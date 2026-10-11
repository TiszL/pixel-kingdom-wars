/** Full drawable viewport, with a separate safe frame for React controls. */
import { caps } from './platform';

const VIEWPORT_EVENT = 'pkw:game-viewport';
// Owner's iPhone / Phantom 26.28 capture (2026-09-06): every viewport API
// included the native bottom toolbar. Keep controls above its ~56px height
// plus 8px clearance, without shrinking the drawable surface. The existing 34px CSS safe-area padding remains responsible for the
// home indicator. This allowance is specific to Phantom's iOS browser.
const PHANTOM_TOOLBAR_CLEARANCE = 64;
// The observed overlaid Pro Max frame excludes62px of status chrome; the
// inset frame excludes149px.70px also distinguishes the SE's20px status-only
// gap from its roughly75px status+toolbar gap. This fallback is a measurement
// heuristic; a positive home-indicator inset takes precedence.
const PHANTOM_TOOLBAR_OUTSIDE_GAP = 70;

function readSafeAreaBottom(): number {
  const probe = document.querySelector('[data-game-viewport-probe="safe"]');
  return probe ? Math.max(0, Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0) : 0;
}

function screenExtent(width: number, height: number): number | null {
  const screen = window.screen;
  if (!screen || !Number.isFinite(screen.width) || !Number.isFinite(screen.height)
    || screen.width <= 0 || screen.height <= 0) return null;
  return width > height ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
}

export function readGameViewport(): { w: number; h: number } {
  if (typeof window === 'undefined') return { w: 0, h: 0 };
  const root = document.getElementById('root');
  return { w: root?.clientWidth || window.innerWidth, h: root?.clientHeight || window.innerHeight };
}

/** Native toolbar clearance affects controls, never the drawable game surface. */
export function readGameUiViewport(): { w: number; h: number } {
  const frame = readGameViewport();
  if (typeof window === 'undefined') return frame;
  const clearance = Number.parseFloat(document.getElementById('root')?.style.getPropertyValue('--game-ui-bottom-clearance') ?? '') || 0;
  return { w: frame.w, h: Math.max(0, frame.h - clearance) };
}

/** Opt-in local diagnostics; never includes form contents or player identity. */
export function readGameViewportDiagnostics(): {
  root: { x: number; y: number; width: number; height: number } | null;
  canvasContainer: { x: number; y: number; width: number; height: number } | null;
  canvas: { x: number; y: number; width: number; height: number } | null;
  dynamicHeight: number | null;
  largeHeight: number | null;
  screenExtent: number | null;
  safeBottom: number;
  uiHeight: number;
  bottomClearance: number;
  inner: { width: number; height: number };
  scroll: { x: number; y: number };
  visual: { offsetLeft: number; offsetTop: number; width: number; height: number; scale: number } | null;
  editableFocused: boolean;
} {
  const rect = document.getElementById('root')?.getBoundingClientRect();
  const probe = document.querySelector('[data-game-viewport-probe="dynamic"]');
  const visual = window.visualViewport;
  const largeHeight = document.querySelector('[data-game-viewport-probe="large"]')?.getBoundingClientRect().height ?? null;
  const box = (selector: string) => {
    const bounds = document.querySelector(selector)?.getBoundingClientRect();
    return bounds ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height } : null;
  };
  return {
    root: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
    canvasContainer: box('[data-game-canvas-container]'),
    canvas: box('[data-game-canvas-container] canvas'),
    dynamicHeight: probe?.getBoundingClientRect().height ?? null,
    largeHeight,
    screenExtent: screenExtent(document.documentElement.clientWidth, largeHeight ?? rect?.height ?? window.innerHeight),
    safeBottom: readSafeAreaBottom(),
    uiHeight: readGameUiViewport().h,
    bottomClearance: readGameViewport().h - readGameUiViewport().h,
    inner: { width: window.innerWidth, height: window.innerHeight },
    scroll: { x: window.scrollX, y: window.scrollY },
    visual: visual ? { offsetLeft: visual.offsetLeft, offsetTop: visual.offsetTop,
      width: visual.width, height: visual.height, scale: visual.scale } : null,
    editableFocused: hasFocusedTextInput(),
  };
}

/** Only editable text focus can make VisualViewport describe a keyboard. */
export function hasFocusedTextInput(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && (active.isContentEditable
    || active instanceof HTMLTextAreaElement && !active.readOnly && !active.disabled
    || active instanceof HTMLInputElement && !active.readOnly && !active.disabled
      && !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(active.type));
}

/** Keyboard scroll is relative to the containing frame, which may already end
 * above the keyboard. Subtracting from innerHeight again hides the form twice. */
export function visibleParentInsets(
  parent: { top: number; bottom: number }, visual: { offsetTop: number; height: number },
): { top: number; bottom: number } {
  const height = Math.max(0, parent.bottom - parent.top);
  const top = Math.min(height, Math.max(0, visual.offsetTop - parent.top));
  return {
    top: Math.round(top),
    bottom: Math.round(Math.min(height - top, Math.max(0, parent.bottom - visual.offsetTop - visual.height))),
  };
}

export function subscribeGameViewport(listener: () => void): () => void {
  window.addEventListener(VIEWPORT_EVENT, listener);
  window.addEventListener('resize', listener);
  window.addEventListener('orientationchange', listener);
  return () => {
    window.removeEventListener(VIEWPORT_EVENT, listener);
    window.removeEventListener('resize', listener);
    window.removeEventListener('orientationchange', listener);
  };
}

/** Install before React renders. A scale-one visual viewport describes browser
 * chrome/keyboard occlusion; pinch zoom must not shrink and reflow the game. */
export function installGameViewport(): () => void {
  const root = document.getElementById('root');
  if (!root) return () => undefined;
  const visual = window.visualViewport;
  const fullscreen = window.matchMedia?.('(display-mode: fullscreen)');
  const phantomToolbar = caps.isIOS && !caps.isStandalone
    && /Phantom\/ios\//i.test(navigator.userAgent);
  // The document never owns game scrolling. Restoring its old offset after
  // navigation can pan WebKit's fixed root, independently of its correct size.
  const scrollRestoration = 'scrollRestoration' in history ? history.scrollRestoration : null;
  if (scrollRestoration !== null) history.scrollRestoration = 'manual';
  // WebKit can finish its browser/keyboard animation after the last resize
  // event. Observe an uncapped CSS viewport, not just the root whose old cap
  // would otherwise prevent its own ResizeObserver from noticing expansion.
  const dynamicViewport = document.createElement('div');
  dynamicViewport.setAttribute('aria-hidden', 'true');
  dynamicViewport.dataset.gameViewportProbe = 'dynamic';
  dynamicViewport.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;visibility:hidden;pointer-events:none;contain:strict;overflow:hidden;';
  dynamicViewport.style.height = '100dvh';
  document.body.appendChild(dynamicViewport);
  // The large viewport stays independent of keyboard/dynamic viewport shrink.
  // Reading the already-capped root here would repeatedly subtract the reserve.
  const largeViewport = phantomToolbar ? document.createElement('div') : null;
  if (largeViewport) {
    largeViewport.setAttribute('aria-hidden', 'true');
    largeViewport.dataset.gameViewportProbe = 'large';
    largeViewport.style.cssText = 'position:fixed;top:0;left:0;width:0;height:100vh;visibility:hidden;pointer-events:none;contain:strict;overflow:hidden;';
    largeViewport.style.height = '100lvh';
    document.body.appendChild(largeViewport);
  }
  const safeArea = largeViewport ? document.createElement('div') : null;
  if (safeArea) {
    safeArea.setAttribute('aria-hidden', 'true');
    safeArea.dataset.gameViewportProbe = 'safe';
    safeArea.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;padding-bottom:env(safe-area-inset-bottom);visibility:hidden;pointer-events:none;overflow:hidden;';
    document.body.appendChild(safeArea);
  }
  let frameHeight = 0;
  let toolbarFrameHeight = Infinity;
  let keyboardFrameHeight: number | null = null;
  let layoutWidth = 0;
  let previous = '';
  let origin = '';
  const publish = (): void => {
    const { w, h } = readGameViewport();
    const clearance = Math.max(0, h - toolbarFrameHeight);
    root.style.setProperty('--game-ui-bottom-clearance', `${Math.floor(clearance)}px`);
    const uiHeight = readGameUiViewport().h;
    root.style.setProperty('--game-viewport-height', `${uiHeight}px`);
    const rect = root.getBoundingClientRect();
    // An origin-only correction also changes Phaser's input mapping. Native
    // accessibility pinch must not reflow a focused form's frozen viewport.
    if (!visual || Math.abs(visual.scale - 1) < 0.01) {
      origin = `${rect.x}:${rect.y}:${window.scrollX}:${window.scrollY}:${visual?.offsetLeft ?? 0}:${visual?.offsetTop ?? 0}`;
    }
    const next = `${w}:${h}:${uiHeight}:${origin}`;
    if (next === previous) return;
    previous = next;
    window.dispatchEvent(new Event(VIEWPORT_EVENT));
  };
  const sync = (): void => {
    const width = document.documentElement.clientWidth;
    const zoomed = !!visual && Math.abs(visual.scale - 1) >= 0.01;
    const textFocused = hasFocusedTextInput();
    // Freeze the whole layout during native pinch, not just VisualViewport.
    // Some WebKit versions also change innerHeight while magnifying the page.
    // A real layout-width change (rotation) still needs a new CSS frame.
    if (!zoomed || !frameHeight || width !== layoutWidth) {
      const dynamicHeight = dynamicViewport.getBoundingClientRect().height;
      const height = Number.isFinite(dynamicHeight) && dynamicHeight > 0 ? dynamicHeight : window.innerHeight;
      if (Number.isFinite(height) && height > 0) {
        frameHeight = height;
        keyboardFrameHeight = null;
        toolbarFrameHeight = Infinity;
        if (largeViewport && !fullscreen?.matches) {
          const largeHeight = largeViewport.getBoundingClientRect().height;
          const extent = screenExtent(width, largeHeight);
          const underToolbar = readSafeAreaBottom() > 0 || extent === null
            || extent - largeHeight < PHANTOM_TOOLBAR_OUTSIDE_GAP;
          if (Number.isFinite(largeHeight) && largeHeight > PHANTOM_TOOLBAR_CLEARANCE && underToolbar) {
            // Older Phantom draws under its bar; newer versions already end
            // the WebView above it. Never charge that native occlusion twice.
            toolbarFrameHeight = largeHeight - PHANTOM_TOOLBAR_CLEARANCE;
          }
        }
        // Keep the independent CSS frame so keyboard dismissal can
        // release only its extra clip even if native zoom is still active.
        const bottom = visual ? visual.offsetTop + visual.height : 0;
        if (!zoomed && textFocused && Number.isFinite(bottom) && bottom > 0 && bottom < frameHeight) {
          keyboardFrameHeight = frameHeight;
          frameHeight = bottom;
        }
        layoutWidth = width;
        root.style.setProperty('--game-viewport-frame-height', `${Math.floor(frameHeight)}px`);
      }
    } else if (!textFocused && keyboardFrameHeight !== null) {
      // Re-reading dvh during pinch could adopt a magnified height. Restore the
      // known unzoomed frame; later pinch events keep the ordinary freeze.
      frameHeight = keyboardFrameHeight;
      keyboardFrameHeight = null;
      root.style.setProperty('--game-viewport-frame-height', `${Math.floor(frameHeight)}px`);
    }
    publish();
  };
  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(publish);
  observer?.observe(root);
  const viewportObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
  viewportObserver?.observe(dynamicViewport);
  if (largeViewport) viewportObserver?.observe(largeViewport);
  // env() changes padding, not this zero-sized probe's content box.
  if (safeArea) viewportObserver?.observe(safeArea, { box: 'border-box' });
  let settleTimers: ReturnType<typeof setTimeout>[] = [];
  let originRecoveryPending = false;
  let panRecoveryArmed = true;
  const originPanned = (): boolean => {
    const rect = root.getBoundingClientRect();
    const documentPanned = Math.abs(window.scrollX) > 1 || Math.abs(window.scrollY) > 1;
    const visualPanned = !!visual && (visual.offsetTop > 1 && rect.top < -1
      || visual.offsetLeft > 1 && rect.left < -1);
    return documentPanned || visualPanned;
  };
  const recoverDocumentOrigin = (): boolean => {
    if (document.visibilityState === 'hidden' || hasFocusedTextInput()
      || visual && Math.abs(visual.scale - 1) >= 0.01 || !originPanned()) return false;
    // scrollTo can dispatch synchronous or asynchronous scroll feedback.
    // Disarm before calling it; observing rest is the only way to re-arm.
    panRecoveryArmed = false;
    window.scrollTo(0, 0);
    return true;
  };
  const recoverObservedPan = (): void => {
    if (document.visibilityState === 'hidden' || hasFocusedTextInput()
      || visual && Math.abs(visual.scale - 1) >= 0.01) return;
    if (!originPanned()) { panRecoveryArmed = true; return; }
    if (!originRecoveryPending && panRecoveryArmed && recoverDocumentOrigin()) sync();
  };
  const clearSettles = (): void => {
    settleTimers.forEach(clearTimeout);
    settleTimers = [];
    originRecoveryPending = false;
  };
  const settle = (recoverOrigin = false): void => {
    // Keyboard/browser animation can emit a resize after a reset attempt.
    // Measure it, but neither cancel nor extend the existing recovery tail.
    if (!recoverOrigin && originRecoveryPending) { sync(); return; }
    clearSettles();
    originRecoveryPending = recoverOrigin;
    const measure = (): void => {
      if (recoverOrigin) recoverDocumentOrigin();
      sync();
    };
    measure();
    if (document.visibilityState === 'hidden') { originRecoveryPending = false; return; }
    // A finite tail also covers wallet browsers that update viewport APIs
    // without another CSS resize. No permanent polling or keyboard guesses.
    settleTimers = [100, 350, 1000].map((delay) => setTimeout(() => {
      measure();
      if (delay === 1000) {
        originRecoveryPending = false;
        // A refused lifecycle correction cannot earn a fifth attempt from
        // its own delayed scroll event. A later new pan still can recover.
        if (recoverOrigin) panRecoveryArmed = !originPanned();
      }
    }, delay));
  };
  // Chrome can pan a fixed root long after navigation or toolbar settling.
  // Permit one correction per observed pan, never an unbounded feedback loop.
  const resize = (): void => { settle(); recoverObservedPan(); };
  const scroll = (): void => { sync(); recoverObservedPan(); };
  const restoreFrame = (): void => settle(true);
  window.addEventListener('resize', resize);
  window.addEventListener('scroll', scroll, { passive: true });
  window.addEventListener('orientationchange', restoreFrame);
  window.addEventListener('pageshow', restoreFrame);
  window.addEventListener('focus', restoreFrame);
  document.addEventListener('focusin', resize);
  document.addEventListener('focusout', restoreFrame);
  document.addEventListener('visibilitychange', restoreFrame);
  fullscreen?.addEventListener?.('change', restoreFrame);
  visual?.addEventListener('resize', resize);
  visual?.addEventListener('scroll', scroll);
  restoreFrame();
  return () => {
    clearSettles();
    observer?.disconnect();
    viewportObserver?.disconnect();
    dynamicViewport.remove();
    largeViewport?.remove();
    safeArea?.remove();
    window.removeEventListener('resize', resize);
    window.removeEventListener('scroll', scroll);
    window.removeEventListener('orientationchange', restoreFrame);
    window.removeEventListener('pageshow', restoreFrame);
    window.removeEventListener('focus', restoreFrame);
    document.removeEventListener('focusin', resize);
    document.removeEventListener('focusout', restoreFrame);
    document.removeEventListener('visibilitychange', restoreFrame);
    fullscreen?.removeEventListener?.('change', restoreFrame);
    visual?.removeEventListener('resize', resize);
    visual?.removeEventListener('scroll', scroll);
    root.style.removeProperty('--game-viewport-frame-height');
    root.style.removeProperty('--game-viewport-height');
    root.style.removeProperty('--game-ui-bottom-clearance');
    if (scrollRestoration !== null && history.scrollRestoration === 'manual') history.scrollRestoration = scrollRestoration;
  };
}
