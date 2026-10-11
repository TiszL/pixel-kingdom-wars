import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackAttachments, feedbackExportJobs, feedbackExportReports, feedbackMessages, players, testerFeedback } from '../src/db/schema';
import { feedbackLastExportedRevision, frozenFeedbackExportReports, requestFeedbackExport } from '../src/game/feedbackExports';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL),config={ADMIN_WALLETS:['export-admin']};
let admin='export-admin';
beforeEach(()=>{admin=`export-admin-${randomUUID()}`;config.ADMIN_WALLETS=[admin];});
afterAll(async()=>conn.sql.end());
async function fixture(count=1){
 const wallet=randomUUID();await conn.db.insert(players).values({wallet});
 const rows=await conn.db.insert(testerFeedback).values(Array.from({length:count},()=>({wallet,category:'bug',title:'Private export fixture',body:'Full private diagnostic report',adminNote:'Historical staff note',context:{screen:'tester',build:'fixture'}}))).returning();
 return{wallet,rows};
}
const request=(ids:string[])=>({requestId:randomUUID(),format:'zip' as const,selection:{ids}});
const storage={read:vi.fn(async()=>Buffer.from('screenshot'))};
async function collect(jobId:string){const out=[];for await(const r of frozenFeedbackExportReports(conn.db,config,admin,jobId,storage)){const messages=[];for await(const m of r.messages)messages.push(m);const attachments=[];for await(const a of r.attachments)attachments.push(a);out.push({...r,messages,attachments});}return out;}
it('freezes every selected report beyond200 and returns exact concurrent idempotent receipt without transport secrets',async()=>{
 const f=await fixture(205),input=request(f.rows.map(r=>r.id));
 const [a,b]=await Promise.all([requestFeedbackExport(conn.db,config,admin,input),requestFeedbackExport(conn.db,config,admin,{...input,selection:{ids:[...input.selection.ids].reverse()}})]);
 expect(a).toEqual(b);expect(a.reportCount).toBe(205);
 const out=await collect(a.jobId);expect(out).toHaveLength(205);expect(out[0]!.data).toMatchObject({wallet:f.wallet,adminNote:'Historical staff note'});
 expect(out[0]!.data).not.toHaveProperty('requestHash');expect(out[0]!.data).not.toHaveProperty('submissionReceipt');
 await expect(requestFeedbackExport(conn.db,config,admin,{...input,format:'text'})).rejects.toMatchObject({code:'FEEDBACK_EXPORT_CONFLICT'});
});
it('full filter selection has no200 ceiling and matches all selected statuses with no unknown filter bypass',async()=>{
 const f=await fixture(205);await conn.db.update(testerFeedback).set({category:'other',fixedRef:f.wallet}).where(eq(testerFeedback.wallet,f.wallet));
 const job=await requestFeedbackExport(conn.db,config,admin,{requestId:randomUUID(),format:'json',selection:{filter:{category:'other'}}});
 const exported=(await collect(job.jobId)).filter(r=>r.data['wallet']===f.wallet);expect(exported).toHaveLength(205);
 await expect(requestFeedbackExport(conn.db,config,admin,{requestId:randomUUID(),format:'json',selection:{filter:{wallet:f.wallet}}} as never)).rejects.toMatchObject({statusCode:400});
});
it('streams full private history in ordered pages, freezing metadata and excluding new replies',async()=>{
 const f=await fixture(),r=f.rows[0]!;
 await conn.db.insert(feedbackMessages).values(Array.from({length:75},(_,i)=>({reportId:r.id,author:admin,visibility:'admin',kind:'note',body:`Private note ${i}`,context:{authorRole:'admin',reason:'Staff evidence',requestHash:'not-exported',receipt:{secret:'not-exported'}},revision:i+2,requestId:randomUUID()})));
 await conn.db.update(testerFeedback).set({revision:76}).where(eq(testerFeedback.id,r.id));
 const job=await requestFeedbackExport(conn.db,config,admin,request([r.id]));
 await conn.db.insert(feedbackMessages).values({reportId:r.id,author:admin,visibility:'admin',kind:'reply',body:'After export snapshot',revision:77,requestId:randomUUID()});
 await conn.db.update(testerFeedback).set({revision:77,title:'Changed after snapshot'}).where(eq(testerFeedback.id,r.id));
 const [out]=await collect(job.jobId);expect(out!.revision).toBe(76);expect(out!.data['title']).toBe(r.title);expect(out!.messages).toHaveLength(75);expect(out!.messages.at(-1)!.body).toBe('Private note 74');
 expect(out!.messages[0]!.context).toEqual({authorRole:'admin',reason:'Staff evidence'});
 const last=()=>conn.db.select({revision:feedbackLastExportedRevision(sql`${testerFeedback.id}`,sql`${testerFeedback.exportedAt}`)}).from(testerFeedback).where(eq(testerFeedback.id,r.id));
 expect((await last())[0]!.revision).toBe(0);
 await conn.db.update(feedbackExportJobs).set({preparedAt:new Date(),state:'ready'}).where(eq(feedbackExportJobs.id,job.jobId));
 expect((await last())[0]!.revision).toBe(76);
 const changed=await requestFeedbackExport(conn.db,config,admin,{requestId:randomUUID(),format:'text',selection:{filter:{exported:false}}});
 expect((await conn.db.select().from(feedbackExportReports).where(and(eq(feedbackExportReports.jobId,changed.jobId),eq(feedbackExportReports.reportId,r.id))))).toHaveLength(1);
});
it('requires current configured admin for request/source and rolls back a missing selected report',async()=>{
 const f=await fixture(),input=request([f.rows[0]!.id]);
 await expect(requestFeedbackExport(conn.db,config,f.wallet,input)).rejects.toMatchObject({statusCode:404});
 const job=await requestFeedbackExport(conn.db,config,admin,input);
 await expect(frozenFeedbackExportReports(conn.db,{ADMIN_WALLETS:[]},admin,job.jobId,storage)[Symbol.asyncIterator]().next()).rejects.toMatchObject({statusCode:404});
 const missing=request([f.rows[0]!.id,randomUUID()]);await expect(requestFeedbackExport(conn.db,config,admin,missing)).rejects.toMatchObject({statusCode:404});
 expect(await conn.db.select().from(feedbackExportJobs).where(eq(feedbackExportJobs.requestId,missing.requestId))).toHaveLength(0);
});
it('retains attachment markers and rechecks deletion before bytes; uncertainty propagates to writer',async()=>{
 const f=await fixture(),r=f.rows[0]!;const [m]=await conn.db.insert(feedbackMessages).values({reportId:r.id,author:f.wallet,visibility:'reporter',kind:'reply',body:'Screenshot',revision:2,reporterRevision:2,requestId:randomUUID(),context:{authorRole:'reporter'}}).returning();
 await conn.db.update(testerFeedback).set({revision:2,reporterRevision:2}).where(eq(testerFeedback.id,r.id));
 const hash=createHash('sha256').update('screenshot').digest('hex');
 const [a]=await conn.db.insert(feedbackAttachments).values({wallet:f.wallet,reportId:r.id,messageId:m!.id,requestId:randomUUID(),state:'attached',objectKey:`feedback/${randomUUID()}/${hash}.webp`,sha256:hash,byteLength:10,width:1,height:1,contentType:'image/webp',expiresAt:new Date()}).returning();
 const job=await requestFeedbackExport(conn.db,config,admin,request([r.id]));const [out]=await collect(job.jobId);expect(out!.attachments).toHaveLength(1);expect(out!.attachments[0]!.expired).toBe(false);
 storage.read.mockRejectedValueOnce(new Error('R2 unavailable'));await expect(out!.attachments[0]!.read()).rejects.toThrow('R2 unavailable');
 await conn.db.update(feedbackAttachments).set({state:'deleted'}).where(eq(feedbackAttachments.id,a!.id));
 expect(await out!.attachments[0]!.read()).toBeNull();expect((await collect(job.jobId))[0]!.attachments[0]!.expired).toBe(true);
});
it('fails closed on tampered snapshot and expired export instead of returning falsely complete data',async()=>{
 const f=await fixture(),job=await requestFeedbackExport(conn.db,config,admin,request([f.rows[0]!.id]));
 await conn.db.update(feedbackExportReports).set({snapshot:{body:'tampered'}}).where(eq(feedbackExportReports.jobId,job.jobId));await expect(collect(job.jobId)).rejects.toThrow('snapshot hash mismatch');
 await conn.db.update(feedbackExportJobs).set({expiresAt:new Date(0)}).where(eq(feedbackExportJobs.id,job.jobId));await expect(collect(job.jobId)).rejects.toMatchObject({statusCode:410});
});

it('keeps frozen canonical linkage and reviewed reward evidence after later relink/review without transport receipts',async()=>{
 const {feedbackIssueLinks,feedbackIssues}=await import('../src/db/schema');
 const {linkFeedbackReport}=await import('../src/game/feedbackIssueModeration');
 const {reviewFeedbackReward}=await import('../src/game/feedbackRewards');
 const f=await fixture(),report=f.rows[0]!;
 const [issue]=await conn.db.insert(feedbackIssues).values({title:'Reviewed canonical title',body:'Private draft summary',category:'bug',approvedBy:admin}).returning();
 const link=await linkFeedbackReport(conn.db,config,admin,report.id,{requestId:randomUUID(),issueId:issue!.id,expectedIssueRevision:1,expectedReportRevision:1,reason:'Grouped after identical reproduction'});
 await reviewFeedbackReward(conn.db,config,admin,report.id,{requestId:randomUUID(),expectedRevision:link.revision,status:'accepted',verdict:'actionable',award:'first_actionable',importance:'high',reason:'First actionable reproduction',verificationEvidence:'Reproduced in local renderer with archived orders'});
 const job=await requestFeedbackExport(conn.db,config,admin,request([report.id]));
 const before=await collect(job.jobId),exported=before[0]!;
 expect(exported.data['linkedIssue']).toMatchObject({id:issue!.id,revision:1,title:'Reviewed canonical title',publishedAt:null,linkReason:'Grouped after identical reproduction'});
 expect(exported.messages[0]!.context).toMatchObject({issueLink:{issueId:issue!.id,issueRevision:1}});
 expect(exported.messages[1]!.context).toMatchObject({review:{reason:'First actionable reproduction',verificationEvidence:'Reproduced in local renderer with archived orders',award:'first_actionable',verdict:'actionable',reportRevision:3}});
 expect(JSON.stringify(exported)).not.toContain('requestHash');expect(JSON.stringify(exported)).not.toContain('requestId');expect(JSON.stringify(exported)).not.toContain('"receipt"');
 await conn.db.update(feedbackIssues).set({title:'Changed later',revision:2}).where(eq(feedbackIssues.id,issue!.id));
 const [next]=await conn.db.insert(feedbackIssues).values({title:'Other reviewed issue',body:'Different problem',approvedBy:admin}).returning();
 const relink=await linkFeedbackReport(conn.db,config,admin,report.id,{requestId:randomUUID(),issueId:next!.id,expectedIssueRevision:1,expectedReportRevision:3,reason:'Different diagnosis after export'});
 await reviewFeedbackReward(conn.db,config,admin,report.id,{requestId:randomUUID(),expectedRevision:relink.revision,status:'reviewed',verdict:'unverified',award:'none',reason:'Review after export',verificationEvidence:'New evidence after snapshot'});
 expect(await collect(job.jobId)).toEqual(before);
 expect((await conn.db.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.reportId,report.id)))[0]!.issueId).toBe(next!.id);
});

it('exports the same fixed reports shown in the admin filter, including accepted rows and fixed precedence',async()=>{
 const {adminPageTesterFeedback}=await import('../src/game/tester');
 const f=await fixture(3);
 await conn.db.update(testerFeedback).set({status:'accepted',fixedAt:new Date()}).where(eq(testerFeedback.id,f.rows[0]!.id));
 await conn.db.update(testerFeedback).set({status:'reviewed',fixedAt:new Date()}).where(eq(testerFeedback.id,f.rows[1]!.id));
 const ids:string[]=[];let cursor:string|null=null;
 do{const page=await adminPageTesterFeedback(conn.db,config,admin,{status:'fixed',fixed:'false',...(cursor?{cursor}:{})});ids.push(...page.feedback.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
 const job=await requestFeedbackExport(conn.db,config,admin,{requestId:randomUUID(),format:'text',selection:{filter:{status:'fixed',fixed:false}}});
 const exported=await conn.db.select({id:feedbackExportReports.reportId}).from(feedbackExportReports).where(eq(feedbackExportReports.jobId,job.jobId));
 expect(new Set(exported.map(r=>r.id))).toEqual(new Set(ids));expect(ids).toContain(f.rows[0]!.id);expect(ids).toContain(f.rows[1]!.id);expect(ids).not.toContain(f.rows[2]!.id);
});
it('bounds queued exports under the same admin lock while exact lost-response retries remain available',async()=>{
 const {FEEDBACK_EXPORTS:limit}=await import('@shardkeep/shared/feedback');const f=await fixture(),input=request([f.rows[0]!.id]);
 const first=await requestFeedbackExport(conn.db,config,admin,input);
 const concurrent=await Promise.allSettled(Array.from({length:limit.maxActiveJobsPerAdmin},()=>requestFeedbackExport(conn.db,config,admin,request([f.rows[0]!.id]))));
 expect(concurrent.filter(r=>r.status==='fulfilled')).toHaveLength(limit.maxActiveJobsPerAdmin-1);
 expect(concurrent.filter(r=>r.status==='rejected')).toHaveLength(1);
 expect(await requestFeedbackExport(conn.db,config,admin,input)).toEqual(first);
});
