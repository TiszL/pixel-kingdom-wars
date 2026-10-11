/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/api';
import { useApp } from '../../state/store';
import { ChatLauncher } from './ChatLauncher';
import { chatApi, type ChatStatus } from './protocol';

vi.mock('./ChatScreen',()=>({default:()=> <div role="dialog" aria-label="Global chat">CHAT PANEL</div>}));

const ENABLED_STATUS: ChatStatus = {
  enabled: true, canSend: true, sendBlockedReason: null, mutedUntil: null,
  pollOpenMs: 2_000, pollClosedMs: 20_000, latestEventId: '0',
};

function setViewport(width: number, height: number, event?: 'resize' | 'orientationchange'): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
  if (event) window.dispatchEvent(new Event(event));
}

async function mountEnabledLauncher(): Promise<{
  host: HTMLDivElement;
  root: ReturnType<typeof createRoot>;
}> {
  vi.spyOn(chatApi, 'status').mockResolvedValue(ENABLED_STATUS);
  vi.spyOn(chatApi, 'events').mockResolvedValue({ events: [], nextAfter: '0' });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<ChatLauncher />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return { host, root };
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
  useApp.setState({ authed: true, wallet: 'wallet', screen: 'base', mapTab:'world' });
  setViewport(390, 844);
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  useApp.setState({ authed: false, wallet: null, screen: 'title' });
  vi.restoreAllMocks();
});

describe('global chat launcher capability', () => {
  it('uses the HUD solver for base/build, resize and orientation-only transitions', async () => {
    const rightSetter = vi.spyOn(CSSStyleDeclaration.prototype, 'right', 'set');
    const bottomSetter = vi.spyOn(CSSStyleDeclaration.prototype, 'bottom', 'set');
    setViewport(909, 780);
    const { host, root } = await mountEnabledLauncher();
    const launcher = (): HTMLButtonElement =>
      host.querySelector<HTMLButtonElement>('button[aria-label^="Open global chat"]')!;

    expect(launcher().style.getPropertyValue('--chat-launcher-right')).toBe('10px');
    expect(launcher().style.getPropertyValue('--chat-launcher-bottom')).toBe('72px');
    expect(new Set(rightSetter.mock.calls.map(([value]) => String(value))
      .filter((value) => value.includes('safe-area-inset-right'))))
      .toEqual(new Set(['calc(var(--chat-launcher-right) + env(safe-area-inset-right))']));
    expect(new Set(bottomSetter.mock.calls.map(([value]) => String(value))
      .filter((value) => value.includes('safe-area-inset-bottom'))))
      .toEqual(new Set(['calc(var(--chat-launcher-bottom) + env(safe-area-inset-bottom))']));

    await act(async () => {
      useApp.setState({ screen: 'build' });
      await Promise.resolve();
    });
    expect(launcher().style.getPropertyValue('--chat-launcher-right')).toBe('10px');
    expect(launcher().style.getPropertyValue('--chat-launcher-bottom')).toBe('72px');

    await act(async () => {
      setViewport(980, 768, 'resize');
      await Promise.resolve();
    });
    expect(launcher().style.getPropertyValue('--chat-launcher-right')).toBe('10px');
    // The floating primary actions use the same bottom cluster in every orientation.
    expect(launcher().style.getPropertyValue('--chat-launcher-bottom')).toBe('72px');

    await act(async () => {
      setViewport(915, 412, 'orientationchange');
      await Promise.resolve();
    });
    expect(launcher().style.getPropertyValue('--chat-launcher-right')).toBe('10px');
    expect(launcher().style.getPropertyValue('--chat-launcher-bottom')).toBe('72px');

    await act(async () => {
      setViewport(375, 812, 'resize');
      await Promise.resolve();
    });
    expect(launcher().style.getPropertyValue('--chat-launcher-right')).toBe('10px');
    expect(launcher().style.getPropertyValue('--chat-launcher-bottom')).toBe('72px');
    await act(async () => root.unmount());
  });

  it.each(['world','campaign'] as const)('retires open chat and all chat polling on %s, then restores only the base launcher',async(mapTab)=>{
    vi.useFakeTimers();
    const {host,root}=await mountEnabledLauncher();
    await act(async()=>host.querySelector<HTMLButtonElement>('button[aria-label^="Open global chat"]')!.click());
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    await act(async()=>useApp.setState({screen:'map',mapTab}));
    expect(host.querySelector('button[aria-label^="Open global chat"]')).toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    const statusReads=vi.mocked(chatApi.status).mock.calls.length,eventReads=vi.mocked(chatApi.events).mock.calls.length;
    await act(async()=>vi.advanceTimersByTimeAsync(60000));
    expect(chatApi.status).toHaveBeenCalledTimes(statusReads);
    expect(chatApi.events).toHaveBeenCalledTimes(eventReads);
    await act(async()=>useApp.setState({screen:'base'}));
    expect(host.querySelector('button[aria-label^="Open global chat"]')).not.toBeNull();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    await act(async()=>root.unmount());
  });

  it('restores the launcher after an administrator re-enables chat', async () => {
    vi.useFakeTimers();
    vi.spyOn(chatApi, 'status')
      .mockResolvedValueOnce({
        enabled: false, canSend: false, sendBlockedReason: 'DISABLED', mutedUntil: null,
        pollOpenMs: 2_000, pollClosedMs: 20_000, latestEventId: '10',
      })
      .mockResolvedValue({
        enabled: true, canSend: true, sendBlockedReason: null, mutedUntil: null,
        pollOpenMs: 2_000, pollClosedMs: 20_000, latestEventId: '12',
      });
    vi.spyOn(chatApi, 'events').mockImplementation(() => new Promise(() => undefined));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ChatLauncher />);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(host.querySelector('button[aria-label^="Open global chat"]')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
      await Promise.resolve(); await Promise.resolve();
    });
    expect(chatApi.status).toHaveBeenCalledTimes(2);
    expect(host.querySelector('button[aria-label^="Open global chat"]')).toBeTruthy();
    await act(async () => root.unmount());
  });

  it('stays hidden against a rolling old API with no chat route', async () => {
    vi.spyOn(chatApi, 'status').mockRejectedValue(new ApiError(404, 'missing'));
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ChatLauncher />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(host.querySelector('button[aria-label^="Open global chat"]')).toBeNull();
    await act(async () => root.unmount());
  });

  it('shows only after an enabled capability answer and caps the visual unread badge', async () => {
    vi.spyOn(chatApi, 'status').mockResolvedValue({
      enabled: true, canSend: true, sendBlockedReason: null, mutedUntil: null,
      pollOpenMs: 2_000, pollClosedMs: 20_000, latestEventId: '0',
    });
    vi.spyOn(chatApi, 'events').mockResolvedValue({
      events: Array.from({ length: 101 }, (_, index) => ({
        id: String(index + 1), type: 'message' as const, createdAt: '2026-08-13T00:00:00.000Z',
        messageId: String(index + 1),
        message: {
          id: String(index + 1), clientMessageId: `client-${index}`, text: 'hello',
          createdAt: '2026-08-13T00:00:00.000Z',
          author: { name: 'KEEPER', avatarUrl: null, seekerVerified: false },
          canBlock: true,
        },
      })),
      nextAfter: '101',
    });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<ChatLauncher />);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    const launcher = host.querySelector<HTMLButtonElement>('button[aria-label^="Open global chat"]')!;
    expect(launcher).toBeTruthy();
    expect(launcher.getAttribute('aria-label')).toBe('Open global chat, 101 unread');
    expect(launcher.textContent).toContain('99+');
    expect(launcher.style.getPropertyValue('--chat-launcher-right')).toBe('10px');
    expect(launcher.style.getPropertyValue('--chat-launcher-bottom')).toBe('72px');
    await act(async () => root.unmount());
  });
});


describe('mention ping lifecycle', () => {
  it('deduplicates live pings, retires redactions and resets them on wallet switch', async () => {
    vi.useFakeTimers();
    const { host, root } = await mountEnabledLauncher();
    const message = { id: '11', clientMessageId: 'incoming-11', text: 'hello @Suga', createdAt: '2026-09-06T15:00:00Z', author: { name: 'Keeper', avatarUrl: null, seekerVerified: false }, canBlock: true, mentioned: true, mentions: [{ start: 6, end: 11 }] };
    vi.mocked(chatApi.events).mockResolvedValue({ events: [{ id: '11', type: 'message', messageId: '11', createdAt: message.createdAt, message }], nextAfter: '11' });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Open global chat, 1 unread, 1 mention');
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Open global chat, 1 unread, 1 mention');
    vi.mocked(chatApi.events).mockResolvedValue({ events: [{ id: '12', type: 'redaction', messageId: '11', createdAt: message.createdAt }], nextAfter: '12' });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Open global chat');
    vi.mocked(chatApi.events).mockResolvedValue({ events: [{ id: '13', type: 'message', messageId: '11', createdAt: message.createdAt, message }], nextAfter: '13' });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(host.querySelector('button')?.textContent).toContain('@1');
    vi.mocked(chatApi.events).mockImplementation(() => new Promise(() => undefined));
    await act(async () => { useApp.setState({ wallet: 'another-wallet' }); });
    expect(host.querySelector('button')?.getAttribute('aria-label')).toBe('Open global chat');
    await act(async () => root.unmount());
  });
});
