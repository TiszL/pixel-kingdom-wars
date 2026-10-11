/** One durable preparation lease globally. Disk/R2 work never holds a DB
 * transaction; generation checks prevent a late worker publishing stale state. */
import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { FEEDBACK_EXPORTS as LIMIT } from '@shardkeep/shared/feedback';
import { and, eq, gt, isNull, lte, or, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackExportJobs as jobs } from '../db/schema';
import { frozenFeedbackExportReports } from './feedbackExports';
import { writeFeedbackExport, FeedbackExportLimitError } from './feedbackExportFormat';
import { feedbackExportObjectKey, type FeedbackExportContentType, type FeedbackExportStorage } from './feedbackExportStorage';
import type { FeedbackScreenshotStorage } from './feedbackStorage';
import { createFeedbackExportTemporaryDirectory } from './feedbackExportRetention';

type Artifact = Awaited<ReturnType<typeof writeFeedbackExport>>;
type Manifest = Omit<Artifact,'path'|'sha256'>;
type Job = typeof jobs.$inferSelect;
class LostLease extends Error {}
class SourceChanged extends Error {}
const manifestOf = ({path:_path,sha256:_sha,...manifest}:Artifact):Manifest=>manifest;
const sameManifest = (a:Manifest,b:Manifest)=>a.byteLength===b.byteLength&&a.contentType===b.contentType&&a.reportCount===b.reportCount&&a.messageCount===b.messageCount&&a.attachmentCount===b.attachmentCount&&a.missingAttachments===b.missingAttachments;
const owns = (job:Job,generation:string,now:Date) => and(eq(jobs.id,job.id),eq(jobs.state,'preparing'),eq(jobs.preparationGeneration,generation),gt(jobs.preparationLeaseUntil,now),gt(jobs.expiresAt,now));
async function claim(db:Db,now:Date){
 return db.transaction(async tx=>{
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('feedback-export-preparation',0))`);
  const [busy]=await tx.select({id:jobs.id}).from(jobs).where(and(eq(jobs.state,'preparing'),gt(jobs.preparationLeaseUntil,now))).limit(1);
  if(busy)return null;
  const [candidate]=await tx.select().from(jobs).where(and(sql`${jobs.state} in ('pending','preparing')`,gt(jobs.expiresAt,now),or(isNull(jobs.preparationLeaseUntil),lte(jobs.preparationLeaseUntil,now))))
   .orderBy(jobs.createdAt,jobs.id).limit(1).for('update');
  if(!candidate)return null;
  if(candidate.preparationAttempts>=LIMIT.maxPreparationAttempts){
   await tx.update(jobs).set({state:'failed',errorCode:'FEEDBACK_EXPORT_PREPARATION_FAILED',preparationGeneration:null,preparationLeaseUntil:null}).where(eq(jobs.id,candidate.id));
   return {failed:candidate.id} as const;
  }
  const generation=randomUUID();
  const [job]=await tx.update(jobs).set({state:'preparing',preparationGeneration:generation,preparationAttempts:candidate.preparationAttempts+1,
    preparationLeaseUntil:new Date(now.getTime()+LIMIT.preparationLeaseMs),errorCode:null}).where(eq(jobs.id,candidate.id)).returning();
  return {job:job!,generation} as const;
 });
}
async function verifyStored(storage:FeedbackExportStorage,key:string,manifest:Manifest,sha256:string,signal:AbortSignal){
 const remote=await storage.read(key,signal);if(!remote)return false;
 const reader=remote.body.getReader();let bytes=0;const hash=createHash('sha256');
 try{
  if(remote.sha256!==sha256||remote.byteLength!==manifest.byteLength||remote.contentType!==manifest.contentType)throw new SourceChanged();
  for(;;){signal.throwIfAborted();const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;if(bytes>manifest.byteLength)throw new SourceChanged();hash.update(chunk.value);}
  if(bytes!==manifest.byteLength||hash.digest('hex')!==sha256)throw new SourceChanged();
  return true;
 }finally{await reader.cancel();}
}
export interface FeedbackExportPreparationDependencies {
 screenshots:Pick<FeedbackScreenshotStorage,'read'>;exports:FeedbackExportStorage;
 /** Tests can fault the writer without constructing gigabyte archives. */
 writer?:typeof writeFeedbackExport;
 temporaryRoot?:string;
}
export type FeedbackExportPreparationResult={jobId:string;state:'ready'|'retry'|'failed'|'lost'}|null;
export async function prepareNextFeedbackExport(db:Db,config:Pick<Config,'ADMIN_WALLETS'>,deps:FeedbackExportPreparationDependencies,
 signal?:AbortSignal):Promise<FeedbackExportPreparationResult>{
 const claimed=await claim(db,new Date());if(!claimed)return null;if('failed'in claimed)return{jobId:claimed.failed,state:'failed'};
 const {job,generation}=claimed;const controller=new AbortController();let heartbeat:Promise<void>|null=null,dir:string|undefined;
 const abort=()=>controller.abort(signal?.reason??new Error('Export preparation stopped'));signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
 const renew=async()=>{
  const now=new Date();const rows=await db.update(jobs).set({preparationLeaseUntil:new Date(now.getTime()+LIMIT.preparationLeaseMs)}).where(owns(job,generation,now)).returning({id:jobs.id});
  if(!rows.length)throw new LostLease();
 };
 const timer=setInterval(()=>{if(heartbeat||controller.signal.aborted)return;heartbeat=renew().catch(error=>{controller.abort(error);}).finally(()=>{heartbeat=null;});},LIMIT.preparationHeartbeatMs);
 const assertOwned=async()=>{controller.signal.throwIfAborted();await renew();};
 const publish=async(manifest:Manifest)=>{
  await assertOwned();const now=new Date();const rows=await db.update(jobs).set({state:'ready',preparedAt:now,manifest,
   errorCode:null,preparationGeneration:null,preparationLeaseUntil:null}).where(owns(job,generation,now)).returning({id:jobs.id});
  if(!rows.length)throw new LostLease();
 };
 try{
  await assertOwned();
  if(!config.ADMIN_WALLETS?.includes(job.requestedBy))throw new SourceChanged();
  if(job.objectKey){
   if(!job.sha256||!job.manifest)throw new SourceChanged();
   const manifest=job.manifest as Manifest;
   if(await verifyStored(deps.exports,job.objectKey,manifest,job.sha256,controller.signal)){await publish(manifest);return{jobId:job.id,state:'ready'};}
  }
  dir=await createFeedbackExportTemporaryDirectory({version:1,jobId:job.id,generation,createdAt:job.createdAt.getTime(),expiresAt:job.expiresAt.getTime()},deps.temporaryRoot);
  const source=frozenFeedbackExportReports(db,config,job.requestedBy,job.id,{read:(key)=>{controller.signal.throwIfAborted();return deps.screenshots.read(key,controller.signal);}});
  async function* checked<T>(values:AsyncIterable<T>){for await(const value of values){controller.signal.throwIfAborted();yield value;}}
  async function* boundedSource(){for await(const report of checked(source)){yield {...report,messages:checked(report.messages),attachments:checked(report.attachments)};}}
  const artifact=await(deps.writer??writeFeedbackExport)(dir,job.format as 'text'|'json'|'zip',{jobId:job.id,createdAt:job.createdAt.toISOString()},boundedSource());
  await assertOwned();const manifest=manifestOf(artifact);
  const key=feedbackExportObjectKey(job.id,artifact.sha256,job.format==='text'?'txt':job.format as 'json'|'zip');
  if(job.objectKey&&(job.objectKey!==key||job.sha256!==artifact.sha256||!sameManifest(job.manifest as Manifest,manifest)))throw new SourceChanged();
  // Reserve BEFORE any PUT. A timeout never changes this immutable destination.
  const reserved=await db.update(jobs).set({objectKey:key,sha256:artifact.sha256,manifest}).where(owns(job,generation,new Date())).returning({id:jobs.id});
  if(!reserved.length)throw new LostLease();
  await deps.exports.putFile(key,artifact.path,artifact.sha256,artifact.contentType as FeedbackExportContentType,controller.signal);
  if(!await verifyStored(deps.exports,key,manifest,artifact.sha256,controller.signal))throw new Error('Export object not yet visible');
  await publish(manifest);return{jobId:job.id,state:'ready'};
 }catch(error){
  const now=new Date(),terminal=error instanceof SourceChanged||error instanceof FeedbackExportLimitError||job.preparationAttempts>=LIMIT.maxPreparationAttempts;
  const errorCode=error instanceof SourceChanged?'FEEDBACK_EXPORT_SOURCE_CHANGED':error instanceof FeedbackExportLimitError?'FEEDBACK_EXPORT_TOO_LARGE':'FEEDBACK_EXPORT_PREPARATION_FAILED';
  const rows=await db.update(jobs).set({state:terminal?'failed':'pending',errorCode,preparationGeneration:null,
    preparationLeaseUntil:terminal?null:new Date(now.getTime()+LIMIT.preparationRetryMs)}).where(owns(job,generation,now)).returning({id:jobs.id});
  return{jobId:job.id,state:rows.length?(terminal?'failed':'retry'):'lost'};
 }finally{
  clearInterval(timer);signal?.removeEventListener('abort',abort);await heartbeat;
  // Remove only this worker's private directory. Crash leftovers are handled by
  // the separate 24h temporary-directory retention sweep.
  if(dir)await rm(dir,{recursive:true,force:true});
 }
}
