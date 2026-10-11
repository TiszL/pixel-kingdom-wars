/**
 * PER-IP RATE LIMITS ON THE MAP READS (docs/WORLDMAP-GLOBE-PLAN.md P4).
 *
 * WHY A PURPOSE-BUILT APP INSTEAD OF THE USUAL buildApp + inject.
 * app.ts registers @fastify/rate-limit only when NODE_ENV !== 'test' (otherwise
 * every suite in the repo would share one 300/60 s budget and start 429-ing each
 * other). That makes `config.rateLimit` INERT under test — so a test that injected
 * requests at the real app would pass no matter what the routes declared, and the
 * plan's claim that these routes are "rate-limited" would stay unverified. That is
 * exactly how the gap being closed here got in.
 *
 * So this suite wires the REAL route table (`registerGameRoutes`) into a Fastify
 * instance that DOES have the limiter, and drives the REAL numbers through it. The
 * Anonymous bulk limiters run at `onRequest`, ahead of authentication, which is
 * what makes them cheap: unauthenticated requests are counted and answered 401.
 * The one identity-bearing parcel lookup deliberately has TWO buckets: an
 * `onRequest` IP gate (because route config replaces the global limit), followed
 * by a manual `createRateLimit` wallet gate after authentication + land ownership.
 * Its test requests reach the empty test DB and harmlessly return 404.
 *
 * WHAT IS BEING PROTECTED. The global 300/60 s is a DDoS floor, not a cost ceiling:
 *  - `GET /map?valleyId=<any uuid>` loads a whole ≤500-row roster into mapCache for
 *    every DISTINCT id, so under the global cap alone one IP drives ~5 cold roster
 *    loads/s and can churn the entire WORLD.mapCacheMaxValleys LRU, evicting the
 *    valleys real players are looking at.
 *  - `GET /globe` can miss its 60 s snapshot and run the planet aggregate.
 *  - `GET /map/search` runs a leading-wildcard `ilike` that no index can serve, and
 *    free onboarding moved it out of the paid group — so reaching it no longer costs
 *    0.2 SOL and the floor was all that was left (security review F11).
 *
 * AND WHAT IS NOT. The expensive thing is the COLD load, not the request, so /map
 * splits into three counters (routes.ts mapBudget): your own valley, CONTINUING to
 * view a valley already in mapCache (a cache hit — poll + pan), and OPENING one that
 * is not. Fusing the last two is what made honest exploring 429: see the
 * browse-and-pan test below, which is sized from the same arithmetic as the constant.
 */
import rateLimit from '@fastify/rate-limit';
import { GLOBE, WORLD } from '@shardkeep/shared';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAP_RATE_LIMITS, registerGameRoutes } from '../src/game/routes';
import { getValleySnapshot, resetMapCache } from '../src/lib/mapCache';
import { connectTestDb } from './helpers';

const conn = connectTestDb();
let app: FastifyInstance;

beforeAll(async () => {
  // `trustProxy: 1` mirrors app.ts:96 — the limiter keys on req.ip, so without it
  // every injected request shares one key and the per-IP claim cannot be tested.
  app = Fastify({ trustProxy: 1 });
  // In-memory store, and a GLOBAL cap far above every per-route cap under test, so
  // a 429 can only come from the route's own declaration.
  await app.register(rateLimit, { global: true, max: 10_000, timeWindow: 60_000 });
  // Stub the two decorators registerGameRoutes reads. Anonymous reads reject after
  // their onRequest limiter has counted them. Parcel reads establish a stable test
  // wallet so their later per-wallet preHandler limiter can be exercised.
  app.decorate('authenticate', async (
    req: { url: string; headers: Record<string, string | string[] | undefined>; wallet: string },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } },
  ): Promise<void> => {
    if (req.url.startsWith('/map/parcel/')) {
      const header = req.headers['x-test-wallet'];
      req.wallet = typeof header === 'string' ? header : 'parcel-viewer-a';
      return;
    }
    if (req.url.startsWith('/globe/parcels')) {
      const header = req.headers['x-test-wallet'];
      if (typeof header === 'string') {
        req.wallet = header;
        return;
      }
    }
    await reply.code(401).send({ error: { message: 'stub' } });
  });
  app.decorate('authenticateLoginRecovery', app.authenticate);
  app.decorate('requireLandOwned', async () => undefined);
  app.decorateRequest('wallet', '');
  registerGameRoutes(app as never, conn.db);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await conn.sql.end();
});

/** Fire n requests from one IP and return the status codes, in order. */
async function fire(
  url: string,
  n: number,
  ip = '203.0.113.7',
  wallet?: string,
): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = await app.inject({
      method: 'GET',
      url,
      headers: { 'x-forwarded-for': ip, ...(wallet ? { 'x-test-wallet': wallet } : {}) },
    });
    out.push(res.statusCode);
  }
  return out;
}

describe('the globe routes are explicitly rate limited', () => {
  it('declares the cap from constants, not from the global floor', () => {
    // WHY assert the declaration too: the behavioural test below would also pass if
    // the cap came from somewhere other than GLOBE.rateLimitPerMin (a literal, an
    // env var). The hard rule is that every tuning number lives in constants.ts.
    expect(MAP_RATE_LIMITS.globe).toEqual({ max: GLOBE.rateLimitPerMin, timeWindow: 60_000 });
  });

  it('429s the (GLOBE.rateLimitPerMin + 1)-th request from one IP', async () => {
    const codes = await fire('/globe', GLOBE.rateLimitPerMin + 1, '203.0.113.10');
    expect(codes.slice(0, GLOBE.rateLimitPerMin).every((c) => c !== 429)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('gives /globe/sector/:id its own budget, so one does not starve the other', async () => {
    // WHY: they are polled together — the region band opens over an already-loaded
    // globe. A shared counter would make normal use of both look like abuse of one.
    const ip = '203.0.113.11';
    expect((await fire('/globe', GLOBE.rateLimitPerMin, ip)).at(-1)).not.toBe(429);
    expect((await fire('/globe/sector/0', 1, ip)).at(-1)).not.toBe(429);
  });
});

describe('GET /globe/parcels is explicitly fail-closed and rate limited', () => {
  it('declares independent fail-closed IP and wallet caps from shared constants', () => {
    expect(MAP_RATE_LIMITS.viewportParcelIp).toMatchObject({
      max: GLOBE.parcelViewportIpRateLimitPerMin,
      timeWindow: 60_000,
      hook: 'onRequest',
      skipOnError: false,
    });
    expect(MAP_RATE_LIMITS.viewportParcelIp.keyGenerator({ ip: '203.0.113.1' } as never))
      .toBe('globe-parcels-ip:203.0.113.1');
    expect(MAP_RATE_LIMITS.viewportParcelWallet).toMatchObject({
      max: GLOBE.parcelViewportWalletRateLimitPerMin,
      timeWindow: 60_000,
      skipOnError: false,
    });
    expect(MAP_RATE_LIMITS.viewportParcelWallet.keyGenerator({ wallet: 'viewer' } as never))
      .toBe('globe-parcels-wallet:viewer');
    expect(GLOBE.parcelViewportIpRateLimitPerMin)
      .toBeGreaterThan(GLOBE.parcelViewportWalletRateLimitPerMin);
  });

  it('spends the fail-closed IP budget before authentication', async () => {
    const n = GLOBE.parcelViewportIpRateLimitPerMin;
    const codes = await fire(
      '/globe/parcels?x0=0&x1=0&y0=0&y1=0',
      n + 1,
      '203.0.113.12',
    );
    expect(codes.slice(0, n).every((code) => code === 401)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('gives two wallets independent budgets behind one carrier-NAT IP', async () => {
    const n = GLOBE.parcelViewportWalletRateLimitPerMin;
    const ip = '203.0.113.13';
    const url = '/globe/parcels?x0=0&x1=0&y0=0&y1=0';
    const codes = await fire(url, n + 1, ip, 'viewport-wallet-a');
    expect(codes.slice(0, n).every((code) => code !== 429)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    expect((await fire(url, 1, ip, 'viewport-wallet-b')).at(-1)).not.toBe(429);
  });
});

describe('GET /map/search is explicitly rate limited (security review F11)', () => {
  it('declares the cap from constants, not from the global floor', () => {
    // WHY THIS ROUTE NEEDED ITS OWN CEILING: free onboarding moved /map/search out
    // of the paid group, so reaching it stopped costing 0.2 SOL — and it had NO
    // entry here, leaving only app.ts's 300/60 s DDoS floor. It is the free tier's
    // most expensive uncached read: the name predicate is a LEADING-wildcard ilike
    // (game/world.ts searchPlayers) that no index can serve, so every call is a scan
    // over the landowner join.
    //
    // THE VALUE AND ITS ARITHMETIC LIVE ON THE CONSTANT (WORLD.mapSearchRate-
    // LimitPerMin = 60): a human typing in the search box makes ≤4 requests per
    // term, a hard minute is a term every 5 s ⇒ 12 × 4 = 48/min, and 60 is 1.25×
    // that. Asserted as a declaration too, because the behavioural test below would
    // also pass if the number came from a literal or an env var — every tuning
    // number lives in constants.ts (CLAUDE.md).
    expect(MAP_RATE_LIMITS.search).toEqual({ max: WORLD.mapSearchRateLimitPerMin, timeWindow: 60_000 });
    expect(WORLD.mapSearchRateLimitPerMin).toBeLessThan(300); // tighter than the global floor
  });

  it('429s the (WORLD.mapSearchRateLimitPerMin + 1)-th search from one IP', async () => {
    const n = WORLD.mapSearchRateLimitPerMin;
    const codes = await fire('/map/search?q=zzz', n + 1, '203.0.113.30');
    expect(codes.slice(0, n).every((c) => c !== 429)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('keeps its own counter, so searching cannot lock you out of the map', async () => {
    // WHY: same reasoning as /globe vs /globe/sector — a shared bucket would make
    // normal use of one surface look like abuse of another.
    const ip = '203.0.113.31';
    await fire('/map/search?q=zzz', WORLD.mapSearchRateLimitPerMin + 1, ip);
    expect((await fire('/map?parcelBand=1', 1, ip)).at(-1)).not.toBe(429);
  });
});

describe('GET /map/parcel/:earthCell is explicitly rate limited', () => {
  it('declares independent fail-closed IP and wallet budgets from the same constant', () => {
    // WHY TWO DECLARATIONS: a route config replaces the global plugin limiter,
    // while either identity alone is rotatable. The onRequest bucket covers IP;
    // the manually-applied post-auth bucket follows the verified landowner.
    expect(MAP_RATE_LIMITS.parcelIp).toMatchObject({
      max: WORLD.mapVisitOpenRateLimitPerMin,
      timeWindow: 60_000,
      hook: 'onRequest',
      skipOnError: false,
    });
    expect(MAP_RATE_LIMITS.parcelIp.keyGenerator({ ip: '203.0.113.1' } as never))
      .toBe('parcel-ip:203.0.113.1');
    expect(MAP_RATE_LIMITS.parcelWallet).toMatchObject({
      max: WORLD.mapVisitOpenRateLimitPerMin,
      timeWindow: 60_000,
      skipOnError: false,
    });
    expect(MAP_RATE_LIMITS.parcelWallet.keyGenerator({ wallet: 'viewer-wallet' } as never))
      .toBe('parcel-wallet:viewer-wallet');
    expect(WORLD.mapVisitOpenRateLimitPerMin).toBeLessThan(300);
  });

  it('429s after one wallet budget even when every request rotates IP', async () => {
    const n = WORLD.mapVisitOpenRateLimitPerMin;
    const codes: number[] = [];
    for (let i = 0; i <= n; i++) {
      codes.push(...await fire(
        '/map/parcel/12345',
        1,
        `203.0.113.${40 + i}`,
        'parcel-viewer-rotation-proof',
      ));
    }
    expect(codes.slice(0, n).every((c) => c !== 429)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('429s after one IP budget even when every request rotates wallet', async () => {
    const ip = '203.0.113.90';
    const n = WORLD.mapVisitOpenRateLimitPerMin;
    const codes: number[] = [];
    for (let i = 0; i <= n; i++) {
      codes.push(...await fire('/map/parcel/12345', 1, ip, `parcel-viewer-ip-rotation-${i}`));
    }
    expect(codes.slice(0, n).every((c) => c !== 429)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('keeps an unrelated IP + wallet usable after either protected budget is exhausted', async () => {
    const n = WORLD.mapVisitOpenRateLimitPerMin;
    await fire('/map/parcel/12345', n + 1, '203.0.113.91', 'parcel-viewer-exhausted');

    expect((await fire(
      '/map/parcel/12345', 1, '203.0.113.92', 'parcel-viewer-unrelated',
    )).at(-1)).not.toBe(429);
  });
});

/** A distinct, well-formed valley id per scenario — the limiter never parses it,
 *  but the route's zod schema does, and an id-walker's ids are all different. */
const vid = (n: number): string => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;

/** Put a valley's roster in mapCache, exactly as a first (cold) read would.
 *  No DB: the loader is a stub, because what is under test is the LIMITER's
 *  reaction to a WARM valley, not how the roster got there. */
async function warmValley(valleyId: string): Promise<void> {
  await getValleySnapshot(valleyId, false, async () => ({
    valleyId, valleyName: 'WARMED', players: [], camps: [],
  }));
}

describe('GET /map: opening a valley, viewing it, and polling your own are separate budgets', () => {
  it('meters COLD OPENS — a new valley id every time — at WORLD.mapVisitOpenRateLimitPerMin', async () => {
    // WHY: the cost of a visit is the ≤500-row roster load plus an LRU slot, and a
    // brand-new id pays it every single time. This is the amplification cap and the
    // one number that must stay small: an id-walking scraper wants hundreds a minute.
    const ip = '203.0.113.20';
    const codes: number[] = [];
    for (let i = 0; i <= WORLD.mapVisitOpenRateLimitPerMin; i++) {
      codes.push(...await fire(`/map?valleyId=${vid(i)}&parcelBand=1`, 1, ip));
    }
    expect(codes.slice(0, WORLD.mapVisitOpenRateLimitPerMin).every((c) => c !== 429)).toBe(true);
    expect(codes.at(-1)).toBe(429);
  });

  it('lets a real browse-and-pan session run without a 429 — the bug this split fixes', async () => {
    // WHY: this is the failure the owner would have hit on a phone. The visit bucket
    // used to fund EVERY subsequent read of a valley you were already inside — the
    // unconditional WORLD.mapPollSec poll plus a refetch per quantised pan step — out
    // of the same tiny allowance as opening a new place. So tapping a distant valley
    // on the globe and looking around it, the exact behaviour the globe exists to
    // invite, ran out of budget mid-drag and started 429-ing.
    //
    // Continuing to view an already-loaded valley is a CACHE HIT: same shape and same
    // cost as polling your own valley, so it draws on WORLD.mapRateLimitPerMin in its
    // own counter (mapBudget 'view'), and only the cold open stays tightly capped.
    const ip = '203.0.113.22';
    const valleyId = vid(100);
    resetMapCache();

    // Open it once — cold, one unit of the open budget — then it is in the cache,
    // which is what the limiter reads to tell 'view' from 'open'.
    expect((await fire(`/map?valleyId=${valleyId}&parcelBand=1`, 1, ip)).at(-1)).not.toBe(429);
    await warmValley(valleyId);

    // One hard minute of exploring, from WORLD.mapRateLimitPerMin's own derivation:
    // 60/mapPollSec polls plus ~46 pan/zoom refetches, all of the SAME valley.
    const PAN_REFETCHES = 46;
    const session = 60 / WORLD.mapPollSec + PAN_REFETCHES;
    // The session must be BIGGER than the open cap, or this test would pass even if
    // the two concerns were still fused — which is precisely how the bug survived.
    expect(session).toBeGreaterThan(WORLD.mapVisitOpenRateLimitPerMin);

    const codes = await fire(`/map?valleyId=${valleyId}&parcelBand=1`, session, ip);
    expect(codes.every((c) => c !== 429), 'browsing a valley you already opened must not 429').toBe(true);

    // And the cold-open budget is still intact underneath: viewing did not spend it.
    for (let i = 0; i < WORLD.mapVisitOpenRateLimitPerMin - 1; i++) {
      expect((await fire(`/map?valleyId=${vid(200 + i)}&parcelBand=1`, 1, ip)).at(-1)).not.toBe(429);
    }
  });

  it('does not let exploring lock you out of your OWN valley', async () => {
    // WHY: the budgets are separated by keyGenerator precisely so the poll that keeps
    // your own map alive (every WORLD.mapPollSec) can never be spent by looking
    // around the globe — and so a scraper cannot borrow either of the larger
    // allowances to walk valley ids.
    const ip = '203.0.113.21';
    for (let i = 0; i <= WORLD.mapVisitOpenRateLimitPerMin; i++) {
      await fire(`/map?valleyId=${vid(300 + i)}&parcelBand=1`, 1, ip);
    }
    expect((await fire('/map?parcelBand=1', 1, ip)).at(-1)).not.toBe(429);
    // …and the own-valley budget is itself bounded.
    const codes = await fire('/map?parcelBand=1', WORLD.mapRateLimitPerMin, ip);
    expect(codes.at(-1)).toBe(429);
  });
});
