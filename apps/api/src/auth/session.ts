/** Session + recent-primary-auth JWT helpers and auth preHandler decorators. */
import { createHash, randomBytes } from 'node:crypto';
import { LOGIN_AUTH, MAIL } from '@shardkeep/shared';
import { and, eq, gt, isNotNull, isNull, or } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import { multiBaseEnabled, type Config } from '../config';
import type { Db } from '../db/client';
import { alphaAccess, bases, baseSlots, players, sessions } from '../db/schema';
import { HttpError } from '../lib/errors';

export const SESSION_COOKIE = 'shardkeep_session';
export const LOGIN_COOKIE = 'shardkeep_login';
export const SESSION_TTL_SEC = 7 * 24 * 60 * 60; // 7 days
/** Header carrying the short-lived, server-signed primary-auth grant. */
export const RECENT_AUTH_HEADER = 'x-shardkeep-recent-auth';
/** Five minutes from the SERVER-issued challenge, never from a later replay. */
export const RECENT_AUTH_TTL_SEC = 5 * 60;
/** Safe to render verbatim in a wallet signing prompt. Withdrawal request IDs
 * are deliberately narrower than generic game idempotency keys: no whitespace,
 * control characters or bidi/prompt-injection punctuation. */
export const WITHDRAWAL_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export type RecentAuthPurpose =
  | 'factor_change' | 'key_export' | 'withdrawal' | 'admin_mail_reward' | 'totp_recovery';

/** The exact withdrawal request a primary-auth signature authorizes. */
export interface WithdrawalRecentAuthIntent {
  version: 1;
  grossAmount: string;
  feeBurned: string;
  netAmount: string;
  cluster: 'devnet' | 'mainnet-beta';
  keepMint: string;
  destination: string;
  idempotencyKey: string;
  mode: 'standard' | 'instant';
  unbondingHours: number;
}

/** Exact digest of one admin reward delivery. The content hash is recomputed
 * from the send body; a grant for one recipient/payload cannot authorize any
 * other mail even when an idempotency key is reused. */
export interface AdminMailRewardRecentAuthIntent {
  recipientWallet: string;
  idempotencyKey: string;
  subject: string;
  attachments: Array<
    | { kind: 'KEEP' | 'SHARDS'; amount: string }
    | { kind: 'ITEM'; itemId: string; qty: number }
  >;
  contentHash: string;
}

/** Exact durable recovery row and phase authorized by a fresh wallet proof. */
export interface TotpRecoveryRecentAuthIntent {
  recoveryId: string;
  action: 'start' | 'complete';
}

export type RecentAuthIntent =
  | WithdrawalRecentAuthIntent | AdminMailRewardRecentAuthIntent | TotpRecoveryRecentAuthIntent;

export interface SessionIdentity {
  wallet: string;
  sessionId: string;
}

interface RecentAuthBaseClaims extends JWTPayload {
  sub: string;
  sid: string;
  purpose: RecentAuthPurpose;
  kind: 'challenge' | 'grant';
}

export interface RecentAuthChallengeClaims extends RecentAuthBaseClaims {
  kind: 'challenge';
  nonce: string;
  intent?: RecentAuthIntent;
}

interface RecentAuthGrantClaims extends RecentAuthBaseClaims {
  kind: 'grant';
  intentHash?: string;
}

const RECENT_AUTH_ISSUER = 'shardkeep-api';
const RECENT_AUTH_AUDIENCE = 'shardkeep:recent-auth';
const RECENT_AUTH_TOKEN_TYPE = 'reauth+jwt';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth preHandler — the verified wallet pubkey. */
    wallet: string;
    /** DB-active session jti. Sensitive grants are bound to this exact session. */
    sessionId: string;
    /** True only on the narrowly scoped login/recovery authentication path. */
    loginPending?: boolean;
  }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateLoginRecovery: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    assertRecentAuth: (
      req: FastifyRequest,
      purpose: RecentAuthPurpose,
      intent?: RecentAuthIntent,
    ) => Promise<void>;
    /** After authenticate: 402 LAND_NOT_OWNED unless this wallet bought its land. */
    requireLandOwned: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

type SessionVerificationConfig = Pick<Config, 'JWT_SECRET' | 'ALPHA_WALLETS' | 'ADMIN_WALLETS' | 'PLAYTEST_OPEN'>;

function secretBytes(config: Pick<Config, 'JWT_SECRET'>): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

export async function issueSessionJwt(config: Config, wallet: string, sessionId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(wallet)
    .setJti(sessionId)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + SESSION_TTL_SEC)
    .sign(secretBytes(config));
}

/** Decode only. Every request caller must use verifyActiveSession below. */
async function decodeSessionJwt(config: SessionVerificationConfig, token: string): Promise<SessionIdentity> {
  try {
    const { payload } = await jwtVerify(token, secretBytes(config), { algorithms: ['HS256'] });
    if (
      typeof payload.sub !== 'string' || payload.sub.length === 0
      || typeof payload.jti !== 'string' || !UUID_RE.test(payload.jti)
    ) {
      throw new Error('missing session identity');
    }
    return { wallet: payload.sub, sessionId: payload.jti };
  } catch {
    throw new HttpError(401, 'invalid or expired session');
  }
}

/**
 * A JWT is only the cookie envelope. The sessions row is the revocation and
 * expiry authority, so logout takes effect even when an attacker retained the
 * old cookie and DB expiry cannot drift behind the token's seven-day exp.
 */
export async function verifyActiveSession(config: SessionVerificationConfig, db: Db, token: string): Promise<SessionIdentity> {
  const identity = await decodeSessionJwt(config, token);
  const [active] = await db.select({ id: sessions.id }).from(sessions)
    .innerJoin(players, eq(players.wallet, sessions.wallet)).where(and(
    eq(sessions.id, identity.sessionId),
    eq(sessions.wallet, identity.wallet),
    eq(sessions.scope, 'full'),
    or(eq(players.loginTotpRequired, false), isNotNull(sessions.loginMfaAt)),
    isNull(sessions.revokedAt),
    gt(sessions.expiresAt, new Date()),
  )).limit(1);
  if (!active) throw new HttpError(401, 'invalid or expired session');
  return identity;
}

/** Separate key, audience, type and DB scope: a login proof is never gameplay
 * authentication, even if copied into the normal cookie by an attacker. */
function loginKey(config: Config): Uint8Array {
  return createHash('sha256').update('shardkeep:login-pending:v1\0').update(config.JWT_SECRET).digest();
}

export async function issueLoginJwt(config: Config, wallet: string, sessionId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'login+jwt' })
    .setIssuer('shardkeep-api').setAudience('shardkeep:login')
    .setSubject(wallet).setJti(sessionId).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + LOGIN_AUTH.pendingTtlSec)
    .sign(loginKey(config));
}

export async function verifyPendingLogin(config: Config, db: Db, token: string): Promise<SessionIdentity> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, loginKey(config), {
      algorithms: ['HS256'], issuer: 'shardkeep-api', audience: 'shardkeep:login',
      requiredClaims: ['sub', 'jti', 'iat', 'exp'],
    });
    if (protectedHeader.typ !== 'login+jwt' || typeof payload.sub !== 'string'
      || typeof payload.jti !== 'string' || !UUID_RE.test(payload.jti)) throw new Error('invalid login');
    const [active] = await db.select({ id: sessions.id }).from(sessions)
      .innerJoin(players, eq(players.wallet, sessions.wallet)).where(and(
        eq(sessions.id, payload.jti), eq(sessions.wallet, payload.sub),
        eq(sessions.scope, 'login_pending'), eq(players.loginTotpRequired, true),
        isNull(sessions.revokedAt), gt(sessions.expiresAt, new Date()),
      )).limit(1);
    if (!active) throw new Error('expired login');
    return { wallet: payload.sub, sessionId: payload.jti };
  } catch {
    throw new HttpError(401, 'login verification expired — sign in again', 'LOGIN_EXPIRED');
  }
}

const LOGIN_RECOVERY_ROUTES = new Set([
  'GET /auth/login/status', 'POST /auth/login/verify', 'POST /auth/logout', 'GET /2fa/status',
  'POST /auth/reauth/challenge', 'POST /auth/reauth/verify',
  'POST /2fa/totp/recovery/start', 'POST /2fa/totp/recovery/confirm',
  'POST /2fa/totp/recovery/cancel', 'POST /2fa/totp/recovery/complete/send-code',
  'POST /2fa/totp/recovery/complete',
]);
const LOGIN_REPLACEMENT_ROUTES = new Set([
  'POST /2fa/step-up/email', 'POST /2fa/totp/enroll', 'POST /2fa/totp/verify',
]);

export async function assertLoginProofPurpose(db: Db, req: FastifyRequest, purpose: RecentAuthPurpose): Promise<void> {
  if (!req.loginPending || purpose === 'totp_recovery') return;
  if (purpose === 'factor_change') {
    const [player] = await db.select({ replacement: players.totpReenrollmentRequired })
      .from(players).where(eq(players.wallet, req.wallet));
    if (player?.replacement) return;
  }
  throw new HttpError(403, 'complete login verification first', 'LOGIN_TOTP_REQUIRED');
}

export function makeAuthenticateLoginRecovery(config: Config, db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const pending = req.cookies[LOGIN_COOKIE];
    if (!pending) return makeAuthenticate(config, db)(req, reply);
    const route = `${req.method} ${req.routeOptions.url}`;
    if (!LOGIN_RECOVERY_ROUTES.has(route) && !LOGIN_REPLACEMENT_ROUTES.has(route)) {
      throw new HttpError(403, 'complete login verification first', 'LOGIN_TOTP_REQUIRED');
    }
    const identity = await verifyPendingLogin(config, db, pending);
    req.wallet = identity.wallet;
    req.sessionId = identity.sessionId;
    req.loginPending = true;
    if (LOGIN_REPLACEMENT_ROUTES.has(route)) await assertLoginProofPurpose(db, req, 'factor_change');
  };
}

function isPurpose(v: unknown): v is RecentAuthPurpose {
  return v === 'factor_change' || v === 'key_export' || v === 'withdrawal'
    || v === 'admin_mail_reward' || v === 'totp_recovery';
}

function isWithdrawalIntent(v: unknown): v is WithdrawalRecentAuthIntent {
  if (!v || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  if (i['version'] !== 1
    || typeof i['grossAmount'] !== 'string' || !/^\d+$/.test(i['grossAmount'])
    || typeof i['feeBurned'] !== 'string' || !/^\d+$/.test(i['feeBurned'])
    || typeof i['netAmount'] !== 'string' || !/^\d+$/.test(i['netAmount'])) return false;
  const gross = BigInt(i['grossAmount']);
  const fee = BigInt(i['feeBurned']);
  const net = BigInt(i['netAmount']);
  return gross > 0n && fee >= 0n && fee <= gross && net === gross - fee
    && (i['cluster'] === 'devnet' || i['cluster'] === 'mainnet-beta')
    && typeof i['keepMint'] === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(i['keepMint'])
    && typeof i['destination'] === 'string' && i['destination'].length >= 32 && i['destination'].length <= 64
    && typeof i['idempotencyKey'] === 'string'
    && WITHDRAWAL_IDEMPOTENCY_KEY_RE.test(i['idempotencyKey'])
    && (i['mode'] === 'standard' || i['mode'] === 'instant')
    && typeof i['unbondingHours'] === 'number' && Number.isInteger(i['unbondingHours'])
    && i['unbondingHours'] >= 0
    && (i['mode'] === 'instant' ? i['unbondingHours'] === 0 : i['unbondingHours'] > 0);
}

function isAdminMailRewardIntent(v: unknown): v is AdminMailRewardRecentAuthIntent {
  if (!v || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  const attachments = i['attachments'];
  const validAttachments = Array.isArray(attachments) && attachments.length > 0
    && attachments.length <= MAIL.maxAttachments
    && attachments.every((attachment: unknown) => {
      if (!attachment || typeof attachment !== 'object') return false;
      const a = attachment as Record<string, unknown>;
      if (a['kind'] === 'KEEP' || a['kind'] === 'SHARDS') {
        const max = a['kind'] === 'KEEP' ? MAIL.rewardKeepMax : MAIL.rewardShardsMax;
        return typeof a['amount'] === 'string' && /^\d+$/.test(a['amount'])
          && BigInt(a['amount']) > 0n && BigInt(a['amount']) <= BigInt(max);
      }
      return a['kind'] === 'ITEM'
        && typeof a['itemId'] === 'string'
        && MAIL.approvedStackableConsumableIds.includes(a['itemId'] as never)
        && typeof a['qty'] === 'number' && Number.isInteger(a['qty'])
        && a['qty'] > 0 && a['qty'] <= MAIL.rewardConsumableQtyMax;
    });
  return typeof i['recipientWallet'] === 'string' && i['recipientWallet'].length >= 32
    && i['recipientWallet'].length <= 44
    && typeof i['idempotencyKey'] === 'string'
    && WITHDRAWAL_IDEMPOTENCY_KEY_RE.test(i['idempotencyKey'])
    && typeof i['subject'] === 'string' && i['subject'].trim() === i['subject']
    && i['subject'].length > 0 && [...i['subject']].length <= MAIL.subjectMaxChars
    && validAttachments
    && typeof i['contentHash'] === 'string' && /^[0-9a-f]{64}$/.test(i['contentHash']);
}

function isTotpRecoveryIntent(v: unknown): v is TotpRecoveryRecentAuthIntent {
  if (!v || typeof v !== 'object') return false;
  const i = v as Record<string, unknown>;
  return typeof i['recoveryId'] === 'string' && UUID_RE.test(i['recoveryId'])
    && (i['action'] === 'start' || i['action'] === 'complete');
}

/** One canonical representation on both challenge issuance and action check. */
export function recentAuthIntentHash(intent: RecentAuthIntent): string {
  const canonical = 'grossAmount' in intent ? [
      'withdrawal:v1', intent.grossAmount, intent.feeBurned, intent.netAmount,
      intent.cluster, intent.keepMint, intent.destination, intent.idempotencyKey,
      intent.mode, intent.unbondingHours,
    ] : 'recoveryId' in intent ? [
      'totp-recovery:v1', intent.recoveryId, intent.action,
    ] : [
      'admin_mail_reward', intent.recipientWallet, intent.idempotencyKey,
      intent.subject, intent.attachments, intent.contentHash,
    ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Issue a signed challenge envelope. It needs no DB row: replaying the same
 * wallet signature can only recreate a grant with this envelope's ORIGINAL
 * expiry, so replay never extends freshness. Both challenge and grant remain
 * useless after the bound sessions row is revoked.
 */
export async function issueRecentAuthChallenge(
  config: Config,
  identity: SessionIdentity,
  purpose: RecentAuthPurpose,
  intent?: RecentAuthIntent,
): Promise<{ challengeToken: string; claims: RecentAuthChallengeClaims; expiresAt: Date }> {
  if ((purpose === 'withdrawal' || purpose === 'admin_mail_reward' || purpose === 'totp_recovery') && !intent) {
    throw new HttpError(400, 'this recent-auth purpose requires an intent');
  }
  if (purpose !== 'withdrawal' && purpose !== 'admin_mail_reward' && purpose !== 'totp_recovery' && intent) {
    throw new HttpError(400, 'this recent-auth purpose does not accept an intent');
  }
  if (purpose === 'withdrawal' && intent && !isWithdrawalIntent(intent)) {
    throw new HttpError(400, 'invalid withdrawal recent-auth intent');
  }
  if (purpose === 'admin_mail_reward' && intent && !('contentHash' in intent)) {
    throw new HttpError(400, 'invalid admin mail recent-auth intent');
  }
  if (purpose === 'totp_recovery' && !isTotpRecoveryIntent(intent)) {
    throw new HttpError(400, 'invalid authenticator-recovery recent-auth intent');
  }
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + RECENT_AUTH_TTL_SEC;
  const claims: RecentAuthChallengeClaims = {
    kind: 'challenge',
    sub: identity.wallet,
    sid: identity.sessionId,
    purpose,
    nonce: randomBytes(24).toString('hex'),
    ...(intent ? { intent } : {}),
    iat: issuedAt,
    exp: expiresAt,
    iss: RECENT_AUTH_ISSUER,
    aud: RECENT_AUTH_AUDIENCE,
  };
  const challengeToken = await new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256', typ: RECENT_AUTH_TOKEN_TYPE })
    .sign(secretBytes(config));
  return { challengeToken, claims, expiresAt: new Date(expiresAt * 1000) };
}

async function decodeRecentAuthToken(
  config: Config,
  token: string,
  kind: 'challenge' | 'grant',
  currentDate?: Date,
): Promise<RecentAuthChallengeClaims | RecentAuthGrantClaims> {
  try {
    const { payload, protectedHeader } = await jwtVerify(token, secretBytes(config), {
      algorithms: ['HS256'],
      issuer: RECENT_AUTH_ISSUER,
      audience: RECENT_AUTH_AUDIENCE,
      ...(currentDate ? { currentDate } : {}),
    });
    if (protectedHeader.typ !== RECENT_AUTH_TOKEN_TYPE || payload['kind'] !== kind
      || typeof payload.sub !== 'string' || typeof payload['sid'] !== 'string'
      || !isPurpose(payload['purpose']) || typeof payload.iat !== 'number'
      || typeof payload.exp !== 'number') {
      throw new Error('invalid recent-auth claims');
    }
    if (kind === 'challenge') {
      if (typeof payload['nonce'] !== 'string') throw new Error('missing challenge nonce');
      if (payload['purpose'] === 'withdrawal') {
        if (!isWithdrawalIntent(payload['intent'])) throw new Error('invalid challenge intent');
      } else if (payload['purpose'] === 'admin_mail_reward') {
        if (!isAdminMailRewardIntent(payload['intent'])) throw new Error('invalid challenge intent');
      } else if (payload['purpose'] === 'totp_recovery') {
        if (!isTotpRecoveryIntent(payload['intent'])) throw new Error('invalid challenge intent');
      } else if (payload['intent'] !== undefined) {
        throw new Error('unexpected challenge intent');
      }
      return payload as RecentAuthChallengeClaims;
    }
    if (payload['intentHash'] !== undefined && typeof payload['intentHash'] !== 'string') {
      throw new Error('invalid grant intent');
    }
    return payload as RecentAuthGrantClaims;
  } catch {
    throw new HttpError(428, 'confirm this sensitive action with your wallet again', 'RECENT_AUTH_REQUIRED');
  }
}

export async function readRecentAuthChallenge(
  config: Config,
  token: string,
  identity: SessionIdentity,
): Promise<RecentAuthChallengeClaims> {
  const claims = await decodeRecentAuthToken(config, token, 'challenge') as RecentAuthChallengeClaims;
  if (claims.sub !== identity.wallet || claims.sid !== identity.sessionId) {
    throw new HttpError(428, 'confirm this sensitive action with your wallet again', 'RECENT_AUTH_REQUIRED');
  }
  return claims;
}

/** Worker-side verification uses the database submission timestamp rather than
 * payout time: a standard withdrawal is intentionally signed 24h before it is
 * eligible, while the challenge itself is valid for only five minutes. */
export async function readWithdrawalAuthChallengeAt(
  config: Config,
  token: string,
  identity: SessionIdentity,
  submittedAt: Date,
): Promise<RecentAuthChallengeClaims> {
  const claims = await decodeRecentAuthToken(
    config, token, 'challenge', submittedAt,
  ) as RecentAuthChallengeClaims;
  if (claims.purpose !== 'withdrawal' || claims.sub !== identity.wallet
      || claims.sid !== identity.sessionId || !claims.intent
      || !('grossAmount' in claims.intent)) {
    throw new HttpError(428, 'invalid withdrawal authorization', 'RECENT_AUTH_REQUIRED');
  }
  return claims;
}

export async function issueRecentAuthGrant(
  config: Config,
  challenge: RecentAuthChallengeClaims,
): Promise<{ grant: string; expiresAt: Date }> {
  // The challenge decoder requires exp. Inheriting it (rather than `now + TTL`)
  // is what makes a replay equivalent to the already-issued capability.
  const expiresAt = challenge.exp!;
  const grantClaims: RecentAuthGrantClaims = {
    kind: 'grant',
    sub: challenge.sub,
    sid: challenge.sid,
    purpose: challenge.purpose,
    ...(challenge.intent ? { intentHash: recentAuthIntentHash(challenge.intent) } : {}),
  };
  const grant = await new SignJWT(grantClaims)
    .setProtectedHeader({ alg: 'HS256', typ: RECENT_AUTH_TOKEN_TYPE })
    .setIssuer(RECENT_AUTH_ISSUER)
    .setAudience(RECENT_AUTH_AUDIENCE)
    .setIssuedAt(challenge.iat)
    .setExpirationTime(expiresAt)
    .setJti(challenge.nonce)
    .sign(secretBytes(config));
  return { grant, expiresAt: new Date(expiresAt * 1000) };
}

/**
 * Assert a grant after app.authenticate. 428 is deliberate: the session is
 * valid, so this must prompt a wallet signature without triggering the web
 * client's global 401 logout handler.
 */
export async function assertRecentAuth(
  config: Config,
  req: FastifyRequest,
  purpose: RecentAuthPurpose,
  intent?: RecentAuthIntent,
): Promise<void> {
  const raw = req.headers[RECENT_AUTH_HEADER];
  if (typeof raw !== 'string' || !req.wallet || !req.sessionId) {
    throw new HttpError(428, 'confirm this sensitive action with your wallet again', 'RECENT_AUTH_REQUIRED');
  }
  const claims = await decodeRecentAuthToken(config, raw, 'grant') as RecentAuthGrantClaims;
  const expectedIntentHash = intent ? recentAuthIntentHash(intent) : undefined;
  if (
    claims.sub !== req.wallet || claims.sid !== req.sessionId || claims.purpose !== purpose
    || claims.intentHash !== expectedIntentHash
  ) {
    throw new HttpError(428, 'confirm this sensitive action with your wallet again', 'RECENT_AUTH_REQUIRED');
  }
}

/**
 * Closed-alpha gate. Unset ALPHA_WALLETS ⇒ always allowed (see config.ts).
 *
 * v2 (invite codes, 2026-08-05): allowed = env ALPHA_WALLETS ∪ env ADMIN_WALLETS
 * ∪ the alpha_access TABLE (where invite-code redemptions land — game/alpha.ts).
 * The env fast paths cost no DB read; the table check is a point SELECT on the
 * PK, never a scan. ADMIN_WALLETS is in the union because the /admin/alpha
 * review panel sits behind this same authenticate chain — an admin not also
 * pasted into ALPHA_WALLETS would be locked out of the very tool that lets
 * players in.
 *
 * 403, never 401. A 401 from an authenticated route makes the client force-logout
 * and toast "SESSION EXPIRED — SIGN IN AGAIN" (apps/web/src/lib/api.ts →
 * ui/Overlay.tsx), which is a lie that hides the real reason and produces an
 * endless bounce back to the connect screen. 403 renders the server's own message
 * verbatim, so a stranger reads why and the owner is not debugging a phantom
 * session bug. The codebase already documents this exact trap for the key-export
 * route, and 403 is already its authorization-failure code.
 *
 * The 403 carries code 'ALPHA_GATED' (machine-readable, app.ts error handler)
 * so the client can branch to the invite-redeem UI instead of a dead end.
 */
export async function assertAlphaAccess(config: SessionVerificationConfig, db: Db, wallet: string): Promise<void> {
  if (config.PLAYTEST_OPEN === 'true') return;
  if (!config.ALPHA_WALLETS) return; // unset = OPEN, deliberately (config.ts)
  if (config.ALPHA_WALLETS.includes(wallet)) return;
  if (config.ADMIN_WALLETS?.includes(wallet)) return;
  const [row] = await db.select({ wallet: alphaAccess.wallet }).from(alphaAccess)
    .where(eq(alphaAccess.wallet, wallet)).limit(1);
  if (row) return;
  throw new HttpError(
    403,
    'playtest access needed — this wallet has no invite yet. Redeem an invite code to enter.',
    'ALPHA_GATED',
  );
}

/** preHandler factory: `{ preHandler: app.authenticate }` guards a route. */
export function makeAuthenticate(config: SessionVerificationConfig, db: Db) {
  return async function authenticate(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = req.cookies[SESSION_COOKIE];
    if (req.cookies[LOGIN_COOKIE]) {
      throw new HttpError(403, 'enter your PKW authenticator code to finish signing in', 'LOGIN_TOTP_REQUIRED');
    }
    if (!token) throw new HttpError(401, 'authentication required');
    const identity = await verifyActiveSession(config, db, token);
    req.wallet = identity.wallet;
    req.sessionId = identity.sessionId;
    // Both revocation authorities live here: sessions.revokedAt/expiry evicts a
    // stolen cookie after logout, and alpha_access deletion evicts game access.
    // They are separate checks because an alpha denial is a truthful 403 while a
    // dead session is a 401 that should return the client to sign-in.
    await assertAlphaAccess(config, db, req.wallet);
  };
}

/**
 * THE LAND GATE (docs/LAND-DEED-ONBOARDING-PLAN.md §2.1) — formerly
 * `makeRequireEntryPaid`. Same five lines, same column, same query; what changed
 * is WHAT it gates. Onboarding is no longer a paywall: a new player builds a base
 * for FREE. Buying land (0.2 SOL on-chain) is what unlocks the Gold Forge,
 * selling on the market, raiding landowners, PvE bounty raids and clans.
 *
 * `players.entryPaidAt` KEEPS ITS EXACT MEANING — "this wallet paid 0.2 SOL
 * on-chain" — which is why there is no new column: deedMetadata's Founded trait,
 * the deposit watcher's stamp, baseTransfer and ~20 tests need no diff. Reusing
 * the column IS the non-regression property.
 *
 * NOT gated on `deedAssetId`: `mintDeedIfConfigured` swallows every error and
 * no-ops without a minter (game/deed.ts), so gating on the NFT would lock a
 * PAYING player out of what they bought. Authorization reads the server column;
 * the NFT is the receipt.
 *
 * Deliberately a per-request lookup, not a JWT claim — payment usually lands
 * AFTER the session was issued, and a stale claim would lock landowners out.
 *
 * 402 carries code 'LAND_NOT_OWNED' (machine-readable, app.ts error handler)
 * following the ALPHA_GATED precedent above, so the client routes to the
 * buy-land screen instead of toasting a bare error message it cannot act on.
 *
 * THE MESSAGE AND CODE ARE NOT BEHIND FREE_ONBOARDING, AND THAT IS DELIBERATE
 * (security review F2, 2026-08-09). The flag's promise is about authorization and
 * about what exists — see the narrowed guarantee in config.ts — not about response
 * strings. Making the 402 flag-dependent would buy nothing and cost two things:
 * the client would need one 402 contract per flag state (before this change there
 * was NO 402 handler at all, so today's client toasts either way), and the hottest
 * gate in the game would read the env on every request. Both flag states want the
 * same outcome from a landless caller — go buy your land — so both say so.
 * test/land-gate.test.ts asserts this shape with the flag OFF as well as ON.
 */
export function makeRequireLandOwned(db: Db) {
  return async function requireLandOwned(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (multiBaseEnabled()) {
      const stable = await db.select({
        id: bases.id,
        landPaidAt: bases.landPaidAt,
        deedAssetId: bases.deedAssetId,
        deedMintAssetId: bases.deedMintAssetId,
      }).from(baseSlots)
        .innerJoin(bases, eq(bases.id, baseSlots.baseId))
        .where(and(
          eq(baseSlots.wallet, req.wallet), eq(baseSlots.active, true),
          eq(bases.status, 'active'),
        ));
      if (!stable.some((base) => base.landPaidAt !== null)) {
        throw new HttpError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');
      }
      if (stable.some((base) => !base.deedAssetId && base.deedMintAssetId)) {
        throw new HttpError(
          503,
          'deed mint is pending exact on-chain recovery; land authority is quarantined',
          'DEED_AUTHORITY_UNAVAILABLE',
        );
      }
      return;
    }
    const [row] = await db.select({
      entryPaidAt: players.entryPaidAt,
      deedAssetId: players.deedAssetId,
      deedMintAssetId: players.deedMintAssetId,
    })
      .from(players).where(eq(players.wallet, req.wallet));
    if (!row?.entryPaidAt) {
      throw new HttpError(402, 'buy your land to unlock this', 'LAND_NOT_OWNED');
    }
    // A paid player with no configured/working minter has both ids null and is
    // still entitled to play. A nonnull reservation is different: the exact
    // deed may already have landed and transferred after an ambiguous RPC
    // failure, so the legacy wallet authority is quarantined until recovery.
    if (!row.deedAssetId && row.deedMintAssetId) {
      throw new HttpError(
        503,
        'deed mint is pending exact on-chain recovery; land authority is quarantined',
        'DEED_AUTHORITY_UNAVAILABLE',
      );
    }
  };
}
