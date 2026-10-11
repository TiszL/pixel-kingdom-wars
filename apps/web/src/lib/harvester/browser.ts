import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { mutationGate } from '../mutationGate';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, ApiError, API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { unpaidOriginal } from '../unpaidResources/transport';
import { harvesterLock, type HarvesterPorts } from './controller';
import { parseHarvesterIdentity, same, type HarvesterIdentity } from './journal';

export const harvesterIdentity = (wallet: string): HarvesterIdentity => parseHarvesterIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });

export function createHarvesterBrowserPorts(input: { identity: HarvesterIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): HarvesterPorts {
  const current = (guard: () => void) => () => { guard(); return true; };
  return {
    capture: baseId => {
      const identity = harvesterIdentity(input.identity.wallet);
      if (!same(parseHarvesterIdentity(input.identity), identity)) throw new Error('This Harvester journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch;
      const selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch))
          throw new Error('The account, kingdom or Harvester view changed. Check the original receipt.');
      };
    },
    get: async (path, guard) => {
      guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      try { const result = await api.get(path, { signal: abort.signal, isCurrent: current(guard) }); abort.signal.throwIfAborted(); guard(); return result; }
      finally { clearTimeout(timer); }
    },
    // Original transports own their deadline, body drain and awaited durable callback.
    // Do not wrap them in a view cancellation race that could close the journal early.
    getProof: (request, guard, retain) => unpaidOriginal({ wallet: input.identity.wallet, command: { kind: 'harvester', request },
      method: 'GET', firstAttempt: false, isCurrent: current(guard), retainAccepted: retain,
      retainRefusal: async () => { throw new Error('A recovery GET cannot supply command refusal.'); } }),
    post: (request, guard, retain, refusal, firstAttempt) => unpaidOriginal({ wallet: input.identity.wallet, command: { kind: 'harvester', request },
      method: 'POST', firstAttempt, isCurrent: current(guard), retainAccepted: retain,
      retainRefusal: async value => { await refusal(new ApiError(value.status, 'Original Harvester request declined.', value.code)); } }),
    lock: harvesterLock,
    key: () => crypto.randomUUID(),
  };
}
