package gg.pixelkingdomwars.nativeclient.network

import java.math.BigInteger
import java.time.Instant
import kotlinx.serialization.json.*

data class ResearchChoice(val troop: String, val level: Int, val target: Int, val cost: BigInteger?, val seconds: Long?, val reason: String?)
private fun JsonObject.objectAt(key: String) = this[key] as? JsonObject
private fun JsonObject.integer(key: String) = string(key)?.toIntOrNull()
private fun JsonObject.amount(key: String) = string(key)?.toBigIntegerOrNull()?.takeIf { it.signum() >= 0 }
fun researchRemaining(row: JsonObject, now: Long): Long? = row.string("finishesAt")?.let { runCatching { ((Instant.parse(it).toEpochMilli()-now+999)/1000).coerceAtLeast(0) }.getOrNull() }
fun researchSpeedupPrice(catalogue: JsonObject, row: JsonObject, now: Long): BigInteger? {
    val rules=catalogue.objectAt("display")?.objectAt("research")?.objectAt("speedup") ?: return null
    val remaining=researchRemaining(row,now)?.takeIf { it>0 } ?: return null
    val rate=rules.amount("rate")?.takeIf { it.signum()>0 } ?: return null
    val granularity=rules.amount("granularitySec")?.takeIf { it.signum()>0 } ?: return null
    val soft=rules.amount("quadraticSoftUnits")?.takeIf { it.signum()>0 } ?: return null
    val units=(remaining.toBigInteger()+granularity-BigInteger.ONE)/granularity
    return units*rate+(rate*units*units+soft-BigInteger.ONE)/soft
}
fun researchConsentSupported(army: JsonObject) = army.objectAt("features")?.objectAt("researchConsent")?.integer("version")==1
fun researchConsent(target: JsonObject): JsonObject = buildJsonObject {
    put("currentLevel",requireNotNull(target.integer("level")))
    when(target.string("action")) {
        "start" -> put("maxCostShards",requireNotNull(target.string("price")))
        "finish", "cancel" -> {
            put("episodeId",requireNotNull(target["episodeId"]))
            put("toLevel",requireNotNull(target.integer("toLevel")))
            put("finishesAt",requireNotNull(target.string("finishesAt")))
            if(target.string("action")=="finish") put("maxCostKeep",requireNotNull(target.string("price")))
        }
        else -> error("Unknown research action")
    }
}
fun researchChoices(catalogue: JsonObject, base: JsonObject, army: JsonObject, balances: JsonObject): List<ResearchChoice> {
    val metadata=catalogue.objectAt("display")?.objectAt("research") ?: return emptyList()
    val constants=catalogue.objectAt("constants") ?: return emptyList()
    val leveling=constants.objectAt("TROOP_LEVELING") ?: return emptyList()
    val active=(army["research"] as? JsonArray) ?: return emptyList()
    val levels=army.objectAt("levels") ?: return emptyList()
    val building=base.objects("buildings")
    val unfinished=base.objects("jobs").filter { it.string("kind")=="build" }.mapNotNull { it.string("buildingId") }
    val forge=building.filter { it.string("type")=="forge" && it.string("id") !in unfinished }.maxOfOrNull { it.integer("level") ?: 0 } ?: 0
    val dark=(metadata["darkTroops"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: return emptyList()
    val elite=metadata.objectAt("eliteItems") ?: return emptyList()
    val maximum=leveling.integer("maxLevel") ?: return emptyList()
    return (metadata["troops"] as? JsonArray).orEmpty().mapNotNull { value ->
        val troop=value.jsonPrimitive.content
        val level=levels.integer(troop)?.takeIf { it>0 } ?: return@mapNotNull null
        val stats=constants.objectAt("TROOPS")?.objectAt(troop) ?: return@mapNotNull null
        val cost=(leveling["researchCostKeep"] as? JsonArray)?.getOrNull(level-1)?.jsonPrimitive?.content?.toBigIntegerOrNull()
        val seconds=(leveling["researchTimeSec"] as? JsonArray)?.getOrNull(level-1)?.jsonPrimitive?.longOrNull
        val keep=base.objectAt("player")?.integer("keepLevel")
        val reason=when {
            !researchConsentSupported(army) -> "Research orders are awaiting compatible server support"
            level>=maximum -> "Maximum level"
            troop in dark && army.objectAt("features")?.objectAt("darkAttackerRoster")?.flag("enabled") != true -> "Coming soon"
            elite.containsKey(troop) && army.objectAt("eliteUnlocks")?.flag(troop) != true -> "Requires ${elite.string(troop)} unlock"
            stats.integer("requiresKeepLevel")?.let { keep==null || keep<it } == true -> "Requires Keep level ${stats.integer("requiresKeepLevel")}"
            active.isNotEmpty() -> "Forge is researching"
            forge<level+1 -> "Requires completed Forge level ${level+1}"
            cost==null || cost.signum()<0 || seconds==null || seconds<0 -> "Research data unavailable"
            balances.amount("shards")?.let { it>=cost } != true -> "Insufficient SHARDS"
            else -> null
        }
        ResearchChoice(troop,level,level+1,cost,seconds,reason)
    }
}
/** A displayed episode must still match before any money-changing POST. */
fun researchActionMatches(action: JsonObject, army: JsonObject): Boolean {
    val troop=action.string("troop") ?: return false
    val levels=army.objectAt("levels") ?: return false
    val rows=army["research"] as? JsonArray ?: return false
    if(levels.string(troop)!=action.string("level")) return false
    val row=rows.mapNotNull { it as? JsonObject }.firstOrNull { it.string("troop")==troop }
    return if(action.string("action")=="start") rows.isEmpty()
    else action.containsKey("episodeId") && row?.containsKey("episodeId")==true && row["episodeId"]==action["episodeId"] && row.string("toLevel")==action.string("toLevel") && row.string("finishesAt")==action.string("finishesAt")
}
fun researchStateAdvanced(order: JsonObject, army: JsonObject): Boolean {
    val target=order.objectAt("target") ?: return false
    val troop=target.string("troop") ?: return false
    val level=army.objectAt("levels")?.integer(troop) ?: return false
    val rows=army["research"] as? JsonArray ?: return false
    val row=rows.mapNotNull { it as? JsonObject }.firstOrNull { it.string("troop")==troop }
    return when(target.string("action")) {
        "start" -> level >= requireNotNull(target.integer("toLevel")) || row?.integer("toLevel")==target.integer("toLevel")
        "finish" -> level >= requireNotNull(target.integer("toLevel"))
        "cancel" -> !researchActionMatches(target,army)
        else -> false
    }
}
