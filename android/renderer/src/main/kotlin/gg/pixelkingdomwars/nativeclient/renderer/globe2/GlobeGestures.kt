package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Pin as P
import kotlin.math.hypot
import kotlin.math.ln

/**
 * The flat globe's gestures (GLOBE-NATIVE-PLAN §3.7): a port of the concept's pointer handlers (main.js pointerdown,
 * pointermove, endPointer), a pure state machine fed screen px (buffer px on the device: the host converts touches
 * with InputScale first) and the frame clock:
 * - one finger: a drag past the slop grabs the globe (arcball, ≤ GRAB_MAX rad a step; a screen-rate pan off the
 *   sphere), and the arcball steps of the last SAMPLE_MS before the lift become the release inertia;
 * - two fingers: a focal pinch (log-ratio zoom) with the midpoint grabbing the globe;
 * - a short, still press is a tap ([Listener.tap]; double taps are the listener's, as in the web's tap()).
 * Any touch stops a flight, inertia and the zoom anchor. GL thread only; never allocates after construction.
 */
class GlobeGestures(private val cam: GlobeCameraV2, private val listener: Listener) {
    fun interface Listener { fun tap(x: Double, y: Double, nowMs: Double) }

    private val ids = IntArray(MAX_POINTERS) { -1 }
    private val xs = DoubleArray(MAX_POINTERS); private val ys = DoubleArray(MAX_POINTERS)
    private var count = 0
    private var dragMoved = false
    private var downX = 0.0; private var downY = 0.0; private var downMs = 0.0; private var hasDown = false
    private var pinchD = 0.0
    // inertia samples: time + arcball step (ring)
    private val sT = DoubleArray(RING); private val sW = DoubleArray(RING * 3); private var sHead = 0; private var sCount = 0
    private val w = DoubleArray(3)

    /** Pointers down right now. */
    val active: Int get() = count

    fun down(id: Int, x: Double, y: Double, nowMs: Double) {
        if (slot(id) >= 0 || count == MAX_POINTERS) return
        ids[count] = id; xs[count] = x; ys[count] = y; count++
        cam.stopMotion()
        if (count == 1) { dragMoved = false; downX = x; downY = y; downMs = nowMs; hasDown = true; sCount = 0 }
        if (count == 2) { pinchD = hypot(xs[0] - xs[1], ys[0] - ys[1]); dragMoved = true }
    }

    fun move(id: Int, x: Double, y: Double, nowMs: Double) {
        val i = slot(id); if (i < 0) return
        val px = xs[i]; val py = ys[i]
        if (count == 1) {
            if (!dragMoved && hypot(x - downX, y - downY) < P.SLOP_PX * cam.pxScale) return
            dragMoved = true
            if (cam.grab(px, py, x, y, w)) {
                push(nowMs, w)
                while (sCount > 0 && nowMs - sT[(sHead - sCount + RING) % RING] > P.SAMPLE_MS) sCount--
            }
        } else if (count == 2) {
            val o = if (i == 0) 1 else 0
            val ox = xs[o]; val oy = ys[o]
            val d = hypot(x - ox, y - oy)
            if (pinchD > 0) { cam.z = V.clamp(cam.z + ln(d / pinchD) / ln(P.ALT_MAX / P.ALT_MIN), cam.zLo, 1.0); cam.zT = cam.z }
            pinchD = d
            cam.grab((px + ox) / 2, (py + oy) / 2, (x + ox) / 2, (y + oy) / 2, w)
        }
        xs[i] = x; ys[i] = y
    }

    fun up(id: Int, x: Double, y: Double, nowMs: Double) = end(id, x, y, nowMs, cancelled = false)
    fun cancel(id: Int) = end(id, 0.0, 0.0, 0.0, cancelled = true)

    private fun end(id: Int, x: Double, y: Double, nowMs: Double, cancelled: Boolean) {
        val i = slot(id); if (i < 0) return
        for (k in i until count - 1) { ids[k] = ids[k + 1]; xs[k] = xs[k + 1]; ys[k] = ys[k + 1] }
        count--; ids[count] = -1
        if (count == 1) pinchD = 0.0
        if (count > 0) return
        // the last SAMPLE_MS before the lift: a finger that stopped, then lifted, does not fling (the web keeps samples
        // until the next move, which a still finger never sends; plan §3.7 "inertia from the last 90 ms of samples")
        if (!cancelled) while (sCount > 0 && nowMs - sT[(sHead - sCount + RING) % RING] > P.SAMPLE_MS) sCount--
        if (dragMoved && sCount > 1) {
            val first = (sHead - sCount + RING) % RING; val last = (sHead - 1 + RING) % RING
            val dt = (sT[last] - sT[first]) / 1000
            if (dt > 0.01) {
                var vx = 0.0; var vy = 0.0; var vz = 0.0
                for (k in 1 until sCount) { val j = (first + k) % RING; vx += sW[j * 3]; vy += sW[j * 3 + 1]; vz += sW[j * 3 + 2] }
                V.set(cam.vel, vx / dt, vy / dt, vz / dt)
                cam.hasVel = V.len(cam.vel) >= P.VEL_MIN
            }
        }
        if (!cancelled && !dragMoved && hasDown && nowMs - downMs < P.TAP_MS) listener.tap(x, y, nowMs)
        hasDown = false
    }

    private fun push(nowMs: Double, v: DoubleArray) {
        sT[sHead] = nowMs; sW[sHead * 3] = v[0]; sW[sHead * 3 + 1] = v[1]; sW[sHead * 3 + 2] = v[2]
        sHead = (sHead + 1) % RING; if (sCount < RING) sCount++
    }

    private fun slot(id: Int): Int { for (i in 0 until count) if (ids[i] == id) return i; return -1 }

    companion object {
        const val MAX_POINTERS = 10
        private const val RING = 64
    }
}
