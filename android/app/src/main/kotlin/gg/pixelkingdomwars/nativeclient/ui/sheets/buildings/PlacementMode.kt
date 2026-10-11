package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.ChunkyBox
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.PriceChip
import gg.pixelkingdomwars.nativeclient.ui.kit.QuietButton
import gg.pixelkingdomwars.nativeclient.ui.kit.priceDescription
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import kotlin.math.roundToInt

/*
 * Design component: placement mode (design/final/buildings/SPEC.md §4, placement.png, placement-blocked.png) in two
 * pieces, because the band is HUD and the ghost is world:
 * - [PlacementStrip]: the hint pill, the shelf, red CANCEL, the charcoal info plate and the green PLACE with its cost pill
 *   and the blocked / no-builder reason pill under it.
 * - [PlacementGhost]: the 18 % tint, the grid over the buildable area, the N × N footprint (green valid / red taken tiles
 *   with a white X), the lifted ghost with its outline and idle bob, the four drag arrows, and the drag itself (snapped per
 *   tile through `onMove`). It needs the scene's screen geometry ([PlacementGeometry]); world → screen is the scene's job.
 * Walls keep today's drag-to-paint placement (owner addendum 3); this mode is for single buildings.
 */

/** Placement states (SPEC §4.3 + [VERIFYING] from DESIGN CORRECTION 7). */
enum class PlacementState {
    /** Every tile free: green PLACE (once the price is a server price). */
    VALID,
    /** Some tiles taken: red tiles, PLACE off + "Spot is blocked"; one buzz on entering (the caller's haptic). */
    BLOCKED,
    /** The price is not known yet: PLACE stone + dots, pill "…". */
    CHECKING_PRICE,
    /** Not enough to pay: PLACE off, red pill; a tap opens Need-more. */
    SHORT,
    /** No free builder: PLACE off + "No free builder"; the plate shows when one frees up; a tap opens Builders. */
    NO_BUILDER,
    /** The order is out: PLACE stone + dots, the ghost is locked. */
    SENDING,
    /** The server refused: back to the VALID look; the host's blood toast carries `failureLine` + Report. The ghost stays. */
    ERROR,
    /** The answer was lost: PLACE stone + dots, ghost locked, "Checking with the server" + Report, never re-sendable. */
    VERIFYING,
}

/** Everything placement draws (SPEC §4.3). Every number arrives formatted; unknown is "…". */
@Immutable data class PlacementUi(
    /** The building type ("workshop"). */
    val type: String,
    /** The PS name on the plate ("WORKSHOP"). */
    val name: String,
    /** The ghost's tier-1 art (`ui:workshop-t1-idle` or an existing GameArt name). */
    val ghostArt: String,
    /** The footprint edge in tiles (Workshop 4 = 4 × 4). */
    val footprint: Int,
    /** The footprint's top-left tile on the base grid (what `onMove` changes). */
    val tile: IntOffset,
    /** Taken tiles, relative to the footprint's top-left (0..footprint-1). Computed locally for feedback; the server
     *  re-checks on PLACE. */
    val takenTiles: Set<IntOffset>,
    /** The build price (CostPill above PLACE). */
    val price: PriceUi,
    /** The build time ("2h"). */
    val time: String,
    /** Builders as the plate shows them ("1/2"; NO_BUILDER: "free in 2h 14m"). */
    val builders: String,
    /** The state. */
    val state: PlacementState,
    /** Overrides the hint pill; null uses `placementHint`. */
    val hint: String?,
    /** Overrides the reason pill under PLACE (BLOCKED / NO_BUILDER / VERIFYING); null uses the default words. */
    val reason: String?,
    /** Rectangular catalogue footprints retain their real height; older square callers need no adapter. */
    val footprintHeight: Int = footprint,
    /** Price words drawn above PLACE instead of the cost pill when the price is not one amount (hero recruitment:
     *  "Uses 1 hero contract · no KEEP"); [price] then only decides whether PLACE may open the review. */
    val priceLine: String? = null,
)

/** Placement callbacks (SPEC §4.3, plus the routes SHORT / NO_BUILDER / VERIFYING need so PLACE never sends from them). */
class PlacementActions(
    /** The ghost was dragged to this top-left tile (snapped). The scene re-checks occupancy and updates the Ui. */
    val onMove: (IntOffset) -> Unit,
    /** Sends the order. Only called when `placeLook(...).tap == PlaceTap.PLACE`. */
    val onPlace: () -> Unit,
    /** CANCEL / Back: leave placement and restore the tray at its scroll position. */
    val onCancel: () -> Unit,
    /** SHORT: PLACE or the red pill opens Need-more for this currency. */
    val onNeedMore: (Currency) -> Unit = {},
    /** NO_BUILDER: PLACE opens Builders. */
    val onBuilders: () -> Unit = {},
    /** VERIFYING: the "Report" link. */
    val onReport: () -> Unit = {},
)

/**
 * Where the scene draws the footprint, in screen px (the overlay root must fill the screen from the window origin, as the
 * command bar's does). [footprint] is the N × N tile square at [PlacementUi.tile]; [tilePx] one tile (30 dp at placement
 * zoom); [buildable] the area the grid lines cover (null: no grid); [ghost] the sprite's box at this zoom (null: 1.4 ×
 * the footprint width, bottom-aligned, from the mock's 168 dp ghost over a 120 dp footprint; the world lane should pass the
 * real one).
 */
@Immutable data class PlacementGeometry(val footprint: PxRect, val tilePx: Float, val buildable: PxRect? = null, val ghost: PxRect? = null)

/** The tint over the world in placement (SPEC §4.1 `rgba(20,30,40,.18)`). */
private val PLACEMENT_TINT = Color(0x2E141E28)
private val GRID_LINE = Color(0x21FFFFFF)
private val TILE_VALID = Color(0x6B94D870)
private val TILE_VALID_RIM = Color(0xFF94D870)
private val TILE_TAKEN = Color(0x8CC9452E)
private val TILE_TAKEN_RIM = Color(0xFFC9452E)
private val GHOST_BLOCKED = Color(0xFFF08A68)
private const val GHOST_BLOCKED_ALPHA = 0.72f
/** Mock ratio: the 168 dp ghost over a 120 dp footprint. */
private const val GHOST_PER_FOOTPRINT = 1.4f
/** The ghost's drop on enter (12 dp above, scale 0.9 → 1, 180 ms `pop`, SPEC §4.4). */
private const val GHOST_DROP_MS = 180

/**
 * The placement band (placement.png bottom): shelf, red CANCEL (x 16), the charcoal plate (x 98, name + time + builders),
 * the green PLACE (W-136) with its cost pill above, and the ink reason pill under PLACE; plus the hint pill centred at y 128.
 * PLACE follows [placeLook]: it sends only from a payable VALID / ERROR; SHORT routes to Need-more and NO_BUILDER to
 * Builders; SENDING / CHECKING_PRICE / VERIFYING show stone dots.
 *
 * Pointer rule: this root is a full-size, transparent layout with NO clickable, pointerInput, draggable or scrim. The
 * shelf and the pills are paint only; only CANCEL, the plate, the cost pill and PLACE take touches, so a drag, pinch or tap
 * anywhere else reaches the kingdom (the scene moves the ghost on a ground tap and pans at the edges).
 */
@Composable fun PlacementStrip(ui: PlacementUi, on: PlacementActions, modifier: Modifier = Modifier) {
    val c = PkwTokens.Colors
    val look = placeLook(ui.state, ui.price, ui.reason)
    val nav = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    val hint = placementHint(ui.state, ui.hint)
    BoxWithConstraints(modifier.fillMaxSize()) {
        // The hint pill (VT 20, ink 86 %) under the status bar, its top at y 128 as measured on placement.png (y 129..159), so it
        // clears the resource stack (y 10..120) instead of overlapping its last row by 8 dp (owner 2026-10-06: nothing overlaps).
        Box(Modifier.align(Alignment.TopCenter).statusBarsPadding().padding(top = 128.dp)
            .background(c.ink.copy(alpha = 0.86f)).padding(horizontal = 12.dp, vertical = 4.dp)
            .clearAndSetSemantics { contentDescription = hint; liveRegion = LiveRegionMode.Polite }) {
            PkwText(hint, PkwTokens.Type.body, color = c.text)
        }
        // The shelf (same as the command bar's): ink 18 % for 16 dp from H-163, then 36 % to the bottom with a 2 dp line.
        Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(163.dp + nav).drawBehind {
            val step = 16.dp.toPx()
            drawRect(c.ink.copy(alpha = 0.18f), Offset.Zero, Size(size.width, step))
            drawRect(c.ink.copy(alpha = PkwTokens.Scrim.COMMAND_SHELF), Offset(0f, step), Size(size.width, size.height - step))
            drawRect(c.ink.copy(alpha = 0.5f), Offset(0f, step), Size(size.width, 2.dp.toPx()))
        })
        // CANCEL: red 68 × 68, top H-107, caption 5 below.
        Column(Modifier.align(Alignment.BottomStart).padding(start = 16.dp, bottom = nav + 12.dp),
            horizontalAlignment = Alignment.CenterHorizontally) {
            ChunkyBox(c.red, on.onCancel, "Cancel placement", Modifier.size(PkwTokens.Dims.command),
                enabled = ui.state != PlacementState.SENDING) {
                PkwIcon("shape:close", 36.dp, tint = c.label)
            }
            PkwText("CANCEL", PkwTokens.Type.caption, Modifier.padding(top = 5.dp), color = c.label, outline = 1.dp)
        }
        // The info plate: 166 × 72 at x 98, top H-109 (narrower when the screen is under 412 dp, never under PLACE).
        val plateW = (maxWidth - 98.dp - 136.dp - 6.dp).coerceIn(100.dp, 166.dp)
        Plate(PlateKind.CHARCOAL, Modifier.align(Alignment.BottomStart).padding(start = 98.dp, bottom = nav + 37.dp).size(plateW, 72.dp)
            .clearAndSetSemantics { contentDescription = "${ui.name}. Takes ${ui.time}. Builders ${ui.builders}" },
            contentPadding = PaddingValues(start = 10.dp, top = 6.dp, end = 8.dp, bottom = 8.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                PkwText(ui.name, PkwTokens.Type.label, color = c.gold.hi, outline = 1.dp)
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (placementPlateShowsTime(ui.state)) {
                        PkwIcon("timer", 24.dp)
                        PkwText(ui.time, PkwTokens.Type.body, color = c.text)
                        Spacer(Modifier.width(4.dp))
                    }
                    PkwIcon("builder", 30.dp)
                    PkwText(ui.builders, PkwTokens.Type.body, Modifier.weight(1f, fill = false), color = c.text)
                }
            }
        }
        // PLACE: 120 × 92 at W-136, top H-127, the cost pill 4 above; the reason pill under it.
        Column(Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = nav + 35.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (ui.priceLine == null) {
                val pill = if (ui.state == PlacementState.SHORT && ui.price.status == PriceStatus.OK) ui.price.copy(status = PriceStatus.SHORT)
                    else if (ui.state == PlacementState.CHECKING_PRICE) ui.price.copy(status = PriceStatus.CHECKING) else ui.price
                PriceChip(pill, onClick = if (look.tap == PlaceTap.NEED_MORE) ({ on.onNeedMore(ui.price.currency) }) else null)
                Spacer(Modifier.height(4.dp))
            }
            PlaceButton(ui, look, on)
        }
        // Price words that are not one amount (hero recruitment) ride above PLACE in an ink pill, right-aligned, 2 lines.
        ui.priceLine?.let { line ->
            Box(Modifier.align(Alignment.BottomEnd).padding(end = 8.dp, bottom = nav + 39.dp + PkwTokens.Dims.commandPrimaryH)
                .widthIn(max = 240.dp).background(c.ink.copy(alpha = 0.86f)).padding(horizontal = 8.dp, vertical = 2.dp)) {
                PkwText(line, PkwTokens.Type.small, color = c.gold.hi, textAlign = TextAlign.End, maxLines = 2)
            }
        }
        look.reason?.let { reason ->
            Box(Modifier.align(Alignment.BottomEnd).padding(end = 8.dp, bottom = nav + 4.dp).background(c.ink.copy(alpha = 0.86f))
                .padding(horizontal = 8.dp, vertical = 2.dp)) {
                PkwText(reason, PkwTokens.Type.small, color = GHOST_BLOCKED, textAlign = TextAlign.Center)
            }
        }
        if (ui.state == PlacementState.VERIFYING) QuietButton("Report", on.onReport,
            Modifier.align(Alignment.BottomCenter).padding(bottom = nav + 140.dp), contentDescription = "Report a problem with this placement")
    }
}

/** The green PLACE primary: drawn check 40 + PS 14 label; stone + dots while waiting; off with no tap when it cannot act. */
@Composable private fun PlaceButton(ui: PlacementUi, look: PlaceLook, on: PlacementActions) {
    val c = PkwTokens.Colors
    val spoken = listOfNotNull("Place ${ui.name}", priceDescription(ui.price), look.reason,
        if (look.dots) "waiting for the server" else null).joinToString(". ")
    val tap: () -> Unit = when (look.tap) {
        PlaceTap.PLACE -> on.onPlace
        PlaceTap.NEED_MORE -> ({ on.onNeedMore(ui.price.currency) })
        PlaceTap.BUILDERS -> on.onBuilders
        PlaceTap.NONE -> ({})
    }
    ChunkyBox(PkwTokens.ramp(look.verb), tap, spoken, Modifier.size(PkwTokens.Dims.commandPrimaryW, PkwTokens.Dims.commandPrimaryH),
        enabled = look.tap != PlaceTap.NONE) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            if (look.dots) BusyDots() else PkwIcon("shape:check", 40.dp, tint = if (look.verb == Verb.OFF) c.text else c.label)
            PkwText("PLACE", PkwTokens.Type.primary, color = if (look.verb == Verb.OFF) c.text else c.label, outline = 2.dp)
        }
    }
}

/**
 * The world half of placement (placement.png middle): tint, grid over the buildable area, the footprint tiles (valid
 * `#94D870` 42 % with a 2 dp rim; taken `#C9452E` 55 % with a rim and a white X), the ghost lifted 6 dp with a 2 dp outline
 * (`#F08A68` at 72 % when blocked) and a 2 dp idle bob, and four drag arrows 18 dp outside the footprint. Drag anywhere on
 * the footprint + 24 dp: the ghost snaps per tile ([tileStep]) and [PlacementActions.onMove] gets the new top-left tile;
 * the footprint glides 60 ms to the new square. SENDING / VERIFYING lock the ghost. Draws nothing while [geometry] is null.
 *
 * Pointer rule: this root is a full-size, transparent layout with NO pointer handling; the tint and grid are paint only.
 * The only touch target is the footprint's hit box (≥ 48 dp, a scene-input region); taps, pinches and pans elsewhere
 * reach the scene, which moves the ghost on a ground tap and pans when a drag nears the edge.
 */
@Composable fun PlacementGhost(ui: PlacementUi, geometry: PlacementGeometry?, on: PlacementActions, modifier: Modifier = Modifier) {
    val g = geometry ?: return
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    val density = LocalDensity.current
    val look = placeLook(ui.state, ui.price, ui.reason)
    val blocked = ui.state == PlacementState.BLOCKED
    val snap = tween<Float>(if (reduced) 0 else PkwTokens.Motion.PAINT_TILE, easing = PkwTokens.Motion.Out)
    val left by animateFloatAsState(g.footprint.left, snap, label = "footprint-x")
    val top by animateFloatAsState(g.footprint.top, snap, label = "footprint-y")
    val dx = left - g.footprint.left; val dy = top - g.footprint.top
    var dragging by remember { mutableStateOf(false) }
    val drop = remember { Animatable(if (still || reduced) 1f else 0f) }
    LaunchedEffect(Unit) { drop.animateTo(1f, tween(GHOST_DROP_MS, easing = PkwTokens.Motion.Pop)) }
    val bob = if (reduced || still) 0f else rememberInfiniteTransition(label = "bob").animateFloat(0f, 1f,
        infiniteRepeatable(tween(PkwTokens.Motion.READY_BOUNCE_LOOP, easing = LinearEasing), RepeatMode.Reverse), label = "bob").value
    val flash = remember { Animatable(0f) }
    LaunchedEffect(blocked) { if (blocked && !reduced) { flash.snapTo(1f); flash.animateTo(0f, tween(PkwTokens.Motion.SNAP_HINT)) } }

    Box(modifier.fillMaxSize()) {
        Canvas(Modifier.fillMaxSize()) {
            drawRect(PLACEMENT_TINT)
            g.buildable?.let { area -> drawGrid(area, g.footprint, g.tilePx) }
            val n = ui.footprint.coerceAtLeast(1); val h = ui.footprintHeight.coerceAtLeast(1)
            val t = g.tilePx; val rim = 2.dp.toPx()
            for (ty in 0 until h) for (tx in 0 until n) {
                val taken = IntOffset(tx, ty) in ui.takenTiles
                val o = Offset(left + tx * t, top + ty * t)
                drawRect(if (taken) TILE_TAKEN else TILE_VALID, o, Size(t, t))
                drawRect(if (taken) TILE_TAKEN_RIM else TILE_VALID_RIM, Offset(o.x + rim / 2, o.y + rim / 2), Size(t - rim, t - rim), style = Stroke(rim))
                if (taken) {
                    val arm = 8.dp.toPx(); val cx = o.x + t / 2; val cy = o.y + t / 2; val w = 2.5f.dp.toPx()
                    drawLine(Color.White, Offset(cx - arm, cy - arm), Offset(cx + arm, cy + arm), w, StrokeCap.Square)
                    drawLine(Color.White, Offset(cx - arm, cy + arm), Offset(cx + arm, cy - arm), w, StrokeCap.Square)
                }
            }
            if (flash.value > 0f) drawRect(TILE_TAKEN_RIM.copy(alpha = 0.5f * flash.value), Offset(left, top), Size(n * t, h * t))
        }
        val ghost = g.ghost ?: run {
            val w = g.footprint.width * GHOST_PER_FOOTPRINT
            PxRect(g.footprint.centerX - w / 2f, g.footprint.bottom - w, g.footprint.centerX + w / 2f, g.footprint.bottom)
        }
        val lift = with(density) { 6.dp.toPx() } + (if (dragging) 0f else bob * with(density) { 2.dp.toPx() })
        val dropPx = (1f - drop.value) * with(density) { 12.dp.toPx() }
        with(density) {
            BuildingArt(ui.ghostArt, ghost.width.toDp(),
                Modifier.offset { IntOffset((ghost.left + dx).roundToInt(), (ghost.top + dy - lift - dropPx).roundToInt()) }
                    .graphicsLayer { val s = 0.9f + 0.1f * drop.value; scaleX = s; scaleY = s }
                    .clearAndSetSemantics { },
                alpha = if (blocked) GHOST_BLOCKED_ALPHA else 1f, outline = if (blocked) GHOST_BLOCKED else TILE_VALID_RIM)
            if (look.draggable) {
                val arrow = 24.dp.toPx(); val gap = 18.dp.toPx(); val f = g.footprint
                DragArrow(0f, IntOffset((f.centerX + dx - arrow / 2).roundToInt(), (minOf(f.top, ghost.top - lift) + dy - gap - arrow).roundToInt()))
                DragArrow(90f, IntOffset((f.right + dx + gap).roundToInt(), ((f.top + f.bottom) / 2 + dy - arrow / 2).roundToInt()))
                DragArrow(180f, IntOffset((f.centerX + dx - arrow / 2).roundToInt(), (f.bottom + dy + gap).roundToInt()))
                DragArrow(270f, IntOffset((f.left + dx - gap - arrow).roundToInt(), ((f.top + f.bottom) / 2 + dy - arrow / 2).roundToInt()))
            }
        }
        GhostDragArea(ui, g, look.draggable, on) { dragging = it }
    }
}

/** 1 dp white 13 % grid lines over [area], in phase with the footprint's tiles. */
private fun androidx.compose.ui.graphics.drawscope.DrawScope.drawGrid(area: PxRect, phase: PxRect, tile: Float) {
    if (tile <= 1f) return
    val w = 1.dp.toPx()
    var x = area.left + ((phase.left - area.left) % tile + tile) % tile
    while (x <= area.right) { drawRect(GRID_LINE, Offset(x, area.top), Size(w, area.height)); x += tile }
    var y = area.top + ((phase.top - area.top) % tile + tile) % tile
    while (y <= area.bottom) { drawRect(GRID_LINE, Offset(area.left, y), Size(area.width, w)); y += tile }
}

/** One 24 dp drag arrow (the kit's up glyph, white with its ink, rotated by [degrees]). Paint only. */
@Composable private fun DragArrow(degrees: Float, at: IntOffset) {
    PkwIcon("shape:up", 24.dp, Modifier.offset { at }.rotate(degrees).clearAndSetSemantics { }, tint = Color.White)
}

/**
 * The drag hit box: the footprint + 24 dp each side, frozen where the drag started so the moving footprint does not shift
 * the finger's coordinates. Each whole-tile step from the start calls onMove(start tile + step) once.
 */
@Composable private fun GhostDragArea(ui: PlacementUi, g: PlacementGeometry, enabled: Boolean, on: PlacementActions, onDragging: (Boolean) -> Unit) {
    // Locked (SENDING / VERIFYING): no hit box at all, so the footprint area passes touches to the scene.
    if (!enabled) return
    val density = LocalDensity.current
    var origin by remember { mutableStateOf<PxRect?>(null) }
    val box = origin ?: g.footprint
    val pad = with(density) { 24.dp.toPx() }
    val currentUi by rememberUpdatedState(ui)
    val currentTile by rememberUpdatedState(g.tilePx)
    val currentFootprint by rememberUpdatedState(g.footprint)
    val currentOn by rememberUpdatedState(on)
    val currentDragging by rememberUpdatedState(onDragging)
    with(density) {
        Box(Modifier.offset { IntOffset((box.left - pad).roundToInt(), (box.top - pad).roundToInt()) }
            .size((box.width + 2 * pad).toDp(), (box.height + 2 * pad).toDp())
            .sceneInputRegion()
            .clearAndSetSemantics { contentDescription = "${ui.name} ghost. Drag to move it" }
            .pointerInput(Unit) {
                var start = IntOffset.Zero
                var total = Offset.Zero
                var last = 0 to 0
                detectDragGestures(
                    onDragStart = { start = currentUi.tile; total = Offset.Zero; last = 0 to 0; origin = currentFootprint; currentDragging(true) },
                    onDragEnd = { origin = null; currentDragging(false) },
                    onDragCancel = { origin = null; currentDragging(false) },
                ) { change, amount ->
                    change.consume()
                    total += amount
                    val step = tileStep(total.x, total.y, currentTile)
                    if (step != last) { last = step; currentOn.onMove(IntOffset(start.x + step.first, start.y + step.second)) }
                }
            })
    }
}

// ---- Previews (sample data only; the real Ui comes from Codex's mapper and the scene's geometry) ----

private val samplePlacement = PlacementUi(type = "workshop", name = "WORKSHOP", ghostArt = "ui:workshop-t1-idle", footprint = 4,
    tile = IntOffset(12, 9), takenTiles = emptySet(), price = PriceUi(Currency.SHARDS, "40,000", PriceStatus.OK), time = "2h",
    builders = "1/2", state = PlacementState.VALID, hint = null, reason = null)

private val previewPlacementActions = PlacementActions(onMove = {}, onPlace = {}, onCancel = {})

@Composable private fun PlacementPreviewFrame(ui: PlacementUi) {
    val density = LocalDensity.current
    val geometry = with(density) {
        val left = 146.dp.toPx(); val top = 395.dp.toPx(); val side = 120.dp.toPx()
        PlacementGeometry(PxRect(left, top, left + side, top + side), 30.dp.toPx(), buildable = PxRect(0f, 330.dp.toPx(), 412.dp.toPx(), 760.dp.toPx()))
    }
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        PlacementGhost(ui, geometry, previewPlacementActions)
        PlacementStrip(ui, previewPlacementActions)
    }
}

@Preview(name = "Placement: valid (placement.png)", widthDp = 412, heightDp = 915)
@Composable private fun PlacementValidPreview() = PlacementPreviewFrame(samplePlacement)

@Preview(name = "Placement: blocked (placement-blocked.png)", widthDp = 412, heightDp = 915)
@Composable private fun PlacementBlockedPreview() = PlacementPreviewFrame(samplePlacement.copy(state = PlacementState.BLOCKED,
    takenTiles = setOf(IntOffset(0, 2), IntOffset(1, 2), IntOffset(2, 2), IntOffset(0, 3), IntOffset(1, 3), IntOffset(2, 3))))

@Preview(name = "Placement: checking price", widthDp = 412, heightDp = 915)
@Composable private fun PlacementCheckingPreview() = PlacementPreviewFrame(samplePlacement.copy(state = PlacementState.CHECKING_PRICE,
    price = PriceUi(Currency.SHARDS, null, PriceStatus.CHECKING)))

@Preview(name = "Placement: short", widthDp = 412, heightDp = 915)
@Composable private fun PlacementShortPreview() = PlacementPreviewFrame(samplePlacement.copy(state = PlacementState.SHORT,
    price = PriceUi(Currency.SHARDS, "40,000", PriceStatus.SHORT)))

@Preview(name = "Placement: no builder", widthDp = 412, heightDp = 915)
@Composable private fun PlacementNoBuilderPreview() = PlacementPreviewFrame(samplePlacement.copy(state = PlacementState.NO_BUILDER,
    builders = "free in 2h 14m"))

@Preview(name = "Placement: sending (busy)", widthDp = 412, heightDp = 915)
@Composable private fun PlacementSendingPreview() = PlacementPreviewFrame(samplePlacement.copy(state = PlacementState.SENDING))

@Preview(name = "Placement: answer lost, being checked", widthDp = 412, heightDp = 915)
@Composable private fun PlacementVerifyingPreview() = PlacementPreviewFrame(samplePlacement.copy(state = PlacementState.VERIFYING,
    reason = failureLine("placement", authoritative = false)))
