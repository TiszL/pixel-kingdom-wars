/** @vitest-environment happy-dom */
import type { ChatMessage } from '@shardkeep/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { installGameViewport } from '../../lib/gameViewport';
import ChatScreen, { chatAvatarUrl, chatNearBottom } from './ChatScreen';
import { chatApi, type ChatStatus } from './protocol';

const STATUS: ChatStatus = {
  enabled: true, canSend: true, sendBlockedReason: null, mutedUntil: null,
  pollOpenMs: 2_000, pollClosedMs: 20_000, latestEventId: '10',
};

const hostile: ChatMessage & { canBlock: boolean } = {
  id: '10', clientMessageId: 'remote-10',
  text: '<img src=x onerror=alert(1)>\n<script>alert(2)</script>',
  createdAt: '2026-08-13T10:00:00.000Z',
  author: { name: '<svg/onload=alert(3)>', avatarUrl: null, seekerVerified: true },
  canBlock: true,
};

const roots: Root[] = [];

async function mount(onClose = vi.fn()): Promise<{ host: HTMLDivElement; onClose: typeof onClose }> {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => {
    root.render(<ChatScreen initialStatus={STATUS} initialCursor="10" onClose={onClose} />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, onClose };
}

async function change(target: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(target, value);
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
    await Promise.resolve();
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** The dock breakpoint (M23 a5) makes viewport an INPUT to this suite: ≥900×600
 * renders the desktop dock, below it the mobile full-screen modal. Tests set
 * it explicitly so the environment default can never silently pick the mode. */
function setViewport(w: number, h: number): void {
  (window as unknown as { innerWidth: number }).innerWidth = w;
  (window as unknown as { innerHeight: number }).innerHeight = h;
  window.dispatchEvent(new Event('resize'));
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  setViewport(390, 844); // phone by default; dock tests opt in explicitly
  vi.spyOn(chatApi, 'status').mockResolvedValue(STATUS);
  vi.spyOn(chatApi, 'history').mockResolvedValue({ messages: [], nextBefore: null });
  vi.spyOn(chatApi, 'events').mockImplementation(() => new Promise(() => undefined));
  vi.spyOn(chatApi, 'report').mockResolvedValue(undefined);
  vi.spyOn(chatApi, 'blocks').mockResolvedValue({ blocks: [], nextBefore: null });
  vi.spyOn(chatApi, 'unblock').mockResolvedValue(undefined);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
    await Promise.resolve();
  });
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mobile global chat', () => {
  it('keeps controls above native toolbar clearance while the underlying game paints the whole viewport', async () => {
    setViewport(440, 894);
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    game.style.setProperty('--game-ui-bottom-clearance', '64px');
    Object.defineProperties(game, { clientWidth: { value: 440 }, clientHeight: { value: 894 } });
    let rootTop = 0;
    vi.spyOn(game, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ y: rootTop, width: 440, height: 894 }));
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { scale: 1, height: 894, offsetTop: 0 }));
    const { host } = await mount();
    expect(host.querySelector<HTMLElement>('[role="dialog"]')!.style.height).toBe('830px');
    await act(async () => {
      host.querySelector('textarea')!.focus(); rootTop = -160;
      window.dispatchEvent(new Event('scroll'));
    });
    expect(host.querySelector<HTMLElement>('[role="dialog"]')!.style.height).toBe('830px');
    expect(game.clientHeight).toBe(894);
  });

  it('keeps Phantom composer inside the game frame and intersects keyboard scrolling only once', async () => {
    setViewport(440, 894);
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    let gameHeight = 830; // existing viewport installer already reserved the toolbar
    let gameTop = 0;
    vi.spyOn(game, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ y: gameTop, height: gameHeight }));
    Object.defineProperties(game, {
      clientWidth: { get: () => 440 }, clientHeight: { get: () => gameHeight },
    });
    const visual = Object.assign(new EventTarget(), { height: 894, offsetTop: 0, scale: 1 });
    vi.stubGlobal('visualViewport', visual);
    const { host } = await mount();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.style.height).toBe('830px');
    expect(dialog.style.top).toBe('0px');
    expect(host.querySelector('textarea')).not.toBeNull();
    expect(host.querySelector('button[aria-label="Close global chat"]')).not.toBeNull();

    await act(async () => {
      host.querySelector('textarea')!.blur(); // no keyboard: retain the measured native-toolbar boundary
      gameTop = -333; gameHeight = 1163;
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('pkw:game-viewport'));
    });
    expect(dialog.style.height).toBe('830px'); // 1163px document frame ends at830, not894

    await act(async () => {
      host.querySelector('textarea')!.focus();
      gameHeight = 833; visual.offsetTop = 80; visual.height = 420;
      visual.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('pkw:game-viewport'));
    });
    expect(dialog.style.top).toBe('80px');
    expect(dialog.style.height).toBe('420px');
    await act(async () => {
      visual.scale = 2; visual.height = 210; visual.offsetTop = 140;
      visual.dispatchEvent(new Event('resize'));
    });
    expect(dialog.style.top).toBe('80px');
    expect(dialog.style.height).toBe('420px');
    await act(async () => {
      host.querySelector('textarea')!.blur();
      gameHeight = 1163; visual.scale = 1; visual.height = 894; visual.offsetTop = 0;
      visual.dispatchEvent(new Event('resize'));
      window.dispatchEvent(new Event('pkw:game-viewport'));
    });
    expect(dialog.style.height).toBe('830px');
    expect(dialog.style.top).toBe('0px');
    await act(async () => {
      gameTop = 0; gameHeight = 830;
      window.dispatchEvent(new Event('scroll'));
      window.dispatchEvent(new Event('pkw:game-viewport'));
    });
    expect(dialog.style.height).toBe('830px');
  });

  it('uses actual root bounds for a scrolled fixed composer without visualViewport', async () => {
    setViewport(440, 894);
    vi.stubGlobal('visualViewport', undefined);
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    Object.defineProperties(game, { clientWidth: { value: 440 }, clientHeight: { value: 1163 } });
    vi.spyOn(game, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ y: -333, height: 1163 }));
    const { host } = await mount();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.style.height).toBe('830px');
    expect(dialog.style.top).toBe('0px');
  });

  it('opens while already pinched using the unzoomed root bounds', async () => {
    setViewport(440, 894);
    vi.stubGlobal('visualViewport', Object.assign(new EventTarget(), { scale: 2, height: 447, offsetTop: 100 }));
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    Object.defineProperties(game, { clientWidth: { value: 440 }, clientHeight: { value: 1163 } });
    vi.spyOn(game, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ y: -333, height: 1163 }));
    const { host } = await mount();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.style.height).toBe('830px');
    expect(dialog.style.top).toBe('0px');
  });

  it('ignores a stale smaller visual viewport until an editable field owns the keyboard', async () => {
    const visual = Object.assign(new EventTarget(), { scale: 1, height: 420, offsetTop: 0 });
    vi.stubGlobal('visualViewport', visual);
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    Object.defineProperties(game, { clientWidth: { value: 390 }, clientHeight: { value: 844 } });
    vi.spyOn(game, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ height: 844 }));
    const { host } = await mount();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const composer = host.querySelector('textarea')!;
    // Chat intentionally autofocuses its composer. Dismiss it to exercise
    // the unfocused stale-metric path, then explicitly reopen the keyboard.
    await act(async () => composer.blur());
    expect(dialog.style.height).toBe('844px');
    await act(async () => composer.focus());
    expect(dialog.style.height).toBe('420px');
    await act(async () => composer.blur());
    expect(dialog.style.height).toBe('844px'); // dismissal need not wait for stale APIs
  });

  it('releases the real game root and chat keyboard intersection during accessibility zoom', async () => {
    const visual = Object.assign(new EventTarget(), { scale: 1, height: 420, offsetTop: 30 });
    vi.stubGlobal('visualViewport', visual);
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    let dynamicHeight = 844;
    Object.defineProperties(game, { clientWidth: { value: 390 },
      clientHeight: { get: () => Number.parseFloat(game.style.getPropertyValue('--game-viewport-frame-height')) || dynamicHeight } });
    const actualRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this === game ? DOMRect.fromRect({ height: game.clientHeight })
        : this.dataset.gameViewportProbe ? DOMRect.fromRect({ height: dynamicHeight }) : actualRect.call(this);
    });
    const disposeViewport = installGameViewport();
    const add = vi.spyOn(document, 'addEventListener'), remove = vi.spyOn(document, 'removeEventListener');
    try {
      const { host } = await mount();
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      const composer = host.querySelector('textarea')!;
      await act(async () => composer.focus());
      expect(dialog.style.height).toBe('420px'); expect(dialog.style.top).toBe('30px');
      expect(game.clientHeight).toBe(450); // the real installer also owns the keyboard cap
      await act(async () => {
        visual.scale = 2; visual.height = 210; visual.offsetTop = 80;
        dynamicHeight = 422;
        visual.dispatchEvent(new Event('resize'));
      });
      expect(dialog.style.height).toBe('420px'); // pinch alone must not reflow chat
      await act(async () => composer.blur());
      // No scale-one resize or root event is required to release the old keyboard
      // intersection. The true game frame remains the layout authority at scale 2.
      expect(dialog.style.height).toBe('844px'); expect(dialog.style.top).toBe('0px');
      expect(game.clientHeight).toBe(844);
      const focusout = add.mock.calls.find(([name]) => name === 'focusout')![1];
      await act(async () => roots.pop()!.unmount());
      expect(remove).toHaveBeenCalledWith('focusout', focusout);
    } finally { disposeViewport(); }
  });

  it.each([0, 80])('fills the keyboard viewport at offset %s after WebKit pans the already-capped root', async (offsetTop) => {
    const visual = Object.assign(new EventTarget(), { scale: 1, height: 844, offsetTop: 0 });
    vi.stubGlobal('visualViewport', visual);
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    let width = 390, dynamicHeight = 844, rootTop = 0;
    Object.defineProperties(document.documentElement, { clientWidth: { configurable: true, get: () => width } });
    Object.defineProperties(game, {
      clientWidth: { get: () => width },
      clientHeight: { get: () => Number.parseFloat(game.style.getPropertyValue('--game-viewport-frame-height')) || dynamicHeight },
    });
    const actualRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this === game ? DOMRect.fromRect({ y: rootTop, width, height: game.clientHeight })
        : this.dataset.gameViewportProbe ? DOMRect.fromRect({ height: dynamicHeight }) : actualRect.call(this);
    });
    vi.spyOn(window, 'scrollTo').mockImplementation(() => { rootTop = 0; });
    const disposeViewport = installGameViewport();
    try {
      const { host } = await mount();
      const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
      const composer = host.querySelector('textarea')!;
      expect(Number.parseFloat(composer.style.fontSize)).toBeGreaterThanOrEqual(16);
      await act(async () => {
        composer.focus(); rootTop = -260; visual.height = 420; visual.offsetTop = offsetTop;
        visual.dispatchEvent(new Event('resize')); window.dispatchEvent(new Event('scroll'));
      });
      expect(game.clientHeight).toBe(offsetTop + 420); // shared installer applied the keyboard cap
      expect(dialog.style.top).toBe(`${offsetTop}px`);
      expect(dialog.style.height).toBe('420px'); // the message log retains all space above the composer
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      await act(async () => {
        visual.scale = 2; visual.height = 210; visual.offsetTop = offsetTop + 60;
        visual.dispatchEvent(new Event('resize'));
      });
      expect(dialog.style.height).toBe('420px'); // native accessibility zoom does not reflow chat
      await act(async () => {
        visual.scale = 1; width = 844; dynamicHeight = 320; rootTop = -90;
        visual.offsetTop = 20; visual.height = 190;
        window.dispatchEvent(new Event('orientationchange')); visual.dispatchEvent(new Event('resize'));
      });
      expect(dialog.style.top).toBe('20px'); expect(dialog.style.height).toBe('190px');
      await act(async () => {
        rootTop = 0; visual.offsetTop = 0; visual.height = 320;
        composer.blur(); visual.dispatchEvent(new Event('resize'));
      });
      expect(dialog.style.height).toBe('320px'); expect(dialog.style.top).toBe('0px');
      await act(async () => {
        width = 390; dynamicHeight = 844; visual.height = 844;
        window.dispatchEvent(new Event('orientationchange'));
      });
      expect(dialog.style.height).toBe('844px');
      await act(async () => {
        dynamicHeight = 780; visual.height = 780;
        window.dispatchEvent(new Event('resize'));
      });
      expect(dialog.style.height).toBe('780px'); // toolbar change follows the same frame after dismissal
    } finally {
      disposeViewport();
      Reflect.deleteProperty(document.documentElement, 'clientWidth');
    }
  });

  it('remeasures a real root rotation during pinch without shrinking to the magnified visual viewport', async () => {
    const visual = Object.assign(new EventTarget(), { scale: 1, height: 844, offsetTop: 0 });
    vi.stubGlobal('visualViewport', visual);
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    let width = 390, height = 844;
    Object.defineProperties(game, { clientWidth: { get: () => width }, clientHeight: { get: () => height } });
    vi.spyOn(game, 'getBoundingClientRect').mockImplementation(() => DOMRect.fromRect({ width, height }));
    const { host } = await mount();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    await act(async () => { visual.scale = 2; visual.height = 422; visual.dispatchEvent(new Event('resize')); });
    expect(dialog.style.height).toBe('844px');
    await act(async () => {
      width = 844; height = 320; visual.height = 160;
      window.dispatchEvent(new Event('pkw:game-viewport'));
    });
    expect(dialog.style.height).toBe('320px');
    expect(dialog.style.top).toBe('0px');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    await act(async () => {
      width = 390; height = 844; visual.height = 422;
      window.dispatchEvent(new Event('pkw:game-viewport'));
    });
    expect(dialog.style.height).toBe('844px');
  });

  it('keeps short landscape modal when document scrolling expands its root height', async () => {
    setViewport(915, 311);
    const game = document.createElement('div'); game.id = 'root'; document.body.append(game);
    Object.defineProperties(game, { clientWidth: { value: 915 }, clientHeight: { value: 644 } });
    vi.spyOn(game, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ y: -333, height: 644 }));
    const { host } = await mount();
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.style.height).toBe('311px');
  });

  it('renders hostile content as inert text with mobile dialog and explicit report controls', async () => {
    vi.mocked(chatApi.history).mockResolvedValue({ messages: [hostile], nextBefore: null });
    const { host, onClose } = await mount();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true'); // phones keep the modal
    expect(dialog.style.position).toBe('fixed');
    expect(dialog.style.height).toBe('844px'); // corrected game frame, not raw viewport CSS
    expect(host.querySelector('[role="log"]')?.getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('article')?.textContent).toContain(hostile.text);
    expect(host.querySelector('article script')).toBeNull();
    expect(host.querySelector('article img')).toBeNull();
    const report = [...host.querySelectorAll('button')].find((button) => button.textContent === 'REPORT')!;
    expect(report.getAttribute('aria-label')).toContain(hostile.author.name);
    await act(async () => report.click());
    expect(host.textContent).toContain('PERSONAL INFO');
    expect([...host.querySelectorAll('button')].find((button) => button.textContent === 'PERSONAL INFO')
      ?.style.minHeight).toBe('44px');

    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close global chat"]')!;
    expect(close.style.width).toBe('44px');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledWith('10', expect.objectContaining({ enabled: true }));
  });

  it('renders a bounded non-modal dock on desktop viewports (M23 a5)', async () => {
    // ≥900×600: the game stays visible and playable beside the conversation,
    // so the panel is anchored bottom-right, bounded, and must NOT claim
    // aria-modal (that would lie to assistive tech about a non-trapping
    // surface). Escape still closes it.
    setViewport(1280, 800);
    const { host, onClose } = await mount();

    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(dialog.style.position).toBe('fixed');
    expect(dialog.style.width).toBe('380px');
    expect(dialog.style.right).toBe('12px');
    // Anchor within the visible frame, which can differ from the layout
    // viewport after Safari scrolls a focused composer.
    expect(Number.parseFloat(dialog.style.top) + Number.parseFloat(dialog.style.height)).toBe(800 - 12);
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledWith('10', expect.objectContaining({ enabled: true }));
  });

  it('keeps API-root avatar paths on the origin instead of double-prefixing /api', () => {
    expect(chatAvatarUrl('/api/avatars/player.webp')).toBe('http://localhost:3000/api/avatars/player.webp');
  });

  it('keeps initials visible beneath a failed custom avatar', async () => {
    vi.mocked(chatApi.history).mockResolvedValue({ messages: [{
      ...hostile, author: { ...hostile.author, name: 'Theodor', avatarUrl: '/api/avatars/retired.webp' },
    }], nextBefore: null });
    const { host } = await mount();
    const image = host.querySelector<HTMLImageElement>('article img')!;
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(image.hidden).toBe(true);
    expect(host.querySelector('article')?.textContent).toContain('TH');
  });

  it('blocks by opaque message id and immediately refreshes server-filtered history', async () => {
    vi.mocked(chatApi.history)
      .mockResolvedValueOnce({ messages: [hostile], nextBefore: null })
      .mockResolvedValueOnce({ messages: [], nextBefore: null });
    vi.spyOn(chatApi, 'block').mockResolvedValue({ block: {
      id: '7', createdAt: hostile.createdAt, author: hostile.author,
    } });
    const { host } = await mount();
    const button = [...host.querySelectorAll('button')].find((item) => item.textContent === 'BLOCK')!;
    await act(async () => { button.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(chatApi.block).toHaveBeenCalledWith(hostile.id);
    expect(chatApi.history).toHaveBeenCalledTimes(2);
    expect(host.querySelectorAll('article')).toHaveLength(0);
  });

  it('fences an events response that began before a successful block', async () => {
    let resolveEvents!: (value: Awaited<ReturnType<typeof chatApi.events>>) => void;
    vi.mocked(chatApi.events).mockImplementation(() => new Promise((resolve) => { resolveEvents = resolve; }));
    vi.mocked(chatApi.history)
      .mockResolvedValueOnce({ messages: [hostile], nextBefore: null })
      .mockResolvedValueOnce({ messages: [], nextBefore: null });
    vi.spyOn(chatApi, 'block').mockResolvedValue({ block: { id: '7', createdAt: hostile.createdAt, author: hostile.author } });
    const { host } = await mount();
    await settle();
    await act(async () => {
      [...host.querySelectorAll('button')].find((item) => item.textContent === 'BLOCK')!.click();
      await Promise.resolve(); await Promise.resolve();
      resolveEvents({ events: [{ id: '11', type: 'message', messageId: hostile.id,
        createdAt: hostile.createdAt, message: hostile }], nextAfter: '11' });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host.querySelectorAll('article')).toHaveLength(0);
  });

  it('discards a load-earlier page that resolves after a block', async () => {
    let resolveOlder!: (value: Awaited<ReturnType<typeof chatApi.history>>) => void;
    vi.mocked(chatApi.history)
      .mockResolvedValueOnce({ messages: [hostile], nextBefore: '9' })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOlder = resolve; }))
      .mockResolvedValueOnce({ messages: [], nextBefore: null });
    vi.spyOn(chatApi, 'block').mockResolvedValue({ block: { id: '7', createdAt: hostile.createdAt, author: hostile.author } });
    const { host } = await mount();
    await act(async () => {
      [...host.querySelectorAll('button')].find((item) => item.textContent === 'LOAD EARLIER')!.click();
      [...host.querySelectorAll('button')].find((item) => item.textContent === 'BLOCK')!.click();
      await Promise.resolve(); await Promise.resolve();
      resolveOlder({ messages: [hostile], nextBefore: null });
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host.querySelectorAll('article')).toHaveLength(0);
  });

  it('replays an event that arrives while filtered history is refreshing', async () => {
    const newer = { ...hostile, id: '12', clientMessageId: 'remote-12', text: 'new keeper joined' };
    let resolveOldPoll!: (value: Awaited<ReturnType<typeof chatApi.events>>) => void;
    let resolveRefresh!: (value: Awaited<ReturnType<typeof chatApi.history>>) => void;
    vi.mocked(chatApi.events)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveOldPoll = resolve; }))
      .mockResolvedValue({ events: [{ id: '12', type: 'message', messageId: '12',
        createdAt: newer.createdAt, message: newer }], nextAfter: '12' });
    vi.mocked(chatApi.history)
      .mockResolvedValueOnce({ messages: [hostile], nextBefore: null })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRefresh = resolve; }));
    vi.spyOn(chatApi, 'block').mockResolvedValue({ block: { id: '7', createdAt: hostile.createdAt, author: hostile.author } });
    const { host } = await mount();
    await settle();
    await act(async () => {
      [...host.querySelectorAll('button')].find((item) => item.textContent === 'BLOCK')!.click();
      await Promise.resolve(); await Promise.resolve();
      resolveOldPoll({ events: [{ id: '12', type: 'message', messageId: '12',
        createdAt: newer.createdAt, message: newer }], nextAfter: '12' });
      resolveRefresh({ messages: [], nextBefore: null });
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    });
    expect(host.textContent).toContain('new keeper joined');
  });

  it('focuses the close control when chat is read-only', async () => {
    vi.mocked(chatApi.status).mockResolvedValue({
      ...STATUS, canSend: false, sendBlockedReason: 'DEED_REQUIRED',
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    roots.push(root);
    await act(async () => {
      root.render(<ChatScreen
        initialStatus={{ ...STATUS, canSend: false, sendBlockedReason: 'DEED_REQUIRED' }}
        initialCursor="10" onClose={vi.fn()} />);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    expect(document.activeElement).toBe(host.querySelector('button[aria-label="Close global chat"]'));
    expect(host.querySelector('textarea')?.hasAttribute('disabled')).toBe(true);
  });

  it('does not steal focus when the periodic status answer refreshes', async () => {
    let resolveStatus!: (status: ChatStatus) => void;
    vi.mocked(chatApi.status).mockImplementationOnce(() => new Promise((resolve) => { resolveStatus = resolve; }));
    const { host } = await mount();
    const close = host.querySelector<HTMLButtonElement>('button[aria-label="Close global chat"]')!;
    close.focus();
    await act(async () => {
      resolveStatus({ ...STATUS, mutedUntil: '2026-08-13T12:00:00.000Z' });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(document.activeElement).toBe(close);
  });

  it('keeps the exact optimistic UUID and text across an ambiguous retry, then dedupes canonical truth', async () => {
    const canonical: ChatMessage = {
      id: '11', clientMessageId: '', text: 'hold the north wall',
      createdAt: '2026-08-13T10:01:00.000Z',
      author: { name: 'THEODOR', avatarUrl: null, seekerVerified: false },
      canBlock: false,
    };
    vi.spyOn(chatApi, 'send')
      .mockRejectedValueOnce(new ApiError(0, 'offline'))
      .mockImplementationOnce(async (clientMessageId, text) => ({ ...canonical, clientMessageId, text }));
    const { host } = await mount();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await change(textarea, canonical.text);
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'SEND')!;
    await act(async () => { send.click(); await Promise.resolve(); await Promise.resolve(); });

    expect(host.textContent).toContain('NOT SENT — TAP RETRY');
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'RETRY')!;
    const [firstId, firstText] = vi.mocked(chatApi.send).mock.calls[0]!;
    await act(async () => { retry.click(); await Promise.resolve(); await Promise.resolve(); });
    const [secondId, secondText] = vi.mocked(chatApi.send).mock.calls[1]!;
    expect(secondId).toBe(firstId);
    expect(secondText).toBe(firstText);
    expect(firstText).toBe(canonical.text);
    expect(host.querySelectorAll('article')).toHaveLength(1);
    expect(host.textContent).toContain('THEODOR');
    expect(host.textContent).not.toContain('RETRY');
  });

  it('restores a definite invalid message for editing instead of offering a dead retry', async () => {
    vi.spyOn(chatApi, 'send').mockRejectedValue(
      new ApiError(400, 'unsupported content', 'CHAT_TEXT_INVALID'),
    );
    const { host } = await mount();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await change(textarea, 'www.example.com');
    const send = [...host.querySelectorAll('button')].find((button) => button.textContent === 'SEND')!;
    await act(async () => { send.click(); await Promise.resolve(); await Promise.resolve(); });
    expect(textarea.value).toBe('www.example.com');
    expect(host.textContent).toContain('MESSAGE NOT ALLOWED — EDIT AND TRY AGAIN');
    expect(host.textContent).not.toContain('RETRY');
  });

  it('pins only a reader already near the bottom', () => {
    expect(chatNearBottom(1_000, 750, 200)).toBe(true);
    expect(chatNearBottom(1_000, 100, 200)).toBe(false);
  });

  it('keeps plain Enter for newlines and uses Ctrl+Enter as the optional send shortcut', async () => {
    vi.spyOn(chatApi, 'send').mockImplementation(async (clientMessageId, text) => ({
      ...hostile, id: '12', clientMessageId, text,
    }));
    const { host } = await mount();
    const textarea = host.querySelector<HTMLTextAreaElement>('textarea')!;
    await change(textarea, 'two\nlines');
    const plain = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    textarea.dispatchEvent(plain);
    expect(plain.defaultPrevented).toBe(false);
    expect(chatApi.send).not.toHaveBeenCalled();

    textarea.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
    }));
    await settle();
    expect(chatApi.send).toHaveBeenCalledWith(expect.any(String), 'two\nlines');
  });
});


describe('verified in-game mentions', () => {
  it('inserts the complete author handle locally without sending or discarding the draft', async () => {
    vi.mocked(chatApi.history).mockResolvedValue({ messages: [{ ...hostile, text: 'hello', author: { ...hostile.author, name: 'houska.skr' } }], nextBefore: null });
    const send = vi.spyOn(chatApi, 'send');
    const { host } = await mount();
    const input = host.querySelector('textarea')!;
    await change(input, 'hello ');
    input.setSelectionRange(6, 6);
    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Mention houska.skr"]')!.click());
    expect(input.value).toBe('hello @houska.skr ');
    expect(send).not.toHaveBeenCalled();
  });

  it('highlights only verified spans and marks recipient messages without treating text as HTML', async () => {
    const text = 'hello @houska.skr <b>hello</b>';
    vi.mocked(chatApi.history).mockResolvedValue({ messages: [{ ...hostile, text, mentions: [{ start: 6, end: 17 }], mentioned: true }], nextBefore: null });
    const { host } = await mount();
    expect(host.querySelector('mark')?.textContent).toBe('@houska.skr');
    expect(host.querySelector('article')?.getAttribute('aria-label')).toBe('Message mentioning you');
    expect(host.querySelector('article b')).toBeNull();
    expect(host.querySelector('article')?.textContent).toContain('<b>hello</b>');
  });
});
