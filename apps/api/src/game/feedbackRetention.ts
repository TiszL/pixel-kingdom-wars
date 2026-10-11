/** Deletion claims are irreversible: binding/preservation serialize on the
 * report then attachment. Keep keys after DELETE, because an ambiguous PUT may
 * still arrive later; bounded periodic tombstone sweeps reconcile that object. */
import { createHash } from 'node:crypto';
import { FEEDBACK_SCREENSHOTS as LIMIT, FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { and, eq, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackAttachments as attachments, feedbackMessages, testerFeedback as reports } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockFeedbackModeration } from './feedbackRewards';
import type { FeedbackScreenshotStorage } from './feedbackStorage';
import { lockFeedbackReport } from './feedbackThreads';

function eligible(now: Date) {
  const closedBefore = new Date(now.getTime() - LIMIT.closedRetentionDays * 86400000);
  return and(isNull(attachments.preservedAt), or(isNull(attachments.deleteAfter), lte(attachments.deleteAfter, now)), or(
    sql`${attachments.state} IN ('deleting', 'deleted')`,
    and(sql`${attachments.state} IN ('uploading', 'stored', 'failed')`, isNull(attachments.messageId), lte(attachments.expiresAt, now)),
    and(eq(attachments.state, 'attached'), or(lte(reports.closedAt, closedBefore), lte(reports.trashedAt, closedBefore))),
  ));
}

/** One bounded pass, oldest due first. Production storage bounds each DELETE;
 * no object listing, unbounded queues or removal of audit/history rows. */
export async function cleanupFeedbackScreenshots(db: Db, storage: FeedbackScreenshotStorage, now = new Date()) {
  const candidates = await db.select({ id: attachments.id, reportId: attachments.reportId })
    .from(attachments).leftJoin(reports, eq(reports.id, attachments.reportId)).where(eligible(now))
    .orderBy(sql`coalesce(${attachments.deleteAfter}, case when ${attachments.state} = 'attached'
      then least(${reports.closedAt}, ${reports.trashedAt}) + ${LIMIT.closedRetentionDays} * interval '1 day' else ${attachments.expiresAt} end)`, attachments.id)
    .limit(LIMIT.cleanupBatchSize);
  const result = { examined: candidates.length, deleted: 0, failed: 0 };
  for (const candidate of candidates) {
    const claim = await db.transaction(async tx => {
      if (candidate.reportId) await tx.select({ id: reports.id }).from(reports).where(eq(reports.id, candidate.reportId)).for('update');
      await tx.select({ id: attachments.id }).from(attachments).where(eq(attachments.id, candidate.id)).for('update');
      // Recheck after locks: a candidate may have been bound, preserved, reopened
      // or claimed by another worker while this pass waited for the report.
      const [current] = await tx.select({ row: attachments }).from(attachments)
        .leftJoin(reports, eq(reports.id, attachments.reportId)).where(and(eq(attachments.id, candidate.id), eligible(now)));
      if (!current) return null;
      const [row] = await tx.update(attachments).set({ state: 'deleting',
        deleteAfter: new Date(now.getTime() + LIMIT.cleanupRetryMs), deleteAttempts: current.row.deleteAttempts + 1 })
        .where(eq(attachments.id, candidate.id)).returning();
      return row!;
    });
    if (!claim) continue;
    try {
      if (claim.objectKey) await storage.delete(claim.objectKey);
      await db.update(attachments).set({ state: 'deleted', deletedAt: claim.deletedAt ?? now, lastErrorCode: null })
        .where(and(eq(attachments.id, claim.id), eq(attachments.deleteAttempts, claim.deleteAttempts)));
      result.deleted++;
    } catch {
      // Store a stable code; transport errors can contain private object URLs.
      await db.update(attachments).set({ lastErrorCode: 'FEEDBACK_DELETE_FAILED' })
        .where(and(eq(attachments.id, claim.id), eq(attachments.deleteAttempts, claim.deleteAttempts)));
      result.failed++;
    }
  }
  return result;
}

export const FeedbackPreservationBody = z.object({ requestId: z.string().min(1).max(FEEDBACK_THREADS.requestIdMaxLen).regex(/^[A-Za-z0-9_-]+$/),
  preserved: z.boolean(), reason: z.string().trim().min(1).max(FEEDBACK_THREADS.moderationReasonMaxLen),
  expectedRevision: z.number().int().positive().safe(),
}).strict();
export type FeedbackPreservationInput = z.infer<typeof FeedbackPreservationBody>;
interface PreservationReceipt { attachmentId: string; preserved: boolean; revision: number; messageId: string }
export async function setFeedbackScreenshotPreservation(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>, admin: string,
  reportId: string, attachmentId: string, raw: FeedbackPreservationInput): Promise<PreservationReceipt> {
  if (!config.ADMIN_WALLETS?.includes(admin)) throw new HttpError(404, 'feedback not found');
  const parsed = FeedbackPreservationBody.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid screenshot preservation request');
  const input = parsed.data;
  const requestHash = createHash('sha256').update(JSON.stringify({ reportId, attachmentId, ...input })).digest('hex');
  return db.transaction(async tx => {
    await lockFeedbackModeration(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${admin}`}, 0))`);
    const report = await lockFeedbackReport(tx, config, { mode: 'admin', wallet: admin }, reportId);
    const [prior] = await tx.select().from(feedbackMessages).where(and(eq(feedbackMessages.author, admin), eq(feedbackMessages.requestId, input.requestId)));
    if (prior) {
      const context = prior.context as { action?: string; requestHash?: string; receipt?: PreservationReceipt } | null;
      if (context?.action !== 'screenshot-preservation' || context.requestHash !== requestHash || !context.receipt) throw new HttpError(409, 'preservation request changed', 'FEEDBACK_MODERATION_CONFLICT');
      return context.receipt;
    }
    const [row] = await tx.select().from(attachments).where(and(eq(attachments.id, attachmentId), eq(attachments.reportId, reportId))).for('update');
    if (!row) throw new HttpError(404, 'screenshot not found');
    if (row.state !== 'attached') throw new HttpError(409, 'only an available submitted screenshot can be preserved', 'FEEDBACK_ATTACHMENT_CHANGED');
    if (report.revision !== input.expectedRevision) throw new HttpError(409, 'feedback changed; refresh before preserving', 'FEEDBACK_REVIEW_STALE');
    const revision = report.revision + 1;
    await tx.update(attachments).set({ preservedAt: input.preserved ? new Date() : null,
      preservedBy: input.preserved ? admin : null, preservationReason: input.preserved ? input.reason : null })
      .where(eq(attachments.id, row.id));
    const [message] = await tx.insert(feedbackMessages).values({ reportId, author: admin, requestId: input.requestId,
      kind: 'note', visibility: 'admin', body: `${input.preserved ? 'Screenshot preserved' : 'Screenshot preservation removed'}: ${input.reason}`, revision,
    }).returning({ id: feedbackMessages.id });
    const receipt = { attachmentId, preserved: input.preserved, revision, messageId: message!.id };
    await tx.update(feedbackMessages).set({ context: { authorRole: 'admin', action: 'screenshot-preservation', requestHash, attachmentId, reason: input.reason, receipt } })
      .where(eq(feedbackMessages.id, message!.id));
    await tx.update(reports).set({ revision }).where(eq(reports.id, reportId));
    return receipt;
  });
}
