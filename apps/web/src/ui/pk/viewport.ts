/** The shell classifies game UI dimensions; CSS consumes the root attributes. */
import { readGameUiViewport } from '../../lib/gameViewport';
import { classifyPkViewport, stampPkViewport } from './viewportClass';
import { usePkViewport } from './usePkViewport';
export type ViewportClass = import('./viewportClass').PkViewportClass;
export function isTouchClass(c: ViewportClass): boolean { return c !== 'desktop'; }
export function readViewportClass(_root?: HTMLElement): ViewportClass {
  const { w, h } = readGameUiViewport();
  return classifyPkViewport(w, h).vp;
}
export function syncViewportClass(root: HTMLElement = document.documentElement): ViewportClass {
  const { w, h } = readGameUiViewport();
  stampPkViewport(root, w, h);
  return classifyPkViewport(w, h).vp;
}
/**
 * The web LocalReducedMotion (KIT: "no loops, no slides, 120 ms cross-fades"). The bridge already shortens every
 * duration under reduce; components read this only to drop LOOPS and decorative movement the bridge cannot express as
 * a duration (the Celebration's turning rays and sparks, the Seal's scale). BOTH bridge triggers count: the OS query
 * OR `html[data-motion="reduce"]` (useMotion(): the in-game REDUCE MOTION toggle). The kitBase.css block applies the
 * same two triggers in CSS, so a toggle flipped while a piece is shown also takes effect without a re-render.
 */
export function prefersReducedMotion(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduce') return true;
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useViewportClass(): ViewportClass { return usePkViewport().vp; }
