import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ClanController, type ClanPorts } from './controller';
import { ClanJournalStore } from './journal';
import { clanId, deferred, identity, intent, key, receipt, status, target } from './fixtures.test-support';
let factory: IDBFactory; let store: ClanJournalStore; let controller: ClanController; let ports: ClanPorts;
let current: boolean; let epoch: number; let locked: boolean;
beforeEach(() => {
  factory = new IDBFactory(); store = new ClanJournalStore(identity, factory); current = true; epoch = 0; locked = false;
  ports = { get: vi.fn(async () => status()), post: vi.fn(async () => receipt()), key: () => key,
    lock: async (_name, run) => { if (locked) throw new Error('another tab'); locked = true; try { return await run(); } finally { locked = false; } },
    capture: (newAction) => { const old = epoch; return () => { if (!current || newAction && epoch !== old) throw new Error('account or page changed'); }; },
    unsupported: (e) => e instanceof Error && e.message === 'unsupported', consent: vi.fn(async (input) => intent(input.kind)), validate: vi.fn(async () => undefined),
    hydrate: vi.fn(async (r) => ({ membershipAvailable: true, originalPayout: r.state === 'disbanded' ? 'refreshed' as const : 'not-applicable' as const })) };
  controller = new ClanController(store, ports);
});
const submit = async (kind: 'leave' | 'kick' = 'leave') => { await controller.review({ kind, clanId, ...(kind === 'kick' ? { target } : {}) }); await controller.confirm(); };
describe('clan command exact consent and uncertainty', () => {
  it('automatic entry/review/Back never POST; confirmation strictly saves the full original request first', async () => {
    await controller.open(); await controller.open(); await controller.review({ kind: 'leave', clanId }); controller.dismiss(); await controller.confirm();
    expect(ports.post).not.toHaveBeenCalled();
    ports.post = vi.fn(async () => { expect((await new ClanJournalStore(identity, factory).read()).intent).toEqual(intent()); return receipt(); });
    await submit(); expect(ports.post).toHaveBeenCalledExactlyOnceWith('/clans/v1/leave', intent().request, expect.any(Function));
    expect((await store.read()).receipt).toEqual(receipt());
  });
  it.each(['leave', 'kick'] as const)('restored %s saved before POST offers only explicit same-key replay after GET', async (kind) => {
    await store.compareAndSet(0, (r) => ({ ...r, intent: intent(kind) })); ports.post = vi.fn(async () => receipt(kind));
    controller = new ClanController(new ClanJournalStore(identity, factory), ports); await controller.open(); expect(ports.post).not.toHaveBeenCalled();
    await controller.retry(); expect(ports.post).toHaveBeenCalledExactlyOnceWith(`/clans/v1/${kind}`, intent(kind).request, expect.any(Function));
    expect(ports.validate).toHaveBeenCalledWith(intent(kind), expect.any(Function), true);
  });
  it('holds unknown through restart, null/404 and generic refusals, blocking any replacement', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost')); await submit();
    controller = new ClanController(new ClanJournalStore(identity, factory), ports); await controller.open(); await submit('kick');
    expect(ports.post).toHaveBeenCalledOnce(); ports.get = vi.fn().mockRejectedValueOnce(new Error('unsupported')).mockResolvedValue(status());
    await controller.retry(); expect(ports.post).toHaveBeenCalledOnce(); ports.post = vi.fn().mockRejectedValue(new Error('forbidden'));
    await controller.retry(); await controller.finish(); expect((await store.read()).intent).toEqual(intent()); expect((await store.read()).receipt).toBeNull();
  });
  it('a matching durable no-effect refusal after uncertainty is terminal, unlike an ordinary HTTP refusal', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('lost')); await submit();
    const refused = { ...receipt(), state: 'refused' as const, payoutShards: '0', ledgerTransactionId: null, refusalCode: 'CLAN_CHANGED' as const };
    ports.get = vi.fn(async () => status(refused)); await controller.retry(); await controller.finish();
    expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).receipt).toEqual(refused); expect((await store.read()).finished).toBe(true);
  });
  it('hydrates persisted proof after restart without POST and cannot Finish while refresh fails', async () => {
    ports.hydrate = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ membershipAvailable: false, originalPayout: 'unavailable' });
    await submit(); expect((await store.read()).receipt).toEqual(receipt()); await controller.finish(); expect((await store.read()).finished).toBe(false);
    ports.get = vi.fn(async () => status(receipt())); controller = new ClanController(new ClanJournalStore(identity, factory), ports);
    await controller.open(); await controller.finish(); expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).hydrated?.originalPayout).toBe('unavailable');
  });
  it('invalid/cross-account or changed immutable proof never overwrites original consent', async () => {
    ports.post = vi.fn(async () => ({ ...receipt(), actor: target })); await submit(); expect((await store.read()).receipt).toBeNull();
    ports.get = vi.fn(async () => status(receipt())); await controller.open();
    ports.get = vi.fn(async () => status({ ...receipt(), payoutShards: '99' })); await controller.open(); expect((await store.read()).receipt).toEqual(receipt());
    expect(controller.snapshot().error).toContain('immutable');
  });
  it('missing/corrupt capability and failed critical reads/writes never authorize a new command', async () => {
    for (const get of [vi.fn().mockRejectedValue(new Error('unsupported')), vi.fn(async () => ({ ...status(), version: 2 })), vi.fn(async () => ({ ...status(), wallet: target }))]) {
      ports.get = get; await submit(); expect(ports.post).not.toHaveBeenCalled();
    }
    ports.get = vi.fn(async () => status()); vi.spyOn(store, 'read').mockRejectedValueOnce(new Error('unreadable')); await submit(); expect(ports.post).not.toHaveBeenCalled();
    vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); await submit(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('failed proof persistence rescues by exact GET; CAS fences a late losing tab response', async () => {
    ports.post = vi.fn(async () => { vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full')); return receipt(); });
    await submit(); expect((await store.read()).receipt).toBeNull(); ports.get = vi.fn(async () => status(receipt())); await controller.open(); expect((await store.read()).receipt).toEqual(receipt());
    factory = new IDBFactory(); store = new ClanJournalStore(identity, factory); controller = new ClanController(store, ports); ports.get = vi.fn(async () => status());
    const pending = deferred<unknown>(); ports.post = vi.fn(() => pending.promise); const action = submit(); await vi.waitFor(() => expect(ports.post).toHaveBeenCalledOnce());
    const saved = await store.read(); await store.compareAndSet(saved.revision, (r) => ({ ...r })); pending.resolve(receipt()); await action;
    expect((await store.read()).receipt).toBeNull(); expect(controller.snapshot().error).toContain('Another tab');
  });
  it.each(['Back', 'hidden', 'account'] as const)('%s during a deferred preflight prevents POST; late success cannot affect the obsolete view', async (change) => {
    await controller.review({ kind: 'leave', clanId }); const pending = deferred<unknown>(); ports.get = vi.fn(() => pending.promise);
    const action = controller.confirm(); await vi.waitFor(() => expect(ports.get).toHaveBeenCalledOnce());
    if (change === 'Back') controller.dismiss(); else if (change === 'hidden') epoch++; else current = false;
    pending.resolve(status()); await action; expect(ports.post).not.toHaveBeenCalled();
  });
  it('duplicate clicks and another controller cannot queue another POST; late obsolete success remains recoverable', async () => {
    const pending = deferred<unknown>(); ports.post = vi.fn(() => pending.promise); const action = submit(); await vi.waitFor(() => expect(ports.post).toHaveBeenCalledOnce());
    await controller.confirm(); const other = new ClanController(new ClanJournalStore(identity, factory), ports); await other.retry();
    expect(other.snapshot().error).toContain('another tab'); current = false; pending.resolve(receipt()); await action;
    expect(ports.post).toHaveBeenCalledOnce(); expect((await store.read()).receipt).toBeNull(); expect((await store.read()).intent).toEqual(intent());
  });
});
