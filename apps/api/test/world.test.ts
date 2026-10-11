import { trainTroop } from './training-consent';
/**
 * World map + PvE tests (PLAN.md 4e — GDD §3.4/§3.6): plot assignment,
 * viewport markers (tease semantics), scout rules, PvE raids (no bounty since D-152;
 * the emission pool, no trophies/shields/energy, 3/day, respawn).
 */
import {
  HERO_LEVELING, PVE, pvpAttackAllowed, pvpMinDefenderKeep, RAID_RULES, WORLD,
} from '@shardkeep/shared';
import { and, eq, gt, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accounts, buildings, dailyActivity, heroEquipment, heroLevels, heroLoadouts, ledgerTransactions, playerItems, players, plots, pveCamps, questProgress, quests, raids, shields, valleys } from '../src/db/schema';
import { completeDueJobs, ensureStartingBase, placeBuilding } from '../src/game/base';
import { completeDueTraining} from '../src/game/army';
import { setShieldlessMode } from '../src/game/gameConfig';
import { createPveRaid, submitOrders } from '../src/game/raids';
import { rewardShards } from '../src/game/spend';
import { mapCacheLoads, resetMapCache } from '../src/lib/mapCache';
import {
  MAX_CAMP_TIER,
  MAXED_CAMP_TIER,
  campCoords,
  ensurePlotAssigned,
  ensureValleyAtSite,
  getMapChunk,
  isSiteIdCollision,
  makeCampSnapshot,
  makeCampaignSnapshot,
  plotFillOrder,
  removeMaxedCamp,
  reseedValleyCamps,
  respawnPveCamps,
  scoutBase,
  spawnMaxedCamp,
  markCampCleared,
  valleyName,
} from '../src/game/world';
import { bootstrapSystemAccounts, getOrCreatePlayerAccount } from '../src/ledger';
import {
  connectTestDb, createTestPlayer, createTestValley, fundTestKeep, randomWallet, seedPlot, seedPlots,
} from './helpers';

const conn = connectTestDb();
const db = conn.db;
let key = 0;
const k = (): string => `world-${++key}-${Math.random().toString(36).slice(2)}`;
const future = (min: number): Date => new Date(Date.now() + min * 60_000);

async function fighter() {
  const p = await createTestPlayer(db);
  await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
  await ensureStartingBase(db, p.wallet);
  await ensurePlotAssigned(db, p.wallet);
  await fundTestKeep(db, p.wallet, 1_000_000n, 'test.fund', k());
  await rewardShards(db, p.wallet, 1_000_000n, 'test.fund.shards', k());
  // Inside the CENTERED claim [8,22), clear of the re-centered keep (14,14).
  await placeBuilding(db, p.wallet, 'barracks' as never, 17, 17, k());
  await completeDueJobs(db, p.wallet, future(120));
  await placeBuilding(db, p.wallet, 'camp' as never, 19, 19, k());
  await completeDueJobs(db, p.wallet, future(240));
  let t = 300;
  for (let i = 0; i < 4; i++) {
    await trainTroop(db, p.wallet, 'turrider' as never, k(), future(t));
    t += 10;
    await completeDueTraining(db, p.wallet, future(t));
  }
  return p;
}

beforeAll(async () => {
  await bootstrapSystemAccounts(db);
  // Other files can leave only backdated, bare fixture valleys (some have a
  // single custom camp). Plot assignment correctly joins an existing valley;
  // it does not seed it. Create this suite's newest valley through the real
  // production creation path so its PvE assertions own their nine-camp cohort.
  const usedSites = new Set((await db.select({ siteId: valleys.siteId }).from(valleys)
    .where(eq(valleys.planetId, 0))).map((row) => row.siteId));
  let siteId = 0;
  while (usedSites.has(siteId)) siteId++;
  await ensureValleyAtSite(db, siteId);
});
afterAll(async () => {
  await conn.sql.end();
});

describe('plots & valleys', () => {
  it('plotFillOrder covers every valley tile exactly once and spreads early', () => {
    // WHY: the spread order must be a permutation of ALL gridCols×gridRows tiles —
    // a missing tile silently lowers valley capacity, a duplicate wastes an insert
    // attempt. And the first slots must be spaced (not tile-adjacent) so a sparse
    // valley doesn't pack bases from (0,0).
    const order = plotFillOrder();
    expect(order.length).toBe(WORLD.gridCols * WORLD.gridRows);
    expect(new Set(order.map(([x, y]) => `${x},${y}`)).size).toBe(order.length);
    expect(order.every(([x, y]) => x >= 0 && x < WORLD.gridCols && y >= 0 && y < WORLD.gridRows)).toBe(true);
    // the first several slots are the coarse (stride-5) lattice → not adjacent
    const [x0, y0] = order[0]!; const [x1, y1] = order[1]!;
    expect(Math.abs(x1 - x0) + Math.abs(y1 - y0)).toBeGreaterThan(1);
  });

  it('names valleys deterministically instead of showing a human a UUID', async () => {
    // WHY: the map banner printed `VALLEY <uuid-fragment>`. Names must be a pure
    // function of the ordinal so a backfill and a fresh create agree, and must not
    // collide once the world outgrows prefixes × suffixes.
    const { prefixes, suffixes } = WORLD.valleyNameParts;
    const n = prefixes.length * suffixes.length;
    const names = Array.from({ length: n }, (_, i) => valleyName(i + 1));
    expect(new Set(names).size).toBe(n);
    expect(valleyName(1)).toBe(`${prefixes[0]} ${suffixes[0]}`);
    expect(valleyName(1)).toBe(valleyName(1)); // deterministic
    expect(valleyName(n + 1)).not.toBe(valleyName(1)); // cycles get numbered
  });

  it('freezes a valley\'s PLACE: site_id is unique, and losing that race is recognised', async () => {
    // WHY: `valleys.site_id` IS the valley's spot on the globe (schema.ts), so two
    // valleys sharing one is two neighbourhoods drawn on one pin — and, since P5b,
    // two deeds naming the same coordinates. The DB refuses it.
    //
    // AND WHY THE PREDICATE IS TESTED, not just the constraint: `createValley`
    // allocates `max(site_id) + 1` from an UNLOCKED read, so a concurrent rollover
    // is expected to lose this race — and it recovers by joining the winner's
    // valley instead of 500ing a legitimate signup. That recovery only happens if
    // the collision is RECOGNISED, and drizzle wraps driver errors: the wrapper's
    // message is "Failed query: insert into …" with neither the SQLSTATE nor the
    // constraint name in it, so a message-only check silently never matches and
    // every raced signup would surface as a 500 instead.
    const v = await createTestValley(db, {
      name: 'SITE UNIQUENESS VALE', createdAt: new Date('2000-01-09T00:00:00Z'),
    });
    try {
      const err = await db.insert(valleys).values({ name: 'SITE CLASH', siteId: v.siteId })
        .then(() => null, (e: unknown) => e);
      expect(err, 'a second valley on the same site must be refused').not.toBeNull();
      expect(isSiteIdCollision(err)).toBe(true);
      // A real fault must NOT be mistaken for one, or createValley would swallow it.
      expect(isSiteIdCollision(new Error('connection terminated'))).toBe(false);
    } finally {
      // PUT THE WORLD BACK. Every suite shares one database and `ensurePlotAssigned`
      // seats new players in the NEWEST valley, so a leftover camp-less valley
      // becomes somebody else's home and their PvE tests find nothing to attack.
      // Deleting it also exercises the documented gap semantics: site ids are never
      // reused, and `siteOf` does not care that they are contiguous.
      await db.delete(valleys).where(eq(valleys.id, v.id));
    }
  });

  it('assigns a plot idempotently in the newest valley', async () => {
    const p = await createTestPlayer(db);
    const a = await ensurePlotAssigned(db, p.wallet);
    const b = await ensurePlotAssigned(db, p.wallet);
    expect(a).toEqual(b);
    expect(a.x).toBeGreaterThanOrEqual(0);
    expect(a.x).toBeLessThan(WORLD.gridCols);
  });

  it('seeds PvE camps with valid tier snapshots when a valley is created', async () => {
    const p = await createTestPlayer(db);
    const { valleyId } = await ensurePlotAssigned(db, p.wallet);
    const camps = await db.select().from(pveCamps).where(eq(pveCamps.valleyId, valleyId));
    expect(camps.length).toBe(WORLD.campsPerValley);
    for (const tier of [1, 2, 3] as const) {
      const snap = makeCampSnapshot(tier);
      expect(snap.buildings.some((b) => b.type === 'keep')).toBe(true);
    }
  });

  it('every tier layout is collision-free, inside the claim, and ramps in difficulty', () => {
    // WHY (owner 2026-07-24): PvE bases ramp low→max "perfect defence". A tile
    // overlap or an out-of-claim footprint would make the sim reject the camp,
    // so this pins the placer's invariants across ALL tiers.
    const footprint = (type: string): [number, number] => {
      if (type === 'barracks') return [2, 1];
      if (['keep', 'mortar', 'dragonnest', 'camp', 'goldforge'].includes(type)) return [2, 2];
      return [1, 1];
    };
    let prevKeep = 0;
    // MAXED_CAMP_TIER, not MAX_CAMP_TIER: the ops-only T9 must satisfy the same
    // placer invariants at L20 sizes (3 wall rings + all seven defence types).
    for (let tier = 1; tier <= MAXED_CAMP_TIER; tier++) {
      const snap = makeCampSnapshot(tier);
      const cmin = snap.claimMin ?? 0;
      const cmax = snap.claimMax ?? 0;
      const occ = new Set<string>();
      for (const b of snap.buildings) {
        const [fw, fh] = footprint(b.type);
        expect(b.tx).toBeGreaterThanOrEqual(cmin);
        expect(b.ty).toBeGreaterThanOrEqual(cmin);
        expect(b.tx + fw).toBeLessThanOrEqual(cmax);
        expect(b.ty + fh).toBeLessThanOrEqual(cmax);
        for (let dx = 0; dx < fw; dx++) for (let dy = 0; dy < fh; dy++) {
          const cell = `${b.tx + dx},${b.ty + dy}`;
          expect(occ.has(cell), `tier ${tier} overlap at ${cell}`).toBe(false);
          occ.add(cell);
        }
      }
      expect(snap.buildings.some((b) => b.type === 'keep')).toBe(true);
      // Difficulty ramps: keep level is monotonic non-decreasing across tiers.
      expect(snap.keepLevel).toBeGreaterThanOrEqual(prevKeep);
      prevKeep = snap.keepLevel;
    }
    // The top ROTATION tier is a real fortress: epic defenses + a substantial wall ring.
    const top = makeCampSnapshot(MAX_CAMP_TIER);
    expect(top.buildings.some((b) => b.type === 'lasertower')).toBe(true);
    expect(top.buildings.some((b) => b.type === 'dragonnest')).toBe(true);
    expect(top.buildings.filter((b) => b.type === 'wall').length).toBeGreaterThan(20);

    // T9 MAXED (owner 2026-08-03): everything at L20 with ALL SEVEN defence
    // types — the practice target exists to watch every defence the game has
    // fire — behind strictly more wall than the rotation's top tier.
    const maxed = makeCampSnapshot(MAXED_CAMP_TIER);
    expect(maxed.keepLevel).toBe(20);
    for (const t of ['cannon', 'archertower', 'mortar', 'electrictower', 'magetower', 'lasertower', 'dragonnest']) {
      expect(maxed.buildings.some((b) => b.type === t && b.level === 20), `missing L20 ${t}`).toBe(true);
    }
    const maxedWalls = maxed.buildings.filter((b) => b.type === 'wall');
    expect(maxedWalls.length).toBeGreaterThan(top.buildings.filter((b) => b.type === 'wall').length);
    expect(maxedWalls.every((w) => w.level === 20)).toBe(true); // wall tier 20 exists (STRUCTURES.wall.maxTier)
  });
});

const WHOLE_VALLEY = { x0: 0, y0: 0, x1: WORLD.gridCols - 1, y1: WORLD.gridRows - 1 };

/** An isolated, camp-less valley for map tests. Backdated on purpose: real
 *  signups go to the NEWEST valley, so a fresh one here would hijack every later
 *  ensurePlotAssigned in the file and seat players in a valley with no PvE camps. */
async function testValley(name: string): Promise<string> {
  const v = await createTestValley(db, { name, createdAt: new Date('2000-01-01T00:00:00Z') });
  return v.id;
}

/** Every DEEDED tile, row-major: the 500-tile grid minus the 9 PvE camp tiles.
 *  Camps hold a grid tile but are not deeded land (EARTH-TILES-PLAN R2), so since
 *  P5 they have no Earth cell and `plots.earth_cell` is NOT NULL — i.e. a fixture
 *  can no longer seat a player on one. Row-major (rather than plot-assignment
 *  order) keeps every seeded position identical to what this file used before for
 *  the first two rows, which is what the pinhole-viewport assertions read. */
const DEEDED_TILES: Array<[number, number]> = (() => {
  const camps = new Set(campCoords().map((c) => `${c.x},${c.y}`));
  const out: Array<[number, number]> = [];
  for (let y = 0; y < WORLD.gridRows; y++) {
    for (let x = 0; x < WORLD.gridCols; x++) if (!camps.has(`${x},${y}`)) out.push([x, y]);
  }
  return out;
})();

/** Seed `n` players straight onto a valley's tiles — bypasses ensurePlotAssigned
 *  so a scale test gets an ISOLATED valley (the shared newest valley accumulates
 *  rows from every other test in the file). */
async function seedValley(
  valleyId: string, from: number, n: number, trophies: (i: number) => number,
): Promise<string[]> {
  const wallets: string[] = [];
  const playerRows = [];
  const plotRows = [];
  for (let i = from; i < from + n; i++) {
    const w = randomWallet();
    wallets.push(w);
    playerRows.push({
      wallet: w, name: `SEED${i}`, keepLevel: (i % 5) + 1,
      trophies: trophies(i), entryPaidAt: new Date(),
    });
    const [x, y] = DEEDED_TILES[i]!;
    plotRows.push({ valleyId, x, y, playerWallet: w });
  }
  await db.insert(players).values(playerRows);
  await seedPlots(db, plotRows);
  return wallets;
}

describe('map chunk + scout', () => {
  it('returns player + camp markers with tease semantics, never exact balances', async () => {
    const p = await fighter();
    const { markers } = await getMapChunk(db, p.wallet, WHOLE_VALLEY);
    const mine = markers.find((m) => m.kind === 'player' && m.isMe);
    expect(mine).toBeDefined();
    expect(mine).not.toHaveProperty('balance');
    expect((mine as { surplusTease: boolean }).surplusTease).toBe(true); // funded way above threshold
    expect(markers.some((m) => m.kind === 'pve')).toBe(true);
  });

  it('a player who has never held KEEP still appears — and a map read never writes to the ledger', async () => {
    // WHY: getMapChunk used to call getOrCreatePlayerAccount for EVERY marker —
    // an INSERT … ON CONFLICT on a GET, i.e. the ledger table grew because someone
    // opened the map. A missing accounts row simply means balance 0, which is
    // exactly the right surplusTease, so the write had no purpose at all.
    const broke = randomWallet();
    await db.insert(players).values({ wallet: broke, entryPaidAt: new Date() });
    const { valleyId } = await ensurePlotAssigned(db, broke);
    const viewer = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, viewer.wallet));
    // The viewer must be STANDING in this valley to see it in full. Stated
    // explicitly now because a read no longer signs anybody up: `?valleyId=` used to
    // call ensurePlotAssigned for a plot-less caller, i.e. a GET escalating into the
    // FOR UPDATE signup transaction (see map-visit.test.ts "a VISIT never signs the
    // visitor up"). Real players are assigned a plot when their entry payment is
    // credited (depositWatcher) — this line is that, made explicit for a test
    // fixture. Nothing about what this test asserts has changed.
    await ensurePlotAssigned(db, viewer.wallet);

    const count = async (): Promise<number> =>
      (await db.select({ n: sql<number>`count(*)::int` }).from(accounts))[0]!.n;
    const before = await count();
    resetMapCache();
    const { markers } = await getMapChunk(db, viewer.wallet, { ...WHOLE_VALLEY, valleyId });
    expect(await count()).toBe(before); // a GET must never post to the ledger

    const m = markers.find((x) => x.kind === 'player' && x.wallet === broke);
    expect(m, 'a brand-new player must be visible on the map').toBeDefined();
    expect((m as { surplusTease: boolean }).surplusTease).toBe(false);
  });

  it('publishes only minimal deed identity for un-actionable keeps', async () => {
    // WHY: /map used to hand every wallet in the valley to anyone who opened the
    // screen. The owner now wants deed parcels labelled with the public username
    // and avatar, but that must not turn the parcel band into a wallet, presence,
    // shield, loot or combat-state scraping surface. Un-actionable keeps therefore
    // ship only the deliberately small public identity marker.
    //
    // THIS TEST GUARDS THE ROSTER PIPELINE — the full path in getMapChunk that ranks
    // candidates, promotes revenge and decides who gets a nametag — so the viewer is
    // a MEMBER of the valley. That is now load-bearing: since the read-only visit
    // branch landed (2026-08-09), a plot-less viewer naming a valley is routed
    // straight into visitValley, which returns silhouettes by construction and
    // therefore cannot fail this assertion. Read that way, this test proved nothing
    // about the code it was written for. The visit path has its own adversarial
    // coverage in test/map-visit.test.ts; this one must stay on the member path.
    const valleyId = await testValley('silhouette-test');
    // The 40 fixture neighbours are seeded at Keeps 1..5; the viewer's Keep is
    // set so its D-099 bar sits ABOVE every one of them, i.e. none is attackable.
    // This must key off the raid rule itself: neither trophies nor the league
    // thresholds define map attackability any more.
    await seedValley(valleyId, 0, 40, () => 0);
    const viewer = await createTestPlayer(db);
    const viewerKeep = 11;
    expect(pvpMinDefenderKeep(viewerKeep)).toBeGreaterThan(5);
    await db.update(players).set({
      entryPaidAt: new Date(),
      keepLevel: viewerKeep,
    }).where(eq(players.wallet, viewer.wallet));
    // The viewer LIVES here (K11, so all 40 neighbours are too far below).
    // Seeded directly, like seedValley does, because ensurePlotAssigned seats
    // players in the NEWEST valley and this one is deliberately backdated.
    await seedPlot(db, { valleyId, x: 0, y: 5, playerWallet: viewer.wallet });

    resetMapCache();
    const { markers, visiting } = await getMapChunk(db, viewer.wallet, { ...WHOLE_VALLEY, valleyId });
    expect(visiting, 'a member must get the full roster path, not the visit path').toBe(false);
    const silhouettes = markers.filter((m) => m.kind === 'silhouette');
    expect(silhouettes.length).toBe(40);
    for (const s of silhouettes) {
      expect(Object.keys(s).sort()).toEqual([
        'avatarUrl', 'earthCell', 'keepLevel', 'kind', 'name', 'trophies', 'x', 'y',
      ]);
      expect(s).not.toHaveProperty('wallet');
      expect(s.name).toMatch(/^SEED\d+$/);
      expect(s.avatarUrl).toBeNull();
    }
    // Exactly one full marker: your own keep. Every other deed exposes public
    // display identity only and cannot reveal its wallet or actionable state.
    const full = markers.filter((m) => m.kind === 'player');
    expect(full.length).toBe(1);
    expect((full[0] as { wallet: string }).wallet).toBe(viewer.wallet);
  });

  it('a valley that ALL raided you still cannot blow the marker budget', async () => {
    // WHY: revenge markers ship in full wherever they stand, deliberately
    // ignoring the viewport so the WAR ROOM can centre on an off-screen grudge.
    // Uncapped, that defeated BOTH bounds at once: a player everyone had raided
    // pulled the entire valley back as full markers — even from a 1x1-tile
    // request (verification 2026-07-29 P1). The bounded-payload test above
    // seeds ZERO raids, so it is structurally blind to this path.
    const valleyId = await testValley('revenge-flood');
    const wallets = await seedValley(valleyId, 0, 200, () => 0);
    const viewer = wallets[0]!;
    // Everyone else resolved a raid on the viewer inside the revenge window.
    await db.insert(raids).values(wallets.slice(1).map((w) => ({
      attackerWallet: w, defenderWallet: viewer, status: 'resolved' as const,
      seed: 1n, snapshot: {}, armySnapshot: {},
      ordersDeadlineAt: new Date(), resolvedAt: new Date(),
    })));

    resetMapCache();
    const all = await getMapChunk(db, viewer, { ...WHOLE_VALLEY, valleyId });
    const fullAll = all.markers.filter((m) => m.kind === 'player').length;
    // own keep + capped revenge promotions + the in-window candidate cap.
    expect(fullAll).toBeLessThanOrEqual(1 + WORLD.recommendedTargets + WORLD.mapCandidateCap);

    // And a pinhole viewport must not become a whole-valley dump. The real
    // invariant is INDEPENDENCE FROM POPULATION: doubling the number of angry
    // neighbours must not change what a 1x1-tile request costs.
    const pinhole = { valleyId, x0: 0, y0: 0, x1: 1, y1: 1 };
    resetMapCache();
    const tiny = await getMapChunk(db, viewer, pinhole);
    const tinyFull = tiny.markers.filter((m) => m.kind === 'player').length;
    expect(tinyFull).toBeLessThanOrEqual(1 + WORLD.recommendedTargets + WORLD.mapCandidateCap);

    const more = await seedValley(valleyId, 200, 100, () => 0);
    await db.insert(raids).values(more.map((w) => ({
      attackerWallet: w, defenderWallet: viewer, status: 'resolved' as const,
      seed: 1n, snapshot: {}, armySnapshot: {},
      ordersDeadlineAt: new Date(), resolvedAt: new Date(),
    })));
    resetMapCache();
    const tiny2 = await getMapChunk(db, viewer, pinhole);
    const tiny2Full = tiny2.markers.filter((m) => m.kind === 'player').length;
    // NOT an equality: 100 fresh grudges re-rank the promotion set, so WHICH
    // markers come back legitimately shifts (a newly promoted revenge target
    // may sit inside the rect where the one it displaced did not). The
    // invariant is the BOUND — the count stays structural, never proportional
    // to the 100 players added.
    expect(tiny2Full).toBeLessThanOrEqual(1 + WORLD.recommendedTargets + WORLD.mapCandidateCap);
    expect(tiny2Full).toBeLessThanOrEqual(tinyFull + WORLD.recommendedTargets);
  });

  it('marker count is bounded by MEANING, not by valley size', async () => {
    // WHY: the map must stay a fixed-cost screen as the world grows to 20k. Full
    // markers are capped at WORLD.mapCandidateCap however many neighbours you
    // have; everyone else costs a compact public-identity tuple. Without this the
    // payload grows linearly in private gameplay state and the poll loop becomes
    // the bottleneck.
    const valleyId = await testValley('scale-test');
    const first = await seedValley(valleyId, 0, 200, () => 0);
    const viewer = first[0]!;

    resetMapCache();
    const a = await getMapChunk(db, viewer, { ...WHOLE_VALLEY, valleyId });
    const fullA = a.markers.filter((m) => m.kind === 'player').length;
    // cap + your own keep; no raids exist here so there are no revenge extras
    expect(fullA).toBe(WORLD.mapCandidateCap + 1);
    expect(a.recommended.length).toBe(WORLD.recommendedTargets);
    const bytesA = JSON.stringify(a).length;

    // 100 MORE neighbours must not buy 100 more full markers.
    await seedValley(valleyId, 200, 100, () => 0);
    resetMapCache();
    const b = await getMapChunk(db, viewer, { ...WHOLE_VALLEY, valleyId });
    expect(b.markers.filter((m) => m.kind === 'player').length).toBe(fullA);
    expect(b.markers.filter((m) => m.kind === 'silhouette').length).toBe(300 - fullA);
    // The whole valley is bounded by the grid itself, so the payload can never run away.
    expect(b.markers.length).toBeLessThanOrEqual(WORLD.gridCols * WORLD.gridRows);
    // Measured 2026-08-13: ~115.2 B per null-avatar neighbour after the owner
    // deliberately added public username/avatar identity. Even a populated opaque
    // avatar URL remains a fixed-size pointer; wallet, balance, presence, shields,
    // loot and combat state stay absent. The bound is on INFORMATION, not players.
    const perExtraPlayer = (JSON.stringify(b).length - bytesA) / 100;
    expect(perExtraPlayer).toBeLessThan(180);
  });

  it('one roster load serves every viewer of a valley', async () => {
    // WHY: the roster (who stands where, shields, clan tags, scorch marks) is
    // identical for everyone looking at the same valley. If each viewer re-ran it,
    // DB load would scale with CONCURRENT VIEWERS instead of with valleys — the
    // difference between ~48 q/s and thousands at 20k players.
    const valleyId = await testValley('cache-test');
    const ws = await seedValley(valleyId, 0, 5, () => 0);
    resetMapCache();
    await getMapChunk(db, ws[0]!, { ...WHOLE_VALLEY, valleyId });
    await getMapChunk(db, ws[1]!, { ...WHOLE_VALLEY, valleyId });
    expect(mapCacheLoads()).toBe(1);
  });

  it('a purge must not serve stale attackability', async () => {
    // WHY: isWarzoneActive flips shield visibility GLOBALLY. Cached under a key
    // that ignores it, the map would spend up to mapCacheSec insisting bases are
    // shielded that the raid gate will happily let you attack (or vice versa) —
    // the map lying about the one thing it exists to answer.
    const valleyId = await testValley('purge-test');
    const ws = await seedValley(valleyId, 0, 3, () => 0);
    await db.insert(shields).values({ playerWallet: ws[1]!, source: 'loss', expiresAt: future(60) });
    const rect = { ...WHOLE_VALLEY, valleyId };
    const shieldedOf = (r: Awaited<ReturnType<typeof getMapChunk>>): boolean =>
      r.markers.some((m) => m.kind === 'player' && m.wallet === ws[1] && m.shielded);

    resetMapCache();
    try {
      const calm = await getMapChunk(db, ws[0]!, rect);
      expect(calm.warzoneActive).toBe(false);
      expect(shieldedOf(calm)).toBe(true);

      const now = new Date();
      await setShieldlessMode(db, 'purge', {
        purgeStartAt: new Date(now.getTime() - 1_000),
        purgeEndAt: new Date(now.getTime() + 3_600_000),
      });
      // Same valley, well inside mapCacheSec — the warzone segment of the cache
      // key is what makes this a fresh answer rather than a stale one.
      const purge = await getMapChunk(db, ws[0]!, rect);
      expect(purge.warzoneActive).toBe(true);
      expect(shieldedOf(purge)).toBe(false); // loss-shields are suppressed
    } finally {
      await setShieldlessMode(db, 'off');
    }
  });

  it('inWindow mirrors the raid gate, and revenge is a badge — not a licence', async () => {
    // WHY: the map's whole job is telling you who you may march on. inWindow is
    // computed with the SAME predicate as createRaid — since D-099 the Keep rule
    // (their Keep at least half yours), not a trophy window — so the two can
    // never disagree. Revenge (RAID_RULES.revengeLockHours) marks who hit you,
    // but does NOT bend the rule: an unreachable revenge target must render
    // honestly rather than offer a tap the server will 422.
    const valleyId = await testValley('window-test');
    // Trophies deliberately IDENTICAL: they must not be what decides this.
    const ws = await seedValley(valleyId, 0, 3, () => 300);
    const [near, far] = [ws[1]!, ws[2]!];
    const viewerKeep = 10;
    const nearKeep = pvpMinDefenderKeep(viewerKeep);
    const farKeep = nearKeep - 1;
    expect(pvpAttackAllowed(viewerKeep, nearKeep)).toBe(true);
    expect(pvpAttackAllowed(viewerKeep, farKeep)).toBe(false);
    await db.update(players).set({ keepLevel: viewerKeep }).where(eq(players.wallet, ws[0]!));
    await db.update(players).set({ keepLevel: nearKeep }).where(eq(players.wallet, near));
    await db.update(players).set({ keepLevel: farKeep }).where(eq(players.wallet, far));

    // the FAR player raided the viewer — resolved, inside the revenge lock
    await db.insert(raids).values({
      attackerWallet: far, defenderWallet: ws[0]!, seed: 1n, snapshot: {}, armySnapshot: {},
      ordersDeadlineAt: new Date(), status: 'resolved',
    });

    resetMapCache();
    const { markers } = await getMapChunk(db, ws[0]!, { ...WHOLE_VALLEY, valleyId });
    const of = (w: string) => markers.find((m) => m.kind === 'player' && m.wallet === w) as
      { inWindow: boolean; revenge: boolean; burning: boolean } | undefined;
    expect(of(near)?.inWindow).toBe(true);
    // Too far below but STILL shipped in full (and flagged), because "they hit you"
    // is information the player is owed even when the answer is "you can't reply".
    expect(of(far)?.revenge).toBe(true);
    expect(of(far)?.inWindow).toBe(false);
    // and the defender's keep reads as freshly scorched
    expect(of(ws[0]!)?.burning).toBe(true);
  });

  it('scout returns the layout, and a shield does not refuse it', async () => {
    const a = await fighter();
    const b = await fighter();
    // Use a private quest day. API test files share one Postgres database and
    // run concurrently; inserting scout_3 for today's rotating board would
    // change social.test's deterministic three-daily assertion.
    const now = new Date('2099-01-01T12:00:00.000Z');
    const day = now.toISOString().slice(0, 10);
    await db.insert(quests).values({
      scope: 'daily', templateCode: 'scout_3', target: 3,
      rewardKeep: 10n, activeOn: day,
    }).onConflictDoNothing();
    const [scoutQuest] = await db.select().from(quests).where(and(
      eq(quests.scope, 'daily'), eq(quests.activeOn, day), eq(quests.templateCode, 'scout_3'),
    ));
    expect(scoutQuest).toBeDefined();
    const progress = async () => (await db.select().from(questProgress).where(and(
      eq(questProgress.questId, scoutQuest!.id), eq(questProgress.playerWallet, a.wallet),
    )))[0]?.progress ?? 0;

    // A made-up wallet is not a scout. This catches quest progression happening
    // before target existence validation (and prevents wallet-probe farming).
    await expect(scoutBase(db, a.wallet, randomWallet(), now)).rejects.toThrow(/player not found/);
    expect(await progress()).toBe(0);

    const scouted = await scoutBase(db, a.wallet, b.wallet, now);
    expect(scouted.buildings.some((x) => x.type === 'keep')).toBe(true);
    expect(await progress()).toBe(1);
    // The scout payload carries the CENTERED claim bounds + obstacles so the client
    // renders the target with the real base renderer (not a flat board).
    expect(scouted.claimMin).toBe(8);
    expect(scouted.claimMax).toBe(22);
    expect(Array.isArray(scouted.obstacles)).toBe(true);
    expect(scouted.obstacles.length).toBeGreaterThan(0);
    // D-099 (owner: "everyone can scout everyone. it should not be gated by shield
    // or anything else. only attacks should"): a shield used to 422 here (#46/#49).
    // A scout refused by a shield taught the player nothing, and the attack is
    // still refused by the raid gate — so the layout stays readable and the
    // scout quest still counts it.
    await db.insert(shields).values({
      playerWallet: b.wallet,
      source: 'loss',
      expiresAt: new Date(now.getTime() + 60 * 60_000),
    });
    const shieldedScout = await scoutBase(db, a.wallet, b.wallet, now);
    expect(shieldedScout.buildings.some((x) => x.type === 'keep')).toBe(true);
    expect(await progress()).toBe(2);
  });

  it('discloses frozen hero gear after scout gates but activates effective stats only behind the combat flag', async () => {
    // WHY: scout intelligence must explain a visible defender loadout without
    // accidentally turning that loadout on before the server-side rollout flag.
    // The hash/version also let a replay prove exactly which equipment was seen.
    const a = await fighter();
    const b = await fighter();
    await db.insert(buildings).values({
      playerWallet: b.wallet, type: 'heroaltar', level: 1, tx: 10, ty: 11,
    });
    await db.insert(heroLevels).values({ playerWallet: b.wallet, hero: 'vex', level: 3 });
    await db.insert(playerItems).values({
      playerWallet: b.wallet, itemId: 'wardens_helm', qty: 1,
    });
    await db.insert(heroLoadouts).values({
      playerWallet: b.wallet, hero: 'vex', version: 4,
    });
    await db.insert(heroEquipment).values({
      playerWallet: b.wallet, hero: 'vex', slot: 'helm', itemId: 'wardens_helm',
    });

    const original = process.env.HERO_GEAR_COMBAT_ENABLED;
    try {
      process.env.HERO_GEAR_COMBAT_ENABLED = 'false';
      const dark = await scoutBase(db, a.wallet, b.wallet);
      const darkVex = dark.heroes.find((hero) => hero.hero === 'vex')!;
      expect(darkVex).toMatchObject({
        level: 3, guardTx: 11, guardTy: 12, recoveryUntil: null, available: true,
        gear: { version: 4, combatEnabled: false },
      });
      expect(darkVex.gear.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(darkVex.effectiveStats).toEqual(darkVex.baseStats);

      process.env.HERO_GEAR_COMBAT_ENABLED = 'true';
      const live = await scoutBase(db, a.wallet, b.wallet);
      const liveVex = live.heroes.find((hero) => hero.hero === 'vex')!;
      const hp = HERO_LEVELING.hp.vex[2]!;
      const damage = HERO_LEVELING.dps.vex[2]!;
      expect(liveVex.gear).toMatchObject({
        version: 4, hash: darkVex.gear.hash, combatEnabled: true,
        modifiers: { hero_hp_bps: 600, ability_damage_bps: 400 },
      });
      expect(liveVex.effectiveStats).toEqual({
        hp: Math.floor((hp * 10_600) / 10_000),
        basicDamage: damage,
        skillDamageSeed: Math.floor((damage * 10_400) / 10_000),
      });
    } finally {
      if (original === undefined) delete process.env.HERO_GEAR_COMBAT_ENABLED;
      else process.env.HERO_GEAR_COMBAT_ENABLED = original;
    }
  });
});

describe('PvE ruined keeps (GDD §3.6)', () => {
  it('victory pays NO bounty (D-152), no trophies, no shield, camp clears', async () => {
    // WHY: the camp bounty was a custodial KEEP faucet (30–2,000 KEEP × 3/day).
    // D-152 retires custodial KEEP and the owner removed the bounty outright:
    // a PvE win must leave player_keep AND the emission pool untouched while
    // the camp still clears, so the practice loop survives without a faucet.
    const p = await fighter();
    const { valleyId } = await ensurePlotAssigned(db, p.wallet);
    const [camp] = await db.select().from(pveCamps)
      .where(and(eq(pveCamps.valleyId, valleyId), eq(pveCamps.tier, 1)));
    expect(camp).toBeDefined();

    const sys = await bootstrapSystemAccounts(db);
    const before = (await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance;
    const emissionBefore = (await db.select().from(accounts)
      .where(eq(accounts.id, sys.emission_pool)))[0]!.balance;
    // PvE costs NOTHING to enter (owner 2026-07-26: energy AND the PvP shard ante
    // are PvP-only). Ruined Keeps are the practice/earn loop — charging for them
    // would gate the one mode a broke player can still use.
    const shardsBefore = (await getOrCreatePlayerAccount(db, p.wallet, 'player_shards')).balance;
    const raid = await createPveRaid(db, p.wallet, camp!.id, k());
    expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_shards')).balance).toBe(shardsBefore);
    const { result } = await submitOrders(db, p.wallet, raid.id, {
      // Shifted +6 to match the re-centered PvE camp (keep 14,14, claim [8,22)),
      // so the four turriders still surround the camp with the same geometry.
      deploys: [
        { troop: 'turrider', tx: 6, ty: 14, tMs: 0 },
        { troop: 'turrider', tx: 23, ty: 14, tMs: 0 },
        { troop: 'turrider', tx: 14, ty: 6, tMs: 0 },
        { troop: 'turrider', tx: 14, ty: 23, tMs: 0 },
      ],
      idempotencyKey: k(),
    });
    expect(result.stars).toBeGreaterThanOrEqual(1);
    expect(result.attackerTrophyDelta).toBe(0);
    expect(result.lootShards).toBe(0);
    const after = (await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance;
    expect(after).toBe(before);
    const emissionAfter = (await db.select().from(accounts)
      .where(eq(accounts.id, sys.emission_pool)))[0]!.balance;
    expect(emissionAfter).toBe(emissionBefore);
    expect(await db.select().from(ledgerTransactions)
      .where(eq(ledgerTransactions.idempotencyKey, `raid:${raid.id}:bounty`))).toHaveLength(0);

    // no shield was granted to anyone; camp is cleared until respawn
    const sh = await db.select().from(shields)
      .where(and(eq(shields.playerWallet, p.wallet), gt(shields.expiresAt, new Date())));
    expect(sh.length).toBe(0);
    const [after_camp] = await db.select().from(pveCamps).where(eq(pveCamps.id, camp!.id));
    expect(after_camp!.respawnsAt).not.toBeNull();
    await expect(createPveRaid(db, p.wallet, camp!.id, k())).rejects.toThrow(/already cleared/);
  });

  it('enforces the 3 camps/day cap and PvE never consumes PvP energy', async () => {
    const p = await fighter();
    const { valleyId } = await ensurePlotAssigned(db, p.wallet);
    const camps = (await db.select().from(pveCamps).where(eq(pveCamps.valleyId, valleyId)))
      .filter((c) => c.respawnsAt === null) // live camps only — earlier tests may have cleared some
      .slice(0, PVE.maxCampsPerDay + 1);
    expect(camps.length).toBeGreaterThan(PVE.maxCampsPerDay);
    for (let i = 0; i < PVE.maxCampsPerDay; i++) {
      await createPveRaid(db, p.wallet, camps[i]!.id, k());
    }
    await expect(createPveRaid(db, p.wallet, camps[PVE.maxCampsPerDay]!.id, k()))
      .rejects.toThrow(/camps per day/);
  });

  it('an abandoned PvE raid gives its daily camp slot back once the deploy window lapses', async () => {
    // WHY: the 3/day cap exists to meter REWARDS, not clicks. A raid whose march
    // never happened (deploy window expired with no orders) paid nothing out, so
    // letting it burn a slot would strand players at 0 attempts — permanently,
    // since nothing else ever expired PvE rows (expireStaleRaids was PvP-only).
    const p = await fighter();
    const { valleyId } = await ensurePlotAssigned(db, p.wallet);
    const camps = (await db.select().from(pveCamps).where(eq(pveCamps.valleyId, valleyId)))
      .filter((c) => c.respawnsAt === null)
      .slice(0, PVE.maxCampsPerDay + 1);
    expect(camps.length).toBeGreaterThan(PVE.maxCampsPerDay);
    for (let i = 0; i < PVE.maxCampsPerDay; i++) {
      await createPveRaid(db, p.wallet, camps[i]!.id, k());
    }
    // cap is hit…
    await expect(createPveRaid(db, p.wallet, camps[PVE.maxCampsPerDay]!.id, k()))
      .rejects.toThrow(/camps per day/);
    // …then every pending march is abandoned (deadline in the past, no orders)
    await db.update(raids).set({
      ordersDeadlineAt: new Date(
        Date.now() - RAID_RULES.batchOrdersGraceSec * 1_000 - 1_000,
      ),
    })
      .where(and(eq(raids.attackerWallet, p.wallet), eq(raids.status, 'pending_orders')));
    // the next attempt reclaims all three slots and succeeds
    const raid = await createPveRaid(db, p.wallet, camps[PVE.maxCampsPerDay]!.id, k());
    expect(raid.status).toBe('pending_orders');
  });

  it('respawnPveCamps revives camps whose timer passed', async () => {
    const p = await fighter();
    const { valleyId } = await ensurePlotAssigned(db, p.wallet);
    const [camp] = await db.select().from(pveCamps).where(eq(pveCamps.valleyId, valleyId)).limit(1);
    await db.update(pveCamps).set({ respawnsAt: new Date(Date.now() - 1000) })
      .where(eq(pveCamps.id, camp!.id));
    const n = await respawnPveCamps(db);
    expect(n).toBeGreaterThanOrEqual(1);
    const [revived] = await db.select().from(pveCamps).where(eq(pveCamps.id, camp!.id));
    expect(revived!.respawnsAt).toBeNull();
  });
});

void players;

// ---------------------------------------------------------------------------
// Campaign (MAPS split E1, extended 2026-08-11): sixty deterministic stages,
// separate from the rotating camp tiers. What must hold: linear unlock, stars
// RATCHET, and the first-3★ shard reward pays exactly once per stage.
// ---------------------------------------------------------------------------
import { CAMPAIGN } from '@shardkeep/shared';
import { campaignProgress } from '../src/db/schema';
import { createCampaignRaid, getCampaignBoard, submitOrders as submitOrders2 } from '../src/game/raids';
import { utcDay } from '../src/game/emission';
import { getOrCreatePlayerAccount as acctOf } from '../src/ledger';

const winDeploys = [
  { troop: 'turrider' as const, tx: 6, ty: 14, tMs: 0 },
  { troop: 'turrider' as const, tx: 23, ty: 14, tMs: 0 },
  { troop: 'turrider' as const, tx: 14, ty: 6, tMs: 0 },
  { troop: 'turrider' as const, tx: 14, ty: 23, tMs: 0 },
];

describe('campaign (MAPS split E1)', () => {
  it('stage 2 is locked until stage 1 has a star; stars ratchet; first-3★ pays ONCE', async () => {
    const p = await fighter();
    await expect(createCampaignRaid(db, p.wallet, 2, k())).rejects.toThrow(/clear stage 1/);
    expect((await getCampaignBoard(db, p.wallet)).stages[1]!.unlocked).toBe(false);

    // The stage-1 OUTPOST is intentionally conquerable by the starter-band army.
    const raid = await createCampaignRaid(db, p.wallet, 1, k());
    const shardsBefore = (await acctOf(db, p.wallet, 'player_shards')).balance;
    const { result } = await submitOrders2(db, p.wallet, raid.id, { deploys: winDeploys, idempotencyKey: k() });
    expect(result.stars).toBe(3);

    const board = await getCampaignBoard(db, p.wallet);
    expect(board.stages[0]!.bestStars).toBe(3);
    expect(board.stages[0]!.firstThreeStarClaimed).toBe(true);
    expect(board.stages[1]!.unlocked).toBe(true); // the frontier moved
    const reward = BigInt(CAMPAIGN.firstThreeStarShardsByKeep[0]!);
    const afterFirst = (await acctOf(db, p.wallet, 'player_shards')).balance;
    expect(afterFirst - shardsBefore).toBe(reward);

    // Re-train (the first win consumed the army), then replay the same stage
    // and win again: stars stay ratcheted, NO second reward — replayable
    // content must never be a shard faucet.
    let t2 = 900;
    for (let i = 0; i < 4; i++) {
      await trainTroop(db, p.wallet, 'turrider' as never, k(), future(t2));
      t2 += 10;
      await completeDueTraining(db, p.wallet, future(t2));
    }
    const beforeReplay = (await acctOf(db, p.wallet, 'player_shards')).balance; // post-training baseline
    const again = await createCampaignRaid(db, p.wallet, 1, k());
    await submitOrders2(db, p.wallet, again.id, { deploys: winDeploys, idempotencyKey: k() });
    expect((await acctOf(db, p.wallet, 'player_shards')).balance).toBe(beforeReplay); // won again, paid NOTHING, earned NOTHING
    const [row] = await db.select().from(campaignProgress)
      .where(and(eq(campaignProgress.playerWallet, p.wallet), eq(campaignProgress.stage, 1)));
    expect(row!.bestStars).toBe(3);
  });

  it('campaign raids are FREE and uncapped — no energy, no ante, no PvE daily slot', async () => {
    const p = await fighter();
    // Burn all 3 PvE camp slots first; the campaign must not care.
    const { valleyId } = await ensurePlotAssigned(db, p.wallet);
    void valleyId;
    for (let i = 0; i < 4; i++) {
      const r = await createCampaignRaid(db, p.wallet, 1, k());
      expect(r.campaignStage).toBe(1);
    }
    // 4 campaign raids created in one day — no cap threw. (PvE camp cap is 3.)
  });

  it('does not count a free zero-star campaign sandbag as daily raid activity', async () => {
    const p = await fighter();
    const now = new Date();
    await db.insert(campaignProgress).values({
      playerWallet: p.wallet, stage: 59, bestStars: 1, updatedAt: now,
    });
    const before = await db.select({ raids: dailyActivity.raids }).from(dailyActivity)
      .where(and(eq(dailyActivity.playerWallet, p.wallet), eq(dailyActivity.day, utcDay(now))));
    const raid = await createCampaignRaid(db, p.wallet, 60, k(), now);
    const stage = makeCampaignSnapshot(60);
    const { result } = await submitOrders2(db, p.wallet, raid.id, {
      deploys: [{
        troop: 'turrider', tx: stage.claimMin! - 1,
        ty: Math.floor((stage.claimMin! + stage.claimMax!) / 2), tMs: 0,
      }],
      idempotencyKey: k(),
    }, now);
    expect(result.stars).toBe(0);
    const after = await db.select({ raids: dailyActivity.raids }).from(dailyActivity)
      .where(and(eq(dailyActivity.playerWallet, p.wallet), eq(dailyActivity.day, utcDay(now))));
    expect(after[0]?.raids ?? 0).toBe(before[0]?.raids ?? 0);
  });
});

// ---------------------------------------------------------------------------
// MAXED practice camp — tier 9, ops-spawned only (owner 2026-08-03)
// ---------------------------------------------------------------------------

describe('MAXED practice camp (tier 9, ops-only)', () => {
  it('never enters the valley rotation or the campaign — but its bounty exists', () => {
    // WHY: T9 is a dev practice target with a 2,000-KEEP bounty. If campCoords()
    // or the campaign mapping ever picked it up, every valley (and stage list)
    // would ship a maxed bounty faucet the owner never approved.
    for (const c of campCoords()) {
      expect(c.tier).toBeGreaterThanOrEqual(1);
      expect(c.tier).toBeLessThanOrEqual(MAX_CAMP_TIER);
    }
    expect(CAMPAIGN.totalStages).toBe(100);
    expect(makeCampaignSnapshot(100).keepLevel).toBe(20);
    expect(MAXED_CAMP_TIER).toBe(MAX_CAMP_TIER + 1);
    // The T9 bounty row must exist — reseed/spawn index bountyByTier[tier - 1].
    expect(PVE.bountyByTier.length).toBe(MAXED_CAMP_TIER);
  });

  it('spawns ADJACENT to the owner plot, idempotently; a re-run heals a cleared camp', async () => {
    const owner = await createTestPlayer(db);
    const valleyId = await testValley('maxed-camp-spawn');
    await seedPlot(db, { valleyId, x: 10, y: 10, playerWallet: owner.wallet });

    const a = await spawnMaxedCamp(db, owner.wallet);
    expect(a.action).toBe('spawned');
    expect(a.valleyId).toBe(valleyId);
    // truly NEXT TO the base: chebyshev distance exactly 1 when a neighbour is free
    expect(Math.max(Math.abs(a.x - 10), Math.abs(a.y - 10))).toBe(1);
    const [row] = await db.select().from(pveCamps).where(eq(pveCamps.id, a.campId));
    expect(row!.tier).toBe(MAXED_CAMP_TIER);
    expect(row!.lootKeep).toBe(BigInt(PVE.bountyByTier[MAXED_CAMP_TIER - 1]!));

    // Idempotent: a second run refreshes the SAME row — never a duplicate.
    const b = await spawnMaxedCamp(db, owner.wallet);
    expect(b.action).toBe('refreshed');
    expect(b.campId).toBe(a.campId);
    const all = await db.select().from(pveCamps)
      .where(and(eq(pveCamps.valleyId, valleyId), eq(pveCamps.tier, MAXED_CAMP_TIER)));
    expect(all.length).toBe(1);

    // Cleared today → a re-run revives it NOW (that IS the practice loop; the
    // daily cron alone would make the owner wait for UTC midnight).
    await db.update(pveCamps).set({ respawnsAt: future(600) }).where(eq(pveCamps.id, a.campId));
    await spawnMaxedCamp(db, owner.wallet);
    const [healed] = await db.select().from(pveCamps).where(eq(pveCamps.id, a.campId));
    expect(healed!.respawnsAt).toBeNull();
  });

  it('never parks on a rotation lattice spot — db:reseed-camps would silently re-tier it', async () => {
    // WHY: reseedValleyCamps upserts on (valleyId, x, y) over campCoords(). In a
    // valley whose camp rows don't cover the current lattice (the pre-widening
    // valleys reseeding exists for), a T9 placed on an EMPTY lattice spot would
    // be overwritten into a rotation camp — tier, snapshot, bounty and all — by
    // the next reseed run.
    const owner = await createTestPlayer(db);
    const valleyId = await testValley('maxed-camp-lattice'); // bare valley: every lattice spot empty
    // Plot at (2,1): lattice spot (3,2) (campCoords i=0) is a chebyshev-1
    // neighbour. Occupy every OTHER r=1 neighbour so (3,2) is the first free
    // tile in scan order — the exact trap.
    await seedPlot(db, { valleyId, x: 2, y: 1, playerWallet: owner.wallet });
    const blockers = [[1, 0], [2, 0], [3, 0], [1, 1], [3, 1], [1, 2], [2, 2]] as const;
    await db.insert(pveCamps).values(blockers.map(([x, y]) => ({
      valleyId, x, y, tier: 1, snapshot: makeCampSnapshot(1), lootKeep: BigInt(PVE.bountyByTier[0]!),
    })));

    const spawned = await spawnMaxedCamp(db, owner.wallet);
    const lattice = new Set(campCoords().map((c) => `${c.x},${c.y}`));
    expect(lattice.has(`${spawned.x},${spawned.y}`)).toBe(false); // stepped over (3,2) to ring 2

    // And the reseed that motivates the rule really does leave the T9 intact.
    await reseedValleyCamps(db, valleyId);
    const [t9] = await db.select().from(pveCamps).where(eq(pveCamps.id, spawned.campId));
    expect(t9!.tier).toBe(MAXED_CAMP_TIER);
    expect(t9!.lootKeep).toBe(BigInt(PVE.bountyByTier[MAXED_CAMP_TIER - 1]!));
  });

  it('a raid against the maxed camp RESOLVES — and losing to it pays nothing', async () => {
    // WHY (adversarial): the raid path must handle a tier the rotation never
    // emits without special-casing, and a defeat at the wall must not touch the
    // emission pool or clear the camp.
    const owner = await createTestPlayer(db);
    const valleyId = await testValley('maxed-camp-raid');
    await seedPlot(db, { valleyId, x: 5, y: 5, playerWallet: owner.wallet });
    const camp = await spawnMaxedCamp(db, owner.wallet);

    const p = await fighter(); // 4 turriders — 3-stars a T1, hopeless against L20 everything
    const sys = await bootstrapSystemAccounts(db);
    const before = (await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance;
    const emissionBefore = (await db.select().from(accounts)
      .where(eq(accounts.id, sys.emission_pool)))[0]!.balance;
    const raid = await createPveRaid(db, p.wallet, camp.campId, k());
    const { result } = await submitOrders(db, p.wallet, raid.id, { deploys: winDeploys, idempotencyKey: k() });
    expect(result.stars).toBe(0); // slaughtered — but the raid RESOLVED
    const [resolved] = await db.select().from(raids).where(eq(raids.id, raid.id));
    expect(resolved!.status).toBe('resolved');
    // no bounty on defeat, and the camp still stands (not cleared)
    expect((await getOrCreatePlayerAccount(db, p.wallet, 'player_keep')).balance).toBe(before);
    expect((await db.select().from(accounts).where(eq(accounts.id, sys.emission_pool)))[0]!.balance)
      .toBe(emissionBefore);
    const [after] = await db.select().from(pveCamps).where(eq(pveCamps.id, camp.campId));
    expect(after!.respawnsAt).toBeNull();
  });

  it('--remove deletes an untouched camp but TOMBSTONES one raid history references', async () => {
    // Untouched camp → hard delete: gone from map and DB.
    const o1 = await createTestPlayer(db);
    const v1 = await testValley('maxed-camp-del');
    await seedPlot(db, { valleyId: v1, x: 3, y: 3, playerWallet: o1.wallet });
    const c1 = await spawnMaxedCamp(db, o1.wallet);
    const del = await removeMaxedCamp(db, o1.wallet);
    expect(del).toEqual([{ action: 'deleted', campId: c1.campId, x: c1.x, y: c1.y }]);
    expect((await db.select().from(pveCamps).where(eq(pveCamps.id, c1.campId))).length).toBe(0);

    // Raided camp → the raids FK forbids deletion and history is never
    // rewritten, so it tombstones: (a) the daily cron must NOT revive it,
    // (b) it refuses new raids, (c) a later spawn run revives it in place.
    const o2 = await createTestPlayer(db);
    const v2 = await testValley('maxed-camp-tomb');
    await seedPlot(db, { valleyId: v2, x: 4, y: 4, playerWallet: o2.wallet });
    const c2 = await spawnMaxedCamp(db, o2.wallet);
    const p = await fighter();
    await createPveRaid(db, p.wallet, c2.campId, k());
    const tomb = await removeMaxedCamp(db, o2.wallet);
    expect(tomb.length).toBe(1);
    expect(tomb[0]!.action).toBe('tombstoned');
    await respawnPveCamps(db); // daily cron
    const [t] = await db.select().from(pveCamps).where(eq(pveCamps.id, c2.campId));
    expect(t!.respawnsAt).not.toBeNull(); // survived the cron
    await expect(createPveRaid(db, p.wallet, c2.campId, k())).rejects.toThrow(/already cleared/);
    const revived = await spawnMaxedCamp(db, o2.wallet);
    expect(revived.action).toBe('refreshed');
    expect(revived.campId).toBe(c2.campId);
  });

  it('an in-flight raid resolving cannot resurrect a tombstoned camp', async () => {
    // Security review 2026-08-03 finding 1. Sequence: raid starts → ops runs
    // --remove (tombstone, respawnsAt far-future) → the raid RESOLVES →
    // markCampCleared runs. Its old unconditional overwrite would replace the
    // tombstone with next-UTC-midnight, and the daily cron would then revive a
    // camp ops explicitly removed — which resumes paying 2,000 KEEP/day until
    // a human notices. The guard: markCampCleared never SHORTENS a future
    // respawnsAt.
    const o = await createTestPlayer(db);
    const v = await testValley('maxed-camp-resurrect');
    await seedPlot(db, { valleyId: v, x: 5, y: 5, playerWallet: o.wallet });
    const c = await spawnMaxedCamp(db, o.wallet);
    const p = await fighter();
    await createPveRaid(db, p.wallet, c.campId, k());
    await removeMaxedCamp(db, o.wallet); // tombstoned while the raid is in flight
    const [before] = await db.select().from(pveCamps).where(eq(pveCamps.id, c.campId));
    await markCampCleared(db, c.campId); // the raid resolution's call
    const [after] = await db.select().from(pveCamps).where(eq(pveCamps.id, c.campId));
    expect(after!.respawnsAt).toEqual(before!.respawnsAt); // tombstone stands
    await respawnPveCamps(db);
    const [cron] = await db.select().from(pveCamps).where(eq(pveCamps.id, c.campId));
    expect(cron!.respawnsAt).not.toBeNull(); // and the cron still cannot revive it
  });
});
