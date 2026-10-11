package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader

/** Display state only: initial maxima come from the server, hit.dmg is already
 * applied canonical damage. Never derive stats or rerun an attack on the client. */
class BuildingHealthVisualModel(buildings: List<RenderBuilding>, events: List<PresentationEvent>, threshold: Float?, checkpoint: () -> Unit = {}) {
    data class Health(val hp: Long, val maxHp: Long, val damagedSinceTick: Int?)
    private data class Change(val tick: Int, val ordinal: Int, val health: Health)
    private val history = mutableMapOf<String, MutableList<Change>>()
    init {
        require(threshold == null || threshold.isFinite() && threshold > 0f && threshold < 1f)
        fun health(hp: Long, max: Long, tick: Int, previous: Health? = null): Health {
            val damaged = threshold != null && max > 0 && hp.toDouble()/max < threshold.toDouble()
            return Health(hp,max,if(damaged) previous?.damagedSinceTick ?: tick else null)
        }
        buildings.forEach { building ->
            val initial = building.initialHp; val max = building.maxHp
            if(initial != null && max != null) {
                require(initial >= 0 && max >= initial) { "Invalid authoritative building health" }
                require(history.put(building.id,mutableListOf(Change(Int.MIN_VALUE,-1,health(initial,max,0)))) == null)
            }
        }
        val destroyed = mutableSetOf<String>()
        var previousTick = Int.MIN_VALUE
        var eventIndex = 0
        for(event in events) {
            if (eventIndex++ % 256 == 0) checkpoint()
            require(event.t >= previousTick) { "Unordered building health events" }; previousTick=event.t
            if(event.e !in setOf("hit","destroyed")) continue
            val data = JsonReader().parse(event.json)
            val target = data.get(if(event.e == "hit") "target" else "id") ?: continue
            // Troop IDs are numeric; a building named "1" is a different target.
            if(!target.isString) continue
            val id = target.asString(); val changes = history[id] ?: continue
            if(id in destroyed) continue
            val before=changes.last().health
            val hp = if(event.e == "destroyed") { destroyed += id; 0L } else {
                val damage=data.get("dmg") ?: error("Canonical hit has no damage")
                val number=damage.asDouble()
                require(damage.isNumber && number.isFinite() && number >= 0 && number % 1.0 == 0.0 && number <= 9_007_199_254_740_991.0) { "Invalid canonical hit damage" }
                before.hp-minOf(before.hp,number.toLong())
            }
            changes += Change(event.t,eventIndex-1,health(hp,before.maxHp,event.t,before))
        }
    }
    fun at(id: String, tick: Float): Health? {
        val changes=history[id] ?: return null
        var low=0; var high=changes.size
        while(low < high) { val middle=(low+high) ushr 1; if(changes[middle].tick <= tick) low=middle+1 else high=middle }
        return changes[(low-1).coerceAtLeast(0)].health
    }
    /** A hit's source-order state excludes later damage/destruction at the same tick. */
    fun afterEvent(id: String, ordinal: Int): Health? {
        val changes=history[id] ?: return null
        var low=0;var high=changes.size
        while(low<high) { val middle=(low+high) ushr 1;if(changes[middle].ordinal<=ordinal)low=middle+1 else high=middle }
        return changes[(low-1).coerceAtLeast(0)].health
    }
}
