package gg.pixelkingdomwars.nativeclient.network

import java.math.BigDecimal
import java.time.Instant
import kotlinx.serialization.json.*

enum class TrainingScheduling { LEGACY, SEQUENTIAL, UNSUPPORTED }

fun trainingScheduling(army: JsonObject): TrainingScheduling {
    val features=army["features"] as? JsonObject
    if(army.containsKey("features") && features==null) return TrainingScheduling.UNSUPPORTED
    if(features?.containsKey("trainingScheduling")!=true) return TrainingScheduling.LEGACY
    val feature=features["trainingScheduling"] as? JsonObject ?: return TrainingScheduling.UNSUPPORTED
    val required=feature["consentRequired"] as? JsonPrimitive
    // The current confirmation and queue UI supports one sequential lane only.
    return if(feature["version"]==JsonPrimitive(2) && feature.string("mode")=="sequential" && feature["lanes"]==JsonPrimitive(1) &&
        required!=null && !required.isString && required.booleanOrNull!=null)
        TrainingScheduling.SEQUENTIAL else TrainingScheduling.UNSUPPORTED
}

data class TrainingSchedule(val consent: JsonObject,val serverNow: String,val startsAt: String,val finishesAt: String,
                            val waitMs: Long,val durationMs: Long)

/** Validate server-authored timing without deriving costs, speeds or game rules. */
fun trainingQuoteSchedule(quote: JsonObject): TrainingSchedule? {
    if(!quote.containsKey("consent") && !quote.containsKey("schedule")) return null
    try {
        val consent=requireNotNull(quote["consent"] as? JsonObject)
        val schedule=requireNotNull(quote["schedule"] as? JsonObject)
        require(consent["version"]==JsonPrimitive(2) && schedule["version"]==JsonPrimitive(2) && schedule.string("mode")=="sequential")
        val queue=requireNotNull(consent["queue"] as? JsonArray)
        val ids=mutableSetOf<String>()
        var queuedFinish: Long?=null
        for(item in queue) {
            val row=item.jsonObject
            val id=row.text("id")
            require(id.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")) && ids.add(id.lowercase()))
            val finish=timestamp(row.text("finishesAt"))
            require(finish>timestamp(row.text("startedAt")))
            queuedFinish=queuedFinish?.let { maxOf(it,finish) } ?: finish
        }
        val composition=requireNotNull(quote["queueable"] as? JsonArray)
        val durations=requireNotNull(consent["unitDurations"] as? JsonArray)
        require(durations.size==composition.size)
        var total=0L
        for(i in composition.indices) {
            val selected=composition[i].jsonObject;val unit=durations[i].jsonObject
            require(selected.text("troop").isNotBlank() && unit.text("troop")==selected.text("troop"))
            val count=selected.whole("count");val duration=unit.whole("durationMs")
            require(count>0 && duration>0)
            total=Math.addExact(total,Math.multiplyExact(count,duration))
        }
        val now=schedule.text("serverNow");val start=schedule.text("startsAt");val finish=schedule.text("finishesAt")
        val wait=schedule.whole("waitMs");val duration=schedule.whole("durationMs")
        require(wait>=0 && duration==total)
        require(queuedFinish?.let { timestamp(start)>=it } != false)
        require(Math.addExact(timestamp(now),wait)==timestamp(start) && Math.addExact(timestamp(start),duration)==timestamp(finish))
        return TrainingSchedule(consent,now,start,finish,wait,duration)
    } catch(_: Exception) { throw ApiCompatibilityException("/army/training/quote") }
}

fun trainingDurationLabel(milliseconds: Long): String = BigDecimal.valueOf(milliseconds,3).stripTrailingZeros().toPlainString()+" s"
private fun JsonObject.text(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun JsonObject.whole(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.longOrNull)
private fun timestamp(value: String): Long = Instant.parse(value).also { require(it.nano%1_000_000==0) }.toEpochMilli()
