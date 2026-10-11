import { randomUUID } from 'node:crypto';
import { FEEDBACK_ISSUES as LIMIT } from '@shardkeep/shared/feedback';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackConfirmations, feedbackIssueActions, feedbackIssueLinks, feedbackIssues, players, testerFeedback } from '../src/db/schema';
import { mergeFeedbackIssues } from '../src/game/feedbackIssueMerge';
import { getFeedbackIssue } from '../src/game/feedbackIssues';
import { reviewFeedbackReward } from '../src/game/feedbackRewards';
import { linkFeedbackReport } from '../src/game/feedbackIssueModeration';
import { getFeedbackThread } from '../src/game/feedbackThreads';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL);
afterAll(async()=>{await conn.sql.end();});
async function issue(admin:string,published=true){const [i]=await conn.db.insert(feedbackIssues).values({title:`Curated ${randomUUID()}`,body:'Approved public summary',approvedBy:admin,publishedAt:published?new Date():null}).returning();return i!;}
async function setup(){const admin=randomUUID(),owner=randomUUID(),other=randomUUID();await conn.db.insert(players).values([admin,owner,other].map(wallet=>({wallet})));return{admin,owner,other,config:{ADMIN_WALLETS:[admin]},source:await issue(admin),target:await issue(admin)};}
const input=(targetIssueId:string)=>({requestId:randomUUID(),targetIssueId,expectedSourceRevision:1,expectedTargetRevision:1,reason:'Private merge review'});
async function report(wallet:string,issueId:string,points=0){const [r]=await conn.db.insert(testerFeedback).values({wallet,category:'bug',title:'Private report',body:'Private report details',points,basePoints:points,status:points?'accepted':'new'}).returning();await conn.db.insert(feedbackIssueLinks).values({reportId:r!.id,issueId,linkedBy:'admin'});return r!;}
it('moves links and deduplicates confirmations while preserving points and flagging conflicting awards',async()=>{
 const f=await setup(),a=await report(f.owner,f.source.id,10),b=await report(f.other,f.target.id,10);
 await conn.db.insert(feedbackConfirmations).values([{issueId:f.source.id,wallet:f.owner},{issueId:f.source.id,wallet:f.other},{issueId:f.target.id,wallet:f.owner}]);
 const result=await mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,input(f.target.id));
 expect(result).toMatchObject({movedReportIds:[a.id],movedConfirmationCount:2});expect(new Set(result.awardConflicts.map(c=>c.reportId))).toEqual(new Set([a.id,b.id]));
 const [updated]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,a.id));expect(updated).toMatchObject({points:10,basePoints:10,status:'accepted',revision:2,reporterRevision:2});
 const [untouched]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,b.id));expect(untouched).toEqual(b);
 const dto=await getFeedbackIssue(conn.db,f.target.id);expect(dto.affectedPlayerCount).toBe(2);
 expect(await conn.db.select().from(feedbackConfirmations).where(eq(feedbackConfirmations.issueId,f.source.id))).toHaveLength(0);
 const thread=await getFeedbackThread(conn.db,f.config,{wallet:f.owner,mode:'reporter'},a.id);expect(thread.messages).toHaveLength(1);expect(JSON.stringify(thread)).not.toContain('Private merge review');expect(JSON.stringify(thread)).not.toContain(f.target.id);
});
it('has immutable replay and rejects changed request or stale source/target revisions',async()=>{
 const f=await setup(),request=input(f.target.id);
 for(const bad of [{...request,expectedSourceRevision:2},{...request,expectedTargetRevision:2}])await expect(mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,bad)).rejects.toMatchObject({code:'FEEDBACK_REVIEW_STALE'});
 const [a,b]=await Promise.all([mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,request),mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,request)]);expect(a).toEqual(b);
 await expect(mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,{...request,reason:'changed'})).rejects.toMatchObject({code:'FEEDBACK_MODERATION_CONFLICT'});
 expect(await conn.db.select().from(feedbackIssueActions).where(eq(feedbackIssueActions.admin,f.admin))).toHaveLength(1);
});
it('prevents self and opposite concurrent merges from creating cycles',async()=>{
 const f=await setup();await expect(mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,input(f.source.id))).rejects.toMatchObject({code:'FEEDBACK_MERGE_SELF'});
 const results=await Promise.allSettled([mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,input(f.target.id)),mergeFeedbackIssues(conn.db,f.config,f.admin,f.target.id,input(f.source.id))]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'FEEDBACK_ISSUE_MERGED'}});
 const a=await getFeedbackIssue(conn.db,f.source.id),b=await getFeedbackIssue(conn.db,f.target.id);expect(a).toEqual(b);
});
it('never redirects a public issue into a draft and never makes an unpublished source public',async()=>{
 const f=await setup(),draft=await issue(f.admin,false);
 await expect(mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,input(draft.id))).rejects.toMatchObject({code:'FEEDBACK_MERGE_PUBLISH_TARGET'});
 const [unchanged]=await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.id,f.source.id));expect(unchanged).toEqual(f.source);
 await mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,input(f.target.id));
 const visible=await getFeedbackIssue(conn.db,f.source.id);expect(visible.id).toBe(f.target.id);expect(visible.title).toBe(f.target.title);expect(Object.keys(visible)).toHaveLength(8);
 await mergeFeedbackIssues(conn.db,f.config,f.admin,draft.id,{...input(f.target.id),expectedTargetRevision:2});
 await expect(getFeedbackIssue(conn.db,draft.id)).rejects.toMatchObject({statusCode:404});
});
it('rejects oversized merges before any association, history or revision changes',async()=>{
 const f=await setup();const rows=await conn.db.insert(testerFeedback).values(Array.from({length:LIMIT.maxMergeReports+1},()=>({wallet:f.owner,category:'bug',title:'Private report',body:'Private details'}))).returning({id:testerFeedback.id});
 await conn.db.insert(feedbackIssueLinks).values(rows.map(r=>({reportId:r.id,issueId:f.source.id,linkedBy:f.admin})));
 await expect(mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,input(f.target.id))).rejects.toMatchObject({code:'FEEDBACK_MERGE_TOO_LARGE'});
 expect(await conn.db.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.issueId,f.source.id))).toHaveLength(rows.length);
 const [source]=await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.id,f.source.id));expect(source).toEqual(f.source);
 expect(await conn.db.select().from(feedbackIssueActions).where(eq(feedbackIssueActions.admin,f.admin))).toHaveLength(0);
});
it('keeps ancestor first-award claims after awarded reports are relinked away',async()=>{
 const f=await setup(),first=await report(f.owner,f.source.id);
 await reviewFeedbackReward(conn.db,f.config,f.admin,first.id,{requestId:randomUUID(),expectedRevision:1,status:'accepted',verdict:'actionable',award:'first_actionable',importance:'medium',reason:'Verified',verificationEvidence:'Private verifier result'});
 await mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,input(f.target.id));
 const elsewhere=await issue(f.admin);
 await linkFeedbackReport(conn.db,f.config,f.admin,first.id,{requestId:randomUUID(),issueId:elsewhere.id,expectedIssueRevision:1,expectedReportRevision:3,reason:'Reclassified without erasing prior award'});
 const candidate=await report(f.other,f.target.id);
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,candidate.id,{requestId:randomUUID(),expectedRevision:1,status:'accepted',verdict:'actionable',award:'first_actionable',importance:'medium',reason:'Verified',verificationEvidence:'Later verifier'})).rejects.toMatchObject({code:'FEEDBACK_ISSUE_AWARD_CONFLICT'});
});
it('preserves a single legacy first-award claim across merge and subsequent relinking',async()=>{
 const f=await setup(),legacy=await report(f.owner,f.source.id,10);
 await conn.db.update(testerFeedback).set({rewardPolicyVersion:1}).where(eq(testerFeedback.id,legacy.id));
 const merged=await mergeFeedbackIssues(conn.db,f.config,f.admin,f.source.id,input(f.target.id));
 expect(merged.awardConflicts).toEqual([]);expect(merged.awardClaims).toContainEqual({reportId:legacy.id,issueId:f.source.id,points:10});
 const elsewhere=await issue(f.admin);
 await linkFeedbackReport(conn.db,f.config,f.admin,legacy.id,{requestId:randomUUID(),issueId:elsewhere.id,expectedIssueRevision:1,expectedReportRevision:2,reason:'Legacy reclassification'});
 const candidate=await report(f.other,f.target.id);
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,candidate.id,{requestId:randomUUID(),expectedRevision:1,status:'accepted',verdict:'actionable',award:'first_actionable',importance:'medium',reason:'Verified',verificationEvidence:'Later proof'})).rejects.toMatchObject({code:'FEEDBACK_ISSUE_AWARD_CONFLICT'});
});
it('preserves historical claim when a report is directly relinked without a merge',async()=>{
 const f=await setup(),legacy=await report(f.owner,f.source.id,10);
 await conn.db.update(testerFeedback).set({rewardPolicyVersion:1}).where(eq(testerFeedback.id,legacy.id));
 const moved=await linkFeedbackReport(conn.db,f.config,f.admin,legacy.id,{requestId:randomUUID(),issueId:f.target.id,expectedIssueRevision:1,expectedReportRevision:1,reason:'Legacy reclassification'});
 expect(moved.awardClaims).toContainEqual({reportId:legacy.id,issueId:f.source.id,points:10});
 const candidate=await report(f.other,f.source.id);
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,candidate.id,{requestId:randomUUID(),expectedRevision:1,status:'accepted',verdict:'actionable',award:'first_actionable',importance:'medium',reason:'Verified',verificationEvidence:'Later proof'})).rejects.toMatchObject({code:'FEEDBACK_ISSUE_AWARD_CONFLICT'});
});
