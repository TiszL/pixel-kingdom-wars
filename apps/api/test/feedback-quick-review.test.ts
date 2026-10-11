import { createHash, randomUUID } from 'node:crypto';
import { TESTER_PROGRAM } from '@shardkeep/shared';
import { FEEDBACK_THREADS } from '@shardkeep/shared/feedback';
import { and, eq } from 'drizzle-orm';
import { afterAll, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { feedbackIssueActions, feedbackIssueLinks, feedbackIssues, feedbackMessages, feedbackRewardDecisions, players, testerFeedback } from '../src/db/schema';
import { getFeedbackIssue } from '../src/game/feedbackIssues';
import { reviewFeedbackReward, type FeedbackRewardReview } from '../src/game/feedbackRewards';
import { getFeedbackThread } from '../src/game/feedbackThreads';
import { TEST_DATABASE_URL } from './db-url';

const conn = createDb(TEST_DATABASE_URL);
afterAll(async () => { await conn.sql.end(); });
async function fixture() {
  const owner = randomUUID(), admin = randomUUID(), otherAdmin = randomUUID();
  await conn.db.insert(players).values([owner, admin, otherAdmin].map(wallet => ({ wallet })));
  return { owner, admin, otherAdmin, config: { ADMIN_WALLETS: [admin, otherAdmin] } };
}
async function report(wallet: string, extra: Partial<typeof testerFeedback.$inferInsert> = {}) {
  const [row] = await conn.db.insert(testerFeedback).values({ wallet, title: 'Private report title', body: 'Private reproduction details', category: 'bug', createdAt: new Date('2026-01-12T12:00:00Z'), ...extra }).returning();
  return row!;
}
function quick(extra: Partial<FeedbackRewardReview> = {}): FeedbackRewardReview {
  return { requestId: randomUUID(), expectedRevision: 1, status: 'accepted', verdict: 'actionable', award: 'first_actionable', importance: 'medium',
    reason: 'Admin accepted this report as actionable using quick review.',
    verificationEvidence: 'Admin reviewed this report and accepted it as actionable using quick review.', preparePrivateIssue: true, ...extra };
}
async function issue() {
  const [row] = await conn.db.insert(feedbackIssues).values({ title: 'Canonical issue', body: 'Curated summary', approvedBy: 'admin' }).returning();
  return row!.id;
}
async function link(reportId: string, issueId: string) { await conn.db.insert(feedbackIssueLinks).values({ reportId, issueId, linkedBy: 'admin' }); }
async function noPreparation(admin: string, reportId: string) {
  expect(await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.approvedBy, admin))).toHaveLength(0);
  expect(await conn.db.select().from(feedbackIssueActions).where(eq(feedbackIssueActions.admin, admin))).toHaveLength(0);
  expect(await conn.db.select().from(feedbackMessages).where(and(eq(feedbackMessages.author, admin), eq(feedbackMessages.reportId, reportId)))).toHaveLength(0);
  expect(await conn.db.select().from(feedbackRewardDecisions).where(eq(feedbackRewardDecisions.reportId, reportId))).toHaveLength(0);
}

it('one explicit quick review atomically creates a private issue, links it and returns the actual award receipt', async () => {
  const f = await fixture(), r = await report(f.owner), input = quick();
  const receipt = await reviewFeedbackReward(conn.db, f.config, f.admin, r.id, input);
  expect(receipt).toMatchObject({ revision: 3, reporterRevision: 3, points: TESTER_PROGRAM.feedback.basePoints + TESTER_PROGRAM.feedback.importanceBonus.medium });
  const [created] = await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.id, receipt.issueId!));
  expect(created).toMatchObject({ title: r.title, category: r.category, publishedAt: null, status: 'open' });
  expect(created!.body).toContain(r.id); expect(created!.body).not.toContain(r.body);
  await expect(getFeedbackIssue(conn.db, receipt.issueId!)).rejects.toMatchObject({ statusCode: 404 });
  const playerThread = await getFeedbackThread(conn.db, f.config, { wallet: f.owner, mode: 'reporter' }, r.id);
  expect(playerThread.report).not.toHaveProperty('linkedIssue');
  expect(JSON.stringify(playerThread)).not.toContain(receipt.issueId!);
  expect(JSON.stringify(playerThread)).not.toContain(input.verificationEvidence!);
  expect(playerThread.messages.map(m => m.revision)).toEqual([2, 3]);
  expect(await conn.db.select().from(feedbackIssueActions).where(eq(feedbackIssueActions.admin, f.admin))).toHaveLength(1);
});

it('lost response and concurrent exact retries create and pay once, including maximum-length request IDs', async () => {
  const f = await fixture(), r = await report(f.owner), input = quick({ requestId: 'x'.repeat(FEEDBACK_THREADS.requestIdMaxLen) });
  const [a, b] = await Promise.all([reviewFeedbackReward(conn.db, f.config, f.admin, r.id, input), reviewFeedbackReward(conn.db, f.config, f.admin, r.id, input)]);
  expect(a).toEqual(b);
  await reviewFeedbackReward(conn.db, f.config, f.otherAdmin, r.id, quick({ expectedRevision: a.revision, award: 'none', importance: 'high' }));
  expect(await reviewFeedbackReward(conn.db, f.config, f.admin, r.id, input)).toEqual(a);
  expect(await conn.db.select().from(feedbackIssues).where(eq(feedbackIssues.approvedBy, f.admin))).toHaveLength(1);
  expect(await conn.db.select().from(feedbackRewardDecisions).where(eq(feedbackRewardDecisions.admin, f.admin))).toHaveLength(1);
  await expect(reviewFeedbackReward(conn.db, f.config, f.admin, r.id, { ...input, preparePrivateIssue: false })).rejects.toMatchObject({ code: 'FEEDBACK_REWARD_CONFLICT' });
});

it('the submission-day cap rolls back every preparation write, leaving the report available for a no-point decision', async () => {
  const f = await fixture();
  for (let n = 0; n < TESTER_PROGRAM.feedback.dailyPaidSubmissions; n++) await report(f.owner, { rewardPolicyVersion: 1, basePoints: TESTER_PROGRAM.feedback.basePoints, points: TESTER_PROGRAM.feedback.basePoints });
  const r = await report(f.owner);
  await expect(reviewFeedbackReward(conn.db, f.config, f.admin, r.id, quick())).rejects.toMatchObject({ code: 'FEEDBACK_REWARD_DAY_LIMIT' });
  await noPreparation(f.admin, r.id);
  expect(await conn.db.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.reportId, r.id))).toHaveLength(0);
  const [unchanged] = await conn.db.select().from(testerFeedback).where(eq(testerFeedback.id, r.id)); expect(unchanged).toEqual(r);
  expect(await reviewFeedbackReward(conn.db, f.config, f.admin, r.id, quick({ award: 'none' }))).toMatchObject({ points: 0, issueId: null, revision: 2 });
});

it('competing reviewers of one unlinked report cannot create two issues or two rewards', async () => {
  const f = await fixture(), r = await report(f.owner);
  const result = await Promise.allSettled([reviewFeedbackReward(conn.db, f.config, f.admin, r.id, quick()), reviewFeedbackReward(conn.db, f.config, f.otherAdmin, r.id, quick())]);
  expect(result.filter(value => value.status === 'fulfilled')).toHaveLength(1);
  expect(result.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'FEEDBACK_REVIEW_STALE' } });
  expect(await conn.db.select().from(feedbackIssueLinks).where(eq(feedbackIssueLinks.reportId, r.id))).toHaveLength(1);
  expect(await conn.db.select().from(feedbackRewardDecisions).where(eq(feedbackRewardDecisions.reportId, r.id))).toHaveLength(1);
});

it('quick review retains an existing canonical link and cannot escape its earlier-report or award conflict', async () => {
  const f = await fixture(), canonical = await issue(), earlier = await report(f.owner, { createdAt: new Date('2026-01-12T10:00:00Z') }), later = await report(f.owner);
  await link(earlier.id, canonical); await link(later.id, canonical);
  await expect(reviewFeedbackReward(conn.db, f.config, f.admin, later.id, quick())).rejects.toMatchObject({ code: 'FEEDBACK_EARLIER_REPORT' });
  await noPreparation(f.admin, later.id);
  expect(await reviewFeedbackReward(conn.db, f.config, f.admin, earlier.id, quick())).toMatchObject({ issueId: canonical, revision: 2 });
  // A later rejected label removes the ordering blocker, not its immutable award.
  await reviewFeedbackReward(conn.db, f.config, f.admin, earlier.id, quick({ expectedRevision: 2, status: 'rejected', award: 'none', verdict: 'not_actionable' }));
  await expect(reviewFeedbackReward(conn.db, f.config, f.otherAdmin, later.id, quick())).rejects.toMatchObject({ code: 'FEEDBACK_ISSUE_AWARD_CONFLICT' });
  await noPreparation(f.otherAdmin, later.id);
});

it('a merged canonical issue remains an explicit conflict instead of silently preparing another issue', async () => {
  const f = await fixture(), canonical = await issue(), merged = await issue(), r = await report(f.owner);
  await conn.db.update(feedbackIssues).set({ status: 'merged', mergedInto: canonical }).where(eq(feedbackIssues.id, merged)); await link(r.id, merged);
  await expect(reviewFeedbackReward(conn.db, f.config, f.admin, r.id, quick())).rejects.toMatchObject({ code: 'FEEDBACK_ISSUE_MERGED' });
  await noPreparation(f.admin, r.id);
});

it('authorization, historical, stale, trash and fixed guards run before any private preparation', async () => {
  const f = await fixture();
  const cases = [
    { extra: { rewardPolicyVersion: 1 }, input: quick(), code: 'FEEDBACK_HISTORICAL_REWARD' },
    { extra: {}, input: quick({ expectedRevision: 2 }), code: 'FEEDBACK_REVIEW_STALE' },
    { extra: { trashedAt: new Date(), trashedBy: f.admin, trashReason: 'Admin archived report' }, input: quick(), code: 'FEEDBACK_REPORT_TRASHED' },
    { extra: { status: 'accepted' as const, fixedAt: new Date() }, input: quick({ status: 'reviewed', award: 'useful_evidence' }), code: 'FEEDBACK_FIXED_CONFLICT' },
  ];
  for (const c of cases) {
    const r = await report(f.owner, c.extra);
    await expect(reviewFeedbackReward(conn.db, f.config, f.admin, r.id, c.input)).rejects.toMatchObject({ code: c.code });
    await noPreparation(f.admin, r.id);
  }
  const r = await report(f.owner);
  await expect(reviewFeedbackReward(conn.db, f.config, f.owner, r.id, quick())).rejects.toMatchObject({ statusCode: 404 });
  await noPreparation(f.owner, r.id);
});

it('omitting preparation retains manual review request receipts and preserves existing bonuses', async () => {
  const f = await fixture(), canonical = await issue(), r = await report(f.owner); await link(r.id, canonical);
  const { preparePrivateIssue: _flag, ...input } = quick({ importance: 'critical' });
  const old = await reviewFeedbackReward(conn.db, f.config, f.admin, r.id, input);
  const [decision] = await conn.db.select().from(feedbackRewardDecisions).where(eq(feedbackRewardDecisions.id, old.id));
  expect(decision!.requestHash).toBe(createHash('sha256').update(JSON.stringify({ reportId: r.id, ...input })).digest('hex'));
  expect(await reviewFeedbackReward(conn.db, f.config, f.admin, r.id, input)).toEqual(old);
  expect(await reviewFeedbackReward(conn.db, f.config, f.otherAdmin, r.id, quick({ expectedRevision: old.revision, importance: 'medium' }))).toMatchObject({ points: old.points, bonusPoints: old.bonusPoints, delta: 0 });
});
