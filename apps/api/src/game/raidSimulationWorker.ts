/**
 * Isolated CPU worker for deterministic raid resolution.
 *
 * The API runs TypeScript directly through tsx, and the parent explicitly
 * installs the same loader for this worker. Keeping the simulator off the main
 * thread means a legal maximum roster cannot stop health checks, auth, or the
 * fail-fast admission response while its replay is calculated.
 */
import { parentPort, workerData } from 'node:worker_threads';
import {
  SimInputError,
  SimRepresentationLimitError,
  simulateRaid,
  type RaidOrders,
  type SimOptions,
} from '@shardkeep/sim';
import type { BaseSnapshot } from '@shardkeep/shared';

export interface RaidSimulationWorkerInput {
  snapshot: BaseSnapshot;
  orders: RaidOrders;
  seed: number;
  options: SimOptions;
}

export type RaidSimulationWorkerMessage =
  | { ok: true; outcome: ReturnType<typeof simulateRaid> }
  | { ok: false; kind: 'representation' | 'input' | 'internal'; message: string };

if (!parentPort) throw new Error('raid simulation worker requires a parent port');

try {
  const input = workerData as RaidSimulationWorkerInput;
  parentPort.postMessage({
    ok: true,
    outcome: simulateRaid(input.snapshot, input.orders, input.seed, input.options),
  } satisfies RaidSimulationWorkerMessage);
} catch (error) {
  const kind = error instanceof SimRepresentationLimitError
    ? 'representation'
    : error instanceof SimInputError
      ? 'input'
      : 'internal';
  parentPort.postMessage({
    ok: false,
    kind,
    message: error instanceof Error ? error.message : 'raid simulator failed',
  } satisfies RaidSimulationWorkerMessage);
}
parentPort.close();
