import { randomUUID } from 'node:crypto';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackIssueLinks, feedbackIssues, feedbackRewardDecisions, players, testerFeedback } from '../src/db/schema';
import { reviewFeedbackReward, type FeedbackRewardReview } from '../src/game/feedbackRewards';
import { getFeedbackThread } from '../src/game/feedbackThreads';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL);
afterAll(async()=>{await conn.sql.end();});
async function fixture(){const owner=randomUUID(),admin=randomUUID(),otherAdmin=randomUUID();await conn.db.insert(players).values([owner,admin,otherAdmin].map(wallet=>({wallet})));return{owner,admin,otherAdmin,config:{ADMIN_WALLETS:[admin,otherAdmin]}};}
async function issue(){const [row]=await conn.db.insert(feedbackIssues).values({title:'canonical',body:'curated',approvedBy:'admin'}).returning();return row!.id;}
async function report(wallet:string,issueId?:string,extra:Partial<typeof testerFeedback.$inferInsert>={}){const [row]=await conn.db.insert(testerFeedback).values({wallet,title:'test',body:'verified report',category:'bug',createdAt:new Date('2026-01-12T12:00:00Z'),...extra}).returning();if(issueId)await conn.db.insert(feedbackIssueLinks).values({reportId:row!.id,issueId,linkedBy:'admin'});return row!;}
function review(extra:Partial<FeedbackRewardReview>={}):FeedbackRewardReview{return{requestId:randomUUID(),expectedRevision:1,status:'accepted',verdict:'actionable',award:'first_actionable',importance:'medium',reason:'Verified the reproduction',verificationEvidence:'Private verifier evidence',...extra};}
it('requires admin choice/evidence and accepted alone earns nothing',async()=>{
 const f=await fixture(),r=await report(f.owner);
 await expect(reviewFeedbackReward(conn.db,f.config,f.owner,r.id,review())).rejects.toMatchObject({statusCode:404});
 const {verificationEvidence:_e,...missing}=review();
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,r.id,missing)).rejects.toMatchObject({statusCode:400});
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,r.id,review())).rejects.toMatchObject({code:'FEEDBACK_ISSUE_REQUIRED'});
 expect(await reviewFeedbackReward(conn.db,f.config,f.admin,r.id,review({award:'none',verdict:'unverified'}))).toMatchObject({points:0,delta:0});
});
it('concurrent retries pay once, remain exact after later review, and keep private evidence out of the thread',async()=>{
 const f=await fixture(),r=await report(f.owner,await issue()),input=review();
 const [a,b]=await Promise.all([reviewFeedbackReward(conn.db,f.config,f.admin,r.id,input),reviewFeedbackReward(conn.db,f.config,f.admin,r.id,input)]);
 expect(a).toEqual(b);expect(a.points).toBe(TESTER_PROGRAM.feedback.basePoints+TESTER_PROGRAM.feedback.importanceBonus.medium);
 expect(await conn.db.select().from(feedbackRewardDecisions).where(eq(feedbackRewardDecisions.reportId,r.id))).toHaveLength(1);
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,r.id,{...input,reason:'changed'})).rejects.toMatchObject({code:'FEEDBACK_REWARD_CONFLICT'});
 await reviewFeedbackReward(conn.db,f.config,f.otherAdmin,r.id,review({expectedRevision:a.revision,award:'none',status:'reviewed'}));
 expect(await reviewFeedbackReward(conn.db,f.config,f.admin,r.id,input)).toEqual(a);
 const thread=await getFeedbackThread(conn.db,f.config,{wallet:f.owner,mode:'reporter'},r.id);
 expect(JSON.stringify(thread)).not.toContain('Private verifier evidence');
 for (const key of ['rewardPolicyVersion', 'basePoints', 'bonusPoints', 'verificationVerdict']) expect(thread.report).not.toHaveProperty(key);
 const staff=await getFeedbackThread(conn.db,f.config,{wallet:f.admin,mode:'admin'},r.id);
 expect(staff.report).toMatchObject({rewardPolicyVersion:2,basePoints:a.basePoints,bonusPoints:a.bonusPoints,verificationVerdict:'actionable'});
 expect(JSON.stringify(staff)).not.toContain('Private verifier evidence');
});
it('earlier unresolved reports block first awards until explicitly resolved, and stale reviews do not pay',async()=>{
 const f=await fixture(),canonical=await issue(),early=await report(f.owner,canonical,{createdAt:new Date('2026-01-12T10:00:00Z')}),later=await report(f.owner,canonical);
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,later.id,review())).rejects.toMatchObject({code:'FEEDBACK_EARLIER_REPORT',details:{reportId:early.id}});
 await reviewFeedbackReward(conn.db,f.config,f.admin,early.id,review({award:'none',verdict:'not_actionable',status:'rejected'}));
 const awarded=await reviewFeedbackReward(conn.db,f.config,f.admin,later.id,review());expect(awarded.delta).toBeGreaterThan(0);
 await expect(reviewFeedbackReward(conn.db,f.config,f.otherAdmin,later.id,review())).rejects.toMatchObject({code:'FEEDBACK_REVIEW_STALE'});
});
it('importance upgrades are monotonic catalogue totals, and useful evidence never adds a base award',async()=>{
 const f=await fixture(),r=await report(f.owner,await issue());
 const low=await reviewFeedbackReward(conn.db,f.config,f.admin,r.id,review({award:'useful_evidence',importance:'medium'}));
 expect(low).toMatchObject({basePoints:0,bonusPoints:TESTER_PROGRAM.feedback.importanceBonus.medium});
 const high=await reviewFeedbackReward(conn.db,f.config,f.admin,r.id,review({expectedRevision:low.revision,award:'useful_evidence',importance:'critical'}));
 expect(high.points).toBe(TESTER_PROGRAM.feedback.importanceBonus.critical);
 expect(high.delta).toBe(TESTER_PROGRAM.feedback.importanceBonus.critical-TESTER_PROGRAM.feedback.importanceBonus.medium);
 const lower=await reviewFeedbackReward(conn.db,f.config,f.admin,r.id,review({expectedRevision:high.revision,award:'useful_evidence',importance:'low'}));
 expect(lower).toMatchObject({delta:0,points:high.points});
});
it('created UTC day cap includes historical paid reports and serializes competing admins',async()=>{
 const f=await fixture();
 await Promise.all([1,2].map(()=>report(f.owner,undefined,{rewardPolicyVersion:1,basePoints:10,points:10})));
 const a=await report(f.owner,await issue()),b=await report(f.owner,await issue());
 const results=await Promise.allSettled([reviewFeedbackReward(conn.db,f.config,f.admin,a.id,review()),reviewFeedbackReward(conn.db,f.config,f.otherAdmin,b.id,review())]);
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(results.find(r=>r.status==='rejected')).toMatchObject({reason:{code:'FEEDBACK_REWARD_DAY_LIMIT'}});
 const nextDay=await report(f.owner,await issue(),{createdAt:new Date('2026-01-13T00:00:00Z')});
 expect(await reviewFeedbackReward(conn.db,f.config,f.admin,nextDay.id,review())).toMatchObject({createdDay:'2026-01-13'});
});
it('historical totals are immutable and canonical award evidence survives report relinking',async()=>{
 const f=await fixture(),old=await report(f.owner,undefined,{rewardPolicyVersion:1,basePoints:10,bonusPoints:50,points:60});
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,old.id,review())).rejects.toMatchObject({code:'FEEDBACK_HISTORICAL_REWARD'});
 const [unchanged]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,old.id));expect(unchanged).toEqual(old);
 const canonical=await issue(),winner=await report(f.owner,canonical),other=await fixture();
 await reviewFeedbackReward(conn.db,f.config,f.admin,winner.id,review());
 await conn.db.update(feedbackIssueLinks).set({issueId:await issue()}).where(eq(feedbackIssueLinks.reportId,winner.id));
 const later=await report(other.owner,canonical);
 await expect(reviewFeedbackReward(conn.db,other.config,other.admin,later.id,review())).rejects.toMatchObject({code:'FEEDBACK_ISSUE_AWARD_CONFLICT'});
});
it('concurrent reviews cannot give two first awards for one canonical issue',async()=>{
 const f=await fixture(),other=await fixture(),canonical=await issue();
 const first=await report(f.owner,canonical,{createdAt:new Date('2026-01-12T10:00:00Z')}),second=await report(other.owner,canonical);
 const config={ADMIN_WALLETS:[f.admin,other.admin]};
 const results=await Promise.allSettled([
  reviewFeedbackReward(conn.db,config,f.admin,first.id,review()),
  reviewFeedbackReward(conn.db,config,other.admin,second.id,review()),
 ]);
 expect(results[0]).toMatchObject({status:'fulfilled'});
 expect(results[1]).toMatchObject({status:'rejected',reason:{code:'FEEDBACK_EARLIER_REPORT'}});
 const [unpaid]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,second.id));
 expect(unpaid).toMatchObject({points:0,revision:1,reporterRevision:1});
 expect(await conn.db.select().from(feedbackRewardDecisions).where(eq(feedbackRewardDecisions.reportId,second.id))).toHaveLength(0);
});
it('merged issues require explicit current canonical review before any award',async()=>{
 const f=await fixture(),canonical=await issue(),merged=await issue();
 await conn.db.update(feedbackIssues).set({status:'merged',mergedInto:canonical}).where(eq(feedbackIssues.id,merged));
 const r=await report(f.owner,merged);
 await expect(reviewFeedbackReward(conn.db,f.config,f.admin,r.id,review())).rejects.toMatchObject({code:'FEEDBACK_ISSUE_MERGED'});
 const [unchanged]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,r.id));
 expect(unchanged).toEqual(r);
});
