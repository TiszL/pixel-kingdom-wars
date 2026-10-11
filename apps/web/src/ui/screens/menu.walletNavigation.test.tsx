/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { GemsJournalStore } from '../../lib/gems/journal';
import { gemsIdentity } from '../../lib/gems/browser';
import { intent as originalGemsIntent, identity as gemsFixtureIdentity, base as gemsBase, overview as gemsOverview, proof as gemsProof } from '../../lib/gems/fixtures.test-support';
import { createMobileBackGuard, type MobileBackHistory, type MobileBackWindow } from '../../lib/mobileBackGuard';
import { useApp } from '../../state/store';
import { ExchangeScreen, ForgeScreen, MarketScreen, ShopScreen } from './menu';

vi.mock('./exportKey', () => ({ PRIVY_ENABLED: false, ExportKeySection: () => null }));
vi.mock('../../auth/useGameWallet', () => ({ useGameWallet: () => ({ publicKey: null, signMessage: null, sendTransaction: null, isEmbedded: false }) }));
vi.mock('../sheets', () => ({ reloadBase: vi.fn() }));
vi.mock('../../lib/audio', () => ({ playSfx: vi.fn() }));
vi.mock('../../lib/juice', () => ({ haptic: vi.fn() }));

function Screens(): React.JSX.Element {
  const screen = useApp(state => state.screen);
  return screen === 'exchange' ? <ExchangeScreen /> : screen === 'forge' ? <ForgeScreen />
    : screen === 'market' ? <MarketScreen /> : screen === 'shop' ? <ShopScreen />
      : screen === 'inventory' ? <button onClick={() => useApp.getState().setScreen('shop')}>OPEN SHOP</button> : <p>BASE CAMP</p>;
}

// Real ScrollPage/ModalWrap handlers, with deterministic browser history only.
class BackWindow extends EventTarget implements MobileBackWindow {
  readonly location = { href: 'https://play.pixelkingdomwars.com/' };
  private state: unknown = null;
  readonly history: MobileBackHistory;
  constructor() {
    super();
    const owner = this;
    this.history = {
      get state() { return owner.state; },
      pushState(data) { owner.state = data; },
      back() { owner.state = null; owner.dispatchEvent(new Event('popstate')); },
    };
  }
  setTimeout(handler: () => void, timeout: number): number { return window.setTimeout(handler, timeout); }
  clearTimeout(id: number): void { window.clearTimeout(id); }
}

let root: Root;
let host: HTMLDivElement;
const destinations = [['forge', 'GOLD FORGE'], ['market', 'COLLECTION & MARKET']] as const;
const close = async () => { await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Close"]')!.click()); };
async function open(label: string) {
  const text = [...host.querySelectorAll('span')].find(node => node.textContent === label);
  expect(text, `wallet link ${label}`).toBeDefined();
  await act(async () => (text!.closest('.interactive') as HTMLElement).click());
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useApp.getState().setAuth('wallet-navigation', true);
  useApp.getState().setScreen('exchange');
  useApp.getState().setBalances({ keep: '20', shards: '1000', keepRate: 1 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path.startsWith('/forge')) return {
      day: '2026-09-08', cycleEndsInSec: 100, dailyEmissionKeep: 100, softCapShards: 1000,
      maxDailyShareBps: 1000, totalShards: '0', myShards: '0', myShardBalance: '1000',
      goldforgeLevel: 1, myDailyCapShards: '1000', drops: { independentDropBps: {} },
      claimable: { count: 0, totalKeep: '0', days: [], nextExpiresAt: null }, yesterday: null,
    };
    if (path.startsWith('/balances')) return { keep: '20', shards: '1000', keepRate: 1 };
    if (path === '/market/collection') return { collection: null, links: null, feeBps: 500, tradingEnabled: false };
    if (path === '/market/assets') return { assets: [], dasConfigured: false, tradingEnabled: false };
    if (path.startsWith('/market/listings')) return { listings: [], summary: [], feeBps: 500 };
    if (path.startsWith('/items')) return { catalog: [], owned: [] };
    throw new Error(`Unexpected navigation read: ${path}`);
  });
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); useApp.getState().setAuth(null);
});

it.each(destinations)('returns %s to its wallet parent without making later direct entry return there', async (screen, label) => {
  await act(async () => root.render(<Screens />));
  await open(label);
  expect(useApp.getState().screen).toBe(screen);
  // Reasserting the active screen must not erase its mount's origin.
  await act(async () => useApp.getState().setScreen(screen));
  await close();
  expect(host.textContent).toContain('KEEP WALLET');
  await act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === 'CLOSE')!.click());
  expect(host.textContent).toBe('BASE CAMP');
  await act(async () => useApp.getState().setScreen(screen));
  await close();
  expect(host.textContent).toBe('BASE CAMP');
  await act(async () => useApp.getState().setScreen('exchange'));
  await open(label); await close();
  expect(host.textContent).toContain('KEEP WALLET');
});

it.each(destinations)('uses the same parent for Android Back from %s', async (screen, label) => {
  await act(async () => root.render(<Screens />)); await open(label);
  const win = new BackWindow();
  const dispose = createMobileBackGuard({ win, enabled: true, trustedActivation: () => true,
    getScreen: () => useApp.getState().screen, goToBase: () => useApp.getState().setScreen('base'), toast: vi.fn() });
  try {
    win.dispatchEvent(new Event('pointerdown'));
    await act(async () => win.history.back());
    expect(useApp.getState().screen).toBe('exchange');
    await act(async () => win.history.back());
    expect(useApp.getState().screen).toBe('base');
    await act(async () => useApp.getState().setScreen(screen));
    await act(async () => win.history.back());
    expect(useApp.getState().screen).toBe('base');
  } finally { dispose(); }
});

it('keeps the wallet parent when Forge becomes land-locked while open', async () => {
  await act(async () => root.render(<Screens />)); await open('GOLD FORGE');
  await act(async () => useApp.getState().setEntryPaid(false));
  await close();
  expect(host.textContent).toContain('KEEP WALLET');
  expect(useApp.getState().entryPaid).toBe(false);
});

it('returns deedless market browsing to its wallet instead of the base', async () => {
  useApp.getState().setEntryPaid(false);
  await act(async () => root.render(<Screens />)); await open('BROWSE THE MARKET');
  await close(); expect(host.textContent).toContain('KEEP WALLET');
});

it('does not carry a previous account wallet origin into another account', async () => {
  await act(async () => root.render(<Screens />)); await open('GOLD FORGE');
  await act(async () => useApp.getState().setAuth('another-wallet', true));
  await close(); expect(host.textContent).toBe('BASE CAMP');
});


it('Shop offers a labelled Back to Inventory and preserves its origin for Close and Android Back', async () => {
  useApp.getState().setScreen('inventory');
  await act(async () => root.render(<Screens />));
  const openShop = async () => act(async () => host.querySelector('button')!.click());
  await openShop();
  const back = [...host.querySelectorAll('button')].find(button => button.textContent?.includes('BACK TO INVENTORY'));
  expect(back).toBeDefined();
  await act(async () => back!.click());
  expect(useApp.getState().screen).toBe('inventory');
  await openShop(); await close();
  expect(useApp.getState().screen).toBe('inventory');
  await openShop();
  const win = new BackWindow();
  const dispose = createMobileBackGuard({ win, enabled: true, trustedActivation: () => true,
    getScreen: () => useApp.getState().screen, goToBase: () => useApp.getState().setScreen('base'), toast: vi.fn() });
  try {
    win.dispatchEvent(new Event('pointerdown'));
    await act(async () => win.history.back());
    expect(useApp.getState().screen).toBe('inventory');
  } finally { dispose(); }
});

it('direct Shop entry and a new account cannot inherit Inventory as their parent', async () => {
  useApp.getState().setScreen('inventory'); useApp.getState().setScreen('shop');
  await act(async () => root.render(<Screens />));
  await act(async () => useApp.getState().setAuth('other-shop-wallet', true));
  await close(); expect(useApp.getState().screen).toBe('base');
  await act(async () => useApp.getState().setScreen('shop'));
  expect(host.textContent).toContain('BACK TO BASE');
  await close(); expect(useApp.getState().screen).toBe('base');
});

it('Gems wallet requires the supported capability and stays open when a pause removes it during recovery', async () => {
  useApp.getState().setBalances({ keep: '20', shards: '1000', keepRate: 1, gems: '30', features: { gems: { version: 1, receipts: 1 } } });
  await act(async () => root.render(<Screens />));
  const dialog = host.querySelector('[role="dialog"][aria-label="Gems wallet"]');
  expect(dialog).not.toBeNull();
  await act(async () => useApp.getState().setBalances({ keep: '20', shards: '1000', keepRate: 1 }));
  // A capability pause must retain the same recovery mount, not replace its visible title.
  expect(host.querySelector('[role="dialog"][aria-label="Gems wallet"]')).toBe(dialog);
  await act(async () => dialog!.querySelector<HTMLButtonElement>('button[aria-label="Close Gems wallet"]')!.click());
  expect(host.textContent).toBe('BASE CAMP');
  await act(async () => useApp.getState().setScreen('exchange'));
  expect(host.textContent).toContain('KEEP WALLET');
});

it('unknown Gems receipt versions retain the legacy KEEP wallet and do not fetch a new catalogue', async () => {
  useApp.getState().setBalances({ keep: '20', shards: '1000', keepRate: 1, gems: '30', features: { gems: { version: 1, receipts: 2 } } });
  await act(async () => root.render(<Screens />));
  expect(host.textContent).toContain('KEEP WALLET');
  expect(host.querySelector('[role="dialog"][aria-label="Gems wallet"]')).toBeNull();
  expect(vi.mocked(api.get).mock.calls.some(([path]) => path === '/gems')).toBe(false);
});

it('opens a truthful held Gems balance and recovery door without entering a fresh wallet flow', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); vi.stubGlobal('indexedDB', new IDBFactory());
  try {
    useApp.setState({ balances: { keep: '500', gems: '12', shards: '1000', keepRate: 1, features: { gems: { version: 1, receipts: 1 } } } as never });
    await act(async () => root.render(<ExchangeScreen />));
    expect(host.textContent).toContain('GEMS BALANCE'); expect(host.textContent).toContain('12');
    expect(host.textContent).not.toContain('500'); expect(host.textContent).not.toContain('REVIEW CONVERSION');
    expect(host.querySelector('input')).toBeNull();
    expect(vi.mocked(api.get).mock.calls.some(([path]) => path === '/gems')).toBe(false);
  } finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
});

// c71e75e7 B1: retained wallet scenarios opt into the admitted web build.
beforeEach(() => vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
const heldBalances = () => ({ keep: '500', gems: '12', shards: '1000', keepRate: 1, features: { gems: { version: 1, receipts: 1 } } });
it.each([['WITHDRAW CUSTODIAL KEEP', 'withdraw'], ['CONNECTED WALLET', 'profile']] as const)
('keeps the held %s route without showing a stale KEEP balance', async (label, screen) => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); vi.stubGlobal('indexedDB', new IDBFactory());
  useApp.setState({ balances: heldBalances() }); await act(async () => root.render(<ExchangeScreen />));
  expect(host.textContent).toContain('12'); expect(host.textContent).not.toContain('500');
  expect(host.textContent).toContain('Available in the Android app for now.');
  const route = [...host.querySelectorAll('button')].find(b => b.textContent === label)!; expect(route).toBeDefined();
  act(() => route.click()); expect(useApp.getState().screen).toBe(screen);
});
it('keeps custodial withdrawal absent for a deedless player while held', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); vi.stubGlobal('indexedDB', new IDBFactory());
  useApp.setState({ entryPaid: false, balances: heldBalances() }); await act(async () => root.render(<ExchangeScreen />));
  expect(host.textContent).not.toContain('WITHDRAW CUSTODIAL KEEP'); expect(host.textContent).toContain('CONNECTED WALLET');
  expect(host.textContent).not.toContain('500');
});
it('discovers a saved paid journal from held Exchange and opens its original recovery', async () => {
  vi.stubEnv('VITE_PHASE_E_WEB_ENABLED', '0'); const factory = new IDBFactory(); vi.stubGlobal('indexedDB', factory);
  vi.stubGlobal('navigator', { userAgent: 'held-exchange', locks: { request: async (_name: string, _options: unknown, callback: (lock: object) => Promise<unknown>) => callback({}) } });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(gemsFixtureIdentity.wallet, true); useApp.getState().setScreen('exchange');
  useApp.getState().setSelectedBaseId(gemsBase, false); useApp.getState().setBalances(heldBalances());
  const original = originalGemsIntent(); const journal = new GemsJournalStore(gemsIdentity(gemsFixtureIdentity.wallet), factory);
  await journal.compareAndSet(0, saved => ({ ...saved, intent: original, attempted: true })); await journal.close();
  const priorGet = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (path === '/gems') return gemsOverview() as never;
    if (path.includes('/by-key/')) return gemsProof(original) as never;
    if (path === '/me') return { wallet: gemsFixtureIdentity.wallet, entryPaid: true } as never;
    if (path === '/bases') return { enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: [{ id: gemsBase, status: 'active', slot: 1 }] } as never;
    if (path.startsWith('/balances')) return heldBalances() as never;
    return priorGet(path, options);
  });
  const post = vi.spyOn(api, 'postRaw').mockRejectedValue(Error('recovery must only observe'));
  await act(async () => root.render(<ExchangeScreen />)); expect(host.textContent).toContain('GEMS BALANCE');
  await act(async () => vi.waitFor(() => expect(host.textContent).toContain('CHECK SAVED GEMS REQUEST')));
  await act(async () => [...host.querySelectorAll('button')].find(b => b.textContent === 'CHECK SAVED GEMS REQUEST')!.click());
  await act(async () => vi.waitFor(() => expect(host.textContent).toContain('Original receipt confirmed: +20 GEMS')));
  expect(host.querySelector('[role="dialog"][aria-label="Gems wallet"]')).not.toBeNull(); expect(post).not.toHaveBeenCalled();
  expect(host.textContent).not.toContain('REVIEW CONVERSION'); expect(host.querySelector('[aria-label="KEEP amount"]')).toBeNull();
  const check = new GemsJournalStore(gemsIdentity(gemsFixtureIdentity.wallet), factory);
  try { expect((await check.read()).finished).toBe(true); } finally { await check.close(); }
});
