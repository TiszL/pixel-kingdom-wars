import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { mutationGate } from '../mutationGate';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, ApiError, API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { unpaidOriginal } from '../unpaidResources/transport';
import { starterExpeditionLock, type StarterExpeditionPorts } from './controller';
import { parseStarterExpeditionIdentity, same, type StarterExpeditionIdentity } from './journal';

export const starterExpeditionIdentity = (wallet: string): StarterExpeditionIdentity => parseStarterExpeditionIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });

export function createStarterExpeditionBrowserPorts(input: { identity: StarterExpeditionIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): StarterExpeditionPorts {
  const current = (guard: () => void) => () => { guard(); return true; };
  return {
    capture: baseId => {
      const identity = starterExpeditionIdentity(input.identity.wallet);
      if (!same(parseStarterExpeditionIdentity(input.identity), identity)) throw new Error('This starter expedition journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch;
      const selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch))
          throw new Error('The account, kingdom or starter expedition view changed. Check the original receipt.');
      };
    },
    get: async (path, guard) => {
      guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      try { const result = await api.get(path, { signal: abort.signal, isCurrent: current(guard) }); abort.signal.throwIfAborted(); guard(); return result; }
      finally { clearTimeout(timer); }
    },
    // Original transports own their deadline, body drain and awaited durable callback.
    // Do not wrap them in a view cancellation race that could close the journal early.
    getProof: (request, guard, retain) => unpaidOriginal({ wallet: input.identity.wallet, command: { kind: 'expedition', request },
      method: 'GET', firstAttempt: false, isCurrent: current(guard), retainAccepted: retain,
      retainRefusal: async () => { throw new Error('A recovery GET cannot supply command refusal.'); } }),
    post: (request, guard, retain, refusal, firstAttempt, onCreated) => unpaidOriginal({ wallet: input.identity.wallet, command: { kind: 'expedition', request },
      method: 'POST', firstAttempt, ...(onCreated ? { onCreated } : {}), isCurrent: current(guard), retainAccepted: retain,
      retainRefusal: async value => { await refusal(new ApiError(value.status, 'Original starter expedition request declined.', value.code)); } }),
    lock: starterExpeditionLock,
    key: () => crypto.randomUUID(),
  };
}
