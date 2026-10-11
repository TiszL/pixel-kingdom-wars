/** A fantasy cutover never rewrites positively retired NFT documents. Keep
 * filtering at both publication legs, before even asking for image/JSON bytes. */
import { sql, type SQLWrapper } from 'drizzle-orm';
import { bases } from '../db/schema';
import { fantasyWorldEnabled } from '../config';
import { FANTASY_WORLD_ID } from '@shardkeep/shared/fantasyWorld';
import type { DbOrTx } from '../db/client';
import { PRESERVED_RETIRED_DEED_MINTS, PRESERVED_RETIRED_DEED_WALLETS } from './retiredDeedPreservation';

/** Applies even before migration imports positive exclusions, and on the
 * wallet compatibility publisher. Never infer claim authority from this list. */
export function retiredMintPublishingScope(assetId: SQLWrapper) {
  return sql`(${assetId} IS NULL OR ${assetId} NOT IN (${sql.join(PRESERVED_RETIRED_DEED_MINTS.map(mint => sql`${mint}`), sql`, `)}))
    AND NOT EXISTS (SELECT 1 FROM fantasy_retirement_exclusions e WHERE e.mint_id=${assetId})`;
}

/** Wallet keys can still be named by an old retired NFT after another deed
 * joins that wallet. Asset-keyed documents for the new deed remain writable. */
export function retiredWalletPublishingScope(wallet: SQLWrapper) {
  return sql`${wallet} NOT IN (${sql.join(PRESERVED_RETIRED_DEED_WALLETS.map(value => sql`${value}`), sql`, `)})
    AND NOT EXISTS (SELECT 1 FROM fantasy_retirement_exclusions e
      JOIN ledger_transactions t ON t.id=e.receipt_id
      WHERE e.mint_id IS NOT NULL AND t.metadata->>'wallet'=${wallet})`;
}
export async function canPublishWalletDeedAlias(db: DbOrTx, wallet: string): Promise<boolean> {
  return (await db.execute(sql`SELECT 1 WHERE ${retiredWalletPublishingScope(sql`${wallet}`)}`)).length > 0;
}

export function fantasyPublishingScope() {
  return sql`${retiredMintPublishingScope(bases.deedAssetId)} AND NOT EXISTS (SELECT 1 FROM fantasy_retirement_exclusions e
      WHERE e.base_id=${bases.id} OR (e.mint_id IS NOT NULL AND e.mint_id=${bases.deedAssetId}))
    AND ((${!fantasyWorldEnabled()}
      AND NOT EXISTS (SELECT 1 FROM fantasy_purchase_cutover)
      AND NOT EXISTS (SELECT 1 FROM fantasy_land_claims WHERE state='assigned'))
    OR EXISTS (SELECT 1 FROM fantasy_land_claims c
      WHERE c.base_id=${bases.id} AND c.world_id=${FANTASY_WORLD_ID} AND c.state='assigned'))`;
}
