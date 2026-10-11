/** Private thread access. Actor mode comes from the route, admin membership from
 * server configuration; neither a client-supplied wallet nor role grants access. */
import { FEEDBACK_THREADS as LIMIT, FEEDBACK_SCREENSHOTS } from '@shardkeep/shared/feedback';
import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db, DbTx, DbOrTx } from '../db/client';
import { feedbackAttachments, feedbackIssueLinks, feedbackIssues, feedbackMessages, feedbackReaders, feedbackRewardDecisions, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';
import { bindFeedbackScreenshots, feedbackAttachmentDto } from './feedbackAttachments';
import { FeedbackClientOriginContext, type FeedbackClientOrigin } from './feedbackOrigin';

export interface FeedbackActor { wallet: string; mode: 'reporter' | 'admin' }
type Access = Pick<Config, 'ADMIN_WALLETS'>;
type Message = typeof feedbackMessages.$inferSelect;
function authorizeAdmin(config: Access, actor: FeedbackActor) {
  if (actor.mode !== 'reporter' && actor.mode !== 'admin') throw new HttpError(403, 'feedback access denied');
  if (actor.mode === 'admin' && !config.ADMIN_WALLETS?.includes(actor.wallet)) throw new HttpError(404, 'feedback not found');
}
export async function lockFeedbackReport(tx: DbTx, config: Access, actor: FeedbackActor, id: string, options: { allowTrashed?: boolean } = {}) {
  authorizeAdmin(config, actor);
  const [row] = await tx.select().from(testerFeedback).where(and(eq(testerFeedback.id, id),
    actor.mode === 'reporter' ? eq(testerFeedback.wallet, actor.wallet) : undefined)).for('update');
  if (!row) throw new HttpError(404, 'feedback not found');
  if (row.trashedAt && !(actor.mode === 'admin' && options.allowTrashed)) {
    if (actor.mode === 'reporter') throw new HttpError(404, 'feedback not found');
    throw new HttpError(409, 'restore this report before changing it', 'FEEDBACK_REPORT_TRASHED');
  }
  return row;
}
function visible(actor: FeedbackActor) { return actor.mode === 'reporter' ? eq(feedbackMessages.visibility, 'reporter') : undefined; }
function sequence(actor: FeedbackActor) { return actor.mode === 'reporter' ? feedbackMessages.reporterRevision : feedbackMessages.revision; }
function readerKey(actor: FeedbackActor) { return `${actor.mode}:${actor.wallet}`; }
function messageDto(row: Message, actor: FeedbackActor) {
  // Context, request IDs and admin wallet identities never enter reporter DTOs.
  return { id: row.id, revision: actor.mode === 'reporter' ? row.reporterRevision! : row.revision, body: row.body, kind: row.kind,
    visibility: row.visibility, authorRole: (row.context as { authorRole?: string } | null)?.authorRole === 'reporter' ? 'reporter' : 'admin',
    createdAt: row.createdAt, ...(actor.mode === 'admin' ? { author: row.author } : {}) };
}
function attachmentIds(value: string[] | undefined) {
  const ids = value ?? [];
  if (!Array.isArray(ids) || ids.length > FEEDBACK_SCREENSHOTS.maxPerMessage || new Set(ids).size !== ids.length
    || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new HttpError(400, 'invalid screenshot selection');
  }
  return ids;
}
async function messageWithAttachments(tx: DbTx, row: Message, actor: FeedbackActor, loaded?: (typeof feedbackAttachments.$inferSelect)[]) {
  const rows = loaded ?? await tx.select().from(feedbackAttachments).where(and(eq(feedbackAttachments.reportId, row.reportId), eq(feedbackAttachments.messageId, row.id)));
  const ids = (row.context as { attachmentIds?: string[] } | null)?.attachmentIds ?? [];
  return { ...messageDto(row, actor), attachments: ids.flatMap(id => { const item = rows.find(r => r.id === id); return item ? [feedbackAttachmentDto(item, actor.mode)] : []; }) };
}
function cursor(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, 'invalid feedback revision');
}
export interface FeedbackThreadPage { afterRevision?: number | undefined; beforeRevision?: number | undefined }
/** Default is the newest page. Explicit after=0 retains oldest-first traversal. */
export async function getFeedbackThread(db: Db, config: Access, actor: FeedbackActor, reportId: string, pagination: FeedbackThreadPage | number = {}) {
  const query = typeof pagination === 'number' ? { afterRevision: pagination } : pagination;
  if (query.afterRevision !== undefined) cursor(query.afterRevision);
  if (query.beforeRevision !== undefined) cursor(query.beforeRevision);
  if (query.afterRevision !== undefined && query.beforeRevision !== undefined) throw new HttpError(400, 'choose either earlier or newer feedback messages');
  return db.transaction(async (tx) => {
    const report = await lockFeedbackReport(tx, config, actor, reportId, { allowTrashed: true });
    const backwards = query.afterRevision === undefined;
    const rows = await tx.select().from(feedbackMessages).where(and(eq(feedbackMessages.reportId, reportId), visible(actor),
      query.afterRevision === undefined ? undefined : gt(sequence(actor), query.afterRevision),
      query.beforeRevision === undefined ? undefined : lt(sequence(actor), query.beforeRevision)))
      .orderBy(backwards ? desc(sequence(actor)) : asc(sequence(actor))).limit(LIMIT.pageSize);
    const page = backwards ? rows.reverse() : rows;
    const latestRevision = actor.mode === 'reporter' ? report.reporterRevision : report.revision;
    const boundary = query.afterRevision ?? query.beforeRevision ?? latestRevision;
    const oldestRevision = page.length ? messageDto(page[0]!, actor).revision : boundary;
    const nextRevision = page.length ? messageDto(page.at(-1)!, actor).revision : boundary;
    const [earlier] = await tx.select({ id: feedbackMessages.id }).from(feedbackMessages)
      .where(and(eq(feedbackMessages.reportId, reportId), visible(actor), lt(sequence(actor), oldestRevision))).limit(1);
    const [newer] = await tx.select({ id: feedbackMessages.id }).from(feedbackMessages)
      .where(and(eq(feedbackMessages.reportId, reportId), visible(actor), gt(sequence(actor), nextRevision))).limit(1);
    const [reader] = await tx.select({ revision: feedbackReaders.revision }).from(feedbackReaders)
      .where(and(eq(feedbackReaders.reportId, reportId), eq(feedbackReaders.reader, readerKey(actor))));
    const [unread] = await tx.select({ id: feedbackMessages.id }).from(feedbackMessages).where(and(
      eq(feedbackMessages.reportId, reportId), visible(actor), ne(feedbackMessages.author, actor.wallet),
      gt(sequence(actor), reader?.revision ?? 0))).limit(1);
    const screenshots = page.length ? await tx.select().from(feedbackAttachments).where(and(eq(feedbackAttachments.reportId, reportId), inArray(feedbackAttachments.messageId, page.map(row => row.id)))) : [];
    const [linkedIssue] = actor.mode === 'admin' ? await tx.select({
      id: feedbackIssues.id, title: feedbackIssues.title, revision: feedbackIssues.revision, status: feedbackIssues.status,
      publishedAt: feedbackIssues.publishedAt, mergedInto: feedbackIssues.mergedInto,
    }).from(feedbackIssueLinks).innerJoin(feedbackIssues, eq(feedbackIssues.id, feedbackIssueLinks.issueId))
      .where(eq(feedbackIssueLinks.reportId, reportId)) : [];
    const [latestReview] = actor.mode === 'admin' ? await tx.select({ receipt: feedbackRewardDecisions.receipt })
      .from(feedbackRewardDecisions).where(eq(feedbackRewardDecisions.reportId, reportId))
      .orderBy(desc(feedbackRewardDecisions.reportRevision)).limit(1) : [];
    return { report: { id: report.id, category: report.category, title: report.title, body: report.body,
      status: report.fixedAt !== null ? 'fixed' : report.status, importance: report.importance, points: report.points, adminNote: report.adminNote,
      createdAt: report.createdAt, fixedAt: report.fixedAt, fixedRef: report.fixedRef,
      locked: report.lockedAt !== null, closed: report.closedAt !== null,
      ...(actor.mode === 'admin' ? { wallet: report.wallet, context: report.context, revision: report.revision,
        rewardPolicyVersion: report.rewardPolicyVersion, basePoints: report.basePoints, bonusPoints: report.bonusPoints,
        verificationVerdict: (latestReview?.receipt as { verdict?: string } | undefined)?.verdict ?? 'unverified',
        trashed: report.trashedAt !== null, trashedAt: report.trashedAt, linkedIssue: linkedIssue ?? null } : {}) },
      messages: await Promise.all(page.map(row => messageWithAttachments(tx, row, actor, screenshots.filter(image => image.messageId === row.id)))), hasMore: !!newer, hasEarlier: !!earlier,
      oldestRevision, nextRevision, latestRevision, readRevision: reader?.revision ?? 0, unread: !!unread };
  });
}
export async function appendFeedbackReply(db: DbOrTx, config: Access, actor: FeedbackActor, reportId: string,
  input: { requestId: string; body: string; visibility?: 'reporter' | 'admin'; attachmentIds?: string[];
    /** Header-derived display label; never compared on replay, never from a body. */
    origin?: FeedbackClientOrigin | undefined }) {
  authorizeAdmin(config, actor);
  const body = input.body.trim(); const visibility = input.visibility ?? 'reporter';
  const ids = attachmentIds(input.attachmentIds);
  if ((!body && !ids.length) || body.length > LIMIT.replyMaxLen || !input.requestId || input.requestId.length > LIMIT.requestIdMaxLen
    || !/^[A-Za-z0-9_-]+$/.test(input.requestId)) throw new HttpError(400, 'invalid feedback reply');
  if (!['reporter', 'admin'].includes(visibility) || (actor.mode === 'reporter' && visibility !== 'reporter')) {
    throw new HttpError(403, 'staff notes require admin access');
  }
  return db.transaction(async (tx) => {
    // Wallet before report: also serializes the same idempotency key racing on
    // two different reports, so it becomes a changed-request conflict, not 500.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${actor.wallet}`}, 0))`);
    const report = await lockFeedbackReport(tx, config, actor, reportId);
    const [existing] = await tx.select().from(feedbackMessages)
      .where(and(eq(feedbackMessages.author, actor.wallet), eq(feedbackMessages.requestId, input.requestId)));
    if (existing) {
      if (existing.reportId !== reportId || existing.body !== body || existing.visibility !== visibility
        || (existing.context as { action?: unknown } | null)?.action !== undefined
        || existing.kind !== (visibility === 'admin' ? 'note' : 'reply')
        || JSON.stringify((existing.context as { attachmentIds?: string[] } | null)?.attachmentIds ?? []) !== JSON.stringify(ids)
        || (existing.context as { authorRole?: string } | null)?.authorRole !== actor.mode) {
        throw new HttpError(409, 'reply request changed; use a new request ID', 'FEEDBACK_REPLY_CONFLICT');
      }
      return messageWithAttachments(tx, existing, actor);
    }
    if (actor.mode === 'reporter' && (report.lockedAt || report.closedAt)) throw new HttpError(409, 'this feedback thread is closed to replies', 'FEEDBACK_THREAD_LOCKED');
    const now = new Date();
    const recent = await tx.select({ createdAt: feedbackMessages.createdAt }).from(feedbackMessages)
      .where(and(eq(feedbackMessages.author, actor.wallet), gt(feedbackMessages.createdAt, new Date(now.getTime() - LIMIT.replyWindowMs))))
      .orderBy(asc(feedbackMessages.createdAt)).limit(LIMIT.maxRepliesPerWindow);
    if (recent.length >= LIMIT.maxRepliesPerWindow) throw new HttpError(429, 'too many replies; try again shortly',
      'FEEDBACK_REPLY_RATE_LIMITED', { retryAt: new Date(recent[0]!.createdAt.getTime() + LIMIT.replyWindowMs).toISOString() });
    const revision = report.revision + 1;
    const reporterRevision = visibility === 'reporter' ? report.reporterRevision + 1 : null;
    const [created] = await tx.insert(feedbackMessages).values({ reportId, author: actor.wallet,
      visibility, kind: visibility === 'admin' ? 'note' : 'reply', body, requestId: input.requestId,
      context: { authorRole: actor.mode, attachmentIds: ids, ...(input.origin ? FeedbackClientOriginContext.parse(input.origin) : {}) }, revision, reporterRevision, createdAt: now }).returning();
    await tx.update(testerFeedback).set({ revision, reporterRevision: reporterRevision ?? report.reporterRevision }).where(eq(testerFeedback.id, reportId));
    const attachments = await bindFeedbackScreenshots(tx, actor, reportId, created!.id, ids);
    return { ...messageDto(created!, actor), attachments };
  });
}
export async function markFeedbackThreadRead(db: Db, config: Access, actor: FeedbackActor, reportId: string, loadedRevision: number) {
  cursor(loadedRevision);
  return db.transaction(async (tx) => {
    const report = await lockFeedbackReport(tx, config, actor, reportId, { allowTrashed: true });
    const revision = Math.min(loadedRevision, actor.mode === 'reporter' ? report.reporterRevision : report.revision);
    const [read] = await tx.insert(feedbackReaders).values({ reportId, reader: readerKey(actor), revision })
      .onConflictDoUpdate({ target: [feedbackReaders.reportId, feedbackReaders.reader],
        set: { revision: sql`greatest(${feedbackReaders.revision}, ${revision})`, readAt: new Date() } })
      .returning({ revision: feedbackReaders.revision });
    return { readRevision: read!.revision };
  });
}
