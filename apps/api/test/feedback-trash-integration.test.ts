import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { FEEDBACK_SCREENSHOTS as LIMIT } from '@shardkeep/shared/feedback';
import bs58 from 'bs58';
import { eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { feedbackAttachments as attachments, feedbackMessages, testerFeedback as reports } from '../src/db/schema';
import { setFeedbackReportTrashed as trash } from '../src/game/feedbackReportState';
import { cleanupFeedbackScreenshots, setFeedbackScreenshotPreservation } from '../src/game/feedbackRetention';
import { feedbackObjectKey, type FeedbackScreenshotStorage } from '../src/game/feedbackStorage';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb(), ids: string[] = [], objects = new Map<string, Buffer>();
const storage: FeedbackScreenshotStorage = { async put(key, image) { objects.set(key, image.bytes); return 'created'; },
  async read(key) { return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); } };
let app: Awaited<ReturnType<typeof buildApp>>, admin: string, owner: string, adminCookie: string, ownerCookie: string;
let preserved: Pick<typeof attachments.$inferSelect, 'id' | 'preservedAt' | 'preservedBy' | 'preservationReason'>[] = [];
const now = new Date('2001-01-01T00:00:00Z'), cutoff = new Date(now.getTime() - LIMIT.closedRetentionDays * 86400000);
const cookie = (value: string) => ({ [SESSION_COOKIE]: value });
const request = (revision = 1, trashed = true) => ({ requestId: randomUUID(), expectedRevision: revision, trashed, reason: 'Private moderation reason' });
beforeAll(async () => {
  const makeKey = async () => { const secret = utils.randomSecretKey(); return { secret, wallet: bs58.encode(await getPublicKeyAsync(secret)) }; };
  const a = await makeKey(), o = await makeKey(); admin = a.wallet; owner = o.wallet;
  app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [admin] }, conn.db, { feedbackScreenshotStorage: storage });
  const login = async (key: typeof a) => {
    const challenge = await app.inject({ url: '/auth/challenge', query: { wallet: key.wallet } });
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message), key.secret));
    const response = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: key.wallet, signature } });
    expect(response.statusCode).toBe(200); return response.cookies.find(c => c.name === SESSION_COOKIE)!.value;
  };
  adminCookie = await login(a); ownerCookie = await login(o);
  // The broad workspace runs suites serially on one DB: preserve unrelated
  // fixtures while exercising the real global retention sweep, then restore.
  preserved = await conn.db.select({ id: attachments.id, preservedAt: attachments.preservedAt,
    preservedBy: attachments.preservedBy, preservationReason: attachments.preservationReason }).from(attachments);
  if (preserved.length) await conn.db.update(attachments).set({ preservedAt: now, preservedBy: admin, preservationReason: 'isolated trash retention test' })
    .where(inArray(attachments.id, preserved.map(a => a.id)));
});
afterEach(async () => {
  if (ids.length) {
    await conn.db.delete(attachments).where(inArray(attachments.reportId, ids));
    await conn.db.delete(feedbackMessages).where(inArray(feedbackMessages.reportId, ids));
    await conn.db.delete(reports).where(inArray(reports.id, ids));
    ids.length = 0;
  }
  objects.clear();
});
afterAll(async () => {
  try { for (const { id, ...values } of preserved) await conn.db.update(attachments).set(values).where(eq(attachments.id, id)); }
  finally { await app?.close(); await conn.sql.end(); }
});
async function report() {
  const [r] = await conn.db.insert(reports).values({ wallet: owner, category: 'bug', title: 'Private trash fixture', body: 'Private evidence',
    rewardPolicyVersion: 2, points: 10, basePoints: 10 }).returning(); ids.push(r!.id); return r!;
}
async function image() {
  const r = await report(), key = feedbackObjectKey('a'.repeat(64));
  const [a] = await conn.db.insert(attachments).values({ reportId: r.id, wallet: owner, requestId: randomUUID(), state: 'attached',
    objectKey: key, sha256: 'a'.repeat(64), width: 1, height: 1, byteLength: 1, contentType: 'image/webp', expiresAt: now }).returning();
  objects.set(key, Buffer.from('image')); return { r, a: a! };
}

it('HTTP permits admin evidence inspection in trash while hiding reporter lists, threads and images and denying writes', async () => {
  const r = await report(), active = await report();
  const png = await sharp({ create: { width: 2, height: 2, channels: 4, background: '#123456' } }).png().toBuffer();
  const base = `/tester/feedback/${r.id}`, staff = `/admin/tester/feedback/${r.id}`;
  const uploaded = await app.inject({ method: 'POST', url: `${base}/screenshots/${randomUUID()}`, cookies: cookie(ownerCookie), headers: { 'content-type': 'image/png' }, payload: png });
  expect(uploaded.statusCode).toBe(200);
  const sent = await app.inject({ method: 'POST', url: `${base}/replies`, cookies: cookie(ownerCookie), payload: { requestId: randomUUID(), body: '', attachmentIds: [uploaded.json().id] } });
  expect(sent.statusCode).toBe(200);
  await trash(conn.db, { ADMIN_WALLETS: [admin] }, admin, r.id, request(2));
  const read = await app.inject({ url: `${staff}/screenshots/${uploaded.json().id}`, cookies: cookie(adminCookie) });
  expect(read.statusCode).toBe(200); expect((await sharp(read.rawPayload).metadata()).format).toBe('webp');
  expect(read.headers['cache-control']).toBe('private, no-store');
  for (const url of [`${base}/thread`, `${base}/screenshots/${uploaded.json().id}`]) {
    const denied = await app.inject({ url, cookies: cookie(ownerCookie) });
    expect(denied.statusCode).toBe(404); expect(denied.headers['cache-control']).toBe('private, no-store');
  }
  for (const [prefix, auth, status] of [[base, ownerCookie, 404], [staff, adminCookie, 409]] as const) {
    expect((await app.inject({ method: 'POST', url: `${prefix}/replies`, cookies: cookie(auth), payload: { requestId: randomUUID(), body: 'blocked' } })).statusCode).toBe(status);
    expect((await app.inject({ method: 'POST', url: `${prefix}/screenshots/${randomUUID()}`, cookies: cookie(auth), headers: { 'content-type': 'image/png' }, payload: png })).statusCode).toBe(status);
  }
  for (const url of ['/tester/feedback', '/tester/feedback/page']) {
    const list = await app.inject({ url, cookies: cookie(ownerCookie) });
    expect(list.statusCode).toBe(200); expect(list.body).not.toContain(r.id); expect(list.body).toContain(active.id);
  }
  expect((await conn.db.select().from(reports).where(eq(reports.id, r.id)))[0]!.points).toBe(10);
});
it('legacy export stamps reject a stale mixed selection atomically without mutating either report', async () => {
  const removed = await report(), active = await report();
  await trash(conn.db, { ADMIN_WALLETS: [admin] }, admin, removed.id, request());
  const result = await app.inject({ method: 'POST', url: '/admin/tester/feedback/exported', cookies: cookie(adminCookie), payload: { ids: [active.id, removed.id] } });
  expect(result.statusCode).toBe(409); expect(result.json().error.code).toBe('FEEDBACK_REPORT_TRASHED');
  expect((await conn.db.select().from(reports).where(inArray(reports.id, [active.id, removed.id]))).every(r => r.exportedAt === null)).toBe(true);
});
it('trash retention starts at 180 days, respects existing preservation and retains immutable deletion tombstones', async () => {
  const due = await image(), fresh = await image(), kept = await image();
  await setFeedbackScreenshotPreservation(conn.db, { ADMIN_WALLETS: [admin] }, admin, kept.r.id, kept.a.id,
    { requestId: randomUUID(), expectedRevision: 1, preserved: true, reason: 'Keep review evidence' });
  for (const [f, timestamp] of [[due, cutoff], [fresh, new Date(cutoff.getTime() + 1)], [kept, cutoff]] as const) {
    await trash(conn.db, { ADMIN_WALLETS: [admin] }, admin, f.r.id, request(f === kept ? 2 : 1));
    await conn.db.update(reports).set({ trashedAt: timestamp }).where(eq(reports.id, f.r.id));
  }
  expect(await cleanupFeedbackScreenshots(conn.db, storage, now)).toEqual({ examined: 1, deleted: 1, failed: 0 });
  expect((await conn.db.select().from(attachments).where(eq(attachments.id, due.a.id)))[0]).toMatchObject({ state: 'deleted', objectKey: due.a.objectKey, deleteAttempts: 1 });
  expect(objects.has(fresh.a.objectKey!)).toBe(true); expect(objects.has(kept.a.objectKey!)).toBe(true);
});
it('restore committed between discovery and claim prevents unclaimed deletion; restoration cannot resurrect a claimed image', async () => {
  const f = await image();
  await trash(conn.db, { ADMIN_WALLETS: [admin] }, admin, f.r.id, request());
  await conn.db.update(reports).set({ trashedAt: cutoff }).where(eq(reports.id, f.r.id));
  let restored = false;
  const racingDb = new Proxy(conn.db, { get(target, property) {
    if (property === 'transaction') return async (...args: Parameters<typeof conn.db.transaction>) => {
      if (!restored) { restored = true; await trash(conn.db, { ADMIN_WALLETS: [admin] }, admin, f.r.id, request(2, false)); }
      return target.transaction(...args);
    };
    return Reflect.get(target, property);
  } });
  expect(await cleanupFeedbackScreenshots(racingDb, storage, now)).toEqual({ examined: 1, deleted: 0, failed: 0 });
  expect(objects.has(f.a.objectKey!)).toBe(true);
  await trash(conn.db, { ADMIN_WALLETS: [admin] }, admin, f.r.id, request(3));
  await conn.db.update(reports).set({ trashedAt: cutoff }).where(eq(reports.id, f.r.id));
  const deleting = { ...storage, async delete(key: string) {
    await trash(conn.db, { ADMIN_WALLETS: [admin] }, admin, f.r.id, request(4, false)); objects.delete(key);
  } };
  expect((await cleanupFeedbackScreenshots(conn.db, deleting, now)).deleted).toBe(1);
  expect((await conn.db.select().from(attachments).where(eq(attachments.id, f.a.id)))[0]!.state).toBe('deleted');
});
