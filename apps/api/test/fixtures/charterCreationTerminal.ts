/** Actual B6l/B6n backing plus synthetic finalized account bytes consumed by
 * the real B6k/B6j reader. No callback returns an authorization boolean. */
import { createHash } from 'node:crypto';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { vi } from 'vitest';
import { charterClanIdBytes } from '@shardkeep/chain/charter-protocol';
import type { CharterCreationEvidenceRpc, CharterCreationEvidenceTrust } from '@shardkeep/chain/charter-creation-evidence';
import type { CharterCreationPermitInventory } from '../../src/game/clanCharterCreationPermitInventory';
import { createCharterCreationTerminal } from '../../src/game/clanCharterCreationTerminal';
import { charterPermitInventoryFixture, FIXTURE_EXPIRY } from './charterPermitInventory';

export const TERMINAL_CLOCK = FIXTURE_EXPIRY + 10n;
const CORE = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
const LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const SYSVAR = new PublicKey('Sysvar1111111111111111111111111111111111111');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const u32 = (v: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b; };
const u64 = (v: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const str = (v: string) => Buffer.concat([u32(Buffer.byteLength(v)), Buffer.from(v)]);
const discriminator = (v: string) => createHash('sha256').update(`account:${v}`).digest().subarray(0, 8);

export function terminalBank(saved: CharterCreationPermitInventory, minted = false) {
  const original = saved.reservation.consent, chain = original.chain;
  const key = (field: keyof typeof chain) => new PublicKey(chain[field]);
  const b = (field: keyof typeof chain) => key(field).toBuffer();
  const economy = key('economyProgram'), craft = key('craftProgram'), payer = new PublicKey(original.payer);
  const admin = new PublicKey(Buffer.alloc(32, 17));
  const derive = (p: PublicKey, seed: string, ...tails: Buffer[]) => PublicKey.findProgramAddressSync([Buffer.from(seed), ...tails], p);
  const pd = (p: PublicKey) => PublicKey.findProgramAddressSync([p.toBuffer()], LOADER)[0];
  const row = (address: PublicKey, owner: PublicKey, data: Buffer, executable = false) => ({ address, owner, data, executable });
  const rows: ReturnType<typeof row>[] = [];
  const deployment = (programId: PublicKey, n: number) => {
    const programData = Buffer.concat([u32(3), u64(90n), Buffer.of(1), admin.toBuffer(), Buffer.alloc(17, n)]);
    rows.push(row(programId, LOADER, Buffer.concat([u32(2), pd(programId).toBuffer()]), true), row(pd(programId), LOADER, programData));
    return { programId: programId.toBase58(), reviewedDeploymentSlot: 90, reviewedProgramDataSha256: sha(programData), upgradeAuthority: admin.toBase58() };
  };
  const trust: CharterCreationEvidenceTrust = { expectedGenesisHash: chain.genesisHash, economy: deployment(economy, 1),
    craft: deployment(craft, 2), core: deployment(CORE, 3), stateProvenance: 'fresh-reviewed-deployment' };
  const account = (field: keyof typeof chain, name: string, bytes: Buffer, owner = economy) =>
    row(key(field), owner, Buffer.concat([discriminator(name), Buffer.of(1), bytes]));
  rows.push(account('config', 'CharterConfig', Buffer.concat([derive(economy, 'seeker_authority')[0].toBuffer(), craft.toBuffer(),
    b('craftControl'), b('collection'), b('collectionAuthority'), Buffer.of(derive(economy, 'charter_config')[1])])));
  rows.push(account('craftControl', 'CharterControl', Buffer.concat([admin.toBuffer(), economy.toBuffer(), b('collection'),
    b('collectionAuthority'), Buffer.of(0, derive(craft, 'charter_control')[1], derive(craft, 'charter_collection')[1],
      derive(craft, 'charter_collection_authority')[1])]), craft));
  const clan = charterClanIdBytes(original.clanId), intent = charterClanIdBytes(original.creationIntentId);
  // An unrecorded permit deliberately cannot authenticate a mint for a zero head.
  const permit = Buffer.from(saved.permitInventory.messages[0]?.permitId ?? '00'.repeat(16), 'hex');
  const creationRows = [
    account('charter', 'ClanCharter', Buffer.concat([b('config'), clan, b('asset'), b('collection'), payer.toBuffer(), u32(0),
      Buffer.of(1, 0), Buffer.alloc(16), intent, Buffer.from(original.metadata.hash, 'hex'), Buffer.from(saved.admission.commitment, 'hex'),
      permit, u64(FIXTURE_EXPIRY), Buffer.of(derive(economy, 'charter', clan)[1])])),
    account('creationReceipt', 'CharterCreationReceipt', Buffer.concat([intent, clan, b('charter'), b('asset'), payer.toBuffer(), permit,
      Buffer.of(derive(economy, 'charter_creation', intent)[1])])),
    account('assetBinding', 'CharterAssetBinding', Buffer.concat([b('asset'), clan, b('charter'),
      Buffer.of(derive(economy, 'charter_asset', b('asset'))[1])])),
  ];
  const base = Buffer.concat([Buffer.of(1), payer.toBuffer(), Buffer.of(2), b('collection'), str(original.metadata.name), str(original.metadata.uri), Buffer.of(0)]);
  const pluginAt = base.length + 9;
  creationRows.push(row(key('asset'), CORE, Buffer.concat([base, Buffer.of(3), u64(BigInt(pluginAt + 2)), Buffer.of(5, 1, 4),
    u32(1), Buffer.of(5, 3), b('freezeAuthority'), u64(BigInt(pluginAt)), u32(0)])));
  rows.push(row(key('collection'), CORE, Buffer.concat([Buffer.of(5), b('collectionAuthority'), str('Shared Charter collection'),
    str(original.metadata.uri), u32(1), u32(1)])));
  const clock = Buffer.alloc(40); clock.writeBigUInt64LE(150n); clock.writeBigInt64LE(TERMINAL_CLOCK, 32);
  rows.push(row(SYSVAR_CLOCK_PUBKEY, SYSVAR, clock));
  const setMinted = (present: boolean) => {
    for (const entry of creationRows) { const i = rows.indexOf(entry); if (i >= 0) rows.splice(i, 1); }
    if (present) rows.push(...creationRows);
  };
  setMinted(minted);
  const rpc: CharterCreationEvidenceRpc = { getGenesisHash: vi.fn(async () => chain.genesisHash), getSlot: vi.fn(async () => 150),
    getMultipleAccountsInfoAndContext: vi.fn(async (addresses: PublicKey[]) => ({ context: { slot: 150 },
      value: addresses.map(address => rows.find(entry => entry.address.equals(address)) ?? null) })) };
  const connect = vi.fn((_signal: AbortSignal) => rpc);
  return { trust, rpc, connect, rows, creationRows, clock, setMinted, chain: { connect, trust } };
}

export async function charterCreationTerminalFixture(settings: Parameters<typeof charterPermitInventoryFixture>[0] = {}) {
  const f = await charterPermitInventoryFixture(settings);
  async function prepared(options: { actor?: typeof f.source; count?: 0 | 1; minted?: boolean; expiry?: bigint } = {}) {
    const funded = await f.fund(options.actor), zero = await f.inventory().read(funded.actor.wallet, funded.consent.creationIntentId);
    const message = f.message(zero, { expiry: options.expiry ?? FIXTURE_EXPIRY });
    const inventory = options.count === 0 ? zero
      : await f.inventory().recordPrepared(funded.actor.wallet, funded.consent.creationIntentId, message);
    const bank = terminalBank(inventory, options.minted ?? false);
    const service = () => createCharterCreationTerminal(f.db, { chain: bank.chain });
    return { ...funded, zero, inventory, message, bank, service };
  }
  async function seedSpendQuests() {
    await f.sql`insert into quests(scope,template_code,target,reward_keep,active_on)
      values('daily','spend_200',${Number(f.cost)},0,current_date),('daily','spend_500',${Number(f.cost)},0,current_date) on conflict do nothing`;
  }
  const spendProgress = (baseId: string) => f.sql`select q.template_code,p.progress,p.completed_at,p.claimed_at
    from base_quest_progress p join quests q on q.id=p.quest_id where p.base_id=${baseId}
      and q.template_code in('spend_200','spend_500') order by q.template_code,q.id`;
  async function balance(kind: string, baseId?: string) {
    const result = baseId
      ? await f.sql`select coalesce(sum(balance),0)::text n from accounts where kind::text=${kind} and base_id=${baseId}`
      : await f.sql`select coalesce(sum(balance),0)::text n from accounts where kind::text=${kind}`;
    return BigInt(result[0]!.n);
  }
  async function terminalSnapshot() {
    return { inventory: await f.inventorySnapshot(), terminals: await f.sql`select * from charter_creation_terminals order by reservation_id`,
      refunds: await f.sql`select * from charter_creation_refunds order by reservation_id`,
      posts: await f.sql`select * from charter_creation_terminal_posts order by ledger_id`,
      entries: await f.sql`select * from charter_creation_terminal_entries order by entry_id`,
      clans: await f.sql`select * from clans order by id`, members: await f.sql`select * from clan_members order by player_wallet`,
      quests: await f.sql`select * from base_quest_progress order by base_id,quest_id` };
  }
  return { ...f, prepared, seedSpendQuests, spendProgress, balance, terminalSnapshot };
}
export type TerminalFixture = Awaited<ReturnType<typeof charterCreationTerminalFixture>>;
export type PreparedTerminal = Awaited<ReturnType<TerminalFixture['prepared']>>;
