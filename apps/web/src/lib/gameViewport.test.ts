// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGameViewport, readGameViewport, readGameUiViewport, readGameViewportDiagnostics, subscribeGameViewport, visibleParentInsets } from './gameViewport';
import { caps } from './platform';

vi.mock('./platform', () => ({ caps: { isIOS: false, isStandalone: false } }));

class Visual extends EventTarget { width = 390; height = 700; offsetLeft = 0; offsetTop = 0; scale = 1; }
const cleanup: Array<() => void> = [];
beforeEach(() => {
  caps.isIOS = false; caps.isStandalone = false;
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('scrollX', 0);
  vi.stubGlobal('scrollY', 0);
  vi.stubGlobal('screen', { width: 0, height: 0 });
});
afterEach(() => {
  cleanup.splice(0).reverse().forEach((fn) => fn());
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup(options: { height?: number; visualHeight?: number; noVisual?: boolean; safeBottom?: number } = {}) {
  const metrics = { dynamic: options.height ?? 844, large: options.height ?? 844, width: 390, safeBottom: options.safeBottom ?? 0 };
  const root = document.createElement('div'); root.id = 'root'; document.body.append(root);
  vi.spyOn(document.documentElement, 'clientWidth', 'get').mockImplementation(() => metrics.width);
  Object.defineProperties(root, {
    clientWidth: { get: () => metrics.width },
    clientHeight: { get: () => Number.parseFloat(root.style.getPropertyValue('--game-viewport-frame-height')) || metrics.dynamic },
  });
  const actualRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const viewportProbe = this.dataset.gameViewportProbe;
    return this === root ? DOMRect.fromRect({ width: root.clientWidth, height: root.clientHeight })
      : viewportProbe ? DOMRect.fromRect({ height: viewportProbe === 'large' ? metrics.large : metrics.dynamic }) : actualRect.call(this);
  });
  const actualStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => element instanceof HTMLElement && element.dataset.gameViewportProbe === 'safe'
    ? { paddingBottom: `${metrics.safeBottom}px` } as CSSStyleDeclaration : actualStyle(element, pseudo));
  const visual = new Visual(); visual.height = options.visualHeight ?? 700;
  vi.stubGlobal('visualViewport', options.noVisual ? undefined : visual);
  cleanup.push(installGameViewport());
  return { root, visual, metrics };
}

function focusInput() {
  const input = document.createElement('input');
  document.getElementById('root')!.append(input); input.focus();
  return input;
}

describe('visible game frame', () => {
  it('uses the CSS viewport on first paint despite a smaller stale inner/visual height', () => {
    vi.stubGlobal('innerHeight', 700);
    setup({ height: 844, visualHeight: 700 });
    // The old min(innerHeight, visualHeight) left144px blank until APIs caught up.
    expect(readGameViewport()).toEqual({ w: 390, h: 844 });
  });
  it('recovers browser-chrome expansion after its final resize event without a refresh', () => {
    vi.useFakeTimers();
    const { metrics } = setup({ height: 610, visualHeight: 610 });
    expect(readGameViewport().h).toBe(610);
    window.dispatchEvent(new Event('pageshow'));
    metrics.dynamic = 760; // CSS finishes animating; both JS metrics can stay stale.
    vi.advanceTimersByTime(350);
    expect(readGameViewport().h).toBe(760);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('remeasures an independently growing CSS viewport even when the root cannot resize', () => {
    const observed = new Map<Element, ResizeObserverCallback>();
    class Observer {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element) { observed.set(element, this.callback); }
      disconnect() { for (const [element, callback] of observed) if (callback === this.callback) observed.delete(element); }
    }
    vi.stubGlobal('ResizeObserver', Observer);
    const { root, metrics } = setup({ height: 610, visualHeight: 610 });
    expect(readGameViewport().h).toBe(610);
    metrics.dynamic = 780;
    expect(readGameViewport().h).toBe(610);
    const probe = document.querySelector('[data-game-viewport-probe=dynamic]')!;
    observed.get(probe)!([], {} as ResizeObserver);
    expect(readGameViewport().h).toBe(780);
    expect(root.getBoundingClientRect().bottom).toBe(780);
    cleanup.splice(0).forEach((fn) => fn());
    expect(observed.size).toBe(0);
    expect(document.querySelector('[data-game-viewport-probe]')).toBeNull();
  });
  it('fills the frame after keyboard dismissal even if VisualViewport still reports the keyboard', () => {
    vi.useFakeTimers();
    const { root } = setup({ visualHeight: 410 });
    const input = focusInput();
    expect(readGameViewport().h).toBe(410);
    input.blur();
    expect(readGameViewport().h).toBe(844);
    vi.advanceTimersByTime(1000);
    expect(vi.getTimerCount()).toBe(0);
    input.focus();
    expect(vi.getTimerCount()).toBe(3);
    cleanup.splice(0).forEach((fn) => fn());
    expect(vi.getTimerCount()).toBe(0);
    input.blur();
    expect(root.style.getPropertyValue('--game-viewport-frame-height')).toBe('');
  });
  it('releases a keyboard-clipped root during zoom without adopting magnified CSS metrics', () => {
    const { visual, metrics } = setup({ visualHeight: 420 });
    const input = focusInput();
    expect(readGameViewport().h).toBe(420);
    visual.scale = 2; visual.height = 210; metrics.dynamic = 422;
    visual.dispatchEvent(new Event('resize'));
    expect(readGameViewport().h).toBe(420);
    input.blur();
    expect(readGameViewport().h).toBe(844); // restore the independent pre-keyboard frame
    metrics.dynamic = 300; visual.dispatchEvent(new Event('scroll'));
    expect(readGameViewport().h).toBe(844); // ordinary native zoom remains frozen
  });
  it('discards a saved portrait keyboard frame when zoomed rotation establishes a new layout', () => {
    const { visual, metrics } = setup({ visualHeight: 420 });
    const input = focusInput();
    expect(readGameViewport().h).toBe(420);
    visual.scale = 2; metrics.width = 844; metrics.dynamic = 320;
    window.dispatchEvent(new Event('orientationchange'));
    expect(readGameViewport().h).toBe(320);
    input.blur();
    expect(readGameViewport()).toEqual({ w: 844, h: 320 });
  });
  it('moves navigation with measured browser chrome and publishes the actual shared frame', () => {
    const { root, metrics } = setup({ height: 700 });
    expect(root.style.getPropertyValue('--game-viewport-height')).toBe('700px');
    const listener = vi.fn(); cleanup.push(subscribeGameViewport(listener));
    metrics.dynamic = 620; window.dispatchEvent(new Event('resize'));
    expect(readGameViewport().h).toBe(620); expect(listener).toHaveBeenCalled();
    metrics.dynamic = 844; window.dispatchEvent(new Event('resize'));
    expect(readGameViewport().h).toBe(844);
  });
  it('clips a focused form to the keyboard once while preserving the root origin', () => {
    const { root, visual } = setup();
    focusInput();
    visual.offsetTop = 80; visual.height = 420; visual.dispatchEvent(new Event('scroll'));
    expect(readGameViewport().h).toBe(500);
    expect(root.style.top).toBe(''); expect(root.style.transform).toBe('');
    expect(visibleParentInsets({ top: 0, bottom: 500 }, visual)).toEqual({ top: 80, bottom: 0 });
  });
  it('restores visible top and bottom after page restoration without growing the frame', () => {
    vi.useFakeTimers();
    const { root } = setup();
    vi.stubGlobal('scrollY', 140);
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({
      y: -window.scrollY || 0, width: 390, height: root.clientHeight,
    }));
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      vi.stubGlobal('scrollY', 0);
      window.dispatchEvent(new Event('scroll'));
    });
    expect(root.getBoundingClientRect().top).toBe(-140);
    expect(root.getBoundingClientRect().bottom).toBe(704);
    window.dispatchEvent(new Event('pageshow'));
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(root.getBoundingClientRect().top).toBe(0);
    expect(root.getBoundingClientRect().bottom).toBe(844);
    expect(readGameViewport().h).toBe(844);
    expect(root.style.top).toBe(''); expect(root.style.transform).toBe('');
    for (let n = 0; n < 5; n++) window.dispatchEvent(new Event('scroll'));
    vi.advanceTimersByTime(1000);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears an already-restored document offset before the first React frame', () => {
    const { root } = setup();
    cleanup.splice(0).forEach(fn => fn());
    vi.stubGlobal('scrollY', 140);
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => { vi.stubGlobal('scrollY', 0); });
    cleanup.push(installGameViewport());
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(root.clientHeight).toBe(844);
  });
  it('recovers retained visual pan only when the root is visibly displaced', () => {
    const { root, visual } = setup();
    visual.offsetTop = 140;
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => { visual.offsetTop = 0; });
    window.dispatchEvent(new Event('pageshow'));
    expect(scroll).not.toHaveBeenCalled(); // an API offset alone is not a clipped frame
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ y: -visual.offsetTop, height: root.clientHeight }));
    window.dispatchEvent(new Event('pageshow'));
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(root.getBoundingClientRect().bottom).toBe(844);
  });
  it('bounds unsuccessful origin recovery and never retries it from scroll/resize feedback', () => {
    vi.useFakeTimers();
    setup(); vi.stubGlobal('scrollY', 140);
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      window.dispatchEvent(new Event('scroll')); // WebKit has not released its pan
      window.dispatchEvent(new Event('resize')); // its animation must not cancel or extend the bounded tail
    });
    window.dispatchEvent(new Event('pageshow'));
    vi.advanceTimersByTime(10_000);
    expect(scroll).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    for (let n = 0; n < 5; n++) {
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('resize'));
    }
    vi.advanceTimersByTime(10_000);
    expect(scroll).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves keyboard and native zoom pan, then restores the document after text blur', () => {
    const { visual } = setup();
    const input = focusInput();
    vi.stubGlobal('scrollY', 140);
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => { vi.stubGlobal('scrollY', 0); });
    window.dispatchEvent(new Event('pageshow'));
    expect(scroll).not.toHaveBeenCalled();
    visual.scale = 2; input.blur();
    window.dispatchEvent(new Event('orientationchange'));
    expect(scroll).not.toHaveBeenCalled();
    visual.scale = 1; input.focus(); input.blur();
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 0);
  });
  it.each(['window-scroll', 'visual-scroll', 'window-resize', 'visual-resize'])('recovers a new pan outside the lifecycle tail from %s', (event) => {
    vi.useFakeTimers();
    const { root, visual } = setup();
    vi.advanceTimersByTime(1500);
    vi.stubGlobal('scrollY', 112);
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ y: -window.scrollY || 0, height: root.clientHeight }));
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      vi.stubGlobal('scrollY', 0);
      window.dispatchEvent(new Event('scroll'));
    });
    const [target, type = 'scroll'] = event.split('-');
    (target === 'window' ? window : visual).dispatchEvent(new Event(type));
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(root.getBoundingClientRect().top).toBe(0);
    expect(root.getBoundingClientRect().bottom).toBe(844);
  });
  it('does not retry a refused late pan until rest and a genuinely new pan are observed', () => {
    vi.useFakeTimers();
    const { visual } = setup(); vi.advanceTimersByTime(1500);
    vi.stubGlobal('scrollY', 112);
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => {
      window.dispatchEvent(new Event('scroll')); // synchronous feedback cannot recurse
    });
    window.dispatchEvent(new Event('scroll'));
    for (let n = 0; n < 5; n++) {
      window.dispatchEvent(new Event('scroll'));
      visual.dispatchEvent(new Event('resize')); // asynchronous feedback cannot retry either
    }
    vi.advanceTimersByTime(10_000);
    expect(scroll).toHaveBeenCalledTimes(1);
    vi.stubGlobal('scrollY', 0); visual.dispatchEvent(new Event('scroll'));
    vi.stubGlobal('scrollY', 112); visual.dispatchEvent(new Event('scroll'));
    expect(scroll).toHaveBeenCalledTimes(2);
  });
  it('corrects late visual pan only when the root is displaced, preserving an offset-only viewport', () => {
    vi.useFakeTimers();
    const { root, visual } = setup(); vi.advanceTimersByTime(1500);
    visual.offsetTop = 112;
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => { visual.offsetTop = 0; });
    visual.dispatchEvent(new Event('scroll'));
    expect(scroll).not.toHaveBeenCalled();
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ y: -visual.offsetTop, height: root.clientHeight }));
    visual.dispatchEvent(new Event('scroll'));
    expect(scroll).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(root.getBoundingClientRect().bottom).toBe(844);
  });
  it.each(['hidden', 'focused', 'zoomed'])('leaves late %s pans alone', (guard) => {
    vi.useFakeTimers();
    const { visual } = setup(); vi.advanceTimersByTime(1500);
    if (guard === 'hidden') vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    if (guard === 'focused') { focusInput(); vi.advanceTimersByTime(1500); }
    if (guard === 'zoomed') visual.scale = 2;
    vi.stubGlobal('scrollY', 112);
    const scroll = vi.spyOn(window, 'scrollTo');
    window.dispatchEvent(new Event('scroll')); visual.dispatchEvent(new Event('resize'));
    vi.advanceTimersByTime(1500);
    expect(scroll).not.toHaveBeenCalled();
  });
  it('restores document pan on visible resume and rotation, but never in a hidden tab', () => {
    setup(); vi.stubGlobal('scrollY', 140);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const scroll = vi.spyOn(window, 'scrollTo').mockImplementation(() => { vi.stubGlobal('scrollY', 0); });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(scroll).not.toHaveBeenCalled();
    hidden.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange'));
    expect(scroll).toHaveBeenCalledTimes(1);
    vi.stubGlobal('scrollY', 140); window.dispatchEvent(new Event('orientationchange'));
    expect(scroll).toHaveBeenCalledTimes(2);
  });
  it('publishes changed frame origin even when dimensions stay the same', () => {
    const { root } = setup();
    let top = 0;
    vi.spyOn(root, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ y: top, width: 390, height: 844 }));
    const listener = vi.fn(); cleanup.push(subscribeGameViewport(listener));
    top = -140; window.dispatchEvent(new Event('scroll'));
    expect(listener).toHaveBeenCalledTimes(1);
    window.dispatchEvent(new Event('scroll'));
    expect(listener).toHaveBeenCalledTimes(1);
    top = 0; window.dispatchEvent(new Event('scroll'));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(readGameViewport()).toEqual({ w: 390, h: 844 });
  });
  it('keeps document scroll restoration manual only during the installed game lifecycle', () => {
    const gameHistory = { scrollRestoration: 'auto' };
    vi.stubGlobal('history', gameHistory);
    setup();
    expect(gameHistory.scrollRestoration).toBe('manual');
    cleanup.splice(0).forEach(fn => fn());
    expect(gameHistory.scrollRestoration).toBe('auto');
  });
  it('reports viewport geometry for local diagnostics without collecting focused values', () => {
    const { visual } = setup();
    expect(readGameViewportDiagnostics()).toEqual({
      root: { x: 0, y: 0, width: 390, height: 844 }, dynamicHeight: 844,
      largeHeight: null, screenExtent: null, safeBottom: 0, uiHeight: 844, bottomClearance: 0, canvasContainer: null, canvas: null,
      inner: { width: 390, height: 844 }, scroll: { x: 0, y: 0 },
      visual: { width: 390, height: 700, offsetLeft: 0, offsetTop: 0, scale: 1 }, editableFocused: false,
    });
    const input = focusInput(); input.value = 'never diagnostic content';
    visual.offsetTop = 80; vi.stubGlobal('scrollY', 80);
    const diagnostics = readGameViewportDiagnostics();
    expect(diagnostics.editableFocused).toBe(true);
    expect(diagnostics.scroll.y).toBe(80);
    expect(diagnostics.visual?.offsetTop).toBe(80);
    expect(JSON.stringify(diagnostics)).not.toContain(input.value);
  });
  it('freezes the entire unzoomed frame when native pinch also changes CSS and innerHeight', () => {
    const { root, visual, metrics } = setup({ height: 700 });
    visual.scale = 1.5; visual.height = 450; metrics.dynamic = 450;
    vi.stubGlobal('innerHeight', 450); visual.dispatchEvent(new Event('resize'));
    expect(readGameViewport().h).toBe(700);
    expect(root.style.getPropertyValue('--game-viewport-frame-height')).toBe('700px');
    cleanup.splice(0).forEach((fn) => fn());
    visual.scale = 1; visual.height = 400; visual.dispatchEvent(new Event('resize'));
    expect(root.style.getPropertyValue('--game-viewport-frame-height')).toBe('');
  });
  it('does not extend the frozen frame while panning a browser-zoomed page', () => {
    const { root, visual } = setup({ height: 700 });
    visual.scale = 2; visual.height = 350; visual.offsetTop = 180;
    visual.dispatchEvent(new Event('resize'));
    for (let n = 0; n < 5; n++) visual.dispatchEvent(new Event('scroll'));
    expect(readGameViewport().h).toBe(700);
    expect(root.style.top).toBe(''); expect(root.style.transform).toBe('');
    visual.scale = 1; visual.height = 700; visual.offsetTop = 0;
    visual.dispatchEvent(new Event('resize'));
    expect(readGameViewport().h).toBe(700);
  });
  it('remeasures actual landscape layout even if native zoom is still active', () => {
    const { visual, metrics } = setup({ height: 844 });
    visual.scale = 2; visual.height = 160;
    metrics.width = 844; metrics.dynamic = 320;
    window.dispatchEvent(new Event('orientationchange'));
    expect(readGameViewport()).toEqual({ w: 844, h: 320 });
    visual.scale = 1; metrics.width = 390; metrics.dynamic = 844;
    window.dispatchEvent(new Event('orientationchange'));
    expect(readGameViewport()).toEqual({ w: 390, h: 844 });
  });
  it('starts safely when a restored page is already browser-zoomed', () => {
    const { visual } = setup({ height: 844 });
    cleanup.splice(0).forEach((fn) => fn());
    visual.scale = 2; visual.height = 422;
    cleanup.push(installGameViewport());
    expect(readGameViewport().h).toBe(844);
  });
  it('does not subtract keyboard height twice or escape a nested parent', () => {
    expect(visibleParentInsets({ top: 0, bottom: 492 }, { offsetTop: 0, height: 492 })).toEqual({ top: 0, bottom: 0 });
    expect(visibleParentInsets({ top: 100, bottom: 600 }, { offsetTop: 80, height: 420 })).toEqual({ top: 0, bottom: 100 });
    expect(visibleParentInsets({ top: 0, bottom: 100 }, { offsetTop: 120, height: 200 })).toEqual({ top: 100, bottom: 0 });
  });
  it('preserves the CSS frame when VisualViewport is unavailable', () => {
    setup({ height: 780, noVisual: true });
    expect(readGameViewport()).toEqual({ w: 390, h: 780 });
  });
  it('falls back to innerHeight if CSS viewport measurement is unavailable', () => {
    setup({ height: 0, noVisual: true });
    expect(readGameViewport().h).toBe(844);
  });
  it('does not trust a stale smaller layout API over an expanded dynamic viewport', () => {
    const { metrics } = setup();
    vi.stubGlobal('innerHeight', 620); window.dispatchEvent(new Event('resize'));
    expect(readGameViewport().h).toBe(844);
    metrics.dynamic = 320; window.dispatchEvent(new Event('resize'));
    expect(readGameViewport().h).toBe(320);
  });
  it.each(['textarea', 'contenteditable'] as const)('clips a focused %s above the keyboard', (kind) => {
    const { root } = setup({ visualHeight: 400 });
    const field = document.createElement(kind === 'textarea' ? 'textarea' : 'div');
    if (kind === 'contenteditable') { field.contentEditable = 'true'; field.tabIndex = 0; }
    root.append(field); field.focus();
    expect(readGameViewport().h).toBe(400);
  });
  it.each(['button', 'checkbox', 'range'] as const)('does not treat focused %s as an open keyboard', (type) => {
    const { root } = setup({ visualHeight: 400 });
    const field = document.createElement('input'); field.type = type;
    root.append(field); field.focus();
    expect(readGameViewport().h).toBe(844);
  });
  it('keeps the outer document fixed while allowing accessible native browser zoom', () => {
    const css = readFileSync(`${process.cwd()}/src/styles.css`, 'utf8');
    const html = readFileSync(`${process.cwd()}/index.html`, 'utf8');
    expect(css).toMatch(/html,\s*body\s*\{[^}]*overflow:\s*hidden/s);
    expect(css).toMatch(/#root\s*\{[^}]*position:\s*fixed;[^}]*inset:\s*0;[^}]*height:\s*var\(--game-viewport-frame-height,\s*100dvh\)/s);
    const viewport = html.match(/<meta name="viewport"[^>]+>/)?.[0];
    expect(viewport).toContain('viewport-fit=cover');
    expect(viewport).not.toMatch(/maximum-scale|user-scalable/);
  });
});

const PHANTOM_IOS = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Phantom/ios/26.28.0.50429';
function phantom() {
  caps.isIOS = true;
  vi.stubGlobal('navigator', { userAgent: PHANTOM_IOS });
  vi.stubGlobal('innerHeight', 894);
  vi.stubGlobal('screen', { width: 440, height: 956 });
  return setup({ height: 894, visualHeight: 894, safeBottom: 34 });
}

describe('measured Phantom iOS native toolbar', () => {
  it('observes safe padding changes even when no window or viewport resize fires', () => {
    const observed = new Map<Element, { callback: ResizeObserverCallback; options: ResizeObserverOptions | undefined }>();
    class Observer {
      constructor(private callback: ResizeObserverCallback) {}
      observe(element: Element, options?: ResizeObserverOptions) { observed.set(element, { callback: this.callback, options }); }
      disconnect() { for (const [element, row] of observed) if (row.callback === this.callback) observed.delete(element); }
    }
    vi.stubGlobal('ResizeObserver', Observer);
    const { metrics } = phantom(); metrics.dynamic = metrics.large = 807; metrics.safeBottom = 0;
    window.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(807);
    const probe = document.querySelector('[data-game-viewport-probe=safe]')!;
    const observer = observed.get(probe)!;
    expect(observer.options).toEqual({ box: 'border-box' }); // only padding changes, so content-box never fires
    metrics.safeBottom = 34;
    observer.callback([], {} as ResizeObserver);
    expect(readGameUiViewport().h).toBe(743);
    cleanup.splice(0).forEach(fn => fn());
    expect(observed.size).toBe(0);
    expect(document.querySelector('[data-game-viewport-probe=safe]')).toBeNull();
  });
  it('does not reserve a second toolbar when newer Phantom already ends the WebView above it', () => {
    const { root, metrics } = phantom();
    metrics.dynamic = metrics.large = 807; metrics.safeBottom = 0;
    window.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(807);
    expect(root.style.getPropertyValue('--game-ui-bottom-clearance')).toBe('0px');
    expect(readGameViewportDiagnostics()).toMatchObject({ screenExtent: 956, safeBottom: 0, bottomClearance: 0 });
    const listener = vi.fn(); cleanup.push(subscribeGameViewport(listener));
    metrics.dynamic = metrics.large = 894; metrics.safeBottom = 34;
    window.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(830);
    expect(listener).toHaveBeenCalled();
  });
  it.each([
    { screen: { width: 375, height: 667 }, height: 647, expected: 583 },
    { screen: { width: 375, height: 667 }, height: 592, expected: 592 },
    { screen: { width: 440, height: 956 }, height: 894, expected: 830 },
    { screen: { width: 0, height: 0 }, height: 894, expected: 830 },
  ])('retains only unreported native chrome for a zero-safe-area frame $height on $screen.height', ({ screen, height, expected }) => {
    const { metrics } = phantom(); vi.stubGlobal('screen', screen);
    metrics.dynamic = metrics.large = height; metrics.safeBottom = 0;
    window.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(expected);
  });
  it('measures the physical landscape axis and rechecks safe-area changes within one frame size', () => {
    const { metrics } = phantom(); metrics.width = 956; metrics.dynamic = metrics.large = 350; metrics.safeBottom = 0;
    window.dispatchEvent(new Event('orientationchange'));
    expect(readGameViewportDiagnostics()).toMatchObject({ screenExtent: 440, bottomClearance: 0 });
    expect(readGameUiViewport().h).toBe(350);
    const listener = vi.fn(); cleanup.push(subscribeGameViewport(listener));
    metrics.safeBottom = 21;
    window.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(286);
    expect(listener).toHaveBeenCalled();
  });
  it('paints the entire first frame when Phantom APIs include OR already exclude the native toolbar', () => {
    const { root, metrics } = phantom();
    expect(root.clientHeight).toBe(894);
    metrics.dynamic = metrics.large = 830;
    window.dispatchEvent(new Event('resize'));
    // Equal CSS metrics cannot prove whether a native bar is omitted. Only
    // controls may retain a conservative clearance; artwork must fill both.
    expect(root.clientHeight).toBe(830);
  });
  it.each([320, 160, 64, 40])('keeps short landscape %spx drawable while control clearance never makes the usable frame negative', (height) => {
    const { root, metrics } = phantom();
    metrics.width = 844; metrics.dynamic = metrics.large = height;
    window.dispatchEvent(new Event('orientationchange'));
    expect(root.clientHeight).toBe(height);
    expect(readGameUiViewport().h).toBeGreaterThanOrEqual(0);
    expect(readGameUiViewport().h).toBeLessThanOrEqual(height);
    expect(readGameViewportDiagnostics().bottomClearance).toBeLessThanOrEqual(height);
  });
  it('publishes control-only changes even when a fullscreen toolbar changes without resizing the painting', () => {
    class Fullscreen extends EventTarget { matches = false; }
    const fullscreen = new Fullscreen(); vi.stubGlobal('matchMedia', () => fullscreen);
    const { root } = phantom();
    const listener = vi.fn(); cleanup.push(subscribeGameViewport(listener));
    expect(root.clientHeight).toBe(894);
    fullscreen.matches = true; fullscreen.dispatchEvent(new Event('change'));
    expect(root.clientHeight).toBe(894);
    expect(readGameUiViewport().h).toBe(894);
    expect(listener).toHaveBeenCalledTimes(1);
  });
  it('reserves the unreported toolbar once and retains safe-area handling', () => {
    const { root } = phantom();
    expect(readGameUiViewport().h).toBe(830);
    expect(root.style.top).toBe(''); expect(root.style.transform).toBe('');
    expect(root.style.paddingBottom).toBe('');
    expect(document.body.children).toHaveLength(4);
    cleanup.splice(0).forEach((fn) => fn());
    expect(document.body.children).toHaveLength(1);
  });
  it.each(['visual-keyboard', 'dynamic'] as const)('does not add another reserve when %s reports occlusion', (metric) => {
    const { visual, metrics } = phantom();
    if (metric === 'visual-keyboard') { focusInput(); visual.height = 794; }
    else metrics.dynamic = 794;
    window.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(794);
  });
  it('takes the larger of a partial keyboard occlusion and the toolbar allowance', () => {
    const { visual } = phantom(); focusInput();
    visual.height = 864; visual.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(830);
  });
  it('keeps the full keyboard frame when CSS and visualViewport shrink', () => {
    const { root, visual, metrics } = phantom(); focusInput();
    vi.stubGlobal('innerHeight', 500); metrics.dynamic = 500;
    visual.offsetTop = 80; visual.height = 420; visual.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(500);
    expect(visibleParentInsets({ top: 0, bottom: root.clientHeight }, visual)).toEqual({ top: 80, bottom: 0 });
    vi.stubGlobal('innerHeight', 894); metrics.dynamic = 894;
    visual.offsetTop = 0; visual.height = 894; window.dispatchEvent(new Event('focus'));
    expect(readGameUiViewport().h).toBe(830);
  });
  it('keeps the unzoomed frame during pinch and remeasures landscape on normal resize', () => {
    const { visual, metrics } = phantom();
    visual.scale = 1.5; visual.height = 500; visual.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(830);
    visual.scale = 1; visual.height = 440; metrics.width = 844; metrics.dynamic = 440; metrics.large = 440;
    vi.stubGlobal('innerHeight', 440); window.dispatchEvent(new Event('orientationchange'));
    expect(readGameUiViewport().h).toBe(376);
    visual.height = 894; metrics.width = 390; metrics.dynamic = 894; metrics.large = 894;
    vi.stubGlobal('innerHeight', 894); window.dispatchEvent(new Event('pageshow'));
    expect(readGameUiViewport().h).toBe(830);
  });
  it('restores the toolbar-bounded frame when dismissing a keyboard while still zoomed', () => {
    const { visual, metrics } = phantom();
    const input = focusInput();
    visual.height = 420; visual.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(420);
    visual.scale = 2; metrics.dynamic = 447; visual.dispatchEvent(new Event('resize'));
    input.blur();
    expect(readGameUiViewport().h).toBe(830); // preserve the reviewed native-toolbar allowance
  });
  it('never accumulates a scroll allowance under the Phantom toolbar during pinch', () => {
    const { visual } = phantom();
    visual.scale = 1.5; visual.height = 500; visual.offsetTop = 220;
    for (let n = 0; n < 5; n++) visual.dispatchEvent(new Event('resize'));
    expect(readGameUiViewport().h).toBe(830);
  });
  it('retains the toolbar bound without VisualViewport', () => {
    caps.isIOS = true; vi.stubGlobal('navigator', { userAgent: PHANTOM_IOS });
    vi.stubGlobal('innerHeight', 894);
    setup({ height: 894, noVisual: true });
    expect(readGameUiViewport().h).toBe(830);
  });
  it('does not reserve toolbar space when the app is fullscreen', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    phantom();
    expect(readGameUiViewport().h).toBe(894);
    expect(document.body.children).toHaveLength(4);
  });
  it('restores the toolbar allowance after leaving fullscreen without a window resize', () => {
    class Fullscreen extends EventTarget { matches = true; }
    const fullscreen = new Fullscreen();
    vi.stubGlobal('matchMedia', () => fullscreen);
    const { root } = phantom();
    expect(readGameUiViewport().h).toBe(894);
    fullscreen.matches = false; fullscreen.dispatchEvent(new Event('change'));
    expect(readGameUiViewport().h).toBe(830);
    fullscreen.matches = true; fullscreen.dispatchEvent(new Event('change'));
    expect(readGameUiViewport().h).toBe(894);
    cleanup.splice(0).forEach((fn) => fn());
    fullscreen.matches = false; fullscreen.dispatchEvent(new Event('change'));
    expect(root.style.getPropertyValue('--game-viewport-frame-height')).toBe('');
  });
  it.each([
    { name: 'Safari', ios: true, standalone: false, ua: PHANTOM_IOS.replace(/ Phantom\/ios\/.+/, '') },
    { name: 'iPhone Chrome', ios: true, standalone: false, ua: 'Mozilla/5.0 (iPhone) CriOS/145 Mobile Safari/604.1' },
    { name: 'Android Phantom', ios: false, standalone: false, ua: 'Mozilla/5.0 (Linux; Android 15) Phantom/android/26' },
    { name: 'desktop', ios: false, standalone: false, ua: 'Mozilla/5.0 (Macintosh) Chrome/145' },
    { name: 'installed iOS app', ios: true, standalone: true, ua: PHANTOM_IOS },
  ])('does not reserve Phantom toolbar space in $name', ({ ios, standalone, ua }) => {
    caps.isIOS = ios; caps.isStandalone = standalone; vi.stubGlobal('navigator', { userAgent: ua });
    setup({ visualHeight: 844 });
    expect(readGameUiViewport().h).toBe(844);
    expect(document.body.children).toHaveLength(2);
    expect(document.querySelector('[data-game-viewport-probe=large]')).toBeNull();
  });
});
