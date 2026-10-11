package gg.pixelkingdomwars.nativeclient.ui.sheets.editor

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens

/*
 * Design component: the layout editor's tile feedback (DESIGN-SYSTEM §6 "Paint gesture", editor.png): each painted tile
 * pops in (60 ms, 0.8 → 1) on a green tile, a tile the client already knows is taken is red with a white X and shakes
 * (160 ms), the run gets one green frame, the start tile a gold marker, and the snap guide a dashed gold line along the
 * locked axis. ERASE tiles flash red. World → screen is the scene's job: every rectangle arrives in screen px, in the
 * same pixel space as the command bar's `PxRect` (the overlay root fills the window from its origin).
 */

/** One painted (or refused) tile in screen px. [key] is stable per tile ("tx,ty") so a tile pops once, not every frame. */
@Immutable data class EditorTileUi(val key: String, val rect: PxRect, val valid: Boolean)

/** The snap guide: a dashed line across the screen at [at] px (a y for a [horizontal] run, an x for a vertical one). */
@Immutable data class SnapGuideUi(val horizontal: Boolean, val at: Float)

/** What the stroke layer draws. Empty lists and nulls draw nothing. */
@Immutable data class EditorStrokeLayerUi(
    /** The tool that made the stroke (ERASE tints the tiles red). */
    val tool: EditorTool?,
    /** The stroke's tiles: admitted ones [EditorTileUi.valid]; refused ones only when the client knows the spot is taken
     *  (the data lane's sampler emits admitted cells only, so tonight this is usually all-valid). */
    val tiles: List<EditorTileUi>,
    /** One frame around a straight run (null: no frame, e.g. after a corner). */
    val runFrame: PxRect? = null,
    /** The tile where the finger went down (gold marker). */
    val start: PxRect? = null,
    /** The axis the run is locked to. */
    val guide: SnapGuideUi? = null,
)

private val TILE_OK_FILL = Color(0x61A6EA7E)
private val TILE_ERASE_FILL = Color(0x66D23A3A)
private val TILE_TAKEN_FILL = Color(0x8CD23A3A)

/**
 * The stroke feedback over the kingdom. Mount it as a full-screen sibling under the editor's chrome while a stroke is
 * live (or mount nothing if the scene renderer already draws the tiles; never both).
 *
 * Pointer rule: paint only. The root is a full-size transparent layout with NO clickable, pointerInput, draggable or scrim,
 * and no child takes touches, so the drag that paints the walls keeps reaching the scene underneath.
 */
@Composable fun EditorStrokeLayer(ui: EditorStrokeLayerUi, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    Box(modifier.fillMaxSize().clearAndSetSemantics { }) {
        ui.guide?.let { guide ->
            Canvas(Modifier.fillMaxSize()) {
                val dash = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 6.dp.toPx()))
                val start = if (guide.horizontal) Offset(0f, guide.at) else Offset(guide.at, 0f)
                val end = if (guide.horizontal) Offset(size.width, guide.at) else Offset(guide.at, size.height)
                drawLine(c.gold.hi.copy(alpha = 0.85f), start, end, strokeWidth = 2.dp.toPx(), pathEffect = dash)
            }
        }
        ui.tiles.forEach { tile -> key(tile.key) { EditorTile(tile, ui.tool == EditorTool.ERASE) } }
        if (ui.runFrame != null || ui.start != null) Canvas(Modifier.fillMaxSize()) {
            ui.runFrame?.let { r ->
                drawRect(c.ink, Offset(r.left, r.top), Size(r.width, r.height), style = Stroke(2.dp.toPx() * 2))
                val i = 1.5.dp.toPx()
                drawRect(if (ui.tool == EditorTool.ERASE) c.red.hi else c.green.hi, Offset(r.left + i, r.top + i),
                    Size(r.width - 2 * i, r.height - 2 * i), style = Stroke(3.dp.toPx()))
            }
            ui.start?.let { s ->
                val m = 12.dp.toPx(); val o = 2.dp.toPx()
                val x = s.left - m / 2f; val y = (s.top + s.bottom) / 2f - m / 2f
                drawRect(c.ink, Offset(x - o, y - o), Size(m + 2 * o, m + 2 * o))
                drawRect(c.gold.hi, Offset(x, y), Size(m, m))
            }
        }
    }
}

/** One tile: pop in (valid) or shake (taken); reduced motion: no pop, no shake. */
@Composable private fun EditorTile(tile: EditorTileUi, erase: Boolean) {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current || reduced
    val pop = remember { Animatable(if (still) 1f else 0.8f) }
    val shake = remember { Animatable(0f) }
    LaunchedEffect(Unit) {
        if (still) return@LaunchedEffect
        if (tile.valid) pop.animateTo(1f, tween(PkwTokens.Motion.PAINT_TILE, easing = PkwTokens.Motion.Pop))
        else shake.animateTo(0f, keyframes {
            durationMillis = PkwTokens.Motion.INVALID_SHAKE
            -3f at 40; 3f at 80; -2f at 120; 0f at PkwTokens.Motion.INVALID_SHAKE
        })
    }
    val c = PkwTokens.Colors
    Canvas(Modifier.fillMaxSize()) {
        val r = tile.rect
        val dx = shake.value * density
        withTransform({
            translate(left = dx)
            scale(pop.value, pop.value, Offset((r.left + r.right) / 2f, (r.top + r.bottom) / 2f))
        }) {
            val fill = when { !tile.valid -> TILE_TAKEN_FILL; erase -> TILE_ERASE_FILL; else -> TILE_OK_FILL }
            val rim = if (!tile.valid || erase) c.red.hi else c.green.hi
            drawRect(fill, Offset(r.left, r.top), Size(r.width, r.height))
            drawRect(rim, Offset(r.left, r.top), Size(r.width, r.height), style = Stroke(2.dp.toPx()))
            if (!tile.valid) drawTakenX(r)
        }
    }
}

/** The white X on a taken tile (ink-backed so it reads on grass and sand). */
private fun DrawScope.drawTakenX(r: PxRect) {
    val inset = r.width * 0.25f
    val a = Offset(r.left + inset, r.top + inset); val b = Offset(r.right - inset, r.bottom - inset)
    val c2 = Offset(r.right - inset, r.top + inset); val d = Offset(r.left + inset, r.bottom - inset)
    drawLine(PkwTokens.Colors.ink, a, b, strokeWidth = 5.dp.toPx()); drawLine(PkwTokens.Colors.ink, c2, d, strokeWidth = 5.dp.toPx())
    drawLine(Color.White, a, b, strokeWidth = 2.5.dp.toPx()); drawLine(Color.White, c2, d, strokeWidth = 2.5.dp.toPx())
}

// ---- Preview (sample data only; the real Ui comes from the scene) ----

@Preview(name = "Editor stroke: 7 valid tiles, one taken", widthDp = 412, heightDp = 300)
@Composable private fun EditorStrokeLayerPreview() {
    val t = 90f; val y = 300f
    val tiles = (0 until 7).map { i -> EditorTileUi("$i,0", PxRect(100f + i * t, y, 100f + (i + 1) * t, y + t), valid = true) } +
        EditorTileUi("7,0", PxRect(100f + 7 * t, y, 100f + 8 * t, y + t), valid = false)
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        EditorStrokeLayer(EditorStrokeLayerUi(EditorTool.WALLS, tiles, runFrame = PxRect(100f, y, 100f + 7 * t, y + t),
            start = PxRect(100f, y, 100f + t, y + t), guide = SnapGuideUi(horizontal = true, at = y + t / 2f)))
    }
}
