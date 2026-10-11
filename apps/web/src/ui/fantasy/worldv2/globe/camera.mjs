// The flat globe's camera: the concept's camera block (8acdf059 src/main.js "math" and "camera" sections, grab(),
// fitAlt(), homeFrame(), the camera part of frame()), as native ports it in GlobeCameraV2.kt. The flat globe has no
// relief (heightAt = 0) and never tilts (TILT_MAX = 0, owner 2026-09-24). Every screen value is CSS px. Matrices are
// Float32Array exactly as the concept stores them, so camera.test.mjs checks this file against the goldens native's
// GlobeCameraGoldenTest reads (the concept's own numbers, cut from main.js at the pin by tools/globe2-pin.mjs).
import { P, PHASE_E } from './pin.mjs';

export const RAD = Math.PI / 180;
// ---------- math (main.js) ----------
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], mulS = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const len = a => Math.hypot(a[0], a[1], a[2]), norm = a => mulS(a, 1 / len(a));
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x)), mix = (a, b, t) => a + (b - a) * t;
export const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export function rotate(v, axis, ang) { const c = Math.cos(ang), s = Math.sin(ang), k = axis; const kv = cross(k, v), kd = dot(k, v); return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)]; }
export function slerp(a, b, t) { const d = clamp(dot(a, b), -1, 1), w = Math.acos(d); if (w < 1e-5) return b.slice(); const s = Math.sin(w); return add(mulS(a, Math.sin((1 - t) * w) / s), mulS(b, Math.sin(t * w) / s)); }
export function persp(fovy, asp, n, f) { const t = 1 / Math.tan(fovy / 2), nf = 1 / (n - f); return new Float32Array([t / asp, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) * nf, -1, 0, 0, 2 * f * n * nf, 0]); }
export function lookAt(e, c, up) { const z = norm(sub(e, c)), x = norm(cross(up, z)), y = cross(z, x); return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, e), -dot(y, e), -dot(z, e), 1]); }
export function mul4(a, b) { const o = new Float32Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
export function inv4(m) { const a = m, o = new Float32Array(16);
  const b00 = a[0] * a[5] - a[1] * a[4], b01 = a[0] * a[6] - a[2] * a[4], b02 = a[0] * a[7] - a[3] * a[4], b03 = a[1] * a[6] - a[2] * a[5], b04 = a[1] * a[7] - a[3] * a[5], b05 = a[2] * a[7] - a[3] * a[6], b06 = a[8] * a[13] - a[9] * a[12], b07 = a[8] * a[14] - a[10] * a[12], b08 = a[8] * a[15] - a[11] * a[12], b09 = a[9] * a[14] - a[10] * a[13], b10 = a[9] * a[15] - a[11] * a[13], b11 = a[10] * a[15] - a[11] * a[14];
  const det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06);
  o[0] = (a[5] * b11 - a[6] * b10 + a[7] * b09) * det; o[1] = (a[2] * b10 - a[1] * b11 - a[3] * b09) * det; o[2] = (a[13] * b05 - a[14] * b04 + a[15] * b03) * det; o[3] = (a[10] * b04 - a[9] * b05 - a[11] * b03) * det;
  o[4] = (a[6] * b08 - a[4] * b11 - a[7] * b07) * det; o[5] = (a[0] * b11 - a[2] * b08 + a[3] * b07) * det; o[6] = (a[14] * b02 - a[12] * b05 - a[15] * b01) * det; o[7] = (a[8] * b05 - a[10] * b02 + a[11] * b01) * det;
  o[8] = (a[4] * b10 - a[5] * b08 + a[7] * b06) * det; o[9] = (a[1] * b08 - a[0] * b10 - a[3] * b06) * det; o[10] = (a[12] * b04 - a[13] * b02 + a[15] * b00) * det; o[11] = (a[9] * b02 - a[8] * b04 - a[11] * b00) * det;
  o[12] = (a[5] * b07 - a[4] * b09 - a[6] * b06) * det; o[13] = (a[0] * b09 - a[1] * b07 + a[2] * b06) * det; o[14] = (a[13] * b01 - a[12] * b03 - a[14] * b00) * det; o[15] = (a[8] * b03 - a[9] * b01 + a[10] * b00) * det; return o; }
export const lonlatOf = d => ({ lon: Math.atan2(d[0], d[2]) / RAD, lat: Math.asin(clamp(d[1], -1, 1)) / RAD });
export const dirOf = (lon, lat) => [Math.cos(lat * RAD) * Math.sin(lon * RAD), Math.sin(lat * RAD), Math.cos(lat * RAD) * Math.cos(lon * RAD)];
export const EASE = { inout: e => e < .5 ? 4 * e * e * e : 1 - Math.pow(-2 * e + 2, 3) / 2, out: e => 1 - Math.pow(1 - e, 4), in: e => e * e * e };

export const altOf = z => P.ALT_MAX * Math.pow(P.ALT_MIN / P.ALT_MAX, z);
export const zOf = alt => Math.log(alt / P.ALT_MAX) / Math.log(P.ALT_MIN / P.ALT_MAX);
/** Vertical FOV: 36° in landscape; in portrait it widens so the horizontal view stays ~36°, capped at 68°. */
export const fovY = (W, H) => W >= H ? P.FOV_RAD : 2 * Math.atan(Math.min(Math.tan(P.FOV_PORTRAIT_CAP_DEG * RAD), Math.tan(P.FOV_RAD / 2) * H / W));

/**
 * One camera (main.js cam, zLo, lens, view). `phaseE`: the camera may come closer over the Phase E art (minAltAt);
 * off (RG-3) the atlas floor holds everywhere.
 */
export function createCamera() {
  const cam = {
    t: dirOf(P.START_LON, P.START_LAT), z: P.START_Z, zT: P.START_Z, vel: null, anim: null, anchor: null,
    zLo: 0, lens: { x: 0, y: 0, tx: 0, ty: 0 }, view: null, phaseE: false, reducedMotion: false,
  };

  cam.minAltAt = t => {
    if (!cam.phaseE) return P.ALT_MIN_ATLAS;
    for (const A of PHASE_E) { const ang = Math.acos(clamp(dot(norm(t), dirOf(A.lon, A.lat)), -1, 1)) / RAD; if (ang < A.wDeg * 0.9) return mix(P.ALT_MIN, P.ALT_MIN_ATLAS, smooth(A.wDeg * 0.45, A.wDeg * 0.9, ang)); }
    return P.ALT_MIN_ATLAS;
  };

  /** main.js computeView(W, H) (heightAt = 0, tilt 0), stored as cam.view. */
  cam.computeView = (W, H) => {
    const alt = altOf(cam.z), tilt = 0, t = norm(cam.t);
    const east = norm(cross([0, 1, 0], t)), north = cross(t, east);
    const { lon, lat } = lonlatOf(t);
    const Sp = mulS(t, 1);
    let eye = add(Sp, mulS(add(mulS(t, Math.cos(tilt)), mulS(north, -Math.sin(tilt))), alt));
    const clear = 1 + 0.004;
    if (len(eye) < clear) eye = mulS(norm(eye), clear);
    const upV = add(mulS(north, Math.cos(tilt)), mulS(t, Math.sin(tilt)));
    const near = Math.max(P.NEAR_MIN, alt * P.NEAR_K), far = len(eye) + P.FAR_PAD;
    const fy = fovY(W, H), Pm = persp(fy, W / H, near, far); Pm[8] -= cam.lens.x; Pm[9] -= cam.lens.y;
    const Vw = lookAt(eye, Sp, upV), VP = mul4(Pm, Vw);
    const fwd = norm(sub(Sp, eye)), right = norm(cross(fwd, upV)), camUp = cross(right, fwd);
    return (cam.view = { alt, tilt, eye, VP, inv: inv4(VP), W, H, t, lon, lat, pxPerRad: H / 2 / Math.tan(fy / 2), right, up: camUp });
  };

  /** main.js projectDir(d, lift): CSS px or null (behind the limb, or more than 40 px off screen). */
  cam.projectDir = (d, lift = 0) => {
    const view = cam.view, p = mulS(d, 1 + lift), m = view.VP;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    if (w <= 0) return null; const cn = norm(view.eye); if (dot(d, cn) < 1 / len(view.eye) - 0.002) return null;
    const sx = (x / w * 0.5 + 0.5) * view.W, sy = (0.5 - y / w * 0.5) * view.H; if (sx < -40 || sy < -40 || sx > view.W + 40 || sy > view.H + 40) return null; return [sx, sy];
  };
  cam.rayAt = (px, py) => { const view = cam.view, x = px / view.W * 2 - 1, y = 1 - py / view.H * 2, m = view.inv;
    const tp = z => { const v = [x, y, z, 1], o = [0, 0, 0, 0]; for (let r = 0; r < 4; r++) o[r] = m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3]; return [o[0] / o[3], o[1] / o[3], o[2] / o[3]]; };
    const a = tp(-1), b = tp(1); return { o: a, d: norm(sub(b, a)) }; };
  cam.hitSphere = (px, py, R = 1) => { const { o, d } = cam.rayAt(px, py); const b = dot(o, d), c = dot(o, o) - R * R, disc = b * b - c; if (disc < 0) return null; const t = -b - Math.sqrt(disc); if (t < 0) return null; return norm(add(o, mulS(d, t))); };

  /** main.js grab(from, to): an arcball step (≤ GRAB_MAX rad) returning axis·angle, or a screen-rate pan (null). */
  cam.grab = (from, to) => {
    const p0 = cam.hitSphere(from[0], from[1]), p1 = cam.hitSphere(to[0], to[1]);
    if (p0 && p1) { const ax = cross(p1, p0), s = len(ax); if (s < 1e-9) return null; const ang = Math.min(Math.atan2(s, dot(p1, p0)), P.GRAB_MAX); const axis = mulS(ax, 1 / s); cam.t = norm(rotate(cam.t, axis, ang)); return mulS(axis, ang); }
    const view = cam.view, k = 2 * altOf(cam.z) * Math.tan(fovY(view.W, view.H) / 2) / view.H; const { lon, lat } = lonlatOf(norm(cam.t));
    cam.t = dirOf(lon - (to[0] - from[0]) * k / RAD / Math.max(0.3, Math.cos(lat * RAD)), clamp(lat + (to[1] - from[1]) * k / RAD, -85, 85)); return null;
  };

  /** main.js flyTo(dir, z, dur, ease); reduced motion cuts (1 ms). Returns the flight's duration. */
  cam.flyTo = (dir, z, now, dur, ease = 'inout') => {
    const ang = Math.acos(clamp(dot(norm(cam.t), dir), -1, 1)); cam.vel = null; cam.anchor = null;
    if (cam.reducedMotion) dur = 1;
    cam.anim = { t0: norm(cam.t), t1: dir, z0: cam.z, z1: z, start: now, dur: dur ?? clamp(P.FLIGHT_MS + ang * P.FLIGHT_PER_RAD, P.FLIGHT_MS, P.FLIGHT_MAX_MS), arc: clamp(ang / P.ARC_DIV, 0, P.ARC_MAX), ease };
    return cam.anim.dur;
  };

  /** The camera part of main.js frame(): flight, else inertia and the eased zoom toward the anchor; then the zoom floor
   *  zMax, the latitude clamp and the lens ease. dt in seconds (≤ DT_MAX). Returns true while anything moved. */
  cam.step = (now, dt, zMax) => {
    let moved = false;
    if (cam.anim) { const A = cam.anim, e0 = clamp((now - A.start) / A.dur, 0, 1), e = EASE[A.ease ?? 'inout'](e0);
      cam.t = norm(slerp(A.t0, A.t1, e)); cam.z = clamp(mix(A.z0, A.z1, e) - A.arc * Math.sin(Math.PI * e), cam.zLo, 1); cam.zT = cam.z; if (e0 >= 1) cam.anim = null; moved = true; }
    else {
      if (cam.vel) { const w = len(cam.vel); cam.t = norm(rotate(cam.t, mulS(cam.vel, 1 / w), w * dt)); cam.vel = mulS(cam.vel, Math.exp(-dt * P.INERTIA_DECAY)); if (len(cam.vel) < P.INERTIA_STOP) cam.vel = null; moved = true; }
      if (Math.abs(cam.zT - cam.z) > 1e-4) { const nz = mix(cam.z, cam.zT, 1 - Math.exp(-dt * P.ZOOM_EASE)); if (cam.anchor) { const f = 1 - altOf(nz) / altOf(cam.z); if (f > 0) cam.t = norm(slerp(norm(cam.t), cam.anchor, f)); } cam.z = nz; moved = true; }
    }
    if (cam.zT > zMax) cam.zT = zMax;
    if (!cam.anim && cam.z > zMax) { cam.z = Math.max(zMax, cam.z - 0.02); moved = true; }
    const { lon, lat } = lonlatOf(norm(cam.t)); if (Math.abs(lat) > P.LAT_MAX) cam.t = dirOf(lon, clamp(lat, -P.LAT_MAX, P.LAT_MAX));
    const L = cam.lens, e = 1 - Math.exp(-dt * P.LENS_EASE);
    if (L.x !== L.tx || L.y !== L.ty) { L.x = Math.abs(L.tx - L.x) < 1e-4 ? L.tx : mix(L.x, L.tx, e); L.y = Math.abs(L.ty - L.y) < 1e-4 ? L.ty : mix(L.y, L.ty, e); moved = true; }
    return moved;
  };

  /** main.js fitAlt(pts, t, hw, hh, lo): the lowest altitude (≥ lo) keeping every point inside ±hw × ±hh px of the
   *  principal point, by bisection; above the zoom-out floor it answers the floor. */
  cam.fitAlt = (pts, t, hw, hh, lo, W, H) => { const f = H / 2 / Math.tan(fovY(W, H) / 2), E = norm(cross([0, 1, 0], t)), N = cross(t, E);
    const fits = alt => { const D = 1 + alt; for (const p of pts) { const z = dot(p, t); if (z < 1 / D + 0.02) return false; const dz = D - z; if (Math.abs(f * dot(p, E) / dz) > hw || Math.abs(f * dot(p, N) / dz) > hh) return false; } return true; };
    if (fits(lo)) return lo; let hi = altOf(cam.zLo) * 0.97; if (!fits(hi)) return hi;
    for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (fits(m)) hi = m; else lo = m; } return hi; };
  return cam;
}

/**
 * main.js homeFrame(): the whole globe, as large as fits between the header's bottom (top) and the bottom margin,
 * clear of the obstacles ({x0, y0, x1, y1} CSS px). Scans the radius down; per radius each obstacle forbids a band of
 * centre heights. Returns { alt, cy }.
 */
export function homeFrame(W, H, top, obstacles) { const m = 10, cx = W / 2, y0 = top + m, y1 = H - m, yc = (y0 + y1) / 2;
  const ob = obstacles.filter(b => b.x1 > b.x0);
  for (let r = Math.min(W / 2 - m, (y1 - y0) / 2.09); r > 40; r -= 2) { const lo = y0 + r * 1.03, hi = y1 - r * 1.06, bands = [];
    for (const o of ob) { const dx = Math.max(o.x0 - cx, 0, cx - o.x1); if (dx < r + m) { const s = Math.sqrt((r + m) ** 2 - dx * dx); bands.push([o.y0 - s, o.y1 + s]); } }
    const ok = c => c >= lo - 1e-6 && c <= hi + 1e-6 && bands.every(([a, b]) => c <= a + 1e-6 || c >= b - 1e-6);
    const c = [clamp(yc, lo, hi), ...bands.flat()].filter(ok).sort((a, b) => Math.abs(a - yc) - Math.abs(b - yc))[0];
    if (c != null) { const f = H / 2 / Math.tan(fovY(W, H) / 2); return { alt: Math.sqrt(1 + (f / r) ** 2) - 1, cy: c }; } }
  return { alt: P.ALT_MAX, cy: H / 2 }; }

/** The sphere's screen radius (CSS px) at altitude alt: the inverse of homeFrame's alt(r). */
export const sphereRadiusPx = (alt, W, H) => H / 2 / Math.tan(fovY(W, H) / 2) / Math.sqrt((1 + alt) ** 2 - 1);
