import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';

/** Also inspected offline by the reviewed deployment/rollback gate. */
export const ITEM_MARKET_SERVER_CAPABILITY = 'marketplace-receipts-v1';

export async function assertMarketRecoveryCompatible(db: Db, capability: string = ITEM_MARKET_SERVER_CAPABILITY) {
  const rows = await db.execute(sql`select public.shardkeep_item_market_required_contract() as required`);
  const required = Number(rows[0]?.['required']);
  if ((required !== 0 && required !== 1) || (required === 1 && capability !== ITEM_MARKET_SERVER_CAPABILITY)) {
    throw new Error('Database requires marketplace-receipts-v1; use a compatible forward recovery image');
  }
}
