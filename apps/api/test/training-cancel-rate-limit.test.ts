/**
 * The ordinary test app disables @fastify/rate-limit. This focused app mounts
 * the real game routes with the real plugin so the cancellation mutation's
 * secondary per-IP shield cannot silently become inert. Durable wallet/base
 * admission is exercised directly in army.test/base-army.test, deliberately
 * bypassing this Redis layer to prove it remains authoritative on fail-open.
 */
import rateLimit from '@fastify/rate-limit';
import { TRAINING_CANCELLATION } from '@shardkeep/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerGameRoutes, TRAINING_CANCEL_RATE_LIMIT } from '../src/game/routes';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ trustProxy: 1 });
  await app.register(rateLimit, { global: true, max: 100_000, timeWindow: 60_000 });
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async (_req: FastifyRequest, reply: FastifyReply) => {
    await reply.code(401).send({ error: { message: 'stub' } });
  });
  app.decorate('authenticateLoginRecovery', app.authenticate);
  app.decorate('requireLandOwned', async () => undefined);
  registerGameRoutes(app as never, {} as never);
  await app.ready();
});

afterAll(async () => app.close());

describe('POST /army/train/:queueId/cancel per-IP admission', () => {
  it('declares a fail-closed IP budget from shared constants', () => {
    expect(TRAINING_CANCEL_RATE_LIMIT).toMatchObject({
      max: TRAINING_CANCELLATION.ipRateLimitPerMin,
      timeWindow: TRAINING_CANCELLATION.ipRateLimitWindowMs,
      hook: 'onRequest',
      skipOnError: false,
    });
    expect(TRAINING_CANCEL_RATE_LIMIT.keyGenerator({ ip: '203.0.113.1' } as never))
      .toBe('army-train-cancel-ip:203.0.113.1');
  });

  it('rejects the request after one IP spends the explicit route budget', async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= TRAINING_CANCELLATION.ipRateLimitPerMin; i++) {
      const response = await app.inject({
        method: 'POST',
        url: '/army/train/00000000-0000-4000-8000-000000000000/cancel',
        headers: { 'x-forwarded-for': '203.0.113.20' },
        payload: {},
      });
      statuses.push(response.statusCode);
    }
    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
