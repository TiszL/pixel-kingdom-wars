// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { BoundCosmeticWorkshopController } from './workshopController';
import { BoundCosmeticWakeWorkshopController, wakeCraftBlock, type WakeWorkshopPorts } from './wakeWorkshopController';
import { WorkshopJournalStore } from './workshopJournal';
import { command, deferred, id, proof, view } from './workshopFixtures.test-support';
import { wakeCommand, wakeIdentity, wakeProof, wakeView } from './wakeWorkshopFixtures.test-support';
const stores: WorkshopJournalStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); });
function setup() {
  const factory = new IDBFactory(), store = new WorkshopJournalStore(wakeIdentity, factory, 'wake'); stores.push(store);
  const scope = { epoch: 0, base: id(1) as string | null, active: true, ready: true, gate: true, actions: true };
  const remote = { view: wakeView(), proof: wakeProof(false, false), failView: false };
  const ports: WakeWorkshopPorts = {
    applicationReady: () => scope.ready,
    capture: (kind, base) => { const epoch = scope.epoch; return () => {
      if (!scope.active || kind !== 'account' && (epoch !== scope.epoch || (scope.base ?? undefined) !== base)
        || kind === 'craft' && (!scope.ready || !scope.gate || !scope.actions)) throw Error('Scope changed');
    }; },
    capturePreference: enabled => () => { if (!scope.active || !scope.gate || enabled && (!scope.ready || !scope.actions)) throw Error('Preference held'); },
    view: vi.fn(async (base, guard) => { guard(); if (remote.failView) throw Error('Current source unavailable'); return { ...structuredClone(remote.view), selectedBase: base ? remote.view.selectedBase : null }; }),
    original: vi.fn(async (_r, guard, retain) => { if (remote.proof.status === 'accepted') await retain(remote.proof); guard(); return remote.proof; }),
    start: vi.fn(async (r, guard, retain) => { expect((await store.read()).operation?.attempted).toBe(true); expect(r).toEqual(wakeCommand().request);
      remote.proof = wakeProof(); remote.view.original = remote.proof; await retain(remote.proof); guard(); return remote.proof; }),
    preview: vi.fn(async (_a, guard) => { guard(); }),
    preference: vi.fn(async (request, guard) => { guard(); const result = { enabled: request.enabled, revision: (BigInt(request.expectedRevision) + 1n).toString(),
      visual: { state: 'available' as const, visual: { version: 1 as const, wake: request.enabled ? wakeCommand().appearance : null } } }; remote.view.preference = result; return result; }),
    lock: async (_name, run) => run(), key: () => id(6),
  };
  const controller = new BoundCosmeticWakeWorkshopController(store, ports);
  return { factory, store, scope, remote, ports, controller };
}
it('uses genuine recipe Lodge materials and preview admission before one durable explicit craft', async () => {
  const { controller: c, ports, store, remote, scope } = setup(); await c.open(id(1));
  scope.ready = false; await c.begin(id(1), wakeCommand().recipe.recipeId); expect((await store.read()).operation).toBeNull();
  scope.ready = true; remote.view.applicationReady = remote.view.acceptingJobs = false; await c.begin(id(1), wakeCommand().recipe.recipeId); expect(ports.start).not.toHaveBeenCalled();
  remote.view = wakeView(); await c.begin(id(1), wakeCommand().recipe.recipeId); expect((await store.read()).operation?.command).toEqual(wakeCommand()); expect(ports.start).not.toHaveBeenCalled();
  await c.confirm(); expect(ports.start).toHaveBeenCalledOnce(); expect((await store.read()).operation?.proof).toEqual(wakeProof());
  for (const missing of ['lodge', 'workshop', 'stock', 'queue'] as const) { const v = wakeView(), b = v.selectedBase; if (b?.state !== 'available') throw Error('Fixture');
    if (missing === 'lodge') b.lodges = []; if (missing === 'workshop') b.workshops = []; if (missing === 'stock') b.craftingStock.forEach(s => s.available = '0');
    if (missing === 'queue') b.queue = [{ kind: 'cosmetic', jobId: id(8), recipe: command().recipe, startedAt: v.serverNow, readyAt: proof().status === 'accepted' ? '2026-09-30T13:00:00.000Z' : '' }];
    expect(wakeCraftBlock(v)).not.toBeNull(); }
});
it('unknown outcome keeps one original and accepted completion recovers after pause transfer and source outage', async () => {
  const { controller: c, ports, store, remote, scope } = setup(); vi.mocked(ports.start).mockRejectedValueOnce(new ApiError(503, 'Lost reply'));
  await c.open(id(1)); await c.begin(id(1), wakeCommand().recipe.recipeId); await c.confirm(); await c.archive(); expect((await store.read()).operation?.attempted).toBe(true); expect((await store.read()).archives).toEqual([]);
  scope.ready = scope.actions = scope.gate = false; scope.base = null; scope.epoch++; remote.failView = true; remote.proof = wakeProof(true);
  const reopened = new BoundCosmeticWakeWorkshopController(store, ports); await reopened.open(null);
  expect(reopened.snapshot().journal?.operation?.proof).toEqual(wakeProof(true)); expect(ports.start).toHaveBeenCalledOnce();
  await reopened.archive(); expect((await store.read()).archives[0]?.proof).toEqual(wakeProof(true));
});
it('retains late acceptance before obsolete account publication and never restores cancelled consent', async () => {
  const { controller: c, ports, store, scope } = setup(), reply = deferred<ReturnType<typeof wakeProof>>();
  vi.mocked(ports.start).mockImplementationOnce(async (_request, guard, retain) => { const p = await reply.promise; await retain(p); guard(); return p; });
  await c.open(id(1)); await c.begin(id(1), wakeCommand().recipe.recipeId); const pending = c.confirm();
  await vi.waitFor(() => expect(ports.start).toHaveBeenCalledOnce()); c.dismiss(); scope.active = false; reply.resolve(wakeProof()); await pending;
  expect((await store.read()).operation?.proof).toEqual(wakeProof()); expect(c.snapshot().view).toBeNull(); expect(c.snapshot().review).toBeNull();
});
it('Off uses the verified account revision through base ABA and current source outage while preserving global fences', async () => {
  const { controller: c, ports, scope, remote } = setup(); remote.view.original = wakeProof(true); remote.view.serverNow = wakeProof(true).serverNow;
  remote.view.preference = { enabled: true, revision: '2', visual: { state: 'unavailable', visual: null } }; await c.open(id(1));
  scope.base = null; scope.epoch += 2; c.invalidateBaseView(); scope.actions = scope.ready = false; remote.failView = true;
  expect(c.currentView()).toBeNull(); await c.setPreference(false);
  expect(ports.preference).toHaveBeenCalledExactlyOnceWith({ enabled: false, expectedRevision: '2' }, expect.any(Function));
  expect(c.currentPreference()).toMatchObject({ enabled: false, revision: '3' });
  scope.gate = false; await c.setPreference(false); expect(ports.preference).toHaveBeenCalledOnce();
});
it('account On requires completed ownership actual application and preview without a selected kingdom and conflicts never resend', async () => {
  const { controller: c, ports, scope, remote } = setup(); scope.base = null; await c.open(null); await c.setPreference(true); expect(ports.preference).not.toHaveBeenCalled();
  remote.view.original = wakeProof(true); remote.view.serverNow = wakeProof(true).serverNow;
  vi.mocked(ports.preview).mockRejectedValueOnce(Error('No preview')); await c.setPreference(true); expect(ports.preference).not.toHaveBeenCalled();
  vi.mocked(ports.preference).mockImplementationOnce(async () => { remote.view.preference = { enabled: true, revision: '1', visual: { state: 'available', visual: { version: 1, wake: wakeCommand().appearance } } }; throw new ApiError(409, 'Changed', 'BOUND_COSMETIC_PREFERENCE_CHANGED'); });
  await c.setPreference(true); expect(ports.preference).toHaveBeenCalledOnce(); expect(c.currentPreference()).toMatchObject({ enabled: true, revision: '1' }); expect(c.snapshot().notice).toContain('another window');
});
it('Wake and Awning controllers acquire the same account mutex while retaining distinct journals', async () => {
  const { factory, store, ports, controller: wake } = setup(), aStore = new WorkshopJournalStore(wakeIdentity, factory); stores.push(aStore);
  const entered = deferred<void>(), release = deferred<void>(); let held: string | null = null;
  const lock: WakeWorkshopPorts['lock'] = async (name, run) => { if (held === name) throw Error('Account request already active'); held = name; entered.resolve(); await release.promise; try { return await run(); } finally { held = null; } };
  ports.lock = lock;
  const awning = new BoundCosmeticWorkshopController(aStore, { ...ports, view: async () => view(), preference: async () => ({}) });
  const pending = wake.open(id(1)); await entered.promise; await awning.open(id(1)); expect(awning.snapshot().error).toContain('already active'); release.resolve(); await pending;
  expect(store.key).toBe(aStore.key); expect((await store.read()).operation).toBeNull(); expect((await aStore.read()).operation).toBeNull();
});

it('refreshes the account setting independently when selected kingdom authority or stock cannot load', async () => {
  const { controller: c, ports, remote } = setup();
  vi.mocked(ports.view).mockImplementation(async (base, guard) => { guard(); if (base) throw Error('Kingdom unavailable'); return { ...remote.view, selectedBase: null }; });
  await c.open(id(1)); expect(c.currentView()).toBeNull(); expect(c.currentPreference()).toBeNull();
  await c.refreshPreference(); expect(c.currentPreference()).toEqual(remote.view.preference);
  await c.setPreference(false); expect(ports.preference).toHaveBeenCalledOnce();
});
