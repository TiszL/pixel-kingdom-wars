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

internal const val CLAN_ID = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
internal const val CLAN_OTHER = "c310a4a4-d7b5-424a-b8f8-cd77d01114a3"
internal const val CLAN_MEMBER = "8qczveMvzwCmDZPzddgnL7SnDpiMyxXCXCXZBTwmhn2Q"
internal fun clanJson(id: String = CLAN_ID, second: Boolean = false) = json("""{"clan":{"id":"$id","name":"Crown","tag":"CRN","inviteMode":"open","inviteCode":null,
    "leaderWallet":"$WALLET","roster":[{"wallet":"$WALLET","joinedAt":"2026-09-12T00:00:00Z","name":"Leader","keepLevel":2,"trophies":4,"seeker":true}
    ${if (second) """,{"wallet":"$CLAN_MEMBER","joinedAt":"2026-09-12T00:00:01Z","name":"Member","keepLevel":1,"trophies":0,"seeker":false}""" else ""}]}}""")
internal class ClanFixture(val disk: MemoryStore = MemoryStore()) {
    val holder = testHolder(); val session = signedIn(holder); val store = PendingIntentStore(disk); val observer = ReceiptObserver(store)
    var base: String? = BASE_ID; var refreshedBase = 0; var refreshedAccount = 0; var owned = true
    var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true),
        bases = listOf(BaseSummary(BASE_ID, "active", slot = 1), BaseSummary(CLAN_OTHER, "active", slot = 2)))
    var membership = clanJson(); var supported = true; var onAccount: suspend () -> Unit = {}
    val gets = mutableListOf<Pair<String, Map<String, String>>>()
    val posts = mutableListOf<Pair<String, JsonObject>>()
    val receipts = mutableMapOf<String, JsonObject>()
    /** Keys the server answers `absent` for (owner review 2026-10-06: it holds no ledger row for that exact key). */
    val absentKeys = mutableSetOf<String>()
    var beforeGet: suspend (String) -> Unit = {}
    var postHandler: suspend (String, JsonObject) -> JsonObject = { path, body ->
        val intent = requireNotNull(store.get(if (path.endsWith("leave")) IntentKind.CLAN_LEAVE else IntentKind.CLAN_KICK, WALLET))
        assertTrue(intent.attempted); assertEquals(intent.body, body)
        val r = proof(intent, if (path.endsWith("leave")) "disbanded" else "kicked")
        receipts[intent.idempotencyKey] = r
        membership = if (path.endsWith("leave")) json("""{"clan":null}""") else clanJson()
        r
    }
    val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject {
            gets += path to query; beforeGet(path)
            return when {
                path.startsWith("/clans/v1/commands/") -> {
                    if (!supported) throw ApiException(404, null, "Unavailable")
                    val key = path.substringAfterLast('/')
                    if (key in absentKeys && receipts[key] == null) buildJsonObject { put("version", 1); put("status", "absent"); put("idempotencyKey", key) }
                    else buildJsonObject { put("version", 1); put("wallet", WALLET); put("idempotencyKey", key); put("receipt", receipts[key] ?: JsonNull) }
                }
                path == "/clans/mine" -> membership
                path == "/clans" -> json("""{"clans":[]}""")
                path == "/balances" -> balancesJson()
                else -> error("Unexpected read $path")
            }
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject { posts += path to body; return postHandler(path, body) }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT expected")
        override suspend fun delete(path: String): JsonObject = error("No DELETE expected")
    }
    val repo = LiveClansRepository(session, holder, api, store, observer, { base }, { refreshedBase++ }, "devnet", { directory }, { owned }, { onAccount(); refreshedAccount++ })
    fun proof(i: PendingIntent, state: String = "disbanded", amount: String = if (state == "disbanded") "777" else "0"): JsonObject = buildJsonObject {
        put("version", 1); put("actor", WALLET); put("idempotencyKey", i.idempotencyKey)
        put("kind", if (i.kind == IntentKind.CLAN_LEAVE) "leave" else "kick"); put("clanId", i.quote!!.getValue("clanId"))
        put("baseId", i.baseId?.let(::JsonPrimitive) ?: JsonNull)
        put("target", if (i.kind == IntentKind.CLAN_KICK) i.body.getValue("wallet") else JsonNull)
        put("state", state); put("payoutShards", amount)
        put("ledgerTransactionId", if (amount != "0") JsonPrimitive("00000000-0000-4000-8000-000000000001") else JsonNull)
        put("refusalCode", if (state == "refused") JsonPrimitive("CLAN_CHANGED") else JsonNull)
        put("createdAt", "2026-09-13T00:00:00.000Z")
    }
    suspend fun leave() { repo.reviewLeave(CLAN_ID, if (directory?.enabled == true) base else null); repo.confirm(requireNotNull(repo.state.value.review)) }
    suspend fun kick() { repo.reviewKick(CLAN_ID, CLAN_MEMBER); repo.confirm(requireNotNull(repo.state.value.review)) }
    fun saved(kind: String = IntentKind.CLAN_LEAVE) = store.get(kind, WALLET)
    fun legacy(kind: String = IntentKind.CLAN_LEAVE, receipt: JsonObject? = null): PendingIntent {
        val kick = kind == IntentKind.CLAN_KICK
        return PendingIntent(kind, WALLET, if (kick) null else BASE_ID, UUID.randomUUID().toString(), if (kick) "/clans/kick" else "/clans/leave",
            if (kick) jsonBody("wallet" to CLAN_MEMBER) else jsonBody("baseId" to BASE_ID), "Original clan change",
            buildJsonObject { put("clanId", CLAN_ID); put("clanName", "Crown"); if (kick) put("target", CLAN_MEMBER) }, true,
            receipt?.let(ReceiptDocument::fromPost)).also { check(store.create(it)) }
    }
}

class ClansRepositoryTest {
    @Test fun `existing clans remain readable without creation join or unsupported management requests`(): Unit = runBlocking {
        val f = ClanFixture(); f.supported = false; f.repo.refresh()
        assertEquals(CLAN_ID, f.repo.state.value.membership!!.clan!!.id); assertTrue(f.posts.isEmpty()); assertFalse(f.repo.state.value.supported)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.leave() } }; assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `sole leader leave persists exact clan key and base before POST then hydrates original balances`(): Unit = runBlocking {
        val f = ClanFixture(); f.leave()
        assertNull(f.saved()); assertEquals(1, f.posts.size); assertEquals(setOf("idempotencyKey", "clanId", "baseId"), f.posts.single().second.keys)
        assertEquals("777", f.repo.state.value.receipt!!.payoutShards); assertNotNull(f.repo.state.value.receipt!!.ledgerTransactionId)
        assertEquals(listOf(mapOf("baseId" to BASE_ID)), f.gets.filter { it.first == "/balances" }.map { it.second })
        assertNull(f.repo.state.value.membership!!.clan)
    }
    @Test fun `lost leave survives restart and missing membership cannot prove outcome or chest payment`(): Unit = runBlocking {
        val f = ClanFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.leave() } }
        val restored = ClanFixture(f.disk); restored.membership = json("""{"clan":null}"""); restored.repo.refresh()
        assertNotNull(restored.saved()); assertTrue(restored.posts.isEmpty()); assertNull(restored.repo.state.value.receipt)
        assertThrows(IllegalStateException::class.java) { runBlocking { restored.repo.reviewLeave(CLAN_OTHER, BASE_ID) } }
    }
    @Test fun `accepted proof survives hydration failure and refreshes original A after selecting B`(): Unit = runBlocking {
        val f = ClanFixture(); f.beforeGet = { if (it == "/balances") throw IOException("offline") }
        assertThrows(IOException::class.java) { runBlocking { f.leave() } }; assertNotNull(f.saved()!!.receipt)
        val restored = ClanFixture(f.disk); restored.base = CLAN_OTHER; restored.membership = json("""{"clan":null}""")
        restored.repo.checkChanges(); assertNull(restored.saved()); assertTrue(restored.posts.isEmpty())
        assertEquals(BASE_ID, restored.repo.state.value.payout!!.baseId)
        assertEquals(listOf(mapOf("baseId" to BASE_ID)), restored.gets.filter { it.first == "/balances" }.map { it.second })
    }
    @Test fun `stale clan or selected payout base refuses before saving or sending`(): Unit = runBlocking {
        val f = ClanFixture(); f.base = CLAN_OTHER
        assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.reviewLeave(CLAN_ID, BASE_ID) } }
        f.base = BASE_ID; f.membership = clanJson(CLAN_OTHER)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.leave() } }
        assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `leader leaves last and cannot remove themselves`(): Unit = runBlocking {
        val f = ClanFixture(); f.membership = clanJson(second = true)
        assertThrows(IllegalStateException::class.java) { runBlocking { f.leave() } }
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.reviewKick(CLAN_ID, WALLET) } }; assertTrue(f.posts.isEmpty())
    }
    @Test fun `kick freezes original clan and target and validates exact terminal acknowledgement`(): Unit = runBlocking {
        val f = ClanFixture(); f.membership = clanJson(second = true); f.kick()
        assertEquals(JsonPrimitive(CLAN_MEMBER), f.posts.single().second["wallet"]); assertEquals(JsonPrimitive(CLAN_ID), f.posts.single().second["clanId"])
        assertEquals("kicked", f.repo.state.value.receipt!!.state); assertNull(f.saved(IntentKind.CLAN_KICK)); assertEquals(1, f.repo.state.value.membership!!.clan!!.roster.size)
    }
    @Test fun `unknown kick remains after roster change and blocks a second clan action`(): Unit = runBlocking {
        val f = ClanFixture(); f.membership = clanJson(second = true); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.kick() } }; f.membership = clanJson(); f.repo.refresh()
        assertNotNull(f.saved(IntentKind.CLAN_KICK)); assertThrows(IllegalStateException::class.java) { runBlocking { f.leave() } }; assertEquals(1, f.posts.size)
    }
    @Test fun `first HTTP refusal retires but malformed acknowledgement preserves original intent`(): Unit = runBlocking {
        val f = ClanFixture(); f.postHandler = { _, _ -> throw ApiException(422, null, "refused") }
        assertThrows(ApiException::class.java) { runBlocking { f.leave() } }; assertNull(f.saved())
        f.postHandler = { _, _ -> json("""{"left":true}""") }
        assertThrows(ApiCompatibilityException::class.java) { runBlocking { f.leave() } }; assertNotNull(f.saved())
    }
    @Test fun `superseded identity cannot publish the response or clear frozen intent`(): Unit = runBlocking {
        val f = ClanFixture(); f.postHandler = { _, _ -> val proof = f.proof(f.saved()!!); signedIn(f.holder, CLAN_MEMBER); proof }
        assertThrows(CancellationException::class.java) { runBlocking { f.leave() } }
        assertNull(f.repo.state.value.receipt); assertNotNull(f.saved())
    }
    @Test fun `same-key explicit retry does not adopt new membership or another payout destination`(): Unit = runBlocking {
        val f = ClanFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.leave() } }; val original = f.posts.single()
        f.base = CLAN_OTHER; f.postHandler = { _, _ -> f.proof(f.saved()!!, "refused", "0") }
        f.repo.retry(IntentKind.CLAN_LEAVE)
        assertEquals(listOf(original, original), f.posts); assertEquals("refused", f.repo.state.value.receipt!!.state); assertNull(f.saved())
    }
    @Test fun `later HTTP refusal cannot retire an earlier unknown and next recovery stays GET only`(): Unit = runBlocking {
        val f = ClanFixture(); f.postHandler = { _, _ -> throw IOException("lost") }; assertThrows(IOException::class.java) { runBlocking { f.leave() } }
        val saved = f.saved(); f.postHandler = { _, _ -> throw ApiException(409, "CLAN_BASE_CONTEXT_MISMATCH", "changed") }
        assertThrows(ApiException::class.java) { runBlocking { f.repo.retry(IntentKind.CLAN_LEAVE) } }; assertEquals(saved!!.nextAttempt(), f.saved())
        f.repo.refresh(); assertEquals(2, f.posts.size); assertNotNull(f.saved())
    }
    @Test fun `positive matching GET prevents an explicit retry from posting again`(): Unit = runBlocking {
        val f = ClanFixture(); f.postHandler = { _, _ -> val i = f.saved()!!; f.receipts[i.idempotencyKey] = f.proof(i); throw IOException("lost") }
        assertThrows(IOException::class.java) { runBlocking { f.leave() } }; f.repo.retry(IntentKind.CLAN_LEAVE)
        assertEquals(1, f.posts.size); assertNull(f.saved()); assertEquals("777", f.repo.state.value.receipt!!.payoutShards)
    }
    @Test fun `fresh directory proves transferred payout base unavailable without reading another owner balances`(): Unit = runBlocking {
        val f = ClanFixture(); f.beforeGet = { if (it == "/balances") throw IOException("offline") }; assertThrows(IOException::class.java) { runBlocking { f.leave() } }
        val restored = ClanFixture(f.disk); restored.owned = false; restored.base = null; restored.directory = BaseDirectory(true, bases = emptyList())
        restored.repo.checkChanges(); assertNull(restored.saved()); assertEquals(1, restored.refreshedAccount)
        assertTrue(restored.gets.none { it.first in setOf("/balances", "/clans", "/clans/mine") }); assertNotNull(restored.repo.state.value.payout!!.unavailable)
        assertEquals(BASE_ID, restored.repo.state.value.receipt!!.baseId); assertEquals("777", restored.repo.state.value.receipt!!.payoutShards)
    }
    @Test fun `failed directory refresh preserves accepted proof and never certifies a new selected base`(): Unit = runBlocking {
        val f = ClanFixture(); var count = 0; f.onAccount = { count++; if (count > 2) throw IOException("directory offline") }
        assertThrows(IOException::class.java) { runBlocking { f.leave() } }; assertNotNull(f.saved()!!.receipt); assertNull(f.repo.state.value.receipt)
    }
    @Test fun `legacy interrupted leave and kick remain forever on original unsent-key protocol after upgrade`(): Unit = runBlocking {
        for (kind in listOf(IntentKind.CLAN_LEAVE, IntentKind.CLAN_KICK)) {
            val f = ClanFixture(); val legacy = f.legacy(kind); f.repo.refresh()
            assertEquals(legacy, f.store.get(kind, WALLET)); assertFalse(InterruptedIntent(legacy).retryable)
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repo.retry(kind) } }
            assertTrue(f.posts.isEmpty()); assertTrue(f.gets.none { it.first.endsWith(legacy.idempotencyKey) })
        }
    }
    @Test fun `legacy positive POST proof still hydrates without pretending to know its payout amount`(): Unit = runBlocking {
        val f = ClanFixture(); f.legacy(receipt = json("""{"left":true,"disbanded":true}""")); f.membership = json("""{"clan":null}""")
        f.repo.checkChanges(); assertNull(f.saved()); assertEquals(1, f.refreshedBase); assertTrue(f.posts.isEmpty())
        assertNull(f.repo.state.value.receipt); assertTrue(f.repo.state.value.notice!!.contains("does not report its amount"))
    }
    @Test fun `missing route on restored v1 holds exact request with no fallback`(): Unit = runBlocking {
        val f = ClanFixture(); f.postHandler = { _, _ -> throw IOException("lost") }; assertThrows(IOException::class.java) { runBlocking { f.leave() } }
        val restored = ClanFixture(f.disk); restored.supported = false; restored.repo.refresh(); restored.repo.retry(IntentKind.CLAN_LEAVE)
        assertNotNull(restored.saved()); assertTrue(restored.posts.isEmpty()); assertFalse(restored.repo.state.value.supported)
    }
    @Test fun `wallet-mode payout uses explicit null and old wallet proof cannot read a newer selected deed`(): Unit = runBlocking {
        val f = ClanFixture(); f.directory = BaseDirectory(false); f.base = null; f.leave()
        assertEquals(JsonNull, f.posts.single().second["baseId"]); assertNull(f.repo.state.value.receipt!!.baseId)
        assertEquals(emptyMap<String, String>(), f.gets.single { it.first == "/balances" }.second)
    }
    @Test fun `leave and kick saved before attempted marker restore with explicit identical-key retry eligibility`(): Unit = runBlocking {
        for (kind in listOf(IntentKind.CLAN_LEAVE, IntentKind.CLAN_KICK)) {
            val f = ClanFixture()
            val intent = ClanCommandSpec(kind, "devnet").intent(WALLET, UUID.randomUUID().toString(), CLAN_ID, "Crown",
                if (kind == IntentKind.CLAN_LEAVE) BASE_ID else null, if (kind == IntentKind.CLAN_KICK) CLAN_MEMBER else null)
            assertTrue(f.store.create(intent)); assertFalse(intent.attempted)
            val restored = ClanFixture(f.disk); restored.membership = clanJson(second = kind == IntentKind.CLAN_KICK)
            restored.repo.refresh(); assertEquals(intent, restored.saved(kind)); assertTrue(restored.posts.isEmpty())
            assertTrue(InterruptedIntent(requireNotNull(restored.saved(kind))).retryable)
            restored.repo.retry(kind)
            assertEquals(listOf(intent.path to intent.body), restored.posts); assertNull(restored.saved(kind))
            assertEquals(intent.idempotencyKey, restored.repo.state.value.receipt!!.idempotencyKey)
        }
    }
    @Test fun `owned inactive original A never requests a guaranteed refused balance or substitutes selected B`(): Unit = runBlocking {
        val f = ClanFixture(); val original = ClanCommandSpec(IntentKind.CLAN_LEAVE, "devnet")
            .intent(WALLET, UUID.randomUUID().toString(), CLAN_ID, "Crown", BASE_ID, null)
        check(f.store.create(original.copy(attempted = true, receipt = ReceiptDocument.fromPost(f.proof(original)))))
        val restored = ClanFixture(f.disk); restored.base = CLAN_OTHER
        restored.directory = restored.directory!!.copy(bases = listOf(BaseSummary(BASE_ID, "inactive", slot = null), BaseSummary(CLAN_OTHER, "active", slot = 1)))
        restored.repo.checkChanges()
        assertTrue(restored.posts.isEmpty()); assertTrue(restored.gets.none { it.first == "/balances" })
        assertEquals(BASE_ID, restored.repo.state.value.receipt!!.baseId); assertEquals("777", restored.repo.state.value.receipt!!.payoutShards)
        assertTrue(restored.repo.state.value.payout!!.unavailable!!.contains("inactive"))
    }
    @Test fun `historical wallet SHARDS receipt remains explicit when current server uses deed balances`(): Unit = runBlocking {
        val f = ClanFixture(); val original = ClanCommandSpec(IntentKind.CLAN_LEAVE, "devnet")
            .intent(WALLET, UUID.randomUUID().toString(), CLAN_ID, "Crown", null, null)
        check(f.store.create(original.copy(attempted = true, receipt = ReceiptDocument.fromPost(f.proof(original)))))
        val restored = ClanFixture(f.disk); restored.base = CLAN_OTHER; restored.repo.checkChanges()
        assertTrue(restored.posts.isEmpty()); assertTrue(restored.gets.none { it.first == "/balances" })
        assertNull(restored.repo.state.value.receipt!!.baseId); assertEquals("777", restored.repo.state.value.receipt!!.payoutShards)
        assertTrue(restored.repo.state.value.payout!!.unavailable!!.contains("wallet SHARDS"))
    }
}
