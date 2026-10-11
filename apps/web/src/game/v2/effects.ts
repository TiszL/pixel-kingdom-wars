import type Phaser from 'phaser';

const UPDATE = 'update';
const SHUTDOWN = 'shutdown';

export interface EffectHandle {
  cancel(): void;
}

interface Entry {
  elapsed: number;
  duration: number;
  render: (elapsedMs: number, progress: number) => void;
  complete?: () => void;
  dispose?: () => void;
}

/**
 * One absolute-time scheduler per scene for every transient combat effect.
 * Entries contain no Phaser TimerEvent or Tween. A long frame evaluates the
 * effect at its absolute new position and still settles it exactly once.
 */
export class CombatEffectPool {
  private entries = new Set<Entry>();
  private stopped = false;
  private timeScale = 1;
  private readonly updateHandler: (_time: number, delta: number) => void;

  constructor(private readonly scene: Phaser.Scene) {
    this.updateHandler = (_time, delta) => this.tick(delta);
    const events = (scene as Phaser.Scene & { events?: Phaser.Events.EventEmitter }).events;
    events?.on(UPDATE, this.updateHandler);
    events?.once(SHUTDOWN, () => this.destroy());
  }

  add(
    durationMs: number,
    render: Entry['render'],
    complete?: () => void,
    dispose?: () => void,
  ): EffectHandle {
    const entry: Entry = {
      elapsed: 0,
      duration: Math.max(1, durationMs),
      render,
      ...(complete ? { complete } : {}),
      ...(dispose ? { dispose } : {}),
    };
    this.entries.add(entry);
    render(0, 0);
    return {
      cancel: () => {
        if (!this.entries.delete(entry)) return;
        entry.dispose?.();
      },
    };
  }

  /** Persistent attachment (Dragon stream). The caller owns cancellation. */
  addLoop(render: (elapsedMs: number) => void, dispose?: () => void): EffectHandle {
    return this.add(Number.MAX_SAFE_INTEGER, (elapsed) => render(elapsed), undefined, dispose);
  }

  tick(deltaMs: number): void {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) return;
    const scaledDeltaMs = deltaMs * this.timeScale;
    for (const entry of [...this.entries]) {
      if (!this.entries.has(entry)) continue;
      entry.elapsed = Math.min(entry.duration, entry.elapsed + scaledDeltaMs);
      const progress = entry.elapsed / entry.duration;
      entry.render(entry.elapsed, progress);
      if (entry.elapsed < entry.duration || !this.entries.delete(entry)) continue;
      entry.complete?.();
    }
  }

  get size(): number {
    return this.entries.size;
  }

  get destroyed(): boolean {
    return this.stopped;
  }

  /** Keep raw-delta pooled FX on the same playback clock as Phaser timers. */
  setTimeScale(scale: number): void {
    this.timeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  }

  /** A verdict seek discards presentation work; authoritative impacts already
   * arrived through the event log, so clearing must not invent completions. */
  clear(): void {
    for (const entry of this.entries) entry.dispose?.();
    this.entries.clear();
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    const events = (this.scene as Phaser.Scene & {
      events?: Phaser.Events.EventEmitter;
    }).events;
    events?.off(UPDATE, this.updateHandler);
    this.clear();
  }
}

const POOLS = new WeakMap<Phaser.Scene, CombatEffectPool>();

export function combatEffectPool(scene: Phaser.Scene): CombatEffectPool {
  let pool = POOLS.get(scene);
  if (!pool || pool.destroyed) {
    pool = new CombatEffectPool(scene);
    POOLS.set(scene, pool);
  }
  return pool;
}

/** Deterministic test/seek seam; production advances from the scene update. */
export function advanceCombatEffects(scene: Phaser.Scene, deltaMs: number): void {
  combatEffectPool(scene).tick(deltaMs);
}

export function combatEffectCount(scene: Phaser.Scene): number {
  return combatEffectPool(scene).size;
}
