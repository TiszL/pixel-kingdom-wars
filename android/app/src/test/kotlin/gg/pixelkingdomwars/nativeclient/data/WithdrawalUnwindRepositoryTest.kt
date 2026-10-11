package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

internal class WithdrawalUnwindFixture(val disk: MemoryStore = MemoryStore(), val failWrite: (String) -> Boolean = { false }) {
    val id = "00000000-0000-4000-8000-000000000001"
    val holder = testHolder(); val session = signedIn(holder)
    val store = PendingIntentStore(object : SecretStore {
        override fun read() = disk.read()
        override fun write(value: String) { if (failWrite(value)) throw IOException("disk refused"); disk.write(value) }
        override fun clear() = disk.clear()
    })
    val observer = ReceiptObserver(store)
    var base: String? = BASE_ID; var supported = true; var missing = false
    var status = "unbonding"; var refundable = false; var amount = "100"
    var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1), BaseSummary(CLAN_OTHER, "active", slot = 2)))
    var balance: JsonObject = balancesJson(keep = "900")
    var beforeGet: suspend (String) -> Unit = {}; var onAccount: suspend () -> Unit = {}
    val gets = mutableListOf<Pair<String, Map<String, String>>>(); val posts = mutableListOf<Pair<String, JsonObject>>()
    fun row() = buildJsonObject {
        put("id", id); put("status", status); put("amount", amount); put("feeBurned", "10"); put("netAmount", "90")
        put("destination", WALLET); put("createdAt", "2026-09-12T00:00:00Z"); put("unbondsAt", "2026-09-13T00:00:00Z")
        put("completedAt", if (status in setOf("cancelled", "refunded", "sent")) JsonPrimitive("2026-09-13T01:00:00Z") else JsonNull)
        put("txSignature", if (status == "sent") JsonPrimitive("1".repeat(88)) else JsonNull); put("mint", JsonNull); put("refundable", refundable)
    }
    fun history() = buildJsonObject {
        if (supported) put("features", buildJsonObject { put("withdrawalReceipts", buildJsonObject { put("version", 1) }) })
        put("withdrawals", JsonArray(if (missing) emptyList() else listOf(row())))
    }
    fun accept(action: WithdrawalUnwindAction): JsonObject {
        status = action.terminal
        return buildJsonObject { put("id", id); put("status", status); if (action == WithdrawalUnwindAction.REFUND) put("amount", amount) }
    }
    var postHandler: suspend (String, JsonObject) -> JsonObject = { path, body ->
        val i = requireNotNull(saved()); assertTrue(i.attempted); assertEquals(i.path, path); assertEquals(i.body, body)
        assertEquals(i, PendingIntentStore(MemoryStore(disk.value)).get(IntentKind.WITHDRAWAL_UNWIND, WALLET))
        accept(WithdrawalUnwindSpec.consent(i).first)
    }
    val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject {
            gets += path to query; beforeGet(path)
            return when (path) { "/withdrawals" -> history(); "/balances" -> balance; else -> error("Unexpected GET $path") }
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject { posts += path to body; return postHandler(path, body) }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT")
        override suspend fun delete(path: String): JsonObject = error("No DELETE")
    }
    val repo = WithdrawalUnwindRepository(session, holder, api, store, observer, { base }, { directory }, { onAccount() })
    fun saved() = store.get(IntentKind.WITHDRAWAL_UNWIND, WALLET)
    fun create(action: WithdrawalUnwindAction = WithdrawalUnwindAction.CANCEL, scope: String? = BASE_ID) =
        WithdrawalUnwindSpec.intent(WALLET, scope, action, WithdrawalUnwindTarget.from(row())).also { check(store.create(it)) }
    suspend fun unwind(action: WithdrawalUnwindAction = WithdrawalUnwindAction.CANCEL) {
        repo.review(id, action); repo.confirm(requireNotNull(repo.state.value.review))
    }
}

class WithdrawalUnwindRepositoryTest {
    @Test fun `cancellation and safe refund persist original row before one POST and hydrate wallet KEEP`() = runBlocking {
        for (action in WithdrawalUnwindAction.entries) {
            val f = WithdrawalUnwindFixture(); if (action == WithdrawalUnwindAction.REFUND) { f.status = "failed"; f.refundable = true }
            f.unwind(action); assertEquals(listOf("/withdrawals/${f.id}/${action.route}" to buildJsonObject {}), f.posts)
            assertNull(f.saved()); assertEquals(action.terminal, f.repo.state.value.outcome!!.status)
            assertEquals("100", f.repo.state.value.outcome!!.target.gross); assertEquals("900", f.repo.state.value.keepBalance)
            assertEquals(listOf(mapOf("baseId" to BASE_ID)), f.gets.filter { it.first == "/balances" }.map { it.second })
        }
    }
    @Test fun `lost response restart and repeated foreground do not resend or create new consent`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.unwind() } }; assertTrue(f.saved()!!.attempted)
        val restored = WithdrawalUnwindFixture(f.disk); repeat(3) { restored.repo.refresh() }
        assertEquals(f.saved(), restored.saved()); assertTrue(restored.posts.isEmpty()); assertNull(restored.repo.state.value.review)
        assertThrows(IllegalStateException::class.java) { runBlocking { restored.unwind() } }; assertNotNull(restored.saved())
    }
    @Test fun `explicit retry reuses original row action and A balance after selected B`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.unwind() } }
        val saved = f.saved()!!; val restored = WithdrawalUnwindFixture(f.disk); restored.base = CLAN_OTHER; restored.repo.retry()
        assertEquals(f.posts.single(), restored.posts.single()); assertEquals("${f.id}:cancel", saved.idempotencyKey)
        assertNull(restored.saved()); assertEquals(BASE_ID, restored.repo.state.value.outcome!!.baseId)
        assertEquals(mapOf("baseId" to BASE_ID), restored.gets.single { it.first == "/balances" }.second)
    }
    @Test fun `fresh definitive refusal retires only its first attempted action`() = runBlocking {
        for (code in listOf(400, 401, 403, 404, 409, 422, 429)) {
            val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> throw ApiException(code, null, "refused") }
            assertThrows(ApiException::class.java) { runBlocking { f.unwind() } }; assertNull(f.saved()); assertNull(f.repo.state.value.outcome)
        }
    }
    @Test fun `HTTP refusal after earlier uncertainty cannot disprove original compensation`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.unwind() } }; var expected = requireNotNull(f.saved())
        for (code in listOf(404, 409, 422, 429, 500)) {
            f.postHandler = { _, _ -> throw ApiException(code, null, "refused") }
            assertThrows(ApiException::class.java) { runBlocking { f.repo.retry() } }; expected = expected.nextAttempt(); assertEquals(expected, f.saved())
        }
    }
    @Test fun `server failure and timeout retain attempted original request`() = runBlocking {
        for (code in listOf(408, 500, 503)) {
            val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> throw ApiException(code, null, "uncertain") }
            assertThrows(ApiException::class.java) { runBlocking { f.unwind() } }; assertTrue(f.saved()!!.attempted)
        }
    }
    @Test fun `success followed by malformed acknowledgement or history failure remains held`() = runBlocking {
        for (case in 0..2) {
            val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ ->
                val ack = f.accept(WithdrawalUnwindAction.CANCEL)
                if (case == 0) buildJsonObject {} else {
                    f.beforeGet = { if (it == "/withdrawals") { if (case == 1) throw ApiException(404, null, "gone") else throw IOException("offline") } }; ack
                }
            }
            assertThrows(IOException::class.java) { runBlocking { f.unwind() } }; assertNotNull(f.saved()); assertNull(f.repo.state.value.outcome)
            f.beforeGet = {}; f.repo.refresh(); assertNull(f.saved()); assertEquals("cancelled", f.repo.state.value.outcome!!.status); assertEquals(1, f.posts.size)
        }
    }
    @Test fun `terminal GET after lost response resolves without another POST`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> f.accept(WithdrawalUnwindAction.CANCEL); throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.unwind() } }; f.repo.retry()
        assertNull(f.saved()); assertEquals(1, f.posts.size); assertTrue(f.repo.state.value.outcome!!.returnedToWallet)
    }
    @Test fun `concurrent sent payout ends cancellation recovery without reporting returned funds`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.create(); f.status = "sent"; f.repo.retry()
        assertNull(f.saved()); assertTrue(f.posts.isEmpty()); assertEquals("sent", f.repo.state.value.outcome!!.status)
        assertFalse(f.repo.state.value.outcome!!.returnedToWallet)
    }
    @Test fun `unsupported or missing history preserves original uncertainty and blocks submission`() = runBlocking {
        for (unsupported in listOf(true, false)) {
            val f = WithdrawalUnwindFixture(); val original = f.create(); f.supported = !unsupported; f.missing = !unsupported
            if (unsupported) f.repo.retry() else assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.retry() } }
            assertEquals(original, f.saved()); assertTrue(f.posts.isEmpty()); assertNull(f.repo.state.value.outcome)
        }
    }
    @Test fun `mutable failure and processing are neither refund proof nor retry permission`() = runBlocking {
        for (status in listOf("processing", "failed")) {
            val f = WithdrawalUnwindFixture(); f.create(); f.status = status; f.refundable = false
            assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.retry() } }; assertNotNull(f.saved()); assertTrue(f.posts.isEmpty())
            assertNull(f.repo.state.value.outcome)
        }
    }
    @Test fun `preflight status or immutable amount changes invalidate review before saving`() = runBlocking {
        for (facts in listOf(true, false)) {
            val f = WithdrawalUnwindFixture(); f.repo.review(f.id, WithdrawalUnwindAction.CANCEL); val review = f.repo.state.value.review!!
            if (facts) f.amount = "101" else f.status = "processing"
            assertThrows(Exception::class.java) { runBlocking { f.repo.confirm(review) } }; assertNull(f.saved()); assertTrue(f.posts.isEmpty())
        }
    }
    @Test fun `base change and Back revoke displayed consent before persistence`() = runBlocking {
        for (back in listOf(true, false)) {
            val f = WithdrawalUnwindFixture(); f.repo.review(f.id, WithdrawalUnwindAction.CANCEL); val review = f.repo.state.value.review!!
            if (back) f.repo.dismiss() else f.base = CLAN_OTHER
            assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.confirm(review) } }; assertNull(f.saved()); assertTrue(f.posts.isEmpty())
        }
    }
    @Test fun `creation and attempted marker storage failure cannot send compensation`() = runBlocking {
        for (attemptOnly in listOf(false, true)) {
            val f = WithdrawalUnwindFixture(failWrite = { !attemptOnly || it.contains("\"attempted\":true") })
            assertThrows(IOException::class.java) { runBlocking { f.unwind() } }; assertTrue(f.posts.isEmpty())
        }
    }
    @Test fun `receipt write failure retains original key then GET recovers coupled terminal row`() = runBlocking {
        var fail = true; val f = WithdrawalUnwindFixture(failWrite = { fail && it.contains("\"receipt\":{") })
        assertThrows(IOException::class.java) { runBlocking { f.unwind() } }; assertNull(f.saved()!!.receipt)
        fail = false; f.repo.refresh(); assertNull(f.saved()); assertEquals(1, f.posts.size)
    }
    @Test fun `failed balance hydration preserves terminal proof across process death`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.beforeGet = { if (it == "/balances") throw IOException("offline") }
        assertThrows(IOException::class.java) { runBlocking { f.unwind() } }; assertNotNull(f.saved()!!.receipt); assertNull(f.repo.state.value.outcome)
        val restored = WithdrawalUnwindFixture(f.disk); restored.status = "cancelled"; restored.repo.refresh()
        assertNull(restored.saved()); assertTrue(restored.posts.isEmpty()); assertEquals("900", restored.repo.state.value.keepBalance)
    }
    @Test fun `noncanonical balance is rejected without retiring the confirmed terminal proof`() = runBlocking {
        for (value in listOf(JsonPrimitive(900), JsonPrimitive("9e2"), JsonPrimitive("9223372036854775808"))) {
            val f = WithdrawalUnwindFixture(); f.balance = JsonObject(f.balance + ("keep" to value))
            assertThrows(Exception::class.java) { runBlocking { f.unwind() } }; assertNotNull(f.saved()!!.receipt); assertNull(f.repo.state.value.keepBalance)
        }
    }
    @Test fun `lost original deed or mode change never hydrates selected B or on-chain balances`() = runBlocking {
        for (case in 0..2) {
            val f = WithdrawalUnwindFixture(); f.create(scope = if (case == 2) null else BASE_ID); f.status = "cancelled"; f.base = CLAN_OTHER
            if (case != 2) f.directory = f.directory!!.copy(bases = listOf(BaseSummary(CLAN_OTHER, "active", slot = 2)) + if (case == 0) listOf(BaseSummary(BASE_ID, "inactive", slot = 1)) else emptyList())
            f.repo.refresh(); assertNull(f.saved()); assertTrue(f.repo.state.value.balanceUnavailable); assertNull(f.repo.state.value.keepBalance)
            assertFalse(f.gets.any { it.first == "/balances" || it.first == "/wallet/balances" })
        }
    }
    @Test fun `landless legacy wallet can recover its own escrow`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.base = null; f.directory = BaseDirectory(false); f.unwind()
        assertNull(f.saved()); assertEquals("900", f.repo.state.value.keepBalance)
        assertTrue(f.gets.single { it.first == "/balances" }.second.isEmpty())
    }
    @Test fun `generic observer retry cannot bypass explicit original withdrawal consent`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.create()
        assertThrows(IllegalStateException::class.java) { runBlocking { f.observer.retry(IntentKind.WITHDRAWAL_UNWIND, WALLET) } }
        assertTrue(f.posts.isEmpty()); assertNotNull(f.saved())
    }
    @Test fun `identity replacement during POST cannot publish or retire old wallet intent`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.postHandler = { _, _ -> f.accept(WithdrawalUnwindAction.CANCEL).also { signedIn(f.holder, CLAN_MEMBER) } }
        assertThrows(CancellationException::class.java) { runBlocking { f.unwind() } }; assertNotNull(f.saved()); assertNull(f.repo.state.value.outcome)
    }
    @Test fun `directory changes during hydration retain proof instead of claiming a fresh balance`() = runBlocking {
        val f = WithdrawalUnwindFixture(); f.beforeGet = { if (it == "/balances") f.directory = BaseDirectory(false) }
        assertThrows(IllegalStateException::class.java) { runBlocking { f.unwind() } }; assertNotNull(f.saved()!!.receipt); assertNull(f.repo.state.value.outcome)
    }
}
