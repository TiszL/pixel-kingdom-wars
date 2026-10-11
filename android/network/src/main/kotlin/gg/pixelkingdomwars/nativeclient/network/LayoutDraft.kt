package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.PlotGeometry
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.LayoutPosition
import gg.pixelkingdomwars.nativeclient.model.LayoutSlot
import gg.pixelkingdomwars.nativeclient.model.Obstacle
import kotlinx.serialization.json.*

/** Port of `apps/web/src/ui/layoutEditor/model.ts`: the reversible coordinate draft the layout editor
 * edits. Every rule here is the client-side twin of `apps/api/src/game/layouts.ts validateTarget`; the
 * server re-validates the complete layout on save and remains the authority. */
const val LAYOUT_UNDO_LIMIT = 40

/** D-099: the wire id `FARM` reads BASE; `HOME` reads HOME. Every label routes through here. */
fun layoutSlotLabel(slot: String): String = if (slot == "FARM") "BASE" else slot

data class LayoutGeometry(
    val geometryVersion: Int,
    val claimMin: Int,
    val claimMax: Int,
    val buildings: List<Building>,
    val obstacles: List<Obstacle>,
    /** `footprintOf(type, geometryVersion)` from the constants catalogue. */
    val footprint: (String) -> Pair<Int, Int>,
    /** `OBSTACLES.tiers[*].sizeTiles` for a sprite key; unknown sprites occupy one tile. */
    val obstacleSize: (String) -> Int,
    val plotGeometry: PlotGeometry? = null,
)

data class DraftSnapshot(val positions: List<LayoutPosition>, val trayIds: List<String>, val selectedId: String?)
data class LayoutDraft(
    val positions: List<LayoutPosition>,
    val trayIds: List<String>,
    val selectedId: String?,
    val history: List<DraftSnapshot> = emptyList(),
    val dirty: Boolean = false,
) {
    fun position(buildingId: String): LayoutPosition? = positions.firstOrNull { it.buildingId == buildingId }
    fun inTray(buildingId: String): Boolean = buildingId in trayIds
}
data class DraftResult(val draft: LayoutDraft, val error: String?)

fun canonicalPositions(positions: List<LayoutPosition>): List<LayoutPosition> =
    positions.map { LayoutPosition(it.buildingId, it.tx, it.ty) }.sortedBy { it.buildingId }

private fun LayoutDraft.snapshot() = DraftSnapshot(canonicalPositions(positions), trayIds.toList(), selectedId)

private fun commit(draft: LayoutDraft, next: DraftSnapshot): LayoutDraft {
    val before = draft.snapshot()
    val normalized = next.copy(positions = canonicalPositions(next.positions))
    if (before == normalized) return draft
    return LayoutDraft(normalized.positions, normalized.trayIds, normalized.selectedId, (draft.history + before).takeLast(LAYOUT_UNDO_LIMIT), dirty = true)
}

private data class Rect(val tx: Int, val ty: Int, val fw: Int, val fh: Int)
private fun overlaps(a: Rect, b: Rect) = a.tx < b.tx + b.fw && b.tx < a.tx + a.fw && a.ty < b.ty + b.fh && b.ty < a.ty + a.fh

fun validatePlacement(geometry: LayoutGeometry, positions: List<LayoutPosition>, buildingId: String, tx: Int, ty: Int): String? {
    val building = geometry.buildings.firstOrNull { it.id == buildingId } ?: return "BUILDING NO LONGER EXISTS"
    val (fw, fh) = geometry.footprint(building.type)
    if (geometry.plotGeometry?.contains(tx, ty, fw, fh) == false) return "OUTSIDE THE ACTIVE CLAIM"
    val target = Rect(tx, ty, fw, fh)
    if (tx < geometry.claimMin || ty < geometry.claimMin || tx + fw > geometry.claimMax || ty + fh > geometry.claimMax) return "OUTSIDE THE ACTIVE CLAIM"
    for (position in positions) {
        if (position.buildingId == buildingId) continue
        val other = geometry.buildings.firstOrNull { it.id == position.buildingId } ?: continue
        val (ofw, ofh) = geometry.footprint(other.type)
        if (overlaps(target, Rect(position.tx, position.ty, ofw, ofh))) return "ANOTHER BUILDING OCCUPIES THOSE TILES"
    }
    for (obstacle in geometry.obstacles) {
        val size = geometry.obstacleSize(obstacle.spriteKey.orEmpty())
        if (overlaps(target, Rect(obstacle.tx, obstacle.ty, size, size))) return "AN OBSTACLE BLOCKS THOSE TILES"
    }
    return null
}

fun validateCompleteLayout(geometry: LayoutGeometry, positions: List<LayoutPosition>): String? {
    if (positions.size != geometry.buildings.size) return "LAYOUT MUST PLACE EVERY BUILDING"
    val ids = positions.map { it.buildingId }.toSet()
    if (ids.size != positions.size || geometry.buildings.any { it.id !in ids }) return "LAYOUT BUILDING IDENTITIES DO NOT MATCH THIS BASE"
    for (position in positions) validatePlacement(geometry, positions, position.buildingId, position.tx, position.ty)?.let { return it }
    return null
}

/** Empty/repair slots begin from the authoritative live base; a repair never guesses where a removed or
 * newly built identity should go. Only a `ready` slot seeds the draft with its saved positions. */
fun createDraft(buildings: List<Building>, slot: LayoutSlot): LayoutDraft {
    val live = canonicalPositions(buildings.map { LayoutPosition(it.id, it.tx, it.ty) })
    val positions = if (slot.compatibility == "ready") canonicalPositions(slot.positions) else live
    return LayoutDraft(positions, emptyList(), null, emptyList(), dirty = slot.compatibility != "ready")
}

fun selectBuilding(draft: LayoutDraft, buildingId: String?): LayoutDraft = draft.copy(selectedId = buildingId)

fun moveBuilding(draft: LayoutDraft, geometry: LayoutGeometry, buildingId: String, tx: Int, ty: Int): DraftResult {
    validatePlacement(geometry, draft.positions, buildingId, tx, ty)?.let { return DraftResult(draft, it) }
    val exists = draft.positions.any { it.buildingId == buildingId }
    val positions = if (exists) draft.positions.map { if (it.buildingId == buildingId) LayoutPosition(buildingId, tx, ty) else it }
        else draft.positions + LayoutPosition(buildingId, tx, ty)
    return DraftResult(commit(draft, DraftSnapshot(positions, draft.trayIds.filter { it != buildingId }, buildingId)), null)
}

fun nudgeSelected(draft: LayoutDraft, geometry: LayoutGeometry, dx: Int, dy: Int): DraftResult {
    val selected = draft.selectedId ?: return DraftResult(draft, "SELECT A BUILDING FIRST")
    val current = draft.position(selected) ?: return DraftResult(draft, "PLACE THIS BUILDING FROM THE TRAY FIRST")
    return moveBuilding(draft, geometry, current.buildingId, current.tx + dx, current.ty + dy)
}

fun moveToTray(draft: LayoutDraft, buildings: List<Building>, buildingId: String): DraftResult {
    if (buildings.none { it.id == buildingId }) return DraftResult(draft, "BUILDING NO LONGER EXISTS")
    if (draft.inTray(buildingId)) return DraftResult(draft, null)
    return DraftResult(commit(draft, DraftSnapshot(draft.positions.filter { it.buildingId != buildingId }, draft.trayIds + buildingId, buildingId)), null)
}

fun pickUpAll(draft: LayoutDraft, buildings: List<Building>): LayoutDraft =
    commit(draft, DraftSnapshot(emptyList(), buildings.map { it.id }, null))

/** Paint consumes existing trayed wall identities of [level] in stable tray order. It never creates a
 * wall or changes its level; invalid tiles are skipped, matching the ordinary wall stroke without hiding
 * a partial result. */
fun paintWalls(draft: LayoutDraft, geometry: LayoutGeometry, level: Int, tiles: List<Pair<Int, Int>>): DraftResult {
    val byId = geometry.buildings.associateBy { it.id }
    val walls = draft.trayIds.filter { id -> byId[id]?.let { it.type == "wall" && it.level == level } == true }
    if (walls.isEmpty()) return DraftResult(draft, "PUT LEVEL $level WALLS IN THE TRAY BEFORE PAINTING")
    var positions = canonicalPositions(draft.positions)
    val placed = mutableListOf<String>()
    val seen = mutableSetOf<Pair<Int, Int>>()
    for (tile in tiles) {
        val id = walls.getOrNull(placed.size) ?: break
        if (!seen.add(tile)) continue
        if (validatePlacement(geometry, positions, id, tile.first, tile.second) != null) continue
        positions = positions + LayoutPosition(id, tile.first, tile.second)
        placed += id
    }
    if (placed.isEmpty()) return DraftResult(draft, "NO FREE WALL TILES IN THAT STROKE")
    return DraftResult(commit(draft, DraftSnapshot(positions, draft.trayIds.filter { it !in placed }, placed.last())), null)
}

fun replaceDraftPositions(draft: LayoutDraft, positions: List<LayoutPosition>): LayoutDraft =
    commit(draft, DraftSnapshot(canonicalPositions(positions), emptyList(), null))

fun undoDraft(draft: LayoutDraft): LayoutDraft {
    val prior = draft.history.lastOrNull() ?: return draft
    return LayoutDraft(prior.positions, prior.trayIds, prior.selectedId, draft.history.dropLast(1), dirty = true)
}

/** The draft as the scene sees it (web `BaseScene.applyLayoutDraft`): server buildings re-seated at
 * their draft coordinates, trayed identities withheld, and job scaffolds suppressed because they are
 * keyed to the unchanged server rows — the editor never fabricates replacement state. */
fun LayoutDraft.applyToBase(base: JsonObject): JsonObject {
    val at = positions.associateBy { it.buildingId }
    val buildings = base.objects("buildings").mapNotNull { building ->
        val id = building.string("id") ?: return@mapNotNull null
        if (id in trayIds) return@mapNotNull null
        val position = at[id] ?: return@mapNotNull null
        JsonObject(building + mapOf("tx" to JsonPrimitive(position.tx), "ty" to JsonPrimitive(position.ty)))
    }
    return JsonObject(base + mapOf("buildings" to JsonArray(buildings), "jobs" to JsonArray(emptyList())))
}
