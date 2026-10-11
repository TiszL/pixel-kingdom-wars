import { describe, expect, it } from 'vitest';
import { StepTimingSampler } from './stepTiming';

describe('rendered STEP timing', () => {
  it('measures accepted 60 Hz steps instead of the 120 Hz rAF counters when limited', () => {
    const timing = new StepTimingSampler();
    expect(timing.sample(0, 1000 / 120, true)).toBeNull();
    expect(timing.sample(1000 / 60, 1000 / 120, true)).toBeCloseTo(1000 / 60);
    expect(timing.sample(2000 / 60, 1000 / 120, true)).toBeCloseTo(1000 / 60);
    expect(timing.fps(120, true)).toBeCloseTo(60);
  });

  it('preserves raw browser gaps and Phaser fps on an unlimited desktop', () => {
    const timing = new StepTimingSampler();
    expect(timing.sample(20, 83, false)).toBe(83);
    expect(timing.fps(58.4, false)).toBe(58.4);
  });

  it('drops a visibility-pause gap and resumes from the next accepted STEP', () => {
    const timing = new StepTimingSampler();
    timing.sample(0, 8, true);
    expect(timing.sample(1000 / 60, 8, true)).toBeCloseTo(1000 / 60);
    timing.dropBaseline();
    expect(timing.sample(60_000, 8, true)).toBeNull();
    expect(timing.sample(60_000 + 1000 / 60, 8, true)).toBeCloseTo(1000 / 60);
    expect(timing.fps(120, true)).toBeCloseTo(60);
  });
});
