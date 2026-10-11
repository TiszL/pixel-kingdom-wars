/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { useApp } from '../../state/store';
import { buyer, id, seller, treasury } from '../../lib/market/fixtures.test-support';
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
let host: HTMLDivElement; let root: Root;
const spec = { id: 'iron_sword', name: 'Iron Sword', kind: 'gear', costKeep: 0, asset: '', desc: 'Knuckle plates made to split masonry.', rarity: 'common', weight: 1, acquisition: { type: 'shop' }, maxOwned: null };
/** Two listings: a named seller (server-computed sellerName) and one from an API
 *  build that predates the field, whose 4…4 fallback the client must derive itself. */
const NAMED = 'Arc69';
const anon = treasury;
const short = (w: string): string => `${w.slice(0, 4)}…${w.slice(-4)}`;
function buttons(): HTMLButtonElement[] { return [...host.querySelectorAll('button')]; }
async function ready(): Promise<void> { await act(async () => { await vi.waitFor(() => expect(buttons().find((b) => b.textContent === 'BUY')?.disabled).toBe(false)); }); }
async function render(): Promise<void> { await act(async () => root.render(<MarketScreen />)); }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, fn: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return fn(null); held.add(name); try { return await fn({ name }); } finally { held.delete(name); }
  } } });
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  h.buy.mockReset(); h.wallet = { publicKey: buyer.publicKey, signMessage: null, sendTransaction: vi.fn(), isEmbedded: false, signTransaction: vi.fn() };
  useApp.getState().setAuth(buyer.publicKey.toBase58(), true); useApp.setState({ selectedBaseId: id(5), baseSelectionEpoch: 1 });
  vi.spyOn(api, 'get').mockImplementation(async (path) => {
    if (path === '/market/collection') return { collection: null, links: null, feeBps: 500, tradingEnabled: false };
    if (path === '/market/assets') return { assets: [], tradingEnabled: false };
    if (path === '/market/purchases/pending') return { purchases: [], next: null };
    if (path === '/market/trades') return { trades: [], hasMore: false };
    if (path.endsWith('/listings/mine')) return { listings: [] };
    if (path.startsWith('/market/listings')) return { feeBps: 500, listings: [
      { id: id(3), itemId: spec.id, baseId: null, seller, sellerName: NAMED, priceLamports: '1000000' },
      { id: id(7), itemId: spec.id, baseId: null, seller: anon, priceLamports: '2000000' },
    ], summary: [{ itemId: spec.id, floorLamports: '1000000', listed: 2 }] };
    if (path.startsWith('/items')) return { catalog: [spec], owned: [], heroLoadouts: [] };
    if (path === '/me') return { wallet: buyer.publicKey.toBase58(), entryPaid: true };
    if (path === '/bases') return { enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: id(5), status: 'active', slot: 1 }] };
    if (path.startsWith('/balances')) return { keep: '4', shards: '5', keepRate: 1 };
    throw new Error(path);
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  Reflect.deleteProperty(document, 'visibilityState'); vi.restoreAllMocks(); vi.unstubAllGlobals(); useApp.getState().setAuth(null);
});
describe('market listing cards (tester ef22cdb7)', () => {
  it('does not offer owned crafted ingots on the SOL market while ordinary loose items remain sellable', async () => {
    // Owned craft stock remains discoverable when refining is paused, but must
    // never advertise the SOL exit that the authoritative listing gate forbids.
    const get = vi.mocked(api.get).getMockImplementation()!;
    vi.mocked(api.get).mockImplementation(async (path, ...args) => {
      if (path.startsWith('/items')) return {
        catalog: [spec, { ...spec, id: 'forge_ingot', name: 'FORGE INGOT', kind: 'material', acquisition: { type: 'craft' } }],
        owned: [{ itemId: spec.id, qty: 1 }, { itemId: 'forge_ingot', qty: 1 }], heroLoadouts: [],
      };
      return get(path, ...args);
    });
    await render(); await ready();
    expect(host.textContent).not.toContain('FORGE INGOT');
    expect(buttons().filter((button) => button.textContent === 'SELL')).toHaveLength(1);
  });

  it('keeps the item description behind a per-card INFO toggle so the grid stays scannable', async () => {
    // WHY: a 118px card carrying a two-line blurb per listing buried the price and
    // the buy button (tester screenshot); the description is opt-in per card.
    await render(); await ready();
    expect(host.textContent).not.toContain(spec.desc);
    const info = buttons().filter((b) => b.textContent === 'INFO');
    expect(info).toHaveLength(2);
    expect(info.every((b) => b.getAttribute('aria-expanded') === 'false')).toBe(true);
    await act(async () => info[0]!.click());
    expect(host.textContent.split(spec.desc).length - 1).toBe(1);
    expect(buttons().filter((b) => b.textContent === 'INFO')[0]!.getAttribute('aria-expanded')).toBe('true');
    await act(async () => buttons().filter((b) => b.textContent === 'INFO')[0]!.click());
    expect(host.textContent).not.toContain(spec.desc);
  });
  it('shows who is selling as the public name, falling back to the 4…4 wallet, never the full address', async () => {
    await render(); await ready();
    expect(host.textContent).toContain(`BY ${NAMED}`);
    expect(host.textContent).toContain(`BY ${short(anon)}`);
    expect(host.textContent).not.toContain(anon);
    expect(host.textContent).not.toContain(seller);
  });
});
