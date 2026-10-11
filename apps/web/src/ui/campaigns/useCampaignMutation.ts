import { useEffect, useRef, useState } from 'react';
import { api, ApiError, idemKey } from '../../lib/api';
import { useApp } from '../../state/store';
interface Intent { path: string; body: Record<string, unknown> }
const key = (wallet: string, scope: string) => `pkw:campaign-intent:${JSON.stringify([wallet, scope])}`;
export function useCampaignMutation(scope: string, refresh: () => Promise<void>) {
  const wallet = useApp(s => s.wallet) ?? '';
  const [pending, setPending] = useState<Intent | null>(() => {
    try {
      const raw = sessionStorage.getItem(key(wallet, scope));
      const saved = raw ? JSON.parse(raw) as Intent : null;
      if (!saved || typeof saved.path !== 'string' || !saved.path.startsWith(`${scope}/`)
        || !/^(schedule|cancel|disqualify|award|payment|finalize|participate|submissions)$/.test(saved.path.slice(scope.length + 1))
        || !saved.body || typeof saved.body.requestId !== 'string') return null;
      return saved;
    } catch { return null; }
  });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lock = useRef(false), controller = useRef<AbortController | null>(null), live = useRef(true);
  useEffect(() => {
    live.current = true;
    const off = useApp.subscribe(s => { if (s.wallet !== wallet) controller.current?.abort(); });
    return () => { live.current = false; controller.current?.abort(); off(); };
  }, [wallet]);
  const clear = (): void => { sessionStorage.removeItem(key(wallet, scope)); setPending(null); };
  const send = async (intent: Intent): Promise<void> => {
    if (lock.current || !wallet || useApp.getState().wallet !== wallet) return;
    lock.current = true; setBusy(true); setError(null);
    try {
      sessionStorage.setItem(key(wallet, scope), JSON.stringify(intent)); setPending(intent);
      const ctrl = new AbortController(); controller.current = ctrl;
      await api.postRaw(intent.path, intent.body, { signal: ctrl.signal });
      if (!live.current || ctrl.signal.aborted || useApp.getState().wallet !== wallet) return;
      clear(); await refresh();
    } catch (e) {
      if (!live.current || controller.current?.signal.aborted || useApp.getState().wallet !== wallet) return;
      const terminal = e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 429;
      if (terminal) { clear(); await refresh(); }
      setError(e instanceof Error ? e.message : 'Could not save. Retry the same request.');
    } finally { lock.current = false; if (live.current) setBusy(false); }
  };
  return { pending, busy, error,
    run: (path: string, body: Record<string, unknown>) => {
      if (pending) return;
      void send({ path, body: { requestId: idemKey(), ...body } });
    },
    retry: () => { if (pending) void send(pending); },
  };
}
