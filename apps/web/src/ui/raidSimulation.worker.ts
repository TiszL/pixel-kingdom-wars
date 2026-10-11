import { computeRaidSimulation } from './raidSimulationCompute';
import type { RaidSimulationRequest, RaidSimulationResponse } from './raidSimulation';

self.onmessage = (event: MessageEvent<RaidSimulationRequest>): void => {
  const { id, input } = event.data;
  let response: RaidSimulationResponse;
  try { response = { id, outcome: computeRaidSimulation(input) }; }
  catch (error) { response = { id, error: error instanceof Error ? error.message : 'Battle simulation failed.' }; }
  self.postMessage(response);
};
