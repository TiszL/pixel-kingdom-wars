/** Owner 2026-09-07: independent campaigns. All admin changes are serialized,
 * revision checked and receipted. Cash awards record decisions, never transfer money. */
import { createHash } from 'node:crypto';
import { PLAYTEST_COMPETITIONS as RULES, PLAYTEST_STATS, BASE_OWNERSHIP, TESTER_DAILY, MINT_INVENTORY } from '@shardkeep/shared';
import { and, eq, gte, lt, desc, asc, inArray, sql } from 'drizzle-orm';
import type { Db, DbOrTx, DbTx } from '../db/client';
import { players, testerFeedback, testerMilestones, testerBoardHidden } from '../db/schema';
import { playtestCampaigns as campaigns, playtestParticipants as participants,
  playtestCampaignAudit as audit, playtestSubmissions as submissions,
  playtestAwards as awards, playtestFounders as founders, playtestCampaignDays as campaignDays, playtestMintEvidence as mintEvidence, playtestCampaignScores as scoreRows, playtestMintInventory as mintInventory, playtestCloseDeedEvidence as closeEvidence } from '../db/playtestCampaignSchema';
import { playtestMintStatus } from '../db/playtestMintStatusSchema';
import { HttpError } from '../lib/errors';
import { playerActionEvents } from '../db/playtestActivitySchema';
import { reconcilePlayerActions } from './playtestActivity';
import { shortWallet } from './tester';
import { scoreCampaignEvents, compareCampaignScores, allocateGameplayAwards, selectFoundingAwards } from './playtestCampaignScoring';
import { foundingMintCandidates, internalPlaytestWallets } from './playtestEligibility';

export type Campaign = typeof campaigns.$inferSelect;

async function campaignWallTime(db: DbOrTx): Promise<Date> {
  const [row] = await db.execute(sql`select clock_timestamp() as now`);
  const value = row!['now'];
  return value instanceof Date ? value : new Date(String(value));
}
export type AdminReceipt = { requestId: string; revision: number };
export type CampaignCommand =
  | { action: 'schedule'; startAt: string; registrationOpen: boolean }
  | { action: 'cancel'; reason: string }
  | { action: 'disqualify'; wallet: string; reason: string }
  | { action: 'award'; prizeId: string; wallet: string; submissionId: string; reason: string;
      scores?: { feedback: number; evidence: number; clarity: number; coverage: number } | undefined }
  | { action: 'payment'; prizeId: string; wallet: string; reference: string };

export async function ensurePlaytestCampaigns(db: DbOrTx): Promise<void> {
  await db.insert(campaigns).values([
    { id: RULES.foundingId, kind: 'founding' }, { id: RULES.rewardedId, kind: 'rewarded' },
  ]).onConflictDoNothing();
}
export function campaignPhase(c: Campaign, now = new Date()): string {
  if (c.cancelledAt) return 'cancelled';
  if (c.finalizedAt) return 'finalized';
  if (!c.startAt || !c.endAt) return 'draft';
  return now < c.startAt ? 'scheduled' : now < c.endAt ? 'running' : 'ended';
}
export async function lockedCampaign(tx: DbTx, id: string): Promise<Campaign> {
  const [c] = await tx.select().from(campaigns).where(eq(campaigns.id, id)).for('update');
  if (!c) throw new HttpError(404, 'campaign not found');
  return c;
}

/** Exact replay is allowed even after the campaign subsequently changes. */
export async function campaignAdminMutation(
  db: Db, id: string, actor: string, receipt: AdminReceipt, detail: Record<string, unknown>,
  apply: (tx: DbTx, c: Campaign, at: Date) => Promise<void>, now?: Date,
): Promise<{ revision: number }> {
  const hash = createHash('sha256').update(JSON.stringify({ actor, detail })).digest('hex');
  return db.transaction(async tx => {
    const c = await lockedCampaign(tx, id);
    const [prior] = await tx.select().from(audit).where(and(eq(audit.campaignId, id), eq(audit.requestId, receipt.requestId)));
    if (prior) {
      if (prior.requestHash !== hash) throw new HttpError(409, 'request id already used for a different decision');
      return prior.result as { revision: number };
    }
    if (receipt.revision !== c.revision) throw new HttpError(409, 'campaign changed; refresh before deciding');
    const acceptedAt = now ?? await campaignWallTime(tx);
    await apply(tx, c, acceptedAt);
    const result = { revision: c.revision + 1 };
    await tx.update(campaigns).set(result).where(eq(campaigns.id, id));
    await tx.insert(audit).values({ campaignId: id, requestId: receipt.requestId, actor,
      action: String(detail['action']), requestHash: hash, revision: result.revision, detail, result, createdAt: acceptedAt });
    return result;
  });
}

export async function administerCampaign(db: Db, id: string, actor: string, receipt: AdminReceipt,
  command: CampaignCommand, now?: Date, internal: readonly string[] = []): Promise<{ revision: number }> {
  return campaignAdminMutation(db, id, actor, receipt, command, async (tx, c, now) => {
    if (command.action === 'schedule') {
      if (c.cancelledAt || c.finalizedAt || (c.startAt && now >= c.startAt)) throw new HttpError(409, 'campaign schedule is locked');
      const start = new Date(command.startAt);
      if (!Number.isFinite(start.getTime()) || start <= now) throw new HttpError(422, 'choose a future UTC start');
      if (c.kind === 'founding' && !c.snapshotAt) throw new HttpError(409, 'verified first-50 snapshot is required');
      await tx.update(campaigns).set({ startAt: start, endAt: new Date(start.getTime() + RULES.durationDays * 86_400_000),
        registrationOpen: c.kind === 'rewarded' && command.registrationOpen }).where(eq(campaigns.id, id));
    } else if (command.action === 'cancel') {
      if (c.finalizedAt) throw new HttpError(409, 'finalized results are immutable');
      await tx.update(campaigns).set({ cancelledAt: now, registrationOpen: false }).where(eq(campaigns.id, id));
    } else if (command.action === 'disqualify') {
      if (c.finalizedAt || c.cancelledAt) throw new HttpError(409, 'campaign decisions are locked');
      const [player] = await tx.select({ wallet: players.wallet }).from(players).where(eq(players.wallet, command.wallet));
      if (!player) throw new HttpError(404, 'player not found');
      const [p] = await tx.select().from(participants).where(and(eq(participants.campaignId, id), eq(participants.wallet, command.wallet)));
      if (c.kind === 'rewarded' && !p) throw new HttpError(422, 'wallet is not a participant');
      await tx.insert(participants).values({ campaignId: id, wallet: command.wallet, joinedAt: c.startAt ?? now,
        disqualifiedAt: now, disqualificationReason: command.reason }).onConflictDoUpdate({
          target: [participants.campaignId, participants.wallet], set: { disqualifiedAt: now, disqualificationReason: command.reason },
        });
    } else if (command.action === 'award') {
      if ((await internalPlaytestWallets(tx, internal)).has(command.wallet)) throw new HttpError(409, 'internal wallets are not eligible for campaign awards');
      if (c.kind !== 'rewarded' || !c.finalizedAt || c.cancelledAt) throw new HttpError(409, 'finalize competition results before judging');
      const prize = RULES.prizes.find(p => p.id === command.prizeId && p.metric === 'judged');
      if (!prize) throw new HttpError(422, 'this award is calculated automatically');
      const [entry] = await tx.select().from(submissions).where(and(eq(submissions.id, command.submissionId),
        eq(submissions.campaignId, id), eq(submissions.wallet, command.wallet), eq(submissions.kind, prize.category)));
      const [p] = await tx.select().from(participants).where(and(eq(participants.campaignId, id), eq(participants.wallet, command.wallet)));
      if (!entry || !p || p.disqualifiedAt) throw new HttpError(422, 'eligible submission required');
      if (entry.kind === 'report') {
        const [report] = await tx.select().from(testerFeedback).where(eq(testerFeedback.id, entry.reportId!)).for('update');
        if (!report || report.trashedAt || report.status === 'duplicate' || report.status !== 'accepted') throw new HttpError(422, 'accepted actionable report required');
      } else if (!command.scores) throw new HttpError(422, 'video rubric scores are required');
      const [taken] = await tx.select().from(awards).where(and(eq(awards.campaignId, id),
        sql`(${awards.prizeId} = ${prize.id} OR (${awards.wallet} = ${command.wallet} AND ${awards.category} = ${prize.category}))`));
      if (taken) throw new HttpError(409, 'prize or category already awarded');
      const [player] = await tx.select({ name: players.name }).from(players).where(eq(players.wallet, command.wallet));
      await tx.insert(awards).values({ campaignId: id, prizeId: prize.id, wallet: command.wallet, username: player?.name ?? '',
        amountUsd: prize.amountUsd, category: prize.category, decidedAt: now,
        evidence: { submissionId: entry.id, reason: command.reason, scores: command.scores ?? null, weights: entry.kind === 'video' ? RULES.videoWeights : null } });
    } else {
      if (!c.finalizedAt || c.cancelledAt) throw new HttpError(409, 'finalized award required');
      const [award] = await tx.select().from(awards).where(and(eq(awards.campaignId, id), eq(awards.prizeId, command.prizeId), eq(awards.wallet, command.wallet)));
      if (!award) throw new HttpError(404, 'award not found');
      if (award.paidAt) throw new HttpError(409, 'payment already recorded');
      await tx.update(awards).set({ paidAt: now, paymentReference: command.reference }).where(and(eq(awards.campaignId, id), eq(awards.prizeId, command.prizeId)));
    }
  }, now);
}

export async function participateInCampaign(db: Db, id: string, wallet: string, at?: Date, internal: readonly string[] = []) {
  return db.transaction(async tx => {
    const c = await lockedCampaign(tx, id);
    const now = at ?? await campaignWallTime(tx);
    if ((await internalPlaytestWallets(tx, internal)).has(wallet)) throw new HttpError(409, 'internal wallets are not eligible for campaign awards');
    const [prior] = await tx.select().from(participants).where(and(eq(participants.campaignId, id), eq(participants.wallet, wallet)));
    if (prior) return prior;
    if (c.kind !== 'rewarded' || (!c.registrationOpen && (!c.startAt || now < c.startAt)) || !c.endAt || now >= c.endAt || c.cancelledAt || c.finalizedAt) throw new HttpError(409, 'registration is closed');
    const [joined] = await tx.insert(participants).values({ campaignId: id, wallet, joinedAt: now }).returning();
    return joined!;
  });
}

export async function submitCampaignEntry(db: Db, id: string, wallet: string,
  input: { requestId: string; kind: 'report' | 'video'; reportId?: string; url?: string }, at?: Date, internal: readonly string[] = []) {
  return db.transaction(async tx => {
    const c = await lockedCampaign(tx, id);
    const now = at ?? await campaignWallTime(tx);
    if ((await internalPlaytestWallets(tx, internal)).has(wallet)) throw new HttpError(409, 'internal wallets are not eligible for campaign awards');
    const submissionId = `${wallet}:${input.requestId}`;
    const [prior] = await tx.select().from(submissions).where(eq(submissions.id, submissionId));
    if (prior) {
      if (prior.campaignId !== id || prior.kind !== input.kind || prior.url !== (input.url ?? null) || prior.reportId !== (input.reportId ?? null)) throw new HttpError(409, 'submission request changed');
      return prior;
    }
    const [p] = await tx.select().from(participants).where(and(eq(participants.campaignId, id), eq(participants.wallet, wallet)));
    if (c.kind !== 'rewarded' || campaignPhase(c, now) !== 'running' || !p || p.disqualifiedAt) throw new HttpError(409, 'join the running competition first');
    if (input.kind === 'report') {
      const [report] = await tx.select().from(testerFeedback).where(and(eq(testerFeedback.id, input.reportId!), eq(testerFeedback.wallet, wallet))).for('update');
      if (!report || report.trashedAt || report.createdAt < c.startAt! || report.createdAt < p.joinedAt || report.createdAt >= c.endAt!) throw new HttpError(422, 'eligible report required');
    } else {
      const url = new URL(input.url!);
      if (url.protocol !== 'https:' || url.username || url.password || !url.hostname.includes('.')) throw new HttpError(422, 'public HTTPS social-post URL required');
    }
    const [entry] = await tx.insert(submissions).values({ id: submissionId, campaignId: id, wallet, kind: input.kind,
      reportId: input.reportId ?? null, url: input.url ?? null, createdAt: now }).returning();
    return entry!;
  });
}

export async function campaignState(db: Db, id: string, wallet?: string, now = new Date(), admin = false, internal: readonly string[] = []) {
  return db.transaction(tx => readCampaignState(tx, id, wallet, now, admin, internal), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

async function readCampaignState(db: DbOrTx, id: string, wallet: string | undefined, now: Date, admin: boolean, internal: readonly string[]) {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!c) throw new HttpError(404, 'campaign not found');
  const winners = await db.select({ prizeId: awards.prizeId, wallet: awards.wallet, username: awards.username,
    amountUsd: awards.amountUsd, category: awards.category }).from(awards).where(eq(awards.campaignId, id));
  const [participant] = wallet ? await db.select().from(participants).where(and(eq(participants.campaignId, id), eq(participants.wallet, wallet))) : [];
  const excluded = await internalPlaytestWallets(db, internal);
  const hidden = await db.select({ wallet: testerBoardHidden.wallet }).from(testerBoardHidden);
  const displayExcluded = new Set([...excluded, ...hidden.map(h => h.wallet)]);
  let first = await db.select({ wallet: founders.wallet, username: founders.username, position: founders.position }).from(founders).orderBy(founders.position);
  const guaranteed = new Set(c.snapshotAt ? first.map(f => f.wallet) : []);
  const mintStatus = c.kind === 'founding' ? await mintVerificationStatus(db, internal, now) : null;
  if (c.kind === 'founding' && !c.snapshotAt) {
    const candidates = mintStatus!.complete ? (await foundingMintCandidates(db, internal)).slice(0, RULES.founderSpots) : [];
    const names = candidates.length ? await db.select({ wallet: players.wallet, name: players.name }).from(players)
      .where(inArray(players.wallet, candidates.map(m => m.originalWallet!))) : [];
    first = candidates.map((m, i) => ({ wallet: m.originalWallet!, position: i + 1,
      username: names.find(p => p.wallet === m.originalWallet)?.name ?? '' }));
  }
  const scores = await db.select().from(scoreRows).where(eq(scoreRows.campaignId, id))
    .orderBy(desc(scoreRows.points), desc(scoreRows.activeDays), asc(scoreRows.achievedAt), asc(scoreRows.wallet));
  const standings = scores.filter(s => admin || !displayExcluded.has(s.wallet)).map(({ campaignId: _id, evidence: _evidence, ...s }, i) => ({ ...s,
    eligible: s.eligible && !excluded.has(s.wallet), rank: i + 1, guaranteed: guaranteed.has(s.wallet), isYou: wallet === s.wallet }));
  const ownSubmissions = wallet ? await db.select().from(submissions).where(and(eq(submissions.campaignId, id), eq(submissions.wallet, wallet))) : [];
  const coverage = await db.execute(sql`select started_at from playtest_activity_coverage where key='authoritative-v1'`);
  const phase = campaignPhase(c, now);
  const beforeLaunch = !c.startAt || now < c.startAt;
  const visibleWallet = (w: string) => admin || w === wallet ? w : shortWallet(w);
  return { ...c, registrationOpen: c.kind === 'rewarded' && (phase === 'running' || (phase === 'scheduled' && c.registrationOpen)), name: c.kind === 'founding' ? RULES.names.founding : RULES.names.rewarded, phase, winners: winners.filter(w => admin || !displayExcluded.has(w.wallet)).map(w => ({ ...w, wallet: visibleWallet(w.wallet) })),
    spots: c.kind === 'founding' ? { reserved: RULES.founderSpots, ranked: RULES.rankedSpots, total: RULES.founderSpots + RULES.rankedSpots } : null,
    standings: standings.map(s => ({ ...s, wallet: visibleWallet(s.wallet), achievedAt: admin || s.isYou ? s.achievedAt : null })),
    stale: !c.finalizedAt && !c.cancelledAt && !!c.startAt && now >= c.startAt &&
      (!c.reconciledAt || (phase === 'ended' ? c.reconciledAt < c.endAt! : now.getTime() - c.reconciledAt.getTime() > PLAYTEST_STATS.refreshEveryMs * 2)),
    measurementSince: coverage[0]?.['started_at'] ? new Date(String(coverage[0]['started_at'])).toISOString() : null,
    participant: participant ?? null, ownSubmissions, prizes: c.kind === 'rewarded' ? RULES.prizes : [],
    founders: c.kind === 'founding' ? first.filter(f => admin || !displayExcluded.has(f.wallet)).map(f => ({ ...f, wallet: visibleWallet(f.wallet) })) : [],
    checkpoint: c.kind === 'founding' ? {
      count: beforeLaunch ? (c.snapshotAt ? first.length : mintStatus!.complete ? Math.min(RULES.founderSpots, mintStatus!.verifiedUniqueWallets) : null) : first.length + Math.min(RULES.rankedSpots, standings.filter(s => s.eligible && !s.guaranteed && s.points > 0).length),
      target: beforeLaunch ? RULES.founderSpots : RULES.founderSpots + RULES.rankedSpots,
      frozen: beforeLaunch && !!c.snapshotAt && first.length === RULES.founderSpots,
      available: !beforeLaunch || !!c.snapshotAt || mintStatus!.complete,
      verification: { status: mintStatus!.complete ? 'verified' as const : mintStatus!.status === 'stale' ? 'stale' as const : 'unavailable' as const, lastSuccessAt: mintStatus!.lastSuccessAt, lastAttemptAt: mintStatus!.lastAttemptAt },
    } : null,
  };
}

export async function adminCampaignState(db: Db, id: string, now = new Date(), internal: readonly string[] = []) {
  return db.transaction(tx => readAdminCampaignState(tx, id, now, internal), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

async function readAdminCampaignState(db: DbOrTx, id: string, now: Date, internal: readonly string[]) {
  const state = await readCampaignState(db, id, undefined, now, true, internal);
  const entrants = await db.select({ wallet: participants.wallet, username: players.name,
    joinedAt: participants.joinedAt, disqualifiedAt: participants.disqualifiedAt,
    disqualificationReason: participants.disqualificationReason, bonusAt: participants.bonusAt }).from(participants)
    .leftJoin(players, eq(players.wallet, participants.wallet)).where(eq(participants.campaignId, id));
  const entries = await db.select({ id: submissions.id, wallet: submissions.wallet, username: players.name,
    kind: submissions.kind, reportId: submissions.reportId, url: submissions.url, createdAt: submissions.createdAt }).from(submissions)
    .leftJoin(players, eq(players.wallet, submissions.wallet)).where(eq(submissions.campaignId, id));
  const automatic = state.kind === 'founding' ? state.standings.filter(s => !entrants.some(e => e.wallet === s.wallet)).map(s => ({ wallet: s.wallet, username: s.username, joinedAt: state.startAt, disqualifiedAt: null, disqualificationReason: null, bonusAt: null })) : [];
  return { ...state, participants: [...entrants, ...automatic], submissions: entries,
    awards: await db.select().from(awards).where(eq(awards.campaignId, id)),
    mintVerification: await mintVerificationStatus(db, internal, now),
    closeVerification: await campaignCloseVerification(db, state),
  };
}

export async function exportCampaign(db: Db, id: string, internal: readonly string[] = []) {
  return db.transaction(async tx => ({ ...(await readAdminCampaignState(tx, id, new Date(), internal)),
    audit: await tx.select().from(audit).where(eq(audit.campaignId, id)).orderBy(audit.revision),
    scoreEvidence: await tx.select().from(campaignDays).where(eq(campaignDays.campaignId, id)),
    eligibilityEvidence: await tx.select().from(scoreRows).where(eq(scoreRows.campaignId, id)),
    closeDeedEvidence: await tx.select().from(closeEvidence).where(eq(closeEvidence.campaignId, id)),
  }), { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Worker entry: reconcile all evidence in each live window, then replace its
 * derived ledger atomically. Cancelled construction may reduce campaign scores. */
export async function refreshPlaytestCampaign(db: Db, id: string, internalWallets: readonly string[], now = new Date()) {
  return db.transaction(async tx => {
    const c = await lockedCampaign(tx, id);
    if (!c.startAt || !c.endAt || now <= c.startAt || c.cancelledAt || c.finalizedAt) return;
    await reconcileCampaign(tx, c, internalWallets, now < c.endAt ? now : c.endAt);
  });
}

async function reconcileCampaign(tx: DbTx, c: Campaign, internal: readonly string[], to: Date) {
  await reconcilePlayerActions(tx, { from: c.startAt!, to });
  const all = await tx.select().from(playerActionEvents).where(and(
    gte(playerActionEvents.occurredAt, c.startAt!), lt(playerActionEvents.occurredAt, to),
    inArray(playerActionEvents.sourceKey, [...TESTER_DAILY.sources.map(s => s.key), 'battle_fought'])));
  const registered = await tx.select().from(participants).where(eq(participants.campaignId, c.id));
  const hidden = await tx.select({ wallet: testerBoardHidden.wallet }).from(testerBoardHidden);
  const excluded = new Set([...await internalPlaytestWallets(tx, internal), ...hidden.map(h => h.wallet), ...registered.filter(p => p.disqualifiedAt).map(p => p.wallet)]);
  const byWallet = new Map<string, typeof all>();
  for (const event of all) { const events = byWallet.get(event.wallet) ?? []; events.push(event); byWallet.set(event.wallet, events); }
  const wallets = c.kind === 'founding' ? [...new Set(all.map(e => e.wallet))] : registered.map(p => p.wallet);
  const scores = wallets.filter(w => !excluded.has(w)).map(wallet => {
    const joined = registered.find(p => p.wallet === wallet)?.joinedAt;
    const start = c.kind === 'rewarded' && joined && joined > c.startAt! ? joined : c.startAt!;
    return scoreCampaignEvents(wallet, byWallet.get(wallet) ?? [], start, to);
  }).sort(compareCampaignScores);
  const eligibility = await deedEligibilityAt(tx, to);
  await tx.delete(campaignDays).where(eq(campaignDays.campaignId, c.id));
  await tx.delete(scoreRows).where(eq(scoreRows.campaignId, c.id));
  for (const score of scores) {
    const [player] = await tx.select({ name: players.name }).from(players).where(eq(players.wallet, score.wallet));
    const { days: _days, ...summary } = score;
    const eligibleDeeds = eligibility.get(score.wallet) ?? [];
    await tx.insert(scoreRows).values({ ...summary, campaignId: c.id, username: player?.name ?? '',
      eligible: c.kind === 'rewarded' || eligibleDeeds.length > 0, evidence: { eligibleDeeds, basis: 'server-state-with-finalized-observer-coverage' } });
    if (score.days.length) await tx.insert(campaignDays).values(score.days.map(day => ({ campaignId: c.id, wallet: score.wallet, ...day })));
    if (c.kind === 'rewarded' && score.activeDays >= RULES.participationBonus.activeDays) {
      const p = registered.find(p => p.wallet === score.wallet)!;
      if (!p.bonusAt) {
        const active = score.days.filter(d => d.key === 'played').sort((a, b) => +a.achievedAt - +b.achievedAt);
        const achievedAt = active[RULES.participationBonus.activeDays - 1]!.achievedAt;
        await tx.insert(testerMilestones).values({ wallet: score.wallet, key: `campaign_participation:${c.id}`,
          points: RULES.participationBonus.points, source: 'hook', achievedAt, meta: { campaignId: c.id, activeDays: RULES.participationBonus.activeDays } }).onConflictDoNothing();
        await tx.update(participants).set({ bonusAt: achievedAt }).where(and(eq(participants.campaignId, c.id), eq(participants.wallet, score.wallet)));
      }
    }
  }
  await tx.update(campaigns).set({ reconciledAt: to }).where(eq(campaigns.id, c.id));
  return scores;
}

/** Completeness includes every known original mint, including transferred deeds.
 * The verifier records unresolved assets before attaching any proof. */
export async function snapshotPlaytestFounders(db: Db, internal: readonly string[], at?: Date) {
  return db.transaction(async tx => {
    const c = await lockedCampaign(tx, RULES.foundingId);
    if (c.snapshotAt || c.startAt || c.cancelledAt || c.finalizedAt) return;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('playtest-mint-inventory', 0))`);
    const now = at ?? await campaignWallTime(tx);
    const status = await mintVerificationStatus(tx, internal, now);
    if (!status.complete) return;
    const missing = await tx.execute(sql`select asset from (
      select deed_asset_id as asset from bases
      union select deed_asset_id from players
      union select deed_asset_id from base_transfers
      union select asset_id from playtest_mint_evidence
    ) inventory left join playtest_mint_evidence m on m.asset_id=inventory.asset
    where inventory.asset is not null and m.verified_at is null limit 1`);
    if (missing.length) return;
    const [inventory] = await tx.select().from(mintInventory).where(eq(mintInventory.id, 'land-deeds'));
    const unique = await foundingMintCandidates(tx, internal);
    if (unique.length < RULES.founderSpots) return;
    for (const [i, m] of unique.slice(0, RULES.founderSpots).entries()) {
      const [p] = await tx.select({ name: players.name }).from(players).where(eq(players.wallet, m.originalWallet!));
      await tx.insert(founders).values({ wallet: m.originalWallet!, position: i + 1, username: p?.name ?? '', assetId: m.assetId,
        evidence: { signature: m.signature, slot: m.slot, transactionIndex: m.transactionIndex, confirmedAt: m.confirmedAt!.toISOString() }, snapshotAt: now });
    }
    await tx.update(campaigns).set({ snapshotAt: now, revision: c.revision + 1 }).where(eq(campaigns.id, c.id));
    const detail = { action: 'founder-snapshot', policy: 'authenticated-game-originals-v2', assets: unique.slice(0, RULES.founderSpots).map(m => m.assetId), throughSlot: inventory!.throughSlot };
    await tx.insert(audit).values({ campaignId: c.id, requestId: 'system:founder-snapshot-v2', actor: 'system', action: 'founder-snapshot',
      requestHash: createHash('sha256').update(JSON.stringify(detail)).digest('hex'), revision: c.revision + 1, detail, result: { snapshotAt: now.toISOString(), revision: c.revision + 1 }, createdAt: now });
  });
}

/** Eligibility is the last authoritative base transition strictly before close,
 * not whichever wallet holds the deed when an administrator later clicks finalize. */
async function deedStatesAt(db: DbOrTx, at: Date) {
  return db.execute(sql`select b.id as base_id,e.metadata,o.metadata as observation
    from bases b join lateral (
      select metadata from player_action_events where source_key='deed_eligibility' and base_id=b.id
        and occurred_at < ${at.toISOString()}::timestamptz order by occurred_at desc,captured_at desc,id desc limit 1
    ) e on true left join lateral (
      select metadata from player_action_events where source_key='deed_observation' and base_id=b.id
        and occurred_at < ${at.toISOString()}::timestamptz order by occurred_at desc,captured_at desc,id desc limit 1
    ) o on true`);
}

async function deedEligibilityAt(db: DbOrTx, at: Date, requireCoverage = false): Promise<Map<string, string[]>> {
  const rows = await deedStatesAt(db, at);
  const owners = new Map<string, string[]>();
  let active = 0;
  let uncovered = 0;
  for (const row of rows) {
    const m = row['metadata'] as Record<string, unknown>;
    if (m['status'] !== 'active' || m['paid'] !== true || typeof m['deedAssetId'] !== 'string' || !m['deedAssetId'] || typeof m['ownerWallet'] !== 'string') continue;
    active += 1;
    const o = row['observation'] as Record<string, unknown> | null;
    const checked = o?.['checkedAt'] ? new Date(String(o['checkedAt'])).getTime() : Number.NaN;
    const fresh = o?.['status'] === 'owned' && o['owner'] === m['ownerWallet'] && o['assetId'] === m['deedAssetId'] &&
      o['slot'] !== null && o['slot'] !== undefined && checked <= at.getTime() &&
      at.getTime() - checked <= BASE_OWNERSHIP.observationHealthFreshnessMs;
    if (!fresh) { uncovered += 1; continue; }
    const deeds = owners.get(m['ownerWallet']) ?? [];
    deeds.push(m['deedAssetId']);
    owners.set(m['ownerWallet'], deeds);
  }
  if (requireCoverage && (uncovered > 0 || active > BASE_OWNERSHIP.observationMaxActiveDeeds)) {
    throw new HttpError(409, 'close-time deed observation coverage is incomplete; verify ownership evidence before finalizing', 'CAMPAIGN_DEED_COVERAGE');
  }
  return owners;
}

export async function mintVerificationStatus(db: DbOrTx, internal: readonly string[] = [], at?: Date) {
  const now = at ?? await campaignWallTime(db);
  const [diagnostic] = await db.select().from(playtestMintStatus).where(eq(playtestMintStatus.id, 'land-deeds'));
  const [inventory] = await db.select().from(mintInventory).where(eq(mintInventory.id, 'land-deeds'));
  const evidence = await db.select().from(mintEvidence);
  const missing = await db.execute(sql`select asset from (
    select deed_asset_id as asset from bases union select deed_asset_id from players
    union select deed_asset_id from base_transfers union select asset_id from playtest_mint_evidence
  ) inventory left join playtest_mint_evidence m on m.asset_id=inventory.asset
  where inventory.asset is not null and m.verified_at is null`);
  const ambiguous = evidence.filter(e => e.verifiedAt && evidence.some(other => other.assetId !== e.assetId && other.verifiedAt && other.slot === e.slot && other.transactionIndex === e.transactionIndex && other.originalWallet !== e.originalWallet));
  const covered = inventory ? evidence.filter(e => e.verifiedAt && e.slot && BigInt(e.slot) <= BigInt(inventory.throughSlot)) : [];
  const age = inventory ? now.getTime() - inventory.completedAt.getTime() : Number.POSITIVE_INFINITY;
  const fresh = age >= 0 && age <= MINT_INVENTORY.receiptFreshnessMs;
  const complete = !!inventory && fresh && missing.length === 0 && ambiguous.length === 0 && covered.length === inventory.assetCount && evidence.every(e => !!e.verifiedAt);
  return { complete,
    unresolvedAssets: [...new Set([...missing.map(r => String(r['asset'])), ...ambiguous.map(e => e.assetId)])],
    verifiedUniqueWallets: (await foundingMintCandidates(db, internal)).length,
    inventoryCompletedAt: inventory?.completedAt.toISOString() ?? null,
    status: inventory && !fresh ? 'stale' as const : complete ? 'verified' as const : 'unavailable' as const,
    lastAttemptAt: diagnostic?.lastAttemptAt.toISOString() ?? null,
    lastSuccessAt: diagnostic?.lastSuccessAt?.toISOString() ?? inventory?.completedAt.toISOString() ?? null,
    reason: inventory && !fresh ? 'receipt_stale' : inventory && !complete ? 'proof_unresolved' : diagnostic?.reason ?? null,
    diagnostics: diagnostic?.diagnostics ?? null };
}

export async function finalizePlaytestCampaign(db: Db, id: string, actor: string, receipt: AdminReceipt,
  internal: readonly string[], now?: Date) {
  const wall = now ?? await campaignWallTime(db);
  const [candidate] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!candidate) throw new HttpError(404, 'campaign not found');
  if (!candidate.finalizedAt && !candidate.cancelledAt && (!candidate.endAt || wall < candidate.endAt)) {
    throw new HttpError(409, 'campaign has not reached its database close time');
  }
  if (candidate.endAt && !candidate.finalizedAt && !candidate.cancelledAt) {
    // Drain accepted work in a separate, short transaction. Releasing SHARE
    // before FK-backed score writes avoids inverting gameplay's player locks.
    // Live recorders after this barrier sample acceptance time after the close.
    await db.transaction(async barrier => {
      await barrier.execute(sql`lock table player_action_events in share mode`);
      if ((now ?? await campaignWallTime(barrier)) < candidate.endAt!) throw new HttpError(409, 'campaign has not reached its database close time');
    });
  }
  return campaignAdminMutation(db, id, actor, receipt, { action: 'finalize' }, async (tx, c, now) => {
    if (c.cancelledAt || c.finalizedAt || !c.startAt || !c.endAt || now < c.endAt) throw new HttpError(409, 'campaign must have ended before finalization');
    const scores = await reconcileCampaign(tx, c, internal, c.endAt);
    if (!scores) throw new HttpError(409, 'campaign reconciliation unavailable');
    let selected: Array<{ prizeId: string; wallet: string; amountUsd: number; category: string }>;
    if (c.kind === 'rewarded') selected = allocateGameplayAwards(scores);
    else {
      if (!c.snapshotAt) throw new HttpError(409, 'verified founders snapshot required');
      const guaranteed = new Set((await tx.select({ wallet: founders.wallet }).from(founders)).map(f => f.wallet));
      const eligibility = await deedEligibilityAt(tx, c.endAt, true);
      const verified = await campaignCloseVerification(tx, c);
      if (!verified.complete) throw new HttpError(409, 'chain ownership at close needs verification or reconciliation', 'CAMPAIGN_CLOSE_VERIFICATION');
      selected = selectFoundingAwards(scores, guaranteed, new Set(eligibility.keys()));
    }
    for (const winner of selected) {
      const [standing] = await tx.select().from(scoreRows).where(and(eq(scoreRows.campaignId, id), eq(scoreRows.wallet, winner.wallet)));
      await tx.insert(awards).values({ ...winner, campaignId: id, username: standing!.username, decidedAt: now,
        evidence: { points: standing!.points, activeDays: standing!.activeDays, longestStreak: standing!.longestStreak,
          revenge: standing!.revenge, stages: standing!.stages, achievedAt: standing!.achievedAt.toISOString(), eligibility: standing!.evidence } });
    }
    await tx.update(campaigns).set({ finalizedAt: now, registrationOpen: false }).where(eq(campaigns.id, id));
  }, now);
}

export interface CampaignCloseDeed {
  assetId: string; ownerWallet: string; baseId: string;
  observation: { assetId: string; owner: string | null; slot: string | null; status: string; checkedAt: string } | null;
}
async function closeDeedsAt(db: DbOrTx, endAt: Date): Promise<CampaignCloseDeed[]> {
  const rows = await deedStatesAt(db, endAt);
  return rows.flatMap(row => {
    const m = row['metadata'] as Record<string, unknown>;
    if (m['status'] !== 'active' || m['paid'] !== true || typeof m['deedAssetId'] !== 'string' || !m['deedAssetId'] || typeof m['ownerWallet'] !== 'string') return [];
    return [{ assetId: m['deedAssetId'], ownerWallet: m['ownerWallet'], baseId: String(row['base_id']),
      observation: row['observation'] as CampaignCloseDeed['observation'] }];
  });
}

/** Root-owned verifier consumes exactly the same frozen source state as finalization. */
export async function requiredCampaignCloseDeeds(db: Db, id: string): Promise<CampaignCloseDeed[]> {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!c || c.kind !== 'founding' || !c.endAt) return [];
  return closeDeedsAt(db, c.endAt);
}

async function campaignCloseVerification(db: DbOrTx, c: Pick<Campaign, 'id' | 'kind' | 'endAt'>) {
  if (c.kind !== 'founding' || !c.endAt) return { complete: false, missingAssets: [] as Array<{ assetId: string; wallet: string; reason: string }> };
  const needed = await closeDeedsAt(db, c.endAt);
  const receipts = await db.select().from(closeEvidence).where(eq(closeEvidence.campaignId, c.id));
  const missingAssets = needed.flatMap(deed => {
    const receipt = receipts.find(r => r.assetId === deed.assetId);
    const reason = !receipt ? 'Awaiting chain verification' : receipt.error ? receipt.error : !receipt.verifiedAt ? 'Verification incomplete' :
      receipt.ownerAtClose !== deed.ownerWallet ? 'Chain owner at close differs from recorded server owner; reconciliation required' : null;
    return reason ? [{ assetId: deed.assetId, wallet: deed.ownerWallet, reason }] : [];
  });
  return { complete: missingAssets.length === 0, missingAssets };
}
