/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../lib/api';
import { authCookies } from '../auth/authCookieCoordinator';
import { useApp } from '../state/store';
import { WorkshopJournalStore, type WorkshopCommand } from '../lib/workshop/journal';
import { workshopIdentity } from '../lib/workshop/browser';
import { collect, id, identity, proof, start, view } from '../lib/workshop/fixtures.test-support';
import { base, capabilities, directory, snapshotRead } from '../lib/workshop/snapshot.test-support';
import { WorkshopScreen } from './WorkshopScreen';
import { WorkshopDoor } from './WorkshopDoor';
let root: Root, host: HTMLDivElement, enabled: boolean, accepted: boolean, command: WorkshopCommand, currentView: ReturnType<typeof view>, visibility: DocumentVisibilityState;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const until = (fn: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); await fn(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const click = async (label: string) => { expect(button(label)?.disabled).toBe(false); await act(async () => button(label)!.click()); };
const saved = async () => { const store = new WorkshopJournalStore(workshopIdentity(identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const mount = async (strict = false, actionsEnabled = true) => {
  await act(async () => root.render(strict ? <StrictMode><WorkshopScreen actionsEnabled={actionsEnabled} /></StrictMode> : <WorkshopScreen actionsEnabled={actionsEnabled} />));
  await until(() => expect(button('REFRESH WORKSHOP & RECEIPTS')?.disabled).toBe(false));
};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null); held.add(name); try { return await run({}); } finally { held.delete(name); }
  } } });
  visibility = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setScreen('workshop'); useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBase(base());
  enabled = true; accepted = false; command = start; currentView = view();
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path.includes('/by-key/')) {
      const idempotencyKey = decodeURIComponent(path.split('/').at(-1)!);
      command = path.includes('/collect/by-key/') ? { ...collect, request: { idempotencyKey } } : { ...start, request: { ...start.request, idempotencyKey } };
      return proof(command, accepted) as never;
    }
    if (path.startsWith('/workshop?')) return { ...currentView, acceptingJobs: enabled } as never;
    if (path === '/native/capabilities') return capabilities(enabled) as never;
    return await snapshotRead(path) as never;
  });
  vi.spyOn(api, 'postRaw').mockImplementation(async (_path, body, options) => {
    options?.isCurrent?.(); const operation = (await saved()).operation; expect(operation?.attempted).toBe(true); expect(operation?.command.request).toEqual(body);
    command = operation!.command; accepted = true; return {} as never;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });
it('StrictMode/open/focus only GET; consent separates selected stock and wallet allowance with exact final charge and duration', async () => {
  await mount(true); await until(() => expect(button('REVIEW REFINING')).toBeDefined());
  expect(host.textContent).toContain('Shared daily starts remaining');expect(host.textContent).toContain('Shared Ingot space remaining');
  expect(api.postRaw).not.toHaveBeenCalled(); expect(host.textContent).toContain('1 held · 1 refining'); expect(host.textContent).toContain('3 held + 2 pending');
  await click('REVIEW REFINING'); await until(() => expect(button('CONFIRM REFINING')?.disabled).toBe(false));
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Confirm Workshop command"]'));
  expect(host.querySelector('[aria-label="Confirm Workshop command"]')?.textContent).toContain('10,000 SHARDS → 1 INGOTS');
  expect(host.textContent).toContain('Duration'); expect(host.textContent).toContain('No cancellation, refund or SOL fee');
  expect([...host.querySelectorAll('button')].every(b => parseInt(b.style.minHeight || '44', 10) >= 44)).toBe(true);
  await act(async () => window.dispatchEvent(new Event('focus'))); await until(() => expect(button('CONFIRM REFINING')).toBeUndefined()); expect(api.postRaw).not.toHaveBeenCalled();
});
it('explicit confirmation preserves original receipt and archived history without deriving inventory from it', async () => {
  await mount(); await until(() => expect(button('REVIEW REFINING')).toBeDefined()); await click('REVIEW REFINING'); await until(() => expect(button('CONFIRM REFINING')?.disabled).toBe(false));
  await click('CONFIRM REFINING'); await until(() => expect(host.textContent).toContain('ORIGINAL RECEIPT CONFIRMED'));
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Saved Workshop command"]'));
  expect(api.postRaw).toHaveBeenCalledOnce(); expect(host.textContent).toContain('1 held · 1 refining');
  await click('ARCHIVE CONFIRMED RECEIPT'); await until(() => expect(host.textContent).toContain('WORKSHOP HISTORY (1)')); expect((await saved()).archives[0]?.reason).toBe('accepted');
});
it('lost acknowledgement survives remount and paused recovery without another POST', async () => {
  vi.mocked(api.postRaw).mockImplementation(async () => { accepted = true; throw new Error('lost acknowledgement'); });
  await mount(); await until(() => expect(button('REVIEW REFINING')).toBeDefined()); await click('REVIEW REFINING'); await until(() => expect(button('CONFIRM REFINING')?.disabled).toBe(false)); await click('CONFIRM REFINING');
  await until(() => expect((async () => (await saved()).operation?.attempted)()).resolves.toBe(true));
  await act(async () => root.render(null)); enabled = false; await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL RECEIPT CONFIRMED'));
  expect(host.textContent).toContain('New refining is paused'); expect(api.postRaw).toHaveBeenCalledOnce();
});
it('hide/freeze and maintenance changes dismiss confirmation; foreground never POSTs', async () => {
  await mount(); await until(() => expect(button('REVIEW REFINING')).toBeDefined()); await click('REVIEW REFINING'); await until(() => expect(button('CONFIRM REFINING')).toBeDefined());
  await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('freeze')); }); expect(button('CONFIRM REFINING')).toBeUndefined();
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('resume')); }); await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
  await click('REVIEW ORIGINAL REQUEST'); await until(() => expect(button('CONFIRM REFINING')).toBeDefined()); await mount(false, false);
  expect(button('CONFIRM REFINING')).toBeUndefined(); expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false); expect(api.postRaw).not.toHaveBeenCalled();
});
it('lost base ownership still shows an original receipt and does not substitute another stock snapshot', async () => {
  const store = new WorkshopJournalStore(workshopIdentity(identity.wallet)); await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attempted: false, proof: null } })); await store.close(); accepted = true;
  const read = vi.mocked(api.get).getMockImplementation()!; vi.mocked(api.get).mockImplementation(async (path, opts) => path === '/bases' ? { ...directory(), bases: [] } as never : read(path, opts));
  await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL RECEIPT CONFIRMED'));
  expect(host.textContent).toContain('Current base inventory is unavailable'); expect(api.postRaw).not.toHaveBeenCalled();
});
it('dark recovery door avoids server probes without local history, but paid history remains discoverable through a pause', async () => {
  await act(async () => root.render(<WorkshopDoor />)); await act(async () => new Promise(resolve => setTimeout(resolve, 20))); expect(host.textContent).toBe(''); expect(api.get).not.toHaveBeenCalled();
  await act(async () => root.render(null)); const store = new WorkshopJournalStore(workshopIdentity(identity.wallet)); await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attempted: false, proof: null } })); await store.close();
  await act(async () => root.render(<WorkshopDoor />)); await until(() => expect(button('WORKSHOP & SAVED RECEIPTS')).toBeDefined()); expect(api.get).not.toHaveBeenCalled();
});
it('keeps the original journal open through a pending mutation after unmount, then recovers its lost acknowledgement using GET only', async () => {
  const writes = vi.spyOn(WorkshopJournalStore.prototype, 'compareAndSet'), closes = vi.spyOn(WorkshopJournalStore.prototype, 'close');
  const pending = deferred<void>(), entered = deferred<void>();
  vi.mocked(api.postRaw).mockImplementation(async () => { entered.resolve(); await pending.promise; accepted = true; return {} as never; });
  await mount(); await until(() => expect(button('REVIEW REFINING')?.disabled).toBe(false));
  await click('REVIEW REFINING'); await until(() => expect(button('CONFIRM REFINING')?.disabled).toBe(false));
  const originalStore = writes.mock.contexts[0]!;
  await click('CONFIRM REFINING'); await entered.promise; expect((await saved()).operation?.attempted).toBe(true);
  await act(async () => root.render(null)); useApp.getState().setBalances({ keep: '500', shards: '98765', keepRate: 1 });
  expect(closes.mock.contexts).not.toContain(originalStore);
  await act(async () => pending.resolve()); await until(() => expect(closes.mock.contexts).toContain(originalStore));
  expect(useApp.getState().balances?.shards).toBe('98765'); expect((await saved()).operation?.proof).toBeNull();
  await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL RECEIPT CONFIRMED'));
  expect(api.postRaw).toHaveBeenCalledOnce(); expect((await saved()).operation?.proof?.status).toBe('accepted');
});
it('paused refining permits explicit collection of ready paid jobs above a reduced holding cap and retains lost-ack recovery', async () => {
  enabled = false; currentView.holding.cap = 1; currentView.allowance.holding.cap = 1; currentView.allowance.holding.remaining = 0;
  await mount(); await until(() => expect(button('REVIEW COLLECTION')?.disabled).toBe(false));
  expect(button('REVIEW REFINING')).toBeUndefined(); expect(host.textContent).toContain('New refining is paused');
  await click('REVIEW COLLECTION'); await until(() => expect(button('CONFIRM COLLECTION')?.disabled).toBe(false));
  const original = (await saved()).operation!.command; expect(original.kind).toBe('collect');
  expect(host.querySelector('[aria-label="Confirm Workshop command"]')?.textContent).toContain('1 ingots go to the producing base');
  vi.mocked(api.postRaw).mockImplementation(async (_path, body, options) => { options?.isCurrent?.(); expect(body).toEqual(original.request); accepted = true; throw new Error('lost collection acknowledgement'); });
  await click('CONFIRM COLLECTION'); await until(() => expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));
  expect(api.postRaw).toHaveBeenCalledExactlyOnceWith(`/workshop/jobs/${id(2)}/collect`, original.request, expect.anything());
  await act(async () => root.render(null)); await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL RECEIPT CONFIRMED'));
  expect((await saved()).operation?.proof?.receipt).toMatchObject({ ingotsCredited: 1, jobId: id(2), baseId: id(1) });
  expect(host.textContent).toContain('1 held · 1 refining'); expect(api.postRaw).toHaveBeenCalledOnce();
});
it('a client clock past readyAt never enables collection until a fresh server response confirms readiness', async () => {
  currentView.serverNow = currentView.jobs[0]!.startedAt; currentView.jobs[0]!.ready = false;
  await mount(); await until(() => expect(button('REVIEW COLLECTION')).toBeDefined()); expect(button('REVIEW COLLECTION')?.disabled).toBe(true);
  expect(Date.now()).toBeGreaterThan(Date.parse(currentView.jobs[0]!.readyAt)); expect(api.postRaw).not.toHaveBeenCalled();
  currentView = view(); await click('REFRESH WORKSHOP & RECEIPTS'); await until(() => expect(button('REVIEW COLLECTION')?.disabled).toBe(false));
});
it('foreground events coalesce behind a pending authoritative refresh and cannot restore the older allowance or approve a request', async () => {
  await mount(); await until(() => expect(button('REVIEW REFINING')?.disabled).toBe(false));
  const originalRead = vi.mocked(api.get).getMockImplementation()!, waiting = deferred<void>(), entered = deferred<void>(); let delayed = false, views = 0;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (path.startsWith('/workshop?')) {
      views++; if (!delayed) { delayed = true; const old = structuredClone(currentView); entered.resolve(); await waiting.promise; return old as never; }
    }
    return originalRead(path, options);
  });
  await click('REFRESH WORKSHOP & RECEIPTS'); await entered.promise;
  expect(button('REVIEW REFINING')?.disabled).toBe(true);
  await act(async () => { window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online')); window.dispatchEvent(new Event('pageshow')); });
  expect(views).toBe(1); currentView.allowance.daily.used = 5; currentView.allowance.daily.remaining = 1;
  await act(async () => waiting.resolve()); await until(() => expect(button('REFRESH WORKSHOP & RECEIPTS')?.disabled).toBe(false));
  expect(views).toBe(2); expect(host.textContent).toContain('Daily: 5 / 6 started'); expect(api.postRaw).not.toHaveBeenCalled();
});
it.each(['base', 'wallet'] as const)('an old %s refresh cannot publish base balances or inventory after the user switches', async change => {
  await mount(); await until(() => expect(button('REVIEW REFINING')?.disabled).toBe(false));
  const originalRead = vi.mocked(api.get).getMockImplementation()!, waiting = deferred<void>(), entered = deferred<void>(); let delayed = false;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (path.startsWith('/workshop?') && !delayed) { delayed = true; entered.resolve(); await waiting.promise; return { ...view(), inventory: { ...view().inventory, held: 777 }, holding: { ...view().holding, held: 777 } } as never; }
    return originalRead(path, options);
  });
  await click('REFRESH WORKSHOP & RECEIPTS'); await entered.promise;
  await act(async () => {
    if (change === 'base') useApp.getState().setSelectedBaseId(id(9), false);
    else useApp.getState().setAuth('So11111111111111111111111111111111111111112', true);
    useApp.getState().setBalances({ keep: '500', shards: '98765', keepRate: 1 });
  });
  await act(async () => waiting.resolve()); await until(() => expect(host.textContent).toContain('Current base inventory is unavailable'));
  expect(useApp.getState().balances?.shards).toBe('98765'); expect(host.textContent).not.toContain('777 held'); expect(api.postRaw).not.toHaveBeenCalled();
});
it('a selected standing Workshop with paid jobs remains discoverable when new refining is paused without any local journal', async () => {
  enabled = false; await act(async () => root.render(<WorkshopDoor discover />)); await until(() => expect(button('OPEN WORKSHOP')).toBeDefined());
  expect((await saved()).operation).toBeNull(); expect(api.postRaw).not.toHaveBeenCalled();
});
it('cancelling review during confirmation read preserves the draft and releases busy through a queued GET without posting', async () => {
  await mount(); await until(() => expect(button('REVIEW REFINING')?.disabled).toBe(false));
  await click('REVIEW REFINING'); await until(() => expect(button('CONFIRM REFINING')?.disabled).toBe(false));
  const originalRead = vi.mocked(api.get).getMockImplementation()!, pending = deferred<void>(), entered = deferred<void>(); let delayed = false;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (path.includes('/by-key/') && !delayed) { delayed = true; entered.resolve(); await pending.promise; }
    return originalRead(path, options);
  });
  await click('CONFIRM REFINING'); await entered.promise; await click('CANCEL REVIEW'); expect(button('CONFIRM REFINING')).toBeUndefined();
  await act(async () => pending.resolve()); await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
  expect(api.postRaw).not.toHaveBeenCalled(); expect((await saved()).operation).toMatchObject({ attempted: false, proof: null });
  await click('REVIEW ORIGINAL REQUEST'); await until(() => expect(button('CONFIRM REFINING')?.disabled).toBe(false));
});
it('another device collecting first shows a durable decline and explicit archive, freeing the wallet without claiming this request credited stock', async () => {
  enabled = false; await mount(); await until(() => expect(button('REVIEW COLLECTION')?.disabled).toBe(false));
  await click('REVIEW COLLECTION'); await until(() => expect(button('CONFIRM COLLECTION')?.disabled).toBe(false));
  vi.mocked(api.postRaw).mockImplementation(async () => { currentView.jobs[0]!.collectedAt = currentView.serverNow; throw new ApiError(409, 'Already collected', 'JOB_ALREADY_COLLECTED'); });
  await click('CONFIRM COLLECTION'); await until(() => expect(button('ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
  expect(host.textContent).toContain('ORIGINAL REQUEST DECLINED'); expect(host.textContent).toContain('Nothing was spent or credited by this request'); expect(button('REVIEW ORIGINAL REQUEST')).toBeUndefined();
  await act(async () => root.render(null)); await mount(); await until(() => expect(button('ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
  await click('ARCHIVE DECLINED REQUEST'); await until(() => expect((async () => (await saved()).operation)()).resolves.toBeNull());
  expect(host.textContent).toContain('Declined request archived with its original proof'); expect(api.postRaw).toHaveBeenCalledOnce();
  expect((await saved()).archives[0]).toMatchObject({ reason: 'refused', operation: { attempted: true, refusal: { code: 'JOB_ALREADY_COLLECTED' } }, evidence: { status: 'unknown' } });
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
