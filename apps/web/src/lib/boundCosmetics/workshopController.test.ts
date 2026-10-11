// @vitest-environment happy-dom
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { BoundCosmeticWorkshopController, awningCraftBlock, type WorkshopPorts } from './workshopController';
import { WorkshopJournalStore, parseWorkshopJournal } from './workshopJournal';
import { command, deferred, id, identity, proof, view } from './workshopFixtures.test-support';
const stores: WorkshopJournalStore[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map(s => s.close())); });
function setup() {
  const store = new WorkshopJournalStore(identity, new IDBFactory()); stores.push(store);
  const scope = { epoch: 0, selected: id(1), visible: true, actions: true, gate: true, authed: true };
  const remote = { view: view(), proof: proof(command(), false) };
  const ports: WorkshopPorts = {
    capture: (kind, baseId) => { const epoch = scope.epoch; return () => {
      if (!scope.authed || !scope.visible || kind !== 'account' && (epoch !== scope.epoch || baseId !== scope.selected)
        || (kind === 'craft' || kind === 'preference') && !scope.gate || kind === 'craft' && !scope.actions) throw Error('Scope changed');
    }; },
    view: vi.fn(async (_base, guard) => { guard(); return structuredClone(remote.view); }),
    original: vi.fn(async (_request, guard, retain) => { if (remote.proof.status === 'accepted') await retain(remote.proof); guard(); return structuredClone(remote.proof); }),
    start: vi.fn(async (request, guard, retain) => {
      const original = (await store.read()).operation!; expect(original.attempted).toBe(true); expect(original.command.request).toEqual(request);
      remote.proof = proof(original.command); remote.view.originals = [remote.proof];
      await retain(remote.proof); guard(); return structuredClone(remote.proof);
    }),
    preference: vi.fn(async (request, guard) => { guard(); const base = remote.view.selectedBase; if (base?.state !== 'available') throw Error('Fixture base unavailable');
      base.preference = { enabled: request.enabled, revision: (BigInt(request.expectedRevision) + 1n).toString() };
      return { baseId: request.baseId, ...base.preference, visual: base.visual };
    }),
    preview: vi.fn(async (_appearance, guard) => { guard(); }),
    lock: async (_name, run) => run(), key: vi.fn(() => id(5)),
  };
  const controller = new BoundCosmeticWorkshopController(store, ports);
  return { store, ports, scope, remote, controller };
}
it('saves exact reviewed terms before dispatch and never crafts from open, refresh or review', async () => {
  const { controller: c, ports, store } = setup(); await c.open(id(1)); await c.begin(id(1), command().request.recipeId);
  expect(ports.start).not.toHaveBeenCalled(); expect((await store.read()).operation).toEqual({ command: command(), attempted: false, proof: null });
  expect(c.snapshot().review?.command).toEqual(command()); await c.confirm();
  expect(ports.start).toHaveBeenCalledOnce(); expect((await store.read()).operation?.proof?.status).toBe('accepted');
  await c.open(id(1)); expect(ports.start).toHaveBeenCalledOnce();
});
it('recovers a lost accepted response after reopening despite pause and current-view outage', async () => {
  const { controller: c, ports, store, remote, scope } = setup();
  vi.mocked(ports.start).mockImplementationOnce(async () => { remote.proof = proof((await store.read()).operation!.command, true, true); throw Error('Lost reply'); });
  await c.open(id(1)); await c.begin(id(1), command().request.recipeId); await c.confirm();
  expect((await store.read()).operation?.attempted).toBe(true); expect((await store.read()).operation?.proof).toBeNull();
  scope.actions = false; scope.gate = false; vi.mocked(ports.view).mockRejectedValue(Error('Current provider unavailable'));
  const reopened = new BoundCosmeticWorkshopController(store, ports); await reopened.open(id(1));
  expect(reopened.snapshot().journal?.operation?.proof?.completion).not.toBeNull(); expect(reopened.snapshot().view).toBeNull();
  expect(ports.start).toHaveBeenCalledOnce();
});
it('unknown outcomes keep one key through reopen and require another explicit review before the same-request resend', async () => {
  const { controller: c, ports, store } = setup();
  vi.mocked(ports.start).mockRejectedValueOnce(Error('Reply lost'));
  await c.open(id(1)); await c.begin(id(1), command().request.recipeId); await c.confirm();
  const reopened = new BoundCosmeticWorkshopController(store, ports); await reopened.open(id(1)); await reopened.confirm();
  expect(ports.start).toHaveBeenCalledTimes(1); expect(reopened.snapshot().error).toContain('Review');
  await reopened.reviewOriginal(); expect(ports.start).toHaveBeenCalledTimes(1); await reopened.confirm();
  expect(ports.start).toHaveBeenCalledTimes(2); expect(vi.mocked(ports.start).mock.calls.map(c => c[0])).toEqual([command().request, command().request]);
  expect(ports.key).toHaveBeenCalledOnce();
});
it('never archives or replaces an attempted unknown request, including typed server errors', async () => {
  const { controller: c, ports, store } = setup(); vi.mocked(ports.start).mockRejectedValue(new ApiError(409, 'Busy', 'ORDINARY_CRAFTING_BUSY'));
  await c.open(id(1)); await c.begin(id(1), command().request.recipeId); await c.confirm(); await c.archive();
  expect(c.snapshot().error).toContain('unknown outcome'); await c.begin(id(1), 'craft_artisan_market_awning_t2_v1');
  expect((await store.read()).operation?.command).toEqual(command()); expect((await store.read()).archives).toHaveLength(0); expect(ports.key).toHaveBeenCalledOnce();
});
it('retains a late accepted original under its original identity without publishing into an obsolete view', async () => {
  const { controller: c, ports, store, scope } = setup(); const pending = deferred<ReturnType<typeof proof>>();
  vi.mocked(ports.start).mockImplementationOnce(async (_request, guard, retain) => { const p = await pending.promise; await retain(p); guard(); return p; });
  await c.open(id(1)); await c.begin(id(1), command().request.recipeId); const running = c.confirm();
  await vi.waitFor(() => expect(ports.start).toHaveBeenCalledOnce()); c.dismiss(); scope.authed = false;
  pending.resolve(proof()); await running;
  expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect(c.snapshot().view).toBeNull(); expect(c.snapshot().review).toBeNull();
});
it('invalidates snapshot and review immediately after selected kingdom ABA or backgrounding', async () => {
  const { controller: c, ports, scope } = setup(); await c.open(id(1)); await c.begin(id(1), command().request.recipeId);
  scope.epoch += 2; expect(c.currentView()).toBeNull(); await c.confirm(); expect(ports.start).not.toHaveBeenCalled();
  await c.open(id(1)); scope.visible = false; expect(c.currentView()).toBeNull(); await c.checkOriginal(); expect(ports.start).not.toHaveBeenCalled();
});
it('fresh confirmation refuses a newly occupied common queue without consuming or replacing the saved draft', async () => {
  const { controller: c, ports, remote, store } = setup(); await c.open(id(1)); await c.begin(id(1), command().request.recipeId);
  const base = remote.view.selectedBase!; if (base.state !== 'available') throw Error('Fixture');
  const other = remote.view.recipes[3]!.recipe; base.queue = [{ kind: 'cosmetic', jobId: id(90), recipe: other, startedAt: remote.view.serverNow, readyAt: '2026-09-30T12:20:00.000Z' }];
  await c.confirm(); expect(c.snapshot().error).toContain('Workshop is busy'); expect(ports.start).not.toHaveBeenCalled();
  expect((await store.read()).operation?.attempted).toBe(false);
});
it('requires server Blueprint, completed facilities, available materials and application admission', () => {
  for (const change of ['blueprint', 'workshop', 'market', 'stock', 'application'] as const) {
    const v = view(), b = v.selectedBase!; if (b.state !== 'available') throw Error('Fixture');
    if (change === 'blueprint') v.blueprint = { state: 'not-earned', proof: null };
    if (change === 'workshop') b.workshops = [];
    if (change === 'market') b.markets = [];
    if (change === 'stock') b.craftingStock.forEach(s => s.available = '0');
    if (change === 'application') v.applicationReady = v.acceptingJobs = false;
    expect(awningCraftBlock(v, v.recipes[0]!)).not.toBeNull();
  }
});
it('missing or corrupt selected art blocks both review and confirmation without a material request', async () => {
  const { controller: c, ports, store } = setup(); await c.open(id(1));
  vi.mocked(ports.preview).mockRejectedValueOnce(Error('Selected art unavailable'));
  await c.begin(id(1), command().request.recipeId); expect(c.snapshot().review).toBeNull(); expect((await store.read()).operation).toBeNull();
  await c.begin(id(1), command().request.recipeId); expect(c.snapshot().review).not.toBeNull();
  vi.mocked(ports.preview).mockRejectedValueOnce(Error('Selected art became corrupt'));
  await c.confirm(); expect(ports.start).not.toHaveBeenCalled(); expect((await store.read()).operation?.attempted).toBe(false);
});
it('preference conflict refreshes the current choice and never automatically inverts or resends it', async () => {
  const { controller: c, ports, remote } = setup(); remote.view.originals = [proof(command(), true, true)]; remote.view.serverNow = '2026-09-30T12:10:00.000Z';
  if (remote.view.selectedBase?.state === 'available') remote.view.selectedBase.markets[0]!.level = 1;
  await c.open(id(1));
  vi.mocked(ports.preference).mockImplementationOnce(async () => { const b = remote.view.selectedBase!; if (b.state === 'available') b.preference = { enabled: true, revision: '1' }; throw new ApiError(409, 'Changed', 'BOUND_COSMETIC_PREFERENCE_CHANGED'); });
  await c.setPreference(id(1), true); expect(ports.preference).toHaveBeenCalledOnce();
  expect(vi.mocked(ports.preference).mock.calls[0]![0]).toEqual({ baseId: id(1), enabled: true, expectedRevision: '0' });
  expect(c.snapshot().notice).toContain('another window'); expect(c.currentView()?.selectedBase).toMatchObject({ preference: { enabled: true, revision: '1' } });
});
it('accepted history still checks original completion during provider outage after archiving', async () => {
  const { controller: c, ports, store, remote } = setup(); await c.open(id(1)); await c.begin(id(1), command().request.recipeId); await c.confirm(); await c.archive();
  remote.proof = proof(command(), true, true); vi.mocked(ports.view).mockRejectedValue(Error('Provider unavailable'));
  const reopened = new BoundCosmeticWorkshopController(store, ports); await reopened.open(id(1)); await reopened.checkReceipt(id(5));
  expect(reopened.snapshot().journal?.archives[0]?.proof?.completion).not.toBeNull(); expect(ports.start).toHaveBeenCalledOnce();
});
it('off remains available through cosmetic pause/outage, but keeps the global mutation fence', async () => {
  const { controller: c, ports, remote, scope } = setup(); remote.view.acceptingJobs = remote.view.applicationReady = false;
  const b = remote.view.selectedBase!; if (b.state === 'available') b.preference = { enabled: true, revision: '2' };
  scope.actions = false; await c.open(id(1)); await c.setPreference(id(1), false); expect(ports.preference).toHaveBeenCalledOnce();
  scope.gate = false; await c.setPreference(id(1), false); expect(ports.preference).toHaveBeenCalledOnce();
});
it('strict journal rejects foreign identity, changed terms, accepted-proof regression and stale tab revisions', async () => {
  const { controller: c, store } = setup(); await c.open(id(1)); await c.begin(id(1), command().request.recipeId); await c.confirm();
  const saved = await store.read(); expect(() => parseWorkshopJournal(saved, { ...identity, wallet: '3'.repeat(32) })).toThrow();
  await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, proof: null } }))).rejects.toThrow('cannot change');
  await expect(store.compareAndSet(saved.revision - 1, old => old)).rejects.toThrow('Another tab');
  await expect(store.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, command: { ...old.operation!.command, request: { ...old.operation!.command.request, baseId: id(99) } } } }))).rejects.toThrow();
});
it('does not show a foreign account/base snapshot or persist a mismatched acceptance', async () => {
  const { controller: c, remote, ports, store } = setup(); remote.view.wallet = '3'.repeat(32); remote.view.blueprint = { state: 'not-earned', proof: null };
  await c.open(id(1)); expect(c.snapshot().view).toBeNull();
  remote.view = view(); await c.open(id(1)); await c.begin(id(1), command().request.recipeId);
  vi.mocked(ports.start).mockResolvedValueOnce({ ...proof(), wallet: '3'.repeat(32) }); await c.confirm(); expect((await store.read()).operation?.proof).toBeNull();
});
