/** Revision 5 realm kit, E-11 expansion obstacles (docs/REALM-KIT-PLAN.md E-11,
 * D-173 expansion obstacles, owner 2026-09-21: "what happens to trees when you
 * extend base? … they are not interactive like in-base trees"). A baked kit prop
 * whose seat tile an expansion reaches used to be simply hidden; now the server
 * inserts an obstacle row of the tier this module names, the player clears it with
 * the plot's own tap-to-clear flow, and every surface draws that row as the prop's
 * OWN still — the species never changes because land was bought. Pure and
 * integer-safe: web, the Kotlin mirror, the deed renderer and the API sync run these
 * rules. Subpath export only, never the barrel (it drags the manifest types along). */
import { KIT_OBSTACLES, OBSTACLES } from './constants';
import type { LayeredAsset } from './layeredGround';
import { OBSTACLE_SPRITE_KEYS, realmKitObstacleSprite, realmKitPlacementSeat, realmKitTileHash,
  type ObstacleSpriteKey, type RealmKitManifest, type RealmKitObstacleState, type RealmKitPlacement } from './realmKit';

const K = KIT_OBSTACLES;
function fail(): never { throw new Error('Invalid realm kit obstacle lookup'); }
const isKey = (v: unknown): v is ObstacleSpriteKey => OBSTACLE_SPRITE_KEYS.includes(v as ObstacleSpriteKey);

/** The server tier's edge in tiles for a sprite key (OBSTACLES.tiers[*].sizeTiles):
 * the row's rect is `size`×`size` from its (tx, ty) top-left, as apps/api obstacleRect. */
export function realmKitObstacleSize(spriteKey: string): number {
  for (const tier of Object.values(OBSTACLES.tiers)) if ((tier.kinds as readonly string[]).includes(spriteKey)) return tier.sizeTiles;
  fail();
}
/** The seat tile of a server row: where a kit prop of that tier stands. The builder
 * seats a w-wide prop's anchor at tx0·32 + ⌊w/2⌋·32 (+16 when odd) and its bottom on the
 * footprint's south edge, so realmKitPlacementSeat reads (tx0 + ⌊w/2⌋, ty0 + h − 1) —
 * the row's own tile for a 1×1 tier, the bottom-right tile for the 2×2 tier. The
 * inverse of realmKitObstacleRow. */
export function realmKitObstacleSeat(spriteKey: string, tx: number, ty: number): { tx: number; ty: number } {
  const size = realmKitObstacleSize(spriteKey);
  return { tx: tx + Math.floor(size / 2), ty: ty + size - 1 };
}
/** The (tx, ty) top-left the API stores for a row whose tier sprite must stand on `seat`;
 * for every key its twin's anchor then coincides with the placement's anchor pixel. */
export function realmKitObstacleRow(spriteKey: string, seat: { tx: number; ty: number }): { tx: number; ty: number } {
  const size = realmKitObstacleSize(spriteKey);
  return { tx: seat.tx - Math.floor(size / 2), ty: seat.ty - size + 1 };
}

const seatCache = new WeakMap<RealmKitManifest, Map<string, RealmKitPlacement>>();
/** "tx,ty" → the placement seated there (first in manifest order when two share a
 * seat), memoised per manifest object: the clients ask per obstacle row per frame. */
export function realmKitSeatIndex(m: RealmKitManifest): ReadonlyMap<string, RealmKitPlacement> {
  const hit = seatCache.get(m);
  if (hit) return hit;
  const index = new Map<string, RealmKitPlacement>();
  for (const p of m.placements) {
    const { tx, ty } = realmKitPlacementSeat(p), key = `${tx},${ty}`;
    if (!index.has(key)) index.set(key, p);
  }
  seatCache.set(m, index);
  return index;
}
/** The kit prop id a placement carries: `prop` when the builder wrote it, else the id
 * prefix (builder ids are `<prop-id-with-dashes>-<serial>`; fixture ids are hand-named). */
const propOf = (p: RealmKitPlacement): string => p.prop ?? p.id;
/** The OBSTACLES sprite key a kit prop becomes when a claim reaches its seat, or
 * undefined when it never becomes one (it stays a hidden prop, as before E-11). The
 * rule and its numbers are KIT_OBSTACLES: the creature sheet never maps; a
 * KIT_OBSTACLES.byProp prefix names its key; otherwise a 1×1 prop is a parity tree
 * on the tall layer or the bush on the low layer, and a 2×2 tall prop the large tree.
 * Whatever names the key, its tier size must equal the prop's footprint — a server
 * row must never occupy a tile the visible prop does not stand on, and never let a
 * 2×1 log or a 3×3 mill be cleared as a bush. Claim-independent on purpose: which
 * rows exist is the API's decision (row iff realmKitPlacementHidden hides the prop —
 * seat inside the claim or its edge ring — so no surface ever shows a gap; ownership
 * of the rect gates the clear, not the row). */
export function realmKitObstacleKindFor(m: RealmKitManifest, p: RealmKitPlacement): ObstacleSpriteKey | undefined {
  const a = m.assets.find(asset => asset.id === p.asset);
  if (!a) fail();
  if (a.frameWidth === K.creatureCellPixels && a.frameHeight === K.creatureCellPixels) return undefined;
  const [w, h] = p.footprint ?? [1, 1], prop = propOf(p), tall = p.layer > 0;
  let key: string | undefined;
  for (const [prefix, mapped] of Object.entries(K.byProp)) if (prop.startsWith(prefix)) { key = mapped; break; }
  if (key === undefined) {
    if (w === 1 && h === 1) {
      if (!tall) key = K.low;
      else { const { tx, ty } = realmKitPlacementSeat(p); key = K.tallByParity[realmKitTileHash(tx, ty) % K.tallByParity.length]; }
    } else if (w === 2 && h === 2 && tall) key = K.tallLarge;
  }
  if (key === undefined || !isKey(key)) return undefined;
  const size = realmKitObstacleSize(key);
  return w === size && h === size ? key : undefined;
}
/** The sheet cell every surface draws for a server obstacle row at (tx, ty): while the
 * row stands (intact, or clearing under a builder), the still of the kit prop seated
 * on the row's seat tile — provided that prop is the one whose kind the row carries,
 * so a stale row under a re-baked kit never borrows a stranger's sprite; otherwise the
 * E-11 twin (realmKitObstacleSprite), which is what remnants always draw (stump /
 * rubble by tier) and what the plot's own generated rows draw. Undefined leaves the
 * key to the frozen `dec_` master (O-7). */
export function realmKitObstacleSpriteAt(m: RealmKitManifest, tx: number, ty: number, spriteKey: string, state: RealmKitObstacleState):
  { asset: LayeredAsset; frame: number } | undefined {
  if (!isKey(spriteKey) || !['intact', 'clearing', 'remnant'].includes(state) || !Number.isSafeInteger(tx) || !Number.isSafeInteger(ty)) fail();
  if (state !== 'remnant') {
    const seat = realmKitObstacleSeat(spriteKey, tx, ty), p = realmKitSeatIndex(m).get(`${seat.tx},${seat.ty}`);
    if (p && realmKitObstacleKindFor(m, p) === spriteKey) {
      const asset = m.assets.find(a => a.id === p.asset);
      if (!asset) fail();
      return { asset, frame: p.frame ?? 0 };
    }
  }
  const twin = realmKitObstacleSprite(m, spriteKey, state);
  return twin ? { asset: twin, frame: 0 } : undefined;
}
