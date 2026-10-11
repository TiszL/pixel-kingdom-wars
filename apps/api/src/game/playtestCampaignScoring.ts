/** Pure scoring over immutable authoritative evidence, bounded before grouping.
 * Lifetime milestones and recomputation times are deliberately absent. */
import { TESTER_DAILY, PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import type { playerActionEvents } from '../db/playtestActivitySchema';
import { shiftDay, utcDay } from './actionDay';

export type CampaignEvent = typeof playerActionEvents.$inferSelect;
export interface CampaignScoreDay { day: string; key: string; count: number; points: number; achievedAt: Date; evidence: string[] }
export interface CampaignScore {
  wallet: string; points: number; activeDays: number; longestStreak: number;
  revenge: number; stages: number; achievedAt: Date; days: CampaignScoreDay[];
}

export function scoreCampaignEvents(wallet: string, input: readonly CampaignEvent[], from: Date, to: Date): CampaignScore {
  const events = input.filter(e => e.wallet === wallet && e.occurredAt >= from && e.occurredAt < to && (!e.invalidatedForScoringAt || e.invalidatedForScoringAt >= to))
    .sort((a, b) => +a.occurredAt - +b.occurredAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const groups = new Map<string, CampaignEvent[]>();
  const played = new Map<string, CampaignEvent>();
  const revenge = new Set<string>();
  const stages = new Set<number>();
  for (const e of events) {
    const day = utcDay(e.occurredAt);
    const key = `${day}|${e.sourceKey}`;
    const group = groups.get(key) ?? [];
    // Several referee actions during a day earn one credit, after exact-window filtering.
    const identity = e.sourceKey === 'referral_active' ? e.metadata['refereeWallet'] : e.sourceId;
    if (!group.some(x => (e.sourceKey === 'referral_active' ? x.metadata['refereeWallet'] : x.sourceId) === identity)) group.push(e);
    groups.set(key, group);
    if (e.active && !played.has(day)) played.set(day, e);
    if (e.sourceKey === 'pvp_win' && typeof e.metadata['originalAttackId'] === 'string' &&
      typeof e.metadata['opponentWallet'] === 'string' && e.metadata['opponentWallet'] !== wallet) revenge.add(`${day}:${e.metadata['opponentWallet']}`);
    if (e.sourceKey === 'pve_battle' && e.metadata['stars'] === 3 && typeof e.metadata['campaignStage'] === 'number') stages.add(e.metadata['campaignStage']);
  }
  const days: CampaignScoreDay[] = [];
  for (const [key, group] of groups) {
    const [day, source] = key.split('|');
    const rule = TESTER_DAILY.sources.find(s => s.key === source);
    if (!rule || !day) continue;
    const credited = group.slice(0, rule.cap);
    days.push({ day, key: rule.key, count: group.length, points: credited.length * rule.points,
      achievedAt: credited[credited.length - 1]!.occurredAt, evidence: credited.map(e => e.id) });
  }
  let longestStreak = 0;
  let run = 0;
  let previous = '';
  const playedRule = TESTER_DAILY.sources.find(s => s.key === 'played')!;
  for (const day of [...played.keys()].sort()) {
    const event = played.get(day)!;
    days.push({ day, key: 'played', count: 1, points: playedRule.points, achievedAt: event.occurredAt, evidence: [event.id] });
    run = previous && shiftDay(previous, 1) === day ? run + 1 : 1;
    previous = day;
    longestStreak = Math.max(longestStreak, run);
    const streak = TESTER_DAILY.streaks.find(s => s.days === run);
    if (streak) days.push({ day, key: streak.key, count: 1, points: streak.points, achievedAt: event.occurredAt, evidence: [event.id] });
  }
  const paid = days.filter(d => d.points > 0);
  return { wallet, points: days.reduce((n, d) => n + d.points, 0), activeDays: played.size, longestStreak,
    revenge: revenge.size * RULES.revengeWinsPerOpponentDay, stages: stages.size,
    achievedAt: paid.length ? new Date(Math.max(...paid.map(d => +d.achievedAt))) : from, days };
}

export function compareCampaignScores(a: CampaignScore, b: CampaignScore): number {
  return b.points - a.points || b.activeDays - a.activeDays || +a.achievedAt - +b.achievedAt || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0);
}
export function allocateGameplayAwards(scores: readonly CampaignScore[]) {
  const used = new Set<string>();
  const awards: Array<{ prizeId: string; wallet: string; amountUsd: number; category: string }> = [];
  for (const prize of RULES.prizes.filter(p => p.category === 'gameplay')) {
    const eligible = scores.filter(s => !used.has(s.wallet) && s.points > 0 &&
      (prize.metric === 'revenge' ? s.revenge > 0 : prize.metric === 'stages' ? s.stages > 0 : prize.metric === 'activeDays' ? s.activeDays > 0 : true));
    eligible.sort((a, b) => {
      const metric = prize.metric === 'revenge' ? b.revenge - a.revenge : prize.metric === 'stages' ? b.stages - a.stages :
        prize.metric === 'activeDays' ? b.activeDays - a.activeDays || b.longestStreak - a.longestStreak : 0;
      return metric || compareCampaignScores(a, b);
    });
    const winner = eligible[0];
    if (winner) { used.add(winner.wallet); awards.push({ prizeId: prize.id, wallet: winner.wallet, amountUsd: prize.amountUsd, category: prize.category }); }
  }
  return awards;
}

export function selectFoundingAwards(scores: readonly CampaignScore[], guaranteed: ReadonlySet<string>, eligible: ReadonlySet<string>) {
  return [...scores].sort(compareCampaignScores).filter(s => s.points > 0 && !guaranteed.has(s.wallet) && eligible.has(s.wallet))
    .slice(0, RULES.rankedSpots).map((s, i) => ({ prizeId: `whitelist-${i + 1}`, wallet: s.wallet, amountUsd: 0, category: 'whitelist' }));
}
