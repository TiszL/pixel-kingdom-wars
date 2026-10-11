package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.ui.features.*
import gg.pixelkingdomwars.nativeclient.ui.home.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** Real command adapter, canonical registry, request queue and mounted host; no service mutation port. */
class PhaseEWorkshopEntryTest {
    private val doors = mapOf("workshop" to "workshop.craft", "lodge" to "lodge.expedition",
        "berth" to "berth.fleet", "harvester" to "harvester.harvest")

    @Test fun `a completed service building offers its entry when the server permits the service`() {
        for ((type, feature) in doors) {
            val f = Fixture(type)
            val command = f.bar().commands.single { it.id == FeatureId(feature) }
            assertEquals(CommandState.ENABLED, command.state)
            assertNull(command.price)
            assertEquals(if (type == "lodge") listOf(BuildingCommandIds.INFO, FeatureId("lodge.passport"), FeatureId(feature))
                else listOf(BuildingCommandIds.INFO, FeatureId(feature)), f.bar().commands.map { it.id })
            if (type == "lodge") {
                // This fixture has no Upgrade offer and no Passport capability; the record door remains visible.
                val passport = f.bar().commands.single { it.id == FeatureId("lodge.passport") }
                assertEquals(CommandState.LOCKED, passport.state); assertEquals("Checking availability", passport.reason)
                assertEquals("PASSPORT", passport.caption); assertEquals("ui:realm-passport", passport.icon)
            }
            if (type == "workshop") {
                assertEquals("CRAFT", command.caption)
                assertEquals("ui:workshop-menu", command.icon)
            }
        }
    }

    @Test fun `unfinished and level zero service instances do not offer their entry`() {
        for (type in doors.keys) for (unfinished in listOf(true, false)) {
            val f = Fixture(type, level = if (unfinished) 1 else 0, underConstruction = unfinished)
            assertEquals(listOf(BuildingCommandIds.INFO), f.bar().commands.map { it.id })
        }
    }

    @Test fun `completed Workshop command opens the existing destination exactly once`() {
        val f = Fixture()
        f.tap()
        assertTrue(f.opened.isEmpty()) // Enqueue is not navigation or a service action.
        val request = f.head()
        assertEquals(f.selection, request.selection.building)
        assertEquals(HomeRouteDispatchResult.DISPATCHED, f.dispatcher.consume(request))
        assertEquals(listOf(Destination.Workshop()), f.opened)
        assertNull(f.requests.pending.value)
        assertEquals(HomeRouteDispatchResult.NOT_HEAD, f.dispatcher.consume(request))
        assertEquals(1, f.opened.size)
    }

    @Test fun `Workshop tap refuses stale rendered base instance or feature host`() {
        for (stale in listOf("base", "instance", "type", "feature")) {
            val f = Fixture()
            val selected = when (stale) {
                "base" -> f.selection.copy(baseId = "old-base")
                "instance" -> f.selection.copy(buildingId = "old-workshop")
                "type" -> f.selection.copy(type = "lodge")
                else -> f.selection
            }
            f.dispatcher.openBuildingDoor(FeatureId(if (stale == "feature") "lodge.expedition" else "workshop.craft"), selected)
            assertNull(stale, f.requests.pending.value)
            assertTrue(stale, f.opened.isEmpty())
            assertEquals(stale, 1, f.reasons.size)
        }
    }

    @Test fun `Workshop queued entry rechecks session base generation and selection`() {
        for (changed in listOf("session", "base", "generation", "selection", "missing")) {
            val f = Fixture(); f.tap(); val request = f.head()
            f.current = when (changed) {
                "session" -> f.context(identity = f.identity.copy(session = Any()))
                "base" -> f.context(identity = f.identity.copy(baseId = "other-base"))
                "generation" -> f.context(identity = f.identity.copy(baseSelectionGeneration = 3))
                "selection" -> f.context(selection = f.selection.copy(buildingId = "other-workshop"))
                else -> null
            }
            assertEquals(changed, HomeRouteDispatchResult.STALE, f.dispatcher.consume(request))
            assertTrue(changed, f.opened.isEmpty())
        }
    }

    @Test fun `Workshop entry retains current admission body review readiness and mount guards`() {
        for (blocked in listOf("admission", "body-review", "body-not-ready", "mount")) {
            val f = Fixture(); f.tap(); val request = f.head()
            when (blocked) {
                "admission" -> f.admissionBlocked = true
                "body-review" -> f.bodyReviewBlocked = true
                "body-not-ready" -> f.bodyReady = false
                else -> f.mount.close()
            }
            assertEquals(blocked, HomeRouteDispatchResult.DEFERRED, f.dispatcher.consume(request))
            assertTrue(blocked, f.opened.isEmpty())
            assertSame(request, f.requests.pending.value)
        }
    }

    @Test fun `Workshop completion lost after enqueue locks the existing destination`() {
        val f = Fixture(); f.tap(); val request = f.head()
        f.current = f.context(complete = false)
        assertEquals(HomeRouteDispatchResult.LOCKED, f.dispatcher.consume(request))
        assertTrue(f.opened.isEmpty())
        assertEquals(listOf("Complete the required building first"), f.reasons)
    }

    @Test fun `Harvester permission still locks its visible control without hiding the other service doors`() {
        for ((type, feature) in doors) {
            val f = Fixture(type)
            f.current = f.context(harvester = GateFact.Denied("Server unavailable"))
            val command = f.bar().commands.single { it.id == FeatureId(feature) }
            assertEquals(if (type == "harvester") CommandState.LOCKED else CommandState.ENABLED, command.state)
            if (type == "harvester") assertEquals("Server unavailable", command.reason)
        }
    }

    private class Fixture(type: String = "workshop", level: Int = 1, underConstruction: Boolean = false) {
        val identity = HomeRouteIdentity(Any(), "base-a", 2)
        val building = Building("selected-$type", type, level, 0, 0, underConstruction = underConstruction)
        val selection = BuildingSelection(identity.baseId, building.id, type)
        var current: HomeRouteContext? = context()
        val requests = HomeRequests()
        val opened = mutableListOf<Destination>()
        val reasons = mutableListOf<String>()
        var admissionBlocked = false
        var bodyReviewBlocked = false
        var bodyReady = true
        val host = HomeSheetRouteHost({ current?.identity }, { admissionBlocked }, { reasons += it },
            bodyReady = { bodyReady }, bodyReviewBlocked = { bodyReviewBlocked })
        val mount = host.attach(identity, {}, { false }, openBody = { opened += it }).also { it.reportBlocked(false) }
        val dispatcher = HomeRouteDispatcher(requests, FeatureRegistry.canonical(), { current }, host)
        val commands = phaseEBuildingCommands(dispatcher)
        fun context(identity: HomeRouteIdentity = this.identity, selection: BuildingSelection = this.selection,
            complete: Boolean = building.level > 0 && !building.underConstruction,
            harvester: GateFact = GateFact.Allowed) = HomeRouteContext(identity, GateContext(baseId = identity.baseId,
                buildings = mapOf(building.type to BuildingGateState(building.level, complete)),
                serverFeatures = mapOf("phaseE.harvesters" to harvester), selection = FeatureSelection(building = selection)))
        fun bar() = buildingCommandBar(KingdomUiState(home = BaseState(base = BaseSnapshot(identity.baseId, null,
            PlayerSummary(keepLevel = 1), null, null, null, listOf(building), emptyList(), emptyList(), 0, JsonObject(emptyMap()))),
            local = KingdomLocal(selectedBuildingId = building.id)), building,
            BuildingGates(null, building.level, 2, null, null, null, null, null, true, false, null), false, 0L, commands)
        fun tap() = routeBuildingCommand(FeatureId("workshop.craft"), bar(),
            BuildingCommandRoutes({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}), commands, selection)
        fun head() = requireNotNull(requests.pending.value as? HomeRequest.Open)
    }
}
