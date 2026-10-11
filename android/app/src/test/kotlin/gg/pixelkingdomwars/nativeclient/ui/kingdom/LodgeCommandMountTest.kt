package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.AccountState
import gg.pixelkingdomwars.nativeclient.model.BaseJob
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.testToken
import gg.pixelkingdomwars.nativeclient.ui.nav.homeRouteContext
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.features.*
import gg.pixelkingdomwars.nativeclient.ui.home.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** 5162b8bf: real registry, producer, request admission and mounted Home body; no money port. */
class LodgeCommandMountTest {
    @Test fun `completed Lodge presents the four designed commands with Explore primary`() {
        val f = Fixture()
        val bar = f.bar()
        assertEquals(listOf("building.info", "lodge.passport", "building.upgrade", "lodge.expedition"), bar.commands.map { it.id.value })
        assertEquals(listOf("INFO", "PASSPORT", "UPGRADE", "EXPLORE"), bar.commands.map { it.caption })
        assertEquals(listOf(FeatureId("lodge.expedition")), bar.commands.filter { it.primary }.map { it.id })
        assertEquals("ui:realm-passport", bar.commands[1].icon)
        assertNull(bar.commands[1].price)
        assertEquals(CommandState.ENABLED, bar.commands[1].state)
    }

    @Test fun `missing Passport capability stays visible and locked with its owner reason`() {
        val f = Fixture()
        f.current = f.context(passport = GateFact.Denied("Passport is not open on this server"))
        val passport = f.bar().commands.single { it.id.value == "lodge.passport" }
        assertEquals(CommandState.LOCKED, passport.state)
        assertEquals("Passport is not open on this server", passport.reason)
        f.tap("lodge.passport")
        assertNull(f.requests.pending.value)
        assertTrue(f.opened.isEmpty())
        assertEquals(listOf("Passport is not open on this server"), f.reasons)
    }

    @Test fun `Passport opens the designed Lodge tab once with the rendered instance`() {
        val f = Fixture(); f.tap("lodge.passport")
        val request = requireNotNull(f.requests.pending.value as? HomeRequest.Open)
        assertEquals(f.selection, request.selection.building)
        assertTrue(f.opened.isEmpty())
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(Destination.Lodge("PASSPORT")), f.opened)
        assertNull(f.requests.pending.value)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
        assertEquals(1, f.opened.size)
    }

    @Test fun `Passport capability revoked after enqueue refuses the retained command`() {
        val f = Fixture(); f.tap("lodge.passport")
        val request = requireNotNull(f.requests.pending.value as? HomeRequest.Open)
        f.current = f.context(passport = GateFact.Denied("Passport is paused"))
        assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(request))
        assertTrue(f.opened.isEmpty())
        assertEquals(listOf("Passport is paused"), f.reasons)
    }

    @Test fun `unfinished Lodge exposes neither Passport nor Explore`() {
        for (underConstruction in listOf(true, false)) {
            val f = Fixture(level = if (underConstruction) 1 else 0, underConstruction = underConstruction)
            assertEquals(listOf("building.info"), f.bar(upgrade = false).commands.map { it.id.value })
        }
    }

    @Test fun `Explore is enabled without a vehicle or Passport capability`() {
        val f = Fixture(); f.current = f.context(passport = GateFact.Unknown)
        val explore = f.bar().commands.single { it.id.value == "lodge.expedition" }
        assertEquals(CommandState.ENABLED, explore.state)
        assertTrue(explore.primary)
        f.tap("lodge.expedition")
        val request = requireNotNull(f.requests.pending.value as? HomeRequest.Open)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(Destination.Lodge()), f.opened)
    }

    @Test fun `Passport never borrows a stale base or another Lodge instance`() {
        for (selection in listOf(BuildingSelection("old", "lodge-a", "lodge"), BuildingSelection("base-a", "other", "lodge"))) {
            val f = Fixture(); f.dispatcher.openBuildingDoor(FeatureId("lodge.passport"), selection)
            assertNull(f.requests.pending.value)
            assertTrue(f.opened.isEmpty())
            assertEquals(listOf("Select the current building before opening its controls."), f.reasons)
        }
    }

    @Test fun `Passport navigation waits for the current Home review owner`() {
        val f = Fixture(); f.tap("lodge.passport")
        val request = requireNotNull(f.requests.pending.value as? HomeRequest.Open)
        f.review = true
        assertEquals(HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
        assertSame(request, f.requests.pending.value)
        assertTrue(f.opened.isEmpty())
    }

    @Test fun `Home publishes job facts only for the selected Lodge and both Lodge doors stay usable during its job`() {
        val session = AccountSession("fixture-wallet", "https://localhost:18443", testToken())
        val account = AccountState(session = session, selectedBaseId = "base-a", baseSelectionGeneration = 2)
        for (type in listOf("lodge", "workshop", "harvester", "berth")) for (running in listOf(false, true)) {
            val building = Building("selected", type, 2, 0, 0)
            val jobs = if (running) listOf(BaseJob("job", "upgrade", buildingId = building.id)) else emptyList()
            val home = BaseState(base = BaseSnapshot("base-a", null, PlayerSummary(keepLevel = 4), null, null, null,
                listOf(building), emptyList(), jobs, 0, JsonObject(emptyMap())))
            val kingdom = KingdomUiState(home = home, local = KingdomLocal(selectedBuildingId = building.id),
                selectedBaseId = "base-a", baseGeneration = 2)
            val context = requireNotNull(homeRouteContext(account, session, session, home, kingdom))
            if (type == "lodge") assertEquals(if (running) GateFact.Allowed else GateFact.Denied("No building job"), context.gates.ownerFacts["building.jobRunning"])
            else assertTrue(context.gates.ownerFacts.isEmpty())
        }
        val f = Fixture(); f.current = f.context(job = GateFact.Allowed)
        val doors = f.bar().commands.filter { it.id.value in setOf("lodge.passport", "lodge.expedition") }
        assertEquals(2, doors.size); assertTrue(doors.all { it.state == CommandState.ENABLED })
    }

    private class Fixture(level: Int = 1, underConstruction: Boolean = false) {
        val identity = HomeRouteIdentity(Any(), "base-a", 2)
        val building = Building("lodge-a", "lodge", level, 0, 0, underConstruction = underConstruction)
        val selection = BuildingSelection(identity.baseId, building.id, building.type)
        var current: HomeRouteContext? = context()
        val requests = HomeRequests()
        val opened = mutableListOf<Destination>()
        val reasons = mutableListOf<String>()
        var review = false
        val host = HomeSheetRouteHost({ current?.identity }, { false }, { reasons += it }, bodyReady = { true }, bodyReviewBlocked = { review })
        val mount = host.attach(identity, {}, { false }, openBody = { opened += it }).also { it.reportBlocked(false) }
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), { current }, host)
        val commands = phaseEBuildingCommands(dispatcher)
        fun context(passport: GateFact = GateFact.Allowed, job: GateFact = GateFact.Denied("No building job")) = HomeRouteContext(identity, GateContext(baseId = identity.baseId,
            buildings = mapOf("lodge" to BuildingGateState(building.level, building.level > 0 && !building.underConstruction)),
            serverFeatures = mapOf("phaseE.passport" to passport), ownerFacts = mapOf("building.jobRunning" to job),
            selection = FeatureSelection(building = selection)))
        fun bar(upgrade: Boolean = true) = buildingCommandBar(KingdomUiState(home = BaseState(base = BaseSnapshot(identity.baseId, null,
            PlayerSummary(keepLevel = 1), null, null, null, listOf(building), emptyList(), emptyList(), 0, JsonObject(emptyMap()))),
            local = KingdomLocal(selectedBuildingId = building.id)), building,
            BuildingGates(null, building.level, 2, null, null, null, null, null, true, upgrade, null), false, 0L, commands)
        fun tap(id: String) = routeBuildingCommand(FeatureId(id), bar(),
            BuildingCommandRoutes({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}), commands, selection)
    }
}
