/** Production-like chat read limiter layering. buildApp skips Redis admission in
 * NODE_ENV=test, so this small app exercises the exact exported route configs. */
import rateLimit from '@fastify/rate-limit';
import { CHAT } from '@shardkeep/shared';
import Fastify, { type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { CHAT_READ_IP_RATE_LIMIT, CHAT_READ_RATE_LIMIT } from '../src/chat/routes';

async function limitedApp(ipMax: number, walletMax: number) {
  const app = Fastify({ trustProxy: 1 });
  await app.register(rateLimit, { global: false, max: 10_000, timeWindow: 60_000 });
  app.decorateRequest('wallet', '');
  let authCalls = 0;
  const walletLimiter = app.createRateLimit({ ...CHAT_READ_RATE_LIMIT, max: walletMax });
  const authenticate = async (req: FastifyRequest) => {
    authCalls++;
    const wallet = req.headers['x-wallet'];
    if (typeof wallet !== 'string' || wallet === '') throw new Error('AUTH');
    req.wallet = wallet;
  };
  const enforceWallet = async (req: FastifyRequest) => {
    const limit = await walletLimiter(req);
    if (!limit.isAllowed && limit.isExceeded) throw new Error('WALLET_LIMIT');
  };
  app.get('/chat', {
    preHandler: [authenticate, enforceWallet],
    config: { rateLimit: { ...CHAT_READ_IP_RATE_LIMIT, max: ipMax } },
  }, async () => ({ ok: true }));
  app.setErrorHandler((err: unknown, _req, reply) => {
    const failure = err as { message?: string; statusCode?: number };
    return reply.code(
      failure.message === 'WALLET_LIMIT' ? 429 : (failure.statusCode ?? 401),
    ).send();
  });
  await app.ready();
  return { app, authCalls: () => authCalls };
}

describe('global chat read limiter layering', () => {
  it('declares finite fail-closed IP admission and independent wallet fairness', () => {
    expect(CHAT_READ_IP_RATE_LIMIT).toMatchObject({
      max: CHAT.readsPerIpMinute, hook: 'onRequest', skipOnError: false,
    });
    expect(CHAT_READ_IP_RATE_LIMIT.keyGenerator({ ip: '203.0.113.1' } as never))
      .toBe('chat-read-ip:203.0.113.1');
    expect(CHAT_READ_RATE_LIMIT).toMatchObject({
      max: CHAT.readsPerWalletMinute, skipOnError: false,
    });
    expect(CHAT_READ_RATE_LIMIT.keyGenerator({ wallet: 'viewer' } as never))
      .toBe('chat-read-wallet:viewer');
    expect(CHAT.readsPerIpMinute).toBeGreaterThan(CHAT.readsPerWalletMinute * 10);
  });

  it('bounds unauthenticated traffic before authentication/DB work', async () => {
    const { app, authCalls } = await limitedApp(2, 100);
    const options = { method: 'GET' as const, url: '/chat', headers: { 'x-forwarded-for': '203.0.113.10' } };
    expect((await app.inject(options)).statusCode).toBe(401);
    expect((await app.inject(options)).statusCode).toBe(401);
    expect((await app.inject(options)).statusCode).toBe(429);
    expect(authCalls()).toBe(2);
    await app.close();
  });

  it('does not make honest wallets behind one NAT share the wallet bucket', async () => {
    const { app } = await limitedApp(20, 2);
    const ip = '203.0.113.11';
    for (const wallet of ['wallet-a', 'wallet-b', 'wallet-c']) {
      for (let i = 0; i < 2; i++) {
        expect((await app.inject({ method: 'GET', url: '/chat', headers: {
          'x-forwarded-for': ip, 'x-wallet': wallet,
        } })).statusCode).toBe(200);
      }
    }
    expect((await app.inject({ method: 'GET', url: '/chat', headers: {
      'x-forwarded-for': ip, 'x-wallet': 'wallet-a',
    } })).statusCode).toBe(429);
    expect((await app.inject({ method: 'GET', url: '/chat', headers: {
      'x-forwarded-for': ip, 'x-wallet': 'wallet-d',
    } })).statusCode).toBe(200);
    await app.close();
  });
});
