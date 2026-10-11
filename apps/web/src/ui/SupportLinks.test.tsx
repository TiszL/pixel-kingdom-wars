/**
 * @vitest-environment happy-dom
 *
 * The one component every "contact support" resolves to (D-098). Each case is
 * a way the old sentence-only copy failed a player: no address, no way to copy
 * it where mailto: is inert (the dApp-store WebView), no community fallback.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bus } from '../lib/events';
import { DISCORD_URL, SUPPORT_EMAIL } from '../lib/support';
import { useApp } from '../state/store';
import { SupportLinks } from './SupportLinks';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let toasts: string[];
let offToast: () => void;
const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  toasts = [];
  offToast = bus.on('ui:toast', ({ msg }) => { toasts.push(msg); });
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  useApp.setState({ wallet: null });
});

afterEach(async () => {
  offToast();
  await act(async () => root.unmount());
  host.remove();
});

const button = (label: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`button not found: ${label}`);
  return found;
};

describe('SupportLinks', () => {
  it('renders the address itself inside a real mailto anchor, wallet in the subject', async () => {
    useApp.setState({ wallet: 'Wallet1111111111111111111111111111111111111' });
    await act(async () => root.render(<SupportLinks topic="Lost authenticator" />));
    const mail = host.querySelector<HTMLAnchorElement>('a[href^="mailto:"]')!;
    expect(mail.textContent).toBe(`EMAIL SUPPORT · ${SUPPORT_EMAIL}`);
    expect(decodeURIComponent(mail.getAttribute('href')!))
      .toBe(`mailto:${SUPPORT_EMAIL}?subject=Lost authenticator · Wallet1111111111111111111111111111111111111`);
  });

  it('leaves the subject bare when no wallet is signed in', async () => {
    await act(async () => root.render(<SupportLinks topic="Hello" />));
    expect(host.querySelector('a[href^="mailto:"]')?.getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}?subject=Hello`);
  });

  it('copies the address to the clipboard and says so — mailto is inert in the dApp-store WebView', async () => {
    await act(async () => root.render(<SupportLinks topic="Hello" />));
    await act(async () => { button('COPY ADDRESS').click(); await Promise.resolve(); await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith(SUPPORT_EMAIL);
    expect(toasts).toEqual(['SUPPORT ADDRESS COPIED']);
  });

  it('tells the player to long-press when the clipboard refuses', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    await act(async () => root.render(<SupportLinks topic="Hello" />));
    await act(async () => { button('COPY ADDRESS').click(); await Promise.resolve(); await Promise.resolve(); });
    expect(toasts).toEqual(['COPY FAILED — LONG-PRESS THE ADDRESS']);
  });

  it('links the Discord invite in a new tab without leaking an opener', async () => {
    await act(async () => root.render(<SupportLinks topic="Hello" />));
    const discord = host.querySelector<HTMLAnchorElement>(`a[href="${DISCORD_URL}"]`)!;
    expect(discord.getAttribute('target')).toBe('_blank');
    expect(discord.rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
  });
});
