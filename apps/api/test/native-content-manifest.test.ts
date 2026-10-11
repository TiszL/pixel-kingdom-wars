/**
 * WHY: /native/capabilities advertises ONE content generation. Installed code 25
 * caps its content engine at renderer contract 14 (NativeContentUpdates.kt:
 * `renderer in 2..14`), so the moment production advertises the revision-5 pack
 * (contract 15) every code 25 content check fails and the "content update could
 * not finish" notice sticks. NATIVE_CONTENT_MANIFEST_URL_LEGACY lets production
 * keep serving code 25 its own generation while code 26 (contract 15) gets the
 * new one. These tests pin who is "modern" (only an Android client declaring
 * contract >= 15), that everything else falls to the legacy URL, and that an
 * unset legacy URL is a strict no-op so the key can deploy dark.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig, loadNativeServiceConfig, type Config } from '../src/config';
import { HttpError } from '../src/lib/errors';
import { buildNativePresentationApp } from '../src/native/app';
import { NativeCapabilitiesSchema } from '../src/native/contracts';
import { registerNativeRoutes } from '../src/native/routes';
import { connectTestDb, randomWallet, TEST_CONFIG } from './helpers';

const conn = connectTestDb(); const db = conn.db;
const apps: FastifyInstance[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
afterAll(async () => { await conn.sql.end(); });

const MODERN = 'https://play.example.com/native-content/modern-hash/manifest.json';
const LEGACY = 'https://play.example.com/native-content/legacy-hash/manifest.json';

type Manifests = Pick<Config, 'NATIVE_CONTENT_MANIFEST_URL' | 'NATIVE_CONTENT_MANIFEST_URL_LEGACY'>;
async function routeApp(manifests: Manifests) {
  const app = Fastify(); apps.push(app);
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async () => { throw new HttpError(401, 'no session'); });
  registerNativeRoutes(app, { ...TEST_CONFIG, ...manifests }, db);
  await app.ready(); return app;
}

async function advertised(app: FastifyInstance, headers: Record<string, string>) {
  const reply = await app.inject({ url: '/native/capabilities', headers });
  expect(reply.statusCode, reply.body).toBe(200);
  return NativeCapabilitiesSchema.parse(reply.json()).contentManifestUrl;
}

const native = (contract?: string): Record<string, string> => ({
  'x-pkw-client': 'android-native', ...(contract === undefined ? {} : { 'x-pkw-renderer-contract': contract }),
});

// [label, headers, is this caller able to read a contract-15 pack?]
const matrix: Array<[string, Record<string, string>, boolean]> = [
  ['web (no X-PKW-Client)', {}, false],
  // Only the Android client's declaration counts: a web caller cannot opt itself in.
  ['web declaring contract 15', { 'x-pkw-renderer-contract': '15' }, false],
  ['native without a contract header (code 25 and older)', native(), false],
  ['native contract 14', native('14'), false],
  ['native contract 15 (code 26)', native('15'), true],
  ['native contract 20', native('20'), true],
  // A typo must never promote a stale renderer onto a pack it cannot read.
  ['native malformed contract "15a"', native('15a'), false],
  ['native malformed contract "fifteen"', native('fifteen'), false],
];

describe('content manifest routing by renderer contract', () => {
  it.each(matrix)('%s', async (_label, headers, modern) => {
    const app = await routeApp({ NATIVE_CONTENT_MANIFEST_URL: MODERN, NATIVE_CONTENT_MANIFEST_URL_LEGACY: LEGACY });
    expect(await advertised(app, headers)).toBe(modern ? MODERN : LEGACY);
  });

  it('with LEGACY unset every caller gets NATIVE_CONTENT_MANIFEST_URL, so the key deploys dark', async () => {
    const app = await routeApp({ NATIVE_CONTENT_MANIFEST_URL: MODERN });
    for (const [, headers] of matrix) expect(await advertised(app, headers)).toBe(MODERN);
  });

  it('with neither URL set every caller still sees null, the pre-existing contract', async () => {
    const app = await routeApp({});
    for (const [, headers] of matrix) expect(await advertised(app, headers)).toBeNull();
  });

  it('the ordinary API passes the legacy key through from its full config', async () => {
    const app = await buildApp({ ...TEST_CONFIG, NATIVE_CONTENT_MANIFEST_URL: MODERN, NATIVE_CONTENT_MANIFEST_URL_LEGACY: LEGACY }, db);
    apps.push(app);
    expect(await advertised(app, native())).toBe(LEGACY);
    expect(await advertised(app, native('15'))).toBe(MODERN);
  });

  it('the isolated companion keeps the legacy key through its config allowlist', async () => {
    // NativeServiceSchema.pick() silently drops an unlisted key; without the
    // allowlist entry the companion would hand code 25 the contract-15 pack.
    const config = loadNativeServiceConfig({ DATABASE_URL: TEST_CONFIG.DATABASE_URL, REDIS_URL: TEST_CONFIG.REDIS_URL,
      JWT_SECRET: TEST_CONFIG.JWT_SECRET, NODE_ENV: 'test', NATIVE_PRESENTATION_SERVICE: 'true',
      NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_WALLETS: randomWallet(),
      NATIVE_CONTENT_MANIFEST_URL: MODERN, NATIVE_CONTENT_MANIFEST_URL_LEGACY: LEGACY });
    expect(config.NATIVE_CONTENT_MANIFEST_URL_LEGACY).toBe(LEGACY);
    const app = await buildNativePresentationApp(config, db); apps.push(app);
    expect(await advertised(app, native('14'))).toBe(LEGACY);
    expect(await advertised(app, native('15'))).toBe(MODERN);
  });
});

describe('NATIVE_CONTENT_MANIFEST_URL_LEGACY config', () => {
  const required = { DATABASE_URL: TEST_CONFIG.DATABASE_URL, JWT_SECRET: TEST_CONFIG.JWT_SECRET, WEB_ORIGIN: 'http://localhost:5173', NODE_ENV: 'test' };

  it('treats the empty .env.example placeholder as unset', () => {
    expect(loadConfig({ ...required, NATIVE_CONTENT_MANIFEST_URL_LEGACY: '' }).NATIVE_CONTENT_MANIFEST_URL_LEGACY).toBeUndefined();
  });

  it('accepts https and refuses a plain-http manifest, like the primary URL', () => {
    // The manifest pins every pack hash; a downgradeable transport would let a
    // network attacker substitute it for exactly the old clients this serves.
    expect(loadConfig({ ...required, NATIVE_CONTENT_MANIFEST_URL_LEGACY: LEGACY }).NATIVE_CONTENT_MANIFEST_URL_LEGACY).toBe(LEGACY);
    expect(() => loadConfig({ ...required, NATIVE_CONTENT_MANIFEST_URL_LEGACY: 'http://example.com/pack.json' })).toThrow();
    expect(() => loadConfig({ ...required, NATIVE_CONTENT_MANIFEST_URL_LEGACY: 'not a url' })).toThrow();
  });
});
