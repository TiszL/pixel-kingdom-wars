import { mutationGate } from '../mutationGate';
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { api, API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { workshopLock, type WorkshopPorts } from './controller';
import { parseWorkshopIdentity, same, type WorkshopIdentity } from './journal';

export const workshopIdentity = (wallet: string): WorkshopIdentity => parseWorkshopIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), cluster: SOLANA_CLUSTER, wallet });
/** Original session checks reach api's isCurrent callback immediately before
 * fetch, even when the auth-cookie coordinator delays a request. */
export function createWorkshopBrowserPorts(input: { identity: WorkshopIdentity;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): WorkshopPorts {
  const request = async (guard: () => void, send: (signal: AbortSignal) => Promise<unknown>) => {
    guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    try { const result = await send(abort.signal); abort.signal.throwIfAborted(); guard(); return result; }
    catch (error) { if (abort.signal.aborted) throw new Error('Workshop request timed out. Keep the original command for recovery.'); throw error; }
    finally { clearTimeout(timer); }
  };
  return {
    capture: baseId => {
      const identity = workshopIdentity(input.identity.wallet);
      if (!same(parseWorkshopIdentity(input.identity), identity)) throw new Error('This Workshop journal belongs to another origin, server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), pageEpoch = input.lifecycle().epoch;
      const selectionEpoch = useApp.getState().baseSelectionEpoch;
      return () => {
        authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== identity.wallet || !page.active || !page.visible || page.epoch !== pageEpoch
          || baseId !== undefined && (!mutationGate.getSnapshot() || !page.actionsEnabled || state.selectedBaseId !== baseId || state.baseSelectionEpoch !== selectionEpoch)) throw new Error('The account, base or Workshop view changed. Check the original receipt.');
      };
    },
    get: (path, guard) => request(guard, signal => api.get(path, { signal, isCurrent: () => { guard(); return true; } })),
    post: (path, body, guard, observeResponseError) => request(guard, signal => api.postRaw(path, body, { signal, isCurrent: () => { guard(); return true; }, ...(observeResponseError ? { observeResponseError } : {}) })),
    lock: workshopLock, clock: () => ({ elapsed: performance.now(), wall: Date.now() }), key: () => crypto.randomUUID(),
  };
}
