import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { HarvesterController, type HarvesterPorts } from './controller';
import { HarvesterJournalStore } from './journal';
import { command, deferred, head, id, identity, policy, proof, start, view, type SettlementOptions } from './fixtures.test-support';
let factory: IDBFactory, store: HarvesterJournalStore, controller: HarvesterController, ports: HarvesterPorts;
let original: ReturnType<typeof command>, currentView: ReturnType<typeof view>, accepted: boolean, settlement: SettlementOptions;
let selected: string, baseEpoch: number, sessionEpoch: number, active: boolean, locked: boolean;
beforeEach(() => {
  factory = new IDBFactory(); store = new HarvesterJournalStore(identity, factory); original = start; currentView = view(); accepted = false; settlement = {};
  selected = id(1); baseEpoch = 0; sessionEpoch = 0; active = true; locked = false;
  ports = {
    get: vi.fn(async (path, guard) => { guard(); expect(path).toBe(`/harvesters?baseId=${id(1)}`); return currentView; }),
    getProof: vi.fn(async (request, guard, retain) => { guard(); const raw = proof({ ...original, request }, accepted, settlement); await retain(raw); guard(); return raw; }),
    post: vi.fn(async (request, guard, retain, _observe, firstAttempt) => { guard(); const saved = await store.read();
      expect(saved.operation?.command.request).toEqual(request); expect(saved.operation?.attemptRevision).toBe(saved.revision); expect(firstAttempt).toBe(true);
      accepted = true; const raw = proof(original, true); await retain(raw); guard(); return raw; }),
    capture: baseId => { const session = sessionEpoch, selection = baseEpoch; return () => {
      if (!active || session !== sessionEpoch || baseId && (baseId !== selected || selection !== baseEpoch)) throw new Error('session or base changed');
    }; },
    lock: async (_name, run) => { if (locked) throw new Error('Another tab owns this command'); locked = true; try { return await run(); } finally { locked = false; } },
    key: () => original.request.idempotencyKey,
  };
  controller = new HarvesterController(store, ports);
});
const begin = () => controller.beginSelection(original.request.baseId, original.request.harvesterId);
const hydrate = async (guard: () => void) => { guard(); };
describe('Harvester exact source and replacement consent', () => {
  it.each(['initial', 'current-head', 'expired-head', 'other-base-head'] as const)('reviews full %s consent and posts only after durable explicit confirmation', async kind => {
    const prior = kind === 'initial' ? null : head(kind === 'other-base-head' ? id(90) : id(1), kind === 'expired-head');
    original = command(prior); currentView = view(prior); await begin();
    expect(controller.snapshot().error).toBeNull(); expect(controller.snapshot().review?.command).toEqual(original); expect(ports.post).not.toHaveBeenCalled();
    if (kind === 'other-base-head') expect(controller.snapshot().review?.view.source).toBeNull();
    const before = structuredClone(currentView); await controller.confirm(); expect(controller.snapshot().error).toBeNull(); expect(ports.post).toHaveBeenCalledOnce();
    expect(vi.mocked(ports.post).mock.calls[0]![0].expectedSourceId).toBe(prior?.sourceId ?? null);
    expect((await store.read()).operation?.proof).toEqual(proof(original, true)); expect(currentView).toEqual(before);
    await controller.finish(hydrate); expect((await store.read()).archives[0]?.operation.command).toEqual(original);
  });
  it('recovers lost acceptance before paused provider/flags, missing home/facility, changed head or lost base authority', async () => {
    ports.post = vi.fn(async () => { accepted = true; throw new Error('lost acknowledgment'); }); await begin(); await controller.confirm();
    expect((await store.read()).operation?.proof).toBeNull(); selected = id(9); baseEpoch++; currentView = { ...view(head(id(90))), acceptingSelections: false, home: null, facilities: [] };
    controller = new HarvesterController(new HarvesterJournalStore(identity, factory), ports); vi.mocked(ports.get).mockClear();
    await controller.open(); await controller.reviewCommand(); await controller.confirm(); await controller.finish(hydrate);
    expect((await store.read()).archives[0]?.operation.proof?.status).toBe('accepted'); expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('unknown retries preserve full replacement consent/key/body and require another explicit review', async () => {
    original = command(head(id(90), true)); currentView = view(original.replacedSource);
    ports.post = vi.fn().mockRejectedValue(new Error('request outcome unknown')); await begin(); await controller.confirm(); const attempted = (await store.read()).operation!.attemptRevision;
    controller = new HarvesterController(store, ports); await controller.open(); await controller.confirm(); expect(ports.post).toHaveBeenCalledOnce();
    await controller.beginSelection(id(1), id(9)); expect((await store.read()).operation?.command).toEqual(original);
    await controller.reviewCommand(); await controller.confirm(); expect(vi.mocked(ports.post).mock.calls.map(call => [call[0], call[4]])).toEqual([[original.request, true], [original.request, false]]);
    expect((await store.read()).operation!.attemptRevision).toBeGreaterThan(attempted!); await controller.abandonDraft(); await controller.archiveRefusal(); expect((await store.read()).archives).toHaveLength(0);
  });
  it.each(['paused', 'home', 'facility', 'future-facility', 'future-head', 'wrong-wallet', 'wrong-base', 'wrong-projection'] as const)('%s admission cannot create intent or POST', async kind => {
    if (kind === 'paused') currentView.acceptingSelections = false;
    else if (kind === 'home') currentView.home = null;
    else if (kind === 'facility') currentView.facilities = [];
    else if (kind === 'future-facility') currentView.facilities[0]!.harvesterCompletedAt = '2026-09-23T12:00:00.000Z';
    else if (kind === 'future-head') { currentView = view(head()); currentView.walletSource!.admittedAt = '2026-09-23T12:00:00.000Z'; currentView.walletSource!.leaseExpiresAt = '2026-09-24T12:00:00.000Z'; currentView.source = currentView.walletSource; }
    else if (kind === 'wrong-wallet') currentView.wallet = 'So11111111111111111111111111111111111111112';
    else if (kind === 'wrong-base') currentView.baseId = id(9);
    else currentView = { ...view(head(id(90))), source: head(id(90)) };
    await begin(); expect(controller.snapshot().error).not.toBeNull(); expect((await store.read()).operation).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['facility', 'completion', 'policy', 'realm', 'head-id', 'head-metadata', 'head-gone', 'provider'] as const)('fresh %s change retires earlier review without rewriting original intent', async kind => {
    original = command(head()); currentView = view(original.replacedSource); await begin(); const frozen = structuredClone((await store.read()).operation!.command);
    if (kind === 'facility') currentView.facilities[0]!.completedBuildJobId = id(10);
    else if (kind === 'completion') currentView.facilities[0]!.harvesterCompletedAt = '2026-09-22T11:00:00.000Z';
    else if (kind === 'policy') currentView.policy = { ...currentView.policy, grossPerCadence: String(BigInt(policy.grossPerCadence) + 1n) };
    else if (kind === 'realm') currentView.home!.realmId = 'frostveil';
    else if (kind === 'head-id') { currentView.walletSource!.sourceId = id(10); currentView.source = currentView.walletSource; }
    else if (kind === 'head-metadata') { currentView.walletSource!.harvesterId = id(10); currentView.source = currentView.walletSource; }
    else if (kind === 'head-gone') { currentView.walletSource = null; currentView.source = null; }
    else currentView.acceptingSelections = false;
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().review).toBeNull(); expect((await store.read()).operation?.command).toEqual(frozen);
  });
  it('refuses a newly appeared wallet head after an initial null review instead of silently consenting to replacement', async () => {
    await begin(); currentView = view(head(id(90))); await controller.confirm(); expect(ports.post).not.toHaveBeenCalled();
    expect((await store.read()).operation?.command.request.expectedSourceId).toBeNull();
  });
  it('accepts persisted home provenance in the same realm without inventing client home or term fields', async () => {
    await begin(); currentView.home = { ...currentView.home!, source: 'free_assignment' }; await controller.confirm();
    expect(controller.snapshot().error).toBeNull(); expect(ports.post).toHaveBeenCalledOnce(); expect(vi.mocked(ports.post).mock.calls[0]![0]).toEqual(start.request);
  });
  it.each(['intent', 'attempt'] as const)('failed durable %s write prevents source enqueue', async stage => {
    if (stage === 'attempt') await begin(); vi.spyOn(store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    if (stage === 'intent') await begin(); else await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().error).toContain('disk full');
  });
  it.each(['base-aba', 'session', 'hidden', 'dismiss'] as const)('rechecks %s at actual enqueue and preserves uncertain attempted consent', async kind => {
    await begin(); const entered = deferred(), release = deferred(); ports.post = vi.fn(async (_request, guard, retain) => { entered.resolve(); await release.promise; guard(); accepted = true; const raw = proof(start, true); await retain(raw); return raw; });
    const work = controller.confirm(); await entered.promise;
    if (kind === 'base-aba') { selected = id(9); baseEpoch++; selected = id(1); baseEpoch++; }
    else if (kind === 'session') sessionEpoch++; else if (kind === 'hidden') active = false; else controller.dismiss();
    const snapshot = controller.snapshot(); release.resolve(); await work; expect(accepted).toBe(false); expect((await store.read()).operation?.attemptRevision).not.toBeNull();
    expect((await store.read()).operation?.proof).toBeNull(); expect(controller.snapshot()).toBe(snapshot);
  });
  it.each(['POST', 'GET'] as const)('owned %s acceptance survives retired UI without publishing stock or inventing events', async kind => {
    await begin(); const entered = deferred(), release = deferred();
    if (kind === 'POST') ports.post = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; });
    else ports.getProof = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; });
    const work = kind === 'POST' ? controller.confirm() : controller.open(); await entered.promise; controller.dismiss(); sessionEpoch++; const snapshot = controller.snapshot(); release.resolve(); await work;
    expect((await store.read()).operation?.proof).toEqual(proof(start, true)); expect(controller.snapshot()).toBe(snapshot); expect(currentView.rawStock).toEqual(view().rawStock);
  });
  it('failed accepted response persistence leaves recoverable uncertainty and reload uses GET', async () => {
    await begin(); ports.post = vi.fn(async (_request, guard, retain) => { guard(); accepted = true; vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('receipt storage full')); const raw = proof(start, true); await retain(raw); return raw; });
    await controller.confirm(); expect((await store.read()).operation?.proof).toBeNull(); controller = new HarvesterController(store, ports); await controller.open();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('holds cross-tab ownership through durable response retention and prevents reentrant confirmation', async () => {
    await begin(); const entered = deferred(), release = deferred(); ports.post = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); return raw; });
    const work = controller.confirm(); await entered.promise; const calls = vi.mocked(ports.getProof).mock.calls.length; await controller.confirm();
    const other = new HarvesterController(new HarvesterJournalStore(identity, factory), ports); await other.open();
    expect(other.snapshot().error).toContain('Another tab'); expect(ports.getProof).toHaveBeenCalledTimes(calls); release.resolve(); await work; expect(ports.post).toHaveBeenCalledOnce();
  });
});
describe('Harvester original refusals and incremental settlement recovery', () => {
  const refusal = new ApiError(409, 'source changed', 'HARVESTER_SOURCE_CHANGED');
  it.each([false, true])('records only original first-attempt refusal at its exact revision; competing=%s', async competing => {
    let attempt = 0; ports.post = vi.fn(async (_request, _guard, _retain, observe) => { attempt = (await store.read()).revision; if (competing) await store.compareAndSet(attempt, old => old); await observe(refusal); await observe(refusal); throw refusal; });
    await begin(); await controller.confirm(); const saved = await store.read(); expect(saved.revision).toBe(attempt + 1);
    expect(saved.operation?.refusal).toEqual(competing ? null : { phase: 'first_post', status: 409, code: 'HARVESTER_SOURCE_CHANGED' });
  });
  it('later refusal or a delayed original callback cannot erase uncertainty from an earlier ambiguous selection', async () => {
    let delayed!: (error: unknown) => Promise<void>; ports.post = vi.fn(async (_request, _guard, _retain, observe) => { delayed = observe; throw new Error('ambiguous first attempt'); }); await begin(); await controller.confirm();
    ports.post = vi.fn(async (_request, _guard, _retain, observe, first) => { expect(first).toBe(false); await delayed(refusal); await observe(refusal); throw refusal; });
    await controller.reviewCommand(); await controller.confirm(); await controller.archiveRefusal(); expect((await store.read()).operation?.refusal).toBeNull(); expect((await store.read()).archives).toHaveLength(0);
  });
  it('positive acceptance wins over earlier refusal while retaining that original refusal evidence', async () => {
    ports.post = vi.fn().mockRejectedValue(refusal); await begin(); await controller.confirm(); accepted = true; selected = id(9); currentView.acceptingSelections = false;
    await controller.archiveRefusal(); expect((await store.read()).operation).toMatchObject({ proof: { status: 'accepted' }, refusal: { code: 'HARVESTER_SOURCE_CHANGED' } });
    expect((await store.read()).archives).toHaveLength(0); await controller.finish(hydrate); expect((await store.read()).archives[0]?.reason).toBe('accepted');
  });
  it.each(['draft', 'refused'] as const)('archived %s can gain acceptance/events without rewriting historical absence or reason', async kind => {
    await begin(); if (kind === 'refused') { ports.post = vi.fn().mockRejectedValue(refusal); await controller.confirm(); }
    if (kind === 'draft') await controller.abandonDraft(); else await controller.archiveRefusal(); const before = (await store.read()).archives[0]!;
    vi.mocked(ports.getProof).mockClear(); await controller.open(); expect(ports.getProof).not.toHaveBeenCalled();
    accepted = true; await controller.checkArchived(start.request.idempotencyKey); settlement = { events: 2, closed: true }; await controller.open();
    expect((await store.read()).archives[0]).toEqual({ ...before, operation: { ...before.operation, proof: proof(start, true, settlement) } }); expect(ports.post).toHaveBeenCalledTimes(kind === 'draft' ? 0 : 1);
  });
  it('continues accepted archive GET after custody stop until earned frontier and closure arrive, then stops automatic checks', async () => {
    await begin(); await controller.confirm(); await controller.finish(hydrate); const receipt = (await store.read()).archives[0]!.operation.proof!.originalReceipt;
    settlement = { stopAfter: 2 }; await controller.open(); vi.mocked(ports.getProof).mockClear();
    settlement = { events: 1, stopAfter: 2 }; await controller.open(); expect(ports.getProof).toHaveBeenCalledOnce();
    settlement = { events: 2, stopAfter: 2, closed: true }; await controller.open();
    const saved = await store.read(); expect(saved.archives[0]!.operation.proof?.originalReceipt).toEqual(receipt);
    expect(saved.archives[0]!.operation.proof?.settlement).toEqual(proof(start, true, settlement).settlement);
    vi.mocked(ports.getProof).mockClear(); await controller.open(); expect(ports.getProof).not.toHaveBeenCalled();
    settlement = { events: 1, stopAfter: 2 }; await controller.checkArchived(start.request.idempotencyKey); expect(controller.snapshot().error).toContain('prefix'); expect((await store.read()).archives).toEqual(saved.archives);
    accepted = false; await controller.checkArchived(start.request.idempotencyKey); expect(controller.snapshot().error).toContain('missing'); expect((await store.read()).archives).toEqual(saved.archives);
    expect(ports.post).toHaveBeenCalledOnce(); expect(currentView.rawStock).toEqual(view().rawStock);
  });
  it('owned archived events survive session retirement and do not overwrite a newer active selection', async () => {
    await begin(); await controller.confirm(); await controller.finish(hydrate);
    const newer = command(head(), id(20)); let saved = await store.read();
    saved = await store.compareAndSet(saved.revision, old => ({ ...old, operation: { command: newer, attemptRevision: null, proof: null, refusal: null } }));
    const entered = deferred(), release = deferred();
    ports.getProof = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true, { events: 2 }); await retain(raw); guard(); return raw; });
    const work = controller.checkArchived(start.request.idempotencyKey); await entered.promise; controller.dismiss(); sessionEpoch++; const snapshot = controller.snapshot(); release.resolve(); await work;
    expect((await store.read()).archives[0]!.operation.proof).toEqual(proof(start, true, { events: 2 })); expect((await store.read()).operation).toEqual(saved.operation);
    expect(controller.snapshot()).toBe(snapshot); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('an expired server display interval cannot invent earnings, closure, stock or renewal', async () => {
    await begin(); await controller.confirm(); const future = proof(start, true); if (future.status !== 'accepted') throw new Error('fixture');
    future.serverNow = new Date(Date.parse(future.originalReceipt.source.leaseExpiresAt) + 1_000).toISOString();
    ports.getProof = vi.fn(async (_request, guard, retain) => { guard(); await retain(future); return future; }); await controller.open();
    expect((await store.read()).operation?.proof?.settlement).toEqual({ events: [], closure: null, custodyStop: null });
    expect(ports.post).toHaveBeenCalledOnce(); expect(currentView.rawStock).toEqual(view().rawStock);
  });
  it('refuses an out-of-order active event response and preserves the greatest observed prefix', async () => {
    await begin(); await controller.confirm(); settlement = { events: 2 }; await controller.open(); const before = await store.read();
    settlement = { events: 1 }; await controller.open(); expect(controller.snapshot().error).toContain('prefix'); expect((await store.read()).operation).toEqual(before.operation);
    settlement = { events: 3 }; await controller.open(); expect((await store.read()).operation?.proof?.settlement?.events).toHaveLength(3); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('failed current hydration or competing revision retains active acceptance for later explicit finish', async () => {
    await begin(); await controller.confirm(); await controller.finish(async () => { throw new Error('current hydration failed'); }); expect((await store.read()).archives).toHaveLength(0);
    await controller.finish(async guard => { guard(); const saved = await store.read(); await store.compareAndSet(saved.revision, old => old); }); expect(controller.snapshot().error).toContain('Another tab');
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); await controller.finish(hydrate); expect((await store.read()).archives).toHaveLength(1);
  });
  it('a corrupt journal or missing original endpoint fails closed without retrying selection', async () => {
    vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('corrupt original journal')); await controller.open(); expect(controller.snapshot().error).toContain('corrupt'); expect(ports.get).not.toHaveBeenCalled();
    ports.getProof = vi.fn().mockRejectedValue(new Error('original endpoint missing')); await begin(); await controller.confirm(); expect((await store.read()).operation?.attemptRevision).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
});
