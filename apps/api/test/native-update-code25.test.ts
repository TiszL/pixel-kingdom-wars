/**
 * Installed code 25 vs the M45 update channel (the one rule of M45: a code 25
 * player signs in, loads their base and fights at every minute of this release).
 * Since G6 Path A (owner D1, 2026-10-10; pins at the end of this file) code 25
 * and every build up to 32 stop fighting on the SIM-18 server and must update to
 * code 33; they must still sign in, load their base and read a clean
 * "update required", which needs this same decodable body.
 *
 * WHY: code 25 is on real Seekers and decodes capabilities with
 * ignoreUnknownKeys. The `update` key is therefore safe ONLY if it is purely
 * additive: every field code 25 already reads must be byte-for-byte identical
 * with the channel on, and the key must be absent (not null) when dark. The
 * schema below is frozen from the 0.5.8 (code 25) server and must never be
 * edited to make a failure pass.
 */
import { readFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { FORGE_INGOT, GEMS, LIVE_RAID, RAID_REPLAY_LIMITS } from '@shardkeep/shared';
import { SIM_VERSION } from '@shardkeep/sim';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app';
import { NATIVE_MAX_WAIT_MS, NATIVE_PAGE_AGE_MS, NATIVE_PAGE_BYTES } from '../src/native/contracts';
import { publishNativeUpdate } from '../src/native/updateChannel';
import { manifest, resetNativeUpdateChannel } from './fixtures/nativeUpdateChannel';
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
let on: FastifyInstance; let off: FastifyInstance; let pathA: FastifyInstance;
const capabilities = async (app: FastifyInstance) => {
  const reply = await app.inject({ method: 'GET', url: '/native/capabilities' });
  expect(reply.statusCode, reply.body).toBe(200);
  return reply.json() as Record<string, unknown>;
};

beforeAll(async () => {
  const config = { ...TEST_CONFIG, PLAY_URL: 'https://play.example.com' };
  on = await buildApp({ ...config, NATIVE_UPDATE_CHANNEL_ENABLED: 'true' }, db);
  off = await buildApp(config, db);
  // G6 Path A production config: the channel on and the floor at the first SIM-18 build.
  pathA = await buildApp({ ...config, NATIVE_UPDATE_CHANNEL_ENABLED: 'true', NATIVE_MIN_VERSION_CODE: 33 }, db);
  await on.ready(); await off.ready(); await pathA.ready();
});
beforeEach(async () => {
  await resetNativeUpdateChannel(db);
  await publishNativeUpdate(db, manifest(26, { channel: 'stable' }), { config: { PLAY_URL: 'https://play.example.com' }, originCheck: false });
});
afterAll(async () => {
  await resetNativeUpdateChannel(db);
  await on?.close(); await off?.close(); await pathA?.close(); await conn.sql.end();
});

describe('code 25 capabilities tolerance', () => {
  it('code 25 still decodes the flag-on response that carries update', async () => {
    const body = await capabilities(on);
    expect(body['update']).toMatchObject({ latestVersionCode: 26 });
    const decoded = CODE25_CAPABILITIES.parse(body);
    expect(Object.hasOwn(decoded, 'update')).toBe(false);
  });

  it('update is purely additive: flag-on minus update equals flag-off', async () => {
    const { update: _update, ...rest } = await capabilities(on);
    expect(rest).toEqual(await capabilities(off));
  });

  it('flag off never emits the key, not even as null', async () => {
    const body = await capabilities(off);
    expect(Object.hasOwn(body, 'update')).toBe(false);
    // D-NEXT: the always-sent worldV2 kill switch is the one other key code 25 strips
    // (native-world-v2.test.ts proves it additive); nothing else may be unknown to it.
    const { worldV2: _worldV2, ...rest } = body;
    expect(CODE25_CAPABILITIES.parse(body)).toEqual(rest);
  });
});

/**
 * Rewritten 2026-10-10 for G6 Path A (owner decision D1; docs/DECISIONS.md, docs/deploy/G6-PATH-A.md).
 *
 * WHY: every native build fights only on the SIM it compiles. It compares capabilities.simVersion
 * (and each raid's simVersion) with STRICT equality against the SIM of its bundled catalogue
 * (code 25: native c5651ea BattleCoordinator.kt:196, :233; BattlePresentation.kt:150), and its
 * content channel refuses any pack on another SIM. Capabilities advertise one BUILD.simVersion, so
 * a "backend accepting both SIMs" keeps no older build fighting. Codes 25-32 compile SIM 17; code 33
 * is the first SIM-18 build.
 *
 * The earlier pin held SIM 17 "ONLY until the dApp Store has published the next build AND the owner
 * has raised NATIVE_MIN_VERSION_CODE above 25". Both halves are now met:
 *  - the dApp Store's LIVE release is 0.6.6 / code 32 (28 Sep 2026), with the in-app updater; 0.5.8 /
 *    code 25 and below are Deprecated there. Owner, 2026-10-10 14:50Z, with a screenshot of the
 *    publisher portal: "that means production is running code 32 rn now not code 25";
 *  - owner, 2026-10-10 14:20Z: "no problem to deploy new code 33 because we have autoupdater so
 *    anyone who has code 25 or installs it can autoupdate so ship it".
 * The rule: SIM 18 ships ONLY together with Android code 33 and NATIVE_MIN_VERSION_CODE=33
 * (infra/deploy.sh refuses a SIM-18 tree with a lower floor; no flag overrides it). Every installed
 * build 25-32 must then get a clean "update required": the body still decodes with the frozen code-25
 * schema above (so the floor is read, not a decode error), the advertised floor is above its own code,
 * and the stable code-33 row is offered. No SIM-17 build may fight on the SIM-18 server.
 * The next SIM change needs the same again: an owner ruling, the first Android code for that SIM in
 * infra/deploy.sh, and a rewrite of these pins. Do not edit them to pass a bump.
 */
describe('SIM 18 ships only with code 33 and floor 33 (G6 Path A)', () => {
  it('SIM_VERSION is 18, the SIM code 33 is the first Android build to compile', () => {
    expect(SIM_VERSION).toBe(18);
  });

  it('capabilities advertise SIM 18 and, with the Path A floor, tell every build 25-32 to update in a body code 25 still decodes', async () => {
    expect((await capabilities(off))['simVersion']).toBe(18);
    await publishNativeUpdate(db, manifest(33, { channel: 'stable', mandatory: true, versionName: '0.7.0' }),
      { config: { PLAY_URL: 'https://play.example.com' }, originCheck: false });
    const body = await capabilities(pathA);
    expect(body['update']).toMatchObject({ latestVersionCode: 33, mandatory: true, channel: 'stable' });
    const decoded = CODE25_CAPABILITIES.parse(body);
    expect(decoded).toMatchObject({ simVersion: 18, minimumVersionCode: 33 });
    for (const installed of [25, 26, 32]) expect(decoded.minimumVersionCode, `code ${installed}`).toBeGreaterThan(installed);
    // The floor and the offer are additive to what code 25 reads; everything else is unchanged.
    const { update: _update, minimumVersionCode: _floor, ...rest } = body;
    const { minimumVersionCode: _offFloor, ...offRest } = await capabilities(off);
    expect(rest).toEqual(offRest);
  });
});

// Copying either example must leave the channel dark (WORKING-RULES S4 pattern).
describe('operator examples', () => {
  it.each(['.env.example', 'infra/.env.prod.example'])('%s ships NATIVE_UPDATE_CHANNEL_ENABLED=false', async (file) => {
    const example = await readFile(new URL(`../../../${file}`, import.meta.url), 'utf8');
    expect([...example.matchAll(/^NATIVE_UPDATE_CHANNEL_ENABLED=(.*)$/gm)].map((match) => match[1])).toEqual(['false']);
  });
});
