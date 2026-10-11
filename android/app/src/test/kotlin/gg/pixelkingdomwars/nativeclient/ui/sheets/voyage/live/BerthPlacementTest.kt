package gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.live

import gg.pixelkingdomwars.nativeclient.data.VehicleRecord
import gg.pixelkingdomwars.nativeclient.model.AdvancedBerthPresentation
import gg.pixelkingdomwars.nativeclient.model.AdvancedInstallationPresentation
import gg.pixelkingdomwars.nativeclient.model.AdvancedPresence
import gg.pixelkingdomwars.nativeclient.model.AdvancedServicePresentation
import gg.pixelkingdomwars.nativeclient.model.BaseServicePresentation
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.BerthPresentation
import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.model.PlayerSummary
import gg.pixelkingdomwars.nativeclient.model.StarterPresence
import gg.pixelkingdomwars.nativeclient.model.StarterPresentation
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.PLACE_BERTH_SUB
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleFamily
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.VehicleStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.berthInstallLook
import gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.fleetPrimary
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Free vehicle placement (owner, 2026-10-06: "cant install exploration vehicles and (we should remove pre chosen spots for
 * placing vehicles) player should be able to install them where they want as on other buildings").
 *
 * Why it matters: the server installs one vehicle per Berth building and refuses a Berth that already holds one
 * (VEHICLE_BERTH_OCCUPIED). The sheet used to send every crafted family to the FIRST Berth, the one holding the starter
 * boat, so the install could never succeed. A vehicle now goes into a vacant Berth the player placed, and with none the base
 * enters the ordinary building placement for a new Berth. A wrong answer here either burns a player's NFT toward a refusal,
 * builds a Berth for nothing (it costs SHARDS and a builder), or leaves INSTALL a door that does nothing.
 */
class BerthPlacementTest {
    private val fx = VoyageFx
    private val berth2 = Building("berth-2", "berth", 1, 8, 0)
    private val berth3 = Building("berth-3", "berth", 1, 12, 0)

    /** The starter boat sits in berth-1 (the fixture's install); [rows] are the crafted fleet. */
    private fun inputs(buildings: List<Building> = fx.buildings, rows: List<String> = emptyList(),
        assets: JsonObject? = fx.assets("A1" to ("survey_balloon" to 1)), records: List<VehicleRecord> = emptyList(),
        placement: BerthPlacementFacts? = BerthPlacementFacts(true), opened: String? = null): VoyageLiveInputs =
        fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(), buildings = buildings,
            vehicles = fx.vehicles(fx.fleet(*rows.toTypedArray()), assets = assets, pending = records))
            .copy(berthPlacement = placement, selectedBerthId = opened)

    private fun Calls.placing() = this.berth().copy(placeBerth = { this.log += "place" })

    @Test fun `a crafted vehicle never installs into the Berth that holds the starter boat`() {
        // One Berth, the starter's: nothing is vacant, so INSTALL places a new Berth instead of targeting berth-1.
        assertEquals(BerthInstallDoor.Place, berthInstallDoor(inputs(), null))
        val ui = berthSheetUi(inputs(), BerthLocalState())
        assertNull(ui.fleet!!.installBerthId)
        assertTrue(ui.fleet!!.placeBerth)
        val balloon = ui.fleet!!.berths.single { it.family == VehicleFamily.SURVEY_BALLOON }
        assertEquals("an empty family row names no pre-chosen Berth", "", balloon.berthId)

        // A placed, vacant Berth is the destination; the starter's and the cutter's Berths are not.
        val three = inputs(buildings = fx.buildings + berth2 + berth3, rows = listOf(fx.row("inst-cut", "cargo_cutter", 2, 7, berth = "berth-2")))
        assertEquals(listOf("berth-3"), vacantBerthIds(three))
        assertEquals(BerthInstallDoor.Into("berth-3"), berthInstallDoor(three, null))
        assertEquals("berth-3", berthSheetUi(three, BerthLocalState()).fleet!!.installBerthId)
    }

    @Test fun `INSTALL with no vacant Berth places a new Berth where the player wants and reads nothing`() {
        val ui = berthSheetUi(inputs(), BerthLocalState(selectedFamily = VehicleFamily.SURVEY_BALLOON))
        assertTrue("the + slot offers a new Berth", ui.placeSlot)
        val calls = Calls()
        berthSheetActions(ui, calls.placing()).fleet.onInstall(VehicleFamily.SURVEY_BALLOON)
        assertEquals(listOf("place"), calls.log)
        // The primary says what the tap does.
        val row = ui.fleet!!.berths.single { it.family == VehicleFamily.SURVEY_BALLOON }
        val look = berthInstallLook(fleetPrimary(row, false, null, true, true).look!!, ui.fleet!!, VehicleFamily.SURVEY_BALLOON)
        assertEquals(PLACE_BERTH_SUB, look.sub)
        assertEquals(CommandState.ENABLED, look.state)
        // The quay's + slot is the same door.
        val plus = Calls()
        berthSheetActions(ui, plus.placing()).onPlaceBerth()
        assertEquals(listOf("place"), plus.log)
        // A host without the placement door explains, never does nothing.
        val bare = Calls()
        berthSheetActions(ui, bare.berth()).fleet.onInstall(VehicleFamily.SURVEY_BALLOON)
        assertEquals(listOf(BERTH_PLACE_FROM_BUILD), bare.toasts)
    }

    @Test fun `a Berth still being built, a full base and an unknown fleet each say why and place nothing`() {
        val building = inputs(buildings = fx.buildings + Building("berth-2", "berth", 0, 8, 0, underConstruction = true))
        assertEquals(BerthInstallDoor.Refused(BERTH_BEING_BUILT), berthInstallDoor(building, null))

        val full = inputs(placement = BerthPlacementFacts(false, "Berth limit reached · max 5"))
        val ui = berthSheetUi(full, BerthLocalState(selectedFamily = VehicleFamily.SURVEY_BALLOON))
        assertFalse(ui.placeSlot)
        assertEquals("Berth limit reached · max 5", ui.fleet!!.installBlockedReason)
        val calls = Calls()
        berthSheetActions(ui, calls.placing()).fleet.onInstall(VehicleFamily.SURVEY_BALLOON)
        assertEquals(listOf("toast:Berth limit reached · max 5"), calls.log)
        val row = ui.fleet!!.berths.single { it.family == VehicleFamily.SURVEY_BALLOON }
        val look = berthInstallLook(fleetPrimary(row, false, null, true, true).look!!, ui.fleet!!, VehicleFamily.SURVEY_BALLOON)
        assertEquals(CommandState.DISABLED, look.state)
        assertEquals("Berth limit reached · max 5", look.reason)

        val unknown = fx.inputs(starter = fx.starter(), starterFleet = fx.starterFleet(), vehicles = fx.vehicles(fleet = null))
        assertNull("no fleet snapshot: no guessed vacancy", vacantBerthIds(unknown))
        assertEquals(BerthInstallDoor.Refused(UNKNOWN), berthInstallDoor(unknown, null))
    }

    @Test fun `a reservation this device made keeps its Berth taken`() {
        // A server reservation is permanent, so its Berth is never offered again, even before the vehicle shows in the fleet.
        val reserved = VehicleRecord("r1", "installation", "key-r1", fx.obj("""{"baseId":"${VoyageFx.BASE}","berthId":"berth-2",
            "assetId":"A9","idempotencyKey":"key-r1"}"""), JsonObject(emptyMap()))
        val i = inputs(buildings = fx.buildings + berth2 + berth3, records = listOf(reserved))
        assertEquals(listOf("berth-3"), vacantBerthIds(i))
    }

    @Test fun `the quay shows the player's own Berths, not five fixed family spots`() {
        val i = inputs(buildings = fx.buildings + berth2 + berth3, rows = listOf(fx.row("inst-cut", "cargo_cutter", 2, 7, berth = "berth-2")))
        val ui = berthSheetUi(i, BerthLocalState())
        assertEquals(listOf("berth-1", "berth-2", "berth-3"), ui.quay.map { it.berthId })
        assertEquals(listOf(VehicleFamily.STARTER, VehicleFamily.CARGO_CUTTER), ui.quay.take(2).map { it.family })
        assertEquals(listOf(VehicleStatus.DOCKED, VehicleStatus.DOCKED, VehicleStatus.EMPTY), ui.quay.map { it.status })
        assertNull("a docked vehicle is selected: no install frame", ui.selectedBerthId)
        val installing = berthSheetUi(i, BerthLocalState(selectedFamily = VehicleFamily.SURVEY_BALLOON))
        assertEquals("the vacant Berth carries the install frame", "berth-3", installing.selectedBerthId)
    }

    @Test fun `the player chooses the Berth - a quay tap or the Berth they opened beats the first vacant one`() {
        val i = inputs(buildings = fx.buildings + berth2 + berth3)
        assertEquals(listOf("berth-2", "berth-3"), vacantBerthIds(i))
        assertEquals("berth-2", berthSheetUi(i, BerthLocalState()).fleet!!.installBerthId)

        var next: BerthLocalState? = null
        val calls = Calls()
        berthSheetActions(berthSheetUi(i, BerthLocalState()), calls.berth { next = it }).onBerthSlot("berth-3")
        assertEquals("berth-3", next?.selectedBerthId)
        assertEquals("the tap selects a family that can go there", VehicleFamily.SURVEY_BALLOON, next?.selectedFamily)
        assertEquals("berth-3", berthSheetUi(i, next!!).fleet!!.installBerthId)

        // Opening the vacant berth-3 from the base makes it the destination and selects a family it can take.
        val opened = berthSheetUi(inputs(buildings = fx.buildings + berth2 + berth3, opened = "berth-3"), BerthLocalState())
        assertEquals("berth-3", opened.fleet!!.installBerthId)
        assertEquals(VehicleFamily.SURVEY_BALLOON, opened.selectedFamily)
    }

    @Test fun `a wallet with none of the family opens the picker and builds no Berth for nothing`() {
        val ui = berthSheetUi(inputs(assets = fx.assets()), BerthLocalState(selectedFamily = VehicleFamily.SURVEY_BALLOON))
        assertTrue(ui.fleet!!.placeBerth)
        val calls = Calls()
        berthSheetActions(ui, calls.placing()).fleet.onInstall(VehicleFamily.SURVEY_BALLOON)
        assertFalse(calls.log.contains("place"))
        assertTrue("the picker (a read) shows the craft link instead", calls.log.contains("assets:null"))
    }

    @Test fun `a new Berth is offered only under the Keep gate and the server's advertised count`() {
        // Synthetic catalogue and capacity: the gate and count contract, not game numbers.
        val catalogue = fx.obj("""{"constants":{"BUILD_COSTS":{"berth":{"costShards":13,"buildSec":17,"requiresKeepLevel":3}},
            "BUILD_COUNT_CAP_BY_KEEP":{"berth":[0,0,1,1]}}}""")
        fun base(keep: Int, berths: Int, advertised: Int?) = BaseSnapshot(baseId = VoyageFx.BASE, visualContext = null,
            player = PlayerSummary(keepLevel = keep), energy = null, armyStatus = null, claim = null,
            buildings = List(berths) { Building("berth-$it", "berth", 1, it * 3, 0) }, obstacles = emptyList(), jobs = emptyList(),
            freeBuilders = 1, raw = if (advertised == null) JsonObject(emptyMap())
                else fx.obj("""{"constructionCapacity":{"version":1,"berth":{"max":$advertised}}}"""))
        assertEquals(BerthPlacementFacts(false, "Unlocks at Keep 3"), berthPlacementFacts(base(2, 0, null), catalogue, true))
        assertEquals(BerthPlacementFacts(false, "Berth limit reached · max 1"), berthPlacementFacts(base(3, 1, null), catalogue, true))
        assertEquals("the server's advertised capacity wins over the old table", BerthPlacementFacts(true),
            berthPlacementFacts(base(3, 1, 4), catalogue, true))
        assertEquals(BerthPlacementFacts(false, BERTH_PLACEMENT_UNAVAILABLE), berthPlacementFacts(base(3, 1, 4), catalogue, false))
        assertNull("unknown base: unknown, never a guess", berthPlacementFacts(null, catalogue, true))
    }

    @Test fun `the legacy Vehicle controls offer only vacant Berths`() {
        val buildings = listOf(Building("berth-1", "berth", 1, 0, 0), Building("berth-2", "berth", 1, 3, 0), Building("berth-3", "berth", 1, 6, 0))
        val base = BaseSnapshot(baseId = VoyageFx.BASE, visualContext = null, player = PlayerSummary(keepLevel = 5), energy = null,
            armyStatus = null, claim = null, buildings = buildings, obstacles = emptyList(), jobs = emptyList(), freeBuilders = 1,
            raw = JsonObject(emptyMap()),
            servicePresentation = BaseServicePresentation(1, listOf(
                BerthPresentation("berth-1", StarterPresentation("starter", StarterPresence.OCCUPIED)),
                BerthPresentation("berth-2", null), BerthPresentation("berth-3", null))),
            advancedServicePresentation = AdvancedServicePresentation(1, listOf(AdvancedBerthPresentation("berth-1", null),
                AdvancedBerthPresentation("berth-2", AdvancedInstallationPresentation("cargo_cutter", 2, AdvancedPresence.OCCUPIED)),
                AdvancedBerthPresentation("berth-3", null))))
        assertEquals("the starter's and the cutter's Berths are never offered", listOf("berth-3"), vacantBerthsForInstall(base, emptyList()))
        assertEquals("a reserved Berth is never offered again", emptyList<String>(), vacantBerthsForInstall(base, listOf("berth-3")))
    }
}
