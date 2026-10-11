package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.economy.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.harvester.*
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionHome
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import java.io.IOException
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Synthetic server terms test screen consent and GET-only original history, not device or earning authority. */
@OptIn(ExperimentalCoroutinesApi::class)
class HarvesterViewModelTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val key = id(2)
    private val now = "2026-09-22T12:00:00.000Z"
    private val format = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    private fun after(seconds: Long) = format.format(Instant.parse(now).plusSeconds(seconds))
    private val policy = HarvesterPolicy(1, 1, "99", "7", 17, 255, 1, 100, 30)
    private val facility = HarvesterFacility(BASE_ID, id(3), id(4), after(-1))
    private val realms = listOf("frost_quartz" to "frostveil", "heartwood_logs" to "elderwood", "sunstone_rubble" to "sunscar",
        "crown_iron_ore" to "crownlands", "rough_prism" to "seeker-reach", "storm_ore" to "stormcairn", "thorn_fibre" to "thornwake", "ember_nodules" to "cinderfall")
    private fun view() = HarvesterView(WALLET, BASE_ID, now, HarvesterFeatures(HarvesterFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), listOf(facility), null, null, policy,
        realms.map { OrdinaryRawStock(it.first, "9", "1", "10") })
    private fun head() = HarvesterSummary(id(8), id(9), id(10), policy.policyVersion, "crownlands", "crown_iron_ore", after(-100), after(-1))
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder); val wire = FakeApiClient(); val memory = MemoryStore()
        val store = HarvesterStore(memory, HarvesterIdentity(session.origin, "devnet", WALLET))
        var selected: String? = BASE_ID; var generation = 0L; var allowed = true; var v = view()
        var dir: BaseDirectory? = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(BASE_ID, "active", slot = 0)))
        var posts = 0; var currentReads = 0; var receiptReads = 0; var hydrates = 0; var accepted = false; var completed = false; var closed = true
        var published = false; var unsupported = false; var malformed = false
        var beforeEnqueue: () -> Unit = {}; var afterView: () -> Unit = {}; var afterProof: () -> Unit = {}
        var account: suspend () -> Unit = {}; var beforeHydration: () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }
        var afterPostProof: () -> Unit = {}
        fun proof(): JsonObject {
            val c = store.read().let { it.operation?.command ?: it.archives.single().operation.command }
            val receipt = if (accepted) HarvesterReceipt(WALLET, c.request,
                HarvesterSource(c.key, c.request.baseId, c.request.harvesterId, c.policy.policyVersion, c.realmId,
                    realms.single { it.second == c.realmId }.first, now, after(c.policy.maxLeaseSec), c.facility.completedBuildJobId,
                    c.facility.harvesterCompletedAt, HarvesterTerm(id(6), "a".repeat(64), after(-60), after(3_600)), c.policy)) else null
            val event = HarvesterEvent(c.key, 1, "1", "crown_iron_ore", policy.policyVersion, after(policy.cadenceSec), after(policy.cadenceSec + 1),
                "2026-09-22T00:00:00.000Z", "7", "5", "2", policy.taxPolicyVersion, policy.taxBasisPoints, policy.islandPoolBps, "0", "10")
            val settlement = if (accepted) HarvesterSettlement(if (completed) listOf(event) else emptyList(),
                if (completed && closed) HarvesterClosure(c.key, "custody_change", after(policy.cadenceSec + 1), 1) else null,
                if (completed) HarvesterCustodyStop(c.key, after(policy.cadenceSec + 1), after(policy.cadenceSec), "b".repeat(64)) else null) else null
            return Json.encodeToJsonElement(HarvesterProof(WALLET, c.key, after(policy.maxLeaseSec + 30),
                if (accepted) "accepted" else "unknown", receipt, settlement)).jsonObject
        }
        val api = object : ApiClient by wire {
            override suspend fun getHarvester(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                if (path == "/harvesters") {
                    currentReads++; assertEquals(mapOf("baseId" to BASE_ID), query); assertNull(evidence)
                    if (unsupported) throw ApiException(404, null, "route absent")
                    val raw = if (malformed) JsonObject(emptyMap()) else Json.encodeToJsonElement(v).jsonObject
                    afterView(); return raw
                }
                receiptReads++; assertTrue(query.isEmpty()); assertEquals("/harvesters/sources/by-key/" + key, path)
                return proof().also { afterProof(); requireNotNull(evidence)(it); holder.requireCurrent(session) }
            }
            override suspend fun postHarvester(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                beforeEnqueue(); guard(); assertEquals("/harvesters/sources", path)
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
        val repository = HarvesterRepository(session, holder, api, store, { selected }, { generation }, { dir },
            { account() }, { guard -> hydrates++; beforeHydration(); guard(); published = true }, { allowed }, { key })
        suspend fun review(): HarvesterReview { repository.reviewSelection(facility.harvesterId); return requireNotNull(repository.state.value.review) }
    }
    private suspend fun withModel(f: Fixture, block: suspend (HarvesterViewModel) -> Unit) {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val model = HarvesterViewModel(f.repository)
        try { withTimeout(5_000) { block(model) } } finally { model.viewModelScope.cancel(); Dispatchers.resetMain() }
    }
    @Test fun `foreground discovers server source support without saving or posting a command`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.foreground(); assertTrue(harvesterEntryAvailable(model.state.value))
            assertEquals(f.v, model.state.value.view); assertNull(f.store.read().operation)
            assertEquals(1, f.currentReads); assertEquals(0, f.receiptReads); assertEquals(0, f.posts)
        }
    }
    @Test fun `invalid facility cannot save intent while full server review never dispatches`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start(id(999))?.join(); assertNull(f.store.read().operation); assertTrue(model.notice.value!!.error)
            model.start(facility.harvesterId)?.join(); val review = requireNotNull(model.state.value.review)
            assertEquals(policy, review.command.policy); assertEquals(facility, review.command.facility)
            assertNull(review.command.request.expectedSourceId); assertNull(f.store.read().operation!!.attemptRevision); assertEquals(0, f.posts)
        }
    }
    @Test fun `explicit replacement review freezes expired selected head and cannot silently follow closure`() = runBlocking<Unit> {
        val f = Fixture(); f.v = f.v.copy(walletSource = head())
        withModel(f) { model ->
            model.start(facility.harvesterId)?.join(); val review = requireNotNull(model.state.value.review)
            assertEquals(head(), review.command.replacedSource); assertEquals(head().sourceId, review.command.request.expectedSourceId)
            assertEquals(0, f.posts); f.v = f.v.copy(walletSource = null)
            model.confirm(review)?.join(); assertEquals(0, f.posts); assertTrue(model.notice.value!!.error)
            assertEquals(review.command, f.store.read().operation!!.command); assertNull(f.store.read().operation!!.attemptRevision)
        }
    }
    @Test fun `double confirmation sends one source POST after explicit review`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        withModel(f) { model ->
            model.start(facility.harvesterId)?.join(); val review = requireNotNull(model.state.value.review)
            val first = model.confirm(review); entered.await(); assertNull(model.confirm(review))
            release.complete(Unit); first?.join(); assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.proof)
        }
    }
    @Test fun `dismissed or cancelled review remains saved without dispatch when foreground returns`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start(facility.harvesterId)?.join(); val review = requireNotNull(model.state.value.review)
            model.dismiss(); model.confirm(review)?.join(); model.foreground()
            assertNull(model.state.value.review); assertEquals(review.command, f.store.read().operation!!.command)
            assertNull(f.store.read().operation!!.attemptRevision); assertEquals(0, f.posts)
        }
    }
    @Test fun `foreground never retries a lost acknowledgement while paused no-base history remains reachable`() = runBlocking<Unit> {
        val f = Fixture(); f.onPost = { throw IOException("lost reply") }
        withModel(f) { model ->
            model.start(facility.harvesterId)?.join(); model.confirm(requireNotNull(model.state.value.review))?.join()
            model.dismiss(); f.allowed = false; f.selected = null; model.foreground()
            assertEquals(1, f.posts); assertNotNull(f.store.read().operation!!.attemptRevision); assertNull(f.store.read().operation!!.proof)
            assertTrue(harvesterEntryAvailable(model.state.value)); assertNull(model.state.value.view)
        }
    }
    @Test fun `screen foreground joins Wallet discovery before issuing another current GET`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var first = true
        f.account = { if (first) { first = false; entered.complete(Unit); release.await() } }
        withModel(f) { model -> coroutineScope {
            val discovery = async { runCatching { f.repository.refresh() } }; entered.await()
            model.dismiss(); val foreground = async { model.foreground() }; yield(); assertFalse(foreground.isCompleted)
            release.complete(Unit); discovery.await(); foreground.await()
            assertNotNull(model.state.value.view); assertFalse(model.busy.value); assertNull(model.state.value.review); assertEquals(0, f.posts)
        } }
    }
    @Test fun `unsupported current server hides only new entry while saved and unreadable journals stay reachable`() = runBlocking<Unit> {
        assertFalse(harvesterEntryAvailable(null)); assertTrue(harvesterEntryAvailable(null, storageUnavailable = true))
        val f = Fixture(); f.unsupported = true
        withModel(f) { model ->
            model.foreground(); assertFalse(harvesterEntryAvailable(model.state.value)); f.unsupported = false
            model.start(facility.harvesterId)?.join(); f.selected = null; model.dismiss()
            assertTrue(harvesterEntryAvailable(model.state.value.copy(advertised = false, view = null)))
            model.archiveUnusedOrRefused()?.join()
            assertTrue(harvesterEntryAvailable(model.state.value.copy(advertised = false, view = null))); assertEquals(0, f.posts)
        }
    }
    @Test fun `foreground observes archived settlement after transfer with GET and stops automatic checks at closure`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start(facility.harvesterId)?.join(); model.confirm(requireNotNull(model.state.value.review))?.join(); model.finish()?.join()
            val original = f.store.read().archives.single().operation.proof!!.originalReceipt
            f.selected = null; f.allowed = false; f.completed = true
            val currentReads = f.currentReads; val receiptReads = f.receiptReads
            model.dismiss(); model.foreground()
            val observed = f.store.read().archives.single().operation.proof!!
            assertEquals(original, observed.originalReceipt); assertEquals(1, observed.settlement!!.events.size)
            assertNotNull(observed.settlement!!.closure); assertNotNull(observed.settlement!!.custodyStop)
            assertEquals(receiptReads + 1, f.receiptReads); assertEquals(currentReads, f.currentReads); assertNull(model.state.value.view)
            model.foreground(); assertEquals(receiptReads + 1, f.receiptReads)
            model.checkArchived(key)?.join(); assertEquals(receiptReads + 2, f.receiptReads) // Explicit verification remains available.
            assertEquals(1, f.posts); assertTrue(harvesterEntryAvailable(model.state.value))
        }
    }
    @Test fun `custody stop alone does not imply final closure or suppress later earned-event recovery`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start(facility.harvesterId)?.join(); model.confirm(requireNotNull(model.state.value.review))?.join(); model.finish()?.join()
            f.selected = null; f.completed = true; f.closed = false
            model.foreground(); val reads = f.receiptReads
            assertNotNull(f.store.read().archives.single().operation.proof!!.settlement!!.custodyStop)
            assertNull(f.store.read().archives.single().operation.proof!!.settlement!!.closure)
            model.foreground(); assertEquals(reads + 1, f.receiptReads)
            f.closed = true; model.foreground(); assertEquals(reads + 2, f.receiptReads)
            model.foreground(); assertEquals(reads + 2, f.receiptReads); assertEquals(1, f.posts)
        }
    }
    @Test fun `paused retired account changed base and cancellation at actual enqueue never send the saved command`() = runBlocking<Unit> {
        for (reason in listOf("paused", "account", "base", "screen", "cancel")) {
            val f = Fixture(); withModel(f) { model ->
                model.start(facility.harvesterId)?.join(); val review = requireNotNull(model.state.value.review)
                f.beforeEnqueue = { when (reason) {
                    "paused" -> f.allowed = false; "account" -> f.holder.replace(null); "base" -> f.generation += 2
                    "screen" -> model.dismiss(); else -> throw CancellationException("cancelled before enqueue")
                } }
                model.confirm(review)?.join(); assertEquals(0, f.posts)
                assertEquals(review.command, f.store.read().operation!!.command); assertNotNull(f.store.read().operation!!.attemptRevision)
                assertNull(f.store.read().operation!!.proof); assertNull(f.store.read().operation!!.refusal)
            }
        }
    }
    @Test fun `foreground waits for cancelled owned response drain and recovers its proof without resubmission`() = runBlocking<Unit> {
        val f = Fixture(); val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.onPost = { entered.complete(Unit); release.await(); f.accepted = true }
        withModel(f) { model -> coroutineScope {
            model.start(facility.harvesterId)?.join(); val posting = requireNotNull(model.confirm(requireNotNull(model.state.value.review)))
            entered.await(); model.dismiss(); posting.cancel()
            val foreground = async { model.foreground() }; yield(); assertFalse(foreground.isCompleted)
            release.complete(Unit); posting.join(); foreground.await()
            assertNotNull(f.store.read().operation!!.proof); assertNull(model.state.value.review); assertFalse(model.busy.value)
            assertEquals(1, f.posts)
        } }
    }
    @Test fun `out of order archived evidence shows an error without erasing its durable frontier`() = runBlocking<Unit> {
        val f = Fixture(); withModel(f) { model ->
            model.start(facility.harvesterId)?.join(); model.confirm(requireNotNull(model.state.value.review))?.join(); model.finish()?.join()
            f.selected = null; f.completed = true; model.foreground(); val bytes = f.memory.read()
            f.completed = false; model.checkArchived(key)?.join()
            assertTrue(model.notice.value!!.error); assertEquals(bytes, f.memory.read())
            assertNotNull(f.store.read().archives.single().operation.proof!!.settlement!!.closure); assertEquals(1, f.posts)
        }
    }
    @Test fun `explicit archived recovery preserves draft or refusal history and foreground follows only unfinished positive proof`() = runBlocking<Unit> {
        for (refused in listOf(false, true)) {
            val f = Fixture(); withModel(f) { model ->
                model.start(facility.harvesterId)?.join()
                if (refused) {
                    f.onPost = { throw ApiException(503, "HARVESTERS_DISABLED", "paused") }
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

                f.completed = true; f.closed = false; model.foreground()
                assertNotNull(f.store.read().archives.single().operation.proof!!.settlement!!.custodyStop)
                assertNull(f.store.read().archives.single().operation.proof!!.settlement!!.closure)
                val stoppedReads = f.receiptReads; model.foreground(); assertEquals(stoppedReads + 1, f.receiptReads)
                f.closed = true
                model.foreground()
                val complete = f.store.read().archives.single(); assertNotNull(complete.operation.proof!!.settlement!!.closure)
                assertEquals(original, complete.copy(operation = complete.operation.copy(proof = null)))
                val terminalReads = f.receiptReads; model.foreground(); assertEquals(terminalReads, f.receiptReads)
                model.checkArchived(key)?.join(); assertEquals(terminalReads + 1, f.receiptReads)
                assertEquals(if (refused) 1 else 0, f.posts); assertNull(model.state.value.view)
            }
        }
    }

}
