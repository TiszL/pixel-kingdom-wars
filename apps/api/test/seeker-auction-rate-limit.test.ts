/** S6-S3 tests-first: real route registration and in-memory production limiter.
 * Deliberately absent source returns 503 after authentication, before any RPC.
 * No buildApp, database helper, Redis connection or socket listener is used. */
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerSeekerAuctionRoutes } from '../src/seeker/auctionRoutes';

const apps: FastifyInstance[] = [];
const wallet = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const auth = { authorization: 'fixture-session' };
// review d954db2f/bb11c2cc: explicit policy expectation, independent of the
// production constant so a mistaken larger limit cannot make the test pass.
const acceptedRefundLimit = 6;

afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

async function fixture() {
  const app = Fastify(); apps.push(app);
  await app.register(rateLimit, { global: false });
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.headers.authorization !== auth.authorization) {
      await reply.code(401).send({ error: 'Authentication required' }); return;
    }
    request.wallet = wallet;
  });
  registerSeekerAuctionRoutes(app, null);
  await app.ready();
  return app;
}

describe('S6-S3 independent Seeker refunds rate limit', () => {
  it('admits six authenticated refund checks, limits the seventh, and preserves ordinary reads', async () => {
    const app = await fixture();
    for (let call = 0; call < acceptedRefundLimit; call++) {
      const response = await app.inject({ url: '/seeker/auctions/refunds', headers: auth });
      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
    const blocked = await app.inject({ url: '/seeker/auctions/refunds', headers: auth });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['x-ratelimit-limit'])).toBe(acceptedRefundLimit);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.headers['cache-control']).toBe('private, no-store');

    // A separate bucket alone is insufficient: accidentally lowering readAuth
    // globally to six must fail this regression too.
    for (let call = 0; call < acceptedRefundLimit + 1; call++) {
      const current = await app.inject({ url: '/seeker/auctions/current', headers: auth });
      expect(current.statusCode).toBe(503);
      expect(Number(current.headers['x-ratelimit-limit'])).toBe(120);
      expect(current.headers['cache-control']).toBe('private, no-store');
    }
  });

  it('keeps both refund and ordinary reads authenticated and uncached', async () => {
    const app = await fixture();
    for (const url of ['/seeker/auctions/refunds', '/seeker/auctions/current']) {
      const response = await app.inject({ url });
      expect(response.statusCode).toBe(401);
      expect(response.headers['cache-control']).toBe('private, no-store');
    }
  });
});
