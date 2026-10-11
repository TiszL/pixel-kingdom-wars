/** Full original-spot concentration comparison. Encoded, signed local chain
 * evidence drives the real verifier; all pool value comes from real returns.
 * This is injected finalized RPC evidence, not a live-chain attestation. */
import { randomUUID } from 'node:crypto';
import { Keypair, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { PHASE_E_POLICY, PHASE_E_STARTER_ACCESS } from '@shardkeep/shared';
import { starterRoutePreview } from '@shardkeep/shared/phaseEExpeditions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMiningTermFixture } from '../../../packages/chain/src/testFixtures/miningZeroWinnerTerm';
import { bases, baseSlots } from '../src/db/schema';
import { assertFreshLockedBaseAuthority } from '../src/game/baseOwnership';
import { prefetchExpeditionTermReader } from '../src/game/expeditionTermReader';
import { readStoredExpeditionTerm } from '../src/game/expeditionTermStore';
import { claimSeekerResourceTax, readCompleteSeekerResourcePool, readSeekerResourceClaim } from '../src/game/seekerResourceClaims';
import { dispatchStarterExpedition } from '../src/game/starterExpeditionDispatch';
import { settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { createTestPlayer } from './helpers';

const spots = PHASE_E_POLICY.seekerIsland.totalSpots;
const preview = starterRoutePreview(PHASE_E_STARTER_ACCESS.freeHomeRealm, 'long_survey');
// The smallest count that funds every spot and crosses the first whole share.
const trips = Number(BigInt(spots) / BigInt(preview.islandPoolQuantity)) + 1;
const start = new Date('2035-01-02T00:00:00.000Z');
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function concentration(allProducerOwned: boolean) {
 const conn = resourceClaimsDatabase();
 await conn.setup();
 try {
  vi.setSystemTime(start);
  const source = await createStarterExpeditionFixture(conn.db, { now: start });
  const other = await createTestPlayer(conn.db);
  const [destination] = await conn.db.insert(bases).values({ ownerWallet: other.wallet, status: 'active' }).returning();
  await conn.db.insert(baseSlots).values({ wallet: other.wallet, slot: 1, baseId: destination!.id });
  const otherAuthority = { baseId: destination!.id, assertAuthority: async (...args: Parameters<typeof assertFreshLockedBaseAuthority>) => {
   await assertFreshLockedBaseAuthority(...args);
  } };
  const owners = Array.from({ length: spots }, (_, spotId) =>
   allProducerOwned || spotId < spots / 2 ? source.wallet : other.wallet);
  const bank = await createMiningTermFixture({ day: '2035-01-01', genesisHash: Keypair.generate().publicKey,
   programId: Keypair.generate().publicKey, winners: owners.map((wallet, spotId) => ({ spotId, wallet: new PublicKey(wallet) })) });
  const accepted = [];
  for (let i = 0; i < trips; i++) {
   // Only the injected finalized Clock moves; original signed settlements and
   // accepted receipts stay byte-for-byte untouched throughout the scenario.
   bank.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(+source.now / 1_000), 32);
   vi.setSystemTime(source.now);
   const reader = await prefetchExpeditionTermReader(bank.connect, bank.policy);
   const trip = await dispatchStarterExpedition(conn.db, source.wallet, { ...source.command, id: randomUUID(),
    routeId: preview.routeId, routeVersion: preview.routeCatalogueVersion, rewardVersion: preview.rewardTableVersion },
    source.authority, { reader, clock: () => source.now });
   expect(trip).toMatchObject({ gross: BigInt(preview.grossQuantity), net: BigInt(preview.netQuantity), tax: BigInt(preview.islandPoolQuantity) });
   source.now = trip.returnsAt; vi.setSystemTime(source.now);
   const [proof] = await conn.db.transaction(tx => settleDueStarterExpeditions(tx, source.baseId, source.now));
   expect(proof!.entries.reduce((sum, e) => sum + e.delta, 0n)).toBe(0n);
   accepted.push(trip);
  }
  const original = accepted[0]!;
  expect(accepted.every(t => t.termId === original.termId && t.termHash === original.termHash)).toBe(true);
  const term = await readStoredExpeditionTerm(conn.db, original.termId, original.termHash);
  expect(term!.snapshot.spots).toHaveLength(spots);
  expect(term!.snapshot.spots.map(s => s.ownerWallet)).toEqual(owners);
  expect(+source.now).toBeLessThan(Date.parse(term!.snapshot.endsAt));
  const gross = BigInt(trips) * BigInt(preview.grossQuantity), net = BigInt(trips) * BigInt(preview.netQuantity);
  const pool = BigInt(trips) * BigInt(preview.islandPoolQuantity), share = pool / BigInt(spots), dust = pool % BigInt(spots);
  expect(pool).toBeGreaterThan(BigInt(spots)); expect(dust).toBeGreaterThan(0n); expect(gross).toBe(net + pool);
  expect(await readCompleteSeekerResourcePool(conn.db, original.termId, original.termHash, original.resourceId)).toBe(pool);
  const stock = async (baseId: string) => BigInt((await conn.sql`select available::text from resource_stocks where base_id=${baseId} and resource_id=${original.resourceId}`)[0]?.available ?? '0');
  expect(await stock(source.baseId)).toBe(net); expect(await stock(destination!.id)).toBe(0n);
  const sources = async () => ({
   trips: await conn.sql`select to_jsonb(s) as value from starter_expeditions s order by id`,
   returns: await conn.sql`select to_jsonb(r) as value from starter_expedition_returns r order by id`,
   entries: await conn.sql`select to_jsonb(e) as value from starter_expedition_entries e order by return_id,bucket`,
   harvesters: await conn.sql`select to_jsonb(e) as value from harvester_entries e`,
  });
  const before = await sources();
  const command = (spotId: number, baseId = owners[spotId] === source.wallet ? source.baseId : destination!.id) => ({
   idempotencyKey: randomUUID(), baseId, termId: original.termId, resourceId: original.resourceId, spotId });
  const claim = (spotId: number) => claimSeekerResourceTax(conn.db, owners[spotId]!, command(spotId),
   owners[spotId] === source.wallet ? source.authority : otherAuthority);
  // Both actors have a valid current destination. Only the original settled
  // winner, rather than a producer or today's selected base, owns each share.
  await expect(claimSeekerResourceTax(conn.db, other.wallet, command(0, destination!.id), otherAuthority))
   .rejects.toMatchObject({ code: 'SEEKER_RESOURCE_NOT_OWNER' });
  if (!allProducerOwned) await expect(claimSeekerResourceTax(conn.db, source.wallet, command(spots / 2, source.baseId), source.authority))
   .rejects.toMatchObject({ code: 'SEEKER_RESOURCE_NOT_OWNER' });
  expect(await conn.sql`select id from seeker_resource_claims`).toHaveLength(0);

  const firstCommand = command(0);
  const duplicates = await Promise.all(Array.from({ length: 3 }, () => claimSeekerResourceTax(conn.db, source.wallet, firstCommand, source.authority)));
  expect(duplicates).toEqual([duplicates[0], duplicates[0], duplicates[0]]);
  const racingKeys = await Promise.allSettled([claim(1), claim(1)]);
  expect(racingKeys.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(racingKeys.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'SEEKER_RESOURCE_NOTHING_DUE' } });
  const second = racingKeys.find(r => r.status === 'fulfilled');
  if (!second || second.status !== 'fulfilled') throw Error('Expected one original spot-1 payout');
  const receipts = [duplicates[0]!, second.value, ...await Promise.all(Array.from({ length: spots - 2 }, (_, i) => claim(i + 2)))];
  expect(receipts.map(r => r.spotId)).toEqual(Array.from({ length: spots }, (_, i) => i));
  for (const receipt of receipts) expect(receipt).toMatchObject({ wallet: owners[receipt.spotId], winnerCount: spots,
   poolTotal: pool.toString(), previousTotal: '0', cumulativeTotal: share.toString(), quantity: share.toString(), shardsIncluded: false });
  const king = receipts.slice(0, PHASE_E_POLICY.seekerIsland.kingSpots), regular = receipts.slice(PHASE_E_POLICY.seekerIsland.kingSpots);
  expect(king).toHaveLength(PHASE_E_POLICY.seekerIsland.kingSpots); expect(regular).toHaveLength(PHASE_E_POLICY.seekerIsland.regularSpots);
  expect(new Set([...king, ...regular].map(r => r.quantity))).toEqual(new Set([share.toString()]));
  const producerRebate = receipts.filter(r => r.wallet === source.wallet).reduce((sum, r) => sum + BigInt(r.quantity), 0n);
  const otherRebate = receipts.filter(r => r.wallet === other.wallet).reduce((sum, r) => sum + BigInt(r.quantity), 0n);
  expect(producerRebate).toBe(BigInt(allProducerOwned ? spots : spots / 2) * share);
  expect(otherRebate).toBe(BigInt(allProducerOwned ? 0 : spots / 2) * share);
  expect(producerRebate + otherRebate + dust).toBe(pool);
  expect(await stock(source.baseId)).toBe(net + producerRebate);
  expect(await stock(destination!.id)).toBe(otherRebate);
  expect(await stock(source.baseId) + await stock(destination!.id) + dust).toBe(gross);
  const payouts = await conn.sql`select bucket,count(*)::int as count,sum(delta)::text as total from seeker_resource_claim_entries group by bucket order by bucket`;
  expect(payouts).toEqual([{ bucket: 'base_stock', count: spots, total: (pool - dust).toString() },
   { bucket: 'island_pool', count: spots, total: (dust - pool).toString() }]);
  expect(await conn.sql`select id from seeker_resource_claims`).toHaveLength(spots);
  expect(await sources()).toEqual(before); // No new issuance or tax on tax receipts.
  expect(await readCompleteSeekerResourcePool(conn.db, original.termId, original.termHash, original.resourceId)).toBe(pool);
  await expect(claim(0)).rejects.toMatchObject({ code: 'SEEKER_RESOURCE_NOTHING_DUE' });
  vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'false');
  const reopened = conn.reopen();
  try {
   expect(await claimSeekerResourceTax(reopened.db, source.wallet, firstCommand, source.authority)).toEqual(duplicates[0]);
   expect(await readSeekerResourceClaim(reopened.db, other.wallet, firstCommand.idempotencyKey)).toBeNull();
  } finally { await reopened.sql.end(); vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'true'); }
  expect(await stock(source.baseId)).toBe(net + producerRebate);
  return { gross, net, pool, share, dust, producerRebate, otherRebate, producerStock: await stock(source.baseId) };
 } finally { await conn.close(); }
}

describe('100 original Seeker spots and producer concentration', () => {
 it('keeps identical production and equal per-spot rights while a 100-spot producer recovers twice the 50-spot rebate', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start); vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'true');
  const monopoly = await concentration(true), split = await concentration(false);
  for (const field of ['gross', 'net', 'pool', 'share', 'dust'] as const) expect(monopoly[field]).toBe(split[field]);
  expect(monopoly.producerRebate).toBe(split.producerRebate * 2n);
  expect(monopoly.producerStock).toBe(monopoly.gross - monopoly.dust);
  expect(split.producerStock).toBe(split.net + split.producerRebate);
  expect(split.otherRebate).toBe(split.producerRebate);
  expect(monopoly.producerStock - split.producerStock).toBe(split.otherRebate);
 }, 180_000);
});
