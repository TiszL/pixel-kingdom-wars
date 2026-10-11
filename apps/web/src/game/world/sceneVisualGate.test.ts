import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../../lib/events';
import { SceneVisualGate } from './sceneVisualGate';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(inputEnabled = true) {
  const scene = { cameras: { main: { visible: true } }, input: { enabled: inputEnabled }, events: new EventEmitter() };
  const retry = vi.fn();
  const gate = new SceneVisualGate(scene as never, 'base', retry);
  return { scene, retry, gate };
}

describe('atomic scene presentation', () => {
  it('reports unknown-length byte activity without per-frame React updates or premature download failure', () => {
    vi.useFakeTimers();
    const emit = vi.spyOn(bus, 'emit'), { gate, scene } = fixture();
    try {
      for (let tick = 0; tick < 60; tick++) {
        gate.update({ state: 'loading', phase: 'download', completed: tick + 1, total: 0, loadAttempt: 1 }, true);
        vi.advanceTimersByTime(16);
      }
      const updates = emit.mock.calls.filter(([name]) => name === 'scene:visualProgress');
      expect(updates.length).toBeLessThanOrEqual(4);
      expect(updates.at(-1)?.[1]).toMatchObject({ phase: 'download', total: 0 });
      vi.advanceTimersByTime(60_000);
      expect(scene.cameras.main.visible).toBe(false);
      expect(emit).not.toHaveBeenCalledWith('scene:visual', { scene: 'base', state: 'failed' });
      gate.update({ state: 'failed', phase: 'download', completed: 60, total: 0,
        loadAttempt: 3, loadReason: 'idle-timeout', loadActiveMs: 60_960 }, true);
      expect(emit.mock.calls.at(-2)).toEqual(['scene:visualProgress', expect.objectContaining({ completed: 60,
        timings: { loadAttempt: 3, loadReason: 'idle-timeout', loadActiveMs: 60_960 } })]);
      expect(emit).toHaveBeenLastCalledWith('scene:visual', { scene: 'base', state: 'failed' });
      // A late completion cannot silently resume a failed battle underneath its cover.
      gate.update({ state: 'ready' }, false); expect(scene.cameras.main.visible).toBe(false);
      bus.emit('scene:visualRetry', { scene: 'base' }); gate.update({ state: 'ready' }, false);
      expect(scene.cameras.main.visible).toBe(true);
    } finally { gate.destroy(); }
  });

  it('attributes a failed later wall edit to walls after an initially ready scene', () => {
    const emit = vi.spyOn(bus, 'emit'), { gate } = fixture();
    try {
      gate.update({ state: 'ready' }, false);
      emit.mockClear();
      gate.update({ state: 'ready' }, false, 'upload failed');
      expect(emit.mock.calls).toEqual([
        ['scene:visualProgress', expect.objectContaining({ phase: 'walls' })],
        ['scene:visual', { scene: 'base', state: 'failed' }],
      ]);
    } finally { gate.destroy(); }
  });

  it('lets the transfer loader own its deadline and reports sampled progress without per-frame UI churn', () => {
    vi.useFakeTimers();
    const emit = vi.spyOn(bus, 'emit'), { gate, scene } = fixture();
    try {
      gate.update({ state: 'loading', phase: 'download' }, true);
      vi.advanceTimersByTime(25_000);
      expect(emit).not.toHaveBeenCalledWith('scene:visual', { scene: 'base', state: 'failed' });
      gate.update({ state: 'loading', phase: 'terrain', completed: 8, total: 1000, downloadMs: 24_800 }, true);
      const progressCalls = () => emit.mock.calls.filter(([name]) => name === 'scene:visualProgress');
      const before = progressCalls().length;
      for (let frame = 0; frame < 60; frame++) gate.update({ state: 'loading', phase: 'terrain', completed: 8, total: 1000 }, true);
      expect(progressCalls()).toHaveLength(before);
      vi.advanceTimersByTime(19_000);
      gate.update({ state: 'loading', phase: 'terrain', completed: 16, total: 1000 }, true);
      vi.advanceTimersByTime(19_000);
      expect(scene.cameras.main.visible).toBe(false);
      expect(emit).not.toHaveBeenCalledWith('scene:visual', { scene: 'base', state: 'failed' });
      gate.update({ state: 'ready', cacheHit: true, paintMs: 48.9 }, true);
      expect(emit).toHaveBeenLastCalledWith('scene:visualProgress', expect.objectContaining({ phase: 'walls', timings: { cacheHit: true, paintMs: 49 } }));
      gate.update({ state: 'ready' }, false);
      expect(scene.cameras.main.visible).toBe(true);
    } finally { gate.destroy(); }
  });

  it('bounds repeated useful progress by active time, excluding background suspension', () => {
    vi.useFakeTimers();
    const emit = vi.spyOn(bus, 'emit'), { gate, scene } = fixture();
    try {
      for (let row = 1; row <= 6; row++) {
        gate.update({ state: 'loading', phase: 'terrain', completed: row, total: 100 }, true);
        vi.advanceTimersByTime(15_000);
      }
      scene.events.emit('sleep'); vi.advanceTimersByTime(600_000); scene.events.emit('wake');
      expect(emit).not.toHaveBeenCalledWith('scene:visual', { scene: 'base', state: 'failed' });
      gate.update({ state: 'loading', phase: 'terrain', completed: 7, total: 100 }, true);
      vi.advanceTimersByTime(15_000);
      gate.update({ state: 'loading', phase: 'terrain', completed: 8, total: 100 }, true);
      vi.advanceTimersByTime(15_000);
      expect(emit).toHaveBeenLastCalledWith('scene:visual', { scene: 'base', state: 'failed' });
    } finally { gate.destroy(); }
  });

  it('cleans loading state when Phaser destroys plugins before the scene without a shutdown', async () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', page);
    const remove = vi.spyOn(page, 'removeEventListener');
    const events = new EventEmitter(), shutdown = vi.fn(), retry = vi.fn();
    const scene = { cameras: { main: { visible: true } as { visible: boolean } | null },
      input: { enabled: true } as { enabled: boolean } | null,
      time: { paused: false } as { paused: boolean } | null,
      tweens: { paused: false } as { paused: boolean } | null, events };
    events.on('shutdown', shutdown);
    // Core scene plugins subscribe at boot, before scene-owned controllers.
    events.once('destroy', () => { scene.cameras.main = null; scene.input = null; scene.time = null; scene.tweens = null; });
    const gate = new SceneVisualGate(scene as never, 'battle', retry);
    const pending = gate.ready();
    const NativeSystems = createRequire(import.meta.url)(fileURLToPath(new URL(
      '../../../node_modules/phaser/src/scene/Systems.js', import.meta.url,
    ))) as { prototype: { destroy: (this: unknown) => void } };
    expect(() => NativeSystems.prototype.destroy.call({ events, settings: {} })).not.toThrow();
    await pending;
    expect(shutdown).not.toHaveBeenCalled();
    expect(events.eventNames()).toEqual([]);
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    bus.emit('scene:visualRetry', { scene: 'battle' });
    expect(retry).not.toHaveBeenCalled();
    expect(() => gate.destroy()).not.toThrow();
  });

  it('cancels an active gesture before covering a published scene, without submitting a release', () => {
    const scene = { cameras: { main: { visible: true } }, input: { enabled: true }, events: new EventEmitter() };
    const cancel = vi.fn(() => expect(scene.input.enabled).toBe(true));
    const gate = new SceneVisualGate(scene as never, 'base', () => {}, cancel);
    try {
      expect(cancel).not.toHaveBeenCalled();
      gate.update({ state: 'ready' }, false);
      gate.loading(); gate.loading();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(scene.input.enabled).toBe(false);
    } finally { gate.destroy(); }
  });

  it('pauses only Battle presentation clocks while wall updates can continue, then releases waiting playback', async () => {
    const scene = { cameras: { main: { visible: true } }, input: { enabled: true },
      time: { paused: false }, tweens: { paused: false }, events: new EventEmitter() };
    const gate = new SceneVisualGate(scene as never, 'battle', () => {});
    const started = vi.fn();
    const pending = gate.ready().then(started);
    try {
      expect(scene.time.paused).toBe(true); expect(scene.tweens.paused).toBe(true);
      gate.update({ state: 'ready' }, true);
      await Promise.resolve(); expect(started).not.toHaveBeenCalled();
      gate.update({ state: 'ready' }, false);
      await pending;
      expect(scene.time.paused).toBe(false); expect(scene.tweens.paused).toBe(false);
      expect(started).toHaveBeenCalledTimes(1);
      gate.loading();
      expect(scene.cameras.main.visible).toBe(false);
      expect(scene.time.paused).toBe(true);
    } finally { gate.destroy(); }
    expect(scene.time.paused).toBe(false); expect(scene.tweens.paused).toBe(false);
  });

  it('never exposes plain ground or initial wall posts while either asynchronous stage is unfinished', () => {
    const emit = vi.spyOn(bus, 'emit');
    const { scene, gate } = fixture();
    try {
      expect(scene.cameras.main.visible).toBe(false);
      expect(scene.input.enabled).toBe(false);
      gate.update(undefined, false);
      gate.update({ state: 'loading' }, false);
      gate.update({ state: 'ready' }, true);
      expect(scene.cameras.main.visible).toBe(false);
      expect(emit).not.toHaveBeenCalledWith('scene:visual', { scene: 'base', state: 'ready' });
      gate.update({ state: 'ready' }, false);
      expect(scene.cameras.main.visible).toBe(true);
      expect(scene.input.enabled).toBe(true);
      gate.update({ state: 'ready' }, true); // a later edit retains its previous complete walls
      expect(scene.cameras.main.visible).toBe(true);
    } finally { gate.destroy(); }
  });

  it('waits for the authoritative base instead of publishing a completed historical default too early', () => {
    const { scene, gate } = fixture();
    try {
      gate.update({ state: 'ready' }, false, '', false);
      expect(scene.cameras.main.visible).toBe(false);
      gate.update({ state: 'loading' }, true, '', true);
      expect(scene.cameras.main.visible).toBe(false);
      gate.update({ state: 'ready' }, false, '', true);
      expect(scene.cameras.main.visible).toBe(true);
      gate.update({ state: 'loading' }, false); // a changed defender/theme hides synchronously on update
      expect(scene.cameras.main.visible).toBe(false);
    } finally { gate.destroy(); }
  });

  it('shows failure instead of legacy fallback and supports a scene-scoped retry', () => {
    const emit = vi.spyOn(bus, 'emit');
    const { scene, gate, retry } = fixture();
    try {
      gate.update({ state: 'failed' }, false);
      expect(emit).toHaveBeenLastCalledWith('scene:visual', { scene: 'base', state: 'failed' });
      expect(scene.cameras.main.visible).toBe(false);
      bus.emit('scene:visualRetry', { scene: 'battle' });
      expect(retry).not.toHaveBeenCalled();
      bus.emit('scene:visualRetry', { scene: 'base' });
      expect(retry).toHaveBeenCalledTimes(1);
      gate.update({ state: 'ready' }, false, 'upload failed');
      expect(scene.cameras.main.visible).toBe(false);
      expect(emit).toHaveBeenCalledWith('scene:visualProgress', expect.objectContaining({ phase: 'walls' }));
      bus.emit('scene:visualRetry', { scene: 'base' });
      gate.update({ state: 'ready' }, false);
      expect(scene.cameras.main.visible).toBe(true);
    } finally { gate.destroy(); }
  });

  it('bounds a stalled renderer independently, pauses while asleep and removes every listener on shutdown', () => {
    vi.useFakeTimers();
    const emit = vi.spyOn(bus, 'emit');
    const { scene, gate, retry } = fixture();
    scene.events.emit('sleep');
    vi.advanceTimersByTime(60_000);
    expect(emit).not.toHaveBeenCalledWith('scene:visual', { scene: 'base', state: 'failed' });
    scene.events.emit('wake');
    vi.advanceTimersByTime(20_000);
    expect(emit).toHaveBeenLastCalledWith('scene:visual', { scene: 'base', state: 'failed' });
    gate.destroy(); gate.destroy();
    expect(scene.events.eventNames()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    bus.emit('scene:visualRetry', { scene: 'base' });
    expect(retry).not.toHaveBeenCalled();
  });

  it('preserves an independently disabled input manager after readiness', () => {
    const { scene, gate } = fixture(false);
    try { gate.update({ state: 'ready' }, false); expect(scene.input.enabled).toBe(false); }
    finally { gate.destroy(); }
  });

  it('does not expire while the browser pauses a hidden tab', () => {
    vi.useFakeTimers();
    const page = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('document', page);
    const remove = vi.spyOn(page, 'removeEventListener');
    const emit = vi.spyOn(bus, 'emit');
    const { gate } = fixture();
    page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(60_000);
    expect(emit).not.toHaveBeenCalledWith('scene:visual', { scene: 'base', state: 'failed' });
    page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(19_999);
    expect(emit).not.toHaveBeenCalledWith('scene:visual', { scene: 'base', state: 'failed' });
    gate.destroy();
    expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
  });
});
