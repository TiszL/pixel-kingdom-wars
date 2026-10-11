package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage

import androidx.compose.animation.Crossfade
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import gg.pixelkingdomwars.nativeclient.ui.LocalReducedMotion
import gg.pixelkingdomwars.nativeclient.ui.kit.Badge
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwIcon
import gg.pixelkingdomwars.nativeclient.ui.kit.PkwTokens
import gg.pixelkingdomwars.nativeclient.ui.kit.TimerChip
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeUi
import gg.pixelkingdomwars.nativeclient.ui.model.TimerUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.BuildingArt
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.drawGrass

/*
 * Design component: the Lodge sheet's living header, `VoyageChart` (SPEC §3 item 2, §5a item 1, §6 item 1): the sea with
 * wave marks, the shore around the Lodge on the left, the chosen island cutout on the right, a stepped dashed route from
 * the Lodge door to the island with the chosen vehicle and its duration chip on it; or several trips at sea (multi); or the
 * starter's dotted coast loop; or the empty sea of a new player.
 *
 * It is drawn inside SheetFrame's 136 dp header box; SheetFrame draws the title plate, History and close on top. Pointer
 * rule: paint only, no touches (the header's buttons belong to SheetFrame).
 */

/** What the header shows. */
enum class ChartMode {
    /** One route: shore → island, vehicle + duration on the line (SEND, CHOOSE AN ISLAND). */
    ROUTE,
    /** The starter boat's dotted loop off the shore, no island (SEND with the starter, SPEC §3a). */
    STARTER_LOOP,
    /** Every trip at sea or back (TRIPS). */
    TRIPS,
    /** Shore, empty sea and the nearest Grade I island, no line (send-locked, SPEC §6). */
    EMPTY,
}

/** One trip on the TRIPS chart. */
@Immutable data class ChartTripUi(
    val route: RouteUi?,
    val family: VehicleFamily,
    val tier: Int?,
    /** 0..1 along its path; null = unknown (drawn at the start). */
    val progress: Float?,
    /** READY: the vehicle sits at the shore edge with a green "!". */
    val ready: Boolean,
)

/** The header's state. */
@Immutable data class VoyageChartUi(
    val mode: ChartMode,
    /** ROUTE / EMPTY: the island. */
    val route: RouteUi? = null,
    /** ROUTE / STARTER_LOOP: the chosen vehicle (null draws the line without one). */
    val vehicle: VehicleUi? = null,
    /** ROUTE / STARTER_LOOP: the duration chip under the vehicle ("3h 20m"); null hides it. */
    val duration: TimerUi? = null,
    /** TRIPS: up to 3 trips are drawn. */
    val trips: List<ChartTripUi> = emptyList(),
    /** What a screen reader hears for the whole picture. */
    val description: String = "",
    /** Added: the Lodge's art tier (`ui:lodge-t{n}-idle`) for the shore stand-in; null draws the lodge-menu icon there. */
    val lodgeTier: Int? = null,
)

/** The Lodge door in a 398 dp wide header (SPEC §3: route from (126, 104) to (262, 70)). */
private const val DESIGN_W = 398f

/** send.html: the route turns up 50 dp past the Lodge door (`M126 104H176V70H262`), and the vehicle rides the top leg
 *  40 dp short of the island (window at 196, 30), its timer chip under it at (186, 88). */
private const val ROUTE_TURN = 50f
private const val VEHICLE_BEFORE_ISLAND = 40f

/** The chart, filling the header box. Mode changes cross-fade in 120 ms (vehicle swap, SPEC §3 motion 3). */
@Composable fun VoyageChart(ui: VoyageChartUi, modifier: Modifier = Modifier) {
    val reduced = LocalReducedMotion.current
    BoxWithConstraints(modifier.fillMaxSize().background(VoyageColors.seaHdr).clearAndSetSemantics { contentDescription = ui.description }) {
        val w = maxWidth.value
        val sx = w / DESIGN_W
        val seed = (ui.route?.routeId ?: "sea").hashCode()
        Canvas(Modifier.fillMaxSize()) { drawWaves(seed) }
        Shore(Modifier.size(160.dp, 136.dp), ui.lodgeTier)
        Crossfade(ui, Modifier.fillMaxSize(), tween(if (reduced) PkwTokens.Motion.REDUCED_CROSSFADE else PkwTokens.Motion.TAB_SWITCH), label = "chart") { shown ->
            Box(Modifier.fillMaxSize()) {
                when (shown.mode) {
                    ChartMode.ROUTE -> RouteChart(shown, w, sx)
                    ChartMode.STARTER_LOOP -> StarterLoop(shown, sx)
                    ChartMode.TRIPS -> TripsChart(shown, w, sx)
                    // send-locked.html: the home Grade I island cutout at (250, −12), 160 dp, cropped by the header edge.
                    ChartMode.EMPTY -> shown.route?.let { LocalVoyageArt.current.routeCutout(it, Modifier.offset(x = (w - 148f).dp, y = (-12).dp).size(160.dp)) }
                }
            }
        }
    }
}

/**
 * The left shore: the data side's live-world crop, or the stand-in: the game's grass cut by the stepped COAST over the
 * 4 dp SAND band (send.html polygons), with the Lodge's own art where the round-2 frames place it (send-advanced.html:
 * `lodge-t2-idle` 112 dp at 14, 22). Without a known tier the lodge-menu icon stands in.
 */
@Composable private fun Shore(modifier: Modifier, lodgeTier: Int?) {
    val shore = LocalVoyageArt.current.shore
    if (shore != null) { shore(modifier); return }
    Box(modifier.drawBehind { drawCoast() }) {
        if (lodgeTier != null) BuildingArt("ui:lodge-t${lodgeTier.coerceIn(1, 4)}-idle", 112.dp, Modifier.offset(x = 14.dp, y = 22.dp))
        else PkwIcon("ui:lodge-menu", 32.dp, Modifier.offset(x = 72.dp, y = 76.dp))
    }
}

/** send.html COAST (grass) and SAND polygons as steps: (right edge of grass, right edge of sand, top, bottom) in dp. The
 *  sand runs 4 dp wider and 4 dp lower than the grass at each step. */
private val COAST_STEPS = listOf(
    floatArrayOf(148f, 152f, 0f, 34f), floatArrayOf(140f, 152f, 34f, 38f), floatArrayOf(140f, 144f, 38f, 62f),
    floatArrayOf(130f, 144f, 62f, 66f), floatArrayOf(130f, 134f, 66f, 92f), floatArrayOf(118f, 134f, 92f, 96f),
    floatArrayOf(118f, 122f, 96f, 116f), floatArrayOf(104f, 122f, 116f, 120f), floatArrayOf(104f, 108f, 120f, 136f),
)

/** The stand-in coast: the sand band, then the game grass clipped to each COAST step. */
private fun DrawScope.drawCoast() {
    val u = density
    COAST_STEPS.forEach { (grassR, sandR, t, b) ->
        drawRect(VoyageColors.sand, Offset(0f, t * u), Size(sandR * u, (b - t) * u))
        clipRect(0f, t * u, grassR * u, b * u) { drawGrass() }
    }
}

/** A stepped (H → V → H) route turning at [turnX] (the midpoint when null): a 7 dp ink line under 3 dp gold-hi dashes
 *  (6 / 6). [dotted] is the starter loop. */
private fun DrawScope.drawRoute(fromX: Float, fromY: Float, toX: Float, toY: Float, dotted: Boolean = false, turnX: Float? = null) {
    val midX = turnX ?: ((fromX + toX) / 2f)
    val pts = listOf(Offset(fromX, fromY), Offset(midX, fromY), Offset(midX, toY), Offset(toX, toY)).map { Offset(it.x * density, it.y * density) }
    val dash = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 6.dp.toPx()))
    for (i in 0 until pts.size - 1) {
        if (!dotted) drawLine(PkwTokens.Colors.ink, pts[i], pts[i + 1], 7.dp.toPx(), StrokeCap.Square)
        drawLine(PkwTokens.Colors.gold.hi, pts[i], pts[i + 1], 3.dp.toPx(), StrokeCap.Butt, if (dotted) PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 5.dp.toPx())) else dash)
    }
}

@Composable private fun RouteChart(ui: VoyageChartUi, w: Float, sx: Float) {
    val fromX = 126f * sx; val fromY = 104f
    val toX = w - 136f; val toY = 70f
    val turnX = fromX + ROUTE_TURN * sx
    ui.route?.let { LocalVoyageArt.current.routeCutout(it, Modifier.offset(x = (w - 160f).dp, y = (-12).dp).size(160.dp)) }
    Canvas(Modifier.fillMaxSize()) { drawRoute(fromX, fromY, toX, toY, turnX = turnX) }
    VehicleOnLine(ui.vehicle, (toX - VEHICLE_BEFORE_ISLAND * sx).coerceAtLeast(turnX), toY, ui.duration)
}

@Composable private fun StarterLoop(ui: VoyageChartUi, sx: Float) {
    val ox = 150f * sx
    Canvas(Modifier.fillMaxSize()) {
        drawRoute(ox, 104f, ox + 120f * sx, 40f, dotted = true)
        drawRoute(ox + 120f * sx, 40f, ox, 104f, dotted = true)
    }
    VehicleOnLine(ui.vehicle, ox + 70f * sx, 60f, ui.duration)
}

/** The chosen vehicle on the line at k 2 (52 × 56 window centred 40 dp above the line's art point), with the duration
 *  chip under it (send.html: window at (x − 26, y − 40), chip at (x − 36, y + 18)). */
@Composable private fun VehicleOnLine(vehicle: VehicleUi?, x: Float, y: Float, duration: TimerUi?) {
    if (vehicle != null) VehicleSprite(vehicle.family, vehicle.tier, 2, Modifier.offset(x = (x - 26f).dp, y = (y - 40f).dp).size(52.dp, 56.dp))
    if (duration != null) TimerChip(duration, Modifier.offset(x = (x - 36f).dp, y = (y + 18f).dp.coerceAtMost(100.dp)))
}

/**
 * Up to three trips: islands at fixed slots, a stepped path from the Lodge to each, vehicles placed by progress. trips.html
 * starts each path on its own row off the shore (y 96, 108, …) and turns it at its own x (164, 200, …), so the paths never
 * run on top of each other; a READY vehicle waits at the shore edge with the green "!".
 */
@Composable private fun TripsChart(ui: VoyageChartUi, w: Float, sx: Float) {
    val slots = listOf(Offset(192f * sx, -6f), Offset(w - 92f, 56f), Offset(230f * sx, 60f))
    val shown = ui.trips.take(3)
    // Islands and paths belong to the trips at sea, in order; READY ones wait at the shore.
    val atSea = shown.filter { !it.ready }
    val ready = shown.filter { it.ready }
    val fromX = 126f * sx
    fun fromY(i: Int) = 96f + 12f * i
    fun turnX(i: Int) = fromX + (38f + 36f * i) * sx
    fun toX(i: Int) = slots[i].x + 8f
    fun toY(i: Int) = slots[i].y + 40f
    atSea.forEachIndexed { i, trip ->
        val s = slots[i]
        trip.route?.let { LocalVoyageArt.current.routeCutout(it, Modifier.offset(x = s.x.dp, y = s.y.dp).size(80.dp)) }
    }
    Canvas(Modifier.fillMaxSize()) {
        atSea.indices.forEach { i -> drawRoute(fromX, fromY(i), toX(i), toY(i), turnX = turnX(i)) }
    }
    atSea.forEachIndexed { i, trip ->
        val (x, y) = steppedRoutePoint(fromX, fromY(i), toX(i), toY(i), trip.progress ?: 0f, turnX(i))
        VehicleSprite(trip.family, trip.tier, 2, Modifier.offset(x = (x - 26f).dp, y = (y - 40f).dp).size(52.dp, 56.dp))
    }
    ready.forEachIndexed { j, trip ->
        // trips.html: a returned vehicle rests at the shore edge (x 96-124, bottom of the header), "!" above it.
        Box(Modifier.offset(x = (fromX - 42f - 24f * j).dp, y = 80.dp).size(52.dp, 56.dp)) {
            VehicleSprite(trip.family, trip.tier, 2, Modifier.fillMaxSize())
            Badge(BadgeUi("!", BadgeTone.READY, "Back"), Modifier.align(Alignment.TopCenter).offset(y = (-8).dp))
        }
    }
}

private val previewRoute = RouteUi("glasswake-3", "glasswake", 2, "Glasswake Keys 3", "elderwood", "Elderwood", "heartwood_logs", 2,
    Access.HOME, null, "voyage:heartwood-logs", "Heartwood Logs")

@Preview(name = "Voyage chart: route", widthDp = 398, heightDp = 136)
@Composable private fun VoyageChartRoutePreview() {
    VoyageChart(VoyageChartUi(ChartMode.ROUTE, previewRoute,
        VehicleUi(VehicleFamily.CARGO_CUTTER, 2, "i-2", "b-2", VehicleStatus.DOCKED, 7, 10, null, 2),
        TimerUi("3h 20m", "Back in 3 hours 20 minutes")))
}

@Preview(name = "Voyage chart: trips", widthDp = 398, heightDp = 136)
@Composable private fun VoyageChartTripsPreview() {
    VoyageChart(VoyageChartUi(ChartMode.TRIPS, trips = listOf(
        ChartTripUi(previewRoute, VehicleFamily.CARGO_CUTTER, 2, 0.3f, false),
        ChartTripUi(previewRoute.copy(routeId = "emberwake-1"), VehicleFamily.COURIER_AIRSHIP, 3, 0.7f, false),
        ChartTripUi(null, VehicleFamily.STARTER, null, null, true))))
}

@Preview(name = "Voyage chart: empty and starter loop", widthDp = 398, heightDp = 280)
@Composable private fun VoyageChartOtherPreview() {
    androidx.compose.foundation.layout.Column {
        Box(Modifier.size(398.dp, 136.dp)) { VoyageChart(VoyageChartUi(ChartMode.EMPTY, previewRoute)) }
        Box(Modifier.padding(top = 8.dp).size(398.dp, 136.dp)) {
            VoyageChart(VoyageChartUi(ChartMode.STARTER_LOOP, vehicle = VehicleUi(VehicleFamily.STARTER, null, "s", "b", VehicleStatus.DOCKED, null, null, null, 0),
                duration = TimerUi("40m", "Back in 40 minutes")))
        }
    }
}

