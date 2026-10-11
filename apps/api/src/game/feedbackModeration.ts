/** Staff control of reply availability only. Closing a report and retention are
 * separate operations; unlocking replies never silently reopens a closed report. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { lockFeedbackModeration } from './feedbackRewards';
import { FEEDBACK_THREADS as LIMIT } from '@shardkeep/shared/feedback';
import { and, eq, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db } from '../db/client';
import { feedbackMessages, testerFeedback } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockFeedbackReport } from './feedbackThreads';

export async function setFeedbackThreadLock(db: Db, config: Pick<Config, 'ADMIN_WALLETS'>, adminWallet: string,
  reportId: string, input: { requestId: string; locked: boolean; reason: string }) {
  if (!config.ADMIN_WALLETS?.includes(adminWallet)) throw new HttpError(404, 'feedback not found');
  if (typeof input.reason !== 'string' || typeof input.requestId !== 'string') throw new HttpError(400, 'invalid moderation request');
  const reason = input.reason.trim();
  if (typeof input.locked !== 'boolean' || !reason || reason.length > LIMIT.moderationReasonMaxLen
    || !input.requestId || input.requestId.length > LIMIT.requestIdMaxLen || !/^[A-Za-z0-9_-]+$/.test(input.requestId)) {
    throw new HttpError(400, 'a valid request ID, lock state and visible reason are required');
  }
  return db.transaction(async tx => {
    // Same lock order/namespace as replies: a key reused across operations must
    // conflict deterministically instead of racing the author/request constraint.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${adminWallet}`}, 0))`);
    const report = await lockFeedbackReport(tx, config, { wallet: adminWallet, mode: 'admin' }, reportId);
    const [existing] = await tx.select().from(feedbackMessages).where(and(eq(feedbackMessages.author, adminWallet), eq(feedbackMessages.requestId, input.requestId)));
    if (existing) {
      const context = existing.context as { action?: string; locked?: boolean; reason?: string } | null;
      if (existing.reportId !== reportId || context?.action !== 'thread-lock' || context.locked !== input.locked || context.reason !== reason) {
        throw new HttpError(409, 'moderation request changed; use a new request ID', 'FEEDBACK_MODERATION_CONFLICT');
      }
      return { messageId: existing.id, revision: existing.revision, reporterRevision: existing.reporterRevision!, locked: input.locked };
    }
    const revision = report.revision + 1; const reporterRevision = report.reporterRevision + 1;
    const [message] = await tx.insert(feedbackMessages).values({ reportId, author: adminWallet,
      kind: 'status', visibility: 'reporter', body: `${input.locked ? 'Replies locked' : 'Replies unlocked'}: ${reason}`,
      revision, reporterRevision, requestId: input.requestId,
      context: { authorRole: 'admin', action: 'thread-lock', locked: input.locked, reason },
    }).returning({ id: feedbackMessages.id });
    await tx.update(testerFeedback).set({ lockedAt: input.locked ? new Date() : null, revision, reporterRevision })
      .where(eq(testerFeedback.id, reportId));
    return { messageId: message!.id, revision, reporterRevision, locked: input.locked };
  });
}


export const FeedbackClosureBody = z.object({requestId:z.string().min(1).max(LIMIT.requestIdMaxLen).regex(/^[A-Za-z0-9_-]+$/),
  expectedRevision:z.number().int().positive().safe(),closed:z.boolean(),reason:z.string().trim().min(1).max(LIMIT.moderationReasonMaxLen)}).strict();
export interface FeedbackClosureReceipt {reportId:string;messageId:string;closed:boolean;closedAt:string|null;revision:number;reporterRevision:number;}
/** Closure is the retention clock. Reopening never resurrects claimed/deleted
 * screenshots; their immutable object lifecycle and expired markers survive. */
export async function setFeedbackThreadClosed(db:Db,config:Pick<Config,'ADMIN_WALLETS'>,admin:string,reportId:string,raw:z.infer<typeof FeedbackClosureBody>):Promise<FeedbackClosureReceipt>{
  if(!config.ADMIN_WALLETS?.includes(admin))throw new HttpError(404,'feedback not found');
  const parsed=FeedbackClosureBody.safeParse(raw);if(!parsed.success)throw new HttpError(400,'invalid closure request');
  const input=parsed.data,requestHash=createHash('sha256').update(JSON.stringify({reportId,...input})).digest('hex');
  return db.transaction(async tx=>{
    await lockFeedbackModeration(tx);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-reply:${admin}`},0))`);
    const report=await lockFeedbackReport(tx,config,{wallet:admin,mode:'admin'},reportId);
    const [prior]=await tx.select().from(feedbackMessages).where(and(eq(feedbackMessages.author,admin),eq(feedbackMessages.requestId,input.requestId)));
    if(prior){const context=prior.context as {action?:string;requestHash?:string;receipt?:FeedbackClosureReceipt}|null;
      if(context?.action!=='thread-closure'||context.requestHash!==requestHash||!context.receipt)throw new HttpError(409,'closure request changed','FEEDBACK_MODERATION_CONFLICT');return context.receipt;}
    if(report.revision!==input.expectedRevision)throw new HttpError(409,'feedback changed; refresh before changing closure','FEEDBACK_REVIEW_STALE');
    const closedAt=input.closed?report.closedAt??new Date():null;
    const revision=report.revision+1,reporterRevision=report.reporterRevision+1;
    const [message]=await tx.insert(feedbackMessages).values({reportId,author:admin,requestId:input.requestId,kind:'status',visibility:'reporter',
      revision,reporterRevision,body:`${input.closed?'Report closed':'Report reopened'}: ${input.reason}`,
      context:{authorRole:'admin',action:'thread-closure',requestHash},
    }).returning({id:feedbackMessages.id});
    const receipt:FeedbackClosureReceipt={reportId,messageId:message!.id,closed:input.closed,closedAt:closedAt?.toISOString()??null,revision,reporterRevision};
    await tx.update(feedbackMessages).set({context:{authorRole:'admin',action:'thread-closure',requestHash,receipt}}).where(eq(feedbackMessages.id,message!.id));
    await tx.update(testerFeedback).set({closedAt,revision,reporterRevision}).where(eq(testerFeedback.id,reportId));
    return receipt;
  });
}
