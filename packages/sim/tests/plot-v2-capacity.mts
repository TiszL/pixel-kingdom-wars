import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { BUILD_COUNT_CAP_BY_KEEP, RAID_REPLAY_LIMITS, STRUCTURES, TROOPS } from '@shardkeep/shared';
import { claimRaidSimulationPermit } from '../../../apps/api/src/game/raidSimulationRunner';
import { maximumPlot2Snapshot } from './plot-v2-capacity.fixture';
import type { RaidOrders } from '../src/types';
import { fnv1a } from './helpers';

const snapshot = maximumPlot2Snapshot();
const armyCapacity = BUILD_COUNT_CAP_BY_KEEP.camp!.at(-1)! * STRUCTURES.camp.capacityPts.at(-1)!;
const edge = [[-34, -34], [-34, 63], [63, -34], [63, 63]] as const;
const scenarios = (['dragon', 'hexbarrow', 'kegrunner'] as const).map(troop => ({
  name: `max50-${troop}-both-heroes`,
  orders: { deploys: Array.from({ length: Math.floor(armyCapacity / TROOPS[troop].pts) }, (_, index) => {
    const [tx, ty] = edge[index % edge.length]!;
    return { troop, tx, ty, tMs: troop === 'dragon' ? index * 120 : 0 };
  }), heroDeploys: [
    { hero: 'vex', level: 20, tx: -11, ty: 15, tMs: 0 },
    { hero: 'theodor', level: 20, tx: 40, ty: 15, tMs: 0 },
  ] } as RaidOrders,
  options: { troopLevels: { [troop]: 20 } },
}));
const samples = [];
for (const scenario of scenarios) {
  const runs = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    const permit = claimRaidSimulationPermit();
    let heartbeats = 0;
    const heartbeat = setInterval(() => { heartbeats++; }, 10);
    const began = performance.now();
    try {
      const outcome = await permit.run({ snapshot, seed: 50, ...scenario });
      runs.push({ wallMs: Math.round(performance.now() - began), heartbeats,
        events: outcome.events.length, ticks: outcome.ticks,
        outcomeBytes: Buffer.byteLength(JSON.stringify(outcome)),
        outcomeHash: fnv1a(JSON.stringify(outcome)), rssBytes: process.memoryUsage().rss });
    } finally {
      clearInterval(heartbeat);
      await permit.release();
    }
  }
  if (runs[0]!.outcomeHash !== runs[1]!.outcomeHash) throw new Error(`non-deterministic ${scenario.name}`);
  samples.push({ name: scenario.name, deploys: scenario.orders.deploys.length, runs });
}
const report = { measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch,
  qualification: 'Local authoritative worker under concurrent development load; not a Seeker or production-server benchmark.',
  buildings: snapshot.buildings.length, field: [-34, 64], plot: [-10, 40],
  wallCap: BUILD_COUNT_CAP_BY_KEEP.wall!.at(-1), actorCap: RAID_REPLAY_LIMITS.maxActors,
  eventCap: RAID_REPLAY_LIMITS.maxEvents, workerDeadlineSec: RAID_REPLAY_LIMITS.simulationWorkerTimeoutSec, samples };
const path = new URL('../../../.reports/floating-hud/sim15-plot50-capacity.json', import.meta.url);
writeFileSync(path, JSON.stringify(report, null, 2) + '\n');
process.stdout.write(`${fileURLToPath(path)}\n${JSON.stringify(report, null, 2)}\n`);
