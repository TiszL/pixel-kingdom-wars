package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import gg.pixelkingdomwars.nativeclient.network.footprintOf
import gg.pixelkingdomwars.nativeclient.network.obstacleSize
import gg.pixelkingdomwars.nativeclient.network.objects
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.renderer.HighlightColors
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlight
import gg.pixelkingdomwars.nativeclient.renderer.SceneHighlightKind
import kotlinx.serialization.json.JsonObject
import kotlin.math.floor

/** Tile-space geometry the Kingdom screen shares with the renderer: the render catalogue's footprints
 * (what the scene draws and hit-tests) with the constants catalogue as the fallback for a row the
 * render catalogue does not carry. Obstacle taps and layout drafts are resolved here so the app never
 * disagrees with the surface about which tiles a thing occupies. */
class BaseGeometry(private val catalogue: JsonObject, renderCatalogue: JsonObject?) {
    private val entries = renderCatalogue?.objects("entries").orEmpty()
    private val obstacleArt = (renderCatalogue?.get("basePresentation") as? JsonObject)?.get("obstacles") as? JsonObject

    fun footprint(type: String, level: Int, geometryVersion: Int? = null): Pair<Int, Int> {
        val entry = entries.firstOrNull { it.string("type") == type && it.string("level") == level.toString() }
        val width = entry?.string("footprintWidth")?.toFloatOrNull()?.toInt(); val height = entry?.string("footprintHeight")?.toFloatOrNull()?.toInt()
        return if (width != null && height != null && width > 0 && height > 0) width to height else footprintOf(catalogue, type, geometryVersion)
    }
    fun footprint(building: Building): Pair<Int, Int> = footprint(building.type, building.level)
    fun obstacleFootprint(obstacle: Obstacle): Int {
        val art = obstacleArt?.get(obstacle.spriteKey.orEmpty()) as? JsonObject
        return art?.string("footprintWidth")?.toFloatOrNull()?.toInt()?.takeIf { it > 0 } ?: obstacleSize(catalogue, obstacle.spriteKey.orEmpty())
    }

    /** The topmost building whose footprint covers the tapped tile, in list order like the renderer's reversed draw order. */
    fun buildingAt(buildings: List<Building>, x: Float, y: Float, position: (Building) -> Pair<Int, Int> = { it.tx to it.ty }): Building? {
        val tx = floor(x).toInt(); val ty = floor(y).toInt()
        return buildings.lastOrNull { building ->
            val (px, py) = position(building); val (fw, fh) = footprint(building)
            tx >= px && tx < px + fw && ty >= py && ty < py + fh
        }
    }
    fun obstacleAt(obstacles: List<Obstacle>, x: Float, y: Float): Obstacle? {
        val tx = floor(x).toInt(); val ty = floor(y).toInt()
        return obstacles.lastOrNull { obstacle -> val size = obstacleFootprint(obstacle); tx >= obstacle.tx && tx < obstacle.tx + size && ty >= obstacle.ty && ty < obstacle.ty + size }
    }

    /** The highlight names the building it marks ([SceneHighlight.targetId]) so the renderer can outline its sprite. */
    fun highlight(building: Building, color: Int, alpha: Float, position: Pair<Int, Int> = building.tx to building.ty,
                  kind: SceneHighlightKind = SceneHighlightKind.FILL): SceneHighlight {
        val (fw, fh) = footprint(building)
        return SceneHighlight(position.first.toFloat(), position.second.toFloat(), fw.toFloat(), fh.toFloat(), color, alpha, kind, targetId = building.id)
    }
    fun highlight(obstacle: Obstacle, color: Int, alpha: Float, kind: SceneHighlightKind = SceneHighlightKind.FILL): SceneHighlight {
        val size = obstacleFootprint(obstacle).toFloat()
        return SceneHighlight(obstacle.tx.toFloat(), obstacle.ty.toFloat(), size, size, color, alpha, kind, targetId = obstacle.id)
    }
    /** The footprint `type` at `level` would occupy from `tile`, coloured by what the app knows of its validity
     * (web `showFootprintTint`): green / red from a local check, neutral gold when only the server can answer. */
    fun footprintHighlight(type: String, level: Int, tile: Pair<Int, Int>, valid: Boolean?): SceneHighlight {
        val (fw, fh) = footprint(type, level)
        return SceneHighlight(tile.first.toFloat(), tile.second.toFloat(), fw.toFloat(), fh.toFloat(), HighlightColors.footprint(valid), FOOTPRINT_ALPHA, SceneHighlightKind.FOOTPRINT)
    }

    companion object {
        /** Palette.gold: a selected building, the wall row a purchase prices. */
        const val SELECTION = HighlightColors.GOLD
        /** The web's VALID_TINT for painted tiles. */
        const val PAINT = 0x6FCF7A
        /** The soft fill under a selected footprint; its outline carries the emphasis. */
        const val SELECTION_ALPHA = 0.18f
        /** Web `showFootprintTint`: the tiles under a placed or moving building. */
        const val FOOTPRINT_ALPHA = 0.35f
        /** Web `drawPlacementGrid` line alpha: faint enough to read the ground through it. */
        const val GRID_ALPHA = 0.12f

        /** The faint plot grid the player sees while a building is placed or moved (web `drawPlacementGrid`);
         * null for a claim with no area. */
        fun plotGrid(claimMin: Int, claimMax: Int): SceneHighlight? {
            val size = claimMax - claimMin
            if (size <= 0) return null
            return SceneHighlight(claimMin.toFloat(), claimMin.toFloat(), size.toFloat(), size.toFloat(), HighlightColors.INK, GRID_ALPHA, SceneHighlightKind.GRID)
        }
    }
}
