/** Route authorization and privacy are independent of campaign calculation. */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import type { Config } from '../src/config';
import { HttpError } from '../src/lib/errors';
import { registerPlaytestCampaignRoutes } from '../src/routes-playtest-campaigns';
import { administerCampaign, campaignState, adminCampaignState, exportCampaign, finalizePlaytestCampaign } from '../src/game/playtestCampaigns';

vi.mock('../src/game/playtestCampaigns', () => ({
  ensurePlaytestCampaigns: vi.fn(async () => undefined),
  campaignState: vi.fn(async () => ({ phase: 'draft' })),
  adminCampaignState: vi.fn(async () => ({ phase: 'draft', submissions: [] })),
  exportCampaign: vi.fn(async () => ({ audit: [] })),
  administerCampaign: vi.fn(async () => ({ revision: 2 })),
  finalizePlaytestCampaign: vi.fn(async () => ({ revision: 2 })),
  participateInCampaign: vi.fn(async () => ({ joinedAt: '2040-01-01T00:00:00Z' })),
  submitCampaignEntry: vi.fn(async () => ({ id: 'entry' })),
}));
let app: FastifyInstance;
const admin = 'AdminWallet';
const wallet = 'PlayerWallet';
beforeEach(async () => {
  vi.clearAllMocks();
  app = Fastify();
  app.decorate('authenticate', async (req: FastifyRequest) => {
    const actor = req.headers['x-test-wallet'];
    if (typeof actor !== 'string') throw new HttpError(401, 'sign in');
    req.wallet = actor;
  });
  registerPlaytestCampaignRoutes(app, { ADMIN_WALLETS: [admin], ALPHA_WALLETS: ['InternalWallet'] } as Config, {} as Db);
  await app.ready();
});
afterEach(async () => { await app.close(); });
const root = '/admin/playtest/campaigns/rewarded-playtest';

it('serves crawler reads publicly but keeps own and every admin route authenticated', async () => {
  expect((await app.inject('/playtest/campaigns')).statusCode).toBe(200);
  expect((await app.inject('/playtest/campaigns/rewarded-playtest/me')).statusCode).toBe(401);
  for (const url of ['/admin/playtest/campaigns', `${root}/export`]) {
    expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { 'x-test-wallet': wallet } })).statusCode).toBe(403);
  }
  for (const action of ['schedule', 'cancel', 'disqualify', 'award', 'payment', 'finalize']) {
    const res = await app.inject({ method: 'POST', url: `${root}/${action}`, headers: { 'x-test-wallet': wallet }, payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.headers['cache-control']).toBe('private, no-store');
  }
  expect(vi.mocked(administerCampaign)).not.toHaveBeenCalled();
  expect(vi.mocked(finalizePlaytestCampaign)).not.toHaveBeenCalled();
});

it('binds the decision actor to authentication and rejects body-supplied roles or enrollment', async () => {
  const payload = { requestId: 'decision-1', revision: 1, startAt: '2040-01-01T00:00:00Z', registrationOpen: true };
  const valid = await app.inject({ method: 'POST', url: `${root}/schedule`, headers: { 'x-test-wallet': admin }, payload });
  expect(valid.statusCode).toBe(200);
  expect(vi.mocked(administerCampaign).mock.calls[0]?.[2]).toBe(admin);
  const extra = await app.inject({ method: 'POST', url: `${root}/schedule`, headers: { 'x-test-wallet': admin }, payload: { ...payload, actor: wallet } });
  expect(extra.statusCode).toBe(400);
  expect((await app.inject({ method: 'POST', url: `${root}/participate`, headers: { 'x-test-wallet': admin }, payload: { wallet } })).statusCode).toBe(404);
});

it('keeps admin/export and own responses private and passes internal exclusions to public readers', async () => {
  for (const url of ['/admin/playtest/campaigns', `${root}/export`, '/playtest/campaigns/rewarded-playtest/me']) {
    const res = await app.inject({ url, headers: { 'x-test-wallet': admin } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['vary']).toBe('Cookie, Authorization');
  }
  expect(vi.mocked(adminCampaignState)).toHaveBeenCalled();
  expect(vi.mocked(exportCampaign)).toHaveBeenCalled();
  await app.inject('/playtest/campaigns');
  expect(vi.mocked(campaignState).mock.calls.at(-1)?.[5]).toEqual(['InternalWallet', admin]);
});
