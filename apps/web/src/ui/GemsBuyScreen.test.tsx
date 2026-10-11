/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { mutationGate } from '../lib/mutationGate';
import { authCookies } from '../auth/authCookieCoordinator';
import { useApp } from '../state/store';
import { expectedSolanaGenesis, SOLANA_CLUSTER } from '../lib/cluster';
import { GemsBuyJournalStore } from '../lib/gemsBuy/journal';
import { gemsBuyBinding, gemsBuyIdentity } from '../lib/gemsBuy/browser';
import { gemsBuySourceAta, type GemsBuyQuote } from '../lib/gemsBuy/contracts';
import { address, binding, credited, disclosure, owner, policy, quote, recovery, serverNow, uuid } from '../lib/gemsBuy/fixtures.test-support';
import { GemsBuyScreen } from './GemsBuyScreen';
import { GemsRecoveryDoor, GemsWalletScreen } from './screens/gems';
const h = vi.hoisted(() => ({ wallet: {} as Record<string, unknown>, connection: {
  getGenesisHash: vi.fn(), getLatestBlockhash: vi.fn(), getFeeForMessage: vi.fn(), getBalance: vi.fn(), getTokenAccountBalance: vi.fn(), getBlockHeight: vi.fn(), sendRawTransaction: vi.fn(),
} }));
const gate = vi.hoisted(() => ({ open: true, listeners: new Set<() => void>() }));
vi.mock('../lib/mutationGate', () => ({ mutationGate: {
  getSnapshot: () => gate.open,
  subscribe: (listener: () => void) => { gate.listeners.add(listener); return () => gate.listeners.delete(listener); },
  close: () => { if (gate.open) { gate.open = false; for (const listener of gate.listeners) listener(); } },
} }));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: h.connection }) }));
vi.mock('../auth/useGameWallet', () => ({ useGameWallet: () => h.wallet }));
let root: Root, host: HTMLDivElement, remote: GemsBuyQuote | null, paid: boolean, enabled: boolean, visibility: DocumentVisibilityState;
let sign: ReturnType<typeof vi.fn>, sendOpaque: ReturnType<typeof vi.fn>;
const originalBinding = () => gemsBuyBinding(binding.wallet);
const known = (key: string) => ({ ...recovery(), idempotencyKey: key, status: remote?.idempotencyKey === key ? 'known' : 'unknown',
  deposit: remote?.idempotencyKey === key ? { originalIntent: remote, ...(paid ? actualCredit() : disclosure()), keepIn: remote.keepIn, gemsOut: remote.gemsOut } : null });
const actualCredit = () => {
  const actual = credited(), baseUnits = (12n * 10n ** BigInt(originalBinding().decimals) + 7n).toString();
  return { ...actual, amount: baseUnits, receipt: { ...actual.receipt, funding: { ...actual.receipt.funding, baseUnits } } };
};
const overview = () => ({ features: { gems: { version: 1, receipts: 1, exactConsent: 1 } }, gems: '12', tasks: [], sources: ['wallet-keep'],
  minConvertKeep: 1, maxConvertKeepPerTx: 100, gemsPerKeep: 1, shardsPerGem: 1, serverNow });
const saved = async () => { const store = new GemsBuyJournalStore(gemsBuyIdentity(binding.wallet)); try { return await store.read(); } finally { await store.close(); } };
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const until = (check: () => void | Promise<void>) => act(async () => { await vi.waitFor(check); });
const click = async (label: string) => { expect(button(label), label).toBeDefined(); expect(button(label)!.disabled).toBe(false); await act(async () => button(label)!.click()); };
const enter = async (text: string) => act(async () => {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="WALLET KEEP amount"]')!;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true }));
});
const mount = async (strict = false) => { await act(async () => root.render(strict ? <StrictMode><GemsBuyScreen onBack={() => undefined} /></StrictMode> : <GemsBuyScreen onBack={() => undefined} />)); await until(() => expect(button('REFRESH SAVED PURCHASE')?.disabled).toBe(false)); };
const review = async () => { await enter('10'); await click('GET ORIGINAL QUOTE'); await until(() => expect(button('REVIEW WALLET PAYMENT')?.disabled).toBe(false)); await click('REVIEW WALLET PAYMENT'); await until(() => expect(button('APPROVE 10 WALLET KEEP')?.disabled).toBe(false)); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
beforeEach(() => {
  gate.open = true; gate.listeners.clear();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null); held.add(name); try { return await run({}); } finally { held.delete(name); }
  } } });
  visibility = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(binding.wallet, true); useApp.getState().setScreen('exchange'); useApp.getState().setSelectedBaseId(uuid(4), false);
  useApp.getState().setBalances({ keep: '500', gems: '12', shards: '20', keepRate: 1 });
  remote = null; paid = false; enabled = true;
  sign = vi.fn(async (tx: Transaction) => { tx.sign(owner); return tx; }); sendOpaque = vi.fn();
  h.wallet = { publicKey: owner.publicKey, signTransaction: sign, sendTransaction: sendOpaque, signMessage: null, isEmbedded: false };
  h.connection.getGenesisHash.mockReset().mockResolvedValue(expectedSolanaGenesis(SOLANA_CLUSTER));
  h.connection.getLatestBlockhash.mockReset().mockResolvedValue({ blockhash: address(35), lastValidBlockHeight: 123 });
  h.connection.getFeeForMessage.mockReset().mockResolvedValue({ context: { slot: 1 }, value: 5000 });
  h.connection.getBalance.mockReset().mockResolvedValue(5000); h.connection.getBlockHeight.mockReset().mockResolvedValue(100);
  h.connection.getTokenAccountBalance.mockReset().mockResolvedValue({ context: { slot: 1 }, value: { amount: (100n * 10n ** BigInt(originalBinding().decimals)).toString(), decimals: originalBinding().decimals, uiAmount: 100 } });
  h.connection.sendRawTransaction.mockReset().mockImplementation(async (wire: Uint8Array) => bs58.encode(Transaction.from(wire).signatures[0]!.signature!));
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path.startsWith('/gems/buy/by-key/')) return known(decodeURIComponent(path.split('/').at(-1)!)) as never;
    if (path === '/gems') { if (!enabled) throw new ApiError(503, 'Gems paused'); return overview() as never; }
    if (path === '/native/capabilities') return { protocolVersion: 1, economy: { gems: { ...overview(), enabled, destinationAta: policy.destinationAta } } } as never;
    if (path === '/me') return { wallet: binding.wallet } as never;
    if (path === '/bases') return { enabled: true, capabilities: { baseScopedReads: true }, bases: [{ id: uuid(4), status: 'active', slot: 1 }] } as never;
    if (path.startsWith('/balances')) return { keep: '500', shards: '20', gems: '12', keepRate: 1 } as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.spyOn(api, 'postRaw').mockImplementation(async (path, body) => {
    if (path === '/deposits') {
      const request = body as { keepIn: number; idempotencyKey: string }, b = originalBinding();
      expect((await saved()).purchase?.request).toEqual(body);
      remote = { ...quote(), ...b, ...request, source: gemsBuySourceAta(b.wallet, b.mint), gemsOut: request.keepIn };
      return { ...remote, status: 'pending', serverNow } as never;
    }
    if (path.endsWith('/paid')) return { committed: true } as never;
    if (path.endsWith('/verify')) { paid = true; return { id: quote().id, kind: 'gems_buy', reference: quote().reference, ...actualCredit() } as never; }
    throw new Error(`Unexpected ${path}`);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });

it('mount and StrictMode foreground only read; explicit review shows wallet KEEP, reserve, fee and expiry without signing', async () => {
  await mount(true); expect(api.get).not.toHaveBeenCalled(); expect(api.postRaw).not.toHaveBeenCalled();
  await review(); const panel = host.querySelector('[aria-label="Approve wallet payment"]');
  expect(document.activeElement).toBe(panel);
  expect(panel?.textContent).toContain('10 WALLET KEEP → 10 GEMS'); expect(panel?.textContent).toContain(policy.destinationAta);
  expect(panel?.textContent).toContain('0.000005 SOL'); expect(panel?.textContent).toContain(quote().expiresAt);
  expect(host.textContent).toContain('does not spend your in-game KEEP'); expect(sign).not.toHaveBeenCalled(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
  await click('CANCEL REVIEW'); expect((await saved()).purchase?.prepared).toBeNull();
  const posts = vi.mocked(api.postRaw).mock.calls.length; await act(async () => window.dispatchEvent(new Event('focus')));
  await until(() => expect(button('REFRESH SAVED PURCHASE')?.disabled).toBe(false)); expect(api.postRaw).toHaveBeenCalledTimes(posts);
});
it('one explicit wallet approval verifies actual credit and archives immutable original proof', async () => {
  await mount(); await review(); await click('APPROVE 10 WALLET KEEP');
  await until(() => expect(host.textContent).toContain('Original receipt confirmed: +12 GEMS'));
  expect(document.activeElement?.textContent).toContain('Original receipt confirmed: +12 GEMS');
  expect(host.textContent).toContain('Uncredited token dust: 7 base units'); expect(sign).toHaveBeenCalledOnce(); expect(sendOpaque).not.toHaveBeenCalled();
  expect(h.connection.sendRawTransaction).toHaveBeenCalledTimes(1); expect((await saved()).purchase?.hydrated).toBe(true);
  await click('ARCHIVE CONFIRMED PURCHASE'); await until(() => expect(host.textContent).toContain('SAVED PURCHASE HISTORY (1)'));
  expect((await saved()).archives[0]?.purchase.deposit?.receipt?.result.amount).toBe('12');
});
it('uncertain wallet rejection survives remount with only original-proof controls and no replacement payment', async () => {
  await mount(); await review(); sign.mockRejectedValue(new Error('wallet rejected or timed out')); await click('APPROVE 10 WALLET KEEP');
  await until(() => expect(host.textContent).toContain('wallet rejected or timed out'));
  expect(button('REVIEW WALLET PAYMENT')).toBeUndefined(); expect(button('ARCHIVE UNUSED DRAFT')).toBeUndefined(); expect(button('GET ORIGINAL QUOTE')).toBeUndefined();
  await act(async () => root.unmount()); root = createRoot(host); enabled = false; await mount();
  expect(host.textContent).toContain('A wallet payment may already exist'); expect(sign).toHaveBeenCalledOnce(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
  await click('CHECK ORIGINAL PAYMENT'); await until(() => expect(host.textContent).toContain('Original receipt confirmed: +12 GEMS'));
  expect(sign).toHaveBeenCalledOnce();
});
it('logout/unmount during wallet approval keeps the original store open until its public signature is saved', async () => {
  await mount(); await review(); const pending = deferred<void>(); sign.mockImplementation(async (tx: Transaction) => { await pending.promise; tx.sign(owner); return tx; });
  await click('APPROVE 10 WALLET KEEP'); await until(() => expect(sign).toHaveBeenCalledOnce());
  await act(async () => { useApp.getState().setAuth(null); root.render(<div>Other account</div>); });
  await act(async () => pending.resolve()); await until(async () => expect((await saved()).purchase?.signature).toBeTruthy());
  expect(h.connection.sendRawTransaction).not.toHaveBeenCalled(); expect(host.textContent).toBe('Other account');
});
it('hide/foreground during a pending wallet schedules one GET-only reopen after the obsolete action settles', async () => {
  await mount(); await review(); const pending = deferred<void>(); sign.mockImplementation(async (tx: Transaction) => { await pending.promise; tx.sign(owner); return tx; });
  await click('APPROVE 10 WALLET KEEP'); await until(() => expect(sign).toHaveBeenCalledOnce());
  const posts = vi.mocked(api.postRaw).mock.calls.length;
  await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange')); });
  await act(async () => pending.resolve()); await until(() => expect(button('CHECK ORIGINAL PAYMENT')?.disabled).toBe(false));
  expect((await saved()).purchase?.signature).toBeTruthy(); expect(api.postRaw).toHaveBeenCalledTimes(posts); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
});
it('failed preparation persistence prevents the wallet prompt and leaves the original draft reviewable', async () => {
  await mount(); await review(); const compare = GemsBuyJournalStore.prototype.compareAndSet;
  vi.spyOn(GemsBuyJournalStore.prototype, 'compareAndSet').mockImplementation(async function(this: GemsBuyJournalStore, revision, update) {
    const old = await this.read(); const next = update(structuredClone(old));
    if (!old.purchase?.prepared && next.purchase?.prepared) throw new Error('disk full');
    return compare.call(this, revision, update);
  });
  await click('APPROVE 10 WALLET KEEP'); await until(() => expect(host.textContent).toContain('disk full'));
  expect(sign).not.toHaveBeenCalled(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled(); expect((await saved()).purchase?.prepared).toBeNull();
});
it('paused recovery door sees wallet-only records locally, and the Gems wallet offers its separate purchase screen', async () => {
  await mount(); await review(); await act(async () => root.unmount()); root = createRoot(host); enabled = false;
  expect((await saved()).purchase?.quote).not.toBeNull();
  vi.mocked(api.get).mockClear(); vi.mocked(api.postRaw).mockClear(); const open = vi.fn();
  await act(async () => root.render(<GemsRecoveryDoor onOpen={open} />));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); expect(button('CHECK SAVED GEMS REQUEST')).toBeDefined(); });
  expect(api.get).not.toHaveBeenCalled(); await click('CHECK SAVED GEMS REQUEST'); expect(open).toHaveBeenCalledOnce();
  await act(async () => root.render(<GemsWalletScreen />)); await until(() => expect(button('WALLET KEEP PURCHASES & RECOVERY')).toBeDefined());
  await click('WALLET KEEP PURCHASES & RECOVERY'); await until(() => expect(host.querySelector('[role="dialog"][aria-label="Get Gems"]')).not.toBeNull());
  expect(api.postRaw).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
});

it('closing the document gate dismisses an open wallet review without prompting or abandoning the saved quote', async () => {
  await mount(); await review(); const original = (await saved()).purchase;
  await act(async () => mutationGate.close());
  await until(() => expect(button('CHECK ORIGINAL PAYMENT')?.disabled).toBe(false));
  expect(button('APPROVE 10 WALLET KEEP')).toBeUndefined();
  expect(button('REVIEW WALLET PAYMENT')?.disabled).toBe(true);
  expect((await saved()).purchase?.request).toEqual(original?.request);
  expect(sign).not.toHaveBeenCalled(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
});
it('a gate closing inside wallet approval retains its late signature and allows explicit settlement without another payment', async () => {
  await mount(); await review(); const pending = deferred<void>();
  sign.mockImplementation(async (tx: Transaction) => { await pending.promise; tx.sign(owner); return tx; });
  await click('APPROVE 10 WALLET KEEP'); await until(() => expect(sign).toHaveBeenCalledOnce());
  const posts = vi.mocked(api.postRaw).mock.calls.length;
  await act(async () => mutationGate.close()); await act(async () => pending.resolve());
  await until(() => expect(button('CHECK ORIGINAL PAYMENT')?.disabled).toBe(false));
  expect((await saved()).purchase?.signature).toBeTruthy();
  expect(api.postRaw).toHaveBeenCalledTimes(posts); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
  await click('CHECK ORIGINAL PAYMENT'); await until(() => expect(host.textContent).toContain('Original receipt confirmed: +12 GEMS'));
  expect(sign).toHaveBeenCalledOnce(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
});

// Existing scenarios explicitly exercise the admitted web build; hold cases override it.
beforeEach(() => vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'));
afterEach(() => vi.unstubAllEnvs());

it('offers no new wallet quote while the web hold is active', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); await mount();
  expect(host.querySelector('[aria-label="New wallet Gems purchase"]')).toBeNull();
  expect(button('GET ORIGINAL QUOTE')).toBeUndefined(); expect(api.postRaw).not.toHaveBeenCalled();
  expect(sign).not.toHaveBeenCalled(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
});
it('keeps an already-paid wallet request recoverable without opening a fresh purchase', async () => {
  await mount(); await review(); await click('APPROVE 10 WALLET KEEP');
  await until(() => expect(host.textContent).toContain('Original receipt confirmed: +12 GEMS'));
  // 2026-10-10 (CI cluster F): the receipt is published while the approval action still
  // holds the per-purchase tab lock (hydration follows). Remounting before it settled let
  // the new view's open() meet that lock and show 'Another tab is handling this purchase'
  // under CI load. This test pins what a held web build shows for a SETTLED paid request,
  // so the old view must be idle (busy=false is published after the lock is released).
  await until(() => expect(button('REFRESH SAVED PURCHASE')?.disabled).toBe(false));
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  await act(async () => root.unmount()); root = createRoot(host); await mount();
  expect(host.textContent).toContain('Original receipt confirmed: +12 GEMS');
  expect(button('CHECK ORIGINAL PAYMENT')).toBeDefined();
  expect(button('GET ORIGINAL QUOTE')).toBeUndefined(); expect(button('REVIEW WALLET PAYMENT')).toBeUndefined();
  expect(sign).toHaveBeenCalledTimes(1); expect(h.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
});
it('does not turn an unpaid saved quote into a fresh wallet payment while held', async () => {
  await mount(); await enter('10'); await click('GET ORIGINAL QUOTE');
  await until(() => expect(button('REVIEW WALLET PAYMENT')).toBeDefined());
  // Same settled-view precondition as above: the quote action must release its tab lock
  // before the remount, or the new view reports another tab instead of the held quote.
  await until(() => expect(button('REFRESH SAVED PURCHASE')?.disabled).toBe(false));
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0');
  await act(async () => root.unmount()); root = createRoot(host); await mount();
  expect(button('REVIEW WALLET PAYMENT')).toBeUndefined(); expect(button('APPROVE 10 WALLET KEEP')).toBeUndefined();
  expect(button('CHECK ORIGINAL PAYMENT')).toBeDefined(); expect(sign).not.toHaveBeenCalled();
});
