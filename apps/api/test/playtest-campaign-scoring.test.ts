import { describe, expect, it } from 'vitest';
import { TESTER_DAILY, PLAYTEST_COMPETITIONS, PLAYTEST_COMPETITIONS as RULES } from '@shardkeep/shared';
import { allocateGameplayAwards, selectFoundingAwards, compareCampaignScores, scoreCampaignEvents, type CampaignEvent, type CampaignScore } from '../src/game/playtestCampaignScoring';

const from = new Date('2026-09-10T12:30:00Z');
const to = new Date('2026-09-24T12:30:00Z');
let seq = 0;
function event(at: string, sourceKey = 'chat_sent', extra: Partial<CampaignEvent> = {}): CampaignEvent {
  const id = `e-${seq++}`;
  return { id, wallet: 'wallet', sourceKey, occurredAt: new Date(at), capturedAt: new Date(at), sourceId: id,
    sourceTable: 'test', baseId: null, metadata: {}, active: true, fought: false, invalidatedForScoringAt: null, ...extra };
}
const points = (key: string) => TESTER_DAILY.sources.find(s => s.key === key)!.points;
const score = (events: CampaignEvent[], start = from) => scoreCampaignEvents('wallet', events, start, to);

it('filters launch, opt-in and exclusive close before assigning UTC days or caps', () => {
  const events = [event('2026-09-10T12:29:59.999Z'), event('2026-09-10T12:30:00Z'), event('2026-09-24T12:29:59.999Z'), event('2026-09-24T12:30:00Z')];
  expect(score(events).activeDays).toBe(2);
  expect(score(events).points).toBe(2 * (points('played') + points('chat_sent')));
  expect(score(events, new Date('2026-09-10T12:30:00.001Z')).activeDays).toBe(1);
});
it('daily caps choose the earliest paying events so later spam cannot worsen the final-score tie time', () => {
  const s = score([event('2026-09-11T00:00:00Z'), event('2026-09-11T22:00:00Z')]);
  expect(s.points).toBe(points('played') + points('chat_sent'));
  expect(s.achievedAt.toISOString()).toBe('2026-09-11T00:00:00.000Z');
});
it('counts real losing deployments as played without inventing victory points or passive activity', () => {
  const s = score([event('2026-09-11T00:00:00Z', 'battle_fought', { fought: true }),
    event('2026-09-12T00:00:00Z', 'defence_held', { active: false })]);
  expect(s.activeDays).toBe(1);
  expect(s.points).toBe(points('played') + points('defence_held'));
});
it('starts streaks fresh, grants each threshold once per run and restarts after a gap', () => {
  const events = ['09', '10', '11', '12', '14', '15', '16'].map(d => event(`2026-09-${d}T15:00:00Z`));
  const s = score(events);
  expect(s.longestStreak).toBe(3);
  expect(s.days.filter(d => d.key === 'streak_3')).toHaveLength(2);
  expect(s.days.filter(d => d.key.startsWith('streak_')).reduce((n, d) => n + d.points, 0))
    .toBe(2 * TESTER_DAILY.streaks.find(s => s.days === 3)!.points);
});
it('deduplicates referees only after the exact window, never turns passive referral points into a played day', () => {
  const events = [event('2026-09-10T12:29:00Z', 'referral_active', { active: false, metadata: { refereeWallet: 'friend' } }),
    event('2026-09-10T12:31:00Z', 'referral_active', { active: false, metadata: { refereeWallet: 'friend' } }),
    event('2026-09-10T12:32:00Z', 'referral_active', { active: false, metadata: { refereeWallet: 'friend' } }),
    ...Array.from({ length: 30 }, (_, i) => event('2026-09-10T13:00:00Z', 'referral_active', { active: false, metadata: { refereeWallet: `friend${i}` } }))];
  const s = score(events);
  expect(s.activeDays).toBe(0);
  expect(s.points).toBe(points('referral_active') * TESTER_DAILY.sources.find(s => s.key === 'referral_active')!.cap);
});
it('invalidated construction no longer affects campaign points, activity or streaks', () => {
  expect(score([event('2026-09-11T00:00:00Z', 'build_started', { invalidatedForScoringAt: new Date('2026-09-12T00:00:00Z') })]).points).toBe(0);
});
it('counts revenge once per opposing wallet/day and distinct three-star stages only', () => {
  const e = (day: string, opponentWallet: string, originalAttackId?: string) => event(day, 'pvp_win', { active: false,
    metadata: { opponentWallet, ...(originalAttackId ? { originalAttackId } : {}) } });
  const s = score([e('2026-09-11T00:00:00Z', 'opponent', 'prior'), e('2026-09-11T02:00:00Z', 'opponent', 'prior'),
    e('2026-09-12T00:00:00Z', 'opponent', 'prior'), e('2026-09-12T00:00:00Z', 'wallet', 'prior'),
    e('2026-09-12T00:00:00Z', 'unproven'),
    ...[1, 1, 2].map(campaignStage => event('2026-09-11T00:00:00Z', 'pve_battle', { metadata: { campaignStage, stars: 3 } })),
    event('2026-09-11T00:00:00Z', 'pve_battle', { metadata: { campaignStage: 3, stars: 2 } })]);
  expect(s.revenge).toBe(2); expect(s.stages).toBe(2);
});

describe('winner allocation', () => {
  const entrant = (wallet: string, points: number, extra: Partial<CampaignScore> = {}): CampaignScore =>
    ({ wallet, points, activeDays: 3, longestStreak: 3, revenge: 1, stages: 1, achievedAt: from, days: [], ...extra });
  it('uses points, activity, earliest final score, then wallet for reproducible ties', () => {
    const ranked = [entrant('c', 10, { activeDays: 4 }), entrant('b', 10), entrant('a', 10), entrant('d', 11)].sort(compareCampaignScores);
    expect(ranked.map(s => s.wallet)).toEqual(['d', 'c', 'a', 'b']);
  });
  it('allocates in published order, one gameplay award per wallet, without filling unsupported awards', () => {
    const scores = Array.from({ length: 6 }, (_, i) => entrant(`wallet${i}`, 100 - i, { revenge: i === 3 ? 2 : 0 }));
    const awards = allocateGameplayAwards(scores);
    expect(awards.map(a => a.prizeId)).toEqual(['champion', 'challenger', 'bronze', 'revenge', 'daily', 'explorer']);
    expect(new Set(awards.map(a => a.wallet)).size).toBe(awards.length);
    expect(allocateGameplayAwards([entrant('empty', 0)])).toEqual([]);
  });
  it('reserves 250 additional whitelist spots without spending one on a guaranteed founder or deedless score leader', () => {
    const candidates = Array.from({ length: 253 }, (_, i) => entrant(`wallet${i}`, 1000 - i));
    const selected = selectFoundingAwards(candidates, new Set(['wallet0']), new Set(candidates.slice(0, 1).concat(candidates.slice(2)).map(s => s.wallet)));
    expect(selected).toHaveLength(RULES.rankedSpots);
    expect(selected[0]?.wallet).toBe('wallet2');
    expect(selected.some(s => s.wallet === 'wallet0' || s.wallet === 'wallet1')).toBe(false);
  });
  it('publishes the agreed $600 pool with a separate $100 objectively judged video award', () => {
    expect(PLAYTEST_COMPETITIONS.prizes.reduce((n, p) => n + p.amountUsd, 0)).toBe(600);
    expect(PLAYTEST_COMPETITIONS.prizes.find(p => p.id === 'video')?.amountUsd).toBe(100);
    expect(Object.values(PLAYTEST_COMPETITIONS.videoWeights).reduce((n, p) => n + p, 0)).toBe(100);
  });
});
