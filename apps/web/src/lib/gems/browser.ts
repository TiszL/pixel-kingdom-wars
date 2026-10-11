import { mutationGate } from '../mutationGate';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp, type BalancesDto } from '../../state/store';
import { api, API_URL } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { gemsBrowserLock, type GemsPorts } from './controller';
import { amount, object, type GemsIntent } from './contracts';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { parseGemsIdentity, type GemsIdentity } from './journal';

export const gemsIdentity = (wallet: string): GemsIdentity => parseGemsIdentity({
  api: new URL(API_URL, window.location.origin).href, wallet, cluster: SOLANA_CLUSTER,
});
/** The wallet screen supplies its visibility epoch and guarded domain hydration;
 * constructing these ports does not activate a flag or opt any sink into Gems. */
export function createGemsBrowserPorts(identity: GemsIdentity,
  lifecycle: () => { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean },
  hydrate: GemsPorts['hydrate']): GemsPorts {
  return {
    get: (path, guard) => api.get(path, { isCurrent: () => { guard(); return true; } }),
    post: (path, body, guard, observeResponseError) => api.postRaw(path, body, { isCurrent: () => { guard(); return true; }, ...(observeResponseError ? { observeResponseError } : {}) }),
    lock: gemsBrowserLock, key: () => crypto.randomUUID(), hydrate,
    validateScope: async (intent, guard) => {
      if (intent.kind !== 'gems-to-shards') return;
      const directory = gemsDirectory(await api.get('/bases', { isCurrent: () => { guard(); return true; } })); guard();
      if (directory.enabled && (!intent.baseId || !directory.mutable || !directory.owned.includes(intent.baseId))
        || !directory.enabled && intent.baseId !== null || useApp.getState().selectedBaseId !== intent.baseId) throw new Error('Select the original base before converting Gems to SHARDS.');
    },
    capture: (savedIdentity, newAction) => {
      const canonical = gemsIdentity(identity.wallet);
      if (JSON.stringify(parseGemsIdentity(identity)) !== JSON.stringify(canonical)
        || JSON.stringify(parseGemsIdentity(savedIdentity)) !== JSON.stringify(canonical)) throw new Error('The saved Gems operation belongs to another server or network.');
      const revision = authCookies.assertSession(), generation = authCookies.captureGeneration();
      const original = useApp.getState(), epoch = lifecycle().epoch;
      return () => {
        authCookies.assertResponse(revision); const current = useApp.getState(), page = lifecycle();
        if (!authCookies.current(generation) || !current.authed || current.wallet !== canonical.wallet || !page.active
          || newAction && (!mutationGate.getSnapshot() || !page.visible || !page.actionsEnabled || page.epoch !== epoch
            || current.selectedBaseId !== original.selectedBaseId || current.baseSelectionEpoch !== original.baseSelectionEpoch)) throw new Error('The account, base or Gems view changed. Check the saved operation.');
      };
    },
  };
}

function gemsDirectory(raw: unknown): { enabled: boolean; mutable: boolean; owned: string[] } {
  const r = object(raw), capabilities = object(r.capabilities);
  if (typeof r.enabled !== 'boolean' || typeof capabilities.baseScopedReads !== 'boolean'
    || typeof capabilities.baseScopedMutations !== 'boolean' || !Array.isArray(r.bases)) throw new Error('The base directory could not be verified.');
  const owned = r.bases.map(object).map(row => {
    if (!['active', 'inactive'].includes(String(row.status)) || !(row.slot === null || Number.isSafeInteger(row.slot) && (row.slot as number) > 0)) throw new Error('The base directory could not be verified.');
    return row;
  }).filter(row => row.status === 'active' && row.slot !== null).map(row => {
    if (typeof row.id !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(row.id)) throw new Error('The base directory could not be verified.'); return row.id;
  });
  return { enabled: r.enabled, mutable: capabilities.baseScopedReads && capabilities.baseScopedMutations, owned };
}
/** Refresh the original destination where still available. Historical receipt
 * proof survives deed transfer; another base is never substituted for it. */
export async function hydrateGemsDestination(wallet: string, intent: GemsIntent, guard: () => void): Promise<void> {
  const get = (path: string) => api.get(path, { isCurrent: () => { guard(); return true; } });
  const me = object(await get('/me')); guard(); if (me.wallet !== wallet) throw new Error('The Gems account changed.');
  const directory = gemsDirectory(await get('/bases')); guard();
  const target = intent.kind === 'gems-to-shards' ? intent.baseId : useApp.getState().selectedBaseId;
  const available = directory.enabled ? target !== null && directory.mutable && directory.owned.includes(target) : target === null;
  if (!available) return; // The UI labels this as an original receipt, never current-base stock.
  const commit = captureBaseBalanceCommit(target);
  const raw = object(await get(target === null ? '/balances' : `/balances?baseId=${encodeURIComponent(target)}`)); guard();
  amount(raw.keep); amount(raw.shards); if (raw.gems !== undefined) amount(raw.gems);
  if (typeof raw.keepRate !== 'number' || !Number.isSafeInteger(raw.keepRate) || raw.keepRate <= 0) throw new Error('The Gems balances could not be refreshed.');
  const after = gemsDirectory(await get('/bases')); guard();
  if (JSON.stringify(after) !== JSON.stringify(directory)) throw new Error('The original Gems destination changed during refresh.');
  // Both answers belong to the same authenticated read window. Balances is the
  // last authoritative answer; it can differ after another same-wallet action.
  commit(raw as unknown as BalancesDto);
}
