package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kit.CornerProfiles
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import gg.pixelkingdomwars.nativeclient.ui.kit.fillStepped
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

/*
 * Design component: the building state markers over the kingdom (DESIGN-SYSTEM §6 WorldBubble / TimerPlate; buildings/SPEC
 * §1.2 "Ready bubbles collect in 1 tap without selecting", §1.5 under construction / upgrading, §4.4 "TimerPlate appears").
 * - Ready to collect: a 48 dp green WorldBubble with the output's icon and a 12 × 8 tail, bouncing 6 dp (900 ms, 2 s pause);
 *   one tap collects without selecting the building.
 * - Notice (cream bubble): something to look at (a spent trap, a finished job); a tap opens the building.
 * - Under construction / upgrading: a 114 × 34 TimerPlate (builder 30, time, 8 dp meter; striped for construction).
 * At most three on screen, nearest the camera centre first ([visibleMarkers]); all of them hide while a building is
 * selected (its NamePlate and CommandBar carry the same state, so it is never shown twice).
 * The selected building's own state (plate "Building · 1h 12m", FINISH, the disabled type action with its reason) is the
 * committed NamePlate / CommandBar in ui/command, filled by `buildingCommands()`; see MOUNT-BUILDINGS.md.
 */

/** What a marker is. */
enum class MarkerKind {
    /** Output waiting: green bubble, one tap collects. */
    READY,
    /** Something to look at: cream bubble, a tap opens the building. */
    NOTICE,
    /** Being built: TimerPlate with a striped meter. */
    CONSTRUCTION,
    /** Being upgraded: TimerPlate with a solid green meter. */
    UPGRADING,
}

/** One world marker. */
@Immutable data class BuildingMarkerUi(
    /** The building's id: what the callbacks hand back. */
    val buildingId: String,
    /** The sprite's visible bounds in screen px (the same space as the overlay root, which fills the screen). */
    val anchor: PxRect,
    /** Bubble or timer plate. */
    val kind: MarkerKind,
    /** Bubbles: the 32 dp icon (the output item, `ui:ready-status`). Timer plates ignore it (they draw the builder). */
    val icon: String,
    /** Timer plates: the time left ("1h 12m", "…"). Bubbles: an optional amount ("+24"), carried for the caller and the
     *  [description]; the 48 dp bubble draws its icon only (kit.png and home.png world markers: no figure fits inside it). */
    val text: String?,
    /** Timer plates: 0..1 done; null = unknown (empty meter, never drawn as zero done). */
    val progress: Float?,
    /** What a screen reader says ("Mine: 8,400 Shards ready to collect", "Workshop: building, 1 hour 12 minutes left"). */
    val description: String,
)

/** The marker layer's state. */
@Immutable data class BuildingMarkersUi(
    /** Every candidate marker; the layer draws at most three (nearest the screen centre). */
    val markers: List<BuildingMarkerUi>,
    /** False while a building is selected, placement or the layout editor is open: nothing is drawn. */
    val visible: Boolean,
)

/** Marker callbacks. */
class BuildingMarkerActions(
    /** A READY bubble was tapped: collect in place (server call, no sheet), without selecting. */
    val onCollect: (String) -> Unit,
    /** A NOTICE bubble was tapped: select / open that building. */
    val onOpen: (String) -> Unit,
)

/** The bubble bounces this high (DESIGN-SYSTEM §6). */
private const val BOUNCE_DP = 6f
/** A bubble's tail sits this far above the sprite top; a timer plate this far. */
private val BUBBLE_GAP = 4.dp
private val PLATE_GAP = 6.dp

/**
 * The world-marker layer (DESIGN-SYSTEM §6 WorldBubble / TimerPlate) for the Home kingdom.
 *
 * Pointer rule: this root is a full-size, transparent layout with NO clickable, pointerInput, draggable or scrim. Timer
 * plates are paint only (a pan or a building tap may start on them); only the 48 dp bubbles take taps (each a scene-input
 * region with a label). Everything else falls through to the kingdom.
 */
@Composable fun BuildingMarkerLayer(ui: BuildingMarkersUi, on: BuildingMarkerActions, modifier: Modifier = Modifier) {
    if (!ui.visible || ui.markers.isEmpty()) return
    BoxWithConstraints(modifier.fillMaxSize()) {
        val shown = visibleMarkers(ui.markers, constraints.maxWidth / 2f, constraints.maxHeight / 2f)
        shown.forEach { marker ->
            key(marker.buildingId, marker.kind) {
                when (marker.kind) {
                    MarkerKind.READY, MarkerKind.NOTICE -> WorldBubble(marker,
                        { if (marker.kind == MarkerKind.READY) on.onCollect(marker.buildingId) else on.onOpen(marker.buildingId) })
                    MarkerKind.CONSTRUCTION, MarkerKind.UPGRADING -> TimerPlate(marker)
                }
            }
        }
    }
}

/** Places the content centred over [anchor], its bottom [gapPx] above the anchor's top (like `Modifier.offset`, the node
 *  keeps its own size, so hit-testing follows the drawn position). */
private fun Modifier.above(anchor: PxRect, gapPx: Float): Modifier = layout { measurable, _ ->
    val p = measurable.measure(Constraints())
    layout(p.width, p.height) { p.place((anchor.centerX - p.width / 2f).roundToInt(), (anchor.top - gapPx - p.height).roundToInt()) }
}

/** A 48 dp WorldBubble + 12 × 8 tail: green for READY (bounces), cream for NOTICE. One ≥ 48 dp target. */
@Composable fun WorldBubble(ui: BuildingMarkerUi, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    val ready = ui.kind == MarkerKind.READY
    val bounce = remember { Animatable(0f) }
    LaunchedEffect(ready, reduced, still) {
        if (!ready || reduced || still) { bounce.snapTo(0f); return@LaunchedEffect }
        val half = PkwTokens.Motion.READY_BOUNCE_LOOP / 2
        while (true) {
            bounce.animateTo(1f, tween(half, easing = PkwTokens.Motion.Out))
            bounce.animateTo(0f, tween(half, easing = PkwTokens.Motion.In))
            delay(PkwTokens.Motion.READY_BOUNCE_PAUSE.toLong())
        }
    }
    val face = if (ready) PkwTokens.Colors.green.hi else null
    Column(modifier.above(ui.anchor, with(LocalDensity.current) { BUBBLE_GAP.toPx() })
        .graphicsLayer { translationY = -BOUNCE_DP * density * bounce.value },
        horizontalAlignment = Alignment.CenterHorizontally) {
        Box(Modifier.size(PkwTokens.Dims.worldBubble).sceneInputRegion()
            .clearAndSetSemantics { contentDescription = ui.description; role = Role.Button; this.onClick(label = null, action = { onClick(); true }) }
            .clickable(role = Role.Button, onClick = onClick)
            .drawBehind { drawPlate(PlateKind.CREAM, face) }, contentAlignment = Alignment.Center) {
            // Icon only: an amount under a 32 dp icon cannot fit the 48 dp face and was clipped; the frames draw none.
            PkwIcon(ui.icon, 32.dp)
        }
        Canvas(Modifier.size(12.dp, 8.dp)) {
            val path = Path().apply { moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width / 2f, size.height); close() }
            drawPath(path, PkwTokens.Colors.ink)
        }
    }
}

/** A 114 × 34 TimerPlate (veil): builder 30, the time, an 8 dp meter (striped while under construction). Paint only. */
@Composable fun TimerPlate(ui: BuildingMarkerUi, modifier: Modifier = Modifier) {
    val gap = with(LocalDensity.current) { PLATE_GAP.toPx() }
    Plate(PlateKind.VEIL, modifier.above(ui.anchor, gap).size(PkwTokens.Dims.timerPlateW, PkwTokens.Dims.timerPlateH)
        .clearAndSetSemantics { contentDescription = ui.description },
        contentPadding = PaddingValues(start = 2.dp, top = 2.dp, end = 5.dp, bottom = 2.dp), blocksScene = false) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            PkwIcon("builder", 30.dp)
            Column(Modifier.weight(1f)) {
                PkwText(ui.text ?: UNKNOWN, PkwTokens.Type.caption, color = PkwTokens.Colors.text, outline = 1.dp)
                JobMeter(ui.progress, striped = ui.kind == MarkerKind.CONSTRUCTION)
            }
        }
    }
}

/** The 8 dp job meter: ink S rim, dark track, green done part (diagonal stripes while under construction). */
@Composable private fun JobMeter(progress: Float?, striped: Boolean) {
    Box(Modifier.fillMaxWidth().height(8.dp).drawBehind {
        fillStepped(0f, 0f, size.width, size.height, CornerProfiles.S, PkwTokens.Colors.ink)
        val i = 1.dp.toPx()
        drawRect(PkwTokens.Colors.track, Offset(i, i), Size(size.width - 2 * i, size.height - 2 * i))
        val done = (progress ?: 0f).coerceIn(0f, 1f)
        if (progress == null || done <= 0f) return@drawBehind
        val w = (size.width - 2 * i) * done
        if (striped) {
            val stripe = 3.dp.toPx()
            val brush = Brush.linearGradient(0f to PkwTokens.Colors.green.hi, 0.5f to PkwTokens.Colors.green.hi,
                0.5f to PkwTokens.Colors.green.face, 1f to PkwTokens.Colors.green.face,
                start = Offset.Zero, end = Offset(stripe * 2, stripe * 2), tileMode = TileMode.Repeated)
            drawRect(brush, Offset(i, i), Size(w, size.height - 2 * i))
        } else drawRect(PkwTokens.Colors.green.face, Offset(i, i), Size(w, size.height - 2 * i))
    })
}

// ---- Previews (sample data only; anchors come from the scene) ----

@Composable private fun MarkerPreviewFrame(markers: List<BuildingMarkerUi>) {
    val density = LocalDensity.current
    Box(Modifier.fillMaxSize().background(Color(0xFF3F6A35))) {
        markers.forEach { m ->
            with(density) {
                Box(Modifier.offset(m.anchor.left.toDp(), m.anchor.top.toDp()).size(m.anchor.width.toDp(), m.anchor.height.toDp())
                    .background(Color(0x33140F17)))
            }
        }
        BuildingMarkerLayer(BuildingMarkersUi(markers, visible = true), BuildingMarkerActions(onCollect = {}, onOpen = {}))
    }
}

@Composable private fun sampleAnchor(leftDp: Float, topDp: Float): PxRect {
    val d = LocalDensity.current.density
    return PxRect(leftDp * d, topDp * d, (leftDp + 84f) * d, (topDp + 84f) * d)
}

@Preview(name = "World markers: ready, construction, upgrading", widthDp = 412, heightDp = 600)
@Composable private fun MarkersPreview() {
    MarkerPreviewFrame(listOf(
        BuildingMarkerUi("mine-1", sampleAnchor(40f, 260f), MarkerKind.READY, "shards", "+8,400", null, "Mine: 8,400 Shards ready to collect"),
        BuildingMarkerUi("workshop-1", sampleAnchor(170f, 300f), MarkerKind.CONSTRUCTION, "builder", "1h 12m", 0.3f, "Workshop: building, 1 hour 12 minutes left"),
        BuildingMarkerUi("lodge-1", sampleAnchor(290f, 240f), MarkerKind.UPGRADING, "builder", "3h 40m", 0.55f, "Lodge: upgrading to level 3, 3 hours 40 minutes left"),
        // A fourth marker far from the centre: dropped (at most three, nearest first).
        BuildingMarkerUi("market-1", sampleAnchor(300f, 520f), MarkerKind.NOTICE, "ui:market-menu", null, null, "Market: 1 sale to collect"),
    ))
}

@Preview(name = "World markers: unknown time and notice", widthDp = 412, heightDp = 400)
@Composable private fun MarkersUnknownPreview() {
    MarkerPreviewFrame(listOf(
        BuildingMarkerUi("workshop-1", sampleAnchor(60f, 220f), MarkerKind.UPGRADING, "builder", null, null, "Workshop: upgrading, time unknown"),
        BuildingMarkerUi("trap-1", sampleAnchor(260f, 220f), MarkerKind.NOTICE, "ui:exhausted-status", null, null, "Spike trap: spent, rearm it"),
    ))
}
