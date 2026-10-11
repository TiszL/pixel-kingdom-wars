import { describe, expect, it } from 'vitest';
import { BuildingType } from '@shardkeep/shared';
import { simulateRaid } from '../src/sim';
import { b, base, deploy, orders } from './helpers';

const snap = () =>
  base([
    b(BuildingType.Keep, 8, 8, 2, 'keep'),
    b(BuildingType.Cannon, 5, 8, 1, 'cannon1'),
    b(BuildingType.Cannon, 11, 8, 1, 'cannon2'),
    b(BuildingType.Vault, 8, 11, 1, 'vault'),
  ]);

const army = () =>
  orders([
    deploy('highlander', 0, 8, 0),
    deploy('highlander', 0, 9, 200),
    deploy('bowman', 17, 8, 500),
    deploy('turrider', 8, 0, 1000),
  ]);

describe('determinism', () => {
  it('identical inputs produce bit-identical outcomes and event logs', () => {
    const a = simulateRaid(snap(), army(), 12345);
    const bRun = simulateRaid(snap(), army(), 12345);
    expect(bRun).toEqual(a);
    expect(JSON.stringify(bRun.events)).toBe(JSON.stringify(a.events));
  });

  it('different seeds produce different event logs (defense damage jitter)', () => {
    const a = simulateRaid(snap(), army(), 1);
    const c = simulateRaid(snap(), army(), 999);
    expect(JSON.stringify(a.events)).not.toBe(JSON.stringify(c.events));
  });

  it('deploy count matches orders and all event coordinates stay in the plot', () => {
    const o = army();
    const r = simulateRaid(snap(), o, 7);
    const deploys = r.events.filter((e) => e.e === 'deploy');
    expect(deploys).toHaveLength(o.deploys.length);
    const MAX = 18 * 256;
    for (const e of r.events) {
      if ('x' in e) {
        expect(e.x).toBeGreaterThanOrEqual(0);
        expect(e.x).toBeLessThanOrEqual(MAX);
        expect(e.y).toBeGreaterThanOrEqual(0);
        expect(e.y).toBeLessThanOrEqual(MAX);
      }
    }
  });
});
