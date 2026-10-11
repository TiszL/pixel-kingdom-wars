package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionCommand
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFlight
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionOperation
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionRequest
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.Access
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ChartMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeLockedVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PreviewState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RewardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.TripState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleStatus
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live Lodge (SEND / CHOOSE AN ISLAND / locked / TRIPS / collect). Why it matters: the Lodge is where a player's raw
 * resources and real wallet money meet. A number the server did not send (a "0" for an unknown, a made-up permit price)
 * is a trust bug; a permit route that sends without its Seal would spend SOL behind the player's back; a missing
 * snapshot shown as "no vehicle" would tell a paying player their vehicle is gone.
 */
class LodgeLiveMapperTest {
    private val fx = VoyageFx

    private fun craftedInputs(local: LodgeLocalState = LodgeLocalState(), records: List<VehicleRecord> = emptyList(), thorn: String = "2") =
        lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null, thorn = thorn)),
            starterFleet = fx.starterFleet(installation = null),
            vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)),
                fx.routes("inst-cut", fx.preview("glasswake-1", "elderwood", "heartwood_logs", "home"),
                    fx.preview("ashreef-2", "cinderfall", "ember_nodules", "paid_realm")), pending = records)), local)

    @Test fun `a starter-only kingdom opens SEND on the coast routes with the server's own terms, no island picker`() {
        val ui = lodgeSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet()), LodgeLocalState())
        val send = requireNotNull(ui.send) { "SEND must show for an installed starter boat" }
        assertNull("the starter never needs the island picker", ui.picker)
        assertEquals(listOf("COAST", "LONG", "INTRO"), send.starterRoutes!!.map { it.label })
        assertEquals("coastal_survey", send.selectedStarterRouteId)
        assertEquals("inst-starter", send.selectedInstallationId)
        val preview = send.preview!!
        assertEquals("3h 20m", preview.duration)
        assertEquals("21:40", preview.returnsAtLocal)
        assertEquals("108", preview.netQuantity)
        assertTrue("starter trips use no supplies", preview.supplies.isEmpty())
        assertNull("starter routes never carry a permit", preview.permit)
        assertTrue(send.ordersAllowed)
        assertEquals(ChartMode.STARTER_LOOP, ui.chart.mode)
        assertEquals("LV 4", ui.level)
    }

    @Test fun `supplies are short only when both sides are known, and the shortfall is the server's difference`() {
        val haves = mapOf("thorn_fibre" to "2")
        val short = supplyUi("thorn_fibre", "6", haves)
        assertTrue(short.short)
        assertEquals("Need 4 more Thorn Fibre", short.shortLine)
        val unknown = supplyUi("thorn_fibre", "6", null)
        assertFalse("an unknown stock is never declared short", unknown.short)
        assertEquals(UNKNOWN, unknown.have)
        assertEquals("a malformed need reads …, never 0", UNKNOWN, supplyUi("thorn_fibre", "six", haves).need)
    }

    @Test fun `a permit island is held with the MS-M3 reason and SEND on it never dispatches`() {
        val ui = craftedInputs(LodgeLocalState(routeId = "ashreef-2", installationId = "inst-cut"))
        val island = ui.send!!.routes.single { it.routeId == "ashreef-2" }
        assertEquals(Access.PAID_REALM, island.access)
        assertEquals(VOYAGE_MONEY_PENDING, island.permitReason)
        val permit = ui.send!!.preview!!.permit!!
        assertEquals("the permit price is never guessed", PriceStatus.CHECKING, permit.price.status)
        assertNull(permit.price.amount)
        val calls = Calls()
        lodgeSheetActions(ui, calls.lodge()).send.onSend()
        assertEquals(listOf(VOYAGE_MONEY_PENDING), calls.toasts)
        assertTrue("no dispatch, no charge", calls.log.none { it.startsWith("dispatch") || it.startsWith("starter") })
    }

    @Test fun `a HOME island SEND dispatches the chosen vehicle to that island through the existing call`() {
        val ui = craftedInputs(LodgeLocalState(routeId = "glasswake-1"))
        assertEquals("the default vehicle is the docked Cutter", "inst-cut", ui.send!!.selectedInstallationId)
        assertEquals(PreviewState.READY, ui.send!!.previewState)
        assertEquals(Access.HOME, ui.send!!.routes.single { it.routeId == "glasswake-1" }.access)
        val calls = Calls()
        lodgeSheetActions(ui, calls.lodge()).send.onSend()
        assertEquals(listOf("dispatch:inst-cut:glasswake-1"), calls.log)
    }

    @Test fun `with crafted vehicles and no island chosen the first visit opens on CHOOSE AN ISLAND`() {
        val ui = craftedInputs()
        assertNotNull(ui.picker)
        assertEquals("SEND_PICKER", ui.panelKey)
        assertEquals(2, ui.picker!!.bestDockedTier)
    }

    @Test fun `missing snapshots never read as no vehicle, known-empty with a Berth does`() {
        val loading = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null), vehicles = fx.vehicles(fleet = null)), LodgeLocalState())
        assertNull("the crafted fleet is still loading: not 'no vehicle'", loading.locked)
        val empty = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null), vehicles = fx.vehicles(fleet = fx.fleet())), LodgeLocalState())
        assertEquals(LodgeLockedVariant.NO_VEHICLE, empty.locked!!.variant)
        assertEquals("2", empty.locked!!.islandCount)
        val noBerth = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null), vehicles = null, buildings = fx.buildingsNoBerth), LodgeLocalState())
        assertEquals(LodgeLockedVariant.NO_BERTH, noBerth.locked!!.variant)
    }

    @Test fun `with the home realm unknown every island is held, never shown as free`() {
        val ui = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(home = null)), starterFleet = fx.starterFleet(),
            vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)), routes = null)), LodgeLocalState(pickerOpen = true))
        assertTrue(ui.picker!!.routes.all { it.access == Access.PAID_REALM && it.permitReason == "Checking your home realm" })
    }

    @Test fun `a crafted trip past its time with no server return is READY to collect, one with a return is gone from TRIPS`() {
        val due = fx.expedition("e1", "inst-cut", "glasswake-1", "2030-01-01T15:00:00.000Z", "2030-01-01T18:00:00.000Z")
        val done = fx.expedition("e2", "inst-cut", "glasswake-1", "2030-01-01T10:00:00.000Z", "2030-01-01T12:00:00.000Z", returned = true)
        val ui = craftedInputs(LodgeLocalState(tab = LodgeSheetUi.TAB_TRIPS), records = listOf(due, done))
        assertEquals(listOf("e1"), ui.trips.trips.map { it.tripId })
        assertEquals(TripState.READY, ui.trips.trips.single().state)
        assertEquals(ChartMode.TRIPS, ui.chart.mode)
        val island = ui.send!!.routes.single { it.routeId == "glasswake-1" }
        assertEquals("the island tile is a door to that trip", "e1", island.myTrip?.tripId)
    }

    @Test fun `a starter flight past its time stays at sea with Due back checking - starter returns are automatic, never a COLLECT`() {
        val flight = StarterExpeditionFlight("exp-1", "inst-starter", fx.starterRoute("coastal_survey"), "2030-01-01T15:00:00.000Z",
            "2030-01-01T18:00:00.000Z", "term-1", "a".repeat(64))
        val ui = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(flight = flight)), starterFleet = fx.starterFleet()),
            LodgeLocalState(tab = LodgeSheetUi.TAB_TRIPS))
        val trip = ui.trips.trips.single()
        assertEquals(TripState.AT_SEA, trip.state)
        assertTrue(trip.dueChecking)
        assertEquals(VehicleStatus.AWAY, ui.send!!.vehicles.single { it.family == VehicleFamily.STARTER }.status)
    }

    @Test fun `collect celebrates only a server receipt, merges per resource, and an unknown amount stays unknown`() {
        val a = fx.expedition("e1", "inst-cut", "glasswake-1", "2030-01-01T15:00:00.000Z", "2030-01-01T18:00:00.000Z", returned = true, net = "40")
        val b = fx.expedition("e2", "inst-cut", "glasswake-1", "2030-01-01T15:00:00.000Z", "2030-01-01T18:00:00.000Z", returned = true, net = "60")
        val inputs = fx.inputs(vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 5)), pending = listOf(a, b)))
        fun collect(response: String?) = VehicleRecord("c1", "collect", "c1", fx.obj("""{"baseId":"${fx.BASE}"}"""), JsonObject(emptyMap()),
            response = response?.let(fx::obj))
        assertNull("no response, nothing celebrates", collectUi(collect(null), inputs, setOf("e1", "e2")))
        assertNull("the server returned none", collectUi(collect("""{"baseId":"b1","serverNow":"2030-01-01T18:20:00.000Z","returned":0}"""), inputs, setOf("e1")))
        val card = collectUi(collect("""{"baseId":"b1","serverNow":"2030-01-01T18:20:00.000Z","returned":2}"""), inputs, setOf("e1", "e2"))!!
        assertEquals("c1", card.receiptId)
        assertEquals(listOf(RewardUi.Kind.CARGO to "100"), card.rewards.map { it.kind to it.quantity })
        val merged = mergeRewards(listOf(Triple(RewardUi.Kind.CARGO, "heartwood_logs", "40"), Triple(RewardUi.Kind.CARGO, "heartwood_logs", null)))
        assertEquals(UNKNOWN, merged.single().quantity)
    }

    @Test fun `a departure from an earlier session is CHECKed, never sent again`() {
        val route = fx.starterRoute("coastal_survey")
        val command = StarterExpeditionCommand(StarterExpeditionRequest("key-1", fx.BASE, "inst-starter", "coastal_survey", 1, 1), route, fx.starterInstallation)
        val starter = fx.starter().let { it.copy(journal = it.journal.copy(operation = StarterExpeditionOperation(command, 1, null, null))) }
        val ui = lodgeSheetUi(fx.inputs(starter = starter, starterFleet = fx.starterFleet()), LodgeLocalState())
        assertNotNull(ui.send!!.pending)
        val calls = Calls()
        lodgeSheetActions(ui, calls.lodge()).send.onSend()
        assertEquals(listOf("check"), calls.log)
    }

    @Test fun `the starter SEND opens the existing reviewed departure for the chosen coast route`() {
        val ui = lodgeSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet()), LodgeLocalState(starterRouteId = "long_survey"))
        val calls = Calls()
        lodgeSheetActions(ui, calls.lodge()).send.onSend()
        assertEquals(listOf("starter:long_survey"), calls.log)
    }
}
