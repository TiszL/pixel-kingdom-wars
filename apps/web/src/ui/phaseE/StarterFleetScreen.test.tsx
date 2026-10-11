/** @vitest-environment happy-dom */
import { IDBFactory } from 'fake-indexeddb';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, ApiError } from '../../lib/api';
import { authCookies } from '../../auth/authCookieCoordinator';
import { useApp } from '../../state/store';
import { unpaidOriginal } from '../../lib/unpaidResources/transport';
import { StarterFleetJournalStore } from '../../lib/starterFleet/journal';
import { starterFleetIdentity } from '../../lib/starterFleet/browser';
import { command, deferred, id, identity, installation, proof, start, view } from '../../lib/starterFleet/fixtures.test-support';
import { base, directory, funds } from '../../lib/workshop/snapshot.test-support';
import { StarterFleetScreen } from './StarterFleetScreen';
import { StarterFleetDoor } from './StarterFleetDoor';

vi.mock('../../lib/unpaidResources/transport', () => ({ unpaidOriginal: vi.fn() }));
let root: Root, host: HTMLDivElement, accepted: boolean, currentView: ReturnType<typeof view>, visibility: DocumentVisibilityState;
const until = (fn: () => void | Promise<void>) => vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); await fn(); });
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
const click = async (label: string) => { expect(button(label)?.disabled).toBe(false); await act(async () => button(label)!.click()); };
const saved = async () => { const store = new StarterFleetJournalStore(starterFleetIdentity(identity.wallet)); try { return await store.read(); } finally { await store.close(); } };
const posts = () => vi.mocked(unpaidOriginal).mock.calls.filter(([input]) => input.method === 'POST');
const mount = async (strict = false, actionsEnabled = true) => {
  await act(async () => root.render(strict ? <StrictMode><StarterFleetScreen actionsEnabled={actionsEnabled} /></StrictMode> : <StarterFleetScreen actionsEnabled={actionsEnabled} />));
  await until(() => expect(button('REFRESH FLEET & RECEIPTS')?.disabled).toBe(false));
};
async function review() {
  await until(() => expect(host.querySelector('select')).not.toBeNull());
  await act(async () => { const select = host.querySelector('select')!; select.value = start.request.berthId; select.dispatchEvent(new Event('change', { bubbles: true })); });
  await click('REVIEW STARTER INSTALLATION'); await until(() => expect(button('CONFIRM STARTER INSTALLATION')?.disabled).toBe(false));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('indexedDB', new IDBFactory());
  const held = new Set<string>(); Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: async (name: string, _options: unknown, run: (lock: object | null) => Promise<unknown>) => {
    if (held.has(name)) return run(null); held.add(name); try { return await run({}); } finally { held.delete(name); }
  } } });
  visibility = 'visible'; Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.spyOn(authCookies, 'assertSession').mockReturnValue('session'); vi.spyOn(authCookies, 'assertResponse').mockImplementation(() => undefined);
  useApp.getState().setAuth(identity.wallet, true); useApp.getState().setScreen('starter-fleet'); useApp.getState().setSelectedBaseId(id(1), false); useApp.getState().setBase(base());
  accepted = false; currentView = view();
  vi.spyOn(api, 'get').mockImplementation(async path => {
    if (path === '/me') return { wallet: identity.wallet } as never;
    if (path === '/bases') return directory() as never;
    if (path.startsWith('/base?')) return base() as never;
    if (path.startsWith('/balances?')) return funds as never;
    if (path.startsWith('/starter-fleet?')) return currentView as never;
    throw new Error(`Unexpected ${path}`);
  });
  vi.mocked(unpaidOriginal).mockReset().mockImplementation(async input => {
    input.isCurrent(); if (input.command.kind !== 'installation') throw new Error('Unexpected command family');
    const journal = await saved(), operation = journal.operation ?? journal.archives.find(row => row.operation.command.request.idempotencyKey === input.command.request.idempotencyKey)?.operation;
    if (input.method === 'POST') { expect(operation?.attemptRevision).not.toBeNull(); expect(operation?.command.request).toEqual(input.command.request); accepted = true; }
    const result = proof(operation?.command ?? command(false, input.command.request.idempotencyKey), accepted);
    if (result.status === 'accepted') await input.retainAccepted(result);
    input.isCurrent(); return result;
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); Reflect.deleteProperty(document, 'visibilityState'); Reflect.deleteProperty(navigator, 'locks'); useApp.getState().setAuth(null); });

it('StrictMode and foreground only read; explicit consent names the permanent berth and free installation', async () => {
  await mount(true); await review(); expect(posts()).toHaveLength(0);
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Confirm starter installation"]'));
  const terms = host.querySelector('[aria-label="Confirm starter installation"]')!.textContent!;
  expect(terms).toContain(start.request.berthId); expect(terms).toContain(start.berth.berthCompletedAt);
  expect(terms).toContain('Permanently bind'); expect(terms).toContain('No SOL, KEEP, Gems or SHARDS payment');
  await act(async () => window.dispatchEvent(new Event('focus'))); await until(() => expect(button('CONFIRM STARTER INSTALLATION')).toBeUndefined()); expect(posts()).toHaveLength(0);
});
it.each([false, true])('accepted original with existing=%s never substitutes its historic installation for the live fleet', async existing => {
  currentView = view(existing); await mount(); await review();
  if (existing) expect(host.textContent).toContain('No additional vehicle is created');
  await click('CONFIRM STARTER INSTALLATION'); await until(() => expect(host.textContent).toContain('ORIGINAL STARTER ACCEPTED'));
  expect(document.activeElement).toBe(host.querySelector('[aria-label="Saved starter request"]'));
  const historical = (await saved()).operation!.proof;
  expect(historical?.status).toBe('accepted');
  if (historical?.status === 'accepted') expect(historical.receipt.installation).toEqual(installation());
  expect(host.querySelector('[aria-label="Current selected kingdom fleet"]')!.textContent).toContain(existing ? 'Starter installed' : 'No starter is installed');
  await click('ARCHIVE ACCEPTED STARTER'); await until(() => expect(host.textContent).toContain('STARTER HISTORY (1)'));
  expect((await saved()).archives[0]?.operation.proof).toEqual(historical); expect(posts()).toHaveLength(1); expect(useApp.getState().balances).toEqual(funds);
});
it('lost acknowledgement recovers while paused and after original ownership disappears, without POST', async () => {
  const send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => { if (input.method === 'POST') { accepted = true; throw new Error('lost acknowledgement'); } return send(input); });
  await mount(); await review(); await click('CONFIRM STARTER INSTALLATION'); await until(() => expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false));
  await act(async () => root.render(null)); currentView.acceptingInstallations = false;
  const read = vi.mocked(api.get).getMockImplementation()!; vi.mocked(api.get).mockImplementation(async (path, options) => path === '/bases' ? { ...directory(), bases: [] } as never : read(path, options));
  await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL STARTER ACCEPTED'));
  expect(host.textContent).toContain('Current kingdom fleet is unavailable'); expect(posts()).toHaveLength(1);
});
it('freeze and maintenance retire consent but leave GET receipt recovery available', async () => {
  await mount(); await review(); await act(async () => { visibility = 'hidden'; document.dispatchEvent(new Event('freeze')); });
  expect(button('CONFIRM STARTER INSTALLATION')).toBeUndefined();
  await act(async () => { visibility = 'visible'; document.dispatchEvent(new Event('resume')); }); await until(() => expect(button('REVIEW ORIGINAL REQUEST')?.disabled).toBe(false));
  await click('REVIEW ORIGINAL REQUEST'); await until(() => expect(button('CONFIRM STARTER INSTALLATION')).toBeDefined()); await mount(false, false);
  expect(button('CONFIRM STARTER INSTALLATION')).toBeUndefined(); expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false); expect(posts()).toHaveLength(0);
});
it('mounted base ABA rejects late fleet hydration, retains the original and queues a fresh read without reviving consent', async () => {
  await mount();
  const oldEntered = deferred(), oldRelease = deferred(), freshEntered = deferred(), freshRelease = deferred();
  const staleFleet = { ...view(true), serverNow: '2026-09-22T12:01:00.000Z' };
  const freshFleet = { ...view(), serverNow: '2026-09-22T12:02:00.000Z' };
  const staleBase = { ...base(), player: { ...base().player, name: 'Obsolete hydration' } };
  const selectedBase = { ...base(), player: { ...base().player, name: 'Selected A after ABA' } };
  const freshBase = { ...base(), player: { ...base().player, name: 'Fresh queued hydration' } };
  const staleFunds = { ...funds, shards: '11111' }, selectedFunds = { ...funds, shards: '77777' }, freshFunds = { ...funds, shards: '88888' };
  const read = vi.mocked(api.get).getMockImplementation()!; let fleetReads = 0;
  vi.mocked(api.get).mockImplementation(async (path, options) => {
    if (path.startsWith('/base?')) {
      if (fleetReads < 3) return staleBase as never;
      freshEntered.resolve(); await freshRelease.promise; return freshBase as never;
    }
    if (path.startsWith('/balances?')) return (fleetReads < 3 ? staleFunds : freshFunds) as never;
    if (path.startsWith('/starter-fleet?')) {
      // Two current admission reads precede the hook's authoritative hydration.
      if (++fleetReads < 3) return view() as never;
      if (fleetReads === 3) { oldEntered.resolve(); await oldRelease.promise; return staleFleet as never; }
      return freshFleet as never;
    }
    return read(path, options);
  });
  const publications: { name: string | undefined; shards: string | undefined }[] = [];
  const unsubscribe = useApp.subscribe(state => publications.push({ name: state.base?.player.name, shards: state.balances?.shards }));
  try {
    await act(async () => { const select = host.querySelector('select')!; select.value = start.request.berthId; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await click('REVIEW STARTER INSTALLATION'); await oldEntered.promise;
    await until(() => expect(button('CONFIRM STARTER INSTALLATION')).toBeDefined());
    const original = (await saved()).operation!, proofReads = vi.mocked(unpaidOriginal).mock.calls.length;
    const epoch = useApp.getState().baseSelectionEpoch;
    await act(async () => useApp.getState().setSelectedBaseId(id(9), false));
    expect(button('CONFIRM STARTER INSTALLATION')).toBeUndefined();
    await act(async () => {
      useApp.getState().setSelectedBaseId(id(1), false);
      useApp.getState().setBase(selectedBase); useApp.getState().setBalances(selectedFunds);
    });
    expect(useApp.getState().baseSelectionEpoch).toBe(epoch + 2);
    await act(async () => oldRelease.resolve()); await freshEntered.promise;
    expect(useApp.getState().base).toEqual(selectedBase); expect(useApp.getState().balances).toEqual(selectedFunds);
    expect(host.querySelector('[aria-label="Current selected kingdom fleet"]')).toBeNull();
    expect(host.textContent).not.toContain(staleFleet.serverNow); expect(button('CONFIRM STARTER INSTALLATION')).toBeUndefined();
    expect((await saved()).operation).toEqual(original);
    expect(vi.mocked(unpaidOriginal).mock.calls.length).toBeGreaterThan(proofReads);
    await act(async () => freshRelease.resolve());
    await until(() => {
      expect(button('REFRESH FLEET & RECEIPTS')?.disabled).toBe(false);
      expect(host.querySelector('[aria-label="Current selected kingdom fleet"]')?.textContent).toContain(freshFleet.serverNow);
    });
    expect(useApp.getState().base).toEqual(freshBase); expect(useApp.getState().balances).toEqual(freshFunds);
    expect(publications.some(value => value.name === staleBase.player.name || value.shards === staleFunds.shards)).toBe(false);
    expect(host.textContent).not.toContain(staleFleet.serverNow); expect(host.textContent).not.toContain('Starter installed at berth');
    expect(button('CONFIRM STARTER INSTALLATION')).toBeUndefined(); expect(button('CHECK ORIGINAL RECEIPT')?.disabled).toBe(false);
    expect((await saved()).operation).toEqual(original);
    for (const [input] of vi.mocked(unpaidOriginal).mock.calls) { expect(input.method).toBe('GET'); expect(input.command.request).toEqual(original.command.request); }
    expect(posts()).toHaveLength(0);
  } finally { oldRelease.resolve(); freshRelease.resolve(); unsubscribe(); }
});
it('owned acceptance after unmount persists before closing the journal without publishing obsolete fleet or funds', async () => {
  const writes = vi.spyOn(StarterFleetJournalStore.prototype, 'compareAndSet'), closes = vi.spyOn(StarterFleetJournalStore.prototype, 'close');
  const waiting = deferred(), entered = deferred(), send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input);
    input.isCurrent(); entered.resolve(); await waiting.promise; accepted = true;
    const result = proof((await saved()).operation!.command, true); if (result.status === 'accepted') await input.retainAccepted(result);
    input.isCurrent(); return result;
  });
  await mount(); await review(); const originalStore = writes.mock.contexts[0]!; await click('CONFIRM STARTER INSTALLATION'); await entered.promise;
  await act(async () => root.render(null)); useApp.getState().setBalances({ ...funds, shards: '98765' }); expect(closes.mock.contexts).not.toContain(originalStore);
  await act(async () => waiting.resolve()); await until(() => expect(closes.mock.contexts).toContain(originalStore));
  expect((await saved()).operation?.proof?.status).toBe('accepted'); expect(useApp.getState().balances?.shards).toBe('98765');
  await mount(); await until(() => expect(host.textContent).toContain('ORIGINAL STARTER ACCEPTED')); expect(posts()).toHaveLength(1);
});
it('an explicit archived-refusal check can retain later acceptance while preserving the earlier decision and evidence', async () => {
  const send = vi.mocked(unpaidOriginal).getMockImplementation()!;
  vi.mocked(unpaidOriginal).mockImplementation(async input => {
    if (input.method !== 'POST') return send(input);
    await input.retainRefusal({ status: 409, code: 'STARTER_BERTH_UNAVAILABLE' }); throw new ApiError(409, 'Unavailable', 'STARTER_BERTH_UNAVAILABLE');
  });
  await mount(); await review(); await click('CONFIRM STARTER INSTALLATION'); await until(() => expect(button('ARCHIVE DECLINED REQUEST')?.disabled).toBe(false));
  await click('ARCHIVE DECLINED REQUEST'); await until(() => expect(button('CHECK ARCHIVED RECEIPT')?.disabled).toBe(false));
  const old = (await saved()).archives[0]!; accepted = true; await click('CHECK ARCHIVED RECEIPT');
  await until(() => expect(host.textContent).toContain('Original acceptance recovered after archival'));
  expect((await saved()).archives[0]).toMatchObject({ reason: 'refused', evidence: old.evidence, operation: { refusal: old.operation.refusal, proof: { status: 'accepted' } } }); expect(posts()).toHaveLength(1);
});
it('unavailable original authority does not silently finish an accepted request', async () => {
  await mount(); await review(); await click('CONFIRM STARTER INSTALLATION'); await until(() => expect(button('ARCHIVE ACCEPTED STARTER')?.disabled).toBe(false));
  const read = vi.mocked(api.get).getMockImplementation()!;
  vi.mocked(api.get).mockImplementation(async (path, options) => path === '/bases' ? { ...directory(), enabled: false } as never : read(path, options));
  await click('ARCHIVE ACCEPTED STARTER'); await until(() => expect(host.textContent).toContain('authority cannot be established'));
  expect((await saved()).operation?.proof?.status).toBe('accepted'); expect((await saved()).archives).toHaveLength(0);
});
it('dark recovery discovery reads only local evidence and remains reachable without new admission', async () => {
  await act(async () => root.render(<StarterFleetDoor />)); await act(async () => new Promise(resolve => setTimeout(resolve, 20))); expect(host.textContent).toBe(''); expect(api.get).not.toHaveBeenCalled();
  await act(async () => root.render(null)); const store = new StarterFleetJournalStore(starterFleetIdentity(identity.wallet));
  await store.compareAndSet(0, old => ({ ...old, operation: { command: start, attemptRevision: null, refusal: null, proof: null } })); await store.close();
  await act(async () => root.render(<StarterFleetDoor />)); await until(() => expect(button('STARTER & SAVED RECEIPTS')).toBeDefined()); expect(api.get).not.toHaveBeenCalled(); expect(posts()).toHaveLength(0);
});

// R0 changes the default build policy; these retained cases exercise the enabled interface.
import { beforeEach as beforeWebHoldCase, afterEach as afterWebHoldCase, vi as webHoldFixture } from 'vitest';
beforeWebHoldCase(() => { webHoldFixture.stubEnv('VITE_PHASE_E_WEB_ENABLED', '1'); });
afterWebHoldCase(() => { webHoldFixture.unstubAllEnvs(); });
