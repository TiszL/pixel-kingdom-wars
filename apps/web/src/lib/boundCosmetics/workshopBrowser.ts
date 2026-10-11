import type { BoundCosmeticWorkshopView } from '@shardkeep/shared/boundCosmeticWorkshopApi';
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { matchBoundCosmeticEnvelope } from '@shardkeep/shared/boundCosmeticApi';
import { api, requestBoundCosmeticOriginal } from '../api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { captureBaseSnapshotGuard, isBaseSnapshotGuardCurrent, useApp } from '../../state/store';
import { ordinaryCraftingIdentity } from '../ordinaryCrafting/browser';
import { mutationGate } from '../mutationGate';
import { BoundCosmeticWorkshopController, type WorkshopPorts } from './workshopController';
import { sameWorkshopValue, WorkshopJournalStore, type WorkshopIdentity } from './workshopJournal';
import { loadCosmeticPreview } from './preview';
import { useCosmeticWorkshopSession } from './workshopBrowserSession';

export type WorkshopBrowserInput = { identity: WorkshopIdentity; lifecycle(): Lifecycle };
type Lifecycle = { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean };
export function createWorkshopBrowserPorts(input: WorkshopBrowserInput): WorkshopPorts {
  const isCurrent = (guard: () => void) => () => { guard(); return true; };
  const original: (method: 'GET' | 'POST', ...args: Parameters<WorkshopPorts['start']>) => Promise<unknown> = (method, request, guard, retain) => {
    guard();
    return requestBoundCosmeticOriginal({ method, path: method === 'GET' ? `/bound-cosmetics/jobs/by-key/${request.idempotencyKey}` : '/bound-cosmetics/jobs',
      ...(method === 'POST' ? { body: request } : {}), isCurrent: isCurrent(guard), timeoutMs: LAND_CHECKOUT_RECOVERY.requestTimeoutMs,
      observe: async (status, raw) => {
        if (status < 200 || status >= 300) return undefined; // Every attempted error stays unknown.
        const proof = matchBoundCosmeticEnvelope(raw, input.identity.wallet, request);
        if (method === 'POST' && proof.status !== 'accepted') throw Error('The reply did not confirm the original request.');
        if (proof.status === 'accepted') await retain(proof);
        return proof;
      } });
  };
  return {
    capture: (kind, baseId) => {
      if (!sameWorkshopValue(input.identity, ordinaryCraftingIdentity(input.identity.wallet))) throw Error('Recovery belongs to another server or network.');
      const session = authCookies.assertSession(), generation = authCookies.captureGeneration(), epoch = input.lifecycle().epoch;
      const selection = captureBaseSnapshotGuard();
      return () => {
        authCookies.assertResponse(session); const state = useApp.getState(), page = input.lifecycle();
        if (!authCookies.current(generation) || !state.authed || state.wallet !== input.identity.wallet || !page.active || !page.visible || page.epoch !== epoch
          || kind !== 'account' && (!isBaseSnapshotGuardCurrent(selection) || (state.selectedBaseId ?? undefined) !== baseId)
          || (kind === 'craft' || kind === 'preference') && !mutationGate.getSnapshot()
          || kind === 'craft' && !page.actionsEnabled) throw Error('The account, kingdom or Workshop view changed. Check the original receipt.');
      };
    },
    view: async (baseId, guard) => {
      guard(); const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      try { const value = await api.get(`/bound-cosmetics${baseId ? `?baseId=${encodeURIComponent(baseId)}` : ''}`, { signal: abort.signal, isCurrent: isCurrent(guard) }); abort.signal.throwIfAborted(); guard(); return value; }
      finally { clearTimeout(timeout); }
    },
    original: (request, guard, retain) => original('GET', request, guard, retain),
    start: (request, guard, retain) => original('POST', request, guard, retain),
    preference: async (request, guard) => {
      guard(); const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      try { const value = await api.put('/bound-cosmetics/awning', request, { signal: abort.signal, isCurrent: isCurrent(guard) }); abort.signal.throwIfAborted(); guard(); return value; }
      finally { clearTimeout(timeout); }
    },
    preview: async (appearance, guard) => {
      guard(); const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
      try { const preview = await loadCosmeticPreview(appearance, abort.signal); try { abort.signal.throwIfAborted(); guard(); } finally { preview.bitmap.close(); } }
      catch { abort.abort(); throw Error('The selected appearance could not be verified on this device. Refresh before crafting.'); }
      finally { clearTimeout(timeout); }
    },
    lock: async (name, run) => {
      if (!navigator.locks?.request) throw Error('Update your browser to coordinate crafting safely across tabs.');
      return navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
        if (!lock) throw Error('Another tab is handling this Awning request.'); return run();
      });
    },
    key: () => crypto.randomUUID(),
  };
}
const createAwningController = (store: WorkshopJournalStore, input: WorkshopBrowserInput) => new BoundCosmeticWorkshopController(store, createWorkshopBrowserPorts(input));
export function useBoundCosmeticWorkshop(actionsEnabled: boolean) {
  const { owned, state, baseId, actionsAllowed, preferenceAllowed } = useCosmeticWorkshopSession<BoundCosmeticWorkshopView, BoundCosmeticWorkshopController>('awning', actionsEnabled, createAwningController);
  const currentView = owned?.controller.currentView() ?? null;
  const current = (currentView?.selectedBase?.baseId ?? null) === baseId;
  return { baseId, actionsAllowed, preferenceAllowed,
    state: { ...state, view: current ? currentView : null, review: current ? state.review : null },
    run: (action: (c: BoundCosmeticWorkshopController) => Promise<void>) => owned?.invoke(action),
    refresh: () => owned?.observe(), cancelReview: () => owned?.controller.cancelReview() };
}
