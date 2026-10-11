/**
 * Fail-safe bridge between wallet-provider identity and the server session.
 * A Phantom account switch updates Wallet Standard without changing the
 * httpOnly game cookie; allowing that stale session to remain would display
 * one account while signing with another. A definite non-null mismatch clears
 * the game immediately. Null during initial provider hydration is ignored, and
 * an explicit adapter disconnect is acted on only after this hook observed the
 * adapter owning the established session.
 */
import { useWallet } from '@solana/wallet-adapter-react';
import { useWallets } from '@privy-io/react-auth/solana';
import { useCallback, useEffect, useRef } from 'react';
import { api } from '../lib/api';
import { useApp } from '../state/store';
import { findPrivyEmbeddedWallet } from './privyWallet';
import { suspendPushSession } from '../lib/pushSubscription';
import { EVENTS, track } from '../lib/analytics';

const PRIVY_ENABLED = !!import.meta.env.VITE_PRIVY_APP_ID;

function invalidateSession(expectedWallet: string): void {
  const state = useApp.getState();
  if (!state.authed || state.wallet !== expectedWallet) return;
  track(EVENTS.AUTH_SESSION_PHASE, { operation: 'session', phase: 'invalidated', reason: 'wallet_change' });
  // Mark push detached before local invalidation, then retire its endpoint
  // before revoking the cookie. Local game state still fails closed at once.
  const retirePush = suspendPushSession();
  state.setAuth(null);
  state.setScreen('title');
  void api.logout(() => retirePush).catch(() => null);
}

function useFence(embeddedSession: boolean, identityReady = true): void {
  const { wallet, publicKey, connected } = useWallet();
  const sessionWallet = useApp((state) => state.wallet);
  const authed = useApp((state) => state.authed);
  const matched = useRef<string | null>(null);

  useEffect(() => {
    // Privy can restore its authenticated cookie before its Solana-wallet list.
    // Until that list is authoritative, an external adapter does not prove the
    // session is external and must not evict a valid embedded-wallet session.
    if (!identityReady) return;
    if (!authed || !sessionWallet || embeddedSession) {
      matched.current = null;
      return;
    }
    const providerWallet = connected ? publicKey?.toBase58() ?? null : null;
    // Null is ambiguous during initial auto-connect/provider hydration. A real
    // disconnect is handled by the adapter event below after a match was seen.
    if (providerWallet === null) return;
    if (providerWallet === sessionWallet) {
      matched.current = sessionWallet;
      return;
    }
    matched.current = null;
    invalidateSession(sessionWallet);
  }, [authed, sessionWallet, embeddedSession, identityReady, connected, publicKey]);

  const adapter = wallet?.adapter ?? null;
  const onDisconnect = useCallback(() => {
    const expected = matched.current;
    matched.current = null;
    if (expected) invalidateSession(expected);
  }, []);

  useEffect(() => {
    if (!adapter) return;
    adapter.on('disconnect', onDisconnect);
    return () => { adapter.off('disconnect', onDisconnect); };
  }, [adapter, onDisconnect]);
}

function useWalletSessionFenceAdapter(): void {
  useFence(false);
}

function useWalletSessionFencePrivy(): void {
  const sessionWallet = useApp((state) => state.wallet);
  const { ready, wallets } = useWallets();
  useFence(findPrivyEmbeddedWallet(wallets, sessionWallet) !== undefined, ready);
}

export const useWalletSessionFence: () => void = PRIVY_ENABLED
  ? useWalletSessionFencePrivy
  : useWalletSessionFenceAdapter;
