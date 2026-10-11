import {
  BuildingType,
  RAID_REPLAY_LIMITS,
  type BaseSnapshot,
} from '@shardkeep/shared';
import { MAX_TICKS, SimRepresentationLimitError } from '@shardkeep/sim';
import { describe, expect, it } from 'vitest';
import {
  claimRaidSimulationPermit,
  RaidSimulationBusyError,
  RaidSimulationSystemError,
} from '../src/game/raidSimulationRunner';
import { makeCampaignSnapshot } from '../src/game/world';

const maxHexInput = () => ({
  snapshot: {
    keepLevel: 20,
    surplusShards: 1_000,
    claimMin: 2,
    claimMax: 28,
    buildings: [
      { id: 'vault', type: BuildingType.Vault, level: 20, tx: 2, ty: 27 },
      { id: 'forge', type: BuildingType.Forge, level: 20, tx: 27, ty: 27 },
      { id: 'keep', type: BuildingType.Keep, level: 20, tx: 26, ty: 2 },
    ],
  } satisfies BaseSnapshot,
  orders: {
    deploys: Array.from({ length: 40 }, () => ({
      troop: 'hexbarrow' as const, tx: -4, ty: -4, tMs: 0,
    })),
  },
  seed: 122,
  options: { troopLevels: { hexbarrow: 1 } },
});

describe('raid simulation worker admission', () => {
  it('runs SIM15 dense Stage100 and maximum Hex reserves without enlarging the wall-routing grid', async () => {
    const stage = { ...makeCampaignSnapshot(100), battlefieldVersion: 2 as const };
    const dense = {
      snapshot: stage,
      orders: {
        deploys: Array.from({ length: 90 }, (_, i) => ({ troop: 'dragon' as const,
          tx: i % 2 ? 63 : -34, ty: 15, tMs: i * 120 })),
        heroDeploys: [
          { hero: 'vex' as const, level: 20, tx: 15, ty: -7, tMs: 0 },
          { hero: 'theodor' as const, level: 20, tx: 15, ty: 63, tMs: 0 },
        ],
      },
      options: { troopLevels: { dragon: 20 } }, seed: 100,
    };
    const hex = maxHexInput();
    hex.snapshot = { ...hex.snapshot, battlefieldVersion: 2 } as typeof hex.snapshot;
    hex.orders.deploys = hex.orders.deploys.map(d => ({ ...d, tx: -34, ty: -34 }));
    for (const input of [dense, hex]) {
      const permit = claimRaidSimulationPermit();
      try {
        const outcome = await permit.run(input);
        expect(outcome.events.length).toBeGreaterThan(input.orders.deploys.length);
        expect(outcome.events.length).toBeLessThanOrEqual(RAID_REPLAY_LIMITS.maxEvents);
        expect(outcome.ticks).toBeLessThanOrEqual(MAX_TICKS + RAID_REPLAY_LIMITS.postBattleDrainTicks);
      } finally {
        await permit.release();
      }
    }
  }, 45_000);

  it('keeps the event loop responsive during the maximum legal Hex replay and fails a second raid fast', async () => {
    // WHY: this legal replay takes meaningful CPU. It must run outside Fastify's
    // event loop, while process admission remains capacity-one and non-queuing.
    const permit = claimRaidSimulationPermit();
    let settled = false;
    const running = permit.run(maxHexInput()).finally(() => { settled = true; });

    let heartbeat = false;
    await new Promise<void>((resolve) => setTimeout(() => {
      heartbeat = true;
      resolve();
    }, 25));
    expect(heartbeat).toBe(true);
    expect(settled).toBe(false);
    expect(() => claimRaidSimulationPermit()).toThrow(RaidSimulationBusyError);

    const outcome = await running;
    await permit.release();
    // M22's defensive Keep can end this replay before the battle clock. This
    // admission test owns responsiveness/capacity, not a duplicate combat
    // golden; pin only that the worker completed a legal bounded simulation.
    expect(outcome.ticks).toBeGreaterThan(0);
    expect(outcome.ticks).toBeLessThanOrEqual(MAX_TICKS);

    const retry = claimRaidSimulationPermit();
    await retry.release();
  }, 15_000);

  it('reconstructs representation errors in the parent process', async () => {
    // WHY: submitOrders' exact compensation branch uses instanceof; structured
    // clone cannot preserve a custom Error prototype by itself.
    const permit = claimRaidSimulationPermit();
    const input = {
      ...maxHexInput(),
      orders: {
        deploys: Array.from(
          { length: RAID_REPLAY_LIMITS.maxDirectDeploys + 1 },
          () => ({ troop: 'bowman' as const, tx: -4, ty: 0, tMs: 0 }),
        ),
      },
    };
    await expect(permit.run(input)).rejects.toBeInstanceOf(SimRepresentationLimitError);
    await permit.release();
  });

  it('types an internal worker fault as a compensable system failure', async () => {
    const permit = claimRaidSimulationPermit();
    const malformed = { ...maxHexInput(), orders: null } as unknown as Parameters<typeof permit.run>[0];
    await expect(permit.run(malformed)).rejects.toBeInstanceOf(RaidSimulationSystemError);
    await permit.release();
  });
});
