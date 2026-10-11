import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import { outbox } from '../db/schema';
import { errorForStorage } from '../lib/errors';

type NoticeSender = (
  to: string,
  subject: string,
  body: string,
  html?: string,
  options?: { idempotencyKey?: string },
) => Promise<void>;

export type TotpRecoveryNoticeEvent = 'holding' | 'cancelled' | 'completed' | 'expired';

interface NoticePayload {
  version: 1;
  recoveryId: string;
  event: TotpRecoveryNoticeEvent;
  to: string;
  subject: string;
  body: string;
}

export async function enqueueTotpRecoveryNoticeTx(
  tx: DbTx, input: Omit<NoticePayload, 'version'>, now = new Date(),
): Promise<void> {
  await tx.insert(outbox).values({
    kind: 'totp_recovery_notice',
    payload: { version: 1, ...input },
    createdAt: now,
    nextAttemptAt: now,
  });
}

/** Retryable security-notice relay. Transition rows enqueue exactly once in the
 * same transaction; provider failures remain pending with bounded backoff. */
export async function drainTotpRecoveryNotices(
  db: Db, send: NoticeSender, now = new Date(), recoveryId?: string,
): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  for (let i = 0; i < 20; i++) {
    const token = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    const row = await db.transaction(async (tx) => {
      const [candidate] = await tx.select().from(outbox).where(and(
        eq(outbox.kind, 'totp_recovery_notice'),
        inArray(outbox.status, ['pending', 'failed']),
        lte(outbox.nextAttemptAt, now),
        or(isNull(outbox.deliveryLeaseExpiresAt), lte(outbox.deliveryLeaseExpiresAt, now)),
        ...(recoveryId ? [sql`${outbox.payload}->>'recoveryId' = ${recoveryId}`] : []),
        // Security notices for one recovery are causal. A later cancellation or
        // completion must never overtake a failed/backed-off hold notice and
        // leave the player receiving stale warnings afterward.
        sql`NOT EXISTS (
          SELECT 1 FROM outbox earlier
          WHERE earlier.kind = 'totp_recovery_notice'
            AND earlier.id < ${outbox.id}
            AND earlier.payload->>'recoveryId' = ${outbox.payload}->>'recoveryId'
            AND earlier.status <> 'sent'
        )`,
      )).orderBy(asc(outbox.id)).limit(1).for('update', { skipLocked: true });
      if (!candidate) return undefined;
      const [leased] = await tx.update(outbox).set({
        deliveryLeaseToken: token,
        deliveryLeaseExpiresAt: leaseExpiresAt,
      }).where(and(
        eq(outbox.id, candidate.id),
        or(isNull(outbox.deliveryLeaseExpiresAt), lte(outbox.deliveryLeaseExpiresAt, now)),
      )).returning();
      return leased;
    });
    if (!row) break;
    const payload = row.payload as NoticePayload;
    try {
      await send(payload.to, payload.subject, payload.body, undefined, {
        idempotencyKey: `totp-recovery:${row.id.toString()}`,
      });
      await db.update(outbox).set({
        status: 'sent', sentAt: now, lastError: null,
        deliveryLeaseToken: null, deliveryLeaseExpiresAt: null,
      }).where(and(eq(outbox.id, row.id), eq(outbox.deliveryLeaseToken, token)));
      sent++;
    } catch (error) {
      const delayMs = Math.min(60 * 60_000, 30_000 * (2 ** Math.min(row.attempts, 7)));
      await db.update(outbox).set({
        status: 'failed',
        attempts: sql`${outbox.attempts} + 1`,
        lastError: errorForStorage(error),
        nextAttemptAt: new Date(now.getTime() + delayMs),
        deliveryLeaseToken: null,
        deliveryLeaseExpiresAt: null,
      }).where(and(eq(outbox.id, row.id), eq(outbox.deliveryLeaseToken, token)));
      failed++;
    }
  }
  return { sent, failed };
}
