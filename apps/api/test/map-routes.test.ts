/**
 * GET /map wire contract (docs/MAP-SCALE-PLAN.md S7).
 *
 * WHY these live at the ROUTE level and not next to getMapChunk: the two things
 * that make a 20-second poll affordable — conditional requests and the rect-size
 * guard — exist only in the HTTP layer. A unit test of getMapChunk cannot see
 * either, so a regression here would be invisible until the poll loop shipped.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import bs58 from 'bs58';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { WORLD } from '@shardkeep/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { players } from '../src/db/schema';
import { SESSION_COOKIE } from '../src/auth/session';
import { ensurePlotAssigned } from '../src/game/world';
import { resetMapCache } from '../src/lib/mapCache';
import { TEST_CONFIG, connectTestDb } from './helpers';

let conn: ReturnType<typeof connectTestDb>;
let app: FastifyInstance;
let cookie: string;

beforeAll(async () => {
  conn = connectTestDb();
  app = await buildApp(TEST_CONFIG, conn.db);
  await app.ready();

  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const ch = await app.inject({ method: 'GET', url: '/auth/challenge', query: { wallet } });
  const { message } = ch.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verify = await app.inject({ method: 'POST', url: '/auth/verify', payload: { wallet, signature } });
  cookie = verify.cookies.find((c) => c.name === SESSION_COOKIE)!.value;

  // /map sits behind requireEntryPaid; the on-chain credit is out of scope here.
  await conn.db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, wallet));
  await ensurePlotAssigned(conn.db, wallet);
  resetMapCache();
});

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, cookies: { [SESSION_COOKIE]: cookie }, headers });

describe('GET /map wire contract', () => {
  it('retires bare and visitor tactical views while keeping the globe projection', async () => {
    // WHY: every playable base now lives on a globe tile. The old 25×20 board is
    // not a second world players can descend into, but rolling clients still use
    // this URL for the explicitly narrow parcel-band projection.
    for (const url of ['/map', `/map?valleyId=${crypto.randomUUID()}`]) {
      const retired = await get(url);
      expect(retired.statusCode).toBe(410);
      expect((retired.json() as { error: { code: string } }).error.code)
        .toBe('VALLEY_VIEW_RETIRED');
    }
    expect((await get('/map?parcelBand=1')).statusCode).toBe(200);
  });

  it('answers 304 to a matching If-None-Match so a 20s poll costs ~nothing', async () => {
    // WHY: the map is only worth polling if an unchanged valley is nearly free.
    // Without the ETag every poll re-ships the whole payload — at 400 concurrent
    // viewers that is megabytes per second for a screen that did not change.
    const first = await get('/map?parcelBand=1');
    expect(first.statusCode).toBe(200);
    const etag = first.headers['etag'] as string;
    expect(etag).toBeTruthy();
    expect(first.headers['cache-control']).toBe('private, no-cache');

    const again = await get('/map?parcelBand=1', { 'if-none-match': etag });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');

    // A stale validator must NOT be honoured — otherwise a browser holding one
    // account's cached body could be told "unchanged" for a different account.
    const stale = await get('/map?parcelBand=1', { 'if-none-match': 'W/"not-the-current-one"' });
    expect(stale.statusCode).toBe(200);
  });

  it('CLAMPS an oversized rect instead of rejecting it', async () => {
    // WHY: rejecting would break every client that has not shipped the viewport
    // rect yet (including the bare `GET /map` this endpoint has always served).
    // Clamping keeps them working while bounding what the server will scan.
    const res = await get(`/map?parcelBand=1&x0=0&y0=0&x1=99999&y1=99999`);
    expect(res.statusCode).toBe(200);
    const { markers } = res.json() as { markers: Array<{ x: number; y: number }> };
    for (const m of markers) {
      expect(m.x).toBeLessThan(WORLD.gridCols);
      expect(m.y).toBeLessThan(WORLD.gridRows);
    }
  });

  it('serves the valley name and the live warzone flag', async () => {
    // WHY: the banner used to print a UUID fragment at a human, and warzoneActive
    // was computed on every map open and then thrown away — while the client had
    // no way to know shields were suppressed.
    const res = await get('/map?parcelBand=1');
    const body = res.json() as { valleyName: string; warzoneActive: boolean; recommended: string[] };
    expect(body.valleyName).toBeTruthy();
    expect(body.valleyName).not.toMatch(/^[0-9a-f]{8}-/); // not a uuid fragment
    expect(typeof body.warzoneActive).toBe('boolean');
    expect(Array.isArray(body.recommended)).toBe(true);
    expect(body.recommended.length).toBeLessThanOrEqual(WORLD.recommendedTargets);
  });

  it('projects the globe parcel band minimally even for the viewer own valley', async () => {
    // WHY: the tactical map may carry wallet/shield/presence/action fields, but
    // the globe calls the same endpoint for its deed directory. An explicit mode
    // must prevent the own-valley branch from spreading the full RosterRow onto
    // that bulk wire response.
    const own = await get('/map?parcelBand=1');
    const valleyId = (own.json() as { valleyId: string }).valleyId;
    const band = await get(`/map?valleyId=${valleyId}&parcelBand=1`);
    expect(band.statusCode).toBe(200);
    const body = band.json() as { markers: Array<Record<string, unknown>>; recommended: unknown[] };
    expect(body.markers.length).toBeGreaterThan(0);
    expect(body.recommended).toEqual([]);
    for (const marker of body.markers) {
      expect(marker['kind']).toBe('silhouette');
      const keys = ['avatarUrl', 'earthCell', 'keepLevel', 'kind', 'name', 'trophies', 'x', 'y'];
      if (marker['isMe'] === true) keys.push('isMe');
      expect(Object.keys(marker).sort()).toEqual(keys.sort());
      for (const forbidden of [
        'wallet', 'shielded', 'surplusTease', 'clanTag', 'seeker', 'online',
        'burning', 'inWindow', 'revenge', 'avatarHash', 'avatarGeneration',
      ]) expect(marker[forbidden]).toBeUndefined();
    }
    expect(body.markers.some((marker) => marker['isMe'] === true)).toBe(true);
  });
});
