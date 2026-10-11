/** Explicit staff curation. Linking never copies private report text into a
 * public issue or rewrites existing reward decisions. */
import { createHash, randomUUID } from 'node:crypto';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_THREADS as LIMIT } from '@shardkeep/shared/feedback';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { DbOrTx } from '../db/client';
import { feedbackIssueActions, feedbackIssueLinks, feedbackIssues, feedbackMessages, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockFeedbackModeration } from './feedbackModerationLock';
import { lockFeedbackReport } from './feedbackThreads';

export const FeedbackIssueLinkBody = z.object({
  requestId: z.string().min(1).max(LIMIT.requestIdMaxLen).regex(/^[A-Za-z0-9_-]+$/),
  issueId: z.string().uuid(),
  expectedIssueRevision: z.number().int().positive().safe(),
  expectedReportRevision: z.number().int().positive().safe(),
  reason: z.string().trim().min(1).max(LIMIT.moderationReasonMaxLen),
}).strict();
export type FeedbackIssueLinkInput = z.infer<typeof FeedbackIssueLinkBody>;
export interface FeedbackIssueLinkReceipt {
  reportId: string; issueId: string; issueRevision: number;
  revision: number; reporterRevision: number; messageId: string;
  awardClaims: {reportId:string;issueId:string;points:number}[];
}
export async function linkFeedbackReport(db: DbOrTx, config: Pick<Config, 'ADMIN_WALLETS'>,
  admin: string, reportId: string, raw: FeedbackIssueLinkInput): Promise<FeedbackIssueLinkReceipt> {
  if (!config.ADMIN_WALLETS?.includes(admin)) throw new HttpError(404, 'feedback not found');
  const parsed = FeedbackIssueLinkBody.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid issue link');
  const input = parsed.data;
  const requestHash = createHash('sha256').update(JSON.stringify({ reportId, ...input })).digest('hex');
  return db.transaction(async tx => {
    await lockFeedbackModeration(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${admin}`}, 0))`);
    const report = await lockFeedbackReport(tx, config, { wallet: admin, mode: 'admin' }, reportId);
    const [prior] = await tx.select().from(feedbackMessages).where(and(eq(feedbackMessages.author, admin), eq(feedbackMessages.requestId, input.requestId)));
    if (prior) {
      const context = prior.context as { action?: string; requestHash?: string; receipt?: FeedbackIssueLinkReceipt } | null;
      if (prior.reportId !== reportId || context?.action !== 'issue-link' || context.requestHash !== requestHash || !context.receipt) {
        throw new HttpError(409, 'issue link request changed', 'FEEDBACK_MODERATION_CONFLICT');
      }
      return context.receipt;
    }
    const [issue] = await tx.select().from(feedbackIssues).where(eq(feedbackIssues.id, input.issueId)).for('update');
    if (!issue) throw new HttpError(404, 'issue not found');
    if (issue.status === 'merged' || issue.mergedInto) throw new HttpError(409, 'select the current canonical issue', 'FEEDBACK_ISSUE_MERGED');
    if (issue.revision !== input.expectedIssueRevision || report.revision !== input.expectedReportRevision) {
      throw new HttpError(409, 'issue or report changed; refresh before linking', 'FEEDBACK_REVIEW_STALE');
    }
    const [previousLink] = await tx.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.reportId,reportId));
    const awardClaims = previousLink && report.basePoints > 0 && (report.rewardPolicyVersion === 2 || report.status === 'accepted')
      ? [{reportId,issueId:previousLink.issueId,points:report.points}] : [];
    const revision = report.revision + 1, reporterRevision = report.reporterRevision + 1;
    // The reason and any unpublished issue identity remain staff-only context.
    // The reporter sees that review advanced without leaking another report.
    const [message] = await tx.insert(feedbackMessages).values({ reportId, author: admin,
      requestId: input.requestId, kind: 'status', visibility: 'reporter',
      revision, reporterRevision, body: 'Your report has been linked to the issue under review.',
      context: { authorRole: 'admin', action: 'issue-link', requestHash, reason: input.reason },
    }).returning({ id: feedbackMessages.id });
    const receipt: FeedbackIssueLinkReceipt = { reportId, issueId: issue.id, issueRevision: issue.revision,
      revision, reporterRevision, messageId: message!.id, awardClaims };
    await tx.update(feedbackMessages).set({ context: { authorRole: 'admin', action: 'issue-link', requestHash, reason: input.reason, receipt } })
      .where(eq(feedbackMessages.id, message!.id));
    await tx.insert(feedbackIssueLinks).values({ reportId, issueId: issue.id, linkedBy: admin, reason: input.reason })
      .onConflictDoUpdate({ target: feedbackIssueLinks.reportId, set: { issueId: issue.id, linkedBy: admin, reason: input.reason, createdAt: new Date() } });
    await tx.update(testerFeedback).set({ revision, reporterRevision }).where(eq(testerFeedback.id, reportId));
    return receipt;
  });
}


const CuratedFields = z.object({
  title: z.string().trim().min(1).max(TESTER_PROGRAM.feedback.titleMaxLen),
  summary: z.string().trim().min(1).max(TESTER_PROGRAM.feedback.bodyMaxLen),
  category: z.enum(TESTER_PROGRAM.feedback.categories),
  workaround: z.string().trim().min(1).max(TESTER_PROGRAM.feedback.bodyMaxLen).nullable(),
  fixedRelease: z.string().trim().min(1).max(TESTER_PROGRAM.feedback.titleMaxLen).nullable(),
  status: z.enum(['open', 'investigating', 'planned', 'fixed', 'closed']),
  published: z.boolean(),
}).strict();
export const FeedbackIssueCurationBody = CuratedFields.extend({
  requestId: FeedbackIssueLinkBody.shape.requestId, reason: FeedbackIssueLinkBody.shape.reason,
  issueId: z.string().uuid().optional(),
  expectedRevision: z.number().int().positive().safe().optional(),
}).strict();
export type FeedbackIssueCurationInput = z.infer<typeof FeedbackIssueCurationBody>;
export interface FeedbackIssueCurationReceipt {
  issueId: string; revision: number; publishedAt: string | null;
  fields: z.infer<typeof CuratedFields>;
}
/** Omit issueId/revision together to create. Updates include both. Publication
 * requires submitting every reviewed public field, never deriving from reports. */
export async function curateFeedbackIssue(db: DbOrTx, config: Pick<Config, 'ADMIN_WALLETS'>,
  admin: string, raw: FeedbackIssueCurationInput): Promise<FeedbackIssueCurationReceipt> {
  if (!config.ADMIN_WALLETS?.includes(admin)) throw new HttpError(404, 'issue not found');
  const parsed = FeedbackIssueCurationBody.safeParse(raw);
  if (!parsed.success || Boolean(parsed.data.issueId) !== Boolean(parsed.data.expectedRevision)) throw new HttpError(400, 'invalid curated issue');
  const input = parsed.data;
  const requestHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  const fields = CuratedFields.parse(Object.fromEntries(Object.keys(CuratedFields.shape).map(key => [key, input[key as keyof typeof input]])));
  return db.transaction(async tx => {
    await lockFeedbackModeration(tx);
    const [prior] = await tx.select().from(feedbackIssueActions).where(and(eq(feedbackIssueActions.admin, admin), eq(feedbackIssueActions.requestId, input.requestId)));
    if (prior) {
      if (prior.requestHash !== requestHash || !['create', 'update', 'publish'].includes(prior.action)) throw new HttpError(409, 'curation request changed', 'FEEDBACK_MODERATION_CONFLICT');
      return prior.receipt as FeedbackIssueCurationReceipt;
    }
    const [existing] = input.issueId ? await tx.select().from(feedbackIssues).where(eq(feedbackIssues.id, input.issueId)).for('update') : [];
    if (input.issueId && !existing) throw new HttpError(404, 'issue not found');
    if (existing && existing.revision !== input.expectedRevision) throw new HttpError(409, 'issue changed; refresh before editing', 'FEEDBACK_REVIEW_STALE');
    if (existing?.mergedInto || existing?.status === 'merged') throw new HttpError(409, 'select the current canonical issue', 'FEEDBACK_ISSUE_MERGED');
    if (existing && ['fixed', 'closed'].includes(existing.status) && !['fixed', 'closed'].includes(input.status)) {
      throw new HttpError(409, 'reopen this issue explicitly before changing its active state', 'FEEDBACK_ISSUE_REOPEN_REQUIRED');
    }
    const issueId = existing?.id ?? randomUUID(), revision = (existing?.revision ?? 0) + 1;
    const publishedAt = input.published ? existing?.publishedAt ?? new Date() : null;
    const values = { title: input.title, body: input.summary, category: input.category, workaround: input.workaround,
      fixedRelease: input.fixedRelease, status: input.status, approvedBy: admin, publishedAt, revision };
    if (existing) await tx.update(feedbackIssues).set(values).where(eq(feedbackIssues.id, issueId));
    else await tx.insert(feedbackIssues).values({ id: issueId, ...values });
    const receipt: FeedbackIssueCurationReceipt = { issueId, revision, publishedAt: publishedAt?.toISOString() ?? null, fields };
    await tx.insert(feedbackIssueActions).values({ admin, requestId: input.requestId, requestHash,
      action: !existing ? 'create' : publishedAt && !existing.publishedAt ? 'publish' : 'update', reason: input.reason, receipt });
    return receipt;
  });
}
