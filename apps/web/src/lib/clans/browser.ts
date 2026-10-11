import { ClanCommandKeySchema, type ClanCommandReceipt } from '@shardkeep/shared/clanCommands';
import { api, API_URL, ApiError, type BasesDto } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp, type BalancesDto } from '../../state/store';
import { clanBrowserLock, type ClanPorts, type ClanReview } from './controller';
import { parseClanIntent, type ClanHydration, type ClanIdentity, type ClanIntent } from './journal';

type MineDto = { clan: { id: string; name: string; leaderWallet: string; roster: { wallet: string }[] } | null };
function mine(raw: unknown): MineDto {
  const r = raw as MineDto | null;
  if (!r || !Object.hasOwn(r, 'clan')) throw new Error('The clan roster did not refresh.');
  if (r.clan !== null && (!r.clan || !ClanCommandKeySchema.safeParse({ key: r.clan.id }).success || typeof r.clan.name !== 'string'
    || r.clan.name.length < 1 || r.clan.name.length > 128 || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(r.clan.leaderWallet)
    || !Array.isArray(r.clan.roster) || r.clan.roster.some((member) => !member || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(member.wallet))))
    throw new Error('The clan roster did not refresh.');
  return r;
}
function account(raw: unknown): { wallet: string; entryPaid: boolean } {
  const r = raw as { wallet?: unknown; entryPaid?: unknown } | null;
  if (!r || typeof r.wallet !== 'string' || typeof r.entryPaid !== 'boolean') throw new Error('The original account did not refresh.');
  return { wallet: r.wallet, entryPaid: r.entryPaid };
}
function directory(raw: unknown): BasesDto {
  const r = raw as Partial<BasesDto> | null;
  if (!r || typeof r.enabled !== 'boolean' || typeof r.capabilities?.baseScopedReads !== 'boolean' || typeof r.capabilities?.baseScopedMutations !== 'boolean'
    || !Array.isArray(r.bases) || r.bases.some((b) => !b || !ClanCommandKeySchema.safeParse({ key: b.id }).success
      || !['active', 'inactive'].includes(b.status) || !(b.slot === null || Number.isSafeInteger(b.slot) && b.slot > 0))
    || new Set(r.bases.map((b) => b.id)).size !== r.bases.length) throw new Error('The current base directory is invalid.');
  return r as BasesDto;
}
const selectable = (d: BasesDto, id: string | null): boolean => d.enabled && d.capabilities.baseScopedReads
  && d.capabilities.baseScopedMutations && id !== null && d.bases.some((b) => b.id === id && b.status === 'active' && b.slot !== null);
export const clanIdentity = (wallet: string): ClanIdentity => ({ api: new URL(API_URL, window.location.origin).href, wallet, cluster: SOLANA_CLUSTER });

type Read = <T>(path: string) => Promise<T>;
/** Directory absence/inactivity is only unavailability, never transfer proof.
 * The original active base's balance route supplies final server authority; an
 * error there retains the receipt instead of substituting the selected base. */
export async function refreshClanDestination(wallet: string, receipt: ClanCommandReceipt, read: Read, guard: () => void): Promise<{
  hydration: ClanHydration; directory: BasesDto; entryPaid: boolean; balances: BalancesDto | null;
}> {
  const me = account(await read('/me')); guard();
  if (me.wallet !== wallet) throw new Error('The original clan account did not refresh.');
  const owned = directory(await read('/bases')); guard();
  if (me.entryPaid) {
    mine(await read('/clans/mine')); guard();
    const list = await read<{ clans: unknown[] }>('/clans'); guard();
    if (!list || !Array.isArray(list.clans)) throw new Error('The clan standings did not refresh.');
  }
  let originalPayout: ClanHydration['originalPayout'] = 'not-applicable'; let balances: BalancesDto | null = null;
  if (receipt.state === 'disbanded') {
    const available = me.entryPaid && (receipt.baseId === null ? !owned.enabled : selectable(owned, receipt.baseId));
    originalPayout = 'unavailable';
    if (available) {
      const path = receipt.baseId === null ? '/balances' : `/balances?baseId=${encodeURIComponent(receipt.baseId)}`;
      const raw = await read<BalancesDto>(path); guard();
      if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw.shards) || !/^(0|[1-9][0-9]*)$/.test(raw.keep) || !Number.isFinite(raw.keepRate)) throw new Error('The original payout balance did not refresh.');
      const after = directory(await read('/bases')); guard();
      if (JSON.stringify(after) !== JSON.stringify(owned)) throw new Error('The original payout directory changed. Check its receipt again.');
      balances = raw; originalPayout = 'refreshed';
    }
  }
  return { hydration: { membershipAvailable: me.entryPaid, originalPayout }, directory: owned, entryPaid: me.entryPaid, balances };
}
export function createClanBrowserPorts(identity: ClanIdentity, lifecycle: () => { active: boolean; visible: boolean; epoch: number }): ClanPorts {
  const capture = (newAction: boolean): (() => void) => {
    const revision = authCookies.assertSession(); const generation = authCookies.captureGeneration();
    const original = useApp.getState(); const epoch = lifecycle().epoch;
    return () => {
      authCookies.assertResponse(revision); const current = useApp.getState(); const page = lifecycle();
      if (!authCookies.current(generation) || !current.authed || current.wallet !== identity.wallet || !page.active
        || (newAction && (!page.visible || page.epoch !== epoch || current.selectedBaseId !== original.selectedBaseId || current.baseSelectionEpoch !== original.baseSelectionEpoch)))
        throw new Error('The account, base or page changed. Check the original saved clan command.');
    };
  };
  const fresh = async (guard: () => void): Promise<BasesDto> => {
    const me = account(await api.get('/me')); guard();
    if (me.wallet !== identity.wallet || !me.entryPaid) throw new Error('Current owned land is required to submit a clan command.');
    return directory(await api.get('/bases'));
  };
  const validateBase = (d: BasesDto, intent: ClanIntent): void => {
    if (intent.kind === 'leave' && (intent.request.baseId === null ? d.enabled : !selectable(d, intent.request.baseId)))
      throw new Error('The original payout destination is unavailable. Keep the original command saved.');
  };
  const validateClan = async (intent: ClanIntent, guard: () => void): Promise<void> => {
    const { clan } = mine(await api.get('/clans/mine')); guard();
    if (!clan || clan.id !== intent.request.clanId) throw new Error('Your clan changed. Review its current roster first.');
    if (intent.kind === 'kick' && (clan.leaderWallet !== identity.wallet || intent.request.wallet === identity.wallet
      || !clan.roster.some((r) => r.wallet === intent.request.wallet))) throw new Error('The original member cannot be removed from this clan.');
    if (intent.kind === 'leave' && clan.leaderWallet === identity.wallet && clan.roster.length > 1) throw new Error('Remove other members before disbanding your clan.');
  };
  return {
    get: (path) => api.get(path),
    post: (path, body, guard) => api.postRaw(path, body, { isCurrent: () => { guard(); return true; } }),
    lock: clanBrowserLock, capture, key: () => crypto.randomUUID(), unsupported: (e) => e instanceof ApiError && e.status === 404,
    consent: async (input: ClanReview, key, guard) => {
      const d = await fresh(guard); guard(); const { clan } = mine(await api.get('/clans/mine')); guard();
      if (!clan || clan.id !== input.clanId) throw new Error('Your clan changed. Review its current roster first.');
      const intent = parseClanIntent(input.kind === 'leave' ? { kind: 'leave', clanName: clan.name,
        request: { idempotencyKey: key, clanId: input.clanId, baseId: d.enabled ? useApp.getState().selectedBaseId : null } }
        : { kind: 'kick', clanName: clan.name, request: { idempotencyKey: key, clanId: input.clanId, wallet: input.target } });
      validateBase(d, intent); await validateClan(intent, guard); return intent;
    },
    validate: async (intent, guard, retry) => {
      const d = await fresh(guard); guard(); validateBase(d, intent);
      if (!retry) {
        if (intent.kind === 'leave' && d.enabled && useApp.getState().selectedBaseId !== intent.request.baseId) throw new Error('Review the currently selected payout base.');
        await validateClan(intent, guard);
      }
    },
    hydrate: async (receipt, guard) => {
      const initial = useApp.getState(); const result = await refreshClanDestination(identity.wallet, receipt, api.get, guard); guard();
      const current = useApp.getState(); current.setEntryPaid(result.entryPaid); current.setBaseDirectory(result.directory);
      if (result.balances && current.selectedBaseId === receipt.baseId && current.baseSelectionEpoch === initial.baseSelectionEpoch) current.setBalances(result.balances);
      return result.hydration;
    },
  };
}
