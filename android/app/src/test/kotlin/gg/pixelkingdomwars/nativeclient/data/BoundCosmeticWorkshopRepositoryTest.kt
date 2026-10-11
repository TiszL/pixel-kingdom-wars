package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Private HTTP fixture supplies original server terms; mutations/fake responses are explicitly synthetic.
 * Repository tests prove no native art/rendering, real transport, production-login or gameplay activation. */
class BoundCosmeticWorkshopRepositoryTest {
    private val json = Json { encodeDefaults = true }
    private fun source() = requireNotNull(javaClass.getResourceAsStream("/boundcosmetics/final-actual-http.json")).use { json.parseToJsonElement(it.readBytes().toString(Charsets.UTF_8)).jsonObject }
    private fun edit(raw: JsonObject, key: String, value: JsonElement) = JsonObject(raw + (key to value))
    private val fixtureWallet get() = source().getValue("wallet").jsonPrimitive.content
    private val base get() = source().getValue("selectedBase").jsonObject.getValue("baseId").jsonPrimitive.content
    private val original get() = BoundCosmeticProof.from(source().getValue("originals").jsonArray.single().jsonObject)
    private val recipeId get() = original.receipt!!.recipe.recipeId
    private val requestKey = "00000000-0000-4000-8000-000000000090"
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }
    private fun stamp(value: Instant) = DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(value)
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder, fixtureWallet); val memory = MemoryStore()
        val store = BoundCosmeticStore(memory, BoundCosmeticIdentity(session.origin, "devnet", session.wallet))
        val wire = FakeApiClient(); var selected: String? = base; var generation = 0L; var allowed = true; var artReady = true
        var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(base, "active", slot = 0)))
        // Synthetic precraft state restores exactly the inputs consumed in the captured original.
        private fun precraft(): JsonObject {
            val raw = source(); val b = raw.getValue("selectedBase").jsonObject
            val stock = b.getValue("craftingStock").jsonArray.map { value -> val row = value.jsonObject
                val input = original.receipt!!.recipe.inputs.find { it.itemId == row.getValue("itemId").jsonPrimitive.content }
                if (input == null) row else edit(row, "available", JsonPrimitive((row.getValue("available").jsonPrimitive.content.toBigInteger() + input.quantity.toBigInteger()).toString())) }
            return edit(edit(raw, "originals", JsonArray(emptyList())), "selectedBase", edit(b, "craftingStock", JsonArray(stock)))
        }
        var view = precraft(); var accepted = false; var completed = false
        var posts = 0; var puts = 0; var currentReads = 0; var receiptReads = 0; var previews = 0; var hydrates = 0
        var currentFailure = false; var previewFailure = false; var hydrationFailure = false; var queueUnavailable = false
        var beforeEnqueue: () -> Unit = {}; var afterView: () -> Unit = {}; var afterReceipt: () -> Unit = {}; var afterPost: () -> Unit = {}
        var onPost: suspend () -> Unit = { accepted = true }; var onPut: (() -> Unit)? = null
        var account: suspend () -> Unit = {}
        val preferences = mutableListOf<BoundCosmeticPreferenceRequest>()
        val rules = BoundCosmeticWorkshopRules({ check(!queueUnavailable) { "Canonical Workshop queue is unavailable" }; 1 }) { level -> source().getValue("recipes").jsonArray.map { it.jsonObject.getValue("recipe").jsonObject }
            .single { it.getValue("requiredFacility").jsonObject.getValue("level").jsonPrimitive.long == level }.getValue("outputId").jsonPrimitive.content }
        fun command(): BoundCosmeticCommand = (store.read().operation ?: store.read().archives.single()).command
        fun proof(): BoundCosmeticProof {
            val c = command(); val started = source().getValue("serverNow").jsonPrimitive.content; val ready = stamp(Instant.parse(started).plusSeconds(c.recipe.durationSec))
            return BoundCosmeticProof(1, session.wallet, c.key, if (completed) ready else started, if (accepted) "accepted" else "unknown",
                if (accepted) BoundCosmeticReceipt(session.wallet, c.key, c.request, c.recipe, c.appearance, original.receipt!!.blueprint, started, ready) else null,
                if (completed) BoundCosmeticCompletion(ready) else null)
        }
        fun rawProof() = json.encodeToJsonElement(BoundCosmeticProof.serializer(), proof()).jsonObject
        fun current(): JsonObject = if (accepted) edit(edit(view, "serverNow", JsonPrimitive(proof().serverNow)), "originals", JsonArray(listOf(rawProof()))) else view
        fun baseChange(change: (JsonObject) -> JsonObject) { view = edit(view, "selectedBase", change(view.getValue("selectedBase").jsonObject)) }
        val api = object : ApiClient by wire {
            override suspend fun getBoundCosmetic(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/bound-cosmetics") { currentReads++; assertNull(evidence)
                    if (currentFailure) throw IOException("current provider offline")
                    val result = current(); afterView(); return result }
                receiptReads++; assertTrue(query.isEmpty()); assertEquals(command().receiptPath, path)
                return rawProof().also { afterReceipt(); requireNotNull(evidence)(it); holder.requireCurrent(session) }
            }
            override suspend fun postBoundCosmetic(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject {
                beforeEnqueue(); guard(); assertEquals("/bound-cosmetics/jobs", path)
                val op = store.read().operation!!; assertTrue(op.attempted); assertEquals(op.command.request.body(), body); posts++
                onPost(); return rawProof().also { evidence(it); afterPost(); holder.requireCurrent(session) }
            }
            override suspend fun putBoundCosmeticPreference(body: JsonObject, guard: () -> Unit): JsonObject {
                beforeEnqueue(); guard(); puts++; val request = BoundCosmeticPreferenceRequest.from(body); preferences += request; onPut?.invoke()
                val next = (request.expectedRevision.toBigInteger() + java.math.BigInteger.ONE).toString()
                baseChange { edit(it, "preference", buildJsonObject { put("enabled", request.enabled); put("revision", next) }) }
                val visual = BoundCosmeticBaseRead.from(view.getValue("selectedBase").jsonObject.getValue("visual").jsonObject)
                return json.encodeToJsonElement(BoundCosmeticPreferenceResponse.serializer(), BoundCosmeticPreferenceResponse(base, request.enabled, next, visual)).jsonObject
            }
        }
        fun repository() = BoundCosmeticWorkshopRepository(session, holder, api, store, rules, { selected }, { generation }, { directory }, { account() },
            { guard -> hydrates++; if (hydrationFailure) throw IOException("snapshot unavailable"); guard() }, { allowed }, { artReady },
            { _, guard -> previews++; guard(); if (previewFailure) throw IOException("missing verified art"); guard() }, { requestKey })
        val repository = repository()
        suspend fun review(): BoundCosmeticWorkshopReview { repository.reviewStart(recipeId); return requireNotNull(repository.state.value.review) }
        suspend fun own(completed: Boolean = true) { review(); accepted = true; this.completed = completed; repository.check(); repository.refresh() }
    }
    @Test fun `explicit review saves server terms before one material POST and only server proof delivers`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); assertEquals(0, f.posts); assertFalse(f.store.read().operation!!.attempted)
        assertEquals(original.receipt!!.recipe, review.command.recipe); assertEquals(original.receipt!!.appearance, review.command.appearance)
        f.repository.confirm(review); assertEquals(1, f.posts); assertEquals(2, f.previews); assertNotNull(f.store.read().operation!!.proof)
        assertNull(f.store.read().operation!!.proof!!.completion); assertEquals(1, f.hydrates)
    }
    @Test fun `lost reply reopen recovery never replaces original and resend needs explicit fresh review`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); f.onPost = { throw IOException("lost reply") }
        rejects { runBlocking { f.repository.confirm(review) } }; val originalCommand = f.store.read().operation!!.command
        val reopened = f.repository(); reopened.refresh(); assertEquals(1, f.posts); assertEquals(originalCommand, reopened.state.value.journal.operation!!.command)
        // Rewritten 2026-10-06 (dead-end audit): the owner now lets archive close an attempted unknown once its own fresh
        // by-key read answers "unknown". What stays pinned: without that fresh answer the original is never archived.
        f.afterReceipt = { throw IOException("original receipt unavailable") }
        rejects { runBlocking { reopened.archive() } }; assertNotNull(f.store.read().operation); f.afterReceipt = {}
        reopened.reviewSaved(); f.onPost = { f.accepted = true }; reopened.confirm(reopened.state.value.review!!)
        assertEquals(2, f.posts); assertEquals(originalCommand, f.store.read().operation!!.command)
    }
    @Test fun `current provider outage cannot suppress original or archived completion recovery`() = runBlocking<Unit> {
        val f = Fixture(); f.review(); f.store.attempt(f.store.read()); f.accepted = true; f.currentFailure = true; f.allowed = false; f.artReady = false
        rejects { runBlocking { f.repository.refresh() } }; assertNotNull(f.store.read().operation!!.proof); assertEquals(1, f.receiptReads)
        f.repository.archive(); assertNull(f.store.read().operation); f.completed = true; val currentReads = f.currentReads
        f.repository.checkArchived(requestKey); assertNotNull(f.store.read().archives.single().proof!!.completion); assertEquals(currentReads, f.currentReads); assertEquals(0, f.posts)
    }
    @Test fun `account base ABA and lifecycle changes refuse obsolete review and actual enqueue`() = runBlocking<Unit> {
        for (reason in listOf("session", "baseABA", "lifecycle", "gate", "ownership")) {
            val f = Fixture(); val review = f.review()
            f.beforeEnqueue = { when (reason) { "session" -> f.holder.replace(null); "baseABA" -> f.generation += 2; "lifecycle" -> f.repository.dismiss(); "gate" -> f.allowed = false; else -> f.directory = f.directory!!.copy(bases = emptyList()) } }
            rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(reason, 0, f.posts); assertTrue(f.store.read().operation!!.attempted)
        }
        val f = Fixture(); f.afterView = { f.generation += 2 }; rejects { runBlocking { f.review() } }; assertNull(f.repository.state.value.view); assertNull(f.store.read().operation)
    }
    @Test fun `late POST original stays durable after account replacement without publishing old screen`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); f.afterPost = { f.holder.replace(null) }
        rejects { runBlocking { f.repository.confirm(review) } }; assertNotNull(f.store.read().operation!!.proof)
        assertNull(f.repository.state.value.journal.operation!!.proof); assertEquals(0, f.hydrates)
    }
    @Test fun `stock queue server readiness and native art changes before confirm never consume materials`() = runBlocking<Unit> {
        for (reason in listOf("stock", "queue", "server", "native", "pixels", "terms", "market")) {
            val f = Fixture(); val review = f.review()
            when (reason) {
                "stock" -> f.baseChange { b -> edit(b, "craftingStock", JsonArray(b.getValue("craftingStock").jsonArray.map { edit(it.jsonObject, "available", JsonPrimitive("0")) })) }
                "queue" -> f.baseChange { b -> edit(b, "queue", JsonArray(listOf(buildJsonObject { put("kind", "cosmetic"); put("jobId", requestKey)
                    put("recipe", json.encodeToJsonElement(BoundCosmeticRecipe.serializer(), review.command.recipe)); put("startedAt", source().getValue("serverNow")); put("readyAt", stamp(Instant.parse(source().getValue("serverNow").jsonPrimitive.content).plusSeconds(review.command.recipe.durationSec))) }))) }
                "server" -> f.view = edit(edit(f.view, "applicationReady", JsonPrimitive(false)), "acceptingJobs", JsonPrimitive(false))
                "native" -> f.artReady = false; "pixels" -> f.previewFailure = true
                "market" -> f.baseChange { b -> edit(b, "markets", JsonArray(b.getValue("markets").jsonArray.map { edit(it.jsonObject, "level", JsonPrimitive(999)) })) }
                else -> f.view = edit(f.view, "recipes", JsonArray(f.view.getValue("recipes").jsonArray.map { row -> edit(row.jsonObject, "recipe", edit(row.jsonObject.getValue("recipe").jsonObject, "durationSec", JsonPrimitive(77))) }))
            }
            rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(reason, 0, f.posts); assertFalse(f.store.read().operation!!.attempted); assertEquals(review.command, f.store.read().operation!!.command)
        }
    }
    @Test fun `unavailable native art blocks first review without saving a draft`() = runBlocking<Unit> {
        for (missing in listOf("admission", "pixels")) { val f = Fixture(); if (missing == "admission") f.artReady = false else f.previewFailure = true
            rejects { runBlocking { f.review() } }; assertNull(f.store.read().operation); assertEquals(0, f.posts) }
    }
    @Test fun `off survives cosmetic pause and absent native assets but retains global mutation fence`() = runBlocking<Unit> {
        val f = Fixture(); f.view = edit(edit(f.view, "applicationReady", JsonPrimitive(false)), "acceptingJobs", JsonPrimitive(false)); f.artReady = false
        f.repository.refresh(); f.repository.setPreference(false); assertEquals(1, f.puts); assertEquals(0, f.previews)
        f.allowed = false; rejects { runBlocking { f.repository.setPreference(false) } }; assertEquals(1, f.puts)
        f.allowed = true; rejects { runBlocking { f.repository.setPreference(true) } }; assertEquals(1, f.puts)
    }
    @Test fun `enable requires completed owned exact current tier and previews it without altering original`() = runBlocking<Unit> {
        val pending = Fixture(); pending.own(false); rejects { runBlocking { pending.repository.setPreference(true) } }; assertEquals(0, pending.puts)
        val owned = Fixture(); owned.own(); val frozen = owned.store.read().operation!!.proof; owned.repository.setPreference(true)
        assertEquals(1, owned.puts); assertEquals(frozen, owned.store.read().operation!!.proof)
        val tier2Level = source().getValue("recipes").jsonArray[1].jsonObject.getValue("recipe").jsonObject.getValue("requiredFacility").jsonObject.getValue("level")
        owned.baseChange { b -> edit(b, "markets", JsonArray(b.getValue("markets").jsonArray.map { edit(it.jsonObject, "level", tier2Level) })) }
        owned.repository.refresh(); rejects { runBlocking { owned.repository.setPreference(true) } }; assertEquals(1, owned.puts)
        owned.repository.setPreference(false); assertEquals(2, owned.puts)
    }
    @Test fun `CAS conflict refreshes current choice without silently inverting or resending`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.refresh(); val initial = (f.repository.state.value.view!!.selectedBase as BoundCosmeticSelectedBase.Available).preference.revision
        f.onPut = { f.baseChange { edit(it, "preference", buildJsonObject { put("enabled", true); put("revision", (initial.toBigInteger() + java.math.BigInteger.ONE).toString()) }) }
            throw ApiException(409, "BOUND_COSMETIC_PREFERENCE_CHANGED", "another window changed preference") }
        f.repository.setPreference(false); assertEquals(1, f.puts); assertEquals(initial, f.preferences.single().expectedRevision)
        assertTrue(f.repository.state.value.preferenceChanged); assertTrue((f.repository.state.value.view!!.selectedBase as BoundCosmeticSelectedBase.Available).preference.enabled)
    }
    @Test fun `stale view CAS cannot execute after same-base generation changes`() = runBlocking<Unit> {
        val f = Fixture(); f.repository.refresh(); f.generation += 2
        rejects { runBlocking { f.repository.setPreference(false) } }; assertEquals(0, f.puts)
    }
    @Test fun `accepted original survives current snapshot hydration failure`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); f.hydrationFailure = true
        rejects { runBlocking { f.repository.confirm(review) } }; assertNotNull(f.store.read().operation!!.proof)
        assertEquals(1, f.posts); f.allowed = false; f.repository.check(); assertEquals(1, f.posts)
    }
    @Test fun `process stores share original mutex across reauthentication and never reset corrupt bytes`() {
        var opens = 0; val stores = BoundCosmeticWorkshopStores { _, _, _ -> opens++; MemoryStore() }
        val a = stores.forIdentity("https://GAME.test:443/", "devnet", fixtureWallet); val b = stores.forIdentity("https://game.test", "devnet", fixtureWallet)
        assertSame(a, b); assertSame(a.requests, b.requests); assertEquals(1, opens)
        assertNotSame(a, stores.forIdentity("https://other.test", "devnet", fixtureWallet)); assertNotSame(a, stores.forIdentity("https://game.test", "mainnet-beta", fixtureWallet))
        val corrupt = MemoryStore("{bad"); rejects { BoundCosmeticWorkshopStores { _, _, _ -> corrupt }.forIdentity("https://game.test", "devnet", fixtureWallet) }; assertEquals("{bad", corrupt.read())
    }
    @Test fun `shared store mutex serializes two repositories and keeps one accepted original`() = runBlocking<Unit> {
        val f = Fixture(); val review = f.review(); val second = f.repository(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        coroutineScope { val first = async { f.repository.confirm(review) }; entered.await()
            val other = async { second.reviewSaved() }; yield(); assertFalse(other.isCompleted); assertEquals(1, f.posts)
            release.complete(Unit); first.await(); other.await() }
        assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof); assertNull(second.state.value.review)
    }
    @Test fun `missing canonical queue holds fresh views but never hides original accepted completion`() = runBlocking<Unit> {
        val f = Fixture(); f.own(completed = false)
        val receipt = f.store.read().operation!!.proof!!.receipt
        f.queueUnavailable = true; f.completed = true; f.allowed = false; f.artReady = false
        rejects { runBlocking { f.repository.refresh() } }
        assertNull(f.repository.state.value.view); assertFalse(f.repository.state.value.advertised)
        assertEquals(receipt, f.store.read().operation!!.proof!!.receipt)
        assertNotNull(f.store.read().operation!!.proof!!.completion)
        f.repository.archive(); val archived = f.store.read().archives.single()
        f.allowed = true; f.artReady = true
        rejects { runBlocking { f.repository.reviewStart(recipeId) } }
        assertNull(f.store.read().operation); assertEquals(archived, f.store.read().archives.single()); assertEquals(0, f.posts)
    }
    @Test fun `queued foreground refresh atomically waits for admission without sending a mutation`() = runBlocking<Unit> {
        withTimeout(1_000) {
            val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
            var firstAccountRead = true
            f.account = { if (firstAccountRead) { firstAccountRead = false; entered.complete(Unit); release.await() } }
            val first = async(start = CoroutineStart.UNDISPATCHED) { f.repository.refresh() }
            entered.await()
            val queued = async(start = CoroutineStart.UNDISPATCHED) { f.repository.refresh(waitForIdle = true) }
            assertFalse(queued.isCompleted); assertEquals(0, f.currentReads); assertEquals(0, f.posts)
            release.complete(Unit); first.await(); queued.await()
            assertEquals(2, f.currentReads); assertEquals(0, f.posts)
            assertFalse(f.repository.state.value.busy)
        }
    }

}
