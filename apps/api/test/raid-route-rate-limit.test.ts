/** Exercise the real registrations with the production limiter enabled: the
 * ordinary buildApp test configuration omits it and cannot detect hook aliasing.
 * Authentication stops at 401 so no gameplay or DB mutation occurs. */
import rateLimit from '@fastify/rate-limit';
import { LIVE_RAID, RAID_REPLAY_LIMITS, TWOFA } from '@shardkeep/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerGameRoutes } from '../src/game/routes';
import { registerNativeRoutes } from '../src/native/routes';

const apps: FastifyInstance[] = [];
const raidId = '11111111-1111-4111-8111-111111111111';
const globalMax = 3;

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function fixture() {
  const app = Fastify({ trustProxy: 1 }); apps.push(app);
  await app.register(rateLimit, { global: true, max: globalMax, timeWindow: 60_000 });
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async (_req: FastifyRequest, reply: FastifyReply) => {
    await reply.code(401).send({ error: { message: 'test authentication boundary' } });
  });
  app.decorate('authenticateLoginRecovery', app.authenticate);
  app.decorate('requireLandOwned', async () => undefined);
  registerNativeRoutes(app, {
    NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_OPEN: 'true',
  }, {} as never);
  registerGameRoutes(app, {} as never);
  await app.ready();
  return app;
}

async function request(app: FastifyInstance, path: string, method: 'GET' | 'POST' = 'POST',
  ip = '203.0.113.10', headers: Record<string, string> = {}) {
  return app.inject({ method, url: path, headers: { 'x-forwarded-for': ip, ...headers } });
}

describe('raid and capability rate-limit isolation', () => {
  it('bounds discovery independently without starving base reads or a first battle finish', async () => {
    const app = await fixture();
    for (let i = 0; i < globalMax; i++) {
      expect((await request(app, `/native/capabilities?attempt=${i}`, 'GET')).statusCode).toBe(200);
    }
    const blocked = await request(app, '/native/capabilities?attempt=new', 'GET', undefined,
      { authorization: 'Bearer changed', 'x-client-platform': 'android' });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect((await request(app, '/base', 'GET')).statusCode).toBe(401);
    expect((await request(app, `/raids/${raidId}/finish`)).statusCode).toBe(401);
    // No caller-controlled query/header creates a new bucket. A different IP does.
    expect((await request(app, '/native/capabilities', 'GET', '203.0.113.11')).statusCode).toBe(200);
  });

  it('keeps general gameplay globally bounded without consuming the independent finish budget', async () => {
    const app = await fixture();
    for (const url of ['/base', '/raids/pending', '/bases']) {
      expect((await request(app, url, 'GET')).statusCode).toBe(401);
    }
    expect((await request(app, '/base', 'GET')).statusCode).toBe(429);
    for (let i = 0; i < RAID_REPLAY_LIMITS.submitRateLimitPerMin; i++) {
      expect((await request(app, `/raids/${raidId}/finish`)).statusCode).toBe(401);
    }
    const blocked = await request(app, '/raids/22222222-2222-4222-8222-222222222222/finish',
      'POST', undefined, { authorization: 'Bearer another-wallet' });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['x-ratelimit-limit'])).toBe(RAID_REPLAY_LIMITS.submitRateLimitPerMin);
    // Preserve the documented aggregate IP CPU ceiling, including behind NAT.
    expect((await request(app, `/raids/${raidId}/finish`, 'POST', '203.0.113.11')).statusCode).toBe(401);
  });

  it.each([
    ['orders', 'POST', RAID_REPLAY_LIMITS.submitRateLimitPerMin],
    ['commands', 'POST', LIVE_RAID.commandRateLimitPerMin],
    ['live', 'GET', LIVE_RAID.reconnectRateLimitPerMin],
    ['presentation', 'GET', LIVE_RAID.reconnectRateLimitPerMin],
  ] as const)('enforces the declared %s budget without leaking it into finish', async (suffix, method, max) => {
    const app = await fixture();
    for (let i = 0; i < max; i++) {
      expect((await request(app, `/raids/${raidId}/${suffix}`, method)).statusCode).toBe(401);
    }
    const blocked = await request(app, `/raids/${raidId}/${suffix}`, method);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['x-ratelimit-limit'])).toBe(max);
    expect((await request(app, `/raids/${raidId}/finish`)).statusCode).toBe(401);
  });

  it('preserves the combined start/speed shield on the actual routes', async () => {
    const app = await fixture();
    for (let i = 0; i < LIVE_RAID.controlRateLimitPerMin; i++) {
      expect((await request(app, `/raids/${raidId}/${i % 2 ? 'start' : 'speed'}`)).statusCode).toBe(401);
    }
    expect((await request(app, `/raids/${raidId}/start`)).statusCode).toBe(429);
    expect((await request(app, `/raids/${raidId}/speed`)).statusCode).toBe(429);
    expect((await request(app, `/raids/${raidId}/finish`)).statusCode).toBe(401);
  });

  it('does not weaken sensitive authentication limits when the general bucket is empty', async () => {
    const app = await fixture();
    for (let i = 0; i <= globalMax; i++) await request(app, '/base', 'GET');
    // Registration is the real sensitive route; auth terminates before custody work.
    const path = '/2fa/email/verify';
    for (let i = 0; i < TWOFA.verifyRateLimitPerMin; i++) {
      expect((await request(app, path)).statusCode).toBe(401);
    }
    expect((await request(app, path)).statusCode).toBe(429);
  });
});
