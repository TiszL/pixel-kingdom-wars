package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The defender's WATCH LIVE reads the same canonical presentation the attacker plays; it never persists an
 * intent, never sends an order, and a participant refusal blocks the view instead of retrying. */
class BattleSpectatorTest {
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val pages = Channel<JsonObject>(Channel.UNLIMITED)
    private fun clock(revision: Int = 0, started: Boolean = false) = buildJsonObject {
        put("protocolVersion", 2); put("revision", revision); put("rate", 1)
        put("anchorWallAt", if (started) JsonPrimitive("2026-09-01T00:00:00Z") else JsonNull); put("anchorSimMs", 0)
        put("serverNow", "2026-09-01T00:00:0${revision}Z"); put("simNowMs", 0); put("battleEndsAt", JsonNull); put("durationMs", 10000)
    }
    private fun page(status: String = "pending_orders", source: String = "live", clock: JsonObject? = clock(), result: JsonObject? = null) = buildJsonObject {
        put("raidId", raid); put("simVersion", 14); put("raidProtocolVersion", 2); put("source", source); put("status", status)
        put("commands", JsonArray(emptyList())); put("clock", clock ?: JsonNull); put("_clientFirstPageReceivedAtNanos", 5L)
        put("snapshot", buildJsonObject {}); put("armySnapshot", buildJsonObject {}); put("result", result ?: JsonNull); put("events", JsonArray(emptyList()))
    }
    private fun spectator(flow: (String) -> Flow<JsonObject> = { pages.receiveAsFlow() }) = BattleSpectator(raid, 14, flow, pause = {})

    @Test fun `staged running and resolved presentations map to phases without any persisted intent`() = runBlocking {
        val s = spectator()
        val job = launch { s.runForeground() }
        pages.send(page()); withTimeout(2000) { s.state.first { it.phase == BattlePhase.STAGING } }
        assertTrue(s.state.value.connected); assertNull(s.state.value.pending)
        pages.send(page(clock = clock(1, started = true))); withTimeout(2000) { s.state.first { it.phase == BattlePhase.RUNNING } }
        assertEquals(1L, s.state.value.clock!!.value.revision)
        pages.send(page(status = "resolved", source = "archive", clock = null, result = buildJsonObject { put("stars", 2) }))
        withTimeout(2000) { s.state.first { it.phase == BattlePhase.RESULT } }
        job.join(); assertEquals("2", s.state.value.result!!.string("stars"))
    }
    @Test fun `a participant refusal blocks the view and a revoked session propagates`() = runBlocking {
        val forbidden = spectator { flow { throw ApiException(403, null, "not a participant") } }
        forbidden.runForeground()
        assertTrue(forbidden.state.value.blocked); assertFalse(forbidden.state.value.connected)
        val revoked = spectator { flow { throw ApiException(401, null, "expired") } }
        assertEquals(401, (runCatching { revoked.runForeground() }.exceptionOrNull() as ApiException).status)
    }
    @Test fun `a different raid or simulator is refused and an older clock cannot rewind`() = runBlocking {
        val s = spectator()
        val job = launch { s.runForeground() }
        pages.send(page(clock = clock(3, started = true))); withTimeout(2000) { s.state.first { it.phase == BattlePhase.RUNNING } }
        pages.send(page(clock = clock(1, started = true))); repeat(10) { yield() }
        assertEquals(3L, s.state.value.clock!!.value.revision)
        pages.send(JsonObject(page() + ("raidId" to JsonPrimitive("22222222-2222-4222-8222-222222222222"))))
        withTimeout(2000) { s.state.first { it.blocked } }
        job.join()
    }
}
