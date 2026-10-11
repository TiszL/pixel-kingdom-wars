package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionArchive
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionCommand
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionOperation
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionProof
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionRefusal
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionRequest
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeLockedVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSendMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.Calls
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LodgeLocalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageFx
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyagePolicyFacts
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.lodgeSheetActions
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.lodgeSheetUi
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Lodge host's doors (send.png, send-advanced.png, send-locked.png, collect.png). Why it matters: SEND AGAIN is the
 * one-tap loop the collect moment sells, so it must land on the same island and vehicle in the route-first frame; the
 * CRAFTED chips and the Berth gate must follow the server and the catalogue, never a guess; a resource tile or a
 * departure line that says nothing true, or promises a time the client did not read, breaks the player's trust.
 */
class HomeLodgeDoorsTest {
    private val fx = VoyageFx
    private val fallback = "Choose an island to see what it brings home."

    /** A kingdom with the starter boat and a docked Cargo Cutter T2 whose Glasswake trip is back (READY, not collected). */
    private val back = fx.expedition("exp-1", "inst-cut", "glasswake-1", "2030-01-01T10:00:00.000Z", "2030-01-01T13:20:00.000Z")
    private fun kingdom(records: List<VehicleRecord> = listOf(back)) = fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(),
        vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)),
            fx.routes("inst-cut", fx.preview("glasswake-1", "elderwood", "heartwood_logs", "home")), pending = records))
    private fun lockedKingdom() = fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
        starterFleet = fx.starterFleet(installation = null), buildings = fx.buildingsNoBerth)

    @Test fun `send again reopens the route first view with the same island and vehicle`() {
        val input = kingdom()
        val trip = lodgeSheetUi(input, LodgeLocalState()).trips.trips.single { it.state == TripState.READY }
        val local = homeLodgeRepeatLocal(trip, LodgeLocalState(tab = LodgeSheetUi.TAB_TRIPS, pickerOpen = true,
            expandedTripId = trip.tripId, starterRouteId = "coastal_survey"))
        assertEquals(LodgeSheetUi.TAB_SEND, local.tab)
        assertFalse("the island picker never covers the repeated island", local.pickerOpen)
        assertNull(local.expandedTripId)
        assertEquals("glasswake-1", local.routeId)
        assertEquals("inst-cut", local.installationId)
        assertNull("an island trip drops an earlier starter route", local.starterRouteId)
        val ui = lodgeSheetUi(input, local)
        assertEquals("send.png shows, not CHOOSE AN ISLAND", LodgeSheetUi.TAB_SEND, ui.panelKey)
        val send = requireNotNull(ui.send)
        assertEquals("glasswake-1", send.selectedRouteId)
        assertEquals("inst-cut", send.selectedInstallationId)
        assertNull("an island trip never falls back to the starter's coast loop", send.starterRoutes)
    }

    @Test fun `send again for a starter trip keeps its starter route and never an island`() {
        val starter = VehicleUi(VehicleFamily.STARTER, null, "inst-starter", "berth-1", VehicleStatus.DOCKED, null, null, null, 0)
        val trip = TripUi("exp-s", starter, null, "long_survey", 1f, null, TripState.COLLECTED, emptyList(), null, title = "Long Survey")
        val local = homeLodgeRepeatLocal(trip, LodgeLocalState(routeId = "glasswake-1", pickerOpen = true))
        assertNull("a starter trip never keeps an earlier island choice", local.routeId)
        assertEquals("long_survey", local.starterRouteId)
        assertEquals("inst-starter", local.installationId)
        val send = requireNotNull(lodgeSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet()), local).send)
        assertNotNull("the starter's own routes show", send.starterRoutes)
        assertEquals("long_survey", send.selectedStarterRouteId)
        assertNull(send.selectedRouteId)
    }

    @Test fun `choosing an island keeps that island instead of falling back to the starter boat`() {
        // The route-first SEND starts on the starter only while nothing is chosen. A chosen island (CHANGE, a preselected
        // archipelago SEND) keeps the SPEC default vehicle, or the island would silently become the starter's coast loop.
        val chosen = homeLodgeStarterDefault(LodgeLocalState(routeId = "glasswake-1"), LodgeSendMode.STARTER, "inst-starter")
        assertNull(chosen.installationId)
        val send = requireNotNull(lodgeSheetUi(kingdom(emptyList()), chosen).send)
        assertEquals("glasswake-1", send.selectedRouteId)
        assertEquals("the lowest tier that reaches the grade", "inst-cut", send.selectedInstallationId)
        assertEquals("inst-starter", homeLodgeStarterDefault(LodgeLocalState(), LodgeSendMode.STARTER, "inst-starter").installationId)
        assertNull("CRAFTED never defaults to the starter", homeLodgeStarterDefault(LodgeLocalState(), LodgeSendMode.CRAFTED, "inst-starter").installationId)
        assertEquals("a picked vehicle is never replaced", "inst-cut",
            homeLodgeStarterDefault(LodgeLocalState(installationId = "inst-cut"), LodgeSendMode.STARTER, "inst-starter").installationId)
    }

    @Test fun `crafted mode is offered only for a finished Berth with an observed vehicle policy`() {
        assertTrue(homeLodgeCraftedOffered(fx.inputs()))
        val lodge = Building("lodge-1", "lodge", 4, 0, 0)
        assertFalse("a Berth under construction docks nothing",
            homeLodgeCraftedOffered(fx.inputs(buildings = listOf(lodge, Building("berth-1", "berth", 1, 4, 0, underConstruction = true)))))
        assertFalse("a level 0 Berth is not finished", homeLodgeCraftedOffered(fx.inputs(buildings = listOf(lodge, Building("berth-1", "berth", 0, 4, 0)))))
        assertFalse("no Berth", homeLodgeCraftedOffered(fx.inputs(buildings = fx.buildingsNoBerth)))
        assertFalse("an unloaded base is not a Berth", homeLodgeCraftedOffered(fx.inputs(buildings = null)))
        assertFalse("no observed vehicle policy, no crafted dispatch", homeLodgeCraftedOffered(fx.inputs(policy = VoyagePolicyFacts())))
    }

    @Test fun `berth unlock reason comes from the catalogue keep level and vanishes once a Berth exists`() {
        val catalogue = fx.obj("""{"constants":{"BUILD_COSTS":{"berth":{"requiresKeepLevel":5}}}}""")
        assertEquals("Unlocks at Keep 5", homeBerthUnlockReason(catalogue, 4, fx.buildingsNoBerth))
        assertNull("the Keep reached the gate", homeBerthUnlockReason(catalogue, 5, fx.buildingsNoBerth))
        assertNull("a Berth already placed, even unfinished",
            homeBerthUnlockReason(catalogue, 4, fx.buildingsNoBerth + Building("berth-1", "berth", 1, 4, 0, underConstruction = true)))
        assertNull("no catalogue gate is never a guessed one",
            homeBerthUnlockReason(fx.obj("""{"constants":{"BUILD_COSTS":{"berth":{}}}}"""), 1, fx.buildingsNoBerth))
        assertNull(homeBerthUnlockReason(null, 1, fx.buildingsNoBerth))
        assertNull(homeBerthUnlockReason(catalogue, null, fx.buildingsNoBerth))
        assertNull(homeBerthUnlockReason(catalogue, 1, null))
        // The live locked SEND then shows the LOCKED variant with that reason instead of a BUILD BERTH that cannot build.
        val reason = homeBerthUnlockReason(catalogue, 4, fx.buildingsNoBerth)
        val locked = lodgeSheetUi(lockedKingdom().copy(berthUnlockReason = reason), LodgeLocalState()).locked
        assertEquals(LodgeLockedVariant.BERTH_LOCKED, locked?.variant)
        assertEquals("Unlocks at Keep 5", locked?.unlockReason)
    }

    @Test fun `resource tiles name the realm that brings the resource home`() {
        assertEquals("Heartwood Logs comes home from Elderwood islands.", homeLodgeResourceLine("heartwood_logs"))
        assertEquals("Rough Prism comes home from Solana Reach islands.", homeLodgeResourceLine("voyage:rough-prism"))
        assertEquals("Thorn Fibre comes home from Thornwake islands.", homeLodgeResourceLine("thorn_fibre"))
        assertEquals("a registry row is not a resource", fallback, homeLodgeResourceLine("building.harvester"))
        assertEquals(fallback, homeLodgeResourceLine(null))
        // Every tile on the locked SEND hands its own id through a resource door the host answers with this line, and
        // every one of them is named (a tile that only said "choose an island" would be a door that tells nothing).
        val calls = Calls()
        val ui = lodgeSheetUi(lockedKingdom(), LodgeLocalState())
        val tiles = requireNotNull(ui.locked).resources
        assertTrue(tiles.isNotEmpty())
        val actions = lodgeSheetActions(ui, calls.lodge())
        tiles.forEach { actions.locked.onResource(it.id) }
        assertEquals(tiles.size, calls.log.size)
        calls.log.forEach { entry ->
            val (door, id) = entry.removePrefix("go:").split(':', limit = 2)
            assertTrue(entry, door == "RESOURCE_DRAWER" || door == "EARN_RESOURCE")
            assertNotEquals(entry, fallback, homeLodgeResourceLine(id))
        }
    }

    @Test fun `supply stack shows at most two rows and only on SEND`() {
        val ui = lodgeSheetUi(kingdom(emptyList()), LodgeLocalState(routeId = "glasswake-1", installationId = "inst-cut"))
        assertEquals("the chosen trip's supplies, from the server preview", listOf("Thorn Fibre"),
            homeLodgeSupplyStack(ui, LodgeSheetUi.TAB_SEND)?.map { it.name })
        val chip = ResourceChipUi(FeatureId("building.harvester"), "voyage:ember-nodules", "18", null, false, null, "Ember Nodules")
        val three = ui.copy(supplyStack = listOf(chip, chip.copy(name = "Thorn Fibre"), chip.copy(name = "Frost Quartz")))
        assertEquals(listOf("Ember Nodules", "Thorn Fibre"), homeLodgeSupplyStack(three, LodgeSheetUi.TAB_SEND)?.map { it.name })
        assertNull("TRIPS hands the HUD back its own rows", homeLodgeSupplyStack(three, LodgeSheetUi.TAB_TRIPS))
        assertNull("PASSPORT too", homeLodgeSupplyStack(three, LodgeSheetUi.TAB_PASSPORT))
        assertNull("no trip chosen, no supply rows", homeLodgeSupplyStack(three.copy(send = null), LodgeSheetUi.TAB_SEND))
        assertNull("a starter route uses no supplies",
            homeLodgeSupplyStack(lodgeSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet()), LodgeLocalState()), LodgeSheetUi.TAB_SEND))
    }

    @Test fun `departure line names the vehicle family and promises no return time`() {
        assertEquals("Cargo Cutter set sail", homeLodgeDepartureLine(VehicleFamily.CARGO_CUTTER))
        assertEquals("Starter Boat set sail", homeLodgeDepartureLine(VehicleFamily.STARTER))
        VehicleFamily.entries.forEach { family ->
            val line = homeLodgeDepartureLine(family)
            assertFalse("the client reads no return time for the toast: $line", line.any { it.isDigit() } || line.contains("back"))
        }
    }

    @Test fun `starter departure toast waits for the server proof of that exact request`() {
        // A finished confirm call is not acceptance: the owner keeps refusals and lost answers as its own notices.
        val view = fx.starterView()
        val route = view.routes.single { it.routeId == "coastal_survey" }
        val installation = requireNotNull(view.installation)
        val command = StarterExpeditionCommand(StarterExpeditionRequest("key-1", view.baseId, installation.installationId, route.routeId,
            route.routeCatalogueVersion, route.rewardTableVersion), route, installation)
        val proof = StarterExpeditionProof(VoyageFx.WALLET, "key-1", view.serverNow, "accepted", null, null)
        val base = fx.starter()
        fun saved(operation: StarterExpeditionOperation?, archives: List<StarterExpeditionArchive> = emptyList()) =
            base.copy(journal = base.journal.copy(operation = operation, archives = archives))
        assertNull("sent but unanswered: keep waiting", homeStarterSailed(saved(StarterExpeditionOperation(command, 1L, null, null)), "key-1"))
        assertEquals(true, homeStarterSailed(saved(StarterExpeditionOperation(command, 1L, proof, null)), "key-1"))
        assertEquals("a refusal never says it sailed", false, homeStarterSailed(saved(StarterExpeditionOperation(command, 1L, null,
            StarterExpeditionRefusal(409, "STARTER_EXPEDITION_INFLIGHT"))), "key-1"))
        assertEquals("accepted and already archived", true, homeStarterSailed(saved(null,
            listOf(StarterExpeditionArchive(StarterExpeditionOperation(command, 1L, proof, null), "accepted", null))), "key-1"))
        val other = command.copy(request = command.request.copy(idempotencyKey = "key-2"))
        assertEquals("another request's proof is not this one", false,
            homeStarterSailed(saved(StarterExpeditionOperation(other, 1L, proof, null)), "key-1"))
        assertNull("no starter snapshot yet", homeStarterSailed(null, "key-1"))
    }
}
