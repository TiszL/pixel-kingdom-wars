import { ForgeClaimKeySchema, type ForgeClaimReceipt } from '@shardkeep/shared/forgeClaims';
import { api, API_URL, ApiError, type BasesDto } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { playSfx } from '../audio';
import { haptic } from '../juice';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp, type BalancesDto } from '../../state/store';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { forgeClaimBrowserLock, type ForgeClaimPorts } from './controller';
import { parseForgeClaimIntent, type ForgeClaimHydration, type ForgeClaimIdentity, type ForgeClaimIntent } from './journal';
function account(raw: unknown): { wallet: string; entryPaid: boolean } {
  const r = raw as { wallet?: unknown; entryPaid?: unknown } | null;
  if (!r || typeof r.wallet !== 'string' || typeof r.entryPaid !== 'boolean') throw new Error('The original Forge account did not refresh.');
  return { wallet: r.wallet, entryPaid: r.entryPaid };
}
function directory(raw: unknown): BasesDto {
  const r = raw as Partial<BasesDto> | null;
  if (!r || typeof r.enabled !== 'boolean' || typeof r.capabilities?.baseScopedReads !== 'boolean' || typeof r.capabilities?.baseScopedMutations !== 'boolean'
    || !Array.isArray(r.bases) || r.bases.some(b => !b || !ForgeClaimKeySchema.safeParse({ key: b.id }).success
      || !['active', 'inactive'].includes(b.status) || !(b.slot === null || Number.isSafeInteger(b.slot) && b.slot > 0))
    || new Set(r.bases.map(b => b.id)).size !== r.bases.length) throw new Error('The current base directory is invalid.');
  return r as BasesDto;
}
const selectable = (d: BasesDto, id: string): boolean => d.enabled && d.capabilities.baseScopedReads
  && d.capabilities.baseScopedMutations && d.bases.some(b => b.id === id && b.status === 'active' && b.slot !== null);
export const forgeClaimIdentity = (wallet: string): ForgeClaimIdentity => ({ api: new URL(API_URL, window.location.origin).href, wallet, cluster: SOLANA_CLUSTER });
type Read = <T>(path: string) => Promise<T>;
// Ledger balances are canonical nonnegative decimal strings within PG bigint.
const balanceAmount = (raw: unknown): raw is string => typeof raw === 'string'
  && /^(0|[1-9][0-9]{0,18})$/.test(raw) && BigInt(raw) <= 9223372036854775807n;
/** Forge credits the actor's wallet KEEP. The current balance endpoint still
 * needs the original readable scope; a different selected deed cannot substitute. */
export async function refreshForgeClaimDestination(wallet: string, receipt: ForgeClaimReceipt, read: Read, guard: () => void): Promise<{
  hydration: ForgeClaimHydration; directory: BasesDto; entryPaid: boolean; balances: BalancesDto | null;
}> {
  const me = account(await read('/me')); guard();
  if (me.wallet !== wallet || receipt.actor !== wallet) throw new Error('The original Forge account did not refresh.');
  const owned = directory(await read('/bases')); guard();
  const available = receipt.baseId === null ? !owned.enabled : me.entryPaid && selectable(owned, receipt.baseId);
  let balances: BalancesDto | null = null;
  if (available) {
    const raw = await read<BalancesDto>(receipt.baseId === null ? '/balances' : `/balances?baseId=${encodeURIComponent(receipt.baseId)}`); guard();
    if (!raw || !balanceAmount(raw.keep) || !balanceAmount(raw.shards) || !Number.isFinite(raw.keepRate)) throw new Error('The original wallet KEEP balance did not refresh.');
    const after = directory(await read('/bases')); guard();
    if (JSON.stringify(after) !== JSON.stringify(owned)) throw new Error('The original allocation scope changed. Check its receipt again.');
    balances = raw;
  }
  return { hydration: { walletKeep: balances ? 'refreshed' : 'unavailable' }, directory: owned, entryPaid: me.entryPaid, balances };
}
export function createForgeClaimBrowserPorts(identity: ForgeClaimIdentity, lifecycle: () => { active: boolean; visible: boolean; epoch: number }): ForgeClaimPorts {
  const capture = (newAction: boolean): (() => void) => {
    const revision = authCookies.assertSession(), generation = authCookies.captureGeneration();
    const original = useApp.getState(), epoch = lifecycle().epoch;
    return () => {
      authCookies.assertResponse(revision); const current = useApp.getState(), page = lifecycle();
      if (!authCookies.current(generation) || !current.authed || current.wallet !== identity.wallet || !page.active
        || (newAction && (!page.visible || page.epoch !== epoch || current.selectedBaseId !== original.selectedBaseId || current.baseSelectionEpoch !== original.baseSelectionEpoch)))
        throw new Error('The account, base or page changed. Check the original saved Forge claim.');
    };
  };
  const validate = async (intent: ForgeClaimIntent, guard: () => void, retry: boolean): Promise<void> => {
    const me = account(await api.get('/me')); guard();
    if (me.wallet !== identity.wallet) throw new Error('The original Forge account changed.');
    const d = directory(await api.get('/bases')); guard();
    const id = intent.request.baseId;
    if (id !== null && (!me.entryPaid || !selectable(d, id))) throw new Error('The original allocation deed is unavailable. Keep the saved claim.');
    // Null is an explicit legacy wallet allocation, even after a multi-base
    // cutover. Only a new review must still match the visible allocation scope.
    if (!retry && (d.enabled ? useApp.getState().selectedBaseId : null) !== id) throw new Error('Review the allocation scope currently on screen.');
  };
  return {
    get: path => api.get(path), post: (path, body, guard) => api.postRaw(path, body, { isCurrent: () => { guard(); return true; } }),
    lock: forgeClaimBrowserLock, capture, key: () => crypto.randomUUID(), unsupported: e => e instanceof ApiError && e.status === 404,
    confirmed: () => { playSfx('sfx_confirm'); haptic('light'); },
    consent: async (input, key, guard) => {
      const intent = parseForgeClaimIntent({ request: { idempotencyKey: key, baseId: input.baseId, day: input.day } });
      await validate(intent, guard, false); guard(); return intent;
    },
    validate,
    hydrate: async (receipt, guard) => {
      const commitBalance = captureBaseBalanceCommit(receipt.baseId);
      const result = await refreshForgeClaimDestination(identity.wallet, receipt, api.get, guard); guard();
      const current = useApp.getState(); current.setEntryPaid(result.entryPaid); current.setBaseDirectory(result.directory);
      if (result.balances) commitBalance(result.balances);
      return result.hydration;
    },
  };
}
