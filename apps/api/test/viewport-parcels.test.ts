import { requiredFixture } from './helpers';
/**
 * Multi-valley Earth parcel viewport: the readable globe band may fetch every
 * eligible deed inside one bounded fine-grid rectangle without widening D-040's
 * public identity tuple into a tactical player directory.
 */
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519';
import { GLOBE } from '@shardkeep/shared';
import { EARTH_FINE } from '@shardkeep/shared/earthMaskFine';
import { fineCellCentreDeg, greatCircleKm, isLandCell } from '@shardkeep/shared/globe';
import { patchCells, tileOfFillIndex } from '@shardkeep/shared/parcelGrid';
import bs58 from 'bs58';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SESSION_COOKIE } from '../src/auth/session';
import { bases, baseSlots, playerActionEvents, playerActivityDays, players, plots, valleys } from '../src/db/schema';
import {
  earthViewportCellRanges, earthViewportCentreDeg, type EarthViewportRect, type ViewportParcels,
} from '../src/game/world';
import {
  TEST_CONFIG, connectTestDb, createTestPlayer, createTestValley, randomWallet, seedPlot,
} from './helpers';

const conn = connectTestDb();
const db = conn.db;
const priorFreeOnboarding = process.env['FREE_ONBOARDING'];
const priorMultiBase = process.env['MULTI_BASE_ENABLED'];
let app: FastifyInstance;
let cookie: string;

interface SeededDeed {
  wallet: string;
  baseId: string;
  earthCell: number;
  name: string;
  avatarGeneration: string;
}

async function signIn(): Promise<string> {
  const secretKey = utils.randomSecretKey();
  const wallet = bs58.encode(await getPublicKeyAsync(secretKey));
  const challenge = await app.inject({
    method: 'GET', url: '/auth/challenge', query: { wallet },
  });
  const { message } = challenge.json() as { message: string };
  const signature = bs58.encode(await signAsync(new TextEncoder().encode(message), secretKey));
  const verified = await app.inject({
    method: 'POST', url: '/auth/verify', payload: { wallet, signature },
  });
  return verified.cookies.find((entry) => entry.name === SESSION_COOKIE)!.value;
}

async function seedStableDeed(
  valley: { id: string; siteId: number },
  fillIndex: number,
  label: string,
  opts: {
    paid?: boolean;
    status?: 'active' | 'inactive';
    slot?: 'active' | 'inactive' | 'missing' | 'wrong-owner';
  } = {},
): Promise<SeededDeed> {
  const player = await createTestPlayer(db);
  const name = `VIEWPORT_${label}_${randomUUID().slice(0, 8)}`;
  const avatarGeneration = randomUUID();
  await db.update(players).set({
    name,
    // Deliberately differs from the stable base value: the DTO must read the
    // deed/base Keep, not a retained legacy player scalar.
    keepLevel: 1,
    avatarHash: 'd'.repeat(64),
    avatarGeneration,
  }).where(eq(players.wallet, player.wallet));
  const [base] = await db.insert(bases).values({
    ownerWallet: player.wallet,
    keepLevel: 7,
    status: opts.status ?? 'active',
    landPaidAt: opts.paid === false ? null : new Date('2026-08-14T00:00:00Z'),
  }).returning({ id: bases.id });

  if (opts.slot !== 'missing') {
    let slotWallet = player.wallet;
    if (opts.slot === 'wrong-owner') slotWallet = (await createTestPlayer(db)).wallet;
    await db.insert(baseSlots).values({
      wallet: slotWallet,
      slot: 1,
      baseId: base!.id,
      active: opts.slot !== 'inactive',
    });
  }

  const tile = tileOfFillIndex(fillIndex);
  await seedPlot(db, {
    valleyId: valley.id,
    x: tile.x,
    y: tile.y,
    playerWallet: player.wallet,
    baseId: base!.id,
  });
  const [plot] = await db.select({ earthCell: plots.earthCell }).from(plots)
    .where(eq(plots.baseId, base!.id));
  return {
    wallet: player.wallet,
    baseId: base!.id,
    earthCell: requiredFixture(plot!.earthCell),
    name,
    avatarGeneration,
  };
}

function rectForTwo(a: number, b: number): EarthViewportRect {
  const ax = a % GLOBE.fineCols;
  const bx = b % GLOBE.fineCols;
  const ay = Math.floor(a / GLOBE.fineCols);
  const by = Math.floor(b / GLOBE.fineCols);
  const lo = Math.min(ax, bx), hi = Math.max(ax, bx);
  const directWidth = hi - lo + 1;
  const wrappedWidth = GLOBE.fineCols - hi + lo + 1;
  return {
    x0: wrappedWidth < directWidth ? hi : lo,
    x1: wrappedWidth < directWidth ? lo : hi,
    y0: Math.min(ay, by),
    y1: Math.max(ay, by),
  };
}

function area(rect: EarthViewportRect): number {
  const width = rect.x0 <= rect.x1
    ? rect.x1 - rect.x0 + 1
    : GLOBE.fineCols - rect.x0 + rect.x1 + 1;
  return width * (rect.y1 - rect.y0 + 1);
}

/** Choose the closest real cells across two independently stored valley patches,
 * so the test proves one response crosses valley identity without assuming where
 * a concurrently allocated test site happens to fall on Earth. */
function closestPair(
  firstSite: number, secondSite: number,
): { firstIndex: number; secondIndex: number; rect: EarthViewportRect } {
  const first = patchCells(firstSite);
  const second = patchCells(secondSite);
  let best: { firstIndex: number; secondIndex: number; rect: EarthViewportRect } | null = null;
  for (let i = 0; i < first.length; i++) {
    for (let j = 0; j < second.length; j++) {
      const rect = rectForTwo(first[i]!, second[j]!);
      const width = rect.x0 <= rect.x1
        ? rect.x1 - rect.x0 + 1
        : GLOBE.fineCols - rect.x0 + rect.x1 + 1;
      const height = rect.y1 - rect.y0 + 1;
      if (width > GLOBE.parcelViewportMaxSpanCells
        || height > GLOBE.parcelViewportMaxSpanCells
        || area(rect) > GLOBE.parcelViewportMaxCells) continue;
      if (!best || area(rect) < area(best.rect)) best = { firstIndex: i, secondIndex: j, rect };
    }
  }
  if (!best) throw new Error('test valleys have no shared bounded Earth viewport');
  return best;
}

const queryOf = (rect: EarthViewportRect): string => new URLSearchParams({
  x0: String(rect.x0), x1: String(rect.x1), y0: String(rect.y0), y1: String(rect.y1),
}).toString();

const exactCellRect = (cell: number): EarthViewportRect => ({
  x0: cell % GLOBE.fineCols,
  x1: cell % GLOBE.fineCols,
  y0: Math.floor(cell / GLOBE.fineCols),
  y1: Math.floor(cell / GLOBE.fineCols),
});

const authedGet = (rect: EarthViewportRect) => app.inject({
  method: 'GET',
  url: `/globe/parcels?${queryOf(rect)}`,
  cookies: { [SESSION_COOKIE]: cookie },
});

/** The same read, ranked from an explicit viewer centre (D-097 `cx`/`cy`). */
const authedGetAt = (rect: EarthViewportRect, at: { lon: number; lat: number }) => app.inject({
  method: 'GET',
  url: `/globe/parcels?${queryOf(rect)}&cx=${at.lon}&cy=${at.lat}`,
  cookies: { [SESSION_COOKIE]: cookie },
});

// ---------------------------------------------------------------------------
// The marker cap (D-097): a window denser than parcelViewportMaxMarkers
// ---------------------------------------------------------------------------

/**
 * 33 × 32 fine cells of open South Pacific (130°W–113.5°W, 40°S–56°S): 1,056
 * cells, 32 over the cap. OCEAN ON PURPOSE — no land on the fine mask means no
 * real parcel can ever be seated here (the parcel stream is land only), so every
 * base the cap tests see is one they seeded and `matched` can be asserted EXACTLY
 * on a database every suite shares. Seeded directly rather than through
 * `seedPlots`, which rightly insists on real land: the cap is about COUNT and
 * DISTANCE, not about where Earth seats a deed.
 */
const DENSE: EarthViewportRect = { x0: 100, x1: 132, y0: 260, y1: 291 };
const denseCell = (x: number, y: number): number => y * GLOBE.fineCols + x;
const DENSE_CELLS: number[] = [];
for (let y = DENSE.y0; y <= DENSE.y1; y++) {
  for (let x = DENSE.x0; x <= DENSE.x1; x++) DENSE_CELLS.push(denseCell(x, y));
}
const denseName = (cell: number): string => `DENSE_${cell}`;

/** Km from a point to a cell's centre — the spec's metric, from shared. */
const kmTo = (from: { lon: number; lat: number }, cell: number): number => {
  const at = fineCellCentreDeg(cell);
  return greatCircleKm(from.lon, from.lat, at.lon, at.lat);
};

/** What the server must answer: nearest first, lowest cell on a tie, `cap` kept. */
const nearestOf = (
  from: { lon: number; lat: number }, cells: readonly number[], cap: number,
): number[] => [...cells].sort((a, b) => kmTo(from, a) - kmTo(from, b) || a - b).slice(0, cap);

const denseValleys: Array<{ id: string; siteId: number }> = [];

/** One paid, active, slotted base per cell, inserted in the given order. */
async function seedDense(cells: readonly number[]): Promise<void> {
  const rows = cells.map((cell, i) => ({
    cell,
    wallet: randomWallet(),
    baseId: randomUUID(),
    valley: denseValleys[Math.floor(i / 500)]!,
    x: i % 25,
    y: Math.floor((i % 500) / 25),
  }));
  await db.insert(players).values(rows.map((r) => ({ wallet: r.wallet, name: denseName(r.cell) })));
  await db.insert(bases).values(rows.map((r) => ({
    id: r.baseId, ownerWallet: r.wallet, keepLevel: 1, status: 'active' as const,
    landPaidAt: new Date('2026-09-02T00:00:00Z'),
  })));
  await db.insert(baseSlots).values(rows.map((r) => ({
    wallet: r.wallet, slot: 1, baseId: r.baseId, active: true,
  })));
  await db.insert(plots).values(rows.map((r) => ({
    valleyId: r.valley.id, x: r.x, y: r.y, playerWallet: r.wallet, baseId: r.baseId,
    earthCell: r.cell, countryA3: 'ZZZ',
  })));
}

/** Remove every base seeded in the window — this run's, or a crashed run's. */
async function wipeDense(): Promise<void> {
  const seeded = await db.select({ baseId: plots.baseId, wallet: plots.playerWallet }).from(plots)
    .where(inArray(plots.earthCell, DENSE_CELLS));
  if (seeded.length === 0) return;
  const baseIds = seeded.flatMap((r) => (r.baseId ? [r.baseId] : []));
  const wallets = seeded.flatMap((r) => (r.wallet ? [r.wallet] : []));
  await db.delete(plots).where(inArray(plots.earthCell, DENSE_CELLS));
  if (baseIds.length > 0) {
    await db.delete(baseSlots).where(inArray(baseSlots.baseId, baseIds));
    await db.delete(bases).where(inArray(bases.id, baseIds));
  }
  if (wallets.length > 0) {
    // Base deletion captures its final ownership state. Remove this fixture's
    // evidence after deleting bases, before deleting the referenced wallets.
    await db.delete(playerActionEvents).where(inArray(playerActionEvents.wallet, wallets));
    await db.delete(playerActivityDays).where(inArray(playerActivityDays.wallet, wallets));
    await db.delete(players).where(inArray(players.wallet, wallets));
  }
}

let firstValley: { id: string; siteId: number };
let secondValley: { id: string; siteId: number };
let first: SeededDeed;
let second: SeededDeed;
let sharedRect: EarthViewportRect;

beforeAll(async () => {
  process.env['FREE_ONBOARDING'] = 'true';
  // Avoid process-wide stable-observer readiness during app construction; this
  // read route consumes the live stable flag only when its query runs.
  process.env['MULTI_BASE_ENABLED'] = 'false';
  app = await buildApp(TEST_CONFIG, db);
  await app.ready();
  cookie = await signIn();
  process.env['MULTI_BASE_ENABLED'] = 'true';

  firstValley = await createTestValley(db, { name: `VIEWPORT A ${randomUUID()}` });
  secondValley = await createTestValley(db, { name: `VIEWPORT B ${randomUUID()}` });
  const pair = closestPair(firstValley.siteId, secondValley.siteId);
  sharedRect = pair.rect;
  first = await seedStableDeed(firstValley, pair.firstIndex, 'FIRST');
  second = await seedStableDeed(secondValley, pair.secondIndex, 'SECOND');
});

afterAll(async () => {
  // Leave no dense window behind: 1,056 bases would tilt every relative count
  // another suite makes against this shared database.
  await wipeDense();
  if (denseValleys.length > 0) {
    await db.delete(valleys).where(inArray(valleys.id, denseValleys.map((v) => v.id)));
  }
  if (app) await app.close();
  await conn.sql.end();
  if (priorFreeOnboarding === undefined) delete process.env['FREE_ONBOARDING'];
  else process.env['FREE_ONBOARDING'] = priorFreeOnboarding;
  if (priorMultiBase === undefined) delete process.env['MULTI_BASE_ENABLED'];
  else process.env['MULTI_BASE_ENABLED'] = priorMultiBase;
});

describe('GET /globe/parcels', () => {
  it('is authenticated and returns exact minimal identities across valleys', async () => {
    const anonymous = await app.inject({
      method: 'GET', url: `/globe/parcels?${queryOf(sharedRect)}`,
    });
    expect(anonymous.statusCode).toBe(401);

    const response = await app.inject({
      method: 'GET',
      url: `/globe/parcels?${queryOf(sharedRect)}&baseId=${first.baseId}`,
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    const body = response.json() as {
      scope: EarthViewportRect;
      markers: Array<Record<string, unknown>>;
      truncated: boolean;
      matched: number;
    };
    expect(body.scope).toEqual(sharedRect);
    // A window under the cap is complete and says so: nothing was cut, and the
    // count the rect really holds is the count on the wire (D-097).
    expect(body.truncated).toBe(false);
    expect(body.matched).toBe(body.markers.length);
    const ours = body.markers.filter((marker) => (
      marker['earthCell'] === first.earthCell || marker['earthCell'] === second.earthCell
    ));
    expect(ours).toHaveLength(2);
    for (const marker of ours) {
      expect(Object.keys(marker).sort()).toEqual([
        'avatarUrl', 'earthCell', 'keepLevel', 'name',
      ]);
      expect(marker['keepLevel']).toBe(7);
      const deed = marker['earthCell'] === first.earthCell ? first : second;
      expect(marker).toEqual({
        earthCell: deed.earthCell,
        name: deed.name,
        avatarUrl: `/api/avatars/${deed.avatarGeneration}.webp`,
        keepLevel: 7,
      });
    }
    const wire = response.body;
    for (const deed of [first, second]) {
      expect(wire).not.toContain(deed.wallet);
      expect(wire).not.toContain(deed.baseId);
    }
    expect(wire).not.toContain('d'.repeat(64));
    for (const forbidden of [
      'shielded', 'trophies', 'online', 'presence', 'wallet', 'baseId', 'x', 'y',
    ]) expect(ours.every((marker) => marker[forbidden] === undefined)).toBe(true);
  });

  it('repeats D-040 active + paid + active owner-slot eligibility', async () => {
    const fixtures = [
      await seedStableDeed(firstValley, 480, 'UNPAID', { paid: false }),
      await seedStableDeed(firstValley, 481, 'INACTIVE', { status: 'inactive' }),
      await seedStableDeed(firstValley, 482, 'SLOT_INACTIVE', { slot: 'inactive' }),
      await seedStableDeed(firstValley, 483, 'UNSLOTTED', { slot: 'missing' }),
      await seedStableDeed(firstValley, 484, 'WRONG_OWNER', { slot: 'wrong-owner' }),
    ];
    for (const hidden of fixtures) {
      const response = await authedGet(exactCellRect(hidden.earthCell));
      expect(response.statusCode).toBe(200);
      // An ineligible deed is not "matched and cut" — it is not there at all.
      expect(response.json()).toEqual({
        scope: exactCellRect(hidden.earthCell),
        markers: [],
        truncated: false,
        matched: 0,
      });
    }
  });

  it('requires an Earth valley even when another planet reuses an Earth cell id', async () => {
    await db.update(valleys).set({ planetId: 31_000 }).where(eq(valleys.id, secondValley.id));
    try {
      expect((await authedGet(exactCellRect(second.earthCell))).json()).toEqual({
        scope: exactCellRect(second.earthCell),
        markers: [],
        truncated: false,
        matched: 0,
      });
    } finally {
      await db.update(valleys).set({ planetId: 0 }).where(eq(valleys.id, secondValley.id));
    }
  });

  it('accepts an antimeridian-wrapping bbox and rejects malformed/oversized boxes', async () => {
    const wrapped: EarthViewportRect = { x0: 718, x1: 1, y0: 10, y1: 11 };
    expect(earthViewportCellRanges(wrapped)).toEqual([
      { min: 10 * GLOBE.fineCols + 718, max: 10 * GLOBE.fineCols + 719 },
      { min: 10 * GLOBE.fineCols, max: 10 * GLOBE.fineCols + 1 },
      { min: 11 * GLOBE.fineCols + 718, max: 11 * GLOBE.fineCols + 719 },
      { min: 11 * GLOBE.fineCols, max: 11 * GLOBE.fineCols + 1 },
    ]);
    expect((await authedGet(wrapped)).statusCode).toBe(200);
    // A wrapped box ranks from the MIDDLE of the box (the antimeridian here), not
    // from the far side of the planet — the default centre wraps as the ranges do.
    expect(earthViewportCentreDeg(wrapped)).toEqual({ lon: -180, lat: 84.5 });

    const invalid = [
      'x0=-1&x1=0&y0=0&y1=0',
      `x0=0&x1=${GLOBE.fineCols}&y0=0&y1=0`,
      'x0=0&x1=0&y0=2&y1=1',
      `x0=0&x1=${GLOBE.parcelViewportMaxSpanCells}&y0=0&y1=0`,
      'x0=0&x1=64&y0=0&y1=63',
      // A viewer centre is a PAIR of real degrees (D-097): half of one is a client
      // bug, and a longitude past 180 or a latitude past 90 is not on the planet.
      'x0=0&x1=0&y0=0&y1=0&cx=1',
      'x0=0&x1=0&y0=0&y1=0&cy=1',
      'x0=0&x1=0&y0=0&y1=0&cx=181&cy=0',
      'x0=0&x1=0&y0=0&y1=0&cx=0&cy=-91',
      'x0=0&x1=0&y0=0&y1=0&cx=west&cy=0',
    ];
    for (const query of invalid) {
      const response = await app.inject({
        method: 'GET',
        url: `/globe/parcels?${query}`,
        cookies: { [SESSION_COOKIE]: cookie },
      });
      expect(response.statusCode, query).toBe(400);
    }
  });
});

describe('GET /globe/parcels — the marker cap (D-097)', () => {
  it('caps a dense window at parcelViewportMaxMarkers nearest the centre and flags truncation', async () => {
    // WHY (owner 2026-09-02, D-097): "even if we have all 59,000 bases minted".
    // D-042 bounds the RECT (4,096 cells), not the answer: a full window is 4,096
    // markers, four times what a phone draws in a frame. The cut must (1) keep
    // the bases under the viewer's thumb — nearest the centre, not whichever cell
    // ids sort first — (2) SAY it cut, with the true count, so the client never
    // draws a window that looks complete and is not, and (3) be a pure function
    // of the set: a reload of an unchanged window must not swap markers in and
    // out at the cap's edge.
    for (const cell of DENSE_CELLS) {
      expect(isLandCell(EARTH_FINE, cell), `cell ${cell} must be ocean`).toBe(false);
    }
    expect(DENSE_CELLS).toHaveLength(GLOBE.parcelViewportMaxMarkers + 32);
    expect(earthViewportCellRanges(DENSE)).toHaveLength(32);
    for (let i = 0; i < 3; i++) {
      denseValleys.push(await createTestValley(db, { name: `VIEWPORT DENSE ${i} ${randomUUID()}` }));
    }
    await wipeDense();
    await seedDense(DENSE_CELLS);

    const response = await authedGet(DENSE);
    expect(response.statusCode).toBe(200);
    const body = response.json() as ViewportParcels;
    expect(body.matched).toBe(DENSE_CELLS.length);
    expect(body.truncated).toBe(true);
    expect(body.markers).toHaveLength(GLOBE.parcelViewportMaxMarkers);

    // No cx/cy sent, so the rank is from the rect's own centre. The cell under
    // that centre is kept, the four corners — farthest from it — are cut, no kept
    // base is farther than any cut one, and the list is nearest-first, so a
    // client that draws the head of the list first draws the middle of the
    // window first.
    const centre = earthViewportCentreDeg(DENSE);
    expect(centre).toEqual({ lon: -121.75, lat: -48 });
    const kept = body.markers.map((m) => m.earthCell);
    const keptSet = new Set(kept);
    const cut = DENSE_CELLS.filter((c) => !keptSet.has(c));
    expect(cut).toHaveLength(32);
    expect(keptSet.has(denseCell(116, 275))).toBe(true);
    for (const corner of [
      denseCell(100, 260), denseCell(132, 260), denseCell(100, 291), denseCell(132, 291),
    ]) expect(keptSet.has(corner), `corner ${corner} is farthest and must be cut`).toBe(false);
    expect(Math.max(...kept.map((c) => kmTo(centre, c))))
      .toBeLessThanOrEqual(Math.min(...cut.map((c) => kmTo(centre, c))));
    expect(kept).toEqual(nearestOf(centre, DENSE_CELLS, GLOBE.parcelViewportMaxMarkers));
    for (const marker of body.markers) {
      expect(marker).toEqual({
        earthCell: marker.earthCell, name: denseName(marker.earthCell), avatarUrl: null, keepLevel: 1,
      });
    }

    // The same window seeded in the reverse order answers byte-for-byte the same:
    // the cut is a function of the set, never of insertion or row order.
    await wipeDense();
    await seedDense([...DENSE_CELLS].reverse());
    expect((await authedGet(DENSE)).json()).toEqual(body);
  });

  it('cx/cy outside the rect still order deterministically', async () => {
    // WHY: the client fetches up to parcelViewportMaxRequests tiles around ONE
    // camera, so a tile at the edge of the footprint is ranked from a centre that
    // is not inside it — and across the antimeridian that centre is 60° of
    // longitude away in the "wrong" direction. The rank must still be distance to
    // THAT point (no clamping to the rect, no fallback to the rect centre), and
    // identical on every repeat: the cut edge of a window must not flicker
    // between two loads.
    expect(DENSE_CELLS.length).toBeGreaterThan(GLOBE.parcelViewportMaxMarkers); // seeded above

    // North-east of the window: the NE corner is the single nearest cell, the SW
    // corner the farthest, and the 32 cut are the far corner's neighbourhood.
    const ne = { lon: -100, lat: -20 };
    const first = (await authedGetAt(DENSE, ne)).json() as ViewportParcels;
    expect(first.matched).toBe(DENSE_CELLS.length);
    expect(first.truncated).toBe(true);
    expect(first.markers).toHaveLength(GLOBE.parcelViewportMaxMarkers);
    expect(first.markers[0]!.earthCell).toBe(denseCell(132, 260));
    const keptNe = first.markers.map((m) => m.earthCell);
    expect(keptNe).not.toContain(denseCell(100, 291));
    expect(keptNe).toEqual(nearestOf(ne, DENSE_CELLS, GLOBE.parcelViewportMaxMarkers));
    expect((await authedGetAt(DENSE, ne)).json()).toEqual(first);

    // Due west ACROSS the antimeridian (170°E is 60° west of the window's west
    // edge, at the window's mid-latitude): the rank wrapped, so the west edge
    // comes first and the NE corner is cut. And it is a GREAT-CIRCLE rank: the
    // nearest cell is the west edge's POLEWARD end (4,104 km), not the cell on the
    // viewer's own parallel (4,300 km) — a geodesic 60° of longitude away bends
    // toward the pole, which a flat Δlon rank would get wrong and the client's
    // globe (which draws real great circles) would visibly disagree with.
    const west = { lon: 170, lat: -47.75 };
    const second = (await authedGetAt(DENSE, west)).json() as ViewportParcels;
    const keptWest = second.markers.map((m) => m.earthCell);
    expect(keptWest[0]).toBe(denseCell(100, 291));
    expect(kmTo(west, denseCell(100, 291))).toBeLessThan(kmTo(west, denseCell(100, 275)));
    expect(keptWest).not.toContain(denseCell(132, 260));
    expect(keptWest).toEqual(nearestOf(west, DENSE_CELLS, GLOBE.parcelViewportMaxMarkers));
    expect(keptWest).not.toEqual(keptNe);
    expect((await authedGetAt(DENSE, west)).json()).toEqual(second);
  });
});
