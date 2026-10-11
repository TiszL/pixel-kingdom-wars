/** Authenticated SHARDS purchase and original receipt recovery; dark in the service. */
import { TWOFA } from '@shardkeep/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client';
import { parse } from '../lib/validation';
import { HttpError } from '../lib/errors';
import { getFreeBasePurchase, purchaseFreeBase } from '../mining/freeBasePurchase';
import { getFreeBasePurchaseView } from '../mining/freeBasePurchaseView';
const Key = z.string().min(8).max(128);
export function createFreeBasePurchaseProvider(db: Db) {
  if ('rollback' in db) throw Error('Free-base purchase service requires a top-level connection');
  return Object.freeze({
    view: (wallet: string, baseId?: string) => getFreeBasePurchaseView(db, wallet, baseId),
    purchase: (wallet: string, request: { sourceBaseId: string; idempotencyKey: string }) => purchaseFreeBase(db, wallet, request),
    read: (wallet: string, key: string) => getFreeBasePurchase(db, wallet, key),
  });
}
export type FreeBasePurchaseProvider = ReturnType<typeof createFreeBasePurchaseProvider>;
export function registerFreeBasePurchaseRoutes(app: FastifyInstance, provider?: FreeBasePurchaseProvider | null): void {
  const use = () => {
    if (!provider) throw new HttpError(503, 'Free-base purchase history is unavailable; keep the original request', 'FREE_BASE_SOURCE_UNAVAILABLE');
    return provider;
  };
  const auth = { preHandler: [app.authenticate] };
  const noStore = async (_request: unknown, reply: { header: (key: string, value: string) => unknown }, payload: unknown) => {
    reply.header('Cache-Control', 'private, no-store'); return payload;
  };
  app.get('/bases/free-purchases', { ...auth, onSend: noStore }, async req => {
    const { sourceBaseId } = parse(z.object({ sourceBaseId: z.uuid().optional() }).strict(), req.query);
    return use().view(req.wallet, sourceBaseId);
  });
  app.post('/bases/free-purchases', { ...auth, onSend: noStore,
    config: { rateLimit: { max: TWOFA.verifyRateLimitPerMin, timeWindow: 60_000 } } }, async (req, reply) => {
    const request = parse(z.object({ sourceBaseId: z.uuid(), idempotencyKey: Key }).strict(), req.body);
    // Service recovers the original before checking its family gate/current ownership.
    const receipt = await use().purchase(req.wallet, request);
    return reply.code(201).send(receipt);
  });
  app.get('/bases/free-purchases/by-key/:key', { ...auth, onSend: noStore }, async req => {
    const { key } = parse(z.object({ key: Key }).strict(), req.params);
    return { receipt: await use().read(req.wallet, key) };
  });
}
