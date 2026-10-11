package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Pin as P
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
import kotlin.math.tan

/**
 * One computed view (main.js computeView): matrices in Float32 exactly as the web stores them (persp, lookAt, mul4 and
 * inv4 write Float32Arrays), everything else in doubles. Units: [w], [h] and every screen coordinate are the host's
 * screen px (buffer px on the device; CSS px in the web goldens). Reused every frame.
 */
class GlobeView {
    var w = 1; var h = 1
    var alt = 0.0
    val t = DoubleArray(3)
    val eye = DoubleArray(3)
    val vp = FloatArray(16)
    val inv = FloatArray(16)
    var pxPerRad = 1.0
    val right = DoubleArray(3)
    val up = DoubleArray(3)
    var lon = 0.0
    var lat = 0.0
    /** Distance of the eye from the planet centre (radius 1). */
    var eyeLen = 1.0
}

/** The ease curves of main.js EASE. */
enum class GlobeEase {
    INOUT, OUT, IN;
    fun at(e: Double): Double = when (this) {
        INOUT -> if (e < .5) 4 * e * e * e else 1 - (-2 * e + 2).pow(3) / 2
        OUT -> 1 - (1 - e).pow(4)
        IN -> e * e * e
    }
}

/**
 * The flat globe's camera (GLOBE-NATIVE-PLAN §3.2 GlobeCameraV2): a port of the pinned concept's camera block (main.js
 * `computeView`, `projectDir`, `rayAt`, `hitSphere`, `grab`, `flyTo`, `fitAlt`, `homeFrame`, `minAltAt`) and the camera
 * part of its `frame()` (flight, inertia, eased zoom with an anchor, the zoom floor, the latitude clamp, the lens ease).
 * Presentation constants come from the generated [GlobeV2Pin]; golden vectors from the web implementation pin it
 * (`GlobeCameraGoldenTest`). The flat globe: no relief (heightAt = 0) and no tilt (TILT_MAX = 0, owner 2026-09-24).
 *
 * Screen px: [pxScale] is screen px per web CSS px (the buffer's px per dp on the device, 1 in the goldens); every
 * CSS-px literal of the web (margins, the 40 px projection cull, the fit padding) is multiplied by it.
 * GL thread only. The per-frame paths ([computeView], [step], [projectDir], [hitSphere], [grab]) never allocate.
 */
class GlobeCameraV2(var pxScale: Double = 1.0) {
    // ---- state (main.js cam, zLo, lens) ----
    val t: DoubleArray = V.dirOf(P.START_LON, P.START_LAT)
    var z = P.START_Z
    var zT = P.START_Z
    val vel = DoubleArray(3)
    var hasVel = false
    val anchor = DoubleArray(3)
    var hasAnchor = false
    var zLo = 0.0
    var lensX = 0.0; var lensY = 0.0; var lensTx = 0.0; var lensTy = 0.0
    /** Phase E layer on: the camera may come closer over its art (minAltAt). Off (RG-3): the atlas floor everywhere. */
    var phaseE = false
    var reducedMotion = false

    // the flight (main.js cam.anim)
    var flying = false; private set
    private val a0 = DoubleArray(3); private val a1 = DoubleArray(3)
    private var az0 = 0.0; private var az1 = 0.0; private var aStart = 0.0; private var aDur = 1.0; private var aArc = 0.0
    private var aEase = GlobeEase.INOUT
    /** The flight's end (for a leave that frames the realm before the flight starts). */
    val flightTarget: DoubleArray get() = a1
    val flightZ: Double get() = az1

    val view = GlobeView()

    // scratch (no per-frame allocation)
    private val s0 = DoubleArray(3); private val s1 = DoubleArray(3); private val s2 = DoubleArray(3); private val s3 = DoubleArray(3)
    private val m0 = FloatArray(16); private val m1 = FloatArray(16)
    private val q0 = DoubleArray(4); private val q1 = DoubleArray(4)
    private val rayO = DoubleArray(3); private val rayD = DoubleArray(3)
    private val h0 = DoubleArray(3); private val h1 = DoubleArray(3)

    // ---- pure helpers (main.js) ----
    fun altOf(z: Double): Double = P.ALT_MAX * (P.ALT_MIN / P.ALT_MAX).pow(z)
    fun zOf(alt: Double): Double = ln(alt / P.ALT_MAX) / ln(P.ALT_MIN / P.ALT_MAX)
    /** Vertical FOV: 36° in landscape; in portrait it widens so the horizontal view stays ~36°, capped (main.js fovY). */
    fun fovY(w: Double, h: Double): Double =
        if (w >= h) P.FOV_RAD else 2 * atan(min(tan(P.FOV_PORTRAIT_CAP_DEG * V.RAD), tan(P.FOV_RAD / 2) * h / w))

    /** main.js minAltAt: the atlas floor, lower near Phase E art only while that layer is on (RG-3). */
    fun minAltAt(dir: DoubleArray): Double {
        if (!phaseE) return P.ALT_MIN_ATLAS
        V.norm(s3, dir)
        for (i in P.PHASE_E.indices) { // by index: a list iterator would allocate in every frame (the zoom floor)
            val a = P.PHASE_E[i]
            V.dirOf(h0, a.lon, a.lat)
            val ang = acos(V.clamp(V.dot(s3, h0), -1.0, 1.0)) / V.RAD
            if (ang < a.wDeg * 0.9) return V.mix(P.ALT_MIN, P.ALT_MIN_ATLAS, V.smooth(a.wDeg * 0.45, a.wDeg * 0.9, ang))
        }
        return P.ALT_MIN_ATLAS
    }

    // ---- the view ----
    /** main.js computeView(W, H) into [view]. */
    fun computeView(w: Int, h: Int): GlobeView {
        val v = view
        v.w = w; v.h = h
        val alt = altOf(z); v.alt = alt
        val tt = V.norm(v.t, t)
        val east = V.norm(s0, V.crossUp(s0, tt))
        val north = V.cross(s1, tt, east)
        v.lon = V.lon(tt); v.lat = V.lat(tt)
        // Sp = t (no relief); eye = Sp + t·alt (no tilt); the clearance floor 1.004 never binds at alt ≥ ALT_MIN
        V.set(v.eye, tt[0] + tt[0] * alt, tt[1] + tt[1] * alt, tt[2] + tt[2] * alt)
        val eLen = V.len(v.eye)
        if (eLen < 1 + 0.004) V.mulS(v.eye, V.norm(s2, v.eye), 1 + 0.004)
        v.eyeLen = V.len(v.eye)
        val near = maxOf(P.NEAR_MIN, alt * P.NEAR_K); val far = v.eyeLen + P.FAR_PAD
        val fy = fovY(w.toDouble(), h.toDouble())
        persp(m0, fy, w.toDouble() / h, near, far)
        m0[8] = (m0[8] - lensX).toFloat(); m0[9] = (m0[9] - lensY).toFloat()
        lookAt(m1, v.eye, tt, north, h0, h1, rayO)
        mul4(v.vp, m0, m1)
        inv4(v.inv, v.vp)
        // fwd = norm(Sp - eye); right = norm(cross(fwd, up)); camUp = cross(right, fwd)
        V.norm(s2, V.sub(s2, tt, v.eye))
        V.norm(v.right, V.cross(v.right, s2, north))
        V.cross(v.up, v.right, s2)
        v.pxPerRad = h / 2.0 / tan(fy / 2)
        return v
    }

    /** main.js projectDir(d, lift): screen px into [out] (x, y), or false (behind the limb or ±40 CSS px off screen). */
    fun projectDir(d: DoubleArray, lift: Double, out: DoubleArray): Boolean {
        val v = view; val m = v.vp
        val k = 1 + lift; val p0 = d[0] * k; val p1 = d[1] * k; val p2 = d[2] * k
        val x = m[0] * p0 + m[4] * p1 + m[8] * p2 + m[12]
        val y = m[1] * p0 + m[5] * p1 + m[9] * p2 + m[13]
        val w = m[3] * p0 + m[7] * p1 + m[11] * p2 + m[15]
        if (w <= 0) return false
        V.norm(s3, v.eye)
        if (V.dot(d, s3) < 1 / V.len(v.eye) - 0.002) return false
        val sx = (x / w * 0.5 + 0.5) * v.w; val sy = (0.5 - y / w * 0.5) * v.h
        val margin = 40 * pxScale
        if (sx < -margin || sy < -margin || sx > v.w + margin || sy > v.h + margin) return false
        out[0] = sx; out[1] = sy
        return true
    }

    /** main.js rayAt: origin and unit direction of the view ray through screen (px, py). */
    fun rayAt(px: Double, py: Double, o: DoubleArray, d: DoubleArray) {
        val v = view; val m = v.inv
        val x = px / v.w * 2 - 1; val y = 1 - py / v.h * 2
        tp(m, x, y, -1.0, q0); tp(m, x, y, 1.0, q1)
        V.set(o, q0[0], q0[1], q0[2])
        V.norm(d, V.set(d, q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]))
    }

    /** main.js hitSphere(px, py, R): the unit direction of the front hit into [out], or false on a miss. */
    fun hitSphere(px: Double, py: Double, out: DoubleArray, r: Double = 1.0): Boolean {
        rayAt(px, py, rayO, rayD)
        val b = V.dot(rayO, rayD); val c = V.dot(rayO, rayO) - r * r; val disc = b * b - c
        if (disc < 0) return false
        val tt = -b - sqrt(disc)
        if (tt < 0) return false
        V.norm(out, V.set(out, rayO[0] + rayD[0] * tt, rayO[1] + rayD[1] * tt, rayO[2] + rayD[2] * tt))
        return true
    }

    /**
     * main.js grab(from, to) against the current [view]: an arcball step (≤ GRAB_MAX rad) when both points hit the
     * sphere, written to [w] (axis·angle) and returning true; otherwise a screen-rate pan by longitude/latitude
     * (returns false, [w] untouched).
     */
    fun grab(fx: Double, fy: Double, tx: Double, ty: Double, w: DoubleArray): Boolean {
        val okA = hitSphere(fx, fy, h0); val okB = okA && hitSphere(tx, ty, h1)
        if (okA && okB) {
            V.cross(s2, h1, h0); val s = V.len(s2)
            if (s < 1e-9) return false
            val ang = min(atan2(s, V.dot(h1, h0)), P.GRAB_MAX)
            V.mulS(s2, s2, 1 / s)
            V.norm(t, V.rotate(s3, t, s2, ang))
            V.mulS(w, s2, ang)
            return true
        }
        val v = view
        val k = 2 * altOf(z) * tan(fovY(v.w.toDouble(), v.h.toDouble()) / 2) / v.h
        V.norm(s3, t); val lon = V.lon(s3); val lat = V.lat(s3)
        V.dirOf(t, lon - (tx - fx) * k / V.RAD / maxOf(0.3, cos(lat * V.RAD)), V.clamp(lat + (ty - fy) * k / V.RAD, -85.0, 85.0))
        return false
    }

    /** main.js flyTo(dir, z, dur, ease): [durMs] ≤ 0 uses the angle-scaled default; reduced motion cuts (1 ms). */
    fun flyTo(dir: DoubleArray, toZ: Double, nowMs: Double, durMs: Double = -1.0, ease: GlobeEase = GlobeEase.INOUT): Double {
        V.norm(a0, t)
        val ang = acos(V.clamp(V.dot(a0, dir), -1.0, 1.0))
        hasVel = false; hasAnchor = false
        var dur = if (durMs > 0) durMs else V.clamp(P.FLIGHT_MS + ang * P.FLIGHT_PER_RAD, P.FLIGHT_MS, P.FLIGHT_MAX_MS)
        if (reducedMotion) dur = 1.0
        V.copy(a1, dir); az0 = z; az1 = toZ; aStart = nowMs; aDur = dur
        aArc = V.clamp(ang / P.ARC_DIV, 0.0, P.ARC_MAX); aEase = ease; flying = true
        return dur
    }

    fun stopFlight() { flying = false }
    fun stopMotion() { flying = false; hasVel = false; hasAnchor = false }

    /**
     * The camera part of main.js frame(): the flight, else inertia and the eased zoom (pulled toward [anchor]), then the
     * zoom floor [zMax] (a z, already chosen by the caller: the dive floor over a realm with a map, else minAltAt) and
     * the latitude clamp. [dt] in seconds, already clamped to DT_MAX. Returns true while anything moved.
     */
    fun step(nowMs: Double, dt: Double, zMax: Double): Boolean {
        var moved = false
        if (flying) {
            val e0 = V.clamp((nowMs - aStart) / aDur, 0.0, 1.0); val e = aEase.at(e0)
            V.norm(t, V.slerp(s0, a0, a1, e))
            z = V.clamp(V.mix(az0, az1, e) - aArc * sin(PI * e), zLo, 1.0); zT = z
            if (e0 >= 1) flying = false
            moved = true
        } else {
            if (hasVel) {
                val w = V.len(vel)
                V.mulS(s0, vel, 1 / w)
                V.norm(t, V.rotate(s1, t, s0, w * dt))
                V.mulS(vel, vel, exp(-dt * P.INERTIA_DECAY))
                if (V.len(vel) < P.INERTIA_STOP) hasVel = false
                moved = true
            }
            if (abs(zT - z) > 1e-4) {
                val nz = V.mix(z, zT, 1 - exp(-dt * P.ZOOM_EASE))
                if (hasAnchor) { val f = 1 - altOf(nz) / altOf(z); if (f > 0) V.norm(t, V.slerp(s0, V.norm(s1, t), anchor, f)) }
                z = nz
                moved = true
            }
        }
        if (zT > zMax) zT = zMax
        if (!flying && z > zMax) { z = maxOf(zMax, z - 0.02); moved = true }
        V.norm(s0, t)
        val lat = V.lat(s0)
        if (abs(lat) > P.LAT_MAX) V.dirOf(t, V.lon(s0), V.clamp(lat, -P.LAT_MAX, P.LAT_MAX))
        // the lens shift eases toward its target
        val e = 1 - exp(-dt * P.LENS_EASE)
        if (lensX != lensTx || lensY != lensTy) {
            lensX = if (abs(lensTx - lensX) < 1e-4) lensTx else V.mix(lensX, lensTx, e)
            lensY = if (abs(lensTy - lensY) < 1e-4) lensTy else V.mix(lensY, lensTy, e)
            moved = true
        }
        return moved
    }

    /**
     * main.js fitAlt(pts, t, hw, hh, lo): the lowest altitude (≥ [lo]) that keeps every point inside ±hw × ±hh px of the
     * principal point, by bisection; above the zoom-out floor it answers the floor. [pts] packs x, y, z per point.
     */
    fun fitAlt(pts: DoubleArray, n: Int, c: DoubleArray, hw: Double, hh: Double, lo: Double, screenW: Double, screenH: Double): Double {
        val f = screenH / 2 / tan(fovY(screenW, screenH) / 2)
        val e = V.norm(DoubleArray(3), V.crossUp(DoubleArray(3), c)); val nn = V.cross(DoubleArray(3), c, e)
        fun fits(alt: Double): Boolean {
            val dd = 1 + alt
            for (i in 0 until n) {
                val px = pts[i * 3]; val py = pts[i * 3 + 1]; val pz = pts[i * 3 + 2]
                val zz = px * c[0] + py * c[1] + pz * c[2]
                if (zz < 1 / dd + 0.02) return false
                val dz = dd - zz
                if (abs(f * (px * e[0] + py * e[1] + pz * e[2]) / dz) > hw || abs(f * (px * nn[0] + py * nn[1] + pz * nn[2]) / dz) > hh) return false
            }
            return true
        }
        var low = lo
        if (fits(low)) return low
        var hi = altOf(zLo) * 0.97
        if (!fits(hi)) return hi
        for (i in 0 until 22) { val m = (low + hi) / 2; if (fits(m)) hi = m else low = m }
        return hi
    }

    /**
     * main.js homeFrame(): the whole globe, as large as fits between the header's bottom [top] and the screen's bottom
     * margin, clear of the [obstacles] (x0, y0, x1, y1 quadruples, screen px). Returns the altitude; the centre height
     * goes to [cy][0].
     */
    fun homeFrame(w: Double, h: Double, top: Double, obstacles: FloatArray, count: Int, cy: DoubleArray): Double {
        val m = 10 * pxScale; val cx = w / 2; val y0 = top + m; val y1 = h - m; val yc = (y0 + y1) / 2
        var r = min(w / 2 - m, (y1 - y0) / 2.09)
        val bands = DoubleArray(count * 2)
        while (r > 40 * pxScale) {
            val lo = y0 + r * 1.03; val hi = y1 - r * 1.06
            var nb = 0
            for (i in 0 until count) {
                val ox0 = obstacles[i * 4].toDouble(); val oy0 = obstacles[i * 4 + 1].toDouble()
                val ox1 = obstacles[i * 4 + 2].toDouble(); val oy1 = obstacles[i * 4 + 3].toDouble()
                if (ox1 <= ox0) continue
                val dx = maxOf(ox0 - cx, 0.0, cx - ox1)
                if (dx < r + m) { val s = sqrt((r + m) * (r + m) - dx * dx); bands[nb * 2] = oy0 - s; bands[nb * 2 + 1] = oy1 + s; nb++ }
            }
            fun ok(c: Double): Boolean {
                if (!(c >= lo - 1e-6 && c <= hi + 1e-6)) return false
                for (b in 0 until nb) if (!(c <= bands[b * 2] + 1e-6 || c >= bands[b * 2 + 1] - 1e-6)) return false
                return true
            }
            // candidates: the clamped centre, then every band edge; the one nearest the middle wins (stable order)
            var best = Double.NaN; var bestD = Double.POSITIVE_INFINITY
            val first = V.clamp(yc, lo, hi)
            if (ok(first)) { best = first; bestD = abs(first - yc) }
            for (b in 0 until nb * 2) { val c = bands[b]; if (ok(c) && abs(c - yc) < bestD) { best = c; bestD = abs(c - yc) } }
            if (!best.isNaN()) {
                val f = h / 2 / tan(fovY(w, h) / 2)
                cy[0] = best
                return sqrt(1 + (f / r) * (f / r)) - 1
            }
            r -= 2 * pxScale
        }
        cy[0] = h / 2
        return P.ALT_MAX
    }

    companion object {
        /** main.js persp(fovy, asp, n, f) into [o] (Float32 storage, as the web's Float32Array). */
        fun persp(o: FloatArray, fovy: Double, asp: Double, n: Double, f: Double) {
            val t = 1 / tan(fovy / 2); val nf = 1 / (n - f)
            o.fill(0f)
            o[0] = (t / asp).toFloat(); o[5] = t.toFloat(); o[10] = ((f + n) * nf).toFloat(); o[11] = -1f; o[14] = (2 * f * n * nf).toFloat()
        }

        /** main.js lookAt(e, c, up) into [o]; [sx], [sy], [sz] are caller scratch (the frame never allocates). */
        fun lookAt(o: FloatArray, e: DoubleArray, c: DoubleArray, up: DoubleArray,
                   sx: DoubleArray = DoubleArray(3), sy: DoubleArray = DoubleArray(3), sz: DoubleArray = DoubleArray(3)) {
            val zv = V.norm(sz, V.sub(sz, e, c))
            val xv = V.norm(sx, V.cross(sx, up, zv))
            val yv = V.cross(sy, zv, xv)
            o[0] = xv[0].toFloat(); o[1] = yv[0].toFloat(); o[2] = zv[0].toFloat(); o[3] = 0f
            o[4] = xv[1].toFloat(); o[5] = yv[1].toFloat(); o[6] = zv[1].toFloat(); o[7] = 0f
            o[8] = xv[2].toFloat(); o[9] = yv[2].toFloat(); o[10] = zv[2].toFloat(); o[11] = 0f
            o[12] = (-V.dot(xv, e)).toFloat(); o[13] = (-V.dot(yv, e)).toFloat(); o[14] = (-V.dot(zv, e)).toFloat(); o[15] = 1f
        }

        /** main.js mul4(a, b): column-major product, double accumulation, Float32 result. */
        fun mul4(o: FloatArray, a: FloatArray, b: FloatArray) {
            for (c in 0 until 4) for (r in 0 until 4) {
                var s = 0.0
                for (k in 0 until 4) s += a[k * 4 + r].toDouble() * b[c * 4 + k]
                o[c * 4 + r] = s.toFloat()
            }
        }

        /** main.js inv4(m), verbatim (double arithmetic on the Float32 inputs, Float32 result). */
        fun inv4(o: FloatArray, m: FloatArray) {
            val a0 = m[0].toDouble(); val a1 = m[1].toDouble(); val a2 = m[2].toDouble(); val a3 = m[3].toDouble()
            val a4 = m[4].toDouble(); val a5 = m[5].toDouble(); val a6 = m[6].toDouble(); val a7 = m[7].toDouble()
            val a8 = m[8].toDouble(); val a9 = m[9].toDouble(); val a10 = m[10].toDouble(); val a11 = m[11].toDouble()
            val a12 = m[12].toDouble(); val a13 = m[13].toDouble(); val a14 = m[14].toDouble(); val a15 = m[15].toDouble()
            val b00 = a0 * a5 - a1 * a4; val b01 = a0 * a6 - a2 * a4; val b02 = a0 * a7 - a3 * a4
            val b03 = a1 * a6 - a2 * a5; val b04 = a1 * a7 - a3 * a5; val b05 = a2 * a7 - a3 * a6
            val b06 = a8 * a13 - a9 * a12; val b07 = a8 * a14 - a10 * a12; val b08 = a8 * a15 - a11 * a12
            val b09 = a9 * a14 - a10 * a13; val b10 = a9 * a15 - a11 * a13; val b11 = a10 * a15 - a11 * a14
            val det = 1 / (b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06)
            o[0] = ((a5 * b11 - a6 * b10 + a7 * b09) * det).toFloat(); o[1] = ((a2 * b10 - a1 * b11 - a3 * b09) * det).toFloat()
            o[2] = ((a13 * b05 - a14 * b04 + a15 * b03) * det).toFloat(); o[3] = ((a10 * b04 - a9 * b05 - a11 * b03) * det).toFloat()
            o[4] = ((a6 * b08 - a4 * b11 - a7 * b07) * det).toFloat(); o[5] = ((a0 * b11 - a2 * b08 + a3 * b07) * det).toFloat()
            o[6] = ((a14 * b02 - a12 * b05 - a15 * b01) * det).toFloat(); o[7] = ((a8 * b05 - a10 * b02 + a11 * b01) * det).toFloat()
            o[8] = ((a4 * b10 - a5 * b08 + a7 * b06) * det).toFloat(); o[9] = ((a1 * b08 - a0 * b10 - a3 * b06) * det).toFloat()
            o[10] = ((a12 * b04 - a13 * b02 + a15 * b00) * det).toFloat(); o[11] = ((a9 * b02 - a8 * b04 - a11 * b00) * det).toFloat()
            o[12] = ((a5 * b07 - a4 * b09 - a6 * b06) * det).toFloat(); o[13] = ((a0 * b09 - a1 * b07 + a2 * b06) * det).toFloat()
            o[14] = ((a13 * b01 - a12 * b03 - a14 * b00) * det).toFloat(); o[15] = ((a8 * b03 - a9 * b01 + a10 * b00) * det).toFloat()
        }

        /** m (column-major) × (x, y, z, 1), divided by w, into out[0..2]. */
        private fun tp(m: FloatArray, x: Double, y: Double, z: Double, out: DoubleArray) {
            for (r in 0 until 4) out[r] = m[r] * x + m[4 + r] * y + m[8 + r] * z + m[12 + r] * 1.0
            val w = out[3]; out[0] /= w; out[1] /= w; out[2] /= w
        }
    }
}
