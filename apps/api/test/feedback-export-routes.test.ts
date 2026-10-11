import { createHash, randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { feedbackExportJobs, testerFeedback } from '../src/db/schema';
import type { FeedbackExportStorage } from '../src/game/feedbackExportStorage';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn=connectTestDb(),prefix='/admin/tester/feedback/exports';
let app:Awaited<ReturnType<typeof buildApp>>,adminCookie:string,reporterCookie:string,reportId:string;
const bytes=Buffer.from('Private report text'),sha=createHash('sha256').update(bytes).digest('hex');
const storage:FeedbackExportStorage={putFile:vi.fn(),delete:vi.fn(),read:vi.fn(async()=>({body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}}),sha256:sha,byteLength:bytes.length,contentType:'text/plain; charset=utf-8' as const}))};
async function keypair(){const secret=utils.randomSecretKey();return{secret,wallet:bs58.encode(await getPublicKeyAsync(secret))};}
async function login(key:Awaited<ReturnType<typeof keypair>>){const challenge=await app.inject({method:'GET',url:'/auth/challenge',query:{wallet:key.wallet}});const signed=bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message),key.secret));const result=await app.inject({method:'POST',url:'/auth/verify',payload:{wallet:key.wallet,signature:signed}});expect(result.statusCode).toBe(200);return result.cookies.find(c=>c.name===SESSION_COOKIE)!.value;}
const cookies=(value:string)=>({[SESSION_COOKIE]:value});
beforeAll(async()=>{const admin=await keypair(),reporter=await keypair();app=await buildApp({...TEST_CONFIG,ADMIN_WALLETS:[admin.wallet]},conn.db,{feedbackExportStorage:storage});adminCookie=await login(admin);reporterCookie=await login(reporter);const [r]=await conn.db.insert(testerFeedback).values({wallet:reporter.wallet,category:'bug',title:'Private report',body:'Private report details'}).returning();reportId=r!.id;});
afterAll(async()=>{await app?.close();await conn.sql.end();});
const input=()=>({requestId:randomUUID(),format:'text',selection:{ids:[reportId]}});
it('requires a full configured admin session on every export surface and keeps errors uncached',async()=>{
 for(const url of [prefix,`${prefix}/${randomUUID()}`,`${prefix}/${randomUUID()}/download`])for(const cookie of [undefined,reporterCookie]){
  const r=await app.inject({method:'GET',url,...(cookie?{cookies:cookies(cookie)}:{})});expect(r.statusCode).toBe(cookie?403:401);expect(r.headers['cache-control']).toBe('private, no-store');
 }
 expect((await app.inject({method:'POST',url:prefix,cookies:cookies(reporterCookie),payload:input()})).statusCode).toBe(403);
 expect(storage.read).not.toHaveBeenCalled();
});
it('prepares one durable request, exposes safe status, and records a download request without claiming it was saved',async()=>{
 const request={method:'POST' as const,url:prefix,cookies:cookies(adminCookie),payload:input()};
 const result=await app.inject(request);expect(result.statusCode).toBe(202);expect((await app.inject(request)).json()).toEqual(result.json());const id=result.json().jobId;
 expect((await app.inject({method:'GET',url:`${prefix}/${id}/download`,cookies:cookies(adminCookie)})).statusCode).toBe(409);
 const objectKey=`exports/${id}/${sha}.txt`;
 await conn.db.update(feedbackExportJobs).set({state:'ready',preparedAt:new Date(),objectKey,sha256:sha,manifest:{byteLength:bytes.length,contentType:'text/plain; charset=utf-8',missingAttachments:0}}).where(eq(feedbackExportJobs.id,id));
 const status=await app.inject({method:'GET',url:`${prefix}/${id}`,cookies:cookies(adminCookie)});expect(status.json()).toMatchObject({id,state:'ready',reportCount:1,private:true,downloadRequestedAt:null});expect(status.body).not.toContain(objectKey);
 const download=await app.inject({method:'GET',url:`${prefix}/${id}/download`,cookies:cookies(adminCookie)});expect(download.statusCode).toBe(200);expect(download.body).toBe(bytes.toString());expect(download.headers['cache-control']).toBe('private, no-store');expect(download.headers['content-disposition']).toContain('.txt');
 const after=await app.inject({method:'GET',url:`${prefix}/${id}`,cookies:cookies(adminCookie)});expect(after.json().downloadRequestedAt).toBeTypeOf('string');expect(after.json()).not.toHaveProperty('savedAt');
 const list=await app.inject({method:'GET',url:prefix,cookies:cookies(adminCookie)});expect(list.json().exports.some((j:{id:string})=>j.id===id)).toBe(true);expect(list.body).not.toContain(objectKey);
});
it('denies expired files and refuses changed storage metadata without recording a download',async()=>{
 const r=await app.inject({method:'POST',url:prefix,cookies:cookies(adminCookie),payload:input()}),id=r.json().jobId;
 await conn.db.update(feedbackExportJobs).set({state:'ready',objectKey:`exports/${id}/${sha}.txt`,sha256:sha,manifest:{byteLength:bytes.length+1,contentType:'text/plain; charset=utf-8'}}).where(eq(feedbackExportJobs.id,id));
 expect((await app.inject({method:'GET',url:`${prefix}/${id}/download`,cookies:cookies(adminCookie)})).statusCode).toBe(503);
 expect((await conn.db.select().from(feedbackExportJobs).where(eq(feedbackExportJobs.id,id)))[0]!.downloadRequestedAt).toBeNull();
 await conn.db.update(feedbackExportJobs).set({expiresAt:new Date(0)}).where(eq(feedbackExportJobs.id,id));
 expect((await app.inject({method:'GET',url:`${prefix}/${id}/download`,cookies:cookies(adminCookie)})).statusCode).toBe(410);
});
