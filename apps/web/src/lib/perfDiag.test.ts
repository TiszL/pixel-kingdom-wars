/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Phaser from 'phaser';
import { PERF_DIAG } from '@shardkeep/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../state/store';
import type { SceneVisualProgress } from './events';

const track = vi.fn();
vi.mock('./analytics', async (orig) => ({ ...(await orig<typeof import('./analytics')>()), track: (...args: unknown[]) => track(...args) }));

import {
  FrameRing, LOSE_WEBGL_EVENT, MAX_SUMMARY_PROPS, PAUSE_EVENT, POST_RENDER_EVENT, STEP_EVENT, boundSummary, frameStats,
  mountPerfDiag, percentile, resetPerfDiagSessionForTests, textureResidency,
} from './perfDiag';
import {
  PERF_DIAG_KEY, perfDiagEnabled, resolvePerfDiagFromUrl, setPerfDiagEnabled, subscribePerfDiag,
} from './perfDiagFlag';

// ---------------------------------------------------------------------------
// A minimal Phaser.Game stand-in: an event bus, a WebGL-looking renderer with
// the four draw entry points Phaser 4.1 calls, a texture list with sources.
// ---------------------------------------------------------------------------
class Bus {
  private handlers = new Map<string, Set<(...a: never[]) => void>>();
  on(e: string, cb: (...a: never[]) => void): this {
    if (!this.handlers.has(e)) this.handlers.set(e, new Set());
    this.handlers.get(e)!.add(cb);
    return this;
  }
  off(e: string, cb: (...a: never[]) => void): this { this.handlers.get(e)?.delete(cb); return this; }
  emit(e: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(e) ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
  count(e: string): number { return this.handlers.get(e)?.size ?? 0; }
}

function fakeGame(opts: { webgl?: boolean; limited?: boolean } = {}) {
  let baseActive = true;
  const gl = {
    drawElements: vi.fn(),
    drawArrays: vi.fn(),
    drawArraysInstanced: vi.fn(),
    drawElementsInstanced: vi.fn(),
  };
  const originals = { ...gl };
  const renderer = Object.assign(new Bus(), opts.webgl === false ? {} : { gl });
  const textures = {
    list: {
      __DEFAULT: { source: [{ width: 32, height: 32 }] },
      bld: { source: [{ width: 4096, height: 4096 }] },
      trp: { source: [{ width: 2048, height: 1024 }] },
    } as Record<string, { source: { width: number; height: number }[] }>,
    get(key: string) { return this.list[key]; },
  };
  const game = {
    events: new Bus(),
    renderer,
    textures,
    loop: { actualFps: opts.limited ? 120 : 58.4, rawDelta: 0, hasFpsLimit: !!opts.limited },
    scale: { width: 1280, height: 720 },
    scene: {
      isActive: (key: string) => key === 'base' ? baseActive : key === 'battle' && !baseActive,
      isVisible: (key: string) => key === 'base' ? baseActive : key === 'battle' && !baseActive,
    },
  };
  return {
    game: game as unknown as Phaser.Game, gl, originals, bus: game.events, renderer,
    setRawDelta: (dt: number) => { game.loop.rawDelta = dt; },
    setBaseActive: (active: boolean) => { baseActive = active; },
  };
}

const expectedBytes = (32 * 32 + 4096 * 4096 + 2048 * 1024) * 4;

describe('percentile math', () => {
  // Nearest-rank on a known series: these are the p95/p99 gates every later
  // perf cut is accepted on; a percentile that drifts makes the gate meaningless.
  const series = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

  it('is nearest-rank on an ascending series', () => {
    expect(percentile(series, 50)).toBe(50);
    expect(percentile(series, 95)).toBe(95);
    expect(percentile(series, 99)).toBe(99);
    expect(percentile(series, 100)).toBe(100);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBe(0);
  });

  it('frameStats sorts numerically, not lexically, and ignores insertion order', () => {
    const deltas = [16, 17, 16, 250, 16, 9, 16, 100, 16, 16];
    const stats = frameStats(deltas);
    // sorted: 9,16,16,16,16,16,16,17,100,250 → ranks 5, 10, 10
    expect(stats).toEqual({ p50: 16, p95: 250, p99: 250 });
    const fs = frameStats([5, 40, 300, 7]);
    expect(fs.p50).toBe(7);
    expect(fs.p99).toBe(300);
  });

  it('the ring keeps only the newest frameRingSize deltas', () => {
    const ring = new FrameRing(3);
    expect(ring.values()).toHaveLength(0);
    ring.push(1); ring.push(2);
    expect([...ring.values()]).toEqual([1, 2]);
    ring.push(3); ring.push(4);
    expect([...ring.values()]).toEqual([2, 3, 4]);
    expect(ring.size).toBe(3);
    ring.clear();
    expect(ring.size).toBe(0);
    expect([...ring.values()]).toEqual([]);
  });
});

describe('summary shape', () => {
  it('keeps numbers and booleans only and never exceeds the sink cap', () => {
    const big: Record<string, number | boolean> = {};
    for (let i = 0; i < 40; i++) big[`k${i}`] = i;
    expect(Object.keys(boundSummary(big))).toHaveLength(MAX_SUMMARY_PROPS);
    const dirty = { ok: 1, flag: true, nan: Number.NaN, inf: Number.POSITIVE_INFINITY,
      str: 'wallet' as unknown as number };
    expect(boundSummary(dirty)).toEqual({ ok: 1, flag: true });
  });

  it('texture residency sums the same RGBA bytes the atlas budget uses', () => {
    const { game } = fakeGame();
    expect(textureResidency(game.textures)).toEqual({ bytes: expectedBytes, count: 3 });
  });

  it('pins the string event names to the Phaser constants', () => {
    // The exports map blocks subpath imports; read the constant sources instead.
    const phaserSrc = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'node_modules', 'phaser', 'src');
    const constant = (rel: string): string | undefined => readFileSync(join(phaserSrc, rel), 'utf8')
      .match(/module\.exports = '([a-z]+)'/)?.[1];
    expect(constant('core/events/STEP_EVENT.js')).toBe(STEP_EVENT);
    expect(constant('core/events/POST_RENDER_EVENT.js')).toBe(POST_RENDER_EVENT);
    expect(constant('core/events/PAUSE_EVENT.js')).toBe(PAUSE_EVENT);
    expect(constant('renderer/events/LOSE_WEBGL_EVENT.js')).toBe(LOSE_WEBGL_EVENT);
  });
});

describe('mountPerfDiag', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    track.mockClear();
    resetPerfDiagSessionForTests();
    useApp.setState({ screen: 'base' });
  });
  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('samples rawDelta rather than Phaser\'s smoothed STEP callback delta', () => {
    const { game, bus, setRawDelta } = fakeGame();
    const dispose = mountPerfDiag(game);
    setRawDelta(Number.NaN);
    bus.emit(STEP_EVENT, 0, 100);
    bus.emit(POST_RENDER_EVENT);
    setRawDelta(Number.POSITIVE_INFINITY);
    bus.emit(STEP_EVENT, 0, 100);
    bus.emit(POST_RENDER_EVENT);
    setRawDelta(-1);
    bus.emit(STEP_EVENT, 0, 100);
    bus.emit(POST_RENDER_EVENT);
    setRawDelta(80);
    bus.emit(STEP_EVENT, 0, 16);
    bus.emit(POST_RENDER_EVENT);
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs);
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      frames: 1, p50: 80, p95: 80, p99: 80, maxDt: 80, stalls: 1,
    });
    dispose();
  });

  it('reports accepted STEP cadence on a 120 Hz panel when rendering is limited to 60', () => {
    const { game, bus, setRawDelta } = fakeGame({ limited: true });
    const dispose = mountPerfDiag(game);
    setRawDelta(1000 / 120); // Phaser's rAF-facing counters still say 120 Hz
    for (const time of [0, 1000 / 60, 2000 / 60]) {
      bus.emit(STEP_EVENT, time, 1000 / 60);
      bus.emit(POST_RENDER_EVENT);
    }

    vi.advanceTimersByTime(1_000);
    expect(document.querySelector<HTMLElement>('[data-perf-diag]')?.textContent)
      .toMatch(/^Phaser loop base\/ready · 60 fps · p95 17 · p99 17ms/);
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs - 1_000);
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      fps: 60, frames: 2, p50: 16.7, p95: 16.7, p99: 16.7,
    });
    dispose();
  });

  it('drops the hidden pause gap before sampling limited-mode frames again', () => {
    const { game, bus, setRawDelta } = fakeGame({ limited: true });
    const dispose = mountPerfDiag(game);
    setRawDelta(1000 / 120);
    bus.emit(STEP_EVENT, 0);
    bus.emit(POST_RENDER_EVENT);
    bus.emit(STEP_EVENT, 1000 / 60);
    bus.emit(POST_RENDER_EVENT);
    bus.emit(PAUSE_EVENT);
    bus.emit(STEP_EVENT, 60_000); // RESUME has not fired yet: this is the new baseline
    bus.emit(POST_RENDER_EVENT);
    bus.emit(STEP_EVENT, 60_000 + 1000 / 60);
    bus.emit(POST_RENDER_EVENT);

    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs);
    expect(track.mock.calls[0]?.[1]).toMatchObject({
      fps: 60, frames: 2, p50: 16.7, p95: 16.7, maxDt: 17, stalls: 0,
    });
    dispose();
  });

  it('emits ONE bounded perf_summary per window with the frames it saw', () => {
    const { game, gl, bus, renderer, setRawDelta, setBaseActive } = fakeGame();
    const dispose = mountPerfDiag(game);
    expect(document.querySelector('[data-perf-diag]')).not.toBeNull();

    // STEP's callback delta is smoothed, but rawDelta exposes the real stall.
    useApp.setState({ screen: 'base' });
    setRawDelta(80);
    bus.emit(STEP_EVENT, 0, 16);
    gl.drawElements(); gl.drawArrays();
    bus.emit(POST_RENDER_EVENT);
    // Build and layout leave the base scene active and are base-context work.
    useApp.setState({ screen: 'build' });
    bus.emit(STEP_EVENT, 0, 16);
    bus.emit(POST_RENDER_EVENT);
    useApp.setState({ screen: 'layout' });
    bus.emit(STEP_EVENT, 0, 16);
    bus.emit(POST_RENDER_EVENT);
    useApp.setState({ screen: 'battle' });
    setBaseActive(false);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    setRawDelta(80);
    bus.emit(STEP_EVENT, 0, 16);
    gl.drawArrays();
    bus.emit(POST_RENDER_EVENT);
    renderer.emit(LOSE_WEBGL_EVENT);

    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs - 1);
    expect(track).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(track).toHaveBeenCalledTimes(1);

    const [event, props] = track.mock.calls[0] as [string, Record<string, number | boolean>];
    expect(event).toBe('perf_summary');
    expect(Object.keys(props).length).toBeLessThanOrEqual(MAX_SUMMARY_PROPS);
    for (const v of Object.values(props)) expect(['number', 'boolean']).toContain(typeof v);
    expect(props).toMatchObject({
      seq: 0, frames: 4, p50: 80, p95: 80, p99: 80, stalls: 4, maxDt: 80,
      drawsMax: 2, drawsAvg: 1, contextLost: 1, webgl: true,
      baseFrames: 3, battleFrames: 1, otherFrames: 0, hiddenFrames: 1,
      textures: 3, textureMiB: Math.round(expectedBytes / 1048576),
      canvasW: 1280, canvasH: 720, windowMs: PERF_DIAG.summaryWindowMs,
    });

    // Ring and context counters reset; the next summary contains only its own sample.
    useApp.setState({ screen: 'map' });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    setRawDelta(7);
    bus.emit(STEP_EVENT, 0, 500);
    bus.emit(POST_RENDER_EVENT);
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs);
    expect(track).toHaveBeenCalledTimes(2);
    expect(track.mock.calls[1]?.[1]).toMatchObject({
      seq: 1, frames: 1, p50: 7, p95: 7, p99: 7, maxDt: 7, stalls: 0,
      baseFrames: 0, battleFrames: 0, otherFrames: 1, hiddenFrames: 0,
      contextLost: 1,
    });

    dispose();
  });

  it('caps summaries per page session even across a remount', () => {
    const { game } = fakeGame();
    let dispose = mountPerfDiag(game);
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs * (PERF_DIAG.maxSummariesPerSession - 1));
    expect(track).toHaveBeenCalledTimes(PERF_DIAG.maxSummariesPerSession - 1);
    dispose();
    dispose = mountPerfDiag(game);
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs * 5);
    expect(track).toHaveBeenCalledTimes(PERF_DIAG.maxSummariesPerSession);
    dispose();
  });

  it('dispose restores the GL draw functions, unhooks the game and removes the readout', () => {
    const { game, gl, originals, bus, renderer } = fakeGame();
    const dispose = mountPerfDiag(game);
    expect(gl.drawElements).not.toBe(originals.drawElements);
    expect(bus.count(STEP_EVENT)).toBe(1);
    expect(bus.count(POST_RENDER_EVENT)).toBe(1);
    expect(bus.count(PAUSE_EVENT)).toBe(1);
    expect(renderer.count(LOSE_WEBGL_EVENT)).toBe(1);
    dispose();
    expect(gl.drawElements).toBe(originals.drawElements);
    expect(gl.drawArrays).toBe(originals.drawArrays);
    expect(gl.drawArraysInstanced).toBe(originals.drawArraysInstanced);
    expect(gl.drawElementsInstanced).toBe(originals.drawElementsInstanced);
    expect(bus.count(STEP_EVENT)).toBe(0);
    expect(bus.count(POST_RENDER_EVENT)).toBe(0);
    expect(bus.count(PAUSE_EVENT)).toBe(0);
    expect(renderer.count(LOSE_WEBGL_EVENT)).toBe(0);
    expect(document.querySelector('[data-perf-diag]')).toBeNull();
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs * 2);
    expect(track).not.toHaveBeenCalled();
  });

  it('skips draw counting on a Canvas renderer and still reports', () => {
    const { game } = fakeGame({ webgl: false });
    const dispose = mountPerfDiag(game);
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs);
    expect(track.mock.calls[0]?.[1]).toMatchObject({ webgl: false, drawsMax: 0 });
    dispose();
  });

  it('shows retained successful preparation after the loading cover is gone without adding telemetry', () => {
    const { game } = fakeGame();
    const progress: SceneVisualProgress = { scene: 'base', phase: 'ready', completed: 0, total: 0,
      timings: { downloadMs: 101, verifyMs: 7, decodeMs: 22, paintMs: 130, uploadMs: 19,
        maxPaintBatchMs: 5, width: 3136, height: 3136, cacheHit: true } };
    const dispose = mountPerfDiag(game, scene => scene === 'base'
      ? { state: 'ready', progress } : { state: 'loading' });
    vi.advanceTimersByTime(1_000);
    const text = document.querySelector('[data-perf-diag]')?.textContent;
    expect(text).toContain('base prep ready/ready · source cache hit (load timings reused)');
    expect(text).toContain('download 101ms · verify 7ms · decode+readback 22ms');
    expect(text).toContain('compose CPU 130ms · submit CPU 19ms · batch max 5ms');
    expect(text).toContain('raster 3136×3136');
    expect(text).toContain('GPU completion and wall duration not measured');
    expect(track).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs - 1_000);
    expect(track).toHaveBeenCalledTimes(1);
    expect(Object.keys(track.mock.calls[0]?.[1] as object).some(key => /prep|download|paint|upload/i.test(key))).toBe(false);
    dispose();
  });

  it('shows the visible frame origin locally without transmitting viewport or input contents', () => {
    const { game } = fakeGame();
    const root = document.createElement('div');
    root.id = 'root';
    document.body.appendChild(root);
    vi.spyOn(root, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: -140, width: 390, height: 700, top: -140, bottom: 560,
      left: 0, right: 390, toJSON: () => ({}),
    });
    const input = document.createElement('input');
    input.value = 'private-owner-search';
    root.appendChild(input);
    input.focus();
    const dispose = mountPerfDiag(game);
    vi.advanceTimersByTime(1_000);
    const readout = document.querySelector('[data-perf-diag]')?.textContent;
    expect(readout).toContain('frame 0,-140 390×700');
    expect(readout).toContain('text focus yes');
    expect(readout).not.toContain(input.value);
    expect(track).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PERF_DIAG.summaryWindowMs - 1_000);
    expect(track).toHaveBeenCalledTimes(1);
    expect(Object.keys(track.mock.calls[0]?.[1] as object).some(key => /viewport|scroll|focus|visual|origin/i.test(key))).toBe(false);
    dispose();
  });

  it('does not label sleeping Phaser samples as globe FPS and resets the next visible scene window', () => {
    const { game, bus, setRawDelta, setBaseActive } = fakeGame();
    const dispose = mountPerfDiag(game);
    const frame = (time: number, dt: number): void => {
      setRawDelta(dt); bus.emit(STEP_EVENT, time); bus.emit(POST_RENDER_EVENT);
    };
    frame(0, 80); frame(80, 80);
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector('[data-perf-diag]')?.textContent).toContain('p95 80');
    useApp.setState({ screen: 'map' }); setBaseActive(false);
    frame(90, 7); frame(97, 7);
    vi.advanceTimersByTime(1_000);
    const covered = document.querySelector('[data-perf-diag]')?.textContent ?? '';
    expect(covered).toContain('Phaser inactive · map (globe measured separately)');
    expect(covered).not.toContain(' fps');
    expect(covered).toContain('visit max 0ms');
    useApp.setState({ screen: 'scout' });
    frame(120, 900); // crossing the old scene never becomes a scout interval
    frame(136, 16); frame(152, 16);
    vi.advanceTimersByTime(1_000);
    const scout = document.querySelector('[data-perf-diag]')?.textContent;
    expect(scout).toContain('Phaser loop scout/ready · 63 fps · p95 16');
    expect(scout).toContain('visit max 16ms');
    dispose();
  });

  it('resets preparation windows on readiness and does not report an unfinished or stale render as fresh FPS', () => {
    const { game, bus, renderer, setRawDelta } = fakeGame();
    let state: 'loading' | 'ready' = 'loading';
    const dispose = mountPerfDiag(game, () => ({ state }));
    const frame = (time: number, dt: number): void => {
      setRawDelta(dt); bus.emit(STEP_EVENT, time); bus.emit(POST_RENDER_EVENT);
    };
    frame(0, 70); frame(70, 70);
    state = 'ready'; frame(100, 500); frame(116, 16);
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector('[data-perf-diag]')?.textContent).toContain('visit max 16ms');
    setRawDelta(999); bus.emit(STEP_EVENT, 999); // no POST_RENDER
    vi.advanceTimersByTime(1_000);
    const stalled = document.querySelector('[data-perf-diag]')?.textContent;
    expect(stalled).toContain('waiting for frame samples');
    expect(stalled).toContain('frame age 2000ms');
    expect(stalled).not.toContain('visit max 999ms');
    Object.assign(renderer, { contextLost: true }); frame(1_100, 100);
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector('[data-perf-diag]')?.textContent).toContain('Phaser inactive · base');
    Object.assign(renderer, { contextLost: false }); frame(1_200, 100); frame(1_216, 16);
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector('[data-perf-diag]')?.textContent).toContain('visit max 16ms');
    dispose();
  });

  it('keeps a first-ready manager baseline so returning from scout reveals retained textures', () => {
    const { game, setBaseActive } = fakeGame();
    const dispose = mountPerfDiag(game);
    vi.advanceTimersByTime(1_000);
    const list = game.textures.list as unknown as Record<string, { source: { width: number; height: number }[] }>;
    list['battle-ground-fixture'] = { source: [{ width: 512, height: 512 }] };
    useApp.setState({ screen: 'scout' }); setBaseActive(false);
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector('[data-perf-diag]')?.textContent).toContain('battle first-ready baseline 4');
    useApp.setState({ screen: 'base' }); setBaseActive(true);
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector('[data-perf-diag]')?.textContent).toContain('base first-ready baseline 3 / 72.0 MiB · Δ 1 / 1.0 MiB');
    delete list['battle-ground-fixture'];
    vi.advanceTimersByTime(1_000);
    expect(document.querySelector('[data-perf-diag]')?.textContent).toContain('base first-ready baseline 3 / 72.0 MiB · Δ 0 / 0.0 MiB');
    dispose();
  });
});

describe('flag', () => {
  beforeEach(() => localStorage.removeItem(PERF_DIAG_KEY));

  it('is off by default, ?diag=1 persists and ?diag=0 clears', () => {
    expect(perfDiagEnabled()).toBe(false);
    expect(resolvePerfDiagFromUrl('')).toBe(false);
    expect(resolvePerfDiagFromUrl('?diag=1&client=solana-mobile')).toBe(true);
    expect(perfDiagEnabled()).toBe(true);
    expect(resolvePerfDiagFromUrl('?client=solana-mobile')).toBe(true); // persisted
    expect(resolvePerfDiagFromUrl('?diag=0')).toBe(false);
    expect(perfDiagEnabled()).toBe(false);
  });

  it('the Settings toggle notifies the mounted game', () => {
    const seen: boolean[] = [];
    const unsub = subscribePerfDiag((on) => seen.push(on));
    setPerfDiagEnabled(true);
    setPerfDiagEnabled(false);
    unsub();
    setPerfDiagEnabled(true);
    expect(seen).toEqual([true, false]);
    localStorage.removeItem(PERF_DIAG_KEY);
  });
});

describe('lazy boundary', () => {
  // The whole point of opt-in diagnostics is that a normal session never
  // carries the measurement code or its per-frame hooks. Only the flag module
  // may be statically imported; perfDiag itself is reached by dynamic import.
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('PhaserGame reaches perfDiag only through a dynamic import gated on the flag', () => {
    const src = read('../game/PhaserGame.tsx');
    expect(src).not.toMatch(/import\s+[^;]*from\s+'\.\.\/lib\/perfDiag'/);
    expect(src).toContain("import('../lib/perfDiag')");
    expect(src).toContain('resolvePerfDiagFromUrl(location.search)');
    expect(src).toContain('subscribePerfDiag(applyDiag)');
  });

  it('nothing else imports perfDiag statically', () => {
    for (const rel of ['../ui/screens/menu.tsx', '../App.tsx', '../ui/Overlay.tsx', './analytics.ts']) {
      expect(read(rel)).not.toMatch(/from\s+'[^']*\/perfDiag'/);
    }
    const menu = read('../ui/screens/menu.tsx');
    expect(menu).toContain('<span>DIAGNOSTICS</span>');
    expect(menu).toContain('setPerfDiagEnabled(next)');
  });
});
