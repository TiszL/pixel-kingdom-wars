import { describe, expect, it } from 'vitest';
import { RenderHeartbeat } from './renderHeartbeat';

describe('completed-render watchdog', () => {
  it('keeps actual step/render ages separate from eligibility grace and reports context loss once per episode', () => {
    const h = new RenderHeartbeat();
    h.markReady(0);
    expect(h.diagnostics(0)).toEqual({ contextState: 'available' });
    h.stepped(10); h.rendered(20); h.resetGrace(1_000);
    expect(h.diagnostics(1_000)).toEqual({ contextState: 'available', stepAgeMs: 990, renderAgeMs: 980 });
    expect(h.contextLost()).toBe(true); expect(h.contextLost()).toBe(false);
    h.rendered(2_000); // Phaser can emit POST_RENDER without drawing a lost context.
    expect(h.diagnostics(2_000).renderAgeMs).toBe(1_980);
    expect(h.check(999_999, true)).toBe(false);
    h.contextRestored(1_000_000);
    expect(h.contextLost()).toBe(true); // a subsequent real loss is distinct evidence
    expect(h.diagnostics(2_000_000).stepAgeMs).toBe(600_000);
  });
  it('waits for engine readiness, then requires five seconds without a completed render', () => {
    const heartbeat = new RenderHeartbeat();
    expect(heartbeat.check(100_000, true)).toBe(false);
    heartbeat.markReady(100_000);
    expect(heartbeat.check(100_000, true)).toBe(false);
    heartbeat.rendered(102_000);
    expect(heartbeat.check(106_999, true)).toBe(false);
    expect(heartbeat.check(107_000, true)).toBe(true);
    expect(heartbeat.check(120_000, true)).toBe(false); // one report/panel per mount
    heartbeat.rendered(120_001);
    expect(heartbeat.check(130_000, true)).toBe(false);
  });

  it('does not count an ineligible interval as time without rendering', () => {
    const heartbeat = new RenderHeartbeat();
    heartbeat.markReady(0);
    heartbeat.check(0, true);
    expect(heartbeat.check(4_000, true)).toBe(false);
    expect(heartbeat.check(100_000, false)).toBe(false);
    expect(heartbeat.check(100_100, true)).toBe(false);
    expect(heartbeat.check(105_099, true)).toBe(false);
    expect(heartbeat.check(105_100, true)).toBe(true);
  });

  it('resets the grace on foreground return even when the interval never ran while hidden', () => {
    const heartbeat = new RenderHeartbeat();
    heartbeat.markReady(0);
    heartbeat.check(0, true);
    heartbeat.resetGrace(1_000_000);
    expect(heartbeat.check(1_000_000, true)).toBe(false);
    expect(heartbeat.check(1_004_999, true)).toBe(false);
    expect(heartbeat.check(1_005_000, true)).toBe(true);
  });
});
