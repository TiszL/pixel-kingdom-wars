/** Count-only private tail of the original caller's starter return transaction.
 * SQL derives all effects from the saved owner-admitted fitting and primary proof. */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DbTx } from '../db/client';
export async function finishStarterEquipmentReturn(tx: DbTx, expeditionId: string): Promise<number> {
  if (!('rollback' in tx)) throw new Error('Starter equipment return requires an existing transaction');
  const [row] = await tx.execute<{ count: number }>(sql`select public.shardkeep_finish_starter_equipment(${z.string().uuid().parse(expeditionId)}::uuid) count`);
  if (!row || ![0, 1].includes(row.count)) throw new Error('Invalid starter equipment return result');
  return row.count;
}
