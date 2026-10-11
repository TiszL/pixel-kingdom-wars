import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { HttpError } from '../src/lib/errors';
import { createFreeBasePurchaseProvider, registerFreeBasePurchaseRoutes } from '../src/game/freeBasePurchaseRoutes';
import { getFreeBasePurchase, purchaseFreeBase } from '../src/mining/freeBasePurchase';
import { getFreeBasePurchaseView } from '../src/mining/freeBasePurchaseView';
vi.mock('../src/mining/freeBasePurchase', () => ({ getFreeBasePurchase: vi.fn(), purchaseFreeBase: vi.fn() }));
vi.mock('../src/mining/freeBasePurchaseView', () => ({ getFreeBasePurchaseView: vi.fn() }));
afterEach(() => vi.resetAllMocks());
async function app() {
  const a = Fastify();
  a.decorate('authenticate', async (req: { headers: Record<string, unknown>; wallet: string }) => {
    if (!req.headers.authorization) throw new HttpError(401, 'authentication required');
    req.wallet = 'authenticated-wallet';
  });
  registerFreeBasePurchaseRoutes(a, createFreeBasePurchaseProvider({} as Db));
  return a;
}
describe('free base purchase HTTP boundary', () => {
  it('keeps availability authenticated, private and scoped only by the explicit source UUID', async () => {
    const a = await app(); vi.mocked(getFreeBasePurchaseView).mockResolvedValue({ enabled: false } as never);
    try {
      expect((await a.inject({ url: '/bases/free-purchases?wallet=forged' })).statusCode).toBe(401);
      const headers = { authorization: 'fixture' }, source = '00000000-0000-4000-8000-000000000001';
      for (const query of ['wallet=forged', 'sourceBaseId=wrong', `sourceBaseId=${source}&price=1`]) {
        expect((await a.inject({ url: `/bases/free-purchases?${query}`, headers })).statusCode).toBe(400);
      }
      expect(getFreeBasePurchaseView).not.toHaveBeenCalled();
      const view = await a.inject({ url: `/bases/free-purchases?sourceBaseId=${source}`, headers });
      expect(view.statusCode).toBe(200); expect(view.headers['cache-control']).toBe('private, no-store');
      expect(getFreeBasePurchaseView).toHaveBeenCalledWith(expect.anything(), 'authenticated-wallet', source);
      expect(purchaseFreeBase).not.toHaveBeenCalled();
    } finally { await a.close(); }
  });
  it('authenticates first and refuses caller-controlled prices, wallets and malformed requests', async () => {
    const a = await app();
    try {
      expect((await a.inject({ method: 'POST', url: '/bases/free-purchases', payload: {} })).statusCode).toBe(401);
      for (const extra of [{ shardsCharged: '1' }, { wallet: 'forged' }, { ownership: true }]) {
        const r = await a.inject({ method: 'POST', url: '/bases/free-purchases', headers: { authorization: 'fixture' }, payload: { sourceBaseId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'fixture-key', ...extra } });
        expect(r.statusCode).toBe(400);
      }
      expect(purchaseFreeBase).not.toHaveBeenCalled();
    } finally { await a.close(); }
  });
  it('uses the authenticated actor and retains private receipt recovery independent of current admission', async () => {
    const a = await app(); const receipt = { baseId: 'original-base' };
    vi.mocked(purchaseFreeBase).mockResolvedValue(receipt as never); vi.mocked(getFreeBasePurchase).mockResolvedValue(receipt as never);
    try {
      const request = { sourceBaseId: '00000000-0000-4000-8000-000000000001', idempotencyKey: 'fixture-key' };
      const bought = await a.inject({ method: 'POST', url: '/bases/free-purchases', headers: { authorization: 'fixture' }, payload: request });
      expect(bought.statusCode).toBe(201); expect(purchaseFreeBase).toHaveBeenCalledWith(expect.anything(), 'authenticated-wallet', request);
      const recovered = await a.inject({ method: 'GET', url: '/bases/free-purchases/by-key/fixture-key', headers: { authorization: 'fixture' } });
      expect(recovered.statusCode).toBe(200); expect(recovered.headers['cache-control']).toBe('private, no-store');
      expect(getFreeBasePurchase).toHaveBeenCalledWith(expect.anything(), 'authenticated-wallet', 'fixture-key');
    } finally { await a.close(); }
  });
});
