import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createMobileBackGuard, registerMobileBackHandler, type MobileBackHistory,
  type MobileBackWindow,
} from './mobileBackGuard';

class FakeWindow extends EventTarget implements MobileBackWindow {
  readonly location = { href: 'https://play.pixelkingdomwars.com/?client=solana-mobile' };
  private entries: unknown[] = [{ page: 'outside' }, { page: 'game' }];
  private cursor = 1;
  readonly history: MobileBackHistory;
  backCalls = 0;
  private timers = new Map<number, () => void>();
  private nextTimer = 1;

  constructor(withOutsideEntry = true) {
    super();
    if (!withOutsideEntry) { this.entries = [{ page: 'game' }]; this.cursor = 0; }
    const owner = this;
    this.history = {
      get state() { return owner.entries[owner.cursor]; },
      pushState(data) {
        owner.entries.splice(owner.cursor + 1);
        owner.entries.push(data);
        owner.cursor = owner.entries.length - 1;
      },
      back() {
        owner.backCalls += 1;
        if (owner.cursor === 0) return;
        owner.cursor -= 1;
        owner.dispatchEvent(new Event('popstate'));
      },
    };
  }

  get historyLength(): number { return this.entries.length; }
  setTimeout(handler: () => void): number {
    const id = this.nextTimer++;
    this.timers.set(id, handler);
    return id;
  }
  clearTimeout(id: number): void { this.timers.delete(id); }
  runTimers(): void {
    const timers = [...this.timers.values()];
    this.timers.clear();
    for (const timer of timers) timer();
  }
}

function activate(win: FakeWindow): void { win.dispatchEvent(new Event('pointerdown')); }
function back(win: FakeWindow): void { win.history.back(); }

function mount(win: FakeWindow, screen: { value: string }, toast = vi.fn()) {
  const goToBase = vi.fn(() => { screen.value = 'base'; });
  const dispose = createMobileBackGuard({
    win, enabled: true, trustedActivation: () => true, now: () => 1_000,
    getScreen: () => screen.value, goToBase, toast,
  });
  return { dispose, goToBase, toast };
}

afterEach(() => vi.restoreAllMocks());

describe('installed Android Back sentinel (D-102)', () => {
  it('does nothing before activation, then keeps exactly one same-URL sentinel', () => {
    const win = new FakeWindow();
    const screen = { value: 'base' };
    const { dispose } = mount(win, screen);
    const before = win.historyLength;
    back(win);
    expect(win.historyLength).toBe(before);

    win.history.pushState({ page: 'game' }, '', win.location.href);
    activate(win);
    const armedLength = win.historyLength;
    const unregister = registerMobileBackHandler(() => true, 500);
    back(win);
    back(win);
    expect(win.historyLength).toBe(armedLength);
    unregister();
    dispose();
  });

  it('delegates to the highest mounted surface without navigating behind it', () => {
    const win = new FakeWindow();
    const screen = { value: 'profile' };
    const { dispose, goToBase } = mount(win, screen);
    const page = vi.fn();
    const modal = vi.fn();
    const offPage = registerMobileBackHandler(page, 100);
    const offModal = registerMobileBackHandler(modal, 300);
    activate(win);
    back(win);
    expect(modal).toHaveBeenCalledOnce();
    expect(page).not.toHaveBeenCalled();
    expect(goToBase).not.toHaveBeenCalled();
    offModal(); offPage(); dispose();
  });

  it('warns on first base Back and follows native history on the second', () => {
    const win = new FakeWindow();
    const screen = { value: 'base' };
    const { dispose, toast } = mount(win, screen);
    activate(win);
    const armedLength = win.historyLength;
    back(win);
    expect(toast).toHaveBeenCalledWith('BACK AGAIN TO EXIT');
    expect(win.historyLength).toBe(armedLength);
    const callsBeforeSecond = win.backCalls;
    back(win);
    expect(win.backCalls).toBe(callsBeforeSecond + 2);
    dispose();
  });

  it('interaction or timeout cancels the pending exit', () => {
    const win = new FakeWindow();
    const screen = { value: 'base' };
    const { dispose, toast } = mount(win, screen);
    activate(win);
    back(win);
    activate(win);
    back(win);
    expect(toast).toHaveBeenCalledTimes(2);
    win.runTimers();
    back(win);
    expect(toast).toHaveBeenCalledTimes(3);
    dispose();
  });

  it('re-arms on interaction when the native exit had no popstate at the history root', () => {
    const win = new FakeWindow(false);
    const { dispose, toast } = mount(win, { value: 'base' });
    activate(win);
    back(win);
    back(win); // history.back at the root cannot deliver the expected bypass pop
    expect(toast).toHaveBeenCalledTimes(1);
    activate(win); // player returns to the installed game and interacts again
    expect(win.historyLength).toBe(2);
    back(win);
    expect(toast, 'the resumed game must guard Back again, not keep a stale bypass').toHaveBeenCalledTimes(2);
    expect(win.historyLength).toBe(2);
    dispose();
  });

  it('leaves ordinary browser/PWA history untouched when disabled', () => {
    const win = new FakeWindow();
    const before = win.historyLength;
    const dispose = createMobileBackGuard({
      win, enabled: false, trustedActivation: () => true,
      getScreen: () => 'base', goToBase: vi.fn(), toast: vi.fn(),
    });
    activate(win);
    expect(win.historyLength).toBe(before);
    dispose();
  });
});
