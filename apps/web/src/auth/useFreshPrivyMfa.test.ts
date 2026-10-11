import { describe, expect, it, vi } from 'vitest';
import {
  isPrivyMfaNotEnrolled, PRIVY_MFA_NOT_ENROLLED, PrivyMfaNotEnrolledError, requireFreshPrivyTotp,
} from './useFreshPrivyMfa';

describe('fresh Privy Authenticator ceremony', () => {
  it('skips vendor MFA for external wallets', async () => {
    const clear = vi.fn();
    const init = vi.fn();
    const promptMfa = vi.fn();
    await requireFreshPrivyTotp({
      isEmbedded: false, ready: false, mfaMethods: undefined, clear, init, promptMfa,
    });
    expect(clear).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(promptMfa).not.toHaveBeenCalled();
  });

  it.each([undefined, [], ['passkey']])('refuses embedded users without TOTP: %j', async (mfaMethods) => {
    await expect(requireFreshPrivyTotp({
      isEmbedded: true,
      ready: true,
      mfaMethods,
      clear: vi.fn(),
      init: vi.fn(),
      promptMfa: vi.fn(),
    })).rejects.toThrow(/Privy Authenticator must be enrolled/);
  });

  it('carries a stable code for the not-enrolled refusal so screens never match on message text', async () => {
    // WHY (D-098): SecurityScreen turns exactly this failure into an inline
    // "enrol Privy MFA first" hint. Message matching is the habit that produced
    // the old 401→"session expired" lie; the code is the contract.
    const refusal = requireFreshPrivyTotp({
      isEmbedded: true, ready: true, mfaMethods: [], clear: vi.fn(), init: vi.fn(), promptMfa: vi.fn(),
    });
    await expect(refusal).rejects.toBeInstanceOf(PrivyMfaNotEnrolledError);
    await expect(refusal).rejects.toMatchObject({ code: PRIVY_MFA_NOT_ENROLLED });
    await refusal.catch((error: unknown) => {
      expect(isPrivyMfaNotEnrolled(error)).toBe(true);
    });
    expect(isPrivyMfaNotEnrolled(new Error('Privy Authenticator must be enrolled before this security action.'))).toBe(false);
    expect(isPrivyMfaNotEnrolled(null)).toBe(false);
    expect(isPrivyMfaNotEnrolled({ code: 'OTHER' })).toBe(false);
  });

  it('runs exactly clear, TOTP init, then prompt and propagates failures', async () => {
    const order: string[] = [];
    await requireFreshPrivyTotp({
      isEmbedded: true,
      ready: true,
      mfaMethods: ['totp', 'passkey'],
      clear: async () => { order.push('clear'); },
      init: async (method) => { order.push(`init:${method}`); },
      promptMfa: async () => { order.push('prompt'); },
    });
    expect(order).toEqual(['clear', 'init:totp', 'prompt']);

    const error = new Error('vendor rejected MFA');
    await expect(requireFreshPrivyTotp({
      isEmbedded: true,
      ready: true,
      mfaMethods: ['totp'],
      clear: async () => undefined,
      init: async () => { throw error; },
      promptMfa: vi.fn(),
    })).rejects.toBe(error);
  });
});
