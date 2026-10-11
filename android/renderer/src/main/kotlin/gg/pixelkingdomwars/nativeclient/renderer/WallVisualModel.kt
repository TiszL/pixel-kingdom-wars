package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue

/** Authored aliases come from the canonical 16-mask export, never rotated or guessed. */
class WallCatalogue(root: JsonValue) {
    private val byFrame: Map<String, Map<Int, String>> = buildMap {
        root.get("walls")?.toList().orEmpty().groupBy { it.getInt("level") }.values.forEach { level ->
            val masks = level.associate { it.getInt("mask") to it.getString("frameKey") }
            require(masks.keys == (0..15).toSet()) { "Incomplete authored wall connections" }
            masks.values.forEach { key ->
                require(get(key)?.let { it == masks } != false) { "Conflicting authored wall family" }
                put(key, masks)
            }
        }
    }
    fun family(frame: String): Map<Int, String>? = byFrame[frame]
}

/** Pure presentation history. A breach removes occupancy in canonical event order;
 * the dying piece freezes its previous row while surviving neighbours immediately retile.
 * Constructed off GL and replaced with the entire accepted presentation revision. */
class WallVisualModel(buildings: List<RenderBuilding>, catalogue: WallCatalogue,
                      events: List<PresentationEvent> = emptyList(), checkpoint: () -> Unit = {}) {
    private data class Cell(val x: Float, val y: Float)
    private data class Wall(val building: RenderBuilding, val frames: Map<Int, String>)
    private data class Change(val tick: Int, val frame: String)
    private val history = mutableMapOf<String, MutableList<Change>>()
    val requiredFrames: Set<String>
    init {
        val walls = buildings.mapNotNull { b -> checkpoint(); catalogue.family(b.frameKey)?.let { Wall(b, it) } }
        val live = walls.associateBy { Cell(it.building.tileX, it.building.tileY) }.toMutableMap()
        require(live.size == walls.size) { "Overlapping wall presentation cells" }
        val byId = walls.associateBy { it.building.id }
        fun frame(wall: Wall): String {
            val b = wall.building
            // packages/shared/src/wallConnect.ts: N=1 E=2 S=4 W=8; mixed levels connect.
            val mask = (if (Cell(b.tileX,b.tileY-1) in live) 1 else 0) or
                (if (Cell(b.tileX+1,b.tileY) in live) 2 else 0) or
                (if (Cell(b.tileX,b.tileY+1) in live) 4 else 0) or
                (if (Cell(b.tileX-1,b.tileY) in live) 8 else 0)
            return wall.frames.getValue(mask)
        }
        walls.forEach { history[it.building.id] = mutableListOf(Change(Int.MIN_VALUE, frame(it))) }
        var previousTick = Int.MIN_VALUE
        events.forEach { event ->
            checkpoint()
            require(event.t >= previousTick) { "Unordered wall presentation events" }
            previousTick = event.t
            if (event.e == "destroyed") {
                val id = JsonReader().parse(event.json).getString("id")
                val wall = byId[id] ?: return@forEach
                val b = wall.building
                if (live.remove(Cell(b.tileX,b.tileY)) == null) return@forEach
                listOf(Cell(b.tileX,b.tileY-1),Cell(b.tileX+1,b.tileY),Cell(b.tileX,b.tileY+1),Cell(b.tileX-1,b.tileY))
                    .mapNotNull(live::get).forEach { neighbour ->
                        val changes = history.getValue(neighbour.building.id)
                        val next = frame(neighbour)
                        if (changes.last().frame != next) changes += Change(event.t,next)
                    }
            }
        }
        requiredFrames = history.values.flatMap { changes -> changes.map { it.frame } }.toSet()
    }
    fun frameAt(id: String, tick: Float): String? = changeAt(id,tick)?.frame
    fun frameSinceTick(id: String, tick: Float): Int? = changeAt(id,tick)?.tick?.coerceAtLeast(0)
    private fun changeAt(id: String, tick: Float): Change? {
        val changes = history[id] ?: return null
        var low = 0; var high = changes.size
        while (low < high) { val mid = (low+high) ushr 1; if (changes[mid].tick <= tick) low=mid+1 else high=mid }
        return changes[(low-1).coerceAtLeast(0)]
    }
}
