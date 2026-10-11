import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { trainingFinishBody, type TrainingFinishIntent } from '@shardkeep/shared/trainingFinish';
import { TrainingFinishController, type TrainingFinishPorts } from './controller';
import { TrainingFinishJournalStore, type TrainingRefusal } from './journal';
import { id, identity, proof, restarted, training } from './fixtures.test-support';
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
let factory: IDBFactory, store: TrainingFinishJournalStore, controller: TrainingFinishController, ports: TrainingFinishPorts;
let accepted: boolean, selected: string | null, epoch: number, active: boolean, locked: boolean, intent: TrainingFinishIntent;
const refusal: TrainingRefusal = { status: 409, code: 'TRAINING_FINISH_QUOTE_CHANGED' };
beforeEach(() => {
  factory = new IDBFactory(); store = new TrainingFinishJournalStore(identity, factory); accepted = false; selected = id(1); epoch = 0; active = true; locked = false; intent = training;
  ports = {
    get: vi.fn(async (_path, guard) => { guard(); return proof(intent, accepted); }),
    post: vi.fn(async (_path, body, currency, guard) => { guard(); expect((await store.read()).operation).toMatchObject({ intent, attempted: true }); expect(body).toEqual(trainingFinishBody(intent)); expect(currency).toBe(intent.expectedCurrency); accepted = true; return { spentKeep: '0', duplicate: true }; }),
    capture: baseId => { const savedEpoch = epoch; return () => { if (!active || epoch !== savedEpoch || baseId !== undefined && baseId !== selected) throw new Error('session or base changed'); }; },
    lock: async (_name, run) => { if (locked) throw new Error('Another tab'); locked = true; try { return await run(); } finally { locked = false; } },
    key: () => intent.idempotencyKey, prepare: vi.fn(async () => intent), validate: vi.fn(async (_intent, guard) => { guard(); }),
    definitiveRefusal: error => error === refusal ? refusal : null,
  };
  controller = new TrainingFinishController(store, ports);
});
const begin = () => controller.begin({ baseId: intent.baseId });
describe('Training speedup explicit original-currency consent', () => {
  it.each([training, restarted])('durably freezes the training episode before dispatch and proves actual original funding rather than trusting POST acknowledgement', async value => {
    intent = value; await begin(); expect(ports.post).not.toHaveBeenCalled(); await controller.confirm();
    expect(controller.snapshot().error).toBeNull(); expect(ports.post).toHaveBeenCalledExactlyOnceWith('/army/train/speedup', trainingFinishBody(intent), intent.expectedCurrency, expect.any(Function), expect.any(Function));
    expect((await store.read()).operation?.proof).toMatchObject({ status: 'accepted', funding: { currency: 'GEMS', amount: '90' } });
    await controller.finish(); expect((await store.read()).operation).toBeNull(); expect((await store.read()).archives).toHaveLength(1);
  });
  it('lost accepted acknowledgement recovers through GET after reload/base transfer without a new spend or current affordability', async () => {
    ports.post = vi.fn(async () => { accepted = true; throw new Error('lost acknowledgement'); }); await begin(); await controller.confirm();
    selected = id(9); ports.validate = vi.fn().mockRejectedValue(new Error('Gems paused'));
    controller = new TrainingFinishController(new TrainingFinishJournalStore(identity, factory), ports); await controller.open(); await controller.finish();
    expect((await store.read()).archives[0]!.reason).toBe('accepted'); expect(ports.post).toHaveBeenCalledOnce(); expect(ports.validate).not.toHaveBeenCalled();
  });
  it('unknown acknowledgement cannot prove acceptance or allocate a replacement key and retry needs a new review', async () => {
    ports.post = vi.fn().mockResolvedValue({ spentKeep: '0', duplicate: true }); await begin(); await controller.confirm();
    expect(controller.snapshot().error).toContain('not yet proven'); expect((await store.read()).operation?.proof).toBeNull();
    controller = new TrainingFinishController(new TrainingFinishJournalStore(identity, factory), ports); await controller.open(); await controller.confirm(); await begin();
    expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).operation?.intent).toEqual(training);
    await controller.reviewCommand(); await controller.confirm(); expect(ports.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.post).mock.calls.every(([, body, currency]) => JSON.stringify(body) === JSON.stringify(trainingFinishBody(training)) && currency === 'GEMS')).toBe(true);
  });
  it('rejects another currency receipt even if the selected balance could cover the whole price', async () => {
    await begin(); ports.get = vi.fn(async () => proof({ ...intent, expectedCurrency: 'KEEP' }, true));
    await controller.open(); await controller.finish(); expect((await store.read()).operation?.proof).toBeNull(); expect((await store.read()).archives).toHaveLength(0); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['command', 'attempt'] as const)('storage failure at %s never dispatches', async stage => {
    if (stage === 'attempt') await begin(); vi.spyOn(store, 'compareAndSet').mockRejectedValue(new Error('disk full'));
    if (stage === 'command') await begin(); else await controller.confirm(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('a definitive first POST refusal preserves original history but allows another distinct command', async () => {
    ports.post = vi.fn().mockRejectedValue(refusal); await begin(); await controller.confirm();
    expect((await store.read()).operation?.refusal).toEqual(refusal); await controller.finish();
    expect((await store.read()).archives[0]).toMatchObject({ reason: 'refused', operation: { intent: training, attempted: true, refusal } });
    intent = { ...training, idempotencyKey: 'new-original-key' }; await begin(); expect(controller.snapshot().review?.idempotencyKey).toBe(intent.idempotencyKey);
  });
  it('a later retry refusal never erases a possibly committed first request', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('timeout')); await begin(); await controller.confirm();
    ports.post = vi.fn().mockRejectedValue(refusal); await controller.reviewCommand(); await controller.confirm(); await controller.finish();
    expect((await store.read()).operation).toMatchObject({ attempted: true, refusal: null, proof: null }); expect((await store.read()).archives).toHaveLength(0);
  });
  it('GET errors cannot become definitive first-POST refusal evidence', async () => {
    await begin(); ports.get = vi.fn().mockRejectedValue(refusal); await controller.confirm(); await controller.finish();
    expect((await store.read()).operation).toMatchObject({ attempted: false, refusal: null }); expect(ports.post).not.toHaveBeenCalled();
  });
  it.each(['base', 'session', 'lifecycle'] as const)('checks %s at delayed actual POST and retains the original attempted command', async change => {
    await begin(); const wait = deferred(), entered = deferred();
    ports.post = vi.fn(async (_path, _body, _currency, guard) => { entered.resolve(); await wait.promise; guard(); accepted = true; return {}; });
    const running = controller.confirm(); await entered.promise;
    if (change === 'base') selected = id(9); else if (change === 'session') epoch++; else active = false;
    wait.resolve(); await running; expect(accepted).toBe(false); expect((await store.read()).operation?.attempted).toBe(true); expect(controller.snapshot().busy).toBe(false);
  });
  it('cancel during confirmation GET does not POST or strand busy, and the saved draft can be reviewed again', async () => {
    await begin(); const wait = deferred(), entered = deferred();
    ports.get = vi.fn(async () => { entered.resolve(); await wait.promise; return proof(intent); });
    const running = controller.confirm(); await entered.promise; controller.dismiss(); wait.resolve(); await running;
    expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().busy).toBe(false); expect((await store.read()).operation?.attempted).toBe(false);
    await controller.reviewCommand(); expect(controller.snapshot().review).toEqual(training);
  });
  it('duplicate taps and another tab cannot dispatch simultaneously', async () => {
    await begin(); const wait = deferred(), entered = deferred();
    ports.post = vi.fn(async () => { entered.resolve(); await wait.promise; accepted = true; return {}; });
    const running = controller.confirm(); await entered.promise; await controller.confirm();
    const other = new TrainingFinishController(new TrainingFinishJournalStore(identity, factory), ports); await other.open(); expect(other.snapshot().error).toContain('Another tab');
    wait.resolve(); await running; expect(ports.post).toHaveBeenCalledOnce();
  });
  it('changed original consent/funds fails closed before dispatch rather than selecting another currency', async () => {
    await begin(); ports.validate = vi.fn().mockRejectedValue(new Error('reviewed GEMS unavailable'));
    await controller.confirm(); expect(ports.post).not.toHaveBeenCalled(); expect((await store.read()).operation?.intent.expectedCurrency).toBe('GEMS');
  });
  it('only fresh matching unknown proof permits abandonment of an unattempted draft, even after its base moves', async () => {
    await begin(); selected = id(9); await controller.abandon(); expect((await store.read()).archives[0]!.reason).toBe('unattempted'); expect(ports.post).not.toHaveBeenCalled();
  });
  it('an attempted draft or a competing tab attempt cannot be abandoned', async () => {
    await begin(); const competing = new TrainingFinishJournalStore(identity, factory);
    ports.get = vi.fn(async () => { const saved = await competing.read(); await competing.compareAndSet(saved.revision, old => ({ ...old, operation: { ...old.operation!, attempted: true } })); return proof(intent); });
    await controller.abandon(); expect(controller.snapshot().error).toContain('Another tab'); await controller.open(); await controller.abandon();
    expect((await store.read()).operation?.attempted).toBe(true); expect((await store.read()).archives).toHaveLength(0);
  });
  it.each(['unknown', 'unavailable'] as const)('retains accepted preflight proof atomically even when the next GET is %s', async later => {
    ports.get = vi.fn().mockResolvedValueOnce(proof(intent, true));
    if (later === 'unknown') vi.mocked(ports.get).mockResolvedValue(proof(intent));
    else vi.mocked(ports.get).mockRejectedValue(new Error('receipt temporarily unavailable'));
    await begin(); expect(ports.get).toHaveBeenCalledOnce();
    expect((await store.read()).operation?.proof?.status).toBe('accepted');
    await controller.open(); await controller.abandon();
    expect((await store.read()).operation?.proof?.status).toBe('accepted'); expect((await store.read()).archives).toHaveLength(0);
    expect(ports.post).not.toHaveBeenCalled();
  });
  it('unsupported receipt endpoint or a retargeted prepare response refuses before saving or paying', async () => {
    ports.get = vi.fn().mockRejectedValue(new Error('404')); await begin(); expect((await store.read()).operation).toBeNull();
    ports.prepare = vi.fn(async () => ({ ...training, idempotencyKey: 'replacement-key' })); await begin(); expect((await store.read()).operation).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
});
