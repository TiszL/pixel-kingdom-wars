/**
 * This package deliberately has no DOM test runtime. The provider/sheet seam is
 * therefore split at the same boundary production uses: App.test.ts pins that
 * WalletProvider is the sole connect() owner, while this tests the reducer fed by
 * the typed provider-error event. Together they cover select → reject → retry
 * without inventing a second connection implementation for a test.
 */
import { describe, expect, it } from 'vitest';
import { bus } from '../lib/events';
import {
  connectOptionKey, connectUiReducer, INITIAL_CONNECT_UI_STATE, walletAttemptBusy,
} from './ConnectSheet';

describe('ConnectSheet provider-owned attempt state', () => {
  it('associates a provider rejection with the chosen row, then makes retry clean', () => {
    const selected = connectUiReducer(INITIAL_CONNECT_UI_STATE, { type: 'choose', walletName: 'Phantom' });
    expect(selected).toEqual({ pending: 'Phantom', errors: {} });

    let rejected = selected;
    const off = bus.on('wallet:error', (notice) => {
      rejected = connectUiReducer(rejected, { type: 'provider-error', notice });
    });
    bus.emit('wallet:error', {
      walletName: 'Phantom', name: 'WalletConnectionError', message: 'User rejected the request.',
    });
    off();
    expect(rejected).toEqual({ pending: null, errors: { Phantom: 'CONNECTION CANCELLED' } });

    const retry = connectUiReducer(rejected, { type: 'choose', walletName: 'Phantom' });
    expect(retry).toEqual({ pending: 'Phantom', errors: {} });
  });

  it('ignores stale errors from the wallet being switched away from', () => {
    const selected = connectUiReducer(INITIAL_CONNECT_UI_STATE, { type: 'choose', walletName: 'Solflare' });
    const stale = connectUiReducer(selected, {
      type: 'provider-error',
      notice: { walletName: 'MetaMask', name: 'WalletDisconnectedError', message: 'disconnected' },
    });
    expect(stale).toBe(selected);
  });

  it('uses the pending row when an upstream error has no adapter identity', () => {
    const selected = connectUiReducer(INITIAL_CONNECT_UI_STATE, { type: 'choose', walletName: 'Backpack' });
    const failed = connectUiReducer(selected, {
      type: 'provider-error',
      notice: { walletName: null, name: 'WalletError', message: '' },
    });
    expect(failed).toEqual({ pending: null, errors: { Backpack: 'CONNECTION FAILED' } });
  });

  it('locks every wallet route from the first selection until provider settlement', () => {
    expect(walletAttemptBusy(null, false)).toBe(false);
    expect(walletAttemptBusy('Phantom', false)).toBe(true); // before provider effect starts
    expect(walletAttemptBusy('Phantom', true)).toBe(true);
    expect(walletAttemptBusy(null, true)).toBe(true); // remembered auto-connect
    expect(walletAttemptBusy(null, false, true)).toBe(true); // provider/adapter StrictMode drift
  });

  it('gives asynchronously inserted wallet rows stable reconciliation keys', () => {
    const metaMask = { kind: 'adapter', walletName: 'MetaMask', label: 'METAMASK', primary: false } as const;
    const phantom = { kind: 'adapter', walletName: 'Phantom', label: 'PHANTOM', primary: true } as const;
    expect(connectOptionKey(metaMask)).toBe('adapter:MetaMask');
    expect(connectOptionKey(phantom)).toBe('adapter:Phantom');
    // Inserting Phantom ahead of MetaMask must not change MetaMask's identity.
    expect([phantom, metaMask].map(connectOptionKey)).toEqual([
      'adapter:Phantom', 'adapter:MetaMask',
    ]);
  });
});
