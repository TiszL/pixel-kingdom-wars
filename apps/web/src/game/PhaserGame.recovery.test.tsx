/** @vitest-environment happy-dom */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApp } from '../state/store';
import { bus } from '../lib/events';

const reports = vi.hoisted(() => ({ captureError: vi.fn() }));
vi.mock('../lib/analytics', () => reports);
vi.mock('./scenes/BaseScene', () => ({ BaseScene: class {} }));
vi.mock('./scenes/BattleScene', () => ({ BattleScene: class {} }));
vi.mock('./scenes/BootScene', () => ({ BootScene: class {} }));
vi.mock('phaser', () => ({ default: {
  AUTO: 0, Scale: { RESIZE: 0 },
  Core: { Events: { READY: 'ready', STEP: 'step', POST_RENDER: 'postrender', PAUSE: 'pause', RESUME: 'resume' } },
  Game: class {
    events = new EventEmitter();
    canvas = document.createElement('canvas');
    isRunning = false;
    isPaused = false;
    pendingDestroy = false;
    renderer = { contextLost: false };
    loop = { actualFps: 58, rawDelta: 16 };
    scene = { isActive: () => true, isVisible: () => true, isSleeping: () => false, sleep: () => undefined };
    scale = {};
    constructor(readonly config: { parent: HTMLElement; audio: { noAudio: boolean } }) {
      config.parent.append(this.canvas);
      Object.defineProperties(this.canvas, { clientWidth: { value: 390 }, clientHeight: { value: 844 } });
    }
    destroy(): void { this.pendingDestroy = true; }
  },
} }));

import { PhaserGame } from './PhaserGame';

type FakeGame = { canvas: HTMLCanvasElement; renderer: { contextLost: boolean }; scene: { isActive: () => boolean; isVisible: () => boolean }; events: EventEmitter; isPaused: boolean; pendingDestroy: boolean; config: { audio: { noAudio: boolean } } };
const game = (): FakeGame => (window as unknown as { __game: FakeGame }).__game;

describe('React-owned renderer recovery', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    useApp.setState({ screen: 'base' });
    reports.captureError.mockReset();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  });
  async function advance(ms: number): Promise<void> {
    await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  }
  async function mount(): Promise<void> {
    await act(async () => root.render(<PhaserGame />));
    game().events.emit('ready');
    await advance(1_000);
  }

  it.each(['scout', 'battle'] as const)('keeps the covered home asleep until %s has entered and wakes it only on return', async screen => {
    await mount();
    const existing = game();
    let homeSleeping = false, battleActive = false;
    const scene = {
      isActive: (name: string) => name === 'base' ? !homeSleeping : battleActive,
      isVisible: () => true,
      isSleeping: (name: string) => name === 'base' && homeSleeping,
      sleep: vi.fn(() => { homeSleeping = true; }),
      wake: vi.fn(() => { homeSleeping = false; }),
      run: vi.fn<(payload: unknown) => void>(() => { battleActive = true; }),
    };
    Object.assign(existing, { scene });
    // Exercise the mounted PhaserGame's real Zustand subscriber and event bus.
    // This adapter represents BaseScene's retained handlers while it sleeps;
    // no engine render/mock callback can conceal an unnecessary home refresh.
    const offEnter = bus.on('battle:enter', payload => {
      if (scene.isActive('base')) scene.sleep();
      scene.run(payload);
    });
    const offExit = bus.on('battle:exit', () => { battleActive = false; scene.wake(); });
    const snapshot = { keepLevel: 20, buildings: [] };
    try {
      await act(async () => useApp.getState().setScreen('map'));
      expect(scene.sleep).toHaveBeenCalledTimes(1);
      expect(homeSleeping).toBe(true);
      await act(async () => useApp.getState().setScreen(screen));
      // Before the async snapshot arrives, waking the home would run its full
      // renderFromStore only to destroy its patrol and sleep again immediately.
      expect(scene.wake).not.toHaveBeenCalled();
      expect(homeSleeping).toBe(true);
      await act(async () => bus.emit('battle:enter', { snapshot, scout: screen === 'scout' }));
      expect(scene.run).toHaveBeenCalledExactlyOnceWith({ snapshot, scout: screen === 'scout' });
      expect(scene.sleep).toHaveBeenCalledTimes(1);
      expect(homeSleeping).toBe(true);
      expect(useApp.getState().screen).toBe(screen);
      await act(async () => useApp.getState().setScreen('base'));
      expect(battleActive).toBe(false);
      expect(homeSleeping).toBe(false);
      expect(scene.wake).toHaveBeenCalledTimes(1);
      expect(game()).toBe(existing);
    } finally { offEnter(); offExit(); }
  });

  it('wakes the home for each home-canvas route and preserves a genuine wake failure', async () => {
    await mount();
    let sleeping = false;
    const wake = vi.fn(() => { sleeping = false; });
    Object.assign(game(), { scene: {
      isActive: (name: string) => name === 'base' && !sleeping,
      isVisible: () => true, isSleeping: () => sleeping,
      sleep: () => { sleeping = true; }, wake,
    } });
    for (const screen of ['base', 'build', 'layout'] as const) {
      await act(async () => useApp.getState().setScreen('map'));
      expect(sleeping).toBe(true);
      await act(async () => useApp.getState().setScreen(screen));
      expect(sleeping).toBe(false);
    }
    expect(wake).toHaveBeenCalledTimes(3);
    await act(async () => useApp.getState().setScreen('map'));
    const failure = new Error('Home refresh failed');
    wake.mockImplementationOnce(() => { throw failure; });
    await act(async () => {
      expect(() => useApp.getState().setScreen('base')).toThrow(failure);
    });
  });

  it('reconciles cached Phaser parent bounds on READY, without waiting for a physical rotation', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<PhaserGame />));
    await advance(1_500); // initial ResizeObserver/settle can finish before async engine boot
    const existing = game();
    const parent = existing.canvas.parentElement!;
    const metrics = { width: 390, height: 844 };
    Object.defineProperties(parent, {
      clientWidth: { get: () => metrics.width }, clientHeight: { get: () => metrics.height },
    });
    vi.spyOn(parent, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect(metrics));
    const require = createRequire(import.meta.url);
    const source = readFileSync(join(dirname(require.resolve('phaser/package.json')), 'src/scale/ScaleManager.js'), 'utf8');
    const method = source.match(/getParentBounds: function \(\)\n    \{[\s\S]*?\n    \},/)?.[0];
    expect(method).toBeDefined();
    const native = runInNewContext(`({${method}})`) as { getParentBounds: (this: unknown) => boolean };
    const cached = { width: 390, height: 700, setSize(w: number, h: number) { this.width = w; this.height = h; } };
    const rendered = { ...cached };
    vi.spyOn(existing.canvas, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect(rendered));
    const scale = {
      canvas: existing.canvas, parent, parentSize: cached, canvasBounds: { x: 0, y: 0 }, width: 390, height: 700,
      getParentBounds: vi.fn(() => native.getParentBounds.call(scale)),
      updateBounds: vi.fn(),
      // Phaser4 refresh consumes cached parentSize; it does NOT measure DOM.
      refresh: vi.fn(() => { Object.assign(scale, cached); Object.assign(rendered, cached); }),
    };
    Object.assign(existing, { scale });
    existing.events.emit('ready');
    await advance(1_300);
    expect(scale.getParentBounds).toHaveBeenCalled();
    expect(scale.height).toBe(844);
    expect(rendered.height).toBe(844);
    expect(game()).toBe(existing);
    metrics.height = 760;
    window.dispatchEvent(new Event('pkw:game-viewport'));
    await advance(1_300);
    expect(scale.height).toBe(760);
    const reads = scale.getParentBounds.mock.calls.length;
    await act(async () => root.render(<></>));
    window.dispatchEvent(new Event('pkw:game-viewport'));
    await advance(1_300);
    expect(scale.getParentBounds).toHaveBeenCalledTimes(reads);
  });

  it('repairs stale canvas display bounds even when the logical scale already matches the frame', async () => {
    vi.useFakeTimers();
    await act(async () => root.render(<PhaserGame />));
    const existing = game();
    const parent = existing.canvas.parentElement!;
    Object.defineProperties(parent, { clientWidth: { value: 390 }, clientHeight: { value: 844 } });
    vi.spyOn(parent, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ width: 390, height: 844 }));
    let renderedHeight = 700;
    vi.spyOn(existing.canvas, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ width: 390, height: renderedHeight }));
    const refresh = vi.fn(() => { renderedHeight = 844; });
    Object.assign(existing, { scale: {
      canvas: existing.canvas, parent, width: 390, height: 844,
      getParentBounds: vi.fn(() => false), updateBounds: vi.fn(), refresh,
    } });
    existing.events.emit('ready');
    await advance(1_300);
    expect(renderedHeight).toBe(844);
    expect(refresh).toHaveBeenCalledTimes(1);
    renderedHeight = 760;
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    expect(renderedHeight).toBe(844);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('updates pointer bounds after an origin-only viewport correction without recreating the game', async () => {
    await mount();
    const existing = game();
    let top = -140;
    vi.spyOn(existing.canvas, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ x: 0, y: top, width: 390, height: 844 }));
    const bounds = { y: -140 };
    const updateBounds = vi.fn(() => { bounds.y = existing.canvas.getBoundingClientRect().top; });
    Object.assign(existing, { scale: {
      canvas: existing.canvas, parent: existing.canvas.parentElement, width: 390, height: 844,
      updateBounds, refresh: vi.fn(),
    } });
    top = 0;
    window.dispatchEvent(new Event('pkw:game-viewport'));
    expect(updateBounds).toHaveBeenCalledTimes(1);
    expect(bounds.y).toBe(0);
    expect(game()).toBe(existing);
    expect(existing.pendingDestroy).toBe(false);
    await act(async () => root.render(<></>));
    window.dispatchEvent(new Event('pkw:game-viewport'));
    expect(updateBounds).toHaveBeenCalledTimes(1);
  });

  it('labels the legacy FPS readout as Phaser and suppresses its numbers under the globe', async () => {
    const previousUrl = location.href;
    history.replaceState(null, '', '?fps=1');
    try {
      await mount();
      const output = document.querySelector('[data-fps-diag]');
      expect(output?.textContent).toContain('Phaser loop base · 58.0 fps');
      await act(async () => useApp.setState({ screen: 'map' }));
      await advance(250);
      expect(output?.textContent).toBe('Phaser inactive · map (globe measured separately)');
      await act(async () => useApp.setState({ screen: 'base' }));
      await advance(250);
      expect(output?.textContent).toContain('Phaser loop base · 58.0 fps');
    } finally { history.replaceState(null, '', previousUrl); }
  });

  it('boots with the installed silent Phaser manager when the audio device cannot open', async () => {
    const audioDevice = vi.fn(function () { throw new DOMException('Device unavailable', 'InvalidStateError'); });
    vi.stubGlobal('AudioContext', audioDevice);
    await mount();
    const require = createRequire(import.meta.url);
    const phaserRoot = dirname(require.resolve('phaser/package.json'));
    const factory = require(join(phaserRoot, 'src/sound/SoundManagerCreator.js')) as {
      create: (config: unknown) => { locked: boolean; sounds: unknown[] };
    };
    // Exercise the installed engine's real choice with the mounted game's
    // config; a second WebAudio manager would try the unavailable device.
    const manager = factory.create({ ...game(), device: { audio: { webAudio: true, audioData: true } } });
    expect(manager.locked).toBe(false);
    expect(manager.sounds).toEqual([]);
    game().events.emit('focus');
    game().events.emit('visible');
    expect(audioDevice).not.toHaveBeenCalled();
    game().events.emit('postrender');
    expect(reports.captureError).not.toHaveBeenCalled();
  });

  it('uses completed frames rather than successful update steps, and never reloads automatically', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    await mount();
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    await advance(1_000);
    game().events.emit('postrender');
    await advance(4_999);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    game().events.emit('step'); // a throwing renderer never reaches postrender
    await advance(1);
    expect(host.textContent).toContain('Game paused');
    expect(reports.captureError).toHaveBeenCalledTimes(1);
    expect(reports.captureError).toHaveBeenCalledWith('error', expect.objectContaining({ diagnostics: expect.objectContaining({
      renderState: 'loop-stopped', contextState: 'available', activeScene: 'base', sceneState: 'ready',
      sceneActive: true, sceneVisible: true, stepAgeMs: 1, renderAgeMs: 5_000,
    }) }));
    await advance(30_000);
    expect(reload).not.toHaveBeenCalled();
    expect(reports.captureError).toHaveBeenCalledTimes(1);
    await act(async () => host.querySelector('button')!.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('keeps healthy completed rendering alive while an intentionally paused, hidden or covered canvas gets a fresh grace', async () => {
    await mount();
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    for (let i = 0; i < 4; i++) { await advance(4_000); game().events.emit('postrender'); }
    game().isPaused = true; game().events.emit('pause');
    await advance(20_000);
    game().isPaused = false; game().events.emit('resume');
    await advance(4_000);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(20_000);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    await advance(4_000);
    await act(async () => useApp.getState().setScreen('shop'));
    await advance(20_000);
    await act(async () => useApp.getState().setScreen('base'));
    await advance(4_000);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(reports.captureError).not.toHaveBeenCalled();
  });

  it('gives a BFCache return time to render without requiring focus or visibility events', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    await mount();
    const existing = game();
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    await advance(1_000);
    existing.events.emit('postrender');
    window.dispatchEvent(new Event('pagehide'));
    // A delayed timer may run before pageshow while document.visibilityState
    // already says visible. No engine pause/focus event is required by BFCache.
    await advance(60_000);
    window.dispatchEvent(new Event('pageshow'));
    await advance(4_000);
    expect(reports.captureError).not.toHaveBeenCalled();
    existing.events.emit('step'); existing.events.emit('postrender');
    await advance(4_000);
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(game()).toBe(existing);
    expect(reload).not.toHaveBeenCalled();
    // Restoration grace is bounded: an actually stranded loop still reports.
    await advance(1_000);
    expect(reports.captureError).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Game paused');
  });

  it('does not announce startup or disposal as a rendering failure', async () => {
    await act(async () => root.render(<PhaserGame />));
    await advance(30_000);
    expect(reports.captureError).not.toHaveBeenCalled();
    game().events.emit('ready');
    game().pendingDestroy = true;
    await advance(30_000);
    expect(reports.captureError).not.toHaveBeenCalled();
  });

  it('offers manual artwork recovery on loading without navigating, recreating the game or changing progress', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    useApp.setState({ screen: 'loading', booted: false });
    await mount();
    const original = game();
    const state = useApp.getState();
    await act(async () => bus.emit('boot:failed', { files: ['hero@2x.json'] }));
    expect(host.textContent).toContain('Couldn’t load your kingdom');
    await advance(30_000);
    expect(useApp.getState()).toBe(state);
    expect(game()).toBe(original);
    expect(reload).not.toHaveBeenCalled();
    expect(host.querySelector('button')?.textContent).toContain('TRY AGAIN');
    await act(async () => host.querySelector('button')!.click());
    expect(reload).toHaveBeenCalledTimes(1);
    expect(useApp.getState()).toBe(state);
  });

  it('retains the original interruption when the final loader retry fails immediately, without request URLs', async () => {
    await mount();
    await act(async () => bus.emit('boot:failed', { files: ['bld@1x.png'], diagnostics: {
      profile: 'constrained', rounds: [{ attempt: 1, reason: 'idle-timeout', activeMs: 20_001.5,
        budgetMs: 35_000, queued: 0, inflight: 1, processing: 0,
        files: [{ key: 'bld-img', kind: 'image', phase: 'loading', state: 12, status: 200,
          loadedBytes: 500_000, totalBytes: 1_479_433 }],
      }, { attempt: 2, reason: 'complete', activeMs: 7,
        budgetMs: 35_000, queued: 0, inflight: 1, processing: 0,
        files: [{ key: 'bld-img', kind: 'image', phase: 'loading', state: 12, status: 200,
          loadedBytes: 500_000, totalBytes: 1_479_433 }],
      }],
    } }));
    expect(reports.captureError).toHaveBeenCalledWith('error', expect.objectContaining({
      name: 'BootAssetLoadError', diagnostics: {
        workerState: 'none', loadProfile: 'constrained', loadReason: 'complete', loadAttempt: 2,
        loadFirstReason: 'idle-timeout', loadFirstActiveMs: 20_002, loadFirstLoadedBytes: 500_000,
        loadActiveMs: 7, loadBudgetMs: 35_000, loadQueued: 0, loadInflight: 1, loadProcessing: 0,
        loadFailures: 'bld-img:image:loading:12:200:500000/1479433',
      },
    }));
  });


  it('reports actual context loss despite continuing Phaser steps and post-render callbacks, then requires a restored frame', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => undefined);
    await mount();
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    game().events.emit('postrender');
    await act(async () => {
      game().renderer.contextLost = true;
      game().canvas.dispatchEvent(new Event('webglcontextlost'));
    });
    expect(host.textContent).toContain('Game paused');
    expect(reports.captureError).toHaveBeenCalledWith('error', expect.objectContaining({ name: 'WebGLContextLost',
      diagnostics: expect.objectContaining({ contextState: 'lost', renderState: 'context-lost', renderAgeMs: 0 }) }));
    for (let i = 0; i < 8; i++) { game().events.emit('step'); game().events.emit('postrender'); await advance(1_000); }
    expect(reports.captureError).toHaveBeenCalledTimes(1);
    expect(host.textContent).toContain('Game paused');
    await act(async () => {
      game().renderer.contextLost = false;
      game().canvas.dispatchEvent(new Event('webglcontextrestored'));
    });
    expect(host.textContent).toContain('Game paused');
    await act(async () => game().events.emit('postrender'));
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    await advance(6_000);
    expect(reports.captureError).toHaveBeenCalledWith('error', expect.objectContaining({ name: 'RendererStopped',
      diagnostics: expect.objectContaining({ contextState: 'restored', renderState: 'loop-stopped' }) }));
  });

  it('keeps a renderer-rejected restoration in context recovery without latching a false stopped loop', async () => {
    await mount();
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    const require = createRequire(import.meta.url);
    const phaserRoot = dirname(require.resolve('phaser/package.json'));
    // Execute only the installed engine method: loading the complete renderer
    // also initializes unrelated Canvas2D feature probes in this DOM fixture.
    const source = readFileSync(join(phaserRoot, 'src/renderer/webgl/WebGLRenderer.js'), 'utf8');
    const method = source.match(/dispatchContextRestored: function \(event\)\n    \{[\s\S]*?\n    \},/)?.[0];
    expect(method).toBeDefined();
    const native = runInNewContext(`({${method}})`, { console: { log: vi.fn() } }) as {
      dispatchContextRestored: (this: unknown, event: Event) => void;
    };
    await act(async () => {
      game().renderer.contextLost = true;
      game().canvas.dispatchEvent(new Event('webglcontextlost'));
      // The installed engine explicitly rejects this event when WebGL still
      // reports a lost context; its later Core.POST_RENDER is not an image.
      const restored = new Event('webglcontextrestored');
      native.dispatchContextRestored.call({ ...game().renderer,
        gl: { isContextLost: () => true } }, restored);
      game().canvas.dispatchEvent(restored);
    });
    for (let i = 0; i < 8; i++) { game().events.emit('step'); game().events.emit('postrender'); await advance(1_000); }
    expect(reports.captureError).toHaveBeenCalledTimes(1);
    expect(reports.captureError).not.toHaveBeenCalledWith('error', expect.objectContaining({ name: 'RendererStopped' }));
    expect(host.textContent).toContain('Game paused');
    await act(async () => {
      game().renderer.contextLost = false;
      game().canvas.dispatchEvent(new Event('webglcontextrestored'));
      game().events.emit('postrender');
    });
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    for (let i = 0; i < 3; i++) { await advance(4_000); game().events.emit('postrender'); }
    expect(host.querySelector('[role="alertdialog"]')).toBeNull();
    expect(reports.captureError).toHaveBeenCalledTimes(1);
  });

  it('does not call an inactive or intentionally hidden scene a stopped loop', async () => {
    await mount();
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    game().scene.isActive = () => false;
    await advance(20_000);
    game().scene.isActive = () => true; game().scene.isVisible = () => false;
    await advance(20_000);
    expect(reports.captureError).not.toHaveBeenCalled();
  });

  it('shows a percentage only for known download totals and retains bounded retry diagnostics', async () => {
    await mount();
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'download', completed: 2048, total: 4096 }));
    expect(host.textContent).toContain('50%');
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('50');
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'download', completed: 2048, total: 0,
      timings: { loadReason: 'idle-timeout', loadAttempt: 3, loadActiveMs: 61_200, downloadMs: 61_200 } }));
    expect(host.textContent).not.toContain('%');
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'failed' }));
    expect(host.textContent).toContain('Please try again.');
    expect(reports.captureError).toHaveBeenCalledWith('error', expect.objectContaining({ name: 'ScenePreparationFailed',
      diagnostics: expect.objectContaining({ prepCompleted: 2048, prepTotal: 0, prepLoadAttempt: 3,
        prepLoadReason: 'idle-timeout', prepLoadActiveMs: 61_200, prepDownloadMs: 61_200 }) }));
  });

  it('keeps local rendering indeterminate while preserving its exact failure diagnostics', async () => {
    await mount();
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'terrain', completed: 64, total: 256,
      timings: { cacheHit: false, downloadMs: 123.4, verifyMs: 12, width: 1536, height: 1536, maxPaintBatchMs: 7.8 } }));
    expect(host.textContent).toContain('Opening your kingdom');
    expect(host.textContent).not.toContain('64 / 256');
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'failed' }));
    expect(reports.captureError).toHaveBeenCalledWith('error', expect.objectContaining({ name: 'ScenePreparationFailed',
      diagnostics: { activeScene: 'base', sceneState: 'failed', prepPhase: 'terrain', prepCompleted: 64, prepTotal: 256,
        prepCacheHit: false, prepDownloadMs: 123, prepVerifyMs: 12, prepWidth: 1536, prepHeight: 1536, prepMaxPaintBatchMs: 8 } }));
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'loading' }));
    expect(host.textContent).not.toContain('64 / 256');
    expect(host.textContent).toContain('Opening your kingdom');
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'download', completed: 0, total: 0 }));
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
  });

  it('removes context and progress observers on unmount', async () => {
    await mount(); const original = game();
    await act(async () => root.render(null));
    original.canvas.dispatchEvent(new Event('webglcontextlost'));
    bus.emit('scene:visualProgress', { scene: 'base', phase: 'ready', completed: 1, total: 1 });
    expect(reports.captureError).not.toHaveBeenCalled();
    expect(original.events.listenerCount('step')).toBe(0);
    expect(original.events.listenerCount('postrender')).toBe(0);
  });

  it('covers the scene until its pixels publish and retries visual failures without recreating the game', async () => {
    await mount();
    const original = game();
    const retry = vi.fn();
    const off = bus.on('scene:visualRetry', retry);
    try {
      expect(host.textContent).toContain('Opening your kingdom');
      await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
      expect(host.textContent).not.toContain('Opening your kingdom');
      await act(async () => useApp.getState().setScreen('scout'));
      await act(async () => bus.emit('battle:enter', { snapshot: { buildings: [] }, scout: true }));
      expect(host.textContent).toContain('Opening the base');
      await act(async () => bus.emit('scene:visual', { scene: 'battle', state: 'failed' }));
      expect(host.textContent).toContain('Couldn’t open the battlefield');
      await act(async () => host.querySelector('button')!.click());
      expect(retry).toHaveBeenCalledWith({ scene: 'battle' });
      expect(game()).toBe(original);
      await act(async () => bus.emit('scene:visual', { scene: 'battle', state: 'ready' }));
      expect(host.querySelector('[role="status"]')).toBeNull();
    } finally { off(); }
  });

  it('keeps the bright loading wallpaper behind the base-opening card after the loading screen hands off', async () => {
    // WHY: a returning player spends the base-art download here, right after
    // Overlay's LoadingScreen unmounts. A bare dark shell made the loading
    // screen visibly drop from the bright wallpaper to a flat fill (owner
    // 2026-09-24: loading was too dark).
    await mount();
    const shell = host.querySelector('.sk-game-loading-shell')!;
    expect(shell.textContent).toContain('Opening your kingdom');
    expect(shell.querySelector('img')?.getAttribute('src')).toMatch(/\/brand\/brand_loading_bg_(?:portrait|landscape)\.png/);
    expect(shell.querySelector('[data-brand-state]')?.getAttribute('style')).toMatch(/filter: brightness\(0?\.9\)/);
    // The strip's dock is positioned so it paints above the fixed wallpaper.
    const css = readFileSync(join(dirname(new URL(import.meta.url).pathname), '../ui/loading/gameLoading.css'), 'utf8');
    expect(css).toMatch(/\.sk-loading-dock\{[^}]*position:absolute;[^}]*z-index:2/);
    expect(shell.querySelector('.sk-loading-dock > .sk-game-loading')).not.toBeNull();
  });

  it('leaves rejected raid/revenge request recovery reachable before a battle snapshot exists', async () => {
    await mount();
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    await act(async () => useApp.getState().setScreen('battle'));
    // A rejected /raids request never emits battle:enter. The mask used to
    // cover RaidUI's server error and BACK TO BASE forever in exactly this state.
    expect(host.querySelector('[role="status"]')).toBeNull();
    await act(async () => bus.emit('battle:enter', { snapshot: { buildings: [] } }));
    expect(host.textContent).toContain('Entering battle');
    await act(async () => bus.emit('scene:visual', { scene: 'battle', state: 'failed' }));
    expect(host.textContent).toContain('Couldn’t open the battlefield');
    await act(async () => {
      bus.emit('battle:exit', undefined);
      useApp.getState().setScreen('base');
      useApp.getState().setScreen('battle');
    });
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('[role="status"]')).toBeNull();
  });
 it('keeps one measured meter while a streamed ground verifies, decodes and uploads each page', async () => {
    // WHY: owner 2026-09-27 "web during loading still has flickering or dizzying
    // on loading box". The layered ground reports download -> verify -> decode ->
    // upload for every page. Treating each page step as "not a download" flipped
    // the meter between a bar and a sweep, and toggled its Downloading line,
    // 14-52 times per load in a SwiftShader capture of a real base.
    await mount();
    const bar = (): Element => host.querySelector('[role="progressbar"]')!;
    const total = 402_669;
    const shown: Array<string | null> = [];
    for (const [phase, completed] of [['download', 0], ['verify', 0], ['download', 98_799], ['decode', 0], ['upload', 0],
      ['download', 254_614], ['decode', 0], ['upload', 0], ['decode', 0], ['upload', 0]] as const) {
      await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase, completed, total: phase === 'download' ? total : 0 }));
      expect(bar().hasAttribute('data-indeterminate')).toBe(false);
      expect(host.textContent).toMatch(/Downloading · \d+%/);
      shown.push(bar().getAttribute('aria-valuenow'));
    }
    expect(shown).toEqual(['0', '0', '24', '24', '24', '63', '63', '63', '63', '63']);
    // Wall preparation after the transfer is local work again: one change back.
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'walls', completed: 0, total: 0 }));
    expect(bar().getAttribute('data-indeterminate')).toBe('true');
    expect(host.textContent).not.toContain('Downloading');
    // A new preparation never inherits the previous transfer's percentage.
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'loading' }));
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'decode', completed: 0, total: 0 }));
    expect(bar().getAttribute('data-indeterminate')).toBe('true');
 });

 it('covers scene preparation with the loading screen’s own strip, tip inside, version label outside', async () => {
    // WHY: owner 2026-09-27. LoadingScreen hands off to this cover mid-load; a
    // tipless, re-centred card here made the box jump ~58 px on a phone and the
    // tip vanish at the handoff. Both surfaces render the shared LoadingStage,
    // and since D-193 the tip lives inside the strip, so the cover must carry
    // it there too or the handoff would drop the sprite and the tip line.
    await mount();
    const shell = host.querySelector('.sk-game-loading-shell')!;
    const tip = shell.querySelector('[data-testid="loading-tip"]');
    const strip = shell.querySelector('.sk-game-loading');
    expect(tip).not.toBeNull();
    expect(strip!.contains(tip)).toBe(true);
    expect(strip!.getAttribute('data-tips')).toBe('true');
    const label = shell.querySelector('.sk-loading-version');
    expect(label?.textContent).toMatch(/^PIXEL KINGDOM WARS v/);
    expect(strip!.contains(label)).toBe(false);
 });

 it('keeps a completed transfer covered until scene readiness and does not call cached work a download', async () => {
    await mount();
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'download', completed: 4096, total: 4096 }));
    expect(host.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe('100');
    expect(host.textContent).toContain('Downloading · 100%');
    expect(host.textContent).toContain('Opening your kingdom');
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'verify', completed: 0, total: 0 }));
    expect(host.querySelector('.sk-game-loading')).not.toBeNull();
    expect(host.textContent).not.toContain('Downloading');
    await act(async () => bus.emit('scene:visualProgress', { scene: 'base', phase: 'download', completed: 4096, total: 4096, timings: { cacheHit: true } }));
    expect(host.querySelector('[role="progressbar"]')?.hasAttribute('aria-valuenow')).toBe(false);
    expect(host.textContent).not.toContain('Downloading');
    await act(async () => bus.emit('scene:visual', { scene: 'base', state: 'ready' }));
    expect(host.querySelector('.sk-game-loading')).toBeNull();
 });

});
