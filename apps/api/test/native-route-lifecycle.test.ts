import { request } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import Fastify, { type FastifyInstance } from 'fastify';
import { BuildingType } from '@shardkeep/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/db/client';
import { HttpError } from '../src/lib/errors';
import { NATIVE_POLL_INTERVAL_MS, registerNativeRoutes } from '../src/native/routes';
import { NativeSimulationService, type NativeSimulationResult } from '../src/native/simulation';
import { loadConfig, loadNativeServiceConfig } from '../src/config';
import { ADMISSION_FIELDS, normalizeAdmission } from '../../../scripts/src/check-native-admission';

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../src/native/source', () => ({ loadNativePresentation: load }));

const apps: FastifyInstance[] = [];
const revision = 'a'.repeat(64);
const url = '/raids/11111111-1111-4111-8111-111111111111/presentation';
const events: NativeSimulationResult = { events: [{ t: 0, e: 'star', n: 1 }] };
const source = () => ({ envelope: { protocolVersion: 1 }, revision, events: [], simulationKey: revision,
  input: { snapshot: { keepLevel: 1, surplusShards: 0,
    buildings: [{ id: 'keep', type: BuildingType.Keep, level: 1, tx: 14, ty: 14 }] },
  orders: { deploys: [] }, seed: 7 } });

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.restoreAllMocks(); load.mockReset();
});

async function fixture() {
  let allowed = true;
  const app = Fastify(); apps.push(app);
  app.decorate('authenticate', async (req) => {
    if (!allowed) throw new HttpError(403, 'session revoked');
    req.wallet = 'viewer';
  });
  app.setErrorHandler((error, _req, reply) => {
    const status = error instanceof HttpError ? error.statusCode : 500;
    void reply.status(status).send({ error: 'request failed' });
  });
  registerNativeRoutes(app, { NATIVE_PRESENTATION_ENABLED: 'true', NATIVE_PRESENTATION_OPEN: 'true',
    NATIVE_PRESENTATION_MAX_STREAMS: 1 }, {} as Db);
  await app.ready();
  load.mockResolvedValue(source());
  return { app, revoke: () => { allowed = false; } };
}

describe('native presentation request lifecycle', () => {
  it('avoids half-second row-lock polls while still rechecking session revocation at the next poll', async () => {
    const f = await fixture();
    let started!: () => void;
    const firstRead = new Promise<void>((resolve) => { started = resolve; });
    load.mockImplementation(async () => { started(); return source(); });
    const response = f.app.inject(`${url}?afterRevision=${revision}&waitMs=1000`).then((value) => value);
    await firstRead; await delay(650);
    expect(load).toHaveBeenCalledTimes(1);
    f.revoke();
    expect((await response).statusCode).toBe(403);
    expect(load).toHaveBeenCalledTimes(1); // Revoked auth beats even the final authority read.
  });

  it('rechecks live authority before returning an unchanged long-poll timeout', async () => {
    const f = await fixture();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(0);
    // A real timer may wake just before the wall-clock deadline, legitimately
    // causing another authority read. Pin this scenario to a deadline reached
    // on the second read, retaining the exact final-read assertion below.
    load.mockResolvedValueOnce(source()).mockImplementationOnce(async () => {
      clock.mockReturnValue(NATIVE_POLL_INTERVAL_MS);
      return source();
    });
    const response = await f.app.inject(`${url}?afterRevision=${revision}&waitMs=${NATIVE_POLL_INTERVAL_MS}`);
    expect(response.statusCode).toBe(204);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('passes socket disconnect to the shared service and releases the HTTP admission slot', async () => {
    const f = await fixture();
    let started!: () => void; let disconnected!: () => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const aborted = new Promise<void>((resolve) => { disconnected = resolve; });
    const simulate = vi.spyOn(NativeSimulationService.prototype, 'simulate').mockImplementation((_id, _key, _input, signal) => {
      expect(signal).toBeDefined();
      return new Promise((_resolve, reject) => {
        signal!.addEventListener('abort', () => {
          disconnected(); reject(new HttpError(499, 'presentation request closed'));
        }, { once: true });
        started();
      });
    });
    const address = await f.app.listen({ host: '127.0.0.1', port: 0 });
    const req = request(`${address}${url}`); req.on('error', () => undefined); req.end();
    await admitted; req.destroy(); await aborted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    load.mockResolvedValue({ ...source(), input: null, simulationKey: null });
    expect((await f.app.inject(url)).statusCode).toBe(200);
    expect(simulate).toHaveBeenCalledTimes(1);
  });

  it('rejects a revoked session after a slow simulation instead of returning its events', async () => {
    const f = await fixture();
    let started!: () => void; let finish!: (value: NativeSimulationResult) => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    vi.spyOn(NativeSimulationService.prototype, 'simulate').mockImplementation(() => new Promise((resolve) => {
      finish = resolve; started();
    }));
    const response = f.app.inject(url).then((value) => value);
    await admitted; f.revoke(); finish(events);
    expect((await response).statusCode).toBe(403);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('rechecks live deed authority after a cached result', async () => {
    const f = await fixture();
    vi.spyOn(NativeSimulationService.prototype, 'simulate').mockResolvedValue(events);
    load.mockResolvedValueOnce(source()).mockRejectedValueOnce(new HttpError(403, 'deed moved'));
    const response = await f.app.inject(url);
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('star');
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('native deployment admission normalization', () => {
  it('matches the real main and companion config semantics, including closed empty lists', () => {
    const baseline = { DATABASE_URL: 'postgres://unused/unused', JWT_SECRET: 'test-secret-test-secret-test-secret!',
      NODE_ENV: 'test', SOLANA_RPC_URL: 'http://localhost:8899', WEB_ORIGIN: 'http://localhost:5173',
      NATIVE_PRESENTATION_SERVICE: 'true' };
    const wallet = 'A'.repeat(32);
    for (const overrides of [{}, { ALPHA_WALLETS: ' ', ADMIN_WALLETS: '' },
      { ALPHA_WALLETS: ', ,', ADMIN_WALLETS: ',,' },
      { ALPHA_WALLETS: `${wallet},${wallet}`, ADMIN_WALLETS: wallet, PLAYTEST_OPEN: 'true', MULTI_BASE_ENABLED: 'true' }]) {
      const env: NodeJS.ProcessEnv = { ...baseline, ...overrides };
      const selected = Object.fromEntries(ADMISSION_FIELDS.map((field) => [field, env[field] ?? null]));
      for (const config of [loadConfig(env), loadNativeServiceConfig(env)]) {
        expect(normalizeAdmission(selected)).toEqual({
          ALPHA_WALLETS: config.ALPHA_WALLETS?.slice().sort() ?? null,
          ADMIN_WALLETS: config.ADMIN_WALLETS?.slice().sort() ?? null,
          PLAYTEST_OPEN: config.PLAYTEST_OPEN === 'true', MULTI_BASE_ENABLED: config.MULTI_BASE_ENABLED === 'true',
        });
      }
    }
  });
});
