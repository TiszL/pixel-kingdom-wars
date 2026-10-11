package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

private fun candidateQuote(request: BasePurchaseRequest): JsonObject {
    val unsigned = buildJsonObject {
        put("version", 1); put("mode", CandidateExpansionContract.MODE); put("origin", CandidateExpansionContract.ORIGIN)
        put("sourceSha", "a".repeat(40)); put("wallet", WALLET); put("fixtureId", PAID_OTHER); put("request", request.raw)
        put("baseEpoch", buildJsonObject { put("landPaidAt", PAID_LAND); put("deedAssetId", JsonNull) })
        put("offer", buildJsonObject { put("expectedExpansions", request.expectedExpansions); put("fromClaimTiles", 14)
            put("toClaimTiles", 16); put("requiredKeepLevel", 3); put("referencePriceLamports", "150000000"); put("chargedLamports", "0") })
        put("createdAt", PAID_NOW)
    }
    return JsonObject(unsigned + ("quoteHash" to JsonPrimitive(CandidateExpansionContract.digest(unsigned))))
}
private fun candidateState(key: String, quote: JsonObject? = null, status: String = if (quote == null) "unquoted" else "quoted") = buildJsonObject {
    put("version", 1); put("mode", CandidateExpansionContract.MODE); put("wallet", WALLET); put("idempotencyKey", key); put("status", status)
    put("quote", quote ?: JsonNull); put("receipt", if (status != "granted") JsonNull else buildJsonObject {
        put("version", 1); put("mode", CandidateExpansionContract.MODE); put("id", PAID_DEPOSIT); put("wallet", WALLET)
        put("idempotencyKey", key); put("baseId", BASE_ID); put("quoteHash", requireNotNull(quote).getValue("quoteHash"))
        put("fromExpansions", 0); put("toExpansions", 1); put("fromClaimTiles", 14); put("toClaimTiles", 16)
        put("chargedLamports", "0"); put("acceptedAt", PAID_NOW)
    })
}

private class CandidateFixture {
    val holder = testHolder(); val session = AccountSession(WALLET, CandidateExpansionContract.ORIGIN, testToken()).also { holder.replace(it) }
    val memory = MemoryStore(); var failWrite = false; var onWrite: () -> Unit = {}
    val disk = object : SecretStore {
        override fun read() = memory.read()
        override fun clear() { if (failWrite) throw IOException("disk"); memory.clear() }
        override fun write(value: String) { onWrite(); if (failWrite) throw IOException("disk"); memory.write(value) }
    }
    val store = CandidateExpansionStore(disk, WALLET, session.origin)
    var selected: String? = BASE_ID; var enabled = true; var allow = true; var supported = true
    var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1, landPaidAt = PAID_LAND)))
    var row: JsonObject? = null; var expansions = 0; var loseQuote = false; var quoteAbsent = false; var loseConfirm = false; var confirmAbsent = false
    var failRefresh = false; var staleClaim = false; var refreshes = 0; var postHook: () -> Unit = {}; var getHook: () -> Unit = {}
    var transform: (JsonObject) -> JsonObject = { it }; var beforePost: suspend () -> Unit = {}
    val posts = mutableListOf<Pair<String, JsonObject>>(); val gets = mutableListOf<String>()
    val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String,String>): JsonObject {
            gets += path; getHook()
            val raw = when {
                path.endsWith("/capability") -> {
                    if (!supported) throw ApiException(404, null, "unsupported")
                    buildJsonObject { put("version", 1); put("mode", CandidateExpansionContract.MODE); put("enabled", true)
                        put("origin", CandidateExpansionContract.ORIGIN); put("sourceSha", "a".repeat(40)); put("wallet", WALLET); put("baseId", query.getValue("baseId")) }
                }
                path.startsWith(CandidateExpansionRepository.PATH) -> row ?: candidateState(path.substringAfterLast('/'))
                path == "/base" -> { if (failRefresh) throw IOException("refresh offline")
                    JsonObject(paidBase() + mapOf("player" to JsonObject(paidBase().getValue("player").jsonObject + ("expansions" to JsonPrimitive(expansions))),
                        "claim" to buildJsonObject { put("min", 8); put("max", if (expansions > 0 && !staleClaim) 24 else 22) })) }
                path == "/balances" -> balancesJson()
                path == "/tutorial" -> tutorialJson()
                else -> error("Unexpected GET $path")
            }
            return transform(raw)
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            val saved = requireNotNull(store.read()); posts += path to body; beforePost()
            when {
                path.endsWith("/quote") -> {
                    assertEquals(saved.request.raw, body)
                    if (!quoteAbsent) row = candidateState(saved.request.key, candidateQuote(saved.request))
                    postHook(); if (loseQuote) throw IOException("quote reply lost")
                }
                path.endsWith("/confirm") -> {
                    assertEquals(saved.state?.quote?.hash, saved.confirmedHash); assertEquals(saved.confirmedHash, body.getValue("quoteHash").jsonPrimitive.content)
                    if (!confirmAbsent) { row = candidateState(saved.request.key, requireNotNull(saved.state?.quote?.raw), "granted"); expansions = 1 }
                    postHook(); if (loseConfirm) throw IOException("confirm reply lost")
                }
                path.endsWith("/cancel") -> {
                    if (row?.get("status") != JsonPrimitive("granted")) row = candidateState(saved.request.key, saved.state?.quote?.raw, "cancelled")
                }
                else -> error("No payment endpoint permitted: $path")
            }
            return requireNotNull(row)
        }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("no PUT")
        override suspend fun delete(path: String): JsonObject = error("no DELETE")
    }
    fun repository() = CandidateExpansionRepository(session, holder, api, store, enabled, { selected }, { directory }, ::paidCatalogue,
        { allow }, {}, { refreshes++ })
    suspend fun ready(): CandidateExpansionRepository = repository().also { it.open(BASE_ID); it.create(BASE_ID) }
}

class CandidateExpansionTest {
    @Test fun `only explicit exact candidate build can enter test lane`() {
        assertTrue(CandidateExpansionContract.lane(true, CandidateExpansionContract.ORIGIN, "gg.pixelkingdomwars.twa.debug", false))
        for ((flag, origin, app, offline) in listOf(listOf(false, CandidateExpansionContract.ORIGIN, "gg.pixelkingdomwars.twa.debug", false),
            listOf(true, "https://play.pixelkingdomwars.com", "gg.pixelkingdomwars.twa.debug", false),
            listOf(true, CandidateExpansionContract.ORIGIN + "/", "gg.pixelkingdomwars.twa.debug", false),
            listOf(true, CandidateExpansionContract.ORIGIN, "gg.pixelkingdomwars.twa", false),
            listOf(true, CandidateExpansionContract.ORIGIN, "gg.pixelkingdomwars.twa.debug", true))) {
            assertFalse(CandidateExpansionContract.lane(flag as Boolean, origin as String, app as String, offline as Boolean))
        }
    }
    @Test fun `quote digest matches the backend canonical JSON fixture`() {
        val request = BasePurchaseRequest.from(buildJsonObject { put("kind", "expansion"); put("idempotencyKey", PAID_KEY)
            put("baseId", BASE_ID); put("expectedExpansions", 0) })
        // Independently generated with Node crypto and the backend's recursive JSON key sort.
        assertEquals("88bdabef124ab0452b9598f7b12841e5f530697972a2d86d36f81b8645b8462e", CandidateExpansionQuote.from(candidateQuote(request)).hash)
    }
    @Test fun `rapid confirmation taps admit only the original outstanding request`() = runBlocking {
        val f = CandidateFixture(); val r = f.ready(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.beforePost = { entered.complete(Unit); release.await() }
        val first = async { r.confirm() }; entered.await(); r.confirm(); r.cancel(); r.create(BASE_ID)
        assertEquals(2, f.posts.size); release.complete(Unit); first.await(); assertEquals("granted", f.store.read()?.state?.status)
    }
    @Test fun `slow encrypted storage serializes same-wallet reauthentication without sending a retired draft`(): Unit = runBlocking {
        val f = CandidateFixture(); val r = f.repository(); val entered = CountDownLatch(1); val release = CountDownLatch(1)
        f.onWrite = { entered.countDown(); check(release.await(5, TimeUnit.SECONDS)) }
        val old = async { r.create(BASE_ID) }
        try {
            assertTrue(withContext(Dispatchers.IO) { entered.await(5, TimeUnit.SECONDS) })
            val replacement = AccountSession(WALLET, CandidateExpansionContract.ORIGIN, testToken()); f.holder.replace(replacement)
            val newRead = async(Dispatchers.IO) { f.store.access({ f.holder.requireCurrent(replacement) }) { f.store.read() } }
            release.countDown()
            try { old.await(); fail("Retired session must stop") } catch (_: CancellationException) { }
            assertNotNull(newRead.await()?.request); assertTrue(f.posts.isEmpty())
            assertThrows(Exception::class.java) { f.store.draft(requireNotNull(f.store.read()).request) }
        } finally { release.countDown() }
    }
    @Test fun `draft quote and consent are durable before their requests and receipt precedes refresh`() = runBlocking {
        val f = CandidateFixture(); val r = f.ready(); val quote = requireNotNull(f.store.read()?.state?.quote)
        assertEquals(quote.request, f.store.read()?.request); assertNull(f.store.read()?.confirmedHash)
        f.failRefresh = true; r.confirm()
        assertEquals(quote.hash, f.store.read()?.confirmedHash); assertEquals("granted", r.state.value.saved?.state?.status)
        assertNotNull(r.state.value.refreshError); assertFalse(r.state.value.hydrated)
        r.finish(); assertNotNull(f.store.read())
        f.failRefresh = false; r.check(); assertTrue(r.state.value.hydrated); r.finish(); assertNull(f.store.read())
        assertTrue(f.posts.all { it.first.startsWith(CandidateExpansionRepository.PATH) })
    }
    @Test fun `restart after lost quote uses only original GET even when selected base changed`() = runBlocking {
        val f = CandidateFixture(); f.loseQuote = true; f.ready(); val original = requireNotNull(f.store.read()).request
        f.selected = PAID_OTHER; val restored = f.repository(); restored.open(PAID_OTHER)
        assertEquals(original, f.store.read()?.state?.quote?.request); assertEquals(1, f.posts.size)
        restored.confirm(); assertEquals(1, f.posts.size)
        restored.cancel(); assertEquals("cancelled", f.store.read()?.state?.status); restored.finish(); assertNull(f.store.read())
    }
    @Test fun `lost confirm restores receipt without another POST or wallet fallback`() = runBlocking {
        val f = CandidateFixture(); val r = f.ready(); f.loseConfirm = true; r.confirm(); val original = requireNotNull(f.store.read())
        assertNotNull(original.confirmedHash); assertEquals("quoted", original.state?.status)
        val restored = f.repository(); restored.open(BASE_ID); assertEquals("granted", restored.state.value.saved?.state?.status)
        restored.check(); assertEquals(2, f.posts.size); assertTrue(restored.state.value.hydrated)
    }
    @Test fun `receipt remains successful while stale claim geometry blocks journal retirement`() = runBlocking {
        val f = CandidateFixture(); val r = f.ready(); f.staleClaim = true; r.confirm()
        assertEquals("granted", r.state.value.saved?.state?.status); assertFalse(r.state.value.hydrated)
        r.finish(); assertNotNull(f.store.read()); f.staleClaim = false; r.check(); assertTrue(r.state.value.hydrated)
    }
    @Test fun `unaccepted quote and confirmation retry require explicit original action`() = runBlocking {
        val f = CandidateFixture(); f.loseQuote = true; f.quoteAbsent = true; val r = f.ready(); val key = f.store.read()?.request?.key
        r.open(BASE_ID); r.check(); assertEquals(1, f.posts.size)
        f.loseQuote = false; f.quoteAbsent = false; r.retryQuote(); assertEquals(key, f.store.read()?.request?.key)
        f.loseConfirm = true; f.confirmAbsent = true; r.confirm(); r.open(BASE_ID); assertEquals(3, f.posts.size)
        f.loseConfirm = false; f.confirmAbsent = false; r.confirm(); assertEquals("granted", f.store.read()?.state?.status)
        assertEquals(f.posts[2].second, f.posts[3].second)
    }
    @Test fun `storage failure blocks quote and confirmation submission`() = runBlocking {
        val f = CandidateFixture(); val r = f.repository(); f.failWrite = true; r.create(BASE_ID); assertTrue(f.posts.isEmpty())
        f.failWrite = false; r.create(BASE_ID); f.failWrite = true; r.confirm(); assertEquals(1, f.posts.size)
    }
    @Test fun `quote persistence failure retains original draft for GET recovery`() = runBlocking {
        val f = CandidateFixture(); f.postHook = { f.failWrite = true }; val r = f.ready()
        assertNull(f.store.read()?.state); assertEquals(1, f.posts.size)
        f.failWrite = false; r.check(); assertNotNull(f.store.read()?.state?.quote); assertEquals(1, f.posts.size)
    }
    @Test fun `disabled and unsupported lanes never issue payment or quote`() = runBlocking {
        for (enabled in listOf(false, true)) { val f = CandidateFixture(); f.enabled = enabled; f.supported = false
            val r = f.repository(); r.open(BASE_ID); r.create(BASE_ID); assertTrue(f.posts.isEmpty()); assertFalse(r.state.value.available) }
    }
    @Test fun `unknown quoted and granted cancellation preserve terminal truth`() = runBlocking {
        val f = CandidateFixture(); f.loseQuote = true; f.quoteAbsent = true; val r = f.ready(); r.cancel(); r.finish(); assertNull(f.store.read())
        f.loseQuote = false; f.quoteAbsent = false; f.row = null; r.create(BASE_ID); r.confirm(); r.cancel()
        assertEquals("granted", f.store.read()?.state?.status); assertEquals(1, f.expansions)
    }
    @Test fun `changed original epoch or content capability cannot confirm`() = runBlocking {
        val f = CandidateFixture(); val r = f.ready()
        f.directory = BaseDirectory(true, capabilities = BaseCapabilities(true,true), bases = listOf(BaseSummary(BASE_ID,"active",slot=1,landPaidAt=PAID_NOW)))
        r.confirm(); assertEquals(1,f.posts.size)
        f.directory = BaseDirectory(true, capabilities = BaseCapabilities(true,true), bases = listOf(BaseSummary(BASE_ID,"active",slot=1,landPaidAt=PAID_LAND)))
        f.transform = { if ("sourceSha" in it && "enabled" in it) JsonObject(it + ("sourceSha" to JsonPrimitive("b".repeat(40)))) else it }
        r.confirm(); assertEquals(1,f.posts.size)
    }
    @Test fun `dismissal or account replacement during quote preserves draft and cannot publish into new session`() = runBlocking {
        val f = CandidateFixture(); val r = f.repository(); f.postHook = r::dismiss; r.create(BASE_ID)
        assertNull(f.store.read()?.state); assertEquals(1,f.posts.size)
        f.postHook = {}; r.open(BASE_ID); f.getHook = { f.holder.replace(AccountSession(PAID_REFERENCE, CandidateExpansionContract.ORIGIN, testToken())) }
        try { r.confirm() } catch (_: CancellationException) { }
        assertEquals(1,f.posts.size)
    }
    @Test fun `wire rejects payment fields wrong origin hash charges and changed accepted outcomes`(): Unit = runBlocking {
        val f = CandidateFixture(); f.ready(); val raw = requireNotNull(f.store.read()?.state?.raw)
        for (change in listOf("version" to JsonPrimitive(2), "mode" to JsonPrimitive("paid"), "receipt" to buildJsonObject {}, "wallet" to JsonPrimitive(PAID_REFERENCE))) {
            assertThrows(Exception::class.java) { CandidateExpansionState.from(JsonObject(raw + change)) }
        }
        val q = requireNotNull(f.store.read()?.state?.quote?.raw)
        for (change in listOf("quoteHash" to JsonPrimitive("0".repeat(64)), "origin" to JsonPrimitive("https://play.pixelkingdomwars.com"), "txSignature" to JsonPrimitive(PAID_SIGNATURE))) {
            assertThrows(Exception::class.java) { CandidateExpansionQuote.from(JsonObject(q + change)) }
        }
        val granted = CandidateExpansionState.from(candidateState(f.store.read()!!.request.key,q,"granted")); f.store.adopt(granted)
        assertThrows(Exception::class.java) { f.store.adopt(CandidateExpansionState.from(raw)) }
        val receipt = requireNotNull(granted.receipt)
        assertThrows(Exception::class.java) { CandidateExpansionState.from(JsonObject(granted.raw + ("receipt" to JsonObject(receipt + ("chargedLamports" to JsonPrimitive("1")))))) }
    }
}
