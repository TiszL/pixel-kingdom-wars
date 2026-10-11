/** Fixed and trash state are moderation, never reward operations. Every change
 * records an immutable receipt under the shared moderation/reply/report locks. */
import { createHash } from 'node:crypto';
import { FEEDBACK_THREADS as LIMIT } from '@shardkeep/shared/feedback';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackMessages, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockFeedbackModeration } from './feedbackRewards';
import { lockFeedbackReport } from './feedbackThreads';

const Request = z.object({
  requestId: z.string().min(1).max(LIMIT.requestIdMaxLen).regex(/^[A-Za-z0-9_-]+$/),
  expectedRevision: z.number().int().positive().safe(),
  reason: z.string().trim().min(1).max(LIMIT.moderationReasonMaxLen),
});
export const FeedbackFixedBody = Request.extend({
  fixed: z.boolean(), fixedRef: z.string().trim().max(LIMIT.fixedRefMaxLen).optional(),
}).strict();
export const FeedbackTrashBody = Request.extend({ trashed: z.boolean() }).strict();
interface StateReceipt { reportId: string; messageId: string; revision: number; reporterRevision: number }
export interface FeedbackFixedReceipt extends StateReceipt {
  fixed: boolean; fixedAt: string | null; fixedRef: string | null; status: string;
}
export interface FeedbackTrashReceipt extends StateReceipt { trashed: boolean; trashedAt: string | null }
type FixedInput = z.infer<typeof FeedbackFixedBody>;
type TrashInput = z.infer<typeof FeedbackTrashBody>;
type Change = { action: 'report-fixed'; input: FixedInput } | { action: 'report-trash'; input: TrashInput };

async function changeState(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>, admin: string,
  reportId: string, change: Change): Promise<FeedbackFixedReceipt | FeedbackTrashReceipt> {
  const { action, input } = change;
  const requestHash = createHash('sha256').update(JSON.stringify({ reportId, action, ...input })).digest('hex');
  return db.transaction(async tx => {
    await lockFeedbackModeration(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${admin}`}, 0))`);
    const report = await lockFeedbackReport(tx, config, { wallet: admin, mode: 'admin' }, reportId,
      { allowTrashed: action === 'report-trash' });
    const [prior] = await tx.select().from(feedbackMessages)
      .where(and(eq(feedbackMessages.author, admin), eq(feedbackMessages.requestId, input.requestId)));
    if (prior) {
      const context = prior.context as { action?: string; requestHash?: string; receipt?: FeedbackFixedReceipt | FeedbackTrashReceipt } | null;
      if (prior.reportId !== reportId || context?.action !== action || context.requestHash !== requestHash || !context.receipt) {
        throw new HttpError(409, 'moderation request changed; use a new request ID', 'FEEDBACK_MODERATION_CONFLICT');
      }
      return context.receipt;
    }
    if (report.revision !== input.expectedRevision) {
      throw new HttpError(409, 'feedback changed; refresh before moderating', 'FEEDBACK_REVIEW_STALE');
    }
    const revision = report.revision + 1;
    const reporterRevision = report.reporterRevision + (action === 'report-fixed' ? 1 : 0);
    let patch: Partial<typeof testerFeedback.$inferInsert>;
    let state: Omit<FeedbackFixedReceipt, keyof StateReceipt> | Omit<FeedbackTrashReceipt, keyof StateReceipt>;
    let body: string;
    if (change.action === 'report-fixed') {
      const fixed = change.input.fixed;
      const status = report.status === 'fixed' ? 'accepted' as const : report.status;
      if (fixed && status !== 'accepted') {
        throw new HttpError(409, 'accept the report before marking it fixed', 'FEEDBACK_FIXED_CONFLICT');
      }
      const fixedAt = fixed ? report.fixedAt ?? new Date() : null;
      const fixedRef = fixed ? change.input.fixedRef === undefined ? report.fixedRef : change.input.fixedRef || null : null;
      patch = { status, fixedAt, fixedRef };
      state = { fixed, fixedAt: fixedAt?.toISOString() ?? null, fixedRef, status: fixed ? 'fixed' : status };
      body = `${fixed ? 'Marked fixed' : 'Fixed mark cleared'}: ${input.reason}`;
    } else {
      const trashedAt = change.input.trashed ? report.trashedAt ?? new Date() : null;
      patch = { trashedAt, trashedBy: change.input.trashed ? admin : null, trashReason: change.input.trashed ? input.reason : null };
      state = { trashed: change.input.trashed, trashedAt: trashedAt?.toISOString() ?? null };
      body = `${change.input.trashed ? 'Moved to trash' : 'Restored from trash'}: ${input.reason}`;
    }
    const [message] = await tx.insert(feedbackMessages).values({ reportId, author: admin, requestId: input.requestId,
      kind: 'status', visibility: action === 'report-fixed' ? 'reporter' : 'admin', body, revision,
      reporterRevision: action === 'report-fixed' ? reporterRevision : null,
      context: { authorRole: 'admin', action, requestHash },
    }).returning({ id: feedbackMessages.id });
    const receipt = { reportId, messageId: message!.id, revision, reporterRevision, ...state };
    await tx.update(feedbackMessages).set({ context: { authorRole: 'admin', action, requestHash, receipt } })
      .where(eq(feedbackMessages.id, message!.id));
    await tx.update(testerFeedback).set({ ...patch, revision, reporterRevision }).where(eq(testerFeedback.id, reportId));
    return receipt;
  });
}

export async function setFeedbackReportFixed(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>,
  admin: string, reportId: string, raw: FixedInput): Promise<FeedbackFixedReceipt> {
  if (!config.ADMIN_WALLETS?.includes(admin)) throw new HttpError(404, 'feedback not found');
  const parsed = FeedbackFixedBody.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid fixed-state request');
  return changeState(db, config, admin, reportId, { action: 'report-fixed', input: parsed.data }) as Promise<FeedbackFixedReceipt>;
}
export async function setFeedbackReportTrashed(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>,
  admin: string, reportId: string, raw: TrashInput): Promise<FeedbackTrashReceipt> {
  if (!config.ADMIN_WALLETS?.includes(admin)) throw new HttpError(404, 'feedback not found');
  const parsed = FeedbackTrashBody.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'invalid trash request');
  return changeState(db, config, admin, reportId, { action: 'report-trash', input: parsed.data }) as Promise<FeedbackTrashReceipt>;
}
