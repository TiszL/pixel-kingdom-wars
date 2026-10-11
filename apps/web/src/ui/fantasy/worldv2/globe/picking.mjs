// Tap picking on the flat globe (native GlobeGeography.kt + GlobePicking.kt, ports of the concept's tap(), geoIndex and
// realmGeom). The frozen display geography comes from the web's own frozen runs (the source native's surface and realm
// masks were cut from): region + visible land + deed + exploration chain per 768×384 cell. Picking never yields a tile:
// a realm, an exploration chain or island (the host's chain and island ids), a Phase E island, the sea, or space.
import { GEOGRAPHY_RUNS } from '../../runtime/geography/frozen-runs.mjs';
import { GEO_W, GEO_H, PHASE_E, ISLE } from './pin.mjs';
import { RAD, add, cross, dirOf, dot, mulS, norm } from './camera.mjs';

/** The frozen geography as flat arrays: land (visible), region (realm index or -1), explore (chain + 1, 0 none), deed. */
export function decodeGeography(runs = GEOGRAPHY_RUNS) {
  const n = GEO_W * GEO_H, land = new Uint8Array(n), region = new Int8Array(n), explore = new Uint8Array(n), deed = new Uint8Array(n);
  let at = 0;
  for (const [length, code] of runs) {
    const r = (code & 15) - 1, l = code & 16 ? 1 : 0, d = code & 32 ? 1 : 0, e = code >> 6;
    for (let i = at; i < at + length; i++) { region[i] = r; land[i] = l; deed[i] = d; explore[i] = e; }
    at += length;
  }
  if (at !== n) throw Error('Incomplete frozen geography');
  return { width: GEO_W, height: GEO_H, land, region, explore, deed };
}

/** geo.js geoIndex(lon, lat) (degrees; native GlobeGeography.index). */
export function geoIndex(lon, lat) {
  const x = Math.min(GEO_W - 1, Math.floor(((((lon + 180) % 360) + 360) % 360) / 360 * GEO_W));
  const y = Math.min(GEO_H - 1, Math.max(0, Math.floor((90 - lat) / 180 * GEO_H)));
  return y * GEO_W + x;
}

const geoDir = (x, y) => dirOf((x + 0.5) / GEO_W * 360 - 180, 90 - (y + 0.5) / GEO_H * 180);

/**
 * main.js realmGeom(r): the realm's main landmass (islets under 30 cells get no ring of their own), its outline points
 * (decimated to about 900) and the centre of their bounding box in the landmass's tangent plane: what a selection frames.
 */
export function realmGeom(geo, r) {
  const GW = geo.width, GH = geo.height, n = GW * GH, land = geo.land, region = geo.region;
  const inRealm = i => land[i] === 1 && region[i] === r;
  // flood fill without per-cell allocation (a phone runs this on the main thread, once per realm, on first selection)
  const lab = new Int32Array(n).fill(-1), stack = new Int32Array(n); let bestId = -1, bestN = 0;
  for (let s0 = 0, id = 0; s0 < n; s0++) { if (lab[s0] >= 0 || !inRealm(s0)) continue; let c = 0, sp = 0; stack[sp++] = s0; lab[s0] = id;
    while (sp) { const i = stack[--sp], x = i % GW, y = (i / GW) | 0; c++;
      const e = y * GW + (x + 1) % GW, w = y * GW + (x + GW - 1) % GW, nn = y > 0 ? i - GW : -1, ss = y < GH - 1 ? i + GW : -1;
      if (lab[e] < 0 && inRealm(e)) { lab[e] = id; stack[sp++] = e; }
      if (lab[w] < 0 && inRealm(w)) { lab[w] = id; stack[sp++] = w; }
      if (nn >= 0 && lab[nn] < 0 && inRealm(nn)) { lab[nn] = id; stack[sp++] = nn; }
      if (ss >= 0 && lab[ss] < 0 && inRealm(ss)) { lab[ss] = id; stack[sp++] = ss; } }
    if (c > bestN) { bestN = c; bestId = id; } id++; }
  const pts = []; let sx = 0, sy = 0, sz = 0;
  for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) { const i = y * GW + x; if (lab[i] !== bestId) continue; const d = geoDir(x, y); sx += d[0]; sy += d[1]; sz += d[2];
    if (y === 0 || y === GH - 1 || !inRealm(i - GW) || !inRealm(i + GW) || !inRealm(y * GW + (x + 1) % GW) || !inRealm(y * GW + (x + GW - 1) % GW)) pts.push(d); }
  const c0 = norm([sx, sy, sz]), e0 = norm(cross([0, 1, 0], c0)), n0 = cross(c0, e0); let u0 = 9, u1 = -9, v0 = 9, v1 = -9;
  for (const p of pts) { const z = dot(p, c0); if (z < 0.05) continue; const u = dot(p, e0) / z, v = dot(p, n0) / z; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
  const stride = Math.max(1, Math.ceil(pts.length / 900));
  return { c: norm(add(c0, add(mulS(e0, (u0 + u1) / 2), mulS(n0, (v0 + v1) / 2)))), pts: pts.filter((_, i) => i % stride === 0), outlineCells: pts.length };
}

/** The Phase E island whose D-165 tap ellipse holds (lon, lat), or null. */
export function phaseEAt(lon, lat) {
  for (const I of PHASE_E) { const dx = ((lon - I.lon + 540) % 360 - 180) * Math.cos(I.lat * RAD), dy = lat - I.lat;
    if ((dx / I.rx) ** 2 + (dy / I.ry) ** 2 < 1) return I.id; }
  return null;
}

/**
 * The exploration island whose art box holds (lon, lat) (native GlobeArt.islandAt, the web's locateIsland without the
 * coastline table): chain index, slot, and the texel in the chain's full-resolution atlas. chains: the host's
 * ARCHIPELAGOS (id, islands[{lon, lat, rx, ry}]).
 */
export function islandAt(chains, lon, lat) {
  for (let c = 0; c < chains.length; c++) { const isl = chains[c].islands;
    for (let s = 0; s < isl.length; s++) { const I = isl[s];
      const dx = ((lon - I.lon + 540) % 360 - 180) / I.rx, dy = (lat - I.lat) / I.ry;
      if (Math.abs(dx) >= ISLE.EXTENT || Math.abs(dy) >= ISLE.EXTENT) continue;
      const u = Math.floor((dx / ISLE.EXTENT + 1) * ISLE.CELL / 2), v = Math.floor((1 - dy / ISLE.EXTENT) * ISLE.CELL / 2);
      return { chain: c, slot: s, x: (s % 3) * ISLE.CELL + u, y: Math.floor(s / 3) * ISLE.CELL + v }; } }
  return null;
}

/** Above this many screen px per geography px the exploration islands are drawn and picked by their art (native
 *  GlobePicking.LEGACY_ISLAND_FOOTPRINT, the legacy web renderer's `footprint > 1.5`). */
export const ISLAND_FOOTPRINT = 1.5;

/**
 * pick(lon, lat, footprint) → one of
 *   { kind: 'phase-e', id }                      (only with phaseE on)
 *   { kind: 'explore', chainId, islandId }       (islandId `${chainId}-${slot + 1}`, the host's id, or null far out)
 *   { kind: 'realm', index, id, deedEligible }
 *   { kind: 'sea' }
 * lands: per chain the full-resolution land bits (Uint8Array ATLAS², 1 = land) once the island art is live, else null
 * (then the chain is picked by its coarse cells, as native before its island layer is rehearsed).
 */
export function createPicking({ geo, realmIds, chains }) {
  const P = { phaseE: false, lands: null };
  P.pick = (lon, lat, footprint) => {
    if (P.phaseE) { const id = phaseEAt(lon, lat); if (id) return { kind: 'phase-e', id }; }
    const lands = P.lands;
    if (lands && footprint > ISLAND_FOOTPRINT) {
      const hit = islandAt(chains, lon, lat);
      if (hit) { const chainId = chains[hit.chain].id, land = lands[hit.chain];
        if (!land) return { kind: 'explore', chainId, islandId: null };
        return land[hit.y * ISLE.ATLAS + hit.x] ? { kind: 'explore', chainId, islandId: `${chainId}-${hit.slot + 1}` } : { kind: 'sea' }; }
    }
    const i = geoIndex(lon, lat), chain = geo.explore[i];
    if ((lands && footprint > ISLAND_FOOTPRINT && chain > 0) || !geo.land[i]) return { kind: 'sea' };
    if (chain > 0) return chains[chain - 1] ? { kind: 'explore', chainId: chains[chain - 1].id, islandId: null } : { kind: 'sea' };
    const r = geo.region[i];
    if (r < 0 || r >= realmIds.length) return { kind: 'sea' };
    return { kind: 'realm', index: r, id: realmIds[r], deedEligible: geo.deed[i] === 1 };
  };
  /** main.js realmIdAt: the realm under (lon, lat) whether or not the cell is land (the dive rule reads this). */
  P.realmIdAt = (lon, lat) => { const r = geo.region[geoIndex(lon, lat)]; return r >= 0 ? realmIds[r] ?? null : null; };
  return P;
}
