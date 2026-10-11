/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { BasesView } from '../../ui/screens/bases';
import { BuilderJobSpeedupProvider } from '../../ui/BuilderJobSpeedup';
import { api } from '../api';
import { KEEP_CONFIRM_KEY } from '../keepConfirm';
import { builderJobSpeedupIdentity } from './browser';
import { useBuilderJobSpeedupView, type BuilderJobSpeedupView } from './context';
import { id, identity, proof, builder } from './fixtures.test-support';
import { BuilderJobSpeedupJournalStore } from './journal';

const gate = vi.hoisted(() => ({ allowed: true, listeners: new Set<() => void>() }));
vi.mock('../mutationGate', () => ({ mutationGate: {
  getSnapshot: () => gate.allowed,
  subscribe: (fn: () => void) => { gate.listeners.add(fn); return () => gate.listeners.delete(fn); },
} }));
let host: HTMLDivElement, root: Root, value: BuilderJobSpeedupView, accepted: boolean, owned: boolean, visible: DocumentVisibilityState;
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const until = (check: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(r => setTimeout(r, 0)); }); await check(); });
function Probe() { value = useBuilderJobSpeedupView()!; return <button onClick={value.openHistory}>BUILDER PAYMENTS & RECEIPTS</button>; }
const mount = async (allowed = true, strict = false) => {
  const children = <BuilderJobSpeedupProvider actionsEnabled={allowed}><Probe /></BuilderJobSpeedupProvider>;
  await act(async () => root.render(strict ? <StrictMode>{children}</StrictMode> : children));
  await until(() => expect(value.state.loaded && !value.state.busy).toBe(true));
};
const saved = async () => { const store = new BuilderJobSpeedupJournalStore(builderJobSpeedupIdentity(identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const run = async (action: Parameters<BuilderJobSpeedupView['run']>[0]) => { await act(async () => value.run(action)); await until(() => expect(value.state.busy).toBe(false)); };
const begin = () => run(c => c.begin(builder));
const balances = { gems: '100', keep: '100', shards: '500', keepRate: 1, features: { gems: { version: 1, receipts: 1 }, gameCurrency: { version: 1, exactSpendCurrency: 1 } } };
const base = () => ({ baseId: id(1), player: { wallet: identity.wallet, keepLevel: 5 }, buildings: [], army: [], obstacles: [],
  features: { builderJobSpeedup: { version: 1, receipts: 1 } }, jobs: [{ id: builder.jobId, ...builder.consent, finishCostKeep: '100', paidFinishQuote: builder.consent }] });
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (key: string, _options: unknown, fn: (lock: object | null) => Promise<unknown>) => {
    if (held.has(key)) return fn(null); held.add(key); try { return await fn({}); } finally { held.delete(key); }
  } } });
  visible = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visible });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  localStorage.clear(); gate.allowed = true; accepted = false; owned = true;
  useApp.getState().setAuth(identity.wallet, true); useApp.setState({ screen: 'build', selectedBaseId: id(1), baseSelectionEpoch: 0, selectedBuildingId: null, selectedObstacleId: null, buildCategory: 'bld' });
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path.includes('/receipt?')) {
      const params = new URL(path, 'https://test.invalid').searchParams;
      return accepted ? proof((await saved()).operation!.intent, true) as never : proof({ ...builder, idempotencyKey: params.get('idempotencyKey')! }) as never;
    }
    if (path === '/me') return { wallet: identity.wallet } as never;
    if (path === '/bases') return { enabled: true, capabilities: { baseScopedReads: true, baseScopedMutations: true }, bases: owned ? [{ id: id(1), status: 'active', slot: 1 }] : [] } as never;
    if (path.startsWith('/base?')) return base() as never;
    if (path.startsWith('/balances?')) return balances as never;
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
it.each(['navigation', 'obstacle', 'base', 'gate', 'freeze', 'wallet'] as const)('late actual transport refuses after %s and never replaces the marked original command', async change => {
  await mount(); await begin(); const entered = deferred<void>(), hold = deferred<void>(); let transported = 0;
  vi.mocked(api.postRaw).mockImplementation(async (_path, _body, options) => { entered.resolve(); await hold.promise; options?.isCurrent?.(); transported++; return {} as never; });
  await act(async () => value.run(c => c.confirm())); await entered.promise; const original = (await saved()).operation;
  await act(async () => {
    if (change === 'navigation') useApp.setState({ selectedBuildingId: id(9) });
    if (change === 'obstacle') useApp.setState({ selectedObstacleId: id(8) });
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
  expect(host.textContent).toContain('BUILDER PAYMENTS & RECEIPTS');
  await act(async () => value.openHistory()); await until(() => expect(value.state.busy).toBe(false));
  const panel = document.querySelector('[aria-label="Builder payment recovery"]')!;
  expect(panel.textContent).toContain('ORIGINAL PAYMENT CONFIRMED'); expect(panel.textContent).toContain(id(1));
  expect(panel.textContent).toContain('historical payment evidence'); expect(panel.textContent).toContain('New Builder payments are paused');
  await run(c => c.finish()); expect(value.state.journal?.archives[0]?.reason).toBe('accepted'); expect(api.postRaw).toHaveBeenCalledOnce();
  expect(panel.textContent).toContain('BUILDER PAYMENT HISTORY (1)');
});
it('unmount waits for a pending first-refusal journal write before closing its database', async () => {
  const closes = vi.spyOn(BuilderJobSpeedupJournalStore.prototype, 'close'), writes = vi.spyOn(BuilderJobSpeedupJournalStore.prototype, 'compareAndSet');
  await mount(); await begin(); const originalStore = writes.mock.contexts[0]!, entered = deferred<void>(), hold = deferred<void>();
  const { ApiError } = await import('../api');
  vi.mocked(api.postRaw).mockImplementation(async () => { entered.resolve(); await hold.promise; throw new ApiError(409, 'changed', 'BUILDER_SPEEDUP_QUOTE_CHANGED'); });
  await act(async () => value.run(c => c.confirm())); await entered.promise;
  await act(async () => root.render(null)); expect(closes.mock.contexts).not.toContain(originalStore);
  await act(async () => hold.resolve()); await until(() => expect(closes.mock.contexts).toContain(originalStore));
  expect((await saved()).operation?.refusal?.code).toBe('BUILDER_SPEEDUP_QUOTE_CHANGED');
  await mount(false); await run(c => c.finish()); expect(value.state.journal?.archives[0]?.reason).toBe('refused'); expect(api.postRaw).toHaveBeenCalledOnce();
});
it('Escape closes the actual currency dialog without abandoning the draft or paying', async () => {
  await mount(); await act(async () => value.begin(builder)); await until(() => expect(value.state.review && !value.state.busy).toBeTruthy());
  const dialog = document.querySelector('[aria-label="Confirm Builder payment"]');
  expect(dialog?.textContent).toContain('UP TO 100'); expect(dialog?.textContent).toContain('GEMS');
  expect(dialog?.textContent).not.toContain("DON'T ASK");
  const original = (await saved()).operation;
  await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => expect(value.state.busy).toBe(false));
  expect(document.querySelector('[aria-label="Confirm Builder payment"]')).toBeNull();
  expect((await saved()).operation).toEqual(original); expect(api.postRaw).not.toHaveBeenCalled();
  expect(host.textContent).toContain('BUILDER PAYMENTS & RECEIPTS');
});
it('a typed first refusal has its own visible archive action, while a pause disables a new review only', async () => {
  await mount(); await act(async () => value.begin(builder)); await until(() => expect(value.state.review && !value.state.busy).toBeTruthy());
  const { ApiError } = await import('../api');
  vi.mocked(api.postRaw).mockRejectedValue(new ApiError(409, 'price changed', 'BUILDER_SPEEDUP_QUOTE_CHANGED'));
  await run(c => c.confirm()); await mount(false);
  expect(document.body.textContent).toContain('ORIGINAL PAYMENT DECLINED');
  const button = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'ARCHIVE DECLINED REQUEST')!;
  expect(button.disabled).toBe(false); await act(async () => button.click()); await until(() => expect(value.state.busy).toBe(false));
  expect(value.state.journal?.archives[0]?.reason).toBe('refused'); expect(api.postRaw).toHaveBeenCalledOnce();
});

it.each([['100', '0', 'GEMS'], ['99', '100', 'KEEP']] as const)('explicit confirmation uses whole %s Gems / %s KEEP choice: %s', async (gems, keep, currency) => {
  localStorage.setItem(KEEP_CONFIRM_KEY, '0');
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => path.startsWith('/balances?') ? { ...balances, gems, keep } as never : read(path, options));
  await mount(); await act(async () => value.begin(builder)); await until(() => expect(value.state.review && !value.state.busy).toBeTruthy());
  const dialog = document.querySelector('[aria-label="Confirm Builder payment"]')!;
  expect(dialog.textContent).toContain('FINISH UPGRADE'); expect(dialog.textContent).toContain('UP TO 100');
  expect(dialog.textContent).toContain(`only ${currency}`);
  const button = [...dialog.querySelectorAll('button')].find(b => b.textContent === `CONFIRM ${currency}`)!;
  expect(button.disabled).toBe(false);
  await act(async () => button.click()); await until(() => expect(value.state.busy).toBe(false));
  expect(api.postRaw).toHaveBeenCalledOnce(); expect((await saved()).operation?.proof?.status).toBe('accepted');
  expect((await saved()).operation?.intent.expectedCurrency).toBe(currency);
});
it('two individually short balances cannot produce a split-currency review or save a paying command', async () => {
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => path.startsWith('/balances?') ? { ...balances, gems: '99', keep: '99' } as never : read(path, options));
  await mount(); await begin(); expect(value.state.review).toBeNull(); expect(value.state.error).toBeTruthy();
  expect((await saved()).operation).toBeNull(); expect(api.postRaw).not.toHaveBeenCalled();
});

it('the actual no-base selection view opens and archives the original receipt while payments are paused', async () => {
  await mount(); await begin(); await run(c => c.confirm());
  await act(async () => root.render(null)); owned = false; useApp.setState({ screen: 'bases', selectedBaseId: null, base: null });
  await act(async () => root.render(<BuilderJobSpeedupProvider actionsEnabled={false}>
    <BasesView directory={null} selectedBaseId={null} loading={false} busy={false} error="No current kingdom" replaceBaseId={null} canClose={false}
      onClose={() => undefined} onRetry={() => undefined} onOpen={() => undefined} onReplace={() => undefined} onActivate={() => undefined} onBuyDeed={() => undefined} />
  </BuilderJobSpeedupProvider>));
  const door = [...host.querySelectorAll('button')].find(b => b.textContent === 'BUILDER PAYMENTS & RECEIPTS')!;
  expect(door.disabled).toBe(false); await act(async () => door.click());
  await until(() => expect(document.querySelector('[aria-label="Builder payment recovery"]')?.textContent).toContain('ORIGINAL PAYMENT CONFIRMED'));
  const archive = [...document.body.querySelectorAll('button')].find(b => b.textContent === 'ARCHIVE CONFIRMED RECEIPT')!;
  await until(() => expect(archive.disabled).toBe(false)); await act(async () => archive.click());
  await until(async () => expect((await saved()).archives[0]?.reason).toBe('accepted')); expect(api.postRaw).toHaveBeenCalledOnce();
});


it('a delayed current snapshot cannot publish after A→B→A even when the visible base ID returns to A', async () => {
  await mount(); await begin(); const hold = deferred<void>(), entered = deferred<void>(), read = vi.mocked(api.get).getMockImplementation()!;
  let first = true;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (path.startsWith('/balances?') && first) { first = false; entered.resolve(); await hold.promise; return { ...balances, keep: '1' } as never; }
    return read(path, options);
  });
  await act(async () => value.refresh()); await entered.promise;
  await act(async () => { useApp.setState({ selectedBaseId: id(8), baseSelectionEpoch: 1 }); useApp.setState({ selectedBaseId: id(1), baseSelectionEpoch: 2 }); });
  const published: string[] = []; const unsubscribe = useApp.subscribe(state => { if (state.balances) published.push(state.balances.keep); });
  await act(async () => hold.resolve()); await until(() => expect(value.state.busy).toBe(false)); unsubscribe();
  expect(published).not.toContain('1'); expect(value.snapshot?.balances.keep).toBe('100'); expect(api.postRaw).not.toHaveBeenCalled();
});
it('foreground reads share the action hydration slot, and an ignored second action never creates another POST', async () => {
  await mount(); await begin(); const hold = deferred<void>(), entered = deferred<void>(), read = vi.mocked(api.get).getMockImplementation()!;
  let held = false, overlapping = false, readsWhileHeld = 0;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (accepted && path.startsWith('/balances?') && !held) { held = true; overlapping = true; entered.resolve(); await hold.promise; overlapping = false; }
    else if (overlapping) readsWhileHeld++;
    return read(path, options);
  });
  await act(async () => value.run(c => c.confirm())); await entered.promise;
  await act(async () => { window.dispatchEvent(new Event('focus')); value.run(c => c.confirm()); });
  expect(value.state.busy).toBe(true); expect(readsWhileHeld).toBe(0); expect(api.postRaw).toHaveBeenCalledOnce();
  await act(async () => hold.resolve()); await until(() => expect(value.state.busy).toBe(false));
  expect((await saved()).operation?.proof?.status).toBe('accepted'); expect(api.postRaw).toHaveBeenCalledOnce();
});

it.each([false, true])('review keeps identifiers in disclosure and uses only a matching current target label (replaced=%s)', async replaced => {
  const read = vi.mocked(api.get).getMockImplementation()!; let reads = 0;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (path.startsWith('/base?')) {
      const snapshot = base(); reads++;
      return { ...snapshot, buildings: [{ id: builder.consent.buildingId, type: 'gold_forge' }],
        jobs: snapshot.jobs.map(job => replaced && reads > 2 ? { ...job, finishesAt: '2026-09-21T13:00:00.000Z' } : job) } as never;
    }
    return read(path, options);
  });
  await mount(); await act(async () => value.begin(builder)); await until(() => expect(value.state.review && !value.state.busy).toBeTruthy());
  const dialog = document.querySelector('[aria-label="Confirm Builder payment"]')!;
  const details = dialog.querySelector('details')!; expect(details.hasAttribute('open')).toBe(false);
  expect(details.textContent).toContain(builder.jobId); expect(details.textContent).toContain(builder.consent.finishesAt);
  const primary = dialog.cloneNode(true) as HTMLElement; primary.querySelectorAll('details').forEach(node => node.remove());
  expect(primary.textContent).not.toContain(builder.baseId); expect(primary.textContent).not.toContain(builder.jobId);
  expect(primary.textContent).not.toContain(builder.consent.finishesAt); expect(primary.textContent).toContain('Scheduled completion:');
  if (replaced) expect(primary.textContent).not.toContain('GOLD FORGE'); else expect(primary.textContent).toContain('GOLD FORGE');
  expect(primary.textContent).toContain('UP TO 100'); expect(api.postRaw).not.toHaveBeenCalled();
});
