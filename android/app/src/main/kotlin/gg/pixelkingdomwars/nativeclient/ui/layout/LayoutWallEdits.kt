package gg.pixelkingdomwars.nativeclient.ui.layout

import gg.pixelkingdomwars.nativeclient.model.LayoutPosition
import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.network.DraftResult
import gg.pixelkingdomwars.nativeclient.network.DraftSnapshot
import gg.pixelkingdomwars.nativeclient.network.LAYOUT_UNDO_LIMIT
import gg.pixelkingdomwars.nativeclient.network.LayoutDraft
import gg.pixelkingdomwars.nativeclient.network.LayoutGeometry
import gg.pixelkingdomwars.nativeclient.network.canonicalPositions
import gg.pixelkingdomwars.nativeclient.network.paintWalls
import gg.pixelkingdomwars.nativeclient.network.validatePlacement
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeMode
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import gg.pixelkingdomwars.nativeclient.scene.wallStrokeGeometry

enum class LayoutWallTool { PAINT, ERASE, SELECT }

/** Every operation stays inside the authoritative inventory; the draft only chooses coordinates. */
private fun layoutWallInventoryValid(draft: LayoutDraft, geometry: LayoutGeometry): Boolean {
    val owned = geometry.buildings.map { it.id }
    val present = draft.positions.map { it.buildingId } + draft.trayIds
    return owned.size == owned.toSet().size && present.size == present.toSet().size && present.toSet() == owned.toSet()
}

/** Use Long before delegating to the legacy draft validator, whose rectangle sums are Ints. */
private fun layoutWallFitsBounds(geometry: LayoutGeometry, tx: Long, ty: Long, width: Int, height: Int): Boolean =
    width > 0 && height > 0 && geometry.claimMin < geometry.claimMax &&
        tx >= geometry.claimMin.toLong() && ty >= geometry.claimMin.toLong() &&
        tx + width.toLong() <= geometry.claimMax.toLong() && ty + height.toLong() <= geometry.claimMax.toLong() &&
        tx in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong() && ty in Int.MIN_VALUE.toLong()..Int.MAX_VALUE.toLong() &&
        geometry.plotGeometry?.contains(tx.toInt(), ty.toInt(), width, height) != false

private fun commitLayoutWallEdit(draft: LayoutDraft, positions: List<LayoutPosition>, trayIds: List<String>): LayoutDraft {
    val before = DraftSnapshot(canonicalPositions(draft.positions), draft.trayIds.toList(), draft.selectedId)
    val next = DraftSnapshot(canonicalPositions(positions), trayIds.toList(), draft.selectedId)
    if (before == next) return draft
    return LayoutDraft(next.positions, next.trayIds, next.selectedId,
        (draft.history + before).takeLast(LAYOUT_UNDO_LIMIT), dirty = true)
}

private const val WALL_INVENTORY_CHANGED = "LAYOUT BUILDING IDENTITIES DO NOT MATCH THIS BASE"

/** The existing draft painter owns wall-level filtering, tray order, duplicate samples and one-step
 * undo. Bounds are checked first so even an invalid incoming coordinate cannot overflow its checks. */
fun layoutPaintWalls(draft: LayoutDraft, geometry: LayoutGeometry, level: Int, tiles: List<WallStrokeTile>): DraftResult {
    if (!layoutWallInventoryValid(draft, geometry)) return DraftResult(draft, WALL_INVENTORY_CHANGED)
    val (width, height) = geometry.footprint("wall")
    return paintWalls(draft, geometry, level, tiles.filter {
        layoutWallFitsBounds(geometry, it.tx.toLong(), it.ty.toLong(), width, height)
    }.map { it.tx to it.ty })
}

private data class PlacedLayoutWall(val id: String, val tx: Int, val ty: Int, val width: Int, val height: Int) {
    fun contains(x: Int, y: Int): Boolean = width > 0 && height > 0 &&
        x.toLong() >= tx.toLong() && x.toLong() < tx.toLong() + width &&
        y.toLong() >= ty.toLong() && y.toLong() < ty.toLong() + height
}

private fun placedLayoutWalls(draft: LayoutDraft, geometry: LayoutGeometry): List<PlacedLayoutWall> {
    val owned = geometry.buildings.associateBy { it.id }
    val tray = draft.trayIds.toSet()
    val (width, height) = geometry.footprint("wall")
    return draft.positions.mapNotNull { position ->
        if (position.buildingId in tray || owned[position.buildingId]?.type != "wall") null
        else PlacedLayoutWall(position.buildingId, position.tx, position.ty, width, height)
    }
}

/** First-hit stroke order, with each placed owned identity included once. Hit-testing uses the draft
 * footprint, so an erased wall remains in the tray and the old live coordinate cannot select it. */
fun layoutWallSelection(draft: LayoutDraft, geometry: LayoutGeometry, tiles: List<WallStrokeTile>): List<String> {
    if (!layoutWallInventoryValid(draft, geometry)) return emptyList()
    val walls = placedLayoutWalls(draft, geometry)
    val selected = linkedSetOf<String>()
    for (tile in tiles) {
        if (!layoutWallFitsBounds(geometry, tile.tx.toLong(), tile.ty.toLong(), 1, 1)) continue
        walls.firstOrNull { it.contains(tile.tx, tile.ty) }?.let { selected.add(it.id) }
    }
    return selected.toList()
}

/** Erasing is a tray operation, never destruction or a purchase refund. The complete stroke creates
 * one snapshot, and replaying already-erased cells is an unchanged draft. */
fun eraseLayoutWalls(draft: LayoutDraft, geometry: LayoutGeometry, tiles: List<WallStrokeTile>): DraftResult {
    if (!layoutWallInventoryValid(draft, geometry)) return DraftResult(draft, WALL_INVENTORY_CHANGED)
    val ids = layoutWallSelection(draft, geometry, tiles)
    if (ids.isEmpty()) return DraftResult(draft, null)
    val removed = ids.toSet()
    return DraftResult(commitLayoutWallEdit(draft, draft.positions.filterNot { it.buildingId in removed }, draft.trayIds + ids), null)
}

/** Translate the selected owned walls as one draft operation. Validate against the final arrangement
 * so a member may occupy another member's vacated cell, but no member can partially move on refusal. */
fun moveLayoutWallRun(draft: LayoutDraft, geometry: LayoutGeometry, ids: List<String>, dx: Int, dy: Int): DraftResult {
    if (ids.isEmpty()) return DraftResult(draft, null)
    if (!layoutWallInventoryValid(draft, geometry)) return DraftResult(draft, WALL_INVENTORY_CHANGED)
    val moving = ids.toSet()
    if (moving.size != ids.size) return DraftResult(draft, "SELECT EACH WALL ONLY ONCE")
    val owned = geometry.buildings.associateBy { it.id }
    if (ids.any { owned[it]?.type != "wall" || draft.inTray(it) || draft.position(it) == null }) {
        return DraftResult(draft, "SELECT PLACED OWNED WALLS BEFORE MOVING")
    }
    if (dx == 0 && dy == 0) return DraftResult(draft, null)
    val (width, height) = geometry.footprint("wall")
    val destinations = linkedMapOf<String, LayoutPosition>()
    for (id in ids) {
        val origin = requireNotNull(draft.position(id))
        val tx = origin.tx.toLong() + dx.toLong(); val ty = origin.ty.toLong() + dy.toLong()
        if (!layoutWallFitsBounds(geometry, tx, ty, width, height)) return DraftResult(draft, "OUTSIDE THE ACTIVE CLAIM")
        destinations[id] = LayoutPosition(id, tx.toInt(), ty.toInt())
    }
    val positions = draft.positions.map { destinations[it.buildingId] ?: it }
    for (destination in destinations.values) {
        validatePlacement(geometry, positions, destination.buildingId, destination.tx, destination.ty)?.let {
            return DraftResult(draft, it)
        }
    }
    return DraftResult(commitLayoutWallEdit(draft, positions, draft.trayIds), null)
}

/** Reuses the BUILD stroke's plot/claim envelope while admitting only owned draft operations.
 * Paint samples a wall-sized anchor; erase/select sample a single cell of any placed wall footprint. */
fun layoutWallStrokeMode(token: String, baseId: String, draft: LayoutDraft, geometry: LayoutGeometry,
    tool: LayoutWallTool, level: Int?): WallStrokeMode? {
    if (token.isBlank() || baseId.isBlank() || !layoutWallInventoryValid(draft, geometry)) return null
    val plot = geometry.plotGeometry ?: PlotGeometry.supported(1)
    if (geometry.claimMin < plot.min || geometry.claimMax > plot.max || geometry.claimMin >= geometry.claimMax) return null
    val (width, height) = geometry.footprint("wall")
    if (width !in 1..plot.size || height !in 1..plot.size) return null
    if (tool == LayoutWallTool.PAINT) {
        if (level == null) return null
        val owned = geometry.buildings.associateBy { it.id }
        val id = draft.trayIds.firstOrNull { owned[it]?.let { wall -> wall.type == "wall" && wall.level == level } == true } ?: return null
        return wallStrokeGeometry(token, baseId, plot, geometry.claimMin, geometry.claimMax, width, height) { tx, ty ->
            layoutWallFitsBounds(geometry, tx.toLong(), ty.toLong(), width, height) &&
                validatePlacement(geometry, draft.positions, id, tx, ty) == null
        }
    }
    val walls = placedLayoutWalls(draft, geometry)
    if (walls.isEmpty()) return null
    return wallStrokeGeometry(token, baseId, plot, geometry.claimMin, geometry.claimMax, 1, 1) { tx, ty ->
        walls.any { it.contains(tx, ty) }
    }
}
