package gg.pixelkingdomwars.nativeclient

import kotlinx.serialization.json.*

/** Membership comes from the frozen reservation, never remaining counts or hero levels. */
internal data class BattleRoster(val troops: List<String>, val heroes: List<String>) {
    fun contains(selection: Pair<String,String>): Boolean = when(selection.first) {
        "deploy" -> selection.second in troops
        "hero" -> selection.second in heroes
        else -> false
    }

    companion object {
        fun read(snapshot: JsonElement?): BattleRoster {
            val army=snapshot as? JsonObject
            val troops=(army?.get("counts") as? JsonObject).orEmpty().mapNotNull { (id,value) ->
                val count=value as? JsonPrimitive
                id.takeIf { it.isNotBlank() && count != null && !count.isString && (count.intOrNull ?: 0)>0 }
            }
            val heroes=(army?.get("heroes") as? JsonArray).orEmpty().mapNotNull { value ->
                (value as? JsonPrimitive)?.takeIf { it.isString }?.content?.takeIf { it.isNotBlank() }
            }.distinct()
            return BattleRoster(troops,heroes)
        }
    }
}
