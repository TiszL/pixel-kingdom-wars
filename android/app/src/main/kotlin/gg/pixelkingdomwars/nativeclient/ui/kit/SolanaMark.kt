package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/*
 * Design component: the SOL mark. The Solana logomark (three slanted bars: the top and bottom bars lean the same way, the
 * middle bar is mirrored; bar : gap = 2 : 1; 45 degree ends) drawn as pixel art in code, so every "sol" icon is the same
 * crisp mark at a whole number of device pixels per mark pixel. It replaces the bundled 24 px bitmap
 * `pkw_web_icon_sol.png` (a copy of the web master `art/game-v4/ui/legacy-ui_icon_sol.png`, which stays bundled and
 * untouched) wherever the client asked for "sol": [PkwIcon] (and through it HubArt, MapIcon and the cluster icons) and
 * `ui.chrome.GameArt` (price buttons, payment plates).
 *
 * Grid key: `.` clear, `x` ink outline ([PkwTokens.Colors.ink], the icon family's outline, so the light green end still
 * reads on parchment), `0`..`5` the six gradient steps from Solana purple to Solana green. The steps follow the logo's
 * own diagonal (bottom-left purple, top-right green); their boundaries are clean 2 : 1 pixel lines. Pure data; the shape,
 * the slants, the gradient direction and the outline are checked in `SolanaMarkTest`.
 */

/** The mark's pixels, 21 wide and 18 tall: three 16-pixel bars of 4 rows, 2-row gaps, a 1-pixel ink outline. */
internal val SOLANA_MARK: List<String> = listOf(
    "....xxxxxxxxxxxxxxxx.",
    "...x4444444555555555x",
    "..x3344444444555555x.",
    ".x3333344444444555x..",
    "x3333333344444444x...",
    ".xxxxxxxxxxxxxxxx....",
    ".xxxxxxxxxxxxxxxx....",
    "x2222223333333344x...",
    ".x2222222333333333x..",
    "..x2222222233333333x.",
    "...x2222222223333333x",
    "....xxxxxxxxxxxxxxxx.",
    "....xxxxxxxxxxxxxxxx.",
    "...x1111111222222222x",
    "..x0011111111222222x.",
    ".x0000011111111222x..",
    "x0000000011111111x...",
    ".xxxxxxxxxxxxxxxx....",
)

internal const val SOLANA_MARK_W = 21
internal const val SOLANA_MARK_H = 18

/**
 * The six gradient steps (ARGB): Solana's brand purple #9945FF, four even straight-sRGB blends, Solana's brand green
 * #14F195. Brand colours, not game numbers.
 */
internal val SOLANA_GRADIENT_ARGB: List<Long> = listOf(0xFF9945FF, 0xFF7E67EA, 0xFF648AD5, 0xFF49ACBF, 0xFF2FCFAA, 0xFF14F195)

/** The art size of the kit's currency icons; the mark takes the scale a 24 px icon gets in the same box. */
private const val NEIGHBOUR_ICON_PX = 24

/** The icon names that draw the SOL mark: the kit / GameArt currency name and the web atlas key of the old bitmap. */
fun isSolanaMark(name: String): Boolean = name == "sol" || name == "ui_icon_sol"

/**
 * Device px per mark pixel in a [boxW] x [boxH] px box: the whole scale the kit gives a 24 px icon there
 * ([integerArtScale], so the mark's pixels match its neighbours' in a price pill), lowered until the 21 x 18 mark fits
 * inside the box. At density 2.625 (Seeker): 12 dp → 1, 16 and 20 dp → 2, 24 dp → 3, 36 dp → 4, 48 dp → 5.
 * 1 for a box smaller than the mark; 0 (draw nothing) for an empty or invalid box.
 */
internal fun solanaMarkScale(boxW: Float, boxH: Float): Int {
    if (!boxW.isFinite() || !boxH.isFinite() || boxW < 1f || boxH < 1f) return 0
    val neighbour = minOf(integerArtScale(boxW, NEIGHBOUR_ICON_PX), integerArtScale(boxH, NEIGHBOUR_ICON_PX))
    // The epsilon keeps an exact fit (63 px / 21) from losing a step to float rounding.
    val fits = minOf(((boxW + 1e-3f) / SOLANA_MARK_W).toInt(), ((boxH + 1e-3f) / SOLANA_MARK_H).toInt())
    return maxOf(1, minOf(neighbour, fits))
}

/** One horizontal run of same-coloured mark pixels. */
private class MarkRun(val x: Int, val y: Int, val length: Int, val color: Color)

/** The grid as runs, built once: 18 rows draw as a few dozen rects. */
private val SOLANA_MARK_RUNS: List<MarkRun> by lazy {
    val palette = SOLANA_GRADIENT_ARGB.map { Color(it) }
    buildList<MarkRun> {
        SOLANA_MARK.forEachIndexed { y, row ->
            var x = 0
            while (x < row.length) {
                val cell = row[x]
                var end = x + 1
                while (end < row.length && row[end] == cell) end++
                val color = when (cell) {
                    'x' -> PkwTokens.Colors.ink
                    in '0'..'5' -> palette[cell - '0']
                    else -> null
                }
                if (color != null) add(MarkRun(x, y, end - x, color))
                x = end
            }
        }
    }
}

/** Draws the mark centred in this scope at [solanaMarkScale], every edge on a whole device pixel. */
internal fun DrawScope.drawSolanaMark(alpha: Float = 1f) {
    val k = solanaMarkScale(size.width, size.height)
    if (k <= 0) return
    val step = k.toFloat()
    val x0 = ((size.width - SOLANA_MARK_W * k) / 2f).roundToInt().toFloat()
    val y0 = ((size.height - SOLANA_MARK_H * k) / 2f).roundToInt().toFloat()
    for (run in SOLANA_MARK_RUNS) {
        drawRect(run.color, Offset(x0 + run.x * step, y0 + run.y * step), Size(run.length * step, step), alpha = alpha)
    }
}

/** The SOL mark in a [size] box (the same box a 24 px currency icon would get). */
@Composable fun SolanaMark(size: Dp, modifier: Modifier = Modifier, contentDescription: String? = null, alpha: Float = 1f) {
    val described = if (contentDescription == null) Modifier else Modifier.semantics { this.contentDescription = contentDescription }
    Canvas(modifier.size(size).then(described)) { drawSolanaMark(alpha) }
}

@Preview(name = "SOL mark at 12, 16, 20, 24, 36, 48 dp on parchment and on charcoal", widthDp = 360, heightDp = 150)
@Composable private fun SolanaMarkPreview() {
    Column {
        for (surface in listOf(PkwTokens.Colors.parchment, PkwTokens.Colors.charcoal)) {
            Row(Modifier.background(surface).padding(8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically) {
                for (side in listOf(12, 16, 20, 24, 36, 48)) SolanaMark(side.dp)
            }
        }
    }
}
