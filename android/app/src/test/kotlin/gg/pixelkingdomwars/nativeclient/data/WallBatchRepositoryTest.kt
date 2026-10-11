package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ops.*
import gg.pixelkingdomwars.nativeclient.renderer.WallStrokeTile
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.UUID

internal class WallBatchFixture(val disk: MemoryStore = MemoryStore(), val failWrite: (String) -> Boolean = { false }) {
    val holder = testHolder(); val session = signedIn(holder)
    val store = PendingIntentStore(object : SecretStore {
        override fun read() = disk.read()
        override fun write(value: String) { if (failWrite(value)) throw IOException("disk refused"); disk.write(value) }
        override fun clear() = disk.clear()
    })
    val observer = ReceiptObserver(store); var base: String? = BASE_ID
    var supported = true; var enabled = true; var allowed = true; var shards = "1000"; var refreshed = 0
    var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1), BaseSummary(CLAN_OTHER, "active", slot = 2)))
    var catalogue = json("""{"constants":{"GRID":{"plotTiles":30},"BUILD_COSTS":{"wall":{"costShards":37,"buildSec":0}},"BUILD_COUNT_CAP_BY_KEEP":{"wall":[5]},"STRUCTURES":{"wall":{"footprint":[1,1]}},"BUILDING_GEOMETRY":{"legacyVersion":1,"keepFootprintByVersion":{"1":[4,4]}}}}""")
    var render: JsonObject? = null; var snapshot = baseJson()
    var onAccount: suspend () -> Unit = {}; var beforeGet: suspend (String) -> Unit = {}
    var transform: (String, JsonObject) -> JsonObject = { _, raw -> raw }
    val gets = mutableListOf<Pair<String, Map<String, String>>>(); val posts = mutableListOf<Pair<String, JsonObject>>()
    val receipts = mutableMapOf<String, JsonObject>()
    var postHandler: suspend (String, JsonObject) -> JsonObject = { _, body ->
        val saved = saved()!!; assertTrue(saved.attempted); assertEquals(body, saved.body)
        assertEquals(saved, PendingIntentStore(MemoryStore(disk.value)).get(IntentKind.WALL_BATCH, WALLET))
        proof(saved).also { receipts[saved.idempotencyKey] = it }
    }
    val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject {
            gets += path to query; beforeGet(path)
            return transform(path, when {
                path.startsWith("/base/walls/batch/v1/") -> {
                    if (!supported) throw ApiException(404, null, "unsupported")
                    val key = path.substringAfterLast('/')
                    buildJsonObject { put("version", 1); put("wallet", WALLET); put("idempotencyKey", key); put("enabled", enabled); put("receipt", receipts[key] ?: JsonNull) }
                }
                path == "/base" -> snapshot
                path == "/balances" -> balancesJson(shards = shards)
                else -> error("Unexpected GET $path")
            })
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject { posts += path to body; return postHandler(path, body) }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT")
        override suspend fun delete(path: String): JsonObject = error("No DELETE")
    }
    val repo = WallBatchRepository(session, holder, api, store, observer, { base }, { directory }, { onAccount() }, { catalogue }, { render }, { allowed }, { refreshed++ }, "devnet")
    fun saved() = store.get(IntentKind.WALL_BATCH, WALLET)
    fun proof(i: PendingIntent) = json("""{"version":1,"actor":"$WALLET","idempotencyKey":"${i.idempotencyKey}","request":${i.body},"receiptId":"${i.idempotencyKey}","acceptedAt":"2026-09-13T00:00:00.000Z","funding":{"currency":"SHARDS","amount":${i.body["maxCostShards"]}}}""")
    val tiles = listOf(WallStrokeTile(8, 8), WallStrokeTile(11, 8))
    suspend fun build(tiles: List<WallStrokeTile> = this.tiles) { repo.prepare(); repo.release(repo.state.value.drawing!!.mode.token, tiles) }
    fun create(): PendingIntent {
        val terms = WallBatchTerms.from(catalogue)
        val request = WallBatchRequest(UUID.randomUUID().toString(), base, tiles.map { WallBatchTile(it.tx, it.ty) }, terms.cost(tiles.size))
        return WallBatchSpec("devnet").intent(WALLET, request, terms).also { check(store.create(it)) }
    }
}

class WallBatchRepositoryTest {
    @Test fun `dismissed resolved wall receipt stays hidden through unrelated state and receipt refreshes`() = runBlocking {
        val f = WallBatchFixture(); f.build()
        val receipt = f.repo.state.value.receipt!!
        assertTrue(f.repo.state.value.historyVisible)
        f.repo.dismissReceipt(receipt.receiptId)
        assertFalse(f.repo.state.value.historyVisible)
        assertEquals(receipt, f.repo.state.value.receipt)
        val disk = f.disk.value
        f.repo.dismiss(); f.base = CLAN_OTHER; f.repo.refresh(); f.observer.refresh(WALLET)
        assertFalse(f.repo.state.value.historyVisible)
        assertEquals(receipt, f.repo.state.value.receipt)
        assertEquals(disk, f.disk.value); assertEquals(1, f.posts.size)
    }
    @Test fun `a new accepted batch is visible and an old close callback cannot hide it`() = runBlocking {
        val f = WallBatchFixture(); f.build(); val first = f.repo.state.value.receipt!!
        f.repo.dismissReceipt(first.receiptId); f.build(); val second = f.repo.state.value.receipt!!
        assertNotEquals(first.receiptId, second.receiptId)
        assertTrue(f.repo.state.value.historyVisible)
        f.repo.dismissReceipt(first.receiptId)
        assertTrue(f.repo.state.value.historyVisible)
        f.repo.dismissReceipt(second.receiptId)
        assertFalse(f.repo.state.value.historyVisible); assertEquals(2, f.posts.size)
    }
    @Test fun `dismiss cannot hide or clear an uncertain original wall command`() = runBlocking {
        val f = WallBatchFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.build(); fail() } catch (_: IOException) { }
        val saved = f.saved()!!; val disk = f.disk.value
        f.repo.dismissReceipt(saved.idempotencyKey); f.repo.dismiss()
        assertEquals("dismissing writes nothing", disk, f.disk.value)
        // Rewritten 2026-10-06 (owner review M2): a read now records its answer and time beside the request (journal facts,
        // so the minimum age and CLOSE survive a restart); after the refresh the saved command itself is compared.
        f.repo.refresh()
        assertEquals(saved, f.saved()); assertEquals(listOf(saved), PendingIntentStore(MemoryStore(f.disk.value)).all(WALLET))
        assertTrue(f.repo.state.value.historyVisible); assertEquals(1, f.posts.size)
    }
    @Test fun `dismiss preserves accepted durable proof until original hydration succeeds`() = runBlocking {
        val f = WallBatchFixture()
        f.postHandler = { _, _ -> f.beforeGet = { if (it == "/balances") throw IOException("offline") }; f.proof(f.saved()!!) }
        try { f.build(); fail() } catch (_: IOException) { }
        val saved = f.saved()!!; assertNotNull(saved.receipt)
        f.repo.dismissReceipt(saved.idempotencyKey)
        assertEquals(saved, f.saved()); assertTrue(f.repo.state.value.historyVisible)
        f.beforeGet = {}; f.repo.refresh()
        assertNull(f.saved()); assertTrue(f.repo.state.value.historyVisible)
        f.repo.dismissReceipt(f.repo.state.value.receipt!!.receiptId)
        f.repo.refresh(); assertFalse(f.repo.state.value.historyVisible); assertEquals(1, f.posts.size)
    }
    @Test fun `obsolete session close callback does not alter retained wall receipt`() = runBlocking {
        val f = WallBatchFixture(); f.build(); val receipt = f.repo.state.value.receipt!!
        signedIn(f.holder); f.repo.dismissReceipt(receipt.receiptId)
        assertTrue(f.repo.state.value.historyVisible)
    }
    @Test fun `release stores exact nonadjacent tiles and full cost before one atomic command then original hydration`() = runBlocking {
        val f = WallBatchFixture(); f.build()
        assertEquals(1, f.posts.size); assertEquals("/base/walls/batch/v1", f.posts.single().first)
        val body = f.posts.single().second; assertEquals(JsonPrimitive("74"), body["maxCostShards"])
        assertEquals(listOf(WallBatchTile(8, 8), WallBatchTile(11, 8)), f.repo.state.value.receipt!!.request.tiles)
        assertNull(f.saved()); assertNull(f.repo.state.value.drawing); assertEquals(1, f.refreshed)
        assertTrue(f.gets.filter { it.first == "/balances" }.all { it.second == mapOf("baseId" to BASE_ID) })
    }
    @Test fun `preparing and live preview only read and price the full sampled draft`() = runBlocking {
        val f = WallBatchFixture(); f.repo.prepare(); val drawing = f.repo.state.value.drawing!!
        f.repo.preview(drawing.mode.token, f.tiles)
        assertEquals(f.tiles, f.repo.state.value.preview); assertEquals("74", drawing.terms.cost(f.tiles.size)); assertEquals(5, drawing.remaining)
        assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `insufficient full-stroke balance never buys an affordable prefix`() = runBlocking {
        val f = WallBatchFixture(); f.shards = "73"
        try { f.build(); fail() } catch (_: IllegalStateException) { }
        assertTrue(f.posts.isEmpty()); assertNull(f.saved()); assertNull(f.repo.state.value.drawing)
    }
    @Test fun `full-stroke cap overflow never drops tiles to fit`() = runBlocking {
        val f = WallBatchFixture()
        try { f.build((8..13).map { WallStrokeTile(it, 8) }); fail() } catch (error: IllegalStateException) { assertTrue(error.message!!.contains("No partial batch")) }
        assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `duplicate blocked outside-claim and expired lease candidates cannot submit`() = runBlocking {
        for (tiles in listOf(listOf(WallStrokeTile(14, 14)), listOf(WallStrokeTile(7, 8)), listOf(WallStrokeTile(8, 8), WallStrokeTile(8, 8)))) {
            val f = WallBatchFixture(); try { f.build(tiles); fail() } catch (_: IllegalArgumentException) { }
            assertTrue(f.posts.isEmpty()); assertNull(f.saved())
        }
    }
    @Test fun `current collision balance or cap changes refuse the entire reviewed stroke before storage`() = runBlocking {
        for (change in 0..2) {
            val f = WallBatchFixture(); f.repo.prepare(); val drawing = f.repo.state.value.drawing!!
            when (change) {
                0 -> f.snapshot = JsonObject(f.snapshot + ("obstacles" to Json.parseToJsonElement("""[{"id":"block","spriteKey":"rock","tx":8,"ty":8}]""")))
                1 -> f.shards = "1"
                else -> f.snapshot = JsonObject(f.snapshot + ("buildings" to Json.parseToJsonElement((0..3).joinToString(prefix = "[", postfix = "]") { """{"id":"wall$it","type":"wall","level":1,"tx":${15 + it},"ty":20}""" })))
            }
            try { f.repo.release(drawing.mode.token, f.tiles); fail() } catch (_: IllegalArgumentException) { }
            assertTrue(f.posts.isEmpty()); assertNull(f.saved())
        }
    }
    @Test fun `unsupported and killflag probes permit no legacy fallback or wall POST`() = runBlocking {
        for (supported in listOf(false, true)) {
            val f = WallBatchFixture(); f.supported = supported; f.enabled = false
            try { f.build(); fail() } catch (_: IllegalStateException) { }
            assertTrue(f.posts.isEmpty()); assertNull(f.saved())
        }
    }
    @Test fun `saved unknown blocks fresh drawings and restores GET-only across process death`() = runBlocking {
        val f = WallBatchFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.build() } catch (_: IOException) { }; val saved = f.saved()!!
        val restored = WallBatchFixture(f.disk); assertEquals(saved, restored.repo.state.value.pending)
        restored.repo.refresh(); assertTrue(restored.posts.isEmpty()); assertEquals(saved, restored.saved())
        try { restored.repo.prepare(); fail() } catch (_: IllegalStateException) { }
        restored.repo.retry(); assertEquals(listOf(saved.body), restored.posts.map { it.second }); assertNull(restored.saved())
    }
    @Test fun `create-before-attempt disk restoration still permits explicit original-key retry`() = runBlocking {
        val f = WallBatchFixture(); val saved = f.create(); val restored = WallBatchFixture(f.disk)
        restored.repo.refresh(); assertFalse(restored.saved()!!.attempted); assertTrue(restored.posts.isEmpty())
        assertFalse(InterruptedIntent(saved).retryable); restored.repo.retry()
        assertEquals(saved.body, restored.posts.single().second)
    }
    @Test fun `lost accepted response uses original ledger history without another command or mutable wall proof`() = runBlocking {
        val f = WallBatchFixture(); f.postHandler = { _, _ -> val saved = f.saved()!!; f.receipts[saved.idempotencyKey] = f.proof(saved); throw IOException("lost") }
        try { f.build() } catch (_: IOException) { }; f.snapshot = JsonObject(f.snapshot + ("buildings" to JsonArray(emptyList())))
        f.enabled = false; f.repo.refresh(); assertEquals(1, f.posts.size); assertNotNull(f.repo.state.value.receipt); assertNull(f.saved())
    }
    @Test fun `later refusal after lost response retains the original exact request`() = runBlocking {
        val f = WallBatchFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.build() } catch (_: IOException) { }; val original = f.saved()!!
        f.postHandler = { _, _ -> throw ApiException(422, null, "collision") }
        try { f.repo.retry(); fail() } catch (_: ApiException) { }
        assertEquals(original.nextAttempt(), f.saved()); assertEquals(listOf(original.body, original.body), f.posts.map { it.second })
    }
    @Test fun `first definitive refusal permits a newly reviewed fresh-key stroke`() = runBlocking {
        val f = WallBatchFixture(); f.postHandler = { _, _ -> throw ApiException(422, null, "collision") }
        repeat(2) { try { f.build(); fail() } catch (_: ApiException) { }; assertNull(f.saved()) }
        assertNotEquals(f.posts.first().second["idempotencyKey"], f.posts.last().second["idempotencyKey"])
    }
    @Test fun `both durable create and attempted marker failures stop before POST`() = runBlocking {
        for (attempt in listOf(false, true)) {
            val f = WallBatchFixture(failWrite = { if (attempt) it.contains("\"attempted\":true") else true })
            try { f.build(); fail() } catch (_: IOException) { }; assertTrue(f.posts.isEmpty())
        }
    }
    @Test fun `accepted receipt survives failed hydration then restart with no new command`() = runBlocking {
        val f = WallBatchFixture(); f.postHandler = { _, _ -> f.beforeGet = { if (it == "/balances") throw IOException("offline") }; f.proof(f.saved()!!) }
        try { f.build(); fail() } catch (_: IOException) { }; assertNotNull(f.saved()!!.receipt)
        val restored = WallBatchFixture(f.disk); restored.repo.refresh()
        assertTrue(restored.posts.isEmpty()); assertNull(restored.saved()); assertNotNull(restored.repo.state.value.receipt)
    }
    @Test fun `original A recovery after selection B reads only A without publishing into B`() = runBlocking {
        val f = WallBatchFixture(); val saved = f.create(); f.receipts[saved.idempotencyKey] = f.proof(saved); f.base = CLAN_OTHER
        f.repo.refresh(); assertEquals(0, f.refreshed); assertNull(f.saved())
        assertEquals(listOf(mapOf("baseId" to BASE_ID)), f.gets.filter { it.first == "/balances" }.map { it.second })
        assertEquals(BASE_ID, f.repo.state.value.receipt!!.request.baseId)
    }
    @Test fun `land loss or inactive A is unavailable without claiming transfer or substituting B`() = runBlocking {
        for (inactive in listOf(false, true)) {
            val f = WallBatchFixture(); val saved = f.create(); f.receipts[saved.idempotencyKey] = f.proof(saved)
            f.directory = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = if (inactive) listOf(BaseSummary(BASE_ID, "inactive")) else emptyList())
            f.repo.refresh(); assertTrue(f.gets.none { it.first == "/base" || it.first == "/balances" }); assertNull(f.saved())
            assertTrue(f.repo.state.value.unavailable!!.contains("unavailable"))
        }
    }
    @Test fun `historical wallet mode after multi-base cutover cannot hydrate selected deed instead`() = runBlocking {
        val f = WallBatchFixture(); f.base = null; val saved = f.create(); f.receipts[saved.idempotencyKey] = f.proof(saved)
        f.repo.refresh(); assertNotNull(f.repo.state.value.unavailable); assertTrue(f.gets.none { it.first == "/balances" }); assertNull(f.saved())
    }
    @Test fun `malformed balances cannot retire receipt through coercion or wrong actor base`() = runBlocking {
        for (value in listOf(JsonPrimitive(10), JsonPrimitive("1e1"), JsonPrimitive("-1"), JsonPrimitive("9223372036854775808"))) {
            val f = WallBatchFixture(); val saved = f.create(); f.receipts[saved.idempotencyKey] = f.proof(saved)
            f.transform = { path, raw -> if (path == "/balances") JsonObject(raw + ("shards" to value)) else raw }
            try { f.repo.refresh(); fail() } catch (_: IllegalArgumentException) { }
            assertNotNull(f.saved()!!.receipt); assertNull(f.repo.state.value.receipt)
        }
    }
    @Test fun `Back selection identity origin and content changes cancel deferred preflight`() = runBlocking {
        for (change in 0..4) {
            val f = WallBatchFixture(); f.repo.prepare(); val drawing = f.repo.state.value.drawing!!
            f.onAccount = { when (change) { 0 -> f.repo.dismiss(); 1 -> f.base = CLAN_OTHER; 2 -> signedIn(f.holder)
                3 -> f.catalogue = JsonObject(f.catalogue + ("new" to JsonPrimitive(true))); else -> f.render = json("""{"changed":true}""") } }
            try { f.repo.release(drawing.mode.token, f.tiles); fail() } catch (_: Exception) { }
            assertTrue(f.posts.isEmpty()); assertNull(f.saved())
        }
    }
    @Test fun `pause after POST escaped retains original intent and suppresses late success`() = runBlocking {
        val f = WallBatchFixture(); f.postHandler = { _, _ -> f.repo.dismiss(); f.proof(f.saved()!!) }
        try { f.build(); fail() } catch (_: IllegalStateException) { }
        assertNotNull(f.saved()); assertNull(f.repo.state.value.receipt); assertEquals(1, f.posts.size)
    }
    @Test fun `new raid or orders block during final probe prevents POST without fallback`() = runBlocking {
        val f = WallBatchFixture(); f.repo.prepare(); val drawing = f.repo.state.value.drawing!!
        f.beforeGet = { if (it.startsWith("/base/walls/batch")) f.allowed = false }
        try { f.repo.release(drawing.mode.token, f.tiles); fail() } catch (_: IllegalStateException) { }
        assertTrue(f.posts.isEmpty()); assertNotNull(f.saved()); assertTrue(f.saved()!!.attempted)
    }
    @Test fun `two simultaneous releases cannot create two wall batches`() = runBlocking {
        val f = WallBatchFixture(); f.repo.prepare(); val token = f.repo.state.value.drawing!!.mode.token
        val entered = CompletableDeferred<Unit>(); val wait = CompletableDeferred<Unit>()
        f.postHandler = { _, _ -> entered.complete(Unit); wait.await(); f.proof(f.saved()!!) }
        val first = async { f.repo.release(token, f.tiles) }; entered.await()
        try { f.repo.release(token, f.tiles); fail() } catch (_: IllegalStateException) { }
        wait.complete(Unit); first.await(); assertEquals(1, f.posts.size)
    }
    @Test fun `directory changing during hydration retains immutable proof for another exact read`() = runBlocking {
        val f = WallBatchFixture(); val saved = f.create(); f.receipts[saved.idempotencyKey] = f.proof(saved)
        var refreshes = 0; f.onAccount = { if (++refreshes == 2) f.directory = BaseDirectory(true, capabilities = BaseCapabilities(true, true)) }
        try { f.repo.refresh(); fail() } catch (_: IllegalArgumentException) { }
        assertNotNull(f.saved()!!.receipt); assertNull(f.repo.state.value.receipt); assertEquals(0, f.refreshed)
    }
    @Test fun `an obsolete preview callback cannot alter a new session drawing`() = runBlocking {
        val f = WallBatchFixture(); f.repo.prepare(); val token = f.repo.state.value.drawing!!.mode.token
        signedIn(f.holder); f.repo.preview(token, f.tiles); assertTrue(f.repo.state.value.preview.isEmpty()); assertTrue(f.posts.isEmpty())
    }
}
