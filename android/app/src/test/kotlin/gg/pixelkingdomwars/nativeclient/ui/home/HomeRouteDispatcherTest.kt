package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.features.*
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.data.WorkshopState
import gg.pixelkingdomwars.nativeclient.data.WorkshopReview
import gg.pixelkingdomwars.nativeclient.workshop.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.homeWorkshopDisplay
import gg.pixelkingdomwars.nativeclient.ui.sheets.money.live.HomeWorkshopReadStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.IngotJobState
import kotlinx.coroutines.CancellationException
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomLocal
import gg.pixelkingdomwars.nativeclient.ui.kingdom.KingdomUiState
import gg.pixelkingdomwars.nativeclient.ui.nav.homeRouteContext
import gg.pixelkingdomwars.nativeclient.ui.nav.homePresentationIdentity
import gg.pixelkingdomwars.nativeclient.ui.nav.StableHomeLayer
import gg.pixelkingdomwars.nativeclient.ui.nav.HomeCommunityReads
import gg.pixelkingdomwars.nativeclient.ui.nav.HomeLeagueReadCapture
import gg.pixelkingdomwars.nativeclient.ui.community.MailScope
import gg.pixelkingdomwars.nativeclient.ui.community.mailScopeCurrent
import gg.pixelkingdomwars.nativeclient.data.CommunityRepository
import gg.pixelkingdomwars.nativeclient.data.CommunityState
import gg.pixelkingdomwars.nativeclient.ui.sheets.hub.LoadState
import androidx.compose.runtime.*
import androidx.compose.runtime.snapshots.Snapshot
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.runCurrent
import java.io.File
import kotlinx.serialization.json.JsonObject
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.*
import org.junit.Test

/** Authored before the dispatcher. Execution belongs to the content pipeline's accepted build queue. */
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class HomeRouteDispatcherTest {
    // WHY: the same vehicle owner serves both doors, but restoration must retain which door and mode were requested.
    @Test fun `voyage vehicle handoff carries the explicit door and separates receipts from controls`() {
        val calls = mutableListOf<Pair<gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint, Boolean>>()
        val open: (gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint, Boolean) -> Unit = { entry, history ->
            calls += entry to history
        }
        for (history in listOf(false, true)) {
            homeVoyageVehicleOpen(Destination.Lodge(), history, open)
            homeVoyageVehicleOpen(Destination.Berth(), history, open)
        }
        assertEquals(listOf(
            gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint.LODGE to false,
            gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint.BERTH to false,
            gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint.LODGE to true,
            gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint.BERTH to true), calls)
        homeVoyageVehicleOpen(Destination.Mail, true, open)
        assertEquals("unsupported destinations cannot invent a vehicle entrance", 4, calls.size)
    }

    @Test fun `mounted voyage history uses only the receipt handoff and root keeps its live admission gates`() {
        val host = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeRouteDispatcher.kt").readText()
            .substringAfter("@Composable internal fun HomeVoyageSheet(")
        assertTrue(host.contains("homeVoyageVehicleOpen(entry.destination, false, openVehicles)"))
        assertTrue(host.contains("homeVoyageVehicleOpen(entry.destination, true, openVehicles)"))
        // Rewritten for the voyage mount (night 2026-10-06). The generic "open Vehicle controls" text button is gone: each
        // designed door now reaches the same openVehicles handoff with its own entry (the Lodge craft link, the Berth craft
        // link and crafted install/service), so the host must hand openVehicles to both bodies instead of drawing a button.
        assertFalse(host.contains("TextButton(onClick = { openVehicles(null, false) })"))
        // Rewritten for voyage packet A2: the Lodge body moved to HomeLodgeLiveSheet. Its HISTORY door still reaches only
        // the receipt handoff, because the host passes vehicleHistory as onHistory and the body routes HISTORY to it.
        val lodge = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeLodgeLiveSheet.kt").readText()
        assertTrue(lodge.contains("LodgeLiveDoor.HISTORY -> onHistory()"))
        assertTrue(host.contains("Modifier.weight(1f), onTab, onClose, vehicleHistory, openFeature"))
        // Rewritten for the craft-vehicle door (owner 2026-10-06: craft vehicle landed on the base screen). The Lodge's only
        // vehicle door was its craft link, which now opens the globe on Solana Island's Public Workshop, so the Lodge gets
        // openSolanaIsland instead of openVehicles; the Berth keeps openVehicles for crafted install/service.
        assertTrue(host.contains("openSolanaIsland = openSolanaIsland, onBuildBerth = onBuildBerth, onStack = onStack"))
        assertFalse(host.contains("openVehicles = openVehicles, onBuildBerth = onBuildBerth"))
        // The Berth body moved to HomeBerthLiveSheet. The host passes vehicleHistory as onHistory beside openVehicles, and
        // HISTORY reaches the receipts only after a saved starter outcome declined it; a missing owner explains itself
        // and never falls back to the legacy screen.
        assertTrue(host.replace(Regex("\\s+"), " ").contains("HomeBerthLiveSheet(identity, entry, input, owners, " +
            "Modifier.weight(1f), onTab, onClose, onLegacy, vehicleHistory, openVehicles, openFeature"))
        val berth = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeBerthLiveSheet.kt").readText()
        val history = berth.substringAfter("BerthLiveDoor.HISTORY ->").substringBefore("BerthLiveDoor.LODGE_SEND")
        assertTrue(history.trimStart().startsWith("if (starterReview?.openSavedOutcome(onLegacy) != true) {"))
        assertTrue(history.contains("if (owners.vehicle != null) onHistory()"))
        assertFalse(berth.contains("BerthLiveDoor.HISTORY -> if (owners.vehicle != null) onHistory() else onLegacy()"))
        assertFalse(history.contains("else onLegacy()"))
        val root = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
            .substringAfter("openVehicles = {").substringBefore("}, openFeature =")
        assertTrue(root.contains("localRouteHost.canUseReadControl(lease) && !routeAdmissionBlocked.value()"))
        assertTrue(root.contains("owner?.entryOpening(vehicleEntry?.name, historyOnly)"))
        assertTrue(root.contains("if (opening != null) handoff { opening() }"))
        assertFalse(root.contains("owner.open()"))
    }

    // WHY: ordinary base refresh is navigation admission, not permission to discard an open card's GET proof.
    @Test fun `base refresh during an open Workshop read keeps the card ready but defers its legacy handoff`() = runTest {
        val f = WorkshopReadFixture(); var baseRefreshing = false; val lease = Any(); val reasons = mutableListOf<String>()
        val host = HomeSheetRouteHost({ f.actual }, { baseRefreshing }, { reasons += it })
        val mount = host.attach(f.identity, {}, { false }, owner = lease, openBody = {})
        mount.reportBlocked(false)
        assertTrue(f.capture.refresh({ f.current() && host.canUseReadControl(lease) }, { f.state }) {
            f.calls++; baseRefreshing = true; mount.reportBlocked(true)
        })
        assertEquals(1, f.calls); assertTrue(baseRefreshing); assertEquals(LoadState.Ready, f.capture.load)
        assertTrue(f.capture.observed(f.state, host.canUseReadControl(lease)))
        assertNotNull(workshopObservation(f.capture.snapshot!!))
        var navigated = 0
        assertFalse(host.handoffOwnedSheet(lease, {}, {}, { navigated++ }))
        assertEquals(0, navigated); assertEquals(1, reasons.size)
    }

    // WHY: the read still cannot erase a review, including one observed after a serialized wait.
    @Test fun `Workshop capture retains a review present before a read or when its wait completes`() = runTest {
        val f = WorkshopReadFixture()
        val review = WorkshopReview(WorkshopCommand.start(workshopView(), "review-original", 1), workshopView(), "999", 0, 2, 0, 0)
        f.state = f.state.copy(review = review)
        assertFalse(f.read()); assertEquals(0, f.calls); assertSame(review, f.state.review)
        f.state = f.state.copy(review = null); val release = CompletableDeferred<Unit>()
        val work = launch { f.capture.refresh(f::current, { f.state }) { f.calls++; release.await() } }
        runCurrent(); assertTrue(f.capture.running); assertEquals(LoadState.Loading, f.capture.load)
        f.state = f.state.copy(review = review); release.complete(Unit); work.join()
        assertSame(review, f.state.review); assertNull(f.capture.snapshot); assertTrue(f.capture.load is LoadState.Error)
    }

    // WHY: exact current discovery evidence alone does not advertise a feature that the server declined.
    @Test fun `Workshop Economy observation requires current advertised idle review free evidence`() = runTest {
        val f = WorkshopReadFixture(); val proof = HomeEconomyReadCapture<WorkshopState>(f.identity)
        assertFalse(homeWorkshopEconomyObserved(proof, f.state, true))
        proof.refresh({ true }) { f.state }; assertTrue(homeWorkshopEconomyObserved(proof, f.state, true))
        assertFalse(homeWorkshopEconomyObserved(proof, f.state, false))
        assertFalse(homeWorkshopEconomyObserved(proof, f.state.copy(), true))
        assertFalse(homeWorkshopEconomyObserved(proof, null, true))
        val review = WorkshopReview(WorkshopCommand.start(workshopView(), "review-original", 1), workshopView(), "999", 0, 2, 0, 0)
        for (state in listOf(f.state.copy(advertised = false), f.state.copy(busy = true), f.state.copy(review = review))) {
            proof.refresh({ true }) { state }
            assertFalse(homeWorkshopEconomyObserved(proof, state, true))
        }
    }

    // WHY: the production Economy host must retain the existing Workshop recovery route until all capture facts exist.
    @Test fun `Workshop Economy uses legacy for unknown flag off or no completed building`() = runTest {
        val id = FeatureId("workshop.craft")
        for ((advertised, completed) in listOf(null to true, false to true, true to false, true to true)) {
            val f = WorkshopReadFixture(); f.state = f.state.copy(advertised = advertised == true)
            val proof = HomeEconomyReadCapture<WorkshopState>(f.identity)
            if (advertised != null) proof.refresh({ true }) { f.state }
            val requests = HomeRequests(); var legacy = 0; var returned = 0; val reasons = mutableListOf<String>()
            val host = HomeEconomyRouteHost({ requests.pending.value == null && homeWorkshopEconomyObserved(proof, f.state, f.current()) },
                { if (it != id) false else { legacy++; true } }, { returned++ }, { reasons += it })
            val snapshot = BaseSnapshot(WORKSHOP_BASE, null, PlayerSummary(keepLevel = 1), null, null, null,
                if (completed) listOf(Building("workshop-fixture", "workshop", 1, 0, 0)) else emptyList(),
                emptyList(), emptyList(), 0, JsonObject(emptyMap()))
            val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), {
                homeEconomyRouteContext(f.identity, BaseState(base = snapshot), emptyMap())
            }, host, HomeRequestEntry.ECONOMY)
            assertTrue(dispatcher.handleFeatureDoor(id)); assertTrue(reasons.isEmpty())
            if (advertised == true && completed) {
                assertEquals(id, (requests.pending.value as HomeRequest.Open).featureId); assertEquals(1, returned); assertEquals(0, legacy)
            } else { assertNull(requests.pending.value); assertEquals(0, returned); assertEquals(1, legacy) }
        }
    }

    // WHY: the prior bug was only in PkwApp; pin that exact guard, concrete handoff and the real discovery predicate.
    @Test fun `Workshop actual navigation wiring separates reads from handoff and preserves Economy recovery`() {
        val app = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        // Rewritten for the in-place mount (ui-craft): the Home branch mounts the designed owner sheet, whose CAST, COLLECT,
        // START and STYLE act in place. Its reads still use the lease's read control alone, TOOLS still goes through the
        // guarded tab handoff, and no route hop (the old onLegacy OPEN REFINING / OPEN INGOTS) is left on this path.
        val branch = app.substringAfter("is Destination.Workshop -> gg.pixelkingdomwars.nativeclient.ui.home.HomeWorkshopOwnerSheet(")
            .substringBefore("is Destination.Harvester ->")
        assertTrue(branch.contains("canRead = { localRouteHost.canUseReadControl(lease) }"))
        assertFalse(branch.contains("canRead = { localRouteHost.canUseReadControl(lease) &&"))
        assertTrue(branch.contains("onTab = changeTab"))
        assertTrue(branch.contains("onOpenTools = { changeTab(\"EQUIPMENT\") }"))
        assertTrue(branch.contains("onOpenDestination = craftDoor"))
        assertFalse(branch.contains("onLegacy")); assertFalse(branch.contains("WorkshopRoute"))
        assertFalse(branch.contains("OrdinaryCraftingRoute"))
        val economy = app.substringAfter("composable<EconomyRoute>").substringBefore("composable<ReferralsRoute>")
        assertTrue(economy.contains("homeWorkshopEconomyObserved(workshopRead, workshopRepository?.state?.value, current)"))
        val legacy = economy.substringAfter("legacy = { id ->").substringBefore("}, returnHome =")
        assertTrue(legacy.contains("if (!economyRouteCurrent()) false")); assertFalse(legacy.contains("economyCanLeave"))
        assertTrue(legacy.contains("\"workshop.craft\" -> { navController.navigate(WorkshopRoute)"))
        assertTrue("workshop.craft" in HOME_ECONOMY_FEATURES)
    }

    // WHY: the repository mutex may outlive its public busy flag; the borrowed read must wait without a false failure.
    @Test fun `Workshop mounted refresh waits for its existing repository lock and retains review guards`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeRouteDispatcher.kt").readText()
        // Since the in-place mount (ui-craft) this pins the retained HomeWorkshopSheet source (off the player path, kept until
        // its cleanup); the mounted sheet's owners read through their own view models (HomeWorkshopOwnerSheetTest).
        val body = source.substringAfter("@Composable internal fun HomeWorkshopSheet(").substringBefore("/** Captured list observations only.")
        assertTrue(body.contains("requireNotNull(repository).refresh(waitForIdle = true)"))
        assertFalse(body.contains("requireNotNull(repository).refresh()"))
        assertTrue(body.contains("repository?.state?.value?.review == null"))
        val capture = source.substringAfter("internal class HomeWorkshopReadCapture(").substringBefore("internal fun homeWorkshopObservation(")
        assertTrue(capture.contains("before.review != null")); assertTrue(capture.contains("after.review != null"))
    }

    // ed35e515: route and actual source wiring, authored before the isolated PkwApp route change.
    @Test fun `Heroes route serializes and restores the explicit selected hero`() {
        val expected = gg.pixelkingdomwars.nativeclient.ui.nav.HeroesRoute("fixture-hero")
        val serializer = gg.pixelkingdomwars.nativeclient.ui.nav.HeroesRoute.serializer()
        val encoded = kotlinx.serialization.json.Json.encodeToString(serializer, expected)
        assertEquals(expected, kotlinx.serialization.json.Json.decodeFromString(serializer, encoded))
        assertEquals("fixture-hero", kotlinx.serialization.json.Json.decodeFromString(serializer, encoded).hero)
    }

    @Test fun `default Heroes route preserves absent explicit selection including missing serialized field`() {
        val serializer = gg.pixelkingdomwars.nativeclient.ui.nav.HeroesRoute.serializer()
        assertNull(gg.pixelkingdomwars.nativeclient.ui.nav.HeroesRoute().hero)
        assertNull(kotlinx.serialization.json.Json.decodeFromString(serializer, "{}").hero)
    }

    @Test fun `Army tap route and Heroes destination preserve the same argument in actual PkwApp wiring`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        val heroDestination = source.substringAfter("composable<HeroesRoute>").substringBefore("composable<InventoryRoute>")
        assertTrue(heroDestination.contains("entry.toRoute<HeroesRoute>().hero"))
        assertTrue(heroDestination.contains("HeroesLiveHost(model, initialHero = requestedHero"))
        // MS-UI3 Army home mount: Hero GO stays over Kingdom, so the tapped hero must reach the Home Heroes sheet unchanged.
        assertTrue(source.contains("onOpenHero = { hero -> armyLiveHero = hero; armyLiveSheet = \"heroes\" }"))
        assertTrue(source.contains("HeroesLiveHost(armyLiveRoster, initialHero = armyLiveHero,"))
        assertTrue(source.contains("MoreDestination.HEROES -> HeroesRoute()"))
        assertFalse(source.contains("@Serializable object HeroesRoute"))
        assertFalse(source.contains("navigate(HeroesRoute)"))
    }

    // Workshop display/handoff regressions: authored before production; synthetic protocol observations only.
    @Test fun `Workshop mounts canonical doors only in Kingdom and keeps the prior building group unchanged`() {
        val f = SheetMountFixture()
        assertTrue(f.host.canOpen(FeatureId("workshop.craft"), HomeTab.KINGDOM))
        assertFalse(f.host.canOpen(FeatureId("workshop.craft"), HomeTab.WORLD))
        // 26f91ecf narrows capture; sibling frame restoration below remains separately covered.
        for (id in listOf("workshop.refine", "workshop.ingots", "workshop.equipment", "workshop.cosmetics")) {
            assertFalse(f.host.canOpen(FeatureId(id), HomeTab.KINGDOM))
            assertFalse(f.host.canOpen(FeatureId(id), HomeTab.WORLD))
        }
        assertEquals(HomeRequestEntry.ECONOMY, HomeRequest.Open(FeatureId("workshop.craft"), f.identity,
            FeatureSelection(), entry = HomeRequestEntry.ECONOMY).entry)
        assertTrue(homeMountedWorkshopBuildingType("workshop"))
        assertFalse(homeMountedWorkshopBuildingType("market")); assertFalse(homeMountedWorkshopBuildingType(null))
        assertFalse(homeMountedBuildingType("workshop")) // Four-group producer allocation remains unchanged.
        assertEquals(FeatureResolution.Navigate(Destination.Workshop()), FeatureRegistry.canonical().resolve(
            FeatureId("workshop.craft"), GateContext(buildings = mapOf("workshop" to BuildingGateState(1, true)))))
    }

    @Test fun `Workshop frame preserves canonical tabs and refuses invented descendants`() {
        for (tab in listOf(null, "REFINE", "INGOTS", "EQUIPMENT", "COSMETICS")) {
            val frame = mountedHomeSheetFrame(gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.Workshop(tab)))!!
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.TALL, frame.size)
            assertEquals(tab ?: "INGOTS", frame.selectedTab)
        }
        assertNull(mountedHomeSheetFrame(gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.Workshop("AWNINGS"))))
        assertNull(mountedHomeSheetFrame(gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.Workshop(), selectedTab = "UNKNOWN")))
    }

    @Test fun `Workshop door waits for a body and legacy handoff requires a current clear lease`() {
        val f = SheetMountFixture(); val lease = Any(); val events = mutableListOf<String>()
        f.mount().reportBlocked(false)
        assertEquals(HomeNavigationResult.DEFERRED, f.host.navigateResult(Destination.Workshop(), HomeTab.KINGDOM))
        f.host.attach(f.identity, {}, { false }, owner = lease, openBody = { events += "body" }).reportBlocked(false)
        assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.Workshop(), HomeTab.KINGDOM))
        f.review = true
        assertFalse(f.host.handoffOwnedSheet(lease, { events += "clear" }, { events += "pop" }, { events += "legacy" }))
        f.review = false; f.current = f.identity.copy(baseSelectionGeneration = 3)
        assertFalse(f.host.handoffOwnedSheet(lease, { events += "clear" }, { events += "pop" }, { events += "legacy" }))
        f.current = f.identity
        assertTrue(f.host.handoffOwnedSheet(lease, { events += "clear" }, { events += "pop" }, { events += "legacy" }))
        assertEquals(listOf("body", "pop", "clear", "legacy"), events)
    }

    @Test fun `Workshop read proof appears only after its bounded operation completes`() = runTest {
        val f = WorkshopReadFixture(); val release = CompletableDeferred<Unit>()
        val job = launch { f.capture.refresh(f::current, { f.state }) { f.calls++; release.await() } }
        runCurrent(); assertTrue(f.capture.running); assertFalse(f.capture.observed(f.state, true))
        assertFalse(f.capture.refresh(f::current, { f.state }) { f.calls++ })
        assertEquals(1, f.calls); release.complete(Unit); job.join()
        assertTrue(f.capture.observed(f.state, true)); assertEquals(LoadState.Ready, f.capture.load)
    }

    @Test fun `stale Workshop identity cannot start a read`() = runTest {
        val f = WorkshopReadFixture(); f.actual = f.identity.copy(baseSelectionGeneration = 3)
        assertFalse(f.read()); assertEquals(0, f.calls); assertNull(f.capture.snapshot)
    }

    @Test fun `Workshop read refuses busy and reviewed owners without dismissing them`() = runTest {
        val f = WorkshopReadFixture(); f.state = f.state.copy(busy = true)
        assertFalse(f.read()); assertEquals(0, f.calls)
        val review = WorkshopReview(WorkshopCommand.start(workshopView(), "original-key", 1), workshopView(), "999", 0, 2, 0, 0)
        f.state = f.state.copy(busy = false, review = review)
        assertFalse(f.read()); assertEquals(0, f.calls); assertSame(review, f.state.review)
        f.state = f.state.copy(review = null); assertTrue(f.read())
    }

    @Test fun `Workshop response after base generation changes cannot publish a current observation`() = runTest {
        val f = WorkshopReadFixture()
        assertFalse(f.capture.refresh(f::current, { f.state }) { f.actual = f.identity.copy(baseSelectionGeneration = 3) })
        assertNull(f.capture.snapshot); assertFalse(f.capture.observed(f.state, true))
    }

    @Test fun `Workshop read failure invalidates earlier view evidence and permits an explicit retry`() = runTest {
        val f = WorkshopReadFixture(); assertTrue(f.read())
        assertFalse(f.capture.refresh(f::current, { f.state }) { error("offline") })
        assertNull(f.capture.snapshot); assertTrue(f.capture.load is LoadState.Error); assertFalse(f.capture.running)
        assertTrue(f.read()); assertTrue(f.capture.observed(f.state, true))
    }

    @Test fun `Workshop cancellation clears transient proof and propagates`() = runTest {
        val f = WorkshopReadFixture(); val cancelled = CancellationException("retired")
        try { f.capture.refresh(f::current, { f.state }) { throw cancelled }; fail("must cancel") }
        catch (actual: CancellationException) { assertSame(cancelled, actual) }
        assertFalse(f.capture.running); assertNull(f.capture.snapshot); assertTrue(f.capture.load is LoadState.Error)
    }

    @Test fun `Workshop retained equal snapshots and A B A generations cannot reuse read evidence`() = runTest {
        val f = WorkshopReadFixture(); assertTrue(f.read())
        assertTrue(f.capture.observed(f.state, true))
        assertFalse(f.capture.observed(f.state.copy(), true)); assertFalse(f.capture.observed(f.state, false))
        val replacement = HomeWorkshopReadCapture(f.identity.copy(baseSelectionGeneration = 4))
        assertFalse(replacement.observed(f.state, true))
    }

    @Test fun `Workshop admission is rechecked against busy and review after a read`() = runTest {
        val f = WorkshopReadFixture()
        assertFalse(f.capture.refresh(f::current, { f.state }) { f.state = f.state.copy(busy = true) })
        assertNull(f.capture.snapshot)
    }

    // The frozen M3 display contract supersedes the preliminary summary model; keep the same eight observation cases.
    @Test fun `Workshop summary consumes admitted mapper inventory without rendering controls or prices`() {
        val ui = requireNotNull(workshopObservation(workshopState()))
        assertEquals("Workshop idle", ui.frame.live?.text); assertEquals("LV 1", ui.frame.titleTag)
        assertEquals(1L, ui.ingots?.inventory?.held); assertEquals(1L, ui.ingots?.inventory?.pending)
        assertNull(ui.ingots?.saved); assertFalse(requireNotNull(ui.ingots).actionsAllowed)
        assertNull(ui.spend); assertNull(ui.review); assertNull(ui.celebration); assertNull(ui.ingots?.shardsPerIngot)
    }

    @Test fun `Workshop summary keeps unobserved inventory unknown and never says paused or permanent checking`() {
        assertNull(workshopObservation(workshopState(), observed = false))
        assertNull(workshopObservation(workshopState(), current = false))
        for (state in listOf(workshopState().copy(view = null), workshopState().copy(advertised = false))) {
            val ui = requireNotNull(workshopObservation(state)); assertNull(ui.ingots); assertNull(ui.frame.titleTag)
            val display = homeWorkshopDisplay(ui, HomeWorkshopReadStatus.READY, true, "INGOTS")
            assertTrue(display.inventory.isEmpty()); assertFalse(display.status.contains("Checking")); assertFalse(display.status.contains("paused"))
        }
    }

    @Test fun `Workshop summary rejects wrong repository identity wrong base and malformed observations`() {
        val state = workshopState()
        assertNull(homeWorkshopObservation(state, WORKSHOP_ID.copy(wallet = "11111111111111111111111111111112"), WORKSHOP_BASE, true, true))
        assertNull(homeWorkshopObservation(state, WORKSHOP_ID, "00000000-0000-4000-8000-000000000009", true, true)?.ingots)
        assertNull(workshopObservation(state.copy(view = workshopView().copy(shardsPerIngot = 0)))?.ingots)
    }

    @Test fun `Workshop saved original remains visible without current view capability or new money admission`() {
        val command = WorkshopCommand.start(workshopView(), "saved-original", 1)
        val state = workshopState().let { it.copy(view = null, advertised = false,
            journal = it.journal.copy(operation = WorkshopOperation(command, true, null, null))) }
        // Completed original observation can be current even when no current-base view/capability is available.
        val ui = requireNotNull(workshopObservation(state))
        assertEquals("saved-original", ui.ingots?.saved?.opId); assertNull(ui.ingots?.inventory?.held)
        assertNull(ui.ingots?.inventory?.pending); assertNull(ui.frame.titleTag)
        val display = homeWorkshopDisplay(ui, HomeWorkshopReadStatus.READY, true, "COSMETICS")
        assertTrue(display.status.contains("original receipt")); assertTrue(display.inventory.isEmpty())
        assertNull(workshopObservation(state, current = false)); assertNull(workshopObservation(state, observed = false))
    }

    @Test fun `Workshop ready and multiple jobs keep observed status without inventing empty stock`() {
        val job = WorkshopJob("00000000-0000-4000-8000-000000000002", 1, "17", 1, 1,
            "2026-09-21T00:00:00.000Z", "2026-09-21T00:01:01.000Z", true, null)
        val ready = requireNotNull(workshopObservation(workshopState().copy(view = workshopView().copy(jobs = listOf(job)))))
        // WHY 08a8f35f: an observed ready job remains visible while the borrowed Home body cannot collect it.
        assertEquals("Forge Ingots ready", ready.frame.live?.text)
        assertEquals(IngotJobState.READY, ready.ingots?.job?.state)
        assertFalse(requireNotNull(ready.ingots).actionsAllowed)
        assertTrue(homeWorkshopDisplay(ready, HomeWorkshopReadStatus.READY, true, "INGOTS").status.contains("ready"))
        val running = job.copy(ready = false, readyAt = "2026-09-21T13:00:00.000Z")
        val multiple = requireNotNull(workshopObservation(workshopState().copy(view = workshopView().copy(jobs = listOf(running,
            running.copy(jobId = "00000000-0000-4000-8000-000000000004"))))))
        assertEquals("Workshop batches need attention", multiple.frame.live?.text); assertNull(multiple.ingots)
    }

    @Test fun `Workshop unsupported sibling observations delegate without inventing bench trip or cosmetic ownership`() {
        for (tab in listOf("REFINE", "EQUIPMENT", "COSMETICS")) {
            val ui = requireNotNull(workshopObservation(workshopState()))
            val display = homeWorkshopDisplay(ui, HomeWorkshopReadStatus.READY, true, tab)
            // WHY 08a8f35f: absent sibling observations state exactly what is unknown and offer no owner controls.
            val unavailable = when (tab) {
                "REFINE" -> "Refining information is unavailable. Recipes and stock have not been observed."
                "EQUIPMENT" -> "Tools information is unavailable. Equipment and trips have not been observed."
                else -> "Style information is unavailable. Owned appearances have not been observed."
            }
            assertEquals(unavailable, display.status); assertFalse(display.canOpenControls)
            assertTrue(display.inventory.isEmpty()); assertNull(ui.refine); assertNull(ui.tools); assertNull(ui.style)
        }
    }

    @Test fun `Workshop observed zero remains zero rather than unknown`() {
        val ui = requireNotNull(workshopObservation(workshopState().copy(view = workshopView().copy(
            inventory = WorkshopInventory(WORKSHOP_BASE, 0, 0), holding = WorkshopLegacyHolding(0, 0, 0, 0, 14)))))
        assertEquals(0L, ui.ingots?.inventory?.held); assertEquals(0L, ui.ingots?.inventory?.pending)
    }

    private class WorkshopReadFixture {
        val identity = HomeRouteIdentity(Any(), WORKSHOP_BASE, 2)
        var actual: HomeRouteIdentity? = identity
        var state = workshopState()
        var calls = 0
        val capture = HomeWorkshopReadCapture(identity)
        fun current() = actual == identity
        suspend fun read() = capture.refresh(::current, { state }) { calls++ }
    }

    // WHY: Mail must resolve through the existing canonical registry and preserve filter history in a FULL frame.
    @Test fun `Mail mount uses the canonical door and restores only its supported filters`() {
        assertEquals(FeatureResolution.Navigate(Destination.Mail), FeatureRegistry.canonical().resolve(FeatureId("hud.mail"), GateContext()))
        val f = SheetMountFixture(); assertTrue(f.host.canOpen(FeatureId("hud.mail"), HomeTab.KINGDOM))
        assertFalse(f.host.canOpen(FeatureId("hud.mail"), HomeTab.WORLD))
        // Hub mount (MailHub replaces HomeMailSheet): ARCHIVE is a restorable chip of the designed card, not a raw strip.
        for (filter in listOf("ALL", "REWARDS", "NEWS", "ARCHIVE")) {
            val frame = mountedHomeSheetFrame(gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.Mail, selectedTab = filter))!!
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.FULL, frame.size)
            assertEquals(filter, frame.selectedTab)
        }
        assertNull(mountedHomeSheetFrame(gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.Mail, selectedTab = "UNKNOWN")))
    }

    // WHY: a partial host without the actual Mail renderer must defer rather than consume the door.
    @Test fun `Mail navigation waits for its body callback and then opens exactly once`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false)
        assertEquals(HomeNavigationResult.DEFERRED, f.host.navigateResult(Destination.Mail, HomeTab.KINGDOM))
        val opened = mutableListOf<Destination>()
        f.host.attach(f.identity, {}, { false }, openBody = { opened += it }).reportBlocked(false)
        assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.Mail, HomeTab.KINGDOM))
        assertEquals(listOf(Destination.Mail), opened)
    }

    // WHY: the list needs an observed GET for its current owner, with no claim/archive/mark-read side effect.
    @Test fun `Mail refresh captures the existing repository list through the shared read queue only`() = runTest {
        val f = MailReadFixture(); assertTrue(f.capture.refresh(f.reads, f::current))
        assertEquals(listOf("refresh:false"), f.repository.calls)
        assertEquals(f.repository.first, f.capture.snapshot?.mailbox?.messages?.single())
        assertEquals(LoadState.Ready, f.capture.load); assertFalse(f.capture.running)
        assertEquals(0, f.repository.mutations)
    }

    // WHY: a replaced account/base/generation cannot issue an old Home owner's GET.
    @Test fun `stale Mail owner makes no repository call`() = runTest {
        val f = MailReadFixture(); f.actual = f.identity.copy(baseSelectionGeneration = 3)
        assertFalse(f.capture.refresh(f.reads, f::current)); assertTrue(f.repository.calls.isEmpty())
        assertNull(f.capture.snapshot)
    }

    // WHY: a successful response after the base changed must never be relabelled as the new owner's inbox.
    @Test fun `Mail read completing for a stale owner cannot publish its list`() = runTest {
        val f = MailReadFixture(); f.repository.afterRead = { f.actual = null }
        assertFalse(f.capture.refresh(f.reads, f::current)); assertNull(f.capture.snapshot)
        assertEquals(0, f.repository.mutations)
    }

    // WHY: a failed refresh must preserve the previously observed rows while presenting a retryable error.
    @Test fun `Mail refresh failure retains the admitted list and its error state`() = runTest {
        val f = MailReadFixture(); assertTrue(f.capture.refresh(f.reads, f::current)); val previous = f.capture.snapshot
        f.repository.afterRead = { error("offline") }
        assertFalse(f.capture.refresh(f.reads, f::current)); assertSame(previous, f.capture.snapshot)
        assertTrue(f.capture.load is LoadState.Error); assertFalse(f.capture.running)
    }

    // WHY: a completed GET without a mailbox is an error, not a permanent loading surface.
    @Test fun `Mail read without a list finishes with truthful retry state`() = runTest {
        val f = MailReadFixture(); f.repository.afterRead = { f.repository.state.value = CommunityState() }
        assertFalse(f.capture.refresh(f.reads, f::current)); assertTrue(f.capture.load is LoadState.Error)
        assertNull(f.capture.snapshot); assertFalse(f.capture.running)
    }

    // WHY: pagination must not merge an old cursor into a mailbox replaced by another existing owner.
    @Test fun `Mail more refreshes when the shared repository page changed`() = runTest {
        val f = MailReadFixture(); assertTrue(f.capture.refresh(f.reads, f::current)); f.repository.calls.clear()
        f.repository.state.value = f.repository.state.value.copy(archived = true)
        assertTrue(f.capture.more(f.reads, f::current)); assertEquals(listOf("refresh:false"), f.repository.calls)
    }

    // WHY: an unchanged current page may use exactly the repository's existing next-page GET.
    @Test fun `Mail more uses the current page once and retains both server rows`() = runTest {
        val f = MailReadFixture(); assertTrue(f.capture.refresh(f.reads, f::current)); f.repository.calls.clear()
        assertTrue(f.capture.more(f.reads, f::current)); assertEquals(listOf("more"), f.repository.calls)
        assertEquals(listOf(f.repository.first, f.repository.second), f.capture.snapshot?.mailbox?.messages)
        assertNull(f.capture.snapshot?.mailbox?.nextCursor)
    }

    // WHY: the existing detail flow receives only the exact letter observed by this owner's GET.
    @Test fun `Mail detail handoff follows an exact current letter GET and does not mark or claim it`() = runTest {
        val f = MailReadFixture(); f.capture.refresh(f.reads, f::current); f.repository.calls.clear(); var opens = 0
        assertTrue(f.capture.open(f.reads, f.repository.first.id, f::current) { opens++ })
        assertEquals(listOf("open:" + f.repository.first.id), f.repository.calls); assertEquals(1, opens)
        assertEquals(f.repository.first.id, f.repository.state.value.detail?.id); assertEquals(0, f.repository.mutations)
    }

    // WHY: a late detail response cannot navigate after the sheet lease/account has retired.
    @Test fun `Mail detail loses navigation authority when current owner changes during GET`() = runTest {
        val f = MailReadFixture(); f.capture.refresh(f.reads, f::current); var opens = 0
        f.repository.afterRead = { f.actual = f.identity.copy(baseId = "other-base") }
        assertFalse(f.capture.open(f.reads, f.repository.first.id, f::current) { opens++ }); assertEquals(0, opens)
        assertEquals(0, f.repository.mutations)
    }

    // WHY: a stale or fabricated row id cannot cause a detail read outside the captured mailbox.
    @Test fun `Mail rejects a detail id absent from the observed list`() = runTest {
        val f = MailReadFixture(); f.capture.refresh(f.reads, f::current); f.repository.calls.clear(); var opens = 0
        assertFalse(f.capture.open(f.reads, f.repository.second.id, f::current) { opens++ })
        assertTrue(f.repository.calls.isEmpty()); assertEquals(0, opens)
    }

    // WHY: stale captured data must stay hidden even when a presentation survives temporary routing lag.
    // Rewritten for the hub mount (owner: retire HomeMailSheet for the designed MailHub): MailHub keys its whole card on
    // MailScope, so an old owner's list is never drawn for a replaced session, base or generation; reading never mutates.
    @Test fun `Mail rendering hides the old owner snapshot without changing repository evidence`() = runTest {
        val f = MailReadFixture(); f.capture.refresh(f.reads, f::current); val saved = f.repository.state.value
        val owner = MailScope(f.identity.session, f.identity.baseId, f.identity.baseSelectionGeneration)
        assertFalse(mailScopeCurrent(owner, owner.copy(generation = 3)))
        assertFalse(mailScopeCurrent(owner, owner.copy(baseId = "other-base")))
        assertFalse(mailScopeCurrent(owner, MailScope(Any(), f.identity.baseId, f.identity.baseSelectionGeneration)))
        assertFalse(mailScopeCurrent(owner, null))
        assertTrue(mailScopeCurrent(owner, owner.copy()))
        assertEquals(saved, f.repository.state.value); assertEquals(0, f.repository.mutations)
    }

    // WHY: admission must be checked again after the shared queue waits for an existing request.
    @Test fun `Mail waiting in the read queue refuses after its owner retires`() = runTest {
        val f = MailReadFixture(); f.repository.state.value = CommunityState(busy = true)
        var completed = true; val job = launch { completed = f.capture.refresh(f.reads, f::current) }
        runCurrent(); assertTrue(f.capture.running); assertTrue(f.repository.calls.isEmpty())
        f.actual = null; f.repository.state.value = CommunityState(); job.join()
        assertFalse(completed); assertTrue(f.repository.calls.isEmpty()); assertNull(f.capture.snapshot)
    }

    // WHY: the accepted list-only mapper must not activate a detail/claim-all surface when repository detail exists.
    @Test fun `Mail mapper retains list-only behavior when existing recovery detail is present`() = runTest {
        val f = MailReadFixture(); f.capture.refresh(f.reads, f::current)
        val state = f.capture.snapshot!!.copy(detail = f.repository.first)
        val ui = gg.pixelkingdomwars.nativeclient.ui.sheets.hub.live.liveMailUi(state, "NEWS", LoadState.Ready)
        assertNull(ui.open); assertNull(ui.claimAll); assertEquals("NEWS", ui.filter)
        assertEquals(listOf(f.repository.first.id), ui.letters.map { it.id })
        assertEquals(0, f.repository.mutations)
    }

    // d578ce6f: keep ordinary base loading out of Mail reads, while navigation retains its live guard.
    @Test fun `base refresh during an open Mail GET preserves its ready list`() = runTest {
        val f = MailReadFixture(); var baseRefreshing = false; val lease = Any()
        val host = HomeSheetRouteHost({ f.actual }, { baseRefreshing }, {})
        host.attach(f.identity, {}, { false }, owner = lease).reportBlocked(false)
        f.repository.afterRead = { baseRefreshing = true }
        assertTrue(f.capture.refresh(f.reads) { f.actual == f.capture.identity && host.canUseReadControl(lease) })
        assertTrue(baseRefreshing); assertEquals(LoadState.Ready, f.capture.load)
        assertNotNull(f.capture.snapshot?.mailbox); assertEquals(0, f.repository.mutations)
    }

    @Test fun `Mail navigation refused during base refresh reports feedback without navigation`() {
        val f = MailReadFixture(); val lease = Any(); val reasons = mutableListOf<String>(); var navigated = 0
        val host = HomeSheetRouteHost({ f.actual }, { true }, { reasons += it })
        host.attach(f.identity, {}, { false }, owner = lease).reportBlocked(true)
        assertTrue(host.canUseReadControl(lease))
        assertFalse(host.handoffOwnedSheet(lease, {}, {}, { navigated++ }))
        assertEquals(0, navigated); assertEquals(1, reasons.size); assertTrue(reasons.single().isNotBlank())
    }

    // Rewritten for the hub mount (owner: "remove retired stuff"): the Home Mail sheet is the designed MailHub, hosted in
    // the sheet with the shared read queue, and its doors (SEE QUESTS, CHANGE, Report) stay inside the sheet host instead
    // of handing off to the old MailRoute screen. MailRoute itself now draws the same MailHub.
    @Test fun `Mail production wiring separates read admission from both guarded handoffs`() {
        val app = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        assertFalse("the old Home mail body is retired", app.contains("HomeMailSheet("))
        val branch = app.substringAfter("Destination.Mail -> gg.pixelkingdomwars.nativeclient.ui.community.MailHub(")
            .substringBefore("explain = localRouteHost::locked)")
        assertTrue(branch.contains("canRead = { localRouteHost.canUseReadControl(lease) }"))
        assertFalse(branch.contains("canRead = { localRouteHost.canUseReadControl(lease) &&"))
        assertTrue(branch.contains("hosted = true")); assertTrue(branch.contains("reads = communityReads"))
        assertTrue(branch.contains("onFeature = { feature -> openHubLink("))
        assertTrue(branch.contains("onReport = { openHub(Destination.Feedback) }"))
        assertFalse(branch.contains("navController.navigate(MailRoute)"))
        val route = app.substringAfter("composable<MailRoute>").substringBefore("composable<LeaguesRoute>")
        assertTrue(route.contains("MailHub(graph, s,")); assertFalse(route.contains("CommunityScreen("))
    }

    // Rewritten for the hub mount: currentness now lives in MailHub, which rebuilds its card for every new owner key.
    @Test fun `Mail production currentness is bound to the stored capture identity`() {
        val source = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/community/MailHub.kt").readText()
        val body = source.substringAfter("@Composable internal fun MailHub(").substringBefore("@Composable private fun MailHubContent(")
        assertTrue(body.contains("MailScope(session.session, account.selectedBaseId, account.baseSelectionGeneration)"))
        assertTrue(body.contains("key(owner)"))
        val f = MailReadFixture(); f.actual = f.identity.copy(baseSelectionGeneration = 3)
        assertNotEquals(f.actual, f.capture.identity); assertFalse(f.current())
    }

    private class MailReadFixture {
        val identity = HomeRouteIdentity(Any(), "base", 2)
        var actual: HomeRouteIdentity? = identity
        fun current() = actual == identity
        val repository = MailReadRepository()
        val reads = HomeCommunityReads(repository)
        val capture = HomeMailReadCapture(identity)
    }

    private class MailReadRepository : CommunityRepository {
        override val state = MutableStateFlow(CommunityState())
        val calls = mutableListOf<String>(); var mutations = 0
        var afterRead: suspend () -> Unit = {}
        fun letter(id: String) = gg.pixelkingdomwars.nativeclient.model.MailMessage(id, "system", "info", "News", "Server news",
            emptyList(), null, null, "2026-10-04T00:00:00Z", null, null, null, null, null)
        val first = letter("00000000-0000-4000-8000-000000000001")
        val second = letter("00000000-0000-4000-8000-000000000002")
        override suspend fun refreshMail(archived: Boolean) {
            calls += "refresh:$archived"
            state.value = state.value.copy(mailbox = gg.pixelkingdomwars.nativeclient.model.MailPage(listOf(first), first.id), archived = archived)
            afterRead()
        }
        override suspend fun moreMail() {
            calls += "more"; state.value = state.value.copy(mailbox = gg.pixelkingdomwars.nativeclient.model.MailPage(listOf(first, second), null)); afterRead()
        }
        override suspend fun openMail(id: String) { calls += "open:$id"; state.value = state.value.copy(detail = first.takeIf { it.id == id }); afterRead() }
        override fun closeMail(): Unit = mutation()
        override suspend fun markRead(): Unit = mutation()
        override suspend fun archive(): Unit = mutation()
        override suspend fun claim(mailId: String, baseId: String?): Unit = mutation()
        override suspend fun checkClaim(): Unit = mutation()
        override suspend fun retryClaim(): Unit = mutation()
        override suspend fun refreshLeagues(): Unit = error("Mail must not read leagues")
        private fun mutation(): Unit { mutations++; error("Mail host must not call a mutating or claim port") }
    }

    /** Only bodies with an actual owner may take over a legacy door; unsupported doors stay usable. */
    @Test fun `the bounded sheet host offers only the actually mounted kingdom league door`() {
        val f = SheetMountFixture()
        assertTrue(f.host.canOpen(FeatureId("hud.leagues"), HomeTab.KINGDOM))
        assertFalse(f.host.canOpen(FeatureId("profile.settings"), HomeTab.KINGDOM))
        assertFalse(f.host.canOpen(FeatureId("hud.leagues"), HomeTab.WORLD))
        assertFalse(f.host.canOpen(FeatureId("hud.leagues"), HomeTab.ARMY))
    }

    @Test fun `an unsupported body never occupies the request queue or fabricates a destination`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false)
        val requests = HomeRequests()
        // Settings is a mounted hub body since the hub mount; BattleLog still has no Home sheet body.
        val dispatcher = HomeRouteDispatcher(requests, sheetRegistry(FeatureId("profile.settings"), Destination.BattleLog()),
            { f.current?.let { HomeRouteContext(it, GateContext(baseId = it.baseId)) } }, f.host)
        assertFalse(dispatcher.openFeature(FeatureId("profile.settings")))
        assertFalse(dispatcher.openResources(FeatureId("hud.resources"), Destination.Resources()))
        assertNull(requests.pending.value)
        // A retained/foreign queue entry must also be refused at dispatch, not just at the door.
        val retained = HomeRequest.Open(FeatureId("profile.settings"), f.identity, FeatureSelection())
        requests.request(retained)
        assertEquals(HomeRouteDispatchResult.REFUSED, dispatcher.consume(retained))
        assertNull(requests.pending.value)
        assertTrue(f.opened.isEmpty())
    }

    @Test fun `a league intent waits for the mounted owner first clear observation`() {
        val f = SheetMountFixture()
        assertTrue(f.host.dispatchBlocked.value)
        assertFalse(f.host.navigate(Destination.Leagues(), HomeTab.KINGDOM))
        val mount = f.mount()
        assertTrue(f.host.dispatchBlocked.value)
        mount.reportBlocked(false)
        assertFalse(f.host.dispatchBlocked.value)
        assertTrue(f.host.navigate(Destination.Leagues("REWARDS"), HomeTab.KINGDOM))
        assertEquals(listOf(Destination.Leagues("REWARDS")), f.opened)
    }

    @Test fun `live admission is checked again before a queued league navigation acts`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false)
        f.blocked = true
        assertFalse(f.host.navigate(Destination.Leagues(), HomeTab.KINGDOM))
        assertTrue(f.opened.isEmpty())
    }

    @Test fun `replaced same-wallet identity cannot navigate with a still clear old mount`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false)
        f.current = HomeRouteIdentity(Any(), BASE, 2)
        assertFalse(f.host.navigate(Destination.Leagues(), HomeTab.KINGDOM))
        assertTrue(f.opened.isEmpty())
    }

    @Test fun `returning to the same base with another generation cannot reuse a mounted callback`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false)
        f.current = f.identity.copy(baseSelectionGeneration = 4)
        assertFalse(f.host.navigate(Destination.Leagues(), HomeTab.KINGDOM))
        assertTrue(f.opened.isEmpty())
    }

    @Test fun `replacing a mount starts blocked and ignores old reports and disposal`() {
        val f = SheetMountFixture(); val old = f.mount(); old.reportBlocked(false)
        val replacement = f.mount()
        assertTrue(f.host.dispatchBlocked.value)
        old.reportBlocked(false)
        assertTrue(f.host.dispatchBlocked.value)
        replacement.reportBlocked(false); old.close(); old.reportBlocked(true)
        assertFalse(f.host.dispatchBlocked.value)
        assertTrue(f.host.navigate(Destination.Leagues(), HomeTab.KINGDOM))
    }

    @Test fun `disposing the current mount prevents late reports from reopening it`() {
        val f = SheetMountFixture(); val mount = f.mount(); mount.reportBlocked(false)
        mount.close(); mount.reportBlocked(false)
        assertTrue(f.host.dispatchBlocked.value)
        assertFalse(f.host.navigate(Destination.Leagues(), HomeTab.KINGDOM))
    }

    @Test fun `invalid league tabs and world hosts never lose their typed parameters in fallback navigation`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false)
        assertFalse(f.host.navigate(Destination.Leagues("UNKNOWN"), HomeTab.KINGDOM))
        assertFalse(f.host.navigate(Destination.Leagues(), HomeTab.WORLD))
        // Hub mount: Settings gained a Home body, so the unmounted example is BattleLog.
        assertFalse(f.host.navigate(Destination.BattleLog(), HomeTab.KINGDOM))
        assertTrue(f.opened.isEmpty())
    }

    @Test fun `door loading busy and unknown identity never consume an uncovered scene tap`() {
        val f = SheetMountFixture(); val mount = f.mount()
        f.blocked = true
        assertFalse(f.host.beforeSceneTap())
        mount.reportBlocked(true)
        assertFalse(f.host.beforeSceneTap())
        f.current = null
        assertFalse(f.host.beforeSceneTap())
        assertEquals(0, f.sceneCloses)
    }

    @Test fun `a covered sheet consumes through exit but a review never closes the lower sheet`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false); f.covered = true
        f.review = true
        assertTrue(f.host.beforeSceneTap())
        assertEquals(0, f.sceneCloses)
        f.review = false; f.blocked = true
        assertTrue(f.host.beforeSceneTap())
        assertEquals(1, f.sceneCloses)
    }

    @Test fun `an unmounted or replaced scope cannot invoke a retained scene close callback`() {
        val f = SheetMountFixture(); val mount = f.mount(); mount.reportBlocked(false)
        f.current = null; f.presentation = null; f.covered = true
        assertTrue(f.host.beforeSceneTap())
        assertEquals(0, f.sceneCloses)
        mount.close()
        assertFalse(f.host.beforeSceneTap())
    }

    @Test fun `restoration drops unsupported parents and their children instead of drawing a placeholder`() {
        val first = gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.Leagues("LADDER"), selectedTab = "REWARDS", restored = true)
        // Hub mount: Settings gained a Home body, so the unsupported parent is BattleLog.
        val stack = gg.pixelkingdomwars.nativeclient.ui.sheets.SheetStack(listOf(first,
            gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.BattleLog()),
            gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.Leagues())))
        assertEquals(listOf(first), mountedHomeSheetStack(stack).entries)
        assertEquals("REWARDS", mountedHomeSheetFrame(first)?.selectedTab)
        assertNull(mountedHomeSheetFrame(first.copy(selectedTab = "UNKNOWN")))
    }

    @Test fun `a supported door never falls through to legacy when its identity is temporarily unknown`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false); f.current = null
        val requests = HomeRequests()
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), { null }, f.host)
        assertTrue(dispatcher.handleFeatureDoor(FeatureId("hud.leagues")))
        assertNull(requests.pending.value)
        val retained = HomeRequest.Open(FeatureId("hud.leagues"), f.identity, FeatureSelection())
        requests.request(retained)
        assertEquals(HomeRouteDispatchResult.STALE, dispatcher.consume(retained))
        assertNull(requests.pending.value)
        assertTrue(f.opened.isEmpty())
        assertEquals(listOf("This feature is waiting for your kingdom to finish loading."), f.reasons)
    }

    @Test fun `the fallback result is reserved for doors with no mounted body`() {
        val f = SheetMountFixture()
        val requests = HomeRequests()
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(),
            { HomeRouteContext(f.identity, GateContext(baseId = BASE)) }, f.host)
        assertFalse(dispatcher.handleFeatureDoor(FeatureId("profile.settings")))
        assertNull(requests.pending.value)
        assertTrue(dispatcher.handleFeatureDoor(FeatureId("hud.leagues")))
        assertEquals(FeatureId("hud.leagues"), (requests.pending.value as HomeRequest.Open).featureId)
    }

    @Test fun `painted callbacks lose their lease on replacement even within the same identity`() {
        val f = SheetMountFixture(); val old = Any(); val next = Any()
        f.host.attach(f.identity, {}, { false }, owner = old).reportBlocked(false)
        assertTrue(f.host.isCurrent(old))
        f.host.attach(f.identity, {}, { false }, owner = next).reportBlocked(false)
        assertFalse(f.host.isCurrent(old))
        assertTrue(f.host.isCurrent(next))
        f.current = f.identity.copy(baseSelectionGeneration = 3)
        assertFalse(f.host.isCurrent(next))
    }

    @Test fun `normalizing a restored history makes close and tab edits act on the painted entry`() {
        val first = gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.Leagues(), restored = true)
        // Hub mount: Settings gained a Home body, so the unsupported child is BattleLog.
        val stack = gg.pixelkingdomwars.nativeclient.ui.sheets.SheetStack(listOf(first,
            gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(Destination.BattleLog())))
        val admitted = mountedHomeSheetStack(stack)
        assertTrue(admitted.pop().isEmpty)
        assertEquals(Destination.Leagues(), admitted.updateTop(selectedTab = "LADDER").top?.destination)
        assertEquals("LADDER", admitted.updateTop(selectedTab = "LADDER").top?.selectedTab)
    }


    @Test fun `a refusing host finishes the open head and explains instead of retrying forever`() {
        val targets = listOf(FeatureTarget.Sheet(Destination.Mail),
            FeatureTarget.OwnedAction(FeatureAction.COLLECT), FeatureTarget.Scene(FeatureScene.BATTLE),
            FeatureTarget.WorldHandoff("seeker", Destination.IslandRewards("seeker")),
            FeatureTarget.HomeHandoff(Destination.FocusBuilding("lodge", Destination.Lodge())))
        for (target in targets) {
            val f = Fixture(target); val request = f.enqueue()
            f.requests.request(HomeRequest.BuildMenu); f.host.accept = false
            assertEquals(HomeRouteDispatchResult.REFUSED, f.dispatcher.consume(request))
            assertEquals(HomeRequest.BuildMenu, f.requests.pending.value)
            assertEquals(listOf("This feature is not available in the current Home view."), f.host.lockedReasons)
            assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
            assertEquals(2, f.host.callCount) // one refusal, one explanation; no replay
        }
    }

    @Test fun `painted read controls use review and identity rather than door admission`() {
        val f = SheetMountFixture(); val lease = Any()
        f.host.attach(f.identity, {}, { false }, owner = lease).reportBlocked(false)
        f.blocked = true
        assertTrue(f.host.canUseReadControl(lease))
        f.review = true
        assertFalse(f.host.canUseReadControl(lease))
        f.review = false; f.current = null
        assertFalse(f.host.canUseReadControl(lease))
    }

    @Test fun `the composed Home root survives identity absence replacement and restoration`() = runTest {
        val identity = mutableStateOf<HomeRouteIdentity?>(null)
        val clock = BroadcastFrameClock()
        val recomposer = Recomposer(coroutineContext + clock)
        val composition = Composition(object : AbstractApplier<Unit>(Unit) {
            override fun insertTopDown(index: Int, instance: Unit) = Unit
            override fun insertBottomUp(index: Int, instance: Unit) = Unit
            override fun remove(index: Int, count: Int) = Unit
            override fun move(from: Int, to: Int, count: Int) = Unit
            override fun onClear() = Unit
        }, recomposer)
        val runner = launch(clock) { recomposer.runRecomposeAndApplyChanges() }
        val seen = mutableListOf<Any>(); var disposals = 0
        composition.setContent {
            StableHomeLayer(identity.value, hooks = { HomeLayerHooks(homeCovered = true, resourcesBlocked = it.baseSelectionGeneration == 2L) }) {
                val root = remember { Any() }
                SideEffect { seen += root }
                DisposableEffect(Unit) { onDispose { disposals++ } }
            }
        }
        try {
            val owner = Any()
            val first = HomeRouteIdentity(owner, BASE, 2)
            for ((index, next) in listOf(first, null, first, first.copy(baseSelectionGeneration = 3)).withIndex()) {
                identity.value = next
                Snapshot.sendApplyNotifications(); runCurrent(); clock.sendFrame(index.toLong()); runCurrent()
                assertEquals(0, disposals)
                assertTrue(seen.size >= index + 2)
                assertTrue(seen.all { it === seen.first() })
            }
        } finally { composition.dispose(); recomposer.cancel(); runner.join() }
        assertEquals(1, disposals)
    }

    @Test fun `presentation scope survives model lag but ends on owner or base generation replacement`() {
        val f = ContextFixture()
        val identity = homePresentationIdentity(f.account, f.session, f.session)
        assertNotNull(identity)
        assertNull(homeRouteContext(f.account, f.session, f.session, f.home, f.kingdom.copy(home = BaseState())))
        assertEquals(identity, homePresentationIdentity(f.account, f.session, f.session))
        assertNull(homePresentationIdentity(f.account, f.session, null))
        assertNotEquals(identity, homePresentationIdentity(f.account.copy(baseSelectionGeneration = 3), f.session, f.session))
    }

    @Test fun `HomeShell uses the stable root scene hook read queue and explicit tab expiry seams`() {
        val app = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
        // Hub mount: the old league body (and its KDoc marker) is retired; HomeShell ends at the shared read queue.
        val shell = app.substringAfter("@Composable private fun HomeShell(").substringBefore("/** The two Home resume reads use one queue")
        assertEquals(1, Regex("StableHomeLayer\\(").findAll(shell).count())
        assertEquals(0, Regex("\\blayer\\(").findAll(shell).count())
        assertTrue(shell.contains("onBeforeSceneTap = localRouteHost::beforeSceneTap"))
        assertTrue(shell.contains("optionalRead { communityReads.refreshMail() }"))
        // Hub mount: the designed LeaguesHub replaces HomeLeagueSheet and keeps the same Home read queue.
        assertFalse(shell.contains("HomeLeagueSheet("))
        assertTrue(shell.contains("ui.community.LeaguesHub(graph, session,")); assertTrue(shell.contains("reads = communityReads, explain = localRouteHost::locked)"))
        assertTrue(shell.contains("localRouteHost.canUseReadControl(lease)"))
        assertTrue(shell.contains("localRouteHost.closeOwnedSheet(lease, clearSelection = kingdom::clearSelection)"))
        assertTrue(shell.contains("{ currentPresentationIdentity.value() }"))
        val scaffold = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeScaffold.kt").readText()
        assertTrue(scaffold.contains("requests.selectHomeTab(next) { tab = it }"))
        assertTrue(scaffold.contains("content(tab, ::selectTab,"))
    }

    @Test fun `mail hydration and league capture serialize through the same repository`() = runTest {
        val f = LeagueReadFixture(); val release = CompletableDeferred<Unit>()
        f.repository.onMail = { release.await() }
        val mail = launch { f.reads.refreshMail() }; runCurrent()
        val league = launch { f.capture.refresh(f.reads) { f.current } }; runCurrent()
        assertEquals(listOf("mail"), f.repository.calls)
        assertNull(f.capture.captured)
        release.complete(Unit); mail.join(); league.join()
        assertEquals(listOf("mail", "league"), f.repository.calls)
        assertEquals(f.identity, f.capture.captured)
        assertEquals(LoadState.Ready, f.capture.load)
    }

    @Test fun `league capture waits for another community owner without colliding`() = runTest {
        val f = LeagueReadFixture()
        f.repository.state.value = f.repository.state.value.copy(busy = true)
        val read = launch { f.capture.refresh(f.reads) { f.current } }; runCurrent()
        assertTrue(f.repository.calls.isEmpty())
        f.repository.state.value = f.repository.state.value.copy(busy = false)
        read.join()
        assertEquals(listOf("league"), f.repository.calls)
    }

    @Test fun `reload keeps the completed captured scope during Loading and on a failed read`() = runTest {
        val f = LeagueReadFixture(); f.capture.refresh(f.reads) { f.current }
        val captured = f.capture.captured; val release = CompletableDeferred<Unit>()
        f.repository.onLeague = { release.await(); error("offline") }
        val reload = launch { f.capture.refresh(f.reads) { f.current } }; runCurrent()
        assertSame(captured, f.capture.captured)
        assertEquals(LoadState.Loading, f.capture.load)
        release.complete(Unit); reload.join()
        assertSame(captured, f.capture.captured)
        assertTrue(f.capture.load is LoadState.Error)
    }

    @Test fun `scope captured before GET cannot be admitted after a generation changes during GET`() = runTest {
        val f = LeagueReadFixture(); val release = CompletableDeferred<Unit>()
        f.repository.onLeague = { release.await() }
        val read = launch { f.capture.refresh(f.reads) { f.current } }; runCurrent()
        assertEquals(listOf("league"), f.repository.calls)
        f.current = false
        release.complete(Unit); read.join()
        assertNull(f.capture.captured)
        assertNotEquals(LoadState.Ready, f.capture.load)
    }

    @Test fun `a stale scope waiting behind hydration never begins its GET`() = runTest {
        val f = LeagueReadFixture(); val release = CompletableDeferred<Unit>()
        f.repository.onMail = { release.await() }
        val mail = launch { f.reads.refreshMail() }; runCurrent()
        val league = launch { f.capture.refresh(f.reads) { f.current } }; runCurrent()
        f.current = false; release.complete(Unit); mail.join(); league.join()
        assertEquals(listOf("mail"), f.repository.calls)
        assertNull(f.capture.captured)
    }

    @Test fun `a completed GET with the wrong repository generation never supplies capture`() = runTest {
        val f = LeagueReadFixture(); f.repository.observedGeneration = 9
        f.capture.refresh(f.reads) { f.current }
        assertNull(f.capture.captured)
        assertNotEquals(LoadState.Ready, f.capture.load)
    }

    private class LeagueReadFixture {
        val identity = HomeRouteIdentity(Any(), BASE, 2)
        var current = true
        val repository = FakeCommunity()
        val reads = HomeCommunityReads(repository)
        val capture = HomeLeagueReadCapture(identity)
    }

    private class FakeCommunity : CommunityRepository {
        override val state = MutableStateFlow(CommunityState())
        val calls = mutableListOf<String>()
        var observedGeneration = 2L
        var onMail: suspend () -> Unit = {}
        var onLeague: suspend () -> Unit = {}
        private suspend fun read(name: String, block: suspend () -> Unit) {
            check(!state.value.busy) { "A community request is already in progress" }
            calls += name; state.value = state.value.copy(busy = true)
            try { block() } finally { state.value = state.value.copy(busy = false) }
        }
        override suspend fun refreshMail(archived: Boolean) = read("mail", onMail)
        override suspend fun refreshLeagues() = read("league") {
            onLeague()
            state.value = state.value.copy(leagueBaseId = BASE, leagueSelectionGeneration = observedGeneration)
        }
        override suspend fun moreMail(): Unit = error("unused")
        override suspend fun openMail(id: String): Unit = error("unused")
        override fun closeMail(): Unit = error("unused")
        override suspend fun markRead(): Unit = error("unused")
        override suspend fun archive(): Unit = error("unused")
        override suspend fun claim(mailId: String, baseId: String?): Unit = error("unused")
        override suspend fun checkClaim(): Unit = error("unused")
        override suspend fun retryClaim(): Unit = error("unused")
    }


    @Test fun `X and Back close a full sheet and clear stale selection while strict context is null`() {
        for (door in listOf("X", "Back")) {
            val f = SheetMountFixture(); val lease = Any()
            var stack = gg.pixelkingdomwars.nativeclient.ui.sheets.SheetStack()
            var selectedBuilding: String? = "stale-building"
            f.host.attach(f.identity, openLeague = { stack = stack.push(it) }, closeSceneSheet = { false },
                owner = lease, sceneCovered = { !stack.isEmpty }).reportBlocked(false)
            assertTrue(f.host.navigate(Destination.Leagues(), HomeTab.KINGDOM))
            assertEquals(gg.pixelkingdomwars.nativeclient.ui.model.SheetSize.FULL, mountedHomeSheetFrame(requireNotNull(stack.top))?.size)
            f.current = null
            assertTrue(f.host.isOwner(lease))
            assertFalse(f.host.canUseReadControl(lease))
            val popped = gg.pixelkingdomwars.nativeclient.ui.sheets.dispatchSheetClose(
                sheetVisible = !stack.isEmpty, onDismissNested = { false }, onPop = {
                    assertTrue(f.host.closeOwnedSheet(lease, clearSelection = { selectedBuilding = null }) {
                        stack = mountedHomeSheetStack(stack).pop()
                    })
                })
            assertTrue(door, popped)
            assertTrue(door, stack.isEmpty)
            assertNull(door, selectedBuilding)
        }
    }

    @Test fun `retired or replaced presentation leases cannot pop history or clear selection`() {
        val f = SheetMountFixture(); val old = Any(); val next = Any()
        f.host.attach(f.identity, {}, { false }, owner = old).reportBlocked(false)
        f.host.attach(f.identity, {}, { false }, owner = next).reportBlocked(false)
        var pops = 0; var clears = 0
        assertFalse(f.host.closeOwnedSheet(old, { clears++ }) { pops++ })
        f.presentation = f.identity.copy(baseSelectionGeneration = 3)
        assertFalse(f.host.closeOwnedSheet(next, { clears++ }) { pops++ })
        assertEquals(0, pops); assertEquals(0, clears)
    }

    @Test fun `closing a retained sheet cannot clear a higher priority active review`() {
        val f = SheetMountFixture(); val lease = Any()
        f.host.attach(f.identity, {}, { false }, owner = lease).reportBlocked(false)
        f.current = null; f.review = true
        var pops = 0; var clears = 0
        assertTrue(f.host.closeOwnedSheet(lease, { clears++ }) { pops++ })
        assertEquals(1, pops); assertEquals(0, clears)
    }

    @Test fun `a Half scene close uses the retained presentation lease during strict model lag`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false)
        f.current = null; f.covered = true
        assertTrue(f.host.beforeSceneTap())
        assertEquals(1, f.sceneCloses)
    }

    @Test fun `a live blocker after the published clear snapshot defers without refusal or replay`() {
        val f = SheetMountFixture(); f.mount().reportBlocked(false)
        val requests = HomeRequests()
        val dispatcher = HomeRouteDispatcher(requests, sheetRegistry(),
            { HomeRouteContext(f.identity, GateContext(baseId = BASE)) }, f.host)
        assertTrue(dispatcher.openFeature(FeatureId("hud.leagues")))
        val request = requests.pending.value as HomeRequest.Open
        requests.request(HomeRequest.BuildMenu)
        f.blocked = true // owner changed after the last SideEffect publication
        assertFalse(f.host.dispatchBlocked.value)
        assertEquals(HomeRouteDispatchResult.DEFERRED, dispatcher.consume(request))
        assertSame(request, requests.pending.value)
        // WHY (rewritten 2026-10-11, owner report on the Seeker, code 34): this asserted no reason at all. Leagues is a HUD door,
        // and a HUD door deferred with no word looked dead to the player; it now says it is waiting. Still no refusal: the
        // same head is kept and opens exactly once below.
        assertTrue(f.opened.isEmpty())
        assertEquals(listOf("Leagues is waiting for the current review or read to finish."), f.reasons)
        f.blocked = false
        assertEquals(HomeRouteDispatchResult.DISPATCHED, dispatcher.consume(request))
        assertEquals(listOf(Destination.Leagues()), f.opened)
        assertEquals(HomeRequest.BuildMenu, requests.pending.value)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, dispatcher.consume(request))
    }

    @Test fun `navigation outcomes distinguish missing or changing owners from structural refusal`() {
        val f = SheetMountFixture()
        assertEquals(HomeNavigationResult.DEFERRED, f.host.navigateResult(Destination.Leagues(), HomeTab.KINGDOM))
        val mount = f.mount()
        assertEquals(HomeNavigationResult.DEFERRED, f.host.navigateResult(Destination.Leagues(), HomeTab.KINGDOM))
        mount.reportBlocked(false); f.current = null
        assertEquals(HomeNavigationResult.DEFERRED, f.host.navigateResult(Destination.Leagues(), HomeTab.KINGDOM))
        // Hub mount: Settings gained a Home body; BattleLog is the structurally unsupported destination.
        assertEquals(HomeNavigationResult.REFUSED, f.host.navigateResult(Destination.BattleLog(), HomeTab.KINGDOM))
        assertEquals(HomeNavigationResult.REFUSED, f.host.navigateResult(Destination.Leagues("UNKNOWN"), HomeTab.KINGDOM))
        assertEquals(HomeNavigationResult.REFUSED, f.host.navigateResult(Destination.Leagues(), HomeTab.WORLD))
        assertTrue(f.opened.isEmpty())
    }

    private fun sheetRegistry(id: FeatureId = FeatureId("hud.leagues"), destination: Destination = Destination.Leagues()) =
        FeatureRegistry.of(listOf(Feature(id, "OPEN", HostKind.HUD, "fixture", FeatureSurface.HUD_SLOT,
            Gate.Open, FeatureIcon(FeatureIconState.SHAPE_CONTRACT, "shape:arrow"), FeatureTarget.Sheet(destination), 0, Visibility.ALWAYS)))

    private class SheetMountFixture {
        val identity = HomeRouteIdentity(Any(), BASE, 2)
        var current: HomeRouteIdentity? = identity
        var presentation: HomeRouteIdentity? = identity
        var blocked = false
        var covered = false
        var review = false
        val reasons = mutableListOf<String>()
        val opened = mutableListOf<Destination.Leagues>()
        var sceneCloses = 0
        val host = HomeSheetRouteHost({ current }, { blocked }, { reasons += it }, { review }, { presentation })
        fun mount() = host.attach(identity, openLeague = { opened += it }, closeSceneSheet = { sceneCloses++; true },
            sceneCovered = { covered })
    }

    @Test fun `the same live account owner keeps one opaque sheet scope across remounts`() {
        val owner = ContextFixture().session
        val first = homeRouteSessionId(owner)
        assertEquals(first, homeRouteSessionId(owner))
        assertEquals(first, java.util.UUID.fromString(first).toString())
        assertFalse(first.contains(owner.wallet))
        assertFalse(first.contains(owner.origin))
    }

    @Test fun `replacing a same-wallet account owner never restores its previous sheet scope`() {
        val old = ContextFixture().session
        val replacement = AccountSession(old.wallet, old.origin, testToken())
        assertNotSame(old, replacement)
        assertNotEquals(homeRouteSessionId(old), homeRouteSessionId(replacement))
    }

    @Test fun `review admission stays unknown until every required current owner reports clear`() {
        val gate = HomeRouteReviewGate(setOf("kingdom", "sheet"))
        assertTrue(gate.blocked.value)
        val kingdom = gate.register("kingdom")
        kingdom.report(false)
        assertTrue(gate.blocked.value)
        val sheet = gate.register("sheet")
        assertTrue(gate.blocked.value)
        sheet.report(false)
        assertFalse(gate.blocked.value)
    }

    @Test fun `closing one of overlapping owner reviews cannot release the other`() {
        val gate = HomeRouteReviewGate(setOf("kingdom", "sheet"))
        val kingdom = gate.register("kingdom")
        val sheet = gate.register("sheet")
        kingdom.report(true)
        sheet.report(true)
        kingdom.report(false)
        assertTrue(gate.blocked.value)
        sheet.report(false)
        assertFalse(gate.blocked.value)
        kingdom.report(true)
        assertTrue(gate.blocked.value)
    }

    @Test fun `replacing an owner registration blocks until its own first clear report`() {
        val gate = HomeRouteReviewGate(setOf("kingdom"))
        val old = gate.register("kingdom")
        old.report(false)
        assertFalse(gate.blocked.value)
        val replacement = gate.register("kingdom")
        assertTrue(gate.blocked.value)
        old.report(false)
        assertTrue(gate.blocked.value)
        replacement.report(false)
        assertFalse(gate.blocked.value)
    }

    @Test fun `a retired disposer or blocked report cannot overwrite its replacement`() {
        val gate = HomeRouteReviewGate(setOf("kingdom"))
        val old = gate.register("kingdom")
        val replacement = gate.register("kingdom")
        replacement.report(false)
        old.report(true)
        old.close()
        assertFalse(gate.blocked.value)
    }

    @Test fun `disposed current owner remains unknown despite a delayed clear callback`() {
        val gate = HomeRouteReviewGate(setOf("kingdom"))
        val current = gate.register("kingdom")
        current.report(false)
        current.close()
        assertTrue(gate.blocked.value)
        current.report(false)
        assertTrue(gate.blocked.value)
        val remounted = gate.register("kingdom")
        remounted.report(false)
        assertFalse(gate.blocked.value)
    }

    @Test fun `closing the admission scope permanently invalidates all its callbacks`() {
        val gate = HomeRouteReviewGate(setOf("kingdom"))
        val owner = gate.register("kingdom")
        owner.report(false)
        gate.close()
        assertTrue(gate.blocked.value)
        owner.report(false)
        owner.close()
        assertTrue(gate.blocked.value)
    }

    @Test fun `a fresh scope cannot inherit an old scope clear observation`() {
        val oldScope = HomeRouteReviewGate(setOf("kingdom"))
        val old = oldScope.register("kingdom")
        old.report(false)
        val currentScope = HomeRouteReviewGate(setOf("kingdom"))
        val current = currentScope.register("kingdom")
        old.close()
        old.report(false)
        assertTrue(currentScope.blocked.value)
        current.report(false)
        assertFalse(currentScope.blocked.value)
    }

    @Test fun `owner review defers the exact request until the owner releases it`() {
        val f = Fixture()
        val request = f.enqueue()
        f.host.dispatchBlocked.value = true
        assertEquals(HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
        assertSame(request, f.requests.pending.value)
        assertEquals(0, f.host.callCount)
        f.host.dispatchBlocked.value = false
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertNull(f.requests.pending.value)
        assertEquals(1, f.host.callCount)
    }

    @Test fun `owner review prevents even a locked notification from replacing the current review`() {
        val f = Fixture(gate = Gate.OwnerFact("ready"))
        val request = f.enqueue()
        f.host.dispatchBlocked.value = true
        assertEquals(HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
        assertEquals(0, f.host.callCount)
        f.host.dispatchBlocked.value = false
        assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(request))
        assertEquals(1, f.host.lockedReasons.size)
    }

    @Test fun `stale identity is discarded without effects even while the owner review blocks dispatch`() {
        val f = Fixture()
        val request = f.enqueue()
        f.host.dispatchBlocked.value = true
        f.current = null
        assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
        assertNull(f.requests.pending.value)
        assertEquals(0, f.host.callCount)
    }

    @Test fun `navigation preserves the destination and requested Home host`() {
        val destination = Destination.Lodge("SEND", "advanced", "route-7")
        for (tab in listOf(HomeTab.KINGDOM, HomeTab.WORLD)) {
            val f = Fixture(FeatureTarget.Sheet(destination))
            assertTrue(f.dispatcher.openFeature(ID, tab))
            assertEquals(tab, f.head.homeTab)
            assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.head))
            assertEquals(listOf(destination to tab), f.host.navigations)
            assertEquals(1, f.host.callCount)
            assertNull(f.requests.pending.value)
        }
    }

    @Test fun `owned action is sent once to its existing owner`() {
        val f = Fixture(FeatureTarget.OwnedAction(FeatureAction.FINISH_NOW))
        val request = f.enqueue()
        assertTrue(f.host.actions.isEmpty())
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(FeatureAction.FINISH_NOW), f.host.actions)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
        assertEquals(1, f.host.callCount)
    }

    @Test fun `scene resolution is never converted into a sheet`() {
        val f = Fixture(FeatureTarget.Scene(FeatureScene.SCOUT))
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.enqueue()))
        assertEquals(listOf(FeatureScene.SCOUT), f.host.scenes)
        assertTrue(f.host.navigations.isEmpty())
    }

    @Test fun `world handoff preserves island and typed followup`() {
        val then = Destination.IslandSpot("seeker", 7, "bid")
        val f = Fixture(FeatureTarget.WorldHandoff("seeker", then))
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.enqueue()))
        assertEquals(listOf("seeker" to then), f.host.worldHandoffs)
        assertEquals(1, f.host.callCount)
    }

    @Test fun `Home handoff preserves nested destination parameters`() {
        val destination = Destination.FocusBuilding("lodge", Destination.Lodge("SEND", "advanced", "route-19"))
        val f = Fixture(FeatureTarget.HomeHandoff(destination))
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.enqueue()))
        assertEquals(listOf(destination), f.host.homeHandoffs)
        assertTrue(f.host.navigations.isEmpty())
    }

    @Test fun `locked gate reports its reason and advances the queue without opening anything`() {
        val f = Fixture(gate = Gate.OwnerFact("ready"))
        f.setFacts(GateFact.Denied("Wait for your current order"))
        val request = f.enqueue()
        f.requests.request(HomeRequest.BuildMenu)
        assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(request))
        assertEquals(listOf("Wait for your current order"), f.host.lockedReasons)
        assertEquals(1, f.host.callCount)
        assertEquals(HomeRequest.BuildMenu, f.requests.pending.value)
    }

    @Test fun `hidden gate drains its request silently`() {
        val f = Fixture(gate = Gate.OwnerFact("ready"), visibility = Visibility.WHEN_AVAILABLE)
        f.setFacts(GateFact.Denied("Not on this server"))
        assertEquals(HomeRouteDispatchResult.HIDDEN, f.dispatcher.consume(f.enqueue()))
        assertEquals(0, f.host.callCount)
        assertNull(f.requests.pending.value)
    }

    @Test fun `capture does not resolve gates and consumption observes their latest value`() {
        val f = Fixture(gate = Gate.OwnerFact("ready"))
        f.setFacts(GateFact.Denied("Still loading"))
        val request = f.enqueue()
        assertEquals(0, f.host.callCount)
        f.setFacts(GateFact.Allowed)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(1, f.host.navigations.size)
    }

    @Test fun `a gate revoked after enqueue blocks consumption`() {
        val f = Fixture(gate = Gate.OwnerFact("ready"))
        f.setFacts(GateFact.Allowed)
        val request = f.enqueue()
        f.setFacts(GateFact.Denied("Your order is being checked"))
        assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(request))
        assertEquals(listOf("Your order is being checked"), f.host.lockedReasons)
        assertTrue(f.host.navigations.isEmpty())
    }

    @Test fun `unknown feature fails through the registry instead of inventing a route`() {
        val f = Fixture()
        assertTrue(f.dispatcher.openFeature(FeatureId("missing.feature")))
        assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(f.head))
        assertEquals(1, f.host.lockedReasons.size)
        assertTrue(f.host.navigations.isEmpty())
    }

    @Test fun `capture requires a current context whose hydrated base matches its identity`() {
        val f = Fixture()
        f.current = null
        assertFalse(f.dispatcher.openFeature(ID))
        assertFalse(f.dispatcher.openResources(ID, Destination.Resources("shards")))
        f.current = HomeRouteContext(f.identity, GateContext(baseId = "other-base"))
        assertFalse(f.dispatcher.openFeature(ID))
        assertFalse(f.dispatcher.openResources(ID, Destination.Resources("shards")))
        assertNull(f.requests.pending.value)
        assertEquals(0, f.host.callCount)
    }

    @Test fun `missing context at consumption discards only the stale head`() {
        val f = Fixture()
        val request = f.enqueue()
        f.requests.request(HomeRequest.Training)
        f.current = null
        assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
        assertEquals(HomeRequest.Training, f.requests.pending.value)
        assertEquals(0, f.host.callCount)
    }

    @Test fun `equal but distinct session objects cannot consume an old session request`() {
        data class EqualSession(val label: String)
        val old = EqualSession("same-wallet")
        val replacement = EqualSession("same-wallet")
        assertEquals(old, replacement)
        assertNotSame(old, replacement)
        val f = Fixture()
        f.current = HomeRouteContext(HomeRouteIdentity(old, BASE, 2), f.context.gates)
        val request = f.enqueue()
        f.current = HomeRouteContext(HomeRouteIdentity(replacement, BASE, 2), f.context.gates)
        assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
        assertEquals(0, f.host.callCount)
        assertNull(f.requests.pending.value)
    }

    @Test fun `returning to the same base with a new selection generation rejects the old request`() {
        val f = Fixture()
        val request = f.enqueue()
        f.current = HomeRouteContext(HomeRouteIdentity(f.session, BASE, 4), GateContext(baseId = BASE))
        assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
        assertEquals(0, f.host.callCount)
    }

    @Test fun `changing selected base rejects a queued request even when the new base is hydrated`() {
        val f = Fixture()
        val request = f.enqueue()
        f.current = HomeRouteContext(HomeRouteIdentity(f.session, "base-b", 2), GateContext(baseId = "base-b"))
        assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
        assertEquals(0, f.host.callCount)
    }

    @Test fun `hydrated base mismatch after enqueue is stale`() {
        val f = Fixture()
        val request = f.enqueue()
        f.current = HomeRouteContext(f.identity, GateContext(baseId = "old-base"))
        assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
        assertEquals(0, f.host.callCount)
    }

    @Test fun `changed or cleared building selection cannot redirect an old selection request`() {
        val original = FeatureSelection(building = BuildingSelection(BASE, "building-a", "workshop"))
        for (next in listOf(FeatureSelection(), FeatureSelection(building = BuildingSelection(BASE, "building-b", "workshop")))) {
            val f = Fixture(FeatureTarget.SelectedBuildingInfo)
            f.setSelection(original)
            val request = f.enqueue()
            assertEquals(original, request.selection)
            assertEquals(original, f.context.gates.selection)
            assertEquals(0, f.host.callCount)
            f.setSelection(next)
            assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
            assertEquals(0, f.host.callCount)
        }
    }

    @Test fun `map selection and selected route are also checked before consumption`() {
        val original = FeatureSelection(spot = IslandSpotSelection("seeker-island", 2),
            tile = MapTileSelection(17, true), routeId = "route-a")
        val changed = listOf(original.copy(spot = IslandSpotSelection("seeker-island", 3)),
            original.copy(tile = MapTileSelection(18, true)), original.copy(routeId = "route-b"))
        for (selection in changed) {
            val f = Fixture()
            f.setSelection(original)
            val request = f.enqueue()
            f.setSelection(selection)
            assertEquals(HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
            assertEquals(0, f.host.callCount)
        }
    }

    @Test fun `nonhead consumption neither resolves nor removes another request`() {
        val f = Fixture()
        f.requests.request(HomeRequest.BuildMenu)
        assertTrue(f.dispatcher.openFeature(ID))
        val queued = HomeRequest.Open(ID, f.identity, f.context.gates.selection)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(queued))
        assertEquals(HomeRequest.BuildMenu, f.requests.pending.value)
        assertEquals(0, f.host.callCount)
        f.requests.consume(HomeRequest.BuildMenu)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.head))
    }

    @Test fun `each owner can defer without losing the head and later accept it exactly once`() {
        val targets = listOf(FeatureTarget.Sheet(Destination.Mail),
            FeatureTarget.OwnedAction(FeatureAction.COLLECT), FeatureTarget.Scene(FeatureScene.BATTLE),
            FeatureTarget.WorldHandoff("seeker", Destination.IslandRewards("seeker")),
            FeatureTarget.HomeHandoff(Destination.FocusBuilding("lodge", Destination.Lodge())))
        for (target in targets) {
            val f = Fixture(target)
            val request = f.enqueue()
            f.requests.request(HomeRequest.BuildMenu)
            f.host.dispatchBlocked.value = true
            assertEquals(HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
            assertEquals(request, f.requests.pending.value)
            assertEquals(0, f.host.callCount)
            f.host.dispatchBlocked.value = false
            assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
            assertEquals(HomeRequest.BuildMenu, f.requests.pending.value)
            assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
            assertEquals(1, f.host.callCount)
        }
    }

    @Test fun `a reentrant host callback cannot dispatch its current head twice`() {
        val f = Fixture()
        val request = f.enqueue()
        var nestedResult: HomeRouteDispatchResult? = null
        f.host.onNavigate = { nestedResult = f.dispatcher.consume(request) }
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertNotNull(nestedResult)
        assertNotEquals(HomeRouteDispatchResult.DISPATCHED, nestedResult)
        assertEquals(1, f.host.callCount)
        assertNull(f.requests.pending.value)
    }

    @Test fun `resource override preserves exact focus only after Resources admission`() {
        for (resource in listOf<String?>(null, "shards", "material:iron-7")) {
            val f = Fixture(FeatureTarget.Sheet(Destination.Resources()))
            val destination = Destination.Resources(resource)
            assertTrue(f.dispatcher.openResources(ID, destination, HomeTab.WORLD))
            assertEquals(destination, f.head.resources)
            assertEquals(0, f.host.callCount)
            assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.head))
            assertEquals(listOf(destination to HomeTab.WORLD), f.host.navigations)
        }
    }

    @Test fun `resource override cannot convert another admitted target into a drawer`() {
        val targets = listOf(FeatureTarget.Sheet(Destination.Market("BUY", "materials")),
            FeatureTarget.OwnedAction(FeatureAction.COLLECT), FeatureTarget.Scene(FeatureScene.SCOUT),
            FeatureTarget.WorldHandoff("seeker"),
            FeatureTarget.HomeHandoff(Destination.FocusBuilding("lodge")))
        for (target in targets) {
            val f = Fixture(target)
            assertTrue(f.dispatcher.openResources(ID, Destination.Resources("shards")))
            assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(f.head))
            assertEquals(1, f.host.lockedReasons.size)
            assertTrue(f.host.lockedReasons.single().isNotBlank())
            assertEquals(1, f.host.callCount)
            assertNull(f.requests.pending.value)
        }
    }

    @Test fun `aggregate destination parameters survive navigation without legacy flattening`() {
        val destinations = listOf(Destination.Berth("SERVICE", "repair"), Destination.Market("BUY", "materials"),
            Destination.GoldForge("CLAIM", "resource-mining"), Destination.Heroes("vex", "SKILLS"),
            Destination.Leagues("REWARDS"), Destination.Workshop("AWNINGS"))
        for (destination in destinations) {
            val f = Fixture(FeatureTarget.Sheet(destination))
            assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.enqueue()))
            assertEquals(listOf(destination to HomeTab.KINGDOM), f.host.navigations)
        }
    }

    @Test fun `a host failure advances its ambiguous request and never replays the effect`() {
        val f = Fixture()
        val request = f.enqueue()
        f.requests.request(HomeRequest.BuildMenu)
        val failure = IllegalStateException("Host failed after accepting the request")
        f.host.onNavigate = { throw failure }
        assertSame(failure, assertThrows(IllegalStateException::class.java) { f.dispatcher.consume(request) })
        assertEquals(HomeRequest.BuildMenu, f.requests.pending.value)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
        assertEquals(1, f.host.callCount)
        f.requests.consume(HomeRequest.BuildMenu)
        f.host.onNavigate = null
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(f.enqueue()))
        assertEquals(2, f.host.callCount)
    }

    @Test fun `building door accessor reads current selection and refuses mismatched bases`() {
        val f = Fixture()
        val first = BuildingSelection(BASE, "workshop-a", "workshop")
        val second = BuildingSelection(BASE, "workshop-b", "workshop")
        f.setSelection(FeatureSelection(building = first))
        assertEquals(first, f.dispatcher.currentSelection())
        f.setSelection(FeatureSelection(building = second))
        assertEquals(second, f.dispatcher.currentSelection())
        f.setSelection(FeatureSelection(building = BuildingSelection("old-base", "workshop-b", "workshop")))
        assertNull(f.dispatcher.currentSelection())
        f.current = null
        assertNull(f.dispatcher.currentSelection())
        assertNull(f.requests.pending.value)
        assertEquals(0, f.host.callCount)
    }

    @Test fun `context producer binds current session base generation and selected building`() {
        val f = ContextFixture()
        val context = requireNotNull(f.read())
        assertSame(f.session, context.identity.session)
        assertEquals(BASE, context.identity.baseId)
        assertEquals(2L, context.identity.baseSelectionGeneration)
        assertEquals(4, context.gates.keepLevel)
        assertEquals(BuildingSelection(BASE, "workshop-a", "workshop"), context.gates.selection.building)
        assertEquals(BuildingGateState(2, true), context.gates.buildings["workshop"])
        assertEquals(GateFact.Unknown, context.gates.walletLinked)
        assertTrue(context.gates.serverFeatures.isEmpty())
        assertTrue(context.gates.ownerFacts.isEmpty())
        assertTrue(context.gates.history.isEmpty())
        assertNull(context.gates.buildings["lodge"])
    }

    @Test fun `context producer refuses either stale session reference including same wallet replacement`() {
        val f = ContextFixture()
        val replacement = AccountSession(f.session.wallet, f.session.origin, f.session.token)
        assertNull(f.read(account = f.account.copy(session = replacement)))
        assertNull(f.read(currentSession = replacement))
        assertNull(f.read(account = f.account.copy(session = null)))
        assertNull(f.read(currentSession = null))
    }

    @Test fun `context producer requires both hydrated views to agree with account base and generation`() {
        val f = ContextFixture()
        assertNull(f.read(account = f.account.copy(selectedBaseId = null)))
        assertNull(f.read(account = f.account.copy(selectedBaseId = "base-b")))
        assertNull(f.read(account = f.account.copy(baseSelectionGeneration = 3)))
        assertNull(f.read(home = BaseState()))
        assertNull(f.read(home = f.home.copy(base = f.snapshot.copy(baseId = "base-b"))))
        assertNull(f.read(kingdom = f.kingdom.copy(selectedBaseId = "base-b")))
        assertNull(f.read(kingdom = f.kingdom.copy(baseGeneration = 1)))
        assertNull(f.read(kingdom = f.kingdom.copy(home = BaseState())))
        assertNull(f.read(kingdom = f.kingdom.copy(home = f.home.copy(base = f.snapshot.copy(baseId = "base-b")))))
    }

    @Test fun `context producer refuses selected building missing from either current view or with another type`() {
        val f = ContextFixture()
        assertNull(f.read(kingdom = f.kingdom.copy(local = KingdomLocal(selectedBuildingId = "missing"))))
        assertNull(f.read(home = f.home.copy(base = f.snapshot.copy(buildings = emptyList()))))
        val wrongType = f.snapshot.copy(buildings = listOf(f.building.copy(type = "lodge")))
        assertNull(f.read(kingdom = f.kingdom.copy(home = f.home.copy(base = wrongType))))
        val duplicate = f.snapshot.copy(buildings = listOf(f.building, f.building.copy(type = "lodge")))
        assertNull(f.read(home = f.home.copy(base = duplicate)))
    }

    @Test fun `context producer prefers highest completed instance over a higher unfinished building`() {
        val f = ContextFixture()
        val rows = listOf(f.building, f.building.copy(id = "workshop-b", level = 4),
            f.building.copy(id = "workshop-c", level = 9, underConstruction = true))
        val home = f.home.copy(base = f.snapshot.copy(buildings = rows))
        val context = requireNotNull(f.read(home = home, kingdom = f.kingdom.copy(home = home)))
        assertEquals(BuildingGateState(4, true), context.gates.buildings["workshop"])
        assertEquals(GateResult.Pass, Gate.BuildingCompleted("workshop", 4).check(context.gates))
        assertTrue(Gate.BuildingCompleted("workshop", 5).check(context.gates) is GateResult.Locked)
    }

    @Test fun `context producer leaves malformed and absent facts unknown while retaining known unfinished presence`() {
        val f = ContextFixture()
        val rows = listOf(f.building.copy(id = "unfinished", type = "lodge", level = 3, underConstruction = true),
            f.building.copy(id = "invalid", type = "market", level = -1),
            f.building.copy(id = "blank-type", type = ""), f.building.copy(id = "", type = "berth"))
        val home = f.home.copy(base = f.snapshot.copy(player = PlayerSummary(keepLevel = -1), buildings = rows))
        val kingdom = f.kingdom.copy(home = home, local = KingdomLocal())
        val context = requireNotNull(f.read(home = home, kingdom = kingdom))
        assertNull(context.gates.keepLevel)
        assertEquals(mapOf("lodge" to BuildingGateState(3, false)), context.gates.buildings)
        assertEquals(GateResult.Locked("Checking availability", unknown = true), Gate.BuildingCompleted("market").check(context.gates))
        assertNull(context.gates.selection.building)
    }

    @Test fun `context producer permits no selection without inventing map route or building selection`() {
        val f = ContextFixture()
        val context = requireNotNull(f.read(kingdom = f.kingdom.copy(local = KingdomLocal())))
        assertEquals(FeatureSelection(), context.gates.selection)
        assertEquals(0, requireNotNull(f.read(home = f.home.copy(base = f.snapshot.copy(player = PlayerSummary(keepLevel = 0))))).gates.keepLevel)
    }

    private class ContextFixture {
        val session = AccountSession("fixture-wallet", "https://localhost:18443", testToken())
        val account = AccountState(session = session, selectedBaseId = BASE, baseSelectionGeneration = 2)
        val building = Building("workshop-a", "workshop", 2, 0, 0)
        val snapshot = BaseSnapshot(baseId = BASE, visualContext = null, player = PlayerSummary(keepLevel = 4),
            energy = null, armyStatus = null, claim = null, buildings = listOf(building), obstacles = emptyList(),
            jobs = emptyList(), freeBuilders = 0, raw = JsonObject(emptyMap()))
        val home = BaseState(base = snapshot)
        val kingdom = KingdomUiState(home = home, local = KingdomLocal(selectedBuildingId = building.id),
            selectedBaseId = BASE, baseGeneration = 2)
        fun read(account: AccountState = this.account, currentSession: AccountSession? = session,
            home: BaseState = this.home, kingdom: KingdomUiState = this.kingdom): HomeRouteContext? =
            homeRouteContext(account, session, currentSession, home, kingdom)
    }

    private class Fixture(target: FeatureTarget = FeatureTarget.Sheet(Destination.Mail), gate: Gate = Gate.Open,
        visibility: Visibility = Visibility.ALWAYS) {
        val session = Any()
        val identity = HomeRouteIdentity(session, BASE, 2)
        var current: HomeRouteContext? = HomeRouteContext(identity, GateContext(baseId = BASE))
        val context: HomeRouteContext get() = requireNotNull(current)
        val requests = HomeRequests()
        val host = RecordingHost()
        val registry = FeatureRegistry.of(listOf(Feature(ID, "OPEN", HostKind.HUD, "fixture", FeatureSurface.HUD_SLOT,
            gate, FeatureIcon(FeatureIconState.SHAPE_CONTRACT, "shape:arrow"), target, 0, visibility)))
        val dispatcher = HomeRouteDispatcher(requests, registry, { current }, host)
        val head: HomeRequest.Open get() = requests.pending.value as HomeRequest.Open

        fun enqueue(): HomeRequest.Open {
            assertTrue(dispatcher.openFeature(ID))
            return head
        }

        fun setFacts(fact: GateFact) {
            current = HomeRouteContext(context.identity, GateContext(baseId = context.identity.baseId,
                ownerFacts = mapOf("ready" to fact), selection = context.gates.selection))
        }

        fun setSelection(selection: FeatureSelection) {
            current = HomeRouteContext(context.identity, GateContext(baseId = context.identity.baseId, selection = selection))
        }
    }

    private class RecordingHost : HomeRouteHost {
        override val dispatchBlocked = MutableStateFlow(false)
        var accept = true
        var onNavigate: (() -> Unit)? = null
        val navigations = mutableListOf<Pair<Destination, HomeTab>>()
        val actions = mutableListOf<FeatureAction>()
        val scenes = mutableListOf<FeatureScene>()
        val worldHandoffs = mutableListOf<Pair<String, Destination?>>()
        val homeHandoffs = mutableListOf<Destination.FocusBuilding>()
        val lockedReasons = mutableListOf<String>()
        val callCount: Int get() = navigations.size + actions.size + scenes.size + worldHandoffs.size + homeHandoffs.size + lockedReasons.size
        override fun navigate(destination: Destination, tab: HomeTab): Boolean {
            navigations += destination to tab
            onNavigate?.invoke()
            return accept
        }
        override fun action(action: FeatureAction): Boolean { actions += action; return accept }
        override fun scene(scene: FeatureScene): Boolean { scenes += scene; return accept }
        override fun worldHandoff(island: String, then: Destination?): Boolean { worldHandoffs += island to then; return accept }
        override fun homeHandoff(destination: Destination.FocusBuilding): Boolean { homeHandoffs += destination; return accept }
        override fun locked(reason: String) { lockedReasons += reason }
    }

    companion object {
        private val WORKSHOP_ID = WorkshopIdentity("https://example.invalid", "devnet", "11111111111111111111111111111111")
        private const val WORKSHOP_BASE = "00000000-0000-4000-8000-000000000001"
        // Deliberately synthetic validated protocol data, not client-owned game constants.
        private fun workshopView() = WorkshopView(WorkshopFeatures(WorkshopFeature(1, 1, 1)), true, 1, 1, 17,
            WorkshopBatch(3, 9), 61, WorkshopInventory(WORKSHOP_BASE, 1, 1),
            WorkshopAllowance(1, "free_wallet", "2026-09-21T00:00:00.000Z", "2026-09-22T00:00:00.000Z", 2,
                WorkshopDaily(6, 2, 4), WorkshopHolding(3, 2, 0, 0, 14, 9)),
            6, 1, WorkshopLegacyHolding(1, 0, 0, 1, 14), 2, emptyList(), "2026-09-21T12:00:00.000Z")
        private fun workshopState() = WorkshopState(WorkshopJournal(1, WORKSHOP_ID, 0, null, emptyList()),
            view = workshopView(), shards = "999", advertised = true)
        private fun workshopObservation(state: WorkshopState, current: Boolean = true, observed: Boolean = true) =
            homeWorkshopObservation(state, WORKSHOP_ID, WORKSHOP_BASE, current, observed)
        private const val BASE = "base-a"
        private val ID = FeatureId("fixture.open")
    }
}
