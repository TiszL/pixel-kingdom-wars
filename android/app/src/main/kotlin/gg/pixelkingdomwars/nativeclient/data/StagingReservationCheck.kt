package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.JsonObject
import java.time.Instant

enum class StagingReservationStatus { OPEN, CHECKING, WAITING, WINDOW_CLOSED, FAILED;
    val canRetry: Boolean get() = this == WAITING || this == WINDOW_CLOSED || this == FAILED
}

/** Input admission only. Neither a timer nor an absent pending row is a terminal receipt. */
internal class StagingReservationCheck(
    private val raidId: String,
    private val baseId: String,
    private val live: () -> LiveBattleState,
    private val current: () -> Boolean,
    private val read: suspend (String) -> JsonObject,
    private val changed: (StagingReservationStatus) -> Unit,
    private val nanos: () -> Long = System::nanoTime,
) {
    private val gate = Mutex()
    private var checkedClock: BattleClock? = null
    var status = StagingReservationStatus.OPEN; private set
    private fun publish(value: StagingReservationStatus) { status = value; if (current()) changed(value) }
    private fun clock(state: LiveBattleState): BattleClock? = checkedClock?.takeIf { it.newerThan(state.clock) } ?: state.clock
    private fun timeRemains(state: LiveBattleState): Boolean {
        // Older durable records may omit this display metadata. Absence is not evidence
        // that an order is late; retain their existing server-authoritative admission.
        val deadline = state.deployEndsAtMs() ?: return true
        val clock = clock(state) ?: return false
        // Server wall time plus process-monotonic elapsed avoids changes/skew in the phone clock.
        if (clock.value.anchorWallAt != null) return false // Wait for the complete running presentation.
        val elapsed = ((nanos() - clock.receivedAtNanos).coerceAtLeast(0) / 1_000_000)
        val serverNow = Instant.parse(clock.value.serverNow).toEpochMilli()
        return serverNow <= deadline && elapsed <= deadline - serverNow
    }
    fun allowsInput(): Boolean {
        if (!current()) return false
        val state = live()
        if (state.terminal || state.blocked || !state.connected) return false
        if (state.phase == BattlePhase.RUNNING) return true
        return state.phase == BattlePhase.STAGING && status == StagingReservationStatus.OPEN && timeRemains(state)
    }
    suspend fun refreshIfDue(retry: Boolean = false) {
        val state = live()
        if (!current() || state.phase != BattlePhase.STAGING || state.terminal || state.blocked) return
        if (status == StagingReservationStatus.OPEN && timeRemains(state)) return
        if (status != StagingReservationStatus.OPEN && !(retry && status.canRetry)) return
        if (!gate.tryLock()) return
        try {
            if (!current()) return
            publish(StagingReservationStatus.CHECKING)
            val response = read("/raids/pending/$raidId")
            val received = nanos()
            currentCoroutineContext().ensureActive()
            if (!current()) return
            val state = live()
            if (state.terminal || state.phase != BattlePhase.STAGING) { publish(StagingReservationStatus.OPEN); return }
            val raid = response["raid"] as? JsonObject
            if (raid == null) { publish(StagingReservationStatus.WAITING); return }
            require(raid.string("id") == raidId && raid.string("attackerBaseId") == baseId &&
                raid.string("simVersion") == state.presentation?.string("simVersion") && raid.string("raidProtocolVersion") == "2") {
                "Reservation response does not match this battle"
            }
            require(raid.string("ordersDeadlineAt") == state.pending?.ordersDeadlineAt) { "Reservation deadline changed" }
            val raw = (raid["live"] as? JsonObject)?.get("clock") as? JsonObject
            val observed = BattleClock.read(requireNotNull(raw) { "Reservation clock is unavailable" }, received)
            val latest = clock(state)
            checkedClock = if (observed.newerThan(latest)) observed else latest
            val authoritative = checkedClock?.value
            val deadline = state.deployEndsAtMs()
            publish(when {
                // Observed server time, not elapsed phone time, confirms closure.
                // Neither that observation nor an older retry settles any command.
                authoritative != null && authoritative.anchorWallAt == null && deadline != null &&
                    Instant.parse(authoritative.serverNow).toEpochMilli() >= deadline -> StagingReservationStatus.WINDOW_CLOSED
                timeRemains(state) -> StagingReservationStatus.OPEN
                else -> StagingReservationStatus.WAITING
            })
        } catch (error: CancellationException) {
            if (current()) publish(StagingReservationStatus.OPEN)
            throw error
        } catch (_: Exception) {
            currentCoroutineContext().ensureActive()
            if (current()) publish(StagingReservationStatus.FAILED)
        } finally {
            if (!currentCoroutineContext().isActive && current()) publish(StagingReservationStatus.OPEN)
            gate.unlock()
        }
    }
}
