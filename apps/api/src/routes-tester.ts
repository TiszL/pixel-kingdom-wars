import { eq } from 'drizzle-orm';
import { playtestCampaigns } from './db/schema';
import { PLAYTEST_COMPETITIONS } from '@shardkeep/shared';
/**
 * Tester program routes (owner 2026-08-21).
 *
 * Public, uncredentialed READS — consumed by pixelkingdomwars.com/leaderboard
 * (the landing origin is allowed through the CORS delegate in app.ts for
 * exactly these two paths, credentials:false, GET only):
 *   GET /tester/leaderboard      top N by points (names + short wallets only)
 *   GET /tester/progress?wallet= one wallet's checklist (the visitor types it)
 *
 * Session-authed, behind the closed-alpha gate like every game route:
 *   GET  /tester/me              own progress (milestones + today's daily ledger,
 *                                streak, referral counts, why listed/unlisted);
 *                                runs a bounded recompute first
 *   POST /tester/feedback        submit feedback (points frozen on the row)
 *   GET  /tester/feedback        own feedback history
 *
 * Admin (ADMIN_WALLETS; unset ⇒ 404 before auth, the /admin/alpha pattern):
 *   GET  /admin/tester/feedback?status=&fixed=&exported=&client=
 *   POST /admin/tester/feedback/:id/rate   {importance?, status?, note?, fixed?, fixedRef?}
 *                                          FIXED is a flag beside the status (owner
 *                                          2026-09-04): accepted+fixed yes, rejected+fixed 409
 *   POST /admin/tester/feedback/exported   {ids} stamps exported_at (first time only)
 *   GET  /admin/tester/export              full wallets + points (rewards)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PLAYTEST_CAMPAIGN, TESTER_DAILY, TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_CLIENTS, FEEDBACK_THREADS, FEEDBACK_SCREENSHOTS } from '@shardkeep/shared/feedback';
import { feedbackClientOrigin } from './game/feedbackOrigin';
import { appendFeedbackReply, getFeedbackThread, markFeedbackThreadRead } from './game/feedbackThreads';
import type { Config } from './config';
import type { Db } from './db/client';
import { campaignWindow } from './game/playtestStats';
import {
  FeedbackDiagnosticContext, adminExportTesters, adminListBoardHidden, adminListTesterFeedback, adminMarkFeedbackExported,
  adminRateTesterFeedback, adminSetBoardHidden, listMyTesterFeedback, recomputeIfDue, submitTesterFeedback,
  testerLeaderboard, testerProgress,
} from './game/tester';
import { listReporterFeedbackPage } from './game/feedbackReporterPage';
import { HttpError } from './lib/errors';
import { parse } from './lib/validation';

export const TESTER_PUBLIC_PATHS = ['/tester/leaderboard', '/tester/progress'] as const;

const WalletQuery = z.object({ wallet: z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/) });
const FeedbackBody = z.object({
  requestId: z.string().min(1).max(FEEDBACK_THREADS.requestIdMaxLen).regex(/^[A-Za-z0-9_-]+$/).optional(),
  category: z.enum(TESTER_PROGRAM.feedback.categories),
  title: z.string().min(1).max(TESTER_PROGRAM.feedback.titleMaxLen),
  body: z.string().min(TESTER_PROGRAM.feedback.bodyMinLen).max(TESTER_PROGRAM.feedback.bodyMaxLen),
  context: FeedbackDiagnosticContext.optional(),
});
const TRIAGE_STATUSES = ['new', 'reviewed', 'accepted', 'rejected', 'duplicate'] as const;
const Flag = z.enum(['true', 'false']).transform((v) => v === 'true');
/** Admin list filters (owner 2026-09-04). `status=fixed` is accepted as the
 *  legacy spelling of `fixed=true`. */
const StatusQuery = z.object({
  status: z.enum([...TRIAGE_STATUSES, 'fixed']).optional(),
  fixed: Flag.optional(),
  exported: Flag.optional(),
  /** Owner 2026-09-18: "Android app only" (`client=android-native`). */
  client: z.enum(FEEDBACK_CLIENTS).optional(),
});
const IdParams = z.object({ id: z.string().uuid() });
const RateBody = z.object({
  importance: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  status: z.enum(TRIAGE_STATUSES).optional(),
  note: z.string().max(1000).optional(),
  /** FIXED is a flag beside the status: accepted+fixed is fine, rejected+fixed is a 409. */
  fixed: z.boolean().optional(),
  /** Public change reference an admin cites when marking a report fixed. */
  fixedRef: z.string().max(FEEDBACK_THREADS.fixedRefMaxLen).optional(),
});
const ThreadQuery = z.object({
  afterRevision: z.coerce.number().int().nonnegative().safe().optional(),
  beforeRevision: z.coerce.number().int().nonnegative().safe().optional(),
}).strict().refine(q => q.afterRevision === undefined || q.beforeRevision === undefined, 'choose either earlier or newer messages');
const ThreadReplyBody = z.object({
  requestId: z.string().min(1).max(FEEDBACK_THREADS.requestIdMaxLen).regex(/^[A-Za-z0-9_-]+$/),
  body: z.string().trim().max(FEEDBACK_THREADS.replyMaxLen),
  attachmentIds: z.array(z.string().uuid()).max(FEEDBACK_SCREENSHOTS.maxPerMessage).optional(),
  visibility: z.enum(['reporter', 'admin']).optional(),
}).strict();
const ThreadReadBody = z.object({ revision: z.number().int().nonnegative().safe() }).strict();

const ExportedBody = z.object({ ids: z.array(z.string().uuid()).min(1).max(500) });

const HideBody = z.object({
  wallet: z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/),
  hidden: z.boolean(),
  reason: z.string().max(200).optional(),
});

/** The daily catalog every surface renders from live values (D-103): sources
 * with caps and points, streak bonuses, category labels. */
const DAILY_CATALOG = {
  sources: TESTER_DAILY.sources, streaks: TESTER_DAILY.streaks,
  categoryLabels: TESTER_DAILY.categoryLabels, lookbackDays: TESTER_DAILY.lookbackDays,
} as const;

export function registerTesterRoutes(app: FastifyInstance, config: Config, db: Db): void {
  // Team/internal wallets never appear on the public board (owner 2026-08-22);
  // same set telemetry treats as internal.
  const internalWallets = [...new Set([...(config.ALPHA_WALLETS ?? []), ...(config.ADMIN_WALLETS ?? [])])];
  const publicLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };
  const feedbackLimit = { config: { rateLimit: { max: 10, timeWindow: 60_000 } } };
  const adminLimit = { config: { rateLimit: { max: 60, timeWindow: 60_000 } } };

  // --- public ------------------------------------------------------------------
  // The Founding Kingdoms framing every surface shows (D-103): name, reward
  // sentence and the optional window. Presentation only; points never read it.
  const campaign = async () => {
    const [definition] = await db.select().from(playtestCampaigns)
      .where(eq(playtestCampaigns.id, PLAYTEST_COMPETITIONS.foundingId));
    return {
      name: PLAYTEST_CAMPAIGN.name, totalDays: PLAYTEST_CAMPAIGN.totalDays, rewardCopy: PLAYTEST_CAMPAIGN.rewardCopy,
      whitelist: PLAYTEST_CAMPAIGN.whitelist,
      id: PLAYTEST_COMPETITIONS.foundingId, scoreType: 'founding',
      ...campaignWindow(definition?.startAt?.toISOString(), new Date()),
    };
  };

  app.get('/tester/leaderboard', publicLimit, async (_req, reply) => {
    const board = await testerLeaderboard(db, { internalWallets });
    // Public board: short cache so the landing page and many tabs share one read.
    reply.header('cache-control', 'public, max-age=30');
    return {
      ...board,
      scoreType: 'lifetime', computedAt: new Date().toISOString(),
      campaignIds: [PLAYTEST_COMPETITIONS.foundingId, PLAYTEST_COMPETITIONS.rewardedId],
      campaign: await campaign(),
      catalog: {
        milestones: TESTER_PROGRAM.milestones.length, feedback: TESTER_PROGRAM.feedback,
        daily: DAILY_CATALOG,
      },
    };
  });

  app.get('/tester/progress', publicLimit, async (req, reply) => {
    const { wallet } = parse(WalletQuery, req.query);
    // Public: achieved flags only — no timestamps for someone else's wallet.
    const progress = await testerProgress(db, wallet, { timestamps: false, internalWallets });
    if (!progress) throw new HttpError(404, 'no tester with that wallet yet');
    reply.header('cache-control', 'public, max-age=15');
    return progress;
  });

  // --- own -----------------------------------------------------------------------
  app.get('/tester/me', { preHandler: app.authenticate }, async (req) => {
    const earned = await recomputeIfDue(db, req.wallet);
    const progress = await testerProgress(db, req.wallet, { timestamps: true, internalWallets });
    if (!progress) throw new HttpError(404, 'player not found');
    return { ...progress, daily: { ...progress.daily, catalog: DAILY_CATALOG }, campaign: await campaign(), justEarned: earned };
  });

  app.post('/tester/feedback', { preHandler: app.authenticate, ...feedbackLimit }, async (req) => {
    const body = parse(FeedbackBody, req.body);
    // The client label comes from this request's headers, never from its body.
    return submitTesterFeedback(db, req.wallet, { ...body, origin: feedbackClientOrigin(req.headers) });
  });

  app.get('/tester/feedback/page', {
    preHandler: app.authenticate,
    onRequest: async (_req, reply) => { reply.header('Cache-Control', 'private, no-store'); reply.header('Vary', 'Cookie, Authorization'); },
  }, async (req) => listReporterFeedbackPage(db, req.wallet, req.query));

  app.get('/tester/feedback', { preHandler: app.authenticate }, async (req) => ({
    feedback: await listMyTesterFeedback(db, req.wallet),
  }));

  // --- admin ---------------------------------------------------------------------
  async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!config.ADMIN_WALLETS) throw new HttpError(404, 'not found');
    await app.authenticate(req, reply);
    if (!config.ADMIN_WALLETS.includes(req.wallet)) throw new HttpError(403, 'admin access required');
  }

  // Route identity is fixed here, never taken from a client role/wallet field.
  // Private errors and successful bodies are equally ineligible for shared caches.
  for (const mode of ['reporter', 'admin'] as const) {
    const prefix = mode === 'admin' ? '/admin/tester/feedback' : '/tester/feedback';
    const options = {
      preHandler: mode === 'admin' ? requireAdmin : app.authenticate,
      onRequest: async (_req: FastifyRequest, reply: FastifyReply) => {
        reply.header('Cache-Control', 'private, no-store');
        reply.header('Vary', 'Cookie, Authorization');
      },
      ...adminLimit,
    };
    app.get(`${prefix}/:id/thread`, options, async (req) => {
      const { id } = parse(IdParams, req.params);
      const pagination = parse(ThreadQuery, req.query);
      return getFeedbackThread(db, config, { wallet: req.wallet, mode }, id, pagination);
    });
    app.post(`${prefix}/:id/replies`, options, async (req) => {
      const { id } = parse(IdParams, req.params);
      const body = parse(ThreadReplyBody, req.body);
      return appendFeedbackReply(db, config, { wallet: req.wallet, mode }, id, {
        requestId: body.requestId, body: body.body, origin: feedbackClientOrigin(req.headers),
        ...(body.attachmentIds === undefined ? {} : { attachmentIds: body.attachmentIds }),
        ...(body.visibility === undefined ? {} : { visibility: body.visibility }),
      });
    });
    app.post(`${prefix}/:id/read`, options, async (req) => {
      const { id } = parse(IdParams, req.params);
      const { revision } = parse(ThreadReadBody, req.body);
      return markFeedbackThreadRead(db, config, { wallet: req.wallet, mode }, id, revision);
    });
  }

  app.get('/admin/tester/feedback', { preHandler: requireAdmin, ...adminLimit }, async (req) => {
    const q = parse(StatusQuery, req.query);
    const filter = q.status === 'fixed'
      ? { fixed: true, exported: q.exported, client: q.client }
      : { status: q.status, fixed: q.fixed, exported: q.exported, client: q.client };
    return { feedback: await adminListTesterFeedback(db, filter, undefined, req.wallet) };
  });

  /** Stamp reports as exported (first time only) after the panel copied them. */
  app.post('/admin/tester/feedback/exported', { preHandler: requireAdmin, ...adminLimit }, async (req) => {
    const { ids } = parse(ExportedBody, req.body);
    return adminMarkFeedbackExported(db, ids);
  });

  app.post('/admin/tester/feedback/:id/rate', { preHandler: requireAdmin, ...adminLimit }, async (req) => {
    const { id } = parse(IdParams, req.params);
    const body = parse(RateBody, req.body);
    return adminRateTesterFeedback(db, id, req.wallet, body);
  });

  app.get('/admin/tester/board/hidden', { preHandler: requireAdmin, ...adminLimit }, async () => ({
    hidden: await adminListBoardHidden(db),
  }));

  app.post('/admin/tester/board/hide', { preHandler: requireAdmin, ...adminLimit }, async (req) => {
    const body = parse(HideBody, req.body);
    return adminSetBoardHidden(db, body.wallet, body.hidden, req.wallet, body.reason);
  });

  app.get('/admin/tester/export', { preHandler: requireAdmin, ...adminLimit }, async () => ({
    testers: await adminExportTesters(db),
    exportedAt: new Date().toISOString(),
  }));
}
