/**
 * The rate limiter must see the PLAYER's address, not Caddy's.
 *
 * infra/Caddyfile puts a reverse proxy in front of the API, so without
 * `trustProxy` every request in the game arrives from the same socket peer — the
 * Caddy container. @fastify/rate-limit keys on `req.ip`, so the entire
 * playerbase would share one 300-req/min bucket and `/auth/challenge` would
 * allow 20 sign-ins per minute across all players combined. A hundred players
 * with the map open saturate that in seconds: an outage on launch day, caused by
 * one missing option.
 *
 * These tests assert the observable behaviour rather than the option, so they
 * survive a refactor and fail for the right reason if the option is dropped.
 */
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { TEST_CONFIG, connectTestDb } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;

beforeAll(async () => {
  conn = connectTestDb();
  app = await buildApp(TEST_CONFIG, conn.db);
  // A probe route. buildApp does not call ready(), so routes can still be added,
  // and this reports exactly what the rate limiter's keyGenerator would read.
  app.get('/__ip', async (req) => ({ ip: req.ip }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

const ipSeenBy = async (headers: Record<string, string>): Promise<string> =>
  (await app.inject({ method: 'GET', url: '/__ip', headers })).json().ip;

describe('the API trusts exactly one proxy hop', () => {
  it('reports the CLIENT address from X-Forwarded-For, not the proxy socket', async () => {
    expect(await ipSeenBy({ 'x-forwarded-for': '203.0.113.9' })).toBe('203.0.113.9');
  });

  it('buckets two different players separately', async () => {
    // The actual property that matters. Before the fix both of these returned the
    // same address and therefore shared one rate-limit bucket.
    const a = await ipSeenBy({ 'x-forwarded-for': '203.0.113.9' });
    const b = await ipSeenBy({ 'x-forwarded-for': '198.51.100.4' });
    expect(a).not.toBe(b);
  });

  it('falls back to the socket address when there is no proxy header', async () => {
    // A direct-to-API deployment (no Caddy) must keep working.
    expect(await ipSeenBy({})).toBeTruthy();
  });

  it('takes only ONE hop, so a client cannot forge its way into a fresh bucket', async () => {
    // With `trustProxy: true` Fastify would walk to the LEFTMOST entry and a
    // client could mint a new bucket per request by sending its own header.
    // With `1` it takes the rightmost — the address Caddy itself observed.
    // (Caddy replaces rather than appends, so in production the forged entry is
    // never even forwarded; this is defence in depth for a misconfigured proxy.)
    expect(await ipSeenBy({ 'x-forwarded-for': '10.0.0.1, 203.0.113.9' })).toBe('203.0.113.9');
  });
});
