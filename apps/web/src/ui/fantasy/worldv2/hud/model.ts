/**
 * The World v2 HUD's decisions as pure functions, so the rules the owner reviewed on native are pinned by tests
 * without a DOM. Every value comes from a server read (`/globe/fantasy`, the parcel read, the viewport markers) or the
 * shared catalogue; the HUD never decides eligibility.
 */
import { FANTASY_WORLD } from '@shardkeep/shared';
import type { FantasyGlobeData, FantasyOwnedTile, FantasySearchResult } from '../../data';
import type { ParcelDetail } from '../../../screens/globe/parcelDetail';
import { LEVEL_RANGE, PHASE_E_ISLANDS, REALM_INFO, RESERVED_REALM_ID, WORLD_COPY } from '../copy';

export type RealmCounts = FantasyGlobeData['realms'][number];
export type CardDetail = Omit<ParcelDetail, 'parcel'>;

/** A rail destination: the 8 realms, then the 3 islands (D-166.1: one language, identity only in the accent). */
export interface RailEntry { kind: 'realm' | 'island'; id: string; name: string; accent: string }
export const RAIL_ENTRIES: readonly RailEntry[] = [
  ...REALM_INFO.map(r => ({ kind: 'realm' as const, id: r.id, name: r.name, accent: r.accent })),
  ...PHASE_E_ISLANDS.map(i => ({ kind: 'island' as const, id: i.id, name: i.title, accent: i.accent })),
];

/** One realm-panel CTA (native `RealmCta`). */
export interface RealmCta { kind: 'choose-land' | 'no-open-land' | 'my-base' | 'enter-map' | 'no-map' | 'preparing'; gold: boolean; percent?: number }

/**
 * The realm panel's CTA rows (native `realmCtaRows`, GlobeHud.kt). The browse row is My base (you own land here and
 * the realm has a map) then Enter map, or why not yet. Choose mode leads with "Choose land here" for a realm with
 * open land and KEEPS the browse row under it: the owner (Seeker code 31b, 2026-09-26) lost Enter map when choose
 * mode replaced the whole foot. One gold at most: choose mode's lead while there is open land, else My base when
 * MY PARCEL opened the panel ([mineCta]), else Enter map.
 */
export function realmCtaRows(o: { realmId: string; open: number | null | undefined; mine: boolean; hasMap: boolean;
  ready?: number | null | undefined; mineCta?: boolean | undefined; choose?: boolean | undefined }): RealmCta[][] {
  const preparing = o.ready !== null && o.ready !== undefined && o.ready < 1;
  const percent = preparing ? Math.floor((o.ready ?? 0) * 100) : 0;
  const openLand = o.realmId !== RESERVED_REALM_ID && (o.open === null || o.open === undefined || o.open > 0);
  const chooseLeads = !!o.choose && openLand;
  const myBaseGold = !chooseLeads && !!o.mineCta && o.mine && o.hasMap;
  const enterGold = !chooseLeads && !myBaseGold;
  const browse: RealmCta[] = [];
  if (o.mine && o.hasMap) browse.push({ kind: 'my-base', gold: myBaseGold });
  browse.push(!o.hasMap ? { kind: 'no-map', gold: false } : preparing ? { kind: 'preparing', gold: enterGold, percent } : { kind: 'enter-map', gold: enterGold });
  if (!o.choose) return [browse];
  const lead: RealmCta = !openLand ? { kind: 'no-open-land', gold: false }
    : o.hasMap && preparing ? { kind: 'preparing', gold: true, percent } : { kind: 'choose-land', gold: true };
  return [[lead], browse];
}

/** The realm panel's four stats: the server's counts, or, for Solana Reach, its reserved allocations
 *  (native GlobeHud.kt). `null` = not read yet (shown as a dash, never a guess). */
export function realmStats(realmId: string, counts: RealmCounts | null | undefined, mine: number):
  Array<{ label: string; value: number | null; mine: boolean }> {
  const S = WORLD_COPY.stats, v = (n: number | undefined): number | null => (n === undefined ? null : n);
  if (realmId === RESERVED_REALM_ID) return [
    { label: S.deeds, value: v(counts?.total), mine: false },
    { label: S.genesis, value: FANTASY_WORLD.genesisTiles, mine: false },
    { label: S.seeker, value: FANTASY_WORLD.seekerTiles, mine: false },
    { label: S.open, value: v(counts?.available), mine: false },
  ];
  return [
    { label: S.deeds, value: v(counts?.total), mine: false },
    { label: S.kingdoms, value: v(counts?.occupied), mine: false },
    { label: S.open, value: v(counts?.available), mine: false },
    { label: S.mine, value: mine, mine: mine > 0 },
  ];
}

export type TagTone = 'gold' | 'blue' | 'red';
/**
 * The card's tags (native ParcelCard.kt). "You can attack" shows exactly when the server's
 * `actions.attack.allowed` is true for a rival: raiding has no location rule (owner 2026-09-26), so the tag never
 * says a range and never guesses. The shield tag reads the parcel's own `shield`, suppressed first.
 */
export function cardTags(own: boolean, detail: Pick<CardDetail, 'shield' | 'actions'> | null | undefined): Array<{ label: string; tone: TagTone }> {
  const T = WORLD_COPY.tags, out: Array<{ label: string; tone: TagTone }> = [];
  if (own) out.push({ label: T.yours, tone: 'gold' });
  if (detail?.shield.suppressedByWarzone === true) out.push({ label: T.suppressed, tone: 'red' });
  else if (detail?.shield.active === true) out.push({ label: T.shielded, tone: 'blue' });
  if (!own && detail?.actions.attack.allowed === true) out.push({ label: T.attack, tone: 'red' });
  return out;
}

/** D-181 / D-191: the Unshielded filter exists only once a read has carried the `shielded` key (hidden, never faked). */
export function markersCarryShield(markers: ReadonlyArray<object> | null | undefined): boolean {
  return !!markers?.some(m => typeof (m as { shielded?: unknown }).shielded === 'boolean');
}

/**
 * The realm map's filter (All / Mine / Unshielded, and the keep-level range). D-191 (owner 2026-09-28, endorsing a
 * player): a kingdom that fails it is hidden on the map, not dimmed, and 'unshielded' keeps only kingdoms whose shield
 * bit is explicitly false — the point of searching is to raid, so the target is the unshielded (there is no Shielded chip).
 */
export interface RealmFilter { kind: 'all' | 'mine' | 'unshielded'; lo: number; hi: number }
export const DEFAULT_REALM_FILTER: RealmFilter = { kind: 'all', lo: LEVEL_RANGE.min, hi: LEVEL_RANGE.max };
export const levelFiltered = (f: RealmFilter): boolean => f.lo > LEVEL_RANGE.min || f.hi < LEVEL_RANGE.max;

/** Owner search on a realm map (native F9): this realm's results select in place; the others offer "Go to ‹realm›". */
export function splitSearch(results: readonly FantasySearchResult[] | null | undefined, realmId: string):
  { here: FantasySearchResult[]; elsewhere: FantasySearchResult[] } {
  const here: FantasySearchResult[] = [], elsewhere: FantasySearchResult[] = [];
  for (const r of results ?? []) (r.realmId === realmId ? here : elsewhere).push(r);
  return { here, elsewhere };
}

/** Deed column/row of a catalogue tile id. */
export const tileXY = (tileId: number): { x: number; y: number } =>
  ({ x: tileId % FANTASY_WORLD.columns, y: Math.floor(tileId / FANTASY_WORLD.columns) });

/** Your bases in one realm, from the directory's owned tiles. */
export const minesIn = (owned: readonly FantasyOwnedTile[] | null | undefined, realmId: string): number =>
  (owned ?? []).filter(t => t.realmId === realmId).length;
