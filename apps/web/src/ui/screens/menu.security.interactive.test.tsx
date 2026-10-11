/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TwoFaStatus } from './menu';

const h = vi.hoisted(() => ({
  status: null as TwoFaStatus | null,
  /** Wallet kind for useRecentAuth: the recovery hint differs by it (D-099). */
  isEmbedded: true,
  reload: vi.fn(),
  prove: vi.fn(),
  freshMfa: vi.fn(),
  signOut: vi.fn(),
  post: vi.fn(),
  postRecent: vi.fn(),
}));

vi.mock('../useFetch', () => ({
  useFetch: () => ({ data: h.status, loading: false, error: null, reload: h.reload }),
}));
vi.mock('../../auth/useRecentAuth', () => ({
  useRecentAuth: () => ({ prove: h.prove, isEmbedded: h.isEmbedded }),
}));
vi.mock('../../auth/useFreshPrivyMfa', async (importOriginal) => ({
  // Keep the real error class/predicate: the screen matches on the stable code.
  ...await importOriginal<typeof import('../../auth/useFreshPrivyMfa')>(),
  useFreshPrivyMfa: () => h.freshMfa,
}));
vi.mock('../../auth/useSignOut', () => ({ useSignOut: () => h.signOut }));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, post: h.post, postRecent: h.postRecent } };
});
vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({
  useGameWallet: () => ({ publicKey: null, sendTransaction: null, connection: null }),
}));

import { PrivyMfaNotEnrolledError } from '../../auth/useFreshPrivyMfa';
import { bus } from '../../lib/events';
import { DISCORD_URL, SUPPORT_EMAIL } from '../../lib/support';
import { SecurityScreen } from './menu';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const RECOVERY_ID = '8b9f3642-4299-49f8-8cf8-f94cb0dc6607';
const baseStatus = (): TwoFaStatus => ({
  totpEnabled: true,
  emailVerified: true,
  email: 'player@example.com',
  pendingEmail: null,
  totpReady: true,
  totpReadyAt: null,
  instantEligible: true,
  instantWithdrawalsEnabled: true,
  reenrollmentRequired: false,
  recoveryEnabled: true,
  recovery: {
    recoveryId: null, status: null, readyAt: null, expiresAt: null,
    reenrollmentRequired: false,
  },
});

function button(host: HTMLElement, label: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label);
  if (!(found instanceof HTMLButtonElement)) throw new Error(`button not found: ${label}`);
  return found;
}

describe('SecurityScreen authenticator recovery interactions', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    h.status = baseStatus();
    h.isEmbedded = true;
    h.reload.mockReset();
    h.prove.mockReset().mockResolvedValue('recent-grant');
    h.freshMfa.mockReset().mockResolvedValue(undefined);
    h.signOut.mockReset().mockResolvedValue(undefined);
    h.post.mockReset().mockResolvedValue({});
    h.postRecent.mockReset().mockResolvedValue({ status: h.status.recovery });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await act(async () => root.unmount());
    host.remove();
  });

  it('starts once on a same-tick double tap and orders fresh Privy TOTP before exact wallet proof', async () => {
    let release!: () => void;
    h.freshMfa.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    await act(async () => root.render(<SecurityScreen />));

    await act(async () => {
      button(host, 'LOST AUTHENTICATOR?').click();
      button(host, 'LOST AUTHENTICATOR?').click();
      await Promise.resolve();
    });
    expect(h.freshMfa).toHaveBeenCalledOnce();
    expect(h.prove).not.toHaveBeenCalled();

    await act(async () => { release(); await Promise.resolve(); await Promise.resolve(); });
    expect(h.prove).toHaveBeenCalledWith('totp_recovery', expect.objectContaining({ action: 'start' }));
    expect(h.postRecent).toHaveBeenCalledOnce();
    expect(h.postRecent.mock.calls[0]?.[0]).toBe('/2fa/totp/recovery/start');
  });

  it('lets a pending request be cancelled with the current PKW code and preserves mobile input semantics', async () => {
    h.status = {
      ...baseStatus(),
      recovery: {
        recoveryId: RECOVERY_ID, status: 'email_pending', readyAt: null,
        expiresAt: new Date(Date.now() + 300_000).toISOString(), reenrollmentRequired: false,
      },
    };
    await act(async () => root.render(<SecurityScreen />));
    const input = host.querySelector<HTMLInputElement>(
      'input[aria-label="Current Pixel Kingdom Wars Authenticator Code"]',
    )!;
    expect(input.inputMode).toBe('numeric');
    expect(input.autocomplete).toBe('one-time-code');
    expect(input.style.minHeight).toBe('44px');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '123456');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => { button(host, 'CANCEL RECOVERY').click(); await Promise.resolve(); });
    expect(h.post).toHaveBeenCalledWith('/2fa/totp/recovery/cancel', {
      recoveryId: RECOVERY_ID, code: '123456',
    });
    expect(h.freshMfa).not.toHaveBeenCalled();
  });

  it('refreshes at readyAt, hides email mutation during hold, and signs out only after completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-02T10:00:00.000Z'));
    h.status = {
      ...baseStatus(),
      recovery: {
        recoveryId: RECOVERY_ID, status: 'holding',
        readyAt: '2026-09-02T10:00:01.000Z',
        expiresAt: '2026-09-09T10:00:00.000Z', reenrollmentRequired: false,
        receipt: { cancelledWithdrawals: 2, inFlightWithdrawals: 1, refundedKeep: '1250' },
      },
    };
    h.postRecent.mockImplementation(async (path: string) => (
      path.endsWith('/send-code') ? { sent: true, devCode: '654321' } : {}
    ));
    await act(async () => root.render(<SecurityScreen />));
    expect(host.textContent).not.toContain('VERIFIED CONTACT EMAIL');
    expect(host.textContent).not.toContain('SEND COMPLETION EMAIL CODE');
    const receipt = host.querySelector<HTMLElement>('[role="status"]')!;
    expect(receipt.textContent).toContain('2 PENDING WITHDRAWAL(S) CANCELLED');
    expect(receipt.textContent).toContain('1 PROCESSING LEFT UNTOUCHED');
    expect(receipt.style.whiteSpace).toBe('normal');
    expect(receipt.style.overflowWrap).toBe('anywhere');

    await act(async () => { await vi.advanceTimersByTimeAsync(1_026); });
    expect(h.reload).toHaveBeenCalledOnce();
    expect(host.textContent).toContain('SEND COMPLETION EMAIL CODE');

    await act(async () => {
      button(host, 'SEND COMPLETION EMAIL CODE').click();
      await Promise.resolve(); await Promise.resolve();
    });
    expect(h.freshMfa).toHaveBeenCalledOnce();
    expect(h.prove).toHaveBeenCalledWith('totp_recovery', {
      recoveryId: RECOVERY_ID, action: 'complete',
    });
    const completion = host.querySelector<HTMLInputElement>(
      'input[aria-label="Authenticator recovery completion email code"]',
    )!;
    expect(completion.value).toBe('654321');
    await act(async () => { button(host, 'REMOVE OLD AUTHENTICATOR & SIGN OUT').click(); await Promise.resolve(); await Promise.resolve(); });
    expect(h.postRecent).toHaveBeenLastCalledWith(
      '/2fa/totp/recovery/complete',
      { recoveryId: RECOVERY_ID, code: '654321' },
      'recent-grant',
    );
    expect(h.signOut).toHaveBeenCalledOnce();
  });

  it('explains Privy enrolment when fresh MFA is unavailable', async () => {
    // WHY (D-098): an embedded wallet without Privy Wallet MFA failed BEFORE
    // the wallet proof with a raw vendor toast — a dead end the player could
    // not read. The screen now matches the stable code and points at the
    // enrolment control below; nothing is posted and the button stays live.
    h.freshMfa.mockRejectedValue(new PrivyMfaNotEnrolledError());
    const toasts: string[] = [];
    const off = bus.on('ui:toast', ({ msg }) => { toasts.push(msg); });
    try {
      await act(async () => root.render(<SecurityScreen />));
      await act(async () => {
        button(host, 'LOST AUTHENTICATOR?').click();
        await Promise.resolve(); await Promise.resolve();
      });
    } finally {
      off();
    }
    expect(host.querySelector('[role="alert"]')?.textContent)
      .toContain('ENROL PRIVY WALLET MFA FIRST (SECURE WALLET WITH PRIVY MFA, below) — then tap LOST AUTHENTICATOR? again.');
    expect(h.prove).not.toHaveBeenCalled();
    expect(h.postRecent).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
    expect(button(host, 'LOST AUTHENTICATOR?').disabled).toBe(false);
  });

  it('hands a no-verified-email account a real support address, not a sentence', async () => {
    // WHY (D-094 unchanged, D-098): such an account is support-only with no
    // automated bypass. The button stays off; the screen says why and renders
    // the mailto, a copy control (mailto is inert in the dApp-store WebView)
    // and the Discord invite, so "support" is somewhere the player can reach.
    h.status = { ...baseStatus(), emailVerified: false, email: null };
    await act(async () => root.render(<SecurityScreen />));
    expect(button(host, 'LOST AUTHENTICATOR?').disabled).toBe(true);
    expect(host.textContent).toContain('this account has none');
    expect(host.textContent).toContain('Standard withdrawals never need the code');
    const mail = host.querySelector<HTMLAnchorElement>('a[href^="mailto:"]');
    expect(mail?.getAttribute('href')).toMatch(new RegExp(`^mailto:${SUPPORT_EMAIL}\\?subject=Lost%20Pixel%20Kingdom%20Wars%20authenticator`));
    expect(mail?.textContent).toContain(SUPPORT_EMAIL);
    expect(button(host, 'COPY ADDRESS').disabled).toBe(false);
    expect(host.querySelector(`a[href="${DISCORD_URL}"]`)).not.toBeNull();
  });

  it('shows only replacement-enrollment controls after a completed recovery latch', async () => {
    h.status = {
      ...baseStatus(), totpEnabled: false, reenrollmentRequired: true,
      recovery: {
        recoveryId: RECOVERY_ID, status: 'completed', readyAt: null, expiresAt: null,
        reenrollmentRequired: true,
      },
    };
    await act(async () => root.render(<SecurityScreen />));
    expect(host.textContent).toContain('REPLACEMENT AUTHENTICATOR REQUIRED');
    expect(host.textContent).toContain('SEND CONFIRMATION CODE');
    expect(host.textContent).not.toContain('VERIFIED CONTACT EMAIL');
    expect(host.textContent).not.toContain('LOST AUTHENTICATOR?');
  });

  it('tells each wallet kind its own recovery order under LOST AUTHENTICATOR? (D-099)', async () => {
    // WHY: an external wallet is never asked for Privy MFA (useFreshPrivyMfa
    // returns at once when !isEmbedded), yet the only copy near the button
    // spoke of Privy MFA — an external-wallet player went looking for a
    // factor they never had. The hint is keyed on the wallet kind, not on
    // the enrolment error, so it reads right before the first tap.
    const embedded = 'PRIVY WALLET MFA FIRST, THEN A WALLET SIGNATURE AND THE EMAIL CODE';
    const external = 'EXTERNAL WALLET: SIGN A MESSAGE WITH YOUR WALLET, THEN ENTER THE EMAIL CODE — NO PRIVY MFA NEEDED';
    await act(async () => root.render(<SecurityScreen />));
    expect(button(host, 'LOST AUTHENTICATOR?').disabled).toBe(false);
    expect(host.textContent).toContain(embedded);
    expect(host.textContent).not.toContain(external);

    await act(async () => root.unmount());
    h.isEmbedded = false;
    root = createRoot(host);
    await act(async () => root.render(<SecurityScreen />));
    expect(button(host, 'LOST AUTHENTICATOR?').disabled).toBe(false);
    expect(host.textContent).toContain(external);
    expect(host.textContent).not.toContain(embedded);
  });
});
