/**
 * READ-ONLY CROSS-VALLEY VISITS — the privacy surface (owner decision 2,
 * 2026-08-09; docs/WORLDMAP-GLOBE-PLAN.md P4 and its SILHOUETTE PRIVACY risk).
 *
 * The globe is explorable: zoom a distant valley and you see its shape and its
 * name plus every occupied parcel's frozen earthCell and minimal public profile
 * identity. Loot/shield/actions still require the separate land-gated/rate-
 * limited detail endpoint. It is tested adversarially
 * rather than descriptively. `GET /map?valleyId=` already accepted ANY valley id
 * before the globe existed and served it exactly like your own — full markers with
 * wallet + name for everyone inside your trophy window, plus every PvE camp id.
 * A client that walked valley ids therefore had a roster scraper: MAP-SCALE-PLAN
 * L8's plot-id-walking concern, from the other end. These tests pin exactly what
 * the bulk visit may learn and ensure identity still requires explicit inspection.
 */
import { randomUUID } from 'node:crypto';
import { PVE, pvpAttackAllowed, WORLD } from '@shardkeep/shared';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { players, plots, pveCamps, valleys } from '../src/db/schema';
import { ensurePlotAssigned, getMapChunk, makeCampSnapshot } from '../src/game/world';
import { mapCacheLoads, resetMapCache } from '../src/lib/mapCache';
import { connectTestDb, createTestPlayer, createTestValley, randomWallet, seedPlot } from './helpers';

const conn = connectTestDb();
const db = conn.db;

const WHOLE_VALLEY = { x0: 0, y0: 0, x1: WORLD.gridCols - 1, y1: WORLD.gridRows - 1 };

afterAll(async () => { await conn.sql.end(); });

/** Someone else's valley, populated with NAMED neighbours who are all inside the
 *  visitor's trophy window — i.e. the exact rows the old code shipped in full. */
async function foreignValley(label: string, trophies: number) {
  const v = await createTestValley(db, {
    name: `${label} VALE`, createdAt: new Date('2000-01-03T00:00:00Z'),
  });
  const valleyId = v.id;
  const wallets: string[] = [];
  const names: string[] = [];
  const avatarGenerations: string[] = [];
  for (let i = 0; i < 3; i++) {
    const wallet = randomWallet();
    const name = `${label}_RESIDENT_${i}`;
    wallets.push(wallet);
    names.push(name);
    const avatarGeneration = randomUUID();
    avatarGenerations.push(avatarGeneration);
    await db.insert(players).values({
      wallet, name, trophies, keepLevel: 4, entryPaidAt: new Date(),
      avatarHash: 'b'.repeat(64), avatarGeneration,
    });
    await seedPlot(db, { valleyId, x: i, y: 0, playerWallet: wallet });
  }
  const [camp] = await db.insert(pveCamps).values({
    valleyId, x: 10, y: 10, tier: 1,
    snapshot: makeCampSnapshot(1), lootKeep: BigInt(PVE.bountyByTier[0]!),
  }).returning();
  return { valleyId, wallets, names, avatarGenerations, campId: camp!.id };
}

describe('read-only valley visits', () => {
  it('hands a visitor minimal deed profiles — never wallet or gameplay state', async () => {
    // WHY: this is the whole disclosure. A silhouette says "a keep of about this
    // size stands here", which is what makes the planet legible; a wallet or a
    // username/avatar are now deliberate public profile fields; wallet and
    // gameplay state remain outside the scrapeable bulk response.
    const visitor = await createTestPlayer(db);
    await db.update(players).set({ trophies: 300 }).where(eq(players.wallet, visitor.wallet));
    await ensurePlotAssigned(db, visitor.wallet); // the visitor lives SOMEWHERE ELSE

    // Same Keep (K1) as the visitor, so every one of them clears the D-099 raid
    // gate: before the visit branch these came back as FULL markers with wallet
    // + name.
    const foreign = await foreignValley('VISIT', 300);
    expect(pvpAttackAllowed(1, 1)).toBe(true);

    resetMapCache();
    const res = await getMapChunk(db, visitor.wallet, { ...WHOLE_VALLEY, valleyId: foreign.valleyId });

    expect(res.visiting).toBe(true);
    expect(res.valleyName).toBe('VISIT VALE'); // the name IS the point of visiting
    expect(res.markers.length).toBe(3);
    for (const m of res.markers) {
      expect(m.kind).toBe('silhouette');
      // The exact key set, not just "no wallet": a future field added to the
      // shared roster row must not ride along into a stranger's payload.
      expect(Object.keys(m).sort()).toEqual([
        'avatarUrl', 'earthCell', 'keepLevel', 'kind', 'name', 'trophies', 'x', 'y',
      ]);
    }

    const body = JSON.stringify(res);
    for (const w of foreign.wallets) expect(body).not.toContain(w);
    for (const n of foreign.names) expect(body).toContain(n);
    for (const generation of foreign.avatarGenerations) {
      expect(body).toContain(`/api/avatars/${generation}.webp`);
    }
    expect(body).not.toContain('b'.repeat(64));
  });

  it('keeps the bulk visit free of direct target wallets and camp ids', async () => {
    // WHY: the frozen earthCell is deliberately actionable through the separate,
    // land-gated and rate-limited parcel-detail route. The BULK visit must still
    // contain no wallet list and no camp id: createPveRaid does NOT check that a
    // camp is in the attacker's valley, so shipping foreign ids would hand out
    // three free bounties a day in somebody else's back yard.
    const visitor = await createTestPlayer(db);
    await ensurePlotAssigned(db, visitor.wallet);
    const foreign = await foreignValley('NOTARGET', 500);

    resetMapCache();
    const res = await getMapChunk(db, visitor.wallet, { ...WHOLE_VALLEY, valleyId: foreign.valleyId });

    expect(res.recommended).toEqual([]);
    expect(res.markers.some((m) => m.kind === 'pve')).toBe(false);
    expect(JSON.stringify(res)).not.toContain(foreign.campId);
  });

  it('walking the grid yields public profiles but still no wallet identities', async () => {
    // WHY: the obvious attack on a bounded payload is to ask for many small rects
    // and stitch the answers together. The visit rule is per-REQUEST-KIND, not per
    // rect size, so a pinhole request has the same minimal field floor as a whole valley.
    const visitor = await createTestPlayer(db);
    await ensurePlotAssigned(db, visitor.wallet);
    const foreign = await foreignValley('WALK', 300);

    resetMapCache();
    for (let x = 0; x < 3; x++) {
      const res = await getMapChunk(db, visitor.wallet, { valleyId: foreign.valleyId, x0: x, y0: 0, x1: x, y1: 0 });
      expect(res.visiting).toBe(true);
      expect(res.markers.every((m) => m.kind === 'silhouette')).toBe(true);
      const body = JSON.stringify(res);
      for (const w of foreign.wallets) expect(body).not.toContain(w);
      expect(body).toContain(foreign.names[x]);
    }
  });

  it('a VISIT never signs the visitor up — a read must not mint a plot', async () => {
    // WHY: this was an amplification vector, not a style point. Settling "is this my
    // valley?" used to call ensurePlotAssigned, which for a caller with no plot
    // escalates a GET into the FOR UPDATE signup transaction — it takes the newest
    // valley's row lock, scans up to WORLD.valleyCapacity plots, and INSERTs. So
    // `GET /map?valleyId=<any uuid>` was the cheapest way to make the server do the
    // single most contended write in the game (the documented launch-day cliff),
    // from a read path, repeatedly. Membership now comes from the roster already in
    // hand: not on it and you named a valley ⇒ you are a visitor.
    const visitor = await createTestPlayer(db); // deliberately plot-less
    const foreign = await foreignValley('NOSIGNUP', 300);
    const valleysBefore = (await db.select().from(valleys)).length;

    resetMapCache();
    const res = await getMapChunk(db, visitor.wallet, { ...WHOLE_VALLEY, valleyId: foreign.valleyId });

    expect(res.visiting).toBe(true);
    expect(await db.select().from(plots).where(eq(plots.playerWallet, visitor.wallet))).toEqual([]);
    expect((await db.select().from(valleys)).length).toBe(valleysBefore);
  });

  it('id-walking gains nothing and costs one cold load per DISTINCT id', async () => {
    // WHY: the visit branch is the one place a caller chooses which valley the server
    // loads, so it is the natural enumeration surface. Two things make walking it
    // pointless, and both are pinned here rather than assumed:
    //  1. There is nothing to find. Valley ids are UUIDv4 (122 random bits), so they
    //     cannot be guessed; an id that is not a valley answers 200 with a generic
    //     name, no markers and no side effects — no row is created, so a walk cannot
    //     even pollute the world it is probing. (The only cheap SOURCE of valley ids
    //     is GET /globe/sector/:id, which is valley-level aggregates by design.)
    //  2. What it costs is bounded and metered. A probe of a NEW id is exactly one
    //     cold roster load; a repeat probe is zero, because the first one populated
    //     mapCache. That is why the /map limiter meters cold opens
    //     (WORLD.mapVisitOpenRateLimitPerMin) and not requests — see
    //     test/map-rate-limit.test.ts.
    const visitor = await createTestPlayer(db);
    await ensurePlotAssigned(db, visitor.wallet);
    const notAValley = crypto.randomUUID();
    const valleysBefore = (await db.select().from(valleys)).length;

    resetMapCache();
    const before = mapCacheLoads();
    const res = await getMapChunk(db, visitor.wallet, { ...WHOLE_VALLEY, valleyId: notAValley });
    expect(res.visiting).toBe(true);
    expect(res.markers).toEqual([]);
    expect(res.recommended).toEqual([]);
    expect(mapCacheLoads() - before).toBe(1);

    // A second probe of the same id is free — the cost is per DISTINCT id, which is
    // the unit the rate limiter charges for.
    await getMapChunk(db, visitor.wallet, { ...WHOLE_VALLEY, valleyId: notAValley });
    expect(mapCacheLoads() - before).toBe(1);

    // And probing invented ids must never be a write.
    expect((await db.select().from(valleys)).length).toBe(valleysBefore);
    expect(await db.select().from(plots).where(eq(plots.valleyId, notAValley))).toEqual([]);
  });

  it('YOUR OWN valley is unchanged — asking for it by id is not a visit', async () => {
    // WHY: the regression this rule could cause. The client identifies its own
    // valley by id and passes it back; if that read were treated as a visit, the
    // player would lose their own keep, their target list and every nametag.
    const mine = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, mine.wallet));
    const { valleyId } = await ensurePlotAssigned(db, mine.wallet);

    resetMapCache();
    const res = await getMapChunk(db, mine.wallet, { ...WHOLE_VALLEY, valleyId });
    expect(res.visiting).toBe(false);
    const own = res.markers.find((m) => m.kind === 'player' && m.wallet === mine.wallet);
    expect(own, 'your own keep must still ship in full').toBeDefined();
  });
});
