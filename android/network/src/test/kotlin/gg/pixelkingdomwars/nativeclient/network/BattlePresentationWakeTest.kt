package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.toList
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Owner incident 2026-09-17 (store build, live raids): a deployed troop stood still until the server's own
 * long-poll cadence discovered the accepted command. The acknowledgement already proves the revision moved, so
 * the observer re-reads at once. The fake server below re-checks its journal only when the test releases its
 * next poll tick, like the source `/raids/:id/presentation` handler. This proves the wake bypasses that wait
 * without confusing a delayed CI thread with transport latency. */
class BattlePresentationWakeTest {
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val revisionA = "a".repeat(64)
    private val revisionB = "b".repeat(64)
    private val generation = "c".repeat(32)
    private fun event(tick: Int, kind: String = "pos") = buildJsonObject { put("t", tick); put("e", kind) }
    private fun metadata(terminal: Boolean = false) = buildJsonObject {
        put("source", if (terminal) "archive" else "live"); put("status", if (terminal) "resolved" else "pending_orders")
        put("simVersion", 14); put("raidProtocolVersion", 2); put("clock", buildJsonObject { put("rate", 1) })
        put("lastSequence", -1); put("snapshot", buildJsonObject { put("base", "frozen") })
        put("armySnapshot", buildJsonObject {}); put("commands", JsonArray(emptyList())); put("result", JsonNull)
    }
    private fun page(revision: String, batch: List<JsonObject>, parentRevision: String? = null, boundary: Int = 0, terminal: Boolean = false) = buildJsonObject {
        put("protocolVersion", 2); put("raidId", raid); put("revision", revision); put("generation", generation)
        put("parentRevision", parentRevision?.let(::JsonPrimitive) ?: JsonNull); put("replaceFromTick", boundary)
        put("eventOffset", 0); put("totalEvents", batch.size); put("events", JsonArray(batch))
        put("commandOffset", 0); put("totalCommands", 0); put("commands", JsonArray(emptyList()))
        put("nextCursor", JsonNull); put("state", metadata(terminal))
    }
    private fun capabilities() = buildJsonObject { put("presentation", buildJsonObject {
        put("enabled", true); put("protocolVersions", JsonArray(listOf(JsonPrimitive(2)))); put("maxWaitMs", 15_000)
        put("maxEvents", 50_000); put("maxCommands", 10); put("maxPageBytes", 262_144)
    }) }

    /** The source handler's shape: a read that already sees a newer revision returns at once; otherwise it
     * sleeps its cadence and re-checks, which is when a command committed meanwhile is first noticed. */
    private inner class FakeServer(private val wake: BattlePresentationWake?) {
        val queries = mutableListOf<Map<String, String>>()
        val longPollStarted = Channel<Unit>(Channel.UNLIMITED)
        val pollTick = CompletableDeferred<Unit>()
        val pageBServed = CompletableDeferred<Unit>()
        @Volatile var cancelledLongPolls = 0
        @Volatile var completedCadences = 0
        @Volatile var committed = false
        val presentation = BattlePresentation({ path, query ->
            if (path == "/native/capabilities") return@BattlePresentation capabilities()
            queries += query
            when (query["afterRevision"]) {
                null -> page(revisionA, listOf(event(0, "deploy")))
                revisionA -> {
                    // Snapshot before notifying the test: its acknowledgement cannot retroactively make
                    // the already-started poll a fresh read, even if another dispatcher resumes it first.
                    val committedAtRead = committed
                    longPollStarted.send(Unit)
                    if (!committedAtRead) try {
                        pollTick.await(); completedCadences++
                    } catch (cancelled: CancellationException) { cancelledLongPolls++; throw cancelled }
                    check(committed) { "The test commits the command while the poll waits" }
                    pageBServed.complete(Unit)
                    page(revisionB, listOf(event(2, "accepted")), parentRevision = revisionA, boundary = 2)
                }
                else -> page("d".repeat(64), listOf(event(0, "terminal")), terminal = true)
            }
        }, 14, pause = {}, wake = wake)
    }

    @Test fun `a command acknowledgement abandons the waiting long-poll and re-reads at once with the applied cursor`() = runBlocking {
        val wake = BattlePresentationWake()
        val server = FakeServer(wake)
        val emitted = mutableListOf<JsonObject>()
        val observer = launch { server.presentation.observe(raid).toList(emitted) }
        withTimeout(2_000) { server.longPollStarted.receive() }
        server.committed = true
        wake.wake()
        // The woken observer's fresh read reaches the fake server immediately and is served at once.
        withTimeout(2_000) { server.longPollStarted.receive() }
        withTimeout(5_000) { observer.join() }
        assertEquals("The waiting poll was abandoned once", 1, server.cancelledLongPolls)
        assertFalse("The fresh read completes before the server's next poll tick", server.pollTick.isCompleted)
        assertEquals("No server cadence was needed to obtain the acknowledged revision", 0, server.completedCadences)
        val longPolls = server.queries.filter { it["afterRevision"] == revisionA }
        assertEquals("Woken and fresh reads both carry the applied cursor", 2, longPolls.size)
        assertTrue(longPolls.none { it.containsKey("cursor") })
        assertEquals(listOf(revisionA, revisionB, "d".repeat(64)), emitted.map { it.string("revision") })
        assertEquals("The woken read changed nothing: one revision B, no duplicate", 1, emitted.count { it.string("revision") == revisionB })
    }

    @Test fun `without a wake the acknowledged revision waits for the server cadence, with one it does not`() = runBlocking {
        suspend fun acknowledge(wake: BattlePresentationWake?): FakeServer {
            val server = FakeServer(wake)
            val emitted = mutableListOf<JsonObject>()
            val observer = launch { server.presentation.observe(raid).toList(emitted) }
            withTimeout(2_000) { server.longPollStarted.receive() }
            server.committed = true
            if (wake == null) {
                assertFalse("An acknowledgement alone cannot answer the already-waiting poll", server.pageBServed.isCompleted)
                assertTrue("Without a wake the observer still waits for the server tick", observer.isActive)
                server.pollTick.complete(Unit)
            } else {
                wake.wake()
                withTimeout(2_000) { server.pageBServed.await() }
                assertFalse("The wake served revision B while the server cadence was still blocked", server.pollTick.isCompleted)
            }
            withTimeout(5_000) { observer.join() }
            assertEquals(listOf(revisionA, revisionB, "d".repeat(64)), emitted.map { r -> r.string("revision") })
            return server
        }
        val before = acknowledge(null)
        val after = acknowledge(BattlePresentationWake())
        assertEquals("Without a wake the original poll resumes on the server's next cadence", 1, before.completedCadences)
        assertEquals("The original poll was allowed to answer normally", 0, before.cancelledLongPolls)
        assertEquals("With a wake no server cadence is needed", 0, after.completedCadences)
        assertEquals("The wake abandons the blocked poll once", 1, after.cancelledLongPolls)
    }

    @Test fun `wakes never race page continuation and earlier wakes are not remembered as work`() = runBlocking {
        val wake = BattlePresentationWake()
        wake.wake(); wake.wake() // Acknowledgements before the observer exists are not remembered as work.
        var polls = 0
        val presentation = BattlePresentation({ path, query ->
            if (path == "/native/capabilities") capabilities()
            else if (query.containsKey("cursor")) {
                wake.wake() // An acknowledgement while a continuation page downloads must not abandon that page.
                buildJsonObject {
                    put("protocolVersion", 2); put("raidId", raid); put("revision", revisionA); put("generation", generation)
                    put("parentRevision", JsonNull); put("replaceFromTick", 0); put("eventOffset", 1); put("totalEvents", 2)
                    put("events", JsonArray(listOf(event(2)))); put("commandOffset", 0); put("totalCommands", 0)
                    put("commands", JsonArray(emptyList())); put("nextCursor", JsonNull); put("state", JsonNull)
                }
            } else { polls++; JsonObject(page(revisionA, listOf(event(0)), terminal = true) + ("nextCursor" to JsonPrimitive("page-two")) + ("totalEvents" to JsonPrimitive(2))) }
        }, 14, pause = {}, wake = wake)
        val emitted = withTimeout(5_000) { presentation.observe(raid).toList() }
        assertEquals("One first-page read; neither the earlier wakes nor the mid-continuation wake repeated it", 1, polls)
        assertEquals(listOf(0, 2), emitted.single().objects("events").map { it.battleInt("t") })
    }

    @Test fun `a deploy acknowledgement wakes the observer while a definite refusal does not`() = runBlocking {
        val storage = object : SecretStore { @Volatile var raw: String? = null
            override fun read() = raw; override fun write(value: String) { raw = value }; override fun clear() { raw = null } }
        val store = PendingBattleStore(storage)
        store.put(PendingBattle("wallet", "deed", raidId = raid, stage = 1))
        val pages = Channel<JsonObject>(Channel.UNLIMITED)
        val clock = buildJsonObject {
            put("protocolVersion", 2); put("revision", 0); put("rate", 1); put("anchorWallAt", JsonNull); put("anchorSimMs", 0)
            put("serverNow", "2026-09-01T00:00:00Z"); put("simNowMs", 0); put("battleEndsAt", JsonNull); put("durationMs", 10000)
        }
        pages.send(buildJsonObject {
            put("raidId", raid); put("simVersion", 14); put("raidProtocolVersion", 2); put("source", "live"); put("status", "pending_orders")
            put("commands", JsonArray(emptyList())); put("clock", clock); put("_clientFirstPageReceivedAtNanos", 1L)
            put("snapshot", buildJsonObject {}); put("armySnapshot", buildJsonObject { put("counts", buildJsonObject { put("archer", 2) }) })
            put("result", JsonNull)
        })
        val wake = BattlePresentationWake()
        var refuse = false
        val coordinator = BattleCoordinator.withTransport("wallet", "deed", 14, store, { _, _ -> error("no reads") }, { _, body ->
            if (refuse) throw ApiException(422, null, "Refused")
            buildJsonObject {
                put("command", JsonObject(requireNotNull(body["command"] as? JsonObject) + mapOf(
                    "clientCommandId" to body.getValue("clientCommandId"), "sequence" to JsonPrimitive(0))))
                put("clock", clock)
            }
        }, { pages.receiveAsFlow() }, wake)
        val foreground = launch { coordinator.runForeground() }
        withTimeout(2_000) { coordinator.state.first { it.phase == BattlePhase.STAGING } }
        val before = wake.current()
        coordinator.deploy("archer", 1, 2)
        assertEquals("The acknowledged deploy woke the observer exactly once", before + 1, wake.current())
        refuse = true
        assertTrue(runCatching { coordinator.deploy("archer", 1, 3) }.isFailure)
        assertEquals("A refusal changed no server revision, so nothing to wake", before + 1, wake.current())
        foreground.cancelAndJoin()
    }

    private val liveClock = buildJsonObject {
        put("protocolVersion", 2); put("revision", 0); put("rate", 1); put("anchorWallAt", JsonNull); put("anchorSimMs", 0)
        put("serverNow", "2026-09-01T00:00:00Z"); put("simNowMs", 0); put("battleEndsAt", JsonNull); put("durationMs", 10000)
    }
    private fun livePage(commands: List<JsonObject> = emptyList()) = buildJsonObject {
        put("raidId", raid); put("simVersion", 14); put("raidProtocolVersion", 2); put("source", "live"); put("status", "pending_orders")
        put("commands", JsonArray(commands)); put("clock", liveClock); put("_clientFirstPageReceivedAtNanos", 1L)
        put("snapshot", buildJsonObject {}); put("armySnapshot", buildJsonObject { put("counts", buildJsonObject { put("archer", 2) }) })
        put("result", JsonNull)
    }
    private fun accepted(body: JsonObject, sequence: Int) = JsonObject(requireNotNull(body["command"] as? JsonObject) + mapOf(
        "clientCommandId" to body.getValue("clientCommandId"), "sequence" to JsonPrimitive(sequence)))

    /** Review 2026-09-18 (deploy latency): the wake used to fire only after the receipt's durable bookkeeping — a
     * Keystore write and fsync under the gate, queued behind every other order being saved. It now fires on the
     * acknowledgement itself. What must stay true: the receipt is still recorded, once, and nothing is left behind. */
    @Test fun `the acknowledgement wakes the observer before the receipt's durable write and the receipt is still recorded once`() = runBlocking {
        val wake = BattlePresentationWake()
        val wakesAtWrite = java.util.Collections.synchronizedList(mutableListOf<Long>())
        val storage = object : SecretStore { @Volatile var raw: String? = null
            override fun read() = raw; override fun write(value: String) { wakesAtWrite += wake.current(); raw = value }; override fun clear() { raw = null } }
        val store = PendingBattleStore(storage)
        store.put(PendingBattle("wallet", "deed", raidId = raid, stage = 1))
        val pages = Channel<JsonObject>(Channel.UNLIMITED); pages.send(livePage())
        val coordinator = BattleCoordinator.withTransport("wallet", "deed", 14, store, { _, _ -> error("no reads") },
            { _, body -> buildJsonObject { put("command", accepted(body, 0)); put("clock", liveClock) } }, { pages.receiveAsFlow() }, wake)
        val foreground = launch { coordinator.runForeground() }
        withTimeout(2_000) { coordinator.state.first { it.phase == BattlePhase.STAGING } }
        wakesAtWrite.clear(); val before = wake.current()
        coordinator.deploy("archer", 1, 2)
        assertEquals("Intent and attempt are saved before the POST, so before any wake", before, wakesAtWrite.first())
        assertEquals("The receipt's journal write found the observer already woken", before + 1, wakesAtWrite.last())
        assertEquals("One acknowledgement, one wake", before + 1, wake.current())
        val settled = coordinator.state.value
        assertEquals(1, settled.commands.size); assertTrue(settled.pending!!.writes.isEmpty()); assertTrue(settled.inFlight.isEmpty()); assertNull(settled.error)
        assertTrue("The journal holds no unacknowledged order", store.get("wallet", "deed")!!.writes.isEmpty())
        foreground.cancelAndJoin()
    }

    /** The earlier wake makes this order more likely, so it is pinned: the woken read's presentation takes the gate
     * BEFORE the command's own receipt block. Either may go first; the other must find its work done, not redo it. */
    @Test fun `a presentation that overtakes the receipt neither loses nor doubles the command`() = runBlocking {
        val wake = BattlePresentationWake()
        val storage = object : SecretStore { @Volatile var raw: String? = null
            override fun read() = raw; override fun write(value: String) { raw = value }; override fun clear() { raw = null } }
        val store = PendingBattleStore(storage)
        store.put(PendingBattle("wallet", "deed", raidId = raid, stage = 1))
        val pages = Channel<JsonObject>(Channel.UNLIMITED); pages.send(livePage())
        lateinit var coordinator: BattleCoordinator
        coordinator = BattleCoordinator.withTransport("wallet", "deed", 14, store, { _, _ -> error("no reads") }, { _, body ->
            val command = accepted(body, 0)
            // The server committed the command; the observer's page carrying it is applied while the POST reply is still on its way.
            pages.send(livePage(listOf(command)))
            withTimeout(2_000) { coordinator.state.first { it.commands.size == 1 && it.pending?.writes?.isEmpty() == true } }
            assertTrue("The order is still marked in flight while its reply travels", coordinator.state.value.inFlight.isNotEmpty())
            buildJsonObject { put("command", command); put("clock", liveClock) }
        }, { pages.receiveAsFlow() }, wake)
        val foreground = launch { coordinator.runForeground() }
        withTimeout(2_000) { coordinator.state.first { it.phase == BattlePhase.STAGING } }
        val before = wake.current()
        coordinator.deploy("archer", 1, 2)
        val settled = coordinator.state.value
        assertEquals("Accepted once, by sequence, whichever arrived first", 1, settled.commands.size)
        assertEquals("One archer of two remains: the order is counted once", 1, settled.available("archer"))
        assertTrue(settled.pending!!.writes.isEmpty()); assertTrue(settled.inFlight.isEmpty()); assertNull(settled.error); assertFalse(settled.blocked)
        assertTrue(store.get("wallet", "deed")!!.writes.isEmpty())
        assertEquals(before + 1, wake.current())
        foreground.cancelAndJoin()
    }

    /** Review 2026-09-18: every wake-driven read is one more GET against the presentation route's per-minute limit
     * (LIVE_RAID.reconnectRateLimitPerMin, 120 on production main) and a second stream per wallet while the abandoned
     * one closes. Wakes are coalesced where they are consumed: abandoning a read needs a permit. This drives the
     * worst case — a wake always pending, the observer always willing to abandon — on a virtual clock. */
    @Test fun `coalesced wakes keep sustained rapid deploys inside the presentation read budget`() = runBlocking {
        var nowNanos = 0L
        val wake = BattlePresentationWake({ nowNanos }, { ms -> nowNanos += ms * 1_000_000L })
        val permitsAtMs = mutableListOf<Long>()
        while (true) {
            val seen = wake.current(); wake.wake()            // a deploy is acknowledged…
            wake.awaitAfter(seen)                              // …and the observer asks to abandon its long-poll
            if (nowNanos >= 60_000L * 1_000_000L) break
            permitsAtMs += nowNanos / 1_000_000L
            nowNanos += 50L * 1_000_000L                       // the player keeps tapping, 20 orders a second
        }
        val spacing = permitsAtMs.zipWithNext { a, b -> b - a }
        assertTrue("Never two abandoned reads within ${BattlePresentationWake.WAKE_SPACING_MS} ms: $spacing", spacing.all { it >= BattlePresentationWake.WAKE_SPACING_MS })
        assertEquals("A short burst answers at once", listOf(0L, 200L, 400L), permitsAtMs.take(BattlePresentationWake.WAKE_BURST))
        val ceiling = BattlePresentationWake.WAKE_BURST + 60_000L / BattlePresentationWake.WAKE_REFILL_MS
        assertTrue("At most $ceiling wake-driven reads in a minute of nonstop tapping, got ${permitsAtMs.size}", permitsAtMs.size <= ceiling)
        assertTrue("which leaves the route's 120/min limit to the observer's own reads", permitsAtMs.size <= 30)
    }

    @Test fun `a wake that is waiting for its permit takes nothing when the long-poll answers first`() = runBlocking {
        var nowNanos = 0L
        val gate = Channel<Unit>(Channel.UNLIMITED)
        val wake = BattlePresentationWake({ nowNanos }, { gate.receive() }) // a permit wait that only the test releases
        repeat(BattlePresentationWake.WAKE_BURST) { val seen = wake.current(); wake.wake(); wake.awaitAfter(seen); nowNanos += BattlePresentationWake.WAKE_SPACING_MS * 1_000_000L }
        val seen = wake.current(); wake.wake()
        val waiting = launch { wake.awaitAfter(seen) }
        delay(50); assertTrue("The burst is spent, so this wake waits while the poll keeps running", waiting.isActive)
        waiting.cancelAndJoin() // BattlePresentation cancels it when the read returns first
        nowNanos += BattlePresentationWake.WAKE_REFILL_MS * 1_000_000L
        val next = wake.current(); wake.wake()
        withTimeout(2_000) { wake.awaitAfter(next) } // the refilled permit was not consumed by the cancelled wait
    }

}
