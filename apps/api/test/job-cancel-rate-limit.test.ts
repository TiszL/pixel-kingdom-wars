/**
 * The ordinary test app disables @fastify/rate-limit. This focused app mounts
 * the real game routes with the real plugin so the upgrade- and research-
 * cancellation mutations' secondary per-IP shields cannot silently become
 * inert (the same proof training-cancel-rate-limit.test.ts gives the troop
 * route). Durable wallet/base admission is exercised directly in
 * upgrade-cancel / research-cancel / base-cancel tests, deliberately bypassing
 * this Redis layer to prove it remains authoritative on fail-open.
 */
import rateLimit from '@fastify/rate-limit';
import { RESEARCH_CANCELLATION, UPGRADE_CANCELLATION } from '@shardkeep/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerGameRoutes, RESEARCH_CANCEL_RATE_LIMIT, UPGRADE_CANCEL_RATE_LIMIT } from '../src/game/routes';

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

async function spend(url: string, ip: string, budget: number): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i <= budget; i++) {
    const response = await app.inject({
      method: 'POST', url, headers: { 'x-forwarded-for': ip }, payload: {},
    });
    statuses.push(response.statusCode);
  }
  return statuses;
}

describe('per-IP admission for the dialog-gated cancellations', () => {
  it('declares fail-closed IP budgets from shared constants, keyed apart from the troop route', () => {
    expect(UPGRADE_CANCEL_RATE_LIMIT).toMatchObject({
      max: UPGRADE_CANCELLATION.ipRateLimitPerMin,
      timeWindow: UPGRADE_CANCELLATION.ipRateLimitWindowMs,
      hook: 'onRequest',
      skipOnError: false,
    });
    expect(RESEARCH_CANCEL_RATE_LIMIT).toMatchObject({
      max: RESEARCH_CANCELLATION.ipRateLimitPerMin,
      timeWindow: RESEARCH_CANCELLATION.ipRateLimitWindowMs,
      hook: 'onRequest',
      skipOnError: false,
    });
    const req = { ip: '203.0.113.1' } as never;
    expect(UPGRADE_CANCEL_RATE_LIMIT.keyGenerator(req)).toBe('base-upgrade-cancel-ip:203.0.113.1');
    expect(RESEARCH_CANCEL_RATE_LIMIT.keyGenerator(req)).toBe('army-research-cancel-ip:203.0.113.1');
  });

  it('POST /base/jobs/:id/cancel rejects after one IP spends the explicit route budget', async () => {
    const statuses = await spend(
      '/base/jobs/00000000-0000-4000-8000-000000000000/cancel', '203.0.113.30',
      UPGRADE_CANCELLATION.ipRateLimitPerMin,
    );
    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it('POST /army/research/:troop/cancel rejects after one IP spends the explicit route budget', async () => {
    const statuses = await spend(
      '/army/research/giant/cancel', '203.0.113.40', RESEARCH_CANCELLATION.ipRateLimitPerMin,
    );
    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});
