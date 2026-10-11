/** D153.211 actual earned vehicle inputs on a fresh, same-owner paid base.
 * Facilities, deeds and expedition term observations are explicit local facts.
 * The inherited Divine sponsor's seeded stock stays on its original base; this
 * destination receives only played-Divine fragments and earned/refined goods.
 * The fragment wrapper owns the isolated DB. No validator or live source runs. */
import { randomUUID } from 'node:crypto';
import { Keypair, PublicKey } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, PHASE_E_ORDINARY_CRAFTING as C, PHASE_E_POLICY } from '@shardkeep/shared';
import { StarterCommonRouteIdSchema, starterRoutePreview } from '@shardkeep/shared/phaseEExpeditions';
import { ORDINARY_REFINED_IDS, ORDINARY_REFINED_INPUTS, ordinaryCraftingRecipe, type OrdinaryRefinedId } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { vehicleCraftRecipe } from '@shardkeep/shared/phaseEVehicleRecipes';
import bs58 from 'bs58';
import { eq, sql } from 'drizzle-orm';
import { expect, vi } from 'vitest';
import { bases, baseSlots, builderJobs, buildings } from '../../src/db/schema';
import { fantasyManifestHash, planFantasyMigration, rehearseFantasyMigration } from '../../src/db/fantasyMigration';
import { assertFreshLockedBaseAuthority, refreshBaseOwnership } from '../../src/game/baseOwnership';
import { createDivineFragments } from '../../src/game/divineFragments';
import type { ExpeditionTermReader, ExpeditionTermSnapshot } from '../../src/game/expeditionTerms';
import { readOrdinaryCrafting, settleDueOrdinaryCrafting, startOrdinaryCrafting } from '../../src/game/ordinaryCrafting';
import { dispatchStarterExpedition } from '../../src/game/starterExpeditionDispatch';
import { readStarterExpeditionReturn, settleDueStarterExpeditions } from '../../src/game/starterExpeditionReturns';
import { installStarterFleet } from '../../src/game/starterFleet';
import { withDivineFragmentFixture, type DivineFragmentFixture } from './divineFragments';

async function earnedSource(f: DivineFragmentFixture) {
  // Reuse the exact underlying earned-Renown / played-Divine source, choosing
  // the clean destination before its first personal delivery. The market
  // wrapper delivers to its preexisting sponsor base and cannot prove that
  // base's refined inventory was all earned.
  await f.fragments.enroll(f.event.id);
  await f.play();
  const settlement = await f.settle();
  expect(settlement.awards).toHaveLength(2);
  const conn = f.f.conn, db = f.db, collection = f.options.deedCollection!;
  const wallet = f.wallet, signer = f.f.walletSigner;
  const owners = new Map<string, string>();
  const deedReader = async (asset: string) => {
    const owner = owners.get(asset);
    return owner ? { owner, collection, slot: 100_000, frozen: false, delegate: null } : null;
  };
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(f.clock());
  process.env.MULTI_BASE_ENABLED = 'true';
  const recipe = vehicleCraftRecipe('survey_balloon', 1);
  // Three separate original attempts are the local composition's test coverage,
  // not a game quantity, allowance or new recipe choice.
  const originalCount = 3;
  const requiredInputs = recipe.inputs.map(input => ({ ...input, quantity: (BigInt(input.quantity) * BigInt(originalCount)).toString() }));
  let realClock = false;
  const clock = () => realClock ? new Date() : f.clock();
  const advance = (value: Date) => {
    if (realClock) throw Error('Historical source clock is closed after switching to real time');
    f.setTime(new Date(Math.max(+clock(), +value)));
    vi.setSystemTime(clock());
  };
  const deed = Keypair.generate().publicKey.toBase58();
  owners.set(deed, wallet);
  const [base] = await db.insert(bases).values({ ownerWallet: wallet, status: 'active', deedAssetId: deed, landPaidAt: clock() }).returning();
  const baseId = base!.id;
  const occupied = await db.select({ slot: baseSlots.slot }).from(baseSlots).where(eq(baseSlots.wallet, wallet));
  const slot = Array.from({ length: PHASE_E_POLICY.bases.activePerWalletMax }, (_, i) => i + 1).find(value => !occupied.some(row => row.slot === value));
  if (!slot) throw Error('Earned vehicle fixture needs an available original owner slot');
  await db.insert(baseSlots).values({ wallet, slot, baseId });
  const authority = { baseId, assertAuthority: async (...args: Parameters<typeof assertFreshLockedBaseAuthority>) => { await assertFreshLockedBaseAuthority(...args); } };
  const seller = { wallet, baseId, signer, deed, collection, authority };
  async function refresh() {
    expect(await refreshBaseOwnership(db, baseId, deedReader, collection, clock(), 'vehicle-material-earned-source', clock)).toBe('owned');
  }
  await refresh();
  const claims = await db.query.fantasyLandClaims.findMany();
  const manifest = planFantasyMigration({ snapshotAt: clock().toISOString(), active: [{ baseId, mintId: deed, ownerWallet: wallet }], inactive: [], exclusions: [],
    unavailableTileIds: claims.filter(claim => claim.state !== 'released').map(claim => claim.tileId) });
  await rehearseFantasyMigration(db, manifest, fantasyManifestHash(manifest));
  async function facility(type: BuildingType.Berth | BuildingType.Lodge | BuildingType.Workshop, x: number) {
    const [building] = await db.insert(buildings).values({ baseId, playerWallet: wallet, type, tx: x, ty: 2 }).returning();
    const completedAt = new Date(+clock() - 1_000);
    await db.insert(builderJobs).values({ baseId, playerWallet: wallet, buildingId: building!.id, kind: 'build',
      startedAt: new Date(+completedAt - BUILD_COSTS[type].buildSec * 1_000), finishesAt: completedAt, completedAt });
    return building!;
  }
  const berth = await facility(BuildingType.Berth, 2);
  await facility(BuildingType.Lodge, 5);
  await facility(BuildingType.Workshop, 9);
  const installation = await installStarterFleet(db, wallet, berth.id, authority);
  const preview = starterRoutePreview('crownlands', 'introduction');
  const command = { id: randomUUID(), baseId, installationId: installation.installationId,
    routeId: preview.routeId, routeVersion: preview.routeCatalogueVersion, rewardVersion: preview.rewardTableVersion };
  const key = (byte: number) => new PublicKey(new Uint8Array(32).fill(byte)).toBase58();
  const startsAt = new Date(+clock() - 3_600_000).toISOString();
  const snapshot: ExpeditionTermSnapshot = { version: 1, termId: randomUUID(), startsAt,
    endsAt: new Date(Date.parse(startsAt) + PHASE_E_POLICY.seekerIsland.operatingTermSec * 1_000).toISOString(),
    source: { kind: 'solana_auction_round', genesisHash: key(201), programId: key(202), auctionConfig: Keypair.generate().publicKey.toBase58(), round: '1' },
    spots: Array.from({ length: PHASE_E_POLICY.seekerIsland.totalSpots }, (_, spotId) => ({ spotId, ownerWallet: null,
      auctionAccount: key(spotId + 1), settlementSignature: bs58.encode(new Uint8Array(64).fill(7)), settlementSlot: String(100 + spotId), termsHash: 'ab'.repeat(32) })) };
  const reader: ExpeditionTermReader = { async readOperatingTerm(dispatchAt) {
    return { snapshot, finality: { commitment: 'finalized', observedAt: dispatchAt, contextSlot: '200' } };
  } };
  const stock = async () => ({
    refined: await db.execute<{ item_id: string; available: string; pending_output: string; market_outgoing: string; market_incoming: string; mining_pending: string }>(sql`select item_id,available::text,pending_output::text,market_outgoing::text,market_incoming::text,mining_pending::text from crafting_stocks where base_id=${baseId} order by item_id`),
    raw: await db.execute<{ resource_id: string; available: string }>(sql`select resource_id,available::text from resource_stocks where base_id=${baseId} order by resource_id`),
    fragments: (await db.execute<{ available: string; market_outgoing: string; market_incoming: string }>(sql`select available::text,market_outgoing::text,market_incoming::text from crystal_fragment_stocks where base_id=${baseId}`))[0]
      ?? { available: '0', market_outgoing: '0', market_incoming: '0' },
  });
  const baseline = await stock();
  expect(baseline.refined).toHaveLength(0);
  expect(baseline.raw).toHaveLength(0);
  expect(baseline.fragments.available).toBe('0');
  const inheritedBaseId = f.baseId;
  const inheritedRefined = await db.execute<{ item_id: string; available: string }>(sql`select item_id,available::text from crafting_stocks where base_id=${inheritedBaseId} order by item_id`);
  const fragmentInput = requiredInputs.find(input => input.kind === 'fragment')!;
  const award = settlement.awards.find(row => row.wallet === wallet)!;
  expect(BigInt(award.net)).toBeGreaterThanOrEqual(BigInt(fragmentInput.quantity));
  // The immutable played-event award supports an ordinary destination choice;
  // the original personal delivery goes directly to this fresh base.
  await refresh();
  const fragments = createDivineFragments(db, { ...f.options, finalizedDeedReader: deedReader });
  const sourceReceipt = await fragments.deliver(wallet, f.event.id, { idempotencyKey: randomUUID(), baseId });
  expect(sourceReceipt.quantity).toBe(award.net);
  const originalDelivery = structuredClone(sourceReceipt), originalAwards = structuredClone(settlement.awards), originalPool = structuredClone(settlement.record);
  async function assertOriginalSource() {
    expect((await fragments.award(wallet, f.event.id)).delivery).toEqual(originalDelivery);
    const replay = await fragments.settle(f.event.id);
    expect(replay.awards).toEqual(originalAwards);
    expect(replay.record).toEqual(originalPool);
  }
  const expeditionReceipts: NonNullable<Awaited<ReturnType<typeof readStarterExpeditionReturn>>>[] = [];
  const refiningReceipts: NonNullable<Awaited<ReturnType<typeof readOrdinaryCrafting>>>[] = [];
  for (const input of requiredInputs.filter(input => input.kind === 'refined')) {
    if (!(ORDINARY_REFINED_IDS as readonly string[]).includes(input.itemId)) throw Error('Vehicle recipe needs an unadmitted ordinary material');
    const item = input.itemId as OrdinaryRefinedId, rawId = ORDINARY_REFINED_INPUTS[item];
    const routeId = StarterCommonRouteIdSchema.options.find(id => starterRoutePreview('crownlands', id).resourceId === rawId);
    if (!routeId) throw Error('Vehicle leaf material has no admitted common route');
    const route = starterRoutePreview('crownlands', routeId);
    let remaining = BigInt(input.quantity);
    while (remaining > 0n) {
      const quantity = Number(remaining > BigInt(C.v1.maxBatch) ? BigInt(C.v1.maxBatch) : remaining);
      const refining = ordinaryCraftingRecipe(`refine_${item}`, C.currentRecipeVersion, quantity);
      const [before] = await db.execute<{ available: string }>(sql`select available::text from resource_stocks where base_id=${baseId} and resource_id=${rawId}`);
      const needed = BigInt(refining.inputs[0]!.quantity) - BigInt(before?.available ?? '0');
      const trips = needed > 0n ? (needed + BigInt(route.netQuantity) - 1n) / BigInt(route.netQuantity) : 0n;
      for (let i = 0n; i < trips; i++) {
        await refresh();
        const trip = await dispatchStarterExpedition(db, wallet, { ...command, id: randomUUID(), routeId,
          routeVersion: route.routeCatalogueVersion, rewardVersion: route.rewardTableVersion }, authority, { reader, clock });
        advance(trip.returnsAt);
        await db.transaction(tx => settleDueStarterExpeditions(tx, baseId, clock()));
        const returned = await readStarterExpeditionReturn(db, trip.id);
        if (!returned) throw Error('Actual vehicle material raw return is missing');
        expeditionReceipts.push(returned);
      }
      await refresh();
      const started = await startOrdinaryCrafting(db, wallet, { id: randomUUID(), baseId, recipeId: `refine_${item}`,
        recipeVersion: refining.recipeVersion, quantity }, authority, { clock });
      advance(started.job.readyAt);
      await db.transaction(tx => settleDueOrdinaryCrafting(tx, baseId, clock()));
      const completed = await readOrdinaryCrafting(db, started.job.id);
      if (!completed?.completion) throw Error('Actual vehicle leaf refining completion is missing');
      refiningReceipts.push(completed);
      remaining -= BigInt(refining.output.quantity);
    }
  }
  const earnedStock = await stock();
  for (const input of requiredInputs.filter(input => input.kind === 'refined')) {
    expect(earnedStock.refined.find(row => row.item_id === input.itemId)?.available).toBe(input.quantity);
    expect(refiningReceipts.filter(receipt => receipt.job.recipeSnapshot.output.itemId === input.itemId)
      .reduce((total, receipt) => total + BigInt(receipt.job.recipeSnapshot.output.quantity), 0n)).toBe(BigInt(input.quantity));
  }
  expect(earnedStock.fragments.available).toBe(sourceReceipt.quantity);
  expect(await db.execute(sql`select item_id,available::text from crafting_stocks where base_id=${inheritedBaseId} order by item_id`)).toEqual(inheritedRefined);
  await assertOriginalSource();
  // Validator polling and new finalized authority must use real time. Historical
  // receipts stay unchanged; no synthetic time leaks into the caller's SBF loop.
  vi.useRealTimers();
  realClock = true;
  f.setTime(clock());
  await refresh();
  return { conn, db, seller, collection, deedReader, clock, refresh, stock, recipe, originalCount, requiredInputs,
    sourceReceipt, fragmentReceipt: sourceReceipt, expeditionReceipts, refiningReceipts, baseline, earnedStock,
    inheritedBaseId, inheritedRefined, fragmentSource: { f, fragments, settlement, delivery: sourceReceipt, assertOriginalSource } };
}

export type VehicleMaterialEarnedSource = Awaited<ReturnType<typeof earnedSource>>;
export async function withVehicleMaterialEarnedSource(run: (source: VehicleMaterialEarnedSource) => Promise<void>) {
  const flags = ['ORDINARY_CRAFTING_ENABLED', 'STARTER_EXPEDITIONS_ENABLED', 'MULTI_BASE_ENABLED'];
  const prior = flags.map(key => [key, process.env[key]] as const);
  for (const key of flags.filter(key => key !== 'MULTI_BASE_ENABLED')) process.env[key] = 'true';
  try { await withDivineFragmentFixture(async source => run(await earnedSource(source))); }
  finally { for (const [key, value] of prior) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}
