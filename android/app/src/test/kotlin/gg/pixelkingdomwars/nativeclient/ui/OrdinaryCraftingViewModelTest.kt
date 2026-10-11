package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.ui.economy.OrdinaryCraftingViewModel
import gg.pixelkingdomwars.nativeclient.ui.economy.ordinaryCraftingEntryAvailable
import java.io.IOException
import java.time.Instant
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server quantities; proves explicit UI intent and GET-only lifecycle behavior, not device QA. */
@OptIn(ExperimentalCoroutinesApi::class)
class OrdinaryCraftingViewModelTest {
    private val key = "00000000-0000-4000-8000-000000000002"
    private val now = "2026-09-22T12:00:00.000Z"
    private val pairs = listOf("frostglass" to "frost_quartz", "heartwood_beams" to "heartwood_logs", "sunstone_blocks" to "sunstone_rubble",
        "crownsteel" to "crown_iron_ore", "prismstone_lens" to "rough_prism", "stormalloy" to "storm_ore", "thornsilk" to "thorn_fibre", "embercore" to "ember_nodules")
    private fun view() = OrdinaryCraftingView(WALLET, BASE_ID, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)), true, 2, 9,
        pairs.map { (output, input) -> OrdinaryCraftingRecipe(2, "refine_$output", 1, 17, listOf(OrdinaryCraftingInput("raw", input, "13")), OrdinaryCraftingOutput(output, "3")) } +
            OrdinaryCraftingRecipe(2, "craft_navigation_kit", 1, 23, listOf(OrdinaryCraftingInput("crafting", "prismstone_lens", "2"), OrdinaryCraftingInput("crafting", "frostglass", "4")), OrdinaryCraftingOutput("navigation_kit", "1")) + listOf(
            OrdinaryCraftingRecipe(2, "craft_climate_kit", 1, 29, listOf(OrdinaryCraftingInput("crafting", "sunstone_blocks", "3"), OrdinaryCraftingInput("crafting", "embercore", "4")), OrdinaryCraftingOutput("climate_kit", "1")),
            OrdinaryCraftingRecipe(2, "craft_expedition_kit", 1, 31, listOf(OrdinaryCraftingInput("crafting", "heartwood_beams", "2"), OrdinaryCraftingInput("crafting", "thornsilk", "3"), OrdinaryCraftingInput("shards", "shards", "7")), OrdinaryCraftingOutput("expedition_kit", "1"))),
        pairs.map { OrdinaryRawStock(it.second, "100", "5", "105") }, (pairs.map { it.first } + listOf("navigation_kit", "climate_kit", "expedition_kit")).map { OrdinaryProtectedStock(it, "100", "0") }, emptyList(), now, catalogueVersion = 2, shardsAvailable = "100")
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val store = OrdinaryCraftingStore(MemoryStore(), OrdinaryCraftingIdentity(session.origin, "devnet", WALLET))
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var accepted = false; var completed = false
        var current = view(); var currentReads = 0; var receiptReads = 0; var posts = 0
        var account: suspend () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }
        val api = object : ApiClient by FakeApiClient() {
            override suspend fun getOrdinaryCrafting(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/ordinary-crafting") { currentReads++; assertEquals(mapOf("baseId" to BASE_ID, "catalogueVersion" to "2"), query); return Json.encodeToJsonElement(current).jsonObject }
                receiptReads++; assertTrue(query.isEmpty()); assertEquals("/ordinary-crafting/jobs/by-key/$key", path)
                return proof().also { requireNotNull(evidence)(it) }
            }
            override suspend fun postOrdinaryCrafting(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                guard(); assertEquals("/ordinary-crafting/jobs", path); assertEquals(store.read().operation!!.command.request.body(), body)
                posts++; onPost(); return proof().also(evidence)
            }
        }
        val repository = OrdinaryCraftingRepository(session, holder, api, store, { selected }, { generation },
            { BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 0))) },
            { account() }, { guard -> guard() }, { allowed }, { key })
        fun proof(): JsonObject {
            val journal = store.read(); val command = journal.operation?.command ?: journal.archives.single().operation.command
            val ready = Instant.parse(now).plusSeconds(command.recipe.durationSec).toString().replace("Z", ".000Z")
            return Json.encodeToJsonElement(OrdinaryCraftingProof(WALLET, key, if (completed) ready else now, if (accepted) "accepted" else "unknown",
                if (accepted) OrdinaryCraftingReceipt(key, command.recipe, now, ready, WALLET, command.request) else null,
                if (completed) OrdinaryCraftingCompletion(ready) else null)).jsonObject
        }
    }
    private suspend fun withModel(f: Fixture, block: suspend (OrdinaryCraftingViewModel) -> Unit) {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val model = OrdinaryCraftingViewModel(f.repository)
        try { withTimeout(5_000) { block(model) } } finally { model.viewModelScope.cancel(); Dispatchers.resetMain() }
    }
    @Test fun `foreground discovers current ordinary recipes without creating a command or POST`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model -> model.foreground(); assertTrue(ordinaryCraftingEntryAvailable(model.state.value))
            assertEquals(f.current, model.state.value.view); assertNull(f.store.read().operation); assertEquals(0, f.posts) }
    }
    @Test fun `quantity validation cannot save malformed or overflowing intent and valid review cannot dispatch`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            for (quantity in listOf("", "0", "01", "-1", "1.5", "1e2", "2147483648")) {
                model.start("refine_frostglass", quantity)?.join(); assertNull(f.store.read().operation); assertTrue(model.notice.value!!.error)
            }
            model.start("refine_frostglass", "2")?.join(); assertNotNull(model.state.value.review)
            assertEquals("26", f.store.read().operation!!.command.recipe.inputs.single().quantity); assertEquals(0, f.posts)
        }
    }
    @Test fun `double confirmation permits one original POST and only after explicit review`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); val review = requireNotNull(model.state.value.review)
            val first = model.confirm(review); entered.await(); assertNull(model.confirm(review)); release.complete(Unit); first?.join()
            assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof)
        }
    }
    @Test fun `dismissed review stays saved and cannot dispatch after screen reopen`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); val review = requireNotNull(model.state.value.review)
            model.dismiss(); model.confirm(review)?.join(); model.foreground()
            assertNull(model.state.value.review); assertEquals(review.command, f.store.read().operation!!.command)
            assertNull(f.store.read().operation!!.attemptRevision); assertEquals(0, f.posts)
        }
    }
    @Test fun `foreground never retries an uncertain command after response loss`() = runBlocking<Unit> {
        val f = Fixture(); f.onPost = { throw IOException("lost reply") }
        withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            model.dismiss(); f.allowed = false; f.selected = null; model.foreground()
            assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.attemptRevision); assertNull(f.store.read().operation!!.proof)
            assertTrue(ordinaryCraftingEntryAvailable(model.state.value)); assertNull(model.state.value.view)
        }
    }
    @Test fun `foreground checks archived automatic completion without selection or live admission`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join(); model.finish()?.join()
            val frozen = f.store.read().archives.single().operation.proof!!.receipt
            f.selected = null; f.allowed = false; f.completed = true; val reads = f.currentReads
            model.dismiss(); model.foreground()
            assertEquals(frozen, f.store.read().archives.single().operation.proof!!.receipt)
            assertNotNull(f.store.read().archives.single().operation.proof!!.completion)
            assertEquals(reads, f.currentReads); assertEquals(1, f.posts); assertTrue(ordinaryCraftingEntryAvailable(model.state.value))
        }
    }
    @Test fun `screen foreground waits for Wallet discovery to release shared repository admission`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var first = true
        f.account = { if (first) { first = false; entered.complete(Unit); release.await() } }
        withModel(f) { model -> coroutineScope {
            val discovery = async { runCatching { f.repository.refresh() } }; entered.await()
            model.dismiss(); val foreground = async { model.foreground() }
            yield(); assertFalse(foreground.isCompleted); release.complete(Unit); discovery.await(); foreground.await()
            assertNotNull(model.state.value.view); assertFalse(model.busy.value); assertNull(model.state.value.review); assertEquals(0, f.posts)
        } }
    }
    @Test fun `old-server entry remains hidden while corrupt storage and original history remain reachable`() = runBlocking<Unit> {
        assertFalse(ordinaryCraftingEntryAvailable(null)); assertTrue(ordinaryCraftingEntryAvailable(null, storageUnavailable = true))
        val f = Fixture(); assertFalse(ordinaryCraftingEntryAvailable(f.repository.state.value))
        withModel(f) { model -> model.start("refine_frostglass", "2")?.join(); f.selected = null; model.dismiss()
            assertTrue(ordinaryCraftingEntryAvailable(model.state.value.copy(advertised = false, view = null)))
            model.archiveUnusedOrRefused()?.join(); assertTrue(ordinaryCraftingEntryAvailable(model.state.value.copy(advertised = false, view = null)))
            assertEquals(0, f.posts)
        }
    }
    @Test fun `explicit archived recovery preserves draft or refusal history and foreground follows only unfinished positive proof`() = runBlocking<Unit> {
        for (refused in listOf(false, true)) {
            val f = Fixture(); withModel(f) { model ->
                model.start("refine_frostglass", "2")?.join()
                if (refused) {
                    f.onPost = { throw ApiException(503, "PHASE_E_DISABLED", "paused") }
                    model.confirm(requireNotNull(model.state.value.review))?.join()
                    assertNotNull(f.store.read().operation!!.refusal)
                }
                model.archiveUnusedOrRefused()?.join(); val original = f.store.read().archives.single()
                assertEquals(if (refused) "refused" else "unattempted", original.reason)
                f.selected = null; f.allowed = false; model.dismiss()
                val unknownReads = f.receiptReads; model.foreground(); assertEquals(unknownReads, f.receiptReads)
                model.checkArchived(key)?.join(); assertEquals(unknownReads + 1, f.receiptReads)
                assertEquals(original, f.store.read().archives.single())
                f.accepted = true; model.foreground(); assertEquals(unknownReads + 1, f.receiptReads)
                model.checkArchived(key)?.join()
                val recovered = f.store.read().archives.single(); assertNotNull(recovered.operation.proof)
                assertEquals(original, recovered.copy(operation = recovered.operation.copy(proof = null)))
                assertNull(model.state.value.view)
                val observedReads = f.receiptReads; model.foreground(); assertEquals(observedReads + 1, f.receiptReads)

                f.completed = true
                model.foreground()
                val complete = f.store.read().archives.single(); assertNotNull(complete.operation.proof!!.completion)
                assertEquals(original, complete.copy(operation = complete.operation.copy(proof = null)))
                val terminalReads = f.receiptReads; model.foreground(); assertEquals(terminalReads, f.receiptReads)
                model.checkArchived(key)?.join(); assertEquals(terminalReads + 1, f.receiptReads)
                assertEquals(if (refused) 1 else 0, f.posts); assertNull(model.state.value.view)
            }
        }
    }

    @Test fun `ingredient panel names SHARDS and exact needed owned missing amounts from current view`() {
        val v = view().copy(shardsAvailable = "5"); val recipe = v.recipes.single { it.recipeId == "craft_expedition_kit" }.batch(2)
        val rows = gg.pixelkingdomwars.nativeclient.ui.economy.ordinaryIngredientAvailability(recipe, v)
        assertEquals(listOf("heartwood_beams", "thornsilk", "shards"), rows.map { it.itemId })
        assertEquals("14", rows.last().needed); assertEquals("5", rows.last().owned); assertEquals("9", rows.last().missing)
        val consent = gg.pixelkingdomwars.nativeclient.ui.economy.ordinaryCraftingIngredientConsent(recipe)
        assertTrue(consent.contains("14 SHARDS")); assertTrue(consent.contains("ingredient")); assertTrue(consent.contains("not a service fee or tax"))
    }


    @Test fun `completed original finish emits exact local event only after guarded hydration`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            assertNull(model.completion.value)
            f.completed = true; f.current = f.current.copy(serverNow = "2026-09-22T12:00:34.000Z")
            model.finish()?.join()
            val event = requireNotNull(model.completion.value)
            assertEquals("+6 FROSTGLASS", event.ui.ribbon); assertSame(model.state.value.view, event.view)
            assertEquals(OrdinaryCraftingHydration.CURRENT_ORIGINAL_BASE, model.state.value.hydration)
            assertNull(model.state.value.journal.operation); assertNull(model.notice.value); assertEquals(1, f.posts)
            model.acknowledgeCompletion(event.token); assertNull(model.completion.value)
            model.checkArchived(key)?.join(); model.refresh()?.join(); assertNull(model.completion.value)
            assertEquals(1, f.posts)
        }
    }
    @Test fun `accepted unfinished start retains archive notice without premature celebration`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            model.finish()?.join(); assertNull(model.completion.value)
            assertEquals("Original receipt archived. Automatic completion remains available in history.", model.notice.value!!.message)
        }
    }
    @Test fun `failed delivery hydration cannot publish completion even when receipt is complete`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            f.completed = true; f.current = f.current.copy(serverNow = "2026-09-22T12:00:34.000Z")
            f.account = { throw IOException("delivery unavailable") }; model.finish()?.join()
            assertNull(model.completion.value); assertTrue(model.notice.value!!.error)
            assertNotNull(model.state.value.journal.operation!!.proof!!.completion)
            assertTrue(model.state.value.journal.archives.isEmpty()); assertEquals(1, f.posts)
        }
    }
    @Test fun `other base completed receipt archives without pretending delivery is hydrated here`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            f.completed = true; f.selected = null; f.generation++; model.finish()?.join()
            assertNull(model.completion.value); assertNull(model.state.value.view)
            assertEquals(OrdinaryCraftingHydration.ORIGINAL_BASE_UNAVAILABLE, model.state.value.hydration)
            assertEquals(1, f.posts)
        }
    }
    @Test fun `already archived completion is not replayed by a new screen model or foreground`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start("refine_frostglass", "2")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            f.completed = true; f.current = f.current.copy(serverNow = "2026-09-22T12:00:34.000Z")
            model.finish()?.join(); val event = requireNotNull(model.completion.value)
            model.acknowledgeCompletion(event.token)
        }
        withModel(f) { model -> model.foreground(); assertNull(model.completion.value); assertEquals(1, f.posts) }
    }

}
