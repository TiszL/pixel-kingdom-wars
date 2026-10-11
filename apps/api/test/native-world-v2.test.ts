/**
 * The native new-world kill switch — D-NEXT (new world bundled in the APK with a
 * kill switch; code 25 never locked out).
 *
 * WHY: the Android client bundles the new GL30 world (globe + realm maps) and runs it
 * unless capabilities says `worldV2.enabled === false`. If that world breaks on
 * players' devices the owner must be able to turn it off for EVERY native client
 * without a release, a store review or a maintenance window: set
 * NATIVE_WORLD_V2_ENABLED=false and recreate the api container. That only works if
 * every capabilities response carries the answer, so the key is always sent.
 *
 * Installed code 25 (0.5.8 on real Seekers) decodes capabilities with
 * ignoreUnknownKeys and must never notice the switch: every field it reads must be
 * identical with the switch on and off. The schema below is the frozen code-25 copy
 * from native-update-code25.test.ts (release checkout 2caf7c65, before M45); it must
 * never be edited, nor replaced by the live schema, to make a failure pass.
 */
import { readFile } from 'node:fs/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { FORGE_INGOT, GEMS, LIVE_RAID, RAID_REPLAY_LIMITS } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { HttpError } from '../src/lib/errors';
import { NATIVE_MAX_WAIT_MS, NATIVE_PAGE_AGE_MS, NATIVE_PAGE_BYTES } from '../src/native/contracts';
import { registerNativeRoutes } from '../src/native/routes';
import { connectTestDb, TEST_CONFIG } from './helpers';

/** Frozen copy of NativeCapabilitiesSchema as served to code 25 (release checkout
 * 2caf7c65, before M45). Non-strict: unknown keys strip, like ignoreUnknownKeys. */
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

const conn = connectTestDb();
const db = conn.db;
const apps: FastifyInstance[] = [];
let on: FastifyInstance; let off: FastifyInstance;
const capabilities = async (app: FastifyInstance) => {
  const reply = await app.inject({ method: 'GET', url: '/native/capabilities' });
  expect(reply.statusCode, reply.body).toBe(200);
  return reply.json() as Record<string, unknown>;
};

beforeAll(async () => {
  on = await buildApp(TEST_CONFIG, db); apps.push(on);
  off = await buildApp({ ...TEST_CONFIG, NATIVE_WORLD_V2_ENABLED: 'false' }, db); apps.push(off);
  await on.ready(); await off.ready();
});
afterAll(async () => {
  for (const app of apps) await app.close();
  await conn.sql.end();
});

describe('capabilities always carries worldV2', () => {
  // Default ON: shipping the APK is the owner's choice to run the new world.
  it('default config advertises { enabled: true }', async () => {
    const body = await capabilities(on);
    expect(Object.hasOwn(body, 'worldV2')).toBe(true);
    expect(body['worldV2']).toEqual({ enabled: true });
  });

  // The incident lever: an explicit false is the only thing that turns the world off.
  it("NATIVE_WORLD_V2_ENABLED='false' advertises { enabled: false }, key still present", async () => {
    const body = await capabilities(off);
    expect(Object.hasOwn(body, 'worldV2')).toBe(true);
    expect(body['worldV2']).toEqual({ enabled: false });
  });

  // Route fixtures and the D-113 companion config omit the key; omission must read ON,
  // never "off by accident", and needs no session (authenticate here always refuses).
  it('a config that omits the key reads ON without a session', async () => {
    const app = Fastify(); apps.push(app);
    app.decorateRequest('wallet', '');
    app.decorate('authenticate', async () => { throw new HttpError(401, 'no session'); });
    const { NATIVE_WORLD_V2_ENABLED: _omitted, ...config } = TEST_CONFIG;
    registerNativeRoutes(app, config, db);
    await app.ready();
    expect((await capabilities(app))['worldV2']).toEqual({ enabled: true });
  });
});

describe('code 25 never notices the switch', () => {
  it('the code-25 view is deep-equal with the switch on and off', async () => {
    const [bodyOn, bodyOff] = [await capabilities(on), await capabilities(off)];
    const [viewOn, viewOff] = [CODE25_CAPABILITIES.parse(bodyOn), CODE25_CAPABILITIES.parse(bodyOff)];
    expect(viewOn).toEqual(viewOff);
    expect(Object.hasOwn(viewOn, 'worldV2')).toBe(false);
  });

  it('worldV2 is purely additive: the rest of the response is identical on and off', async () => {
    const { worldV2: _on, ...restOn } = await capabilities(on);
    const { worldV2: _off, ...restOff } = await capabilities(off);
    expect(restOn).toEqual(restOff);
  });
});

// A typo in the production env must refuse boot, never silently pick a world.
describe('config', () => {
  const env = {
    DATABASE_URL: 'postgres://x:y@localhost:5433/example',
    JWT_SECRET: 'test-secret-test-secret-test-secret!',
    WEB_ORIGIN: 'http://localhost:5173',
    NODE_ENV: 'test',
  };

  it("defaults to 'true' when unset", () => {
    expect(loadConfig(env).NATIVE_WORLD_V2_ENABLED).toBe('true');
  });

  it('accepts exactly the two literals', () => {
    expect(loadConfig({ ...env, NATIVE_WORLD_V2_ENABLED: 'false' }).NATIVE_WORLD_V2_ENABLED).toBe('false');
    expect(loadConfig({ ...env, NATIVE_WORLD_V2_ENABLED: 'true' }).NATIVE_WORLD_V2_ENABLED).toBe('true');
  });

  it('refuses any other value at boot', () => {
    for (const bad of ['yes', 'no', 'FALSE', 'True', '0', 'off']) {
      expect(() => loadConfig({ ...env, NATIVE_WORLD_V2_ENABLED: bad }), bad).toThrow(/NATIVE_WORLD_V2_ENABLED/);
    }
  });
});

// Copying either example must keep the new world ON and name the lever an operator pulls.
describe('operator examples', () => {
  it.each(['.env.example', 'infra/.env.prod.example'])('%s ships NATIVE_WORLD_V2_ENABLED=true', async (file) => {
    const example = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect([...example.matchAll(/^NATIVE_WORLD_V2_ENABLED=(.*)$/gm)].map((match) => match[1])).toEqual(['true']);
  });
});
