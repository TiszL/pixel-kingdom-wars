import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import type Phaser from 'phaser';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the installed engine, not a duplicate limiter implementation. The
// browser uses its ESM bundle; the final test pins that bundle to this same fix.
const require = createRequire(import.meta.url);
const phaserRoot = dirname(require.resolve('phaser/package.json'));
const TimeStep = require(join(phaserRoot, 'src/core/TimeStep.js')) as typeof Phaser.Core.TimeStep;
const PERIOD = 1000 / 60;

function harness(smoothStep: boolean, limit = 60) {
  const loop = new TimeStep({} as Phaser.Game, { limit, smoothStep });
  const frames: { time: number; delta: number }[] = [];
  Object.assign(loop, {
    lastTime: 0,
    deltaHistory: Array.from({ length: loop.deltaSmoothingMax }, () => 1000 / 120),
    callback: (time: number, delta: number) => frames.push({ time, delta }),
  });
  let acceptedMs = 0;
  const originalSmooth = loop.smoothDelta.bind(loop);
  vi.spyOn(loop, 'smoothDelta').mockImplementation((delta) => {
    const smoothed = originalSmooth(delta);
    acceptedMs += smoothed;
    return smoothed;
  });
  let wallMs = 0;
  return {
    loop,
    frames,
    advance(delta: number): void {
      wallMs += delta;
      if (!smoothStep) acceptedMs += delta;
      if (limit > 0) loop.stepLimitFPS(wallMs);
      else loop.step(wallMs);
    },
    accepted: () => acceptedMs,
    wall: () => wallMs,
    delivered: () => frames.reduce((sum, frame) => sum + frame.delta, 0),
  };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('Phaser frame limiting conserves elapsed time rather than speeding up raids', () => {
  for (const hz of [30, 60, 90, 120, 144]) {
    for (const smoothing of [false, true]) {
      it(`keeps every millisecond exactly once at ${hz} Hz, smoothing=${smoothing}`, () => {
        const h = harness(smoothing);
        for (let frame = 0; frame < hz * 10; frame++) {
          // Fractional jitter forces nonzero remainders, including on 60 Hz.
          h.advance(1000 / hz + (frame % 2 === 0 ? 0.7 : -0.7));
          expect(h.delivered() + h.loop.delta).toBeCloseTo(h.accepted(), 7);
          expect(h.loop.delta).toBeGreaterThanOrEqual(0);
          expect(h.loop.delta).toBeLessThan(PERIOD);
        }
        // Above the cap, retaining the remainder preserves ~60 frames/second.
        // At exactly 60 Hz, unsmoothed jitter may miss an existing threshold;
        // the separate schedule test pins that unchanged engine behavior.
        // Clearing the remainder would avoid drift but render 90 Hz at 45.
        if (hz > 60) expect(h.frames.length).toBeGreaterThanOrEqual(595);
        expect(h.frames.length).toBeLessThanOrEqual(Math.min(hz, 60) * 10 + 5);
      });
    }
  }

  it('retains exactly the same callback scheduling under irregular input', () => {
    const h = harness(false);
    const expectedTimes: number[] = [];
    let pendingMs = 0;
    let previousAt = 0;
    for (let frame = 0; frame < 1000; frame++) {
      h.advance([7, 9, 11, 8, 14, 33, 5][frame % 7]!);
      pendingMs += h.wall() - previousAt;
      previousAt = h.wall();
      if (pendingMs >= PERIOD) {
        expectedTimes.push(h.wall());
        pendingMs %= PERIOD;
      }
    }
    expect(h.frames.map((frame) => frame.time)).toEqual(expectedTimes);
  });

  it('keeps 1x, 2x and bounded 8x catch-up clocks on the same consumed time', () => {
    const h = harness(false);
    for (let frame = 0; frame < 1200; frame++) h.advance(frame % 2 ? 9 : 7.6666666667);
    for (const rate of [1, 2, 8]) {
      const sceneMs = h.frames.reduce((sum, frame) => sum + frame.delta * rate, 0);
      expect(sceneMs).toBeLessThanOrEqual(h.wall() * rate + 1e-6);
      expect(h.wall() * rate - sceneMs).toBeLessThan(PERIOD * rate);
    }
  });

  it('delivers a multi-period frame once, retaining only the undelivered fraction', () => {
    const h = harness(false);
    h.advance(10);
    h.advance(67);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]!.delta).toBeCloseTo(PERIOD * 4, 8);
    expect(h.delivered() + h.loop.delta).toBeCloseTo(77, 8);
    h.advance(12);
    expect(h.frames).toHaveLength(2);
    expect(h.delivered() + h.loop.delta).toBeCloseTo(89, 8);
  });

  it('resets pending time on resume without leaking the hidden interval into a step', () => {
    const h = harness(false);
    h.advance(10);
    vi.stubGlobal('window', { performance: { now: () => 60_000 } });
    h.loop.resetDelta();
    expect(h.loop.delta).toBe(0);
    h.loop.stepLimitFPS(60_010);
    expect(h.frames).toHaveLength(0);
    h.loop.stepLimitFPS(60_020);
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]!.delta).toBeCloseTo(PERIOD, 8);
    expect(h.frames[0]!.delta + h.loop.delta).toBeCloseTo(20, 8);
  });

  it('leaves the uncapped desktop loop unchanged', () => {
    const h = harness(false, 0);
    for (const delta of [8, 12, 17, 5, 25]) h.advance(delta);
    expect(h.frames.map((frame) => frame.delta)).toEqual([8, 12, 17, 5, 25]);
    expect(h.delivered()).toBe(67);
  });

  it('ships the same corrected limiter through the actual ESM and CommonJS exports', () => {
    const corrected = /this\.callback\(time, this\.delta - \(this\.delta % this\._limitRate\)\)/;
    for (const file of ['src/core/TimeStep.js', 'dist/phaser.esm.js', 'dist/phaser.js']) {
      const source = readFileSync(join(phaserRoot, file), 'utf8');
      expect(source, file).toMatch(corrected);
      expect(source, file).not.toContain('this.callback(time, this.delta);');
    }
  });
});
