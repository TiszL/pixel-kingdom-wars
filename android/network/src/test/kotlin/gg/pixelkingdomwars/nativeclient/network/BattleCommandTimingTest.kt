package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

class BattleCommandTimingTest {
    private class Memory : SecretStore {
        @Volatile var raw: String? = null
        var beforeWrite: (String) -> Unit = {}
        val writes = AtomicInteger()
        override fun read() = raw
        override fun write(value: String) { beforeWrite(value); raw = value; writes.incrementAndGet() }
        override fun clear() { raw = null }
    }
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val memory = Memory()
    private val store = PendingBattleStore(memory)
    private val pages = Channel<JsonObject>(Channel.UNLIMITED)
    private val stages = Collections.synchronizedList(mutableListOf<Pair<String, BattleCommandStage>>())
    private val bound = Collections.synchronizedList(mutableListOf<String>())
    private val inputCalls = AtomicInteger()
    private var ids = 0
    private val timing = object : BattleCommandTiming {
        override fun input(): BattleInputTiming {
            inputCalls.incrementAndGet()
            return object : BattleInputTiming { override fun admitted(id: String) { bound += id } }
        }
        override fun stage(id: String, stage: BattleCommandStage) { stages += id to stage }
    }
    private fun clock() = buildJsonObject {
        put("protocolVersion", 2); put("revision", 0); put("rate", 1); put("anchorWallAt", JsonNull)
        put("anchorSimMs", 0); put("serverNow", "2026-09-15T00:00:00Z"); put("simNowMs", 0)
        put("battleEndsAt", JsonNull); put("durationMs", 10000)
    }
    private fun page(commands: List<JsonObject> = emptyList()) = buildJsonObject {
        put("raidId", raid); put("simVersion", 15); put("raidProtocolVersion", 2)
        put("source", "live"); put("status", "pending_orders"); put("commands", JsonArray(commands))
        put("clock", clock()); put("_clientFirstPageReceivedAtNanos", 1_000_000_000L)
        put("armySnapshot", buildJsonObject { put("counts", buildJsonObject { put("dragon", 2) }) })
    }
    private fun receipt(body: JsonObject, sequence: Int = 0) = buildJsonObject {
        put("command", JsonObject(body.getValue("command").jsonObject + mapOf(
            "clientCommandId" to body.getValue("clientCommandId"), "sequence" to JsonPrimitive(sequence))))
        put("clock", clock())
    }
    private fun request(id: String) = PendingBattleWrite(id, "/raids/$raid/commands", buildJsonObject {
        put("clientCommandId", id); put("command", buildJsonObject {
            put("kind", "deploy"); put("payload", buildJsonObject { put("troop", "dragon"); put("tx", -20); put("ty", 50) })
        })
    }, attempted = true)
    private fun coordinator(observer: BattleCommandTiming = timing, post: suspend (String, JsonObject) -> JsonObject) =
        BattleCoordinator("wallet", "base", 15, store, { _, _ -> error("Saved raid needs no pending lookup") },
            post, { pages.receiveAsFlow() }, newId = { "original-${++ids}" }, timing = observer)
    private suspend fun CoroutineScope.staged(coordinator: BattleCoordinator): Job {
        val job = launch { coordinator.runForeground() }
        pages.send(page())
        withTimeout(2000) { coordinator.state.first { it.phase == BattlePhase.STAGING } }
        return job
    }
    private fun saved(writes: List<PendingBattleWrite> = emptyList()) = store.put(PendingBattle("wallet", "base", raidId = raid, writes = writes))
    private fun observed(id: String) = synchronized(stages) { stages.filter { it.first == id }.map { it.second } }

    @Test fun `milestones wait for each durable write while the input binds before slow intent storage`() = runBlocking {
        saved()
        val entered = List(3) { CompletableDeferred<Unit>() }
        val release = List(3) { CountDownLatch(1) }
        val write = AtomicInteger()
        memory.beforeWrite = {
            val index = write.getAndIncrement()
            entered[index].complete(Unit)
            check(release[index].await(5, TimeUnit.SECONDS)) { "Storage test was not released" }
        }
        val posts = AtomicInteger()
        val coordinator = coordinator { _, body -> posts.incrementAndGet(); receipt(body) }
        val foreground = staged(coordinator)
        val deploy = async { coordinator.deploy("dragon", -20, 50, inputTiming = coordinator.beginInputTiming()) }
        try {
            withTimeout(2000) { entered[0].await() }
            assertEquals(listOf("original-1"), bound); assertEquals(1, coordinator.state.value.available("dragon"))
            assertTrue(stages.isEmpty()); assertEquals(0, posts.get())
            release[0].countDown(); withTimeout(2000) { entered[1].await() }
            assertEquals(listOf(BattleCommandStage.INTENT_DURABLE), observed("original-1")); assertEquals(0, posts.get())
            release[1].countDown(); withTimeout(2000) { entered[2].await() }
            assertEquals(listOf(BattleCommandStage.INTENT_DURABLE, BattleCommandStage.ATTEMPT_DURABLE,
                BattleCommandStage.POST_BEGIN, BattleCommandStage.RESPONSE), observed("original-1"))
            assertEquals(1, posts.get())
            release[2].countDown(); deploy.await()
            assertEquals(BattleCommandStage.RECEIPT_DURABLE, observed("original-1").last())
            assertEquals(5, observed("original-1").size); assertTrue(store.get("wallet", "base")!!.writes.isEmpty())
        } finally { release.forEach { it.countDown() }; deploy.cancelAndJoin(); foreground.cancelAndJoin() }
    }

    @Test fun `an invalid receipt observes a response but never acknowledges a different original id`() = runBlocking {
        saved()
        val coordinator = coordinator { _, body -> receipt(JsonObject(body + ("clientCommandId" to JsonPrimitive("wrong-id")))) }
        val foreground = staged(coordinator)
        try {
            assertTrue(runCatching { coordinator.deploy("dragon", -20, 50, inputTiming = coordinator.beginInputTiming()) }.isFailure)
            assertEquals(BattleCommandStage.RESPONSE, observed("original-1").last())
            assertFalse(stages.any { it.second == BattleCommandStage.RECEIPT_DURABLE })
            assertEquals("original-1", store.get("wallet", "base")!!.writes.single().id)
            assertTrue(coordinator.state.value.commands.isEmpty())
        } finally { foreground.cancelAndJoin() }
    }

    @Test fun `refused admission does not bind an input to an unqueued command`() = runBlocking {
        saved()
        val coordinator = coordinator { _, _ -> error("An unavailable troop cannot POST") }
        val foreground = staged(coordinator)
        try {
            assertTrue(runCatching { coordinator.deploy("missing", -20, 50, inputTiming = coordinator.beginInputTiming()) }.isFailure)
            assertEquals(1, inputCalls.get()); assertTrue(bound.isEmpty()); assertTrue(stages.isEmpty())
            assertTrue(coordinator.state.value.preparingWrites.isEmpty()); assertTrue(store.get("wallet", "base")!!.writes.isEmpty())
        } finally { foreground.cancelAndJoin() }
    }

    @Test fun `failed receipt storage never reports durable acknowledgement or drops original intent`() = runBlocking {
        saved()
        val coordinator = coordinator { _, body ->
            memory.beforeWrite = { throw IOException("Receipt cannot be saved") }
            receipt(body)
        }
        val foreground = staged(coordinator)
        try {
            assertTrue(runCatching { coordinator.deploy("dragon", -20, 50, inputTiming = coordinator.beginInputTiming()) }.isFailure)
            assertEquals(BattleCommandStage.RESPONSE, observed("original-1").last())
            assertEquals("original-1", store.get("wallet", "base")!!.writes.single().id)
            assertTrue(coordinator.state.value.blocked)
        } finally { foreground.cancelAndJoin() }
    }

    @Test fun `throwing input bind and stage observers cannot change hero or troop command semantics`() = runBlocking {
        saved(); var failInput = true
        val observer = object : BattleCommandTiming {
            override fun input(): BattleInputTiming? {
                if (failInput) throw AssertionError("Optional input observer failed")
                return object : BattleInputTiming { override fun admitted(id: String) { throw CancellationException("Optional bind failed") } }
            }
            override fun stage(id: String, stage: BattleCommandStage) { throw AssertionError("Optional stage observer failed") }
        }
        val bodies = mutableListOf<JsonObject>()
        val coordinator = coordinator(observer) { _, body -> bodies += body; receipt(body, bodies.lastIndex) }
        val foreground = staged(coordinator)
        try {
            assertNull(coordinator.beginInputTiming()); failInput = false
            coordinator.hero("vex", -20, 50, inputTiming = coordinator.beginInputTiming())
            coordinator.deploy("dragon", -20, 50, inputTiming = coordinator.beginInputTiming())
            assertEquals(listOf("original-1", "original-2"), bodies.map { it.string("clientCommandId") })
            assertEquals(listOf("hero", "deploy"), bodies.map { it.getValue("command").jsonObject.string("kind") })
            assertEquals(2, coordinator.state.value.commands.size); assertTrue(store.get("wallet", "base")!!.writes.isEmpty())
        } finally { foreground.cancelAndJoin() }
    }

    @Test fun `restored original command recovers through reads without fabricating input or POST stages`() = runBlocking {
        val original = request("retained-original"); saved(listOf(original))
        val coordinator = coordinator { _, _ -> error("Read-only recovery cannot POST") }
        val foreground = staged(coordinator)
        try {
            pages.send(page(listOf(receipt(original.body).getValue("command").jsonObject)))
            withTimeout(2000) { coordinator.state.first { it.pending!!.writes.isEmpty() } }
            assertEquals(listOf(BattleCommandStage.RECEIPT_DURABLE), observed(original.id))
            assertTrue(bound.isEmpty()); assertEquals(0, inputCalls.get())
        } finally { foreground.cancelAndJoin() }
    }

    @Test fun `explicit retry reuses durable attempted marker without manufacturing a new input or intent`() = runBlocking {
        val original = request("retained-original"); saved(listOf(original))
        val coordinator = coordinator { _, body -> assertEquals(original.body, body); receipt(body) }
        val foreground = staged(coordinator)
        try {
            val before = memory.writes.get(); coordinator.retry(original.id)
            assertEquals(before + 1, memory.writes.get())
            assertEquals(listOf(BattleCommandStage.ATTEMPT_DURABLE, BattleCommandStage.POST_BEGIN,
                BattleCommandStage.RESPONSE, BattleCommandStage.RECEIPT_DURABLE), observed(original.id))
            assertTrue(bound.isEmpty()); assertEquals(0, inputCalls.get())
        } finally { foreground.cancelAndJoin() }
    }

    @Test fun `canonical read may acknowledge both originals before out of order POST responses without rewriting the journal`() = runBlocking {
        saved()
        val arrived = Channel<JsonObject>(Channel.UNLIMITED)
        val release = List(2) { CompletableDeferred<Unit>() }
        val coordinator = coordinator { _, body ->
            val index = body.string("clientCommandId")!!.substringAfter('-').toInt() - 1
            arrived.send(body); release[index].await(); receipt(body, index)
        }
        val foreground = staged(coordinator)
        val first = async { coordinator.deploy("dragon", -20, 50, inputTiming = coordinator.beginInputTiming()) }
        val second = async { coordinator.deploy("dragon", -20, 50, inputTiming = coordinator.beginInputTiming()) }
        try {
            val bodies = withTimeout(2000) { listOf(arrived.receive(), arrived.receive()) }.sortedBy { it.string("clientCommandId") }
            pages.send(page(bodies.mapIndexed { index, body -> receipt(body, index).getValue("command").jsonObject }))
            withTimeout(2000) { coordinator.state.first { it.pending!!.writes.isEmpty() } }
            for (id in bound) assertEquals(listOf(BattleCommandStage.INTENT_DURABLE, BattleCommandStage.ATTEMPT_DURABLE,
                BattleCommandStage.POST_BEGIN, BattleCommandStage.RECEIPT_DURABLE), observed(id))
            val before = memory.writes.get()
            release[1].complete(Unit); second.await(); release[0].complete(Unit); first.await()
            assertEquals(before, memory.writes.get()); assertEquals(2, coordinator.state.value.commands.size)
            for (id in bound) assertEquals(listOf(BattleCommandStage.RESPONSE, BattleCommandStage.RECEIPT_DURABLE), observed(id).takeLast(2))
        } finally { release.forEach { it.complete(Unit) }; first.cancelAndJoin(); second.cancelAndJoin(); foreground.cancelAndJoin() }
    }
}
