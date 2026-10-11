import { mutationGate } from '../mutationGate';
import { LAND_CHECKOUT_RECOVERY, TOKEN } from '@shardkeep/shared';
import type { Connection } from '@solana/web3.js';
import { authCookies } from '../../auth/authCookieCoordinator';
import type { GameWallet } from '../../auth/useGameWallet';
import { captureBaseBalanceCommit } from '../../state/baseSnapshot';
import { useApp, type BalancesDto } from '../../state/store';
import { api, API_URL } from '../api';
import { expectedSolanaGenesis, KEEP_MINT, SOLANA_CLUSTER } from '../cluster';
import { amount, object, parseGemsOverview } from '../gems/contracts';
import { gemsBuyAddress, type GemsBuyBinding, type GemsBuyReceipt } from './contracts';
import { gemsBuyLock, type GemsBuyPorts } from './controller';
import { parseGemsBuyIdentity, type GemsBuyIdentity } from './journal';
import { assertGemsBuyPaymentLive, broadcastGemsBuyPayment, prepareGemsBuyPayment, signGemsBuyPayment,
  type GemsBuyPaymentConnection, type PreparedGemsBuyPayment } from './payment';

export const gemsBuyIdentity = (wallet: string): GemsBuyIdentity => parseGemsBuyIdentity({ origin: window.location.origin,
  api: new URL(API_URL, window.location.origin).href.replace(/\/$/, ''), wallet, cluster: SOLANA_CLUSTER });
export const gemsBuyBinding = (wallet: string): GemsBuyBinding => ({ wallet, mint: KEEP_MINT, decimals: TOKEN.decimals });
async function request<T>(guard: () => void, send: (signal: AbortSignal) => Promise<T>): Promise<T> {
  guard(); const abort = new AbortController(), timer = setTimeout(() => abort.abort(), LAND_CHECKOUT_RECOVERY.requestTimeoutMs);
  try { const result = await send(abort.signal); abort.signal.throwIfAborted(); guard(); return result; }
  catch (error) { if (abort.signal.aborted) throw new Error('Purchase request timed out. The original recovery record is kept.'); throw error; }
  finally { clearTimeout(timer); }
}
function directory(raw: unknown): { enabled: boolean; readable: boolean; owned: string[] } {
  const r = object(raw), caps = object(r.capabilities);
  if (typeof r.enabled !== 'boolean' || typeof caps.baseScopedReads !== 'boolean' || !Array.isArray(r.bases)) throw new Error('Base ownership could not be refreshed.');
  const rows = r.bases.map(object);
  if (rows.some(b => typeof b.id !== 'string' || !/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(b.id) || !['active', 'inactive'].includes(String(b.status))
    || !(b.slot === null || Number.isSafeInteger(b.slot) && (b.slot as number) > 0))
    || new Set(rows.map(b => b.id)).size !== rows.length) throw new Error('Base ownership could not be refreshed.');
  return { enabled: r.enabled, readable: caps.baseScopedReads, owned: rows.filter(b => b.status === 'active' && b.slot !== null).map(b => b.id as string).sort() };
}
/** Wallet credit proof is independent of the selected base. Never replace its SHARDS with another base's snapshot. */
export async function hydrateGemsBuyReceipt(identity: GemsBuyIdentity, receipt: GemsBuyReceipt, guard: () => void): Promise<void> {
  if (receipt.wallet !== identity.wallet) throw new Error('The purchase receipt belongs to another account.');
  const get = (path: string) => request(guard, signal => api.get(path, { signal, isCurrent: () => { guard(); return true; } }));
  const selected = useApp.getState(), baseId = selected.selectedBaseId, selectionEpoch = selected.baseSelectionEpoch;
  const me = object(await get('/me')); if (me.wallet !== identity.wallet) throw new Error('The original purchase account did not refresh.');
  const before = directory(await get('/bases')); guard();
  if (before.enabled ? !before.readable || baseId === null || !before.owned.includes(baseId) : baseId !== null) return;
  const commit = captureBaseBalanceCommit(baseId);
  const raw = object(await get(baseId === null ? '/balances' : `/balances?baseId=${encodeURIComponent(baseId)}`)); guard();
  amount(raw.keep); amount(raw.shards); if (raw.gems !== undefined) amount(raw.gems);
  if (!Number.isSafeInteger(raw.keepRate) || (raw.keepRate as number) <= 0) throw new Error('Purchase balances did not refresh.');
  const after = directory(await get('/bases')); guard();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Base ownership changed during the balance refresh.');
  const current = useApp.getState();
  if (current.selectedBaseId === baseId && current.baseSelectionEpoch === selectionEpoch) commit(raw as unknown as BalancesDto);
}
export function createGemsBuyBrowserPorts(input: { identity: GemsBuyIdentity; connection: Connection; wallet(): GameWallet;
  lifecycle(): { active: boolean; visible: boolean; epoch: number; actionsEnabled: boolean } }): GemsBuyPorts {
  const signers = new WeakMap<PreparedGemsBuyPayment, { wallet: GameWallet; guard: () => void }>();
  const capture = (newAction: boolean) => {
    const canonical = gemsBuyIdentity(input.identity.wallet);
    if (JSON.stringify(parseGemsBuyIdentity(input.identity)) !== JSON.stringify(canonical)) throw new Error('This purchase belongs to another origin, server or network.');
    const revision = authCookies.assertSession(), generation = authCookies.captureGeneration(), epoch = input.lifecycle().epoch;
    return () => {
      authCookies.assertResponse(revision); const state = useApp.getState(), page = input.lifecycle();
      if (!authCookies.current(generation) || !state.authed || state.wallet !== canonical.wallet || !page.active || !page.visible
        || page.epoch !== epoch || newAction && (!mutationGate.getSnapshot() || !page.actionsEnabled)) throw new Error('The account or purchase view changed. Check the original purchase.');
    };
  };
  const get: GemsBuyPorts['get'] = (path, guard) => request(guard, signal => api.get(path, { signal, isCurrent: () => { guard(); return true; } }));
  const rpc = (guard: () => void): GemsBuyPaymentConnection => {
    const read = async <T>(run: () => Promise<T>) => { guard(); const value = await run(); guard(); return value; };
    return {
      getGenesisHash: () => read(() => input.connection.getGenesisHash()),
      getLatestBlockhash: commitment => read(() => input.connection.getLatestBlockhash(commitment)),
      getBlockHeight: commitment => read(() => input.connection.getBlockHeight(commitment)),
      getFeeForMessage: (message, commitment) => read(() => input.connection.getFeeForMessage(message, commitment)),
      getBalance: (owner, commitment) => read(() => input.connection.getBalance(owner, commitment)),
      getTokenAccountBalance: (owner, commitment) => read(() => input.connection.getTokenAccountBalance(owner, commitment)),
    };
  };
  const originalSigner = (prepared: PreparedGemsBuyPayment) => {
    const saved = signers.get(prepared), current = input.wallet();
    if (!saved || !current.publicKey?.equals(saved.wallet.publicKey!) || current.signTransaction !== saved.wallet.signTransaction) throw new Error('The original wallet signer changed. Review the saved purchase.');
    saved.guard(); return saved;
  };
  return {
    capture, get, post: (path, body, guard) => request(guard, signal => api.postRaw(path, body, { signal, isCurrent: () => { guard(); return true; } })),
    lock: gemsBuyLock, key: () => crypto.randomUUID(), clock: () => ({ elapsed: performance.now(), wall: Date.now() }),
    policy: async (binding, guard) => {
      if (JSON.stringify(binding) !== JSON.stringify(gemsBuyBinding(input.identity.wallet))) throw new Error('The original KEEP mint configuration changed.');
      const gems = parseGemsOverview(await get('/gems', guard)); guard();
      const native = object(await get('/native/capabilities', guard)); guard();
      const caps = object(object(native.economy).gems);
      if (native.protocolVersion !== 1 || caps.enabled !== true || !Array.isArray(caps.sources) || !caps.sources.includes('wallet-keep')
        || !gems.sources.includes('wallet-keep') || gems.gemsPerKeep !== 1 || caps.gemsPerKeep !== 1
        || caps.minConvertKeep !== gems.minConvertKeep || caps.maxConvertKeepPerTx !== gems.maxConvertKeepPerTx) throw new Error('Wallet Gems purchases are unavailable or their terms changed.');
      return { destinationAta: gemsBuyAddress(caps.destinationAta), minConvertKeep: gems.minConvertKeep, maxConvertKeepPerTx: gems.maxConvertKeepPerTx };
    },
    prepare: async (admission, guard) => {
      guard(); const signer = input.wallet();
      if (signer.publicKey?.toBase58() !== input.identity.wallet || !signer.signTransaction) throw new Error('Connect the original wallet with sign-only transaction support.');
      const prepared = await prepareGemsBuyPayment(admission, rpc(guard), expectedSolanaGenesis(input.identity.cluster)); guard();
      signers.set(prepared, { wallet: { ...signer }, guard }); originalSigner(prepared); return prepared;
    },
    sign: async prepared => signGemsBuyPayment(prepared, originalSigner(prepared).wallet),
    live: async (prepared, guard) => { guard(); originalSigner(prepared); await assertGemsBuyPaymentLive(prepared, rpc(guard)); guard(); },
    broadcast: async (wire, signature, guard) => {
      guard(); if (input.wallet().publicKey?.toBase58() !== input.identity.wallet) throw new Error('The original wallet changed before broadcast.');
      await broadcastGemsBuyPayment({ sendRawTransaction: (bytes, options) => { guard(); return input.connection.sendRawTransaction(bytes, options); } }, wire, signature);
      guard();
    },
    hydrate: (receipt, guard) => hydrateGemsBuyReceipt(input.identity, receipt, guard),
  };
}
