package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.FantasyParcel
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

/** What the base card says when its metered read fails (the web's `landGate` rule and GLOBE-PRODUCTION-PLAN §2.6.4). */
enum class WorldParcelFailureKind {
    /** 402/403: a deedless player may not inspect occupied bases (F12); the card offers "Choose land". */
    LAND_GATE,
    /** 429: the 24/min parcel budget is spent; the map stays usable and the card offers RETRY. */
    BUSY,
    /** Anything else: the server's words and RETRY. */
    OTHER,
}

/** A refused or failed parcel read for [tileId]: [message] is the card's copy, [raw] the error's own text. */
data class WorldParcelFailure(val tileId: Int, val kind: WorldParcelFailureKind, val message: String, val raw: String) {
    companion object {
        const val LAND_GATE_TEXT = "Acquire a Land Deed to inspect occupied bases."
        const val BUSY_TEXT = "Details are busy, try again in a moment"
        const val OTHER_TEXT = "This parcel could not be read. Please retry."
        fun of(tileId: Int, error: Throwable): WorldParcelFailure {
            val raw = error.message ?: OTHER_TEXT
            val status = (error as? ApiException)?.status
            return when (status) {
                402, 403 -> WorldParcelFailure(tileId, WorldParcelFailureKind.LAND_GATE, LAND_GATE_TEXT, raw)
                429 -> WorldParcelFailure(tileId, WorldParcelFailureKind.BUSY, BUSY_TEXT, raw)
                else -> WorldParcelFailure(tileId, WorldParcelFailureKind.OTHER, raw, raw)
            }
        }
    }
}

/**
 * The card dwell rule (GLOBE-PRODUCTION-PLAN §2.6.4) for `GET /globe/fantasy/parcels/:tileId`, which the server meters at
 * 24/min per wallet and per IP and fails closed. The realm map invites base-by-base browsing (next/previous, swipes), so:
 *  - the card first shows its silhouette from the viewport markers; the metered read starts only once the card has
 *    rested on one tile for the dwell (a new selection cancels the wait, so a fast browse spends nothing);
 *  - a read is cached per tile for the catalogue's `WORLD.mapPollSec`: coming back inside that window shows it at once
 *    and spends nothing;
 *  - a refused read (land gate, 429) is never retried on its own; the card's RETRY starts a fresh follow.
 * The loop runs on an injected clock so the rule is JVM-tested with virtual time.
 */
class WorldParcelReads(private val capacity: Int = 32) {
    companion object {
        /** The card's rest before the metered read (GLOBE-PRODUCTION-PLAN §2.6.4: "after the card rests ≥ 600 ms"). A HUD
         *  timing that keeps browsing inside the server's budget, not a game number. */
        const val CARD_DWELL_MS = 600L
    }
    private class Entry(val parcel: FantasyParcel, val atMs: Long, val atNanos: Long)
    private val cache = object : LinkedHashMap<Int, Entry>(16, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, Entry>?): Boolean = size > capacity
    }

    /** [tileId]'s read if it is younger than [cacheMs]: the parcel and its monotonic receive time. */
    @Synchronized fun cached(tileId: Int, nowMs: Long, cacheMs: Long): Pair<FantasyParcel, Long>? {
        val e = cache[tileId] ?: return null
        return if (nowMs - e.atMs < cacheMs) e.parcel to e.atNanos else null
    }
    @Synchronized private fun age(tileId: Int, nowMs: Long): Long? = cache[tileId]?.let { nowMs - it.atMs }
    @Synchronized private fun store(tileId: Int, parcel: FantasyParcel, atMs: Long, atNanos: Long) { cache[tileId] = Entry(parcel, atMs, atNanos) }
    @Synchronized fun clear() { cache.clear() }

    /**
     * Follows [tileId] until cancelled. A fresh cache entry is published at once and the next read waits for the rest of
     * the poll ([pollMs] less its age, or an earlier shield/warzone boundary from [nextDelayMs]); otherwise the first read
     * waits [dwellMs] ([fresh] skips the cache: RETRY). Each read is stored and published, then the next waits
     * [nextDelayMs] of the full poll. LAND_GATE and BUSY stop the loop; other failures retry at the poll, as before.
     */
    suspend fun follow(tileId: Int, dwellMs: Long, cacheMs: Long, pollMs: Long, fresh: Boolean, nowMs: () -> Long, nowNanos: () -> Long,
        read: suspend (Int) -> FantasyParcel, publish: (FantasyParcel, Long) -> Unit, fail: (WorldParcelFailure) -> Unit,
        nextDelayMs: (parcel: FantasyParcel, atNanos: Long, pollMs: Long) -> Long) {
        val hit = if (fresh) null else cached(tileId, nowMs(), cacheMs)
        var wait = if (hit != null) {
            publish(hit.first, hit.second)
            nextDelayMs(hit.first, hit.second, (pollMs - (age(tileId, nowMs()) ?: 0L)).coerceAtLeast(1L))
        } else dwellMs
        while (true) {
            if (wait > 0) delay(wait)
            val parcel = try { read(tileId) } catch (error: CancellationException) { throw error } catch (error: Exception) {
                val failure = WorldParcelFailure.of(tileId, error)
                fail(failure)
                if (failure.kind != WorldParcelFailureKind.OTHER) return
                wait = pollMs
                continue
            }
            val at = nowNanos()
            store(tileId, parcel, nowMs(), at)
            publish(parcel, at)
            wait = nextDelayMs(parcel, at, pollMs)
        }
    }
}
