package gg.pixelkingdomwars.nativeclient.ui.world

import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandOwner
import gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandOwners
import gg.pixelkingdomwars.nativeclient.ui.phasee.VehicleEntryPoint
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * The craft-vehicle door (owner 2026-10-06: "when I press craft vehicle it goes to my base screen instead of showing Solana
 * Island"). Two halves, read partly from source because the hosts are Compose bodies over live owners:
 * - the Berth's and Lodge's craft GO ("Public Workshop, Solana Island") opens the globe on Solana Island (WorldEntry), the
 *   same admitted handoff as the faucet sheet's Seeker door;
 * - Solana Island's Public Workshop CRAFT VEHICLE opens the ONE vehicle owner's craft page (SOLANA_PUBLIC), never the base
 *   screen through a Berth focus, and never a second crafting owner.
 * Why it matters: a craft door that drops the player on the base (or loops island → base → island) is a dead end in the
 * demo, and a second crafting owner could diverge from the one that holds saved craft requests.
 */
class CraftVehicleDoorTest {
    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
    private fun compact(text: String) = text.replace(Regex("\\s+"), "")

    private fun vehicles(available: Boolean, calls: MutableList<String>) = FleetCommandOwner(FleetCommandDestination.VEHICLES,
        available, false, open = { calls += "fleet" }, close = {}, openHistory = { calls += "history" },
        openEntry = { calls += "live:$it" }, openHistoryEntry = { calls += "history:$it" }, form = {})

    @Test fun `CRAFT VEHICLE selects the vehicle owner's Solana craft entry without running it`() {
        val calls = mutableListOf<String>()
        val other = FleetCommandOwner(FleetCommandDestination.EQUIPMENT, true, false, open = { calls += "equipment" }, close = {},
            openEntry = { calls += "equipment:$it" }, form = {})
        val opening = publicWorkshopCraftOpening(FleetCommandOwners(listOf(other, vehicles(true, calls))))
        assertTrue("selecting runs nothing; the owner admits on the tap", calls.isEmpty())
        requireNotNull(opening).invoke()
        assertEquals("the craft page (SOLANA_PUBLIC → page craft), not FLEET, history or another owner",
            listOf("live:${VehicleEntryPoint.SOLANA_PUBLIC.name}"), calls)
        assertEquals("craft", VehicleEntryPoint.SOLANA_PUBLIC.page)
    }

    @Test fun `no session, no vehicle owner or an unavailable one gives no opening, so the sheet explains`() {
        val calls = mutableListOf<String>()
        assertNull(publicWorkshopCraftOpening(null))
        assertNull(publicWorkshopCraftOpening(FleetCommandOwners(emptyList())))
        assertNull(publicWorkshopCraftOpening(FleetCommandOwners(listOf(vehicles(false, calls)))))
        assertTrue(calls.isEmpty())
    }

    @Test fun `the World tab passes the craft opening down to the Public Workshop sheet and drops the Berth hop`() {
        val app = source("ui/nav/PkwApp.kt")
        assertTrue(app.contains("onCraftVehicle = gg.pixelkingdomwars.nativeclient.ui.world.publicWorkshopCraftOpening(fleet))"))
        assertTrue(source("ui/world/WorldScreen.kt").contains("seekerAuction = seekerAuction, onCraftVehicle = onCraftVehicle)"))
        val hud = compact(source("ui/world/WorldHudScreen.kt"))
        assertTrue(hud.contains("seekerAuction,onCraftVehicle,searchRecent){ui=it}"))
        assertTrue(hud.contains("seekerAuction=seekerAuction,onCraftVehicle=craftVehicle)"))
        val sheet = source("ui/world/WorldIslandSheet.kt")
        assertTrue(sheet.contains("publicWorkshopActions(buildings, onCraftVehicle, onFocusBuilding, onBuildMenu, explain, onClose)"))
        val mapper = source("ui/sheets/map/live/IslandPanelMappers.kt")
            .substringAfter("internal fun publicWorkshopActions(").substringBefore("/** Whether the admitted catalogue")
        assertTrue(mapper.contains("onCraft = { if (onCraftVehicle != null) onCraftVehicle() else explain(VEHICLE_CRAFT_UNAVAILABLE) }"))
        assertFalse("CRAFT never selects the Berth (the base screen) again", mapper.contains("berth"))
    }

    @Test fun `the Berth and Lodge craft GO open the globe on Solana Island after their sheet`() {
        val app = source("ui/nav/PkwApp.kt")
        assertTrue(app.contains("openSolanaIsland = { handoff { graph.homeRequests.request(HomeRequest.World(" +
            "gg.pixelkingdomwars.nativeclient.data.WorldEntry.SolanaIsland)) } },"))
        val berth = source("ui/home/HomeBerthLiveSheet.kt")
        assertTrue(berth.contains("BerthLiveDoor.SOLANA_WORKSHOP -> if (canRead()) homeVoyageVehicleControls(unavailable, openSolanaIsland, explain)"))
        val lodge = source("ui/home/HomeLodgeLiveSheet.kt")
        assertTrue(lodge.contains("onCraftLink = { openSolanaIsland?.invoke() ?: explain(\"Open Solana Island on the World map to craft a vehicle.\") }"))
        assertFalse("the Lodge no longer opens the craft page past the island", lodge.contains("VehicleEntryPoint.SOLANA_PUBLIC"))
    }
}
