import { api } from '../api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { createReferralBrowserPorts, referralIdentity, withLegacyReferralFence } from './browser';
import { ReferralController } from './controller';
import { ReferralJournalStore } from './journal';

/** Loaded only when a referral link exists. Anonymous URL storage is a draft;
 * a supported server needs explicit Profile confirmation, never an automatic POST. */
export async function optionalReferralMode(wallet: string, signal: AbortSignal): Promise<'review' | 'legacy'> {
  const lifecycle = { active: true, visible: document.visibilityState !== 'hidden', epoch: 0 };
  const ports = createReferralBrowserPorts(referralIdentity(wallet), () => lifecycle);
  const store = new ReferralJournalStore(referralIdentity(wallet)); const controller = new ReferralController(store, ports);
  const guard = ports.capture(true);
  try {
    signal.throwIfAborted(); guard(); await controller.open(); signal.throwIfAborted(); guard();
    const state = controller.snapshot();
    if (state.error || !state.loaded) throw new Error(state.error ?? 'Read saved referral status first.');
    return state.supported || state.journal?.activated ? 'review' : 'legacy';
  } finally { await store.close(); }
}
export async function submitOptionalLegacyReferral(wallet: string, code: string, signal: AbortSignal): Promise<void> {
  const revision = authCookies.assertSession(); const generation = authCookies.captureGeneration();
  const guard = (): void => {
    signal.throwIfAborted(); authCookies.assertResponse(revision);
    const current = useApp.getState();
    if (!authCookies.current(generation) || current.wallet !== wallet || !current.authed || document.visibilityState === 'hidden') throw new Error('The referral account or page changed.');
  };
  await withLegacyReferralFence(wallet, { route: '/referrals/use', code, retry: false }, guard, (request) => api.post(request.route, { code: request.code }, { signal }));
}
/** Closed-alpha admission remains its own server operation. GET attribution is
 * never admission proof. Block every referral-code path if exact v1 intent exists. */
export async function submitAlphaReferral(wallet: string | null, code: string, signal: AbortSignal, proof: () => void, retry = false): Promise<{ ok: boolean; wallet: string }> {
  const guard = (): void => { signal.throwIfAborted(); proof(); if (document.visibilityState === 'hidden') throw new Error('Return to the invite screen before submitting.'); };
  return withLegacyReferralFence(wallet, { route: '/alpha/referral', code, retry }, guard,
    (request) => api.postRaw<{ ok: boolean; wallet: string }>(request.route, { code: request.code }, { signal }));
}
export async function readAlphaReferral(wallet: string, proof: () => void): Promise<{ code: string; retry: boolean } | null> {
  proof(); const store = new ReferralJournalStore(referralIdentity(wallet));
  try {
    const saved = await store.read(); proof();
    if (saved.legacy?.route === '/alpha/referral' && !saved.legacy.result) return { code: saved.legacy.code, retry: true };
    if (saved.activated) throw new Error('Check the saved referral in Profile. Attribution is not alpha admission.');
    return null;
  } finally { await store.close(); }
}
