// LIFE lane (D-164 realm maps; docs/REALM-MAP-PLAN.md §2.2, §3.6, §5.1, §7): the pure, deterministic
// placement maths behind every living thing on a realm map — scatter (trees, scrub, rocks, crops,
// litter), features and landmarks, creatures (herds at MAP, kit creatures at TRUE), birds and ambience.
//
// It is the JS reference of glsl/sprites.glsl.js and glsl/air.glsl.js: the shaders place instances from
// gl_InstanceID over the same world-anchored lattices with the same integer hashes, so offline QC and the
// tests below can reproduce any instance exactly. No wall clock, no Math.random: an instance is a function
// of (realm, group, lattice cell) and an animation pose of (instance, uClock ms).
//
// Units: art px (32 per tile at 1×, 3136 per deed) for positions; tiles for lattice pitches; realm tile
// coordinates run tile = deed·98 + local from the pack grid origin (plan §3.2).
import { ART, DEED_ART, CLASS, BANDS, TILES as TILES_PER_DEED } from './contracts.mjs';
import { bands } from './camera.mjs';
import { kitHash, pcg2d, dissolve } from './glsl/common.glsl.mjs';

// ---- presentation caps and rules (plan §2.3, §7). LIFE-only presentation numbers; at productisation they
// move with the rest of the realm-map numbers into constants.ts (plan §6.3 last paragraph). ---------------
/** The anti-speckle rule (§2.3): a sprite whose ink is under 6 device px tall is not drawn. */
export const MIN_SPRITE_PX = 6;
/** On-screen caps (§7 table A7–A18, §9 instance budget). */
export const LIFE_CAPS = Object.freeze({
  sway: 6000,          // A7 trees swaying
  props: 200,          // A8 animated props (features/landmarks with clips)
  creatures: 120,      // A9 kit creatures at TRUE
  birds: 24,           // A10
  particles: 300,      // A11
  herds: 60,           // A18 herd animals at MAP
  mapobj: 4000,        // map-object lattice cells walked per frame: the lattice thins by 2× steps (world-anchored) past it
  submitted: { phone: 40000, desktop: 60000 }, // §9 instances submitted per frame (all LIFE draws)
});
/** A CSS viewport whose short side is at most this is a phone (every phone and small tablet, portrait or landscape). */
export const PHONE_CSS_MAX = 600;
/**
 * The §9 submitted-instance ceiling of a view (RM-20, P0 fix pass): per device class, never per pixel. At the same d a
 * dpr-3 phone or a dpr-2 desktop shows 2.3–4× the world of a dpr-2 phone or dpr-1 desktop, and LIFE's lattice windows
 * grew with it (50–52k on a 390×844 dpr-3 phone against 40k, 136–140k on 1920×1080 dpr 2 against 60k). planDraws
 * enforces this; the budget test covers dpr 1–3.
 */
export const submittedCap = view => (Math.min(view.W, view.H) <= PHONE_CSS_MAX ? LIFE_CAPS.submitted.phone : LIFE_CAPS.submitted.desktop);
/** The coarsest thinning stride planDraws may use to meet submittedCap (1/64 of a lattice). */
export const THIN_MAX = 8;
/** The order the ceiling thins scatter groups in: the least defining first (ground litter before rocks, scrub, crops;
 * the grove, the realm's woods, last); a group not listed goes after these. */
export const THIN_ORDER = Object.freeze(['litter', 'rocks', 'scrub', 'crops', 'grove', 'lone', 'features', 'landmarks']);
/** Sway (A7): the top two vertices move ≤ 1 art px, 3–5 s per instance. */
export const SWAY = Object.freeze({ ampArt: 1, periodMinMs: 3000, periodMaxMs: 5000 });
/** Sky scale for things that fly (A10): birds read at MAP by drawing up to 3× their art size. */
export const skyScale = d => Math.min(3, Math.max(1, BANDS.trueFull / Math.max(1, d)));

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
/** Device px of `inkArt` art px at d device px per deed (× an optional draw scale). */
export const devicePx = (inkArt, d, scale = 1) => inkArt * scale * d / DEED_ART;
/** The d at which `inkArt` art px reach MIN_SPRITE_PX (the sprite's first visible zoom). */
export const minVisibleD = (inkArt, scale = 1) => MIN_SPRITE_PX * DEED_ART / Math.max(1e-6, inkArt * scale);
/** The anti-speckle test the vertex shaders run (integer-free, same inequality). */
export const bigEnough = (inkArt, d, scale = 1) => inkArt * scale * d >= MIN_SPRITE_PX * DEED_ART;

// ---- plot exclusion (plan §3.2 step 1, §3.6: "never in plots") --------------------------------------------
// The plot SDF is GROUND's: `classes` include plotSdf on the GPU, classify.js plotSdf(state, x, y) as its JS
// reference (rounded box, half = claim/2 + ring + 2, corner radius 3, centred at deed-local 49). LIFE only
// adds the clearance below.
/** Scatter keeps this far (tiles) outside every plot's rounded box (§3.6: cull by plotSdf < 2). */
export const PLOT_CLEAR = 2;
/** Species per LIFE table row (life.js TABLE_W = MAX_SPECIES · SPT texels; glsl pickSpecies searches it). A row keeps
 * its first MAX_SPECIES species and lists the rest in `missing` — never a silent out-of-table read on the GPU. Stage B: 64
 * (was 32; Solana Reach ships 53 map objects), and the GLSL pick became a lower-bound search of ≤ 7 fetches. */
export const MAX_SPECIES = 64;

// ---- the kit creature path pose, verbatim semantics (realm-kit packages/shared/src/realmKit.ts at
// fc5c6ad19ea6: realmKitIsqrt, realmKitSegmentFacing, realmKitFacingRow, realmKitPathPose). Integer-safe:
// + − × ÷ ⌊⌋ only, so the GLSL twin (uint maths) is exact. -------------------------------------------------
export const FACINGS = Object.freeze(['down', 'left', 'right', 'up']);
export function isqrt(n) {
  if (n < 2) return n;
  let x = n, y = Math.floor((x + 1) / 2);
  while (y < x) { x = y; y = Math.floor((x + Math.floor(n / x)) / 2); }
  return x;
}
export const segmentFacing = (dx, dy) => Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'left' : 'right') : (dy < 0 ? 'up' : 'down');
export function facingRow(directions, facing, dx) {
  if (directions === 4) return FACINGS.indexOf(facing);
  if (directions === 2) return facing === 'left' || (facing !== 'right' && dx < 0) ? 0 : 1;
  return 0;
}
/**
 * One walker's pose at elapsedMs on a resolved path {points:[{x,y}], speed (art px/s), dwellMs, loop}:
 * the realm kit's realmKitPathPose, so a realm-map creature walks exactly like the same creature in its
 * base (plan §3.6, §10.4 "kit speed/dwell pose parity").
 */
export function pathPose(r, elapsedMs, still) {
  const pts = r.loop === 'pingpong' && r.points.length > 2 ? [...r.points, ...r.points.slice(1, -1).reverse()] : r.points;
  const vertices = r.loop === 'pingpong' ? [...pts, pts[0]] : pts;
  const segments = vertices.length - 1;
  const seg = i => { const p = vertices[i], q = vertices[i + 1]; return { p, dx: q.x - p.x, dy: q.y - p.y }; };
  const travel = i => { const { dx, dy } = seg(i); return Math.floor(isqrt(dx * dx + dy * dy) * 1000 / r.speed); };
  const first = seg(0);
  const home = { x: first.p.x, y: first.p.y, facing: segmentFacing(first.dx, first.dy), dx: first.dx, dy: first.dy, dwelling: true };
  if (still) return home;
  const dwell = r.dwellMs || 0;
  let period = 0;
  for (let i = 0; i < segments; i++) period += dwell + travel(i);
  let t = period > 0 ? elapsedMs % period : 0;
  for (let i = 0; i < segments; i++) {
    const { p, dx, dy } = seg(i), facing = segmentFacing(dx, dy);
    if (t < dwell) return { x: p.x, y: p.y, facing, dx, dy, dwelling: true };
    t -= dwell;
    const T = travel(i);
    if (t < T) return { x: p.x + Math.floor(dx * t / T), y: p.y + Math.floor(dy * t / T), facing, dx, dy, dwelling: false };
    t -= T;
  }
  return home;
}
/** The sheet frame the kit draws for a pose: row(facing) × frames + walk frame (0 while dwelling). */
export function poseFrame(pose, elapsedMs, frames, frameMs, directions = 4, still = false) {
  const walk = still || pose.dwelling ? 0 : Math.floor(elapsedMs / frameMs) % frames;
  return facingRow(directions, pose.facing, pose.dx) * frames + walk;
}

// ---- groups: compile a table row into the integer form the shaders read -----------------------------------
const CLASS_IDS = Object.keys(CLASS);
const NCLASS = CLASS_IDS.length;
/** Class names → bitmask over CLASS ids. */
export const classMask = names => (names || []).reduce((m, n) => m | (1 << CLASS[n]), 0);
/** A stable 16-bit salt from a string (FNV-1a folded), so every group owns its lattice hash stream. */
export function salt16(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return ((h >>> 16) ^ h) & 0xffff;
}
/**
 * Compile a scatter group: densities → u16 per class, species weights → cumulative u16, per-species class
 * masks and footprint radius. `sprites(id)` returns {inkH, w, h, ax, ay} for an available sprite (or null:
 * the species is dropped and reported in `missing`).
 */
export function compileGroup(realm, g, sprites, fields = null) {
  const kept = [], missing = [];
  for (const s of g.species) {
    const [id, w, opt = {}] = s;
    const sp = sprites(id);
    if (!sp) { missing.push(id); continue; }
    if (kept.length >= MAX_SPECIES) { missing.push(`${id} (over ${MAX_SPECIES} species in ${g.id})`); continue; }
    kept.push({ id, w, on: opt.on ? classMask(opt.on) : 0, coast: !!opt.coast, emit: opt.emit || null, glow: opt.glow || null, sp });
  }
  const total = kept.reduce((a, s) => a + s.w, 0);
  let acc = 0;
  const species = kept.map(s => {
    acc += s.w;
    const fr = Math.max(1, Math.ceil(Math.max(s.sp.w, s.sp.h * 0.6) / ART / 2)); // footprint radius (tiles)
    return { ...s, cum: total > 0 ? Math.min(65536, Math.round(acc / total * 65536)) : 0, footR: fr };
  });
  if (species.length) species[species.length - 1].cum = 65536;
  const density = new Array(NCLASS).fill(0);
  for (const [name, p] of Object.entries(g.density || {})) density[CLASS[name]] = Math.round(clamp(p, 0, 1) * 65535);
  const pitchArt = Math.round(g.pitch * ART);
  return {
    id: g.id, kind: g.kind, realm, salt: salt16(`${realm}:${g.id}`), pitch: g.pitch, pitchArt,
    jitterArt: Math.max(0, Math.min(pitchArt - 1, Math.floor(pitchArt * (g.jitter ?? 0.8)))),
    density, species, missing, twin: !!g.twin, sway: !!g.sway, mapOnly: !!g.mapOnly, trueOnly: !g.twin,
    mod: compileMod(g.mod, fields), cluster8: Math.round(clamp(g.cluster ?? 0, 0, 1) * 255),
    maxInkH: species.reduce((m, s) => Math.max(m, s.sp.inkH), 0),
    minInkH: species.reduce((m, s) => Math.min(m, s.sp.inkH), Infinity),
    maxExtent: species.reduce((m, s) => Math.max(m, s.sp.w, s.sp.h), 0),
  };
}

// ---- world-anchored lattices -------------------------------------------------------------------------------
/**
 * Lattice cells whose seat may put a sprite inside the art-px rect {x0,y0,x1,y1}. Conservative by the
 * group's largest sprite extent on every side (kept as `margin`: only seats within it of the rect can touch a
 * pixel). The shader walks instance id → (ix0 + id % nx, iy0 + id / nx).
 */
export function latticeWindow(pitchArt, rect, marginArt, stride = 1) {
  let ix0 = Math.floor((rect.x0 - marginArt) / pitchArt), ix1 = Math.floor((rect.x1 + marginArt) / pitchArt);
  let iy0 = Math.floor((rect.y0 - marginArt) / pitchArt), iy1 = Math.floor((rect.y1 + marginArt) / pitchArt);
  if (stride > 1) { // every stride-th cell, aligned to the world (a nested subset: zooming in only ever adds cells)
    ix0 = Math.floor(ix0 / stride) * stride; iy0 = Math.floor(iy0 / stride) * stride;
    return { ix0, iy0, nx: Math.max(0, Math.floor((ix1 - ix0) / stride) + 1), ny: Math.max(0, Math.floor((iy1 - iy0) / stride) + 1), stride, margin: marginArt };
  }
  return { ix0, iy0, nx: Math.max(0, ix1 - ix0 + 1), ny: Math.max(0, iy1 - iy0 + 1), stride: 1, margin: marginArt };
}
/** Map-object kept fraction for a view whose map-object lattice spans at most `blocks` rank blocks (W1; was a 1/2/4
 * stride): the largest whose rank window walks at most LIFE_CAPS.mapobj cells (blocks × (16 · keep + 1) slots). A function
 * of the view size only, continuous in d, and nested: zooming in only adds map objects. */
export const mapKeep = blocks => clamp((LIFE_CAPS.mapobj / Math.max(1, blocks) - 1) / RANK_SLOTS, 0, 1);
/** The art-px rect of the visible deeds of a view {x, y (deed centre), d, W, H (CSS), dpr}. */
export function viewRectArt(view) {
  const hw = view.W * view.dpr / view.d / 2, hh = view.H * view.dpr / view.d / 2;
  return { x0: (view.x - hw) * DEED_ART, y0: (view.y - hh) * DEED_ART, x1: (view.x + hw) * DEED_ART, y1: (view.y + hh) * DEED_ART };
}
/** Hashes of lattice cell (ix, iy) in a group's stream (GLSL: pcg2d(uvec2(ivec2(ix ^ salt, iy ^ salt*7)))). */
export function cellHash(salt, ix, iy) {
  const [h0, h1] = pcg2d((ix ^ salt) >>> 0, (iy ^ (salt * 7)) >>> 0);
  return { h0, h1, h2: kitHash(ix ^ salt, iy) };
}
/**
 * A 16-bit hash field reduced to [0, n) by multiply-shift, never by a modulo: GPU compilers mis-optimise
 * constant-divisor modulo after a shift (headless SwiftShader returns (u >> 16) % 97 = 9546 for 0xABCD1234,
 * see docs/realm-map/lane-life.md), so every hash→range reduction in LIFE's shaders and here uses this.
 */
export const range16 = (h16, n) => ((h16 & 0xffff) * n) >>> 16;
/** Seat (art px, bottom-centre anchor) of lattice cell (ix, iy): integer, so every instance is pixel-exact. */
export function cellSeat(g, ix, iy, h0) {
  const off = (g.pitchArt - g.jitterArt) >> 1, J = g.jitterArt + 1;
  return { x: ix * g.pitchArt + off + range16(h0, J), y: iy * g.pitchArt + off + range16(h0 >>> 16, J) };
}

// ---- rank windows (W1 follow-up, D-171 orchestrator call on RM-20's fade thinning) ----------------------------------
// Every scatter cell and stand site has a stable 16-bit RANK (0…65535). The MAP→TRUE dissolve and the §9 thinning both
// keep the cells whose rank is under a threshold, so the kept set is nested (zooming in only adds) and varies smoothly
// with a threshold that varies smoothly with d. Ranks are laid out so that a draw can SUBMIT only the kept cells: the
// lattice is cut into world-aligned RANK_B × RANK_B blocks, each block orders its cells by a scrambled ordered-dither
// (Bayer) index j, and rank = j · 4096 + (a per-block hash u16 >> 4). A rank range [lo, hi) is then slots j0 … j0+m−1
// of every block (the edge slots partially kept by the block hash), so the draw submits blocks × m instances instead of
// the whole window. Pure integer maths; glsl/sprites.glsl.js rankCell / slotCell are the GPU twins.
/** Rank blocks are 4×4 lattice cells (RANK_B = 1 << RANK_N): 16 slots, a rank step of 4096. */
export const RANK_N = 2, RANK_B = 1 << RANK_N, RANK_SLOTS = RANK_B * RANK_B, RANK_STEP = 65536 / RANK_SLOTS;
const floorDiv = (a, b) => Math.floor(a / b);
/** A block's hash: a 2-bit x / y scramble (XOR) and u16 (the partial-slot offset). GLSL rankHash. */
export function rankHash(salt, bx, by) {
  const h = pcg2d((bx ^ salt ^ 0x5a17) >>> 0, (by ^ (salt * 7) ^ 0x3c6e) >>> 0)[0];
  return { sx: h & (RANK_B - 1), sy: (h >>> 4) & (RANK_B - 1), u16: h >>> 16 };
}
/** Slot j (0…15) → block-local cell: 2-bit digits coarse first, each the 2×2 Bayer order (0,0) (1,1) (1,0) (0,1), so
 * slots 0–3 are a stride-2 coset, 0–7 a checkerboard, and every prefix is spread over the block. GLSL slotXY. */
export function slotXY(j) {
  const a = j & 3, b = (j >> 2) & 3;
  return [(((a ^ (a >> 1)) & 1) << 1) | ((b ^ (b >> 1)) & 1), ((a & 1) << 1) | (b & 1)];
}
/** Block-local cell → its slot (the inverse of slotXY). GLSL xySlot. */
export function xySlot(x, y) {
  const q = (dx, dy) => ((dx ^ dy) << 1) | dy;
  return q((x >> 1) & 1, (y >> 1) & 1) | (q(x & 1, y & 1) << 2);
}
/** The rank (0…65535) of lattice cell (ix, iy) in a stream with this salt. */
export function cellRank(salt, ix, iy) {
  const bx = floorDiv(ix, RANK_B), by = floorDiv(iy, RANK_B), h = rankHash(salt, bx, by);
  return xySlot((ix - bx * RANK_B) ^ h.sx, (iy - by * RANK_B) ^ h.sy) * RANK_STEP + (h.u16 >>> (2 * RANK_N));
}
/** Slot j of block (bx, by) → [ix, iy, rank]: the cell a rank-window instance draws (its rank equals cellRank). */
export function slotCell(salt, bx, by, j) {
  const h = rankHash(salt, bx, by), [x, y] = slotXY(j);
  return [bx * RANK_B + (x ^ h.sx), by * RANK_B + (y ^ h.sy), j * RANK_STEP + (h.u16 >>> (2 * RANK_N))];
}
/** A weight 0…1 as a rank bound (u16 fixed point, 0…65536): a cell is under it when its rank < the bound. */
export const rankBound = w => Math.min(65536, Math.max(0, Math.round(w * 65536)));
/** Slots [j0, j0 + m) of every block that can hold ranks in [lo, hi) (u16 bounds). */
export function rankSlots(lo, hi) {
  if (hi <= lo) return { j0: 0, m: 0 };
  const j0 = Math.floor(lo / RANK_STEP), j1 = Math.min(RANK_SLOTS, Math.ceil(hi / RANK_STEP));
  return { j0, m: j1 - j0 };
}
/** The world-aligned rank blocks covering a (stride-1) lattice window. */
export function rankBlocks(win) {
  const bx0 = floorDiv(win.ix0, RANK_B), by0 = floorDiv(win.iy0, RANK_B);
  return { bx0, by0, nbx: floorDiv(win.ix0 + win.nx - 1, RANK_B) - bx0 + 1, nby: floorDiv(win.iy0 + win.ny - 1, RANK_B) - by0 + 1 };
}
/**
 * One draw of a window's rank range [lo, hi): the cheaper of the plain window (every cell, the shader culls by rank) and
 * the rank window (blocks × m slots). → { lo, hi, rl: null | { bx0, by0, nbx, nby, j0, m }, count } (instances per draw).
 * Both draw exactly the cells whose rank is in range, so the choice changes cost only, never a pixel.
 */
export function rankDraw(win, lo, hi) {
  const cells = win.nx * win.ny;
  if (hi <= lo || !cells) return { lo, hi, rl: null, count: 0 };
  if (lo <= 0 && hi >= 65536) return { lo: 0, hi: 65536, rl: null, count: cells };
  const b = rankBlocks(win), s = rankSlots(lo, hi), n = b.nbx * b.nby * s.m;
  return n < cells ? { lo, hi, rl: { ...b, ...s }, count: n } : { lo, hi, rl: null, count: cells };
}
/** Weighted species pick from the top 16 bits of h1 (cumulative u16 table; first cum > pick). */
export function pickSpecies(species, pick16) {
  for (let i = 0; i < species.length; i++) if (pick16 < species[i].cum) return i;
  return -1;
}
/**
 * The scatter instance of lattice cell (ix, iy), or null. `env.classAt(tx, ty)` → CLASS id of a tile;
 * `env.plotSdf(tx, ty)` → tiles (classify.js plotSdf). Rules, in the shader's order:
 *   seat class density (h1 low 16) → species (h1 high 16) → species class mask → coast need →
 *   footprint corners share an allowed class → plot clearance (PLOT_CLEAR + footprint radius).
 */
export function scatterInstance(g, ix, iy, env) {
  if (!g.species.length) return null;
  const { h0, h1, h2 } = cellHash(g.salt, ix, iy);
  const seat = cellSeat(g, ix, iy, h0);
  const tx = Math.floor(seat.x / ART), ty = Math.floor(seat.y / ART);
  const cls = env.classAt(tx, ty);
  let dens = g.density[cls], sdf = null;
  if (g.mod && dens) { // round 2: thicker inside stands and along clearing edges, thinner in the open (the kit's home view)
    sdf = env.plotSdf(seat.x / ART, seat.y / ART);
    dens = modDensity(dens, g.mod, fieldCover(g.mod, seat.x, seat.y), edgeWeight(sdf, PLOT_CLEAR));
  }
  if ((h1 & 0xffff) >= dens) return null;
  let pick = h1 >>> 16;
  if (g.cluster8 && (pcg2d(h0, h1)[0] & 255) < g.cluster8) pick = clusterPick(g.salt, seat.x, seat.y); // stands of one species
  let s = pickSpecies(g.species, pick);
  if (s < 0) return null;
  const grows = i => !g.species[i].on || (g.species[i].on >>> cls) & 1;
  if (g.mapOnly && !grows(s)) { // map objects: two more hashed picks, the first whose role grows here (dunes on sand, oases…)
    const e = pcg2d(h1, h0)[0];
    for (const p of [e >>> 16, e & 0xffff]) { const t = pickSpecies(g.species, p); if (t >= 0 && grows(t)) { s = t; break; } }
  }
  const sp = g.species[s];
  if (sp.on && !((sp.on >>> cls) & 1)) return null;
  const r = sp.footR;
  if (r > 1) { // set pieces: all four footprint corners must stand on a class this species (else group) may use
    for (const [cx, cy] of [[-r, -r], [r, -r], [-r, 0], [r, 0]]) {
      const c = env.classAt(tx + cx, ty + cy); // on the species' own classes when it names them, else the group's
      if (sp.on ? !((sp.on >>> c) & 1) : g.density[c] === 0) return null;
    }
  }
  if (sp.coast && !nearWater(env, tx, ty, r + 3)) return null;
  if ((sdf ?? env.plotSdf(seat.x / ART, seat.y / ART)) < PLOT_CLEAR + r) return null;
  return { ix, iy, x: seat.x, y: seat.y, cls, species: s, id: sp.id, flip: (h2 >>> 16) & 1, phase: (h2 >>> 17) & 0x7fff, h2, rank: cellRank(g.salt, ix, iy) };
}
const WATERY = classMask(['DEEP', 'SEA', 'WATER']);
/** Coast need (boathouses, quays): open water within `r` tiles along one of the 4 axes. */
export function nearWater(env, tx, ty, r) {
  for (const [dx, dy] of [[r, 0], [-r, 0], [0, r], [0, -r]]) if ((WATERY >>> env.classAt(tx + dx, ty + dy)) & 1) return true;
  return false;
}
/**
 * LOD of a scatter instance at device px per deed d, with the camera's band weights (uBand.z = MAP→TRUE,
 * uBand.w = twins switch-in, both 0..1). 'true' draws the kit sprite, 'twin' the map-scale twin at the
 * SAME seat and size, 'none' nothing. Per-instance switches, never alpha (§2.1, §2.3). The twin switch-in and the
 * MAP→TRUE switch are the cell's rank (W1: the rank the §9 thinning keeps, so a draw submits only what can show); `keep`
 * is planDraws' thinning of the group (1 = none): a kept cell has rank < keep, it is TRUE when its rank < wTrue · keep, and
 * a twin when not TRUE and its rank < wTwin · keep (wTwin ≥ wTrue at every d). Map objects dissolve out by their hash.
 */
export function instanceLod(g, inst, d, wTrue, wTwin, keep = 1) {
  const sp = g.species[inst.species].sp;
  if (!bigEnough(sp.inkH, d)) return 'none';
  if (inst.rank >= rankBound(keep)) return 'none';
  if (g.mapOnly) return dissolve(inst.h2, wTrue) ? 'none' : 'twin';         // map objects show across the whole MAP band
  if (inst.rank < rankBound(wTrue * keep)) return 'true';
  if (g.twin && inst.rank < rankBound(wTwin * keep)) return 'twin';  // the MAP twin switch-in (d 250–350): the same rank
  return 'none';
}
/** Sway offset (art px, integer) of a tree's top edge at ms (A7; 0 below BANDS.sway or with reduced motion).
 * The phase is taken modulo the period first, exactly as the vertex shader does (float-safe for any clock). */
export function swayArt(inst, ms, d, rm) {
  if (rm || d < BANDS.sway) return 0;
  const period = SWAY.periodMinMs + range16(inst.h2 >>> 16, SWAY.periodMaxMs - SWAY.periodMinMs + 1);
  return Math.floor(Math.sin((ms % period) / period * 2 * Math.PI + inst.phase) * SWAY.ampArt + 0.5);
}
/** Clip frame of an animated prop (A8/A13): hashed phase so neighbouring mills do not turn in lockstep. */
export function clipFrame(inst, ms, frames, frameMs, rm) {
  if (frames <= 1 || rm) return 0;
  return Math.floor(((ms + inst.phase * 37) >>> 0) / Math.max(1, frameMs)) % frames;
}

// ---- creatures: herd sites on a world lattice; members walk kit paths (A9 TRUE, A18 herds at MAP) ---------
/** Members per herd site (instance id = site·HERD_MAX + member). */
export const HERD_MAX = 4;
/** A member's loop stays within this many tiles of its home (A9: 4-waypoint loops ≤ 6 t across). */
export const LOOP_RADIUS_TILES = 3;
/** Waypoints snap to half tiles, as the kit's own paths do. */
export const WAYPOINT_SNAP = 16;
/**
 * Compile a realm's creature table: species with their kit sheet data. `sheet(id)` → {inkH, frames,
 * frameMs, speed, dwellMs, directions, kind} or null.
 */
export function compileCreatures(realm, t, sheet) {
  const kept = [], missing = [];
  for (const [id, w, herd, on] of t.species) {
    const sh = sheet(id);
    if (!sh) { missing.push(id); continue; }
    kept.push({ id, w, herdMin: herd[0], herdMax: Math.min(HERD_MAX, herd[1]), on: classMask(on), sh });
  }
  const total = kept.reduce((a, s) => a + s.w, 0);
  let acc = 0;
  const species = kept.map(s => { acc += s.w; return { ...s, cum: Math.min(65536, Math.round(acc / total * 65536)) }; });
  if (species.length) species[species.length - 1].cum = 65536;
  const density = new Array(NCLASS).fill(0);
  for (const [name, p] of Object.entries(t.density || {})) density[CLASS[name]] = Math.round(clamp(p, 0, 1) * 65535);
  const pitchArt = Math.round(t.pitch * ART);
  return { realm, salt: salt16(`${realm}:creatures`), pitch: t.pitch, pitchArt, jitterArt: Math.floor(pitchArt * 0.7), density, species, missing,
    maxInkH: species.reduce((m, s) => Math.max(m, s.sh.inkH), 0) };
}
const WATER_WALK = classMask(['WATER', 'SEA', 'SHORE']);
const LAND_BLOCK = classMask(['DEEP', 'SEA', 'WATER', 'ROAD', 'TURF', 'RING']);
/** Walkable test for a creature kind at a tile (ground: dry wild land; water: water, sea and shore). */
export function walkableFor(kind, cls) {
  return kind === 'water' ? ((WATER_WALK >>> cls) & 1) === 1 : ((LAND_BLOCK >>> cls) & 1) === 0;
}
/**
 * Herd site (ix, iy): the species and member count, or null. The site must be walkable for the species and
 * its whole loop disk must clear every plot (plotSdf ≥ PLOT_CLEAR + LOOP_RADIUS + 2).
 */
export function herdSite(c, ix, iy, env) {
  if (!c.species.length) return null;
  const { h0, h1, h2 } = cellHash(c.salt, ix, iy);
  const seat = cellSeat(c, ix, iy, h0);
  const tx = Math.floor(seat.x / ART), ty = Math.floor(seat.y / ART);
  const cls = env.classAt(tx, ty);
  if ((h1 & 0xffff) >= c.density[cls]) return null;
  const s = pickSpecies(c.species, h1 >>> 16);
  if (s < 0) return null;
  const sp = c.species[s];
  if (!((sp.on >>> cls) & 1) || !walkableFor(sp.sh.kind, cls)) return null;
  if (env.plotSdf(seat.x / ART, seat.y / ART) < PLOT_CLEAR + LOOP_RADIUS_TILES + 2) return null;
  const n = sp.herdMin + range16(h2 >>> 16, sp.herdMax - sp.herdMin + 1);
  return { ix, iy, x: seat.x, y: seat.y, cls, species: s, id: sp.id, n, h2 };
}
const snap = v => Math.round(v / WAYPOINT_SNAP) * WAYPOINT_SNAP;
/** Every half tile along the straight walk a→b (art px) is walkable for the kind (so no animal crosses water). */
export function segmentWalkable(kind, env, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y, n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / WAYPOINT_SNAP));
  for (let k = 1; k < n; k++) {
    const x = a.x + Math.floor(dx * k / n), y = a.y + Math.floor(dy * k / n);
    if (!walkableFor(kind, env.classAt(Math.floor(x / ART), Math.floor(y / ART)))) return false;
  }
  return true;
}
/**
 * Member m of a herd site: its home and closed 4-waypoint loop (art px). A waypoint is kept only if it and the
 * straight walks to it and back home are walkable; otherwise it collapses onto the previous point. Plus the kit speed/dwell and a hashed clock phase. The same
 * record drives the MAP herd twin and the TRUE kit creature, so both stand on identical positions.
 */
export function herdMember(c, site, m, env) {
  if (m >= site.n) return null;
  const sp = c.species[site.species], R = LOOP_RADIUS_TILES * ART;
  const [a, b] = pcg2d((site.h2 ^ (m * 0x9e37)) >>> 0, (site.ix * 31 + site.iy * 17 + m) >>> 0);
  const off = v => range16(v, 97) - 48; // home within ±1.5 t of the site
  const home = { x: snap(site.x + (m ? off(a & 0xffff) : 0)), y: snap(site.y + (m ? off(a >>> 16) : 0)) };
  if (!walkableFor(sp.sh.kind, env.classAt(Math.floor(home.x / ART), Math.floor(home.y / ART)))) return null;
  const pts = [home];
  const [c1, c2] = pcg2d(a, b), [c3] = pcg2d(b, a);
  let prev = home;
  for (const h of [c1, c2, c3]) { // a waypoint stays only if it and both straight walks (from the previous point, back home) are walkable
    const p = { x: snap(home.x + range16(h, 2 * R + 1) - R), y: snap(home.y + range16(h >>> 16, 2 * R + 1) - R) };
    const ok = walkableFor(sp.sh.kind, env.classAt(Math.floor(p.x / ART), Math.floor(p.y / ART)))
      && segmentWalkable(sp.sh.kind, env, prev, p) && segmentWalkable(sp.sh.kind, env, p, home);
    if (ok) prev = p;
    pts.push({ ...prev });
  }
  pts.push({ ...home });
  const path = { points: pts, speed: sp.sh.speed, dwellMs: sp.sh.dwellMs, loop: 'cycle' };
  return { site, m, id: sp.id, species: site.species, path, phase: (b >>> 8) & 0xffff };
}
/** The density-LOD test of a site (planDraws keep fraction; GLSL: (h2 & 0xffff) < keep·65536). */
export const siteKept = (site, keep) => (site.h2 & 0xffff) < keep * 65536;
/** Pose of a member at animation ms (reduced motion → home, frame 0). */
export function memberPose(member, ms, rm) {
  const t = (ms + member.phase) >>> 0;
  return pathPose(member.path, t, !!rm);
}

// ---- birds (A10): flocks circling world-anchored sites --------------------------------------------------
/** Birds per flock site (instance id = site·FLOCK_MAX + member; a power of two so the shader splits ids bitwise). */
export const FLOCK_MAX = 8;
export function compileBirds(realm, t, sprite) {
  const kept = [];
  for (const [id, w, flock, on, opt = {}] of t.species) {
    const sp = sprite(id);
    if (sp) kept.push({ id, w, fMin: flock[0], fMax: Math.min(FLOCK_MAX, flock[1]), on: classMask(on), speed: opt.speed ?? 36, alt: opt.alt ?? 72, sp });
  }
  const total = kept.reduce((a, s) => a + s.w, 0);
  let acc = 0;
  const species = kept.map(s => { acc += s.w; return { ...s, cum: Math.min(65536, Math.round(acc / total * 65536)) }; });
  if (species.length) species[species.length - 1].cum = 65536;
  return { realm, salt: salt16(`${realm}:birds`), pitch: t.pitch, pitchArt: Math.round(t.pitch * ART), jitterArt: Math.floor(t.pitch * ART * 0.6),
    p16: Math.round(clamp(t.p, 0, 1) * 65535), species };
}
/** Flock at site (ix, iy): species, size, centre (art px), radius (art px) — or null. */
export function flockSite(b, ix, iy, env) {
  if (!b.species.length) return null;
  const { h0, h1, h2 } = cellHash(b.salt, ix, iy);
  if ((h1 & 0xffff) >= b.p16) return null;
  const seat = cellSeat(b, ix, iy, h0);
  const s = pickSpecies(b.species, h1 >>> 16);
  if (s < 0) return null;
  const sp = b.species[s];
  if (sp.on && !((sp.on >>> env.classAt(Math.floor(seat.x / ART), Math.floor(seat.y / ART))) & 1)) return null;
  const n = sp.fMin + range16(h2 >>> 16, sp.fMax - sp.fMin + 1);
  const radius = (6 + range16((h0 ^ h2) >>> 16, 7)) * ART; // 6–12 tiles
  return { ix, iy, x: seat.x, y: seat.y, species: s, id: sp.id, n, radius, dir: (h2 >>> 20) & 1 ? 1 : -1, h2, rank: (h0 ^ h2) & 0xffff };
}
/** Bird m of a flock at ms: ground point (art px), altitude (art px), heading sign and wing frame. The
 * clock is taken modulo the flock's circle period (as the shader does), so the pose never loses precision. */
export function birdPose(b, f, m, ms) {
  const sp = b.species[f.species];
  const w = sp.speed / f.radius * f.dir;                       // rad/s along the circle
  const periodMs = Math.floor(2 * Math.PI * f.radius / sp.speed * 1000 + 0.5);
  const th = (f.h2 & 0xffff) / 65536 * 2 * Math.PI + w * (ms % periodMs) / 1000 - m * 0.22 * f.dir;
  const rr = f.radius * (1 - 0.06 * m);
  const x = f.x + Math.cos(th) * rr, y = f.y + Math.sin(th) * rr * 0.62;
  const vx = -Math.sin(th) * w;
  const frame = (Math.floor(ms / sp.sp.frameMs) + m) % sp.sp.frames;
  return { x, y, alt: sp.alt + 10 * m, flip: vx < 0 ? 1 : 0, frame };
}

// ---- ambience (A11): world-anchored particles ------------------------------------------------------------
/**
 * Particle emitters of a realm. Kinds: 'wander' (a sprite drifting along the wind across its cell: dust and
 * ash devils, mist banks), 'fall' (flakes and embers falling or rising through a cell), 'spray' (bursts on
 * the surf line: a SEA tile next to land). Emitters attached to features ('emit') live on the feature
 * species (compileGroup `emit`). Each cell holds one particle, alive for `lifeMs`, Bayer-faded at both ends.
 */
export function compileAmbience(realm, list, sprite) {
  return list.map(a => {
    const sp = sprite(a.id);
    if (!sp) return null;
    const density = new Array(NCLASS).fill(0);
    for (const [name, p] of Object.entries(a.density || {})) density[CLASS[name]] = Math.round(clamp(p, 0, 1) * 65535);
    return { ...a, realm, salt: salt16(`${realm}:amb:${a.id}:${a.kind}`), pitchArt: Math.round(a.pitch * ART), jitterArt: Math.floor(a.pitch * ART * 0.9), density, sp };
  }).filter(Boolean);
}
/** The ink measure an emitter's anti-speckle test uses: its sprite's ink, or less when a table row sets a
 * minimum zoom `minD` (fine specks such as embers must not twinkle as mid-zoom speckle). */
export const ambienceInk = a => (a.sp.inkH < MIN_SPRITE_PX
  // an fx speck smaller than the 6-px rule (the shared fx pack's 3–5-px sparkles, motes, pollen) shows only from the
  // pixel-snapped 1:1 zoom, at its authored size exactly as the in-game base draws it — never as MAP-band speckle
  ? Math.floor(MIN_SPRITE_PX * DEED_ART / Math.max(a.minD ?? 0, BANDS.snap))
  : a.minD ? Math.min(a.sp.inkH, Math.floor(MIN_SPRITE_PX * DEED_ART / a.minD)) : a.sp.inkH);
/** Particle of cell (ix, iy) at ms: position (art px), altitude, frame, fade (0..1), or null. */
export function particle(a, ix, iy, ms, env, wind) {
  const { h0, h1, h2 } = cellHash(a.salt, ix, iy);
  const seat = cellSeat(a, ix, iy, h0);
  const cls = env.classAt(Math.floor(seat.x / ART), Math.floor(seat.y / ART));
  if ((h1 & 0xffff) >= a.density[cls]) return null;
  if (a.kind === 'spray' && !nearLand(env, Math.floor(seat.x / ART), Math.floor(seat.y / ART))) return null;
  const life = a.lifeMs, t = ((ms + range16(h2, life)) >>> 0) % life, u = t / life;
  const drift = a.kind === 'spray' ? 0 : t / 1000;
  const x = seat.x + wind[0] * drift * (a.windK ?? 1), y = seat.y + wind[1] * drift * (a.windK ?? 1);
  const alt = a.kind === 'fall' ? (a.rise ? a.alt * u : a.alt * (1 - u)) : a.kind === 'spray' ? 0 : (a.alt ?? 0);
  const frame = (Math.floor(ms / a.sp.frameMs) + (h1 >>> 16)) % a.sp.frames;
  const fade = Math.min(1, u / 0.15, (1 - u) / 0.15);
  return { x, y, alt, frame, fade, flip: (h2 >>> 20) & 1 };
}
const LANDY = ~classMask(['DEEP', 'SEA', 'WATER']);
export function nearLand(env, tx, ty) {
  for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) if ((LANDY >>> env.classAt(tx + dx, ty + dy)) & 1) return true;
  return false;
}

// ---- round 2: the stand field, clearing edges and stands (the in-game home view's composition) ----------------
// The kit's layout.json does not scatter uniformly: woods are groves of one dominant species at 2–3-tile
// spacing in zones, rocks come as outcrops, and the home clearing is framed by dense edges with open gaps
// between (T1). LIFE reproduces that with (1) a low-frequency value-noise "stand field" per realm that scales
// the lattice groups' densities, (2) an edge band outside every plot's clearance where density rises, and
// (3) stands: whole clumps of trees or rocks on their own world lattice, drawn at MAP as ONE composed clump
// sprite (the members' own map twins, laid out exactly as at TRUE) and at TRUE as the members themselves, so
// MAP↔TRUE instance positions agree (T2). All integer maths; glsl/sprites.glsl.js is the GPU twin.
export const STAND = Object.freeze({
  pitch: 8,            // tiles between stand sites (256 art px: a power of two, so the shaders use shifts)
  jitter: 0.5,         // of the pitch: neighbouring stands may touch and merge into one wood
  members: 16,         // trees/rocks per stand at most (instance id = site·16 + member, split bitwise)
  edgeFlat: 8,         // tiles beyond the plot clearance at full edge weight: GROUND's organic clearing reaches ~half + 3…10 t,
  edgeTiles: 6,        // then the weight falls to 0 over these tiles — the woods framing the clearing, as in the home view
  // Fix iteration 1 (GA2 T2 "d 48–170 reads as flat colour fields"): low MAP draws MERGED clumps — one per 2×2 block
  // of stand cells (the block's first stand, drawn 2×) — so woods, groves and outcrops read as objects from d 60;
  // over [splitFrom, splitFull] each block hands over to its stands' own clumps (per stand, hashed; the leader's
  // merged clump goes exactly when its own clump comes). Every clump obeys the 6-px rule.
  mergeFrom: 60,       // d: merged clumps from here (the FAR→MAP fade below belongs to the chart)
  mergeCap: 10000,     // merged-block instances: over it the blocks thin to every 2nd (world-aligned), over 4× it none
  splitFrom: 150,      // d: merged → per-stand clumps over [splitFrom, splitFull]
  splitFull: 210,
  merge: 2,            // draw scale of a merged clump (its block is 2×2 stand cells)
});
/** Cubic fade of a u8 fraction (0..255 → 0..255): t²(3 − 2t) in integers. */
export const fadeU8 = t => (t * t * (768 - 2 * t)) >>> 16;
const vcell = (salt, cx, cy) => pcg2d((cx ^ salt) >>> 0, (cy ^ (salt * 7)) >>> 0)[0] & 255;
/** Integer value noise (0..255) at art px (x, y): cells of 2^shift art px, cubic-faded bilinear corners. */
export function valueU8(salt, x, y, shift) {
  const m = (1 << shift) - 1, cx = x >> shift, cy = y >> shift;
  const fx = fadeU8(((x & m) << 8) >> shift), fy = fadeU8(((y & m) << 8) >> shift);
  const a = vcell(salt, cx, cy) * (256 - fx) + vcell(salt, cx + 1, cy) * fx;
  const b = vcell(salt, cx, cy + 1) * (256 - fx) + vcell(salt, cx + 1, cy + 1) * fx;
  return (a * (256 - fy) + b * fy) >>> 16;
}
/** The stand field (0..255): 32-tile and 16-tile octaves, 3:1. World-anchored, one per realm and field kind. */
export const standField = (salt, x, y) => (valueU8(salt, x, y, 10) * 3 + valueU8(salt ^ 0x5bd1, x, y, 9)) >> 2;
/** Cover (0..256) of a field value against its [lo, hi] ramp; k = ⌊65536 / (hi − lo)⌋ (multiply-shift, no division). */
export const coverOf = (V, lo, k) => clamp(((V - lo) * k) >> 8, 0, 256);
export const fieldCover = (f, x, y) => coverOf(standField(f.salt, x, y), f.lo, f.k);
const EDGE_FLAT_Q = STAND.edgeFlat * 4, EDGE_Q = (STAND.edgeFlat + STAND.edgeTiles) * 4, EDGE_INV = Math.floor(65536 / (STAND.edgeTiles * 4));
/** Clearing-edge weight (quarter tiles): −1 inside the clearance, 255 for edgeFlat tiles beyond it, then falling
 * to 0 over edgeTiles. The band is measured from the plot box, so it must reach past GROUND's clearing. */
export function edgeWeight(sdf, clear) {
  const e = Math.floor(Math.min(sdf - clear, 64) * 4);
  return e < 0 ? -1 : e < EDGE_FLAT_Q ? 255 : e >= EDGE_Q ? 0 : ((EDGE_Q - e) * EDGE_INV) >> 8;
}
/** A group's density scaled by the stand field (out → in across the cover ramp) and lifted along clearing edges. */
export function modDensity(dens16, mod, cover256, edge256) {
  if (!mod || !dens16) return dens16;
  let m = mod.out + (((mod.inn - mod.out) * cover256) >> 8);
  const e = edge256 > 0 ? (mod.edge * edge256) >> 8 : 0;
  if (e > m) m = e;
  return Math.min(65535, (dens16 * m) >> 8);
}
/** Species of a group's 8-tile cluster cell (the kit's grove clusterTiles 8): woods read as stands of one kind. */
export const clusterPick = (salt, x, y) => pcg2d(((x >> 8) ^ (salt * 3)) >>> 0, ((y >> 8) ^ (salt * 5)) >>> 0)[0] >>> 16;
/** Realm fields {veg, rock} → {salt, lo, k} (table `fields: { veg: [lo, hi], rock: [lo, hi] }`). */
export function compileFields(realm, f = {}) {
  const one = (name, [lo, hi] = [128, 168]) => ({ id: name === 'rock' ? 1 : 0, salt: salt16(`${realm}:field:${name}`), lo, k: Math.floor(65536 / Math.max(1, hi - lo)) });
  return { veg: one('veg', f.veg), rock: one('rock', f.rock) };
}
function compileMod(m, fields) {
  if (!m || !fields) return null;
  const f = fields[m.field === 'rock' ? 'rock' : 'veg'];
  return { ...f, out: Math.round(m.out * 256), inn: Math.round(m.in * 256), edge: Math.round((m.edge ?? 0) * 256) };
}

/**
 * Compile a realm's stand table: mixes (woods, copses, outcrops) → species list, per-mix class densities
 * and their pre-laid variants. A variant is a fixed member layout (offsets from the stand centre, species,
 * flip) chosen per site by hash; the same layout is the MAP clump sprite and the TRUE members.
 * t = { mixes: [{ id, field, density {CLASS:p}, species [[id, w]], spacing (tiles), R [min, max] (tiles),
 *       cluster (0..1: share of the dominant species), variants (count), sway }] }
 */
export function compileStands(realm, t, fields, sprites) {
  if (!t?.mixes?.length) return null;
  const species = [], missing = [], index = new Map();
  const sIdx = id => { if (index.has(id)) return index.get(id); const sp = sprites(id); if (!sp || species.length >= MAX_SPECIES) { missing.push(sp ? `${id} (over ${MAX_SPECIES} stand species)` : id); index.set(id, -1); return -1; }
    species.push({ id, sp, footR: 1 }); index.set(id, species.length - 1); return species.length - 1; };
  const mixes = [], variants = [];
  t.mixes.forEach((mx, mi) => {
    const sp = mx.species.map(([id, w]) => ({ s: sIdx(id), w })).filter(e => e.s >= 0);
    if (!sp.length) return;
    const density = new Array(NCLASS).fill(0);
    for (const [name, p] of Object.entries(mx.density || {})) density[CLASS[name]] = Math.round(clamp(p, 0, 1) * 65535);
    const mix = { id: mx.id, index: mixes.length, field: fields[mx.field === 'rock' ? 'rock' : 'veg'], density, sway: !!mx.sway, mapOnly: !!mx.mapOnly };
    mixes.push(mix);
    const salt = salt16(`${realm}:stand:${mx.id}`);
    for (let v = 0; v < (mx.variants ?? 8); v++) variants.push(layStand(mix, mx, sp, species, salt, v));
  });
  if (!variants.length) return null;
  const minInkH = variants.reduce((m, v) => Math.min(m, v.inkH), Infinity);
  return { realm, salt: salt16(`${realm}:stands`), pitch: STAND.pitch, pitchArt: STAND.pitch * ART, jitterArt: Math.floor(STAND.pitch * ART * STAND.jitter),
    species, mixes, variants, missing, maxInkH: variants.reduce((m, v) => Math.max(m, v.inkH), 0), minInkH,
    // merged clumps stay until every variant's own clump passes the 6-px rule (a small outcrop never blinks out)
    mergeUntil: Math.max(STAND.splitFull, Math.ceil(MIN_SPRITE_PX * DEED_ART / Math.max(1, minInkH))),
    memberInkMin: species.reduce((m, s) => Math.min(m, s.sp.inkH), Infinity) };
}
/** One pre-laid stand: a jittered hex patch of `spacing` inside a ragged radius R, ≤ 16 members, the dominant
 * species with probability `cluster`, painter-ordered (back row first). Pure in (realm, mix, v). */
function layStand(mix, mx, sp, species, salt, v) {
  let k = 0;
  const H = () => pcg2d((salt * 131 + v * 0x9e37) >>> 0, (k++ * 0x85ebca6b + v) >>> 0)[0];
  const u = () => (H() & 0xffff) / 65536;
  const total = sp.reduce((a, e) => a + e.w, 0);
  const pick = r => { let x = r * total; for (const e of sp) { if (x < e.w) return e.s; x -= e.w; } return sp[sp.length - 1].s; };
  const [r0, r1] = mx.R ?? [2, 4];
  const R = Math.round((r0 + (r1 - r0) * u()) * 4) / 4, Ra = R * ART;               // quarter tiles
  const s = (mx.spacing ?? 2.2) * ART, rowH = s * 0.866, ox = u() * s, oy = u() * rowH;
  const dominant = pick(u()), cluster = mx.cluster ?? 0.7;
  const cand = [];
  const n = Math.ceil(Ra / rowH) + 1;
  for (let j = -n; j <= n; j++) for (let i = -n; i <= n; i++) {
    const x = (i + (j & 1 ? 0.5 : 0)) * s + ox - s / 2 + (u() - 0.5) * s * 0.45, y = j * rowH + oy - rowH / 2 + (u() - 0.5) * rowH * 0.45;
    const lim = Ra * (0.8 + 0.4 * u());                                                 // a ragged, not circular, rim
    const sIx = u() < cluster ? dominant : pick(u()), flip = u() < 0.5 ? 1 : 0;
    if (x * x + y * y <= lim * lim) cand.push({ dx: Math.round(x), dy: Math.round(y), s: sIx, flip, r2: x * x + y * y });
  }
  cand.sort((a, b) => a.r2 - b.r2);
  const members = cand.slice(0, STAND.members).sort((a, b) => a.dy - b.dy || a.dx - b.dx).map(({ r2, ...m }) => m);
  if (!members.length) members.push({ dx: 0, dy: 0, s: dominant, flip: 0 });
  let top = Infinity, bot = -Infinity;
  for (const m of members) { top = Math.min(top, m.dy - species[m.s].sp.inkH); bot = Math.max(bot, m.dy); }
  return { mix: mix.index, R4: Math.round(R * 4), members, inkH: bot - top, footDy: bot };
}
/**
 * Stand site (ix, iy) on the stand lattice, or null. Its variant (hence mix) comes from the hash; the mix's
 * class density × the field cover (lifted to the full density along clearing edges) decides whether a stand
 * grows; eight compass samples at the stand radius must stand on the mix's classes (no half-wood in a lake);
 * the whole stand clears every plot (plotSdf ≥ PLOT_CLEAR + R).
 */
export function standSite(S, ix, iy, env) {
  const { h0, h1, h2 } = cellHash(S.salt, ix, iy);
  const seat = cellSeat(S, ix, iy, h0);
  const tx = seat.x >> 5, ty = seat.y >> 5;
  const cls = env.classAt(tx, ty);
  // variant: up to three hashed picks, the first whose mix grows on this class (rock sites get outcrops, sand palms)
  const [e0] = pcg2d(h0, h1), nV = S.variants.length;
  let v = range16(h1 >>> 16, nV);
  if (!S.mixes[S.variants[v].mix].density[cls]) v = range16(e0 & 0xffff, nV);
  if (!S.mixes[S.variants[v].mix].density[cls]) v = range16(e0 >>> 16, nV);
  const V = S.variants[v], mix = S.mixes[V.mix], p = mix.density[cls];
  if (!p) return null;
  const sdf = env.plotSdf(seat.x / ART, seat.y / ART), ew = edgeWeight(sdf, PLOT_CLEAR + V.R4 / 4);
  if (ew < 0) return null;
  let q = mix.mapOnly ? p : (p * coverOf(standField(mix.field.salt, seat.x, seat.y), mix.field.lo, mix.field.k)) >>> 8; // a map-only canopy fills its class
  const qe = (p * ew) >>> 8; if (qe > q) q = qe;
  if ((h1 & 0xffff) >= q) return null;
  const R = (V.R4 + 3) >> 2, D = (R * 181) >> 8;                                         // whole tiles; diagonal R/√2
  for (const [dx, dy] of [[R, 0], [-R, 0], [0, R], [0, -R], [D, D], [-D, D], [D, -D], [-D, -D]]) if (!mix.density[env.classAt(tx + dx, ty + dy)]) return null;
  return { ix, iy, x: seat.x, y: seat.y, cls, v, mix: V.mix, flip: (h2 >>> 16) & 1, h2, sdf, rank: cellRank(S.salt, ix, iy) };
}
/** Member m of a stand at TRUE (kit sprite), or null: the variant's offset (mirrored with the stand), on the
 * mix's classes and outside the plot clearance. The clump the MAP draws holds the same members. */
export function standMember(S, site, m, env) {
  const V = S.variants[site.v];
  if (m >= V.members.length || S.mixes[V.mix].mapOnly) return null; // a map-only canopy's TRUE trees are the grove group's
  const mm = V.members[m], x = site.x + (site.flip ? -mm.dx : mm.dx), y = site.y + mm.dy;
  if (!S.mixes[V.mix].density[env.classAt(x >> 5, y >> 5)]) return null;
  if (env.plotSdf(x / ART, y / ART) < PLOT_CLEAR + 1) return null;
  return { x, y, species: mm.s, id: S.species[mm.s].id, flip: site.flip ^ mm.flip };
}
/** Sway (A7) of stand member m: the scatter sway with a per-member phase (GLSL: ph = (h2 >> 17) ^ m·977). */
export function standSwayArt(site, m, ms, d, rm) {
  const ph = ((site.h2 >>> 17) ^ (m * 977)) >>> 0;
  return swayArt({ h2: ((ph & 0xffff) << 16) >>> 0, phase: ph & 0x7fff }, ms, d, rm);
}
/** Merged → per-stand hand-over weight at d (0..1, linear in d over [splitFrom, splitFull]). */
export const splitWeight = d => clamp((d - STAND.splitFrom) / (STAND.splitFull - STAND.splitFrom), 0, 1);
/** True when a stand's own clump shows at d (not yet TRUE): big enough and switched in by its hashed hand-over. */
const ownClump = (V, site, d) => V.inkH * d >= MIN_SPRITE_PX * DEED_ART && dissolve(site.h2 >>> 16, splitWeight(d));
/** LOD of a stand: 'true' (members, kit art), 'clump' (one composed MAP sprite), 'none'. Per-stand switches: a whole
 * stand turns from clump to trees at once, in place, when its rank passes wTrue · keep (W1: the rank the §9 thinning
 * keeps; keep = planDraws' stand thinning, 1 = none). A map-only canopy never resolves: at TRUE the grove group's own
 * trees are the forest. */
export function standLod(S, site, d, wTrue, keep = 1) {
  const V = S.variants[site.v];
  if (site.rank >= rankBound(keep)) return 'none';
  if (site.rank < rankBound(wTrue * keep)) return S.mixes[V.mix].mapOnly ? 'none' : 'true';
  return ownClump(V, site, d) ? 'clump' : 'none';
}
/**
 * The merged clump of 2×2 stand block (bx, by), or null: its first stand in the fixed order (0,0) (1,0) (0,1)
 * (1,1) whose doubled clump still clears every plot (plotSdf ≥ PLOT_CLEAR + 2R) and stands on the mix's classes
 * at 2R along both axes. The leader IS a stand of the lattice, so zooming in keeps it exactly where it was.
 */
export function mergedSite(S, bx, by, env) {
  for (let k = 0; k < 4; k++) {
    const site = standSite(S, 2 * bx + (k & 1), 2 * by + (k >> 1), env);
    if (!site) continue;
    const V = S.variants[site.v], mix = S.mixes[V.mix], R2 = ((V.R4 + 3) >> 2) * STAND.merge;
    if (site.sdf < PLOT_CLEAR + R2) continue;
    const tx = site.x >> 5, ty = site.y >> 5;
    if ([[R2, 0], [-R2, 0], [0, R2], [0, -R2]].some(([dx, dy]) => !mix.density[env.classAt(tx + dx, ty + dy)])) continue;
    return { ...site, bx, by };
  }
  return null;
}
/** Whether a block's merged clump draws at d: across low MAP, 2× art over 6 px, until its leader's own clump takes
 * over (then exactly never both, never neither). */
export function mergedLod(S, site, d) {
  const V = S.variants[site.v];
  if (d < STAND.mergeFrom || d >= S.mergeUntil || V.inkH * STAND.merge * d < MIN_SPRITE_PX * DEED_ART) return 'none';
  return ownClump(V, site, d) ? 'none' : 'merged';
}

// ---- density LOD: keep on-screen counts under their caps, world-anchored ---------------------------------------
/**
 * The keep fraction for a group whose expected on-screen count at this view is `expected`: sites whose
 * rank hash is under the fraction draw. It depends only on the view size and d, so a still camera never
 * reshuffles, and zooming in only ever adds instances (the kept set is nested).
 */
export const keepFraction = (cap, expected) => (expected <= cap ? 1 : cap / expected);

// ---- per-realm tables (plan §5.1 reuse row by row; kit ids exactly as each realm's kit.json names them) ------
// Scatter group rows: { id, kind, pitch (tiles), jitter (0..1 of pitch), density {CLASS: p}, twin, sway,
//   species: [[kitId, weight, {on:[CLASS…] only on these classes, coast:true needs open water, emit:{…}}]] }
// Groups with `twin` have map-scale twins at MAP (isolated trees, features, landmarks); the rest draw only
// from the MAP→TRUE fade on (dense forests are the M1 ground at MAP; small props are sub-6-px there).
const T = (id, kind, pitch, density, species, o = {}) => ({ id, kind, pitch, density, species, jitter: o.jitter ?? 0.85, twin: !!o.twin, sway: !!o.sway, mapOnly: !!o.mapOnly,
  ...(o.mod ? { mod: o.mod } : {}), ...(o.cluster ? { cluster: o.cluster } : {}) });
/** Round-2 density modulations (T1): understory thickens inside stands and along clearing edges. */
const UNDER = { field: 'veg', out: 0.7, in: 2.4, edge: 3 }, LONE = { field: 'veg', out: 1, in: 1.4, edge: 1.8 },
  STONES = { field: 'rock', out: 0.4, in: 2.6, edge: 1.6 }, DEBRIS = { field: 'veg', out: 0.5, in: 2.2, edge: 2 };
/** MAP-only map objects (plan §2.2 "Nature" at MAP; §5.3 map objects A/B): species come from the pack's
 * map.objects (lifeTable), placed on the classes their role belongs to, the whole footprint on them. */
const MAPOBJ = (density = { ROCK: 0.55, SNOW: 0.55, SPECIAL: 0.3, GROUND2: 0.08, WILD: 0.05, FIELD: 0.05, SHORE: 0.05 }) => T('mapobj', 'mapobj', 15, density, [], { twin: true, mapOnly: true, jitter: 0.6 });
/** Map-object role → the classes it may stand on (ids are map_<role>_<n>; PACK may pass role explicitly). */
export const MAPOBJ_ROLES = Object.freeze({
  peak: ['ROCK', 'SNOW'], massif: ['ROCK', 'SNOW'], range: ['ROCK', 'SNOW'], crag: ['ROCK'], mesa: ['ROCK'], arch: ['ROCK'],
  hoodoos: ['ROCK'], canyon_mouth: ['ROCK'], hill: ['ROCK', 'GROUND2'], dune_crest: ['SPECIAL'], oasis_pool: ['WILD', 'FIELD'],
  serac: ['SPECIAL', 'ROCK'], ice_floe: ['SPECIAL'], crater: ['ROCK', 'SPECIAL'], fumarole: ['SPECIAL', 'ROCK'],
  sea_stack: ['SHORE', 'ROCK'], stone_ring: ['WILD', 'SPECIAL'], lake_reeds: ['SHORE', 'WILD'], ruin_mound: ['WILD', 'GROUND2'],
  // round-2 ART roles (art-prep/realm/mapkit/<realm>/masters.json objects): canopy clumps and realm specials
  clump: ['WILD', 'GROUND2', 'SHORE'], scrub: ['WILD', 'GROUND2'], orchard: ['FIELD', 'WILD'], wildflowers: ['WILD', 'SPECIAL', 'FIELD'],
  heather: ['SPECIAL', 'WILD'], peat_bog: ['GROUND2', 'SPECIAL', 'WILD'], loch: ['WILD', 'GROUND2'], cairn: ['WILD', 'ROCK', 'SPECIAL'],
  frozen_pond: ['SPECIAL', 'WILD'], ice_cliff: ['ROCK', 'SPECIAL', 'SNOW'], hot_spring: ['WILD', 'GROUND2', 'ROCK'],
  lava_vent: ['SPECIAL', 'GROUND2', 'ROCK'], lava_pool: ['SPECIAL', 'GROUND2'], spire: ['ROCK', 'SPECIAL', 'GROUND2'], rubble: ['ROCK', 'GROUND2', 'WILD'],
  waterfall: ['ROCK'],
  // Stage B (Elderwood, Thornwake, Solana Reach: masters.json objects[].on, docs/realm-map/lane-life.md "Stage B")
  giant_tree: ['WILD', 'FOREST'], great_stump: ['WILD'], fern_brake: ['WILD', 'FOREST'], fallen_log: ['WILD', 'FOREST'], root_arch: ['WILD', 'ROCK'],
  lumen_grove: ['SPECIAL', 'WILD', 'FOREST'], glowcaps: ['SPECIAL', 'WILD', 'GROUND2'], monolith: ['WILD', 'ROCK', 'SPECIAL'], beacon: ['WILD', 'ROCK', 'SHORE'],
  shard_ridge: ['ROCK', 'WILD'], gate: ['WILD', 'ROAD'], geode: ['ROCK', 'WILD'], braziers: ['WILD'], lilies: ['WATER', 'SHORE'],
  // the gem-shard water: seated on the SEA band or a lake by the group density (DEEP has none), a 14-tile footprint may
  // reach deep water (the SEA band is ≤ 12 tiles wide); quays stand in the shallows (these realms have no SHORE class)
  quay: ['SHORE', 'SEA', 'DEEP'], boats: ['SEA', 'WATER', 'DEEP'], buoys: ['SEA', 'WATER', 'DEEP'], gem_shoal: ['SEA', 'WATER', 'SHORE', 'DEEP'],
  gem_shards: ['SEA', 'WATER', 'DEEP'], crystal_reef: ['SEA', 'WATER', 'DEEP'], islets: ['SEA', 'DEEP'], sea_arch: ['SEA', 'SHORE', 'DEEP'],
  lanterns: ['WATER', 'SEA', 'DEEP'], whirl: ['SEA', 'DEEP'],
});
/**
 * A map object's pulsing lens glow (Stage B, Solana Reach's beacons: ART cleared the provider's opaque halo, lane-art.md):
 * a table's `glow: { <map object id>: [x, y] }` anchor in its map canvas (map-art px). SPRITE_FS (LIFE_GLOW) brightens the
 * lens and breathes a Bayer-dithered halo of radiusMap map px around it; strength lo → 1 → lo over periodMs (a hashed phase
 * per instance), `rest` under reduced motion. Presentation numbers (plan §6.3: constants.ts at productisation).
 */
export const GLOW = Object.freeze({ radiusMap: 9, periodMs: 2400, lo: 0.3, rest: 0.6 }); // 9: the lens crystals are ~12 map px across, the halo reaches ~3 px past them
/** Glow strength of an instance at ms (GLSL SCATTER_VS twin): a smoothstepped triangle over the period, phase from h2. */
export function glowPulse(h2, ms, rm, periodMs = GLOW.periodMs) {
  if (rm) return GLOW.rest;
  const ph = (h2 >>> 17) & 0x7fff, t = ((ms + ph * 61) >>> 0) % periodMs, tri = 1 - Math.abs(2 * (t / periodMs) - 1);
  return GLOW.lo + (1 - GLOW.lo) * tri * tri * (3 - 2 * tri);
}
export function mapObjectRole(id, r) { // ART writes roles like "peak" or "mountain massif"; ids read map_<role>_<n>
  const words = String(r?.role ?? '').toLowerCase().trim(), cand = [words.replace(/\s+/g, '_'), ...words.split(/\s+/).reverse()];
  return cand.find(c => MAPOBJ_ROLES[c]) ?? Object.keys(MAPOBJ_ROLES).find(k => new RegExp(`^map_${k}(_|$)`).test(id)) ?? null;
}
const smoke = (dy = -40) => ({ fx: 'smoke_drift', dx: 0, dy, rise: 28, puffs: 3 });
const steam = (dy = -24) => ({ fx: 'steam_drift', dx: 0, dy, rise: 24, puffs: 3 });
const spray = (dy = -24) => ({ fx: 'spray_drift', dx: 0, dy, rise: 16, puffs: 3 });   // falls (Elderwood, Thornwake)
const vapour = (dy = -24) => ({ fx: 'vapour_drift', dx: 0, dy, rise: 20, puffs: 3 }); // Solana Reach's crystal spring
const beacon = dy => ({ fx: 'wisp_drift', dx: 0, dy, rise: 10, puffs: 3 });          // a wisp rising from a kit beacon's lens at TRUE
/**
 * A map object whose art carries falling water (Stage B fix pass, critic B1 #1): rare (a species weight of 0.08 against 1
 * for a plain object) and only by open water (`coast`: DEEP/SEA/WATER within footprint radius + 3 tiles on one axis, the
 * scatter coast rule both sides already run). At weight 1 on every rock object Thornwake's hills showed a fall on 28 % of
 * its map objects (11.6 per 16 deeds, dozens per screen) where its kit has one, Mossy Falls. A table lists them in
 * `mapobjs` (map-object id or role → weight, or { w, coast }), which lifeTable applies; unlisted objects weigh 1.
 */
const FALL = Object.freeze({ w: 0.08, coast: true });

export const LIFE_TABLES = Object.freeze({
  sunscar: {
    wind: [7, 1],
    // round 2 (T1/T2): the kit's oasis/dune stands and boulder outcrops (layout.json scatter groves), as stands
    fields: { veg: [104, 142], rock: [124, 166] },
    stands: { mixes: [
      { id: 'palms', field: 'veg', variants: 10, R: [2.5, 4.5], spacing: 1.93, cluster: 0.75, sway: true,
        density: { WILD: 0.81, SHORE: 0.95, GROUND2: 0.47, SPECIAL: 0.54, FIELD: 0.41 },
        species: [['canopy_date_palm', 6], ['canopy_date_palm_b', 5], ['canopy_fan_palm', 4], ['canopy_palm_young', 2], ['canopy_olive', 2], ['canopy_fig', 2], ['canopy_tamarisk', 2], ['canopy_acacia', 1]] },
      { id: 'acacias', field: 'veg', variants: 6, R: [1.5, 3.5], spacing: 2.21, cluster: 0.6, sway: true,
        density: { WILD: 0.74, SPECIAL: 0.68, GROUND2: 0.54, ROCK: 0.16 },
        species: [['canopy_acacia', 5], ['canopy_acacia_b', 3], ['canopy_olive', 3], ['canopy_fig', 2], ['canopy_tamarisk', 2], ['canopy_thornbush', 2], ['canopy_saguaro', 1], ['canopy_joshua', 1]] },
      { id: 'boulders', field: 'rock', variants: 8, R: [1.5, 3], spacing: 1.56, cluster: 0.35,
        density: { WILD: 0.47, GROUND2: 0.68, ROCK: 0.95, SNOW: 0.94, SPECIAL: 0.47 },
        species: [['boulder_sand', 3], ['boulder_sand_b', 3], ['rock_l_sand', 3], ['mesa_rock', 2], ['rock_s_sand', 2], ['dune_crest_rock', 1], ['cactus_cluster', 1], ['agave', 1], ['dry_bush', 1]] },
    ] },
    groups: [
      T('grove', 'tree', 1.75, { FOREST: 0.9 }, [['canopy_date_palm', 5], ['canopy_date_palm_b', 5], ['canopy_fan_palm', 3], ['canopy_palm_young', 3],
        ['canopy_olive', 2], ['canopy_fig', 2], ['canopy_tamarisk', 2], ['great_palm', 0.35], ['great_palm_b', 0.35]], { sway: true, cluster: 0.8 }),
      T('lone', 'tree', 5, { WILD: 0.2, GROUND2: 0.24, SHORE: 0.44, FIELD: 0.1, SPECIAL: 0.06, ROCK: 0.08 }, [['canopy_acacia', 5], ['canopy_acacia_b', 4],
        ['canopy_saguaro', 3], ['canopy_joshua', 2], ['canopy_acacia_dead', 2], ['canopy_dragon_tree', 1], ['canopy_tamarisk', 1],
        ['canopy_date_palm', 3, { on: ['SHORE', 'FIELD'] }]], { twin: true, sway: true, mod: LONE }),
      T('scrub', 'scrub', 3, { WILD: 0.105, GROUND2: 0.225, FOREST: 0.075, SPECIAL: 0.045, ROCK: 0.09, FIELD: 0.03, SHORE: 0.075 }, [['canopy_thornbush', 3],
        ['canopy_dead_scrub_low', 2], ['dry_bush', 3], ['agave', 2], ['cactus_cluster', 2], ['dead_scrub', 2], ['tumbleweed', 1], ['desert_flowers', 1]], { mod: UNDER }),
      T('rocks', 'rock', 4, { ROCK: 0.45, SNOW: 0.3, GROUND2: 0.05, WILD: 0.015, SPECIAL: 0.05 }, [['rock_l_sand', 3], ['boulder_sand', 2], ['boulder_sand_b', 2],
        ['mesa_rock', 2, { on: ['ROCK', 'SNOW'] }], ['rock_s_sand', 3], ['dune_crest_rock', 2, { on: ['SPECIAL', 'WILD'] }]], { mod: STONES }),
      T('litter', 'litter', 5, { WILD: 0.02, SHORE: 0.08, FOREST: 0.05, GROUND2: 0.02 }, [['bones_skull', 1], ['driftwood', 2, { on: ['SHORE'] }],
        ['stump_palm', 2], ['palm_frond_pile', 2, { on: ['FOREST', 'SHORE'] }]], { mod: DEBRIS }),
      T('crops', 'crop', 2.5, { FIELD: 0.38 }, [['millet_bed', 3], ['melon_patch', 3], ['water_jars', 0.4], ['irrigation_gate', 0.4]]),
      T('features', 'feature', 30, { WILD: 0.16, GROUND2: 0.2, FIELD: 0.22, ROCK: 0.18, SPECIAL: 0.14, SHORE: 0.25 }, [
        ['clay_granary', 2, { on: ['FIELD', 'GROUND2', 'WILD'] }], ['mud_boathouse', 2, { coast: true }], ['temple_ruin', 2, { on: ['WILD', 'GROUND2', 'SPECIAL'] }],
        ['caravanserai_gate', 1.5, { on: ['WILD', 'GROUND2'] }], ['sand_mesa', 2.5, { on: ['ROCK', 'SPECIAL'] }], ['obelisk', 1], ['sun_shrine', 1],
        ['broken_column_sand', 1], ['buried_statue', 1, { on: ['SPECIAL', 'WILD'] }], ['cairn_sand', 1], ['well_stone', 1, { on: ['FIELD', 'WILD'] }],
        ['shadoof', 1.5, { on: ['FIELD', 'SHORE'] }], ['kiln', 1, { emit: smoke(-44) }], ['tent_desert', 1, { on: ['WILD', 'GROUND2'] }],
        ['campfire_desert', 0.6, { emit: smoke(-20) }], ['market_stall', 0.5, { on: ['WILD', 'GROUND2'] }]], { twin: true, jitter: 0.5 }),
      T('landmarks', 'landmark', 196, { ROCK: 0.5, WILD: 0.3, SPECIAL: 0.4, GROUND2: 0.3 }, [['spring_cliff', 1]], { twin: true, jitter: 0.4 }),
      MAPOBJ(),
    ],
    creatures: { pitch: 14, density: { WILD: 0.18, GROUND2: 0.22, SPECIAL: 0.14, FIELD: 0.2, ROCK: 0.25, SNOW: 0.2, SHORE: 0.35, FOREST: 0.12, WATER: 0.06 },
      species: [['camel', 3, [2, 3], ['WILD', 'GROUND2', 'SPECIAL', 'FIELD']], ['desert_goat', 3, [2, 4], ['GROUND2', 'ROCK', 'WILD']],
        ['fennec', 1.5, [1, 1], ['WILD', 'SPECIAL', 'FOREST']], ['jerboa', 1.5, [1, 2], ['WILD', 'SPECIAL', 'GROUND2']],
        ['ibex', 2, [1, 3], ['ROCK', 'SNOW']], ['lizard', 1.5, [1, 1], ['ROCK', 'GROUND2', 'WILD']], ['tortoise', 1, [1, 1], ['WILD', 'FOREST', 'FIELD']],
        ['ibis', 2, [1, 3], ['SHORE', 'WATER']]] },
    birds: { pitch: 150, p: 0.45, species: [['vulture_flight', 1, [1, 3], ['ROCK', 'WILD', 'SPECIAL', 'GROUND2'], { speed: 40, alt: 84 }]] },
    ambience: [
      { id: 'dust_devil', kind: 'wander', pitch: 30, density: { WILD: 0.2, SPECIAL: 0.3, GROUND2: 0.25 }, lifeMs: 14000, windK: 1.8 },
      { id: 'heat_sparkle', shared: true, kind: 'wander', pitch: 7, minD: 1800, density: { WILD: 0.3, SPECIAL: 0.35, GROUND2: 0.3, ROCK: 0.3 }, lifeMs: 1600, windK: 0 },
    ],
  },
  frostveil: {
    wind: [-5, 2],
    fields: { veg: [100, 138], rock: [124, 166] },
    stands: { mixes: [
      { id: 'spruce', field: 'veg', variants: 10, R: [2.5, 4.5], spacing: 1.75, cluster: 0.8, sway: true,
        density: { WILD: 0.81, GROUND2: 0.54, SHORE: 0.47, FIELD: 0.27, SPECIAL: 0.14 },
        species: [['canopy_spruce', 6], ['canopy_spruce_b', 5], ['canopy_fir_snow', 5], ['canopy_blue_spruce', 3], ['canopy_pine_frost', 2], ['canopy_spruce_old', 1], ['canopy_holly_snow', 1]] },
      { id: 'birches', field: 'veg', variants: 6, R: [1.5, 3.5], spacing: 2.02, cluster: 0.5, sway: true,
        density: { WILD: 0.68, GROUND2: 0.61, SHORE: 0.61, FIELD: 0.34 },
        species: [['canopy_larch_bare', 3], ['canopy_birch_white', 3], ['canopy_spruce_young', 2], ['canopy_juniper', 2], ['canopy_pine_leaning', 2], ['canopy_sapling_snow', 2], ['bush_snow', 2], ['berry_bush_frost', 1]] },
      { id: 'boulders', field: 'rock', variants: 8, R: [1.5, 3], spacing: 1.56, cluster: 0.35,
        density: { ROCK: 0.95, SNOW: 0.74, SPECIAL: 0.68, GROUND2: 0.47, WILD: 0.3 },
        species: [['boulder_snow', 3], ['boulder_snow_b', 2], ['rock_l_frost', 3], ['rock_s_frost', 2], ['snow_mound', 2], ['ice_boulder', 1], ['icicle_rock', 1]] },
    ] },
    groups: [
      T('grove', 'tree', 1.75, { FOREST: 0.9 }, [['canopy_spruce', 5], ['canopy_spruce_b', 4], ['canopy_fir_snow', 4], ['canopy_pine_frost', 3],
        ['canopy_blue_spruce', 2], ['canopy_spruce_old', 2], ['canopy_spruce_young', 2], ['great_spruce', 0.35], ['great_spruce_b', 0.35]], { sway: true, cluster: 0.8 }),
      T('lone', 'tree', 5, { WILD: 0.18, GROUND2: 0.2, SHORE: 0.16, FIELD: 0.08, SPECIAL: 0.02, ROCK: 0.08 }, [['canopy_larch_bare', 3], ['canopy_birch_white', 3],
        ['canopy_pine_leaning', 2], ['canopy_juniper', 2], ['canopy_holly_snow', 1], ['canopy_spruce_young', 3], ['canopy_sapling_snow', 2]], { twin: true, sway: true, mod: LONE }),
      T('scrub', 'scrub', 3, { WILD: 0.09, GROUND2: 0.18, FOREST: 0.09, ROCK: 0.075, SHORE: 0.12, FIELD: 0.03 }, [['bush_snow', 3], ['berry_bush_frost', 2],
        ['juniper_low', 2], ['frosted_shrub', 2], ['holly_snow', 1], ['canopy_bramble_frost', 1], ['reeds_frozen', 2, { on: ['SHORE'] }], ['snow_mound', 2]], { mod: UNDER }),
      T('rocks', 'rock', 4, { ROCK: 0.45, SNOW: 0.25, SPECIAL: 0.12, GROUND2: 0.05, WILD: 0.015 }, [['boulder_snow', 3], ['boulder_snow_b', 2], ['rock_l_frost', 3],
        ['rock_s_frost', 3], ['ice_boulder', 2, { on: ['SPECIAL', 'ROCK', 'SHORE'] }], ['icicle_rock', 1], ['ice_shard_cluster', 2, { on: ['SPECIAL'] }]], { mod: STONES }),
      T('litter', 'litter', 5, { WILD: 0.02, FOREST: 0.06, GROUND2: 0.02 }, [['stump_snow', 2], ['log_snow', 2], ['canopy_log_snow', 1], ['dead_larch', 1]], { mod: DEBRIS }),
      T('crops', 'crop', 2.5, { FIELD: 0.38 }, [['cabbage_bed_snow', 3], ['turnip_clamp', 2], ['hay_bale_snow', 2], ['hay_feeder', 0.6]]),
      T('features', 'feature', 30, { WILD: 0.16, GROUND2: 0.2, FIELD: 0.22, ROCK: 0.12, SPECIAL: 0.1, SHORE: 0.25, FOREST: 0.05 }, [
        ['snow_barn', 2, { on: ['FIELD', 'WILD', 'GROUND2'], emit: smoke(-60) }], ['smokehouse', 1.5, { emit: smoke(-44) }], ['boathouse_ice', 2, { coast: true }],
        ['watchtower_frost', 1.5], ['watchtower_frost_b', 1.5], ['hot_spring', 1.5, { on: ['WILD', 'GROUND2', 'ROCK'], emit: steam(-30) }],
        ['rune_stone_b', 1], ['rune_stone_c', 1], ['shrine_ice', 1], ['cairn_snow', 1], ['ruin_wall_frost', 1], ['broken_column_ice', 1],
        ['tent_snow', 1, { on: ['WILD', 'GROUND2'] }], ['campfire_snow', 0.6, { emit: smoke(-20) }], ['well_frozen', 0.8, { on: ['FIELD', 'WILD'] }]], { twin: true, jitter: 0.5 }),
      T('landmarks', 'landmark', 196, { ROCK: 0.5, SPECIAL: 0.5, WILD: 0.2 }, [['glacier_cliff', 1]], { twin: true, jitter: 0.4 }),
      MAPOBJ(),
    ],
    creatures: { pitch: 14, density: { WILD: 0.18, GROUND2: 0.2, FIELD: 0.18, ROCK: 0.22, SNOW: 0.18, FOREST: 0.2, SHORE: 0.3, SPECIAL: 0.06, SEA: 0.03 },
      species: [['reindeer', 3, [2, 4], ['WILD', 'GROUND2', 'FIELD']], ['arctic_fox', 1.5, [1, 1], ['WILD', 'FOREST']], ['snow_hare', 1.5, [1, 2], ['WILD', 'FOREST', 'GROUND2']],
        ['wolf', 1.5, [2, 3], ['FOREST', 'WILD']], ['moose', 1.5, [1, 2], ['FOREST', 'SHORE', 'WILD']], ['ptarmigan', 1.5, [2, 3], ['WILD', 'GROUND2', 'ROCK']],
        ['mountain_goat', 2, [1, 3], ['ROCK', 'SNOW']], ['seal', 2, [1, 3], ['SHORE', 'SEA']]] },
    birds: { pitch: 150, p: 0.4, species: [['raven_flight', 1, [2, 4], null, { speed: 38, alt: 72 }]] },
    ambience: [
      { id: 'snowflake_drift', kind: 'fall', pitch: 6, density: { WILD: 0.45, GROUND2: 0.45, FOREST: 0.45, ROCK: 0.45, SNOW: 0.45, FIELD: 0.45, SPECIAL: 0.45, SHORE: 0.4, SEA: 0.3, WATER: 0.3, ROAD: 0.45 },
        lifeMs: 7000, alt: 96, windK: 1.2 },
      { id: 'ice_motes', shared: true, kind: 'fall', pitch: 8, minD: 1800, density: { SPECIAL: 0.5, SNOW: 0.35, ROCK: 0.2 }, lifeMs: 5000, alt: 48, windK: 0.6 },
    ],
  },
  cinderfall: {
    wind: [3, -2],
    fields: { veg: [104, 142], rock: [120, 162] },
    stands: { mixes: [
      { id: 'embers', field: 'veg', variants: 8, R: [2.5, 4.5], spacing: 2.02, cluster: 0.75, sway: true,
        density: { WILD: 0.74, GROUND2: 0.41, SHORE: 0.27, FIELD: 0.2, SPECIAL: 0.2 },
        species: [['canopy_ember_maple', 6], ['canopy_ember_maple_b', 4], ['canopy_red_rowan', 3], ['canopy_ash_birch', 2], ['canopy_dead_burnt_oak', 1], ['canopy_half_burnt_pine', 1]] },
      { id: 'pines', field: 'veg', variants: 8, R: [2.5, 4], spacing: 1.93, cluster: 0.75, sway: true,
        density: { WILD: 0.68, GROUND2: 0.54, ROCK: 0.2, SPECIAL: 0.2 },
        species: [['canopy_half_burnt_pine', 5], ['canopy_black_spruce', 5], ['canopy_ember_maple', 3], ['canopy_ash_snag', 2], ['canopy_twisted_juniper', 2], ['canopy_dead_burnt_oak', 1]] },
      { id: 'basalt', field: 'rock', variants: 8, R: [1.5, 3], spacing: 1.56, cluster: 0.35,
        density: { ROCK: 0.95, SNOW: 0.94, GROUND2: 0.61, SPECIAL: 0.54, WILD: 0.34 },
        species: [['rock_s_basalt_columns', 3], ['rock_s_basalt_column_shard', 2], ['boulder_basalt', 2], ['boulder_basalt_b', 2], ['rock_l_basalt', 2], ['rock_s_basalt', 2], ['canopy_lava_shrub', 1], ['canopy_red_fern', 1]] },
    ] },
    groups: [
      T('grove', 'tree', 1.75, { FOREST: 0.9 }, [['canopy_ember_maple', 5], ['canopy_ember_maple_b', 4], ['canopy_red_rowan', 3], ['canopy_black_spruce', 3],
        ['canopy_half_burnt_pine', 2], ['canopy_twisted_juniper', 2], ['canopy_ash_birch', 2], ['canopy_great_maple', 0.35], ['canopy_great_maple_b', 0.35]], { sway: true, cluster: 0.8 }),
      T('lone', 'tree', 5, { WILD: 0.18, GROUND2: 0.16, SHORE: 0.1, FIELD: 0.1, SPECIAL: 0.04, ROCK: 0.06 }, [['canopy_dead_burnt_oak', 3], ['canopy_ash_snag', 3],
        ['canopy_ash_snag_b', 2], ['canopy_red_sapling', 2], ['canopy_black_thorn', 2], ['canopy_twisted_juniper', 2]], { twin: true, sway: true, mod: LONE }),
      T('scrub', 'scrub', 3, { WILD: 0.09, GROUND2: 0.15, FOREST: 0.09, SPECIAL: 0.075, ROCK: 0.06, FIELD: 0.18 }, [['canopy_lava_shrub', 2], ['canopy_red_fern', 3],
        ['canopy_burnt_bramble', 2], ['dead_shrub', 2], ['mushroom_cluster_ember', 1], ['ash_drift', 1]], { mod: UNDER }),
      T('rocks', 'rock', 4, { ROCK: 0.45, SNOW: 0.3, SPECIAL: 0.1, GROUND2: 0.06, WILD: 0.015 }, [['rock_s_basalt', 3], ['rock_l_basalt', 3], ['boulder_basalt', 2],
        ['boulder_basalt_b', 2], ['rock_s_basalt_columns', 2], ['rock_s_basalt_column_shard', 1], ['slag_lump', 1, { on: ['SPECIAL', 'GROUND2'] }],
        ['obsidian_pile_low', 1], ['slag_glass_shard', 1, { on: ['SPECIAL', 'GROUND2'] }]], { mod: STONES }),
      T('litter', 'litter', 5, { WILD: 0.025, FOREST: 0.06, GROUND2: 0.03, SPECIAL: 0.03 }, [['stump_burnt', 2], ['charred_log', 2], ['canopy_charred_log', 1],
        ['stump_smoulder', 1], ['bones_scatter', 1], ['bones_skull', 0.5], ['ember_ground', 1.5, { on: ['SPECIAL', 'GROUND2'] }]], { mod: DEBRIS }),
      T('crops', 'crop', 2.5, { FIELD: 0.3 }, [['mushroom_cluster_ember', 2], ['charcoal_sack_open', 0.6], ['cordwood_row_ew', 0.6], ['ember_ground_bank', 1]]),
      T('features', 'feature', 30, { WILD: 0.16, GROUND2: 0.2, FIELD: 0.18, ROCK: 0.14, SPECIAL: 0.14, SHORE: 0.25 }, [
        ['kiln_house', 2, { emit: smoke(-64) }], ['kiln_clay', 1, { emit: smoke(-36) }], ['kiln_turf', 1, { emit: smoke(-36) }], ['smelter_gate', 1.5, { emit: smoke(-70) }],
        ['smelter_furnace', 1, { emit: smoke(-44) }], ['quay_shed', 2, { coast: true }], ['slag_ruin', 1.5], ['slag_glass_mass', 1, { on: ['SPECIAL', 'GROUND2'] }],
        ['ruin_arch_broken', 1], ['watchtower_burnt', 1], ['ember_shrine', 1], ['obsidian_slab', 1], ['ember_vent_small', 1.5, { on: ['SPECIAL', 'GROUND2', 'ROCK'], emit: steam(-20) }],
        ['basalt_spire', 1.5, { on: ['ROCK', 'SPECIAL', 'GROUND2'] }], ['basalt_spire_b', 1.5, { on: ['ROCK', 'SPECIAL', 'GROUND2'] }], ['cordwood_stack', 0.8]], { twin: true, jitter: 0.5 }),
      T('landmarks', 'landmark', 196, { ROCK: 0.4, SPECIAL: 0.5, GROUND2: 0.3, WILD: 0.2 }, [['fissure_vent', 1, { emit: steam(-40) }]], { twin: true, jitter: 0.4 }),
      MAPOBJ(),
    ],
    creatures: { pitch: 14, density: { WILD: 0.18, GROUND2: 0.2, FIELD: 0.18, ROCK: 0.22, SNOW: 0.15, FOREST: 0.2, SHORE: 0.2, SPECIAL: 0.15, WATER: 0.08 },
      species: [['obsidian_goat', 3, [2, 4], ['ROCK', 'GROUND2', 'SNOW']], ['ash_hare', 1.5, [1, 2], ['WILD', 'FOREST', 'FIELD']],
        ['cinder_beetle', 1.5, [1, 2], ['GROUND2', 'SPECIAL']], ['salamander', 2, [1, 2], ['WATER', 'SHORE']], ['soot_crow', 1.5, [1, 3], ['WILD', 'GROUND2', 'FIELD']],
        ['magma_slug', 1, [1, 1], ['SPECIAL', 'GROUND2']], ['vulture', 1.5, [1, 2], ['ROCK', 'WILD']], ['ember_moth', 1.5, [1, 2], ['FOREST', 'FIELD']]] },
    birds: { pitch: 150, p: 0.4, species: [['soot_crow_flight', 1, [2, 5], null, { speed: 34, alt: 70 }]] },
    ambience: [
      // embers and sparks are clouds of 1–2-art-px specks: only from d 1800 (art ≥ 0.57 device px), never as mid-zoom speckle
      { id: 'ember_drift', kind: 'fall', rise: true, pitch: 8, minD: 1800, density: { SPECIAL: 0.6, GROUND2: 0.35, SHORE: 0.5, WATER: 0.5, WILD: 0.2, FOREST: 0.25, ROCK: 0.25 },
        lifeMs: 6000, alt: 80, windK: 1.4 },
      { id: 'spark_rise', kind: 'fall', rise: true, pitch: 10, minD: 1800, density: { WATER: 0.6, SHORE: 0.5, SPECIAL: 0.35 }, lifeMs: 2400, alt: 56, windK: 0.6 },
      { id: 'ash_devil', kind: 'wander', pitch: 32, density: { WILD: 0.2, GROUND2: 0.25, SPECIAL: 0.2 }, lifeMs: 14000, windK: 1.8 },
    ],
  },
  stormcairn: {
    wind: [8, -1],
    fields: { veg: [104, 142], rock: [118, 160] },
    stands: { mixes: [
      { id: 'pinewood', field: 'veg', variants: 8, R: [2.5, 4.5], spacing: 1.75, cluster: 0.7, sway: true,
        density: { WILD: 0.68, SPECIAL: 0.61, GROUND2: 0.41 },
        species: [['canopy_scots_pine', 7], ['canopy_scots_pine_b', 4], ['canopy_birch_downy', 3], ['canopy_rowan_wind', 1], ['canopy_rowan_young', 1]] },
      { id: 'oakwood', field: 'veg', variants: 6, R: [1.5, 3.5], spacing: 1.84, cluster: 0.8, sway: true,
        density: { WILD: 0.61, SHORE: 0.47, GROUND2: 0.41, SPECIAL: 0.41 },
        species: [['canopy_stunted_oak', 5], ['canopy_scots_pine', 3], ['canopy_birch_downy', 3], ['canopy_alder', 2]] },
      { id: 'gorse', field: 'veg', variants: 6, R: [1.5, 3], spacing: 1.38, cluster: 0.4,
        density: { WILD: 0.61, SPECIAL: 0.74, SHORE: 0.61, GROUND2: 0.47, ROCK: 0.34 },
        species: [['canopy_gorse', 4], ['canopy_broom', 3], ['canopy_sea_buckthorn', 3], ['canopy_thorn_scrub', 2], ['canopy_heather_clump', 2], ['canopy_bracken', 2]] },
      { id: 'crags', field: 'rock', variants: 8, R: [1.5, 3], spacing: 1.56, cluster: 0.35,
        density: { ROCK: 0.95, SNOW: 0.88, WILD: 0.27, GROUND2: 0.34, SHORE: 0.27 },
        species: [['boulder_granite', 2], ['boulder_granite_b', 2], ['rock_l_granite', 3], ['rock_s_granite', 3], ['canopy_heather_clump', 1], ['canopy_juniper', 1]] },
    ] },
    groups: [
      T('grove', 'tree', 1.75, { FOREST: 0.9 }, [['canopy_scots_pine', 5], ['canopy_scots_pine_b', 4], ['canopy_alder', 2], ['canopy_birch_downy', 2],
        ['canopy_stunted_oak', 2], ['canopy_rowan_wind', 1], ['canopy_great_pine', 0.35], ['canopy_great_pine_b', 0.35]], { sway: true, cluster: 0.8 }),
      T('lone', 'tree', 5, { WILD: 0.16, GROUND2: 0.1, SHORE: 0.08, FIELD: 0.08, SPECIAL: 0.1, ROCK: 0.06 }, [['canopy_hawthorn_wind', 3], ['canopy_rowan_wind', 2],
        ['canopy_rowan_young', 2], ['canopy_stunted_oak', 2], ['canopy_birch_downy', 2], ['canopy_great_thorn', 0.3]], { twin: true, sway: true, mod: LONE }),
      T('scrub', 'scrub', 3, { WILD: 0.12, GROUND2: 0.15, FOREST: 0.075, SPECIAL: 0.21, ROCK: 0.075, SHORE: 0.12, FIELD: 0.03 }, [['canopy_juniper', 2], ['canopy_gorse', 3],
        ['canopy_broom', 2], ['canopy_sea_buckthorn', 2, { on: ['SHORE', 'WILD'] }], ['canopy_heather_clump', 3, { on: ['SPECIAL', 'WILD', 'GROUND2'] }],
        ['canopy_bracken', 2], ['canopy_thorn_scrub', 1], ['bog_cotton', 2, { on: ['GROUND2', 'SPECIAL'] }], ['thrift_rock', 1, { on: ['SHORE', 'ROCK'] }]], { mod: UNDER }),
      T('rocks', 'rock', 4, { ROCK: 0.45, SNOW: 0.3, GROUND2: 0.04, WILD: 0.02, SPECIAL: 0.03, SHORE: 0.04 }, [['rock_s_granite', 3], ['rock_l_granite', 3],
        ['boulder_granite', 2], ['boulder_granite_b', 2], ['crag_columns', 1.5, { on: ['ROCK', 'SNOW'] }], ['crag_columns_b', 1.5, { on: ['ROCK', 'SNOW'] }],
        ['standing_stone', 0.4, { on: ['WILD', 'SPECIAL'] }], ['standing_stone_lean', 0.3, { on: ['WILD', 'SPECIAL'] }]], { mod: STONES }),
      T('litter', 'litter', 5, { WILD: 0.02, FOREST: 0.05, GROUND2: 0.02, SHORE: 0.1 }, [['stump_pine', 2], ['canopy_log_pine', 1], ['driftwood', 2, { on: ['SHORE'] }],
        ['kelp_heap', 2, { on: ['SHORE'] }], ['shingle_bank', 1.5, { on: ['SHORE'] }]], { mod: DEBRIS }),
      T('crops', 'crop', 2.5, { FIELD: 0.38, GROUND2: 0.02 }, [['oat_rig', 3], ['oat_rig_b', 2], ['kale_bed', 2], ['lazybed', 2], ['hay_stook', 1], ['oat_stook', 1.5],
        ['peat_stack', 1, { on: ['GROUND2', 'FIELD'] }], ['peat_stack_b', 0.8, { on: ['GROUND2', 'FIELD'] }]]),
      T('features', 'feature', 30, { WILD: 0.16, GROUND2: 0.18, FIELD: 0.22, ROCK: 0.12, SPECIAL: 0.14, SHORE: 0.25 }, [
        ['broch_ruin', 2], ['harbour_house', 2, { coast: true, emit: smoke(-60) }], ['boat_shed', 2, { coast: true }], ['blackhouse_byre', 2, { on: ['FIELD', 'WILD', 'GROUND2'], emit: smoke(-52) }],
        ['cairn_circle', 1.5, { on: ['WILD', 'SPECIAL', 'GROUND2'] }], ['broch_wall', 1], ['chapel_gable', 1], ['road_cairn', 1],
        ['bothy_tent', 0.8, { on: ['WILD', 'SPECIAL'] }], ['peat_fire', 0.6, { emit: smoke(-20) }]], { twin: true, jitter: 0.5 }),
      T('landmarks', 'landmark', 196, { SHORE: 0.5, ROCK: 0.4, WILD: 0.2, SPECIAL: 0.3 }, [['sea_stack', 1, { coast: true }], ['cliff_burn', 1, { on: ['ROCK', 'WILD', 'SPECIAL'] }]], { twin: true, jitter: 0.4 }),
      MAPOBJ(),
    ],
    creatures: { pitch: 14, density: { WILD: 0.2, GROUND2: 0.2, FIELD: 0.22, ROCK: 0.18, SNOW: 0.1, FOREST: 0.18, SHORE: 0.3, SPECIAL: 0.18, SEA: 0.03 },
      species: [['highland_cow', 3, [2, 3], ['WILD', 'SPECIAL', 'FIELD', 'GROUND2']], ['blackface_sheep', 3, [3, 4], ['WILD', 'SPECIAL', 'ROCK', 'FIELD']],
        ['grey_seal', 2, [1, 3], ['SHORE']], ['otter', 1, [1, 1], ['SHORE']], ['gannet', 1.5, [1, 3], ['SHORE', 'SEA']], ['brown_hare', 1.5, [1, 2], ['WILD', 'FIELD', 'SPECIAL']],
        ['pine_marten', 1, [1, 1], ['FOREST']], ['raven', 1.5, [1, 2], ['ROCK', 'WILD', 'GROUND2']]] },
    birds: { pitch: 140, p: 0.5, species: [['gull_flight', 3, [2, 5], null, { speed: 44, alt: 80 }], ['gull_far_flight', 2, [3, 6], null, { speed: 36, alt: 120 }]] },
    ambience: [
      { id: 'mist_drift', kind: 'wander', pitch: 26, density: { WILD: 0.18, SPECIAL: 0.22, GROUND2: 0.22, SEA: 0.1, SHORE: 0.2, FOREST: 0.12 }, lifeMs: 20000, windK: 1.0 },
      { id: 'spray_burst', kind: 'spray', pitch: 7, density: { SEA: 0.5, DEEP: 0.2 }, lifeMs: 2600 },
      { id: 'sea_spray', shared: true, kind: 'spray', pitch: 9, density: { SEA: 0.35 }, lifeMs: 2000 },
    ],
  },
  crownlands: {
    wind: [5, 2],
    fields: { veg: [94, 132], rock: [124, 166] },
    stands: { mixes: [
      { id: 'woods', field: 'veg', variants: 10, R: [2.5, 4.5], spacing: 1.93, cluster: 0.75, sway: true,
        density: { WILD: 0.74, SHORE: 0.54, GROUND2: 0.41, SPECIAL: 0.47, FIELD: 0.16 },
        species: [['canopy_oak', 6], ['canopy_oak_b', 5], ['canopy_fir', 4], ['canopy_pine', 3], ['canopy_beech', 3], ['canopy_elm', 2], ['canopy_ash', 2], ['canopy_holly', 1], ['canopy_oak_old', 1]] },
      { id: 'copses', field: 'veg', variants: 6, R: [1.5, 3.5], spacing: 2.02, cluster: 0.5, sway: true,
        density: { WILD: 0.68, FIELD: 0.27, SPECIAL: 0.61, SHORE: 0.47, GROUND2: 0.41 },
        species: [['canopy_oak_young', 3], ['canopy_hawthorn', 3], ['canopy_rowan', 2], ['canopy_sapling', 2], ['birch', 2], ['canopy_oak_autumn', 1], ['bush', 2], ['berry_bush', 1]] },
      { id: 'stones', field: 'rock', variants: 8, R: [1.5, 3], spacing: 1.56, cluster: 0.35,
        density: { ROCK: 0.95, SNOW: 0.88, GROUND2: 0.41, WILD: 0.2 },
        species: [['boulder_mossy', 3], ['rock_l', 3], ['rock_s', 2], ['bush', 1]] },
    ] },
    groups: [
      T('grove', 'tree', 1.75, { FOREST: 0.9 }, [['canopy_oak', 5], ['canopy_oak_b', 4], ['canopy_beech', 4], ['canopy_elm', 2], ['canopy_ash', 2], ['canopy_oak_old', 2],
        ['canopy_fir', 1], ['canopy_pine', 1], ['canopy_oak_autumn', 1], ['hero_oak', 0.3], ['hero_oak_b', 0.3]], { sway: true, cluster: 0.8 }),
      T('lone', 'tree', 5, { WILD: 0.34, GROUND2: 0.16, SHORE: 0.24, FIELD: 0.1, SPECIAL: 0.1, ROCK: 0.06 }, [['canopy_oak_young', 3], ['canopy_hawthorn', 2],
        ['canopy_rowan', 2], ['canopy_holly', 1], ['canopy_sapling', 2], ['oak', 2], ['birch', 2], ['willow', 2, { on: ['SHORE'] }], ['willow_b', 2, { on: ['SHORE'] }],
        ['dead_tree', 0.5]], { twin: true, sway: true, mod: LONE }),
      T('scrub', 'scrub', 3, { WILD: 0.105, GROUND2: 0.15, FOREST: 0.09, SPECIAL: 0.21, ROCK: 0.075, SHORE: 0.12, FIELD: 0.03 }, [['bush', 3], ['berry_bush', 2],
        ['canopy_bramble', 1.5], ['flowers', 3, { on: ['SPECIAL', 'WILD'] }], ['dry_grass', 1.5], ['mushrooms', 1, { on: ['FOREST'] }], ['reeds', 2, { on: ['SHORE'] }]], { mod: UNDER }),
      T('rocks', 'rock', 4, { ROCK: 0.45, SNOW: 0.3, GROUND2: 0.04, WILD: 0.015, SHORE: 0.02 }, [['boulder_mossy', 3], ['rock_l', 3], ['rock_s', 3],
        ['standing_stone', 0.3, { on: ['WILD', 'SPECIAL'] }]], { mod: STONES }),
      T('litter', 'litter', 5, { WILD: 0.02, FOREST: 0.06, GROUND2: 0.02 }, [['stump', 2], ['log', 2], ['canopy_log', 1], ['log_pile', 0.5]], { mod: DEBRIS }),
      T('crops', 'crop', 2.5, { FIELD: 0.38 }, [['wheat_ripe', 3], ['wheat_young', 3], ['hay_bale', 1.5], ['scarecrow', 0.5], ['beehive', 0.5], ['cart_hay', 0.3]]),
      T('features', 'feature', 30, { WILD: 0.16, GROUND2: 0.2, FIELD: 0.24, ROCK: 0.12, SPECIAL: 0.14, SHORE: 0.25 }, [
        ['windmill', 2, { on: ['FIELD', 'WILD'] }], ['watermill', 1.5, { coast: true }], ['boathouse', 2, { coast: true }], ['watchtower_ruin', 1.5], ['watchtower_ruin_b', 1.5],
        ['ruin_wall', 1], ['shrine', 1], ['well', 1, { on: ['FIELD', 'WILD'] }], ['cairn', 1], ['watchtower_wood', 1], ['tent', 0.8, { on: ['WILD', 'GROUND2'] }],
        ['campfire', 0.6, { emit: smoke(-20) }]], { twin: true, jitter: 0.5 }),
      T('landmarks', 'landmark', 196, { ROCK: 0.5, WILD: 0.3, SPECIAL: 0.3 }, [['waterfall_cliff', 1]], { twin: true, jitter: 0.4 }),
      MAPOBJ(),
    ],
    creatures: { pitch: 14, density: { WILD: 0.22, GROUND2: 0.2, FIELD: 0.25, ROCK: 0.18, SNOW: 0.1, FOREST: 0.2, SHORE: 0.2, SPECIAL: 0.2, WATER: 0.1 },
      species: [['sheep', 3, [3, 4], ['WILD', 'FIELD', 'SPECIAL']], ['chicken', 1.5, [2, 4], ['FIELD']], ['pig', 1, [1, 2], ['FIELD']], ['goat', 1.5, [2, 3], ['GROUND2', 'ROCK']],
        ['deer', 2, [1, 3], ['FOREST', 'WILD']], ['rabbit', 1.5, [1, 2], ['WILD', 'SPECIAL', 'FIELD']], ['fox', 1, [1, 1], ['FOREST', 'WILD']], ['duck', 2, [2, 3], ['WATER', 'SHORE']]] },
    birds: { pitch: 140, p: 0.45, species: [['sparrow_flight', 3, [3, 6], ['WILD', 'FIELD', 'FOREST', 'SPECIAL', 'GROUND2'], { speed: 48, alt: 56 }],
      ['gull_flight', 2, [2, 4], ['SHORE', 'SEA', 'DEEP', 'WATER'], { speed: 42, alt: 80 }]] },
    ambience: [ // leaves, petals and pollen come from the shared fx pack (ART, plan §5.3); until it ships they are listed missing
      { id: 'leaf_drift_green', shared: true, kind: 'fall', pitch: 9, density: { FOREST: 0.5, WILD: 0.08, SHORE: 0.1 }, lifeMs: 6500, alt: 72, windK: 1.4 },
      { id: 'leaf_drift_gold', shared: true, kind: 'fall', pitch: 13, density: { FOREST: 0.35, FIELD: 0.08 }, lifeMs: 6500, alt: 72, windK: 1.4 },
      { id: 'petals', shared: true, kind: 'fall', pitch: 10, density: { SPECIAL: 0.5, FIELD: 0.12, WILD: 0.06 }, lifeMs: 5500, alt: 48, windK: 1.2 },
      { id: 'pollen', shared: true, kind: 'wander', pitch: 8, minD: 1800, density: { SPECIAL: 0.45, FIELD: 0.3, WILD: 0.15 }, lifeMs: 4000, windK: 0.8 },
    ],
  },
  // ---- Stage B: the three new realms (kit layout.json groves and roam at their release SHAs: Elderwood 99147f20,
  // Thornwake e02e40b8, Solana Reach a65cede0; densities read against the realm-kit screenshots per realm).
  // Their land is WILD, FOREST (64–69 %; Solana 43 %), ROCK and WATER (+ SPECIAL/SNOW on Solana): no FIELD, GROUND2 or
  // SHORE, so no crops row. docs/realm-map/lane-life.md "Stage B" has the reasoning per row.
  elderwood: {
    wind: [3, 0],
    // the most wooded realm: a lower veg ramp gives more stand cover (the kit's glade stands at density 100)
    fields: { veg: [92, 130], rock: [124, 166] },
    stands: { mixes: [ // kit groves: stands / rim_woods / frame_stands (spacing 1.6, clusterWeight 0.6), hazel_knoll, mossy outcrops
      { id: 'oakwood', field: 'veg', variants: 10, R: [2.5, 4.5], spacing: 1.6, cluster: 0.6, sway: true,
        density: { WILD: 0.81, ROCK: 0.2 },
        species: [['canopy_elder_oak', 5], ['canopy_elder_oak_b', 4], ['canopy_hollow_oak', 2], ['canopy_ancient_yew', 3], ['canopy_ancient_yew_b', 2], ['canopy_moss_beech', 2], ['canopy_moss_beech_b', 1], ['canopy_twisted_beech', 2]] },
      { id: 'hazel', field: 'veg', variants: 6, R: [1.5, 3], spacing: 1.6, cluster: 0.4, sway: true,
        density: { WILD: 0.6, ROCK: 0.1 },
        species: [['canopy_hazel_coppice', 3], ['canopy_hazel_coppice_small', 3], ['canopy_sapling', 1], ['canopy_holly', 1], ['canopy_gnarled_elder', 1], ['canopy_elder_bush', 1]] },
      { id: 'mossrocks', field: 'rock', variants: 8, R: [1.5, 3], spacing: 1.56, cluster: 0.35,
        density: { ROCK: 0.95, WILD: 0.34 },
        species: [['boulder_moss', 3], ['rock_l_moss', 3], ['rock_l_moss_block', 2], ['rock_l_moss_blocks', 2], ['rock_s_moss', 2], ['rock_s_moss_b', 2], ['canopy_fern_bush', 1], ['fern_tall', 1]] },
    ] },
    groups: [
      T('grove', 'tree', 1.75, { FOREST: 0.92 }, [['canopy_elder_oak', 5], ['canopy_elder_oak_b', 4], ['canopy_ancient_yew', 3], ['canopy_ancient_yew_b', 2],
        ['canopy_hollow_oak', 2], ['canopy_moss_beech', 2], ['canopy_moss_beech_b', 1], ['canopy_twisted_beech', 2], ['canopy_gnarled_elder', 1],
        ['canopy_great_oak', 0.35], ['canopy_great_oak_b', 0.35]], { sway: true, cluster: 0.7 }),
      T('lone', 'tree', 5, { WILD: 0.3, ROCK: 0.06 }, [['canopy_hazel_coppice', 2], ['canopy_hazel_coppice_small', 2], ['canopy_holly', 2], ['canopy_gnarled_elder', 2],
        ['canopy_sapling', 1], ['canopy_sapling_beech', 1], ['canopy_twisted_beech_b', 1], ['canopy_elder_oak', 1],
        ['canopy_old_willow', 3, { coast: true }], ['canopy_old_willow_b', 2, { coast: true }]], { twin: true, sway: true, mod: LONE }),
      T('scrub', 'scrub', 3, { WILD: 0.12, FOREST: 0.12, ROCK: 0.06 }, [['canopy_fern_bush', 4], ['canopy_fern_small', 2], ['canopy_bramble', 3], ['canopy_bramble_small', 1],
        ['canopy_elder_bush', 2], ['canopy_elder_bush_small', 2], ['fern_tall', 2], ['fern_low', 2], ['foxgloves', 1], ['foxgloves_b', 1], ['bluebell_clump_b', 2],
        ['toadstools', 1], ['toadstools_b', 1], ['reeds_stream', 2, { coast: true }]], { mod: UNDER }),
      T('rocks', 'rock', 4, { ROCK: 0.45, WILD: 0.02, FOREST: 0.01 }, [['rock_l_moss', 3], ['rock_s_moss', 3], ['rock_s_moss_b', 2], ['boulder_moss', 2],
        ['rock_l_moss_block', 1.5], ['rock_l_moss_blocks', 1.5], ['fallen_stone', 1], ['standing_stone_moss', 0.4, { on: ['WILD'] }], ['standing_stone_b', 0.3, { on: ['WILD'] }]], { mod: STONES }),
      T('litter', 'litter', 5, { WILD: 0.03, FOREST: 0.07 }, [['canopy_log_mossy', 3], ['fallen_oak', 1], ['fallen_oak_hollow', 1], ['stump_oak', 2], ['stump_oak_low', 1],
        ['canopy_mushroom_ring', 1], ['canopy_mushroom_ring_b', 1], ['mushroom_logs', 1], ['mushroom_logs_b', 0.5], ['root_knot', 1]], { mod: DEBRIS }),
      T('features', 'feature', 30, { WILD: 0.18, ROCK: 0.1, FOREST: 0.04 }, [
        ['woodcutters_hall', 2, { on: ['WILD'], emit: smoke(-60) }], ['root_boathouse', 1.5, { coast: true }], ['well_mossy', 1, { on: ['WILD'] }], ['tent_hide', 1, { on: ['WILD'] }],
        ['tent_hide_b', 0.8, { on: ['WILD'] }], ['campfire', 0.6, { emit: smoke(-20) }], ['firewood_lean_to', 1], ['deer_stand', 1, { on: ['WILD', 'FOREST'] }], ['mossy_statue', 1],
        ['offering_stone', 1], ['spiral_stone', 1], ['standing_stone_b', 1], ['goose_house', 0.8, { on: ['WILD'] }], ['bee_skep', 0.8, { on: ['WILD'] }],
        ['honey_stall', 0.5, { on: ['WILD'] }], ['mushroom_stall', 0.5, { on: ['WILD'] }], ['timber_cart', 0.6], ['signpost_wood', 0.5], ['lantern_post_wood', 0.5],
        ['eel_trap', 0.8, { coast: true }]], { twin: true, jitter: 0.5 }),
      T('landmarks', 'landmark', 196, { ROCK: 0.4, WILD: 0.3, FOREST: 0.15 }, [['root_ledge_falls', 1, { on: ['ROCK', 'WILD'], emit: spray(-24) }],
        ['elder_arch', 1, { on: ['WILD', 'FOREST'] }], ['great_stump', 1, { on: ['WILD', 'FOREST'] }], ['moot_oak', 1, { on: ['WILD'] }]], { twin: true, jitter: 0.4 }),
      MAPOBJ({ ROCK: 0.55, SNOW: 0.55, WILD: 0.08, FOREST: 0.08 }), // giant trees, fern brakes and fallen logs stand in the wood too
    ],
    creatures: { pitch: 14, density: { WILD: 0.22, FOREST: 0.2, ROCK: 0.15, WATER: 0.12 },
      species: [['stag', 2, [1, 3], ['WILD', 'FOREST']], ['wild_boar', 2, [2, 3], ['FOREST', 'WILD']], ['grey_wolf', 1, [2, 3], ['FOREST', 'ROCK']],
        ['goose', 1.5, [2, 4], ['WILD']], ['badger', 1, [1, 1], ['FOREST', 'WILD']], ['hedgehog', 1, [1, 1], ['WILD', 'FOREST']],
        ['red_squirrel', 1.5, [1, 2], ['FOREST']], ['kingfisher', 1.5, [1, 1], ['WATER']]] },
    birds: { pitch: 150, p: 0.35, species: [['owl_flight', 1, [1, 2], null, { speed: 30, alt: 64 }]] },
    ambience: [ // fireflies, drifting leaves, bees in the glades; sun motes and green leaves (shared fx) at the 1:1 zoom
      { id: 'leaf_drift', kind: 'fall', pitch: 12, density: { FOREST: 0.8, WILD: 0.1 }, lifeMs: 6500, alt: 72, windK: 1.3 },
      { id: 'firefly_drift', kind: 'wander', pitch: 11, density: { FOREST: 0.55, WILD: 0.38 }, lifeMs: 5000, windK: 0.2 },
      { id: 'bee_drift', kind: 'wander', pitch: 16, density: { WILD: 0.16 }, lifeMs: 6000, windK: 0.3 },
      { id: 'dust_motes', shared: true, kind: 'wander', pitch: 8, minD: 1800, density: { FOREST: 0.4, WILD: 0.1 }, lifeMs: 5000, windK: 0.4 },
      { id: 'leaf_drift_green', shared: true, kind: 'fall', pitch: 14, minD: 1800, density: { FOREST: 0.57 }, lifeMs: 6500, alt: 72, windK: 1.3 },
    ],
  },
  thornwake: {
    wind: [-2, -1],
    fields: { veg: [94, 132], rock: [122, 164] },
    stands: { mixes: [ // kit groves: stands / frame / step / falls (spacing 1.6, clusterWeight 0.55), riverside palms, fern brakes, boulders
      { id: 'jungle', field: 'veg', variants: 10, R: [2.5, 4.5], spacing: 1.6, cluster: 0.55, sway: true,
        density: { WILD: 0.78, ROCK: 0.16 },
        species: [['canopy_kapok', 5], ['canopy_kapok_b', 4], ['canopy_banyan', 3], ['canopy_banyan_b', 2], ['canopy_liana_hardwood', 5], ['canopy_liana_hardwood_b', 3],
          ['canopy_rubber_tree', 3], ['canopy_rubber_tree_b', 3], ['canopy_strangler_fig', 4], ['canopy_strangler_fig_b', 3]] },
      { id: 'palms', field: 'veg', variants: 6, R: [1.5, 3.5], spacing: 2, cluster: 0.5, sway: true,
        density: { WILD: 0.6, ROCK: 0.1 },
        species: [['canopy_jungle_palm', 4], ['canopy_jungle_palm_slender', 4], ['canopy_bamboo', 4], ['canopy_tree_fern', 3], ['canopy_banana_young', 2], ['canopy_tree_fern_young', 1]] },
      { id: 'ferns', field: 'veg', variants: 6, R: [1.5, 3], spacing: 1.4, cluster: 0.4, sway: true,
        density: { WILD: 0.55, ROCK: 0.2 },
        species: [['canopy_giant_fern', 6], ['canopy_fern_small', 5], ['canopy_cycad', 2], ['canopy_cycad_small', 3], ['canopy_vine_tangle', 4], ['heliconia', 2], ['canopy_orchid_bush', 1], ['pitcher_plants', 1]] },
      { id: 'jrocks', field: 'rock', variants: 8, R: [1.5, 3], spacing: 1.56, cluster: 0.35,
        density: { ROCK: 0.95, WILD: 0.3 },
        species: [['boulder_jungle', 3], ['boulder_jungle_b', 3], ['rock_l_jungle', 3], ['rock_s_jungle', 2], ['canopy_log_mossy', 1], ['canopy_giant_fern', 1], ['canopy_cycad_small', 1]] },
    ] },
    groups: [
      T('grove', 'tree', 1.75, { FOREST: 0.92 }, [['canopy_kapok', 5], ['canopy_kapok_b', 4], ['canopy_liana_hardwood', 5], ['canopy_liana_hardwood_b', 3],
        ['canopy_strangler_fig', 4], ['canopy_strangler_fig_b', 3], ['canopy_banyan', 3], ['canopy_banyan_b', 2], ['canopy_rubber_tree', 3], ['canopy_rubber_tree_b', 3],
        ['canopy_great_kapok', 0.35], ['canopy_great_kapok_b', 0.35]], { sway: true, cluster: 0.7 }),
      T('lone', 'tree', 5, { WILD: 0.26, ROCK: 0.06 }, [['canopy_jungle_palm', 3], ['canopy_jungle_palm_slender', 3], ['canopy_bamboo', 2], ['canopy_banana', 2],
        ['canopy_banana_young', 1], ['canopy_mango', 1], ['canopy_mango_b', 1], ['canopy_tree_fern', 2], ['canopy_cycad', 1], ['canopy_dead_palm', 0.5]], { twin: true, sway: true, mod: LONE }),
      T('scrub', 'scrub', 3, { WILD: 0.13, FOREST: 0.12, ROCK: 0.07 }, [['canopy_giant_fern', 4], ['canopy_fern_small', 4], ['canopy_cycad_small', 2], ['canopy_vine_tangle', 3],
        ['heliconia', 2], ['canopy_orchid_bush', 1], ['pitcher_plants', 1], ['canopy_tree_fern_young', 1], ['reeds_jungle', 2, { coast: true }]], { mod: UNDER }),
      T('rocks', 'rock', 4, { ROCK: 0.45, WILD: 0.02, FOREST: 0.01 }, [['rock_s_jungle', 3], ['rock_l_jungle', 3], ['boulder_jungle', 2], ['boulder_jungle_b', 2],
        ['termite_mound', 0.6, { on: ['WILD'] }], ['temple_block_fallen', 0.5]], { mod: STONES }),
      // the home view's many fallen mossy logs (kit woods_floor): the densest litter of any realm
      T('litter', 'litter', 5, { WILD: 0.04, FOREST: 0.07 }, [['canopy_log_mossy', 4], ['stump_jungle', 1.5], ['root_arch', 1], ['fallen_fruit_pile', 0.5]], { mod: DEBRIS }),
      T('features', 'feature', 30, { WILD: 0.18, ROCK: 0.1, FOREST: 0.04 }, [
        ['stilt_longhouse', 2, { on: ['WILD'], emit: smoke(-56) }], ['stilt_boathouse', 1.5, { coast: true }], ['stilt_granary', 1.2, { on: ['WILD'] }], ['fowl_coop', 0.8, { on: ['WILD'] }],
        ['fruit_stall', 0.6, { on: ['WILD'] }], ['market_stall_thatch', 0.6, { on: ['WILD'] }], ['drying_rack', 0.8], ['fish_smoking_rack', 0.8, { coast: true, emit: smoke(-30) }],
        ['cookfire', 0.6, { emit: smoke(-20) }], ['idol_mossy', 1], ['carved_post', 0.8], ['offering_bowls', 0.6], ['hammock_posts', 0.6], ['water_wheel', 0.8, { coast: true }],
        ['bamboo_torch', 0.5], ['signpost_bamboo', 0.5], ['pottery_jars', 0.5], ['termite_mound', 0.8, { on: ['WILD'] }], ['dugout_canoe_beached', 0.8, { coast: true }],
        ['fish_trap_bamboo', 0.6, { coast: true }]], { twin: true, jitter: 0.5 }),
      T('landmarks', 'landmark', 196, { ROCK: 0.4, WILD: 0.3, FOREST: 0.15 }, [['mossy_falls', 1, { on: ['ROCK', 'WILD'], emit: spray(-30) }],
        ['temple_head', 1, { on: ['WILD', 'FOREST'] }], ['red_mud_bluff', 1, { on: ['ROCK', 'WILD'] }], ['vine_arch', 1, { on: ['WILD', 'FOREST'] }]], { twin: true, jitter: 0.4 }),
      MAPOBJ({ ROCK: 0.55, SNOW: 0.55, WILD: 0.07, FOREST: 0.07 }),
    ],
    // map objects: massif 1–3, range 1 and waterfall 1 all carry a fall (5 of its 13 rock objects; the kit has one, Mossy
    // Falls): rare and only by water (FALL); peaks, hills, crags and the spire carry the rock instead
    mapobjs: { map_massif_1: FALL, map_massif_2: FALL, map_massif_3: FALL, map_range_1: FALL, map_waterfall_1: FALL, peak: 2, hill: 1.5, crag: 1.5, spire: 1.5 },
    creatures: { pitch: 14, density: { WILD: 0.22, FOREST: 0.22, ROCK: 0.15, WATER: 0.15 },
      species: [['crocodile', 1.5, [1, 2], ['WATER']], ['tapir', 1.5, [1, 2], ['FOREST', 'WILD']], ['monitor_lizard', 1.5, [1, 1], ['ROCK', 'WILD']],
        ['jungle_boar', 2, [2, 3], ['FOREST', 'WILD']], ['hornbill', 1, [1, 2], ['FOREST']], ['macaque', 2, [2, 4], ['FOREST', 'WILD', 'ROCK']],
        ['jungle_fowl', 1.5, [2, 4], ['WILD', 'FOREST']], ['giant_frog', 1, [1, 2], ['WILD']]] },
    birds: { pitch: 140, p: 0.45, species: [['parrot_flight', 1, [3, 6], null, { speed: 46, alt: 70 }]] },
    ambience: [ // insects (butterflies; fireflies at 1:1), river mist (the kit's spray puffs drifting slowly: Thornwake has no mist sprite)
      { id: 'butterfly_drift', kind: 'wander', pitch: 10, density: { WILD: 0.25, FOREST: 0.15 }, lifeMs: 6000, windK: 0.4 },
      { id: 'spray_drift', kind: 'wander', pitch: 22, density: { WATER: 0.35, FOREST: 0.08 }, lifeMs: 16000, windK: 0.5 },
      { id: 'fireflies', shared: true, kind: 'wander', pitch: 8, minD: 1800, density: { FOREST: 0.35, WILD: 0.1 }, lifeMs: 4500, windK: 0.3 },
    ],
  },
  'seeker-reach': { // Solana Reach (D-170, the owner's realm): open crystal groves (kit grove spacing 3.2), slate and shard fields
    wind: [5, -3],
    // fix pass (critic B1 #2, "an even violet speckle"): the kit's groves and shard fields are zones with open reachstone
    // between, but a [106, 144] ramp covered ~3/4 of the land and the rock-field mixes filled the veg field's gaps, so 54 %
    // of MAP's 2×2 blocks drew a clump, evenly (window variance/mean 0.89). Sharp, high ramps and full groves inside them:
    // 38 % of blocks, clumped (1.5), with gaps (lane-life.md "Stage B fix pass")
    fields: { veg: [146, 160], rock: [140, 162] },
    stands: { mixes: [ // kit groves: amethyst_wood, umbral_stand, glowcap_hollow (LOW: ART pack-hints), lumen groves on SPECIAL, spring/ridge rises, shard fields
      { id: 'amethyst', field: 'veg', variants: 10, R: [2.5, 4.5], spacing: 2.4, cluster: 0.85,
        density: { WILD: 1, SPECIAL: 0.4, ROCK: 0.12 },
        species: [['canopy_crystal_amethyst_l', 6], ['canopy_crystal_amethyst_l_b', 4], ['canopy_crystal_teal_l', 4], ['canopy_crystal_teal_l_b', 2], ['canopy_silver_birch', 3], ['canopy_silver_birch_b', 2]] },
      { id: 'umbral', field: 'veg', variants: 8, R: [2, 4], spacing: 2.4, cluster: 0.85,
        density: { WILD: 0.9, ROCK: 0.3, SPECIAL: 0.3 },
        species: [['canopy_petrified_pine', 4], ['canopy_petrified_oak', 3], ['canopy_petrified_oak_b', 2], ['canopy_void_pine', 2], ['canopy_void_pine_b', 1], ['canopy_silver_birch_b', 2], ['canopy_crystal_amethyst_l', 2]] },
      { id: 'lumen', field: 'veg', variants: 6, R: [2, 4], spacing: 2.8, cluster: 0.8,
        density: { SPECIAL: 0.74, WILD: 0.12 },
        species: [['canopy_lumen_tree', 2], ['canopy_lumen_tree_b', 2], ['canopy_crystal_teal_l', 3], ['canopy_crystal_teal_l_b', 2], ['canopy_silver_birch', 2]] },
      { id: 'glowcaps', field: 'veg', variants: 4, R: [1.5, 3], spacing: 2.6, cluster: 0.85,
        density: { SPECIAL: 0.15, WILD: 0.05 },
        species: [['canopy_glowcap_l', 5], ['canopy_glowcap_l_b', 3], ['canopy_crystal_teal_l', 3], ['canopy_silver_birch', 3]] },
      { id: 'slate', field: 'rock', variants: 8, R: [1.5, 3], spacing: 1.8, cluster: 0.35,
        density: { ROCK: 0.9, SNOW: 0.8, WILD: 0.1, SPECIAL: 0.2 }, // slate frames the plots (edge lift), not the open land
        species: [['rock_l_slate_block', 3], ['boulder_slate', 2], ['boulder_slate_b', 2], ['rock_l_slate', 2], ['rock_s_slate', 2], ['crystal_cluster_violet', 2], ['crystal_cluster_teal', 2], ['geode_split', 1], ['silver_fern', 1]] },
      { id: 'shards', field: 'rock', variants: 6, R: [1.5, 3], spacing: 1.6, cluster: 0.4,
        density: { ROCK: 0.4, WILD: 0.3, SPECIAL: 0.3 },
        species: [['crystal_cluster_violet', 4], ['crystal_cluster_teal', 4], ['crystal_cluster_small_violet', 3], ['crystal_cluster_small_teal', 3], ['canopy_shard_cluster', 2], ['canopy_shard_cluster_b', 1], ['geode_split', 1]] },
    ] },
    groups: [ // crystal and petrified wood does not sway (no `sway` on any Solana row)
      T('grove', 'tree', 2.5, { FOREST: 0.9 }, [['canopy_crystal_teal_l', 5], ['canopy_crystal_teal_l_b', 4], ['canopy_crystal_amethyst_l', 3], ['canopy_crystal_amethyst_l_b', 2],
        ['canopy_void_pine', 2], ['canopy_void_pine_b', 1], ['canopy_silver_birch', 2], ['canopy_silver_birch_b', 1], ['canopy_petrified_oak', 1],
        ['canopy_lumen_tree', 0.35], ['canopy_lumen_tree_b', 0.35]], { cluster: 0.85 }),
      T('lone', 'tree', 5, { WILD: 0.26, SPECIAL: 0.12, ROCK: 0.06 }, [['canopy_crystal_amethyst_s', 3], ['canopy_crystal_teal_s', 3], ['canopy_silver_birch', 2],
        ['canopy_void_pine_b', 2], ['canopy_petrified_pine', 2], ['canopy_crystal_amethyst_l', 1], ['canopy_crystal_teal_l', 1], ['canopy_glowcap_l', 0.5]], { twin: true, mod: LONE }),
      T('scrub', 'scrub', 3, { WILD: 0.115, FOREST: 0.08, SPECIAL: 0.14, ROCK: 0.06, SNOW: 0.04 }, [['canopy_crystal_shrub', 3], ['canopy_crystal_shrub_teal', 2], ['canopy_lichen_bush', 3],
        ['canopy_lichen_bush_b', 2], ['silver_fern', 2], ['canopy_shard_cluster', 2], ['canopy_shard_cluster_b', 1], ['canopy_thorn_violet', 1], ['canopy_glowcap_s', 0.6],
        ['glowcap_cluster', 0.5, { on: ['SPECIAL', 'FOREST'] }], ['lumen_reeds_b', 2, { coast: true }]], { mod: UNDER }),
      T('rocks', 'rock', 4, { ROCK: 0.45, SNOW: 0.3, SPECIAL: 0.08, WILD: 0.02 }, [['rock_s_slate', 3], ['rock_s_slate_b', 2], ['rock_l_slate', 2], ['rock_l_slate_block', 3],
        ['boulder_slate', 2], ['boulder_slate_b', 2], ['crystal_cluster_violet', 2], ['crystal_cluster_teal', 2], ['crystal_cluster_small_violet', 1],
        ['crystal_cluster_small_teal', 1], ['geode_split', 1]], { mod: STONES }),
      T('litter', 'litter', 5, { WILD: 0.025, FOREST: 0.05, SPECIAL: 0.02 }, [['canopy_log_petrified', 2], ['stump_petrified', 1], ['stump_petrified_flat', 2], ['fallen_petrified', 1],
        ['fallen_monolith', 0.4]], { mod: DEBRIS }),
      T('features', 'feature', 30, { WILD: 0.18, ROCK: 0.12, SPECIAL: 0.14, FOREST: 0.03 }, [
        ['harvest_shed', 1.5, { on: ['WILD', 'SPECIAL'] }], ['quay_house', 1.5, { coast: true }], ['tent_teal', 1, { on: ['WILD'] }], ['tent_violet', 1, { on: ['WILD'] }],
        ['observatory_arc', 1], ['glow_brazier', 1], ['lantern_crystal', 0.8], ['beacon_lamp', 0.8], ['beacon_lamp_post', 1, { emit: beacon(-54) }], ['beacon_lens', 1, { emit: beacon(-48) }],
        ['rune_stone', 1], ['resonance_post', 0.8], ['resonance_post_b', 0.8], ['monolith_shard', 1], ['monolith_shard_b', 0.8], ['monolith_shard_c', 0.8], ['pedestal_lens', 0.8],
        ['broken_pillar_obsidian', 0.8], ['refinery_still', 0.6], ['crystal_cart', 0.5], ['signpost_obsidian', 0.5], ['market_stall_teal', 0.4, { on: ['WILD'] }],
        ['market_stall_violet', 0.4, { on: ['WILD'] }]], { twin: true, jitter: 0.5 }),
      T('landmarks', 'landmark', 196, { ROCK: 0.4, WILD: 0.3, SPECIAL: 0.4 }, [['crystal_spring_cliff', 1, { on: ['ROCK', 'SPECIAL', 'WILD'], emit: vapour(-30) }],
        ['broken_monolith', 1, { on: ['WILD', 'ROCK', 'SPECIAL'] }], ['resonance_gate_b_wide', 1, { on: ['WILD'] }], ['shard_ridge', 1, { on: ['ROCK'] }],
        ['shard_ridge_b', 1, { on: ['ROCK'] }], ['geode_hall', 1, { on: ['ROCK', 'WILD'] }]], { twin: true, jitter: 0.4 }),
      // map objects: 53 (ART A/A2/A3/B); the gem-shard water ones seat on the SEA band and lakes (never DEEP: no density)
      MAPOBJ({ ROCK: 0.55, SNOW: 0.55, SPECIAL: 0.3, WILD: 0.08, FOREST: 0.06, WATER: 0.25, SEA: 0.12 }),
    ],
    // the terraced violet mesas (3–6, the kit's ridge steps at map scale) weigh 2 on the rock; the one fall is rare and by water
    mapobjs: { map_waterfall_1: FALL, map_mesa_3: 2, map_mesa_4: 2, map_mesa_5: 2, map_mesa_6: 2 },
    creatures: { pitch: 14, density: { WILD: 0.2, FOREST: 0.18, ROCK: 0.2, SPECIAL: 0.2, SNOW: 0.1, WATER: 0.15 },
      species: [['phase_deer', 2.5, [1, 3], ['WILD', 'FOREST', 'SPECIAL']], ['shadow_cat', 1, [1, 1], ['ROCK', 'FOREST']], ['void_fox', 1.5, [1, 1], ['WILD', 'FOREST']],
        ['rock_tortoise', 1.5, [1, 2], ['ROCK', 'WILD']], ['glow_lizard', 1.5, [1, 2], ['ROCK', 'SPECIAL', 'SNOW']], ['shard_crab', 1, [1, 3], ['ROCK', 'WILD']],
        ['crystal_beetle', 1.5, [1, 2], ['WILD', 'SPECIAL', 'FOREST']], ['lumen_koi', 2, [2, 3], ['WATER']]] },
    birds: { pitch: 150, p: 0.4, species: [['echo_bats', 1, [3, 6], null, { speed: 40, alt: 60 }]] },
    ambience: [ // beacon pulses (below: `glow`, plus the kit beacons' wisps above), crystal glints, drifting light motes, wisps, spring vapour
      { id: 'spark_drift', kind: 'wander', pitch: 10, density: { ROCK: 0.6, SNOW: 0.6, SPECIAL: 0.4, FOREST: 0.24 }, lifeMs: 1200, windK: 0 },
      { id: 'mote_swarm', kind: 'wander', pitch: 14, density: { SPECIAL: 0.48, FOREST: 0.27, WILD: 0.16 }, lifeMs: 9000, windK: 0.5 },
      { id: 'wisp_drift', kind: 'wander', pitch: 16, density: { SPECIAL: 0.46, FOREST: 0.33 }, lifeMs: 7000, windK: 0.3 },
      { id: 'vapour_drift', kind: 'wander', pitch: 18, density: { WATER: 0.5, SEA: 0.06 }, lifeMs: 12000, windK: 0.8 },
    ],
    // ART's beacon map objects had their provider halo cleared (lane-art.md, cu/dehalo.mjs): LIFE pulses a glow at each lens,
    // in the 64-px map canvas (map-art px). See GLOW.
    glow: { map_beacon_1: [32, 20], map_beacon_2: [31, 18] },
  },
});
/**
 * The realm's LIFE table: realm.json.life when PACK writes one, else the defaults above — plus every sprite
 * the pack marks `kind: "landmark"` (ART's hero landmarks, the D-164.2 map-only extras), which joins the
 * landmark group so a new landmark needs no code change.
 */
export function lifeTable(realmId, meta) {
  const base = meta?.life ?? LIFE_TABLES[realmId] ?? null;
  if (!base) return null;
  const extra = Object.entries(meta?.sprites?.rects ?? {}).filter(([, r]) => r.kind === 'landmark').map(([id]) => [id, 1]);
  const objs = Object.entries(meta?.map?.objects ?? {}).map(([id, r]) => {
    const role = mapObjectRole(id, r), o = base.mapobjs?.[id] ?? base.mapobjs?.[role]; // a table's per-object / per-role weight (FALL)
    return [id, typeof o === 'number' ? o : o?.w ?? 1, { on: MAPOBJ_ROLES[role] ?? ['ROCK'], ...(o?.coast ? { coast: true } : {}), ...(base.glow?.[id] ? { glow: base.glow[id] } : {}) }];
  });
  if (!extra.length && !objs.length) return base;
  return { ...base, groups: base.groups.map(g => g.id === 'landmarks' ? { ...g, species: [...g.species, ...extra.filter(([id]) => !g.species.some(s => s[0] === id))] }
    : g.id === 'mapobj' ? { ...g, species: [...g.species, ...objs] } : g) };
}

// ---- compile a realm + plan a frame's draws (pure: life.js uploads what this returns) ----------------------
/**
 * Compile every LIFE table of a realm against the sprites the pack actually carries. `lookup` is
 * { sprite(id) → {inkH, w, h, ax, ay, frames, frameMs} | null, creature(id) → sheet | null }.
 * Unknown ids are dropped (never guessed) and listed in `missing` for stats / QC.
 */
export function compileLife(realmId, table, lookup) {
  if (!table) return null;
  const fields = compileFields(realmId, table.fields);
  const groups = table.groups.map(g => compileGroup(realmId, g, lookup.sprite, fields)).filter(g => g.species.length);
  const stands = table.stands ? compileStands(realmId, withCanopy(table), fields, lookup.sprite) : null;
  const creatures = table.creatures ? compileCreatures(realmId, table.creatures, lookup.creature) : null;
  const birds = table.birds ? compileBirds(realmId, table.birds, lookup.sprite) : null;
  const ambience = compileAmbience(realmId, table.ambience || [], lookup.sprite);
  const missing = [...table.groups.flatMap(g => compileGroup(realmId, g, lookup.sprite).missing), ...(creatures?.missing ?? []),
    ...(table.ambience || []).filter(a => !lookup.sprite(a.id)).map(a => `${a.id}${a.shared ? ' (shared fx pack)' : ''}`),
    ...[...new Set(stands?.missing ?? [])].map(id => `${id} (stand)`)];
  return { realm: realmId, wind: table.wind || [0, 0], fields, groups, stands, creatures, birds, ambience, missing };
}
/**
 * The MAP canopy of FOREST (fix iteration 1: the forest class read as flat green blocks at d 60–800): unless a mix
 * already grows on FOREST, a map-only stand mix of the grove group's own species fills it with clumps across MAP;
 * at TRUE it draws nothing, the grove's trees are the forest (standMember → null).
 */
export function withCanopy(table) {
  const grove = table.groups.find(g => g.id === 'grove'), mixes = table.stands.mixes;
  if (!grove || mixes.some(m => m.density?.FOREST)) return table.stands;
  return { ...table.stands, mixes: [...mixes, { id: 'canopy', mapOnly: true, variants: 16, R: [1.5, 3.5], spacing: grove.pitch, cluster: 0.8, // R fits forest ribbons between plots
    sway: false, density: { FOREST: 0.95 }, species: grove.species.map(([id, w]) => [id, w]) }] };
}
/** Band weights exactly as the camera writes them into uBand (camera.js bands(d).w: log-interpolated fades). */
export function bandWeights(d) { const w = bands(d).w; return { true: w.true, twins: w.twins }; }
/**
 * Whether LIFE's placement reads GROUND's TRUE tile records at d (GLSL lifeClass via uTrueCls; fix iteration 2).
 * GROUND resolves TRUE pages only from BANDS.pageResolve, and then keeps the view ±1 deed resident, which holds every
 * LIFE window and class sample (tested). Below it a resident page is a leftover of an earlier view (LRU): classes read
 * through it made clumps, map objects and herds depend on where the camera had been, and a context restore (an empty
 * LRU) moved them. So below pageResolve LIFE reads the MAP lattice class: a pure function of the position. GROUND's
 * MAP draw takes TRUE vertex classes on the same threshold (uMpVtx). LIFE only ever SAMPLES baked classes (the record
 * or the lattice), never GROUND's classifier (fix iteration 2, P0: compile cost).
 */
export const trueClasses = d => d >= BANDS.pageResolve;
/** Art px a stand's sprites may reach beyond its lattice cell: radius 4.5 t, a 64-px tree, the jitter. */
const STAND_MARGIN = 6 * ART + 64;
const maxDensity = arr => arr.reduce((m, v) => Math.max(m, v), 0) / 65535;
/** How much faster the first group of a tier (THIN_ORDER) thins than its last: the kept fractions are f^k, k from
 * THIN_SPREAD down to 1. */
export const THIN_SPREAD = 3;
/** The rise of a thinnable draw's bound through its plateau, as a share of its plain window (planDraws epsB). Smaller frees
 * budget where nothing thins (0.02: grove 0.73 instead of 0.69 at the retina's d 1100 rest edge) but makes a tier's start and
 * end steeper (0.02: stands 1 → 0.87 in one 0.2 % zoom step on a 1920×1080 dpr-2 screen); 0.1 keeps every step ≤ ~0.05. */
export const THIN_EPS = 0.1;
/**
 * The kept fraction of item `pos` of `n` in a thinning tier (THIN_ORDER) at the tier's factor f ∈ [0, 1] (W1): f^k with
 * k falling from THIN_SPREAD (the least defining group) to 1 (the most). At f = 0 the tier draws nothing: a rank window
 * submits at least one slot per block, so a group thinned towards 0 still costs that floor until it is off — its density
 * is continuous (→ 0), and the next tier only thins once this one is gone. The whole tier moves
 * together, so the deficit a zoom adds is shared and every density changes about as fast as the TRUE dissolve itself;
 * thinning one group at a time made a small group absorb it all (litter 0.97 → 0.25 over a 0.4 % zoom on the retina).
 */
export function thinFactor(pos, n, f) {
  const k = n > 1 ? 1 + (THIN_SPREAD - 1) * (n - 1 - pos) / (n - 1) : 1;
  return f ** k;
}
/**
 * Instances one frame's draws submit (RM-20, P0 fix pass; W1 rank windows): each draw's count × the instanced draws
 * that submit it. life.js draws a scatter group's kit range once per sprite array holding its species (kit art) and
 * PUFFS× for emitter puffs, its twin range once per twin array (below trueFull); stand members once per member array
 * (16 slots per stand), own and merged clumps once per clump array; birds twice (shadow and air). life.js records those
 * counts as `submit` on the compiled groups, stands and birds; without them (the pure tests' stubs) every draw counts
 * once. While the TRUE weight is 0 (trueOn false) a twin group's kit draws go only to arrays holding species without a
 * map twin (the rest would all cull). life.js's own draw accounting is tested equal to this.
 */
export function submittedTotal(L, out, d) {
  const ss = L.stands?.submit, ps = out.stands;
  return out.groups.reduce((a, pg) => a + (pg.kit?.count ?? 0) * pg.kitK + (pg.tw?.count ?? 0) * pg.twK, 0)
    + (ps ? ps.members * (ss?.members ?? 1) + (ps.clumps + (ps.merged ?? 0)) * (ss?.clumps ?? 1) : 0)
    + (out.creatures?.count ?? 0) + (out.birds?.count ?? 0) * (L.birds?.submit ?? 1) + out.ambience.reduce((a, e) => a + e.count, 0);
}
/** A group's draw multiplicities (see submittedTotal): kit range draws (+ puffs) and twin range draws. */
function groupKinds(g, trueOn, d) {
  const s = g.submit, twinNow = g.twin && d < BANDS.trueFull;
  if (!s) return { kitK: g.mapOnly ? 0 : 1, twK: twinNow ? 1 : 0 };
  return { kitK: (trueOn === false ? s.kitMap : s.kit) + s.puffs, twK: twinNow ? s.twin : 0 };
}
/**
 * The draws of one frame: per scatter group its lattice window and rank ranges (or inactive), the stands, the
 * herd/creature window with its keep fraction, birds and ambience windows, and totals. Pure in (compiled life, view),
 * so the budget and caps are unit-tested exactly as life.js applies them. view = {x, y, d, W, H, dpr, rm}.
 * trueClasses: whether the shaders may read TRUE tile records (see trueClasses).
 *
 * Draws (W1 rank windows): a TRUE-only group draws its kit art for ranks [0, wTrue · keep); a twin group its kit art for
 * [0, wTwin · keep) and its twins for [wTrue · keep, wTwin · keep); stands their members for [0, wTrue · keep) and their own clumps for
 * [wTrue · keep, keep). Each range is submitted as the cheaper of its plain window and its rank window (rankDraw), so the
 * MAP→TRUE fade submits about what it shows: kit art that the dissolve still hides is not sent (RM-20: the retina's
 * d 820 frame was 107k submitted, ~17k shown).
 */
export function planDraws(L, view) {
  const d = view.d, out = { groups: [], total: 0, ambience: [], trueClasses: trueClasses(view.d) };
  let rect = viewRectArt(view);
  if (view.bounds) { // never walk lattices outside the realm grid
    const b = view.bounds;
    rect = { x0: Math.max(rect.x0, b.x0), y0: Math.max(rect.y0, b.y0), x1: Math.min(rect.x1, b.x1), y1: Math.min(rect.y1, b.y1) };
    if (rect.x1 <= rect.x0 || rect.y1 <= rect.y0) return out;
  }
  const vw = (rect.x1 - rect.x0) / ART, vh = (rect.y1 - rect.y0) / ART; // view size in tiles
  const fullW = view.W * view.dpr / d * TILES_PER_DEED, fullH = view.H * view.dpr / d * TILES_PER_DEED; // unclipped view (tiles): LOD never flips while panning
  // Kit art that only the TRUE dissolve shows (groups without a twin, stand members) draws nothing while the TRUE weight
  // is 0 — at d = trueStart, a resting edge (RM-20).
  const { true: wTrue, twins: wTwin } = bandWeights(d); out.trueOn = wTrue > 0;
  // ---- pan-invariant cost bounds (W1): continuous in d, never below what a window can submit at any pan ----------
  // A window of pitch p and margin m over a view span s has at most (s + 2m)/p/stride + 2 cells per axis, and at most
  // ((s + 2m)/p + 1)/RANK_B + 2 rank blocks. A rank range [lo, hi) (fractions) submits at most RANK_SLOTS·(hi − lo) + 1
  // slots per block from 0 (+2 from lo > 0: two partial edge slots). The thinning below is fitted to these bounds only, so
  // it is a function of (d, W, H, dpr) — never of the pan, which would make instances flicker at the rank threshold.
  const spW = fullW * ART, spH = fullH * ART;
  const cellsB = (p, m, s = 1) => ((spW + 2 * m) / p / s + 2) * ((spH + 2 * m) / p / s + 2);
  const blocksB = (p, m) => (((spW + 2 * m) / p + 1) / RANK_B + 2) * (((spH + 2 * m) / p + 1) / RANK_B + 2);
  const rlB = (p, m, len, slack) => blocksB(p, m) * (RANK_SLOTS * len + slack + 1e-3);
  const floorB = (p, m, slack = 1) => Math.min(cellsB(p, m), rlB(p, m, 0, slack)); // a range just above empty: one or two slots
  // The bound of one thinnable draw whose rank range has length len (≤ lenMax, its length unthinned; slack 1 from 0, 2 inside):
  // the rank window's bound, but never above the plain window's except on a THIN_EPS ramp. Near keep 1 the plain window is
  // the cheaper draw and thinning saves nothing ("the plateau"); costing it flat would make the fitted keep jump across the
  // plateau the moment a tier starts, so the bound rises through it by THIN_EPS × the plain bound: strictly increasing, so the
  // fit is continuous, at the price of reserving THIN_EPS of the plain window where nothing thins.
  const epsB = (p, m, len, lenMax, slack) => {
    if (!(len > 0)) return 0;
    const P = cellsB(p, m), R = rlB(p, m, len, slack), lenC = (P / blocksB(p, m) - slack - 1e-3) / RANK_SLOTS;
    return lenMax <= lenC || len <= lenC ? Math.min(P, R) : Math.min(R, P * (1 + THIN_EPS * (len - lenC) / (lenMax - lenC)));
  };
  // A draw that ends at a threshold (the twin and own-clump ranges at trueFull, merged blocks at mergeUntil) keeps a phantom
  // of its last cost that fades out over EASE in d, and a stream that starts at one is phased in over EASE before it: the
  // bound total, hence every fitted density, stays continuous across them (it only over-reserves for a moment).
  const EASE = 1.1, after = t => clamp(1 - Math.log(d / t) / Math.log(EASE), 0, 1), before = t => clamp(1 - Math.log(t / d) / Math.log(EASE), 0, 1);

  const rank = g => { const i = THIN_ORDER.indexOf(g.id); return i < 0 ? THIN_ORDER.length : i; };
  const G = L.groups.map(g => {
    // map objects start with MAP proper (fix iteration 1: at the FAR fade they were sub-pixel yet half of all instances)
    const from = g.mapOnly ? BANDS.mapStart : g.twin ? BANDS.twins[0] : BANDS.trueStart;
    const on = d >= from && (!g.mapOnly || d < BANDS.trueFull) && (g.mapOnly || g.twin || wTrue > 0) && bigEnough(g.maxInkH, d);
    const win = on ? latticeWindow(g.pitchArt, rect, g.maxExtent) : { ix0: 0, iy0: 0, nx: 0, ny: 0, stride: 1 };
    return { g, on, win, keep: g.mapOnly ? mapKeep(blocksB(g.pitchArt, g.maxExtent)) : 1, ...groupKinds(g, out.trueOn, d) };
  });
  // thinning tiers (RM-20; W1: continuous): 1 the TRUE-only groups, 3 the twin groups, each in THIN_ORDER
  const tier = twin => G.filter(e => e.on && !e.g.mapOnly && !e.g.twin === !twin).sort((x, y) => rank(x.g) - rank(y.g));
  const T1 = tier(false), T3 = tier(true), tau = [1, 1, 1, 1];
  const setTier = (items, t) => items.forEach((e, i) => { e.keep = thinFactor(i, items.length, t); });
  const groupB = e => {
    const { g } = e, p = g.pitchArt, m = g.maxExtent, sub = g.submit;
    if (!e.on) { // phantoms across a group's own start and end (see EASE)
      const dOn = Math.max(g.mapOnly ? BANDS.mapStart : g.twin ? BANDS.twins[0] : BANDS.trueStart, minVisibleD(g.maxInkH));
      if (d <= dOn) { // what it submits the moment it starts: its ranges start empty, one slot per block
        if (g.mapOnly || d * EASE <= dOn) return 0;
        const k = groupKinds(g, dOn > BANDS.trueStart, dOn);
        return (k.kitK + k.twK) * floorB(p, m) * before(dOn);
      }
      return g.mapOnly && d >= BANDS.trueFull ? (sub ? sub.kitMap + sub.puffs + sub.twin : 1) * Math.min(cellsB(p, m), rlB(p, m, e.keep, 1)) * after(BANDS.trueFull) : 0;
    }
    if (g.mapOnly) return (e.kitK + e.twK) * Math.min(cellsB(p, m), rlB(p, m, e.keep, 1)); // their own cap, not a tier
    if (!(e.keep > 0)) return 0;                                   // thinned to nothing: off
    // TRUE-only kit art is costed as its rank window below the plateau (epsB): the tier fitted first must be continuous
    if (!g.twin) return e.kitK * epsB(p, m, wTrue * e.keep, wTrue, 1);
    const tail = d >= BANDS.trueFull ? (sub?.twin ?? 1) * floorB(p, m, 2) * after(BANDS.trueFull) : 0;
    return e.kitK * epsB(p, m, wTwin * e.keep, wTwin, 1) + e.twK * epsB(p, m, (wTwin - wTrue) * e.keep, wTwin - wTrue, wTrue > 0 ? 2 : 1) + tail;
  };

  const S = L.stands, st = { on: false, keep: 1 };
  if (S) { // stands: members (kit art) from the TRUE fade on; own clumps from the hand-over; merged clumps at low MAP
    st.members = wTrue > 0; st.clumps = d < BANDS.trueFull && d >= STAND.splitFrom && S.maxInkH * d >= MIN_SPRITE_PX * DEED_ART;
    st.on = st.members || st.clumps;
    const ss = S.submit ?? { members: 1, clumps: 1 };
    st.memK = STAND.members * ss.members; st.cluK = ss.clumps;
    const blocks = fullW * fullH / (2 * STAND.pitch) ** 2, ms = blocks <= STAND.mergeCap ? 1 : blocks <= 4 * STAND.mergeCap ? 2 : 0;
    if (ms && d >= STAND.mergeFrom && d < S.mergeUntil && S.maxInkH * STAND.merge * d >= MIN_SPRITE_PX * DEED_ART) {
      st.mw = latticeWindow(S.pitchArt * 2, rect, STAND_MARGIN * STAND.merge, ms);
      st.mergedB = st.cluK * cellsB(S.pitchArt * 2, STAND_MARGIN * STAND.merge, ms);
    } else if (d >= S.mergeUntil) st.mergedB = st.cluK * cellsB(S.pitchArt * 2, STAND_MARGIN * STAND.merge, 1) * after(S.mergeUntil);
    // the own clumps that end at trueFull (their range → [keep, keep) as w.true → 1, one slot per block)
    if (d >= BANDS.trueFull) st.tailB = st.cluK * floorB(S.pitchArt, STAND_MARGIN, 2) * after(BANDS.trueFull);
  }
  if (S && !st.members && d <= BANDS.trueStart) st.tailB = (st.tailB ?? 0) + st.memK * floorB(S.pitchArt, STAND_MARGIN) * before(BANDS.trueStart);
  const standsB = () => (st.on && st.keep > 0 ? (st.members ? st.memK * epsB(S.pitchArt, STAND_MARGIN, wTrue * st.keep, wTrue, 1) : 0)
    + (st.clumps ? st.cluK * epsB(S.pitchArt, STAND_MARGIN, (1 - wTrue) * st.keep, 1 - wTrue, 2) : 0) : 0) + (st.mergedB ?? 0) + (st.tailB ?? 0);

  // keep-capped streams: herds/creatures, birds, ambience (thinned first, by world-aligned strides: their keep × s²
  // keeps the expected on-screen count, so the thinning shows no density change)
  const streams = [];
  let rampB = 0;
  const onAt = (lo, hi, on) => { for (let i = 0; i < 24; i++) { const mid = (lo + hi) / 2; if (on(mid)) hi = mid; else lo = mid; } return hi; }; // on is monotone in d
  const c = L.creatures;
  if (c && c.species.length) { const dOn = Math.max(BANDS.herds, minVisibleD(c.maxInkH)); if (d < dOn) rampB += HERD_MAX * cellsB(c.pitchArt, LOOP_RADIUS_TILES * ART + 64) * before(dOn); }
  if (c && c.species.length && d >= BANDS.herds && bigEnough(c.maxInkH, d)) {
    const margin = LOOP_RADIUS_TILES * ART + 64, win = latticeWindow(c.pitchArt, rect, margin);
    const sites = vw * vh / (c.pitch * c.pitch);
    const meanHerd = c.species.reduce((a, s) => a + (s.herdMin + s.herdMax) / 2, 0) / c.species.length;
    const cap = d >= BANDS.creatures ? LIFE_CAPS.creatures : LIFE_CAPS.herds;
    out.creatures = { ...win, count: win.nx * win.ny * HERD_MAX, keep: keepFraction(cap, sites * maxDensity(c.density) * meanHerd), cap };
    streams.push({ e: out.creatures, pitchArt: c.pitchArt, per: HERD_MAX, k: 1 });
  }
  const b = L.birds;
  if (b && b.species.length && !view.rm) {
    const bigAt = x => b.species.some(s => bigEnough(s.sp.inkH, x, skyScale(x)));
    if (!bigAt(d) && bigAt(d * EASE)) { const dOn = onAt(d, d * EASE, bigAt), k = skyScale(dOn); rampB += FLOCK_MAX * (b.submit ?? 1) * cellsB(b.pitchArt, 12 * ART + 160 * k) * before(dOn); }
    const k = skyScale(d), big = bigAt(d);
    if (big) {
      const reach = 12 * ART + 160 * k;
      const win = latticeWindow(b.pitchArt, rect, reach);
      const sites = (vw + 2 * reach / ART) * (vh + 2 * reach / ART) / (b.pitch * b.pitch);
      const meanFlock = b.species.reduce((a, s) => a + (s.fMin + s.fMax) / 2, 0) / b.species.length;
      out.birds = { ...win, count: win.nx * win.ny * FLOCK_MAX, keep: keepFraction(LIFE_CAPS.birds, sites * b.p16 / 65535 * meanFlock), scale: k };
      streams.push({ e: out.birds, pitchArt: b.pitchArt, per: FLOCK_MAX, k: b.submit ?? 1 });
    }
  }
  if (!view.rm) {
    let expected = 0;
    for (const a of L.ambience) if (!bigEnough(ambienceInk(a), d) && bigEnough(ambienceInk(a), d * EASE))
      rampB += cellsB(a.pitchArt, 160 + (a.alt ?? 0)) * before(minVisibleD(ambienceInk(a)));
    const act = L.ambience.filter(a => bigEnough(ambienceInk(a), d)).map(a => {
      const win = latticeWindow(a.pitchArt, rect, 160 + (a.alt ?? 0));
      expected += vw * vh / (a.pitchArt / ART) ** 2 * maxDensity(a.density);
      return { a, ...win, count: win.nx * win.ny };
    });
    const keep = keepFraction(LIFE_CAPS.particles, expected);
    for (const e of act) { e.keep = keep; out.ambience.push(e); streams.push({ e, pitchArt: e.a.pitchArt, per: 1, k: 1 }); }
  }
  const streamsB = () => streams.reduce((a, s) => a + s.k * s.per * cellsB(s.pitchArt, s.e.margin, s.e.stride ?? 1), rampB);

  // ---- the §9 ceiling (RM-20), fitted to the bounds (W1) --------------------------------------------------------------
  // Tiers, from the least visible: 0 the keep-capped streams (strides, count-neutral); 1 the TRUE-only groups; 2 the
  // stands; 3 the twin groups. Tiers 1–3 thin by RANK — one continuous factor f per tier (thinFactor), solved so the
  // bound total meets the cap — so a density never steps while zooming. The actual submission is at most the bound total.
  out.cap = submittedCap(view);
  const model = () => G.reduce((a, e) => a + groupB(e), 0) + standsB() + streamsB();
  if (model() > out.cap) {
    const restream = (s, n) => {
      const e = s.e;
      if (!e?.count || (e.keep0 ?? e.keep) * n * n > 1) return;
      e.keep0 ??= e.keep;
      Object.assign(e, latticeWindow(s.pitchArt, rect, e.margin, n)); e.count = e.nx * e.ny * s.per; e.keep = e.keep0 * n * n;
    };
    for (let n = 2; n <= THIN_MAX && model() > out.cap; n *= 2) for (const s of streams) { if (model() <= out.cap) break; restream(s, n); }
    const fit = apply => { // the largest f whose bound total meets the cap (the total rises with f); 0 (the floors) when none does
      apply(0); if (model() > out.cap) return 0;
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) { const mid = (lo + hi) / 2; apply(mid); if (model() > out.cap) hi = mid; else lo = mid; }
      apply(lo); return lo;
    };
    const tiers = [[1, T1.length, f => setTier(T1, f)], [2, st.on ? 1 : 0, f => { st.keep = thinFactor(0, 1, f); }], [3, T3.length, f => setTier(T3, f)]];
    for (const [k, n, apply] of tiers) if (n && model() > out.cap) tau[k] = fit(apply);
  }
  out.thin = { tau, model: model(), parts: { groups: Object.fromEntries(G.filter(e => groupB(e) > 0).map(e => [e.g.id, Math.round(groupB(e))])), stands: Math.round(standsB()), streams: Math.round(streamsB()) } };

  // ---- the draws ---------------------------------------------------------------------------------------------------
  for (const e of G) {
    const { g, win } = e, pg = { g, ...win, keep: e.keep, kitK: e.kitK, twK: e.twK, kit: null, tw: null, count: 0 };
    if (e.on && g.mapOnly) { pg.truHi = 0; pg.keepHi = pg.twinHi = rankBound(e.keep); pg.kit = pg.tw = rankDraw(win, 0, pg.keepHi); }
    else if (e.on) {
      pg.keepHi = rankBound(e.keep); pg.truHi = rankBound(wTrue * e.keep); pg.twinHi = g.twin ? rankBound(wTwin * e.keep) : 0;
      pg.kit = rankDraw(win, 0, g.twin ? pg.twinHi : pg.truHi); // a twin group's kit draws also show twin-less species' twins
      if (g.twin && d < BANDS.trueFull) pg.tw = rankDraw(win, pg.truHi, pg.twinHi);
    }
    pg.count = pg.kit?.count ?? 0;
    out.groups.push(pg);
  }
  if (st.on || st.mw) {
    const win = st.on ? latticeWindow(S.pitchArt, rect, STAND_MARGIN) : { ix0: 0, iy0: 0, nx: 0, ny: 0, stride: 1 };
    const keepHi = rankBound(st.keep), truHi = rankBound(wTrue * st.keep);
    const mem = st.members ? rankDraw(win, 0, truHi) : rankDraw(win, 0, 0), clu = st.clumps ? rankDraw(win, truHi, keepHi) : rankDraw(win, 0, 0);
    out.stands = { ...win, sites: win.nx * win.ny, keep: st.keep, truHi, keepHi, mem, clu, members: mem.count * STAND.members, clumps: clu.count, merged: 0 };
    if (st.mw) { out.stands.merged = st.mw.nx * st.mw.ny; out.stands.mergedWin = st.mw; }
  }
  out.total = submittedTotal(L, out, d);
  return out;
}
