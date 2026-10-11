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
import java.util.UUID

internal class ForgeClaimFixture(val disk: MemoryStore = MemoryStore(), val failWrite: (String) -> Boolean = { false }) {
    val holder = testHolder(); val session = signedIn(holder)
    val store = PendingIntentStore(object : SecretStore {
        override fun read() = disk.read()
        override fun write(value: String) { if (failWrite(value)) throw IOException("disk refused"); disk.write(value) }
        override fun clear() = disk.clear()
    })
    val observer = ReceiptObserver(store)
    var base: String? = BASE_ID; var owned = true; var enabled = true; var supported = true; var max: Int? = 2
    var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1), BaseSummary(CLAN_OTHER, "active", slot = 2)))
    var onAccount: suspend () -> Unit = {}; var onHome: suspend () -> Unit = {}; var homeReads = 0; var beforeGet: suspend (String) -> Unit = {}
    val gets = mutableListOf<Pair<String, Map<String, String>>>(); val posts = mutableListOf<Pair<String, JsonObject>>()
    val receipts = mutableMapOf<String, JsonObject>(); var empty = false; var claimable = "777"
    /** Keys the server answers `absent` for (owner review 2026-10-06: it holds no ledger row for that exact key). */
    val absentKeys = mutableSetOf<String>()
    var postHandler: suspend (String, JsonObject) -> JsonObject = { _, body ->
        val i = requireNotNull(saved()); assertTrue(i.attempted); assertEquals(i.body, body)
        assertEquals(i, PendingIntentStore(MemoryStore(disk.value)).get(IntentKind.FORGE_CLAIM, WALLET))
        proof(i).also { receipts[i.idempotencyKey] = it }
    }
    val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject {
            gets += path to query; beforeGet(path)
            return when {
                path.startsWith("/forge/claims/v1/") -> {
                    if (!supported) throw ApiException(404, null, "unavailable")
                    val key = path.substringAfterLast('/')
                    if (key in absentKeys && receipts[key] == null) buildJsonObject { put("version", 1); put("status", "absent"); put("idempotencyKey", key) }
                    else buildJsonObject { put("version", 1); put("wallet", WALLET); put("idempotencyKey", key); put("enabled", enabled); put("receipt", receipts[key] ?: JsonNull) }
                }
                path == "/forge/allocations" -> {
                    val day = if (query["before"] == "2026-08-21") "2026-08-20" else "2026-09-11"
                    json("""{"days":[{"day":"$day","shards":"10","keepPaid":"777","status":"claimable","expiresAt":null}],"nextBefore":null,"totals":{"keepClaimed":"0","keepClaimable":"$claimable","keepExpired":"0"}}""")
                }
                path == "/balances" -> balancesJson(keep = "900")
                path == "/forge" -> forgeClaimOverview()
                else -> error("Unexpected GET $path")
            }
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject { posts += path to body; return postHandler(path, body) }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT")
        override suspend fun delete(path: String): JsonObject = error("No DELETE")
    }
    val economy = LiveEconomyRepository(session, holder, api, { base }, { owned }, store, observer)
    val repo = ForgeClaimsRepository(session, holder, api, store, observer, { base }, { directory }, { owned }, { onAccount() }, { max }, "devnet", economy::invalidateForge, economy::refreshForgeAfterClaim, { homeReads++; onHome() })
    fun saved() = store.get(IntentKind.FORGE_CLAIM, WALLET)
    fun proof(i: PendingIntent): JsonObject = buildJsonObject {
        put("version", 1); put("actor", WALLET); put("idempotencyKey", i.idempotencyKey); put("baseId", i.body.getValue("baseId")); put("day", i.body.getValue("day")); put("createdAt", "2026-09-13T00:00:00.000Z")
        put("result", buildJsonObject {
            put("claimed", if (empty) JsonArray(emptyList()) else buildJsonArray { add(buildJsonObject {
                put("day", (i.body["day"] as? JsonPrimitive)?.contentOrNull ?: "2026-09-11"); put("keep", "777"); put("ledgerTransactionId", "00000000-0000-4000-8000-000000000001")
            }) }); put("totalKeep", if (empty) "0" else "777"); put("remaining", 0)
        })
    }
    suspend fun claim(day: String? = null) { repo.review(if (owned) base else null, day); repo.confirm(requireNotNull(repo.state.value.review)) }
    fun create(day: String? = null, scope: String? = BASE_ID): PendingIntent = ForgeClaimSpec("devnet").intent(WALLET, UUID.randomUUID().toString(), scope, day, 2).also { check(store.create(it)) }
}

internal fun forgeClaimOverview() = json("""{"day":"2026-09-12","cycleEndsAt":"2026-09-13T00:00:00Z","dailyEmissionKeep":"100","totalShards":"50","myShards":"10","myShardBalance":"100","goldforgeLevel":1,"myDailyCapShards":"100","claimable":{"totalKeep":"0","count":0}}""")

class ForgeClaimsRepositoryTest {
    @Test fun `all claim persists exact request before one POST and refreshes original wallet KEEP`() = runBlocking {
        val f = ForgeClaimFixture(); f.claim(); assertEquals(1, f.posts.size); assertEquals(setOf("idempotencyKey", "baseId", "day"), f.posts.single().second.keys)
        assertNull(f.saved()); assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep); assertEquals("900", f.repo.state.value.payout!!.keepBalance)
        assertEquals(listOf(mapOf("baseId" to BASE_ID)), f.gets.filter { it.first == "/balances" }.map { it.second })
    }
    @Test fun `older single day review rereads exact pagination and keeps day in consent`() = runBlocking {
        val f = ForgeClaimFixture(); f.claim("2026-08-20")
        assertEquals(mapOf("baseId" to BASE_ID, "before" to "2026-08-21"), f.gets.single { it.first == "/forge/allocations" && "before" in it.second }.second)
        assertEquals(JsonPrimitive("2026-08-20"), f.posts.single().second["day"])
    }
    @Test fun `empty result is positive terminal proof and still hydrates balance`() = runBlocking {
        val f = ForgeClaimFixture(); f.empty = true; f.claim(); assertNull(f.saved()); assertEquals("0", f.repo.state.value.receipt!!.result.totalKeep)
        assertEquals("900", f.repo.state.value.payout!!.keepBalance)
    }
    @Test fun `lost response and process restart are GET only and block a fresh key`() = runBlocking {
        val f = ForgeClaimFixture(); f.postHandler = { _, _ -> throw IOException("lost") }; assertThrows(IOException::class.java) { runBlocking { f.claim() } }
        val restored = ForgeClaimFixture(f.disk); restored.repo.refresh(); assertEquals(f.saved(), restored.saved()); assertTrue(restored.posts.isEmpty())
        assertThrows(IllegalStateException::class.java) { runBlocking { restored.claim() } }; assertNotNull(restored.saved())
    }
    @Test fun `retry after missing history preserves exact body key and original A after selected B`() = runBlocking {
        val f = ForgeClaimFixture(); f.postHandler = { _, _ -> throw IOException("lost") }; assertThrows(IOException::class.java) { runBlocking { f.claim() } }; val first = f.posts.single()
        val restored = ForgeClaimFixture(f.disk); restored.base = CLAN_OTHER; restored.repo.retry()
        assertEquals(first, restored.posts.single()); assertEquals(BASE_ID, restored.repo.state.value.receipt!!.baseId)
        assertEquals(listOf(mapOf("baseId" to BASE_ID), mapOf("baseId" to CLAN_OTHER)), restored.gets.filter { it.first == "/balances" }.map { it.second })
    }
    @Test fun `first and later HTTP refusals never manufacture an empty receipt`() = runBlocking {
        for (code in listOf(404, 422, 409)) {
            val f = ForgeClaimFixture(); f.postHandler = { _, _ -> throw ApiException(code, "REFUSED", "refused") }
            assertThrows(IOException::class.java) { runBlocking { f.claim() } }; val saved = f.saved(); assertNotNull(saved)
            assertThrows(IOException::class.java) { runBlocking { f.repo.retry() } }; assertEquals(saved!!.nextAttempt(), f.saved())
        }
    }
    @Test fun `unsupported or disabled server blocks all new POSTs and retains unknown history`() = runBlocking {
        for (unsupported in listOf(true, false)) {
            val f = ForgeClaimFixture(); f.supported = !unsupported; f.enabled = false; f.repo.refresh()
            assertThrows(IllegalStateException::class.java) { runBlocking { f.claim() } }; assertTrue(f.posts.isEmpty())
            f.create(); if (unsupported) f.repo.retry() else assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.retry() } }
            assertNotNull(f.saved()); assertTrue(f.posts.isEmpty())
        }
    }
    @Test fun `disabled switch cannot hide immutable completed claim recovery`() = runBlocking {
        val f = ForgeClaimFixture(); val i = f.create(); f.enabled = false; f.receipts[i.idempotencyKey] = f.proof(i); f.repo.refresh()
        assertNull(f.saved()); assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep); assertTrue(f.posts.isEmpty())
    }
    @Test fun `failed hydration preserves proof and restart hydrates without GET receipt or POST`() = runBlocking {
        val f = ForgeClaimFixture(); f.beforeGet = { if (it == "/balances") throw IOException("offline") }
        assertThrows(IOException::class.java) { runBlocking { f.claim() } }; assertNotNull(f.saved()!!.receipt); assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep); assertTrue(f.repo.state.value.refreshRequired); assertNotNull(f.repo.state.value.refreshError)
        val key = f.saved()!!.idempotencyKey; val restored = ForgeClaimFixture(f.disk); restored.base = CLAN_OTHER; restored.repo.refresh()
        assertNull(restored.saved()); assertTrue(restored.posts.isEmpty()); assertFalse(restored.gets.any { it.first.endsWith(key) })
        assertEquals(listOf(mapOf("baseId" to BASE_ID), mapOf("baseId" to CLAN_OTHER)), restored.gets.filter { it.first == "/balances" }.map { it.second })
    }
    @Test fun `inactive missing or mode-changed original scope never substitutes selected B`() = runBlocking {
        for (case in 0..2) {
            val f = ForgeClaimFixture(); val i = f.create(scope = if (case == 2) null else BASE_ID); f.receipts[i.idempotencyKey] = f.proof(i); f.base = CLAN_OTHER
            if (case != 2) f.directory = f.directory!!.copy(bases = listOf(BaseSummary(CLAN_OTHER, "active", slot = 2)) + if (case == 0) listOf(BaseSummary(BASE_ID, "inactive", slot = 1)) else emptyList())
            f.repo.refresh(); assertNull(f.saved()); assertNull(f.repo.state.value.payout!!.keepBalance); assertNotNull(f.repo.state.value.payout!!.unavailable)
            assertEquals(listOf(mapOf("baseId" to CLAN_OTHER)), f.gets.filter { it.first == "/balances" }.map { it.second }); assertFalse(f.gets.any { it.first == "/wallet/balances" })
        }
    }
    @Test fun `wallet allocation claim remains explicit null after land loss and multi-base mode change`() = runBlocking {
        val f = ForgeClaimFixture(); f.owned = false; f.claim(); assertEquals(JsonNull, f.posts.single().second["baseId"])
        assertNotNull(f.repo.state.value.payout!!.unavailable); assertEquals(listOf(mapOf("baseId" to BASE_ID)), f.gets.filter { it.first == "/balances" }.map { it.second })
        val walletMode = ForgeClaimFixture(); walletMode.owned = false; walletMode.directory = BaseDirectory(false); walletMode.base = null; walletMode.claim()
        assertEquals(emptyMap<String, String>(), walletMode.gets.single { it.first == "/balances" }.second)
    }
    @Test fun `original unavailable base cannot retry unknown claim under another base or null`() = runBlocking {
        val f = ForgeClaimFixture(); val i = f.create(); f.owned = false; f.base = CLAN_OTHER; f.directory = f.directory!!.copy(bases = emptyList())
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.retry() } }; assertEquals(i, f.saved()); assertTrue(f.posts.isEmpty())
    }
    @Test fun `malformed matching-key receipt cannot retire original intent`() = runBlocking {
        val f = ForgeClaimFixture(); f.postHandler = { _, _ -> JsonObject(f.proof(f.saved()!!) + ("baseId" to JsonNull)) }
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.claim() } }; assertNotNull(f.saved()); assertNull(f.repo.state.value.receipt)
    }
    @Test fun `create-before-attempt process death permits only explicit same-key retry`() = runBlocking {
        val f = ForgeClaimFixture(); val i = f.create("2026-09-11"); val restored = ForgeClaimFixture(f.disk)
        restored.repo.refresh(); assertTrue(restored.posts.isEmpty()); assertTrue(InterruptedIntent(restored.saved()!!).retryable)
        restored.repo.retry(); assertEquals(i.body, restored.posts.single().second); assertNull(restored.saved())
    }
    @Test fun `failed creation or attempted-marker write never sends a claim`() = runBlocking {
        for (attemptOnly in listOf(false, true)) {
            val f = ForgeClaimFixture(failWrite = { !attemptOnly || it.contains("\"attempted\":true") })
            assertThrows(IOException::class.java) { runBlocking { f.claim() } }; assertTrue(f.posts.isEmpty())
        }
    }
    @Test fun `failed receipt write holds key and recovers from exact GET evidence`() = runBlocking {
        var fail = true; val f = ForgeClaimFixture(failWrite = { fail && it.contains("\"receipt\":{") })
        assertThrows(IOException::class.java) { runBlocking { f.claim() } }; assertNull(f.saved()!!.receipt)
        fail = false; f.repo.refresh(); assertNull(f.saved()); assertEquals(1, f.posts.size)
    }
    @Test fun `generic observer retry cannot bypass explicit Forge consent`() = runBlocking {
        val f = ForgeClaimFixture(); f.create()
        assertThrows(IllegalStateException::class.java) { runBlocking { f.observer.retry(IntentKind.FORGE_CLAIM, WALLET) } }
        assertTrue(f.posts.isEmpty()); assertNotNull(f.saved())
    }
    @Test fun `session replacement during POST cannot publish or clear original intent`() = runBlocking {
        val f = ForgeClaimFixture(); f.postHandler = { _, _ -> val r = f.proof(f.saved()!!); signedIn(f.holder, CLAN_MEMBER); r }
        assertThrows(CancellationException::class.java) { runBlocking { f.claim() } }; assertNull(f.repo.state.value.receipt); assertNotNull(f.saved())
    }
    @Test fun `selected base and verified contract changes invalidate reviewed consent before persistence`() = runBlocking {
        val f = ForgeClaimFixture(); f.repo.review(BASE_ID, null); val r = f.repo.state.value.review!!; f.base = CLAN_OTHER
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.confirm(r) } }; f.base = BASE_ID; f.max = 3
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.confirm(r) } }; assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `new explicit consent after confirmed claim uses a fresh key`() = runBlocking {
        val f = ForgeClaimFixture(); f.claim(); f.claim(); assertEquals(2, f.posts.size)
        assertNotEquals(f.posts[0].second["idempotencyKey"], f.posts[1].second["idempotencyKey"])
    }
    @Test fun `durable receipt is visible while coordinated refresh is delayed and no new claim is admitted`() = runBlocking {
        val f = ForgeClaimFixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.beforeGet = { if (it == "/balances") { entered.complete(Unit); release.await() } }
        val claim = async { f.claim() }; entered.await()
        assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep)
        assertEquals(ForgeClaimPhase.UPDATING, f.repo.state.value.phase)
        assertNotNull(f.saved()!!.receipt); assertTrue(f.repo.state.value.refreshRequired)
        assertNull(f.economy.state.value.allocations)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.review(BASE_ID, null) } }
        release.complete(Unit); claim.await()
        assertEquals(ForgeClaimPhase.SUCCESS, f.repo.state.value.phase); assertFalse(f.repo.state.value.refreshRequired)
        assertTrue(f.economy.state.value.forgeReady); assertEquals(1, f.posts.size)
    }
    @Test fun `confirmed empty availability prevents another all-ready review even after a positive payout`() = runBlocking {
        val f = ForgeClaimFixture(); f.postHandler = { _, _ -> f.claimable = "0"; f.proof(f.saved()!!) }
        f.claim()
        assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep)
        assertEquals("0", f.economy.state.value.allocations!!.claimable)
        val error = assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.review(BASE_ID, null) } }
        assertEquals("Nothing ready to collect.", error.message); assertEquals(1, f.posts.size)
    }
    @Test fun `base switch during accepted refresh keeps original proof and never publishes stale current availability`() = runBlocking {
        val f = ForgeClaimFixture(); f.beforeGet = { if (it == "/forge") f.base = CLAN_OTHER }
        assertThrows(CancellationException::class.java) { runBlocking { f.claim() } }
        assertNotNull(f.saved()!!.receipt); assertEquals(BASE_ID, f.repo.state.value.receipt!!.baseId)
        assertTrue(f.repo.state.value.refreshRequired); assertNull(f.economy.state.value.allocations)
        assertFalse(f.economy.state.value.forgeReady); assertEquals(1, f.posts.size)
    }

    @Test fun `Forge kill switch leaves exact historical receipt recoverable while all gameplay Forge routes return 404`() = runBlocking {
        val f = ForgeClaimFixture(); val intent = f.create(); f.receipts[intent.idempotencyKey] = f.proof(intent)
        f.enabled = false
        f.beforeGet = { if (it == "/forge" || it == "/forge/allocations") throw ApiException(404, null, "Route not found") }
        f.repo.refresh()
        assertNull(f.saved()); assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep)
        assertEquals("900", f.repo.state.value.payout!!.keepBalance)
        assertFalse(f.repo.state.value.payout!!.availabilityCurrent); assertTrue(f.repo.state.value.refreshRequired)
        assertNotNull(f.repo.state.value.refreshError); assertFalse(f.repo.state.value.enabled)
        assertEquals(0, f.homeReads); assertTrue(f.posts.isEmpty())
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.review(BASE_ID, null) } }; Unit
    }
    @Test fun `no selectable deed can retire a historical receipt even when current balances reject null selection`() = runBlocking {
        for (originalScope in listOf(BASE_ID, null)) {
        val f = ForgeClaimFixture(); val intent = f.create(scope = originalScope); f.receipts[intent.idempotencyKey] = f.proof(intent)
        f.base = null; f.owned = false; f.directory = f.directory!!.copy(bases = emptyList())
        f.beforeGet = { if (it == "/balances") throw ApiException(409, "BASE_ID_REQUIRED", "No active base") }
        f.repo.refresh()
        assertNull(f.saved()); assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep)
        assertNull(f.repo.state.value.payout!!.keepBalance); assertNotNull(f.repo.state.value.payout!!.unavailable)
        assertFalse(f.repo.state.value.payout!!.availabilityCurrent); assertTrue(f.repo.state.value.refreshRequired)
        assertEquals(listOf(emptyMap<String, String>()), f.gets.filter { it.first == "/balances" }.map { it.second })
        assertEquals(0, f.homeReads); assertTrue(f.posts.isEmpty())
        }
    }
    @Test fun `optional Home refresh failure does not retain an already recovered original receipt or permit a new claim`() = runBlocking {
        val f = ForgeClaimFixture(); f.onHome = { throw IOException("Home offline") }; f.claim()
        assertNull(f.saved()); assertEquals("777", f.repo.state.value.receipt!!.result.totalKeep)
        assertEquals("900", f.repo.state.value.payout!!.keepBalance); assertTrue(f.repo.state.value.refreshRequired)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.review(BASE_ID, null) } }
        f.onHome = {}; f.repo.refresh()
        assertFalse(f.repo.state.value.refreshRequired); assertNull(f.repo.state.value.refreshError); assertEquals(1, f.posts.size)
    }

}
