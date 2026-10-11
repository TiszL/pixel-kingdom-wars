package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.IntOffset
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Claim
import gg.pixelkingdomwars.nativeclient.renderer.BaseCameraView
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.renderer.workmanJobs
import gg.pixelkingdomwars.nativeclient.scene.BaseGeometry
import gg.pixelkingdomwars.nativeclient.scene.BuildingRooflines
import gg.pixelkingdomwars.nativeclient.ui.command.PxRect
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.kingdom.buildingSelectionAnchor
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import java.io.File

/** Local feedback only. A clear set never admits a price, builder, order, or server placement. */
internal data class PlacementSpace(val width: Int, val height: Int, val takenTiles: Set<IntOffset>, val reason: String?)

internal fun placementSpace(base: BaseSnapshot, geometry: BaseGeometry, type: String, tile: Pair<Int, Int>,
    settling: Map<String, Pair<Int, Int>> = emptyMap()): PlacementSpace {
    val (width, height) = geometry.footprint(type, 1)
    val claim = base.claim
    if (claim == null || claim.max <= claim.min || width <= 0 || height <= 0)
        return PlacementSpace(width, height, emptySet(), "Land bounds are unavailable")
    // A move still awaiting its response reserves BOTH seats. Only a server hydration frees the old one.
    data class Occupied(val x: Int, val y: Int, val width: Int, val height: Int)
    val occupied = base.buildings.flatMap { b ->
        val (w, h) = geometry.footprint(b)
        listOfNotNull(Occupied(b.tx, b.ty, w, h), settling[b.id]?.let { Occupied(it.first, it.second, w, h) })
    } + base.obstacles.map { o -> val size = geometry.obstacleFootprint(o); Occupied(o.tx, o.ty, size, size) }
    val taken = mutableSetOf<IntOffset>()
    var outside = false
    for (dy in 0 until height) for (dx in 0 until width) {
        val x = tile.first.toLong() + dx; val y = tile.second.toLong() + dy
        val out = x < claim.min || y < claim.min || x >= claim.max || y >= claim.max
        outside = outside || out
        if (out || occupied.any { x >= it.x && y >= it.y && x < it.x.toLong() + it.width && y < it.y.toLong() + it.height })
            taken += IntOffset(dx, dy)
    }
    return PlacementSpace(width, height, taken, when { outside -> "Outside your land"; taken.isNotEmpty() -> "Spot is blocked"; else -> null })
}

internal fun readPlacementSpace(state: KingdomUiState): PlacementSpace? {
    val draft = state.placement ?: return null
    return placementSpace(state.base ?: return null, state.geometry ?: return null, draft.type,
        draft.tile ?: return null, state.local.settling)
}

/** Surface-local pixels share the exact GL camera. Null during a pan/pinch or before the first chosen tile. */
internal fun livePlacementGeometry(ui: PlacementUi, hasTile: Boolean, baseId: String?, tilePixels: Float,
    claim: Claim?, camera: BaseCameraView?): PlacementGeometry? {
    val view = camera?.takeIf { it.baseId == baseId && baseId != null && it.overlayVisible } ?: return null
    if (!hasTile || !tilePixels.isFinite() || tilePixels <= 0f) return null
    val x = ui.tile.x * tilePixels; val y = ui.tile.y * tilePixels
    val rect = PxRect(view.screenX(x), view.screenY(y), view.screenX(x + ui.footprint * tilePixels),
        view.screenY(y + ui.footprintHeight * tilePixels))
    val plot = claim?.takeIf { it.max > it.min }?.let { PxRect(view.screenX(it.min * tilePixels), view.screenY(it.min * tilePixels),
        view.screenX(it.max * tilePixels), view.screenY(it.max * tilePixels)) }
    return PlacementGeometry(rect, tilePixels * view.scale, plot)
}

@Composable internal fun LivePlacementWorldLayer(review: LivePlacementSheetFacts, scene: BaseScene, claim: Claim?,
    camera: State<BaseCameraView?>, onMove: (IntOffset) -> Unit, modifier: Modifier = Modifier) {
    val ui = livePlacementUi(review) ?: return
    val geometry = livePlacementGeometry(ui, review.facts.tile != null, scene.baseId, scene.tilePixels, claim, camera.value)
    PlacementGhost(ui, geometry, PlacementActions(onMove = onMove, onPlace = {}, onCancel = {}), modifier.fillMaxSize())
}

/** At most the kit marker budget, nearest the drawn viewport centre. No absent/offscreen/foreign anchors. */
internal fun constructionWorldUi(sites: List<TimerPlateUi>, scene: BaseScene, roofs: Map<String, Float>,
    camera: BaseCameraView?, hidden: Boolean): ConstructionLayerUi {
    val view = camera?.takeIf { it.baseId == scene.baseId && scene.baseId != null && it.overlayVisible }
    if (hidden || view == null) return ConstructionLayerUi(emptyList(), visible = false)
    val anchors = scene.buildings.mapNotNull { b -> buildingSelectionAnchor(b, roofs[b.id], scene.baseId, scene.tilePixels, view)
        ?.takeIf { it.right > 0 && it.bottom > 0 && it.left < view.width && it.top < view.height }?.let { b.id to it } }.toMap()
    val layer = liveConstructionLayer(sites, anchors, hidden = false)
    // One builder per job: a site the scene already walks its Workman to draws no second, still builder.
    val walked = scene.workmanJobs().mapNotNullTo(HashSet()) { it.buildingId }
    return layer.copy(sites = layer.sites.distinctBy { it.buildingId }.sortedBy {
        val dx = it.anchor.centerX - view.width / 2f; val dy = (it.anchor.top + it.anchor.bottom) / 2f - view.height / 2f
        dx * dx + dy * dy
    }.take(MAX_WORLD_MARKERS).map { it.copy(workmanInScene = it.buildingId in walked) })
}

/** Renderer scaffolds, workmen, completion sprites and job ownership stay intact; this adds their missing timers. */
@Composable internal fun LiveConstructionWorldLayer(sites: List<TimerPlateUi>, scene: BaseScene, assets: File, render: JsonObject,
    camera: State<BaseCameraView?>, hidden: Boolean, onSelect: (String) -> Unit, modifier: Modifier = Modifier) {
    val buildings = scene.buildings.filter { b -> sites.any { it.buildingId == b.id } }
    // A changed base, render generation or moved building immediately drops its former roof observation.
    var roofs by remember(assets, render, scene.baseId, scene.tilePixels, buildings) { mutableStateOf(emptyMap<String, Float>()) }
    LaunchedEffect(assets, render, scene.baseId, scene.tilePixels, buildings) {
        roofs = withContext(Dispatchers.IO) { buildings.mapNotNull { b ->
            BuildingRooflines.measuredRoof(assets, render, b, scene.tilePixels)?.let { b.id to it }
        }.toMap() }
    }
    ConstructionLayer(constructionWorldUi(sites, scene, roofs, camera.value, hidden), ConstructionActions(onSelect), modifier.fillMaxSize())
}
