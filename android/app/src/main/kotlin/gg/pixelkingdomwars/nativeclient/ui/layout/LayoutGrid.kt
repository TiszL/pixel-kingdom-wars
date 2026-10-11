package gg.pixelkingdomwars.nativeclient.ui.layout

import gg.pixelkingdomwars.nativeclient.network.LayoutDraft
import gg.pixelkingdomwars.nativeclient.network.LayoutGeometry
import gg.pixelkingdomwars.nativeclient.renderer.HighlightColors
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlight
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind

/** Web BaseScene.drawPlacementGrid: occupancy at the draft positions, including the selection.
 * Build once for the immutable editor state, never from the render/frame loop. These are presentation
 * tiles only; validatePlacement and the server still decide whether a whole building can land. */
internal fun layoutGrid(geometry: LayoutGeometry, draft: LayoutDraft): List<SceneHighlight> {
    val min = geometry.claimMin; val max = geometry.claimMax
    val size = max - min
    if (size <= 0) return emptyList()
    val blocked = BooleanArray(size * size)
    fun occupy(x: Int, y: Int, width: Int, height: Int) {
        for (ty in maxOf(min, y) until minOf(max, y + height))
            for (tx in maxOf(min, x) until minOf(max, x + width)) blocked[(ty - min) * size + tx - min] = true
    }
    val buildings = geometry.buildings.associateBy { it.id }
    val tray = draft.trayIds.toSet()
    for (position in draft.positions) {
        if (position.buildingId in tray) continue
        val building = buildings[position.buildingId] ?: continue
        val (width, height) = geometry.footprint(building.type)
        occupy(position.tx, position.ty, width, height)
    }
    for (obstacle in geometry.obstacles) {
        val width = geometry.obstacleSize(obstacle.spriteKey.orEmpty())
        occupy(obstacle.tx, obstacle.ty, width, width)
    }
    return buildList {
        for (ty in min until max) for (tx in min until max) {
            val free = !blocked[(ty - min) * size + tx - min] && geometry.plotGeometry?.contains(tx, ty, 1, 1) != false
            // Web placement tile alpha: free 0.09, occupied 0.30; grid white 0.10.
            add(SceneHighlight(tx.toFloat(), ty.toFloat(), 1f, 1f,
                if (free) HighlightColors.VALID else HighlightColors.BLOCKED, if (free) .09f else .30f))
        }
        add(SceneHighlight(min.toFloat(), min.toFloat(), size.toFloat(), size.toFloat(),
            0xFFFFFF, .10f, SceneHighlightKind.GRID_OVERLAY))
    }
}
