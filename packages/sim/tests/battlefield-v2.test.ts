import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BuildingType, CAPS, GRID, type BaseSnapshot } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { b, base, deploy, fnv1a, orders, wallRing } from './helpers';

function snapshot(): BaseSnapshot {
  return { ...base([
    b(BuildingType.Keep, 14, 14, 20, 'keep'),
    b(BuildingType.AirMine, 18, 18, 20, 'airmine'),
    b(BuildingType.Cannon, 13, 12, 20, 'cannon'),
    ...wallRing(10, 20, 20, 'wall'),
  ], 20), battlefieldVersion: 2, claimMin: 2, claimMax: 28 };
}

describe('SIM15 version-2 battlefield', () => {
  it('admits each field edge/corner and the reported (15,-7) coordinate', () => {
    for (const [tx, ty] of [[-34,-34],[-34,63],[63,-34],[63,63],[15,-34],[15,63],[-34,15],[63,15],[15,-7]]) {
      const result = simulateRaid(snapshot(), orders([deploy('dragon', tx!, ty!)]), 15);
      expect(result.events.find(e => e.e === 'deploy')).toMatchObject({ x: tx! * 256 + 128, y: ty! * 256 + 128 });
      // All emitted moving coordinates stay inside the same enlarged field.
      for (const e of result.events) if ((e.e === 'pos' || e.e === 'deploy') && 'x' in e && 'y' in e) {
        expect(e.x).toBeGreaterThanOrEqual(-34 * 256);
        expect(e.y).toBeGreaterThanOrEqual(-34 * 256);
        expect(e.x).toBeLessThan(64 * 256);
        expect(e.y).toBeLessThan(64 * 256);
      }
    }
  });
  it('admits an empty interior for every unlocked claim size', () => {
    for (const size of CAPS.claimTilesByExpansion) {
      const claimMin = (GRID.plotTiles - size) / 2;
      const s = { ...snapshot(), claimMin, claimMax: claimMin + size };
      expect(() => simulateRaid(s, orders([deploy('highlander', 17, 17)]), 15)).not.toThrow();
    }
  });
  it('rejects building, wall and trap footprints even for late reserves', () => {
    for (const [tx, ty] of [[14,14],[15,15],[10,10],[18,18]]) {
      expect(() => simulateRaid(snapshot(), orders([
        deploy('dragon', 17, 17), deploy('dragon', tx!, ty!, 80_000),
      ]), 15)).toThrow(/deploy outside the deploy zone/);
    }
    for (const [tx, ty] of [[-35,0],[64,0],[0,-35],[0,64]]) {
      expect(() => simulateRaid(snapshot(), orders([deploy('dragon', tx!, ty!)]), 15)).toThrow(/deploy outside/);
    }
  });
  it('blocks omitted construction and spent traps without admitting them into combat', () => {
    const original = snapshot();
    const frozen = { ...original, deploymentBlockers: [{ tx: 17, ty: 17, fw: 2, fh: 1 }] };
    expect(() => simulateRaid(frozen, orders([deploy('dragon', 18, 17)]), 15)).toThrow(/deploy outside/);
    const legalOrders = orders([deploy('dragon', 5, 5)]);
    expect(simulateRaid(frozen, legalOrders, 15)).toEqual(simulateRaid(original, legalOrders, 15));
    expect(frozen.buildings).toBe(original.buildings);
  });
  it('keeps legacy field/interior rejection and movement byte-identical', () => {
    const legacy = { ...snapshot(), battlefieldVersion: 1 as const };
    const missing = { ...legacy }; delete missing.battlefieldVersion;
    const command = orders([deploy('dragon', 0, 15)]);
    expect(simulateRaid(legacy, command, 15)).toEqual(simulateRaid(missing, command, 15));
    for (const s of [legacy, missing]) {
      expect(() => simulateRaid(s, orders([deploy('dragon', 17, 17)]), 15)).toThrow(/deploy outside/);
      expect(() => simulateRaid(s, orders([deploy('dragon', 15, -7)]), 15)).toThrow(/deploy outside/);
    }
  });
  it('pins the new event stream separately from every historical golden', () => {
    const result = simulateRaid(snapshot(), orders([
      deploy('dragon', -34, 15), deploy('highlander', 17, 17, 100),
      deploy('kegrunner', 22, 15, 300), deploy('dragon', 63, 15, 500),
    ], { heroDeploys: [{ hero: 'vex', level: 20, tx: 15, ty: -7, tMs: 0 }] }), 0x51515);
    const { events, ...outcome } = result;
    const golden = { simVersion: 15, hash: fnv1a(JSON.stringify(events)),
      outcome, ticks: result.ticks, eventCount: events.length };
    const path = join(__dirname, 'battlefield-v2.golden.json');
    if (process.env['UPDATE_SIM15_GOLDEN'] === '1') writeFileSync(path, JSON.stringify(golden, null, 2) + '\n');
    expect(golden).toEqual(JSON.parse(readFileSync(path, 'utf8')));
  });
});
