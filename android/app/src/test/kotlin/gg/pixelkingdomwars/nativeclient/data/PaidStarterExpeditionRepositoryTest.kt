package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import kotlinx.coroutines.*
import kotlinx.coroutines.test.*
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.ui.economy.StarterExpeditionViewModel
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException

/** Full encoded historical proof survives recovery; selected display never becomes authority. */
class PaidStarterExpeditionRepositoryTest {
    private val json = Json { encodeDefaults = true }
    private val fixture = json.parseToJsonElement(requireNotNull(javaClass.getResource("/paid-starter-expedition.json")).readText()).jsonObject
    private val envelope = fixture.getValue("envelope").jsonObject
    private val receipt = json.decodeFromJsonElement<StarterExpeditionReceipt>(envelope.getValue("receipt"))
    private val paid = receipt.route.copy(access = StarterExpeditionAccess("paid_realm", 1))
    private val base = receipt.request.baseId
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val installed = StarterFleetInstallation(receipt.installationId, base, id(8), "starter", id(9), receipt.departedAt, receipt.departedAt)
    private val resources = listOf("frost_quartz", "heartwood_logs", "sunstone_rubble", "crown_iron_ore", "rough_prism", "storm_ore", "thorn_fibre", "ember_nodules")
    private fun currentView() = StarterExpeditionView(receipt.wallet, base, receipt.departedAt,
        StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true, StarterExpeditionHome("free_assignment", 1, "crownlands"),
        (listOf("introduction", "coastal_survey", "long_survey") + paidStarterRealmIds.map { "common_${it.replace('-', '_')}" }).map { route ->
            val realm = if (route.startsWith("common_")) route.removePrefix("common_").replace('_', '-') else "crownlands"
            paid.copy(routeCatalogueVersion = 2, routeId = route, realmId = realm, resourceId = resources[paidStarterRealmIds.indexOf(realm)],
                access = if (route.startsWith("common_")) StarterExpeditionAccess("starter_common", 1) else null) },
        installed, null, receipt.departedAt, resources.map { OrdinaryRawStock(it, "0", "0", "0") })
    private fun preview() = PaidStarterExpeditionView(receipt.wallet, base, 0, receipt.departedAt, "none", true, paid,
        PaidStarterCoverage("covered", receipt.route.access!!.observation!!.expiresAt, receipt.departedAt))
    private inner class Fixture {
        val holder = testHolder(); val session = signedIn(holder, receipt.wallet); val memory = MemoryStore()
        val store = StarterExpeditionStore(memory, StarterIdentity(session.origin, "devnet", session.wallet))
        var selected: String? = base; var generation = 0L; var allowed = true; var current = currentView(); var paidView = preview()
        var dir = BaseDirectory(true, capabilities = BaseCapabilities(true, true), bases = listOf(BaseSummary(base, "active", slot = 0)))
        var posts = 0; var selectedReads = 0; var currentReads = 0; var receiptReads = 0; var hydrates = 0
        var accepted = false; var returned = false; var providerLost = false
        var afterSelected: () -> Unit = {}; var beforeEnqueue: () -> Unit = {}; var onPost: suspend () -> Unit = { accepted = true }
        val wire = object : ApiClient by FakeApiClient() {
            override suspend fun getStarterExpedition(path: String, query: Map<String, String>, guard: () -> Unit, evidence: ((JsonObject) -> Unit)?): JsonObject {
                guard()
                return when (path) {
                    "/starter-expeditions" -> { currentReads++; assertEquals(mapOf("baseId" to base), query); json.encodeToJsonElement(current).jsonObject }
                    "/starter-expeditions/paid-route" -> { selectedReads++; assertEquals(mapOf("baseId" to base, "realm" to "0"), query); assertNull(evidence)
                        if (providerLost) throw IOException("access provider unavailable")
                        json.encodeToJsonElement(paidView).jsonObject.also { afterSelected() } }
                    else -> { receiptReads++; assertEquals("/starter-expeditions/by-key/${receipt.request.idempotencyKey}", path); assertTrue(query.isEmpty())
                        proof().also { requireNotNull(evidence)(it); holder.requireCurrent(session) } }
                }
            }
            // Forward the repository's departure-aware entry to THIS fake's body-only response;
            // delegation to FakeApiClient bypasses the override. No fabricated 201/created evidence.
            override suspend fun postStarterExpeditionWithDeparture(path: String, body: JsonObject, guard: () -> Unit,
                evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit,
                created: (gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture) -> Unit): JsonObject =
                postStarterExpedition(path, body, guard, evidence, refusal)
            override suspend fun postStarterExpedition(path: String, body: JsonObject, guard: () -> Unit, evidence: (JsonObject) -> Unit, refusal: (ApiException) -> Unit): JsonObject {
                beforeEnqueue(); guard(); posts++; assertEquals(receipt.request.body(), body)
                assertNotNull(store.read().operation!!.attemptRevision)
                try { onPost() } catch (e: ApiException) { refusal(e); throw e }
                return proof().also(evidence)
            }
        }
        fun proof(): JsonObject {
            if (!accepted) return json.encodeToJsonElement(StarterExpeditionProof(session.wallet, receipt.request.idempotencyKey, receipt.departedAt, "unknown", null, null)).jsonObject
            return if (!returned) envelope else json.encodeToJsonElement(StarterExpeditionProof(session.wallet, receipt.request.idempotencyKey,
                "2030-01-01T00:00:00.000Z", "accepted", receipt, StarterExpeditionReturn(id(7), "2030-01-01T00:00:00.000Z"))).jsonObject
        }
        fun repository() = StarterExpeditionRepository(session, holder, wire, store, { selected }, { generation }, { dir }, {},
            { guard -> guard(); hydrates++ }, { allowed }, { receipt.request.idempotencyKey })
        val repo = repository()
        suspend fun review(): StarterExpeditionReview { repo.reviewPaidDeparture(0); return requireNotNull(repo.state.value.review) }
    }
    private fun rejects(block: () -> Unit) { assertThrows(Exception::class.java) { block() } }

    /** Every explicit wait names the stage that would otherwise stall the app test module. */
    private suspend fun Job.joinBounded(stage: String) = try {
        withTimeout(5_000) { join() }
    } catch (error: TimeoutCancellationException) {
        throw AssertionError("Paid starter expedition fixture timed out waiting for $stage", error)
    }

    @Test fun `selected read is display only and explicit review saves immutable original economics`() = runBlocking {
        val f = Fixture(); f.repo.selectPaidRealm(0); assertEquals(f.paidView, f.repo.state.value.paidView)
        assertNull(f.store.read().operation); assertEquals(0, f.posts)
        val review = f.review(); assertEquals(paid, review.command.route); assertNull(review.command.route.access!!.observation)
        assertEquals(review.command, f.store.read().operation!!.command); assertEquals(11, review.view.routes.size)
    }
    @Test fun `committed lost reply recovers original GET before pause provider loss and transfer then returns after expiry`() = runBlocking {
        val f = Fixture(); val review = f.review(); f.onPost = { f.accepted = true; throw IOException("lost accepted reply") }
        rejects { runBlocking { f.repo.confirm(review) } }; assertNull(f.store.read().operation!!.proof)
        f.allowed = false; f.providerLost = true; f.selected = null; f.generation++; f.dir = f.dir.copy(bases = emptyList())
        val reads = f.selectedReads; val recovered = f.repository(); recovered.reviewSaved()
        assertEquals(receipt, f.store.read().operation!!.proof!!.receipt); assertEquals(reads, f.selectedReads)
        recovered.finish(); assertEquals(0, f.hydrates); assertEquals(StarterExpeditionHydration.ORIGINAL_BASE_UNAVAILABLE, recovered.state.value.hydration)
        f.returned = true; recovered.checkArchived(receipt.request.idempotencyKey)
        assertNotNull(f.store.read().archives.single().operation.proof!!.returned)
        assertEquals(receipt, f.store.read().archives.single().operation.proof!!.receipt); assertEquals(1, f.posts)
    }
    @Test fun `unknown paid POST remains held after repository recreation with no second POST or current selected read`() = runBlocking {
        val f = Fixture(); val review = f.review(); f.onPost = { throw IOException("outcome unknown") }
        rejects { runBlocking { f.repo.confirm(review) } }; val saved = f.store.read(); val reads = f.selectedReads
        val next = f.repository(); next.check(); rejects { runBlocking { next.reviewSaved() } }
        assertEquals(saved, f.store.read()); assertEquals(reads, f.selectedReads); assertEquals(1, f.posts)
        // Rewritten 2026-10-06 (dead-end audit): it stays held from any resend, but no longer forever (owner: no saved request
        // may block play forever). After a fresh `unknown` receipt the explicit close keeps it only as an "unknown" archive.
        next.archiveDraftOrRefusal(); val closed = f.store.read().archives.single()
        assertEquals("unknown", closed.reason); assertEquals(saved.operation, closed.operation); assertNull(f.store.read().operation)
        assertEquals(reads, f.selectedReads); assertEquals(1, f.posts)
    }
    @Test fun `selected read guards session screen and A B A base selection before draft or display publication`() = runBlocking {
        for (reason in listOf("session", "screen", "selection")) {
            val f = Fixture(); f.afterSelected = { when (reason) { "session" -> f.holder.replace(null); "screen" -> f.repo.dismiss(); else -> f.generation += 2 } }
            rejects { runBlocking { f.review() } }; assertNull(f.store.read().operation); assertNull(f.repo.state.value.paidView); assertEquals(0, f.posts)
        }
    }
    @Test fun `changed paid economics coverage or installation cannot change consent at confirmation`() = runBlocking {
        for (reason in listOf("terms", "coverage", "fleet")) {
            val f = Fixture(); val review = f.review()
            when (reason) { "terms" -> f.paidView = f.paidView.copy(route = paid.copy(durationSec = paid.durationSec + 1))
                "coverage" -> f.paidView = f.paidView.copy(coverage = PaidStarterCoverage("unavailable"))
                else -> f.current = f.current.copy(installation = installed.copy(installationId = id(22))) }
            rejects { runBlocking { f.repo.confirm(review) } }; assertEquals(0, f.posts); assertNull(f.store.read().operation!!.attemptRevision)
            assertEquals(review.command, f.store.read().operation!!.command)
        }
    }
    @Test fun `paid final enqueue rechecks lifecycle account and mutable base authority`() = runBlocking {
        for (reason in listOf("screen", "session", "gate", "selection", "owner")) {
            val f = Fixture(); val review = f.review(); f.beforeEnqueue = { when (reason) {
                "screen" -> f.repo.dismiss(); "session" -> f.holder.replace(null); "gate" -> f.allowed = false
                "selection" -> f.generation += 2; else -> f.dir = f.dir.copy(bases = emptyList()) } }
            rejects { runBlocking { f.repo.confirm(review) } }; assertEquals(0, f.posts); assertNotNull(f.store.read().operation!!.attemptRevision)
        }
    }
    @OptIn(ExperimentalCoroutinesApi::class)
    @Test fun `paid view model selection and foreground never dispatch and unknown explicit review cannot resend`() = runBlocking {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val f = Fixture(); val model = StarterExpeditionViewModel(f.repo)
        try {
            model.selectPaid(0)?.joinBounded("paid selection display"); assertNull(f.store.read().operation); assertEquals(0, f.posts)
            model.startPaid(0)?.joinBounded("paid departure review"); val review = requireNotNull(model.state.value.review)
            f.onPost = { throw IOException("lost reply") }; model.confirm(review)?.joinBounded("unknown paid POST completion"); assertEquals(1, f.posts)
            model.dismiss(); model.foreground(); model.reviewSaved()?.joinBounded("saved paid review after foreground")
            assertTrue(requireNotNull(model.notice.value).error); assertNull(model.state.value.review); assertEquals(1, f.posts)
            assertEquals(review.command, f.store.read().operation!!.command)
        } finally { model.viewModelScope.cancel(); Dispatchers.resetMain() }
    }
    @Test fun `accepted paid original archives only after current stock hydration`() = runBlocking {
        val f = Fixture(); f.repo.confirm(f.review()); f.current = f.current.copy(acceptingDepartures = false); f.providerLost = true
        f.repo.finish(); assertEquals(1, f.hydrates); assertEquals(receipt, f.store.read().archives.single().operation.proof!!.receipt)
        assertEquals(StarterExpeditionHydration.CURRENT_ORIGINAL_BASE, f.repo.state.value.hydration)
    }
}
