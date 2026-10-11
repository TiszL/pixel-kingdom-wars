import { requiredFixture } from './helpers';
/**
 * Land Deed minting (Phase 6): best-effort, idempotent, NEVER blocks entry.
 * These tests encode the §8/§9 decoupling contract: the deed is record-keeping
 * (players.deed_asset_id) — a mint failure or missing config must leave the
 * game fully playable, and a deed can only ever be recorded once per player.
 */
import { readFileSync } from 'node:fs';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bases, baseSlots, players, plots } from '../src/db/schema';
import {
  configureDeedMinter, DEED_CLAIM_STALE_MS, mintDeedIfConfigured, reconcileMissingDeeds,
  type DeedMinter,
} from '../src/game/deed';
import { ensureWalletBaseIdentity } from '../src/game/baseOwnership';
import { isolateDeedTestFixtures } from './deed-fixtures';
import { bootstrapSystemAccounts } from '../src/ledger';
import { connectTestDb, createTestPlayer, createTestValley, randomWallet, seedPlot } from './helpers';

const conn = connectTestDb();
const db = conn.db;
const deedReservationMigration = readFileSync(
  new URL('../drizzle/0072_colossal_grey_gargoyle.sql', import.meta.url),
  'utf8',
);

let restoreDeedFixtures = async () => {};
beforeAll(async () => {
  await bootstrapSystemAccounts(db);
  restoreDeedFixtures = await isolateDeedTestFixtures(db, { pendingQueue: true });
});
afterAll(async () => {
  try { await restoreDeedFixtures(); } finally { await conn.sql.end(); }
});
afterEach(() => { configureDeedMinter(null); });

const mockDeedMinter = (
  assetFor: (operationId: string) => string,
  onMint: (owner: string, operationId: string, asset: string) => Promise<void> | void = () => {},
): DeedMinter => ({
  assetFor,
  mint: async (owner, operationId, asset) => {
    await onMint(owner, operationId, asset);
    return { asset };
  },
});

const deedOf = async (wallet: string): Promise<string | null> => {
  const [p] = await db.select({ d: players.deedAssetId }).from(players).where(eq(players.wallet, wallet));
  return p?.d ?? null;
};

/**
 * A player who BOUGHT THEIR LAND. Every minting test needs one, because since
 * free onboarding (2026-08-09) `mintDeedIfConfigured` refuses to mint for a
 * wallet with no `entryPaidAt` — the deed IS what the 0.2 SOL buys, and
 * GET /base (which calls it) is now a free route. Stamped directly here: the
 * on-chain credit is the deposit watcher's job, not this suite's.
 */
const paidPlayer = async (): Promise<{ wallet: string }> => {
  const p = await createTestPlayer(db);
  await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
  await ensureWalletBaseIdentity(db, p.wallet);
  return p;
};

describe('land deed minting', () => {
  it('is a no-op when no minter is configured (deeds disabled)', async () => {
    const p = await paidPlayer();
    await mintDeedIfConfigured(db, p.wallet);
    expect(await deedOf(p.wallet)).toBeNull();
  });

  it('mints once and records the asset; repeat calls do not re-mint', async () => {
    const p = await paidPlayer();
    let mints = 0;
    configureDeedMinter(mockDeedMinter(() => 'DeedAsset1', () => { mints++; }));
    await mintDeedIfConfigured(db, p.wallet);
    expect(await deedOf(p.wallet)).toBe('DeedAsset1');
    expect((await db.select({ deed: bases.deedAssetId }).from(bases)
      .where(eq(bases.ownerWallet, p.wallet)))[0]?.deed).toBe('DeedAsset1');
    await mintDeedIfConfigured(db, p.wallet); // already minted → no second mint
    expect(mints).toBe(1);
    expect(await deedOf(p.wallet)).toBe('DeedAsset1');
  });

  it('swallows mint failures (entry crediting must never depend on the deed)', async () => {
    const p = await paidPlayer();
    configureDeedMinter(mockDeedMinter(() => 'DeedHealed', () => { throw new Error('rpc down'); }));
    await expect(mintDeedIfConfigured(db, p.wallet)).resolves.toBeUndefined();
    expect(await deedOf(p.wallet)).toBeNull();
    // self-heal: a later call with a working minter succeeds
    configureDeedMinter(mockDeedMinter(() => 'DeedHealed'));
    await mintDeedIfConfigured(db, p.wallet);
    expect(await deedOf(p.wallet)).toBe('DeedHealed');
  });

  it('refuses to mint for a wallet that has NOT bought its land', async () => {
    // WHY THIS IS THE MOST IMPORTANT LINE IN THE FILE: mintDeedIfConfigured is
    // called from GET /base, and GET /base is FREE since onboarding stopped being
    // a paywall. The payment precondition used to live entirely in the call
    // sites; if it is ever moved back there, every visitor is minted a real,
    // collection-verified, royalty-bearing Land Deed for nothing and the deed
    // stops being the thing 0.2 SOL buys.
    const p = await createTestPlayer(db); // deliberately NOT paidPlayer()
    let mints = 0;
    configureDeedMinter(mockDeedMinter(() => 'UnpaidDeed', () => { mints++; }));
    for (let i = 0; i < 3; i++) await mintDeedIfConfigured(db, p.wallet);
    expect(mints).toBe(0);
    expect(await deedOf(p.wallet)).toBeNull();
    // Not merely deferred — buying the land is what releases it.
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await mintDeedIfConfigured(db, p.wallet);
    expect(mints).toBe(1);
    expect(await deedOf(p.wallet)).toBe('UnpaidDeed');
  });

  it('ignores unknown wallets safely', async () => {
    configureDeedMinter(mockDeedMinter(() => 'X'));
    await expect(mintDeedIfConfigured(db, 'NoSuchWallet1111111111111111111111111111111')).resolves.toBeUndefined();
  });

  it('worker reconciliation is bounded and only visits paid bases missing deeds', async () => {
    await Promise.all([paidPlayer(), paidPlayer(), paidPlayer()]);
    const planned = new Map((await db.select({
      id: bases.id, asset: bases.deedMintAssetId,
    }).from(bases)).map((row) => [row.id, row.asset]));
    let mints = 0;
    configureDeedMinter(mockDeedMinter(
      (operationId) => planned.get(operationId) ?? `ReconciledDeed-${operationId}`,
      () => { mints++; },
    ));
    const result = await reconcileMissingDeeds(db, 2);
    expect(result).toEqual({ attempted: 2 });
    expect(mints).toBe(2);
  });

  it('reconciles a paid inactive deed without consuming a sixth activation slot', async () => {
    const p = await paidPlayer();
    const [base] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, p.wallet));
    await db.update(bases).set({ status: 'inactive' }).where(eq(bases.id, base!.id));
    await db.delete(baseSlots).where(eq(baseSlots.baseId, base!.id));

    configureDeedMinter(mockDeedMinter((operationId) => `InactiveDeed-${operationId}`));
    for (let pass = 0; pass < 20; pass++) {
      await reconcileMissingDeeds(db, 10);
      const [current] = await db.select({ deed: bases.deedAssetId, status: bases.status })
        .from(bases).where(eq(bases.id, base!.id));
      if (current?.deed) {
        expect(current.status).toBe('inactive');
        expect(await db.select().from(baseSlots).where(eq(baseSlots.baseId, base!.id))).toHaveLength(0);
        return;
      }
    }
    throw new Error('bounded deed reconciliation never reached the paid inactive base');
  });
});

// ---------------------------------------------------------------------------
// Dynamic metadata endpoint (ITEMS plan §metadata, wired 2026-07-26). The deed's
// on-chain URI points HERE, so this route is what makes the NFT "dynamic": a
// wallet UI fetching it sees the base as it stands now, not as it was at mint.
// ---------------------------------------------------------------------------
import type { FastifyInstance } from 'fastify';
import { parcelCell } from '@shardkeep/shared/parcelGrid';
import { buildApp } from '../src/app';
import { earthCountries, valleys } from '../src/db/schema';
import { ensureStartingBase } from '../src/game/base';
import { transferBase } from '../src/game/baseTransfer';
import { buildDeedMetadata } from '../src/game/deedMetadata';
import { NO_SOVEREIGN_A3 } from '../src/lib/globeGeo';
import { TEST_CONFIG } from './helpers';

/**
 * A 0.5° cell whose country is not in doubt: `cellAtDeg(EARTH_FINE, 44.79, 41.71)`
 * — the 55 km box centred at 44.75°E 41.75°N, i.e. Tbilisi, Natural Earth `NAME`
 * "Georgia". Used by the two tests that need the STORED address to disagree with
 * the derived one; both do it inside a transaction they roll back, so the row never
 * commits — earth-address.test.ts asserts across the whole shared database that
 * every committed plot's cell equals `parcelCell(site_id, x, y)`, and that invariant
 * must survive this suite untouched.
 */
const TBILISI_CELL = 69_569;
const TBILISI_A3 = 'GEO';
const TBILISI_COUNTRY = 'Georgia';
/** A country the fixtures are never in, used to prove the document follows the
 *  COLUMN rather than the cell: France holds no cell anywhere near Chukotka. */
const OTHER_A3 = 'FRA';
const OTHER_COUNTRY = 'France';

/** Roll a transaction back on purpose (the pattern seeker.test.ts uses). */
class Rollback extends Error {}
const inRolledBackTx = async (fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>): Promise<void> => {
  try {
    await db.transaction(async (tx) => { await fn(tx); throw new Rollback(); });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
};

describe('deed dynamic metadata (GET /deed/:wallet.json)', () => {
  let app: FastifyInstance;
  let flagWas: string | undefined;
  beforeAll(async () => {
    app = await buildApp(TEST_CONFIG, db);
    await app.ready();
    // P6 SHIPS DARK, so the suite has to turn it on to assert the shipped shape.
    // The flag is read from the live env inside buildDeedMetadata (one reader,
    // three callers — config.deedLocationV2Enabled), which is also what lets the
    // rollback test below assert the OFF document in the same process.
    flagWas = process.env['DEED_LOCATION_V2'];
    process.env['DEED_LOCATION_V2'] = 'true';
  });
  afterAll(async () => {
    if (flagWas === undefined) delete process.env['DEED_LOCATION_V2'];
    else process.env['DEED_LOCATION_V2'] = flagWas;
    await app.close();
  });

  it('serves LIVE traits publicly — no auth, and upgrades show on the next fetch', async () => {
    const p = await createTestPlayer(db);
    // entryPaidAt is the deed gate (the route 404s without it — asserted below),
    // and the bare test helper deliberately does not stamp it.
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);

    // PUBLIC by design: wallet UIs and marketplace crawlers fetch the URI
    // anonymously — an auth wall here would blank every deed everywhere.
    const r1 = await app.inject({ url: `/deed/${p.wallet}.json` });
    expect(r1.statusCode).toBe(200);
    const m1 = r1.json() as { name: string; attributes: Array<{ trait_type: string; value: unknown }> };
    const trait = (m: typeof m1, t: string): unknown => m.attributes.find((a) => a.trait_type === t)?.value;
    expect(m1.name).toContain('Land Deed');
    expect(trait(m1, 'Keep Level')).toBe(1);
    expect(trait(m1, 'Buildings')).toBeGreaterThan(0); // starting base, live count

    // THE DYNAMIC CONTRACT: change the base, the SAME URI answers differently.
    // This is the whole reason the URI points at the api instead of static JSON.
    await db.update(players).set({ keepLevel: 9 }).where(eq(players.wallet, p.wallet));
    const r2 = await app.inject({ url: `/deed/${p.wallet}.json` });
    expect(trait(r2.json() as typeof m1, 'Keep Level')).toBe(9);
  });

  it('404s for unknown wallets and UNPAID players — no deed, nothing to describe', async () => {
    expect((await app.inject({ url: '/deed/1nc1nerator11111111111111111111111111111111.json' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/deed/not-base58!!.json' })).statusCode).toBe(404);
    // Unpaid: player row exists (helper never stamps entryPaidAt) → no deed.
    const ghost = await createTestPlayer(db);
    expect((await app.inject({ url: `/deed/${ghost.wallet}.json` })).statusCode).toBe(404);
  });

  // -------------------------------------------------------------------------
  // F2/F6/F7 (security review 2026-07-29, thaw blockers). The document is the
  // ONLY thing a marketplace buyer reads, so it must be addressed by the ASSET
  // and must not advertise anything the sale does not deliver.
  // -------------------------------------------------------------------------
  it('is addressed by the ASSET and resolves the deed\'s CURRENT holder', async () => {
    const p = await createTestPlayer(db);
    const asset = randomWallet();
    await db.update(players).set({ entryPaidAt: new Date(), deedAssetId: asset, keepLevel: 5 })
      .where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);

    const r = await app.inject({ url: `/deed/asset/${asset}.json` });
    expect(r.statusCode).toBe(200);
    const m = r.json() as { name: string; attributes: Array<{ trait_type: string; value: unknown }> };
    expect(m.attributes.find((a) => a.trait_type === 'Keep Level')?.value).toBe(5);
    // Named after the asset — a holder-derived name mislabels the deed on sale.
    expect(m.name).toContain(asset.slice(0, 4));
    expect(m.name).not.toContain(p.wallet.slice(0, 4));
    // An asset nobody holds describes nothing.
    expect((await app.inject({ url: `/deed/asset/${randomWallet()}.json` })).statusCode).toBe(404);
    expect((await app.inject({ url: '/deed/asset/not-base58!!.json' })).statusCode).toBe(404);
  });

  it('advertises ONLY what the sale delivers, and discloses what it does not', async () => {
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date(), trophies: 900, league: 'gold' })
      .where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);
    // A deeded Earth cell, so `Location` is present below. Without one it is omitted
    // (asserted in its own test), and this assertion would then pass for the wrong
    // reason — the four-trait set it used to pin.
    const vale = await createTestValley(db, {
      name: 'TRAIT SET VALE', createdAt: new Date('2000-01-07T00:00:00Z'),
    });
    await seedPlot(db, { valleyId: vale.id, x: 4, y: 2, playerWallet: p.wallet });
    const m = (await app.inject({ url: `/deed/${p.wallet}.json` })).json() as
      { description: string; attributes: Array<{ trait_type: string; value: unknown }> };

    /**
     * TRAITS: every one must MOVE in baseTransfer.ts. Trophies and League were
     * priced by buyers and delivered to nobody — transferBase leaves both with
     * the seller. A trait added here without a matching move is mis-selling.
     *
     * `Location` retains its public trait key for compatibility, but D-063 makes
     * the frozen `plots.earth_cell` its value. Internal allocation names and x/y
     * are not part of the deed's player-facing identity.
     *
     * `Country` AND `Tile` WERE ADDED ON PURPOSE (P6, 2026-08-10 Q3), and this list
     * is REWRITTEN here for the second time rather than patched until green. The
     * rule has not moved — only CONVEYING state may be a trait — and both new traits
     * pass it by the same conveying-row mechanism:
     *
     *  - THEY MOVE, AND FOR FREE. `plots.earth_cell` is a column on the very row
     *    `transferBase` re-points, so the Earth cell (and therefore the country that
     *    holds it) changes hands with the deed without a single extra line in
     *    baseTransfer.ts. "The country conveys" below proves it against the same
     *    asset id under a new holder — the assertion Trophies and League fail.
     *  - BOTH VALUES ARE FROZEN COLUMNS, NEVER THE MASK. This is the ONLY reason the
     *    owner's Q3 reversal is safe at all: migration 0053 wrote every parcel's cell
     *    down and 0054 wrote the `ADM0_A3` that holds it, and deedMetadata reads those
     *    columns plus the `earth_countries` registry — it imports nothing regenerable
     *    at all (asserted by the import scan in earth-address.test.ts). Regenerating
     *    the Earth data therefore cannot move a minted deed's stated country, which is
     *    exactly the objection that got Earth lat/lon refused on 2026-08-09. Freezing
     *    only the CELL was not enough, because the cell → country lookup itself runs
     *    through the mask's land enumeration and the index's rank-based ids (D1);
     *    "reads the FROZEN … column" below is the test that pins it, by making the
     *    stored cell and the stored country disagree with each other.
     *  - AND THE OWNER DECIDED THE DISCLOSURE, not this file: the deed collection is
     *    already readable with no auth, so this turns "wallet → valley + x,y" into
     *    "wallet → owns land in <country>". Recorded in EARTH-TILES-PLAN Q3/R12.
     */
    expect(m.attributes.map((a) => a.trait_type).sort())
      .toEqual(['Buildings', 'Country', 'Founded', 'Keep Level', 'Land', 'Location', 'Tile']);
    // Both public address fields come from the stored cell. The legacy valley name
    // and local 4,2 coordinate must not appear anywhere in the new document.
    const location = m.attributes.find((a) => a.trait_type === 'Location')?.value;
    // THE TILE IS THE STORED COLUMN, VERBATIM — read back from the database here so
    // this cannot pass against a re-derived value. The body is in the string from
    // day one (§5.3), so a Moon deed can never be mistaken for an Earth one.
    const [row] = await db.select({ cell: plots.earthCell }).from(plots)
      .where(eq(plots.playerWallet, p.wallet));
    expect(location).toBe(`Earth Cell ${row!.cell}`);
    expect(m.attributes.find((a) => a.trait_type === 'Tile')?.value).toBe(`Earth · ${row!.cell}`);
    expect(JSON.stringify(m)).not.toContain('TRAIT SET VALE');
    expect(JSON.stringify(m)).not.toContain('· 4,2');
    // A NAME, not a code and not a flag: Natural Earth `NAME` verbatim (R20). Every
    // claimable cell has a sovereign by construction, so a real parcel always has
    // one — the omission path is asserted separately.
    const country = m.attributes.find((a) => a.trait_type === 'Country')?.value;
    expect(typeof country).toBe('string');
    expect(country as string).toMatch(/^[^\d·]{2,}$/);
    for (const gone of ['Trophies', 'League', 'KEEP', 'Shards', 'Items', 'Army', 'Heroes', 'Streak']) {
      expect(m.attributes.some((a) => a.trait_type === gone)).toBe(false);
    }

    // DISCLOSURE: the non-conveying set and the one-base rule, on the asset.
    for (const term of ['KEEP', 'Shard', 'items', 'army', 'training queue', 'troop research',
      'hero levels', 'trophies', 'league', 'streaks']) {
      expect(m.description).toContain(term);
    }
    expect(m.description).toContain('ONE BASE PER WALLET');
    expect(m.description).toContain('DOES NOT CONVEY');
  });

  it('the LOCATION conveys: the same asset names the same Earth cell for its new holder', async () => {
    // The frozen cell travels on the plot row with the asset; allocator place names
    // and x/y remain private implementation details.
    const seller = await createTestPlayer(db);
    const asset = randomWallet();
    await db.update(players).set({ entryPaidAt: new Date(), deedAssetId: asset })
      .where(eq(players.wallet, seller.wallet));
    await ensureStartingBase(db, seller.wallet);
    const vale = await createTestValley(db, {
      name: 'CONVEYANCE VALE', createdAt: new Date('2000-01-08T00:00:00Z'),
    });
    await seedPlot(db, { valleyId: vale.id, x: 12, y: 8, playerWallet: seller.wallet });

    const locationOf = async (url: string): Promise<unknown> => {
      const r = await app.inject({ url });
      expect(r.statusCode).toBe(200);
      const doc = r.json() as { attributes: Array<{ trait_type: string; value: unknown }> };
      return doc.attributes.find((a) => a.trait_type === 'Location')?.value;
    };

    const [seeded] = await db.select({ cell: plots.earthCell }).from(plots)
      .where(eq(plots.playerWallet, seller.wallet));
    const expectedLocation = `Earth Cell ${seeded!.cell}`;
    expect(await locationOf(`/deed/asset/${asset}.json`)).toBe(expectedLocation);

    // A baseless buyer claims the deed — the real path, not a hand-written UPDATE.
    const buyer = await createTestPlayer(db);
    const moved = await transferBase(db, seller.wallet, buyer.wallet, asset);
    expect(moved.plot, 'the plot row is what makes Location conveying state').toBe(true);

    // THE ASSET is what a marketplace holds and re-fetches, and it now describes
    // the buyer's base — same frozen Earth cell, new owner.
    expect(await locationOf(`/deed/asset/${asset}.json`)).toBe(expectedLocation);
    expect(await locationOf(`/deed/${buyer.wallet}.json`)).toBe(expectedLocation);
    // And the seller kept nothing to describe: transferBase clears their
    // entryPaidAt, so there is no second document claiming the same parcel.
    expect((await app.inject({ url: `/deed/${seller.wallet}.json` })).statusCode).toBe(404);
  });

  it('the COUNTRY conveys: the same asset names the same Earth tile for its new holder', async () => {
    // THE SAME SHAPE AS THE LOCATION CONVEYANCE TEST, and for the same reason — it is
    // what makes Country and Tile legitimate traits rather than mis-selling. The
    // mechanism is one level deeper and needs NO code in baseTransfer.ts:
    // `plots.earth_cell` is a column on the row `transferBase` re-points, so the
    // county and the country ride along with the deed exactly as the coordinates do.
    // `git diff --stat apps/api/src/game/baseTransfer.ts` is empty for this phase
    // (R6), and this test is the proof that "empty diff" is not "not implemented".
    const seller = await createTestPlayer(db);
    const asset = randomWallet();
    await db.update(players).set({ entryPaidAt: new Date(), deedAssetId: asset })
      .where(eq(players.wallet, seller.wallet));
    await ensureStartingBase(db, seller.wallet);
    const vale = await createTestValley(db, {
      name: 'COUNTRY VALE', createdAt: new Date('2000-01-09T00:00:00Z'),
    });
    await seedPlot(db, { valleyId: vale.id, x: 12, y: 8, playerWallet: seller.wallet });
    const [seeded] = await db.select({ cell: plots.earthCell, a3: plots.countryA3 }).from(plots)
      .where(eq(plots.playerWallet, seller.wallet));

    const earthOf = async (url: string): Promise<{ country: unknown; tile: unknown }> => {
      const r = await app.inject({ url });
      expect(r.statusCode).toBe(200);
      const doc = r.json() as { attributes: Array<{ trait_type: string; value: unknown }> };
      const at = (t: string): unknown => doc.attributes.find((a) => a.trait_type === t)?.value;
      return { country: at('Country'), tile: at('Tile') };
    };

    const before = await earthOf(`/deed/asset/${asset}.json`);
    // A real parcel always has a sovereign: its cell came from `claimableCells`,
    // which is "land cells with a country" ∪ the sub-tile countries' cells. And the
    // name is the one the FROZEN code resolves to in the `earth_countries` registry —
    // pinned to the stored code here, so "conveys" cannot pass on an empty trait.
    const [registry] = await db.select({ name: earthCountries.name })
      .from(earthCountries).where(eq(earthCountries.a3, requiredFixture(seeded!.a3)));
    expect(registry!.name, 'the frozen code must resolve to a name').toBeTruthy();
    expect(before.country).toBe(registry!.name);
    expect(before.tile).toBe(`Earth · ${seeded!.cell}`);

    const buyer = await createTestPlayer(db);
    const moved = await transferBase(db, seller.wallet, buyer.wallet, asset);
    expect(moved.plot, 'the plots row is what carries earth_cell + country_a3 to the buyer').toBe(true);

    // SAME ASSET, SAME LAND, NEW HOLDER — read through the asset (what a marketplace
    // re-fetches) and through the buyer's own document.
    expect(await earthOf(`/deed/asset/${asset}.json`)).toEqual(before);
    expect(await earthOf(`/deed/${buyer.wallet}.json`)).toEqual(before);
    // Neither column moved: conveyance is the ROW changing hands, not the address or
    // the sovereign changing. If this fails, a transfer re-addressed land — and note
    // baseTransfer.ts needed no diff for the country either, because it is a column on
    // the row it already re-points (R6).
    const [after] = await db.select({ cell: plots.earthCell, a3: plots.countryA3 }).from(plots)
      .where(eq(plots.playerWallet, buyer.wallet));
    expect(after!.cell).toBe(seeded!.cell);
    expect(after!.a3).toBe(seeded!.a3);
  });

  it('reads the FROZEN plots.earth_cell column, never a re-derived one', async () => {
    /**
     * THE TEST THE WHOLE PHASE RESTS ON (EARTH-TILES-PLAN R4 + the Q3 lock), and it
     * is STRONGER since D1 (2026-08-10) because the first version of this phase only
     * froze half of what a deed prints.
     *
     * `parcelCell(site_id, x, y)` would answer the same CELL as the column today, and
     * calling it would still be wrong: it reads the generated Earth mask, which
     * `earth:mask` may rebuild. But the country was worse than that — it was
     * recomputed on every request by `countryIdOfCell(mask, index, cell)`, which
     * resolves the cell to a RANK in the mask's land enumeration and reads a
     * rank-based id out of the index. One land cell gained anywhere below the cell
     * shifts every rank after it, so a regenerated mask could have moved a minted
     * deed's stated country while the address stayed put. Both halves are columns now.
     *
     * SO THIS TEST MAKES THE TWO DISAGREE, TWICE:
     *  1. the stored CELL is moved to Georgia while `country_a3` keeps saying what it
     *     said — and the document must still say the COLUMN's country, proving the
     *     country is not derived from the cell (i.e. the mask is not consulted);
     *  2. `country_a3` is then set to France on that same Georgian cell — a state no
     *     real parcel could have — and the document must say France, proving the
     *     country comes from the column and nowhere else.
     *
     * If someone "simplifies" deedMetadata back to a cell → country lookup, (2) fails
     * and the message is the reason.
     *
     * IN A ROLLED-BACK TRANSACTION: the mismatch must never commit, because
     * earth-address.test.ts asserts across the whole shared database that every plot's
     * cell equals `parcelCell(site_id, x, y)` and its country matches that cell.
     * `buildDeedMetadata` takes a `DbOrTx`, so the document can be built inside the
     * transaction that will vanish.
     */
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);
    const vale = await createTestValley(db, {
      name: 'FROZEN VALE', createdAt: new Date('2000-01-12T00:00:00Z'),
    });
    await seedPlot(db, { valleyId: vale.id, x: 3, y: 3, playerWallet: p.wallet });
    const derived = parcelCell(vale.siteId, 3, 3);
    expect(derived, 'the fixture is pointless unless the two disagree').not.toBe(TBILISI_CELL);
    const [seeded] = await db.select({ a3: plots.countryA3 }).from(plots)
      .where(eq(plots.playerWallet, p.wallet));
    expect(seeded!.a3, 'the fixture must not already be in Georgia').not.toBe(TBILISI_A3);

    await inRolledBackTx(async (tx) => {
      // (1) the cell moves to Georgia; the frozen country does not move with it.
      await tx.update(plots).set({ earthCell: TBILISI_CELL })
        .where(eq(plots.playerWallet, p.wallet));
      const m1 = await buildDeedMetadata(tx, p.wallet);
      const at1 = (t: string): unknown => m1!.attributes.find((a) => a.trait_type === t)?.value;
      expect(at1('Country'), 'the country must NOT be derived from the stored cell')
        .not.toBe(TBILISI_COUNTRY);
      expect(at1('Tile')).toBe(`Earth · ${TBILISI_CELL}`);
      // Location is the stored cell too; neither value is re-derived from the
      // allocator's site/x/y mapping.
      expect(at1('Location')).toBe(`Earth Cell ${TBILISI_CELL}`);

      // (2) now the COLUMN says France on that Georgian cell — and so must the deed.
      await tx.update(plots).set({ countryA3: OTHER_A3 })
        .where(eq(plots.playerWallet, p.wallet));
      const m2 = await buildDeedMetadata(tx, p.wallet);
      const at2 = (t: string): unknown => m2!.attributes.find((a) => a.trait_type === t)?.value;
      expect(at2('Country'), 'the country must come from plots.country_a3').toBe(OTHER_COUNTRY);
      expect(at2('Tile')).toBe(`Earth · ${TBILISI_CELL}`);
    });

    // …and with the columns back to what they were, the same builder answers
    // differently, which is what proves the assertions above read the columns at all.
    const m = await buildDeedMetadata(db, p.wallet);
    const at = (t: string): unknown => m!.attributes.find((a) => a.trait_type === t)?.value;
    expect(at('Tile')).toBe(`Earth · ${derived}`);
    expect(at('Country')).not.toBe(OTHER_COUNTRY);
  });

  it('claims no Earth country for a parcel on another body', async () => {
    // ADDENDUM C: `valleys.planet_id` exists so a second body is additive, and
    // nothing in P0–P6 may hard-code planet 0 outside that column's default. Cell ids
    // are MASK-RELATIVE and the `earth_countries` registry is Earth's, so a Moon
    // parcel that happened to store cell 69569 must NOT be advertised as land in
    // Georgia — the traits are omitted until whoever adds the Moon adds its own rows.
    // Rolled back like the test above: this row would otherwise be a Moon plot
    // sitting on an Earth address.
    //
    // ITS COUNTRY IS THE `ZZZ` SENTINEL, which is what migration 0054 writes for any
    // body this atlas does not describe, and which has no registry row on purpose —
    // so BOTH the planet gate and the missing name independently omit the trait.
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);

    await inRolledBackTx(async (tx) => {
      // site 0 on planet 1 is free: the unique is (planet_id, site_id) since 0053.
      const [moon] = await tx.insert(valleys)
        .values({ name: 'MOON VALE', siteId: 0, planetId: 1 }).returning({ id: valleys.id });
      await tx.insert(plots).values({
        valleyId: moon!.id, x: 3, y: 3, playerWallet: p.wallet,
        earthCell: TBILISI_CELL, countryA3: NO_SOVEREIGN_A3,
      });
      const m = await buildDeedMetadata(tx, p.wallet);
      const types = m!.attributes.map((a) => a.trait_type).sort();
      expect(types).not.toContain('Country');
      expect(types).not.toContain('Tile');
      // This renderer has no immutable non-Earth address vocabulary yet, so it
      // omits Location rather than publishing allocator names or Earth fiction.
      expect(types).not.toContain('Location');
      expect(JSON.stringify(m)).not.toContain('MOON VALE');
    });
  });

  it('never falls back to allocator identity when DEED_LOCATION_V2 is off', async () => {
    // D-063 supersedes the old valley/x,y Location. Feature rollback may omit the
    // Earth address, but it must never republish the internal allocation address.
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);
    const vale = await createTestValley(db, {
      name: 'FLAG OFF VALE', createdAt: new Date('2000-01-13T00:00:00Z'),
    });
    await seedPlot(db, { valleyId: vale.id, x: 5, y: 5, playerWallet: p.wallet });

    process.env['DEED_LOCATION_V2'] = 'false';
    try {
      const m = await buildDeedMetadata(db, p.wallet);
      expect(m!.attributes.map((a) => a.trait_type).sort())
        .toEqual(['Buildings', 'Founded', 'Keep Level', 'Land']);
      const json = JSON.stringify(m);
      expect(json).not.toContain('Country');
      expect(json).not.toContain('Tile');
      expect(json).not.toContain('Location');
      expect(json).not.toContain('FLAG OFF VALE');
      expect(json).not.toContain('5,5');
      expect(json).not.toContain('Earth');
    } finally {
      process.env['DEED_LOCATION_V2'] = 'true';
    }
    // …and back on, the same wallet gains the Earth-cell address fields.
    const on = await buildDeedMetadata(db, p.wallet);
    expect(on!.attributes.map((a) => a.trait_type).sort())
      .toEqual(['Buildings', 'Country', 'Founded', 'Keep Level', 'Land', 'Location', 'Tile']);
  });

  it('omits Location rather than inventing one when there is no parcel yet', async () => {
    // WHY: a paid wallet exists for a moment before ensurePlotAssigned runs (the
    // deposit watcher does both in one branch), and a deed document is public the
    // whole time. "Location: unknown" on a land title is worse than silence, and a
    // guessed one would be a lie about where someone's land is — so the trait is
    // absent, exactly as GlobeSectorValley.active is absent rather than zeroed.
    const p = await createTestPlayer(db);
    await db.update(players).set({ entryPaidAt: new Date() }).where(eq(players.wallet, p.wallet));
    await ensureStartingBase(db, p.wallet);

    const m = (await app.inject({ url: `/deed/${p.wallet}.json` })).json() as
      { attributes: Array<{ trait_type: string; value: unknown }> };
    expect(m.attributes.map((a) => a.trait_type).sort())
      .toEqual(['Buildings', 'Founded', 'Keep Level', 'Land']);
    expect(JSON.stringify(m)).not.toContain('Location');
    // AND NO COUNTRY OR TILE EITHER, with the flag ON (this suite turns it on): no
    // plot row means no frozen `earth_cell`, and there is nothing else to read — a
    // country inferred from anything else would be a guess about where a stranger's
    // land is, which is worse on a title than silence.
    expect(JSON.stringify(m)).not.toContain('Country');
    expect(JSON.stringify(m)).not.toContain('Tile');
  });
});

describe('the mint claim is atomic, not best-effort', () => {
  /**
   * THE BUG THIS CLOSES. The guard used to be an in-process Set whose .add()
   * ran one `await` after the membership check, so two overlapping callers both
   * passed it. That is not a theoretical race: the entry credit fires a mint
   * (money/depositWatcher.ts) at the same moment as the client's first
   * GET /base poll (game/routes.ts), which is the highest-concurrency instant
   * in a player's whole session.
   *
   * The `deed_asset_id IS NULL` write guard stopped the second ID being
   * RECORDED — which is why this looked harmless — but not the second NFT being
   * MINTED. Deeds are tradeable (MARKETPLACE.tradingEnabled) and minted
   * unfrozen, so the orphan is a real, collection-verified, royalty-bearing
   * Land Deed that conveys nothing: base claim only ever matches the recorded
   * id, so whoever buys the orphan gets an empty asset.
   */
  it('mints ONCE when two callers race, not twice', async () => {
    const p = await paidPlayer();
    let mints = 0;
    configureDeedMinter(mockDeedMinter(() => 'RaceAsset1', async () => {
      mints++;
      // Hold the mint open long enough for the second caller to get all the way
      // through its own guard — an RPC round trip, not an instant return.
      await new Promise((r) => setTimeout(r, 50));
    }));

    await Promise.all([
      mintDeedIfConfigured(db, p.wallet),
      mintDeedIfConfigured(db, p.wallet),
    ]);

    expect(mints).toBe(1);                       // fails on the old in-process Set
    expect(await deedOf(p.wallet)).toBe('RaceAsset1');
  });

  it('releases the claim when a mint fails, so the next poll retries', async () => {
    // Without the release, one failed mint parks the player for the full 5-minute
    // staleness window with no deed — and the self-heal on GET /base is the only
    // reason minting is allowed to be best-effort at all.
    const p = await paidPlayer();
    configureDeedMinter(mockDeedMinter(() => 'RetryAsset', () => { throw new Error('rpc exploded'); }));
    await mintDeedIfConfigured(db, p.wallet);
    expect(await deedOf(p.wallet)).toBeNull();

    let mints = 0;
    configureDeedMinter(mockDeedMinter(() => 'RetryAsset', () => { mints++; }));
    await mintDeedIfConfigured(db, p.wallet); // must NOT be blocked by a stuck claim
    expect(mints).toBe(1);
    expect(await deedOf(p.wallet)).toBe('RetryAsset');
  });

  it('recovers an ambiguous landed send with one fixed asset and no orphan mint', async () => {
    // The dangerous failure is "chain accepted create, RPC threw". A timestamp
    // claim alone cannot distinguish it from "nothing landed" and the old
    // random-signer retry minted a second tradeable deed. This fake chain
    // records the first send before throwing, then answers the retry's exact-id
    // lookup. There must be one send and one durable id throughout.
    const p = await paidPlayer();
    const fixedAsset = 'ExactlyOnceDeed';
    const landed = new Set<string>();
    let sends = 0;
    configureDeedMinter({
      assetFor: () => fixedAsset,
      mint: async (_owner, _operationId, expectedAsset) => {
        if (landed.has(expectedAsset)) return { asset: expectedAsset };
        sends++;
        landed.add(expectedAsset);
        throw new Error('RPC timed out after the create landed');
      },
    });

    await mintDeedIfConfigured(db, p.wallet);
    expect(await deedOf(p.wallet)).toBeNull();
    const [pending] = await db.select({ expected: bases.deedMintAssetId }).from(bases)
      .where(eq(bases.ownerWallet, p.wallet));
    expect(pending?.expected).toBe(fixedAsset);

    await mintDeedIfConfigured(db, p.wallet);
    expect(sends).toBe(1);
    expect([...landed]).toEqual([fixedAsset]);
    expect(await deedOf(p.wallet)).toBe(fixedAsset);
    const [attached] = await db.select({ expected: bases.deedMintAssetId, deed: bases.deedAssetId })
      .from(bases).where(eq(bases.ownerWallet, p.wallet));
    expect(attached).toEqual({ expected: fixedAsset, deed: fixedAsset });
  });

  it('fails closed when a rotated admin key derives a different asset', async () => {
    const p = await paidPlayer();
    let broadcasts = 0;
    configureDeedMinter(mockDeedMinter(
      () => 'AssetFromOriginalKey',
      () => { broadcasts++; throw new Error('ambiguous send'); },
    ));
    await mintDeedIfConfigured(db, p.wallet);
    expect(broadcasts).toBe(1);

    // A new process/key cannot overwrite the durable plan or broadcast its new
    // signer. Restoring the original key/address remains recoverable.
    configureDeedMinter(mockDeedMinter(
      () => 'AssetFromRotatedKey',
      () => { broadcasts++; },
    ));
    await mintDeedIfConfigured(db, p.wallet);
    expect(broadcasts).toBe(1);
    expect(await deedOf(p.wallet)).toBeNull();
    expect((await db.select({ expected: bases.deedMintAssetId }).from(bases)
      .where(eq(bases.ownerWallet, p.wallet)))[0]?.expected).toBe('AssetFromOriginalKey');

    configureDeedMinter(mockDeedMinter(() => 'AssetFromOriginalKey', () => { broadcasts++; }));
    await mintDeedIfConfigured(db, p.wallet);
    expect(broadcasts).toBe(2);
    expect(await deedOf(p.wallet)).toBe('AssetFromOriginalKey');
  });

  it('a live claim survives a restart — it is in the DB, not in a process', async () => {
    // The claim column is what makes this cross-process. Simulated by stamping the
    // row directly (as a crashed peer would have left it) and confirming a fresh
    // caller declines rather than minting a duplicate.
    const p = await paidPlayer();
    const fixedAsset = 'RestartedFixedAsset';
    const stamp = new Date();
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('shardkeep.fixed_deed_mint_claim', 'on', true)`);
      await tx.update(bases).set({ deedMintAssetId: fixedAsset, deedMintingAt: stamp })
        .where(eq(bases.ownerWallet, p.wallet));
      await tx.update(players).set({ deedMintAssetId: fixedAsset, deedMintingAt: stamp })
        .where(eq(players.wallet, p.wallet));
    });
    let mints = 0;
    configureDeedMinter(mockDeedMinter(() => fixedAsset, () => { mints++; }));
    await mintDeedIfConfigured(db, p.wallet);
    expect(mints).toBe(0);
    expect(await deedOf(p.wallet)).toBeNull();
  });

  it('reclaims a STALE claim so a crashed mint cannot orphan a player forever', async () => {
    const p = await paidPlayer();
    const stale = new Date(Date.now() - DEED_CLAIM_STALE_MS - 60_000);
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('shardkeep.fixed_deed_mint_claim', 'on', true)`);
      await tx.update(bases).set({ deedMintingAt: stale, deedMintAssetId: 'ReclaimedAsset' })
        .where(eq(bases.ownerWallet, p.wallet));
      await tx.update(players).set({ deedMintingAt: stale, deedMintAssetId: 'ReclaimedAsset' })
        .where(eq(players.wallet, p.wallet));
    });
    let mints = 0;
    configureDeedMinter(mockDeedMinter(() => 'ReclaimedAsset', () => { mints++; }));
    await mintDeedIfConfigured(db, p.wallet);
    expect(mints).toBe(1);
    expect(await deedOf(p.wallet)).toBe('ReclaimedAsset');
  });

  it('never replaces a legacy ambiguous claim whose random signer is unknown', async () => {
    const p = await paidPlayer();
    const [base] = await db.select({ id: bases.id }).from(bases)
      .where(eq(bases.ownerWallet, p.wallet));
    await db.update(bases).set({ deedMintAssetId: `legacy-unknown:${base!.id}` })
      .where(eq(bases.id, base!.id));
    let mints = 0;
    configureDeedMinter(mockDeedMinter(() => 'UnsafeReplacement', () => { mints++; }));
    await mintDeedIfConfigured(db, p.wallet);
    expect(mints).toBe(0);
    expect(await deedOf(p.wallet)).toBeNull();
  });

  it('rejects the deployed old conditional claim before its broadcaster can run', async () => {
    // Mixed-version regression: the deployed pre-0072 query writes only the
    // player timestamp and treats UPDATE ... RETURNING as permission to invoke
    // a random-signer minter. The trigger must abort that statement. Merely
    // synthesizing a sentinel still returns a row and therefore still mints.
    const p = await paidPlayer();
    let broadcasts = 0;
    const runOldClaim = async (): Promise<void> => {
      try {
        const claimed = await db.update(players).set({ deedMintingAt: new Date() }).where(and(
          eq(players.wallet, p.wallet),
          isNotNull(players.entryPaidAt),
          isNull(players.deedAssetId),
          or(
            isNull(players.deedMintingAt),
            lt(players.deedMintingAt, new Date(Date.now() - DEED_CLAIM_STALE_MS)),
          ),
        )).returning({ wallet: players.wallet });
        if (claimed.length > 0) broadcasts++;
      } catch {
        // This is the deployed old function's outer best-effort catch. The key
        // assertion is that execution never reaches its broadcaster.
      }
    };
    await runOldClaim();
    expect(broadcasts).toBe(0);
    expect((await db.select({ claim: players.deedMintingAt }).from(players)
      .where(eq(players.wallet, p.wallet)))[0]?.claim).toBeNull();
    await expect(db.update(bases).set({ deedMintingAt: new Date() })
      .where(eq(bases.ownerWallet, p.wallet))).rejects.toMatchObject({ cause: { code: '23514' } });

    // Exact-id presence alone must not authorize the old random-signer code: an
    // old pod can race a released new-code retry during a rolling deployment.
    await db.update(bases).set({ deedMintAssetId: 'FixedRetryOwnedByNewCode' })
      .where(eq(bases.ownerWallet, p.wallet));
    await db.update(players).set({ deedMintAssetId: 'FixedRetryOwnedByNewCode' })
      .where(eq(players.wallet, p.wallet));
    await runOldClaim();
    expect(broadcasts).toBe(0);
    await expect(db.update(bases).set({ deedMintingAt: new Date() })
      .where(eq(bases.ownerWallet, p.wallet))).rejects.toMatchObject({ cause: { code: '23514' } });
  });

  it('0072 quarantines historical paid deedless rows even after an old catch cleared the lease', () => {
    // A NULL timestamp cannot distinguish "never sent" from "landed, RPC threw,
    // catch cleared". The migration must quarantine the entire historical paid
    // deedless set and require a new-code transaction marker for future claims.
    expect(deedReservationMigration.match(/legacy timestamp-only deed mint writer is fenced/g))
      .toHaveLength(2);
    expect(deedReservationMigration)
      .not.toContain("NEW.deed_mint_asset_id := 'legacy-unknown:");
    expect(deedReservationMigration)
      .toContain('AND ("land_paid_at" IS NOT NULL OR "deed_minting_at" IS NOT NULL)');
    expect(deedReservationMigration)
      .toContain('AND (p."entry_paid_at" IS NOT NULL OR p."deed_minting_at" IS NOT NULL)');
    expect(deedReservationMigration)
      .toContain('WHERE b."owner_wallet" = p."wallet" AND b."deed_asset_id" IS NOT NULL');
    expect(deedReservationMigration)
      .toContain("current_setting('shardkeep.fixed_deed_mint_claim', true)");
  });
});
