package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** A staging label must survive recovery without becoming a client authority over orders or expiry. */
class BattleStagingDeadlineTest {
    private class Memory : SecretStore {
        var raw: String? = null
        override fun read() = raw
        override fun write(value: String) { raw = value }
        override fun clear() { raw = null }
    }
    private val raidId = "11111111-1111-4111-8111-111111111111"
    private val deadline = "2026-09-13T12:03:00.000Z"
    private val deadlineMs = Instant.parse(deadline).toEpochMilli()
    private fun raid(deadlineValue: JsonElement? = JsonPrimitive(deadline)) = buildJsonObject {
        put("id", raidId); put("attackerBaseId", "base"); put("simVersion", 14); put("raidProtocolVersion", 2)
        put("campaignStage", 1); deadlineValue?.let { put("ordersDeadlineAt", it) }
    }
    private fun clock(started: Boolean = false) = buildJsonObject {
        put("protocolVersion", 2); put("revision", 0); put("rate", 1); put("durationMs", 10000)
        put("anchorWallAt", if (started) JsonPrimitive("2026-09-13T12:00:00Z") else JsonNull)
        put("anchorSimMs", 0); put("simNowMs", 0); put("serverNow", "2026-09-13T12:00:00Z"); put("battleEndsAt", JsonNull)
    }
    private fun page() = buildJsonObject {
        put("raidId", raidId); put("simVersion", 14); put("raidProtocolVersion", 2)
        put("source", "live"); put("status", "pending_orders"); put("commands", JsonArray(emptyList()))
        put("clock", clock()); put("_clientFirstPageReceivedAtNanos", 1L); put("snapshot", buildJsonObject {})
        put("armySnapshot", buildJsonObject { put("counts", buildJsonObject { put("archer", 2) }) })
        put("result", JsonNull)
    }
    private fun coordinator(store: PendingBattleStore, row: JsonObject = raid(),
        post: suspend (String, JsonObject) -> JsonObject = { _, _ -> buildJsonObject { put("raid", row) } },
        get: suspend (String, Map<String, String>) -> JsonObject = { path, _ -> when (path) {
            "/native/capabilities" -> buildJsonObject { put("simVersion", 14); put("presentation", buildJsonObject { put("enabled", true) }) }
            "/raids/pending" -> buildJsonObject { put("raids", JsonArray(emptyList())) }
            "/raids/pending/$raidId" -> buildJsonObject { put("raid", row) }
            else -> error("Unexpected read")
        } }
    ) = BattleCoordinator("wallet", "base", 14, store, get, post,
        { flow { emit(page()); awaitCancellation() } }, { 1L }, { "command-id" })
    private suspend fun CoroutineScope.staging(value: BattleCoordinator): Job {
        val job = launch { value.runForeground() }
        withTimeout(2000) { value.state.first { it.phase == BattlePhase.STAGING } }
        return job
    }
    private fun pending(value: String? = deadline) = PendingBattle("wallet", "base", raidId, stage = 1, ordersDeadlineAt = value)

    @Test fun `accepted create keeps the authoritative deadline across a read-only process recovery`() = runBlocking {
        val store = PendingBattleStore(Memory()); var posts = 0
        coordinator(store, post = { _, _ -> posts++; buildJsonObject { put("raid", raid()) } }).createCampaign(1)
        assertEquals(deadline, store.get("wallet", "base")!!.ordersDeadlineAt)
        val recovered = coordinator(store, post = { _, _ -> error("Recovery cannot POST") }, get = { _, _ -> error("No extra deadline read") })
        val job = staging(recovered)
        try {
            assertEquals(deadlineMs - 10000, recovered.state.value.deployEndsAtMs())
            assertEquals(1, posts)
        } finally { job.cancelAndJoin() }
    }

    @Test fun `explicit pending resume refreshes display metadata without replacing an uncertain order`() = runBlocking {
        val store = PendingBattleStore(Memory())
        val write = PendingBattleWrite("unknown", "/raids/$raidId/commands", jsonBody("clientCommandId" to "unknown"), attempted = true)
        val original = pending(null).copy(writes = listOf(write)); store.put(original)
        coordinator(store, post = { _, _ -> error("Resume cannot POST") }).resumeRaid(raidId)
        assertEquals(original.copy(ordersDeadlineAt = deadline), store.get("wallet", "base"))
        coordinator(store, row = raid(JsonPrimitive("bad date")), post = { _, _ -> error("Resume cannot POST") }).resumeRaid(raidId)
        assertEquals("Malformed latest metadata is unavailable; the exact unknown order remains", original, store.get("wallet", "base"))
    }

    @Test fun `deadline cannot cross the existing raid base sim or protocol acceptance checks`() = runBlocking {
        for ((field, value) in listOf("id" to JsonPrimitive("22222222-2222-4222-8222-222222222222"),
            "attackerBaseId" to JsonPrimitive("other-base"), "simVersion" to JsonPrimitive(13), "raidProtocolVersion" to JsonPrimitive(1))) {
            val store = PendingBattleStore(Memory()); val original = pending(null); store.put(original)
            val wrong = JsonObject(raid() + (field to value))
            assertTrue(runCatching { coordinator(store, row = wrong).resumeRaid(raidId) }.isFailure)
            assertEquals(original, store.get("wallet", "base"))
        }
        val store = PendingBattleStore(Memory())
        val wrongBase = JsonObject(raid() + ("attackerBaseId" to JsonPrimitive("other-base")))
        assertTrue(runCatching { coordinator(store, row = wrongBase).createCampaign(1) }.isFailure)
        assertNull(store.get("wallet", "base")!!.ordersDeadlineAt)
        assertTrue("An invalid acknowledgement cannot erase the original create identity", store.get("wallet", "base")!!.create!!.attempted)
    }

    @Test fun `absent malformed and nonstring wire deadlines cannot reject an otherwise accepted raid`() = runBlocking {
        for (raw in listOf(null, JsonNull, JsonPrimitive(123), JsonPrimitive(true), JsonPrimitive("tomorrow"),
            JsonPrimitive("+1000000000-12-31T23:59:59Z"), buildJsonObject {}, JsonArray(emptyList()))) {
            val store = PendingBattleStore(Memory())
            coordinator(store, row = raid(raw)).createCampaign(1)
            val accepted = store.get("wallet", "base")!!
            assertEquals(raidId, accepted.raidId); assertNull(accepted.create); assertNull(accepted.ordersDeadlineAt)
            assertNull(LiveBattleState(phase = BattlePhase.STAGING, pending = accepted).deployEndsAtMs(10000))
        }
    }

    @Test fun `old and malformed cached display fields leave durable recovery intent readable`() {
        val memory = Memory(); val store = PendingBattleStore(memory)
        val original = pending(null).copy(writes = listOf(PendingBattleWrite("unknown", "/raids/$raidId/finish", buildJsonObject {}, true)))
        store.put(original)
        val oldRaw = memory.raw!!; assertFalse(oldRaw.contains("ordersDeadlineAt"))
        assertEquals(original, store.get("wallet", "base"))
        val envelope = Json.parseToJsonElement(oldRaw).jsonObject
        val entries = envelope.getValue("requests").jsonObject
        val key = entries.keys.single(); val record = entries.getValue(key).jsonObject
        for (raw in listOf(JsonPrimitive("invalid"), JsonPrimitive(1), buildJsonObject {}, JsonArray(emptyList()))) {
            memory.raw = JsonObject(envelope + ("requests" to buildJsonObject {
                put(key, JsonObject(record + ("ordersDeadlineAt" to raw)))
            })).toString()
            assertEquals(original, store.get("wallet", "base"))
        }
        assertNull(store.get("other-wallet", "base")); assertNull(store.get("wallet", "other-base"))
    }

    @Test fun `staging display uses canonical duration with only an explicit catalogue fallback`() {
        val state = LiveBattleState(phase = BattlePhase.STAGING, pending = pending())
        assertNull(state.deployEndsAtMs()); assertNull(state.deployEndsAtMs(0)); assertNull(state.deployEndsAtMs(-1))
        assertEquals(deadlineMs - 25000, state.deployEndsAtMs(25000))
        val canonical = state.copy(clock = BattleClock.read(clock(), 1))
        assertEquals(deadlineMs - 10000, canonical.deployEndsAtMs(25000))
        assertEquals(deadlineMs - 10000, canonical.copy(clock = canonical.clock!!.copy(value = canonical.clock.value.copy(rate = 2))).deployEndsAtMs())
        assertNull(canonical.copy(clock = canonical.clock!!.copy(value = canonical.clock.value.copy(durationMs = 0))).deployEndsAtMs(25000))
        assertNull(state.copy(pending = pending(Instant.ofEpochMilli(Long.MIN_VALUE).toString())).deployEndsAtMs(10000))
    }

    @Test fun `running terminal unknown and malformed states never show a staging deadline`() {
        val state = LiveBattleState(phase = BattlePhase.STAGING, pending = pending())
        for (phase in BattlePhase.entries.filter { it != BattlePhase.STAGING }) assertNull(state.copy(phase = phase).deployEndsAtMs(10000))
        assertNull(state.copy(expired = true).deployEndsAtMs(10000))
        assertNull(state.copy(result = buildJsonObject {}).deployEndsAtMs(10000))
        assertNull(state.copy(clock = BattleClock.read(clock(started = true), 1)).deployEndsAtMs(10000))
        assertNull(state.copy(pending = null).deployEndsAtMs(10000))
        assertNull(state.copy(pending = pending("invalid")).deployEndsAtMs(10000))
    }

    @Test fun `elapsed display deadline neither blocks orders nor proves expiry or home availability`() = runBlocking {
        val store = PendingBattleStore(Memory()); store.put(pending("1970-01-01T00:00:00Z")); var posts = 0
        val battle = coordinator(store, post = { _, body ->
            posts++
            buildJsonObject {
                put("command", JsonObject(body.getValue("command").jsonObject + mapOf(
                    "clientCommandId" to body.getValue("clientCommandId"), "sequence" to JsonPrimitive(0))))
                put("clock", clock())
            }
        })
        val job = staging(battle)
        try {
            assertEquals(-10000L, battle.state.value.deployEndsAtMs())
            battle.deploy("archer", 1, 2)
            assertEquals(1, posts); assertEquals(1, battle.state.value.commands.size)
            assertFalse(battle.state.value.expired); assertFalse(battle.state.value.terminal)
            assertTrue(runCatching { battle.home() }.isFailure)
            assertNotNull(store.get("wallet", "base"))
        } finally { job.cancelAndJoin() }
    }
}
