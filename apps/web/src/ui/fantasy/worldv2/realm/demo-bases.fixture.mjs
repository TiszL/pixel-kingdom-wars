// Realm maps — the demo base population (plan §6.1, §10.2). BASES lane.
// The live bulk feed is out of scope this round (plan §1.4); until it lands every realm map is populated
// from here. It must look like a real, lived-in realm, deterministically (seed 7331):
//   - about 24 % of the realm's own deeds claimed, clustered around settlement hubs (rivers and heartlands
//     read as towns in the prototype; uniform noise reads as static);
//   - keep levels skewed low (most players are early), a few high-level citadels;
//   - some shielded bases (the demo feed is one of the three sources of known shields, Q2);
//   - clans (so the Clan filter shows allies) and exactly one base that is yours (gold everywhere);
//   - a shielded neighbour next to your base, so V4 "a shield dome on a shielded neighbour" always exists.
import { DEED_PX } from './contracts.mjs';

export const DEMO = Object.freeze({
  seed: 7331, occupancy: 0.24, hubs: 26, levelSkew: 1.9, shieldShare: 0.2, clanShare: 0.35, myLevel: 9, attackRange: 3,
  ladder: Object.freeze([1, 3, 5, 9, 13, 17, 20]),
  // fix iteration 2 (QA critical 1, "a perfect grid of identical keeps at d 49–150"): a settlement is never a solid
  // block. `vacant` of the deeds are held empty (hashed per deed: fallow land, never claimed by the demo), and no
  // deed is claimed once its 5×5 neighbourhood already holds `localCap` of 24 neighbours (≈ 42 %) or its 3×3 one
  // `nearCap` of 8 (so no solid 3×3 block either).
  vacant: 0.3, localCap: 10, nearCap: 4,
  // V8 (a base on a river: its plot is a natural islet/peninsula) needs one on every realm; Crownlands' population
  // has none, so this deed is claimed: the own deed whose centre lies nearest a lines.json river (0.9 t).
  moat: Object.freeze({ crownlands: Object.freeze({ x: 57, y: 56, level: 7 }) }),
});
const SYL = ['ka', 'ren', 'dor', 'el', 'mi', 'tor', 'va', 'lis', 'gar', 'on', 'bel', 'thy', 'ro', 'sa', 'kin', 'mar', 'ul', 'fen', 'ash', 'ly'];
export const CLANS = Object.freeze(['Emberwatch', 'Tidebreakers', 'Iron Pact', 'Dawnspire', 'Frostborn', 'Sunward', 'Grey Cairn', 'Oathkeepers']);

/** mulberry32: the prototype's deterministic generator (realmmap.js rng), kept so demo realms match it. */
export function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gridOf = meta => ({ cols: meta?.grid?.cols ?? meta?.cols, rows: meta?.grid?.rows ?? meta?.rows });
/** deeds.png as 1 byte per deed, or its RGBA decode (4 bytes per deed): either works. */
function deedReader(deedsU8, cols, rows) {
  const stride = deedsU8.length >= cols * rows * 4 ? 4 : 1;
  return (x, y) => deedsU8[(y * cols + x) * stride];
}

/** demoBases(meta, deedsU8) → Base[] (plan §6.1 typedef). Deterministic. */
export function demoBases(meta, deedsU8) {
  const { cols, rows } = gridOf(meta);
  if (!cols || !rows) throw new Error('demoBases: realm.json has no grid cols/rows');
  const deed = deedReader(deedsU8, cols, rows), own = (x, y) => deed(x, y) >= DEED_PX.thisRealm - 55; // 255 this realm
  const r = rng(DEMO.seed), cells = [];
  // hashed fallow deeds and the local density cap (DEMO.vacant, DEMO.localCap): dense zones stay ≈ 35–45 % claimed
  const vacant = (x, y) => { let h = Math.imul(x ^ 0x5bd1e995, 0x27d4eb2d) ^ Math.imul(y + 0x165667b1, 0x85ebca6b); h ^= h >>> 15; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 13; return (h >>> 0) / 4294967296 < DEMO.vacant; };
  const grid = new Uint8Array(cols * rows);
  const crowded = (x, y) => { let n = 0, m = 0;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= cols || Y >= rows) continue;
      const v = grid[Y * cols + X]; n += v; if (dx * dx <= 1 && dy * dy <= 1) m += v; }
    return n >= DEMO.localCap || m >= DEMO.nearCap; };
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) if (own(x, y)) cells.push([x, y]);
  if (!cells.length) return [];
  const hubs = Array.from({ length: DEMO.hubs }, () => cells[Math.floor(r() * cells.length)]);
  const want = Math.round(cells.length * DEMO.occupancy), used = new Set(), bases = [];
  let guard = 0;
  while (bases.length < want && guard++ < want * 40) {
    const h = hubs[Math.floor(r() * hubs.length)], sp = 2 + r() * 9;
    const x = Math.round(h[0] + (r() + r() + r() - 1.5) * sp), y = Math.round(h[1] + (r() + r() + r() - 1.5) * sp), k = y * cols + x;
    if (x < 0 || y < 0 || x >= cols || y >= rows || used.has(k) || !own(x, y) || vacant(x, y) || crowded(x, y)) continue;
    used.add(k); grid[k] = 1;
    const level = 1 + Math.floor(Math.pow(r(), DEMO.levelSkew) * 20), n = 2 + Math.floor(r() * 2);
    let name = ''; for (let i = 0; i < n; i++) name += SYL[Math.floor(r() * SYL.length)];
    const shield = r() < DEMO.shieldShare, clan = r() < DEMO.clanShare ? CLANS[Math.floor(r() * CLANS.length)] : null;
    bases.push({ id: k, x, y, level, name: name[0].toUpperCase() + name.slice(1), avatar: Math.floor(r() * 256),
      trophies: Math.floor(200 + level * 180 + r() * 400), clan, mine: false, shield, attackable: false });
  }
  // Coverage top-up: the hub walk can starve on a realm whose deeds are few and scattered (Cinderfall);
  // fill any shortfall uniformly so occupancy always meets the plan.
  for (let i = 0; bases.length < want && i < cells.length * 4; i++) {
    const [x, y] = cells[Math.floor(r() * cells.length)], k = y * cols + x;
    if (used.has(k) || vacant(x, y) || crowded(x, y)) continue;
    used.add(k); grid[k] = 1;
    const level = 1 + Math.floor(Math.pow(r(), DEMO.levelSkew) * 20);
    bases.push({ id: k, x, y, level, name: SYL[Math.floor(r() * SYL.length)].replace(/^./, c => c.toUpperCase()) + SYL[Math.floor(r() * SYL.length)],
      avatar: Math.floor(r() * 256), trophies: Math.floor(200 + level * 180 + r() * 400), clan: null, mine: false, shield: r() < DEMO.shieldShare, attackable: false });
  }
  // V8: the realm's river deed (DEMO.moat) is always claimed — its plot sits in the water as an islet/peninsula
  const mo = DEMO.moat[meta?.id];
  if (mo && own(mo.x, mo.y) && !used.has(mo.y * cols + mo.x)) {
    const k = mo.y * cols + mo.x; used.add(k); grid[k] = 1;
    bases.push({ id: k, x: mo.x, y: mo.y, level: mo.level, name: 'Rivermoot', avatar: 77, trophies: 200 + mo.level * 180, clan: null, mine: false, shield: false, attackable: false });
  }
  // Yours: the base nearest the realm's centre of mass of claimed deeds (a heartland, not an edge).
  let cx = 0, cy = 0; for (const b of bases) { cx += b.x; cy += b.y; } cx /= bases.length; cy /= bases.length;
  let me = bases[0]; for (const b of bases) if ((b.x - cx) ** 2 + (b.y - cy) ** 2 < (me.x - cx) ** 2 + (me.y - cy) ** 2) me = b;
  Object.assign(me, { mine: true, name: 'Your Kingdom', level: DEMO.myLevel, clan: CLANS[0], shield: true, trophies: 2150 });
  // A shielded neighbour: the nearest other base gets a known shield (V4 needs one on screen).
  let nb = null; for (const b of bases) if (b !== me && (!nb || (b.x - me.x) ** 2 + (b.y - me.y) ** 2 < (nb.x - me.x) ** 2 + (nb.y - me.y) ** 2)) nb = b;
  if (nb) nb.shield = true;
  // QA level ladder (plan §11.1 V4b): `?ladder=1` on the dev page puts L1 L3 L5 L9 L13 L17 L20 in a row.
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  if (q?.get('ladder') === '1') return ladderBases(bases, meta, deedsU8);
  return withAttackable(bases);
}

/** attackable = not yours, not shielded, within ±3 keep levels of yours (the prototype's rule). */
export function withAttackable(bases) {
  const me = bases.find(b => b.mine);
  for (const b of bases) b.attackable = !!me && !b.mine && b.shield !== true && Math.abs(b.level - me.level) <= DEMO.attackRange;
  return bases;
}

/** The QA level ladder (plan §11.1 V4b, `?ladder=1`): seven bases L1, L3, L5, L9, L13, L17, L20 on the
 *  nearest run of seven consecutive own-realm deeds to your base, replacing whatever stood there. */
export function ladderBases(bases, meta, deedsU8, levels = DEMO.ladder) {
  const { cols, rows } = gridOf(meta), deed = deedReader(deedsU8, cols, rows), own = (x, y) => deed(x, y) >= DEED_PX.thisRealm - 55;
  const me = bases.find(b => b.mine) ?? { x: cols >> 1, y: rows >> 1 }, n = levels.length;
  let best = null, bd = Infinity;
  for (let y = 0; y < rows; y++) for (let x = 0; x + n <= cols; x++) {
    let ok = true; for (let i = 0; i < n && ok; i++) ok = own(x + i, y) && !(x + i === me.x && y === me.y);
    if (!ok) continue;
    const d = (x + n / 2 - me.x) ** 2 + (y - me.y) ** 2;
    if (d < bd) { bd = d; best = [x, y]; }
  }
  if (!best) return bases;
  const [x0, y0] = best, taken = new Set(levels.map((_, i) => y0 * cols + x0 + i));
  const kept = bases.filter(b => !taken.has(b.y * cols + b.x));
  levels.forEach((level, i) => kept.push({ id: y0 * cols + x0 + i, x: x0 + i, y: y0, level, name: `Ladder L${level}`, avatar: 40 + i * 30,
    trophies: 200 + level * 180, clan: null, mine: false, shield: level === 9 || level === 17, attackable: false }));
  return withAttackable(kept);
}
