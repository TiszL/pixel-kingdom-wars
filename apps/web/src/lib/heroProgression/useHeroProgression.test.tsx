/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { HeroProgressionProvider } from '../../ui/HeroProgression';
import { api } from '../api';
import { heroProgressionIdentity } from './browser';
import { useHeroProgressionView, type HeroProgressionView } from './context';
import { id, identity, proof, upgrade } from './fixtures.test-support';
import { HeroProgressionJournalStore } from './journal';

const gate = vi.hoisted(() => ({ allowed: true, listeners: new Set<() => void>() }));
vi.mock('../mutationGate', () => ({ mutationGate: {
  getSnapshot: () => gate.allowed,
  subscribe: (fn: () => void) => { gate.listeners.add(fn); return () => gate.listeners.delete(fn); },
} }));
let host: HTMLDivElement, root: Root, value: HeroProgressionView, accepted: boolean, owned: boolean, visible: DocumentVisibilityState;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const until = (check: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); await check(); });
function Probe() { value = useHeroProgressionView()!; return <span>{value.state.review ? 'review' : 'no review'}</span>; }
const mount = async (allowed = true, strict = false) => {
  const children = <HeroProgressionProvider actionsEnabled={allowed}><Probe /></HeroProgressionProvider>;
  await act(async () => root.render(strict ? <StrictMode>{children}</StrictMode> : children));
  await until(() => expect(value.state.loaded && !value.state.busy).toBe(true));
};
const saved = async () => { const store = new HeroProgressionJournalStore(heroProgressionIdentity(identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const run = async (action: Parameters<HeroProgressionView['run']>[0]) => { await act(async () => value.run(action)); await until(() => expect(value.state.busy).toBe(false)); };
const begin = () => run(c => c.begin(upgrade));
const balances = { gems: '100', keep: '100', shards: '500', keepRate: 1, features: { gems: { version: 1, receipts: 1 }, gameCurrency: { version: 1, exactSpendCurrency: 1 } } };
const heroes = () => ({ keepLevel: 5, keepBalance: '100', features: { heroConsent: { version: 1 }, heroReceipts: { version: 1 } }, heroes: [{ hero: upgrade.hero,
  recruited: true, level: 1, available: true, recoveryUntil: null, recoveryFinishNow: null, next: { level: 2, costKeep: '100' } }] });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (key: string, _options: unknown, fn: (lock: object | null) => Promise<unknown>) => {
    if (held.has(key)) return fn(null); held.add(key); try { return await fn({}); } finally { held.delete(key); }
  } } });
  visible = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  gate.allowed = true; accepted = false; owned = true;
  useApp.getState().setAuth(identity.wallet, true); useApp.setState({ screen: 'build', selectedBaseId: id(1), baseSelectionEpoch: 0, selectedBuildingId: null, buildCategory: 'her' });
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path.includes('/receipt?')) {
      const params = new URL(path, 'https://test.invalid').searchParams;
      return proof({ ...upgrade, idempotencyKey: params.get('idempotencyKey')! }, accepted) as never;
    }
    if (path === '/me') return { wallet: identity.wallet } as never;
    if (path === '/bases') return { enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: owned ? [{ id: id(1), status: 'active', slot: 1 }] : [] } as never;
    if (path.startsWith('/base?')) return { baseId: id(1), player: { wallet: identity.wallet, keepLevel: 5 }, buildings: [], army: [], jobs: [], obstacles: [], heroes: heroes().heroes } as never;
    if (path.startsWith('/balances?')) return balances as never;
    if (path.startsWith('/heroes?')) return heroes() as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.spyOn(api, 'postRaw').mockImplementation(async (_path, body, options) => {
    options?.isCurrent?.(); const op = (await saved()).operation!;
    expect(op.attempted).toBe(true); expect(op.intent.expectedCurrency).toBe(options?.expectedCurrency);
    expect((body as { idempotencyKey: string }).idempotencyKey).toBe(op.intent.idempotencyKey); accepted = true; return {} as never;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(navigator, 'locks'); Reflect.deleteProperty(document, 'visibilityState'); useApp.getState().setAuth(null); });

it('StrictMode and foreground never POST; one provider restores only original evidence', async () => {
  await mount(true, true); await act(async () => window.dispatchEvent(new Event('focus')));
  await until(() => expect(value.state.busy).toBe(false)); expect(api.postRaw).not.toHaveBeenCalled();
  await begin(); expect(value.state.review?.expectedCurrency).toBe('GEMS');
  expect((await saved()).operation?.attempted).toBe(false);
});
it('cancel during pre-POST reads clears busy after the action settles and retains an unsent original draft', async () => {
  await mount(); await begin(); const hold = deferred<unknown>(), entered = deferred<void>(), read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (path.includes('/receipt?')) { entered.resolve(); await hold.promise; } return read(path, options);
  });
  await act(async () => value.run(c => c.confirm())); await entered.promise;
  await act(async () => value.dismiss()); expect(value.state.review).toBeNull();
  await act(async () => hold.resolve(null)); await until(() => expect(value.state.busy).toBe(false));
  expect(api.postRaw).not.toHaveBeenCalled(); expect((await saved()).operation?.attempted).toBe(false);
  await run(c => c.reviewCommand()); expect(value.state.review).not.toBeNull();
});
it.each(['navigation', 'base', 'gate', 'freeze', 'wallet'] as const)('late actual transport refuses after %s and never replaces the marked original command', async change => {
  await mount(); await begin(); const entered = deferred<void>(), hold = deferred<void>(); let transported = 0;
  vi.mocked(api.postRaw).mockImplementation(async (_path, _body, options) => { entered.resolve(); await hold.promise; options?.isCurrent?.(); transported++; return {} as never; });
  await act(async () => value.run(c => c.confirm())); await entered.promise; const original = (await saved()).operation;
  await act(async () => {
    if (change === 'navigation') useApp.setState({ selectedBuildingId: id(9) });
    if (change === 'base') useApp.setState({ baseSelectionEpoch: 1 });
    if (change === 'gate') { gate.allowed = false; gate.listeners.forEach(fn => fn()); }
    if (change === 'freeze') { visible = 'hidden'; document.dispatchEvent(new Event('freeze')); }
    if (change === 'wallet') useApp.getState().setAuth('22222222222222222222222222222222', true);
  });
  await act(async () => hold.resolve()); await until(() => expect(transported).toBe(0));
  expect((await saved()).operation).toEqual(original);
});
it('lost acknowledgement recovers with GET after remount even with admissions closed and original base sold', async () => {
  await mount(); await begin(); vi.mocked(api.postRaw).mockImplementation(async () => { accepted = true; throw new Error('reply lost'); });
  await run(c => c.confirm()); await act(async () => root.render(null)); owned = false;
  useApp.setState({ selectedBaseId: null }); await mount(false);
  expect(value.state.journal?.operation?.proof?.status).toBe('accepted'); expect(value.snapshot).toBeNull();
  expect(host.textContent).toContain('HERO PAYMENTS & RECEIPTS');
  await act(async () => value.openHistory()); await until(() => expect(value.state.busy).toBe(false));
  const panel = document.querySelector('[aria-label="Hero payment recovery"]')!;
  expect(panel.textContent).toContain('ORIGINAL PAYMENT CONFIRMED'); expect(panel.textContent).toContain(id(1));
  expect(panel.textContent).toContain('historical payment evidence'); expect(panel.textContent).toContain('New Hero payments are paused');
  await run(c => c.finish()); expect(value.state.journal?.archives[0]?.reason).toBe('accepted'); expect(api.postRaw).toHaveBeenCalledOnce();
  expect(panel.textContent).toContain('HERO PAYMENT HISTORY (1)');
});
it('unmount waits for a pending first-refusal journal write before closing its database', async () => {
  const closes = vi.spyOn(HeroProgressionJournalStore.prototype, 'close'), writes = vi.spyOn(HeroProgressionJournalStore.prototype, 'compareAndSet');
  await mount(); await begin(); const originalStore = writes.mock.contexts[0]!, entered = deferred<void>(), hold = deferred<void>();
  const { ApiError } = await import('../api');
  vi.mocked(api.postRaw).mockImplementation(async () => { entered.resolve(); await hold.promise; throw new ApiError(409, 'changed', 'HERO_PRICE_CHANGED'); });
  await act(async () => value.run(c => c.confirm())); await entered.promise;
  await act(async () => root.render(null)); expect(closes.mock.contexts).not.toContain(originalStore);
  await act(async () => hold.resolve()); await until(() => expect(closes.mock.contexts).toContain(originalStore));
  expect((await saved()).operation?.refusal?.code).toBe('HERO_PRICE_CHANGED');
  await mount(false); await run(c => c.finish()); expect(value.state.journal?.archives[0]?.reason).toBe('refused'); expect(api.postRaw).toHaveBeenCalledOnce();
});
it('Escape closes the actual currency dialog without abandoning the draft or paying', async () => {
  await mount(); await act(async () => value.begin(upgrade)); await until(() => expect(value.state.review && !value.state.busy).toBeTruthy());
  const dialog = document.querySelector('[aria-label="Confirm Hero payment"]');
  expect(dialog?.textContent).toContain('UP TO 100'); expect(dialog?.textContent).toContain('GEMS');
  expect(dialog?.textContent).not.toContain("DON'T ASK");
  const original = (await saved()).operation;
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => expect(value.state.busy).toBe(false));
  expect(document.querySelector('[aria-label="Confirm Hero payment"]')).toBeNull();
  expect((await saved()).operation).toEqual(original); expect(api.postRaw).not.toHaveBeenCalled();
  expect(host.textContent).toContain('HERO PAYMENTS & RECEIPTS');
});
it('a typed first refusal has its own visible archive action, while a pause disables a new review only', async () => {
  await mount(); await act(async () => value.begin(upgrade)); await until(() => expect(value.state.review && !value.state.busy).toBeTruthy());
  const { ApiError } = await import('../api');
  vi.mocked(api.postRaw).mockRejectedValue(new ApiError(409, 'price changed', 'HERO_PRICE_CHANGED'));
  await run(c => c.confirm()); await mount(false);
  expect(document.body.textContent).toContain('ORIGINAL PAYMENT DECLINED');
  const button = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'ARCHIVE DECLINED REQUEST')!;
  expect(button.disabled).toBe(false); await act(async () => button.click()); await until(() => expect(value.state.busy).toBe(false));
  expect(value.state.journal?.archives[0]?.reason).toBe('refused'); expect(api.postRaw).toHaveBeenCalledOnce();
});
