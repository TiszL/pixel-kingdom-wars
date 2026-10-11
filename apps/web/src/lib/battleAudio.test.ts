import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AUDIO_RUNTIME } from '@shardkeep/shared';
import { registerSfxAssets } from './audio';
import { planBattleSfx, productionBankWindowsForPlan } from './battleAudio';

type Event = { t: number; e: string } & Record<string, unknown>;

const troops = [
  'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer',
  'giant', 'troll', 'dragon', 'mage', 'bilgewraith', 'gloamfang',
  'direwyvern', 'hexbarrow',
] as const;

function run(id: number, troop: string, technique: string, targetKind = 'building'): Event {
  return {
    t: id + 20, e: 'attackRun', id, side: 'attacker', troop, targetKind,
    target: targetKind === 'building' ? 'keep' : 999, ix: 256, iy: 256,
    mode: ['arrow', 'boulder', 'bolt', 'breath', 'hexshot'].includes(technique)
      ? 'projectile' : 'melee',
    technique, cycleMs: 100, releaseOffsetMs: 20, cycleTicks: 1,
    releaseOffsetTicks: 0, impactOffsetsTicks: [1], cadenceTicks: 1, count: 1,
  };
}

function catalogFamilies(prefix: string): Set<string> {
  const catalog = JSON.parse(readFileSync(
    new URL('../../../../scripts/audio-production/catalog.json', import.meta.url), 'utf8',
  )) as { entries: Array<{ familyId: string }> };
  return new Set(catalog.entries.map((entry) => entry.familyId)
    .filter((family) => family.startsWith(prefix)));
}

describe('production battle audio routing', () => {
  it('covers every current troop family from an authoritative replay verb', () => {
    const events: Event[] = troops.map((troop, id) => ({
      t: id, e: 'deploy', id, troop, x: 0, y: 0,
    }));
    events.push(
      { t: 15, e: 'troopSpawn', id: 50, troop: 'barrowling' },
      { t: 16, e: 'spawn', id: 51, troop: 'wyrmling' },
      run(0, 'highlander', 'strike'), run(1, 'bowman', 'arrow'),
      run(3, 'tunneler', 'strike'), run(4, 'turrider', 'strike'),
      run(5, 'plunderer', 'strike'), run(6, 'giant', 'strike'),
      run(60, 'giant', 'boulder'), run(7, 'troll', 'slam'),
      run(70, 'troll', 'slam', 'troop'), run(8, 'dragon', 'breath'),
      run(9, 'mage', 'bolt'), run(10, 'bilgewraith', 'strike'),
      run(11, 'gloamfang', 'rend'), run(12, 'direwyvern', 'maul'),
      run(13, 'hexbarrow', 'hexshot'), run(50, 'barrowling', 'strike'),
      run(51, 'wyrmling', 'breath'),
      { t: 40, e: 'detonate', id: 2 },
      { t: 41, e: 'burrow', id: 3 }, { t: 42, e: 'emerge', id: 3 },
      { t: 43, e: 'burrow', id: 10 }, { t: 44, e: 'emerge', id: 10 },
      { t: 45, e: 'troopAbility', id: 11, ability: 'howl' },
      { t: 46, e: 'troopAbility', id: 11, ability: 'lunge' },
      { t: 47, e: 'troopAbility', id: 12, ability: 'firestorm' },
      { t: 48, e: 'troopAbility', id: 12, ability: 'maul' },
      { t: 49, e: 'troopAbility', id: 13, ability: 'disgorge' },
    );
    [...troops, 'barrowling', 'wyrmling'].forEach((troop, index) => {
      events.push({ t: 80 + index, e: 'troopDeath', id: index < troops.length ? index : 50 + index - troops.length, troop });
    });

    expect(new Set(planBattleSfx(events, []).map((cue) => cue.family)
      .filter((family) => family.startsWith('sfx_troop_'))))
      .toEqual(catalogFamilies('sfx_troop_'));
  });

  it('covers every current hero and defense family without routing generic hit events', () => {
    const skillNames = [
      'crimsonDash', 'moonsunderWave', 'degenAwakening',
      'doubleOrNothingHeads', 'doubleOrNothingTails', 'omegaShardstorm',
      'cheekQuake', 'snotRocket', 'cannonball', 'skillIssue', 'bellyBounce',
      'brownNote', 'rageQuit', 'rageQuitWake', 'silentButDeadly',
    ];
    const events: Event[] = [
      { t: 0, e: 'deploy', id: 1, troop: 'highlander', hero: 'vex' },
      { t: 0, e: 'deploy', id: 2, troop: 'giant', hero: 'theodor' },
      { t: 1, e: 'heroAttack', id: 1, hero: 'vex' },
      { t: 1, e: 'heroAttack', id: 2, hero: 'theodor' },
      ...skillNames.map((skill, index) => ({ t: index + 2, e: 'heroSkill', id: index < 6 ? 1 : 2, skill, phase: 'impact' })),
      { t: 30, e: 'troopDeath', id: 1 }, { t: 31, e: 'troopDeath', id: 2 },
      { t: 90, e: 'hit', target: 1, dmg: 5 },
    ];
    const defenses = ['cannon', 'archertower', 'mortar', 'electrictower', 'magetower', 'lasertower'];
    defenses.forEach((type, index) => events.push({
      t: 40 + index, e: 'fire', id: type, releaseOffsetMs: 20, impactOffsetTicks: 2,
    }));
    events.push(
      { t: 50, e: 'spawn', id: 80, troop: 'wyrmling' },
      { t: 51, e: 'trap', id: 'spiketrap' },
    );
    const plan = planBattleSfx(events, [
      ...defenses.map((type) => ({ id: type, type })),
      { id: 'spiketrap', type: 'spiketrap' },
    ]);
    const families = new Set(plan.map((cue) => cue.family));
    expect(new Set([...families].filter((family) => family.startsWith('sfx_hero_'))))
      .toEqual(catalogFamilies('sfx_hero_'));
    expect(new Set([...families].filter((family) => family.startsWith('sfx_defense_'))))
      .toEqual(catalogFamilies('sfx_defense_'));
    expect(plan.some((cue) => cue.variantKey.includes(':hit'))).toBe(false);
  });

  it('keeps loops actor-owned and leaves the future timeout cue dormant', () => {
    const plan = planBattleSfx([
      { t: 0, e: 'deploy', id: 1, troop: 'kegrunner' },
      { t: 1, e: 'deploy', id: 2, troop: 'tunneler' },
      { t: 2, e: 'burrow', id: 2 },
      { t: 3, e: 'rally' }, { t: 4, e: 'star', n: 3 },
    ], []);
    expect(plan.filter((cue) => cue.opts?.loop).every((cue) => cue.dispatch === 'actorLoop')).toBe(true);
    expect(plan.some((cue) => cue.family === 'sfx_battle_defeat_timeout')).toBe(false);
  });

  it('lets attackRun exclusively own matching compatibility attack verbs', () => {
    const plan = planBattleSfx([
      { t: 0, e: 'deploy', id: 7, troop: 'mage', x: 0, y: 0 },
      run(7, 'mage', 'bolt'),
      { t: 27, e: 'troopFire', id: 7, target: 'keep', proj: 'bolt' },
      // A different tick is genuinely legacy-only and must remain audible.
      { t: 99, e: 'troopFire', id: 7, target: 'keep', proj: 'bolt' },
    ], []);
    expect(plan.filter((cue) => cue.atMs === 2_700)).toHaveLength(0);
    expect(plan.filter((cue) => cue.variantKey.startsWith('7:27:'))).toHaveLength(2);
    expect(plan.filter((cue) => cue.variantKey.startsWith('7:99:'))).toHaveLength(2);
  });

  it('partitions exact deterministic variants into rolling mobile decode windows', () => {
    registerSfxAssets([
      { id: 'sfx_ui_tap_v1', file: '/audio/sfx-ai/ui/tap-v1.mp3' },
      { id: 'sfx_ui_tap_v2', file: '/audio/sfx-ai/ui/tap-v2.mp3' },
    ]);
    const windows = productionBankWindowsForPlan([
      { atMs: 1_000, family: 'sfx_ui_tap', variantKey: 'first' },
      { atMs: AUDIO_RUNTIME.battleBankWindowMs + 1, family: 'sfx_ui_tap', variantKey: 'second' },
    ]);
    expect(windows.map((window) => window.startMs)).toEqual([
      0, AUDIO_RUNTIME.battleBankWindowMs,
    ]);
    expect(windows.every((window) => window.cues.length === 1)).toBe(true);
  });

  it('admits no-fallback and earlier cues first when an oversized slice degrades', () => {
    registerSfxAssets([
      { id: 'sfx_ui_tap_v1', file: '/audio/sfx-ai/ui/tap-v1.mp3' },
      { id: 'sfx_ui_error_v1', file: '/audio/sfx-ai/ui/error-v1.mp3' },
      { id: 'sfx_ui_confirm_v1', file: '/audio/sfx-ai/ui/confirm-v1.mp3' },
    ]);
    const [window] = productionBankWindowsForPlan([
      { atMs: 100, family: 'sfx_ui_tap', variantKey: 'no-fallback-later' },
      {
        atMs: 1, family: 'sfx_ui_error', variantKey: 'fallback-critical',
        fallback: 'sfx_error',
        opts: { priority: 'critical' },
      },
      { atMs: 50, family: 'sfx_ui_confirm', variantKey: 'no-fallback-earlier' },
    ]);
    expect(window?.cues[0]).toBe('sfx_ui_confirm_v1');
    expect(window?.cues[1]).toMatch(/^sfx_ui_tap_v[12]$/);
    expect(window?.cues[2]).toBe('sfx_ui_error_v1');
  });
});
