import type Phaser from 'phaser';
import { bus, type SceneVisualProgress, type SceneVisualTimings } from '../../lib/events';

export type SceneVisualState = 'loading' | 'ready' | 'failed';
type GroundProgress = SceneVisualTimings & {
  state: string; phase?: SceneVisualProgress['phase']; completed?: number; total?: number;
};

/** Keep scene updates running while initial terrain and contextual walls prepare.
 * Hiding the camera is synchronous; React's cover cannot expose an intermediate
 * frame while its state update is waiting to commit. */
export class SceneVisualGate {
  private state: SceneVisualState = 'loading';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private sleeping = false;
  private page = typeof document === 'undefined' ? undefined : document;
  private inputEnabled: boolean;
  private clockPaused: boolean | undefined;
  private tweensPaused: boolean | undefined;
  private waiters: Array<() => void> = [];
  private unsubscribe: () => void;
  private phase: SceneVisualProgress['phase'] = 'base';
  private completed = 0;
  private progressKey = '';
  private activeMs = 0;
  private emittedAt = 0;
  private armedAt: number | undefined;
  private onSleep = (): void => { this.sleeping = true; this.pauseTimeout(); };
  private onWake = (): void => { this.sleeping = false; if (this.state === 'loading') this.armTimeout(); };
  private onDestroy = (): void => this.destroy();
  private onVisibility = (): void => {
    if (this.page?.hidden) this.pauseTimeout();
    else if (this.state === 'loading') this.armTimeout();
  };

  constructor(private scene: Phaser.Scene, private key: 'base' | 'battle', private retry: () => void,
    private onCover: () => void = () => {}) {
    this.inputEnabled = scene.input?.enabled ?? true;
    if (key === 'battle') {
      this.clockPaused = scene.time?.paused ?? false;
      this.tweensPaused = scene.tweens?.paused ?? false;
    }
    this.unsubscribe = bus.on('scene:visualRetry', ({ scene: key }) => {
      if (key !== this.key || this.stopped) return;
      this.begin();
      try { this.retry(); } catch { this.fail(); }
    });
    scene.events.on('sleep', this.onSleep);
    scene.events.on('wake', this.onWake);
    scene.events.once('destroy', this.onDestroy);
    this.page?.addEventListener('visibilitychange', this.onVisibility);
    this.begin();
  }

  get isReady(): boolean { return this.state === 'ready'; }
  ready(): Promise<void> {
    return this.isReady || this.stopped ? Promise.resolve() : new Promise(resolve => this.waiters.push(resolve));
  }

  /** Called before a context swap removes its old texture, including when the
   * swap is triggered between Phaser update callbacks. */
  loading(): void { if (!this.stopped && this.state !== 'loading') this.begin(); }

  update(ground: GroundProgress | undefined, wallsPreparing: boolean, wallError = '', populated = true): void {
    if (this.stopped || this.state === 'failed') return;
    if (this.state === 'loading' || wallError || ground?.state === 'failed') {
      this.progress(ground, wallsPreparing || !!wallError, populated);
    }
    if (wallError || ground?.state === 'failed') { this.fail(); return; }
    if (!populated || !ground || ground.state === 'idle' || ground.state === 'loading') {
      if (this.state === 'ready') this.begin();
      return;
    }
    // Later edits retain the already-published neighborhood while its new batch
    // prepares. Only initial/context loading waits for the complete wall batch.
    if (this.state === 'ready' || wallsPreparing) return;
    if (ground.state === 'ready') this.publish('ready');
  }

  private begin(): void {
    this.pauseTimeout();
    this.activeMs = 0; this.phase = 'base'; this.completed = 0; this.progressKey = '';
    this.publish('loading');
    this.armTimeout();
  }

  private progress(ground: GroundProgress | undefined, wallsPreparing: boolean, populated: boolean): void {
    const phase = !populated || !ground ? 'base'
      : ground.state === 'ready' ? (wallsPreparing ? 'walls' : 'ready') : ground.phase ?? 'terrain';
    const completed = phase === 'terrain' || phase === 'download' ? ground?.completed ?? 0 : 0;
    const total = phase === 'terrain' || phase === 'download' ? ground?.total ?? 0 : 0;
    // Only a new phase, received bytes or sampled rows count as useful progress. Repeated
    // scene ticks cannot keep a stuck download or upload alive indefinitely.
    if (phase !== this.phase || completed > this.completed) {
      this.phase = phase; this.completed = completed; this.armTimeout();
    }
    const key = `${phase}:${total ? Math.floor(completed / total * 100) : completed}:${ground?.loadAttempt ?? 0}:${ground?.loadReason ?? ''}:${ground?.state ?? ''}`;
    if (key === this.progressKey) return;
    // Byte activity is accounted above even when React updates are throttled.
    if (phase === 'download' && ground?.state !== 'failed' && this.progressKey.startsWith('download:')
      && performance.now() - this.emittedAt < 250) return;
    this.progressKey = key; this.emittedAt = performance.now();
    const timings: SceneVisualTimings = {};
    for (const field of ['downloadMs', 'verifyMs', 'decodeMs', 'paintMs', 'uploadMs',
      'maxPaintBatchMs', 'width', 'height', 'loadAttempt', 'loadActiveMs'] as const) {
      const value = ground?.[field];
      if (typeof value === 'number' && Number.isFinite(value)) timings[field] = Math.max(0, Math.round(value));
    }
    if (ground?.loadProtocol !== undefined) timings.loadProtocol = ground.loadProtocol;
    if (ground?.loadReason !== undefined) timings.loadReason = ground.loadReason;
    if (ground?.cacheHit !== undefined) timings.cacheHit = ground.cacheHit;
    bus.emit('scene:visualProgress', { scene: this.key, phase, completed, total, timings });
  }

  private pauseTimeout(): void {
    clearTimeout(this.timer);
    if (this.armedAt !== undefined) this.activeMs += Math.max(0, performance.now() - this.armedAt);
    this.armedAt = undefined;
  }

  private armTimeout(): void {
    this.pauseTimeout();
    // Operational watchdog, independent of Phaser's clock/render loop. A stalled
    // decode or wall preparation must expose recovery instead of hiding forever.
    if (!this.sleeping && !this.page?.hidden) {
      this.armedAt = performance.now();
      // The shared transfer owns byte-idle recovery and its entire finite
      // episode. Do not race its healthy retries with a second download timer.
      const quietMs = this.phase === 'download' ? 120_000 : 20_000;
      this.timer = setTimeout(() => this.fail(), Math.max(0, Math.min(quietMs, 120_000 - this.activeMs)));
    }
  }

  private fail(): void { if (!this.stopped && this.state !== 'failed') this.publish('failed'); }

  private publish(state: SceneVisualState): void {
    const wasReady = this.state === 'ready';
    this.state = state;
    if (wasReady && state !== 'ready') this.onCover();
    if (state !== 'loading') this.pauseTimeout();
    this.scene.cameras.main.visible = state === 'ready';
    if (this.scene.input) this.scene.input.enabled = state === 'ready' && this.inputEnabled;
    if (this.clockPaused !== undefined && this.scene.time) this.scene.time.paused = state !== 'ready' || this.clockPaused;
    if (this.tweensPaused !== undefined && this.scene.tweens) this.scene.tweens.paused = state !== 'ready' || this.tweensPaused;
    bus.emit('scene:visual', { scene: this.key, state });
    if (state === 'ready') for (const resolve of this.waiters.splice(0)) resolve();
  }

  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.pauseTimeout();
    this.unsubscribe();
    this.scene.events.off('sleep', this.onSleep);
    this.scene.events.off('wake', this.onWake);
    this.scene.events.off('destroy', this.onDestroy);
    this.page?.removeEventListener('visibilitychange', this.onVisibility);
    // Built-in plugins register DESTROY first; CameraManager may have already
    // nulled its main camera when a full Game.destroy bypasses SHUTDOWN.
    if (this.scene.cameras?.main) this.scene.cameras.main.visible = true;
    if (this.scene.input) this.scene.input.enabled = this.inputEnabled;
    if (this.clockPaused !== undefined && this.scene.time) this.scene.time.paused = this.clockPaused;
    if (this.tweensPaused !== undefined && this.scene.tweens) this.scene.tweens.paused = this.tweensPaused;
    for (const resolve of this.waiters.splice(0)) resolve();
  }
}
