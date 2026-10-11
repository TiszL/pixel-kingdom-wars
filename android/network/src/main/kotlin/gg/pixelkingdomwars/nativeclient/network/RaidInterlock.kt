package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.ActiveBaseRaid
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.selects.select
import kotlinx.serialization.json.JsonObject
import kotlin.math.min

/** What the selected deed's raid lock is known to be. */
data class RaidInterlockState(val activeRaid: ActiveBaseRaid? = null, val known: Boolean = false) {
    /** Web `deedActionsAllowed`: only a canonical "no raid" snapshot unlocks the deed's mutation affordances;
     * a lost transport leaves them locked until a fresh snapshot or poll answers. */
    val actionsAllowed: Boolean get() = known && activeRaid == null
}

// UI freshness cadences (web BaseRaidInterlock.tsx), not game rules.
internal const val ACTIVE_RAID_POLL_MS = 2_000L
internal const val STREAM_WATCHDOG_MS = 30_000L
internal const val STREAM_DISABLED_RETRY_MS = 60_000L
internal const val STREAM_MAX_BACKOFF_MS = 30_000L

/** Selected-deed defender interlock (D-036, web `useActiveBaseRaid`). The server owns the lock; this mirrors it:
 * an SSE stream of snapshots while healthy, a 2 s `GET /bases/:id/active-raid` poll while it is not, exponential
 * reconnects (a minute when the server disables streaming), a 30 s watchdog that heartbeats may only re-arm after
 * the first snapshot. Losing transport never unlocks a deed: a known lock survives, an unlocked deed becomes unknown. */
class RaidInterlock internal constructor(
    val baseId: String,
    private val stream: suspend (String) -> Flow<RaidEventFrame>,
    private val poll: suspend (String) -> ActiveBaseRaid?,
    private val pause: suspend (Long) -> Unit = { delay(it) },
    /** Where frame reads block (the socket); tests run the producer inline. */
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    constructor(baseId: String, api: GameApi, session: SessionToken, poll: suspend (String) -> ActiveBaseRaid?) :
        this(baseId, { id -> api.raidEvents("/bases/$id/raid-events", id, session) }, poll)

    private val _state = MutableStateFlow(RaidInterlockState())
    val state: StateFlow<RaidInterlockState> = _state.asStateFlow()
    private var snapshotRevision = 0
    @Volatile private var healthy = false

    /** Runs until cancelled (the Home screen's STARTED lifecycle). Reads only; never a mutation. */
    suspend fun run(): Unit = coroutineScope {
        var reconnects = 0
        // Web `schedulePoll`: the first fallback read waits one cadence; a stream that connects first cancels it.
        val poller = launch {
            while (isActive) {
                pause(ACTIVE_RAID_POLL_MS)
                if (!healthy) runCatching { pollOnce() }.onFailure { if (it is CancellationException) throw it }
            }
        }
        try {
            while (isActive) {
                var disabled = false
                try { observe { reconnects = 0 } }
                catch (error: CancellationException) { throw error }
                catch (error: Exception) { disabled = error is ApiException && (error.code == RAID_EVENTS_DISABLED || error.status == 404) }
                healthy = false
                uncertain()
                // The canonical GET also applies the session/ownership routing an error event may carry; like the
                // web's `void poll()` it never delays the reconnect timer.
                launch { runCatching { pollOnce() } }
                pause(if (disabled) STREAM_DISABLED_RETRY_MS else min(STREAM_MAX_BACKOFF_MS, 1_000L shl min(reconnects++, 5)))
            }
        } finally { poller.cancel() }
    }

    private suspend fun observe(onSnapshot: () -> Unit): Unit = coroutineScope {
        val frames = Channel<RaidEventFrame>(Channel.UNLIMITED)
        // Frame reads block on the socket: the producer lives on IO, the state machine stays where it was called.
        val producer = launch(io) {
            try { stream(baseId).collect { frames.send(it) }; frames.close() }
            catch (error: CancellationException) { throw error }
            catch (error: Throwable) { frames.close(error) }
        }
        var receivedSnapshot = false
        var watchdog = launch { pause(STREAM_WATCHDOG_MS) }
        try {
            while (true) {
                val next = select<RaidEventFrame?> {
                    frames.onReceiveCatching { result -> result.getOrNull() ?: throw (result.exceptionOrNull() ?: ApiException(0, RAID_EVENTS_CLOSED, "Live raid connection closed.")) }
                    watchdog.onJoin { null }
                } ?: throw ApiException(0, RAID_EVENTS_CLOSED, "Live raid updates stalled.")
                when (next) {
                    is RaidEventFrame.Snapshot -> {
                        receivedSnapshot = true; healthy = true; snapshotRevision++
                        _state.value = RaidInterlockState(next.activeRaid, known = true)
                        onSnapshot()
                        watchdog.cancel(); watchdog = launch { pause(STREAM_WATCHDOG_MS) }
                    }
                    // Heartbeats cannot indefinitely hide a missing initial snapshot.
                    RaidEventFrame.Heartbeat -> if (receivedSnapshot) { watchdog.cancel(); watchdog = launch { pause(STREAM_WATCHDOG_MS) } }
                }
            }
        } finally { watchdog.cancel(); producer.cancel() }
    }

    private val polling = kotlinx.coroutines.sync.Mutex()
    /** One canonical read in flight (web: an overlapping poll is rescheduled, never doubled). */
    private suspend fun pollOnce() {
        if (healthy || !polling.tryLock()) return
        try {
            val revision = snapshotRevision
            val raid = poll(baseId)
            // A slow poll answered after a newer stream snapshot must not overwrite it.
            if (!healthy && revision == snapshotRevision) _state.value = RaidInterlockState(raid, known = true)
        } finally { polling.unlock() }
    }

    /** A known lock survives lost transport; a previously unlocked deed needs a fresh canonical snapshot. */
    private fun uncertain() { _state.update { RaidInterlockState(it.activeRaid, known = it.activeRaid != null) } }

    companion object {
        /** `GET /bases/:id/active-raid` → the lock or null; a malformed answer is an interrupted read, never an unlock. */
        fun activeRaidOf(response: JsonObject, baseId: String): ActiveBaseRaid? =
            parseRaidSnapshot(JsonObject(response + ("baseId" to kotlinx.serialization.json.JsonPrimitive(baseId))), baseId)
    }
}
