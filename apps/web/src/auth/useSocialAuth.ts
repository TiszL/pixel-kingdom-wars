/** Social sign-in exchanges provider-verified access and identity tokens when
 * enabled by the API. Wallet signatures remain the explicit legacy rollout path
 * and the separate authority for wallet-sensitive operations. */
import { getAccessToken, getIdentityToken, useLogin, usePrivy } from '@privy-io/react-auth';
import { useCreateWallet, useWallets } from '@privy-io/react-auth/solana';
import bs58 from 'bs58';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDeviceId } from '../lib/analytics';
import { api } from '../lib/api';
import { signInClient } from '../lib/platform';
import { useApp } from '../state/store';
import { authCookies } from './authCookieCoordinator';
import { acceptLoginResponse, useLoginChallenge, type LoginResponse } from './loginChallenge';
import { waitForWalletSignature } from './walletSignature';
import { clearSocialLoginIntent, consumeSocialLoginIntent, rememberSocialLoginIntent } from './socialLoginIntent';

interface ChallengeResponse {
  nonce: string;
  message: string;
  expiresAt: string;
}

export function useSocialAuth(): {
  signInWithSocial: () => void;
  signingIn: boolean;
  error: string | null;
} {
  const { ready, authenticated, user } = usePrivy();
  const currentSubject = useRef(user?.id);
  currentSubject.current = user?.id;
  const [tokenLogin, setTokenLogin] = useState<boolean | null>(null);
  const { ready: walletsReady, wallets } = useWallets();
  const { createWallet } = useCreateWallet();
  const setAuth = useApp((s) => s.setAuth);
  const [phase, setPhase] = useState<'idle' | 'options' | 'login' | 'wallet' | 'siws'>('idle');
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const loginRevision = useRef(0);
  const cookieAttempt = useRef(0);
  const attemptActive = useRef(false);
  const loginCompleted = useRef(false);
  const loginStarted = useRef(false);
  const walletCreationStarted = useRef(false);
  const mounted = useRef(true);

  const { login } = useLogin({
    // With createOnLogin="all-users", Privy calls onComplete only after both
    // authentication and any required embedded-wallet creation complete. An
    // explicit phase transition keeps the original click alive into SIWS.
    onComplete: () => {
      if (!mounted.current || !attemptActive.current) return;
      clearSocialLoginIntent();
      loginCompleted.current = true;
      setPhase('wallet');
    },
    onError: (code) => {
      if (!mounted.current || !attemptActive.current || loginCompleted.current) return;
      clearSocialLoginIntent();
      attemptActive.current = false;
      loginStarted.current = false;
      walletCreationStarted.current = false;
      setPhase('idle');
      if (code !== 'exited_auth_flow' && code !== 'oauth_user_denied') {
        setError('Unable to complete social sign-in. Please try again.');
      }
    },
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The Privy-managed embedded wallet, not any external Standard wallet the
  // user might also have connected. `useWallets()` returns Privy's
  // ConnectedStandardSolanaWallet wrapper; walletClientType is NOT a property
  // on that wrapper. The SDK's actual discriminator lives on standardWallet.
  const embedded = wallets.find(
    (wallet) => (wallet.standardWallet as { isPrivyWallet?: boolean }).isPrivyWallet === true,
  );

  // A title-screen click can beat Privy's async `ready` transition. Defer the
  // modal request until the SDK is ready instead of leaving `pending` latched
  // forever. Privy's login() is deliberately a no-op for an authenticated user,
  // so an exceptional legacy session without its embedded signer must use the
  // dedicated Solana creation API instead.
  useEffect(() => {
    if (
      phase !== 'login'
      || !ready
      || !authenticated
      || (loginStarted.current && !(tokenLogin === true && user?.linkedAccounts.some((account) =>
        account.type === 'wallet' && account.chainType === 'solana' && account.connectorType === 'embedded')))
      || !attemptActive.current
    ) return;
    // A click can also beat restoration of an existing Privy session. No fresh
    // modal means no onComplete callback, but the owned click must still proceed
    // to wallet publication and SIWS once restoration finishes.
    clearSocialLoginIntent();
    setPhase('wallet');
  }, [phase, ready, authenticated, tokenLogin, user]);

  useEffect(() => {
    if (phase !== 'login' || !ready || authenticated || loginStarted.current) return;
    try { rememberSocialLoginIntent(authCookies.assertSession()); }
    catch (cause) {
      attemptActive.current = false;
      setError(cause instanceof Error ? cause.message : 'Unable to continue social sign-in.');
      setPhase('idle');
      return;
    }
    loginStarted.current = true;
    login();
  }, [phase, ready, authenticated, login]);

  useEffect(() => {
    if (phase !== 'wallet' || !ready || !authenticated || tokenLogin !== false) return;
    // `authenticated` can precede the Solana wallet list. Wait for its own
    // readiness signal so an existing embedded wallet is never mistaken for a
    // missing one and sent through duplicate creation.
    // A fresh `login()` uses Privy's createOnLogin="all-users" contract and
    // publishes the embedded signer after authentication. Do not race that
    // SDK-owned creation with a second createWallet() call. This fallback is
    // only for a session that was already authenticated before this attempt.
    if (loginStarted.current || !walletsReady || embedded || walletCreationStarted.current) return;
    walletCreationStarted.current = true;
    void createWallet().catch(() => {
      walletCreationStarted.current = false;
      if (!mounted.current) return;
      attemptActive.current = false;
      setPhase('idle');
      setError('Unable to create your game wallet. Please try again.');
    });
  }, [phase, ready, authenticated, walletsReady, embedded, createWallet, tokenLogin]);

  // Once the user has logged in AND the embedded wallet exists, run SIWS exactly
  // once. `login()` is async (opens a modal), so this can't be inline in the
  // click handler — it fires when `authenticated` + `embedded` become ready.
  useEffect(() => {
    if (
      phase !== 'wallet'
      || tokenLogin !== false
      || !ready
      || !walletsReady
      || !authenticated
      || !embedded
      || running.current
    ) return;
    running.current = true;
    setPhase('siws');
    void (async () => {
      try {
        const wallet = embedded.address;
        const challenge = await api.get<ChallengeResponse>(`/auth/challenge?wallet=${wallet}`);
        const signed = await waitForWalletSignature(embedded.signMessage({
          message: new TextEncoder().encode(challenge.message),
        }));
        const verified = await api.postAuth<LoginResponse>('/auth/verify', {
          wallet,
          nonce: challenge.nonce,
          signature: bs58.encode(signed.signature),
          // Same session label as useAuth.ts (D-103 statistics split).
          client: signInClient(),
          deviceId: getDeviceId(),
        }, () => mounted.current && attemptActive.current && authCookies.current(cookieAttempt.current)
          && useLoginChallenge.getState().revision === loginRevision.current);
        if (mounted.current && attemptActive.current && useLoginChallenge.getState().revision === loginRevision.current) acceptLoginResponse(verified, setAuth);
      } catch (e) {
        if (mounted.current) setError(e instanceof Error ? e.message : 'social sign-in failed');
      } finally {
        running.current = false;
        attemptActive.current = false;
        loginCompleted.current = false;
        loginStarted.current = false;
        walletCreationStarted.current = false;
        if (mounted.current) setPhase('idle');
      }
    })();
  }, [phase, ready, walletsReady, authenticated, embedded, setAuth, tokenLogin]);

  // A restored signer is not a prerequisite for ordinary social login. The
  // signed identity token contains the embedded wallet even while its signer is
  // locked behind Privy MFA. Only legacy accounts missing a wallet create one.
  useEffect(() => {
    if (phase !== 'wallet' || tokenLogin !== true || !ready || !authenticated || !user || running.current) return;
    running.current = true;
    setPhase('siws');
    const subject = user.id;
    void (async () => {
      try {
        const ownsEmbeddedWallet = user.linkedAccounts.some((account) =>
          account.type === 'wallet' && account.chainType === 'solana'
          && account.connectorType === 'embedded');
        if (!ownsEmbeddedWallet) await createWallet();
        const accessToken = await getAccessToken();
        const identityToken = await getIdentityToken();
        if (!mounted.current || !attemptActive.current || useLoginChallenge.getState().revision !== loginRevision.current || currentSubject.current !== subject) {
          return;
        }
        if (!accessToken || !identityToken) throw new Error('Social identity is not ready. Please sign in again.');
        const verified = await api.postAuth<LoginResponse>('/auth/social', {
          accessToken, identityToken, client: signInClient(), deviceId: getDeviceId(),
        }, () => mounted.current && attemptActive.current && currentSubject.current === subject
          && authCookies.current(cookieAttempt.current)
          && useLoginChallenge.getState().revision === loginRevision.current);
        if (mounted.current && attemptActive.current && useLoginChallenge.getState().revision === loginRevision.current && currentSubject.current === subject) {
          acceptLoginResponse(verified, setAuth);
        }
      } catch (e) {
        if (mounted.current && currentSubject.current === subject) {
          setError(e instanceof Error ? e.message : 'social sign-in failed');
        }
      } finally {
        running.current = false; attemptActive.current = false;
        loginCompleted.current = false; loginStarted.current = false; walletCreationStarted.current = false;
        if (mounted.current) setPhase('idle');
      }
    })();
  }, [phase, tokenLogin, ready, authenticated, user, createWallet, setAuth]);

  const signInWithSocial = useCallback(() => {
    if (attemptActive.current) return;
    attemptActive.current = true;
    cookieAttempt.current = authCookies.begin();
    const attempt = cookieAttempt.current;
    useLoginChallenge.getState().setWallet(null);
    loginRevision.current = useLoginChallenge.getState().revision;
    loginCompleted.current = false;
    loginStarted.current = false;
    walletCreationStarted.current = false;
    setError(null);
    setTokenLogin(null);
    setPhase('options');
    void api.waitForAuth().then(() => {
      if (!authCookies.current(attempt)) throw new Error('Sign-in changed. Please try again.');
      return api.get<{ socialTokenLogin: boolean }>('/auth/options');
    }).then((options) => {
      if (!mounted.current || !attemptActive.current || cookieAttempt.current !== attempt) return;
      if (!authCookies.current(attempt)) {
        attemptActive.current = false; setPhase('idle');
        return;
      }
      if (typeof options.socialTokenLogin !== 'boolean') throw new Error('Sign-in configuration is unavailable. Please try again.');
      setTokenLogin(options.socialTokenLogin);
      setPhase(authenticated ? 'wallet' : 'login');
    }).catch((e: unknown) => {
      if (!mounted.current || cookieAttempt.current !== attempt) return;
      attemptActive.current = false; setPhase('idle');
      setError(e instanceof Error ? e.message : 'Sign-in configuration is unavailable.');
    });
  }, [authenticated]);

  // OAuth may return to a fresh document, losing the hook refs that owned the
  // click. Resume only its one-use intent after the normal cookie restoration
  // has had a chance to establish a full or limited game session.
  useEffect(() => {
    if (phase !== 'idle' || !ready || !authenticated || !user || attemptActive.current) return;
    let live = true;
    const subject = user.id;
    void api.waitForAuth().then(() => {
      if (!live || attemptActive.current || currentSubject.current !== subject) return;
      if (useApp.getState().authed || useLoginChallenge.getState().wallet) {
        clearSocialLoginIntent();
        return;
      }
      if (consumeSocialLoginIntent(authCookies.assertSession())) signInWithSocial();
    }).catch(() => { clearSocialLoginIntent(); });
    return () => { live = false; };
  }, [phase, ready, authenticated, user, signInWithSocial]);

  return { signInWithSocial, signingIn: phase !== 'idle', error };
}
