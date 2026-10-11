/**
 * Withdrawal 2FA + instant payout (owner 2026-07-19). Covers the security-
 * critical behaviour: TOTP enroll only enables on a correct code; email codes
 * are single-use, attempt-capped, purpose-scoped, and cooldown-limited; and an
 * instant (2FA-verified) withdrawal settles synchronously via the sender, is due
 * immediately, and a failed send retains the escrow (never silently loses funds).
 */
import { ECONOMY, TWOFA } from '@shardkeep/shared';
import { Keypair } from '@solana/web3.js';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Secret, TOTP } from 'otpauth';
import { ensureStartingBase } from '../src/game/base';
import { rewardShards } from '../src/game/spend';
import {
  checkTotp, consoleEmailSender, disableTotp, enrollTotp, get2faStatus,
  factorChangeEmailChallengeContext, rewrapTotpSecrets, sendFactorStepUpEmailCode,
  sendWithdrawEmailCode, startEmailEnroll, verifyEmailEnroll, verifyTotpEnroll, verifyWithdrawal2fa,
  verifyInstantWithdrawalTotp,
  type EmailSender,
} from '../src/auth/twofa';
import { cancelWithdrawal, requestWithdrawal } from '../src/money/withdrawals';
import type { ReserveReader } from '../src/money/snapshot';
import { currentKeepMint } from '../src/money/mintDimension';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import { connectTestDb, createTestPlayer, fundTestKeep } from './helpers';
import { emailOtps, players, withdrawalAuthorizations } from '../src/db/schema';
import { makeResendEmailSender } from '../src/lib/resend';
import { makeTestKeepSender } from './withdrawalSender';

const conn = connectTestDb();
const db = conn.db;
/** A real on-curve wallet — a valid withdrawal destination. */
const DEST = Keypair.generate().publicKey.toBase58();
const FACTOR_SESSION = 'test-factor-session';
let key = 0;
const k = (): string => `2fa-${++key}-${Math.random().toString(36).slice(2)}`;

async function fundedPlayer(keep = 50_000n) {
  const p = await createTestPlayer(db);
  await ensureStartingBase(db, p.wallet);
  if (keep > 0n) await fundTestKeep(db, p.wallet, keep, 'test.fund', k());
  if (keep > 0n) await rewardShards(db, p.wallet, keep, 'test.fund.shards', k());
  return p;
}
const balance = async (w: string) => (await getOrCreatePlayerAccount(db, w, 'player_keep')).balance;

/** Sender stub that captures the 6-digit code out of the email body. */
function captureSender(): { send: EmailSender; last: () => string } {
  let last: string | null = null;
  const send: EmailSender = async (_to, _subject, body) => {
    last = body.match(/\b(\d{6})\b/)?.[1] ?? null;
  };
  return { send, last: () => { if (!last) throw new Error('no code captured'); return last; } };
}

const totpCode = (secret: string, timestamp = Date.now()): string =>
  new TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: Secret.fromBase32(secret) }).generate({ timestamp });
const LEGACY_MATURE_AT = new Date(0);
const matureTotp = (wallet: string) => db.update(players)
  .set({
    totpEnabledAt: LEGACY_MATURE_AT,
    // A truly mature enrollment's enrollment proof is thousands of steps old.
    totpLastUsedStep: BigInt(Math.floor(Date.now() / 1000 / 30) - 1),
  }).where(eq(players.wallet, wallet));

beforeAll(async () => { await bootstrapSystemAccounts(db); });
afterAll(async () => { await conn.sql.end(); });

describe('2FA — TOTP authenticator', () => {
  it('enroll does not enable until a correct code is verified', async () => {
    const p = await fundedPlayer(0n);
    const { secret, otpauthUrl, qrDataUri } = await enrollTotp(db, p.wallet);
    expect(otpauthUrl).toContain('otpauth://totp/');
    expect(qrDataUri).toContain('data:image/');
    expect((await get2faStatus(db, p.wallet)).totpEnabled).toBe(false);
    expect(await checkTotp(db, p.wallet, totpCode(secret))).toBe(false); // not enabled yet
    await verifyTotpEnroll(db, p.wallet, totpCode(secret));
    const st = await get2faStatus(db, p.wallet);
    expect(st.totpEnabled).toBe(true);
    expect(st.totpReady).toBe(false);
    expect(st.instantEligible).toBe(false);
    expect(st.totpReadyAt).not.toBeNull();
    expect(await checkTotp(db, p.wallet, totpCode(secret))).toBe(true);
  });

  it('never stores the authenticator seed in plaintext', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    const [row] = await db.select({ stored: players.totpSecret }).from(players)
      .where(eq(players.wallet, p.wallet));
    expect(row?.stored).toMatch(/^g2\.test-v1\./);
    expect(row?.stored).not.toContain(secret);
    await verifyTotpEnroll(db, p.wallet, totpCode(secret));
  });

  it('dual-reads a legacy plaintext seed and safely rewraps it in place', async () => {
    const p = await fundedPlayer(0n);
    const secret = new Secret({ size: 20 }).base32;
    await db.update(players).set({ totpSecret: secret, totpEnabled: true, totpEnabledAt: LEGACY_MATURE_AT })
      .where(eq(players.wallet, p.wallet));
    expect(await checkTotp(db, p.wallet, totpCode(secret))).toBe(true);
    const [row] = await db.select({ stored: players.totpSecret }).from(players)
      .where(eq(players.wallet, p.wallet));
    expect(row?.stored).toMatch(/^g2\.test-v1\./);
  });

  it('binds the encrypted seed to its wallet as authenticated data', async () => {
    const owner = await fundedPlayer(0n);
    const other = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, owner.wallet);
    const [row] = await db.select({ stored: players.totpSecret }).from(players)
      .where(eq(players.wallet, owner.wallet));
    await db.update(players).set({ totpSecret: row!.stored, totpEnabled: true, totpEnabledAt: LEGACY_MATURE_AT })
      .where(eq(players.wallet, other.wallet));
    try {
      await expect(checkTotp(db, other.wallet, totpCode(secret))).rejects.toThrow(/decrypt/i);
    } finally {
      await db.update(players).set({ totpSecret: null, totpEnabled: false, totpEnabledAt: null })
        .where(eq(players.wallet, other.wallet));
    }
  });

  it('reads an older key id and lazily rotates the envelope to the first key', async () => {
    const previous = process.env['TWOFA_ENCRYPTION_KEYS'];
    const old = 'old:BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=';
    const fresh = 'fresh:CAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAg=';
    let cleanup: { wallet: string } | undefined;
    try {
      process.env['TWOFA_ENCRYPTION_KEYS'] = old;
      const p = await fundedPlayer(0n);
      cleanup = p;
      const { secret } = await enrollTotp(db, p.wallet);
      await verifyTotpEnroll(db, p.wallet, totpCode(secret));
      process.env['TWOFA_ENCRYPTION_KEYS'] = `${fresh},${old}`;
      expect(await checkTotp(db, p.wallet, totpCode(secret))).toBe(true);
      const [row] = await db.select({ stored: players.totpSecret }).from(players)
        .where(eq(players.wallet, p.wallet));
      expect(row?.stored).toMatch(/^g2\.fresh\./);
    } finally {
      if (cleanup) await db.update(players).set({ totpSecret: null, totpEnabled: false, totpEnabledAt: null })
        .where(eq(players.wallet, cleanup.wallet));
      if (previous) process.env['TWOFA_ENCRYPTION_KEYS'] = previous;
      else delete process.env['TWOFA_ENCRYPTION_KEYS'];
    }
  });

  it('ops backfill dry-runs and CAS-rewraps dormant plaintext seeds in bounded batches', async () => {
    const p = await fundedPlayer(0n);
    const secret = new Secret({ size: 20 }).base32;
    await db.update(players).set({ totpSecret: secret, totpEnabled: true, totpEnabledAt: LEGACY_MATURE_AT })
      .where(eq(players.wallet, p.wallet));
    const dry = await rewrapTotpSecrets(db, { apply: false, batchSize: 1 });
    expect(dry.needsRewrap).toBeGreaterThanOrEqual(1);
    expect(dry.rewrapped).toBe(0);
    const applied = await rewrapTotpSecrets(db, { apply: true, batchSize: 2 });
    expect(applied.rewrapped).toBeGreaterThanOrEqual(1);
    expect((await rewrapTotpSecrets(db, { apply: false })).needsRewrap).toBe(0);
  });

  it('rejects a wrong enrollment code and stays disabled', async () => {
    const p = await fundedPlayer(0n);
    await enrollTotp(db, p.wallet);
    await expect(verifyTotpEnroll(db, p.wallet, '000000')).rejects.toThrow(/invalid/i);
    expect((await get2faStatus(db, p.wallet)).totpEnabled).toBe(false);
  });

  it('disable requires a valid code', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    // Enrollment consumes its accepted step, so use the adjacent accepted step
    // and leave the current code as a distinct proof for disable.
    await verifyTotpEnroll(db, p.wallet, totpCode(secret, Date.now() - 30_000));
    await expect(disableTotp(db, p.wallet, '000000')).rejects.toThrow(/invalid/i);
    await disableTotp(db, p.wallet, totpCode(secret));
    expect(await get2faStatus(db, p.wallet)).toMatchObject({
      totpEnabled: false, totpReady: false, totpReadyAt: null, instantEligible: false,
    });
    const replacement = await enrollTotp(db, p.wallet);
    await verifyTotpEnroll(db, p.wallet, totpCode(replacement.secret));
    expect(await get2faStatus(db, p.wallet)).toMatchObject({
      totpEnabled: true, totpReady: false, instantEligible: false,
    });
  });

  it('cannot replay a TOTP consumed by instant custody to disable the authenticator', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    await verifyTotpEnroll(db, p.wallet, totpCode(secret, Date.now() - 30_000));
    await matureTotp(p.wallet);
    const code = totpCode(secret);
    expect(await verifyInstantWithdrawalTotp(db, p.wallet, code)).toBe(true);
    await expect(disableTotp(db, p.wallet, code)).rejects.toThrow(/invalid authenticator code/i);
    expect((await get2faStatus(db, p.wallet)).totpEnabled).toBe(true);
  });

  it('withdrawal TOTP is single-use — the same code cannot authorize twice (replay)', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    await verifyTotpEnroll(db, p.wallet, totpCode(secret));
    await matureTotp(p.wallet);
    const code = totpCode(secret);
    expect(await verifyInstantWithdrawalTotp(db, p.wallet, code)).toBe(true);
    expect(await verifyInstantWithdrawalTotp(db, p.wallet, code)).toBe(false); // replay rejected
  });

  it('records the same TOTP step it validated when a request crosses a 30-second boundary', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    const boundary = 1_800_000_000_000;
    const capturedBeforeBoundary = new Date(boundary - 1);
    const beforeStep = BigInt(Math.floor(capturedBeforeBoundary.getTime() / 1000 / 30));
    await db.update(players).set({
      totpEnabled: true,
      totpEnabledAt: LEGACY_MATURE_AT,
      totpLastUsedStep: beforeStep - 1n,
    }).where(eq(players.wallet, p.wallet));

    const code = totpCode(secret, capturedBeforeBoundary.getTime());
    const clock = vi.spyOn(Date, 'now').mockReturnValue(boundary + 1);
    try {
      expect(await verifyInstantWithdrawalTotp(db, p.wallet, code, capturedBeforeBoundary)).toBe(true);
      expect(await verifyInstantWithdrawalTotp(db, p.wallet, code, new Date(boundary + 1))).toBe(false);
    } finally {
      clock.mockRestore();
    }
  });

  it('locks the account after too many failed withdrawal-2FA attempts', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    await verifyTotpEnroll(db, p.wallet, totpCode(secret));
    await matureTotp(p.wallet);
    for (let i = 0; i < TWOFA.maxWithdrawAttempts; i++) {
      expect(await verifyInstantWithdrawalTotp(db, p.wallet, '000000')).toBe(false);
    }
    // now locked — even a correct code is refused with a lockout error
    await expect(verifyInstantWithdrawalTotp(db, p.wallet, totpCode(secret))).rejects.toThrow(/too many/i);
  });

  it('holds a new authenticator for the normal unbonding window, then accepts it at the exact boundary', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    const now = new Date();
    await verifyTotpEnroll(db, p.wallet, totpCode(secret, now.getTime()), now);
    const holdMs = ECONOMY.unbondingHours * 3_600_000;
    await db.update(players).set({
      totpEnabledAt: new Date(now.getTime() - holdMs),
      totpLastUsedStep: BigInt(Math.floor(now.getTime() / 1000 / 30) - 1),
    }).where(eq(players.wallet, p.wallet));
    await expect(verifyInstantWithdrawalTotp(
      db, p.wallet, totpCode(secret, now.getTime()),
      new Date(now.getTime() - 1),
    )).rejects.toThrow(/still maturing/i);
    expect(await verifyInstantWithdrawalTotp(
      db, p.wallet, totpCode(secret, now.getTime()), now,
    )).toBe(true);
  });

  it('migration backfills legacy enabled authenticators as mature', async () => {
    const sql = await readFile(new URL('../drizzle/0061_high_pandemic.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/SET "totp_enabled_at" = TIMESTAMPTZ '1970-01-01 00:00:00\+00'/);
    expect(sql).toMatch(/WHERE "totp_enabled" = true/);
    const p = await fundedPlayer(0n);
    const secret = new Secret({ size: 20 }).base32;
    await db.update(players).set({
      totpSecret: secret, totpEnabled: true, totpEnabledAt: LEGACY_MATURE_AT,
    }).where(eq(players.wallet, p.wallet));
    expect((await get2faStatus(db, p.wallet)).instantEligible).toBe(true);
  });
});

describe('2FA — email codes', () => {
  it('never reports delivery through the non-development fallback sender', async () => {
    await expect(consoleEmailSender('x@example.com', 'code', 'secret code'))
      .rejects.toThrow(/not configured/i);
  });

  it('verifies the email; normalizes + masks it; code is single-use', async () => {
    const p = await fundedPlayer(0n);
    const cap = captureSender();
    await startEmailEnroll(db, p.wallet, '  Player@PixelKingdomWars.COM ', cap.send);
    const code = cap.last();
    expect(code).toMatch(/^\d{6}$/);
    await verifyEmailEnroll(db, p.wallet, code);
    const st = await get2faStatus(db, p.wallet);
    expect(st.emailVerified).toBe(true);
    expect(st.email).toContain('@pixelkingdomwars.com'); // normalized lowercase, masked local part
    expect(st.instantEligible).toBe(false); // contact email is never a custody factor
    await expect(verifyEmailEnroll(db, p.wallet, code)).rejects.toThrow(/invalid|expired/i); // consumed
  });

  it('rejects reserved non-deliverable domains before reserving, sending, or changing email state', async () => {
    const p = await fundedPlayer(0n);
    await db.update(players).set({
      email: 'admin-owner@pixelkingdomwars.com',
      emailVerified: true,
      pendingEmail: 'pending-owner@pixelkingdomwars.com',
    }).where(eq(players.wallet, p.wallet));
    const send = vi.fn(async () => undefined);
    const beforeReservations = await db.select({ id: emailOtps.id }).from(emailOtps)
      .where(eq(emailOtps.playerWallet, p.wallet));

    for (const address of [
      'admin@example.com',
      'admin@sub.example.net',
      'admin@EXAMPLE.ORG.',
      'admin@mail.example',
      'admin@mail.invalid',
      'admin@mail.test',
      'admin@mail.localhost',
    ]) {
      await expect(startEmailEnroll(db, p.wallet, address, send)).rejects.toMatchObject({
        statusCode: 422,
        message: 'use a deliverable email address — reserved example/test domains cannot receive codes',
      });
    }

    const [after] = await db.select({
      email: players.email,
      emailVerified: players.emailVerified,
      pendingEmail: players.pendingEmail,
    }).from(players).where(eq(players.wallet, p.wallet));
    expect(after).toEqual({
      email: 'admin-owner@pixelkingdomwars.com',
      emailVerified: true,
      pendingEmail: 'pending-owner@pixelkingdomwars.com',
    });
    expect(await db.select({ id: emailOtps.id }).from(emailOtps)
      .where(eq(emailOtps.playerWallet, p.wallet))).toEqual(beforeReservations);
    expect(send).not.toHaveBeenCalled();
  });

  it('changing contact email never shortens an already-mature TOTP hold', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    await verifyTotpEnroll(db, p.wallet, totpCode(secret));
    await matureTotp(p.wallet);
    const before = (await db.select({ at: players.totpEnabledAt }).from(players)
      .where(eq(players.wallet, p.wallet)))[0]!.at;
    const cap = captureSender();
    await startEmailEnroll(
      db, p.wallet, 'contact@pixelkingdomwars.com', cap.send, undefined,
      { method: 'totp', code: totpCode(secret) },
    );
    await verifyEmailEnroll(db, p.wallet, cap.last());
    const after = (await db.select({ at: players.totpEnabledAt }).from(players)
      .where(eq(players.wallet, p.wallet)))[0]!.at;
    expect(after).toEqual(before);
    expect((await get2faStatus(db, p.wallet)).instantEligible).toBe(true);
  });

  it('stores a keyed HMAC bound to the exact recipient, never a public digest', async () => {
    const p = await fundedPlayer(0n);
    const cap = captureSender();
    await startEmailEnroll(db, p.wallet, 'bound@pixelkingdomwars.com', cap.send);
    const [row] = await db.select().from(emailOtps)
      .where(eq(emailOtps.playerWallet, p.wallet));
    expect(row?.codeHash).toMatch(/^h1\.test-v1\./);
    expect(row?.codeHash).not.toContain(cap.last());
    expect(row?.targetEmail).toBe('bound@pixelkingdomwars.com');
    expect(row?.challengeContext).toMatch(/^c1\.test-v1\./);
    expect(row?.deliveredAt).toBeInstanceOf(Date);
  });

  it('keeps the verified address active until its delivered replacement is promoted', async () => {
    const p = await fundedPlayer(0n);
    const delivered: Array<{ to: string; code: string }> = [];
    const send: EmailSender = async (to, _subject, body) => {
      delivered.push({ to, code: body.match(/\b(\d{6})\b/)![1]! });
    };
    await startEmailEnroll(db, p.wallet, 'old@pixelkingdomwars.com', send);
    await verifyEmailEnroll(db, p.wallet, delivered.at(-1)!.code);
    await sendFactorStepUpEmailCode(db, p.wallet, send, FACTOR_SESSION);
    const stepUp = delivered.at(-1)!.code;
    const afterEnrollCooldown = new Date(Date.now() + TWOFA.emailResendCooldownSec * 1000 + 1_000);
    await startEmailEnroll(
      db, p.wallet, 'new@pixelkingdomwars.com', send, afterEnrollCooldown,
      { method: 'email', code: stepUp }, factorChangeEmailChallengeContext(FACTOR_SESSION),
    );

    const [pending] = await db.select({
      email: players.email, verified: players.emailVerified, pending: players.pendingEmail,
    }).from(players).where(eq(players.wallet, p.wallet));
    expect(pending).toMatchObject({
      email: 'old@pixelkingdomwars.com', verified: true, pending: 'new@pixelkingdomwars.com',
    });
    expect(await get2faStatus(db, p.wallet)).toMatchObject({
      email: 'ol*@pixelkingdomwars.com', pendingEmail: 'ne*@pixelkingdomwars.com', emailVerified: true,
    });

    await verifyEmailEnroll(db, p.wallet, delivered.at(-1)!.code);
    const [promoted] = await db.select({
      email: players.email, verified: players.emailVerified, pending: players.pendingEmail,
    }).from(players).where(eq(players.wallet, p.wallet));
    expect(promoted).toMatchObject({ email: 'new@pixelkingdomwars.com', verified: true, pending: null });
    expect(await get2faStatus(db, p.wallet)).toMatchObject({
      email: 'ne*@pixelkingdomwars.com', pendingEmail: null, emailVerified: true,
    });
  });

  it('labels factor-change mail as account security, never as a withdrawal', async () => {
    const p = await fundedPlayer(0n);
    const delivered: Array<{ subject: string; body: string }> = [];
    const send: EmailSender = async (_to, subject, body) => {
      delivered.push({ subject, body });
    };
    await startEmailEnroll(db, p.wallet, 'security-copy@pixelkingdomwars.com', send);
    const enrollCode = delivered.at(-1)!.body.match(/\b(\d{6})\b/)![1]!;
    await verifyEmailEnroll(db, p.wallet, enrollCode);

    await sendFactorStepUpEmailCode(db, p.wallet, send, FACTOR_SESSION);
    const message = delivered.at(-1)!;
    const code = message.body.match(/\b(\d{6})\b/)![1]!;
    const mins = Math.round(TWOFA.emailCodeTtlSec / 60);
    expect(message).toEqual({
      subject: 'Confirm your Pixel Kingdom Wars account security change',
      body: `Your Pixel Kingdom Wars account security confirmation code is ${code}. It expires in ${mins} minutes. This code cannot authorize a withdrawal.`,
    });
  });

  it('rolls back pending state and cooldown when the provider rejects delivery', async () => {
    const p = await fundedPlayer(0n);
    const failed: EmailSender = async () => { throw new Error('provider unavailable'); };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await expect(startEmailEnroll(db, p.wallet, 'retry@pixelkingdomwars.com', failed)).rejects.toMatchObject({
        statusCode: 503,
        code: 'EMAIL_DELIVERY_UNAVAILABLE',
        message: 'email delivery is unavailable — try again shortly',
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('provider unavailable'));
    } finally {
      log.mockRestore();
    }
    const [afterFailure] = await db.select({
      email: players.email, verified: players.emailVerified, pending: players.pendingEmail,
    }).from(players).where(eq(players.wallet, p.wallet));
    expect(afterFailure).toMatchObject({ email: null, verified: false, pending: null });

    // Same instant, same purpose: this would 429 if the failed send had committed
    // an unusable row/cooldown.
    const cap = captureSender();
    await expect(startEmailEnroll(db, p.wallet, 'retry@pixelkingdomwars.com', cap.send)).resolves.toBeDefined();
  });

  it('reserves cooldown without holding a DB transaction during a slow provider call', async () => {
    const p = await fundedPlayer(0n);
    let release!: () => void;
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const providerRelease = new Promise<void>((resolve) => { release = resolve; });
    const slow: EmailSender = async () => { entered(); await providerRelease; };
    const first = startEmailEnroll(db, p.wallet, 'slow@pixelkingdomwars.com', slow);
    await providerEntered;
    // If the network await still held the player-row transaction, this call
    // would block instead of promptly observing the committed reservation.
    await expect(startEmailEnroll(db, p.wallet, 'other@pixelkingdomwars.com', captureSender().send))
      .rejects.toThrow(/wait/i);
    release();
    await expect(first).resolves.toBeDefined();
  });

  it('binds a withdrawal email code to the exact server-supplied intent', async () => {
    const p = await fundedPlayer(0n);
    const cap = captureSender();
    await startEmailEnroll(db, p.wallet, 'intent@pixelkingdomwars.com', cap.send);
    await verifyEmailEnroll(db, p.wallet, cap.last());
    await sendWithdrawEmailCode(
      db, p.wallet, cap.send, new Date(), 'intent:a', 'account_security_change',
    );
    const code = cap.last();
    expect(await verifyWithdrawal2fa(db, p.wallet, 'email', code, new Date(), 'intent:b')).toBe(false);
    expect(await verifyWithdrawal2fa(db, p.wallet, 'email', code, new Date(), 'intent:a')).toBe(true);
  });

  it('withdraw email code authorizes once, then is single-use consumed', async () => {
    const p = await fundedPlayer(0n);
    const cap = captureSender();
    await startEmailEnroll(db, p.wallet, 'x@y.zz', cap.send);
    await verifyEmailEnroll(db, p.wallet, cap.last());
    await sendWithdrawEmailCode(
      db, p.wallet, cap.send, new Date(), 'test-withdrawal', 'account_security_change',
    );
    const code = cap.last();
    expect(await verifyWithdrawal2fa(db, p.wallet, 'email', code, new Date(), 'test-withdrawal')).toBe(true);
    expect(await verifyWithdrawal2fa(db, p.wallet, 'email', code, new Date(), 'test-withdrawal')).toBe(false); // consumed
  });

  it('rejects an unverified email and rate-limits resends', async () => {
    const p = await fundedPlayer(0n);
    const cap = captureSender();
    await expect(sendWithdrawEmailCode(
      db, p.wallet, cap.send, new Date(), 'test-withdrawal', 'account_security_change',
    ))
      .rejects.toThrow(/verify an email/i);
    await startEmailEnroll(db, p.wallet, 'a@b.cc', cap.send);
    await expect(startEmailEnroll(db, p.wallet, 'a@b.cc', cap.send)).rejects.toThrow(/wait/i);
  });
});

describe('Resend transport', () => {
  it('always sends the canonical plain-text part with a bounded request', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        from: 'Pixel Kingdom Wars <noreply@example.com>',
        to: 'player@example.com',
        subject: 'Security code',
        text: 'Plain body',
      });
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    const send = makeResendEmailSender('re_test', 'Pixel Kingdom Wars <noreply@example.com>', fetchImpl);
    await expect(send('player@example.com', 'Security code', 'Plain body')).resolves.toBeUndefined();
  });

  it('throws on provider rejection so callers cannot report sent', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 503, statusText: 'Service Unavailable',
    })) as unknown as typeof fetch;
    const send = makeResendEmailSender('re_test', 'noreply@example.com', fetchImpl);
    await expect(send('player@example.com', 'Security code', 'Plain body'))
      .rejects.toThrow('resend: 503 Service Unavailable');
  });
});

describe('instant (2FA) withdrawal payout', () => {
  // The instant path is RESERVE-GATED like the worker (AUDIT-FIX-PLAN B1): a 2FA
  // code buys you out of the unbonding wait, not out of the solvency check. These
  // tests are about the 2FA settlement, so they pin the gate open; the gate's own
  // behaviour (including that instant halts to 'unbonding') lives in money.test.ts.
  const COVERED: ReserveReader = async () => 10n ** 15n;
  // These direct unit calls bypass the HTTP proof route. Pin the independent
  // worker-verification seam open so the tests remain specifically about
  // synchronous instant settlement; route tests cover real wallet proofs.
  const AUTHORIZED: NonNullable<Parameters<typeof requestWithdrawal>[5]>['authorizationGate'] = async (w) => {
    const digest = createHash('sha256').update(`twofa-direct-test:${w.id}`).digest('hex');
    await db.insert(withdrawalAuthorizations).values({
      withdrawalId: w.id,
      challengeToken: 'twofa-direct-test-authorization-token',
      walletSignature: '2'.repeat(88),
      cluster: 'devnet',
      keepMint: currentKeepMint()!,
    });
    await db.update(withdrawalAuthorizations).set({
      validatedDigest: digest,
      validatedAt: new Date(),
    }).where(eq(withdrawalAuthorizations.withdrawalId, w.id));
    return { ok: true, digest, cluster: 'devnet', keepMint: currentKeepMint()! };
  };

  it('settles synchronously via the sender, due immediately', async () => {
    const p = await fundedPlayer(10_000n);
    const before = await balance(p.wallet);
    const sent: Array<{ dest: string; amount: bigint }> = [];
    const send = makeTestKeepSender({ broadcast: async (prepared) => {
      sent.push({
        dest: prepared.transfer.destinationOwner,
        amount: BigInt(prepared.transfer.amountKeep),
      });
      return prepared.signature;
    } });
    const row = await requestWithdrawal(db, p.wallet, 5_000n, DEST, k(), {
      instant: true, send, readReserve: COVERED, authorizationGate: AUTHORIZED,
    });
    expect(row.status).toBe('sent');
    expect(row.txSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
    expect(new Date(row.unbondsAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const fee = (5_000n * BigInt(ECONOMY.withdrawFeeBps)) / 10_000n;
    expect(sent[0]!.amount).toBe(5_000n - fee); // net paid on-chain
    expect(await balance(p.wallet)).toBe(before - 5_000n); // gross left the play balance
  });

  it('without a sender, instant is due immediately but stays queued', async () => {
    const p = await fundedPlayer(10_000n);
    const row = await requestWithdrawal(db, p.wallet, 1_000n, DEST, k(), { instant: true });
    expect(row.status).toBe('unbonding');
    expect(new Date(row.unbondsAt).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    // Clean up: this row is 'unbonding' AND immediately due, so leaving it would
    // pollute another suite's global processDueWithdrawals count (shared test DB).
    await cancelWithdrawal(db, p.wallet, row.id);
  });

  it('a finalized-error instant transfer marks failed and retains escrow', async () => {
    const p = await fundedPlayer(10_000n);
    const before = await balance(p.wallet);
    const send = makeTestKeepSender({
      reconcile: async () => ({
        status: 'finalized_error', source: 'test-primary', error: 'InstructionError',
      }),
    });
    const row = await requestWithdrawal(db, p.wallet, 2_000n, DEST, k(), {
      instant: true, send, readReserve: COVERED, authorizationGate: AUTHORIZED,
    });
    expect(row.status).toBe('failed');
    expect(await balance(p.wallet)).toBe(before - 2_000n); // funds still frozen, never lost
  });
});

describe('withdrawal idempotency-key safety (security review #1)', () => {
  it('a client key colliding with an internal ledger key still produces a BACKED withdrawal', async () => {
    const p = await fundedPlayer(10_000n);
    const before = await balance(p.wallet);
    // 'genesis:play_pool' is a REAL internal ledger idempotency key. Used raw it
    // once created an UNBACKED withdrawal (free KEEP); per-wallet namespacing of
    // the freeze key neutralizes the collision → a normal, escrow-backed request.
    const row = await requestWithdrawal(db, p.wallet, 1_000n, DEST, 'genesis:play_pool');
    expect(row.status).toBe('unbonding');
    expect(await balance(p.wallet)).toBe(before - 1_000n); // player WAS debited
  });

  it('same client key retried returns the same row, charged once', async () => {
    const p = await fundedPlayer(10_000n);
    const before = await balance(p.wallet);
    const idem = 'client-retry-key-abc';
    const a = await requestWithdrawal(db, p.wallet, 1_000n, DEST, idem);
    const b = await requestWithdrawal(db, p.wallet, 1_000n, DEST, idem);
    expect(b.id).toBe(a.id); // deduped
    expect(await balance(p.wallet)).toBe(before - 1_000n); // one debit, not two
  });

  it('the same client key from different wallets does not collide', async () => {
    const p1 = await fundedPlayer(10_000n);
    const p2 = await fundedPlayer(10_000n);
    const idem = 'shared-client-key-xyz';
    const r1 = await requestWithdrawal(db, p1.wallet, 1_000n, DEST, idem);
    const r2 = await requestWithdrawal(db, p2.wallet, 1_000n, DEST, idem);
    expect(r1.id).not.toBe(r2.id); // per-wallet namespacing → independent
  });
});

describe('2FA enrollment + sibling-endpoint guards (security review #2)', () => {
  it('cannot silently re-enroll an already-enabled authenticator', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    await verifyTotpEnroll(db, p.wallet, totpCode(secret));
    await expect(enrollTotp(db, p.wallet)).rejects.toThrow(/already enabled/i);
  });

  it('adding an authenticator to an email-2FA account requires step-up proof', async () => {
    const p = await fundedPlayer(0n);
    const cap = captureSender();
    await startEmailEnroll(db, p.wallet, 'x@y.zz', cap.send);
    await verifyEmailEnroll(db, p.wallet, cap.last());
    // emailVerified now true → a hijacked session must NOT be able to add its own
    // authenticator without proving the existing (email) factor.
    await expect(enrollTotp(db, p.wallet)).rejects.toThrow(/confirm|existing 2fa/i);
    // with a valid email step-up code it proceeds
    await sendFactorStepUpEmailCode(db, p.wallet, cap.send, FACTOR_SESSION);
    await expect(enrollTotp(
      db, p.wallet, { method: 'email', code: cap.last() },
      factorChangeEmailChallengeContext('different-session'),
    )).rejects.toThrow(/invalid/i);
    const enroll = await enrollTotp(
      db, p.wallet, { method: 'email', code: cap.last() },
      factorChangeEmailChallengeContext(FACTOR_SESSION),
    );
    expect(enroll.secret).toBeTruthy();
  });

  it('the per-account lockout also covers the disable endpoint (oracle closed)', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    await verifyTotpEnroll(db, p.wallet, totpCode(secret));
    for (let i = 0; i < TWOFA.maxWithdrawAttempts; i++) {
      await expect(disableTotp(db, p.wallet, '000000')).rejects.toThrow(/invalid/i);
    }
    await expect(disableTotp(db, p.wallet, totpCode(secret))).rejects.toThrow(/too many/i);
  });

  it('re-verifying an already-enabled authenticator does NOT reset the lockout counter', async () => {
    const p = await fundedPlayer(0n);
    const { secret } = await enrollTotp(db, p.wallet);
    await verifyTotpEnroll(db, p.wallet, totpCode(secret));
    await matureTotp(p.wallet);
    // Interleave wrong withdrawal guesses with no-op re-verifies. If /2fa/totp/verify
    // reset the shared counter (the 2nd F2 residual), the lockout would never fire.
    for (let i = 0; i < TWOFA.maxWithdrawAttempts; i++) {
      expect(await verifyWithdrawal2fa(db, p.wallet, 'totp', '000000')).toBe(false);
      await verifyTotpEnroll(db, p.wallet, '000000'); // no-op (already enabled), must not reset
    }
    await expect(verifyWithdrawal2fa(db, p.wallet, 'totp', totpCode(secret))).rejects.toThrow(/too many/i);
  });
});
