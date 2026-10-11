package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.data.VehicleState
import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ServiceOp
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/** A9 sheet component; VehicleUnavailable is the coordinated C3 data dependency. No Compose/runtime substitute. */
class BerthUnavailableStateTest {
    private val fx = VoyageFx
    private val copy = "Vehicles are not open on this server yet"
    private fun assertUnavailable(ui: BerthSheetUi) {
        val empty = requireNotNull(ui.unavailable)
        assertEquals("FLEET", empty.headline); assertEquals(copy, empty.reason)
        assertNull(empty.go); assertNull(empty.goLabel)
        assertEquals(BerthSheetUi.PANEL_UNAVAILABLE, ui.panelKey)
        assertTrue("Unknown fleet never becomes five empty slots", ui.quay.isEmpty())
        assertNull(ui.selectedFamily); assertNull(ui.fleet); assertNull(ui.install); assertNull(ui.starter)
        assertTrue(ui.service.installed.isEmpty()); assertTrue(ui.serviceLocked)
    }

    @Test fun `missing policy is unavailable before any owner read or exception exists`() {
        for (state in listOf(null, VehicleState())) {
            assertUnavailable(berthSheetUi(fx.inputs(vehicles = state, policy = VoyagePolicyFacts()), BerthLocalState()))
        }
    }

    @Test fun `typed missing policy remains closed until its owner replaces the refusal`() {
        val state = fx.vehicles().copy(unavailable = VehicleUnavailable.MISSING_POLICY)
        assertUnavailable(berthSheetUi(fx.inputs(vehicles = state), BerthLocalState()))
    }

    @Test fun `held service hides retained fleet and wallet rows without consuming saved history`() {
        val original = VehicleRecord("saved", "installation", "original-key", JsonObject(emptyMap()), JsonObject(emptyMap()))
        val state = fx.vehicles(fleet = fx.fleet(fx.row("installed", "cargo_cutter", 2, 7)),
            assets = fx.assets("owned" to ("cargo_cutter" to 2)), pending = listOf(original))
            .copy(unavailable = VehicleUnavailable.SERVICE_HELD, error = "raw server detail")
        val ui = berthSheetUi(fx.inputs(vehicles = state), BerthLocalState())
        assertUnavailable(ui); assertTrue(ui.history)
        assertSame(original, state.journal!!.pending.single())
        assertNotNull(state.fleet); assertNotNull(state.assets)
    }

    @Test fun `unavailable callbacks perform no load review dispatch or navigation except explicit history and close`() {
        for (reason in VehicleUnavailable.entries) {
            val ui = berthSheetUi(fx.inputs(vehicles = fx.vehicles().copy(unavailable = reason)), BerthLocalState())
            val calls = Calls(); val actions = berthSheetActions(ui, calls.berth())
            actions.onTab("SERVICE"); actions.onSlot(VehicleFamily.CARGO_CUTTER)
            actions.fleet.onSelect(VehicleFamily.CARGO_CUTTER)
            actions.fleet.onInstall(VehicleFamily.CARGO_CUTTER); actions.fleet.onCraftLink()
            actions.fleet.onSendFromLodge("installed"); actions.fleet.onService("installed"); actions.fleet.onCheckInstall(VehicleFamily.CARGO_CUTTER)
            actions.starter.onInstallStarter(); actions.starter.onCraftLink(); actions.starter.onFamilyTeaser(VehicleFamily.CARGO_CUTTER)
            actions.starter.onGoLodge()
            actions.install.onBack(); actions.install.onPickAsset("owned"); actions.install.onMore(); actions.install.onCraftLink()
            actions.service.onPickVehicle("installed"); actions.service.onAwayVehicle("installed")
            actions.service.onPickOp(ServiceOp.UPGRADE); actions.service.onHandInGo(); actions.service.onServiceConfirm()
            actions.service.onRecover(); actions.service.onGoFleet()
            assertTrue("No hidden action survives $reason", calls.log.isEmpty())
            actions.onHistory(); actions.onClose()
            assertEquals(listOf("go:HISTORY:null", "close"), calls.log)
        }
    }

    // Rewritten 2026-10-06 (owner Seeker, QA server with the vehicles feature switched off): this case pinned that a held
    // crafted service hid the free starter panel unless the player had opened it explicitly, and that a present vehicle owner
    // never offered INSTALL FREE. On QA that closed the whole Berth: the player could neither install the free boat nor see
    // it once installed. The rule now: crafted unavailability closes only the crafted panels (quay, fleet rows, picker,
    // SERVICE); a starter owner keeps its panel on FLEET with the quiet crafted-off line, and SERVICE says so honestly.
    @Test fun `unavailable service closes crafted panels but keeps the free starter panel of a starter owner`() {
        val state = fx.vehicles().copy(unavailable = VehicleUnavailable.SERVICE_HELD)
        val locals = listOf(BerthLocalState(tab = "SERVICE"), BerthLocalState(section = BERTH_SECTION_STARTER),
            BerthLocalState(section = BERTH_SECTION_INSTALL, selectedFamily = VehicleFamily.CARGO_CUTTER, installAssetId = "owned"))
        for (local in locals) {
            val ui = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(), vehicles = state), local)
            // 636db729: crafted availability must not retire the explicit, independent free-starter door.
            assertNotNull(ui.unavailable); assertNotNull(ui.starter)
            assertTrue("Unknown fleet never becomes five empty slots", ui.quay.isEmpty())
            assertNull(ui.selectedFamily); assertNull(ui.fleet); assertNull(ui.install)
            assertTrue(ui.service.installed.isEmpty()); assertTrue(ui.serviceLocked)
            assertTrue(requireNotNull(ui.starter).installed)
            assertEquals(CRAFTED_VEHICLES_OFF, requireNotNull(ui.starter).craftedOff)
            if (local.tab == BerthSheetUi.TAB_SERVICE) {
                assertEquals(BerthSheetUi.PANEL_UNAVAILABLE, ui.panelKey)
                assertEquals(BerthSheetUi.TAB_SERVICE, requireNotNull(ui.unavailable).headline)
                assertEquals(CRAFTED_VEHICLES_OFF, requireNotNull(ui.unavailable).reason)
            } else {
                assertEquals("FLEET_STARTER", ui.panelKey)
                val calls = Calls(); val actions = berthSheetActions(ui, calls.berth())
                actions.starter.onInstallStarter(); actions.starter.onGoLodge()
                assertEquals(listOf("go:LODGE_SEND:null", "go:LODGE_SEND:null"), calls.log)
            }
        }
        // Preserve exactly the a9 default: absent vehicle owner + no installed boat opens the free starter panel.
        val starter = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(installation = null), vehicles = null,
            policy = VoyagePolicyFacts()), BerthLocalState())
        assertEquals("FLEET_STARTER", starter.panelKey); assertTrue(requireNotNull(starter.starter).available)
        val calls = Calls(); berthSheetActions(starter, calls.berth()).starter.onInstallStarter()
        assertEquals(listOf("starterInstall"), calls.log)
        // A present vehicle owner whose crafted service is held now offers the same free INSTALL FREE (the QA defect: a9 did not).
        val held = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(installation = null), vehicles = state), BerthLocalState())
        assertEquals("FLEET_STARTER", held.panelKey); assertTrue(requireNotNull(held.starter).available)
        val heldCalls = Calls(); berthSheetActions(held, heldCalls.berth()).starter.onInstallStarter()
        assertEquals(listOf("starterInstall"), heldCalls.log)
        // No starter owner at all still keeps the closed body: nothing is invented.
        assertUnavailable(berthSheetUi(fx.inputs(vehicles = state), BerthLocalState()))
    }

    @Test fun `a retryable read failure is not converted into a service hold by its message`() {
        for (message in listOf("Connection interrupted. Please retry.", "Required value was null.", copy)) {
            val state = fx.vehicles().copy(error = message)
            val ui = berthSheetUi(fx.inputs(vehicles = state), BerthLocalState())
            assertNull(ui.unavailable); assertNull(ui.fleet)
            assertEquals(BerthSheetUi.TAB_FLEET, ui.panelKey)
        }
    }

    @Test fun `fresh available fleet returns to the existing projection without sticky unavailable state`() {
        val state = fx.vehicles(fleet = fx.fleet(fx.row("installed", "cargo_cutter", 2, 7)))
        assertUnavailable(berthSheetUi(fx.inputs(vehicles = state.copy(unavailable = VehicleUnavailable.SERVICE_HELD)), BerthLocalState()))
        val available = berthSheetUi(fx.inputs(vehicles = state), BerthLocalState())
        assertNull(available.unavailable); assertNotNull(available.fleet)
        assertEquals("installed", available.quay.single { it.family == VehicleFamily.CARGO_CUTTER }.installationId)
    }

    @Test fun `both unavailable causes reuse the existing copy and no cause has no message`() {
        assertNull(vehicleUnavailableReason(null))
        VehicleUnavailable.entries.forEach { assertEquals(copy, vehicleUnavailableReason(it)) }
    }
}
