import { LAND_CHECKOUT_RECOVERY, MARKETPLACE } from '@shardkeep/shared';
import { LAMPORTS_PER_SOL, type Connection } from '@solana/web3.js';
import { api, ApiError, API_URL, type BasesDto } from '../api';
import { SOLANA_CLUSTER } from '../cluster';
import { authCookies } from '../../auth/authCookieCoordinator';
import type { GameWallet } from '../../auth/useGameWallet';
import { useApp, type BalancesDto } from '../../state/store';
import { marketBrowserLock, type MarketPorts } from './controller';
import type { MarketCommand, MarketIdentity, MarketPurchase } from './journal';
import { prepareMarketPayment, signMarketPayment, broadcastMarketPayment } from './payment';

export function marketIdentity(wallet: string): MarketIdentity {
  return { api: new URL(API_URL, window.location.origin).href, wallet, cluster: SOLANA_CLUSTER };
}
export function marketSolAmount(input: string): string {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,9})?$/.test(input.trim())) throw new Error('Enter a SOL price with at most 9 decimal places.');
  const [whole, fractional = ''] = input.trim().split('.');
  const amount = BigInt(whole!) * BigInt(LAMPORTS_PER_SOL) + BigInt(fractional.padEnd(9, '0'));
  const bounds = MARKETPLACE.itemMarket;
  if (amount < BigInt(bounds.minPriceLamports) || amount > BigInt(bounds.maxPriceLamports)) throw new Error(`Price must be ${bounds.minPriceLamports / LAMPORTS_PER_SOL}–${bounds.maxPriceLamports / LAMPORTS_PER_SOL} SOL.`);
  return amount.toString();
}
/** Only a proved first list/reserve rejection can retire that new key. A 409
 * without explicit consent-change attribution may refer to an existing key. */
export function firstMarketRefusal(error: unknown): { status: number; message: string } | null {
  if (!(error instanceof ApiError)) return null;
  if ([400, 401, 403, 404, 422, 429].includes(error.status)
    || (error.status === 409 && error.code === 'MARKET_CONSENT_CHANGED')) return { status: error.status, message: error.message.slice(0, 1000) };
  return null;
}
function directory(value: unknown): BasesDto {
  const d = value as Partial<BasesDto> | null;
  if (!d || typeof d.enabled !== 'boolean' || typeof d.capabilities?.baseScopedReads !== 'boolean'
    || typeof d.capabilities?.baseScopedMutations !== 'boolean' || !Array.isArray(d.bases)
    || d.bases.some((b) => !b || typeof b.id !== 'string' || !['active', 'inactive'].includes(b.status))
    || new Set(d.bases.map((b) => b.id)).size !== d.bases.length) throw new Error('Fresh base ownership is unavailable.');
  return d as BasesDto;
}
function inventory(value: unknown): void {
  const i = value as { catalog?: unknown; owned?: { itemId?: unknown; qty?: unknown }[] } | null;
  if (!i || !Array.isArray(i.catalog) || !Array.isArray(i.owned)
    || i.owned.some((row) => typeof row.itemId !== 'string' || !Number.isSafeInteger(row.qty) || (row.qty as number) < 0)) throw new Error('The original inventory did not refresh.');
}
/** Kept separate from UI selection: a settled purchase into A cannot be marked
 * refreshed by merely loading today's selected B. Missing ownership fails closed. */
export async function refreshMarketDestination(
  expectedWallet: string, originalBaseId: string | null,
  read: <T>(path: string) => Promise<T>, guard: () => void,
  selected: string | null,
): Promise<{ destination: NonNullable<MarketPurchase['hydrated']>; directory: BasesDto; balances: BalancesDto; balanceBase: string | null; entryPaid: boolean }> {
  const me = await read<{ wallet: string; entryPaid: boolean }>('/me'); guard();
  if (me.wallet !== expectedWallet || typeof me.entryPaid !== 'boolean') throw new Error('The original account did not refresh.');
  const owned = directory(await read<unknown>('/bases')); guard();
  const stillOwned = originalBaseId === null || owned.bases.some((base) => base.id === originalBaseId);
  if (originalBaseId !== null && !owned.enabled) throw new Error('Original destination ownership is unavailable.');
  // Refresh wallet balances through a fresh authorized base where required.
  // Do not publish these base-specific SHARDS over a different selection.
  const selectedStillOwned = selected !== null && owned.bases.some((b) => b.id === selected);
  const balanceBase = selectedStillOwned ? selected : owned.bases.find((b) => b.status === 'active' && b.slot !== null)?.id ?? null;
  const balances = await read<BalancesDto>(balanceBase ? `/balances?baseId=${encodeURIComponent(balanceBase)}` : '/balances'); guard();
  if (!balances || !/^[0-9]+$/.test(balances.keep) || !/^[0-9]+$/.test(balances.shards) || !Number.isFinite(balances.keepRate)) throw new Error('Wallet balances did not refresh.');
  if (stillOwned) {
    const target = originalBaseId ?? balanceBase;
    inventory(await read<unknown>(target ? `/items?baseId=${encodeURIComponent(target)}` : '/items')); guard();
  }
  return { destination: { baseId: originalBaseId, stillOwned }, directory: owned, balances, balanceBase, entryPaid: me.entryPaid };
}
/** Bound transport waiting, never the payment's lifetime. Abort the actual
 * request and reject late responses before they can update the saved receipt. */
export async function marketRequest<T>(request: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
  try {
    const result = await request(controller.signal);
    controller.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Market request timed out. Your saved receipt is kept. Read it again to continue.');
    throw error;
  } finally { clearTimeout(timer); }
}
export function createMarketBrowserPorts(input: {
  identity: MarketIdentity;
  connection: Connection;
  wallet(): GameWallet;
  lifecycle(): { active: boolean; epoch: number; visible: boolean };
}): MarketPorts {
  const capture = (newAction: boolean): (() => void) => {
    const revision = authCookies.assertSession(); const generation = authCookies.captureGeneration();
    const selected = useApp.getState(); const epoch = input.lifecycle().epoch;
    return () => {
      const current = useApp.getState(); const page = input.lifecycle();
      authCookies.assertResponse(revision);
      if (!authCookies.current(generation) || !current.authed || current.wallet !== input.identity.wallet || !page.active
        || (newAction && (current.selectedBaseId !== selected.selectedBaseId || current.baseSelectionEpoch !== selected.baseSelectionEpoch
          || page.epoch !== epoch || !page.visible))) throw new Error('The account, selected base or page changed. Read the saved market receipt.');
    };
  };
  const read = <T>(path: string): Promise<T> => marketRequest((signal) => api.get<T>(path, { signal }));
  const hydrate = async (baseId: string | null): Promise<NonNullable<MarketPurchase['hydrated']>> => {
    const guard = capture(false); const initial = useApp.getState(); const selected = initial.selectedBaseId;
    const result = await refreshMarketDestination(input.identity.wallet, baseId, read, guard, selected); guard();
    const current = useApp.getState(); current.setEntryPaid(result.entryPaid); current.setBaseDirectory(result.directory);
    // Only the coherent selected-base balance read can update the shared HUD.
    if (current.selectedBaseId === result.balanceBase && current.baseSelectionEpoch === initial.baseSelectionEpoch) current.setBalances(result.balances);
    return result.destination;
  };
  return {
    get: read, post: (path, body) => marketRequest((signal) => api.postRaw(path, body, { signal })),
    lock: marketBrowserLock, capture,
    assertDestination: (baseId) => {
      if (baseId !== null && useApp.getState().selectedBaseId !== baseId) throw new Error('Select the original receiving base before approving this payment.');
    },
    prepare: (quote) => prepareMarketPayment(quote, input.connection),
    sign: (prepared, buyer) => signMarketPayment(prepared, buyer, input.wallet()),
    broadcast: (wire, signature) => broadcastMarketPayment(input.connection, wire, signature),
    hydratePurchase: (quote) => hydrate(quote.buyerBaseId),
    hydrateCommand: async (command: MarketCommand) => {
      const sourceBase = command.kind === 'list' ? command.request.baseId : command.request.sourceBaseId;
      await hydrate(sourceBase);
    },
    clock: () => ({ elapsed: performance.now(), wall: Date.now() }), key: () => crypto.randomUUID(), firstRefusal: firstMarketRefusal,
  };
}
