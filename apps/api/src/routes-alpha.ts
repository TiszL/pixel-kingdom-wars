/**
 * Closed-alpha surface (owner decisions 2026-08-05): the PUBLIC application
 * form the marketing site POSTs to cross-origin, the admin review panel, and
 * the authed invite-code redemption. Registered from app.ts beside the auth
 * and game route modules.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SEEKER } from '@shardkeep/shared';
import { autoDetectSeeker, type LinkDeps } from './auth/seeker';
import { SESSION_COOKIE, assertAlphaAccess, verifyActiveSession } from './auth/session';
import { consoleEmailSender, type EmailSender } from './auth/twofa';
import type { Config } from './config';
import type { Db } from './db/client';
import {
  alphaStats, approveApplication, generateAdminInviteBatch, listApplications,
  listInviteCodes, redeemInviteCode, rejectApplication, submitApplication,
  verifyTurnstile,
} from './game/alpha';
import { HttpError } from './lib/errors';
import { parse } from './lib/validation';

/** Optional wiring (app.ts passes AppDeps bits through; tests inject fakes). */
export interface AlphaDeps {
  emailSender?: EmailSender | undefined;
  /** Transport for the server-side Turnstile verify. Defaults to global fetch. */
  turnstileFetch?: typeof fetch | undefined;
  /** Transport for the read-only mainnet Seeker reads (POST /alpha/seeker).
   *  Defaults to global fetch; tests inject a fake mainnet. */
  seekerFetch?: typeof fetch | undefined;
}

const ApplyBody = z.object({
  email: z.string().min(3).max(254),
  handle: z.string().trim().max(64).optional(),
  socials: z.string().trim().max(256).optional(),
  /** Free-form question answers from the form — bounded, review context only. */
  answers: z.record(z.string().max(64), z.string().max(2000))
    // Key COUNT bound (security review 2026-08-05 finding 4): each key/value
    // was bounded but the record itself was not — one hostile application
    // could carry ~1MiB of jsonb and swamp the admin card that renders every
    // key. The landing form sends 6; 24 leaves headroom for form growth.
    .refine((o) => Object.keys(o).length <= 24, 'too many answers')
    .optional(),
  /**
   * HONEYPOT. A visually hidden field humans never fill; a non-empty value is a
   * bot. The route answers the normal success body and stores nothing — a
   * rejection would teach the bot which field gave it away. The route checks it
   * BEFORE this schema runs (so an over-long stuffed value can never 400 with
   * the field's name in the message); by parse time it is only ever ''/absent.
   */
  website: z.string().max(256).optional(),
  /** Cloudflare Turnstile client token; required when the server secret is set. */
  turnstileToken: z.string().max(4096).optional(),
});

const RedeemBody = z.object({ code: z.string().min(1).max(64) });
const IdParams = z.object({ id: z.string().uuid() });
const ListQuery = z.object({ status: z.enum(['pending', 'approved', 'rejected']).optional() });
const RejectBody = z.object({ note: z.string().max(1000).optional() });
const GenerateInvitesBody = z.object({
  count: z.number().int().min(1).max(100),
  idempotencyKey: z.string().uuid(),
}).strict();
const InviteHistoryQuery = z.object({
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});

export function registerAlphaRoutes(
  app: FastifyInstance, config: Config, db: Db, deps: AlphaDeps = {},
): void {
  const send = deps.emailSender ?? consoleEmailSender;
  const playUrl = config.PLAY_URL ?? config.WEB_ORIGIN[0]!;
  const assertInvitesEnabled = (): void => {
    if (config.PLAYTEST_OPEN === 'true') {
      throw new HttpError(409, `The playtest is open. No invite code required. Play now: ${playUrl}`, 'PLAYTEST_OPEN');
    }
  };
  app.get('/playtest/access', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { open: config.PLAYTEST_OPEN === 'true' || !config.ALPHA_WALLETS, playUrl };
  });

  // The ONLY fully public write endpoint in the app, reachable cross-origin from
  // the marketing site — so it takes the tightest per-IP limit here. Ops knobs,
  // not game numbers; ignored under NODE_ENV=test (limiter not registered).
  const applyLimit = { config: { rateLimit: { max: 5, timeWindow: 60_000 } } };
  // Codes are 128-bit so brute force is hopeless anyway; the limit just keeps
  // the endpoint from being free load.
  const redeemLimit = { config: { rateLimit: { max: 10, timeWindow: 60_000 } } };
  const adminLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };
  // One request can emit 100 live admission secrets, so generation gets a
  // tighter ceiling than ordinary admin reads/review actions.
  const adminGenerateLimit = { config: { rateLimit: { max: 10, timeWindow: 60_000 } } };

  // -------------------------------------------------------------------------
  // Public: request an invite
  // -------------------------------------------------------------------------
  app.post('/alpha/apply', applyLimit, async (req) => {
    assertInvitesEnabled();
    // Honeypot BEFORE any real work — including BEFORE zod: same response,
    // nothing stored, no email, no Turnstile check, so the drop is
    // indistinguishable from success even to a bot that solved the challenge.
    // Pre-parse on purpose: the landing input has no maxlength, and a bot that
    // stuffs an over-long (or non-string) value into the trap must get this
    // same silent success — parse-first answered it with a 400 that NAMED the
    // honeypot field, telling the bot exactly which field to leave empty.
    const rawWebsite = (req.body as { website?: unknown } | null | undefined)?.website;
    if (rawWebsite !== undefined && rawWebsite !== null && rawWebsite !== '') return { ok: true };
    const body = parse(ApplyBody, req.body);
    await verifyTurnstile(config.TURNSTILE_SECRET_KEY, body.turnstileToken, req.ip, deps.turnstileFetch);
    await submitApplication(db, body, send);
    // Identical body for fresh AND duplicate email (submitApplication no-ops on
    // duplicates): this endpoint must not confirm which addresses applied.
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Authed (pre-gate): redeem an invite code
  // -------------------------------------------------------------------------
  //
  // Session-authed WITHOUT app.authenticate: that preHandler runs the alpha
  // gate, which 403s the very wallet that is here to redeem (chicken-and-egg).
  // The cookie is still fully verified — this is the one route where a valid
  // session is enough and allowlisting is not. Deliberately pre-entry too: the
  // 0.2 SOL entry comes AFTER a player can get in at all.
  app.post('/alpha/redeem', redeemLimit, async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError(401, 'authentication required');
    const wallet = (await verifyActiveSession(config, db, token)).wallet;
    const { code } = parse(RedeemBody, req.body);
    await redeemInviteCode(db, wallet, code);
    return { ok: true, wallet };
  });

  // -------------------------------------------------------------------------
  // Authed (pre-gate): a friend's REFERRAL code is an alpha invite (D-052)
  // -------------------------------------------------------------------------
  //
  // Same cookie-only, pre-gate, rate-limited posture as /alpha/redeem — the
  // wallet standing here is exactly the one the gate refuses. Admission also
  // records the referral relationship when the 14-day window allows, so the
  // inviter's mining bonus can later qualify from this same act.
  app.post('/alpha/referral', redeemLimit, async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError(401, 'authentication required');
    const wallet = (await verifyActiveSession(config, db, token)).wallet;
    const { code } = parse(RedeemBody, req.body);
    const { redeemReferralAdmission, useReferralCode } = await import('./game/social');
    if (config.PLAYTEST_OPEN === 'true') {
      // Older clients may still arrive here; admission limits do not constrain
      // optional friend attribution once the playtest is public.
      await useReferralCode(db, wallet, code.trim().toUpperCase());
    } else {
      await redeemReferralAdmission(db, wallet, code);
    }
    // Referral loop close (PostHog audit 2026-08-16) — after the admission
    // committed, per the count-confirmed-state-changes rule.
    // The code itself is an invite secret; a keyed hash still counts distinct
    // codes without making the vendor a place to read them from.
    const { hashForAnalytics, serverTrack } = await import('./telemetry');
    serverTrack('referral_redeemed', wallet, { code_hash: hashForAnalytics(code) });
    return { ok: true, wallet };
  });

  // -------------------------------------------------------------------------
  // Authed (pre-gate): Seeker auto-admission probe
  // -------------------------------------------------------------------------
  //
  // Same cookie-only pattern as /alpha/redeem, for the same chicken-and-egg
  // reason. Session creation deliberately performs no third-party mainnet RPC:
  // a slow provider must never hold every fresh wallet on SIGNING IN. The gate
  // screen calls this once on mount; it runs the bounded auto-detect and answers
  // whether the wallet passes the gate now. Reaches
  // mainnet at most once per autoDetectRecheckHours per wallet, with the
  // tighter Seeker read ceiling on top (F4 discipline).
  const seekerDeps: LinkDeps = {
    mainnetRpcUrl: config.SOLANA_MAINNET_RPC_URL,
    mainnetRpcUrlSecondary: config.SOLANA_MAINNET_RPC_URL_2,
    fetchImpl: deps.seekerFetch,
  };
  const seekerProbeLimit = {
    config: { rateLimit: { max: SEEKER.statusRefreshPerMin, timeWindow: 60_000 } },
  };
  app.post('/alpha/seeker', seekerProbeLimit, async (req) => {
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError(401, 'authentication required');
    const wallet = (await verifyActiveSession(config, db, token)).wallet;
    // v0.3.2 and older shells may still send a client marker here. It is
    // deliberately ignored: query parameters, localStorage, user-agent and
    // request JSON are all caller-controlled and therefore can never grant
    // closed-alpha access. Only a verified mainnet SGT or an existing
    // invite/manual allowlist grant can make assertAlphaAccess succeed.
    const seeker = await autoDetectSeeker(db, seekerDeps, wallet);
    // Answer from the gate itself, not from `seeker.linked`: env-listed and
    // invite-admitted wallets are admitted too, and an OPEN game admits all.
    let admitted = true;
    try {
      await assertAlphaAccess(config, db, wallet);
    } catch {
      admitted = false;
    }
    // `wallet` mirrors /alpha/redeem: the restore-path gate screen hydrates
    // auth from it (the store never saw /me succeed).
    return { admitted, seeker, wallet };
  });

  // -------------------------------------------------------------------------
  // Admin: review panel (inside the game app, same origin — session auth works)
  // -------------------------------------------------------------------------
  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    // UNSET ⇒ the panel does not exist. 404 BEFORE auth so the surface is
    // indistinguishable from an unregistered path, even to an unauthenticated
    // probe — config.ts ADMIN_WALLETS rationale.
    if (!config.ADMIN_WALLETS) throw new HttpError(404, 'not found');
    await app.authenticate(req, reply);
    if (!config.ADMIN_WALLETS.includes(req.wallet)) {
      throw new HttpError(403, 'admin access required');
    }
  }

  app.get('/admin/alpha/applications', { preHandler: requireAdmin, ...adminLimit }, async (req) => {
    const { status } = parse(ListQuery, req.query);
    return listApplications(db, status);
  });

  app.post('/admin/alpha/:id/approve', { preHandler: requireAdmin, ...adminLimit }, async (req) => {
    assertInvitesEnabled();
    const { id } = parse(IdParams, req.params);
    // PLAY_URL when set; else WEB_ORIGIN[0], the canonical host by convention (auth/routes.ts
    // derives the SIWS domain from it) — the right URL for the invite email.
    return approveApplication(db, id, send, config.PLAY_URL ?? config.WEB_ORIGIN[0]!);
  });

  app.post('/admin/alpha/:id/reject', { preHandler: requireAdmin, ...adminLimit }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const { note } = parse(RejectBody, req.body ?? {});
    return rejectApplication(db, id, note);
  });

  app.post('/admin/alpha/invites', { preHandler: requireAdmin, ...adminGenerateLimit }, async (req, reply) => {
    assertInvitesEnabled();
    const { count, idempotencyKey } = parse(GenerateInvitesBody, req.body);
    reply.header('cache-control', 'no-store');
    return generateAdminInviteBatch(db, req.wallet, count, idempotencyKey);
  });

  app.get('/admin/alpha/invites', { preHandler: requireAdmin, ...adminLimit }, async (req, reply) => {
    const query = parse(InviteHistoryQuery, req.query);
    reply.header('cache-control', 'no-store');
    return listInviteCodes(db, query);
  });

  app.get('/admin/alpha/stats', { preHandler: requireAdmin, ...adminLimit }, async () => ({
    ...await alphaStats(db), accessOpen: config.PLAYTEST_OPEN === 'true' || !config.ALPHA_WALLETS,
  }));
}
