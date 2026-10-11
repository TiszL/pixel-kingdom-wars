import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { mutationGate } from '../mutationGate';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { seekerResourceClaimOriginal } from './transport';
import { seekerResourceClaimsLock, type SeekerResourceClaimsPorts } from './controller';
import { parseSeekerResourceClaimsIdentity, same, type SeekerResourceClaimsIdentity } from './journal';

export const seekerResourceClaimsIdentity = (wallet: string): SeekerResourceClaimsIdentity => parseSeekerResourceClaimsIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });

export function createSeekerResourceClaimsBrowserPorts(input: { identity: SeekerResourceClaimsIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): SeekerResourceClaimsPorts {
  const current = (guard: () => void) => () => { guard(); return true; };
  return {
    capture: baseId => {
      const identity = seekerResourceClaimsIdentity(input.identity.wallet);
      if (!same(parseSeekerResourceClaimsIdentity(input.identity), identity)) throw new Error('This resource claims journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch;
      const selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch))
          throw new Error('The account, kingdom or resource claims view changed. Check the original receipt.');
      };
    },
    get: async (path, guard) => {
      guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      try { const result = await api.getPrivate(path, { signal: abort.signal, isCurrent: current(guard) }); abort.signal.throwIfAborted(); guard(); return result; }
      finally { clearTimeout(timer); }
    },
    // Original transports own their deadline, body drain and awaited durable callback.
    // Do not wrap them in a view cancellation race that could close the journal early.
    getProof: (request, guard, retain) => seekerResourceClaimOriginal({ request, method: 'GET', isCurrent: current(guard), retain }),
    post: (request, guard, retain) => seekerResourceClaimOriginal({ request, method: 'POST', isCurrent: current(guard), retain }),
    lock: seekerResourceClaimsLock,
    key: () => crypto.randomUUID(),
  };
}
