import { randomUUID } from 'node:crypto';
import { FEEDBACK_SCREENSHOTS as LIMIT } from '@shardkeep/shared/feedback';
import { and, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackAttachments, feedbackMessages, players, testerFeedback } from '../src/db/schema';
import { readFeedbackScreenshot, uploadFeedbackScreenshot } from '../src/game/feedbackAttachments';
import type { FeedbackScreenshotStorage } from '../src/game/feedbackStorage';
import { appendFeedbackReply, getFeedbackThread } from '../src/game/feedbackThreads';
import { TEST_DATABASE_URL } from './db-url';
const conn = createDb(TEST_DATABASE_URL);
const owner = { wallet: randomUUID(), mode: 'reporter' as const };
const other = { wallet: randomUUID(), mode: 'reporter' as const };
const admin = { wallet: randomUUID(), mode: 'admin' as const };
const config = { ADMIN_WALLETS: [admin.wallet] };
const objects = new Map<string, Buffer>();
let puts = 0; let reads = 0; let losePut = false; let image: Buffer; let changed: Buffer;
const storage: FeedbackScreenshotStorage = {
  async put(key, value) {
    puts++; const exists = objects.has(key); objects.set(key, value.bytes);
    if (losePut) { losePut = false; throw new Error('lost PUT response'); }
    return exists ? 'exists' : 'created';
  },
  async read(key) { reads++; return objects.get(key) ?? null; },
  async delete(key) { objects.delete(key); },
};
beforeAll(async () => {
  await conn.db.insert(players).values([owner, other, admin].map(a => ({ wallet: a.wallet })));
  image = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#203040' } }).png().toBuffer();
  changed = await sharp({ create: { width: 20, height: 10, channels: 4, background: '#102030' } }).png().toBuffer();
});
afterAll(async () => { await conn.sql.end(); });
async function report() {
  const [row] = await conn.db.insert(testerFeedback).values({ wallet: owner.wallet, category: 'bug', title: 'private screenshot', body: 'test report' }).returning();
  return row!.id;
}
it('denies cross-wallet uploads before decoding or touching private storage', async () => {
  const id = await report(); const before = puts;
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, other, id, randomUUID(), Buffer.from('bad'), 'image/png')).rejects.toMatchObject({ statusCode: 404 });
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, { ...other, mode: 'admin' }, id, randomUUID(), image, 'image/png')).rejects.toMatchObject({ statusCode: 404 });
  expect(puts).toBe(before);
});
it('persists one immutable reservation across duplicate uploads and lost R2 responses', async () => {
  const id = await report(); const request = randomUUID(); losePut = true;
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png')).rejects.toThrow('lost PUT');
  const pending = await conn.db.select().from(feedbackAttachments).where(eq(feedbackAttachments.requestId, request));
  expect(pending).toHaveLength(1); expect(pending[0]!.state).toBe('uploading');
  const [first, second] = await Promise.all([
    uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png'),
    uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png'),
  ]);
  expect(first).toEqual(second); expect(first.id).toBe(pending[0]!.id);
  expect(Object.keys(first).sort()).toEqual(['byteLength', 'contentType', 'expired', 'height', 'id', 'width']);
  expect(await readFeedbackScreenshot(conn.db, config, storage, owner, id, first.id)).toMatchObject({ contentType: 'image/webp' });
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, changed, 'image/png')).rejects.toMatchObject({ code: 'FEEDBACK_UPLOAD_CONFLICT' });
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, await report(), request, image, 'image/png')).rejects.toMatchObject({ code: 'FEEDBACK_UPLOAD_CONFLICT' });
});
it('never exposes admin draft or admin-note screenshots through reporter routes', async () => {
  const id = await report(); const item = await uploadFeedbackScreenshot(conn.db, config, storage, admin, id, randomUUID(), image, 'image/png');
  const before = reads;
  await expect(readFeedbackScreenshot(conn.db, config, storage, owner, id, item.id)).rejects.toMatchObject({ statusCode: 404 });
  await expect(readFeedbackScreenshot(conn.db, config, storage, other, id, item.id)).rejects.toMatchObject({ statusCode: 404 });
  await expect(readFeedbackScreenshot(conn.db, config, storage, { ...other, mode: 'admin' }, id, item.id)).rejects.toMatchObject({ statusCode: 404 });
  expect(reads).toBe(before);
  const [note] = await conn.db.insert(feedbackMessages).values({ reportId: id, author: admin.wallet, revision: 2, kind: 'note', visibility: 'admin', body: 'staff only', requestId: randomUUID() }).returning();
  await conn.db.update(feedbackAttachments).set({ state: 'attached', messageId: note!.id }).where(eq(feedbackAttachments.id, item.id));
  await expect(readFeedbackScreenshot(conn.db, config, storage, owner, id, item.id)).rejects.toMatchObject({ statusCode: 404 });
  expect((await readFeedbackScreenshot(conn.db, config, storage, admin, id, item.id)).bytes.length).toBeGreaterThan(0);
  await conn.db.update(feedbackMessages).set({ kind: 'reply', visibility: 'reporter', reporterRevision: 2 }).where(eq(feedbackMessages.id, note!.id));
  expect((await readFeedbackScreenshot(conn.db, config, storage, owner, id, item.id)).bytes.length).toBeGreaterThan(0);
});
it('refuses corrupt input without allocating a durable upload or storage object', async () => {
  const id = await report(); const request = randomUUID(); const before = puts;
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, Buffer.from('bad'), 'image/png')).rejects.toThrow();
  expect(await conn.db.select().from(feedbackAttachments).where(eq(feedbackAttachments.requestId, request))).toHaveLength(0);
  expect(puts).toBe(before);
});
it('preserves acknowledged upload replay when locked, but refuses new uploads', async () => {
  const id = await report(); const request = randomUUID();
  const original = await uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png');
  await conn.db.update(testerFeedback).set({ lockedAt: new Date() }).where(eq(testerFeedback.id, id));
  expect(await uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png')).toEqual(original);
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, id, randomUUID(), image, 'image/png')).rejects.toMatchObject({ code: 'FEEDBACK_THREAD_LOCKED' });
});
it('does not resurrect expired uploads and reports missing R2 objects as recoverable', async () => {
  const id = await report(); const request = randomUUID();
  const item = await uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png');
  const [row] = await conn.db.select().from(feedbackAttachments).where(eq(feedbackAttachments.id, item.id));
  objects.delete(row!.objectKey!);
  await expect(readFeedbackScreenshot(conn.db, config, storage, owner, id, item.id)).rejects.toMatchObject({ statusCode: 503 });
  await conn.db.update(feedbackAttachments).set({ expiresAt: new Date(0) }).where(eq(feedbackAttachments.id, item.id));
  const before = puts;
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png')).rejects.toMatchObject({ statusCode: 410 });
  expect(puts).toBe(before);
});
it('bounds per-wallet upload attempts across reports and leaves retries available', async () => {
  const id = await report();
  await conn.db.update(feedbackAttachments).set({ createdAt: new Date(0) }).where(eq(feedbackAttachments.wallet, owner.wallet));
  const request = randomUUID(); const first = await uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png');
  await conn.db.insert(feedbackAttachments).values(Array.from({ length: LIMIT.maxUploadsPerWindow - 1 }, () => ({ wallet: owner.wallet, reportId: id, requestId: randomUUID(), expiresAt: new Date(Date.now() + 60000) })));
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, await report(), randomUUID(), image, 'image/png')).rejects.toMatchObject({ code: 'FEEDBACK_UPLOAD_RATE_LIMITED' });
  expect(await uploadFeedbackScreenshot(conn.db, config, storage, owner, id, request, image, 'image/png')).toEqual(first);
  expect(await conn.db.select().from(feedbackAttachments).where(and(eq(feedbackAttachments.wallet, owner.wallet), eq(feedbackAttachments.requestId, request)))).toHaveLength(1);
});
it('keeps private staff activity independent of the fixed reporter allocation within the total cap', async () => {
  const id = await report();
  await conn.db.update(feedbackAttachments).set({ createdAt: new Date(0) }).where(eq(feedbackAttachments.wallet, owner.wallet));
  await conn.db.insert(feedbackAttachments).values(Array.from({ length: LIMIT.maxStaffPerThread }, () => ({ wallet: admin.wallet, uploadRole: 'admin', reportId: id, requestId: randomUUID(), expiresAt: new Date(Date.now() + 60000) })));
  const capacity = LIMIT.maxPerThread - LIMIT.maxStaffPerThread;
  for (let i = 0; i < capacity; i++) {
    expect(await uploadFeedbackScreenshot(conn.db, config, storage, owner, id, randomUUID(), image, 'image/png')).toHaveProperty('id');
  }
  await conn.db.update(feedbackAttachments).set({ createdAt: new Date(0) }).where(eq(feedbackAttachments.wallet, owner.wallet));
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, id, randomUUID(), image, 'image/png')).rejects.toMatchObject({ code: 'FEEDBACK_ATTACHMENTS_FULL' });
  const rows = await conn.db.select().from(feedbackAttachments).where(eq(feedbackAttachments.reportId, id));
  expect(rows).toHaveLength(LIMIT.maxPerThread);
  const staff = rows.find(row => row.uploadRole === 'admin')!;
  await conn.db.update(feedbackAttachments).set({ state: 'deleted' }).where(eq(feedbackAttachments.id, staff.id));
  // Hidden staff deletion also cannot change what a reporter observes.
  await expect(uploadFeedbackScreenshot(conn.db, config, storage, owner, id, randomUUID(), image, 'image/png')).rejects.toMatchObject({ code: 'FEEDBACK_ATTACHMENTS_FULL' });
});
it('binds exactly the reviewed screenshots with the reply and rolls everything back on changed attachments', async () => {
  await conn.db.update(feedbackAttachments).set({ createdAt: new Date(0) }).where(eq(feedbackAttachments.wallet, owner.wallet));
  const id = await report();
  const uploaded = await uploadFeedbackScreenshot(conn.db, config, storage, owner, id, randomUUID(), image, 'image/png');
  await expect(appendFeedbackReply(conn.db, config, owner, id, { requestId: randomUUID(), body: 'no partial reply', attachmentIds: [uploaded.id, randomUUID()] })).rejects.toMatchObject({ code: 'FEEDBACK_ATTACHMENT_CHANGED' });
  expect((await getFeedbackThread(conn.db, config, owner, id)).latestRevision).toBe(1);
  expect(await conn.db.select().from(feedbackMessages).where(eq(feedbackMessages.reportId, id))).toHaveLength(0);
  const input = { requestId: randomUUID(), body: '', attachmentIds: [uploaded.id] };
  const first = await appendFeedbackReply(conn.db, config, owner, id, input);
  expect(first.attachments).toEqual([uploaded]);
  expect(await appendFeedbackReply(conn.db, config, owner, id, input)).toEqual(first);
  await expect(appendFeedbackReply(conn.db, config, owner, id, { ...input, attachmentIds: [] })).rejects.toMatchObject({ statusCode: 400 });
  await expect(appendFeedbackReply(conn.db, config, owner, id, { ...input, body: 'changed' })).rejects.toMatchObject({ code: 'FEEDBACK_REPLY_CONFLICT' });
  await expect(appendFeedbackReply(conn.db, config, owner, id, { requestId: randomUUID(), body: 'reuse', attachmentIds: [uploaded.id] })).rejects.toMatchObject({ code: 'FEEDBACK_ATTACHMENT_CHANGED' });
  await conn.db.update(feedbackAttachments).set({ state: 'deleted', deletedAt: new Date() }).where(eq(feedbackAttachments.id, uploaded.id));
  expect((await getFeedbackThread(conn.db, config, owner, id)).messages[0]!.attachments[0]!.expired).toBe(true);
});
it('serializes competing replies so a screenshot cannot attach to two messages', async () => {
  const id = await report();
  const uploaded = await uploadFeedbackScreenshot(conn.db, config, storage, owner, id, randomUUID(), image, 'image/png');
  const results = await Promise.allSettled([1, 2].map(() => appendFeedbackReply(conn.db, config, owner, id, { requestId: randomUUID(), body: 'one image', attachmentIds: [uploaded.id] })));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'FEEDBACK_ATTACHMENT_CHANGED' } });
  const thread = await getFeedbackThread(conn.db, config, owner, id);
  expect(thread.messages).toHaveLength(1); expect(thread.latestRevision).toBe(2);
});
it('keeps private note attachments outside reporter thread metadata and rejects foreign or duplicate selections', async () => {
  await conn.db.update(feedbackAttachments).set({ createdAt: new Date(0) }).where(eq(feedbackAttachments.wallet, admin.wallet));
  const id = await report();
  const uploaded = await uploadFeedbackScreenshot(conn.db, config, storage, admin, id, randomUUID(), image, 'image/png');
  const before = await getFeedbackThread(conn.db, config, owner, id);
  await expect(appendFeedbackReply(conn.db, config, owner, id, { requestId: randomUUID(), body: 'forged id', attachmentIds: [uploaded.id] })).rejects.toMatchObject({ code: 'FEEDBACK_ATTACHMENT_CHANGED' });
  await expect(appendFeedbackReply(conn.db, config, admin, id, { requestId: randomUUID(), body: 'duplicate id', attachmentIds: [uploaded.id, uploaded.id] })).rejects.toMatchObject({ statusCode: 400 });
  await appendFeedbackReply(conn.db, config, admin, id, { requestId: randomUUID(), body: 'private image', visibility: 'admin', attachmentIds: [uploaded.id] });
  expect(await getFeedbackThread(conn.db, config, owner, id)).toEqual(before);
  expect((await getFeedbackThread(conn.db, config, admin, id)).messages[0]!.attachments).toEqual([uploaded]);
  await expect(readFeedbackScreenshot(conn.db, config, storage, owner, id, uploaded.id)).rejects.toMatchObject({ statusCode: 404 });
});
