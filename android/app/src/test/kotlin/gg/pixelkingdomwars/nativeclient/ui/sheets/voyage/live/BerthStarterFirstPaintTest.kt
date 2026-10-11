package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Owner Seeker, QA, 2026-10-06 08:17 UTC (phone/v7-berth-fleet-081734.png, then v7-berth-wait-081806.png): opening the
 * Berth drew five skeleton rows for several seconds before the Starter Boat appeared. FLEET waited for the crafted-vehicle
 * read (the crafted vehicle routes, which on QA ends in a 503) although the starter boat never depends on it. Why it matters: a sheet opens
 * on what the game already knows (voyage SPEC §0.5, notes fix-loading-refresh and c-perf). A player who owns a boat must see
 * it at once, and a slow or failing crafted server must never hide the free starter boat. Skeleton rows stay only where
 * nothing is known yet, so no empty fleet is ever invented.
 */
class BerthStarterFirstPaintTest {
    private val fx = VoyageFx
    /** The crafted read is still running: its owner exists, nothing has answered yet (no fleet, no error, not held). */
    private val reading = fx.vehicles(busy = true)

    @Test fun `starter card draws before the crafted read settles`() {
        // The v7 case, an installed boat: YOUR BOAT IS IN with GO TO LODGE at once, no skeleton and no guessed crafted fleet.
        val installed = berthSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(), vehicles = reading), BerthLocalState())
        assertFalse("a known starter is never hidden behind skeleton rows", installed.loading)
        assertEquals("FLEET_STARTER", installed.panelKey)
        val boat = requireNotNull(installed.starter)
        assertTrue(boat.installed); assertFalse("never offered again", boat.available)
        assertNull("crafted vehicles are not guessed while their read runs", installed.fleet)
        assertTrue(installed.quay.isEmpty())
        assertNull("a read still running is not a failure: no RETRY", installed.readError)
        assertNull(installed.unavailable)
        assertTrue("only the 2 dp line says the crafted read is still running", installed.refreshing)
        val calls = Calls(); berthSheetActions(installed, calls.berth()).starter.onInstallStarter()
        assertEquals(listOf("go:LODGE_SEND:null"), calls.log)

        // Not installed yet: INSTALL FREE is offered at once and reaches the existing free review.
        val fresh = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(installation = null), vehicles = reading), BerthLocalState())
        assertFalse(fresh.loading); assertEquals("FLEET_STARTER", fresh.panelKey)
        assertTrue(requireNotNull(fresh.starter).available)
        val free = Calls(); berthSheetActions(fresh, free.berth()).starter.onInstallStarter()
        assertEquals(listOf("starterInstall"), free.log)

        // No crafted owner on this projection at all: the installed boat draws instead of skeleton rows that never end.
        val noOwner = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(), vehicles = null), BerthLocalState())
        assertFalse(noOwner.loading); assertTrue(requireNotNull(noOwner.starter).installed)
        assertFalse("no crafted read runs without its owner", noOwner.refreshing)

        // An accepted install the old view has not re-read yet is known too: the boat shows installed, not INSTALL FREE.
        val before = fx.starterFleet(installation = null)
        val view = requireNotNull(before.view)
        val command = gg.pixelkingdomwars.nativeclient.starter.StarterFleetCommand(
            gg.pixelkingdomwars.nativeclient.starter.StarterFleetRequest("saved-key", VoyageFx.BASE, "berth-1"), view.eligibleBerths.single(), null)
        val receipt = gg.pixelkingdomwars.nativeclient.starter.StarterFleetReceipt(VoyageFx.WALLET, command.request, VoyageFx.starterInstallation, view.serverNow)
        val proof = gg.pixelkingdomwars.nativeclient.starter.StarterFleetProof(VoyageFx.WALLET, command.key, view.serverNow, "accepted", receipt)
        val accepted = before.copy(view = null, journal = before.journal.copy(
            operation = gg.pixelkingdomwars.nativeclient.starter.StarterFleetOperation(command, 1L, proof, null)))
        val proven = berthSheetUi(fx.inputs(starterFleet = accepted, vehicles = reading), BerthLocalState())
        assertFalse(proven.loading); assertTrue(requireNotNull(proven.starter).installed)
    }

    @Test fun `skeleton rows stay only where nothing is known yet`() {
        // No starter owner: nothing to draw, so the honest first-load skeleton stays (BerthLiveBodyMountTest).
        assertTrue(berthSheetUi(fx.inputs(vehicles = reading), BerthLocalState()).loading)
        // A starter owner that has never answered for this kingdom (no view, no proof): no card is guessed from nothing.
        val unread = fx.starterFleet().copy(view = null)
        val blank = berthSheetUi(fx.inputs(starterFleet = unread, vehicles = reading), BerthLocalState())
        assertTrue(blank.loading); assertNull(blank.starter); assertFalse(blank.refreshing)
        // SERVICE is about crafted vehicles only: while their read runs it keeps its skeleton, never "nothing to service".
        val service = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(), vehicles = reading), BerthLocalState(tab = BerthSheetUi.TAB_SERVICE))
        assertTrue(service.loading); assertTrue(service.serviceLocked)
        // Another kingdom's starter view is not this kingdom's starter state.
        val foreign = fx.starterFleet().let { it.copy(view = it.view?.copy(baseId = "another-base")) }
        assertFalse(starterKnown(fx.inputs(starterFleet = foreign, vehicles = reading)))
    }

    @Test fun `the crafted answer replaces the starter card in place`() {
        // The read lands with a crafted vehicle: FLEET rows and the quay take over, the refresh line goes.
        val answered = berthSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(),
            vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)))), BerthLocalState())
        assertEquals(BerthSheetUi.TAB_FLEET, answered.panelKey)
        assertNotNull(answered.fleet); assertFalse(answered.refreshing); assertFalse(answered.loading)
        assertEquals(VehicleFamily.CARGO_CUTTER, answered.selectedFamily)
        // The read lands as "crafted vehicles are not open here" (QA's 503): the same starter card, now with the quiet line.
        val held = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(),
            vehicles = fx.vehicles().copy(unavailable = VehicleUnavailable.SERVICE_HELD)), BerthLocalState())
        assertEquals("FLEET_STARTER", held.panelKey); assertFalse(held.refreshing)
        assertEquals(CRAFTED_VEHICLES_OFF, requireNotNull(held.starter).craftedOff)
        // A real failure keeps the boat under RETRY and stops the refresh line (the read has settled).
        val failed = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(),
            vehicles = fx.vehicles().copy(error = "Connection interrupted. Please retry.")), BerthLocalState())
        assertNotNull(failed.readError); assertTrue(requireNotNull(failed.starter).installed); assertFalse(failed.refreshing)
    }
}
