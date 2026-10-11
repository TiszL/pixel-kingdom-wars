package gg.pixelkingdomwars.nativeclient.renderer.world

import kotlin.math.roundToInt

/**
 * View px ↔ buffer px across `SurfaceHolder.setFixedSize` (GLOBE-NATIVE-PLAN §3.7, §5.5). libGDX's touch handler
 * reports raw `MotionEvent` coordinates in VIEW px while `Gdx.graphics` reports the fixed BUFFER size, so every touch
 * crosses [viewToBufferX]/[viewToBufferY] before picking, slop, focal point and inertia, and every `WorldFrame` anchor
 * and HUD rect crosses back. Mutable and allocation-free: the GL thread keeps one instance and calls [set] on resize.
 */
class InputScale {
    var viewW = 1; private set
    var viewH = 1; private set
    var bufferW = 1; private set
    var bufferH = 1; private set
    /** Buffer px per view px on each axis (≤ 1 when the buffer is downscaled). */
    var sx = 1.0f; private set
    var sy = 1.0f; private set

    fun set(viewW: Int, viewH: Int, bufferW: Int, bufferH: Int) {
        require(viewW > 0 && viewH > 0 && bufferW > 0 && bufferH > 0) { "Empty surface" }
        this.viewW = viewW; this.viewH = viewH; this.bufferW = bufferW; this.bufferH = bufferH
        sx = bufferW.toFloat() / viewW; sy = bufferH.toFloat() / viewH
    }

    fun viewToBufferX(x: Float): Float = x * sx
    fun viewToBufferY(y: Float): Float = y * sy
    fun bufferToViewX(x: Float): Float = x / sx
    fun bufferToViewY(y: Float): Float = y / sy
    /** A length along x in view px (a 6 dp slop, a pinch span) in buffer px. */
    fun viewToBufferLength(length: Float): Float = length * (sx + sy) * 0.5f

    /** [count] rects (x, y, w, h quadruples) from view px (Compose `SetUiRects`) into buffer px, into [out]. */
    fun viewRectsToBuffer(rects: FloatArray, count: Int, out: FloatArray) = scale(rects, count * 4, out, sx, sy)

    /** [count] points (x, y pairs) from buffer px (engine anchors) into view px (`WorldFrame` for Compose), into [out]. */
    fun bufferPointsToView(points: FloatArray, count: Int, out: FloatArray) = scale(points, count * 2, out, 1f / sx, 1f / sy)

    /** Even slots are x or width, odd slots y or height: both layouts alternate the two axes. */
    private fun scale(src: FloatArray, n: Int, out: FloatArray, kx: Float, ky: Float) {
        require(n <= src.size && n <= out.size) { "Buffer too small" }
        var i = 0
        while (i < n) { out[i] = src[i] * kx; out[i + 1] = src[i + 1] * ky; i += 2 }
    }

    companion object {
        /** core.js `resize()`: the engine's dpr is capped at 2 (`Math.min(2, devicePixelRatio)`), plan §5.5 default. */
        const val WEB_DPR_CAP = 2.0

        /** The engine's dpr on a screen of this density: render-target px per dp, capped like the web. */
        fun dpr(density: Double, cap: Double = WEB_DPR_CAP): Double = minOf(cap, density)

        /** One side of the fixed buffer: the panel side in dp × dpr, rounded (1200 px at density 2.625 → 914). Never
         *  larger than the panel (a density below the cap renders at native size). */
        fun fixedBufferSide(panelPx: Int, density: Double, cap: Double = WEB_DPR_CAP): Int {
            require(panelPx > 0 && density > 0) { "Bad panel" }
            return minOf(panelPx, (panelPx * dpr(density, cap) / density).roundToInt())
        }
    }
}
