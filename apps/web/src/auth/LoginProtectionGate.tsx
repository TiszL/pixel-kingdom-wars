import { lazy, Suspense, useEffect, useState } from 'react';
import { api, setLoginRequiredHandler } from '../lib/api';
import { useApp } from '../state/store';
import { Btn, COLORS as C } from '../ui/primitives';
import { authCookies } from './authCookieCoordinator';
import { acceptLoginResponse, useLoginChallenge, type LoginResponse } from './loginChallenge';
import { useSignOut } from './useSignOut';

const Recovery = lazy(() => import('../ui/screens/menu').then((m) => ({ default: m.SecurityScreen })));

export function LoginProtectionGate(): React.JSX.Element | null {
  const wallet = useLoginChallenge((s) => s.wallet);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState(false);
  const signOut = useSignOut();
  useEffect(() => {
    let live = true;
    let pending = false;
    const restore = (): void => {
      // /me can also request this while the initial check is still pending.
      // Keep one cookie-owning request; never queue a second stalled check.
      if (pending) return;
      pending = true;
      const revision = useLoginChallenge.getState().revision;
      void api.get<{ loginRequired: boolean; wallet?: string }>('/auth/login/status').then((r) => {
        if (live && r.loginRequired && r.wallet && useLoginChallenge.getState().revision === revision) {
          useApp.getState().setAuth(null);
          useLoginChallenge.getState().setWallet(r.wallet);
        }
      }).catch(() => { /* the normal sign-in surface remains retryable */ }).finally(() => { pending = false; });
    };
    restore();
    setLoginRequiredHandler(restore);
    return () => { live = false; setLoginRequiredHandler(null); };
  }, []);
  useEffect(() => { setCode(''); setError(null); setRecovery(false); }, [wallet]);
  if (!wallet) return null;
  const verify = async (): Promise<void> => {
    if (busy) return;
    const attempt = authCookies.begin();
    setBusy(true); setError(null);
    try {
      const response = await api.postAuth<LoginResponse>('/auth/login/verify', { code: code.trim() },
        () => authCookies.current(attempt) && useLoginChallenge.getState().wallet === wallet);
      if (useLoginChallenge.getState().wallet !== wallet) return;
      acceptLoginResponse(response, useApp.getState().setAuth);
    } catch (e) {
      if (useLoginChallenge.getState().wallet === wallet) setError(e instanceof Error ? e.message : 'Verification failed');
    } finally { setBusy(false); }
  };
  return (
    <div role="dialog" aria-modal="true" aria-label="PKW login verification" className="interactive"
      style={{ position: 'fixed', inset: 0, zIndex: 9000, background: C.ink, color: C.text,
        overflow: 'auto', padding: 'max(16px, env(safe-area-inset-top)) 16px max(16px, env(safe-area-inset-bottom))',
        display: 'flex', flexDirection: 'column', gap: 12 }}>
      {recovery ? <Suspense fallback={<span>LOADING ACCOUNT RECOVERY…</span>}>
        <Recovery loginRecovery onLoginClose={() => setRecovery(false)} />
      </Suspense> : <div style={{ width: '100%', maxWidth: 440, margin: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
        <h1 style={{ fontSize: 24 }}>PKW AUTHENTICATOR</h1>
        <p>Enter the six-digit code from your Pixel Kingdom Wars authenticator to finish signing in.</p>
        <input aria-label="PKW login authenticator code" value={code} onChange={(e) => setCode(e.target.value)}
          inputMode="numeric" autoComplete="one-time-code" maxLength={6}
          style={{ font: 'inherit', fontSize: 24, minHeight: 48, color: C.text, background: C.surface, border: `2px solid ${C.border}`, padding: 8 }} />
        {error && <div role="alert" style={{ color: C.danger }}>{error}</div>}
        <Btn disabled={busy || !/^\d{6}$/.test(code.trim())} onClick={() => void verify()}>
          {busy ? 'VERIFYING…' : 'VERIFY & SIGN IN'}
        </Btn>
        <Btn variant="sec" disabled={busy} onClick={() => setRecovery(true)}>LOST AUTHENTICATOR?</Btn>
      </div>}
      <Btn variant="ghost" disabled={busy} onClick={() => void signOut()}>SIGN OUT</Btn>
    </div>
  );
}
