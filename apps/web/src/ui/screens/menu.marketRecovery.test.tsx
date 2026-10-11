/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { MarketJournalStore, type ReservationReceipt } from '../../lib/market/journal';
import { marketIdentity } from '../../lib/market/browser';
import { buyer, blockhash, id, receipt, seller, deferred } from '../../lib/market/fixtures.test-support';
import { MarketScreen } from './menu';
const h = vi.hoisted(() => ({ wallet: {} as Record<string, unknown>, buy: vi.fn(),
  connection: { getLatestBlockhash: vi.fn(), getFeeForMessage: vi.fn(), getBalance: vi.fn(), sendRawTransaction: vi.fn() } }));
vi.mock('@solana/wallet-adapter-react', () => ({ useConnection: () => ({ connection: h.connection }), useWallet: () => ({ publicKey: null }) }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => h.wallet }));
vi.mock('../../auth/useMarketBuy', () => ({ useMarketBuy: () => ({ buy: h.buy, phase: 'idle', listingId: null, error: null }) }));
vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn() }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));
let host: HTMLDivElement; let root: Root; let enabled: boolean; let remote: ReservationReceipt; let own: boolean; let cancelResult: unknown; let visibility: DocumentVisibilityState;
const spec = { id: 'iron_sword', name: 'Iron Sword', kind: 'gear', costKeep: 0, asset: '', desc: 'A test item.', rarity: 'common', weight: 1, acquisition: { type: 'shop' }, maxOwned: null };
const itemInventory = () => ({ catalog: [spec], owned: [{ itemId: spec.id, qty: 2 }], heroLoadouts: [] });
const features = { itemMarket: { version: 1, listingReceipts: 1, reservationReceipts: 1, cancelReceipts: 1 } };
function buttons(): HTMLButtonElement[] { return [...host.querySelectorAll('button')]; }
async function click(label: string): Promise<void> {
  const b = buttons().find((button) => button.textContent === label); expect(b, label).toBeDefined(); expect(b!.disabled, label).toBe(false);
  await act(async () => b!.click());
}
async function ready(): Promise<void> { await act(async () => { await vi.waitFor(() => expect(buttons().find((b) => b.textContent === 'BUY')?.disabled).toBe(false)); }); }
async function render(): Promise<void> { await act(async () => root.render(<MarketScreen />)); }
async function reserve(): Promise<void> { await ready(); await click('BUY'); await click('CONFIRM RESERVATION'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('SAVED PURCHASE')); }); }
const saved = async () => { const s = new MarketJournalStore(marketIdentity(buyer.publicKey.toBase58())); try { return await s.read(); } finally { await s.close(); } };
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, fn: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return fn(null); held.add(name); try { return await fn({ name }); } finally { held.delete(name); }
  } } });
  visibility = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  enabled = true; own = false; cancelResult = null; remote = receipt(); h.buy.mockReset().mockResolvedValue(undefined);
  h.connection.getLatestBlockhash.mockReset().mockResolvedValue({ blockhash, lastValidBlockHeight: 10 });
  h.connection.getFeeForMessage.mockReset().mockResolvedValue({ context: { slot: 1 }, value: 5000 }); h.connection.getBalance.mockReset().mockResolvedValue(1005000);
  h.connection.sendRawTransaction.mockReset().mockImplementation(async (wire: Uint8Array) => bs58.encode(Transaction.from(wire).signature!));
  h.wallet = { publicKey: buyer.publicKey, signMessage: null, sendTransaction: vi.fn(), isEmbedded: false,
    signTransaction: vi.fn(async (tx: Transaction) => { tx.sign(buyer); return tx; }) };
  useApp.getState().setAuth(buyer.publicKey.toBase58(), true); useApp.setState({ selectedBaseId: id(5), baseSelectionEpoch: 1 });
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/market/collection') return { collection: null, links: null, feeBps: 500, tradingEnabled: false };
    if (path === '/market/assets') return { assets: [], tradingEnabled: false };
    if (path === '/market/purchases/pending') return { purchases: [], next: null };
    if (path === '/market/trades') return { trades: [], hasMore: false };
    if (path.endsWith('/listings/mine')) return { listings: own ? [{ id: id(3), itemId: spec.id, baseId: id(4), priceLamports: '1000000', status: 'reserved', cancelConsent: { version: 1, status: 'reserved', reference: remote.quote.reference } }] : [] };
    if (path.startsWith('/market/listings')) return { feeBps: 500, listings: [{ id: id(3), itemId: spec.id, baseId: id(4), seller, priceLamports: '1000000' }], summary: [{ itemId: spec.id, floorLamports: '1000000', listed: 1 }], ...(enabled ? { features } : {}) };
    if (path.startsWith('/market/v1/reservations/by-key/')) return remote;
    if (path.startsWith('/market/v1/cancellations/by-key/')) return cancelResult;
    if (path.startsWith('/items')) return itemInventory();
    if (path === '/me') return { wallet: buyer.publicKey.toBase58(), entryPaid: true };
    if (path === '/bases') return { enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: id(5), status: 'active', slot: 1 }, { id: id(6), status: 'active', slot: 2 }] };
    if (path.startsWith('/balances')) return { keep: '4', shards: '5', keepRate: 1 };
    throw new Error(path);
  });
  vi.spyOn(api, 'postRaw').mockImplementation(async (path, body) => {
    if (path.endsWith('/reserve')) { remote.quote.idempotencyKey = (body as { idempotencyKey: string }).idempotencyKey; return structuredClone(remote); }
    if (path.endsWith('/paid')) { remote = { ...remote, payable: false, state: 'committed', paymentSignature: (body as { signature: string }).signature }; return structuredClone(remote); }
    if (path.endsWith('/settle')) { remote = { ...remote, payable: false, state: 'settled', txSignature: remote.paymentSignature, resolvedAt: '2026-09-13T00:00:10.000Z' }; return structuredClone(remote); }
    if (path.endsWith('/cancel')) { (cancelResult as { idempotencyKey: string }).idempotencyKey = (body as { idempotencyKey: string }).idempotencyKey; return cancelResult; }
    throw new Error(path);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  Reflect.deleteProperty(document, 'visibilityState'); vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null);
});
describe('market v1 real menu journeys', () => {
  it('keeps browsing read-only until reservation consent and exposes the original quote before any wallet prompt', async () => {
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => undefined);
    await render(); await ready(); expect(api.postRaw).not.toHaveBeenCalled();
    const trigger = buttons().find((button) => button.textContent === 'BUY')!; trigger.focus();
    await click('BUY');
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Review market request"]'));
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
    expect(host.textContent).toContain('Receiving inventory'); expect(api.postRaw).not.toHaveBeenCalled(); await click('BACK'); expect(api.postRaw).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
    await reserve(); expect(api.postRaw).toHaveBeenCalledTimes(1); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
    expect(host.textContent).toContain('0.00095 SOL'); expect(host.textContent).toContain('0.00005 SOL'); expect(host.textContent).toContain(id(5)); expect(host.textContent).toContain('devnet');
  });
  it('reviews network fee, pays once, refreshes the original delivery and finishes the receipt', async () => {
    await render(); await reserve(); await click('REVIEW NETWORK FEE');
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('Estimated network fee')); });
    expect(h.wallet.signTransaction).not.toHaveBeenCalled(); await click('PAY 0.001 SOL + NETWORK FEE');
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('Payment settled and the original receiving inventory refreshed')); });
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
    await click('FINISH'); await act(async () => { await vi.waitFor(async () => expect((await saved()).purchase).toBeNull()); });
    expect((await saved()).activated).toBe(true);
  });
  it('does not approve a stale selected-base review', async () => {
    await render(); await ready(); await click('BUY'); await act(async () => useApp.setState({ selectedBaseId: id(6), baseSelectionEpoch: 2 }));
    await click('CONFIRM RESERVATION'); expect(api.postRaw).not.toHaveBeenCalled(); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('restores RPC uncertainty after unmount with GET only and explicitly settles without signing or sending again', async () => {
    h.connection.sendRawTransaction.mockRejectedValueOnce(new Error('RPC response lost'));
    await render(); await reserve(); await click('REVIEW NETWORK FEE'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('Estimated network fee')); });
    await click('PAY 0.001 SOL + NETWORK FEE'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('RPC response lost')); });
    const count = vi.mocked(api.postRaw).mock.calls.length; await act(async () => root.unmount()); root = createRoot(host); await render();
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('SAVED PURCHASE')); });
    expect(api.postRaw).toHaveBeenCalledTimes(count); expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.waitFor(() => expect(buttons().find((b) => b.textContent === 'CHECK ORIGINAL PAYMENT')?.disabled).toBe(false)); });
    await click('CHECK ORIGINAL PAYMENT'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('Payment settled')); });
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('retains the v1 activation after closing unpaid review, even if the server capability disappears', async () => {
    await render(); await reserve(); enabled = false; await click('CLOSE SAVED REVIEW'); await ready();
    await click('BUY'); await click('CONFIRM RESERVATION'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('has not enabled saved market payments')); });
    expect(h.buy).not.toHaveBeenCalled(); expect(api.postRaw).toHaveBeenCalledTimes(1);
  });
  it('attributes cancelled-listing paid rescue to the original buyer destination', async () => {
    own = true; cancelResult = { version: 1, idempotencyKey: id(1), actor: buyer.publicKey.toBase58(), listingId: id(3), itemId: spec.id,
      sourceBaseId: id(4), priceLamports: '1000000', expectedStatus: 'reserved', expectedReference: remote.quote.reference,
      createdAt: '2026-09-13T00:00:00.000Z', state: 'settled', resolvedAt: '2026-09-13T00:00:10.000Z', refusalCode: null,
      settlement: { reference: remote.quote.reference, txSignature: '2'.repeat(88), buyer: seller, buyerBaseId: id(9) } };
    await render(); await ready(); await click('REVIEW CANCELLATION'); expect(api.postRaw).not.toHaveBeenCalled(); await click('CONFIRM CANCELLATION');
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('A buyer already paid')); });
    expect(host.textContent).toContain(id(9)); expect(host.textContent).toContain('cancellation did not return the item'); expect(h.wallet.signTransaction).not.toHaveBeenCalled();
  });
  it('preserves legacy buying when the server lacks v1 and the durable journal is known empty', async () => {
    enabled = false; await render(); await ready(); await click('BUY'); await act(async () => { await vi.waitFor(() => expect(h.buy).toHaveBeenCalledTimes(1)); });
    expect(api.postRaw).not.toHaveBeenCalled();
  });
  it('a stale legacy tab rechecks another tab activation before issuing any old buy', async () => {
    enabled = false; await render(); await ready(); const s = new MarketJournalStore(marketIdentity(buyer.publicKey.toBase58()));
    await s.compareAndSet(0, (r) => ({ ...r, activated: true })); await s.close(); await click('BUY');
    expect(h.buy).not.toHaveBeenCalled(); expect(api.postRaw).not.toHaveBeenCalled();
  });
});

describe('market page lifetime around real signing', () => {
  function switchVisibility(): void {
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
  }
  it('invalidates a fee review hidden during deferred preparation', async () => {
    await render(); await reserve(); const waiting = deferred<{ blockhash: string; lastValidBlockHeight: number }>();
    h.connection.getLatestBlockhash.mockReturnValueOnce(waiting.promise); await click('REVIEW NETWORK FEE');
    await act(async () => { await vi.waitFor(() => expect(h.connection.getLatestBlockhash).toHaveBeenCalledTimes(1)); switchVisibility(); });
    await act(async () => waiting.resolve({ blockhash, lastValidBlockHeight: 1 }));
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('page changed')); });
    expect(h.wallet.signTransaction).not.toHaveBeenCalled(); expect(host.textContent).not.toContain('Estimated network fee');
  });
  it('invalidates a Pay click hidden during its pre-sign receipt read', async () => {
    await render(); await reserve(); await click('REVIEW NETWORK FEE');
    await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('Estimated network fee')); });
    const waiting = deferred<unknown>(); const originalGet = vi.mocked(api.get).getMockImplementation()!; let blocked = false;
    vi.mocked(api.get).mockImplementation((path, options) => {
      if (path.startsWith('/market/v1/reservations/by-key/')) { blocked = true; return waiting.promise; }
      return originalGet(path, options);
    });
    await click('PAY 0.001 SOL + NETWORK FEE'); await act(async () => { await vi.waitFor(() => expect(blocked).toBe(true)); switchVisibility(); });
    await act(async () => waiting.resolve(remote)); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('page changed')); });
    expect(h.wallet.signTransaction).not.toHaveBeenCalled(); expect((await saved()).purchase?.attempted).toBe(false);
  });
  it('allows a deliberate sign-only wallet handoff to hide and return, then checks fresh proof before sending', async () => {
    h.wallet.signTransaction = vi.fn(async (tx: Transaction) => { switchVisibility(); tx.sign(buyer); return tx; });
    await render(); await reserve(); await click('REVIEW NETWORK FEE'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('Estimated network fee')); });
    await click('PAY 0.001 SOL + NETWORK FEE'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('Payment settled')); });
    expect(h.wallet.signTransaction).toHaveBeenCalledTimes(1); expect(h.connection.sendRawTransaction).toHaveBeenCalledTimes(1);
  });
  it('pagehide during a wallet response always invalidates sending while preserving its public signature', async () => {
    h.wallet.signTransaction = vi.fn(async (tx: Transaction) => { window.dispatchEvent(new Event('pagehide')); tx.sign(buyer); return tx; });
    await render(); await reserve(); await click('REVIEW NETWORK FEE'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('Estimated network fee')); });
    await click('PAY 0.001 SOL + NETWORK FEE'); await act(async () => { await vi.waitFor(() => expect(host.textContent).toContain('page changed')); });
    expect((await saved()).purchase?.signature).not.toBeNull(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});


describe('reported terminal receipt market soft-lock', () => {
  it('returns to trading while preserving signed evidence across reopening and a fresh purchase', async () => {
    own = true;
    remote = { ...remote, state: 'superseded', payable: false, resolvedAt: '2026-09-13T00:05:00.000Z' };
    const original = { receipt: structuredClone(remote), attempted: true, signature: '2'.repeat(88), hydrated: null };
    const store = new MarketJournalStore(marketIdentity(buyer.publicKey.toBase58()));
    await store.compareAndSet(0, (old) => ({ ...old, activated: true, purchase: original })); await store.close();
    await render(); await act(async () => { await vi.waitFor(() => expect(buttons().find((b) => b.textContent === 'BACK TO MARKET')?.disabled).toBe(false)); });
    expect(buttons().find((b) => b.textContent === 'BUY')?.disabled).toBe(true);
    expect(buttons().find((b) => b.textContent === 'REVIEW CANCELLATION')?.disabled).toBe(true);
    expect(buttons().some((b) => b.textContent === 'CHECK ORIGINAL PAYMENT')).toBe(false);
    await click('BACK TO MARKET'); await ready();
    expect(host.querySelector('[aria-label="Saved market request"]')).toBeNull();
    expect((await saved()).archivedPurchases).toEqual([original]); expect((await saved()).purchase).toBeNull();
    expect(buttons().find((b) => b.textContent === 'REVIEW CANCELLATION')?.disabled).toBe(false);
    await click('REVIEW CANCELLATION'); expect(host.textContent).toContain('CONFIRM CANCELLATION'); await click('BACK');
    await click('SELL'); expect(buttons().find((b) => b.textContent === 'LIST')?.disabled).toBe(false); await click('LIST');
    expect(host.textContent).toContain('CONFIRM LISTING'); await click('BACK');
    expect(api.postRaw).not.toHaveBeenCalled(); expect(h.wallet.signTransaction).not.toHaveBeenCalled(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
    await act(async () => root.unmount()); root = createRoot(host); await render(); await ready();
    const history = host.querySelector<HTMLDetailsElement>('[aria-label="Saved market receipts"]')!;
    expect(history).not.toBeNull(); expect(history.textContent).toContain('does not verify a payment or issue a refund');
    expect(history.textContent).toContain(original.receipt.quote.reservationId); expect(history.textContent).toContain('support@pixelkingdomwars.com');
    expect(history.querySelector('a')?.href).toContain(original.signature);
    remote = receipt(); remote.quote = { ...remote.quote, reservationId: id(21), reference: seller };
    await reserve();
    expect((await saved()).purchase?.receipt.quote.idempotencyKey).not.toBe(original.receipt.quote.idempotencyKey);
    expect((await saved()).purchase?.signature).toBeNull(); expect((await saved()).archivedPurchases).toEqual([original]);
    expect(api.postRaw).toHaveBeenCalledTimes(1); expect(h.wallet.signTransaction).not.toHaveBeenCalled(); expect(h.connection.sendRawTransaction).not.toHaveBeenCalled();
  });
});
