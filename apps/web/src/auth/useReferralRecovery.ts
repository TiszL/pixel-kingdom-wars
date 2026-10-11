import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useApp } from '../state/store';
import { api } from '../lib/api';
import { ReferralController, type ReferralState } from '../lib/referrals/controller';
import { ReferralJournalStore } from '../lib/referrals/journal';
import { createReferralBrowserPorts, referralIdentity, withLegacyReferralFence } from '../lib/referrals/browser';

const EMPTY: ReferralState = { loaded: false, supported: false, busy: false, journal: null, review: null, error: null };
const emptySnapshot = (): ReferralState => EMPTY;
const emptySubscribe = (): (() => void) => () => undefined;
export function useReferralRecovery(): { controller: ReferralController | null; state: ReferralState; legacy(code: string): Promise<void>; retryLegacy(): Promise<void> } {
  const wallet = useApp((s) => s.wallet); const authed = useApp((s) => s.authed);
  const owned = useMemo(() => {
    if (!wallet || !authed) return null;
    const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0 };
    const store = new ReferralJournalStore(referralIdentity(wallet));
    const ports = createReferralBrowserPorts(store.identity, () => lifecycle);
    return { store, ports, controller: new ReferralController(store, ports), lifecycle };
  }, [wallet, authed]);
  const controller = owned?.controller ?? null;
  const state = useSyncExternalStore(controller?.subscribe ?? emptySubscribe, controller?.snapshot ?? emptySnapshot);
  useEffect(() => {
    if (!owned) return;
    owned.lifecycle.active = true;
    const suspend = (): void => { owned.lifecycle.epoch += 1; owned.controller.dismiss(); };
    const observe = (): void => { if (owned.lifecycle.active && owned.lifecycle.visible && !owned.controller.snapshot().busy) void owned.controller.open(); };
    const visibility = (): void => {
      owned.lifecycle.visible = document.visibilityState !== 'hidden';
      if (!owned.lifecycle.visible) suspend(); else observe();
    };
    document.addEventListener('visibilitychange', visibility); document.addEventListener('freeze', suspend);
    window.addEventListener('pagehide', suspend); window.addEventListener('focus', observe); window.addEventListener('online', observe);
    observe();
    return () => {
      owned.lifecycle.active = false; suspend();
      document.removeEventListener('visibilitychange', visibility); document.removeEventListener('freeze', suspend);
      window.removeEventListener('pagehide', suspend); window.removeEventListener('focus', observe); window.removeEventListener('online', observe);
      queueMicrotask(() => {
        if (owned.lifecycle.active) return;
        if (!owned.controller.snapshot().busy) { void owned.store.close().catch(() => undefined); return; }
        const stop = owned.controller.subscribe(() => {
          if (!owned.controller.snapshot().busy) { stop(); if (!owned.lifecycle.active) void owned.store.close().catch(() => undefined); }
        });
      });
    };
  }, [owned]);
  const legacy = async (code: string): Promise<void> => {
    if (!owned) throw new Error('Sign in before using a referral code.');
    const guard = owned.ports.capture(true); guard();
    await owned.controller.open(); guard(); const fresh = owned.controller.snapshot();
    if (!fresh.loaded || fresh.busy || fresh.error || fresh.supported) throw new Error('Review this code through saved referral recovery.');
    try { await withLegacyReferralFence(owned.store.identity.wallet, { route: '/referrals/use', code, retry: false }, guard, (request) => api.post(request.route, { code: request.code })); }
    finally { await owned.controller.open(); }
  };
  const retryLegacy = async (): Promise<void> => {
    if (!owned) throw new Error('Sign in to recover the original referral.');
    const guard = owned.ports.capture(true); guard();
    const saved = await owned.store.read(); guard();
    if (!saved.legacy || saved.legacy.route !== '/referrals/use' || saved.legacy.result) throw new Error('Recover original alpha admission from the invite screen.');
    try { await withLegacyReferralFence(owned.store.identity.wallet, { ...saved.legacy, retry: true }, guard, (request) => api.post(request.route, { code: request.code })); }
    finally { await owned.controller.open(); }
  };
  return { controller, state, legacy, retryLegacy };
}
