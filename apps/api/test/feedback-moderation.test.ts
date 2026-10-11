import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { players, testerFeedback, feedbackAttachments } from '../src/db/schema';
import { adminListTesterFeedback, listMyTesterFeedback } from '../src/game/tester';
import { appendFeedbackReply, getFeedbackThread, markFeedbackThreadRead } from '../src/game/feedbackThreads';
import { setFeedbackThreadLock, setFeedbackThreadClosed } from '../src/game/feedbackModeration';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL);
afterAll(async()=>{await conn.sql.end();});
async function fixture(){
 const owner={wallet:randomUUID(),mode:'reporter' as const}; const admin={wallet:randomUUID(),mode:'admin' as const};
 await conn.db.insert(players).values([owner,admin].map(x=>({wallet:x.wallet})));
 const [report]=await conn.db.insert(testerFeedback).values({wallet:owner.wallet,title:'private',body:'test report',category:'bug',adminNote:'historical visible note'}).returning();
 return {owner,admin,id:report!.id,config:{ADMIN_WALLETS:[admin.wallet]}};
}
it('report lists use mode-specific unread and never reveal hidden staff activity',async()=>{
 const f=await fixture();const before=(await listMyTesterFeedback(conn.db,f.owner.wallet))[0]!;
 expect(before).toMatchObject({rewardPolicyVersion:2,revision:1,unread:false});
 await appendFeedbackReply(conn.db,f.config,f.admin,f.id,{requestId:'staff',body:'private note',visibility:'admin'});
 expect((await listMyTesterFeedback(conn.db,f.owner.wallet))[0]).toEqual(before);
 await appendFeedbackReply(conn.db,f.config,f.admin,f.id,{requestId:'visible',body:'visible answer'});
 const mine=(await listMyTesterFeedback(conn.db,f.owner.wallet))[0]!;
 expect(mine).toMatchObject({revision:2,unread:true,adminNote:'historical visible note'});
 expect(mine).not.toHaveProperty('reporterRevision');
 await markFeedbackThreadRead(conn.db,f.config,f.owner,f.id,2);
 expect((await listMyTesterFeedback(conn.db,f.owner.wallet))[0]!.unread).toBe(false);
 await appendFeedbackReply(conn.db,f.config,f.owner,f.id,{requestId:'owner',body:'player followup'});
 const listed=(await adminListTesterFeedback(conn.db,{},200,f.admin.wallet)).find(r=>r.id===f.id)!;
 expect(listed).toMatchObject({revision:4,reporterRevision:3,unread:true,rewardPolicyVersion:2});
 await markFeedbackThreadRead(conn.db,f.config,f.admin,f.id,4);
 expect((await adminListTesterFeedback(conn.db,{},200,f.admin.wallet)).find(r=>r.id===f.id)!.unread).toBe(false);
});
it('wrong-role wallets cannot lock threads; locking/unlocking creates visible serialized history',async()=>{
 const f=await fixture();const input={requestId:'lock',locked:true,reason:'Please wait for investigation'};
 await expect(setFeedbackThreadLock(conn.db,f.config,f.owner.wallet,f.id,input)).rejects.toMatchObject({statusCode:404});
 const [a,b]=await Promise.all([1,2].map(()=>setFeedbackThreadLock(conn.db,f.config,f.admin.wallet,f.id,input)));
 expect(a).toEqual(b);expect(a).toMatchObject({revision:2,reporterRevision:2,locked:true});
 await expect(appendFeedbackReply(conn.db,f.config,f.owner,f.id,{requestId:'denied',body:'hello'})).rejects.toMatchObject({code:'FEEDBACK_THREAD_LOCKED'});
 await expect(setFeedbackThreadLock(conn.db,f.config,f.admin.wallet,f.id,{...input,locked:false})).rejects.toMatchObject({code:'FEEDBACK_MODERATION_CONFLICT'});
 await setFeedbackThreadLock(conn.db,f.config,f.admin.wallet,f.id,{requestId:'unlock',locked:false,reason:'Ready for more details'});
 expect(await setFeedbackThreadLock(conn.db,f.config,f.admin.wallet,f.id,input)).toEqual(a);
 const thread=await getFeedbackThread(conn.db,f.config,f.owner,f.id);
 expect(thread.report.locked).toBe(false);
 expect(thread.messages.map(m=>[m.kind,m.visibility,m.revision])).toEqual([['status','reporter',2],['status','reporter',3]]);
 expect(thread.messages[0]!.body).toContain(input.reason);
 expect(await appendFeedbackReply(conn.db,f.config,f.owner,f.id,{requestId:'resumed',body:'Now it works'})).toHaveProperty('revision',4);
});
it('unlock never resets closed state or retention and keys cannot cross reply/moderation operations',async()=>{
 const f=await fixture();const closedAt=new Date('2026-01-01');
 await conn.db.update(testerFeedback).set({closedAt,lockedAt:new Date()}).where(eq(testerFeedback.id,f.id));
 await appendFeedbackReply(conn.db,f.config,f.admin,f.id,{requestId:'used',body:'staff response'});
 await expect(setFeedbackThreadLock(conn.db,f.config,f.admin.wallet,f.id,{requestId:'used',locked:false,reason:'reused'})).rejects.toMatchObject({code:'FEEDBACK_MODERATION_CONFLICT'});
 await setFeedbackThreadLock(conn.db,f.config,f.admin.wallet,f.id,{requestId:'unlock-closed',locked:false,reason:'unlock only'});
 await expect(appendFeedbackReply(conn.db,f.config,f.admin,f.id,{requestId:'unlock-closed',body:'Replies unlocked: unlock only'})).rejects.toMatchObject({code:'FEEDBACK_REPLY_CONFLICT'});
 const [row]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,f.id));
 expect(row!.closedAt).toEqual(closedAt);expect(row!.lockedAt).toBeNull();
 await expect(appendFeedbackReply(conn.db,f.config,f.owner,f.id,{requestId:'stillclosed',body:'hello'})).rejects.toMatchObject({code:'FEEDBACK_THREAD_LOCKED'});
});

it('closure is replay-safe, revision-checked and does not reset rewards, locks or its original retention deadline',async()=>{
 const f=await fixture(), lockedAt=new Date();await conn.db.update(testerFeedback).set({lockedAt,points:10,basePoints:10,status:'accepted'}).where(eq(testerFeedback.id,f.id));
 const input={requestId:'close',closed:true,expectedRevision:1,reason:'Investigation resolved'};
 await expect(setFeedbackThreadClosed(conn.db,f.config,f.owner.wallet,f.id,input)).rejects.toMatchObject({statusCode:404});
 const [a,b]=await Promise.all([1,2].map(()=>setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,input)));expect(a).toEqual(b);
 await expect(setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,{...input,reason:'changed'})).rejects.toMatchObject({code:'FEEDBACK_MODERATION_CONFLICT'});
 await expect(setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,{...input,requestId:'stale'})).rejects.toMatchObject({code:'FEEDBACK_REVIEW_STALE'});
 const again=await setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,{...input,requestId:'again',expectedRevision:2});expect(again.closedAt).toBe(a!.closedAt);
 await setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,{...input,requestId:'reopen',expectedRevision:3,closed:false});
 expect(await setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,input)).toEqual(a);
 const [row]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,f.id));expect(row).toMatchObject({closedAt:null,lockedAt,points:10,status:'accepted',revision:4,reporterRevision:4});
 const thread=await getFeedbackThread(conn.db,f.config,f.owner,f.id);expect(thread.messages.map(m=>m.body)).toEqual(['Report closed: Investigation resolved','Report closed: Investigation resolved','Report reopened: Investigation resolved']);
 await expect(appendFeedbackReply(conn.db,f.config,f.admin,f.id,{requestId:'close',body:'Report closed: Investigation resolved'})).rejects.toMatchObject({code:'FEEDBACK_REPLY_CONFLICT'});
});
it('closing competes safely with a reporter reply and reopening never resurrects deleted screenshots',async()=>{
 const f=await fixture();const results=await Promise.allSettled([
  setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,{requestId:'close',closed:true,expectedRevision:1,reason:'Completed'}),
  appendFeedbackReply(conn.db,f.config,f.owner,f.id,{requestId:'reply',body:'More evidence'}),
 ]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const [current]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,f.id));
 if(!current!.closedAt)await setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,{requestId:'close-next',closed:true,expectedRevision:2,reason:'Completed'});
 const [closed]=await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id,f.id));
 await expect(appendFeedbackReply(conn.db,f.config,f.owner,f.id,{requestId:'denied',body:'Not yet'})).rejects.toMatchObject({code:'FEEDBACK_THREAD_LOCKED'});
 const [attachment]=await conn.db.insert(feedbackAttachments).values({reportId:f.id,wallet:f.owner.wallet,requestId:randomUUID(),state:'deleting',expiresAt:new Date(0)}).returning();
 await setFeedbackThreadClosed(conn.db,f.config,f.admin.wallet,f.id,{requestId:'reopen',closed:false,expectedRevision:closed!.revision,reason:'Need more evidence'});
 expect((await conn.db.select().from(feedbackAttachments).where(eq(feedbackAttachments.id,attachment!.id)))[0]!.state).toBe('deleting');
 await appendFeedbackReply(conn.db,f.config,f.owner,f.id,{requestId:'resumed',body:'New evidence after reopening'});
});
