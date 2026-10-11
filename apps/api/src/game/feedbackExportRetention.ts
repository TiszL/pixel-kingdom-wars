/** Private export expiry retains immutable keys and audit rows. A delayed PUT
 * can arrive after DELETE, so expired keys remain recurring tombstones. */
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, opendir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FEEDBACK_EXPORTS as LIMIT } from '@shardkeep/shared/feedback';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { feedbackExportJobs as jobs } from '../db/schema';
import type { FeedbackExportStorage } from './feedbackExportStorage';

const due = (now:Date)=>and(or(isNull(jobs.deleteAfter),lte(jobs.deleteAfter,now)),
 or(sql`${jobs.state} in ('deleting','deleted')`,lte(jobs.expiresAt,now)));
export async function cleanupFeedbackExports(db:Db,storage:Pick<FeedbackExportStorage,'delete'>,now=new Date()){
 const candidates=await db.select({id:jobs.id}).from(jobs).where(due(now))
  .orderBy(sql`coalesce(${jobs.deleteAfter},${jobs.expiresAt})`,jobs.id).limit(LIMIT.cleanupBatchSize);
 const result={examined:candidates.length,deleted:0,failed:0};
 for(const candidate of candidates){
  const claim=await db.transaction(async tx=>{
   const [current]=await tx.select().from(jobs).where(eq(jobs.id,candidate.id)).for('update');
   if(!current)return null;
   const [stillDue]=await tx.select({id:jobs.id}).from(jobs).where(and(eq(jobs.id,current.id),due(now)));
   if(!stillDue)return null;
   const [row]=await tx.update(jobs).set({state:'deleting',preparationGeneration:null,preparationLeaseUntil:null,
     deleteAttempts:current.deleteAttempts+1,deleteAfter:new Date(now.getTime()+LIMIT.cleanupRetryMs)})
    .where(eq(jobs.id,current.id)).returning();
   return row!;
  });
  if(!claim)continue;
  try{
   if(claim.objectKey)await storage.delete(claim.objectKey);
   const rows=await db.update(jobs).set({state:'deleted',deletedAt:claim.deletedAt??now,errorCode:null})
    .where(and(eq(jobs.id,claim.id),eq(jobs.state,'deleting'),eq(jobs.deleteAttempts,claim.deleteAttempts))).returning({id:jobs.id});
   result.deleted+=rows.length;
  }catch{
   const rows=await db.update(jobs).set({errorCode:'FEEDBACK_EXPORT_DELETE_FAILED'})
    .where(and(eq(jobs.id,claim.id),eq(jobs.state,'deleting'),eq(jobs.deleteAttempts,claim.deleteAttempts))).returning({id:jobs.id});
   result.failed+=rows.length;
  }
 }
 return result;
}

const ROOT=join(tmpdir(),'pkw-feedback-exports'),MARKER='.private-export.json';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAME=/^pkw-feedback-export-[A-Za-z0-9]{6}$/;
interface Marker {version:1;jobId:string;generation:string;createdAt:number;expiresAt:number}
async function privateDirectory(path:string){
 const stat=await lstat(path);
 return stat.isDirectory()&&!stat.isSymbolicLink()&&(stat.mode&0o077)===0&&stat.uid===process.getuid?.();
}
export async function createFeedbackExportTemporaryDirectory(marker:Marker,root=ROOT){
 if(marker.version!==1||!UUID.test(marker.jobId)||!UUID.test(marker.generation)||!Number.isSafeInteger(marker.createdAt)||!Number.isSafeInteger(marker.expiresAt)
  ||marker.expiresAt-marker.createdAt!==LIMIT.retentionHours*3600000)throw new Error('Invalid private export marker');
 await mkdir(root,{recursive:true,mode:0o700});
 if(!await privateDirectory(root))throw new Error('Private export temporary root is unsafe');
 const directory=await mkdtemp(join(root,'pkw-feedback-export-'));
 try{
  await chmod(directory,0o700);
  await writeFile(join(directory,MARKER),JSON.stringify(marker),{flag:'wx',mode:0o600});
  return directory;
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}
async function expiredMarker(directory:string,now:Date){
 const file=await open(join(directory,MARKER),constants.O_RDONLY|constants.O_NOFOLLOW);
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||stat.size<=0||stat.size>LIMIT.temporaryMarkerMaxBytes)return false;
  const bytes=Buffer.alloc(LIMIT.temporaryMarkerMaxBytes+1),read=await file.read(bytes,0,bytes.length,0);
  if(read.bytesRead!==stat.size)return false;
  const marker=JSON.parse(bytes.subarray(0,read.bytesRead).toString('utf8')) as Marker;
  if(Object.keys(marker).sort().join(',')!=='createdAt,expiresAt,generation,jobId,version'||marker.version!==1||!UUID.test(marker.jobId)||!UUID.test(marker.generation)
   ||!Number.isSafeInteger(marker.createdAt)||!Number.isSafeInteger(marker.expiresAt)||marker.expiresAt-marker.createdAt!==LIMIT.retentionHours*3600000)return false;
  return marker.expiresAt<=now.getTime();
 }finally{await file.close();}
}
/** A dedicated private root avoids walking the OS temporary directory. At most
 * a bounded number of entries are examined; unknown or symlinked paths stay. */
export async function cleanupFeedbackExportTemporaryDirectories(root=ROOT,now=new Date()){
 const result={examined:0,deleted:0,failed:0};
 try{if(!await privateDirectory(root))return result;}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return result;throw error;}
 const dir=await opendir(root);
 try{
  for(let scanned=0;scanned<LIMIT.temporaryScanEntries&&result.deleted<LIMIT.cleanupBatchSize;scanned++){
   const entry=await dir.read();if(!entry)break;
   if(!NAME.test(entry.name)||!entry.isDirectory())continue;
   result.examined++;const path=join(root,entry.name);
   try{
    if(!await privateDirectory(path)||!await expiredMarker(path,now))continue;
    // Recheck after marker read; never follow a replaced directory symlink.
    if(!await privateDirectory(path))continue;
    await rm(path,{recursive:true,force:true});result.deleted++;
   }catch(error){if(!['ENOENT','ELOOP'].includes((error as NodeJS.ErrnoException).code??''))result.failed++;}
  }
 }finally{await dir.close();}
 return result;
}
