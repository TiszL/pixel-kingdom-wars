package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.economy.*
import gg.pixelkingdomwars.nativeclient.ui.features.*
import gg.pixelkingdomwars.nativeclient.ui.kingdom.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.*
import org.junit.Test

/** fc7a61fa: Home TRADE borrows the one KEEP owner. Authored before its mount; Cedar3 executes. */
class MarketHomeEntryTest {
    private class Door {
        val id = FeatureId("market.trade")
        val selection = BuildingSelection("base", "market-1", "market")
        val identity = HomeRouteIdentity(Any(), "base", 4)
        val registry = FeatureRegistry.canonical()
        val requests = HomeRequests()
        var context: HomeRouteContext? = HomeRouteContext(identity, GateContext(baseId = "base",
            buildings = mapOf("market" to BuildingGateState(1, true)),
            selection = FeatureSelection(building = selection)))
        val blocked = MutableStateFlow(false)
        var accepts = true
        var opened = 0
        val reasons = mutableListOf<String>()
        val host = object : HomeRouteHost {
            override val dispatchBlocked = blocked
            override fun canOpen(id: FeatureId, tab: HomeTab) = false
            override fun openLegacyFeature(id: FeatureId): Boolean {
                assertEquals(FeatureId("market.trade"), id)
                if (accepts) opened++
                return accepts
            }
            override fun navigate(destination: Destination, tab: HomeTab) = false
            override fun action(action: FeatureAction) = false
            override fun scene(scene: FeatureScene) = false
            override fun worldHandoff(island: String, then: Destination?) = false
            override fun homeHandoff(destination: Destination.FocusBuilding) = false
            override fun locked(reason: String) { reasons += reason }
        }
        val dispatcher = HomeRouteDispatcher(requests, registry, { context }, host)
        fun tap() = dispatcher.openBuildingDoor(id, selection)
    }

    @Test fun `canonical TRADE retains the default Market destination without a SOL section`() {
        val f = Door()
        val resolution = f.registry.resolve(f.id, f.context!!.gates) as FeatureResolution.Navigate
        assertEquals(Destination.Market(), resolution.destination)
        val market = resolution.destination as Destination.Market
        assertNull(market.section)
        assertEquals("BUY", market.tab)
    }

    @Test fun `Market producer has its own mounted helper and canonical feature`() {
        assertTrue(homeMountedMarketBuildingType("market"))
        assertFalse(homeMountedMarketBuildingType("keep"))
        assertFalse(homeMountedMarketBuildingType(null))
        assertEquals(FeatureId("market.trade"), phaseEBuildingFeature("market"))
        assertEquals(setOf(FeatureId("market.trade")), phaseEBuildingFeatures("market"))
        assertFalse("The four-group helper retains its old scope", homeMountedBuildingType("market"))
    }

    @Test fun `real selected Market projection adds enabled navigation TRADE without payment facts`() {
        val f = Door()
        val building = Building("market-1", "market", 1, 0, 0)
        val bar = mergePhaseEBuildingCommands(CommandBarUi(building.id, emptyList()), building,
            f.selection, phaseEBuildingCommands(f.dispatcher))
        val row = bar.commands.single()
        assertEquals(f.id, row.id); assertEquals("TRADE", row.caption)
        assertEquals("ui:market-menu", row.icon); assertNull(row.price)
        assertEquals(CommandState.ENABLED, row.state)
        assertTrue(f.context!!.gates.serverFeatures.isEmpty())
    }

    @Test fun `unfinished selected Market cannot expose TRADE even with another completed Market`() {
        val f = Door()
        for (building in listOf(Building("market-1", "market", 0, 0, 0),
            Building("market-1", "market", 1, 0, 0, underConstruction = true))) {
            val bar = mergePhaseEBuildingCommands(CommandBarUi(building.id, emptyList()), building,
                f.selection, phaseEBuildingCommands(f.dispatcher))
            assertTrue(bar.commands.isEmpty())
        }
    }

    @Test fun `admitted selected Market opens its existing owner with no invented Home sheet request`() {
        val f = Door(); f.tap()
        assertEquals(1, f.opened); assertNull(f.requests.pending.value); assertTrue(f.reasons.isEmpty())
    }

    @Test fun `stale selection and absent context explain without opening a replacement owner`() {
        for (selection in listOf(BuildingSelection("old-base", "market-1", "market"),
            BuildingSelection("base", "other-market", "market"), BuildingSelection("base", "market-1", "keep"))) {
            val f = Door(); f.dispatcher.openBuildingDoor(f.id, selection)
            assertEquals(0, f.opened); assertEquals(1, f.reasons.size)
        }
        val f = Door(); f.context = null; f.tap()
        assertEquals(0, f.opened); assertEquals(1, f.reasons.size)
    }

    @Test fun `Market cannot open through a current selection of another building type`() {
        val f = Door()
        val wrong = BuildingSelection("base", "market-1", "workshop")
        f.context = HomeRouteContext(f.identity, GateContext(baseId = "base",
            buildings = mapOf("market" to BuildingGateState(1, true)), selection = FeatureSelection(building = wrong)))
        f.dispatcher.openBuildingDoor(f.id, wrong)
        assertEquals(0, f.opened); assertTrue(f.reasons.single().contains("selected building"))
    }

    @Test fun `canonical missing building denial never reaches KEEP owner`() {
        val f = Door()
        f.context = HomeRouteContext(f.identity, GateContext(baseId = "base",
            buildings = emptyMap(), selection = FeatureSelection(building = f.selection)))
        f.tap(); assertEquals(0, f.opened); assertEquals(1, f.reasons.size)
    }

    @Test fun `published admission or private review blocker refuses Market without owner side effects`() {
        val f = Door(); f.blocked.value = true; f.tap()
        assertEquals(0, f.opened); assertEquals(1, f.reasons.size); assertNull(f.requests.pending.value)
    }

    @Test fun `owner live refusal explains and leaves all pending requests untouched`() {
        val f = Door(); f.accepts = false; f.tap()
        assertEquals(0, f.opened); assertTrue(f.reasons.single().isNotBlank()); assertNull(f.requests.pending.value)
    }

    @Test fun `KEEP opening shares fleet identity lifecycle and battle admission`() {
        val session = Any(); val content = Any()
        val captured = FleetCommandScopeIdentity(session, 4, content)
        var current = captured; var eligible = true; var opened = 0
        val lifetime = FleetPresentationLifetime()
        val opening = FleetCommandOpening(captured, lifetime, { current }, { eligible }) { opened++ }
        current = captured.copy(baseGeneration = 5)
        assertFalse(opening.attempt(FleetCommandDestination.KEEP_MARKET))
        current = captured; eligible = false
        assertFalse(opening.attempt(FleetCommandDestination.KEEP_MARKET))
        eligible = true; assertTrue(opening.attempt(FleetCommandDestination.KEEP_MARKET))
        lifetime.retire(); assertFalse(opening.attempt(FleetCommandDestination.KEEP_MARKET))
        assertEquals(1, opened)
    }

    @Test fun `one hoisted KEEP registration retains original recovery history and read driver`() {
        val registration = source("ui/phasee/KeepEquipmentMarketRegistration.kt")
        val bases = source("ui/phasee/PhaseERegistration.kt")
        val fleet = source("ui/economy/HomeFleetCommandPane.kt")
        assertFalse(bases.contains("KeepEquipmentMarketRegistration("))
        assertEquals(1, Regex("KeepEquipmentMarketRegistration\\(graph, session, wallet\\)").findAll(fleet).count())
        assertTrue(fleet.contains("opening.attempt(FleetCommandDestination.KEEP_MARKET)"))
        assertTrue(registration.contains("return FleetCommandOwner(FleetCommandDestination.KEEP_MARKET"))
        assertTrue(registration.contains("openHistory = openHistory"))
        assertTrue(registration.contains("PhaseEReceiptHistoryScreen(\"MARKET RECEIPTS\""))
        assertTrue(registration.contains("KeepMarketHomeBody(model,account.selectedBaseId"))
        assertTrue(registration.contains("onHistory=openHistory"))
        assertEquals(1, Regex("model\\?\\.foreground\\(\\)").findAll(registration).count())
        assertTrue(registration.contains("if(ownerCurrent() && admit())"))
        assertTrue(registration.contains("Market controls are no longer current. Open the Market again."))
    }

    @Test fun `Home Market handoff preserves live base review route and exact selected building guards`() {
        val app = source("ui/nav/PkwApp.kt")
        val legacy = app.substringAfter("val legacyFeatureOpen =").substringBefore("val localRouteHost =")
        val market = legacy.substringAfter("\"market.trade\" -> {").substringBefore("\"berth.fleet\"")
        assertTrue(legacy.contains("routeAdmissionBlocked.value() || bodyReviewBlocked.value() || currentRouteIdentity.value() == null"))
        assertTrue(market.contains("FleetCommandDestination.KEEP_MARKET"))
        assertTrue(market.contains("selection?.type == \"market\""))
        assertTrue(market.contains("it.id == selection.id"))
        assertTrue(market.contains("it.type == \"market\" && it.level > 0 && !it.underConstruction"))
        assertTrue(market.contains("owner.open()"))
        assertFalse(market.contains("MarketRoute"))
        assertTrue(app.contains("homeMountedMarketBuildingType(kingdomAudio.selectedBuilding?.type)"))
    }

    private fun source(path: String) = java.io.File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
}
