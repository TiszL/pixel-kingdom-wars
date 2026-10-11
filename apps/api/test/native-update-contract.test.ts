/**
 * The frozen /native/capabilities contract every INSTALLED native build reads to
 * find its next update (owner 2026-09-27: every installed build must always be able
 * to find and install the next update from its loading screen, even after a future
 * breaking release).
 *
 * WHY: codes 26–28 (0.6.0–0.6.2, on real Seekers) decode the WHOLE response with one
 * strict kotlinx decode (native 2cf5da4 network/.../model/Account.kt:97-144, the same
 * class since code 26 f6ea8ab): `protocolVersion` Int and `simVersion` Long are
 * required, `minimumVersionCode` is a Long that must be >= 0 (`require`), and
 * `contentManifestUrl` / `presentation` are nullable. `ApiJson` ignores unknown keys
 * but never coerces a type, so a retyped top-level field fails the decode and the
 * build loses its content pointer, its floor and its update offer at once. The
 * `update` block has a tolerant wrapper: if one of its 11 required fields is missing
 * or retyped, the offer silently reads as null. The build then never offers an
 * update again, and the only way off it is a manual store visit. Code 29 adds a
 * tolerant boot-time gate, but builds already installed never receive it.
 *
 * So nothing below may be edited to make a failure pass. A new offer shape is a NEW
 * additive key, never a change to these. The pins move only when adoption telemetry
 * shows codes 26–28 gone (docs/KNOWN_ISSUES.md K-203). The audience rule (tester rows
 * never reach an unauthenticated caller) is pinned in native-update-channel.test.ts.
 */
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { SIM_VERSION } from '@shardkeep/sim';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../src/app';
import type { Config } from '../src/config';
import type { NativeUpdateOffer } from '../src/native/contracts';
import { publishNativeUpdate } from '../src/native/updateChannel';
import { manifest, resetNativeUpdateChannel } from './fixtures/nativeUpdateChannel';
import { connectTestDb, TEST_CONFIG } from './helpers';

/** The top-level fields codes 26–28 decode strictly (Account.kt:97-109). Non-strict
 * like their ignoreUnknownKeys; `update` and `worldV2` have tolerant wrappers. */
const INSTALLED_CAPABILITIES = z.object({
  protocolVersion: z.literal(1),
  simVersion: z.number().int().positive(),
  minimumVersionCode: z.number().int().nonnegative(),
  contentManifestUrl: z.string().nullable(),
  presentation: z.object({ enabled: z.boolean() }).nullable(),
});

/** The `update` block as codes 26–28 decode it (Account.kt:129-143): every key and its
 * JSON type. All but `mandatory` and `notesUrl` are required by the Kotlin class;
 * those two have defaults, but an owner-marked mandatory offer only reaches
 * the player if `mandatory` arrives as a boolean. `notesUrl` may also be null
 * (pinned in native-update-channel.test.ts); this fixture sets it. */
const FROZEN_UPDATE_TYPES = {
  latestVersionCode: 'integer', versionName: 'string', sourceCommit: 'string', apkPath: 'string',
  apkUrl: 'string', sha256: 'string', sizeBytes: 'integer', signerSha256: 'string', publishedAt: 'string',
  storeStatus: 'string', channel: 'string', mandatory: 'boolean', notesUrl: 'string',
} as const;
const jsonType = (value: unknown) => value === null ? 'null' : Number.isSafeInteger(value) ? 'integer' : typeof value;

/** Request shapes the route must answer identically, without a session cookie. */
const CALLERS: Array<[string, Record<string, string>]> = [
  ['no client headers (web, curl, the landing page)', {}],
  // Every APK through renderer contract 14 predates the renderer header.
  ['a native build older than the renderer header', { 'x-pkw-client': 'android-native' }],
  ['a native build declaring a future renderer contract', { 'x-pkw-client': 'android-native', 'x-pkw-renderer-contract': '99' }],
  // Code 28 stamps x-sim-version on every call (GameApi.kt:79). After a SIM bump its
  // value is stale, and the raid routes answer that with 426. Capabilities must not.
  ['a build left behind by a SIM bump', { 'x-pkw-client': 'android-native', 'x-pkw-renderer-contract': '15',
    'x-sim-version': String(SIM_VERSION - 1), 'user-agent': 'PKW-Native/0.6.2' }],
  ['malformed renderer and SIM headers', { 'x-pkw-client': 'android-native', 'x-pkw-renderer-contract': 'abc',
    'x-sim-version': 'garbage' }],
];

const PLAY = 'https://play.example.com';
const NOTES = `${PLAY}/notes/28`;
const conn = connectTestDb();
const db = conn.db;
let current: FastifyInstance; let retired: FastifyInstance;
const get = (app: FastifyInstance, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> =>
  app.inject({ method: 'GET', url: '/native/capabilities', headers });

beforeAll(async () => {
  const config: Config = { ...TEST_CONFIG, PLAY_URL: PLAY, NATIVE_UPDATE_CHANNEL_ENABLED: 'true' };
  current = await buildApp(config, db);
  // A future breaking release: stable 28 published first, THEN the floor raised to it,
  // so codes 26 and 27 are below the floor. They must still be told where 28 is.
  retired = await buildApp({ ...config, NATIVE_MIN_VERSION_CODE: 28 }, db);
  await current.ready(); await retired.ready();
});
beforeEach(async () => {
  await resetNativeUpdateChannel(db);
  const skip = { config: { PLAY_URL: PLAY }, originCheck: false as const };
  // The cutover shape docs/APK-RELEASE.md asks for: a mandatory stable row, with a tester
  // candidate above it that no unauthenticated caller may see.
  await publishNativeUpdate(db, manifest(28, { channel: 'stable', mandatory: true, notesUrl: NOTES }), skip);
  await publishNativeUpdate(db, manifest(29), skip);
});
afterAll(async () => {
  await resetNativeUpdateChannel(db);
  await current?.close(); await retired?.close(); await conn.sql.end();
});

describe.each([
  ['floor unset', () => current, 0],
  ['floor raised above the installed build', () => retired, 28],
])('capabilities for installed builds (%s)', (_label, app, floor) => {
  // A changed key or type in `update` makes codes 26–28 read null. They show no update
  // and stay on their build until the player finds the store by hand.
  it('the update block carries exactly the frozen keys with their frozen JSON types', async () => {
    const reply = await get(app());
    expect(reply.statusCode, reply.body).toBe(200);
    const update = (reply.json() as { update?: Record<string, unknown> }).update;
    expect(update, 'unauthenticated callers must see the stable row').toBeDefined();
    const types = Object.fromEntries(Object.entries(update!).map(([key, value]) => [key, jsonType(value)]));
    expect(types).toStrictEqual(FROZEN_UPDATE_TYPES);
    expect(update).toMatchObject({ latestVersionCode: 28, channel: 'stable', mandatory: true, notesUrl: NOTES });
  });

  // Codes 26–28 refuse an offer as MALFORMED (UpdateEligibility.kt, 2cf5da4) unless the
  // path, hash, code, size and name agree. The server must not emit an offer they refuse.
  it('the offer passes the checks codes 26–28 run before downloading', async () => {
    const update = (await get(app())).json().update as NativeUpdateOffer;
    const path = /^\/native\/releases\/([0-9]{1,6})-([0-9a-f]{64})\.apk$/.exec(update.apkPath);
    expect(path, update.apkPath).not.toBeNull();
    expect(Number(path![1])).toBe(update.latestVersionCode);
    expect(path![2]).toBe(update.sha256);
    expect(update.signerSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(update.sizeBytes).toBeGreaterThanOrEqual(1);
    expect(update.sizeBytes).toBeLessThanOrEqual(300 * 1024 * 1024); // the client's own MAX_UPDATE_BYTES
    expect(update.versionName).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
  });

  // A retyped top-level field fails the WHOLE strict decode in codes 26–28. They lose
  // the offer AND their floor, and a negative floor fails their `require`.
  it('protocolVersion is 1, simVersion an integer, minimumVersionCode a non-negative integer', async () => {
    const body = (await get(app())).json() as Record<string, unknown>;
    expect(INSTALLED_CAPABILITIES.safeParse(body).success, JSON.stringify(body)).toBe(true);
    expect(body['protocolVersion']).toBe(1);
    expect(Number.isSafeInteger(body['simVersion'])).toBe(true);
    expect(Object.hasOwn(body, 'minimumVersionCode')).toBe(true);
    expect(body['minimumVersionCode']).toBe(floor);
  });

  // Code 28 asks without a cookie while signed out or restoring (UpdateRepository.kt:259),
  // and every build stamps X-PKW-Client. A session requirement, a 426 or a redirect on
  // any header shape means a build that most needs the update cannot hear about it.
  it.each(CALLERS)('%s: 200 without a session cookie, same offer, no 426 and no redirect', async (_caller, headers) => {
    const baseline = (await get(app())).json() as Record<string, unknown>;
    const reply = await get(app(), headers);
    expect(reply.statusCode, reply.body).toBe(200);
    expect(reply.headers['location']).toBeUndefined();
    const body = reply.json() as Record<string, unknown>;
    expect(INSTALLED_CAPABILITIES.safeParse(body).success, reply.body).toBe(true);
    expect(body['update']).toEqual(baseline['update']);
    expect(body['minimumVersionCode']).toBe(floor);
  });
});
