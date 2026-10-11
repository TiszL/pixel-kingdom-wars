import { describe, expect, it } from 'vitest';
import { BuildingType, type BaseSnapshot } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { b, base, deploy, orders, wallRing } from './helpers';

const pocket = (): BaseSnapshot => ({ ...base([
  b(BuildingType.Keep, 14, 14, 1, 'keep'), ...wallRing(4, 7, 1, 'pocket'),
]), battlefieldVersion: 3 });
const commands = (kind: 'troop' | 'hero', tx: number, ty: number) => kind === 'troop'
  ? orders([deploy('highlander', tx, ty)]) : orders([], { heroDeploys: [{ hero: 'vex', tx, ty, tMs: 0 }] });

describe('SIM17 version-3 frozen deployment clearance', () => {
  it.each(['troop', 'hero'] as const)('admits every corner of a fully empty enclosed square for a %s', (kind) => {
    for (const [tx, ty] of [[5,5],[6,5],[5,6],[6,6]]) {
      const result = simulateRaid(pocket(), commands(kind, tx!, ty!), 17, { stopAfterTick: 0 });
      expect(result.events.filter((e) => e.e === 'deploy')).toHaveLength(1);
      expect(result.events.find((e) => e.e === 'deploy')).toMatchObject({ x: tx! * 256 + 128, y: ty! * 256 + 128 });
    }
  });
  it.each(['troop', 'hero'] as const)('rejects a hole, corridor, missing square cell and frozen blocker for a %s', (kind) => {
    const hole = { ...pocket(), buildings: [b(BuildingType.Keep, 14, 14, 1, 'keep'), ...wallRing(4, 6, 1, 'hole')] };
    const corridor = { ...pocket(), deploymentBlockers: [{ tx: 6, ty: 5, fw: 1, fh: 2 }] };
    const corner = { ...pocket(), deploymentBlockers: [{ tx: 6, ty: 6, fw: 1, fh: 1 }] };
    for (const snapshot of [hole, corridor, corner]) {
      expect(() => simulateRaid(snapshot, commands(kind, 5, 5), 17, { stopAfterTick: 0 })).toThrow(/deploy outside/);
      // This was legal in version2: changing the current constant must never
      // reinterpret a historical single-cell order under the new clearance.
      expect(() => simulateRaid({ ...snapshot, battlefieldVersion: 2 }, commands(kind, 5, 5), 17, { stopAfterTick: 0 })).not.toThrow();
    }
    for (const [tx, ty] of [[4,4],[14,14],[-35,0],[64,0]]) {
      expect(() => simulateRaid(pocket(), commands(kind, tx!, ty!), 17, { stopAfterTick: 0 })).toThrow(/deploy outside/);
    }
  });
  it('keeps scenery decorative and never reserves deployment squares for earlier units', () => {
    const snapshot = { ...pocket(), obstacles: [{ spriteKey: 'boulder', tx: 5, ty: 5 }] };
    const input = orders([deploy('highlander', 5, 5), deploy('highlander', 5, 5)], { heroDeploys: [{ hero: 'vex', tx: 5, ty: 5, tMs: 0 }] });
    expect(simulateRaid(snapshot, input, 17, { stopAfterTick: 0 }).events.filter((e) => e.e === 'deploy')).toHaveLength(3);
  });
  it('keeps full outcomes byte-identical to version2 for commands legal under both policies', () => {
    const snapshot = pocket(); const input = orders([deploy('dragon', -34, -34), deploy('highlander', 5, 5)]);
    expect(simulateRaid(snapshot, input, 0x51717)).toEqual(simulateRaid({ ...snapshot, battlefieldVersion: 2 }, input, 0x51717));
  });
});
