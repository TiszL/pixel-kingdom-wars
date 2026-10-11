/** Private upload reservations survive ambiguous R2 writes. No object keys or
 * storage credentials enter a browser DTO; access is checked for every read. */
import { FEEDBACK_SCREENSHOTS as LIMIT, FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { Config } from '../config';
import type { Db, DbTx } from '../db/client';
import { feedbackAttachments, feedbackMessages } from '../db/schema';
import { HttpError } from '../lib/errors';
import { lockFeedbackReport, type FeedbackActor } from './feedbackThreads';
import { feedbackObjectKey, normalizeFeedbackScreenshot, type FeedbackScreenshotStorage } from './feedbackStorage';

type Access = Pick<Config, 'ADMIN_WALLETS'>;
type Attachment = typeof feedbackAttachments.$inferSelect;
export function feedbackAttachmentDto(row: Attachment, mode: FeedbackActor['mode'] = 'reporter') {
  return { id: row.id, width: row.width, height: row.height, byteLength: row.byteLength,
    contentType: row.contentType, expired: row.state === 'deleted' || row.state === 'deleting',
    ...(mode === 'admin' ? { preserved: row.preservedAt !== null } : {}) };
}
/** Caller holds the report lock and inserts the message in the same transaction. */
export async function bindFeedbackScreenshots(tx: DbTx, actor: FeedbackActor, reportId: string, messageId: string, ids: string[]) {
  if (!ids.length) return [];
  const rows = await tx.select().from(feedbackAttachments).where(inArray(feedbackAttachments.id, ids)).for('update');
  if (rows.length !== ids.length || rows.some(row => row.reportId !== reportId || row.wallet !== actor.wallet
    || row.uploadRole !== actor.mode || row.messageId !== null || row.state !== 'stored' || row.expiresAt <= new Date())) {
    throw new HttpError(409, 'a screenshot is unavailable, expired or already used; review your attachments', 'FEEDBACK_ATTACHMENT_CHANGED');
  }
  await tx.update(feedbackAttachments).set({ state: 'attached', messageId }).where(inArray(feedbackAttachments.id, ids));
  return ids.map(id => feedbackAttachmentDto(rows.find(row => row.id === id)!, actor.mode));
}
async function lockUploadWallet(tx: DbTx, wallet: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`feedback-upload:${wallet}`}, 0))`);
}
/** Called by the route before buffering and again under the reservation lock. */
export async function authorizeFeedbackUpload(db: Db, config: Access, actor: FeedbackActor, reportId: string) {
  await db.transaction(async tx => { await lockFeedbackReport(tx, config, actor, reportId); });
}
/** Staff may inspect trashed evidence, but cannot add uploads until restored. */
export async function authorizeFeedbackScreenshotRead(db: Db, config: Access, actor: FeedbackActor, reportId: string) {
  await db.transaction(async tx => { await lockFeedbackReport(tx, config, actor, reportId, { allowTrashed: true }); });
}
export async function uploadFeedbackScreenshot(db: Db, config: Access, storage: FeedbackScreenshotStorage,
  actor: FeedbackActor, reportId: string, requestId: string, bytes: Buffer, contentType: string) {
  if (!requestId || requestId.length > FEEDBACK_THREADS.requestIdMaxLen || !/^[A-Za-z0-9_-]+$/.test(requestId)) throw new HttpError(400, 'invalid screenshot request');
  await authorizeFeedbackUpload(db, config, actor, reportId);
  const image = await normalizeFeedbackScreenshot(bytes, contentType);
  const reservation = await db.transaction(async tx => {
    await lockUploadWallet(tx, actor.wallet);
    const report = await lockFeedbackReport(tx, config, actor, reportId);
    const [existing] = await tx.select().from(feedbackAttachments).where(and(
      eq(feedbackAttachments.wallet, actor.wallet), eq(feedbackAttachments.requestId, requestId))).for('update');
    if (existing) {
      if (existing.reportId !== reportId || existing.sha256 !== image.sha256 || existing.uploadRole !== actor.mode) throw new HttpError(409, 'screenshot request changed; select the image again', 'FEEDBACK_UPLOAD_CONFLICT');
      if (existing.state === 'deleting' || existing.state === 'deleted' || existing.expiresAt <= new Date() && existing.state !== 'attached') throw new HttpError(410, 'screenshot upload expired; select the image again', 'FEEDBACK_UPLOAD_EXPIRED');
      return existing;
    }
    if (actor.mode === 'reporter' && (report.lockedAt || report.closedAt)) throw new HttpError(409, 'this feedback thread is closed to uploads', 'FEEDBACK_THREAD_LOCKED');
    const now = new Date();
    const recent = await tx.select({ id: feedbackAttachments.id }).from(feedbackAttachments).where(and(
      eq(feedbackAttachments.wallet, actor.wallet), gt(feedbackAttachments.createdAt, new Date(now.getTime() - LIMIT.uploadWindowMs)))).limit(LIMIT.maxUploadsPerWindow);
    if (recent.length >= LIMIT.maxUploadsPerWindow) throw new HttpError(429, 'too many screenshot uploads; try again shortly', 'FEEDBACK_UPLOAD_RATE_LIMITED');
    // Fixed allocations preserve the overall thread cap without exposing whether
    // staff added private evidence. Public staff replies keep their staff slot.
    const capacity = actor.mode === 'admin' ? LIMIT.maxStaffPerThread : LIMIT.maxPerThread - LIMIT.maxStaffPerThread;
    const held = await tx.select({ id: feedbackAttachments.id }).from(feedbackAttachments).where(and(
      eq(feedbackAttachments.reportId, reportId), eq(feedbackAttachments.uploadRole, actor.mode), inArray(feedbackAttachments.state, ['uploading', 'stored', 'attached']))).limit(capacity);
    if (held.length >= capacity) throw new HttpError(409, 'this thread has reached its screenshot limit', 'FEEDBACK_ATTACHMENTS_FULL');
    const [created] = await tx.insert(feedbackAttachments).values({ wallet: actor.wallet, reportId, requestId, uploadRole: actor.mode,
      state: 'uploading', objectKey: feedbackObjectKey(image.sha256), sha256: image.sha256,
      byteLength: image.bytes.length, width: image.width, height: image.height, contentType: image.contentType,
      expiresAt: new Date(now.getTime() + LIMIT.abandonedRetentionHours * 60 * 60 * 1000) }).returning();
    return created!;
  });
  if (reservation.state === 'stored' || reservation.state === 'attached') return feedbackAttachmentDto(reservation, actor.mode);
  // A failed or lost PUT can already have succeeded. Reuse the immutable key;
  // conditional PUT plus read/hash verification reconciles either outcome.
  await storage.put(reservation.objectKey!, image);
  const stored = await storage.read(reservation.objectKey!);
  if (!stored || !stored.equals(image.bytes)) throw new Error('Private screenshot storage verification failed');
  return db.transaction(async tx => {
    await lockUploadWallet(tx, actor.wallet);
    await lockFeedbackReport(tx, config, actor, reportId);
    const [current] = await tx.select().from(feedbackAttachments).where(eq(feedbackAttachments.id, reservation.id)).for('update');
    if (!current || !['uploading', 'stored', 'attached'].includes(current.state) || current.expiresAt <= new Date() && current.state !== 'attached') throw new HttpError(410, 'screenshot upload expired; select the image again', 'FEEDBACK_UPLOAD_EXPIRED');
    if (current.state === 'uploading') {
      const [ready] = await tx.update(feedbackAttachments).set({ state: 'stored', lastErrorCode: null })
        .where(eq(feedbackAttachments.id, current.id)).returning();
      return feedbackAttachmentDto(ready!, actor.mode);
    }
    return feedbackAttachmentDto(current, actor.mode);
  });
}
export async function readFeedbackScreenshot(db: Db, config: Access, storage: FeedbackScreenshotStorage,
  actor: FeedbackActor, reportId: string, attachmentId: string) {
  const row = await db.transaction(async tx => {
    await lockFeedbackReport(tx, config, actor, reportId, { allowTrashed: true });
    const [found] = await tx.select().from(feedbackAttachments).where(and(
      eq(feedbackAttachments.id, attachmentId), eq(feedbackAttachments.reportId, reportId)));
    if (!found) throw new HttpError(404, 'screenshot not found');
    // An unsubmitted draft is visible only to its uploader, even if that uploader
    // is a staff member. Staff can inspect all objects only in the admin route.
    if (actor.mode !== 'admin') {
      if (found.messageId) {
        const [message] = await tx.select({ visibility: feedbackMessages.visibility }).from(feedbackMessages)
          .where(and(eq(feedbackMessages.id, found.messageId), eq(feedbackMessages.reportId, reportId)));
        if (message?.visibility !== 'reporter') throw new HttpError(404, 'screenshot not found');
      } else if (found.wallet !== actor.wallet) throw new HttpError(404, 'screenshot not found');
    }
    if (!['stored', 'attached'].includes(found.state) || found.expiresAt <= new Date() && found.state !== 'attached') throw new HttpError(410, 'screenshot is unavailable or expired', 'FEEDBACK_ATTACHMENT_EXPIRED');
    return found;
  });
  const bytes = await storage.read(row.objectKey!);
  if (!bytes) throw new HttpError(503, 'screenshot storage is temporarily unavailable; retry later', 'FEEDBACK_STORAGE_UNAVAILABLE');
  return { bytes, contentType: 'image/webp' as const };
}
