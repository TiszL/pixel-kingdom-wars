import { randomUUID } from 'node:crypto';
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { feedbackExportReports, feedbackMessages, feedbackRewardDecisions, players, testerFeedback } from '../src/db/schema';
import { setFeedbackReportFixed as fixed, setFeedbackReportTrashed as trash } from '../src/game/feedbackReportState';
import { requestFeedbackExport } from '../src/game/feedbackExports';
import { getFeedbackThread } from '../src/game/feedbackThreads';
import { adminListTesterFeedback, adminPageTesterFeedback, listMyTesterFeedback } from '../src/game/tester';
import { listReporterFeedbackPage } from '../src/game/feedbackReporterPage';
import { reviewFeedbackReward } from '../src/game/feedbackRewards';
import { connectTestDb, TEST_CONFIG } from './helpers';

const conn = connectTestDb();
afterAll(async () => { await conn.sql.end(); });
async function fixture(policy = 2, status: 'new' | 'reviewed' | 'accepted' | 'rejected' | 'duplicate' = 'new') {
  const owner = randomUUID(), admin = randomUUID(), closedAt = new Date('2026-01-01');
  await conn.db.insert(players).values([{ wallet: owner }, { wallet: admin }]);
  const [report] = await conn.db.insert(testerFeedback).values({ wallet: owner, category: 'bug', title: 'State fixture',
    body: 'Private evidence', rewardPolicyVersion: policy, status, basePoints: 10, bonusPoints: 5, points: 15, closedAt }).returning();
  const id = report!.id, config = { ADMIN_WALLETS: [admin] };
  if (policy === 2) await conn.db.insert(feedbackRewardDecisions).values({ reportId: id, wallet: owner, admin,
    requestId: 'prior-award', requestHash: 'a'.repeat(64), policyVersion: 2, reportRevision: 1,
    reason: 'Verified useful evidence', receipt: { delta: 15, points: 15 } });
  return { owner, admin, id, config, closedAt };
}
async function row(id: string) { return (await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id, id)))[0]!; }
async function rewards(id: string) { return conn.db.select().from(feedbackRewardDecisions).where(eq(feedbackRewardDecisions.reportId, id)); }
const mark = { requestId: 'fixed', expectedRevision: 1, fixed: true, fixedRef: 'release-sha', reason: 'Verified fix' };
const remove = { requestId: 'trash', expectedRevision: 1, trashed: true, reason: 'Private staff reason' };

it.each([1, 2])('policy %i fixed/clear preserves earned points, receipts and triage on clearing', async policy => {
  const f = await fixture(policy, 'accepted'), before = await rewards(f.id);
  const result = await fixed(conn.db, f.config, f.admin, f.id, mark);
  expect(result).toMatchObject({ fixed: true, fixedRef: 'release-sha', status: 'fixed', revision: 2, reporterRevision: 2 });
  const again = await fixed(conn.db, f.config, f.admin, f.id, { ...mark, requestId: 'ref', expectedRevision: 2, fixedRef: 'next-release' });
  expect(again.fixedAt).toBe(result.fixedAt);
  const cleared = await fixed(conn.db, f.config, f.admin, f.id, { ...mark, requestId: 'clear', expectedRevision: 3, fixed: false });
  expect(cleared).toMatchObject({ status: 'accepted', fixed: false, fixedAt: null, fixedRef: null });
  expect(await row(f.id)).toMatchObject({ basePoints: 10, bonusPoints: 5, points: 15, closedAt: f.closedAt, rewardPolicyVersion: policy });
  expect(await rewards(f.id)).toEqual(before);
  const thread = await getFeedbackThread(conn.db, f.config, { wallet: f.owner, mode: 'reporter' }, f.id);
  expect(thread.messages.map(m => m.body)).toEqual(['Marked fixed: Verified fix', 'Marked fixed: Verified fix', 'Fixed mark cleared: Verified fix']);
});
it.each(['new', 'reviewed', 'rejected', 'duplicate'] as const)('fixed refuses %s until accepted and clear preserves that triage', async status => {
  const f = await fixture(2, status);
  await expect(fixed(conn.db, f.config, f.admin, f.id, mark)).rejects.toMatchObject({ code: 'FEEDBACK_FIXED_CONFLICT' });
  expect(await fixed(conn.db, f.config, f.admin, f.id, { ...mark, fixed: false })).toMatchObject({ status });
});
it('fixed retries are immutable, concurrent changes require a fresh review and request IDs cannot cross actions', async () => {
  const f = await fixture(2, 'accepted');
  const [a, b] = await Promise.all([1, 2].map(() => fixed(conn.db, f.config, f.admin, f.id, mark)));
  expect(a).toEqual(b);
  await expect(fixed(conn.db, f.config, f.admin, f.id, { ...mark, reason: 'different' })).rejects.toMatchObject({ code: 'FEEDBACK_MODERATION_CONFLICT' });
  await expect(trash(conn.db, f.config, f.admin, f.id, { ...remove, requestId: 'fixed', expectedRevision: 2 })).rejects.toMatchObject({ code: 'FEEDBACK_MODERATION_CONFLICT' });
  const changes = await Promise.allSettled(['first', 'second'].map(requestId => fixed(conn.db, f.config, f.admin, f.id,
    { ...mark, requestId, expectedRevision: 2, fixed: false })));
  expect(changes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(changes.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'FEEDBACK_REVIEW_STALE' } });
  expect(await fixed(conn.db, f.config, f.admin, f.id, mark)).toEqual(a);
  expect(await row(f.id)).toMatchObject({ revision: 3, fixedAt: null });
});
it.each([1, 2])('policy %i trash/restore is private, replay-safe and preserves rewards, fix and retention', async policy => {
  const f = await fixture(policy, 'accepted'), fixedAt = new Date('2026-02-01');
  await conn.db.update(testerFeedback).set({ fixedAt, fixedRef: 'original' }).where(eq(testerFeedback.id, f.id));
  const before = await rewards(f.id);
  const [a, b] = await Promise.all([1, 2].map(() => trash(conn.db, f.config, f.admin, f.id, remove)));
  expect(a).toEqual(b); expect(a).toMatchObject({ trashed: true, revision: 2, reporterRevision: 1 });
  await expect(getFeedbackThread(conn.db, f.config, { wallet: f.owner, mode: 'reporter' }, f.id)).rejects.toMatchObject({ statusCode: 404 });
  await expect(fixed(conn.db, f.config, f.admin, f.id, { ...mark, expectedRevision: 2 })).rejects.toMatchObject({ code: 'FEEDBACK_REPORT_TRASHED' });
  await expect(trash(conn.db, f.config, f.admin, f.id, { ...remove, requestId: 'stale', trashed: false })).rejects.toMatchObject({ code: 'FEEDBACK_REVIEW_STALE' });
  const restored = await trash(conn.db, f.config, f.admin, f.id, { ...remove, requestId: 'restore', expectedRevision: 2, trashed: false });
  expect(restored).toMatchObject({ trashed: false, trashedAt: null, revision: 3, reporterRevision: 1 });
  expect(await trash(conn.db, f.config, f.admin, f.id, remove)).toEqual(a);
  expect(await row(f.id)).toMatchObject({ trashedAt: null, trashedBy: null, trashReason: null,
    fixedAt, fixedRef: 'original', closedAt: f.closedAt, status: 'accepted', points: 15, basePoints: 10, bonusPoints: 5 });
  expect(await rewards(f.id)).toEqual(before);
  expect((await getFeedbackThread(conn.db, f.config, { wallet: f.owner, mode: 'reporter' }, f.id)).messages).toEqual([]);
  const history = await conn.db.select().from(feedbackMessages).where(eq(feedbackMessages.reportId, f.id));
  expect(history).toHaveLength(2); expect(history.every(m => m.visibility === 'admin' && m.reporterRevision === null)).toBe(true);
  expect(history.every(m => m.body?.includes(remove.reason) === true)).toBe(true);
});
it('new exports exclude trash while prior frozen selections and exact retries retain their original history', async () => {
  const f = await fixture();
  const input = { requestId: randomUUID(), format: 'json' as const, selection: { ids: [f.id] } };
  const frozen = await requestFeedbackExport(conn.db, f.config, f.admin, input);
  const snapshots = await conn.db.select().from(feedbackExportReports).where(eq(feedbackExportReports.jobId, frozen.jobId));
  await trash(conn.db, f.config, f.admin, f.id, remove);
  expect(await requestFeedbackExport(conn.db, f.config, f.admin, input)).toEqual(frozen);
  await expect(requestFeedbackExport(conn.db, f.config, f.admin, { ...input, requestId: randomUUID() })).rejects.toMatchObject({ statusCode: 404 });
  const filtered = await requestFeedbackExport(conn.db, f.config, f.admin, { requestId: randomUUID(), format: 'json', selection: { filter: {} } });
  expect((await conn.db.select().from(feedbackExportReports).where(eq(feedbackExportReports.jobId, filtered.jobId))).some(r => r.reportId === f.id)).toBe(false);
  expect(await conn.db.select().from(feedbackExportReports).where(eq(feedbackExportReports.jobId, frozen.jobId))).toEqual(snapshots);
});
it('Accepted and Fixed are exclusive across admin/reporter views and exports, and reopening returns to Accepted', async () => {
  // Owner changed the lifecycle: compatibility storage may still say accepted,
  // but no API filter or current projection may show a fixed report as accepted.
  const f = await fixture(2, 'accepted');
  await fixed(conn.db, f.config, f.admin, f.id, mark);
  const hasId = (rows: Array<{ id: string }>) => rows.some(r => r.id === f.id);
  expect(hasId(await adminListTesterFeedback(conn.db, { status: 'accepted' }))).toBe(false);
  expect((await adminListTesterFeedback(conn.db, { status: 'fixed' })).find(r => r.id === f.id)).toMatchObject({ status: 'fixed' });
  expect(hasId((await adminPageTesterFeedback(conn.db, f.config, f.admin, { status: 'accepted' })).feedback)).toBe(false);
  expect((await adminPageTesterFeedback(conn.db, f.config, f.admin, { status: 'fixed' })).feedback.find(r => r.id === f.id)).toMatchObject({ status: 'fixed' });
  expect((await listMyTesterFeedback(conn.db, f.owner))[0]).toMatchObject({ status: 'fixed' });
  expect((await listReporterFeedbackPage(conn.db, f.owner)).feedback[0]).toMatchObject({ status: 'fixed' });
  for (const mode of ['reporter', 'admin'] as const) expect((await getFeedbackThread(conn.db, f.config,
    { wallet: mode === 'admin' ? f.admin : f.owner, mode }, f.id)).report).toMatchObject({ status: 'fixed' });
  const accepted = await requestFeedbackExport(conn.db, f.config, f.admin, { requestId: randomUUID(), format: 'json', selection: { filter: { status: 'accepted' } } });
  expect((await conn.db.select().from(feedbackExportReports).where(eq(feedbackExportReports.jobId, accepted.jobId))).some(r => r.reportId === f.id)).toBe(false);
  const exportFixed = await requestFeedbackExport(conn.db, f.config, f.admin, { requestId: randomUUID(), format: 'json', selection: { filter: { status: 'fixed' } } });
  const snapshots = await conn.db.select().from(feedbackExportReports).where(eq(feedbackExportReports.jobId, exportFixed.jobId));
  expect(snapshots.find(r => r.reportId === f.id)?.snapshot).toMatchObject({ status: 'fixed' });
  const result = await fixed(conn.db, f.config, f.admin, f.id, { ...mark, requestId: 'reopen', expectedRevision: 2, fixed: false });
  expect(result).toMatchObject({ status: 'accepted', fixed: false });
  expect(hasId(await adminListTesterFeedback(conn.db, { status: 'accepted' }))).toBe(true);
  expect(hasId((await adminPageTesterFeedback(conn.db, f.config, f.admin, { status: 'fixed' })).feedback)).toBe(false);
  expect((await listReporterFeedbackPage(conn.db, f.owner)).feedback[0]).toMatchObject({ status: 'accepted' });
  expect(await conn.db.select().from(feedbackExportReports).where(eq(feedbackExportReports.jobId, exportFixed.jobId))).toEqual(snapshots);
});
it('review decisions cannot hide a triage change under Fixed, while prior review receipts remain replayable', async () => {
  const f = await fixture(2, 'accepted');
  const input = { requestId: 'review', expectedRevision: 1, status: 'accepted' as const,
    verdict: 'unverified' as const, award: 'none' as const, reason: 'Accepted for investigation' };
  const receipt = await reviewFeedbackReward(conn.db, f.config, f.admin, f.id, input);
  const before = await rewards(f.id);
  await fixed(conn.db, f.config, f.admin, f.id, { ...mark, expectedRevision: 2 });
  await expect(reviewFeedbackReward(conn.db, f.config, f.admin, f.id,
    { ...input, requestId: 'reviewed-while-fixed', expectedRevision: 3, status: 'reviewed' }))
    .rejects.toMatchObject({ code: 'FEEDBACK_FIXED_CONFLICT' });
  expect(await reviewFeedbackReward(conn.db, f.config, f.admin, f.id, input)).toEqual(receipt);
  expect(await fixed(conn.db, f.config, f.admin, f.id, { ...mark, requestId: 'reopen', expectedRevision: 3, fixed: false }))
    .toMatchObject({ status: 'accepted', revision: 4 });
  expect(await row(f.id)).toMatchObject({ status: 'accepted', points: 15, basePoints: 10, bonusPoints: 5 });
  expect(await rewards(f.id)).toEqual(before);
});
it('both routes require a real full configured-admin session and keep denied responses private', async () => {
  const secret = utils.randomSecretKey(), wallet = bs58.encode(await getPublicKeyAsync(secret)), f = await fixture();
  const app = await buildApp({ ...TEST_CONFIG, ADMIN_WALLETS: f.config.ADMIN_WALLETS }, conn.db);
  try {
    const challenge = await app.inject({ url: '/auth/challenge', query: { wallet } });
    const signature = bs58.encode(await signAsync(new TextEncoder().encode(challenge.json().message), secret));
    const auth = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
    expect(auth.statusCode).toBe(200);
    const cookie = auth.cookies.find(c => c.name === SESSION_COOKIE)!.value;
    for (const [action, payload] of [['fixed', mark], ['trash', remove]] as const) for (const authenticated of [false, true]) {
      const result = await app.inject({ method: 'POST', url: `/admin/tester/feedback/${f.id}/${action}`, payload,
        ...(authenticated ? { cookies: { [SESSION_COOKIE]: cookie } } : {}) });
      expect(result.statusCode).toBe(authenticated ? 403 : 401);
      expect(result.headers['cache-control']).toBe('private, no-store');
    }
    await expect(fixed(conn.db, f.config, wallet, f.id, mark)).rejects.toMatchObject({ statusCode: 404 });
    await expect(trash(conn.db, f.config, wallet, f.id, remove)).rejects.toMatchObject({ statusCode: 404 });
    expect(await row(f.id)).toMatchObject({ revision: 1, trashedAt: null, fixedAt: null });
  } finally { await app.close(); }
});
