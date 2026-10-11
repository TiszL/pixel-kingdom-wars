/** Only curated public fields cross this boundary. Reports, conversations,
 * identities and attachments are private even when linked to a public issue. */
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_ISSUES as LIMIT } from '@shardkeep/shared/feedback';
import { and, asc, desc, eq, ilike, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Db, DbOrTx } from '../db/client';
import { feedbackConfirmations, feedbackIssueLinks, feedbackIssues, players, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';

// Drizzle unqualifies columns inside a single-table SELECT projection. Keep the
// correlated outer ID explicit so it cannot bind to a private report's inner ID.
const outerIssueId = sql`${sql.identifier('feedback_issues')}.${sql.identifier('id')}`;
const publicColumns = {
  id: feedbackIssues.id, title: feedbackIssues.title, summary: feedbackIssues.body,
  category: feedbackIssues.category, status: feedbackIssues.status,
  workaround: feedbackIssues.workaround, fixedRelease: feedbackIssues.fixedRelease,
  affectedPlayerCount: sql<number>`(select count(distinct affected.wallet)::int from (
    select ${testerFeedback.wallet} as wallet from ${feedbackIssueLinks}
      join ${testerFeedback} on ${testerFeedback.id} = ${feedbackIssueLinks.reportId}
      where ${feedbackIssueLinks.issueId} = ${outerIssueId}
    union all select ${feedbackConfirmations.wallet} as wallet from ${feedbackConfirmations}
      where ${feedbackConfirmations.issueId} = ${outerIssueId}
  ) affected)`,
};
const published = (now = new Date()) => and(isNotNull(feedbackIssues.publishedAt), lte(feedbackIssues.publishedAt, now),
  ne(feedbackIssues.status, 'merged'), isNull(feedbackIssues.mergedInto));
async function requireIssue(db: DbOrTx, id: string, now = new Date()) {
  const [issue] = await db.select(publicColumns).from(feedbackIssues).where(and(eq(feedbackIssues.id, id), published(now)));
  if (!issue) throw new HttpError(404, 'issue not found');
  return issue;
}
export async function getFeedbackIssue(db: Db, id: string) {
  // Curation and other visibility checks use the application clock. Keep every
  // hop and the final projection on that same instant, even if DB time differs.
  const now = new Date(), visibleAt = now.toISOString();
  // Every visible hop was explicitly published. The path guard fails closed
  // even if a future migration introduced a cycle; private drafts never resolve.
  const target = await db.execute<{ id: string }>(sql`with recursive canonical as (
    select id,merged_into,status,array[id] as path from feedback_issues where id=${id} and published_at <= ${visibleAt}::timestamptz
    union all select next.id,next.merged_into,next.status,c.path || next.id from canonical c
      join feedback_issues next on next.id=c.merged_into where next.published_at <= ${visibleAt}::timestamptz and not next.id=any(c.path)
  ) select id from canonical where merged_into is null and status <> 'merged' limit 1`);
  if (!target[0]) throw new HttpError(404, 'issue not found');
  return requireIssue(db, target[0].id, now);
}
/** A bounded first page/suggestion set, not an exhaustive catalogue export. */
export async function searchFeedbackIssues(db: Db, input: { query?: string; category?: string } = {}) {
  const query = (input.query ?? '').trim();
  if (query.length > LIMIT.queryMaxLen) throw new HttpError(400, 'issue search is too long');
  if (input.category !== undefined && !(TESTER_PROGRAM.feedback.categories as readonly string[]).includes(input.category)) {
    throw new HttpError(400, 'unknown feedback category');
  }
  const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, LIMIT.maxTerms);
  const matches = terms.flatMap(term => [ilike(feedbackIssues.title, `%${term}%`), ilike(feedbackIssues.body, `%${term}%`), ilike(feedbackIssues.workaround, `%${term}%`)]);
  const score = terms.length ? sql<number>`(${sql.join(terms.map(term => sql`(
    case when ${feedbackIssues.title} ilike ${`%${term}%`} then ${LIMIT.titleTermWeight} else 0 end +
    case when ${feedbackIssues.body} ilike ${`%${term}%`} then ${LIMIT.summaryTermWeight} else 0 end +
    case when ${feedbackIssues.workaround} ilike ${`%${term}%`} then ${LIMIT.workaroundTermWeight} else 0 end
  )`), sql` + `)})` : sql<number>`cast(0 as integer)`;
  // Filter and rank before limiting, so an older relevant issue cannot be hidden
  // behind a page of unrelated recently published issues.
  return db.select(publicColumns).from(feedbackIssues).where(and(published(),
    input.category === undefined ? undefined : eq(feedbackIssues.category, input.category),
    terms.length ? or(...matches) : undefined)).orderBy(desc(score), asc(feedbackIssues.id)).limit(LIMIT.resultLimit);
}
/** authenticatedWallet is taken from the verified session by the eventual route. */
export async function confirmFeedbackIssue(db: Db, authenticatedWallet: string, issueId: string) {
  return db.transaction(async tx => {
    const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, authenticatedWallet));
    if (!player) throw new HttpError(404, 'player not found');
    // Serializes against publishing/merging under the same issue row lock.
    const [issue] = await tx.select({ id: feedbackIssues.id, mergedInto: feedbackIssues.mergedInto }).from(feedbackIssues)
      .where(and(eq(feedbackIssues.id, issueId), isNotNull(feedbackIssues.publishedAt), lte(feedbackIssues.publishedAt, new Date()))).for('update');
    if (!issue) throw new HttpError(404, 'issue not found');
    if (issue.mergedInto) throw new HttpError(409, 'this issue was merged; reopen it to review the current summary before confirming', 'FEEDBACK_ISSUE_MERGED');
    await tx.insert(feedbackConfirmations).values({ issueId, wallet: authenticatedWallet }).onConflictDoNothing();
    return requireIssue(tx, issueId);
  });
}
