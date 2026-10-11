package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.generated.NativeClockDto
import kotlinx.serialization.json.*
import java.time.Instant

/** Presentation only. Receipt time is process-monotonic and is never persisted
 * or sent as an order timestamp. The server owns every simulation anchor. */
data class BattleClock(val value: NativeClockDto, val receivedAtNanos: Long) {
    fun playheadMs(nowNanos: Long): Double = if (value.anchorWallAt == null) 0.0 else
        (value.simNowMs.toDouble() + ((nowNanos - receivedAtNanos).coerceAtLeast(0) / 1_000_000.0) * value.rate)
            .coerceAtMost(value.durationMs.toDouble())
    fun newerThan(other: BattleClock?) = other == null || value.revision > other.value.revision ||
        (value.revision == other.value.revision && Instant.parse(value.serverNow).isAfter(Instant.parse(other.value.serverNow)))

    companion object {
        private val json = Json { ignoreUnknownKeys = true }
        fun read(raw: JsonObject, receivedAtNanos: Long): BattleClock {
            val value = json.decodeFromJsonElement<NativeClockDto>(raw)
            require(value.protocolVersion in 1..2 && value.revision >= 0 && value.rate in 1..2)
            require(value.durationMs > 0 && value.simNowMs in 0..value.durationMs && value.anchorSimMs in 0..value.durationMs)
            Instant.parse(value.serverNow)
            value.anchorWallAt?.let(Instant::parse); value.battleEndsAt?.let(Instant::parse)
            return BattleClock(value, receivedAtNanos)
        }
    }
}
