/** Admin consolidation never changes earned tester points or public wording. */
import { createHash } from 'node:crypto';
import { FEEDBACK_ISSUES as LIMIT } from '@shardkeep/shared/feedback';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackConfirmations, feedbackIssueActions, feedbackIssueLinks, feedbackIssues, feedbackMessages, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';
import { FeedbackIssueLinkBody } from './feedbackIssueModeration';
import { lockFeedbackModeration, recordedFeedbackAwardClaims } from './feedbackRewards';
export const FeedbackIssueMergeBody = z.object({requestId:FeedbackIssueLinkBody.shape.requestId,
  targetIssueId:z.string().uuid(),expectedSourceRevision:FeedbackIssueLinkBody.shape.expectedIssueRevision,
  expectedTargetRevision:FeedbackIssueLinkBody.shape.expectedIssueRevision,reason:FeedbackIssueLinkBody.shape.reason}).strict();
export interface FeedbackIssueMergeReceipt {issueId:string;targetIssueId:string;sourceRevision:number;targetRevision:number;
  movedReportIds:string[];movedConfirmationCount:number;awardClaims:{reportId:string;issueId:string;points:number}[];awardConflicts:{reportId:string;issueId:string;points:number}[];}
export async function mergeFeedbackIssues(db:Db,config:Pick<Config,'ADMIN_WALLETS'>,admin:string,sourceId:string,raw:z.infer<typeof FeedbackIssueMergeBody>):Promise<FeedbackIssueMergeReceipt>{
  if(!config.ADMIN_WALLETS?.includes(admin))throw new HttpError(404,'issue not found');
  const parsed=FeedbackIssueMergeBody.safeParse(raw);
  if(!parsed.success||!z.string().uuid().safeParse(sourceId).success)throw new HttpError(400,'invalid merge request');
  const input=parsed.data;
  if(sourceId===input.targetIssueId)throw new HttpError(409,'choose a different canonical issue','FEEDBACK_MERGE_SELF');
  const requestHash=createHash('sha256').update(JSON.stringify({sourceId,...input})).digest('hex');
  return db.transaction(async tx=>{
    await lockFeedbackModeration(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${admin}`},0))`);
    const [prior]=await tx.select().from(feedbackIssueActions).where(and(eq(feedbackIssueActions.admin,admin),eq(feedbackIssueActions.requestId,input.requestId)));
    if(prior){if(prior.action!=='merge'||prior.requestHash!==requestHash)throw new HttpError(409,'merge request changed','FEEDBACK_MODERATION_CONFLICT');return prior.receipt as FeedbackIssueMergeReceipt;}
    const links=await tx.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.issueId,sourceId)).limit(LIMIT.maxMergeReports+1);
    if(links.length>LIMIT.maxMergeReports)throw new HttpError(409,'issue exceeds the single-merge report limit','FEEDBACK_MERGE_TOO_LARGE');
    const reportIds=links.map(l=>l.reportId).sort();
    const reports=reportIds.length?await tx.select().from(testerFeedback).where(inArray(testerFeedback.id,reportIds)).orderBy(asc(testerFeedback.id)).for('update'):[];
    const issues=await tx.select().from(feedbackIssues).where(inArray(feedbackIssues.id,[sourceId,input.targetIssueId])).orderBy(asc(feedbackIssues.id)).for('update');
    const source=issues.find(i=>i.id===sourceId),target=issues.find(i=>i.id===input.targetIssueId);
    if(!source||!target)throw new HttpError(404,'issue not found');
    if(source.mergedInto||target.mergedInto)throw new HttpError(409,'select the current canonical issue and review again','FEEDBACK_ISSUE_MERGED');
    if(source.revision!==input.expectedSourceRevision||target.revision!==input.expectedTargetRevision)throw new HttpError(409,'issue changed; refresh before merging','FEEDBACK_REVIEW_STALE');
    if(source.publishedAt&&(!target.publishedAt||target.publishedAt>new Date()))throw new HttpError(409,'publish the reviewed target before merging a published issue','FEEDBACK_MERGE_PUBLISH_TARGET');
    const claims=await tx.execute<{reportId:string;issueId:string;points:number}>(sql`
      with recursive canonical_history(id) as (select id from feedback_issues where id in(${sourceId}::uuid,${target.id}::uuid)
        union select i.id from feedback_issues i join canonical_history h on i.merged_into=h.id)
      select distinct f.id as "reportId",l.issue_id as "issueId",f.points from feedback_issue_links l join tester_feedback f on f.id=l.report_id
      where l.issue_id in(${sourceId}::uuid,${target.id}::uuid) and f.base_points>0 and (f.reward_policy_version=2 or f.status='accepted')
      union select distinct d.report_id as "reportId",(d.receipt->>'issueId')::uuid as "issueId",f.points
      from feedback_reward_decisions d join tester_feedback f on f.id=d.report_id
      where d.receipt->>'issueId' in(select id::text from canonical_history) and d.receipt->>'award'='first_actionable'
      union select c.report_id::uuid as "reportId",c.issue_id::uuid as "issueId",f.points from (${recordedFeedbackAwardClaims}) c
        join tester_feedback f on f.id=c.report_id::uuid where c.issue_id in(select id::text from canonical_history)`);
    const awardConflicts=new Set(claims.map(c=>c.reportId)).size>1?[...claims]:[];
    if(reports.length){
      await tx.insert(feedbackMessages).values(reports.map(report=>({
        reportId:report.id,author:admin,requestId:`merge_${createHash('sha256').update(JSON.stringify({admin,requestId:input.requestId,reportId:report.id})).digest('hex')}`,
        kind:'status',visibility:'reporter',body:'Your report now follows the consolidated issue.',
        revision:report.revision+1,reporterRevision:report.reporterRevision+1,
        context:{authorRole:'admin',action:'issue-merge',sourceIssueId:sourceId,targetIssueId:target.id,reason:input.reason},
      })));
      await tx.update(testerFeedback).set({revision:sql`${testerFeedback.revision}+1`,reporterRevision:sql`${testerFeedback.reporterRevision}+1`}).where(inArray(testerFeedback.id,reportIds));
    }
    const confirmationCount=await tx.execute<{count:number}>(sql`select count(*)::int as count from feedback_confirmations where issue_id=${sourceId}`);
    await tx.update(feedbackIssueLinks).set({issueId:target.id,linkedBy:admin,reason:input.reason}).where(eq(feedbackIssueLinks.issueId,sourceId));
    await tx.execute(sql`insert into feedback_confirmations(issue_id,wallet,created_at) select ${target.id}::uuid,wallet,created_at from feedback_confirmations where issue_id=${sourceId} on conflict(issue_id,wallet) do nothing`);
    await tx.delete(feedbackConfirmations).where(eq(feedbackConfirmations.issueId,sourceId));
    await tx.update(feedbackIssues).set({status:'merged',mergedInto:target.id,revision:source.revision+1}).where(eq(feedbackIssues.id,sourceId));
    await tx.update(feedbackIssues).set({revision:target.revision+1}).where(eq(feedbackIssues.id,target.id));
    const receipt:FeedbackIssueMergeReceipt={issueId:sourceId,targetIssueId:target.id,sourceRevision:source.revision+1,targetRevision:target.revision+1,movedReportIds:reportIds,movedConfirmationCount:confirmationCount[0]!.count,awardClaims:[...claims],awardConflicts};
    await tx.insert(feedbackIssueActions).values({admin,requestId:input.requestId,requestHash,action:'merge',reason:input.reason,receipt});
    return receipt;
  });
}
