/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { ordinaryOriginal } from '../../lib/unpaidResources/transport';
import { OrdinaryCraftingJournalStore } from '../../lib/ordinaryCrafting/journal';
import { ordinaryCraftingIdentity } from '../../lib/ordinaryCrafting/browser';
import { command, deferred, id, identity, proof, start, view } from '../../lib/ordinaryCrafting/fixtures.test-support';
import { base, directory, funds } from '../../lib/workshop/snapshot.test-support';
import { OrdinaryCraftingScreen } from './OrdinaryCraftingScreen';
import { WorkshopJournalStore } from '../../lib/boundCosmetics/workshopJournal';
import { command as awningCommand, view as awningView } from '../../lib/boundCosmetics/workshopFixtures.test-support';
import { OrdinaryCraftingDoor } from './OrdinaryCraftingDoor';
import { wakeCommand } from '../../lib/boundCosmetics/wakeWorkshopFixtures.test-support';

vi.mock('./BoundCosmeticPreview', () => ({ BoundCosmeticPreview: () => <span>Appearance preview</span> }));
vi.mock('../../lib/unpaidResources/transport', () => ({ ordinaryOriginal: vi.fn() }));
let root: Root, host: HTMLDivElement, accepted: boolean, completed: boolean, currentView: ReturnType<typeof view>, visibility: DocumentVisibilityState;
const until = (fn: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); await fn(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const click = async (label: string) => { expect(button(label)?.disabled).toBe(false); await act(async () => button(label)!.click()); };
const saved = async () => { const store = new OrdinaryCraftingJournalStore(ordinaryCraftingIdentity(identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const posts = () => vi.mocked(ordinaryOriginal).mock.calls.filter(([input]) => input.method === 'POST');
const mount = async (strict = false, actionsEnabled = true) => {
  await act(async () => root.render(strict ? <StrictMode><OrdinaryCraftingScreen actionsEnabled={actionsEnabled} /></StrictMode> : <OrdinaryCraftingScreen actionsEnabled={actionsEnabled} />));
  await until(() => expect(button('REFRESH STOCK & RECEIPTS')?.disabled).toBe(false));
};
async function review() {
  await until(() => expect(host.querySelector('select')).not.toBeNull());
  await act(async () => { const select = host.querySelector('select')!; select.value = start.request.recipeId; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('REVIEW REFINING'); await until(() => expect(button('CONFIRM REFINING')?.disabled).toBe(false));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null); held.add(name); try { return await run({}); } finally { held.delete(name); }
  } } });
  visibility = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setScreen('ordinary-crafting'); useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBase(base());
  accepted = false; completed = false; currentView = view();
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/me') return { wallet: identity.wallet } as never;
    if (path === '/bases') return directory() as never;
    if (path.startsWith('/base?')) return base() as never;
    if (path.startsWith('/balances?')) return funds as never;
    if (path.startsWith('/ordinary-crafting?')) return currentView as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.mocked(ordinaryOriginal).mockReset().mockImplementation(async input => {
    input.isCurrent();
    if (input.method === 'POST') {
      const operation = (await saved()).operation; expect(operation?.attemptRevision).not.toBeNull(); expect(operation?.command.request).toEqual(input.request); accepted = true;
    }
    const selected = (await saved()).operation?.command ?? command(input.request.quantity, input.request.idempotencyKey);
    const result = proof(selected, accepted, completed);
    if (result.status === 'accepted') await input.retainAccepted(result);
    input.isCurrent(); return result;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });

it('StrictMode and foreground only read; consent shows server recipe and automatic output without a Collect action', async () => {
  await mount(true); await review();
  expect(posts()).toHaveLength(0); expect(host.textContent).toContain('No SOL, KEEP or Gems payment');
  const terms = host.querySelector('[aria-label="Confirm ordinary refining"]')!.textContent!;
  expect(terms).toContain(start.recipe.output.quantity); expect(terms).toContain(String(start.recipe.durationSec));
  expect(terms).toContain('Inputs are consumed at start'); expect(terms).toContain('including after a kingdom transfer');
  expect([...host.querySelectorAll('button')].some(b => /collect/i.test(b.textContent ?? ''))).toBe(false);
  await act(async () => window.dispatchEvent(new Event('focus'))); await until(() => expect(button('CONFIRM REFINING')).toBeUndefined()); expect(posts()).toHaveLength(0);
});
it('explicit confirmation persists its original job; archive completion never credits current stock from historical output', async () => {
  await mount(); await review(); await click('CONFIRM REFINING'); await until(() => expect(host.textContent).toContain('ORIGINAL JOB ACCEPTED'));
  expect(posts()).toHaveLength(1); expect((await saved()).operation?.proof?.status).toBe('accepted');
  const stock = () => [...host.querySelectorAll('[aria-label="Current selected kingdom stock"] dl.sk-economy-values')].map(p => p.textContent);
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Saved refining request"]'));
  const before = stock(); expect(before).toHaveLength(2); expect(before.join(' ')).toContain('available'); await click('ARCHIVE ACCEPTED JOB'); await until(() => expect(host.textContent).toContain('REFINING HISTORY (1)'));
  completed = true; await act(async () => window.dispatchEvent(new Event('focus')));
  await until(async () => expect((await saved()).archives[0]?.operation.proof?.completion).not.toBeNull());
  await until(() => expect(button('REFRESH STOCK & RECEIPTS')?.disabled).toBe(false));
  expect(stock()).toEqual(before); expect(posts()).toHaveLength(1); expect(useApp.getState().balances).toEqual(funds);
});
it('lost acknowledgement recovers on remount while admission is paused, without another POST', async () => {
  const send = vi.mocked(ordinaryOriginal).getMockImplementation()!;
  vi.mocked(ordinaryOriginal).mockImplementation(async input => { if (input.method === 'POST') { accepted = true; throw new Error('lost acknowledgement'); } return send(input); });
  await mount(); await review(); await click('CONFIRM REFINING'); await until(() => expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));
  expect((await saved()).operation?.attemptRevision).not.toBeNull();
  await act(async () => root.render(null)); currentView.acceptingJobs = false; await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL JOB ACCEPTED'));
  expect(host.textContent).toContain('New refining is paused'); expect(posts()).toHaveLength(1);
});
it('freeze and maintenance invalidate review; resumed recovery remains GET-only', async () => {
  await mount(); await review(); await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('freeze')); });
  expect(button('CONFIRM REFINING')).toBeUndefined();
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('resume')); }); await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
  await click('REVIEW ORIGINAL REQUEST'); await until(() => expect(button('CONFIRM REFINING')).toBeDefined()); await mount(false, false);
  expect(button('CONFIRM REFINING')).toBeUndefined(); expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false); expect(posts()).toHaveLength(0);
});
it('owned accepted response after unmount is saved before closing its journal and cannot publish obsolete balances', async () => {
  const writes = vi.spyOn(OrdinaryCraftingJournalStore.prototype, 'compareAndSet'), closes = vi.spyOn(OrdinaryCraftingJournalStore.prototype, 'close');
  const waiting = deferred(), entered = deferred(), send = vi.mocked(ordinaryOriginal).getMockImplementation()!;
  vi.mocked(ordinaryOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input);
    input.isCurrent(); entered.resolve(); await waiting.promise; accepted = true;
    const result = proof(command(input.request.quantity, input.request.idempotencyKey), true);
    if (result.status === 'accepted') await input.retainAccepted(result);
    input.isCurrent(); return result;
  });
  await mount(); await review(); const originalStore = writes.mock.contexts[0]!; await click('CONFIRM REFINING'); await entered.promise;
  await act(async () => root.render(null)); useApp.getState().setBalances({ ...funds, shards: '98765' });
  expect(closes.mock.contexts).not.toContain(originalStore);
  await act(async () => waiting.resolve()); await until(() => expect(closes.mock.contexts).toContain(originalStore));
  expect((await saved()).operation?.proof?.status).toBe('accepted'); expect(useApp.getState().balances?.shards).toBe('98765');
  await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL JOB ACCEPTED')); expect(posts()).toHaveLength(1);
});
it('cancelling during the original confirmation GET retains the unsent command and cannot enqueue POST', async () => {
  await mount(); await review(); const waiting = deferred(), entered = deferred(), send = vi.mocked(ordinaryOriginal).getMockImplementation()!;
  let delayed = false;
  vi.mocked(ordinaryOriginal).mockImplementation(async input => { if (input.method === 'GET' && !delayed) { delayed = true; entered.resolve(); await waiting.promise; } return send(input); });
  await click('CONFIRM REFINING'); await entered.promise; await click('CANCEL REVIEW');
  await act(async () => waiting.resolve()); await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
  expect((await saved()).operation?.attemptRevision).toBeNull(); expect(posts()).toHaveLength(0);
});
it('first typed refusal remains durable and requires explicit archive after a fresh original GET', async () => {
  const send = vi.mocked(ordinaryOriginal).getMockImplementation()!;
  vi.mocked(ordinaryOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input);
    await input.retainRefusal({ status: 409, code: 'ORDINARY_CRAFTING_BUSY' }); throw new ApiError(409, 'Busy', 'ORDINARY_CRAFTING_BUSY');
  });
  await mount(); await review(); await click('CONFIRM REFINING'); await until(() => expect(button('ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
  expect(button('REVIEW ORIGINAL REQUEST')).toBeUndefined(); await act(async () => root.render(null)); await mount();
  await click('ARCHIVE DECLINED REQUEST'); await until(async () => expect((await saved()).operation).toBeNull());
  expect((await saved()).archives[0]?.reason).toBe('refused'); expect(posts()).toHaveLength(1);
});
it('a failed current-stock refresh keeps the accepted original active instead of silently archiving it', async () => {
  await mount(); await review(); await click('CONFIRM REFINING'); await until(() => expect(button('ARCHIVE ACCEPTED JOB')?.disabled).toBe(false));
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => { if (path.startsWith('/balances?')) throw new Error('stock refresh offline'); return read(path, options); });
  await click('ARCHIVE ACCEPTED JOB'); await until(() => expect(host.textContent).toContain('stock refresh offline'));
  expect((await saved()).operation?.proof?.status).toBe('accepted'); expect((await saved()).archives).toHaveLength(0);
});
it('lost original kingdom ownership permits historical archive without publishing a substitute stock snapshot', async () => {
  await mount(); await review(); await click('CONFIRM REFINING'); await until(() => expect(button('ARCHIVE ACCEPTED JOB')?.disabled).toBe(false));
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => path === '/bases' ? { ...directory(), bases: [] } as never : read(path, options));
  await click('ARCHIVE ACCEPTED JOB'); await until(async () => expect((await saved()).archives).toHaveLength(1));
  expect(host.textContent).toContain('Current kingdom stock is unavailable'); expect(posts()).toHaveLength(1);
});
it('dark recovery discovery uses only the local journal and stays reachable during a feature pause', async () => {
  await act(async () => root.render(<OrdinaryCraftingDoor />)); await act(async () => new Promise(resolve => setTimeout(resolve, 20))); expect(host.textContent).toBe(''); expect(api.get).not.toHaveBeenCalled();
  await act(async () => root.render(null)); const store = new OrdinaryCraftingJournalStore(ordinaryCraftingIdentity(identity.wallet));
  await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attemptRevision: null, refusal: null, proof: null } })); await store.close();
  await act(async () => root.render(<OrdinaryCraftingDoor />)); await until(() => expect(button('WORKSHOP & SAVED RECEIPTS')).toBeDefined()); expect(api.get).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});

it('shows named kit ingredients and missing SHARDS before consent, without treating it as a fee', async () => {
  if (!('shardsAvailable' in currentView)) throw Error('Missing new catalogue fixture');
  currentView.shardsAvailable = '0'; await mount();
  await act(async () => { const select = host.querySelector('select')!; select.value = 'craft_expedition_kit'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  const ingredients = host.querySelector('[aria-label="Selected recipe ingredients"]')!;
  expect(ingredients.textContent).toContain('Heartwood Beams'); expect(ingredients.textContent).toContain('Thornsilk');
  expect(ingredients.textContent).toContain('SHARDS'); expect(ingredients.textContent).toContain('Owned 0'); expect(ingredients.textContent).toContain('Missing');
  expect(button('REVIEW REFINING')?.disabled).toBe(true); expect(posts()).toHaveLength(0);
  currentView.shardsAvailable = '10000';
  await click('REFRESH STOCK & RECEIPTS'); await until(() => expect(button('REVIEW REFINING')?.disabled).toBe(false));
  await click('REVIEW REFINING'); await until(() => expect(button('CONFIRM REFINING')?.disabled).toBe(false));
  expect(host.querySelector('[aria-label="Confirm ordinary refining"]')!.textContent).toContain('SHARDS shown above are a recipe ingredient');
  expect(posts()).toHaveLength(0);
});

const ownAwningView = () => {
  const value = awningView(); value.wallet = identity.wallet;
  if (value.blueprint.state === 'eligible') value.blueprint.proof.actorWallet = identity.wallet;
  return value;
};
it('Workshop selector mounts one section and cancels refining review while keeping its exact saved draft', async () => {
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => path.startsWith('/bound-cosmetics') ? ownAwningView() as never : read(path, options));
  await mount(); await review(); const original = (await saved()).operation!.command;
  await click('AWNINGS'); await until(() => expect(button('REVIEW CRAFT')).toBeDefined());
  expect(host.querySelectorAll('[role="dialog"]')).toHaveLength(1); expect(button('CONFIRM REFINING')).toBeUndefined();
  expect(button('AWNINGS')!.getAttribute('aria-pressed')).toBe('true');
  expect(button('AWNINGS')!.style.minHeight).toBe('48px'); expect(button('MATERIALS')!.style.minHeight).toBe('48px');
  await act(async () => root.render(<OrdinaryCraftingScreen actionsEnabled={false} />));
  await until(() => expect(button('REVIEW CRAFT')?.disabled).toBe(true));
  await click('MATERIALS'); await until(() => expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));
  expect(button('CONFIRM REFINING')).toBeUndefined(); expect((await saved()).operation!.command).toEqual(original);
  expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(true); expect(posts()).toHaveLength(0);
});
it('saved Awning recovery alone keeps Workshop reachable without selected base or discovery', async () => {
  const store = new WorkshopJournalStore(ordinaryCraftingIdentity(identity.wallet));
  await store.compareAndSet(0, old => ({ ...old, operation: { command: awningCommand(), attempted: false, proof: null } })); await store.close();
  useApp.getState().setSelectedBaseId(null, false);
  await act(async () => root.render(<OrdinaryCraftingDoor />));
  await until(() => expect(button('WORKSHOP & SAVED RECEIPTS')).toBeDefined());
  expect(api.get).not.toHaveBeenCalled(); await click('WORKSHOP & SAVED RECEIPTS');
  expect(useApp.getState().screen).toBe('ordinary-crafting');
});
it('unreadable ordinary or Awning journals advertise recovery instead of looking empty', async () => {
  for (const store of [OrdinaryCraftingJournalStore, WorkshopJournalStore]) {
    const broken = vi.spyOn(store.prototype, 'read').mockRejectedValue(Error('Fixture corrupt recovery'));
    await act(async () => root.render(<OrdinaryCraftingDoor />));
    await until(() => expect(button('WORKSHOP & SAVED RECEIPTS')).toBeDefined());
    expect(api.get).not.toHaveBeenCalled();
    await act(async () => root.render(null)); broken.mockRestore();
  }
});
it('Awning discovery requires strict matching account and base even when ordinary discovery is unavailable', async () => {
  for (const kind of ['wrong-wallet', 'wrong-base', 'extra-field', 'valid', 'no-base', 'unavailable-base']) {
    useApp.getState().setSelectedBaseId(kind === 'no-base' ? null : id(1), false);
    let response: unknown = ownAwningView();
    if (kind === 'wrong-wallet') response = awningView();
    if (kind === 'wrong-base') { const value = ownAwningView(); value.selectedBase!.baseId = id(9); response = value; }
    if (kind === 'extra-field') response = { ...ownAwningView(), forged: true };
    if (kind === 'no-base') response = { ...ownAwningView(), selectedBase: null };
    if (kind === 'unavailable-base') response = { ...ownAwningView(), selectedBase: { state: 'unavailable', baseId: id(1), reason: 'BASE_NOT_OWNED' } };
    vi.mocked(api.get).mockImplementation(async path => {
      if (path.startsWith('/bound-cosmetics')) return response as never;
      throw Error('Ordinary discovery offline');
    });
    await act(async () => root.render(<OrdinaryCraftingDoor discover />));
    await until(() => expect(vi.mocked(api.get).mock.calls.some(([path]) => path.startsWith('/bound-cosmetics'))).toBe(true));
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    expect(button('WORKSHOP') !== undefined).toBe(['valid', 'no-base', 'unavailable-base'].includes(kind));
    expect(posts()).toHaveLength(0); await act(async () => root.render(null)); vi.mocked(api.get).mockClear();
  }
});
it('late Awning discovery cannot advertise after account ABA base ABA freeze or unmount', async () => {
  for (const reason of ['account', 'base', 'freeze', 'unmount']) {
    const entered = deferred(), release = deferred(); let requests = 0;
    vi.mocked(api.get).mockImplementation(async path => {
      if (!path.startsWith('/bound-cosmetics') || requests++) throw Error('No current discovery');
      entered.resolve(); await release.promise; return ownAwningView() as never;
    });
    await act(async () => root.render(<OrdinaryCraftingDoor discover />)); await entered.promise;
    await act(async () => {
      if (reason === 'account') { useApp.getState().setAuth('2'.repeat(32), true); useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false); }
      if (reason === 'base') { useApp.getState().setSelectedBaseId(id(9), false); useApp.getState().setSelectedBaseId(id(1), false); }
      if (reason === 'freeze') { document.dispatchEvent(new Event('freeze')); document.dispatchEvent(new Event('resume')); }
      if (reason === 'unmount') root.render(null);
      release.resolve();
    });
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    expect(host.textContent).toBe(''); await act(async () => root.render(null));
  }
});
it('a late local journal cannot publish another account recovery entry after account ABA', async () => {
  const entered = deferred(), release = deferred(); let reads = 0;
  const implementation = OrdinaryCraftingJournalStore.prototype.read;
  const ordinary = vi.spyOn(OrdinaryCraftingJournalStore.prototype, 'read');
  ordinary.mockImplementation(async function (this: OrdinaryCraftingJournalStore) {
    const empty = await implementation.call(this);
    if (reads++) return empty;
    entered.resolve(); await release.promise;
    return { ...empty, operation: { command: start, attemptRevision: null, refusal: null, proof: null } };
  });
  await act(async () => root.render(<OrdinaryCraftingDoor />)); await entered.promise;
  await act(async () => {
    useApp.getState().setAuth('2'.repeat(32), true); useApp.getState().setAuth(identity.wallet, true); useApp.getState().setSelectedBaseId(id(1), false);
    release.resolve();
  });
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  expect(host.textContent).toBe(''); expect(api.get).not.toHaveBeenCalled();
});

it('unknown Wake alone keeps local recovery reachable without base Workshop or current admission and never sends', async () => {
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Error('Local recovery must not send HTTP'));
  const store = new WorkshopJournalStore(ordinaryCraftingIdentity(identity.wallet), globalThis.indexedDB, 'wake');
  const draft = await store.compareAndSet(0, old => ({ ...old, operation: { command: wakeCommand(), attempted: false, proof: null } }));
  await store.compareAndSet(draft.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } })); await store.close();
  useApp.getState().setSelectedBaseId(null, false);
  const other = '11111111111111111111111111111113';
  useApp.getState().setAuth(other, true);
  await act(async () => root.render(<OrdinaryCraftingDoor />));
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  expect(host.textContent).toBe('');
  await act(async () => useApp.getState().setAuth(identity.wallet, true));
  await until(() => expect(button('WORKSHOP & SAVED RECEIPTS')).toBeDefined());
  await click('WORKSHOP & SAVED RECEIPTS'); expect(useApp.getState().screen).toBe('ordinary-crafting');
  expect(api.get).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
  const reopened = new WorkshopJournalStore(ordinaryCraftingIdentity(identity.wallet), globalThis.indexedDB, 'wake');
  try { expect((await reopened.read()).operation).toEqual({ command: wakeCommand(), attempted: true, proof: null }); }
  finally { await reopened.close(); }
});
it('unreadable Wake recovery advertises the shared Workshop entry even when other journals are empty', async () => {
  const read = WorkshopJournalStore.prototype.read;
  vi.spyOn(WorkshopJournalStore.prototype, 'read').mockImplementation(function (this: WorkshopJournalStore) {
    return this.mode === 'wake' ? Promise.reject(Error('Unreadable Wake original')) : read.call(this);
  });
  useApp.getState().setSelectedBaseId(null, false);
  await act(async () => root.render(<OrdinaryCraftingDoor />));
  await until(() => expect(button('WORKSHOP & SAVED RECEIPTS')).toBeDefined());
  expect(api.get).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});
it('late Wake journal read cannot publish after account ABA or replace another account recovery', async () => {
  const entered = deferred(), release = deferred(), read = WorkshopJournalStore.prototype.read; let held = false;
  vi.spyOn(WorkshopJournalStore.prototype, 'read').mockImplementation(async function (this: WorkshopJournalStore) {
    const empty = await read.call(this);
    if (this.mode !== 'wake' || held) return empty;
    held = true; entered.resolve(); await release.promise;
    return { ...empty, operation: { command: wakeCommand(), attempted: true, proof: null } };
  });
  await act(async () => root.render(<OrdinaryCraftingDoor />)); await entered.promise;
  await act(async () => {
    useApp.getState().setAuth('11111111111111111111111111111113', true);
    useApp.getState().setAuth(identity.wallet, true); release.resolve();
  });
  await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  expect(host.textContent).toBe(''); expect(api.get).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
