/**
 * Post-commit publication for public deed identity.
 *
 * Username/avatar writes are wallet-scoped, while the public map cache is
 * valley-scoped. Resolve the affected valleys before the write, then evict only
 * after its transaction commits so an in-flight pre-commit reader cannot make
 * stale identity authoritative for another cache lifetime.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client';
import { bases, plots } from '../db/schema';
import { invalidateValley } from '../lib/mapCache';
import { multiBaseEnabled } from '../config';

export async function identityValleysForWallet(db: Db, wallet: string): Promise<string[]> {
  const rows = multiBaseEnabled()
    ? await db.selectDistinct({ valleyId: plots.valleyId }).from(plots)
      .innerJoin(bases, eq(bases.id, plots.baseId))
      .where(eq(bases.ownerWallet, wallet))
    : await db.selectDistinct({ valleyId: plots.valleyId }).from(plots)
      .where(eq(plots.playerWallet, wallet));
  return rows.flatMap((row) => row.valleyId === null ? [] : [row.valleyId]);
}

export function publishWorldIdentity(valleyIds: readonly string[]): void {
  for (const valleyId of valleyIds) invalidateValley(valleyId);
}

/** Re-resolve after commit as well as using the pre-write set. This closes the
 * interleaving where a deed is activated/transferred between the first lookup
 * and the profile commit: either transaction's post-commit publication must
 * evict the valley that can now display this wallet. A failed second read still
 * publishes the known set and never turns a committed profile write into 503. */
export async function publishWorldIdentityAfterCommit(
  db: Db, wallet: string, knownValleyIds: readonly string[],
): Promise<void> {
  let valleyIds = knownValleyIds;
  try {
    valleyIds = [...new Set([...knownValleyIds, ...await identityValleysForWallet(db, wallet)])];
  } catch (err) {
    console.warn('[world-identity] post-commit valley resolution failed', err);
  }
  publishWorldIdentity(valleyIds);
}
