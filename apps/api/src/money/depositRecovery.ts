import { and, eq, or } from 'drizzle-orm';
import { deposits } from '../db/schema';

/** Expiry ends new signing admission, not the obligation to honour a proven
 * wallet Gems transfer. This exception never reopens other deposit kinds or
 * paid-failed rows; callers still require positive chain proof before effects. */
export function depositPaymentRecoverable(row: { kind: string; status: string }): boolean {
  return row.status === 'pending' || row.kind === 'gems_buy' && row.status === 'expired';
}

export function recoverableDepositPaymentSql() {
  return or(eq(deposits.status, 'pending'),
    and(eq(deposits.kind, 'gems_buy'), eq(deposits.status, 'expired')))!;
}
