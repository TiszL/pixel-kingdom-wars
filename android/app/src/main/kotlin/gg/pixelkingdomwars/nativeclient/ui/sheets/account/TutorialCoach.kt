package gg.pixelkingdomwars.nativeclient.ui.sheets.account

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.Presence
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import kotlin.math.roundToInt

/**
 * Design component: the first-Home tutorial (design/final/account/onboard-first-home.png, SPEC §1.2): a dashed gold
 * rectangle (3 dp, ink 2 dp) around the step's target building, a gold pointer 44 × 52 bouncing 6 dp above it (900 ms
 * loop), and a charcoal plate 236 × 58 "STEP 1 OF 4" / "Tap your Keep to open it" placed under the target (or above it,
 * [coachPlateTop]). Steps 1-4: Keep → BUILD → ATTACK → MAP. The "free camp" status segment and the land herald are the
 * HUD's (`HomeHudUi`, `HeraldUi`), driven by [landHeraldShown].
 *
 * Pointer rule: PAINT ONLY. The coach fills the HUD layer but has no clickable, pointerInput or scrim, and its plate is
 * not a scene-input region: the player's tap goes straight through to the building (the normal select), which is the
 * step's whole point.
 */

/** One tutorial step (SPEC §1.2 `TutorialUiState`). */
@Immutable data class TutorialUi(
    /** 1-based. */
    val step: Int,
    val total: Int,
    /** "Tap your Keep to open it". */
    val text: String,
    /** The building the step points at (the mount projects its sprite bounds to [TutorialCoach]'s `target`). */
    val targetBuildingId: String?,
)

/**
 * The tutorial coach. [target] is the target's bounds in this composable's own pixel space (the world layer projects the
 * building's sprite each frame); null draws the plate only (a deck step: the mount passes the deck button's bounds).
 * Pass [ui] null to hide it (120 ms fade).
 *
 * Pointer rule: paint only. No clickable, pointerInput, scrim or scene-input region anywhere, so every tap reaches the
 * kingdom (the step's target building) underneath.
 */
@Composable fun TutorialCoach(ui: TutorialUi?, target: Rect?, modifier: Modifier = Modifier) {
    Presence(ui, PkwTokens.Motion.PLATE_IN, COACH_OUT_MS) { shown, progress, _, reduced ->
        CoachLayer(shown, target, progress, still = reduced || LocalInspectionMode.current, modifier = modifier)
    }
}

@Composable private fun CoachLayer(shown: TutorialUi, target: Rect?, progress: () -> Float, still: Boolean, modifier: Modifier) {
    val bounce = if (still) null else rememberInfiniteTransition(label = "coach").animateFloat(0f, 1f,
        infiniteRepeatable(tween(PkwTokens.Motion.READY_BOUNCE_LOOP / 2, easing = PkwTokens.Motion.Out), RepeatMode.Reverse), label = "bounce")
    val density = LocalDensity.current
    BoxWithConstraints(modifier.fillMaxSize().graphicsLayer { alpha = progress() }) {
        val areaH = with(density) { maxHeight.toPx() }
        val areaW = with(density) { maxWidth.toPx() }
        if (target != null) {
            Canvas(Modifier.fillMaxSize().clearAndSetSemantics { }) {
                val pad = 6.dp.toPx()
                val r = Rect(target.left - pad, target.top - pad, target.right + pad, target.bottom + pad)
                val dash = PathEffect.dashPathEffect(floatArrayOf(10.dp.toPx(), 6.dp.toPx()))
                drawRect(PkwTokens.Colors.ink, r.topLeft, r.size, style = Stroke(width = 7.dp.toPx(), pathEffect = dash))
                drawRect(PkwTokens.Colors.gold.face, r.topLeft, r.size, style = Stroke(width = 3.dp.toPx(), pathEffect = dash))
                // The pointer: a gold down-arrow 44 × 52 above the rect, bouncing 6 dp.
                val lift = 6.dp.toPx() * (bounce?.value ?: 0f)
                val pw = 44.dp.toPx(); val ph = 52.dp.toPx()
                val left = r.center.x - pw / 2f; val top = r.top - ph - 6.dp.toPx() - lift
                drawPointer(Offset(left, top), Size(pw, ph))
            }
        }
        with(density) {
            val plateW = COACH_PLATE_W.toPx(); val plateH = COACH_PLATE_H.toPx(); val gap = 14.dp.toPx()
            val top = if (target != null) coachPlateTop(target.top, target.bottom, plateH, areaH, gap) else areaH * 0.62f
            val left = ((target?.center?.x ?: (areaW / 2f)) - plateW / 2f).coerceIn(8.dp.toPx(), (areaW - plateW - 8.dp.toPx()).coerceAtLeast(8.dp.toPx()))
            Plate(PlateKind.CHARCOAL, Modifier.offset { IntOffset(left.roundToInt(), top.roundToInt()) }.width(COACH_PLATE_W)
                .clearAndSetSemantics { contentDescription = "Step ${shown.step} of ${shown.total}. ${shown.text}"; liveRegion = LiveRegionMode.Polite },
                contentPadding = PaddingValues(start = 12.dp, top = 6.dp, end = 12.dp, bottom = 8.dp), blocksScene = false) {
                Column {
                    PkwText("STEP ${shown.step} OF ${shown.total}", PkwTokens.Type.caption, color = PkwTokens.Colors.gold.hi, outline = 1.dp)
                    PkwText(shown.text, PkwTokens.Type.body, color = PkwTokens.Colors.text, maxLines = 2)
                }
            }
        }
    }
}

private val COACH_PLATE_W = 236.dp
private val COACH_PLATE_H = 58.dp
/** The coach's exit (SPEC §1.2: rect and plate fade 120 ms on the target tap). */
private const val COACH_OUT_MS = 120

/** A stepped gold down-arrow with an ink rim (drawn in code: no pointer art exists). */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawPointer(at: Offset, size: Size) {
    val w = size.width; val h = size.height
    fun arrow(inset: Float) = Path().apply {
        moveTo(at.x + w * 0.30f + inset, at.y + inset)
        lineTo(at.x + w * 0.70f - inset, at.y + inset)
        lineTo(at.x + w * 0.70f - inset, at.y + h * 0.52f)
        lineTo(at.x + w - inset * 1.6f, at.y + h * 0.52f)
        lineTo(at.x + w / 2f, at.y + h - inset * 1.8f)
        lineTo(at.x + inset * 1.6f, at.y + h * 0.52f)
        lineTo(at.x + w * 0.30f + inset, at.y + h * 0.52f)
        close()
    }
    drawPath(arrow(0f), PkwTokens.Colors.ink)
    drawPath(arrow(3.dp.toPx()), PkwTokens.Colors.gold.face)
    drawRect(PkwTokens.Colors.gold.hi, Offset(at.x + w * 0.30f + 3.dp.toPx(), at.y + 3.dp.toPx()), Size(w * 0.40f - 6.dp.toPx(), 3.dp.toPx()))
}

@Preview(name = "Tutorial step 1 (onboard-first-home.png)", widthDp = 412, heightDp = 915)
@Composable private fun TutorialPreview() {
    Box(Modifier.fillMaxSize().background(androidx.compose.ui.graphics.Color(0xFF4E7A35))) {
        val d = LocalDensity.current
        val target = with(d) { Rect(150.dp.toPx(), 380.dp.toPx(), 262.dp.toPx(), 486.dp.toPx()) }
        Box(Modifier.offset(150.dp, 380.dp).size(112.dp, 106.dp).background(androidx.compose.ui.graphics.Color(0xFF8C8478)))
        TutorialCoach(TutorialUi(1, 4, "Tap your Keep to open it", "keep"), target)
    }
}
