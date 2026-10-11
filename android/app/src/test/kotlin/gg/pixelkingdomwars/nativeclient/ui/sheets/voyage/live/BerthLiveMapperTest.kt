package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.BerthSheetUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.ServiceOp
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VoyageSealState
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The live Berth (quay, FLEET, starter, install picker, SERVICE). Why it matters: installing and servicing a crafted
 * vehicle BURNS a wallet asset and pays SOL. Until MS-M3 wires those Seals, no tap here may start one — a single stray
 * call would destroy a player's NFT. And the quay must never claim a berth is empty, or a wallet has none, on data the
 * server has not fully sent.
 */
class BerthLiveMapperTest {
    private val fx = VoyageFx

    private fun berth(local: BerthLocalState = BerthLocalState(), walletLinked: Boolean = true, left: Int = 7, tier: Int = 2,
        assets: JsonObject? = fx.assets("A1" to ("survey_balloon" to 1)), pending: List<VehicleRecord> = emptyList()) =
        berthSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(), walletLinked = walletLinked,
            vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", tier, left)), assets = assets, pending = pending)), local)

    // Rewritten 2026-10-06 (owner: "remove pre chosen spots for placing vehicles"). The quay used to be five fixed family spots
    // that all pointed at the first Berth. The FLEET rows keep one row per family (the server allows one install per family
    // per base); the quay header now shows the player's own Berths, one slot per placed Berth building.
    @Test fun `FLEET reads one row per family, starter first, and the quay reads the player's own Berths`() {
        val ui = berth()
        val rows = ui.fleet!!.berths
        assertEquals(VehicleFamily.entries.toList(), rows.map { it.family })
        assertEquals(VehicleStatus.DOCKED, rows[0].status)
        assertEquals(listOf(VehicleStatus.EMPTY, VehicleStatus.DOCKED, VehicleStatus.EMPTY, VehicleStatus.EMPTY), rows.drop(1).map { it.status })
        assertEquals("the first crafted vehicle is selected", VehicleFamily.CARGO_CUTTER, ui.selectedFamily)
        assertEquals("7 of 10 trips: tripsMax is the policy's trips-per-install", 10, rows[2].tripsMax)
        assertEquals("LV 5", ui.level)
        assertEquals("one Berth building, one quay slot", listOf("berth-1"), ui.quay.map { it.berthId })
    }

    @Test fun `wallet counts say 0 only when the server sent the last page`() {
        val complete = walletCounts(fx.assets("A1" to ("survey_balloon" to 1)))!!
        assertEquals(1, complete[VehicleFamily.SURVEY_BALLOON])
        assertEquals(0, complete[VehicleFamily.EXPEDITION_BARGE])
        val partial = walletCounts(fx.assets("A1" to ("survey_balloon" to 1), nextCursor = "next"))!!
        assertNull("more pages exist: unknown, not 0", partial[VehicleFamily.EXPEDITION_BARGE])
        assertNull("no snapshot: unknown", walletCounts(null))
    }

    @Test fun `INSTALL without a wallet says why and loads nothing`() {
        val ui = berth(walletLinked = false)
        val calls = Calls()
        berthSheetActions(ui, calls.berth()).fleet.onInstall(VehicleFamily.SURVEY_BALLOON)
        assertEquals(listOf("Link a wallet in Profile to install vehicles"), calls.toasts)
        assertTrue(calls.log.none { it.startsWith("assets") })
    }

    // Rewritten 2026-10-06 (free placement): INSTALL now needs a vacant Berth. This fixture's only Berth holds the starter boat,
    // which the server refuses for a crafted vehicle (VEHICLE_BERTH_OCCUPIED), so a second, vacant Berth keeps this case about
    // the picker read and the refused money pick.
    @Test fun `INSTALL opens the wallet picker (a read) but picking a vehicle is refused until MS-M3`() {
        var next: BerthLocalState? = null
        val calls = Calls()
        val withVacant = fx.buildings + Building("berth-2", "berth", 1, 8, 0)
        fun sheet(local: BerthLocalState) = berthSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(),
            buildings = withVacant, vehicles = fx.vehicles(fx.fleet(fx.row("inst-cut", "cargo_cutter", 2, 7)),
                assets = fx.assets("A1" to ("survey_balloon" to 1)))), local)
        berthSheetActions(sheet(BerthLocalState()), calls.berth { next = it }).fleet.onInstall(VehicleFamily.SURVEY_BALLOON)
        assertEquals(BERTH_SECTION_INSTALL, next?.section)
        assertEquals("the vacant Berth, never the starter's", "berth-2", next?.selectedBerthId)
        assertTrue(calls.log.contains("assets:null"))
        val picker = sheet(next!!)
        val install = picker.install!!
        assertEquals(listOf("A1"), install.assets.map { it.assetId })
        assertNull("the fee review is a money step: never pre-filled", install.feeSol)
        val pick = Calls()
        berthSheetActions(picker, pick.berth()).install.onPickAsset("A1")
        assertEquals(listOf("toast:$VOYAGE_MONEY_PENDING"), pick.log)
    }

    @Test fun `SERVICE never starts a burn - an enabled RESTORE is refused with the MS-M3 reason, a blocked one says its own`() {
        val withHandIn = berth(left = 0, assets = fx.assets("A2" to ("cargo_cutter" to 2)))
        assertEquals(ServiceOp.RESTORE_USES, withHandIn.service.selectedOp)
        assertEquals("A2", withHandIn.service.handIn?.assetId)
        val calls = Calls()
        berthSheetActions(withHandIn, calls.berth()).service.onServiceConfirm()
        assertEquals(listOf("toast:$VOYAGE_MONEY_PENDING"), calls.log)
        val noHandIn = berth(left = 0, assets = fx.assets())
        val refused = Calls()
        berthSheetActions(noHandIn, refused.berth()).service.onServiceConfirm()
        assertEquals(listOf("You need a Cargo Cutter T2 in your wallet"), refused.toasts)
    }

    @Test fun `service options come from the policy only`() {
        val top = berth(tier = 4, left = 3).service.options
        val upgrade = top.single { it.op == ServiceOp.UPGRADE }
        assertFalse(upgrade.available)
        assertEquals("Max tier", upgrade.reason)
        val restore = top.single { it.op == ServiceOp.RESTORE_USES }
        assertFalse("restore only at zero trips left", restore.available)
        assertEquals(10, restore.resultTrips)
        // Rewritten 2026-10-06: the cutter is the FLEET row (the quay is now per Berth building, not per family).
        val unknown = serviceOptions(berth().fleet!!.berths[2], VoyagePolicyFacts())
        assertFalse(unknown.single { it.op == ServiceOp.UPGRADE }.available)
    }

    @Test fun `an earlier session's service in flight is uncertain - CHECK, never Nothing was sent`() {
        val inFlight = VehicleRecord("s1", "service", "key-s1", fx.obj("""{"installationId":"inst-cut","assetId":"A2","operation":"restore_uses",
            "idempotencyKey":"key-s1"}"""), JsonObject(emptyMap()))
        val service = berth(left = 0, pending = listOf(inFlight)).service
        assertEquals(VoyageSealState.ERROR, service.sealState)
        assertFalse(service.error!!.authoritative)
        assertTrue(service.error!!.recoverable)
    }

    @Test fun `FLEET waits for the fleet snapshot instead of drawing guessed EMPTY rows`() {
        val ui = berthSheetUi(fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(), vehicles = fx.vehicles(fleet = null)), BerthLocalState())
        assertNull(ui.fleet)
    }

    @Test fun `the free starter install keeps its existing review, and a paused server says so`() {
        val open = berthSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)), starterFleet = fx.starterFleet(installation = null)),
            BerthLocalState(section = BERTH_SECTION_STARTER))
        assertTrue(open.starter!!.available)
        val calls = Calls()
        berthSheetActions(open, calls.berth()).starter.onInstallStarter()
        assertEquals(listOf("starterInstall"), calls.log)
        val paused = berthSheetUi(fx.inputs(starter = fx.starter(fx.starterView(installation = null)),
            starterFleet = fx.starterFleet(installation = null, accepting = false)), BerthLocalState(section = BERTH_SECTION_STARTER))
        assertFalse(paused.starter!!.available)
        val refused = Calls()
        berthSheetActions(paused, refused.berth()).starter.onInstallStarter()
        assertEquals(listOf("Starter installs are paused on this server"), refused.toasts)
        assertEquals(BerthSheetUi.TAB_FLEET, paused.tab)
    }
}
