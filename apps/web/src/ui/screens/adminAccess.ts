/** Tiny eager owner-capability probe. The full admin console stays a lazy chunk
 * so its secret-history UI never consumes the game's first-paint budget. */
import { useEffect, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import { useApp } from '../../state/store';

/** wallet → verdict. A definitive 403/404 is cached; a network fault is not. */
const adminProbe = new Map<string, boolean>();

export function useIsAdmin(): boolean {
  const wallet = useApp((s) => s.wallet);
  const [isAdmin, setIsAdmin] = useState<boolean>(() => (wallet ? adminProbe.get(wallet) ?? false : false));
  useEffect(() => {
    if (!wallet) { setIsAdmin(false); return; }
    const cached = adminProbe.get(wallet);
    if (cached !== undefined) { setIsAdmin(cached); return; }
    let live = true;
    void api.get('/admin/alpha/stats')
      .then(() => { adminProbe.set(wallet, true); if (live) setIsAdmin(true); })
      .catch((e: unknown) => {
        if (e instanceof ApiError && (e.status === 403 || e.status === 404)) adminProbe.set(wallet, false);
        if (live) setIsAdmin(false);
      });
    return () => { live = false; };
  }, [wallet]);
  return isAdmin;
}
