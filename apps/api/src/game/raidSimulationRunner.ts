import { Worker } from 'node:worker_threads';
import {
  SimInputError,
  SimRepresentationLimitError,
  type RaidOutcome,
} from '@shardkeep/sim';
import { RAID_REPLAY_LIMITS } from '@shardkeep/shared';
import type {
  RaidSimulationWorkerInput,
  RaidSimulationWorkerMessage,
} from './raidSimulationWorker';

export class RaidSimulationBusyError extends Error {
  constructor() {
    super('raid simulator is busy; retry shortly');
    this.name = 'RaidSimulationBusyError';
  }
}

/** The server accepted valid work but its isolated executor failed. This is
 * categorically different from attacker input: the raid must be compensated. */
export class RaidSimulationSystemError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'RaidSimulationSystemError';
  }
}

export interface RaidSimulationPermit {
  run(input: RaidSimulationWorkerInput): Promise<RaidOutcome>;
  release(): Promise<void>;
}

// One worker per API process. Admission is synchronous and never queues, so a
// second socket gets a retryable response even while the first worker is busy.
let activePermit = false;

export function claimRaidSimulationPermit(): RaidSimulationPermit {
  if (activePermit) throw new RaidSimulationBusyError();
  activePermit = true;
  let released = false;
  let worker: Worker | undefined;

  return {
    run(input) {
      if (released) return Promise.reject(new Error('raid simulation permit was released'));
      if (worker) return Promise.reject(new Error('raid simulation permit may only run once'));

      return new Promise<RaidOutcome>((resolve, reject) => {
        // A tiny .mjs bootstrap installs tsx's programmatic loader inside the
        // worker before importing the TypeScript entry. Worker threads do not
        // inherit the main thread's tsx registration reliably on Node 22/23.
        worker = new Worker(new URL('./raidSimulationWorker.mjs', import.meta.url), {
          execArgv: [],
          workerData: input,
        });
        let settled = false;
        const timeout = setTimeout(() => {
          if (settled) return;
          settled = true;
          void worker?.terminate();
          reject(new RaidSimulationSystemError('raid simulation worker timed out'));
        }, RAID_REPLAY_LIMITS.simulationWorkerTimeoutSec * 1_000);
        worker.once('message', (message: RaidSimulationWorkerMessage) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (message.ok) resolve(message.outcome);
          else if (message.kind === 'representation') reject(new SimRepresentationLimitError(message.message));
          else if (message.kind === 'input') reject(new SimInputError(message.message));
          else reject(new RaidSimulationSystemError(message.message));
        });
        worker.once('error', (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new RaidSimulationSystemError('raid simulation worker failed', { cause: error }));
        });
        worker.once('exit', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          reject(new RaidSimulationSystemError(`raid simulation worker exited before replying (${code})`));
        });
      });
    },
    async release() {
      if (released) return;
      released = true;
      activePermit = false;
      if (worker) await worker.terminate();
    },
  };
}
