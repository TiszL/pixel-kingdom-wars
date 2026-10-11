package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.*
import org.junit.Test

class BattleRecoverySummaryTest {
    @Test fun `compact summary retains every original request for explicit disclosure without four-row truncation`() {
        val writes = (0..7).map { index -> PendingBattleWrite("original-$index", "/raids/raid/commands",
            buildJsonObject { put("clientCommandId", "original-$index") }, attempted = true) }
        val live = LiveBattleState(pending = PendingBattle("wallet", "base", "raid", writes = writes), inFlight = setOf("original-0", "original-1"))
        val summary = battleRecoverySummary(live)
        assertEquals(8, summary.requests.size); assertEquals(2, summary.sending)
        summary.requests.zip(writes).forEach { (shown, saved) -> assertSame("Retry must use this exact durable request", saved, shown) }
        assertTrue(battleRecoverySummary(live.copy(pending = live.pending!!.copy(writes = emptyList()))).requests.isEmpty())
    }
    /** Owner 2026-09-17 (store build): "1 sending · Details" appeared above the troop cards for every deploy; after that
     * was silenced, owner 2026-09-18: "N awaiting confirmation · Details" still flashed, because a deploy is first saved
     * (not yet in flight) while it queues behind the durable journal, and only then sent. This test used to pin "every
     * saved write that is not in flight is unresolved at once"; the rule is now that neither ordinary state is text, and
     * a battle order surfaces only after it has stayed unsent and unacknowledged for [STUCK_BATTLE_REQUEST_MS]. */
    @Test fun `queued and in-flight orders are silent and only an order stuck for the delay surfaces for recovery`() {
        val writes = (0..2).map { index -> PendingBattleWrite("deploy-$index", "/raids/raid/commands",
            buildJsonObject { put("clientCommandId", "deploy-$index") }, attempted = index != 2) }
        val pending = PendingBattle("wallet", "base", "raid", writes = writes)
        val tracker = BattleStuckRequests()
        fun shown(live: LiveBattleState, nowMs: Long): List<String> {
            val summary = battleRecoverySummary(live)
            tracker.observe(summary.waiting, nowMs)
            return summary.unresolved(tracker.stuck(nowMs)).map { it.id }
        }
        val queued = LiveBattleState(pending = pending)
        assertEquals("Saved but not yet sent (queued behind the journal gate) is not a fault", emptyList<String>(), shown(queued, 0))
        assertEquals(emptyList<String>(), shown(queued.copy(inFlight = writes.map { it.id }.toSet()), 200))
        val oneLost = queued.copy(inFlight = setOf("deploy-0", "deploy-2"))
        assertEquals("A send that just failed is not text yet either", emptyList<String>(), shown(oneLost, 300))
        assertEquals("Still nothing just before the delay", emptyList<String>(), shown(oneLost, 300 + STUCK_BATTLE_REQUEST_MS - 1))
        assertEquals("deploy-1 left flight unacknowledged at 300 ms and has now waited the whole delay", listOf("deploy-1"),
            shown(oneLost, 300 + STUCK_BATTLE_REQUEST_MS))
        assertEquals("An explicit Retry puts it back in flight and the row leaves", emptyList<String>(),
            shown(queued.copy(inFlight = writes.map { it.id }.toSet()), 300 + STUCK_BATTLE_REQUEST_MS + 10))
        val restart = BattleStuckRequests()
        assertEquals(STUCK_BATTLE_REQUEST_MS, restart.observe(writes.map { it.id }, 1_000))
        assertTrue(restart.stuck(1_000).isEmpty())
        assertEquals("After a process restart every persisted order is offered once the delay has passed", writes.map { it.id }.toSet(), restart.stuck(1_000 + STUCK_BATTLE_REQUEST_MS))
        assertNull("Nothing left to wait for", restart.observe(writes.map { it.id }, 1_000 + STUCK_BATTLE_REQUEST_MS))
    }
    @Test fun `an unknown march create is offered at once but not during its own send window`() {
        val create = PendingBattleWrite("create-id", "/raids", buildJsonObject { put("idempotencyKey", "create-id") }, attempted = true)
        val live = LiveBattleState(pending = PendingBattle("wallet", "base", create = create))
        assertEquals(listOf(create), battleRecoverySummary(live).unresolved(emptySet()))
        assertTrue(battleRecoverySummary(live.copy(creating = true)).unresolved(emptySet()).isEmpty())
        assertTrue(battleRecoverySummary(live.copy(inFlight = setOf("create-id"))).unresolved(emptySet()).isEmpty())
    }
    /** D153.333 (a): once a terminal refusal retires the saved create, the "N awaiting confirmation · Details" pill has
     * nothing to count. The server's line belongs to the refusal panel, and a server-listed march is a resume, not a
     * request of ours to resend. */
    @Test fun `a retired create leaves nothing awaiting confirmation`() {
        val live = LiveBattleState(error = "No other target available", candidates = listOf(buildJsonObject { put("id", "raid") }))
        val summary = battleRecoverySummary(live)
        assertTrue(summary.requests.isEmpty())
        assertTrue("Neither the refusal nor a listed server march is a saved request to resend", summary.unresolved(setOf("raid")).isEmpty())
    }
    @Test fun `unknown create and unsent durable write stay available but in-memory admission is not retryable`() {
        val create = PendingBattleWrite("create-id", "/raids", buildJsonObject { put("idempotencyKey", "create-id") })
        val preparing = PendingBattleWrite("not-durable", "/raids/raid/commands", buildJsonObject {})
        val live = LiveBattleState(pending = PendingBattle("wallet", "base", create = create), preparingWrites = listOf(preparing))
        assertEquals(listOf(create), battleRecoverySummary(live).requests)
        assertEquals(0, battleRecoverySummary(live).sending)
    }
}
