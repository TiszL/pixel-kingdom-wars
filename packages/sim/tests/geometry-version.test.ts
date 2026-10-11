import { describe, expect, it } from 'vitest';
import { BuildingType, type BaseSnapshot } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { footprintOf } from '../src/stats';

const archived: BaseSnapshot = {
  keepLevel: 1,
  surplusShards: 0,
  buildings: [{ id: 'keep', type: BuildingType.Keep, level: 1, tx: 27, ty: 27 }],
};

describe('versioned KEEP geometry', () => {
  it('keeps missing and explicit v1 snapshots exactly on the archived 2x2 path', () => {
    expect(footprintOf(BuildingType.Keep)).toEqual({ fw: 2, fh: 2 });
    expect(footprintOf(BuildingType.Keep, 1)).toEqual({ fw: 2, fh: 2 });
    expect(simulateRaid(archived, { deploys: [] }, 42))
      .toEqual(simulateRaid({ ...archived, geometryVersion: 1 }, { deploys: [] }, 42));
  });

  it('uses 4x4 only for an explicitly stamped v2 snapshot', () => {
    expect(footprintOf(BuildingType.Keep, 2)).toEqual({ fw: 4, fh: 4 });
    // 27,27 is legal for the archived 2x2 KEEP but cannot fit a 4x4 body. This
    // proves the version reaches authoritative collision/bounds geometry.
    expect(() => simulateRaid({ ...archived, geometryVersion: 2 }, { deploys: [] }, 42))
      .toThrow(/building keep out of plot bounds/);
  });

  it('fails closed on an unknown persisted geometry version', () => {
    expect(() => footprintOf(BuildingType.Keep, 3)).toThrow(/unsupported building geometry version/);
  });
});
