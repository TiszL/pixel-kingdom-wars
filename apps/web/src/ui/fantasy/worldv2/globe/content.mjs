// The globe's content transforms (no GL, no fetch): pure functions over decoded pixels, ported from native
// GlobeContent.kt and PhaseEIslandLayer.kt so the web builds the same texels from the same pack bytes.
import { PHASE_E, ISLE } from './pin.mjs';
import { RAD, clamp, cross, dirOf, dot } from './camera.mjs';

/** IEEE half-float bits of v, round to nearest even (native Half.bits). */
export function halfBits(v) {
  const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer); f32[0] = v;
  const f = u32[0], sign = (f >>> 16) & 0x8000, exp = ((f >>> 23) & 0xff) - 127 + 15; let mant = f & 0x7fffff;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant |= 0x800000; const shift = 14 - exp; let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1), halfway = 1 << (shift - 1);
    if (rem > halfway || (rem === halfway && (h & 1) === 1)) h++;
    return sign | h;
  }
  if (exp >= 31) return sign | 0x7c00;
  let h = (exp << 10) | (mant >>> 13); const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1) === 1)) h++;
  return sign | h;
}
/** The float a half's bits encode (tests). */
export function halfToFloat(bits) {
  const s = bits & 0x8000 ? -1 : 1, e = (bits >>> 10) & 0x1f, m = bits & 0x3ff;
  if (e === 0) return s * m / 1024 / 16384;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

/**
 * A selection field's 8-bit RGB texels (art-prep/globe-v2 sel-*.png, globe-v2.json formats.sel) as RG16F: R16F = the
 * half whose bits are (R << 8) | G (signed outline distance), G16F = B / 128 (its rate). rgba: decoded RGBA8 pixels.
 */
export function fieldTexels(rgba, n) {
  const out = new Uint16Array(n * 2), rates = new Uint16Array(256);
  for (let b = 0; b < 256; b++) rates[b] = halfBits(b / 128);
  for (let i = 0; i < n; i++) { out[i * 2] = (rgba[i * 4] << 8) | rgba[i * 4 + 1]; out[i * 2 + 1] = rates[rgba[i * 4 + 2]]; }
  return out;
}

/**
 * One exploration chain's art layer (native GlobeContent.islands): the colour where the chain's mask says land
 * (mask R = 1), else transparent, premultiplied (land texels opaque), box-reduced by ISLE.DOWNSCALE (the v2 camera
 * never comes closer than the atlas floor, where a 320 px cell is already minified about 2×). The full-resolution land
 * bits stay for picking (a hit counts only on a land texel of the precise mask). color, mask: ATLAS² RGBA8.
 */
export function chainLayer(color, mask, size = ISLE.ATLAS, k = ISLE.DOWNSCALE) {
  const land = new Uint8Array(size * size), half = size / k, out = new Uint8Array(half * half * 4);
  for (let i = 0; i < size * size; i++) if (mask[i * 4] === 1) land[i] = 1;
  for (let y = 0; y < half; y++) for (let x = 0; x < half; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) { const i = (y * k + yy) * size + x * k + xx; if (!land[i]) continue; r += color[i * 4]; g += color[i * 4 + 1]; b += color[i * 4 + 2]; a += 255; }
    const n = k * k, o = (y * half + x) * 4; // (sum + n/2) / n: native's box rounding, on premultiplied texels
    out[o] = (r + (n >> 1)) / n | 0; out[o + 1] = (g + (n >> 1)) / n | 0; out[o + 2] = (b + (n >> 1)) / n | 0; out[o + 3] = (a + (n >> 1)) / n | 0;
  }
  return { land, layer: out, size: half };
}

const FX = { fall: [2, 0xd4f2ed], beacon: [1, 0], vent: [3, 0xffc18a], spore: [4, 0xd6e9bb] };
const SHORE_RGB = 0xbbd8d1;
/**
 * The islands' animated points for 'globe-fx' (native GlobeContent.effects over the same sites): per island its shore
 * sparkles (kind 0, u = the point's index) then its authored feature pixels (beacon 1, fall 2, vent 3, spore 4), with
 * the legacy colours. anchors: runtime/island-effects.mjs effectAnchors (lon, lat in radians), one per island in the
 * host chains' order.
 */
export function fxPoints(anchors) {
  const dirs = [], info = [], colors = [];
  const point = (lonRad, latRad, kind, u, v, island, rgb) => {
    dirs.push(...dirOf(lonRad / RAD, latRad / RAD)); info.push(kind, u, v, island); colors.push(rgb >>> 16 & 255, rgb >>> 8 & 255, rgb & 255, 255);
  };
  anchors.forEach((site, island) => {
    site.shore.forEach((p, n) => point(p.lon, p.lat, 0, n, 0, island, SHORE_RGB));
    for (const f of site.features) {
      const spec = FX[f.kind]; if (!spec) throw Error(`unknown island effect ${f.kind}`);
      const rgb = f.kind === 'beacon' ? parseInt((f.tint ?? (f.group === 'aurora' ? '#d9ecff' : '#fff0bd')).replace('#', ''), 16) : spec[1];
      for (const q of f.pixels) point(q.lon, q.lat, spec[0], q.u ?? 0, q.v ?? 0, island, rgb);
    }
  });
  return { count: info.length / 4, dirs: new Float32Array(dirs), info: new Int32Array(info), colors: new Uint8Array(colors) };
}

// ---------- Phase E islands (native PhaseEIslandLayer: resampled from the pack's close-range art) ----------
export const PE = Object.freeze({ LAYER: 1024, MARGIN: 0.06, NEAR_STEP: 0.018, DZ_MIN: 0.9, SHALLOWS: 0.45, TEAL: [58, 170, 190], ART_CAP: 1.5 });

/** The art frame's axes (composite.mjs, rot 0): east0 = (cos lon, 0, −sin lon), north = c × east. */
export function axes(spec) { const c = dirOf(spec.lon, spec.lat), e = [Math.cos(spec.lon * RAD), 0, -Math.sin(spec.lon * RAD)]; return { c, e, n: cross(c, e) }; }

/** The island's lon/lat box (rx, ry degrees) holding its art frame plus the 6 % shallows margin. */
export function phaseEBox(spec) {
  const { c, e, n } = axes(spec);
  const hu = spec.wDeg / 2 + PE.MARGIN * spec.wDeg, hv = spec.wDeg * spec.aspect / 2 + PE.MARGIN * spec.wDeg;
  let rx = 0, ry = 0; const steps = 128;
  for (let s = 0; s <= steps; s++) for (let side = 0; side < 4; side++) {
    const k = -1 + 2 * s / steps, u = side < 2 ? (side === 0 ? -hu : hu) : k * hu, v = side < 2 ? k * hv : (side === 2 ? -hv : hv);
    const tu = Math.tan(u * RAD), tv = Math.tan(v * RAD);
    const d0 = [c[0] + e[0] * tu + n[0] * tv, c[1] + e[1] * tu + n[1] * tv, c[2] + e[2] * tu + n[2] * tv], l = Math.hypot(...d0), d = d0.map(x => x / l);
    const lon = Math.atan2(d[0], d[2]) / RAD, lat = Math.asin(clamp(d[1], -1, 1)) / RAD;
    rx = Math.max(rx, Math.abs(((lon - spec.lon + 540) % 360) - 180)); ry = Math.max(ry, Math.abs(lat - spec.lat));
  }
  return [rx * 1.01, ry * 1.01];
}

/** 'globe-isles' instance records (lon, lat, rx, ry of the box; layer, 0, 0, 0), one per island in PHASE_E order. */
export function phaseERecords() {
  const d = new Float32Array(PHASE_E.length * 8);
  PHASE_E.forEach((s, i) => { const b = phaseEBox(s); d.set([s.lon, s.lat, b[0], b[1], i, 0, 0, 0], i * 8); });
  return d;
}

/**
 * One island's size² premultiplied layer over its box (native PhaseEIslandLayer.resample): composite.mjs islandAt +
 * withIsland over transparent sea, the art's alpha-weighted bilinear colour inside its rect and a 45 % teal shallows
 * halo where the art is under half opaque near land. rgba: the straight-alpha art (w × h). Rows [j0, j1) only, so the
 * caller can spread the work over idle frames; returns out.
 */
export function resamplePhaseE(spec, rgba, w, h, size, out, j0 = 0, j1 = size) {
  const b = phaseEBox(spec), { c, e, n } = axes(spec);
  const artPerDeg = w / spec.wDeg, outPerDeg = Math.max(size / (2 * b[1]), size / (2 * b[0] * Math.cos(spec.lat * RAD)));
  const k = Math.max(Math.max(1, Math.floor(artPerDeg / outPerDeg)), Math.ceil(Math.max(w, h) / (PE.ART_CAP * size)));
  const art = reduced(rgba, w, h, k), kw = art.w, kh = art.h, hDeg = spec.wDeg * spec.aspect, margin = kw * PE.MARGIN;
  const step = Math.max(1, Math.round(kw * PE.NEAR_STEP)), px = [0, 0, 0, 0];
  for (let j = j0; j < j1; j++) for (let i = 0; i < size; i++) {
    const lon = spec.lon + b[0] * ((i + 0.5) / (size / 2) - 1), lat = spec.lat + b[1] * (1 - (j + 0.5) / (size / 2));
    const d = dirOf(lon, lat), dz = dot(d, c); if (dz < PE.DZ_MIN) continue;
    const u = Math.atan(dot(d, e) / dz) / RAD, v = Math.atan(dot(d, n) / dz) / RAD;
    const fx = (u / spec.wDeg + 0.5) * kw, fy = (0.5 - v / hDeg) * kh;
    if (fx < -margin || fy < -margin || fx > kw + margin || fy > kh + margin) continue;
    let near = 0; const cx = Math.floor(fx), cy = Math.floor(fy);
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = cx + dx * step, yy = cy + dy * step; if (xx >= 0 && yy >= 0 && xx < kw && yy < kh && art.land(yy * kw + xx)) near++; }
    if (fx >= 0 && fy >= 0 && fx < kw && fy < kh) {
      const bx = clamp(fx - 0.5, 0, kw - 1.001), by = clamp(fy - 0.5, 0, kh - 1.001), xa = Math.floor(bx), ya = Math.floor(by), tx = bx - xa, ty = by - ya;
      const t00 = ya * kw + xa, t10 = ya * kw + Math.min(kw - 1, xa + 1), t01 = Math.min(kh - 1, ya + 1) * kw + xa, t11 = Math.min(kh - 1, ya + 1) * kw + Math.min(kw - 1, xa + 1);
      for (let ch = 0; ch < 4; ch++) px[ch] = (art.pm(t00, ch) * (1 - tx) + art.pm(t10, ch) * tx) * (1 - ty) + (art.pm(t01, ch) * (1 - tx) + art.pm(t11, ch) * tx) * ty;
    } else px.fill(0);
    const a = px[3] / 255, hk = near > 0 && a < 0.5 ? PE.SHALLOWS * near / 9 : 0, alpha = hk + a - hk * a;
    if (alpha <= 0) continue;
    const o = (j * size + i) * 4;
    out[o] = clamp(Math.round(PE.TEAL[0] * hk * (1 - a) + px[0]), 0, 255); out[o + 1] = clamp(Math.round(PE.TEAL[1] * hk * (1 - a) + px[1]), 0, 255);
    out[o + 2] = clamp(Math.round(PE.TEAL[2] * hk * (1 - a) + px[2]), 0, 255); out[o + 3] = clamp(Math.round(alpha * 255), 0, 255);
  }
  return out;
}

/** The art at 1/k as premultiplied 8-bit texels (native PhaseEIslandLayer.Reduced). */
function reduced(rgba, sw, sh, k) {
  const w = Math.floor(sw / k), h = Math.floor(sh / k); let box = null;
  if (k > 1) { box = new Uint8Array(w * h * 4); const nk = k * k;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let r = 0, g = 0, bl = 0, a = 0;
      for (let yy = 0; yy < k; yy++) for (let xx = 0; xx < k; xx++) { const i = ((y * k + yy) * sw + x * k + xx) * 4, al = rgba[i + 3]; r += rgba[i] * al; g += rgba[i + 1] * al; bl += rgba[i + 2] * al; a += al; }
      const o = (y * w + x) * 4; box[o] = (r + (255 * nk >> 1)) / (255 * nk) | 0; box[o + 1] = (g + (255 * nk >> 1)) / (255 * nk) | 0; box[o + 2] = (bl + (255 * nk >> 1)) / (255 * nk) | 0; box[o + 3] = (a + (nk >> 1)) / nk | 0; } }
  const pm = (t, ch) => { if (box) return box[t * 4 + ch]; const a = rgba[t * 4 + 3]; return ch === 3 ? a : (rgba[t * 4 + ch] * a + 127) / 255 | 0; };
  const land = t => { const al = pm(t, 3); if (al <= 128) return false; const sr = pm(t, 0) * 255 / al, sg = pm(t, 1) * 255 / al, sb = pm(t, 2) * 255 / al; return !(sg > 110 && sb > 130 && sr < 110 && sb - sr > 60); };
  return { w, h, pm, land };
}
