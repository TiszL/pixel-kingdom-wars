import { describe, expect, it } from 'vitest';
import { BuildingType, KEEP_BATTERIES } from '@shardkeep/shared';
import { defenseCombat, footprintOf, trapCombat } from '../src/stats';
import { simulateRaid } from '../src/sim';
import { b, base, deploy, orders } from './helpers';

describe('M22 defensive buildings', () => {
  it('Air Defence is 2×2, ignores ground and fires only on flying attackers', () => {
    expect(footprintOf(BuildingType.AirDefence)).toEqual({ fw: 2, fh: 2 });
    const snapshot = base([
      b(BuildingType.Keep, 12, 12, 10, 'keep'),
      b(BuildingType.AirDefence, 8, 8, 10, 'air'),
    ], 10);
    const ground = simulateRaid(snapshot, orders([deploy('highlander', 8, 0)]), 41);
    const flying = simulateRaid(snapshot, orders([deploy('dragon', 8, 0)]), 41);
    expect(ground.events.some((e) => e.e === 'fire' && e.id === 'air')).toBe(false);
    expect(flying.events.some((e) => e.e === 'fire' && e.id === 'air')).toBe(true);
  });

  it('Air Defence targets AIR first and only — a closer ground troop never steals a shot (D-060)', () => {
    // Owner 2026-08-16: dragons are "air defence's preferred target if it can
    // see it in range". Today that preference is enforced STRUCTURALLY:
    // targetsGround false means its only legal target class is air, so with a
    // dragon and a nearer ground troop both inside range every single shot goes
    // to the dragon. If Air Defence ever gains a ground weapon, this pin forces
    // the air-first selection question to be answered deliberately.
    const snapshot = base([
      b(BuildingType.Keep, 12, 12, 10, 'keep'),
      b(BuildingType.AirDefence, 8, 8, 10, 'air'),
    ], 10);
    const r = simulateRaid(snapshot, orders([
      deploy('highlander', 8, 2), // walks in and melees the battery point-blank
      deploy('dragon', 8, 0),     // the mandated target, hovering farther out
    ]), 41);
    const dragonId = (r.events.find((e) => e.e === 'deploy' && e.troop === 'dragon') as { id: number }).id;
    const fires = r.events.filter((e) => e.e === 'fire' && e.id === 'air');
    expect(fires.length).toBeGreaterThan(0);
    expect(fires.every((e) => (e as { target: number }).target === dragonId)).toBe(true);
  });

  it('Keep unlocks mortar-profile high range at L15 and cannon-profile low range at L17', () => {
    expect(defenseCombat(BuildingType.Keep, 14)).toBeNull();
    const high = defenseCombat(BuildingType.Keep, 15)!;
    const both = defenseCombat(BuildingType.Keep, 17)!;
    expect(high).toMatchObject({ proj: 'shell', targetsAir: false, targetsGround: true });
    expect(high.lowRange).toBeUndefined();
    expect(both.lowRange).toMatchObject({ proj: 'cannonball', targetsAir: false, targetsGround: true });
    expect(both.lowRange!.rangeUnits).toBeLessThan(both.rangeUnits);
    // D-060 doubled the CANNON BUILDING's range; the Keep's point battery keeps
    // its own pinned dead-zone reach and must not silently inherit that buff.
    expect(both.lowRange!.rangeUnits).toBe(KEEP_BATTERIES.lowRangeTiles * 256);

    const snapshot = { ...base([b(BuildingType.Keep, 14, 14, 17, 'keep')], 17),
      claimMin: 2, claimMax: 16 };
    const near = simulateRaid(snapshot, orders([deploy('giant', 17, 14)]), 45);
    const far = simulateRaid(snapshot, orders([deploy('giant', 14, 2)]), 45);
    expect(near.events.find((e) => e.e === 'fire' && e.id === 'keep')).toMatchObject({ proj: 'cannonball' });
    expect(far.events.find((e) => e.e === 'fire' && e.id === 'keep')).toMatchObject({ proj: 'shell' });
    expect([...near.events, ...far.events].some((e) => e.e === 'fire' && e.id === 'keep'
      && e.target >= 0)).toBe(true);
  });

  it('Clan Hall is a destructible 2×2 structure and traps are never defense targets', () => {
    expect(footprintOf(BuildingType.ClanHall)).toEqual({ fw: 2, fh: 2 });
    const result = simulateRaid(base([
      b(BuildingType.ClanHall, 8, 8, 1, 'hall'),
      b(BuildingType.Keep, 14, 14, 15, 'keep'),
      b(BuildingType.SpikeTrap, 3, 8, 1, 'spike'),
      b(BuildingType.PowderMine, 4, 8, 1, 'powder'),
      b(BuildingType.Pitfall, 5, 8, 1, 'pit'),
      b(BuildingType.AirMine, 6, 8, 1, 'airmine'),
    ], 15), orders([deploy('turrider', 0, 8)]), 42);
    const attackedBuildings = result.events
      .filter((e) => e.e === 'attackRun' && e.targetKind === 'building')
      .map((e) => e.target);
    expect(attackedBuildings.some((id) => ['spike', 'powder', 'pit', 'airmine'].includes(String(id)))).toBe(false);
    expect(result.buildings.find((entry) => entry.id === 'hall')!.maxHp).toBeGreaterThan(0);
  });
});

describe('M22 deterministic trap families', () => {
  it('maps every trap level into four monotonic combat tiers', () => {
    for (const type of ['spiketrap', 'powdermine', 'pitfall', 'airmine'] as const) {
      const damage = [1, 6, 11, 16].map((level) => trapCombat(type, level).damageDeci);
      expect(damage[0]).toBeLessThan(damage[1]!);
      expect(damage[1]).toBeLessThan(damage[2]!);
      expect(damage[2]).toBeLessThan(damage[3]!);
      expect(trapCombat(type, 20)).toEqual(trapCombat(type, 16));
    }
  });

  it('spends a ground Pitfall once, damages and applies a bounded stun, without scoring it', () => {
    const result = simulateRaid(base([
      b(BuildingType.Keep, 12, 8, 1, 'keep'),
      b(BuildingType.Pitfall, 3, 8, 20, 'pit'),
    ]), orders([deploy('giant', 0, 8)]), 43);
    const traps = result.events.filter((e) => e.e === 'trap');
    expect(traps).toHaveLength(1);
    expect(traps[0]).toMatchObject({ id: 'pit', kind: 'pitfall', victims: [0] });
    expect((traps[0] as { t: number; stunUntil: number }).stunUntil - traps[0]!.t).toBe(15);
    expect(result.buildings.find((entry) => entry.id === 'pit')).toMatchObject({ destroyed: true, maxHp: 0 });

    const excluded = simulateRaid(base([
      b(BuildingType.Keep, 12, 8, 1, 'keep'),
      b(BuildingType.SpikeTrap, 3, 8, 20, 'spike'),
    ]), orders([deploy('highlander', 0, 8)]), 43);
    expect(excluded.destructionPct).toBe(0);
    expect(excluded.buildings.find((entry) => entry.id === 'spike')).toMatchObject({ destroyed: true });
  });

  it('Powder Mine splashes ground only and Air Mine splashes flying only', () => {
    const run = (trap: BuildingType, troop: 'highlander' | 'dragon') => simulateRaid(base([
      b(BuildingType.Keep, 12, 8, 1, 'keep'), b(trap, 3, 8, 16, 'trap'),
    ]), orders([deploy(troop, 0, 8), deploy(troop, 0, 8)]), 44);
    const powder = run(BuildingType.PowderMine, 'highlander');
    const air = run(BuildingType.AirMine, 'dragon');
    expect(powder.events.find((e) => e.e === 'trap')).toMatchObject({ victims: [0, 1] });
    expect(air.events.find((e) => e.e === 'trap')).toMatchObject({ victims: [0, 1] });
    expect(run(BuildingType.PowderMine, 'dragon').events.some((e) => e.e === 'trap')).toBe(false);
    expect(run(BuildingType.AirMine, 'highlander').events.some((e) => e.e === 'trap')).toBe(false);
  });
});
