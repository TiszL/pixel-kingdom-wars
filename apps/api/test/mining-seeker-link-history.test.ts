import { sql } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { readMiningSeekerLinkHistory } from '../src/mining/seekerLinkHistory';
import { withSeekerLinkHistoryFixture as fixture } from './fixtures/seekerLinkHistory';

describe('recorded Seeker link continuity without credential or bonus authority', () => {
 it('proves no recorded link for a covered wallet without trusting a current badge', () => fixture(async f => {
  await f.conn.sql`update players set seeker_verified=true where wallet=${f.wallet}`; await f.close();
  const r = await readMiningSeekerLinkHistory(f.conn.db, f.request);
  expect(r).toMatchObject({ status: 'no_link', openingLink: null, closingLink: null, changes: [], activeThroughout: false, bonusAuthorized: false, eligibilityAuthorized: false, allocationAuthorized: false });
  expect(r.credentialHistory).toMatchObject({ priorHistory: 'unknown', uniqueSinceCoverage: true, claims: [] });
 }));
 it.each([false, true])('distinguishes unchanged row continuity from revoked=%s membership and ignores display/recheck fields', revoked => fixture(async f => {
  await f.clock('2020-01-01T12:00:00Z'); await f.link();
  if (revoked) await f.conn.sql`update seeker_links set revoked_at='2020-01-01T13:00:00.123456Z' where wallet=${f.wallet}`;
  await f.clock('2020-01-02T12:00:00Z'); await f.conn.sql`update seeker_links set verified_at=now(),last_checked_at=now(),member_number=9,skr_domain='fixture.skr' where wallet=${f.wallet}`;
  await f.close(); const r = await readMiningSeekerLinkHistory(f.conn.db, f.request);
  expect(r.status).toBe('continuous_link'); expect(r.activeThroughout).toBe(!revoked); expect(r.changes).toEqual([]);
  expect(r.openingLink).toEqual(r.closingLink);
  expect(r.openingLink).toEqual({ wallet: f.wallet, seekerWallet: f.seekerWallet, sgtMint: f.sgtMint, revokedAt: revoked ? '2020-01-01T13:00:00.123456Z' : null });
 }));
 it.each(['revoke-revive', 'delete-recreate', 'out-back'] as const)('does not restore continuity after %s despite matching endpoints', mutation => fixture(async f => {
  await f.clock('2020-01-01T12:00:00Z'); await f.link(); await f.clock('2020-01-02T12:00:00Z');
  if (mutation === 'revoke-revive') await f.conn.sql`update seeker_links set revoked_at='2020-01-02T12:00:00Z' where wallet=${f.wallet}`;
  else if (mutation === 'delete-recreate') await f.conn.sql`delete from seeker_links where wallet=${f.wallet}`;
  else await f.conn.sql`update seeker_links set wallet=${f.buyer} where wallet=${f.wallet}`;
  await f.clock('2020-01-02T13:00:00Z');
  if (mutation === 'revoke-revive') await f.conn.sql`update seeker_links set revoked_at=null where wallet=${f.wallet}`;
  else if (mutation === 'delete-recreate') await f.link();
  else await f.conn.sql`update seeker_links set wallet=${f.wallet} where wallet=${f.buyer}`;
  await f.close(); const r = await readMiningSeekerLinkHistory(f.conn.db, f.request);
  expect(r.status).toBe('changed_link'); expect(r.activeThroughout).toBe(false); expect(r.changes).toHaveLength(2); expect(r.openingLink).toEqual(r.closingLink);
  expect(r.credentialHistory.uniqueSinceCoverage).toBe(mutation !== 'out-back');
 }));
 it.each(['sgt-mint', 'seeker-wallet'] as const)('retains cross-wallet %s reuse after deletion, including revoked reservations', shared => fixture(async f => {
  await f.clock('2020-01-01T02:00:00Z'); await f.link(f.buyer);
  await f.conn.sql`update seeker_links set revoked_at='2020-01-01T02:30:00Z' where wallet=${f.buyer}`;
  const mint = shared === 'sgt-mint' ? f.sgtMint : f.key(), seeker = shared === 'seeker-wallet' ? f.seekerWallet : f.key();
  await expect(f.link(f.wallet, mint, seeker)).rejects.toThrow('duplicate key');
  await f.clock('2020-01-01T03:00:00Z'); await f.conn.sql`delete from seeker_links where wallet=${f.buyer}`; await f.link(f.wallet, mint, seeker);
  await f.close(); const r = await readMiningSeekerLinkHistory(f.conn.db, f.request);
  expect(r.status).toBe('continuous_link'); expect(r.activeThroughout).toBe(true); expect(r.credentialHistory.uniqueSinceCoverage).toBe(false);
  expect(new Set(r.credentialHistory.claims.flatMap(c => c.gameWallets))).toEqual(new Set([f.wallet, f.buyer]));
  expect(r.bonusAuthorized).toBe(false);
 }));
 it('keeps a temporary link visible when opening and closing are both null', () => fixture(async f => {
  await f.clock('2020-01-02T12:00:00Z'); await f.link(); await f.clock('2020-01-02T13:00:00Z'); await f.conn.sql`delete from seeker_links where wallet=${f.wallet}`;
  await f.close(); const r = await readMiningSeekerLinkHistory(f.conn.db, f.request);
  expect(r).toMatchObject({ status: 'changed_link', openingLink: null, closingLink: null, activeThroughout: false }); expect(r.changes).toHaveLength(2);
 }));
 it('uses exact half-open UTC microsecond boundaries and leaves earlier cutoffs unchanged', () => fixture(async f => {
  await f.clock('2020-01-01T23:59:59.999999Z'); await f.link(); await f.close();
  const before = await readMiningSeekerLinkHistory(f.conn.db, f.request); expect(before.status).toBe('continuous_link');
  await f.clock('2020-01-03T00:00:00.000000Z'); await f.conn.sql`delete from seeker_links where wallet=${f.wallet}`; await f.close();
  const zoned = await f.conn.db.transaction(async tx => { await tx.execute(sql`set local timezone='Asia/Tbilisi'`); return readMiningSeekerLinkHistory(tx as unknown as typeof f.conn.db, f.request); });
  expect(zoned).toEqual(before);
 }));
 it('treats exact-start acquisition as changed rather than continuous', () => fixture(async f => {
  await f.clock('2020-01-02T00:00:00.000000Z'); await f.link(); await f.close();
  expect(await readMiningSeekerLinkHistory(f.conn.db, f.request)).toMatchObject({ status: 'changed_link', openingLink: null, activeThroughout: false });
 }));
 it.each(['uncaptured', 'microsecond-before-coverage', 'born-at-day-start'] as const)('refuses %s birth instead of inventing an opening link', scenario => fixture(async f => {
  await f.close(); await expect(readMiningSeekerLinkHistory(f.conn.db, f.request)).rejects.toMatchObject({ code: 'IDENTITY_COVERAGE_UNAVAILABLE' });
 }, scenario === 'uncaptured' ? { preCoverageBirth: true } : scenario === 'microsecond-before-coverage' ? {
  coverageAt: '2020-01-01T00:00:00.000002Z', birthAt: '2020-01-01T00:00:00.000001Z', observedBirthAt: '2020-01-01T00:00:00.000003Z',
 } : { birthAt: '2020-01-02T00:00:00.000000Z' }));
 it('rejects current identity relabelling and unknown caller authority while retaining earlier cutoffs', () => fixture(async f => {
  await f.close(); const before = await readMiningSeekerLinkHistory(f.conn.db, f.request);
  await f.clock('2020-01-03T12:00:00Z'); await f.conn.sql`update players set created_at='2020-01-03T00:00:00Z' where wallet=${f.wallet}`; await f.close();
  expect(await readMiningSeekerLinkHistory(f.conn.db, f.request)).toEqual(before);
  await expect(readMiningSeekerLinkHistory(f.conn.db, { ...f.request, day: '2020-01-03' })).rejects.toMatchObject({ code: 'IDENTITY_COVERAGE_UNAVAILABLE' });
  for (const extra of [{ active: true }, { sgtMint: f.sgtMint }, { bonus: 1 }, { now: new Date() }, { day: '2020-02-30' }, { wallet: '1'.repeat(100000) }])
   await expect(readMiningSeekerLinkHistory(f.conn.db, { ...f.request, ...extra })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
 }));
 it('reproduces the old non-cohort truncate gap while dormant and refuses retrospective coverage', () => fixture(async f => {
  await f.clock('2020-01-01T12:00:00Z'); await f.link();
  const before = await f.conn.sql`select id from mining_free_cohort_events where wallet=${f.wallet} and source_table='seeker_links'`;
  expect(await f.conn.sql`select * from mining_free_cohorts`).toHaveLength(0);
  await f.conn.sql`truncate seeker_links`;
  expect(await f.conn.sql`select id from mining_free_cohort_events where wallet=${f.wallet} and source_table='seeker_links'`).toEqual(before);
  await f.initialize(); await f.close();
  await expect(readMiningSeekerLinkHistory(f.conn.db, f.request)).rejects.toMatchObject({ code: 'IDENTITY_COVERAGE_UNAVAILABLE' });
 }, { marker: false }));
 it('uses the event floor to exclude a same-clock pre-marker birth and permits a subsequent original birth', () => fixture(async f => {
  const fresh = f.key(); await f.conn.sql`insert into players(wallet,created_at) values(${fresh},'2020-01-01T01:00:00Z')`; await f.close();
  await expect(readMiningSeekerLinkHistory(f.conn.db, f.request)).rejects.toMatchObject({ code: 'IDENTITY_COVERAGE_UNAVAILABLE' });
  expect(await readMiningSeekerLinkHistory(f.conn.db, { ...f.request, wallet: fresh })).toMatchObject({ status: 'no_link' });
 }, { birthAt: '2020-01-01T01:00:00Z', markerAt: '2020-01-01T01:00:00Z', beforeMarkerBirth: true }));
 it('preserves initialized truncate protection, marker immutability and receipts through migration retries', () => fixture(async f => {
  await f.clock('2020-01-01T12:00:00Z'); await f.link(); await f.close(); const first = await readMiningSeekerLinkHistory(f.conn.db, f.request);
  for (let i = 0; i < 2; i++) await f.migrate();
  await expect(f.conn.sql`truncate seeker_links`).rejects.toThrow('MINING_SEEKER_LINK_HISTORY_RETAINED');
  await expect(f.conn.sql`update mining_seeker_link_coverage set birth_event_floor=0`).rejects.toThrow('MINING_SEEKER_LINK_COVERAGE_IMMUTABLE');
  await expect(f.conn.sql`delete from mining_seeker_link_coverage`).rejects.toThrow('MINING_SEEKER_LINK_COVERAGE_IMMUTABLE');
  await expect(f.conn.sql`truncate mining_seeker_link_coverage`).rejects.toThrow('MINING_SEEKER_LINK_COVERAGE_IMMUTABLE');
  expect(await readMiningSeekerLinkHistory(f.conn.db, f.request)).toEqual(first);
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false'); await f.initialize();
 }));
 it('rejects missing exact capture sites at initialization and later reads', () => fixture(async f => {
  await f.conn.sql`alter table seeker_links disable trigger seeker_links_mining_free_capture`;
  await expect(f.initialize()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
  await f.conn.sql`alter table seeker_links enable trigger seeker_links_mining_free_capture`;
  await f.initialize(); await f.close();
  await f.conn.sql`alter table seeker_links disable trigger seeker_links_mining_history_no_truncate`;
  await expect(readMiningSeekerLinkHistory(f.conn.db, f.request)).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
 }, { marker: false }));
 it('refuses a column-filtered UPDATE trigger even when table, name, function and event bits match', () => fixture(async f => {
  await f.conn.sql`drop trigger seeker_links_mining_free_capture on seeker_links`;
  await f.conn.sql`create trigger seeker_links_mining_free_capture after insert or delete or update of member_number on seeker_links for each row execute function public.shardkeep_capture_mining_free()`;
  await expect(f.initialize()).rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' });
 }, { marker: false }));
 it('bounds historical day spans before decoding source rows', () => fixture(async f => {
  await f.clock('2099-01-01T00:00:00Z');
  await expect(readMiningSeekerLinkHistory(f.conn.db, { ...f.request, day: '2050-01-01' })).rejects.toMatchObject({ code: 'TOO_LARGE' });
 }));
 it('binds the new definer to its original public truncate trigger and rejects broadly granted marker writes', () => fixture(async f => {
  const role = `seeker_history_${f.key().slice(0, 12).toLowerCase()}`;
  await f.conn.sql.unsafe(`create role ${role}`);
  try {
   await f.conn.sql.unsafe(`grant usage on schema public to ${role}; grant all on all tables in schema public to ${role}; grant execute on all functions in schema public to ${role}`);
   await expect(f.conn.sql.begin(async tx => { await tx.unsafe(`set local role ${role}`); await tx`insert into mining_seeker_link_coverage(id) values(true)`; })).rejects.toThrow('MINING_SEEKER_LINK_OWNER_REQUIRED');
   await expect(f.conn.sql.begin(async tx => {
    await tx.unsafe(`set local role ${role}`); await tx`create temporary table seeker_links(x int)`;
    await tx`create trigger seeker_links_mining_history_no_truncate before truncate on pg_temp.seeker_links for each statement execute function public.shardkeep_mining_seeker_link_no_truncate()`;
    await tx`truncate pg_temp.seeker_links`;
   })).rejects.toThrow('MINING_SEEKER_LINK_SOURCE_INVALID');
  } finally { await f.conn.sql.unsafe(`drop owned by ${role}`); await f.conn.sql.unsafe(`drop role ${role}`); }
 }));
 it.each([9999, 10000])('refuses bounded history overflow from %i actual source mutations', count => fixture(async f => {
  await f.clock('2020-01-01T12:00:00Z'); await f.link(); await f.clock('2020-01-02T12:00:00Z');
  await f.conn.sql.unsafe(`do $$ begin for i in 1..${count} loop update seeker_links set revoked_at=case when i%2=0 then null else '2020-01-02T12:00:00Z'::timestamptz end where wallet='${f.wallet}'; end loop; end $$`);
  await f.close(); await expect(readMiningSeekerLinkHistory(f.conn.db, f.request)).rejects.toMatchObject({ code: 'TOO_LARGE' });
 }), 120_000);
 it('reports original cross-midnight observations without inventing atomic transaction or earning authority', () => fixture(async f => {
  await f.clock('2020-01-01T23:59:59.999999Z');
  await f.conn.sql.begin(async tx => {
   await tx`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.wallet},${f.seekerWallet},${f.sgtMint})`;
   await tx.unsafe("create or replace function public.shardkeep_mining_free_clock() returns timestamptz language sql volatile as $$ select '2020-01-02T00:00:01Z'::timestamptz $$");
   await tx`insert into seeker_links(wallet,seeker_wallet,sgt_mint) values(${f.buyer},${f.key()},${f.key()})`;
  });
  await f.close();
  const rows = await f.conn.sql`select wallet,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at from mining_free_cohort_events where source_table='seeker_links' order by id`;
  expect(rows).toEqual([{ wallet: f.wallet, at: '2020-01-01T23:59:59.999999Z' }, { wallet: f.buyer, at: '2020-01-02T00:00:01.000000Z' }]);
  expect(await readMiningSeekerLinkHistory(f.conn.db, f.request)).toMatchObject({
   status: 'continuous_link', activeThroughout: true, changes: [], continuityAuthority: 'recorded-source-observations', atomicTransactionHistory: 'unavailable',
   historicalChainOwnership: 'unknown', bonusAuthorized: false, eligibilityAuthorized: false, allocationAuthorized: false, publicationAuthorized: false,
  });
 }));
 it('replays while paused without writes and refuses source contention', () => fixture(async f => {
  await f.clock('2020-01-01T12:00:00Z'); await f.link(); await f.close(); vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  const r = await f.conn.db.transaction(async tx => { await tx.execute(sql`set transaction read only`); return readMiningSeekerLinkHistory(tx as unknown as typeof f.conn.db, f.request); }); expect(r.status).toBe('continuous_link');
  let ready!: () => void, release!: () => void; const started = new Promise<void>(r => { ready = r; }), gate = new Promise<void>(r => { release = r; });
  const writer = f.conn.sql.begin(async tx => { await tx`lock table seeker_links in row exclusive mode`; ready(); await gate; });
  try { await started; await expect(readMiningSeekerLinkHistory(f.conn.db, f.request)).rejects.toMatchObject({ code: 'BUSY' }); } finally { release(); await writer; }
 }));
});
