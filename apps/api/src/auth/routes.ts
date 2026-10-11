/**
 * SIWS-style wallet auth (ARCHITECTURE §5, GDD §4.9 "the wallet IS the identity"):
 * GET /auth/challenge → single-use 5-min nonce; wallet signs the canonical
 * message; POST /auth/verify → ed25519 verify → players upsert → httpOnly JWT.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { verifyAsync } from '@noble/ed25519';
import bs58 from 'bs58';
import { and, desc, eq, gt, gte, isNull, lt, ne, notExists, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { GRID, MAIL, PROFILE_AVATAR, SEEKER, TWOFA, WARZONE } from '@shardkeep/shared';
import { devLoginRealm, fantasyWorldEnabled, gemsEnabled, multiBaseEnabled, type Config } from '../config';
import { identifyDevice, serverTrack } from '../telemetry';
import type { Db } from '../db/client';
import { authNonces, builderJobs, nativePushRevocations, nativePushSubscriptions, obstacles, players, privyIdentities, sessions } from '../db/schema';
import { ensureStartingBase } from '../game/base';
import { getGameConfig, setShieldlessMode } from '../game/gameConfig';
import { isWarzoneActive } from '../game/warzone';
import { ensureBasePlotAssigned, ensurePlotAssigned } from '../game/world';
import { ensureWalletBaseIdentity, hasActivePaidStableBase, resolveActiveBase } from '../game/baseOwnership';
import { HttpError } from '../lib/errors';
import { currentKeepMint } from '../money/mintDimension';
import { lockWithdrawalWalletTx } from '../money/withdrawalLock';
import { parse } from '../lib/validation';
import { checkUsername, cooldownDaysLeft, setUsername } from '../game/username';
import {
  acquireAvatarRawUploadPermit, AVATAR_MAX_UPLOAD_BYTES, AvatarBusyError,
  AvatarInputError, avatarObjectKey, clearPlayerAvatar, serializeAvatar,
  readPublicAvatar, uploadPlayerAvatar, withAvatarReadPermit, withAvatarStorageDeadline,
  type AvatarStorage,
} from '../game/playerAvatar';
import {
  adoptDiscoveredSkr, createLinkChallenge, resolveSeeker, unlinkSeeker,
  verifyAndLinkSeeker, type LinkDeps,
} from './seeker';
import { buildRecentAuthMessage, buildSignInMessage } from './message';
import {
  LOGIN_COOKIE, SESSION_COOKIE, SESSION_TTL_SEC, assertRecentAuth, assertLoginProofPurpose, issueRecentAuthChallenge,
  issueRecentAuthGrant, issueSessionJwt, readRecentAuthChallenge, verifyActiveSession, verifyPendingLogin,
  WITHDRAWAL_IDEMPOTENCY_KEY_RE,
} from './session';
import {
  consoleEmailSender, get2faStatus, sendWithdrawEmailCode, verifyKeyExport2fa, type EmailSender,
} from './twofa';
import { getTotpRecoveryStatus } from './totpRecovery';
import { makeSocialTokenVerifier, type SocialTokenVerifier } from './social';
import { completeLogin, insertLoginSessionTx, sendLoginSession, setLoginProtection } from './loginProtection';

export const NONCE_TTL_MS = 5 * 60 * 1000;
const keyExportEmailContext = (sessionId: string): string =>
  JSON.stringify(['key-export:v1', sessionId]);

const WalletSchema = z.string().min(32).max(44);
/** Which shell signed in (D-103 statistics cohort). The web sends it; the
 *  value is descriptive only and grants nothing. */
const SignInClientSchema = z.enum(['solana-mobile', 'browser']);
const ChallengeQuerySchema = z.object({ wallet: WalletSchema });
const VerifyBodySchema = z.object({
  wallet: WalletSchema,
  signature: z.string().min(1),
  // Optional for one backwards-compatible rollout: current web clients send it,
  // while cached/TWA clients can still verify the one stable active challenge.
  nonce: z.string().regex(/^[0-9a-f]{48}$/).optional(),
  // D-103 cohort tag from the web (`?client=solana-mobile` / the installed
  // shell). Recorded on the session and, for a first sign-in, the player;
  // NEVER an access decision — Seeker verification stays the SGT check.
  client: SignInClientSchema.optional(),
  // The client's persisted analytics device id (apps/web/src/lib/analytics.ts).
  // Lets the relay join this device's pre-auth history to the wallet pseudonym
  // with one `$identify`; NEVER stored, NEVER an access input.
  deviceId: z.string().regex(/^[A-Za-z0-9-]{8,36}$/).optional(),
});
const AdminMailRewardAttachment = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('KEEP'),
    amount: z.string().regex(/^\d+$/).max(String(MAIL.rewardKeepMax).length)
      .refine((amount) => BigInt(amount) > 0n && BigInt(amount) <= BigInt(MAIL.rewardKeepMax)),
  }),
  z.object({
    kind: z.literal('SHARDS'),
    amount: z.string().regex(/^\d+$/).max(String(MAIL.rewardShardsMax).length)
      .refine((amount) => BigInt(amount) > 0n && BigInt(amount) <= BigInt(MAIL.rewardShardsMax)),
  }),
  z.object({
    kind: z.literal('ITEM'),
    itemId: z.enum(MAIL.approvedStackableConsumableIds),
    qty: z.number().int().positive().max(MAIL.rewardConsumableQtyMax),
  }),
]);
const RecentAuthChallengeBody = z.discriminatedUnion('purpose', [
  z.object({ purpose: z.literal('factor_change') }),
  z.object({ purpose: z.literal('key_export') }),
  z.object({
    purpose: z.literal('totp_recovery'),
    intent: z.object({
      recoveryId: z.uuid(),
      action: z.enum(['start', 'complete']),
    }),
  }),
  z.object({
    purpose: z.literal('withdrawal'),
    intent: z.object({
      version: z.literal(1),
      grossAmount: z.string().regex(/^\d+$/),
      feeBurned: z.string().regex(/^\d+$/),
      netAmount: z.string().regex(/^\d+$/),
      cluster: z.enum(['devnet', 'mainnet-beta']),
      keepMint: WalletSchema,
      destination: z.string().min(32).max(64),
      idempotencyKey: z.string().regex(WITHDRAWAL_IDEMPOTENCY_KEY_RE),
      mode: z.enum(['standard', 'instant']),
      unbondingHours: z.number().int().nonnegative(),
    }),
  }),
  z.object({
    purpose: z.literal('admin_mail_reward'),
    intent: z.object({
      recipientWallet: WalletSchema,
      idempotencyKey: z.string().regex(WITHDRAWAL_IDEMPOTENCY_KEY_RE),
      subject: z.string().trim().min(1)
        .refine((subject) => [...subject].length <= MAIL.subjectMaxChars),
      attachments: z.array(AdminMailRewardAttachment).min(1).max(MAIL.maxAttachments),
      contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  }),
]);
const RecentAuthVerifyBody = z.object({
  challengeToken: z.string().min(32).max(4096),
  signature: z.string().min(1).max(256),
});
/** #46 warzone lever body: mode switch + optional purge-window length (hours). */
const WarzoneBody = z.object({
  mode: z.enum(['off', 'scheduled', 'purge']),
  hours: z.number().int().positive().max(720).optional(),
});

/** Opaque avatar reads carry two independent fail-closed buckets. Route config
 * replaces the global limiter, so the IP bucket must be explicit and onRequest;
 * the wallet bucket is applied manually only after authentication. Exported so
 * focused tests exercise the real keys, limits and hook ordering. */
export const AVATAR_READ_RATE_LIMITS = {
  ip: {
    max: PROFILE_AVATAR.readIpAbuseLimitPerMin,
    timeWindow: 60_000,
    hook: 'onRequest' as const,
    keyGenerator: (req: FastifyRequest): string => `avatar-read-ip:${req.ip}`,
    skipOnError: false,
  },
  wallet: {
    max: PROFILE_AVATAR.readWalletLimitPerMin,
    timeWindow: 60_000,
    keyGenerator: (req: FastifyRequest): string => `avatar-read-wallet:${req.wallet}`,
    skipOnError: false,
  },
} as const;

/** base58-decode a wallet, enforcing a 32-byte ed25519 pubkey. */
function decodeWallet(wallet: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(wallet);
  } catch {
    throw new HttpError(400, 'wallet is not valid base58');
  }
  if (bytes.length !== 32) throw new HttpError(400, 'wallet must be a 32-byte ed25519 pubkey');
  return bytes;
}

/** Optional wiring for the auth surface (tests inject a fake mainnet). */
export interface AuthDeps {
  socialTokenVerifier?: SocialTokenVerifier | undefined;
  /** Transport used for the read-only MAINNET Seeker reads. Defaults to global
   *  fetch; tests substitute a fake so the SGT predicate is exercised without a
   *  live validator. */
  seekerFetch?: typeof fetch | undefined;
  /** Email transport for the key-export email challenge (POST /auth/export/
   *  send-code). Same provider the game routes use for 2FA; falls back to the
   *  console sender so dev/test work without an email service. */
  emailSender?: EmailSender | undefined;
  /** Public wallet-avatar object store. Omitted means uploads answer 503;
   * existing reads can still use avatarPublicBaseUrl. Tests inject a putter. */
  avatarStorage?: AvatarStorage | undefined;
  /** Read-only URL remains usable if write credentials are absent/down. */
  avatarPublicBaseUrl?: string | undefined;
  /** Focused lifecycle-test override. Production always uses the shared bound. */
  avatarUploadReceiveTimeoutMs?: number | undefined;
}

export function registerAuthRoutes(
  app: FastifyInstance, config: Config, db: Db, deps: AuthDeps = {},
): void {
  // The FIRST allowed origin is canonical: it is the host written into the
  // sign-in message the wallet displays to the user. Safe with several allowed
  // origins because the SERVER builds that message and the client signs it
  // verbatim (apps/web/src/auth/useAuth.ts) — the client never derives the
  // domain itself, so verification cannot disagree with it. Put the public host
  // first in WEB_ORIGIN so that is what players see when they sign.
  const domain = new URL(config.WEB_ORIGIN[0]!).host;

  // Tight limits on the unauthenticated auth surface (DB write per challenge,
  // ed25519 verify + ~6 queries per verify) — security review P0. Ops knob;
  // ignored under NODE_ENV=test where the limiter isn't registered.
  const authRateLimit = { config: { rateLimit: { max: 20, timeWindow: 60_000 } } };
  const verifySocial = deps.socialTokenVerifier ?? makeSocialTokenVerifier(config);

  app.get('/auth/options', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { socialTokenLogin: config.SOCIAL_TOKEN_LOGIN_ENABLED === 'true' };
  });

  app.post('/auth/social', authRateLimit, async (req, reply) => {
    if (config.SOCIAL_TOKEN_LOGIN_ENABLED !== 'true') throw new HttpError(404, 'not found');
    const body = parse(z.object({
      accessToken: z.string().min(32).max(32_768),
      identityToken: z.string().min(32).max(65_536),
      client: SignInClientSchema.optional(),
      deviceId: z.string().regex(/^[A-Za-z0-9-]{8,36}$/).optional(),
    }).strict(), req.body);
    const identity = await verifySocial(body.accessToken, body.identityToken);
    const issued = await db.transaction(async (tx) => {
      // Serialize a DID before its wallet so concurrent claims cannot split the
      // permanent identity binding. The UNIQUE wallet constraint is a backstop.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`privy:${identity.subject}`}, 0))`);
      await lockWithdrawalWalletTx(tx, identity.wallet);
      const [bound] = await tx.select().from(privyIdentities).where(eq(privyIdentities.subject, identity.subject));
      const [walletBound] = await tx.select().from(privyIdentities).where(eq(privyIdentities.wallet, identity.wallet));
      if ((bound && bound.wallet !== identity.wallet) || (walletBound && walletBound.subject !== identity.subject)) {
        throw new HttpError(409, 'this social identity has a conflicting wallet binding', 'SOCIAL_IDENTITY_CONFLICT');
      }
      const session = await insertLoginSessionTx(tx, identity.wallet, body.client);
      if (!bound) await tx.insert(privyIdentities).values(identity);
      return session;
    });
    if (!issued.loginRequired) serverTrack('login_completed', identity.wallet, { entryPaid: issued.entryPaid });
    identifyDevice(identity.wallet, body.deviceId);
    return sendLoginSession(reply, config, issued);
  });

  app.get('/auth/login/status', authRateLimit, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    const token = req.cookies[LOGIN_COOKIE];
    if (!token) return { loginRequired: false };
    try {
      const identity = await verifyPendingLogin(config, db, token);
      return { loginRequired: true, wallet: identity.wallet };
    } catch {
      reply.clearCookie(LOGIN_COOKIE, { path: '/' });
      return { loginRequired: false, expired: true };
    }
  });

  app.post('/auth/login/verify', { ...authRateLimit, preHandler: app.authenticateLoginRecovery }, async (req, reply) => {
    if (!req.loginPending) throw new HttpError(409, 'no login verification is pending');
    const { code } = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
    const issued = await completeLogin(db, { wallet: req.wallet, sessionId: req.sessionId }, code);
    serverTrack('login_completed', req.wallet, { entryPaid: issued.entryPaid });
    return sendLoginSession(reply, config, issued);
  });

  app.post('/auth/login/protection', { ...authRateLimit, preHandler: app.authenticate }, async (req) => {
    const { enabled, code } = parse(z.object({ enabled: z.boolean(), code: z.string().regex(/^\d{6}$/) }), req.body);
    await app.assertRecentAuth(req, 'factor_change');
    await setLoginProtection(db, { wallet: req.wallet, sessionId: req.sessionId }, enabled, code,
      config.TOTP_RECOVERY_ENABLED === 'true');
    return { loginTotpRequired: enabled };
  });

  // Seeker reads hit MAINNET (a third party) when a verdict has aged out, so
  // they get their own, tighter ceiling on top of the recheckHours reuse window
  // — security review F4, which measured 50 mainnet calls from 25 requests.
  const seekerReadLimit = {
    config: { rateLimit: { max: SEEKER.statusRefreshPerMin, timeWindow: 60_000 } },
  };

  // Mainnet-only reads, gated behind the caller's session AND (for linking) a
  // signature from the Seeker wallet. Declared up here because /me renders the
  // badge and therefore re-verifies it too.
  const seekerDeps: LinkDeps = {
    mainnetRpcUrl: config.SOLANA_MAINNET_RPC_URL,
    // Cross-check endpoint. Unset ⇒ verdicts are reported `unconfirmed`.
    mainnetRpcUrlSecondary: config.SOLANA_MAINNET_RPC_URL_2,
    fetchImpl: deps.seekerFetch,
  };

  const avatarReadWalletLimiter = config.NODE_ENV === 'test'
    ? null
    : app.createRateLimit(AVATAR_READ_RATE_LIMITS.wallet);
  const avatarReadWalletRateLimit = async (req: FastifyRequest): Promise<void> => {
    if (!avatarReadWalletLimiter) return;
    const limit = await avatarReadWalletLimiter(req);
    if (!limit.isAllowed && limit.isExceeded) {
      throw new HttpError(429, `avatar read limit reached; try again in ${limit.ttlInSeconds}s`);
    }
  };

  app.get('/auth/challenge', authRateLimit, async (req, reply) => {
    const { wallet } = parse(ChallengeQuerySchema, req.query);
    decodeWallet(wallet);

    // One active challenge per wallet/purpose. The transaction-scoped advisory
    // lock serializes concurrent requests across API replicas, so an anonymous
    // caller cannot invalidate a message after the player has signed it.
    const challenge = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(
        hashtextextended(${`auth-signin:${wallet}`}, 0)
      )`);

      const [active] = await tx.select().from(authNonces).where(and(
        eq(authNonces.wallet, wallet),
        eq(authNonces.purpose, 'signin'),
        isNull(authNonces.usedAt),
        gt(authNonces.expiresAt, new Date()),
      )).orderBy(desc(authNonces.issuedAt)).limit(1);
      if (active) return active;

      const nonce = randomBytes(24).toString('hex');
      const issuedAt = new Date(); // set in JS so the signed message round-trips exactly
      const expiresAt = new Date(issuedAt.getTime() + NONCE_TTL_MS);
      const [created] = await tx.insert(authNonces)
        .values({ wallet, nonce, issuedAt, expiresAt })
        .returning();
      if (!created) throw new Error('failed to create auth challenge');
      return created;
    });

    reply.header('Cache-Control', 'no-store');

    return {
      nonce: challenge.nonce,
      message: buildSignInMessage({
        domain, wallet, nonce: challenge.nonce, issuedAt: challenge.issuedAt,
      }),
      expiresAt: challenge.expiresAt.toISOString(),
    };
  });

  app.post('/auth/verify', authRateLimit, async (req, reply) => {
    const { wallet, signature, nonce, client, deviceId } = parse(VerifyBodySchema, req.body);
    const walletBytes = decodeWallet(wallet);
    // NO alpha gate here (invite codes, 2026-08-05). Sign-in must stay OPEN so a
    // code holder can mint the session that POST /alpha/redeem requires — gating
    // verify was a chicken-and-egg lockout for every invited player not in the
    // env list. The authoritative, revocable check stays in makeAuthenticate: a
    // stranger's session 403s (code ALPHA_GATED) on every authed route, so all
    // it can reach is the redeem endpoint. Strangers now accumulate players
    // rows; that is inherent to the access model and bounded by authRateLimit.

    let signatureBytes: Uint8Array;
    try {
      signatureBytes = bs58.decode(signature);
    } catch {
      throw new HttpError(400, 'signature is not valid base58');
    }
    if (signatureBytes.length !== 64) throw new HttpError(400, 'signature must be 64 bytes');

    const [challenge] = await db
      .select()
      .from(authNonces)
      .where(and(
        eq(authNonces.wallet, wallet),
        // SCOPE (2026-07-29): this table now also carries Seeker-link
        // challenges. Without this filter a link nonce — signed under a
        // DIFFERENT message — would be picked up here as "the latest
        // challenge", 401-ing a legitimate sign-in; and the reverse omission
        // would let a link signature mint a session for the Seeker wallet.
        eq(authNonces.purpose, 'signin'),
        nonce ? eq(authNonces.nonce, nonce) : undefined,
        isNull(authNonces.usedAt),
        gt(authNonces.expiresAt, new Date()),
      ))
      .orderBy(desc(authNonces.issuedAt))
      .limit(1);
    if (!challenge) throw new HttpError(401, 'no active challenge for this wallet');

    const message = buildSignInMessage({
      domain,
      wallet,
      nonce: challenge.nonce,
      issuedAt: challenge.issuedAt,
    });
    const valid = await verifyAsync(signatureBytes, new TextEncoder().encode(message), walletBytes);
    if (!valid) throw new HttpError(401, 'invalid signature');

    // Session issuance shares the recovery/custody wallet serialization root.
    // This closes the gap where recovery could revoke its snapshot of sessions
    // while an already-verified sign-in inserted a new row just afterward. A
    // sign-in is now wholly before or wholly after the recovery transition.
    /**
     * THE FREE-ONBOARDING FLIP (docs/LAND-DEED-ONBOARDING-PLAN.md P3) DOES NOT
     * HAPPEN HERE, AND MUST NOT (security review F3, 2026-08-09).
     *
     * The starting base is created by the first ALPHA-PASSING authenticated touch
     * — `GET /base`, which is in the FREE group when the flag is on and already
     * calls `ensureStartingBase` idempotently as its own self-heal. This route is
     * deliberately NOT alpha-gated (see above), so anything it creates can be
     * driven by a stranger holding nothing but a keypair. One `players` row was an
     * accepted cost of the invite model; a whole base is not: `ensureStartingBase`
     * writes a keep, ~189 deterministic obstacle rows, two ledger accounts and a
     * 500-shard `shard_genesis` posting, so at authRateLimit's 20/min/IP a stranger
     * with no invite code could mint ~28,800 full bases per day per IP and inflate
     * "shards ever minted" (game/economy.ts) with them. Sign-in stays a session
     * mint; `makeAuthenticate`'s closed-alpha check is the first thing that can
     * decide a wallet is allowed to exist in the world, so the world is built
     * behind it.
     *
     * ONLY THE BASE MOVED AT ALL. `ensurePlotAssigned` stays in the watcher
     * (money/depositWatcher.ts): NO LAND ⇒ NO PLOT is the locked owner decision,
     * and it is load-bearing rather than cosmetic — the valley roster is
     * `plots INNER JOIN players`, so a player with no plot produces NO map row and
     * cannot be found, scouted or raided by landowners.
     *
     * WHAT THE ATTACKABILITY INVARIANT IS NOW (restated truthfully, F9 2026-08-09).
     * INV-1 was `(base exists) × shield × warzone`; the land partition adds one
     * factor, so it is now
     *     (base exists) × shield × warzone × sameLandTier(attacker, defender)
     * — see game/land.ts. The substantive half of INV-1 is intact and is what
     * matters: NOTHING in the raid path reads deed or DAS state, so listing or
     * selling a deed can never change who may attack you (the ITEMS-plan §8
     * "list-to-dodge-attacks" fix). In legacy mode the tier input is
     * `players.entryPaidAt`; stable mode follows active `bases.landPaidAt` rows.
     * Paying moves you INTO the raidable paid pool, and a finalized base transfer
     * hands the parcel (and the exposure) to the buyer.
     *
     * The watcher's own `ensureStartingBase` call needs no diff either: it is
     * idempotent (returns early once a Keep exists), so for a player who already
     * built free it is a no-op, and for a wallet that paid before ever signing in
     * it is still what creates the base. Zero diff in money/* is the R3 guard.
     */
    const issued = await db.transaction(async (tx) => {
      await lockWithdrawalWalletTx(tx, wallet);

      // Consume the nonce in the same transaction as the session insert —
      // single-use even under concurrent verifies, with no half-issued login.
      const consumed = await tx.update(authNonces)
        .set({ usedAt: new Date() })
        .where(and(
          eq(authNonces.id, challenge.id),
          isNull(authNonces.usedAt),
          gt(authNonces.expiresAt, new Date()),
        ))
        .returning({ id: authNonces.id });
      if (consumed.length === 0) throw new HttpError(401, 'challenge already used');

      return insertLoginSessionTx(tx, wallet, client);
    });

    const response = await sendLoginSession(reply, config, issued);
    // Analytics (M23 a13): the authoritative login event, after the session
    // row exists. Fire-and-forget; a dark relay makes this a no-op.
    if (!issued.loginRequired) serverTrack('login_completed', wallet, { entryPaid: issued.entryPaid });
    // Join the device's anonymous funnel to this wallet — once per pair.
    identifyDevice(wallet, deviceId);
    return response;
  });

  // --- Fresh primary authentication ---------------------------------------
  // A seven-day cookie is convenient for play but is not fresh enough to
  // change account factors, export a key or bypass withdrawal unbonding. These
  // two endpoints reuse the session wallet's SIWS signer and issue a five-minute
  // server-signed capability bound to this exact DB-active session + purpose.
  app.post('/auth/reauth/challenge', {
    preHandler: app.authenticateLoginRecovery,
    ...authRateLimit,
  }, async (req) => {
    const body = parse(RecentAuthChallengeBody, req.body);
    await assertLoginProofPurpose(db, req, body.purpose);
    if (body.purpose === 'admin_mail_reward' && !config.ADMIN_WALLETS?.includes(req.wallet)) {
      throw new HttpError(config.ADMIN_WALLETS ? 403 : 404, config.ADMIN_WALLETS ? 'admin access required' : 'not found');
    }
    const intent = body.purpose === 'withdrawal' || body.purpose === 'admin_mail_reward'
      || body.purpose === 'totp_recovery'
      ? body.intent
      : undefined;
    if (body.purpose === 'withdrawal') {
      const selectedMint = currentKeepMint(config.SOLANA_CLUSTER);
      if (!selectedMint) throw new HttpError(503, 'KEEP withdrawal network is not configured');
      if (body.intent.cluster !== config.SOLANA_CLUSTER || body.intent.keepMint !== selectedMint) {
        throw new HttpError(409, 'withdrawal proof network does not match this deployment');
      }
    }
    const issued = await issueRecentAuthChallenge(config, {
      wallet: req.wallet,
      sessionId: req.sessionId,
    }, body.purpose, intent);
    const message = buildRecentAuthMessage({
      domain,
      wallet: req.wallet,
      sessionId: req.sessionId,
      purpose: body.purpose,
      nonce: issued.claims.nonce,
      issuedAt: new Date(issued.claims.iat! * 1000),
      expiresAt: issued.expiresAt,
      ...(intent ? { intent } : {}),
    });
    return {
      challengeToken: issued.challengeToken,
      message,
      expiresAt: issued.expiresAt.toISOString(),
    };
  });

  app.post('/auth/reauth/verify', {
    preHandler: app.authenticateLoginRecovery,
    ...authRateLimit,
  }, async (req) => {
    const body = parse(RecentAuthVerifyBody, req.body);
    const identity = { wallet: req.wallet, sessionId: req.sessionId };
    const challenge = await readRecentAuthChallenge(config, body.challengeToken, identity);
    await assertLoginProofPurpose(db, req, challenge.purpose);
    let signatureBytes: Uint8Array;
    try {
      signatureBytes = bs58.decode(body.signature);
    } catch {
      throw new HttpError(422, 'recent-auth signature is not valid base58');
    }
    if (signatureBytes.length !== 64) throw new HttpError(422, 'recent-auth signature must be 64 bytes');
    const message = buildRecentAuthMessage({
      domain,
      wallet: req.wallet,
      sessionId: req.sessionId,
      purpose: challenge.purpose,
      nonce: challenge.nonce,
      issuedAt: new Date(challenge.iat! * 1000),
      expiresAt: new Date(challenge.exp! * 1000),
      ...(challenge.intent ? { intent: challenge.intent } : {}),
    });
    const walletBytes = decodeWallet(req.wallet);
    const valid = await verifyAsync(signatureBytes, new TextEncoder().encode(message), walletBytes);
    // The SESSION is still valid, so a failed fresh proof is 422 rather than a
    // 401 that would incorrectly force-log-out the web client.
    if (!valid) throw new HttpError(422, 'invalid recent-auth signature');
    const granted = await issueRecentAuthGrant(config, challenge);
    return {
      grant: granted.grant,
      purpose: challenge.purpose,
      expiresAt: granted.expiresAt.toISOString(),
    };
  });

  // Minimal authed probe — also the target for auth-flow tests.
  app.get('/me', { preHandler: app.authenticate }, async (req) => {
    const [player] = await db.select().from(players).where(eq(players.wallet, req.wallet));
    if (!player) throw new HttpError(401, 'unknown player'); // session for a deleted player
    // Identity block (2026-07-29): the client renders the username + Seeker
    // badge from THIS, never from anything it decided locally.
    // resolveSeeker, not getSeekerStatus: a badge whose last on-chain proof has
    // aged out is re-verified HERE (security review F5 — nothing else expires
    // it, so the badge used to survive selling the SGT forever), and a wallet
    // with NO link gets the bounded post-sign-in auto-detect (2026-08-08 — session
    // JWTs live 7 days, so /me is the only read a cookie-restored Seeker is
    // guaranteed to hit). Costs one indexed SELECT while the verdict is inside
    // SEEKER.recheckHours / autoDetectRecheckHours.
    const seeker = await resolveSeeker(db, seekerDeps, req.wallet);
    const entryPaid = multiBaseEnabled()
      ? await hasActivePaidStableBase(db, req.wallet)
      : !!player.entryPaidAt;
    return {
      wallet: player.wallet,
      name: player.name,
      ...serializeAvatar(deps.avatarPublicBaseUrl, player),
      /** '' until the player picks one — the client must prompt, not invent. */
      nameChangedAt: player.nameChangedAt?.toISOString() ?? null,
      /** Days until a rename is allowed (0 = now). */
      nameCooldownDays: cooldownDaysLeft(player.nameChangedAt, new Date()),
      seeker,
      keepLevel: player.keepLevel,
      entryPaid,
      /** Land Deed Core asset (Phase 6) — null until minted / when disabled. */
      deedAssetId: player.deedAssetId,
    };
  });

  // Opaque bulk-map avatar. The UUID generation carries no wallet or R2 key;
  // the authenticated image request resolves the current pointer server-side.
  // A replaced/cleared generation stops resolving as soon as the DB pointer
  // moves, even while its durable object retirement is still retrying.
  app.get('/avatars/:generation.webp', {
    preHandler: [app.authenticate, avatarReadWalletRateLimit],
    config: { rateLimit: AVATAR_READ_RATE_LIMITS.ip },
  }, async (req, reply) => {
    const { generation } = req.params as { generation: string };
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(generation)) {
      throw new HttpError(404, 'avatar not found');
    }
    let body: Buffer | null;
    try {
      body = await withAvatarReadPermit(async () => {
        // Keep both the indexed pointer lookup and R2 request inside the same
        // fail-fast permit. Random UUID misses must not create an unbounded DB
        // queue before the object-store concurrency guard is reached.
        const [player] = await db.select({
          wallet: players.wallet,
          avatarHash: players.avatarHash,
          avatarGeneration: players.avatarGeneration,
        }).from(players).where(eq(players.avatarGeneration, generation)).limit(1);
        if (!player?.avatarHash || player.avatarGeneration !== generation) {
          throw new HttpError(404, 'avatar not found');
        }
        const key = avatarObjectKey(player.wallet, player.avatarHash, generation);
        return withAvatarStorageDeadline('GET', (signal) => {
          if (deps.avatarStorage?.read) return deps.avatarStorage.read(key, signal);
          if (deps.avatarPublicBaseUrl) return readPublicAvatar(deps.avatarPublicBaseUrl, key, signal);
          throw new HttpError(503, 'avatar images are temporarily unavailable');
        });
      });
    } catch (err) {
      if (err instanceof HttpError) throw err;
      req.log.error({ err }, 'opaque avatar read failed');
      throw new HttpError(503, 'avatar images are temporarily unavailable');
    }
    if (!body) throw new HttpError(404, 'avatar not found');
    return reply
      .header('cache-control', `private, max-age=${PROFILE_AVATAR.publicCacheSeconds}, immutable`)
      .type('image/webp')
      .send(body);
  });

  // Availability probe for the settings UI. ADVISORY ONLY — a name can be taken
  // between this call and the PATCH, which is why the write relies on the unique
  // index rather than on this answer.
  app.get('/username/check', { preHandler: app.authenticate, ...authRateLimit }, async (req) => {
    const { name } = parse(z.object({ name: z.string().max(64) }), req.query);
    return checkUsername(db, name);
  });

  // Set the player's username. Uniqueness (case-insensitive), charset, length
  // and the rename cooldown all live in game/username.ts; every limit comes from
  // USERNAMES in @shardkeep/shared.
  app.patch('/me', { preHandler: app.authenticate }, async (req) => {
    const { name } = parse(z.object({ name: z.string().min(1).max(64) }), req.body);
    const res = await setUsername(db, req.wallet, name);
    return { wallet: req.wallet, name: res.name, nameChangedAt: res.nameChangedAt.toISOString() };
  });

  // Two independent limits are deliberate. Route-level configuration replaces
  // the global limiter, so the onRequest/IP gate runs before Fastify buffers up
  // to 8 MiB. Authentication and the process-local raw-buffer permit are ALSO
  // onRequest hooks; only the wallet limiter waits until preHandler. All fail
  // closed before hostile image decoding, independently across IP and wallet.
  const avatarIpLimiter = config.NODE_ENV === 'test'
    ? null
    : app.createRateLimit({
      max: PROFILE_AVATAR.mutationsPerMinute,
      timeWindow: 60_000,
      keyGenerator: (req: FastifyRequest): string => `avatar-ip:${req.ip}`,
      skipOnError: false,
    });
  const avatarIpRateLimit = async (req: FastifyRequest): Promise<void> => {
    if (!avatarIpLimiter) return;
    const limit = await avatarIpLimiter(req);
    if (!limit.isAllowed && limit.isExceeded) {
      throw new HttpError(429, `avatar limit reached; try again in ${limit.ttlInSeconds}s`);
    }
  };
  const avatarWalletLimiter = config.NODE_ENV === 'test'
    ? null
    : app.createRateLimit({
      max: PROFILE_AVATAR.mutationsPerMinute,
      timeWindow: 60_000,
      keyGenerator: (req: FastifyRequest): string => `avatar-wallet:${req.wallet}`,
      skipOnError: false,
    });
  const avatarWalletRateLimit = async (req: FastifyRequest): Promise<void> => {
    if (!avatarWalletLimiter) return;
    const limit = await avatarWalletLimiter(req);
    if (!limit.isAllowed && limit.isExceeded) {
      throw new HttpError(429, `avatar limit reached; try again in ${limit.ttlInSeconds}s`);
    }
  };
  const avatarDeletePreHandler = [app.authenticate, avatarWalletRateLimit];

  // Keep hostile-image parsing inside an encapsulated plugin. Content-type parsers
  // inherit down Fastify's plugin tree, so registering these on the root auth
  // instance made every unrelated route accept and buffer an 8 MiB image body.
  // PATCH /me/avatar is the only route allowed to opt into these raw media types.
  app.register(async (avatarUploadApp) => {
    // Weak request ownership avoids widening Fastify's global request type. A
    // permit is installed only after authentication succeeds, before parsing.
    // Error, response and client-abort hooks all share one delete-before-release
    // path, so a request can release exactly once regardless of hook overlap.
    const rawUploadReleases = new WeakMap<FastifyRequest, () => void>();
    const rawUploadTimers = new WeakMap<FastifyRequest, ReturnType<typeof setTimeout>>();
    const clearRawUploadTimer = (req: FastifyRequest): void => {
      const timer = rawUploadTimers.get(req);
      if (!timer) return;
      rawUploadTimers.delete(req);
      clearTimeout(timer);
    };
    const releaseRawUpload = (req: FastifyRequest): void => {
      clearRawUploadTimer(req);
      const release = rawUploadReleases.get(req);
      if (!release) return;
      rawUploadReleases.delete(req);
      release();
    };
    const authenticateAndAdmitRawUpload = async (
      req: FastifyRequest,
      reply: Parameters<typeof app.authenticate>[1],
    ): Promise<void> => {
      await app.authenticate(req, reply);
      try {
        rawUploadReleases.set(req, acquireAvatarRawUploadPermit());
        const timeoutMs = deps.avatarUploadReceiveTimeoutMs
          ?? PROFILE_AVATAR.uploadReceiveTimeoutMs;
        rawUploadTimers.set(req, setTimeout(() => {
          // Destroy, rather than merely release: allowing a timed-out body to
          // continue streaming while admitting another recreates the memory/
          // socket starvation this deadline exists to prevent.
          releaseRawUpload(req);
          req.raw.destroy(new Error('avatar upload body receive timed out'));
        }, timeoutMs));
      } catch (err) {
        if (err instanceof AvatarBusyError) {
          throw new HttpError(503, 'avatar upload capacity is busy; try again');
        }
        throw err;
      }
    };

    // Raw bytes, not multipart: phone/desktop file inputs can send File directly,
    // while filenames and form framing never enter the trusted parser. Fastify
    // rejects every other media type with 415 before the upload route runs.
    for (const contentType of ['image/jpeg', 'image/png', 'image/webp']) {
      avatarUploadApp.addContentTypeParser(contentType, {
        parseAs: 'buffer',
        bodyLimit: AVATAR_MAX_UPLOAD_BYTES,
      }, (_req, body, done) => done(null, body));
    }

    avatarUploadApp.patch('/me/avatar', {
      // createRateLimit is invoked manually so IP admission is guaranteed to be
      // first. The plugin otherwise appends its configured onRequest hook after
      // route-local authentication/raw admission.
      onRequest: [avatarIpRateLimit, authenticateAndAdmitRawUpload],
      preHandler: avatarWalletRateLimit,
      onError: async (req) => { releaseRawUpload(req); },
      onResponse: async (req) => { releaseRawUpload(req); },
      onRequestAbort: async (req) => { releaseRawUpload(req); },
      onTimeout: async (req) => { releaseRawUpload(req); },
      config: { rateLimit: false },
      // Body receipt is complete before preValidation. Stop the receive clock;
      // response/error hooks continue owning the raw-memory permit itself.
      preValidation: async (req) => { clearRawUploadTimer(req); },
    }, async (req) => {
      if (!deps.avatarStorage) throw new HttpError(503, 'avatar uploads are temporarily unavailable');
      if (!Buffer.isBuffer(req.body)) throw new HttpError(422, 'avatar image body is required');
      const contentType = (req.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
      try {
        return await uploadPlayerAvatar(
          db, deps.avatarStorage, req.wallet, req.body, contentType,
        );
      } catch (err) {
        if (err instanceof AvatarInputError) throw new HttpError(422, err.message);
        // An object-store or DB failure must leave the previous pointer intact;
        // log the operational cause but do not leak provider details to clients.
        req.log.error({ err }, 'avatar upload failed before pointer change');
        throw new HttpError(503, 'avatar upload could not be saved; your previous avatar is unchanged');
      }
    });
  });

  // No image parser in this scope: a body-bearing DELETE is rejected as an
  // unsupported media type instead of being buffered like an upload.
  app.delete('/me/avatar', {
    onRequest: avatarIpRateLimit,
    preHandler: avatarDeletePreHandler,
    config: { rateLimit: false },
  }, async (req) => {
    try {
      return await clearPlayerAvatar(
        db, deps.avatarPublicBaseUrl, req.wallet,
      );
    } catch (err) {
      req.log.error({ err }, 'avatar removal failed before pointer change');
      throw new HttpError(503, 'avatar could not be removed; your current avatar is unchanged');
    }
  });

  // --- Seeker identity (Solana Mobile) -------------------------------------

  // On-demand re-verification so the badge NEVER depends on ENABLE_WORKERS being
  // on (R9 incident: entry crediting had exactly that bug). The `refresh` query
  // param the client sends is now a no-op: EVERY read re-verifies a stale
  // verdict and reuses a fresh one, which is what stops `?refresh=1` from being
  // a mainnet-RPC amplifier (security review F4). resolveSeeker so an UNLINKED
  // wallet's read can also run the bounded auto-detect (2026-08-08).
  app.get('/seeker/status', { preHandler: app.authenticate, ...seekerReadLimit }, async (req) =>
    resolveSeeker(db, seekerDeps, req.wallet));

  // Session-authed WITHOUT app.authenticate, the /alpha/redeem pattern
  // (routes-alpha.ts): that preHandler runs the alpha gate, and linking a
  // Seeker is now itself a way IN (owner 2026-08-08 — a split-wallet Seeker
  // owner, e.g. a Privy/social player whose embedded wallet can never hold the
  // SGT, proves theirs from the gate screen). Gating these was a
  // chicken-and-egg lockout: 403 ALPHA_GATED before the wallet could ever
  // verify. The cookie is still fully verified; the link itself additionally
  // requires the Seeker wallet's own signature + the mainnet holding check.
  const sessionWallet = async (req: { cookies: Record<string, string | undefined> }): Promise<string> => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError(401, 'authentication required');
    return (await verifyActiveSession(config, db, token)).wallet;
  };

  app.post('/seeker/link/challenge', authRateLimit, async (req) => {
    const wallet = await sessionWallet(req);
    const { seekerWallet } = parse(z.object({ seekerWallet: WalletSchema }), req.body);
    decodeWallet(seekerWallet);
    return createLinkChallenge(db, domain, wallet, seekerWallet);
  });

  app.post('/seeker/link/verify', authRateLimit, async (req) => {
    const wallet = await sessionWallet(req);
    const body = parse(z.object({
      seekerWallet: WalletSchema,
      signature: z.string().min(1),
      /** OPTIONAL naming nicety. Server-verified against the .skr parent; a bad
       *  or foreign domain is ignored, never fatal to the link. */
      skrDomain: z.string().max(70).optional(),
    }), req.body);
    decodeWallet(body.seekerWallet);
    return verifyAndLinkSeeker(db, seekerDeps, domain, wallet, body);
  });

  // Late `.skr` adoption for a linked account with no domain on file. Reaches
  // mainnet (a filtered gPA — the most expensive read we make), so it takes the
  // tighter Seeker read ceiling, same as /seeker/status. NOT wired into
  // recheckSeeker: that runs on hot /me reads (F4 RPC amplifier).
  app.post('/seeker/skr/adopt', { preHandler: app.authenticate, ...seekerReadLimit }, async (req) =>
    adoptDiscoveredSkr(db, seekerDeps, req.wallet));

  app.delete('/seeker/link', { preHandler: app.authenticate }, async (req) => {
    await unlinkSeeker(db, req.wallet);
    return { ok: true };
  });

  // Sign out: clear the httpOnly session cookie (the browser then stops sending
  // the JWT) and revoke the wallet's sessions as an audit trail. The old client
  // SIGN OUT only navigated to the title screen, leaving the session live
  // (audit: signout-broken-loop).
  app.post('/auth/logout', authRateLimit, async (req, reply) => {
    // Cleanup is idempotent, including expired/revoked/absent credentials. The
    // cookie coordinator must be able to clear a stale Set-Cookie response
    // before admitting the next login. An invalid credential grants no revoke.
    const pending = req.cookies[LOGIN_COOKIE];
    const full = req.cookies[SESSION_COOKIE];
    if (pending) {
      let identity: { wallet: string; sessionId: string } | null = null;
      try { identity = await verifyPendingLogin(config, db, pending); } catch { /* clear below */ }
      if (identity) await db.update(sessions).set({ revokedAt: new Date() }).where(and(
        eq(sessions.wallet, identity.wallet), eq(sessions.id, identity.sessionId), isNull(sessions.revokedAt),
      ));
    }
    if (full) {
      let identity: { wallet: string; sessionId: string } | null = null;
      try { identity = await verifyActiveSession(config, db, full); } catch { /* clear below */ }
      if (identity) {
        const wallet = identity.wallet;
        await db.transaction(async (tx) => {
          await tx.select({ wallet: players.wallet }).from(players)
            .where(eq(players.wallet, wallet)).for('update');
          const now = new Date();
          await tx.update(sessions).set({ revokedAt: now }).where(and(
            eq(sessions.wallet, wallet), isNull(sessions.revokedAt),
          ));
          const bindings = await tx.selectDistinct({ bindingId: nativePushSubscriptions.bindingId }).from(nativePushSubscriptions)
            .where(eq(nativePushSubscriptions.wallet, wallet));
          if (bindings.length) await tx.insert(nativePushRevocations)
            .values(bindings.map(({ bindingId }) => ({ wallet, bindingId, revokedAt: now }))).onConflictDoNothing();
          await tx.update(nativePushSubscriptions).set({ disabledAt: now }).where(and(
            eq(nativePushSubscriptions.wallet, wallet), isNull(nativePushSubscriptions.disabledAt),
          ));
        });
      }
    }
    reply.clearCookie(LOGIN_COOKIE, { path: '/' });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  // Gate for the Privy private-key EXPORT (Phase 2, ONRAMP-WALLETS-PLAN Flow B).
  // The key itself NEVER touches this server — Privy reveals it client-side in a
  // cross-origin modal. Every export first requires a fresh wallet signature
  // bound to this DB-active session and the `key_export` purpose. When the player
  // also has 2FA enrolled, a valid single-use code (shared lockout + TOTP replay
  // machinery) is required as an additional factor.
  //
  // KEY EXPORT IS A CUSTODY RIGHT, SO THE WHOLE FLOW IS AUTH-ONLY (security review
  // F8, 2026-08-09). Account 2FA management is auth-only too; only the actual
  // withdrawal remains land-gated. Email is an account contact/recovery factor,
  // not a monetary authorization factor; instant withdrawals are mature-TOTP-only.
  // The export
  // flow still carries its OWN two narrow routes so a landless player can recover
  // their key without depending on withdrawal/profile response shape:
  //   GET  /auth/export/status     — is a factor enrolled, and which (no email
  //                                  address, no instantEligible: this answers
  //                                  "which prompt do I render", not "may I
  //                                  withdraw"; `masked` mirrors get2faStatus).
  //   POST /auth/export/send-code  — an email challenge using the shared storage
  //                                  machinery but a session-bound key-export
  //                                  context unusable for money/factor changes.
  // Withdrawals themselves stay `owned`: nothing here can move funds — the export
  // happens entirely in Privy's iframe, and this server never sees the key.
  app.get('/auth/export/status', { preHandler: app.authenticate, ...authRateLimit }, async (req) => {
    const s = await get2faStatus(db, req.wallet);
    const recovery = await getTotpRecoveryStatus(db, req.wallet);
    return {
      totpEnabled: s.totpEnabled,
      emailVerified: s.emailVerified,
      email: s.email,
      /** True ⇒ the challenge below will demand a code. */
      gated: s.totpEnabled || s.emailVerified,
      recovery,
    };
  });

  // Tight per-IP cap at the same TWOFA verification ceiling as the other
  // security-factor routes, on top of issueEmailCode's per-player resend cooldown.
  app.post('/auth/export/send-code', {
    preHandler: app.authenticate,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } },
  }, async (req) => {
    const { devCode } = await sendWithdrawEmailCode(
      db, req.wallet, deps.emailSender ?? consoleEmailSender, undefined,
      keyExportEmailContext(req.sessionId), 'private_key_export',
      { recoveryAction: 'key_export' },
    );
    // Dev echo, same rule as the game routes: only under NODE_ENV=development.
    return config.NODE_ENV === 'development' ? { sent: true, devCode } : { sent: true };
  });

  const ExportChallengeBody = z.object({
    method: z.enum(['totp', 'email']).optional(),
    code: z.string().min(1).optional(),
  });
  app.post('/auth/export/challenge', { preHandler: app.authenticate, ...authRateLimit }, async (req) => {
    await assertRecentAuth(config, req, 'key_export');
    const { method, code } = parse(ExportChallengeBody, req.body ?? {});
    // 422, NOT 401: the session credential is valid — only the second factor
    // failed. The instant-withdrawal route uses 422 for the identical condition
    // (game/routes.ts), and the client force-logs-out on any authed 401, so a
    // merely mistyped code was booting the player to the title screen with
    // "SESSION EXPIRED".
    const result = await verifyKeyExport2fa(
      db, req.wallet, method, code, keyExportEmailContext(req.sessionId),
    );
    if (!result.ok) throw new HttpError(422, method && code
      ? 'invalid or expired 2FA code'
      : 'a 2FA code is required to export your key');
    return { exportOk: true, gated: result.enrolled };
  });

  // DEV ONLY: signature-less session for local testing/preview. Double-gated:
  // never in production builds AND requires the explicit env opt-in.
  if (config.NODE_ENV !== 'production' && process.env['DEV_LOGIN'] === 'true') {
    app.post('/auth/dev-login', async (req, reply) => {
      const body = (req.body ?? {}) as { wallet?: string; client?: unknown; baseId?: unknown };
      const wallet = body.wallet ?? bs58.encode(randomBytes(32));
      decodeWallet(wallet);
      // Same optional cohort tag as /auth/verify so a local stack can exercise
      // the Solana Mobile / browser split of /playtest/stats.
      const client = parse(SignInClientSchema.optional(), body.client);
      // Dev-login IS the sanctioned entry-payment bypass (ECONOMY.md §5:
      // "Dev-login bypasses this for local testing only") — stamp entryPaidAt
      // so the same requireEntryPaid gate serves both flows with no exemptions.
      await db.insert(players).values({ wallet, entryPaidAt: new Date() }).onConflictDoNothing();
      await db.update(players).set({ entryPaidAt: new Date() })
        .where(and(eq(players.wallet, wallet), isNull(players.entryPaidAt)));
      if (client) {
        await db.update(players).set({ firstClient: client }).where(and(
          eq(players.wallet, wallet),
          isNull(players.firstClient),
          notExists(db.select({ id: sessions.id }).from(sessions).where(eq(sessions.wallet, wallet))),
        ));
      }
      // Stable-mode development must exercise the same deed-owned books as the
      // production game. Seeding wallet shadows here would bypass the cutover
      // and make every local multi-base/browser smoke lie about what it tested.
      const requestedDevBaseId = parse(z.uuid().optional(), body.baseId);
      const stableBaseId = multiBaseEnabled()
        ? requestedDevBaseId
          ? (await resolveActiveBase(db, wallet, requestedDevBaseId))?.base.id
          : await ensureWalletBaseIdentity(db, wallet)
        : null;
      if (multiBaseEnabled() && !stableBaseId) {
        throw new HttpError(500, 'dev-login could not materialize its stable base');
      }
      await ensureStartingBase(db, wallet, stableBaseId ?? undefined);
      if (stableBaseId && fantasyWorldEnabled()) {
        // DEV_LOGIN_REALM (config.ts, docs/REALM-THEMES-PLAN.md §3 P0): a fresh dev
        // base is seeded in the realm under review; an already-seated one keeps its
        // claim and PRESENTS the realm instead (game/baseVisual.ts resolveBaseVisual).
        const { seedDevFantasyLocation } = await import('../game/fantasyLocation');
        await seedDevFantasyLocation(db, wallet, stableBaseId, devLoginRealm());
      }
      if (devLoginRealm()) {
        // Under the switch the presented realm can change between logins with no
        // persisted trace, so every dev-login re-seats the kit's expansion obstacle
        // rows from scratch: the rows off the legacy plot (only kitObstacles.ts seats
        // those) are dropped here and the next GET /base seats the presented realm's
        // own. Left standing, the previous realm's trees would draw in the new one and
        // block its seats (a row at a tile is never recreated). A row a builder job
        // touched — cleared, or clearing now — stays: the job carries the shard debit
        // receipt and references the row, and a dev base's audit is still an audit.
        // Keyed by wallet, not by the stable base: a legacy single-base host has no
        // stable base id, and every base the wallet owns presents the switch realm
        // (resolveBaseVisual), fantasy world or not.
        await db.delete(obstacles).where(and(
          eq(obstacles.playerWallet, wallet),
          or(lt(obstacles.tx, 0), gte(obstacles.tx, GRID.plotTiles), lt(obstacles.ty, 0), gte(obstacles.ty, GRID.plotTiles)),
          notExists(db.select({ id: builderJobs.id }).from(builderJobs).where(eq(builderJobs.obstacleId, obstacles.id))),
        ));
      }
      if (stableBaseId) await ensureBasePlotAssigned(db, wallet, stableBaseId);
      else await ensurePlotAssigned(db, wallet);
      // dev convenience: funded balances (KEEP + shards post-split) + a small
      // ready army so every flow (build, raid, forge) is exercisable
      const { rewardShards } = await import('../game/spend');
      if (gemsEnabled()) {
        // D-152: the dev grant is Gems (`grant:dev:<wallet>`), backed by a
        // journaled budget top-up from the emission pool under the same
        // DEV_LOGIN guard (never reachable in production).
        const { fundGemsRewardBudget, grantGems } = await import('../game/gemsGrants');
        await fundGemsRewardBudget(db, 50_000n, `dev-fund:${wallet}`, { wallet, reason: 'dev-login' }).catch(() => null);
        await grantGems(db, { wallet, gems: 50_000n, reason: 'dev' }).catch(() => null);
      } else {
        // Legacy custodial KEEP grant (emission_pool → player_keep), kept
        // verbatim while Gems are dark so flag-off dev flows do not change.
        const { bootstrapSystemAccounts, getOrCreatePlayerAccount } = await import('../ledger/accounts');
        const { postTransaction } = await import('../ledger/ledger');
        const sys = await bootstrapSystemAccounts(db);
        const acct = await getOrCreatePlayerAccount(db, wallet, 'player_keep');
        await postTransaction(db, {
          idempotencyKey: `dev-fund:${wallet}`, type: 'dev.fund',
          entries: [{ account: sys.emission_pool, delta: -50_000n }, { account: acct.id, delta: 50_000n }],
          metadata: { wallet, pool: 'emission_pool' },
        }).catch(() => null); // idempotent: second login reuses the same key
      }
      if (stableBaseId) {
        const { rewardBaseShards } = await import('../game/baseEconomy');
        await rewardBaseShards(
          db, stableBaseId, 50_000n, 'dev.fund', `dev-fund-base-shards:${stableBaseId}`,
        ).catch(() => null);
      } else {
        await rewardShards(db, wallet, 50_000n, 'dev.fund', `dev-fund-shards:${wallet}`)
          .catch(() => null);
      }
      const { army, baseArmy, buildings } = await import('../db/schema');
      // SEED ONCE PER PLAYER, and check it explicitly.
      //
      // This used to be a bare insert with .onConflictDoNothing(), which reads
      // like a dedupe and is a NO-OP: the only unique index on `buildings` is the
      // primary key, and `id` is a fresh gen_random_uuid() on every call, so
      // there is never a conflict to do nothing about. Every dev-login therefore
      // stacked another mine/barracks/camp on the SAME fixed tiles, invisibly —
      // one sprite drawn over another. Six dev-logins left six camps on tile
      // (12,8) in the owner's base, plus mines past the Keep cap, because this
      // path bypasses geometryCheck and every cap (owner report 2026-08-02).
      //
      // Gate on "does this player have ANY non-Keep building" rather than a
      // unique index: ensureStartingBase already gave them a Keep, the seed is
      // pure convenience, and a player who has built anything at all does not
      // want three more buildings dropped on fixed coordinates.
      const existing = await db.select({ id: buildings.id }).from(buildings)
        .where(and(
          stableBaseId ? eq(buildings.baseId, stableBaseId) : eq(buildings.playerWallet, wallet),
          ne(buildings.type, 'keep'),
        )).limit(1);
      if (existing.length === 0) {
        await db.insert(buildings).values([
          { playerWallet: wallet, baseId: stableBaseId, type: 'mine', level: 1, tx: 6, ty: 8 },
          { playerWallet: wallet, baseId: stableBaseId, type: 'barracks', level: 1, tx: 11, ty: 12 },
          { playerWallet: wallet, baseId: stableBaseId, type: 'camp', level: 1, tx: 12, ty: 8 },
        ]);
      }
      if (stableBaseId) {
        await db.insert(baseArmy).values([
          { baseId: stableBaseId, troop: 'highlander', count: 5 },
          { baseId: stableBaseId, troop: 'kegrunner', count: 2 },
          { baseId: stableBaseId, troop: 'bowman', count: 4 },
        ]).onConflictDoNothing();
      } else {
        await db.insert(army).values([
          { playerWallet: wallet, troop: 'highlander', count: 5 },
          { playerWallet: wallet, troop: 'kegrunner', count: 2 },
          { playerWallet: wallet, troop: 'bowman', count: 4 },
        ]).onConflictDoNothing();
      }
      const sessionId = randomUUID();
      const expiresAt = new Date(Date.now() + SESSION_TTL_SEC * 1000);
      await db.insert(sessions).values({ id: sessionId, wallet, expiresAt, client: client ?? null });
      const jwt = await issueSessionJwt(config, wallet, sessionId);
      reply.setCookie(SESSION_COOKIE, jwt, {
        httpOnly: true,
        sameSite: 'lax',
        secure: false,
        path: '/',
        maxAge: SESSION_TTL_SEC,
      });
      return { wallet, dev: true, entryPaid: true };
    });
  }

  // DEV/ADMIN ONLY (#46): the shieldless/warzone mode SWITCH. No admin-auth surface
  // exists yet, so it is gated to non-production like dev-login. Body:
  //   { mode: 'off' | 'scheduled' | 'purge', hours?: number }
  // 'scheduled' = the predictable weekend window (WARZONE constants, players know);
  // 'purge' = an UNANNOUNCED window of `hours` (default WARZONE.durationHours)
  // starting NOW — start/end are stored server-side and NEVER returned to players,
  // so nobody knows in advance when a 48h warzone begins (owner 2026-07-20).
  if (config.NODE_ENV !== 'production') {
    app.post('/dev/warzone', async (req) => {
      const body = parse(WarzoneBody, req.body);
      const now = new Date();
      if (body.mode === 'purge') {
        const hours = body.hours ?? WARZONE.durationHours;
        await setShieldlessMode(db, 'purge', {
          purgeStartAt: now,
          purgeEndAt: new Date(now.getTime() + hours * 3_600_000),
        }, now);
      } else {
        await setShieldlessMode(db, body.mode, undefined, now);
      }
      const cfg = await getGameConfig(db);
      // Return only the CURRENT state (active now / not) — never the purge window.
      return { mode: cfg.shieldlessMode, warzoneActive: isWarzoneActive(cfg, now) };
    });

    // DEV ONLY (#49): grant a 48h warzone shield to a wallet WITHOUT the SOL payment,
    // so the "only a warzone shield protects during a warzone" mechanic is testable
    // in-game before the on-chain purchase flow lands. Body: { wallet }.
    app.post('/dev/warzone-shield', async (req) => {
      const { wallet } = parse(z.object({ wallet: WalletSchema }), req.body);
      const { grantWarzoneShield } = await import('../game/warzoneShield');
      const { expiresAt } = await grantWarzoneShield(db, wallet, new Date());
      return { wallet, warzoneShieldUntil: expiresAt.toISOString() };
    });
  }
}
