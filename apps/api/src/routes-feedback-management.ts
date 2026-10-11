/** Public fields are curated; private reports and staff actions require the
 * existing authenticated account/admin boundary. Global IP limits still apply. */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_ISSUES, FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { z } from 'zod';
import type { Config } from './config';
import type { Db } from './db/client';
import { AdminFeedbackPageQuery, adminPageTesterFeedback } from './game/tester';
import { FeedbackIssueReopenBody, FeedbackIssueSplitBody, reopenFeedbackIssue, splitFeedbackIssue } from './game/feedbackIssueSplit';
import { FeedbackIssueMergeBody, mergeFeedbackIssues } from './game/feedbackIssueMerge';
import { addPrivateFeedbackEvidence, FeedbackEvidenceBody } from './game/feedbackEvidence';
import { feedbackClientOrigin } from './game/feedbackOrigin';
import { confirmFeedbackIssue, getFeedbackIssue, searchFeedbackIssues } from './game/feedbackIssues';
import { curateFeedbackIssue, FeedbackIssueCurationBody, FeedbackIssueLinkBody, linkFeedbackReport } from './game/feedbackIssueModeration';
import { FeedbackRewardReviewBody, reviewFeedbackReward } from './game/feedbackRewards';
import { FeedbackAdminIssueQuery, FeedbackIssueHistoryQuery, getAdminFeedbackIssue, getAdminFeedbackIssueHistory, listAdminFeedbackIssues } from './game/feedbackIssueHistory';
import { FeedbackPreservationBody, setFeedbackScreenshotPreservation } from './game/feedbackRetention';
import { FeedbackClosureBody, setFeedbackThreadClosed, setFeedbackThreadLock } from './game/feedbackModeration';
import { FeedbackFixedBody, FeedbackTrashBody, setFeedbackReportFixed, setFeedbackReportTrashed } from './game/feedbackReportState';
import { HttpError } from './lib/errors';
import { parse } from './lib/validation';
const Id = z.object({ id: z.string().uuid() }).strict();
const Search = z.object({ query: z.string().max(FEEDBACK_ISSUES.queryMaxLen).optional(), category: z.enum(TESTER_PROGRAM.feedback.categories).optional() }).strict();
const Lock = z.object({ requestId: FeedbackIssueLinkBody.shape.requestId, locked: z.boolean(), reason: z.string().trim().min(1).max(FEEDBACK_THREADS.moderationReasonMaxLen) }).strict();
const Create = FeedbackIssueCurationBody.omit({ issueId: true, expectedRevision: true });
const Update = FeedbackIssueCurationBody.omit({ issueId: true }).extend({ expectedRevision: FeedbackIssueLinkBody.shape.expectedIssueRevision });
export function registerFeedbackManagementRoutes(app: FastifyInstance, config: Config, db: Db): void {
  async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
    if (!config.ADMIN_WALLETS) throw new HttpError(404, 'not found');
    await app.authenticate(req, reply);
    if (!config.ADMIN_WALLETS.includes(req.wallet)) throw new HttpError(403, 'admin access required');
  }
  const onRequest = async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Vary', 'Cookie, Authorization');
  };
  const admin = { preHandler: requireAdmin, onRequest };
  // Published catalogue reads expose the same fixed eight-field allowlist with
  // or without a session. They do not grant access to linked reports.
  app.get('/tester/issues', { onRequest }, async req => {
    const input = parse(Search, req.query);
    return { issues: await searchFeedbackIssues(db, {
      ...(input.query === undefined ? {} : { query: input.query }),
      ...(input.category === undefined ? {} : { category: input.category }),
    }) };
  });
  app.get('/tester/issues/:id', { onRequest }, async req => getFeedbackIssue(db, parse(Id, req.params).id));
  app.post('/tester/issues/:id/confirm', { preHandler: app.authenticate, onRequest }, async req => {
    parse(z.object({}).strict(), req.body ?? {});
    return confirmFeedbackIssue(db, req.wallet, parse(Id, req.params).id);
  });
  app.post('/tester/issues/:id/evidence', { preHandler: app.authenticate, onRequest }, async req =>
    addPrivateFeedbackEvidence(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackEvidenceBody, req.body), feedbackClientOrigin(req.headers)));
  app.get('/admin/tester/feedback/page', admin, async req => adminPageTesterFeedback(db, config, req.wallet, parse(AdminFeedbackPageQuery, req.query)));
  app.get('/admin/tester/issues', admin, async req => listAdminFeedbackIssues(db, config, req.wallet, parse(FeedbackAdminIssueQuery, req.query)));
  app.get('/admin/tester/issues/:id', admin, async req => getAdminFeedbackIssue(db, config, req.wallet, parse(Id, req.params).id));
  app.get('/admin/tester/issues/:id/history', admin, async req => getAdminFeedbackIssueHistory(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackIssueHistoryQuery, req.query)));
  app.post('/admin/tester/issues', admin, async req => curateFeedbackIssue(db, config, req.wallet, parse(Create, req.body)));
  app.patch('/admin/tester/issues/:id', admin, async req => curateFeedbackIssue(db, config, req.wallet, {
    ...parse(Update, req.body), issueId: parse(Id, req.params).id,
  }));
  app.post('/admin/tester/issues/:id/split', admin, async req => splitFeedbackIssue(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackIssueSplitBody, req.body)));
  app.post('/admin/tester/issues/:id/reopen', admin, async req => reopenFeedbackIssue(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackIssueReopenBody, req.body)));
  app.post('/admin/tester/issues/:id/merge', admin, async req => mergeFeedbackIssues(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackIssueMergeBody, req.body)));
  app.post('/admin/tester/feedback/:id/link', admin, async req => linkFeedbackReport(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackIssueLinkBody, req.body)));
  app.post('/admin/tester/feedback/:id/review', admin, async req => reviewFeedbackReward(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackRewardReviewBody, req.body)));
  app.post('/admin/tester/feedback/:id/closure', admin, async req => setFeedbackThreadClosed(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackClosureBody, req.body)));
  app.post('/admin/tester/feedback/:id/fixed', admin, async req => setFeedbackReportFixed(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackFixedBody, req.body)));
  app.post('/admin/tester/feedback/:id/trash', admin, async req => setFeedbackReportTrashed(db, config, req.wallet, parse(Id, req.params).id, parse(FeedbackTrashBody, req.body)));
  app.post('/admin/tester/feedback/:id/screenshots/:attachmentId/preservation', admin, async req => {
    const params=parse(z.object({id:z.string().uuid(),attachmentId:z.string().uuid()}).strict(),req.params);
    return setFeedbackScreenshotPreservation(db,config,req.wallet,params.id,params.attachmentId,parse(FeedbackPreservationBody,req.body));
  });
  app.post('/admin/tester/feedback/:id/lock', admin, async req => setFeedbackThreadLock(db, config, req.wallet, parse(Id, req.params).id, parse(Lock, req.body)));
}
