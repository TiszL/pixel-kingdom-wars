package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFlight
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionRoute
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RewardUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.LodgeLocalState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.VoyageFx
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.departureInFlight
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.lodgeSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live.starterRouteChoices
import org.junit.Assert.*
import org.junit.Test

/**
 * Voyage gap audit, exploration end to end with the free Starter Boat. WHY each rule matters:
 * - the server credits a starter return on its own, so the collect card is the ONLY moment the player sees the cargo
 *   land; it must play exactly once, only for a flight this Home saw at sea, and never for history after a restart;
 * - Home may borrow the starter owner's read only for a warm read or a due flight, or every Home visit would poll;
 * - a routine re-read must not blank the sheet or paint SEND as "Sending" (owner: "always loading");
 * - the boat at sea must say when it is back instead of offering a SEND the server refuses;
 * - eight `common_<realm>` chips that all read "COMMON" could not be told apart.
 */
class HomeStarterReturnsTest {
    private val fx = VoyageFx
    private fun flight(returnsAt: String = "2030-01-01T18:00:00.000Z", route: StarterExpeditionRoute = fx.starterRoute("coastal_survey")) =
        StarterExpeditionFlight("exp-1", "inst-starter", route, "2030-01-01T15:00:00.000Z", returnsAt, "term-1", "a".repeat(64))

    @Test fun `a flight seen at sea and gone after its return time plays the return card exactly once`() {
        val watch = StarterReturnWatch()
        assertNull("the first look only records the boat at sea", watch.observe(fx.starterView(flight = flight())))
        assertNull("a view still showing the same flight is not a return", watch.observe(fx.starterView(flight = flight())))
        val back = watch.observe(fx.starterView(flight = null)) // serverNow 18:20, the flight was due 18:00
        assertEquals("exp-1", back?.expeditionId)
        assertNull("the same return never plays twice", watch.observe(fx.starterView(flight = null)))
    }

    @Test fun `history after a restart, an early disappearance or another boat never celebrates`() {
        assertNull("nothing was seen at sea in this run", StarterReturnWatch().observe(fx.starterView(flight = null)))
        val early = StarterReturnWatch()
        early.observe(fx.starterView(flight = flight(returnsAt = "2030-01-01T19:00:00.000Z")))
        assertNull("gone before its return time is not a settled return", early.observe(fx.starterView(flight = null)))
        val moved = StarterReturnWatch()
        moved.observe(fx.starterView(flight = flight()))
        assertNull("another boat in the berth means this flight's return is not proven here",
            moved.observe(fx.starterView(installation = fx.starterInstallation.copy(installationId = "inst-new"), flight = null)))
    }

    @Test fun `the return card shows the departure's own net cargo on the starter boat and repeats its coast route`() {
        val card = homeStarterReturnCollect(flight(), "berth-1")
        assertEquals(listOf(Triple("heartwood_logs", "108", RewardUi.Kind.CARGO)), card.rewards.map { Triple(it.resourceId, it.quantity, it.kind) })
        assertEquals(VehicleFamily.STARTER, card.vehicleAfter.family)
        val trip = card.trips.single()
        assertEquals("SEND AGAIN reopens the same coast route", "coastal_survey", trip.starterRouteId)
        assertNull("a coast trip has no island", trip.route)
        assertTrue("nothing celebrates without the server's own id", card.receiptId.contains("exp-1"))
    }

    @Test fun `Home borrows the starter read once per visit and again only for a due flight`() {
        assertTrue("no view of this kingdom yet: one warm read", homeStarterLeaseWanted(viewKnown = false, warmed = false, flightDue = false))
        assertFalse("a warm read is never retried in a loop", homeStarterLeaseWanted(viewKnown = false, warmed = true, flightDue = false))
        assertFalse("a known view with nothing due needs no read", homeStarterLeaseWanted(viewKnown = true, warmed = false, flightDue = false))
        assertTrue("a due flight is settled by the owner's read", homeStarterLeaseWanted(viewKnown = true, warmed = true, flightDue = true))
    }

    @Test fun `a routine re-read keeps the last starter view on screen but a failed read does not pretend`() {
        val memory = VoyageSnapshotMemory(VoyageFx.BASE)
        val shown = fx.starter()
        assertSame(shown.view, retainVoyage(memory, shown, null, null).starter?.view)
        assertSame("the owner drops its view while it re-reads; the sheet keeps the last one",
            shown.view, retainVoyage(memory, fx.starter(view = null, busy = true), null, null).starter?.view)
        assertNull("a finished read with no view is shown as it is, so the sheet can say it could not refresh",
            retainVoyage(memory, fx.starter(view = null, busy = false), null, null).starter?.view)
    }

    @Test fun `a routine owner read never paints SEND as Sending`() {
        val inputs = fx.inputs(starter = fx.starter(busy = true), starterFleet = fx.starterFleet())
        assertFalse(departureInFlight(inputs, starterMode = true))
        assertFalse(lodgeSheetUi(inputs, LodgeLocalState()).send!!.busy)
    }

    @Test fun `the starter boat at sea turns SEND off with its return time`() {
        val ui = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(flight = flight(returnsAt = "2030-01-01T19:00:00.000Z"))),
            starterFleet = fx.starterFleet()), LodgeLocalState(tab = LodgeSheetUi.TAB_SEND))
        val send = ui.send!!
        assertFalse(send.ordersAllowed)
        assertEquals("Back in 40m", send.ordersReason)
    }

    @Test fun `common coast routes are named by their realm with that realm's cargo icon`() {
        val common = StarterExpeditionRoute(2, 2, "common_seeker_reach", "seeker-reach", "rough_prism", "starter", 600, "12", "10", "2")
        val choices = starterRouteChoices(fx.starterView().copy(routes = fx.starterView().routes + common))
        assertEquals(listOf("COAST", "LONG", "INTRO", "Solana Reach"), choices.map { it.label })
        val chip = choices.last()
        assertTrue(chip.common)
        assertEquals("voyage:rough-prism", chip.icon)
        assertFalse("the home routes stay in the segment row", choices.first().common)
    }
}
