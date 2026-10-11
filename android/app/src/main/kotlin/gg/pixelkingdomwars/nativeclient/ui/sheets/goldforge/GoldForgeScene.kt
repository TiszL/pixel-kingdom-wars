package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameMillis
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Paint
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.scale
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens

/**
 * Design component: GoldForgeScene (GF-A2), the animated dwarf foundry that is the Gold Forge sheet's living header
 * (design/final/goldforge/SPEC.md §1 `GoldForgeHero`, 204 dp; mock frame `_assets/forge-hero-1x.png`).
 *
 * The scene is data: [GoldForgeSceneUi.layers] is the draw plan ([goldForgeScenePlan], from MS-A's
 * `assets/native-goldforge/scene/scene.json` + the reference player's placement), and [GoldForgeSceneUi.art] the decoded
 * bitmaps the CALLER supplies, keyed by each layer's [GoldForgeLayerSpec.art] path. This composable never opens a file.
 * A missing bitmap skips its layer (the warm off-scene fill shows), so a partly loaded scene is never a crash.
 */
@Immutable data class GoldForgeSceneUi(
    /** The layer plan, any order (drawn by [GoldForgeLayerSpec.order]). */
    val layers: List<GoldForgeLayerSpec> = goldForgeScenePlan(),
    /** Decoded art by asset path (relative to `native-goldforge/scene/`). Atlases are horizontal strips. */
    val art: Map<String, ImageBitmap> = emptyMap(),
    val stageW: Int = GOLD_FORGE_STAGE_W,
    val stageH: Int = GOLD_FORGE_STAGE_H,
    /** The art x the crop centres on. */
    val focusX: Int = GOLD_FORGE_FOCUS_X,
    /** The scene time of the still pose (reduced motion, at rest, previews). */
    val stillAtMs: Long = GOLD_FORGE_STILL_AT_MS,
    /** Bump after a SMELT receipt: one extra spark burst at the anvil (3 smith frames). 0 = none yet. */
    val sparkBurst: Int = 0,
)

/**
 * Draws the foundry: every layer by integer-scaled frame stepping (scale = ceil(width px / 320), [FilterQuality.None]),
 * centred on art x 155 and bottom-anchored ([goldForgeViewport]); the off-stage area is `#1A120E`.
 *
 * Motion: frames step on the scene clock (each layer at its own fps and phase), the carrier walks its 10 s track and
 * mirrors on the way back, the token rides the conveyor every 3.6 s, sparks show on the smith's impact frames. The clock
 * runs only while [working] (built, not under construction, not destroyed: `GoldForgeSheetUi.sceneWorking`), only while
 * the lifecycle is at least RESUMED (it pauses below), and never with reduced motion or in previews: then every layer
 * shows its still frame at [GoldForgeSceneUi.stillAtMs]. It keeps playing through sheet motion and tab switches because
 * it lives in the sheet header, not in a tab.
 *
 * Pointer rule: paint only. No click, no pointer input, no semantics (decorative; the hero's status chip speaks), so it
 * never takes a touch from anything.
 */
@Composable fun GoldForgeScene(ui: GoldForgeSceneUi, working: Boolean, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val inspection = LocalInspectionMode.current
    val animate = working && !reduced && !inspection
    val time = remember { mutableLongStateOf(ui.stillAtMs) }
    val burstUntil = remember { mutableLongStateOf(Long.MIN_VALUE) }
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(owner, animate, ui.stillAtMs) {
        if (!animate) {
            time.longValue = ui.stillAtMs
            return@LaunchedEffect
        }
        owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
            var last = -1L
            var elapsed = time.longValue
            while (true) {
                withFrameMillis { now ->
                    // Accumulate frame deltas so a pause (below RESUMED) never jumps the scene forward on resume.
                    if (last >= 0L) elapsed += (now - last).coerceIn(0L, MAX_STEP_MS)
                    last = now
                    // Publish the clock at the art's own pace: the layers step at 8-12 fps and the actors move whole art
                    // pixels, so a 60-120 Hz redraw would repaint identical frames (owner 2026-10-06: smooth and fast).
                    if (elapsed - time.longValue >= SCENE_TICK_MS) time.longValue = elapsed
                }
            }
        }
    }
    LaunchedEffect(ui.sparkBurst) {
        if (ui.sparkBurst != 0) burstUntil.longValue = time.longValue + GOLD_FORGE_SPARK_BURST_MS
    }
    val byId = remember(ui.layers) { ui.layers.associateBy { it.id } }
    // The draw list is computed once per published clock step, not once per draw call.
    val plan = remember(ui.layers, animate) { SceneDrawCache() }
    Canvas(modifier.clipToBounds().clearAndSetSemantics { }) {
        drawRect(GoldForgeColors.wellFace)
        val vp = goldForgeViewport(size.width.toInt(), size.height.toInt(), ui.stageW, ui.stageH, ui.focusX)
        // Reading the clock here (draw phase) redraws without recomposing.
        val t = time.longValue
        val burst = animate && t < burstUntil.longValue
        if (plan.draws == null || plan.t != t || plan.burst != burst) {
            plan.draws = goldForgeSceneDraws(ui.layers, t, animate, burst = burst); plan.t = t; plan.burst = burst
        }
        for (d in plan.draws.orEmpty()) {
            val layer = byId[d.id] ?: continue
            val bitmap = ui.art[layer.art] ?: continue
            drawLayer(layer, d, bitmap, vp)
        }
    }
}

/** The longest clock step one frame may add (a stalled frame must not fast-forward the actors). */
private const val MAX_STEP_MS = 100L

/** The scene clock's published step (30 per second: above the fastest layer's 12 fps and the actors' art-pixel pace). */
private const val SCENE_TICK_MS = 33L

/** The last computed draw list and the clock step it belongs to (draw-phase memo; never state). */
private class SceneDrawCache { var t = Long.MIN_VALUE; var burst = false; var draws: List<SceneDraw>? = null }

/** One layer cell at the viewport's integer scale, clipped and mirrored as planned. Straight-line: no per-draw lambdas. */
private fun DrawScope.drawLayer(layer: GoldForgeLayerSpec, d: SceneDraw, bitmap: ImageBitmap, vp: SceneViewport) {
    val cols = if (layer.cellW <= 0) 1 else (bitmap.width / layer.cellW).coerceAtLeast(1)
    val f = d.frame.coerceAtLeast(0)
    val sx = (f % cols) * layer.cellW
    val sy = (f / cols) * layer.cellH
    // A malformed atlas (too small for the planned frame) skips the layer instead of drawing a wrong cell.
    if (sx + layer.cellW > bitmap.width || sy + layer.cellH > bitmap.height) return
    val s = vp.scale
    val dx = vp.offsetX + d.left * s
    val dy = vp.offsetY + d.top * s
    val dw = layer.cellW * s
    val dh = layer.cellH * s
    val clip = layer.clip
    if (clip != null) {
        drawContext.canvas.save()
        drawContext.canvas.clipRect((vp.offsetX + clip.x * s).toFloat(), (vp.offsetY + clip.y * s).toFloat(),
            (vp.offsetX + (clip.x + clip.w) * s).toFloat(), (vp.offsetY + (clip.y + clip.h) * s).toFloat())
    }
    if (d.mirrored) {
        drawContext.canvas.save()
        drawContext.canvas.scale(-1f, 1f, dx + dw / 2f, dy + dh / 2f)
    }
    drawImage(bitmap, srcOffset = IntOffset(sx, sy), srcSize = IntSize(layer.cellW, layer.cellH),
        dstOffset = IntOffset(dx, dy), dstSize = IntSize(dw, dh), filterQuality = FilterQuality.None)
    if (d.mirrored) drawContext.canvas.restore()
    if (clip != null) drawContext.canvas.restore()
}

/** Preview stand-in art: flat blocks per layer (one shade step per frame), so the layout and order show without the
 *  real pack. Never used by the app. */
internal fun previewSceneArt(layers: List<GoldForgeLayerSpec>): Map<String, ImageBitmap> {
    val colors = listOf(Color(0xFF5A4636), Color(0xFFE88A2E), Color(0xFF7A5A3A), Color(0xFF8C6A4E), Color(0xFF6E6A66),
        Color(0xFF9A7A54), Color(0xFF4A3A2C), Color(0xFFE2B33F), Color(0xFFB0824E), Color(0xFF3A3A44), Color(0xFFFFE38A),
        Color(0xFFA0603A), Color(0xFF8A6A3A), Color(0xFFE2B33F))
    return layers.distinctBy { it.art }.associate { layer ->
        val w = layer.cellW * layer.frameCount.coerceAtLeast(1)
        val bitmap = ImageBitmap(w, layer.cellH)
        val canvas = androidx.compose.ui.graphics.Canvas(bitmap)
        val base = colors[layer.order.coerceIn(0, colors.lastIndex)]
        for (f in 0 until layer.frameCount.coerceAtLeast(1)) {
            val inset = if (layer.id == "background") 0f else (layer.cellW / 6f)
            val paint = Paint().apply { color = base.copy(alpha = if (layer.id == "background") 1f else 0.6f + 0.4f * (f % 2)) }
            canvas.drawRect(f * layer.cellW + inset, inset + (f % 3), (f + 1) * layer.cellW - inset, layer.cellH.toFloat() - inset / 2f, paint)
        }
        layer.art to bitmap
    }
}

@Preview(name = "GoldForgeScene: still pose, stand-in art (204 dp)", widthDp = 398, heightDp = 204)
@Composable private fun GoldForgeScenePreview() {
    val plan = goldForgeScenePlan(CartStage.READY)
    Box {
        GoldForgeScene(GoldForgeSceneUi(plan, previewSceneArt(plan)), working = true,
            Modifier.fillMaxWidth().height(PkwTokens.Dims.goldForgeHeaderH))
    }
}

@Preview(name = "GoldForgeScene: no art yet (off-scene fill only)", widthDp = 398, heightDp = 204)
@Composable private fun GoldForgeSceneEmptyPreview() {
    GoldForgeScene(GoldForgeSceneUi(), working = false, Modifier.fillMaxWidth().height(204.dp))
}
