package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader

/** A canonical position endpoint's delivery time, independent of its endpoint tick.
 * Ordinals refer to the original event list, including events omitted from this map. */
data class PositionDelivery(
    val eventOrdinal: Int,
    val startTick: Float,
    val durationMs: Float,
    val skip: Boolean = false,
) {
    companion object {
        /** Mirrors BattleScene.positionPlayback. Only births and pos records advance
         * the preceding endpoint; ability origins and emerge snaps do not. The map
         * retains source order and skipped records. Merge with ordinary events by
         * (startTick, eventOrdinal), excluding skipped records and events before fromTick. */
        fun compile(
            events: List<PresentationEvent>,
            positionCadenceTicks: Int,
            summonedPositionCadenceTicks: Int,
            tickDurationMs: Float,
            fromTick: Float = 0f,
        ): Map<Int, PositionDelivery> {
            require(positionCadenceTicks > 0 && summonedPositionCadenceTicks > 0)
            require(tickDurationMs.isFinite() && tickDurationMs > 0 && fromTick.isFinite() && fromTick >= 0)
            require(events.zipWithNext().all { (a, b) -> a.t <= b.t })
            val previous = mutableMapOf<Int, Int>()
            val cadence = mutableMapOf<Int, Int>()
            val previousPosition = mutableMapOf<Int, Int>()
            val result = linkedMapOf<Int, PositionDelivery>()
            val reader = JsonReader()
            for ((ordinal, event) in events.withIndex()) {
                val data = reader.parse(event.json)
                require(data.getInt("t") == event.t && data.getString("e") == event.e)
                if (event.e in setOf("deploy", "spawn", "troopSpawn")) {
                    val id = data.getInt("id")
                    previous[id] = event.t
                    cadence[id] = if (event.e == "troopSpawn") summonedPositionCadenceTicks else positionCadenceTicks
                    continue
                }
                if (event.e != "pos") continue
                val id = data.getInt("id")
                val prior = previous[id] ?: event.t
                previous[id] = event.t
                if (event.t < fromTick) continue
                previousPosition[id]?.let { priorOrdinal ->
                    val priorDelivery = result.getValue(priorOrdinal)
                    if (prior == events[priorOrdinal].t && priorDelivery.durationMs == 0f)
                        result[priorOrdinal] = priorDelivery.copy(skip = true)
                }
                previousPosition[id] = ordinal
                val maxSegment = cadence[id] ?: positionCadenceTicks
                val segmentStart = if (event.t - prior > maxSegment) event.t - maxSegment else prior
                val start = maxOf(segmentStart.toFloat(), fromTick)
                val duration = maxOf(0.0, event.t.toDouble() - start) * tickDurationMs
                require(duration.isFinite() && duration <= Float.MAX_VALUE) { "Unbounded position delivery" }
                result[ordinal] = PositionDelivery(ordinal, start, duration.toFloat())
            }
            return result
        }
    }
}
