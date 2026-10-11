/**
 * Opt-in performance diagnostics (D-101 "measure first"; owner 2026-09-03:
 * "the game has become heavy and a bit of freezing" on Solana Mobile).
 *
 * LAZY BY CONTRACT: only `PhaserGame.tsx` reaches this module, through a
 * dynamic import gated on `lib/perfDiagFlag.ts`. Nothing else may import it —
 * a static import would put the measurement code and its per-frame hooks into
 * every session, which is the opposite of what an opt-in overlay is for.
 *
 * What it measures, and why each number exists:
 * - rendered frame deltas sampled at game STEP into a ring buffer → p50/p95/p99
 *   and the count over `PERF_DIAG.stallFrameMs` (`rawDelta` when unlimited;
 *   successive STEP timestamps when fps-limited). The p95/p99 gate is how every
 *   later perf cut (P1a @1x art, transfer discipline, cadence) is accepted or
 *   rejected, so the percentile math is pinned by a test.
 * - draw calls per frame by wrapping the WebGL draw entry points: Phaser 4.1
 *   has no counter. Restored on dispose; skipped on the Canvas renderer.
 * - decoded texture residency from the same `textureBytes` the atlas budget
 *   enforces, so the overlay and `artBudget` never disagree.
 * - long tasks (PerformanceObserver, when supported), WebGL context loss, and
 *   the device facts that put the numbers in context.
 *
 * Output: a small pointer-transparent DOM readout refreshed once a second and
 * ONE bounded `perf_summary` telemetry event per `PERF_DIAG.summaryWindowMs`,
 * ≤ 32 numeric/boolean props, capped per page session — the sink allows
 * 30 req/min/IP and the Seeker is identifiable through the sticky
 * `?client=solana-mobile` marker the analytics context already carries.
 */
import type Phaser from 'phaser';
import { PERF_DIAG } from '@shardkeep/shared';
import { StepTimingSampler } from '../game/stepTiming';
import { textureBytes } from '../game/world/atlasLoader';
import { useApp } from '../state/store';
import { EVENTS, track } from './analytics';
import type { SceneVisualProgress } from './events';
import { readGameViewportDiagnostics } from './gameViewport';

// Phaser event names as strings: this module must not import the Phaser
// runtime (it is loaded after the game exists, and its tests run without it).
// Pinned in perfDiag.test.ts against the Phaser constants.
export const STEP_EVENT = 'step';
export const POST_RENDER_EVENT = 'postrender';
export const PAUSE_EVENT = 'pause';
export const LOSE_WEBGL_EVENT = 'losewebgl';

export interface FrameStats {
  p50: number;
  p95: number;
  p99: number;
}

/** Nearest-rank percentile over an ascending-sorted series; 0 for an empty one. */
export function percentile(sorted: ArrayLike<number>, p: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  const rank = Math.min(n, Math.max(1, Math.ceil((p / 100) * n)));
  return sorted[rank - 1] ?? 0;
}

export function frameStats(deltas: ArrayLike<number>): FrameStats {
  const sorted = Float64Array.from(deltas).sort();
  return {
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  };
}

/** Fixed-size ring of frame deltas (ms). */
export class FrameRing {
  private readonly buf: Float64Array;
  private next = 0;
  private filled = 0;

  constructor(size: number) {
    this.buf = new Float64Array(Math.max(1, size));
  }

  push(dt: number): void {
    this.buf[this.next] = dt;
    this.next = (this.next + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled += 1;
  }

  clear(): void {
    this.next = 0;
    this.filled = 0;
  }

  /** Recorded deltas, oldest first. */
  values(): Float64Array {
    if (this.filled < this.buf.length) return this.buf.slice(0, this.filled);
    return Float64Array.from([...this.buf.subarray(this.next), ...this.buf.subarray(0, this.next)]);
  }

  get size(): number { return this.filled; }
}

export const MAX_SUMMARY_PROPS = 32;

export type PerfSummary = Record<string, number | boolean>;

/** Only what the sink accepts and what a dashboard can aggregate: numbers and
 *  booleans, nothing that could carry an identifier. Trims to the cap rather
 *  than dropping the event — a later added field must never silence the summary. */
export function boundSummary(summary: PerfSummary): PerfSummary {
  const out: PerfSummary = {};
  let n = 0;
  for (const [k, v] of Object.entries(summary)) {
    if (n >= MAX_SUMMARY_PROPS) break;
    if (typeof v === 'boolean') { out[k] = v; n += 1; continue; }
    if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; n += 1; }
  }
  return out;
}

interface GlLike {
  drawElements?: (...args: unknown[]) => void;
  drawArrays?: (...args: unknown[]) => void;
  drawArraysInstanced?: (...args: unknown[]) => void;
  drawElementsInstanced?: (...args: unknown[]) => void;
}

const DRAW_METHODS = ['drawElements', 'drawArrays', 'drawArraysInstanced', 'drawElementsInstanced'] as const;

/** Counts every WebGL draw through the context Phaser renders with. Wrapping
 *  the context's own properties is enough: the renderer looks them up per call. */
function wrapDrawCalls(gl: GlLike, onDraw: () => void): () => void {
  const originals: Partial<Record<(typeof DRAW_METHODS)[number], (...args: unknown[]) => void>> = {};
  for (const name of DRAW_METHODS) {
    const fn = gl[name];
    if (typeof fn !== 'function') continue;
    originals[name] = fn;
    gl[name] = function wrapped(this: unknown, ...args: unknown[]) {
      onDraw();
      return fn.apply(this, args);
    };
  }
  return () => {
    for (const name of DRAW_METHODS) {
      const fn = originals[name];
      if (fn) gl[name] = fn;
    }
  };
}

/** Sum of decoded RGBA bytes over every texture the manager holds, plus count. */
export function textureResidency(textures: Phaser.Textures.TextureManager): { bytes: number; count: number } {
  let bytes = 0;
  let count = 0;
  for (const key of Object.keys(textures.list as Record<string, unknown>)) {
    bytes += textureBytes(textures, key);
    count += 1;
  }
  return { bytes, count };
}

const MIB = 1024 * 1024;

interface DeviceFacts {
  deviceMemoryGb?: number;
  cores?: number;
  dpr: number;
  heapMiB?: number;
}

function deviceFacts(): DeviceFacts {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const perf = performance as Performance & { memory?: { usedJSHeapSize?: number } };
  const heap = perf.memory?.usedJSHeapSize;
  return {
    ...(typeof nav.deviceMemory === 'number' ? { deviceMemoryGb: nav.deviceMemory } : {}),
    ...(typeof nav.hardwareConcurrency === 'number' ? { cores: nav.hardwareConcurrency } : {}),
    dpr: window.devicePixelRatio || 1,
    ...(typeof heap === 'number' ? { heapMiB: Math.round(heap / MIB) } : {}),
  };
}

/** Summaries already emitted this page session (the cap is per session, not
 *  per mount — toggling the overlay off and on must not reset the budget). */
let summariesSent = 0;

/** Test seam only. */
export function resetPerfDiagSessionForTests(): void { summariesSent = 0; }

type VisualScene = 'base' | 'battle';
interface PreparationSnapshot {
  state: 'loading' | 'ready' | 'failed';
  progress?: SceneVisualProgress | undefined;
}

/** DOM-only evidence. These values are intentionally absent from perf_summary. */
function preparationReadout(scene: VisualScene, snapshot: PreparationSnapshot | undefined): string[] {
  const progress = snapshot?.progress;
  if (!progress) return [];
  const t = progress.timings;
  const ms = (value: number | undefined): string => typeof value === 'number' && Number.isFinite(value)
    ? `${Math.round(value)}ms` : 'n/a';
  return [
    `${scene} prep ${snapshot.state}/${progress.phase}${t?.cacheHit ? ' · source cache hit (load timings reused)' : ''}`,
    `download ${ms(t?.downloadMs)} · verify ${ms(t?.verifyMs)} · decode+readback ${ms(t?.decodeMs)}`,
    `compose CPU ${ms(t?.paintMs)} · submit CPU ${ms(t?.uploadMs)} · batch max ${ms(t?.maxPaintBatchMs)}`,
    `raster ${t?.width ?? 0}×${t?.height ?? 0} · rows ${progress.completed}/${progress.total}`,
  ];
}

/**
 * Attach every probe to a running game and start the readout + telemetry.
 * Returns the disposer that unhooks the game, restores the GL draw functions
 * and removes the DOM element. Safe to call again after dispose.
 */
export function mountPerfDiag(game: Phaser.Game,
  readPreparation?: (scene: VisualScene) => PreparationSnapshot,
): () => void {
  const ring = new FrameRing(PERF_DIAG.frameRingSize);
  let windowFrames = 0;
  let windowStalls = 0;
  let windowMaxDt = 0;
  let drawsThisFrame = 0;
  let windowDraws = 0;
  let windowDrawsMax = 0;
  let longTasks = 0;
  let longTaskMax = 0;
  let contextLost = 0;
  let baseFrames = 0;
  let battleFrames = 0;
  let otherFrames = 0;
  let hiddenFrames = 0;
  let sampleCurrentFrame = false;
  let seq = 0;
  const timing = new StepTimingSampler();
  const limited = game.loop.hasFpsLimit;
  // The existing telemetry window stays unchanged. The DOM has its own scene
  // window so a sleeping Phaser base can never masquerade as globe performance.
  const displayRing = new FrameRing(PERF_DIAG.frameRingSize);
  const displayTiming = new StepTimingSampler();
  const baselines = new Map<VisualScene, { bytes: number; count: number }>();
  let displayScope = '';
  let displayFirst = true;
  let displayPending: number | null = null;
  let displayMax = 0;
  let displayLastRender: number | undefined;
  const scope = (): { key: string; scene: VisualScene | null; active: boolean } => {
    const screen = useApp.getState().screen;
    const scene = screen === 'battle' || screen === 'scout' ? 'battle'
      : screen === 'base' || screen === 'build' || screen === 'layout' ? 'base' : null;
    const state = scene ? readPreparation?.(scene).state ?? 'ready' : 'covered';
    const active = !!scene && game.scene.isActive(scene) && game.scene.isVisible(scene)
      && document.visibilityState === 'visible'
      && !(game.renderer as { contextLost?: boolean } | null)?.contextLost;
    return { key: `${screen}:${state}:${active}`, scene, active };
  };
  const resetDisplay = (): void => {
    displayScope = ''; displayFirst = true; displayPending = null;
    displayMax = 0; displayLastRender = undefined;
    displayRing.clear(); displayTiming.dropBaseline(); displayTiming.clearWindow();
  };
  const syncDisplay = (): ReturnType<typeof scope> => {
    const current = scope();
    if (current.key !== displayScope) { resetDisplay(); displayScope = current.key; }
    return current;
  };
  const unsubscribeScreen = useApp.subscribe((state, previous) => {
    if (state.screen !== previous.screen) resetDisplay();
  });
  const onPause = (): void => { timing.dropBaseline(); resetDisplay(); };

  const onStep = (time: number): void => {
    const display = syncDisplay();
    displayPending = null;
    if (display.active) {
      const dt = displayTiming.sample(time, game.loop.rawDelta, limited);
      // Even an unlimited frame can straddle a scene transition. Establish a
      // fresh baseline before reporting that scene's completed-frame intervals.
      if (!displayFirst) displayPending = dt;
      displayFirst = false;
    }
    // Phaser's STEP delta is deliberately smoothed and capped. rawDelta is the
    // browser-frame gap on an unlimited game. With fps.limit it still measures
    // every rAF; successive accepted STEP timestamps are the rendered gap.
    const dt = timing.sample(time, game.loop.rawDelta, limited);
    if (dt === null) { sampleCurrentFrame = false; return; }
    sampleCurrentFrame = true;
    ring.push(dt);
    windowFrames += 1;
    if (dt > PERF_DIAG.stallFrameMs) windowStalls += 1;
    if (dt > windowMaxDt) windowMaxDt = dt;
    const screen = useApp.getState().screen;
    if (screen === 'battle' || screen === 'scout') battleFrames += 1;
    else if (game.scene.isActive('base')) baseFrames += 1;
    else otherFrames += 1;
    if (document.visibilityState === 'hidden') hiddenFrames += 1;
  };
  const onPostRender = (): void => {
    const display = syncDisplay();
    if (display.active) {
      displayLastRender = performance.now();
      if (displayPending !== null) {
        displayRing.push(displayPending);
        displayMax = Math.max(displayMax, displayPending);
      }
    }
    displayPending = null;
    // STEP precedes rendering, so only POST_RENDER has this frame's complete
    // draw count. Committing at the next STEP misattributes the final frame of
    // every telemetry window.
    if (sampleCurrentFrame) {
      windowDraws += drawsThisFrame;
      if (drawsThisFrame > windowDrawsMax) windowDrawsMax = drawsThisFrame;
    }
    drawsThisFrame = 0;
    sampleCurrentFrame = false;
  };
  game.events.on(STEP_EVENT, onStep);
  game.events.on(POST_RENDER_EVENT, onPostRender);
  game.events.on(PAUSE_EVENT, onPause);

  const renderer = game.renderer as { gl?: GlLike; on?: (e: string, cb: () => void) => unknown; off?: (e: string, cb: () => void) => unknown } | null;
  const webgl = !!renderer?.gl;
  const unwrapDraws = renderer?.gl ? wrapDrawCalls(renderer.gl, () => { drawsThisFrame += 1; }) : undefined;
  const onLose = (): void => { contextLost += 1; };
  renderer?.on?.(LOSE_WEBGL_EVENT, onLose);

  let observer: PerformanceObserver | undefined;
  try {
    if (typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
      observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks += 1;
          if (entry.duration > longTaskMax) longTaskMax = entry.duration;
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
    }
  } catch { observer = undefined; /* optional probe */ }

  const div = document.createElement('div');
  div.dataset['perfDiag'] = '1';
  div.style.cssText =
    'position:fixed;top:2px;right:2px;z-index:99999;pointer-events:none;white-space:pre-wrap;' +
    'max-width:calc(100% - 4px);box-sizing:border-box;overflow-wrap:anywhere;' +
    'font:11px monospace;color:#7CFC00;background:rgba(0,0,0,.6);padding:2px 6px;text-align:right';
  document.body.appendChild(div);

  const readout = (): void => {
    const display = syncDisplay();
    const values = displayRing.values();
    const stats = frameStats(values);
    const res = textureResidency(game.textures);
    const facts = deviceFacts();
    const age = displayLastRender === undefined ? null : Math.max(0, performance.now() - displayLastRender);
    const recent = age !== null && age <= 1_000;
    const elapsed = values.reduce((sum, value) => sum + value, 0);
    const cadence = elapsed > 0 ? values.length * 1_000 / elapsed : 0;
    const screen = useApp.getState().screen;
    if (display.active && display.scene && (readPreparation?.(display.scene).state ?? 'ready') === 'ready'
      && !baselines.has(display.scene)) baselines.set(display.scene, res);
    const baseline = display.scene ? baselines.get(display.scene) : undefined;
    const prep = (['base', 'battle'] as const).flatMap(scene => preparationReadout(scene, readPreparation?.(scene)));
    const viewport = readGameViewportDiagnostics();
    const round = (value: number): number => Math.round(value);
    const rect = viewport.root;
    const visual = viewport.visual;
    const formatBox = (box: typeof rect): string => box ? `${round(box.x)},${round(box.y)} ${round(box.width)}×${round(box.height)}` : 'n/a';
    div.textContent = [
      display.active ? `Phaser loop ${screen}/${display.scene ? readPreparation?.(display.scene).state ?? 'ready' : 'covered'} · ${recent && values.length ? `${cadence.toFixed(0)} fps · p95 ${stats.p95.toFixed(0)} · p99 ${stats.p99.toFixed(0)}ms` : 'waiting for frame samples'}`
        : `Phaser inactive · ${screen}${screen === 'map' ? ' (globe measured separately)' : ''}`,
      `last ≤${PERF_DIAG.frameRingSize} gaps · visit max ${displayMax.toFixed(0)}ms · frame age ${age === null ? 'n/a' : `${Math.round(age)}ms`}`,
      `Phaser/page ${PERF_DIAG.summaryWindowMs / 1_000}s window: draws ${(windowDraws / Math.max(1, windowFrames)).toFixed(0)}/${windowDrawsMax} · long tasks ${longTasks}`,
      `manager tex ${res.count} · ${(res.bytes / MIB).toFixed(1)} MiB (RGBA estimate)`,
      baseline ? `${display.scene} first-ready baseline ${baseline.count} / ${(baseline.bytes / MIB).toFixed(1)} MiB · Δ ${res.count - baseline.count} / ${((res.bytes - baseline.bytes) / MIB).toFixed(1)} MiB` : 'texture baseline waits for visible ready scene',
      `${facts.heapMiB !== undefined ? `heap ${facts.heapMiB} MiB · ` : ''}${contextLost ? `GL LOST ×${contextLost} · ` : ''}${webgl ? 'WebGL' : 'canvas2d'}`,
      `frame ${rect ? `${round(rect.x)},${round(rect.y)} ${round(rect.width)}×${round(rect.height)}` : 'n/a'} · dvh ${viewport.dynamicHeight === null ? 'n/a' : round(viewport.dynamicHeight)} · inner ${viewport.inner.width}×${viewport.inner.height}`,
      `lvh ${viewport.largeHeight === null ? 'n/a' : round(viewport.largeHeight)} · controls ${round(viewport.uiHeight)} · bottom clearance ${round(viewport.bottomClearance)}`,
      `screen extent ${viewport.screenExtent === null ? 'n/a' : round(viewport.screenExtent)} · safe bottom ${round(viewport.safeBottom)}`,
      `container ${formatBox(viewport.canvasContainer)} · canvas ${formatBox(viewport.canvas)}`,
      `scale ${round(game.scale.width)}×${round(game.scale.height)} · parent cache ${game.scale.parentSize ? `${round(game.scale.parentSize.width)}×${round(game.scale.parentSize.height)}` : 'n/a'}`,
      `scroll ${round(viewport.scroll.x)},${round(viewport.scroll.y)} · visual ${visual ? `${round(visual.offsetLeft)},${round(visual.offsetTop)} ${round(visual.width)}×${round(visual.height)} @${visual.scale.toFixed(2)}` : 'n/a'} · text focus ${viewport.editableFocused ? 'yes' : 'no'}`,
      ...prep,
      ...(prep.length ? ['load includes cache/await time; compose/submit are CPU totals', 'GPU completion and wall duration not measured'] : []),
    ].join('\n');
  };
  const readoutTimer = window.setInterval(readout, 1_000);

  const emit = (): void => {
    const stats = frameStats(ring.values());
    const res = textureResidency(game.textures);
    const facts = deviceFacts();
    const frames = Math.max(1, windowFrames);
    const summary = boundSummary({
      seq,
      windowMs: PERF_DIAG.summaryWindowMs,
      fps: Math.round(timing.fps(limited ? 0 : game.loop.actualFps, limited) * 10) / 10,
      frames: windowFrames,
      p50: Math.round(stats.p50 * 10) / 10,
      p95: Math.round(stats.p95 * 10) / 10,
      p99: Math.round(stats.p99 * 10) / 10,
      maxDt: Math.round(windowMaxDt),
      stalls: windowStalls,
      longTasks,
      longTaskMax: Math.round(longTaskMax),
      textures: res.count,
      textureMiB: Math.round(res.bytes / MIB),
      drawsAvg: Math.round(windowDraws / frames),
      drawsMax: windowDrawsMax,
      contextLost,
      webgl,
      baseFrames,
      battleFrames,
      otherFrames,
      hiddenFrames,
      canvasW: game.scale.width,
      canvasH: game.scale.height,
      dpr: facts.dpr,
      ...(facts.deviceMemoryGb !== undefined ? { deviceMemoryGb: facts.deviceMemoryGb } : {}),
      ...(facts.cores !== undefined ? { cores: facts.cores } : {}),
      ...(facts.heapMiB !== undefined ? { heapMiB: facts.heapMiB } : {}),
    });
    seq += 1;
    windowFrames = 0;
    windowStalls = 0;
    windowMaxDt = 0;
    windowDraws = 0;
    windowDrawsMax = 0;
    longTasks = 0;
    longTaskMax = 0;
    baseFrames = 0;
    battleFrames = 0;
    otherFrames = 0;
    hiddenFrames = 0;
    ring.clear();
    timing.clearWindow();
    if (summariesSent >= PERF_DIAG.maxSummariesPerSession) return;
    summariesSent += 1;
    track(EVENTS.PERF_SUMMARY, summary);
  };
  const summaryTimer = window.setInterval(emit, PERF_DIAG.summaryWindowMs);

  return () => {
    window.clearInterval(readoutTimer);
    window.clearInterval(summaryTimer);
    game.events.off(STEP_EVENT, onStep);
    game.events.off(POST_RENDER_EVENT, onPostRender);
    game.events.off(PAUSE_EVENT, onPause);
    unsubscribeScreen();
    renderer?.off?.(LOSE_WEBGL_EVENT, onLose);
    unwrapDraws?.();
    observer?.disconnect();
    div.remove();
  };
}
