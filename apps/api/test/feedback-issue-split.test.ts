import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackIssueLinks, feedbackIssues, players, testerFeedback } from '../src/db/schema';
import { reopenFeedbackIssue, splitFeedbackIssue } from '../src/game/feedbackIssueSplit';
import { getFeedbackThread } from '../src/game/feedbackThreads';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL);afterAll(async()=>{await conn.sql.end();});
async function fixture(){const admin=randomUUID(),wallet=randomUUID();await conn.db.insert(players).values([{wallet:admin},{wallet}]);const [issue]=await conn.db.insert(feedbackIssues).values({title:'Original curated issue',body:'Original public summary',approvedBy:admin}).returning();const reports=await conn.db.insert(testerFeedback).values([1,2].map(()=>({wallet,category:'bug',title:'Secret reporter title',body:'Secret reporter body',rewardPolicyVersion:1,basePoints:10,points:10,status:'accepted' as const,closedAt:new Date()}))).returning();await conn.db.insert(feedbackIssueLinks).values(reports.map(r=>({reportId:r.id,issueId:issue!.id,linkedBy:admin})));return{admin,wallet,config:{ADMIN_WALLETS:[admin]},issue:issue!,reports};}
const target={title:'Separate curated issue',summary:'Separately reviewed public wording',category:'bug' as const,status:'open' as const,published:true,workaround:null,fixedRelease:null};
it('splits exactly selected reports with immutable retries, new public wording and unchanged historical rewards',async()=>{
 const f=await fixture(),r=f.reports[0]!,input={requestId:randomUUID(),expectedSourceRevision:1,reason:'Private split diagnosis',reports:[{id:r.id,expectedRevision:1}],target};
 const [a,b]=await Promise.all([splitFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,input),splitFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,input)]);expect(a).toEqual(b);expect(a.awardClaims).toContainEqual({reportId:r.id,issueId:f.issue.id,points:10});
 const [newIssue]=await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.id,a.targetIssueId));expect(newIssue).toMatchObject({title:target.title,body:target.summary});expect(JSON.stringify(newIssue)).not.toContain(r.body);
 const [moved]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,r.id));expect(moved).toMatchObject({points:10,basePoints:10,status:'accepted',revision:2,closedAt:r.closedAt});
 const [other]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,f.reports[1]!.id));expect(other).toEqual(f.reports[1]);
 const thread=await getFeedbackThread(conn.db,f.config,{wallet:f.wallet,mode:'reporter'},r.id);expect(thread.messages).toHaveLength(1);expect(JSON.stringify(thread)).not.toContain(input.reason);expect(JSON.stringify(thread)).not.toContain(a.targetIssueId);
 await expect(splitFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,{...input,reason:'changed'})).rejects.toMatchObject({code:'FEEDBACK_MODERATION_CONFLICT'});
});
it('rejects wrong roles, duplicate selection and stale/foreign report revisions without moving anything',async()=>{
 const f=await fixture(),r=f.reports[0]!,input={requestId:randomUUID(),expectedSourceRevision:1,reason:'Reviewed',reports:[{id:r.id,expectedRevision:1}],target};
 await expect(splitFeedbackIssue(conn.db,f.config,f.wallet,f.issue.id,input)).rejects.toMatchObject({statusCode:404});
 await expect(splitFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,{...input,reports:[...input.reports,...input.reports]})).rejects.toMatchObject({statusCode:400});
 for(const stale of [{...input,expectedSourceRevision:2},{...input,reports:[{id:r.id,expectedRevision:2}]},{...input,reports:[{id:randomUUID(),expectedRevision:1}]}])await expect(splitFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,stale)).rejects.toMatchObject({code:'FEEDBACK_REVIEW_STALE'});
 expect(await conn.db.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.issueId,f.issue.id))).toHaveLength(2);
});
it('reopens only fixed/closed issues, clears current release label, preserves private closure and replays exactly',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),expectedRevision:1,reason:'Issue has recurred'};
 await expect(reopenFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,input)).rejects.toMatchObject({code:'FEEDBACK_ISSUE_REOPEN_INVALID'});
 await conn.db.update(feedbackIssues).set({status:'fixed',fixedRelease:'release-previous'}).where(eq(feedbackIssues.id,f.issue.id));
 await expect(reopenFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,{...input,expectedRevision:2})).rejects.toMatchObject({code:'FEEDBACK_REVIEW_STALE'});
 const [a,b]=await Promise.all([reopenFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,input),reopenFeedbackIssue(conn.db,f.config,f.admin,f.issue.id,input)]);expect(a).toEqual(b);expect(a).toMatchObject({revision:2,status:'open',previousStatus:'fixed',previousFixedRelease:'release-previous',fixedRelease:null});
 const unchanged=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.wallet,f.wallet));
 // Reopening must preserve each private report exactly; PostgreSQL row order
 // is unrelated to that invariant and is not guaranteed without ORDER BY.
 expect(new Map(unchanged.map(r=>[r.id,r]))).toEqual(new Map(f.reports.map(r=>[r.id,r])));
});
