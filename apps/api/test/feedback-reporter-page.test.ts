import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync,signAsync,utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { eq,sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll,beforeAll,expect,it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { feedbackAttachments,feedbackIssueLinks,feedbackIssues,feedbackMessages,players,testerFeedback } from '../src/db/schema';
import { listReporterFeedbackPage } from '../src/game/feedbackReporterPage';
import { appendFeedbackReply,getFeedbackThread,markFeedbackThreadRead } from '../src/game/feedbackThreads';
import { setFeedbackScreenshotPreservation } from '../src/game/feedbackRetention';
import { TEST_CONFIG,connectTestDb } from './helpers';
const conn=connectTestDb();let app:FastifyInstance,owner:string,other:string,admin:string,ownerCookie:string,otherCookie:string;
async function keypair(){const secret=utils.randomSecretKey();return{secret,wallet:bs58.encode(await getPublicKeyAsync(secret))};}
async function login(key:Awaited<ReturnType<typeof keypair>>){const challenge=await app.inject({method:'GET',url:'/auth/challenge',query:{wallet:key.wallet}});const signature=bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message),key.secret));const response=await app.inject({method:'POST',url:'/auth/verify',payload:{wallet:key.wallet,signature}});expect(response.statusCode).toBe(200);return response.cookies.find(c=>c.name===SESSION_COOKIE)!.value;}
beforeAll(async()=>{const a=await keypair(),o=await keypair(),x=await keypair();owner=o.wallet;other=x.wallet;admin=a.wallet;app=await buildApp({...TEST_CONFIG,ADMIN_WALLETS:[admin]},conn.db);ownerCookie=await login(o);otherCookie=await login(x);await login(a);});
afterAll(async()=>{await app?.close();await conn.sql.end();});
async function report(wallet=owner){return(await conn.db.insert(testerFeedback).values({wallet,category:'bug',title:'Private reporter issue',body:'Actual bounded reproduction',adminNote:'Historical staff response',context:{screen:'sensitive-context'}}).returning())[0]!;}
it('returns more than200 reports through stable timestamp/UUID pages without crossing wallet scope',async()=>{
 const wallet=randomUUID();await conn.db.insert(players).values({wallet});
 const ids=(await conn.db.insert(testerFeedback).values(Array.from({length:205},()=>({wallet,category:'bug',title:'Shared timestamp',body:'Complete paginated history',createdAt:new Date('2003-01-01T00:00:00.123Z')}))).returning({id:testerFeedback.id})).map(r=>r.id).sort().reverse();
 // Distinct microseconds inside the same millisecond must not drop rows.
 await conn.db.execute(sql`update tester_feedback set created_at=created_at+interval '0.0005 seconds' where wallet=${wallet} and id=${ids[100]}`);
 const seen:string[]=[];let cursor:string|undefined;
 do{const page=await listReporterFeedbackPage(conn.db,wallet,cursor?{cursor}:{});expect(page.feedback.length).toBeLessThanOrEqual(50);seen.push(...page.feedback.map(r=>r.id));cursor=page.nextCursor??undefined;}while(cursor);
 expect(seen).toEqual(ids);expect(new Set(seen).size).toBe(205);
 const first=await listReporterFeedbackPage(conn.db,wallet);await expect(listReporterFeedbackPage(conn.db,other,{cursor:first.nextCursor})).rejects.toMatchObject({statusCode:400});
});
it('private staff activity changes neither reporter list rows nor unread; visible staff replies do',async()=>{
 const r=await report(),config={ADMIN_WALLETS:[admin]},actor={wallet:admin,mode:'admin' as const};
 const before=await listReporterFeedbackPage(conn.db,owner);
 const [issue]=await conn.db.insert(feedbackIssues).values({title:'Unpublished private issue',body:'Private diagnosis',approvedBy:admin}).returning();
 await conn.db.insert(feedbackIssueLinks).values({reportId:r.id,issueId:issue!.id,linkedBy:admin,reason:'Secret link reason'});
 await appendFeedbackReply(conn.db,config,actor,r.id,{requestId:randomUUID(),visibility:'admin',body:'Secret internal evidence'});
 expect(await listReporterFeedbackPage(conn.db,owner)).toEqual(before);
 await appendFeedbackReply(conn.db,config,actor,r.id,{requestId:randomUUID(),body:'Please add a screenshot'});
 const row=(await listReporterFeedbackPage(conn.db,owner)).feedback.find(f=>f.id===r.id)!;
 expect(row).toMatchObject({revision:2,reporterRevision:2,unread:true});
 for(const key of ['wallet','context','adminNote','linkedIssue','lockedAt','closedAt'])expect(row).not.toHaveProperty(key);
 expect(JSON.stringify(row)).not.toContain(issue!.id);
 await markFeedbackThreadRead(conn.db,config,{wallet:owner,mode:'reporter'},r.id,row.reporterRevision);
 expect((await listReporterFeedbackPage(conn.db,owner)).feedback.find(f=>f.id===r.id)!.unread).toBe(false);
 await appendFeedbackReply(conn.db,config,{wallet:owner,mode:'reporter'},r.id,{requestId:randomUUID(),body:'Added my own reply'});
 expect((await listReporterFeedbackPage(conn.db,owner)).feedback.find(f=>f.id===r.id)!.unread).toBe(false);
});
it('rejects malformed/admin cursors and unrecognized filters without widening the reporter projection',async()=>{
 for(const cursor of ['not-json','%bad',Buffer.from(JSON.stringify({mode:'admin',t:0,id:randomUUID()})).toString('base64url'),'a'.repeat(500)])await expect(listReporterFeedbackPage(conn.db,owner,{cursor})).rejects.toMatchObject({statusCode:400});
 await expect(listReporterFeedbackPage(conn.db,owner,{wallet:other})).rejects.toMatchObject({statusCode:400});
});
it('uses real signed session auth and private cache headers on success, invalid query and denial',async()=>{
 await report(other);
 for(const auth of [{}, {[SESSION_COOKIE]:'forged'}]){const denied=await app.inject({method:'GET',url:'/tester/feedback/page',cookies:auth});expect(denied.statusCode).toBe(401);expect(denied.headers['cache-control']).toBe('private, no-store');}
 const mine=await app.inject({method:'GET',url:'/tester/feedback/page',cookies:{[SESSION_COOKIE]:ownerCookie}});expect(mine.statusCode).toBe(200);expect(mine.headers['cache-control']).toBe('private, no-store');expect(mine.headers['vary']).toContain('Cookie');
 const theirs=await app.inject({method:'GET',url:'/tester/feedback/page',cookies:{[SESSION_COOKIE]:otherCookie}});expect(theirs.statusCode).toBe(200);
 const mineIds=mine.json().feedback.map((r:{id:string})=>r.id);expect(theirs.json().feedback.every((r:{id:string})=>!mineIds.includes(r.id))).toBe(true);
 const invalid=await app.inject({method:'GET',url:'/tester/feedback/page?cursor=bad',cookies:{[SESSION_COOKIE]:ownerCookie}});expect(invalid.statusCode).toBe(400);expect(invalid.headers['cache-control']).toBe('private, no-store');
 const legacy=await app.inject({method:'GET',url:'/tester/feedback',cookies:{[SESSION_COOKIE]:ownerCookie}});expect(legacy.statusCode).toBe(200);expect(legacy.json().feedback).toBeInstanceOf(Array);
});
it('serializes raw PostgreSQL report timestamps as ISO UTC for installed native readers without exposing private fields',async()=>{
 const r=await report(),unreviewed=await report();
 await conn.db.execute(sql`update tester_feedback set created_at='2026-09-19 22:22:19.186789+04'::timestamptz,
  reviewed_at='2026-09-19 22:23:19.186789+04'::timestamptz,fixed_at='2026-09-19 22:24:19.186789+04'::timestamptz,fixed_ref='0.5.8' where id=${r.id}`);
 // This is the production raw-query path, not a fabricated Date-based DTO that Fastify would normalize itself.
 const [raw]=await conn.db.execute<{createdAt:string}>(sql`select created_at as "createdAt" from tester_feedback where id=${r.id}`);
 expect(typeof raw!.createdAt).toBe('string');expect(raw!.createdAt).toContain(' ');
 const response=await app.inject({method:'GET',url:'/tester/feedback/page',cookies:{[SESSION_COOKIE]:ownerCookie}});
 expect(response.statusCode).toBe(200);expect(response.headers['cache-control']).toBe('private, no-store');
 const page=response.json(),row=page.feedback.find((f:{id:string})=>f.id===r.id);
 expect(row).toMatchObject({status:'fixed',createdAt:'2026-09-19T18:22:19.186Z',reviewedAt:'2026-09-19T18:23:19.186Z',fixedAt:'2026-09-19T18:24:19.186Z',fixedRef:'0.5.8'});
 const pending=page.feedback.find((f:{id:string})=>f.id===unreviewed.id);
 expect(pending).toMatchObject({reviewedAt:null,fixedAt:null});expect(pending.createdAt).toBe(new Date(pending.createdAt).toISOString());
 for(const field of ['wallet','context','adminNote','linkedIssue','lockedAt','closedAt'])expect(row).not.toHaveProperty(field);
});
it('accepts the installed campaign picker canonical limit on every page without changing defaults or widening query scope',async()=>{
 const key=await keypair(),cookie=await login(key);
 const ids=(await conn.db.insert(testerFeedback).values(Array.from({length:FEEDBACK_THREADS.pageSize+1},()=>({wallet:key.wallet,category:'bug',title:'Campaign report',body:'Private report selection',createdAt:new Date('2026-09-19T18:22:19.186Z')}))).returning({id:testerFeedback.id})).map(r=>r.id).sort().reverse();
 const get=(query:Record<string,string>={})=>app.inject({method:'GET',url:'/tester/feedback/page',query,cookies:{[SESSION_COOKIE]:cookie}});
 const normal=await get(),first=await get({limit:String(FEEDBACK_THREADS.pageSize)});
 expect(first.statusCode).toBe(200);expect(first.json()).toEqual(normal.json());
 expect(first.json().feedback).toHaveLength(FEEDBACK_THREADS.pageSize);
 const second=await get({limit:String(FEEDBACK_THREADS.pageSize),cursor:first.json().nextCursor});
 expect(second.statusCode).toBe(200);expect(second.json().nextCursor).toBeNull();
 expect([...first.json().feedback,...second.json().feedback].map((r:{id:string})=>r.id)).toEqual(ids);
 for(const limit of ['', '0','1','49','51','-1','NaN','50.5','050'])expect((await get({limit})).statusCode).toBe(400);
 expect((await get({limit:String(FEEDBACK_THREADS.pageSize),wallet:other})).statusCode).toBe(400);
 const foreign=await app.inject({method:'GET',url:'/tester/feedback/page',query:{limit:String(FEEDBACK_THREADS.pageSize),cursor:first.json().nextCursor},cookies:{[SESSION_COOKIE]:otherCookie}});
 expect(foreign.statusCode).toBe(400);expect(foreign.headers['cache-control']).toBe('private, no-store');
});
it('exposes screenshot preservation only to admin projection while reporter data stays identical',async()=>{
 const r=await report(),config={ADMIN_WALLETS:[admin]},attachmentId=randomUUID(),messageId=randomUUID();
 await conn.db.insert(feedbackMessages).values({id:messageId,reportId:r.id,author:owner,visibility:'reporter',kind:'reply',body:'Evidence screenshot',revision:2,reporterRevision:2,requestId:randomUUID(),context:{authorRole:'reporter',attachmentIds:[attachmentId]}});
 await conn.db.update(testerFeedback).set({revision:2,reporterRevision:2}).where(eq(testerFeedback.id,r.id));
 await conn.db.insert(feedbackAttachments).values({id:attachmentId,wallet:owner,reportId:r.id,messageId,requestId:randomUUID(),state:'attached',objectKey:`feedback/${randomUUID()}/${'a'.repeat(64)}.webp`,sha256:'a'.repeat(64),byteLength:10,width:1,height:1,contentType:'image/webp',expiresAt:new Date()});
 const actor={wallet:owner,mode:'reporter' as const},staff={wallet:admin,mode:'admin' as const};
 const reporterBefore=await getFeedbackThread(conn.db,config,actor,r.id),listBefore=await listReporterFeedbackPage(conn.db,owner);
 const adminBefore=await getFeedbackThread(conn.db,config,staff,r.id);expect(adminBefore.messages[0]!.attachments[0]!.preserved).toBe(false);expect(reporterBefore.messages[0]!.attachments[0]).not.toHaveProperty('preserved');
 await setFeedbackScreenshotPreservation(conn.db,config,admin,r.id,attachmentId,{requestId:randomUUID(),expectedRevision:adminBefore.report.revision!,preserved:true,reason:'Private evidence investigation'});
 expect(await getFeedbackThread(conn.db,config,actor,r.id)).toEqual(reporterBefore);expect(await listReporterFeedbackPage(conn.db,owner)).toEqual(listBefore);
 const adminAfter=await getFeedbackThread(conn.db,config,staff,r.id);expect(adminAfter.messages[0]!.attachments[0]!.preserved).toBe(true);expect(adminAfter.report.revision).toBe(3);
});
