package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.boundcosmetics.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.ui.economy.*
import java.io.IOException
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Captured terms plus explicitly synthetic precraft/replies and admission. These
 * JVM tests verify UI intent/lifecycle, not real artwork, transport or Android pixels. */
@OptIn(ExperimentalCoroutinesApi::class)
class BoundCosmeticWorkshopViewModelTest {
    private val json = Json { encodeDefaults = true }
    private fun source() = json.parseToJsonElement(requireNotNull(javaClass.getResource("/boundcosmetics/final-actual-http.json")).readText()).jsonObject
    private val original get() = BoundCosmeticProof.from(source().getValue("originals").jsonArray.single().jsonObject)
    private val base get() = original.receipt!!.request.baseId
    private val recipeId get() = original.receipt!!.recipe.recipeId
    private fun edit(raw: JsonObject, key: String, value: JsonElement) = JsonObject(raw + (key to value))
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder, original.wallet); val memory = MemoryStore()
        val store = BoundCosmeticStore(memory, BoundCosmeticIdentity(session.origin, "devnet", session.wallet))
        var selected: String? = base; var generation = 0L; var allowed = true; var artReady = true
        var accepted = false; var completed = false; var posts = 0; var puts = 0; var reads = 0
        var providerFails = false; var previewFails = false
        var onPost: suspend () -> Unit = { accepted = true }; var beforeAccount: suspend () -> Unit = {}
        val rules = BoundCosmeticWorkshopRules(1) { level -> source().getValue("recipes").jsonArray.map { it.jsonObject.getValue("recipe").jsonObject }
            .single { it.getValue("requiredFacility").jsonObject.getValue("level").jsonPrimitive.long == level }.getValue("outputId").jsonPrimitive.content }
        var raw = source().let { src -> val b = src.getValue("selectedBase").jsonObject
            val stock = b.getValue("craftingStock").jsonArray.map { item -> val row = item.jsonObject
                val input = original.receipt!!.recipe.inputs.find { it.itemId == row.getValue("itemId").jsonPrimitive.content }
                if (input == null) row else edit(row, "available", JsonPrimitive((row.getValue("available").jsonPrimitive.content.toBigInteger() + input.quantity.toBigInteger()).toString())) }
            edit(edit(src, "originals", JsonArray(emptyList())), "selectedBase", edit(b, "craftingStock", JsonArray(stock))) }
        fun command() = (store.read().operation ?: store.read().archives.single()).command
        fun proof(): BoundCosmeticProof {
            val c = command(); val start = source().getValue("serverNow").jsonPrimitive.content
            val ready = DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(Instant.parse(start).plusSeconds(c.recipe.durationSec))
            return BoundCosmeticProof(1, session.wallet, c.key, if (completed) ready else start, if (accepted) "accepted" else "unknown",
                if (accepted) BoundCosmeticReceipt(session.wallet, c.key, c.request, c.recipe, c.appearance, original.receipt!!.blueprint, start, ready) else null,
                if (completed) BoundCosmeticCompletion(ready) else null)
        }
        fun rawProof() = json.encodeToJsonElement(BoundCosmeticProof.serializer(), proof()).jsonObject
        fun current(): JsonObject {
            val v = if (accepted) edit(edit(raw, "serverNow", JsonPrimitive(proof().serverNow)), "originals", JsonArray(listOf(rawProof()))) else raw
            return if (selected == null) edit(v, "selectedBase", JsonNull) else v
        }
        val api = object : ApiClient by FakeApiClient() {
            override suspend fun getBoundCosmetic(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard(); reads++
                if (path == "/bound-cosmetics") { if (providerFails) throw IOException("Current Workshop unavailable"); return current() }
                return rawProof().also { requireNotNull(evidence)(it) }
            }
            override suspend fun postBoundCosmetic(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit): JsonObject {
                guard(); assertTrue(store.read().operation!!.attempted); assertEquals(command().request.body(), body)
                posts++; onPost(); return rawProof().also(evidence)
            }
            override suspend fun putBoundCosmeticPreference(body: JsonObject, guard: () -> Unit): JsonObject {
                guard(); puts++; val request = BoundCosmeticPreferenceRequest.from(body)
                val b = raw.getValue("selectedBase").jsonObject; val revision = (request.expectedRevision.toBigInteger() + java.math.BigInteger.ONE).toString()
                raw = edit(raw, "selectedBase", edit(b, "preference", buildJsonObject { put("enabled", request.enabled); put("revision", revision) }))
                val visual = BoundCosmeticBaseRead.from(b.getValue("visual").jsonObject)
                return json.encodeToJsonElement(BoundCosmeticPreferenceResponse.serializer(), BoundCosmeticPreferenceResponse(base, request.enabled, revision, visual)).jsonObject
            }
        }
        val repository = BoundCosmeticWorkshopRepository(session, holder, api, store, rules, { selected }, { generation },
            { BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(base, "active", slot = 0))) },
            { beforeAccount() }, { guard -> guard() }, { allowed }, { artReady },
            { _, guard -> guard(); if (previewFails) throw IOException("Verified artwork missing") }, { "00000000-0000-4000-8000-000000000090" })
    }
    private suspend fun withModel(f: Fixture, block: suspend (BoundCosmeticWorkshopViewModel) -> Unit) {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val model = BoundCosmeticWorkshopViewModel(f.repository)
        try { withTimeout(5_000) { block(model) } } finally { model.viewModelScope.cancel(); Dispatchers.resetMain() }
    }
    @Test fun `review saves exact materials but only explicit consent and one confirmation can post`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        withModel(f) { m ->
            m.foreground(); assertEquals(0, f.posts); m.review(recipeId)?.join()
            val review = requireNotNull(m.state.value.review); assertEquals(original.receipt!!.recipe, review.command.recipe)
            m.confirm(review, false)?.join(); assertEquals(0, f.posts); assertTrue(m.notice.value!!.error)
            val first = m.confirm(review, true); entered.await(); assertNull(m.confirm(review, true)); release.complete(Unit); first?.join()
            assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof); assertNull(f.store.read().operation!!.proof!!.completion)
        }
    }
    @Test fun `STOP section disposal and base ABA retire consent while preserving saved original`() = runBlocking<Unit> {
        for (aba in listOf(false, true)) {
            val f = Fixture(); withModel(f) { m ->
                m.review(recipeId)?.join(); val review = requireNotNull(m.state.value.review)
                if (aba) f.generation += 2 else m.dismiss()
                m.confirm(review, true)?.join(); m.dismiss(); m.foreground()
                assertNull(m.state.value.review); assertEquals(review.command, f.store.read().operation!!.command)
                assertFalse(f.store.read().operation!!.attempted); assertEquals(0, f.posts)
            }
        }
    }
    @Test fun `foreground never resends unknown attempt during pause or missing current kingdom`() = runBlocking<Unit> {
        val f = Fixture(); f.onPost = { throw IOException("Lost reply") }
        withModel(f) { m ->
            m.review(recipeId)?.join(); m.confirm(requireNotNull(m.state.value.review), true)?.join()
            val command = f.store.read().operation!!.command; m.dismiss(); f.allowed = false; f.artReady = false; f.selected = null
            m.foreground(); assertEquals(1, f.posts); assertEquals(command, f.store.read().operation!!.command)
            assertEquals("Outcome unknown", awningRequestStatus(f.store.read().operation!!)); assertTrue(boundCosmeticWorkshopEntryAvailable(m.state.value))
            // Rewritten 2026-10-06 (dead-end audit): an explicit archive tap now closes the unknown original once its own
            // fresh by-key read answers "unknown" (owner rule), so a pause cannot block the Workshop forever. It still never resends.
            m.archive()?.join(); assertNull(f.store.read().operation); assertTrue(f.store.read().archives.single().closedUnknown)
            assertNull(f.store.read().archives.single().proof); assertEquals(command, f.store.read().archives.single().command); assertEquals(1, f.posts)
        }
    }
    @Test fun `archived automatic completion recovers independently of paused current provider`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { m ->
            m.review(recipeId)?.join(); m.confirm(requireNotNull(m.state.value.review), true)?.join(); m.archive()?.join()
            val receipt = f.store.read().archives.single().proof!!.receipt
            f.completed = true; f.providerFails = true; f.allowed = false; f.artReady = false; m.dismiss(); m.foreground()
            assertEquals(receipt, f.store.read().archives.single().proof!!.receipt); assertNotNull(f.store.read().archives.single().proof!!.completion)
            assertEquals(1, f.posts); assertNull(m.state.value.view); assertTrue(boundCosmeticWorkshopEntryAvailable(m.state.value)); assertTrue(m.notice.value!!.error)
        }
    }
    @Test fun `free off survives art pause but global pause and missing preview never permit mutation`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { m ->
            f.artReady = false; m.foreground(); m.setPreference(false)?.join(); assertEquals(1, f.puts)
            m.setPreference(true)?.join(); assertEquals(1, f.puts)
            f.allowed = false; m.setPreference(false)?.join(); assertEquals(1, f.puts)
            f.allowed = true; f.artReady = true; f.previewFails = true; m.review(recipeId)?.join()
            assertNull(f.store.read().operation); assertEquals(0, f.posts); assertTrue(m.notice.value!!.error)
        }
    }
    @Test fun `current material needs never manufacture missing stock and history keeps the entry reachable`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { m ->
            assertFalse(boundCosmeticWorkshopEntryAvailable(null)); assertTrue(boundCosmeticWorkshopEntryAvailable(null, true))
            m.foreground(); val state = m.state.value; val view = requireNotNull(state.view); val row = view.recipes.first()
            assertNull(awningCraftHold(state, row, true, true)); assertNotNull(awningCraftHold(state, row, true, false))
            val b = view.selectedBase as BoundCosmeticSelectedBase.Available
            assertTrue(awningMaterials(row.recipe, b).all { it.missing == "0" })
            assertTrue(awningMaterials(row.recipe, null).all { it.available == null && it.missing == null })
            val scarce = b.copy(craftingStock = b.craftingStock.map { it.copy(available = "0") })
            assertTrue(awningMaterials(row.recipe, scarce).all { it.missing == it.needed })
            assertTrue(awningCraftHold(state.copy(view = view.copy(selectedBase = scarce)), row, true, true)!!.contains("missing"))
            assertTrue(awningMatchingOwned(view.copy(originals = listOf(original)), f.rules.completedMarketOutput).originals.isNotEmpty())
            m.review(recipeId)?.join(); m.dismiss(); assertTrue(boundCosmeticWorkshopEntryAvailable(m.state.value))
            m.archive()?.join(); assertTrue(boundCosmeticWorkshopEntryAvailable(m.state.value.copy(advertised = false)))
        }
    }
    @Test fun `unavailable Market catalogue holds apply on without hiding free off or original recovery`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { m ->
            m.foreground(); val view = requireNotNull(m.state.value.view).copy(originals = listOf(original))
            val matching = awningMatchingOwned(view) { throw IllegalStateException("Admitted catalogue disappeared") }
            assertFalse(matching.available); assertTrue(matching.originals.isEmpty())
            assertEquals(listOf(original), view.originals)
            f.artReady = false; m.setPreference(false)?.join(); assertEquals(1, f.puts)
            m.setPreference(true)?.join(); assertEquals(1, f.puts)
            assertNotNull(m.state.value.view)
        }
    }
    @Test fun `foreground waits for shared discovery then refreshes without reviving old review`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var first = true
        f.beforeAccount = { if (first) { first = false; entered.complete(Unit); release.await() } }
        withModel(f) { m -> coroutineScope {
            val discovery = async { runCatching { f.repository.refresh() } }; entered.await(); m.dismiss()
            val foreground = async { m.foreground() }; yield(); assertFalse(foreground.isCompleted)
            release.complete(Unit); discovery.await(); foreground.await()
            assertNotNull(m.state.value.view); assertNull(m.state.value.review); assertEquals(0, f.posts)
        } }
    }
}
