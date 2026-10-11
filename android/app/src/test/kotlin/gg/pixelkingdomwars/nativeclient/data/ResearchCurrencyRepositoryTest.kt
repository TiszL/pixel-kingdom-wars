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

class ResearchCurrencyRepositoryTest {
    private class Fixture {
        val wire = FakeApiClient(); val holder = testHolder(); val session = signedIn(holder)
        val disk = MemoryStore(); val store = PendingIntentStore(disk); val observer = ReceiptObserver(store)
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var level = 1
        var cost = "37"; var gems = "50"; var keep = "0"; var support = 1; var episode: String? = EPISODE
        var deadline = UNTIL; var quoteMissing = false; var keys = 0; var homePublications = 0
        var catalogue: JsonObject? = json("""{"constants":{"TROOPS":{"highlander":{}},"TROOP_LEVELING":{"maxLevel":3}}}""")
        var afterAccount: suspend () -> Unit = {}; var beforeEnqueue: () -> Unit = {}; var beforeHome: suspend () -> Unit = {}
        var afterReceipt: () -> Unit = {}; val sent = mutableListOf<PendingIntent>()
        var post: suspend () -> JsonObject = { level = 2; json("{}") }
        val api = object : ApiClient by wire {
            override suspend fun postMoneyCommand(path: String, body: JsonObject, currency: GameCurrency?, refusal: (ApiException) -> Unit, requireCurrent: () -> Unit): JsonObject {
                beforeEnqueue(); requireCurrent()
                val saved = requireNotNull(saved()); assertEquals(saved.body, body); assertEquals(saved.expectedCurrency, currency?.name)
                assertTrue(saved.attempted); assertTrue(saved.attemptRevision > 0); sent += saved
                return post()
            }
        }
        val repo = LiveArmyRepository(session, holder, api, store, observer, { selected }, { catalogue }, { BaseState() }, {},
            newKey = { "research-review-${++keys}" }, refreshAccount = { afterAccount() }, baseGeneration = { generation }, heroActionsAllowed = { allowed },
            hydrateResearchHome = { guard -> beforeHome(); guard(); homePublications++ })
        init {
            wire.onGet("/native/capabilities") { json("""{"economy":{"gameCurrency":{"version":1,"exactSpendCurrency":$support}}}""") }
            wire.onGet("/balances") { json("""{"gems":"$gems","keep":"$keep","features":{"gameCurrency":{"version":1,"exactSpendCurrency":1},"gems":{"version":1,"receipts":1}}}""") }
            wire.onGet("/army") { army() }
            wire.onGet(ResearchSpeedup.RECEIPT) { query ->
                val saved = requireNotNull(saved()); assertEquals(ResearchSpec.exact(saved).query, query)
                proof(saved).also { afterReceipt() }
            }
        }
        fun army() = buildJsonObject {
            put("levels", buildJsonObject { put("highlander", level) })
            put("features", json("""{"researchConsent":{"version":1},"researchSpeedupReceipts":{"version":$support}}"""))
            put("research", buildJsonArray { if (level == 1) add(buildJsonObject {
                put("troop", "highlander"); put("toLevel", 2); put("finishesAt", deadline); put("episodeId", episode?.let(::JsonPrimitive) ?: JsonNull)
                put("finishQuote", if (quoteMissing) JsonNull else buildJsonObject { put("currentLevel", 1); put("toLevel", 2); put("finishesAt", deadline)
                    put("episodeId", episode?.let(::JsonPrimitive) ?: JsonNull); put("maxCostKeep", cost) })
            }) })
        }
        fun saved() = store.get(IntentKind.RESEARCH, WALLET)
        fun roundtrip() { selected = EPISODE; generation++; selected = BASE_ID; generation++ }
        fun proof(saved: PendingIntent) = buildJsonObject {
            val terms = ResearchSpec.exact(saved)
            put("version", 1); put("status", "accepted"); put("wallet", WALLET); put("request", terms.json)
            put("receiptId", EPISODE); put("acceptedAt", "2026-09-21T13:00:00Z")
            put("funding", buildJsonObject { put("currency", terms.expectedCurrency.name); put("amount", cost) })
            put("result", buildJsonObject { put("troop", terms.troop); put("fromLevel", terms.currentLevel); put("toLevel", terms.toLevel) })
        }
    }
    @Test fun `whole Gems review persists exact command before send and publishes only hydrated army`() = runBlocking {
        val f = Fixture(); f.repo.reviewResearchFinish("highlander")
        val review = requireNotNull(f.repo.state.value.researchReview); assertEquals("GEMS", review.intent.expectedCurrency)
        assertNull(f.saved()); f.beforeHome = { assertNotNull(f.saved()?.receipt) }
        f.repo.confirmResearchFinish()
        assertEquals(review.intent.nextAttempt(), f.sent.single()); assertNull(f.saved()); assertEquals(2, f.repo.state.value.army!!.levels["highlander"])
        assertEquals(1, f.homePublications); assertTrue(f.wire.posts.isEmpty())
    }
    @Test fun `whole KEEP fallback at review never combines balances or switches after consent`() = runBlocking {
        val f = Fixture(); f.gems = "36"; f.keep = "37"; f.repo.reviewResearchFinish("highlander")
        assertEquals("KEEP", f.repo.state.value.researchReview!!.intent.expectedCurrency)
        f.gems = "100"; f.repo.confirmResearchFinish(); assertEquals("KEEP", f.sent.single().expectedCurrency)
        val short = Fixture(); short.gems = "20"; short.keep = "20"
        assertThrows(Exception::class.java) { runBlocking { short.repo.reviewResearchFinish("highlander") } }; assertNull(short.saved())
        val changed = Fixture(); changed.repo.reviewResearchFinish("highlander"); changed.gems = "0"; changed.keep = "100"
        assertThrows(Exception::class.java) { runBlocking { changed.repo.confirmResearchFinish() } }; assertTrue(changed.sent.isEmpty()); assertNull(changed.saved())
    }
    @Test fun `missing future malformed quote and mutable episode cannot admit a replacement debit`() = runBlocking {
        for (case in 0..5) {
            val f = Fixture()
            when (case) { 0 -> f.quoteMissing = true; 1 -> f.support = 2; 2 -> f.cost = "01"; 3 -> f.catalogue = null; 4 -> f.deadline = "bad"; else -> f.level = 2 }
            assertThrows(Exception::class.java) { runBlocking { f.repo.reviewResearchFinish("highlander") } }; assertNull(f.saved()); assertTrue(f.sent.isEmpty())
        }
        for (case in 0..3) {
            val f = Fixture(); f.repo.reviewResearchFinish("highlander")
            when (case) { 0 -> f.episode = null; 1 -> f.level = 2; 2 -> f.deadline = "2031-01-01T00:00:00Z"; else -> f.cost = "38" }
            assertThrows(Exception::class.java) { runBlocking { f.repo.confirmResearchFinish() } }; assertTrue(f.sent.isEmpty()); assertNull(f.saved())
        }
        val lower = Fixture(); lower.repo.reviewResearchFinish("highlander"); val original = lower.repo.state.value.researchReview!!.intent
        lower.cost = "35"; lower.repo.confirmResearchFinish(); assertEquals(original.nextAttempt(), lower.sent.single())
    }
    @Test fun `late review and actual enqueue check lifecycle base generation session and mutation gate`() = runBlocking {
        for (stage in listOf("read", "enqueue")) for (change in listOf("dismiss", "base", "session", "gate")) {
            val f = Fixture()
            val invalidate = { when (change) { "dismiss" -> f.repo.dismissResearchReview(); "base" -> f.roundtrip(); "session" -> f.holder.replace(null); else -> f.allowed = false }; Unit }
            if (stage == "read") f.afterAccount = { invalidate() } else { f.repo.reviewResearchFinish("highlander"); f.beforeEnqueue = invalidate }
            assertThrows(Exception::class.java) { runBlocking { if (stage == "read") f.repo.reviewResearchFinish("highlander") else f.repo.confirmResearchFinish() } }
            assertTrue(f.sent.isEmpty()); assertNull(f.repo.state.value.researchReview)
            if (stage == "enqueue") assertTrue(f.saved()!!.attempted) else assertNull(f.saved())
        }
    }
    @Test fun `accepted historical proof survives obsolete hydration and recovers paused without any selected base`() = runBlocking {
        for (duringHome in listOf(false, true)) {
            val f = Fixture(); f.repo.reviewResearchFinish("highlander")
            if (duringHome) f.beforeHome = { f.roundtrip() } else f.afterReceipt = { f.roundtrip() }
            assertThrows(Exception::class.java) { runBlocking { f.repo.confirmResearchFinish() } }
            assertNotNull(f.saved()?.receipt); assertEquals(1, f.repo.state.value.army!!.levels["highlander"]); assertEquals(0, f.homePublications)
            f.allowed = false; f.support = 2; f.catalogue = null; f.selected = null; f.generation++; f.beforeHome = {}; f.afterReceipt = {}
            val before = f.wire.gets.size
            assertTrue(f.observer.check(IntentKind.RESEARCH, WALLET) is Receipt.Accepted)
            assertNull(f.saved()); assertNull(f.repo.state.value.army); assertEquals(before, f.wire.gets.size); assertEquals(1, f.sent.size)
        }
    }
    @Test fun `lost reply rechecks original receipt GET only before explicit same key retry review`() = runBlocking {
        val f = Fixture(); f.repo.reviewResearchFinish("highlander"); val original = f.repo.state.value.researchReview!!.intent
        f.post = { throw IOException("lost reply") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmResearchFinish() } }
        f.wire.onGet(ResearchSpeedup.RECEIPT) { json("""{"version":1,"status":"unknown","idempotencyKey":"${original.idempotencyKey}"}""") }
        f.repo.reviewResearchSaved(); assertEquals(original.nextAttempt(), f.repo.state.value.researchReview!!.intent); assertEquals(1, f.sent.size)
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmResearchFinish() } }
        assertEquals(original.nextAttempt().nextAttempt(), f.saved()); assertEquals(1, f.keys)
        f.selected = null; f.generation++; f.allowed = false; f.catalogue = null
        f.wire.onGet(ResearchSpeedup.RECEIPT) { f.proof(requireNotNull(f.saved())) }
        assertTrue(f.observer.check(IntentKind.RESEARCH, WALLET) is Receipt.Accepted); assertNull(f.saved()); assertEquals(2, f.sent.size)
    }
    @Test fun `later army read wins and A to B to A never republishes an earlier full DTO`() = runBlocking {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var reads = 0
        f.wire.onGet("/army") {
            if (++reads == 1) { val old = f.army(); entered.complete(Unit); release.await(); old } else f.army()
        }
        val first = async { runCatching { f.repo.refreshArmy() } }; entered.await()
        f.level = 2; f.repo.refreshArmy(); release.complete(Unit); assertTrue(first.await().isFailure)
        assertEquals(2, f.repo.state.value.army!!.levels["highlander"])
        f.wire.onGet("/army") { f.army().also { f.roundtrip() } }
        f.level = 1; assertThrows(Exception::class.java) { runBlocking { f.repo.refreshArmy() } }
        assertEquals(2, f.repo.state.value.army!!.levels["highlander"])
    }
    @Test fun `later ordinary army read invalidates accepted research hydration before protected Home publication`() = runBlocking {
        val f = Fixture(); f.repo.reviewResearchFinish("highlander")
        f.beforeHome = { f.repo.refreshArmy() }
        assertThrows(Exception::class.java) { runBlocking { f.repo.confirmResearchFinish() } }
        assertNotNull(f.saved()?.receipt); assertEquals(0, f.homePublications); assertEquals(2, f.repo.state.value.army!!.levels["highlander"])
    }
    companion object {
        const val EPISODE = "22222222-2222-4222-8222-222222222222"
        const val UNTIL = "2030-01-01T12:00:00.000Z"
    }
}
