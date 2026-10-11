package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** A9: the mounted read sheet must not print exception text or offer impossible retries. AUTHORED / UNRUN. */
class HomeVoyageAvailabilityTest {
    @Test fun `missing policy is unavailable before the first repository emission`() {
        assertEquals(VehicleUnavailable.MISSING_POLICY, homeVoyageUnavailable(null, false))
        assertEquals(VehicleUnavailable.MISSING_POLICY, homeVoyageUnavailable(VehicleState(error = "Required value was null."), false))
        assertEquals(VehicleUnavailable.SERVICE_HELD, homeVoyageUnavailable(VehicleState(unavailable = VehicleUnavailable.SERVICE_HELD), true))
    }

    @Test fun `missing policy and held service have no retry message and no dispatch handoff`() {
        for (reason in VehicleUnavailable.entries) for (destination in listOf(Destination.Lodge(), Destination.Berth())) {
            val opens = mutableListOf<Pair<VehicleEntryPoint, Boolean>>(); val explanations = mutableListOf<String>()
            assertNull(homeVoyageReadError(reason, "read diagnostic", "Required value was null."))
            homeVoyageVehicleControls(reason,
                { homeVoyageVehicleOpen(destination, false, { entry, history -> opens += entry to history }) },
                { explanations += it })
            assertTrue(opens.isEmpty()); assertEquals(1, explanations.size)
            assertEquals("Vehicles are not open on this server yet", explanations.single())
        }
    }

    @Test fun `retryable read errors use existing safe copy and retain an admitted control handoff`() {
        val copy = "Fleet details could not be refreshed. Original receipts remain available."
        assertEquals(copy, homeVoyageReadError(null, null, "Required value was null."))
        assertEquals(copy, homeVoyageReadError(null, "socket or unexpected diagnostic", null))
        assertNull(homeVoyageReadError(null, null, null))
        val opens = mutableListOf<Pair<VehicleEntryPoint, Boolean>>()
        homeVoyageVehicleControls(null,
            { homeVoyageVehicleOpen(Destination.Berth(), false, { entry, history -> opens += entry to history }) }, { fail(it) })
        assertEquals(listOf(VehicleEntryPoint.BERTH to false), opens)
    }

    @Test fun `mounted sheet uses availability guard and safe error instead of printing raw repository failure`() {
        val body = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeRouteDispatcher.kt").readText()
            .substringAfter("@Composable internal fun HomeVoyageSheet(")
        assertTrue(body.contains("homeVoyageUnavailable(vehicles, policy.tiers != null)"))
        assertTrue(body.contains("homeVoyageVehicleControls(unavailable,"))
        assertTrue(body.contains("{ homeVoyageVehicleOpen(entry.destination, false, openVehicles) }, explain)"))
        assertTrue(body.contains("homeVoyageReadError(unavailable, refreshError, vehicles?.error)"))
        assertFalse(body.contains("(refreshError ?: vehicles?.error)"))
        assertTrue("the separate receipt entry remains read-only", body.contains("val vehicleHistory = { homeVoyageVehicleOpen(entry.destination, true, openVehicles) }"))
    }
}
