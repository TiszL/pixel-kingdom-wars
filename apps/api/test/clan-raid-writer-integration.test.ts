/** K232: actual admission/simulator/submitOrders, immutable original clan and
 * atomic expiry. No synthetic outcome or alternate writer in this suite. */
import { CLANS, PHASE_E_POLICY } from '@shardkeep/shared';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createClanCharterEvents } from '../src/game/clanCharterEvents';
import { joinClan, kickMember, clanChestInvariantHolds } from '../src/game/clans';
import { batchOrdersSubmitDeadlineAt, getRaidEnergy, getReplay, submitOrders } from '../src/game/raids';
import { getOrCreatePlayerAccount } from '../src/ledger';
import { raidChestFixture, raidChestKey, type RaidChestFixture } from './fixtures/clanCharterRaidChest';
let f: RaidChestFixture;
beforeEach(async () => { vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false'); f = raidChestFixture(); await f.setup(); }, 120_000);
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await f?.close(); }, 120_000);
const orders = () => ({ idempotencyKey: raidChestKey(), deploys: [
  { troop: 'turrider' as const, tx: 6, ty: 14, tMs: 0 }, { troop: 'turrider' as const, tx: 23, ty: 14, tMs: 0 },
  { troop: 'turrider' as const, tx: 14, ty: 6, tMs: 0 }, { troop: 'turrider' as const, tx: 14, ty: 23, tMs: 0 }] });
const balance = async (wallet: string) => (await getOrCreatePlayerAccount(f.db, wallet, 'player_shards')).balance;

it.each([true, false])('routes actual loot by original clan presence=%s after joining a different clan, then replays paused', async original => {
  const a = await f.attacker('turrider'), leader = await f.funded(), c = await f.clan(leader.wallet);
  const otherLeader = await f.funded(), other = await f.clan(otherLeader.wallet), d = await f.defender();
  if (original) await joinClan(f.db, a.wallet, c.id);
  const rule = await f.initialize(), raid = await f.admit(a.wallet, d.wallet);
  if (original) await kickMember(f.db, leader.wallet, a.wallet);
  await joinClan(f.db, a.wallet, other.id);
  const beforeA = await balance(a.wallet), beforeD = await balance(d.wallet), request = orders();
  const first = await submitOrders(f.db, a.wallet, raid.id, request);
  expect(first.result.stars).toBeGreaterThanOrEqual(1);
  const gross = beforeD - await balance(d.wallet), cut = original ? gross * BigInt(CLANS.chestTitheBps) / BigInt(PHASE_E_POLICY.basisPoints) : 0n;
  expect(gross).toBeGreaterThan(0n); expect(await balance(a.wallet) - beforeA).toBe(gross - cut);
  expect(await f.sql`select chest_shards::text from clans where id=${c.id}`).toEqual([{ chest_shards: String(cut) }]);
  expect(await f.sql`select chest_shards::text from clans where id=${other.id}`).toEqual([{ chest_shards: '0' }]);
  const entries = await f.entries(raid.id); expect(entries).toHaveLength(original ? 3 : 2);
  expect(entries.reduce((sum, e) => sum + BigInt(e.delta), 0n)).toBe(0n);
  const proof = { status: 'reconciled', raidId: raid.id, originalClanId: original ? c.id : null,
    ruleId: rule.id, terminalStatus: 'resolved', chestShards: String(cut) };
  expect(await f.service().read(raid.id)).toEqual(proof);
  await expect(submitOrders(f.db, a.wallet, raid.id, request)).rejects.toMatchObject({ statusCode: 422, message: 'raid already resolved' });
  expect((await getReplay(f.db, a.wallet, raid.id)).result).toEqual(first.result);
  expect(await f.entries(raid.id)).toEqual(entries); expect(await f.service().read(raid.id)).toEqual(proof);
  expect(await clanChestInvariantHolds(f.db)).toBe(true);
}, 120_000);

it('refuses source-only unpriced submission instead of guessing current membership or enrolling through gameplay', async () => {
  const a = await f.attacker('turrider'); await f.clan(a.wallet); const d = await f.defender();
  vi.stubEnv('MULTI_BASE_ENABLED', 'true'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'true');
  await createClanCharterEvents(f.db).initialize();
  vi.stubEnv('MULTI_BASE_ENABLED', 'false'); vi.stubEnv('PHASE_E_CHARTER_ENABLED', 'false');
  const raid = await f.admit(a.wallet, d.wallet), before = await f.money();
  await expect(submitOrders(f.db, a.wallet, raid.id, orders())).rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_HELD' });
  expect(await f.money()).toEqual(before); expect(await f.entries(raid.id)).toHaveLength(0);
  expect(await f.sql`select status from raids where id=${raid.id}`).toEqual([{ status: 'pending_orders' }]);
  await expect(f.initialize()).rejects.toMatchObject({ code: 'CLAN_CHARTER_RAID_CHEST_PENDING_RAIDS' });
  expect(await f.sql`select * from clan_charter_raid_tithe_rules`).toHaveLength(0);
}, 120_000);

it.each(['lease', 'system-attempt'] as const)('expires enrolled accepted %s atomically, retaining original refund eligibility and exact terminal proof', async kind => {
  const a = await f.attacker('turrider'), c = await f.clan(a.wallet), d = await f.defender();
  await f.initialize(); const before = await balance(a.wallet), energy = await getRaidEnergy(f.db, a.wallet);
  const raid = await f.admit(a.wallet, d.wallet);
  expect(await balance(a.wallet)).toBeLessThan(before); expect((await getRaidEnergy(f.db, a.wallet)).used).toBe(energy.used + 1);
  if (kind === 'lease') {
    // Persist an abandoned resolver's exact lease fields; admission/time/energy
    // and ante remain those written by actual createRaid.
    await f.sql`update raids set simulation_lease_token=${raidChestKey()}::uuid,
      simulation_lease_until=now()-interval '1 second' where id=${raid.id}`;
  } else {
    await f.sql`alter table clan_charter_raid_terminals add constraint k232_terminal_refusal check(terminal_status<>'resolved') not valid`;
    try { await expect(submitOrders(f.db, a.wallet, raid.id, orders())).rejects.toThrow(); }
    finally { await f.sql`alter table clan_charter_raid_terminals drop constraint k232_terminal_refusal`; }
    const [pending] = await f.sql`select status,simulation_system_attempted_at from raids where id=${raid.id}`;
    expect(pending!.status).toBe('pending_orders'); expect(pending!.simulation_system_attempted_at).not.toBeNull();
    expect(await f.entries(raid.id)).toHaveLength(0);
  }
  const at = new Date(batchOrdersSubmitDeadlineAt(raid.ordersDeadlineAt).getTime() + 1);
  const results = await Promise.all([getRaidEnergy(f.db, a.wallet, at), getRaidEnergy(f.db, a.wallet, at)]);
  for (const result of results) expect(result).toEqual(energy);
  expect(await balance(a.wallet)).toBe(before);
  expect(await f.sql`select status,simulation_lease_token,simulation_lease_until,simulation_system_attempted_at from raids where id=${raid.id}`)
    .toEqual([{ status: 'expired', simulation_lease_token: null, simulation_lease_until: null, simulation_system_attempted_at: null }]);
  expect(await f.sql`select t.after_raid=to_jsonb(r) exact from clan_charter_raid_terminals t join raids r on r.id=t.raid_id where r.id=${raid.id}`)
    .toEqual([{ exact: true }]);
  expect(await f.sql`select id from ledger_transactions where idempotency_key=${'raid-ante-refund:' + raid.id}`).toHaveLength(1);
  expect(await f.service().read(raid.id)).toMatchObject({ status: 'reconciled', originalClanId: c.id, terminalStatus: 'expired', chestShards: '0' });
  await getRaidEnergy(f.db, a.wallet, new Date(at.getTime() + 1_000)); expect(await balance(a.wallet)).toBe(before);
  expect(await f.entries(raid.id)).toHaveLength(0);
}, 120_000);
