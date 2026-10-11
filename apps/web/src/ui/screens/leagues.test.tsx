/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { LEAGUES, type LeagueOverview } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../../state/store';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const apiGet = vi.fn();
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, get: (...args: unknown[]) => apiGet(...args) } };
});

import LeaguesScreen, { tierRewardLines, weeklyCache } from './leagues';
import { LeagueChip, leagueChipAriaLabel } from './leagueChip';
import { leagueRailLabel, tierForTrophies, tierProgressPct } from './leagueTier';

const screenSource = readFileSync(`${process.cwd()}/src/ui/screens/leagues.tsx`, 'utf8');
const chipSource = readFileSync(`${process.cwd()}/src/ui/screens/leagueChip.tsx`, 'utf8');

const overview = (over: Partial<LeagueOverview> = {}): LeagueOverview => ({
  week: {
    startsAt: '2026-09-07T00:00:00.000Z',
    closesAt: '2026-09-14T00:00:00.000Z',
    settlesAt: '2026-09-14T00:15:00.000Z',
  },
  rewards: {
    status: 'active', firstSettlementAt: '2026-09-14T00:15:00.000Z',
    minRatedAttacks: 3, maxRewardedBasesPerWallet: 1,
  },
  trophyModel: 'cumulative',
  you: {
    baseId: '00000000-0000-4000-8000-000000000001', trophies: 55, tier: 'gold',
    currentWeekRatedAttacks: 2, participationMet: false,
    rewardCandidate: false, blockedByHigherBase: false,
  },
  board: [{
    rank: 1, baseId: '00000000-0000-4000-8000-000000000002',
    name: 'IRONMOOR', trophies: 151, tier: 'sol', you: false,
  }],
  lastSettlement: null,
  ...over,
});

describe('league tier + reward mirrors', () => {
  it('uses the shared cumulative boundaries exactly', () => {
    expect([0, 9, 10, 49, 50, 149, 150].map(tierForTrophies))
      .toEqual(['bronze', 'bronze', 'silver', 'silver', 'gold', 'gold', 'sol']);
    expect(tierProgressPct(50)).toBe(0);
    expect(tierProgressPct(150)).toBe(100);
    expect(leagueRailLabel(149)).toBe('1 TO SOL');
  });

  it('quotes only the exact SHARD cache and approved items', () => {
    for (const tier of ['bronze', 'silver', 'gold', 'sol'] as const) {
      for (let keepLevel = 1; keepLevel <= 20; keepLevel += 1) {
        expect(weeklyCache(tier, keepLevel)).toBe(Math.trunc(
          (LEAGUES.weeklyCacheShardsByKeepLevel[keepLevel - 1]!
            * LEAGUES.cacheTierMultBps[tier]) / 10_000,
        ));
      }
      const copy = tierRewardLines(tier, 10).join(' | ');
      expect(copy).toContain('SHARDS');
      expect(copy).not.toMatch(/pool|raid energy|powder|aegis|keep reward/i);
    }
  });

  it('keeps the HUD chip first-paint-safe and accessible', () => {
    expect(leagueChipAriaLabel(50)).toBe('GOLD league, 50 trophies');
    expect(LeagueChip({ trophies: 50, form: 'compact' })).toBeTruthy();
    expect(chipSource).not.toContain("from './leagues'");
    expect(chipSource).not.toContain("import './leagues.css'");
  });
});

describe('leagues screen', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    apiGet.mockReset();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    useApp.setState({
      base: {
        player: {
          wallet: 'w', name: 'KEEP', keepLevel: 10, trophies: 55,
          league: 'gold', builders: 1, expansions: 0,
        },
        claim: { min: 8, max: 22 }, energy: { used: 0, free: 6, max: 6 }, shield: null,
        buildings: [], obstacles: [], army: [], jobs: [], freeBuilders: 1,
      } as never,
      selectedBaseId: null,
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    useApp.setState({ base: null, selectedBaseId: null });
  });

  async function render(dto: LeagueOverview): Promise<void> {
    apiGet.mockResolvedValue(dto);
    await act(async () => { root.render(<LeaguesScreen />); });
  }

  it('states cumulative trophies, three attacks, 00:15 settlement, and one base per wallet', async () => {
    await render(overview());
    const text = host.textContent ?? '';
    expect(text).toContain('Trophies are cumulative and never reset');
    expect(text).toContain('3 resolved attacks');
    expect(text).toContain('00:15 UTC');
    expect(text).toContain('Only one base per wallet earns');
    expect(text).toContain('2 / 3');
    expect(text).toContain('COMPLETE THE ATTACK REQUIREMENT');
    expect(text).not.toMatch(/KEEP pool|raid tithe|raid energy|Aegis|Powder/);
  });

  it('renders disabled rollout state without advertising an unavailable cache', async () => {
    await render(overview({
      rewards: {
        status: 'disabled', firstSettlementAt: '2026-09-14T00:15:00.000Z',
        minRatedAttacks: 3, maxRewardedBasesPerWallet: 1,
      },
    }));
    expect(host.textContent).toContain('REWARDS ARE DISABLED. NO CACHE WILL BE CREATED');
  });

  it('renders the immutable SHARD/item receipt with no KEEP amount', async () => {
    await render(overview({
      lastSettlement: {
        week: '2026-09-07', tier: 'gold', trophies: 55, keepLevel: 10,
        cacheShards: '32000', items: [{ itemId: 'finishers_seal', qty: 1 }],
        settledAt: '2026-09-14T00:15:01.000Z',
      },
    }));
    const last = host.querySelector('.lg-last')?.textContent ?? '';
    expect(last).toContain('32,000 SHARDS');
    expect(last).toContain("1 × FINISHER'S SEAL");
    expect(last).not.toMatch(/KEEP from|KEEP reward|pool/i);
  });

  it('contains no legacy pool/tithe/energy DTO or copy', () => {
    expect(screenSource).not.toMatch(/keepAmount|lootTithe|poolSplit|weeklyEnergy/i);
  });
});
