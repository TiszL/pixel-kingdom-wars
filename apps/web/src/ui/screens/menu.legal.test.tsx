/** @vitest-environment happy-dom */
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, connection: null }),
}));

import { DISCORD_URL, SUPPORT_EMAIL } from '../../lib/support';
import { AboutLegalPane, LEGAL_DOCUMENTS } from './menu';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => vi.restoreAllMocks());

const menuSource = (): string => readFileSync(
  `${process.cwd()}/src/ui/screens/menu.tsx`, 'utf8',
);

async function renderLegalPane(): Promise<{ host: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(<AboutLegalPane />));
  return { host, root };
}

describe('in-app legal delivery', () => {
  it('is reachable from the Profile tabs and the existing About action', () => {
    const source = menuSource();
    const profile = source.slice(
      source.indexOf('export function ProfileScreen'), source.indexOf('// CLANS ('),
    );
    expect(profile).toContain("(['PROFILE', 'WALLET', 'ABOUT'] as const)");
    expect(profile).toContain("profileTab === 'ABOUT' ? <AboutLegalPane />");
    expect(profile).toContain("onClick={() => setProfileTab('ABOUT')}");
  });

  it('switches only between the two canonical allowlisted URLs', async () => {
    expect(Object.fromEntries(Object.entries(LEGAL_DOCUMENTS).map(([key, value]) => [key, value.url])))
      .toEqual({
        TERMS: 'https://pixelkingdomwars.com/terms',
        PRIVACY: 'https://pixelkingdomwars.com/privacy',
      });
    const allowed = new Set<string>(Object.values(LEGAL_DOCUMENTS).map((document) => document.url));
    const { host, root } = await renderLegalPane();

    const currentFrame = (): HTMLIFrameElement => host.querySelector('iframe')!;
    expect(currentFrame().getAttribute('src')).toBe(LEGAL_DOCUMENTS.TERMS.url);
    expect(allowed.has(currentFrame().getAttribute('src')!)).toBe(true);

    const privacy = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'PRIVACY POLICY')!;
    await act(async () => privacy.click());
    expect(currentFrame().getAttribute('src')).toBe(LEGAL_DOCUMENTS.PRIVACY.url);
    expect(allowed.has(currentFrame().getAttribute('src')!)).toBe(true);

    const terms = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent === 'TERMS OF USE')!;
    await act(async () => terms.click());
    expect(currentFrame().getAttribute('src')).toBe(LEGAL_DOCUMENTS.TERMS.url);
    await act(async () => root.unmount());
  });

  it('uses an accessible, lazy and capability-free frame with no referrer', async () => {
    const { host, root } = await renderLegalPane();
    const frame = host.querySelector('iframe')!;
    expect(frame.getAttribute('title')).toBe(LEGAL_DOCUMENTS.TERMS.frameTitle);
    expect(frame.getAttribute('loading')).toBe('lazy');
    expect(frame.hasAttribute('sandbox')).toBe(true);
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');

    const source = menuSource();
    const pane = source.slice(
      source.indexOf('export function AboutLegalPane'), source.indexOf('interface AvatarMutation'),
    );
    expect(pane).not.toContain('dangerouslySetInnerHTML');
    await act(async () => root.unmount());
  });

  it('exposes both canonical documents as real external anchors', async () => {
    const { host, root } = await renderLegalPane();
    // The pane also carries the support row (below); the legal anchors are the
    // https ones and must still be exactly the two canonical documents.
    const anchors = Array.from(host.querySelectorAll<HTMLAnchorElement>('a[href^="https://pixelkingdomwars.com/"]'));
    expect(anchors.map((anchor) => anchor.getAttribute('href'))).toEqual([
      LEGAL_DOCUMENTS.TERMS.url,
      LEGAL_DOCUMENTS.PRIVACY.url,
    ]);
    for (const anchor of anchors) {
      expect(anchor.getAttribute('target')).toBe('_blank');
      expect(anchor.rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }
    await act(async () => root.unmount());
  });

  it('carries the support address the Terms promise, with a copy control and Discord', async () => {
    // WHY (D-098): the Terms tell players support is by email at this address;
    // until now the app itself never showed it. The row is the one place a
    // player looks for "how do I reach you" without reading the Terms.
    const { host, root } = await renderLegalPane();
    expect(host.textContent).toContain('SUPPORT');
    const mail = host.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
    expect(mail?.getAttribute('href')).toBe(`mailto:${SUPPORT_EMAIL}?subject=Pixel%20Kingdom%20Wars%20support`);
    expect(mail?.textContent).toContain(SUPPORT_EMAIL);
    const discord = host.querySelector<HTMLAnchorElement>(`a[href="${DISCORD_URL}"]`);
    expect(discord?.getAttribute('target')).toBe('_blank');
    expect(discord?.rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'COPY ADDRESS')).toBe(true);
    await act(async () => root.unmount());
  });
});
