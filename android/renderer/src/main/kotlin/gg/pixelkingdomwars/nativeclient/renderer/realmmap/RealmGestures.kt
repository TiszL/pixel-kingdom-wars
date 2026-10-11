package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import kotlin.math.hypot
import kotlin.math.max

/** What a gesture asks of the engine (camera.js `bindGestures` handlers). */
interface RealmGestureListener {
    /** A single tap (CSS px): the engine asks the cluster counters first, then picks a deed. */
    fun onTap(sx: Double, sy: Double)
    /** Any pointer input: leaves the idle phases (core.input()). */
    fun onInput()
    /** A pinch-out below 0.7 × the rest floor, the whole-realm fit (D-NEXT; D-173 measured it from MAP's start): leave
     *  to the globe. */
    fun onPinchOut()
    /** The camera changed: a frame is needed. */
    fun onChange()
}

/**
 * Touch gestures of the realm map (camera.js `bindGestures`), as a pure state machine fed with pointer events in CSS
 * px and ms. The host converts every libGDX touch (view px) with `InputScale` into buffer px and divides by the
 * engine's dpr (GLOBE-NATIVE-PLAN §3.7); the web's CSS px equal dp here. One-finger pan with inertia from the last
 * 90 ms, pinch about the fingers with a midpoint pan, double-tap zoom ×2.4, a 6 CSS px tap slop, pinch-out exit below
 * the rest floor. Allocation-free after construction; GL thread only.
 */
class RealmGestures(private val cam: RealmCamera, private val listener: RealmGestureListener) {
    private val ids = IntArray(MAX_POINTERS) { -1 }
    private val px = DoubleArray(MAX_POINTERS)
    private val py = DoubleArray(MAX_POINTERS)
    private var count = 0
    private var pinching = false
    private var pinchD = 0.0; private var pinchMx = 0.0; private var pinchMy = 0.0
    private var down = false; private var downX = 0.0; private var downY = 0.0; private var downT = 0.0; private var moved = false
    private var lastTap = NO_TAP
    private val sx = DoubleArray(SAMPLES); private val sy = DoubleArray(SAMPLES); private val st = DoubleArray(SAMPLES)
    private var samples = 0

    val pointers: Int get() = count

    private fun slot(id: Int): Int { for (i in 0 until count) if (ids[i] == id) return i; return -1 }
    private fun resetSamples(x: Double, y: Double, t: Double) { samples = 1; sx[0] = x; sy[0] = y; st[0] = t }
    private fun pushSample(x: Double, y: Double, t: Double) {
        if (samples == SAMPLES) { System.arraycopy(sx, 1, sx, 0, SAMPLES - 1); System.arraycopy(sy, 1, sy, 0, SAMPLES - 1); System.arraycopy(st, 1, st, 0, SAMPLES - 1); samples-- }
        sx[samples] = x; sy[samples] = y; st[samples] = t; samples++
    }
    /** camera.js `exitCheck`, measured from the rest floor ([RealmCamera.sRest]: the whole-realm fit, since the engine
     *  never sets a floor under D-NEXT; the camera keeps `floorD` for the web's traces), and only while the fingers close
     *  ([k] < 1): a pinch-in never leaves. */
    private fun exitCheck(k: Double) { if (k < 1 && cam.s < cam.sRest() * EXIT_K) listener.onPinchOut() }

    fun down(id: Int, x: Double, y: Double, t: Double) {
        if (count == MAX_POINTERS || slot(id) >= 0) return
        ids[count] = id; px[count] = x; py[count] = y; count++
        listener.onInput()
        if (count == 1) { cam.beginGesture(); down = true; downX = x; downY = y; downT = t; moved = false; resetSamples(x, y, t) }
        if (count == 2) {
            pinching = true; pinchD = hypot(px[0] - px[1], py[0] - py[1]); pinchMx = (px[0] + px[1]) / 2; pinchMy = (py[0] + py[1]) / 2
            if (down) moved = true
        }
        listener.onChange()
    }

    fun move(id: Int, x: Double, y: Double, t: Double) {
        val i = slot(id); if (i < 0) return
        val dx = x - px[i]; val dy = y - py[i]; px[i] = x; py[i] = y
        listener.onInput()
        if (count == 1) {
            if (down && hypot(x - downX, y - downY) > SLOP) moved = true
            if (down && moved) {
                cam.panBy(dx, dy); pushSample(x, y, t)
                cam.setSpeed(hypot(sx[samples - 1] - sx[0], sy[samples - 1] - sy[0]) / max(8.0, st[samples - 1] - st[0]) * 1000)
                listener.onChange()
            }
        } else if (count == 2 && pinching) {
            val d = hypot(px[0] - px[1], py[0] - py[1]); val mx = (px[0] + px[1]) / 2; val my = (py[0] + py[1]) / 2
            val k = d / max(1.0, pinchD)
            cam.panBy(mx - pinchMx, my - pinchMy); cam.zoomAt(mx, my, k)
            pinchD = d; pinchMx = mx; pinchMy = my
            listener.onChange(); exitCheck(k)
        }
    }

    fun up(id: Int, x: Double, y: Double, t: Double) {
        val i = slot(id); if (i < 0) return
        for (j in i until count - 1) { ids[j] = ids[j + 1]; px[j] = px[j + 1]; py[j] = py[j + 1] }
        count--; ids[count] = -1
        listener.onInput()
        if (count == 1) { pinching = false; resetSamples(px[0], py[0], t); return } // pinch → pan with the remaining finger
        if (count > 0) return
        pinching = false
        var vx = 0.0; var vy = 0.0
        if (down && !moved && t - downT < TAP_MS) {
            if (t - lastTap < DOUBLE_TAP_MS) {
                lastTap = NO_TAP; cam.endGesture(0.0, 0.0, x, y); cam.zoomAround(x, y, DOUBLE_TAP_ZOOM, 320.0); listener.onChange(); down = false
                return
            }
            lastTap = t; listener.onTap(x, y)
        } else if (down && moved && samples > 1) {
            val dt = max(8.0, st[samples - 1] - st[0])
            if (t - st[samples - 1] < INERTIA_MS) { vx = (sx[samples - 1] - sx[0]) / dt; vy = (sy[samples - 1] - sy[0]) / dt }
        }
        cam.endGesture(vx, vy, x, y); down = false; listener.onChange()
    }

    fun cancel(id: Int) {
        val i = slot(id); if (i < 0) return
        for (j in i until count - 1) { ids[j] = ids[j + 1]; px[j] = px[j + 1]; py[j] = py[j + 1] }
        count--; ids[count] = -1
        pinching = false
        if (count == 0) { down = false; cam.endGesture(); listener.onChange() }
    }

    companion object {
        const val MAX_POINTERS = 10
        private const val SAMPLES = 8
        const val SLOP = 6.0
        const val TAP_MS = 400.0
        const val DOUBLE_TAP_MS = 300.0
        const val DOUBLE_TAP_ZOOM = 2.4
        const val INERTIA_MS = 90.0
        /** camera.js: a pinch below 0.7 × the rest floor leaves (the camera's own undershoot floor is 0.6 ×). */
        const val EXIT_K = 0.7
        /** No previous tap (the web's 0 at page time, which is always long before the first tap). */
        private const val NO_TAP = -1e9
    }
}
