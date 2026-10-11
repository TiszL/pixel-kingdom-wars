/** @vitest-environment happy-dom */
import { fmtDur } from '@shardkeep/shared';
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { unpaidOriginal } from '../../lib/unpaidResources/transport';
import { StarterExpeditionJournalStore } from '../../lib/starterExpedition/journal';
import { starterExpeditionIdentity } from '../../lib/starterExpedition/browser';
import { deferred, id, identity, proof, start, view } from '../../lib/starterExpedition/fixtures.test-support';
import { base, directory, funds } from '../../lib/workshop/snapshot.test-support';
import { StarterExpeditionScreen } from './StarterExpeditionScreen';
import { StarterExpeditionDoor } from './StarterExpeditionDoor';

vi.mock('../../lib/unpaidResources/transport', () => ({ unpaidOriginal: vi.fn() }));
let root: Root, host: HTMLDivElement, accepted: boolean, returned: boolean;
let currentView: ReturnType<typeof view>, visibility: DocumentVisibilityState;
const until = (fn: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); await fn(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const click = async (label: string) => { expect(button(label)?.disabled).toBe(false); await act(async () => button(label)!.click()); };
const saved = async () => { const store = new StarterExpeditionJournalStore(starterExpeditionIdentity(identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const posts = () => vi.mocked(unpaidOriginal).mock.calls.filter(([input]) => input.method === 'POST');
const originalGets = () => vi.mocked(unpaidOriginal).mock.calls.filter(([input]) => input.method === 'GET');
const stock = () => [...host.querySelectorAll('[aria-label="Current raw resource stock"] dd')]
  .map(row => row.textContent);
const mount = async (strict = false, actionsEnabled = true) => {
  await act(async () => root.render(strict ? <StrictMode><StarterExpeditionScreen actionsEnabled={actionsEnabled} /></StrictMode> : <StarterExpeditionScreen actionsEnabled={actionsEnabled} />));
  await until(() => expect(button('REFRESH EXPEDITIONS & RECEIPTS')?.disabled).toBe(false));
};
async function review(routeId: string = start.request.routeId) {
  await until(() => expect(host.querySelector('select[aria-label="Expedition route"]')).not.toBeNull());
  await act(async () => { const select = host.querySelector<HTMLSelectElement>('select[aria-label="Expedition route"]')!;
    select.value = routeId; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('REVIEW DEPARTURE'); await until(() => expect(button('CONFIRM DEPARTURE')?.disabled).toBe(false));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null); held.add(name); try { return await run({}); } finally { held.delete(name); }
  } } });
  visibility = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setScreen('starter-expeditions');
  useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBase(base());
  accepted = false; returned = false; currentView = view();
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/me') return { wallet: identity.wallet } as never;
    if (path === '/bases') return directory() as never;
    if (path.startsWith('/base?')) return base() as never;
    if (path.startsWith('/balances?')) return funds as never;
    if (path.startsWith('/starter-expeditions?')) return currentView as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.mocked(unpaidOriginal).mockReset().mockImplementation(async input => {
    input.isCurrent(); if (input.command.kind !== 'expedition') throw new Error('Unexpected command family');
    const journal = await saved(), key = input.command.request.idempotencyKey;
    const operation = journal.operation?.command.request.idempotencyKey === key ? journal.operation
      : journal.archives.find(row => row.operation.command.request.idempotencyKey === key)?.operation;
    if (!operation) throw new Error('Original departure must be durable before transport');
    if (input.method === 'POST') {
      expect(operation.attemptRevision).not.toBeNull(); expect(operation.command.request).toEqual(input.command.request); accepted = true;
    }
    const result = proof(operation.command, accepted, returned);
    if (result.status === 'accepted') await input.retainAccepted(result);
    input.isCurrent(); return result;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });

it.each(['home', 'common'] as const)('explicit %s consent presents the server route, duration and gross/tax/net; StrictMode and foreground never POST', async kind => {
  const route = currentView.routes.find(row => ('access' in row) === (kind === 'common'))!;
  await mount(true); await review(route.routeId);
  const terms = host.querySelector('[aria-label="Confirm starter departure"]')!.textContent!;
  const whole = (value: string | number) => BigInt(value).toLocaleString('en-US');
  expect(terms).toContain(kind === 'common' ? 'Common route' : 'Home route');
  expect(terms).toContain(fmtDur(route.durationSec));
  const cargo = host.querySelector('[aria-label="Confirm starter departure"] [aria-label="Cargo outcome"]')!;
  expect([...cargo.querySelectorAll('dt')].map(n => n.textContent)).toEqual(['Gross cargo', 'Island pool', 'To kingdom']);
  expect([...cargo.querySelectorAll('dd')].map(n => n.textContent)).toEqual([route.grossQuantity, route.islandPoolQuantity, route.netQuantity].map(n => `${whole(n)} ${route.resourceId.replaceAll('_', ' ')}`));
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Confirm starter departure"]'));
  expect(terms).toContain(`Route version ${route.routeCatalogueVersion}`); expect(terms).toContain(`Reward version ${route.rewardTableVersion}`);
  expect(terms).toContain(start.request.baseId); expect(terms).toContain(start.installation.installationId);
  expect(terms).toContain('including after transfer'); expect(terms).toContain('No SOL, KEEP, Gems or SHARDS payment');
  expect((await saved()).operation?.command.route).toEqual(route); expect(posts()).toHaveLength(0);
  await act(async () => window.dispatchEvent(new Event('focus'))); await until(() => expect(button('CONFIRM DEPARTURE')).toBeUndefined());
  expect(posts()).toHaveLength(0);
});

it('one explicit confirmation retains the complete original trip independently of live stock and has no Collect action', async () => {
  await mount(); const before = stock(); expect(before).toHaveLength(currentView.rawStock.length);
  await review(); const original = (await saved()).operation!.command;
  await click('CONFIRM DEPARTURE'); await until(() => expect(host.textContent).toContain('ORIGINAL DEPARTURE ACCEPTED'));
  await until(() => expect(button('REFRESH EXPEDITIONS & RECEIPTS')?.disabled).toBe(false));
  expect(posts()).toHaveLength(1); expect((await saved()).operation?.command).toEqual(original);
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Saved expedition request"]'));
  expect((await saved()).operation?.proof).toEqual(proof(original, true)); expect(stock()).toEqual(before);
  expect([...host.querySelectorAll('button')].some(b => /collect/i.test(b.textContent ?? ''))).toBe(false);
  expect(useApp.getState().balances).toEqual(funds);
});

it('an archived accepted trip gains only a GET-observed automatic return, never a historical credit to selected stock', async () => {
  await mount(); await review(); await click('CONFIRM DEPARTURE');
  await until(() => expect(button('ARCHIVE ACCEPTED DEPARTURE')?.disabled).toBe(false));
  const original = (await saved()).operation!.proof, before = stock();
  await click('ARCHIVE ACCEPTED DEPARTURE'); await until(() => expect(host.textContent).toContain('EXPEDITION HISTORY (1)'));
  returned = true; currentView.acceptingDepartures = false;
  await act(async () => window.dispatchEvent(new Event('focus')));
  await until(async () => expect((await saved()).archives[0]?.operation.proof).toMatchObject({
    status: 'accepted', return: { returnId: id(7) },
  }));
  await until(() => expect(button('REFRESH EXPEDITIONS & RECEIPTS')?.disabled).toBe(false));
  const final = (await saved()).archives[0]!.operation.proof;
  expect(final?.status).toBe('accepted');
  if (final?.status === 'accepted' && original?.status === 'accepted') expect(final.receipt).toEqual(original.receipt);
  expect(host.textContent).toContain('Automatic return observed:'); expect(stock()).toEqual(before);
  expect(useApp.getState().balances).toEqual(funds); expect(posts()).toHaveLength(1);
  const recovered = originalGets().length;
  await act(async () => window.dispatchEvent(new Event('focus')));
  await until(() => expect(button('REFRESH EXPEDITIONS & RECEIPTS')?.disabled).toBe(false));
  expect(originalGets()).toHaveLength(recovered);
  await click('CHECK AUTOMATIC RETURN'); await until(() => expect(originalGets()).toHaveLength(recovered + 1));
  expect(posts()).toHaveLength(1);
});

it('lost acknowledgement recovers after transfer and provider pause without another POST or buyer-stock publication', async () => {
  const send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => { if (input.method === 'POST') { accepted = true; throw new Error('lost acknowledgement'); } return send(input); });
  await mount(); await review(); await click('CONFIRM DEPARTURE');
  await until(() => expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));
  expect(host.textContent).toContain('ORIGINAL OUTCOME UNKNOWN'); expect(posts()).toHaveLength(1);
  expect((await saved()).operation?.attemptRevision).not.toBeNull();
  await act(async () => root.render(null)); currentView.acceptingDepartures = false;
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => path === '/bases' ? { ...directory(), bases: [] } as never : read(path, options));
  await mount(false, false); await until(() => expect(host.textContent).toContain('ORIGINAL DEPARTURE ACCEPTED'));
  expect(host.textContent).toContain('Current kingdom stock and fleet are unavailable');
  expect(host.querySelector('[aria-label="Current selected kingdom expeditions"]')).toBeNull(); expect(posts()).toHaveLength(1);
});

it('owned acceptance after unmount is saved before journal close and cannot publish obsolete balances', async () => {
  const writes = vi.spyOn(StarterExpeditionJournalStore.prototype, 'compareAndSet'), closes = vi.spyOn(StarterExpeditionJournalStore.prototype, 'close');
  const waiting = deferred(), entered = deferred(), send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input);
    input.isCurrent(); entered.resolve(); await waiting.promise; accepted = true;
    const result = proof((await saved()).operation!.command, true);
    if (result.status === 'accepted') await input.retainAccepted(result);
    input.isCurrent(); return result;
  });
  try {
    await mount(); await review(); const originalStore = writes.mock.contexts[0]!;
    await click('CONFIRM DEPARTURE'); await entered.promise;
    await act(async () => root.render(null)); useApp.getState().setBalances({ ...funds, shards: '98765' });
    expect(closes.mock.contexts).not.toContain(originalStore);
    await act(async () => waiting.resolve()); await until(() => expect(closes.mock.contexts).toContain(originalStore));
    expect((await saved()).operation?.proof?.status).toBe('accepted'); expect(useApp.getState().balances?.shards).toBe('98765');
    await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL DEPARTURE ACCEPTED')); expect(posts()).toHaveLength(1);
  } finally { waiting.resolve(); }
});

it('cancelling during confirmation recovery preserves an unsent draft and prevents enqueue', async () => {
  await mount(); await review(); const waiting = deferred(), entered = deferred(), send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  let delayed = false;
  vi.mocked(unpaidOriginal).mockImplementation(async input => { if (input.method === 'GET' && !delayed) { delayed = true; entered.resolve(); await waiting.promise; } return send(input); });
  try {
    await click('CONFIRM DEPARTURE'); await entered.promise; await click('CANCEL REVIEW');
    await act(async () => waiting.resolve()); await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
    expect((await saved()).operation?.attemptRevision).toBeNull(); expect(posts()).toHaveLength(0);
  } finally { waiting.resolve(); }
});

it('freeze and maintenance retire consent while resumed original recovery stays GET-only', async () => {
  await mount(); await review(); await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('freeze')); });
  expect(button('CONFIRM DEPARTURE')).toBeUndefined();
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('resume')); });
  await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
  await click('REVIEW ORIGINAL REQUEST'); await until(() => expect(button('CONFIRM DEPARTURE')).toBeDefined()); await mount(false, false);
  expect(button('CONFIRM DEPARTURE')).toBeUndefined(); expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false); expect(posts()).toHaveLength(0);
});

it('a provider pause after review refuses the new attempt without losing its original command', async () => {
  await mount(); await review(); const original = (await saved()).operation!.command;
  currentView.acceptingDepartures = false; await click('CONFIRM DEPARTURE');
  await until(() => expect(host.textContent).toContain('New departure requires available server admission'));
  expect(button('CONFIRM DEPARTURE')).toBeUndefined(); expect(posts()).toHaveLength(0);
  expect((await saved()).operation).toMatchObject({ command: original, attemptRevision: null, proof: null });
});

const unavailable: Array<{ name: string; message: string; change: (v: ReturnType<typeof view>) => void }> = [
  { name: 'home authority', message: 'Home authority is unavailable', change: v => { v.home = null; v.routes = []; } },
  { name: 'starter installation', message: 'Install a starter at a completed berth', change: v => { v.installation = null; } },
  { name: 'completed Lodge', message: 'A completed Lodge is required', change: v => { v.lodgeCompletedAt = null; } },
  { name: 'provider admission', message: 'New departures are unavailable', change: v => { v.acceptingDepartures = false; } },
  { name: 'idle vehicle', message: 'The vehicle is away', change: v => {
    const trip = proof(start, true); if (trip.status !== 'accepted') throw new Error('Missing accepted fixture');
    const receipt = trip.receipt;
    v.flight = { expeditionId: receipt.expeditionId, installationId: receipt.installationId, route: receipt.route,
      departedAt: receipt.departedAt, returnsAt: receipt.returnsAt, termId: receipt.termId, termHash: receipt.termHash };
  } },
];
it.each(unavailable)('missing $name hides new departure without inventing readiness', async ({ change, message }) => {
  change(currentView); await mount(); expect(host.textContent).toContain(message);
  expect(button('REVIEW DEPARTURE')).toBeUndefined(); expect(host.querySelector('select')).toBeNull();
  expect(stock()).toHaveLength(currentView.rawStock.length); expect(posts()).toHaveLength(0); expect((await saved()).operation).toBeNull();
});

it('archived refusal can gain original acceptance while preserving the earlier refusal and absence evidence', async () => {
  const send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input);
    await input.retainRefusal({ status: 409, code: 'STARTER_EXPEDITION_INFLIGHT' });
    throw new ApiError(409, 'Vehicle is away', 'STARTER_EXPEDITION_INFLIGHT');
  });
  await mount(); await review(); await click('CONFIRM DEPARTURE'); await until(() => expect(button('ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
  await click('ARCHIVE DECLINED REQUEST'); await until(() => expect(button('CHECK ARCHIVED RECEIPT')?.disabled).toBe(false));
  const old = (await saved()).archives[0]!; accepted = true; await click('CHECK ARCHIVED RECEIPT');
  await until(() => expect(host.textContent).toContain('Original acceptance recovered after archival'));
  expect((await saved()).archives[0]).toMatchObject({ reason: 'refused', evidence: old.evidence,
    operation: { refusal: old.operation.refusal, proof: { status: 'accepted' } } });
  expect(host.textContent).toContain('Original refusal: starter expedition inflight'); expect(posts()).toHaveLength(1);
});

it('failed current hydration keeps accepted departure active rather than silently archiving or inferring stock', async () => {
  await mount(); await review(); await click('CONFIRM DEPARTURE'); await until(() => expect(button('ARCHIVE ACCEPTED DEPARTURE')?.disabled).toBe(false));
  const original = (await saved()).operation!.proof, read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => { if (path.startsWith('/balances?')) throw new Error('stock refresh offline'); return read(path, options); });
  await click('ARCHIVE ACCEPTED DEPARTURE'); await until(() => expect(host.textContent).toContain('stock refresh offline'));
  expect((await saved()).operation?.proof).toEqual(original); expect((await saved()).archives).toHaveLength(0);
  expect(host.querySelector('[aria-label="Current selected kingdom expeditions"]')).toBeNull(); expect(posts()).toHaveLength(1);
});

it('dark recovery discovery reads only saved history and needs no current departure capability', async () => {
  await act(async () => root.render(<StarterExpeditionDoor />)); await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
  expect(host.textContent).toBe(''); expect(api.get).not.toHaveBeenCalled();
  await act(async () => root.render(null)); const store = new StarterExpeditionJournalStore(starterExpeditionIdentity(identity.wallet));
  await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attemptRevision: null, refusal: null, proof: null } })); await store.close();
  await act(async () => root.render(<StarterExpeditionDoor />)); await until(() => expect(button('EXPEDITIONS & SAVED RECEIPTS')).toBeDefined());
  expect(api.get).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
