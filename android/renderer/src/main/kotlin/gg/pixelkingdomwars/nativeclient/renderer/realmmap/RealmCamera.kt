package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import java.util.function.DoubleSupplier
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin

/** Band names of camera.js `bandOf`. */
object RealmBand {
    const val FAR = 0
    const val FAR_MAP = 1
    const val MAP = 2
    const val MAP_TRUE = 3
    const val TRUE = 4
    private val NAMES = arrayOf("far", "far-map", "map", "map-true", "true")
    fun name(band: Int): String = NAMES[band]
    /** map.js `BAND_SET`: 0 FAR, 1 the MAP set gates d > farEnd, 2 the TRUE set gates d > trueStart. */
    fun set(band: Int): Int = when (band) { FAR -> 0; FAR_MAP, MAP -> 1; else -> 2 }
}

/** camera.js `bands(d)`: reused per frame (never allocated in a frame). */
class RealmBandState {
    var band = RealmBand.FAR
    /** The log-d weight of the fade d sits in (0 outside every fade; at rest always exactly 0 or 1). */
    var fadeWeight = 0.0
    var far = 1.0; var map = 0.0; var trueW = 0.0; var twins = 0.0; var decor = 0.0
    var herds = 0.0; var creatures = 0.0; var sway = 0.0
}

/**
 * The pure band rules of the web realm camera (camera.js `snapEdge`, `inRest`, `restTarget`, `bandOf`, `bands`,
 * `snapD`). [deedArt] is `DEED_ART` (worldTiles × GRID.tilePx, game numbers from the catalogue).
 */
class RealmBandRules(val bands: RealmBands, val deedArt: Double) {
    private fun lnT(d: Double, a: Double, b: Double): Double = ((ln(d) - ln(a)) / (ln(b) - ln(a))).coerceIn(0.0, 1.0)

    /** Float noise at a band edge (s·dpr for an odd dpr) snaps onto the edge so an edge is never "inside". */
    fun snapEdge(d: Double): Double { for (e in bands.edges) if (abs(d - e) <= e * 1e-9) return e; return d }

    /** True when d lies strictly inside a no-rest interval. */
    fun inRest(d0: Double): Boolean {
        val d = snapEdge(d0); val r = bands.rest
        var i = 0
        while (i < r.size) { if (d > r[i] && d < r[i + 1]) return true; i += 2 }
        return false
    }

    /** The resting d for d: itself outside `BANDS.rest`, else the nearer edge in log d ([lo], [hi]: reachable d). */
    fun restTarget(d0: Double, lo: Double = 0.0, hi: Double = Double.POSITIVE_INFINITY): Double {
        val d = snapEdge(d0); val r = bands.rest
        var i = 0
        while (i < r.size) {
            val a = r[i]; val b = r[i + 1]; i += 2
            if (!(d > a && d < b)) continue
            val near = if (ln(d / a) <= ln(b / d)) a else b
            val far = if (near == a) b else a
            if (near >= lo && near <= hi) return near
            if (far >= lo && far <= hi) return far
            return near
        }
        return d
    }

    fun bandOf(d0: Double): Int {
        val d = snapEdge(d0); val b = bands
        return if (d < b.farEnd) RealmBand.FAR else if (d < b.mapStart) RealmBand.FAR_MAP else if (d < b.trueStart) RealmBand.MAP
            else if (d < b.trueFull) RealmBand.MAP_TRUE else RealmBand.TRUE
    }

    /** camera.js `bands(d)` into [out]. */
    fun bands(d0: Double, out: RealmBandState): RealmBandState {
        val d = snapEdge(d0); val b = bands
        var fade = 0.0
        var i = 0
        while (i < b.rest.size) { if (d >= b.rest[i] && d <= b.rest[i + 1]) { fade = lnT(d, b.rest[i], b.rest[i + 1]); break }; i += 2 }
        val tFM = lnT(d, b.farEnd, b.mapStart); val tMT = lnT(d, b.trueStart, b.trueFull)
        out.band = bandOf(d); out.fadeWeight = fade
        out.far = 1 - tFM; out.map = tFM * (1 - tMT); out.trueW = tMT
        out.twins = lnT(d, b.twins[0], b.twins[1]); out.decor = lnT(d, b.impostor[0], b.impostor[1])
        out.herds = if (d >= b.herds) 1.0 else 0.0; out.creatures = if (d >= b.creatures) 1.0 else 0.0; out.sway = if (d >= b.sway) 1.0 else 0.0
        return out
    }

    /** The pixel-snapped d for a resting d ≥ `BANDS.snap`: a whole number of device px per art px. */
    fun snapD(d: Double, hi: Double = Double.POSITIVE_INFINITY): Double {
        if (d < bands.snap) return d
        var m = max(1.0, jsRound(d / deedArt))
        while (m > 1 && m * deedArt > hi + 1e-6) m--
        return m * deedArt
    }

    companion object {
        /** JS `Math.round`: halves round toward +∞. */
        fun jsRound(v: Double): Double = floor(v + 0.5)
    }
}

/** The band gate's answer ([RealmBandLimit.limit]): reused, never allocated in a frame. */
class RealmGateLimit {
    /** The highest d (device px per deed) the camera may reach now, +∞ = none. */
    var lim = Double.POSITIVE_INFINITY
    /** The band held: 0 none, 1 MAP, 2 TRUE. */
    var band = 0
    /** Why ([RealmMapEngine.GATE_NONE], [RealmMapEngine.GATE_LOADING], [RealmMapEngine.GATE_REHEARSAL],
     *  [RealmMapEngine.GATE_BYPASS]). */
    var reason = RealmMapEngine.GATE_NONE
    fun set(lim: Double, band: Int, reason: Int): RealmGateLimit { this.lim = lim; this.band = band; this.reason = reason; return this }
}

/**
 * core.js `bandLimit({ on, bypass, valve, items, dive, lanesIn })` (pure; W1 S2/S8, D-173 stage B D5, 911b39c5): the
 * highest d the camera may reach now. Items are the rehearsal items still to do: [n] of them, item i in set [set] (1 =
 * the MAP set, 2 = TRUE) and [gating] (its lane has loaded and it can draw). [dive]: the D-173 dive holds the camera in
 * the painted chart; [lanesIn]: every live lane's load has settled; [valve]: the stall valve opened this gate; [bypass]:
 * a QA set() jumped past it. The dive holds at `farEnd` until the lanes are in AND the MAP set is rehearsed; GROUND's
 * mapReady hold is the caller's (it is timed). Inline, so the engine's lambdas over its pair arrays allocate nothing.
 * Pinned over every flag combination by `world/golden/bandlimit.json`.
 *
 * D-177 (web 197d753c) withdrew the dive rule: a lane still loading never closes the zoom, and [RealmMapEngine] never
 * passes [dive] / [lanesIn]. The rule stays here only while the golden pin is stage B (205b6326), whose rows still carry
 * it; drop both parameters with the next re-pin (the web's bandLimit no longer takes them).
 */
object RealmBandLimit {
    inline fun limit(out: RealmGateLimit, bands: RealmBands, on: Boolean = true, bypass: Boolean = false, valve: Boolean = false,
                     dive: Boolean = false, lanesIn: Boolean = true, n: Int = 0, set: (Int) -> Int = { 0 }, gating: (Int) -> Boolean = { false }): RealmGateLimit {
        if (bypass) return out.set(Double.POSITIVE_INFINITY, 0, RealmMapEngine.GATE_BYPASS)
        if (on && !valve) {
            if (dive && !lanesIn) return out.set(bands.farEnd, 1, RealmMapEngine.GATE_LOADING)
            for (i in 0 until n) if (set(i) <= 1 && gating(i)) return out.set(bands.farEnd, 1, RealmMapEngine.GATE_REHEARSAL)
            for (i in 0 until n) if (set(i) <= 2 && gating(i)) return out.set(bands.trueStart, 2, RealmMapEngine.GATE_REHEARSAL)
        }
        return out.set(Double.POSITIVE_INFINITY, 0, RealmMapEngine.GATE_NONE)
    }
}

/**
 * The realm-map camera (camera.js `createCamera`), deed space: [x], [y] = the deed-space point at the screen centre,
 * [s] = CSS px per deed, [d] = s·dpr = device px per deed. Rest rule, pixel snap, flights on a log-scale arc, inertia,
 * and band readiness ([limitD]: the highest d zooming in may reach now). Pure and allocation-free: [now] is the frame
 * clock in ms (the pacer's), so JVM tests drive it with a fake clock. GL thread only.
 */
class RealmCamera(private val rules: RealmBandRules, private val now: DoubleSupplier) {
    private val bands = rules.bands

    var viewW = 1.0; private set
    var viewH = 1.0; private set
    var dpr = 1.0; private set
    var x = 0.0; private set
    var y = 0.0; private set
    var s = 20.0; private set
    var cols = 1; private set
    var rows = 1; private set
    private var vx = 0.0; private var vy = 0.0
    var speed = 0.0; private set
    private var held = 0
    private var last = 0.0

    // goal: a flight or a focus ease (fields, not objects: no allocation per gesture)
    private var goal = GOAL_NONE
    private var gT0 = 0.0; private var gMs = 1.0; private var gS0 = 0.0; private var gS1 = 0.0
    private var gX0 = 0.0; private var gY0 = 0.0; private var gX1 = 0.0; private var gY1 = 0.0
    private var gU = 0.0; private var gV = 0.0; private var gFx = 0.0; private var gFy = 0.0; private var gDx = 0.0; private var gDy = 0.0
    // settle: the rest rule waiting for the inertia to die
    private var settle = false; private var settleFx = 0.0; private var settleFy = 0.0; private var settleAt = 0.0
    // band readiness
    var limit = Double.POSITIVE_INFINITY; private set
    private var clampedAt = -1e9
    private var pend = false; private var pendX = 0.0; private var pendY = 0.0; private var pendD = 0.0

    val d: Double get() = s * dpr
    /** A fly, ease, inertia or pending settle is running, or a pointer is down. */
    val moving: Boolean get() = goal != GOAL_NONE || settle || held > 0 || hypot(vx, vy) > 0
    val flying: Boolean get() = goal == GOAL_FLY
    /** camera.js `goal.kind`: "fly", "focus" or null. */
    val goalKind: String? get() = when (goal) { GOAL_FLY -> "fly"; GOAL_FOCUS -> "focus"; else -> null }
    /** The player pushes against the limit (a clamp in the last 500 ms) or a held flight waits for it. */
    val pressing: Boolean get() = now.asDouble - clampedAt < 500 || pend

    /**
     * D-173 (owner, 2026-09-25: "the realm map never rests zoomed out as a flat image"): the rest floor in device px per
     * deed, camera.js `floorD` / `setFloorD(d)` at the stage-B pin 205b6326 (911b39c5): 0 (≤ 0 or NaN, the web's null) =
     * the whole-realm fit; the engine sets `BANDS.mapStart` while a lane can draw MAP. A set floor IS the rest floor,
     * whatever the fit (camera.js `sMin = floorD / dpr`). The gesture undershoot (0.6×) and the pinch-out exit (0.7×) keep
     * the web's proportions, measured from this floor. Pinned by the D-173 traces of `world/golden/camera.json`.
     */
    var floorD = 0.0

    /** The whole-realm fit, CSS px per deed, whatever the floor (camera.js `sFit`; the web's `sMin` is [sRest]). */
    fun sMin(): Double = min(viewW / cols, viewH / rows) * (if (viewW < viewH && viewW < 700) 0.97 else 0.92)
    /** The resting floor, CSS px per deed (camera.js `sMin`): [floorD] when set (D-173), else the whole-realm fit. */
    fun sRest(): Double = if (floorD > 0) floorD / dpr else sMin()
    private fun sFloor() = sRest() * 0.6
    private fun sHi() = min(bands.sMax, limit / dpr)
    private fun limS(v: Double): Double {
        val hi = sHi()
        if (v > hi + 1e-9) { clampedAt = now.asDouble; return max(hi, min(v, s)) }
        return v
    }
    private fun dLo() = sRest() * dpr
    private fun dHi() = min(bands.sMax * dpr, max(limit, s * dpr))
    private fun clampPos() { x = x.coerceIn(0.0, cols.toDouble()); y = y.coerceIn(0.0, rows.toDouble()) }
    private fun clamp(v: Double, a: Double, b: Double) = max(a, min(b, v))

    fun setViewport(w: Double, h: Double, dpr: Double) { viewW = max(1.0, w); viewH = max(1.0, h); this.dpr = if (dpr > 0) dpr else 1.0 }
    fun setGrid(cols: Int, rows: Int) { this.cols = cols; this.rows = rows }

    /** Screen (CSS px) → deed space. */
    fun screenToDeedX(sx: Double): Double = x + (sx - viewW / 2) / s
    fun screenToDeedY(sy: Double): Double = y + (sy - viewH / 2) / s
    fun deedToScreenX(u: Double): Double = (u - x) * s + viewW / 2
    fun deedToScreenY(v: Double): Double = (v - y) * s + viewH / 2
    fun rectX0() = x - viewW / 2 / s
    fun rectY0() = y - viewH / 2 / s
    fun rectX1() = x + viewW / 2 / s
    fun rectY1() = y + viewH / 2 / s

    /** Rest rule + snap + fit floor → the resting s for a wanted d. */
    private fun restS(want: Double): Double {
        var t = rules.restTarget(max(want, dLo()), dLo(), dHi())
        t = rules.snapD(t, dHi())
        return clamp(t, dLo(), dHi()) / dpr
    }

    /** Device-pixel grid snap of a centre coordinate at s (only when d ≥ snap). */
    private fun gridSnap(c: Double, sv: Double, span: Double): Double {
        val dd = sv * dpr
        if (dd < bands.snap - 1e-6) return c
        val half = span * dpr / 2
        return (RealmBandRules.jsRound(c * dd - half) + half) / dd
    }

    private fun startEase(s1: Double, fx: Double, fy: Double, ms: Double): Boolean {
        val u = screenToDeedX(fx); val v = screenToDeedY(fy)
        val x1 = u - (fx - viewW / 2) / s1; val y1 = v - (fy - viewH / 2) / s1
        val xs = gridSnap(clamp(x1, 0.0, cols.toDouble()), s1, viewW); val ys = gridSnap(clamp(y1, 0.0, rows.toDouble()), s1, viewH)
        if (abs(s1 - s) < 1e-9 && abs(xs - x) < 1e-9 && abs(ys - y) < 1e-9) return false
        goal = GOAL_FOCUS; gT0 = now.asDouble; gMs = ms; gS0 = s; gS1 = s1; gU = u; gV = v; gFx = fx; gFy = fy; gDx = xs - x1; gDy = ys - y1
        return true
    }

    private fun settleNow(fx: Double, fy: Double): Boolean {
        settle = false
        return startEase(restS(s * dpr), fx, fy, bands.restEaseMs)
    }

    /** Immediate placement (no rest rule; entry and deterministic captures). NaN leaves a coordinate unchanged. [free]
     *  (camera.js `set(x, y, s, { free })`, stage B): below the floor too, down to 1e-3 (QA captures). */
    fun set(nx: Double, ny: Double, ns: Double, free: Boolean = false) {
        goal = GOAL_NONE; settle = false; vx = 0.0; vy = 0.0; pend = false
        if (!ns.isNaN()) s = limS(clamp(ns, if (free) 1e-3 else sFloor(), bands.sMax))
        if (!nx.isNaN()) x = nx
        if (!ny.isNaN()) y = ny
        clampPos()
    }

    /**
     * Band readiness: the highest d zooming in may reach (+∞ = none). Raising it resumes a held flight that has stopped;
     * one still flying to the edge resumes at its end, inside [step] (camera.js 911b39c5: the one resume mechanism, as on
     * the web; it replaces N3's engine-driven `resumeHeld`, which fixed the same parked-flight bug natively first).
     */
    fun limitD(dMax: Double) {
        val was = limit
        limit = if (dMax > 0) dMax else Double.POSITIVE_INFINITY
        if (limit > was && pend && goal == GOAL_NONE && held == 0 && !settle) { pend = false; flyToD(pendX, pendY, pendD, 450.0) }
    }

    // ---- gestures (CSS px) ----
    fun beginGesture() { held++; goal = GOAL_NONE; settle = false; vx = 0.0; vy = 0.0; pend = false }
    fun panBy(dx: Double, dy: Double) { x -= dx / s; y -= dy / s; clampPos() }
    fun zoomAt(sx: Double, sy: Double, k: Double) {
        val u = screenToDeedX(sx); val v = screenToDeedY(sy)
        // Native deviation from camera.js zoomAt (clamp(s·k, sFloor, sMax); no golden trace reaches it): below a raised
        // floor a pinch never jumps the camera up to 0.6 × the floor. The native engine raises the floor when the D-173
        // landing starts (the camera is still at the chart's d under it); map.js raises it only once the dive has landed,
        // so the web never zooms from below a set floor.
        val lo = if (floorD > 0) min(sFloor(), s) else sFloor()
        s = limS(clamp(s * k, lo, bands.sMax))
        x = u - (sx - viewW / 2) / s; y = v - (sy - viewH / 2) / s; clampPos()
    }
    /** End of a gesture. [rvx], [rvy]: release velocity in CSS px/ms (0 = none). */
    fun endGesture(rvx: Double = 0.0, rvy: Double = 0.0, fx: Double = viewW / 2, fy: Double = viewH / 2) {
        held = max(0, held - 1); if (held > 0) return
        last = now.asDouble
        if (hypot(rvx, rvy) < 0.02) { vx = 0.0; vy = 0.0; settleNow(fx, fy); return }
        vx = rvx; vy = rvy; settle = true; settleFx = fx; settleFy = fy; settleAt = 0.0
    }

    /** A wheel step (a mouse or a stylus wheel): zoom about the pointer; the rest rule runs 160 ms after the burst. */
    fun wheel(sx: Double, sy: Double, k: Double) {
        goal = GOAL_NONE; pend = false; zoomAt(sx, sy, k)
        settle = true; settleFx = sx; settleFy = sy; settleAt = now.asDouble + 160
    }

    // ---- flights (targets pass the rest rule) ----
    /** Fly to deed point ([tx], [ty]) at [td] device px per deed on a log-scale arc. [raw] (camera.js `{ raw }`, stage B:
     *  the D-173 leave into the chart): no rest rule, no floor and no band hold, s1 = clamp(td, 1e-3, dHi) / dpr. */
    fun flyToD(tx: Double, ty: Double, td: Double, ms: Double = 700.0, raw: Boolean = false) {
        pend = !raw && td > limit * 1.001
        if (pend) { pendX = tx; pendY = ty; pendD = td; clampedAt = now.asDouble }
        val s1 = if (raw) clamp(td, 1e-3, dHi()) / dpr else restS(td)
        val x1 = gridSnap(clamp(tx, 0.0, cols.toDouble()), s1, viewW); val y1 = gridSnap(clamp(ty, 0.0, rows.toDouble()), s1, viewH)
        settle = false; vx = 0.0; vy = 0.0
        goal = GOAL_FLY; gT0 = now.asDouble; gMs = max(1.0, ms); gX0 = x; gY0 = y; gS0 = s; gX1 = x1; gY1 = y1; gS1 = s1
    }
    fun flyTo(tx: Double, ty: Double, ts: Double, ms: Double = 700.0) = flyToD(tx, ty, ts * dpr, ms)

    /** Zoom by k about a screen point over ms (double-tap ×2.4; +/− ×2.2), rest rule applied. */
    fun zoomAround(sx: Double, sy: Double, k: Double, ms: Double = 300.0) {
        settle = false; vx = 0.0; vy = 0.0; pend = false
        if (s * k * dpr > limit * 1.001) clampedAt = now.asDouble
        if (!startEase(restS(s * k * dpr), sx, sy, ms)) goal = GOAL_NONE
    }

    /** Force the rest rule now (after entry clamps into the FAR band). */
    fun settle(fx: Double = viewW / 2, fy: Double = viewH / 2): Boolean = settleNow(fx, fy)

    /** Pan speed from the gesture layer, CSS px/s. */
    fun setSpeed(v: Double) { speed = v }

    /** Advance motion to [t] (ms). True when the camera changed (a frame is needed). */
    fun step(t: Double = now.asDouble): Boolean {
        if (goal != GOAL_NONE) {
            val k = clamp((t - gT0) / gMs, 0.0, 1.0)
            if (goal == GOAL_FLY) {
                val e = easeInOut(k)
                val hop = sin(PI * e) * min(0.9, hypot(gX1 - gX0, gY1 - gY0) * gS0 / viewW * 0.35)
                s = exp(ln(gS0) + (ln(gS1) - ln(gS0)) * e - hop)
                x = gX0 + (gX1 - gX0) * e; y = gY0 + (gY1 - gY0) * e
                if (k >= 1) {
                    s = gS1; x = gX1; y = gY1; goal = GOAL_NONE
                    // a held flight whose gate opened while it still flew to the edge resumes here (limitD resumes only a
                    // stopped one: the D-173 dive's hold can end inside its first 450 ms on a fast device)
                    if (pend && pendD <= limit * 1.001) { pend = false; flyToD(pendX, pendY, pendD, 450.0) }
                }
            } else {
                val e = easeOut(k)
                s = exp(ln(gS0) + (ln(gS1) - ln(gS0)) * e)
                x = gU - (gFx - viewW / 2) / s + gDx * e; y = gV - (gFy - viewH / 2) / s + gDy * e
                if (k >= 1) { s = gS1; x = gU - (gFx - viewW / 2) / gS1 + gDx; y = gV - (gFy - viewH / 2) / gS1 + gDy; goal = GOAL_NONE }
            }
            speed = 0.0; last = t
            return true
        }
        if (held > 0) { last = t; return false }
        val v = hypot(vx, vy)
        if (v > 0) {
            val dt = clamp(t - last, 0.0, 64.0); last = t
            x -= vx * dt / s; y -= vy * dt / s; clampPos()
            val decay = 0.92.pow(dt / 16.667); vx *= decay; vy *= decay; speed = v * 1000
            if (hypot(vx, vy) < 0.02) { vx = 0.0; vy = 0.0; speed = 0.0 }
            return true
        }
        last = t; speed = 0.0
        if (settle && t >= settleAt) { settleNow(settleFx, settleFy); return step(t) }
        return false
    }

    companion object {
        private const val GOAL_NONE = 0
        private const val GOAL_FLY = 1
        private const val GOAL_FOCUS = 2
        fun easeOut(t: Double): Double = 1 - (1 - t).pow(3)
        fun easeInOut(t: Double): Double = if (t < 0.5) 4 * t * t * t else 1 - (-2 * t + 2).pow(3) / 2
    }
}
