import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEEDBACK_EXPORTS as LIMIT } from '@shardkeep/shared/feedback';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackExportJobs as jobs, feedbackExportReports, playerActionEvents, playerActivityDays, players, testerFeedback } from '../src/db/schema';
import { requestFeedbackExport } from '../src/game/feedbackExports';
import { prepareNextFeedbackExport } from '../src/game/feedbackExportPreparation';
import { writeFeedbackExport } from '../src/game/feedbackExportFormat';
import type { FeedbackExportStorage } from '../src/game/feedbackExportStorage';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL),admin=randomUUID(),config={ADMIN_WALLETS:[admin]};
let root:string;const ids:string[]=[],reports:string[]=[],wallets:string[]=[];
const objects=new Map<string,{bytes:Buffer;contentType:Parameters<FeedbackExportStorage['putFile']>[3];sha256:string}>();
const storage:FeedbackExportStorage={
 putFile:vi.fn(async(key,path,sha256,contentType)=>{const bytes=await readFile(path);objects.set(key,{bytes,contentType,sha256});return'created' as const;}),
 read:vi.fn(async key=>{const o=objects.get(key);return o?{body:new ReadableStream({start(c){c.enqueue(o.bytes);c.close();}}),byteLength:o.bytes.length,contentType:o.contentType,sha256:o.sha256}:null;}),
 delete:vi.fn(async key=>{objects.delete(key);}),
};
const deps=()=>({exports:storage,screenshots:{read:async()=>null},temporaryRoot:root});
let prior:Pick<typeof jobs.$inferSelect,'id'|'expiresAt'|'preparationLeaseUntil'|'deleteAfter'>[]=[];
beforeAll(async()=>{
 root=await mkdtemp(join(tmpdir(),'feedback-preparation-test-'));
 // Global claim tests run in sequential files. Protect all earlier fixtures,
 // then restore precisely these timestamps after this suite. The retirement
 // sweep must also leave prior fixtures alone while testing our late PUT.
 prior=await conn.db.select({id:jobs.id,expiresAt:jobs.expiresAt,preparationLeaseUntil:jobs.preparationLeaseUntil,deleteAfter:jobs.deleteAfter}).from(jobs);
 if(prior.length)await conn.db.update(jobs).set({expiresAt:new Date(0),preparationLeaseUntil:new Date(0),deleteAfter:new Date('2099-01-01')}).where(inArray(jobs.id,prior.map(j=>j.id)));
});
afterEach(async()=>{
 if(ids.length){await conn.db.delete(feedbackExportReports).where(inArray(feedbackExportReports.jobId,ids));await conn.db.delete(jobs).where(inArray(jobs.id,ids));}
 if(reports.length)await conn.db.delete(testerFeedback).where(inArray(testerFeedback.id,reports));
 if(wallets.length){
  // Deleting reports does not erase their activity receipts. Remove only the
  // fixture wallets' evidence so cleanup reaches the mock reset below.
  await conn.db.delete(playerActionEvents).where(inArray(playerActionEvents.wallet,wallets));
  await conn.db.delete(playerActivityDays).where(inArray(playerActivityDays.wallet,wallets));
  await conn.db.delete(players).where(inArray(players.wallet,wallets));
 }
 ids.length=reports.length=wallets.length=0;objects.clear();vi.clearAllMocks();
 expect(await readdir(root)).toEqual([]);
});
afterAll(async()=>{try{for(const {id,...timestamps} of prior)await conn.db.update(jobs).set(timestamps).where(eq(jobs.id,id));await rm(root,{recursive:true,force:true});}finally{await conn.sql.end();}});
async function fixture(){const wallet=randomUUID();wallets.push(wallet);await conn.db.insert(players).values({wallet});const [r]=await conn.db.insert(testerFeedback).values({wallet,category:'bug',title:'Preparation fixture',body:'Private screenshot-free export'}).returning();reports.push(r!.id);const input={requestId:randomUUID(),format:'zip' as const,selection:{ids:[r!.id]}};const job=await requestFeedbackExport(conn.db,config,admin,input);ids.push(job.jobId);return{job,input};}
async function saved(id:string){return(await conn.db.select().from(jobs).where(eq(jobs.id,id)))[0]!;}
async function retry(id:string){await conn.db.update(jobs).set({preparationLeaseUntil:new Date(0)}).where(eq(jobs.id,id));}
it('reserves key before PUT, verifies full remote bytes before ready and preserves exact request expiry',async()=>{
 const {job,input}=await fixture();let reserved=false;
 const exports={...storage,putFile:vi.fn(async(...args:Parameters<FeedbackExportStorage['putFile']>)=>{const row=await saved(job.jobId);reserved=row.objectKey===args[0]&&row.sha256===args[2]&&row.state==='preparing'&&row.manifest!==null;return storage.putFile(...args);})};
 expect(await prepareNextFeedbackExport(conn.db,config,{...deps(),exports})).toEqual({jobId:job.jobId,state:'ready'});
 expect(reserved).toBe(true);expect(storage.read).toHaveBeenCalledOnce();const row=await saved(job.jobId);expect(row.preparedAt).not.toBeNull();expect(row.manifest).toMatchObject({reportCount:1,missingAttachments:0});
 expect(await requestFeedbackExport(conn.db,config,admin,input)).toEqual(job);
});
it('recovers a lost successful PUT from its reserved key without building/uploading another artifact',async()=>{
 const {job}=await fixture();const exports={...storage,putFile:async(...args:Parameters<FeedbackExportStorage['putFile']>)=>{await storage.putFile(...args);throw new Error('lost acknowledgement https://private-secret');}};
 expect(await prepareNextFeedbackExport(conn.db,config,{...deps(),exports})).toEqual({jobId:job.jobId,state:'retry'});const old=await saved(job.jobId);expect(old.errorCode).toBe('FEEDBACK_EXPORT_PREPARATION_FAILED');expect(old.objectKey).not.toBeNull();await retry(job.jobId);
 const writer=vi.fn(writeFeedbackExport);expect(await prepareNextFeedbackExport(conn.db,config,{...deps(),writer})).toEqual({jobId:job.jobId,state:'ready'});
 expect(writer).not.toHaveBeenCalled();expect(storage.putFile).toHaveBeenCalledOnce();expect((await saved(job.jobId)).objectKey).toBe(old.objectKey);
});
it('keeps one global claim while another request waits and fences a late worker after replacement',async()=>{
 const first=await fixture(),second=await fixture();let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
 const writer:typeof writeFeedbackExport=async(...args)=>{entered();await gate;return writeFeedbackExport(...args);};
 const pending=prepareNextFeedbackExport(conn.db,config,{...deps(),writer});await started;
 expect(await prepareNextFeedbackExport(conn.db,config,deps())).toBeNull();
 const row=await saved(first.job.jobId);await conn.db.update(jobs).set({preparationGeneration:randomUUID(),preparationLeaseUntil:new Date(Date.now()+LIMIT.preparationLeaseMs)}).where(eq(jobs.id,row.id));
 release();expect(await pending).toEqual({jobId:row.id,state:'lost'});expect(storage.putFile).not.toHaveBeenCalled();expect((await saved(second.job.jobId)).state).toBe('pending');
});
it('reclaims a crashed lease, respects retry delay and reaches a bounded terminal failure',async()=>{
 const {job}=await fixture();await conn.db.update(jobs).set({state:'preparing',preparationGeneration:randomUUID(),preparationLeaseUntil:new Date(0)}).where(eq(jobs.id,job.jobId));
 const writer=vi.fn(async()=>{throw new Error('disk failed private path');});
 for(let i=0;i<LIMIT.maxPreparationAttempts;i++){
  const result=await prepareNextFeedbackExport(conn.db,config,{...deps(),writer});expect(result).toEqual({jobId:job.jobId,state:i===LIMIT.maxPreparationAttempts-1?'failed':'retry'});
  expect(await prepareNextFeedbackExport(conn.db,config,deps())).toBeNull();await retry(job.jobId);
 }
 expect(writer).toHaveBeenCalledTimes(LIMIT.maxPreparationAttempts);expect((await saved(job.jobId)).errorCode).toBe('FEEDBACK_EXPORT_PREPARATION_FAILED');
});
it('fails closed when remote bytes mismatch and when a reserved missing artifact rebuilds differently',async()=>{
 const {job}=await fixture();const exports={...storage,read:async(key:string)=>{const result=await storage.read(key);if(!result)return null;return{...result,body:new ReadableStream<Uint8Array>({start(c){c.enqueue(Buffer.alloc(result.byteLength));c.close();}})};}};
 expect(await prepareNextFeedbackExport(conn.db,config,{...deps(),exports})).toEqual({jobId:job.jobId,state:'failed'});expect((await saved(job.jobId)).errorCode).toBe('FEEDBACK_EXPORT_SOURCE_CHANGED');
 const second=await fixture();const uncertain={...storage,putFile:async()=>{throw new Error('PUT never arrived');}};
 expect(await prepareNextFeedbackExport(conn.db,config,{...deps(),exports:uncertain})).toEqual({jobId:second.job.jobId,state:'retry'});const before=await saved(second.job.jobId);await retry(second.job.jobId);
 const writer:typeof writeFeedbackExport=async(...args)=>({...await writeFeedbackExport(...args),sha256:createHash('sha256').update('changed').digest('hex')});
 expect(await prepareNextFeedbackExport(conn.db,config,{...deps(),writer})).toEqual({jobId:second.job.jobId,state:'failed'});expect((await saved(second.job.jobId)).objectKey).toBe(before.objectKey);
});
it('does not prepare expired or revoked-admin jobs and leaves no private temporary files after abort',async()=>{
 const old=await fixture();await conn.db.update(jobs).set({expiresAt:new Date(0)}).where(eq(jobs.id,old.job.jobId));expect(await prepareNextFeedbackExport(conn.db,config,deps())).toBeNull();
 const denied=await fixture();expect(await prepareNextFeedbackExport(conn.db,{ADMIN_WALLETS:[]},deps())).toEqual({jobId:denied.job.jobId,state:'failed'});expect(storage.putFile).not.toHaveBeenCalled();
 const aborted=await fixture(),controller=new AbortController();controller.abort();expect(await prepareNextFeedbackExport(conn.db,config,deps(),controller.signal)).toEqual({jobId:aborted.job.jobId,state:'retry'});expect(storage.putFile).not.toHaveBeenCalled();
});

it('heartbeat observes lease loss while a transport is pending and never publishes afterward',async()=>{
 const {job}=await fixture();let entered!:()=>void;const started=new Promise<void>(r=>{entered=r;});
 const exports={...storage,putFile:async(...args:Parameters<FeedbackExportStorage['putFile']>)=>{
  const signal=args[4]!;entered();await new Promise<void>((_resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('stale transport aborted')),{once:true});});return'created' as const;
 }};
 vi.useFakeTimers({toFake:['setInterval','clearInterval']});
 try{
  const pending=prepareNextFeedbackExport(conn.db,config,{...deps(),exports});await started;
  await conn.db.update(jobs).set({preparationLeaseUntil:new Date(0)}).where(eq(jobs.id,job.jobId));
  await vi.advanceTimersByTimeAsync(LIMIT.preparationHeartbeatMs);
  expect(await pending).toEqual({jobId:job.jobId,state:'lost'});expect((await saved(job.jobId)).preparedAt).toBeNull();
 }finally{vi.useRealTimers();}
});
it('expiry cleanup fences a PUT that completes late, and the next tombstone sweep removes its bytes',async()=>{
 const {cleanupFeedbackExports}=await import('../src/game/feedbackExportRetention');
 const {job}=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
 const exports={...storage,putFile:async(...args:Parameters<FeedbackExportStorage['putFile']>)=>{entered();await gate;return storage.putFile(...args);}};
 const pending=prepareNextFeedbackExport(conn.db,config,{...deps(),exports});await started;
 const expired=new Date();await conn.db.update(jobs).set({expiresAt:expired}).where(eq(jobs.id,job.jobId));
 expect((await cleanupFeedbackExports(conn.db,storage,expired)).deleted).toBe(1);
 release();expect(await pending).toEqual({jobId:job.jobId,state:'lost'});const row=await saved(job.jobId);expect(row.state).toBe('deleted');expect(objects.has(row.objectKey!)).toBe(true);
 await cleanupFeedbackExports(conn.db,storage,new Date(expired.getTime()+LIMIT.cleanupRetryMs));expect(objects.has(row.objectKey!)).toBe(false);
});
