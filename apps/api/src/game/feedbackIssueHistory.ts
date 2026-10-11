/** Staff catalogue/history projections. Never reuse these DTOs publicly. */
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_ISSUES as LIMIT } from '@shardkeep/shared/feedback';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { HttpError } from '../lib/errors';
const Cursor = z.object({ t: z.number().int().nonnegative().safe(), i: z.string().uuid(), s: z.enum(['i', 'a', 'm']) }).strict();
export const FeedbackAdminIssueQuery = z.object({
  query: z.string().trim().max(LIMIT.queryMaxLen).optional(), category: z.enum(TESTER_PROGRAM.feedback.categories).optional(),
  published: z.enum(['true', 'false']).optional(), cursor: z.string().max(LIMIT.cursorMaxLen).optional(),
}).strict();
export const FeedbackIssueHistoryQuery = FeedbackAdminIssueQuery.pick({ cursor: true });
function decode(value: string | undefined) {
  if (value === undefined) return null;
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > LIMIT.cursorMaxLen) throw new Error('cursor');
    const cursor = Cursor.parse(JSON.parse(Buffer.from(value, 'base64url').toString('utf8')));
    if (!Number.isFinite(new Date(cursor.t).getTime())) throw new Error('date');
    return cursor;
  } catch { throw new HttpError(400, 'invalid issue cursor'); }
}
// Match cursor precision to the JS Date returned by the driver; UUID breaks
// same-millisecond ties without skipping PostgreSQL microsecond timestamps.
function encode(row: { createdAt: Date | string; id: string; source: 'i' | 'a' | 'm' }) {
  return Buffer.from(JSON.stringify({ t: new Date(row.createdAt).getTime(), i: row.id, s: row.source })).toString('base64url');
}
function adminOnly(config: Pick<Config, 'ADMIN_WALLETS'>, admin: string) {
  if (!config.ADMIN_WALLETS?.includes(admin)) throw new HttpError(404, 'issue not found');
}
export async function listAdminFeedbackIssues(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>, admin: string, raw: unknown = {}) {
  adminOnly(config, admin);
  const parsed = FeedbackAdminIssueQuery.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid issue filter');
  const input = parsed.data, cursor = decode(input.cursor);
  if (cursor && cursor.s !== 'i') throw new HttpError(400, 'invalid issue cursor');
  const terms = [...new Set(input.query?.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, LIMIT.maxTerms);
  const matches = terms.map(term => sql`(title ilike ${`%${term}%`} or body ilike ${`%${term}%`})`);
  // Match the application clock used to publish issues and expose public DTOs.
  const visibleAt = new Date().toISOString();
  const rows = await db.execute<{
    id: string; title: string; summary: string; category: string; status: string; workaround: string | null;
    fixedRelease: string | null; revision: number; publishedAt: Date | null; mergedInto: string | null;
    recurrenceOf: string | null; createdAt: Date | string;
  }>(sql`select id,title,body as summary,category,status,workaround,fixed_release as "fixedRelease",revision,
    published_at as "publishedAt",merged_into as "mergedInto",recurrence_of as "recurrenceOf",created_at as "createdAt"
    from feedback_issues where ${input.category ? sql`category=${input.category}` : sql`true`}
    and (${input.published === undefined ? sql`true` : input.published === 'true' ? sql`published_at is not null and published_at <= ${visibleAt}::timestamptz` : sql`published_at is null or published_at > ${visibleAt}::timestamptz`})
    and ${matches.length ? sql`(${sql.join(matches, sql` or `)})` : sql`true`}
    and ${cursor ? sql`(date_trunc('milliseconds',created_at),id) < (${new Date(cursor.t).toISOString()}::timestamptz,${cursor.i}::uuid)` : sql`true`}
    order by date_trunc('milliseconds',created_at) desc,id desc limit ${LIMIT.adminPageSize + 1}`);
  const page = rows.slice(0, LIMIT.adminPageSize), last = page.at(-1);
  return { issues: page, nextCursor: rows.length > LIMIT.adminPageSize && last ? encode({ ...last, source: 'i' }) : null };
}
export async function getAdminFeedbackIssueHistory(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>, admin: string, issueId: string, raw: unknown = {}) {
  adminOnly(config, admin);
  const input = FeedbackIssueHistoryQuery.safeParse(raw);
  if (!input.success || !z.string().uuid().safeParse(issueId).success) throw new HttpError(400, 'invalid issue history');
  const cursor = decode(input.data.cursor);
  if (cursor?.s === 'i') throw new HttpError(400, 'invalid history cursor');
  const exists = await db.execute(sql`select id from feedback_issues where id=${issueId}`);
  if (!exists.length) throw new HttpError(404, 'issue not found');
  const rows = await db.execute<{ id: string; action: string; reason: string; admin: string; createdAt: Date | string; receipt: unknown; source: 'a'|'m' }>(sql`
    select id,action,reason,admin,created_at as "createdAt",receipt,source from (
      select id,action,reason,admin,created_at,receipt,'a' as source from feedback_issue_actions where receipt->>'issueId'=${issueId} or receipt->>'targetIssueId'=${issueId}
      union all select id,'link' as action,context->>'reason' as reason,author as admin,created_at,context->'receipt' as receipt,'m' as source
      from feedback_messages where kind='status' and context->>'action'='issue-link' and context->'receipt'->>'issueId'=${issueId}
    ) events where ${cursor ? sql`(date_trunc('milliseconds',created_at),id,source) < (${new Date(cursor.t).toISOString()}::timestamptz,${cursor.i}::uuid,${cursor.s})` : sql`true`}
    order by date_trunc('milliseconds',created_at) desc,id desc,source desc limit ${LIMIT.adminPageSize + 1}`);
  const page = rows.slice(0, LIMIT.adminPageSize), last = page.at(-1);
  return { actions: page.map(({ source: _source, ...action }) => action), nextCursor: rows.length > LIMIT.adminPageSize && last ? encode(last) : null };
}

/** Direct draft-safe read for conflict recovery; never fall back to a title search. */
export async function getAdminFeedbackIssue(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>, admin: string, issueId: string) {
  adminOnly(config, admin);
  if (!z.string().uuid().safeParse(issueId).success) throw new HttpError(400, 'invalid issue ID');
  const rows = await db.execute(sql`select id,title,body as summary,category,status,workaround,fixed_release as "fixedRelease",revision,
    published_at as "publishedAt",merged_into as "mergedInto",recurrence_of as "recurrenceOf",created_at as "createdAt"
    from feedback_issues where id=${issueId}`);
  if (!rows[0]) throw new HttpError(404, 'issue not found');
  return rows[0];
}
