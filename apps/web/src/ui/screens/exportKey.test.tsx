/**
 * @vitest-environment happy-dom
 *
 * Behaviour coverage for the two independent export boundaries. Privy enrollment
 * decides whether a reveal action exists at all; once it does, SHARDKEEP's
 * recent-auth challenge must finish before the vendor export modal is invoked.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  privyReady: false,
  availableMfaMethods: ['totp'] as string[],
  user: null as null | { mfaMethods: string[] },
  showEnrollment: vi.fn(),
  clearMfa: vi.fn(),
  initMfa: vi.fn(),
  promptMfa: vi.fn(),
  exportWallet: vi.fn(),
  prove: vi.fn(),
  postRecent: vi.fn(),
  reloadStatus: vi.fn(),
  wallets: [] as Array<{ address: string; standardWallet: { isPrivyWallet: boolean } }>,
}));

vi.mock('@privy-io/react-auth', () => ({
  usePrivy: () => ({
    ready: h.privyReady, user: h.user, mfaMethods: h.availableMfaMethods,
  }),
  useMfaEnrollment: () => ({ showMfaEnrollmentModal: h.showEnrollment }),
  useMfa: () => ({ clear: h.clearMfa, init: h.initMfa, promptMfa: h.promptMfa }),
}));

vi.mock('@privy-io/react-auth/solana', () => ({
  useWallets: () => ({ wallets: h.wallets }),
  useExportWallet: () => ({ exportWallet: h.exportWallet }),
}));

vi.mock('../../state/store', () => ({
  useApp: (select: (state: { wallet: string }) => unknown) =>
    select({ wallet: 'embedded-address' }),
}));

vi.mock('../../auth/useRecentAuth', () => ({
  useRecentAuth: () => ({ prove: h.prove }),
}));

vi.mock('../../auth/useFreshPrivyMfa', () => ({
  useFreshPrivyMfa: () => async () => {
    await h.clearMfa();
    await h.initMfa('totp');
    await h.promptMfa();
  },
}));

vi.mock('../useFetch', () => ({
  useFetch: () => ({
    data: { totpEnabled: false, emailVerified: false, gated: false },
    error: null,
    loading: false,
    reload: h.reloadStatus,
  }),
}));

vi.mock('../../lib/api', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
  api: {
    get: vi.fn(),
    post: vi.fn(),
    postRecent: h.postRecent,
  },
}));

import { PRIVY_HELP_URL, SUPPORT_EMAIL } from '../../lib/support';
import { ExportKeySection } from './exportKey';

const roots: Root[] = [];

function button(label: string): HTMLButtonElement | null {
  return [...document.body.querySelectorAll('button')]
    .find((candidate) => candidate.textContent?.trim() === label) ?? null;
}

async function renderSection(root?: Root): Promise<Root> {
  const target = root ?? (() => {
    const host = document.createElement('div');
    document.body.append(host);
    const created = createRoot(host);
    roots.push(created);
    return created;
  })();
  await act(async () => { target.render(<ExportKeySection />); });
  return target;
}

async function click(target: HTMLButtonElement): Promise<void> {
  await act(async () => {
    target.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  h.privyReady = false;
  h.availableMfaMethods = ['totp'];
  h.user = null;
  h.showEnrollment.mockReset();
  h.clearMfa.mockReset().mockResolvedValue(undefined);
  h.initMfa.mockReset().mockResolvedValue(undefined);
  h.promptMfa.mockReset().mockResolvedValue(undefined);
  h.exportWallet.mockReset();
  h.prove.mockReset();
  h.postRecent.mockReset();
  h.reloadStatus.mockReset();
  h.wallets = [{ address: 'embedded-address', standardWallet: { isPrivyWallet: true } }];
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
    .IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
});

describe('Privy export assurance', () => {
  it('does not expose Privy MFA or key export for an external session wallet', async () => {
    h.privyReady = true;
    h.user = { mfaMethods: ['totp'] };
    h.wallets = [{ address: 'embedded-address', standardWallet: { isPrivyWallet: false } }];
    await renderSection();

    expect(button('EXPORT PRIVATE KEY…')).toBeNull();
    expect(button('MANAGE PRIVY WALLET MFA…')).toBeNull();
    expect(button('REVEAL MY KEY')).toBeNull();
  });

  it('has no in-app export action until Privy reports an enrolled MFA method', async () => {
    const root = await renderSection();

    expect(document.body.textContent).toContain('CHECKING PRIVY WALLET SECURITY');
    expect(button('EXPORT PRIVATE KEY…')).toBeNull();
    expect(button('REVEAL MY KEY')).toBeNull();

    h.privyReady = true;
    h.user = { mfaMethods: [] };
    await renderSection(root);

    expect(button('EXPORT PRIVATE KEY…')).toBeNull();
    expect(button('REVEAL MY KEY')).toBeNull();
    const enroll = button('SECURE WALLET WITH PRIVY MFA');
    expect(enroll).not.toBeNull();
    expect(enroll?.style.background).not.toBe('transparent');
    expect(document.body.textContent).toContain('outside Pixel Kingdom Wars');
    expect(document.body.textContent).toContain('additional app-layer safeguard');
    await click(enroll!);
    expect(h.showEnrollment).toHaveBeenCalledOnce();

    h.user = { mfaMethods: ['totp'] };
    await renderSection(root);

    expect(button('SECURE WALLET WITH PRIVY MFA')).toBeNull();
    expect(button('EXPORT PRIVATE KEY…')).not.toBeNull();
  });

  it('explains the operator configuration gap instead of opening an unusable MFA modal', async () => {
    h.privyReady = true;
    h.availableMfaMethods = [];
    h.user = { mfaMethods: [] };
    await renderSection();

    expect(document.body.textContent).toContain('TEMPORARILY UNAVAILABLE');
    expect(document.body.textContent).toContain('enable wallet MFA');
    expect(button('SECURE WALLET WITH PRIVY MFA')).toBeNull();
    expect(button('EXPORT PRIVATE KEY…')).toBeNull();
    expect(h.showEnrollment).not.toHaveBeenCalled();
  });

  it('preserves export access for a user already enrolled before app methods are disabled', async () => {
    h.privyReady = true;
    h.availableMfaMethods = [];
    h.user = { mfaMethods: ['totp'] };
    await renderSection();

    expect(document.body.textContent).not.toContain('TEMPORARILY UNAVAILABLE');
    expect(button('SECURE WALLET WITH PRIVY MFA')).toBeNull();
    expect(button('EXPORT PRIVATE KEY…')).not.toBeNull();
  });

  it('does not treat a Privy passkey as the owner-selected Authenticator policy', async () => {
    h.privyReady = true;
    h.availableMfaMethods = ['totp'];
    h.user = { mfaMethods: ['passkey'] };
    await renderSection();

    expect(button('EXPORT PRIVATE KEY…')).toBeNull();
    expect(button('SECURE WALLET WITH PRIVY MFA')).not.toBeNull();
    expect(h.clearMfa).not.toHaveBeenCalled();
    expect(h.initMfa).not.toHaveBeenCalled();
    expect(h.promptMfa).not.toHaveBeenCalled();
  });

  it('warns before Privy enrolment and again at reveal that a lost Privy authenticator has no reset', async () => {
    // WHY (D-098, K-074): Privy cannot remove a user's MFA method and neither
    // can we — a lost Privy authenticator is lost for good. The warning must
    // stand where the setup key can still be saved (before enrolment) and at
    // the moment of reveal, with Privy's help centre and our support mailto
    // (wallet in the subject, never a code) as the only honest ways out.
    const expectWarning = (): void => {
      const note = document.body.querySelector<HTMLElement>('[role="note"]');
      expect(note?.textContent).toContain('PRIVY WALLET SECURITY IS A SEPARATE AUTHENTICATOR');
      expect(note?.textContent).toContain('NEITHER PRIVY NOR PIXEL KINGDOM WARS CAN RESET IT');
      expect(note?.textContent).toContain('KEEP THE SETUP KEY SOMEWHERE SAFE');
      const help = note?.querySelector<HTMLAnchorElement>(`a[href="${PRIVY_HELP_URL}"]`);
      expect(help?.getAttribute('target')).toBe('_blank');
      expect(help?.rel.split(/\s+/)).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
      const mail = note?.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
      const href = decodeURIComponent(mail?.getAttribute('href') ?? '');
      expect(href).toBe(`mailto:${SUPPORT_EMAIL}?subject=Lost Privy Wallet MFA · embedded-address`);
    };

    h.privyReady = true;
    h.user = { mfaMethods: [] };
    const root = await renderSection();
    expect(button('SECURE WALLET WITH PRIVY MFA')).not.toBeNull();
    expectWarning();

    h.user = { mfaMethods: ['totp'] };
    await renderSection(root);
    expect(document.body.querySelector('[role="note"]')).toBeNull();
    await click(button('EXPORT PRIVATE KEY…')!);
    expect(button('REVEAL MY KEY')).not.toBeNull();
    expectWarning();
  });

  it('runs SHARDKEEP defense-in-depth before invoking vendor export', async () => {
    const order: string[] = [];
    h.privyReady = true;
    h.user = { mfaMethods: ['totp'] };
    h.clearMfa.mockImplementation(async () => { order.push('mfa:clear'); });
    h.initMfa.mockImplementation(async () => { order.push('mfa:init:totp'); });
    h.promptMfa.mockImplementation(async () => { order.push('mfa:prompt'); });
    h.prove.mockImplementation(async (purpose: string) => {
      order.push(`prove:${purpose}`);
      return 'recent-grant';
    });
    h.postRecent.mockImplementation(async () => { order.push('challenge'); });
    h.exportWallet.mockImplementation(async () => { order.push('export'); });
    await renderSection();

    await click(button('EXPORT PRIVATE KEY…')!);
    expect(document.body.textContent).toContain('DEFENSE-IN-DEPTH');
    await click(button('REVEAL MY KEY')!);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(order).toEqual(['mfa:clear', 'mfa:init:totp', 'mfa:prompt', 'prove:key_export', 'challenge', 'export']);
    expect(h.initMfa).toHaveBeenCalledWith('totp');
    expect(h.postRecent).toHaveBeenCalledWith(
      '/auth/export/challenge', {}, 'recent-grant',
    );
    expect(h.exportWallet).toHaveBeenCalledWith({ address: 'embedded-address' });
  });
});
