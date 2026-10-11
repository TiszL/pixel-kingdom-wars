/**
 * The stale-client gate.
 *
 * A phone can hold a cached bundle across a deploy. That client simulates the
 * battle locally while the player deploys, the server re-simulates it at submit,
 * and if the two simulators disagree the player watches one fight and is awarded
 * the outcome of a different one. These tests pin the two halves of the defence:
 * /version tells a client what the server is, and raid creation/submission refuse
 * a client that would disagree. Creation is the cheap primary gate; submission
 * closes the rollout race for a battle created just before a deploy.
 */
import type { FastifyInstance } from 'fastify';
import { SIM_VERSION } from '@shardkeep/sim';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { BUILD, isOutdatedClient, SIM_VERSION_HEADER } from '../src/version';
import { TEST_CONFIG, connectTestDb } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;

beforeAll(async () => {
  conn = connectTestDb();
  app = await buildApp(TEST_CONFIG, conn.db);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

describe('GET /version', () => {
  it('publishes the running build, unauthenticated', async () => {
    // Unauthenticated on purpose: a client that cannot log in (because it is too
    // old) must still be able to find out that it is too old.
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      version: BUILD.version,
      gitSha: BUILD.gitSha,
      builtAt: BUILD.builtAt,
      simVersion: SIM_VERSION,
    });
  });

  it('reports the SIM_VERSION the sim package actually exports', async () => {
    // Guards against the endpoint drifting to a hardcoded literal — the whole
    // mechanism is worthless if this number is not the real one.
    const res = await app.inject({ method: 'GET', url: '/version' });
    expect(res.json().simVersion).toBe(SIM_VERSION);
  });
});

describe('credentialed game-app CORS', () => {
  it('preflights authoritative PUT routes from the configured web origin', async () => {
    const origin = TEST_CONFIG.WEB_ORIGIN[0]!;
    const res = await app.inject({
      method: 'OPTIONS',
      url: '/base/layouts/HOME',
      headers: {
        origin,
        'access-control-request-method': 'PUT',
      },
    });

    expect(res.statusCode).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers['access-control-allow-methods']).split(/,\s*/)).toContain('PUT');
  });
});

describe('isOutdatedClient', () => {
  it('accepts a matching version', () => {
    expect(isOutdatedClient(String(SIM_VERSION))).toBe(false);
  });

  it('rejects any mismatch, in EITHER direction', () => {
    // Not >= : replay is bit-identical or it is wrong. A client running a NEWER
    // sim than the server is just as broken as an older one, and would otherwise
    // sail through a naive minimum-version check.
    expect(isOutdatedClient(String(SIM_VERSION + 1))).toBe(true);
    expect(isOutdatedClient(String(SIM_VERSION - 1))).toBe(true);
  });

  it('rejects garbage rather than coercing it', () => {
    expect(isOutdatedClient('')).toBe(true);   // Number('') is 0, which is not a version
    expect(isOutdatedClient('two')).toBe(true);
    expect(isOutdatedClient('  ')).toBe(true);
    // A decimal spelling of the SAME integer is the same version, not garbage.
    expect(isOutdatedClient(`${SIM_VERSION}.0`)).toBe(false);
  });

  it('lets a request with NO header through', () => {
    // Deliberate: the server is authoritative and re-simulates everything, so
    // omitting the header gains a liar nothing. The gate exists to protect an
    // honest stale client, and a missing header is every non-web caller (curl,
    // tests, future native client) rather than an attack.
    expect(isOutdatedClient(undefined)).toBe(false);
  });
});

describe('raid creation refuses a client that would simulate differently', () => {
  const stale = { [SIM_VERSION_HEADER]: String(SIM_VERSION + 1) };

  it('426s POST /raids before touching auth-protected work', async () => {
    const res = await app.inject({ method: 'POST', url: '/raids', headers: stale, payload: {} });
    expect(res.statusCode).toBe(426);
    expect(res.json().error.message).toBe('OUTDATED_CLIENT');
  });

  it('404s the retired PvE route before any version gate (D-152)', async () => {
    // WHY: POST /raids/pve and its KEEP bounty were deleted under D-152. A stale
    // client must see a plain 404 (route gone), never a 426 that would send it
    // to update for a feature that no longer exists.
    const res = await app.inject({ method: 'POST', url: '/raids/pve', headers: stale, payload: {} });
    expect(res.statusCode).toBe(404);
  });

  it('426s campaign and order submission too — every battle write', async () => {
    // The create routes and the one resolution route all cross the local
    // simulator boundary. A raid can be created immediately before a rollout and
    // submitted immediately after it, so creation-only gating leaves a race.
    for (const url of [
      '/campaign/1/raid',
      '/raids/00000000-0000-4000-8000-000000000000/orders',
    ]) {
      const res = await app.inject({ method: 'POST', url, headers: stale, payload: {} });
      expect(res.statusCode, url).toBe(426);
      expect(res.json().error.message, url).toBe('OUTDATED_CLIENT');
    }
  });

  it('426 beats the 401/402 a stale client would otherwise get', async () => {
    // These requests carry no session. The gate must run FIRST, or a stale client
    // sees "log in again", tries, and loops — instead of "update", which is the
    // only thing that actually fixes it.
    const authed = await app.inject({ method: 'POST', url: '/raids', payload: {} });
    expect(authed.statusCode).not.toBe(426); // control: without the header it gets the normal rejection
    const gated = await app.inject({ method: 'POST', url: '/raids', headers: stale, payload: {} });
    expect(gated.statusCode).toBe(426);
  });
});
