package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*

data class BaseOrderPrice(val currency: String, val amount: String, val seconds: String?)

/** Display values are selected from the exported canonical tables. The API still prices and validates every order. */
fun buildingPrice(catalogue: JsonObject, base: JsonObject, type: String): BaseOrderPrice? {
    val constants = catalogue["constants"] as? JsonObject ?: return null
    val build = (constants["BUILD_COSTS"] as? JsonObject)?.get(type) as? JsonObject ?: return null
    val hero = when(type) { "heroaltar" -> "vex"; "siegestool" -> "theodor"; else -> null }
    if(hero != null) return null // Recruitment needs the item/KEEP consent flow, not an ordinary build order.
    if(type == "mine") {
        val index = base.objects("buildings").count { it.string("type") == "mine" }
        val prices = (constants["MINING"] as? JsonObject)?.get("MINE_BUILD_KEEP") as? JsonArray ?: return null
        val amount = (prices.getOrNull(index) as? JsonPrimitive)?.contentOrNull ?: return null
        return BaseOrderPrice(if(index == 0) "SHARDS" else "KEEP",amount,build.string("buildSec"))
    }
    return build.string("costShards")?.let { BaseOrderPrice("SHARDS",it,build.string("buildSec")) }
}

fun buildingUpgradePrice(catalogue: JsonObject, building: JsonObject): BaseOrderPrice? {
    val type = building.string("type") ?: return null
    val level = building.string("level")?.toIntOrNull()?.takeIf { it > 0 } ?: return null
    val constants = catalogue["constants"] as? JsonObject ?: return null
    val costs = (constants["UPGRADE_COSTS"] as? JsonObject)?.get(type) as? JsonArray ?: return null
    val amount = (costs.getOrNull(level - 1) as? JsonPrimitive)?.contentOrNull ?: return null
    // A missing paid-step table is unsupported, never a guessed free/SOL-less order.
    val sol = ((catalogue["display"] as? JsonObject)?.get("upgradeSolLamports") as? JsonObject)?.get(type) as? JsonObject ?: return null
    // The exporter fills a type's table from `settings.maxLevel`, which no defence, trap or wall carries, so their
    // tables are present but EMPTY in every published pack. The canonical `upgradeSolLamports(type, level)` answers 0
    // for every level that has no SOL step, so an absent LEVEL inside a present TYPE table is that same 0 — reading
    // it as "unsupported" disabled UPGRADE on every cannon, tower, trap and wall (owner, 0.5.3). Only a positive
    // step routes to the paid purchase; the server re-prices every order and refuses a shard order for a SOL step.
    if((sol.string((level + 1).toString()) ?: "0") != "0") return null
    val duration = ((constants["UPGRADE_TIMES_SEC"] as? JsonObject)?.get(type) as? JsonArray)?.getOrNull(level-1) as? JsonPrimitive
    return BaseOrderPrice("SHARDS",amount,if(type == "wall") null else duration?.contentOrNull)
}
