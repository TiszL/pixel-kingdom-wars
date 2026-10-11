/** @vitest-environment happy-dom */
/**
 * THE VALUE-CHANGE ACKNOWLEDGEMENT — the bar's only motion, and the three ways
 * it can be wrong.
 *
 * The owner's critique #5 was "nothing is alive; values snap between numbers
 * with no acknowledgement". A flash is easy; a flash that does not lie is not.
 * Each rule below is a way this feature could exist and still be a defect:
 *
 *  - IT MUST NOT FIRE ON MOUNT. Balances are null until the server answers, so a
 *    naive previous-value comparison flashes BOTH currencies on every cold start
 *    and on every base switch. A signal that fires when nothing happened trains
 *    the player to ignore it — and the thing it exists to catch is an
 *    unintended KEEP spend, which is exactly what production reported.
 *  - IT MUST DISTINGUISH DIRECTION. Warm for a gain, cold for a loss. A single
 *    "something changed" flash cannot tell a player they just spent.
 *  - IT MUST OBEY BOTH MOTION SWITCHES. The stylesheet honours the OS
 *    prefers-reduced-motion; this hook honours the game's own REDUCE MOTION
 *    toggle (state/store, profile screen). Either one on ⇒ the number changes
 *    instantly. Testing only the CSS would leave the in-game switch dead, which
 *    is the failure a player who turned it on would actually experience.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  HudChip, HUD_FLASH_MS, HUD_ROLL_MS, HudOverflowButton, useHudFlash, useHudRoll,
  type HudFlash,
} from './hudChrome';

let host: HTMLDivElement;
let root: Root;

/** Drives the hook through a real render so the effect actually runs. */
function Probe({ value, reduceMotion }: { value: number | null; reduceMotion?: boolean }): React.JSX.Element {
  const flash = useHudFlash(value, reduceMotion);
  return <HudChip ariaLabel="Probe" flash={flash}>{String(value)}</HudChip>;
}

const render = (value: number | null, reduceMotion = false): void => {
  act(() => { root.render(<Probe value={value} reduceMotion={reduceMotion} />); });
};

/** Everything after the chrome's `<style>` block — i.e. the button itself. The
 *  stylesheet names `data-hud-still` (it is the selector that exempts a stilled
 *  badge), so an attribute assertion on the whole markup would always pass. */
const el = (html: string): string => html.slice(html.lastIndexOf('</style>'));

/** The direction currently on the chip, or null when it is at rest. */
const flashOf = (): HudFlash | null =>
  (host.querySelector('[aria-label="Probe"]')?.getAttribute('data-hud-flash') as HudFlash | null) ?? null;

/** Drives the count-up through a real render, drawing what the chip would draw. */
function RollProbe({ value, reduceMotion }: { value: number | null; reduceMotion?: boolean }): React.JSX.Element {
  const shown = useHudRoll(value, reduceMotion);
  return <HudChip ariaLabel="Roll">{String(shown)}</HudChip>;
}

const roll = (value: number | null, reduceMotion = false): void => {
  act(() => { root.render(<RollProbe value={value} reduceMotion={reduceMotion} />); });
};

/** The number currently ON SCREEN, which during an increase is not the value. */
const drawn = (): number | null => {
  const text = host.querySelector('[aria-label="Roll"]')?.textContent ?? 'null';
  return text === 'null' ? null : Number(text);
};

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => { root.unmount(); });
  host.remove();
  vi.useRealTimers();
});

describe('a HUD value acknowledges that it moved', () => {
  it('says nothing on first paint, or when the balance merely arrives', () => {
    render(null);
    expect(flashOf()).toBeNull();
    // null → number is the server answering, not the player earning.
    render(12_450);
    expect(flashOf()).toBeNull();
  });

  it('flashes warm on a gain and cold on a spend', () => {
    render(12_450);
    render(13_000);
    expect(flashOf()).toBe('up');
    act(() => { vi.advanceTimersByTime(HUD_FLASH_MS); });
    expect(flashOf()).toBeNull();

    render(9_000);
    expect(flashOf()).toBe('down');
  });

  it('stays silent when the value is re-rendered unchanged', () => {
    // Balance polling re-renders the bar on a timer. A flash on every poll is
    // the same defect as a flash on mount.
    render(12_450);
    render(12_450);
    expect(flashOf()).toBeNull();
  });

  it('settles back to rest so the chip is not left tinted', () => {
    render(12_450);
    render(13_000);
    act(() => { vi.advanceTimersByTime(HUD_FLASH_MS - 1); });
    expect(flashOf()).toBe('up');
    act(() => { vi.advanceTimersByTime(1); });
    expect(flashOf()).toBeNull();
  });
});

describe('a gain is counted, not swapped', () => {
  /**
   * THE OWNER'S BRIEF was "a resource that increases ticks up". A tally is easy;
   * a tally that cannot lie about a balance or break the row is the feature.
   *
   * The two rules below are not polish. hudBarPlan() budgets every chip's width
   * from the exact string it is about to draw, so a value in motion is only safe
   * while its intermediate strings are no WIDER than the one that was budgeted —
   * which is true climbing and false falling. And an animation that is
   * interrupted (a poll, a second collection, an unmount) must leave the REAL
   * balance behind it, because this chip is the number a player checks before
   * spending.
   */
  it('never counts on the balance merely arriving', () => {
    roll(null);
    expect(drawn()).toBeNull();
    // null → number is the server answering. A cold start that counted
    // 0 → 7,038,871 would be a slot machine on every launch.
    roll(12_450);
    expect(drawn()).toBe(12_450);
  });

  it('climbs through the gap and lands exactly on the new balance', () => {
    roll(1_000);
    roll(2_000);
    // The first frame is where the value WAS, not where it is going.
    expect(drawn()).toBe(1_000);
    act(() => { vi.advanceTimersByTime(HUD_ROLL_MS / 2); });
    const mid = drawn()!;
    expect(mid).toBeGreaterThan(1_000);
    expect(mid).toBeLessThan(2_000);
    act(() => { vi.advanceTimersByTime(HUD_ROLL_MS); });
    // EXACT, not "close": this is a currency, and a rounded tally that stopped
    // one shard short would be a balance the game is lying about.
    expect(drawn()).toBe(2_000);
  });

  it('never draws a number wider than the width the bar solved for', () => {
    // hudBarPlan() is handed the TARGET string. Every frame of an increase is
    // between the old value and the target, so it can only be shorter — which is
    // why a spend snaps instead of counting down: 7,038,871 → 12,450 counted
    // down would draw 7-digit strings inside a 6-digit chip and clip the
    // currency mid-number, the exact defect the solver exists to prevent.
    roll(7_038_871);
    roll(12_450);
    expect(drawn()).toBe(12_450);
    for (const t of [1, HUD_ROLL_MS / 2, HUD_ROLL_MS]) {
      act(() => { vi.advanceTimersByTime(t); });
      expect(drawn()).toBe(12_450);
    }
  });

  it('lands on the real balance when a second change interrupts the count', () => {
    roll(1_000);
    roll(9_000);
    act(() => { vi.advanceTimersByTime(HUD_ROLL_MS / 4); });
    expect(drawn()).toBeLessThan(9_000);
    // The server answers again mid-tally. The interrupted count must not strand
    // its last interpolated frame on screen.
    roll(4_000);
    expect(drawn()).toBe(4_000);
    act(() => { vi.advanceTimersByTime(HUD_ROLL_MS * 2); });
    expect(drawn()).toBe(4_000);
  });

  it('just changes the number when the GAME switch is on', () => {
    roll(1_000, true);
    roll(2_000, true);
    expect(drawn()).toBe(2_000);
  });

  it('just changes the number when the OS switch is on', () => {
    // THE GAP THIS CLOSES. Every other animation in the chrome is CSS wrapped in
    // `@media (prefers-reduced-motion: no-preference)`, so the OS switch stops it
    // for free. A count-up is a real number changing in JavaScript and no media
    // query can touch it — a player who set the OS preference and never opened
    // the game's own settings would still watch their balance tick. The hook has
    // to ask, so this is the assertion that it does.
    const real = window.matchMedia;
    window.matchMedia = ((q: string) => ({
      matches: q.includes('prefers-reduced-motion: reduce'),
      media: q, onchange: null, addEventListener: () => undefined,
      removeEventListener: () => undefined, addListener: () => undefined,
      removeListener: () => undefined, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      roll(1_000);
      roll(2_000);
      expect(drawn()).toBe(2_000);
    } finally {
      window.matchMedia = real;
    }
  });
});

describe('REDUCE MOTION means the number just changes', () => {
  it('never marks the chip when the game setting is on', () => {
    // The OS switch is handled by the stylesheet's prefers-reduced-motion guard.
    // This is the in-game toggle, and it has to work on its own — a player who
    // turned it on will never see the media query fire.
    render(12_450, true);
    render(13_000, true);
    expect(flashOf()).toBeNull();
    render(9_000, true);
    expect(flashOf()).toBeNull();
  });

  it('drops a flash already on screen the moment the setting is turned on', () => {
    render(12_450);
    render(13_000);
    expect(flashOf()).toBe('up');
    // Same value, motion now suppressed: the tint must not survive the switch.
    render(13_000, true);
    expect(flashOf()).toBeNull();
  });

  it('stops the badge bobbing without dropping the badge', () => {
    // THE TRAP THIS CATCHES. The obvious way to honour REDUCE MOTION on the
    // badge is to stop rendering the animated element — which would also delete
    // the alert itself, silently turning an accessibility preference into a lost
    // daily cache. The badge rule in hudBar.test.tsx pins that .hud-badge is
    // present whenever something is claimable; this pins that REDUCE MOTION
    // still leaves it present, and stops only the motion.
    const shown = renderToStaticMarkup(
      <HudOverflowButton open={false} alert reduceMotion onToggle={vi.fn()} />,
    );
    expect(shown).toContain('class="hud-badge"');
    expect(shown).toContain('ACTION NEEDED');
    expect(el(shown)).toContain('data-hud-still="1"');
    // And the stylesheet has to actually exempt it, or the attribute is decor.
    expect(shown).toContain('.hud-badge:not([data-hud-still]){animation:hud-badge-bob');
    // Motion on: the same badge, unmarked, so the rule applies to it.
    const moving = renderToStaticMarkup(
      <HudOverflowButton open={false} alert onToggle={vi.fn()} />,
    );
    expect(moving).toContain('class="hud-badge"');
    expect(el(moving)).not.toContain('data-hud-still');
  });

  it('moves the badge by a whole pixel, never by a scale', () => {
    // A transform:scale() on a 16px pixel-art sprite resamples every pixel off
    // the grid: at DPR 1 the badge BLURS at the peak of every pulse, on the one
    // element that must never be missed. Integer translate keeps it on the grid,
    // and steps() keeps it there for the whole animation rather than only at the
    // keyframes.
    //
    // THE ASSERTION NAMES `transform` ON PURPOSE (2026-08-29). It used to be a
    // bare `not.toContain('scale(')` over the whole markup, which is a proxy for
    // the rule rather than the rule: the chrome's disabled-tab treatment is
    // `filter: grayscale(1)` — a colour operation on a control that is not this
    // badge and does not resample anything — and the substring `scale(` inside
    // `grayscale(` failed it. Matching the transform property (and the `scale`
    // longhand) pins the geometry rule itself, so a real regression still fails
    // and an unrelated filter no longer can.
    const html = renderToStaticMarkup(
      <HudOverflowButton open={false} alert onToggle={vi.fn()} />,
    );
    expect(html).toContain('translateY(1px)');
    expect(html).not.toMatch(/transform:[^;}"]*scale\(/);
    expect(html).not.toMatch(/[;{"]\s*scale:/);
    expect(html).toContain('steps(1,end)');
  });
});
