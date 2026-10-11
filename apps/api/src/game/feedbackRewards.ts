/** D-116 reviewed policy-2 awards. Status is never implicit consent to pay.
 * All future link/merge/reward writers take this global lock FIRST. */
import { createHash, randomUUID } from 'node:crypto';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_THREADS as LIMIT } from '@shardkeep/shared/feedback';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackIssueLinks, feedbackIssues, feedbackMessages, feedbackRewardDecisions, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockFeedbackReport } from './feedbackThreads';
import { curateFeedbackIssue, linkFeedbackReport } from './feedbackIssueModeration';
import { lockFeedbackModeration } from './feedbackModerationLock';
export { lockFeedbackModeration } from './feedbackModerationLock';

/** Immutable recognized claims survive a later relink, including policy-1
 * awards that predate structured feedback_reward_decisions. */
export const recordedFeedbackAwardClaims = sql`
  select claim->>'reportId' as report_id,claim->>'issueId' as issue_id from feedback_issue_actions a
    cross join lateral jsonb_array_elements(coalesce(a.receipt->'awardClaims','[]'::jsonb)) claim
  union select claim->>'reportId' as report_id,claim->>'issueId' as issue_id from feedback_messages m
    cross join lateral jsonb_array_elements(coalesce(m.context->'receipt'->'awardClaims','[]'::jsonb)) claim
    where m.context->>'action'='issue-link'`;

export const FeedbackRewardReviewBody = z.object({
  requestId: z.string().min(1).max(LIMIT.requestIdMaxLen).regex(/^[A-Za-z0-9_-]+$/),
  expectedRevision: z.number().int().positive().safe(),
  status: z.enum(['reviewed', 'accepted', 'rejected', 'duplicate']),
  verdict: z.enum(['unverified', 'actionable', 'not_actionable']),
  award: z.enum(['none', 'first_actionable', 'useful_evidence']),
  importance: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  reason: z.string().trim().min(1).max(LIMIT.moderationReasonMaxLen),
  verificationEvidence: z.string().trim().min(1).max(LIMIT.moderationReasonMaxLen).optional(),
  /** Explicit quick-review consent; omitted historical requests keep their hash. */
  preparePrivateIssue: z.boolean().optional(),
}).strict();
export type FeedbackRewardReview = z.infer<typeof FeedbackRewardReviewBody>;
export interface FeedbackRewardReceipt {
  id: string; reportId: string; issueId: string | null; revision: number; reporterRevision: number;
  status: FeedbackRewardReview['status']; verdict: FeedbackRewardReview['verdict']; award: FeedbackRewardReview['award'];
  basePoints: number; bonusPoints: number; points: number; delta: number; createdDay: string; verificationEvidence: string | null;
}
export async function reviewFeedbackReward(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>,
  admin: string, reportId: string, raw: FeedbackRewardReview): Promise<FeedbackRewardReceipt> {
  if (!config.ADMIN_WALLETS?.includes(admin)) throw new HttpError(404, 'feedback not found');
  const parsed = FeedbackRewardReviewBody.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid feedback review');
  const input = parsed.data;
  if (input.award !== 'none' && (input.verdict !== 'actionable' || !input.verificationEvidence || !input.importance
    || input.status === 'rejected' || (input.award === 'first_actionable' && input.status !== 'accepted'))) {
    throw new HttpError(400, 'awards require an explicit actionable verdict, importance and verification evidence');
  }
  const requestHash = createHash('sha256').update(JSON.stringify({ reportId, ...input })).digest('hex');
  return db.transaction(async tx => {
    await lockFeedbackModeration(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${admin}`}, 0))`);
    const report = await lockFeedbackReport(tx, config, { wallet: admin, mode: 'admin' }, reportId);
    const [old] = await tx.select().from(feedbackRewardDecisions).where(and(eq(feedbackRewardDecisions.admin, admin), eq(feedbackRewardDecisions.requestId, input.requestId)));
    if (old) {
      if (old.requestHash !== requestHash) throw new HttpError(409, 'reward request changed', 'FEEDBACK_REWARD_CONFLICT');
      return old.receipt as FeedbackRewardReceipt;
    }
    const [usedMessage] = await tx.select({ id: feedbackMessages.id }).from(feedbackMessages).where(and(eq(feedbackMessages.author, admin), eq(feedbackMessages.requestId, input.requestId)));
    if (usedMessage) throw new HttpError(409, 'request ID belongs to another operation', 'FEEDBACK_REWARD_CONFLICT');
    if (report.rewardPolicyVersion !== 2) throw new HttpError(409, 'historical rewards must be preserved', 'FEEDBACK_HISTORICAL_REWARD');
    if (report.revision !== input.expectedRevision) throw new HttpError(409, 'feedback changed; refresh before reviewing', 'FEEDBACK_REVIEW_STALE');
    if (report.fixedAt && input.status !== 'accepted') throw new HttpError(409, 'reopen a fixed report before changing its triage', 'FEEDBACK_FIXED_CONFLICT');
    const [link] = await tx.select({ issueId: feedbackIssueLinks.issueId, status: feedbackIssues.status, mergedInto: feedbackIssues.mergedInto }).from(feedbackIssueLinks)
      .innerJoin(feedbackIssues, eq(feedbackIssues.id, feedbackIssueLinks.issueId)).where(eq(feedbackIssueLinks.reportId, reportId));
    let issueId = link?.issueId ?? null;
    let currentRevision = report.revision, currentReporterRevision = report.reporterRevision;
    if (input.award !== 'none' && !issueId && input.preparePrivateIssue) {
      // Preparation and payment share the outer transaction: a policy conflict
      // must not leave an orphan draft or a half-finished report review.
      const operation = createHash('sha256').update(input.requestId).digest('hex');
      const created = await curateFeedbackIssue(tx, config, admin, {
        requestId: `quick-issue-${operation}`, title: report.title, category: report.category as typeof TESTER_PROGRAM.feedback.categories[number],
        summary: `Private report ${reportId}. Review and write a public summary before publishing.`,
        status: 'open', published: false, workaround: null, fixedRelease: null,
        reason: 'Private issue prepared for an explicit admin feedback award.',
      });
      const linked = await linkFeedbackReport(tx, config, admin, reportId, {
        requestId: `quick-link-${operation}`, issueId: created.issueId, expectedIssueRevision: created.revision,
        expectedReportRevision: report.revision, reason: 'Private issue linked for an explicit admin feedback award.',
      });
      issueId = linked.issueId; currentRevision = linked.revision; currentReporterRevision = linked.reporterRevision;
    }
    if (input.award !== 'none' && !issueId) throw new HttpError(409, 'link a verified canonical issue before awarding points', 'FEEDBACK_ISSUE_REQUIRED');
    if (input.award !== 'none' && (link?.status === 'merged' || link?.mergedInto)) throw new HttpError(409, 'link the current canonical issue before awarding points', 'FEEDBACK_ISSUE_MERGED');
    if (input.award === 'first_actionable') {
      const blockers = await tx.execute<{ id: string }>(sql`select f.id from feedback_issue_links l join tester_feedback f on f.id = l.report_id
        where l.issue_id = ${issueId} and (f.created_at, f.id) < (${report.createdAt.toISOString()}::timestamptz, ${reportId}::uuid)
          and f.status not in ('rejected', 'duplicate') and coalesce((select d.receipt->>'verdict' from feedback_reward_decisions d
            where d.report_id = f.id order by d.report_revision desc limit 1), 'unverified') <> 'not_actionable'
        order by f.created_at, f.id limit 1`);
      if (blockers.length) throw new HttpError(409, 'review the earlier linked report first', 'FEEDBACK_EARLIER_REPORT', { reportId: blockers[0]!.id });
      const prior = await tx.execute<{ id: string }>(sql`with recursive canonical_history(id) as (select ${issueId}::uuid union select i.id from feedback_issues i join canonical_history h on i.merged_into=h.id)
        select f.id from feedback_issue_links l join tester_feedback f on f.id=l.report_id
        where l.issue_id=${issueId} and f.id<>${reportId} and f.base_points>0
          and (f.reward_policy_version=2 or f.status='accepted')
        union select d.report_id as id from feedback_reward_decisions d where d.report_id<>${reportId}
          and d.receipt->>'issueId' in(select id::text from canonical_history) and d.receipt->>'award'='first_actionable'
        union select c.report_id::uuid as id from (${recordedFeedbackAwardClaims}) c
          where c.report_id<>${reportId} and c.issue_id in(select id::text from canonical_history) limit 1`);
      // A historical/merged conflict is flagged; never resolve it by clawing points back.
      if (prior.length) throw new HttpError(409, 'this issue already has an award requiring review', 'FEEDBACK_ISSUE_AWARD_CONFLICT', { reportId: prior[0]!.id });
    }
    const basePoints = input.award === 'first_actionable' ? Math.max(report.basePoints, TESTER_PROGRAM.feedback.basePoints) : report.basePoints;
    const bonusPoints = input.award === 'none' ? report.bonusPoints : Math.max(report.bonusPoints, TESTER_PROGRAM.feedback.importanceBonus[input.importance!]);
    const points = basePoints + bonusPoints; const delta = points - report.points;
    if (delta < 0) throw new HttpError(409, 'existing reward totals require manual review', 'FEEDBACK_REWARD_TOTAL_CONFLICT');
    const createdDay = report.createdAt.toISOString().slice(0, 10);
    if (delta > 0 && report.points === 0) {
      const paid = await tx.execute<{ count: number }>(sql`select count(*)::int as count from tester_feedback where wallet=${report.wallet} and points>0
        and created_at >= (${createdDay}::date::timestamp at time zone 'UTC') and created_at < ((${createdDay}::date + 1)::timestamp at time zone 'UTC')`);
      if (paid[0]!.count >= TESTER_PROGRAM.feedback.dailyPaidSubmissions) throw new HttpError(409, 'rewarded report limit reached for that submission day', 'FEEDBACK_REWARD_DAY_LIMIT');
    }
    const revision = currentRevision + 1; const reporterRevision = currentReporterRevision + 1;
    const receipt: FeedbackRewardReceipt = { id: randomUUID(), reportId, issueId, revision, reporterRevision,
      status: input.status, verdict: input.verdict, award: input.award, basePoints, bonusPoints, points, delta, createdDay, verificationEvidence: input.verificationEvidence ?? null };
    await tx.insert(feedbackRewardDecisions).values({ id: receipt.id, reportId, wallet: report.wallet, admin,
      requestId: input.requestId, requestHash, policyVersion: 2, reportRevision: revision, reason: input.reason,
      receipt });
    await tx.insert(feedbackMessages).values({ reportId, author: admin, kind: 'status', visibility: 'reporter',
      revision, reporterRevision, requestId: input.requestId, body: `Review updated. Total feedback points: ${points}.`, context: { authorRole: 'admin', action: 'reward-review' } });
    await tx.update(testerFeedback).set({ status: input.status, importance: input.importance ?? report.importance,
      basePoints, bonusPoints, points, revision, reporterRevision, reviewedAt: new Date(), reviewedBy: admin }).where(eq(testerFeedback.id, reportId));
    return receipt;
  });
}
