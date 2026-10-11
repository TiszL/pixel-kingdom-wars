package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update

/** A command acknowledgement proves the server revision advanced, so the observer's in-flight long-poll
 * (which the server only re-checks on its own cadence) is abandoned and a fresh read issued at once with
 * the same applied cursor. Advisory only: it never changes the applied state, page continuation, restart
 * accounting or any receipt; a spurious wake costs one extra read and a missed wake costs at most the
 * server's poll cadence.
 *
 * Every wake-driven read is one more GET against the presentation route's per-minute limit, and a second
 * stream per wallet while the abandoned one closes. Wakes are therefore coalesced where they are consumed:
 * abandoning a read needs a permit, at most one per [WAKE_SPACING_MS] and, beyond a small burst, one per
 * [WAKE_REFILL_MS]. A wake that finds no permit waits for one while the long-poll keeps running, and is
 * simply dropped when that poll answers first — which, with orders arriving that fast, it does within the
 * server's cadence. These are client transport pacing values like the read backoff below them, not game
 * numbers: a sustained tapping run adds at most about 27 reads a minute to the observer's own. */
class BattlePresentationWake internal constructor(private val nanos: () -> Long, private val pause: suspend (Long) -> Unit) {
    constructor() : this(System::nanoTime, { delay(it) })
    private val epoch = MutableStateFlow(0L)
    private val pacing = Any()
    private var permits = WAKE_BURST
    private var refilledAtNanos = nanos()
    private var lastPermitAtNanos: Long? = null

    fun wake() { epoch.update { it + 1 } }
    internal fun current(): Long = epoch.value
    /** Suspends until a wake later than [seen] arrives and the pacing admits one more abandoned read. */
    internal suspend fun awaitAfter(seen: Long) {
        epoch.first { it != seen }
        while (true) pause(permitOrWaitMs() ?: return)
    }
    /** Takes a permit (null) or returns how long until one can be taken. Cancelling the wait takes nothing. */
    private fun permitOrWaitMs(): Long? = synchronized(pacing) {
        val now = nanos()
        val refills = (now - refilledAtNanos) / WAKE_REFILL_NANOS
        if (refills > 0) { permits = minOf(WAKE_BURST.toLong(), permits + refills).toInt(); refilledAtNanos += refills * WAKE_REFILL_NANOS }
        if (permits >= WAKE_BURST) refilledAtNanos = now // A full bucket accrues nothing.
        val spacing = lastPermitAtNanos?.let { WAKE_SPACING_NANOS - (now - it) } ?: 0L
        val refill = if (permits > 0) 0L else WAKE_REFILL_NANOS - (now - refilledAtNanos)
        val waitNanos = maxOf(spacing, refill)
        if (waitNanos <= 0L) { permits--; lastPermitAtNanos = now; null } else (waitNanos + 999_999L) / 1_000_000L
    }

    internal companion object {
        const val WAKE_SPACING_MS = 200L
        const val WAKE_REFILL_MS = 2_500L
        const val WAKE_BURST = 3
        private const val WAKE_SPACING_NANOS = WAKE_SPACING_MS * 1_000_000L
        private const val WAKE_REFILL_NANOS = WAKE_REFILL_MS * 1_000_000L
    }
}
