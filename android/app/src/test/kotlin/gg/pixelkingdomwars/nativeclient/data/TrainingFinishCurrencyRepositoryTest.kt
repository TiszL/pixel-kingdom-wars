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

class TrainingFinishCurrencyRepositoryTest {
    private class Fixture {
        val wire = FakeApiClient(); val holder = testHolder(); val session = signedIn(holder)
        val disk = MemoryStore(); val store = PendingIntentStore(disk); val observer = ReceiptObserver(store)
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var count = 7
        var cost = "37"; var gems = "50"; var keep = "0"; var support = 1; var keys = 0; var homePublications = 0
        var queue = listOf(QueueConsentRow(ROW, "2030-01-01T11:00:00.000Z", "2030-01-01T12:00:00.000Z"),
            QueueConsentRow(ROW2, "2030-01-01T12:00:00.000Z", "2030-01-01T13:00:00.000Z"))
        var completedAt = "2030-01-01T11:30:00.000Z"
        var offer: JsonElement? = JsonNull; var eligibility: JsonElement? = JsonPrimitive(false)
        var catalogue: JsonObject? = json("""{"constants":{"TROOPS":{"highlander":{}},"TRAINING_SCHEDULE":{"version":2,"lanesPerBase":1,"maxConsentQueueRows":3}}}""")
        var afterAccount: suspend () -> Unit = {}; var beforeEnqueue: () -> Unit = {}; var beforeHome: suspend () -> Unit = {}
        var afterReceipt: () -> Unit = {}; val sent = mutableListOf<PendingIntent>()
        var post: suspend () -> JsonObject = { count = 99; queue = emptyList(); json("{}") }
        val api = object : ApiClient by wire {
            override suspend fun postMoneyCommand(path: String, body: JsonObject, currency: GameCurrency?, refusal: (ApiException) -> Unit, requireCurrent: () -> Unit): JsonObject {
                beforeEnqueue(); requireCurrent()
                val saved = requireNotNull(saved()); assertEquals(saved.body, body); assertEquals(saved.expectedCurrency, currency?.name)
                assertTrue(saved.attempted); assertTrue(saved.attemptRevision > 0); sent += saved
                return try { post() } catch (error: ApiException) { refusal(error); throw error }
            }
        }
        val repo = LiveArmyRepository(session, holder, api, store, observer, { selected }, { catalogue }, { BaseState() }, {},
            newKey = { "training-review-${++keys}" }, refreshAccount = { afterAccount() }, baseGeneration = { generation }, heroActionsAllowed = { allowed },
            hydrateTrainingFinishHome = { guard -> beforeHome(); guard(); homePublications++ })
        init {
            wire.onGet("/native/capabilities") { json("""{"economy":{"gameCurrency":{"version":1,"exactSpendCurrency":$support}}}""") }
            wire.onGet("/balances") { json("""{"gems":"$gems","keep":"$keep","features":{"gameCurrency":{"version":1,"exactSpendCurrency":1},"gems":{"version":1,"receipts":1}}}""") }
            wire.onGet("/army") { army() }
            wire.onGet(TrainingFinish.RECEIPT) { query ->
                val saved = requireNotNull(saved()); assertEquals(TrainingFinishSpec.exact(saved).query, query)
                proof(saved).also { afterReceipt() }
            }
        }
        fun row(r: QueueConsentRow) = buildJsonObject { put("id", r.id); put("startedAt", r.startedAt); put("finishesAt", r.finishesAt) }
        fun army() = buildJsonObject {
            put("counts", buildJsonObject { put("highlander", count) }); put("levels", buildJsonObject { put("highlander", 1) })
            put("features", json("""{"trainingScheduling":{"version":2,"mode":"sequential","lanes":1,"consentRequired":true},"trainingFinishReceipts":{"version":$support}}"""))
            put("queue", JsonArray(queue.map { JsonObject(row(it) + ("troop" to JsonPrimitive("highlander"))) }))
            put("finishAllQuote", buildJsonObject { put("version", 2); put("maxCostKeep", if (queue.isEmpty()) "0" else cost); put("queue", JsonArray(queue.map(::row))) })
            offer?.let { put("freeFinishAllOffer", it) }; eligibility?.let { put("freeFinishAllReviewRequired", it) }
        }
        fun saved() = store.get(IntentKind.TRAINING_FINISH, WALLET)
        fun roundtrip() { selected = ROW; generation++; selected = BASE_ID; generation++ }
        fun proof(saved: PendingIntent) = buildJsonObject {
            val terms = TrainingFinishSpec.exact(saved); val paid = terms.queue.filter { it.finishesAt > completedAt }
            put("version", 1); put("status", "accepted"); put("wallet", WALLET); put("request", terms.json)
            put("receiptId", ROW); put("acceptedAt", completedAt)
            put("funding", buildJsonObject { put("currency", terms.expectedCurrency.name); put("amount", cost) })
            put("result", buildJsonObject {
                put("completedAt", completedAt); put("paidRows", JsonArray(paid.map { JsonObject(row(it) + ("troop" to JsonPrimitive("highlander"))) }))
                put("completed", buildJsonArray { add(buildJsonObject { put("troop", "highlander"); put("count", paid.size) }) })
            })
        }
    }
    @Test fun `whole Gems consent is saved before exact send and only fresh army counts are published`() = runBlocking {
        val f = Fixture(); f.repo.reviewTrainingFinish(); val review = requireNotNull(f.repo.state.value.trainingFinishReview)
        assertEquals("GEMS", review.intent.expectedCurrency); assertNull(f.saved())
        f.beforeHome = { assertNotNull(f.saved()?.receipt) }
        f.repo.confirmTrainingFinish()
        assertEquals(review.intent.nextAttempt(), f.sent.single()); assertNull(f.saved()); assertEquals(99, f.repo.state.value.army!!.counts["highlander"])
        assertEquals(1, f.homePublications); assertTrue(f.wire.posts.isEmpty())
    }
    @Test fun `whole KEEP selection cannot combine funds or switch currency after review`() = runBlocking {
        val f = Fixture(); f.gems = "36"; f.keep = "37"; f.repo.reviewTrainingFinish()
        assertEquals("KEEP", f.repo.state.value.trainingFinishReview!!.intent.expectedCurrency)
        f.gems = "100"; f.repo.confirmTrainingFinish(); assertEquals("KEEP", f.sent.single().expectedCurrency)
        val short = Fixture(); short.gems = "20"; short.keep = "20"
        assertThrows(Exception::class.java) { runBlocking { short.repo.reviewTrainingFinish() } }; assertNull(short.saved())
        val changed = Fixture(); changed.repo.reviewTrainingFinish(); changed.gems = "0"; changed.keep = "100"
        assertThrows(Exception::class.java) { runBlocking { changed.repo.confirmTrainingFinish() } }; assertTrue(changed.sent.isEmpty()); assertNull(changed.saved())
    }
    @Test fun `free eligible unknown malformed or review pending status never authorizes paid dispatch`() = runBlocking {
        for (confirm in listOf(false, true)) for (case in 0..4) {
            val f = Fixture(); if (confirm) f.repo.reviewTrainingFinish()
            when (case) { 0 -> f.offer = null; 1 -> f.offer = json("""{"offer":"first_troops","consent":{"version":2,"queue":[],"maxCostKeep":"0"}}""")
                2 -> f.offer = JsonPrimitive(false); 3 -> f.eligibility = JsonPrimitive(true); else -> f.eligibility = null }
            assertThrows(Exception::class.java) { runBlocking { if (confirm) f.repo.confirmTrainingFinish() else f.repo.reviewTrainingFinish() } }
            assertTrue(f.sent.isEmpty()); assertNull(f.saved())
        }
    }
    @Test fun `natural completion and cheaper quote retain full original body while replacement timers and higher price fail`() = runBlocking {
        val f = Fixture(); f.repo.reviewTrainingFinish(); val original = f.repo.state.value.trainingFinishReview!!.intent
        f.queue = f.queue.drop(1); f.cost = "25"; f.gems = "25"; f.completedAt = "2030-01-01T12:30:00.000Z"
        f.repo.confirmTrainingFinish(); assertEquals(original.nextAttempt(), f.sent.single())
        assertEquals(2, TrainingFinishSpec.exact(f.sent.single()).queue.size); assertEquals("37", TrainingFinishSpec.exact(f.sent.single()).maxCostKeep)
        for (case in 0..5) {
            val bad = Fixture(); bad.repo.reviewTrainingFinish()
            when (case) { 0 -> bad.queue = listOf(bad.queue.first().copy(id = BASE_ID)); 1 -> bad.queue = listOf(bad.queue.first().copy(finishesAt = "2030-01-01T12:01:00.000Z"))
                2 -> bad.cost = "38"; 3 -> bad.queue = emptyList(); 4 -> bad.support = 2; else -> bad.catalogue = null }
            assertThrows(Exception::class.java) { runBlocking { bad.repo.confirmTrainingFinish() } }; assertTrue(bad.sent.isEmpty()); assertNull(bad.saved())
        }
    }
    @Test fun `late admission and actual enqueue reject dismissal session base roundtrip and pause`() = runBlocking {
        for (stage in listOf("read", "enqueue")) for (change in listOf("dismiss", "base", "session", "gate")) {
            val f = Fixture()
            val invalidate = { when (change) { "dismiss" -> f.repo.dismissTrainingFinishReview(); "base" -> f.roundtrip(); "session" -> f.holder.replace(null); else -> f.allowed = false }; Unit }
            if (stage == "read") f.afterAccount = { invalidate() } else { f.repo.reviewTrainingFinish(); f.beforeEnqueue = invalidate }
            assertThrows(Exception::class.java) { runBlocking { if (stage == "read") f.repo.reviewTrainingFinish() else f.repo.confirmTrainingFinish() } }
            assertTrue(f.sent.isEmpty()); assertNull(f.repo.state.value.trainingFinishReview)
            if (stage == "enqueue") assertTrue(f.saved()!!.attempted) else assertNull(f.saved())
        }
    }
    @Test fun `historical acceptance survives obsolete hydration and recovers paused after last base loss`() = runBlocking {
        for (duringHome in listOf(false, true)) {
            val f = Fixture(); f.repo.reviewTrainingFinish()
            if (duringHome) f.beforeHome = { f.roundtrip() } else f.afterReceipt = { f.roundtrip() }
            assertThrows(Exception::class.java) { runBlocking { f.repo.confirmTrainingFinish() } }
            assertNotNull(f.saved()?.receipt); assertEquals(7, f.repo.state.value.army!!.counts["highlander"]); assertEquals(0, f.homePublications)
            f.selected = null; f.generation++; f.allowed = false; f.catalogue = null; f.support = 2; f.beforeHome = {}; f.afterReceipt = {}
            val reads = f.wire.gets.size
            assertTrue(f.observer.check(IntentKind.TRAINING_FINISH, WALLET) is Receipt.Accepted)
            assertNull(f.saved()); assertNull(f.repo.state.value.army); assertNull(f.repo.state.value.armyBaseId)
            assertEquals(reads, f.wire.gets.size); assertEquals(1, f.sent.size)
        }
    }
    @Test fun `lost reply checks GET before explicit retry of same key queue and currency`() = runBlocking {
        val f = Fixture(); f.repo.reviewTrainingFinish(); val original = f.repo.state.value.trainingFinishReview!!.intent
        f.post = { throw IOException("lost reply") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmTrainingFinish() } }
        f.wire.onGet(TrainingFinish.RECEIPT) { json("""{"version":1,"status":"unknown","idempotencyKey":"${original.idempotencyKey}"}""") }
        f.repo.reviewTrainingFinishSaved(); assertEquals(original.nextAttempt(), f.repo.state.value.trainingFinishReview!!.intent); assertEquals(1, f.sent.size)
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmTrainingFinish() } }
        assertEquals(original.nextAttempt().nextAttempt(), f.saved()); assertEquals(1, f.keys)
        f.selected = null; f.generation++; f.allowed = false; f.catalogue = null
        f.wire.onGet(TrainingFinish.RECEIPT) { f.proof(requireNotNull(f.saved())) }
        assertTrue(f.observer.check(IntentKind.TRAINING_FINISH, WALLET) is Receipt.Accepted); assertNull(f.saved()); assertEquals(2, f.sent.size)
    }
    @Test fun `newer army read prevents historical payment from publishing obsolete Home or Army`() = runBlocking {
        val f = Fixture(); f.repo.reviewTrainingFinish(); f.beforeHome = { f.repo.refreshArmy() }
        assertThrows(Exception::class.java) { runBlocking { f.repo.confirmTrainingFinish() } }
        assertNotNull(f.saved()?.receipt); assertEquals(0, f.homePublications); assertEquals(99, f.repo.state.value.army!!.counts["highlander"])
    }
    @Test fun `saved legacy paid finish keeps headerless GET recovery and cannot be reinterpreted as modern review`() = runBlocking {
        val f = Fixture(); val terms = PaidTrainingFinishIntent(BASE_ID, "legacy-finish-key", GameCurrency.KEEP, f.queue, "37")
        val legacy = PendingIntent(IntentKind.TRAINING_FINISH, WALLET, BASE_ID, terms.idempotencyKey, TrainingFinish.PATH, terms.body, "Legacy finish").nextAttempt()
        assertTrue(f.store.create(legacy)); assertThrows(IllegalStateException::class.java) { runBlocking { f.repo.reviewTrainingFinishSaved() } }
        assertEquals(legacy, f.saved()); assertTrue(f.wire.gets.isEmpty())
        f.queue = emptyList(); assertTrue(f.observer.check(IntentKind.TRAINING_FINISH, WALLET) is Receipt.Accepted)
        assertNull(f.saved()); assertTrue(f.sent.isEmpty()); assertTrue(f.wire.posts.isEmpty())
        assertTrue(f.wire.gets.all { it.first == "/army" })
    }
    companion object {
        const val ROW = "22222222-2222-4222-8222-222222222222"
        const val ROW2 = "33333333-3333-4333-8333-333333333333"
    }
}
