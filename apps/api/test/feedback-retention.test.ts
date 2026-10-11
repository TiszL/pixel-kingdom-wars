import { randomUUID } from 'node:crypto';
import { FEEDBACK_SCREENSHOTS as LIMIT } from '@shardkeep/shared/feedback';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackAttachments as attachments, feedbackMessages, playerActionEvents, playerActivityDays, players, testerFeedback as reports } from '../src/db/schema';
import { cleanupFeedbackScreenshots, setFeedbackScreenshotPreservation } from '../src/game/feedbackRetention';
import { feedbackObjectKey, type FeedbackScreenshotStorage } from '../src/game/feedbackStorage';
import { TEST_DATABASE_URL } from './db-url';
import { appendFeedbackReply } from '../src/game/feedbackThreads';

// Files run sequentially against one test DB. Temporarily preserve other suites'
// fixtures so this global sweeper cannot change their deletion state/history.
const conn = createDb(TEST_DATABASE_URL), admin = randomUUID(), wallet = randomUUID();
const config = { ADMIN_WALLETS: [admin] }, now = new Date('2001-01-01T00:00:00Z');
const reportIds: string[] = [], objects = new Set<string>();
const storage: FeedbackScreenshotStorage = { async put() { return 'created'; }, async read() { return null; }, async delete(key) { objects.delete(key); } };
let priorPreservation: Pick<typeof attachments.$inferSelect, 'id' | 'preservedAt' | 'preservedBy' | 'preservationReason'>[] = [];
beforeAll(async () => {
  await conn.db.insert(players).values([{ wallet }, { wallet: admin }]);
  priorPreservation = await conn.db.select({ id: attachments.id, preservedAt: attachments.preservedAt,
    preservedBy: attachments.preservedBy, preservationReason: attachments.preservationReason }).from(attachments);
  if (priorPreservation.length) await conn.db.update(attachments)
    .set({ preservedAt: now, preservedBy: admin, preservationReason: 'isolated retention fixture' })
    .where(inArray(attachments.id, priorPreservation.map(row => row.id)));
});
afterEach(async () => {
  if (!reportIds.length) return;
  await conn.db.delete(attachments).where(inArray(attachments.reportId, reportIds));
  await conn.db.delete(feedbackMessages).where(inArray(feedbackMessages.reportId, reportIds));
  await conn.db.delete(reports).where(inArray(reports.id, reportIds));
  reportIds.length = 0; objects.clear();
});
afterAll(async () => {
  try {
    await conn.db.transaction(async tx => {
      for (const { id, ...preservation } of priorPreservation) await tx.update(attachments).set(preservation).where(eq(attachments.id, id));
    });
    if (priorPreservation.length) {
      const restored = await conn.db.select({ id: attachments.id, preservedAt: attachments.preservedAt,
        preservedBy: attachments.preservedBy, preservationReason: attachments.preservationReason }).from(attachments)
        .where(inArray(attachments.id, priorPreservation.map(row => row.id)));
      expect(restored.sort((a, b) => a.id.localeCompare(b.id))).toEqual(priorPreservation.sort((a, b) => a.id.localeCompare(b.id)));
    }
    // Report creation records authoritative activity, retained after report
    // deletion. Clean only our fixture evidence before deleting its actors.
    await conn.db.delete(playerActionEvents).where(inArray(playerActionEvents.wallet, [wallet, admin]));
    await conn.db.delete(playerActivityDays).where(inArray(playerActivityDays.wallet, [wallet, admin]));
    await conn.db.delete(players).where(inArray(players.wallet, [wallet, admin]));
  } finally { await conn.sql.end(); }
});
async function fixture(state = 'stored', closedAt: Date | null = null, expiresAt = new Date(0)) {
  const [report] = await conn.db.insert(reports).values({ wallet, category: 'bug', title: 'retention', body: 'private test', closedAt }).returning();
  reportIds.push(report!.id);
  const [row] = await conn.db.insert(attachments).values({ reportId: report!.id, wallet, requestId: randomUUID(), state, expiresAt,
    objectKey: feedbackObjectKey('a'.repeat(64)), sha256: 'a'.repeat(64), byteLength: 10, width: 1, height: 1, contentType: 'image/webp' }).returning();
  objects.add(row!.objectKey!); return row!;
}
async function saved(id: string) { return (await conn.db.select().from(attachments).where(eq(attachments.id, id)))[0]!; }

it('expires abandoned uploads at their deadline and closed screenshots after 180 days, preserving open threads', async () => {
  const abandoned = await fixture('uploading', null, now);
  const fresh = await fixture('stored', null, new Date(now.getTime() + 1));
  const open = await fixture('attached');
  const closed = await fixture('attached', new Date(now.getTime() - LIMIT.closedRetentionDays * 86400000));
  expect(await cleanupFeedbackScreenshots(conn.db, storage, now)).toEqual({ examined: 2, deleted: 2, failed: 0 });
  expect((await saved(abandoned.id)).state).toBe('deleted'); expect((await saved(closed.id)).state).toBe('deleted');
  expect(objects.has(fresh.objectKey!)).toBe(true); expect(objects.has(open.objectKey!)).toBe(true);
});
it('keeps a durable key and revisits a late PUT after an acknowledged DELETE', async () => {
  const row = await fixture('uploading');
  await cleanupFeedbackScreenshots(conn.db, storage, now);
  expect(await saved(row.id)).toMatchObject({ objectKey: row.objectKey, state: 'deleted', deleteAttempts: 1 });
  objects.add(row.objectKey!); // the old transport completes after the deletion
  expect((await cleanupFeedbackScreenshots(conn.db, storage, now)).examined).toBe(0);
  await cleanupFeedbackScreenshots(conn.db, storage, new Date(now.getTime() + LIMIT.cleanupRetryMs));
  expect(objects.has(row.objectKey!)).toBe(false); expect((await saved(row.id)).deleteAttempts).toBe(2);
});
it('retains failed deletion for a bounded retry without leaking transport URLs into history', async () => {
  const row = await fixture();
  const failed = { ...storage, async delete() { throw new Error('https://private-object/secret'); } };
  expect((await cleanupFeedbackScreenshots(conn.db, failed, now)).failed).toBe(1);
  expect(await saved(row.id)).toMatchObject({ state: 'deleting', lastErrorCode: 'FEEDBACK_DELETE_FAILED' });
  await cleanupFeedbackScreenshots(conn.db, storage, new Date(now.getTime() + LIMIT.cleanupRetryMs));
  expect(await saved(row.id)).toMatchObject({ state: 'deleted', lastErrorCode: null });
});
it('bounds work and advances past recently processed tombstones', async () => {
  const rows = await Promise.all(Array.from({ length: LIMIT.cleanupBatchSize + 1 }, () => fixture()));
  expect((await cleanupFeedbackScreenshots(conn.db, storage, now)).deleted).toBe(LIMIT.cleanupBatchSize);
  expect((await cleanupFeedbackScreenshots(conn.db, storage, now)).deleted).toBe(1);
  expect(objects.size).toBe(0); expect(rows).toHaveLength(LIMIT.cleanupBatchSize + 1);
});
it('serializes overlapping workers so the same due object is claimed once', async () => {
  await fixture(); let deletes = 0;
  const counted = { ...storage, async delete(key: string) { deletes++; objects.delete(key); } };
  const passes = await Promise.all([cleanupFeedbackScreenshots(conn.db, counted, now), cleanupFeedbackScreenshots(conn.db, counted, now)]);
  expect(passes.reduce((sum, pass) => sum + pass.deleted, 0)).toBe(1); expect(deletes).toBe(1);
});
it('makes preservation authorized, auditable, private, replayable and removable', async () => {
  const row = await fixture('attached', new Date(0));
  const input = { requestId: randomUUID(), preserved: true, reason: 'needed for regression review', expectedRevision: 1 };
  await expect(setFeedbackScreenshotPreservation(conn.db, config, wallet, row.reportId!, row.id, input)).rejects.toMatchObject({ statusCode: 404 });
  const receipt = await setFeedbackScreenshotPreservation(conn.db, config, admin, row.reportId!, row.id, input);
  expect(await setFeedbackScreenshotPreservation(conn.db, config, admin, row.reportId!, row.id, input)).toEqual(receipt);
  await expect(setFeedbackScreenshotPreservation(conn.db, config, admin, row.reportId!, row.id, { ...input, preserved: false })).rejects.toMatchObject({ code: 'FEEDBACK_MODERATION_CONFLICT' });
  expect((await cleanupFeedbackScreenshots(conn.db, storage, now)).examined).toBe(0);
  const [report] = await conn.db.select().from(reports).where(eq(reports.id, row.reportId!));
  const [audit] = await conn.db.select().from(feedbackMessages).where(eq(feedbackMessages.id, receipt.messageId));
  expect(report).toMatchObject({ revision: 2, reporterRevision: 1 }); expect(audit).toMatchObject({ visibility: 'admin', reporterRevision: null });
  await setFeedbackScreenshotPreservation(conn.db, config, admin, row.reportId!, row.id, { ...input, requestId: randomUUID(), expectedRevision: 2, preserved: false });
  expect((await cleanupFeedbackScreenshots(conn.db, storage, now)).deleted).toBe(1);
  await expect(setFeedbackScreenshotPreservation(conn.db, config, admin, row.reportId!, row.id, { ...input, requestId: randomUUID(), expectedRevision: 3 })).rejects.toMatchObject({ code: 'FEEDBACK_ATTACHMENT_CHANGED' });
});
it('rechecks preservation and reopening committed after discovery but before claiming', async () => {
  const preserved = await fixture('attached', new Date(0));
  const reopened = await fixture('attached', new Date(0));
  let interleaved = false;
  // Force the real concurrent commit at the discovery/claim boundary instead of
  // depending on scheduler timing. Queries and row locks still use real Postgres.
  const racingDb = new Proxy(conn.db, { get(target, property) {
    if (property === 'transaction') return async (...args: Parameters<typeof conn.db.transaction>) => {
      if (!interleaved) {
        interleaved = true;
        await setFeedbackScreenshotPreservation(conn.db, config, admin, preserved.reportId!, preserved.id,
          { requestId: randomUUID(), preserved: true, reason: 'keep evidence', expectedRevision: 1 });
        await conn.db.update(reports).set({ closedAt: null }).where(eq(reports.id, reopened.reportId!));
      }
      return target.transaction(...args);
    };
    return Reflect.get(target, property);
  } });
  expect(await cleanupFeedbackScreenshots(racingDb, storage, now)).toEqual({ examined: 2, deleted: 0, failed: 0 });
  expect(objects.size).toBe(2);
});
it('rejects preservation after a claim while storage deletion is still pending', async () => {
  const row = await fixture('attached', new Date(0));
  const concurrent = { ...storage, async delete(key: string) {
    await expect(setFeedbackScreenshotPreservation(conn.db, config, admin, row.reportId!, row.id,
      { requestId: randomUUID(), preserved: true, reason: 'too late', expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'FEEDBACK_ATTACHMENT_CHANGED' });
    objects.delete(key);
  } };
  expect((await cleanupFeedbackScreenshots(conn.db, concurrent, now)).deleted).toBe(1);
});
it('keeps preservation audit requests distinct from ordinary staff notes in both replay directions', async () => {
  const row = await fixture('attached');
  const input = { requestId: randomUUID(), preserved: true, reason: 'keep evidence', expectedRevision: 1 };
  await setFeedbackScreenshotPreservation(conn.db, config, admin, row.reportId!, row.id, input);
  const note = { requestId: input.requestId, body: 'Screenshot preserved: keep evidence', visibility: 'admin' as const };
  await expect(appendFeedbackReply(conn.db, config, { wallet: admin, mode: 'admin' }, row.reportId!, note))
    .rejects.toMatchObject({ code: 'FEEDBACK_REPLY_CONFLICT' });
  const next = { ...note, requestId: randomUUID() };
  await appendFeedbackReply(conn.db, config, { wallet: admin, mode: 'admin' }, row.reportId!, next);
  await expect(setFeedbackScreenshotPreservation(conn.db, config, admin, row.reportId!, row.id,
    { ...input, requestId: next.requestId, expectedRevision: 3 }))
    .rejects.toMatchObject({ code: 'FEEDBACK_MODERATION_CONFLICT' });
  const [report] = await conn.db.select().from(reports).where(eq(reports.id, row.reportId!));
  expect(report!.revision).toBe(3);
  expect(await saved(row.id)).toMatchObject({ preservedBy: admin, preservationReason: 'keep evidence' });
});
