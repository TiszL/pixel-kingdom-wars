/** B6p adapter acceptance. The protected submitOrders writer is unchanged;
 * these cases prove the private adapter plus actual DB/ledger source guards. */
import { CLANS, PHASE_E_POLICY } from '@shardkeep/shared';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClanCharterEvents } from '../src/game/clanCharterEvents';
import { createClanCharterReconciliation } from '../src/game/clanCharterReconciliation';
import { createClanCharterRaidChest, resolveOriginalClanRaidChest } from '../src/game/clanCharterRaidChest';
import { clanChestInvariantHolds, joinClan, kickMember, leaveClan } from '../src/game/clans';
import { rewardShards } from '../src/game/spend';
import { bootstrapSystemAccounts, postTransaction } from '../src/ledger';
import { raidChestFixture, raidChestKey, raidChestPg, type RaidChestFixture } from './fixtures/clanCharterRaidChest';

let f: RaidChestFixture;
beforeEach(async () => {
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false');
  f = raidChestFixture(); await f.setup();
}, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); }, 120_000);
const gross = () => BigInt(PHASE_E_POLICY.basisPoints);

it('captures one constants-backed rule prospectively and replays the immutable rule after pause and reopen', async () => {
  await expect(f.service().initializeRule()).rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_DISABLED' });
  const rule = await f.initialize();
  expect(rule).toMatchObject({ version: 1, rateSource: 'CLANS.chestTitheBps',
    titheBps: CLANS.chestTitheBps, basisPoints: PHASE_E_POLICY.basisPoints });
  expect(Object.isFrozen(rule)).toBe(true); expect(Object.isFrozen(f.service())).toBe(true);
  expect(await f.service().initializeRule()).toEqual(rule);
  const reopened = f.reopen();
  try { expect(await createClanCharterRaidChest(reopened.db).initializeRule()).toEqual(rule); }
  finally { await reopened.sql.end(); }
  expect(await f.sql`select source_id from clan_charter_event_source`).toEqual([{ source_id: rule.sourceId }]);
  expect(await f.sql`select id from clan_charter_raid_tithe_rules`).toEqual([{ id: rule.id }]);
});

it('allows legacy routing only when the B6a source is genuinely absent', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  const raid = await f.admit(a.wallet, d.wallet), result = await f.settle(raid.id, gross());
  expect(result).toMatchObject({ history: 'unenrolled', clanId: c.id,
    chestCut: BigInt(CLANS.chestTitheBps) });
  expect(await f.service().read(raid.id)).toEqual({ status: 'unenrolled' });
  expect(await f.sql`select * from clan_charter_event_source`).toHaveLength(0);
  expect(await clanChestInvariantHolds(f.db)).toBe(true);
});

it('keeps old enrolled pending work without a rule held instead of recapturing membership or price', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'true');
  await createClanCharterEvents(f.db).initialize();
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false');
  const raid = await f.admit(a.wallet, d.wallet), before = await f.money();
  await expect(f.settle(raid.id, gross())).rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_HELD' });
  expect(await f.service().read(raid.id)).toEqual({ status: 'held', reason: 'rule_missing' });
  await expect(f.initialize()).rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_PENDING_RAIDS' });
  expect(await f.money()).toEqual(before); expect(await f.entries(raid.id)).toHaveLength(0);
  expect(await f.sql`select tithe_rule_id from clan_charter_raid_events where raid_id=${raid.id}`)
    .toEqual([{ tithe_rule_id: null }]);
  expect(await f.sql`select id from clans where id=${c.id}`).toHaveLength(1);
  // Earlier committed observations remain readable, but they do not acquire
  // a rate-covered deletion proof retrospectively, even after actual expiry.
  await f.expire(raid, a.wallet);
  expect(await createClanCharterReconciliation(f.db).read(raid.id))
    .toMatchObject({ status: 'reconciled', terminalStatus: 'expired', chestShards: '0' });
  expect(await f.service().read(raid.id)).toEqual({ status: 'held', reason: 'rule_missing' });
  expect(raidChestPg(await leaveClan(f.db, a.wallet).catch(error => error)))
    .toEqual({ code: 'P0001', message: 'CLAN_CHARTER_RAID_CHEST_PENDING' });
  expect(await f.sql`select id from clans where id=${c.id}`).toHaveLength(1);
});

it('actual admission retains the original clan and rate after kick and joining another clan', async () => {
  const leader = await f.funded(), original = await f.clan(leader.wallet), a = await f.attacker();
  const otherLeader = await f.funded(), other = await f.clan(otherLeader.wallet), d = await f.defender();
  await joinClan(f.db, a.wallet, original.id); const rule = await f.initialize();
  const raid = await f.admit(a.wallet, d.wallet);
  await kickMember(f.db, leader.wallet, a.wallet); await joinClan(f.db, a.wallet, other.id);
  const paid = await f.settle(raid.id, gross());
  expect(paid).toMatchObject({ history: 'captured', clanId: original.id, chestCut: BigInt(rule.titheBps) });
  expect(await f.sql`select id,chest_shards::text from clans where id in (${original.id},${other.id}) order by id`)
    .toEqual([{ id: original.id, chest_shards: String(rule.titheBps) }, { id: other.id, chest_shards: '0' }].sort((a,b) => a.id.localeCompare(b.id)));
  expect(await f.entries(raid.id)).toHaveLength(3);
  const proof = await f.service().read(raid.id);
  expect(proof).toEqual({ status: 'reconciled', raidId: raid.id, originalClanId: original.id,
    ruleId: rule.id, terminalStatus: 'resolved', chestShards: String(rule.titheBps) });
  expect(Object.isFrozen(proof)).toBe(true); expect(await clanChestInvariantHolds(f.db)).toBe(true);
});

it('captured none remains none after a later join and never becomes missing history', async () => {
  const a = await f.attacker(), leader = await f.funded(), c = await f.clan(leader.wallet), d = await f.defender();
  const rule = await f.initialize(), raid = await f.admit(a.wallet, d.wallet);
  await joinClan(f.db, a.wallet, c.id); const paid = await f.settle(raid.id, gross());
  expect(paid).toMatchObject({ history: 'captured', clanId: null, chestCut: 0n });
  expect(await f.entries(raid.id)).toHaveLength(2);
  expect(await f.service().read(raid.id)).toEqual({ status: 'reconciled', raidId: raid.id,
    originalClanId: null, ruleId: rule.id, terminalStatus: 'resolved', chestShards: '0' });
  expect(await f.sql`select chest_shards::text from clans where id=${c.id}`).toEqual([{ chest_shards: '0' }]);
});

it('proves the exact two-leg rounded-zero cut for an original clan using its captured rule', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  const rule = await f.initialize(), raid = await f.admit(a.wallet, d.wallet);
  const tiny = BigInt(Math.floor(rule.basisPoints / rule.titheBps) - 1);
  expect(tiny).toBeGreaterThan(0n); expect(tiny * BigInt(rule.titheBps) / BigInt(rule.basisPoints)).toBe(0n);
  expect(await f.settle(raid.id, tiny)).toMatchObject({ clanId: c.id, chestCut: 0n });
  expect(await f.entries(raid.id)).toHaveLength(2);
  expect(await f.sql`select * from clan_charter_chest_updates`).toHaveLength(0);
  expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled', chestShards: '0', ruleId: rule.id });
});

it('refuses actual sole-leader dissolution with pending captured work and rolls its attempted payout back', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  await f.db.transaction(async tx => {
    const sys = await bootstrapSystemAccounts(tx);
    await postTransaction(tx, { idempotencyKey: raidChestKey(), type: 'test.raid-chest.old-chest',
      entries: [{ account: sys.shard_genesis, delta: -7n }, { account: sys.clan_chest, delta: 7n }] });
    await tx.execute(sql`update clans set chest_shards=7 where id=${c.id}`);
  });
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet), before = await f.money();
  expect(raidChestPg(await leaveClan(f.db, a.wallet).catch(error => error)))
    .toEqual({ code: 'P0001', message: 'CLAN_CHARTER_RAID_CHEST_PENDING' });
  expect(await f.money()).toEqual(before);
  expect(await f.sql`select id from ledger_transactions where idempotency_key=${'clan-dissolve:' + c.id}`).toHaveLength(0);
  expect(await f.sql`select chest_shards::text from clans where id=${c.id}`).toEqual([{ chest_shards: '7' }]);
  await f.expire(raid, a.wallet); expect(await leaveClan(f.db, a.wallet)).toEqual({ left: true, disbanded: true });
  expect(await f.sql`select e.delta::text from ledger_entries e join ledger_transactions t on t.id=e.txn_id
    where t.idempotency_key=${'clan-dissolve:' + c.id} order by e.delta`).toEqual([{ delta: '-7' }, { delta: '7' }]);
  expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled', terminalStatus: 'expired' });
});

it('commits actual expiry then allows dissolution while its terminal proof remains readable', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet);
  await f.expire(raid, a.wallet); const proof = await f.service().read(raid.id);
  expect(proof).toMatchObject({ status: 'reconciled', originalClanId: c.id, terminalStatus: 'expired', chestShards: '0' });
  expect(await leaveClan(f.db, a.wallet)).toEqual({ left: true, disbanded: true });
  expect(await f.service().read(raid.id)).toEqual(proof); expect(await f.entries(raid.id)).toHaveLength(0);
});

it('preserves zero-loot proof across dissolution and ordinary later player balance changes', async () => {
  const a = await f.attacker(); await f.clan(a.wallet); const d = await f.defender();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet);
  await f.settle(raid.id, 0n); const proof = await f.service().read(raid.id);
  expect(proof).toMatchObject({ status: 'reconciled', chestShards: '0' });
  await leaveClan(f.db, a.wallet);
  await rewardShards(f.db, a.wallet, 3n, 'test.raid-chest.later-reward', raidChestKey());
  expect(await f.service().read(raid.id)).toEqual(proof);
});

it('allows ordinary roster, chest payout and later balance changes without invalidating positive history', async () => {
  const a = await f.attacker(), c = await f.clan(a.wallet), d = await f.defender(), member = await f.funded();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet); await f.settle(raid.id, gross());
  const proof = await f.service().read(raid.id), before = await f.money();
  await joinClan(f.db, member.wallet, c.id); await leaveClan(f.db, member.wallet);
  expect(await f.service().read(raid.id)).toEqual(proof);
  expect(await leaveClan(f.db, a.wallet)).toEqual({ left: true, disbanded: true });
  expect(await f.money()).not.toEqual(before); expect(await f.service().read(raid.id)).toEqual(proof);
  expect(await clanChestInvariantHolds(f.db)).toBe(true);
});

it('does not let an unrelated raid-linked reward header masquerade as the canonical loot source', async () => {
  const a = await f.attacker(); await f.clan(a.wallet); const d = await f.defender();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet);
  await f.settle(raid.id, 0n); const proof = await f.service().read(raid.id);
  await rewardShards(f.db, a.wallet, 5n, 'test.raid-chest.unrelated-reward', raidChestKey(), { raidId: raid.id });
  expect(await f.service().read(raid.id)).toEqual(proof);
});

it('rejects a substituted attacker before posting and retries the original admitted actor safely', async () => {
  const a = await f.attacker(); await f.clan(a.wallet); const d = await f.defender();
  await f.initialize(); const raid = await f.admit(a.wallet, d.wallet), before = await f.money();
  await expect(f.db.transaction(tx => resolveOriginalClanRaidChest(tx, raid.id, d.wallet, gross())))
    .rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_HELD' });
  expect(await f.money()).toEqual(before); expect(await f.entries(raid.id)).toHaveLength(0);
  await f.settle(raid.id, gross()); expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled' });
});
