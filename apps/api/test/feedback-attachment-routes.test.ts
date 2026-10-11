import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { FEEDBACK_SCREENSHOTS as LIMIT } from '@shardkeep/shared/feedback';
import bs58 from 'bs58';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { testerFeedback } from '../src/db/schema';
import { acquireFeedbackPermit, FeedbackStorageBusyError, type FeedbackScreenshotStorage } from '../src/game/feedbackStorage';
import { TEST_CONFIG, connectTestDb } from './helpers';

let app: FastifyInstance; let conn: ReturnType<typeof connectTestDb>;
let owner: string; let admin: string; let ownerCookie: string; let otherCookie: string; let adminCookie: string;
let reportId: string; let png: Buffer; let failStorage = false;
const objects = new Map<string, Buffer>(); let puts = 0; let reads = 0;
const storage: FeedbackScreenshotStorage = {
  async put(key, image) { puts++; if (failStorage) throw new Error('provider-secret feedback/private-object-key'); objects.set(key, image.bytes); return 'created'; },
  async read(key) { reads++; return objects.get(key) ?? null; }, async delete(key) { objects.delete(key); },
};
async function keypair() { const secret = utils.randomSecretKey(); return { secret, wallet: bs58.encode(await getPublicKeyAsync(secret)) }; }
async function login(key: Awaited<ReturnType<typeof keypair>>) {
  const challenge = await app.inject({ url: '/auth/challenge', query: { wallet: key.wallet } });
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message), key.secret));
  const response = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: key.wallet, signature } });
  expect(response.statusCode).toBe(200); return response.cookies.find((c) => c.name === SESSION_COOKIE)!.value;
}
const cookies = (cookie: string) => ({ [SESSION_COOKIE]: cookie });
const path = (id = randomUUID(), staff = false) => `/${staff ? 'admin/tester' : 'tester'}/feedback/${reportId}/screenshots/${id}`;
function allPermitsFree() {
  const releases: Array<() => void> = [];
  try { for (let i = 0; i < LIMIT.maxConcurrentRawUploads; i++) releases.push(acquireFeedbackPermit('raw')); }
  finally { releases.forEach((release) => release()); }
}
beforeAll(async () => {
  conn = connectTestDb(); const o = await keypair(); const a = await keypair(); const other = await keypair(); owner = o.wallet; admin = a.wallet;
  app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [admin] }, conn.db, { feedbackScreenshotStorage: storage });
  ownerCookie = await login(o); adminCookie = await login(a); otherCookie = await login(other);
  const [report] = await conn.db.insert(testerFeedback).values({ wallet: owner, category: 'bug', title: 'Private image', body: 'Private screenshot route test' }).returning(); reportId = report!.id;
  png = await sharp({ create: { width: 10, height: 20, channels: 4, background: '#345678' } }).png().toBuffer();
});
afterAll(async () => { await app?.close(); await conn?.sql.end(); });

it('authenticates and authorizes before an oversized body is parsed, including false admin claims', async () => {
  const before = puts;
  for (const [cookie, staff, status] of [[null, false, 401], [otherCookie, false, 404], [ownerCookie, true, 404], [adminCookie, false, 404]] as const) {
    const response = await app.inject({ method: 'POST', url: path(randomUUID(), staff),
      ...(cookie ? { cookies: cookies(cookie) } : {}), headers: { 'content-type': 'image/png' }, payload: Buffer.alloc(LIMIT.maxUploadBytes + 1) });
    expect(response.statusCode).toBe(status); expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers.vary).toContain('Cookie'); allPermitsFree();
  }
  expect(puts).toBe(before);
});
it('normalizes private images and returns no object key; every read retains its own authorization', async () => {
  const requestId = randomUUID();
  const uploaded = await app.inject({ method: 'POST', url: path(requestId), cookies: cookies(ownerCookie), headers: { 'content-type': 'image/png' }, payload: png });
  expect(uploaded.statusCode).toBe(200); expect(uploaded.headers['cache-control']).toBe('private, no-store');
  expect(uploaded.json()).toMatchObject({ width: 10, height: 20, contentType: 'image/webp' });
  expect(uploaded.body).not.toContain('objectKey'); expect(uploaded.body).not.toContain('feedback/');
  const imageId = uploaded.json().id;
  const result = await app.inject({ url: path(imageId), cookies: cookies(ownerCookie) });
  expect(result.statusCode).toBe(200); expect(result.headers['content-type']).toBe('image/webp');
  expect(result.headers['cache-control']).toBe('private, no-store'); expect(result.headers['x-content-type-options']).toBe('nosniff');
  expect((await sharp(result.rawPayload).metadata()).format).toBe('webp');
  const readCount = reads;
  expect((await app.inject({ url: path(imageId), cookies: cookies(otherCookie) })).statusCode).toBe(404);
  expect(reads).toBe(readCount);
  const repeated = await app.inject({ method: 'POST', url: path(requestId), cookies: cookies(ownerCookie), headers: { 'content-type': 'image/png' }, payload: png });
  expect(repeated.json().id).toBe(imageId); allPermitsFree();
});
it('keeps staff draft screenshots out of reporter routes', async () => {
  const uploaded = await app.inject({ method: 'POST', url: path(randomUUID(), true), cookies: cookies(adminCookie), headers: { 'content-type': 'image/png' }, payload: png });
  expect(uploaded.statusCode).toBe(200); const id = uploaded.json().id; const before = reads;
  expect((await app.inject({ url: path(id), cookies: cookies(ownerCookie) })).statusCode).toBe(404); expect(reads).toBe(before);
  expect((await app.inject({ url: path(id, true), cookies: cookies(adminCookie) })).statusCode).toBe(200);
});
it('rejects corrupt, oversized and unsupported media and leaves raw permits usable', async () => {
  const before = puts;
  for (const [type, bytes, status] of [['image/png', Buffer.from('truncated'), 422], ['image/png', Buffer.alloc(LIMIT.maxUploadBytes + 1), 413], ['image/svg+xml', Buffer.from('<svg/>'), 415]] as const) {
    const result = await app.inject({ method: 'POST', url: path(), cookies: cookies(ownerCookie), headers: { 'content-type': type }, payload: bytes });
    expect(result.statusCode).toBe(status); expect(result.headers['cache-control']).toBe('private, no-store'); allPermitsFree();
  }
  expect(puts).toBe(before);
  const unrelated = await app.inject({ method: 'POST', url: '/tester/feedback', cookies: cookies(ownerCookie), headers: { 'content-type': 'image/png' }, payload: png });
  expect(unrelated.statusCode).toBe(415);
});
it('sanitizes provider failures while retaining an exact upload retry', async () => {
  const id = randomUUID(); failStorage = true;
  try {
    const result = await app.inject({ method: 'POST', url: path(id), cookies: cookies(ownerCookie), headers: { 'content-type': 'image/png' }, payload: png });
    expect(result.statusCode).toBe(503); expect(result.body).not.toMatch(/provider-secret|private-object-key/);
    expect(result.headers['cache-control']).toBe('private, no-store'); allPermitsFree();
  } finally { failStorage = false; }
  expect((await app.inject({ method: 'POST', url: path(id), cookies: cookies(ownerCookie), headers: { 'content-type': 'image/png' }, payload: png })).statusCode).toBe(200);
});
it('destroys incomplete bodies at the receive deadline and releases client-aborted capacity', async () => {
  const slow = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [admin] }, conn.db, { feedbackScreenshotStorage: storage, feedbackUploadReceiveTimeoutMs: 500 });
  const origin = await slow.listen({ host: '127.0.0.1', port: 0 }); const requests: ReturnType<typeof httpRequest>[] = [];
  try {
    const finished = Array.from({ length: LIMIT.maxConcurrentRawUploads }, () => new Promise<void>((resolve, reject) => {
      const req = httpRequest(new URL(path(), origin), { method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${ownerCookie}`, 'content-type': 'image/png', 'content-length': String(LIMIT.maxUploadBytes) } });
      requests.push(req); const timer = setTimeout(() => { req.destroy(); reject(new Error('receive deadline did not stop body')); }, 5000);
      req.once('error', () => { clearTimeout(timer); resolve(); }); req.write(png.subarray(0, 4));
    }));
    await vi.waitFor(() => { let release: (() => void) | undefined; try { release = acquireFeedbackPermit('raw'); }
      catch (error) { expect(error).toBeInstanceOf(FeedbackStorageBusyError); return; }
      release(); throw new Error('waiting for raw admission'); }, { timeout: 500 });
    const busy = await slow.inject({ method: 'POST', url: path(), cookies: cookies(ownerCookie), headers: { 'content-type': 'image/png' }, payload: png });
    expect(busy.statusCode).toBe(503); requests[0]!.destroy(); await Promise.all(finished);
    allPermitsFree();
    expect((await slow.inject({ method: 'POST', url: path(), cookies: cookies(ownerCookie), headers: { 'content-type': 'image/png' }, payload: png })).statusCode).toBe(200);
    allPermitsFree();
  } finally { requests.forEach((req) => req.destroy()); await slow.close(); }
});
