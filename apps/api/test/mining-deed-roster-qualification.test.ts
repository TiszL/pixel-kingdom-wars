/** Roster-day source candidates never grant mining scores, class, capacity or replacement rights. */
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { qualifyDeedMiningRosterDay } from '../src/mining/deedRosterQualification';
import { withDeedRosterQualificationFixture as fixture } from './fixtures/deedRosterQualification';

describe('paid-deed registered-roster day qualification', () => {
 it.each([1, 5])('joins %i stable active paid bases to serialized continuous ownership', count => fixture(async f => {
  for (let slot = 1; slot <= count; slot++) await f.add(slot);
  await f.init(); await f.close();
  const r = await qualifyDeedMiningRosterDay(f.conn.db, f.chain().deps, f.request);
  expect(r.candidates).toEqual(f.registered.map((b, i) => ({ ...b, slot: i + 1 })));
  expect(r.excludedBases).toEqual([]);
  expect(r).toMatchObject({ wallet: f.wallet, day: f.request.day, policyVersion: 1, sourceQualification: 'complete', eligibilityAuthorized: false, scoringAuthorized: false, allocationReady: false, publicationAuthorized: false, replacementAuthorized: false });
  expect(r).not.toHaveProperty('weight'); expect(r).not.toHaveProperty('eligibleUnits');
  expect(r.candidates[0]).not.toHaveProperty('deedClass');
  vi.stubEnv('PHASE_E_MINING_ENABLED', 'false');
  expect((await qualifyDeedMiningRosterDay(f.conn.db, f.chain().deps, f.request)).candidates).toEqual(r.candidates);
 }));
 it('retains inactive and unregistered deeds as ownership evidence without creating candidates', () => fixture(async f => {
  const active = await f.add(1), inactive = await f.add(null), unregistered = Keypair.generate().publicKey.toBase58();
  await f.init(); await f.close();
  const r = await qualifyDeedMiningRosterDay(f.conn.db, f.chain({ extraHeld: [unregistered] }).deps, f.request);
  expect(r.candidates).toEqual([{ ...active, slot: 1 }]);
  expect(r.excludedBases).toEqual([{ ...inactive, reason: 'inactive_or_unslotted' }]);
  expect(r.unregisteredHeldAssetIds).toEqual([unregistered]);
  expect(r.sources.deeds.continuouslyHeldAssetIds).toEqual(expect.arrayContaining([active.assetId, inactive.assetId, unregistered]));
 }));
 it.each(['exact-start-mint', 'exact-start-acquisition', 'out-back', 'other-owner'] as const)('excludes proven %s ownership without inferring continuous ownership from the horizon', scenario => fixture(async f => {
  const b = await f.add(1); await f.init(); await f.close();
  const r = await qualifyDeedMiningRosterDay(f.conn.db, f.chain({ scenarios: { [b.assetId]: scenario } }).deps, f.request);
  expect(r.candidates).toEqual([]);
  expect(r.excludedBases).toEqual([{ ...b, reason: 'deed_not_continuously_owned' }]);
 }));
 it('keeps half-open closed-day ownership when a transfer happens exactly at the following midnight', () => fixture(async f => {
  const b = await f.add(1); await f.init(); await f.close();
  const r = await qualifyDeedMiningRosterDay(f.conn.db, f.chain({ scenarios: { [b.assetId]: 'transfer-at-end' } }).deps, f.request);
  expect(r.candidates).toEqual([{ ...b, slot: 1 }]);
  expect(r.sources.deeds.evidence.assets[0]!.ownerAtHorizon).not.toBe(f.wallet);
 }));
 it.each(['slot-removal', 'transfer-out-back'] as const)('preserves recorded %s even when both endpoint rosters match', mutation => fixture(async f => {
  const changed = await f.add(1), untouched = await f.add(2); await f.init();
  await f.clock('2035-01-02T12:00:00Z');
  if (mutation === 'slot-removal') await f.conn.sql`delete from base_slots where wallet=${f.wallet} and slot=1`;
  else await f.conn.sql`update bases set owner_wallet=${f.buyer} where id=${changed.baseId}`;
  await f.clock('2035-01-02T13:00:00Z');
  if (mutation === 'slot-removal') await f.conn.sql`insert into base_slots(wallet,slot,base_id) values(${f.wallet},1,${changed.baseId})`;
  else await f.conn.sql`update bases set owner_wallet=${f.wallet} where id=${changed.baseId}`;
  await f.close(); const r = await qualifyDeedMiningRosterDay(f.conn.db, f.chain().deps, f.request);
  expect(r.candidates).toEqual([{ ...untouched, slot: 2 }]);
  expect(r.excludedBases).toEqual([{ ...changed, reason: 'registered_roster_changed' }]);
  expect(r.sources.registeredRoster.open).toEqual(r.sources.registeredRoster.close);
 }));
 it('does not treat an exact-start registration as prior continuous roster membership', () => fixture(async f => {
  await f.init(); await f.clock('2035-01-02T00:00:00Z'); const b = await f.add(1); await f.close();
  const r = await qualifyDeedMiningRosterDay(f.conn.db, f.chain().deps, f.request);
  expect(r.candidates).toEqual([]); expect(r.excludedBases).toEqual([{ ...b, reason: 'registered_roster_changed' }]);
 }));
 it('excludes paid pending, free and absent-collection identities without inventing class or replacement rights', () => fixture(async f => {
  const pending = await f.add(1, 'pending'), free = await f.add(2, 'free'), absent = await f.add(3);
  await f.init(); await f.close();
  const r = await qualifyDeedMiningRosterDay(f.conn.db, f.chain({ omit: [absent.assetId] }).deps, f.request);
  expect(r.candidates).toEqual([]);
  expect(r.excludedBases).toEqual(expect.arrayContaining([
   { baseId: pending.baseId, assetId: null, reason: 'deed_not_finalized' },
   { baseId: free.baseId, assetId: null, reason: 'not_paid_before_day' },
   { ...absent, reason: 'deed_not_in_collection' },
  ]));
  expect(r.replacementAuthorized).toBe(false);
 }));
 it('refuses missing roster coverage and unavailable historical chain evidence', () => fixture(async f => {
  await f.add(1); await f.close(); const before = f.chain();
  await expect(qualifyDeedMiningRosterDay(f.conn.db, before.deps, f.request)).rejects.toMatchObject({ code: 'COVERAGE_UNAVAILABLE' });
  expect(before.reader.getProgramAccounts).not.toHaveBeenCalled();
  await f.clock('2035-01-01T12:00:00Z'); await f.init(); await f.close(); const missing = f.chain();
  missing.reader.getTransaction.mockResolvedValue(null);
  await expect(qualifyDeedMiningRosterDay(f.conn.db, missing.deps, f.request)).rejects.toMatchObject({ code: 'HISTORY_INCOMPLETE' });
 }));
 it.each(['different-finalized-and-reserved', 'cross-base-duplicate'] as const)('the DB rejects %s identity before it can become roster history', conflict => fixture(async f => {
  const a = await f.add(1), b = await f.add(2);
  if (conflict === 'different-finalized-and-reserved') await expect(f.conn.sql`update bases set deed_mint_asset_id=${Keypair.generate().publicKey.toBase58()} where id=${a.baseId}`).rejects.toThrow('differs from reserved deed');
  else {
   await f.conn.sql`update bases set deed_mint_asset_id=null where id=${a.baseId}`;
   await expect(f.conn.sql`update bases set deed_asset_id=null,deed_mint_asset_id=${a.assetId} where id=${b.baseId}`).rejects.toThrow('is attached to another base');
  }
  await f.init(); await f.close();
  expect((await qualifyDeedMiningRosterDay(f.conn.db, f.chain().deps, f.request)).candidates).toEqual([{ ...a, slot: 1 }, { ...b, slot: 2 }]);
 }));
 it.each(['duplicate-inventory', 'conflicting-owner'] as const)('refuses %s serialized source evidence without choosing an identity', corruption => fixture(async f => {
  const b = await f.add(1); await f.add(2); await f.init(); await f.close(); const chain = f.chain();
  if (corruption === 'duplicate-inventory') chain.reader.getProgramAccounts.mockResolvedValue({ context: { slot: 20 }, value: [chain.entries[0]!, chain.entries[0]!] });
  else {
   const otherOwner = f.chain({ scenarios: { [b.assetId]: 'other-owner' } });
   chain.reader.getProgramAccounts.mockResolvedValue({ context: { slot: 20 }, value: otherOwner.entries });
  }
  await expect(qualifyDeedMiningRosterDay(f.conn.db, chain.deps, f.request)).rejects.toMatchObject(corruption === 'duplicate-inventory' ? { code: 'SOURCE_REFUSED', sourceCode: 'ASSET_INVALID' } : { code: 'EVIDENCE_CONFLICT' });
 }));
 it('binds source configuration and rejects caller authority or invalid dates before reading providers', () => fixture(async f => {
  const chain = f.chain();
  for (const extra of [{ eligible: true }, { collection: chain.deps.collection }, { policyVersion: 2 }, { day: '2035-02-30' }, { wallet: 'x'.repeat(10000) }])
   await expect(qualifyDeedMiningRosterDay(f.conn.db, chain.deps, { ...f.request, ...extra })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(qualifyDeedMiningRosterDay(f.conn.db, { ...chain.deps, collection: 'bad' }, f.request)).rejects.toMatchObject({ code: 'SOURCE_CONFIGURATION_INVALID' });
  expect(chain.reader.getProgramAccounts).not.toHaveBeenCalled();
 }));
});
