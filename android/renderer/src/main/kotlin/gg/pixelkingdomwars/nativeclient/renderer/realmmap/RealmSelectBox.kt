package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * The selected OPEN deed's highlight (owner 2026-09-26, choosing land: "could not tell which land deed was selected"),
 * the port of the web's ui.js `deedBox` and `.rmx-selbox` (SHARDKEEP-globe 1d39d2e7 + 36745a38). The landing's chart
 * and TRUE draw no deed selection and MAP only a 1–2 px gold edge (`rm-map`'s `uSel`), so a tapped open deed showed only
 * in the card and the minimap. The box: a 3 CSS px gold border (#f4d77b) with a 2 px dark ring outside it and a 1 px dark
 * line inside it (#0b0a10), a gold tint, and the whole box's opacity breathing 1 → 0.6 → 1 over 1.6 s (CSS `ease-in-out`
 * per half). It is never under 18 CSS px (centred on the deed: landing deeds are 5–12 px), is clipped 8 px past the
 * screen (a TRUE deed thousands of px wide never becomes a huge pass), and its tint eases 0.30 → 0.16 as the deed grows to
 * half the screen: light over the close-up art, still visible when the deed fills the screen and its border is off it.
 *
 * The web draws it as a DOM box over the canvas; here it is one blended full-screen-triangle pass scissored to the box and
 * its ring, on the screen after the realm's sprites and occupancy dots and before the minimap (Compose's tags stay above
 * it, as the web's box sits under its tags). Kingdoms keep their own selection (sprites, the MAP edge, the minimap ring).
 * No pulse under reduced motion, GPU safe mode or the idle freeze: the box holds at full strength there (the native pulse
 * rule: the idle scheduler draws no frame to move it). GL thread only; no allocation per frame.
 */
class RealmSelectBox(private val core: Gl3Core) {
    private val box = DoubleArray(5)
    /** The last drawn box, CSS px (top-left [x], [y], [w] × [h]), its tint alpha [fill] and its pulse opacity [alpha]. */
    var x = 0.0; private set
    var y = 0.0; private set
    var w = 0.0; private set
    var h = 0.0; private set
    var fill = 0.0; private set
    var alpha = 1.0; private set
    /** The last [draw] drew the box. */
    var drawn = false; private set
    private var shownX = -1; private var shownY = -1; private var startMs = 0L

    /** Is the box of open deed ([deedX], [deedY]) on screen in [view]? (Its pulse asks for idle frames only then.) */
    fun onScreen(view: RealmView, deedX: Int, deedY: Int): Boolean = place(view, deedX, deedY, box)

    /** Draw the box of open deed ([deedX], [deedY]) into the bound screen pass. False when off screen or not drawn. */
    fun draw(program: Gl3Program, view: RealmView, deedX: Int, deedY: Int): Boolean {
        drawn = false
        if (!place(view, deedX, deedY, box)) { shownX = -1; return false }
        // the web's CSS animation restarts whenever the box is shown again (display none → block): a new deed, or back on screen
        if (deedX != shownX || deedY != shownY) { shownX = deedX; shownY = deedY; startMs = view.pulseMs }
        x = box[0]; y = box[1]; w = box[2]; h = box[3]; fill = box[4]
        alpha = if (view.reducedMotion || view.frozen) 1.0 else pulse(view.pulseMs - startMs)
        val dpr = view.dpr; val th = view.targetH
        val sx0 = max(0, floor((x - RING_CSS) * dpr).toInt()); val sx1 = min(view.targetW, ceil((x + w + RING_CSS) * dpr).toInt())
        val sy0 = max(0, floor(th - (y + h + RING_CSS) * dpr).toInt()); val sy1 = min(th, ceil(th - (y - RING_CSS) * dpr).toInt())
        if (sx1 <= sx0 || sy1 <= sy0 || !core.use(program)) return false
        val gl = core.gl
        // its own state, whatever a lane pass left (the same pair as [rehearse]: a live first draw is a pipeline build)
        core.disable(GL20.GL_DEPTH_TEST); core.colorMask(true, true, true, true)
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        core.enable(GL20.GL_SCISSOR_TEST); core.scissor(sx0, sy0, sx1 - sx0, sy1 - sy0)
        // uBox: the border's outer edge in target px, GL rows (bottom-up); uLook: ring, border, inner line (px), tint alpha
        gl.uniform4f(program.uniform(core, "uBox"), (x * dpr).toFloat(), (th - (y + h) * dpr).toFloat(), ((x + w) * dpr).toFloat(), (th - y * dpr).toFloat())
        gl.uniform4f(program.uniform(core, "uLook"), (RING_CSS * dpr).toFloat(), (BORDER_CSS * dpr).toFloat(), (INSET_CSS * dpr).toFloat(), fill.toFloat())
        gl.uniform1f(program.uniform(core, "uAlpha"), alpha.toFloat())
        core.fullscreen()
        core.disable(GL20.GL_SCISSOR_TEST); core.disable(GL20.GL_BLEND)
        drawn = true
        return true
    }

    /** The draw's real state inside [Gl3Core.rehearse] (screen target): depth off, blended, the full-screen triangle. */
    fun rehearse(program: Gl3Program): Boolean {
        if (!core.use(program)) return false
        val gl = core.gl
        core.disable(GL20.GL_DEPTH_TEST); core.colorMask(true, true, true, true)
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        gl.uniform4f(program.uniform(core, "uBox"), 0f, 0f, 1f, 1f)
        gl.uniform4f(program.uniform(core, "uLook"), 0f, 0f, 0f, 0f)
        gl.uniform1f(program.uniform(core, "uAlpha"), 1f)
        core.fullscreen()
        core.disable(GL20.GL_BLEND)
        return true
    }

    private fun place(view: RealmView, deedX: Int, deedY: Int, out: DoubleArray): Boolean =
        deedBox((deedX - view.x) * view.s + view.viewW / 2, (deedY - view.y) * view.s + view.viewH / 2, view.s, view.viewW, view.viewH, out)

    companion object {
        /** ui.js `deedBox`: never under 18 CSS px; clipped 8 CSS px past the screen. */
        const val MIN_CSS = 18.0
        const val CLIP_CSS = 8.0
        /** ui.js `deedBox` (36745a38): the tint alpha, 0.30 up to a 96 CSS px deed, 0.16 from half the screen's short side. */
        const val FILL_SMALL = 0.30
        const val FILL_LARGE = 0.16
        const val FILL_FROM_CSS = 96.0
        /** `.rmx-selbox`: `border: 3px`, `box-shadow: 0 0 0 2px #0b0a10, inset 0 0 0 1px #0b0a10` (border-box sizing). */
        const val BORDER_CSS = 3.0
        const val RING_CSS = 2.0
        const val INSET_CSS = 1.0
        /** `animation: rmx-selp 1.6s ease-in-out infinite`, `@keyframes rmx-selp { 50% { opacity: .6 } }`. */
        const val PULSE_MS = 1600L
        const val PULSE_LOW = 0.6

        /**
         * ui.js `deedBox(sx, sy, s, W, H)` into [out]: the box's top-left x, y and w, h (CSS px, rounded like the web's
         * `Math.round`), then its tint alpha. [sx], [sy]: the deed's top-left on screen; [s]: CSS px per deed; [viewW] ×
         * [viewH]: the screen. False when the box is off screen.
         */
        fun deedBox(sx: Double, sy: Double, s: Double, viewW: Double, viewH: Double, out: DoubleArray): Boolean {
            val m = max(s, MIN_CSS); val cx = sx + s / 2; val cy = sy + s / 2
            val x0 = max(-CLIP_CSS, cx - m / 2); val y0 = max(-CLIP_CSS, cy - m / 2)
            val x1 = min(viewW + CLIP_CSS, cx + m / 2); val y1 = min(viewH + CLIP_CSS, cy + m / 2)
            if (x1 <= x0 || y1 <= y0) return false
            out[0] = jsRound(x0); out[1] = jsRound(y0); out[2] = jsRound(x1 - x0); out[3] = jsRound(y1 - y0)
            val grow = ((s - FILL_FROM_CSS) / max(1.0, min(viewW, viewH) / 2 - FILL_FROM_CSS)).coerceIn(0.0, 1.0)
            out[4] = FILL_SMALL - (FILL_SMALL - FILL_LARGE) * grow
            return true
        }

        /** The box's opacity [t] ms into its animation: 1 → 0.6 at 0.8 s → 1 at 1.6 s, CSS `ease-in-out` in each half. */
        fun pulse(t: Long): Double {
            val u = Math.floorMod(t, PULSE_MS).toDouble() / PULSE_MS * 2
            return if (u < 1) 1 - (1 - PULSE_LOW) * easeInOut(u) else PULSE_LOW + (1 - PULSE_LOW) * easeInOut(u - 1)
        }

        /** CSS `ease-in-out` = cubic-bezier(0.42, 0, 0.58, 1): solve x(t) = [u] (Newton), return y(t). */
        fun easeInOut(u: Double): Double {
            if (u <= 0.0) return 0.0
            if (u >= 1.0) return 1.0
            var t = u
            for (i in 0 until 8) {
                val dx = bezier(t, 0.42, 0.58) - u; val slope = bezierSlope(t, 0.42, 0.58)
                if (abs(dx) < 1e-9 || slope < 1e-6) break
                t = (t - dx / slope).coerceIn(0.0, 1.0)
            }
            return bezier(t, 0.0, 1.0)
        }

        private fun bezier(t: Double, p1: Double, p2: Double): Double = 3 * (1 - t) * (1 - t) * t * p1 + 3 * (1 - t) * t * t * p2 + t * t * t
        private fun bezierSlope(t: Double, p1: Double, p2: Double): Double = 3 * (1 - t) * (1 - t) * p1 + 6 * (1 - t) * t * (p2 - p1) + 3 * t * t * (1 - p2)
        private fun jsRound(v: Double): Double = floor(v + 0.5)
    }
}
