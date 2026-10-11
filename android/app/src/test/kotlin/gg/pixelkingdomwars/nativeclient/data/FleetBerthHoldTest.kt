package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.ops.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

/** Owner N-028 (2026-10-06): a fleet read the server holds is "not open here", never a red error, and never stops or delays
 * the kingdom. Demo build on the QA chain lane: every cold start showed the RED toast "Fleet berths are temporarily
 * unavailable; try loading th… [Report]" at about 9 s. Those are the server's words for 503 VEHICLE_BERTH_VIEW_HELD, raised
 * by the lane's starter-fleet berth hook on GET /base itself (apps/api/src/game/vehicleBerthOccupancy.ts) when its
 * `for update nowait` row read collides with the concurrent GET /starter-fleet; the Home read published them as its error. */
class FleetBerthHoldTest {
    private class Fixture {
        val api = FakeApiClient()
        val holder = testHolder()
        val session = signedIn(holder)
        val intents = PendingIntentStore(MemoryStore())
        val repository = LiveBaseRepository(session, holder, api, intents, ReceiptObserver(intents), { BASE_ID })
        init { api.onGet("/balances") { balancesJson() }; api.onGet("/tutorial") { tutorialJson() } }
    }
    private val held = ApiException(503, "VEHICLE_BERTH_VIEW_HELD", "Fleet berths are temporarily unavailable; try loading them again")
    private fun Fixture.baseReads() = api.gets.count { it.first == "/base" }

    @Test fun `a 503 on the vehicle client assets never shows an error toast and keeps the starter fleet`() = runBlocking {
        // 1. The cold-start collision: the berth hook holds the first GET /base. It is read once more and the kingdom arrives,
        //    with no error for the Home's status toasts (KingdomStatusToasts posts BaseState.error as a red toast + Report).
        val f = Fixture(); var calls = 0
        f.api.onGet("/base") { if (calls++ == 0) throw held else baseJson() }
        f.repository.refresh()
        assertEquals("One repeat of the read, never more", 2, f.baseReads())
        assertNull("No red toast", f.repository.state.value.error)
        val kept = requireNotNull(f.repository.state.value.base) { "the kingdom must arrive on the repeat" }
        assertFalse(f.repository.state.value.loading)
        // 2. Still held on the repeat: the last good Home (its starter fleet included) stays, quietly, and refresh() returns,
        //    so the screen model posts no notice either. The next cadence tick reads again.
        f.api.gets.clear(); f.api.onGet("/base") { throw held }
        f.repository.refresh()
        assertEquals(2, f.baseReads())
        assertSame("The kingdom on screen is kept", kept, f.repository.state.value.base)
        assertNull("Still no red toast", f.repository.state.value.error); assertFalse(f.repository.state.value.loading)
        // 3. The crafted-vehicle reads the lane holds (GET /vehicles/client/assets(-v2): 503 VEHICLE_CLIENT_PROVIDER_UNAVAILABLE,
        //    or a bare 503) are the feature off: VehicleRepository draws SERVICE_HELD with no error, and the Berth keeps the
        //    starter boat (BerthFleetDegradeTest pins that drawing).
        assertTrue(vehicleFeatureOff(ApiException(503, "VEHICLE_CLIENT_PROVIDER_UNAVAILABLE", "Current vehicle ownership is unavailable")))
        assertTrue(vehicleFeatureOff(ApiException(503, null, "Service unavailable")))
    }

    @Test fun `any other 503 on the Home read still speaks`() = runBlocking {
        // Matched on the code, never the status alone: a held kingdom (maintenance, a database outage) is a real error.
        val f = Fixture()
        f.api.onGet("/base") { throw ApiException(503, "MAINTENANCE", "The kingdom is under maintenance") }
        assertTrue(runCatching { f.repository.refresh() }.exceptionOrNull() is ApiException)
        assertEquals("Not repeated", 1, f.baseReads())
        assertEquals("The kingdom is under maintenance", f.repository.state.value.error)
        assertFalse(berthViewHeld(ApiException(503, null, "Fleet berths are temporarily unavailable; try loading them again")))
    }
}
