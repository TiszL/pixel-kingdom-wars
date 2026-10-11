import { randomUUID } from 'node:crypto';
import { FEEDBACK_ISSUES as LIMIT } from '@shardkeep/shared/feedback';
import { eq, sql } from 'drizzle-orm';
import { afterAll, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackConfirmations, feedbackIssueLinks, feedbackIssues, players, testerFeedback } from '../src/db/schema';
import { confirmFeedbackIssue, getFeedbackIssue, searchFeedbackIssues } from '../src/game/feedbackIssues';
import { curateFeedbackIssue } from '../src/game/feedbackIssueModeration';
import { listAdminFeedbackIssues } from '../src/game/feedbackIssueHistory';
import { TEST_DATABASE_URL } from './db-url';
const conn=createDb(TEST_DATABASE_URL);
afterAll(async()=>{await conn.sql.end();});
async function issue(values:Partial<typeof feedbackIssues.$inferInsert>={}) {
 const [row]=await conn.db.insert(feedbackIssues).values({title:'Curated title',body:'Safe description',approvedBy:'private-admin-id',publishedAt:new Date(),...values}).returning();return row!;
}
async function wallet(){const id=randomUUID();await conn.db.insert(players).values({wallet:id});return id;}
it.each([-30_000, 30_000])('keeps every publication gate on the curation clock when it differs from DB time by %sms', async offset => {
 const admin=await wallet(),config={ADMIN_WALLETS:[admin]},query=`clock${randomUUID().replaceAll('-','')}`;
 const [clock]=await conn.db.execute<{ms:string}>(sql`select extract(epoch from clock_timestamp())*1000 as ms`);
 const now=Number(clock!.ms)+offset;
 vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(now);
 try {
  const published=await curateFeedbackIssue(conn.db,config,admin,{requestId:randomUUID(),title:query,summary:'Reviewed public summary',category:'bug',workaround:null,fixedRelease:null,status:'open',published:true,reason:'Private approval'});
  expect(published.publishedAt).toBe(new Date().toISOString());
  expect.soft((await searchFeedbackIssues(conn.db,{query})).map(i=>i.id)).toEqual([published.issueId]);
  await expect.soft(getFeedbackIssue(conn.db,published.issueId)).resolves.toMatchObject({id:published.issueId});
  expect.soft((await listAdminFeedbackIssues(conn.db,config,admin,{query,published:'true'})).issues.map(i=>i.id)).toEqual([published.issueId]);
  expect.soft((await listAdminFeedbackIssues(conn.db,config,admin,{query,published:'false'})).issues).toEqual([]);
  // A database clock ahead of the app must not make a future merged URL public.
  const future=await issue({title:query,publishedAt:new Date(now+15_000),status:'merged',mergedInto:published.issueId});
  await expect.soft(getFeedbackIssue(conn.db,future.id)).rejects.toMatchObject({statusCode:404});
  await expect.soft(confirmFeedbackIssue(conn.db,admin,future.id)).rejects.toMatchObject({statusCode:404});
  expect.soft((await listAdminFeedbackIssues(conn.db,config,admin,{query,published:'false'})).issues.map(i=>i.id)).toEqual([future.id]);
  // A published URL cannot bypass a future intermediate hop or final target.
  const ancestor=await issue({status:'merged',mergedInto:future.id});
  await expect.soft(getFeedbackIssue(conn.db,ancestor.id)).rejects.toMatchObject({statusCode:404});
  const futureTarget=await issue({publishedAt:new Date(now+15_000)});
  const visibleSource=await issue({status:'merged',mergedInto:futureTarget.id});
  await expect.soft(getFeedbackIssue(conn.db,visibleSource.id)).rejects.toMatchObject({statusCode:404});
 } finally {vi.useRealTimers();}
});
it('public DTOs include only curated fields and never raw reports, identities or private notes',async()=>{
 const row=await issue();const who=await wallet();
 const [report]=await conn.db.insert(testerFeedback).values({wallet:who,category:'bug',title:'private title',body:'private body',adminNote:'private note',context:{token:'private context'}}).returning();
 await conn.db.insert(feedbackIssueLinks).values({reportId:report!.id,issueId:row.id,linkedBy:'private-link-admin',reason:'private evidence'});
 const dto=await getFeedbackIssue(conn.db,row.id);
 expect(Object.keys(dto).sort()).toEqual(['affectedPlayerCount','category','fixedRelease','id','status','summary','title','workaround']);
 expect(dto.affectedPlayerCount).toBe(1);
 for(const secret of ['private body','private note','private context','private-admin-id',who,report!.id]) expect(JSON.stringify(dto)).not.toContain(secret);
});
it('private issues stay hidden; old merged links resolve approved targets but require fresh confirmation',async()=>{
 const who=await wallet(); const target=await issue();
 for(const row of [await issue({publishedAt:null}),await issue({publishedAt:new Date('2099-01-01')}),await issue({status:'merged',mergedInto:target.id})]) {
  // Owner-approved merge behavior: GET preserves old public links by returning
  // the approved target; mutations must still target the newly reviewed issue.
  if(row.mergedInto) expect(await getFeedbackIssue(conn.db,row.id)).toEqual(await getFeedbackIssue(conn.db,target.id));
  else await expect(getFeedbackIssue(conn.db,row.id)).rejects.toMatchObject({statusCode:404});
  await expect(confirmFeedbackIssue(conn.db,who,row.id)).rejects.toMatchObject({statusCode:row.mergedInto?409:404});
  expect((await searchFeedbackIssues(conn.db)).some(i=>i.id===row.id)).toBe(false);
 }
});
it('distinct affected wallets union linked reporters and concurrent confirmations without awarding points',async()=>{
 const row=await issue();const who=await wallet();const other=await wallet();
 const reports=await conn.db.insert(testerFeedback).values([1,2].map(()=>({wallet:who,category:'bug',title:'duplicate evidence',body:'private',points:10,basePoints:10,rewardPolicyVersion:1}))).returning();
 await conn.db.insert(feedbackIssueLinks).values(reports.map(r=>({reportId:r.id,issueId:row.id,linkedBy:'admin'})));
 const results=await Promise.all(Array.from({length:4},()=>confirmFeedbackIssue(conn.db,who,row.id)));
 expect(results.every(r=>r.affectedPlayerCount===1)).toBe(true);
 expect(await conn.db.select().from(feedbackConfirmations).where(eq(feedbackConfirmations.issueId,row.id))).toHaveLength(1);
 expect((await confirmFeedbackIssue(conn.db,other,row.id)).affectedPlayerCount).toBe(2);
 expect((await conn.db.select().from(testerFeedback).where(eq(testerFeedback.wallet,who))).map(r=>r.points)).toEqual([10,10]);
 await expect(confirmFeedbackIssue(conn.db,randomUUID(),row.id)).rejects.toMatchObject({statusCode:404});
});
it('filters and ranks all matching curated issues before the bounded limit with deterministic ties',async()=>{
 const marker=`unique${randomUUID().replaceAll('-','')}`;
 const titleMatch=await issue({title:`${marker} wall`,category:'bug',createdAt:new Date('2020-01-01')});
 await conn.db.insert(feedbackIssues).values(Array.from({length:LIMIT.resultLimit+5},()=>({title:'unrelated',body:'unrelated',approvedBy:'admin',publishedAt:new Date()})));
 const bodyMatch=await issue({title:'Different title',body:`${marker} wall`,category:'bug'});
 await issue({title:`${marker} wall`,category:'idea'});
 const result=await searchFeedbackIssues(conn.db,{query:marker,category:'bug'});
 expect(result.map(r=>r.id)).toEqual([titleMatch.id,bodyMatch.id]);
 expect(await searchFeedbackIssues(conn.db,{query:marker,category:'bug'})).toEqual(result);
 expect((await searchFeedbackIssues(conn.db)).length).toBe(LIMIT.resultLimit);
 await expect(searchFeedbackIssues(conn.db,{query:'x'.repeat(LIMIT.queryMaxLen+1)})).rejects.toMatchObject({statusCode:400});
 await expect(searchFeedbackIssues(conn.db,{category:'invalid'})).rejects.toMatchObject({statusCode:400});
});
