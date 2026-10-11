package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.BaseCapabilities
import gg.pixelkingdomwars.nativeclient.model.BaseDirectory
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** These tests exercise user consent and recovery across repository lifetimes, not balance deltas. */
class GemsRepositoryTest {
    private class Fixture(val disk: MemoryStore = MemoryStore()) {
        val holder = testHolder(); val session = signedIn(holder); val api = FakeApiClient()
        val store = PendingIntentStore(disk)
        var base: String? = BASE_ID; var generation = 0L
        var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true),
            bases = listOf(BaseSummary(BASE_ID, "active", slot = 1)))
        var enabled = true; var exactConsent = 1; var keepRate = 2L; var shardRate = 3L; var taskClaimed = false
        var accountRefreshes = 0; var homeRefreshes = 0
        var beforeAccount: suspend () -> Unit = {}
        var afterPost: suspend (PendingIntent) -> Unit = {}
        var receiptFailure: Exception? = null
        var receiptTransform: (JsonObject) -> JsonObject = { it }
        val receipts = mutableMapOf<String, JsonObject>()

        init {
            api.onGet("/native/capabilities") { json("""{"protocolVersion":1,"simVersion":14,"economy":{"gems":{
                "enabled":$enabled,"exactConsent":$exactConsent,"sources":["ledger-keep"],"gemsPerKeep":$keepRate,"shardsPerGem":$shardRate,
                "minConvertKeep":1,"maxConvertKeepPerTx":1000}}}""") }
            api.onGet("/gems") {
                if (!enabled) throw ApiException(503, "PHASE_E_DISABLED", "Gems are paused")
                json("""{"features":{"gems":{"version":1,"receipts":1,"exactConsent":$exactConsent}},"gems":"100","tasks":[
                    {"id":"starter-task","gems":"5","claimed":$taskClaimed}],"sources":["ledger-keep"],
                    "minConvertKeep":1,"maxConvertKeepPerTx":1000,"gemsPerKeep":$keepRate,"shardsPerGem":$shardRate,
                    "serverNow":"2026-09-21T00:00:00Z"}""")
            }
            api.onGet("/balances") {
                json("""{"shards":"300","keep":"100","keepRate":1,"gems":"100",
                    "gemsRate":{"gemsPerKeep":$keepRate,"shardsPerGem":$shardRate},"features":{"gems":{"version":1,"receipts":1}}}""")
            }
            listOf(GemsFromKeepSpec, GemsToShardsSpec, GemsTaskClaimSpec).forEach { spec ->
                val path = when (spec) {
                    GemsFromKeepSpec -> GemsFromKeepSpec.PATH
                    GemsToShardsSpec -> GemsToShardsSpec.PATH
                    else -> "/gems/tasks/starter-task/claim"
                }
                api.onPost(path) { body ->
                    val saved = requireNotNull(store.get(spec.kind, session.wallet))
                    assertTrue("The attempted marker must reach storage before POST", saved.attempted)
                    assertEquals(saved.body, body)
                    assertEquals(saved, PendingIntentStore(MemoryStore(disk.value)).get(spec.kind, session.wallet))
                    bind(saved)
                    receipts[saved.idempotencyKey] = accepted(saved)
                    afterPost(saved)
                    buildJsonObject { put("gems", "20"); put("shards", "30") }
                }
            }
        }

        fun repository() = GemsRepository(session, holder, api, store, ReceiptObserver(store), { base }, { generation }, { directory },
            { beforeAccount(); accountRefreshes++ }, { homeRefreshes++ })

        fun bind(intent: PendingIntent) {
            val request = spec(intent.kind).receiptRequest(intent)
            api.onGet(request.path) { query ->
                assertEquals("Recovery must query the saved destination and amount", request.query, query)
                receiptFailure?.let { throw it }
                receiptTransform(receipts[intent.idempotencyKey] ?: unknown(intent))
            }
        }

        suspend fun review(repository: GemsRepository, kind: String = IntentKind.GEMS_FROM_KEEP): GemsReview {
            repository.review(kind, if (kind == IntentKind.GEMS_TASK_CLAIM) null else "10", if (kind == IntentKind.GEMS_TASK_CLAIM) "starter-task" else null)
            return requireNotNull(repository.state.value.review).also { bind(it.intent) }
        }

        fun accepted(intent: PendingIntent): JsonObject {
            val task = intent.kind == IntentKind.GEMS_TASK_CLAIM
            val fromKeep = intent.kind == IntentKind.GEMS_FROM_KEEP
            val rate = if (fromKeep) keepRate else shardRate
            val proof = buildJsonObject {
                put("version", 1); put("status", "accepted"); put("wallet", intent.wallet)
                put("receiptId", "a7000000-0000-4000-8000-000000000001"); put("acceptedAt", "2026-09-21T00:00:00Z")
                put("request", if (task) JsonObject(intent.body + ("taskId" to JsonPrimitive("starter-task"))) else intent.body)
                if (task) put("taskId", "starter-task")
                else {
                    val amount = intent.body.getValue(if (fromKeep) "keep" else "gems").jsonPrimitive.content
                    put("funding", buildJsonObject { put("currency", if (fromKeep) "KEEP" else "GEMS"); put("amount", amount) })
                }
                if (intent.kind == IntentKind.GEMS_TO_SHARDS) put("baseId", intent.baseId?.let(::JsonPrimitive) ?: JsonNull)
                put("result", buildJsonObject {
                    put(if (intent.kind == IntentKind.GEMS_TO_SHARDS) "shards" else "gems", if (task) "5" else (10L * rate).toString())
                    if (!task) put("rate", rate)
                })
            }
            return if (intent.kind == IntentKind.GEMS_TO_SHARDS) proof else envelope(intent, "accepted", proof)
        }

        fun unknown(intent: PendingIntent) = if (intent.kind == IntentKind.GEMS_TO_SHARDS) buildJsonObject {
            put("version", 1); put("status", "unknown"); put("idempotencyKey", intent.idempotencyKey)
        } else envelope(intent, "unknown", JsonNull)

        private fun envelope(intent: PendingIntent, status: String, proof: JsonElement) = buildJsonObject {
            put("wallet", intent.wallet); put("idempotencyKey", intent.idempotencyKey); put("status", status)
            put("receipt", proof); put("serverNow", "2026-09-21T00:00:00Z")
        }
    }

    @Test fun `each ledger action freezes consent before POST and completes only from its exact receipt`() = runBlocking {
        listOf(IntentKind.GEMS_FROM_KEEP, IntentKind.GEMS_TO_SHARDS, IntentKind.GEMS_TASK_CLAIM).forEach { kind ->
            val f = Fixture(); val repository = f.repository(); val review = f.review(repository, kind)
            if (kind == IntentKind.GEMS_TO_SHARDS) assertEquals(JsonPrimitive(BASE_ID), review.intent.body["baseId"])
            else assertNull(review.intent.baseId)
            assertEquals(buildJsonObject { put("rate", review.rate?.let(::JsonPrimitive) ?: JsonNull); put("output", review.output) }, review.intent.body["expected"])
            repository.confirm(review)
            assertEquals(1, f.api.posts.size); assertNull(f.store.get(kind, WALLET))
            assertEquals(kind, repository.state.value.receipt?.kind)
            assertEquals(if (kind == IntentKind.GEMS_TASK_CLAIM) "5" else if (kind == IntentKind.GEMS_FROM_KEEP) "20" else "30", repository.state.value.receipt?.amount)
            assertTrue(f.accountRefreshes > 0)
            if (kind == IntentKind.GEMS_TO_SHARDS) assertTrue("Home must show the converted SHARDS", f.homeRefreshes > 0)
        }
    }

    @Test fun `a lost POST response survives a new repository and resolves without sending again`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.afterPost = { throw IOException("response lost after commit") }
        refuses { repository.confirm(review) }
        val saved = requireNotNull(f.store.get(review.intent.kind, WALLET))
        assertTrue(saved.attempted); assertNull(saved.receipt)
        val restored = f.repository()
        assertEquals(saved, restored.state.value.pending.single())
        restored.check(saved.kind)
        assertNull(f.store.get(saved.kind, WALLET)); assertNotNull(restored.state.value.receipt)
        assertEquals(1, f.api.posts.size)
    }

    @Test fun `receipt 404 after successful POST cannot erase a potentially accepted request`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.receiptFailure = ApiException(404, null, "receipt temporarily unavailable")
        refuses { repository.confirm(review) }
        assertTrue(requireNotNull(f.store.get(review.intent.kind, WALLET)).attempted)
        assertNull(repository.state.value.receipt)
        f.receiptFailure = null
        f.repository().check(review.intent.kind)
        assertNull(f.store.get(review.intent.kind, WALLET)); assertEquals(1, f.api.posts.size)
    }

    @Test fun `failed hydration retains durable proof and restart refreshes without another receipt request or POST`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.afterPost = { f.beforeAccount = { throw IOException("account refresh offline") } }
        refuses { repository.confirm(review) }
        assertNotNull(f.store.get(review.intent.kind, WALLET)?.receipt)
        val reads = f.api.gets.count { it.first.contains("by-key") }
        f.beforeAccount = {}
        f.repository().check(review.intent.kind)
        assertNull(f.store.get(review.intent.kind, WALLET)); assertEquals(1, f.api.posts.size)
        assertEquals(reads, f.api.gets.count { it.first.contains("by-key") })
    }

    @Test fun `base A to B to A invalidates old conversion consent even though the ID matches`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository, IntentKind.GEMS_TO_SHARDS)
        f.generation += 2
        refuses { repository.confirm(review) }
        assertTrue(f.api.posts.isEmpty()); assertNull(f.store.get(review.intent.kind, WALLET))
    }

    @Test fun `a selection generation change while account refreshes prevents stale review publication`() = runBlocking {
        val f = Fixture(); val repository = f.repository()
        f.beforeAccount = { f.generation += 2 }
        refuses { f.review(repository, IntentKind.GEMS_TO_SHARDS) }
        assertNull(repository.state.value.review); assertTrue(f.api.posts.isEmpty())
    }

    @Test fun `paused Gems keeps saved acceptance recoverable without requiring the live overview`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.afterPost = { throw IOException("lost response") }
        refuses { repository.confirm(review) }
        f.enabled = false
        val restored = f.repository()
        assertEquals(review.intent.idempotencyKey, restored.state.value.pending.single().idempotencyKey)
        restored.check(review.intent.kind)
        assertNotNull(restored.state.value.receipt); assertNull(f.store.get(review.intent.kind, WALLET))
        refuses { f.review(restored) }
        assertEquals(1, f.api.posts.size)
    }

    @Test fun `unknown recovery never posts automatically and explicit retry reuses the exact key body and base`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository, IntentKind.GEMS_TO_SHARDS)
        f.afterPost = { f.receipts.clear(); throw IOException("delivery unknown") }
        refuses { repository.confirm(review) }
        val restored = f.repository()
        restored.check(review.intent.kind)
        assertEquals(1, f.api.posts.size); assertNotNull(f.store.get(review.intent.kind, WALLET))
        refuses { f.review(restored, IntentKind.GEMS_TO_SHARDS) }
        f.afterPost = {}
        restored.retry(review.intent.kind)
        assertEquals(listOf(review.intent.path to review.intent.body, review.intent.path to review.intent.body), f.api.posts)
        assertNull(f.store.get(review.intent.kind, WALLET))
    }

    @Test fun `a changed server conversion rate requires new consent before money leaves`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.keepRate = 4
        refuses { repository.confirm(review) }
        assertTrue(f.api.posts.isEmpty()); assertNull(f.store.get(review.intent.kind, WALLET))
    }

    @Test fun `a restart cannot retry an uncertain purchase at a worse rate than the durable consent`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.afterPost = { f.receipts.clear(); throw IOException("delivery unknown") }
        refuses { repository.confirm(review) }
        val saved = requireNotNull(f.store.get(review.intent.kind, WALLET))
        f.keepRate = 1
        f.afterPost = {}
        val restored = f.repository()
        refuses { restored.retry(review.intent.kind) }
        assertEquals("Changed rates require fresh consent without replacing the original key", saved, f.store.get(review.intent.kind, WALLET))
        assertEquals(1, f.api.posts.size)
        assertNull(restored.state.value.receipt)
    }

    @Test fun `a different wallet receipt never proves the saved request despite a successful POST`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.receiptTransform = { raw -> JsonObject(raw + ("wallet" to JsonPrimitive("another-wallet"))) }
        refuses { repository.confirm(review) }
        assertNull(repository.state.value.receipt); assertNull(f.store.get(review.intent.kind, WALLET)?.receipt)
        assertTrue(requireNotNull(f.store.get(review.intent.kind, WALLET)).attempted)
    }

    @Test fun `same-wallet reauthentication cannot publish an older request result`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.afterPost = { signedIn(f.holder, WALLET) }
        refuses { repository.confirm(review) }
        assertNull(repository.state.value.receipt); assertNotNull(f.store.get(review.intent.kind, WALLET))
    }

    @Test fun `multibase without a selected deed refuses SHARDS conversion but permits wallet tasks and Gems purchase`() = runBlocking {
        val f = Fixture(); f.base = null; val repository = f.repository()
        refuses { f.review(repository, IntentKind.GEMS_TO_SHARDS) }
        assertTrue(f.api.posts.isEmpty())
        listOf(IntentKind.GEMS_FROM_KEEP, IntentKind.GEMS_TASK_CLAIM).forEach { kind ->
            repository.confirm(f.review(repository, kind))
            assertNull(f.api.posts.last().second["baseId"])
        }
        assertEquals(2, f.api.posts.size)
    }

    @Test fun `malformed durable storage blocks opening and cannot be replaced by a fresh operation`() {
        val f = Fixture(MemoryStore("{not-json"))
        assertThrows(Exception::class.java) { f.repository() }
        assertEquals("{not-json", f.disk.value); assertTrue(f.api.posts.isEmpty())
    }
    @Test fun `an older server cannot accept a newly reviewed request without atomic quote support`() = runBlocking {
        val f = Fixture(); f.exactConsent = 0
        refuses { f.review(f.repository()) }
        assertTrue(f.api.posts.isEmpty()); assertTrue(f.store.all(WALLET).isEmpty())
    }
    @Test fun `a legacy journal with only local consent is readable but cannot resend an unguarded body`() = runBlocking {
        val f = Fixture(); val review = f.review(f.repository())
        val legacy = review.intent.copy(body = JsonObject(review.intent.body - "expected"), attempted = true)
        f.store.create(legacy); f.bind(legacy)
        val restored = f.repository(); refuses { restored.retry(legacy.kind) }
        assertTrue(f.api.posts.isEmpty()); assertEquals(legacy, f.store.get(legacy.kind, WALLET))
        f.enabled = false; f.receipts[legacy.idempotencyKey] = f.accepted(legacy)
        restored.check(legacy.kind)
        assertNotNull(restored.state.value.receipt); assertNull(f.store.get(legacy.kind, WALLET))
    }
    @Test fun `arithmetic valid but differently priced proof cannot finish the guarded request`() = runBlocking {
        val f = Fixture(); val repository = f.repository(); val review = f.review(repository)
        f.afterPost = { saved -> f.keepRate = 3; f.receipts[saved.idempotencyKey] = f.accepted(saved) }
        refuses { repository.confirm(review) }
        assertEquals(1, f.api.posts.size); assertNull(repository.state.value.receipt)
        assertNotNull(f.store.get(review.intent.kind, WALLET)); assertNull(f.store.get(review.intent.kind, WALLET)?.receipt)
    }

    private companion object {
        fun spec(kind: String): GemsSpec = when (kind) {
            IntentKind.GEMS_FROM_KEEP -> GemsFromKeepSpec
            IntentKind.GEMS_TO_SHARDS -> GemsToShardsSpec
            IntentKind.GEMS_TASK_CLAIM -> GemsTaskClaimSpec
            else -> error("Unexpected Gems intent")
        }
        suspend fun refuses(action: suspend () -> Unit) {
            try { action(); fail("The changed or uncertain request must not complete") } catch (_: Exception) {}
        }
    }
}
