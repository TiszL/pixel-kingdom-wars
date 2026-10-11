import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ForgeClaimController, type ForgeClaimPorts } from './controller';
import { ForgeClaimJournalStore } from './journal';
import { baseA, baseB, deferred, identity, intent, key, receipt, status, target } from './fixtures.test-support';
let factory: IDBFactory, store: ForgeClaimJournalStore, controller: ForgeClaimController, ports: ForgeClaimPorts;
let current: boolean, epoch: number, locked: boolean;
beforeEach(() => {
  factory = new IDBFactory(); store = new ForgeClaimJournalStore(identity, factory); current = true; epoch = 0; locked = false;
  ports = { get: vi.fn(async () => status()), post: vi.fn(async () => receipt()), key: () => key,
    lock: async (_name, run) => { if (locked) throw new Error('another tab'); locked = true; try { return await run(); } finally { locked = false; } },
    capture: (newAction) => { const old = epoch; return () => { if (!current || newAction && epoch !== old) throw new Error('account or page changed'); }; },
    unsupported: e => e instanceof Error && e.message === 'unsupported',
    consent: vi.fn(async (input, k) => intent(input.day, input.baseId, k)), validate: vi.fn(async () => undefined),
    confirmed: vi.fn(), hydrate: vi.fn(async () => ({ walletKeep: 'refreshed' as const })) };
  controller = new ForgeClaimController(store, ports);
});
const submit = async (day: string | null = null) => { await controller.review({ baseId: baseA, day }); await controller.confirm(); };
describe('Forge original claims survive uncertainty', () => {
  it('open review and Back stay GET-only while confirmation strictly persists exact request before POST', async () => {
    await controller.open(); await controller.open(); await controller.review({ baseId: baseA, day: null }); controller.dismiss(); await controller.confirm(); expect(ports.post).not.toHaveBeenCalled();
    ports.post = vi.fn(async () => { expect((await new ForgeClaimJournalStore(identity, factory).read()).intent).toEqual(intent()); return receipt(); });
    await submit(); expect(ports.post).toHaveBeenCalledExactlyOnceWith('/forge/claims/v1', intent().request, expect.any(Function)); expect((await store.read()).receipt).toEqual(receipt()); expect(ports.confirmed).toHaveBeenCalledOnce();
  });
  it.each([null, '2026-09-11'])('day=%s process death after journal commit permits only explicit same-key retry after GET', async day => {
    await store.compareAndSet(0, r => ({ ...r, intent: intent(day) })); ports.post = vi.fn(async () => receipt(day));
    controller = new ForgeClaimController(new ForgeClaimJournalStore(identity, factory), ports); await controller.open(); expect(ports.post).not.toHaveBeenCalled();
    await controller.retry(); expect(ports.post).toHaveBeenCalledExactlyOnceWith('/forge/claims/v1', intent(day).request, expect.any(Function));
    expect(ports.validate).toHaveBeenCalledWith(intent(day), expect.any(Function), true);
  });
  it('first and later HTTP refusals remain unknown through reload null and404, blocking replacement', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('422 refused')); await submit();
    controller = new ForgeClaimController(new ForgeClaimJournalStore(identity, factory), ports); await controller.open(); await submit('2026-09-11'); expect(ports.post).toHaveBeenCalledOnce();
    ports.get = vi.fn().mockRejectedValueOnce(new Error('unsupported')).mockResolvedValue(status()); await controller.retry(); expect(ports.post).toHaveBeenCalledOnce();
    await controller.retry(); await controller.finish(); expect(ports.post).toHaveBeenCalledTimes(2); expect((await store.read()).intent).toEqual(intent()); expect((await store.read()).receipt).toBeNull();
  });
  it('immutable empty receipt is a finished zero command and never claims a future allocation automatically', async () => {
    ports.post = vi.fn(async () => receipt(null, baseA, true)); await submit(); await controller.finish();
    ports.get = vi.fn(async () => status(receipt(null, baseA, true))); controller = new ForgeClaimController(new ForgeClaimJournalStore(identity, factory), ports); await controller.open();
    expect((await store.read()).finished).toBe(true); expect((await store.read()).receipt!.result).toEqual({ claimed: [], totalKeep: '0', remaining: 0 }); expect(ports.post).toHaveBeenCalledOnce();
    await controller.retry(); expect(ports.post).toHaveBeenCalledOnce();
  });
  it('kill switch blocks new or uncertain POST but still hydrates an exact historical receipt', async () => {
    ports.get = vi.fn(async () => status(null, false)); await submit(); expect(ports.post).not.toHaveBeenCalled();
    await store.compareAndSet(0, r => ({ ...r, intent: intent() })); await controller.retry(); expect(ports.post).not.toHaveBeenCalled();
    ports.get = vi.fn(async () => status(receipt(), false)); await controller.open(); await controller.finish(); expect((await store.read()).finished).toBe(true); expect(ports.post).not.toHaveBeenCalled();
  });
  it('failed hydration preserves proof and Finish remains unavailable until exact original destination refresh', async () => {
    ports.hydrate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ walletKeep: 'unavailable' }); await submit();
    expect((await store.read()).receipt).toEqual(receipt()); await controller.finish(); expect((await store.read()).finished).toBe(false);
    ports.get = vi.fn(async () => status(receipt())); controller = new ForgeClaimController(new ForgeClaimJournalStore(identity, factory), ports); await controller.open(); await controller.finish();
    expect(ports.post).toHaveBeenCalledOnce(); expect(ports.confirmed).toHaveBeenCalledOnce(); expect((await store.read()).hydrated).toEqual({ walletKeep: 'unavailable' });
  });
  it('cross-wallet mismatched selectors and changed valid ledger proof cannot replace immutable result', async () => {
    ports.post = vi.fn(async () => ({ ...receipt(), actor: target })); await submit(); expect((await store.read()).receipt).toBeNull();
    ports.get = vi.fn(async () => status({ ...receipt(), baseId: baseB })); await controller.open(); expect((await store.read()).receipt).toBeNull();
    ports.get = vi.fn(async () => status(receipt())); await controller.open();
    ports.get = vi.fn(async () => status({ ...receipt(), result: { claimed: [{ day: '2026-09-11', keep: '99', ledgerTransactionId: baseB }], totalKeep: '99', remaining: 0 } }));
    await controller.open(); expect((await store.read()).receipt).toEqual(receipt()); expect(controller.snapshot().error).toContain('immutable');
  });
  it('unsupported malformed status and failed durable reads or writes never authorize new POST', async () => {
    for (const get of [vi.fn().mockRejectedValue(new Error('unsupported')), vi.fn(async () => ({ ...status(), version: 2 })), vi.fn(async () => ({ ...status(), wallet: target }))]) {
      ports.get = get; await submit(); expect(ports.post).not.toHaveBeenCalled();
    }
    ports.get = vi.fn(async () => status()); vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('unreadable')); await submit(); expect(ports.post).not.toHaveBeenCalled();
    vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); await submit(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('failed receipt persistence rescues by exact GET and CAS fences late losing response', async () => {
    ports.post = vi.fn(async () => { vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); return receipt(); }); await submit(); expect((await store.read()).receipt).toBeNull();
    ports.get = vi.fn(async () => status(receipt())); await controller.open(); expect((await store.read()).receipt).toEqual(receipt());
    factory = new IDBFactory(); store = new ForgeClaimJournalStore(identity, factory); controller = new ForgeClaimController(store, ports); ports.get = vi.fn(async () => status());
    const pending = deferred<unknown>(); ports.post = vi.fn(() => pending.promise); const action = submit(); await vi.waitFor(() => expect(ports.post).toHaveBeenCalledOnce());
    const saved = await store.read(); await store.compareAndSet(saved.revision, r => ({ ...r })); pending.resolve(receipt()); await action; expect((await store.read()).receipt).toBeNull(); expect(controller.snapshot().error).toContain('Another tab');
  });
  it.each(['Back', 'hidden', 'account'])('%s during pending final preflight cannot send obsolete consent', async change => {
    await controller.review({ baseId: baseA, day: null }); const pending = deferred<unknown>(); ports.get = vi.fn(() => pending.promise);
    const action = controller.confirm(); await vi.waitFor(() => expect(ports.get).toHaveBeenCalledOnce());
    if (change === 'Back') controller.dismiss(); else if (change === 'hidden') epoch++; else current = false;
    pending.resolve(status()); await action; expect(ports.post).not.toHaveBeenCalled();
  });
  it('duplicate click and other tab cannot queue a second claim and obsolete late success stays recoverable', async () => {
    const pending = deferred<unknown>(); ports.post = vi.fn(() => pending.promise); const action = submit(); await vi.waitFor(() => expect(ports.post).toHaveBeenCalledOnce());
    await controller.confirm(); const other = new ForgeClaimController(new ForgeClaimJournalStore(identity, factory), ports); await other.retry(); expect(other.snapshot().error).toContain('another tab');
    current = false; pending.resolve(receipt()); await action; expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).receipt).toBeNull(); expect((await store.read()).intent).toEqual(intent()); expect(ports.confirmed).not.toHaveBeenCalled();
  });
  it.each([false, true])('explicit POST empty=%s confirms only after its exact receipt is durable', async empty => {
    ports.post = vi.fn(async () => receipt(null, baseA, empty));
    ports.confirmed = vi.fn(() => { expect(controller.snapshot().journal?.receipt).toEqual(receipt(null, baseA, empty)); });
    await submit(); expect(ports.confirmed).toHaveBeenCalledOnce();
    expect((await store.read()).receipt).toEqual(receipt(null, baseA, empty));
    ports.get = vi.fn(async () => status(receipt(null, baseA, empty))); await controller.open(); await controller.finish();
    expect(ports.confirmed).toHaveBeenCalledOnce();
  });
  it('GET-only discovery after a lost POST is silent while recording the authoritative outcome', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost')); await submit(); expect(ports.confirmed).not.toHaveBeenCalled();
    ports.get = vi.fn(async () => status(receipt())); await controller.open(); await controller.finish();
    expect((await store.read()).receipt).toEqual(receipt()); expect(ports.confirmed).not.toHaveBeenCalled();
  });
  it('failed durable receipt write does not emit successful action feedback', async () => {
    ports.post = vi.fn(async () => { vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); return receipt(); });
    await submit(); expect(ports.confirmed).not.toHaveBeenCalled();
    ports.get = vi.fn(async () => status(receipt())); await controller.open(); expect(ports.confirmed).not.toHaveBeenCalled();
  });
  it('only a fresh explicit confirmation after Finish can replace the tombstone with a distinct key', async () => {
    await submit(); await controller.finish(); ports.get = vi.fn(async () => status(receipt())); await controller.review({ baseId: baseA, day: '2026-09-11' }); await controller.confirm();
    expect(ports.post).toHaveBeenCalledOnce(); expect(controller.snapshot().error).toContain('distinct key');
    ports.key = () => baseB; ports.post = vi.fn(async () => ({ ...receipt('2026-09-11'), idempotencyKey: baseB })); await controller.review({ baseId: baseA, day: '2026-09-11' }); await controller.confirm();
    expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).intent?.request.idempotencyKey).toBe(baseB);
  });
});
