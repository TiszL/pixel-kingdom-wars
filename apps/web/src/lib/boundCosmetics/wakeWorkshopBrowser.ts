import type { BoundCosmeticWakeWorkshopView } from '@shardkeep/shared/boundCosmeticWakeWorkshopApi';
import { LAND_CHECKOUT_RECOVERY } from '@shardkeep/shared';
import { BoundCosmeticRequestSchema, matchBoundCosmeticEnvelope } from '@shardkeep/shared/boundCosmeticApi';
import { BoundCosmeticWakePreferenceRequestSchema } from '@shardkeep/shared/boundCosmeticWake';
import { api, requestBoundCosmeticOriginal } from '../api';
import { mutationGate } from '../mutationGate';
import { createWorkshopBrowserPorts } from './workshopBrowser';
import { BoundCosmeticWakeWorkshopController, type WakeWorkshopPorts } from './wakeWorkshopController';
import { useCosmeticWorkshopSession } from './workshopBrowserSession';
import type { WorkshopBrowserInput } from './workshopBrowser';
import type { WorkshopJournalStore } from './workshopJournal';
import type { WorkshopGuard } from './workshopControllerCore';

/** The production hook remains closed to new craft/on until C5 supplies a real capability. */
export function createWakeWorkshopBrowserPorts(input: Parameters<typeof createWorkshopBrowserPorts>[0] & { applicationReady(): boolean }): WakeWorkshopPorts {
  const common = createWorkshopBrowserPorts(input);
  const isCurrent = (guard: WorkshopGuard) => () => { guard(); return true; };
  const bounded = async (guard: WorkshopGuard, run: (signal: AbortSignal) => Promise<unknown>) => {
    guard(); const abort = new AbortController(), timeout = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
    try { const result = await run(abort.signal); abort.signal.throwIfAborted(); guard(); return result; }
    finally { clearTimeout(timeout); }
  };
  return {
    ...common,
    applicationReady: input.applicationReady,
    capture: (kind, baseId) => { const guard = common.capture(kind, baseId); return () => {
      guard(); if (kind === 'craft' && !input.applicationReady()) throw Error('Aurora Wake application is unavailable in this client.');
    }; },
    capturePreference: enabled => { const guard = common.capture('account'); return () => {
      guard(); if (!mutationGate.getSnapshot() || enabled && (!input.lifecycle().actionsEnabled || !input.applicationReady()))
        throw Error('This account appearance update is unavailable.');
    }; },
    view: (baseId, guard) => bounded(guard, signal => api.get(`/bound-cosmetics/wakes/v1/workshop${baseId ? `?baseId=${encodeURIComponent(baseId)}` : ''}`, { signal, isCurrent: isCurrent(guard) })),
    start: (request, guard, retain) => {
      guard(); BoundCosmeticRequestSchema.parse(request);
      if (request.recipeId !== 'craft_aurora_wake_v1') throw Error('This request is not an Aurora Wake craft.');
      return requestBoundCosmeticOriginal({ method: 'POST', path: '/bound-cosmetics/wakes/v1/jobs', body: request,
        isCurrent: isCurrent(guard), timeoutMs: LAND_CHECKOUT_RECOVERY.requestTimeoutMs,
        observe: async (status, raw) => {
          if (status < 200 || status >= 300) return undefined;
          const proof = matchBoundCosmeticEnvelope(raw, input.identity.wallet, request);
          if (proof.status !== 'accepted') throw Error('The reply did not confirm the original request.');
          await retain(proof); return proof;
        } });
    },
    preference: (request, guard) => {
      BoundCosmeticWakePreferenceRequestSchema.parse(request);
      return bounded(guard, signal => api.put('/bound-cosmetics/wakes/v1/preference', request, { signal, isCurrent: isCurrent(guard) }));
    },
  };
}

// No C5 application provider is installed. This closed default is not art admission.
const createWakeController = (store: WorkshopJournalStore, input: WorkshopBrowserInput) => new BoundCosmeticWakeWorkshopController(store,
  createWakeWorkshopBrowserPorts({ ...input, applicationReady: () => false }));
export function useBoundCosmeticWakeWorkshop(actionsEnabled: boolean) {
  const { owned, state, baseId, actionsAllowed, preferenceAllowed } = useCosmeticWorkshopSession<BoundCosmeticWakeWorkshopView, BoundCosmeticWakeWorkshopController>('wake', actionsEnabled, createWakeController);
  const currentView = owned?.controller.currentView() ?? null;
  const current = (currentView?.selectedBase?.baseId ?? null) === baseId;
  return { baseId, preference: owned?.controller.currentPreference() ?? null, actionsAllowed, preferenceAllowed, applicationReady: false,
    state: { ...state, view: current ? currentView : null, review: current ? state.review : null },
    run: (action: (c: BoundCosmeticWakeWorkshopController) => Promise<void>) => owned?.invoke(action),
    refresh: () => owned?.observe(), cancelReview: () => owned?.controller.cancelReview() };
}
