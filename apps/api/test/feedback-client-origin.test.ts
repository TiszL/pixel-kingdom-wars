/** WHY (owner 2026-09-18): "I want to receive android feedback visible marked sent
 * from android app." Until now a report from the native Android app and one from
 * the web client opened on an Android phone looked the same in triage and in the
 * private export. The server now stamps which client sent a report, reply or
 * evidence — from the REQUEST HEADERS ONLY — and lists/exports can filter on it.
 *
 * The header is spoofable by design, so these tests also pin that it is nothing
 * more than a label: a body can never set it, it never changes idempotency, and it
 * never changes what a report earns. */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { FEEDBACK_THREADS, feedbackOrigin } from '@shardkeep/shared/feedback';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { feedbackIssueLinks, feedbackIssues, feedbackMessages, testerFeedback } from '../src/db/schema';
import { writeFeedbackExport } from '../src/game/feedbackExportFormat';
import { frozenFeedbackExportReports, requestFeedbackExport } from '../src/game/feedbackExports';
import { feedbackClientOrigin } from '../src/game/feedbackOrigin';
import { reviewFeedbackReward } from '../src/game/feedbackRewards';
import { adminListTesterFeedback } from '../src/game/tester';
import { TEST_CONFIG, connectTestDb } from './helpers';

let app: FastifyInstance;
let conn: ReturnType<typeof connectTestDb>;
let admin: string, adminCookie: string;
const folders: string[] = [];
const NATIVE_BUILD = '984ad65f'.padEnd(40, 'a');
const NATIVE = { 'x-pkw-client': 'android-native', 'user-agent': 'PKW-Native/0.5.4' };
const nativeContext = { platform: 'android', screen: 'feedback', build: NATIVE_BUILD };

async function player() {
  const secret = utils.randomSecretKey(), wallet = bs58.encode(await getPublicKeyAsync(secret));
  const challenge = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message), secret));
  const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  expect(verified.statusCode).toBe(200);
  return { wallet, cookies: { [SESSION_COOKIE]: verified.cookies.find(c => c.name === SESSION_COOKIE)!.value } };
}
const report = (extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), category: 'bug', title: 'Walls cannot be built',
  body: 'Placing a wall segment on my phone does nothing at all.', ...extra });
const stored = async (id: string) => (await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id, id)))[0]!;
async function submit(who: Awaited<ReturnType<typeof player>>, payload: Record<string, unknown>, headers: Record<string, string> = {}) {
  const response = await app.inject({ method: 'POST', url: '/tester/feedback', cookies: who.cookies, headers, payload });
  expect(response.statusCode).toBe(200);
  return response.json() as { id: string; basePoints: number; dailyRemaining: number };
}

beforeAll(async () => {
  conn = connectTestDb();
  const key = utils.randomSecretKey(); admin = bs58.encode(await getPublicKeyAsync(key));
  app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: [admin] }, conn.db);
  const challenge = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet: admin } });
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message), key));
  const verified = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet: admin, signature } });
  adminCookie = verified.cookies.find(c => c.name === SESSION_COOKIE)!.value;
});
afterAll(async () => {
  await app?.close(); await conn?.sql.end();
  await Promise.all(folders.map(path => rm(path, { recursive: true, force: true })));
});

it('stamps a report sent by the Android app from its request headers', async () => {
  const who = await player();
  const receipt = await submit(who, report({ context: nativeContext }), NATIVE);
  expect((await stored(receipt.id)).context).toEqual({ screen: 'feedback', build: NATIVE_BUILD, platform: 'android', client: 'android-native', clientRelease: '0.5.4' });
  expect(feedbackOrigin((await stored(receipt.id)).context).label).toBe('ANDROID APP 0.5.4');
});

it('never lets a request BODY claim the Android app, and keeps web reports web', async () => {
  const who = await player();
  // A browser on an Android phone, forging every body field it can think of.
  const forged = await submit(who, report({ client: 'android-native', origin: { client: 'android-native', clientRelease: '9.9.9' },
    context: { platform: 'android', screen: 'tester', build: 'cee3869', client: 'android-native', clientRelease: '9.9.9' } }),
  { 'user-agent': 'PKW-Native/9.9.9' }); // The User-Agent alone is not the app either.
  expect((await stored(forged.id)).context).toEqual({ screen: 'tester', build: 'cee3869', platform: 'android', client: 'web' });
  expect(feedbackOrigin((await stored(forged.id)).context).label).toBe('WEB · android');
  // The reverse forgery cannot hide a native report as web.
  const native = await submit(who, report({ context: { ...nativeContext, client: 'web' } }), NATIVE);
  expect((await stored(native.id)).context).toMatchObject({ client: 'android-native', clientRelease: '0.5.4' });
  for (const value of ['Android-Native', 'android-native-spoof', 'web', '']) {
    expect(feedbackClientOrigin({ 'x-pkw-client': value, 'user-agent': 'PKW-Native/0.5.4' })).toEqual({ client: 'web' });
  }
  expect(feedbackClientOrigin({ 'x-pkw-client': ['android-native', 'android-native'] })).toEqual({ client: 'web' });
});

it('drops a release that is not a short plain version instead of storing or printing it', async () => {
  const who = await player();
  const receipt = await submit(who, report(), { ...NATIVE, 'user-agent': 'PKW-Native/0.5.4 <img src=x>' });
  expect((await stored(receipt.id)).context).toEqual({ client: 'android-native' });
  for (const agent of [`PKW-Native/${'9'.repeat(FEEDBACK_THREADS.clientReleaseMaxLen + 1)}`, 'PKW-Native/', 'okhttp/4.12.0',
    'Mozilla/5.0 PKW-Native/0.5.4', 'PKW-Native/0.5.4\nX-Evil: 1', 'PKW-Native/0.5.4;drop', undefined]) {
    expect(feedbackClientOrigin({ 'x-pkw-client': 'android-native', 'user-agent': agent })).toEqual({ client: 'android-native' });
  }
  expect(feedbackClientOrigin({ 'x-pkw-client': 'android-native', 'user-agent': `PKW-Native/0.5.4-candidate:20:${NATIVE_BUILD}` }))
    .toEqual({ client: 'android-native', clientRelease: `0.5.4-candidate:20:${NATIVE_BUILD}` });
});

it('replays a lost response after the app updated instead of calling the retry a changed request', async () => {
  // The native outbox retries the SAME request ID; the label must stay outside the idempotency hash.
  const who = await player(), payload = report({ context: nativeContext });
  const first = await submit(who, payload, NATIVE);
  expect(await submit(who, payload, { ...NATIVE, 'user-agent': 'PKW-Native/0.5.5' })).toEqual(first);
  expect(await submit(who, payload)).toEqual(first);
  expect((await stored(first.id)).context).toMatchObject({ client: 'android-native', clientRelease: '0.5.4' });
});

it('stamps replies and private evidence the same way', async () => {
  const who = await player(), receipt = await submit(who, report());
  const reply = { requestId: randomUUID(), body: 'Still happening after the update', client: 'android-native' };
  expect((await app.inject({ method: 'POST', url: `/tester/feedback/${receipt.id}/replies`, cookies: who.cookies, headers: NATIVE, payload: reply })).statusCode).toBe(400); // strict body
  const { client: _forged, ...cleanReply } = reply;
  const sent = await app.inject({ method: 'POST', url: `/tester/feedback/${receipt.id}/replies`, cookies: who.cookies, headers: NATIVE, payload: cleanReply });
  expect(sent.statusCode).toBe(200);
  const replayed = await app.inject({ method: 'POST', url: `/tester/feedback/${receipt.id}/replies`, cookies: who.cookies, payload: cleanReply });
  expect(replayed.statusCode).toBe(200); expect(replayed.json().id).toBe(sent.json().id);
  const staff = await app.inject({ method: 'POST', url: `/admin/tester/feedback/${receipt.id}/replies`, cookies: { [SESSION_COOKIE]: adminCookie }, payload: { requestId: randomUUID(), body: 'Thank you, checking' } });
  expect(staff.statusCode).toBe(200);
  const messages = await conn.db.select().from(feedbackMessages).where(eq(feedbackMessages.reportId, receipt.id)).orderBy(feedbackMessages.revision);
  expect(messages.map(m => m.context)).toEqual([
    { authorRole: 'reporter', attachmentIds: [], client: 'android-native', clientRelease: '0.5.4' },
    { authorRole: 'admin', attachmentIds: [], client: 'web' },
  ]);
  // The reporter's own thread never carries message context, so no page of theirs changes.
  const thread = await app.inject({ method: 'GET', url: `/tester/feedback/${receipt.id}/thread`, cookies: who.cookies });
  expect(thread.body).not.toContain('android-native'); expect(thread.body).not.toContain('clientRelease');

  const [issue] = await conn.db.insert(feedbackIssues).values({ title: 'Walls', body: 'Curated', category: 'bug', approvedBy: admin, status: 'open', publishedAt: new Date() }).returning();
  const evidence = await app.inject({ method: 'POST', url: `/tester/issues/${issue!.id}/evidence`, cookies: who.cookies, headers: NATIVE,
    payload: { requestId: randomUUID(), mode: 'evidence', title: 'Same on my phone', body: 'The wall tray never places a segment.', context: nativeContext } });
  expect(evidence.statusCode).toBe(200);
  expect((await stored(evidence.json().reportId)).context).toMatchObject({ client: 'android-native', clientRelease: '0.5.4' });
});

it('filters the admin list to Android-app reports, inferring rows older than the stamp', async () => {
  const who = await player();
  const [issue] = await conn.db.insert(feedbackIssues).values({ title: 'Origin fixture', body: 'Isolates this test', approvedBy: admin }).returning();
  const contexts: Array<Record<string, unknown> | null> = [
    { ...nativeContext, client: 'android-native', clientRelease: '0.5.4' }, // stamped native
    nativeContext,                                                          // legacy native: sent before the stamp existed
    { platform: 'android', screen: 'tester', build: 'cee3869' },            // web client on an Android phone
    { platform: 'desktop', screen: 'tester', build: 'cee3869', client: 'web' },
    { ...nativeContext, client: 'web' },                                    // the stamp outranks the legacy signature
    null,
  ];
  const rows = await conn.db.insert(testerFeedback).values(contexts.map(context => ({ wallet: who.wallet, category: 'bug', title: 'Origin', body: 'Origin filter fixture', context }))).returning();
  await conn.db.insert(feedbackIssueLinks).values(rows.map(row => ({ reportId: row.id, issueId: issue!.id, linkedBy: admin })));
  const page = async (query: string) => {
    const response = await app.inject({ method: 'GET', url: `/admin/tester/feedback/page?issueId=${issue!.id}${query}`, cookies: { [SESSION_COOKIE]: adminCookie } });
    expect(response.statusCode).toBe(200);
    return (response.json().feedback as Array<{ id: string }>).map(row => row.id).sort();
  };
  const expected = (client: string) => rows.filter(row => feedbackOrigin(row.context).client === client).map(row => row.id).sort();
  expect(expected('android-native')).toEqual([rows[0]!.id, rows[1]!.id].sort());
  // The SQL filter and the shared read-time helper must agree row for row.
  expect(await page('&client=android-native')).toEqual(expected('android-native'));
  expect(await page('&client=web')).toEqual(expected('web'));
  expect(await page('')).toEqual(rows.map(row => row.id).sort());
  expect((await app.inject({ method: 'GET', url: '/admin/tester/feedback/page?client=ios', cookies: { [SESSION_COOKIE]: adminCookie } })).statusCode).toBe(400);
  expect((await app.inject({ method: 'GET', url: '/admin/tester/feedback/page?client=android-native', cookies: who.cookies })).statusCode).toBe(403);
  // The legacy list endpoint takes the same filter.
  const legacy = await app.inject({ method: 'GET', url: '/admin/tester/feedback?client=android-native', cookies: { [SESSION_COOKIE]: adminCookie } });
  expect(legacy.statusCode).toBe(200);
  expect((legacy.json().feedback as Array<{ context: unknown }>).every(row => feedbackOrigin(row.context).client === 'android-native')).toBe(true);
  expect((await adminListTesterFeedback(conn.db, { client: 'web' }, 200)).every(row => feedbackOrigin(row.context).client === 'web')).toBe(true);

  // The private export selects with the same rule and says SOURCE on every report.
  const job = await requestFeedbackExport(conn.db, { ADMIN_WALLETS: [admin] }, admin, { requestId: randomUUID(), format: 'text', selection: { filter: { client: 'android-native' } } });
  const exportedIds: string[] = [];
  for await (const item of frozenFeedbackExportReports(conn.db, { ADMIN_WALLETS: [admin] }, admin, job.jobId, { read: async () => null })) {
    expect(feedbackOrigin(item.data['context']).client).toBe('android-native'); exportedIds.push(item.id);
  }
  expect(exportedIds).toEqual(expect.arrayContaining([rows[0]!.id, rows[1]!.id]));
  for (const row of rows.slice(2)) expect(exportedIds).not.toContain(row.id);
  const chosen = await requestFeedbackExport(conn.db, { ADMIN_WALLETS: [admin] }, admin, { requestId: randomUUID(), format: 'text', selection: { ids: [rows[0]!.id, rows[1]!.id, rows[2]!.id] } });
  const folder = await mkdtemp(join(tmpdir(), 'pkw-origin-export-')); folders.push(folder);
  const artifact = await writeFeedbackExport(folder, 'text', { jobId: chosen.jobId, createdAt: chosen.createdAt },
    frozenFeedbackExportReports(conn.db, { ADMIN_WALLETS: [admin] }, admin, chosen.jobId, { read: async () => null }));
  const text = await readFile(artifact.path, 'utf8');
  for (const [row, source] of [[rows[0]!, 'SOURCE: ANDROID APP 0.5.4'], [rows[1]!, 'SOURCE: ANDROID APP'], [rows[2]!, 'SOURCE: WEB · android']] as const) {
    expect(text).toContain(`${source}\nREPORT ${row.id} `);
  }
});

it('earns exactly what a web report earns: the label is never a reward input', async () => {
  const native = await player(), web = await player();
  const receipts = [await submit(native, report({ context: nativeContext }), NATIVE), await submit(web, report({ context: { platform: 'desktop', screen: 'tester', build: 'cee3869' } }))];
  expect(receipts.map(r => [r.basePoints, r.dailyRemaining])).toEqual([[0, receipts[1]!.dailyRemaining], [0, receipts[1]!.dailyRemaining]]);
  const awards = [];
  for (const receipt of receipts) {
    const [issue] = await conn.db.insert(feedbackIssues).values({ title: 'Reward parity', body: 'Curated', approvedBy: admin }).returning();
    await conn.db.insert(feedbackIssueLinks).values({ reportId: receipt.id, issueId: issue!.id, linkedBy: admin });
    const decision = await reviewFeedbackReward(conn.db, { ADMIN_WALLETS: [admin] }, admin, receipt.id, { requestId: randomUUID(), expectedRevision: 1,
      status: 'accepted', verdict: 'actionable', award: 'first_actionable', importance: 'medium', reason: 'Verified', verificationEvidence: 'Reproduced' });
    awards.push({ basePoints: decision.basePoints, bonusPoints: decision.bonusPoints, points: decision.points });
  }
  expect(awards[0]!.points).toBeGreaterThan(0); expect(awards[0]).toEqual(awards[1]);
  // Guard the money path at the source too: reward code must never learn the label exists.
  const rewards = await readFile(new URL('../src/game/feedbackRewards.ts', import.meta.url), 'utf8');
  expect(rewards).not.toMatch(/feedbackOrigin|clientRelease|x-pkw-client|'client'/i);
});
