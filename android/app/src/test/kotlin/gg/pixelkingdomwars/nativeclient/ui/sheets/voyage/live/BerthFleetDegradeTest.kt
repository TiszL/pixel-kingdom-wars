package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.starter.StarterExpeditionFlight
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetCommand
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetOperation
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetProof
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetReceipt
import gg.pixelkingdomwars.nativeclient.starter.StarterFleetRequest
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LodgeLockedVariant
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.RouteFilter
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.filterCount
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner Seeker, QA, 2026-10-06 07:24 UTC: the QA server has the crafted-vehicle feature switched off, so `/vehicles/fleet`
 * answers 503 ADVANCED_FLEET_UNAVAILABLE (production: 404). The Berth treated that as a failure of the whole fleet view:
 * RETRY over the free Starter Boat, and after INSTALL FREE the boat vanished, so the player could not see it was installed
 * or go on to the Lodge SEND. Why it matters: the starter boat is every new player's first voyage and never depends on
 * the crafted vehicle routes; a server that has not opened crafted vehicles must still let them install it, see it and sail it.
 */
class BerthFleetDegradeTest {
    private val fx = VoyageFx
    private val held = fx.vehicles().copy(unavailable = VehicleUnavailable.SERVICE_HELD)

    private fun flight(returnsAt: String) = StarterExpeditionFlight("exp-1", "inst-starter", fx.starterRoute("coastal_survey"),
        "2030-01-01T15:00:00.000Z", returnsAt, "term-1", "a".repeat(64))

    @Test fun `vehicles feature off leaves the starter fleet visible with INSTALL FREE and no retry`() {
        val ui = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(installation = null), vehicles = held), BerthLocalState())
        assertEquals("FLEET_STARTER", ui.panelKey)
        assertNull("a closed feature is not a failed read: no RETRY", ui.readError)
        assertFalse(ui.loading)
        val starter = requireNotNull(ui.starter)
        assertTrue(starter.available); assertFalse(starter.installed)
        assertEquals("the MORE BERTHS row says it quietly", CRAFTED_VEHICLES_OFF, starter.craftedOff)
        assertNull("no crafted fleet is invented", ui.fleet); assertTrue(ui.quay.isEmpty())
        val calls = Calls(); val actions = berthSheetActions(ui, calls.berth())
        actions.starter.onInstallStarter()
        // Crafting is part of the closed feature: its doors explain instead of opening a page that cannot work.
        actions.starter.onFamilyTeaser(VehicleFamily.CARGO_CUTTER); actions.starter.onCraftLink()
        assertEquals(listOf("starterInstall", "toast:$CRAFTED_VEHICLES_OFF", "toast:$CRAFTED_VEHICLES_OFF"), calls.log)
    }

    @Test fun `vehicles feature off still shows the installed starter boat and sends it from the Lodge`() {
        val ui = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(), vehicles = held), BerthLocalState())
        assertEquals("FLEET_STARTER", ui.panelKey); assertNull(ui.readError)
        val boat = requireNotNull(ui.starter)
        assertTrue(boat.installed); assertFalse("never offered again", boat.available)
        assertNull("docked: no sea timer", boat.atSeaLine)
        val calls = Calls(); val actions = berthSheetActions(ui, calls.berth())
        actions.starter.onInstallStarter(); actions.starter.onGoLodge()
        assertEquals(listOf("go:LODGE_SEND:null", "go:LODGE_SEND:null"), calls.log)
    }

    @Test fun `an accepted starter install shows the boat installed whatever the crafted vehicle read says`() {
        val before = fx.starterFleet(installation = null)
        val view = requireNotNull(before.view)
        val command = StarterFleetCommand(StarterFleetRequest("saved-key", VoyageFx.BASE, "berth-1"), view.eligibleBerths.single(), null)
        val receipt = StarterFleetReceipt(VoyageFx.WALLET, command.request, VoyageFx.starterInstallation, view.serverNow)
        val proof = StarterFleetProof(VoyageFx.WALLET, command.key, view.serverNow, "accepted", receipt)
        val accepted = before.copy(journal = before.journal.copy(operation = StarterFleetOperation(command, 1L, proof, null)))
        assertNull("the old view has not been re-read yet", accepted.view?.installation)
        for (vehicles in listOf(held, fx.vehicles().copy(error = "private response detail"))) {
            val ui = berthSheetUi(fx.inputs(starterFleet = accepted, vehicles = vehicles), BerthLocalState())
            assertEquals("FLEET_STARTER", ui.panelKey)
            val boat = requireNotNull(ui.starter)
            assertTrue(boat.installed); assertFalse(boat.available); assertFalse(boat.pending)
            // RETRY only for the real failure, never for the closed feature.
            assertEquals(vehicles.unavailable == null, ui.readError != null)
        }
    }

    @Test fun `the starter boat at sea shows its timer while crafted vehicles are off`() {
        val out = berthSheetUi(fx.inputs(starter = fx.starter(fx.starterView(flight = flight("2030-01-01T19:32:00.000Z"))),
            starterFleet = fx.starterFleet(), vehicles = held), BerthLocalState())
        // 18:20 now, back at 19:32: the server's own return time, formatted, never computed from a duration.
        assertEquals("Back in ${backInText(4_320L)}", requireNotNull(out.starter).atSeaLine)
        val due = berthSheetUi(fx.inputs(starter = fx.starter(fx.starterView(flight = flight("2030-01-01T18:00:00.000Z"))),
            starterFleet = fx.starterFleet(), vehicles = held), BerthLocalState())
        assertEquals("$DUE_BACK · checking", requireNotNull(due.starter).atSeaLine)
    }

    @Test fun `SERVICE says crafted vehicles are not open and the tabs still switch`() {
        val fleet = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(), vehicles = held), BerthLocalState())
        var next: BerthLocalState? = null
        val calls = Calls(); berthSheetActions(fleet, calls.berth { next = it }).onTab(BerthSheetUi.TAB_SERVICE)
        assertEquals(listOf("update"), calls.log); assertEquals(BerthSheetUi.TAB_SERVICE, next?.tab)
        val service = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(), vehicles = held), BerthLocalState(tab = BerthSheetUi.TAB_SERVICE))
        assertEquals(BerthSheetUi.PANEL_UNAVAILABLE, service.panelKey)
        assertEquals(BerthSheetUi.TAB_SERVICE, requireNotNull(service.unavailable).headline)
        assertEquals(CRAFTED_VEHICLES_OFF, requireNotNull(service.unavailable).reason)
        assertTrue(service.serviceLocked); assertNull(service.readError)
    }

    @Test fun `a real crafted read failure keeps RETRY and is never shown as the feature off`() {
        val ui = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(installation = null),
            vehicles = fx.vehicles().copy(error = "Connection interrupted. Please retry.")), BerthLocalState())
        assertNotNull(ui.readError); assertNull(ui.unavailable)
        assertNull(requireNotNull(ui.starter).craftedOff)
    }

    @Test fun `the Lodge counts the starter boat alone while crafted vehicles are off`() {
        // Before the install: nothing can sail, and that is known, so SEND is the designed locked state (GO TO BERTH), not an
        // island picker reading CAN SAIL 0 over an unknown fleet.
        val noBoat = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null), vehicles = held), LodgeLocalState())
        assertEquals(LodgeLockedVariant.NO_VEHICLE, requireNotNull(noBoat.locked).variant)
        assertNull(noBoat.send); assertNull(noBoat.picker)
        // An unread crafted fleet (no answer yet) still waits instead of claiming "no boat".
        val unread = lodgeSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null), vehicles = fx.vehicles()), LodgeLocalState())
        assertNull(unread.locked)
        // After the install: the starter boat alone. A crafted snapshot retained from before is not a vehicle that may sail.
        val retained = fx.vehicles(fleet = fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)))
            .copy(unavailable = VehicleUnavailable.SERVICE_HELD)
        val boat = lodgeSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(), vehicles = retained),
            LodgeLocalState(pickerOpen = true))
        val send = requireNotNull(boat.send)
        assertEquals(listOf(VehicleFamily.STARTER), send.vehicles.map { it.family })
        assertNotNull("starter mode: the coast routes", send.starterRoutes)
        val picker = requireNotNull(boat.picker)
        assertNull(picker.bestDockedTier)
        assertEquals("0", filterCount(picker.routes, RouteFilter.CAN_SAIL, picker.bestDockedTier, picker.loading))
    }
}
