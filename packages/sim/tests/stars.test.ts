import { describe, expect, it } from 'vitest';
import { BuildingType } from '@shardkeep/shared';
import { computeStars, simulateRaid } from '../src/sim';
import { b, base, deploy, orders } from './helpers';

describe('computeStars (GDD §3.3: ★ ≥50%, ★★ Keep, ★★★ 100%)', () => {
  it.each([
    [0, false, 0],
    [49, false, 0],
    [50, false, 1],
    [99, false, 1],
    [49, true, 1], // keep-only kill
    [50, true, 2],
    [99, true, 2],
    [100, true, 3],
  ] as const)('pct=%i keep=%s -> %i stars', (pct, keep, want) => {
    expect(computeStars(pct, keep)).toBe(want);
  });

  it('100% destruction implies the keep fell, so 100 always means 3 stars in practice', () => {
    // (computeStars(100,false) would be 2, but the sim can only reach 100 with the keep destroyed.)
    expect(computeStars(100, true)).toBe(3);
  });
});

describe('integration star outcomes', () => {
  it('overwhelming army = 100%, 3 stars, victory', () => {
    const snap = base([
      b(BuildingType.Keep, 8, 8, 1, 'keep'),
      b(BuildingType.Mine, 11, 8, 1, 'mine'),
    ]);
    const r = simulateRaid(
      snap,
      orders([
        deploy('turrider', 0, 8, 0),
        deploy('turrider', 17, 8, 0),
        deploy('highlander', 8, 0, 0),
        deploy('highlander', 8, 17, 0),
      ]),
      5,
    );
    expect(r.destructionPct).toBe(100);
    expect(r.keepDestroyed).toBe(true);
    expect(r.stars).toBe(3);
    expect(r.victory).toBe(true);
    expect(r.mineDestroyed).toBe(true);
  });

  it('hopeless attack = 0 stars, defeat', () => {
    const snap = base([
      b(BuildingType.Keep, 8, 8, 3, 'keep'),
      b(BuildingType.Cannon, 6, 8, 3, 'c1'),
      b(BuildingType.Cannon, 10, 8, 3, 'c2'),
      b(BuildingType.ArcherTower, 8, 6, 3, 'a1'),
      b(BuildingType.ArcherTower, 8, 11, 3, 'a2'),
    ]);
    const r = simulateRaid(snap, orders([deploy('plunderer', 0, 8)]), 5);
    expect(r.stars).toBe(0);
    expect(r.victory).toBe(false);
    expect(r.keepDestroyed).toBe(false);
  });
});
