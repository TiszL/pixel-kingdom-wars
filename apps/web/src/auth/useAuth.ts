/** SIWS auth: one challenge → one wallet approval → one cookie verification. */
import { useWallet } from '@solana/wallet-adapter-react';
import { useCallback, useEffect, useRef } from 'react';
import { create } from 'zustand';
import bs58 from 'bs58';
import { EVENTS, getDeviceId, track } from '../lib/analytics';
import { api } from '../lib/api';
import { signInClient } from '../lib/platform';
import { useApp } from '../state/store';
import { authCookies } from './authCookieCoordinator';
import { acceptLoginResponse, useLoginChallenge, type LoginResponse } from './loginChallenge';
import { waitForWalletApproval } from './walletSignature';

interface ChallengeResponse { nonce: string; message: string; expiresAt: string }
type SignInPhase = 'idle' | 'checking' | 'approval' | 'waiting' | 'verifying';
const useWalletLogin = create<{ phase: SignInPhase; error: string | null }>(() => ({ phase: 'idle', error: null }));
type Flight = { wallet: string; controller: AbortController; promise: Promise<void> };
// The native wallet is outside React. Unmounting/remounting the title must not
// create a second approval owner or abandon a cookie response already in flight.
let flight: Flight | null = null;
const phase = (value: SignInPhase): void => {
  useWalletLogin.setState({ phase: value });
  if (value !== 'idle') track(EVENTS.AUTH_SESSION_PHASE, { operation: 'wallet', phase: value });
};

export function cancelNativeSignIn(reason: 'user_cancelled' | 'wallet_change' | 'logout' | 'cross_tab' = 'user_cancelled'): void {
  const old = flight;
  if (!old) return;
  flight = null;
  authCookies.begin();
  old.controller.abort();
  track(EVENTS.AUTH_SESSION_PHASE, { operation: 'wallet', phase: 'cancelled', reason });
  useWalletLogin.setState({ phase: 'idle', error: reason === 'user_cancelled' ? 'Sign-in cancelled. Close the old wallet request before trying again.' : null });
}

export function useAuth(): {
  signIn: () => Promise<void>; cancelSignIn: () => void;
  signingIn: boolean; phase: SignInPhase; error: string | null;
} {
  const { publicKey, signMessage, connected } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const observedWallet = useRef(wallet);
  const observedConnected = useRef(connected);
  const setAuth = useApp((s) => s.setAuth);
  const state = useWalletLogin();
  useEffect(() => {
    if (flight && ((wallet !== null && wallet !== flight.wallet)
      || (observedWallet.current === flight.wallet && wallet === null)
      || (observedConnected.current === true && connected === false))) {
      cancelNativeSignIn('wallet_change');
    }
    observedWallet.current = wallet;
    observedConnected.current = connected;
  }, [wallet, connected]);

  const signIn = useCallback((): Promise<void> => {
    if (flight) return flight.promise;
    if (!wallet || !signMessage) {
      useWalletLogin.setState({ error: 'Connect a wallet first.' });
      return Promise.resolve();
    }
    const attempt = authCookies.begin();
    useLoginChallenge.getState().setWallet(null);
    const revision = useLoginChallenge.getState().revision;
    const owned: Flight = { wallet, controller: new AbortController(), promise: Promise.resolve() };
    flight = owned;
    const current = (): boolean => flight === owned && !owned.controller.signal.aborted
      && authCookies.current(attempt) && useLoginChallenge.getState().revision === revision;
    useWalletLogin.setState({ phase: 'checking', error: null });
    track(EVENTS.AUTH_SESSION_PHASE, { operation: 'wallet', phase: 'checking' });
    owned.promise = (async () => {
      try {
        await api.waitForAuth();
        if (!current()) return;
        const challenge = await api.get<ChallengeResponse>(`/auth/challenge?wallet=${wallet}`, { signal: owned.controller.signal });
        if (!current()) return;
        phase('approval');
        const signature = await waitForWalletApproval(
          signMessage(new TextEncoder().encode(challenge.message)), owned.controller.signal,
          () => { if (current()) phase('waiting'); },
        );
        if (!current()) return;
        if (Date.parse(challenge.expiresAt) <= Date.now()) {
          track(EVENTS.AUTH_SESSION_PHASE, { operation: 'wallet', phase: 'failed', reason: 'challenge_expired' });
          throw new Error('This sign-in request expired. Start a new sign-in when your wallet is ready.');
        }
        phase('verifying');
        // Cookie-changing requests are never aborted: the coordinator must
        // receive their headers/body and revoke an abandoned success safely.
        const verified = await api.postAuth<LoginResponse>('/auth/verify', {
          wallet, nonce: challenge.nonce, signature: bs58.encode(signature), client: signInClient(), deviceId: getDeviceId(),
        }, current);
        if (!current()) return;
        acceptLoginResponse(verified, setAuth);
        track(EVENTS.AUTH_SESSION_PHASE, { operation: 'wallet', phase: 'accepted' });
      } catch (error) {
        if (flight !== owned) return;
        useWalletLogin.setState({ error: error instanceof Error ? error.message : 'Sign-in failed. Please try again.' });
        track(EVENTS.AUTH_SESSION_PHASE, { operation: 'wallet', phase: 'failed' });
      } finally {
        if (flight === owned) { flight = null; phase('idle'); }
      }
    })();
    return owned.promise;
  }, [wallet, signMessage, setAuth]);
  return { signIn, cancelSignIn: cancelNativeSignIn, signingIn: state.phase !== 'idle', ...state };
}
