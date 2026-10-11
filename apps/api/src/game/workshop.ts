/**
 * Workshop refining — Forge Ingots (docs/phase-e/E2-WORKSHOP-CONTRACT.md; D-149 §5).
 *
 *  - 10,000 SHARDS → 1 Forge Ingot, deterministic, no failure, no SOL (LOCKED).
 *  - SHARDS are SPENT AT START (`base_shards −s / shard_burn +s`, type
 *    `workshop.refine`, the spendBaseShards shape) and the debit id is stored on
 *    the job row. Start is FINAL: no cancel, no refund (§5 — a cancellable job
 *    would be a free raid shelter). Refining is a D-150 conversion: no tax.
 *  - No worker: readiness is `ready_at <= now` on read and `collect` is the
 *    only completion path (the builder-job lazy-completion rule).
 *  - Base-scoped: the job and the collected ingots (`base_items`, acquired_via
 *    'craft') follow the deed; collect needs the CURRENT owner's authority.
 *  - Caps: batch ≤ min(max, base + level × perLevel); ≤ refineDailyCapMultiplier
 *    × capacity started per UTC day; held + uncollected ≤ holdingCapMultiplier
 *    × capacity. Free bases share one wallet allowance; deed bases have their own. Every number is read from FORGE_INGOT.
 *  - Pausing the flag blocks starts; paid jobs and receipts remain recoverable.
 */
import { FORGE_INGOT, MATERIAL_ITEMS, STRUCTURES } from '@shardkeep/shared';
import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { forgeIngotsEnabled } from '../config';
import type { Db, DbOrTx, DbTx } from '../db/client';
import {
  accounts, baseItems, bases, builderJobs, buildings, ledgerEntries, ledgerTransactions, players, workshopJobs,
} from '../db/schema';
import { InsufficientFundsError } from '../ledger/ledger';
import { HttpError } from '../lib/errors';
import { getBaseShardBalance, spendBaseShards } from './baseEconomy';
import {
  lockStablePrerequisiteBase, requireActiveStablePrerequisiteBase, requireStableBaseMutationContext,
  type StableBaseMutationContext,
} from './stableBasePrerequisites';

export const WORKSHOP_FEATURE = { version: 1, receipts: 1, allowance: 1 } as const;
export const WORKSHOP_REFINE_TXN_TYPE = 'workshop.refine';
const INGOT_ITEM_ID: keyof typeof MATERIAL_ITEMS = 'forge_ingot';
const BPS = 10_000;

// ---------------------------------------------------------------------------
// Pure rules (exported so the tests compute expectations from the same source)
// ---------------------------------------------------------------------------

/** Ingots one job may refine at a Workshop level (E2-WORKSHOP-CONTRACT §0). */
export function refineBatchSize(workshopLevel: number): number {
  const { baseSize, perWorkshopLevel, max } = FORGE_INGOT.batch;
  return Math.min(max, baseSize + workshopLevel * perWorkshopLevel);
}

/** Effective seconds per ingot at a Workshop level: −refineSpeedupBpsPerLevel
 * per level above L1, floored to whole seconds. */
export function refineSecPerIngotAt(workshopLevel: number): number {
  const factorBps = BPS - FORGE_INGOT.refineSpeedupBpsPerLevel * (Math.max(workshopLevel, 1) - 1);
  return Math.floor(FORGE_INGOT.refineSecPerIngot * factorBps / BPS);
}

export function refineDurationSec(ingots: number, workshopLevel: number): number {
  return ingots * refineSecPerIngotAt(workshopLevel);
}

/** The Forge day: caps reset at 00:00 UTC (§5). */
export function utcDayStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Workshop-only v1 ladder (D-153.13), not the future E4 mining model. */
export type WorkshopCapacityBase = Pick<typeof bases.$inferSelect, 'keepLevel' | 'landPaidAt' | 'deedAssetId'>;
function hasWorkshopDeed(base: WorkshopCapacityBase): boolean {
  return base.deedAssetId !== null || base.landPaidAt !== null;
}
export function workshopCapacity(base: WorkshopCapacityBase): number {
  const { freeUnits, deedMinUnits, deedMaxUnits } = FORGE_INGOT.capacity;
  if (!hasWorkshopDeed(base)) return freeUnits;
  const span = Math.max(STRUCTURES.keep.maxLevel - 1, 1);
  const progressBps = Math.floor(BPS * Math.min(Math.max(base.keepLevel, 1) - 1, span) / span);
  return deedMinUnits + Math.floor((deedMaxUnits - deedMinUnits) * progressBps / BPS);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function assertForgeIngotsOn(): void {
  if (!forgeIngotsEnabled()) throw new HttpError(503, 'Workshop refining is not enabled', 'PHASE_E_DISABLED');
}

/** The standing Workshop: a `buildings` row whose placement job is finished
 * (lazy — a due job counts). `level` is the row's level, so an in-progress
 * upgrade keeps the previous level until it completes (§1). */
async function standingWorkshop(db: DbOrTx, baseId: string, now: Date): Promise<{ id: string; level: number } | null> {
  const rows = await db.select({ id: buildings.id, level: buildings.level }).from(buildings)
    .where(and(eq(buildings.baseId, baseId), eq(buildings.type, 'workshop')))
    .orderBy(desc(buildings.level));
  for (const row of rows) {
    const [pending] = await db.select({ id: builderJobs.id }).from(builderJobs).where(and(
      eq(builderJobs.buildingId, row.id), eq(builderJobs.kind, 'build'),
      isNull(builderJobs.completedAt), gt(builderJobs.finishesAt, now),
    )).limit(1);
    if (!pending) return row;
  }
  return null;
}

const sumIngots = sql<number>`coalesce(sum(${workshopJobs.ingots}), 0)`.mapWith(Number);

async function refinedToday(db: DbOrTx, baseId: string, now: Date): Promise<number> {
  const [row] = await db.select({ ingots: sumIngots }).from(workshopJobs)
    .where(and(eq(workshopJobs.baseId, baseId), gte(workshopJobs.startedAt, utcDayStart(now)),
      lt(workshopJobs.startedAt, utcDayEnd(now))));
  return row?.ingots ?? 0;
}

async function inProgress(db: DbOrTx, baseId: string): Promise<number> {
  const [row] = await db.select({ ingots: sumIngots }).from(workshopJobs)
    .where(and(eq(workshopJobs.baseId, baseId), isNull(workshopJobs.collectedAt)));
  return row?.ingots ?? 0;
}

async function heldIngots(db: DbOrTx, baseId: string): Promise<number> {
  const [row] = await db.select({ qty: baseItems.qty }).from(baseItems)
    .where(and(eq(baseItems.baseId, baseId), eq(baseItems.itemId, INGOT_ITEM_ID)));
  return row?.qty ?? 0;
}

/** Closed-open UTC window: future-day rows never consume today's allowance. */
function utcDayEnd(now: Date): Date {
  const end = utcDayStart(now);
  end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

async function workshopAllowance(db: DbOrTx, wallet: string, base: WorkshopCapacityBase & { id: string }, now: Date) {
  const scope: 'deed_base' | 'free_wallet' = hasWorkshopDeed(base) ? 'deed_base' : 'free_wallet';
  const capacityUnits = workshopCapacity(base);
  // The player's lock serializes admission, collection, activation and transfer.
  // Do not lock every owned base: doing so reverses the shared transfer order.
  const ownedFreeBases = db.select({ id: bases.id }).from(bases).where(and(
    eq(bases.ownerWallet, wallet), isNull(bases.deedAssetId), isNull(bases.landPaidAt),
  ));
  const [daily] = await db.select({ ingots: sumIngots }).from(workshopJobs).where(and(
    scope === 'deed_base' ? eq(workshopJobs.baseId, base.id) : and(
      eq(workshopJobs.startedByWallet, wallet),
      or(eq(workshopJobs.capacityScopeAtStart, 'free_wallet'), isNull(workshopJobs.capacityScopeAtStart)),
    ),
    gte(workshopJobs.startedAt, utcDayStart(now)), lt(workshopJobs.startedAt, utcDayEnd(now)),
  ));
  // Ownership/status changes cannot erase original daily use. Holding follows
  // current ownership across ALL free bases, including inactive/non-rostered ones.
  const [stock] = await db.select({ qty: sql<number>`coalesce(sum(${baseItems.qty}), 0)`.mapWith(Number) })
    .from(baseItems).where(and(eq(baseItems.itemId, INGOT_ITEM_ID), scope === 'deed_base'
      ? eq(baseItems.baseId, base.id) : inArray(baseItems.baseId, ownedFreeBases)));
  const [pending] = await db.select({ ingots: sumIngots }).from(workshopJobs).where(and(
    isNull(workshopJobs.collectedAt), scope === 'deed_base'
      ? eq(workshopJobs.baseId, base.id) : inArray(workshopJobs.baseId, ownedFreeBases),
  ));
  const [reservedStock] = await db.execute<{ qty: number }>(sql`select coalesce(sum(r.qty),0)::integer qty from (
      select r.base_id,r.qty from mining_ingot_reservations r
      where not exists(select 1 from mining_ingot_releases x where x.reservation_id=r.id)
      and not exists(select 1 from mining_ingot_dispositions x where x.reservation_id=r.id)
      union all select r.base_id,l.quantity qty from mining_contribution_receipts r join mining_contribution_lines l on l.receipt_id=r.id
      where l.resource_id='forge_ingot' and not exists(select 1 from mining_contribution_terminals t where t.receipt_id=r.id)
    ) r where ${scope === 'deed_base' ? sql`r.base_id=${base.id}` : sql`r.base_id in (${ownedFreeBases})`}`);
  const dailyCap = FORGE_INGOT.refineDailyCapMultiplier * capacityUnits;
  const holdingCap = FORGE_INGOT.holdingCapMultiplier * capacityUnits;
  const used = daily?.ingots ?? 0;
  const held = stock?.qty ?? 0;
  const inProgress = pending?.ingots ?? 0;
  const reserved = reservedStock?.qty ?? 0;
  return {
    version: 1, scope, day: utcDayStart(now).toISOString(), resetsAt: utcDayEnd(now).toISOString(), capacityUnits,
    daily: { cap: dailyCap, used, remaining: Math.max(0, dailyCap - used) },
    holding: { held, pending: inProgress, listed: 0, reserved, cap: holdingCap,
      remaining: Math.max(0, holdingCap - held - inProgress - reserved) },
  };
}

type JobRow = typeof workshopJobs.$inferSelect;
const jobView = (job: JobRow, now: Date) => ({
  jobId: job.id, ingots: job.ingots, shards: job.shardsCharged.toString(),
  recipeVersion: job.recipeVersion, workshopLevel: job.workshopLevelAtStart,
  capacityScopeAtStart: job.capacityScopeAtStart,
  startedAt: job.startedAt.toISOString(), readyAt: job.readyAt.toISOString(),
  ready: job.readyAt.getTime() <= now.getTime(),
  collectedAt: job.collectedAt?.toISOString() ?? null,
});

export async function getWorkshopView(db: Db, wallet: string, baseId: string, now = new Date()) {
  const base = await requireActiveStablePrerequisiteBase(db, wallet, baseId);
  const workshop = await standingWorkshop(db, baseId, now);
  const level = workshop?.level ?? 0;
  const capacity = workshopCapacity(base);
  const dayStart = utcDayStart(now);
  const [refined, held, pending, jobs, allowance] = await Promise.all([
    refinedToday(db, baseId, now), heldIngots(db, baseId), inProgress(db, baseId),
    db.select().from(workshopJobs).where(and(
      eq(workshopJobs.baseId, baseId),
      or(isNull(workshopJobs.collectedAt), gte(workshopJobs.collectedAt, dayStart)),
    )).orderBy(asc(workshopJobs.startedAt)),
    workshopAllowance(db, wallet, base, now),
  ]);
  // KEEP-market listing remains unimplemented; pending mining custody counts.
  const listed = 0;
  const [reservedRow] = await db.execute<{ qty: number }>(sql`select coalesce(sum(qty),0)::integer qty from (
      select r.qty from mining_ingot_reservations r where r.base_id=${baseId}
      and not exists(select 1 from mining_ingot_releases x where x.reservation_id=r.id)
      and not exists(select 1 from mining_ingot_dispositions x where x.reservation_id=r.id)
      union all select l.quantity qty from mining_contribution_receipts r join mining_contribution_lines l on l.receipt_id=r.id
      where r.base_id=${baseId} and l.resource_id='forge_ingot' and not exists(select 1 from mining_contribution_terminals t where t.receipt_id=r.id)
    ) pending`);
  const reserved = reservedRow?.qty ?? 0;
  return {
    features: { workshop: WORKSHOP_FEATURE },
    acceptingJobs: forgeIngotsEnabled(),
    level,
    recipeVersion: FORGE_INGOT.recipeVersion,
    shardsPerIngot: FORGE_INGOT.shardsPerIngot,
    batch: { size: level > 0 ? refineBatchSize(level) : 0, max: FORGE_INGOT.batch.max },
    secPerIngot: level > 0 ? refineSecPerIngotAt(level) : null,
    // Compatibility fields describe this selected base, not wallet admission.
    // Clients use the versioned allowance for start limits and inventory for stock.
    inventory: { baseId, held, pending },
    allowance,
    dailyRefineCap: FORGE_INGOT.refineDailyCapMultiplier * capacity,
    refinedToday: refined,
    holding: { held, listed, reserved, inProgress: pending, cap: FORGE_INGOT.holdingCapMultiplier * capacity },
    capacity,
    jobs: jobs.map((job) => jobView(job, now)),
    serverNow: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function lockOwnedBase(tx: DbTx, wallet: string, baseId: string, stableContext: StableBaseMutationContext | undefined) {
  const [player] = await tx.select({ wallet: players.wallet }).from(players)
    .where(eq(players.wallet, wallet)).for('update');
  if (!player) throw new HttpError(404, 'player not found');
  const context = requireStableBaseMutationContext(stableContext);
  if (context.baseId !== baseId) {
    throw new HttpError(409, 'base authority context does not match target', 'BASE_NOT_OWNED');
  }
  return lockStablePrerequisiteBase(tx, wallet, context);
}

const startResult = (job: JobRow, duplicate: boolean) => ({
  jobId: job.id, baseId: job.baseId, ingots: job.ingots, shardsCharged: job.shardsCharged.toString(),
  recipeVersion: job.recipeVersion, workshopLevel: job.workshopLevelAtStart,
  capacityScopeAtStart: job.capacityScopeAtStart,
  startedAt: job.startedAt.toISOString(), readyAt: job.readyAt.toISOString(),
  receiptId: job.debitLedgerTxnId, duplicate,
});

/**
 * Start a refining job: charge `ingots × shardsPerIngot` SHARDS from the base
 * NOW and freeze the recipe. Idempotent on (wallet, idempotencyKey); a reused
 * key with a different body answers 409 IDEMPOTENCY_BODY_MISMATCH.
 */
export async function startRefine(
  db: Db, wallet: string, baseId: string, ingots: number, recipeVersion: number,
  idempotencyKey: string, at?: Date, stableContext?: StableBaseMutationContext,
) {
  assertForgeIngotsOn();
  if (!Number.isSafeInteger(ingots) || ingots <= 0) throw new HttpError(422, 'refine a positive whole number of ingots');
  if (recipeVersion !== FORGE_INGOT.recipeVersion) {
    throw new HttpError(409, 'the refining recipe changed; reload the Workshop', 'RECIPE_VERSION_STALE',
      { recipeVersion: FORGE_INGOT.recipeVersion });
  }
  const shards = BigInt(ingots) * BigInt(FORGE_INGOT.shardsPerIngot);
  return db.transaction(async (tx) => {
    const base = await lockOwnedBase(tx, wallet, baseId, stableContext);
    // A request waiting across UTC midnight belongs to the admitted day.
    const now = at ?? new Date();
    const [existing] = await tx.select().from(workshopJobs).where(and(
      eq(workshopJobs.startedByWallet, wallet), eq(workshopJobs.startIdempotencyKey, idempotencyKey),
    ));
    if (existing) {
      if (existing.baseId !== baseId || existing.ingots !== ingots || existing.recipeVersion !== recipeVersion) {
        throw new HttpError(409, 'idempotency key was already used with a different refining request', 'IDEMPOTENCY_BODY_MISMATCH');
      }
      return { ...startResult(existing, true), serverNow: now.toISOString() };
    }
    const workshop = await standingWorkshop(tx, baseId, now);
    if (!workshop) throw new HttpError(409, 'a standing Workshop is required to refine ingots', 'WORKSHOP_REQUIRED');
    const batch = refineBatchSize(workshop.level);
    if (ingots > batch) {
      throw new HttpError(422, `a Workshop L${workshop.level} refines at most ${batch} ingots per job`, 'BATCH_EXCEEDED', { batch });
    }
    const allowance = await workshopAllowance(tx, wallet, base, now);
    if (ingots > allowance.daily.remaining) {
      throw new HttpError(422, `this allowance permits at most ${allowance.daily.cap} ingots per UTC day`, 'REFINE_CAP_EXCEEDED',
        { dailyRefineCap: allowance.daily.cap, refinedToday: allowance.daily.used, allowance });
    }
    if (ingots > allowance.holding.remaining) {
      throw new HttpError(422, `this allowance may hold at most ${allowance.holding.cap} ingots, counting uncollected jobs`, 'HOLDING_CAP_EXCEEDED',
        { holdingCap: allowance.holding.cap, held: allowance.holding.held, inProgress: allowance.holding.pending, allowance });
    }
    let posted;
    try {
      posted = await spendBaseShards(tx, baseId, shards, WORKSHOP_REFINE_TXN_TYPE,
        `workshop:${baseId}:${wallet}:${idempotencyKey}`,
        { wallet, ingots, shards: shards.toString(), recipeVersion, workshopLevel: workshop.level });
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        throw new HttpError(422, `Not enough SHARDS. Refining ${ingots} ingots costs ${shards.toLocaleString('en-US')} SHARDS.`,
          'INSUFFICIENT_SHARDS', { costShards: shards.toString(), baseShards: (await getBaseShardBalance(tx, baseId)).toString() });
      }
      throw error;
    }
    // The debit and job commit atomically. Validate a duplicate posting's
    // amount as well; it must never back a differently priced job.
    const debited = posted.entries.reduce((acc, e) => e.delta < 0n ? acc - e.delta : acc, 0n);
    if (debited !== shards) {
      throw new HttpError(409, 'idempotency key was already used with a different refining request', 'IDEMPOTENCY_BODY_MISMATCH');
    }
    const startedAt = posted.duplicate ? posted.transaction.createdAt : now;
    const readyAt = new Date(startedAt.getTime() + refineDurationSec(ingots, workshop.level) * 1000);
    const [job] = await tx.insert(workshopJobs).values({
      baseId, startedByWallet: wallet, workshopLevelAtStart: workshop.level, recipeVersion,
      ingots, shardsCharged: shards, startedAt, readyAt, capacityScopeAtStart: allowance.scope,
      debitLedgerTxnId: posted.transaction.id, startIdempotencyKey: idempotencyKey,
    }).returning();
    return { ...startResult(job!, false), serverNow: now.toISOString() };
  });
}

const collectResult = (job: JobRow, held: number, duplicate: boolean) => ({
  jobId: job.id, baseId: job.baseId, ingotsCredited: job.ingots, held,
  collectedAt: job.collectedAt!.toISOString(), duplicate,
});

/**
 * Collect a ready job into the base's inventory (`forge_ingot`, acquired_via
 * 'craft'). Lazy readiness (`readyAt <= now`); the CURRENT owner collects.
 * Idempotent on (wallet, idempotencyKey).
 */
export async function collectRefine(
  db: Db, wallet: string, baseId: string, jobId: string, idempotencyKey: string,
  at?: Date, stableContext?: StableBaseMutationContext,
) {
  return db.transaction(async (tx) => {
    await lockOwnedBase(tx, wallet, baseId, stableContext);
    const now = at ?? new Date();
    const [replay] = await tx.select().from(workshopJobs).where(and(
      eq(workshopJobs.collectedByWallet, wallet), eq(workshopJobs.collectIdempotencyKey, idempotencyKey),
    ));
    if (replay) {
      if (replay.id !== jobId || replay.baseId !== baseId) {
        throw new HttpError(409, 'idempotency key was already used to collect a different job', 'IDEMPOTENCY_BODY_MISMATCH');
      }
      return { ...collectResult(replay, await heldIngots(tx, baseId), true), serverNow: now.toISOString() };
    }
    const [job] = await tx.select().from(workshopJobs)
      .where(and(eq(workshopJobs.id, jobId), eq(workshopJobs.baseId, baseId))).for('update');
    if (!job) throw new HttpError(404, 'refining job not found on this base', 'JOB_NOT_FOUND');
    if (job.collectedAt) {
      throw new HttpError(409, 'this job was already collected', 'JOB_ALREADY_COLLECTED',
        { jobId: job.id, ingotsCredited: job.ingots, collectedAt: job.collectedAt.toISOString() });
    }
    if (job.readyAt.getTime() > now.getTime()) {
      throw new HttpError(409, 'this job is still refining', 'JOB_NOT_READY',
        { readyAt: job.readyAt.toISOString(), serverNow: now.toISOString() });
    }
    const [stock] = await tx.insert(baseItems)
      .values({ baseId, itemId: INGOT_ITEM_ID, qty: job.ingots, acquiredVia: 'craft', acquiredAt: now })
      .onConflictDoUpdate({
        target: [baseItems.baseId, baseItems.itemId],
        set: { qty: sql`${baseItems.qty} + ${job.ingots}`, acquiredVia: 'craft' },
      })
      .returning({ qty: baseItems.qty });
    const [collected] = await tx.update(workshopJobs)
      .set({ collectedAt: now, collectedByWallet: wallet, collectIdempotencyKey: idempotencyKey })
      .where(eq(workshopJobs.id, job.id)).returning();
    return { ...collectResult(collected!, stock!.qty, false), serverNow: now.toISOString() };
  });
}

// ---------------------------------------------------------------------------
// Receipts (E1-CONTRACTS §4.0 rule 2): immutable evidence only; `unknown`
// with 200 when nothing matches. The start receipt resolves for the starter
// after a deed transfer and discloses nothing about the new owner's state
// (the conversionReceipt.ts rule): it carries the job's START facts only.
// ---------------------------------------------------------------------------

const Unknown = z.object({ version: z.literal(1), status: z.literal('unknown'), idempotencyKey: z.string() });
export const WorkshopStartReceiptSchema = z.discriminatedUnion('status', [Unknown, z.object({
  version: z.literal(1), status: z.literal('accepted'), wallet: z.string(), baseId: z.uuid(), jobId: z.uuid(),
  ingots: z.number().int().positive(), shardsCharged: z.string().regex(/^[1-9][0-9]*$/),
  recipeVersion: z.number().int().positive(), workshopLevelAtStart: z.number().int().positive(),
  capacityScopeAtStart: z.enum(['free_wallet', 'deed_base']).nullable(),
  startedAt: z.iso.datetime(), readyAt: z.iso.datetime(), receiptId: z.uuid(), acceptedAt: z.iso.datetime(),
})]);
export const WorkshopCollectReceiptSchema = z.discriminatedUnion('status', [Unknown, z.object({
  version: z.literal(1), status: z.literal('accepted'), wallet: z.string(), baseId: z.uuid(), jobId: z.uuid(),
  ingotsCredited: z.number().int().positive(), collectedAt: z.iso.datetime(), receiptId: z.uuid(),
})]);

export async function getWorkshopStartReceipt(db: Db, wallet: string, idempotencyKey: string) {
  const unknown = { version: 1, status: 'unknown', idempotencyKey } as const;
  const [row] = await db.select({ job: workshopJobs, txn: ledgerTransactions }).from(workshopJobs)
    .innerJoin(ledgerTransactions, eq(ledgerTransactions.id, workshopJobs.debitLedgerTxnId))
    .where(and(eq(workshopJobs.startedByWallet, wallet), eq(workshopJobs.startIdempotencyKey, idempotencyKey)));
  if (!row || row.txn.type !== WORKSHOP_REFINE_TXN_TYPE) return unknown;
  const { job, txn } = row;
  const meta = z.object({
    wallet: z.string(), baseId: z.string(), ingots: z.number().int().positive(), shards: z.string().regex(/^[1-9][0-9]*$/),
    recipeVersion: z.number().int().positive(), workshopLevel: z.number().int().positive(),
  }).safeParse(txn.metadata);
  if (!meta.success || meta.data.wallet !== wallet || meta.data.baseId !== job.baseId
    || meta.data.ingots !== job.ingots || BigInt(meta.data.shards) !== job.shardsCharged
    || meta.data.recipeVersion !== job.recipeVersion || meta.data.workshopLevel !== job.workshopLevelAtStart) return unknown;
  // The recipe is LOCKED (D-149 §5): the debit must be exactly ingots × recipe.
  if (BigInt(job.ingots) * BigInt(FORGE_INGOT.shardsPerIngot) !== job.shardsCharged) return unknown;
  const entries = await db.select({ delta: ledgerEntries.delta, kind: accounts.kind, currency: accounts.currency, baseId: accounts.baseId })
    .from(ledgerEntries).innerJoin(accounts, eq(accounts.id, ledgerEntries.accountId)).where(eq(ledgerEntries.txnId, txn.id));
  const has = (kind: string, delta: bigint, baseId: string | null) => entries.some((e) =>
    e.kind === kind && e.currency === 'SHARDS' && e.delta === delta && (e.baseId ?? null) === baseId);
  if (entries.length !== 2 || !has('base_shards', -job.shardsCharged, job.baseId) || !has('shard_burn', job.shardsCharged, null)) return unknown;
  return WorkshopStartReceiptSchema.parse({
    version: 1, status: 'accepted', wallet, baseId: job.baseId, jobId: job.id,
    ingots: job.ingots, shardsCharged: job.shardsCharged.toString(),
    recipeVersion: job.recipeVersion, workshopLevelAtStart: job.workshopLevelAtStart,
    capacityScopeAtStart: job.capacityScopeAtStart,
    startedAt: job.startedAt.toISOString(), readyAt: job.readyAt.toISOString(),
    receiptId: txn.id, acceptedAt: txn.createdAt.toISOString(),
  });
}

export async function getWorkshopCollectReceipt(db: Db, wallet: string, jobId: string, idempotencyKey: string) {
  const unknown = { version: 1, status: 'unknown', idempotencyKey } as const;
  const [job] = await db.select().from(workshopJobs).where(and(
    eq(workshopJobs.id, jobId), eq(workshopJobs.collectedByWallet, wallet), eq(workshopJobs.collectIdempotencyKey, idempotencyKey),
  ));
  if (!job?.collectedAt) return unknown;
  return WorkshopCollectReceiptSchema.parse({
    version: 1, status: 'accepted', wallet, baseId: job.baseId, jobId: job.id,
    ingotsCredited: job.ingots, collectedAt: job.collectedAt.toISOString(), receiptId: job.id,
  });
}
