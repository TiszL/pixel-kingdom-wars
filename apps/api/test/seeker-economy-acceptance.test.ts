/** D-150 composition: identical production, different ownership concentration.
 * Actual source/payout services share one encoded finalized Seeker term. KEEP
 * remains a funded publication plan here: signed delivery/recycling and permit
 * self-purchase/quota evidence live in programs/mining-local-{funded,tax}.ts and
 * programs/seeker-local-sales.ts. No fixture asserts demand or an exchange rate. */
import { randomUUID } from 'node:crypto';
import { PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { seekerTermPda } from '@shardkeep/chain/seeker-auction-protocol';
import { MINING, PHASE_E_POLICY, PHASE_E_STARTER_ACCESS, getMiningQuota } from '@shardkeep/shared';
import { starterRoutePreview } from '@shardkeep/shared/phaseEExpeditions';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildings, mineAccrualStates } from '../src/db/schema';
import { collectBaseMines, MINE_DAY_MS } from '../src/game/baseMining';
import { prefetchExpeditionTermReader } from '../src/game/expeditionTermReader';
import { readStoredExpeditionTerm } from '../src/game/expeditionTermStore';
import { claimSeekerResourceTax, readCompleteSeekerResourcePool } from '../src/game/seekerResourceClaims';
import { dispatchStarterExpedition } from '../src/game/starterExpeditionDispatch';
import { settleDueStarterExpeditions } from '../src/game/starterExpeditionReturns';
import { claimSeekerShardsTax } from '../src/mining/seekerShardsClaims';
import { readCompleteShardsTaxPool } from '../src/mining/shardsTaxHistory';
import { admitPhysicalMineTaxSources } from '../src/mining/shardsTaxMineSources';
import { withInitialFreeMiningFixture } from './fixtures/initialFreeMining';
import { createInitialFreePublicationSources, INITIAL_FREE_PUBLICATION_DAY, prepareInitialFreePublication } from './fixtures/initialFreePublication';
import { createStarterExpeditionFixture } from './fixtures/starterExpeditions';

const policy = PHASE_E_POLICY.seekerIsland, count = policy.totalSpots;
const start = new Date(`${INITIAL_FREE_PUBLICATION_DAY}T00:00:00.000Z`);
const route = starterRoutePreview(PHASE_E_STARTER_ACCESS.freeHomeRealm, 'long_survey');
// Enough actual returns for one whole original share with retained pool dust.
const trips = Number(BigInt(count) / BigInt(route.islandPoolQuantity)) + 1;
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

async function economy(allOneOwner: boolean) {
 let result!: { raw: bigint; shards: bigint; keep: bigint; rawNet: bigint; shardsNet: bigint;
  keepNet: bigint; recycle: bigint; rawPool: bigint; shardsPool: bigint; keepPool: bigint;
  ownerRaw: bigint; ownerShards: bigint; ownerKeep: bigint; peerRaw: bigint; peerShards: bigint; peerKeep: bigint };
 await withInitialFreeMiningFixture(async f => {
  const request = await prepareInitialFreePublication(f);
  vi.setSystemTime(start);
  // Two actual producers: the physical/raw producer and the qualified KEEP
  // participant. Only their original spot ownership changes between scenarios.
  const raw = await createStarterExpeditionFixture(f.conn.db, { now: start });
  const owners = Array.from({ length: count }, (_, spotId) =>
   allOneOwner || spotId < count / 2 ? raw.wallet : f.wallet);
  const source = await createInitialFreePublicationSources(f, undefined,
   owners.map((wallet, spotId) => ({ spotId, wallet: new PublicKey(wallet) })));
  const clock = (at: Date) => {
   vi.setSystemTime(at);
   source.term.store.get(SYSVAR_CLOCK_PUBKEY.toBase58())!.data.writeBigInt64LE(BigInt(Math.floor(+at / 1_000)), 32);
  };
  const reader = () => prefetchExpeditionTermReader(source.term.connect, source.term.policy);
  clock(start);
  const [mine] = await f.conn.db.insert(buildings).values({ playerWallet: raw.wallet,
   baseId: raw.baseId, type: 'mine', level: 1, tx: 10, ty: 10 }).returning();
  await f.conn.db.insert(mineAccrualStates).values({ mineBuildingId: mine!.id, lastAccrualAt: start, accruedShards: 0n });
  const admission = await admitPhysicalMineTaxSources(f.conn.db, raw.wallet,
   { idempotencyKey: randomUUID(), baseId: raw.baseId }, raw.authority, { reader: await reader(), clock: () => start });
  const returns = [];
  for (let i = 0; i < trips; i++) {
   clock(raw.now);
   const trip = await dispatchStarterExpedition(f.conn.db, raw.wallet, { ...raw.command, id: randomUUID(),
    routeId: route.routeId, routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion },
    raw.authority, { reader: await reader(), clock: () => raw.now });
   raw.now = trip.returnsAt; clock(raw.now);
   await f.conn.db.transaction(tx => settleDueStarterExpeditions(tx, raw.baseId, raw.now));
   returns.push(trip);
  }
  const first = returns[0]!, rawGross = BigInt(trips) * BigInt(route.grossQuantity), rawNet = BigInt(trips) * BigInt(route.netQuantity);
  const rawPool = BigInt(trips) * BigInt(route.islandPoolQuantity);
  expect(returns.every(r => r.termId === admission.termId && r.termHash === admission.termHash)).toBe(true);
  expect(await readCompleteSeekerResourcePool(f.conn.db, first.termId, first.termHash, first.resourceId)).toBe(rawPool);
  expect(await readCompleteShardsTaxPool(f.conn.db, first.termId, first.termHash)).toBe(0n);

  // One whole Mine day plus exactly one tax quantum gives SHARDS its own dust;
  // the second collection is real accrual, not a seeded tax/ledger balance.
  const quota = getMiningQuota(1, [1], 0, MINING.EPOCH_RATE_BPS);
  const extraGross = PHASE_E_POLICY.basisPoints / PHASE_E_POLICY.taxes.resources.islandPoolBps;
  const firstCollection = new Date(+start + MINE_DAY_MS);
  const lastCollection = new Date(+firstCollection + Math.ceil(extraGross * MINE_DAY_MS / quota));
  clock(firstCollection); await collectBaseMines(f.conn.db, raw.wallet, raw.authority, firstCollection);
  clock(lastCollection); await collectBaseMines(f.conn.db, raw.wallet, raw.authority, lastCollection);
  const shardsGross = BigInt(quota + extraGross);
  const shardsPool = shardsGross * BigInt(PHASE_E_POLICY.taxes.resources.islandPoolBps) / BigInt(PHASE_E_POLICY.basisPoints);
  const shardsNet = shardsGross - shardsPool;
  expect(await readCompleteShardsTaxPool(f.conn.db, first.termId, first.termHash)).toBe(shardsPool);
  expect(await readCompleteSeekerResourcePool(f.conn.db, first.termId, first.termHash, first.resourceId)).toBe(rawPool);
  const plan = await source.plan(request), publication = plan.publication;
  if (!publication) throw Error('Expected actual qualified KEEP publication');
  const manifest = JSON.parse(plan.manifestJson);
  expect(manifest.taxManifest.beneficiaries.map((b: { wallet: string }) => b.wallet)).toEqual(owners);
  const original = await readStoredExpeditionTerm(f.conn.db, admission.termId, admission.termHash);
  expect(manifest.taxManifest.source.term).toBe(seekerTermPda(source.term.policy.programId,
   source.term.policy.config, source.term.policy.round).toBase58());
  expect(manifest.taxManifest.source.source).toMatchObject({ round: original!.snapshot.source.round,
   config: original!.snapshot.source.auctionConfig, genesisHash: original!.snapshot.source.genesisHash,
   programId: original!.snapshot.source.programId });
  expect(publication.freeGross).toBe(publication.playerNet + publication.tax + publication.recycle);
  expect(publication.deedGross).toBe(0n);
  expect(publication.freeGross).toBeLessThanOrEqual(publication.budgetGross * BigInt(PHASE_E_POLICY.mining.freePoolBps) / BigInt(PHASE_E_POLICY.basisPoints));
  const stock = async (baseId: string) => BigInt((await f.conn.sql`select available::text from resource_stocks where base_id=${baseId} and resource_id=${first.resourceId}`)[0]?.available ?? '0');
  const shards = async (baseId: string) => BigInt((await f.conn.sql`select balance::text from accounts where kind='base_shards' and base_id=${baseId}`)[0]?.balance ?? '0');
  const sourceState = async () => ({
   raw: await f.conn.sql`select to_jsonb(r) value from starter_expedition_returns r order by id`,
   assessments: await f.conn.sql`select to_jsonb(a) value from shards_tax_assessments a order by operation_key,segment_id`,
   issuance: await f.conn.sql`select balance::text from accounts where kind='shard_genesis'`,
   xp: await f.conn.sql`select to_jsonb(e) value from mining_wallet_experience_days e order by day`,
   activity: await f.conn.sql`select to_jsonb(e) value from player_action_events e order by id`,
   ingots: await f.conn.sql`select to_jsonb(r) value from mining_ingot_reservations r order by id`,
  });
  const before = await sourceState(), peerShardsBefore = await shards(f.baseId);
  expect(await stock(raw.baseId)).toBe(rawNet); expect(await shards(raw.baseId)).toBe(shardsNet);
  const rawReceipts = [], shardReceipts = [];
  for (let spotId = 0; spotId < count; spotId++) {
   const wallet = owners[spotId]!, context = wallet === raw.wallet ? raw.authority : f.context;
   rawReceipts.push(await claimSeekerResourceTax(f.conn.db, wallet, { idempotencyKey: randomUUID(),
    baseId: context.baseId, termId: first.termId, resourceId: first.resourceId, spotId }, context));
   shardReceipts.push(await claimSeekerShardsTax(f.conn.db, wallet, { idempotencyKey: randomUUID(),
    baseId: context.baseId, termId: first.termId, spotId }, context));
  }
  const rawShare = rawPool / BigInt(count), shardsShare = shardsPool / BigInt(count), keepShare = publication.tax / BigInt(count);
  for (let spotId = 0; spotId < count; spotId++) {
   expect(rawReceipts[spotId]).toMatchObject({ spotId, wallet: owners[spotId], winnerCount: count, quantity: rawShare.toString() });
   expect(shardReceipts[spotId]).toMatchObject({ spotId, wallet: owners[spotId], winnerCount: count, quantity: shardsShare.toString() });
  }
  const owned = BigInt(allOneOwner ? count : count / 2), peers = BigInt(count) - owned;
  expect(await stock(raw.baseId)).toBe(rawNet + owned * rawShare);
  expect(await stock(f.baseId)).toBe(peers * rawShare);
  expect(await shards(raw.baseId)).toBe(shardsNet + owned * shardsShare);
  expect(await shards(f.baseId)).toBe(peerShardsBefore + peers * shardsShare);
  expect(BigInt((await f.conn.sql`select balance::text from accounts where kind='shards_tax_escrow'`)[0]!.balance)).toBe(shardsPool % BigInt(count));
  expect(rawPool % BigInt(count)).toBeGreaterThan(0n); expect(shardsPool % BigInt(count)).toBeGreaterThan(0n);
  expect(await sourceState()).toEqual(before);
  // Neither cross-currency payouts nor re-reading the unchanged day creates
  // another reservation, earning, allocation or same-day recycled budget.
  const again = await source.plan(request);
  expect(again.publication).toEqual(publication);
  expect(JSON.parse(again.manifestJson).awards).toEqual(manifest.awards);
  expect(await f.conn.sql`select epoch_id from mining_publication_attempts`).toHaveLength(0);
  expect(await f.conn.sql`select reservation_id from mining_ingot_dispositions`).toHaveLength(0);
  expect(await f.conn.sql`select sale_id from seeker_realm_sale_preparations`).toHaveLength(0);
  expect(await readCompleteSeekerResourcePool(f.conn.db, first.termId, first.termHash, first.resourceId)).toBe(rawPool);
  expect(await readCompleteShardsTaxPool(f.conn.db, first.termId, first.termHash)).toBe(shardsPool);
  expect(rawNet + owned * rawShare + peers * rawShare + rawPool % BigInt(count)).toBe(rawGross);
  expect(shardsNet + owned * shardsShare + peers * shardsShare + shardsPool % BigInt(count)).toBe(shardsGross);
  expect(publication.playerNet + owned * keepShare + peers * keepShare + publication.tax % BigInt(count) + publication.recycle).toBe(publication.freeGross);
  result = { raw: rawGross, shards: shardsGross, keep: publication.freeGross, rawNet, shardsNet,
   keepNet: publication.playerNet, recycle: publication.recycle, rawPool, shardsPool, keepPool: publication.tax,
   ownerRaw: owned * rawShare, ownerShards: owned * shardsShare, ownerKeep: owned * keepShare,
   peerRaw: peers * rawShare, peerShards: peers * shardsShare, peerKeep: peers * keepShare };
 }, { roster: true });
 return result;
}

describe('D-150 independent source pools and ownership incentives', () => {
 it('changes only original owner redistribution when identical production moves from 100/0 to 50/50 spots', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.stubEnv('PHASE_E_SEEKER_ENABLED', 'true');
  const concentrated = await economy(true), split = await economy(false);
  for (const key of ['raw', 'shards', 'keep', 'rawNet', 'shardsNet', 'keepNet', 'recycle', 'rawPool', 'shardsPool', 'keepPool'] as const)
   expect(concentrated[key]).toBe(split[key]);
  for (const [owner, peer] of [['ownerRaw', 'peerRaw'], ['ownerShards', 'peerShards'], ['ownerKeep', 'peerKeep']] as const) {
   expect(concentrated[owner]).toBe(split[owner] * 2n);
   expect(split[owner]).toBe(split[peer]); expect(concentrated[peer]).toBe(0n);
  }
 }, 180_000);
});
