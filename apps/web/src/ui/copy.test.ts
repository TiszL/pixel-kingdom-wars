import { isTrainableTroop, QUESTS, TROOPS, TROOP_TYPES } from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { QUEST_LABELS, TRAIN_TABLE, TROOP_DISPLAY } from './copy';

describe('troop UI roster invariants', () => {
  it('names every TroopType exactly once', () => {
    expect(Object.keys(TROOP_DISPLAY).sort()).toEqual([...TROOP_TYPES].sort());
  });

  it('offers every and only trainable troop in the barracks', () => {
    // Spawn products are real replay TroopTypes but must never leak into the
    // zero-cost barracks surface.
    const trainable = TROOP_TYPES.filter(isTrainableTroop);
    expect(TRAIN_TABLE.map((row) => row.key).sort()).toEqual([...trainable].sort());
  });

  it('presents the server-charged training price as SHARDS', () => {
    for (const row of TRAIN_TABLE) {
      expect(row.shardCost).toBe(TROOPS[row.key as keyof typeof TROOPS].costKeep);
      expect(row).not.toHaveProperty('keepCost');
    }
  });
});

describe('quest labels (M23 a15: 50 dailies + 5 weeklies + the onboarding chain)', () => {
  it('labels every daily, weekly and onboarding template id — and nothing else', () => {
    // The board falls back to templateCode.toUpperCase() for a missing label
    // (screens/quests.tsx), so a gap ships raw snake_case to players silently.
    // Pin the exact bijection with the shared pool.
    //
    // The ONBOARDING chain joined this set on 2026-08-28: those five labels are
    // the first words a new player reads, and they render through the same
    // lookup, so a gap there is the most expensive gap of the lot.
    const templateIds = [
      ...QUESTS.dailyTemplates.map((t) => t.id),
      ...QUESTS.weeklyTemplates.map((t) => t.id),
      ...QUESTS.onboardingTemplates.map((t) => t.id),
    ].sort();
    expect(Object.keys(QUEST_LABELS).sort()).toEqual(templateIds);
    for (const label of Object.values(QUEST_LABELS)) {
      expect(label).toBe(label.toUpperCase()); // board style: uppercase, like the App
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
