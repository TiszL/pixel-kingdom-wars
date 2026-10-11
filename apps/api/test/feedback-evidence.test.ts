import { randomUUID } from 'node:crypto';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackEvidenceRequests, feedbackIssueLinks, feedbackIssues, feedbackMessages, players, testerFeedback } from '../src/db/schema';
import { addPrivateFeedbackEvidence } from '../src/game/feedbackEvidence';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL);
afterAll(async()=>{await conn.sql.end();});
async function fixture(status='open',published=true) {
 const wallet=randomUUID();await conn.db.insert(players).values({wallet});
 const [issue]=await conn.db.insert(feedbackIssues).values({title:'Public issue',body:'Only curated text',category:'bug',approvedBy:'admin',status,publishedAt:published?new Date():null}).returning();
 return{wallet,issue:issue!,config:{ADMIN_WALLETS:['admin']}};
}
const evidence=(extra:Record<string,unknown>={})=>({requestId:randomUUID(),mode:'evidence' as const,title:'My private observation',body:'Detailed private observation',...extra});
it('creates once then appends actual evidence once, serializing different keys into the owned thread',async()=>{
 const f=await fixture(),input=evidence();
 const [a,b]=await Promise.all([addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,input),addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,input)]);
 expect(a).toEqual(b);expect(a).toMatchObject({reused:false,messageId:null,basePoints:0});
 const next=evidence({body:'New proof from a later visit'});
 const [c,d]=await Promise.all([addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,next),addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,next)]);
 expect(c).toEqual(d);expect(c).toMatchObject({reused:true,reportId:a.reportId});
 expect(await conn.db.select().from(testerFeedback).where(eq(testerFeedback.wallet,f.wallet))).toHaveLength(1);
 const messages=await conn.db.select().from(feedbackMessages).where(eq(feedbackMessages.reportId,a.reportId));expect(messages).toHaveLength(1);expect(messages[0]!.body).toBe(next.body);
 const distinct=await Promise.all([addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence()),addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence())]);
 expect(distinct.every(r=>r.reportId===a.reportId&&r.reused)).toBe(true);
 await expect(addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,{...input,body:'Changed private evidence'})).rejects.toMatchObject({code:'FEEDBACK_REQUEST_CONFLICT'});
 const [storedIssue]=await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.id,f.issue.id));expect(storedIssue).toEqual(f.issue);
});
it('counts only new reports against8/day and never reuses another wallet report',async()=>{
 const f=await fixture(),first=await addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence());
 await conn.db.insert(testerFeedback).values(Array.from({length:TESTER_PROGRAM.feedback.dailyMaxSubmissions-1},()=>({wallet:f.wallet,category:'bug',title:'Separate report',body:'Different issue details'})));
 expect(await addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence())).toMatchObject({reused:true,reportId:first.reportId});
 const other=await fixture();
 await expect(addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,other.issue.id,evidence())).rejects.toMatchObject({statusCode:429});
 const independent=await addPrivateFeedbackEvidence(conn.db,f.config,other.wallet,f.issue.id,evidence());expect(independent.reportId).not.toBe(first.reportId);
 const reports=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.wallet,f.wallet));expect(reports).toHaveLength(TESTER_PROGRAM.feedback.dailyMaxSubmissions);expect(reports.every(r=>r.points===0)).toBe(true);
});
it('requires explicit recurrence after resolution, reuses an open episode, and allows a later closed recurrence',async()=>{
 const f=await fixture('fixed');
 await expect(addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence())).rejects.toMatchObject({code:'FEEDBACK_RECURRENCE_REQUIRED'});
 const first=await addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,{...evidence(),mode:'recurrence'});
 expect(first).toMatchObject({recurrence:true,reused:false});
 const repeated=await addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,{...evidence(),mode:'recurrence'});expect(repeated).toMatchObject({reused:true,reportId:first.reportId});
 await conn.db.update(testerFeedback).set({lockedAt:new Date()}).where(eq(testerFeedback.id,first.reportId));
 await expect(addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,{...evidence(),mode:'recurrence'})).rejects.toMatchObject({code:'FEEDBACK_THREAD_LOCKED'});
 await conn.db.update(testerFeedback).set({closedAt:new Date()}).where(eq(testerFeedback.id,first.reportId));
 const later=await addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,{...evidence(),mode:'recurrence'});expect(later.reportId).not.toBe(first.reportId);
 const [old]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,first.reportId));expect(old!.closedAt).not.toBeNull();expect(old!.lockedAt).not.toBeNull();
});
it('refuses unpublished/merged issues, active recurrence and locked/closed active threads without side effects',async()=>{
 const f=await fixture('open',false);
 await expect(addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence())).rejects.toMatchObject({statusCode:404});
 await conn.db.update(feedbackIssues).set({publishedAt:new Date()}).where(eq(feedbackIssues.id,f.issue.id));
 await expect(addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,{...evidence(),mode:'recurrence'})).rejects.toMatchObject({code:'FEEDBACK_ISSUE_CHANGED'});
 const active=await addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence());
 await conn.db.update(testerFeedback).set({closedAt:new Date()}).where(eq(testerFeedback.id,active.reportId));
 await expect(addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence())).rejects.toMatchObject({code:'FEEDBACK_THREAD_LOCKED'});
 const target=await fixture();await conn.db.update(feedbackIssues).set({status:'merged',mergedInto:target.issue.id}).where(eq(feedbackIssues.id,f.issue.id));
 await expect(addPrivateFeedbackEvidence(conn.db,f.config,f.wallet,f.issue.id,evidence())).rejects.toMatchObject({statusCode:409,code:'FEEDBACK_ISSUE_MERGED'});
 expect(await conn.db.select().from(feedbackEvidenceRequests).where(eq(feedbackEvidenceRequests.wallet,f.wallet))).toHaveLength(1);
 expect(await conn.db.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.reportId,active.reportId))).toHaveLength(1);
});
