/** SIM18 combat admission only. Actual construction, art/native compatibility
 * and resource production have separate gates; this suite grants none of them. */
import { describe, expect, it } from 'vitest';
import { BuildingType, RAID_RULES, STRUCTURES, type BaseSnapshot } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { defenseCombat, footprintOf, TICKS_PER_SEC } from '../src/stats';
import { b, base, deploy, orders } from './helpers';

const TYPES = [BuildingType.Workshop, BuildingType.Lodge, BuildingType.Market, BuildingType.Harvester, BuildingType.Berth] as const;
const stage = (type: typeof TYPES[number]): BaseSnapshot => ({ ...base([
  b(type, 4, 8, 1, 'facility'), b(BuildingType.Keep, 14, 14, 1, 'keep'),
]), battlefieldVersion: 3, claimMin: 2, claimMax: 18 });
const army = () => orders([deploy('turrider', 0, 8)]);
const SEED = 0xe518;

describe('SIM18 Phase E passive structure contract', () => {
  it.each(TYPES)('%s falls once, never fires, and contributes its HP to destruction before the Keep', type => {
    const snapshot = stage(type), input = army(), full = simulateRaid(snapshot, input, SEED);
    const collapse = full.events.find(event => event.e === 'destroyed' && event.id === 'facility');
    expect(collapse).toBeDefined();
    const cut = simulateRaid(snapshot, input, SEED, { stopAfterTick: collapse!.t });
    expect(cut.buildings.find(building => building.id === 'facility')).toEqual({ id: 'facility', type,
      maxHp: STRUCTURES[type].hp, hp: 0, destroyed: true });
    expect(cut.buildings.find(building => building.id === 'keep')).toMatchObject({ hp: STRUCTURES.keep.hp, destroyed: false });
    expect(cut.destructionPct).toBe(Math.floor(100 * STRUCTURES[type].hp / (STRUCTURES[type].hp + STRUCTURES.keep.hp)));
    expect(cut.keepDestroyed).toBe(false); expect(cut.mineDestroyed).toBe(false); expect(cut.vaultDestroyed).toBe(false);
    expect(full.events.filter(event => event.e === 'destroyed' && event.id === 'facility')).toHaveLength(1);
    expect(full.events.some(event => event.e === 'fire' || event.e === 'spawn' || event.e === 'trap')).toBe(false);
    expect(cut.events).toEqual(full.events.filter(event => event.t <= collapse!.t));
  });

  it.each(TYPES)('%s retains ordinary targeting and HP scaling, without resource or defense privileges', type => {
    // Gold Forge is the existing passive 2×2 structure with the same HP ladder.
    // These two attackers expose both possible accidental category changes:
    // Plunderer prefers real resources; Giant prefers real defenses.
    for (const level of [1, 6, 11, 16, 20]) {
      expect(defenseCombat(type, level)).toBeNull();
      for (const troop of ['plunderer', 'giant'] as const) {
        const snapshot = (kind: BuildingType) => ({ ...base([
          b(kind, 4, 8, level, 'facility'), b(BuildingType.Vault, 10, 8, 1, 'vault'),
          b(BuildingType.Cannon, 12, 4, 1, 'cannon'), b(BuildingType.Keep, 14, 14, 1, 'keep'),
        ]), battlefieldVersion: 3 as const, claimMin: 2, claimMax: 18 });
        const input = orders([deploy(troop, 0, 8)]);
        const actual = simulateRaid(snapshot(type), input, SEED), reference = simulateRaid(snapshot(BuildingType.GoldForge), input, SEED);
        expect({ ...actual, buildings: actual.buildings.map(building => building.id === 'facility'
          ? { ...building, type: BuildingType.GoldForge } : building) }).toEqual(reference);
        const firstAttack = actual.events.find(event => event.e === 'attackRun' && event.targetKind === 'building');
        expect(firstAttack).toMatchObject({ target: troop === 'plunderer' ? 'vault' : 'cannon' });
      }
    }
  });

  it.each(TYPES)('%s blocks all four deployment cells and retains the original footprint after collapse', type => {
    const snapshot = stage(type);
    expect(footprintOf(type)).toEqual({ fw: 2, fh: 2 });
    for (const [tx, ty] of [[4, 8], [5, 8], [4, 9], [5, 9]] as const) {
      expect(() => simulateRaid(snapshot, orders([deploy('highlander', tx, ty)]), SEED, { stopAfterTick: 0 })).toThrow(/deploy outside/);
      expect(() => simulateRaid(snapshot, orders([], { heroDeploys: [{ hero: 'vex', tx, ty, tMs: 0 }] }), SEED, { stopAfterTick: 0 })).toThrow(/deploy outside/);
    }
    // A neighboring complete 2×2 square remains usable; no extra terrain or
    // water reservation accompanies the Berth's ordinary structure footprint.
    expect(simulateRaid(snapshot, orders([deploy('highlander', 3, 8)]), SEED, { stopAfterTick: 0 }).events
      .filter(event => event.e === 'deploy')).toHaveLength(1);
    const full = simulateRaid(snapshot, army(), SEED);
    const collapse = full.events.find(event => event.e === 'destroyed' && event.id === 'facility');
    expect(collapse).toBeDefined();
    const afterCollapseMs = (collapse!.t + 1) * 1_000 / TICKS_PER_SEC;
    // The second order occurs after a genuine earlier collapse, within the
    // ordinary deploy window. Destruction cannot create new legal drop tiles.
    expect(afterCollapseMs).toBeLessThan(RAID_RULES.deployWindowSec * 1_000);
    expect(() => simulateRaid(snapshot, orders([...army().deploys,
      deploy('highlander', 5, 9, afterCollapseMs)]), SEED)).toThrow(/deploy outside/);
  });
});
