/** Worker-only executable simulator import. Presentation imports its types. */
import { SIM_VERSION, simulateRaid, type RaidOutcome } from '@shardkeep/sim';
import type { RaidSimulationInput } from './raidSimulation';

export function computeRaidSimulation(input: RaidSimulationInput): RaidOutcome {
  if (input.simVersion !== SIM_VERSION) throw new Error(`LIVE RAID REQUIRES SIM VERSION ${SIM_VERSION}`);
  return simulateRaid(input.snapshot, input.orders, input.seed, input.options);
}
