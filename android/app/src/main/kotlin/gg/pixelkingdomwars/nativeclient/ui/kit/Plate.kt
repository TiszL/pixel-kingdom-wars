package gg.pixelkingdomwars.nativeclient.ui.kit

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.background
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import kotlin.math.roundToInt

/**
 * Design component: the plates and materials of DESIGN-SYSTEM §4-§5 (stepped corners, elevation e1-e4, VeilChip,
 * CharcoalPlate, ParchmentPanel, CreamCard, WoodFrame) and the ChunkyButton face every kit button draws.
 *
 * Everything is drawn in code with hard pixel bands; no blur, no rounded corner, no shader. The authored 16 × 16
 * `pkw_web_*` nine-slices are deliberately not used here: the design (§5) retires their look from Home. (UX-ARCHITECTURE
 * §7.1 still names a nine-slice Plate; the final design overrides it.)
 *
 * Pointer rule: a [Plate] is a painted panel, so by default it is a scene-input region (touches on it never reach the
 * kingdom). It is never full-screen and never a scrim. Pass `blocksScene = false` only for world-anchored markers that
 * must let a pan start on them.
 */

/** A stepped pixel corner shape for `clip`, `border` or `background`; the profile is in dp ([CornerProfiles]). */
class SteppedShape(private val profileDp: FloatArray) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline =
        Outline.Generic(steppedPath(0f, 0f, size.width, size.height, profilePx(profileDp, density.density)))
    override fun equals(other: Any?): Boolean = other is SteppedShape && other.profileDp.contentEquals(profileDp)
    override fun hashCode(): Int = profileDp.contentHashCode()
}

/** The design's two corner shapes: S (4 dp cut, chips, pills, faces, tiles) and M (8 dp cut, buttons, plates, cards). */
object PixelShapes {
    val S: Shape = SteppedShape(CornerProfiles.S)
    val M: Shape = SteppedShape(CornerProfiles.M)
}

/** A dp profile in whole device pixels, so steps land on the pixel grid. */
internal fun profilePx(profileDp: FloatArray, density: Float): FloatArray =
    FloatArray(profileDp.size) { (profileDp[it] * density).roundToInt().toFloat() }

internal fun steppedPath(left: Float, top: Float, width: Float, height: Float, profilePx: FloatArray): Path {
    val points = steppedPolygon(width, height, profilePx)
    return Path().apply {
        moveTo(left + points[0], top + points[1])
        var i = 2
        while (i < points.size) { lineTo(left + points[i], top + points[i + 1]); i += 2 }
        close()
    }
}

/** Fills the stepped box (l, t, r, b) with [color]. */
internal fun DrawScope.fillStepped(l: Float, t: Float, r: Float, b: Float, profileDp: FloatArray, color: Color) {
    if (r - l <= 0f || b - t <= 0f) return
    drawPath(steppedPath(l, t, r - l, b - t, profilePx(profileDp, density)), color)
}

/** Runs [block] clipped to the stepped box (l, t, r, b); coordinates stay those of the whole DrawScope. */
internal fun DrawScope.insideStepped(l: Float, t: Float, r: Float, b: Float, profileDp: FloatArray, block: DrawScope.() -> Unit) {
    if (r - l <= 0f || b - t <= 0f) return
    clipPath(steppedPath(l, t, r - l, b - t, profilePx(profileDp, density))) { block() }
}

/** A horizontal band [h] px tall at [y] across (l, r). */
internal fun DrawScope.band(l: Float, r: Float, y: Float, h: Float, color: Color) {
    if (h > 0f && r > l) drawRect(color, Offset(l, y), Size(r - l, h))
}

/** The plate materials (DESIGN-SYSTEM §5). */
enum class PlateKind {
    /** e1 HUD chip: ink S rim 2 dp, flat #221D27 face, 2 dp #3A3340 top band. */
    VEIL,
    /** e2 dark plate (name plate, toast, title plate): ink M rim 3 dp, banded surface, 2 dp inner frame, 4 dp lip. */
    CHARCOAL,
    /** Sheet body: parchment S, 3 dp light top band, 4 dp dark bottom band. No ink rim. */
    PARCHMENT,
    /** Cards, tiles, world bubbles: ink M rim 2 dp, cream, 4 dp bottom band. */
    CREAM,
    /** e4 sheet frame: ink M rim 3 dp, wood with a 2 dp seam every 12 dp, 3 dp top band, 4 dp bottom band. */
    WOOD,
}

/** The padding that keeps content inside a plate's rim, bands and lip. */
fun plateContentPadding(kind: PlateKind): PaddingValues = when (kind) {
    PlateKind.VEIL -> PaddingValues(start = 4.dp, top = 4.dp, end = 4.dp, bottom = 2.dp)
    PlateKind.CHARCOAL -> PaddingValues(start = 6.dp, top = 6.dp, end = 6.dp, bottom = 8.dp)
    PlateKind.PARCHMENT -> PaddingValues(start = 6.dp, top = 5.dp, end = 6.dp, bottom = 6.dp)
    PlateKind.CREAM -> PaddingValues(start = 4.dp, top = 4.dp, end = 4.dp, bottom = 6.dp)
    PlateKind.WOOD -> PaddingValues(start = 9.dp, top = 9.dp, end = 9.dp, bottom = 10.dp)
}

/** Paints one plate material over the whole DrawScope. [tint] replaces the face colour (selected / blood / divine). */
fun DrawScope.drawPlate(kind: PlateKind, tint: Color? = null) {
    val w = size.width; val h = size.height
    val c = PkwTokens.Colors
    fun dp(v: Float) = v * density
    when (kind) {
        PlateKind.VEIL -> {
            fillStepped(0f, 0f, w, h, CornerProfiles.S, c.ink)
            val i = dp(2f)
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                drawRect(tint ?: c.veil)
                band(i, w - i, i, dp(2f), c.veilHi)
            }
        }
        PlateKind.CHARCOAL -> {
            fillStepped(0f, 0f, w, h, CornerProfiles.M, c.ink)
            val i = dp(3f); val l = i; val t = i; val r = w - i; val b = h - i
            insideStepped(l, t, r, b, CornerProfiles.S) {
                drawRect(tint ?: c.surface)
                band(l, r, t, dp(3f), c.plateBand)
                val f = dp(2f)
                drawRect(c.border, Offset(l, t), Size(f, b - t))
                drawRect(c.border, Offset(r - f, t), Size(f, b - t))
                band(l, r, t, f, c.border)
                band(l, r, b - dp(4f), dp(4f), c.plateLip)
            }
        }
        PlateKind.PARCHMENT -> insideStepped(0f, 0f, w, h, CornerProfiles.S) {
            drawRect(tint ?: c.parchment)
            band(0f, w, 0f, dp(3f), c.parchmentHi)
            band(0f, w, h - dp(4f), dp(4f), c.parchmentLo)
        }
        PlateKind.CREAM -> {
            fillStepped(0f, 0f, w, h, CornerProfiles.M, c.ink)
            val i = dp(2f)
            insideStepped(i, i, w - i, h - i, CornerProfiles.S) {
                drawRect(tint ?: c.cream)
                band(i, w - i, h - i - dp(4f), dp(4f), c.creamLo)
            }
        }
        PlateKind.WOOD -> {
            fillStepped(0f, 0f, w, h, CornerProfiles.M, c.ink)
            val i = dp(3f); val l = i; val t = i; val r = w - i; val b = h - i
            insideStepped(l, t, r, b, CornerProfiles.S) {
                drawRect(tint ?: c.wood)
                val period = dp(12f); val seam = dp(2f)
                var y = t + dp(10f)
                while (y < b) { band(l, r, y, seam, c.woodSeam); y += period }
                band(l, r, t, dp(3f), c.woodHi)
                band(l, r, b - dp(4f), dp(4f), c.woodLo)
            }
        }
    }
}

/**
 * A plate of [kind] behind [content]. The plate sizes to its content plus [contentPadding] unless [modifier] sizes it.
 * Not clickable: put a button inside, or make the caller's modifier clickable.
 */
@Composable fun Plate(kind: PlateKind, modifier: Modifier = Modifier, contentPadding: PaddingValues = plateContentPadding(kind),
    tint: Color? = null, blocksScene: Boolean = true, content: @Composable BoxScope.() -> Unit) {
    Box(modifier.then(if (blocksScene) Modifier.sceneInputRegion() else Modifier).drawBehind { drawPlate(kind, tint) }
        .padding(contentPadding), content = content)
}

/**
 * The ChunkyButton face (DESIGN-SYSTEM §5, common.css `.btn`): an ink M shell padded 3 / 3 / [lipDp], and inside it a
 * stepped S face with a 3 dp highlight band, the face to 55 %, the mid colour below and a 5 dp lip band. [press] runs
 * 0 (up) to 1 (down): the shell's top drops by 3 dp and the lip shrinks from [lipDp] to 3 dp, so the bottom edge stays put.
 */
fun DrawScope.drawChunky(ramp: PkwTokens.Ramp, press: Float, lipDp: Float = 6f) {
    val p = press.coerceIn(-0.4f, 1f)
    fun dp(v: Float) = v * density
    val travel = dp(3f) * p
    val w = size.width; val h = size.height
    fillStepped(0f, travel, w, h, CornerProfiles.M, PkwTokens.Colors.ink)
    val l = dp(3f); val r = w - dp(3f); val t = travel + dp(3f); val b = h - dp(lipDp) + travel.coerceAtMost(dp(lipDp - 3f))
    insideStepped(l, t, r, b, CornerProfiles.S) {
        drawRect(ramp.face)
        band(l, r, t, dp(3f), ramp.hi)
        val mid = t + (b - t) * 0.55f
        band(l, r, mid, b - mid, ramp.mid)
        band(l, r, b - dp(5f), dp(5f), ramp.lo)
        if (p > 0f) {
            band(l, r, b - dp(2f), dp(2f), Color.Black.copy(alpha = 0.35f * p))
            band(l, r, t, dp(3f), Color.Black.copy(alpha = 0.18f * p))
        }
    }
}

/** How much a chunky face's content sits above centre (half the lip) so it reads centred on the face. */
internal fun chunkyContentPadding(lip: Dp = 6.dp): PaddingValues = PaddingValues(start = 3.dp, top = 3.dp, end = 3.dp, bottom = lip)

@Preview(name = "Plates", widthDp = 260, heightDp = 300)
@Composable private fun PlatesPreview() {
    Column(Modifier.background(PkwTokens.Colors.bg).padding(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PlateKind.entries.forEach { kind ->
            Plate(kind, Modifier.size(width = 200.dp, height = 44.dp), blocksScene = false) {
                PkwText(kind.name, PkwTokens.Type.caption, color = if (kind == PlateKind.PARCHMENT || kind == PlateKind.CREAM)
                    PkwTokens.Colors.textOnParch else PkwTokens.Colors.text)
            }
        }
        Box(Modifier.size(width = 120.dp, height = 52.dp).drawBehind { drawChunky(PkwTokens.Colors.green, 0f) })
    }
}
