package gg.pixelkingdomwars.nativeclient.network

import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

class BattleCoordinatorTest {
    private class Memory : SecretStore {
        @Volatile var raw: String? = null
        var rejectWrites = false
        var beforeWrite: (String) -> Unit = {}
        var afterWrite: () -> Unit = {}
        val writes = AtomicInteger()
        override fun read() = raw
        override fun write(value: String) {
            writes.incrementAndGet(); beforeWrite(value)
            check(!rejectWrites) { "storage unavailable" }; raw = value; afterWrite()
        }
        override fun clear() { raw = null }
    }
    private val raid = "11111111-1111-4111-8111-111111111111"
    private val storage = Memory()
    private val store = PendingBattleStore(storage)
    private val pages = Channel<JsonObject>(Channel.UNLIMITED)
    private var time = 1_000_000_000L
    private var ids = 0
    private var pendingRaids: List<JsonObject> = emptyList()
    private fun clock(revision: Int = 0, started: Boolean = false, rate: Int = 1, server: String = "2026-09-01T00:00:00Z") = buildJsonObject {
        put("protocolVersion", 2); put("revision", revision); put("rate", rate)
        put("anchorWallAt", if (started) JsonPrimitive(server) else JsonNull); put("anchorSimMs", 0)
        put("serverNow", server); put("simNowMs", 0); put("battleEndsAt", JsonNull); put("durationMs", 10000)
    }
    private fun page(commands: List<JsonObject> = emptyList(), terminal: Boolean = false, clock: JsonObject = clock()) = buildJsonObject {
        put("raidId", raid); put("simVersion", 14); put("raidProtocolVersion", 2)
        put("source", if (terminal) "archive" else "live"); put("status", if (terminal) "resolved" else "pending_orders")
        put("commands", JsonArray(commands)); put("clock", clock); put("_clientFirstPageReceivedAtNanos", time)
        put("snapshot", buildJsonObject {}); put("armySnapshot", buildJsonObject { put("counts", buildJsonObject { put("archer", 2) }) })
        put("result", if (terminal) buildJsonObject { put("stars", 1) } else JsonNull)
    }
    private fun receipt(body: JsonObject, sequence: Int = 0, clock: JsonObject = clock()) = buildJsonObject {
        put("command", JsonObject(requireNotNull(body["command"] as? JsonObject) + mapOf(
            "clientCommandId" to body.getValue("clientCommandId"), "sequence" to JsonPrimitive(sequence))))
        put("clock", clock)
    }
    private fun makeCoordinator(beforeGet: suspend (String) -> Unit = {}, post: suspend (String, JsonObject) -> JsonObject) = BattleCoordinator("wallet", "deed", 14, store,
        { path, _ -> beforeGet(path); if (path == "/native/capabilities") buildJsonObject {
            put("simVersion", 14); put("presentation", buildJsonObject { put("enabled", true) })
        } else buildJsonObject { put("raids", JsonArray(pendingRaids)) } }, post, { pages.receiveAsFlow() }, { time }, { "request-${++ids}" })
    private suspend fun CoroutineScope.staged(coordinator: BattleCoordinator): Job {
        val job = launch { coordinator.runForeground() }
        pages.send(page())
        withTimeout(2000) { coordinator.state.first { it.phase == BattlePhase.STAGING } }
        return job
    }
    private fun savedRaid() { store.put(PendingBattle("wallet", "deed", raidId = raid, stage = 1)) }

    @Test fun `DNS failure at either campaign preflight read clears busy without persisting or posting and explicit retry starts once`() = runBlocking {
        for (failedPath in listOf("/native/capabilities", "/raids/pending")) {
            storage.clear()
            var offline = true; var posts = 0
            val coordinator = makeCoordinator(beforeGet = { path ->
                if (offline && path == failedPath) throw java.net.UnknownHostException("Unable to resolve host play.pixelkingdomwars.com")
            }) { _, _ -> posts++; buildJsonObject { put("raid", buildJsonObject {
                put("id", raid); put("attackerBaseId", "deed"); put("simVersion", 14); put("raidProtocolVersion", 2)
            }) } }
            assertTrue(runCatching { coordinator.createCampaign(1) }.exceptionOrNull() is java.net.UnknownHostException)
            assertFalse(coordinator.state.value.creating)
            assertNull(store.get("wallet", "deed")); assertEquals(0, posts)
            assertEquals("Can't connect to the game. Check your connection and try again.", coordinator.state.value.error)
            offline = false
            coordinator.createCampaign(1)
            assertEquals(1, posts); assertEquals(raid, store.get("wallet", "deed")?.raidId)
            assertNull(coordinator.state.value.error)
        }
    }

    @Test fun `checking an uncertain create keeps its original identity and never posts or adopts another pending march`() = runBlocking {
        var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; throw IOException("lost acknowledgement") }
        assertTrue(runCatching { coordinator.createCampaign(1) }.isFailure)
        val original = store.get("wallet", "deed")!!
        pendingRaids = listOf(buildJsonObject { put("id", raid); put("attackerBaseId", "deed") })
        coordinator.refreshEntry()
        val observing = launch { coordinator.runForeground() }
        try { withTimeout(3000) { coordinator.state.first { it.connected && it.candidates.isNotEmpty() } } }
        finally { observing.cancelAndJoin() }
        assertNull("A successful status read must replace stale connection failure with saved-request guidance", coordinator.state.value.error)
        assertEquals(original, store.get("wallet", "deed"))
        assertTrue(runCatching { coordinator.createCampaign(1) }.isFailure)
        assertEquals("Neither read recovery nor a second entry may charge again", 1, posts)
    }

    @Test fun `acknowledged entry reconnects through the existing single reader without changing raid or posting`() = runBlocking {
        savedRaid()
        var online = false; var readers = 0; var activeReaders = 0; var maxReaders = 0; var posts = 0
        val coordinator = BattleCoordinator("wallet", "deed", 14, store, { _, _ -> error("Known raids read presentation") },
            { _, _ -> posts++; error("Recovery cannot post") }, { requested -> flow {
                assertEquals(raid, requested); readers++; activeReaders++; maxReaders = maxOf(maxReaders, activeReaders)
                try {
                    if (!online) throw java.net.UnknownHostException("private transport detail")
                    emit(page()); awaitCancellation()
                } finally { activeReaders-- }
            } })
        val observing = launch { coordinator.runForeground() }
        try {
            withTimeout(3000) { coordinator.state.first { it.error != null } }
            assertNull(coordinator.state.value.presentation)
            online = true
            repeat(20) { coordinator.refreshEntry() }
            withTimeout(3000) { coordinator.state.first { it.presentation != null } }
            assertEquals(2, readers); assertEquals(1, maxReaders)
            assertEquals(raid, store.get("wallet", "deed")?.raidId); assertEquals(0, posts)
        } finally { observing.cancelAndJoin() }
    }

    @Test fun `transport copy must preserve compatibility and structured API instructions`() {
        val incompatible = ApiCompatibilityException("/native/capabilities")
        assertEquals(incompatible.message, battleFailureMessage(incompatible))
        val storage = SecretStorageException()
        assertEquals(storage.message, battleFailureMessage(storage))
        assertEquals("Out of raid energy", battleFailureMessage(ApiException(422, null, "Out of raid energy")))
        assertFalse(battleFailureMessage(java.net.UnknownHostException("hostname")).contains("hostname"))
    }

    @Test fun `an uncertain finish cannot allocate or post another result request`() = runBlocking {
        savedRaid(); var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; throw IOException("lost result acknowledgement") }
        val observing = staged(coordinator)
        try {
            assertTrue(runCatching { coordinator.finish() }.isFailure)
            val original = store.get("wallet", "deed")!!
            assertNotNull(coordinator.state.value.unresolvedFinish)
            repeat(3) { assertTrue(runCatching { coordinator.finish() }.isFailure) }
            coordinator.refreshEntry()
            assertEquals(original, store.get("wallet", "deed"))
            assertEquals("Only explicit exact-request recovery may resend the saved FINISH", 1, posts)
        } finally { observing.cancelAndJoin() }
    }

    @Test fun `server Retry After survives lifecycle reentry and repeated retry taps without another request`() = runBlocking {
        var reads = 0
        val coordinator = makeCoordinator(beforeGet = {
            reads++
            if (reads == 1) throw ApiException(429, null, "Wait", retryAfterSeconds = 14)
        }) { _, _ -> error("Read recovery must not POST") }
        var observing = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.runForeground() }
        assertEquals(1, reads); assertFalse(coordinator.state.value.connected)
        observing.cancelAndJoin()
        repeat(20) { coordinator.refreshEntry() }
        observing = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.runForeground() }
        assertEquals("Reentering the screen must retain the server's original deadline", 1, reads)
        observing.cancelAndJoin()
        time += 14_000_000_000L
        observing = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.runForeground() }
        assertTrue(coordinator.state.value.connected)
        assertEquals("Twenty retry taps coalesce to at most one queued read after the deadline", 3, reads)
        observing.cancelAndJoin()
    }

    @Test fun `live presentation hands rate limits to its coordinator without hidden retry or delay`() = runBlocking {
        val refusal = ApiException(429, null, "Rate limited", retryAfterSeconds = 14)
        var reads = 0
        val presentation = BattlePresentation({ _, _ -> reads++; throw refusal }, 14,
            pause = { error("The live coordinator owns this deadline") }, retryRateLimits = false)
        assertSame(refusal, runCatching { presentation.observe(raid).first() }.exceptionOrNull())
        assertEquals(1, reads)
    }

    @Test fun `finish rate limit blocks new requests until the server deadline without automatically retrying`() = runBlocking {
        savedRaid(); var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; throw ApiException(429, null, "Rate limited", retryAfterSeconds = 14) }
        val observing = staged(coordinator)
        try {
            assertTrue(runCatching { coordinator.finish() }.isFailure)
            assertNull("A definite refusal leaves no uncertain finish", coordinator.state.value.unresolvedFinish)
            repeat(20) { assertTrue(runCatching { coordinator.finish() }.isFailure) }
            assertEquals(1, posts); assertTrue(store.get("wallet", "deed")!!.writes.isEmpty())
            time += 14_000_000_000L
            assertEquals("Time alone must never resend a mutation", 1, posts)
            assertTrue(runCatching { coordinator.finish() }.isFailure)
            assertEquals("A new result check is explicit and only after the deadline", 2, posts)
        } finally { observing.cancelAndJoin() }
    }

    @Test fun `deploy observer sees the exact durable identity before POST and cannot alter acceptance`() = runBlocking {
        savedRaid();val calls=mutableListOf<String>()
        val feedback=object:BattleCommandFeedback {
            override fun notEnqueued(){error("Not refused")}
            override fun enqueued(id:String) {
                val saved=store.get("wallet","deed")!!.writes.single()
                assertEquals(id,saved.id);assertFalse(saved.attempted);calls+="queued:$id"
                throw IllegalStateException("Presentation observer failed")
            }
            override fun refused(id:String){error("Not refused")}
        }
        val coordinator=makeCoordinator { _,body->
            assertEquals(listOf("queued:${body.string("clientCommandId")}"),calls)
            assertTrue(store.get("wallet","deed")!!.writes.single().attempted)
            receipt(body)
        }
        val job=staged(coordinator);coordinator.deploy("archer",1,2,feedback)
        assertTrue(store.get("wallet","deed")!!.writes.isEmpty());assertEquals(1,coordinator.state.value.commands.size)
        job.cancelAndJoin()
    }
    @Test fun `only the existing definitive fresh refusal clears feedback and uncertain retry never does`() = runBlocking {
        for(unknown in listOf(false,true)) {
            savedRaid();val calls=mutableListOf<String>();var posts=0
            val feedback=object:BattleCommandFeedback {
                override fun notEnqueued(){calls+="notQueued"}
                override fun enqueued(id:String){calls+="queued:$id"}
                override fun refused(id:String){assertTrue(store.get("wallet","deed")!!.writes.isEmpty());calls+="refused:$id"}
            }
            val coordinator=makeCoordinator { _,_->posts++;if(unknown&&posts==1)throw IOException("Unknown") else throw ApiException(422,null,"Refused") }
            val job=staged(coordinator)
            assertTrue(runCatching {coordinator.deploy("archer",1,2,feedback)}.isFailure)
            val id=calls.single {it.startsWith("queued:")}.substringAfter(':')
            if(unknown) {
                assertEquals(listOf("queued:$id"),calls)
                assertTrue(runCatching {coordinator.retry(id)}.isFailure)
                assertEquals(listOf("queued:$id"),calls)
                assertTrue(store.get("wallet","deed")!!.writes.single().attempted)
            } else assertEquals(listOf("queued:$id","refused:$id"),calls)
            job.cancelAndJoin()
        }
    }
    @Test fun `only pre-storage command refusal is proven unqueued while uncertain storage gets no false cleanup`() = runBlocking {
        for(storageFailure in listOf(false,true)) {
            savedRaid();val calls=mutableListOf<String>();var posts=0
            val feedback=object:BattleCommandFeedback {
                override fun notEnqueued(){calls+="notQueued"}
                override fun enqueued(id:String){calls+="queued"}
                override fun refused(id:String){calls+="refused"}
            }
            val coordinator=makeCoordinator { _,_->posts++;error("No POST") };val job=staged(coordinator)
            storage.rejectWrites=storageFailure
            assertTrue(runCatching {coordinator.deploy(if(storageFailure)"archer" else "missing",1,2,feedback)}.isFailure)
            assertEquals(if(storageFailure)emptyList<String>() else listOf("notQueued"),calls);assertEquals(0,posts)
            storage.rejectWrites=false;job.cancelAndJoin()
        }
    }

    @Test fun `pending lookup expiry reaches the account owner with the original session and preserves unknown creation`() = runBlocking {
        val token = SessionToken()
        val failure = ApiException(401, null, "expired", session = token)
        val pending = PendingBattle("wallet", "deed", create = PendingBattleWrite("creation", "/campaign/1/raid", jsonBody("idempotencyKey" to "creation"), attempted = true))
        store.put(pending)
        val coordinator = makeCoordinator(beforeGet = { throw failure }) { _, _ -> error("Expiry cannot send an order") }
        assertSame(failure, runCatching { coordinator.runForeground() }.exceptionOrNull())
        assertSame(token, failure.session)
        assertTrue(coordinator.state.value.blocked)
        assertFalse(coordinator.state.value.connected)
        assertEquals(pending, store.get("wallet", "deed"))
    }

    @Test fun `presentation expiry propagates while forbidden access stays blocked without clearing uncertain commands`() = runBlocking {
        val pending = PendingBattle("wallet", "deed", raidId = raid, writes = listOf(
            PendingBattleWrite("deploy", "/raids/$raid/commands", jsonBody("clientCommandId" to "deploy"), attempted = true)))
        for (status in listOf(401, 403)) {
            store.put(pending)
            val failure = ApiException(status, null, "access denied", session = SessionToken())
            val coordinator = BattleCoordinator("wallet", "deed", 14, store,
                { _, _ -> error("Saved raid observes presentation") }, { _, _ -> error("No recovery POST") },
                { flow { throw failure } })
            val result = runCatching { coordinator.runForeground() }
            if (status == 401) assertSame(failure, result.exceptionOrNull()) else assertTrue(result.isSuccess)
            assertTrue(coordinator.state.value.blocked)
            assertFalse(coordinator.state.value.connected)
            assertEquals(pending, store.get("wallet", "deed"))
        }
    }

    @Test fun `coordinator reads presentation and explicit retries cannot borrow a replacement session`() = runBlocking {
        val origin = "https://127.0.0.1:1"
        val api = GameApi(origin, SessionCookieJar(origin.toHttpUrl(), Memory()), "test")
        val original = api.sessionToken()
        val empty = BattleCoordinator("wallet", "deed", 14, store, api, original)
        val pending = PendingBattle("wallet", "deed", raidId = raid, writes = listOf(
            PendingBattleWrite("deploy", "/raids/$raid/commands", jsonBody("clientCommandId" to "deploy"), attempted = true)))
        store.put(pending)
        val saved = BattleCoordinator("wallet", "deed", 14, store, api, original)
        assertSame(original, empty.sessionToken)
        assertSame(original, saved.sessionToken)
        val replacement = api.beginAuthentication()
        withTimeout(2_000) {
            api.withSession(replacement) {
                // All three fail before connecting, including the presentation
                // Flow's dispatcher change and a durable explicit POST retry.
                assertTrue(runCatching { empty.runForeground() }.exceptionOrNull() is SessionSupersededException)
                assertTrue(runCatching { saved.runForeground() }.exceptionOrNull() is SessionSupersededException)
                assertTrue(runCatching { saved.retry("deploy") }.exceptionOrNull() is SessionSupersededException)
            }
        }
        assertEquals(pending, store.get("wallet", "deed"))
        assertSame(replacement, api.sessionToken())
    }

    @Test fun `create identity is durable before POST and an unknown result never triggers another automatic POST`() = runBlocking {
        var posts = 0
        val coordinator = makeCoordinator { path, body ->
            posts++; assertEquals("/campaign/1/raid", path)
            assertEquals(body, store.get("wallet", "deed")!!.create!!.body)
            assertTrue(store.get("wallet", "deed")!!.create!!.attempted)
            throw IOException("lost response")
        }
        assertTrue(runCatching { coordinator.createCampaign(1) }.isFailure)
        assertEquals(1, posts); assertNotNull(store.get("wallet", "deed")!!.create)
        assertFalse(coordinator.state.value.creating)
        val stored = store.get("wallet", "deed")!!.create!!
        lateinit var restored: BattleCoordinator
        restored = makeCoordinator { path, body ->
            assertTrue(restored.state.value.creating)
            posts++; assertEquals(stored.path, path); assertEquals(stored.body, body)
            buildJsonObject { put("raid", buildJsonObject { put("id", raid); put("attackerBaseId", "deed"); put("simVersion", 14); put("raidProtocolVersion", 2) }) }
        }
        restored.retry(stored.id)
        assertEquals(2, posts); assertEquals(raid, store.get("wallet", "deed")!!.raidId)
        assertNull(store.get("wallet", "deed")!!.create)
        assertFalse(restored.state.value.creating)
    }

    @Test fun `a successful create is observed without waiting for a poll cadence`() = runBlocking<Unit> {
        val coordinator = makeCoordinator { _, _ -> buildJsonObject { put("raid", buildJsonObject {
            put("id", raid); put("attackerBaseId", "deed"); put("simVersion", 14); put("raidProtocolVersion", 2)
        }) } }
        val observing = launch { coordinator.runForeground() }
        try {
            coordinator.createCampaign(1)
            pages.send(page())
            // D153.333 (c): the settled create wakes the reader; a 201 is never left waiting on the back-off schedule.
            withTimeout(500) { coordinator.state.first { it.phase == BattlePhase.STAGING } }
        } finally { observing.cancelAndJoin() }
    }

    @Test fun `creation owns navigation before initial reads and releases its guard after a failed preflight`() = runBlocking {
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        var posts = 0
        val coordinator = makeCoordinator(beforeGet = { path ->
            if (path == "/native/capabilities") { entered.complete(Unit); release.await(); throw IOException("preflight unavailable") }
        }) { _, _ -> posts++; error("No post after failed preflight") }
        val creating = async { runCatching { coordinator.createCampaign(1) } }
        entered.await()
        assertTrue(coordinator.state.value.creating)
        assertNull(coordinator.state.value.pending)
        assertTrue(runCatching { coordinator.createCampaign(1) }.isFailure)
        assertTrue(coordinator.state.value.creating) // Rejected caller must not release the owner's guard.
        release.complete(Unit)
        assertTrue(creating.await().isFailure)
        assertFalse(coordinator.state.value.creating)
        assertNull(store.get("wallet", "deed")); assertEquals(0, posts)
    }

    @Test fun `cancelling initial creation reads releases navigation without sending a hidden march`() = runBlocking {
        val entered = CompletableDeferred<Unit>()
        var posts = 0
        val coordinator = makeCoordinator(beforeGet = { entered.complete(Unit); awaitCancellation() }) { _, _ ->
            posts++; error("Cancelled creation cannot post")
        }
        val creating = launch { coordinator.createCampaign(1) }
        entered.await(); assertTrue(coordinator.state.value.creating)
        creating.cancelAndJoin()
        assertFalse(coordinator.state.value.creating)
        assertNull(store.get("wallet", "deed")); assertEquals(0, posts)
    }

    @Test fun `create checks canonical pending raids before foreground recovery can race it`() = runBlocking {
        pendingRaids = listOf(buildJsonObject { put("id", raid); put("attackerBaseId", "deed") })
        var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; error("Cannot create while a march exists") }
        assertTrue(runCatching { coordinator.createCampaign(1) }.isFailure)
        assertEquals(0, posts); assertNull(store.get("wallet", "deed"))
        assertEquals(pendingRaids, coordinator.state.value.candidates)
    }

    @Test fun `failed durable storage prevents a mutation from reaching the server`() = runBlocking {
        storage.rejectWrites = true
        var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; error("No durable identity") }
        assertTrue(runCatching { coordinator.createCampaign(1) }.isFailure)
        assertEquals(0, posts); assertNull(store.get("wallet", "deed"))
    }

    @Test fun `pending deployment reserves immediately and canonical acceptance removes the reservation exactly once`() = runBlocking {
        savedRaid()
        val release = CompletableDeferred<Unit>(); val entered = CompletableDeferred<JsonObject>()
        val coordinator = makeCoordinator { _, body -> entered.complete(body); release.await(); receipt(body) }
        val observer = staged(coordinator)
        val mutation = launch { coordinator.deploy("archer", 3, 4) }
        val body = entered.await()
        assertEquals(1, coordinator.state.value.available("archer")); assertEquals(1, store.get("wallet", "deed")!!.writes.size)
        val command = receipt(body).getValue("command").jsonObject
        pages.send(page(listOf(command)))
        withTimeout(2000) { coordinator.state.first { it.pending!!.writes.isEmpty() } }
        assertEquals(1, coordinator.state.value.available("archer"))
        release.complete(Unit); mutation.join()
        assertEquals(1, coordinator.state.value.commands.size); assertEquals(1, coordinator.state.value.available("archer"))
        observer.cancelAndJoin()
    }

    @Test fun `slow encrypted persistence reserves consecutive taps before disk while every POST uses its durable identity`() = runBlocking {
        savedRaid()
        val entered = CompletableDeferred<Unit>(); val releaseDisk = CountDownLatch(1)
        val firstWrite = AtomicBoolean(true); val posts = AtomicInteger()
        val responses = CompletableDeferred<Unit>()
        storage.beforeWrite = {
            if (firstWrite.compareAndSet(true, false)) {
                entered.complete(Unit)
                check(releaseDisk.await(5, TimeUnit.SECONDS)) { "Test did not release storage" }
            }
        }
        val coordinator = makeCoordinator { _, body ->
            val sequence = posts.getAndIncrement()
            val exact = store.get("wallet", "deed")!!.writes.single { it.id == body.string("clientCommandId") }
            assertTrue(exact.attempted); assertEquals(body, exact.body)
            responses.await(); receipt(body, sequence)
        }
        val observer = staged(coordinator)
        try {
            val first = async { coordinator.deploy("archer", 1, 2) }
            withTimeout(2000) { entered.await() }
            assertEquals(1, coordinator.state.value.available("archer"))
            val second = async(start = CoroutineStart.UNDISPATCHED) { coordinator.deploy("archer", 4, 5) }
            assertEquals("Second tap reserves without waiting on the blocked journal", 0, coordinator.state.value.available("archer"))
            assertEquals(2, coordinator.state.value.preparingWrites.size)
            assertEquals(0, posts.get())
            assertTrue(runCatching { coordinator.deploy("archer", 8, 9) }.isFailure)
            releaseDisk.countDown()
            withTimeout(2000) { coordinator.state.first { it.inFlight.size == 2 } }
            assertEquals(setOf("request-1", "request-2"), coordinator.state.value.pending!!.writes.map { it.id }.toSet())
            responses.complete(Unit); first.await(); second.await()
            assertEquals(2, posts.get()); assertEquals(2, coordinator.state.value.commands.size)
            assertTrue(coordinator.state.value.preparingWrites.isEmpty())
            assertEquals(0, coordinator.state.value.available("archer"))
        } finally { releaseDisk.countDown(); responses.complete(Unit); observer.cancelAndJoin() }
    }

    @Test fun `cancel while waiting for another disk write releases only the never-persisted admission`() = runBlocking {
        savedRaid()
        val entered = CompletableDeferred<Unit>(); val releaseDisk = CountDownLatch(1)
        val firstWrite = AtomicBoolean(true); var posts = 0
        storage.beforeWrite = { if (firstWrite.compareAndSet(true, false)) { entered.complete(Unit); check(releaseDisk.await(5, TimeUnit.SECONDS)) } }
        val coordinator = makeCoordinator { _, body -> posts++; receipt(body) }
        val observer = staged(coordinator)
        try {
            val first = async { coordinator.deploy("archer", 1, 1) }
            withTimeout(2000) { entered.await() }
            var neverQueued = 0
            val feedback = object : BattleCommandFeedback {
                override fun notEnqueued() { neverQueued++ }
                override fun enqueued(id: String) { error("Cancelled admission was never persisted") }
                override fun refused(id: String) { error("No request sent") }
            }
            val second = launch(start = CoroutineStart.UNDISPATCHED) { coordinator.deploy("archer", 2, 2, feedback) }
            assertEquals(0, coordinator.state.value.available("archer"))
            second.cancelAndJoin()
            assertEquals(1, neverQueued); assertEquals(1, coordinator.state.value.available("archer"))
            assertEquals(listOf("request-1"), coordinator.state.value.preparingWrites.map { it.id })
            releaseDisk.countDown(); first.await(); assertEquals(1, posts)
        } finally { releaseDisk.countDown(); observer.cancelAndJoin() }
    }

    @Test fun `account scope cancellation during disk finishes original identity without sending or losing the reservation`() = runBlocking {
        savedRaid()
        val entered = CompletableDeferred<Unit>(); val releaseDisk = CountDownLatch(1)
        var posts = 0
        storage.beforeWrite = { entered.complete(Unit); check(releaseDisk.await(5, TimeUnit.SECONDS)) }
        val coordinator = makeCoordinator { _, _ -> posts++; error("Cancelled account cannot POST") }
        val observer = staged(coordinator)
        try {
            val first = launch { coordinator.deploy("archer", 1, 1) }
            withTimeout(2000) { entered.await() }
            first.cancel(); releaseDisk.countDown(); first.join()
            val durable = store.get("wallet", "deed")!!.writes.single()
            assertEquals("request-1", durable.id); assertFalse(durable.attempted)
            assertEquals(0, posts); assertEquals(1, coordinator.state.value.available("archer"))
            val restored = makeCoordinator { _, _ -> error("GET-only recovery") }
            assertEquals(durable, restored.state.value.pending!!.writes.single())
        } finally { releaseDisk.countDown(); observer.cancelAndJoin() }
    }

    @Test fun `write that commits then reports failure keeps exact admission and blocks more spending until reread`() = runBlocking {
        savedRaid(); var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; error("Ambiguous local storage cannot send") }
        val observer = staged(coordinator)
        storage.afterWrite = { throw IOException("Failure after durable commit") }
        assertTrue(runCatching { coordinator.deploy("archer", 3, 4) }.isFailure)
        val durable = store.get("wallet", "deed")!!.writes.single()
        assertEquals(durable, coordinator.state.value.preparingWrites.single())
        assertTrue(coordinator.state.value.blocked); assertEquals(1, coordinator.state.value.available("archer"))
        assertTrue(runCatching { coordinator.deploy("archer", 5, 6) }.isFailure)
        assertTrue(runCatching { coordinator.retry(durable.id) }.isFailure)
        observer.cancelAndJoin(); storage.afterWrite = {}
        val restored = makeCoordinator { _, _ -> posts++; error("Recovery must be GET only") }
        val recovered = staged(restored)
        assertEquals(durable, restored.state.value.pending!!.writes.single())
        assertEquals(0, posts); assertEquals(1, restored.state.value.available("archer"))
        recovered.cancelAndJoin()
    }

    @Test fun `out of order command receipts and a newer journal page account for each original troop exactly once`() = runBlocking {
        savedRaid()
        val bodies = Channel<JsonObject>(Channel.UNLIMITED)
        val releaseFirst = CompletableDeferred<Unit>(); val releaseSecond = CompletableDeferred<Unit>()
        val coordinator = makeCoordinator { _, body ->
            bodies.send(body)
            val sequence = if (body.string("clientCommandId") == "request-1") 0 else 1
            if (sequence == 0) releaseFirst.await() else releaseSecond.await()
            receipt(body, sequence)
        }
        val observer = staged(coordinator)
        val first = async { coordinator.deploy("archer", 1, 1) }
        val body1 = withTimeout(2000) { bodies.receive() }
        val second = async { coordinator.deploy("archer", 2, 2) }
        val body2 = withTimeout(2000) { bodies.receive() }
        releaseSecond.complete(Unit); second.await()
        assertEquals(0, coordinator.state.value.available("archer"))
        pages.send(page(listOf(receipt(body1, 0).getValue("command").jsonObject, receipt(body2, 1).getValue("command").jsonObject)))
        withTimeout(2000) { coordinator.state.first { it.pending!!.writes.isEmpty() } }
        val writesBeforeDelayedReceipt = storage.writes.get()
        releaseFirst.complete(Unit); first.await()
        assertEquals("Already reconciled receipt performs no redundant encrypted write", writesBeforeDelayedReceipt, storage.writes.get())
        assertEquals(listOf("request-1", "request-2"), coordinator.state.value.commands.map { it.string("clientCommandId") })
        assertEquals(0, coordinator.state.value.available("archer")); observer.cancelAndJoin()
    }

    @Test fun `stale coordinator cannot overwrite replacement intent or another wallet and base`() = runBlocking {
        savedRaid()
        val coordinator = makeCoordinator { _, _ -> error("Stale owner cannot POST") }
        val observer = staged(coordinator)
        val replacement = PendingBattle("wallet", "deed", raidId = "22222222-2222-4222-8222-222222222222")
        val other = PendingBattle("other", "deed", raidId = "other")
        val base = PendingBattle("wallet", "other-deed", raidId = "base")
        store.put(replacement); store.put(other); store.put(base)
        assertTrue(runCatching { coordinator.deploy("archer", 1, 1) }.isFailure)
        assertTrue(coordinator.state.value.blocked)
        assertEquals(replacement, store.get("wallet", "deed"))
        assertEquals(other, store.get("other", "deed")); assertEquals(base, store.get("wallet", "other-deed"))
        observer.cancelAndJoin()
    }

    @Test fun `lost deployment response survives process death and foreground recovery sends reads only`() = runBlocking {
        savedRaid(); var posts = 0
        val first = makeCoordinator { _, _ -> posts++; throw IOException("lost acknowledgement") }
        val observer = staged(first)
        assertTrue(runCatching { first.deploy("archer", 1, 1) }.isFailure)
        observer.cancelAndJoin()
        val exact = store.get("wallet", "deed")!!.writes.single()
        val restored = makeCoordinator { _, _ -> posts++; error("Recovery cannot automatically resend") }
        val recovered = launch { restored.runForeground() }
        pages.send(page(listOf(receipt(exact.body).getValue("command").jsonObject)))
        withTimeout(2000) { restored.state.first { it.presentation != null && it.pending!!.writes.isEmpty() } }
        assertEquals(1, posts); assertEquals(1, restored.state.value.available("archer"))
        recovered.cancelAndJoin()
    }

    @Test fun `only first-attempt rejection releases a reservation while rejected ambiguous retry preserves identity`() = runBlocking {
        savedRaid(); var reject = false
        val coordinator = makeCoordinator { _, _ -> if (reject) throw ApiException(422, "NO_ARMY", "rejected") else throw IOException("uncertain") }
        val observer = staged(coordinator)
        assertTrue(runCatching { coordinator.deploy("archer", 1, 1) }.isFailure)
        val first = store.get("wallet", "deed")!!.writes.single()
        reject = true
        val beforeRetryWrites = storage.writes.get()
        assertTrue(runCatching { coordinator.retry(first.id) }.isFailure)
        assertEquals("Retry reuses the durable attempted marker", beforeRetryWrites, storage.writes.get())
        assertEquals(first, store.get("wallet", "deed")!!.writes.single())
        assertTrue(runCatching { coordinator.deploy("archer", 1, 1) }.isFailure)
        assertEquals(listOf(first), store.get("wallet", "deed")!!.writes)
        assertEquals(1, coordinator.state.value.available("archer"))
        observer.cancelAndJoin()
    }

    @Test fun `stale clock updates canonical state without silently submitting another start`() = runBlocking {
        savedRaid(); var posts = 0
        val canonical = clock(revision = 4, started = true, rate = 2)
        val coordinator = makeCoordinator { path, body ->
            posts++; assertTrue(path.endsWith("/start")); assertEquals("0", body.string("expectedClockRevision"))
            throw ApiException(409, "RAID_CLOCK_STALE", "stale", buildJsonObject { put("clock", canonical) })
        }
        val observer = staged(coordinator)
        assertTrue(runCatching { coordinator.start() }.isFailure)
        assertEquals(1, posts); assertEquals(4L, coordinator.state.value.clock!!.value.revision)
        assertTrue(store.get("wallet", "deed")!!.writes.isEmpty())
        observer.cancelAndJoin()
    }

    @Test fun `canonical terminal result permits home while local timer or retreat intent cannot clear recovery`() = runBlocking {
        savedRaid(); val coordinator = makeCoordinator { _, _ -> throw IOException("lost retreat") }
        val observer = staged(coordinator)
        assertTrue(runCatching { coordinator.home() }.isFailure)
        assertTrue(runCatching { coordinator.retreat() }.isFailure)
        assertNotNull(store.get("wallet", "deed")); assertTrue(runCatching { coordinator.home() }.isFailure)
        pages.send(page(terminal = true))
        observer.join()
        assertEquals(BattlePhase.RESULT, coordinator.state.value.phase)
        coordinator.home(); assertNull(store.get("wallet", "deed"))
    }

    @Test fun `deed loss blocks further writes and retains uncertain intent for canonical recovery`() = runBlocking {
        savedRaid(); var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; throw ApiException(409, "DEED_OWNERSHIP_CHANGED", "transferred") }
        val observer = staged(coordinator)
        assertTrue(runCatching { coordinator.deploy("archer", 0, 0) }.isFailure)
        assertTrue(coordinator.state.value.blocked)
        assertTrue(runCatching { coordinator.start() }.isFailure)
        assertEquals(1, posts); assertNotNull(store.get("wallet", "deed"))
        observer.cancelAndJoin()
    }

    // --- PvP creation (web raidCreateRequest / canChooseNextTarget) ---------------------------------------------

    private fun pvpRaid(defenderBase: String = "enemy") = buildJsonObject { put("raid", buildJsonObject {
        put("id", raid); put("attackerBaseId", "deed"); put("defenderWallet", "DefenderWallet"); put("defenderBaseId", defenderBase); put("simVersion", 14); put("raidProtocolVersion", 2)
    }) }

    @Test fun `find me a target posts the stable automatic match and keeps the defender the server chose`() = runBlocking {
        var sent: Pair<String, JsonObject>? = null
        val coordinator = makeCoordinator { path, body -> sent = path to body; pvpRaid() }
        coordinator.createRaid(RaidCreateTarget.Pvp())
        assertEquals("/raids", sent!!.first)
        assertEquals("""{"attackerBaseId":"deed","idempotencyKey":"request-1","raidProtocolVersion":2}""", sent!!.second.toString())
        val saved = store.get("wallet", "deed")!!
        assertEquals(raid, saved.raidId); assertNull(saved.stage)
        assertEquals("NEXT TARGET excludes the deed the server matched", "enemy", saved.pvpDefenderBaseId)
        assertEquals("DefenderWallet", saved.target!!.defenderWallet)
    }
    @Test fun `revenge names the defender deed and next target excludes one and the two cannot be combined`() = runBlocking<Unit> {
        val bodies = mutableListOf<JsonObject>()
        val coordinator = makeCoordinator { _, body -> bodies += body; pvpRaid() }
        coordinator.createRaid(RaidCreateTarget.Pvp(defenderWallet = "DefenderWallet", defenderBaseId = "enemy", name = "Foe"))
        assertEquals("DefenderWallet", bodies.single().string("defenderWallet")); assertEquals("enemy", bodies.single().string("defenderBaseId")); assertNull(bodies.single().string("excludeBaseId"))
        assertEquals("Foe", store.get("wallet", "deed")!!.target!!.name)
        assertTrue("A second march cannot start over a saved one", runCatching { coordinator.createRaid(RaidCreateTarget.Pvp(excludeBaseId = "enemy")) }.isFailure)
        assertEquals(1, bodies.size)
        store.clear("wallet", "deed", store.get("wallet", "deed")!!)
        val next = makeCoordinator { _, body -> bodies += body; pvpRaid() }
        next.createRaid(RaidCreateTarget.Pvp(excludeBaseId = "enemy"))
        assertEquals("enemy", bodies.last().string("excludeBaseId")); assertNull(bodies.last().string("defenderWallet"))
        assertThrows(IllegalArgumentException::class.java) { RaidCreateTarget.Pvp(defenderWallet = "w", excludeBaseId = "enemy") }
    }
    @Test fun `a definitive first-attempt refusal clears the create intent so TRY AGAIN can name a fresh key`() = runBlocking {
        val coordinator = makeCoordinator { _, _ -> throw ApiException(404, "no_other_targets", "No other target available") }
        val failure = runCatching { coordinator.createRaid(RaidCreateTarget.Pvp(excludeBaseId = "enemy")) }.exceptionOrNull() as ApiException
        assertEquals("no_other_targets", failure.code)
        assertNull("Nothing was charged; nothing is left to recover", store.get("wallet", "deed"))
        assertEquals(BattlePhase.EMPTY, coordinator.state.value.phase)
    }
    @Test fun `next target is offered only for a staged untouched stable PvP march`() = runBlocking {
        store.put(PendingBattle("wallet", "deed", raidId = raid, target = PendingRaidTarget(defenderWallet = "w", defenderBaseId = "enemy")))
        val release = CompletableDeferred<Unit>()
        val coordinator = makeCoordinator { _, body -> release.await(); receipt(body) }
        val observer = staged(coordinator)
        assertTrue(coordinator.state.value.canChooseNextTarget)
        val mutation = launch { coordinator.deploy("archer", 1, 1) }
        withTimeout(2000) { coordinator.state.first { it.pending!!.writes.isNotEmpty() } }
        assertFalse("A reserved deploy makes the entry final", coordinator.state.value.canChooseNextTarget)
        release.complete(Unit); mutation.join()
        assertFalse("An accepted deploy makes the entry final", coordinator.state.value.canChooseNextTarget)
        observer.cancelAndJoin()
    }
    @Test fun `next target is never offered for a campaign stage or once the clock has anchored`() = runBlocking {
        store.put(PendingBattle("wallet", "deed", raidId = raid, stage = 1, target = PendingRaidTarget(defenderBaseId = "enemy")))
        val campaign = makeCoordinator { _, _ -> error("no orders") }
        val observer = staged(campaign)
        assertFalse(campaign.state.value.canChooseNextTarget)
        observer.cancelAndJoin()
        store.clear("wallet", "deed", store.get("wallet", "deed")!!)
        store.put(PendingBattle("wallet", "deed", raidId = raid, target = PendingRaidTarget(defenderBaseId = "enemy")))
        val started = makeCoordinator { _, _ -> error("no orders") }
        val job = launch { started.runForeground() }
        pages.send(page(clock = clock(1, started = true)))
        withTimeout(2000) { started.state.first { it.phase == BattlePhase.RUNNING } }
        assertFalse(started.state.value.canChooseNextTarget)
        job.cancelAndJoin()
    }
    @Test fun `resuming a pending pvp march restores its defender identity from the server row`() = runBlocking {
        val coordinator = makeCoordinator { _, _ -> error("resume reads only") }
        val row = buildJsonObject { put("raid", buildJsonObject { put("id", raid); put("attackerBaseId", "deed"); put("defenderWallet", "w"); put("defenderBaseId", "enemy"); put("simVersion", 14); put("raidProtocolVersion", 2) }) }
        val resumed = BattleCoordinator("wallet", "deed", 14, store, { path, _ -> if (path == "/raids/pending/$raid") row else buildJsonObject { put("raids", JsonArray(emptyList())) } }, { _, _ -> error("no post") }, { pages.receiveAsFlow() })
        resumed.resumeRaid(raid)
        assertEquals("enemy", store.get("wallet", "deed")!!.pvpDefenderBaseId)
        assertNotNull(coordinator)
    }
    @Test fun `an unresolved retreat is the exact request RETRY NEXT TARGET resends`() = runBlocking {
        store.put(PendingBattle("wallet", "deed", raidId = raid, target = PendingRaidTarget(defenderBaseId = "enemy")))
        var posts = 0
        val coordinator = makeCoordinator { _, _ -> posts++; throw IOException("lost retreat acknowledgement") }
        val observer = staged(coordinator)
        assertTrue(runCatching { coordinator.retreat() }.isFailure)
        val retreat = requireNotNull(coordinator.state.value.unresolvedRetreat)
        assertTrue(retreat.body.flag("retreat")); assertFalse(coordinator.state.value.canChooseNextTarget)
        assertTrue(runCatching { coordinator.retry(retreat.id) }.isFailure)
        assertEquals("Only the player's explicit retry resends", 2, posts)
        observer.cancelAndJoin()
    }

    @Test fun `clock uses first page receipt freezes unstarted staging and ignores older control receipts`() {
        val staged = BattleClock.read(clock(), 100)
        assertEquals(0.0, staged.playheadMs(Long.MAX_VALUE), 0.0)
        val live = BattleClock.read(clock(2, true, 2), 1_000_000_000)
        assertEquals(6000.0, live.playheadMs(4_000_000_000), 0.0)
        assertEquals(10000.0, live.playheadMs(99_000_000_000), 0.0)
        assertFalse(BattleClock.read(clock(1, true), 9_000_000_000).newerThan(live))
        assertFalse(BattleClock.read(clock(2, true), 9_000_000_000).newerThan(live))
    }

    @Test fun `saved battle identities remain scoped to wallet and deed and stale clears cannot erase newer intent`() {
        val original = PendingBattle("wallet", "deed", raid)
        store.put(original); store.put(PendingBattle("other", "deed", "other-raid"))
        assertNull(store.get("wallet", "other-deed"))
        val next = original.copy(raidId = "new-raid"); store.put(next)
        assertFalse(store.clear("wallet", "deed", original))
        assertEquals(next, store.get("wallet", "deed")); assertEquals("other-raid", store.get("other", "deed")!!.raidId)
    }
}
