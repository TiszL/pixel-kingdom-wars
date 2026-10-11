package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*

/** Pending bodies belong to the frozen attacking army, before any actor event exists. */
fun deploymentArtwork(source: JsonObject, renderCatalogue: JsonObject): Map<String,String> {
    val army = source["armySnapshot"] as? JsonObject ?: return emptyMap()
    val actors = renderCatalogue.objects("actors")
    val levels = army["levels"] as? JsonObject
    val counts = army["counts"] as? JsonObject
    val heroes = army["heroLevels"] as? JsonObject
    return buildMap {
        counts?.forEach { (troop, count) ->
            if ((count as? JsonPrimitive)?.intOrNull?.let { it > 0 } != true) return@forEach
            val level = levels?.string(troop) ?: "1"
            val art = actors.firstOrNull { it.string("type") == troop && it.string("level") == level && (it.string("variant") ?: "0") == "0" }
                ?: error("No approved pending artwork for $troop level $level")
            put(troop, requireNotNull(art.string("frameKey")))
        }
        heroes?.forEach { (hero, level) ->
            if ((level as? JsonPrimitive)?.intOrNull?.let { it > 0 } != true) return@forEach
            // Current source HeroFx uses the same authored hero skin at every gameplay level.
            val entries=actors.filter { it.string("type")==hero }
            val art = entries.firstOrNull { it.string("level")==level.jsonPrimitive.content }
                ?: entries.singleOrNull()?.takeIf {it.string("level")=="1"}
                ?: error("No approved pending hero artwork for $hero")
            put(hero, requireNotNull(art.string("frameKey")))
        }
    }
}

/** Frozen actor-specific art. Defender and summoned visuals never inherit attacker research. */
fun actorArtwork(replay: JsonObject, renderCatalogue: JsonObject): Map<String,String> {
    val events = replay.objects("events").filter { it.string("e") in setOf("deploy","spawn","troopSpawn") }
    // Scout reports are flat, actor-free snapshots. They need no attacking army or nested snapshot.
    if (events.isEmpty()) return emptyMap()
    val artwork = renderCatalogue.objects("actors").groupBy { it.string("type") }
    val army = replay["armySnapshot"] as? JsonObject
    val levels = army?.get("levels") as? JsonObject
    val heroLevels = army?.get("heroLevels") as? JsonObject
    val snapshot = requireNotNull(replay["snapshot"] as? JsonObject)
    val buildings = snapshot.objects("buildings").associateBy { it.string("id") }
    val defenders = snapshot.objects("defenderHeroes").associateBy { it.string("hero") }
    return buildMap {
        events.forEach { event ->
            val hero=event.string("hero"); val troop=requireNotNull(event.string("troop")); val type=hero ?: troop
            val level = when(event.string("e")) {
                "troopSpawn" -> requireNotNull(event.string("level")) { "Summoned actor has no frozen level" }
                "spawn" -> requireNotNull(buildings[event.string("from")]?.string("level")) { "Defender actor has no frozen nest level" }
                else -> if(hero != null && event.string("side")=="defender") requireNotNull(defenders[hero]?.string("level"))
                    else if(hero != null) heroLevels?.string(hero) ?: "1" else levels?.string(troop) ?: "1"
            }
            val variant = event.string("variant") ?: "0"
            val entries = artwork[type].orEmpty()
            val art = entries.firstOrNull { it.string("level")==level && (it.string("variant") ?: "0")==variant }
                // HeroFx's single authored skin serves every gameplay level, as in deploymentArtwork.
                // Never borrow a different troop tier, hero variant or ambiguous multi-skin entry.
                ?: entries.singleOrNull()?.takeIf { hero != null && it.string("level")=="1" && (it.string("variant") ?: "0")==variant }
                ?: error("No approved artwork for $type level $level variant $variant")
            put("#${requireNotNull(event.string("id"))}",requireNotNull(art.string("frameKey")))
        }
    }
}
