/**
 * Unified sign-out: ends the server session (POST /auth/logout clears the
 * httpOnly cookie + revokes sessions), logs out of Privy (so a different
 * social/email account can sign in — needed for testing and shared devices),
 * clears client auth state, returns to the title, and disconnects the adapter.
 * Phantom's injected mobile provider is deliberately preserved instead:
 * its Wallet Standard disconnect poisons the next connection after an account
 * switch. Module-level branch on VITE_PRIVY_APP_ID like useGameWallet.
 */
import { useWallet } from '@solana/wallet-adapter-react';
import { usePrivy } from '@privy-io/react-auth';
import { useCallback } from 'react';
import { api } from '../lib/api';
import { caps } from '../lib/platform';
import { useLoginChallenge } from './loginChallenge';
import { useApp } from '../state/store';
import { injectedPhantomProvider, isMobileInjectedPhantom } from './injectedPhantom';
import { suspendPushSession } from '../lib/pushSubscription';
import { cancelNativeSignIn } from './useAuth';
import { EVENTS, track } from '../lib/analytics';

const PRIVY_ENABLED = !!import.meta.env.VITE_PRIVY_APP_ID;

function useSignOutAdapter(): (afterLogout?: () => Promise<unknown>) => Promise<void> {
  const { disconnect, wallet } = useWallet();
  return useCallback(async (afterLogout?: () => Promise<unknown>) => {
    track(EVENTS.AUTH_SESSION_PHASE, { operation: 'session', phase: 'start', reason: 'logout' });
    cancelNativeSignIn('logout');
    // Fence and retire the private delivery endpoint while the game cookie can
    // still authorize its DELETE. Local auth clears immediately so gameplay
    // cannot race the slower best-effort network retirement.
    const retirePush = suspendPushSession();
    const s = useApp.getState();
    useLoginChallenge.getState().setWallet(null);
    s.setAuth(null);
    s.setScreen('title');
    // Legacy Wallet Standard Phantom disconnect poisons the next mobile
    // connection, so preserve only that adapter. Phantom Mobile's custom
    // disconnect is deliberately local and must run to clear React's connected
    // state after sign-out; it does not revoke the injected provider.
    const walletName = wallet?.adapter.name ?? null;
    const preserveLegacyPhantom = walletName?.trim().toLowerCase() === 'phantom'
      && isMobileInjectedPhantom(
      caps.platform,
      walletName,
      injectedPhantomProvider(),
      );
    const disconnectAdapter = preserveLegacyPhantom
      ? Promise.resolve()
      : disconnect().catch(() => null);
    await api.logout(() => Promise.all([retirePush, disconnectAdapter]), afterLogout).catch(() => null);
  }, [disconnect, wallet]);
}

function useSignOutPrivy(): () => Promise<void> {
  const base = useSignOutAdapter();
  const { logout } = usePrivy();
  return useCallback(async () => {
    await base(() => logout().catch(() => null));
  }, [logout, base]);
}

export const useSignOut: () => () => Promise<void> = PRIVY_ENABLED ? useSignOutPrivy : useSignOutAdapter;
