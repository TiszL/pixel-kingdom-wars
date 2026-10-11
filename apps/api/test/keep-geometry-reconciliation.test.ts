import { describe, expect, it } from 'vitest';
import { BUILDING_GEOMETRY, BuildingType } from '@shardkeep/shared';
import {
  planKeepGeometryReconciliation,
  type KeepGeometryReconciliationInput,
} from '../src/game/keepGeometryReconciliation';

const claim = { minTx: 8, minTy: 8, maxTx: 22, maxTy: 22 } as const;

function fixture(overrides: Partial<KeepGeometryReconciliationInput> = {}): KeepGeometryReconciliationInput {
  return {
    geometryVersion: BUILDING_GEOMETRY.legacyVersion,
    claim,
    buildings: [
      {
        id: 'keep', type: BuildingType.Keep, level: 7, tx: 14, ty: 14,
        jobs: [{ id: 'upgrade-keep', finishesAt: '2026-08-27T00:00:00Z' }],
        metadata: { owner: 'player', nested: { z: 2, a: 1 } },
      },
      { id: 'cannon', type: BuildingType.Cannon, level: 3, tx: 13, ty: 13 },
      { id: 'mine', type: BuildingType.Mine, level: 4, tx: 20, ty: 20 },
    ],
    obstacles: [
      { id: 'tree', spriteKey: 'pine1', tx: 16, ty: 16, metadata: { seed: 9 } },
      { id: 'outer', spriteKey: 'boulder', tx: 24, ty: 24 },
    ],
    ...overrides,
  };
}

describe('KEEP geometry reconciliation planner', () => {
  it('audits by default without moving blockers or mutating its input', () => {
    const input = fixture();
    const before = JSON.stringify(input);
    const report = planKeepGeometryReconciliation(input);

    expect(report.mode).toBe('audit');
    expect(report.active.keep).toEqual({
      id: 'keep',
      old: { tx: 14, ty: 14, fw: 2, fh: 2 },
      proposed: { tx: 13, ty: 13, fw: 4, fh: 4 },
    });
    expect(report.active.conflicts).toEqual([
      {
        kind: 'building', id: 'cannon',
        rect: { tx: 13, ty: 13, fw: 1, fh: 1 },
        overlap: { tx: 13, ty: 13, fw: 1, fh: 1 },
      },
      {
        kind: 'obstacle', id: 'tree',
        rect: { tx: 16, ty: 16, fw: 1, fh: 1 },
        overlap: { tx: 16, ty: 16, fw: 1, fh: 1 },
      },
    ]);
    expect(report.active.relocations).toEqual([]);
    expect(report.active.collisionFree).toBe(false);
    expect(report.readyToApply).toBe(false);
    expect(report.active.buildings.find((building) => building.id === 'cannon'))
      .toMatchObject({ tx: 13, ty: 13 });
    expect(JSON.stringify(input)).toBe(before);
  });

  it('preserves identity, levels, job metadata and canonicalizes hashable output', () => {
    const first = planKeepGeometryReconciliation(fixture());
    const second = planKeepGeometryReconciliation(fixture({
      buildings: [...fixture().buildings].reverse(),
      obstacles: [...fixture().obstacles].reverse(),
    }));
    const keep = first.active.buildings.find((building) => building.id === 'keep');

    expect(keep).toMatchObject({
      id: 'keep', type: BuildingType.Keep, level: 7,
      jobs: [{ id: 'upgrade-keep', finishesAt: '2026-08-27T00:00:00Z' }],
      metadata: { nested: { a: 1, z: 2 }, owner: 'player' },
    });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.active.buildings)).toBe(true);
    expect(Object.isFrozen(keep!.metadata!.nested)).toBe(true);
  });

  it('relocates only on explicit request with distance/y/x tie-breaking', () => {
    const report = planKeepGeometryReconciliation(fixture({ mode: 'relocate-conflicts' }));

    expect(report.active.relocations).toEqual([
      { kind: 'building', id: 'cannon', from: { tx: 13, ty: 13 }, to: { tx: 13, ty: 12 } },
      { kind: 'obstacle', id: 'tree', from: { tx: 16, ty: 16 }, to: { tx: 17, ty: 16 } },
    ]);
    expect(report.active.collisionFree).toBe(true);
    expect(report.readyToApply).toBe(true);
    expect(report.active.buildings.map((building) => building.id)).toEqual(['cannon', 'keep', 'mine']);
    expect(report.active.obstacles.map((obstacle) => obstacle.id)).toEqual(['outer', 'tree']);
  });

  it('plans saved layouts independently and rejects divergent inventories', () => {
    const saved = {
      slot: 'B',
      positions: [
        { buildingId: 'mine', tx: 19, ty: 19 },
        { buildingId: 'keep', tx: 12, ty: 12 },
        { buildingId: 'cannon', tx: 10, ty: 10 },
      ],
    } as const;
    const report = planKeepGeometryReconciliation(fixture({ savedLayouts: [saved] }));

    expect(report.savedLayouts).toHaveLength(1);
    expect(report.savedLayouts[0]!.keep.proposed).toEqual({ tx: 11, ty: 11, fw: 4, fh: 4 });
    expect(report.savedLayouts[0]!.buildings.find((building) => building.id === 'mine'))
      .toMatchObject({ level: 4, tx: 19, ty: 19 });

    expect(() => planKeepGeometryReconciliation(fixture({
      savedLayouts: [{ slot: 'B', positions: saved.positions.slice(0, 2) }],
    }))).toThrow(/saved-layout B is missing buildings: cannon/);
    expect(() => planKeepGeometryReconciliation(fixture({
      savedLayouts: [{
        slot: 'B',
        positions: [...saved.positions, { buildingId: 'foreign', tx: 8, ty: 8 }],
      }],
    }))).toThrow(/saved-layout B diverges at building foreign/);
  });

  it('fails closed on missing/multiple KEEP, unknown versions and out-of-claim buildings', () => {
    const all = fixture().buildings;
    expect(() => planKeepGeometryReconciliation(fixture({
      buildings: all.filter((building) => building.type !== BuildingType.Keep),
    }))).toThrow(/expected exactly one KEEP, found 0/);
    expect(() => planKeepGeometryReconciliation(fixture({
      buildings: [...all, { id: 'keep-2', type: BuildingType.Keep, level: 1, tx: 8, ty: 8 }],
    }))).toThrow(/expected exactly one KEEP, found 2/);
    expect(() => planKeepGeometryReconciliation(fixture({ geometryVersion: 99 })))
      .toThrow(/unsupported building geometry version: 99/);
    expect(() => planKeepGeometryReconciliation(fixture({
      buildings: all.map((building) => building.id === 'mine' ? { ...building, tx: 22 } : building),
    }))).toThrow(/building mine is outside claim bounds/);
  });

  it('fails instead of deleting a blocker when no relocation slot exists', () => {
    expect(() => planKeepGeometryReconciliation({
      geometryVersion: BUILDING_GEOMETRY.legacyVersion,
      claim: { minTx: 0, minTy: 0, maxTx: 4, maxTy: 4 },
      mode: 'relocate-conflicts',
      buildings: [
        { id: 'keep', type: BuildingType.Keep, level: 1, tx: 1, ty: 1 },
        { id: 'wall', type: BuildingType.Wall, level: 1, tx: 0, ty: 0 },
      ],
      obstacles: [],
    })).toThrow(/no legal relocation slot for building wall/);
  });

  it('is a no-op for an already-v2 collision-free layout', () => {
    const report = planKeepGeometryReconciliation(fixture({
      geometryVersion: BUILDING_GEOMETRY.candidateVersion,
      buildings: [
        { id: 'keep', type: BuildingType.Keep, level: 7, tx: 13, ty: 13 },
        { id: 'mine', type: BuildingType.Mine, level: 4, tx: 20, ty: 20 },
      ],
      obstacles: [{ id: 'outer', spriteKey: 'boulder', tx: 24, ty: 24 }],
    }));

    expect(report.active.keep.old).toEqual(report.active.keep.proposed);
    expect(report.active.conflicts).toEqual([]);
    expect(report.active.relocations).toEqual([]);
    expect(report.readyToApply).toBe(true);
  });
});
