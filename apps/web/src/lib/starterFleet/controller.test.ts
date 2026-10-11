import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { StarterFleetController, type StarterFleetPorts } from './controller';
import { StarterFleetJournalStore } from './journal';
import { command, deferred, id, identity, installation, proof, start, view } from './fixtures.test-support';
let factory: IDBFactory, store: StarterFleetJournalStore, controller: StarterFleetController, ports: StarterFleetPorts;
let original: ReturnType<typeof command>, currentView: ReturnType<typeof view>, accepted: boolean, selected: string, baseEpoch: number, sessionEpoch: number, active: boolean, locked: boolean;
beforeEach(() => {
  factory = new IDBFactory(); store = new StarterFleetJournalStore(identity, factory); original = start; currentView = view(); accepted = false;
  selected = id(1); baseEpoch = 0; sessionEpoch = 0; active = true; locked = false;
  ports = {
    get: vi.fn(async (path, guard) => { guard(); expect(path).toBe(`/starter-fleet?baseId=${id(1)}`); return currentView; }),
    getProof: vi.fn(async (request, guard, retain) => { guard(); const raw = proof({ ...original, request }, accepted); await retain(raw); guard(); return raw; }),
    post: vi.fn(async (request, guard, retain, _observe, firstAttempt) => {
      guard(); const saved = await store.read(); expect(saved.operation?.command.request).toEqual(request);
      expect(saved.operation?.attemptRevision).toBe(saved.revision); expect(firstAttempt).toBe(true);
      accepted = true; const raw = proof(original, true); await retain(raw); guard(); return raw;
    }),
    capture: baseId => { const session = sessionEpoch, selection = baseEpoch; return () => {
      if (!active || session !== sessionEpoch || baseId && (baseId !== selected || selection !== baseEpoch)) throw new Error('session or base changed');
    }; },
    lock: async (_name, run) => { if (locked) throw new Error('Another tab owns this command'); locked = true; try { return await run(); } finally { locked = false; } },
    key: () => original.request.idempotencyKey,
  };
  controller = new StarterFleetController(store, ports);
});
const begin = () => controller.beginInstall(original.request.baseId, original.request.berthId);
const hydrate = async (guard: () => void) => { guard(); };
describe('starter installation explicit complete-berth consent', () => {
  it.each([false, true])('persists the full reviewed berth and existing starter=%s before one explicit POST', async existing => {
    original = command(existing); currentView = view(existing); await begin(); expect(controller.snapshot().error).toBeNull();
    expect(controller.snapshot().review?.command).toEqual(original); expect((await store.read()).operation?.command).toEqual(original); expect(ports.post).not.toHaveBeenCalled();
    const before = structuredClone(currentView); await controller.confirm(); expect(controller.snapshot().error).toBeNull(); expect(ports.post).toHaveBeenCalledOnce();
    expect((await store.read()).operation?.proof).toEqual(proof(original, true)); expect(currentView).toEqual(before);
    const refresh = vi.fn(hydrate); await controller.finish(refresh); expect(refresh).toHaveBeenCalledOnce();
    expect((await store.read()).operation).toBeNull(); expect((await store.read()).archives[0]?.operation.command).toEqual(original);
  });
  it('loses an acknowledgment without losing the original, and recovers before flags, custody or current-fleet reads', async () => {
    ports.post = vi.fn(async () => { accepted = true; throw new Error('lost acknowledgment'); }); await begin(); await controller.confirm();
    expect((await store.read()).operation?.proof).toBeNull(); selected = id(9); baseEpoch++; currentView.acceptingInstallations = false;
    controller = new StarterFleetController(new StarterFleetJournalStore(identity, factory), ports); vi.mocked(ports.get).mockClear();
    await controller.open(); await controller.reviewCommand(); await controller.confirm(); await controller.finish(hydrate);
    expect((await store.read()).archives[0]?.operation.proof?.status).toBe('accepted'); expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('unknown retries retain the same body/key and require a fresh explicit review, never abandoning ambiguous attempts', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost request')); await begin(); await controller.confirm();
    const first = (await store.read()).operation!.attemptRevision;
    controller = new StarterFleetController(new StarterFleetJournalStore(identity, factory), ports); await controller.open(); await controller.confirm();
    expect(ports.post).toHaveBeenCalledOnce(); await controller.beginInstall(id(1), id(9)); expect((await store.read()).operation?.command).toEqual(start);
    await controller.reviewCommand(); await controller.confirm(); expect(ports.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.post).mock.calls.map(call => [call[0], call[4]])).toEqual([[start.request, true], [start.request, false]]);
    expect((await store.read()).operation!.attemptRevision).toBeGreaterThan(first!); await controller.abandonDraft(); await controller.archiveRefusal();
    expect((await store.read()).archives).toHaveLength(0); expect((await store.read()).operation?.command).toEqual(start);
  });
  it.each(['missing-berth', 'missing-job', 'future-completion', 'duplicate-berth', 'foreign-wallet', 'foreign-base', 'paused'] as const)('rejects %s before saving or sending a new command', async kind => {
    if (kind === 'missing-berth') currentView.eligibleBerths = [];
    else if (kind === 'missing-job') ports.get = vi.fn(async () => ({ ...currentView, eligibleBerths: [{ berthId: id(3), level: 1 }] }));
    else if (kind === 'future-completion') currentView.eligibleBerths[0]!.berthCompletedAt = '2026-09-23T12:00:00.000Z';
    else if (kind === 'duplicate-berth') currentView.eligibleBerths.push({ ...currentView.eligibleBerths[0]! });
    else if (kind === 'foreign-wallet') currentView.wallet = 'So11111111111111111111111111111111111111112';
    else if (kind === 'foreign-base') currentView.baseId = id(9);
    else currentView.acceptingInstallations = false;
    await begin(); expect(controller.snapshot().error).not.toBeNull(); expect((await store.read()).operation).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['job', 'completion', 'installation-appeared', 'installation-replaced', 'paused', 'berth-disappeared'] as const)('fresh %s change invalidates prior consent without overwriting the frozen intent', async kind => {
    if (kind === 'installation-replaced') { original = command(true); currentView = view(true); }
    await begin(); const frozen = structuredClone((await store.read()).operation!.command);
    if (kind === 'job') currentView.eligibleBerths[0]!.completedBuildJobId = id(9);
    else if (kind === 'completion') currentView.eligibleBerths[0]!.berthCompletedAt = '2026-09-22T10:59:00.000Z';
    else if (kind === 'installation-appeared') currentView.installation = installation();
    else if (kind === 'installation-replaced') currentView.installation!.installationId = id(9);
    else if (kind === 'paused') currentView.acceptingInstallations = false;
    else currentView.eligibleBerths = [];
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().review).toBeNull();
    expect((await store.read()).operation?.attemptRevision).toBeNull(); expect((await store.read()).operation?.command).toEqual(frozen);
  });
  it('a concurrently installed starter requires explicit unsent archival and new review; an old key cannot silently adopt it', async () => {
    await begin(); currentView = view(true); await controller.confirm(); await controller.reviewCommand();
    expect(ports.post).not.toHaveBeenCalled(); expect((await store.read()).operation?.command.installation).toBeNull();
    await controller.abandonDraft(); original = command(true, id(9)); await begin(); await controller.confirm();
    expect((await store.read()).operation?.command.installation).toEqual(installation()); expect(ports.post).toHaveBeenCalledOnce();
    expect((await store.read()).archives[0]?.operation.command.request.idempotencyKey).toBe(start.request.idempotencyKey);
  });
  it('an unavailable original endpoint retains unsent intent and never manufactures absence or confirmation', async () => {
    ports.getProof = vi.fn().mockRejectedValue(new Error('unsupported original endpoint')); await begin(); await controller.confirm();
    expect((await store.read()).operation?.command).toEqual(start); expect((await store.read()).operation?.attemptRevision).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['intent', 'attempt'] as const)('failed durable %s write blocks mutation enqueue', async stage => {
    if (stage === 'attempt') await begin(); vi.spyOn(store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    if (stage === 'intent') await begin(); else await controller.confirm();
    expect(controller.snapshot().error).toContain('disk full'); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['base-aba', 'session', 'hidden', 'dismiss'] as const)('rechecks %s at the actual delayed enqueue and suppresses obsolete UI publication', async kind => {
    await begin(); const entered = deferred(), release = deferred();
    ports.post = vi.fn(async (_request, guard, retain) => { entered.resolve(); await release.promise; guard(); accepted = true; const raw = proof(start, true); await retain(raw); return raw; });
    const work = controller.confirm(); await entered.promise;
    if (kind === 'base-aba') { selected = id(9); baseEpoch++; selected = id(1); baseEpoch++; }
    else if (kind === 'session') sessionEpoch++; else if (kind === 'hidden') active = false; else controller.dismiss();
    const snapshot = controller.snapshot(); release.resolve(); await work;
    expect(accepted).toBe(false); expect((await store.read()).operation?.attemptRevision).not.toBeNull(); expect((await store.read()).operation?.proof).toBeNull(); expect(controller.snapshot()).toBe(snapshot);
  });
  it.each(['POST', 'GET'] as const)('complete owned %s acceptance survives dismissal/account retirement before guarded publication', async kind => {
    await begin(); const entered = deferred(), release = deferred();
    if (kind === 'POST') ports.post = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; });
    else ports.getProof = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); guard(); return raw; });
    const work = kind === 'POST' ? controller.confirm() : controller.open(); await entered.promise; controller.dismiss(); sessionEpoch++;
    const snapshot = controller.snapshot(); release.resolve(); await work; expect((await store.read()).operation?.proof).toEqual(proof(start, true)); expect(controller.snapshot()).toBe(snapshot);
  });
  it('failed accepted-body persistence keeps the attempted original and permits GET recovery on reload', async () => {
    await begin(); ports.post = vi.fn(async (_request, guard, retain) => { guard(); accepted = true;
      vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('receipt storage full')); const raw = proof(start, true); await retain(raw); return raw; });
    await controller.confirm(); expect(controller.snapshot().error).toContain('storage full'); expect((await store.read()).operation?.proof).toBeNull();
    controller = new StarterFleetController(store, ports); await controller.open(); expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect(ports.post).toHaveBeenCalledOnce();
  });
  it.each(['wallet', 'key', 'job', 'partial'] as const)('rejects foreign or incomplete %s evidence without saving acceptance', async kind => {
    await begin(); const raw = proof(start, true); if (raw.status !== 'accepted') throw new Error('fixture'); let invalid: unknown = raw;
    if (kind === 'wallet') raw.wallet = 'So11111111111111111111111111111111111111112';
    else if (kind === 'key') raw.idempotencyKey = id(9);
    else if (kind === 'job') raw.receipt.installation.completedBuildJobId = id(9);
    else invalid = { status: 'accepted' };
    ports.getProof = vi.fn(async (_request, _guard, retain) => { await retain(invalid); return invalid; });
    await controller.open(); expect((await store.read()).operation?.proof).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('holds exclusive cross-tab ownership until a received body finishes retention', async () => {
    await begin(); const entered = deferred(), release = deferred();
    ports.post = vi.fn(async (_request, guard, retain) => { guard(); entered.resolve(); await release.promise; const raw = proof(start, true); await retain(raw); return raw; });
    const work = controller.confirm(); await entered.promise; const reads = vi.mocked(ports.getProof).mock.calls.length;
    await controller.confirm(); const other = new StarterFleetController(new StarterFleetJournalStore(identity, factory), ports); await other.open();
    expect(other.snapshot().error).toContain('Another tab'); expect(ports.getProof).toHaveBeenCalledTimes(reads);
    release.resolve(); await work; expect(ports.post).toHaveBeenCalledOnce(); expect(locked).toBe(false);
  });
});
describe('starter installation original refusal and immutable history', () => {
  const refusal = new ApiError(409, 'berth unavailable', 'STARTER_BERTH_UNAVAILABLE');
  it.each([false, true])('records a first refusal only at its original attempted revision; competing=%s', async competing => {
    let attempt = 0;
    ports.post = vi.fn(async (_request, _guard, _retain, observe) => { attempt = (await store.read()).revision;
      if (competing) await store.compareAndSet(attempt, old => old); await observe(refusal); await observe(refusal); throw refusal; });
    await begin(); await controller.confirm(); const saved = await store.read(); expect(saved.revision).toBe(attempt + 1);
    expect(saved.operation?.refusal).toEqual(competing ? null : { phase: 'first_post', status: 409, code: 'STARTER_BERTH_UNAVAILABLE' });
  });
  it('a retry refusal and delayed prior callback cannot classify the earlier ambiguous attempt', async () => {
    let delayed!: (error: unknown) => Promise<void>;
    ports.post = vi.fn(async (_request, _guard, _retain, observe) => { delayed = observe; throw new Error('ambiguous first attempt'); }); await begin(); await controller.confirm();
    ports.post = vi.fn(async (_request, _guard, _retain, observe, first) => { expect(first).toBe(false); await delayed(refusal); await observe(refusal); throw refusal; });
    await controller.reviewCommand(); await controller.confirm(); expect((await store.read()).operation?.refusal).toBeNull(); await controller.archiveRefusal();
    expect((await store.read()).archives).toHaveLength(0);
  });
  it('owned first refusal persists after dismissal, and later original acceptance wins without erasing it', async () => {
    await begin(); const entered = deferred(), release = deferred();
    ports.post = vi.fn(async (_request, guard, _retain, observe) => { guard(); entered.resolve(); await release.promise; await observe(refusal); guard(); throw refusal; });
    const work = controller.confirm(); await entered.promise; controller.dismiss(); const snapshot = controller.snapshot(); release.resolve(); await work;
    expect((await store.read()).operation?.refusal?.code).toBe('STARTER_BERTH_UNAVAILABLE'); expect(controller.snapshot()).toBe(snapshot);
    accepted = true; selected = id(9); currentView.acceptingInstallations = false; controller = new StarterFleetController(store, ports);
    await controller.reviewCommand(); await controller.finish(hydrate); expect((await store.read()).archives[0]).toMatchObject({ reason: 'accepted', operation: { proof: { status: 'accepted' }, refusal: { code: 'STARTER_BERTH_UNAVAILABLE' } } });
  });
  it.each(['draft', 'refused'] as const)('explicit %s archive preserves absence and later GET adds acceptance without changing the original reason', async kind => {
    await begin(); if (kind === 'refused') { ports.post = vi.fn().mockRejectedValue(refusal); await controller.confirm(); }
    selected = id(9); baseEpoch++; currentView.acceptingInstallations = false; vi.mocked(ports.get).mockClear();
    if (kind === 'draft') await controller.abandonDraft(); else await controller.archiveRefusal();
    const before = (await store.read()).archives[0]!; expect(before.evidence?.status).toBe('unknown'); accepted = true;
    await controller.checkArchived(start.request.idempotencyKey); const after = (await store.read()).archives[0]!;
    expect(after).toEqual({ ...before, operation: { ...before.operation, proof: proof(start, true) } }); expect(ports.get).not.toHaveBeenCalled();
    accepted = false; await controller.checkArchived(start.request.idempotencyKey); expect(controller.snapshot().error).toContain('missing'); expect((await store.read()).archives[0]).toEqual(after);
    expect(ports.post).toHaveBeenCalledTimes(kind === 'draft' ? 0 : 1);
  });
  it('historical positive reconciliation cannot replace a newer active original command', async () => {
    await begin(); await controller.abandonDraft(); original = command(false, id(9)); await begin();
    const activeOriginal = (await store.read()).operation; accepted = true;
    await controller.checkArchived(start.request.idempotencyKey);
    const saved = await store.read(); expect(saved.operation).toEqual(activeOriginal);
    expect(saved.archives[0]).toMatchObject({ reason: 'unattempted', evidence: { status: 'unknown' }, operation: { proof: { status: 'accepted' }, command: start } });
    expect(ports.post).not.toHaveBeenCalled();
  });
  it('a newly positive proof blocks refusal archival and retains the original for accepted finish', async () => {
    ports.post = vi.fn().mockRejectedValue(refusal); await begin(); await controller.confirm(); accepted = true; await controller.archiveRefusal();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect((await store.read()).archives).toHaveLength(0);
    await controller.finish(hydrate); expect((await store.read()).archives[0]?.reason).toBe('accepted');
  });
  it('failed hydration or a competing revision preserves the active accepted command', async () => {
    await begin(); await controller.confirm(); await controller.finish(async () => { throw new Error('current snapshot failed'); });
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect((await store.read()).archives).toHaveLength(0);
    await controller.finish(async guard => { guard(); const saved = await store.read(); await store.compareAndSet(saved.revision, old => old); });
    expect(controller.snapshot().error).toContain('Another tab'); expect((await store.read()).archives).toHaveLength(0);
    await controller.finish(hydrate); expect((await store.read()).archives).toHaveLength(1);
  });
  it('an immutable accepted installation has no automatic completion check, while explicit history remains GET-only', async () => {
    await begin(); await controller.confirm(); await controller.finish(hydrate); vi.mocked(ports.getProof).mockClear(); await controller.open();
    expect(ports.getProof).not.toHaveBeenCalled(); await controller.checkArchived(start.request.idempotencyKey);
    expect(ports.getProof).toHaveBeenCalledOnce(); expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).operation).toBeNull();
  });
  it('unreadable journal evidence blocks all current reads and mutations without resetting history', async () => {
    vi.spyOn(store, 'read').mockRejectedValue(new Error('corrupt original journal')); await controller.open(); await begin();
    expect(controller.snapshot().error).toContain('corrupt original'); expect(ports.getProof).not.toHaveBeenCalled(); expect(ports.get).not.toHaveBeenCalled(); expect(ports.post).not.toHaveBeenCalled();
  });
});
