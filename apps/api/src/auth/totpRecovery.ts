import { TWOFA } from '@shardkeep/shared';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { Db } from '../db/client';
import { players, sessions, totpRecoveries, withdrawals } from '../db/schema';
import { HttpError } from '../lib/errors';
import {
  cancelUnbondingWithdrawalsForTotpRecoveryTx,
} from '../money/withdrawals';
import { lockWithdrawalGlobalTx, lockWithdrawalWalletTx } from '../money/withdrawalLock';
import { serverTrack } from '../telemetry';
import {
  assertTotpFactorActionAllowedTx, expireTotpRecoveriesTx, lockTotpRecoveryPlayerTx,
  type TotpFactorAction,
} from './totpRecoveryPolicy';
import {
  hasLiveTotpRecoveryEmailCode, sendTotpRecoveryEmailCode, verifyTotpRecoveryEmailCodeTx,
  verifyWithdrawal2faTx, type EmailSender,
} from './twofa';
import {
  drainTotpRecoveryNotices, enqueueTotpRecoveryNoticeTx,
} from './totpRecoveryNotices';

type RecoveryRow = typeof totpRecoveries.$inferSelect;
const INVALID_RECOVERY_CODE = Symbol('invalid-recovery-code');
const RECOVERY_FACTOR_GONE = Symbol('recovery-factor-gone');

export interface TotpRecoveryStatus {
  recoveryId: string | null;
  status: RecoveryRow['status'] | null;
  readyAt: string | null;
  expiresAt: string | null;
  reenrollmentRequired: boolean;
  receipt: {
    cancelledWithdrawals: number;
    inFlightWithdrawals: number;
    refundedKeep: string;
  } | null;
}

function publicStatus(row: RecoveryRow | undefined, reenrollmentRequired: boolean): TotpRecoveryStatus {
  const hasReceipt = row !== undefined
    && ['holding', 'cancelled', 'completed'].includes(row.status);
  return {
    recoveryId: row?.id ?? null,
    status: row?.status ?? null,
    readyAt: row?.readyAt?.toISOString() ?? null,
    expiresAt: row?.expiresAt?.toISOString() ?? null,
    reenrollmentRequired,
    receipt: hasReceipt ? {
      cancelledWithdrawals: row.cancelledWithdrawalCount,
      inFlightWithdrawals: row.inFlightWithdrawalCount,
      refundedKeep: row.refundedKeep.toString(),
    } : null,
  };
}

export async function getTotpRecoveryStatus(
  db: Db, wallet: string, now = new Date(),
): Promise<TotpRecoveryStatus> {
  return db.transaction(async (tx) => {
    const player = await lockTotpRecoveryPlayerTx(tx, wallet);
    await expireTotpRecoveriesTx(tx, wallet, now);
    const [row] = await tx.select().from(totpRecoveries)
      .where(eq(totpRecoveries.playerWallet, wallet))
      .orderBy(desc(totpRecoveries.requestedAt)).limit(1);
    return publicStatus(row, player.totpReenrollmentRequired);
  });
}

export async function startTotpRecovery(
  db: Db, wallet: string, sessionId: string, recoveryId: string,
  send: EmailSender, now = new Date(),
): Promise<{ status: TotpRecoveryStatus; devCode?: string }> {
  const pendingExpiresAt = new Date(now.getTime() + TWOFA.emailCodeTtlSec * 1_000);
  const started = await db.transaction(async (tx) => {
    const player = await lockTotpRecoveryPlayerTx(tx, wallet);
    await expireTotpRecoveriesTx(tx, wallet, now);
    if (player.totpReenrollmentRequired) {
      throw new HttpError(409, 'finish enrolling your replacement authenticator');
    }
    if (!player.totpEnabled || !player.totpSecret) {
      throw new HttpError(409, 'no Pixel Kingdom Wars authenticator is enabled');
    }
    if (!player.emailVerified || !player.email) {
      throw new HttpError(
        409,
        'authenticator recovery requires a verified Pixel Kingdom Wars contact email — contact support',
        'TOTP_RECOVERY_SUPPORT_REQUIRED',
      );
    }
    const [same] = await tx.select().from(totpRecoveries)
      .where(and(
        eq(totpRecoveries.id, recoveryId),
        eq(totpRecoveries.playerWallet, wallet),
      )).for('update');
    if (same) {
      if (same.status !== 'email_pending' || same.startedSessionId !== sessionId) {
        throw new HttpError(409, 'this authenticator recovery cannot be restarted');
      }
      return { row: same, created: false };
    }
    const [active] = await tx.select({ id: totpRecoveries.id })
      .from(totpRecoveries).where(and(
        eq(totpRecoveries.playerWallet, wallet),
        inArray(totpRecoveries.status, ['email_pending', 'holding']),
      )).limit(1);
    if (active) throw new HttpError(409, 'an authenticator recovery is already active');
    const [row] = await tx.insert(totpRecoveries).values({
      id: recoveryId,
      playerWallet: wallet,
      startedSessionId: sessionId,
      status: 'email_pending',
      targetEmail: player.email,
      requestedAt: now,
      expiresAt: pendingExpiresAt,
      updatedAt: now,
    }).returning();
    if (!row) throw new Error('failed to start authenticator recovery');
    return { row, created: true };
  });

  if (!started.created && await hasLiveTotpRecoveryEmailCode(
    db, wallet, started.row.targetEmail, recoveryId, 'start', sessionId, now,
  )) {
    return { status: publicStatus(started.row, false) };
  }
  try {
    const { devCode } = await sendTotpRecoveryEmailCode(
      db, wallet, started.row.targetEmail, recoveryId, 'start', sessionId, send, now,
    );
    serverTrack('totp_recovery_started', wallet, { recovery_id: recoveryId }, {
      eventId: `totp-recovery-started:${recoveryId}`,
    });
    return {
      status: publicStatus(started.row, false),
      ...(devCode ? { devCode } : {}),
    };
  } catch (error) {
    // A concurrent retry can hit cooldown while the first provider call is
    // still unresolved. Never report that retry as sent: the owner call may
    // still fail. The durable pending row remains retryable after the in-flight
    // reservation either becomes delivered or is cleaned up by its owner.
    if (!started.created && error instanceof HttpError && error.statusCode === 429) {
      throw new HttpError(
        409,
        'authenticator recovery email delivery is still in progress — retry shortly',
        'TOTP_RECOVERY_EMAIL_PENDING',
      );
    }
    // Do not delete the recovery row here: another exact retry may own a newer
    // reservation. Undelivered OTP rows are removed by their own sender, while
    // this bounded pending row expires durably and can be retried with the same
    // UUID without weakening the one-active invariant.
    throw error;
  }
}

export async function confirmTotpRecovery(
  db: Db, wallet: string, sessionId: string, recoveryId: string, code: string,
  send: EmailSender, now = new Date(),
): Promise<{
  status: TotpRecoveryStatus;
  cancelledWithdrawals: number;
  inFlightWithdrawals: number;
  refundedKeep: string;
  replay: boolean;
}> {
  const result = await db.transaction(async (tx) => {
    await lockWithdrawalGlobalTx(tx);
    const player = await lockTotpRecoveryPlayerTx(tx, wallet);
    await expireTotpRecoveriesTx(tx, wallet, now);
    const [row] = await tx.select().from(totpRecoveries).where(and(
      eq(totpRecoveries.id, recoveryId),
      eq(totpRecoveries.playerWallet, wallet),
    )).for('update');
    if (!row) throw new HttpError(404, 'authenticator recovery not found');
    if (row.status === 'holding') {
      return {
        row,
        cancelled: { count: row.cancelledWithdrawalCount, amount: row.refundedKeep },
        inFlight: row.inFlightWithdrawalCount,
        replay: true,
      };
    }
    if (row.status === 'expired') throw new HttpError(410, 'authenticator recovery expired — start again');
    if (row.status !== 'email_pending' || row.startedSessionId !== sessionId) {
      throw new HttpError(409, 'authenticator recovery cannot be confirmed from this session');
    }
    if (!player.totpEnabled || !player.totpSecret) {
      const [cancelled] = await tx.update(totpRecoveries).set({
        status: 'cancelled', cancelledAt: now, updatedAt: now,
      }).where(and(
        eq(totpRecoveries.id, recoveryId),
        eq(totpRecoveries.status, 'email_pending'),
      )).returning();
      if (!cancelled) throw new Error('factor-loss recovery cancellation raced');
      await enqueueTotpRecoveryNoticeTx(tx, {
        recoveryId,
        event: 'cancelled',
        to: cancelled.targetEmail,
        subject: 'Pixel Kingdom Wars authenticator recovery cancelled',
        body: 'Your authenticator recovery request was cancelled because the original Pixel Kingdom Wars authenticator changed before the security hold began. Start again only if recovery is still needed.',
      }, now);
      return RECOVERY_FACTOR_GONE;
    }
    const verified = await verifyTotpRecoveryEmailCodeTx(
      tx, wallet, row.targetEmail, code, recoveryId, 'start', sessionId, now,
    );
    // Return a denial sentinel so the shared attempt counter/lockout commits.
    // Throwing inside this transaction would roll it back and permit unlimited
    // guesses behind only the route's IP limiter.
    if (!verified) return INVALID_RECOVERY_CODE;
    const readyAt = new Date(now.getTime() + TWOFA.recoveryHoldHours * 60 * 60 * 1_000);
    const expiresAt = new Date(now.getTime() + TWOFA.recoveryCompletionDays * 24 * 60 * 60 * 1_000);
    const [holding] = await tx.update(totpRecoveries).set({
      status: 'holding', confirmedAt: now, readyAt, expiresAt, updatedAt: now,
    }).where(and(
      eq(totpRecoveries.id, recoveryId),
      eq(totpRecoveries.status, 'email_pending'),
    )).returning();
    if (!holding) throw new Error('authenticator recovery confirmation raced');
    const cancelled = await cancelUnbondingWithdrawalsForTotpRecoveryTx(
      tx, wallet, recoveryId, now,
    );
    const inFlight = (await tx.select({ id: withdrawals.id }).from(withdrawals).where(and(
      eq(withdrawals.playerWallet, wallet),
      eq(withdrawals.status, 'processing'),
    ))).length;
    const [receipt] = await tx.update(totpRecoveries).set({
      cancelledWithdrawalCount: cancelled.count,
      inFlightWithdrawalCount: inFlight,
      refundedKeep: cancelled.amount,
      updatedAt: now,
    }).where(and(
      eq(totpRecoveries.id, recoveryId),
      eq(totpRecoveries.status, 'holding'),
    )).returning();
    if (!receipt) throw new Error('authenticator recovery receipt write raced');
    await tx.update(sessions).set({ revokedAt: now }).where(and(
      eq(sessions.wallet, wallet), ne(sessions.id, sessionId), isNull(sessions.revokedAt),
    ));
    await enqueueTotpRecoveryNoticeTx(tx, {
      recoveryId,
      event: 'holding',
      to: receipt.targetEmail,
      subject: 'Pixel Kingdom Wars authenticator recovery hold started',
      body: `A Pixel Kingdom Wars authenticator recovery entered its ${TWOFA.recoveryHoldHours}-hour security hold. `
        + `${cancelled.count} pending withdrawal(s) were cancelled and refunded. `
        + `${inFlight} already-processing withdrawal(s) were left untouched. `
        + 'If this was not you and you still have the current authenticator, sign in and cancel recovery immediately.',
    }, now);
    return { row: receipt, cancelled, inFlight, replay: false };
  });

  if (result === INVALID_RECOVERY_CODE) {
    throw new HttpError(422, 'invalid or expired recovery code');
  }
  if (result === RECOVERY_FACTOR_GONE) {
    await drainTotpRecoveryNotices(db, send, now, recoveryId);
    throw new HttpError(
      409,
      'the original Pixel Kingdom Wars authenticator changed — recovery was cancelled',
      'TOTP_RECOVERY_FACTOR_CHANGED',
    );
  }

  if (!result.replay) {
    await drainTotpRecoveryNotices(db, send, now, recoveryId);
    serverTrack('totp_recovery_holding', wallet, {
      recovery_id: recoveryId,
      cancelled_withdrawals: result.cancelled.count,
    }, { eventId: `totp-recovery-holding:${recoveryId}` });
  }
  return {
    status: publicStatus(result.row, false),
    cancelledWithdrawals: result.cancelled.count,
    inFlightWithdrawals: result.inFlight,
    refundedKeep: result.cancelled.amount.toString(),
    replay: result.replay,
  };
}

export async function cancelTotpRecovery(
  db: Db, wallet: string, recoveryId: string, currentTotpCode: string,
  send: EmailSender, now = new Date(),
): Promise<TotpRecoveryStatus> {
  const result = await db.transaction(async (tx) => {
    await lockTotpRecoveryPlayerTx(tx, wallet);
    await expireTotpRecoveriesTx(tx, wallet, now);
    const [current] = await tx.select().from(totpRecoveries).where(and(
      eq(totpRecoveries.id, recoveryId),
      eq(totpRecoveries.playerWallet, wallet),
    )).for('update');
    if (!current) throw new HttpError(404, 'authenticator recovery not found');
    if (current.status === 'cancelled') return { row: current, transitioned: false };
    if (!['email_pending', 'holding'].includes(current.status)) {
      throw new HttpError(409, `cannot cancel a ${current.status} recovery`);
    }
    const valid = await verifyWithdrawal2faTx(
      tx, wallet, 'totp', currentTotpCode, now,
    );
    if (!valid) return INVALID_RECOVERY_CODE;
    const [cancelled] = await tx.update(totpRecoveries).set({
      status: 'cancelled', cancelledAt: now, updatedAt: now,
    }).where(and(
      eq(totpRecoveries.id, recoveryId),
      inArray(totpRecoveries.status, ['email_pending', 'holding']),
    )).returning();
    if (!cancelled) throw new Error('authenticator recovery cancellation raced');
    await enqueueTotpRecoveryNoticeTx(tx, {
      recoveryId,
      event: 'cancelled',
      to: cancelled.targetEmail,
      subject: 'Pixel Kingdom Wars authenticator recovery cancelled',
      body: 'Your Pixel Kingdom Wars authenticator recovery was cancelled with the current authenticator. Previously cancelled withdrawals remain cancelled and refunded.',
    }, now);
    return { row: cancelled, transitioned: true };
  });
  if (result === INVALID_RECOVERY_CODE) {
    throw new HttpError(422, 'invalid Pixel Kingdom Wars authenticator code');
  }
  if (result.transitioned) {
    await drainTotpRecoveryNotices(db, send, now, recoveryId);
    serverTrack('totp_recovery_cancelled', wallet, { recovery_id: recoveryId }, {
      eventId: `totp-recovery-cancelled:${recoveryId}`,
    });
  }
  return publicStatus(result.row, false);
}

async function completionRow(
  db: Db, wallet: string, recoveryId: string, now: Date,
): Promise<RecoveryRow> {
  return db.transaction(async (tx) => {
    await lockTotpRecoveryPlayerTx(tx, wallet);
    await expireTotpRecoveriesTx(tx, wallet, now);
    const [row] = await tx.select().from(totpRecoveries).where(and(
      eq(totpRecoveries.id, recoveryId),
      eq(totpRecoveries.playerWallet, wallet),
    )).for('update');
    if (!row) throw new HttpError(404, 'authenticator recovery not found');
    if (row.status === 'expired') throw new HttpError(410, 'authenticator recovery expired — start again');
    if (row.status !== 'holding' || !row.readyAt || row.readyAt > now) {
      throw new HttpError(423, 'authenticator recovery security hold is not complete', 'TOTP_RECOVERY_HOLD');
    }
    return row;
  });
}

export async function sendTotpRecoveryCompletionCode(
  db: Db, wallet: string, sessionId: string, recoveryId: string,
  send: EmailSender, now = new Date(),
): Promise<{ sent: true; devCode?: string }> {
  const row = await completionRow(db, wallet, recoveryId, now);
  const { devCode } = await sendTotpRecoveryEmailCode(
    db, wallet, row.targetEmail, recoveryId, 'complete', sessionId, send, now,
  );
  return { sent: true, ...(devCode ? { devCode } : {}) };
}

export async function completeTotpRecovery(
  db: Db, wallet: string, sessionId: string, recoveryId: string, code: string,
  send: EmailSender, now = new Date(),
): Promise<{ status: TotpRecoveryStatus; transitioned: boolean }> {
  const result = await db.transaction(async (tx) => {
    const player = await lockTotpRecoveryPlayerTx(tx, wallet);
    await expireTotpRecoveriesTx(tx, wallet, now);
    const [current] = await tx.select().from(totpRecoveries).where(and(
      eq(totpRecoveries.id, recoveryId),
      eq(totpRecoveries.playerWallet, wallet),
    )).for('update');
    if (!current) throw new HttpError(404, 'authenticator recovery not found');
    if (current.status === 'completed') {
      return {
        row: current,
        transitioned: false,
        reenrollmentRequired: player.totpReenrollmentRequired,
      };
    }
    if (current.status === 'expired') throw new HttpError(410, 'authenticator recovery expired — start again');
    if (current.status !== 'holding' || !current.readyAt || current.readyAt > now) {
      throw new HttpError(423, 'authenticator recovery security hold is not complete', 'TOTP_RECOVERY_HOLD');
    }
    const verified = await verifyTotpRecoveryEmailCodeTx(
      tx, wallet, current.targetEmail, code, recoveryId, 'complete', sessionId, now,
    );
    if (!verified) return INVALID_RECOVERY_CODE;
    await tx.update(players).set({
      totpSecret: null,
      totpEnabled: false,
      totpEnabledAt: null,
      totpLastUsedStep: null,
      totpReenrollmentRequired: true,
    }).where(eq(players.wallet, wallet));
    const [completed] = await tx.update(totpRecoveries).set({
      status: 'completed', completedSessionId: sessionId, completedAt: now, updatedAt: now,
    }).where(and(
      eq(totpRecoveries.id, recoveryId),
      eq(totpRecoveries.status, 'holding'),
    )).returning();
    if (!completed) throw new Error('authenticator recovery completion raced');
    await tx.update(sessions).set({ revokedAt: now }).where(and(
      eq(sessions.wallet, wallet), isNull(sessions.revokedAt),
    ));
    await enqueueTotpRecoveryNoticeTx(tx, {
      recoveryId,
      event: 'completed',
      to: completed.targetEmail,
      subject: 'Pixel Kingdom Wars authenticator recovery completed',
      body: 'Your old Pixel Kingdom Wars authenticator was removed. All sessions were signed out. Sign in again and enroll a new Pixel Kingdom Wars authenticator before exporting a key or creating a withdrawal.',
    }, now);
    return { row: completed, transitioned: true, reenrollmentRequired: true };
  });
  if (result === INVALID_RECOVERY_CODE) {
    throw new HttpError(422, 'invalid or expired recovery code');
  }
  if (result.transitioned) {
    await drainTotpRecoveryNotices(db, send, now, recoveryId);
    serverTrack('totp_recovery_completed', wallet, { recovery_id: recoveryId }, {
      eventId: `totp-recovery-completed:${recoveryId}`,
    });
  }
  return {
    status: publicStatus(result.row, result.reenrollmentRequired),
    transitioned: result.transitioned,
  };
}

/** Narrow route helper: holding blocks every factor mutation; after completion,
 * only the email step-up + replacement TOTP enroll/verify sequence is allowed. */
export async function assertTotpFactorActionAllowed(
  db: Db, wallet: string,
  action: TotpFactorAction,
  now = new Date(),
): Promise<void> {
  await db.transaction((tx) => assertTotpFactorActionAllowedTx(tx, wallet, action, now));
}
