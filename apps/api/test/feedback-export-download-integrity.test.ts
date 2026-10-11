/** A completed Content-Length response is browser success. The storage guard
 * must withhold its last chunk until integrity verification, over real HTTP. */
import { createHash,randomUUID } from 'node:crypto';
import { getPublicKeyAsync,signAsync,utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { afterAll,beforeAll,expect,it,vi } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { feedbackExportJobs } from '../src/db/schema';
import { feedbackExportObjectKey,makeFeedbackExportStorage } from '../src/game/feedbackExportStorage';
import { connectTestDb,TEST_CONFIG } from './helpers';
const {fetchObject}=vi.hoisted(()=>({fetchObject:vi.fn()}));
vi.mock('aws4fetch',()=>({AwsClient:class{fetch=fetchObject;}}));
const conn=connectTestDb(),bytes=Buffer.from('private verified report artifact'),sha=createHash('sha256').update(bytes).digest('hex');
let app:Awaited<ReturnType<typeof buildApp>>,origin:string,cookie:string,url:string;
beforeAll(async()=>{
 const secret=utils.randomSecretKey(),wallet=bs58.encode(await getPublicKeyAsync(secret));
 const storage=makeFeedbackExportStorage({accountId:'a'.repeat(32),bucket:'private-feedback',accessKeyId:'test-only',secretAccessKey:'test-only'});
 app=await buildApp({...TEST_CONFIG,ADMIN_WALLETS:[wallet]},conn.db,{feedbackExportStorage:storage});
 const challenge=await app.inject({method:'GET',url:'/auth/challenge',query:{wallet}});const signature=bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message),secret));
 const auth=await app.inject({method:'POST',url:'/auth/verify',payload:{wallet,signature}});expect(auth.statusCode).toBe(200);cookie=`${SESSION_COOKIE}=${auth.cookies.find(c=>c.name===SESSION_COOKIE)!.value}`;
 const id=randomUUID();await conn.db.insert(feedbackExportJobs).values({id,requestedBy:wallet,requestId:randomUUID(),requestHash:'b'.repeat(64),format:'text',schemaVersion:1,selection:{ids:[]},state:'ready',objectKey:feedbackExportObjectKey(id,sha,'txt'),sha256:sha,manifest:{byteLength:bytes.length,contentType:'text/plain; charset=utf-8',missingAttachments:0},preparedAt:new Date(),expiresAt:new Date(Date.now()+3600000)});
 origin=await app.listen({host:'127.0.0.1',port:0});url=`${origin}/admin/tester/feedback/exports/${id}/download`;
});
afterAll(async()=>{await app?.close();await conn.sql.end();});
function remote(chunks:Buffer[]){return new Response(new ReadableStream<Uint8Array>({start(c){chunks.forEach(b=>c.enqueue(b));c.close();}}),{headers:{'content-type':'text/plain; charset=utf-8','content-length':String(bytes.length),'x-amz-meta-sha256':sha}});}
it('only completes a successful authenticated HTTP download when the full hash matches',async()=>{
 fetchObject.mockResolvedValueOnce(remote([bytes.subarray(0,5),bytes.subarray(5)]));
 const valid=await fetch(url,{headers:{cookie}});expect(valid.status).toBe(200);expect(valid.headers.get('cache-control')).toBe('private, no-store');expect(Buffer.from(await valid.arrayBuffer())).toEqual(bytes);
 for(const chunks of [[Buffer.alloc(bytes.length)],[Buffer.alloc(5),Buffer.alloc(bytes.length-5)]]){
  fetchObject.mockResolvedValueOnce(remote(chunks));
  let successful=false;
  try{const corrupt=await fetch(url,{headers:{cookie}});const downloaded=await corrupt.arrayBuffer();successful=corrupt.status===200&&downloaded.byteLength===bytes.length;}catch{/* A truncated/terminated HTTP response is not a saved export. */}
  expect(successful).toBe(false);
 }
});
