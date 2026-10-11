package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.network.string
import kotlinx.serialization.json.*

/** Server remaining time plus monotonic elapsed time. The device calendar never decides a rule. */
data class WorldDeadline(val key:String,val remainingMs:Long,val receivedAtNanos:Long) {
    fun remaining(nowNanos:Long)=(remainingMs-(nowNanos-receivedAtNanos).coerceAtLeast(0)/1_000_000).coerceAtLeast(0)
}
class WorldBoundaryRefresh {
    private val fired=mutableSetOf<String>()
    fun nextDelay(pollMs:Long,boundaries:List<WorldDeadline>,nowNanos:Long):Long {
        require(pollMs>0)
        val first=boundaries.filter {it.key !in fired}.minByOrNull {it.remaining(nowNanos)} ?: return pollMs
        val boundaryMs=first.remaining(nowNanos)+250 // Production admits the server's boundary before refreshing.
        if(boundaryMs>pollMs)return pollMs
        fired+=first.key
        return boundaryMs
    }
}
fun parcelDeadlines(detail:JsonObject?,at:Long):List<WorldDeadline> = buildList {
    fun addClock(kind:String,data:JsonObject?,deadline:String,enabled:Boolean) {
        val key=data?.string(deadline) ?: return
        val left=data["remainingMs"]?.jsonPrimitive?.longOrNull ?: return
        if(enabled)add(WorldDeadline("$kind:$key",left.coerceAtLeast(0),at))
    }
    val shield=detail?.get("shield") as? JsonObject
    val protected=shield?.get("active")?.jsonPrimitive?.booleanOrNull==true || shield?.get("suppressedByWarzone")?.jsonPrimitive?.booleanOrNull==true
    addClock("shield",shield,"expiresAt",protected)
    addClock("warzone",detail?.get("warzone") as? JsonObject,"boundaryAt",true)
}
data class WorldWarzone(val mode:String,val active:Boolean,val boundary:String?,val deadline:WorldDeadline?) {
    companion object {
        fun parse(value:JsonObject?,at:Long):WorldWarzone {
            val active=value?.get("active")?.jsonPrimitive?.booleanOrNull==true
            val complete=value!=null && value.string("mode") in setOf("off","scheduled","purge") && listOf("startsAt","endsAt","nextStartsAt","remainingMs").all {it in value}
            val mode=if(complete)requireNotNull(value?.string("mode")) else if(active)"unknown" else "off"
            val boundary=if(active)value?.string("endsAt") else if(mode=="scheduled")value?.string("startsAt") ?: value?.string("nextStartsAt") else null
            val remaining=value?.get("remainingMs")?.jsonPrimitive?.longOrNull
            return WorldWarzone(mode,active,boundary,if(boundary!=null && remaining!=null)WorldDeadline("$mode:$active:$boundary",remaining.coerceAtLeast(0),at) else null)
        }
    }
}
internal fun worldDuration(ms:Long):String {
    val seconds=(ms.coerceAtLeast(0)+999)/1000
    return when { seconds>=86400->"${seconds/86400}D ${seconds%86400/3600}H";seconds>=3600->"${seconds/3600}H ${seconds%3600/60}M";seconds>=60->"${seconds/60}M ${seconds%60}S";else->"${seconds}S" }
}
