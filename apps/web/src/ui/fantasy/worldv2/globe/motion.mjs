// The globe's pure state machines (no DOM, no GL; CSS px and ms):
// - gestures: the concept's pointer handlers (main.js pointerdown/pointermove/endPointer), as native GlobeGestures.kt;
// - approach: D-NEXT "a dive is coming" (native GlobeApproach.kt), the prefetch hook;
// - cover: the dive's cloud-cover clock (native DiveCoverClock).
import { P } from './pin.mjs';
import { add, clamp, len, mulS } from './camera.mjs';

/**
 * One finger drags the globe (arcball past the slop; the last SAMPLE_MS of steps become the release inertia); two
 * fingers pinch (log-ratio zoom) with the midpoint grabbing; a short still press is a tap. Any touch stops a flight,
 * inertia and the zoom anchor.
 */
export function createGestures(cam, onTap) {
  const pointers = new Map(); let dragMoved = false, downAt = null, pinchD = 0, samples = [];
  return {
    get active() { return pointers.size; },
    down(id, x, y, now) {
      if (pointers.has(id)) return;
      pointers.set(id, [x, y]); cam.anim = null; cam.vel = null; cam.anchor = null;
      if (pointers.size === 1) { dragMoved = false; downAt = [x, y, now]; samples = []; }
      if (pointers.size === 2) { const [p, q] = [...pointers.values()]; pinchD = Math.hypot(p[0] - q[0], p[1] - q[1]); dragMoved = true; }
    },
    move(id, x, y, now) {
      const prev = pointers.get(id); if (!prev) return; const cur = [x, y];
      if (pointers.size === 1) {
        if (!dragMoved && Math.hypot(cur[0] - downAt[0], cur[1] - downAt[1]) < P.SLOP_PX) return; dragMoved = true;
        const w = cam.grab(prev, cur); if (w) { samples.push([now, w]); while (samples.length && now - samples[0][0] > P.SAMPLE_MS) samples.shift(); }
      } else if (pointers.size === 2) {
        const other = [...pointers.entries()].find(([k]) => k !== id)[1];
        const mid0 = [(prev[0] + other[0]) / 2, (prev[1] + other[1]) / 2], mid1 = [(cur[0] + other[0]) / 2, (cur[1] + other[1]) / 2];
        const d = Math.hypot(cur[0] - other[0], cur[1] - other[1]);
        if (pinchD > 0) { cam.z = clamp(cam.z + Math.log(d / pinchD) / Math.log(P.ALT_MAX / P.ALT_MIN), cam.zLo, 1); cam.zT = cam.z; }
        pinchD = d; cam.grab(mid0, mid1);
      }
      pointers.set(id, cur);
    },
    up(id, x, y, now, cancelled = false) {
      if (!pointers.delete(id)) return;
      if (pointers.size === 1) pinchD = 0;
      if (pointers.size) return;
      // only the steps of the last SAMPLE_MS before the lift fling (a finger that stopped, then lifted, does not)
      if (!cancelled) while (samples.length && now - samples[0][0] > P.SAMPLE_MS) samples.shift();
      if (dragMoved && samples.length > 1) { const dt = (samples[samples.length - 1][0] - samples[0][0]) / 1000;
        if (dt > 0.01) { let w = [0, 0, 0]; for (const [, v] of samples.slice(1)) w = add(w, v); cam.vel = mulS(w, 1 / dt); if (len(cam.vel) < P.VEL_MIN) cam.vel = null; } }
      if (!cancelled && !dragMoved && downAt && now - downAt[2] < P.TAP_MS) onTap(x, y, now);
      downAt = null;
    },
    cancelAll() { pointers.clear(); pinchD = 0; downAt = null; samples = []; },
  };
}

/**
 * D-NEXT approach prefetch (native GlobeApproach): the player is about to dive when the camera has rested REST_MS at or
 * below REST_ALT over a realm whose map can open, or a pinch aims below PINCH_ALT. Never while spinning or flying.
 * One answer per realm while the camera stays in the zone; leaving it re-arms.
 */
export function createApproach({ restMs = 400, restAlt = 0.6, pinchAlt = 0.5 } = {}) {
  let fired = null, restSince = NaN, restRealm = null;
  const reset = () => { fired = null; restSince = NaN; restRealm = null; };
  return {
    reset,
    step(now, realmId, alt, targetAlt, pinching, moving, spinning, flying) {
      if (realmId == null || Math.min(alt, targetAlt) > restAlt) { reset(); return null; }
      if (spinning || flying) { restSince = NaN; return null; }
      if (moving) restSince = NaN;
      else if (Number.isNaN(restSince) || realmId !== restRealm) { restSince = now; restRealm = realmId; }
      const due = (pinching && targetAlt < pinchAlt) || (!Number.isNaN(restSince) && alt <= restAlt && now - restSince >= restMs);
      if (!due || fired === realmId) return null;
      fired = realmId; return realmId;
    },
    /** Mark a realm as already prefetched (an Enter-map dive asked for it at its start). */
    mark(realmId) { fired = realmId; },
  };
}

/**
 * The dive's cloud cover clock (native DiveCoverClock): nothing before SHOW_AFTER_MS (a normal dive is ready before
 * it), then the clouds rise over RAMP_MS and hold; ready() stops the rise; live()/failed() part them over PART_MS;
 * reset() drops them (a leave never has clouds).
 */
export function createCoverClock({ showAfterMs = 400, rampMs = 300, partMs = 450 } = {}) {
  let phase = 0, t0 = 0, held = 0, partT0 = 0, partFrom = 0; // 0 idle, 1 waiting, 2 held, 3 parting
  const rise = now => clamp((now - t0 - showAfterMs) / rampMs, 0, 1);
  const part = now => { if (phase !== 1 && phase !== 2) return; partFrom = phase === 1 ? rise(now) : held; partT0 = now; phase = partFrom > 0 ? 3 : 0; };
  return {
    get animating() { return phase !== 0; },
    start(now) { phase = 1; t0 = now; },
    ready(now) { if (phase !== 1) return; held = rise(now); phase = held > 0 ? 2 : 0; },
    live: part, failed: part,
    reset() { phase = 0; },
    alpha(now) {
      if (phase === 1) return rise(now);
      if (phase === 2) return held;
      if (phase === 3) { const a = partFrom - (now - partT0) / partMs; if (a <= 0) { phase = 0; return 0; } return a; }
      return 0;
    },
    seconds(now) { return (now - t0) / 1000; },
  };
}
