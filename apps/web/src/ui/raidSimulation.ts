import type { BaseSnapshot } from '@shardkeep/shared';
import type { RaidOrders, RaidOutcome, SimOptions } from '@shardkeep/sim';

export interface RaidSimulationInput {
  simVersion: number;
  snapshot: BaseSnapshot;
  orders: RaidOrders;
  seed: number;
  options?: SimOptions;
}
export type RaidSimulationRequest = { id: number; input: RaidSimulationInput };
export type RaidSimulationResponse = { id: number } & (
  | { outcome: RaidOutcome }
  | { error: string }
);
type WorkerPort = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror' | 'onmessageerror'>;
type Task = {
  request: RaidSimulationRequest;
  resolve: (value: RaidOutcome | null) => void;
  reject: (error: Error) => void;
};

/** One raid presentation owns one lazy worker. While a calculation runs, keep
 * only the newest accepted journal; superseded results never reach the canvas.
 * The caller still fences wallet/base/raid identity before applying a result.
 * Worker failure is surfaced, never retried on the main thread. */
export class RaidSimulationService {
  private worker: WorkerPort | null = null;
  private active: Task | null = null;
  private queued: Task | null = null;
  private nextId = 0;
  private closed = false;
  private failure: Error | null = null;

  constructor(private createWorker: () => WorkerPort = () => new Worker(
    new URL('./raidSimulation.worker.ts', import.meta.url), { type: 'module' },
  )) {}

  simulate(input: RaidSimulationInput): Promise<RaidOutcome | null> {
    if (this.closed) return Promise.resolve(null);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const task: Task = { request: { id: ++this.nextId, input }, resolve, reject };
      if (this.active) {
        this.active.resolve(null);
        this.queued?.resolve(null);
        this.queued = task;
      } else this.start(task);
    });
  }

  dispose(): void {
    this.closed = true;
    this.active?.resolve(null);
    this.queued?.resolve(null);
    this.active = this.queued = null;
    this.stopWorker();
  }

  private start(task: Task): void {
    this.active = task;
    try {
      if (!this.worker) {
        this.worker = this.createWorker();
        this.worker.onmessage = (event: MessageEvent<RaidSimulationResponse>) => {
          const active = this.active;
          if (this.closed || !active) return;
          if (event.data?.id !== active.request.id) {
            this.fail(new Error('Battle simulation returned an unexpected revision.'));
            return;
          }
          if ('error' in event.data) { this.fail(new Error(event.data.error)); return; }
          const next = this.queued;
          this.active = this.queued = null;
          active.resolve(next ? null : event.data.outcome);
          if (next) this.start(next);
        };
        this.worker.onerror = () => this.fail(new Error('Battle simulation failed to load or run. Reload the game to retry.'));
        this.worker.onmessageerror = () => this.fail(new Error('Battle simulation could not be received. Reload the game to retry.'));
      }
      this.worker.postMessage(task.request);
    } catch (error) { this.fail(error instanceof Error ? error : new Error('Battle simulation could not start.')); }
  }

  private fail(error: Error): void {
    this.failure = error;
    this.active?.reject(error);
    this.queued?.reject(error);
    this.active = this.queued = null;
    this.stopWorker();
  }

  private stopWorker(): void {
    if (!this.worker) return;
    this.worker.onmessage = this.worker.onerror = this.worker.onmessageerror = null;
    this.worker.terminate();
    this.worker = null;
  }
}
