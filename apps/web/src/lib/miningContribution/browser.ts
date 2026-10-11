import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { mutationGate } from '../mutationGate';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, ApiError, API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { miningContributionOriginal } from './transport';
import { miningContributionLock, type MiningContributionPorts } from './controller';
import { parseMiningContributionIdentity, same, type MiningContributionIdentity } from './journal';

export const miningContributionIdentity = (wallet: string): MiningContributionIdentity => parseMiningContributionIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });

export function createMiningContributionBrowserPorts(input: { identity: MiningContributionIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): MiningContributionPorts {
  const current = (guard: () => void) => () => { guard(); return true; };
  return {
    capture: baseId => {
      const identity = miningContributionIdentity(input.identity.wallet);
      if (!same(parseMiningContributionIdentity(input.identity), identity)) throw new Error('This mining contribution journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch;
      const selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch))
          throw new Error('The account, kingdom or mining contribution view changed. Check the original receipt.');
      };
    },
    get: async (path, guard) => {
      guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      try { const result = await api.get(path, { signal: abort.signal, isCurrent: current(guard) }); abort.signal.throwIfAborted(); guard(); return result; }
      finally { clearTimeout(timer); }
    },
    // Original transports own their deadline, body drain and awaited durable callback.
    // Do not wrap them in a view cancellation race that could close the journal early.
    getProof: (request, guard, retain) => miningContributionOriginal({ wallet: input.identity.wallet, request,
      method: 'GET', firstAttempt: false, isCurrent: current(guard), retainAccepted: retain,
      retainRefusal: async () => { throw new Error('A recovery GET cannot supply command refusal.'); } }),
    post: (request, guard, retain, refusal, firstAttempt) => miningContributionOriginal({ wallet: input.identity.wallet, request,
      method: 'POST', firstAttempt, isCurrent: current(guard), retainAccepted: retain,
      retainRefusal: async value => { await refusal(new ApiError(value.status, 'Original mining contribution request declined.', value.code)); } }),
    lock: miningContributionLock,
    key: () => crypto.randomUUID(),
  };
}
