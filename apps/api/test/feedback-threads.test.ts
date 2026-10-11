import { randomUUID } from 'node:crypto';
import { FEEDBACK_THREADS as LIMIT } from '@shardkeep/shared/feedback';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackMessages, players, testerFeedback } from '../src/db/schema';
import { appendFeedbackReply, getFeedbackThread, markFeedbackThreadRead } from '../src/game/feedbackThreads';
import { TEST_DATABASE_URL } from './db-url';
const conn = createDb(TEST_DATABASE_URL);
const owner = { wallet: randomUUID(), mode: 'reporter' as const };
const admin = { wallet: randomUUID(), mode: 'admin' as const };
const other = { wallet: randomUUID(), mode: 'reporter' as const };
const config = { ADMIN_WALLETS: [admin.wallet] };
let id: string; let second: string;
beforeAll(async () => {
 await conn.db.insert(players).values([owner, admin, other].map(a => ({wallet:a.wallet})));
 const rows = await conn.db.insert(testerFeedback).values([1,2].map(n => ({wallet:owner.wallet,category:'bug',title:`test${n}`,body:'report body',adminNote:'legacy visible note'}))).returning();
 id=rows[0]!.id; second=rows[1]!.id;
});
beforeEach(async () => {
 await conn.db.update(feedbackMessages).set({createdAt:new Date(Date.now()-LIMIT.replyWindowMs-1)}).where(inArray(feedbackMessages.author,[owner.wallet,admin.wallet]));
});
afterAll(async () => { await conn.sql.end(); });
async function freshReport() {
 const [report] = await conn.db.insert(testerFeedback).values({wallet:owner.wallet,category:'bug',title:'isolated thread',body:'report body'}).returning();
 return report!.id;
}
it('denies other wallets and forged admins before exposing thread data', async () => {
 await expect(getFeedbackThread(conn.db,config,other,id)).rejects.toMatchObject({statusCode:404});
 await expect(getFeedbackThread(conn.db,config,{...other,mode:'admin'},id)).rejects.toMatchObject({statusCode:404});
 await expect(getFeedbackThread(conn.db,config,{...admin,mode:'reporter'},id)).rejects.toMatchObject({statusCode:404});
});
it('keeps notes, author wallets, context and note activity out of reporter views', async () => {
 const before=await getFeedbackThread(conn.db,config,owner,id);
 await appendFeedbackReply(conn.db,config,admin,id,{requestId:'staff-one',body:'secret note',visibility:'admin'});
 const after=await getFeedbackThread(conn.db,config,owner,id);
 expect(after).toEqual(before);
 expect(after.report.adminNote).toBe('legacy visible note');
 expect(after.report).not.toHaveProperty('wallet');
 const staff=await getFeedbackThread(conn.db,config,admin,id);
 expect(staff.messages[0]).toMatchObject({body:'secret note',visibility:'admin',kind:'note'});
 await expect(appendFeedbackReply(conn.db,config,owner,id,{requestId:'bad-role',body:'hidden',visibility:'admin'})).rejects.toMatchObject({statusCode:403});
});
it('serializes duplicate requests exactly once and rejects changed or cross-report reuse', async () => {
 const input={requestId:'same-one',body:'helpful reply'};
 const [a,b]=await Promise.all([appendFeedbackReply(conn.db,config,owner,id,input),appendFeedbackReply(conn.db,config,owner,id,input)]);
 expect(a).toEqual(b);
 await expect(appendFeedbackReply(conn.db,config,owner,id,{...input,body:'different'})).rejects.toMatchObject({statusCode:409});
 await expect(appendFeedbackReply(conn.db,config,owner,second,input)).rejects.toMatchObject({statusCode:409});
 const race=await Promise.allSettled([id,second].map(reportId=>appendFeedbackReply(conn.db,config,owner,reportId,{requestId:'cross-race',body:'one request'})));
 expect(race.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 expect(race.find(r=>r.status==='rejected')).toMatchObject({reason:{statusCode:409}});
});
it('unread cursors are monotonic and staff notes never count as reporter unread', async () => {
 const reply=await appendFeedbackReply(conn.db,config,admin,id,{requestId:'visible-one',body:'team answer'});
 expect(reply).toHaveProperty('author',admin.wallet);
 const view=await getFeedbackThread(conn.db,config,owner,id);
 expect(view.unread).toBe(true);
 expect(view.messages.find(m=>m.id===reply.id)).not.toHaveProperty('author');
 await markFeedbackThreadRead(conn.db,config,owner,id,view.latestRevision);
 await markFeedbackThreadRead(conn.db,config,owner,id,0);
 await appendFeedbackReply(conn.db,config,admin,id,{requestId:'staff-two',body:'internal followup',visibility:'admin'});
 const after=await getFeedbackThread(conn.db,config,owner,id);
 expect(after.unread).toBe(false); expect(after.latestRevision).toBe(view.latestRevision);
});
it('blocks new reporter writes when locked while preserving lost-response replay', async () => {
 await conn.db.update(testerFeedback).set({lockedAt:new Date()}).where(eq(testerFeedback.id,id));
 await expect(appendFeedbackReply(conn.db,config,owner,id,{requestId:'locked',body:'new reply'})).rejects.toMatchObject({code:'FEEDBACK_THREAD_LOCKED'});
 expect(await appendFeedbackReply(conn.db,config,owner,id,{requestId:'same-one',body:'helpful reply'})).toHaveProperty('id');
 expect(await appendFeedbackReply(conn.db,config,admin,id,{requestId:'locked-staff',body:'we are reviewing'})).toHaveProperty('id');
});
it('paginates more than a full page by visible revisions without exposing interleaved notes', async () => {
 const reportId=await freshReport();
 const visibleCount=LIMIT.pageSize+3;
 await conn.db.insert(feedbackMessages).values(Array.from({length:visibleCount*2},(_,index)=>({
  reportId,author:admin.wallet,visibility:index%2?'admin':'reporter',kind:index%2?'note':'reply',
  body:index%2?'staff only':`reply ${index/2}`,revision:index+2,reporterRevision:index%2?null:index/2+2,requestId:`page-${reportId}-${index}`,context:{authorRole:'admin'},
 })));
 await conn.db.update(testerFeedback).set({revision:visibleCount*2+1,reporterRevision:visibleCount+1}).where(eq(testerFeedback.id,reportId));
 const first=await getFeedbackThread(conn.db,config,owner,reportId,{afterRevision:0});
 expect(first.messages).toHaveLength(LIMIT.pageSize); expect(first.hasMore).toBe(true);
 const secondPage=await getFeedbackThread(conn.db,config,owner,reportId,first.nextRevision);
 expect(first.nextRevision).toBe(LIMIT.pageSize+1);
 expect(secondPage.messages.map(m=>m.revision)).toEqual([LIMIT.pageSize+2,LIMIT.pageSize+3,LIMIT.pageSize+4]);
 expect(secondPage.messages).toHaveLength(3); expect(secondPage.hasMore).toBe(false);
 const all=[...first.messages,...secondPage.messages];
 expect(new Set(all.map(m=>m.id)).size).toBe(visibleCount);
 expect(all.every(m=>m.visibility==='reporter' && m.body!=='staff only')).toBe(true);
 const newest=await getFeedbackThread(conn.db,config,owner,reportId);
 expect(newest.messages).toHaveLength(LIMIT.pageSize);
 expect(newest.messages[0]!.revision).toBe(5);
 expect(newest).toMatchObject({oldestRevision:5,nextRevision:visibleCount+1,hasEarlier:true,hasMore:false});
 const earlier=await getFeedbackThread(conn.db,config,owner,reportId,{beforeRevision:newest.oldestRevision});
 expect(earlier.messages.map(m=>m.revision)).toEqual([2,3,4]);
 expect(earlier).toMatchObject({oldestRevision:2,nextRevision:4,hasEarlier:false,hasMore:true});
 expect([...earlier.messages,...newest.messages].map(m=>m.id)).toEqual(all.map(m=>m.id));
 await markFeedbackThreadRead(conn.db,config,owner,reportId,newest.nextRevision);
 expect((await getFeedbackThread(conn.db,config,owner,reportId)).unread).toBe(false);
 const empty=await getFeedbackThread(conn.db,config,owner,reportId,secondPage.nextRevision);
 expect(empty.messages).toEqual([]); expect(empty.nextRevision).toBe(secondPage.nextRevision);
});
it('closed threads independently refuse reporter writes and allow staff responses', async () => {
 const reportId=await freshReport();
 await conn.db.update(testerFeedback).set({closedAt:new Date(),lockedAt:null}).where(eq(testerFeedback.id,reportId));
 expect((await getFeedbackThread(conn.db,config,owner,reportId)).report).toMatchObject({closed:true,locked:false});
 await expect(appendFeedbackReply(conn.db,config,owner,reportId,{requestId:'closed-owner',body:'cannot append'})).rejects.toMatchObject({code:'FEEDBACK_THREAD_LOCKED'});
 expect(await appendFeedbackReply(conn.db,config,admin,reportId,{requestId:'closed-admin',body:'closure explanation'})).toHaveProperty('id');
});
it('validates request/body limits and revision cursors before changing a report', async () => {
 const reportId=await freshReport();
 for(const input of [{requestId:'empty',body:'  '},{requestId:'long',body:'x'.repeat(LIMIT.replyMaxLen+1)},
  {requestId:'',body:'valid'},{requestId:'x'.repeat(LIMIT.requestIdMaxLen+1),body:'valid'},{requestId:'bad/key',body:'valid'}]) {
  await expect(appendFeedbackReply(conn.db,config,owner,reportId,input)).rejects.toMatchObject({statusCode:400});
 }
 await expect(getFeedbackThread(conn.db,config,owner,reportId,{afterRevision:0,beforeRevision:3})).rejects.toMatchObject({statusCode:400});
 for(const bad of [-1,0.5,Number.MAX_SAFE_INTEGER+1]) {
  await expect(getFeedbackThread(conn.db,config,owner,reportId,{beforeRevision:bad})).rejects.toMatchObject({statusCode:400});
  await expect(getFeedbackThread(conn.db,config,owner,reportId,bad)).rejects.toMatchObject({statusCode:400});
  await expect(markFeedbackThreadRead(conn.db,config,owner,reportId,bad)).rejects.toMatchObject({statusCode:400});
 }
 expect((await getFeedbackThread(conn.db,config,owner,reportId)).latestRevision).toBe(1);
 expect(await appendFeedbackReply(conn.db,config,owner,reportId,{requestId:'x'.repeat(LIMIT.requestIdMaxLen),body:'x'.repeat(LIMIT.replyMaxLen)})).toHaveProperty('revision',2);
});
it('distinct concurrent reply keys across actors receive unique ordered revisions', async () => {
 const reportId=await freshReport();
 const replies=await Promise.all([owner,admin,owner,admin].map((actor,i)=>appendFeedbackReply(conn.db,config,actor,reportId,{requestId:`concurrent-${reportId}-${i}`,body:`reply ${i}`})));
 expect(replies.map(r=>r.revision).sort((a,b)=>a-b)).toEqual([2,3,4,5]);
 expect((await getFeedbackThread(conn.db,config,owner,reportId)).messages).toHaveLength(4);
});

it('reporter probes and read cursors reveal no hidden staff-note count', async () => {
 const reportId=await freshReport();
 await appendFeedbackReply(conn.db,config,admin,reportId,{requestId:'hidden-a',body:'private1',visibility:'admin'});
 await appendFeedbackReply(conn.db,config,admin,reportId,{requestId:'hidden-b',body:'private2',visibility:'admin'});
 expect((await getFeedbackThread(conn.db,config,owner,reportId)).latestRevision).toBe(1);
 const input={requestId:'visible-probe',body:'hello'};
 expect(await appendFeedbackReply(conn.db,config,owner,reportId,input)).toHaveProperty('revision',2);
 expect(await appendFeedbackReply(conn.db,config,owner,reportId,input)).toHaveProperty('revision',2);
 const view=await getFeedbackThread(conn.db,config,owner,reportId);
 expect([view.latestRevision,view.nextRevision,view.messages[0]!.revision]).toEqual([2,2,2]);
 expect(await markFeedbackThreadRead(conn.db,config,owner,reportId,99)).toEqual({readRevision:2});
 expect((await getFeedbackThread(conn.db,config,admin,reportId)).latestRevision).toBe(4);
});
it('bounds new replies per wallet across threads while preserving successful request replays', async () => {
 const reportId=await freshReport(); const reportTwo=await freshReport();
 const messages=await Promise.all(Array.from({length:LIMIT.maxRepliesPerWindow},(_,i)=>appendFeedbackReply(conn.db,config,owner,i%2?reportTwo:reportId,{requestId:`rate-${i}`,body:'reply'})));
 await expect(appendFeedbackReply(conn.db,config,owner,reportId,{requestId:'rate-over',body:'reply'})).rejects.toMatchObject({statusCode:429,code:'FEEDBACK_REPLY_RATE_LIMITED'});
 expect(await appendFeedbackReply(conn.db,config,owner,reportId,{requestId:'rate-0',body:'reply'})).toEqual(messages[0]);
 await expect(appendFeedbackReply(conn.db,config,owner,reportId,{requestId:'rate-0',body:'changed'})).rejects.toMatchObject({statusCode:409});
 await conn.db.update(feedbackMessages).set({createdAt:new Date(Date.now()-LIMIT.replyWindowMs-1)}).where(eq(feedbackMessages.author,owner.wallet));
 expect(await appendFeedbackReply(conn.db,config,owner,reportId,{requestId:'rate-after',body:'reply'})).toHaveProperty('id');
});
