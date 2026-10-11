package gg.pixelkingdomwars.nativeclient.ui.layout

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.network.DraftResult
import gg.pixelkingdomwars.nativeclient.network.LayoutDraft
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeMode
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import java.util.UUID

/** Value snapshot, never lambda identity: a geometry or inventory change revokes a gesture. */
data class LayoutWallContext(
    val baseId: String,
    val slot: String,
    val draft: LayoutDraft,
    val geometryVersion: Int,
    val claimMin: Int,
    val claimMax: Int,
    val plot: PlotGeometry?,
    val buildings: List<Building>,
    val obstacles: List<Obstacle>,
    val footprints: Map<String, Pair<Int, Int>>,
    val obstacleSizes: Map<String, Int>,
    val tool: LayoutWallTool,
    val level: Int?,
    val epoch: Long,
)

data class LayoutWallBinding(val context: LayoutWallContext, val mode: WallStrokeMode)
data class LayoutWallPending(
    val token: String,
    val context: LayoutWallContext,
    val tiles: List<WallStrokeTile>,
    val result: DraftResult,
    val requestedCount: Int,
    val affectedCount: Int,
)

internal fun bindLayoutWalls(state: LayoutEditorState, previous: LayoutWallBinding?): LayoutWallBinding? {
    if (!state.open || state.locked || !state.deedActionsAllowed || state.local.busy != null || state.local.discardOpen || state.local.wallInputPaused) return null
    val tool = state.local.wallTool ?: return null
    val geometry = state.geometry ?: return null
    val draft = state.draft ?: return null
    val baseId = state.base?.baseId ?: return null
    val context = LayoutWallContext(baseId, state.slot, draft.copy(positions = draft.positions.toList(), trayIds = draft.trayIds.toList(), history = draft.history.toList()),
        geometry.geometryVersion, geometry.claimMin, geometry.claimMax, geometry.plotGeometry,
        geometry.buildings.toList(), geometry.obstacles.toList(),
        geometry.buildings.map { it.type }.distinct().associateWith(geometry.footprint) + ("wall" to geometry.footprint("wall")),
        geometry.obstacles.map { it.spriteKey.orEmpty() }.distinct().associateWith(geometry.obstacleSize),
        tool, state.local.wallPaintLevel, state.local.wallEpoch)
    if (previous?.context == context) return previous
    val mode = layoutWallStrokeMode(UUID.randomUUID().toString(), baseId, draft, geometry, tool, context.level) ?: return null
    return LayoutWallBinding(context, mode)
}
