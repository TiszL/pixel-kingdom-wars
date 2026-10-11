/** Intended path: apps/api/test/fixtures/charterCreationFunding.ts.
 * Owns one local DB. Opening base balances are trusted existing-ledger inputs;
 * this fixture makes no claim about arbitrary owner pre-credit before capture. */
import { randomUUID } from 'node:crypto';
import { CLANS } from '@shardkeep/shared';
import { Keypair, PublicKey } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { charterAssetPda, charterConfigPda, charterCreationPda, charterExecutorPda,
  charterFreezePda, charterMintPda, charterPda, hashCharterMetadata } from '@shardkeep/chain/charter-protocol';
import { bases, players } from '../../src/db/schema';
import { createDb } from '../../src/db/client';
import { ensureStartingBase } from '../../src/game/base';
import { ensureWalletBaseIdentity, refreshBaseOwnership } from '../../src/game/baseOwnership';
import { rewardBaseShards } from '../../src/game/baseEconomy';
import { createClanCharterCustodyEpochs } from '../../src/game/clanCharterCustodyEpochs';
import { createCharterCreationReservations } from '../../src/game/clanCharterCreationReservations';
import type { CharterCreationConsent } from '../../src/game/clanCharterCreationConsent';
import { getOrCreateBaseAccount, getOrCreatePlayerAccount } from '../../src/ledger';
import { ADMIN_DATABASE_URL } from '../db-url';
import { resourceClaimsDatabase } from './resourceClaimsDatabase';

const key = () => Keypair.generate().publicKey.toBase58();
export async function charterCreationFundingFixture(settings: { domain?: { genesisHash: string; economyProgram: string }; database?: ReturnType<typeof resourceClaimsDatabase> } = {}) {
  const prior = { multi: process.env['MULTI_BASE_ENABLED'], charter: process.env['PHASE_E_CHARTER_ENABLED'] };
  process.env['PHASE_E_CHARTER_ENABLED'] = 'true';
  const f = settings.database ?? resourceClaimsDatabase(), cost = BigInt(CLANS.createCostShards);
  const domain = { genesisHash: settings.domain?.genesisHash ?? key(), economyProgram: settings.domain?.economyProgram ?? key(), craftProgram: key() };
  async function dispose() {
    try { await f.close(); } finally {
      if (prior.multi === undefined) delete process.env['MULTI_BASE_ENABLED']; else process.env['MULTI_BASE_ENABLED'] = prior.multi;
      if (prior.charter === undefined) delete process.env['PHASE_E_CHARTER_ENABLED']; else process.env['PHASE_E_CHARTER_ENABLED'] = prior.charter;
    }
  }
  try { await f.setup(); } catch (error) { await dispose(); throw error; }
  async function actor(amount = cost * 4n) {
    const wallet = key(); await f.db.insert(players).values({ wallet });
    await getOrCreatePlayerAccount(f.db, wallet, 'player_keep');
    process.env['MULTI_BASE_ENABLED'] = 'false'; await ensureStartingBase(f.db, wallet);
    const baseId = (await ensureWalletBaseIdentity(f.db, wallet))!, deed = key(), collection = key(), paidAt = new Date();
    await f.db.update(bases).set({ deedAssetId: deed, landPaidAt: paidAt }).where(eq(bases.id, baseId));
    await f.db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
    process.env['MULTI_BASE_ENABLED'] = 'true';
    const proof = (owner = wallet, slot = 100) => ({ owner, slot, collection, frozen: false, delegate: null });
    const refresh = (owner = wallet, slot = 100) => refreshBaseOwnership(f.db, baseId, async () => proof(owner, slot), collection);
    if (await refresh() !== 'owned') throw Error('Fixture ownership not accepted');
    const custody = createClanCharterCustodyEpochs(f.db), epoch = await custody.enroll(wallet, baseId);
    if (amount > 0n) await rewardBaseShards(f.db, baseId, amount, 'test.charter.fund', randomUUID());
    const account = await getOrCreateBaseAccount(f.db, baseId, 'base_shards');
    return { wallet, baseId, deed, collection, proof, refresh, custody, epoch, account };
  }
  function consent(x: Awaited<ReturnType<typeof actor>>, clanId = randomUUID()) {
    const creationIntentId = randomUUID(), economy = new PublicKey(domain.economyProgram), craft = new PublicKey(domain.craftProgram);
    const asset = charterMintPda(craft, clanId), suffix = clanId.replaceAll('-', '').slice(0, CLANS.tagMaxLen);
    const metadata = { name: 'Charter ' + suffix, uri: 'https://invalid.example/' + clanId };
    const cp = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], craft)[0].toBase58();
    return { version: 1 as const, creationIntentId, clanId, payer: x.wallet,
      funding: { baseId: x.baseId, deedAssetId: x.deed, ownershipEpoch: { id: x.epoch.id, evidenceCommitment: x.epoch.evidenceCommitment } },
      clan: { name: 'Clan ' + suffix, tag: suffix.toUpperCase(), inviteMode: 'open' as const },
      price: { source: 'CLANS.createCostShards' as const, version: 1 as const, shards: String(CLANS.createCostShards) },
      metadata: { ...metadata, hash: hashCharterMetadata(metadata).toString('hex') },
      chain: { ...domain, config: charterConfigPda(economy).toBase58(), craftControl: cp('charter_control'), collection: cp('charter_collection'),
        collectionAuthority: cp('charter_collection_authority'), charter: charterPda(economy, clanId).toBase58(), asset: asset.toBase58(),
        assetBinding: charterAssetPda(economy, asset).toBase58(), freezeAuthority: charterFreezePda(craft, clanId).toBase58(),
        executor: charterExecutorPda(economy, clanId).toBase58(), creationReceipt: charterCreationPda(economy, creationIntentId).toBase58() },
      reservationId: randomUUID() };
  }
  const service = () => createCharterCreationReservations(f.db, { newCreationDomain: domain });
  async function escrowAccount() {
    const rows = await f.sql`select id,balance::text balance from accounts where kind::text='charter_creation_escrow'`;
    if (rows.length !== 1) throw Error('Fixture requires exactly one bootstrapped Charter escrow');
    return { id: rows[0]!.id as string, balance: BigInt(rows[0]!.balance) };
  }
  // PROVISIONAL wire names, to freeze against the implementation before RED.
  // No transport adapter guesses or filters metadata from another posting.
  async function posting(x: Awaited<ReturnType<typeof actor>>, value: CharterCreationConsent = consent(x)) {
    const escrow = await escrowAccount();
    return { idempotencyKey: 'charter-create:' + value.creationIntentId, type: 'clan.charter.reserve',
      metadata: { version: 1, consent: value }, entries: [{ account: x.account.id, delta: -cost }, { account: escrow.id, delta: cost }] };
  }
  async function snapshot() {
    return { accounts: await f.sql`select * from accounts order by id`, posts: await f.sql`select * from charter_creation_funding_posts order by ledger_id`,
      entries: await f.sql`select * from charter_creation_funding_entries order by entry_id`,
      reservations: await f.sql`select * from charter_creation_reservations order by id`,
      ledger: await f.sql`select * from ledger_transactions order by id`, legs: await f.sql`select * from ledger_entries order by id` };
  }
  async function ownerUrl() { const [row] = await f.sql`select current_database() name`; const url = new URL(ADMIN_DATABASE_URL); url.pathname = '/' + row!.name; return url; }
  async function dedicatedOwner() { return createDb((await ownerUrl()).toString(), { max: 1 }); }
  try { const source = await actor(); return { ...f, cost, domain, source, actor, consent, service, escrowAccount, posting, snapshot, ownerUrl, dedicatedOwner, dispose }; }
  catch (error) { await dispose(); throw error; }
}
