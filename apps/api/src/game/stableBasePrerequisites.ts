/**
 * Stable-base authority for deed-owned progression that consumes facilities.
 *
 * Callers lock the player first; this helper then locks the exact active
 * slot/base, refuses mutations while that deed is being raided, and lets the
 * route apply the shared finalized-deed evidence policy before any
 * prerequisite read or currency debit.
 */
import { and, eq } from 'drizzle-orm';
import type { DbOrTx, DbTx } from '../db/client';
import { baseRaidLocks, bases, baseSlots } from '../db/schema';
import { HttpError } from '../lib/errors';
import type { ShardsCacheSourceDependencies } from '../mining/shardsTaxCacheSource';

export interface StableBaseMutationContext {
  baseId: string;
  /** Private server-owned provider; never filled from an HTTP command. */
  shardsCacheSource?: ShardsCacheSourceDependencies;
  assertAuthority: (tx: DbTx, wallet: string, baseId: string) => Promise<void>;
}

/** Read-side ownership fence. Reads do not hold locks or mutate base state, but
 * they still must not disclose another owner's facility capacity after a route
 * precheck races a transfer. */
export async function requireActiveStablePrerequisiteBase(
  db: DbOrTx,
  wallet: string,
  baseId: string,
) {
  const [row] = await db.select({ base: bases }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(
      eq(baseSlots.baseId, baseId),
      eq(baseSlots.wallet, wallet),
      eq(baseSlots.active, true),
      eq(bases.ownerWallet, wallet),
      eq(bases.status, 'active'),
    ));
  if (!row) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  return row.base;
}

export async function lockStablePrerequisiteBase(
  tx: DbTx,
  wallet: string,
  context: StableBaseMutationContext,
) {
  // Match transferStableBase's player → base → slot order. A joined FOR UPDATE
  // leaves row-lock acquisition to the query plan and can invert base/slot when
  // a transfer races this action.
  const [base] = await tx.select().from(bases).where(and(
    eq(bases.id, context.baseId),
    eq(bases.ownerWallet, wallet),
    eq(bases.status, 'active'),
  )).for('update');
  if (!base) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  const [slot] = await tx.select({ baseId: baseSlots.baseId }).from(baseSlots).where(and(
    eq(baseSlots.baseId, base.id),
    eq(baseSlots.wallet, wallet),
    eq(baseSlots.active, true),
  )).for('update');
  if (!slot) throw new HttpError(404, 'base not owned or inactive', 'BASE_NOT_OWNED');
  const [raidLock] = await tx.select({ raidId: baseRaidLocks.raidId })
    .from(baseRaidLocks).where(eq(baseRaidLocks.baseId, base.id)).for('update');
  if (raidLock) {
    throw new HttpError(
      423,
      'You are being raided, please wait to continue playing or watch it live',
      'BASE_BEING_RAIDED',
    );
  }
  await context.assertAuthority(tx, wallet, base.id);
  return base;
}

export function requireStableBaseMutationContext(
  context: StableBaseMutationContext | undefined,
): StableBaseMutationContext {
  if (!context) {
    throw new HttpError(409, 'baseId is required while multi-base is active', 'BASE_ID_REQUIRED');
  }
  return context;
}
