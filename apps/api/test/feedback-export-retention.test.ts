import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FEEDBACK_EXPORTS as LIMIT } from '@shardkeep/shared/feedback';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackExportJobs as jobs } from '../src/db/schema';
import { feedbackExportObjectKey } from '../src/game/feedbackExportStorage';
import { cleanupFeedbackExports,cleanupFeedbackExportTemporaryDirectories,createFeedbackExportTemporaryDirectory } from '../src/game/feedbackExportRetention';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL),ids:string[]=[],objects=new Set<string>(),now=new Date('2002-01-01T00:00:00Z');let root:string;
const storage={delete:async(key:string)=>{objects.delete(key);}};
let prior:Pick<typeof jobs.$inferSelect,'id'|'expiresAt'|'deleteAfter'>[]=[];
beforeAll(async()=>{
 root=await mkdtemp(join(tmpdir(),'feedback-retention-test-'));
 prior=await conn.db.select({id:jobs.id,expiresAt:jobs.expiresAt,deleteAfter:jobs.deleteAfter}).from(jobs);
 if(prior.length)await conn.db.update(jobs).set({expiresAt:new Date('2100-01-01'),deleteAfter:new Date('2100-01-01')}).where(inArray(jobs.id,prior.map(j=>j.id)));
});
afterEach(async()=>{if(ids.length)await conn.db.delete(jobs).where(inArray(jobs.id,ids));ids.length=0;objects.clear();for(const entry of await readdir(root))await rm(join(root,entry),{recursive:true,force:true});});
afterAll(async()=>{try{for(const {id,...fields}of prior)await conn.db.update(jobs).set(fields).where(eq(jobs.id,id));await rm(root,{recursive:true,force:true});}finally{await conn.sql.end();}});
async function fixture(state='ready',expiresAt=now){const id=randomUUID(),key=feedbackExportObjectKey(id,'a'.repeat(64),'zip');ids.push(id);objects.add(key);await conn.db.insert(jobs).values({id,requestedBy:'admin',requestId:randomUUID(),requestHash:'b'.repeat(64),format:'zip',schemaVersion:1,selection:{filter:{}},state,objectKey:key,sha256:'a'.repeat(64),manifest:{reportCount:3},preparedAt:state==='ready'?new Date(0):null,expiresAt});return(await conn.db.select().from(jobs).where(eq(jobs.id,id)))[0]!;}
async function saved(id:string){return(await conn.db.select().from(jobs).where(eq(jobs.id,id)))[0]!;}
it('expires artifacts and unfinished jobs, preserves unexpired files and keeps preparation/export audit records',async()=>{
 const ready=await fixture(),pending=await fixture('pending'),fresh=await fixture('ready',new Date(now.getTime()+1));
 expect(await cleanupFeedbackExports(conn.db,storage,now)).toEqual({examined:2,deleted:2,failed:0});
 expect(await saved(ready.id)).toMatchObject({state:'deleted',objectKey:ready.objectKey,manifest:{reportCount:3},preparedAt:new Date(0),sha256:ready.sha256,deleteAttempts:1});
 expect((await saved(pending.id)).state).toBe('deleted');expect(objects.has(fresh.objectKey!)).toBe(true);
});
it('revisits a late PUT after successful deletion and keeps uncertainty private and retryable',async()=>{
 const row=await fixture();await cleanupFeedbackExports(conn.db,storage,now);objects.add(row.objectKey!);
 expect((await cleanupFeedbackExports(conn.db,storage,now)).examined).toBe(0);
 expect((await cleanupFeedbackExports(conn.db,storage,new Date(now.getTime()+LIMIT.cleanupRetryMs))).deleted).toBe(1);expect(objects.size).toBe(0);expect((await saved(row.id)).deleteAttempts).toBe(2);
 const failed=await fixture();await cleanupFeedbackExports(conn.db,{delete:async()=>{throw new Error('https://private-export/secret');}},now);
 expect(await saved(failed.id)).toMatchObject({state:'deleting',errorCode:'FEEDBACK_EXPORT_DELETE_FAILED',objectKey:failed.objectKey});
 await cleanupFeedbackExports(conn.db,storage,new Date(now.getTime()+LIMIT.cleanupRetryMs));expect((await saved(failed.id)).state).toBe('deleted');
});
it('bounds deletion, invalidates active preparation and allows only one concurrent deletion claim',async()=>{
 const rows=await Promise.all(Array.from({length:LIMIT.cleanupBatchSize+1},()=>fixture('preparing')));
 for(const row of rows)await conn.db.update(jobs).set({preparationGeneration:randomUUID(),preparationLeaseUntil:new Date('2100-01-01')}).where(eq(jobs.id,row.id));
 let count=0;const slow={delete:async(key:string)=>{count++;await storage.delete(key);}};
 const results=await Promise.all([cleanupFeedbackExports(conn.db,slow,now),cleanupFeedbackExports(conn.db,slow,now)]);
 expect(count).toBeLessThanOrEqual(rows.length);expect(results.every(r=>r.examined<=LIMIT.cleanupBatchSize)).toBe(true);
 await cleanupFeedbackExports(conn.db,slow,now);expect(count).toBe(rows.length);
 for(const row of rows)expect(await saved(row.id)).toMatchObject({state:'deleted',preparationGeneration:null,preparationLeaseUntil:null});
});
it('does not let a delayed DELETE completion overwrite a newer tombstone attempt',async()=>{
 const row=await fixture();let entered!:()=>void,release!:()=>void;const started=new Promise<void>(r=>{entered=r;});const gate=new Promise<void>(r=>{release=r;});
 const pending=cleanupFeedbackExports(conn.db,{delete:async()=>{entered();await gate;}},now);await started;
 const later=new Date(now.getTime()+LIMIT.cleanupRetryMs);await cleanupFeedbackExports(conn.db,storage,later);const latest=await saved(row.id);
 release();expect((await pending).deleted).toBe(0);expect(await saved(row.id)).toEqual(latest);
});
const marker=(expiresAt=now.getTime())=>({version:1 as const,jobId:randomUUID(),generation:randomUUID(),createdAt:expiresAt-LIMIT.retentionHours*3600000,expiresAt});
it('deletes only expired marked directories; preserves fresh, unknown, symlinked and oversized markers',async()=>{
 const old=await createFeedbackExportTemporaryDirectory(marker(),root),fresh=await createFeedbackExportTemporaryDirectory(marker(now.getTime()+1),root);
 expect((await lstat(old)).mode&0o777).toBe(0o700);expect((await lstat(join(old,'.private-export.json'))).mode&0o777).toBe(0o600);
 await writeFile(join(old,'reports.json'),'private export',{mode:0o600});
 const unknown=join(root,'pkw-feedback-export-ABC123');await mkdir(unknown,{mode:0o700});await writeFile(join(unknown,'unrelated'),'keep');
 const huge=await createFeedbackExportTemporaryDirectory(marker(),root);await writeFile(join(huge,'.private-export.json'),'x'.repeat(LIMIT.temporaryMarkerMaxBytes+1));
 const linked=join(root,'pkw-feedback-export-DEF456');await symlink(fresh,linked);
 const markerLink=await createFeedbackExportTemporaryDirectory(marker(),root);await rm(join(markerLink,'.private-export.json'));await symlink(join(fresh,'.private-export.json'),join(markerLink,'.private-export.json'));
 expect((await cleanupFeedbackExportTemporaryDirectories(root,now)).deleted).toBe(1);
 expect(await readFile(join(unknown,'unrelated'),'utf8')).toBe('keep');expect((await lstat(linked)).isSymbolicLink()).toBe(true);expect((await lstat(fresh)).isDirectory()).toBe(true);expect((await lstat(huge)).isDirectory()).toBe(true);
});
it('bounds temporary deletion and refuses an unsafe or symlinked root without touching files',async()=>{
 for(let i=0;i<LIMIT.cleanupBatchSize+1;i++)await createFeedbackExportTemporaryDirectory(marker(),root);
 expect((await cleanupFeedbackExportTemporaryDirectories(root,now)).deleted).toBe(LIMIT.cleanupBatchSize);
 expect((await cleanupFeedbackExportTemporaryDirectories(root,now)).deleted).toBe(1);
 const linked=join(root,'alias');await symlink(root,linked);expect((await cleanupFeedbackExportTemporaryDirectories(linked,now)).deleted).toBe(0);
 await chmod(root,0o755);try{expect((await cleanupFeedbackExportTemporaryDirectories(root,now)).deleted).toBe(0);await expect(createFeedbackExportTemporaryDirectory(marker(),root)).rejects.toThrow('unsafe');}finally{await chmod(root,0o700);}
});
