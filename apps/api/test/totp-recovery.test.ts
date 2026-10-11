import { randomUUID } from 'node:crypto';
import { TWOFA } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { and, eq, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  cancelTotpRecovery, completeTotpRecovery, confirmTotpRecovery,
  getTotpRecoveryStatus, sendTotpRecoveryCompletionCode, startTotpRecovery,
} from '../src/auth/totpRecovery';
import { assertTotpRecoveryAllows } from '../src/auth/totpRecoveryPolicy';
import {
  disableTotp, enrollTotp, factorChangeEmailChallengeContext, sendFactorStepUpEmailCode,
  startEmailEnroll, verifyTotpEnroll, type EmailSender,
} from '../src/auth/twofa';
import {
  ledgerEntries, outbox, players, sessions, totpRecoveries, withdrawalPayoutReservations, withdrawals,
} from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { requestWithdrawal } from '../src/money/withdrawals';
import {
  drainTotpRecoveryNotices, enqueueTotpRecoveryNoticeTx,
} from '../src/auth/totpRecoveryNotices';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const DEST = Keypair.generate().publicKey.toBase58();
let sequence = 0;
const key = (): string => `totp-recovery-${++sequence}-${randomUUID()}`;

function mailbox(): { send: EmailSender; code: () => string; deliveries: () => number } {
  let latest: string | null = null;
  let count = 0;
  return {
    send: async (_to, _subject, body) => {
      count += 1;
      latest = body.match(/\b(\d{6})\b/)?.[1] ?? latest;
    },
    code: () => {
      if (!latest) throw new Error('no email code captured');
      return latest;
    },
    deliveries: () => count,
  };
}

function codeFor(secret: string, now: Date): string {
  return new TOTP({
    algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret),
  }).generate({ timestamp: now.getTime() });
}

async function session(wallet: string): Promise<string> {
  const [row] = await db.insert(sessions).values({
    wallet, expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  }).returning({ id: sessions.id });
  return row!.id;
}

async function securedPlayer(now: Date, keep = 20_000n) {
  const player = await createTestPlayer(db);
  await ensureStartingBase(db, player.wallet);
  if (keep > 0n) await fundTestKeep(db, player.wallet, keep, 'test.totp-recovery', key());
  const { secret } = await enrollTotp(db, player.wallet);
  await verifyTotpEnroll(db, player.wallet, codeFor(secret, now), now);
  await db.update(players).set({
    email: `recovery-${sequence}@pkw.testmail.dev`, emailVerified: true,
  }).where(eq(players.wallet, player.wallet));
  return { ...player, secret };
}

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('lost PKW authenticator recovery', () => {
  it('requires both the existing PKW authenticator and a verified contact email', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const plain = await createTestPlayer(db);
    const plainSession = await session(plain.wallet);
    await expect(startTotpRecovery(
      db, plain.wallet, plainSession, randomUUID(), mailbox().send, now,
    )).rejects.toMatchObject({ statusCode: 409 });

    const secured = await securedPlayer(now, 0n);
    await db.update(players).set({ email: null, emailVerified: false })
      .where(eq(players.wallet, secured.wallet));
    await expect(startTotpRecovery(
      db, secured.wallet, await session(secured.wallet), randomUUID(), mailbox().send, now,
    )).rejects.toMatchObject({
      statusCode: 409,
      code: 'TOTP_RECOVERY_SUPPORT_REQUIRED',
    });
  });

  it('expires an abandoned email start durably and permits a fresh recovery id', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    const first = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, sid, first, mail.send, now);

    const expiredAt = new Date(now.getTime() + TWOFA.emailCodeTtlSec * 1_000 + 1);
    expect((await getTotpRecoveryStatus(db, player.wallet, expiredAt)).status).toBe('expired');
    expect((await db.select().from(totpRecoveries)
      .where(eq(totpRecoveries.id, first)))[0]?.status).toBe('expired');
    const pendingExpiryNotice = (await db.select().from(outbox).where(and(
      eq(outbox.kind, 'totp_recovery_notice'),
      sql`${outbox.payload}->>'recoveryId' = ${first}`,
    ))).find((row) => (row.payload as { event?: string }).event === 'expired');
    expect((pendingExpiryNotice?.payload as { body?: string }).body).toContain('unconfirmed');

    const second = randomUUID();
    await startTotpRecovery(db, player.wallet, sid, second, mail.send, expiredAt);
    expect((await getTotpRecoveryStatus(db, player.wallet, expiredAt)).recoveryId).toBe(second);
  });

  it('makes lost-response and concurrent start retries idempotent', async () => {
    const now = new Date('2026-09-02T01:00:00.000Z');
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    const recoveryId = randomUUID();
    const mail = mailbox();

    await startTotpRecovery(db, player.wallet, sid, recoveryId, mail.send, now);
    const retry = await startTotpRecovery(
      db, player.wallet, sid, recoveryId, mail.send, new Date(now.getTime() + 1_000),
    );
    expect(retry.status.recoveryId).toBe(recoveryId);
    expect(mail.deliveries()).toBe(1);
    expect(await db.select().from(totpRecoveries).where(eq(totpRecoveries.id, recoveryId)))
      .toHaveLength(1);
  });

  it('serializes truly concurrent start retries onto one row and one email', async () => {
    const now = new Date('2026-09-02T01:30:00.000Z');
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    const recoveryId = randomUUID();
    const mail = mailbox();
    let entered!: () => void;
    let release!: () => void;
    const sendEntered = new Promise<void>((resolve) => { entered = resolve; });
    const sendReleased = new Promise<void>((resolve) => { release = resolve; });
    let senderCalls = 0;
    const delayed: EmailSender = async (...args) => {
      if (++senderCalls > 1) throw new Error('duplicate recovery email send');
      entered();
      await sendReleased;
      await mail.send(...args);
    };

    const owner = startTotpRecovery(db, player.wallet, sid, recoveryId, delayed, now);
    try {
      // Hold delivery unresolved: a retry after delivery is legitimately
      // successful, so elapsed time cannot establish this concurrency case.
      await Promise.race([sendEntered, owner]);
      await expect(startTotpRecovery(
        db, player.wallet, sid, recoveryId, delayed, now,
      )).rejects.toMatchObject({ statusCode: 409, code: 'TOTP_RECOVERY_EMAIL_PENDING' });
    } finally {
      release();
      await owner;
    }
    expect(mail.deliveries()).toBe(1);
    await expect(startTotpRecovery(
      db, player.wallet, sid, recoveryId, delayed, new Date(now.getTime() + 1_000),
    )).resolves.toMatchObject({ status: { recoveryId } });
    expect(mail.deliveries()).toBe(1);
    expect(await db.select().from(totpRecoveries).where(eq(totpRecoveries.id, recoveryId)))
      .toHaveLength(1);
  });

  it('never reports an in-flight failed delivery as sent and keeps the exact row retryable', async () => {
    const now = new Date('2026-09-02T01:45:00.000Z');
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    const recoveryId = randomUUID();
    let rejectProvider!: () => void;
    const providerGate = new Promise<void>((_resolve, reject) => {
      rejectProvider = () => reject(new Error('provider unavailable'));
    });
    const failing: EmailSender = async () => providerGate;

    const owner = startTotpRecovery(db, player.wallet, sid, recoveryId, failing, now);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(startTotpRecovery(db, player.wallet, sid, recoveryId, failing, now))
      .rejects.toMatchObject({ statusCode: 409, code: 'TOTP_RECOVERY_EMAIL_PENDING' });
    rejectProvider();
    await expect(owner).rejects.toMatchObject({ statusCode: 503, code: 'EMAIL_DELIVERY_UNAVAILABLE' });

    const mail = mailbox();
    await expect(startTotpRecovery(
      db, player.wallet, sid, recoveryId, mail.send, new Date(now.getTime() + 1_000),
    )).resolves.toMatchObject({ status: { recoveryId } });
    expect(mail.deliveries()).toBe(1);
    expect(await db.select().from(totpRecoveries).where(eq(totpRecoveries.id, recoveryId)))
      .toHaveLength(1);
  });

  it('starts the hold atomically, refunds only unbonding custody, and revokes siblings', async () => {
    const now = new Date('2026-09-02T02:00:00.000Z');
    const player = await securedPlayer(now);
    const current = await session(player.wallet);
    const sibling = await session(player.wallet);
    const balanceBefore = (await getOrCreatePlayerAccount(db, player.wallet, 'player_keep')).balance;
    const withdrawal = await requestWithdrawal(db, player.wallet, 4_000n, DEST, key(), { now });
    // Model the payout worker's crash seam: allowance reserved, but no signed
    // attempt or unbonding->processing claim persisted yet.
    expect((await db.execute(sql<{ allowed: boolean }>`
      SELECT public.shardkeep_reserve_withdrawal_allowance(
        ${withdrawal.id}::uuid, ${player.wallet}::text, ${withdrawal.amount}::bigint, 1000000::bigint
      ) AS allowed
    `))[0]?.allowed).toBe(true);
    const [prepared] = await db.insert(withdrawals).values({
      playerWallet: player.wallet,
      currency: 'KEEP',
      amount: 321n,
      destination: DEST,
      status: 'unbonding',
      unbondsAt: now,
      lastError: 'SIGNED AND PERSISTED — broadcast pending',
    }).returning();
    expect((await db.execute(sql<{ allowed: boolean }>`
      SELECT public.shardkeep_reserve_withdrawal_allowance(
        ${prepared!.id}::uuid, ${player.wallet}::text, ${prepared!.amount}::bigint, 1000000::bigint
      ) AS allowed
    `))[0]?.allowed).toBe(true);
    await db.update(withdrawals).set({ status: 'processing' })
      .where(eq(withdrawals.id, prepared!.id));
    const recoveryId = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, current, recoveryId, mail.send, now);

    const confirmed = await confirmTotpRecovery(
      db, player.wallet, current, recoveryId, mail.code(), mail.send,
      new Date(now.getTime() + 1_000),
    );
    expect(confirmed).toMatchObject({
      cancelledWithdrawals: 1, inFlightWithdrawals: 1, refundedKeep: '4000', replay: false,
    });
    const noticesAfterTransition = mail.deliveries();
    const replay = await confirmTotpRecovery(
      db, player.wallet, current, recoveryId, 'response-was-lost', mail.send,
      new Date(now.getTime() + 2_000),
    );
    expect(replay).toEqual({
      status: confirmed.status,
      cancelledWithdrawals: 1,
      inFlightWithdrawals: 1,
      refundedKeep: '4000',
      replay: true,
    });
    expect(mail.deliveries()).toBe(noticesAfterTransition);
    expect((await getOrCreatePlayerAccount(db, player.wallet, 'player_keep')).balance).toBe(balanceBefore);
    const cancelledRow = (await db.select().from(withdrawals)
      .where(eq(withdrawals.id, withdrawal.id)))[0];
    expect(cancelledRow).toMatchObject({ status: 'cancelled', lastError: null });
    expect(cancelledRow?.refundLedgerTxnId).not.toBeNull();
    const [refundEvidence] = await db.execute(sql<{ count: number; total: bigint }>`
      SELECT count(*)::int AS count, sum(delta)::bigint AS total
      FROM ledger_entries WHERE txn_id=${cancelledRow!.refundLedgerTxnId}
    `);
    expect(refundEvidence).toEqual({ count: 2, total: '0' });
    expect((await db.select().from(withdrawalPayoutReservations)
      .where(eq(withdrawalPayoutReservations.withdrawalId, withdrawal.id)))[0]?.status)
      .toBe('released');
    // A persisted/signed processing row is outside the recovery cancellation
    // set. Its custody reservation stays live for reconciliation/broadcast.
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, prepared!.id)))[0]?.status)
      .toBe('processing');
    expect((await db.select().from(withdrawalPayoutReservations)
      .where(eq(withdrawalPayoutReservations.withdrawalId, prepared!.id)))[0]?.status)
      .toBe('reserved');
    expect((await db.select().from(sessions).where(eq(sessions.id, sibling)))[0]?.revokedAt).not.toBeNull();
    expect((await db.select().from(sessions).where(eq(sessions.id, current)))[0]?.revokedAt).toBeNull();
    await expect(requestWithdrawal(db, player.wallet, 4_000n, DEST, key(), {
      now: new Date(now.getTime() + 2_000),
    })).rejects.toMatchObject({ statusCode: 423, code: 'TOTP_RECOVERY_HOLD' });
    // This deliberately ambiguous processing fixture would otherwise be swept
    // by money.test when Vitest runs files in parallel.
    await db.execute(sql`
      SELECT public.shardkeep_finalize_withdrawal_allowance(${prepared!.id}::uuid)
    `);
    await db.update(withdrawals).set({
      status: 'sent', txSignature: `test-terminal-${prepared!.id}`, lastError: null,
    }).where(eq(withdrawals.id, prepared!.id));
  });

  it('rolls email consumption, hold state, and every cancellation back if escrow is inconsistent', async () => {
    const now = new Date('2026-09-02T03:00:00.000Z');
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    const recoveryId = randomUUID();
    const mail = mailbox();
    const [unbacked] = await db.insert(withdrawals).values({
      playerWallet: player.wallet, currency: 'KEEP', amount: 9_999_999n,
      destination: DEST, unbondsAt: new Date(now.getTime() + 86_400_000),
    }).returning();
    await startTotpRecovery(db, player.wallet, sid, recoveryId, mail.send, now);
    const emailCode = mail.code();

    await expect(confirmTotpRecovery(
      db, player.wallet, sid, recoveryId, emailCode, mail.send,
      new Date(now.getTime() + 1_000),
    )).rejects.toThrow();
    expect((await db.select().from(totpRecoveries).where(eq(totpRecoveries.id, recoveryId)))[0]?.status)
      .toBe('email_pending');
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, unbacked!.id)))[0]?.status)
      .toBe('unbonding');
    // The code consumption rolled back too: after removing the corrupt fixture,
    // the exact proof can still confirm once.
    await db.delete(withdrawals).where(eq(withdrawals.id, unbacked!.id));
    await expect(confirmTotpRecovery(
      db, player.wallet, sid, recoveryId, emailCode, mail.send,
      new Date(now.getTime() + 2_000),
    )).resolves.toMatchObject({ replay: false });
  });

  it('commits recovery-code failures and shared lockout instead of rolling guesses back', async () => {
    const now = new Date('2026-09-02T03:30:00.000Z');
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    const recoveryId = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, sid, recoveryId, mail.send, now);
    const wrongCode = mail.code() === '000000' ? '111111' : '000000';
    for (let i = 0; i < TWOFA.maxWithdrawAttempts; i++) {
      await expect(confirmTotpRecovery(
        db, player.wallet, sid, recoveryId, wrongCode, mail.send,
        new Date(now.getTime() + i + 1),
      )).rejects.toMatchObject({ statusCode: 422 });
    }
    const [locked] = await db.select({ until: players.twofaLockedUntil })
      .from(players).where(eq(players.wallet, player.wallet));
    expect(locked?.until).not.toBeNull();
    await expect(confirmTotpRecovery(
      db, player.wallet, sid, recoveryId, mail.code(), mail.send,
      new Date(now.getTime() + 10_000),
    )).rejects.toMatchObject({ statusCode: 429 });
  });

  it('freezes the original factor identity while recovery email confirmation is pending', async () => {
    const now = new Date('2026-09-02T03:45:00.000Z');
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    const recoveryId = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, sid, recoveryId, mail.send, now);
    const disableAt = new Date(now.getTime() + 31_000);
    await expect(disableTotp(
      db, player.wallet, codeFor(player.secret, disableAt), disableAt,
    )).rejects.toMatchObject({ statusCode: 423, code: 'TOTP_RECOVERY_PENDING' });
    expect((await getTotpRecoveryStatus(db, player.wallet, disableAt)).status).toBe('email_pending');
    expect((await db.select({ enabled: players.totpEnabled }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.enabled).toBe(true);
  });

  it('rechecks recovery after provider I/O before activating an email replacement', async () => {
    const now = new Date(Date.now() - 31_000);
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    let providerStarted!: () => void;
    let releaseProvider!: () => void;
    const entered = new Promise<void>((resolve) => { providerStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const delayed: EmailSender = async () => { providerStarted(); await gate; };
    const changeAt = new Date();
    const changing = startEmailEnroll(
      db, player.wallet, `replacement-${sequence}@pkw.testmail.dev`, delayed, changeAt,
      { method: 'totp', code: codeFor(player.secret, changeAt) },
    );
    await entered;

    const recoveryId = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, sid, recoveryId, mail.send, changeAt);
    releaseProvider();
    await expect(changing).rejects.toMatchObject({
      statusCode: 423, code: 'TOTP_RECOVERY_PENDING',
    });
    expect((await db.select({ pending: players.pendingEmail }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.pending).toBeNull();
  });

  it('binds both email phases to recovery and session, then latches re-enrollment after completion', async () => {
    const now = new Date('2026-09-02T04:00:00.000Z');
    const player = await securedPlayer(now);
    const startSession = await session(player.wallet);
    const wrongSession = await session(player.wallet);
    const recoveryId = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, startSession, recoveryId, mail.send, now);
    await expect(confirmTotpRecovery(
      db, player.wallet, wrongSession, recoveryId, mail.code(), mail.send,
      new Date(now.getTime() + 1_000),
    )).rejects.toMatchObject({ statusCode: 409 });
    await confirmTotpRecovery(
      db, player.wallet, startSession, recoveryId, mail.code(), mail.send,
      new Date(now.getTime() + 2_000),
    );

    const ready = new Date(now.getTime() + TWOFA.recoveryHoldHours * 3_600_000 + 3_000);
    const completionSession = await session(player.wallet);
    await sendTotpRecoveryCompletionCode(
      db, player.wallet, completionSession, recoveryId, mail.send, ready,
    );
    const firstCompletionCode = mail.code();
    const otherCompletionSession = await session(player.wallet);
    const later = new Date(ready.getTime() + TWOFA.emailResendCooldownSec * 1_000 + 1);
    await expect(completeTotpRecovery(
      db, player.wallet, otherCompletionSession, recoveryId, firstCompletionCode, mail.send, later,
    )).rejects.toMatchObject({ statusCode: 422 });
    expect((await db.select({ attempts: players.twofaFailedAttempts }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.attempts).toBe(0);
    const foreignMail = mailbox();
    await sendTotpRecoveryCompletionCode(
      db, player.wallet, otherCompletionSession, recoveryId, foreignMail.send, later,
    );
    // The newer foreign-session code neither shadows nor burns the older exact
    // proof. The original session can still complete with its own code.
    await completeTotpRecovery(
      db, player.wallet, completionSession, recoveryId, firstCompletionCode, mail.send, later,
    );
    const status = await getTotpRecoveryStatus(db, player.wallet, later);
    expect(status).toMatchObject({ status: 'completed', reenrollmentRequired: true });
    expect((await db.select().from(sessions).where(and(
      eq(sessions.wallet, player.wallet), eq(sessions.id, completionSession),
    )))[0]?.revokedAt).not.toBeNull();
    await expect(assertTotpRecoveryAllows(db, player.wallet, 'key_export', ready))
      .rejects.toMatchObject({ code: 'TOTP_REENROLLMENT_REQUIRED' });

    const reenrollSession = await session(player.wallet);
    const reenrollAt = new Date(ready.getTime() + 31_000);
    await sendFactorStepUpEmailCode(
      db, player.wallet, mail.send, reenrollSession, reenrollAt,
    );
    vi.useFakeTimers({ now: reenrollAt, toFake: ['Date'] });
    const replacement = await enrollTotp(
      db, player.wallet, { method: 'email', code: mail.code() },
      factorChangeEmailChallengeContext(reenrollSession),
    ).finally(() => vi.useRealTimers());
    const verifyAt = new Date(reenrollAt.getTime() + 31_000);
    await verifyTotpEnroll(db, player.wallet, codeFor(replacement.secret, verifyAt), verifyAt);
    expect((await getTotpRecoveryStatus(db, player.wallet, verifyAt)).reenrollmentRequired).toBe(false);
    await expect(completeTotpRecovery(
      db, player.wallet, completionSession, recoveryId, 'replay-after-reenroll', mail.send, verifyAt,
    )).resolves.toMatchObject({
      transitioned: false,
      status: { reenrollmentRequired: false },
    });
    await expect(assertTotpRecoveryAllows(db, player.wallet, 'withdrawal', verifyAt))
      .resolves.toBeUndefined();
  });

  it('lets the current authenticator cancel a hold without resurrecting refunded withdrawals', async () => {
    const now = new Date('2026-09-02T05:00:00.000Z');
    const player = await securedPlayer(now);
    const sid = await session(player.wallet);
    const withdrawal = await requestWithdrawal(db, player.wallet, 4_000n, DEST, key(), { now });
    const recoveryId = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, sid, recoveryId, mail.send, now);
    await confirmTotpRecovery(
      db, player.wallet, sid, recoveryId, mail.code(), mail.send,
      new Date(now.getTime() + 1_000),
    );
    const cancelAt = new Date(now.getTime() + 31_000);
    const validCancelCode = codeFor(player.secret, cancelAt);
    const wrongCancelCode = validCancelCode === '000000' ? '111111' : '000000';
    await expect(cancelTotpRecovery(
      db, player.wallet, recoveryId, wrongCancelCode, mail.send, cancelAt,
    )).rejects.toMatchObject({ statusCode: 422 });
    expect((await db.select({ attempts: players.twofaFailedAttempts }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.attempts).toBe(1);
    await cancelTotpRecovery(
      db, player.wallet, recoveryId, validCancelCode, mail.send, cancelAt,
    );
    expect((await getTotpRecoveryStatus(db, player.wallet, cancelAt)).status).toBe('cancelled');
    expect((await db.select().from(withdrawals).where(eq(withdrawals.id, withdrawal.id)))[0]?.status)
      .toBe('cancelled');
    await expect(assertTotpRecoveryAllows(db, player.wallet, 'withdrawal', cancelAt)).resolves.toBeUndefined();
  });

  it('enforces exact hold/expiry boundaries and preserves the old factor on expiry', async () => {
    const now = new Date('2026-09-02T06:00:00.000Z');
    const player = await securedPlayer(now, 0n);
    const sid = await session(player.wallet);
    const recoveryId = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, sid, recoveryId, mail.send, now);
    const confirmAt = new Date(now.getTime() + 1_000);
    const confirmed = await confirmTotpRecovery(
      db, player.wallet, sid, recoveryId, mail.code(), mail.send, confirmAt,
    );
    const readyAt = new Date(confirmed.status.readyAt!);
    await expect(sendTotpRecoveryCompletionCode(
      db, player.wallet, await session(player.wallet), recoveryId, mail.send,
      new Date(readyAt.getTime() - 1),
    )).rejects.toMatchObject({ statusCode: 423, code: 'TOTP_RECOVERY_HOLD' });

    const expiresAt = new Date(confirmed.status.expiresAt!);
    expect((await getTotpRecoveryStatus(db, player.wallet, expiresAt)).status).toBe('expired');
    expect((await db.select({ enabled: players.totpEnabled }).from(players)
      .where(eq(players.wallet, player.wallet)))[0]?.enabled).toBe(true);
    const expiryNotice = (await db.select().from(outbox).where(and(
      eq(outbox.kind, 'totp_recovery_notice'),
      sql`${outbox.payload}->>'recoveryId' = ${recoveryId}`,
    ))).find((row) => (row.payload as { event?: string }).event === 'expired');
    expect((expiryNotice?.payload as { body?: string }).body).toContain('expired after 7 days');
  });

  it('allows completion exactly at readyAt, then reports authoritative replay state', async () => {
    const now = new Date('2026-09-02T07:00:00.000Z');
    const player = await securedPlayer(now, 0n);
    const startSession = await session(player.wallet);
    const recoveryId = randomUUID();
    const mail = mailbox();
    await startTotpRecovery(db, player.wallet, startSession, recoveryId, mail.send, now);
    const confirmed = await confirmTotpRecovery(
      db, player.wallet, startSession, recoveryId, mail.code(), mail.send,
      new Date(now.getTime() + 1_000),
    );
    const readyAt = new Date(confirmed.status.readyAt!);
    const completionSession = await session(player.wallet);
    await sendTotpRecoveryCompletionCode(
      db, player.wallet, completionSession, recoveryId, mail.send, readyAt,
    );
    const first = await completeTotpRecovery(
      db, player.wallet, completionSession, recoveryId, mail.code(), mail.send, readyAt,
    );
    expect(first).toMatchObject({ transitioned: true, status: { reenrollmentRequired: true } });
    const replay = await completeTotpRecovery(
      db, player.wallet, completionSession, recoveryId, 'ignored-on-replay', mail.send,
      new Date(readyAt.getTime() + 1),
    );
    expect(replay).toMatchObject({ transitioned: false, status: { reenrollmentRequired: true } });
  });

  it('leases durable security alerts so failures retry and concurrent drainers send once', async () => {
    const now = new Date();
    const recoveryId = randomUUID();
    await db.transaction((tx) => enqueueTotpRecoveryNoticeTx(tx, {
      recoveryId,
      event: 'holding',
      to: 'security@pkw.testmail.dev',
      subject: 'Recovery hold',
      body: 'A recovery hold started.',
    }, now));
    const failed = await drainTotpRecoveryNotices(
      db, async () => { throw new Error('provider down'); }, now, recoveryId,
    );
    expect(failed).toEqual({ sent: 0, failed: 1 });
    expect((await db.select().from(outbox).where(and(
      eq(outbox.kind, 'totp_recovery_notice'),
      sql`${outbox.payload}->>'recoveryId' = ${recoveryId}`,
    )))[0]).toMatchObject({ status: 'failed', attempts: 1 });

    await db.transaction((tx) => enqueueTotpRecoveryNoticeTx(tx, {
      recoveryId,
      event: 'cancelled',
      to: 'security@pkw.testmail.dev',
      subject: 'Recovery cancelled',
      body: 'The recovery was cancelled.',
    }, new Date(now.getTime() + 1)));
    // A later notice cannot overtake the backed-off hold warning.
    expect(await drainTotpRecoveryNotices(
      db, async () => { throw new Error('must not send'); }, new Date(now.getTime() + 2), recoveryId,
    )).toEqual({ sent: 0, failed: 0 });

    let deliveries = 0;
    const retryAt = new Date(now.getTime() + 31_000);
    const sender: EmailSender = async () => {
      deliveries++;
      await new Promise((resolve) => setTimeout(resolve, 20));
    };
    const drained = await Promise.all([
      drainTotpRecoveryNotices(db, sender, retryAt, recoveryId),
      drainTotpRecoveryNotices(db, sender, retryAt, recoveryId),
    ]);
    expect(drained.reduce((sum, row) => sum + row.sent, 0)).toBe(2);
    expect(deliveries).toBe(2);
    expect((await db.select().from(outbox).where(and(
      eq(outbox.kind, 'totp_recovery_notice'),
      sql`${outbox.payload}->>'recoveryId' = ${recoveryId}`,
    ))).every((row) => row.status === 'sent')).toBe(true);
  });
});
