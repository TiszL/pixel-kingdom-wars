/** D153.278 / D-190 recorded-deed eligibility. Active ownership and finalized
 * proof remain the caller's fences; mutations call this under their base lock. */
import { and, eq } from 'drizzle-orm';
import type { DbOrTx } from '../db/client';
import { bases, baseSlots } from '../db/schema';
import { isFantasyRetired } from './fantasyLocationRead';

export type RecordedDeedRefusal = 'LAND_NOT_PAID' | 'NO_DEED_ASSET' | 'LEGACY_UNKNOWN_MINT' | 'RETIRED_DEED';

export async function recordedDeedRefusal(db: DbOrTx, base: {
  id: string; landPaidAt: Date | null; deedAssetId: string | null; deedMintAssetId: string | null;
}): Promise<RecordedDeedRefusal | null> {
  if (base.landPaidAt === null) return 'LAND_NOT_PAID';
  if (base.deedAssetId === null) return 'NO_DEED_ASSET';
  if (base.deedMintAssetId?.startsWith('legacy-unknown:')) return 'LEGACY_UNKNOWN_MINT';
  if (await isFantasyRetired(db, base.id, base.deedAssetId)) return 'RETIRED_DEED';
  return null;
}

/** Read-side wallet eligibility only, never a substitute for a locked per-base
 * mutation check. Another deed in the wallet does not authorize a free base. */
export async function hasRecordedDeed(db: DbOrTx, wallet: string): Promise<boolean> {
  const rows = await db.select({ base: bases }).from(baseSlots)
    .innerJoin(bases, eq(bases.id, baseSlots.baseId))
    .where(and(eq(baseSlots.wallet, wallet), eq(baseSlots.active, true),
      eq(bases.ownerWallet, wallet), eq(bases.status, 'active')));
  for (const { base } of rows) if (await recordedDeedRefusal(db, base) === null) return true;
  return false;
}
