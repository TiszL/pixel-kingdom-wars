/**
 * Frame timing at Phaser's rendered STEP boundary.
 *
 * With `fps.limit`, Phaser still observes every requestAnimationFrame while it
 * emits STEP only for accepted frames. Its `rawDelta` / `actualFps` can
 * therefore describe a 120 Hz panel even while the game renders at 60 Hz.
 * Successive STEP timestamps are the authoritative interval in limited mode.
 */
export class StepTimingSampler {
  private previousLimitedStepAt: number | null = null;
  private windowIntervals = 0;
  private windowElapsedMs = 0;

  sample(stepAt: number, rawDelta: number, limited: boolean): number | null {
    if (!limited) return Number.isFinite(rawDelta) && rawDelta >= 0 ? rawDelta : null;
    if (!Number.isFinite(stepAt)) {
      this.previousLimitedStepAt = null;
      return null;
    }
    const previous = this.previousLimitedStepAt;
    this.previousLimitedStepAt = stepAt;
    if (previous === null) return null;
    const interval = stepAt - previous;
    if (!Number.isFinite(interval) || interval <= 0) return null;
    this.windowIntervals += 1;
    this.windowElapsedMs += interval;
    return interval;
  }

  fps(fallback: number, limited: boolean): number {
    if (!limited || this.windowElapsedMs <= 0) return fallback;
    return (this.windowIntervals * 1_000) / this.windowElapsedMs;
  }

  /** Visibility PAUSE fires before the clock gap; RESUME fires after Phaser's
   * first resumed STEP, so dropping the predecessor here makes that first
   * callback the new baseline instead of a minutes-long synthetic frame. */
  dropBaseline(): void {
    this.previousLimitedStepAt = null;
  }

  clearWindow(): void {
    this.windowIntervals = 0;
    this.windowElapsedMs = 0;
  }
}
