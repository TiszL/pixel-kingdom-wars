package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.*
import gg.pixelkingdomwars.nativeclient.starter.*
import org.junit.Assert.*
import org.junit.Test

/** 93056118/9a66094e: designed read bodies and the existing free owner; no new money or legacy form callback. */
class BerthLiveBodyMountTest {
    @Test fun `unknown fleet is loading with no fabricated empty quay or service verdict`() {
        for (tab in listOf("FLEET", "SERVICE")) {
            val ui = berthSheetUi(VoyageFx.inputs(vehicles = VoyageFx.vehicles()), BerthLocalState(tab = tab))
            assertTrue(ui.loading)
            assertTrue(ui.quay.isEmpty())
            assertNull(ui.fleet)
            assertNull(ui.readError)
            assertTrue(ui.serviceLocked)
        }
    }

    @Test fun `read failure shows retryable safe copy inside the designed body`() {
        val ui = berthSheetUi(VoyageFx.inputs(vehicles = VoyageFx.vehicles().copy(error = "private response detail")), BerthLocalState())
        assertFalse(ui.loading)
        assertEquals("Fleet details could not be refreshed. Try again.", ui.readError)
        assertNull(ui.unavailable)
        assertTrue(ui.quay.isEmpty())
    }

    @Test fun `current installed fleet feeds FLEET and SERVICE with server trips`() {
        val input = VoyageFx.inputs(vehicles = VoyageFx.vehicles(fleet = VoyageFx.fleet(VoyageFx.row("current", "cargo_cutter", 2, 7))))
        val fleet = berthSheetUi(input, BerthLocalState())
        val service = berthSheetUi(input, BerthLocalState(tab = "SERVICE"))
        assertFalse(fleet.loading)
        assertEquals("current", fleet.fleet!!.berths.single { it.family == VehicleFamily.CARGO_CUTTER }.installationId)
        assertEquals("current", service.service.selectedInstallationId)
        assertEquals(7, service.service.installed.single().tripsLeft)
        assertEquals("SERVICE", service.panelKey)
    }

    @Test fun `unknown loading body callbacks cannot select fabricated slots or start reviews`() {
        val ui = berthSheetUi(VoyageFx.inputs(vehicles = VoyageFx.vehicles()), BerthLocalState())
        val calls = Calls(); val actions = berthSheetActions(ui, calls.berth())
        actions.onSlot(VehicleFamily.CARGO_CUTTER)
        actions.fleet.onInstall(VehicleFamily.CARGO_CUTTER)
        actions.starter.onInstallStarter()
        actions.service.onServiceConfirm()
        assertTrue(calls.log.isEmpty())
        actions.onClose()
        assertEquals(listOf("close"), calls.log)
    }

    @Test fun `Home review boundary refuses crafted actions while free starter reaches its existing reviewed owner`() {
        val ui = berthSheetUi(VoyageFx.inputs(starterFleet = VoyageFx.starterFleet(installation = null),
            vehicles = VoyageFx.vehicles(fleet = VoyageFx.fleet())), BerthLocalState(section = "starter"))
            .copy(reviewUnavailable = "Review is not available here yet")
        val calls = Calls(); val actions = berthSheetActions(ui, calls.berth())
        actions.starter.onInstallStarter()
        actions.install.onPickAsset("owned")
        actions.service.onServiceConfirm()
        assertEquals(listOf("starterInstall", "toast:Review is not available here yet",
            "toast:Review is not available here yet"), calls.log)
    }

    @Test fun `crafted unavailability keeps the free starter owner callback but no crafted review`() {
        val ui = berthSheetUi(VoyageFx.inputs(starterFleet = VoyageFx.starterFleet(installation = null),
            vehicles = VoyageFx.vehicles(), policy = VoyagePolicyFacts()), BerthLocalState(section = "starter"))
            .copy(reviewUnavailable = "Crafted reviews unavailable")
        val calls = Calls(); val actions = berthSheetActions(ui, calls.berth())
        assertEquals("FLEET_STARTER", ui.panelKey)
        actions.starter.onInstallStarter()
        actions.install.onPickAsset("owned"); actions.service.onServiceConfirm()
        assertEquals(listOf("starterInstall"), calls.log)

        val before = VoyageFx.starterFleet(installation = null)
        val view = requireNotNull(before.view)
        val command = StarterFleetCommand(StarterFleetRequest("saved-key", VoyageFx.BASE, "berth-1"), view.eligibleBerths.single(), null)
        val receipt = StarterFleetReceipt(VoyageFx.WALLET, command.request, VoyageFx.starterInstallation, view.serverNow)
        val proof = StarterFleetProof(VoyageFx.WALLET, command.key, view.serverNow, "accepted", receipt)
        val accepted = before.copy(journal = before.journal.copy(operation = StarterFleetOperation(command, 1L, proof, null)))
        val confirmed = berthSheetUi(VoyageFx.inputs(starterFleet = accepted, vehicles = VoyageFx.vehicles(), policy = VoyagePolicyFacts()),
            BerthLocalState(section = "starter"))
        assertNull(accepted.view?.installation) // Confirmation has not refreshed the old view.
        assertTrue(requireNotNull(confirmed.starter).installed); assertFalse(requireNotNull(confirmed.starter).available)
        val confirmedCalls = Calls(); berthSheetActions(confirmed, confirmedCalls.berth()).starter.onInstallStarter()
        assertEquals(listOf("go:LODGE_SEND:null"), confirmedCalls.log)
        val foreignProof = proof.copy(receipt = receipt.copy(installation = VoyageFx.starterInstallation.copy(baseId = "another-base")))
        val foreign = accepted.copy(journal = accepted.journal.copy(operation = accepted.journal.operation?.copy(proof = foreignProof)))
        assertFalse(requireNotNull(berthSheetUi(VoyageFx.inputs(starterFleet = foreign, vehicles = VoyageFx.vehicles(), policy = VoyagePolicyFacts()),
            BerthLocalState(section = "starter")).starter).installed)
    }

    @Test fun `explicit starter remains usable while a present crafted fleet has no snapshot`() {
        val ui = berthSheetUi(VoyageFx.inputs(starterFleet = VoyageFx.starterFleet(installation = null),
            vehicles = VoyageFx.vehicles()), BerthLocalState(section = "starter"))
        assertFalse(ui.loading); assertEquals("FLEET_STARTER", ui.panelKey)
        val calls = Calls(); berthSheetActions(ui, calls.berth()).starter.onInstallStarter()
        assertEquals(listOf("starterInstall"), calls.log)
    }
}
