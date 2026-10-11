/**
 * Land Deed metadata (ITEMS plan §metadata) — the ONE builder of a deed's
 * Metaplex-standard JSON, shared by:
 *  - GET /deed/asset/:assetId.json (the URI every deed now carries on chain),
 *  - GET /deed/:wallet.json (legacy alias, see below), and
 *  - the R2 pusher (deedR2.ts) that publishes the same JSON to a public bucket
 *    when the api itself is NOT publicly reachable (owner 2026-07-26: local dev
 *    box + Cloudflare R2).
 *
 * ASSET-KEYED, NOT WALLET-KEYED (security review 2026-07-29 F2, thaw blocker):
 * the document is addressed by the deed's asset id and BUILT from whoever holds
 * that deed's base right now. The wallet is only ever an intermediate lookup —
 * it never appears in the URI, and no longer in the name. A wallet-keyed
 * document broke the moment deeds became tradeable: the buyer's asset kept
 * pointing at the seller's document (so the NFT rendered the seller's rebuilt
 * base) and the seller's replacement deed collided on the same URI.
 *
 * Traits are LIVE server state — that is what makes the deed dynamic. INV-1
 * stands: gameplay never reads deed/DAS state; this is presentation-only.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { deedAssetName } from '@shardkeep/chain';
import { deedLocationV2Enabled, multiBaseEnabled } from '../config';
import type { DbOrTx } from '../db/client';
import { bases, buildings, earthCountries, players, plots, valleys } from '../db/schema';
import { claimRect } from './footprints';
import { REALM_NAMES } from '@shardkeep/shared/baseVisual';
import { resolveFantasyLocation } from './fantasyLocationRead';

/**
 * THIS FILE IMPORTS NOTHING THAT CAN BE REGENERATED, AND THAT IS A REQUIREMENT
 * (D1, 2026-08-10). Not the Earth masks, not the country index, not `parcelGrid`,
 * and not `lib/globeGeo.ts` which reaches all three. Every real-world fact a deed
 * prints comes out of a COLUMN: `plots.earth_cell` (the address, migration 0053),
 * `plots.country_a3` (the sovereign, migration 0054) and the `earth_countries`
 * registry (the name). See the Country trait below for why a request-time lookup
 * was not good enough even with the address frozen.
 * Fantasy locations likewise use persisted claims and the immutable, versioned
 * catalog. Terrain paintings never decide NFT identity or allocation.
 */

/**
 * The PUBLIC base URL deed assets are served from — the same host that serves
 * the deed JSON, so a wallet that loaded the JSON can always load its picture.
 * Preference mirrors the minter (jobs.ts): the R2 bucket first, then the api's
 * own public host. Never a localhost fallback: a deed pointing at localhost is
 * dead for everyone but this machine, which is exactly the bug this fixes.
 */
export function deedAssetBase(): string | null {
  const base = process.env['R2_PUBLIC_BASE_URL'] ?? process.env['DEED_METADATA_BASE_URL'];
  if (!base) return null;
  const clean = base.replace(/\/$/, '');
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i.test(clean) ? null : clean;
}

/** Public URL of a rendered base image. Stable multi-deed images are keyed by
 * the deed asset; the wallet alias remains only for legacy single-base URIs. */
export function deedImageUrl(wallet: string, assetId?: string | null): string {
  const base = deedAssetBase();
  const path = assetId ? `/deed/asset/${assetId}.png` : `/deed/${wallet}.png`;
  return base ? `${base}${path}` : path;
}

/** The wallet whose base a deed asset currently conveys — the server registry
 *  (`players.deed_asset_id`, unique) is the authority, so this follows a claim
 *  the instant baseTransfer commits. Null when the asset is unknown here. */
export async function deedHolderWallet(db: DbOrTx, assetId: string): Promise<string | null> {
  if (multiBaseEnabled()) {
    const [base] = await db.select({ wallet: bases.ownerWallet }).from(bases)
      .where(eq(bases.deedAssetId, assetId));
    return base?.wallet ?? null;
  }
  const [p] = await db.select({ wallet: players.wallet }).from(players)
    .where(eq(players.deedAssetId, assetId));
  return p?.wallet ?? null;
}

/**
 * Deeds whose published document is known to be WRONG right now — currently
 * only a completed claim, which swaps the base under an asset without changing
 * anything the R2 reconciler's content hash would notice on its own timetable.
 * The sweep drains this and force-pushes, so a buyer's asset stops describing
 * the seller's base within one sweep instead of waiting for a trait to move.
 * Module-level (like the deed minter registry) so the claim path can signal it
 * without importing the renderer.
 */
const dirtyDeeds = new Set<string>();

export function markDeedDirty(assetId: string): void {
  dirtyDeeds.add(assetId);
}

/** True if this asset needs a forced republish; the sweep clears it only after
 *  a SUCCESSFUL put, so a failed push stays dirty and retries. */
export function isDeedDirty(assetId: string): boolean {
  return dirtyDeeds.has(assetId);
}

export function clearDeedDirty(assetId: string): void {
  dirtyDeeds.delete(assetId);
}

export interface DeedMetadata {
  name: string;
  symbol: 'DEED';
  description: string;
  external_url: string;
  image: string;
  attributes: Array<{ trait_type: string; value: string | number }>;
}

/**
 * What the deed does and does NOT convey, stated on the asset itself (security
 * review 2026-07-29 F6/F7 — a marketplace buyer sees only this document).
 * The legacy description remains truthful while the compatibility mode is off.
 * In multi-base mode playable state is keyed by stable base_id, so ownership of
 * the deed changes authority without copying or recreating economic state.
 */
const DEED_DESCRIPTION =
  'A sovereign plot in Pixel Kingdom Wars, sold as it stands. '
  + 'CONVEYS: the land and every expansion, all structures at their current levels, builder jobs still in flight, '
  + 'builder slots, the Keep level, and any active shields. '
  + 'DOES NOT CONVEY: KEEP and Shard balances, items, the army, the training queue, troop research, hero levels, '
  + 'trophies, league and streaks — those stay with the seller\'s wallet. '
  + 'ONE BASE PER WALLET: claim this deed with a wallet that does not already own a base, or the claim is refused. '
  + 'Traits are live: they reflect the base as it stands right now.';

const MULTI_BASE_DEED_DESCRIPTION =
  'A sovereign plot in Pixel Kingdom Wars, sold as it stands. '
  + 'CONVEYS THE COMPLETE PLAYABLE BASE: this land and every expansion; structures, builders and jobs; '
  + 'the base Shard balance, Mine stores and unsettled Gold Forge stake; army, training and troop research; '
  + 'heroes, recovery, equipment and loadouts; deed-owned items and consumables; trophies, league, streaks, '
  + 'quests, campaign progress, shields, and permanent battle history with replays. '
  + 'DOES NOT CONVEY: the seller\'s identity, wallet KEEP or SOL, clan membership, or account cosmetics. '
  + 'A wallet may own multiple independent bases; this deed conveys only the base identified by this asset. '
  + 'Traits are live: they reflect that base as it stands right now.';

/** Build the deed JSON for a PAID wallet; null for unknown/unpaid (no deed).
 *  `imageUrl` overrides the static env/placeholder image — the R2 pusher passes
 *  the rendered base PNG's public URL (with a layout-hash cache-buster). */
export async function buildDeedMetadata(
  db: DbOrTx, wallet: string, imageUrl?: string, baseId?: string,
): Promise<DeedMetadata | null> {
  const stable = multiBaseEnabled();
  const stableRows = stable ? await db.select({
    id: bases.id,
    keepLevel: bases.keepLevel, deedAssetId: bases.deedAssetId,
    expansions: bases.expansions, entryPaidAt: bases.landPaidAt,
    earthCell: plots.earthCell, planetId: valleys.planetId,
    countryName: earthCountries.name,
  }).from(bases)
    .leftJoin(plots, eq(plots.baseId, bases.id))
    .leftJoin(valleys, eq(valleys.id, plots.valleyId))
    .leftJoin(earthCountries, eq(earthCountries.a3, plots.countryA3))
    .where(and(eq(bases.ownerWallet, wallet), ...(baseId ? [eq(bases.id, baseId)] : [])))
    .orderBy(asc(bases.createdAt)).limit(baseId ? 1 : 2) : [];
  // A wallet alias cannot truthfully choose between several deeds. Asset-keyed
  // callers pass the stable base id; ambiguous legacy aliases fail closed.
  if (stable && !baseId && stableRows.length > 1) return null;
  const [legacy] = stable ? [] : await db.select({
    id: plots.baseId,
    keepLevel: players.keepLevel, deedAssetId: players.deedAssetId,
    expansions: players.expansions, entryPaidAt: players.entryPaidAt,
    // ITS PLACE ON EARTH (P6), on the SAME row rather than in a second query,
    // for exactly the reason above: this runs once per deed per R2 sweep, so the
    // country must cost zero extra round trips. THREE STORED VALUES AND NO
    // COMPUTATION: the cell, the frozen `ADM0_A3`, and that code's name from the
    // registry — a third LEFT JOIN on a primary key.
    earthCell: plots.earthCell, planetId: valleys.planetId,
    countryName: earthCountries.name,
  }).from(players)
    .leftJoin(plots, eq(plots.playerWallet, players.wallet))
    .leftJoin(valleys, eq(valleys.id, plots.valleyId))
    .leftJoin(earthCountries, eq(earthCountries.a3, plots.countryA3))
    .where(eq(players.wallet, wallet));
  const p = stable ? stableRows[0] : legacy;
  if (!p || !p.entryPaidAt) return null;
  const [b] = await db.select({ n: sql<number>`count(*)::int` }).from(buildings)
    .where(stable && p.id ? eq(buildings.baseId, p.id) : eq(buildings.playerWallet, wallet));
  const claim = claimRect(p.expansions);
  const side = claim.max - claim.min;
  /**
   * THE PARCEL'S PLACE ON THE REAL EARTH (P6) — the frozen cell, and the frozen
   * country that holds it. BOTH ARE COLUMNS. Nothing here computes geography.
   *
   * THE SAFETY PROPERTY, AND IT IS THE WHOLE REASON THIS PHASE COULD SHIP AT ALL.
   * `earthCell` is `plots.earth_cell` and `countryName` is the `earth_countries` row
   * for `plots.country_a3` — both written in the same INSERT that creates the plot
   * (`tryAssignInValley`, game/world.ts) and backfilled for pre-existing rows by
   * migrations 0053/0054. `parcelCell(site_id, x, y)` would give the same cell
   * today, and calling it would still be wrong: it reads the generated Earth mask +
   * country index, which `pnpm --filter @shardkeep/scripts earth:mask` may
   * legitimately rebuild — so a build step would then be able to move land a minted
   * deed already names, and an on-chain trait cannot be recalled. That is the exact
   * objection the owner's 2026-08-09 refusal of Earth lat/lon recorded (see the
   * Location comment below), and freezing is what answers it.
   *
   * WHY THE COUNTRY HAD TO BE FROZEN TOO, WHICH THE FIRST CUT OF THIS FILE GOT
   * WRONG (D1, 2026-08-10). It stored the cell and then asked
   * `countryIdOfCell(EARTH_FINE, EARTH_COUNTRIES_FINE, cell)` per request, on the
   * argument that a cell id is an absolute patch of ground — cell 69569 is the
   * ~55 km box at 44.5–45.0°E, 41.5–42.0°N whatever any mask says. The address part
   * of that is true; the LOOKUP part is not. `countryIdOfCell` resolves the cell to
   * a RANK in the fine mask's land enumeration (`landCellRank`) and reads the index
   * at that rank, and the id it gets back is a position in an `ADM0_A3`-sorted list.
   * One land cell gained anywhere below cell 69569 shifts every rank after it; one
   * feature added to the source renumbers every id. Either way the same frozen cell
   * would have printed a DIFFERENT country after a build step — which is precisely
   * what the LOCKED Q3 decision said must be impossible. So `ADM0_A3` — the
   * country's identity, and the very sort key those ranks are ranks in — is written
   * into `plots.country_a3` once, at plot creation, and read back here.
   *
   * WHAT A REGENERATION CAN AND CANNOT DO NOW. It can change what a NEW parcel's
   * country is (that is what regenerating means) and it can be caught doing it: the
   * mask, the index, the address book and the migration's cell → country ranges are
   * all pinned by content hash in apps/api/test/earth-address.test.ts (R15). It
   * cannot touch an existing deed: no rank, no id and no vote is consulted to build
   * this document. Renaming a country is a migration against `earth_countries`.
   *
   * PLANET-GATED, and not defensively: cell ids are MASK-RELATIVE and the registry
   * is Earth's. `valleys.planet_id` exists from P5 precisely so a second body is
   * additive, and the Addendum's rule is that nothing may hard-code planet 0 outside
   * that column's default — so a parcel on any other body gets no country and no
   * tile here rather than an Earth country it does not have. Its `country_a3` is the
   * `ZZZ` sentinel, which has no registry row, so the trait would be omitted anyway;
   * whoever adds the Moon adds its own bodies' rows and lifts this gate.
   */
  const fantasy = stable && p.id ? await resolveFantasyLocation(db, p.id) : null;
  const earthCell = !fantasy && deedLocationV2Enabled() && p.planetId === 0 ? p.earthCell : null;
  // D-063: preserve the established Location trait key for marketplace/API
  // compatibility, but its value is now the same immutable Earth-cell identity
  // used by the globe. Allocation valley names and local x/y are not land titles.
  // No assigned Earth cell means omission, never a guessed placeholder.
  const location = fantasy ? `${REALM_NAMES[fantasy.realmId]} · Tile ${fantasy.tileId}`
    : earthCell === null ? null : `Earth Cell ${earthCell}`;
  // '' = "no name to print", which happens for exactly one stored value: the `ZZZ`
  // sentinel, i.e. ground with no sovereign (ocean and Antarctica share it, because
  // "no sovereign" and "not claimable" are the same fact). Then the trait is OMITTED
  // rather than filled, exactly as `location` is: a land title that names no country
  // is honest, one that names the wrong country is not. Unreachable for a real Earth
  // parcel — a plot's cell always comes from `claimableCells`, so it always has a
  // sovereign, and `tryAssignInValley` refuses the seat rather than writing `ZZZ`.
  const country = earthCell === null ? '' : p.countryName ?? '';
  return {
    // Named after the ASSET, never the holder (F2): the name is baked on chain
    // at mint and read by every marketplace — a holder-derived name mis-labels
    // the deed the instant it is sold.
    name: p.deedAssetId ? deedAssetName(p.deedAssetId) : 'Land Deed',
    symbol: 'DEED',
    description: stable ? MULTI_BASE_DEED_DESCRIPTION : DEED_DESCRIPTION,
    external_url: 'https://pixelkingdomwars.com',
    // The deed's picture is the BASE ITSELF (baseRender.ts). Stable deeds use
    // /deed/asset/<asset>.png so two deeds held by one wallet cannot overwrite
    // each other's picture; the wallet path remains a legacy single-base alias. It
    // used to default to a single static file on a domain that does not
    // resolve, so every deed a
    // wallet displayed was image-less even when the JSON loaded (owner
    // 2026-07-29: "I dont see any data metadata or base image").
    image: imageUrl ?? process.env['DEED_IMAGE_URL'] ?? deedImageUrl(wallet, p.deedAssetId),
    // ONLY CONVEYING STATE MAY BE A TRAIT (F2/F7). Stable deed-mode traits must
    // resolve through base_id so a buyer receives exactly the advertised state;
    // legacy wallet-mode deliberately retains its historical narrower contract.
    attributes: [
      // Keep the public field stable while making its value the deed's actual,
      // frozen globe address. Transfer re-points the whole plot row, so this cell
      // conveys with the asset and cannot change under generated-map rebuilds.
      ...(location === null ? [] : [{ trait_type: 'Location', value: location }]),
      ...(fantasy ? [{ trait_type: 'Realm', value: REALM_NAMES[fantasy.realmId] },
        { trait_type: 'Tile', value: `${fantasy.worldId} · ${fantasy.tileId}` }] : []),
      // COUNTRY AND TILE PASS THE SAME RULE, BY THE SAME MECHANISM (P6, owner
      // decision 2026-08-10 Q3 — which overrode the plan's own recommendation).
      // `transferBase` re-points the `plots` row, and the Earth cell is a column ON
      // that row, so the cell — and therefore the country — changes hands with the
      // deed exactly as the coordinates do. Nothing extra had to be written in
      // baseTransfer.ts for that, which is the same argument Location makes one
      // level up; deed.test.ts transfers a base and demands the SAME asset report
      // the SAME country under its new holder, which is the assertion Trophies and
      // League could never have passed.
      //
      // THE COUNTRY IS `NAME` FROM NATURAL EARTH, VERBATIM (EARTH-TILES-PLAN R20):
      // never a flag (there is no flag for "Siachen Glacier"), never a boundary this
      // codebase redrew, and never a viewpoint this codebase picked. It reaches this
      // line as `plots.country_a3` → `earth_countries.name`, i.e. two stored values,
      // which is what makes it a permanent statement rather than a live opinion.
      //
      // The collection is DAS-enumerable without auth, so country and cell are
      // intentionally public facts while allocator coordinates remain private.
      ...(country === '' ? [] : [{ trait_type: 'Country', value: country }]),
      // THE TILE IS THE FROZEN COLUMN ITSELF, so it is the one trait no rebuild of
      // anything can move. Free to include: it is already on the row above.
      //
      // Retain the established Tile field for consumers that already read it.
      ...(earthCell === null ? [] : [{ trait_type: 'Tile', value: `Earth · ${earthCell}` }]),
      { trait_type: 'Keep Level', value: p.keepLevel },
      { trait_type: 'Buildings', value: b?.n ?? 0 },
      { trait_type: 'Land', value: `${side}×${side}` },
      { trait_type: 'Founded', value: p.entryPaidAt.toISOString().slice(0, 10) },
    ],
  };
}

/** Asset-keyed metadata is the unambiguous public path once one wallet may own
 * several deeds. The legacy wallet alias remains available only for a wallet
 * with exactly one stable base. */
export async function buildDeedMetadataForAsset(
  db: DbOrTx, assetId: string, imageUrl?: string,
): Promise<DeedMetadata | null> {
  if (!multiBaseEnabled()) {
    const wallet = await deedHolderWallet(db, assetId);
    return wallet ? buildDeedMetadata(db, wallet, imageUrl) : null;
  }
  const [base] = await db.select({ id: bases.id, wallet: bases.ownerWallet }).from(bases)
    .where(eq(bases.deedAssetId, assetId));
  return base ? buildDeedMetadata(db, base.wallet, imageUrl, base.id) : null;
}
