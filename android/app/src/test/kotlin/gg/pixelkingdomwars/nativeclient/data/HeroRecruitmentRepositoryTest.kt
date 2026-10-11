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

internal class HeroRecruitmentFixture(val disk: MemoryStore = MemoryStore(), val failWrite: (String) -> Boolean = { false }) {
    val holder = testHolder(); val session = signedIn(holder)
    val store = PendingIntentStore(object : SecretStore {
        override fun read() = disk.read()
        override fun write(value: String) { if (failWrite(value)) throw IOException("disk refused"); disk.write(value) }
        override fun clear() = disk.clear()
    })
    val observer = ReceiptObserver(store); var base: String? = BASE_ID; var contracts = 0; var active = false; var supported = true; var enabled = true
    var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 1), BaseSummary(CLAN_OTHER, "active", slot = 2)))
    var catalogue = json("""{"constants":{"GRID":{"plotTiles":30},"BUILD_COSTS":{"heroaltar":{"requiresKeepLevel":5,"buildSec":2},"siegestool":{"requiresKeepLevel":5,"buildSec":2}},"HEROES":{
        "vex":{"name":"Vex","altar":"heroaltar","unlockKeepLevel":5,"recruitCostKeep":37,"recruitItemId":"item_hero_vex"},
        "theodor":{"name":"Theodor","altar":"siegestool","unlockKeepLevel":5,"recruitCostKeep":71,"recruitItemId":"item_hero_theodor"}}}}""")
    val definitions get() = HeroAltarDefinition.all(catalogue)
    var onAccount: suspend () -> Unit = {}; var beforeGet: suspend (String) -> Unit = {}; var refreshed = 0
    var transform: (String, JsonObject) -> JsonObject = { _, raw -> raw }
    val gets = mutableListOf<Pair<String, Map<String, String>>>(); val posts = mutableListOf<Pair<String, JsonObject>>()
    val receipts = mutableMapOf<String, JsonObject>()
    var postHandler: suspend (String, JsonObject) -> JsonObject = { _, body ->
        val saved = requireNotNull(saved()); assertTrue(saved.attempted); assertEquals(saved.body, body)
        assertEquals(saved, PendingIntentStore(MemoryStore(disk.value)).get(IntentKind.HERO_RECRUITMENT, WALLET))
        proof(saved).also { receipts[saved.idempotencyKey] = it }
    }
    fun items() = buildJsonObject { put("catalog", buildJsonArray { definitions.forEach { d -> add(buildJsonObject {
        put("id", d.itemId); put("activation", buildJsonObject { put("kind", "hero"); put("active", active); put("availableContracts", contracts) })
    }) } }); put("owned", JsonArray(emptyList())) }
    fun heroes() = buildJsonObject { put("heroes", buildJsonArray { definitions.forEach { d -> add(buildJsonObject {
        put("hero", d.hero); put("name", d.name); put("altar", d.type); put("unlockKeepLevel", d.keepLevel); put("recruitCostKeep", d.costKeep); put("recruitItemId", d.itemId); put("recruited", active)
    }) } }) }
    val api = object : ApiClient {
        override suspend fun get(path: String, query: Map<String, String>): JsonObject {
            gets += path to query; beforeGet(path)
            val raw = when {
                path.startsWith("/heroes/recruit/v1/") -> {
                    if (!supported) throw ApiException(404, null, "unavailable")
                    val key = path.substringAfterLast('/')
                    buildJsonObject { put("version", 1); put("wallet", WALLET); put("idempotencyKey", key); put("enabled", enabled); put("receipt", receipts[key] ?: JsonNull) }
                }
                path == "/base" -> baseJson(query["baseId"] ?: BASE_ID).let { raw -> JsonObject(raw + ("player" to JsonObject(raw.getValue("player").jsonObject + ("keepLevel" to JsonPrimitive(8))))) }
                path == "/balances" -> balancesJson(keep = "900")
                path == "/tutorial" -> tutorialJson()
                path == "/items" -> items()
                path == "/heroes" -> heroes()
                else -> error("Unexpected GET $path")
            }
            return transform(path, raw)
        }
        override suspend fun postMoneyCommand(path: String, body: JsonObject, currency: gg.pixelkingdomwars.nativeclient.model.GameCurrency?, refusal: (ApiException) -> Unit, guard: () -> Unit): JsonObject { guard(); return post(path, body) }
        override suspend fun post(path: String, body: JsonObject): JsonObject { posts += path to body; return postHandler(path, body) }
        override suspend fun put(path: String, body: JsonObject): JsonObject = error("No PUT")
        override suspend fun delete(path: String): JsonObject = error("No DELETE")
    }
    val repo = HeroRecruitmentRepository(session, holder, api, store, observer, { base }, { directory }, { onAccount() }, { catalogue }, { refreshed++ }, "devnet")
    fun saved() = store.get(IntentKind.HERO_RECRUITMENT, WALLET)
    fun proof(i: PendingIntent): JsonObject {
        val d = HeroRecruitmentSpec("devnet").definition(i)
        return json("""{"version":1,"actor":"$WALLET","idempotencyKey":"${i.idempotencyKey}","request":${i.body},"hero":"${d.hero}",
          "building":{"id":"00000000-0000-4000-8000-000000000031","baseId":${i.body["baseId"]},"type":"${d.type}","level":1,"tx":${i.body["tx"]},"ty":${i.body["ty"]}},
          "job":{"id":"00000000-0000-4000-8000-000000000032","buildingId":"00000000-0000-4000-8000-000000000031","startedAt":"2026-09-13T00:00:00.000Z","finishesAt":"2026-09-13T00:00:02.000Z"},
          "funding":${if (contracts > 0) """{"kind":"contract","itemId":"${d.itemId}","itemUseId":"00000000-0000-4000-8000-000000000033","sourceBaseId":null,"quantity":1}""" else """{"kind":"keep","amount":"${d.costKeep}","ledgerTransactionId":"00000000-0000-4000-8000-000000000034"}"""},"createdAt":"2026-09-13T00:00:00.000Z"}""")
    }
    suspend fun recruit(type: String = "heroaltar") { repo.review(type, 10, 11); repo.confirm(requireNotNull(repo.state.value.review)) }
    fun create(contract: Boolean = false): PendingIntent {
        val d = definitions.first(); val req = HeroRecruitmentRequest(UUID.randomUUID().toString(), base, d.type, 10, 11, contract, if (contract) "0" else d.costKeep)
        return HeroRecruitmentSpec("devnet").intent(WALLET, req, d).also { check(store.create(it)) }
    }
}

class HeroRecruitmentRepositoryTest {
    @Test fun `recruitment persists its exact original consent before one POST and hydrates altar inventory and roster`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.recruit()
        assertEquals(1, f.posts.size); assertEquals("/heroes/recruit/v1", f.posts.single().first)
        assertEquals(JsonPrimitive("37"), f.posts.single().second["maxCostKeep"]); assertNull(f.saved()); assertEquals(1, f.refreshed)
        assertNotNull(f.repo.state.value.receipt); assertTrue(f.gets.any { it.first == "/items" }); assertTrue(f.gets.any { it.first == "/heroes" })
    }
    @Test fun `legacy wallet stock is prepaid even when the sellable deed bag is empty`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.contracts = 1; f.recruit()
        assertEquals(JsonPrimitive(true), f.posts.single().second["heroContractOnly"])
        assertEquals(JsonPrimitive("0"), f.posts.single().second["maxCostKeep"])
        assertEquals(JsonNull, f.repo.state.value.receipt!!.funding["sourceBaseId"])
    }
    @Test fun `a vanished contract never silently substitutes KEEP after original review`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.contracts = 1; f.repo.review("heroaltar", 10, 11); val review = f.repo.state.value.review!!
        f.contracts = 0; try { f.repo.confirm(review); fail() } catch (_: IllegalArgumentException) { }
        assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `a new prepaid contract still wins after a KEEP ceiling review`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.repo.review("heroaltar", 10, 11); val review = f.repo.state.value.review!!; f.contracts = 1
        f.repo.confirm(review); assertEquals(JsonPrimitive(false), f.posts.single().second["heroContractOnly"])
        assertEquals(JsonPrimitive("37"), f.posts.single().second["maxCostKeep"]); assertEquals(JsonPrimitive("contract"), f.repo.state.value.receipt!!.funding["kind"])
    }
    @Test fun `unsupported and disabled servers cannot receive legacy or v1 placement`() = runBlocking {
        for (disabled in listOf(false, true)) {
            val f = HeroRecruitmentFixture(); f.supported = disabled; f.enabled = false
            try { f.recruit(); fail() } catch (_: IllegalStateException) { }
            assertTrue(f.posts.isEmpty()); assertNull(f.saved())
        }
    }
    @Test fun `GET-only process restoration retains uncertainty and explicit retry keeps the original key and body`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.recruit(); fail() } catch (_: IOException) { }
        val original = f.saved()!!; val restored = HeroRecruitmentFixture(f.disk)
        restored.repo.refresh(); assertTrue(restored.posts.isEmpty()); assertEquals(original, restored.saved())
        restored.repo.retry(); assertEquals(listOf(original.body), restored.posts.map { it.second }); assertNull(restored.saved())
    }
    @Test fun `create-before-attempt process death remains retryable without any automatic POST`() = runBlocking {
        val f = HeroRecruitmentFixture(); val original = f.create(); val restored = HeroRecruitmentFixture(f.disk)
        restored.repo.refresh(); assertTrue(restored.posts.isEmpty()); assertFalse(restored.saved()!!.attempted)
        restored.repo.retry(); assertEquals(original.body, restored.posts.single().second)
    }
    @Test fun `lost accepted reply recovers from matching history without paying or placing again`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.postHandler = { _, _ -> val i = f.saved()!!; f.receipts[i.idempotencyKey] = f.proof(i); throw IOException("lost") }
        try { f.recruit(); fail() } catch (_: IOException) { }
        f.repo.refresh(); assertEquals(1, f.posts.size); assertNull(f.saved()); assertNotNull(f.repo.state.value.receipt)
    }
    @Test fun `a later ordinary refusal cannot erase an earlier ambiguous placement`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.postHandler = { _, _ -> throw IOException("lost") }
        try { f.recruit() } catch (_: IOException) { }
        val original = f.saved(); f.postHandler = { _, _ -> throw ApiException(422, null, "altar cap") }
        try { f.repo.retry(); fail() } catch (_: ApiException) { }
        assertEquals(original!!.nextAttempt(), f.saved()); assertEquals(2, f.posts.size)
    }
    @Test fun `first definitive refusal retires only that newly submitted consent`() = runBlocking {
        // A contract-only refusal can disprove this contract consent, never a KEEP consent.
        val f = HeroRecruitmentFixture(); f.contracts = 1
        f.postHandler = { _, _ -> throw ApiException(409, "HERO_CONTRACT_UNAVAILABLE", "gone") }
        try { f.recruit(); fail() } catch (_: ApiException) { }; assertNull(f.saved())
        val first = f.posts.single().second.getValue("idempotencyKey"); try { f.recruit() } catch (_: ApiException) { }
        assertNotEquals(first, f.posts.last().second.getValue("idempotencyKey"))
    }
    @Test fun `journal failure stops before placement transport`() = runBlocking {
        val f = HeroRecruitmentFixture(failWrite = { true })
        try { f.recruit(); fail() } catch (_: IOException) { }; assertTrue(f.posts.isEmpty())
    }
    @Test fun `saved accepted proof survives offline hydration and reopens without another command`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.postHandler = { _, _ -> f.beforeGet = { if (it == "/items") throw IOException("offline") }; f.proof(f.saved()!!) }
        try { f.recruit(); fail() } catch (_: IOException) { }; assertNotNull(f.saved()!!.receipt)
        val restored = HeroRecruitmentFixture(f.disk); restored.repo.refresh(); assertTrue(restored.posts.isEmpty()); assertNull(restored.saved())
    }
    @Test fun `recovery after selection B refreshes original A and never publishes A into B`() = runBlocking {
        val f = HeroRecruitmentFixture(); val i = f.create(); f.receipts[i.idempotencyKey] = f.proof(i); f.base = CLAN_OTHER
        f.repo.refresh(); assertNull(f.saved()); assertEquals(0, f.refreshed)
        assertEquals(mapOf("baseId" to BASE_ID), f.gets.first { it.first == "/items" }.second)
        assertEquals(BASE_ID, f.repo.state.value.receipt!!.request.baseId)
    }
    @Test fun `land loss or inactive original deed preserves proof with honest unavailable without a substitute`() = runBlocking {
        for (inactive in listOf(false, true)) {
            val f = HeroRecruitmentFixture(); val i = f.create(); f.receipts[i.idempotencyKey] = f.proof(i)
            f.directory = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = if (inactive) listOf(BaseSummary(BASE_ID, "inactive", slot = null)) else emptyList())
            f.repo.refresh(); assertTrue(f.gets.none { it.first == "/balances" || it.first == "/items" }); assertNull(f.saved())
            assertNotNull(f.repo.state.value.unavailable)
        }
    }
    @Test fun `wallet-mode receipt after stable cutover cannot certify balances of the selected new deed`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.base = null; val i = f.create(); f.receipts[i.idempotencyKey] = f.proof(i)
        f.repo.refresh(); assertTrue(f.gets.none { it.first == "/balances" }); assertNotNull(f.repo.state.value.unavailable); assertNull(f.saved())
    }
    @Test fun `Back selection change and same-wallet replacement fence deferred approval before POST`() = runBlocking {
        for (change in 0..2) {
            val f = HeroRecruitmentFixture(); f.repo.review("heroaltar", 10, 11); val review = f.repo.state.value.review!!
            f.onAccount = { when (change) { 0 -> f.repo.dismiss(); 1 -> f.base = CLAN_OTHER; else -> signedIn(f.holder) } }
            try { f.repo.confirm(review); fail() } catch (_: Exception) { }
            assertTrue(f.posts.isEmpty()); assertNull(f.saved())
        }
    }
    @Test fun `late POST after Back retains attempted intent without publishing success`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.postHandler = { _, _ -> f.repo.dismiss(); f.proof(f.saved()!!) }
        try { f.recruit(); fail() } catch (_: IllegalStateException) { }; assertNotNull(f.saved()); assertNull(f.repo.state.value.receipt)
    }
    @Test fun `missing canonical stock cannot silently become a paid offer`() {
        val f = HeroRecruitmentFixture(); val items = f.items(); val catalog = items.getValue("catalog").jsonArray.toMutableList()
        val item = catalog.first().jsonObject; catalog[0] = JsonObject(item + ("activation" to JsonObject(item.getValue("activation").jsonObject - "availableContracts")))
        assertThrows(IllegalArgumentException::class.java) { heroOffer(f.definitions.first(), JsonObject(items + ("catalog" to JsonArray(catalog))), f.heroes()) }
    }
    @Test fun `an offline restart exposes the exact saved request before network or owned-land gates`() {
        val f = HeroRecruitmentFixture(); val saved = f.create()
        val restored = HeroRecruitmentFixture(f.disk)
        assertEquals(saved, restored.repo.state.value.pending); assertTrue(restored.gets.isEmpty()); assertTrue(restored.posts.isEmpty())
        assertFalse("Only the dedicated original-request action can retry", InterruptedIntent(saved.copy(attempted = true)).retryable)
    }
    @Test fun `a content swap while final consent is suspended prevents any new request`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.repo.review("heroaltar", 10, 11); val review = f.repo.state.value.review!!
        f.onAccount = { f.catalogue = JsonObject(f.catalogue + ("next" to JsonPrimitive(true))) }
        try { f.repo.confirm(review); fail() } catch (_: IllegalStateException) { }
        assertTrue(f.posts.isEmpty()); assertNull(f.saved())
    }
    @Test fun `server stock corruption or contradictory active hero cannot be consent to spend KEEP`() = runBlocking {
        for (change in listOf("negative", "missing", "active")) {
            val f = HeroRecruitmentFixture(); f.transform = { path, raw ->
                if (path != "/items") raw else {
                    val catalog = raw.getValue("catalog").jsonArray.toMutableList(); val item = catalog.first().jsonObject
                    val activation = item.getValue("activation").jsonObject
                    catalog[0] = JsonObject(item + ("activation" to when (change) {
                        "negative" -> JsonObject(activation + ("availableContracts" to JsonPrimitive(-1)))
                        "missing" -> JsonObject(activation - "availableContracts")
                        else -> JsonObject(activation + ("active" to JsonPrimitive(true)))
                    })); JsonObject(raw + ("catalog" to JsonArray(catalog)))
                }
            }
            try { f.recruit(); fail() } catch (_: IllegalArgumentException) { }
            assertTrue(change, f.posts.isEmpty()); assertNull(f.saved())
        }
    }
    @Test fun `a server cost different from the verified catalogue requires new content before consent`() = runBlocking {
        val f = HeroRecruitmentFixture(); f.transform = { path, raw ->
            if (path != "/heroes") raw else JsonObject(raw + ("heroes" to JsonArray(raw.getValue("heroes").jsonArray.map {
                JsonObject(it.jsonObject + ("recruitCostKeep" to JsonPrimitive("38")))
            })))
        }
        try { f.recruit(); fail() } catch (_: IllegalArgumentException) { }; assertTrue(f.posts.isEmpty())
    }
    @Test fun `server builder Keep and existing altar limits remain enforced before consent`() = runBlocking {
        for (limit in listOf("keep", "builder", "altar")) {
            val f = HeroRecruitmentFixture(); f.transform = { path, raw -> if (path != "/base") raw else when (limit) {
                "keep" -> JsonObject(raw + ("player" to JsonObject(raw.getValue("player").jsonObject + ("keepLevel" to JsonPrimitive(1)))))
                "builder" -> JsonObject(raw + ("freeBuilders" to JsonPrimitive(0)))
                else -> JsonObject(raw + ("buildings" to JsonArray(raw.getValue("buildings").jsonArray + json("""{"id":"altar","type":"heroaltar","level":1,"tx":3,"ty":3,"underConstruction":true}"""))))
            } }
            try { f.recruit(); fail() } catch (_: IllegalArgumentException) { }; assertTrue(limit, f.posts.isEmpty())
        }
    }
    @Test fun `malformed hydration preserves accepted proof rather than declaring refreshed inventory`() = runBlocking {
        for (broken in listOf("/balances", "/items", "/heroes")) {
            val f = HeroRecruitmentFixture(); f.postHandler = { _, _ ->
                f.transform = { path, raw -> if (path != broken) raw else if (path == "/balances")
                    JsonObject(raw + ("keep" to JsonPrimitive("1e3"))) else buildJsonObject {} }
                f.proof(f.saved()!!)
            }
            try { f.recruit(); fail() } catch (_: IllegalArgumentException) { }
            assertNotNull(broken, f.saved()!!.receipt); assertNull(f.repo.state.value.receipt)
            f.transform = { _, raw -> raw }; f.repo.refresh(); assertNull(f.saved()); assertEquals(1, f.posts.size)
        }
    }
    @Test fun `the generic receipt observer cannot send recruitment without dedicated current consent`() = runBlocking {
        val f = HeroRecruitmentFixture(); val i = f.create()
        try { f.observer.retry(IntentKind.HERO_RECRUITMENT, WALLET); fail() } catch (_: IllegalStateException) { }
        assertTrue(f.posts.isEmpty()); assertEquals(i.body, f.saved()!!.body)
    }
    @Test fun `a later unsupported backend clears availability while preserving the same unresolved request`() = runBlocking {
        val f = HeroRecruitmentFixture(); val original = f.create(); f.repo.refresh(); assertTrue(f.repo.state.value.supported)
        f.supported = false; f.repo.retry()
        assertFalse(f.repo.state.value.supported); assertFalse(f.repo.state.value.enabled)
        assertEquals(original, f.saved()); assertTrue(f.posts.isEmpty())
    }
    @Test fun `accepted construction sounds once before offline hydration and GET recovery stays silent`() = runBlocking {
        val f = HeroRecruitmentFixture(); val cues = mutableListOf<gg.pixelkingdomwars.nativeclient.audio.UiAudioSound>()
        val emitter = gg.pixelkingdomwars.nativeclient.audio.UiAudioEmitter { cue, _ -> cues += cue }
        emitter.update(f.session, "pack", true); val scope = emitter.scope(BASE_ID, f.session) { f.base }.also { it.active(true) }
        f.postHandler = { _, _ -> f.beforeGet = { if (it == "/items") throw IOException("offline") }; f.proof(f.saved()!!) }
        try { withContext(scope.capture()!!) { f.recruit() }; fail() } catch (_: IOException) { }
        assertEquals(listOf(gg.pixelkingdomwars.nativeclient.audio.UiAudioCue.PLACE), cues); assertNotNull(f.saved()!!.receipt)
        f.beforeGet = {}; withContext(scope.capture()!!) { f.repo.refresh() }; assertEquals(1, cues.size); scope.close()
    }
}
