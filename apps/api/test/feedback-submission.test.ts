import { randomUUID } from 'node:crypto';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { players, testerFeedback } from '../src/db/schema';
import { adminRateTesterFeedback, submitTesterFeedback } from '../src/game/tester';
import { TEST_DATABASE_URL } from './db-url';
const conn = createDb(TEST_DATABASE_URL);
afterAll(async () => { await conn.sql.end(); });
async function wallet() { const id=randomUUID(); await conn.db.insert(players).values({wallet:id}); return id; }
const input = () => ({requestId:randomUUID(),category:'bug' as const,title:'Issue',body:'The game shows the wrong building after tapping.'});
it('old clients receive an actionable update response without creating a report or points', async () => {
 const who=await wallet(); const {requestId:_id,...old}=input();
 await expect(submitTesterFeedback(conn.db,who,old)).rejects.toMatchObject({statusCode:409,code:'FEEDBACK_CLIENT_UPDATE_REQUIRED'});
 expect(await conn.db.select().from(testerFeedback).where(eq(testerFeedback.wallet,who))).toEqual([]);
});
it('concurrent exact retries preserve one original receipt and zero policy2 points', async () => {
 const who=await wallet(); const request=input();
 const responses=await Promise.all(Array.from({length:5},()=>submitTesterFeedback(conn.db,who,request)));
 expect(responses.every(r=>JSON.stringify(r)===JSON.stringify(responses[0]))).toBe(true);
 const rows=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.wallet,who));
 expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({rewardPolicyVersion:2,basePoints:0,bonusPoints:0,points:0,submissionReceipt:responses[0]});
 await expect(submitTesterFeedback(conn.db,who,{...request,title:'changed'})).rejects.toMatchObject({code:'FEEDBACK_REQUEST_CONFLICT'});
});
it('daily cap remains atomic and lost-response retries return stable quota receipts after cap', async () => {
 const who=await wallet(); const request=input(); const first=await submitTesterFeedback(conn.db,who,request);
 const results=await Promise.allSettled(Array.from({length:TESTER_PROGRAM.feedback.dailyMaxSubmissions+2},()=>submitTesterFeedback(conn.db,who,input())));
 expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(TESTER_PROGRAM.feedback.dailyMaxSubmissions-1);
 expect(results.filter(r=>r.status==='rejected').every(r=>r.status==='rejected'&&r.reason.statusCode===429)).toBe(true);
 expect(await submitTesterFeedback(conn.db,who,request)).toEqual(first);
 expect(first.dailyRemaining).toBe(TESTER_PROGRAM.feedback.dailyMaxSubmissions-1);
});
it('hashes only normalized allowlisted diagnostics and strips tokens, chat and logs', async () => {
 const who=await wallet(); const request={...input(),context:{screen:'base',build:'abcdef01',platform:'android',baseId:randomUUID(),viewportWidth:390,viewportHeight:844,devicePixelRatio:3,token:'never-store',chat:'private',logs:{key:'secret'}}};
 const first=await submitTesterFeedback(conn.db,who,request);
 const [row]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,first.id));
 expect(row!.context).toEqual({screen:'base',build:'abcdef01',platform:'android',baseId:request.context.baseId,viewportWidth:390,viewportHeight:844,devicePixelRatio:3});
 expect(await submitTesterFeedback(conn.db,who,{...request,title:' Issue ',context:{...request.context,token:'different ignored secret'}})).toEqual(first);
 await expect(submitTesterFeedback(conn.db,who,{...request,context:{...request.context,viewportWidth:412}})).rejects.toMatchObject({code:'FEEDBACK_REQUEST_CONFLICT'});
 await expect(submitTesterFeedback(conn.db,who,{...input(),context:{baseId:'not-a-uuid'}})).rejects.toMatchObject({statusCode:400});
});
it('legacy rating refuses policy2 without changing any report field', async () => {
 const who=await wallet(); const receipt=await submitTesterFeedback(conn.db,who,input());
 const [before]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,receipt.id));
 await expect(adminRateTesterFeedback(conn.db,receipt.id,'admin',{importance:'critical',status:'accepted',note:'reward'})).rejects.toMatchObject({code:'FEEDBACK_REVIEW_UPDATE_REQUIRED'});
 const [after]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,receipt.id));
 expect(after).toEqual(before);
});
