// Realm-map camera (plan §2.1, §2.3, §6.6, §8.2). Deed space: x, y = the deed-space point at the screen
// centre, s = CSS px per deed, d = s·dpr = device px per deed (every art decision and every fly/rest
// target is in d, so phone and desktop land in the same band).
//  - bands(d): the band, the active cross-fade's weight and per-layer weights (unit-tested).
//  - rest rule: a gesture (or its inertia) that ends with d inside BANDS.rest eases over 250 ms to the
//    nearer band edge (nearer in log d, i.e. in zoom steps); fly targets pass through the same rule.
//  - pixel snap: when zooming stops at d ≥ 3136, s eases to a whole number of device px per art px and
//    the camera snaps to the device-pixel grid.
// createCamera() is pure (no DOM; `now` injectable) so camera.test.mjs drives it with a fake clock.
// bindGestures() wires pointer/wheel input to it and is the only DOM code here.
import { BANDS, DEED_ART } from './contracts.mjs';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lnT = (d, a, b) => clamp((Math.log(d) - Math.log(a)) / (Math.log(b) - Math.log(a)), 0, 1);
const EDGES = [...new Set([BANDS.farEnd, BANDS.mapStart, BANDS.trueStart, BANDS.trueFull, ...BANDS.impostor, ...BANDS.twins, BANDS.snap])];
/** Float noise at a band edge (s·dpr for an odd dpr) snaps onto the edge so an edge is never "inside". */
export function snapEdge(d) { for (const e of EDGES) if (Math.abs(d - e) <= e * 1e-9) return e; return d; }
/** True when d lies strictly inside a no-rest interval. */
export function inRest(d) { d = snapEdge(d); return BANDS.rest.some(([a, b]) => d > a && d < b); }
/**
 * The resting d for d: itself outside BANDS.rest, else the nearer edge in log d. `lo`/`hi` are the
 * camera's reachable d; when the nearer edge is unreachable the other edge is used.
 */
export function restTarget(d, lo = 0, hi = Infinity) {
  d = snapEdge(d);
  for (const [a, b] of BANDS.rest) {
    if (!(d > a && d < b)) continue;
    const near = Math.log(d / a) <= Math.log(b / d) ? a : b, far = near === a ? b : a;
    if (near >= lo && near <= hi) return near;
    if (far >= lo && far <= hi) return far;
    return near;
  }
  return d;
}
/** Band name for d: 'far' | 'far-map' | 'map' | 'map-true' | 'true'. */
export function bandOf(d) {
  d = snapEdge(d);
  return d < BANDS.farEnd ? 'far' : d < BANDS.mapStart ? 'far-map' : d < BANDS.trueStart ? 'map' : d < BANDS.trueFull ? 'map-true' : 'true';
}
/**
 * bands(d) → { band, fadeWeight, restTarget, w }.
 * fadeWeight: the log-d weight of the fade d sits in (BANDS.rest intervals, closed), 0 outside every
 * fade; so at rest it is always exactly 0 or 1. w: layer weights (far, map, true, twins, decor, herds,
 * creatures, sway), the values the UBO's uBand/uLod carry.
 */
export function bands(d) {
  d = snapEdge(d);
  let fadeWeight = 0;
  for (const [a, b] of BANDS.rest) if (d >= a && d <= b) { fadeWeight = lnT(d, a, b); break; }
  const tFM = lnT(d, BANDS.farEnd, BANDS.mapStart), tMT = lnT(d, BANDS.trueStart, BANDS.trueFull);
  return {
    band: bandOf(d), fadeWeight, restTarget,
    w: {
      far: 1 - tFM, map: tFM * (1 - tMT), true: tMT,
      twins: lnT(d, BANDS.twins[0], BANDS.twins[1]), decor: lnT(d, BANDS.impostor[0], BANDS.impostor[1]),
      herds: d >= BANDS.herds ? 1 : 0, creatures: d >= BANDS.creatures ? 1 : 0, sway: d >= BANDS.sway ? 1 : 0,
    },
  };
}
/** The pixel-snapped d for a resting d ≥ BANDS.snap: a whole number of device px per art px. */
export function snapD(d, hi = Infinity) {
  if (d < BANDS.snap) return d;
  let m = Math.max(1, Math.round(d / DEED_ART));
  while (m > 1 && m * DEED_ART > hi + 1e-6) m--;
  return m * DEED_ART;
}

const easeOut = t => 1 - (1 - t) ** 3;
const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * web port P12 (D-177; owner on native, reference item 1: "land on the whole-realm overview"): where Enter map and a
 * pinch-in dive land — the realm's centre at the whole-realm fit, d in device px per deed. The concept landed at
 * max(min(sStart·dpr, farEnd), fit·dpr), a crop about 5× inside the fit. Pinch-out still leaves below 0.7 × this fit.
 */
export function landing(cam) { return { x: cam.cols / 2, y: cam.rows / 2, d: cam.sFit() * cam.dpr }; }

/**
 * createCamera({ now }) → Camera. Units: screen coordinates in CSS px (origin top-left of the canvas).
 * The owner calls setViewport(W, H, dpr) and setGrid(cols, rows) before use.
 */
export function createCamera({ now = () => performance.now() } = {}) {
  const vp = { W: 1, H: 1, dpr: 1 };
  const st = { x: 0, y: 0, s: 20, cols: 1, rows: 1, vx: 0, vy: 0, goal: null, settle: null, held: 0, last: 0, speed: 0 };
  // the fit leaves an 8 % margin; a portrait phone fits its safe width tighter (fix iteration 2: at FAR the realm
  // filled only ~40 % of a phone screen, and every CSS px of width is the realm's)
  const sFit = () => Math.min(vp.W / st.cols, vp.H / st.rows) * (vp.W < vp.H && vp.W < 700 ? 0.97 : 0.92);
  // D-177 (owner 2026-09-26, "overview first, live"; withdraws D-173's MAP zoom floor): the lowest resting view is the
  // whole-realm fit, and pinch-out below 0.7 × it leaves for the globe (bindGestures → onPinchOut).
  const sMin = sFit;
  const sFloor = () => sMin() * 0.6; // gestures may undershoot the fit (pinch below 0.7·sMin exits)
  // band readiness (W1 S2): lim = the highest d zooming in may reach now (map.js: a band whose pipelines are not built
  // yet). Zoom-out is never limited, and a camera already past a lowered limit stays where it is. A flight or ease that
  // ends at the limit keeps its target (pend) and resumes when the limit rises, unless the player moved the camera since.
  let lim = Infinity, clampedAt = -1e9, pend = null;
  const sHi = () => Math.min(BANDS.sMax, lim / vp.dpr);
  const limS = s => { const hi = sHi(); if (s > hi + 1e-9) { clampedAt = now(); return Math.max(hi, Math.min(s, st.s)); } return s; };
  const dLo = () => sMin() * vp.dpr, dHi = () => Math.min(BANDS.sMax * vp.dpr, Math.max(lim, st.s * vp.dpr)); // never pulls a camera back
  const clampPos = () => { st.x = clamp(st.x, 0, st.cols); st.y = clamp(st.y, 0, st.rows); };
  const toDeed = (sx, sy, s = st.s, x = st.x, y = st.y) => [x + (sx - vp.W / 2) / s, y + (sy - vp.H / 2) / s];

  /** Rest rule + snap + fit floor → the resting s for a wanted d. */
  function restS(d) {
    let t = restTarget(Math.max(d, dLo()), dLo(), dHi());
    t = snapD(t, dHi());
    return clamp(t, dLo(), dHi()) / vp.dpr;
  }
  /** Device-pixel grid snap of a centre coordinate at s (only when d ≥ snap). */
  function gridSnap(c, s, span) {
    const d = s * vp.dpr; if (d < BANDS.snap - 1e-6) return c;
    const half = span * vp.dpr / 2; return (Math.round(c * d - half) + half) / d;
  }
  function startEase(s1, fx, fy, ms) {
    const [u, v] = toDeed(fx, fy);
    let x1 = u - (fx - vp.W / 2) / s1, y1 = v - (fy - vp.H / 2) / s1;
    const xs = gridSnap(clamp(x1, 0, st.cols), s1, vp.W), ys = gridSnap(clamp(y1, 0, st.rows), s1, vp.H);
    if (Math.abs(s1 - st.s) < 1e-9 && Math.abs(xs - st.x) < 1e-9 && Math.abs(ys - st.y) < 1e-9) return false;
    st.goal = { kind: 'focus', t0: now(), ms, s0: st.s, s1, u, v, fx, fy, dx: xs - x1, dy: ys - y1 };
    return true;
  }
  /** Called when a gesture, its inertia or a wheel burst ends: apply the rest rule and the pixel snap. */
  function settleNow(fx = vp.W / 2, fy = vp.H / 2) {
    st.settle = null;
    const s1 = restS(st.s * vp.dpr);
    return startEase(s1, fx, fy, BANDS.restEaseMs);
  }

  const cam = {
    get x() { return st.x; }, get y() { return st.y; }, get s() { return st.s; },
    get d() { return st.s * vp.dpr; }, get dpr() { return vp.dpr; }, get W() { return vp.W; }, get H() { return vp.H; },
    get cols() { return st.cols; }, get rows() { return st.rows; },
    /** true while a fly, ease, inertia or pending settle is in progress (or a pointer is down). */
    get moving() { return !!st.goal || !!st.settle || st.held > 0 || Math.hypot(st.vx, st.vy) > 0; },
    /** Current pan speed in CSS px/s (tags hide above 1500). */
    get speed() { return st.speed; },
    get goal() { return st.goal; },
    sMin, sMax: () => BANDS.sMax,
    /** The whole-realm fit (CSS px per deed): the lowest resting view (D-177). */
    sFit,
    setViewport(W, H, dpr) { vp.W = Math.max(1, W); vp.H = Math.max(1, H); vp.dpr = dpr || 1; },
    setGrid(cols, rows) { st.cols = cols; st.rows = rows; },
    /** Immediate placement (no rest rule; used for entry and deterministic captures). free: below 0.6 × the fit too (QA). */
    set(x, y, s, { free = false } = {}) { st.goal = null; st.settle = null; st.vx = st.vy = 0; pend = null; if (s != null) st.s = limS(clamp(s, free ? 1e-3 : sFloor(), BANDS.sMax)); if (x != null) st.x = x; if (y != null) st.y = y; clampPos(); },
    /** Band readiness (W1 S2): the highest d zooming in may reach (Infinity = none). Raising it resumes a held flight. */
    limitD(d) {
      const was = lim; lim = d > 0 ? d : Infinity;
      if (lim > was && pend && !st.goal && !st.held && !st.settle) { const p = pend; pend = null; cam.flyToD(p.x, p.y, p.d, 450); }
    },
    get limit() { return lim; },
    /** true while the player pushes against the limit (a clamp in the last 500 ms) or a held flight waits for it. */
    get pressing() { return now() - clampedAt < 500 || !!pend; },
    screenToDeed: (sx, sy) => toDeed(sx, sy),
    deedToScreen: (u, v) => [(u - st.x) * st.s + vp.W / 2, (v - st.y) * st.s + vp.H / 2],
    /** Visible deed rect (fractional). */
    rect() { const hw = vp.W / 2 / st.s, hh = vp.H / 2 / st.s; return { x0: st.x - hw, y0: st.y - hh, x1: st.x + hw, y1: st.y + hh }; },
    // ---- gestures ----
    beginGesture() { st.held++; st.goal = null; st.settle = null; st.vx = st.vy = 0; pend = null; },
    panBy(dx, dy) { st.x -= dx / st.s; st.y -= dy / st.s; clampPos(); },
    zoomAt(sx, sy, k) {
      const [u, v] = toDeed(sx, sy); st.s = limS(clamp(st.s * k, sFloor(), BANDS.sMax));
      st.x = u - (sx - vp.W / 2) / st.s; st.y = v - (sy - vp.H / 2) / st.s; clampPos();
    },
    /** End of a touch/mouse gesture. vx, vy: release velocity in CSS px/ms (0 = none). */
    endGesture({ vx = 0, vy = 0, fx = vp.W / 2, fy = vp.H / 2 } = {}) {
      st.held = Math.max(0, st.held - 1); if (st.held) return;
      st.last = now();
      if (Math.hypot(vx, vy) < 0.02) { st.vx = st.vy = 0; settleNow(fx, fy); return; } // rest rule starts now
      st.vx = vx; st.vy = vy; st.settle = { fx, fy, at: 0 }; // runs when the inertia has died
    },
    /** A wheel step: zoom about the pointer; the rest rule runs 160 ms after the burst ends. */
    wheel(sx, sy, k) { st.goal = null; pend = null; cam.zoomAt(sx, sy, k); st.settle = { fx: sx, fy: sy, at: now() + 160 }; },
    // ---- flights (targets pass the rest rule) ----
    /** Fly to deed point (x, y) at d (device px per deed) on a log-scale arc. raw: no rest rule and no fit (the leave,
     *  which zooms out through the FAR→MAP fade into the painted chart before the globe takes over, from below the fit too). */
    flyToD(x, y, d, ms = 700, { raw = false } = {}) {
      pend = !raw && d > lim * 1.001 ? { x, y, d } : null; // aimed past a closed band gate: land at its edge, resume when it opens
      if (pend) clampedAt = now();
      const s1 = raw ? clamp(d, 1e-3, dHi()) / vp.dpr : restS(d);
      const x1 = gridSnap(clamp(x, 0, st.cols), s1, vp.W), y1 = gridSnap(clamp(y, 0, st.rows), s1, vp.H);
      st.settle = null; st.vx = st.vy = 0;
      st.goal = { kind: 'fly', t0: now(), ms: Math.max(1, ms), x0: st.x, y0: st.y, s0: st.s, x1, y1, s1 };
    },
    /** Public-API flight in s (CSS px per deed); converted to d so every device lands in the same band. */
    flyTo(x, y, s, ms = 700) { cam.flyToD(x, y, s * vp.dpr, ms); },
    /** Zoom by k about a screen point over ms (double-tap ×2.4; +/− buttons ×2.2), rest rule applied. */
    zoomAround(sx, sy, k, ms = 300) { st.settle = null; st.vx = st.vy = 0; pend = null; if (st.s * k * vp.dpr > lim * 1.001) clampedAt = now(); if (!startEase(restS(st.s * k * vp.dpr), sx, sy, ms)) st.goal = null; },
    /** Advance motion to time t. Returns true when the camera changed (a frame is needed). */
    step(t = now()) {
      if (st.goal) {
        const g = st.goal, k = clamp((t - g.t0) / g.ms, 0, 1);
        if (g.kind === 'fly') {
          const e = easeInOut(k), hop = Math.sin(Math.PI * e) * Math.min(0.9, Math.hypot(g.x1 - g.x0, g.y1 - g.y0) * g.s0 / vp.W * 0.35);
          st.s = Math.exp(Math.log(g.s0) + (Math.log(g.s1) - Math.log(g.s0)) * e - hop);
          st.x = g.x0 + (g.x1 - g.x0) * e; st.y = g.y0 + (g.y1 - g.y0) * e;
          if (k >= 1) {
            st.s = g.s1; st.x = g.x1; st.y = g.y1; st.goal = null;
            // a held flight whose gate opened while it was still flying to the edge resumes here (limitD only resumes one
            // that had already stopped: a gate can open within a flight's first few hundred ms on a fast device)
            if (pend && pend.d <= lim * 1.001) { const p = pend; pend = null; cam.flyToD(p.x, p.y, p.d, 450); }
          }
        } else {
          const e = easeOut(k); st.s = Math.exp(Math.log(g.s0) + (Math.log(g.s1) - Math.log(g.s0)) * e);
          st.x = g.u - (g.fx - vp.W / 2) / st.s + g.dx * e; st.y = g.v - (g.fy - vp.H / 2) / st.s + g.dy * e;
          if (k >= 1) { st.s = g.s1; st.x = g.u - (g.fx - vp.W / 2) / g.s1 + g.dx; st.y = g.v - (g.fy - vp.H / 2) / g.s1 + g.dy; st.goal = null; }
        }
        st.speed = 0; st.last = t; return true;
      }
      if (st.held) { st.last = t; return false; }
      const v = Math.hypot(st.vx, st.vy);
      if (v > 0) {
        const dt = clamp(t - st.last, 0, 64); st.last = t;
        st.x -= st.vx * dt / st.s; st.y -= st.vy * dt / st.s; clampPos();
        const decay = 0.92 ** (dt / 16.667); st.vx *= decay; st.vy *= decay; st.speed = v * 1000;
        if (Math.hypot(st.vx, st.vy) < 0.02) { st.vx = st.vy = 0; st.speed = 0; }
        return true;
      }
      st.last = t; st.speed = 0;
      if (st.settle && t >= st.settle.at) { settleNow(st.settle.fx, st.settle.fy); return cam.step(t); }
      return false;
    },
    /** Force the rest rule now (e.g. after entry clamps into the FAR band). */
    settle: (fx, fy) => settleNow(fx, fy),
    /** Record pan speed from the gesture layer (CSS px/s). */
    setSpeed(v) { st.speed = v; },
  };
  return cam;
}

/**
 * Pointer + wheel gestures (touch and mouse): one-finger pan with inertia, pinch about the fingers,
 * double-tap zoom ×2.4, tap. handlers: { onTap(sx, sy), onInput(), onPinchOut() (pinch/wheel below
 * sMin·0.7), onChange() }. Returns an unbind function.
 */
export function bindGestures(el, cam, handlers = {}) {
  const pts = new Map(); let pinch = null, down = null, lastTap = 0, samples = [];
  const pos = e => { const r = el.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  const input = () => handlers.onInput?.();
  const change = () => handlers.onChange?.();
  const exitCheck = () => { if (cam.s < cam.sMin() * 0.7) handlers.onPinchOut?.(); };
  function onDown(e) {
    if (e.button !== undefined && e.button > 0 && e.pointerType === 'mouse') return;
    el.setPointerCapture?.(e.pointerId); const [x, y] = pos(e); pts.set(e.pointerId, { x, y }); input();
    if (pts.size === 1) { cam.beginGesture(); down = { x, y, t: e.timeStamp, moved: false }; samples = [[x, y, e.timeStamp]]; }
    if (pts.size === 2) { const [a, b] = [...pts.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }; if (down) down.moved = true; }
    change();
  }
  function onMove(e) {
    const p = pts.get(e.pointerId); if (!p) return; const [x, y] = pos(e); const dx = x - p.x, dy = y - p.y; p.x = x; p.y = y; input();
    if (pts.size === 1) {
      if (down && Math.hypot(x - down.x, y - down.y) > 6) down.moved = true;
      if (down?.moved) {
        cam.panBy(dx, dy); samples.push([x, y, e.timeStamp]); if (samples.length > 8) samples.shift();
        const a = samples[0], b = samples[samples.length - 1]; cam.setSpeed(Math.hypot(b[0] - a[0], b[1] - a[1]) / Math.max(8, b[2] - a[2]) * 1000);
        change();
      }
    } else if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()], d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      cam.panBy(mx - pinch.mx, my - pinch.my); cam.zoomAt(mx, my, d / Math.max(1, pinch.d)); pinch = { d, mx, my }; change(); exitCheck();
    }
  }
  function onUp(e) {
    if (!pts.has(e.pointerId)) return; const [x, y] = pos(e); pts.delete(e.pointerId); input();
    if (pts.size === 1) { // pinch → pan with the remaining finger
      const [r] = [...pts.values()]; pinch = null; samples = [[r.x, r.y, e.timeStamp]]; return;
    }
    if (pts.size > 0) return;
    pinch = null;
    let vx = 0, vy = 0;
    if (down && !down.moved && e.timeStamp - down.t < 400) {
      if (e.timeStamp - lastTap < 300) { lastTap = 0; cam.endGesture({ fx: x, fy: y }); cam.zoomAround(x, y, 2.4, 320); change(); down = null; return; }
      lastTap = e.timeStamp; handlers.onTap?.(x, y);
    } else if (down?.moved && samples.length > 1) {
      const a = samples[0], b = samples[samples.length - 1], dt = Math.max(8, b[2] - a[2]);
      if (e.timeStamp - b[2] < 90) { vx = (b[0] - a[0]) / dt; vy = (b[1] - a[1]) / dt; }
    }
    cam.endGesture({ vx, vy, fx: x, fy: y }); down = null; change();
  }
  function onCancel(e) { if (!pts.delete(e.pointerId)) return; pinch = null; if (!pts.size) { down = null; cam.endGesture(); change(); } }
  function onWheel(e) {
    e.preventDefault(); input(); const [x, y] = pos(e);
    cam.wheel(x, y, Math.exp(-e.deltaY * (e.deltaMode ? 0.05 : 0.0016))); change(); exitCheck();
  }
  el.addEventListener('pointerdown', onDown); el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onCancel);
  el.addEventListener('wheel', onWheel, { passive: false });
  return () => {
    el.removeEventListener('pointerdown', onDown); el.removeEventListener('pointermove', onMove);
    el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onCancel);
    el.removeEventListener('wheel', onWheel);
  };
}
