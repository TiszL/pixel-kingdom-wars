package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import kotlin.math.abs

/**
 * The dive/leave cross-fade drawn in GL (GLOBE-NATIVE-PLAN §3.5). The web cross-fades two canvases with CSS
 * (`#realm` and `#globe` opacity over .45 s `ease`); native has one surface, so the realm view is rendered ONCE into
 * a snapshot texture (offscreen, RGBA8 at the buffer size) and composited over the live globe frame with the realm's
 * opacity: rising on a dive, falling on a leave. Both cameras are still during the fade (the dive's flight has ended;
 * the leave holds the last realm frame), so one snapshot is exact.
 *
 * The rule the host reads every frame: [fading] frames carry no compile, rehearsal or upload (plan §3.5, §5.3). The
 * composite's own (program, state) pair is rehearsed with the realm's pairs before the dive is allowed.
 */
class RealmDiveFade(private val core: Gl3Core, private val fadeMs: Double) {
    var phase = NONE; private set
    private var t0 = 0.0
    var snapshot: Gl3Texture? = null; private set

    val fading: Boolean get() = phase != NONE

    /** The snapshot target at the buffer size (allocated on first use; CORE pool: the swapchain/driver line). */
    fun snapshotTarget(width: Int, height: Int): Gl3Texture? {
        val s = snapshot
        if (s != null && s.ready && s.width == width && s.height == height) return s
        core.free(s)
        snapshot = core.texture2D(Gl3Pool.CORE, width, height, Gl3Format.RGBA8)
        return snapshot
    }

    /** What the snapshot holds: the realm view (drawn over the live globe) or the globe (plan §3.5's dive: the last
     *  globe frame, drawn by the globe engine into [snapshotTarget], over the live realm). */
    var snapshotIsRealm = true; private set

    fun start(kind: Int, nowMs: Double, snapshotIsRealm: Boolean = true) {
        require(kind == DIVE || kind == LEAVE); phase = kind; t0 = nowMs; this.snapshotIsRealm = snapshotIsRealm
    }

    /** The composite's opacity: the realm's share when the snapshot is the realm, the globe's when it is the globe. */
    fun snapshotAlpha(nowMs: Double): Double = if (snapshotIsRealm) realmAlpha(nowMs) else 1.0 - realmAlpha(nowMs)

    /** Eased progress 0..1 of the running fade (CSS `ease`). */
    fun progress(nowMs: Double): Double = if (phase == NONE) 1.0 else cssEase(((nowMs - t0) / fadeMs).coerceIn(0.0, 1.0))

    /** The realm snapshot's opacity over the globe: rising on a dive, falling on a leave; 1 or 0 at rest. */
    fun realmAlpha(nowMs: Double): Double = when (phase) { DIVE -> progress(nowMs); LEAVE -> 1.0 - progress(nowMs); else -> 1.0 }

    fun done(nowMs: Double): Boolean = phase != NONE && nowMs - t0 >= fadeMs

    /** End the fade and free the snapshot (glDelete only). */
    fun finish() { phase = NONE; core.free(snapshot); snapshot = null }

    /** Draw the snapshot over the current screen pass with [alpha] (blend SRC_ALPHA, ONE_MINUS_SRC_ALPHA, depth off). */
    fun composite(program: Gl3Program, alpha: Double) {
        val snap = snapshot ?: return
        if (!snap.ready || alpha <= 0.0 || !core.use(program)) return
        core.disable(GL20.GL_DEPTH_TEST)
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        core.bindTexture(0, snap)
        core.gl.uniform1i(program.uniform(core, "uSnap"), 0)
        core.gl.uniform1f(program.uniform(core, "uAlpha"), alpha.toFloat())
        core.fullscreen()
        core.disable(GL20.GL_BLEND)
    }

    /** The composite's real state inside [Gl3Core.rehearse] (screen target), sampling [stand] (any RGBA8 texture). */
    fun rehearse(program: Gl3Program, stand: Gl3Texture): Boolean {
        if (!stand.ready || !core.use(program)) return false
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        core.bindTexture(0, stand)
        core.gl.uniform1i(program.uniform(core, "uSnap"), 0); core.gl.uniform1f(program.uniform(core, "uAlpha"), 1f)
        core.fullscreen()
        core.disable(GL20.GL_BLEND)
        return true
    }

    fun dispose() { core.free(snapshot); snapshot = null; phase = NONE }

    companion object {
        const val NONE = 0
        const val DIVE = 1
        const val LEAVE = 2

        /** CSS `ease` = cubic-bezier(0.25, 0.1, 0.25, 1): y at the curve parameter whose x is [x]. */
        fun cssEase(x: Double): Double {
            if (x <= 0.0) return 0.0
            if (x >= 1.0) return 1.0
            val x1 = 0.25; val y1 = 0.1; val x2 = 0.25; val y2 = 1.0
            fun bx(t: Double) = ((1 - 3 * x2 + 3 * x1) * t + (3 * x2 - 6 * x1)) * t * t + 3 * x1 * t
            fun by(t: Double) = ((1 - 3 * y2 + 3 * y1) * t + (3 * y2 - 6 * y1)) * t * t + 3 * y1 * t
            fun dx(t: Double) = (3 * (1 - 3 * x2 + 3 * x1) * t + 2 * (3 * x2 - 6 * x1)) * t + 3 * x1
            var t = x
            for (i in 0 until 8) { val e = bx(t) - x; if (abs(e) < 1e-9) return by(t); val d = dx(t); if (abs(d) < 1e-9) break; t -= e / d }
            var lo = 0.0; var hi = 1.0; t = x
            for (i in 0 until 60) { val v = bx(t); if (abs(v - x) < 1e-9) break; if (v < x) lo = t else hi = t; t = (lo + hi) / 2 }
            return by(t)
        }

        /** The plan's dive/leave cross-fade length (GLOBE-NATIVE-PLAN §3.5; the web's `#realm` `.45s` transition). */
        const val PLAN_FADE_MS = 450.0
    }
}
