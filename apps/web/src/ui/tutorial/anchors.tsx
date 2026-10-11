/**
 * COACH-MARK ANCHORING — the one implementation, shared.
 *
 * This was lifted out of TutorialOverlay.tsx on 2026-08-29 when the guided
 * first-run flow needed to ring controls too. Two ring implementations would
 * have drifted within a week: two fail-soft rules, two z-index policies, two
 * answers to "what happens when the element is not on screen yet". There is one
 * of each, here, and both surfaces import it.
 *
 * THE FAIL-SOFT RULE IS THE WHOLE CONTRACT. A selector that matches nothing
 * yields `null`, and every caller must render something useful without a ring —
 * HUD controls mount behind their own fetches, live inside a panel that is not
 * open yet, or simply do not exist on the screen the player wandered off to.
 * Guidance is guidance; it never gates and it never throws.
 *
 * WHY A POLL AND NOT A ResizeObserver: the anchors move for reasons that are not
 * resizes — a sheet opening, a horizontal tray scrolling, a HUD pill arriving
 * with its data. One cheap getBoundingClientRect a second, only while a mark is
 * on screen, covers all of them; the state setter bails on an unchanged box, so
 * a stationary ring costs zero renders.
 */
import { useEffect, useState } from 'react';
import { COLORS as C } from '../primitives';

/** How to find the control a step is about, in priority order. */
export interface AnchorSpec {
  /** Stable CSS selector for the element to ring. Tutorial-owned data hooks or
   * durable ARIA names are required; visible button copy is not an API. */
  selector?: string;
}

export interface AnchorBox { left: number; top: number; width: number; height: number }

/** How far the ring stands off the control it marks. */
const PAD = 5;

/** Re-measure this often — see the poll note in the file header. */
const MEASURE_MS = 1_000;

/** A ring may only point at a visible, enabled control the player can hit. */
export function anchorIsVisible(el: Element, allowOffscreen = false): boolean {
  const control = el.matches('button, input, select, textarea, a[href]')
    ? el : el.querySelector('button, input, select, textarea, a[href]') ?? el;
  if (control.matches(':disabled, [aria-disabled="true"]')) return false;
  for (let node: Element | null = el; node; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hasAttribute('hidden') || node.hasAttribute('inert')
      || style.display === 'none' || style.visibility === 'hidden'
      || style.visibility === 'collapse' || style.opacity === '0') return false;
  }
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  if (allowOffscreen) return true;
  let left = Math.max(0, r.left), top = Math.max(0, r.top);
  let right = Math.min(window.innerWidth, r.right), bottom = Math.min(window.innerHeight, r.bottom);
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent);
    const clipX = /hidden|clip|auto|scroll/.test(style.overflowX || style.overflow);
    const clipY = /hidden|clip|auto|scroll/.test(style.overflowY || style.overflow);
    if (!clipX && !clipY) continue;
    const box = parent.getBoundingClientRect();
    if (clipX) { left = Math.max(left, box.left); right = Math.min(right, box.right); }
    if (clipY) { top = Math.max(top, box.top); bottom = Math.min(bottom, box.bottom); }
  }
  if (right <= left || bottom <= top) return false;
  // Sample the visible control, not the unclipped original centre. A partial
  // card remains usable; a modal or sheet sitting over it does not.
  const hit = document.elementFromPoint((left + right) / 2, (top + bottom) / 2);
  return hit !== null && (el === hit || el.contains(hit) || control === hit);
}

export function findAnchor(spec: AnchorSpec, allowOffscreen = false): Element | null {
  try {
    if (spec.selector) {
      for (const el of document.querySelectorAll(spec.selector)) {
        if (anchorIsVisible(el, allowOffscreen)) return el;
      }
    }
  } catch {
    /* A stale selector must never take down the game. */
  }
  return null;
}

/**
 * The live screen box of a spec's anchor, or null while it is not on screen.
 *
 * `key` re-arms the measurement when the CALLER's idea of the target changed
 * without the spec object identity changing (a new step, a new screen). Passing
 * a fresh object literal every render would work too, but it would re-run the
 * effect on every unrelated re-render of the host.
 */
export function useAnchorBox(spec: AnchorSpec | null, key: string): AnchorBox | null {
  const [box, setBox] = useState<AnchorBox | null>(null);
  useEffect(() => {
    if (!spec) { setBox(null); return undefined; }
    const measure = (): void => {
      const el = findAnchor(spec);
      if (!el) { setBox(null); return; }
      const r = el.getBoundingClientRect();
      const next: AnchorBox = {
        left: r.left - PAD, top: r.top - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2,
      };
      setBox((prev) => (
        prev && prev.left === next.left && prev.top === next.top
        && prev.width === next.width && prev.height === next.height
          ? prev : next
      ));
    };
    measure();
    window.addEventListener('resize', measure);
    const t = setInterval(measure, MEASURE_MS);
    return () => {
      window.removeEventListener('resize', measure);
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the caller's re-arm signal
  }, [key]);
  return box;
}

/**
 * The pulsing ring. `data-tutorial-ring` is the hook every test asserts a coach
 * mark through, and the reduced-motion rule is attached to it — keep both.
 *
 * `zIndex` is a parameter because the two callers sit at different heights: the
 * card deck stays UNDER sheets and modals so an open dialog always covers it,
 * while the guided flow deliberately rings controls that live INSIDE those
 * sheets. Nothing here takes pointer events either way, so a ring can never
 * intercept the tap it is asking for.
 */
export function AnchorRing({ box, zIndex }: { box: AnchorBox; zIndex: number }): React.JSX.Element {
  return (
    <>
      <div aria-hidden="true" data-tutorial-ring style={{
        position: 'fixed', left: box.left, top: box.top, width: box.width, height: box.height,
        border: `3px solid ${C.gold}`, outline: `2px solid ${C.ink}`,
        boxShadow: `0 0 0 2px ${C.ink} inset`, pointerEvents: 'none', zIndex,
        animation: 'skpTutPulse 1.04s steps(2,end) infinite',
      }} />
      <style>{`@keyframes skpTutPulse { 0%, 49.9% { border-color: ${C.gold} } 50%, 100% { border-color: ${C.goldHi} } } @media (prefers-reduced-motion: reduce) { [data-tutorial-ring] { animation: none } }`}</style>
    </>
  );
}

/**
 * FOCUS, NOT A CAGE (owner 2026-08-29: "lock in", but the rest of the game must
 * keep working).
 *
 * Four dim panes around the anchor, so the eye lands on the one control the step
 * is about. Every pane is `pointer-events: none`: the dimmed game is still fully
 * playable, every button under the wash still takes taps, and there is nothing
 * to be trapped in. This is a tint, not a modal — the difference matters enough
 * that it is the reason the spotlight is four rects rather than one backdrop
 * with a hole punched in it, which would have had to swallow clicks to work.
 *
 * A hole is only cut when there IS an anchor. Without one the caller renders no
 * spotlight at all rather than dimming the whole screen at a player who has not
 * been shown where to go.
 */
export function Spotlight({ box, zIndex }: { box: AnchorBox; zIndex: number }): React.JSX.Element {
  const pane = (style: React.CSSProperties): React.JSX.Element => (
    <div aria-hidden="true" data-tutorial-dim style={{
      position: 'fixed', background: 'rgba(16,14,20,.58)', pointerEvents: 'none', zIndex, ...style,
    }} />
  );
  const right = box.left + box.width;
  const bottom = box.top + box.height;
  return (
    <>
      {pane({ left: 0, right: 0, top: 0, height: Math.max(0, box.top) })}
      {pane({ left: 0, right: 0, top: bottom, bottom: 0 })}
      {pane({ left: 0, width: Math.max(0, box.left), top: box.top, height: box.height })}
      {pane({ left: right, right: 0, top: box.top, height: box.height })}
    </>
  );
}
