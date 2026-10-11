/** Real private admissions and protected reads with synthetic completed facilities,
 * materials and term/finality evidence. No live chain or renderer claim. */
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Keypair } from '@solana/web3.js';
import { BUILD_COSTS, BuildingType, PHASE_E_HARVESTER, PHASE_E_ORDINARY_CRAFTING } from '@shardkeep/shared';
import { ordinaryCraftingRecipe } from '@shardkeep/shared/phaseEOrdinaryCrafting';
import { eq, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { bases, builderJobs, buildings, deedOwnershipObservations, harvesterSourceHeads, players, resourceStocks, sessions } from '../src/db/schema';
import { getBaseState } from '../src/game/base';
import { observationHash, transferStableBase } from '../src/game/baseOwnership';
import { withHarvesterActivity } from '../src/game/harvesterActivity';
import { readHarvesterSettlement, recordHarvesterCustodyStop, settleDueHarvesterSources } from '../src/game/harvesterSettlement';
import { selectHarvesterSource } from '../src/game/harvesterSources';
import { startOrdinaryCrafting } from '../src/game/ordinaryCrafting';
import { readServiceActivity } from '../src/game/serviceActivity';
import { createHarvesterFixture } from './fixtures/harvesters';
import { resourceClaimsDatabase } from './fixtures/resourceClaimsDatabase';
import { TEST_CONFIG } from './helpers';

const conn = resourceClaimsDatabase(), db = conn.db;
beforeAll(() => conn.setup(), 180_000);
afterAll(() => conn.close());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function freeze(at: Date) { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(at); }
async function fixture() {
  for (const flag of ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'HARVESTERS_ENABLED', 'ORDINARY_CRAFTING_ENABLED', 'FREE_ONBOARDING']) vi.stubEnv(flag, 'true');
  freeze(new Date(Date.now() - 3 * 86_400_000));
  const f = await createHarvesterFixture(db, { now: new Date() });
  const source = await selectHarvesterSource(db, f.wallet, { id: f.request.idempotencyKey, baseId: f.baseId,
    harvesterId: f.harvesterId, policyVersion: f.request.policyVersion }, f.authority, { clock: () => f.now, reader: f.reader });
  return { ...f, source };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const current = (f: Fixture, at = f.now, wallet = f.wallet) => getBaseState(db, wallet, at, f.baseId, f.authority.assertAuthority, () => at);
const item = (buildingId: string, state: 'working' | 'idle') => ({ buildingId, state });
async function facility(f: Fixture, type: BuildingType.Workshop | BuildingType.Harvester, x: number, pending = false) {
  const [b] = await db.insert(buildings).values({ baseId: f.baseId, playerWallet: f.wallet, type, level: pending ? 0 : 1, tx: x, ty: 10 }).returning();
  const completedAt = new Date(+f.now - 1000);
  await db.insert(builderJobs).values({ baseId: f.baseId, playerWallet: f.wallet, buildingId: b!.id, kind: 'build',
    startedAt: new Date(+completedAt - BUILD_COSTS[type].buildSec * 1000),
    finishesAt: pending ? new Date(+f.now + BUILD_COSTS[type].buildSec * 1000) : completedAt,
    completedAt: pending ? null : completedAt });
  return b!;
}

it('composes the exact original machine with genuine Workshop work and complete current idle closure', async () => {
  const f = await fixture(), workshop = await facility(f, BuildingType.Workshop, 12);
  const other = await facility(f, BuildingType.Harvester, 16), unfinished = await facility(f, BuildingType.Harvester, 20, true);
  const recipe = ordinaryCraftingRecipe('refine_crownsteel', PHASE_E_ORDINARY_CRAFTING.currentRecipeVersion, 1);
  for (const input of recipe.inputs) await db.insert(resourceStocks).values({ baseId: f.baseId, resourceId: input.itemId, available: BigInt(input.quantity) });
  await startOrdinaryCrafting(db, f.wallet, { id: randomUUID(), baseId: f.baseId, recipeId: recipe.recipeId,
    recipeVersion: recipe.recipeVersion, quantity: recipe.quantity }, f.authority, { clock: () => f.now });
  const state = await current(f), services = state.serviceActivity!.services;
  expect(services).toContainEqual(item(workshop.id, 'working'));
  expect(services).toContainEqual(item(f.harvesterId, 'working'));
  expect(services).toContainEqual(item(other.id, 'idle'));
  expect(services).toContainEqual(item(unfinished.id, 'idle'));
  expect(services.map(s => s.buildingId)).toEqual(services.map(s => s.buildingId).sort());
  expect(state.buildings.find(b => b.id === unfinished.id)?.underConstruction).toBe(true);
  expect(await getBaseState(db, f.wallet, f.now, f.baseId)).not.toHaveProperty('serviceActivity');
});

it('preserves accepted work while admission is paused and captures normal authenticated expiry as idle', async () => {
  const f = await fixture();
  const config = { ...TEST_CONFIG, FREE_ONBOARDING: 'true', MULTI_BASE_ENABLED: 'true' } as typeof TEST_CONFIG;
  const app = await buildApp(config, db);
  try {
    await app.ready();
    const [session] = await db.insert(sessions).values({ wallet: f.wallet, expiresAt: new Date(+f.now + SESSION_TTL_SEC * 1000) }).returning();
    const cookies = { [SESSION_COOKIE]: await issueSessionJwt(config, f.wallet, session!.id) };
    const path = `/base?baseId=${f.baseId}`;
    expect((await app.inject({ url: path })).statusCode).toBe(401);
    vi.stubEnv('HARVESTERS_ENABLED', 'false');
    vi.setSystemTime(new Date(+f.source.leaseExpiresAt - 1));
    const working = await app.inject({ url: path, cookies });
    expect(working.statusCode, working.body).toBe(200);
    expect(working.json().serviceActivity.services).toContainEqual(item(f.harvesterId, 'working'));
    vi.setSystemTime(f.source.leaseExpiresAt);
    const idle = await app.inject({ url: path, cookies });
    expect(idle.statusCode, idle.body).toBe(200);
    expect(idle.json().serviceActivity.services).toContainEqual(item(f.harvesterId, 'idle'));
    expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, f.source.id))).toHaveLength(1);
    const history = await readHarvesterSettlement(db, f.source.id);
    expect(history!.source).toEqual(f.source);
    expect(history!.events.at(-1)!.event.earnedAt).toEqual(f.source.leaseExpiresAt);
    expect((await app.inject({ url: path, cookies })).json().serviceActivity).toEqual(idle.json().serviceActivity);
    await writeFile('/tmp/harvester-activity-primary-http-pair.json', JSON.stringify({ provenance: {
      kind: 'normal-buildApp-authenticated-inject-response-bodies', wallet: f.wallet, baseId: f.baseId, harvesterId: f.harvesterId,
      authority: 'Actual private source admission, canonical settlement and protected /base reads. Synthetic completed facilities and original term/finality; historical Date-only clock.',
      boundary: 'Same accepted original immediately before and exactly at exclusive lease expiry. Harvester admission paused; no current provider injected. Expired head retained.',
      limits: 'Owner fixture DB connection; no restricted-login proof in this pair. No listening socket, native HTTP, browser, pixels, chain, release or new art admission.'
    }, working: working.body, idle: idle.body }, null, 2) + '\n');
  } finally { await app.close(); }
});

it('never rebinds a replacement lease or transfers the seller lease to the buyer', async () => {
  const f = await fixture(), other = await facility(f, BuildingType.Harvester, 16);
  const at = new Date(+f.now + 1000); vi.setSystemTime(at);
  const next = await selectHarvesterSource(db, f.wallet, { id: randomUUID(), baseId: f.baseId, harvesterId: other.id,
    policyVersion: f.request.policyVersion }, f.authority, { clock: () => at, reader: f.reader });
  const state = await current(f, at);
  expect(state.serviceActivity!.services).toContainEqual(item(f.harvesterId, 'idle'));
  expect(state.serviceActivity!.services).toContainEqual(item(other.id, 'working'));
  expect((await readHarvesterSettlement(db, f.source.id))!.closure!.reason).toBe('replacement');
  const buyer = Keypair.generate().publicKey.toBase58(), deed = Keypair.generate().publicKey.toBase58();
  await db.insert(players).values({ wallet: buyer });
  await db.update(bases).set({ deedAssetId: deed, deedMintAssetId: deed, landPaidAt: at }).where(eq(bases.id, f.baseId));
  await transferStableBase(db, f.baseId, f.wallet, buyer, deed, { owner: buyer, collection: Keypair.generate().publicKey.toBase58(),
    frozen: false, delegate: null, slot: 100, observedAtMs: +at }, () => at);
  await expect(current(f, at)).rejects.toMatchObject({ code: 'BASE_NOT_OWNED' });
  expect((await current(f, at, buyer)).serviceActivity!.services).toContainEqual(item(other.id, 'idle'));
  expect((await readHarvesterSettlement(db, next.id))!.closure!.reason).toBe('custody_change');
});

it('does not mistake a stopped retained head for operating authority', async () => {
  const f = await fixture(), at = new Date(+f.now + 1000);
  const deed = Keypair.generate().publicKey.toBase58(), buyer = Keypair.generate().publicKey.toBase58();
  await db.update(bases).set({ deedAssetId: deed, deedMintAssetId: deed }).where(eq(bases.id, f.baseId));
  await db.insert(deedOwnershipObservations).values({ baseId: f.baseId, assetId: deed, owner: buyer, slot: 300n,
    status: 'mismatch', source: 'synthetic-finalized-fixture', checkedAt: at, auditHash: observationHash(deed, buyer, 'mismatch', 300n, at) });
  // Exact canonical stop proof, without pretending a mismatched owner can still
  // pass the normal protected current authority check.
  await db.transaction(async tx => {
    await recordHarvesterCustodyStop(tx, f.baseId, at);
    const proofs = await settleDueHarvesterSources(tx, f.baseId, at);
    const currentBuildings = await tx.select().from(buildings).where(eq(buildings.baseId, f.baseId));
    const baseline = await readServiceActivity(tx, f.wallet, f.baseId, currentBuildings, at);
    expect((await withHarvesterActivity(tx, f.wallet, f.baseId, currentBuildings, at, baseline, proofs))!.services)
      .toContainEqual(item(f.harvesterId, 'idle'));
    expect(proofs[0]!.stop).not.toBeNull();
  });
  expect(await db.select().from(harvesterSourceHeads).where(eq(harvesterSourceHeads.sourceId, f.source.id))).toHaveLength(1);
});

it('holds unavailable or misbound machine facts and propagates canonical source and SQL errors', async () => {
  const f = await fixture(), other = await facility(f, BuildingType.Harvester, 16), rollback = Error('rollback owned mutation');
  await db.transaction(async tx => {
    const proofs = await settleDueHarvesterSources(tx, f.baseId, f.now);
    const bs = await tx.select().from(buildings).where(eq(buildings.baseId, f.baseId));
    const baseline = await readServiceActivity(tx, f.wallet, f.baseId, bs, f.now);
    expect(await withHarvesterActivity(tx, f.wallet, f.baseId, bs, f.now, null, proofs)).toBeNull();
    expect(await withHarvesterActivity(tx, 'foreign-actor', f.baseId, bs, f.now, baseline, proofs)).toBeNull();
    expect(await withHarvesterActivity(tx, f.wallet, randomUUID(), bs, f.now, baseline, proofs)).toBeNull();
    expect(await withHarvesterActivity(tx, f.wallet, f.baseId, bs.filter(b => b.id !== f.harvesterId), f.now, baseline, proofs)).toBeNull();
  });
  for (const mutation of [sql`update builder_jobs set building_id=${other.id} where id=${f.jobId}`,
    sql`update buildings set level=0 where id=${f.harvesterId}`]) {
    await expect(db.transaction(async tx => {
      await tx.execute(mutation);
      expect((await getBaseState(tx, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => f.now)).serviceActivity).toBeNull();
      throw rollback;
    })).rejects.toBe(rollback);
  }
  await expect(db.transaction(async tx => {
    await tx.execute(sql`set local session_replication_role=replica`);
    await tx.execute(sql`update harvester_sources set lease_expires_at=lease_expires_at+interval '1 second' where id=${f.source.id}`);
    await tx.execute(sql`set local session_replication_role=origin`);
    await getBaseState(tx, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => f.now);
  })).rejects.toThrow('Harvester source differs from original interval');
  await expect(db.transaction(async tx => {
    await tx.execute(sql`alter table builder_jobs rename to unavailable_builder_jobs`);
    await getBaseState(tx, f.wallet, f.now, f.baseId, f.authority.assertAuthority, () => f.now);
  })).rejects.toThrow();
});

it('does not require positive earning evidence for a live lease', async () => {
  const f = await fixture(), at = new Date(+f.now + PHASE_E_HARVESTER.v1.cadenceSec * 1000);
  await db.transaction(async tx => {
    const proofs = await settleDueHarvesterSources(tx, f.baseId, at);
    const bs = await tx.select().from(buildings).where(eq(buildings.baseId, f.baseId));
    const baseline = await readServiceActivity(tx, f.wallet, f.baseId, bs, at);
    // Composer-only typed control: substitute zero gross/net/tax for a real
    // proof's event. This is NOT a canonical cap-saturation history claim.
    // Normal monotonic scheduling cannot naturally exceed the current cap.
    const zero = proofs.map(p => ({ ...p, events: p.events.map(e => ({ ...e, event: { ...e.event, gross: 0n, net: 0n, tax: 0n } })) }));
    expect((await withHarvesterActivity(tx, f.wallet, f.baseId, bs, at, baseline, zero))!.services)
      .toContainEqual(item(f.harvesterId, 'working'));
    expect(proofs[0]!.events[0]!.event.gross).toBeGreaterThan(0n);
  });
});
