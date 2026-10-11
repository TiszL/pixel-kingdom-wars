import Fastify from 'fastify';
import { PLAYTEST_COMPETITIONS } from '@shardkeep/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../src/config';
import type { Db } from '../src/db/client';
import { refreshPublicPlaytestStats } from '../src/jobs';
import { registerAlphaRoutes } from '../src/routes-alpha';

const mocks = vi.hoisted(() => ({
  ensure: vi.fn(), founders: vi.fn(), campaign: vi.fn(), stats: vi.fn(), relay: vi.fn(), alpha: vi.fn(),
}));
vi.mock('../src/game/playtestCampaigns', async importOriginal => ({
  ...await importOriginal<typeof import('../src/game/playtestCampaigns')>(),
  ensurePlaytestCampaigns: mocks.ensure, snapshotPlaytestFounders: mocks.founders, refreshPlaytestCampaign: mocks.campaign,
}));
vi.mock('../src/game/playtestStats', async importOriginal => ({
  ...await importOriginal<typeof import('../src/game/playtestStats')>(), writePlaytestStatsSnapshot: mocks.stats,
}));
vi.mock('../src/telemetry', async importOriginal => ({
  ...await importOriginal<typeof import('../src/telemetry')>(), relayServerError: mocks.relay,
}));
vi.mock('../src/game/alpha', async importOriginal => ({
  ...await importOriginal<typeof import('../src/game/alpha')>(), alphaStats: mocks.alpha,
}));
const db = {} as Db;
const baseConfig = { WEB_ORIGIN: ['https://play.example.test'], ADMIN_WALLETS: ['admin'] } as Config;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ensure.mockResolvedValue(undefined);
  mocks.founders.mockResolvedValue(undefined);
  mocks.campaign.mockResolvedValue(undefined);
  mocks.stats.mockResolvedValue({computedAt:'2026-09-08T00:00:00.000Z',cohorts:{total:{players:37}}});
  mocks.alpha.mockResolvedValue({pending:0,approved:0,rejected:0});
});

describe('public statistics failure isolation', () => {
  it('publishes genuine activity after failed founder proof and one failed campaign, while the other campaign refreshes', async () => {
    const log = vi.spyOn(console,'error').mockImplementation(() => undefined);
    try {
      mocks.founders.mockRejectedValueOnce(new Error('mint proof incomplete'));
      mocks.campaign.mockImplementation(async (_db,id) => {
        if (id === PLAYTEST_COMPETITIONS.foundingId) throw new Error('founding refresh unavailable');
      });
      await expect(refreshPublicPlaytestStats(db,baseConfig)).resolves.toEqual({computedAt:'2026-09-08T00:00:00.000Z',players:37});
      expect(mocks.campaign.mock.calls.map(call=>call[1])).toEqual([PLAYTEST_COMPETITIONS.foundingId,PLAYTEST_COMPETITIONS.rewardedId]);
      expect(mocks.stats).toHaveBeenCalledOnce();
      expect(log).toHaveBeenCalledTimes(2);
      expect(mocks.relay).toHaveBeenCalledTimes(2);
    } finally { log.mockRestore(); }
  });

  it('does not let a failed campaign bootstrap prevent the independent public snapshot', async () => {
    const log=vi.spyOn(console,'error').mockImplementation(() => undefined);
    try {
      mocks.ensure.mockRejectedValueOnce(new Error('campaign bootstrap unavailable'));
      await refreshPublicPlaytestStats(db,baseConfig);
      expect(mocks.stats).toHaveBeenCalledOnce();
      expect(mocks.relay).toHaveBeenCalledWith(expect.any(Error),expect.objectContaining({route:'job:playtest-stats:campaign-definitions'}));
    } finally { log.mockRestore(); }
  });

  it('fails the job when the actual statistics snapshot cannot publish', async () => {
    mocks.stats.mockRejectedValueOnce(new Error('snapshot write failed'));
    await expect(refreshPublicPlaytestStats(db,baseConfig)).rejects.toThrow('snapshot write failed');
  });
});

describe('effective open-admission status', () => {
  it.each([
    {flag:undefined,listed:false,open:true},
    {flag:'false',listed:false,open:true},
    {flag:undefined,listed:true,open:false},
    {flag:'false',listed:true,open:false},
    {flag:'true',listed:true,open:true},
  ] as const)('matches public and admin status for $flag with list=$listed', async ({flag,listed,open}) => {
    const app=Fastify();
    // Authentication itself has DB-backed coverage; here the fake authenticated
    // admin isolates the status DTO and must never query a database.
    app.decorate('authenticate',async (request) => { request.wallet='admin'; });
    const config={...baseConfig,...(flag ? {PLAYTEST_OPEN:flag}:{}),...(listed ? {ALPHA_WALLETS:['internal']}: {})};
    registerAlphaRoutes(app,config,db);
    try {
      const publicStatus=await app.inject({url:'/playtest/access'});
      const adminStatus=await app.inject({url:'/admin/alpha/stats'});
      expect(publicStatus.statusCode).toBe(200);
      expect(adminStatus.statusCode).toBe(200);
      expect(publicStatus.json().open).toBe(open);
      expect(adminStatus.json().accessOpen).toBe(open);
    } finally { await app.close(); }
  });
});
