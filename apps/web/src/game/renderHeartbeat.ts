/** Rendering liveness, independent of Phaser's frame loop (which can stop
 * scheduling after a thrown callback). Presentation timings, not game clocks. */
export const RENDER_HEARTBEAT = { checkMs: 1_000, graceMs: 5_000 } as const;

export class RenderHeartbeat {
  private ready = false;
  private lastRenderAt = 0;
  private actualRenderAt: number | null = null;
  private lastStepAt: number | null = null;
  private context: 'available' | 'lost' | 'restored' = 'available';
  private eligible = false;
  private stopped = false;

  markReady(now: number): void {
    this.ready = true;
    this.resetGrace(now);
  }

  stepped(now: number): void { this.lastStepAt = now; }

  rendered(now: number): void {
    if (this.context === 'lost') return;
    this.lastRenderAt = now;
    this.actualRenderAt = now;
  }

  isContextLost(): boolean { return this.context === 'lost'; }

  contextLost(): boolean {
    if (this.context === 'lost') return false;
    this.context = 'lost';
    return true;
  }

  contextRestored(now: number): void { this.context = 'restored'; this.resetGrace(now); }

  diagnostics(now: number): { contextState: 'available' | 'lost' | 'restored'; stepAgeMs?: number; renderAgeMs?: number } {
    const age = (at: number): number => Math.min(600_000, Math.max(0, Math.round(now - at)));
    return { contextState: this.context,
      ...(this.lastStepAt === null ? {} : { stepAgeMs: age(this.lastStepAt) }),
      ...(this.actualRenderAt === null ? {} : { renderAgeMs: age(this.actualRenderAt) }) };
  }

  resetGrace(now: number): void {
    this.lastRenderAt = now;
    this.eligible = false;
  }

  /** True only once. A recovered frame does not dismiss the player's recovery
   * choice, and no caller is authorized to reload or mutate a raid here. */
  check(now: number, eligible: boolean): boolean {
    if (!this.ready || !eligible || this.context === 'lost') {
      this.resetGrace(now);
      return false;
    }
    if (!this.eligible) {
      this.eligible = true;
      this.lastRenderAt = now;
      return false;
    }
    if (!this.stopped && now - this.lastRenderAt >= RENDER_HEARTBEAT.graceMs) {
      this.stopped = true;
      return true;
    }
    return false;
  }
}
