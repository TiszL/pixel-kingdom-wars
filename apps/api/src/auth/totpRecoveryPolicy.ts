import { and, desc, eq, inArray, lte } from 'drizzle-orm';
import type { Db, DbTx } from '../db/client';
import { players, totpRecoveries } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockWithdrawalWalletTx } from '../money/withdrawalLock';
import { serverTrack } from '../telemetry';
import {
  drainTotpRecoveryNotices, enqueueTotpRecoveryNoticeTx,
} from './totpRecoveryNotices';
import type { EmailSender } from './twofa';

export type TotpRecoveryProtectedAction =
  | 'key_export'
  | 'factor_change'
  | 'email_change'
  | 'withdrawal';

export type TotpFactorAction =
  | 'step_up_email' | 'totp_enroll' | 'totp_verify' | 'totp_disable' | 'email_change';

/** Expiry is written, not merely inferred. This releases the one-active-row
 * index and makes an abandoned start/hold recoverable across deploys. */
export async function expireTotpRecoveriesTx(
  tx: DbTx, wallet: string, now = new Date(),
): Promise<Array<{ id: string; targetEmail: string }>> {
  const expired = await tx.update(totpRecoveries).set({ status: 'expired', updatedAt: now }).where(and(
    eq(totpRecoveries.playerWallet, wallet),
    inArray(totpRecoveries.status, ['email_pending', 'holding']),
    lte(totpRecoveries.expiresAt, now),
  )).returning({
    id: totpRecoveries.id,
    targetEmail: totpRecoveries.targetEmail,
    confirmedAt: totpRecoveries.confirmedAt,
  });
  for (const row of expired) {
    await enqueueTotpRecoveryNoticeTx(tx, {
      recoveryId: row.id,
      event: 'expired',
      to: row.targetEmail,
      subject: 'Pixel Kingdom Wars authenticator recovery expired',
      body: row.confirmedAt
        ? `Your Pixel Kingdom Wars authenticator recovery expired after ${TWOFA.recoveryCompletionDays} days. Your existing authenticator remains enabled. Start a new recovery if you still need help.`
        : 'Your unconfirmed Pixel Kingdom Wars authenticator recovery request expired. Your existing authenticator remains enabled. Start again if recovery is still needed.',
    }, now);
  }
  return expired;
}

/** Bounded worker sweep: expiry and its alert are one DB commit even when the
 * player never returns. Delivery is retried through the durable outbox. */
export async function sweepExpiredTotpRecoveries(
  db: Db, send: EmailSender, now = new Date(),
): Promise<{ expired: number; sent: number; failed: number }> {
  const due = await db.select({ wallet: totpRecoveries.playerWallet })
    .from(totpRecoveries).where(and(
      inArray(totpRecoveries.status, ['email_pending', 'holding']),
      lte(totpRecoveries.expiresAt, now),
    )).limit(100);
  let expired = 0;
  for (const { wallet } of due) {
    const rows = await db.transaction(async (tx) => {
      await lockTotpRecoveryPlayerTx(tx, wallet);
      return expireTotpRecoveriesTx(tx, wallet, now);
    });
    expired += rows.length;
    for (const row of rows) {
      serverTrack('totp_recovery_expired', wallet, { recovery_id: row.id }, {
        eventId: `totp-recovery-expired:${row.id}`,
      });
    }
  }
  const delivered = await drainTotpRecoveryNotices(db, send, now);
  return { expired, ...delivered };
}

/** First two locks in every recovery/factor/custody transaction. Returning the
 * locked player avoids a later player-row acquisition after a recovery row. */
export async function lockTotpRecoveryPlayerTx(
  tx: DbTx, wallet: string,
): Promise<typeof players.$inferSelect> {
  await lockWithdrawalWalletTx(tx, wallet);
  const [player] = await tx.select().from(players)
    .where(eq(players.wallet, wallet)).for('update');
  if (!player) throw new HttpError(404, 'player not found');
  return player;
}

export async function totpRecoveryProtectionTx(
  tx: DbTx, wallet: string, now = new Date(),
): Promise<{ pending: boolean; holding: boolean; reenrollmentRequired: boolean }> {
  // Canonical recovery/custody lock graph:
  //   optional global withdrawal lock -> wallet advisory lock -> player row
  //   -> recovery row -> email/withdrawal rows.
  // The advisory lock is transaction-scoped and re-entrant, so money callers
  // that already own it can safely use this guard without changing order.
  const player = await lockTotpRecoveryPlayerTx(tx, wallet);
  await expireTotpRecoveriesTx(tx, wallet, now);
  const [active] = await tx.select({ status: totpRecoveries.status })
    .from(totpRecoveries)
    .where(and(
      eq(totpRecoveries.playerWallet, wallet),
      inArray(totpRecoveries.status, ['email_pending', 'holding']),
    ))
    .orderBy(desc(totpRecoveries.requestedAt)).limit(1).for('update');
  return {
    holding: active?.status === 'holding',
    pending: active?.status === 'email_pending',
    reenrollmentRequired: player.totpReenrollmentRequired,
  };
}

export async function assertTotpRecoveryAllowsTx(
  tx: DbTx, wallet: string, action: TotpRecoveryProtectedAction, now = new Date(),
): Promise<void> {
  const state = await totpRecoveryProtectionTx(tx, wallet, now);
  if (state.holding) {
    throw new HttpError(
      423,
      'authenticator recovery is in its security hold — this action is temporarily locked',
      'TOTP_RECOVERY_HOLD',
    );
  }
  if (state.reenrollmentRequired) {
    throw new HttpError(
      423,
      action === 'factor_change'
        ? 'enroll a new Pixel Kingdom Wars authenticator before changing security settings'
        : 'enroll a new Pixel Kingdom Wars authenticator before this action',
      'TOTP_REENROLLMENT_REQUIRED',
    );
  }
}

export async function assertTotpFactorActionAllowedTx(
  tx: DbTx, wallet: string, action: TotpFactorAction, now = new Date(),
): Promise<void> {
  const state = await totpRecoveryProtectionTx(tx, wallet, now);
  if (state.pending || state.holding) {
    throw new HttpError(
      423,
      state.pending
        ? 'confirm or cancel the pending authenticator recovery before changing security factors'
        : 'authenticator recovery is in its security hold',
      state.pending ? 'TOTP_RECOVERY_PENDING' : 'TOTP_RECOVERY_HOLD',
    );
  }
  if (state.reenrollmentRequired
    && !['step_up_email', 'totp_enroll', 'totp_verify'].includes(action)) {
    throw new HttpError(
      423,
      'enroll a new Pixel Kingdom Wars authenticator before changing security settings',
      'TOTP_REENROLLMENT_REQUIRED',
    );
  }
}

export async function assertTotpRecoveryAllows(
  db: Db, wallet: string, action: TotpRecoveryProtectedAction, now = new Date(),
): Promise<void> {
  await db.transaction((tx) => assertTotpRecoveryAllowsTx(tx, wallet, action, now));
}
import { TWOFA } from '@shardkeep/shared';
