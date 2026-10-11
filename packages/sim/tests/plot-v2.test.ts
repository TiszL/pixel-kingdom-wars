import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILD_COUNT_CAP_BY_KEEP, BuildingType, CAPS, isInsidePlot, MINING, PHASE_E_BUILDINGS, plotBounds, type BaseSnapshot } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { footprintOf } from '../src/stats';
import { UNITS_PER_TILE } from '../src/fixed';
import type { RaidOrders, RaidOutcome } from '../src/types';
import { b, base, deploy, fnv1a, orders, wallRing } from './helpers';
import { maximumPlot2Snapshot } from './plot-v2-capacity.fixture';

function signed(snapshot: BaseSnapshot): BaseSnapshot {
  return { ...snapshot, plotVersion: 2, battlefieldVersion: 2, claimMin: -10, claimMax: 40 };
}

function translated(snapshot: BaseSnapshot, command: RaidOrders, dx: number, dy: number) {
  return {
    snapshot: { ...snapshot,
      buildings: snapshot.buildings.map(building => ({ ...building, tx: building.tx + dx, ty: building.ty + dy })),
      ...(snapshot.defenderHeroes ? { defenderHeroes: snapshot.defenderHeroes.map(hero => ({ ...hero,
        guardTx: hero.guardTx + dx, guardTy: hero.guardTy + dy })) } : {}),
    },
    command: { ...command,
      deploys: command.deploys.map(drop => ({ ...drop, tx: drop.tx + dx, ty: drop.ty + dy })),
      ...(command.heroDeploys ? { heroDeploys: command.heroDeploys.map(drop => ({ ...drop,
        tx: drop.tx + dx, ty: drop.ty + dy })) } : {}),
    },
  };
}

function untranslated(result: RaidOutcome, dx: number, dy: number): RaidOutcome {
  return { ...result, events: result.events.map(event => {
    const copy = { ...event };
    if ('x' in copy) copy.x -= dx * UNITS_PER_TILE;
    if ('y' in copy) copy.y -= dy * UNITS_PER_TILE;
    if ('ix' in copy && copy.ix !== undefined) copy.ix -= dx * UNITS_PER_TILE;
    if ('iy' in copy && copy.iy !== undefined) copy.iy -= dy * UNITS_PER_TILE;
    if ('fromX' in copy && copy.fromX !== undefined) copy.fromX -= dx * UNITS_PER_TILE;
    if ('fromY' in copy && copy.fromY !== undefined) copy.fromY -= dy * UNITS_PER_TILE;
    if ('toX' in copy && copy.toX !== undefined) copy.toX -= dx * UNITS_PER_TILE;
    if ('toY' in copy && copy.toY !== undefined) copy.toY -= dy * UNITS_PER_TILE;
    return copy;
  }) };
}

const translations = [[-15, -15], [-15, 20], [20, -15], [20, 20]] as const;

describe('SIM15 independent 50×50 plot geometry', () => {
  it('capacity fixture occupies the full 50×50 frame at existing caps with no overlapping footprints', () => {
    const snapshot = maximumPlot2Snapshot();
    const occupied = new Set<string>();
    const ids = new Set<string>();
    const counts = new Map<BuildingType, number>();
    for (const building of snapshot.buildings) {
      const { fw, fh } = footprintOf(building.type, snapshot.geometryVersion);
      expect(isInsidePlot({ ...building, fw, fh }, snapshot.plotVersion)).toBe(true);
      expect(ids.has(building.id)).toBe(false);
      ids.add(building.id);
      counts.set(building.type, (counts.get(building.type) ?? 0) + 1);
      for (let dy = 0; dy < fh; dy++) for (let dx = 0; dx < fw; dx++) {
        const key = `${building.tx + dx},${building.ty + dy}`;
        expect(occupied.has(key), `overlap at ${key}`).toBe(false);
        occupied.add(key);
      }
    }
    // The five Phase E types carry a cap row but are DARK (D-152 §5 commit A):
    // no placement exists, so the signed goldens must not carry them. A count
    // here would mean the fixture — and the golden hash — moved before commit B.
    const dark: readonly string[] = PHASE_E_BUILDINGS.types;
    for (const [type, caps] of Object.entries(BUILD_COUNT_CAP_BY_KEEP)) {
      expect(counts.get(type as BuildingType)).toBe(dark.includes(type) ? undefined : caps.at(-1));
    }
    expect(counts.get(BuildingType.Mine)).toBe(MINING.MAX_MINES_BY_KEEP.at(-1));
    expect([BuildingType.SpikeTrap, BuildingType.PowderMine, BuildingType.Pitfall, BuildingType.AirMine]
      .reduce((sum, type) => sum + counts.get(type)!, 0)).toBe(CAPS.trapsByKeepLevel.at(-1));
    for (const tx of [-10, 39]) for (const ty of [-10, 39]) expect(occupied.has(`${tx},${ty}`)).toBe(true);
  });

  it('admits complete current-geometry footprints at all four plot corners', () => {
    const { min, max } = plotBounds(2);
    const { fw, fh } = footprintOf(BuildingType.Keep, 2);
    for (const tx of [min, max - fw]) for (const ty of [min, max - fh]) {
      const snapshot = { ...signed(base([b(BuildingType.Keep, tx, ty, 1, 'keep')])), geometryVersion: 2 };
      const result = simulateRaid(snapshot, orders([deploy('dragon', tx - 1, ty)]), 50);
      expect(result.buildings[0]!.hp).toBeLessThan(result.buildings[0]!.maxHp);
    }
  });

  it('rejects overflowing, fractional and unsupported plots without admitting a partial building', () => {
    for (const [tx, ty] of [[-11, 0], [0, -11], [39, 0], [0, 39], [0.5, 0], [0, NaN]]) {
      const snapshot = signed(base([b(BuildingType.Keep, tx!, ty!, 1, 'keep')]));
      expect(() => simulateRaid(snapshot, orders([]), 50)).toThrow(/out of plot bounds/);
    }
    const future = { ...signed(base([b(BuildingType.Keep, 14, 14, 1, 'keep')])), plotVersion: 3 };
    expect(() => simulateRaid(future as unknown as BaseSnapshot, orders([]), 50)).toThrow(/unsupported plot version/);
  });

  it('never infers expanded geometry from a battlefield or claim, and keeps missing/1 identical', () => {
    const expanded = signed(base([b(BuildingType.Keep, -5, -5, 1, 'keep')]));
    for (const plotVersion of [undefined, 1] as const) {
      expect(() => simulateRaid({ ...expanded, plotVersion }, orders([]), 50)).toThrow(/out of plot bounds/);
    }
    const old = { ...base([b(BuildingType.Keep, 14, 14, 1, 'keep')]), battlefieldVersion: 2 as const };
    const command = orders([deploy('dragon', -34, 15)]);
    expect(simulateRaid(old, command, 50)).toEqual(simulateRaid({ ...old, plotVersion: 1 }, command, 50));
  });

  it('keeps deployment footprints frozen for late troops at negative coordinates', () => {
    const snapshot = signed(base([
      b(BuildingType.Keep, -6, -6, 1, 'keep'),
      b(BuildingType.AirMine, -3, -3, 1, 'trap'),
      b(BuildingType.Wall, -8, -8, 1, 'wall'),
    ]));
    for (const [tx, ty] of [[-6, -6], [-5, -5], [-3, -3], [-8, -8]]) {
      expect(() => simulateRaid(snapshot, orders([
        deploy('dragon', -10, -6), deploy('dragon', tx!, ty!, 80_000),
      ]), 50)).toThrow(/deploy outside the deploy zone/);
    }
  });

  it('preserves wall detours through the same gap in every signed quadrant', () => {
    const snapshot = signed(base([
      b(BuildingType.Cannon, 11, 11, 1, 'cannon'),
      ...wallRing(6, 16, 2, 'wall').filter(wall => !(wall.tx === 6 && wall.ty === 9)),
    ], 3));
    const command = orders([deploy('giant', 0, 11)]);
    const reference = simulateRaid(snapshot, command, 7);
    expect(reference.buildings.find(building => building.id === 'cannon')!.destroyed).toBe(true);
    expect(reference.buildings.filter(building => building.type === BuildingType.Wall)
      .every(wall => wall.hp === wall.maxHp)).toBe(true);
    for (const [dx, dy] of translations) {
      const shifted = translated(snapshot, command, dx, dy);
      expect(untranslated(simulateRaid(shifted.snapshot, shifted.command, 7), dx, dy)).toEqual(reference);
    }
  });

  it.each(['kegrunner', 'tunneler'] as const)('preserves %s wall contact and effects across the signed origin', troop => {
    const snapshot = signed(base([
      b(BuildingType.Keep, 11, 11, 1, 'keep'), ...wallRing(6, 16, 2, 'wall'),
    ]));
    const command = orders([deploy(troop, 0, 11)]);
    const reference = simulateRaid(snapshot, command, 7);
    expect(reference.events.some(event => event.e === (troop === 'kegrunner' ? 'detonate' : 'burrow'))).toBe(true);
    for (const [dx, dy] of translations) {
      const shifted = translated(snapshot, command, dx, dy);
      expect(untranslated(simulateRaid(shifted.snapshot, shifted.command, 7), dx, dy)).toEqual(reference);
    }
  });

  it('admits signed defender guards while preserving their combat and bounded origins', () => {
    const snapshot = signed({ ...base([b(BuildingType.Keep, 11, 11, 1, 'keep')]),
      defenderHeroes: [{ hero: 'theodor', level: 20, guardTx: 8, guardTy: 11 }],
    });
    const command = orders([deploy('highlander', 7, 11)]);
    const reference = simulateRaid(snapshot, command, 50);
    expect(reference.events.some(event => event.e === 'deploy' && event.hero === 'theodor' && event.side === 'defender')).toBe(true);
    for (const [dx, dy] of translations) {
      const shifted = translated(snapshot, command, dx, dy);
      expect(untranslated(simulateRaid(shifted.snapshot, shifted.command, 50), dx, dy)).toEqual(reference);
    }
    for (const guardTx of [-11, 40]) {
      expect(() => simulateRaid({ ...snapshot, defenderHeroes: [{ ...snapshot.defenderHeroes![0]!, guardTx }] }, command, 50))
        .toThrow(/defender hero guard out of bounds/);
    }
  });

  it.each(['theodor', 'vex'] as const)('pins signed %s wall skills separately from historical goldens', hero => {
    const snapshot = signed(base([
      b(BuildingType.LaserTower, 14, 14, 3, 'laser'), ...wallRing(6, 22, 20, 'wall'),
    ], 3));
    const command: RaidOrders = { deploys: [], heroDeploys: [
      { hero, level: 20, tx: 0, ty: 14, tMs: 0 },
    ] };
    const shifted = translated(snapshot, command, -15, -15);
    const reference = simulateRaid(snapshot, command, 50);
    const result = simulateRaid(shifted.snapshot, shifted.command, 50);
    expect(untranslated(result, -15, -15)).toEqual(reference);
    if (hero === 'theodor') {
      const note = result.events.find(event => event.e === 'heroSkill' && event.skill === 'brownNote');
      expect(note).toBeDefined();
      expect(result.events.filter(event => event.e === 'destroyed' && event.t === note!.t)).toHaveLength(2);
    } else {
      expect(result.events.some(event => event.e === 'heroSkill' && event.skill === 'crimsonDash')).toBe(true);
    }
    const { events, ...outcome } = result;
    const golden = { simVersion: 15, plotVersion: 2, hash: fnv1a(JSON.stringify(events)), outcome, eventCount: events.length };
    const path = join(__dirname, `plot-v2-${hero}.golden.json`);
    if (process.env['UPDATE_PLOT2_GOLDEN'] === '1') writeFileSync(path, JSON.stringify(golden, null, 2) + '\n');
    expect(golden).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });
});
