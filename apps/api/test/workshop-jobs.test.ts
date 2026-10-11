/**
 * Workshop refining — Forge Ingots (docs/phase-e/E2-WORKSHOP-CONTRACT.md §8; D-149 §5).
 *
 * WHY these cases: an ingot is 10,000 SHARDS leaving the raidable economy for
 * good. The contract's money rules — SHARDS spent at START and never refunded,
 * caps that count jobs in progress, lazy readiness on the server clock, the
 * job following the deed, receipts that recover an interrupted POST — are what
 * stop refining from becoming a free raid shelter, a duplicate-charge trap, or
 * an ingot faucet. Every number here is read from FORGE_INGOT, never inlined.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FORGE_INGOT, ITEMS, PHASE_E_POLICY, STRUCTURES } from '@shardkeep/shared';
import {
  matchWorkshopCollectEnvelope, matchWorkshopStartEnvelope, WorkshopCollectResultSchema,
  WorkshopStartResultSchema, WorkshopViewSchema,
} from '@shardkeep/shared/workshop';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { issueSessionJwt, SESSION_COOKIE, SESSION_TTL_SEC } from '../src/auth/session';
import { forgeIngotsEnabled, loadConfig, phaseEBuildingsEnabled } from '../src/config';
import {
  accounts, baseItems, baseRaidLocks, bases, baseSlots, builderJobs, buildings, ledgerEntries, ledgerTransactions,
  players, raids, sessions, workshopJobs,
} from '../src/db/schema';
import { getBaseShardBalance, rewardBaseShards, spendBaseShards } from '../src/game/baseEconomy';
import { transferStableBase } from '../src/game/baseOwnership';
import { reserveDeedRaidLoot } from '../src/game/raidLoot';
import {
  collectRefine, getWorkshopCollectReceipt, getWorkshopStartReceipt, getWorkshopView, refineBatchSize,
  refineDurationSec, refineSecPerIngotAt, startRefine, utcDayStart, workshopCapacity,
} from '../src/game/workshop';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
const db = conn.db;
let app: FastifyInstance;
const k = () => randomUUID();
const SHARDS_PER_INGOT = BigInt(FORGE_INGOT.shardsPerIngot);
const RECIPE = FORGE_INGOT.recipeVersion;
const HOUR = 60 * 60 * 1000;
const ENV = ['MULTI_BASE_ENABLED', 'PHASE_E_BUILDINGS_ENABLED', 'FORGE_INGOTS_ENABLED', 'FREE_ONBOARDING'] as const;
const prior: Partial<Record<(typeof ENV)[number], string | undefined>> = {};
beforeAll(async () => {
  for (const key of ENV) prior[key] = process.env[key];
  process.env['PHASE_E_BUILDINGS_ENABLED'] = 'true';
  process.env['FORGE_INGOTS_ENABLED'] = 'true';
  process.env['FREE_ONBOARDING'] = 'true';
  await bootstrapSystemAccounts(db);
  // Boot with multi-base OFF: the boot preflight demands a current owned
  // observation for every active deed in the SHARED test database, which
  // other suites' deed fixtures do not carry (base-bootstrap-route.test.ts
  // does the same). The route gates read the live env per request.
  process.env['MULTI_BASE_ENABLED'] = 'false';
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
  process.env['MULTI_BASE_ENABLED'] = 'true';
});
afterAll(async () => {
  await app.close();
  for (const key of ENV) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
  await conn.sql.end();
});

// Untyped no-op authority: the deed-authority callback is exercised by the
// route tests (a deedless base needs no chain evidence); the service tests
// pin money and state rules.
const context = (baseId: string) => ({ baseId, assertAuthority: async (): Promise<void> => {} });
type Json = Record<string, any>;

async function signIn(wallet: string) {
  const [session] = await db.insert(sessions).values({ wallet, expiresAt: new Date(Date.now() + SESSION_TTL_SEC * 1000) }).returning();
  return { [SESSION_COOKIE]: await issueSessionJwt(TEST_CONFIG, wallet, session!.id) };
}

/** A stable base: deedless (free tier) or a deed base, optional standing Workshop, optional SHARDS. */
async function fixture(opts: { deed?: boolean; keepLevel?: number; workshopLevel?: number; shards?: bigint; wallet?: string; slot?: number } = {}) {
  const wallet = opts.wallet ?? (await createTestPlayer(db)).wallet;
  const deedAssetId = opts.deed ? `workshop-deed-${randomUUID()}` : null;
  const [base] = await db.insert(bases).values({
    ownerWallet: wallet, status: 'active', keepLevel: opts.keepLevel ?? 1,
    ...(deedAssetId ? { deedAssetId, deedMintAssetId: deedAssetId, landPaidAt: new Date('2026-08-12T00:00:00.000Z') } : {}),
  }).returning();
  const baseId = base!.id;
  await db.insert(baseSlots).values({ wallet, slot: opts.slot ?? 1, baseId });
  let workshopId: string | undefined;
  if (opts.workshopLevel) {
    const [row] = await db.insert(buildings).values({
      playerWallet: wallet, baseId, type: 'workshop', level: opts.workshopLevel, tx: 20, ty: 20,
    }).returning();
    workshopId = row!.id;
  }
  if (opts.shards) await rewardBaseShards(db, baseId, opts.shards, 'test.workshop.fund', k());
  return { wallet, baseId, base: base!, deedAssetId, workshopId, cookies: await signIn(wallet) };
}

const ingotsOf = async (baseId: string) => (await db.select({ qty: baseItems.qty, via: baseItems.acquiredVia }).from(baseItems)
  .where(and(eq(baseItems.baseId, baseId), eq(baseItems.itemId, 'forge_ingot'))))[0] ?? null;
const jobsOf = (baseId: string) => db.select().from(workshopJobs).where(eq(workshopJobs.baseId, baseId));
async function shapeOf(txnId: string) {
  const rows = await db.select({ delta: ledgerEntries.delta, kind: accounts.kind, baseId: accounts.baseId })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txnId));
  return rows.map((r) => `${r.kind}${r.baseId ? `@${r.baseId}` : ''}:${r.delta}`).sort();
}
const start = (f: { wallet: string; baseId: string }, ingots: number, now: Date, key = k(), recipe = RECIPE) =>
  startRefine(db, f.wallet, f.baseId, ingots, recipe, key, now, context(f.baseId));
const collect = (f: { wallet: string; baseId: string }, jobId: string, now: Date, key = k()) =>
  collectRefine(db, f.wallet, f.baseId, jobId, key, now, context(f.baseId));
const post = (cookies: Record<string, string>, url: string, payload: object) => app.inject({ method: 'POST', url, cookies, payload });
const get = (cookies: Record<string, string>, url: string) => app.inject({ method: 'GET', url, cookies });

describe('rules are read from FORGE_INGOT, never inlined', () => {
  it('batch = min(max, baseSize + level × perWorkshopLevel)', () => {
    const { baseSize, perWorkshopLevel, max } = FORGE_INGOT.batch;
    expect(refineBatchSize(1)).toBe(Math.min(max, baseSize + perWorkshopLevel));
    expect(refineBatchSize(STRUCTURES.workshop.maxLevel)).toBe(Math.min(max, baseSize + STRUCTURES.workshop.maxLevel * perWorkshopLevel));
    expect(refineBatchSize(STRUCTURES.workshop.maxLevel)).toBeLessThanOrEqual(max);
  });
  it('duration: −refineSpeedupBpsPerLevel per level above L1, floored, × ingots', () => {
    const l1 = FORGE_INGOT.refineSecPerIngot;
    expect(refineSecPerIngotAt(1)).toBe(l1);
    expect(refineSecPerIngotAt(2)).toBe(Math.floor(l1 * (10_000 - FORGE_INGOT.refineSpeedupBpsPerLevel) / 10_000));
    expect(refineSecPerIngotAt(20)).toBeLessThan(refineSecPerIngotAt(2));
    expect(refineDurationSec(7, 3)).toBe(7 * refineSecPerIngotAt(3));
  });
  it('capacity: free units for a deedless base; the deed ladder climbs with Keep level', () => {
    const { freeUnits, deedMinUnits, deedMaxUnits } = FORGE_INGOT.capacity;
    expect(freeUnits).toBe(PHASE_E_POLICY.mining.freeCapacityUnitsPerWalletDay);
    expect(workshopCapacity({ keepLevel: 20, landPaidAt: null, deedAssetId: null })).toBe(freeUnits);
    expect(workshopCapacity({ keepLevel: 1, landPaidAt: new Date(), deedAssetId: null })).toBe(deedMinUnits);
    expect(workshopCapacity({ keepLevel: STRUCTURES.keep.maxLevel, landPaidAt: null, deedAssetId: 'x' })).toBe(deedMaxUnits);
    const mid = workshopCapacity({ keepLevel: 10, landPaidAt: null, deedAssetId: 'x' });
    expect(mid).toBeGreaterThan(deedMinUnits); expect(mid).toBeLessThan(deedMaxUnits);
  });
  it('the Forge day resets at 00:00 UTC', () => {
    expect(utcDayStart(new Date('2026-09-20T23:59:59.999Z')).toISOString()).toBe('2026-09-20T00:00:00.000Z');
    expect(utcDayStart(new Date('2026-09-21T00:00:00.000Z')).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
  it('the recipe is the D-149 lock and the migration literal', () => {
    expect(FORGE_INGOT.shardsPerIngot).toBe(PHASE_E_POLICY.forge.shardsPerIngot);
    expect(FORGE_INGOT.shardsPerIngot).toBe(10_000);
    expect(ITEMS.forge_ingot.acquisition).toEqual({ type: 'craft' });
  });
});

describe('flags (E2-WORKSHOP-CONTRACT §6)', () => {
  const BASE_ENV = { DATABASE_URL: 'postgres://x:y@localhost:5433/example', JWT_SECRET: 'test-secret-test-secret-test-secret!', WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };
  it('both default false; the child cannot be true with the parent off', () => {
    const cfg = loadConfig({ ...BASE_ENV });
    expect([cfg.PHASE_E_BUILDINGS_ENABLED, cfg.FORGE_INGOTS_ENABLED]).toEqual(['false', 'false']);
    expect(() => loadConfig({ ...BASE_ENV, FORGE_INGOTS_ENABLED: 'true' })).toThrow(/FORGE_INGOTS_ENABLED=true requires PHASE_E_BUILDINGS_ENABLED=true/);
    expect(loadConfig({ ...BASE_ENV, PHASE_E_BUILDINGS_ENABLED: 'true', FORGE_INGOTS_ENABLED: 'true' }).FORGE_INGOTS_ENABLED).toBe('true');
    for (const bad of ['TRUE', '1', 'yes']) {
      expect(() => loadConfig({ ...BASE_ENV, PHASE_E_BUILDINGS_ENABLED: bad }), bad).toThrow(/PHASE_E_BUILDINGS_ENABLED/);
    }
  });
  it('the readers agree: ingots need BOTH flags', () => {
    expect(phaseEBuildingsEnabled({})).toBe(false);
    expect(forgeIngotsEnabled({ FORGE_INGOTS_ENABLED: 'true' })).toBe(false);
    expect(forgeIngotsEnabled({ PHASE_E_BUILDINGS_ENABLED: 'true' })).toBe(false);
    expect(forgeIngotsEnabled({ PHASE_E_BUILDINGS_ENABLED: 'true', FORGE_INGOTS_ENABLED: 'true' })).toBe(true);
  });
  it('advertises the same Workshop recipe and requires both flags for new client work', async () => {
    for (const [parent, child, enabled] of [['true', 'true', true], ['true', 'false', false], ['false', 'true', false]] as const) {
      process.env['PHASE_E_BUILDINGS_ENABLED'] = parent;
      process.env['FORGE_INGOTS_ENABLED'] = child;
      try {
        const response = await app.inject({ method: 'GET', url: '/native/capabilities' });
        expect(response.statusCode).toBe(200);
        expect(response.json<Json>().economy.workshop).toEqual({ enabled, recipeVersion: RECIPE });
      } finally {
        process.env['PHASE_E_BUILDINGS_ENABLED'] = 'true';
        process.env['FORGE_INGOTS_ENABLED'] = 'true';
      }
    }
  });
});

describe('dark: FORGE_INGOTS_ENABLED=false', () => {
  it('blocks new work after authentication while empty recovery stays readable and writes nothing', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    process.env['FORGE_INGOTS_ENABLED'] = 'false';
    try {
      expect((await get({}, `/workshop?baseId=${f.baseId}`)).statusCode).toBe(401);
      for (const res of [
        await post(f.cookies, '/workshop/jobs', { idempotencyKey: k(), baseId: f.baseId, ingots: 1, recipeVersion: RECIPE }),
      ]) {
        expect(res.statusCode).toBe(503);
        expect(res.json<Json>().error.code).toBe('PHASE_E_DISABLED');
      }
      await expect(start(f, 1, new Date())).rejects.toMatchObject({ statusCode: 503, code: 'PHASE_E_DISABLED' });
      expect((await get(f.cookies, `/workshop?baseId=${f.baseId}`)).json<Json>()).toMatchObject({ acceptingJobs: false, jobs: [] });
      expect((await get(f.cookies, `/workshop/jobs/by-key/${k()}`)).json<Json>()).toMatchObject({ status: 'unknown', receipt: null });
      expect((await get(f.cookies, `/workshop/jobs/${randomUUID()}/collect/by-key/${k()}`)).json<Json>()).toMatchObject({ status: 'unknown', receipt: null });
      expect((await post(f.cookies, `/workshop/jobs/${randomUUID()}/collect`, { idempotencyKey: k() })).statusCode).toBe(404);
      expect((await get({}, `/workshop/jobs/by-key/${k()}`)).statusCode).toBe(401);
      expect((await post({}, `/workshop/jobs/${randomUUID()}/collect`, { idempotencyKey: k() })).statusCode).toBe(401);
    } finally {
      process.env['FORGE_INGOTS_ENABLED'] = 'true';
    }
    expect(await jobsOf(f.baseId)).toEqual([]);
    expect(await getBaseShardBalance(db, f.baseId)).toBe(SHARDS_PER_INGOT * 5n);
  });

  it('a pause preserves paid collection, ownership checks, receipts and owned inventory without a second credit', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const other = await fixture();
    const startKey = k();
    const started = await start(f, 1, new Date(Date.now() - HOUR), startKey);
    const collectKey = k();
    process.env['FORGE_INGOTS_ENABLED'] = 'false';
    process.env['PHASE_E_BUILDINGS_ENABLED'] = 'false';
    try {
      const view = await get(f.cookies, `/workshop?baseId=${f.baseId}`);
      expect(view.statusCode).toBe(200);
      expect(view.json<Json>()).toMatchObject({ acceptingJobs: false, jobs: [{ jobId: started.jobId, ready: true }] });
      const receipt = await get(f.cookies, `/workshop/jobs/by-key/${startKey}`);
      expect(receipt.statusCode).toBe(200);
      expect(receipt.headers['cache-control']).toBe('private, no-store');
      expect(receipt.json<Json>()).toMatchObject({ status: 'accepted', receipt: { jobId: started.jobId } });
      expect((await get(other.cookies, `/workshop/jobs/by-key/${startKey}`)).json<Json>()).toMatchObject({ status: 'unknown' });
      const foreign = await post(other.cookies, `/workshop/jobs/${started.jobId}/collect`, { idempotencyKey: k() });
      expect(foreign.statusCode).toBe(404);
      expect(foreign.json<Json>().error.code).toBe('JOB_NOT_FOUND');
      const collected = await post(f.cookies, `/workshop/jobs/${started.jobId}/collect`, { idempotencyKey: collectKey });
      expect(collected.statusCode).toBe(201);
      expect(collected.json<Json>()).toMatchObject({ ingotsCredited: 1, duplicate: false });
      const replay = await post(f.cookies, `/workshop/jobs/${started.jobId}/collect`, { idempotencyKey: collectKey });
      expect(replay.statusCode).toBe(200);
      expect(replay.json<Json>()).toMatchObject({ ingotsCredited: 1, duplicate: true });
      expect((await get(f.cookies, `/workshop/jobs/${started.jobId}/collect/by-key/${collectKey}`)).json<Json>())
        .toMatchObject({ status: 'accepted', receipt: { ingotsCredited: 1 } });
      const inventory = await get(f.cookies, `/items?baseId=${f.baseId}`);
      expect(inventory.statusCode).toBe(200);
      expect(inventory.json<Json>().catalog).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'forge_ingot' })]));
      expect(await ingotsOf(f.baseId)).toMatchObject({ qty: 1, via: 'craft' });
      expect(await getBaseShardBalance(db, f.baseId)).toBe(SHARDS_PER_INGOT * 4n);
      await expect(start(f, 1, new Date())).rejects.toMatchObject({ code: 'PHASE_E_DISABLED' });
    } finally {
      process.env['PHASE_E_BUILDINGS_ENABLED'] = 'true';
      process.env['FORGE_INGOTS_ENABLED'] = 'true';
    }
  });
});

describe('wallet-scoped start keys', () => {
  it('racing one key across two bases yields one job and a definitive conflict, never two debits', async () => {
    const first = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 2n });
    const second = await fixture({ wallet: first.wallet, slot: 2, workshopLevel: 1, shards: SHARDS_PER_INGOT * 2n });
    const key = k();
    const now = new Date();
    const results = await Promise.allSettled([start(first, 1, now, key), start(second, 1, now, key)]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_BODY_MISMATCH' });
    expect((await jobsOf(first.baseId)).length + (await jobsOf(second.baseId)).length).toBe(1);
    expect((await getBaseShardBalance(db, first.baseId)) + (await getBaseShardBalance(db, second.baseId))).toBe(SHARDS_PER_INGOT * 3n);
    expect(await getWorkshopStartReceipt(db, first.wallet, key)).toMatchObject({ status: 'accepted' });
  });
});

describe('start (POST /workshop/jobs)', () => {
  it('charges ingots × shardsPerIngot from base_shards to shard_burn NOW, freezes the recipe, and shows in the view', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 10n });
    const key = k();
    const res = await post(f.cookies, '/workshop/jobs', { idempotencyKey: key, baseId: f.baseId, ingots: 3, recipeVersion: RECIPE });
    expect(res.statusCode).toBe(201);
    const body = res.json<Json>();
    expect(body).toMatchObject({ baseId: f.baseId, ingots: 3, shardsCharged: (SHARDS_PER_INGOT * 3n).toString(), recipeVersion: RECIPE, workshopLevel: 1, duplicate: false });
    expect(new Date(body.readyAt).getTime()).toBe(new Date(body.startedAt).getTime() + refineDurationSec(3, 1) * 1000);
    expect(await getBaseShardBalance(db, f.baseId)).toBe(SHARDS_PER_INGOT * 7n);
    const [job] = await jobsOf(f.baseId);
    expect(job).toMatchObject({ id: body.jobId, startedByWallet: f.wallet, workshopLevelAtStart: 1, recipeVersion: RECIPE, ingots: 3, shardsCharged: SHARDS_PER_INGOT * 3n, startIdempotencyKey: key, collectedAt: null });
    const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, job!.debitLedgerTxnId));
    expect(txn).toMatchObject({ type: 'workshop.refine', idempotencyKey: `workshop:${f.baseId}:${f.wallet}:${key}` });
    expect(txn!.metadata).toMatchObject({ wallet: f.wallet, baseId: f.baseId, ingots: 3, shards: (SHARDS_PER_INGOT * 3n).toString(), recipeVersion: RECIPE, workshopLevel: 1 });
    expect(await shapeOf(job!.debitLedgerTxnId)).toEqual([`base_shards@${f.baseId}:${-(SHARDS_PER_INGOT * 3n)}`, `shard_burn:${SHARDS_PER_INGOT * 3n}`].sort());

    const view = (await get(f.cookies, `/workshop?baseId=${f.baseId}`)).json<Json>();
    expect(view).toMatchObject({
      features: { workshop: { version: 1, receipts: 1 } }, level: 1, recipeVersion: RECIPE,
      batch: { size: refineBatchSize(1), max: FORGE_INGOT.batch.max }, secPerIngot: refineSecPerIngotAt(1),
      capacity: FORGE_INGOT.capacity.freeUnits, dailyRefineCap: FORGE_INGOT.refineDailyCapMultiplier * FORGE_INGOT.capacity.freeUnits,
      refinedToday: 3, holding: { held: 0, listed: 0, reserved: 0, inProgress: 3, cap: FORGE_INGOT.holdingCapMultiplier * FORGE_INGOT.capacity.freeUnits },
      jobs: [{ jobId: body.jobId, ingots: 3, shards: (SHARDS_PER_INGOT * 3n).toString(), ready: false, collectedAt: null }],
    });
    expect(typeof view.serverNow).toBe('string');
  });

  it('WORKSHOP_REQUIRED without a standing Workshop — also while one is still being built; a due build counts (lazy)', async () => {
    const bare = await fixture({ shards: SHARDS_PER_INGOT * 5n });
    const res = await post(bare.cookies, '/workshop/jobs', { idempotencyKey: k(), baseId: bare.baseId, ingots: 1, recipeVersion: RECIPE });
    expect(res.statusCode).toBe(409);
    expect(res.json<Json>().error.code).toBe('WORKSHOP_REQUIRED');
    expect(await getBaseShardBalance(db, bare.baseId)).toBe(SHARDS_PER_INGOT * 5n);

    const building = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const now = new Date();
    const [job] = await db.insert(builderJobs).values({
      playerWallet: building.wallet, baseId: building.baseId, kind: 'build', buildingId: building.workshopId!,
      startedAt: now, finishesAt: new Date(now.getTime() + HOUR),
    }).returning();
    await expect(start(building, 1, now)).rejects.toMatchObject({ statusCode: 409, code: 'WORKSHOP_REQUIRED' });
    expect(await jobsOf(building.baseId)).toEqual([]);
    await expect(start(building, 1, new Date(now.getTime() + HOUR))).resolves.toMatchObject({ ingots: 1, duplicate: false });
    expect(job!.completedAt).toBeNull(); // no worker ran; readiness was lazy
  });

  it('RECIPE_VERSION_STALE before any write when the catalogue moved', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const res = await post(f.cookies, '/workshop/jobs', { idempotencyKey: k(), baseId: f.baseId, ingots: 1, recipeVersion: RECIPE + 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json<Json>().error).toMatchObject({ code: 'RECIPE_VERSION_STALE', recipeVersion: RECIPE });
    expect(await jobsOf(f.baseId)).toEqual([]);
    expect(await getBaseShardBalance(db, f.baseId)).toBe(SHARDS_PER_INGOT * 5n);
  });

  it('BATCH_EXCEEDED above the Workshop level\'s batch; the wire caps at batch.max', async () => {
    const f = await fixture({ deed: true, keepLevel: STRUCTURES.keep.maxLevel, workshopLevel: 1, shards: SHARDS_PER_INGOT * 100n });
    const batch = refineBatchSize(1);
    await expect(start(f, batch + 1, new Date())).rejects.toMatchObject({ statusCode: 422, code: 'BATCH_EXCEEDED', details: { batch } });
    expect(await jobsOf(f.baseId)).toEqual([]);
    await expect(start(f, batch, new Date())).resolves.toMatchObject({ ingots: batch });
    const res = await post(f.cookies, '/workshop/jobs', { idempotencyKey: k(), baseId: f.baseId, ingots: FORGE_INGOT.batch.max + 1, recipeVersion: RECIPE });
    expect(res.statusCode).toBe(400);
  });

  it('REFINE_CAP_EXCEEDED at refineDailyCapMultiplier × capacity per UTC day, and the day resets at 00:00 UTC', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 100n });
    const cap = FORGE_INGOT.refineDailyCapMultiplier * FORGE_INGOT.capacity.freeUnits;
    const day = new Date('2026-09-20T10:00:00.000Z');
    await start(f, cap - 1, day);
    await expect(start(f, 2, new Date('2026-09-20T23:59:59.000Z'))).rejects.toMatchObject({
      statusCode: 422, code: 'REFINE_CAP_EXCEEDED', details: { dailyRefineCap: cap, refinedToday: cap - 1 },
    });
    await expect(start(f, 1, new Date('2026-09-20T23:59:59.000Z'))).resolves.toMatchObject({ ingots: 1 });
    await expect(start(f, 1, new Date('2026-09-20T23:59:59.999Z'))).rejects.toMatchObject({ code: 'REFINE_CAP_EXCEEDED' });
    await expect(start(f, 1, new Date('2026-09-21T00:00:00.000Z'))).resolves.toMatchObject({ ingots: 1 });
    expect((await getWorkshopView(db, f.wallet, f.baseId, new Date('2026-09-21T00:00:01.000Z'))).refinedToday).toBe(1);
  });

  it('HOLDING_CAP_EXCEEDED counts held + in-progress against holdingCapMultiplier × capacity', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 100n });
    const cap = FORGE_INGOT.holdingCapMultiplier * FORGE_INGOT.capacity.freeUnits;
    const dailyCap = FORGE_INGOT.refineDailyCapMultiplier * FORGE_INGOT.capacity.freeUnits;
    // Stay under the DAILY cap (3 + 2 starts) so only the holding rule can refuse;
    // a tuning change that breaks that separation must fail here, loudly.
    expect(dailyCap).toBeGreaterThanOrEqual(5);
    expect(cap).toBeGreaterThan(dailyCap);
    const held = cap - 4; // room for four more ingots, held + in progress
    await db.insert(baseItems).values({ baseId: f.baseId, itemId: 'forge_ingot', qty: held, acquiredVia: 'craft' });
    const day = new Date('2026-09-22T10:00:00.000Z');
    const first = await start(f, 3, day);
    await expect(start(f, 2, day)).rejects.toMatchObject({
      statusCode: 422, code: 'HOLDING_CAP_EXCEEDED', details: { holdingCap: cap, held, inProgress: 3 },
    });
    // Collecting moves the in-progress ingots to held: the cap still counts them.
    await collect(f, first.jobId, new Date(first.readyAt));
    await expect(start(f, 2, new Date(first.readyAt))).rejects.toMatchObject({ code: 'HOLDING_CAP_EXCEEDED', details: { held: held + 3, inProgress: 0 } });
    await expect(start(f, 1, new Date(first.readyAt))).resolves.toMatchObject({ ingots: 1 });
    expect((await getWorkshopView(db, f.wallet, f.baseId, new Date(first.readyAt))).holding).toEqual({ held: held + 3, listed: 0, reserved: 0, inProgress: 1, cap });
  });

  it('INSUFFICIENT_SHARDS refuses without a job row or a partial debit', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT - 1n });
    const res = await post(f.cookies, '/workshop/jobs', { idempotencyKey: k(), baseId: f.baseId, ingots: 1, recipeVersion: RECIPE });
    expect(res.statusCode).toBe(422);
    expect(res.json<Json>().error).toMatchObject({ code: 'INSUFFICIENT_SHARDS', costShards: SHARDS_PER_INGOT.toString(), baseShards: (SHARDS_PER_INGOT - 1n).toString() });
    expect(await jobsOf(f.baseId)).toEqual([]);
    expect(await getBaseShardBalance(db, f.baseId)).toBe(SHARDS_PER_INGOT - 1n);
  });

  it('is idempotent on the key: same body → the original job (200, one debit); different body → 409 IDEMPOTENCY_BODY_MISMATCH', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 10n });
    const key = k();
    const body = { idempotencyKey: key, baseId: f.baseId, ingots: 2, recipeVersion: RECIPE };
    const first = (await post(f.cookies, '/workshop/jobs', body)).json<Json>();
    const replay = await post(f.cookies, '/workshop/jobs', body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json<Json>()).toMatchObject({ jobId: first.jobId, readyAt: first.readyAt, duplicate: true });
    const mismatch = await post(f.cookies, '/workshop/jobs', { ...body, ingots: 3 });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json<Json>().error.code).toBe('IDEMPOTENCY_BODY_MISMATCH');
    expect((await jobsOf(f.baseId)).length).toBe(1);
    expect(await getBaseShardBalance(db, f.baseId)).toBe(SHARDS_PER_INGOT * 8n);
  });

  it('refuses another owner\'s base (404 BASE_NOT_OWNED) and a base id the wallet cannot see', async () => {
    const owner = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const other = await fixture();
    const res = await post(other.cookies, '/workshop/jobs', { idempotencyKey: k(), baseId: owner.baseId, ingots: 1, recipeVersion: RECIPE });
    expect(res.statusCode).toBe(404);
    expect(res.json<Json>().error.code).toBe('BASE_NOT_OWNED');
    expect((await get(other.cookies, `/workshop?baseId=${owner.baseId}`)).statusCode).toBe(404);
    expect(await jobsOf(owner.baseId)).toEqual([]);
  });
});

describe('collect (POST /workshop/jobs/:jobId/collect)', () => {
  it('JOB_NOT_READY before readyAt on the SERVER clock; nothing is credited', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const job = (await post(f.cookies, '/workshop/jobs', { idempotencyKey: k(), baseId: f.baseId, ingots: 1, recipeVersion: RECIPE })).json<Json>();
    const res = await post(f.cookies, `/workshop/jobs/${job.jobId}/collect`, { idempotencyKey: k() });
    expect(res.statusCode).toBe(409);
    expect(res.json<Json>().error).toMatchObject({ code: 'JOB_NOT_READY', readyAt: job.readyAt });
    expect(await ingotsOf(f.baseId)).toBeNull();
    await expect(collect(f, job.jobId, new Date(new Date(job.readyAt).getTime() - 1))).rejects.toMatchObject({ code: 'JOB_NOT_READY' });
  });

  it('credits forge_ingot into base_items as acquired_via=craft once ready; SHARDS are never refunded; a second collect returns the existing receipt', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const started = await start(f, 2, new Date(Date.now() - 2 * HOUR)); // ready in the past → the route's real clock accepts it
    const key = k();
    const res = await post(f.cookies, `/workshop/jobs/${started.jobId}/collect`, { idempotencyKey: key });
    expect(res.statusCode).toBe(201);
    expect(res.json<Json>()).toMatchObject({ jobId: started.jobId, baseId: f.baseId, ingotsCredited: 2, held: 2, duplicate: false });
    expect(await ingotsOf(f.baseId)).toEqual({ qty: 2, via: 'craft' });
    const [job] = await jobsOf(f.baseId);
    expect(job).toMatchObject({ collectedByWallet: f.wallet, collectIdempotencyKey: key });
    expect(job!.collectedAt).not.toBeNull();
    // Start is final: the debit stands after collection and no transaction ever credits base_shards for it.
    expect(await getBaseShardBalance(db, f.baseId)).toBe(SHARDS_PER_INGOT * 3n);
    const baseAcct = (await db.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.baseId, f.baseId), eq(accounts.kind, 'base_shards'))))[0]!;
    const credits = await db.select({ delta: ledgerEntries.delta, txnId: ledgerEntries.txnId }).from(ledgerEntries)
      .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, ledgerEntries.txnId))
      .where(and(eq(ledgerEntries.accountId, baseAcct.id), eq(ledgerTransactions.type, 'workshop.refine')));
    expect(credits).toEqual([{ delta: -(SHARDS_PER_INGOT * 2n), txnId: started.receiptId }]);
    expect((await post(f.cookies, `/workshop/jobs/${started.jobId}/cancel`, { idempotencyKey: k() })).statusCode).toBe(404);

    const replay = await post(f.cookies, `/workshop/jobs/${started.jobId}/collect`, { idempotencyKey: key });
    expect(replay.statusCode).toBe(200);
    expect(replay.json<Json>()).toMatchObject({ jobId: started.jobId, ingotsCredited: 2, duplicate: true });
    const again = await post(f.cookies, `/workshop/jobs/${started.jobId}/collect`, { idempotencyKey: k() });
    expect(again.statusCode).toBe(409);
    expect(again.json<Json>().error).toMatchObject({ code: 'JOB_ALREADY_COLLECTED', jobId: started.jobId, ingotsCredited: 2 });
    expect(await ingotsOf(f.baseId)).toEqual({ qty: 2, via: 'craft' }); // credited exactly once
    const view = (await get(f.cookies, `/workshop?baseId=${f.baseId}`)).json<Json>();
    expect(view.holding).toMatchObject({ held: 2, inProgress: 0 });
    expect(view.jobs.find((j: Json) => j.jobId === started.jobId)).toMatchObject({ ready: true, collectedAt: expect.any(String) });
  });

  it('a reused collect key on a different job is a body mismatch; an unknown job is 404', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const at = new Date(Date.now() - 2 * HOUR);
    const a = await start(f, 1, at); const b = await start(f, 1, at);
    const key = k();
    await collect(f, a.jobId, new Date(a.readyAt), key);
    await expect(collect(f, b.jobId, new Date(b.readyAt), key)).rejects.toMatchObject({ statusCode: 409, code: 'IDEMPOTENCY_BODY_MISMATCH' });
    expect(await ingotsOf(f.baseId)).toEqual({ qty: 1, via: 'craft' });
    expect((await post(f.cookies, `/workshop/jobs/${randomUUID()}/collect`, { idempotencyKey: k() })).statusCode).toBe(404);
  });

  it('jobs follow the deed: after a transfer only the NEW owner collects, and the starter\'s receipt still resolves', async () => {
    const seller = await fixture({ deed: true, workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const buyer = await createTestPlayer(db);
    const startKey = k();
    const started = await start(seller, 2, new Date(Date.now() - 2 * HOUR), startKey);
    await transferStableBase(db, seller.baseId, seller.wallet, buyer.wallet, seller.deedAssetId!);

    await expect(collect(seller, started.jobId, new Date())).rejects.toMatchObject({ statusCode: 404, code: 'BASE_NOT_OWNED' });
    const asBuyer = { wallet: buyer.wallet, baseId: seller.baseId };
    const collectKey = k();
    await expect(collect(asBuyer, started.jobId, new Date(), collectKey)).resolves.toMatchObject({ ingotsCredited: 2, held: 2 });
    expect(await ingotsOf(seller.baseId)).toEqual({ qty: 2, via: 'craft' });

    // The starter's receipt: START facts only, nothing about the new owner's collection.
    const receipt = await getWorkshopStartReceipt(db, seller.wallet, startKey);
    expect(receipt).toMatchObject({ status: 'accepted', wallet: seller.wallet, baseId: seller.baseId, jobId: started.jobId, ingots: 2 });
    expect(Object.keys(receipt)).not.toContain('collectedAt');
    expect((await getWorkshopStartReceipt(db, buyer.wallet, startKey)).status).toBe('unknown');
    expect((await getWorkshopCollectReceipt(db, seller.wallet, started.jobId, collectKey)).status).toBe('unknown');
    expect(await getWorkshopCollectReceipt(db, buyer.wallet, started.jobId, collectKey)).toMatchObject({ status: 'accepted', wallet: buyer.wallet, ingotsCredited: 2 });
  });
});

describe('receipts (by-key, E1-CONTRACTS §4.0)', () => {
  it('serves client-verifiable original commands, receipts and allowance views, including paid recovery while paused', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 3n });
    const request = { baseId: f.baseId, idempotencyKey: k(), ingots: 1, recipeVersion: RECIPE };
    const expected = { wallet: f.wallet, request };
    expect(matchWorkshopStartEnvelope((await get(f.cookies, `/workshop/jobs/by-key/${request.idempotencyKey}`)).json(), expected).status).toBe('unknown');
    const response = await post(f.cookies, '/workshop/jobs', request);
    expect(response.statusCode).toBe(201);
    const started = WorkshopStartResultSchema.parse(response.json());
    expect(matchWorkshopStartEnvelope((await get(f.cookies, `/workshop/jobs/by-key/${request.idempotencyKey}`)).json(), expected).receipt?.jobId).toBe(started.jobId);
    const view = WorkshopViewSchema.parse((await get(f.cookies, `/workshop?baseId=${f.baseId}`)).json());
    expect(view.inventory).toMatchObject({ baseId: f.baseId, held: 0, pending: 1 });

    const ready = await start(f, 1, new Date(Date.now() - 2 * HOUR));
    const collection = { wallet: f.wallet, baseId: f.baseId, jobId: ready.jobId, request: { idempotencyKey: k() } };
    const recovery = `/workshop/jobs/${ready.jobId}/collect/by-key/${collection.request.idempotencyKey}`;
    expect(matchWorkshopCollectEnvelope((await get(f.cookies, recovery)).json(), collection).status).toBe('unknown');
    process.env['FORGE_INGOTS_ENABLED'] = 'false';
    try {
      const collected = await post(f.cookies, `/workshop/jobs/${ready.jobId}/collect`, collection.request);
      expect(collected.statusCode).toBe(201);
      expect(WorkshopCollectResultSchema.parse(collected.json()).ingotsCredited).toBe(1);
      expect(matchWorkshopCollectEnvelope((await get(f.cookies, recovery)).json(), collection).receipt?.jobId).toBe(ready.jobId);
      const paused = WorkshopViewSchema.parse((await get(f.cookies, `/workshop?baseId=${f.baseId}`)).json());
      expect(paused.acceptingJobs).toBe(false);
      expect(paused.inventory).toMatchObject({ baseId: f.baseId, held: 1, pending: 1 });
    } finally { process.env['FORGE_INGOTS_ENABLED'] = 'true'; }
  });

  it('start: the job row + its workshop.refine transaction, verified; unknown for any other key, wallet or tampered evidence', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const key = k();
    const started = (await post(f.cookies, '/workshop/jobs', { idempotencyKey: key, baseId: f.baseId, ingots: 2, recipeVersion: RECIPE })).json<Json>();
    const res = await get(f.cookies, `/workshop/jobs/by-key/${key}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json<Json>()).toMatchObject({
      wallet: f.wallet, idempotencyKey: key, status: 'accepted',
      receipt: { version: 1, status: 'accepted', wallet: f.wallet, baseId: f.baseId, jobId: started.jobId, ingots: 2,
        shardsCharged: (SHARDS_PER_INGOT * 2n).toString(), recipeVersion: RECIPE, workshopLevelAtStart: 1,
        startedAt: started.startedAt, readyAt: started.readyAt, receiptId: started.receiptId },
    });
    expect((await get(f.cookies, `/workshop/jobs/by-key/${k()}`)).json<Json>()).toMatchObject({ status: 'unknown', receipt: null });
    const other = await fixture();
    expect((await get(other.cookies, `/workshop/jobs/by-key/${key}`)).json<Json>()).toMatchObject({ status: 'unknown', receipt: null });
    // Evidence must verify: metadata naming another wallet is not this wallet's receipt.
    const [txn] = await db.select().from(ledgerTransactions).where(eq(ledgerTransactions.id, started.receiptId));
    await db.update(ledgerTransactions).set({ metadata: { ...(txn!.metadata as Json), wallet: other.wallet } }).where(eq(ledgerTransactions.id, started.receiptId));
    try {
      expect((await getWorkshopStartReceipt(db, f.wallet, key)).status).toBe('unknown');
    } finally {
      await db.update(ledgerTransactions).set({ metadata: txn!.metadata }).where(eq(ledgerTransactions.id, started.receiptId));
    }
  });

  it('collect: resolves for the collector\'s key only', async () => {
    const f = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const started = await start(f, 1, new Date(Date.now() - 2 * HOUR));
    const key = k();
    expect((await get(f.cookies, `/workshop/jobs/${started.jobId}/collect/by-key/${key}`)).json<Json>()).toMatchObject({ status: 'unknown', receipt: null });
    await post(f.cookies, `/workshop/jobs/${started.jobId}/collect`, { idempotencyKey: key });
    const res = await get(f.cookies, `/workshop/jobs/${started.jobId}/collect/by-key/${key}`);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.json<Json>()).toMatchObject({ wallet: f.wallet, idempotencyKey: key, status: 'accepted',
      receipt: { version: 1, status: 'accepted', wallet: f.wallet, baseId: f.baseId, jobId: started.jobId, ingotsCredited: 1, receiptId: started.jobId } });
  });
});

describe('exposure (E2-WORKSHOP-CONTRACT §5)', () => {
  it('SHARDS burned at start are gone from raid loot, and ingots in progress are not loot', async () => {
    // Two identical deedless defenders: A funds 5 ingots' worth and refines 3;
    // B funds only what A has left. A raid on A must reserve exactly what a raid
    // on B reserves — the burned SHARDS and the in-progress ingots are invisible.
    const attacker = await fixture();
    const a = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 5n });
    const b = await fixture({ workshopLevel: 1, shards: SHARDS_PER_INGOT * 2n });
    const now = new Date();
    await start(a, 3, now);
    expect(await getBaseShardBalance(db, a.baseId)).toBe(SHARDS_PER_INGOT * 2n);
    const reserve = async (defender: { wallet: string; baseId: string }) => {
      const [raid] = await db.insert(raids).values({
        idempotencyKey: k(), attackerWallet: attacker.wallet, attackerBaseId: attacker.baseId,
        defenderWallet: defender.wallet, defenderBaseId: defender.baseId,
        seed: 1n, snapshot: {}, armySnapshot: {}, simVersion: 9, ordersDeadlineAt: new Date(now.getTime() + 120_000),
      }).returning();
      await db.insert(baseRaidLocks).values({ baseId: defender.baseId, raidId: raid!.id, expiresAt: new Date(now.getTime() + 180_000) });
      return db.transaction((tx) => reserveDeedRaidLoot(tx, { raidId: raid!.id, attackerBaseId: attacker.baseId, defenderBaseId: defender.baseId, now }));
    };
    const [onA, onB] = [await reserve(a), await reserve(b)];
    expect(onA.balancePool).toBe(onB.balancePool);
    expect(onA.maximum).toBe(onB.maximum);
    expect(onA.balancePool).toBeLessThanOrEqual(SHARDS_PER_INGOT * 2n);
  });

  it('the SOL item market refuses a forge_ingot listing at any price (no SHARDS → SOL lane, holding cap intact)', async () => {
    // WHY (security review 2026-09-20, Workshop finding 1): a listing decrements
    // base_items, so listing ingots would drain `held` past the holding cap and
    // pay the seller SOL for 10,000 SHARDS — the first SHARDS → SOL conversion,
    // contradicting the contract (ingots leave only via a Forge commitment or the
    // KEEP market) and D-150. Refused at LIST, unconditionally, like dropOnly.
    const f = await fixture({ deed: true, workshopLevel: 1 });
    await db.insert(baseItems).values({ baseId: f.baseId, itemId: 'forge_ingot', qty: 2, acquiredVia: 'craft' });
    const { listItem } = await import('../src/game/itemMarket');
    const { MARKETPLACE } = await import('@shardkeep/shared');
    await expect(listItem(db, f.wallet, 'forge_ingot', BigInt(MARKETPLACE.itemMarket.maxPriceLamports), k(), undefined,
      { baseId: f.baseId, assertAuthority: async () => {} }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ITEM_NOT_LISTABLE' });
    expect((await ingotsOf(f.baseId))?.qty).toBe(2); // nothing left the base
  });

  it('hides forge_ingot from the item catalogue while the Workshop is dark, shows it when on', async () => {
    const f = await fixture({ workshopLevel: 1 });
    const ids = async () => (await get(f.cookies, `/items?baseId=${f.baseId}`)).json<{ catalog: Array<{ id: string }> }>().catalog.map((it) => it.id);
    expect(await ids()).toContain('forge_ingot');
    process.env['FORGE_INGOTS_ENABLED'] = 'false';
    try { expect(await ids()).not.toContain('forge_ingot'); }
    finally { process.env['FORGE_INGOTS_ENABLED'] = 'true'; }
  });

  it('the craft gate still refuses buying a forge_ingot at any price', async () => {
    const f = await fixture({ workshopLevel: 1 });
    const res = await post(f.cookies, '/items/buy', { itemId: 'forge_ingot', idempotencyKey: k(), baseId: f.baseId });
    expect(res.statusCode).toBe(422);
    expect(res.json<Json>().error.message).toMatch(/crafted, not sold/);
    expect(await ingotsOf(f.baseId)).toBeNull();
  });
});

describe('packages/sim is untouched by this slice (E2-WORKSHOP-CONTRACT §7)', () => {
  it('ingots are not a combat object: the simulator never mentions them', () => {
    const root = fileURLToPath(new URL('../../../packages/sim/src', import.meta.url));
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p); else if (p.endsWith('.ts')) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      expect(src, file).not.toMatch(/ingot/i);
      expect(src, file).not.toMatch(/workshop_jobs|FORGE_INGOT|workshopJobs/);
    }
  });
});

// K-154: capacity belongs to an allowance, not to whichever free base is open.
describe('Workshop v1 scoped allowance (D-153.13)', () => {
  const day = new Date('2026-09-20T12:00:00.000Z');
  const freeDaily = FORGE_INGOT.refineDailyCapMultiplier * FORGE_INGOT.capacity.freeUnits;
  const freeHolding = FORGE_INGOT.holdingCapMultiplier * FORGE_INGOT.capacity.freeUnits;
  const funded = { workshopLevel: 1, shards: SHARDS_PER_INGOT * 100n };
  const view = (f: { wallet: string; baseId: string }, at = day) => getWorkshopView(db, f.wallet, f.baseId, at);

  it('two free bases racing for the final daily unit get one job and one debit', async () => {
    const a = await fixture(funded);
    const b = await fixture({ ...funded, wallet: a.wallet, slot: 2 });
    await start(a, freeDaily - 1, day);
    const before = await getBaseShardBalance(db, a.baseId) + await getBaseShardBalance(db, b.baseId);
    const results = await Promise.allSettled([start(a, 1, day), start(b, 1, day)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)
      .toMatchObject({ code: 'REFINE_CAP_EXCEEDED' });
    expect(await getBaseShardBalance(db, a.baseId) + await getBaseShardBalance(db, b.baseId)).toBe(before - SHARDS_PER_INGOT);
    const allowance = (await view(b)).allowance;
    expect(allowance).toMatchObject({ version: 1, scope: 'free_wallet', capacityUnits: FORGE_INGOT.capacity.freeUnits,
      day: '2026-09-20T00:00:00.000Z', resetsAt: '2026-09-21T00:00:00.000Z', daily: { cap: freeDaily, used: freeDaily, remaining: 0 } });
    expect((await view(a)).allowance).toEqual(allowance);
  });

  it('inactive, non-rostered free stock and ready-but-uncollected jobs still consume holding', async () => {
    const a = await fixture(funded);
    const hidden = await fixture({ ...funded, wallet: a.wallet, slot: 2 });
    await start(hidden, 1, new Date(day.getTime() - HOUR));
    await db.insert(baseItems).values({ baseId: hidden.baseId, itemId: 'forge_ingot', qty: freeHolding - 1, acquiredVia: 'craft' });
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, hidden.baseId));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, hidden.baseId));
    expect(await view(a)).toMatchObject({ inventory: { baseId: a.baseId, held: 0, pending: 0 },
      allowance: { holding: { held: freeHolding - 1, pending: 1, remaining: 0, listed: 0, reserved: 0 } } });
    await expect(start(a, 1, day)).rejects.toMatchObject({ code: 'HOLDING_CAP_EXCEEDED' });
    // Both paid markers use the SAME deed predicate, so either excludes this
    // other base from the wallet's free stock, regardless of its roster state.
    await db.update(bases).set({ landPaidAt: day }).where(eq(bases.id, hidden.baseId));
    expect((await view(a)).allowance.holding.remaining).toBe(freeHolding);
    await db.update(bases).set({ landPaidAt: null, deedAssetId: k() }).where(eq(bases.id, hidden.baseId));
    expect((await view(a)).allowance.holding.remaining).toBe(freeHolding);
  });

  it('collection racing a start conserves held plus pending, so it never opens a phantom slot', async () => {
    const a = await fixture(funded);
    const b = await fixture({ ...funded, wallet: a.wallet, slot: 2 });
    const job = await start(a, 1, new Date(day.getTime() - HOUR));
    await db.insert(baseItems).values({ baseId: b.baseId, itemId: 'forge_ingot', qty: freeHolding - 1, acquiredVia: 'craft' });
    const [collected, started] = await Promise.allSettled([collect(a, job.jobId, day), start(b, 1, day)]);
    expect(collected.status).toBe('fulfilled');
    expect(started.status).toBe('rejected');
    expect((started as PromiseRejectedResult).reason).toMatchObject({ code: 'HOLDING_CAP_EXCEEDED' });
    expect((await view(b)).allowance.holding).toMatchObject({ held: freeHolding, pending: 0, remaining: 0 });
  });

  it('free starts stay charged to the original wallet after upgrade and sale; every start follows the deed day', async () => {
    const a = await fixture(funded);
    const b = await fixture({ ...funded, wallet: a.wallet, slot: 2 });
    const key = k();
    const original = await start(a, freeDaily, day, key);
    const deed = `allowance-deed-${k()}`;
    await db.update(bases).set({ landPaidAt: day, deedAssetId: deed, deedMintAssetId: deed }).where(eq(bases.id, a.baseId));
    const deedDaily = FORGE_INGOT.refineDailyCapMultiplier * FORGE_INGOT.capacity.deedMinUnits;
    expect((await view(a)).allowance).toMatchObject({ scope: 'deed_base', daily: { used: freeDaily } });
    expect(await start(a, freeDaily, day, key)).toMatchObject({ ...original, duplicate: true, capacityScopeAtStart: 'free_wallet' });
    await start(a, deedDaily - freeDaily, day);
    const buyer = await createTestPlayer(db);
    await transferStableBase(db, a.baseId, a.wallet, buyer.wallet, deed);
    expect((await view({ wallet: buyer.wallet, baseId: a.baseId })).allowance.daily).toMatchObject({ used: deedDaily, remaining: 0 });
    await expect(start(b, 1, day)).rejects.toMatchObject({ code: 'REFINE_CAP_EXCEEDED' });
    expect((await view(b)).allowance.daily.used).toBe(freeDaily); // deed-started jobs do not consume the free allowance
    expect(await getWorkshopStartReceipt(db, a.wallet, key)).toMatchObject({ status: 'accepted', capacityScopeAtStart: 'free_wallet' });
  });

  it('a Keep upgrade raises the deed cap without resetting daily use or completing any builder job', async () => {
    const f = await fixture({ ...funded, deed: true });
    await start(f, 2, day);
    const [due] = await db.insert(builderJobs).values({ playerWallet: f.wallet, baseId: f.baseId,
      kind: 'upgrade', buildingId: f.workshopId!, startedAt: new Date(day.getTime() - HOUR), finishesAt: day }).returning();
    await db.update(bases).set({ keepLevel: STRUCTURES.keep.maxLevel }).where(eq(bases.id, f.baseId));
    expect((await view(f)).allowance).toMatchObject({ capacityUnits: FORGE_INGOT.capacity.deedMaxUnits,
      daily: { cap: FORGE_INGOT.refineDailyCapMultiplier * FORGE_INGOT.capacity.deedMaxUnits, used: 2 } });
    await start(f, 1, day);
    expect((await db.select().from(builderJobs).where(eq(builderJobs.id, due!.id)))[0]!.completedAt).toBeNull();
    expect((await view(f)).level).toBe(1);
  });

  it('UTC ranges exclude the next day, including its exact midnight row', async () => {
    const f = await fixture(funded);
    await start(f, 1, new Date('2026-09-21T00:00:00.000Z'));
    expect((await view(f, new Date('2026-09-20T23:59:59.999Z'))).allowance.daily.used).toBe(0);
    expect((await view(f, new Date('2026-09-21T00:00:00.000Z'))).allowance.daily.used).toBe(1);
  });

  it('a start waiting on the wallet lock across midnight uses its POST-LOCK day and response clock', async () => {
    const f = await fixture(funded);
    const before = new Date('2026-09-20T23:59:59.999Z');
    const after = new Date('2026-09-21T00:00:00.000Z');
    await start(f, freeDaily, before);
    let unlock!: () => void;
    let signalLocked!: () => void;
    const locked = new Promise<void>((r) => { signalLocked = r; });
    const release = new Promise<void>((r) => { unlock = r; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(players).where(eq(players.wallet, f.wallet)).for('update');
      signalLocked(); await release;
    });
    await locked;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(before);
    const waiting = startRefine(db, f.wallet, f.baseId, 1, RECIPE, k(), undefined, context(f.baseId));
    try {
      let blocked = false;
      for (let tries = 0; tries < 100; tries++) {
        const [row] = await conn.sql<{ waiting: boolean }[]>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'
          AND query LIKE '%"players"%' AND pid <> pg_backend_pid()
        ) AS waiting`;
        if (row?.waiting) { blocked = true; break; }
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(blocked, 'the POST must really be waiting for the player row').toBe(true);
      vi.setSystemTime(after);
      unlock(); await holder;
      const admitted = await waiting;
      expect(admitted).toMatchObject({ startedAt: after.toISOString(), serverNow: after.toISOString() });
      expect((await view(f, after)).allowance.daily.used).toBe(1);
    } finally {
      unlock(); await holder; await waiting.catch(() => {}); vi.useRealTimers();
    }
  });

  it('legacy NULL scope consumes both original-wallet and current-deed daily allowances and remains collectable', async () => {
    const f = await fixture({ ...funded, deed: true });
    const free = await fixture({ ...funded, wallet: f.wallet, slot: 2 });
    const key = k();
    const job = await db.transaction(async (tx) => {
      const debit = await spendBaseShards(tx, f.baseId, SHARDS_PER_INGOT, 'workshop.refine', `workshop:${f.baseId}:${f.wallet}:${key}`,
        { wallet: f.wallet, ingots: 1, shards: SHARDS_PER_INGOT.toString(), recipeVersion: RECIPE, workshopLevel: 1 });
      return (await tx.insert(workshopJobs).values({ baseId: f.baseId, startedByWallet: f.wallet, workshopLevelAtStart: 1,
        recipeVersion: RECIPE, ingots: 1, shardsCharged: SHARDS_PER_INGOT, startedAt: day, readyAt: day,
        debitLedgerTxnId: debit.transaction.id, startIdempotencyKey: key }).returning())[0]!;
    });
    expect(job.capacityScopeAtStart).toBeNull();
    expect((await view(f)).allowance.daily.used).toBe(1);
    expect((await view(free)).allowance.daily.used).toBe(1);
    expect(await getWorkshopStartReceipt(db, f.wallet, key)).toMatchObject({ status: 'accepted', capacityScopeAtStart: null });
    await expect(collect(f, job.id, day)).resolves.toMatchObject({ ingotsCredited: 1 });
    expect((await view(free)).allowance.daily.used).toBe(1);
  });

  it('imported stock over the cap blocks new jobs but cannot strand a paid collection', async () => {
    const f = await fixture(funded);
    const job = await start(f, 1, day);
    await db.insert(baseItems).values({ baseId: f.baseId, itemId: 'forge_ingot', qty: freeHolding + 1, acquiredVia: 'grant' });
    await expect(start(f, 1, day)).rejects.toMatchObject({ code: 'HOLDING_CAP_EXCEEDED' });
    await expect(collect(f, job.jobId, new Date(job.readyAt))).resolves.toMatchObject({ held: freeHolding + 2 });
    expect((await view(f)).allowance.holding.remaining).toBe(0);
  });

  it('SQL cannot rewrite frozen classification, job identity, recipe, timestamps or a collection receipt', async () => {
    const f = await fixture(funded);
    const original = await start(f, 1, day);
    const [job] = await jobsOf(f.baseId);
    const updates: Array<Partial<typeof workshopJobs.$inferInsert>> = [
      { capacityScopeAtStart: 'deed_base' }, { capacityScopeAtStart: null }, { id: k() }, { baseId: k() },
      { startedByWallet: 'another' }, { workshopLevelAtStart: 2 }, { recipeVersion: RECIPE + 1 },
      { ingots: 2, shardsCharged: SHARDS_PER_INGOT * 2n }, { startedAt: new Date(0) }, { readyAt: new Date(0) },
      { debitLedgerTxnId: k() }, { startIdempotencyKey: k() },
    ];
    for (const mutation of updates) {
      await expect(db.update(workshopJobs).set(mutation).where(eq(workshopJobs.id, original.jobId)))
        .rejects.toMatchObject({ cause: { message: 'Workshop start facts are immutable' } });
    }
    await expect(db.delete(workshopJobs).where(eq(workshopJobs.id, original.jobId)))
      .rejects.toMatchObject({ cause: { message: 'Workshop start facts are immutable' } });
    expect((await jobsOf(f.baseId))[0]).toEqual(job);
    await collect(f, original.jobId, new Date(original.readyAt));
    await expect(db.update(workshopJobs).set({ collectedAt: null, collectedByWallet: null, collectIdempotencyKey: null })
      .where(eq(workshopJobs.id, original.jobId))).rejects.toMatchObject({ cause: { message: 'Workshop collection facts are immutable' } });
  });
});
