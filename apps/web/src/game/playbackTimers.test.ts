import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import type Phaser from 'phaser';
import { describe, expect, it, vi } from 'vitest';
import { flushRetiredPlaybackTimers, retirePlaybackTimers } from './playbackTimers';

// Load the installed Clock itself, without the browser-only Phaser barrel.
const require = createRequire(import.meta.url);
type Clock = Phaser.Time.Clock & {
  shutdown(): void;
  _active: Phaser.Time.TimerEvent[];
  _pendingInsertion: Phaser.Time.TimerEvent[];
  _pendingRemoval: Phaser.Time.TimerEvent[];
};
const InstalledClock = require(resolve(dirname(require.resolve('phaser')), '../src/time/Clock.js')) as new (scene: unknown) => Clock;
function clock(): Clock {
  return new InstalledClock({ sys: { events: { on() {}, once() {}, off() {} } } });
}

describe('owned playback timer retirement', () => {
  it('replaces a large journal without one active-array search per expired event', async () => {
    const c = clock();
    const old = Array.from({ length: 12_000 }, () => c.delayedCall(90_000, vi.fn()));
    c.preUpdate();
    const searches = vi.spyOn(c._active, 'indexOf');
    retirePlaybackTimers(c, old);
    await Promise.resolve();
    c.update(16, 16);
    c.preUpdate();
    // WHY: Phaser's indexOf + splice for each expired old timer caused a real
    // one-to-two-second render stall after the worker had already completed.
    expect(searches.mock.calls.length).toBe(0);
    expect(c._active).toHaveLength(0);
    expect(c._pendingRemoval).toHaveLength(0);
  });

  it('preserves other effects and the replacement schedule, even when cancelled inside a callback', async () => {
    const c = clock(), fired: string[] = [];
    let old!: Phaser.Time.TimerEvent;
    c.delayedCall(1, () => {
      fired.push('effect-before');
      retirePlaybackTimers(c, [old]);
      c.delayedCall(10, () => fired.push('replacement'));
    });
    old = c.delayedCall(50, () => fired.push('obsolete'));
    c.delayedCall(1, () => fired.push('effect-after'));
    c.preUpdate();
    c.update(1, 1);
    expect(fired).toEqual(['effect-before', 'effect-after']);
    await Promise.resolve();
    c.preUpdate();
    c.timeScale = 2;
    c.update(6, 5);
    expect(fired).toEqual(['effect-before', 'effect-after', 'replacement']);
  });

  it('flushes a synchronous verdict boundary and destroys overlapping queue membership only once', async () => {
    const c = clock(), fired: string[] = [];
    const old = c.delayedCall(1, () => fired.push('old'));
    const destroy = vi.spyOn(old, 'destroy');
    c.preUpdate(); c.update(1, 1); // now both active and pending removal
    const fresh = c.delayedCall(2, () => fired.push('new'));
    retirePlaybackTimers(c, [old, old]);
    flushRetiredPlaybackTimers(c); // manual Clock seek cannot await a microtask
    c.preUpdate(); c.update(3, 2);
    expect(fired).toEqual(['old', 'new']);
    expect(destroy).toHaveBeenCalledOnce();
    expect(c._active).toContain(fresh);
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('keeps scene ownership separate and safely follows shutdown before its microtask', async () => {
    const a = clock(), b = clock();
    const timerA = a.delayedCall(1, vi.fn()), timerB = b.delayedCall(1, vi.fn());
    retirePlaybackTimers(a, [timerA]);
    a.shutdown();
    const restarted = a.delayedCall(2, vi.fn());
    await Promise.resolve();
    expect(a._active).toEqual([]);
    expect(a._pendingInsertion).toEqual([restarted]);
    expect(b._pendingInsertion).toEqual([timerB]);
  });
});
