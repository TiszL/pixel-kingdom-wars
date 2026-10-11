import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StarterRouteIdSchema } from '@shardkeep/shared/phaseEExpeditions';
import { ApiError } from '../api';
import { StarterExpeditionController, type StarterExpeditionPorts } from './controller';
import { StarterExpeditionJournalStore, parseStarterExpeditionCommand } from './journal';
import { command, deferred, id, identity, proof, start, view } from './fixtures.test-support';
let factory: IDBFactory, store: StarterExpeditionJournalStore, controller: StarterExpeditionController, ports: StarterExpeditionPorts;
let original: ReturnType<typeof command>, currentView: ReturnType<typeof view>, accepted: boolean, returned: boolean, selected: string, baseEpoch: number, sessionEpoch: number, active: boolean, locked: boolean;
beforeEach(() => {
  factory = new IDBFactory(); store = new StarterExpeditionJournalStore(identity, factory); original = start; currentView = view(); accepted = false; returned = false;
  selected = id(1); baseEpoch = 0; sessionEpoch = 0; active = true; locked = false;
  ports = {
    get: vi.fn(async (path, guard) => { guard(); expect(path).toBe(`/starter-expeditions?baseId=${id(1)}`); return currentView; }),
    getProof: vi.fn(async (request, guard, retain) => { guard(); const raw = proof({ ...original, request }, accepted, returned); await retain(raw); guard(); return raw; }),
    post: vi.fn(async (request, guard, retain, _observe, firstAttempt) => { guard(); const saved = await store.read();
      expect(saved.operation?.command.request).toEqual(request); expect(saved.operation?.attemptRevision).toBe(saved.revision); expect(firstAttempt).toBe(true);
      accepted = true; const raw = proof(original, true); await retain(raw); guard(); return raw; }),
    capture: baseId => { const session = sessionEpoch, selection = baseEpoch; return () => {
      if (!active || session !== sessionEpoch || baseId && (baseId !== selected || selection !== baseEpoch)) throw new Error('session or base changed');
    }; },
    lock: async (_name, run) => { if (locked) throw new Error('Another tab owns this command'); locked = true; try { return await run(); } finally { locked = false; } },
    key: () => original.request.idempotencyKey,
  };
  controller = new StarterExpeditionController(store, ports);
});
const begin = () => controller.beginDeparture(original.request.baseId, original.request.routeId);
const hydrate = async (guard: () => void) => { guard(); };
describe('starter departure exact route consent', () => {
  it.each(StarterRouteIdSchema.options)('reviews the complete server route %s and posts only after durable explicit confirmation', async routeId => {
    original = command(routeId); await begin(); expect(controller.snapshot().error).toBeNull(); expect(controller.snapshot().review?.command).toEqual(original);
    expect(ports.post).not.toHaveBeenCalled(); expect(currentView.rawStock.every(stock => stock.available === '0')).toBe(true);
    const before = structuredClone(currentView); await controller.confirm(); expect(controller.snapshot().error).toBeNull(); expect(ports.post).toHaveBeenCalledOnce();
    expect((await store.read()).operation?.proof).toEqual(proof(original, true)); expect(currentView).toEqual(before);
    await controller.finish(hydrate); expect((await store.read()).archives[0]?.operation.command).toEqual(original);
  });
  it('recovers lost acceptance before paused provider/flags, missing home/Lodge/vehicle or changed custody', async () => {
    ports.post = vi.fn(async () => { accepted = true; throw new Error('lost acknowledgment'); }); await begin(); await controller.confirm();
    expect((await store.read()).operation?.proof).toBeNull(); selected = id(9); baseEpoch++; currentView = { ...view(), acceptingDepartures: false, home: null, routes: [], lodgeCompletedAt: null, installation: null };
    controller = new StarterExpeditionController(new StarterExpeditionJournalStore(identity, factory), ports); vi.mocked(ports.get).mockClear();
    await controller.open(); await controller.reviewCommand(); await controller.confirm(); await controller.finish(hydrate);
    expect((await store.read()).archives[0]?.operation.proof?.status).toBe('accepted'); expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('retains historical route versions without loading the current catalogue or reinterpreting saved rewards', async () => {
    original = parseStarterExpeditionCommand({ ...start, request: { ...start.request, routeVersion: 1, rewardVersion: 1 }, route: { ...start.route,
      routeCatalogueVersion: 1, rewardTableVersion: 1, durationSec: 13, grossQuantity: '100', netQuantity: '97', islandPoolQuantity: '3' } });
    await store.compareAndSet(0, old => ({ ...old, operation: { command: original, attemptRevision: null, proof: null, refusal: null } }));
    accepted = true; currentView.acceptingDepartures = false; await controller.open();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('unknown retries preserve the exact route/key/body and need a new explicit review', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('request outcome unknown')); await begin(); await controller.confirm(); const attempted = (await store.read()).operation!.attemptRevision;
    controller = new StarterExpeditionController(store, ports); await controller.open(); await controller.confirm(); expect(ports.post).toHaveBeenCalledOnce();
    await controller.beginDeparture(id(1), 'coastal_survey'); expect((await store.read()).operation?.command).toEqual(start);
    await controller.reviewCommand(); await controller.confirm(); expect(vi.mocked(ports.post).mock.calls.map(call => [call[0], call[4]])).toEqual([[start.request, true], [start.request, false]]);
    expect((await store.read()).operation!.attemptRevision).toBeGreaterThan(attempted!); await controller.abandonDraft(); await controller.archiveRefusal(); expect((await store.read()).archives).toHaveLength(0);
  });
  it.each(['paused', 'home', 'lodge', 'installation', 'flight', 'future-installation', 'future-flight', 'wrong-wallet', 'wrong-base'] as const)('%s current admission cannot create a new intent or POST', async kind => {
    if (kind === 'paused') currentView.acceptingDepartures = false;
    else if (kind === 'home') { currentView.home = null; currentView.routes = []; }
    else if (kind === 'lodge') currentView.lodgeCompletedAt = null;
    else if (kind === 'installation') currentView.installation = null;
    else if (kind === 'future-installation') currentView.installation!.installedAt = '2026-09-23T12:00:00.000Z';
    else if (kind === 'wrong-wallet') currentView.wallet = 'So11111111111111111111111111111111111111112';
    else if (kind === 'wrong-base') currentView.baseId = id(9);
    else {
      const flight = proof(start, true); if (flight.status !== 'accepted') throw new Error('fixture'); const r = flight.receipt;
      currentView.flight = { expeditionId: r.expeditionId, installationId: r.installationId, route: r.route, departedAt: r.departedAt, returnsAt: r.returnsAt, termId: r.termId, termHash: r.termHash };
      if (kind === 'future-flight') { currentView.flight.departedAt = '2026-09-23T12:00:00.000Z'; currentView.flight.returnsAt = new Date(Date.parse(currentView.flight.departedAt) + r.route.durationSec * 1_000).toISOString(); }
    }
    await begin(); expect(controller.snapshot().error).not.toBeNull(); expect((await store.read()).operation).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['route', 'vehicle', 'lodge', 'provider', 'home'] as const)('fresh %s changes retire earlier consent without rewriting original intent', async kind => {
    await begin(); const frozen = structuredClone((await store.read()).operation!.command);
    if (kind === 'route') currentView.routes = currentView.routes.map(route => route.routeId === start.request.routeId ? { ...route, durationSec: route.durationSec + 1 } : route);
    else if (kind === 'vehicle') currentView.installation!.installationId = id(9);
    else if (kind === 'lodge') currentView.lodgeCompletedAt = null;
    else if (kind === 'provider') currentView.acceptingDepartures = false;
    else { currentView.home = null; currentView.routes = []; }
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().review).toBeNull(); expect((await store.read()).operation?.command).toEqual(frozen);
  });
  it('does not reinterpret an unpersisted free-home preview as a client home assignment or demand a new command when the same realm becomes assigned', async () => {
    await begin(); currentView.home = { ...currentView.home!, source: 'free_assignment' }; await controller.confirm();
    expect(controller.snapshot().error).toBeNull(); expect(ports.post).toHaveBeenCalledOnce(); expect(vi.mocked(ports.post).mock.calls[0]![0]).toEqual(start.request);
    expect(Object.hasOwn(vi.mocked(ports.post).mock.calls[0]![0], 'home')).toBe(false);
  });
  it.each(['intent', 'attempt'] as const)('failed durable %s write prevents departure enqueue', async stage => {
    if (stage === 'attempt') await begin(); vi.spyOn(store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    if (stage === 'intent') await begin(); else await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().error).toContain('disk full');
  });
  it.each(['base-aba', 'session', 'hidden', 'dismiss'] as const)('rechecks %s at actual enqueue and leaves an uncertain attempted command after refusal', async kind => {
    await begin(); const entered = deferred(), release = deferred(); ports.post = vi.fn(async (_request, guard, retain) => { entered.resolve(); await release.promise; guard(); accepted = true; const raw = proof(start, true); await retain(raw); return raw; });
    const work = controller.confirm(); await entered.promise;
    if (kind === 'base-aba') { selected = id(9); baseEpoch++; selected = id(1); baseEpoch++; }
    else if (kind === 'session') sessionEpoch++; else if (kind === 'hidden') active = false; else controller.dismiss();
    const snapshot = controller.snapshot(); release.resolve(); await work; expect(accepted).toBe(false); expect((await store.read()).operation?.attemptRevision).not.toBeNull();
    expect((await store.read()).operation?.proof).toBeNull(); expect(controller.snapshot()).toBe(snapshot);
  });
  it.each(['POST', 'GET'] as const)('owned %s acceptance persists despite retired UI, with no speculative return or stock publication', async kind => {
    await begin(); const entered = deferred(), release = deferred();
    if (kind === 'POST') ports.post = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; });
    else ports.getProof = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; });
    const work = kind === 'POST' ? controller.confirm() : controller.open(); await entered.promise; controller.dismiss(); sessionEpoch++; const snapshot = controller.snapshot(); release.resolve(); await work;
    expect((await store.read()).operation?.proof).toEqual(proof(start, true)); expect(controller.snapshot()).toBe(snapshot); expect(currentView.rawStock).toEqual(view().rawStock);
  });
  it('failed accepted-body persistence preserves original uncertainty and reload recovers it by GET', async () => {
    await begin(); ports.post = vi.fn(async (_request, guard, retain) => { guard(); accepted = true; vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('receipt storage full')); const raw = proof(start, true); await retain(raw); return raw; });
    await controller.confirm(); expect((await store.read()).operation?.proof).toBeNull(); controller = new StarterExpeditionController(store, ports); await controller.open();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('holds cross-tab command ownership through a pending durable response', async () => {
    await begin(); const entered = deferred(), release = deferred(); ports.post = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); return raw; });
    const work = controller.confirm(); await entered.promise; const calls = vi.mocked(ports.getProof).mock.calls.length; await controller.confirm();
    const other = new StarterExpeditionController(new StarterExpeditionJournalStore(identity, factory), ports); await other.open();
    expect(other.snapshot().error).toContain('Another tab'); expect(ports.getProof).toHaveBeenCalledTimes(calls); release.resolve(); await work; expect(ports.post).toHaveBeenCalledOnce();
  });
});
describe('starter departure original refusals, archives and automatic return evidence', () => {
  const refusal = new ApiError(503, 'term unavailable', 'EXPEDITION_TERM_UNAVAILABLE');
  it.each([false, true])('records only the original first-attempt refusal at its revision; competing=%s', async competing => {
    let attempt = 0; ports.post = vi.fn(async (_request, _guard, _retain, observe) => { attempt = (await store.read()).revision; if (competing) await store.compareAndSet(attempt, old => old); await observe(refusal); await observe(refusal); throw refusal; });
    await begin(); await controller.confirm(); const saved = await store.read(); expect(saved.revision).toBe(attempt + 1);
    expect(saved.operation?.refusal).toEqual(competing ? null : { phase: 'first_post', status: 503, code: 'EXPEDITION_TERM_UNAVAILABLE' });
  });
  it('later refusal or delayed prior callback cannot classify an earlier ambiguous departure', async () => {
    let delayed!: (error: unknown) => Promise<void>; ports.post = vi.fn(async (_request, _guard, _retain, observe) => { delayed = observe; throw new Error('ambiguous first attempt'); }); await begin(); await controller.confirm();
    ports.post = vi.fn(async (_request, _guard, _retain, observe, first) => { expect(first).toBe(false); await delayed(refusal); await observe(refusal); throw refusal; });
    await controller.reviewCommand(); await controller.confirm(); await controller.archiveRefusal(); expect((await store.read()).operation?.refusal).toBeNull(); expect((await store.read()).archives).toHaveLength(0);
  });
  it('positive original acceptance wins over retained refusal and cannot be archived as absent', async () => {
    ports.post = vi.fn().mockRejectedValue(refusal); await begin(); await controller.confirm(); accepted = true; selected = id(9); currentView.acceptingDepartures = false;
    await controller.archiveRefusal(); expect((await store.read()).operation).toMatchObject({ proof: { status: 'accepted' }, refusal: { code: 'EXPEDITION_TERM_UNAVAILABLE' } });
    expect((await store.read()).archives).toHaveLength(0); await controller.finish(hydrate); expect((await store.read()).archives[0]?.reason).toBe('accepted');
  });
  it.each(['draft', 'refused'] as const)('archived %s can later acquire acceptance and return without rewriting historical absence or original reason', async kind => {
    await begin(); if (kind === 'refused') { ports.post = vi.fn().mockRejectedValue(refusal); await controller.confirm(); }
    if (kind === 'draft') await controller.abandonDraft(); else await controller.archiveRefusal(); const before = (await store.read()).archives[0]!;
    vi.mocked(ports.getProof).mockClear(); await controller.open(); expect(ports.getProof).not.toHaveBeenCalled();
    accepted = true; await controller.checkArchived(start.request.idempotencyKey); returned = true; await controller.open();
    expect((await store.read()).archives[0]).toEqual({ ...before, operation: { ...before.operation, proof: proof(start, true, true) } }); expect(ports.post).toHaveBeenCalledTimes(kind === 'draft' ? 0 : 1);
  });
  it('foreground checks accepted unfinished archives only, adds return once and then stops automatic checks', async () => {
    await begin(); await controller.confirm(); await controller.finish(hydrate); const receipt = (await store.read()).archives[0]!.operation.proof!.receipt;
    vi.mocked(ports.getProof).mockClear(); returned = true; await controller.open(); expect(ports.getProof).toHaveBeenCalledOnce();
    const saved = await store.read(); expect(saved.archives[0]!.operation.proof?.receipt).toEqual(receipt); expect(saved.archives[0]!.operation.proof?.return).toEqual(proof(start, true, true).return);
    vi.mocked(ports.getProof).mockClear(); await controller.open(); expect(ports.getProof).not.toHaveBeenCalled();
    returned = false; await controller.checkArchived(start.request.idempotencyKey); expect(controller.snapshot().error).toContain('return'); expect((await store.read()).archives).toEqual(saved.archives);
    accepted = false; await controller.checkArchived(start.request.idempotencyKey); expect(controller.snapshot().error).toContain('missing'); expect((await store.read()).archives).toEqual(saved.archives);
    expect(ports.post).toHaveBeenCalledOnce(); expect(currentView.rawStock).toEqual(view().rawStock);
  });
  it('owned archived return saves after account retirement without publishing obsolete fleet or replacing the departure', async () => {
    await begin(); await controller.confirm(); await controller.finish(hydrate); const entered = deferred(), release = deferred();
    ports.getProof = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true, true); await retain(raw); guard(); return raw; });
    const work = controller.open(); await entered.promise; controller.dismiss(); sessionEpoch++; const snapshot = controller.snapshot(); release.resolve(); await work;
    expect((await store.read()).archives[0]!.operation.proof).toEqual(proof(start, true, true)); expect(controller.snapshot()).toBe(snapshot); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('a passed local/server display deadline without return proof never completes the trip or grants stock', async () => {
    await begin(); await controller.confirm(); const future = proof(start, true); if (future.status !== 'accepted') throw new Error('fixture');
    future.serverNow = new Date(Date.parse(future.receipt.returnsAt) + 1_000).toISOString();
    ports.getProof = vi.fn(async (_request, guard, retain) => { guard(); await retain(future); return future; }); await controller.open();
    expect((await store.read()).operation?.proof?.return).toBeNull(); expect(ports.post).toHaveBeenCalledOnce(); expect(currentView.rawStock).toEqual(view().rawStock);
  });
  it('failed hydration or a competing revision preserves active acceptance for later finish', async () => {
    await begin(); await controller.confirm(); await controller.finish(async () => { throw new Error('current hydration failed'); }); expect((await store.read()).archives).toHaveLength(0);
    await controller.finish(async guard => { guard(); const saved = await store.read(); await store.compareAndSet(saved.revision, old => old); }); expect(controller.snapshot().error).toContain('Another tab');
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); await controller.finish(hydrate); expect((await store.read()).archives).toHaveLength(1);
  });
  it('corrupt journal or missing original endpoint fails closed instead of inventing a retry or current departure', async () => {
    vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('corrupt original journal')); await controller.open(); expect(controller.snapshot().error).toContain('corrupt'); expect(ports.get).not.toHaveBeenCalled();
    ports.getProof = vi.fn().mockRejectedValue(new Error('original endpoint missing')); await begin(); await controller.confirm(); expect((await store.read()).operation?.attemptRevision).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
});

it('arms one fresh action refresh only from committed POST metadata, never saved-original recovery', async () => {
  const originalPost = ports.post;
  ports.post = async (request, guard, retain, refusal, first, onCreated) => {
    const result = await originalPost(request, guard, retain, refusal, first); onCreated?.(); return result;
  };
  await begin(); await controller.confirm();
  expect(controller.consumeJourneyRefresh()).toBe(true); expect(controller.consumeJourneyRefresh()).toBe(false);
  await controller.open(); expect(controller.consumeJourneyRefresh()).toBe(false);
  await controller.reviewCommand(); await controller.confirm(); expect(controller.consumeJourneyRefresh()).toBe(false);
  expect(ports.getProof).toHaveBeenCalled();
});
