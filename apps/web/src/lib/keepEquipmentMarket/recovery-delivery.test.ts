import { webcrypto } from 'node:crypto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { KeepMarketController, type KeepMarketPorts } from './controller';
import { KeepMarketJournalStore, marketKey } from './journal';
import { keepMarketReleasedFixture } from './fixtures.testHelpers';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());

async function savedDelivery(staleAfterReview: boolean) {
  const f = keepMarketReleasedFixture();
  const store = new KeepMarketJournalStore({ origin: 'http://localhost', api: 'http://localhost/api', cluster: 'devnet', wallet: f.signed.fill.buyerWallet }, new IDBFactory());
  const command = { kind: 'fill' as const, key: f.signed.fill.id, request: null };
  let current = true;
  const guard = () => { if (!current) throw Error('view changed'); };
  const capture = vi.fn<KeepMarketPorts['capture']>((_action, _baseId, purpose) => {
    if (purpose !== 'saved-delivery') throw Error('history denies new orders');
    guard(); return guard;
  });
  const request = vi.fn<KeepMarketPorts['request']>(async (_request, check, retain) => {
    check(); await retain(f.signed); return f.signed;
  });
  const review = vi.fn<KeepMarketPorts['review']>(async (original, check) => {
    check(); expect(original.wire).toEqual(f.signed.wire);
    if (staleAfterReview) current = false;
    return { feeLamports: '5000', rentLamports: '0', totalLamports: '5000', assertFresh: guard };
  });
  const sign = vi.fn<KeepMarketPorts['sign']>(async () => { throw Error('must not sign again'); });
  const controller = new KeepMarketController(store, { capture, request, review, sign, key: () => crypto.randomUUID(), lock: async (_key, run) => run() });
  await store.begin(command); await store.retain(marketKey(command), f.signed); controller.select(marketKey(command));
  return { f, store, controller, request, review, sign };
}

it('nonterminal history delivery reviews the retained wire and delivers once without a wallet call', async () => {
  const f = await savedDelivery(false);
  try {
    await f.controller.deliver();
    expect(f.request.mock.calls.map(([request]) => request.action)).toEqual(['recover', 'deliver']);
    expect(f.review).toHaveBeenCalledOnce(); expect(f.sign).not.toHaveBeenCalled();
    expect((await f.store.read()).pending[0]!.original).toEqual(f.f.signed);
  } finally { await f.store.close(); }
});

it('a stale history view after saved-wire review cannot deliver or discard its original', async () => {
  const f = await savedDelivery(true);
  try {
    await expect(f.controller.deliver()).rejects.toThrow('view changed');
    expect(f.request.mock.calls.map(([request]) => request.action)).toEqual(['recover']);
    expect(f.sign).not.toHaveBeenCalled();
    expect((await f.store.read()).pending[0]!.original).toEqual(f.f.signed);
  } finally { await f.store.close(); }
});
