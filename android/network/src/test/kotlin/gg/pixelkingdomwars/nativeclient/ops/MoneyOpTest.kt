package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.SessionSupersededException
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The one mechanism every money-changing request rides on. Each test names the invariant it protects. */
class MoneyOpTest {
    private class Fixture(val memory: MemoryStore = MemoryStore()) {
        val store = PendingIntentStore(memory)
        val transport = ScriptedTransport()
        val op = MoneyOp(TrainingBatchSpec, store, transport)
        val hydrated = mutableListOf<TrainingAcceptance>()
        var hydrate: suspend (Receipt.Accepted<TrainingAcceptance>) -> Unit = { hydrated += it.value }
        fun saved() = store.get(IntentKind.TRAINING_BATCH, WALLET)
    }
    private val ack = buildJsonObject { put("costShards", "9007199254740993"); put("replayed", false) }
    private suspend inline fun <reified T : Throwable> fails(noinline action: suspend () -> Unit): T {
        try { action() } catch (error: Throwable) { if (error is T) return error; throw error }
        error("Expected ${T::class.java.simpleName}")
    }

    @Test fun `the exact intent is durable and marked attempted before the POST leaves`() = runBlocking {
        val f = Fixture()
        f.transport.onPost = { path, body ->
            assertEquals(TrainingBatchSpec.PATH, path); assertEquals(trainingBody(), body)
            assertEquals(trainingIntent().nextAttempt(), PendingIntentStore(MemoryStore(f.memory.value)).get(IntentKind.TRAINING_BATCH, WALLET))
            ack
        }
        val accepted = f.op.submit(trainingIntent(), f.hydrate)
        assertEquals("9007199254740993", accepted.value.costShards)
        assertEquals(1, f.transport.posts.size); assertEquals(listOf(accepted.value), f.hydrated)
        assertNull("A hydrated acceptance retires the intent", f.saved())
    }
    @Test fun `definite rejection of a first attempt permits a fresh reviewed quote`() = runBlocking {
        // 402 is the land gate (LAND_NOT_OWNED), raised in the route's preHandler or the base lock before any key is
        // recorded: the owner's Seeker (2026-10-06) kept an uncloseable "Build goldforge" card after exactly this answer.
        for (status in listOf(400, 401, 402, 403, 404, 409, 422, 429)) {
            val f = Fixture(); f.transport.onPost = { _, _ -> throw ApiException(status, null, "Rejected") }
            assertEquals(status, fails<ApiException> { f.op.submit(trainingIntent(), f.hydrate) }.status)
            assertNull(f.saved()); assertTrue(f.hydrated.isEmpty())
        }
    }
    @Test fun `a consented placement refused by the land gate retires on its first attempt`() {
        // Owner's Seeker 2026-10-06: a Gold Forge placed on a deedless base answered 402 LAND_NOT_OWNED from the route's
        // preHandler (before placeBuilding records the key) and left an "Interrupted request · Build goldforge" card with no
        // exit. The consented (modern) placement reads the observed table, so the row must be there, code-matched.
        val placement = PendingIntent(IntentKind.CONSTRUCTION, "wallet", "5d8f4121-59e0-4a6a-8f09-2f6be65cd501", "11111111-1111-4111-8111-111111111111",
            ConstructionSpec.PLACE, buildJsonObject { put("type", "goldforge"); put("tx", 12); put("ty", 9) }, "Build goldforge", expectedCurrency = "KEEP")
        assertTrue(ConstructionSpec.modernBuilder(placement))
        assertTrue(ConstructionSpec.definitiveInitialRejection(placement, ApiException(402, "LAND_NOT_OWNED", "the Gold Forge needs land")))
        assertFalse("another 402 code is not the land gate", ConstructionSpec.definitiveInitialRejection(placement, ApiException(402, "SOMETHING_ELSE", "x")))
        // The legacy (unconsented) placement reads the generic set, which now knows 402 too.
        assertTrue(ConstructionSpec.definitiveInitialRejection(placement.copy(expectedCurrency = null), ApiException(402, "LAND_NOT_OWNED", "land")))
    }
    @Test fun `a timed out or failed first request survives process recreation for receipt recovery`() = runBlocking {
        for (error in listOf(ApiException(408, null, "Timeout"), ApiException(500, null, "Server"), ApiException(503, null, "Busy"), IOException("lost"))) {
            val f = Fixture(); f.transport.onPost = { _, _ -> throw error }
            fails<IOException> { f.op.submit(trainingIntent(), f.hydrate) }
            assertEquals(trainingIntent().nextAttempt(), PendingIntentStore(MemoryStore(f.memory.value)).get(IntentKind.TRAINING_BATCH, WALLET))
        }
    }
    @Test fun `a rejected explicit retry does not erase a possibly accepted original request`() = runBlocking {
        for (status in listOf(401, 403, 409, 422, 500)) {
            val f = Fixture(); f.store.create(trainingIntent().copy(attempted = true))
            f.transport.onPost = { _, _ -> throw ApiException(status, null, "Rejected") }
            fails<ApiException> { f.op.retry(WALLET, f.hydrate) }
            assertEquals(trainingIntent().nextAttempt(), f.saved())
        }
    }
    @Test fun `a malformed acknowledgement keeps the attempted intent for receipt recovery`() = runBlocking {
        val f = Fixture(); f.transport.onPost = { _, _ -> buildJsonObject { put("costShards", "1") } }
        fails<ApiCompatibilityException> { f.op.submit(trainingIntent(), f.hydrate) }
        assertEquals(trainingIntent().nextAttempt(), f.saved()); assertTrue(f.hydrated.isEmpty())
    }
    @Test fun `acceptance is persisted as a receipt before hydration and retired only after it`() = runBlocking {
        val f = Fixture(); f.transport.onPost = { _, _ -> ack }
        f.hydrate = { throw IOException("Home refresh failed") }
        fails<IOException> { f.op.submit(trainingIntent(), f.hydrate) }
        val proven = requireNotNull(f.saved())
        assertTrue(proven.attempted); assertEquals(ReceiptDocument.fromPost(ack), proven.receipt)
        // Recovery: the saved receipt is proof; no GET or POST is needed, hydration is retried.
        f.hydrate = { f.hydrated += it.value }
        val observed = f.op.observe(WALLET, f.hydrate) as Receipt.Accepted
        assertEquals("9007199254740993", observed.value.costShards); assertEquals(1, f.transport.posts.size); assertTrue(f.transport.gets.isEmpty())
        assertNull(f.saved()); assertEquals(1, f.hydrated.size)
    }
    @Test fun `a saved unknown intent blocks new intents of its kind until resolved`() = runBlocking {
        val f = Fixture(); f.transport.onPost = { _, _ -> throw IOException("lost") }
        fails<IOException> { f.op.submit(trainingIntent(), f.hydrate) }
        fails<IllegalStateException> { f.op.submit(trainingIntent(trainingBody(key = "replacement-key")), f.hydrate) }
        assertEquals(1, f.transport.posts.size); assertEquals(trainingIntent().nextAttempt(), f.saved())
    }
    @Test fun `observation is GET only and decodes unknown closed accepted and unsupported`() = runBlocking {
        val attempted = trainingIntent().copy(attempted = true)
        for ((reply, expected) in listOf(trainingReceipt(status = "unknown") to Receipt.Unknown, trainingReceipt(status = "closed") to Receipt.Closed("2026-09-06T12:00:00.000Z"),
            JsonObject(trainingReceipt(status = "unknown") + ("version" to JsonPrimitive(2))) to Receipt.Unsupported)) {
            val f = Fixture(); f.store.create(attempted)
            f.transport.onGet = { path, query -> assertEquals(TrainingBatchSpec.RECEIPT, path); assertEquals(mapOf("idempotencyKey" to "original-receipt"), query); reply }
            assertEquals(expected, f.op.observe(WALLET, f.hydrate))
            assertTrue(f.transport.posts.isEmpty())
            if (expected is Receipt.Closed) assertNull(f.saved()) else assertEquals(attempted, f.saved())
        }
        val f = Fixture(); f.store.create(attempted); f.transport.onGet = { _, _ -> trainingReceipt() }
        val accepted = f.op.observe(WALLET, f.hydrate) as Receipt.Accepted
        assertEquals("9007199254740993", accepted.value.costShards); assertNull(f.saved()); assertEquals(1, f.hydrated.size)
        val old = Fixture(); old.store.create(attempted); old.transport.onGet = { _, _ -> throw ApiException(404, null, "Not found") }
        assertEquals(Receipt.Unsupported, old.op.observe(WALLET, old.hydrate)); assertEquals(attempted, old.saved())
        assertNull("Nothing saved means nothing to observe", Fixture().op.observe(WALLET) {})
    }
    @Test fun `hydration that discovers a superseded session keeps the proof and publishes nothing`() = runBlocking {
        val f = Fixture(); f.store.create(trainingIntent().copy(attempted = true)); f.transport.onGet = { _, _ -> trainingReceipt() }
        f.hydrate = { throw SessionSupersededException() }
        fails<SessionSupersededException> { f.op.observe(WALLET, f.hydrate) }
        val proven = requireNotNull(f.saved()); assertEquals(ReceiptDocument.fromReceiptRoute(trainingReceipt()), proven.receipt)
        assertTrue(f.hydrated.isEmpty())
    }
    @Test fun `a newer saved record cannot be retired by an older reply`() = runBlocking {
        val f = Fixture(); val replacement = trainingIntent(trainingBody(key = "replacement-key")).copy(attempted = true)
        f.transport.onPost = { _, _ ->
            // Another device wrote a newer intent while this reply was in flight.
            assertTrue(f.store.clearIfMatching(trainingIntent().nextAttempt())); assertTrue(f.store.create(replacement)); ack
        }
        fails<IllegalStateException> { f.op.submit(trainingIntent(), f.hydrate) }
        assertEquals(replacement, f.saved()); assertTrue(f.hydrated.isEmpty())
    }
    @Test fun `concurrent taps cannot send a second POST while one is outstanding`() = runBlocking {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.transport.onPost = { _, _ -> entered.complete(Unit); release.await(); ack }
        val first = async { f.op.submit(trainingIntent(), f.hydrate) }; entered.await()
        fails<IllegalStateException> { f.op.submit(trainingIntent(), f.hydrate) }
        fails<IllegalStateException> { f.op.observe(WALLET, f.hydrate) }
        release.complete(Unit); first.await(); assertEquals(1, f.transport.posts.size)
    }
    @Test fun `explicit close uses one POST and recovers a lost close reply with GET only`() = runBlocking {
        for (terminal in listOf("closed", "accepted", "unknown")) {
            val f = Fixture(); f.store.create(trainingIntent().copy(attempted = true)); var reads = 0
            f.transport.onGet = { _, _ -> trainingReceipt(status = if (reads++ == 0) "unknown" else terminal) }
            f.transport.onPost = { path, sent ->
                assertEquals(TrainingBatchSpec.CLOSE, path); assertEquals(buildJsonObject { put("idempotencyKey", "original-receipt"); put("confirmed", true) }, sent)
                throw IOException("lost after server commit")
            }
            val result = f.op.close(WALLET, confirmed = true, f.hydrate)
            assertEquals(1, f.transport.posts.size); assertEquals(2, reads)
            if (terminal == "unknown") { assertEquals(Receipt.Unknown, result); assertNotNull(f.saved()) } else assertNull(f.saved())
        }
    }
    @Test fun `close never refunds an acceptance that won its race and requires confirmation`() = runBlocking {
        val f = Fixture(); f.store.create(trainingIntent().copy(attempted = true))
        f.transport.onGet = { _, _ -> trainingReceipt(status = "unknown") }; f.transport.onPost = { _, _ -> trainingReceipt() }
        assertTrue(f.op.close(WALLET, confirmed = true, f.hydrate) is Receipt.Accepted)
        assertEquals(1, f.transport.posts.size); assertNull(f.saved()); assertEquals(1, f.hydrated.size)
        val denied = Fixture(); denied.store.create(trainingIntent().copy(attempted = true))
        fails<IllegalArgumentException> { denied.op.close(WALLET, confirmed = false, denied.hydrate) }
        assertTrue(denied.transport.gets.isEmpty() && denied.transport.posts.isEmpty())
    }
    @Test fun `revoked session and cancellation preserve the original key without a hidden retry`() = runBlocking {
        val f = Fixture(); f.store.create(trainingIntent().copy(attempted = true)); var calls = 0
        f.transport.onGet = { _, _ -> calls++; throw ApiException(401, null, "Revoked") }
        assertEquals(401, fails<ApiException> { f.op.observe(WALLET, f.hydrate) }.status); assertEquals(1, calls)
        assertEquals(trainingIntent().copy(attempted = true), f.saved())
        val cancelled = Fixture(); cancelled.store.create(trainingIntent().copy(attempted = true))
        cancelled.transport.onGet = { _, _ -> trainingReceipt(status = "unknown") }; cancelled.transport.onPost = { _, _ -> throw CancellationException() }
        fails<CancellationException> { cancelled.op.close(WALLET, confirmed = true, cancelled.hydrate) }
        assertNotNull(cancelled.saved())
    }
    @Test fun `observer retry refuses unknown or mismatched plot geometry before any POST or journal write`() = runBlocking {
        val valid = gg.pixelkingdomwars.nativeclient.model.PlotGeometry.supported(2).json
        val invalid = listOf(JsonObject(valid + ("version" to JsonPrimitive(3))),
            JsonObject(valid + ("min" to JsonPrimitive(-11))), JsonObject(valid + ("max" to JsonPrimitive(41))),
            JsonObject(valid + ("version" to JsonPrimitive("2"))), JsonNull, null)
        for (geometry in invalid) for (attempted in listOf(false,true)) {
            val body = JsonObject(placementBody() + mapOf("tx" to JsonPrimitive(-10),"ty" to JsonPrimitive(39)))
            val saved = placementIntent(body).copy(attempted=attempted,quote=geometry?.let { buildJsonObject { put("plotGeometry",it) } })
            val memory=MemoryStore();val store=PendingIntentStore(memory);store.create(saved)
            val bytes=memory.value;val writes=memory.writes
            val transport=ScriptedTransport();val op=MoneyOp(ConstructionSpec,store,transport)
            val observer=ReceiptObserver(store);observer.register(op) { error("Unsupported geometry cannot hydrate") }
            fails<IllegalArgumentException> { observer.retry(IntentKind.CONSTRUCTION,WALLET) }
            assertTrue(transport.posts.isEmpty());assertTrue(transport.gets.isEmpty())
            assertEquals(bytes,memory.value);assertEquals(writes,memory.writes);assertEquals(0,memory.clears)
            assertEquals(saved,store.get(IntentKind.CONSTRUCTION,WALLET))
            assertEquals(saved,observer.interrupted.value.single().intent)
        }
    }
    @Test fun `valid historical and signed original retries send exactly their saved request without current content`() = runBlocking {
        val plot=gg.pixelkingdomwars.nativeclient.model.PlotGeometry.supported(2)
        val signed=placementIntent(JsonObject(placementBody()+mapOf("tx" to JsonPrimitive(-10),"ty" to JsonPrimitive(39))))
            .copy(quote=buildJsonObject {put("plotGeometry",plot.json)})
        for (original in listOf(placementIntent(),signed)) {
            val saved=original.copy(attempted=true);val store=PendingIntentStore(MemoryStore());store.create(saved)
            val transport=ScriptedTransport(onPost={path,body->
                assertEquals(saved.path,path);assertEquals(saved.body,body)
                assertEquals(saved.idempotencyKey,body.getValue("idempotencyKey").jsonPrimitive.content)
                assertEquals(saved.nextAttempt(),store.get(IntentKind.CONSTRUCTION,WALLET))
                throw IOException("retain original uncertain outcome")
            })
            val observer=ReceiptObserver(store);observer.register(MoneyOp(ConstructionSpec,store,transport)) {}
            fails<IOException> {observer.retry(IntentKind.CONSTRUCTION,WALLET)}
            assertEquals(listOf(saved.path to saved.body),transport.posts)
            assertTrue(transport.gets.isEmpty());assertEquals(saved.nextAttempt(),store.get(IntentKind.CONSTRUCTION,WALLET))
        }
    }
    @Test fun `an unsupported operation without a receipt route reports unsupported and keeps the intent`() = runBlocking {
        val store = PendingIntentStore(MemoryStore()); val transport = ScriptedTransport(); val op = MoneyOp(ConstructionSpec, store, transport)
        val upgrade = placementIntent(buildJsonObject { put("idempotencyKey", "upgrade-key-1"); put("baseId", BASE) }, "/base/buildings/00000000-0000-4000-8000-000000000002/upgrade").copy(attempted = true)
        store.create(upgrade)
        assertEquals(Receipt.Unsupported, op.observe(WALLET) {})
        assertTrue(transport.gets.isEmpty()); assertEquals(upgrade, store.get(IntentKind.CONSTRUCTION, WALLET))
        transport.onPost = { _, _ -> buildJsonObject { put("ok", true) } }
        val retried = op.retry(WALLET) {}
        assertEquals("Build mine", retried.value.label); assertEquals(1, transport.posts.size)
        assertNull(store.get(IntentKind.CONSTRUCTION, WALLET))
    }
}
