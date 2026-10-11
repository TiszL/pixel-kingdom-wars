import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedMarketPayment } from './payment';
import { MarketController, type MarketPorts } from './controller';
import { MarketJournalStore, type ReservationReceipt } from './journal';
import { deferred, id, identity, purchase, receipt, reserveCommand } from './fixtures.test-support';
const signature = '2'.repeat(88);
const feature = { features: { itemMarket: { version: 1, listingReceipts: 1, reservationReceipts: 1, cancelReceipts: 1 } } };
let store: MarketJournalStore; let controller: MarketController; let ports: MarketPorts;
let current: boolean; let elapsed: number; let wall: number; let remote: ReservationReceipt;
let posts: { path: string; body: unknown }[]; let locked: boolean;
const assert = (): void => { if (!current) throw new Error('identity or page changed'); };
beforeEach(() => {
  store = new MarketJournalStore(identity, new IDBFactory()); current = true; elapsed = 0; wall = 1000000; remote = receipt(); posts = []; locked = false;
  ports = {
    get: vi.fn(async (path) => path === '/market/listings' ? feature : remote),
    post: vi.fn(async (path, body) => {
      posts.push({ path, body });
      if (path.endsWith('/paid')) remote = { ...remote, state: 'committed', payable: false, paymentSignature: signature };
      if (path.endsWith('/settle')) remote = { ...remote, state: 'settled', payable: false, paymentSignature: signature, txSignature: signature, resolvedAt: '2026-09-13T00:00:05.000Z' };
      return remote;
    }),
    lock: async (_name, action) => { if (locked) throw new Error('another tab'); locked = true; try { return await action(); } finally { locked = false; } },
    capture: () => assert,
    assertDestination: vi.fn(),
    prepare: vi.fn(async () => ({ networkFee: 5000 } as PreparedMarketPayment)),
    sign: vi.fn(async () => ({ signature, wire: new Uint8Array([9]) })),
    broadcast: vi.fn(async () => undefined),
    hydratePurchase: vi.fn(async (quote) => ({ baseId: quote.buyerBaseId, stillOwned: true })),
    hydrateCommand: vi.fn(async () => undefined), clock: () => ({ elapsed, wall }), key: () => id(1),
    firstRefusal: (error) => error instanceof Error && error.message === 'definitive' ? { status: 422, message: 'definitive' } : null,
  };
  controller = new MarketController(store, ports);
});
async function savedPurchase(): Promise<void> { await store.compareAndSet(0, (old) => ({ ...old, activated: true, purchase: purchase() })); await controller.open(); }
const reserve = () => { const c = reserveCommand(); if (c.kind !== 'reserve') throw new Error('fixture'); const { idempotencyKey: _key, ...body } = c.request; return controller.reserve(c.listingId, body); };

describe('original marketplace intent recovery', () => {
  it('persists a command before its first POST and atomically adopts the full quote', async () => {
    ports.post = vi.fn(async () => { expect((await store.read()).command).toEqual(reserveCommand()); return remote; });
    await reserve(); const saved = await store.read();
    expect(saved.command).toBeNull(); expect(saved.purchase?.receipt).toEqual(receipt()); expect(saved.activated).toBe(true);
  });
  it('never sends when the critical initial journal write fails', async () => {
    vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('disk full'));
    await reserve(); expect(ports.post).not.toHaveBeenCalled(); expect(controller.snapshot().error).toBe('disk full');
  });
  it('keeps unknown first response and 404 recovery, then explicitly retries the identical body/key', async () => {
    ports.post = vi.fn().mockRejectedValueOnce(new Error('response lost')).mockResolvedValueOnce(remote);
    await reserve(); const original = structuredClone((await store.read()).command);
    ports.get = vi.fn().mockRejectedValue(new Error('404'));
    await controller.open(); expect((await store.read()).command).toEqual(original);
    await controller.retryCommand(); expect(ports.post).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ports.post).mock.calls[0]).toEqual(vi.mocked(ports.post).mock.calls[1]); expect((await store.read()).purchase).not.toBeNull();
  });
  it('allows a proved first refusal to finish, but a later retry refusal never disproves the old ambiguous command', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('definitive'));
    await reserve(); expect((await store.read()).refusal?.status).toBe(422); await controller.finish(); expect((await store.read()).command).toBeNull();
    ports.post = vi.fn().mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('definitive'));
    await reserve(); await controller.retryCommand(); expect((await store.read()).refusal).toBeNull(); expect((await store.read()).command).not.toBeNull();
  });
  it('refuses feature fallback and any second order while an existing journal needs recovery', async () => {
    ports.get = vi.fn(async () => ({})); await reserve(); expect(ports.post).not.toHaveBeenCalled();
    ports.get = vi.fn(async () => feature); ports.post = vi.fn().mockRejectedValue(new Error('lost')); await reserve(); await reserve();
    expect(ports.post).toHaveBeenCalledTimes(1); expect(controller.snapshot().error).toContain('Finish the saved');
  });
  it('does not publish or overwrite an original command when a competing revision wins during POST', async () => {
    const response = deferred<unknown>(); ports.post = vi.fn(() => response.promise);
    const action = reserve(); await vi.waitFor(() => expect(ports.post).toHaveBeenCalledTimes(1));
    const old = await store.read(); await store.compareAndSet(old.revision, (r) => ({ ...r })); response.resolve(remote); await action;
    expect((await store.read()).command).not.toBeNull(); expect((await store.read()).purchase).toBeNull(); expect(controller.snapshot().error).toContain('another tab');
  });
  it('opening a saved purchase is GET-only and never prepares or signs', async () => {
    await savedPurchase(); await controller.open(); expect(ports.post).not.toHaveBeenCalled(); expect(ports.prepare).not.toHaveBeenCalled(); expect(ports.sign).not.toHaveBeenCalled();
  });
});
describe('one explicit wallet approval and one broadcast', () => {
  it('writes attempted before signing, signature before final GET, and proof before one send', async () => {
    await savedPurchase(); await controller.reviewPayment();
    ports.sign = vi.fn(async () => { expect((await store.read()).purchase?.attempted).toBe(true); return { signature, wire: new Uint8Array([9]) }; });
    const get = ports.get; ports.get = vi.fn(async (path) => { const saved = await store.read(); if (saved.purchase?.signature) expect(saved.purchase.signature).toBe(signature); return get(path); });
    ports.broadcast = vi.fn(async () => { expect((await store.read()).purchase?.signature).toBe(signature); });
    await controller.pay(); expect(ports.broadcast).toHaveBeenCalledTimes(1);
    expect(posts.map((p) => p.path)).toEqual([`/market/v1/reservations/${id(2)}/paid`, `/market/v1/reservations/${id(2)}/settle`]);
    expect(posts.every((p) => (p.body as { reference: string }).reference === remote.quote.reference)).toBe(true);
    expect((await store.read()).purchase?.hydrated).toEqual({ baseId: id(5), stillOwned: true });
  });
  it('a wallet exception holds attempted and never permits another signature', async () => {
    await savedPurchase(); await controller.reviewPayment(); ports.sign = vi.fn().mockRejectedValue(new Error('approval closed'));
    await controller.pay(); await controller.reviewPayment(); await controller.pay();
    expect(ports.sign).toHaveBeenCalledTimes(1); expect(ports.broadcast).not.toHaveBeenCalled(); expect((await store.read()).purchase?.attempted).toBe(true);
  });
  it('keeps the signature if the final fresh payable check is offline', async () => {
    await savedPurchase(); await controller.reviewPayment(); ports.sign = vi.fn(async () => {
      ports.get = vi.fn().mockRejectedValue(new Error('offline after sign')); return { signature, wire: new Uint8Array([9]) };
    });
    await controller.pay(); expect((await store.read()).purchase?.signature).toBe(signature); expect(ports.broadcast).not.toHaveBeenCalled();
    await controller.pay(); expect(ports.sign).toHaveBeenCalledTimes(1);
  });
  it('never sends if signature persistence fails even when wallet returned signed bytes', async () => {
    await savedPurchase(); await controller.reviewPayment(); ports.sign = vi.fn(async () => {
      vi.spyOn(store, 'compareAndSet').mockRejectedValueOnce(new Error('storage unavailable')); return { signature, wire: new Uint8Array([9]) };
    });
    await controller.pay(); expect(ports.broadcast).not.toHaveBeenCalled(); expect((await store.read()).purchase?.attempted).toBe(true); expect((await store.read()).purchase?.signature).toBeNull();
  });
  it.each(['elapsed', 'sleep', 'clock-backward', 'identity', 'server-expired'] as const)('refuses post-approval broadcast after %s changed, retaining all available proof', async (scenario) => {
    await savedPurchase(); await controller.reviewPayment();
    ports.sign = vi.fn(async () => {
      if (scenario === 'elapsed') elapsed += 120000;
      if (scenario === 'sleep') wall += 120000;
      if (scenario === 'clock-backward') wall -= 1;
      if (scenario === 'identity') current = false;
      if (scenario === 'server-expired') remote = { ...remote, payable: false };
      return { signature, wire: new Uint8Array([9]) };
    });
    await controller.pay(); expect(ports.broadcast).not.toHaveBeenCalled(); expect((await store.read()).purchase?.attempted).toBe(true);
    expect((await store.read()).purchase?.signature).toBe(signature);
  });
  it('serial browser ownership refuses another tab while the first wallet is open', async () => {
    await savedPurchase(); await controller.reviewPayment(); const signed = deferred<{ signature: string; wire: Uint8Array }>(); ports.sign = vi.fn(() => signed.promise);
    const paying = controller.pay(); await vi.waitFor(() => expect(ports.sign).toHaveBeenCalledTimes(1));
    const other = new MarketController(store, ports); await other.open(); expect(other.snapshot().error).toBe('another tab');
    signed.resolve({ signature, wire: new Uint8Array([9]) }); await paying; expect(ports.broadcast).toHaveBeenCalledTimes(1);
  });
  it('RPC uncertainty survives restart and only checks original paid/settle, without resigning or rebroadcast', async () => {
    await savedPurchase(); await controller.reviewPayment(); ports.broadcast = vi.fn().mockRejectedValue(new Error('RPC response lost'));
    await controller.pay(); const restarted = new MarketController(store, ports); await restarted.open(); await restarted.recoverPayment();
    expect(ports.sign).toHaveBeenCalledTimes(1); expect(ports.broadcast).toHaveBeenCalledTimes(1); expect((await store.read()).purchase?.receipt.state).toBe('settled');
  });
  it('does not let an unsaved fee review survive a process restart', async () => {
    await savedPurchase(); await controller.reviewPayment(); const restarted = new MarketController(store, ports); await restarted.open(); await restarted.pay();
    expect(ports.sign).not.toHaveBeenCalled(); expect(restarted.snapshot().error).toContain('Review the original');
  });
});
describe('settled proof and original destination hydration', () => {
  it('retains settled proof across offline hydration, restart and Finish refusal, then retries hydration without another verification', async () => {
    await savedPurchase(); await controller.reviewPayment(); ports.hydratePurchase = vi.fn().mockRejectedValue(new Error('directory offline'));
    await controller.pay(); expect((await store.read()).purchase?.receipt.state).toBe('settled'); expect((await store.read()).purchase?.hydrated).toBeNull();
    const restarted = new MarketController(store, ports); await restarted.open(); const originalPosts = posts.length; await restarted.finish(); expect((await store.read()).purchase).not.toBeNull();
    ports.hydratePurchase = vi.fn(async (quote) => ({ baseId: quote.buyerBaseId, stillOwned: false })); await restarted.recoverPayment();
    expect(posts).toHaveLength(originalPosts); expect((await store.read()).purchase?.hydrated).toEqual({ baseId: id(5), stillOwned: false });
    await restarted.finish(); expect((await store.read()).purchase).toBeNull(); expect((await store.read()).activated).toBe(true);
  });
  it('rejects a refresh of today selected base B as proof of original delivery into A', async () => {
    await savedPurchase(); await controller.reviewPayment(); ports.hydratePurchase = vi.fn(async () => ({ baseId: id(99), stillOwned: true }));
    await controller.pay(); expect((await store.read()).purchase?.receipt.state).toBe('settled'); expect((await store.read()).purchase?.hydrated).toBeNull();
    expect(controller.snapshot().error).toContain('delivery refresh');
  });
  it('closes only an unattempted review after exact GET; does not cancel its server reservation', async () => {
    await savedPurchase(); await controller.finish(); expect((await store.read()).purchase).toBeNull(); expect(ports.post).not.toHaveBeenCalled();
  });
  it('cannot discard an attempted superseded payment even when its server lifecycle is terminal', async () => {
    await savedPurchase(); await controller.reviewPayment(); ports.sign = vi.fn().mockRejectedValue(new Error('lost'));
    await controller.pay(); remote = { ...remote, state: 'superseded', payable: false, resolvedAt: '2026-09-13T00:03:00.000Z' };
    await controller.open(); await controller.finish(); expect((await store.read()).purchase).not.toBeNull();
  });
});

describe('listing and cancellation receipts', () => {
  const listing = () => ({ version: 1, idempotencyKey: id(1), creator: identity.wallet, listingId: id(3), itemId: 'iron_sword', sourceBaseId: id(4), priceLamports: '1000000', createdAt: '2026-09-13T00:00:00.000Z' });
  const cancellation = (state: 'pending' | 'cancelled' | 'settled' | 'refused') => ({
    version: 1, idempotencyKey: id(1), actor: identity.wallet, listingId: id(3), itemId: 'iron_sword', sourceBaseId: id(4), priceLamports: '1000000',
    expectedStatus: 'reserved', expectedReference: receipt().quote.reference, createdAt: '2026-09-13T00:00:00.000Z', state,
    resolvedAt: state === 'pending' ? null : '2026-09-13T00:00:05.000Z', refusalCode: state === 'refused' ? 'BASE_NOT_OWNED' : null,
    settlement: state === 'settled' ? { reference: receipt().quote.reference, txSignature: signature, buyer: identity.wallet, buyerBaseId: id(5) } : null,
  });
  const cancel = () => controller.cancel(id(3), { itemId: 'iron_sword', sourceBaseId: id(4), priceLamports: '1000000', status: 'reserved', reference: receipt().quote.reference });
  it('retains listing receipt until inventory hydration succeeds and preserves its original listing identity', async () => {
    ports.post = vi.fn(async () => listing()); await controller.list({ itemId: 'iron_sword', priceLamports: '1000000', baseId: id(4) });
    ports.get = vi.fn(async () => listing()); ports.hydrateCommand = vi.fn().mockRejectedValueOnce(new Error('inventory offline')).mockResolvedValueOnce(undefined);
    await controller.finish(); expect((await store.read()).command?.receipt).toEqual(listing()); await controller.finish(); expect((await store.read()).command).toBeNull();
  });
  it('rejects a matching-key listing receipt that changes the original listing ID', async () => {
    ports.post = vi.fn(async () => listing()); await controller.list({ itemId: 'iron_sword', priceLamports: '1000000', baseId: id(4) });
    ports.get = vi.fn(async () => ({ ...listing(), listingId: id(99) })); await controller.finish(); expect((await store.read()).command?.receipt).toEqual(listing());
    expect(controller.snapshot().error).toContain('original listing');
  });
  it.each(['cancelled', 'settled', 'refused'] as const)('retains exact %s attribution instead of reporting every cancellation as returned inventory', async (state) => {
    ports.post = vi.fn(async () => cancellation(state)); await cancel(); const saved = (await store.read()).command;
    expect(saved?.receipt).toEqual(cancellation(state)); expect(ports.sign).not.toHaveBeenCalled();
    ports.get = vi.fn(async () => cancellation(state)); await controller.finish(); expect(ports.hydrateCommand).toHaveBeenCalledExactlyOnceWith(saved);
  });
  it('keeps pending cancellation after reopen and retries only on explicit consent with the original key/reference', async () => {
    ports.post = vi.fn(async () => cancellation('pending')); await cancel(); const original = vi.mocked(ports.post).mock.calls[0];
    ports.get = vi.fn(async () => cancellation('pending')); await controller.open(); await controller.finish(); expect(ports.post).toHaveBeenCalledTimes(1); expect((await store.read()).command).not.toBeNull();
    await controller.retryCommand(); expect(vi.mocked(ports.post).mock.calls[1]).toEqual(original);
  });
  it('never treats a cancellation error as a locally proved refund or safe new key', async () => {
    ports.post = vi.fn().mockRejectedValue(new Error('definitive')); await cancel(); expect((await store.read()).refusal).toBeNull();
    ports.get = vi.fn().mockRejectedValue(new Error('404')); await controller.finish(); expect((await store.read()).command).not.toBeNull();
  });
  it('rejects cancellation paid-rescue proof for another original generation', async () => {
    const wrong = cancellation('settled'); wrong.settlement!.reference = identity.wallet;
    ports.post = vi.fn(async () => wrong); await cancel(); expect((await store.read()).command?.receipt).toBeNull();
  });
  it('still performs original settle if /paid cannot register a broadcast after its commit window', async () => {
    await savedPurchase(); await controller.reviewPayment();
    const original = ports.post; ports.post = vi.fn(async (path, body) => { if (path.endsWith('/paid')) throw new Error('commit window elapsed'); return original(path, body); });
    await controller.pay(); expect((await store.read()).purchase?.receipt.state).toBe('settled'); expect(posts.at(-1)?.path).toBe(`/market/v1/reservations/${id(2)}/settle`);
  });
});

describe('late callback ownership and selected destination', () => {
  it('a losing tab cannot save its late wallet response over a newer revision or broadcast', async () => {
    await savedPurchase(); await controller.reviewPayment();
    ports.sign = vi.fn(async () => {
      const current = await store.read(); await store.compareAndSet(current.revision, (r) => ({ ...r }));
      return { signature, wire: new Uint8Array([9]) };
    });
    await controller.pay(); expect((await store.read()).purchase?.signature).toBeNull(); expect((await store.read()).purchase?.attempted).toBe(true);
    expect(ports.broadcast).not.toHaveBeenCalled(); expect(controller.snapshot().error).toContain('another tab');
  });
  it('requires the original receiving base before preparing another payment approval', async () => {
    await savedPurchase(); ports.assertDestination = vi.fn(() => { throw new Error('select original A'); });
    await controller.reviewPayment(); expect(ports.assertDestination).toHaveBeenCalledWith(id(5)); expect(ports.prepare).not.toHaveBeenCalled(); expect(ports.sign).not.toHaveBeenCalled();
  });
  it('catches a stale identity at capture without rejecting the UI event promise', async () => {
    ports.capture = () => { throw new Error('signed out'); }; await expect(controller.open()).resolves.toBeUndefined(); expect(controller.snapshot().error).toBe('signed out');
  });
});


describe('ended purchase dismissal preserves evidence while freeing the market', () => {
  async function ended(state: 'superseded' | 'cancelled' = 'superseded'): Promise<void> {
    remote = { ...receipt(), state, payable: false, resolvedAt: '2026-09-13T00:05:00.000Z' };
    await store.compareAndSet(0, (old) => ({ ...old, activated: true, purchase: { ...purchase(), receipt: remote, attempted: true, signature } }));
    await controller.open();
  }
  it.each(['superseded', 'cancelled'] as const)('archives exact %s proof only after fresh GET, survives restart, and permits fresh explicit consent', async (state) => {
    await ended(state); const original = (await store.read()).purchase!;
    vi.mocked(ports.get).mockClear();
    await controller.archivePurchase();
    expect(ports.get).toHaveBeenCalledExactlyOnceWith(`/market/v1/reservations/by-key/${id(1)}`);
    expect((await store.read()).purchase).toBeNull(); expect((await store.read()).archivedPurchases).toEqual([original]);
    const restarted = new MarketController(store, ports); await restarted.open();
    expect(restarted.snapshot().journal?.archivedPurchases).toEqual([original]);
    expect(ports.post).not.toHaveBeenCalled(); expect(ports.sign).not.toHaveBeenCalled(); expect(ports.broadcast).not.toHaveBeenCalled();
    remote = receipt(); remote.quote = { ...remote.quote, idempotencyKey: id(20), reservationId: id(21), reference: remote.quote.seller };
    ports.key = () => id(20);
    const command = reserveCommand(); if (command.kind !== 'reserve') throw new Error('fixture');
    const { idempotencyKey: _oldKey, ...request } = command.request;
    await restarted.reserve(command.listingId, request);
    expect((await store.read()).purchase).toMatchObject({ attempted: false, signature: null, receipt: { quote: { idempotencyKey: id(20), reservationId: id(21) } } });
    expect((await store.read()).archivedPurchases).toEqual([original]);
    expect(ports.post).toHaveBeenCalledTimes(1); expect(ports.sign).not.toHaveBeenCalled(); expect(ports.broadcast).not.toHaveBeenCalled();
  });
  it.each(['reserved', 'committed'] as const)('cannot archive or replace an active %s payment', async (state) => {
    remote = { ...receipt(), state, payable: state === 'reserved', paymentSignature: state === 'committed' ? signature : null };
    await store.compareAndSet(0, (old) => ({ ...old, activated: true, purchase: { ...purchase(), receipt: remote, attempted: true, signature } }));
    await controller.open(); await controller.archivePurchase(); await reserve();
    expect((await store.read()).purchase?.receipt.state).toBe(state); expect((await store.read()).archivedPurchases).toEqual([]);
    expect(ports.post).not.toHaveBeenCalled(); expect(ports.sign).not.toHaveBeenCalled();
  });
  it.each(['offline', 'quote-change', 'terminal-change', 'identity-change', 'storage-failure', 'competing-tab'] as const)('preserves active and archived evidence when dismissal encounters %s', async (failure) => {
    await ended(); const original = (await store.read()).purchase;
    if (failure === 'offline') ports.get = vi.fn().mockRejectedValue(new Error('offline'));
    if (failure === 'quote-change') remote = { ...remote, quote: { ...remote.quote, reservationId: id(99) } };
    if (failure === 'terminal-change') remote = { ...remote, state: 'settled', txSignature: signature };
    if (failure === 'identity-change') ports.get = vi.fn(async () => { current = false; return remote; });
    if (failure === 'storage-failure') {
      const write = store.compareAndSet.bind(store);
      vi.spyOn(store, 'compareAndSet').mockImplementationOnce(write).mockRejectedValueOnce(new Error('disk full'));
    }
    if (failure === 'competing-tab') ports.get = vi.fn(async () => {
      const current = await store.read(); await store.compareAndSet(current.revision, (old) => ({ ...old })); return remote;
    });
    await controller.archivePurchase();
    expect(controller.snapshot().error).not.toBeNull(); expect((await store.read()).purchase).toEqual(original);
    expect((await store.read()).archivedPurchases).toEqual([]); expect(ports.post).not.toHaveBeenCalled();
  });
});
