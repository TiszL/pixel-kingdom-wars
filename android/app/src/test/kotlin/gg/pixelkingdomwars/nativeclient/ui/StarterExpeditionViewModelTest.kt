package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import gg.pixelkingdomwars.nativeclient.ui.economy.*
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic terms exercise UI consent and GET-only recovery, not device or real term acceptance. */
@OptIn(ExperimentalCoroutinesApi::class)
class StarterExpeditionViewModelTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val key = id(2)
    private val now = "2026-09-22T12:00:00.000Z"
    private val ready = "2026-09-22T12:00:17.000Z"
    private val installed = StarterFleetInstallation(id(5), BASE_ID, id(3), "starter", id(4), now, now)
    private val realms = listOf("frost_quartz" to "frostveil", "heartwood_logs" to "elderwood", "sunstone_rubble" to "sunscar",
        "crown_iron_ore" to "crownlands", "rough_prism" to "seeker-reach", "storm_ore" to "stormcairn", "thorn_fibre" to "thornwake", "ember_nodules" to "cinderfall")
    private fun route(name: String, realm: String, resource: String) = StarterExpeditionRoute(2, 2, name, realm, resource, "starter", 17,
        "101", "77", "24", if (name.startsWith("common_")) StarterExpeditionAccess("starter_common", 1) else null)
    private fun view() = StarterExpeditionView(WALLET, BASE_ID, now, StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"),
        listOf("introduction", "coastal_survey", "long_survey").map { route(it, "crownlands", "crown_iron_ore") } +
            realms.map { (resource, realm) -> route("common_${realm.replace('-', '_')}", realm, resource) },
        installed, null, now, realms.map { OrdinaryRawStock(it.first, "9", "1", "10") })
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val wire = FakeApiClient(); val memory = MemoryStore()
        val store = StarterExpeditionStore(memory, StarterIdentity(session.origin, "devnet", WALLET))
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var v = view()
        var dir: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 0)))
        var posts = 0; var currentReads = 0; var receiptReads = 0; var hydrates = 0; var accepted = false; var completed = false
        var published = false; var unsupported = false; var malformed = false
        var beforeEnqueue: () -> Unit = {}; var afterView: () -> Unit = {}; var afterProof: () -> Unit = {}
        var account: suspend () -> Unit = {}; var beforeHydration: () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }
        var afterPostProof: () -> Unit = {}
        fun proof(): JsonObject {
            val c = store.read().let { it.operation?.command ?: it.archives.single().operation.command }
            val receipt = if (accepted) StarterExpeditionReceipt(WALLET, c.request, c.key, c.installation.installationId,
                c.route, now, ready, id(6), "a".repeat(64)) else null
            return Json.encodeToJsonElement(StarterExpeditionProof(WALLET, c.key, if (completed) ready else now,
                if (accepted) "accepted" else "unknown", receipt, if (completed) StarterExpeditionReturn(id(7), ready) else null)).jsonObject
        }
        val api = object : ApiClient by wire {
            override suspend fun getStarterExpedition(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/starter-expeditions") {
                    currentReads++; assertEquals(mapOf("baseId" to BASE_ID), query); assertNull(evidence)
                    if (unsupported) throw ApiException(404, null, "route absent")
                    val raw = if (malformed) JsonObject(emptyMap()) else Json.encodeToJsonElement(v).jsonObject
                    afterView(); return raw
                }
                receiptReads++; assertTrue(query.isEmpty()); assertEquals("/starter-expeditions/by-key/" + key, path)
                return proof().also { afterProof(); requireNotNull(evidence)(it); holder.requireCurrent(session) }
            }
            // UI-R1 (root diagnosis 105852da): the repository's departure-aware entry forwards to THIS fixture's old POST override,
            // never to the wire. Legacy body-only evidence: no fabricated 201/created callback.
            override suspend fun postStarterExpeditionWithDeparture(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit,
                refusal: (ApiException) -> Unit, created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture) -> Unit): JsonObject =
                postStarterExpedition(path, body, guard, evidence, refusal)
            override suspend fun postStarterExpedition(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                beforeEnqueue(); guard(); assertEquals("/starter-expeditions", path)
                val saved = store.read(); val operation = requireNotNull(saved.operation)
                assertEquals(operation.command.request.body(), body)
                assertEquals(saved.revision, operation.attemptRevision); posts++
                // Model the adapter's already-owned bounded body, including proof retention before cancellation.
                return withContext(NonCancellable) {
                    try { onPost() } catch (error: ApiException) { refusal(error); holder.requireCurrent(session); throw error }
                    proof().also { evidence(it); afterPostProof(); holder.requireCurrent(session) }
                }
            }
        }
        val repository = StarterExpeditionRepository(session, holder, api, store, { selected }, { generation }, { dir },
            { account() }, { guard -> hydrates++; beforeHydration(); guard(); published = true }, { allowed }, { key })
        suspend fun review(): StarterExpeditionReview { repository.reviewDeparture("coastal_survey"); return requireNotNull(repository.state.value.review) }
    }
    private suspend fun withModel(f: Fixture, block: suspend (StarterExpeditionViewModel) -> Unit) {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val model = StarterExpeditionViewModel(f.repository)
        try { withTimeout(5_000) { block(model) } } finally { model.viewModelScope.cancel(); Dispatchers.resetMain() }
    }
    @Test fun `foreground discovers current policy without saving or posting a command`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model -> model.foreground(); assertTrue(starterExpeditionEntryAvailable(model.state.value))
            assertEquals(f.v, model.state.value.view); assertNull(f.store.read().operation); assertEquals(0, f.posts) }
    }
    @Test fun `invalid selection cannot save intent while a valid review never dispatches`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model -> model.start("missing")?.join(); assertNull(f.store.read().operation)
            assertTrue(model.notice.value!!.error); model.start("coastal_survey")?.join(); assertNotNull(model.state.value.review)
            assertNull(f.store.read().operation!!.attemptRevision); assertEquals(0, f.posts) }
    }
    @Test fun `double confirmation permits only one POST after explicit review`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        withModel(f) { model -> model.start("coastal_survey")?.join(); val review = requireNotNull(model.state.value.review)
            val first = model.confirm(review); entered.await(); assertNull(model.confirm(review)); release.complete(Unit); first?.join()
            assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof) }
    }
    @Test fun `dismissed consent stays saved without dispatch after foreground`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model -> model.start("coastal_survey")?.join(); val review = requireNotNull(model.state.value.review)
            model.dismiss(); model.confirm(review)?.join(); model.foreground()
            assertNull(model.state.value.review); assertEquals(review.command, f.store.read().operation!!.command)
            assertNull(f.store.read().operation!!.attemptRevision); assertEquals(0, f.posts) }
    }
    @Test fun `foreground never retries response loss while original history remains reachable`() = runBlocking<Unit> {
        val f = Fixture(); f.onPost = { throw IOException("lost reply") }
        withModel(f) { model -> model.start("coastal_survey")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            model.dismiss(); f.allowed = false; f.selected = null; model.foreground()
            assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.attemptRevision); assertNull(f.store.read().operation!!.proof)
            assertTrue(starterExpeditionEntryAvailable(model.state.value)); assertNull(model.state.value.view) }
    }
    @Test fun `screen foreground waits for Wallet discovery admission without losing original consent`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var first = true
        f.account = { if (first) { first = false; entered.complete(Unit); release.await() } }
        withModel(f) { model -> coroutineScope { val discovery = async { runCatching { f.repository.refresh() } }; entered.await()
            model.dismiss(); val foreground = async { model.foreground() }; yield(); assertFalse(foreground.isCompleted)
            release.complete(Unit); discovery.await(); foreground.await(); assertNotNull(model.state.value.view)
            assertFalse(model.busy.value); assertNull(model.state.value.review); assertEquals(0, f.posts) } }
    }
    @Test fun `old server hides new entry while saved and corrupt journals remain recoverable`() = runBlocking<Unit> {
        assertFalse(starterExpeditionEntryAvailable(null)); assertTrue(starterExpeditionEntryAvailable(null, storageUnavailable = true))
        val f = Fixture(); f.unsupported = true
        withModel(f) { model -> model.foreground(); assertFalse(starterExpeditionEntryAvailable(model.state.value)); f.unsupported = false
            model.start("coastal_survey")?.join(); f.selected = null; model.dismiss()
            assertTrue(starterExpeditionEntryAvailable(model.state.value.copy(advertised = false, view = null)))
            model.archiveUnusedOrRefused()?.join(); assertTrue(starterExpeditionEntryAvailable(model.state.value.copy(advertised = false, view = null)))
            assertEquals(0, f.posts) }
    }
    @Test fun `foreground observes archived automatic return after transfer without posting again`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model -> model.start("coastal_survey")?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            model.finish()?.join(); val frozen = f.store.read().archives.single().operation.proof!!.receipt
            f.selected = null; f.allowed = false; f.completed = true; val reads = f.currentReads; model.dismiss(); model.foreground()
            assertEquals(frozen, f.store.read().archives.single().operation.proof!!.receipt)
            assertNotNull(f.store.read().archives.single().operation.proof!!.returned); assertEquals(reads, f.currentReads)
            assertEquals(1, f.posts); assertTrue(starterExpeditionEntryAvailable(model.state.value)) }
    }
    @Test fun `explicit archived recovery preserves draft or refusal history and foreground follows only unfinished positive proof`() = runBlocking<Unit> {
        for (refused in listOf(false, true)) {
            val f = Fixture(); withModel(f) { model ->
                model.start("coastal_survey")?.join()
                if (refused) {
                    f.onPost = { throw ApiException(503, "STARTER_EXPEDITIONS_DISABLED", "paused") }
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
                val complete = f.store.read().archives.single(); assertNotNull(complete.operation.proof!!.returned)
                assertEquals(original, complete.copy(operation = complete.operation.copy(proof = null)))
                val terminalReads = f.receiptReads; model.foreground(); assertEquals(terminalReads, f.receiptReads)
                model.checkArchived(key)?.join(); assertEquals(terminalReads + 1, f.receiptReads)
                assertEquals(if (refused) 1 else 0, f.posts); assertNull(model.state.value.view)
            }
        }
    }

}
