import { requiredFixture } from './helpers';
/**
 * P5 — A PARCEL'S ADDRESS ON EARTH IS NOW A STORED FACT (docs/EARTH-TILES-PLAN.md).
 *
 * Since P4 the cell was DERIVED from `parcelCell(site_id, x, y)`, which was safe
 * only while nothing outside the process depended on the answer. The owner then
 * decided the COUNTRY GOES ON THE DEED (2026-08-10 Q3), and P6 will read it — so
 * from here on the address must be something a rebuild of the Earth data cannot
 * move.
 *
 * D1 (2026-08-10) FOUND THE HALF THAT WAS STILL MOVING: the address was frozen, but
 * the deed still asked the mask + index for the COUNTRY per request, and that lookup
 * goes through the mask's land enumeration and the index's rank-based ids — both
 * renumbered by a regeneration. So `plots.country_a3` and the `earth_countries`
 * registry now freeze the answer itself (migration 0054), the deed path imports
 * nothing regenerable, and Earth running out fails as a product state rather than a
 * stack trace. That is what this file guards, in layers:
 *
 *  1. THE COLUMN EXISTS FOR EVERY PLOT AND CANNOT BE SKIPPED — NOT NULL, written in
 *     the same INSERT that creates the plot.
 *  2. NO TWO PARCELS SHARE A CELL — UNIQUE, i.e. two deeds can never convey one
 *     55 km county.
 *  3. THE MIGRATION'S EMBEDDED ADDRESS BOOK IS THE SAME PLANET the code computes.
 *     `drizzle-kit migrate` is a pure-SQL runner, so migration 0053 carries the
 *     120 × 491 result of `patchCells` as data; this re-derives all 58,920 numbers
 *     and fails on a single difference. That is also R15's freeze: regenerating the
 *     mask now breaks a test instead of silently relocating royalty-bearing land.
 *  4. THE GENERATED EARTH DATA IS PINNED BY CONTENT HASH, so a regeneration is a
 *     deliberate migration rather than an invisible build step — the addresses are
 *     a pure function of exactly these three artefacts.
 *
 * Plus the planet dimension: `valleys.planet_id` defaults to 0 and site ids are
 * unique WITHIN a planet, which is what makes a second body additive later.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { and, asc, eq, sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { WORLD } from '@shardkeep/shared';
import { claimableCells, countryIdOfCell, countryOfId } from '@shardkeep/shared/globe';
import { EARTH_COARSE } from '@shardkeep/shared/earthMask';
import { EARTH_FINE } from '@shardkeep/shared/earthMaskFine';
import { EARTH_COUNTRIES_FINE } from '@shardkeep/shared/earthCountriesFine';
import {
  PARCELS_PER_PATCH, fillIndex, parcelCapacity, parcelCell, patchCount, tileOfFillIndex,
} from '@shardkeep/shared/parcelGrid';
import { earthCountries, plots, valleys } from '../src/db/schema';
import { EARTH_FULL_CODE, campCoords, ensurePlotAssigned, plotFillOrder } from '../src/game/world';
import { NO_SOVEREIGN_A3, globeGeo, setGlobeGeo } from '../src/lib/globeGeo';
import {
  connectTestDb, countryA3OfCell, createTestPlayer, createTestValley, seedPlots,
} from './helpers';

const conn = connectTestDb();
const db = conn.db;
afterAll(async () => { await conn.sql.end(); });

const MIGRATION = new URL('../drizzle/0053_parcel_earth_cell.sql', import.meta.url);
const COUNTRY_MIGRATION = new URL('../drizzle/0054_parcel_country.sql', import.meta.url);

describe('a plot always has an Earth cell, and only one plot has each', () => {
  it('test valleys fill a low Earth gap even when a high site already exists', async () => {
    // Land-purchase tests may create a selected high site before older fixture
    // helpers run. A max+1 allocator would treat that sparse row as a full prefix
    // and eventually invent site 120; the fixture must mirror production's
    // lowest-unused policy instead.
    const highSite = patchCount() - 1;
    const [existingHigh] = await db.select({ id: valleys.id }).from(valleys)
      .where(and(eq(valleys.planetId, 0), eq(valleys.siteId, highSite)));
    const [sentinel] = existingHigh ? [] : await db.insert(valleys)
      .values({ name: 'TEST HIGH-SITE SENTINEL', planetId: 0, siteId: highSite })
      .returning({ id: valleys.id });
    let created: { id: string; siteId: number } | undefined;
    try {
      const used = await db.select({ siteId: valleys.siteId }).from(valleys)
        .where(eq(valleys.planetId, 0)).orderBy(asc(valleys.siteId));
      const taken = new Set(used.map((row) => row.siteId));
      let expected = 0;
      while (taken.has(expected)) expected++;
      expect(expected).toBeLessThan(patchCount());

      created = await createTestValley(db, { name: 'LOWEST GAP VALE' });
      expect(created.siteId).toBe(expected);
      expect(() => parcelCell(created!.siteId, 0, 0)).not.toThrow();
    } finally {
      if (created) await db.delete(valleys).where(eq(valleys.id, created.id));
      if (sentinel) await db.delete(valleys).where(eq(valleys.id, sentinel.id));
    }
  });

  it('signup writes the cell in the same INSERT as the plot', async () => {
    // WHY: a plot that exists for even one transaction without its address is a
    // plot whose address could then be computed against a different mask. So the
    // value is not a later UPDATE, and it is the SAME function the client and the
    // deed use — not a second opinion living in the server.
    const p = await createTestPlayer(db);
    const at = await ensurePlotAssigned(db, p.wallet);
    const [row] = await db.select({ earthCell: plots.earthCell, x: plots.x, y: plots.y })
      .from(plots).where(eq(plots.playerWallet, p.wallet));
    const [v] = await db.select({ siteId: valleys.siteId }).from(valleys).where(eq(valleys.id, at.valleyId));
    expect(row!.earthCell).toBe(parcelCell(v!.siteId, at.x, at.y));
    expect(row!.earthCell).toBeGreaterThan(0);
    // Idempotent: a second call returns the same plot, so the address cannot drift.
    await ensurePlotAssigned(db, p.wallet);
    const again = await db.select({ earthCell: plots.earthCell })
      .from(plots).where(eq(plots.playerWallet, p.wallet));
    expect(again.length).toBe(1);
    expect(again[0]!.earthCell).toBe(row!.earthCell);
  });

  it('EVERY plot in the database agrees with parcelCell, and no two share a cell', async () => {
    // The invariant P6 will rest on, asserted over whatever rows the suite has
    // produced so far rather than over a fixture: if any writer of `plots` ever
    // invents its own cell — or forgets one — this is where it shows up.
    const rows = await db.select({
      earthCell: plots.earthCell, x: plots.x, y: plots.y, siteId: valleys.siteId,
    }).from(plots).innerJoin(valleys, eq(valleys.id, plots.valleyId));
    expect(rows.length).toBeGreaterThan(0);
    const mismatched = rows.filter((r) => r.earthCell !== parcelCell(r.siteId, requiredFixture(r.x), requiredFixture(r.y)));
    expect(mismatched).toEqual([]);
    expect(new Set(rows.map((r) => r.earthCell)).size).toBe(rows.length);
  });

  it('refuses a plot with no Earth cell, and a cell that is already taken', async () => {
    // Both are DB-level, because the DB is the only layer that can actually refuse
    // them: application code can be bypassed by an ops script or a future writer.
    const v = await createTestValley(db, {
      name: 'ADDRESS VALE', createdAt: new Date('2000-01-10T00:00:00Z'),
    });
    try {
      const noCell = await db.execute(
        sql`insert into plots (valley_id, x, y) values (${v.id}, 1, 1)`,
      ).then(() => null, (e: unknown) => e);
      expect(noCell, 'a plot without an Earth cell must be impossible').not.toBeNull();
      expect(String((noCell as { cause?: { code?: string } }).cause?.code
        ?? (noCell as { code?: string }).code)).toBe('23514'); // dual-address CHECK requires all legacy fields

      const noCountry = await db.execute(
        sql`insert into plots (valley_id, x, y, earth_cell) values (${v.id}, 1, 1, ${parcelCell(v.siteId, 1, 1)})`,
      ).then(() => null, (e: unknown) => e);
      expect(noCountry, 'a plot without a frozen country must be impossible').not.toBeNull();
      expect(String((noCountry as { cause?: { code?: string } }).cause?.code
        ?? (noCountry as { code?: string }).code)).toBe('23514'); // dual-address CHECK requires all legacy fields

      const cell = parcelCell(v.siteId, 1, 1);
      const a3 = countryA3OfCell(cell);
      await db.insert(plots).values({ valleyId: v.id, x: 1, y: 1, earthCell: cell, countryA3: a3 });
      const dup = await db.insert(plots)
        .values({ valleyId: v.id, x: 2, y: 2, earthCell: cell, countryA3: a3 })
        .then(() => null, (e: unknown) => e);
      expect(dup, 'two parcels on one Earth cell is two deeds on one place').not.toBeNull();
      const constraint = String((dup as { cause?: { constraint_name?: string } }).cause?.constraint_name
        ?? (dup as { constraint_name?: string }).constraint_name ?? '');
      expect(constraint).toContain('plots_earth_cell_uq');
    } finally {
      // PUT THE WORLD BACK — every suite shares one database, and a leftover
      // camp-less valley becomes somebody else's home.
      await db.delete(plots).where(eq(plots.valleyId, v.id));
      await db.delete(valleys).where(eq(valleys.id, v.id));
    }
  });

  it('gives a PvE camp tile no address at all', () => {
    // R2: camps hold a grid tile but are not deeded land. The consequence of P5 is
    // that a plot on a camp tile is now unrepresentable — `parcelCell` refuses to
    // invent an address, so the row cannot be written rather than being written
    // with a cell that belongs to somebody else.
    for (const c of campCoords()) {
      expect(() => parcelCell(0, c.x, c.y)).toThrow(/PvE camp/);
    }
    expect(campCoords().length).toBe(WORLD.campsPerValley);
  });
});

describe('a plot always has a frozen COUNTRY, and only a migration can move it', () => {
  it('signup writes country_a3 in the same INSERT, and it matches the cell', async () => {
    // D1: freezing the CELL was not enough. The deed used to ask
    // `countryIdOfCell(mask, index, cell)` per request, and that lookup runs through
    // the mask's land ENUMERATION (`landCellRank`) and the index's rank-based ids —
    // both of which a regeneration renumbers — so the same frozen cell could have
    // printed a different country after a build step. The ADM0_A3 is now written
    // down with the address, in one statement, by the same code path.
    const p = await createTestPlayer(db);
    const at = await ensurePlotAssigned(db, p.wallet);
    const [row] = await db.select({ cell: plots.earthCell, a3: plots.countryA3 })
      .from(plots).where(eq(plots.playerWallet, p.wallet));
    expect(row!.a3).toBe(countryA3OfCell(requiredFixture(row!.cell)));
    expect(row!.a3).toMatch(/^[A-Z]{3}$/);
    // A REAL PARCEL ALWAYS HAS A SOVEREIGN, and the server refuses the seat rather
    // than writing the sentinel: claimable Earth is "land cells with a country" ∪
    // the sub-tile countries' cells, so 'ZZZ' here would mean the mask and the index
    // have diverged — which must stop a signup, not produce a countryless deed.
    expect(row!.a3).not.toBe(NO_SOVEREIGN_A3);
    expect(at.x).toBeGreaterThanOrEqual(0);
  });

  it('EVERY plot in the database names the country its stored cell is in', async () => {
    // Over whatever rows the suite has produced, not a fixture: if any writer of
    // `plots` ever invents a country — or copies a neighbour's — this is where it
    // shows up. Paired with the cell invariant above, it says the two columns are
    // consistent with each other AND with the Earth data as it stands today, which
    // is the only moment that comparison is legitimate: after a regeneration this
    // test is SUPPOSED to fail, and the fix is a migration, not an edit here.
    const rows = await db.select({ cell: plots.earthCell, a3: plots.countryA3, planetId: valleys.planetId })
      .from(plots).innerJoin(valleys, eq(valleys.id, plots.valleyId));
    expect(rows.length).toBeGreaterThan(0);
    const wrong = rows.filter((r) => r.planetId === 0 && r.a3 !== countryA3OfCell(requiredFixture(r.cell)));
    expect(wrong).toEqual([]);
    // …and nothing on Earth carries the no-sovereign sentinel.
    expect(rows.filter((r) => r.planetId === 0 && r.a3 === NO_SOVEREIGN_A3)).toEqual([]);
  });

  it('refuses a malformed country code at the database level', async () => {
    // The failure mode this prevents is the quiet one: a lowercase or padded code
    // finds no `earth_countries` row, so the deed OMITS the Country trait and looks
    // merely incomplete rather than broken.
    const v = await createTestValley(db, {
      name: 'SHAPE VALE', createdAt: new Date('2000-01-13T00:00:00Z'),
    });
    try {
      for (const bad of ['geo', 'GE', 'GEOR', '', 'G3O']) {
        const e = await db.insert(plots)
          .values({ valleyId: v.id, x: 1, y: 1, earthCell: parcelCell(v.siteId, 1, 1), countryA3: bad })
          .then(() => null, (err: unknown) => err);
        expect(e, `country_a3 '${bad}' must be refused`).not.toBeNull();
        expect(String((e as { cause?: { constraint_name?: string } }).cause?.constraint_name
          ?? (e as { constraint_name?: string }).constraint_name ?? ''))
          .toContain('plots_country_a3_shape');
      }
    } finally {
      await db.delete(valleys).where(eq(valleys.id, v.id));
    }
  });

  it('carries the whole country registry, and the sentinel is deliberately absent', async () => {
    // THE NAMING AUTHORITY IS THIS TABLE, not the generated index — that is what lets
    // game/deedMetadata.ts import nothing regenerable. So the table must agree with
    // the index TODAY (a data refresh then arrives as a red test plus a migration,
    // R15) and must be total: every id the index can produce has a row.
    const rows = await db.select().from(earthCountries).orderBy(asc(earthCountries.a3));
    expect(rows.length).toBe(EARTH_COUNTRIES_FINE.countries.length);
    expect(rows.length).toBe(240);
    const byA3 = new Map(rows.map((r) => [r.a3, r.name]));
    for (const c of EARTH_COUNTRIES_FINE.countries) {
      expect(byA3.get(c.a3), `registry is missing ${c.a3}`).toBe(c.name);
    }
    // Spot-checks a reader can verify by eye, including the mirror's two patched
    // names and the one apostrophe (a quoting bug in the seed would land here).
    expect(byA3.get('GEO')).toBe('Georgia');
    expect(byA3.get('MKD')).toBe('North Macedonia');
    expect(byA3.get('SWZ')).toBe('eSwatini');
    expect(byA3.get('CIV')).toBe("Côte d'Ivoire");
    // THE SENTINEL HAS NO NAME, ON PURPOSE: a parcel with no sovereign gets no
    // Country trait rather than a fabricated one. And it can never collide with a
    // real code, which is why ZZZ was chosen (ISO 3166-1 user-assigned range).
    expect(byA3.has(NO_SOVEREIGN_A3)).toBe(false);
    expect(EARTH_COUNTRIES_FINE.countries.some((c) => c.a3 === NO_SOVEREIGN_A3)).toBe(false);
    expect(NO_SOVEREIGN_A3).toMatch(/^[A-Z]{3}$/); // storable in the same column
  });

  it('names the 170 countries that own tiles WITHOUT hiding the 70 that do not', () => {
    // OWNER DECISION D2 (2026-08-10): 70 of 240 countries have no ownable tile at
    // 0.5°, that is ACCEPTED, and it must be visible rather than papered over — so
    // the registry lists every country the data knows and the tile count is measured,
    // not assumed. Re-streaming `claimableCells` to reach the other 70 was rejected:
    // it would relocate production's live valley.
    const seated = new Set<string>();
    for (let site = 0; site < patchCount(); site++) {
      for (let i = 0; i < PARCELS_PER_PATCH; i++) {
        const t = tileOfFillIndex(i);
        seated.add(countryA3OfCell(parcelCell(site, t.x, t.y)));
      }
    }
    expect(seated.has(NO_SOVEREIGN_A3)).toBe(false);
    expect(seated.size).toBe(170);
    expect(EARTH_COUNTRIES_FINE.countries.length - seated.size).toBe(70);
    // The 70 are a fact about the patch stream, not about the countries: each one
    // has a claimable cell, it just never falls inside a patch.
    const claimable = new Set<string>();
    for (const cell of claimableCells(EARTH_FINE, EARTH_COUNTRIES_FINE)) {
      claimable.add(countryOfId(EARTH_COUNTRIES_FINE, countryIdOfCell(EARTH_FINE, EARTH_COUNTRIES_FINE, cell))!.a3);
    }
    expect(claimable.size).toBe(240);
  });
});

describe('migration 0054 carries the same countries the code computes', () => {
  const sqlText = readFileSync(COUNTRY_MIGRATION, 'utf8');

  it('keeps the add-nullable → backfill → assert → tighten split', () => {
    // drizzle's generated form is a single `ADD COLUMN … NOT NULL`, which cannot
    // succeed where rows already exist (0044 / 0052 / 0053 all hit that wall). If a
    // regeneration ever collapses the split, this is the tripwire.
    const add = sqlText.indexOf('ADD COLUMN "country_a3" text;');
    const backfill = sqlText.indexOf('UPDATE "plots" p SET "country_a3"');
    const assert = sqlText.indexOf('RAISE EXCEPTION \'country backfill left');
    const sentinel = sqlText.indexOf('UPDATE "plots" SET "country_a3" = \'ZZZ\'');
    const notNull = sqlText.indexOf('ALTER COLUMN "country_a3" SET NOT NULL');
    const shape = sqlText.indexOf('ADD CONSTRAINT "plots_country_a3_shape"');
    expect(add).toBeGreaterThan(-1);
    expect(sqlText).not.toContain('ADD COLUMN "country_a3" text NOT NULL');
    expect(add).toBeLessThan(backfill);
    expect(backfill).toBeLessThan(assert);
    expect(assert).toBeLessThan(sentinel);
    expect(sentinel).toBeLessThan(notNull);
    expect(notNull).toBeLessThan(shape);
    // The registry has to exist before the column that reads it, and the backfill is
    // EARTH-ONLY: cell ids are mask-relative, so another body's cell is not an
    // address in this atlas.
    expect(sqlText.indexOf('CREATE TABLE "earth_countries"')).toBeLessThan(add);
    expect(sqlText).toContain('v."planet_id" = 0');
  });

  it('embeds a cell → country atlas that equals countryIdOfCell, run for run', () => {
    // THE LOAD-BEARING TEST, the analogue of 0053's address-book check: the migration
    // cannot call TypeScript, so it carries the RESULT as data, and that is only safe
    // while the data is machine-checked against the functions the server writes with.
    const runs: Array<[number, number, string]> = [];
    for (const m of sqlText.matchAll(/\((\d+),(\d+),'([A-Z]{3})'\)/g)) {
      runs.push([Number(m[1]), Number(m[2]), m[3]!]);
    }
    expect(runs.length).toBe(3_991);
    let covered = 0;
    let prevHi = -1;
    for (const [lo, hi, a3] of runs) {
      expect(lo).toBeGreaterThan(prevHi); // ascending, non-overlapping
      expect(hi).toBeGreaterThanOrEqual(lo);
      prevHi = hi;
      for (let cell = lo; cell <= hi; cell++) {
        if (countryA3OfCell(cell) !== a3) {
          throw new Error(
            `migration 0054 puts cell ${cell} in ${a3}, but the country index says `
            + `${countryA3OfCell(cell)}. The Earth data was regenerated: that is a MIGRATION `
            + 'with a backfill, not a build step (R15).',
          );
        }
        covered++;
      }
    }
    // …and it covers EVERY claimable cell, so no plot can ever fall outside it.
    const claimable = claimableCells(EARTH_FINE, EARTH_COUNTRIES_FINE);
    expect(covered).toBe(claimable.length);
    expect(covered).toBe(61_903);
    for (const cell of [claimable[0]!, claimable[claimable.length - 1]!, 69_569]) {
      expect(runs.some(([lo, hi]) => cell >= lo && cell <= hi), `cell ${cell} unaddressed`).toBe(true);
    }
  });

  it('pins the atlas by content hash, independently of its three inputs', () => {
    // Same argument as 0053's address-book hash: the inputs could change in ways that
    // cancel out; what a deed depends on is the OUTPUT. This number must not move
    // while any deed names a country.
    const flat = [...sqlText.matchAll(/\((\d+),(\d+),'([A-Z]{3})'\)/g)]
      .map((m) => `${m[1]}-${m[2]}-${m[3]}`).join(',');
    expect(createHash('sha256').update(flat).digest('hex'))
      .toBe('2ce9e7f6625bf2245fff1002ae85c4b693ac5ea6302eb7f2d0372aa1c1f29d27');
  });
});

describe('the deed path cannot reach the Earth data at all (D1)', () => {
  const SRC = new URL('../src/', import.meta.url);
  const REGENERABLE = ['earthMask', 'earthCountries', 'parcelGrid', 'shared/globe', 'globeGeo'];

  const importsOf = (rel: string): string[] => {
    const text = readFileSync(new URL(rel, SRC), 'utf8');
    return [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]!);
  };

  it('pins every import in game/deedMetadata.ts', () => {
    // THE WHOLE SAFETY PROPERTY, STATED AS A LIST. If a future change adds an import
    // of the mask, the country index, `parcelGrid` or even `lib/globeGeo` (which
    // reaches all three), this fails and the reason is right here: a deed is
    // published on a chain that cannot be recalled, so it may only read columns.
    expect(importsOf('game/deedMetadata.ts').sort()).toEqual([
      '../config',
      '../db/client',
      '../db/schema',
      './fantasyLocationRead',
      './footprints',
      '@shardkeep/chain',
      '@shardkeep/shared/baseVisual',
      'drizzle-orm',
    ]);
  });

  it('and nothing it imports, transitively, reaches them either', () => {
    // A one-file assertion would be satisfied by moving the lookup one hop away, so
    // the whole reachable graph inside apps/api is walked. Bare specifiers are not
    // followed (they are packages), which is why the two that appear above are named
    // explicitly: `drizzle-orm` is a query builder and `@shardkeep/chain` imports no
    // globe data (grep: zero hits for the mask, the index or parcelGrid).
    const seen = new Set<string>();
    const bare = new Set<string>();
    const walk = (rel: string): void => {
      if (seen.has(rel)) return;
      seen.add(rel);
      for (const spec of importsOf(rel)) {
        if (!spec.startsWith('.')) { bare.add(spec); continue; }
        const base = new URL(spec, new URL(rel, SRC)).pathname.replace(new URL(SRC).pathname, '');
        for (const cand of [`${base}.ts`, `${base}/index.ts`, base]) {
          try { readFileSync(new URL(cand, SRC)); walk(cand); break; } catch { /* next */ }
        }
      }
    };
    walk('game/deedMetadata.ts');
    expect(seen.size).toBeGreaterThan(3); // the walk actually walked
    const offenders = [...seen, ...bare].filter((s) => REGENERABLE.some((b) => s.includes(b)));
    expect(offenders).toEqual([]);
    // The write path, by contrast, MUST reach them — otherwise nothing would be
    // frozen and this suite would be guarding an empty promise.
    expect(importsOf('lib/globeGeo.ts').some((s) => s.includes('earthCountriesFine'))).toBe(true);
    expect(importsOf('game/world.ts').some((s) => s.includes('globeGeo'))).toBe(true);
  });
});

describe('Earth sells out, and it says so instead of 500ing (D4)', () => {
  it('refuses the signup BEFORE minting an orphan valley, with a typed reason', async () => {
    // THE MOMENT THE WHOLE FINITE-EARTH DECISION EXISTS FOR (owner Q1: selling out is
    // what unlocks the next planet). Before this guard the order of events was the
    // worst available: `createValley` committed a valley at site `patchCount()` with
    // its 9 camps and published it through `invalidateGlobe()`, and only THEN did
    // `parcelCell` throw a raw `Error: Earth is full` — so every subsequent signup
    // 500ed and an unusable valley was left on the map.
    //
    // Driven through the seam rather than by creating 120 real valleys: the planet in
    // force reports a capacity that is already reached, which is exactly what the
    // 121st valley would see. `parcelCell` stays REAL, so if the guard is removed the
    // signup SUCCEEDS (a fresh site is still addressable) and this test fails — that
    // is the mutation check.
    const vale = await createTestValley(db, {
      // Far-future so it is unambiguously the newest valley `ensurePlotAssigned`
      // picks, whatever else the shared database holds.
      name: 'SOLD OUT VALE', createdAt: new Date('2099-01-01T00:00:00Z'),
    });
    const camps = new Set(campCoords().map((c) => `${c.x},${c.y}`));
    const deeded = plotFillOrder().filter(([x, y]) => !camps.has(`${x},${y}`));
    expect(deeded.length).toBe(PARCELS_PER_PATCH);
    const real = globeGeo();
    try {
      // Fill it: every deeded tile taken (no wallets needed — occupancy is what
      // `tryAssignInValley` reads), so the signup must roll over.
      await seedPlots(db, deeded.map(([x, y]) => ({ valleyId: vale.id, x, y })));
      setGlobeGeo({ ...real, patchCount: () => vale.siteId + 1 });
      const before = await db.select({ id: valleys.id, siteId: valleys.siteId }).from(valleys)
        .where(eq(valleys.planetId, 0)).orderBy(asc(valleys.siteId), asc(valleys.id));

      const p = await createTestPlayer(db);
      const err = await ensurePlotAssigned(db, p.wallet).then(() => null, (e: unknown) => e);
      expect(err, 'a full Earth must refuse the seat').not.toBeNull();
      expect(err).toMatchObject({ statusCode: 503, code: EARTH_FULL_CODE });
      // The message is for a human in an incident: it says the planet is out of land
      // and that retrying will not help, and it quotes the real ceiling.
      expect(String((err as Error).message)).toContain('sold out');
      expect(String((err as Error).message)).toContain(String(vale.siteId + 1));
      expect(String((err as Error).message)).toMatch(/not resolve by retrying/);

      // NO ORPHAN: the entire Earth valley registry is unchanged. Sparse selected
      // sites may legitimately be numerically above this test's low-gap site, so
      // `site_id > vale.siteId` is not evidence of a new row.
      const after = await db.select({ id: valleys.id, siteId: valleys.siteId }).from(valleys)
        .where(eq(valleys.planetId, 0)).orderBy(asc(valleys.siteId), asc(valleys.id));
      expect(after).toEqual(before);
    } finally {
      setGlobeGeo(null);
      await db.delete(plots).where(eq(plots.valleyId, vale.id));
      await db.delete(valleys).where(eq(valleys.id, vale.id));
    }
  });

  it('still refuses when the ceiling is reached the real way', () => {
    // The guard is the FIRST line of defence, not the only one: `patchCells` throws
    // past the last patch in `shared`, which is what makes a wrap — two deeds on one
    // 55 km county — unrepresentable rather than merely unlikely.
    expect(() => parcelCell(patchCount(), 0, 0)).toThrow(/Earth is full/);
    expect(parcelCapacity()).toBe(patchCount() * PARCELS_PER_PATCH);
  });
});

describe('the planet dimension (§5.3) is additive', () => {
  it('defaults every valley to Earth and makes site ids unique WITHIN a planet', async () => {
    // WHY: Earth is finite (120 patches / 58,920 parcels) and selling out is what
    // unlocks the next body, so the schema must be able to hold a second one
    // without a rewrite. `UNIQUE (planet_id, site_id)` is that, and the DB is the
    // only layer that can refuse two valleys on one pin.
    const v = await createTestValley(db, {
      name: 'PLANET VALE', createdAt: new Date('2000-01-11T00:00:00Z'),
    });
    try {
      const [row] = await db.select({ planetId: valleys.planetId })
        .from(valleys).where(eq(valleys.id, v.id));
      expect(row!.planetId).toBe(0);

      const clash = await db.insert(valleys).values({ name: 'PLANET CLASH', siteId: v.siteId })
        .then(() => null, (e: unknown) => e);
      expect(clash, 'the same site on the same planet must be refused').not.toBeNull();

      // …and the SAME site id on ANOTHER planet is a different place, so it is fine.
      const moon = await db.insert(valleys)
        .values({ name: 'PLANET VALE MOON', siteId: v.siteId, planetId: 1 })
        .returning({ id: valleys.id });
      expect(moon[0]!.id).toBeTruthy();
      await db.delete(valleys).where(eq(valleys.id, moon[0]!.id));
    } finally {
      await db.delete(valleys).where(eq(valleys.id, v.id));
    }
  });
});

describe('migration 0053 carries the same planet the code computes', () => {
  const sqlText = readFileSync(MIGRATION, 'utf8');

  it('keeps the four-statement split, so it can apply to a POPULATED table', () => {
    // drizzle's generated form is a single `ADD COLUMN … NOT NULL`, which cannot
    // succeed where rows already exist (0044/0052 hit the same wall). If a future
    // regeneration collapses the split, this is the tripwire.
    const add = sqlText.indexOf('ADD COLUMN "earth_cell" integer;');
    const backfill = sqlText.indexOf('UPDATE "plots" p SET "earth_cell"');
    const notNull = sqlText.indexOf('ALTER COLUMN "earth_cell" SET NOT NULL');
    const uniq = sqlText.indexOf('ADD CONSTRAINT "plots_earth_cell_uq"');
    expect(add).toBeGreaterThan(-1);
    expect(sqlText).not.toContain('ADD COLUMN "earth_cell" integer NOT NULL');
    expect(add).toBeLessThan(backfill);
    expect(backfill).toBeLessThan(notNull);
    expect(notNull).toBeLessThan(uniq);
    // The composite unique deliberately REUSES the old constraint name so that
    // `isSiteIdCollision` still recognises a raced allocation during the
    // migration-first deploy window (R18).
    expect(sqlText).toContain('ADD CONSTRAINT "valleys_site_id_uq" UNIQUE("planet_id","site_id")');
  });

  it('embeds all 58,920 addresses, and every one equals parcelCell', () => {
    // THE LOAD-BEARING TEST. The migration cannot call TypeScript, so it carries
    // the result as data; that is only safe while the data is machine-checked
    // against the function production writes with.
    const book = new Map<number, number[]>();
    for (const m of sqlText.matchAll(/^ {2}\((\d+),'([\d,]+)'\)/gm)) {
      book.set(Number(m[1]), m[2]!.split(',').map(Number));
    }
    expect(book.size).toBe(patchCount());
    expect(patchCount()).toBe(120);
    expect(parcelCapacity()).toBe(58_920);

    const seen = new Set<number>();
    let checked = 0;
    for (const [siteId, cells] of book) {
      expect(cells.length).toBe(PARCELS_PER_PATCH);
      for (let i = 0; i < cells.length; i++) {
        const t = tileOfFillIndex(i);
        expect(fillIndex(t.x, t.y)).toBe(i);
        if (cells[i] !== parcelCell(siteId, t.x, t.y)) {
          throw new Error(
            `migration 0053 addresses patch ${siteId} index ${i} to cell ${cells[i]}, but `
            + `parcelCell says ${parcelCell(siteId, t.x, t.y)}. The Earth data was regenerated: `
            + 'that is a MIGRATION with a backfill, not a build step (R15).',
          );
        }
        seen.add(cells[i]!);
        checked++;
      }
    }
    expect(checked).toBe(58_920);
    expect(seen.size).toBe(58_920); // no cell is handed out twice
  });
});

describe('the generated Earth data is frozen by content hash (R15)', () => {
  it('pins the three artefacts every stored address is derived from', () => {
    // A parcel's address is a pure function of: the COARSE mask (the Hilbert site
    // walk that anchors patch order), the FINE mask (the cells themselves) and the
    // FINE country index (which cells are claimable at all). Regenerating any of
    // them can move an address that is now written into `plots.earth_cell` and,
    // after P6, into a minted deed — so a regeneration must arrive as a deliberate
    // change with a backfill, and it must not be able to arrive any other way.
    //
    // TO REGENERATE ON PURPOSE: update these hashes IN THE SAME COMMIT as a
    // migration that re-addresses every existing plot, and re-run the P5 proof.
    // If only the numbers below change, land was moved silently.
    const h = (b: Uint8Array): string =>
      createHash('sha256').update(Buffer.from(b.buffer, b.byteOffset, b.byteLength)).digest('hex');

    expect(h(EARTH_COARSE.bits)).toBe('d0c328be4938eed7e290e8bb45d0891cb1cafed92737dccf2b888ce4e6d0dd27');
    expect(EARTH_COARSE.landCells).toBe(5_432);
    expect(h(EARTH_FINE.bits)).toBe('a8d4906e98c09b3682c188fedc4e457ebf1c9af21aac15612bf39ccfb719b26a');
    expect(EARTH_FINE.landCells).toBe(86_122);
    expect(h(EARTH_COUNTRIES_FINE.cells))
      .toBe('072e2caa5456374900f14362a8d83e0578921706ea12236d308eccdd8a0c969c');
    expect(h(new Uint8Array(
      EARTH_COUNTRIES_FINE.extraCells.buffer,
      EARTH_COUNTRIES_FINE.extraCells.byteOffset,
      EARTH_COUNTRIES_FINE.extraCells.byteLength,
    ))).toBe('3ec150cf3369c368faca0236030bd6179584e3f0845b6f1a72783b78fd33d555');
    expect(EARTH_COUNTRIES_FINE.extraCells.length).toBe(57);
    expect(EARTH_COUNTRIES_FINE.countries.length).toBe(240);
  });

  it('pins the address book itself, independently of the three inputs', () => {
    // The inputs could in principle change in a way that cancels out; what a deed
    // depends on is the OUTPUT. This is the one number that must never move while
    // any deed names a country.
    const flat: number[] = [];
    for (let s = 0; s < patchCount(); s++) {
      for (let i = 0; i < PARCELS_PER_PATCH; i++) {
        const t = tileOfFillIndex(i);
        flat.push(parcelCell(s, t.x, t.y));
      }
    }
    expect(createHash('sha256').update(flat.join(',')).digest('hex'))
      .toBe('ee1f90dc9221c7035f56f5ec82911be4ed12f4a4bb8f0ae232ed0fdc66ac7542');
  });
});
