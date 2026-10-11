package gg.pixelkingdomwars.nativeclient.ui.kingdom

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalInspectionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.renderer.RenderBuilding
import gg.pixelkingdomwars.nativeclient.scene.BuildingRooflines
import gg.pixelkingdomwars.nativeclient.scene.sceneInputRegion
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.home.LocalHomeVoyageReturnAction
import gg.pixelkingdomwars.nativeclient.ui.home.VoyageAwayMarker
import gg.pixelkingdomwars.nativeclient.ui.home.VoyageReadyMarker
import gg.pixelkingdomwars.nativeclient.ui.home.homeVoyageTrips
import gg.pixelkingdomwars.nativeclient.ui.home.rememberHomeVoyageInputs
import gg.pixelkingdomwars.nativeclient.ui.home.voyageReturnMarkers
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.BusyDots
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwText
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.Plate
import gg.pixelkingdomwars.nativeclient.ui.kit.PlateKind
import gg.pixelkingdomwars.nativeclient.ui.kit.ProgressBar
import gg.pixelkingdomwars.nativeclient.ui.kit.drawPlate
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleSprite
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.familyName
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BERTH_TYPE
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LODGE_TYPE
import java.io.File
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/*
 * The trip-back markers on the Home kingdom (voyage SPEC §2 `home-return.png`; DESIGN-SYSTEM §6 WorldBubble / TimerPlate).
 * - READY: a green 48 dp WorldBubble 4 dp above the LODGE roof, ready-status 32, a gold main-cargo badge top-right
 *   ("+40") and a "+n" count badge for more returns; it bounces 6 dp (900 ms, 2 s pause). One tap collects every READY
 *   trip through the Home collect owner (no sheet). While a collect or another vehicle-owner step runs it shows stone
 *   dots and ignores taps; it stays on screen, so a routine refresh never blanks it.
 * - AWAY: a 114 × 34 TimerPlate 6 dp above the BERTH for the soonest-returning vehicle at sea (starter flight included):
 *   its idle sprite at k = 1 in a 28 dp window instead of the builder, the time, an 8 dp green meter. Paint only.
 * Both share the selected-building camera anchor (measured roof + footprint, one per building) and hide while a building
 * is selected, placed or the layout editor is open ([visible]). The bubble also needs a mounted collect owner: a bubble
 * that could not collect would be a dead door.
 */

/** The bubble bounces this high (DESIGN-SYSTEM §6). */
private const val BOUNCE_DP = 6f
/** SPEC §2 motion: "Collect: the bubble scales 1 → 0.8 over 90 ms". */
private const val COLLECT_SCALE = 0.8f
private const val COLLECT_PRESS_MS = 90
/** The bubble's tail sits this far above the roof; the timer plate this far (BuildingStateMarkers geometry). */
private val BUBBLE_GAP = 4.dp
private val PLATE_GAP = 6.dp

/** The Lodge return bubble and the Berth away plate share the selected-building camera anchor and hide under selection/editing. */
@Composable internal fun VoyageReturnLayer(buildings: List<Building>, scene: BaseScene, assets: File, render: JsonObject,
    camera: State<BaseCameraView?>, visible: Boolean, modifier: Modifier = Modifier) {
    val action = LocalHomeVoyageReturnAction.current
    val input = rememberHomeVoyageInputs(buildings, scene.baseId)
    val markers = voyageReturnMarkers(homeVoyageTrips(input))
    val lodgeId = buildings.firstOrNull { it.type == LODGE_TYPE && !it.underConstruction }?.id
    val berthId = buildings.firstOrNull { it.type == BERTH_TYPE && !it.underConstruction }?.id
    val lodgeAnchor = rememberRoofAnchor(scene.buildings.firstOrNull { it.id == lodgeId }, scene, assets, render, camera)
    val berthAnchor = rememberRoofAnchor(scene.buildings.firstOrNull { it.id == berthId }, scene, assets, render, camera)
    if (!visible) return
    val ready = markers.ready?.takeIf { action != null }
    val away = markers.away
    if (ready == null && away == null) return
    val collecting = action?.busy?.invoke() == true
    val busy = collecting || input.vehicles?.busy == true
    Box(modifier.fillMaxSize()) {
        if (away != null && berthAnchor != null) VoyageAwayPlate(away, berthAnchor)
        if (ready != null && lodgeAnchor != null && action != null) {
            VoyageReadyBubble(ready, lodgeAnchor, busy, collecting) { if (!busy) action.collect() }
        }
    }
}

/** One building's camera anchor, measured exactly like the selection's (BuildingRooflines + buildingSelectionAnchor). */
@Composable private fun rememberRoofAnchor(building: RenderBuilding?, scene: BaseScene, assets: File, render: JsonObject,
    camera: State<BaseCameraView?>): PxRect? {
    var roof by remember(building?.id, building?.frameKey) { mutableStateOf<Float?>(null) }
    LaunchedEffect(assets, render, scene.tilePixels, building) {
        roof = building?.let { withContext(Dispatchers.IO) { BuildingRooflines.measuredRoof(assets, render, it, scene.tilePixels) } }
    }
    val anchor by remember(building, scene.baseId, scene.tilePixels) { derivedStateOf {
        buildingSelectionAnchor(building, roof, scene.baseId, scene.tilePixels, camera.value)
    } }
    return anchor
}

/** Places the content centred over [anchor], its bottom [gapPx] above the anchor's top (hit-testing follows the drawn
 *  position; the same placement as BuildingStateMarkers). */
private fun Modifier.above(anchor: PxRect, gapPx: Float): Modifier = layout { measurable, _ ->
    val p = measurable.measure(Constraints())
    layout(p.width, p.height) { p.place((anchor.centerX - p.width / 2f).roundToInt(), (anchor.top - gapPx - p.height).roundToInt()) }
}

/** SPEC §2 WorldBubble (green, ready): one ≥ 48 dp target with the main-cargo badge; stone dots and no taps while [busy]. */
@Composable private fun VoyageReadyBubble(marker: VoyageReadyMarker, anchor: PxRect, busy: Boolean, collecting: Boolean,
    onCollect: () -> Unit) {
    val reduced = LocalReducedMotion.current
    val still = LocalInspectionMode.current
    val bounce = remember { Animatable(0f) }
    LaunchedEffect(busy, reduced, still) {
        if (busy || reduced || still) { bounce.snapTo(0f); return@LaunchedEffect }
        val half = PkwTokens.Motion.READY_BOUNCE_LOOP / 2
        while (true) {
            bounce.animateTo(1f, tween(half, easing = PkwTokens.Motion.Out))
            bounce.animateTo(0f, tween(half, easing = PkwTokens.Motion.In))
            delay(PkwTokens.Motion.READY_BOUNCE_PAUSE.toLong())
        }
    }
    val press by animateFloatAsState(if (collecting && !reduced) COLLECT_SCALE else 1f, tween(COLLECT_PRESS_MS), label = "voyage-collect-press")
    val trips = marker.tripIds.size
    val description = "Lodge: ${if (trips == 1) "1 trip" else "$trips trips"} back, main cargo ${marker.mainReward}. Collect"
    val tap = if (busy) Modifier.clearAndSetSemantics { contentDescription = "Lodge: collecting returned trips" }
        else Modifier.clearAndSetSemantics { contentDescription = description; role = Role.Button; this.onClick(label = null, action = { onCollect(); true }) }
            .clickable(role = Role.Button, onClick = onCollect)
    Column(Modifier.above(anchor, with(LocalDensity.current) { BUBBLE_GAP.toPx() })
        .graphicsLayer { translationY = -BOUNCE_DP * density * bounce.value; scaleX = press; scaleY = press },
        horizontalAlignment = Alignment.CenterHorizontally) {
        Box {
            Box(Modifier.size(PkwTokens.Dims.worldBubble).sceneInputRegion().then(tap)
                .drawBehind { drawPlate(PlateKind.CREAM, PkwTokens.Colors.green.hi) }, contentAlignment = Alignment.Center) {
                if (busy) BusyDots() else PkwIcon(marker.icon, 32.dp)
            }
            // home-return.html: the gold badge sits right −14, top −10 of the bubble; the "+n" count stacks under it.
            Badge(BadgeUi(marker.mainReward, BadgeTone.REWARD, "Main cargo ${marker.mainReward}"),
                Modifier.align(Alignment.TopEnd).offset(x = 14.dp, y = (-10).dp))
            if (marker.extraCount > 0) Badge(BadgeUi("+${marker.extraCount}", BadgeTone.COUNT,
                "${marker.extraCount} more ${if (marker.extraCount == 1) "trip" else "trips"} back"),
                Modifier.align(Alignment.TopEnd).offset(x = 14.dp, y = 16.dp))
        }
        Canvas(Modifier.size(12.dp, 8.dp)) {
            val path = Path().apply { moveTo(0f, 0f); lineTo(size.width, 0f); lineTo(size.width / 2f, size.height); close() }
            drawPath(path, PkwTokens.Colors.ink)
        }
    }
}

/** SPEC §2 TimerPlate over the Berth: the away vehicle's idle sprite (k = 1, 28 dp window), its time and an 8 dp
 *  green meter. Paint only: a pan or a building tap may start on it. */
@Composable private fun VoyageAwayPlate(marker: VoyageAwayMarker, anchor: PxRect) {
    val gap = with(LocalDensity.current) { PLATE_GAP.toPx() }
    val name = familyName(marker.family)
    Plate(PlateKind.VEIL, Modifier.above(anchor, gap).size(PkwTokens.Dims.timerPlateW, PkwTokens.Dims.timerPlateH)
        .clearAndSetSemantics { contentDescription = "$name at sea: ${marker.returnsIn}" },
        contentPadding = PaddingValues(start = 2.dp, top = 2.dp, end = 5.dp, bottom = 2.dp), blocksScene = false) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            VehicleSprite(marker.family, marker.tier, 1, Modifier.size(28.dp))
            Column(Modifier.weight(1f)) {
                PkwText(marker.returnsIn, PkwTokens.Type.caption, color = PkwTokens.Colors.text, outline = 1.dp)
                ProgressBar(marker.progress, "$name trip progress", height = 8.dp)
            }
        }
    }
}
