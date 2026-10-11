/**
 * Account 2FA (owner 2026-08-11). Two enrollable methods — an authenticator
 * app (TOTP, RFC 6238 via the vetted `otpauth` lib) and a verified email (6-digit
 * codes) — with single-use checks for sensitive account confirmations. An
 * INSTANT payout that skips normal unbonding has a separate custody-only verifier. Verified
 * email remains useful for account recovery actions but cannot authorize custody:
 * only a TOTP enrollment older than the normal unbonding window can do that.
 *
 * Security posture:
 * - TOTP secrets are generated server-side; `totpEnabled` latches true only after
 *   the first correct code, so a half-finished enroll never gates anything.
 * - TOTP seeds are AES-256-GCM encrypted with a versioned, rotatable keyring.
 *   Legacy plaintext seeds are dual-read and rewrapped under the active key on use.
 * - Email codes are stored ONLY as a keyed, versioned HMAC; the plaintext is emailed
 *   and never persisted. Codes are single-use (consumedAt), TTL'd, attempt-capped
 *   (brute-force guard), and `purpose`-scoped so an enroll code can't authorize a
 *   withdrawal. Sends are cooldown-rate-limited per player.
 * - The email transport is injected (EmailSender). Dev logs the code and the route
 *   echoes it back only when NODE_ENV=development, so the flow is testable without
 *   an email provider; production wires a real sender and never echoes.
 */
import { ECONOMY, TWOFA } from '@shardkeep/shared';
import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, randomInt, timingSafeEqual,
} from 'node:crypto';
import { and, asc, desc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import { Secret, TOTP } from 'otpauth';
import QRCode from 'qrcode';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { emailOtps, players, sessions, totpRecoveries } from '../db/schema';
import { errorForStorage, HttpError } from '../lib/errors';
import { lockWithdrawalWalletTx } from '../money/withdrawalLock';
import {
  assertTotpFactorActionAllowedTx, assertTotpRecoveryAllowsTx,
  type TotpFactorAction, type TotpRecoveryProtectedAction,
} from './totpRecoveryPolicy';

/** Pluggable email transport. Dev logs; prod wires Resend/SES/etc.
 *  `html` is an optional richer body — `body` stays the canonical plain-text
 *  part and MUST always carry the full content (clients that strip HTML, and
 *  every existing caller/test, see only the text). */
export type EmailSender = (
  to: string,
  subject: string,
  body: string,
  html?: string,
  options?: { idempotencyKey?: string },
) => Promise<void>;

/** Default transport. Development logs the full message; every other environment
 * fails explicit. Production MUST inject a real EmailSender via AppDeps. */
export const consoleEmailSender: EmailSender = async (to, subject, body) => {
  if (process.env['NODE_ENV'] === 'development') {
    console.info(`[email:2fa] to=${to} subject="${subject}"\n${body}`);
    return;
  }
  // Tests inject a sender; production injects Resend and fails boot without it.
  // Every other runtime fails explicit rather than reporting a false delivery.
  throw new Error('email provider is not configured');
};

// Owner 2026-07-20 rebrand. Existing TOTP enrollments keep their old issuer LABEL
// in the authenticator app (the shared secret still validates); only new enrollments
// show the new name — no re-enrollment needed.
const ISSUER = 'Pixel Kingdom Wars';
const FACTOR_CHANGE_CONTEXT_PREFIX = 'factor-change:v1';

export function factorChangeEmailChallengeContext(sessionId: string): string {
  if (!sessionId) throw new Error('active session id is required for factor-change email');
  return JSON.stringify([FACTOR_CHANGE_CONTEXT_PREFIX, sessionId]);
}

interface TwofaKey { id: string; bytes: Buffer }

/**
 * First key writes; every listed key reads. Rotation is therefore deploy-safe:
 * prepend the new key, keep old keys during the lazy rewrap window, then remove
 * them after the database no longer contains their key ids.
 *
 * Format: `key-id:base64-32-byte-key[,older-id:base64-32-byte-key]`.
 */
function twofaKeys(env: NodeJS.ProcessEnv = process.env): TwofaKey[] {
  const raw = env['TWOFA_ENCRYPTION_KEYS'];
  if (!raw) throw new Error('TWOFA_ENCRYPTION_KEYS is required for 2FA operations');
  const seen = new Set<string>();
  return raw.split(',').map((entry) => {
    const colon = entry.indexOf(':');
    const id = entry.slice(0, colon);
    const encoded = entry.slice(colon + 1);
    if (colon < 1 || !/^[A-Za-z0-9_-]{1,32}$/.test(id) || seen.has(id)
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
      throw new Error('TWOFA_ENCRYPTION_KEYS has an invalid or duplicate key id/value');
    }
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.length !== 32) throw new Error('TWOFA_ENCRYPTION_KEYS entries must decode to exactly 32 bytes');
    seen.add(id);
    return { id, bytes };
  });
}

const envelopeAad = (version: 'g1' | 'g2', wallet: string): Buffer =>
  Buffer.from(`pixel-kingdom-wars:totp:${version}:${wallet}`);

function totpEncryptionKey(key: TwofaKey, version: 'g1' | 'g2'): Buffer {
  // g1 read support exists only for the unshipped first implementation. g2
  // derives an AES subkey so the root is never reused across AES and HMAC.
  return version === 'g1'
    ? key.bytes
    : createHmac('sha256', key.bytes).update('totp-encryption-key:g2').digest();
}

function sealTotp(secret: string, wallet: string): string {
  const key = twofaKeys()[0]!;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', totpEncryptionKey(key, 'g2'), iv);
  cipher.setAAD(envelopeAad('g2', wallet));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['g2', key.id, iv.toString('base64url'), encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.');
}

function openTotp(stored: string, wallet: string): { secret: string; rewrap: boolean } {
  if (!stored.startsWith('g1.') && !stored.startsWith('g2.')) {
    // Pre-0059 rows were raw base32. Only that exact alphabet is accepted as a
    // legacy value; malformed/future envelopes must never be mistaken for it.
    if (!/^[A-Z2-7]+=*$/.test(stored)) throw new Error('invalid TOTP secret envelope');
    return { secret: stored, rewrap: true };
  }
  const [rawVersion, id, iv64, ciphertext64, tag64, extra] = stored.split('.');
  const version = rawVersion as 'g1' | 'g2';
  if (!id || !iv64 || !ciphertext64 || !tag64 || extra !== undefined) throw new Error('invalid TOTP secret envelope');
  const keys = twofaKeys();
  const key = keys.find((candidate) => candidate.id === id);
  if (!key) throw new Error('a TOTP secret encryption key is unavailable');
  try {
    const iv = Buffer.from(iv64, 'base64url');
    const ciphertext = Buffer.from(ciphertext64, 'base64url');
    const tag = Buffer.from(tag64, 'base64url');
    if (iv.length !== 12 || ciphertext.length === 0 || tag.length !== 16) {
      throw new Error('invalid envelope lengths');
    }
    const decipher = createDecipheriv(
      'aes-256-gcm', totpEncryptionKey(key, version), iv,
    );
    decipher.setAAD(envelopeAad(version, wallet));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([
      decipher.update(ciphertext), decipher.final(),
    ]).toString('utf8');
    if (!/^[A-Z2-7]+=*$/.test(secret)) throw new Error('invalid plaintext');
    return { secret, rewrap: version !== 'g2' || keys[0]!.id !== id };
  } catch {
    throw new Error('unable to decrypt TOTP secret');
  }
}

async function rewrapTotp(
  db: DbOrTx, wallet: string, stored: string, opened: { secret: string; rewrap: boolean },
): Promise<void> {
  if (!opened.rewrap) return;
  // Compare-and-swap: a concurrent disable/re-enroll wins instead of an old read
  // resurrecting its seed. This is both the plaintext backfill and key rotation.
  await db.update(players).set({ totpSecret: sealTotp(opened.secret, wallet) }).where(and(
    eq(players.wallet, wallet), eq(players.totpSecret, stored),
  ));
}

function keyedDigest(key: TwofaKey, domain: string, parts: readonly string[]): string {
  return createHmac('sha256', key.bytes)
    .update(domain).update('\0').update(JSON.stringify(parts)).digest('base64url');
}

function codeHash(code: string, wallet: string, purpose: string, target: string, context: string): string {
  const key = twofaKeys()[0]!;
  return `h1.${key.id}.${keyedDigest(key, 'email-code:h1', [code, wallet, purpose, target, context])}`;
}

function codeMatches(stored: string, code: string, wallet: string, purpose: string, target: string, context: string): boolean {
  const [version, id, digest, extra] = stored.split('.');
  if (version !== 'h1' || !id || !digest || extra !== undefined) return false;
  const key = twofaKeys().find((candidate) => candidate.id === id);
  if (!key) return false;
  const expected = Buffer.from(keyedDigest(key, 'email-code:h1', [code, wallet, purpose, target, context]), 'base64url');
  const actual = Buffer.from(digest, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function contextHash(context: string): string {
  const key = twofaKeys()[0]!;
  return `c1.${key.id}.${keyedDigest(key, 'email-context:c1', [context])}`;
}

function contextMatches(stored: string | null, context: string): boolean {
  if (!stored) return false;
  const [version, id, digest, extra] = stored.split('.');
  if (version !== 'c1' || !id || !digest || extra !== undefined) return false;
  const key = twofaKeys().find((candidate) => candidate.id === id);
  if (!key) return false;
  const expected = Buffer.from(keyedDigest(key, 'email-context:c1', [context]), 'base64url');
  const actual = Buffer.from(digest, 'base64url');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function totpFor(secretBase32: string, wallet: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label: wallet,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

async function getPlayer2fa(db: DbOrTx, wallet: string) {
  const [p] = await db.select({
    totpSecret: players.totpSecret,
    totpEnabled: players.totpEnabled,
    loginTotpRequired: players.loginTotpRequired,
    totpEnabledAt: players.totpEnabledAt,
    totpReenrollmentRequired: players.totpReenrollmentRequired,
    email: players.email,
    emailVerified: players.emailVerified,
    pendingEmail: players.pendingEmail,
  }).from(players).where(eq(players.wallet, wallet));
  if (!p) throw new HttpError(404, 'player not found');
  return p;
}

type PlayerRow = typeof players.$inferSelect;

/**
 * Per-account 2FA lockout wrapper (security review 2026-07-19 #2). Serializes on
 * the player row (FOR UPDATE), refuses a locked-out account, runs `attempt`
 * (which validates the code and applies its own success side-effects, returning
 * whether the code was valid), then records the outcome: a wrong code bumps the
 * shared failure counter and locks the account for lockoutMinutes after
 * maxWithdrawAttempts; a right one clears it. EVERY code check — withdrawal,
 * enroll-verify, disable — goes through this so the counter can't be evaded by
 * brute-forcing the same secret through a sibling endpoint.
 */
async function withLockout(
  db: Db, wallet: string, now: Date,
  attempt: (tx: DbTx, p: PlayerRow) => Promise<boolean>,
): Promise<boolean> {
  return db.transaction((tx) => withLockoutTx(tx, wallet, now, attempt));
}

/** Same lockout primitive for callers already inside a money transaction. */
async function withLockoutTx(
  tx: DbTx, wallet: string, now: Date,
  attempt: (tx: DbTx, p: PlayerRow) => Promise<boolean | null>,
): Promise<boolean> {
  await lockWithdrawalWalletTx(tx, wallet);
  const [p] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
  if (!p) throw new HttpError(404, 'player not found');
  if (p.twofaLockedUntil && p.twofaLockedUntil > now) {
    throw new HttpError(429, 'too many 2FA attempts — wait a few minutes and try again');
  }
  const verdict = await attempt(tx, p);
  // No exact challenge exists for this action/session. This is not a code
  // guess and must not let a foreign context burn the account-wide lockout.
  if (verdict === null) return false;
  const ok = verdict;
  if (ok) {
    if (p.twofaFailedAttempts !== 0 || p.twofaLockedUntil !== null) {
      await tx.update(players).set({ twofaFailedAttempts: 0, twofaLockedUntil: null })
        .where(eq(players.wallet, wallet));
    }
  } else {
    const attempts = p.twofaFailedAttempts + 1;
    const lock = attempts >= TWOFA.maxWithdrawAttempts;
    await tx.update(players).set({
      twofaFailedAttempts: lock ? 0 : attempts,
      ...(lock ? { twofaLockedUntil: new Date(now.getTime() + TWOFA.lockoutMinutes * 60_000) } : {}),
    }).where(eq(players.wallet, wallet));
  }
  return ok;
}

// ---------------------------------------------------------------------------
// TOTP (authenticator app)
// ---------------------------------------------------------------------------

/** Begin TOTP enrollment: mint a fresh secret (NOT yet enabled) and return the
 *  provisioning URI + a QR data-URI + the base32 key for manual entry. */
/** Step-up proof of an EXISTING 2FA factor, required to add/change a factor. */
export interface StepUp { method: 'totp' | 'email'; code: string }

/** Adding or changing a 2FA method on an account that ALREADY has a verified
 *  factor must prove possession of that factor — otherwise a hijacked session
 *  could enroll its OWN authenticator (or swap the email) and bypass the owner's
 *  2FA entirely (security review 2026-07-19 #2, enroll-takeover). First-factor
 *  setup on an un-protected account needs no step-up. */
async function requireStepUpIf2fa(
  db: Db, wallet: string, stepUp: StepUp | undefined, factorContext?: string,
): Promise<void> {
  const p = await getPlayer2fa(db, wallet);
  if (!p.totpEnabled && !p.emailVerified) return; // no existing factor → first-time setup is free
  if (!stepUp) throw new HttpError(403, 'confirm with your existing 2FA code to change 2FA settings');
  // verifyWithdrawal2fa applies the single-use + per-account lockout guarantees.
  if (stepUp.method === 'email' && !factorContext) {
    throw new HttpError(403, 'request a new factor-change email code first');
  }
  if (!(await verifyWithdrawal2fa(
    db, wallet, stepUp.method, stepUp.code, new Date(), factorContext ?? '',
  ))) {
    throw new HttpError(422, 'invalid 2FA code');
  }
}

export async function enrollTotp(
  db: Db, wallet: string, stepUp?: StepUp, factorContext?: string,
): Promise<{
  secret: string; otpauthUrl: string; qrDataUri: string;
}> {
  const p = await getPlayer2fa(db, wallet);
  if (p.totpEnabled) throw new HttpError(409, 'authenticator already enabled — disable it first to re-enroll');
  // A verified email factor must be proven before adding an authenticator.
  await requireStepUpIf2fa(db, wallet, stepUp, factorContext);
  const secret = new Secret({ size: 20 }).base32;
  await db.transaction(async (tx) => {
    await assertTotpFactorActionAllowedTx(tx, wallet, 'totp_enroll');
    await tx.update(players)
      .set({ totpSecret: sealTotp(secret, wallet), totpEnabled: false, totpEnabledAt: null, totpLastUsedStep: null })
      .where(eq(players.wallet, wallet));
  });
  const otpauthUrl = totpFor(secret, wallet).toString();
  const qrDataUri = await QRCode.toDataURL(otpauthUrl, { margin: 1, width: 220 });
  return { secret, otpauthUrl, qrDataUri };
}

/** Finish enrollment: a correct code enables TOTP. Lockout-guarded so this
 *  endpoint can't be used as a brute-force oracle for the pending secret. */
export async function verifyTotpEnroll(db: Db, wallet: string, code: string, now = new Date()): Promise<void> {
  // Already enabled → idempotent no-op, returned BEFORE withLockout. Routing a
  // no-op "success" THROUGH withLockout would reset the shared brute-force counter
  // without proving possession — a free lockout reset an attacker could interleave
  // with wrong withdrawal guesses to dodge the lockout (security review 2026-07-19
  // #2, 2nd residual). Now the only success path requires a valid code.
  if ((await getPlayer2fa(db, wallet)).totpEnabled) return;
  const ok = await withLockout(db, wallet, now, async (tx, p) => {
    await assertTotpFactorActionAllowedTx(tx, wallet, 'totp_verify', now);
    if (!p.totpSecret) throw new HttpError(422, 'start TOTP enrollment first');
    const opened = openTotp(p.totpSecret, wallet);
    const delta = totpFor(opened.secret, wallet).validate({
      token: code,
      timestamp: now.getTime(),
      window: TWOFA.totpWindow,
    });
    if (delta === null) return false;
    const enrollmentStep = BigInt(Math.floor(now.getTime() / 1000 / 30) + delta);
    await tx.update(players).set({
      totpEnabled: true,
      totpEnabledAt: now,
      // A completed recovery remains custody-blocking until this exact proof
      // verifies the replacement secret. Merely opening the enrollment screen
      // never clears the durable latch.
      totpReenrollmentRequired: false,
      // The proof that enrolled this seed is already spent. It is normally long
      // expired by maturation, but recording it keeps the single-use invariant
      // complete even if the hold policy is later shortened.
      totpLastUsedStep: enrollmentStep,
      ...(opened.rewrap ? { totpSecret: sealTotp(opened.secret, wallet) } : {}),
    }).where(eq(players.wallet, wallet));
    if (p.totpReenrollmentRequired && p.loginTotpRequired) {
      await tx.update(sessions).set({ revokedAt: now }).where(eq(sessions.wallet, wallet));
    }
    return true;
  });
  if (!ok) throw new HttpError(422, 'invalid authenticator code');
}

/** Disable TOTP — requires a currently-valid code (lockout-guarded) so a hijacked
 *  session can't silently strip the owner's second factor OR use this as an oracle. */
export async function disableTotp(db: Db, wallet: string, code: string, now = new Date()): Promise<void> {
  const ok = await withLockout(db, wallet, now, async (tx, p) => {
    await assertTotpFactorActionAllowedTx(tx, wallet, 'totp_disable', now);
    if (p.loginTotpRequired) throw new HttpError(409, 'disable PKW login protection before removing its authenticator');
    if (!p.totpEnabled || !p.totpSecret) return false;
    const opened = openTotp(p.totpSecret, wallet);
    const delta = totpFor(opened.secret, wallet).validate({
      token: code,
      timestamp: now.getTime(),
      window: TWOFA.totpWindow,
    });
    const step = delta === null ? null : BigInt(Math.floor(now.getTime() / 1000 / 30) + delta);
    // Single-use is cross-purpose: a code consumed by payout, key export, or
    // factor step-up cannot be replayed in the same 30-second window to strip
    // the authenticator itself.
    const valid = step !== null && (p.totpLastUsedStep === null || step > p.totpLastUsedStep);
    if (valid) {
      await tx.update(players)
        .set({ totpSecret: null, totpEnabled: false, totpEnabledAt: null, totpLastUsedStep: null })
        .where(eq(players.wallet, wallet));
    }
    return valid;
  });
  if (!ok) throw new HttpError(422, 'invalid authenticator code');
}

/** Verify a TOTP code against an ENABLED secret — stateless, no lockout. NOT
 *  wired to any route (the withdrawal path uses verifyWithdrawal2fa, which is
 *  single-use + lockout-guarded). Kept as an internal/test read-only check. */
export async function checkTotp(db: DbOrTx, wallet: string, code: string): Promise<boolean> {
  const p = await getPlayer2fa(db, wallet);
  if (!p.totpEnabled || !p.totpSecret) return false;
  const opened = openTotp(p.totpSecret, wallet);
  await rewrapTotp(db, wallet, p.totpSecret, opened);
  return totpFor(opened.secret, wallet).validate({ token: code, window: TWOFA.totpWindow }) !== null;
}

// ---------------------------------------------------------------------------
// Email codes
// ---------------------------------------------------------------------------

function genCode(): string {
  return String(randomInt(0, 10 ** TWOFA.emailCodeDigits)).padStart(TWOFA.emailCodeDigits, '0');
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const EMAIL_ENROLL_CONTEXT = 'email-enroll:v1';
const RFC2606_RESERVED_EMAIL_DOMAINS = [
  'example.com', 'example.net', 'example.org', 'example', 'invalid', 'test', 'localhost',
] as const;

/** RFC 2606 domains are documentation/test namespaces and cannot receive a
 * verification message. Include subdomains and a trailing DNS root dot so an
 * address cannot bypass the guard through an equivalent spelling. */
function hasReservedEmailDomain(address: string): boolean {
  const domain = address.slice(address.lastIndexOf('@') + 1).replace(/\.+$/, '');
  return RFC2606_RESERVED_EMAIL_DOMAINS.some(
    (reserved) => domain === reserved || domain.endsWith(`.${reserved}`),
  );
}

/** Canonical, opaque input for an email challenge. Routes include the active
 * session id so a code captured from one session cannot authorize another. */
export function withdrawalEmailChallengeContext(intent: {
  amount: string; destination: string; idempotencyKey: string; sessionId: string;
}): string {
  return JSON.stringify(['withdrawal:v1', intent.amount, intent.destination, intent.idempotencyKey, intent.sessionId]);
}

interface EmailCodeReservation {
  id: string;
  code: string;
  to: string;
  purpose: 'enroll' | 'withdraw' | 'totp_recovery';
  expiresAt: Date;
  issuedAt: Date;
}

/** Human-facing intent only. The legacy `withdraw` DB purpose remains the
 * cryptographic storage namespace; the exact challenge context remains the
 * authorization boundary and is still included in both HMACs. */
export type SecurityEmailAction = 'account_security_change' | 'private_key_export';
export type TotpRecoveryEmailAction = 'start' | 'complete';
type EmailCodeAction = SecurityEmailAction | `totp_recovery_${TotpRecoveryEmailAction}`;

export function totpRecoveryEmailChallengeContext(
  recoveryId: string, action: TotpRecoveryEmailAction, sessionId: string,
): string {
  if (!recoveryId || !sessionId) throw new Error('recovery id and active session id are required');
  return JSON.stringify(['totp-recovery:v1', recoveryId, action, sessionId]);
}

function emailCodeMessage(
  reservation: EmailCodeReservation, validity: string, action?: EmailCodeAction,
): { subject: string; body: string } {
  if (reservation.purpose === 'enroll') {
    return {
      subject: 'Verify your Pixel Kingdom Wars email',
      body: `Your Pixel Kingdom Wars email verification code is ${reservation.code}. It expires ${validity}.`,
    };
  }
  if (action === 'account_security_change') {
    return {
      subject: 'Confirm your Pixel Kingdom Wars account security change',
      body: `Your Pixel Kingdom Wars account security confirmation code is ${reservation.code}. It expires ${validity}. This code cannot authorize a withdrawal.`,
    };
  }
  if (action === 'private_key_export') {
    return {
      subject: 'Confirm your Pixel Kingdom Wars private key export',
      body: `Your Pixel Kingdom Wars private key export code is ${reservation.code}. It expires ${validity}. Only enter it when exporting your private key. This code cannot authorize a withdrawal.`,
    };
  }
  if (action === 'totp_recovery_start') {
    return {
      subject: 'Confirm your Pixel Kingdom Wars authenticator recovery',
      body: `Your Pixel Kingdom Wars lost-authenticator recovery code is ${reservation.code}. It expires ${validity}. Confirming starts a ${TWOFA.recoveryHoldHours}-hour security hold, cancels pending withdrawals, and alerts this address. If you did not request this, do not enter the code.`,
    };
  }
  if (action === 'totp_recovery_complete') {
    return {
      subject: 'Complete your Pixel Kingdom Wars authenticator recovery',
      body: `Your Pixel Kingdom Wars authenticator-recovery completion code is ${reservation.code}. It expires ${validity}. Enter it only after the security hold shown in the game. If you did not request this, do not enter the code.`,
    };
  }
  throw new Error('a security email action is required');
}

/** Reserve a challenge/cooldown under the player lock. Provider I/O happens only
 * after this short transaction commits, never while holding a pool connection. */
async function reserveEmailCodeTx(
  tx: DbTx, wallet: string, to: string, purpose: 'enroll' | 'withdraw' | 'totp_recovery',
  challenge: string, now: Date, expiresAtCap?: Date,
): Promise<EmailCodeReservation> {
  if (challenge.length > 2_048) throw new HttpError(422, 'email challenge context is too large');
  const cutoff = new Date(now.getTime() - TWOFA.emailResendCooldownSec * 1000);
  const [recent] = await tx.select({ createdAt: emailOtps.createdAt }).from(emailOtps)
    .where(and(eq(emailOtps.playerWallet, wallet), eq(emailOtps.purpose, purpose), gt(emailOtps.createdAt, cutoff)))
    .orderBy(desc(emailOtps.createdAt)).limit(1);
  if (recent) throw new HttpError(429, 'a code was just sent — wait a moment before requesting another');

  const code = genCode();
  const expiresAt = new Date(Math.min(
    now.getTime() + TWOFA.emailCodeTtlSec * 1000,
    expiresAtCap?.getTime() ?? Number.POSITIVE_INFINITY,
  ));
  if (expiresAt.getTime() <= now.getTime()) {
    throw new HttpError(410, 'authenticator recovery has expired');
  }
  const [row] = await tx.insert(emailOtps).values({
    playerWallet: wallet,
    purpose,
    codeHash: codeHash(code, wallet, purpose, to, challenge),
    targetEmail: to,
    challengeContext: contextHash(challenge),
    expiresAt,
    createdAt: now,
  }).returning({ id: emailOtps.id });
  if (!row) throw new Error('failed to reserve email challenge');
  return { id: row.id, code, to, purpose, expiresAt, issuedAt: now };
}

/** Deliver outside the DB transaction, then atomically activate the challenge
 * (and optionally the pending address). A rejected provider deletes the inert
 * reservation, so it neither returns sent nor starts an unusable cooldown. */
async function deliverReservedEmailCode(
  db: Db, reservation: EmailCodeReservation, send: EmailSender,
  onDelivered?: (tx: DbTx) => Promise<void>, action?: EmailCodeAction,
  beforeOtpLock?: (tx: DbTx) => Promise<void>,
): Promise<string> {
  const wholeMinutes = Math.floor(
    (reservation.expiresAt.getTime() - reservation.issuedAt.getTime()) / 60_000,
  );
  const validity = wholeMinutes >= 1 ? `in ${wholeMinutes} minute${wholeMinutes === 1 ? '' : 's'}`
    : `at ${reservation.expiresAt.toISOString()}`;
  const message = emailCodeMessage(reservation, validity, action);
  try {
    await send(reservation.to, message.subject, message.body);
  } catch (providerError) {
    try {
      await db.delete(emailOtps).where(and(
        eq(emailOtps.id, reservation.id), isNull(emailOtps.deliveredAt),
      ));
    } catch (cleanupError) {
      console.error(`[email:2fa] failed-reservation cleanup failed reservation=${reservation.id}: ${errorForStorage(cleanupError)}`);
    }
    // Provider detail is operational evidence, not client-safe response data.
    // Do not log the recipient or plaintext code.
    console.error(
      `[email:2fa] delivery failed reservation=${reservation.id} purpose=${reservation.purpose}: ${errorForStorage(providerError)}`,
    );
    throw new HttpError(
      503, 'email delivery is unavailable — try again shortly', 'EMAIL_DELIVERY_UNAVAILABLE',
    );
  }
  try {
    await db.transaction(async (tx) => {
      // Sensitive post-provider mutations acquire wallet/player/recovery before
      // the OTP row. Otherwise confirm/verify could deadlock this activation,
      // or a hold starting during provider I/O could be missed entirely.
      if (beforeOtpLock) await beforeOtpLock(tx);
      const [row] = await tx.select({ deliveredAt: emailOtps.deliveredAt })
        .from(emailOtps).where(eq(emailOtps.id, reservation.id)).for('update');
      if (!row || row.deliveredAt) throw new Error('email challenge reservation is unavailable');
      if (onDelivered) await onDelivered(tx);
      await tx.update(emailOtps).set({ deliveredAt: new Date() })
        .where(eq(emailOtps.id, reservation.id));
    });
  } catch (activationError) {
    // The provider may already have delivered the plaintext. If recovery won
    // the race, remove the still-inert DB reservation so that message can never
    // become a usable factor-change proof later.
    await db.delete(emailOtps).where(and(
      eq(emailOtps.id, reservation.id), isNull(emailOtps.deliveredAt),
    )).catch((cleanupError: unknown) => {
      console.error(`[email:2fa] failed-inert activation cleanup reservation=${reservation.id}: ${errorForStorage(cleanupError)}`);
    });
    throw activationError;
  }
  return reservation.code;
}

/** Start email enrollment without disabling a currently verified address. */
export async function startEmailEnroll(
  db: Db, wallet: string, email: string, send: EmailSender, now = new Date(), stepUp?: StepUp,
  factorContext?: string,
): Promise<{ devCode?: string }> {
  const addr = email.trim().toLowerCase();
  if (!EMAIL_RE.test(addr) || addr.length > 254) throw new HttpError(422, 'invalid email address');
  if (hasReservedEmailDomain(addr)) {
    throw new HttpError(422, 'use a deliverable email address — reserved example/test domains cannot receive codes');
  }
  // Prove the existing factor BEFORE mutating (else a hijacked session could
  // point 2FA at the attacker's inbox). No-op for first-time setup.
  await requireStepUpIf2fa(db, wallet, stepUp, factorContext);
  const reservation = await db.transaction(async (tx) => {
    await assertTotpFactorActionAllowedTx(tx, wallet, 'email_change', now);
    await lockWithdrawalWalletTx(tx, wallet);
    const [p] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!p) throw new HttpError(404, 'player not found');
    return reserveEmailCodeTx(tx, wallet, addr, 'enroll', EMAIL_ENROLL_CONTEXT, now);
  });
  const code = await deliverReservedEmailCode(db, reservation, send, async (tx) => {
    await tx.update(players).set({ pendingEmail: addr }).where(eq(players.wallet, wallet));
  }, undefined, async (tx) => {
    await assertTotpFactorActionAllowedTx(tx, wallet, 'email_change', new Date());
  });
  return { devCode: code };
}

/** Consume + promote in one transaction. The old verified address remains active
 * until this commit, including while a replacement message is in flight. */
export async function verifyEmailEnroll(db: Db, wallet: string, code: string, now = new Date()): Promise<void> {
  const ok = await withLockout(db, wallet, now, async (tx, p) => {
    await assertTotpFactorActionAllowedTx(tx, wallet, 'email_change', now);
    if (!p.pendingEmail) return false;
    const consumed = await consumeEmailCodeTx(
      tx, wallet, code, 'enroll', now, p.pendingEmail, EMAIL_ENROLL_CONTEXT,
    );
    if (!consumed) return false;
    await tx.update(players).set({
      email: p.pendingEmail,
      emailVerified: true,
      pendingEmail: null,
    }).where(eq(players.wallet, wallet));
    return true;
  });
  if (!ok) throw new HttpError(422, 'invalid or expired code');
}

/** Send a context-bound email proof to the verified contact. It is intentionally
 * not wired to custody; current callers use it for factor changes and key export. */
export async function sendWithdrawEmailCode(
  db: Db, wallet: string, send: EmailSender, now = new Date(),
  challenge?: string, action?: SecurityEmailAction,
  guard?: { recoveryAction?: TotpRecoveryProtectedAction; factorAction?: TotpFactorAction },
): Promise<{ devCode?: string }> {
  if (!challenge) throw new Error('email challenge context is required');
  if (!action) throw new Error('a security email action is required');
  const reservation = await db.transaction(async (tx) => {
    if (guard?.recoveryAction) {
      await assertTotpRecoveryAllowsTx(tx, wallet, guard.recoveryAction, now);
    }
    if (guard?.factorAction) {
      await assertTotpFactorActionAllowedTx(tx, wallet, guard.factorAction, now);
    }
    await lockWithdrawalWalletTx(tx, wallet);
    const [p] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!p) throw new HttpError(404, 'player not found');
    if (!p.emailVerified || !p.email) throw new HttpError(422, 'verify an email first');
    return reserveEmailCodeTx(tx, wallet, p.email, 'withdraw', challenge, now);
  });
  const code = await deliverReservedEmailCode(db, reservation, send, undefined, action);
  return { devCode: code };
}

/** Dedicated factor-change step-up. It intentionally shares neither an intent
 * context nor a code with withdrawals/key export, and is bound to the active
 * server-verified session id. */
export function sendFactorStepUpEmailCode(
  db: Db, wallet: string, send: EmailSender, sessionId: string, now = new Date(),
): Promise<{ devCode?: string }> {
  return sendWithdrawEmailCode(
    db, wallet, send, now, factorChangeEmailChallengeContext(sessionId),
    'account_security_change', { factorAction: 'step_up_email' },
  );
}

/**
 * Verify + CONSUME a hashed email code. Increments attempts (burning the code
 * once maxCodeAttempts is hit) and single-uses it on success. Constant-ish:
 * touches only a row whose target and versioned context match this exact proof.
 */
/** Consume a hashed email code inside a caller-provided transaction (so it can
 *  share the per-wallet lock of verifyWithdrawal2fa). Selects the newest matching live row
 *  FOR UPDATE, attempt-caps it, and single-uses it on a hash match. */
async function consumeEmailCodeTx(
  tx: DbTx, wallet: string, code: string, purpose: 'enroll' | 'withdraw' | 'totp_recovery', now: Date,
  target: string, challenge: string,
): Promise<boolean | null> {
  const candidates = await tx.select().from(emailOtps).where(and(
    eq(emailOtps.playerWallet, wallet),
    eq(emailOtps.purpose, purpose),
    isNull(emailOtps.consumedAt),
    isNotNull(emailOtps.deliveredAt),
    gt(emailOtps.expiresAt, now),
    eq(emailOtps.targetEmail, target),
  )).orderBy(desc(emailOtps.createdAt)).for('update');
  // Match the stored versioned HMAC in application code so codes minted before
  // a key rotation remain valid. A foreign session/action can neither shadow
  // nor spend attempts on the exact code this caller is verifying.
  const row = candidates.find((candidate) => contextMatches(candidate.challengeContext, challenge));
  if (!row) return null;
  if (row.attempts >= TWOFA.maxCodeAttempts) return false;
  const ok = row.targetEmail === target
    && contextMatches(row.challengeContext, challenge)
    && codeMatches(row.codeHash, code, wallet, purpose, target, challenge);
  await tx.update(emailOtps)
    .set({ attempts: sql`${emailOtps.attempts} + 1`, ...(ok ? { consumedAt: now } : {}) })
    .where(eq(emailOtps.id, row.id));
  return ok;
}

/** Send a recovery-only code to the verified address snapshotted on the
 * recovery row. Rechecking the current address prevents a pre-hold email swap
 * from silently redirecting the second proof. */
export async function sendTotpRecoveryEmailCode(
  db: Db, wallet: string, targetEmail: string, recoveryId: string,
  action: TotpRecoveryEmailAction, sessionId: string, send: EmailSender,
  now = new Date(),
): Promise<{ devCode?: string }> {
  const context = totpRecoveryEmailChallengeContext(recoveryId, action, sessionId);
  const assertExactRecovery = async (tx: DbTx, checkAt: Date) => {
    await lockWithdrawalWalletTx(tx, wallet);
    const [p] = await tx.select().from(players).where(eq(players.wallet, wallet)).for('update');
    if (!p) throw new HttpError(404, 'player not found');
    if (!p.emailVerified || !p.email || p.email !== targetEmail) {
      throw new HttpError(409, 'the verified recovery email changed — cancel and start again');
    }
    const [recovery] = await tx.select().from(totpRecoveries).where(and(
      eq(totpRecoveries.id, recoveryId), eq(totpRecoveries.playerWallet, wallet),
    )).for('update');
    const expected = action === 'start' ? 'email_pending' : 'holding';
    if (!recovery || recovery.status !== expected || recovery.expiresAt.getTime() <= checkAt.getTime()
      || (action === 'start' && recovery.startedSessionId !== sessionId)
      || (action === 'complete' && (!recovery.readyAt || recovery.readyAt.getTime() > checkAt.getTime()))) {
      throw new HttpError(recovery?.expiresAt && recovery.expiresAt.getTime() <= checkAt.getTime() ? 410 : 409,
        'authenticator recovery state changed — refresh and try again');
    }
    return recovery;
  };
  const reservation = await db.transaction(async (tx) => {
    const recovery = await assertExactRecovery(tx, now);
    return reserveEmailCodeTx(tx, wallet, targetEmail, 'totp_recovery', context, now, recovery.expiresAt);
  });
  const deliveryStartedAt = Date.now();
  const code = await deliverReservedEmailCode(
    db, reservation, send, undefined, `totp_recovery_${action}`, async (tx) => {
      // Advance the injected clock only by real provider latency. This keeps
      // tests deterministic while still refusing activation if delivery crosses
      // the recovery deadline in production.
      await assertExactRecovery(tx, new Date(now.getTime() + Math.max(0, Date.now() - deliveryStartedAt)));
    },
  );
  return { devCode: code };
}

/** Idempotent recovery-start retries do not mint a second code when the first
 * provider delivery already succeeded. Exact target/action/session binding is
 * checked against the HMAC-only context; no plaintext code is recoverable. */
export async function hasLiveTotpRecoveryEmailCode(
  db: Db, wallet: string, targetEmail: string, recoveryId: string,
  action: TotpRecoveryEmailAction, sessionId: string, now = new Date(),
): Promise<boolean> {
  const context = totpRecoveryEmailChallengeContext(recoveryId, action, sessionId);
  const [row] = await db.select().from(emailOtps).where(and(
    eq(emailOtps.playerWallet, wallet),
    eq(emailOtps.purpose, 'totp_recovery'),
    eq(emailOtps.targetEmail, targetEmail),
    isNull(emailOtps.consumedAt),
    isNotNull(emailOtps.deliveredAt),
    gt(emailOtps.expiresAt, now),
  )).orderBy(desc(emailOtps.createdAt)).limit(1);
  return Boolean(row && contextMatches(row.challengeContext, context));
}

/** Consume a recovery code inside the caller's wallet/ledger transaction. */
export async function verifyTotpRecoveryEmailCodeTx(
  tx: DbTx, wallet: string, targetEmail: string, code: string,
  recoveryId: string, action: TotpRecoveryEmailAction, sessionId: string,
  now = new Date(),
): Promise<boolean> {
  const context = totpRecoveryEmailChallengeContext(recoveryId, action, sessionId);
  return withLockoutTx(tx, wallet, now, async (locked, p) => {
    if (!p.emailVerified || !p.email || p.email !== targetEmail) return false;
    return consumeEmailCodeTx(
      locked, wallet, code, 'totp_recovery', now, targetEmail, context,
    );
  });
}

/**
 * Shared factor proof for account changes/key export. Runs under withLockout
 * (per-account brute-force + serialization). TOTP is SINGLE-USE — a code whose
 * 30s step was already spent is a replay and refused (RFC 6238 §5.2); email codes
 * are consumed atomically in the same tx. Concurrent same-code attempts serialize
 * on the player-row lock, so a code authorizes at most one withdrawal.
 */
export async function verifyWithdrawal2fa(
  db: Db, wallet: string, method: 'totp' | 'email', code: string, now = new Date(),
  challenge?: string,
): Promise<boolean> {
  return db.transaction((tx) => verifyWithdrawal2faTx(tx, wallet, method, code, now, challenge));
}

/** Atomic key-export factor gate. Recovery protection and factor consumption
 * share the wallet/player transaction, closing the route-level check/use gap. */
export async function verifyKeyExport2fa(
  db: Db, wallet: string, method: 'totp' | 'email' | undefined,
  code: string | undefined, challenge: string, now = new Date(),
): Promise<{ enrolled: boolean; ok: boolean }> {
  return db.transaction(async (tx) => {
    await assertTotpRecoveryAllowsTx(tx, wallet, 'key_export', now);
    const [player] = await tx.select({
      totpEnabled: players.totpEnabled,
      emailVerified: players.emailVerified,
    }).from(players).where(eq(players.wallet, wallet));
    if (!player) throw new HttpError(404, 'player not found');
    const enrolled = player.totpEnabled || player.emailVerified;
    if (!enrolled) return { enrolled: false, ok: true };
    if (!method || !code) return { enrolled: true, ok: false };
    return {
      enrolled: true,
      ok: await verifyWithdrawal2faTx(tx, wallet, method, code, now, challenge),
    };
  });
}

/** Transaction-compatible factor proof. Instant custody must call the dedicated
 * mature-TOTP wrapper below so readiness cannot be forgotten at the money seam. */
export async function verifyWithdrawal2faTx(
  tx: DbTx, wallet: string, method: 'totp' | 'email', code: string, now = new Date(),
  challenge?: string, requireMatureTotp = false,
): Promise<boolean> {
  return withLockoutTx(tx, wallet, now, async (locked, p) => {
    if (method === 'totp') {
      if (!p.totpEnabled || !p.totpSecret) return false;
      if (requireMatureTotp && (!p.totpEnabledAt || now.getTime() < totpReadyAt(p.totpEnabledAt).getTime())) {
        throw new HttpError(403, 'authenticator is still maturing — use the standard withdrawal until it is ready');
      }
      const opened = openTotp(p.totpSecret, wallet);
      const delta = totpFor(opened.secret, wallet).validate({
        token: code,
        timestamp: now.getTime(),
        window: TWOFA.totpWindow,
      });
      if (delta === null) return false;
      const step = BigInt(Math.floor(now.getTime() / 1000 / 30) + delta);
      if (p.totpLastUsedStep !== null && step <= p.totpLastUsedStep) return false; // replay
      await locked.update(players).set({
        totpLastUsedStep: step,
        ...(opened.rewrap ? { totpSecret: sealTotp(opened.secret, wallet) } : {}),
      }).where(eq(players.wallet, wallet));
      return true;
    }
    if (!p.emailVerified || !p.email) return false;
    if (!challenge) throw new Error('email challenge context is required');
    return consumeEmailCodeTx(locked, wallet, code, 'withdraw', now, p.email, challenge);
  });
}

/** Custody-only verifier. Keeping maturation out of the generic factor step-up
 * path lets a new authenticator protect account changes immediately while making
 * it impossible for that same enrollment to accelerate a payout. */
export async function verifyInstantWithdrawalTotpTx(
  tx: DbTx, wallet: string, code: string, now = new Date(),
): Promise<boolean> {
  return verifyWithdrawal2faTx(tx, wallet, 'totp', code, now, undefined, true);
}

export async function verifyInstantWithdrawalTotp(
  db: Db, wallet: string, code: string, now = new Date(),
): Promise<boolean> {
  return db.transaction((tx) => verifyInstantWithdrawalTotpTx(tx, wallet, code, now));
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/** Masked 2FA status for the UI: is instant-withdrawal unlocked, and how. */
export async function get2faStatus(db: Db, wallet: string, now = new Date()): Promise<{
  totpEnabled: boolean;
  emailVerified: boolean;
  email: string | null;
  pendingEmail: string | null;
  totpReady: boolean;
  totpReadyAt: string | null;
  instantEligible: boolean;
  reenrollmentRequired: boolean;
  loginTotpRequired: boolean;
}> {
  const p = await getPlayer2fa(db, wallet);
  const readyAt = p.totpEnabled && p.totpEnabledAt ? totpReadyAt(p.totpEnabledAt) : null;
  return {
    totpEnabled: p.totpEnabled,
    emailVerified: p.emailVerified,
    email: p.email ? maskEmail(p.email) : null,
    pendingEmail: p.pendingEmail ? maskEmail(p.pendingEmail) : null,
    totpReady: readyAt !== null && now.getTime() >= readyAt.getTime(),
    totpReadyAt: readyAt?.toISOString() ?? null,
    instantEligible: readyAt !== null && now.getTime() >= readyAt.getTime(),
    reenrollmentRequired: p.totpReenrollmentRequired,
    loginTotpRequired: p.loginTotpRequired,
  };
}

function totpReadyAt(enabledAt: Date): Date {
  return new Date(enabledAt.getTime() + ECONOMY.unbondingHours * 60 * 60 * 1_000);
}

/**
 * Bounded ops backfill for legacy plaintext and non-active-key TOTP envelopes.
 * Dry-run still decrypts each candidate, proving every referenced key exists,
 * but emits counts only. Apply uses per-row CAS so concurrent disable/re-enroll
 * wins and no stale seed can be resurrected.
 */
export async function rewrapTotpSecrets(
  db: Db, options: { apply: boolean; batchSize?: number },
): Promise<{ scanned: number; needsRewrap: number; rewrapped: number; raced: number }> {
  const batchSize = options.batchSize ?? 100;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error('2FA rewrap batchSize must be an integer from 1 to 1000');
  }
  let cursor: string | undefined;
  const result = { scanned: 0, needsRewrap: 0, rewrapped: 0, raced: 0 };
  for (;;) {
    const rows = await db.select({ wallet: players.wallet, stored: players.totpSecret })
      .from(players)
      .where(and(
        isNotNull(players.totpSecret),
        ...(cursor ? [gt(players.wallet, cursor)] : []),
      ))
      .orderBy(asc(players.wallet))
      .limit(batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      if (!row.stored) continue;
      result.scanned++;
      const opened = openTotp(row.stored, row.wallet);
      if (!opened.rewrap) continue;
      result.needsRewrap++;
      if (!options.apply) continue;
      const updated = await db.update(players)
        .set({ totpSecret: sealTotp(opened.secret, row.wallet) })
        .where(and(eq(players.wallet, row.wallet), eq(players.totpSecret, row.stored)))
        .returning({ wallet: players.wallet });
      if (updated.length === 1) result.rewrapped++;
      else result.raced++;
    }
    cursor = rows.at(-1)!.wallet;
  }
  return result;
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!user || !domain) return email;
  const head = user.slice(0, 2);
  return `${head}${'*'.repeat(Math.max(1, user.length - 2))}@${domain}`;
}
