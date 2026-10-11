/** Prospective evidence from the actual locked compensation transaction. No
 * HTTP input can supply a disposition or authorize a historical repair. */
import { sql } from 'drizzle-orm';
import type { TroopType } from '@shardkeep/shared';
import type { DbTx } from '../db/client';

export async function captureCharterArmyChange(tx: DbTx, raidId: string, wallet: string,
 lease: string, used: Partial<Record<TroopType, number>>): Promise<boolean> {
 const requested = Object.fromEntries(Object.entries(used).filter(([, count]) => count !== 0));
 const [row] = await tx.execute<{ accepted: boolean }>(sql`select public.shardkeep_charter_army_disposition_begin(
  ${raidId}::uuid,${wallet},${lease}::uuid,${JSON.stringify(requested)}::jsonb) accepted`);
 if (typeof row?.accepted !== 'boolean') throw Error('Charter army disposition unavailable');
 return row.accepted;
}
