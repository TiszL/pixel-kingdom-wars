package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleUnavailable
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ServiceOp
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The Berth's crafted money doors (S3, night 2026-10-06). Why it matters: installing or servicing a crafted vehicle burns a
 * wallet NFT and pays SOL, and that reviewed sequence with its wallet approval exists only in the existing Vehicle
 * controls. So a designed picker card or SERVICE primary may only open those controls, never start a burn here, and only
 * when the selected service could actually run; a dead "not available" toast on a working system is the defect this
 * replaces. The free starter install must not depend on the crafted fleet read.
 */
class BerthHandoffTest {
    private val fx = VoyageFx
    private val reviewUnavailable = "Crafted install and service reviews are not available here yet."

    private fun berthUi(local: BerthLocalState = BerthLocalState(), left: Int = 7, tier: Int = 2, away: Boolean = false,
        assets: JsonObject? = fx.assets("A1" to ("survey_balloon" to 1)), review: String? = reviewUnavailable) =
        berthSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(),
            vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", tier, left, away = away)), assets = assets)), local)
            .copy(reviewUnavailable = review)

    private fun Calls.withControls() = this.berth().copy(openCraftedControls = { this.log += "controls" })

    private val picker = BerthLocalState(section = BERTH_SECTION_INSTALL, selectedFamily = VehicleFamily.SURVEY_BALLOON)
    private val service = BerthLocalState(tab = BerthSheetUi.TAB_SERVICE)

    @Test fun `picking a wallet vehicle hands off to the existing vehicle controls and never toasts a money refusal`() {
        val ui = berthUi(picker)
        assertEquals("FLEET_INSTALL", ui.panelKey)
        assertEquals(listOf("A1"), requireNotNull(ui.install).assets.map { it.assetId })
        val calls = Calls()
        berthSheetActions(ui, calls.withControls()).install.onPickAsset("A1")
        // Exactly one handoff: no wallet read, no check, no review start and no refusal toast.
        assertEquals(listOf("controls"), calls.log)
    }

    @Test fun `service hands off only when its option is available and the vehicle is docked`() {
        // Worn out with a matching T2 in the wallet: RESTORE can run, so the controls that perform it open.
        val ready = berthUi(service, left = 0, assets = fx.assets("A2" to ("cargo_cutter" to 2)))
        assertEquals(ServiceOp.RESTORE_USES, ready.service.selectedOp)
        val readyCalls = Calls()
        berthSheetActions(ready, readyCalls.withControls()).service.onServiceConfirm()
        assertEquals(listOf("controls"), readyCalls.log)

        // No matching vehicle to hand in: the primary's own reason, never the controls.
        val missing = Calls()
        berthSheetActions(berthUi(service, left = 0, assets = fx.assets()), missing.withControls()).service.onServiceConfirm()
        assertEquals(listOf("toast:You need a Cargo Cutter T2 in your wallet"), missing.log)

        // A T4 cannot be upgraded: the LOCKED reason, never the controls.
        val maxTier = Calls()
        berthSheetActions(berthUi(service, tier = 4, left = 3, assets = fx.assets("A4" to ("cargo_cutter" to 4))), maxTier.withControls())
            .service.onServiceConfirm()
        assertEquals(listOf("toast:Max tier"), maxTier.log)

        // The same available UPGRADE while the vehicle is at sea waits for it to dock.
        val docked = Calls()
        berthSheetActions(berthUi(service, left = 3, assets = fx.assets("A2" to ("cargo_cutter" to 2))), docked.withControls())
            .service.onServiceConfirm()
        assertEquals(listOf("controls"), docked.log)
        val atSea = Calls()
        berthSheetActions(berthUi(service, left = 3, away = true, assets = fx.assets("A2" to ("cargo_cutter" to 2))), atSea.withControls())
            .service.onServiceConfirm()
        assertEquals(listOf("toast:Back in $UNKNOWN"), atSea.log)
    }

    @Test fun `without the handoff hook the honest refusal stays`() {
        // A host that offers no controls keeps today's refusal for both money doors.
        val pick = Calls()
        berthSheetActions(berthUi(picker), pick.berth()).install.onPickAsset("A1")
        val serve = Calls()
        berthSheetActions(berthUi(service, left = 0, assets = fx.assets("A2" to ("cargo_cutter" to 2))), serve.berth()).service.onServiceConfirm()
        assertEquals(listOf("toast:$reviewUnavailable"), pick.log)
        assertEquals(listOf("toast:$reviewUnavailable"), serve.log)

        // The hook replaces only the "not available here" refusal: once a sheet Seal is admitted (no refusal) it is unused.
        val admitted = Calls()
        val actions = berthSheetActions(berthUi(picker, review = null), admitted.withControls())
        actions.install.onPickAsset("A1")
        assertEquals(listOf("toast:$VOYAGE_MONEY_PENDING"), admitted.log)
    }

    @Test fun `free starter install stays reachable when the crafted fleet read failed`() {
        val failed = fx.vehicles().copy(error = "private response detail")
        val ui = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(installation = null), vehicles = failed), BerthLocalState())
        assertFalse(ui.loading)
        assertNotNull(ui.readError)
        assertNull("no guessed fleet behind the failed read", ui.fleet)
        assertEquals("FLEET_STARTER", ui.panelKey)
        assertTrue(requireNotNull(ui.starter).available)
        val calls = Calls()
        val actions = berthSheetActions(ui, calls.berth())
        actions.starter.onInstallStarter()
        actions.starter.onCraftLink()
        actions.starter.onFamilyTeaser(VehicleFamily.CARGO_CUTTER)
        assertEquals(listOf("starterInstall", "go:SOLANA_WORKSHOP:null", "toast:Craft one at Solana Island ▸"), calls.log)

        // An installed starter is never offered again just because the crafted read failed.
        // Rewritten 2026-10-06 (owner Seeker, QA): this pinned `installed.starter == null`, so right after INSTALL FREE the boat
        // vanished behind RETRY and the player could not see it was installed. It now stays as installed: not available, its
        // primary goes to the Lodge (never a second install), and RETRY stays for the real crafted read failure.
        val installed = berthSheetUi(fx.inputs(starterFleet = fx.starterFleet(), vehicles = failed), BerthLocalState())
        val boat = requireNotNull(installed.starter)
        assertTrue(boat.installed); assertFalse(boat.available)
        assertNull("a real failure is not the feature off", boat.craftedOff)
        assertEquals("FLEET_STARTER", installed.panelKey)
        assertNotNull(installed.readError)
        val again = Calls(); berthSheetActions(installed, again.berth()).starter.onInstallStarter()
        assertEquals(listOf("go:LODGE_SEND:null"), again.log)
    }

    @Test fun `a loading or failed fleet read still switches tabs while an unavailable server keeps them closed`() {
        val states = listOf(fx.vehicles(), fx.vehicles().copy(error = "x"))
        for (state in states) {
            val ui = berthSheetUi(fx.inputs(vehicles = state), BerthLocalState())
            var next: BerthLocalState? = null
            val calls = Calls()
            berthSheetActions(ui, calls.berth { next = it }).onTab(BerthSheetUi.TAB_SERVICE)
            assertEquals(listOf("update"), calls.log)
            assertEquals(BerthSheetUi.TAB_SERVICE, next?.tab)
        }
        val held = berthSheetUi(fx.inputs(vehicles = fx.vehicles().copy(unavailable = VehicleUnavailable.SERVICE_HELD)), BerthLocalState())
        val calls = Calls()
        berthSheetActions(held, calls.berth()).onTab(BerthSheetUi.TAB_SERVICE)
        assertTrue(calls.log.isEmpty())
    }
}
