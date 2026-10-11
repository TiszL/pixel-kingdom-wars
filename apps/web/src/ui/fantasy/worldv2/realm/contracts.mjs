// Realm maps (D-162/D-163/D-164): FROZEN cross-lane contracts (docs/REALM-MAP-PLAN.md §10.2).
// Only SHELL changes this file. Every other lane imports from it and never re-declares a number.
// Game numbers come from packages/shared/src/constants.ts (hard rule); the presentation-only numbers
// below (bands, decor caps, ring widths, idle policy) move to a REALM_MAP block in constants.ts at
// productisation (plan §6.3 last paragraph).
import {
  GRID, CAMPAIGN, CAMPAIGN_LAYOUT, STRUCTURES, BASE_GROUND_WORLD_GEOMETRY, BUILD_COUNT_CAP_BY_KEEP, wallCapForKeepLevel,
} from '@shardkeep/shared';

// ---- geometry ---------------------------------------------------------------------------------
/** In-game tiles per deed: one deed = one base world (constants.ts BASE_GROUND_WORLD_GEOMETRY). */
export const TILES = BASE_GROUND_WORLD_GEOMETRY.worldTiles; // 98
/** Art px per in-game tile at 1× (constants.ts GRID.tilePx). */
export const ART = GRID.tilePx; // 32
/** Map lattice: 1 map cell = 7 tiles, 14 cells per deed (plan §3.3 D′). */
export const CELL = 7, CELLS = TILES / CELL; // 14
/** Art px per deed at 1× = the true scale (plan §2). */
export const DEED_ART = TILES * ART; // 3136
/** Map-art px per deed (32-px map cells × 14). */
export const MAP_ART = CELLS * 32; // 448
/** Deed-local origin of the in-game base world (constants.ts: worldOriginTiles −34). */
export const WORLD_ORIGIN = BASE_GROUND_WORLD_GEOMETRY.worldOriginTiles; // -34
/** One deed spans 0.5° of lon/lat on the globe (the deed catalog grid). */
export const DEED_DEG = 0.5;

// ---- zoom bands (plan §2.1). All values are d = device px per deed unless marked s (CSS px per deed).
export const BANDS = Object.freeze({
  farEnd: 24, mapStart: 48, trueStart: 800, trueFull: 1100,
  impostor: Object.freeze([200, 280]),
  /** Open intervals where the camera may not rest; a finished gesture eases to the nearer edge. */
  rest: Object.freeze([Object.freeze([24, 48]), Object.freeze([200, 280]), Object.freeze([800, 1100])]),
  restEaseMs: 250,
  selectD: 700, myBaseD: 1400,                // fly/rest targets, in d
  twins: Object.freeze([250, 350]), herds: 300, creatures: 1100, sway: 2000, snap: 3136,
  pageResolve: 600, trueAssets: 400, chart16: 12,
  sMax: 6272,                                 // s: 64 CSS px per tile, the base scene's T = 64
  uiDots: 24, uiIcons: 48, keepMinCss: 28, domeSilhouette: 100, pennants: 120, smoke: 200, // s
  deedLinesFrom: 16, deedLinesOff: 800,       // d
});
export const SELECT_D = BANDS.selectD, MY_BASE_D = BANDS.myBaseD;

/** Keep enlargement inside its courtyard (plan §6.7): kFit(L) = min(maxScale, clearTiles/inkTiles). */
export const KEEP_FIT = Object.freeze({
  maxScale: 2, clearTiles: Object.freeze({ below9: 4.5, citadel: 3.75 }), courtyard: Object.freeze([46, 52]),
  inkTiles: Object.freeze({ l1: 1.6, l20: 2.3 }), fitFromD: 280, trueAtD: 1100,
});
/** River/track stroke rules (plan §3.2 step 4, §4.3 step 3). Units: tiles. */
export const LINES = Object.freeze({ riverHwMin: 1.5, trackHwMin: 1.0, riverNoiseK: 0.35, lensMargin: 6 });
/** Timed idle policy (plan §7 / C10). */
export const IDLE = Object.freeze({
  fullMs: 20000, fullCapFps: 20, capFps: 8, freezeMs: 60000, pulseFps: 4,
  /** Tags whose pulse may keep rendering after the freeze (at pulseFps). */
  pulseTags: Object.freeze(['select', 'shield']),
  /** A period at or below this is "continuous" (shield sweep, clouds, particles): capped at fullCapFps. */
  continuousMs: 50,
  /** After leave(), the realm's GPU textures are freed this late (fix iteration 2: realm + re-warmed globe hit the
   *  200 MB phone bar); re-entry re-uploads from the loader's decoded sources. A quick re-dive inside it stays warm. */
  evictMs: 5000,
});
/**
 * GPU safety (P0, KNOWN_ISSUES RM-GPU-1: the realm map hung the owner's whole Mac GPU). Three quality levels:
 * 0 default, 1 slow GPU, 2 safe (after slow frames at level 1, a lost context, or a session that died inside the
 * map). The ground passes render into an INTEGER fraction 1/n of the canvas (an exact n× pixel snap, never a second
 * resample of the pixel art; P0 fix pass #4), sprites and UI at the canvas's own resolution; heavy = the optional passes
 * (LIFE 'air', cloud shade, the animation loop, the selection pulse). The divisor n per level (core.groundDiv, W1 S3/S4):
 *   level 0: n = 1 (full resolution) when ONE ground display pass is drawn at rest and that pass plus the resolve slices
 *            fit the display budget (groundcost PASS[pass] + RESOLVE_BUDGET ≤ DISPLAY_BUDGET: chart and TRUE today; MAP
 *            once GROUND's MAP pass is ≤ 58 fetches); else n0 = ceil(dpr / groundPx[0]) (dpr 2 → ½ in every fade);
 *   level 1: n1 = max(n0, ceil(dpr / groundPx[1])) everywhere (½ on dpr 1.5–2);
 *   level 2: n1 + 1 everywhere (⅓ on dpr 2, ½ on dpr 1), and heavy off.
 * So on every screen of dpr ≥ 1.5 each level that changes the view cuts the modelled ground frame cost ≥ 20 % (a
 * level that changes nothing in the current band state is skipped by the watchdog). The switch between n 1 and n0 happens
 * where a fade's weight reaches 0 or 1 (one pass ↔ two), never mid-fade.
 * The watchdog (core.qualityStep) counts only STEADY frames: a frame with a first (program, state) draw, a rehearsal
 * draw, a link completion or an upload over coldUploadBytes (and the frame after it) is one-off work and never a sample
 * (#3, #6, W1 S6). It steps one level down when `need` of the last `window` samples took more than slowMs of GPU time,
 * or `severeNeed` took severeMs; it steps back up (never above the floor a lost context or a stored crash set) after
 * upAfter consecutive samples ≤ upMs, and never again once a step up was followed by a step down (no oscillation).
 * lossStop lost contexts in one session stop the realm map until a reload, and so does ONE loss at level 2 (there is no
 * cheaper level to restore at: restoring the same view would run the same hang again, W1 S5).
 * Crash memory (W1 S5, core.gpuRecord; localStorage[storeKey], never on a software rasteriser): a visit that ended inside
 * the map without a clean leave (a freeze, a crash, a force quit), or a lost context, stores level 2 and counts a crash.
 * The stored level holds until crash.clean × crashes clean visits have followed (2, then 4, 6 …: back-off), with no time
 * expiry — a whole-machine freeze the next day is the same hazard. A visit is clean only if it drew crash.steady steady
 * watchdog samples (≈ 1 s of drawing) in a band at or above the band the crash happened in (the band is stored beside
 * `pending`; W1 fix pass 2 #6: two short FAR visits used to clear a MAP freeze). A crash while the stored level was already 2 holds
 * the realm map until the player chooses TRY AGAIN (never an automatic re-run of a view that froze even in safe mode).
 */
export const GPU_SAFE = Object.freeze({
  groundPx: Object.freeze([1.5, 1.0]), heavy: Object.freeze([true, true, false]),
  slowMs: 50, severeMs: 250, window: 6, need: 3, severeNeed: 2, upMs: 12, upAfter: 240, coldUploadBytes: 256 * 1024, lossStop: 2,
  /**
   * Level-0 frame-rate governor for MAP rest (stage B D2, D-167 "degrade detail adaptively"; core.govStep). W1 made MAP full
   * resolution at rest (the owner-bar fix for the k ½ softness), 3.0–3.3× the fade frame's ground work, and the watchdog
   * steps down only below ~20 fps (slowMs 50). So between 20 and 60 fps nothing traded it back. The governor watches the
   * steady GPU samples of frames that drew the MAP pass ALONE at level 0: when their median over the last windowMs (at least
   * minSamples, spanning ≥ 0.8 × windowMs) is over ms, MAP rest renders at n0 (½ on dpr 2, as in a fade); it returns to full
   * resolution after upAfter consecutive MAP-rest samples ≤ upMs (≈ ms / 3.3: the n0 frame's share of the full one), and
   * locks at n0 for the session once a return has been followed by another drop (qualityStep's no-oscillation rule). Only on a
   * real GPU (the watchdog's own switch); a software rasteriser measures only. Device-unverified thresholds (Gate B sets them).
   */
  gov: Object.freeze({ ms: 20, windowMs: 1000, minSamples: 6, upMs: 6, upAfter: 120 }),
  storeKey: 'rm-gpu-safe', crash: Object.freeze({ clean: 2, steady: 60 }),
  /**
   * Band rehearsal (P0 fix pass #1/#5, contract v2 W1 S1/S2): a program's GPU pipeline — and the driver's per-state
   * fragment work (SwiftShader's sampling routines, tile-based drivers) — is built at its first draw that SHADES
   * FRAGMENTS, not at link. So map.js pre-draws every (program, GL state) the bands use, before the band change:
   * - WHEN: after the painted overview is on screen and GROUND's MAP data is in (so it never delays MAP ready). A hook may
   *   be called while its lane still loads (falsy then only backs off); after its load() settled, falsy = `nothing` (below)
   *   and only then do its programs gate a band. One NEW (program, state) per frame at most (core skips further new
   *   states in that call; the hook is called again next frame), at idleMs after the last input with the camera still —
   *   or at once while the camera waits at a band gate or a lane waits for its pipelines (see below), gapMs apart.
   * - ORDER of need: the MAP set (every program not in trueSet) before the TRUE set, then `order`.
   * - HOW: lane.rehearse(prog, view, rv) → truthy when it drew; rv = { target: 'canvas' | 'low', k, box }. SHELL has
   *   bound the pass's real target — GROUND: the canvas or the ½ (low) ground target, once per target the current
   *   level uses, depth test off; LIFE/BASES/minimap: the canvas, depth test on (LEQUAL), writes on — with the viewport
   *   set so the VIEW CENTRE (clip-space origin) lands in a box × box px square at the target's origin, and SCISSOR_TEST
   *   locked to that square (core ignores gl.scissor and gl.disable(SCISSOR_TEST) during a rehearsal). Display hooks do
   *   not change the viewport and draw ONE instance that covers the view centre (view.x, view.y), ≥ 1 device px — TWO when
   *   one program's real draws take two texture paths one instance cannot both reach (BASES' sprite: textureLod when
   *   magnified, texture() when minified; ≤ 2 × box² fragments, accepted at the W1 integrate) — with the
   *   real draw's textures bound (or ones of the same format, filter and wrap), so ≥ 1 fragment is shaded (a discard
   *   counts: it ran); a full-screen pass covers it by itself. A bake hook binds a scratch target of the real format and
   *   sets gl.viewport to it (the locked box at 0,0 lies inside). Each hook draws EVERY state variant its real passes
   *   use (VAO and vertex layout, blend on/off and func, depth test/mask, colour mask), 1 instance (2 as above), ≤ 6 vertices, and is
   *   idempotent (it may be called several times: no uploads, no resolves, no cache/LRU changes). SHELL restores FBO,
   *   viewport, blend, depth, scissor, cull, colour mask and the VAO afterwards.
   * - Falsy = cannot draw it now: retried without a count (retryMs × tries, ≤ retryMaxMs; at once when the lane's load
   *   settles); after the load settled it is also reported as `nothing` and never gates. A throw is logged and that
   *   program skipped (the lane is NOT disabled).
   * - A real draw of a (program, state) no rehearsal built is listed in stats().rehearsal.stateMisses.
   * - BAND READINESS: the camera may not zoom past a band's gate edge (gate.map = BANDS.farEnd, gate.true =
   *   BANDS.trueStart) until that band's set is rehearsed (for lanes that have loaded): it rests at the edge with a small
   *   cue in the scale pill, and a flight aimed past it resumes when the gate opens. The FAR→MAP gate also waits for
   *   GROUND's mapReady(view) (G4) for at most mapReadyHoldMs. A gate with no rehearsal progress for stallMs opens anyway
   *   (logged): a stuck hook must never lock the zoom. A lane whose load settles after the camera passed its gate draws
   *   nothing until its programs for the current band are rehearsed (degrade, never stall). ?rehearse=0 = off (no gate).
   */
  rehearse: Object.freeze({ idleMs: 400, gapMs: 32, retryMs: 1500, retryMaxMs: 6000, box: 8, stallMs: 8000, mapReadyHoldMs: 1500,
    // D-177 (owner 2026-09-26, "overview first, live"; withdraws D-173's dive hold and MAP landing): Enter map lands in the
    // painted chart at the globe's own scale and stays there until the player zooms; the dive waits for nothing the landing
    // does not draw. The MAP / TRUE gates above hold a zoom-in (the scale pill's "detail N%") while the lanes load and
    // rehearse in the background. Leaving zooms out leaveMs into the chart (FAR) before the globe cross-fades in: the dive
    // in reverse.
    leaveMs: 350,
    // TRUE set = programs no lane can draw below trueStart (W1 fix pass 2 #4: rm-record resolves TRUE pages from
    // BANDS.pageResolve 600 and life-creature draws MAP herds from BANDS.herds 300 — both inside MAP, so they are MAP set)
    trueSet: Object.freeze(['rm-true']),
    order: Object.freeze(['rm-raw', 'rm-despeckle', 'rm-legalise', 'rm-pure', 'rm-chart', 'rm-map', 'rm-lowres-blit', 'life-scatter', 'life-stand', 'life-stand-merged', 'bases-sprite', 'bases-shield', 'bases-fx', 'bases-field', 'bases-dot',
      'minimap', 'minimap-dots', 'life-bird', 'life-particle', 'rm-record', 'life-creature', 'rm-true']) }),
  /**
   * Shader budget (fix iteration 2 P0, orchestrator decision "no synchronous program linking"): programs link in
   * the background (KHR_parallel_shader_compile), but a program that takes minutes to compile still leaves its layer
   * blank that long, and a driver can still stall on it. Per stage as core.program() hands it to the driver:
   * stageChars = preprocessed source length; inlinedChars = main() with every reachable call inlined (what the
   * compiler really builds; dead includes cost nothing). classifier = copies of GROUND's §3.2 classifier
   * (rmClassCore) inlined into one program: display programs only SAMPLE baked classes (0), a bake pass runs it at
   * most once. Caps ≈ 1.3× the largest program on 2026-09-24 (rm-map FS 60.6k chars, 95.6k inlined): a regression
   * guard — raising one needs a reason in docs/realm-map/lane-shell.md. Pinned by core.test.mjs.
   */
  shader: Object.freeze({ stageChars: 80000, inlinedChars: 128000, classifierDisplay: 0, classifierBake: 1 }),
  /** No KHR_parallel_shader_compile: a status query blocks until the link ends; defer it this long so the painted
   *  overview is on screen first, and once blocking queries have held the main thread noParallelSliceMs in a burst,
   *  wait 16 ms before the next (core.js settle). Background polls of pending programs run every pollMs. */
  noParallelDeferMs: 250, pollMs: 100, noParallelSliceMs: 8,
});

// ---- semantic classes (plan §3.2) and base-state flags (plan §6.1) ---------------------------------
export const CLASS = Object.freeze({
  DEEP: 0, SEA: 1, WATER: 2, SHORE: 3, WILD: 4, GROUND2: 5, FIELD: 6, ROCK: 7, SNOW: 8,
  SPECIAL: 9, ROAD: 10, TURF: 11, RING: 12, FOREST: 13,
});
export const FLAG = Object.freeze({
  occupied: 1, mine: 2, shield: 4, attackable: 8, filteredIn: 16, selected: 32, clan: 64, hovered: 128,
});
/** Base-state texture kind channel (r). */
export const KIND = Object.freeze({ none: 0, open: 1, otherRealm: 2 });
/** deeds.png values (1 px per deed). */
export const DEED_PX = Object.freeze({ thisRealm: 255, otherRealm: 96, none: 0 });

// ---- plots (plan §6.1) ----------------------------------------------------------------------------
/** Deed-local centre of every plot (tiles). */
export const PLOT_CENTRE = 49;
/**
 * The single source of plot geometry, uploaded to GLSL as uPlotByLevel[20].
 * claim = CAMPAIGN.claimTilesByKeep[L−1] (C2: the PvE level→claim table, labelled "estimated claim");
 * ring = 4 + floor(L/4); plotTiles = claim + 2·ring; wallTier = ceil(L/4); wallRings = CAMPAIGN_LAYOUT.wallRingsByKeep[L−1].
 */
export function plotRule(level) {
  const L = Math.min(20, Math.max(1, Math.round(level) || 1));
  const claim = CAMPAIGN.claimTilesByKeep[L - 1];
  const ring = 4 + Math.floor(L / 4);
  return { level: L, claim, ring, plotTiles: claim + 2 * ring, wallTier: Math.ceil(L / 4), wallRings: CAMPAIGN_LAYOUT.wallRingsByKeep[L - 1] };
}
/**
 * Plot offset (round 2, T3 "bases fit naturally, not a rigid lattice"). Each claimed plot sits at a deterministic,
 * hashed, whole-tile offset from its deed centre. VISUAL ONLY: the deed stays the unit of picking, selection,
 * occupancy and the base-state texture; everything that DRAWS or AIMS at a plot (GROUND plot SDF / lens / rim /
 * clearing / MAP overlay, BASES decor seats + keep + pick rects, LIFE scatter avoidance, SHELL tags / fly / card)
 * uses PLOT_CENTRE + offset instead of PLOT_CENTRE.
 * Bound (plan §3.2 lens rule, per axis): the plot box (claim/2 + ring + plotMargin), GROUND's island-rim gap and the
 * lens margin must stay inside the deed: |d| ≤ room(L) = 49 − lensMargin − rimGap − plotMargin − ring − ⌈claim/2⌉
 * (28 t at L1 … 17 t at L20; fix iteration 2: lensMargin 12 → 6, rimGap 8 → 2). A bigger kingdom therefore sits nearer its deed centre, and two neighbouring plot boxes
 * are always ≥ 2·(lensMargin + rimGap) = 16 t apart. GROUND: build the rim with axisMax − max(|dx|, |dy|).
 * Level is REQUIRED (the room shrinks as a kingdom grows): omitting it throws, never a silent L1.
 */
export const PLOT_OFFSET = Object.freeze({ lensMargin: LINES.lensMargin, rimGap: 2, plotMargin: 2, salt: 0x6a09e667 });
/** Offset budget per axis at a keep level, in whole tiles (plan §3.2; see PLOT_OFFSET). */
export function plotRoom(level) {
  const p = plotRule(level), o = PLOT_OFFSET;
  return Math.max(0, PLOT_CENTRE - o.lensMargin - o.rimGap - o.plotMargin - p.ring - Math.ceil(p.claim / 2));
}
/** uint32 hash of a deed (realm-grid col,row). GLSL twin: common.glsl.js plotHash (same ops, uint wrap). */
export function plotHash(deedX, deedY) {
  let h = (Math.imul(deedX | 0, 0x8da6b343) ^ Math.imul(deedY | 0, 0xd8163841) ^ PLOT_OFFSET.salt) >>> 0;
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d) >>> 0; h ^= h >>> 15; h = Math.imul(h, 0x846ca68b) >>> 0; h ^= h >>> 16;
  return h >>> 0;
}
// 16 hash bits → a whole-tile offset in [−room, room], rounded; integer-only so GLSL int maths matches exactly.
function plotAxis(v, room) { const t = 2 * v - 65535, m = Math.floor((Math.abs(t) * room + 32767) / 65535); return t < 0 ? -m : m; }
/** Whole-tile offset {dx, dy} of the plot centre from the deed centre (deed-local PLOT_CENTRE + dx). */
export function plotOffset(deedX, deedY, level) {
  if (typeof level !== 'number' || !Number.isFinite(level)) throw new TypeError('plotOffset(deedX, deedY, level): level is required');
  const room = plotRoom(level), h = plotHash(deedX, deedY);
  return { dx: plotAxis(h & 0xffff, room), dy: plotAxis(h >>> 16, room) };
}
/** The plot centre in realm deed units (fractional col,row; a centred plot is x + 0.5). For UI, camera and fly. */
export function plotCentre(deedX, deedY, level) {
  const o = plotOffset(deedX, deedY, level);
  return { x: deedX + (PLOT_CENTRE + o.dx) / TILES, y: deedY + (PLOT_CENTRE + o.dy) / TILES };
}
/** The keep footprint the live game uses (C3: v1 today). */
export const KEEP_FOOTPRINT = STRUCTURES.keep.footprint;
/** Tower art tier for a keep level (plan §6.3). */
export const towerTier = level => Math.min(4, Math.max(1, Math.ceil(level / 5)));

// ---- decor caps (plan §6.3): min(BUILD_COUNT_CAP_BY_KEEP, DECOR_CAP). Keys are game-v4 art dirs. ------
export const DECOR_CAP = Object.freeze({
  archer: 4, cannon: 4, mortar: 2, airdefence: 2, electrictower: 2, magetower: 2, lasertower: 2, dragonnest: 1,
  vault: 2, camp: 2, barracks: 1, mine: 4, goldforge: 1, clanhall: 1, heroaltar: 1, siegestool: 1, alchemylab: 1,
});
/** game-v4 art dir → BUILD_COUNT_CAP_BY_KEEP key (where the names differ). */
export const BUILD_KEY = Object.freeze({ archer: 'archertower', alchemylab: 'forge' }); // the alchemy lab is the runtime forge (Keep L2 gate)
/** Presentation cap for a decor building at a keep level (undefined build cap → decor cap only). */
export function decorCap(key, level) {
  const arr = BUILD_COUNT_CAP_BY_KEEP[BUILD_KEY[key] ?? key];
  const game = arr ? arr[Math.min(20, Math.max(1, level)) - 1] : Infinity;
  return Math.min(game, DECOR_CAP[key] ?? 0);
}
export { wallCapForKeepLevel };

// ---- realms ------------------------------------------------------------------------------------------
/** Realms with a realm map and dressed bases (D-164.7; stage B, D-170: all eight). Entering does NOT depend on it: has(id)
 *  comes from pack/realm/index.json. BASES dresses by decor.js KIT_DRESSING and decor.test.mjs dresses every realm listed
 *  here; PACK's base-atlas.mjs builds a realm's bases only once it is listed. contracts.test.mjs: every listed realm has a
 *  pack, and every packed realm is listed. */
export const REALMS_WITH_MAPS = Object.freeze(['crownlands', 'frostveil', 'sunscar', 'cinderfall', 'stormcairn', 'elderwood', 'thornwake', 'seeker-reach']);
/** Display names of every realm with a pack (stage B: Elderwood, Thornwake and Solana Reach, D-170; realm id
 *  'seeker-reach' is shown as Solana Reach). map.js falls back to the raw id, so a missing name shows 'seeker-reach'. */
export const REALM_NAMES = Object.freeze({
  crownlands: 'Crownlands', frostveil: 'Frostveil', sunscar: 'Sunscar', cinderfall: 'Cinderfall', stormcairn: 'Stormcairn',
  elderwood: 'Elderwood', thornwake: 'Thornwake', 'seeker-reach': 'Solana Reach',
});
/** Deed counts per realm that D2 checks against realm.json.grid.deeds (and contracts.test.mjs against deeds.png). */
export const DEED_COUNTS = Object.freeze({
  crownlands: 12958, frostveil: 13127, sunscar: 13931, cinderfall: 4237, stormcairn: 15268,
  elderwood: 13609, thornwake: 6706, 'seeker-reach': 5585,
});

// ---- texture units per program (plan §10.2) ----------------------------------------------------------
export const UNITS = Object.freeze({
  chart: Object.freeze({ chart8: 0, chart16: 1, deeds: 2, baseState: 3, fieldsA: 4 }),
  map: Object.freeze({ mapkit: 0, mapmask: 1, lattice: 2, fieldsA: 3, fieldsBC: 4, rivers: 5, tracks: 6, tone: 7, baseState: 8, plots: 9, plotRule: 10 }),
  true: Object.freeze({ groundA: 0, groundB: 1, decals: 2, groundmask: 3, records: 4, vclasses: 5, pageTable: 6, baseState: 7, fieldsA: 8 }),
  /** Sprite/base/shield programs: 0–7 own textures, then ground.bindClasses(p, CLASSES_FIRST) uses 8–13. */
  spriteOwnMax: 7, classesFirst: 8,
});
// ---- lane interfaces (plan §10.2) ----------------------------------------------------------------------------
/**
 * The Ground module's public members (createGround(core) → Ground). map.js reports a missing one in
 * stats().modules.groundApi (fail loud, never a silent stub).
 * classState() (fix iteration 2, QA GA2 #10) → { fields, lines, cfg, cols, rows } | null: GROUND's CPU class inputs for
 * classify.classAt(fields, lines, state, [x, y], cfg) — null until they are loaded. It is the FORMAL way another lane
 * reads terrain classes (BASES' kingdom paths); debug() is QA-only and may change shape without notice.
 * W1 (integrate, GROUND's request): rehearse(prog, view, rv) (GPU_SAFE.rehearse), mapReady(view) (the FAR→MAP hold) and
 * passes(view) → { chart, map, true } (exact after update(view); SHELL picks the ground scale from it) are part of it:
 * SHELL still degrades when one is absent (the stub ground), but a real GROUND without one is reported, not silent.
 */
export const GROUND_API = Object.freeze(['ready', 'load', 'setBaseState', 'setOccupancy', 'update', 'draw', 'bindClasses', 'stats', 'dispose', 'classState',
  'rehearse', 'mapReady', 'passes']);

/** Uniform block binding point of the RealmView UBO (std140). */
export const UBO_VIEW = 0;

// ---- dev page --------------------------------------------------------------------------------------
/** realm-dev.html query parameters (plan §10.2). */
export const DEV_PARAMS = Object.freeze(['realm', 'x', 'y', 's', 'sel', 'rm', 'stats', 'freeze', 'decode', 'verify', 'ladder', 'debugPages', 'pack', 'gpx', 'gpusafe', 'gpuwd', 'rehearse', 'marks']);
