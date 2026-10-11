// Presentation constants of the concept globe at the world pin 02e9da84 (the JS port follows 8acdf059, which changes
// none of them): native's generated GlobeV2Pin.kt (tools/globe2-pin.mjs, cut from src/main.js, src/geo.js REALMS /
// NEW_ISLANDS / DIVINE / ISLAND_ART and src/landmarks.js accents). Camera, gesture and label numbers only: no game
// number lives here. pin.test.mjs compares every value with the golden export native's GlobeV2Pin.kt was generated
// from (goldens/camera.json constants), so web and native cannot drift apart silently.
export const PIN = '02e9da8414156b9e0000df1653de6273b196cca6';
export const GEO_W = 768, GEO_H = 384;

export const P = Object.freeze({
  ALT_MAX: 2.7, ALT_MIN: 0.1, FOV_RAD: 0.6283185307179586, ALT_MIN_ATLAS: 0.3, FOV_PORTRAIT_CAP_DEG: 34,
  START_LON: 8, START_LAT: 22, START_Z: 0.08, NEAR_MIN: 0.0006, NEAR_K: 0.08, FAR_PAD: 1.3,
  FLIGHT_MS: 700, FLIGHT_PER_RAD: 700, FLIGHT_MAX_MS: 1800, ARC_DIV: 1.4, ARC_MAX: 0.35,
  DT_MAX: 0.05, INERTIA_DECAY: 4.2, INERTIA_STOP: 0.01, ZOOM_EASE: 10, DIVE_ALT_K: 0.8, LAT_MAX: 85, DIVE_ALT: 0.3,
  SEL_FADE_S: 0.32, LENS_EASE: 7, FX_BUSY_MS: 1600, CLOUD_ROT_PER_S: 0.004, CLOUD_ALT0: 0.25, CLOUD_ALT1: 0.8,
  SUN_T: 0.82, SUN_EAST: -0.4, SUN_NORTH: 0.42, NIGHT_SUN_T: 0.2, NIGHT_SUN_EAST: 0.98,
  DOUBLE_TAP_MS: 300, DOUBLE_TAP_PX: 30, DOUBLE_TAP_DZ: 0.2, DOUBLE_TAP_MS2: 600, SLOP_PX: 6, SAMPLE_MS: 90,
  GRAB_MAX: 0.3, TAP_MS: 400, VEL_MIN: 0.05, DPR_CAP: 2, ENTRANCE_K: 0.6, ENTRANCE_LEAD_MS: 300, FOCUS_PAD: 36,
  DIVE_FLIGHT_MS: 700, DIVE_FLIGHT_ALT: 0.5, DIVE_FAR_RAD: 0.35, DIVE_FAIL_BLOCK_MS: 5000, LEAVE_BLOCK_MS: 1500,
  LABEL_ALT: 0.35, LABEL_LIMB: 0.16, LABEL_LIFT: 0.03, REALM_FOCUS_ALT: 0.3, CLOUD_SHELL: 1.034,
});

/** geo.js REALMS order: the frozen geography's region index (the web REGIONS order too). */
export const REALMS = Object.freeze([
  { id: 'frostveil', name: 'Frostveil', lon: -23, lat: 53, accent: 0x8fe3ff },
  { id: 'elderwood', name: 'Elderwood', lon: -43, lat: 1, accent: 0x86ec6c },
  { id: 'sunscar', name: 'Sunscar', lon: 43, lat: -26, accent: 0xffbf4d },
  { id: 'crownlands', name: 'Crownlands', lon: 26, lat: 23, accent: 0xffd65c },
  { id: 'seeker-reach', name: 'Solana Reach', lon: -115, lat: 38, accent: 0xc99dff },
  { id: 'stormcairn', name: 'Stormcairn', lon: 157.3, lat: 23.8, accent: 0x9dbcff },
  { id: 'thornwake', name: 'Thornwake', lon: -142.2, lat: -17.8, accent: 0xc6e65a },
  { id: 'cinderfall', name: 'Cinderfall', lon: -152.4, lat: -57.3, accent: 0xff8a4c },
]);

/** Seeker, Solana, Divine (geo.js NEW_ISLANDS + DIVINE and their ISLAND_ART frames). rx, ry: the D-165 tap ellipse
 *  (degrees); wDeg, aspect: the art frame. Drawn, picked and framed only with the phaseEIslands option (RG-3). */
export const PHASE_E = Object.freeze([
  { id: 'seeker-island', name: 'Seeker Island', lon: -83.25, lat: 32.25, rx: 7.47, ry: 9.96, accent: 0xffb066, wDeg: 12.66, aspect: 1.3683342495876856 },
  { id: 'solana-island', name: 'Solana Island', lon: -141, lat: 38.25, rx: 6.24, ry: 6.2, accent: 0x5ff2c8, wDeg: 9.36, aspect: 1.0012771392081736 },
  { id: 'divine-isle', name: 'Divine Isle', lon: 94, lat: 4, rx: 6.5, ry: 4.9, accent: 0xffd97a, wDeg: 13, aspect: 0.701171875 },
]);

/** The exploration islands' shared art layout (runtime/island-shapes.mjs ISLAND_CELL / ISLAND_ATLAS / ISLAND_EXTENT,
 *  native islands.json "shape"): 3 cells a row in a chain's atlas, each box extent × (rx, ry). */
export const ISLE = Object.freeze({ CELL: 320, ATLAS: 1024, EXTENT: 1.12, DOWNSCALE: 2, MAX: 32 });
