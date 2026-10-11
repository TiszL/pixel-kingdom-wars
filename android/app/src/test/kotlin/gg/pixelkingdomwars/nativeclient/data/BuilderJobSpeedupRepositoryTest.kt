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

class BuilderJobSpeedupRepositoryTest {
    private class Disk : SecretStore {
        var raw: String? = null; var writes = 0; var failAt = -1
        override fun read() = raw
        private fun save(value: String?) { writes++; if (writes == failAt) throw IOException("Journal write failed"); raw = value }
        override fun write(value: String) = save(value)
        override fun clear() = save(null)
    }
    private class Fixture {
        val wire = FakeApiClient(); val holder = testHolder(); val session = signedIn(holder)
        val disk = Disk(); val store = PendingIntentStore(disk); val observer = ReceiptObserver(store)
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var support = 1; var keys = 0
        var active = true; var level = 1; var gems = "50"; var keep = "0"; var numericKeep = false
        var jobId = JOB; var kind = "upgrade"; var building: String? = BUILDING; var obstacle: String? = null
        var started = "2030-01-01T11:00:00.000Z"; var finishes = "2030-01-01T12:00:00.000Z"; var cost = "37"
        var quote: (JsonObject) -> JsonElement = { it }; var accepted = false; var charged = "37"
        var afterAccount: suspend () -> Unit = {}; var beforeBase: suspend () -> Unit = {}; var afterReceipt: () -> Unit = {}
        var beforeEnqueue: () -> Unit = {}; val sent = mutableListOf<PendingIntent>()
        var post: suspend () -> JsonObject = { accepted = true; charged = cost; active = false; level = 4; json("{}") }
        val api = object : ApiClient by wire {
            override suspend fun postMoneyCommand(path: String, body: JsonObject, currency: GameCurrency?, refusal: (ApiException) -> Unit, requireCurrent: () -> Unit): JsonObject {
                beforeEnqueue(); requireCurrent()
                val saved = requireNotNull(saved()); assertTrue(saved.attempted); assertTrue(saved.attemptRevision > 0)
                assertEquals(saved.path, path); assertEquals(saved.body, body); assertEquals(saved.expectedCurrency, currency?.name); sent += saved
                return try { post() } catch (error: ApiException) { refusal(error); throw error }
            }
        }
        val repo = LiveBaseRepository(session, holder, api, store, observer, { selected }, newKey = { "builder-review-${++keys}" },
            refreshAccount = { afterAccount() }, baseGeneration = { generation }, builderActionsAllowed = { allowed })
        init {
            wire.onGet("/native/capabilities") { json("""{"economy":{"gameCurrency":{"version":1,"exactSpendCurrency":$support}}}""") }
            wire.onGet("/base") { query -> beforeBase(); home(requireNotNull(query["baseId"])) }
            wire.onGet("/balances") { buildJsonObject {
                put("shards", "500"); put("gems", gems); put("keep", if (numericKeep) JsonPrimitive(keep.toLong()) else JsonPrimitive(keep))
                put("features", json("""{"gameCurrency":{"version":1,"exactSpendCurrency":1},"gems":{"version":1,"receipts":1}}"""))
            } }
            wire.onGet("/tutorial") { tutorialJson() }
            wire.onGet(BuilderJobSpeedup.RECEIPT) { query ->
                val original = requireNotNull(saved()); assertEquals(ConstructionSpec.builderTerms(original).query, query)
                (if (accepted) proof(original) else json("""{"version":1,"status":"unknown","idempotencyKey":"${original.idempotencyKey}"}""")).also { afterReceipt() }
            }
        }
        fun saved() = store.get(IntentKind.CONSTRUCTION, WALLET)
        fun roundtrip() { selected = JOB; generation++; selected = BASE_ID; generation++ }
        fun job() = buildJsonObject {
            val consent = buildJsonObject {
                put("version", 1); put("kind", kind); put("buildingId", building?.let(::JsonPrimitive) ?: JsonNull)
                put("obstacleId", obstacle?.let(::JsonPrimitive) ?: JsonNull); put("startedAt", started); put("finishesAt", finishes); put("maxCostKeep", cost)
            }
            consent.filterKeys { it !in setOf("version", "maxCostKeep") }.forEach { (k, v) -> put(k, v) }
            put("id", jobId); put("finishCostKeep", cost); put("paidFinishQuote", quote(consent))
        }
        fun home(base: String) = JsonObject(baseJson(base, if (active) "[${job()}]" else "[]") + mapOf(
            "features" to json("""{"builderJobSpeedup":{"version":$support,"receipts":1}}"""),
            "buildings" to JsonArray(baseJson().getValue("buildings").jsonArray.map { JsonObject(it.jsonObject + ("level" to JsonPrimitive(level))) })))
        fun proof(saved: PendingIntent) = buildJsonObject {
            val terms = ConstructionSpec.builderTerms(saved)
            put("version", 1); put("status", "accepted"); put("wallet", WALLET); put("request", terms.json)
            put("receiptId", JOB); put("acceptedAt", "2030-01-01T11:30:00.000Z")
            put("funding", buildJsonObject { put("currency", terms.expectedCurrency.name); put("amount", charged) })
            put("result", buildJsonObject { put("jobId", terms.jobId); put("kind", terms.consent.kind)
                put("buildingId", terms.consent.buildingId?.let(::JsonPrimitive) ?: JsonNull); put("obstacleId", terms.consent.obstacleId?.let(::JsonPrimitive) ?: JsonNull)
                put("completedAt", "2030-01-01T11:30:00.000Z") })
        }
    }
    @Test fun `review does not journal and confirm durably saves full consent before exact send and fresh Home`() = runBlocking {
        val f = Fixture(); f.repo.reviewBuilderFinish(JOB); val original = f.repo.state.value.builderFinishReview!!.intent
        assertNull(f.saved()); assertEquals("GEMS", original.expectedCurrency); assertTrue(f.sent.isEmpty())
        f.beforeBase = { if (f.accepted) assertNotNull(f.saved()?.receipt) }
        f.repo.confirmBuilderFinish()
        assertEquals(original.nextAttempt(), f.sent.single()); assertNull(f.saved()); assertEquals(4, f.repo.state.value.base!!.buildings.single().level)
        assertTrue(f.wire.posts.isEmpty()); assertNull(f.repo.state.value.builderFinishReview)
    }
    @Test fun `whole KEEP stays KEEP after Gems arrive and neither split funds nor post-review currency fallback is allowed`() = runBlocking {
        val f = Fixture(); f.gems = "36"; f.keep = "37"; f.repo.reviewBuilderFinish(JOB)
        assertEquals("KEEP", f.repo.state.value.builderFinishReview!!.intent.expectedCurrency)
        f.gems = "100"; f.repo.confirmBuilderFinish(); assertEquals("KEEP", f.sent.single().expectedCurrency)
        val split = Fixture(); split.gems = "20"; split.keep = "20"
        assertThrows(Exception::class.java) { runBlocking { split.repo.reviewBuilderFinish(JOB) } }; assertNull(split.saved())
        val changed = Fixture(); changed.repo.reviewBuilderFinish(JOB); changed.gems = "0"; changed.keep = "100"
        assertThrows(Exception::class.java) { runBlocking { changed.repo.confirmBuilderFinish() } }; assertTrue(changed.sent.isEmpty()); assertNull(changed.saved())
    }
    @Test fun `cheaper server quote keeps complete original episode and ceiling while replacements fail before saving`() = runBlocking {
        val f = Fixture(); f.repo.reviewBuilderFinish(JOB); val original = f.repo.state.value.builderFinishReview!!.intent
        f.cost = "25"; f.gems = "25"; f.repo.confirmBuilderFinish(); assertEquals(original.nextAttempt(), f.sent.single())
        for (case in 0..6) {
            val bad = Fixture(); bad.repo.reviewBuilderFinish(JOB)
            when (case) { 0 -> bad.jobId = BUILDING; 1 -> bad.building = JOB; 2 -> bad.started = "2030-01-01T10:00:00.000Z"
                3 -> bad.finishes = "2030-01-01T12:01:00.000Z"; 4 -> bad.cost = "38"; 5 -> bad.active = false; else -> bad.kind = "repair" }
            assertThrows(Exception::class.java) { runBlocking { bad.repo.confirmBuilderFinish() } }; assertTrue(bad.sent.isEmpty()); assertNull(bad.saved())
        }
    }
    @Test fun `new payment refuses free build zero missing capability and lenient numeric balances`() = runBlocking {
        for (confirm in listOf(false, true)) for (case in 0..5) {
            val f = Fixture(); if (confirm) f.repo.reviewBuilderFinish(JOB)
            when (case) { 0 -> f.kind = "build"; 1 -> f.cost = "0"; 2 -> f.quote = { JsonNull }; 3 -> f.support = 2
                4 -> f.allowed = false; else -> { f.gems = "0"; f.keep = "100"; f.numericKeep = true } }
            assertThrows(Exception::class.java) { runBlocking { if (confirm) f.repo.confirmBuilderFinish() else f.repo.reviewBuilderFinish(JOB) } }
            assertTrue(f.sent.isEmpty()); assertNull(f.saved())
        }
        val f = Fixture(); val dark = LiveBaseRepository(f.session, f.holder, f.api, f.store, ReceiptObserver(f.store), { BASE_ID })
        assertThrows(Exception::class.java) { runBlocking { dark.reviewBuilderFinish(JOB) } }; assertTrue(f.wire.gets.isEmpty())
    }
    @Test fun `read and actual enqueue recheck session base ABA dismissal and pause`() = runBlocking {
        for (stage in listOf("read", "enqueue")) for (change in listOf("session", "base", "dismiss", "pause", "home")) {
            val f = Fixture()
            val invalidate = { when (change) { "session" -> f.holder.replace(null); "base" -> f.roundtrip(); "dismiss" -> f.repo.dismissBuilderFinishReview()
                "home" -> runBlocking { f.repo.refresh() }; else -> f.allowed = false }; Unit }
            if (stage == "read") f.afterAccount = { invalidate() } else { f.repo.reviewBuilderFinish(JOB); f.beforeEnqueue = invalidate }
            assertThrows(Exception::class.java) { runBlocking { if (stage == "read") f.repo.reviewBuilderFinish(JOB) else f.repo.confirmBuilderFinish() } }
            assertTrue(f.sent.isEmpty()); assertNull(f.repo.state.value.builderFinishReview)
            if (stage == "enqueue") assertTrue(f.saved()!!.attempted) else assertNull(f.saved())
        }
    }
    // Owner Seeker 2026-10-06 16:45: "The builder review closed. Check its original receipt." on a FINISH. The screen closed
    // the review for its own reasons (raid-interlock flips, a recomposed Home) while the payment was still reading or sending
    // (~4 s per QA /base, K-night-07). Those closes are not the player's CANCEL, so they must never withdraw an in-flight payment.
    @Test fun `a screen-driven close during an in-flight payment completes the original consent and retires the review after`() = runBlocking {
        for (stage in listOf("read", "enqueue", "hydrate")) {
            val f = Fixture(); f.repo.reviewBuilderFinish(JOB); val original = f.repo.state.value.builderFinishReview!!.intent
            var closes = 0; val close = { closes++; f.repo.retireBuilderFinishReview() }
            when (stage) { "read" -> f.afterAccount = { close() }; "enqueue" -> f.beforeEnqueue = { close() }
                else -> f.beforeBase = { if (f.accepted) close() } }
            f.repo.confirmBuilderFinish()
            assertTrue(stage, closes > 0); assertEquals(stage, original.nextAttempt(), f.sent.single()); assertNull(stage, f.saved())
            assertEquals(stage, 4, f.repo.state.value.base!!.buildings.single().level); assertNull(stage, f.repo.state.value.error)
            assertNull(stage, f.repo.state.value.builderFinishReview)
        }
    }
    // The retire only stops a presentation close from fencing; the payment's own guards are the fail-closed rules and stay:
    // a raid lock / update gate (admission), a changed kingdom, and a changed price (K155: a changed quote forces a new review).
    @Test fun `a screen-driven close cannot carry a payment past a raid lock a changed kingdom or a changed price`() = runBlocking {
        for (change in listOf("pause", "base", "price")) {
            val f = Fixture(); f.repo.reviewBuilderFinish(JOB)
            f.afterAccount = { f.repo.retireBuilderFinishReview(); when (change) { "pause" -> f.allowed = false; "base" -> f.roundtrip(); else -> f.cost = "38" } }
            assertThrows(Exception::class.java) { runBlocking { f.repo.confirmBuilderFinish() } }
            assertTrue(change, f.sent.isEmpty()); assertNull(change, f.saved()); assertNull(change, f.repo.state.value.builderFinishReview)
        }
    }
    @Test fun `a screen-driven close still retires an unsubmitted review and never fences a receipt read with no review open`() = runBlocking {
        // Unsubmitted: the shown review closes at once and its stale terms cannot be paid.
        val f = Fixture(); f.repo.reviewBuilderFinish(JOB); f.repo.retireBuilderFinishReview()
        assertNull(f.repo.state.value.builderFinishReview)
        assertThrows(Exception::class.java) { runBlocking { f.repo.confirmBuilderFinish() } }; assertTrue(f.sent.isEmpty())
        // A Home resume re-reads an accepted saved payment (GET only) while the interlock restarts and flips: the receipt is
        // proof of a real charge, so the screen's close must not turn it into a red "review closed" and keep it saved again.
        val g = Fixture(); g.repo.reviewBuilderFinish(JOB); g.post = { g.accepted = true; throw IOException("lost after commit") }
        assertThrows(IOException::class.java) { runBlocking { g.repo.confirmBuilderFinish() } }
        g.beforeBase = { g.repo.retireBuilderFinishReview() }
        assertTrue(g.observer.check(IntentKind.CONSTRUCTION, WALLET) is Receipt.Accepted)
        assertNull(g.saved()); assertEquals(1, g.sent.size); assertEquals(BASE_ID, g.repo.state.value.base!!.baseId)
    }
    @Test fun `newer ordinary Home refresh supersedes both review and historical publication without losing receipt`() = runBlocking {
        for (history in listOf(false, true)) {
            val f = Fixture(); if (history) f.repo.reviewBuilderFinish(JOB)
            f.beforeBase = {
                if (!history || f.accepted) { f.beforeBase = {}; f.level = 8; f.repo.refresh() }
            }
            assertThrows(Exception::class.java) { runBlocking { if (history) f.repo.confirmBuilderFinish() else f.repo.reviewBuilderFinish(JOB) } }
            assertEquals(8, f.repo.state.value.base!!.buildings.single().level)
            if (history) assertNotNull(f.saved()?.receipt) else { assertNull(f.saved()); assertTrue(f.sent.isEmpty()) }
        }
    }
    @Test fun `accepted proof survives obsolete hydration and recovers without base or current admission reads`() = runBlocking {
        for (change in listOf("receipt", "home", "pause")) {
            val f = Fixture(); f.repo.reviewBuilderFinish(JOB)
            when (change) { "home" -> f.beforeBase = { if (f.accepted) f.roundtrip() }; "pause" -> f.afterReceipt = { f.allowed = false }; else -> f.afterReceipt = { f.roundtrip() } }
            assertThrows(Exception::class.java) { runBlocking { f.repo.confirmBuilderFinish() } }; assertNotNull(f.saved()?.receipt)
            f.selected = null; f.generation++; f.allowed = false; f.support = 2; f.beforeBase = {}; f.afterReceipt = {}
            val reads = f.wire.gets.size
            assertTrue(f.observer.check(IntentKind.CONSTRUCTION, WALLET) is Receipt.Accepted)
            assertEquals(reads, f.wire.gets.size); assertNull(f.saved()); assertNull(f.repo.state.value.base); assertNull(f.repo.state.value.balances)
            assertEquals(1, f.sent.size)
        }
    }
    @Test fun `lost acknowledgement uses original GET before same key explicit retry and can recover after last base loss`() = runBlocking {
        val f = Fixture(); f.repo.reviewBuilderFinish(JOB); val original = f.repo.state.value.builderFinishReview!!.intent
        f.post = { throw IOException("lost reply") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmBuilderFinish() } }
        val reads = f.wire.gets.size; f.repo.reviewSavedBuilderFinish()
        assertEquals(BuilderJobSpeedup.RECEIPT, f.wire.gets[reads].first); assertEquals(1, f.sent.size)
        assertEquals(original.nextAttempt(), f.repo.state.value.builderFinishReview!!.intent)
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmBuilderFinish() } }
        assertEquals(original.nextAttempt().nextAttempt(), f.saved()); assertEquals(1, f.keys)
        f.accepted = true; f.selected = null; f.generation++; f.allowed = false; f.support = 2
        val recoveryReads = f.wire.gets.size; f.repo.reviewSavedBuilderFinish()
        assertEquals(listOf(BuilderJobSpeedup.RECEIPT), f.wire.gets.drop(recoveryReads).map { it.first }); assertNull(f.saved()); assertEquals(2, f.sent.size)
    }
    @Test fun `historical receipt keeps original base identity while refreshing a different selected kingdom`() = runBlocking {
        val f = Fixture(); f.repo.reviewBuilderFinish(JOB); f.post = { f.accepted = true; throw IOException("lost after commit") }
        assertThrows(IOException::class.java) { runBlocking { f.repo.confirmBuilderFinish() } }
        f.selected = JOB; f.generation++; f.allowed = false; f.support = 2; f.active = false; f.level = 7
        val reads = f.wire.gets.size; f.repo.reviewSavedBuilderFinish()
        val recovery = f.wire.gets.drop(reads)
        assertEquals(BuilderJobSpeedup.RECEIPT, recovery.first().first); assertEquals(BASE_ID, recovery.first().second["baseId"])
        assertEquals(listOf("/base", "/balances", "/tutorial"), recovery.drop(1).map { it.first })
        assertTrue(recovery.drop(1).all { it.second["baseId"] == JOB }); assertEquals(JOB, f.repo.state.value.base!!.baseId)
        assertEquals(7, f.repo.state.value.base!!.buildings.single().level); assertNull(f.saved()); assertEquals(1, f.sent.size)
    }
    @Test fun `journal failures at create attempt proof and retirement preserve the original recoverable boundary`() = runBlocking {
        for (failure in 1..4) {
            val f = Fixture(); f.repo.reviewBuilderFinish(JOB); val original = f.repo.state.value.builderFinishReview!!.intent; f.disk.failAt = failure
            assertThrows(IOException::class.java) { runBlocking { f.repo.confirmBuilderFinish() } }
            assertEquals(if (failure <= 2) 0 else 1, f.sent.size)
            when (failure) { 1 -> assertNull(f.saved()); 2 -> assertEquals(original, f.saved()); 3 -> assertEquals(original.nextAttempt(), f.saved()); 4 -> assertNotNull(f.saved()?.receipt) }
            f.disk.failAt = -1
            if (failure == 2) { f.repo.reviewSavedBuilderFinish(); f.repo.confirmBuilderFinish(); assertEquals(original.nextAttempt(), f.sent.single()); assertNull(f.saved()) }
            if (failure >= 3) { f.selected = null; f.generation++; f.allowed = false; f.repo.reviewSavedBuilderFinish(); assertNull(f.saved()); assertEquals(1, f.sent.size) }
        }
    }
    @Test fun `damaged modern saved commands cannot use legacy retry or be overwritten`() = runBlocking {
        val f = Fixture(); f.repo.reviewBuilderFinish(JOB); val damaged = f.repo.state.value.builderFinishReview!!.intent.copy(expectedCurrency = null).nextAttempt()
        f.repo.dismissBuilderFinishReview(); assertTrue(f.store.create(damaged)); val originalBytes = f.disk.raw
        assertThrows(Exception::class.java) { runBlocking { f.repo.reviewSavedBuilderFinish() } }
        assertThrows(Exception::class.java) { runBlocking { f.repo.construction.retry(WALLET) {} } }
        assertThrows(Exception::class.java) { runBlocking { f.repo.reviewBuilderFinish(JOB) } }
        assertEquals(originalBytes, f.disk.raw); assertTrue(f.sent.isEmpty()); assertTrue(f.wire.posts.isEmpty())
    }
    @Test fun `ordinary observer retry cannot dispatch a modern command and unreadable journals remain untouched`() = runBlocking {
        val f = Fixture(); f.repo.reviewBuilderFinish(JOB); val original = f.repo.state.value.builderFinishReview!!.intent
        assertTrue(f.store.create(original.nextAttempt()))
        // Even a still-open review is insufficient: only confirm installs the fresh enqueue guard.
        assertThrows(Exception::class.java) { runBlocking { f.observer.retry(IntentKind.CONSTRUCTION, WALLET) } }
        assertTrue(f.sent.isEmpty()); assertTrue(f.wire.posts.isEmpty()); assertEquals(original.nextAttempt().nextAttempt(), f.saved())
        val broken = Fixture(); broken.disk.raw = "{unreadable original journal"
        assertThrows(Exception::class.java) { runBlocking { broken.repo.reviewBuilderFinish(JOB) } }
        assertEquals("{unreadable original journal", broken.disk.raw); assertTrue(broken.sent.isEmpty()); assertEquals(0, broken.disk.writes)
    }
    @Test fun `cancelled dispatched command stays unknown and legacy free finish keeps ordinary transport`() = runBlocking {
        val f = Fixture(); f.repo.reviewBuilderFinish(JOB); val original = f.repo.state.value.builderFinishReview!!.intent
        f.post = { throw CancellationException("view ended") }
        assertThrows(CancellationException::class.java) { runBlocking { f.repo.confirmBuilderFinish() } }; assertEquals(original.nextAttempt(), f.saved())
        val legacy = Fixture(); legacy.wire.onPost("/base/jobs/$JOB/speedup") { json("""{"cost":"0"}""") }
        legacy.repo.finishJob(JOB); assertEquals(1, legacy.wire.posts.size); assertTrue(legacy.sent.isEmpty()); assertNull(legacy.saved())
        val old = PendingIntent(IntentKind.CONSTRUCTION, WALLET, BASE_ID, "legacy-builder-key", "/base/jobs/$JOB/speedup",
            json("""{"baseId":"$BASE_ID","idempotencyKey":"legacy-builder-key"}"""), "Legacy finish").nextAttempt()
        assertTrue(legacy.store.create(old)); val reads = legacy.wire.gets.size
        assertThrows(Exception::class.java) { runBlocking { legacy.repo.reviewSavedBuilderFinish() } }
        // Rewritten 2026-10-06 (dead-end audit): this pinned that a legacy finish had no read at all, which let a lost reply
        // block construction forever. GET /base now proves the finish was not applied while its job still runs: one read,
        // Absent (owner review M1: CLOSE may archive it once settled), and still nothing is sent.
        assertEquals(Receipt.Absent, legacy.observer.check(IntentKind.CONSTRUCTION, WALLET)); assertEquals(reads + 1, legacy.wire.gets.size)
        assertEquals("/base", legacy.wire.gets.last().first); assertEquals(1, legacy.wire.posts.size)
        legacy.repo.construction.retry(WALLET) {}; assertEquals(2, legacy.wire.posts.size); assertNull(legacy.saved())
    }
    companion object {
        const val JOB = "22222222-2222-4222-8222-222222222222"
        const val BUILDING = "eee0575f-6df7-4672-91ea-33f497d2e1d6"
    }
}
