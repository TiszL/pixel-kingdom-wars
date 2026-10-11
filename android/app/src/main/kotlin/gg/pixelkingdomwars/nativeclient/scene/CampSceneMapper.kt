package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*

/** Source patrol.ts interleaves the ready army, deals across completed camps, then
 * caps each camp. Stop constructing the roster once every visible seat is filled. */
internal fun mapCampTroops(base: JsonObject, buildings: List<RenderBuilding>, catalogue: JsonObject,
    renderCatalogue: JsonObject, checkpoint: () -> Unit = {}): Pair<List<RenderCampTroop>, CampPatrolRules?> {
    val camps = buildings.filter { it.type == "camp" && !it.underConstruction }.sortedBy { it.id }
    val army = base.objects("army").filter { (it.string("count")?.toLongOrNull() ?: 0) > 0 }
        .sortedBy { it.string("troop") } // unordered API rows must not respawn unchanged camp seats
    if (camps.isEmpty() || army.isEmpty()) return emptyList<RenderCampTroop>() to null
    val constants = requireNotNull(catalogue["constants"] as? JsonObject)
    val ambience = requireNotNull(constants["AMBIENCE"] as? JsonObject) { "Camp patrol policy is unavailable" }
    fun number(key: String) = requireNotNull(ambience.string(key)?.toFloatOrNull()) { "Camp patrol policy missing $key" }
    val battleScale = requireNotNull((constants["BATTLE_SCALE"] as? JsonObject)?.string("troop")?.toFloatOrNull())
    val tile = requireNotNull((renderCatalogue["basePresentation"] as? JsonObject)?.string("tilePixels")?.toFloatOrNull())
    val rules = CampPatrolRules(number("garrisonMaxPerCamp").toInt(), number("garrisonSpeedPxPerSec"),
        number("garrisonWanderPadTiles"), number("garrisonPauseMinMs"), number("garrisonPauseMaxMs"),
        number("walkerDetourSearchTiles").toInt(), number("walkerRouteRetries").toInt(), number("garrisonScale") / battleScale, tile)
    require(army.map { it.string("troop") }.distinct().size == army.size) { "Duplicate ready-army row" }
    val campSection = (renderCatalogue["campPresentation"] as? JsonObject)?.also { require(it.string("version") == "1") { "Unsupported camp presentation" } }
    val compact = campSection?.let { requireNotNull(it["actors"] as? JsonObject) { "Compact camp catalogue is missing" } }
    val artwork = renderCatalogue.objects("actors").associateBy { Triple(it.string("type"), it.string("level"), it.string("variant") ?: "0") }
    val left = army.map { requireNotNull(it.string("count")).toLong() }.toLongArray()
    val result = ArrayList<RenderCampTroop>()
    val limit = Math.multiplyExact(camps.size, rules.maxPerCamp)
    while (result.size < limit && left.any { it > 0 }) {
        for (row in army.indices) {
            checkpoint()
            if (left[row] <= 0 || result.size == limit) continue
            val troop = requireNotNull(army[row].string("troop"))
            val level = requireNotNull(army[row].string("level")) { "Ready troop level is missing for $troop" }
            val entry = artwork[Triple(troop, level, "0")] ?: error("Camp artwork is unavailable for $troop level $level")
            compact?.let { require(it[entry.string("frameKey")] is JsonObject) { "Compact camp artwork is missing for $troop level $level" } }
            val index = result.size
            result += RenderCampTroop(camps[index % camps.size].id, index / camps.size, troop, level.toInt(), requireNotNull(entry.string("frameKey")))
            left[row]--
        }
    }
    return result to rules
}
