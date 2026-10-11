package gg.pixelkingdomwars.nativeclient.renderer

import kotlin.math.PI
import kotlin.math.cos

/** Presentation colours for the overlay rectangles (web `BaseScene` VALID_TINT / BLOCKED_TINT and the HUD
 * gold). The renderer is presentation only: none of these reach the sim or an order. */
object HighlightColors {
    /** Palette.gold: a selected footprint's outline and soft fill. */
    const val GOLD = 0xE3AE3C
    /** Palette.goldHi: the selection's corner ticks. */
    const val GOLD_HI = 0xF4D77B
    /** Web VALID_TINT: a footprint the app's own placement check accepts. */
    const val VALID = 0x8CB36E
    /** Web BLOCKED_TINT / Palette.danger: a footprint the app's own placement check refuses. */
    const val BLOCKED = 0xC75A2E
    /** Palette.ink: the faint plot grid under a building being placed or moved. */
    const val INK = 0x1A171E

    /** Validity the app knows reads green / red; validity only the server can answer (`null`) stays neutral gold. */
    fun footprint(valid: Boolean?): Int = when (valid) { true -> VALID; false -> BLOCKED; null -> GOLD }
}

/** An axis-aligned world-space rectangle the shape pass fills. */
data class HighlightRect(val x: Float, val y: Float, val width: Float, val height: Float)

/** Pure geometry for the selection and placement chrome (web `showSelection`, `showFootprintTint`,
 * `drawPlacementGrid`). Everything is in world units; callers convert dp through [worldPerDp]. */
object HighlightGeometry {
    /** Web `placementFootprintPx` family: strokes are sized in CSS px ÷ zoom; on Android that is dp × zoom. */
    const val OUTLINE_DP = 2f
    const val TICK_DP = 6f
    const val GRID_LINE_DP = 1f
    /** The selection outline breathes one dp outward and back. */
    const val BREATH_DP = 1f
    const val BREATH_PERIOD_SECONDS = 1.6f
    const val STROKE_ALPHA = 0.95f

    /** World units per density-independent pixel for the current camera zoom. */
    fun worldPerDp(density: Float, zoom: Float): Float = density * zoom

    /** A closed outline of `thickness` centred on the rectangle's edges, as four non-overlapping bars so a
     * translucent colour never double-blends where they meet. */
    fun outlineSegments(x: Float, y: Float, width: Float, height: Float, thickness: Float): List<HighlightRect> {
        val half = thickness / 2
        val inner = (height - thickness).coerceAtLeast(0f)
        return listOf(
            HighlightRect(x - half, y - half, width + thickness, thickness),
            HighlightRect(x - half, y + height - half, width + thickness, thickness),
            HighlightRect(x - half, y + half, thickness, inner),
            HighlightRect(x + width - half, y + half, thickness, inner),
        )
    }

    /** Web `ovl_select_corner`: an L bracket at each corner, `thickness` thick and `length` long along both
     * edges, centred on the outline. The two arms of a bracket share their corner square. */
    fun cornerTicks(x: Float, y: Float, width: Float, height: Float, length: Float, thickness: Float): List<HighlightRect> {
        val half = thickness / 2
        val right = x + width; val bottom = y + height
        return listOf(
            HighlightRect(x - half, y - half, length, thickness), HighlightRect(x - half, y - half, thickness, length),
            HighlightRect(right + half - length, y - half, length, thickness), HighlightRect(right - half, y - half, thickness, length),
            HighlightRect(right + half - length, bottom - half, length, thickness), HighlightRect(right - half, bottom + half - length, thickness, length),
            HighlightRect(x - half, bottom - half, length, thickness), HighlightRect(x - half, bottom + half - length, thickness, length),
        )
    }

    /** A one-tile footprint (a wall) keeps its outline but no ticks: brackets swamp the piece they mark
     * (web `showSelection`). Larger footprints get `requested`, capped at a third of the footprint's short
     * side so a zoomed-out base never shows brackets bigger than the building they mark. */
    fun tickLength(widthTiles: Float, heightTiles: Float, requested: Float, shortSideWorld: Float = Float.MAX_VALUE): Float =
        if (widthTiles > 1f || heightTiles > 1f) minOf(requested, shortSideWorld / 3f).coerceAtLeast(0f) else 0f

    /** Lines every tile across the rectangle, both outer edges included (web `drawPlacementGrid`). */
    fun gridLines(x: Float, y: Float, columns: Int, rows: Int, tile: Float, thickness: Float): List<HighlightRect> {
        require(columns > 0 && rows > 0 && tile > 0f)
        val half = thickness / 2
        val width = columns * tile; val height = rows * tile
        val lines = ArrayList<HighlightRect>(columns + rows + 2)
        for (column in 0..columns) lines += HighlightRect(x + column * tile - half, y - half, thickness, height + thickness)
        for (row in 0..rows) lines += HighlightRect(x - half, y + row * tile - half, width + thickness, thickness)
        return lines
    }

    /** Selection breathing on the renderer's own frame clock: 0 → 1 → 0 over [BREATH_PERIOD_SECONDS];
     * still under reduced motion. */
    fun breath(seconds: Float, reducedMotion: Boolean, periodSeconds: Float = BREATH_PERIOD_SECONDS): Float {
        if (reducedMotion || periodSeconds <= 0f) return 0f
        val phase = (seconds % periodSeconds + periodSeconds) % periodSeconds
        return ((1 - cos(2 * PI * phase / periodSeconds)) / 2).toFloat().coerceIn(0f, 1f)
    }
}
