import { ReferralCodeSchema } from '@shardkeep/shared/referrals';
import { api, API_URL, ApiError } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { referralBrowserLock, referralLockName, type ReferralPorts } from './controller';
import { ReferralJournalStore, parseLegacyReferral, type LegacyReferral, type ReferralIdentity } from './journal';

export const referralIdentity = (wallet: string): ReferralIdentity => ({ api: new URL(API_URL, window.location.origin).href, wallet, cluster: SOLANA_CLUSTER });
export const firstReferralRefusal = (error: unknown): boolean => error instanceof ApiError
  && ((error.status === 404 && error.code === 'REFERRAL_CODE_UNKNOWN')
    || (error.status === 422 && ['REFERRAL_SELF', 'REFERRAL_WINDOW_CLOSED'].includes(error.code ?? '')));
export function createReferralBrowserPorts(identity: ReferralIdentity, lifecycle: () => { active: boolean; visible: boolean; epoch: number }): ReferralPorts {
  return {
    get: (path) => api.get(path), post: (path, body) => api.postRaw(path, body),
    lock: referralBrowserLock, unsupported: (error) => error instanceof ApiError && error.status === 404,
    firstRefusal: firstReferralRefusal,
    capture: (newAction) => {
      const revision = authCookies.assertSession(); const generation = authCookies.captureGeneration(); const epoch = lifecycle().epoch;
      return () => {
        authCookies.assertResponse(revision);
        const current = useApp.getState(); const page = lifecycle();
        if (!authCookies.current(generation) || !current.authed || current.wallet !== identity.wallet || !page.active
          || (newAction && (!page.visible || epoch !== page.epoch))) throw new Error('The account or page changed. Check the original saved referral.');
      };
    },
  };
}
/** All legacy callers, including the pre-admission AlphaGate, share the v1 lock.
 * The identity must come from the authenticated session, never a connected key.
 * Persist exact legacy route/code before POST too: upgrading an old server cannot
 * turn its lost response into permission for a different v1 code. Only explicit
 * same-route retry may resume an unresolved legacy request. */
export async function withLegacyReferralFence<T>(
  wallet: string | null, request: { route: LegacyReferral['route']; code: string; retry: boolean },
  guard: () => void, operation: (request: { route: LegacyReferral['route']; code: string }) => Promise<T>,
  storeFactory: (identity: ReferralIdentity) => ReferralJournalStore = (identity) => new ReferralJournalStore(identity),
  lock: ReferralPorts['lock'] = referralBrowserLock,
): Promise<T> {
  if (!wallet) throw new Error('Confirm the signed-in account before using a referral code.');
  const revision = authCookies.assertSession(); const generation = authCookies.captureGeneration();
  const current = (): void => { guard(); authCookies.assertResponse(revision); if (!authCookies.current(generation)) throw new Error('The signed-in account changed.'); };
  const store = storeFactory(referralIdentity(wallet));
  try {
    return await lock(referralLockName(store), async () => {
      current(); const saved = await store.read(); current();
      const code = ReferralCodeSchema.parse(request.code);
      if (request.retry) {
        if (!saved.legacy || saved.legacy.route !== request.route || saved.legacy.code !== code || saved.legacy.result)
          throw new Error('Only the original unresolved legacy referral can be retried.');
      } else if (saved.activated || saved.code || saved.relationship || saved.legacy) throw new Error('Check the saved referral in Profile before using another code.');
      const pending = request.retry ? saved : await store.compareAndSet(saved.revision, (old) => ({ ...old, activated: true, code,
        legacy: { route: request.route, code, result: null } }));
      current(); const result = await operation({ route: request.route, code }); current();
      const legacy = parseLegacyReferral({ route: request.route, code, result }, store.identity);
      await store.compareAndSet(pending.revision, (old) => ({ ...old, legacy })); current(); return result;
    });
  } finally { await store.close(); }
}
