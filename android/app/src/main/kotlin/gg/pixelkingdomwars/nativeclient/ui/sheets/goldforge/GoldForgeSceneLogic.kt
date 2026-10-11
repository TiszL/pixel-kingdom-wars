package gg.pixelkingdomwars.nativeclient.ui.sheets.goldforge

import androidx.compose.runtime.Immutable
import kotlin.math.abs

/*
 * The data and pure maths of the GoldForgeScene (GF-A2; design/final/goldforge/SPEC.md §1 hero): the layer draw plan of
 * MS-A's `assets/native-goldforge/scene/scene.json` (schemaVersion 1) plus the stage positions, order, clip, tracks and
 * gates of the reference player `gold-forge-scene/scene.js`, the frame stepping, and the integer-scale viewport. No
 * Compose drawing and no file access here; JVM-tested in `GoldForgeSceneLogicTest`.
 */

/** A rectangle in stage (art) pixels. */
@Immutable data class SceneRect(val x: Int, val y: Int, val w: Int, val h: Int)

/** How a track moves its layer. */
enum class TrackKind {
    /** Out from → to over the first half of [SceneTrack.periodMs], back over the second (the carrier). */
    PING_PONG,
    /** Visible only inside [SceneTrack.windowStart]..[SceneTrack.windowEnd] of each period, moving from → to with an
     *  upward arc of [SceneTrack.arcPx] at the middle (the conveyor token). */
    WINDOW,
}

/** A whole-layer motion along an authored path (scene.json `tracks`). */
@Immutable data class SceneTrack(
    val fromX: Int, val fromY: Int, val toX: Int, val toY: Int,
    val periodMs: Int,
    val kind: TrackKind = TrackKind.PING_PONG,
    val windowStart: Float = 0f,
    val windowEnd: Float = 1f,
    val arcPx: Int = 0,
    /** PING_PONG: mirror the sprite on the way back ("horizontal mirror at endpoint"). */
    val mirrorOnReturn: Boolean = false,
    /** True: the layer rests at from while the scene is still (the cart's committed travel); false: the track is read
     *  at the still time too (the carrier keeps its pose position). */
    val animatedOnly: Boolean = false,
)

/** Draw a layer only while another layer shows one of [frames] (the sparks on the smith's impact frames 5, 6, 7). */
@Immutable data class SceneGate(val layerId: String, val frames: Set<Int>)

/**
 * One layer of the foundry (scene.json `layers.<id>` + scene.js placement). [art] is the asset path relative to
 * `native-goldforge/scene/` (the caller decodes it and hands the bitmap over in [GoldForgeSceneUi.art]); an animated
 * layer's art is its horizontal atlas of [frameCount] cells of [cellW] × [cellH]. ([x], [y]) is where the cell's anchor
 * ([anchorX], [anchorY]) lands on the 320 × 192 stage. Layers draw in ascending [order].
 */
@Immutable data class GoldForgeLayerSpec(
    val id: String,
    val art: String,
    val order: Int,
    val cellW: Int,
    val cellH: Int,
    val frameCount: Int = 1,
    val fps: Int = 0,
    val anchorX: Int = 0,
    val anchorY: Int = 0,
    val x: Int = 0,
    val y: Int = 0,
    /** scene.js `phase` (seconds) in ms: shifts the frame clock so actors do not move in lock-step. */
    val phaseMs: Int = 0,
    val loop: Boolean = true,
    val mirrored: Boolean = false,
    val clip: SceneRect? = null,
    val track: SceneTrack? = null,
    val gate: SceneGate? = null,
    /** Drawn only while the scene animates (sparks, the moving token): a still scene never shows a mid-air effect. */
    val onlyWhenAnimating: Boolean = false,
    /** The frame a still scene shows (reduced motion, forge at rest, previews). */
    val stillFrame: Int = 0,
)

/** One layer placement for one frame: the cell's top-left on the stage (after the anchor and any mirror). */
data class SceneDraw(val id: String, val frame: Int, val left: Int, val top: Int, val mirrored: Boolean)

/** A track position at one time. */
data class TrackPoint(val x: Int, val y: Int, val returning: Boolean, val visible: Boolean)

/** The integer device-px scale and the device-px offset of the stage's top-left inside the header. */
data class SceneViewport(val scale: Int, val offsetX: Int, val offsetY: Int)

/** Where the ingot cart stands (scene.js `ingotStage`). */
enum class CartStage {
    /** No cart. */
    HIDDEN,
    /** Parked at the furnace mouth. */
    READY,
    /** Ingots committed today: the cart nudges 16 px back and forth while the scene animates. */
    COMMITTED,
}

/** scene.json `stage`: 320 × 192 art px. */
const val GOLD_FORGE_STAGE_W = 320
const val GOLD_FORGE_STAGE_H = 192
/** SPEC §1 crop: centred on art x = 155. */
const val GOLD_FORGE_FOCUS_X = 155
/** scene.json `impactFrames` of the smith. */
val GOLD_FORGE_IMPACT_FRAMES: Set<Int> = setOf(5, 6, 7)
/** The still pose time: the mock's t = 1840 ms (design/final/goldforge/_src/hero.py). */
const val GOLD_FORGE_STILL_AT_MS = 1840L
/** SPEC §3 SMELT success: one extra spark burst of 3 smith frames at 12 fps. */
const val GOLD_FORGE_SPARK_BURST_MS = 250L

/**
 * The foundry's draw plan, schemaVersion 1: scene.json supplies cells, frame counts, fps and anchors; scene.js the
 * placement, order, the furnace-light clip `rect(49,96,36,53)`, the phases, the carrier and conveyor tracks and the
 * impact gate. A mapper that parses scene.json may override any field with `copy`; the art paths are the scene.json
 * paths (atlases for animated layers).
 */
fun goldForgeScenePlan(cart: CartStage = CartStage.READY): List<GoldForgeLayerSpec> = listOfNotNull(
    GoldForgeLayerSpec("background", "source/background.png", 0, GOLD_FORGE_STAGE_W, GOLD_FORGE_STAGE_H),
    GoldForgeLayerSpec("furnace-light", "runtime/furnace-light/atlas.png", 1, 64, 80, frameCount = 8, fps = 8, anchorX = 32, anchorY = 80,
        x = 68, y = 156, clip = SceneRect(49, 96, 36, 53)),
    GoldForgeLayerSpec("bellows", "runtime/bellows/atlas.png", 2, 48, 48, frameCount = 8, fps = 8, anchorX = 24, anchorY = 44, x = 91, y = 158),
    GoldForgeLayerSpec("dwarf-bellows", "runtime/dwarf-bellows/atlas.png", 3, 64, 64, frameCount = 12, fps = 8, anchorX = 32, anchorY = 58,
        x = 124, y = 160, phaseMs = 250, mirrored = true),
    GoldForgeLayerSpec("coin-press", "runtime/coin-press/atlas.png", 4, 64, 64, frameCount = 8, fps = 8, anchorX = 32, anchorY = 58,
        x = 237, y = 170, phaseMs = 400),
    GoldForgeLayerSpec("workbench", "layers/workbench.png", 5, 48, 48, anchorX = 24, anchorY = 44, x = 276, y = 164),
    GoldForgeLayerSpec("coin-tray", "layers/coin-tray.png", 6, 24, 24, anchorX = 12, anchorY = 21, x = 277, y = 146),
    // The finished token on the tray: the exact KEEP mark (scene.json `token.nativePng`), drawn by its top-left.
    GoldForgeLayerSpec("keep-token", "keep-token-exact-24.png", 7, 24, 24, x = 261, y = 113),
    GoldForgeLayerSpec("dwarf-smith", "runtime/dwarf-smith/atlas.png", 8, 64, 64, frameCount = 16, fps = 12, anchorX = 32, anchorY = 58,
        x = 169, y = 176),
    GoldForgeLayerSpec("anvil", "layers/anvil.png", 9, 32, 32, anchorX = 16, anchorY = 30, x = 190, y = 184),
    GoldForgeLayerSpec("forge-sparks", "source/forge-sparks.png", 10, 64, 64, anchorX = 32, anchorY = 55, x = 190, y = 172,
        gate = SceneGate("dwarf-smith", GOLD_FORGE_IMPACT_FRAMES), onlyWhenAnimating = true),
    GoldForgeLayerSpec("dwarf-carrier", "runtime/dwarf-carrier/atlas.png", 11, 64, 64, frameCount = 8, fps = 10, anchorX = 32, anchorY = 58,
        x = 190, y = 188, phaseMs = 350, track = SceneTrack(190, 188, 277, 188, 10_000, mirrorOnReturn = true)),
    when (cart) {
        CartStage.HIDDEN -> null
        CartStage.READY -> GoldForgeLayerSpec("ingot-cart", "forge-ingots/delivery-cart.png", 12, 64, 64, anchorX = 32, anchorY = 58, x = 38, y = 190)
        CartStage.COMMITTED -> GoldForgeLayerSpec("ingot-cart", "forge-ingots/delivery-cart.png", 12, 64, 64, anchorX = 32, anchorY = 58,
            x = 38, y = 190, track = SceneTrack(38, 190, 54, 190, 10_000, animatedOnly = true))
    },
    GoldForgeLayerSpec("keep-token-conveyor", "keep-token-exact-24.png", 13, 24, 24, onlyWhenAnimating = true,
        track = SceneTrack(232, 129, 261, 129, 3_600, TrackKind.WINDOW, windowStart = 0.25f, windowEnd = 0.75f, arcPx = 5)),
)

/** The asset paths a plan needs, for the caller's loader (each decoded once, even when two layers share it). */
fun goldForgeSceneArt(layers: List<GoldForgeLayerSpec>): Set<String> = layers.mapTo(LinkedHashSet()) { it.art }

/**
 * The frame a layer shows at scene time [tMs] (scene.js `frame`: floor((t / 1000 + phase) × fps) mod count). A still
 * scene, a still layer (fps 0) or a single-frame layer shows [stillFrame]; a non-looping layer holds its last frame.
 */
fun sceneFrameIndex(tMs: Long, fps: Int, frameCount: Int, phaseMs: Int = 0, animate: Boolean = true, stillFrame: Int = 0,
    loop: Boolean = true): Int {
    if (frameCount <= 1) return 0
    if (!animate || fps <= 0) return stillFrame.coerceIn(0, frameCount - 1)
    val step = Math.floorDiv((tMs + phaseMs) * fps, 1000L)
    if (!loop) return step.coerceIn(0L, (frameCount - 1).toLong()).toInt()
    return Math.floorMod(step, frameCount.toLong()).toInt()
}

/** Where [track] puts its layer at [tMs] (scene.js carrier and conveyor maths; JS Math.round = round half up). */
fun trackPoint(track: SceneTrack, tMs: Long): TrackPoint {
    val period = track.periodMs.coerceAtLeast(1)
    val cycle = Math.floorMod(tMs, period.toLong()).toDouble() / period
    val dx = track.toX - track.fromX
    val dy = track.toY - track.fromY
    return when (track.kind) {
        TrackKind.PING_PONG -> {
            val outbound = cycle < 0.5
            val f = if (outbound) cycle * 2 else (1 - cycle) * 2
            TrackPoint(track.fromX + Math.round(f * dx).toInt(), track.fromY + Math.round(f * dy).toInt(), !outbound, true)
        }
        TrackKind.WINDOW -> {
            val start = track.windowStart.toDouble(); val end = track.windowEnd.toDouble()
            if (cycle <= start || cycle >= end || end <= start) TrackPoint(track.fromX, track.fromY, false, false)
            else {
                val p = (cycle - start) / (end - start)
                val lift = Math.round(track.arcPx * (1 - abs(2 * p - 1))).toInt()
                TrackPoint(track.fromX + Math.round(dx * p).toInt(), track.fromY + Math.round(dy * p).toInt() - lift, false, true)
            }
        }
    }
}

/**
 * Every layer to draw at scene time [tMs], back to front. [animate] false is the still scene (reduced motion, forge at
 * rest, previews): still frames, no effects, tracks at their still position. [burst] shows gated layers (the sparks)
 * regardless of their gate while animating (SPEC §3 SMELT success spark burst).
 */
fun goldForgeSceneDraws(layers: List<GoldForgeLayerSpec>, tMs: Long, animate: Boolean, burst: Boolean = false): List<SceneDraw> {
    val sorted = layers.sortedBy { it.order }
    val frames = HashMap<String, Int>(sorted.size * 2)
    sorted.forEach { frames[it.id] = sceneFrameIndex(tMs, it.fps, it.frameCount, it.phaseMs, animate, it.stillFrame, it.loop) }
    return sorted.mapNotNull { layer ->
        if (layer.onlyWhenAnimating && !animate) return@mapNotNull null
        val gate = layer.gate
        if (gate != null && !(burst && animate) && frames[gate.layerId] !in gate.frames) return@mapNotNull null
        val track = layer.track
        val point = when {
            track == null -> null
            track.animatedOnly && !animate -> TrackPoint(track.fromX, track.fromY, false, true)
            else -> trackPoint(track, tMs)
        }
        if (point != null && !point.visible) return@mapNotNull null
        val x = point?.x ?: layer.x
        val y = point?.y ?: layer.y
        val mirrored = layer.mirrored xor (point?.returning == true && track?.mirrorOnReturn == true)
        val ax = if (mirrored) layer.cellW - layer.anchorX else layer.anchorX
        SceneDraw(layer.id, frames.getValue(layer.id), x - ax, y - layer.anchorY, mirrored)
    }
}

/**
 * The header viewport (SPEC §1 GoldForgeHero): scale s = ceil(widthPx / stage width), never fractional and at least 1;
 * horizontally centred on art x [focusX] and clamped so the stage always covers the width; bottom-anchored so the
 * dwarves' feet sit on the header's bottom edge (at 2.0x density, s = 3 and art y ≈ 56..192 shows).
 */
fun goldForgeViewport(widthPx: Int, heightPx: Int, stageW: Int = GOLD_FORGE_STAGE_W, stageH: Int = GOLD_FORGE_STAGE_H,
    focusX: Int = GOLD_FORGE_FOCUS_X): SceneViewport {
    val w = widthPx.coerceAtLeast(0)
    val s = if (stageW <= 0) 1 else ((w + stageW - 1) / stageW).coerceAtLeast(1)
    val sceneW = stageW * s
    val x = (w / 2 - focusX * s).coerceIn(minOf(0, w - sceneW), 0)
    return SceneViewport(s, x, heightPx - stageH * s)
}

/** The source cell of [frame] in an atlas [atlasWidthPx] wide (frames left to right, then wrapping rows). */
fun atlasCell(frame: Int, cellW: Int, cellH: Int, atlasWidthPx: Int): Pair<Int, Int> {
    val cols = if (cellW <= 0) 1 else (atlasWidthPx / cellW).coerceAtLeast(1)
    val f = frame.coerceAtLeast(0)
    return (f % cols) * cellW to (f / cols) * cellH
}
