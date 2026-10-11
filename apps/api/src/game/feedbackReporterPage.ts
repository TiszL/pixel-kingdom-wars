/** Reporter-only history. Internal revisions and staff notes never affect the
 * projection, unread state or pagination key. Legacy history stays unchanged. */
import { createHash } from 'node:crypto';
import { FEEDBACK_THREADS as LIMIT } from '@shardkeep/shared/feedback';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/client';
import { HttpError } from '../lib/errors';
// Installed native campaign pickers send the packed page size; omission retains the same fixed-size page.
export const FeedbackReporterPageQuery=z.object({cursor:z.string().max(LIMIT.reportCursorMaxLen).optional(),limit:z.literal(String(LIMIT.pageSize)).optional()}).strict();
const Cursor=z.object({v:z.literal(1),mode:z.literal('reporter'),wallet:z.string().regex(/^[0-9a-f]{64}$/),t:z.number().int().nonnegative().safe(),id:z.string().uuid()}).strict();
const fingerprint=(wallet:string)=>createHash('sha256').update(wallet).digest('hex');
function decode(value:string|undefined,wallet:string){
 if(value===undefined)return null;
 try{
  if(!/^[A-Za-z0-9_-]+$/.test(value))throw new Error('cursor');
  const parsed=Cursor.parse(JSON.parse(Buffer.from(value,'base64url').toString('utf8')));
  if(parsed.wallet!==fingerprint(wallet)||!Number.isFinite(new Date(parsed.t).getTime()))throw new Error('cursor');
  return parsed;
 }catch{throw new HttpError(400,'invalid reporter feedback cursor');}
}
export interface FeedbackReporterPageRow extends Record<string,unknown> {
 id:string;category:string;title:string;body:string;status:string;importance:string|null;
 rewardPolicyVersion:number;revision:number;reporterRevision:number;unread:boolean;points:number;
 createdAt:Date|string;reviewedAt:Date|string|null;fixedAt:Date|string|null;fixedRef:string|null;
}
export async function listReporterFeedbackPage(db:Db,wallet:string,raw:unknown={}){
 const input=FeedbackReporterPageQuery.safeParse(raw);if(!input.success)throw new HttpError(400,'invalid reporter feedback query');
 const cursor=decode(input.data.cursor,wallet);
 // Millisecond ordering exactly matches JS cursor precision. UUID resolves
 // ties, including PostgreSQL timestamps with distinct microseconds.
 const rows=await db.execute<FeedbackReporterPageRow>(sql`select f.id,f.category,f.title,f.body,case when f.fixed_at is not null then 'fixed' else f.status::text end as status,f.importance,
  f.reward_policy_version as "rewardPolicyVersion",f.reporter_revision as revision,f.reporter_revision as "reporterRevision",
  exists(select 1 from feedback_messages m left join feedback_readers r on r.report_id=m.report_id and r.reader=${`reporter:${wallet}`}
   where m.report_id=f.id and m.author<>${wallet} and m.visibility='reporter' and m.reporter_revision>coalesce(r.revision,0)) as unread,
  f.points,f.created_at as "createdAt",f.reviewed_at as "reviewedAt",f.fixed_at as "fixedAt",f.fixed_ref as "fixedRef"
  from tester_feedback f where f.wallet=${wallet} and f.trashed_at is null
   and ${cursor?sql`(date_trunc('milliseconds',f.created_at),f.id)<(${new Date(cursor.t).toISOString()}::timestamptz,${cursor.id}::uuid)`:sql`true`}
  order by date_trunc('milliseconds',f.created_at) desc,f.id desc limit ${LIMIT.pageSize+1}`);
 const page=rows.slice(0,LIMIT.pageSize),last=page.at(-1);
 const nextCursor=rows.length>LIMIT.pageSize&&last?Buffer.from(JSON.stringify({v:1,mode:'reporter',wallet:fingerprint(wallet),t:new Date(last.createdAt).getTime(),id:last.id})).toString('base64url'):null;
 // Raw db.execute timestamps are PostgreSQL strings, unlike typed Drizzle Date columns. Native readers require ISO UTC.
 return{feedback:page.map(row=>({...row,createdAt:new Date(row.createdAt).toISOString(),
  reviewedAt:row.reviewedAt===null?null:new Date(row.reviewedAt).toISOString(),
  fixedAt:row.fixedAt===null?null:new Date(row.fixedAt).toISOString()})),nextCursor};
}
