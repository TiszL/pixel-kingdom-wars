import { describe, expect, it } from 'vitest';
import { findPrivyEmbeddedWallet, walletMatchesSession } from './privyWallet';

const wallet = (address: string, isPrivyWallet?: boolean) => ({
  address,
  standardWallet: { isPrivyWallet },
});

describe('findPrivyEmbeddedWallet', () => {
  it('selects only the session-matching wallet that Privy marks as embedded', () => {
    const embedded = wallet('session-wallet', true);
    expect(findPrivyEmbeddedWallet([
      wallet('other-wallet', true), wallet('session-wallet', false), embedded,
    ], 'session-wallet')).toBe(embedded);
  });

  it('rejects an external Wallet Standard wrapper even when its address matches', () => {
    expect(findPrivyEmbeddedWallet([
      wallet('session-wallet', false),
    ], 'session-wallet')).toBeUndefined();
  });

  it('allows an external adapter only while it still owns the authenticated session', () => {
    const adapter = (address: string) => ({ toBase58: () => address });
    expect(walletMatchesSession(adapter('session-wallet'), 'session-wallet')).toBe(true);
    expect(walletMatchesSession(adapter('switched-wallet'), 'session-wallet')).toBe(false);
    expect(walletMatchesSession(null, 'session-wallet')).toBe(false);
  });
});
