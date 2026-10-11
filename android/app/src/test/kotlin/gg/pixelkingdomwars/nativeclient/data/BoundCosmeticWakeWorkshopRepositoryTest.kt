package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Actual private primary before/pending/completed bytes share one account. Any edits below are
 * synthetic guards, never native C5, transport, Android pixels or production-login evidence. */
class BoundCosmeticWakeWorkshopRepositoryTest {
    private val json = Json { encodeDefaults = true }
    private fun pair() = requireNotNull(javaClass.getResourceAsStream("/boundcosmetics/wake-workshop-primary-pair.json")).use {
        json.parseToJsonElement(it.readBytes().toString(Charsets.UTF_8)).jsonObject
    }
    private fun source(name: String) = pair().getValue(name).jsonObject
    private fun edit(raw: JsonObject, key: String, value: JsonElement) = JsonObject(raw + (key to value))
    private val wallet get() = source("before").getValue("wallet").jsonPrimitive.content
    private val base get() = source("before").getValue("selectedBase").jsonObject.getValue("baseId").jsonPrimitive.content
    private val captured get() = BoundCosmeticProof.from(source("original"))
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }
    internal inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder, wallet); val memory = MemoryStore()
        val store = BoundCosmeticStore(memory, BoundCosmeticIdentity(session.origin, "devnet", wallet), BoundCosmeticMode.WAKE)
        val wire = FakeApiClient(); var selected: String? = base; var generation = 0L; var allowed = true; var globalAllowed = true
        var art = true; var queueAvailable = true; var currentFails = false; var accountFails = false; var hydrateFails = false
        var accepted = false; var completed = false; var previews = 0; var posts = 0; var puts = 0; var accountReads = 0; var originalReads = 0
        var view = source("before"); var preference = view.getValue("preference").jsonObject
        var directory: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(base, "active", slot = 0)))
        var afterView: () -> Unit = {}; var beforePut: suspend () -> Unit = {}; var afterPut: () -> Unit = {}; var afterOriginal: () -> Unit = {}
        var onPreview: () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }; var onPut: () -> Unit = {}
        var account: suspend () -> Unit = {}; var currentReads = 0
        val requests = mutableListOf<BoundCosmeticWakePreferenceRequest>()
        fun proof(): JsonObject = if (completed) source("completed").getValue("original").jsonObject else if (accepted) source("original") else buildJsonObject {
            put("version", 1); put("wallet", wallet); put("idempotencyKey", captured.idempotencyKey)
            put("serverNow", source("before").getValue("serverNow")); put("status", "unknown"); put("receipt", JsonNull); put("completion", JsonNull)
        }
        fun current(account: Boolean): JsonObject {
            val raw = if (completed) source("completed") else if (accepted) source("pending") else view
            return edit(edit(raw, "preference", preference), "selectedBase", if (account) JsonNull else raw.getValue("selectedBase"))
        }
        val api = object : ApiClient by wire {
            override suspend fun getBoundCosmetic(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/bound-cosmetics/wakes/v1/workshop") {
                    assertNull(evidence); val account = query.isEmpty()
                    if (account) { accountReads++; if (accountFails) throw IOException("account unavailable") }
                    else { currentReads++; assertEquals(mapOf("baseId" to base), query); if (currentFails) throw IOException("selected stock unavailable") }
                    val raw = current(account); afterView(); return raw
                }
                assertEquals("/bound-cosmetics/jobs/by-key/${captured.idempotencyKey}", path); assertTrue(query.isEmpty()); originalReads++
                return proof().also { afterOriginal(); requireNotNull(evidence)(it); guard() }
            }
            override suspend fun postBoundCosmetic(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject {
                guard(); assertEquals("/bound-cosmetics/wakes/v1/jobs", path)
                val saved = store.read().operation!!; assertTrue(saved.attempted); assertEquals(saved.command.request.body(), body); posts++
                onPost(); return proof().also { evidence(it); guard() }
            }
            override suspend fun putBoundCosmeticWakePreference(body: JsonObject, guard: () -> Unit): JsonObject {
                beforePut(); guard(); puts++; val request = BoundCosmeticWakePreferenceRequest.from(body); requests += request; onPut()
                val visual = BoundCosmeticWakeRead("available", BoundCosmeticWakeVisual(1, if (request.enabled) captured.receipt!!.appearance else null))
                val response = BoundCosmeticWakePreferenceResponse(request.enabled, (request.expectedRevision.toBigInteger() + java.math.BigInteger.ONE).toString(), visual)
                preference = json.encodeToJsonElement(BoundCosmeticWakePreferenceSnapshot.serializer(), BoundCosmeticWakePreferenceSnapshot(response.enabled, response.revision, response.visual)).jsonObject
                afterPut(); return json.encodeToJsonElement(BoundCosmeticWakePreferenceResponse.serializer(), response).jsonObject
            }
        }
        fun repository(defaultAdmission: Boolean = false) = BoundCosmeticWakeWorkshopRepository(session, holder, api, store,
            { check(queueAvailable); source("pending").getValue("selectedBase").jsonObject.getValue("queue").jsonArray.size },
            { selected }, { generation }, { directory }, { account(); if (currentFails) throw IOException("selected hydration unavailable") },
            { guard -> guard(); if (hydrateFails) throw IOException("hydration unavailable") }, { allowed }, { globalAllowed },
            { !defaultAdmission && art }, { appearance, guard -> assertEquals(captured.receipt!!.appearance, appearance); previews++; onPreview(); guard() },
            { captured.idempotencyKey })
        val repository = repository()
        suspend fun review(): BoundCosmeticWakeWorkshopReview { repository.reviewStart(); return repository.state.value.review!! }
        fun baseChange(change: (JsonObject) -> JsonObject) { view = edit(view, "selectedBase", change(view.getValue("selectedBase").jsonObject)) }
        fun seedAccepted() {
            val r = captured.receipt!!; val c = BoundCosmeticCommand(r.request, r.recipe, r.appearance)
            store.begin(store.read(), c); store.attempt(store.read()); accepted = true
            store.accept(c, captured)
        }
    }
    @Test fun `explicit confirm saves exact request before one POST and lost reply reopens only the same original`() = runBlocking {
        val f = Fixture(); val review = f.review(); assertEquals(0, f.posts); assertFalse(f.store.read().operation!!.attempted)
        f.onPost = { throw IOException("lost reply") }; rejects { runBlocking { f.repository.confirm(review) } }
        assertEquals(1, f.posts); assertEquals(captured.receipt!!.request, f.store.read().operation!!.command.request)
        val reopened = f.repository(); reopened.refresh(); assertEquals(1, f.posts); assertNull(reopened.state.value.review)
        rejects { runBlocking { reopened.reviewStart() } }
        // Rewritten 2026-10-06 (dead-end audit): the owner now lets archive close an attempted unknown once its own fresh
        // by-key read answers "unknown". What stays pinned: without that fresh answer the original is never archived.
        f.afterOriginal = { throw IOException("original receipt unavailable") }
        rejects { runBlocking { reopened.archive() } }; assertNotNull(f.store.read().operation); f.afterOriginal = {}
        reopened.reviewSaved(); assertEquals(review.command, reopened.state.value.review!!.command)
        f.onPost = { f.accepted = true }; reopened.confirm(reopened.state.value.review!!)
        assertEquals(2, f.posts); assertNotNull(f.store.read().operation!!.proof)
    }
    @Test fun `provider failure and craft pause still recover accepted originals and archived completion`() = runBlocking {
        val f = Fixture(); f.seedAccepted(); f.completed = true; f.currentFails = true; f.accountFails = true; f.allowed = false; f.art = false
        rejects { runBlocking { f.repository.refresh() } }; assertNotNull(f.store.read().operation!!.proof!!.completion)
        f.repository.archive(); assertNull(f.store.read().operation); f.repository.checkArchived(captured.idempotencyKey)
        assertNotNull(f.repository.state.value.journal.archives.single().proof!!.completion); assertEquals(0, f.posts)
    }
    @Test fun `late accepted evidence survives dismissal and hydration failure without publishing stale current facts`() = runBlocking {
        val f = Fixture(); val review = f.review(); f.onPost = { f.accepted = true; f.repository.dismiss() }
        rejects { runBlocking { f.repository.confirm(review) } }; assertNotNull(f.store.read().operation!!.proof); assertNull(f.repository.state.value.view)
        val g = Fixture(); val current = g.review(); g.hydrateFails = true
        rejects { runBlocking { g.repository.confirm(current) } }; assertNotNull(g.store.read().operation!!.proof); assertEquals(1, g.posts)
    }
    @Test fun `base ABA art admission and lifecycle retire craft consent before any POST`() = runBlocking {
        val f = Fixture(); val review = f.review(); f.generation++; f.repository.invalidateAdmission()
        rejects { runBlocking { f.repository.confirm(review) } }; assertEquals(0, f.posts); assertNotNull(f.store.read().operation)
        val g = Fixture(); val consent = g.review(); g.art = false
        rejects { runBlocking { g.repository.confirm(consent) } }; assertEquals(0, g.posts)
        val h = Fixture(); val old = h.review(); h.repository.dismiss()
        rejects { runBlocking { h.repository.confirm(old) } }; assertEquals(0, h.posts)
    }
    @Test fun `missing C5 preview Lodge stock and shared queue cannot create a spend`() = runBlocking {
        val closed = Fixture(); rejects { runBlocking { closed.repository(true).reviewStart() } }; assertNull(closed.store.read().operation)
        val art = Fixture(); art.onPreview = { throw IOException("missing verified appearance") }; rejects { runBlocking { art.review() } }; assertNull(art.store.read().operation)
        val lodge = Fixture(); lodge.baseChange { edit(it, "lodges", JsonArray(emptyList())) }; rejects { runBlocking { lodge.review() } }
        val stock = Fixture(); stock.baseChange { b -> edit(b, "craftingStock", JsonArray(b.getValue("craftingStock").jsonArray.map { edit(it.jsonObject, "available", JsonPrimitive("0")) })) }; rejects { runBlocking { stock.review() } }
        val queue = Fixture(); queue.baseChange { edit(it, "queue", source("pending").getValue("selectedBase").jsonObject.getValue("queue")) }; rejects { runBlocking { queue.review() } }
        listOf(closed, art, lodge, stock, queue).forEach { assertEquals(0, it.posts); assertNull(it.store.read().operation) }
    }
    @Test fun `account Off survives no kingdom catalogue crafting flag or native art while global fence persists`() = runBlocking {
        val f = Fixture(); f.selected = null; f.directory = null; f.currentFails = true; f.queueAvailable = false; f.allowed = false; f.art = false
        f.repository.refreshPreference(); f.repository.setPreference(false)
        assertEquals(1, f.puts); assertEquals(false, f.repository.state.value.preference!!.enabled); assertEquals(0, f.previews)
        f.globalAllowed = false; rejects { runBlocking { f.repository.setPreference(false) } }; assertEquals(1, f.puts)
        f.repository.check(); assertEquals(0, f.posts)
    }
    @Test fun `base invalidation during account Off does not cancel it but lifecycle and account replacement do`() = runBlocking {
        val f = Fixture(); f.repository.refreshPreference(); f.beforePut = { f.generation++; f.selected = null; f.repository.invalidateAdmission() }
        f.repository.setPreference(false); assertEquals(1, f.puts); assertNotNull(f.repository.state.value.preference)
        val g = Fixture(); g.repository.refreshPreference(); g.beforePut = { g.repository.dismiss() }
        rejects { runBlocking { g.repository.setPreference(false) } }; assertEquals(0, g.puts)
        val h = Fixture(); h.repository.refreshPreference(); h.beforePut = { signedIn(h.holder, source("on").getValue("wallet").jsonPrimitive.content) }
        rejects { runBlocking { h.repository.setPreference(false) } }; assertEquals(0, h.puts)
    }
    @Test fun `account setting refresh remains available when selected current read fails`() = runBlocking {
        val f = Fixture(); f.currentFails = true; f.queueAvailable = false
        rejects { runBlocking { f.repository.refresh() } }; assertNull(f.repository.state.value.view); assertNotNull(f.repository.state.value.preference)
        f.allowed = false; f.art = false; f.repository.setPreference(false); assertEquals(1, f.puts); assertEquals(1, f.accountReads)
    }
    @Test fun `On requires actual completed original server readiness native readiness and verified exact preview`() = runBlocking {
        val f = Fixture(); f.repository.refreshPreference(); rejects { runBlocking { f.repository.setPreference(true) } }; assertEquals(0, f.puts)
        f.accepted = true; f.completed = true; f.repository.refreshPreference(); f.art = false
        rejects { runBlocking { f.repository.setPreference(true) } }; assertEquals(0, f.puts)
        f.art = true; f.onPreview = { throw IOException("preview unavailable") }; rejects { runBlocking { f.repository.setPreference(true) } }; assertEquals(0, f.puts)
        f.onPreview = {}; f.repository.setPreference(true); assertEquals(1, f.puts); assertTrue(f.repository.state.value.preference!!.enabled)
    }
    @Test fun `account-only readiness can enable an owned Wake after selected stock fails without reviving craft admission`() = runBlocking {
        val f = Fixture(); f.accepted = true; f.completed = true; f.selected = null; f.directory = null
        f.currentFails = true; f.queueAvailable = false; f.allowed = false
        // The fixture explicitly supplies C5=true; production omits it and remains held.
        rejects { runBlocking { f.repository.refresh() } }
        assertNull(f.repository.state.value.view); assertTrue(f.repository.state.value.accountApplicationReady)
        assertNotNull(f.repository.state.value.original!!.completion)
        f.repository.invalidateAdmission(); assertTrue(f.repository.state.value.accountApplicationReady)
        f.repository.setPreference(true)
        assertEquals(1, f.puts); assertEquals(0, f.posts); assertEquals(1, f.previews)
        assertTrue(f.repository.state.value.preference!!.enabled); assertNull(f.repository.state.value.review)
        f.repository.dismiss(); assertFalse(f.repository.state.value.accountApplicationReady); assertNull(f.repository.state.value.preference)
    }
    @Test fun `CAS conflict refreshes account once without inversion and uncertain PUT requires explicit observation`() = runBlocking {
        val f = Fixture(); f.repository.refreshPreference()
        f.onPut = { f.preference = edit(f.preference, "revision", JsonPrimitive("3")); throw ApiException(409, "BOUND_COSMETIC_PREFERENCE_CHANGED", "changed") }
        f.repository.setPreference(false); assertEquals(1, f.puts); assertTrue(f.repository.state.value.preferenceChanged); assertEquals("3", f.repository.state.value.preference!!.revision)
        f.onPut = { throw IOException("reply lost") }; rejects { runBlocking { f.repository.setPreference(false) } }; assertNull(f.repository.state.value.preference)
        rejects { runBlocking { f.repository.setPreference(false) } }; assertEquals(2, f.puts)
        f.repository.refreshPreference(); assertEquals(2, f.puts)
    }
    @Test fun `shared identity mutex prevents concurrent siblings while corrupt Wake bytes leave Awning bytes intact`() = runBlocking {
        val memory = mutableMapOf<String, MemoryStore>(); val stores = BoundCosmeticWorkshopStores.withWakeStores { _, purpose -> memory.getOrPut(purpose) { MemoryStore() } }
        val f = Fixture(); val awning = stores.forIdentity(f.session.origin, "devnet", wallet); val wake = stores.forWakeIdentity(f.session.origin, "devnet", wallet)
        assertSame(awning.requests, wake.requests); assertNotSame(awning, wake); assertSame(wake, stores.forWakeIdentity(f.session.origin, "devnet", wallet))
        assertEquals(setOf("bound-cosmetics-devnet-$wallet", "bound-cosmetic-wake-v1-devnet-$wallet"), memory.keys)
        awning.requests.lock(); val began = CompletableDeferred<Unit>(); val waiting = async { began.complete(Unit); wake.requests.lock(); wake.requests.unlock() }
        began.await(); yield(); assertFalse(waiting.isCompleted); awning.requests.unlock(); waiting.await()
        val raw = "{corrupt preserved bytes"; memory.getValue("bound-cosmetic-wake-v1-devnet-$wallet").write(raw)
        rejects { wake.read() }; assertEquals(raw, memory.getValue("bound-cosmetic-wake-v1-devnet-$wallet").read()); assertEquals(0L, awning.read().revision)
        rejects { BoundCosmeticWorkshopStores { _, _, _ -> MemoryStore() }.forWakeIdentity(f.session.origin, "devnet", wallet) }
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
