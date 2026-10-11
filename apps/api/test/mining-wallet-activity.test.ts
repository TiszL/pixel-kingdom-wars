import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import * as experience from '../src/mining/walletExperience';
import { readMiningWalletActivity } from '../src/mining/walletActivity';
import { withWalletActivityFixture as fixture } from './fixtures/walletActivity';

describe('covered wallet XP and qualifying activity independent of free cohort', () => {
 it('reads a paid/deed wallet with no free cohort and keeps wallet XP after base transfer', () => fixture(async f => {
  const raid = await f.raid('2020-01-01'); await f.seal('2020-01-01'); await f.close();
  expect(await f.conn.sql`select * from mining_free_cohorts`).toHaveLength(0);
  const before = await readMiningWalletActivity(f.conn.db, f.request());
  expect(before).toMatchObject({ wallet: f.wallet, recordedXp: 100, todayQualifyingRaidIds: [raid.id], latestQualifiedAt: raid.at, latestDayActivityBps: 3333, allocationReady: false, publicationAuthorized: false });
  expect(before).not.toHaveProperty('usefulChainBps'); expect(before).not.toHaveProperty('capacityUnits');
  await f.conn.sql`update bases set owner_wallet=${f.buyer} where owner_wallet=${f.wallet}`;
  expect(await readMiningWalletActivity(f.conn.db, f.request())).toEqual(before);
 }));
 it('shares the wallet XP cap across two bases while a fourth victory refreshes activity and redeployment does not', () => fixture(async f => {
  const raids = [];
  for (let i = 0; i < 4; i++) raids.push(await f.raid('2020-01-01', { baseId: f.bases[i % 2]!, at: `2020-01-01T${10 + i}:00:00.000Z` }));
  await f.redeploy(raids[0]!.id, '2020-01-01T20:00:00.000Z'); await f.seal('2020-01-01'); await f.close();
  const r = await readMiningWalletActivity(f.conn.db, f.request());
  expect(r.recordedXp).toBe(300); expect(r.qualifiedRaids).toHaveLength(4);
  expect(r.days[0]!.awardedRaidIds).toEqual(raids.slice(0, 3).map(r => r.id));
  expect(r.latestQualifiedAt).toBe(raids[3]!.at); expect(r.latestDayActivityBps).toBe(10000);
 }));
 it('refuses a missing empty day and missing XP seal, then accepts the actual empty seal without manufacturing it', () => fixture(async f => {
  await f.raid('2020-01-01'); await f.seal('2020-01-01'); await f.raid('2020-01-03'); await f.seal('2020-01-03'); await f.close();
  await expect(readMiningWalletActivity(f.conn.db, f.request('2020-01-03'))).rejects.toMatchObject({ code: 'DAY_COVERAGE_UNAVAILABLE' });
  expect(await f.conn.sql`select day from mining_activity_evidence where day='2020-01-02'`).toHaveLength(0);
  expect(await f.conn.sql`select day from mining_wallet_experience_days where day='2020-01-02'`).toHaveLength(0);
  await f.activity('2020-01-02');
  await expect(readMiningWalletActivity(f.conn.db, f.request('2020-01-03'))).rejects.toMatchObject({ code: 'DAY_COVERAGE_UNAVAILABLE' });
  await f.seal('2020-01-02'); const r = await readMiningWalletActivity(f.conn.db, f.request('2020-01-03'));
  expect(r.recordedXp).toBe(200); expect(r.days[1]).toMatchObject({ day: '2020-01-02', qualifyingRaidIds: [], awardedXp: 0 });
 }));
 it('keeps earlier cutoffs unchanged after later XP and identity relabelling', () => fixture(async f => {
  await f.raid('2020-01-01'); await f.seal('2020-01-01'); await f.close();
  const first = await readMiningWalletActivity(f.conn.db, f.request());
  await f.raid('2020-01-02'); await f.seal('2020-01-02');
  await f.clock('2020-01-02T15:00:00Z'); await f.conn.sql`update players set created_at='2020-01-02T00:00:00Z' where wallet=${f.wallet}`; await f.close();
  expect(await readMiningWalletActivity(f.conn.db, f.request())).toEqual(first);
  await expect(readMiningWalletActivity(f.conn.db, f.request('2020-01-02'))).rejects.toMatchObject({ code: 'IDENTITY_COVERAGE_UNAVAILABLE' });
 }));
 it('rejects an uncaptured older birth even when current created_at is relabelled into coverage', () => fixture(async f => {
  await f.clock('2020-01-01T01:00:00Z'); await f.conn.sql`update players set created_at='2020-01-01T00:30:00Z' where wallet=${f.wallet}`;
  await f.seal('2020-01-01'); await f.close();
  await expect(readMiningWalletActivity(f.conn.db, f.request())).rejects.toMatchObject({ code: 'IDENTITY_COVERAGE_UNAVAILABLE' });
 }, { birthBeforeInitialization: true }));
 it('rejects deletion and rebirth as a new identity without erasing the earlier cutoff', () => fixture(async f => {
  await f.seal('2020-01-01'); await f.close(); const first = await readMiningWalletActivity(f.conn.db, f.request());
  await f.clock('2020-01-02T12:00:00Z'); await f.conn.sql`update bases set owner_wallet=${f.buyer} where owner_wallet=${f.wallet}`;
  await f.conn.sql`delete from player_action_events where wallet=${f.wallet}`;
  await f.conn.sql`delete from players where wallet=${f.wallet}`;
  await f.conn.sql`insert into players(wallet,created_at) values(${f.wallet},'2020-01-02T12:00:00Z')`;
  await f.seal('2020-01-02'); await f.close();
  expect(await readMiningWalletActivity(f.conn.db, f.request())).toEqual(first);
  await expect(readMiningWalletActivity(f.conn.db, f.request('2020-01-02'))).rejects.toMatchObject({ code: 'IDENTITY_COVERAGE_UNAVAILABLE' });
 }));
 it('keeps microsecond identity boundaries in PostgreSQL rather than promoting rounded display times', () => fixture(async f => {
  await f.seal('2020-01-01'); await f.close();
  await expect(readMiningWalletActivity(f.conn.db, f.request())).rejects.toMatchObject({ code: 'IDENTITY_COVERAGE_UNAVAILABLE' });
 }, { identityCoverageAt: '2020-01-01T00:00:00.000002Z', birthAt: '2020-01-01T00:00:00.000001Z', observedBirthAt: '2020-01-01T00:00:00.000003Z' }));
 it('excludes a microsecond partial activity day, reports the precise range, and stays UTC across session zones', () => fixture(async f => {
  await f.raid('2020-01-01'); await f.seal('2020-01-01'); await f.raid('2020-01-02'); await f.seal('2020-01-02'); await f.close();
  const r = await readMiningWalletActivity(f.conn.db, f.request('2020-01-02'));
  const [awards] = await f.conn.sql`select sum(points)::int all_points,sum(points) filter(where day>='2020-01-02')::int included_points from mining_wallet_experience_awards where wallet=${f.wallet}`;
  expect(awards).toEqual({ all_points: 200, included_points: 100 });
  expect(r.recordedXp).toBe(awards!.included_points); expect(r.experienceCoverage).toMatchObject({ fromDay: '2020-01-02', throughDay: '2020-01-02', partialBirthDayExcluded: true, activityCoverageStartedAt: '2020-01-01T00:00:00.000001Z' });
  const zoned = await f.conn.db.transaction(async tx => { await tx.execute(sql`set local timezone='Asia/Tbilisi'`); return readMiningWalletActivity(tx as unknown as typeof f.conn.db, f.request('2020-01-02')); });
  expect(zoned).toEqual(r);
 }, { activityCoverageAt: '2020-01-01T00:00:00.000001Z', birthAt: '2020-01-01T00:00:00.000002Z', observedBirthAt: '2020-01-01T00:00:00.000003Z' }));
 it('rejects a source event before immutable birth and refuses open days or caller authority', () => fixture(async f => {
  await f.raid('2020-01-01', { at: '2020-01-01T11:00:00.000Z' }); await f.seal('2020-01-01'); await f.close();
  await expect(readMiningWalletActivity(f.conn.db, f.request())).rejects.toMatchObject({ code: 'SOURCE_CONFLICT' });
  for (const extra of [{ xp: 999 }, { eligible: true }, { now: new Date() }, { policyVersion: 2 }, { day: '2020-02-30' }, { wallet: '1'.repeat(100000) }])
   await expect(readMiningWalletActivity(f.conn.db, { ...f.request(), ...extra })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await f.clock('2020-01-01T23:59:59Z'); await expect(readMiningWalletActivity(f.conn.db, f.request())).rejects.toMatchObject({ code: 'DAY_OPEN' });
 }, { birthAt: '2020-01-01T12:00:00Z' }));
 it('bounds the required day span before scanning or creating any journal', () => fixture(async f => {
  await f.clock('2099-01-01T00:00:00Z');
  await expect(readMiningWalletActivity(f.conn.db, f.request('2050-01-01'))).rejects.toMatchObject({ code: 'TOO_LARGE' });
  expect(await f.conn.sql`select * from mining_wallet_experience_days`).toHaveLength(0);
 }));
 it.each([1, 17])('bounds uncompressed source bytes across %i sealed days before replay', count => fixture(async f => {
  // Repeated text compresses well in PostgreSQL TOAST. Counting pg_column_size
  // would miss the actual JSON bytes that replay materializes in the process.
  const padding = 'x'.repeat(count === 1 ? 4_300_000 : 4_000_000);
  for (let i = 1; i <= count; i++) {
   const day = `2020-01-${String(i).padStart(2, '0')}`, raid = await f.raid(day);
   await f.conn.sql`update player_action_events set metadata=metadata||${JSON.stringify({ padding })}::jsonb where source_id=${raid.id} and source_key='battle_fought'`;
   await f.seal(day);
  }
  await f.close();
  await expect(readMiningWalletActivity(f.conn.db, f.request(`2020-01-${String(count).padStart(2, '0')}`))).rejects.toMatchObject({ code: 'TOO_LARGE' });
 }), 120_000);
 it('releases the live player barrier before replaying immutable day JSON', () => fixture(async f => {
  await f.raid('2020-01-01'); await f.seal('2020-01-01'); await f.close();
  const original = experience.collectMiningWalletExperience;
  let ready!: () => void, release!: () => void; const started = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  const replay = vi.spyOn(experience, 'collectMiningWalletExperience').mockImplementationOnce(async (db, value) => { ready(); await gate; return original(db, value); });
  const reading = readMiningWalletActivity(f.conn.db, f.request());
  try {
   await started;
   await f.conn.sql.begin(async tx => {
    await tx`set local lock_timeout='250ms'`;
    await tx`update players set created_at='2020-01-02T00:00:00Z' where wallet=${f.wallet}`;
   });
  } finally { release(); replay.mockRestore(); }
  expect((await reading).recordedXp).toBe(100);
 }));
 it('replays while paused in a read-only transaction and refuses concurrent source writers', () => fixture(async f => {
  await f.raid('2020-01-01'); await f.seal('2020-01-01'); await f.close(); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  const r = await f.conn.db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return readMiningWalletActivity(tx as unknown as typeof f.conn.db, f.request()); });
  expect(r.recordedXp).toBe(100);
  let ready!: () => void, release!: () => void; const started = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  const writer = f.conn.sql.begin(async tx => { await tx`lock table mining_activity_evidence in row exclusive mode`; ready(); await gate; });
  try { await started; await expect(readMiningWalletActivity(f.conn.db, f.request())).rejects.toMatchObject({ code: 'BUSY' }); } finally { release(); await writer; }
 }));
});
