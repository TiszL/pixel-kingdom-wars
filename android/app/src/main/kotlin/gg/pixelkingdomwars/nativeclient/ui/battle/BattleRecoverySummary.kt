package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import gg.pixelkingdomwars.nativeclient.network.PendingBattleWrite

/** How long a saved battle order may sit neither acknowledged nor being sent before its recovery is offered.
 * Presentation pacing, not a game number. An ordinary deploy is first queued behind the durable journal (saved,
 * not yet in flight) and then in flight; neither is a fault, and both last a fraction of this. */
internal const val STUCK_BATTLE_REQUEST_MS = 4_000L

internal data class BattleRecoverySummary(val requests: List<PendingBattleWrite>, val inFlight: Set<String>, private val create: String?) {
    val sending: Int get() = requests.count { it.id in inFlight }
    /** Saved requests nobody is sending right now, oldest first. Fast deploys pass through here between the
     * journal write and the POST, so this alone never puts text on the battle screen. */
    val waiting: List<String> get() = requests.filterNot { it.id in inFlight }.map { it.id }
    /** The requests the player is offered to resend: an unknown march create at once (it is never a deploy and
     * nothing else can be done until it resolves), a battle order only after it has waited [STUCK_BATTLE_REQUEST_MS]
     * (see [BattleStuckRequests]). Owner 2026-09-17/18: "1 sending" and then "1 awaiting confirmation" flashed above
     * the troop cards on every deploy, reflowing the tray and moving the camera. */
    fun unresolved(stuck: Set<String>): List<PendingBattleWrite> = requests.filter { it.id !in inFlight && (it.id == create || it.id in stuck) }
}
internal fun battleRecoverySummary(live: LiveBattleState): BattleRecoverySummary {
    val requests = live.pending?.let { listOfNotNull(it.create) + it.writes }.orEmpty()
    // `creating` covers the create's own short journal-to-POST window the same way.
    return BattleRecoverySummary(requests, live.inFlight, live.pending?.create?.id?.takeIf { !live.creating })
}

/** How long each waiting request has been waiting, on a caller-supplied monotonic clock. A request that is sent
 * again (explicit Retry) or acknowledged leaves; one that fails later starts a new wait. */
internal class BattleStuckRequests(private val afterMs: Long = STUCK_BATTLE_REQUEST_MS) {
    private val since = HashMap<String, Long>()
    /** Records the current waiting set; returns the delay until the next request becomes stuck, or null. */
    fun observe(waiting: Collection<String>, nowMs: Long): Long? {
        since.keys.retainAll(waiting.toSet())
        waiting.forEach { since.putIfAbsent(it, nowMs) }
        return since.values.map { afterMs - (nowMs - it) }.filter { it > 0 }.minOrNull()
    }
    fun stuck(nowMs: Long): Set<String> = since.filterValues { nowMs - it >= afterMs }.keys.toSet()
}
