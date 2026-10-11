package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.FantasyTile
import gg.pixelkingdomwars.nativeclient.network.string
import java.io.File
import java.util.Locale
import kotlinx.serialization.json.*

/** The frozen owner-approved geography shipped in the pack (`fantasy/world-v1.json`, D-128), read the
 * way `packages/shared/src/fantasyWorld.ts` reads it: realm membership as run-length tile ranges,
 * Genesis and Seeker sanctuaries partitioning Solana Reach. Geometry (`columns`/`rows`) comes from
 * the catalogue's `FANTASY_WORLD`; the membership hash pins the file to the catalogue module. */
class FantasyCatalog private constructor(
    val columns: Int,
    val rows: Int,
    val membershipHash: String,
    val realmIds: List<String>,
    /** Sorted, non-overlapping `[start, end]` runs with the realm index they belong to. */
    private val runs: List<Run>,
    private val genesis: List<IntRange>,
    private val seeker: List<IntRange>,
) {
    private class Run(val start: Int, val end: Int, val realm: Int)
    val totalCells: Int get() = columns * rows

    private fun runAt(tileId: Int): Run? {
        var low = 0; var high = runs.size - 1
        while (low <= high) {
            val mid = (low + high) ushr 1; val run = runs[mid]
            when { tileId < run.start -> high = mid - 1; tileId > run.end -> low = mid + 1; else -> return run }
        }
        return null
    }
    private fun allocation(tileId: Int): String = when {
        genesis.any { tileId in it } -> "genesis"
        seeker.any { tileId in it } -> "seeker"
        else -> "ordinary"
    }

    /** `getFantasyTile`: null outside the world or off every realm; a Solana Reach tile is never ordinary. */
    fun tile(tileId: Int): FantasyTile? {
        if (tileId < 0 || tileId >= totalCells) return null
        val run = runAt(tileId) ?: return null
        val realm = realmIds[run.realm]
        val allocation = allocation(tileId)
        if (realm == SEEKER_REALM && allocation == "ordinary") throw IllegalStateException("Unreserved Solana tile")
        return FantasyTile(BaseDirectory.FANTASY_WORLD_ID, tileId, realm, allocation, lon(tileId), lat(tileId))
    }
    fun isLand(tileId: Int): Boolean = runAt(tileId)!=null
    fun isGenesis(tileId: Int): Boolean = genesis.any { tileId in it }
    fun x(tileId: Int): Int = tileId % columns
    fun y(tileId: Int): Int = tileId / columns
    fun tileAt(x: Int, y: Int): Int? = if (x in 0 until columns && y in 0 until rows) y * columns + x else null
    private fun lon(tileId: Int) = String.format(Locale.ROOT, "%.2f", (x(tileId) + 0.5) * 360.0 / columns - 180.0)
    private fun lat(tileId: Int) = String.format(Locale.ROOT, "%.2f", 90.0 - (y(tileId) + 0.5) * 180.0 / rows)

    /** Ordinary (purchasable) tiles of [realmId] in tile order, at most [limit], starting at or after [from]. */
    fun ordinaryTiles(realmId: String, from: Int = 0, limit: Int): List<Int> {
        val realm = realmIds.indexOf(realmId); if (realm < 0 || limit <= 0) return emptyList()
        val out = ArrayList<Int>(limit)
        for (run in runs) {
            if (run.realm != realm || run.end < from) continue
            for (tileId in maxOf(run.start, from)..run.end) {
                if (allocation(tileId) != "ordinary") continue
                out += tileId; if (out.size == limit) return out
            }
        }
        return out
    }
    fun realmCells(realmId: String): Int { val realm = realmIds.indexOf(realmId); return runs.filter { it.realm == realm }.sumOf { it.end - it.start + 1 } }

    companion object {
        /** The one world id lives in the network model ([BaseDirectory.FANTASY_WORLD_ID]); the reserved realm is the web's `SEEKER_REALM`. */
        const val SEEKER_REALM = "seeker-reach"
        fun parse(world: JsonObject, columns: Int, rows: Int): FantasyCatalog {
            require(columns > 0 && rows > 0) { "Fantasy world geometry is missing" }
            val cells = columns * rows
            val regions = requireNotNull(world["regions"] as? JsonArray) { "Malformed frozen fantasy catalog" }.map { it.jsonObject }
            val ids = regions.map { requireNotNull(it.string("id")) { "Malformed frozen fantasy catalog" } }
            val runs = mutableListOf<Run>()
            regions.forEachIndexed { index, region ->
                for (run in requireNotNull(region["runs"] as? JsonArray)) {
                    val pair = run.jsonArray; require(pair.size == 2) { "Malformed frozen fantasy catalog" }
                    val start = pair[0].jsonPrimitive.int; val end = pair[1].jsonPrimitive.int
                    require(start in 0..end && end < cells) { "Malformed frozen fantasy catalog" }
                    runs += Run(start, end, index)
                }
            }
            runs.sortBy { it.start }
            runs.zipWithNext().forEach { (a, b) -> require(a.end < b.start) { "Overlapping frozen fantasy tiles" } }
            fun ranges(key: String) = (world[key] as? JsonArray).orEmpty().map { val pair = it.jsonArray; pair[0].jsonPrimitive.int..pair[1].jsonPrimitive.int }
            val catalog = FantasyCatalog(columns, rows, requireNotNull(world.string("membershipSha256")), ids, runs, ranges("genesisRuns"), ranges("seekerRuns"))
            val seekerIndex = ids.indexOf(SEEKER_REALM)
            for (range in catalog.genesis + catalog.seeker) for (cell in range) {
                require(catalog.runAt(cell)?.realm == seekerIndex) { "Sanctuary membership must partition Solana Reach" }
            }
            require(catalog.genesis.none { g -> catalog.seeker.any { s -> g.first <= s.last && s.first <= g.last } }) { "Sanctuary membership must partition Solana Reach" }
            return catalog
        }
        /** Reads the pack file and pins it to the catalogue module's membership hash and geometry. */
        fun load(assets: File, catalogue: JsonObject): FantasyCatalog {
            val constants = requireNotNull((catalogue["constants"] as? JsonObject)?.get("FANTASY_WORLD") as? JsonObject) { "The catalogue has no FANTASY_WORLD geometry" }
            val module = (catalogue["modules"] as? JsonObject)?.get("fantasyWorld") as? JsonObject
            val world = Json.parseToJsonElement(File(assets, "fantasy/world-v1.json").readText()).jsonObject
            val catalog = parse(world, requireNotNull(constants.string("columns")).toInt(), requireNotNull(constants.string("rows")).toInt())
            module?.string("FANTASY_MEMBERSHIP_HASH")?.let { require(it == catalog.membershipHash) { "The bundled fantasy world does not match the catalogue" } }
            require(constants.string("totalTiles")?.toIntOrNull()?.let { it == catalog.runs.sumOf { r -> r.end - r.start + 1 } } != false) { "The bundled fantasy world does not match the catalogue" }
            return catalog
        }
    }
}
