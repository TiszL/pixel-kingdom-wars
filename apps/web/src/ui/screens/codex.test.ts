import {
  ART_V2, BUILD_COSTS, DEFENSES, KEEP_BATTERIES, SHIELD, STRUCTURES, TROOP_ABILITIES, TROOPS,
  fmtDur, warePortraitAliasKey,
} from '@shardkeep/shared';
import { describe, expect, it } from 'vitest';
import { CODEX } from './codex';
import { TROOP_DISPLAY } from '../copy';

describe('lazy Codex future roster', () => {
  it('labels train costs as SHARDS and reads every value from TROOPS', () => {
    for (const key of [
      'highlander', 'bowman', 'kegrunner', 'tunneler', 'turrider', 'plunderer',
      'gloamfang', 'direwyvern', 'hexbarrow',
    ] as const) {
      const entry = CODEX.TROOPS.find((candidate) => candidate.name === TROOP_DISPLAY[key]);
      expect(entry?.tag).toContain(`${TROOPS[key].costKeep} SHARDS`);
      expect(entry?.tag).not.toContain(`${TROOPS[key].costKeep} KEEP`);
    }
  });

  it('documents every newly active root plus its replay-only spawn product', () => {
    const entries = new Map(CODEX.TROOPS.map((entry) => [entry.name, entry]));
    expect([...entries.keys()]).toEqual(expect.arrayContaining([
      'GLOAMFANG', 'DIREWYVERN', 'HEXBARROW', 'BARROWLING',
    ]));
    expect(entries.get('DIREWYVERN')?.tag).toContain(`${TROOPS.direwyvern.pts} PTS`);
    // D-058 (owner 2026-08-16): the Keep-level gate is retired — these troops
    // unlock via Gold-Forge TRAINING WRITS, and the Codex must say so instead
    // of advertising a Keep level that no longer opens anything.
    expect(entries.get('DIREWYVERN')?.tag).toContain('FORGE WRIT');
    expect(entries.get('GLOAMFANG')?.tag).toContain('FORGE WRIT');
    expect(entries.get('HEXBARROW')?.tag).toContain('FORGE WRIT');
    for (const unit of ['gloamfang', 'direwyvern', 'hexbarrow', 'barrowling']) {
      expect(entries.get(unit.toUpperCase())?.img).toBe(`trp_${unit}_portrait`);
    }
  });

  it('states that Barrowling is spawn-only instead of presenting a train cost', () => {
    const barrowling = CODEX.TROOPS.find((entry) => entry.name === 'BARROWLING');
    expect(barrowling?.tag).toContain('SPAWN ONLY');
    expect(barrowling?.tag).toContain(`${TROOP_ABILITIES.hexbarrow.brood.variants} VARIANTS`);
    expect(barrowling?.who).toContain('cannot be trained');
  });
});

describe('M22 building Codex', () => {
  it('documents every new defense/trap with shared-owned values and portraits', () => {
    const entries = new Map(CODEX.DEFENSE.map((entry) => [entry.name, entry]));
    expect([...entries.keys()]).toEqual(expect.arrayContaining([
      'AIR DEFENCE', 'SPIKE TRAP', 'POWDER MINE', 'PITFALL', 'AIR MINE',
    ]));
    expect(entries.get('AIR DEFENCE')).toMatchObject({
      img: warePortraitAliasKey('airdefence', 1),
    });
    expect(entries.get('AIR DEFENCE')?.tag).toContain(`RANGE ${DEFENSES.airdefence.rangeTiles}`);
    expect(entries.get('AIR DEFENCE')?.tag)
      .toContain(`KEEP L${BUILD_COSTS.airdefence.requiresKeepLevel}`);
    // D-060: cannon/archer ranges were hardcoded prose and went stale the
    // moment the owner doubled the cannon — the tags must read DEFENSES.
    expect(entries.get('CANNON')?.tag).toContain(`RANGE ${DEFENSES.cannon.rangeTiles}`);
    expect(entries.get('ARCHER TOWER')?.tag).toContain(`RANGE ${DEFENSES.archertower.rangeTiles}`);
    expect(entries.get('ARCHER TOWER')?.img).toBe(warePortraitAliasKey('archertower', 1));
    expect(entries.get('POWDER MINE')?.img).toBe(warePortraitAliasKey('powdermine', 1));
    expect(entries.get('PITFALL')?.img).toBe(warePortraitAliasKey('pitfall', 1));
    expect(entries.get('AIR MINE')?.img).toBe(warePortraitAliasKey('airmine', 1));
    expect(entries.get('SPIKE TRAP')?.strat).toContain('inert until repaired');
    expect(entries.get('WALLS')?.tag).toContain('5 ART TIERS');
    expect(entries.get('WALLS')?.img).toBe('wall5_t1_straight_intact_f1');
  });

  it('presents forge as Alchemy Lab and includes the destructible Clan Hall', () => {
    const entries = new Map(CODEX.BUILDINGS.map((entry) => [entry.name, entry]));
    expect(entries.has('FORGE')).toBe(false);
    expect(entries.get('ALCHEMY LAB')).toMatchObject({ img: warePortraitAliasKey('forge', 1) });
    expect(entries.get('ALCHEMY LAB')?.tag).toContain(`L1–L${STRUCTURES.forge.maxLevel}`);
    expect(entries.get('CLAN HALL')).toMatchObject({ img: warePortraitAliasKey('clanhall', 1) });
    expect(entries.get('CLAN HALL')?.tag).toContain(`KEEP L${BUILD_COSTS.clanhall.requiresKeepLevel}`);
    expect(entries.get('CLAN HALL')?.strat).toContain('counts toward raid destruction');
    for (const unit of ['keep', 'mine', 'vault', 'barracks', 'camp'] as const) {
      const name = unit === 'camp' ? 'ARMY CAMP' : unit.toUpperCase();
      expect(entries.get(name)?.img).toBe(warePortraitAliasKey(unit, 1));
    }
    expect(entries.get('KEEP')?.strat).toContain(`L${KEEP_BATTERIES.highRangeUnlockLevel}`);
    expect(entries.get('KEEP')?.strat).toContain(`L${KEEP_BATTERIES.lowRangeUnlockLevel}`);
  });
});

/**
 * The SHIELD entry used to carry a hardcoded "24H AFTER A LOSS" while
 * SHIELD.hoursOnLoss had been 48 since 2026-08-12 — a codex that lies about a
 * defensive rule. Game numbers live in constants; the codex renders them, and
 * anything over a day is spoken in days (owner 2026-08-23).
 */
describe('Codex shield rule', () => {
  it('states the shield window from SHIELD.*, in days once it passes a day', () => {
    const shield = CODEX.ITEMS.find((entry) => entry.name === 'SHIELD');
    expect(shield?.tag).toBe(`${fmtDur(SHIELD.hoursOnLoss * 3_600).toUpperCase()} AFTER A LOSS`);
    expect(shield?.tag).toBe('2D AFTER A LOSS');
    expect(shield?.who).toContain(`max ${fmtDur(SHIELD.maxHours * 3_600).toUpperCase()}`);
  });
});
