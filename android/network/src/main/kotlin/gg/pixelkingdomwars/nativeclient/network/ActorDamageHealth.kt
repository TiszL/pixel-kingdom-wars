package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*

/** Only damaged-body display maxima. Uses the frozen raid loadout and accepted
 * hero orders, including an order whose hero never spawned before victory. */
fun actorDamageMaxHp(source: JsonObject, render: JsonObject, catalogue: JsonObject, frames: Map<String,String>): Map<Int,Long> {
    val damaged = render.objects("actors").mapNotNull { actor ->
        val combat = actor["combat"] as? JsonObject
            ?: (render["combatProfiles"] as? JsonObject)?.get(actor.string("combatKey")) as? JsonObject
        val maximum = if(combat?.get("damagedBody") is JsonObject) requireNotNull((actor["damagedBodyMaxHp"] as? JsonPrimitive)?.longOrNull) else null
        maximum?.let { require(it > 0); requireNotNull(actor.string("frameKey")) to it }
    }.toMap()
    if (damaged.isEmpty()) return emptyMap() // Historical packs contain no optional body-health contract.
    val bps = alliedTroopHpBps(source, catalogue)
    return buildMap {
        for (event in source.objects("events")) {
            if (event.string("e") !in setOf("deploy","spawn","troopSpawn")) continue
            val id = requireNotNull(event.string("id")?.toIntOrNull())
            val maximum = damaged[frames["#$id"] ?: frames[event.string("troop")]] ?: continue
            // Summoned troop stats do not inherit the attacking army's equipment bonus.
            val modifier = if(event.string("e") == "deploy" && event.string("hero") == null && event.string("side") != "defender") bps else 0L
            put(id,Math.floorDiv(Math.multiplyExact(maximum,10_000L+modifier),10_000L))
        }
    }
}

/** Web fx/stats.ts battleArmyHpBps: the frozen `allied_troop_hp_bps` of every deployed hero's loadout,
 * each clamped to the catalogue cap and then the total. Accepted hero orders count before the hero spawns. */
internal fun alliedTroopHpBps(source: JsonObject, catalogue: JsonObject): Long {
    val cap = requireNotNull(catalogue["constants"]?.jsonObject?.get("INVENTORY")?.jsonObject
        ?.get("modifierCapsBps")?.jsonObject?.get("allied_troop_hp_bps")?.jsonPrimitive?.longOrNull)
    require(cap in 0 until 10_000)
    val knownHeroes=requireNotNull(catalogue["constants"]?.jsonObject?.get("HERO_KEYS") as? JsonArray).map { it.jsonPrimitive.content }.toSet()
    fun optionalObject(value:JsonElement?):JsonObject?=if(value==null || value==JsonNull)null else requireNotNull(value as? JsonObject)
    fun optionalRows(value:JsonElement?):List<JsonObject> = if(value==null)emptyList() else requireNotNull(value as? JsonArray).map { requireNotNull(it as? JsonObject) }
    val orders = optionalObject(source["orders"])
    val heroes = if (orders != null) optionalRows(orders["heroDeploys"]).map { order -> requireNotNull(order.string("hero")) to optionalObject(order["loadout"]) }
        else optionalRows(source["commands"]).filter { it.string("kind") == "hero" }
            .map { requireNotNull((it["payload"] as? JsonObject)?.string("hero")) to null }
    require(heroes.all { it.first in knownHeroes })
    if(orders!=null)require(heroes.size<=knownHeroes.size && heroes.distinctBy { it.first }.size==heroes.size)
    val loadouts = optionalObject((source["armySnapshot"] as? JsonObject)?.get("heroLoadouts"))
    return heroes.distinctBy { it.first }.sumOf { (hero,orderLoadout) ->
        val value = (orderLoadout ?: optionalObject(loadouts?.get(hero)))?.get("modifiers")?.jsonObject?.get("allied_troop_hp_bps")
        if (value == null) 0L else requireNotNull((value as? JsonPrimitive)?.longOrNull).coerceIn(-cap,cap)
    }.coerceIn(-cap,cap)
}

/** Display maxima for the floating HP bars (web fx/hpbars.ts) of every deploy/spawn/troopSpawn actor.
 * A pack's `damagedBodyMaxHp` wins; every other actor mirrors web fx/stats.ts battleUnitMaxHp from the
 * catalogue: TROOPS.hp tapered by LEVEL_STEP_TROOP at the frozen army level, HERO_LEVELING.hp at the frozen
 * hero level (HERO_DEFENCE.statPct for a defender hero), then the frozen loadout modifier. Nest spawns
 * use level 1 like the web. A catalogue without those tables yields only the pack maxima: no bar is
 * better than a guessed one. Display only; never a simulation, targeting or reward input. */
fun actorDisplayMaxHp(source: JsonObject, render: JsonObject, catalogue: JsonObject, frames: Map<String,String>): Map<Int,Long> {
    val damaged = actorDamageMaxHp(source, render, catalogue, frames)
    val constants = catalogue["constants"] as? JsonObject ?: return damaged
    val troops = constants["TROOPS"] as? JsonObject ?: return damaged
    val steps = (constants["LEVEL_STEP_TROOP"] as? JsonArray)?.map { requireNotNull(it.jsonPrimitive.doubleOrNull) } ?: return damaged
    val heroHp = (constants["HERO_LEVELING"] as? JsonObject)?.get("hp") as? JsonObject
    val defenceStatPct = (constants["HERO_DEFENCE"] as? JsonObject)?.string("statPct")?.toLongOrNull()
    val caps = (constants["INVENTORY"] as? JsonObject)?.get("modifierCapsBps") as? JsonObject
    val heroCap = caps?.string("hero_hp_bps")?.toLongOrNull()
    val armyBps = if (caps?.string("allied_troop_hp_bps") != null && constants["HERO_KEYS"] is JsonArray) alliedTroopHpBps(source, catalogue) else 0L
    val army = source["armySnapshot"] as? JsonObject
    val levels = army?.get("levels") as? JsonObject
    val heroLevels = army?.get("heroLevels") as? JsonObject
    val loadouts = army?.get("heroLoadouts") as? JsonObject
    val defenders = (source["snapshot"] as? JsonObject)?.objects("defenderHeroes").orEmpty().associateBy { it.string("hero") }
    fun levelScale(base: Double, level: Int): Long { var v = base; for (i in 1 until level) v *= steps.getOrNull(i) ?: 1.0; return Math.round(v) }
    fun heroBps(loadout: JsonObject?): Long {
        val raw = (loadout?.get("modifiers") as? JsonObject)?.get("hero_hp_bps") ?: return 0L
        if (heroCap == null) return 0L
        return requireNotNull((raw as? JsonPrimitive)?.longOrNull).coerceIn(-heroCap, heroCap)
    }
    return buildMap {
        putAll(damaged)
        for (event in source.objects("events")) {
            if (event.string("e") !in setOf("deploy","spawn","troopSpawn")) continue
            val id = requireNotNull(event.string("id")?.toIntOrNull())
            if (id in damaged) continue
            val troop = event.string("troop") ?: continue
            val hero = event.string("hero"); val defender = event.string("side") == "defender"
            val base: Long; val bps: Long
            if (hero != null) {
                val table = (heroHp?.get(hero) as? JsonArray)?.takeIf { it.isNotEmpty() } ?: continue
                val level = (if (defender) defenders[hero]?.string("level") else heroLevels?.string(hero))?.toIntOrNull() ?: 1
                var value = table.getOrNull(level.coerceIn(1, table.size) - 1)?.jsonPrimitive?.longOrNull ?: continue
                if (defender) value = Math.floorDiv(value * (defenceStatPct ?: continue), 100L)
                base = value; bps = heroBps(if (defender) defenders[hero]?.get("loadout") as? JsonObject else loadouts?.get(hero) as? JsonObject)
            } else {
                val hp = (troops[troop] as? JsonObject)?.string("hp")?.toDoubleOrNull() ?: continue
                val level = when (event.string("e")) {
                    "troopSpawn" -> event.string("level")?.toIntOrNull() ?: 1
                    "spawn" -> 1
                    else -> levels?.string(troop)?.toIntOrNull() ?: 1
                }
                base = levelScale(hp, maxOf(1, level)); bps = if (event.string("e") == "deploy" && !defender) armyBps else 0L
            }
            if (base <= 0) continue
            put(id, Math.floorDiv(Math.multiplyExact(base, 10_000L + bps), 10_000L))
        }
    }
}
