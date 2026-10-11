import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { mutationGate } from '../mutationGate';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { seekerShardsClaimOriginal } from './transport';
import { seekerShardsClaimsLock, type SeekerShardsClaimsPorts } from './controller';
import { parseSeekerShardsClaimsIdentity, same, type SeekerShardsClaimsIdentity } from './journal';

export const seekerShardsClaimsIdentity = (wallet: string): SeekerShardsClaimsIdentity => parseSeekerShardsClaimsIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });

export function createSeekerShardsClaimsBrowserPorts(input: { identity: SeekerShardsClaimsIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): SeekerShardsClaimsPorts {
  const current = (guard: () => void) => () => { guard(); return true; };
  return {
    capture: baseId => {
      const identity = seekerShardsClaimsIdentity(input.identity.wallet);
      if (!same(parseSeekerShardsClaimsIdentity(input.identity), identity)) throw new Error('This SHARDS claims journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch;
      const selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch))
          throw new Error('The account, kingdom or SHARDS claims view changed. Check the original receipt.');
      };
    },
    get: async (path, guard) => {
      guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      try { const result = await api.getPrivate(path, { signal: abort.signal, isCurrent: current(guard) }); abort.signal.throwIfAborted(); guard(); return result; }
      finally { clearTimeout(timer); }
    },
    // Original transports own their deadline, body drain and awaited durable callback.
    // Do not wrap them in a view cancellation race that could close the journal early.
    getProof: (request, guard, retain) => seekerShardsClaimOriginal({ request, method: 'GET', isCurrent: current(guard), retain }),
    post: (request, guard, retain) => seekerShardsClaimOriginal({ request, method: 'POST', isCurrent: current(guard), retain }),
    lock: seekerShardsClaimsLock,
    key: () => crypto.randomUUID(),
  };
}
