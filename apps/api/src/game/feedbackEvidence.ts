/** A player explicitly sends private evidence; browsing never creates reports. */
import { createHash } from 'node:crypto';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackEvidenceRequests, feedbackIssueLinks, feedbackIssues, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';
import { FeedbackIssueLinkBody } from './feedbackIssueModeration';
import { lockFeedbackModeration } from './feedbackRewards';
import { appendFeedbackReply } from './feedbackThreads';
import { FeedbackDiagnosticContext, submitTesterFeedback } from './tester';
import type { FeedbackClientOrigin } from './feedbackOrigin';
export const FeedbackEvidenceBody = z.object({
  requestId: FeedbackIssueLinkBody.shape.requestId, mode: z.enum(['evidence', 'recurrence']),
  title: z.string().trim().min(1).max(TESTER_PROGRAM.feedback.titleMaxLen),
  body: z.string().trim().min(TESTER_PROGRAM.feedback.bodyMinLen).max(TESTER_PROGRAM.feedback.bodyMaxLen),
  context: FeedbackDiagnosticContext.optional(),
}).strict();
export interface FeedbackEvidenceReceipt {
  reportId: string; messageId: string | null; reused: boolean; recurrence: boolean;
  issueRevision: number; basePoints: number; dailyRemaining: number | null;
}
export async function addPrivateFeedbackEvidence(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>,
  wallet: string, issueId: string, raw: z.infer<typeof FeedbackEvidenceBody>,
  /** Header-derived display label; outside the strict body and its request hash. */
  origin?: FeedbackClientOrigin): Promise<FeedbackEvidenceReceipt> {
  const parsed = FeedbackEvidenceBody.safeParse(raw);
  if (!parsed.success || !z.string().uuid().safeParse(issueId).success) throw new HttpError(400, 'invalid private evidence');
  const input = parsed.data;
  const requestHash = createHash('sha256').update(JSON.stringify({issueId,...input})).digest('hex');
  return db.transaction(async tx => {
    await lockFeedbackModeration(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`tester-feedback:${wallet}`},0))`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${wallet}`},0))`);
    const [prior] = await tx.select().from(feedbackEvidenceRequests).where(and(eq(feedbackEvidenceRequests.wallet,wallet),eq(feedbackEvidenceRequests.requestId,input.requestId)));
    if (prior) {
      if (prior.requestHash !== requestHash) throw new HttpError(409,'evidence request changed','FEEDBACK_REQUEST_CONFLICT');
      const [original] = await tx.select({ trashedAt: testerFeedback.trashedAt }).from(testerFeedback).where(eq(testerFeedback.id, prior.reportId));
      if (!original || original.trashedAt) throw new HttpError(409,'this report was removed; start new evidence if needed','FEEDBACK_REPORT_TRASHED');
      return prior.receipt as FeedbackEvidenceReceipt;
    }
    // Global moderation serialization prevents a link, merge or issue revision
    // changing between candidate selection and its report/issue locks.
    const [candidate] = await tx.select({id:testerFeedback.id}).from(testerFeedback)
      .innerJoin(feedbackIssueLinks,eq(feedbackIssueLinks.reportId,testerFeedback.id))
      .where(and(eq(testerFeedback.wallet,wallet),eq(feedbackIssueLinks.issueId,issueId),sql`${testerFeedback.trashedAt} is null`,
        input.mode === 'recurrence' ? sql`${testerFeedback.closedAt} is null and exists(select 1 from feedback_evidence_requests e join feedback_issues i on i.id=e.issue_id
          where e.report_id=${testerFeedback.id} and e.wallet=${wallet} and e.issue_id=${issueId}
          and e.receipt->>'recurrence'='true' and e.receipt->>'issueRevision'=i.revision::text)` : undefined))
      .orderBy(desc(testerFeedback.createdAt),desc(testerFeedback.id)).limit(1);
    const [report] = candidate ? await tx.select().from(testerFeedback).where(eq(testerFeedback.id,candidate.id)).for('update') : [];
    const [issue] = await tx.select().from(feedbackIssues).where(eq(feedbackIssues.id,issueId)).for('update');
    if (!issue || !issue.publishedAt || issue.publishedAt > new Date()) throw new HttpError(404,'issue not found');
    if (issue.mergedInto || issue.status==='merged') throw new HttpError(409,'this issue was merged; reopen it to review the current summary before sending evidence','FEEDBACK_ISSUE_MERGED');
    const terminal = issue.status==='fixed' || issue.status==='closed';
    if (terminal && input.mode !== 'recurrence') throw new HttpError(409,'this issue was resolved; choose NEW RECURRENCE to report it happening again','FEEDBACK_RECURRENCE_REQUIRED');
    if (!terminal && input.mode==='recurrence') throw new HttpError(409,'issue is active; add evidence to its current thread','FEEDBACK_ISSUE_CHANGED');
    let receipt: FeedbackEvidenceReceipt;
    if (report) {
      const message=await appendFeedbackReply(tx,config,{wallet,mode:'reporter'},report.id,{requestId:input.requestId,body:input.body,origin});
      receipt={reportId:report.id,messageId:message.id,reused:true,recurrence:terminal,issueRevision:issue.revision,basePoints:0,dailyRemaining:null};
    } else {
      const [used]=await tx.select({id:testerFeedback.id}).from(testerFeedback).where(and(eq(testerFeedback.wallet,wallet),eq(testerFeedback.requestId,input.requestId)));
      if (used) throw new HttpError(409,'request ID belongs to a different report','FEEDBACK_REQUEST_CONFLICT');
      const created=await submitTesterFeedback(tx,wallet,{requestId:input.requestId,category:issue.category as typeof TESTER_PROGRAM.feedback.categories[number],title:input.title,body:input.body,origin,...(input.context===undefined?{}:{context:input.context})});
      await tx.insert(feedbackIssueLinks).values({reportId:created.id,issueId,linkedBy:wallet,reason:terminal?'Reporter submitted an explicit recurrence':'Reporter added private evidence'});
      receipt={reportId:created.id,messageId:null,reused:false,recurrence:terminal,issueRevision:issue.revision,basePoints:0,dailyRemaining:created.dailyRemaining};
    }
    await tx.insert(feedbackEvidenceRequests).values({wallet,requestId:input.requestId,requestHash,issueId,reportId:receipt.reportId,receipt});
    return receipt;
  });
}
