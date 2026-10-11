import { sql } from 'drizzle-orm';
import type { DbTx } from '../db/client';

/** Canonical outer lock for transactions that create or bulk-unwind custody
 * withdrawals. Always take this before the wallet lock. */
export async function lockWithdrawalGlobalTx(tx: DbTx): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('shardkeep:withdrawal'))`);
}

/** Serializes the last unbonding->processing claim against account recovery.
 * The two-argument form avoids relying on a 64-bit hash cast in application
 * code while keeping the namespace distinct from every existing advisory lock. */
export async function lockWithdrawalWalletTx(tx: DbTx, wallet: string): Promise<void> {
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext('shardkeep:withdrawal-wallet'), hashtext(${wallet})
    )
  `);
}
