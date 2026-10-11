import { describe, expect, it } from 'vitest';
import { CAMPAIGN } from '@shardkeep/shared';
import { FANTASY_CHAPTERS, campaignPresentationName, campaignRoutePoint, campaignState } from './campaign';
import presentation from './campaign-presentation.json';

describe('fantasy campaign presentation preserves authoritative progress', () => {
  it('all 100 existing stage identities receive a name and a visible route point', () => {
    expect(FANTASY_CHAPTERS).toHaveLength(CAMPAIGN.totalStages / CAMPAIGN.stagesPerAct);
    const names = new Set<string>();
    for (let stage = 1; stage <= CAMPAIGN.totalStages; stage++) {
      const act = Math.ceil(stage / CAMPAIGN.stagesPerAct);
      const name = campaignPresentationName({ stage, act, name: 'SERVER FALLBACK' });
      const point = campaignRoutePoint({ stage, act });
      expect(name).not.toBe('SERVER FALLBACK');
      expect(name.length).toBeGreaterThan(3);
      names.add(name);
      expect(point.x).toBeGreaterThan(0);
      expect(point.x).toBeLessThan(1);
      expect(point.y).toBeGreaterThan(0);
      expect(point.y).toBeLessThan(1);
    }
    expect(names.size).toBe(CAMPAIGN.totalStages);
  });
  it('chapters retain the approved four-realm sequence used by the server battle theme', () => {
    expect(FANTASY_CHAPTERS.map(c => c.region)).toEqual([
      'crownlands', 'crownlands', 'elderwood', 'elderwood', 'sunscar',
      'sunscar', 'frostveil', 'frostveil', 'crownlands', 'frostveil',
    ]);
  });
  it('locked and available states come only from the server board, never stage index or local progress', () => {
    expect(campaignState({ bestStars: 0, unlocked: false })).toBe('locked');
    expect(campaignState({ bestStars: 0, unlocked: true })).toBe('available');
    expect(campaignState({ bestStars: 1, unlocked: true })).toBe('cleared');
    expect(campaignState({ bestStars: 3, unlocked: true })).toBe('cleared');
  });
  it('artwork metadata contains no demo encounters, rewards or progress', () => {
    expect(Object.keys(presentation).sort()).toEqual(['chapters', 'regions']);
    expect(JSON.stringify(presentation)).not.toMatch(/demoResult|makeDemoProgress|firstThreeStarClaimed|buildings|rewardShards/);
  });
});
