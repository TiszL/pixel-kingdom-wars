import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackIssues, feedbackIssueLinks, players, testerFeedback } from '../src/db/schema';
import { curateFeedbackIssue, type FeedbackIssueCurationInput, linkFeedbackReport } from '../src/game/feedbackIssueModeration';
import { getFeedbackIssue } from '../src/game/feedbackIssues';
import { getFeedbackThread } from '../src/game/feedbackThreads';
import { TEST_DATABASE_URL } from './db-url';
const conn = createDb(TEST_DATABASE_URL);
afterAll(async () => { await conn.sql.end(); });
async function setup() {
 const owner=randomUUID(),admin=randomUUID();
 await conn.db.insert(players).values([{wallet:owner},{wallet:admin}]);
 const [report]=await conn.db.insert(testerFeedback).values({wallet:owner,title:'private report title',body:'private report body',category:'bug'}).returning();
 const [issue]=await conn.db.insert(feedbackIssues).values({title:'unpublished staff title',body:'curated',approvedBy:admin}).returning();
 return {owner,admin,report:report!,issue:issue!,config:{ADMIN_WALLETS:[admin]}};
}
it('links privately and exactly once without copying report text or changing rewards',async()=>{
 const f=await setup();
 const input={requestId:randomUUID(),issueId:f.issue.id,expectedIssueRevision:1,expectedReportRevision:1,reason:'private diagnosis'};
 await expect(linkFeedbackReport(conn.db,f.config,f.owner,f.report.id,input)).rejects.toMatchObject({statusCode:404});
 const [a,b]=await Promise.all([linkFeedbackReport(conn.db,f.config,f.admin,f.report.id,input),linkFeedbackReport(conn.db,f.config,f.admin,f.report.id,input)]);
 expect(a).toEqual(b);
 const thread=await getFeedbackThread(conn.db,f.config,{wallet:f.owner,mode:'reporter'},f.report.id);
 expect(thread.messages).toHaveLength(1);
 expect(JSON.stringify(thread)).not.toContain('private diagnosis');
 expect(JSON.stringify(thread)).not.toContain(f.issue.id);
 expect(JSON.stringify(thread)).not.toContain(f.issue.title);
 const [issue]=await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.id,f.issue.id));expect(issue).toEqual(f.issue);
 const [report]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,f.report.id));
 expect(report).toMatchObject({revision:2,reporterRevision:2,points:0,status:'new'});
 await expect(linkFeedbackReport(conn.db,f.config,f.admin,f.report.id,{...input,reason:'changed'})).rejects.toMatchObject({code:'FEEDBACK_MODERATION_CONFLICT'});
});
it('stale and merged destinations reject atomically; replay cannot revert a later relink',async()=>{
 const f=await setup(),input={requestId:randomUUID(),issueId:f.issue.id,expectedIssueRevision:1,expectedReportRevision:1,reason:'verified linkage'};
 await expect(linkFeedbackReport(conn.db,f.config,f.admin,f.report.id,{...input,expectedIssueRevision:2})).rejects.toMatchObject({code:'FEEDBACK_REVIEW_STALE'});
 const first=await linkFeedbackReport(conn.db,f.config,f.admin,f.report.id,input);
 const [other]=await conn.db.insert(feedbackIssues).values({title:'second curated issue',body:'curated',approvedBy:f.admin}).returning();
 await linkFeedbackReport(conn.db,f.config,f.admin,f.report.id,{...input,requestId:randomUUID(),issueId:other!.id,expectedReportRevision:first.revision});
 expect(await linkFeedbackReport(conn.db,f.config,f.admin,f.report.id,input)).toEqual(first);
 const [link]=await conn.db.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.reportId,f.report.id));expect(link!.issueId).toBe(other!.id);
 await conn.db.update(feedbackIssues).set({status:'merged',mergedInto:other!.id}).where(eq(feedbackIssues.id,f.issue.id));
 await expect(linkFeedbackReport(conn.db,f.config,f.admin,f.report.id,{...input,requestId:randomUUID(),expectedReportRevision:3})).rejects.toMatchObject({code:'FEEDBACK_ISSUE_MERGED'});
});

function curation(extra: Partial<FeedbackIssueCurationInput> = {}): FeedbackIssueCurationInput {
 return { requestId: randomUUID(), title: 'Sanitized public issue', summary: 'Staff-reviewed summary', category: 'bug',
   workaround: null, fixedRelease: null, status: 'open', published: false, reason: 'Reviewed public wording', ...extra };
}
it('creates an immutable replayable draft and publishes only explicitly reviewed fields',async()=>{
 const f=await setup(),input=curation();
 await expect(curateFeedbackIssue(conn.db,f.config,f.owner,input)).rejects.toMatchObject({statusCode:404});
 await expect(curateFeedbackIssue(conn.db,f.config,f.admin,{...input,reportBody:'private'} as FeedbackIssueCurationInput)).rejects.toMatchObject({statusCode:400});
 const [a,b]=await Promise.all([curateFeedbackIssue(conn.db,f.config,f.admin,input),curateFeedbackIssue(conn.db,f.config,f.admin,input)]);
 expect(a).toEqual(b);
 await expect(getFeedbackIssue(conn.db,a.issueId)).rejects.toMatchObject({statusCode:404});
 const published=await curateFeedbackIssue(conn.db,f.config,f.admin,curation({issueId:a.issueId,expectedRevision:a.revision,published:true}));
 expect(published).toMatchObject({revision:2});
 const publicIssue=await getFeedbackIssue(conn.db,a.issueId);
 expect(publicIssue).toMatchObject({title:input.title,summary:input.summary,affectedPlayerCount:0});
 expect(JSON.stringify(publicIssue)).not.toContain(f.admin);
 expect(JSON.stringify(publicIssue)).not.toContain(input.reason);
 expect(JSON.stringify(publicIssue)).not.toContain(f.report.body);
 expect(await curateFeedbackIssue(conn.db,f.config,f.admin,input)).toEqual(a);
 expect(await getFeedbackIssue(conn.db,a.issueId)).toEqual(publicIssue);
 await expect(curateFeedbackIssue(conn.db,f.config,f.admin,{...input,title:'Different'})).rejects.toMatchObject({code:'FEEDBACK_MODERATION_CONFLICT'});
});
it('serializes concurrent edits and leaves the rejected edit unapplied',async()=>{
 const f=await setup(),draft=await curateFeedbackIssue(conn.db,f.config,f.admin,curation());
 const results=await Promise.allSettled(['First edit','Second edit'].map(title=>curateFeedbackIssue(conn.db,f.config,f.admin,curation({issueId:draft.issueId,expectedRevision:1,title}))));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'FEEDBACK_REVIEW_STALE'}});
 const [stored]=await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.id,draft.issueId));
 expect(stored!.revision).toBe(2);
});
it('fixed/closed issues require explicit reopen and merged issues cannot be edited',async()=>{
 const f=await setup(),fixed=await curateFeedbackIssue(conn.db,f.config,f.admin,curation({status:'fixed',fixedRelease:'0804cca3'}));
 await expect(curateFeedbackIssue(conn.db,f.config,f.admin,curation({issueId:fixed.issueId,expectedRevision:1}))).rejects.toMatchObject({code:'FEEDBACK_ISSUE_REOPEN_REQUIRED'});
 await conn.db.update(feedbackIssues).set({status:'merged',mergedInto:f.issue.id}).where(eq(feedbackIssues.id,fixed.issueId));
 await expect(curateFeedbackIssue(conn.db,f.config,f.admin,curation({issueId:fixed.issueId,expectedRevision:1}))).rejects.toMatchObject({code:'FEEDBACK_ISSUE_MERGED'});
});
