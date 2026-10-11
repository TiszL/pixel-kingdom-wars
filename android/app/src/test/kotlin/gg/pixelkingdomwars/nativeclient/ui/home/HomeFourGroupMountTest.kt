package gg.pixelkingdomwars.nativeclient.ui.home

import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import gg.pixelkingdomwars.nativeclient.ui.features.*
import gg.pixelkingdomwars.nativeclient.ui.model.SheetSize
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetStack
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LodgeLocalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageLiveInputs
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyagePolicyFacts
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** b0b6b39c: authored BEFORE production changes; Cedar3 alone executes. Each case names the ownership risk. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class HomeFourGroupMountTest {
    // WHY: a second tap during this exact intent's read must not leave its pending new sheet for legacy.
    @Test fun `matching pending Harvester intent explains once without legacy or duplicate capture`() = runTest {
        val f = WarmDoorFixture(); f.warm { true }; f.dispatcher.openBuildingDoor(f.id, f.selection)
        val request = f.requests.pending.value as HomeRequest.Open
        val finish = kotlinx.coroutines.CompletableDeferred<Unit>()
        val read = launch { f.proof.refreshFor(request, { finish.await(); true }, { true }) }
        runCurrent(); assertEquals(GateFact.Unknown, f.fact())
        f.dispatcher.openBuildingDoor(f.id, f.selection)
        assertSame(request, f.requests.pending.value); assertEquals(0, f.legacyCalls)
        assertEquals(listOf("Opening Harvester. Please wait."), f.reasons)
        finish.complete(Unit); read.join()
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request)); assertNull(f.requests.pending.value)
    }

    // 38398eb4: unrelated/retired heads keep FIFO order while the current unknown Harvester captures its own read.
    @Test fun `pending door coalescing requires both the same feature and current identity before queuing a new read`() {
        for (mismatch in listOf("feature", "base", "generation", "session")) {
            val f = WarmDoorFixture()
            val oldIdentity = when (mismatch) {
                "base" -> f.identity.copy(baseId = "other")
                "generation" -> f.identity.copy(baseSelectionGeneration = 8)
                "session" -> f.identity.copy(session = Any())
                else -> f.identity
            }
            val old = HomeRequest.Open(if (mismatch == "feature") FeatureId("berth.fleet") else f.id, oldIdentity, FeatureSelection())
            f.requests.request(old); f.dispatcher.openBuildingDoor(f.id, f.selection)
            assertEquals(0, f.legacyCalls); assertTrue(f.reasons.isEmpty()); assertSame(old, f.requests.pending.value)
            f.requests.consume(old)
            val next = f.requests.pending.value as HomeRequest.Open
            assertNotSame(old, next); assertEquals(f.id, next.featureId); assertEquals(f.identity, next.identity)
            assertEquals(f.selection, next.selection.building)
        }
    }

    // WHY: a lifecycle-cancelled warm chain may finish on the next resume, but completion still ends the allowance.
    @Test fun `cancelled warm read may be reclaimed until one chain completes`() = runTest {
        val f = WarmDoorFixture(); val wait = kotlinx.coroutines.CompletableDeferred<Unit>()
        val first = launch { f.warm { wait.await(); true } }; runCurrent()
        assertEquals(1, f.warmCalls); assertEquals(HomeFeatureReadStatus.READING, f.proof.status)
        first.cancel(); first.join(); assertEquals(HomeFeatureReadStatus.WAITING, f.proof.status)
        f.warm { true }; assertEquals(2, f.warmCalls); assertEquals(HomeFeatureReadStatus.READY, f.proof.status)
        f.warm { true }; assertEquals(2, f.warmCalls)
    }

    // WHY: cancellation does not turn an explicit request's proof into an unowned warm allowance.
    @Test fun `cancelled request bound preparation still excludes a warm claim`() = runTest {
        val f = WarmDoorFixture(); val request = HomeRequest.Open(f.id, f.identity, FeatureSelection())
        val wait = kotlinx.coroutines.CompletableDeferred<Unit>()
        val read = launch { f.proof.refreshFor(request, { wait.await(); true }, { true }) }; runCurrent()
        read.cancel(); read.join(); assertEquals(HomeFeatureReadStatus.WAITING, f.proof.statusFor(request))
        f.warm { true }; assertEquals(0, f.warmCalls)
        f.proof.refreshFor(request, { true }, { true })
        assertEquals(HomeFeatureReadStatus.READY, f.proof.statusFor(request)); assertEquals(0, f.warmCalls)
    }

    // WHY: the canonical Harvester door needs a current GET before a cold Home can capture its first intent.
    @Test fun `one cold Home warm read changes the canonical Harvester door from unknown to typed`() = runTest {
        val f = WarmDoorFixture()
        assertEquals(GateFact.Unknown, f.fact())
        f.warm { true }
        assertEquals(GateFact.Allowed, f.fact())
        f.dispatcher.openBuildingDoor(f.id, f.selection)
        assertEquals(f.id, (f.requests.pending.value as HomeRequest.Open).featureId)
        assertEquals(0, f.legacyCalls); assertEquals(1, f.warmCalls); assertTrue(f.reasons.isEmpty())
    }

    // WHY: a queued or running explicit request owns its status; a warm read must not claim or overwrite it.
    @Test fun `pending request bound Harvester preparation excludes the warm read before and during GET`() = runTest {
        val f = WarmDoorFixture(); val request = HomeRequest.Open(f.id, f.identity, FeatureSelection())
        f.requests.request(request); f.warm { true }
        assertEquals(0, f.warmCalls); assertEquals(HomeFeatureReadStatus.WAITING, f.proof.statusFor(request))
        val finish = kotlinx.coroutines.CompletableDeferred<Unit>()
        val job = launch { f.proof.refreshFor(request, { finish.await(); true }, { true }) }
        runCurrent(); assertEquals(HomeFeatureReadStatus.READING, f.proof.statusFor(request))
        f.warm { false }; assertEquals(0, f.warmCalls)
        assertEquals(HomeFeatureReadStatus.READING, f.proof.statusFor(request))
        finish.complete(Unit); job.join(); f.requests.consume(request); f.warm { false }
        assertEquals(0, f.warmCalls); assertEquals(HomeFeatureReadStatus.READY, f.proof.statusFor(request))
    }

    // WHY: resume or a repository emission cannot turn the optional GET into polling; a new presentation may warm.
    @Test fun `warm read can be claimed once per Home presentation`() = runTest {
        val first = WarmDoorFixture(); repeat(3) { first.warm { true } }
        assertEquals(1, first.warmCalls)
        val next = WarmDoorFixture(); next.warm { true }; assertEquals(1, next.warmCalls)
    }

    // 38398eb4: failure stays unknown; the explicit read owns retry instead of navigating to legacy controls.
    @Test fun `failed warm read queues one explicit preparation which excludes warming and can recover`() = runTest {
        val f = WarmDoorFixture(); f.warm { error("offline") }
        assertEquals(GateFact.Unknown, f.fact())
        f.dispatcher.openBuildingDoor(f.id, f.selection)
        val request = f.requests.pending.value as HomeRequest.Open
        assertEquals(f.id, request.featureId); assertEquals(f.identity, request.identity)
        assertEquals(0, f.legacyCalls); assertTrue(f.reasons.isEmpty())
        f.warm { true }; assertEquals(1, f.warmCalls)
        assertSame(request, f.requests.pending.value)
        f.proof.refreshFor(request, { true }, { true })
        assertEquals(HomeFeatureReadStatus.READY, f.proof.statusFor(request))
        assertNull(homeHarvesterLegacyNotice(f.proof.status))
    }

    // WHY: a request arriving after the warm GET began takes precedence over its late failure.
    @Test fun `late warm read cannot overwrite a newer request bound result`() = runTest {
        val f = WarmDoorFixture(); val finish = kotlinx.coroutines.CompletableDeferred<Unit>()
        val warm = launch { f.warm { finish.await(); false } }; runCurrent()
        val request = HomeRequest.Open(f.id, f.identity, FeatureSelection())
        f.proof.refreshFor(request, { true }, { true }); finish.complete(Unit); warm.join()
        assertEquals(HomeFeatureReadStatus.READY, f.proof.statusFor(request))
        assertEquals(GateFact.Allowed, f.fact())
    }

    // WHY: an old presentation's successful read is never proof for a replacement identity.
    @Test fun `warm read completion after identity replacement stays unknown`() = runTest {
        val f = WarmDoorFixture(); f.warm { f.current = f.identity.copy(baseSelectionGeneration = 9); true }
        assertEquals(HomeFeatureReadStatus.WAITING, f.proof.status); assertEquals(GateFact.Unknown, f.fact())
        // A completed but stale chain spent this presentation's allowance, independently of the WAITING status guard.
        f.current = f.identity; f.warm { true }
        assertEquals(1, f.warmCalls); assertEquals(GateFact.Unknown, f.fact())
    }

    // WHY: only a current, completed building warrants the optional GET; loading and malformed rows do not.
    @Test fun `Home warm read eligibility requires a current completed Harvester`() {
        val f = EconomyDoorFixture(); val ready = f.base
        assertTrue(homeHasCompletedHarvester(ready, f.identity))
        assertFalse(homeHasCompletedHarvester(ready.copy(loading = true), f.identity))
        assertFalse(homeHasCompletedHarvester(ready.copy(error = "offline"), f.identity))
        assertFalse(homeHasCompletedHarvester(ready, f.identity.copy(baseId = "other")))
        for (rows in listOf(emptyList(), listOf(gg.pixelkingdomwars.nativeclient.model.Building("h", "harvester", 0, 0, 0)),
            listOf(gg.pixelkingdomwars.nativeclient.model.Building("h", "harvester", 1, 0, 0, underConstruction = true)),
            listOf(gg.pixelkingdomwars.nativeclient.model.Building("", "harvester", 1, 0, 0)))) {
            assertFalse(homeHasCompletedHarvester(ready.copy(base = ready.base!!.copy(buildings = rows)), f.identity))
        }
    }

    // WHY: these source pins connect the behavior tests to both actual request sites and the once-only RESUMED read.
    @Test fun `PkwApp wires current request preparation and admitted one shot Home warm read`() {
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        assertTrue(source.contains("homeFeatureReadResult(proof, graph.homeRequests.pending.value as? HomeRequest.Open"))
        assertTrue(source.contains("proof.refreshFor(request, read ="))
        val warm = source.substringAfter("// One optional Harvester GET per Home presentation.")
            .substringBefore("// A request-specific GET supplies")
        assertTrue(warm.contains("LaunchedEffect(harvesterRead, ownerProjections, lifecycle)"))
        assertTrue(warm.contains("repeatOnLifecycle(Lifecycle.State.RESUMED)"))
        assertTrue(warm.contains("awaitHomeReadAdmission(signals)"))
        assertTrue(warm.contains("homeHasCompletedHarvester(session.base.state.value, proof.identity)"))
        assertTrue(warm.contains("proof.claimWarmRead(requestPending ="))
        assertTrue(warm.contains("pending?.featureId?.value == \"harvester.harvest\""))
        assertTrue(warm.contains("proof.refresh(read = { ownerProjections.harvester?.refresh?.invoke(Unit) == true })"))
        assertTrue(warm.contains("currentRouteIdentity.value() == proof.identity"))
        assertFalse(warm.contains("refreshFor(")); assertFalse(warm.contains("while ("))
        assertTrue(source.contains("homeHarvesterLegacyNotice(harvesterRead?.status)"))
    }

    // WHY: exercise the production Economy host, including its pending exclusion and return-Home side effect.
    @Test fun `production Economy host falls back or enqueues once and rejects a stale second tap`() {
        val f = EconomyDoorFixture(); val id = FeatureId("harvester.harvest")
        f.advertised = false; assertTrue(f.dispatcher.handleFeatureDoor(id))
        assertEquals(listOf(id), f.legacy); assertEquals(0, f.homeReturns); assertNull(f.requests.pending.value)
        f.advertised = true; assertTrue(f.dispatcher.handleFeatureDoor(id))
        val request = f.requests.pending.value as HomeRequest.Open
        assertEquals(1, f.homeReturns); assertEquals(HomeRequestEntry.ECONOMY, request.entry)
        assertFalse(f.dispatcher.handleFeatureDoor(id)); assertSame(request, f.requests.pending.value)
        assertEquals(1, f.homeReturns); f.requests.consume(request); assertNull(f.requests.pending.value)
        assertEquals(listOf("This Economy screen is no longer current. Open Economy again."), f.reasons)
        assertFalse(f.host.dispatchBlocked.value)
        assertFalse(f.host.canOpen(id, HomeTab.WORLD)); assertFalse(f.host.canOpen(FeatureId("hud.mail"), HomeTab.KINGDOM))
    }

    // WHY: the pending guard must hold even in a modelled pre-navigation interval; production changes the route synchronously.
    @Test fun `pending Economy intent prevents a duplicate even before the route leaves`() {
        val f = EconomyDoorFixture(); val id = FeatureId("harvester.harvest")
        assertTrue(f.dispatcher.handleFeatureDoor(id)); val first = f.requests.pending.value as HomeRequest.Open
        f.routeCurrent = true // Model the interval before the navigation change is observed.
        assertTrue(f.dispatcher.handleFeatureDoor(id))
        assertSame(first, f.requests.pending.value); assertEquals(1, f.homeReturns); assertTrue(f.legacy.isEmpty())
        assertEquals(listOf("Opening Harvester. Please wait."), f.reasons)
        f.requests.consume(first); assertNull(f.requests.pending.value)
    }

    // WHY: busy/review/march restrictions belong to new capture, not to navigation into saved-receipt recovery.
    @Test fun `all three Economy recovery doors remain reachable when capture cannot leave`() {
        for (id in economyIds) {
            val f = EconomyDoorFixture(); f.canLeave = false
            assertTrue(f.dispatcher.handleFeatureDoor(id)); assertEquals(listOf(id), f.legacy)
            assertNull(f.requests.pending.value); assertEquals(0, f.homeReturns); assertTrue(f.reasons.isEmpty())
        }
    }

    // WHY: canonical building gates and base currentness choose legacy, without synthetic admission facts.
    @Test fun `all three Economy doors fall back for absent incomplete loading error and mismatched bases`() {
        for (id in economyIds) {
            val control = EconomyDoorFixture(); assertTrue(control.dispatcher.handleFeatureDoor(id))
            assertNotNull(control.requests.pending.value); assertTrue(control.legacy.isEmpty())
            val ready = control.base
            val cases = listOf(ready.copy(base = ready.base!!.copy(buildings = emptyList())),
                ready.copy(base = ready.base!!.copy(buildings = ready.base!!.buildings.map { it.copy(underConstruction = true) })),
                ready.copy(loading = true), ready.copy(error = "offline"), ready.copy(base = ready.base!!.copy(baseId = "other")))
            for (state in cases) {
                val f = EconomyDoorFixture(); f.base = state
                assertTrue(f.dispatcher.handleFeatureDoor(id)); assertEquals(listOf(id), f.legacy)
                assertNull(f.requests.pending.value); assertEquals(0, f.homeReturns); assertTrue(f.reasons.isEmpty())
            }
        }
    }

    // WHY: a helper-only test would miss a restored full guard or a silent fleet-pane refusal at the real call site.
    @Test fun `Economy actual legacy wiring checks only current route and opens concrete recovery screens`() {
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        val economy = source.substringAfter("composable<EconomyRoute>").substringBefore("composable<ReferralsRoute>")
        val current = economy.substringAfter("val economyRouteCurrent =").substringBefore("val economyCanLeave =")
        assertTrue(current.contains("graph.sessionGraph.value === s")); assertTrue(current.contains("graph.holder.current === s.session"))
        assertTrue(current.contains("graph.account.state.value.session === s.session"))
        assertTrue(current.contains("navController.currentBackStackEntry === economyEntry"))
        assertFalse(current.contains("busy")); assertFalse(current.contains("activationAllowed"))
        assertTrue(economy.contains("admitted = { economyCanLeave() && graph.homeRequests.pending.value == null && observed(it) }"))
        val legacy = economy.substringAfter("legacy = { id ->").substringBefore("}, returnHome =")
        assertTrue(legacy.contains("if (!economyRouteCurrent()) false")); assertFalse(legacy.contains("economyCanLeave"))
        assertTrue(legacy.contains("navigate(HarvesterRoute)")); assertTrue(legacy.contains("navigate(StarterFleetRoute)"))
        assertTrue(legacy.contains("navigate(StarterExpeditionRoute)")); assertFalse(legacy.contains("owner.open()"))
    }

    private val economyIds = listOf("harvester.harvest", "berth.fleet", "lodge.expedition").map(::FeatureId)
    private class EconomyDoorFixture {
        val identity = HomeRouteIdentity(Any(), "base", 1); val requests = HomeRequests()
        var canLeave = true; var routeCurrent = true; var advertised = true; var homeReturns = 0
        val legacy = mutableListOf<FeatureId>(); val reasons = mutableListOf<String>()
        // Synthetic protocol rows, not copied game rules.
        var base = gg.pixelkingdomwars.nativeclient.data.BaseState(base = gg.pixelkingdomwars.nativeclient.model.BaseSnapshot(
            baseId = "base", visualContext = null, player = gg.pixelkingdomwars.nativeclient.model.PlayerSummary(keepLevel = 1),
            energy = null, armyStatus = null, claim = null,
            buildings = listOf("harvester", "berth", "lodge").map { gg.pixelkingdomwars.nativeclient.model.Building(it, it, 1, 0, 0) },
            obstacles = emptyList(), jobs = emptyList(), freeBuilders = 0, raw = kotlinx.serialization.json.JsonObject(emptyMap())))
        val host = HomeEconomyRouteHost({ canLeave && routeCurrent && requests.pending.value == null && advertised },
            { if (!routeCurrent) false else { legacy += it; true } }, { homeReturns++; routeCurrent = false }, { reasons += it })
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), {
            if (!canLeave || !routeCurrent) null else homeEconomyRouteContext(identity, base,
                mapOf("phaseE.harvesters" to if (advertised) GateFact.Allowed else GateFact.Unknown))
        }, host, HomeRequestEntry.ECONOMY)
    }

    private class WarmDoorFixture {
        val identity = HomeRouteIdentity(Any(), "base", 1); var current: HomeRouteIdentity? = identity
        val proof = HomeFeatureReadCapture(identity); val requests = HomeRequests(); val id = FeatureId("harvester.harvest")
        val selection = BuildingSelection("base", "selected", "harvester")
        var warmCalls = 0; var legacyCalls = 0; val reasons = mutableListOf<String>()
        fun fact() = homeObservedFeatureFact(proof.status == HomeFeatureReadStatus.READY, current == identity, true)
        val host = HomeSheetRouteHost({ current }, { false }, { reasons += it }, legacyFeature = {
            legacyCalls++; homeHarvesterLegacyNotice(proof.status)?.let { reasons += it }; true
        })
        val mount = host.attach(identity, {}, { false }, openBody = {}).also { it.reportBlocked(false) }
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), { HomeRouteContext(identity,
            GateContext(baseId = identity.baseId, buildings = mapOf("harvester" to BuildingGateState(1, true)),
                serverFeatures = mapOf("phaseE.harvesters" to fact()), selection = FeatureSelection(building = selection))) }, host)
        suspend fun warm(read: suspend () -> Boolean) {
            val pending = requests.pending.value as? HomeRequest.Open
            if (proof.claimWarmRead(pending?.featureId == id)) proof.refresh({ warmCalls++; read() }, { current == identity })
        }
    }

    // 38398eb4: unknown now captures a read; known denial and blocked admission retain the existing fallback guards.
    @Test fun `building door queues unknown facts but falls back for flag off and blocked admission`() {
        val f = DoorFixture()
        f.fact = GateFact.Unknown; f.dispatcher.openBuildingDoor(f.id, f.selection)
        val unknown = f.requests.pending.value as HomeRequest.Open
        assertEquals(f.id, unknown.featureId); assertEquals(0, f.legacyCalls)
        f.requests.consume(unknown)
        f.fact = GateFact.Denied("off"); f.dispatcher.openBuildingDoor(f.id, f.selection)
        assertTrue(f.reasons.isEmpty()); assertEquals(1, f.legacyCalls); assertNull(f.requests.pending.value)
        f.fact = GateFact.Allowed; f.mount.reportBlocked(true); f.dispatcher.openBuildingDoor(f.id, f.selection)
        assertEquals(2, f.legacyCalls); assertNull(f.requests.pending.value)
        assertEquals(listOf("These controls are not available yet. Finish the current review or loading step, then try again."), f.reasons)
        f.mount.reportBlocked(false); f.dispatcher.openBuildingDoor(f.id, f.selection)
        assertEquals(2, f.legacyCalls); assertNotNull(f.requests.pending.value)
    }

    @Test fun `building projection reads current context and returns null after replacement`() {
        val f = DoorFixture()
        assertNotNull(f.dispatcher.buildingCommandBar(gg.pixelkingdomwars.nativeclient.model.Building("selected", "harvester", 1, 0, 0)))
        f.current = null
        assertNull(f.dispatcher.buildingCommandBar(gg.pixelkingdomwars.nativeclient.model.Building("selected", "harvester", 1, 0, 0)))
    }

    @Test fun `stale building instance cannot open either a new sheet or legacy screen`() {
        val f = DoorFixture(); f.dispatcher.openBuildingDoor(f.id, f.selection.copy(buildingId = "replaced"))
        assertNull(f.requests.pending.value); assertEquals(0, f.legacyCalls); assertEquals(1, f.reasons.size)
    }

    @Test fun `missing legacy route explains one refusal without a toast loop or queued work`() {
        val f = DoorFixture(); f.fact = GateFact.Denied("off"); f.legacyAvailable = false
        f.dispatcher.openBuildingDoor(f.id, f.selection)
        assertEquals(1, f.legacyCalls); assertEquals(1, f.reasons.size); assertNull(f.requests.pending.value)
    }

    // 71fb65a4: DoorFixture uses HomeSheetRouteHost to pin dispatcher mechanics, not production Economy eligibility.
    // The production Economy fallback remains covered by its dedicated host test above.
    @Test fun `dispatcher captures an unknown Harvester fact with aggregate entry metadata`() {
        val f = DoorFixture(entry = HomeRequestEntry.ECONOMY)
        assertTrue(f.dispatcher.handleFeatureDoor(f.id)); assertEquals(1, f.homeReturns)
        val request = f.requests.pending.value as HomeRequest.Open
        assertEquals(HomeRequestEntry.ECONOMY, request.entry); assertEquals(0, f.legacyCalls)
        f.requests.consume(request); f.fact = GateFact.Unknown
        // 71fb65a4: an aggregate intent keeps its metadata when this fixture admits unknown-fact capture.
        assertTrue(f.dispatcher.handleFeatureDoor(f.id)); assertEquals(0, f.legacyCalls); assertEquals(2, f.homeReturns)
        val unknown = f.requests.pending.value as HomeRequest.Open
        assertNotSame(request, unknown); assertEquals(HomeRequestEntry.ECONOMY, unknown.entry)
        assertEquals(f.id, unknown.featureId); assertEquals(f.identity, unknown.identity)
    }

    @Test fun `Economy aggregate entry survives a different selected instance but never a different generation`() {
        val f = DoorFixture(entry = HomeRequestEntry.ECONOMY); assertTrue(f.dispatcher.handleFeatureDoor(f.id))
        val request = f.requests.pending.value as HomeRequest.Open
        f.selection = f.selection.copy(buildingId = "other-current-selection")
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertTrue(f.dispatcher.handleFeatureDoor(f.id)); val stale = f.requests.pending.value as HomeRequest.Open
        f.current = f.identity.copy(baseSelectionGeneration = 9)
        assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(stale))
    }

    @Test fun `Economy entry is bounded to its three read-only aggregate feature intents`() {
        val f = DoorFixture(entry = HomeRequestEntry.ECONOMY)
        assertThrows(IllegalArgumentException::class.java) {
            HomeRequest.Open(FeatureId("hud.mail"), f.identity, FeatureSelection(), entry = HomeRequestEntry.ECONOMY)
        }
    }

    @Test fun `Economy read witness invalidates on failure equal replacement and owner change`() = runTest {
        val identity = HomeRouteIdentity(Any(), "base", 1); val proof = HomeEconomyReadCapture<String>(identity)
        val value = String(charArrayOf('x')); var current = true
        proof.refresh({ current }) { value }; assertTrue(proof.observed(value, true))
        assertFalse(proof.observed(String(charArrayOf('x')), true)); assertFalse(proof.observed(value, false))
        try { proof.refresh({ current }) { error("offline") }; fail("must fail") } catch (_: IllegalStateException) { }
        assertFalse(proof.observed(value, true)); current = false
        proof.refresh({ current }) { value }; assertFalse(proof.observed(value, true))
    }

    private class DoorFixture(entry: HomeRequestEntry = HomeRequestEntry.HOME) {
        val identity = HomeRouteIdentity(Any(), "base", 1)
        var current: HomeRouteIdentity? = identity
        var selection = BuildingSelection("base", "selected", "harvester")
        val id = FeatureId("harvester.harvest"); val requests = HomeRequests()
        var fact: GateFact = GateFact.Allowed; var legacyAvailable = true; var legacyCalls = 0; var homeReturns = 0
        val reasons = mutableListOf<String>()
        // WHY: the production Home legacy branch refuses the same active review/admission that blocks its typed host.
        private fun legacyOpen(id: FeatureId): Boolean { legacyCalls++; return legacyAvailable && !host.dispatchBlocked.value }
        val host = HomeSheetRouteHost({ current }, { false }, { reasons += it },
            legacyFeature = ::legacyOpen, enqueued = { homeReturns++ })
        val mount = host.attach(identity, {}, { false }, openBody = {}).also { it.reportBlocked(false) }
        val registry = FeatureRegistry.of(listOf(Feature(id, "HARVEST", HostKind.BUILDING, "harvester", FeatureSurface.COMMAND,
            Gate.ServerFeature("phaseE.harvesters"), FeatureIcon(FeatureIconState.SHAPE_CONTRACT, "shape:arrow"),
            FeatureTarget.Sheet(Destination.Harvester()), 0, Visibility.ALWAYS)))
        val dispatcher = HomeRouteDispatcher(requests, registry, { current?.let { HomeRouteContext(it,
            GateContext(baseId = it.baseId, serverFeatures = mapOf("phaseE.harvesters" to fact),
                selection = FeatureSelection(building = selection))) } }, host, entry)
    }

    // e6ee7a34: production-wiring seams, authored before the v2 implementation; execution remains with Cedar3.
    @Test fun `a second door tap after failed preparation runs another GET through dispatcher wiring`() = runTest {
        val identity = HomeRouteIdentity(Any(), "base", 1); val requests = HomeRequests()
        val proof = HomeFeatureReadCapture(identity); var gets = 0; var opened = 0
        val host = HomeSheetRouteHost({ identity }, { false }, {}, featureRead = {
            homeFeatureReadResult(proof, requests.pending.value as? HomeRequest.Open, ownerBusy = false)
        })
        host.attach(identity, {}, { false }, openBody = { opened++ }).reportBlocked(false)
        val registry = FeatureRegistry.of(listOf(Feature(FeatureId("harvester.harvest"), "HARVEST", HostKind.HUD,
            "fixture", FeatureSurface.HUD_SLOT, Gate.Open, FeatureIcon(FeatureIconState.SHAPE_CONTRACT, "shape:arrow"),
            FeatureTarget.Sheet(Destination.Harvester()), 0, Visibility.ALWAYS)))
        val dispatcher = HomeRouteDispatcher(requests, registry, { HomeRouteContext(identity, GateContext(baseId = identity.baseId)) }, host)
        assertTrue(dispatcher.openFeature(FeatureId("harvester.harvest")))
        val first = requests.pending.value as HomeRequest.Open
        assertEquals(HomeRouteDispatchResult.DEFERRED, dispatcher.consume(first))
        proof.refreshFor(first, { gets++; error("offline") }, { requests.pending.value === first })
        assertEquals(HomeRouteDispatchResult.LOCKED, dispatcher.consume(first)); assertNull(requests.pending.value)
        assertTrue(dispatcher.openFeature(FeatureId("harvester.harvest")))
        val second = requests.pending.value as HomeRequest.Open; assertNotSame(first, second)
        // Dispatch deliberately wins the composition race before the new read effect starts.
        assertEquals(HomeRouteDispatchResult.DEFERRED, dispatcher.consume(second))
        proof.refreshFor(second, { gets++; true }, { requests.pending.value === second })
        assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(second))
        assertEquals(2, gets); assertEquals(1, opened); assertNull(requests.pending.value)
    }

    @Test fun `read proof is bound to the exact request even when its data fields are equal`() = runTest {
        val identity = HomeRouteIdentity(Any(), "base", 1); val proof = HomeFeatureReadCapture(identity)
        val first = HomeRequest.Open(FeatureId("harvester.harvest"), identity, FeatureSelection())
        proof.refreshFor(first, { false }, { true })
        assertEquals(HomeFeatureReadStatus.FAILED, proof.statusFor(first))
        assertEquals(HomeFeatureReadStatus.WAITING, proof.statusFor(first.copy()))
        assertEquals(HomeNavigationResult.DEFERRED, homeFeatureReadResult(proof, first.copy(), false))
    }

    @Test fun `a StateFlow admission change wakes the actual preflight wait without snapshot state`() = runTest {
        val blocked = MutableStateFlow(true); var reads = 0
        val work = launch { awaitHomeReadAdmission(listOf(blocked)) { !blocked.value }; reads++ }
        runCurrent(); assertEquals(0, reads)
        blocked.value = false; runCurrent(); assertEquals(1, reads); work.join()
    }

    @Test fun `read preparation remains deferred while its observed owner is busy`() = runTest {
        val identity = HomeRouteIdentity(Any(), "base", 1); val proof = HomeFeatureReadCapture(identity)
        val request = HomeRequest.Open(FeatureId("berth.starter"), identity, FeatureSelection())
        proof.refreshFor(request, { true }, { true })
        assertEquals(HomeNavigationResult.DEFERRED, homeFeatureReadResult(proof, request, true))
        assertEquals(HomeNavigationResult.DISPATCHED, homeFeatureReadResult(proof, request, false))
    }

    @Test fun `mounted voyage links open their supported body without unobserved registry facts`() {
        val f = Fixture(); f.mount().reportBlocked(false)
        val expected = listOf("berth.starter" to Destination.Berth(section = "starter"),
            "berth.fleet" to Destination.Berth(), "berth.service" to Destination.Berth("SERVICE"),
            "berth.vehicles" to Destination.Berth(section = "vehicles"),
            "lodge.starter" to Destination.Lodge(mode = "starter"), "lodge.expedition" to Destination.Lodge())
        for ((id, destination) in expected) { assertTrue(f.host.openMountedLink(f.lease, id)); assertEquals(destination, f.opened.last()) }
        assertFalse(f.host.openMountedLink(f.lease, "lodge.passport")); assertTrue(f.reasons.isNotEmpty())
    }

    @Test fun `blocked mounted links and legacy handoffs explain their refusal and touch no navigation`() {
        val f = Fixture(); f.mount().reportBlocked(false); f.ownerReview = true
        assertFalse(f.host.openMountedLink(f.lease, "berth.service"))
        var touched = 0
        assertFalse(f.host.handoffOwnedSheet(f.lease, { touched++ }, { touched++ }, { touched++ }))
        assertEquals(0, touched); assertTrue(f.opened.isEmpty()); assertEquals(2, f.reasons.size)
        assertTrue(f.reasons.all { it.contains("review") })
    }

    @Test fun `Back refused by the body review gate explains why without clearing its owner`() {
        val f = Fixture(); f.mount().reportBlocked(false); f.ownerReview = true
        var touched = 0
        assertFalse(f.host.closeOwnedSheet(f.lease, { touched++ }) { touched++ })
        assertEquals(0, touched); assertEquals(1, f.reasons.size); assertTrue(f.reasons.single().contains("review"))
    }

    @Test fun `read refusal copy distinguishes active review from currentness and generic admission`() {
        assertTrue(homeReadRefusalReason(reviewBlocked = true, currentOwner = true).contains("review"))
        assertFalse(homeReadRefusalReason(reviewBlocked = false, currentOwner = false).contains("review"))
        assertFalse(homeReadRefusalReason(reviewBlocked = false, currentOwner = true).contains("review"))
    }

    private class Fixture {
        val identity = HomeRouteIdentity(Any(), "base", 1)
        var current: HomeRouteIdentity? = identity
        var presentation: HomeRouteIdentity? = identity
        var blocked = false
        var ownerReady = true
        var ownerReview = false
        var unavailable: String? = null
        var preparation = HomeNavigationResult.DISPATCHED
        var covered = true
        val opened = mutableListOf<Destination>()
        val reasons = mutableListOf<String>()
        var sceneCloses = 0
        val lease = Any()
        val host = HomeSheetRouteHost({ current }, { blocked }, { reasons += it },
            presentationCurrent = { presentation }, bodyReady = { ownerReady }, bodyReviewBlocked = { ownerReview },
            featureRead = { preparation }, bodyUnavailable = { unavailable })
        fun mount() = host.attach(identity, { opened += it }, { sceneCloses++; true }, lease, { covered },
            openBody = { opened += it })
        fun dispatcher(id: String, destination: Destination, requests: HomeRequests) = HomeRouteDispatcher(requests,
            FeatureRegistry.of(listOf(Feature(FeatureId(id), "OPEN", HostKind.HUD, "fixture", FeatureSurface.HUD_SLOT,
                Gate.Open, FeatureIcon(FeatureIconState.SHAPE_CONTRACT, "shape:arrow"), FeatureTarget.Sheet(destination), 0, Visibility.ALWAYS))),
            { current?.let { HomeRouteContext(it, GateContext(baseId = it.baseId)) } }, host)
    }

    // WHY: a read refused after admission was checked must terminate so a fresh tap can retry.
    @Test fun `current owner refusing a preflight read publishes retryable failure instead of waiting forever`() = runTest {
        val capture = HomeFeatureReadCapture(HomeRouteIdentity(Any(), "base", 1))
        capture.refresh({ false }, { true })
        assertEquals(HomeFeatureReadStatus.FAILED, capture.status)
        capture.refresh({ true }, { true })
        assertEquals(HomeFeatureReadStatus.READY, capture.status)
    }

    // WHY: a starter destination must not silently select a crafted vehicle when both are installed.
    @Test fun `starter address retains its mode route and actual installation without inventing an id`() {
        val destination = Destination.Lodge(mode = "starter", routeId = "coastal_survey")
        val seeded = homeLodgeLocal(destination, "starter-installation")
        assertEquals("starter-installation", seeded.installationId)
        assertEquals("coastal_survey", seeded.starterRouteId); assertNull(seeded.routeId)
        assertNull(homeLodgeLocal(destination, null).installationId)
        assertEquals("island", homeLodgeLocal(Destination.Lodge(routeId = "island"), "starter-installation").routeId)
        assertNull(homeLodgeLocal(Destination.Lodge(routeId = "island"), "starter-installation").installationId)
    }

    // WHY: Back dismisses the mounted nested state before retiring a sheet history entry.
    @Test fun `nested back collapses Lodge picker and Berth subpanel before allowing pop`() {
        val lodge = LodgeLocalState(pickerOpen = true, routeId = "kept")
        val dismissed = homeLodgeBack(lodge)!!
        assertFalse(dismissed.pickerOpen); assertEquals("kept", dismissed.routeId)
        assertNull(homeLodgeBack(dismissed))
        val berth = gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.BerthLocalState(section = "install", installAssetId = "picked")
        val fleet = homeBerthBack(berth)!!
        assertNull(fleet.section); assertNull(fleet.installAssetId); assertNull(homeBerthBack(fleet))
    }

    // WHY: disposal of an old body must not detach its replacement's Back handler.
    @Test fun `nested back registration retires only its own matching lease`() {
        val back = HomeBodyBack(); val old = Any(); val replacement = Any(); var calls = 0
        back.attach(old) { fail("old body must never be called"); false }
        back.attach(replacement) { calls++; true }
        back.detach(old); assertTrue(back.consume()); assertEquals(1, calls)
        back.detach(replacement); assertFalse(back.consume())
    }

    // WHY: an existing command form must open only after the matching sheet is retired, even with a nested panel.
    @Test fun `legacy handoff retires the matching sheet before opening its existing controls`() {
        val f = Fixture(); f.mount().reportBlocked(false); val calls = mutableListOf<String>()
        assertTrue(f.host.handoffOwnedSheet(f.lease, { calls += "clear" }, { calls += "pop" }, { calls += "open" }))
        assertEquals(listOf("pop", "clear", "open"), calls)
    }

    // WHY: a new review or retired lease cannot open a command form while its protected sheet remains visible.
    @Test fun `legacy handoff refuses without pop or navigation for review and retired leases`() {
        val f = Fixture(); f.mount().reportBlocked(false); var calls = 0
        f.ownerReview = true
        assertFalse(f.host.handoffOwnedSheet(f.lease, { calls++ }, { calls++ }, { calls++ }))
        f.ownerReview = false
        assertFalse(f.host.handoffOwnedSheet(Any(), { calls++ }, { calls++ }, { calls++ }))
        f.blocked = true
        assertFalse(f.host.handoffOwnedSheet(f.lease, { calls++ }, { calls++ }, { calls++ }))
        assertEquals(0, calls)
    }

    // WHY: cancellation or completion of a superseded GET must not erase the newer request's admission proof.
    @Test fun `older feature read cannot overwrite a newer completed attempt`() = runTest {
        val capture = HomeFeatureReadCapture(HomeRouteIdentity(Any(), "base", 1))
        val original = kotlinx.coroutines.CompletableDeferred<Boolean>()
        val old = launch { capture.refresh({ original.await() }, { true }) }
        runCurrent(); assertEquals(HomeFeatureReadStatus.READING, capture.status)
        capture.refresh({ true }, { true }); assertEquals(HomeFeatureReadStatus.READY, capture.status)
        original.complete(false); old.join()
        assertEquals(HomeFeatureReadStatus.READY, capture.status)
    }

    // WHY: the existing account owner now mounts the designed Passport body on Home (7d4f6a35).
    @Test fun `passport door captures the exact designed Home destination once`() {
        val f = Fixture(); val requests = HomeRequests(); val dispatcher = f.dispatcher("lodge.passport", Destination.Lodge("PASSPORT"), requests)
        f.mount().reportBlocked(false)
        assertTrue(f.host.canOpen(FeatureId("lodge.passport"), HomeTab.KINGDOM))
        assertTrue(dispatcher.openFeature(FeatureId("lodge.passport")))
        val request = requireNotNull(requests.pending.value as? HomeRequest.Open)
        assertTrue(f.opened.isEmpty())
        assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(request))
        assertNull(requests.pending.value); assertEquals(listOf(Destination.Lodge("PASSPORT")), f.opened)
        assertTrue(f.reasons.isEmpty())
    }

    // WHY: a retained supported request must wait for its current owner, not fall back to a retired entry.
    @Test fun `retained passport request defers behind a transient blocker then opens exactly once`() {
        val f = Fixture(); val requests = HomeRequests(); val dispatcher = f.dispatcher("lodge.passport", Destination.Lodge("PASSPORT"), requests)
        val request = HomeRequest.Open(FeatureId("lodge.passport"), f.identity, FeatureSelection())
        requests.request(request)
        assertEquals(HomeRouteDispatchResult.DEFERRED, dispatcher.consume(request))
        assertSame(request, requests.pending.value); assertTrue(f.opened.isEmpty()); assertTrue(f.reasons.isEmpty())
        f.mount().reportBlocked(false)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(request))
        assertNull(requests.pending.value); assertEquals(listOf(Destination.Lodge("PASSPORT")), f.opened)
    }

    // Clan mounts a designed information tab; its controls still hand off to the existing Bases owner.
    @Test fun `charter door captures its designed tab and retained request waits for the current mount`() {
        val f = Fixture(); val requests = HomeRequests(); val dispatcher = f.dispatcher("clan.charter", Destination.Clan("CHARTER"), requests)
        assertTrue(f.host.canOpen(FeatureId("clan.charter"), HomeTab.KINGDOM))
        assertTrue(dispatcher.openFeature(FeatureId("clan.charter")))
        val request = requireNotNull(requests.pending.value as? HomeRequest.Open)
        assertEquals(HomeRouteDispatchResult.DEFERRED, dispatcher.consume(request))
        assertSame(request, requests.pending.value); assertTrue(f.opened.isEmpty())
        f.mount().reportBlocked(false)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(request))
        assertNull(requests.pending.value); assertEquals(listOf(Destination.Clan("CHARTER")), f.opened)
        assertTrue(f.reasons.isEmpty())
    }

    // Both bodies are mounted; this does not expose a Charter repository in HomeOwnerProjections.
    @Test fun `direct Passport and Clan charter reach their designed bodies with the same current lease`() {
        val f = Fixture(); f.mount().reportBlocked(false)
        assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.Lodge("PASSPORT"), HomeTab.KINGDOM))
        assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.Clan("CHARTER"), HomeTab.KINGDOM))
        assertEquals(listOf(Destination.Lodge("PASSPORT"), Destination.Clan("CHARTER")), f.opened); assertTrue(f.reasons.isEmpty())
    }

    @Test fun `Clan full frame restores each designed tab and rejects unknown tabs`() {
        for (tab in listOf("CLAN", "MEMBERS", "CHARTER", "TOURNEY")) {
            val entry = SheetEntry(Destination.Clan(tab))
            assertEquals(SheetSize.FULL, mountedHomeSheetFrame(entry)?.size)
            assertEquals(tab, mountedHomeSheetFrame(entry)?.selectedTab)
            val stack = SheetStack(listOf(SheetEntry(Destination.Profile()), entry))
            assertEquals(stack.entries, mountedHomeSheetStack(stack).entries)
        }
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Clan("UNKNOWN"))))
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Clan(), selectedTab = "UNKNOWN")))
    }

    @Test fun `canonical tournament alias restores the TOURNEY display tab`() {
        assertEquals("TOURNEY", mountedHomeSheetFrame(SheetEntry(Destination.Clan("TOURNAMENT")))?.selectedTab)
        assertEquals("TOURNEY", mountedHomeSheetFrame(SheetEntry(Destination.Clan(), selectedTab = "TOURNAMENT"))?.selectedTab)
        assertTrue(FeatureId("clan.tournament").value in HOME_MOUNTED_FEATURES)
    }

    @Test fun `retained Clan request cannot navigate after account kingdom or generation replacement`() {
        for (replacement in listOf("session", "base", "generation")) {
            val f = Fixture(); val requests = HomeRequests(); val dispatcher = f.dispatcher("clan.open", Destination.Clan(), requests)
            f.mount().reportBlocked(false); assertTrue(dispatcher.openFeature(FeatureId("clan.open")))
            val request = requireNotNull(requests.pending.value as? HomeRequest.Open)
            f.current = when (replacement) {
                "session" -> f.identity.copy(session = Any())
                "base" -> f.identity.copy(baseId = "other")
                else -> f.identity.copy(baseSelectionGeneration = 2)
            }
            assertEquals(HomeRouteDispatchResult.STALE, dispatcher.consume(request))
            assertTrue(f.opened.isEmpty()); assertNull(requests.pending.value)
        }
    }

    @Test fun `selected Clan Hall door uses canonical registry and opens the typed Clan once`() {
        val f = ClanDoorFixture()
        f.dispatcher.openBuildingDoor(FeatureId("clan.open"), f.selection)
        val request = requireNotNull(f.requests.pending.value as? HomeRequest.Open)
        assertEquals(f.selection, request.selection.building); assertEquals(0, f.legacyCalls)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(Destination.Clan()), f.opened); assertTrue(f.reasons.isEmpty())
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
        assertEquals(1, f.opened.size)
    }

    @Test fun `selected Clan door refuses stale and wrong building selections without fallback`() {
        val f = ClanDoorFixture()
        f.dispatcher.openBuildingDoor(FeatureId("clan.open"), f.selection.copy(buildingId = "old"))
        assertNull(f.requests.pending.value); assertTrue(f.opened.isEmpty()); assertEquals(0, f.legacyCalls)
        f.selection = BuildingSelection("base", "forge", "goldforge")
        f.dispatcher.openBuildingDoor(FeatureId("clan.open"), f.selection)
        assertNull(f.requests.pending.value); assertEquals(0, f.legacyCalls); assertEquals(2, f.reasons.size)
    }

    @Test fun `Clan Hall construction gate stays authoritative`() {
        val f = ClanDoorFixture(); f.completed = false
        f.dispatcher.openBuildingDoor(FeatureId("clan.open"), f.selection)
        assertNull(f.requests.pending.value); assertTrue(f.opened.isEmpty()); assertEquals(0, f.legacyCalls)
        assertTrue(f.reasons.isNotEmpty())
    }

    @Test fun `Clan charter and tournament require real capability facts before selected building capture`() {
        for ((id, fact, destination) in listOf(
            Triple("clan.charter", "phaseE.charters", Destination.Clan("CHARTER")),
            Triple("clan.tournament", "phaseE.tournaments", Destination.Clan("TOURNAMENT")))) {
            for (unavailable in listOf(GateFact.Unknown, GateFact.Denied("Unavailable"))) {
                val f = ClanDoorFixture(); f.features = mapOf(fact to unavailable)
                f.dispatcher.openBuildingDoor(FeatureId(id), f.selection)
                assertNull(f.requests.pending.value); assertTrue(f.opened.isEmpty()); assertEquals(0, f.legacyCalls)
            }
            val f = ClanDoorFixture(); f.features = mapOf(fact to GateFact.Allowed)
            f.dispatcher.openBuildingDoor(FeatureId(id), f.selection)
            val request = requireNotNull(f.requests.pending.value as? HomeRequest.Open)
            assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
            assertEquals(listOf(destination), f.opened); assertEquals(0, f.legacyCalls)
        }
    }

    @Test fun `Clan actual mounts preserve lease guards and hand off both controls to Bases`() {
        val source = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        val standalone = source.substringAfter("composable<ClansRoute>").substringBefore("composable<TesterRoute>")
        assertTrue(standalone.contains("ClanHub(")); assertFalse(standalone.contains("ClansScreen("))
        assertTrue(standalone.contains("onCharterControls =")); assertTrue(standalone.contains("onTournamentControls ="))
        assertTrue(standalone.contains("navigate(BasesRoute(notice ="))
        val typed = source.substringAfter("is Destination.Clan -> ClanHub(").substringBefore("is Destination.Quests ->")
        assertTrue(typed.contains("hosted = true")); assertTrue(typed.contains("localRouteHost.canUseReadControl(lease)"))
        assertTrue(typed.contains("onCharterControls = { handoff {"))
        assertTrue(typed.contains("onTournamentControls = { handoff {"))
        assertTrue(typed.contains("navigate(BasesRoute(notice ="))
        assertFalse(typed.contains("session.charter")); assertFalse(typed.contains("session.tournament"))
    }

    // WHY: a clanless player's ClanHub draws the finder; without a frame for its tabs every FIND / CREATE / INVITES tap on
    // the Home sheet was refused with "This tab is not available." and the player could never reach the clan finder.
    @Test fun `clanless finder tabs have a Clan frame and open on the Home sheet`() {
        val f = Fixture(); f.mount().reportBlocked(false)
        for (tab in listOf("FIND", "CREATE", "INVITES")) {
            val frame = requireNotNull(mountedHomeSheetFrame(SheetEntry(Destination.Clan(tab)))) { tab }
            assertEquals(SheetSize.FULL, frame.size); assertEquals(tab, frame.selectedTab)
            assertEquals(tab, mountedHomeSheetFrame(SheetEntry(Destination.Clan(), selectedTab = tab, restored = true))?.selectedTab)
            val stack = SheetStack(listOf(SheetEntry(Destination.Profile()), SheetEntry(Destination.Clan(), selectedTab = tab)))
            assertEquals(stack.entries, mountedHomeSheetStack(stack).entries)
            assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.Clan(tab), HomeTab.KINGDOM))
        }
        assertEquals(listOf(Destination.Clan("FIND"), Destination.Clan("CREATE"), Destination.Clan("INVITES")), f.opened)
        assertTrue(f.reasons.isEmpty())
    }

    // WHY: Profile's DAILY TEST SKR row opens the faucet in place; a half sheet keeps the kingdom visible as faucet.png draws
    // it, and a missing frame would refuse the row or restore a blank sheet.
    @Test fun `the SKR faucet is a Home half sheet Profile can open in place`() {
        val frame = requireNotNull(mountedHomeSheetFrame(SheetEntry(Destination.SkrFaucet)))
        assertEquals(SheetSize.HALF, frame.size)
        assertEquals("DAILY TEST SKR", frame.title)
        assertTrue(frame.tabs.isEmpty())
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.SkrFaucet, selectedTab = "UNKNOWN")))
        val stack = SheetStack(listOf(SheetEntry(Destination.Profile("WALLET")), SheetEntry(Destination.SkrFaucet)))
        assertEquals(stack.entries, mountedHomeSheetStack(stack).entries)
        val f = Fixture(); f.mount().reportBlocked(false)
        assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.SkrFaucet, HomeTab.KINGDOM))
        assertEquals(listOf<Destination>(Destination.SkrFaucet), f.opened); assertTrue(f.reasons.isEmpty())
        // The SOL faucet keeps its own route: it is not a Home sheet.
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Faucet)))
    }

    private class ClanDoorFixture {
        val identity = HomeRouteIdentity(Any(), "base", 1)
        var selection = BuildingSelection("base", "hall", "clanhall")
        var completed = true
        var features: Map<String, GateFact> = emptyMap()
        var legacyCalls = 0
        val opened = mutableListOf<Destination>()
        val reasons = mutableListOf<String>()
        val requests = HomeRequests()
        val host = HomeSheetRouteHost({ identity }, { false }, { reasons += it }, legacyFeature = { legacyCalls++; true })
        val mount = host.attach(identity, {}, { false }, openBody = { opened += it }).also { it.reportBlocked(false) }
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), {
            HomeRouteContext(identity, GateContext(baseId = "base", buildings = mapOf("clanhall" to BuildingGateState(1, completed)),
                serverFeatures = features, selection = FeatureSelection(building = selection)))
        }, host)
    }

    // WHY: restoration retains the actual Passport mount and still refuses unknown tabs.
    @Test fun `passport restoration retains its supported tab and parent while refusing unknown tabs`() {
        val parent = SheetEntry(Destination.Lodge())
        val stack = SheetStack(listOf(parent, SheetEntry(Destination.Lodge("PASSPORT"))))
        assertEquals(stack.entries, mountedHomeSheetStack(stack).entries)
        assertEquals("PASSPORT", mountedHomeSheetFrame(SheetEntry(Destination.Lodge(), selectedTab = "PASSPORT"))?.selectedTab)
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Lodge(), selectedTab = "UNSUPPORTED")))
    }

    // WHY: the actual rendered Lodge tabs, not only the outer host, must truthfully lock Passport.
    @Test fun `Home Lodge mapper locks an unavailable Passport and unlocks only the admitted capability`() {
        val input = VoyageLiveInputs(null, "base", null, null, null, VoyagePolicyFacts(), nowMs = 0)
        val ui = homeLodgeSheetUi(input, LodgeLocalState())
        assertTrue(ui.passportLocked)
        assertTrue(gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.lodgeTabs(ui).single { it.id == "PASSPORT" }.locked)
        val admitted = homeLodgeSheetUi(input, LodgeLocalState(tab = "PASSPORT"), passportAvailable = true)
        assertFalse(admitted.passportLocked); assertEquals("PASSPORT", admitted.tab)
        assertFalse(gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.lodgeTabs(admitted).single { it.id == "PASSPORT" }.locked)
    }

    // WHY: simply removing producer providers is insufficient if the Home aggregate still exposes retired owners.
    @Test fun `Home aggregate exposes no Bases scoped owner`() {
        val fields = HomeOwnerProjections::class.java.declaredFields.map { it.name }.toSet()
        assertTrue(fields.containsAll(setOf("harvester", "vehicle", "starter", "starterFleet")))
        assertTrue(fields.intersect(setOf("passport", "charter", "retirement", "migration")).isEmpty())
    }

    // WHY: read admission must be at least as strict as the existing transport's visible guard.
    @Test fun `active started but invisible vehicle cannot read`() {
        assertFalse(homeVehicleReadAdmitted(started = true, active = true, visible = false, busy = false))
        assertTrue(homeVehicleReadAdmitted(started = true, active = true, visible = true, busy = false))
        assertFalse(homeVehicleReadAdmitted(true, false, true, false))
        assertFalse(homeVehicleReadAdmitted(false, true, true, false))
        assertFalse(homeVehicleReadAdmitted(true, true, true, true))
    }

    // WHY: unchanged recomposition must not publish a new static-local owner; generation changes must retire it.
    @Test fun `remembered projection is stable until its identity changes`() = runTest {
        val session = Any(); val model = Any()
        var identity by mutableStateOf(HomeRouteIdentity(session, "base", 1))
        var tick by mutableIntStateOf(0)
        val clock = BroadcastFrameClock(); val recomposer = Recomposer(coroutineContext + clock)
        val composition = Composition(object : AbstractApplier<Unit>(Unit) {
            override fun insertTopDown(index: Int, instance: Unit) = Unit
            override fun insertBottomUp(index: Int, instance: Unit) = Unit
            override fun remove(index: Int, count: Int) = Unit
            override fun move(from: Int, to: Int, count: Int) = Unit
            override fun onClear() = Unit
        }, recomposer)
        val runner = launch(clock) { recomposer.runRecomposeAndApplyChanges() }
        val seen = mutableListOf<Any>()
        composition.setContent {
            val value = rememberHomeProjection(session, model, identity) { Any() }
            val readTick = tick
            SideEffect { if (readTick >= 0) seen += value }
        }
        try {
            tick++; Snapshot.sendApplyNotifications(); runCurrent(); clock.sendFrame(1); runCurrent()
            assertTrue(seen.size >= 2); assertSame(seen.first(), seen.last())
            identity = identity.copy(baseSelectionGeneration = 2)
            Snapshot.sendApplyNotifications(); runCurrent(); clock.sendFrame(2); runCurrent()
            assertNotSame(seen.first(), seen.last())
        } finally { composition.dispose(); recomposer.cancel(); runner.join() }
    }

    // WHY: only mounted, parameter-preserving addresses may replace existing doors.
    @Test fun `supported harvester lodge and berth addresses retain their tabs and sections`() {
        val f = Fixture(); f.mount().reportBlocked(false)
        val routes = listOf(Destination.Harvester("HISTORY"), Destination.Lodge("UNDER_WAY"), Destination.Berth(section = "starter"), Destination.Berth("SERVICE"))
        routes.forEach { assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(it, HomeTab.KINGDOM)) }
        assertEquals(routes, f.opened)
        assertEquals(SheetSize.TALL, mountedHomeSheetFrame(SheetEntry(routes.first()))?.size)
    }

    // WHY: these mounts must never capture another Home tab or fabricate an unsupported mode.
    @Test fun `foreign tabs and unsupported body parameters refuse rather than silently resetting`() {
        val f = Fixture(); f.mount().reportBlocked(false)
        assertFalse(f.host.canOpen(FeatureId("harvester.harvest"), HomeTab.WORLD))
        assertEquals(HomeNavigationResult.REFUSED, f.host.navigateResult(Destination.Lodge(mode = "unknown"), HomeTab.KINGDOM))
        assertEquals(HomeNavigationResult.REFUSED, f.host.navigateResult(Destination.Berth(section = "unknown"), HomeTab.KINGDOM))
        assertEquals(HomeNavigationResult.REFUSED, f.host.navigateResult(Destination.Harvester("unknown"), HomeTab.KINGDOM))
        assertTrue(f.opened.isEmpty())
    }

    // WHY: a missing projection is transient and must not consume the one queued command.
    @Test fun `warming Harvester owner defers then consumes the same queued request once`() {
        val f = Fixture(); f.ownerReady = false; f.mount().reportBlocked(false)
        val requests = HomeRequests(); val dispatcher = f.dispatcher("harvester.harvest", Destination.Harvester(), requests)
        assertTrue(dispatcher.openFeature(FeatureId("harvester.harvest")))
        val request = requests.pending.value as HomeRequest.Open
        assertEquals(HomeRouteDispatchResult.DEFERRED, dispatcher.consume(request)); assertSame(request, requests.pending.value)
        assertTrue(f.opened.isEmpty()); f.ownerReady = true
        assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(request)); assertNull(requests.pending.value)
        assertEquals(listOf(Destination.Harvester()), f.opened)
    }

    // WHY: changing the same base's generation cannot dispatch a previously captured body request.
    @Test fun `stale body requests are retired without navigation`() {
        val f = Fixture(); f.mount().reportBlocked(false); val requests = HomeRequests()
        val dispatcher = f.dispatcher("berth.fleet", Destination.Berth(), requests)
        assertTrue(dispatcher.openFeature(FeatureId("berth.fleet"))); val request = requests.pending.value as HomeRequest.Open
        f.current = f.identity.copy(baseSelectionGeneration = 2)
        assertEquals(HomeRouteDispatchResult.STALE, dispatcher.consume(request)); assertNull(requests.pending.value)
        assertTrue(f.opened.isEmpty())
    }

    // WHY: an owner review that appears after drawing must prevent X/Back and scene fall-through.
    @Test fun `body review blocks close and consumes covered scene taps without dismissal`() {
        val f = Fixture(); f.mount().reportBlocked(false); f.ownerReview = true
        var pops = 0; var clears = 0
        assertFalse(f.host.closeOwnedSheet(f.lease, { clears++ }, { pops++ }))
        assertTrue(f.host.beforeSceneTap()); assertEquals(0, f.sceneCloses)
        assertEquals(0, pops); assertEquals(0, clears)
        assertFalse(f.host.canUseReadControl(f.lease))
    }

    // WHY: a stale FULL or HALF presentation can never close its replacement's history.
    @Test fun `replacement body lease rejects the old close while strict null keeps the new presentation closable`() {
        val f = Fixture(); val old = f.mount(); old.reportBlocked(false)
        val replacement = Any(); f.host.attach(f.identity, {}, { true }, replacement, { true }, openBody = {}).reportBlocked(false)
        f.current = null; var pops = 0
        assertFalse(f.host.closeOwnedSheet(f.lease, {}, { pops++ }))
        assertTrue(f.host.closeOwnedSheet(replacement, {}, { pops++ })); assertEquals(1, pops)
        old.close(); assertTrue(f.host.isOwner(replacement))
    }

    // WHY: selection-specific interception must leave all other legacy building commands reachable.
    @Test fun `partial building interception is limited to mounted building types`() {
        assertTrue(homeMountedBuildingType("harvester")); assertTrue(homeMountedBuildingType("lodge")); assertTrue(homeMountedBuildingType("berth")); assertTrue(homeMountedBuildingType("clanhall"))
        assertFalse(homeMountedBuildingType("market")); assertFalse(homeMountedBuildingType("workshop")); assertFalse(homeMountedBuildingType(null))
    }

    // WHY: first observation is seeded, avoiding invented arrival notifications; acknowledgement never regresses.
    @Test fun `seen marker seeds first observation and advances only on explicit acknowledgement`() {
        val seen = HomeHarvesterSeen()
        assertEquals("9", seen.observe("source", "9")); assertEquals("9", seen.observe("source", "12"))
        assertEquals("12", seen.acknowledge("source", "12")); assertEquals("12", seen.acknowledge("source", "10"))
        assertEquals("2", seen.observe("other-source", "2")); assertEquals("12", seen.observe("source", "13"))
    }

    // WHY: incomplete observations cannot manufacture a saved sequence or reset the account marker.
    @Test fun `unknown and malformed seen sequences never become zero or erase evidence`() {
        val seen = HomeHarvesterSeen()
        assertNull(seen.observe("source", null)); assertNull(seen.observe("source", "bad"))
        assertEquals("8", seen.observe("source", "8")); assertEquals("8", seen.acknowledge("source", null))
        assertEquals("8", seen.acknowledge("source", "-1"))
    }

    // WHY: refresh must preserve legacy history semantics by observing every still-open archived original first.
    @Test fun `Harvester refresh checks archived originals before refreshing the live view`() = runTest {
        val calls = mutableListOf<String>()
        assertTrue(refreshHomeHarvester(listOf("old-a", "old-b"), { true }, { calls += it }, { calls += "view" }))
        assertEquals(listOf("old-a", "old-b", "view"), calls)
    }

    // WHY: an identity or review change while awaiting a receipt prevents further owner calls.
    @Test fun `Harvester refresh stops between archived reads when ownership changes`() = runTest {
        var allowed = true; val calls = mutableListOf<String>()
        assertFalse(refreshHomeHarvester(listOf("old-a", "old-b"), { allowed }, { calls += it; allowed = false }, { calls += "view" }))
        assertEquals(listOf("old-a"), calls)
    }

    // WHY: review retention takes priority over a refresh that would clear the repository's review.
    @Test fun `blocked Harvester refresh makes no call and leaves saved history untouched`() = runTest {
        val keys = listOf("original"); val calls = mutableListOf<String>()
        assertFalse(refreshHomeHarvester(keys, { false }, { calls += it }, { calls += "view" }))
        assertTrue(calls.isEmpty()); assertEquals(listOf("original"), keys)
    }

    // WHY: a server flag cached before this mount cannot admit a gate without a same-owner completed read.
    @Test fun `feature read proof starts unknown and publishes only after completion`() = runTest {
        val identity = HomeRouteIdentity(Any(), "base", 1); val capture = HomeFeatureReadCapture(identity)
        assertEquals(HomeFeatureReadStatus.WAITING, capture.status)
        capture.refresh({ true }, { true })
        assertEquals(HomeFeatureReadStatus.READY, capture.status)
    }

    // WHY: a successful old-base GET is evidence for that original only and must not enable the new owner's UI.
    @Test fun `changed owner during a feature read never publishes ready proof`() = runTest {
        val capture = HomeFeatureReadCapture(HomeRouteIdentity(Any(), "base", 1)); var current = true
        capture.refresh({ current = false; true }, { current })
        assertEquals(HomeFeatureReadStatus.WAITING, capture.status)
    }

    // WHY: failed reads must produce a retryable terminal refusal, not a perpetual warming request.
    @Test fun `failed feature preflight is distinct from warming and a new attempt can recover`() = runTest {
        val capture = HomeFeatureReadCapture(HomeRouteIdentity(Any(), "base", 1))
        capture.refresh({ error("offline") }, { true }); assertEquals(HomeFeatureReadStatus.FAILED, capture.status)
        capture.refresh({ true }, { true }); assertEquals(HomeFeatureReadStatus.READY, capture.status)
    }

    // WHY: the real Harvester registry gate requires both current server evidence and a completed building.
    @Test fun `canonical Harvester gate stays locked without completed current read evidence`() {
        fun context(fact: GateFact) = GateContext(baseId = "base", buildings = mapOf("harvester" to BuildingGateState(1, true)),
            serverFeatures = mapOf("phaseE.harvesters" to fact))
        val registry = FeatureRegistry.canonical(); val id = FeatureId("harvester.harvest")
        assertTrue(registry.resolve(id, context(homeObservedFeatureFact(false, true, true))) is FeatureResolution.Locked)
        assertTrue(registry.resolve(id, context(homeObservedFeatureFact(true, false, true))) is FeatureResolution.Locked)
        assertEquals(FeatureResolution.Navigate(Destination.Harvester()), registry.resolve(id, context(homeObservedFeatureFact(true, true, true))))
        assertTrue(registry.resolve(id, context(homeObservedFeatureFact(true, true, false))) is FeatureResolution.Locked)
    }

    // WHY: a feature GET must finish before even a currently LOCKED/unknown registry row is consumed.
    @Test fun `feature preflight defers the same head before registry resolution and fails terminally`() {
        val f = Fixture(); f.mount().reportBlocked(false); f.preparation = HomeNavigationResult.DEFERRED
        val requests = HomeRequests(); val dispatcher = f.dispatcher("harvester.harvest", Destination.Harvester(), requests)
        assertTrue(dispatcher.openFeature(FeatureId("harvester.harvest"))); val request = requests.pending.value as HomeRequest.Open
        assertEquals(HomeRouteDispatchResult.DEFERRED, dispatcher.consume(request)); assertSame(request, requests.pending.value)
        f.preparation = HomeNavigationResult.REFUSED
        assertEquals(HomeRouteDispatchResult.LOCKED, dispatcher.consume(request)); assertNull(requests.pending.value)
        assertTrue(f.opened.isEmpty()); assertTrue(f.reasons.single().contains("retry"))
    }

    // WHY: storage that failed to open is known unavailable, not a reason for an endless deferred request.
    @Test fun `known unavailable body refuses with its recovery reason`() {
        val f = Fixture(); f.mount().reportBlocked(false); f.unavailable = "Saved fleet storage is unavailable."
        assertEquals(HomeNavigationResult.REFUSED, f.host.navigateResult(Destination.Berth(), HomeTab.KINGDOM))
        assertTrue(f.opened.isEmpty()); assertEquals(listOf(f.unavailable), f.reasons)
    }
}
