/** Primary funded-admission intent fixtures only. SQL provenance/grant/orphan
 * attacks belong to a separate focused witness suite before shipping. */
import { randomUUID } from 'node:crypto';
import type { StableBaseMutationContext } from '../src/game/stableBasePrerequisites';
import { CLANS, LOOT } from '@shardkeep/shared';
import { Keypair, PublicKey } from '@solana/web3.js';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { charterAssetPda, charterConfigPda, charterCreationPda, charterExecutorPda,
  charterFreezePda, charterMintPda, charterPda, hashCharterMetadata } from '@shardkeep/chain/charter-protocol';
import { baseArmy, bases, players } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { assertFreshLockedBaseAuthority, ensureWalletBaseIdentity, refreshBaseOwnership, transferStableBase } from '../src/game/baseOwnership';
import { getBaseShardBalance, rewardBaseShards, spendBaseShards } from '../src/game/baseEconomy';
import { createClan, joinClan } from '../src/game/clans';
import { createCampaignRaid } from '../src/game/raids';
import { createClanCharterCustodyEpochs } from '../src/game/clanCharterCustodyEpochs';
import { createCharterCreationReservations } from '../src/game/clanCharterCreationReservations';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createRawRaidFixture } from './fixtures/rawRaid';
import { getSettledDeedRaidLoot, reserveDeedRaidLoot, settleDeedRaidLoot } from '../src/game/raidLoot';

let f: ReturnType<typeof resourceClaimsDatabase>;
const key = () => Keypair.generate().publicKey.toBase58(), cost = BigInt(CLANS.createCostShards);
const domain = { genesisHash: key(), economyProgram: key(), craftProgram: key() };
beforeEach(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'true');
  f = resourceClaimsDatabase(); await f.setup();
}, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); }, 120_000);
const service = () => createCharterCreationReservations(f.db, { newCreationDomain: domain });

async function player() {
  const wallet = key(); await f.db.insert(players).values({ wallet });
  await getOrCreatePlayerAccount(f.db, wallet, 'player_keep'); return wallet;
}
async function fixture(amount = cost * 4n) {
  const wallet = await player(); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  await ensureStartingBase(f.db, wallet); const baseId = (await ensureWalletBaseIdentity(f.db, wallet))!;
  const deed = key(), collection = key(), paidAt = new Date();
  await f.db.update(bases).set({ deedAssetId: deed, landPaidAt: paidAt }).where(eq(bases.id, baseId));
  await f.db.update(players).set({ entryPaidAt: paidAt }).where(eq(players.wallet, wallet));
  vi.stubEnv('MULTI_BASE_ENABLED', 'true');
  const proof = (owner = wallet, slot = 100) => ({ owner, slot, collection, frozen: false, delegate: null });
  const refresh = (owner = wallet, slot = 100) => refreshBaseOwnership(f.db, baseId, async () => proof(owner, slot), collection);
  expect(await refresh()).toBe('owned');
  const custody = createClanCharterCustodyEpochs(f.db), epoch = await custody.enroll(wallet, baseId);
  if (amount > 0n) await rewardBaseShards(f.db, baseId, amount, 'test.charter.fund', randomUUID());
  return { wallet, baseId, deed, collection, proof, refresh, custody, epoch };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
function consent(x: Fixture, clanId = randomUUID()) {
  const creationIntentId = randomUUID(), economy = new PublicKey(domain.economyProgram), craft = new PublicKey(domain.craftProgram);
  const asset = charterMintPda(craft, clanId), suffix = clanId.replaceAll('-', '').slice(0, CLANS.tagMaxLen);
  const metadata = { name: 'Charter ' + suffix, uri: 'https://invalid.example/' + clanId };
  const cp = (seed: string) => PublicKey.findProgramAddressSync([Buffer.from(seed)], craft)[0].toBase58();
  return { version: 1 as const, creationIntentId, clanId, payer: x.wallet,
    funding: { baseId: x.baseId, deedAssetId: x.deed, ownershipEpoch: { id: x.epoch.id, evidenceCommitment: x.epoch.evidenceCommitment } },
    clan: { name: 'Clan ' + suffix, tag: suffix.toUpperCase(), inviteMode: 'open' as const },
    price: { source: 'CLANS.createCostShards' as const, version: 1 as const, shards: String(CLANS.createCostShards) },
    metadata: { ...metadata, hash: hashCharterMetadata(metadata).toString('hex') },
    chain: { ...domain, config: charterConfigPda(economy).toBase58(), craftControl: cp('charter_control'),
      collection: cp('charter_collection'), collectionAuthority: cp('charter_collection_authority'), charter: charterPda(economy, clanId).toBase58(),
      asset: asset.toBase58(), assetBinding: charterAssetPda(economy, asset).toBase58(), freezeAuthority: charterFreezePda(craft, clanId).toBase58(),
      executor: charterExecutorPda(economy, clanId).toBase58(), creationReceipt: charterCreationPda(economy, creationIntentId).toBase58() },
    reservationId: randomUUID() };
}
const context = (x: Fixture): StableBaseMutationContext => ({ baseId: x.baseId,
  assertAuthority: async (tx, wallet, baseId) => { await assertFreshLockedBaseAuthority(tx, wallet, baseId); } });
const escrow = async () => BigInt((await f.sql`select coalesce(sum(balance),0)::text n from accounts where kind::text='charter_creation_escrow'`)[0]!.n);
const money = () => f.sql`select id,balance from accounts order by id`;

it('moves exactly the founding cost to dedicated escrow without burn, spend quests or placeholder clans', async () => {
  const x = await fixture(), c = consent(x), before = await getBaseShardBalance(f.db, x.baseId);
  await f.sql`insert into quests(scope,template_code,target,reward_keep,active_on) values('daily','spend_200',${CLANS.createCostShards},0,current_date) on conflict do nothing`;
  const burn = await f.sql`select balance from accounts where kind::text='shard_burn'`;
  const result = await service().reserve(x.wallet, c);
  expect(result).toMatchObject({ consent: c, state: 'reserved' }); expect(result.reserveTransactionId).toMatch(/^[0-9a-f-]{36}$/);
  expect(await getBaseShardBalance(f.db, x.baseId)).toBe(before - cost); expect(await escrow()).toBe(cost);
  expect(await f.sql`select balance from accounts where kind::text='shard_burn'`).toEqual(burn);
  expect(await f.sql`select * from base_quest_progress where base_id=${x.baseId}`).toHaveLength(0);
  expect(await f.sql`select * from clans`).toHaveLength(0); expect(await f.sql`select * from clan_members`).toHaveLength(0);
  const legs = await f.sql`select a.kind::text kind,a.base_id,a.owner_wallet,e.delta::text delta from ledger_entries e join accounts a on a.id=e.account_id where e.txn_id=${result.reserveTransactionId} order by e.delta`;
  expect(legs).toEqual([{ kind: 'base_shards', base_id: x.baseId, owner_wallet: null, delta: String(-cost) },
    { kind: 'charter_creation_escrow', base_id: null, owner_wallet: null, delta: String(cost) }]);
  expect(Object.isFrozen(result)).toBe(true); expect(Object.isFrozen(result.consent.funding.ownershipEpoch)).toBe(true);
});

it('recovers the immutable original after reconnect, pause, domain removal and deed transfer without charging again', async () => {
  const x = await fixture(), c = consent(x), original = await service().reserve(x.wallet, c), buyer = await player();
  await transferStableBase(f.db, x.baseId, x.wallet, buyer, x.deed, { ...x.proof(buyer, 101), observedAtMs: Date.now() });
  const before = await money(); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false'); vi.stubEnv('MULTI_BASE_ENABLED', 'false');
  const reopened = f.reopen();
  try { const store = createCharterCreationReservations(reopened.db, { newCreationDomain: null });
    expect(await store.reserve(x.wallet, structuredClone(c))).toEqual(original);
    expect(await store.read(x.wallet, c.creationIntentId)).toEqual(original);
    await expect(store.read(buyer, c.creationIntentId)).rejects.toThrow();
  } finally { await reopened.sql.end(); }
  expect(await money()).toEqual(before);
});

it('refuses changed replay consent instead of rewriting the original or charging its caller again', async () => {
  const x = await fixture(), c = consent(x), result = await service().reserve(x.wallet, c), before = await money();
  for (const mutate of [(v: typeof c) => { v.clan.name += 'x'; }, (v: typeof c) => { v.funding.ownershipEpoch.id = randomUUID(); },
    (v: typeof c) => { v.reservationId = randomUUID(); }, (v: typeof c) => { v.price.shards = String(cost + 1n); }]) {
    const changed = structuredClone(c); mutate(changed); await expect(service().reserve(x.wallet, changed)).rejects.toThrow();
  }
  expect(await service().read(x.wallet, c.creationIntentId)).toEqual(result); expect(await money()).toEqual(before);
});

it('serializes simultaneous identical retries into one posting and preserves a detached original', async () => {
  const x = await fixture(), c = consent(x), expected = structuredClone(c);
  const [a, b] = await Promise.all([service().reserve(x.wallet, c), service().reserve(x.wallet, structuredClone(c))]);
  expect(a).toEqual(b); expect(await escrow()).toBe(cost);
  c.metadata.uri = 'changed'; expect(await service().read(x.wallet, expected.creationIntentId)).toMatchObject({ consent: expected });
  expect(await f.sql`select * from ledger_entries where txn_id=${a.reserveTransactionId}`).toHaveLength(2);
});

it('keeps one outstanding original-payer obligation across bases and one source obligation across successor owners', async () => {
  const x = await fixture(), other = await fixture(), original = await service().reserve(x.wallet, consent(x));
  // The original payer acquires another independently paid deed with a fresh epoch.
  await transferStableBase(f.db, other.baseId, other.wallet, x.wallet, other.deed, { ...other.proof(x.wallet, 101), observedAtMs: Date.now() });
  const nextEpoch = (await other.custody.read(other.baseId))!;
  expect(nextEpoch).toMatchObject({ baseId: other.baseId, ownerWallet: x.wallet, authority: 'current' });
  await expect(service().reserve(x.wallet, consent({ ...other, wallet: x.wallet, epoch: nextEpoch })))
    .rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_OUTSTANDING' });
  const buyer = await player(); await f.db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, buyer));
  await transferStableBase(f.db, x.baseId, x.wallet, buyer, x.deed, { ...x.proof(buyer, 102), observedAtMs: Date.now() });
  const buyerEpoch = (await x.custody.read(x.baseId))!;
  expect(buyerEpoch).toMatchObject({ baseId: x.baseId, ownerWallet: buyer, authority: 'current' });
  await expect(service().reserve(buyer, consent({ ...x, wallet: buyer, epoch: buyerEpoch })))
    .rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_OUTSTANDING' });
  expect(await escrow()).toBe(cost); expect(await service().read(x.wallet, original.consent.creationIntentId)).toEqual(original);
});

it('rolls insufficient funding back without creating a reservation or consuming the intent for a later funded retry', async () => {
  const x = await fixture(0n), c = consent(x);
  await expect(service().reserve(x.wallet, c)).rejects.toThrow(); expect(await service().read(x.wallet, c.creationIntentId)).toBeNull();
  expect(await escrow()).toBe(0n); await rewardBaseShards(f.db, x.baseId, cost, 'test.charter.retry-fund', randomUUID());
  expect((await service().reserve(x.wallet, c)).state).toBe('reserved'); expect(await getBaseShardBalance(f.db, x.baseId)).toBe(0n);
});

it('rejects unauthenticated payer, mismatched deed/epoch and unapproved domain before any new debit', async () => {
  const x = await fixture(), c = consent(x), outsider = await player(), before = await money();
  await expect(service().reserve(outsider, c)).rejects.toThrow();
  for (const change of [{ deedAssetId: key() }, { ownershipEpoch: { id: randomUUID(), evidenceCommitment: x.epoch.evidenceCommitment } },
    { ownershipEpoch: { id: x.epoch.id, evidenceCommitment: 'ab'.repeat(32) } }]) {
    await expect(service().reserve(x.wallet, { ...c, funding: { ...c.funding, ...change } })).rejects.toThrow();
  }
  await expect(createCharterCreationReservations(f.db, { newCreationDomain: null }).reserve(x.wallet, c)).rejects.toThrow();
  await expect(createCharterCreationReservations(f.db, { newCreationDomain: { ...domain, genesisHash: key() } }).reserve(x.wallet, c)).rejects.toThrow();
  expect(await money()).toEqual(before); expect(await escrow()).toBe(0n);
});

it('requires the current accepted epoch after deferred A-to-B-to-A loss, not the unchanged database owner', async () => {
  const x = await fixture(), c = consent(x), buyer = await player();
  await f.db.insert(baseArmy).values({ baseId: x.baseId, troop: 'plunderer', count: 1 });
  const { compensatePendingRaid } = await import('../src/game/raids');
  const raid = await createCampaignRaid(f.db, x.wallet, 1, randomUUID(), new Date(), { attackerBaseId: x.baseId, authorizeAttackerBase: async () => {} });
  await x.refresh(buyer, 101); await x.refresh(x.wallet, 102); await compensatePendingRaid(f.db, raid, false);
  await expect(service().reserve(x.wallet, c)).rejects.toThrow(); expect(await escrow()).toBe(0n);
  const current = (await x.custody.read(x.baseId))!;
  expect(current.id).not.toBe(x.epoch.id); expect((await service().reserve(x.wallet, consent({ ...x, epoch: current }))).state).toBe('reserved');
});

it('requires current authority even when the original epoch is unchanged and recovers the same consent afterward', async () => {
  const x = await fixture(), c = consent(x), before = await money();
  await f.sql`update base_slots set active=false where base_id=${x.baseId}`;
  expect(await x.custody.read(x.baseId)).toEqual({ ...x.epoch, authority: 'unavailable' });
  await expect(service().reserve(x.wallet, c)).rejects.toThrow();
  expect(await money()).toEqual(before); expect(await escrow()).toBe(0n);
  await f.sql`update base_slots set active=true where base_id=${x.baseId}`;
  await x.refresh(x.wallet, 101);
  expect(await x.custody.read(x.baseId)).toEqual(x.epoch);
  expect(await service().reserve(x.wallet, c)).toMatchObject({ consent: c, state: 'reserved' });
});

it('protects pending name, normalized tag and founder against actual legacy create/join with rollback', async () => {
  const x = await fixture(), y = await fixture(), z = await fixture(), c = consent(x); await service().reserve(x.wallet, c);
  const before = await getBaseShardBalance(f.db, y.baseId);
  await expect(createClan(f.db, y.wallet, { name: c.clan.name, tag: 'FREE' }, randomUUID(), context(y))).rejects.toThrow();
  await expect(createClan(f.db, y.wallet, { name: 'Free Clan', tag: c.clan.tag.toLowerCase() }, randomUUID(), context(y))).rejects.toThrow();
  await expect(createClan(f.db, x.wallet, { name: 'Other Clan', tag: 'OTHR' }, randomUUID(), context(x))).rejects.toThrow();
  expect(await getBaseShardBalance(f.db, y.baseId)).toBe(before);
  const live = await createClan(f.db, z.wallet, { name: 'Live Clan', tag: 'LIVE' }, randomUUID(), context(z));
  await expect(joinClan(f.db, x.wallet, live.id)).rejects.toThrow();
  expect(await f.sql`select * from clan_members where player_wallet=${x.wallet}`).toHaveLength(0);
});

it('guards existing clan UPDATEs and direct clan identity insertion against pending rights', async () => {
  const x = await fixture(), y = await fixture(), c = consent(x); await service().reserve(x.wallet, c);
  const live = await createClan(f.db, y.wallet, { name: 'Existing Clan', tag: 'EXST' }, randomUUID(), context(y));
  await expect(f.sql`update clans set name=${c.clan.name} where id=${live.id}`).rejects.toThrow();
  await expect(f.sql`update clans set tag=${c.clan.tag} where id=${live.id}`).rejects.toThrow();
  await expect(f.sql`update clans set leader_wallet=${x.wallet} where id=${live.id}`).rejects.toThrow();
  await expect(f.sql`insert into clans(id,name,tag,leader_wallet,invite_mode) values(${c.clanId},'Other Identity','OID',${y.wallet},'open')`).rejects.toThrow();
  const members = await f.sql`select * from clan_members where clan_id=${live.id} order by player_wallet`;
  await expect(f.sql`update clan_members set player_wallet=${x.wallet} where player_wallet=${y.wallet}`)
    .rejects.toMatchObject({ code: 'P0001', message: 'CLAN_CHARTER_CREATION_PENDING' });
  expect(await f.sql`select * from clan_members where clan_id=${live.id} order by player_wallet`).toEqual(members);
  expect((await f.sql`select name,tag,leader_wallet from clans where id=${live.id}`)[0]).toEqual({ name: live.name, tag: live.tag, leader_wallet: y.wallet });
});

it('refuses existing live names and membership before funding, leaving unrelated admission possible', async () => {
  const x = await fixture(), y = await fixture(), c = consent(x);
  const live = await createClan(f.db, y.wallet, { name: c.clan.name, tag: c.clan.tag }, randomUUID(), context(y));
  const before = await getBaseShardBalance(f.db, x.baseId);
  await expect(service().reserve(x.wallet, c)).rejects.toThrow(); expect(await getBaseShardBalance(f.db, x.baseId)).toBe(before);
  await joinClan(f.db, x.wallet, live.id); await expect(service().reserve(x.wallet, consent(x))).rejects.toThrow();
  const z = await fixture(); expect((await service().reserve(z.wallet, consent(z))).state).toBe('reserved'); expect(await escrow()).toBe(cost);
});

it('leaves the unreserved balance usable by normal spending and actual raids while original escrow remains fixed', async () => {
  const x = await fixture(), c = consent(x), saved = await service().reserve(x.wallet, c);
  const before = await getBaseShardBalance(f.db, x.baseId);
  await spendBaseShards(f.db, x.baseId, cost, 'test.charter.ordinary-spend', randomUUID());
  expect(await getBaseShardBalance(f.db, x.baseId)).toBe(before - cost);
  await f.db.insert(baseArmy).values({ baseId: x.baseId, troop: 'plunderer', count: 1 });
  const raid = await createCampaignRaid(f.db, x.wallet, 1, randomUUID(), new Date(), { attackerBaseId: x.baseId, authorizeAttackerBase: async () => {} });
  expect(raid.id).toBeTruthy(); expect(await escrow()).toBe(cost);
  expect(await service().read(x.wallet, c.creationIntentId)).toEqual(saved);
});

it('settles real PvP money only from unreserved liquid and preserves original Charter escrow through replay', async () => {
  const x = await fixture(), c = consent(x);
  // Isolate the liquid source in this fixture; the settlement result below is
  // synthetic, while reservation/ledger settlement execute real game services.
  expect(await f.sql`select id from buildings where base_id=${x.baseId} and type in ('mine','vault')`).toHaveLength(0);
  expect(await f.sql`select * from base_forge_positions where base_id=${x.baseId}`).toHaveLength(0);
  const original = await service().reserve(x.wallet, c), liquid = await getBaseShardBalance(f.db, x.baseId);
  const charterMoney = await escrow(), now = new Date();
  const pvp = await createRawRaidFixture(f.db, { now, defender: { wallet: x.wallet, baseId: x.baseId }, stocks: {}, keep: false });
  const attackerBefore = await getBaseShardBalance(f.db, pvp.attackerBaseId);
  const expected = liquid * BigInt(LOOT.balanceLootableBps) / 10_000n;
  const frozen = await reserveDeedRaidLoot(f.db, { raidId: pvp.raid.id, attackerBaseId: pvp.attackerBaseId, defenderBaseId: x.baseId, now });
  expect(frozen).toEqual({ balancePool: expected, mines: 0n, maximum: expected }); expect(await escrow()).toBe(charterMoney);
  const paid = await settleDeedRaidLoot(f.db, pvp.raid.id, 3, [], now);
  expect(paid).toEqual({ total: expected, balance: expected, mines: 0n, fromLiquid: expected, fromOpenForge: 0n });
  expect(expected).toBeGreaterThan(0n);
  expect(await getBaseShardBalance(f.db, x.baseId)).toBe(liquid - expected);
  expect(await getBaseShardBalance(f.db, pvp.attackerBaseId)).toBe(attackerBefore + expected);
  expect(await escrow()).toBe(charterMoney); expect(await service().read(x.wallet, c.creationIntentId)).toEqual(original);
  const after = await money(); expect(await getSettledDeedRaidLoot(f.db, pvp.raid.id)).toEqual(paid);
  await expect(settleDeedRaidLoot(f.db, pvp.raid.id, 3, [], now)).rejects.toThrow();
  expect(await money()).toEqual(after);
  expect(await f.sql`select * from base_raid_locks where base_id=${x.baseId}`).toHaveLength(0);
  const [reservation] = await f.sql`select * from raid_loot_reservations where raid_id=${pvp.raid.id}`;
  expect(reservation!.state).toBe('settled');
  expect(await f.sql`select e.id from ledger_entries e join accounts a on a.id=e.account_id where a.kind::text='charter_creation_escrow' and e.txn_id in (${reservation!.reserve_ledger_txn_id},${reservation!.terminal_ledger_txn_id})`).toHaveLength(0);
});


it('requires current evidence when the epoch, paid base and active slot remain unchanged, then recovers the same consent', async () => {
  const x = await fixture(), c = consent(x), before = await money();
  expect(await refreshBaseOwnership(f.db, x.baseId, async () => null, x.collection)).toBe('unavailable');
  expect(await f.sql`select b.owner_wallet,b.status,b.land_paid_at is not null paid,s.active from bases b
    join base_slots s on s.base_id=b.id and s.wallet=${x.wallet} where b.id=${x.baseId}`)
    .toEqual([{ owner_wallet: x.wallet, status: 'active', paid: true, active: true }]);
  expect(await x.custody.read(x.baseId)).toEqual({ ...x.epoch, authority: 'unavailable' });
  await expect(service().reserve(x.wallet, c)).rejects.toMatchObject({ code: 'CLAN_CHARTER_CREATION_CUSTODY' });
  expect(await money()).toEqual(before); expect(await escrow()).toBe(0n);
  expect(await x.refresh(x.wallet, 101)).toBe('owned');
  expect(await x.custody.read(x.baseId)).toEqual(x.epoch);
  expect(await service().reserve(x.wallet, c)).toMatchObject({ consent: c, state: 'reserved' });
});
