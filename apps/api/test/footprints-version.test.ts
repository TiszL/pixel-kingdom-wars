import { describe, expect, it } from 'vitest';
import { BuildingType, type BaseSnapshot } from '@shardkeep/shared';
import { footprintOf } from '../src/game/footprints';
import { validateDropPoint } from '../src/game/liveRaids';

const snapshot = (geometryVersion?: 1 | 2): BaseSnapshot => ({
  ...(geometryVersion === undefined ? {} : { geometryVersion }),
  keepLevel: 1,
  surplusShards: 0,
  claimMin: 8,
  claimMax: 22,
  buildings: [{ id: 'keep', type: BuildingType.Keep, level: 1, tx: 0, ty: 0 }],
});

describe('raid snapshot building geometry compatibility', () => {
  it('keeps live placement/default and archived raid geometry at 2x2', () => {
    expect(footprintOf(BuildingType.Keep)).toEqual({ fw: 2, fh: 2 });
    expect(footprintOf(BuildingType.Keep, 1)).toEqual({ fw: 2, fh: 2 });
    expect(() => validateDropPoint(snapshot(), 3, 3)).not.toThrow();
    expect(() => validateDropPoint(snapshot(1), 3, 3)).not.toThrow();
  });

  it('uses an explicitly stamped v2 4x4 KEEP in live deploy validation', () => {
    expect(footprintOf(BuildingType.Keep, 2)).toEqual({ fw: 4, fh: 4 });
    expect(() => validateDropPoint(snapshot(2), 3, 3))
      .toThrow(/deploy outside the deploy zone/);
  });

  it('refuses unknown persisted geometry versions', () => {
    expect(() => validateDropPoint({ ...snapshot(), geometryVersion: 3 as never }, 3, 3))
      .toThrow(/unsupported building geometry version/);
  });
});
