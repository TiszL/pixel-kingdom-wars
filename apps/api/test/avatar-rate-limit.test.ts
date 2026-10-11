/** @fastify/rate-limit is disabled in the normal test app. This focused app
 * registers the real auth route table with the limiter enabled so hook order,
 * independent keys, and the shared production ceilings are all exercised. */
import rateLimit from '@fastify/rate-limit';
import { PROFILE_AVATAR } from '@shardkeep/shared';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AVATAR_READ_RATE_LIMITS, registerAuthRoutes } from '../src/auth/routes';
import { TEST_CONFIG } from './helpers';

let app: FastifyInstance;
let authenticateCalls = 0;
const avatarUrl = '/avatars/00000000-0000-0000-0000-000000000000.webp';

beforeAll(async () => {
  app = Fastify({ trustProxy: 1 });
  await app.register(rateLimit, { global: true, max: 100_000, timeWindow: 60_000 });
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async (
    req: FastifyRequest, reply: FastifyReply,
  ): Promise<void> => {
    authenticateCalls++;
    const wallet = req.headers['x-test-wallet'];
    if (typeof wallet !== 'string') {
      await reply.code(401).send({ error: { message: 'stub' } });
      return;
    }
    req.wallet = wallet;
  });
  registerAuthRoutes(app, { ...TEST_CONFIG, NODE_ENV: 'production' }, {} as never);
  await app.ready();
});

afterAll(async () => app.close());

async function fire(n: number, ip: string, wallet?: string): Promise<number[]> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) {
    const response = await app.inject({
      url: avatarUrl,
      headers: { 'x-forwarded-for': ip, ...(wallet ? { 'x-test-wallet': wallet } : {}) },
    });
    statuses.push(response.statusCode);
  }
  return statuses;
}

describe('opaque avatar proxy dual admission', () => {
  it('declares independent fail-closed pre-auth IP and post-auth wallet budgets', () => {
    expect(AVATAR_READ_RATE_LIMITS.ip).toMatchObject({
      max: PROFILE_AVATAR.readIpAbuseLimitPerMin, hook: 'onRequest', skipOnError: false,
    });
    expect(AVATAR_READ_RATE_LIMITS.wallet).toMatchObject({
      max: PROFILE_AVATAR.readWalletLimitPerMin, skipOnError: false,
    });
    expect(AVATAR_READ_RATE_LIMITS.ip.keyGenerator({ ip: '203.0.113.1' } as never))
      .toBe('avatar-read-ip:203.0.113.1');
    expect(AVATAR_READ_RATE_LIMITS.wallet.keyGenerator({ wallet: 'keeper-a' } as never))
      .toBe('avatar-read-wallet:keeper-a');
  });

  it('does not make two authenticated wallets behind one carrier IP share the honest ceiling', async () => {
    const ip = '198.51.100.20';
    const a = await fire(PROFILE_AVATAR.readWalletLimitPerMin + 1, ip, 'keeper-a');
    expect(a.slice(0, -1).every((status) => status !== 429)).toBe(true);
    expect(a.at(-1)).toBe(429);
    const b = await fire(PROFILE_AVATAR.readWalletLimitPerMin, ip, 'keeper-b');
    expect(b.every((status) => status !== 429)).toBe(true);
  });

  it('bounds unauthenticated abuse by IP before authentication runs', async () => {
    const before = authenticateCalls;
    const statuses = await fire(PROFILE_AVATAR.readIpAbuseLimitPerMin + 1, '198.51.100.21');
    expect(statuses.slice(0, -1).every((status) => status === 401)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
    expect(authenticateCalls - before).toBe(PROFILE_AVATAR.readIpAbuseLimitPerMin);
  });
});
