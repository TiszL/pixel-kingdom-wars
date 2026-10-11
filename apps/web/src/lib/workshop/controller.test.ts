import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { WorkshopController, type WorkshopPorts } from './controller';
import { WorkshopJournalStore, type WorkshopCommand } from './journal';
import { collect, id, identity, proof, start, view } from './fixtures.test-support';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
let factory: IDBFactory, store: WorkshopJournalStore, controller: WorkshopController, ports: WorkshopPorts;
let accepted: boolean, selected: string, epoch: number, active: boolean, locked: boolean, wall: number, elapsed: number, command: WorkshopCommand, currentView: ReturnType<typeof view>;
beforeEach(() => {
  factory = new IDBFactory(); store = new WorkshopJournalStore(identity, factory); accepted = false; selected = id(1); epoch = 0; active = true; locked = false; wall = 0; elapsed = 0; command = start; currentView = view();
  ports = {
    get: vi.fn(async (path, guard) => { guard(); return path.startsWith('/workshop?') ? currentView : proof(command, accepted); }),
    post: vi.fn(async (_path, body, guard) => { guard(); expect((await store.read()).operation).toMatchObject({ command: { request: body }, attempted: true }); accepted = true; return {}; }),
    capture: baseId => { const savedEpoch = epoch; return () => { if (!active || epoch !== savedEpoch || baseId && baseId !== selected) throw new Error('session or base changed'); }; },
    lock: async (_name, run) => { if (locked) throw new Error('Another tab'); locked = true; try { return await run(); } finally { locked = false; } },
    clock: () => ({ elapsed, wall }), key: () => command.request.idempotencyKey,
  };
  controller = new WorkshopController(store, ports);
});
const begin = () => controller.beginStart(id(1), 1, 1);
describe('Workshop explicit consent and read-only recovery', () => {
  it.each([false, true])('original refusal observer respects competing revision=%s and never writes twice', async competing => {
    let attemptRevision = -1;
    const refusal = new ApiError(422, 'insufficient', 'INSUFFICIENT_SHARDS');
    ports.post = vi.fn(async (_path, _body, _guard, observe) => {
      attemptRevision = (await store.read()).revision;
      if (competing) await store.compareAndSet(attemptRevision, old => old);
      await observe!(refusal); await observe!(refusal); throw refusal;
    });
    await begin(); await controller.confirm();
    const saved = await store.read();
    expect(saved.revision).toBe(attemptRevision + 1);
    expect(saved.operation?.refusal ?? null).toEqual(competing ? null : { phase: 'first_post', status: 422, code: 'INSUFFICIENT_SHARDS' });
    expect(saved.operation?.proof).toBeNull(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('saves immutable consent before the sole explicit POST, then preserves history without publishing receipt quantities as live stock', async () => {
    await begin(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().review?.view.inventory.held).toBe(1);
    await controller.confirm(); expect(controller.snapshot().error).toBeNull(); expect(ports.post).toHaveBeenCalledExactlyOnceWith('/workshop/jobs', start.request, expect.any(Function), expect.any(Function));
    expect(controller.snapshot().review).toBeNull(); expect((await store.read()).operation?.proof?.receipt).toMatchObject({ ingots: 1 });
    await controller.finish(); expect((await store.read()).archives).toHaveLength(1); expect((await store.read()).operation).toBeNull();
  });
  it('lost accepted acknowledgement survives reload, paused starts and another selected base using GET alone', async () => {
    ports.post = vi.fn(async () => { accepted = true; throw new Error('lost acknowledgement'); });
    await begin(); await controller.confirm(); expect((await store.read()).operation?.attempted).toBe(true);
    selected = id(9); currentView.acceptingJobs = false;
    controller = new WorkshopController(new WorkshopJournalStore(identity, factory), ports); await controller.open();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); await controller.finish(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('unknown/lost request can repeat only original body/key after new review and a fresh unknown proof', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost request')); await begin(); await controller.confirm();
    controller = new WorkshopController(new WorkshopJournalStore(identity, factory), ports); await controller.open(); await controller.confirm();
    expect(ports.post).toHaveBeenCalledOnce(); await controller.beginStart(id(1), 2, 1); expect((await store.read()).operation?.command).toEqual(start);
    await controller.reviewCommand(); await controller.confirm(); expect(ports.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.post).mock.calls.every(([, body]) => JSON.stringify(body) === JSON.stringify(start.request))).toBe(true);
  });
  it('rejects wrong wallet/key/base/quantity receipt without replacing original command', async () => {
    await begin(); ports.get = vi.fn(async () => ({ ...proof(start, true), receipt: { ...proof(start, true).receipt!, baseId: id(8) } }));
    await controller.open(); await controller.finish(); expect((await store.read()).operation?.proof).toBeNull(); expect((await store.read()).archives).toHaveLength(0); expect(ports.post).not.toHaveBeenCalled();
  });
  it('a 404 or malformed receipt endpoint never authorizes a new command', async () => {
    ports.get = vi.fn().mockRejectedValue(new Error('404')); await begin(); expect((await store.read()).operation).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['command', 'attempt'] as const)('failed durable %s write blocks every mutation', async stage => {
    if (stage === 'attempt') await begin();
    vi.spyOn(store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    if (stage === 'command') await begin(); else await controller.confirm();
    expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().error).toContain('disk full');
  });
  it.each(['base', 'session', 'lifecycle'] as const)('checks %s again at delayed actual transport and preserves uncertain command', async change => {
    await begin(); const pending = deferred(), entered = deferred();
    ports.post = vi.fn(async (_path, _body, guard) => { entered.resolve(); await pending.promise; guard(); accepted = true; return {}; });
    const running = controller.confirm(); await entered.promise;
    if (change === 'base') selected = id(9); else if (change === 'session') epoch++; else active = false;
    const snapshot = controller.snapshot(); pending.resolve(); await running;
    expect(accepted).toBe(false); expect((await store.read()).operation?.attempted).toBe(true); expect(controller.snapshot()).toBe(snapshot);
  });
  it('duplicates and another tab cannot enter a second simultaneous mutation', async () => {
    await begin(); const pending = deferred(), entered = deferred();
    ports.post = vi.fn(async () => { entered.resolve(); await pending.promise; accepted = true; return {}; });
    const running = controller.confirm(); await entered.promise; await controller.confirm();
    const other = new WorkshopController(new WorkshopJournalStore(identity, factory), ports); await other.open(); expect(other.snapshot().error).toContain('Another tab');
    pending.resolve(); await running; expect(ports.post).toHaveBeenCalledOnce();
  });
  it.each(['wall', 'elapsed', 'rollback'] as const)('UTC midnight or %s clock uncertainty invalidates earlier allowance consent', async kind => {
    currentView.serverNow = '2026-09-21T23:59:59.000Z'; await begin();
    if (kind === 'wall') wall = 1000; else if (kind === 'elapsed') elapsed = 1000; else wall = -1;
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().review).toBeNull();
  });
  it('changed aggregate free-wallet allowance requires renewed review even if selected-base stock is unchanged', async () => {
    await begin(); currentView = structuredClone(currentView); currentView.allowance.daily.used++; currentView.allowance.daily.remaining--;
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().error).toContain('allowance changed');
    await controller.reviewCommand(); await controller.confirm(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('paused starts still permit explicit collection of a ready paid job, including imported over-cap inventory', async () => {
    command = collect; currentView.acceptingJobs = false; currentView.allowance.holding.cap = 1; currentView.holding.cap = 1; currentView.allowance.holding.remaining = 0;
    await controller.beginCollect(id(1), id(2)); await controller.confirm(); expect(controller.snapshot().error).toBeNull();
    expect(ports.post).toHaveBeenCalledExactlyOnceWith(`/workshop/jobs/${id(2)}/collect`, collect.request, expect.any(Function), expect.any(Function));
    expect((await store.read()).operation?.proof?.receipt).toMatchObject({ ingotsCredited: 1 });
  });
  it('explicit unsent abandonment reads a fresh wallet proof without requiring the former base to remain selected or owned', async () => {
    await begin(); selected = id(9); currentView.acceptingJobs = false;
    vi.mocked(ports.get).mockClear(); await controller.abandonDraft();
    expect(ports.get).toHaveBeenCalledExactlyOnceWith(`/workshop/jobs/by-key/${start.request.idempotencyKey}`, expect.any(Function));
    expect(ports.post).not.toHaveBeenCalled(); expect((await store.read()).operation).toBeNull();
    expect((await store.read()).archives[0]).toMatchObject({ reason: 'unattempted', operation: { command: start, attempted: false }, evidence: { status: 'unknown' } });
  });
  it('attempted unknown commands cannot be abandoned; a newly discovered accepted receipt is retained as paid evidence', async () => {
    await begin(); ports.post = vi.fn().mockRejectedValue(new Error('response lost')); await controller.confirm();
    vi.mocked(ports.get).mockClear(); await controller.abandonDraft(); expect(ports.get).not.toHaveBeenCalled();
    expect((await store.read()).operation?.attempted).toBe(true); expect((await store.read()).archives).toHaveLength(0);
    store = new WorkshopJournalStore(identity, new IDBFactory()); controller = new WorkshopController(store, ports);
    await begin(); accepted = true; await controller.abandonDraft();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect((await store.read()).archives).toHaveLength(0);
  });
  it.each(['read', 'write', 'session', 'wrong-key'] as const)('failed %s abandonment keeps the original never-attempted draft', async failure => {
    await begin();
    if (failure === 'write') vi.spyOn(store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    if (failure === 'read') ports.get = vi.fn().mockRejectedValue(new Error('offline'));
    if (failure === 'session') ports.get = vi.fn(async () => { epoch++; return proof(start); });
    if (failure === 'wrong-key') ports.get = vi.fn(async () => ({ ...proof(start), idempotencyKey: 'foreign-command-key' }));
    await controller.abandonDraft(); expect((await store.read()).operation?.command).toEqual(start); expect((await store.read()).archives).toHaveLength(0); expect(ports.post).not.toHaveBeenCalled();
  });
  it('a competing tab attempt after absence proof wins CAS and cannot be erased by unsent abandonment', async () => {
    await begin(); const competing = new WorkshopJournalStore(identity, factory);
    ports.get = vi.fn(async () => {
      const journal = await competing.read(); await competing.compareAndSet(journal.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } }));
      return proof(start);
    });
    await controller.abandonDraft(); expect(controller.snapshot().error).toContain('Another tab');
    expect((await store.read()).operation?.attempted).toBe(true); expect((await store.read()).archives).toHaveLength(0);
  });
  it.each(['empty', 'replacement'] as const)('an older tab cannot confirm its review after another tab archives the draft into %s state', async next => {
    await begin(); const other = new WorkshopController(new WorkshopJournalStore(identity, factory), ports);
    await other.open(); await other.abandonDraft();
    if (next === 'replacement') {
      command = { ...start, request: { ...start.request, idempotencyKey: 'new-distinct-start-key' } };
      await other.beginStart(id(1), 1, 1);
    }
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled();
    expect((await store.read()).archives).toHaveLength(1);
    expect((await store.read()).operation?.command ?? null).toEqual(next === 'replacement' ? command : null);
  });
});
describe('Workshop first-POST definitive refusal recovery', () => {
  it('an insufficient-funds first refusal remains immutable until explicit archive with fresh unknown proof, then permits a distinct request', async () => {
    ports.post = vi.fn().mockRejectedValue(new ApiError(422, 'Not enough SHARDS', 'INSUFFICIENT_SHARDS'));
    await begin(); await controller.confirm();
    expect((await store.read()).operation).toMatchObject({ command: start, attempted: true, refusal: { phase: 'first_post', status: 422, code: 'INSUFFICIENT_SHARDS' }, proof: null });
    await controller.open(); await controller.reviewCommand(); await controller.confirm(); expect(ports.post).toHaveBeenCalledOnce();
    expect((await store.read()).archives).toHaveLength(0); await controller.archiveRefusal();
    expect((await store.read()).archives[0]).toMatchObject({ reason: 'refused', operation: { command: start, refusal: { code: 'INSUFFICIENT_SHARDS' } }, evidence: { status: 'unknown' } });
    command = { ...start, request: { ...start.request, idempotencyKey: 'new-reviewed-request' } }; await begin();
    expect((await store.read()).operation?.command).toEqual(command); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('another device collecting between the final view and POST cannot permanently block this wallet journal', async () => {
    command = collect; ports.post = vi.fn(async () => {
      currentView.jobs[0]!.collectedAt = currentView.serverNow;
      throw new ApiError(409, 'The paid job was already collected', 'JOB_ALREADY_COLLECTED');
    });
    await controller.beginCollect(id(1), id(2)); await controller.confirm();
    expect((await store.read()).operation?.refusal?.code).toBe('JOB_ALREADY_COLLECTED');
    await controller.archiveRefusal(); expect((await store.read()).operation).toBeNull(); expect((await store.read()).archives[0]?.reason).toBe('refused');
    expect(ports.post).toHaveBeenCalledOnce();
  });
  it.each([
    ['start', 409, 'JOB_ALREADY_COLLECTED'], ['collect', 422, 'INSUFFICIENT_SHARDS'], ['start', 409, 'BASE_NOT_OWNED'],
    ['start', 409, 'IDEMPOTENCY_BODY_MISMATCH'], ['collect', 503, 'JOB_NOT_FOUND'], ['start', 401, 'BASE_NOT_OWNED'], ['start', 500, 'INSUFFICIENT_SHARDS'],
  ] as const)('does not infer terminality from wrong-kind/status %s %i %s', async (kind, status, code) => {
    command = kind === 'start' ? start : collect; ports.post = vi.fn().mockRejectedValue(new ApiError(status, 'refused', code));
    if (kind === 'start') await begin(); else await controller.beginCollect(id(1), id(2));
    await controller.confirm(); await controller.archiveRefusal();
    expect((await store.read()).operation).toMatchObject({ attempted: true, refusal: null }); expect((await store.read()).archives).toHaveLength(0);
  });
  it('plain error-shaped objects cannot impersonate a typed server rejection', async () => {
    ports.post = vi.fn().mockRejectedValue({ status: 422, code: 'INSUFFICIENT_SHARDS' }); await begin(); await controller.confirm();
    expect((await store.read()).operation?.refusal).toBeNull();
  });
  it('POST success followed by a typed GET error never reclassifies the successful command as refused', async () => {
    await begin(); ports.post = vi.fn(async () => { accepted = true; ports.get = vi.fn().mockRejectedValue(new ApiError(404, 'lost base', 'BASE_NOT_OWNED')); return {}; });
    await controller.confirm(); await controller.archiveRefusal(); expect((await store.read()).operation).toMatchObject({ attempted: true, refusal: null, proof: null });
    ports.get = vi.fn(async () => proof(start, true)); await controller.open(); expect((await store.read()).operation?.proof?.status).toBe('accepted');
  });
  it('a later retry refusal cannot disprove a previous timeout even after reload', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('timeout')); await begin(); await controller.confirm();
    controller = new WorkshopController(new WorkshopJournalStore(identity, factory), ports); await controller.open(); await controller.reviewCommand();
    ports.post = vi.fn().mockRejectedValue(new ApiError(409, 'Recipe changed', 'RECIPE_VERSION_STALE')); await controller.confirm();
    await controller.archiveRefusal(); expect((await store.read()).operation?.refusal).toBeNull(); expect((await store.read()).operation?.attempted).toBe(true); expect((await store.read()).archives).toHaveLength(0);
  });
  it('failed refusal durability leaves the original attempt uncertain rather than clearing it', async () => {
    await begin(); const write = store.compareAndSet.bind(store);
    vi.spyOn(store, 'compareAndSet').mockImplementation(async (revision, update) => {
      const old = await store.read(); if (update(structuredClone(old)).operation?.refusal) throw new Error('disk full');
      return write(revision, update);
    });
    ports.post = vi.fn().mockRejectedValue(new ApiError(422, 'Not enough SHARDS', 'INSUFFICIENT_SHARDS')); await controller.confirm();
    expect(controller.snapshot().error).toBe('disk full'); expect((await store.read()).operation).toMatchObject({ attempted: true, refusal: null });
  });
  it('a late typed first rejection is saved under the original journal even after a base/view change, with no obsolete publication', async () => {
    await begin(); const pending = deferred(), entered = deferred();
    ports.post = vi.fn(async () => { entered.resolve(); await pending.promise; throw new ApiError(404, 'Base sold', 'BASE_NOT_OWNED'); });
    const running = controller.confirm(); await entered.promise; selected = id(9); epoch++; const snapshot = controller.snapshot(); pending.resolve(); await running;
    expect((await store.read()).operation?.refusal).toMatchObject({ phase: 'first_post', code: 'BASE_NOT_OWNED', status: 404 }); expect(controller.snapshot()).toBe(snapshot);
  });
  it.each(['offline', 'accepted', 'wrong-key', 'write'] as const)('refusal archive fails closed on %s evidence and keeps original proof/history', async failure => {
    ports.post = vi.fn().mockRejectedValue(new ApiError(422, 'Not enough SHARDS', 'INSUFFICIENT_SHARDS')); await begin(); await controller.confirm();
    if (failure === 'offline') ports.get = vi.fn().mockRejectedValue(new ApiError(404, 'Base missing', 'BASE_NOT_OWNED'));
    if (failure === 'accepted') ports.get = vi.fn(async () => proof(start, true));
    if (failure === 'wrong-key') ports.get = vi.fn(async () => ({ ...proof(start), idempotencyKey: 'another-operation' }));
    if (failure === 'write') vi.spyOn(store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    await controller.archiveRefusal(); expect((await store.read()).operation).toMatchObject({ refusal: { code: 'INSUFFICIENT_SHARDS' }, proof: null }); expect((await store.read()).archives).toHaveLength(0);
  });
  it('accepted preflight is retained atomically even when every subsequent GET fails or reports unknown', async () => {
    ports.get = vi.fn().mockResolvedValueOnce(proof(start, true)).mockRejectedValue(new Error('offline'));
    await begin(); expect(ports.get).toHaveBeenCalledOnce(); expect((await store.read()).operation?.proof?.status).toBe('accepted');
    await controller.open(); expect((await store.read()).operation?.proof?.status).toBe('accepted');
    ports.get = vi.fn(async () => proof(start)); await controller.abandonDraft(); await controller.finish();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect((await store.read()).archives).toHaveLength(0); expect(ports.post).not.toHaveBeenCalled();
  });
});
