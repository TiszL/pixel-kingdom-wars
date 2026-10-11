/** Explicit issue split/reopen. Report closure and earned points are independent. */
import { createHash, randomUUID } from 'node:crypto';
import { FEEDBACK_ISSUES as LIMIT } from '@shardkeep/shared/feedback';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackIssueActions, feedbackIssueLinks, feedbackIssues, feedbackMessages, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';
import { FeedbackIssueCurationBody, FeedbackIssueLinkBody } from './feedbackIssueModeration';
import { lockFeedbackModeration } from './feedbackRewards';
const Request = z.object({requestId:FeedbackIssueLinkBody.shape.requestId,reason:FeedbackIssueLinkBody.shape.reason});
export const FeedbackIssueSplitBody = Request.extend({
  expectedSourceRevision:FeedbackIssueLinkBody.shape.expectedIssueRevision,
  reports:z.array(z.object({id:z.string().uuid(),expectedRevision:FeedbackIssueLinkBody.shape.expectedIssueRevision}).strict()).min(1).max(LIMIT.maxSplitReports),
  target:FeedbackIssueCurationBody.omit({requestId:true,reason:true,issueId:true,expectedRevision:true}),
}).strict().refine(value=>new Set(value.reports.map(r=>r.id)).size===value.reports.length,'select each report once');
export const FeedbackIssueReopenBody = Request.extend({expectedRevision:FeedbackIssueLinkBody.shape.expectedIssueRevision}).strict();
export interface FeedbackIssueSplitReceipt {issueId:string;targetIssueId:string;sourceRevision:number;targetRevision:number;movedReportIds:string[];
  target:z.infer<typeof FeedbackIssueSplitBody>['target'];awardClaims:{reportId:string;issueId:string;points:number}[];}
export interface FeedbackIssueReopenReceipt {issueId:string;revision:number;status:'open';previousStatus:string;previousRevision:number;previousFixedRelease:string|null;fixedRelease:null;}
function authorized(config:Pick<Config,'ADMIN_WALLETS'>,admin:string,id:string){
  if(!config.ADMIN_WALLETS?.includes(admin))throw new HttpError(404,'issue not found');
  if(!z.string().uuid().safeParse(id).success)throw new HttpError(400,'invalid issue ID');
}
export async function splitFeedbackIssue(db:Db,config:Pick<Config,'ADMIN_WALLETS'>,admin:string,sourceId:string,raw:z.infer<typeof FeedbackIssueSplitBody>):Promise<FeedbackIssueSplitReceipt>{
  authorized(config,admin,sourceId);const parsed=FeedbackIssueSplitBody.safeParse(raw);if(!parsed.success)throw new HttpError(400,'invalid split request');
  const input=parsed.data,requestHash=createHash('sha256').update(JSON.stringify({sourceId,...input})).digest('hex');
  return db.transaction(async tx=>{
    await lockFeedbackModeration(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${admin}`},0))`);
    const [prior]=await tx.select().from(feedbackIssueActions).where(and(eq(feedbackIssueActions.admin,admin),eq(feedbackIssueActions.requestId,input.requestId)));
    if(prior){if(prior.action!=='split'||prior.requestHash!==requestHash)throw new HttpError(409,'split request changed','FEEDBACK_MODERATION_CONFLICT');return prior.receipt as FeedbackIssueSplitReceipt;}
    const reportIds=input.reports.map(r=>r.id).sort();
    const reports=await tx.select().from(testerFeedback).where(inArray(testerFeedback.id,reportIds)).orderBy(asc(testerFeedback.id)).for('update');
    if(reports.some(report=>report.trashedAt))throw new HttpError(409,'restore reports before moving them between issues','FEEDBACK_REPORT_TRASHED');
    const [source]=await tx.select().from(feedbackIssues).where(eq(feedbackIssues.id,sourceId)).for('update');
    if(!source)throw new HttpError(404,'issue not found');
    if(source.mergedInto)throw new HttpError(409,'select the current canonical issue','FEEDBACK_ISSUE_MERGED');
    const links=await tx.select().from(feedbackIssueLinks).where(and(eq(feedbackIssueLinks.issueId,sourceId),inArray(feedbackIssueLinks.reportId,reportIds)));
    if(source.revision!==input.expectedSourceRevision||reports.length!==reportIds.length||links.length!==reportIds.length||reports.some(r=>r.revision!==input.reports.find(x=>x.id===r.id)!.expectedRevision))throw new HttpError(409,'issue or selected reports changed; review the split again','FEEDBACK_REVIEW_STALE');
    const targetId=randomUUID(),target=input.target;
    await tx.insert(feedbackIssues).values({id:targetId,title:target.title,body:target.summary,category:target.category,workaround:target.workaround,fixedRelease:target.fixedRelease,status:target.status,publishedAt:target.published?new Date():null,approvedBy:admin});
    await tx.insert(feedbackMessages).values(reports.map(report=>({reportId:report.id,author:admin,
      requestId:`split_${createHash('sha256').update(JSON.stringify({admin,requestId:input.requestId,reportId:report.id})).digest('hex')}`,
      kind:'status',visibility:'reporter',body:'Your report now follows a separately reviewed issue.',revision:report.revision+1,reporterRevision:report.reporterRevision+1,
      context:{authorRole:'admin',action:'issue-split',sourceIssueId:sourceId,targetIssueId:targetId,reason:input.reason}})));
    await tx.update(testerFeedback).set({revision:sql`${testerFeedback.revision}+1`,reporterRevision:sql`${testerFeedback.reporterRevision}+1`}).where(inArray(testerFeedback.id,reportIds));
    await tx.update(feedbackIssueLinks).set({issueId:targetId,linkedBy:admin,reason:input.reason}).where(inArray(feedbackIssueLinks.reportId,reportIds));
    await tx.update(feedbackIssues).set({revision:source.revision+1}).where(eq(feedbackIssues.id,sourceId));
    const awardClaims=reports.filter(r=>r.basePoints>0&&(r.rewardPolicyVersion===2||r.status==='accepted')).map(r=>({reportId:r.id,issueId:sourceId,points:r.points}));
    const receipt:FeedbackIssueSplitReceipt={issueId:sourceId,targetIssueId:targetId,sourceRevision:source.revision+1,targetRevision:1,movedReportIds:reportIds,target,awardClaims};
    await tx.insert(feedbackIssueActions).values({admin,requestId:input.requestId,requestHash,action:'split',reason:input.reason,receipt});return receipt;
  });
}
/** The issue revision is the episode marker; no private report is reopened. */
export async function reopenFeedbackIssue(db:Db,config:Pick<Config,'ADMIN_WALLETS'>,admin:string,issueId:string,raw:z.infer<typeof FeedbackIssueReopenBody>):Promise<FeedbackIssueReopenReceipt>{
  authorized(config,admin,issueId);const parsed=FeedbackIssueReopenBody.safeParse(raw);if(!parsed.success)throw new HttpError(400,'invalid reopen request');
  const input=parsed.data,requestHash=createHash('sha256').update(JSON.stringify({issueId,...input})).digest('hex');
  return db.transaction(async tx=>{
    await lockFeedbackModeration(tx);
    const [prior]=await tx.select().from(feedbackIssueActions).where(and(eq(feedbackIssueActions.admin,admin),eq(feedbackIssueActions.requestId,input.requestId)));
    if(prior){if(prior.action!=='reopen'||prior.requestHash!==requestHash)throw new HttpError(409,'reopen request changed','FEEDBACK_MODERATION_CONFLICT');return prior.receipt as FeedbackIssueReopenReceipt;}
    const [issue]=await tx.select().from(feedbackIssues).where(eq(feedbackIssues.id,issueId)).for('update');if(!issue)throw new HttpError(404,'issue not found');
    if(issue.revision!==input.expectedRevision)throw new HttpError(409,'issue changed; refresh before reopening','FEEDBACK_REVIEW_STALE');
    if(!['fixed','closed'].includes(issue.status)||issue.mergedInto)throw new HttpError(409,'only fixed or closed issues can be reopened','FEEDBACK_ISSUE_REOPEN_INVALID');
    const receipt:FeedbackIssueReopenReceipt={issueId,revision:issue.revision+1,status:'open',previousStatus:issue.status,previousRevision:issue.revision,previousFixedRelease:issue.fixedRelease,fixedRelease:null};
    await tx.update(feedbackIssues).set({status:'open',revision:receipt.revision,fixedRelease:null,approvedBy:admin}).where(eq(feedbackIssues.id,issueId));
    await tx.insert(feedbackIssueActions).values({admin,requestId:input.requestId,requestHash,action:'reopen',reason:input.reason,receipt});return receipt;
  });
}
