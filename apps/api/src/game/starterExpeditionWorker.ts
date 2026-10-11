/** Accepted-return runner. No implicit startup; the scheduler owns bounded I/O.
 * Accepted sources survive pause, lost slots and changed/inactive custody.
 * The caller owns scheduling, error redaction and persistence of the cursor. */
import { and, asc, eq, gt, isNull, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { bases, starterExpeditionReturns, starterExpeditions } from '../db/schema';
import { settleDueStarterExpeditions } from './starterExpeditionReturns';

export interface StarterExpeditionWorkerOptions {
  /** Operational batch size in bases, not a gameplay or per-base source cap. */
  limit: number;
  afterBaseId?: string;
  clock: () => Date;
  /** Optional caller-owned operational bounds; SET LOCAL never changes the shared pool. */
  timeouts?: { lockMs: number; statementMs: number; idleMs: number };
}
export interface StarterExpeditionWorkerResult {
  /** Successfully examined bases, including work another runner already did. */
  processedBaseIds: string[];
  /** Internal errors only. A future logger must redact DB details. */
  failures: Array<{ baseId: string; error: unknown }>;
  /** Null means this scan ended; start the next scan without a cursor. */
  nextAfterBaseId: string | null;
}
const uuid = z.string().uuid().transform(value => value.toLowerCase());

function sample(clock: () => Date): Date {
  // Copy caller-owned Date objects before any await; later mutation cannot
  // backdate discovery or the atomic return's custody/receipt boundary.
  return new Date(z.date().parse(clock()).getTime());
}

export async function runStarterExpeditionReturns(
  db: Db, options: StarterExpeditionWorkerOptions,
): Promise<StarterExpeditionWorkerResult> {
  const { limit, clock } = options;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError('Starter expedition worker limit must be an integer from 1 to 100');
  }
  if (typeof clock !== 'function') throw new TypeError('Starter expedition worker requires a server clock');
  const after = options.afterBaseId === undefined ? undefined : uuid.parse(options.afterBaseId);
  const timeouts = options.timeouts;
  if (timeouts && (![timeouts.lockMs, timeouts.statementMs, timeouts.idleMs].every(value => Number.isInteger(value) && value > 0 && value <= 60_000)
    || timeouts.lockMs > timeouts.statementMs || timeouts.statementMs > timeouts.idleMs)) {
    throw new RangeError('Invalid starter return transaction timeouts');
  }
  const bound = async (tx: DbTx) => {
    if (timeouts) await tx.execute(sql`SELECT set_config('lock_timeout', ${`${timeouts.lockMs}ms`}, true),
      set_config('statement_timeout', ${`${timeouts.statementMs}ms`}, true),
      set_config('idle_in_transaction_session_timeout', ${`${timeouts.idleMs}ms`}, true)`);
  };
  const discoveredAt = sample(clock);
  // Read-only discovery must not lock a trip before its base. Missing flights
  // remain obligations: the settlement service reports their corrupt evidence.
  const discover = (read: DbOrTx) => read.selectDistinct({ baseId: starterExpeditions.baseId }).from(starterExpeditions)
    .leftJoin(starterExpeditionReturns, eq(starterExpeditionReturns.expeditionId, starterExpeditions.id))
    .where(and(lte(starterExpeditions.returnsAt, discoveredAt), isNull(starterExpeditionReturns.id),
      after === undefined ? undefined : gt(starterExpeditions.baseId, after)))
    .orderBy(asc(starterExpeditions.baseId)).limit(limit + 1);
  // Await PostgreSQL's actual rollback on timeout; never race and abandon a live query.
  const candidates = timeouts ? await db.transaction(async tx => { await bound(tx); return discover(tx); }) : await discover(db);
  const batch = candidates.slice(0, limit);
  const result: StarterExpeditionWorkerResult = { processedBaseIds: [], failures: [],
    nextAfterBaseId: candidates.length > limit ? batch.at(-1)!.baseId : null };
  for (const { baseId } of batch) {
    try {
      await db.transaction(async tx => {
        await bound(tx);
        const [base] = await tx.select({ id: bases.id }).from(bases).where(eq(bases.id, baseId)).for('update');
        if (!base) throw new Error('Original expedition base is missing');
        // Discovery time may precede this lock wait. Drain ALL obligations due
        // at the actual locked cutoff; never acquire a player lock afterward.
        await settleDueStarterExpeditions(tx, base.id, sample(clock));
      });
      result.processedBaseIds.push(baseId);
    } catch (error) {
      result.failures.push({ baseId, error });
    }
  }
  return result;
}
