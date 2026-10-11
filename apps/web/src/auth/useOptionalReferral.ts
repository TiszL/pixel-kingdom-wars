import { useEffect } from 'react';
import { API_URL } from '../lib/api';
import { bus } from '../lib/events';
import { clearStoredReferralCode, readStoredReferralCode } from '../lib/referral';
import { useApp } from '../state/store';

type Outcome = 'used' | 'review' | 'none';
const pending = new Map<string, Promise<Outcome>>();
function attribute(wallet: string, code: string): Promise<Outcome> {
  const key = JSON.stringify([wallet, code]); const existing = pending.get(key); if (existing) return existing;
  const controller = new AbortController();
  const unsubscribe = useApp.subscribe((state) => { if (!state.authed || state.wallet !== wallet) controller.abort(); });
  const suspend = (): void => controller.abort();
  const visibility = (): void => { if (document.visibilityState === 'hidden') suspend(); };
  document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend); window.addEventListener('pagehide', suspend);
  const request = (async (): Promise<Outcome> => {
    // Keep schema/IDB code outside first paint unless a referral link exists.
    const recovery = await import('../lib/referrals/entry'); controller.signal.throwIfAborted();
    if (await recovery.optionalReferralMode(wallet, controller.signal) === 'review') return 'review';
    // This public route disallows credentialed CORS; admission configuration must
    // remain anonymous. A failed response is never permission to consume a code.
    const access = await fetch(`${API_URL}/playtest/access`, { credentials: 'omit', signal: controller.signal });
    if (!access.ok) return 'none'; const body: unknown = await access.json(); controller.signal.throwIfAborted();
    if (!body || typeof body !== 'object' || !('open' in body) || body.open !== true
      || !useApp.getState().authed || useApp.getState().wallet !== wallet || readStoredReferralCode() !== code) return 'none';
    await recovery.submitOptionalLegacyReferral(wallet, code, controller.signal); return 'used';
  })();
  pending.set(key, request);
  void request.finally(() => {
    unsubscribe(); pending.delete(key); document.removeEventListener('visibilitychange', visibility);
    document.removeEventListener('freeze', suspend); window.removeEventListener('pagehide', suspend);
  }).catch(() => undefined);
  return request;
}
/** Attribution never holds up gameplay. On current servers a link is an explicit
 * Profile review; after any saved attempt, online/focus performs GET recovery only. */
export function useOptionalReferral(): void {
  const wallet = useApp((state) => state.wallet); const authed = useApp((state) => state.authed);
  useEffect(() => {
    if (!authed || !wallet) return;
    let live = true; let busy = false; let suggested = false;
    const observe = (): void => {
      const code = readStoredReferralCode(); if (!live || busy || !code) return; busy = true;
      const current = (): boolean => live && useApp.getState().wallet === wallet && useApp.getState().authed && readStoredReferralCode() === code;
      void attribute(wallet, code).then((result) => {
        if (!current()) return;
        if (result === 'used') { clearStoredReferralCode(code); bus.emit('ui:toast', { msg: 'REFERRAL SUBMITTED — THANKS FOR JOINING YOUR FRIEND' }); }
        else if (result === 'review' && !suggested) { suggested = true; bus.emit('ui:toast', { msg: 'REVIEW YOUR OPTIONAL REFERRAL IN PROFILE' }); }
      }).catch(() => {
        // Every legacy request is now durable too. Neither a transport error nor
        // an unversioned refusal may erase its original code or silently retry it.
        if (current() && !suggested) { suggested = true; bus.emit('ui:toast', { msg: 'CHECK YOUR SAVED REFERRAL IN PROFILE — YOU CAN KEEP PLAYING' }); }
      }).finally(() => { busy = false; });
    };
    observe(); window.addEventListener('online', observe); window.addEventListener('focus', observe);
    return () => { live = false; window.removeEventListener('online', observe); window.removeEventListener('focus', observe); };
  }, [wallet, authed]);
}
