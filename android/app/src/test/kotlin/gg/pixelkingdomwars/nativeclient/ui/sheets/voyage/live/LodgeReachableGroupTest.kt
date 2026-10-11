package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*
import gg.pixelkingdomwars.nativeclient.ui.home.HomeRouteIdentity
import gg.pixelkingdomwars.nativeclient.ui.home.HomeVoyageCollector
import kotlinx.coroutines.test.runTest
import org.junit.Assert.*
import org.junit.Test

/** AUTHORED / UNRUN. These exercise live routing and server evidence, not sample previews. */
class LodgeReachableGroupTest {
    private fun inputs() = VoyageFx.inputs(starter = VoyageFx.starter(), vehicles = VoyageFx.vehicles(
        fleet = VoyageFx.fleet(VoyageFx.row("cutter", "cargo_cutter", 2, 4)),
        routes = VoyageFx.routes("cutter",
            VoyageFx.preview("glasswake-1", "elderwood", "heartwood_logs", "home"),
            VoyageFx.preview("ashreef-2", "cinderfall", "ember_ore", "paid_realm"))))

    @Test fun `advanced mode maps the selected crafted fleet and its server route previews`() {
        val ui = lodgeAdvancedUi(inputs(), LodgeLocalState(installationId = "cutter", routeId = "glasswake-1"))
        assertEquals("cutter", ui.vehicle?.installationId)
        assertEquals(listOf("glasswake-1", "ashreef-2"), ui.routes.map { it.route.routeId })
        assertEquals("108", ui.routes.first().yield)
        assertFalse(ui.routes.first().needsPermit)
        assertTrue(ui.routes.last().needsPermit)
        assertNotNull(ui.preview)
    }

    @Test fun `foreign fleet and missing preview never become current crafted route authority`() {
        val input = inputs()
        val foreign = input.copy(baseId = "foreign")
        assertNull(lodgeAdvancedUi(foreign, LodgeLocalState()).vehicle)
        val missing = input.copy(vehicles = input.vehicles?.copy(routes = null))
        val ui = lodgeAdvancedUi(missing, LodgeLocalState(installationId = "cutter", routeId = "glasswake-1"))
        assertEquals(PreviewState.LOADING, ui.previewState)
        assertNull(ui.preview)
    }

    @Test fun `paid route calls the injected permit review and never crafted dispatch`() {
        val input = inputs()
        val ui = lodgeSheetUi(input, LodgeLocalState(installationId = "cutter", routeId = "ashreef-2"))
        val calls = Calls()
        val on = calls.lodge().copy(reviewPermit = { vehicle, route -> calls.log += "permit:$vehicle:$route" })
        lodgeSheetActions(ui, on).send.onSend()
        assertEquals(listOf("permit:cutter:ashreef-2"), calls.log)
    }

    @Test fun `returned collection requires this base a new collect record and the captured ready trips`() {
        val collect = gg.pixelkingdomwars.nativeclient.data.VehicleRecord("collect-now", "collect", "key", VoyageFx.obj("""{"baseId":"b1"}"""),
            VoyageFx.obj("{}"), response = VoyageFx.obj("""{"returned":1}"""))
        assertTrue(voyageCollectMatches(collect, "b1", emptySet()))
        assertFalse(voyageCollectMatches(collect, "other", emptySet()))
        assertFalse(voyageCollectMatches(collect, "b1", setOf("collect-now")))
        assertFalse(voyageCollectMatches(collect.copy(response = null), "b1", emptySet()))
    }

    @Test fun `collector celebrates only the fresh returned receipt after hydration and current identity`() = runTest {
        val identity = HomeRouteIdentity(Any(), VoyageFx.BASE, 2)
        var current: HomeRouteIdentity? = identity
        val trip = VoyageFx.expedition("trip", "cutter", "glasswake-1", "2030-01-01T10:00:00.000Z", "2030-01-01T18:00:00.000Z")
        val returned = VoyageFx.expedition("trip", "cutter", "glasswake-1", "2030-01-01T10:00:00.000Z", "2030-01-01T18:00:00.000Z", returned = true)
        val receipt = gg.pixelkingdomwars.nativeclient.data.VehicleRecord("collect-new", "collect", "key", VoyageFx.obj("""{"baseId":"b1"}"""),
            VoyageFx.obj("{}"), response = VoyageFx.obj("""{"returned":1}"""))
        var input = inputs().let { it.copy(vehicles = it.vehicles?.copy(journal = it.vehicles?.journal?.copy(pending = listOf(trip)))) }
        var calls = 0
        val control = HomeVoyageCollector(identity, { current }, { true }, { input }) {
            calls++
            input = input.copy(vehicles = input.vehicles?.copy(selectedId = receipt.id,
                journal = input.vehicles?.journal?.copy(pending = listOf(returned, receipt))))
            true
        }
        val ui = control.collect()
        assertEquals("collect-new", ui?.receiptId)
        assertEquals(listOf("trip"), ui?.trips?.map { it.tripId })
        assertEquals(1, calls)
        assertNull(control.collect()) // No ready trip remains: no second POST.
        assertEquals(1, calls)
        current = null
        assertNull(control.collect())
    }

    @Test fun `collect keeps unknown responses and failed hydration out of celebrations`() = runTest {
        for (retire in listOf(false, true)) {
            val identity = HomeRouteIdentity(Any(), VoyageFx.BASE, 2)
            var current: HomeRouteIdentity? = identity
            val trip = VoyageFx.expedition("trip", "cutter", "glasswake-1", "2030-01-01T10:00:00.000Z", "2030-01-01T18:00:00.000Z")
            val input = inputs().let { it.copy(vehicles = it.vehicles?.copy(journal = it.vehicles?.journal?.copy(pending = listOf(trip)))) }
            var calls = 0
            val control = HomeVoyageCollector(identity, { current }, { true }, { input }) {
                calls++; if (retire) current = null
                !retire // A successful callback with no fresh receipt is still not proof.
            }
            assertNull(control.collect())
            assertEquals(1, calls)
            assertFalse(control.busy)
        }
    }

    @Test fun `unresolved collect is checked rather than creating another request`() = runTest {
        val identity = HomeRouteIdentity(Any(), VoyageFx.BASE, 2)
        val trip = VoyageFx.expedition("trip", "cutter", "glasswake-1", "2030-01-01T10:00:00.000Z", "2030-01-01T18:00:00.000Z")
        val unresolved = gg.pixelkingdomwars.nativeclient.data.VehicleRecord("collect-old", "collect", "key",
            VoyageFx.obj("""{"baseId":"b1"}"""), VoyageFx.obj("{}"))
        val input = inputs().let { it.copy(vehicles = it.vehicles?.copy(journal = it.vehicles?.journal?.copy(pending = listOf(trip, unresolved)))) }
        val control = HomeVoyageCollector(identity, { identity }, { true }, { input }) { fail("No second collect POST"); false }
        assertTrue(voyageCollectNeedsCheck(input.vehicles, identity.baseId))
        assertNull(control.collect())
    }
}
