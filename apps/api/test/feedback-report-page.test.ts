import { randomUUID } from 'node:crypto';
import { FEEDBACK_ISSUES as LIMIT } from '@shardkeep/shared/feedback';
import { eq, sql } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackExportJobs, feedbackExportReports, feedbackIssueLinks, feedbackIssues, players, testerFeedback } from '../src/db/schema';
import { adminListTesterFeedback, adminPageTesterFeedback } from '../src/game/tester';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL);afterAll(async()=>{await conn.sql.end();});
async function fixture(){const admin=randomUUID(),wallet=randomUUID();await conn.db.insert(players).values([{wallet:admin},{wallet}]);const [issue]=await conn.db.insert(feedbackIssues).values({title:'Private classification',body:'Curated summary',approvedBy:admin}).returning();return{admin,wallet,config:{ADMIN_WALLETS:[admin]},issue:issue!};}
it('traverses more than200 issue-linked reports with exact revisions and no microsecond cursor gaps',async()=>{
 const f=await fixture(),count=LIMIT.adminPageSize*4+3;
 const reports=await conn.db.insert(testerFeedback).values(Array.from({length:count},(_,i)=>({wallet:f.wallet,category:'bug',title:'Report',body:'Details',revision:2,createdAt:sql`${i%2?'2026-01-01T12:00:00.123987Z':'2026-01-01T12:00:00.123123Z'}::timestamptz`}))).returning({id:testerFeedback.id});
 await conn.db.insert(feedbackIssueLinks).values(reports.map(r=>({reportId:r.id,issueId:f.issue.id,linkedBy:f.admin})));
 const ids:string[]=[];let cursor:string|null=null;
 do{const page=await adminPageTesterFeedback(conn.db,f.config,f.admin,{issueId:f.issue.id,...(cursor?{cursor}:{})});expect(page.feedback.every(r=>r.revision===2&&r.issueId===f.issue.id)).toBe(true);ids.push(...page.feedback.map(r=>r.id));cursor=page.nextCursor;}while(cursor);
 expect(ids).toHaveLength(count);expect(new Set(ids)).toEqual(new Set(reports.map(r=>r.id)));
 expect(await adminListTesterFeedback(conn.db,{},200,f.admin)).toHaveLength(200);
 await expect(adminPageTesterFeedback(conn.db,f.config,f.wallet,{})).rejects.toMatchObject({statusCode:404});
 await expect(adminPageTesterFeedback(conn.db,f.config,f.admin,{cursor:'!bad'})).rejects.toMatchObject({statusCode:400});
});
it('filters export status by current versus prepared revision, preserving legacy revision1 stamps',async()=>{
 const f=await fixture();const [report]=await conn.db.insert(testerFeedback).values({wallet:f.wallet,category:'bug',title:'Report',body:'Details',revision:3,exportedAt:new Date(),fixedAt:new Date()}).returning();
 await conn.db.insert(feedbackIssueLinks).values({reportId:report!.id,issueId:f.issue.id,linkedBy:f.admin});
 async function job(revision:number,prepared:boolean){const [j]=await conn.db.insert(feedbackExportJobs).values({requestedBy:f.admin,requestId:randomUUID(),requestHash:'hash',format:'json',schemaVersion:1,selection:{ids:[report!.id]},expiresAt:new Date('2099-01-01'),preparedAt:prepared?new Date():null,state:prepared?'ready':'preparing'}).returning();await conn.db.insert(feedbackExportReports).values({jobId:j!.id,reportId:report!.id,revision,snapshot:{},sha256:'0'.repeat(64)});return j!;}
 await job(2,true);const pending=await job(3,false);
 const unexported=await adminPageTesterFeedback(conn.db,f.config,f.admin,{issueId:f.issue.id,exported:'false',status:'fixed'});expect(unexported.feedback[0]).toMatchObject({id:report!.id,lastExportedRevision:2,exported:false,revision:3,fixed:true});
 expect((await adminPageTesterFeedback(conn.db,f.config,f.admin,{issueId:f.issue.id,exported:'true'})).feedback).toHaveLength(0);
 await conn.db.update(feedbackExportJobs).set({preparedAt:new Date(),state:'ready'}).where(eq(feedbackExportJobs.id,pending.id));
 expect((await adminPageTesterFeedback(conn.db,f.config,f.admin,{issueId:f.issue.id,exported:'true'})).feedback[0]).toMatchObject({lastExportedRevision:3,exported:true});
});
