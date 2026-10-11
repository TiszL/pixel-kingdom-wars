import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SKR_FAUCET } from '@shardkeep/shared';
import type { makeSkrFaucetService } from '../src/devnet-only/skrFaucet';
import { registerSkrFaucetRoutes } from '../src/devnet-only/routes-skr-faucet';
import { HttpError } from '../src/lib/errors';

const open: Array<ReturnType<typeof Fastify>> = [];
afterEach(async () => { await Promise.all(open.splice(0).map((app) => app.close())); });
async function fixture(authenticated = true) {
  const app = Fastify(); open.push(app); await app.register(rateLimit, { global: false });
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async (request: { wallet: string }) => {
    if (!authenticated) throw new HttpError(401, 'authentication required', 'AUTH_REQUIRED'); request.wallet = 'authenticated-session-wallet';
  });
  app.setErrorHandler((error, _request, reply) => {
    const typed = error as HttpError; reply.code(typed.statusCode ?? 500).send({ error: typed.message, code: typed.code, ...typed.details });
  });
  const methods = { status: vi.fn(async () => ({ reason: 'ok' })), claim: vi.fn(async () => ({ grant: { id: 'reserved' } })),
    prepare: vi.fn(async () => ({ unsignedTransaction: 'unsigned' })), submit: vi.fn(async () => ({ grant: { id: 'submitted' } })), prime: vi.fn(async () => {}) };
  registerSkrFaucetRoutes(app, methods as unknown as ReturnType<typeof makeSkrFaucetService>);
  return { app, methods };
}
describe('SKR faucet authenticated request boundary', () => {
  it('takes the wallet exclusively from authentication for all four endpoints', async () => {
    const { app, methods } = await fixture(); const baseId = randomUUID(), grantId = randomUUID(), attemptId = randomUUID();
    expect((await app.inject(`/devnet-skr-faucet/status?baseId=${baseId}`)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/devnet-skr-faucet/claim', payload: { baseId } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/devnet-skr-faucet/prepare', payload: { grantId } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/devnet-skr-faucet/submit', payload: { attemptId, signedTransaction: 'AQ==' } })).statusCode).toBe(200);
    expect(methods.status).toHaveBeenCalledWith('authenticated-session-wallet', baseId);
    expect(methods.claim).toHaveBeenCalledWith('authenticated-session-wallet', baseId);
    expect(methods.prepare).toHaveBeenCalledWith('authenticated-session-wallet', grantId);
    expect(methods.submit).toHaveBeenCalledWith('authenticated-session-wallet', attemptId, 'AQ==');
  });
  it('refuses extra wallet/base/signature fields and extra mutation query parameters before service calls', async () => {
    const { app, methods } = await fixture();
    for (const [route, payload] of [
      ['claim', { baseId: randomUUID(), wallet: 'attacker' }], ['claim', { baseId: randomUUID(), deedAssetId: 'arbitrary' }],
      ['prepare', { grantId: randomUUID(), mint: 'arbitrary' }],
      ['submit', { attemptId: randomUUID(), signedTransaction: 'AQ==', wallet: 'attacker' }],
    ] as const) expect((await app.inject({ method: 'POST', url: `/devnet-skr-faucet/${route}`, payload })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/devnet-skr-faucet/claim?wallet=attacker', payload: { baseId: randomUUID() } })).statusCode).toBe(400);
    expect((await app.inject('/devnet-skr-faucet/status?wallet=attacker')).statusCode).toBe(400);
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
  });
  it('refuses unauthenticated requests before inspecting grants or preparing signatures', async () => {
    const { app, methods } = await fixture(false);
    for (const url of ['status', 'claim', 'prepare', 'submit']) {
      const response = await app.inject({ method: url === 'status' ? 'GET' : 'POST', url: `/devnet-skr-faucet/${url}`, ...(url === 'status' ? {} : { payload: {} }) });
      expect(response.statusCode).toBe(401);
    }
    for (const method of Object.values(methods)) expect(method).not.toHaveBeenCalled();
  });
  it('rejects oversized/non-base64 submitted wires before parsing cryptographic content', async () => {
    const { app, methods } = await fixture();
    for (const signedTransaction of ['', '%%%secret', 'A'.repeat(1645)]) {
      expect((await app.inject({ method: 'POST', url: '/devnet-skr-faucet/submit', payload: { attemptId: randomUUID(), signedTransaction } })).statusCode).toBe(400);
    }
    expect(methods.submit).not.toHaveBeenCalled();
  });
  it('preserves safe 429 details while hiding raw upstream errors', async () => {
    const { app, methods } = await fixture(); const payload = { baseId: randomUUID() };
    methods.claim.mockRejectedValueOnce(new HttpError(429, 'daily allocation already reserved', 'SKR_FAUCET_DAILY_LIMIT', { nextEligibleAt: '2026-10-03T00:00:00.000Z' }));
    const limited = await app.inject({ method: 'POST', url: '/devnet-skr-faucet/claim', payload });
    expect(limited.statusCode).toBe(429); expect(limited.json()).toMatchObject({ code: 'SKR_FAUCET_DAILY_LIMIT', nextEligibleAt: '2026-10-03T00:00:00.000Z' });
    methods.claim.mockRejectedValueOnce(new Error('https://rpc.invalid/?api-key=secret-private-wire'));
    const failed = await app.inject({ method: 'POST', url: '/devnet-skr-faucet/claim', payload });
    expect(failed.statusCode).toBe(503); expect(failed.body).not.toMatch(/rpc\.invalid|api-key|private-wire/);
  });
  it('enforces the configured per-minute mutation limit', async () => {
    const { app, methods } = await fixture();
    for (let index = 0; index < SKR_FAUCET.devnet.claimRateLimitPerMin; index++) {
      expect((await app.inject({ method: 'POST', url: '/devnet-skr-faucet/claim', payload: { baseId: randomUUID() } })).statusCode).toBe(200);
    }
    expect((await app.inject({ method: 'POST', url: '/devnet-skr-faucet/claim', payload: { baseId: randomUUID() } })).statusCode).toBe(429);
    expect(methods.claim).toHaveBeenCalledTimes(SKR_FAUCET.devnet.claimRateLimitPerMin);
  });
});
