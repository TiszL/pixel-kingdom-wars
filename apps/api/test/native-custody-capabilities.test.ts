/**
 * MS-E capability successor, review 4ee018e4 item 4 (2026-10-02).
 * Frozen tests-first successor; execution remains the content pipeline-owned. No local runtime evidence.
 * Baseline read: eaf093df3c4d9db6e5b46a7172100a01ec6c902e.
 *
 * Exercise the actual public GET /native/capabilities registered by registerNativeRoutes.
 * The real readCustodyTransparency consumes a bounded fake execute result; no phase reader,
 * source projection, config flag helper, native route or response schema is mocked.
 * Only the startup-verified reserve lookup is stubbed. Its cryptographic admission remains
 * the responsibility of existing reserve-identity tests, not this route projection fixture.
 * No helpers.ts, DB connection, session, chain RPC, worker simulation or mutation is needed.
 * The repository's normal Vitest global setup may still allocate a DB: the content pipeline owns all runs.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { FORGE_INGOT, GEMS, LIVE_RAID, RAID_REPLAY_LIMITS } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Db } from '../src/db/client';
import { HttpError } from '../src/lib/errors';
import * as economyIdentity from '../src/money/economyIdentity';
import { NATIVE_MAX_WAIT_MS, NATIVE_PAGE_AGE_MS, NATIVE_PAGE_BYTES,
  NativeCapabilitiesSchema } from '../src/native/contracts';
import { registerNativeRoutes } from '../src/native/routes';

/** Byte-for-byte schema copy from native-update-code25.test.ts at the baseline above.
 * This is the installed decoder contract, not the evolving production schema. */
const CODE25_CAPABILITIES = z.object({
  protocolVersion: z.literal(1),
  sourceCommit: z.string(),
  simVersion: z.number().int().positive(),
  minimumVersionCode: z.number().int().nonnegative(),
  contentManifestUrl: z.url().nullable(),
  presentation: z.object({
    enabled: z.boolean(),
    protocolVersions: z.array(z.union([z.literal(1), z.literal(2)])),
    raidProtocolVersions: z.array(z.literal(2)),
    supportsStablePrefix: z.boolean(),
    maxWaitMs: z.literal(NATIVE_MAX_WAIT_MS),
    maxPageBytes: z.literal(NATIVE_PAGE_BYTES),
    maxEvents: z.literal(RAID_REPLAY_LIMITS.maxEvents),
    maxCommands: z.literal(LIVE_RAID.maxCommands),
    maxPageAgeMs: z.literal(NATIVE_PAGE_AGE_MS),
  }),
  notifications: z.object({ enabled: z.literal(false) }),
  economy: z.object({
    gameCurrency: z.object({ version: z.literal(1), exactSpendCurrency: z.literal(1) }),
    workshop: z.object({ enabled: z.boolean(), recipeVersion: z.literal(FORGE_INGOT.recipeVersion) }),
    gems: z.object({
      exactConsent: z.literal(1).optional(),
      enabled: z.boolean(),
      sources: z.array(z.enum(['ledger-keep', 'wallet-keep', 'store'])),
      destinationAta: z.string().nullable(),
      gemsPerKeep: z.literal(GEMS.gemsPerKeep),
      shardsPerGem: z.literal(GEMS.shardsPerGem),
      minConvertKeep: z.literal(GEMS.minConvertKeep),
      maxConvertKeepPerTx: z.literal(GEMS.maxConvertKeepPerTx),
    }),
  }),
});

type Capabilities = z.infer<typeof NativeCapabilitiesSchema>;
const changedAt = new Date('2026-10-02T00:00:00.000Z');
const row = (phase: string) => ({ phase, changedAt, scope: null });
// Opaque, already-admitted destination fixture; no transfer or account verification occurs here.
const reserveAta = '11111111111111111111111111111111';
const modernManifest = 'https://content.example.test/modern.json';
const legacyManifest = 'https://content.example.test/code25.json';
const apps: FastifyInstance[] = [];

beforeEach(() => {
  vi.stubEnv('GEMS_ENABLED', 'true');
  vi.stubEnv('GEMS_WALLET_BUY_ENABLED', 'false');
  vi.stubEnv('FORGE_INGOTS_ENABLED', 'false');
});
afterEach(async () => {
  try {
    for (const app of apps.splice(0)) await app.close();
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

async function fixture(rows: unknown[] | Error, reserve: string | null = null,
  worldV2: 'true' | 'false' = 'true') {
  const execute = vi.fn(async () => {
    if (rows instanceof Error) throw rows;
    return rows;
  });
  const db = { execute } as unknown as Db;
  vi.spyOn(economyIdentity, 'gemsReserveAta').mockImplementation((requestedDb) => {
    expect(requestedDb).toBe(db);
    return reserve;
  });
  const app = Fastify(); apps.push(app);
  const authenticate = vi.fn(async () => { throw new HttpError(401, 'no fixture session'); });
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', authenticate);
  registerNativeRoutes(app, {
    NATIVE_PRESENTATION_ENABLED: 'false', NATIVE_PRESENTATION_OPEN: 'false',
    NATIVE_UPDATE_CHANNEL_ENABLED: 'false', NATIVE_WORLD_V2_ENABLED: worldV2,
    NATIVE_MIN_VERSION_CODE: 25,
    NATIVE_CONTENT_MANIFEST_URL: modernManifest, NATIVE_CONTENT_MANIFEST_URL_LEGACY: legacyManifest,
  }, db);
  await app.ready();
  return { app, execute, authenticate };
}

async function capabilities(app: FastifyInstance): Promise<Capabilities> {
  // No cookie or modern-renderer header: the existing optional code-25 request stays public.
  const response = await app.inject({ method: 'GET', url: '/native/capabilities' });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return response.json<Capabilities>();
}

describe('native Gems capability follows the real custody reader', () => {
  it('GUARD: open custody preserves the existing ledger-only capability and rates', async () => {
    const f = await fixture([row('open')]);
    const body = await capabilities(f.app);
    expect(body.economy.gems).toEqual({
      enabled: true, exactConsent: 1, sources: ['ledger-keep'], destinationAta: null,
      gemsPerKeep: GEMS.gemsPerKeep, shardsPerGem: GEMS.shardsPerGem,
      minConvertKeep: GEMS.minConvertKeep, maxConvertKeepPerTx: GEMS.maxConvertKeepPerTx,
    });
    expect(f.authenticate).not.toHaveBeenCalled();
  });

  it.each(['fenced', 'withdrawals_closed', 'frozen', 'retired'])(
    '%s removes the ledger source without disabling Gems or changing the installed decoder contract', async phase => {
      const f = await fixture([row(phase)]);
      const body = await capabilities(f.app);
      expect(body.economy.gems.sources).toEqual([]);
      expect(body.economy.gems).toMatchObject({ enabled: true, exactConsent: 1, destinationAta: null });
      expect(f.execute).toHaveBeenCalledTimes(1);
      const { worldV2: _worldV2, ...existingFields } = body;
      expect(CODE25_CAPABILITIES.parse(body)).toEqual(existingFields);
    });

  it.each([
    ['missing latch', []],
    ['ambiguous latch', [row('open'), row('open')]],
    ['unknown phase', [row('future_phase')]],
    ['unreadable timestamp', [{ ...row('open'), changedAt: 'invalid-time' }]],
  ] as const)('%s fails closed through the real reader instead of advertising an older open server', async (_name, rows) => {
    const f = await fixture([...rows]);
    expect((await capabilities(f.app)).economy.gems.sources).toEqual([]);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])('custody read failure stays HTTP 200 and retains only an independently enabled wallet source (%s)',
    async walletBuy => {
      vi.stubEnv('GEMS_WALLET_BUY_ENABLED', walletBuy ? 'true' : 'false');
      const f = await fixture(new Error('fixture custody read denied'), reserveAta);
      const body = await capabilities(f.app);
      expect(body.economy.gems.sources).toEqual(walletBuy ? ['wallet-keep'] : []);
      expect(body.economy.gems.destinationAta).toBe(walletBuy ? reserveAta : null);
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(body)).not.toContain('fixture custody read denied');
    });

  it.each(['open', 'fenced', 'withdrawals_closed', 'frozen', 'retired', 'unknown'])(
    '%s never invents or removes the independent flag-plus-verified-reserve wallet rail', async phase => {
      for (const enabled of [false, true]) for (const verified of [false, true]) {
        vi.stubEnv('GEMS_WALLET_BUY_ENABLED', enabled ? 'true' : 'false');
        const f = await fixture([row(phase)], verified ? reserveAta : null);
        const body = await capabilities(f.app);
        const walletAvailable = enabled && verified;
        expect(body.economy.gems.sources).toEqual([
          ...(phase === 'open' ? ['ledger-keep'] : []),
          ...(walletAvailable ? ['wallet-keep'] : []),
        ]);
        expect(body.economy.gems.destinationAta).toBe(walletAvailable ? reserveAta : null);
      }
    });

  it('custody projection changes only the source list in the existing code-25 response', async () => {
    const open = await fixture([row('open')]);
    const before = await capabilities(open.app);
    const closed = await fixture([row('fenced')]);
    const after = await capabilities(closed.app);
    expect(after).toEqual({ ...before, economy: { ...before.economy,
      gems: { ...before.economy.gems, sources: [] } } });
    expect(CODE25_CAPABILITIES.parse(after)).toEqual({ ...CODE25_CAPABILITIES.parse(before),
      economy: { ...before.economy, gems: { ...before.economy.gems, sources: [] } } });
  });

  it('GUARD: Gems OFF performs no custody DB or session read, and worldV2 remains additive for code 25', async () => {
    vi.stubEnv('GEMS_ENABLED', 'false');
    // Even a stray child flag and admitted reserve cannot advertise a source while its parent is OFF.
    vi.stubEnv('GEMS_WALLET_BUY_ENABLED', 'true');
    const responses: Capabilities[] = [];
    for (const worldV2 of ['true', 'false'] as const) {
      const f = await fixture(new Error('Gems OFF must not touch the DB'), reserveAta, worldV2);
      const body = await capabilities(f.app); responses.push(body);
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.authenticate).not.toHaveBeenCalled();
      expect(body.economy.gems).toEqual({ enabled: false, sources: [], destinationAta: null,
        gemsPerKeep: GEMS.gemsPerKeep, shardsPerGem: GEMS.shardsPerGem,
        minConvertKeep: GEMS.minConvertKeep, maxConvertKeepPerTx: GEMS.maxConvertKeepPerTx });
      expect(body.worldV2).toEqual({ enabled: worldV2 === 'true' });
      expect(body.contentManifestUrl).toBe(legacyManifest);
      expect(body.minimumVersionCode).toBe(25);
      expect(body.simVersion).toBe(SIM_VERSION);
      expect(body).not.toHaveProperty('update');
      const { worldV2: _worldV2, ...existingFields } = body;
      expect(CODE25_CAPABILITIES.parse(body)).toEqual(existingFields);
    }
    expect(CODE25_CAPABILITIES.parse(responses[0])).toEqual(CODE25_CAPABILITIES.parse(responses[1]));
  });
});
