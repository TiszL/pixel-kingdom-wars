/** review b37cc131 S1: art permission is a server opt-in, never inferred from
 * a native pack or the buildings flag alone. Tests authored before S1; UNRUN.
 * Uses the real route/schema/helpers with a refusing DB and no signing fixture.
 * Cedar3 owns execution, including the repository's default global setup. */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { phaseEArtEnabled } from '../src/config';
import type { Db } from '../src/db/client';
import { HttpError } from '../src/lib/errors';
import * as economyIdentity from '../src/money/economyIdentity';
import { NativeCapabilitiesSchema } from '../src/native/contracts';
import { registerNativeRoutes } from '../src/native/routes';

const apps: FastifyInstance[] = [];
const modern = { 'x-pkw-client': 'android-native', 'x-pkw-renderer-contract': '15' };
const deniedHeaders: Array<[string, Record<string, string>]> = [
  ['web', {}],
  ['web claiming a renderer', { 'x-pkw-renderer-contract': '15' }],
  ['native without a renderer', { 'x-pkw-client': 'android-native' }],
  ['old native renderer', { ...modern, 'x-pkw-renderer-contract': '14' }],
  ['malformed native renderer', { ...modern, 'x-pkw-renderer-contract': '15a' }],
  ['wrong client identity', { ...modern, 'x-pkw-client': 'other' }],
];
beforeEach(() => {
  vi.stubEnv('PHASE_E_ART_ENABLED', undefined);
  vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', undefined);
  vi.stubEnv('GEMS_ENABLED', 'false');
  vi.stubEnv('GEMS_WALLET_BUY_ENABLED', 'false');
  vi.stubEnv('FORGE_INGOTS_ENABLED', 'false');
  vi.spyOn(economyIdentity, 'gemsReserveAta').mockReturnValue(null);
});
afterEach(async () => {
  try { for (const app of apps.splice(0)) await app.close(); }
  finally { vi.restoreAllMocks(); vi.unstubAllEnvs(); }
});
async function fixture() {
  const app = Fastify(); apps.push(app);
  const execute = vi.fn(async () => { throw Error('unexpected DB read for dark capability'); });
  const db = { execute } as unknown as Db;
  app.decorateRequest('wallet', '');
  app.decorate('authenticate', async () => { throw new HttpError(401, 'no fixture session'); });
  registerNativeRoutes(app, {
    NATIVE_PRESENTATION_ENABLED: 'false', NATIVE_PRESENTATION_OPEN: 'false',
    NATIVE_UPDATE_CHANNEL_ENABLED: 'false', NATIVE_WORLD_V2_ENABLED: 'true',
    NATIVE_CONTENT_MANIFEST_URL: 'https://content.example.test/modern/manifest.json',
    NATIVE_CONTENT_MANIFEST_URL_LEGACY: 'https://content.example.test/legacy/manifest.json',
  }, db);
  await app.ready();
  return { app, execute };
}
async function read(app: FastifyInstance, headers: Record<string, string> = modern) {
  const response = await app.inject({ url: '/native/capabilities', headers });
  expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  return NativeCapabilitiesSchema.parse(response.json());
}

describe('exact default-off Phase E art opt-in', () => {
  it.each([undefined, 'false', 'TRUE', '1', 'true ', ' true', 'yes', ''])
  ('%s cannot admit art through a loose truthiness check', value => {
    expect(phaseEArtEnabled(value === undefined ? {} : { PHASE_E_ART_ENABLED: value })).toBe(false);
  });
  it('only the exact true string opts in, independently of building game rules', () => {
    expect(phaseEArtEnabled({ PHASE_E_ART_ENABLED: 'true' })).toBe(true);
  });
});

describe('capability admission and compatibility', () => {
  it.each([
    [undefined, undefined, false], ['true', undefined, false],
    [undefined, 'true', false], ['true', 'true', true],
  ] as const)('art=%s buildings=%s gives enabled=%s: both server permissions are required', async (art, buildings, enabled) => {
    vi.stubEnv('PHASE_E_ART_ENABLED', art); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', buildings);
    const { app, execute } = await fixture();
    expect((await read(app)).phaseEArt).toEqual({ version: 1, enabled });
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(deniedHeaders)('%s never receives the new renderer capability even with both flags', async (_name, headers) => {
    vi.stubEnv('PHASE_E_ART_ENABLED', 'true'); vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
    const { app } = await fixture();
    expect(await read(app, headers)).not.toHaveProperty('phaseEArt');
  });
  it('keeps the optional field absent for older responses instead of inventing an opt-in', async () => {
    const { app } = await fixture();
    const { phaseEArt: _omitted, ...oldResponse } = await read(app);
    expect(NativeCapabilitiesSchema.parse(oldResponse)).not.toHaveProperty('phaseEArt');
  });
  it('validates version and boolean without stripping the capability', async () => {
    const { app } = await fixture(), body = await read(app);
    expect(NativeCapabilitiesSchema.parse({ ...body, phaseEArt: { version: 1, enabled: true } }).phaseEArt)
      .toEqual({ version: 1, enabled: true });
    expect(() => NativeCapabilitiesSchema.parse({ ...body, phaseEArt: { version: 2, enabled: true } })).toThrow();
    expect(() => NativeCapabilitiesSchema.parse({ ...body, phaseEArt: { version: 1, enabled: 'true' } })).toThrow();
  });
  it('changes no other capability or legacy manifest when the art permission changes', async () => {
    vi.stubEnv('PHASE_E_BUILDINGS_ENABLED', 'true');
    const { app } = await fixture();
    const legacyBefore = await read(app, deniedHeaders[2]![1]);
    const { phaseEArt: _off, ...before } = await read(app);
    vi.stubEnv('PHASE_E_ART_ENABLED', 'true');
    const { phaseEArt: _on, ...after } = await read(app);
    expect(after).toEqual(before);
    expect(await read(app, deniedHeaders[2]![1])).toEqual(legacyBefore);
  });
});
