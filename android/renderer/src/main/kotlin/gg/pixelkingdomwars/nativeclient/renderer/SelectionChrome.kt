package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.graphics.glutils.ShaderProgram

/**
 * The designed selection marker on the base (design-beacon final `selected.png` and `voyage/lodge-selected.png`,
 * DESIGN-SYSTEM §Selection, TOKENS.json colour + motion). The base is a top-down grid, so the final frames draw a
 * stepped FOOTPRINT FRAME under the sprite (selected.html: "selection on a top-down grid: stepped footprint frame
 * (3 x 2 tiles of 30 dp, 3 dp gold over 7 dp ink)"), not the iso diamond the v1 frames and the older spec text show:
 *  - a soft gold-hi fill over the footprint, 18 %;
 *  - a 7 dp ink stroke, then a 3 dp gold-hi stroke, on the footprint edge, each corner cut by one 4 dp step;
 *  - an inner dashed 2 dp gold ring (6 on / 6 off) at 70 %, 8 dp inside the edge;
 *  - a 2 dp gold-hi outline on the sprite itself (four 2 dp offset draws of the sprite as a flat silhouette).
 * Everything here is pure presentation in world units; callers convert dp through [HighlightGeometry.worldPerDp].
 * The emitters are `inline` so the renderer draws them every frame without allocating.
 */
object SelectionChrome {
    /** TOKENS.json `color.ink.hex`: every outline. */
    const val INK = 0x140F17
    /** TOKENS.json `color.gold.hex`: the inner dashed ring. */
    const val GOLD = 0xE3AE3C
    /** TOKENS.json `color.gold.hi`: the frame's rim, its soft fill and the sprite outline. */
    const val GOLD_HI = 0xFFE38A

    const val INK_DP = 7f
    const val RIM_DP = 3f
    /** One corner step (DESIGN-SYSTEM §Shape: corners are stepped, radius is always 0). */
    const val STEP_DP = 4f
    const val DASH_DP = 2f
    const val DASH_ON_DP = 6f
    const val DASH_OFF_DP = 6f
    const val DASH_INSET_DP = 8f
    const val DASH_ALPHA = 0.7f
    const val SPRITE_OUTLINE_DP = 2f

    /** The design's frame is 60 dp on its short side (3 x 2 tiles of 30 dp); a footprint that small or larger on screen
     * draws the chrome at full weight. A smaller one (a wall, or any building at the far zoom) thins it in proportion so
     * 7 dp of ink never swamps the piece it marks, but never below half weight, so it still reads as selected. */
    const val FULL_WEIGHT_DP = 60f
    const val MIN_WEIGHT = 0.5f
    /** The dashed ring needs room for at least one dash on each side; below that the inner ring is left out. */
    const val MIN_INNER_DP = DASH_ON_DP * 2

    /** Chrome weight for a footprint whose short side measures [shortSideDp] on screen. */
    fun weight(shortSideDp: Float): Float =
        if (shortSideDp.isNaN()) MIN_WEIGHT else (shortSideDp / FULL_WEIGHT_DP).coerceIn(MIN_WEIGHT, 1f)

    /**
     * Lays the frame for a footprint at ([x], [y], [width], [height]) in world units, scaled by [scale] about its centre
     * (the select motion), with [worldPerDp] world units per dp. Writes into [out] so a frame per draw allocates nothing.
     */
    fun layout(out: SelectionFrame, x: Float, y: Float, width: Float, height: Float, worldPerDp: Float, scale: Float = 1f) {
        val w = width * scale; val h = height * scale
        out.x = x + (width - w) / 2; out.y = y + (height - h) / 2; out.width = w; out.height = h
        // Weighed on the footprint, not the scaled frame: the strokes hold still while the frame pops in.
        val k = if (worldPerDp > 0f) weight(minOf(width, height) / worldPerDp) else MIN_WEIGHT
        val dp = worldPerDp * k
        out.weight = k
        out.step = minOf(STEP_DP * dp, minOf(w, h) / 4)
        out.ink = INK_DP * dp; out.rim = RIM_DP * dp
        out.dash = DASH_DP * dp; out.dashOn = DASH_ON_DP * dp; out.dashOff = DASH_OFF_DP * dp
        val inset = DASH_INSET_DP * dp
        out.innerX = out.x + inset; out.innerY = out.y + inset
        out.innerWidth = w - 2 * inset; out.innerHeight = h - 2 * inset
        out.hasInner = out.innerWidth >= MIN_INNER_DP * dp && out.innerHeight >= MIN_INNER_DP * dp
    }

    /** The stepped frame's interior as three non-overlapping rectangles, so a translucent fill never double-blends. */
    inline fun steppedFill(x: Float, y: Float, width: Float, height: Float, step: Float, emit: (Float, Float, Float, Float) -> Unit) {
        if (width <= 0f || height <= 0f) return
        val s = step.coerceIn(0f, minOf(width, height) / 2)
        emit(x + s, y, width - 2 * s, height)
        if (s > 0f && height > 2 * s) {
            emit(x, y + s, s, height - 2 * s)
            emit(x + width - s, y + s, s, height - 2 * s)
        }
    }

    /**
     * A [thickness] stroke centred on the stepped path (selected.html `M8 4h84v4h4v52h-4v4H8v-4H4V8h4z`): the four edges,
     * then the two short legs of each corner's inward step. Square ends, so the outer corner keeps the step and the joins
     * close. The bars overlap where they join: draw it in an opaque colour.
     */
    inline fun steppedStroke(x: Float, y: Float, width: Float, height: Float, step: Float, thickness: Float,
                             emit: (Float, Float, Float, Float) -> Unit) {
        if (width <= 0f || height <= 0f || thickness <= 0f) return
        val s = step.coerceIn(0f, minOf(width, height) / 2); val t = thickness; val half = t / 2
        val right = x + width; val bottom = y + height
        emit(x + s - half, y - half, width - 2 * s + t, t)
        emit(x + s - half, bottom - half, width - 2 * s + t, t)
        emit(x - half, y + s - half, t, height - 2 * s + t)
        emit(right - half, y + s - half, t, height - 2 * s + t)
        if (s <= 0f) return
        emit(x - half, y + s - half, s + t, t); emit(x + s - half, y - half, t, s + t)
        emit(right - s - half, y - half, t, s + t); emit(right - s - half, y + s - half, s + t, t)
        emit(right - s - half, bottom - s - half, s + t, t); emit(right - s - half, bottom - s - half, t, s + t)
        emit(x + s - half, bottom - s - half, t, s + t); emit(x - half, bottom - s - half, s + t, t)
    }

    /**
     * The inner dashed ring: dashes of [on] with gaps of [off], walked clockwise from the top-left corner with the phase
     * carried round the corners (SVG `stroke-dasharray`), butt ends. Each edge owns the corner square at its start: a
     * dash that turns a corner runs through that square once (the edge before stops half a stroke short of it), so the
     * pieces never overlap and the translucent ring never double-blends.
     */
    inline fun dashedRect(x: Float, y: Float, width: Float, height: Float, thickness: Float, on: Float, off: Float,
                          emit: (Float, Float, Float, Float) -> Unit) {
        if (width <= 0f || height <= 0f || thickness <= 0f || on <= 0f || off <= 0f) return
        val half = thickness / 2; val period = on + off
        var start = 0f
        for (edge in 0 until 4) {
            val length = if (edge % 2 == 0) width else height
            var k = (start / period).toInt()
            while (k * period < start + length) {
                val dashStart = k * period; val dashEnd = dashStart + on
                val a = maxOf(dashStart, start) - start; val b = minOf(dashEnd, start + length) - start
                if (b > a) {
                    val from = if (dashStart <= start) a - half else a
                    // The last edge ends at the first corner, whose square the first dash always owns.
                    val to = if (dashEnd > start + length || (edge == 3 && dashEnd >= start + length)) b - half else b
                    if (to > from) when (edge) {
                        0 -> emit(x + from, y - half, to - from, thickness)
                        1 -> emit(x + width - half, y + from, thickness, to - from)
                        2 -> emit(x + width - to, y + height - half, to - from, thickness)
                        else -> emit(x - half, y + height - to, thickness, to - from)
                    }
                }
                k++
            }
            start += length
        }
    }

    /** CSS `cubic-bezier(x1, y1, x2, y2)` at [progress] (0..1): solve x(t) = progress by bisection, return y(t). */
    fun cubicBezier(x1: Float, y1: Float, x2: Float, y2: Float, progress: Float): Float {
        val x = progress.coerceIn(0f, 1f)
        if (x == 0f || x == 1f) return x
        var lo = 0f; var hi = 1f
        for (step in 0 until 24) {
            val mid = (lo + hi) / 2
            if (bezier(mid, x1, x2) < x) lo = mid else hi = mid
        }
        return bezier((lo + hi) / 2, y1, y2)
    }
    /** TOKENS.json `motion.easing.out`: cubic-bezier(0.2, 0, 0, 1). */
    fun easeOut(progress: Float): Float = cubicBezier(0.2f, 0f, 0f, 1f, progress)
    /** TOKENS.json `motion.easing.in`: cubic-bezier(0.4, 0, 1, 1). */
    fun easeIn(progress: Float): Float = cubicBezier(0.4f, 0f, 1f, 1f, progress)
    private fun bezier(t: Float, p1: Float, p2: Float): Float { val u = 1 - t; return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t }
}

/** One laid-out selection frame in world units ([SelectionChrome.layout]); reused every frame. */
class SelectionFrame {
    var x = 0f; var y = 0f; var width = 0f; var height = 0f
    var weight = 1f
    var step = 0f; var ink = 0f; var rim = 0f
    var dash = 0f; var dashOn = 0f; var dashOff = 0f
    var innerX = 0f; var innerY = 0f; var innerWidth = 0f; var innerHeight = 0f
    var hasInner = false
}

/**
 * The selection marker's motion (DESIGN-SYSTEM §Motion "Select building", buildings/SPEC.md §1.7, TOKENS.json):
 *  - select: the frame scales 0.8 → 1 and the sprite outline fades in, 140 ms, easing `out`;
 *  - select another building: the frame cross-moves to it, 140 ms, easing `out`;
 *  - deselect: the reverse, 120 ms, easing `in`;
 *  - reduced motion: no scale and no move; the marker cross-fades in 120 ms.
 * Tile units; driven by frame deltas only (never wall-clock). A re-show of the same footprint is a no-op, so a routine
 * refresh never restarts it.
 */
class SelectionMotion {
    private enum class Phase { HIDDEN, ENTER, MOVE, REST, EXIT }
    private var phase = Phase.HIDDEN
    private var elapsed = 0f
    private var reduced = false
    private var fromX = 0f; private var fromY = 0f; private var fromW = 0f; private var fromH = 0f
    private var toX = 0f; private var toY = 0f; private var toW = 0f; private var toH = 0f
    private var exitFromScale = 1f; private var exitFromRing = 1f; private var exitFromOutline = 1f

    /** The frame's footprint (before [scale]) in tiles. */
    var tileX = 0f; private set
    var tileY = 0f; private set
    var width = 0f; private set
    var height = 0f; private set
    /** Scale about the footprint's centre. */
    var scale = 1f; private set
    /** The frame's opacity: 1 except under reduced motion, where the marker cross-fades. */
    var ringAlpha = 0f; private set
    /** The sprite outline's opacity. */
    var outlineAlpha = 0f; private set
    val visible: Boolean get() = phase != Phase.HIDDEN

    fun show(x: Float, y: Float, w: Float, h: Float, reducedMotion: Boolean) {
        if (phase != Phase.HIDDEN && phase != Phase.EXIT && x == toX && y == toY && w == toW && h == toH) return
        val moving = (phase == Phase.ENTER || phase == Phase.MOVE || phase == Phase.REST) && !reducedMotion
        fromX = tileX; fromY = tileY; fromW = width; fromH = height
        toX = x; toY = y; toW = w; toH = h
        reduced = reducedMotion; elapsed = 0f
        phase = if (moving) Phase.MOVE else Phase.ENTER
        update()
    }

    fun hide() {
        if (phase == Phase.HIDDEN || phase == Phase.EXIT) return
        exitFromScale = scale; exitFromRing = ringAlpha; exitFromOutline = outlineAlpha
        elapsed = 0f; phase = Phase.EXIT
        update()
    }

    /** Drops the marker at once (another base, a battle). */
    fun reset() { phase = Phase.HIDDEN; elapsed = 0f; ringAlpha = 0f; outlineAlpha = 0f; scale = 1f }

    fun advance(seconds: Float) {
        if (phase == Phase.HIDDEN || phase == Phase.REST) return
        elapsed += seconds.coerceAtLeast(0f)
        update()
    }

    private fun update() {
        when (phase) {
            Phase.HIDDEN -> Unit
            Phase.REST -> { place(toX, toY, toW, toH); scale = 1f; ringAlpha = 1f; outlineAlpha = 1f }
            Phase.ENTER -> {
                val duration = if (reduced) REDUCED_SECONDS else SELECT_SECONDS
                val p = (elapsed / duration).coerceIn(0f, 1f); val e = SelectionChrome.easeOut(p)
                place(toX, toY, toW, toH)
                scale = if (reduced) 1f else ENTER_SCALE + (1f - ENTER_SCALE) * e
                ringAlpha = if (reduced) e else 1f
                outlineAlpha = e
                if (p >= 1f) phase = Phase.REST
            }
            Phase.MOVE -> {
                val p = (elapsed / SELECT_SECONDS).coerceIn(0f, 1f); val e = SelectionChrome.easeOut(p)
                place(fromX + (toX - fromX) * e, fromY + (toY - fromY) * e, fromW + (toW - fromW) * e, fromH + (toH - fromH) * e)
                scale = 1f; ringAlpha = 1f; outlineAlpha = 1f
                if (p >= 1f) phase = Phase.REST
            }
            Phase.EXIT -> {
                val duration = if (reduced) REDUCED_SECONDS else DESELECT_SECONDS
                val p = (elapsed / duration).coerceIn(0f, 1f); val e = SelectionChrome.easeIn(p)
                scale = if (reduced) exitFromScale else exitFromScale + (ENTER_SCALE - exitFromScale) * e
                ringAlpha = if (reduced) exitFromRing * (1f - e) else exitFromRing
                outlineAlpha = exitFromOutline * (1f - e)
                if (p >= 1f) reset()
            }
        }
    }
    private fun place(x: Float, y: Float, w: Float, h: Float) { tileX = x; tileY = y; width = w; height = h }

    companion object {
        /** TOKENS.json `motion.durationMs.select`. */
        const val SELECT_SECONDS = 0.14f
        /** DESIGN-SYSTEM §Motion "Select building": reverse 120 ms. */
        const val DESELECT_SECONDS = 0.12f
        /** DESIGN-SYSTEM §Motion: reduced motion cross-fades in 120 ms. */
        const val REDUCED_SECONDS = 0.12f
        const val ENTER_SCALE = 0.8f
    }
}

/** The sprite outline's silhouette pass: texture alpha × batch alpha in the batch colour, texture RGB discarded (a
 * flat-colour copy of the sprite). Same SpriteBatch attribute contract as [HitFillShader]. */
object SelectionOutlineShader {
    /** Null when the device cannot compile it: the outline is decoration, so the frame still draws without it. */
    fun create(): ShaderProgram? = ShaderProgram(HitFillShader.vertex, fragment).let { if (it.isCompiled) it else { it.dispose(); null } }
    val fragment = """
        #ifdef GL_ES
        precision mediump float;
        #define LOWP lowp
        #else
        #define LOWP
        #endif
        varying LOWP vec4 v_color;
        varying vec2 v_texCoords;
        uniform sampler2D u_texture;
        void main() {
            gl_FragColor=vec4(v_color.rgb,texture2D(u_texture,v_texCoords).a*v_color.a);
        }
    """.trimIndent()
}
