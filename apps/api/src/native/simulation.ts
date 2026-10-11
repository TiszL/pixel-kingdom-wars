import { Worker } from 'node:worker_threads';
import { RAID_REPLAY_LIMITS } from '@shardkeep/shared';
import { SIM_VERSION, type SimEvent } from '@shardkeep/sim';
import { nativeBuildingHealth, type NativeBuildingHealth } from './health';
import type { RaidSimulationWorkerInput, RaidSimulationWorkerMessage } from '../game/raidSimulationWorker';
import { HttpError } from '../lib/errors';

export type NativeSimulationInput = RaidSimulationWorkerInput;
export interface NativeSimulationResult { events: SimEvent[]; buildingHealth?: NativeBuildingHealth[] }
export type NativeExecutor = (input: NativeSimulationInput, signal: AbortSignal) => Promise<NativeSimulationResult>;

/** Separate admission from settlement: native presentation must never claim a
 * resolution permit or turn a disconnected viewer into compensation/settlement. */
export const executeNativeSimulation: NativeExecutor = (input, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(new Error('native simulation cancelled')); return; }
  const worker = new Worker(new URL('../game/raidSimulationWorker.mjs', import.meta.url), {
    execArgv: [], workerData: input, resourceLimits: { maxOldGenerationSizeMb: 512 },
  });
  let done = false;
  const finish = (error?: Error, events?: NativeSimulationResult) => {
    if (done) return;
    done = true;
    clearTimeout(timeout);
    signal.removeEventListener('abort', abort);
    void worker.terminate().then(() => {
      if (error) reject(error); else resolve(events!);
    }, () => reject(error ?? new Error('native worker termination failed')));
  };
  const abort = () => finish(new Error('native simulation cancelled'));
  const timeout = setTimeout(() => finish(new Error('native simulation timed out')),
    RAID_REPLAY_LIMITS.simulationWorkerTimeoutSec * 1_000);
  signal.addEventListener('abort', abort, { once: true });
  worker.once('message', (message: RaidSimulationWorkerMessage) => {
    if (!message.ok) finish(new Error('native simulation failed'));
    else {
      try {
        const buildingHealth = nativeBuildingHealth(SIM_VERSION, message.outcome);
        finish(undefined, { events: message.outcome.events, ...(buildingHealth ? { buildingHealth } : {}) });
      } catch { finish(new Error('native building health is invalid')); }
    }
  });
  worker.once('error', () => finish(new Error('native simulation worker failed')));
  worker.once('exit', () => finish(new Error('native simulation exited before replying')));
});

interface Task {
  key: string;
  input: NativeSimulationInput;
  promise: Promise<NativeSimulationResult | null>;
  resolve: (events: NativeSimulationResult | null) => void;
  reject: (error: unknown) => void;
  controller: AbortController;
  viewers: number;
  retained: boolean;
  settled: boolean;
}
interface Slot { active: Task | null; pending: Task | null }
export interface NativeSimulationLimits { workers: number; raids: number; cacheBytes: number }

/** Bounded by distinct raids, executor count and serialized cached bytes. A
 * running raid keeps only its latest requested journal. Superseded callers
 * receive null and re-read authority; obsolete events never enter the cache. */
export class NativeSimulationService {
  private slots = new Map<string, Slot>();
  private cache = new Map<string, { key: string; events: NativeSimulationResult; bytes: number }>();
  private executions = new Set<Promise<void>>();
  private bytes = 0;
  private running = 0;
  private closed = false;

  constructor(private limits: NativeSimulationLimits, private execute = executeNativeSimulation) {}

  simulate(raidId: string, key: string, input: NativeSimulationInput, signal?: AbortSignal): Promise<NativeSimulationResult | null> {
    if (this.closed) return Promise.reject(new Error('native presentation is closed'));
    if (signal?.aborted) return Promise.reject(new HttpError(499, 'presentation request closed'));
    const cached = this.cache.get(raidId);
    if (cached?.key === key) {
      this.cache.delete(raidId); this.cache.set(raidId, cached);
      return Promise.resolve(cached.events);
    }
    let slot = this.slots.get(raidId);
    if (slot?.pending?.key === key) return this.view(raidId, slot, slot.pending, signal);
    if (slot?.active?.key === key && !slot.pending && !slot.active.controller.signal.aborted) {
      return this.view(raidId, slot, slot.active, signal);
    }
    if (!slot) {
      if (this.slots.size >= this.limits.raids) {
        return Promise.reject(new HttpError(503, 'native presentation is busy', 'NATIVE_PRESENTATION_BUSY'));
      }
      slot = { active: null, pending: null };
      this.slots.set(raidId, slot);
    }
    let resolve!: Task['resolve']; let reject!: Task['reject'];
    const promise = new Promise<NativeSimulationResult | null>((yes, no) => { resolve = yes; reject = no; });
    const task: Task = { key, input, promise, controller: new AbortController(), viewers: 0, retained: false, settled: false,
      resolve: (value) => { task.settled = true; resolve(value); },
      reject: (error) => { task.settled = true; reject(error); },
    };
    this.cancel(slot.active); this.cancel(slot.pending);
    slot.pending = task;
    // Attach the first viewer before an executor can be admitted.
    const result = this.view(raidId, slot, task, signal);
    this.pump();
    return result;
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const slot of this.slots.values()) {
      this.cancel(slot.active); this.cancel(slot.pending);
    }
    this.slots.clear(); this.cache.clear(); this.bytes = 0;
    await Promise.allSettled(this.executions);
  }

  private cancel(task: Task | null): void {
    if (!task) return;
    task.resolve(null);
    task.controller.abort();
  }

  private view(raidId: string, slot: Slot, task: Task, signal?: AbortSignal): Task['promise'] {
    // Non-HTTP callers retain their calculation and preserve promise sharing.
    if (!signal) { task.retained = true; return task.promise; }
    task.viewers++;
    return new Promise((resolve, reject) => {
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal.removeEventListener('abort', abort);
        task.viewers--;
        if (!task.viewers && !task.retained && !task.settled) {
          this.cancel(task);
          if (slot.pending === task) slot.pending = null;
          if (!slot.active && !slot.pending) this.slots.delete(raidId);
        }
      };
      const abort = () => { release(); reject(new HttpError(499, 'presentation request closed')); };
      signal.addEventListener('abort', abort, { once: true });
      void task.promise.then((value) => { release(); resolve(value); }, (error: unknown) => { release(); reject(error); });
    });
  }

  private pump(): void {
    for (const [raidId, slot] of this.slots) {
      if (this.closed || this.running >= this.limits.workers) return;
      if (slot.active || !slot.pending) continue;
      const task = slot.pending;
      slot.active = task; slot.pending = null; this.running++;
      const execution = Promise.resolve().then(() => this.execute(task.input, task.controller.signal)).then((events) => {
        if (this.closed || task.controller.signal.aborted || slot.pending) { task.resolve(null); return; }
        const bytes = Buffer.byteLength(JSON.stringify(events));
        if (events.events.length > RAID_REPLAY_LIMITS.maxEvents || bytes > this.limits.cacheBytes) {
          throw new HttpError(503, 'native presentation exceeds response capacity', 'NATIVE_PRESENTATION_CAPACITY');
        }
        const old = this.cache.get(raidId);
        if (old) { this.bytes -= old.bytes; this.cache.delete(raidId); }
        while (this.cache.size && (this.cache.size >= this.limits.raids || this.bytes + bytes > this.limits.cacheBytes)) {
          const oldest = this.cache.keys().next().value!;
          this.bytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
        }
        this.cache.set(raidId, { key: task.key, events, bytes }); this.bytes += bytes;
        task.resolve(events);
      }).catch((error: unknown) => task.reject(error)).finally(() => {
        // executeNativeSimulation settles only after Worker.terminate settles.
        this.executions.delete(execution); this.running--; slot.active = null;
        if (this.slots.get(raidId) === slot) {
          this.slots.delete(raidId);
          // A changing raid yields its next turn to other waiting raids. Keeping
          // its original Map position lets repeated supersession starve them.
          if (slot.pending) this.slots.set(raidId, slot);
        }
        this.pump();
      });
      this.executions.add(execution);
    }
  }
}
