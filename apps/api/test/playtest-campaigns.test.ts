/** Competition decisions must survive retries without touching lifetime gameplay
 * and must freeze the exact eligible window, including arbitrary UTC launch times. */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import { connectTestDb, createTestPlayer } from './helpers';
import { players, bases, sessions, deedOwnershipObservations, testerFeedback, testerMilestones } from '../src/db/schema';
import { playerActionEvents } from '../src/db/playtestActivitySchema';
import { playtestCampaigns as campaigns, playtestParticipants as participants, playtestCampaignAudit as audit,
  playtestCampaignDays as days, playtestCampaignScores as scores, playtestAwards as awards,
  playtestSubmissions as submissions, playtestFounders as founders, playtestMintEvidence as mints,
  playtestMintInventory as inventory, playtestCloseDeedEvidence as closeEvidence,
  playtestInternalWallets as internal } from '../src/db/playtestCampaignSchema';
import { administerCampaign, campaignState, adminCampaignState, exportCampaign, ensurePlaytestCampaigns,
  participateInCampaign, submitCampaignEntry, refreshPlaytestCampaign, finalizePlaytestCampaign,
  snapshotPlaytestFounders, mintVerificationStatus, requiredCampaignCloseDeeds } from '../src/game/playtestCampaigns';

import { computeFoundingCampaignStats } from '../src/game/playtestStats';

let conn: ReturnType<typeof connectTestDb>;
let db: ReturnType<typeof connectTestDb>['db'];
const begin = new Date('2040-01-01T12:30:00Z');
const end = new Date('2040-01-15T12:30:00Z');
const before = new Date('2039-12-31T12:30:00Z');
const after = new Date('2040-01-15T12:31:00Z');
const id = RULES.rewardedId;
const ownWallets: string[] = [];
async function wallet() { const p = await createTestPlayer(db); ownWallets.push(p.wallet); return p.wallet; }
async function clearCampaigns() {
  await db.delete(closeEvidence); await db.delete(audit); await db.delete(awards); await db.delete(submissions); await db.delete(days);
  await db.delete(scores); await db.delete(participants); await db.delete(founders); await db.delete(mints);
  await db.delete(inventory); await db.delete(campaigns); await ensurePlaytestCampaigns(db);
}
beforeAll(async () => { conn = connectTestDb(); db = conn.db; });
beforeEach(async () => { await clearCampaigns(); await db.delete(playerActionEvents).where(eq(playerActionEvents.sourceTable, 'campaign_closure_fixture')); });
afterAll(async () => {
  await clearCampaigns();
  await db.delete(playerActionEvents).where(eq(playerActionEvents.sourceTable, 'campaign_closure_fixture'));
  for (const w of ownWallets) await db.delete(playerActionEvents).where(eq(playerActionEvents.wallet, w));
  if (ownWallets.length) await db.delete(internal).where(sql`${internal.wallet} in (${sql.join(ownWallets.map(w => sql`${w}`), sql`, `)})`);
  await conn.sql.end();
});
const receipt = (revision = 1) => ({ requestId: randomUUID(), revision });
async function launch(campaignId: string = id, at = begin) {
  await administerCampaign(db, campaignId, 'admin', receipt(), { action: 'schedule', startAt: at.toISOString(), registrationOpen: true }, before);
}
async function action(wallet: string, at: Date, extra: Partial<typeof playerActionEvents.$inferInsert> = {}) {
  const eventId = randomUUID();
  await db.insert(playerActionEvents).values({ id: eventId, wallet, sourceKey: 'chat_sent', sourceTable: 'campaign_test', sourceId: eventId,
    occurredAt: at, active: true, fought: false, metadata: {}, ...extra });
}

it('serializes scheduling, exact retries and stale competing admin decisions', async () => {
  const request = receipt();
  const command = { action: 'schedule' as const, startAt: begin.toISOString(), registrationOpen: true };
  const results = await Promise.all([administerCampaign(db, id, 'admin', request, command, before), administerCampaign(db, id, 'admin', request, command, before)]);
  expect(results).toEqual([{ revision: 2 }, { revision: 2 }]);
  await expect(administerCampaign(db, id, 'other-admin', request, command, before)).rejects.toMatchObject({ statusCode: 409 });
  await expect(administerCampaign(db, id, 'admin', receipt(), command, before)).rejects.toMatchObject({ statusCode: 409 });
  expect(await db.select().from(audit)).toHaveLength(1);
  await expect(administerCampaign(db, id, 'admin', receipt(2), command, begin)).rejects.toMatchObject({ statusCode: 409 });
});

it('requires verified founders before scheduling and a future UTC launch', async () => {
  // One campaign exposes both allocations even while its first checkpoint is
  // incomplete; display names never create a new campaign or open registration.
  expect(await campaignState(db, RULES.foundingId, undefined, before)).toMatchObject({
    id: RULES.foundingId, name: RULES.names.founding, phase: 'draft',
    spots: { reserved: RULES.founderSpots, ranked: RULES.rankedSpots, total: RULES.founderSpots + RULES.rankedSpots },
    checkpoint: { target: RULES.founderSpots },
  });
  expect(await campaignState(db, id, undefined, before)).toMatchObject({
    id, name: RULES.names.rewarded, phase: 'draft', spots: null, registrationOpen: false,
  });
  await expect(launch(RULES.foundingId)).rejects.toMatchObject({ statusCode: 409 });
  await expect(administerCampaign(db, id, 'admin', receipt(), { action: 'schedule', startAt: before.toISOString(), registrationOpen: true }, before)).rejects.toMatchObject({ statusCode: 422 });
});

it('records one opt-in time, opens at launch, closes at end, and never enrolls through admin', async () => {
  const w = await wallet();
  await administerCampaign(db, id, 'admin', receipt(), { action: 'schedule', startAt: begin.toISOString(), registrationOpen: false }, before);
  await expect(participateInCampaign(db, id, w, before)).rejects.toMatchObject({ statusCode: 409 });
  const [a, b] = await Promise.all([participateInCampaign(db, id, w, begin), participateInCampaign(db, id, w, new Date(+begin + 1))]);
  expect(a.joinedAt).toEqual(b.joinedAt);
  expect((await campaignState(db, id, w, begin)).registrationOpen).toBe(true);
  await expect(participateInCampaign(db, id, await wallet(), end)).rejects.toMatchObject({ statusCode: 409 });
});

it('excludes pre-join activity and grants the three-day lifetime bonus exactly once across concurrent refreshes', async () => {
  await launch(); const w = await wallet();
  const joined = new Date(+begin + 60_000);
  await participateInCampaign(db, id, w, joined);
  await action(w, begin);
  for (const at of [joined, new Date('2040-01-02T01:00:00Z'), new Date('2040-01-03T01:00:00Z')]) await action(w, at);
  await action(w, end);
  await Promise.all([refreshPlaytestCampaign(db, id, [], after), refreshPlaytestCampaign(db, id, [], after)]);
  const [bonus] = await db.select().from(testerMilestones).where(and(eq(testerMilestones.wallet, w), eq(testerMilestones.key, `campaign_participation:${id}`)));
  expect(bonus?.points).toBe(RULES.participationBonus.points);
  const state = await campaignState(db, id, w, after);
  expect(state.standings[0]?.activeDays).toBe(3);
  expect(state.standings[0]?.points).toBeGreaterThan(0);
  expect(state.participant?.bonusAt).not.toBeNull();
  expect((await db.select().from(days).where(and(eq(days.wallet, w), eq(days.key, 'played'))))).toHaveLength(3);
});

it('reconciles entire campaign at close and freezes scores, awards and replay receipt', async () => {
  await launch(); const w = await wallet();
  await participateInCampaign(db, id, w, begin);
  await action(w, begin);
  await action(w, new Date('2040-01-14T20:00:00Z'));
  const request = receipt(2);
  await expect(finalizePlaytestCampaign(db, id, 'admin', request, [], new Date(+end - 1))).rejects.toMatchObject({ statusCode: 409 });
  const first = await finalizePlaytestCampaign(db, id, 'admin', request, [], after);
  expect(await finalizePlaytestCampaign(db, id, 'admin', request, [], after)).toEqual(first);
  const state = await campaignState(db, id, w, after);
  expect(state.phase).toBe('finalized'); expect(state.standings[0]?.activeDays).toBe(2);
  expect(state.winners).toEqual([expect.objectContaining({ prizeId: 'champion', wallet: w, amountUsd: 100 })]);
  await action(w, new Date('2040-01-05T20:00:00Z'));
  await refreshPlaytestCampaign(db, id, [], after);
  expect((await campaignState(db, id, w, after)).standings).toEqual(state.standings);
});

it('excludes team wallets from campaign bonuses and judging while preserving their existing lifetime records', async () => {
  await launch(); const w = await wallet();
  await participateInCampaign(db, id, w, begin);
  const [lifetime] = await db.insert(testerMilestones).values({ wallet: w, key: 'base_founded',
    points: 10, source: 'hook', achievedAt: before }).returning();
  for (const at of [begin, new Date('2040-01-02T12:30:00Z'), new Date('2040-01-03T12:30:00Z')]) await action(w, at);
  await db.insert(internal).values({ wallet: w, reason: 'owner-confirmed team', recordedBy: 'test', evidence: {} });
  await refreshPlaytestCampaign(db, id, [], after);
  expect((await campaignState(db, id, w, after)).standings).toHaveLength(0);
  expect(await db.select().from(testerMilestones).where(and(eq(testerMilestones.wallet, w),
    eq(testerMilestones.key, `campaign_participation:${id}`)))).toHaveLength(0);
  await expect(participateInCampaign(db, id, w, begin)).rejects.toThrow('internal wallets');
  await expect(submitCampaignEntry(db, id, w, { requestId: 'video', kind: 'video', url: 'https://example.com/play' }, begin)).rejects.toThrow('internal wallets');
  await finalizePlaytestCampaign(db, id, 'admin', receipt(2), [], after);
  await expect(administerCampaign(db, id, 'admin', receipt(3), { action: 'award', wallet: w,
    prizeId: 'video', submissionId: 'video', reason: 'internal must remain ineligible',
    scores: { feedback: 100, evidence: 100, clarity: 100, coverage: 100 } }, after)).rejects.toThrow('internal wallets');
  expect(await db.select().from(awards).where(eq(awards.campaignId, id))).toHaveLength(0);
  expect((await db.select().from(testerMilestones).where(and(eq(testerMilestones.wallet, w), eq(testerMilestones.key, 'base_founded'))))[0]).toEqual(lifetime);
  const configuredAdmin = await wallet();
  await expect(participateInCampaign(db, id, configuredAdmin, begin, [configuredAdmin])).rejects.toThrow('internal wallets');
});

it('cancellation and disqualification preserve lifetime progress and prevent prizes', async () => {
  await launch(); const w = await wallet();
  await participateInCampaign(db, id, w, begin); await action(w, begin);
  await administerCampaign(db, id, 'admin', receipt(2), { action: 'disqualify', wallet: w, reason: 'verified abuse' }, new Date(+begin + 1));
  await finalizePlaytestCampaign(db, id, 'admin', receipt(3), [], after);
  expect((await campaignState(db, id, w, after)).winners).toEqual([]);
  expect((await adminCampaignState(db, id)).participants[0]?.disqualificationReason).toBe('verified abuse');
  await clearCampaigns(); await launch();
  await administerCampaign(db, id, 'admin', receipt(2), { action: 'cancel', reason: 'reschedule later' }, begin);
  await expect(participateInCampaign(db, id, w, begin)).rejects.toMatchObject({ statusCode: 409 });
  await expect(finalizePlaytestCampaign(db, id, 'admin', receipt(3), [], after)).rejects.toMatchObject({ statusCode: 409 });
});

it('keeps private report evidence off public DTOs, judges one report/video per wallet and records external payment once', async () => {
  await launch(); const w = await wallet();
  await participateInCampaign(db, id, w, begin); await action(w, begin);
  const [report] = await db.insert(testerFeedback).values({ wallet: w, category: 'bug', title: 'PRIVATE-TITLE', body: 'PRIVATE-BODY', status: 'accepted', createdAt: new Date(+begin + 1) }).returning();
  const input = { requestId: randomUUID(), kind: 'report' as const, reportId: report!.id };
  const entry = await submitCampaignEntry(db, id, w, input, new Date(+begin + 2));
  expect(await submitCampaignEntry(db, id, w, input, new Date(+begin + 3))).toEqual(entry);
  const video = await submitCampaignEntry(db, id, w, { requestId: randomUUID(), kind: 'video', url: 'https://www.youtube.com/watch?v=original' }, new Date(+begin + 2));
  await finalizePlaytestCampaign(db, id, 'admin', receipt(2), [], after);
  await administerCampaign(db, id, 'admin', receipt(3), { action: 'award', prizeId: 'bug-1', wallet: w, submissionId: entry.id, reason: 'PRIVATE-JUDGING' }, after);
  await expect(administerCampaign(db, id, 'admin', receipt(4), { action: 'award', prizeId: 'bug-2', wallet: w, submissionId: entry.id, reason: 'duplicate winner' }, after)).rejects.toMatchObject({ statusCode: 409 });
  await administerCampaign(db, id, 'admin', receipt(4), { action: 'award', prizeId: 'video', wallet: w, submissionId: video.id, reason: 'useful critique', scores: { feedback: 90, evidence: 80, clarity: 70, coverage: 60 } }, after);
  const payRequest = receipt(5);
  const payment = { action: 'payment' as const, wallet: w, prizeId: 'video', reference: 'EXTERNAL-PAYMENT-REF' };
  await administerCampaign(db, id, 'admin', payRequest, payment, after);
  await administerCampaign(db, id, 'admin', payRequest, payment, after);
  const publicJson = JSON.stringify(await campaignState(db, id));
  for (const secret of ['PRIVATE-TITLE', 'PRIVATE-BODY', 'PRIVATE-JUDGING', 'EXTERNAL-PAYMENT-REF', video.url!]) expect(publicJson).not.toContain(secret);
  expect(JSON.stringify(await exportCampaign(db, id))).toContain('EXTERNAL-PAYMENT-REF');
  expect((await campaignState(db, id)).winners).toHaveLength(3);
  const [persistedReport] = await db.select({ points: testerFeedback.points }).from(testerFeedback).where(eq(testerFeedback.id, report!.id));
  expect(persistedReport?.points).toBe(0);
  expect(publicJson).not.toContain(w);
  expect((await campaignState(db, id)).standings[0]?.achievedAt).toBeNull();
  expect((await adminCampaignState(db, id)).standings[0]?.wallet).toBe(w);
});

it('rejects reports outside eligible participation, duplicates, trash and changed request payloads', async () => {
  await launch(); const w = await wallet(); await participateInCampaign(db, id, w, begin);
  const [report] = await db.insert(testerFeedback).values({ wallet: w, category: 'bug', title: 'old', body: 'old private report', createdAt: before }).returning();
  await expect(submitCampaignEntry(db, id, w, { requestId: randomUUID(), kind: 'report', reportId: report!.id }, begin)).rejects.toMatchObject({ statusCode: 422 });
  const requestId = randomUUID();
  await submitCampaignEntry(db, id, w, { requestId, kind: 'video', url: 'https://example.com/video' }, begin);
  await expect(submitCampaignEntry(db, id, w, { requestId, kind: 'video', url: 'https://example.com/changed' }, begin)).rejects.toMatchObject({ statusCode: 409 });
});

it('withholds first-50 snapshot without complete inventory or with an unresolved equal transaction order', async () => {
  await db.insert(mints).values({ assetId: 'campaign-unresolved', error: 'missing original transaction' });
  await snapshotPlaytestFounders(db, []);
  expect((await campaignState(db, RULES.foundingId)).snapshotAt).toBeNull();
  expect((await mintVerificationStatus(db)).unresolvedAssets).toContain('campaign-unresolved');
  await db.delete(mints);
  await db.insert(mints).values(['first', 'second'].map((originalWallet, i) => ({ assetId: `campaign-tied-${i}`, originalWallet, slot: '100', transactionIndex: 0, signature: `sig-${i}`, confirmedAt: begin, verifiedAt: begin })));
  await db.insert(inventory).values({ id: 'land-deeds', throughSlot: '100', assetCount: 2, completedAt: begin });
  expect((await mintVerificationStatus(db)).complete).toBe(false);
  expect((await mintVerificationStatus(db)).unresolvedAssets).toEqual(expect.arrayContaining(['campaign-tied-0', 'campaign-tied-1']));
});

it('freezes 50 unique original minters and usernames once despite concurrent sweeps, extra deeds and later name changes', async () => {
  // Unrelated fixtures may have minted assets; a complete verifier inventory
  // must include them too, even though this test excludes their recipients.
  const known = await db.execute(sql`select deed_asset_id as asset from bases where deed_asset_id is not null
    union select deed_asset_id from players where deed_asset_id is not null
    union select deed_asset_id from base_transfers`);
  const original = await Promise.all(Array.from({ length: RULES.founderSpots }, () => wallet()));
  await db.update(players).set({ name: 'Frozen founder' }).where(eq(players.wallet, original[0]!));
  const minted = [
    ...known.map(r => ({ assetId: String(r['asset']), originalWallet: 'unrelated-fixture', slot: '1', transactionIndex: 0, signature: 'known-proof', confirmedAt: before, verifiedAt: before })),
    ...original.map((originalWallet, i) => ({ assetId: `campaign-original-${i}`, originalWallet, slot: String(100 + i), transactionIndex: 0, signature: `proof-${i}`, confirmedAt: before, verifiedAt: before })),
    { assetId: 'campaign-extra-deed', originalWallet: original[0]!, slot: '900', transactionIndex: 0, signature: 'extra-proof', confirmedAt: before, verifiedAt: before },
  ];
  await db.insert(mints).values(minted);
  // Collection membership alone is insufficient: every candidate is an
  // authenticated game minter. The first original has already sold this deed.
  await db.insert(sessions).values(original.map(wallet => ({ wallet, expiresAt: before, revokedAt: before })));
  const buyer = await wallet();
  await db.insert(bases).values(original.map((wallet, i) => ({ ownerWallet: i === 0 ? buyer : wallet,
    deedAssetId: `campaign-original-${i}`, landPaidAt: before })));
  await db.insert(inventory).values({ id: 'land-deeds', throughSlot: '1000', assetCount: minted.length, completedAt: before });
  await Promise.all([snapshotPlaytestFounders(db, ['unrelated-fixture'], before), snapshotPlaytestFounders(db, ['unrelated-fixture'], before)]);
  const frozen = await db.select().from(founders).orderBy(founders.position);
  expect(frozen).toHaveLength(RULES.founderSpots);
  expect(frozen[0]).toMatchObject({ wallet: original[0], username: 'Frozen founder', assetId: 'campaign-original-0' });
  await db.update(players).set({ name: 'Changed later' }).where(eq(players.wallet, original[0]!));
  await snapshotPlaytestFounders(db, ['unrelated-fixture'], begin);
  expect(await db.select().from(founders).orderBy(founders.position)).toEqual(frozen);
  expect((await db.select().from(audit).where(eq(audit.action, 'founder-snapshot')))).toHaveLength(1);
  // A later RPC failure invalidates the LIVE inventory receipt, never the
  // completed first-50 snapshot or its published prelaunch checkpoint.
  await db.delete(inventory);
  expect(await mintVerificationStatus(db)).toMatchObject({ complete: false, verifiedUniqueWallets: 0 });
  const state = await campaignState(db, RULES.foundingId, undefined, begin);
  expect(state.checkpoint).toMatchObject({ count: RULES.founderSpots, frozen: true, available: true });
  expect(state.founders).toHaveLength(RULES.founderSpots);
  expect(await computeFoundingCampaignStats(db, begin)).toMatchObject({ checkpointCount: RULES.founderSpots, snapshotComplete: true, checkpointAvailable: true });
});

it('uses immutable pre-close observer history after a normal later update, requires exact chain proof and excludes guaranteed founders', async () => {
  const owner = await wallet(); const buyer = await wallet(); const guaranteed = await wallet();
  const [base] = await db.insert(bases).values({ ownerWallet: owner }).returning();
  const assetId = `campaign-close-${base!.id}`;
  // Isolate this historical close from unrelated suites' still-open synthetic
  // bases, without changing those game rows. All these fixture events are removed.
  const knownBases = await db.select({ id: bases.id, wallet: bases.ownerWallet }).from(bases);
  for (const b of knownBases) await action(b.wallet, new Date(+begin - 1), { sourceKey: 'deed_eligibility', active: false,
    baseId: b.id, sourceTable: 'campaign_closure_fixture', metadata: { status: 'inactive', paid: false, ownerWallet: b.wallet, deedAssetId: null } });
  await action(owner, begin, { sourceKey: 'deed_eligibility', active: false, baseId: base!.id, sourceTable: 'campaign_closure_fixture',
    metadata: { status: 'active', paid: true, ownerWallet: owner, deedAssetId: assetId } });
  const checkedAt = new Date(+end - 30_000);
  const [observation] = await db.insert(deedOwnershipObservations).values({ baseId: base!.id, assetId, owner, slot: 100n,
    status: 'owned', source: 'campaign-test', auditHash: 'before-close', checkedAt }).returning();
  await action(owner, checkedAt, { sourceKey: 'deed_observation', active: false, baseId: base!.id, sourceTable: 'campaign_closure_fixture',
    metadata: { assetId, owner, slot: '100', status: 'owned', checkedAt: checkedAt.toISOString() } });
  // The canonical observer updates its current row in place after close. The
  // competition must still read its earlier immutable receipt, not this row.
  await db.update(deedOwnershipObservations).set({ owner: buyer, slot: 200n, checkedAt: new Date(+end + 10_000) })
    .where(eq(deedOwnershipObservations.id, observation!.id));
  await action(buyer, new Date(+end + 10_000), { sourceKey: 'deed_observation', active: false, baseId: base!.id, sourceTable: 'campaign_closure_fixture',
    metadata: { assetId, owner: buyer, slot: '200', status: 'owned', checkedAt: new Date(+end + 10_000).toISOString() } });
  await action(buyer, new Date(+end + 10_000), { sourceKey: 'deed_eligibility', active: false, baseId: base!.id, sourceTable: 'campaign_closure_fixture',
    metadata: { status: 'active', paid: true, ownerWallet: buyer, deedAssetId: assetId } });
  await db.insert(mints).values({ assetId: 'campaign-guaranteed', originalWallet: guaranteed });
  await db.insert(founders).values({ wallet: guaranteed, username: 'guaranteed', position: 1, assetId: 'campaign-guaranteed', evidence: {}, snapshotAt: before });
  await db.update(campaigns).set({ snapshotAt: before }).where(eq(campaigns.id, RULES.foundingId));
  await launch(RULES.foundingId);
  await action(owner, begin); await action(guaranteed, begin);
  expect(await requiredCampaignCloseDeeds(db, RULES.foundingId)).toEqual([expect.objectContaining({ assetId, ownerWallet: owner,
    observation: expect.objectContaining({ owner, slot: '100' }) })]);
  await expect(finalizePlaytestCampaign(db, RULES.foundingId, 'admin', receipt(2), [], after)).rejects.toMatchObject({ code: 'CAMPAIGN_CLOSE_VERIFICATION' });
  await db.insert(closeEvidence).values({ campaignId: RULES.foundingId, assetId, ownerAtClose: buyer, throughSlot: '150', verifiedAt: after, evidence: { fixture: true } });
  await expect(finalizePlaytestCampaign(db, RULES.foundingId, 'admin', receipt(2), [], after)).rejects.toMatchObject({ code: 'CAMPAIGN_CLOSE_VERIFICATION' });
  // Separate verified-chain outcome, as supplied by the chain verifier.
  await db.delete(closeEvidence);
  await db.insert(closeEvidence).values({ campaignId: RULES.foundingId, assetId, ownerAtClose: owner, throughSlot: '150', verifiedAt: after, evidence: { fixture: true } });
  await finalizePlaytestCampaign(db, RULES.foundingId, 'admin', receipt(2), [], after);
  const state = await campaignState(db, RULES.foundingId, owner, after);
  expect(state.winners).toEqual([expect.objectContaining({ wallet: owner, category: 'whitelist' })]);
  expect(state.winners.some(w => w.wallet === guaranteed)).toBe(false);
});
