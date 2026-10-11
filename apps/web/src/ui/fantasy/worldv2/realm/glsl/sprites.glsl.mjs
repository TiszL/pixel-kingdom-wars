// LIFE sprite shaders (plan §3.6, §7 A7–A9, A13; GLSL ES 3.00, plain strings for the native port).
// The JS reference of every rule here is src/realm/scatter.js: seats, species picks, class/plot culls, the
// anti-speckle rule, hashed MAP→TRUE dissolves and the kit creature path pose must match it exactly.
// Includes: "common" (SHELL), "classes" (GROUND: pageResident, tileRecord, mapClassAt, mapClassFine, plotSdf), "life"
// (below; LIFE reads classes only through lifeClass / lifeClassSeat: sampled lookups, never GROUND's classifier).
//
// Species table (usampler2D RGBA16UI, uLTable). Group row r = 2·g: species s at texels 6s … 6s+5:
//   T0 (layer, cum−1, array | flags<<4, onMask)       flags: 1 coast, 2 emitter, 4 glow (a map object's lens, Stage B)
//   T1 (frames, frameMs, inkH, footR)
//   T2 (layerW, layerH, anchorX, anchorY)               anchor inside the array layer (art px)
//   T3 (twinLayer+1, fxLayer+1, fxDx+32768, fxDy+32768) fx = the emitter's air sprite (p32 array)
//   T4 (fxFrames, fxFrameMs, fxRise, fxInkH)            glow: (anchorX, anchorY in the twin layer, radius, periodMs), map px
//   T5 (twin: array<<9 | layer+1 (0 = none), layerW | layerH<<8, anchorX, anchorY) in map-art px (1 = 7 art px)
// row r+1: class densities, u16 (0…65535), classes 4 per texel.
// Creature rows use the same shape: T0 (layer0, cum−1, kind, onMask), T1 (frames, frameMs, inkH, speed),
//   T2 (layerW, layerH, ax, ay), T3 (dwellMs, herdMin, herdMax, directions), T4 unused.

/** #include "life": table access, integer helpers, walkability and the kit path pose. */
export const LIFE = `
uniform highp usampler2D uLTable;
const int SPT = 6;                           // table texels per species
const float DEED_ART_F = 3136.0;
const float MIN_INK = 18816.0;               // MIN_SPRITE_PX (6) · DEED_ART: inkH · d must reach it
const float PLOT_CLEAR = 2.0;
const int LOOP_R = 96;                        // LOOP_RADIUS_TILES (3) · 32 art px
const int SNAP = 16;                          // WAYPOINT_SNAP

int floorDiv(int a, int b) { return a >= 0 ? a / b : -((-a + b - 1) / b); } // b > 0 (GLSL % and / on negatives are undefined)
ivec2 tileOf(ivec2 art) { return ivec2(floorDiv(art.x, 32), floorDiv(art.y, 32)); }
uvec4 lt(int x, int row) { return texelFetch(uLTable, ivec2(x, row), 0); }
uint density(int row, uint cls) { return lt(int(cls) >> 2, row + 1)[int(cls) & 3]; }
// LIFE's class of tile t: SAMPLED baked classes only (fix iteration 2, orchestrator P0 decision). LIFE never inlines
// GROUND's §3.2 classifier (rmClassAt / classAtTile / walkable): each inlined copy cost SwiftShader tens of seconds of
// pipeline JIT (the SCATTER program with 3 copies had not linked after 240 s; with none it links and draws in 1.5 s),
// every LIFE shader holds 1–9 class reads, and a real GPU links these programs at load. So:
//  - uTrueCls (scatter.js trueClasses: d >= BANDS.pageResolve, from where GROUND keeps the view +-1 deed resident):
//    the deed's resident TRUE page record (GROUND's own rule in classAtTile's resident branch);
//  - otherwise the MAP lattice class (7-tile vertices): a pure function of the position, so clumps, map objects and
//    herds never depend on the camera's history or a context restore (the LRU keeps leftover pages below pageResolve).
// lifeClassSeat: the same rule, but below the TRUE records GROUND's sampled near-water class (mapClassFine: exact about
// water between lattice vertices, so a river narrower than the lattice keeps its trees off). It costs 10 fetches near
// water (1 elsewhere) and ~0.4–1.2 s of SwiftShader JIT per inlined copy, so it is read ONCE per placement, at the seat
// of a scatter instance, a stand and a herd; neighbourhood probes, walks, birds and ambience keep lifeClass (every read
// fine measured LIFE's JIT at 31 s against 11 s, lane-life.md). Both sides of SHELL's CLASSES_STUB define these lookups.
uniform int uTrueCls;
const int DEED_TILES = 98;                   // contracts.js TILES
uint lifeClass(ivec2 t) {
  if (uTrueCls != 0 && pageResident(ivec2(floorDiv(t.x, DEED_TILES), floorDiv(t.y, DEED_TILES)))) return tileRecord(t).w & 15u;
  return mapClassAt(t);
}
uint lifeClassSeat(ivec2 t) {
  if (uTrueCls != 0 && pageResident(ivec2(floorDiv(t.x, DEED_TILES), floorDiv(t.y, DEED_TILES)))) return tileRecord(t).w & 15u;
  return mapClassFine(t);
}
#ifdef REALM_VS
// SHELL's band rehearsal (contracts GPU_SAFE.rehearse v2, W1): the pipeline's fragment-side work is built at the first
// draw that SHADES fragments, and LIFE's instances go wherever the data puts them (or cull). While uRehearse is set,
// every vertex of the ONE rehearsal instance — culled or placed, after the whole real vertex path ran — covers the
// viewport at the near plane (so the view centre, i.e. SHELL's scissored box, whatever the depth buffer holds); the
// fragment shader then runs with the instance's real varyings and textures. Every real draw sets it to 0 (life.js).
uniform int uRehearse;
void rehearsalCover() { if (uRehearse != 0) { int v = gl_VertexID % 3; gl_Position = vec4(v == 1 ? 3.0 : -1.0, v == 2 ? 3.0 : -1.0, -1.0, 1.0); } }
void cullVertex() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); rehearsalCover(); }
#endif
// a 16-bit hash field → [0, n) by multiply-shift (scatter.js range16). Never "% constant": compilers
// mis-optimise constant-divisor modulo after a shift (SwiftShader: (u >> 16u) % 97u is wrong).
uint range16(uint h16, uint n) { return ((h16 & 0xffffu) * n) >> 16u; }
// lattice cell hashes of a stream (scatter.js cellHash): h = pcg2d, h2 = kitHash
uvec2 cellH(int salt, ivec2 c) { return pcg2d(uvec2(ivec2(c.x ^ salt, c.y ^ (salt * 7)))); }
uint cellH2(int salt, ivec2 c) { return kitHash(c.x ^ salt, c.y); }
// integer seat (art px) of lattice cell c (scatter.js cellSeat)
ivec2 cellSeat(ivec2 c, int pitch, int jitter, uvec2 h) {
  int off = (pitch - jitter) >> 1; uint J = uint(jitter + 1);
  return c * pitch + off + ivec2(int(range16(h.x, J)), int(range16(h.x >> 16u, J)));
}
// ---- rank windows (W1; scatter.js rankHash / slotXY / xySlot / cellRank / slotCell): a cell's 16-bit rank is its
// slot j in its world-aligned 4×4 block (a scrambled ordered-dither order) · 4096 + the block hash's top 12 bits. The
// MAP→TRUE dissolve and the §9 thinning keep ranks under a bound, and a rank window submits only slots j0…j0+m−1 of
// every block. Loop-free integer maths.
const int RANK_B = 4, RANK_STEP = 4096;
uint rankHash(int salt, ivec2 b) { return pcg2d(uvec2(ivec2(b.x ^ salt ^ 0x5a17, b.y ^ (salt * 7) ^ 0x3c6e))).x; }
ivec2 rankScramble(uint h) { return ivec2(int(h & 3u), int((h >> 4u) & 3u)); }
ivec2 slotXY(int j) {
  int a = j & 3, b = (j >> 2) & 3;
  return ivec2((((a ^ (a >> 1)) & 1) << 1) | ((b ^ (b >> 1)) & 1), ((a & 1) << 1) | (b & 1));
}
int xySlot(ivec2 l) {
  int a = ((((l.x >> 1) ^ (l.y >> 1)) & 1) << 1) | ((l.y >> 1) & 1), b = (((l.x ^ l.y) & 1) << 1) | (l.y & 1);
  return a | (b << 2);
}
int cellRank(int salt, ivec2 c) {
  ivec2 b = ivec2(floorDiv(c.x, RANK_B), floorDiv(c.y, RANK_B)); uint h = rankHash(salt, b);
  return xySlot((c - b * RANK_B) ^ rankScramble(h)) * RANK_STEP + int(h >> 20u);
}
ivec2 slotCell(int salt, ivec2 b, int j, out int rank) {
  uint h = rankHash(salt, b); rank = j * RANK_STEP + int(h >> 20u);
  return b * RANK_B + (slotXY(j) ^ rankScramble(h));
}
// first species whose cumulative weight covers pick16 (scatter.js pickSpecies, a linear scan): a lower-bound search of the
// non-decreasing cum − 1 column, the same index. Stage B: MAX_SPECIES 64 (Solana Reach ships 53 map objects) in ≤ 7 fetches;
// the literal bound caps the work whatever n holds (2^7 > MAX_SPECIES).
int pickSpecies(int row, int n, uint pick) {
  int lo = 0, hi = n;
  for (int i = 0; i < 7; i++) { if (lo >= hi) break; int mid = (lo + hi) >> 1; if (pick <= lt(mid * SPT, row).y) hi = mid; else lo = mid + 1; }
  return lo < n ? lo : -1;
}
// walkable class for a creature kind (scatter.js walkableFor): ground avoids water, roads and plots' classes
bool walkableFor(uint kind, uint cls) {
  if (kind == 1u) return cls == 1u || cls == 2u || cls == 3u;               // WATER, SEA, SHORE
  return !(cls <= 2u || cls == 10u || cls == 11u || cls == 12u);            // not DEEP/SEA/WATER/ROAD/TURF/RING
}
int snapArt(int v) { return floorDiv(v + SNAP / 2, SNAP) * SNAP; }         // Math.round(v / 16) · 16
// every half tile along the straight walk a→b is walkable (scatter.js segmentWalkable)
bool segmentWalkable(uint kind, ivec2 a, ivec2 b) {
  ivec2 dv = b - a; int n = max(1, (max(abs(dv.x), abs(dv.y)) + SNAP - 1) / SNAP);
  for (int k = 1; k < 16; k++) {
    if (k >= n) break;
    ivec2 q = a + ivec2(floorDiv(dv.x * k, n), floorDiv(dv.y * k, n));
    if (!walkableFor(kind, lifeClass(tileOf(q)))) return false;
  }
  return true;
}
// GPU-hang guard (fix iteration 2, P0): no data-driven loop in any LIFE shader (every loop has a literal bound;
// scatter.test checks the source). isqrtU had two uint while-loops: an overflowed dv.x·dv.x wrapped n, (r+1)² wrapped
// too, and the loop could spin ~2^32 times per vertex. Now: a waypoint step is clamped to ±DV_MAX art px (a herd step
// is ≤ 2·LOOP_R = 192 per axis, so the clamp never binds on real data), and isqrtU is a float sqrt with r ≤ 65535
// (no r² wrap) plus at most one guarded correction each way. For any uint n the float sqrt is within ~0.002 + a few
// ULP of √n, so this is exactly ⌊√n⌋ (scatter.test replays it against scatter.js isqrt over 0…2·DV_MAX² with the
// sqrt perturbed ±4 ULP, and on the whole uint range). The clamp also keeps dv·t < DV_MAX · travelMs(DV_MAX, 1)
// < 2^31 in pathPose5, so garbage in is bounded garbage out, never a spin.
const int DV_MAX = 1024;
ivec2 dvSane(ivec2 dv) { return clamp(dv, ivec2(-DV_MAX), ivec2(DV_MAX)); }
uint isqrtU(uint n) {
  if (n < 2u) return n;
  uint r = min(uint(sqrt(float(n))), 65535u);
  if (r * r > n) r--;
  if (r < 65535u && (r + 1u) * (r + 1u) <= n) r++;
  return r;
}
int travelMs(ivec2 dv, int speed) { ivec2 c = dvSane(dv); return int(isqrtU(uint(c.x * c.x + c.y * c.y)) * 1000u / uint(max(speed, 1))); }
int facingOf(ivec2 dv) { // row in [down, left, right, up] (realmKitSegmentFacing + realmKitFacingRow, 4 directions)
  if (abs(dv.x) >= abs(dv.y)) return dv.x < 0 ? 1 : 2;
  return dv.y < 0 ? 3 : 0;
}
// realmKitPathPose on a closed 5-point loop (cycle). out: pos (art px), facing row, dwelling.
void pathPose5(ivec2 p[5], int speed, int dwell, uint elapsed, bool still, out ivec2 pos, out int row, out bool dwelling) {
  ivec2 d0 = p[1] - p[0];
  pos = p[0]; row = facingOf(d0); dwelling = true;
  if (still) return;
  int T[4]; int period = 0;
  for (int i = 0; i < 4; i++) { T[i] = travelMs(p[i + 1] - p[i], speed); period += dwell + T[i]; }
  int t = period > 0 ? int(elapsed % uint(period)) : 0;
  for (int i = 0; i < 4; i++) {
    ivec2 dv = dvSane(p[i + 1] - p[i]);
    if (t < dwell) { pos = p[i]; row = facingOf(dv); dwelling = true; return; }
    t -= dwell;
    if (t < T[i]) { pos = p[i] + ivec2(floorDiv(dv.x * t, T[i]), floorDiv(dv.y * t, T[i])); row = facingOf(dv); dwelling = false; return; }
    t -= T[i];
  }
}
// ---- round 2: the stand field, clearing edges, species clusters (scatter.js "round 2" section) ----------
uniform ivec4 uField;    // stand-field salts: veg, rock, -, -
uniform ivec4 uCover;    // cover ramps: veg lo, veg k, rock lo, rock k  (k = 65536 / (hi − lo))
const int EDGE_FLAT_Q = 32; // STAND.edgeFlat (8) · 4 quarter tiles at full weight
const int EDGE_Q = 56;   // (STAND.edgeFlat + STAND.edgeTiles) · 4
const int EDGE_INV = 2730; // ⌊65536 / (STAND.edgeTiles · 4)⌋
uint fadeU8(uint t) { return (t * t * (768u - 2u * t)) >> 16u; }
uint vcell(int salt, int cx, int cy) { return pcg2d(uvec2(ivec2(cx ^ salt, cy ^ (salt * 7)))).x & 255u; }
uint valueU8(int salt, ivec2 p, int sh) {
  int m = (1 << sh) - 1; ivec2 c = p >> sh;
  uint fx = fadeU8(uint(((p.x & m) << 8) >> sh)), fy = fadeU8(uint(((p.y & m) << 8) >> sh));
  uint a = vcell(salt, c.x, c.y) * (256u - fx) + vcell(salt, c.x + 1, c.y) * fx;
  uint b = vcell(salt, c.x, c.y + 1) * (256u - fx) + vcell(salt, c.x + 1, c.y + 1) * fx;
  return (a * (256u - fy) + b * fy) >> 16u;
}
uint standField(int salt, ivec2 p) { return (valueU8(salt, p, 10) * 3u + valueU8(salt ^ 0x5bd1, p, 9)) >> 2u; }
int coverOf(uint V, int lo, int k) { return clamp(((int(V) - lo) * k) >> 8, 0, 256); }
int fieldCover(int f, ivec2 p) { return f == 1 ? coverOf(standField(uField.y, p), uCover.z, uCover.w) : coverOf(standField(uField.x, p), uCover.x, uCover.y); }
// −1 inside the clearance, 255 for EDGE_FLAT_Q quarter tiles beyond, then falling to 0 at EDGE_Q (scatter.js edgeWeight)
int edgeW(float sdf, float clear) { int e = int(floor(min(sdf - clear, 64.0) * 4.0)); return e < 0 ? -1 : e < EDGE_FLAT_Q ? 255 : e >= EDGE_Q ? 0 : ((EDGE_Q - e) * EDGE_INV) >> 8; }
uint modDensity(uint dens, int outK, int inK, int edgeK, int cov, int ew) {
  int m = outK + (((inK - outK) * cov) >> 8);
  m = max(m, ew > 0 ? (edgeK * ew) >> 8 : 0);
  return min(65535u, (dens * uint(m)) >> 8u);
}
uint clusterPick(int salt, ivec2 p) { return pcg2d(uvec2(ivec2((p.x >> 8) ^ (salt * 3), (p.y >> 8) ^ (salt * 5)))).x >> 16u; }

// The scatter instance of lattice cell c in a group (scatter.js scatterInstance): seat, species, h2, class.
// B = (pitchArt, jitterArt, salt, nSpecies); C = (flags, table row, out | in<<12, edge | field<<12 | mod<<13 |
// cluster8<<16) — the round-2 density modulation and species clusters. False when culled.
bool scatterPick(ivec2 c, ivec4 B, ivec4 C, out ivec2 seat, out int s, out uint h2) {
  int row = C.y;
  uvec2 h = cellH(B.z, c); h2 = cellH2(B.z, c);
  seat = cellSeat(c, B.x, B.y, h); s = -1;
  ivec2 tile = tileOf(seat);
  uint cls = lifeClassSeat(tile);
  uint dens = density(row, cls);
  float sdf = 0.0; bool haveSdf = false;
  if ((C.w & 0x2000) != 0 && dens != 0u) {
    sdf = plotSdf(vec2(seat) / 32.0); haveSdf = true;
    dens = modDensity(dens, C.z & 4095, C.z >> 12, C.w & 4095, fieldCover((C.w >> 12) & 1, seat), edgeW(sdf, PLOT_CLEAR));
  }
  if ((h.y & 0xffffu) >= dens) return false;
  uint pick = h.y >> 16u;
  int cl = (C.w >> 16) & 255;
  if (cl > 0 && int(pcg2d(h).x & 255u) < cl) pick = clusterPick(B.z, seat);
  s = pickSpecies(row, B.w, pick);
  if (s < 0) return false;
  uvec4 t0 = lt(s * SPT, row);
  if ((C.x & 4) != 0 && t0.w != 0u && ((t0.w >> cls) & 1u) == 0u) { // map objects: two more picks (scatter.js scatterInstance)
    uint e = pcg2d(uvec2(h.y, h.x)).x;
    int s2 = pickSpecies(row, B.w, e >> 16u);
    uint w2 = s2 >= 0 ? lt(s2 * SPT, row).w : 0u;
    if (s2 < 0 || (w2 != 0u && ((w2 >> cls) & 1u) == 0u)) { s2 = pickSpecies(row, B.w, e & 0xffffu); w2 = s2 >= 0 ? lt(s2 * SPT, row).w : 0u; }
    if (s2 >= 0 && (w2 == 0u || ((w2 >> cls) & 1u) != 0u)) { s = s2; t0 = lt(s * SPT, row); }
  }
  uvec4 t1 = lt(s * SPT + 1, row);
  if (t0.w != 0u && ((t0.w >> cls) & 1u) == 0u) return false;
  int r = int(t1.w);
  if (r > 1) { // set pieces: the footprint corners stand on classes this group may use
    ivec2 k[4] = ivec2[4](ivec2(-r, -r), ivec2(r, -r), ivec2(-r, 0), ivec2(r, 0));
    for (int i = 0; i < 4; i++) {
      uint cc = lifeClass(tile + k[i]);
      if (t0.w != 0u ? ((t0.w >> cc) & 1u) == 0u : density(row, cc) == 0u) return false;  // species' classes, else the group's
    }
  }
  if (((t0.z >> 4u) & 1u) != 0u) { // coast need: open water within r + 3 tiles on one axis
    int q = r + 3; bool wet = false;
    ivec2 k[4] = ivec2[4](ivec2(q, 0), ivec2(-q, 0), ivec2(0, q), ivec2(0, -q));
    for (int i = 0; i < 4; i++) if (lifeClass(tile + k[i]) <= 2u) wet = true;
    if (!wet) return false;
  }
  return (haveSdf ? sdf : plotSdf(vec2(seat) / 32.0)) >= PLOT_CLEAR + float(r);
}
// ---- stands (scatter.js standSite / standMember). Table rows: row = species (SPT texels each), row+1 = per-mix
// class densities (mix k at texels 4k…4k+3), row+2+v = variant v: texel 0 (mix | members<<4 | field<<9 | sway<<10,
// R4, clumpLayer+1, clumpArray), 1 (clumpW | clumpH<<8, anchorX, anchorY, inkH) in map-art px (1 = 7 art px),
// 2+m (dx+32768, dy+32768, species, flip), 18 (footDy+32768).
uniform ivec4 uStand;    // pitchArt, jitterArt, salt, nVariants
uint mixDensity(int row, int mix, uint cls) { return lt(mix * 4 + (int(cls) >> 2), row + 1)[int(cls) & 3]; }
bool standSite(ivec2 c, int row, out ivec2 seat, out int v, out uint h2, out uvec4 hd, out float sdf) {
  uvec2 h = cellH(uStand.z, c); h2 = cellH2(uStand.z, c);
  seat = cellSeat(c, uStand.x, uStand.y, h);
  ivec2 tile = tileOf(seat);
  uint cls = lifeClassSeat(tile);
  uint e0 = pcg2d(h).x, nV = uint(uStand.w);                       // up to three picks (scatter.js standSite)
  v = int(range16(h.y >> 16u, nV)); hd = lt(0, row + 2 + v);
  if (mixDensity(row, int(hd.x & 15u), cls) == 0u) { v = int(range16(e0 & 0xffffu, nV)); hd = lt(0, row + 2 + v); }
  if (mixDensity(row, int(hd.x & 15u), cls) == 0u) { v = int(range16(e0 >> 16u, nV)); hd = lt(0, row + 2 + v); }
  int mix = int(hd.x & 15u);
  uint p = mixDensity(row, mix, cls);
  if (p == 0u) return false;
  sdf = plotSdf(vec2(seat) / 32.0);
  int ew = edgeW(sdf, PLOT_CLEAR + float(hd.y) * 0.25);
  if (ew < 0) return false;
  uint cov = ((hd.x >> 11u) & 1u) != 0u ? 256u : uint(fieldCover(int((hd.x >> 9u) & 1u), seat)); // a map-only canopy fills its class
  uint q = max((p * cov) >> 8u, (p * uint(ew)) >> 8u);
  if ((h.y & 0xffffu) >= q) return false;
  int R = (int(hd.y) + 3) >> 2, D = (R * 181) >> 8;             // whole tiles; the diagonal at R/√2
  ivec2 k[8] = ivec2[8](ivec2(R, 0), ivec2(-R, 0), ivec2(0, R), ivec2(0, -R), ivec2(D, D), ivec2(-D, D), ivec2(D, -D), ivec2(-D, -D));
  for (int i = 0; i < 8; i++) if (mixDensity(row, mix, lifeClass(tile + k[i])) == 0u) return false;
  return true;
}
#ifdef STAND_MERGED
// The merged clump of 2×2 stand block b (scatter.js mergedSite): its first stand in the order (0,0) (1,0) (0,1)
// (1,1) whose doubled clump (2R) clears every plot and stands on the mix's classes at 2R along both axes. Only the
// life-stand-merged program compiles it (P0 fix pass: its 4-trip loop over standSite was ~4/5 of STAND's JIT).
bool mergedSite(ivec2 b, int row, out ivec2 seat, out int v, out uint h2, out uvec4 hd) {
  float sdf;
  for (int i = 0; i < 4; i++) {
    if (!standSite(b * 2 + ivec2(i & 1, i >> 1), row, seat, v, h2, hd, sdf)) continue;
    int R2 = ((int(hd.y) + 3) >> 2) * 2, mix = int(hd.x & 15u);                  // STAND.merge = 2
    if (sdf < PLOT_CLEAR + float(R2)) continue;
    ivec2 t = tileOf(seat);
    if (mixDensity(row, mix, lifeClass(t + ivec2(R2, 0))) == 0u || mixDensity(row, mix, lifeClass(t - ivec2(R2, 0))) == 0u ||
        mixDensity(row, mix, lifeClass(t + ivec2(0, R2))) == 0u || mixDensity(row, mix, lifeClass(t - ivec2(0, R2))) == 0u) continue;
    return true;
  }
  return false;
}
#endif
// One herd member (scatter.js herdSite → herdMember → memberPose) on creature table row "row".
// cre = (pitchArt, jitterArt, salt, nSpecies). Returns false when the member is culled; the caller applies
// the anti-speckle rule. s = species, pos = feet (art px), frame = sheet frame (row·frames + walk).
bool herdMemberPose(ivec2 cell, int m, ivec4 cre, int row, float keep, uint clockMs, bool still, out int s, out ivec2 pos, out int frame) {
  s = -1; pos = ivec2(0); frame = 0;
  uvec2 h = cellH(cre.z, cell); uint h2 = cellH2(cre.z, cell);
  ivec2 seat = cellSeat(cell, cre.x, cre.y, h);
  uint cls = lifeClassSeat(tileOf(seat));
  if ((h.y & 0xffffu) >= density(row, cls)) return false;
  s = pickSpecies(row, cre.w, h.y >> 16u);
  if (s < 0) return false;
  uvec4 t0 = lt(s * SPT, row), t1 = lt(s * SPT + 1, row), t3 = lt(s * SPT + 3, row);
  uint kind = t0.z;
  if (((t0.w >> cls) & 1u) == 0u || !walkableFor(kind, cls)) return false;
  if (plotSdf(vec2(seat) / 32.0) < PLOT_CLEAR + 3.0 + 2.0) return false;
  if (float(h2 & 0xffffu) >= keep * 65536.0) return false;
  int n = int(t3.y) + int(range16(h2 >> 16u, t3.z - t3.y + 1u));
  if (m >= n) return false;
  uvec2 ab = pcg2d(uvec2(h2 ^ uint(m * 0x9e37), uint(cell.x * 31 + cell.y * 17 + m)));
  ivec2 home = m == 0 ? ivec2(snapArt(seat.x), snapArt(seat.y))
                      : ivec2(snapArt(seat.x + int(range16(ab.x, 97u)) - 48), snapArt(seat.y + int(range16(ab.x >> 16u, 97u)) - 48));
  if (!walkableFor(kind, lifeClass(tileOf(home)))) return false;
  uvec2 c12 = pcg2d(ab); uint c3 = pcg2d(uvec2(ab.y, ab.x)).x;
  uint hs[3] = uint[3](c12.x, c12.y, c3);
  ivec2 p[5]; p[0] = home; p[4] = home;
  uint span = uint(2 * LOOP_R + 1);
  ivec2 prev = home;
  for (int i = 0; i < 3; i++) {
    ivec2 q = ivec2(snapArt(home.x + int(range16(hs[i], span)) - LOOP_R), snapArt(home.y + int(range16(hs[i] >> 16u, span)) - LOOP_R));
    if (walkableFor(kind, lifeClass(tileOf(q))) && segmentWalkable(kind, prev, q) && segmentWalkable(kind, q, home)) prev = q;
    p[i + 1] = prev;
  }
  uint elapsed = clockMs + ((ab.y >> 8u) & 0xffffu);
  int facing; bool dwelling;
  pathPose5(p, int(t1.w), int(t3.x), elapsed, still, pos, facing, dwelling);
  int frames = int(t1.x);
  frame = facing * frames + (still || dwelling ? 0 : int((elapsed / max(t1.y, 1u)) % uint(frames)));
  return true;
}
`;

/** Scatter + feature emitters. uMode 0: the kit sprite of every instance whose species lives in array uArray
 * (TRUE, and twins that have no reducer-built twin); uMode 1: the rising puffs (uPuffs per instance) of species
 * with an emitter, from the air array; uMode 2: the map-scale twin (PACK's mapkit twins, twin array uArray). */
export const SCATTER_VS = `
#include "common"
#include "classes"
#include "life"
layout(location = 0) in vec2 aQ;
uniform ivec4 uGrp[8];   // ix0, iy0, nx, first instance
uniform ivec4 uGrpB[8];  // pitchArt, jitterArt, salt, nSpecies
uniform ivec4 uGrpC[8];  // flags (1 twin, 2 sway, 4 map-only: a twin across the whole MAP band; bits 8+: lattice stride), table row, mod A, mod B (scatterPick)
uniform ivec4 uGrpR[8];  // W1 rank window (scatter.js rankDraw): slots per block (0: uGrp is the plain window), first slot, TRUE rank bound, this draw's upper rank bound
uniform int uNG;
uniform int uArray;
uniform int uMode;
uniform int uPuffs;
uniform uint uPuffLife;  // ms (a uniform: never '% constant' in these shaders)
uniform vec2 uWind;      // art px / s
out vec2 vTex;           // texel coordinate inside the layer
flat out int vLayer;
flat out float vFade;
flat out vec4 vGlow;     // Stage B (SPRITE_FS LIFE_GLOW): a map object's lens glow — anchor (layer px), radius, strength; z 0 = none
const float GLOW_LO = 0.3, GLOW_REST = 0.6; // scatter.js GLOW.lo, GLOW.rest
void main() {
  vGlow = vec4(0.0);
  int id = gl_InstanceID, puff = 0;
  if (uMode == 1) { puff = id % uPuffs; id = id / uPuffs; }
  int g = 0;
  for (int i = 1; i < 8; i++) if (i < uNG && id >= uGrp[i].w) g = i;
  ivec4 G = uGrp[g], B = uGrpB[g], C = uGrpC[g], R = uGrpR[g];
  int local = id - G.w, st = max(1, C.x >> 8);  // stride: a thinned, world-aligned map-object lattice (scatter.js mapStride)
  bool mapOnly = (C.x & 4) != 0;
  ivec2 cell; int rank = 0;
  if (R.x > 0) { int bi = local / R.x; cell = slotCell(B.z, ivec2(G.x + bi % G.z, G.y + bi / G.z), R.y + local % R.x, rank); } // G = the blocks
  else { cell = ivec2(G.x + (local % G.z) * st, G.y + (local / G.z) * st); rank = cellRank(B.z, cell); }
  // outside this draw's rank range: kit and puffs [0, R.w), twins [R.z, R.w) — culled before any placement read
  if (rank >= R.w || (uMode == 2 && rank < R.z)) { cullVertex(); return; }
  int row = C.y, s; ivec2 seat; uint h2;
  if (!scatterPick(cell, B, C, seat, s, h2)) { cullVertex(); return; }
  uvec4 t0 = lt(s * SPT, row), t1 = lt(s * SPT + 1, row), t5 = lt(s * SPT + 5, row);
  uint flags = t0.z >> 4u;
  bool hasTwin = (t5.x & 511u) != 0u;
  if (uMode == 0 && int(t0.z & 15u) != uArray) { cullVertex(); return; }
  if (uMode == 1 && (flags & 2u) == 0u) { cullVertex(); return; }
  if (uMode == 2 && (!hasTwin || int(t5.x >> 9u) != uArray)) { cullVertex(); return; }
  float d = uViewport.z;
  if (float(t1.z) * d < MIN_INK) { cullVertex(); return; }
  // MAP→TRUE and the twin switch-in: the rank (W1; a twin group's draws end at its twin bound, R.w); map objects dissolve
  // out by their hash and are twins across the whole MAP band
  bool tru = mapOnly ? dissolve(h2, uBand.z) : rank < R.z;
  bool twin = !tru && (C.x & 1) != 0 && (mapOnly || rank < R.w);
  if (!tru && !twin) { cullVertex(); return; }
  if (uMode == 0 && twin && hasTwin) { cullVertex(); return; }   // drawn by the twin pass instead
  if (uMode == 2 && !twin) { cullVertex(); return; }
  bool rm = uViewport.w > 0.5;
  uint phase = (h2 >> 17u) & 0x7fffu;
  uvec4 t2 = lt(s * SPT + 2, row);
  vec2 corner; vec2 size; int layer; float fade = 1.0; float footY;
  if (uMode != 1) {
    int frames = int(t1.x), frame = 0;
    if (uMode == 0 && frames > 1 && !rm) frame = int(((uClock.x + phase * 37u) / max(t1.y, 1u)) % uint(frames));
    bool flip = ((h2 >> 16u) & 1u) == 1u;
    // kit art in art px; a twin in map-art px, 1 map px = 7 art px (the same world size and seat)
    float k = uMode == 2 ? 7.0 : 1.0;
    vec4 g = uMode == 2 ? vec4(float(t5.y & 255u), float(t5.y >> 8u), float(t5.z), float(t5.w)) : vec4(t2);
    size = g.xy;
    float ax = flip ? g.x - g.z : g.z;
    corner = vec2(seat) + vec2(aQ.x * size.x - ax, aQ.y * size.y - g.w) * k;
    if ((C.x & 2) != 0 && uLod.z > 0.5 && !rm && aQ.y < 0.5) { // A7 sway: top edge ±1 art px
      uint period = 3000u + range16(h2 >> 16u, 2001u);
      corner.x += floor(sin(float(uClock.x % period) / float(period) * 6.2831853 + float(phase)) + 0.5);
    }
    vTex = vec2(flip ? 1.0 - aQ.x : aQ.x, aQ.y) * size;
    layer = uMode == 2 ? int(t5.x & 511u) - 1 : int(t0.x) + frame;
    footY = float(seat.y);
    if (uMode == 2 && (flags & 4u) != 0u) { // the lens glow's strength (scatter.js glowPulse): a smoothstepped triangle, hashed phase
      uvec4 t4 = lt(s * SPT + 4, row); uint per = max(t4.w, 1u); // the period is a table value: never '% constant'
      float tri = 1.0 - abs(2.0 * float((uClock.x + phase * 61u) % per) / float(per) - 1.0);
      vGlow = vec4(float(t4.x) + 0.5, float(t4.y) + 0.5, float(t4.z), rm ? GLOW_REST : GLOW_LO + (1.0 - GLOW_LO) * tri * tri * (3.0 - 2.0 * tri));
    }
  } else { // emitter puff: rises from the anchor offset, drifts with the wind, Bayer-faded at both ends
    if (rm) { cullVertex(); return; }
    uvec4 t3 = lt(s * SPT + 3, row), t4 = lt(s * SPT + 4, row);
    if (t3.y == 0u || float(t4.w) * d < MIN_INK) { cullVertex(); return; }
    uint life = uPuffLife, t = (uClock.x + phase * 53u + uint(puff) * life / uint(uPuffs)) % life;
    float u = float(t) / float(life);
    size = vec2(32.0);
    vec2 base = vec2(seat) + vec2(float(int(t3.z) - 32768), float(int(t3.w) - 32768));
    vec2 p = base + vec2(uWind.x * u * 1.6, -float(t4.z) * u + uWind.y * u);
    corner = floor(p) + vec2(aQ.x * 32.0 - 16.0, aQ.y * 32.0 - 16.0);
    fade = min(1.0, min(u / 0.15, (1.0 - u) / 0.3));
    int fr = int((uClock.x / max(t4.y, 1u) + uint(puff)) % max(t4.x, 1u));
    layer = int(t3.y) - 1 + fr;
    vTex = aQ * size;
    footY = float(seat.y) + 1.0;
  }
  vec2 css = deedToCss(corner / DEED_ART_F);
  gl_Position = cssToClip(css, spriteDepth(deedToCss(vec2(float(seat.x), footY) / DEED_ART_F).y));
  vLayer = layer; vFade = fade;
  rehearsalCover();
}
`;

/** Creatures: herd members on world-anchored sites walking closed 4-waypoint kit paths (A9, A18). */
export const CREATURE_VS = `
#include "common"
#include "classes"
#include "life"
layout(location = 0) in vec2 aQ;
uniform ivec4 uWin;      // ix0, iy0, nx, stride (RM-20: a world-aligned thinned lattice, keep scaled to match)
uniform ivec4 uCre;      // pitchArt, jitterArt, salt, nSpecies
uniform int uRow;
uniform float uKeep;
out vec2 vTex;
flat out int vLayer;
flat out float vFade;
void main() {
  int id = gl_InstanceID, m = id & 3, si = id >> 2;   // HERD_MAX = 4 (bitwise: no integer division by a constant)
  ivec2 cell = ivec2(uWin.x, uWin.y) + ivec2(si % uWin.z, si / uWin.z) * max(1, uWin.w);
  int s, frame; ivec2 pos;
  if (!herdMemberPose(cell, m, uCre, uRow, uKeep, uClock.x, uViewport.w > 0.5, s, pos, frame)) { cullVertex(); return; }
  uvec4 t0 = lt(s * SPT, uRow), t1 = lt(s * SPT + 1, uRow), t2 = lt(s * SPT + 2, uRow);
  if (float(t1.z) * uViewport.z < MIN_INK) { cullVertex(); return; }
  vec2 size = vec2(t2.xy);
  vec2 corner = vec2(pos) + vec2(aQ.x * size.x - float(t2.z), aQ.y * size.y - float(t2.w));
  gl_Position = cssToClip(deedToCss(corner / DEED_ART_F), spriteDepth(deedToCss(vec2(pos) / DEED_ART_F).y));
  vTex = aQ * size;
  vLayer = int(t0.x) + frame;
  vFade = 1.0;
  rehearsalCover();
}
`;

/** Stands (round 2, T1/T2; fix iteration 1): uMode 0 draws the members (kit art of array uArray; instance id =
 * site·16 + member) once the stand has switched to TRUE; uMode 2 draws each stand's own composed clump (the members'
 * map twins, same layout) from the merged hand-over on; uMode 3 draws ONE merged clump per 2×2 block of stand cells
 * (its first stand, 2×) across low MAP (scatter.js mergedSite / mergedLod / standLod).
 * Two programs (P0 fix pass, RM-GPU-1): life-stand (uMode 0 and 2) and life-stand-merged (#define STAND_MERGED, uMode 3
 * only). mergedSite inlines standSite in a 4-trip loop, so one program with all three paths paid 5 standSite copies of
 * pipeline JIT at its first draw (5.3 s on SwiftShader) wherever stands first showed; now each band builds only the
 * path it draws, and SHELL's band rehearsal pre-draws both (life.js rehearse). */
export const STAND_VS = `
#include "common"
#include "classes"
#include "life"
layout(location = 0) in vec2 aQ;
uniform ivec4 uWin;      // ix0, iy0, nx, stride (uMode 3: block coordinates; stride 2 thins them world-aligned); a rank window: bx0, by0, nbx
uniform ivec4 uRank;     // W1 rank window (scatter.js rankDraw): slots per block (0: plain), first slot, TRUE rank bound, this draw's upper rank bound
uniform int uRow;
uniform int uArray;
uniform int uMode;
uniform vec4 uSplit;     // STAND.splitFrom, STAND.splitFull, STAND.mergeFrom, S.mergeUntil (d)
out vec2 vTex;
flat out int vLayer;
flat out float vFade;
// own clump shows (scatter.js ownClump): over 6 px and switched in by its per-stand hashed hand-over
bool ownClump(uint inkH, uint h2, float d) {
  return float(inkH) * d >= MIN_INK && dissolve(h2 >> 16u, clamp((d - uSplit.x) / (uSplit.y - uSplit.x), 0.0, 1.0));
}
void main() {
  int id = gl_InstanceID, m = 0;
  ivec2 seat; int v; uint h2; uvec4 hd; float sdf;
  float d = uViewport.z, k = 7.0;
#ifdef STAND_MERGED
  // merged (uMode 3): the block's first stand whose doubled clump clears plots and stays on its mix's ground
  ivec2 cell = ivec2(uWin.x, uWin.y) + ivec2(id % uWin.z, id / uWin.z) * max(1, uWin.w);
  if (!mergedSite(cell, uRow, seat, v, h2, hd)) { cullVertex(); return; }
  k = 14.0; // STAND.merge (2) · 7 art px per map px
  bool tru = dissolve(h2, uBand.z);                 // merged blocks end before the TRUE fade (w.true = 0: never)
#else
  if (uMode == 0) { m = id & 15; id = id >> 4; }  // STAND.members = 16 (bitwise: no division by a constant)
  ivec2 cell; int rank;
  if (uRank.x > 0) { int bi = id / uRank.x; cell = slotCell(uStand.z, ivec2(uWin.x + bi % uWin.z, uWin.y + bi / uWin.z), uRank.y + id % uRank.x, rank); }
  else { cell = ivec2(uWin.x, uWin.y) + ivec2(id % uWin.z, id / uWin.z) * max(1, uWin.w); rank = cellRank(uStand.z, cell); }
  // members [0, uRank.w), own clumps [uRank.z, uRank.w): culled before the stand site's reads
  if (rank >= uRank.w || (uMode == 2 && rank < uRank.z)) { cullVertex(); return; }
  if (!standSite(cell, uRow, seat, v, h2, hd, sdf)) { cullVertex(); return; }
  bool tru = rank < uRank.z;                        // one switch per stand: its rank (W1)
#endif
  bool flip = ((h2 >> 16u) & 1u) == 1u;
  int vrow = uRow + 2 + v;
  vec2 corner, size; int layer; float footY;
#ifndef STAND_MERGED
  if (uMode == 0) {
    if (!tru || m >= int((hd.x >> 4u) & 31u) || ((hd.x >> 11u) & 1u) != 0u) { cullVertex(); return; } // map-only canopy: no TRUE members
    uvec4 mm = lt(2 + m, vrow);
    int dx = int(mm.x) - 32768;
    ivec2 pos = seat + ivec2(flip ? -dx : dx, int(mm.y) - 32768);
    if (mixDensity(uRow, int(hd.x & 15u), lifeClass(tileOf(pos))) == 0u || plotSdf(vec2(pos) / 32.0) < PLOT_CLEAR + 1.0) { cullVertex(); return; }
    int s = int(mm.z);
    uvec4 t0 = lt(s * SPT, uRow), t1 = lt(s * SPT + 1, uRow), t2 = lt(s * SPT + 2, uRow);
    if (int(t0.z & 15u) != uArray || float(t1.z) * d < MIN_INK) { cullVertex(); return; }
    bool mf = flip != (mm.w != 0u);
    size = vec2(t2.xy);
    corner = vec2(pos) + vec2(aQ.x * size.x - (mf ? size.x - float(t2.z) : float(t2.z)), aQ.y * size.y - float(t2.w));
    if (((hd.x >> 10u) & 1u) != 0u && uLod.z > 0.5 && uViewport.w < 0.5 && aQ.y < 0.5) { // A7 sway: top edge ±1 art px
      uint ph = (h2 >> 17u) ^ uint(m * 977);
      uint period = 3000u + range16(ph, 2001u);
      corner.x += floor(sin(float(uClock.x % period) / float(period) * 6.2831853 + float(ph & 0x7fffu)) + 0.5);
    }
    vTex = vec2(mf ? 1.0 - aQ.x : aQ.x, aQ.y) * size;
    layer = int(t0.x);
    footY = float(pos.y);
  } else
#endif
  { // a clump: the stand's own (uMode 2) or its block's merged one (uMode 3)
    if (tru || hd.z == 0u || int(hd.w) != uArray) { cullVertex(); return; }
    uvec4 hc = lt(1, vrow);
    bool own = ownClump(hc.w, h2, d);
    if (uMode == 2 ? !own : (own || d < uSplit.z || d >= uSplit.w || float(hc.w) * 2.0 * d < MIN_INK)) { cullVertex(); return; }
    size = vec2(float(hc.x & 255u), float(hc.x >> 8u));
    corner = vec2(seat) + vec2(aQ.x * size.x - (flip ? size.x - float(hc.y) : float(hc.y)), aQ.y * size.y - float(hc.z)) * k;
    vTex = vec2(flip ? 1.0 - aQ.x : aQ.x, aQ.y) * size;
    layer = int(hd.z) - 1;
    footY = float(seat.y) + float(int(lt(18, vrow).x) - 32768) * (k / 7.0);
  }
  gl_Position = cssToClip(deedToCss(corner / DEED_ART_F), spriteDepth(deedToCss(vec2(float(seat.x), footY) / DEED_ART_F).y));
  vLayer = layer; vFade = 1.0;
  rehearsalCover();
}
`;

/** Sprite fragment: sharp magnification, reducer-built mips when minified, binary alpha, cloud shade (A6). */
export const SPRITE_FS = `
#include "common"
uniform highp sampler2DArray uArr;
uniform float uArtPerDeed;   // art px per deed of this layer (3136 kit art) for the cloud-shade quantisation
in vec2 vTex;
flat in int vLayer;
flat in float vFade;
#ifdef LIFE_GLOW
flat in vec4 vGlow;      // life-scatter only (the other LIFE vertex shaders have no such output)
#endif
out vec4 o;
void main() {
  vec2 size = vec2(textureSize(uArr, 0).xy);
  vec2 px = sharpUV(vTex);
  vec4 c = textureGrad(uArr, vec3(px / size, float(vLayer)), dFdx(vTex / size), dFdy(vTex / size));
#ifdef LIFE_GLOW
  if (vGlow.z > 0.0) { // Stage B lens glow: the lens brightens and a dithered halo breathes around it (no blending: binary alpha)
    float r = length(vTex - vGlow.xy) / vGlow.z;
    if (r < 1.0) {
      float g = vGlow.w * (1.0 - r);
      vec3 hot = mix(texelFetch(uArr, ivec3(ivec2(vGlow.xy), vLayer), 0).rgb, vec3(1.0), 0.55); // the lens's own colour, lightened
      if (c.a >= 0.5) c.rgb = mix(c.rgb, hot, 0.7 * g);
      else if (bayer4(ivec2(gl_FragCoord.xy)) < g) c = vec4(hot, 1.0);
    }
  }
#endif
  if (c.a < 0.5) discard;
  if (vFade < 1.0 && bayer4(ivec2(gl_FragCoord.xy)) >= vFade) discard;
  o = vec4(c.rgb * cloudShade(fragDeed(), uArtPerDeed), 1.0);
}
`;
