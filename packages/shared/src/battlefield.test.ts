import { describe, expect, it } from 'vitest';
import parity from './battlefield.parity.json';
import { CAPS, GRID, RAID_BATTLEFIELD, RAID_RULES } from './constants';
import { battlefieldBounds, isBattlefieldTileDeployable, occupiedBattlefieldTiles, resolveBattlefieldVersion } from './battlefield';

describe('versioned battlefield contract', () => {
  const occupied = occupiedBattlefieldTiles([
    { tx: 14, ty: 14, fw: 2, fh: 2 },
    { tx: 13, ty: 14, fw: 1, fh: 1 },
    { tx: 18, ty: 18, fw: 1, fh: 1 },
  ]);
  it('publishes the exact policy and fixture decisions consumed by native', () => {
    expect(parity.policy).toEqual(RAID_BATTLEFIELD);
    const blocked = occupiedBattlefieldTiles(parity.occupiedRects);
    for (const c of parity.cases) {
      expect(isBattlefieldTileDeployable(c.tx, c.ty, c.context, blocked), c.name).toBe(c.legal);
    }
  });
  it('keeps every legacy tile decision for every shipped claim size', () => {
    for (const size of CAPS.claimTilesByExpansion) {
      const claimMin = (GRID.plotTiles - size) / 2;
      const claimMax = claimMin + size;
      const expected: boolean[] = []; const omitted: boolean[] = []; const explicit: boolean[] = [];
      for (let ty = -35; ty <= 64; ty++) for (let tx = -35; tx <= 64; tx++) {
        const old = tx >= -RAID_RULES.deployMarginTiles && ty >= -RAID_RULES.deployMarginTiles
          && tx < GRID.plotTiles + RAID_RULES.deployMarginTiles && ty < GRID.plotTiles + RAID_RULES.deployMarginTiles
          && !(tx > claimMin && tx < claimMax - 1 && ty > claimMin && ty < claimMax - 1)
          && !occupied.has(`${tx},${ty}`);
        expected.push(old);
        omitted.push(isBattlefieldTileDeployable(tx, ty, { claimMin, claimMax }, occupied));
        explicit.push(isBattlefieldTileDeployable(tx, ty, { battlefieldVersion: 1, claimMin, claimMax }, occupied));
      }
      // Compare the complete grids together: thirteen claim sizes retain every
      // tile assertion without hundreds of thousands of assertion wrappers.
      expect(omitted, `missing version, claim ${size}`).toEqual(expected);
      expect(explicit, `version 1, claim ${size}`).toEqual(expected);
    }
  });
  it('opens every empty realm tile including every claim interior, not just the 30×30 plot', () => {
    expect(battlefieldBounds(2)).toEqual({ min: -34, max: 64 });
    for (const size of CAPS.claimTilesByExpansion) {
      const claimMin = (GRID.plotTiles - size) / 2;
      for (let ty = -35; ty <= 64; ty++) for (let tx = -35; tx <= 64; tx++) {
        expect(isBattlefieldTileDeployable(tx, ty, {
          battlefieldVersion: 2, claimMin, claimMax: claimMin + size,
        }, occupied)).toBe(tx >= -34 && tx < 64 && ty >= -34 && ty < 64 && !occupied.has(`${tx},${ty}`));
      }
    }
  });
  it('does not infer an unknown version from the installed client', () => {
    expect(resolveBattlefieldVersion(undefined)).toBe(RAID_BATTLEFIELD.legacyVersion);
    for (const value of [0, 4, NaN, Infinity]) {
      expect(() => battlefieldBounds(value)).toThrow(/unsupported battlefield/);
      expect(() => isBattlefieldTileDeployable(0, 0, { battlefieldVersion: value }, occupied)).toThrow();
    }
    for (const value of [0.5, NaN, Infinity]) {
      expect(isBattlefieldTileDeployable(value, 0, { battlefieldVersion: 2 }, occupied)).toBe(false);
    }
  });
  it('freezes occupied footprints independently of later destruction or trap activation', () => {
    const buildings = [{ tx: 12, ty: 12, fw: 2, fh: 2, destroyed: false }];
    const frozen = occupiedBattlefieldTiles(buildings);
    buildings[0]!.destroyed = true;
    buildings.length = 0;
    expect([...frozen].sort()).toEqual(['12,12', '12,13', '13,12', '13,13']);
    expect(isBattlefieldTileDeployable(12, 12, { battlefieldVersion: 2 }, frozen)).toBe(false);
  });
});


describe('D-146 version-3 deployment clearance', () => {
  const ring = [{ tx: 4, ty: 4, fw: 4, fh: 1 }, { tx: 4, ty: 7, fw: 4, fh: 1 },
    { tx: 4, ty: 5, fw: 1, fh: 2 }, { tx: 7, ty: 5, fw: 1, fh: 2 }];
  it('preserves each version-2 tile even when no clear square contains it', () => {
    const blockers = [{ tx: 4, ty: 4, fw: 4, fh: 1 }, { tx: 4, ty: 6, fw: 4, fh: 1 }];
    const occupied = occupiedBattlefieldTiles([{ tx: 5, ty: 5, fw: 1, fh: 1 }]);
    const decisions = (version: 2 | 3) => isBattlefieldTileDeployable(6, 5, { battlefieldVersion: version, deploymentBlockers: blockers }, occupied);
    expect(decisions(2)).toBe(true); expect(decisions(3)).toBe(false);
  });
  it('allows every corner of an enclosed two-by-two square without demanding external reachability', () => {
    const occupied = occupiedBattlefieldTiles(ring);
    for (const [tx, ty] of [[5,5],[6,5],[5,6],[6,6]]) {
      expect(isBattlefieldTileDeployable(tx!, ty!, { battlefieldVersion: 3 }, occupied)).toBe(true);
    }
    // The fourth tile matters even when it is only diagonally adjacent to the tap.
    occupied.add('6,6');
    for (const [tx, ty] of [[5,5],[6,5],[5,6],[6,6]]) {
      expect(isBattlefieldTileDeployable(tx!, ty!, { battlefieldVersion: 3 }, occupied)).toBe(false);
    }
  });
  it('matches an independently enumerated union of empty squares across the entire battlefield', () => {
    const bounds = battlefieldBounds(3);
    const buildings = [...ring, { tx: -34, ty: -34, fw: 2, fh: 2 }, { tx: 62, ty: 61, fw: 2, fh: 3 }];
    const blockers = [{ tx: 11, ty: -15, fw: 1, fh: 30 }, { tx: 13, ty: -15, fw: 1, fh: 30 }];
    const occupied = occupiedBattlefieldTiles(buildings);
    const allBlocked = occupiedBattlefieldTiles([...buildings, ...blockers]);
    const expected = new Set<string>();
    // Explicit four-cell oracle deliberately does not share the candidate loops.
    for (let y = bounds.min; y < bounds.max - 1; y++) for (let x = bounds.min; x < bounds.max - 1; x++) {
      const square = [`${x},${y}`, `${x + 1},${y}`, `${x},${y + 1}`, `${x + 1},${y + 1}`];
      if (square.every((cell) => !allBlocked.has(cell))) square.forEach((cell) => expected.add(cell));
    }
    const actual: string[] = [];
    for (let y = bounds.min - 1; y <= bounds.max; y++) for (let x = bounds.min - 1; x <= bounds.max; x++) {
      if (isBattlefieldTileDeployable(x, y, { battlefieldVersion: 3, deploymentBlockers: blockers }, occupied)) actual.push(`${x},${y}`);
    }
    expect(actual.sort()).toEqual([...expected].sort());
  });
});
