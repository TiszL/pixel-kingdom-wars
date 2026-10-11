import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GemsBuyController, type GemsBuyPorts } from './controller';
import { GemsBuyJournalStore, type GemsBuyIdentity } from './journal';
import { prepareGemsBuyPayment, signGemsBuyPayment, assertGemsBuyPaymentLive } from './payment';
import { address, binding, connection, credited, disclosure, policy, quote, recovery, request, response, wallet } from './fixtures.test-support';
const identity: GemsBuyIdentity = { origin: 'https://game.test', api: 'https://game.test/api', cluster: 'devnet', wallet: binding.wallet };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
let factory: IDBFactory, store: GemsBuyJournalStore, controller: GemsBuyController, ports: GemsBuyPorts;
let current: boolean, epoch: number, locked: boolean, known: boolean, paid: boolean, elapsed: number, wall: number;
let paymentWallet: ReturnType<typeof wallet>;
beforeEach(() => {
  factory = new IDBFactory(); store = new GemsBuyJournalStore(identity, factory); current = true; epoch = 0; locked = false; known = false; paid = false; elapsed = 0; wall = 0;
  const rpc = connection(); paymentWallet = wallet();
  ports = {
    get: vi.fn(async () => known ? { ...recovery(), deposit: { originalIntent: quote(), ...(paid ? credited() : disclosure()) } } : { ...recovery(), status: 'unknown', deposit: null }),
    post: vi.fn(async (path, body) => {
      if (path === '/deposits') { expect((await store.read()).purchase?.request).toEqual(body); known = true; return response(); }
      if (path.endsWith('/paid')) return { committed: true };
      paid = true; return { id: quote().id, kind: 'gems_buy', reference: quote().reference, ...credited() };
    }),
    capture: () => { const captured = epoch; return () => { if (!current || epoch !== captured) throw new Error('Account or view changed.'); }; },
    lock: async (_name, run) => { if (locked) throw new Error('Another tab'); locked = true; try { return await run(); } finally { locked = false; } },
    policy: vi.fn(async () => policy), prepare: vi.fn(async a => prepareGemsBuyPayment(a, rpc, 'expected-registry-genesis')),
    sign: vi.fn(async p => { expect((await store.read()).purchase?.prepared).not.toBeNull(); return signGemsBuyPayment(p, paymentWallet); }),
    live: vi.fn(async p => assertGemsBuyPaymentLive(p, rpc)),
    broadcast: vi.fn(async () => { expect(await store.read()).toMatchObject({ purchase: { broadcastStarted: true, signature: expect.any(String) } }); }),
    hydrate: vi.fn(async receipt => { expect((await store.read()).purchase?.deposit?.receipt).toEqual(receipt); }),
    clock: () => ({ elapsed, wall }), key: () => request.idempotencyKey,
  };
  controller = new GemsBuyController(store, ports);
});
const review = async () => { await controller.begin(10, binding); await controller.reviewPayment(); expect(controller.snapshot().error).toBeNull(); };
describe('durable wallet Gems purchase controller', () => {
  it('persists original consent, preparation, signature and broadcast marker before effects; actual overpayment receipt before hydration', async () => {
    await review(); await controller.pay();
    expect(controller.snapshot().error).toBeNull(); expect(ports.sign).toHaveBeenCalledOnce(); expect(ports.broadcast).toHaveBeenCalledOnce();
    expect((await store.read()).purchase).toMatchObject({ request, binding, hydrated: true, deposit: { keepCredited: '12', dustBaseUnits: '7' } });
    expect(ports.hydrate).toHaveBeenCalledWith(expect.objectContaining({ result: { currency: 'GEMS', amount: '12', rate: 1 } }), expect.any(Function));
    await controller.finish(); expect((await store.read()).archives).toHaveLength(1); expect((await store.read()).purchase).toBeNull();
    await controller.begin(10, binding); expect(controller.snapshot().error).toContain('keys cannot be reused');
  });
  it('lost create response survives restart; open GET cannot obtain signing authority; explicit review reuses original body/key', async () => {
    ports.post = vi.fn(async () => { known = true; throw new Error('lost create response'); });
    await controller.begin(10, binding); expect((await store.read()).purchase?.quote).toBeNull();
    controller = new GemsBuyController(new GemsBuyJournalStore(identity, factory), ports);
    await controller.open(); expect((await store.read()).purchase?.quote).toEqual(quote());
    await controller.pay(); expect(ports.sign).not.toHaveBeenCalled(); expect(ports.post).toHaveBeenCalledOnce();
    ports.post = vi.fn(async () => response()); await controller.reviewPayment();
    expect(ports.post).toHaveBeenCalledExactlyOnceWith('/deposits', request, expect.any(Function));
  });
  it('unsupported recovery server never creates an intent or prompts a wallet', async () => {
    ports.get = vi.fn().mockRejectedValue(new Error('404 unsupported'));
    await controller.begin(10, binding); expect((await store.read()).purchase).toBeNull(); expect(ports.post).not.toHaveBeenCalled(); expect(ports.sign).not.toHaveBeenCalled();
  });
  it('old recovery envelopes remain readable but cannot authorize begin, review or payment without late-payment recovery support', async () => {
    const oldRead = async () => { const { expiredPaymentRecovery: _marker, ...old } = recovery(); return known ? old : { ...old, status: 'unknown', deposit: null }; };
    ports.get = vi.fn(oldRead); await controller.begin(10, binding);
    expect((await store.read()).purchase).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
    ports.get = vi.fn(async () => known ? recovery() : { ...recovery(), status: 'unknown', deposit: null }); await review();
    ports.get = vi.fn(oldRead); await controller.pay(); expect(ports.sign).not.toHaveBeenCalled();
    await controller.open(); expect((await store.read()).purchase?.quote).toEqual(quote());
    const posts = vi.mocked(ports.post).mock.calls.length; await controller.reviewPayment();
    expect(ports.post).toHaveBeenCalledTimes(posts); expect(ports.sign).not.toHaveBeenCalled();
  });
  it.each(['request', 'prepared', 'signature', 'broadcast'] as const)('failed %s durability stops the next irreversible effect', async stage => {
    if (stage !== 'request') await review();
    const original = store.compareAndSet.bind(store);
    vi.spyOn(store, 'compareAndSet').mockImplementation(async (revision, update) => {
      const old = await store.read(), next = update(structuredClone(old));
      if (stage === 'request' && !old.purchase && next.purchase || stage === 'prepared' && !old.purchase?.prepared && next.purchase?.prepared
        || stage === 'signature' && !old.purchase?.signature && next.purchase?.signature || stage === 'broadcast' && !old.purchase?.broadcastStarted && next.purchase?.broadcastStarted) throw new Error('disk full');
      return original(revision, update);
    });
    if (stage === 'request') await controller.begin(10, binding); else await controller.pay();
    expect(controller.snapshot().error).toContain('disk full'); expect(ports.broadcast).not.toHaveBeenCalled();
    if (stage === 'request') expect(ports.post).not.toHaveBeenCalled();
    if (stage === 'request' || stage === 'prepared') expect(ports.sign).not.toHaveBeenCalled();
    if (stage === 'signature') expect((await store.read()).purchase?.prepared).not.toBeNull();
  });
  it.each(['logout', 'view', 'dismiss'] as const)('late wallet callback after %s saves under original identity without publishing or relaying', async change => {
    await review(); const pending = deferred<void>();
    ports.sign = vi.fn(async p => { await pending.promise; return signGemsBuyPayment(p, paymentWallet); });
    const action = controller.pay(); await vi.waitFor(() => expect(ports.sign).toHaveBeenCalledOnce());
    if (change === 'logout') current = false; else if (change === 'view') epoch++; else controller.dismiss();
    const snapshot = controller.snapshot(); pending.resolve(); await action;
    expect((await store.read()).purchase?.signature).toBeTruthy(); expect(ports.broadcast).not.toHaveBeenCalled();
    expect(controller.snapshot()).toBe(snapshot);
  });
  it('wallet throws are permanently uncertain; restart/failed/expired observations never authorize another attempt or abandonment', async () => {
    await review(); ports.sign = vi.fn().mockRejectedValue(new Error('User rejected / provider timeout'));
    await controller.pay(); expect((await store.read()).purchase?.prepared).not.toBeNull();
    ports.get = vi.fn(async () => ({ ...recovery(), deposit: { originalIntent: quote(), ...disclosure(), status: 'expired' } }));
    controller = new GemsBuyController(new GemsBuyJournalStore(identity, factory), ports);
    await controller.open(); await controller.reviewPayment(); await controller.pay(); await controller.abandonDraft();
    expect(ports.sign).toHaveBeenCalledOnce(); expect((await store.read()).purchase).not.toBeNull(); expect(ports.broadcast).not.toHaveBeenCalled();
  });
  it('paused flag permits original receipt recovery, never signing; wrong wallet receipt cannot finish or hydrate', async () => {
    await review(); ports.policy = vi.fn().mockRejectedValue(new Error('paused'));
    paid = true; await controller.open(); expect((await store.read()).purchase?.deposit?.receipt).toBeTruthy();
    await controller.recoverPayment(); expect((await store.read()).purchase?.hydrated).toBe(true); expect(ports.sign).not.toHaveBeenCalled();
    const other = new GemsBuyJournalStore(identity, new IDBFactory()); controller = new GemsBuyController(other, ports); store = other; known = false; paid = false;
    ports.policy = vi.fn(async () => policy); await controller.begin(10, binding);
    ports.get = vi.fn(async () => ({ ...recovery(), deposit: { originalIntent: quote(), ...credited(), receipt: { ...credited().receipt, wallet: address(40) } } }));
    await controller.recoverPayment(); expect((await store.read()).purchase?.deposit?.receipt).toBeUndefined(); expect((await store.read()).purchase?.hydrated).toBe(false);
  });
  it('changed terms or sleeping beyond quote expiry cannot prompt; timeout after valid signature persists it before blocking relay', async () => {
    await review(); ports.policy = vi.fn(async () => ({ ...policy, destinationAta: address(40) }));
    await controller.pay(); expect(ports.sign).not.toHaveBeenCalled();
    ports.policy = vi.fn(async () => policy); await controller.reviewPayment(); wall = 60000;
    await controller.pay(); expect(ports.sign).not.toHaveBeenCalled(); wall = 0; await controller.reviewPayment();
    ports.sign = vi.fn(async p => { const signed = await signGemsBuyPayment(p, paymentWallet); wall = 60000; return signed; });
    await controller.pay(); expect((await store.read()).purchase?.signature).toBeTruthy(); expect(ports.broadcast).not.toHaveBeenCalled();
  });
  it('duplicate clicks and another tab cannot open a second wallet; broadcast uncertainty never retries raw bytes', async () => {
    await review(); const pending = deferred<void>(); ports.sign = vi.fn(async p => { await pending.promise; return signGemsBuyPayment(p, paymentWallet); });
    ports.broadcast = vi.fn().mockRejectedValue(new Error('response lost'));
    const action = controller.pay(); await vi.waitFor(() => expect(ports.sign).toHaveBeenCalledOnce()); await controller.pay();
    const other = new GemsBuyController(new GemsBuyJournalStore(identity, factory), ports); await other.reviewPayment(); expect(other.snapshot().error).toContain('Another tab');
    pending.resolve(); await action;
    controller = new GemsBuyController(new GemsBuyJournalStore(identity, factory), ports); await controller.open(); await controller.pay(); await controller.recoverPayment();
    expect(ports.sign).toHaveBeenCalledOnce(); expect(ports.broadcast).toHaveBeenCalledOnce(); expect((await store.read()).purchase?.hydrated).toBe(true);
  });
  it('a losing late-wallet CAS cannot overwrite another tab or broadcast its signature', async () => {
    await review(); ports.sign = vi.fn(async p => {
      const saved = await store.read(); await store.compareAndSet(saved.revision, old => old);
      return signGemsBuyPayment(p, paymentWallet);
    });
    await controller.pay(); expect(controller.snapshot().error).toContain('Another tab');
    expect((await store.read()).purchase?.prepared).not.toBeNull(); expect((await store.read()).purchase?.signature).toBeNull();
    expect(ports.broadcast).not.toHaveBeenCalled();
  });
  it('abandonment requires a fresh matching no-evidence read and preserves the full original draft for audit', async () => {
    await controller.begin(10, binding);
    ports.get = vi.fn(async () => ({ ...recovery(), deposit: { originalIntent: quote(), ...disclosure(), amount: '7', dustBaseUnits: '7' } }));
    await controller.abandonDraft(); expect((await store.read()).purchase).not.toBeNull();
    // Use a separate unattempted draft: positive observations can never be erased.
    factory = new IDBFactory(); store = new GemsBuyJournalStore(identity, factory); controller = new GemsBuyController(store, ports);
    ports.get = vi.fn(async () => ({ ...recovery(), status: 'unknown', deposit: null })); known = false;
    ports.post = vi.fn().mockRejectedValue(new Error('lost'));
    await controller.begin(10, binding); await controller.abandonDraft();
    expect((await store.read()).purchase).toBeNull(); expect((await store.read()).archives[0]).toMatchObject({ reason: 'unattempted', purchase: { request, binding } });
  });
});
