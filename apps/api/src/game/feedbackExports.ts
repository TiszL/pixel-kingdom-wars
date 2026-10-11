/** Admin-only exports freeze report rows in one SQL statement. Conversations
 * are immutable and stream up to each frozen revision, never a live tail. */
import { createHash, randomUUID } from 'node:crypto';
import { FEEDBACK_CLIENTS, FEEDBACK_EXPORTS as LIMIT } from '@shardkeep/shared/feedback';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { and, asc, eq, gt, lte, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackAttachments, feedbackExportJobs, feedbackExportReports, feedbackMessages, feedbackRewardDecisions } from '../db/schema';
import { HttpError } from '../lib/errors';
import type { ExportAttachment, ExportMessage, ExportReport } from './feedbackExportFormat';
import type { FeedbackScreenshotStorage } from './feedbackStorage';
import { feedbackOriginSql } from './feedbackOrigin';

export const FeedbackExportFilter = z.object({
  status: z.enum(['new', 'reviewed', 'accepted', 'rejected', 'duplicate', 'fixed']).optional(),
  fixed: z.boolean().optional(), exported: z.boolean().optional(),
  category: z.enum(TESTER_PROGRAM.feedback.categories).optional(),
  /** "Android app only", the same inference as the admin list filter. */
  client: z.enum(FEEDBACK_CLIENTS).optional(),
}).strict();
export const FeedbackExportRequest = z.object({
  requestId: z.string().uuid(), format: z.enum(['text', 'json', 'zip']),
  selection: z.union([
    z.object({ ids: z.array(z.string().uuid()).min(1).max(LIMIT.maxArchiveEntries) }).strict(),
    z.object({ filter: FeedbackExportFilter }).strict(),
  ]),
}).strict();
export type FeedbackExportInput = z.infer<typeof FeedbackExportRequest>;
export interface FeedbackExportReceipt { jobId: string; format: 'text' | 'json' | 'zip'; reportCount: number; createdAt: string; expiresAt: string }
const adminOnly = (config: Pick<Config, 'ADMIN_WALLETS'>, wallet: string): void => {
  if (!config.ADMIN_WALLETS?.includes(wallet)) throw new HttpError(404, 'export not found');
};
/** Used by paginated admin lists as well as selection. A preparation or download
 * request alone does not mark a report exported. Legacy stamps remain revision1. */
export function feedbackLastExportedRevision(reportId: SQL, legacyStamp: SQL): SQL<number> {
  return sql<number>`greatest(coalesce((select max(er.revision) from feedback_export_reports er
    inner join feedback_export_jobs ej on ej.id=er.job_id
    where er.report_id=${reportId} and ej.prepared_at is not null),0),case when ${legacyStamp} is not null then 1 else 0 end)`;
}
function selectionWhere(selection: FeedbackExportInput['selection']): SQL {
  if ('ids' in selection) return sql`r.trashed_at is null and r.id in (select value::uuid from jsonb_array_elements_text(${JSON.stringify(selection.ids)}::jsonb))`;
  const f = selection.filter, clauses: SQL[] = [sql`r.trashed_at is null`];
  if (f.status && f.status !== 'fixed') clauses.push(sql`r.status=${f.status} and r.fixed_at is null`);
  if (f.category) clauses.push(sql`r.category=${f.category}`);
  if (f.client) clauses.push(sql`${feedbackOriginSql(sql`r.context`)}=${f.client}`);
  if (f.status === 'fixed' || f.fixed === true) clauses.push(sql`r.fixed_at is not null`);
  else if (f.fixed === false) clauses.push(sql`r.fixed_at is null`);
  if (f.exported !== undefined) {
    const exported = feedbackLastExportedRevision(sql`r.id`, sql`r.exported_at`);
    clauses.push(f.exported ? sql`${exported}>=r.revision` : sql`${exported}<r.revision`);
  }
  return clauses.length ? sql.join(clauses, sql` and `) : sql`true`;
}
export async function requestFeedbackExport(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>,
  admin: string, raw: FeedbackExportInput, now = new Date()): Promise<FeedbackExportReceipt> {
  adminOnly(config, admin);
  const parsed = FeedbackExportRequest.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid export selection');
  const input = parsed.data;
  if ('ids' in input.selection) input.selection.ids = [...new Set(input.selection.ids)].sort();
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-export:${admin}`},0))`);
    const [prior] = await tx.select().from(feedbackExportJobs).where(and(eq(feedbackExportJobs.requestedBy,admin),eq(feedbackExportJobs.requestId,input.requestId)));
    if (prior) {
      if (prior.requestHash !== hash) throw new HttpError(409, 'export request changed', 'FEEDBACK_EXPORT_CONFLICT');
      const [countRow] = await tx.select({ count: sql<number>`count(*)::int` }).from(feedbackExportReports).where(eq(feedbackExportReports.jobId,prior.id));
      const count = countRow!.count;
      return { jobId: prior.id, format: input.format, reportCount: count, createdAt: prior.createdAt.toISOString(), expiresAt: prior.expiresAt.toISOString() };
    }
    const [limits] = await tx.select({
      active: sql<number>`count(*) filter (where state in ('pending','preparing') and expires_at>${now.toISOString()}::timestamptz)::int`,
      recent: sql<number>`count(*) filter (where created_at>${new Date(now.getTime()-3600000).toISOString()}::timestamptz)::int`,
    }).from(feedbackExportJobs).where(eq(feedbackExportJobs.requestedBy,admin));
    if (limits!.active >= LIMIT.maxActiveJobsPerAdmin || limits!.recent >= LIMIT.maxRequestsPerHour) {
      throw new HttpError(429, 'Export preparation limit reached. Wait for existing exports or retry later.', 'FEEDBACK_EXPORT_LIMIT');
    }
    const jobId = randomUUID(), expiresAt = new Date(now.getTime()+LIMIT.retentionHours*3600000);
    await tx.insert(feedbackExportJobs).values({ id:jobId, requestedBy:admin, requestId:input.requestId, requestHash:hash,
      format:input.format, schemaVersion:LIMIT.schemaVersion, selection:input.selection, expiresAt, createdAt:now });
    // One statement sees the same committed database snapshot for every row;
    // explicit fields exclude private transport receipts and future secrets.
    await tx.execute(sql`insert into feedback_export_reports(job_id,report_id,revision,snapshot,sha256)
      select ${jobId}::uuid,id,revision,snapshot,encode(sha256(convert_to(snapshot::text,'UTF8')),'hex') from (
        select r.id,r.revision,jsonb_build_object(
          'id',r.id,'revision',r.revision,'wallet',r.wallet,'name',p.name,'category',r.category,'title',r.title,'body',r.body,
          'context',r.context,'status',case when r.fixed_at is not null then 'fixed' else r.status::text end,'importance',r.importance,'rewardPolicyVersion',r.reward_policy_version,
          'basePoints',r.base_points,'bonusPoints',r.bonus_points,'points',r.points,'adminNote',r.admin_note,
          'reviewedBy',r.reviewed_by,'createdAt',r.created_at,'reviewedAt',r.reviewed_at,'fixedAt',r.fixed_at,
          'fixedRef',r.fixed_ref,'exportedAt',r.exported_at,'lockedAt',r.locked_at,'closedAt',r.closed_at,
          'linkedIssue',(select jsonb_build_object('id',i.id,'revision',i.revision,'title',i.title,'summary',i.body,
            'category',i.category,'status',i.status,'workaround',i.workaround,'fixedRelease',i.fixed_release,
            'publishedAt',i.published_at,'mergedInto',i.merged_into,'recurrenceOf',i.recurrence_of,
            'linkedBy',l.linked_by,'linkReason',l.reason,'linkedAt',l.created_at)
            from feedback_issue_links l inner join feedback_issues i on i.id=l.issue_id where l.report_id=r.id)
        ) as snapshot from tester_feedback r inner join players p on p.wallet=r.wallet
        where ${selectionWhere(input.selection)} order by r.id limit ${LIMIT.maxArchiveEntries+1}
      ) frozen`);
    const [countRow] = await tx.select({count:sql<number>`count(*)::int`}).from(feedbackExportReports).where(eq(feedbackExportReports.jobId,jobId));
    const count = countRow!.count;
    if (count > LIMIT.maxArchiveEntries) throw new HttpError(413, 'export too large; narrow the filter', 'FEEDBACK_EXPORT_TOO_LARGE');
    if ('ids' in input.selection && count !== input.selection.ids.length) throw new HttpError(404, 'one or more reports no longer exist');
    return {jobId,format:input.format,reportCount:count!,createdAt:now.toISOString(),expiresAt:expiresAt.toISOString()};
  });
}

const pick = (data: Record<string,unknown>, keys: string[]): Record<string,unknown> =>
  Object.fromEntries(keys.filter(key=>Object.hasOwn(data,key)).map(key=>[key,data[key]]));

async function* messages(db: Db, reportId: string, revision: number): AsyncIterable<ExportMessage> {
  let after = 0;
  for (;;) {
    const page = await db.select({ message:feedbackMessages, review:feedbackRewardDecisions }).from(feedbackMessages)
      .leftJoin(feedbackRewardDecisions,and(eq(feedbackRewardDecisions.reportId,feedbackMessages.reportId),eq(feedbackRewardDecisions.reportRevision,feedbackMessages.revision))).where(and(eq(feedbackMessages.reportId,reportId),gt(feedbackMessages.revision,after),lte(feedbackMessages.revision,revision)))
      .orderBy(asc(feedbackMessages.revision)).limit(LIMIT.pageSize);
    for (const {message:row,review} of page) {
      const context = row.context as Record<string,unknown> | null;
      // No request IDs, request hashes or embedded moderation receipts. Private
      // status reasons/evidence are retained, but never exposed as a public DTO.
      const { requestHash: _hash, receipt: storedReceipt, ...safeContext } = context ?? {};
      const receipt = storedReceipt as Record<string,unknown> | null;
      if (context?.['action']==='issue-link' && receipt) safeContext['issueLink'] = pick(receipt,['issueId','issueRevision','awardClaims']);
      if (context?.['action']==='screenshot-preservation' && receipt) safeContext['preservation'] = pick(receipt,['attachmentId','preserved']);
      if (review) safeContext['review'] = { id:review.id, admin:review.admin, policyVersion:review.policyVersion,
        reportRevision:review.reportRevision, reason:review.reason, createdAt:review.createdAt.toISOString(),
        ...pick(review.receipt as Record<string,unknown>,['issueId','status','verdict','award','basePoints','bonusPoints','points','delta','createdDay','verificationEvidence']) };
      yield {id:row.id,revision:row.revision,body:row.body??'',visibility:row.visibility,kind:row.kind,
        author:row.author,authorRole:context?.['authorRole']==='reporter'?'reporter':'admin',createdAt:row.createdAt.toISOString(),context:safeContext};
      after=row.revision;
    }
    if (page.length<LIMIT.pageSize) return;
  }
}
async function* attachments(db: Db, reportId: string, revision: number, storage: Pick<FeedbackScreenshotStorage,'read'>): AsyncIterable<ExportAttachment> {
  let after: string | undefined;
  for (;;) {
    const page = await db.select({ attachment:feedbackAttachments }).from(feedbackAttachments)
      .innerJoin(feedbackMessages,and(eq(feedbackMessages.reportId,feedbackAttachments.reportId),eq(feedbackMessages.id,feedbackAttachments.messageId)))
      .where(and(eq(feedbackAttachments.reportId,reportId),lte(feedbackMessages.revision,revision),after?gt(feedbackAttachments.id,after):undefined))
      .orderBy(asc(feedbackAttachments.id)).limit(LIMIT.pageSize);
    for (const {attachment:a} of page) {
      if (!a.messageId || !a.sha256 || !a.objectKey) throw new Error('Incomplete attached screenshot metadata');
      const key=a.objectKey;
      yield {id:a.id,messageId:a.messageId,sha256:a.sha256,expired:a.state==='deleted'||a.state==='deleting',read:async()=>{
        // Retention may act after this page was fetched; never restore evidence
        // marked expired, and let uncertain storage reads fail the whole job.
        const [current]=await db.select({state:feedbackAttachments.state}).from(feedbackAttachments).where(eq(feedbackAttachments.id,a.id));
        if (!current || current.state==='deleted'||current.state==='deleting') return null;
        return storage.read(key);
      }};
      after=a.id;
    }
    if(page.length<LIMIT.pageSize)return;
  }
}
export async function* frozenFeedbackExportReports(db: Db, config: Pick<Config,'ADMIN_WALLETS'>,
  admin: string, jobId: string, storage: Pick<FeedbackScreenshotStorage,'read'>): AsyncIterable<ExportReport> {
  adminOnly(config,admin);
  const [job]=await db.select().from(feedbackExportJobs).where(eq(feedbackExportJobs.id,jobId));
  if(!job)throw new HttpError(404,'export not found');
  if(job.expiresAt<=new Date() || ['deleting','deleted'].includes(job.state))throw new HttpError(410,'export expired');
  let after: string|undefined;
  for (;;) {
    const page=await db.select({row:feedbackExportReports,valid:sql<boolean>`encode(sha256(convert_to(${feedbackExportReports.snapshot}::text,'UTF8')),'hex')=${feedbackExportReports.sha256}`})
      .from(feedbackExportReports).where(and(eq(feedbackExportReports.jobId,jobId),after?gt(feedbackExportReports.reportId,after):undefined))
      .orderBy(asc(feedbackExportReports.reportId)).limit(LIMIT.pageSize);
    for(const {row,valid} of page){
      if(!valid)throw new Error('Frozen feedback snapshot hash mismatch');
      yield {id:row.reportId,revision:row.revision,data:row.snapshot as Record<string,unknown>,messages:messages(db,row.reportId,row.revision),attachments:attachments(db,row.reportId,row.revision,storage)};
      after=row.reportId;
    }
    if(page.length<LIMIT.pageSize)return;
  }
}
