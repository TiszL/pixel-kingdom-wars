/**
 * WHY: settlement (raids.ts submitOrders) persists the replay envelope inside the
 * money transaction. The optional buildingHealth projection is display data; a
 * malformed projection must be omitted and reported, never abort a real raid's
 * settlement (security review 2026-09-11, finding 2). Archive decoding stays strict.
 */
import { describe, expect, it } from 'vitest';
import { archivedBuildingHealth, replayBuildingHealth, safeReplayBuildingHealth } from '../src/game/raidReplayHealth';

const valid = { buildings: [{ id: 'a', maxHp: 120 }, { id: 'b', maxHp: 0 }] };

describe('safeReplayBuildingHealth', () => {
  it('preserves the authoritative health contract through SIM18, without guessing future versions', () => {
    // SIM16 targeting, SIM17 clearance and SIM18 passive type admission leave
    // building initialization untouched; later versions still require explicit verification.
    const health = [{ id: 'a', initialHp: 120, maxHp: 120 }, { id: 'b', initialHp: 0, maxHp: 0 }];
    for (const version of [15, 16, 17, 18]) {
      expect(replayBuildingHealth(version, valid)).toEqual(health);
      expect(archivedBuildingHealth({ simVersion: version, buildingHealth: health })).toEqual(health);
    }
    expect(replayBuildingHealth(19, valid)).toBeUndefined();
    expect(archivedBuildingHealth({ simVersion: 19, buildingHealth: health })).toBeUndefined();
  });
  it('projects a valid outcome exactly like the strict decoder', () => {
    const reasons: string[] = [];
    expect(safeReplayBuildingHealth(14, valid, (r) => reasons.push(r))).toEqual(replayBuildingHealth(14, valid));
    expect(reasons).toEqual([]);
  });

  it('omits and reports a non-integer maximum instead of throwing', () => {
    const reasons: string[] = [];
    expect(safeReplayBuildingHealth(14, { buildings: [{ id: 'a', maxHp: 12.5 }] }, (r) => reasons.push(r))).toBeUndefined();
    expect(reasons).toHaveLength(1);
    expect(() => replayBuildingHealth(14, { buildings: [{ id: 'a', maxHp: 12.5 }] })).toThrow();
  });

  it('omits and reports duplicate identities instead of throwing', () => {
    const reasons: string[] = [];
    expect(safeReplayBuildingHealth(14, { buildings: [{ id: 'a', maxHp: 1 }, { id: 'a', maxHp: 1 }] }, (r) => reasons.push(r))).toBeUndefined();
    expect(reasons[0]).toMatch(/Duplicate/);
  });

  it('keeps the archive decoder strict: absent stays unknown, malformed still throws', () => {
    expect(archivedBuildingHealth({ simVersion: 14 })).toBeUndefined();
    expect(() => archivedBuildingHealth({ simVersion: 14, buildingHealth: [{ id: 'a', initialHp: 1, maxHp: 1.5 }] })).toThrow();
  });
});
