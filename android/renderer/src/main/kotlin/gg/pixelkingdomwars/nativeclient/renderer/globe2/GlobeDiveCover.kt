package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPrograms

/**
 * The dive's cloud cover (owner, 2026-09-26: "add an animation of clouds covering the screen between the globe and the
 * map while zooming to mitigate the feeling of a 5 second freeze, or better, just optimize it to under 1 second").
 * D-NEXT does the second; this is the fallback for the dives that still wait: a cold first dive after an install (its
 * programs link) or a phone under memory pressure. A normal dive (READY in 0.22–0.37 s cold, a few frames warm) never
 * shows it.
 *
 * The clock (GL thread, pure, no allocation): [start] when the dive begins to wait; nothing shows before [showAfterMs];
 * then the clouds rise over [rampMs] and hold, drifting ([seconds]). [ready] (the map is ready: its snapshot fade starts
 * under the clouds) stops the rise where it is; a wait that never raised them ends them at once. [live] (the realm draws
 * live) parts them over [partMs] (from full; less from a lower cover), never onto a frozen frame. [failed] parts them onto
 * the globe. [reset] drops them at once (a leave never has clouds).
 */
class DiveCoverClock(val showAfterMs: Double = SHOW_AFTER_MS, val rampMs: Double = RAMP_MS, val partMs: Double = PART_MS) {
    private var phase = IDLE
    private var t0 = 0.0
    private var held = 0.0
    private var partT0 = 0.0
    private var partFrom = 0.0

    /** Frames are needed: the clouds are up, rising, waiting to rise, or parting. */
    val animating: Boolean get() = phase != IDLE

    fun start(nowMs: Double) { phase = WAITING; t0 = nowMs }

    fun ready(nowMs: Double) {
        if (phase != WAITING) return
        held = rise(nowMs)
        phase = if (held > 0.0) HELD else IDLE
    }

    fun live(nowMs: Double) = part(nowMs)
    fun failed(nowMs: Double) = part(nowMs)

    fun reset() { phase = IDLE }

    private fun part(nowMs: Double) {
        if (phase != WAITING && phase != HELD) return
        partFrom = if (phase == WAITING) rise(nowMs) else held
        partT0 = nowMs
        phase = if (partFrom > 0.0) PARTING else IDLE
    }

    private fun rise(nowMs: Double): Double = ((nowMs - t0 - showAfterMs) / rampMs).coerceIn(0.0, 1.0)

    /** The cover, 0 (none) to 1 (the whole screen), at [nowMs]. A parting that reached 0 ends here. */
    fun alpha(nowMs: Double): Double = when (phase) {
        WAITING -> rise(nowMs)
        HELD -> held
        PARTING -> {
            val a = partFrom - (nowMs - partT0) / partMs
            if (a <= 0.0) { phase = IDLE; 0.0 } else a
        }
        else -> 0.0
    }

    /** The drift's clock in seconds since the dive began (the clouds move while they hold). */
    fun seconds(nowMs: Double): Double = (nowMs - t0) / 1000.0

    companion object {
        /** A wait shorter than this shows nothing: every normal dive is READY before it (D-NEXT, 0.22–0.37 s cold). */
        const val SHOW_AFTER_MS = 400.0
        const val RAMP_MS = 300.0
        /** The parting, as long as the dive's snapshot fade (RealmDiveFade.PLAN_FADE_MS, 450 ms). */
        const val PART_MS = 450.0
        private const val IDLE = 0
        private const val WAITING = 1
        private const val HELD = 2
        private const val PARTING = 3
    }
}

/**
 * The cover's program: the realm engine's pinned `rm-lowres-blit` stages (its full-screen vertex stage and its fragment
 * preamble, the web's header), with a native-only body in the dive fade's style ([RealmPrograms.FADE_BODY]; the web has
 * no dive wait to cover). It samples the globe's resident c512 cloud array (R8, six faces) in screen space: two faces at
 * two scales, mirrored so no edge seams, drifting, and a threshold swept by the cover amount (0 clear, 1 every pixel
 * cloud). No new bytes, no decode. `uCover` = (amount, drift seconds, buffer width, buffer height).
 */
object GlobeDiveCover {
    const val PROGRAM = "world-dive-cover"

    const val BODY = "uniform highp sampler2DArray uCloud;\nuniform vec4 uCover;\nout vec4 o;\n" +
        "float cloudAt(vec2 p, float face) { vec2 m = abs(fract(p * 0.5) * 2.0 - 1.0); return texture(uCloud, vec3(m, face)).r; }\n" +
        "void main() {\n" +
        "  vec2 p = gl_FragCoord.xy / max(uCover.z, uCover.w);\n" +
        "  float t = uCover.y;\n" +
        "  float n = cloudAt(p * 1.1 + vec2(t * 0.020, t * 0.006), 0.0) * 0.65 + cloudAt(p * 2.3 - vec2(t * 0.011, 0.0), 3.0) * 0.35;\n" +
        "  float th = mix(1.12, -0.32, uCover.x);\n" +
        "  float a = smoothstep(th - 0.14, th + 0.14, n);\n" +
        "  vec3 c = mix(vec3(0.72, 0.78, 0.88), vec3(0.97, 0.98, 1.0), clamp(n * 1.2, 0.0, 1.0));\n" +
        "  o = vec4(c, a);\n" +
        "}\n"

    /** The cover's fragment stage from the pinned blit's (its `#version`/precision/`#define REALM_FS 1` preamble). */
    fun fragment(blitFs: String): String = RealmPrograms.fadeFs(blitFs).removeSuffix(RealmPrograms.FADE_BODY) + BODY
}
