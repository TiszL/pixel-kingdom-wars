package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.features.*
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** review 713ccef2 A2. Authored before the gate patch; execution belongs to Cedar3. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class HarvesterEntryMountTest {
    @Test fun `Workshop missing building still falls back and never becomes a Harvester warm request`() =
        assertOtherFamilyFallback("workshop.craft", "workshop")

    @Test fun `Lodge missing building still falls back and never becomes a Harvester warm request`() =
        assertOtherFamilyFallback("lodge.expedition", "lodge")

    @Test fun `Berth missing building still falls back and never becomes a Harvester warm request`() =
        assertOtherFamilyFallback("berth.fleet", "berth")

    @Test fun `missing Harvester storage owner keeps recovery page reachable for an unknown fact`() {
        // 71fb65a4: the existing recovery page tells the player to preserve app data and unsettled receipts.
        val f = Fixture(); f.prepared = HomeNavigationResult.REFUSED
        f.tap()
        assertEquals(GateFact.Unknown, f.fact)
        assertEquals(1, f.legacy); assertNull(f.requests.pending.value)
        assertEquals(0, f.navigations); assertTrue(f.reasons.isEmpty())
    }

    @Test fun `unknown Harvester tap captures a read request without navigating legacy`() {
        val f = Fixture(); f.tap()
        val request = f.requests.pending.value as HomeRequest.Open
        assertEquals(f.id, request.featureId); assertEquals(f.identity, request.identity)
        assertEquals(f.selection, request.selection.building)
        assertEquals(0, f.legacy); assertEquals(0, f.navigations)
        assertEquals(HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
        assertSame(request, f.requests.pending.value)
        f.fact = GateFact.Allowed; f.prepared = HomeNavigationResult.DISPATCHED
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(1, f.navigations); assertNull(f.requests.pending.value)
    }

    @Test fun `unknown request still resolves the current denied server response`() {
        val f = Fixture(); f.tap(); val request = f.requests.pending.value as HomeRequest.Open
        f.fact = GateFact.Denied("Server closed"); f.prepared = HomeNavigationResult.DISPATCHED
        assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(request))
        assertEquals(0, f.navigations); assertEquals(0, f.legacy)
        assertEquals(listOf("Server closed"), f.reasons)
    }

    @Test fun `unknown capture does not bypass missing unfinished or denied gates`() {
        for (kind in listOf("missing", "unfinished", "denied", "owner", "wallet")) {
            val extra = when (kind) { "owner" -> Gate.OwnerFact("read.owner"); "wallet" -> Gate.WalletLinked(); else -> Gate.Open }
            val f = Fixture(extra)
            when (kind) {
                "missing" -> f.buildings = emptyMap()
                "unfinished" -> f.buildings = mapOf("harvester" to BuildingGateState(1, false))
                "denied" -> f.fact = GateFact.Denied("Server closed")
            }
            f.tap(); assertNull(kind, f.requests.pending.value)
            assertEquals(kind, 0, f.navigations); assertEquals(kind, 1, f.legacy)
        }
    }

    @Test fun `unknown capture preserves blocked admission refusal and stale selection guards`() {
        for (kind in listOf("blocked", "unmounted", "refused", "no-current", "wrong-base", "selection")) {
            val f = Fixture()
            when (kind) {
                "blocked" -> f.blocked.value = true
                "unmounted" -> f.mounted = false
                "refused" -> f.refusal = "Finish review"
                "no-current" -> f.current = null
                "wrong-base" -> f.contextBase = "other-base"
            }
            f.dispatcher.openBuildingDoor(f.id, if (kind == "selection") f.selection.copy(buildingId = "retired") else f.selection)
            assertNull(kind, f.requests.pending.value); assertEquals(kind, 0, f.navigations)
        }
    }

    @Test fun `queued read cannot navigate after wallet owner base or generation changes`() {
        for (kind in listOf("owner", "base", "generation")) {
            val f = Fixture(); f.tap(); val request = f.requests.pending.value as HomeRequest.Open
            f.current = when (kind) {
                "owner" -> f.identity.copy(session = Any())
                "base" -> f.identity.copy(baseId = "replacement")
                else -> f.identity.copy(baseSelectionGeneration = 2)
            }
            f.fact = GateFact.Allowed; f.prepared = HomeNavigationResult.DISPATCHED
            assertEquals(kind, HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
            assertEquals(kind, 0, f.navigations)
        }
    }

    @Test fun `second unknown tap retains the exact queued request and explains once`() {
        val f = Fixture(); f.tap(); val request = f.requests.pending.value
        f.tap(); assertSame(request, f.requests.pending.value)
        assertEquals(listOf("Opening Harvester. Please wait."), f.reasons)
        assertEquals(0, f.legacy); assertEquals(0, f.navigations)
    }

    @Test fun `failed warm read can claim once again at the next admitted resume`() = runTest {
        val proof = HomeFeatureReadCapture(HomeRouteIdentity(Any(), "base", 1))
        assertTrue(proof.claimWarmRead(false)); assertFalse(proof.claimWarmRead(false))
        proof.refresh({ error("offline") }, { true })
        assertEquals(HomeFeatureReadStatus.FAILED, proof.status)
        assertTrue(proof.claimWarmRead(false)); assertFalse(proof.claimWarmRead(false))
        proof.refresh({ true }, { true })
        assertEquals(HomeFeatureReadStatus.READY, proof.status); assertFalse(proof.claimWarmRead(false))
    }

    @Test fun `pending or bound explicit request wins over failed warm retry`() = runTest {
        val identity = HomeRouteIdentity(Any(), "base", 1); val proof = HomeFeatureReadCapture(identity)
        assertTrue(proof.claimWarmRead(false)); proof.refresh({ false }, { true })
        assertFalse(proof.claimWarmRead(true)); assertEquals(HomeFeatureReadStatus.FAILED, proof.status)
        val request = HomeRequest.Open(FeatureId("harvester.harvest"), identity, FeatureSelection())
        proof.refreshFor(request, { false }, { true })
        assertEquals(HomeFeatureReadStatus.FAILED, proof.statusFor(request))
        assertFalse(proof.claimWarmRead(false))
        proof.refreshFor(request, { true }, { true })
        assertEquals(HomeFeatureReadStatus.READY, proof.statusFor(request))
    }

    @Test fun `in flight warm read cannot claim again and late warm failure cannot replace explicit proof`() = runTest {
        val identity = HomeRouteIdentity(Any(), "base", 1); val proof = HomeFeatureReadCapture(identity)
        assertTrue(proof.claimWarmRead(false)); val finish = CompletableDeferred<Unit>()
        val warm = launch { proof.refresh({ finish.await(); false }, { true }) }; runCurrent()
        assertFalse(proof.claimWarmRead(false))
        val request = HomeRequest.Open(FeatureId("harvester.harvest"), identity, FeatureSelection())
        proof.refreshFor(request, { true }, { true }); finish.complete(Unit); warm.join()
        assertEquals(HomeFeatureReadStatus.READY, proof.statusFor(request))
        assertFalse(proof.claimWarmRead(false))
    }

    @Test fun `warm retry remains one admitted lifecycle read without a polling loop`() {
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        val warm = source.substringAfter("// One optional Harvester GET per Home presentation.")
            .substringBefore("// A request-specific GET supplies")
        assertTrue(warm.contains("repeatOnLifecycle(Lifecycle.State.RESUMED)"))
        assertTrue(warm.contains("awaitHomeReadAdmission(signals)"))
        assertTrue(warm.contains("homeHasCompletedHarvester(session.base.state.value, proof.identity)"))
        assertTrue(warm.contains("proof.claimWarmRead(requestPending ="))
        assertTrue(warm.contains("kotlinx.coroutines.awaitCancellation()"))
        assertFalse(warm.contains("while (")); assertFalse(warm.contains("delay("))
    }

    private fun assertOtherFamilyFallback(feature: String, type: String) {
        val f = Fixture(feature = feature, type = type)
        f.buildings = emptyMap(); f.tap()
        assertNull(f.requests.pending.value); assertEquals(1, f.legacy); assertEquals(0, f.navigations)
        assertTrue(f.reasons.isEmpty())
        f.buildings = mapOf(type to BuildingGateState(1, true)); f.tap()
        assertEquals(f.id, (f.requests.pending.value as HomeRequest.Open).featureId)
        assertEquals(1, f.legacy); assertEquals(0, f.navigations)
    }

    private class Fixture(extraGate: Gate = Gate.Open, feature: String = "harvester.harvest", type: String = "harvester") {
        val identity = HomeRouteIdentity(Any(), "base", 1)
        var current: HomeRouteIdentity? = identity
        var contextBase = identity.baseId
        val selection = BuildingSelection("base", "selected-one", type)
        val id = FeatureId(feature)
        val requests = HomeRequests()
        var fact: GateFact = GateFact.Unknown
        var buildings = mapOf(type to BuildingGateState(1, true))
        val blocked = MutableStateFlow(false)
        var mounted = true; var refusal: String? = null
        var prepared = HomeNavigationResult.DEFERRED
        var legacy = 0; var navigations = 0; val reasons = mutableListOf<String>()
        private val host = object : HomeRouteHost {
            override val dispatchBlocked = blocked
            override fun canOpen(id: FeatureId, tab: HomeTab) = mounted
            override fun refusalReason(id: FeatureId) = refusal
            override fun prepareFeature(id: FeatureId) = prepared
            override fun openLegacyFeature(id: FeatureId): Boolean { legacy++; return true }
            override fun navigate(destination: Destination, tab: HomeTab): Boolean { navigations++; return true }
            override fun action(action: FeatureAction) = false
            override fun scene(scene: FeatureScene) = false
            override fun worldHandoff(island: String, then: Destination?) = false
            override fun homeHandoff(destination: Destination.FocusBuilding) = false
            override fun locked(reason: String) { reasons += reason }
        }
        private val canonical = requireNotNull(FeatureRegistry.canonical()[id])
        val dispatcher = HomeRouteDispatcher(requests,
            FeatureRegistry.of(listOf(canonical.copy(gate = Gate.AllOf(listOf(canonical.gate, extraGate))))), {
                current?.let { HomeRouteContext(it, GateContext(baseId = contextBase, buildings = buildings,
                    serverFeatures = mapOf("phaseE.harvesters" to fact), selection = FeatureSelection(building = selection))) }
            }, host)
        fun tap() = dispatcher.openBuildingDoor(id, selection)
    }
}
