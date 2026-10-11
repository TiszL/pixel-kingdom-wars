package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * The voyage group's mount (night 2026-10-06): which designed body each Lodge / Berth door opens on Home. Read partly from
 * source because the hosts are Compose bodies over live owners. Why it matters: a designed screen that is written but not
 * on the player path is invisible, and a door that lands on an unmounted id falls back to a toast or an old screen. Every
 * voyage door must open a designed voyage sheet, collect in place, or say why. AUTHORED / UNRUN.
 */
class HomeVoyageMountTest {
    private fun source(path: String) = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path").readText()
    private fun compact(text: String) = text.replace(Regex("\\s+"), "")
    private val host = source("ui/home/HomeRouteDispatcher.kt").substringAfter("@Composable internal fun HomeVoyageSheet(")
    private val app = compact(source("ui/nav/PkwApp.kt"))

    /** The sheet each mounted link opens, exactly as HomeSheetRouteHost.openMountedLink maps it. */
    private val linkBodies = mapOf("berth.starter" to Destination.Berth(section = "starter"), "berth.fleet" to Destination.Berth(),
        "berth.service" to Destination.Berth("SERVICE"), "lodge.expedition" to Destination.Lodge())

    @Test fun `every link a voyage body opens lands on a designed voyage sheet`() {
        val links = source("ui/home/HomeRouteDispatcher.kt").substringAfter("fun openMountedLink(").substringBefore("override fun canOpen(")
        val ids = listOf("ui/home/HomeLodgeLiveSheet.kt", "ui/home/HomeBerthLiveSheet.kt")
            .flatMap { Regex("openFeature\\(\"([a-z.]+)\"\\)").findAll(source(it)).map { m -> m.groupValues[1] }.toList() }.toSet()
        assertTrue("the Lodge reaches the Berth and the Berth reaches the Lodge", ids.containsAll(setOf("berth.fleet", "lodge.expedition")))
        for (id in ids) {
            // An id outside this map would reach openMountedLink's "This link is not available" toast instead of a sheet.
            val destination = requireNotNull(linkBodies[id]) { "$id has no designed voyage body" }
            assertTrue(id, id in HOME_MOUNTED_FEATURES)
            assertTrue(id, links.contains("\"$id\" ->"))
            assertNotNull(id, mountedHomeSheetFrame(SheetEntry(destination)))
        }
    }

    @Test fun `the Lodge and Berth open their designed bodies and the old inline Berth body is off the path`() {
        assertTrue(host.contains("is Destination.Lodge -> HomeLodgeLiveSheet("))
        assertTrue(host.contains("is Destination.Berth -> HomeBerthLiveSheet("))
        // A2's inline Berth block drew BerthSheet from the host with a craft toast; HomeBerthLiveSheet replaced it.
        assertFalse(host.contains("berthSheetActions("))
        assertFalse(host.contains("Open Solana Island to craft a vehicle."))
        // Rewritten for the craft-vehicle door (owner 2026-10-06): the craft GO of both bodies leaves for the globe's Solana
        // Island (one openSolanaIsland handoff from the host); the Berth's crafted controls keep the openVehicles handoff.
        assertTrue(host.contains("openSolanaIsland = openSolanaIsland, onBuildBerth = onBuildBerth, onStack = onStack"))
        assertTrue(host.contains("berthPlacement = berthPlacement, openSolanaIsland = openSolanaIsland)"))
        assertTrue(compact(host).contains("vehicleHistory,openVehicles,openFeature,canRead,explain,nestedBack,starterReview"))
        for (tab in listOf("SEND", "UNDER_WAY", "PASSPORT"))
            assertNotNull(tab, mountedHomeSheetFrame(SheetEntry(Destination.Lodge(tab))))
        for (tab in listOf("FLEET", "SERVICE")) assertNotNull(tab, mountedHomeSheetFrame(SheetEntry(Destination.Berth(tab))))
        assertNotNull("berth-install", mountedHomeSheetFrame(SheetEntry(Destination.Berth(section = "install"))))
    }

    @Test fun `island art is provided around the voyage sheets and the collect card`() {
        // Without the provider the sheets keep the sea stand-in; S5's source is refcounted, so providing it costs no lease.
        assertTrue(compact(host).contains("CompositionLocalProvider(gg.pixelkingdomwars.nativeclient.ui.sheets.voyage.LocalVoyageArtprovides" +
            "rememberHomeVoyageArt(graph,session){vehicleOwner?.policy?.invoke()?.ordinaryRoutes})"))
        assertTrue(app.contains("LocalVoyageArtprovidesgg.pixelkingdomwars.nativeclient.ui.home.rememberHomeVoyageArt(graph,session){" +
            "currentOwners.value.vehicle?.policy?.invoke()?.ordinaryRoutes}){gg.pixelkingdomwars.nativeclient.ui.home.HomeVoyageOverlayHost(voyageOverlays,"))
    }

    @Test fun `send-locked BUILD BERTH opens the build tray and SEND supplies reach the HUD only over the Lodge`() {
        val lodge = source("ui/home/HomeLodgeLiveSheet.kt")
        assertTrue(lodge.contains("LodgeLiveDoor.BUILD_BERTH -> onBuildBerth?.invoke() ?: explain("))
        assertTrue(app.contains("onBuildBerth={handoff{graph.homeRequests.request(HomeRequest.BuildCategory(" +
            "gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live.LiveTrayTabs.BUILDINGS))}}"))
        assertTrue(app.contains("onStack={voyageStack=it}"))
        // The Gold Forge wallet rows keep priority, and a stale Lodge stack never shows over another sheet.
        assertTrue(app.contains("authoritativeResources=goldForgeRows?:voyageStack?.takeIf{stack.top?.destinationisDestination.Lodge}"))
    }

    @Test fun `the selected Lodge collects in place only when its bar says COLLECT`() {
        val lodge = Building("lodge-1", "lodge", 4, 0, 0)
        val explore = CommandUi(FeatureId("lodge.expedition"), "ui:lodge-menu", "EXPLORE", null, true, CommandState.ENABLED, null, null)
        val bar = CommandBarUi("lodge-1", listOf(explore))
        val ready = VoyageSelectionUi(atSea = 0, ready = 1, nextBackIn = null, anyVehicle = true, starterInstalled = true,
            collectAvailable = true, complete = true)
        assertTrue(voyageCommandCollects(FeatureId("lodge.expedition"), voyageCommandBar(bar, lodge, ready)))
        // No collect owner on this Home: the tap stays EXPLORE and opens the Lodge sheet through its own route.
        assertFalse(voyageCommandCollects(FeatureId("lodge.expedition"), voyageCommandBar(bar, lodge, ready.copy(collectAvailable = false))))
        // A disabled EXPLORE never becomes an enabled COLLECT.
        val disabled = bar.copy(commands = listOf(explore.copy(state = CommandState.DISABLED, reason = "Upgrading")))
        assertFalse(voyageCommandCollects(FeatureId("lodge.expedition"), voyageCommandBar(disabled, lodge, ready)))
        // KingdomScreen: bar taps and the second tap on the selected Lodge both run onCommand, which collects first.
        val screen = compact(source("ui/kingdom/KingdomScreen.kt"))
        assertTrue(screen.contains("if(voyageReturn!=null&&gg.pixelkingdomwars.nativeclient.ui.home.voyageCommandCollects(id,currentBar))" +
            "voyageReturn.collect()elserouteBuildingCommand(id,currentBar,commandRoutes,phaseECommands,barSelection)"))
        assertTrue(screen.contains("vallatestOnCommandbyrememberUpdatedState(onCommand)"))
        assertTrue(screen.contains("latestOnCommand(primary.id)"))
        assertTrue(screen.contains("gg.pixelkingdomwars.nativeclient.ui.home.voyageCommandBar(bar,b,voyageSelection)"))
        assertTrue(screen.contains("gg.pixelkingdomwars.nativeclient.ui.home.voyageNamePlate(plate,b,voyageSelection)"))
    }

    @Test fun `a returned trip's herald opens TRIPS and its chip flies to the Lodge behind any defence notice`() {
        // The herald target is a mounted Lodge tab, so the dispatcher opens the Lodge on TRIPS.
        assertTrue("lodge.underway" in HOME_MOUNTED_FEATURES)
        assertNotNull(mountedHomeSheetFrame(SheetEntry(Destination.Lodge("UNDER_WAY"))))
        // The chip is a camera door, not a sheet: the dispatcher declines it, so the scaffold's own branch must take it.
        assertFalse("lodge.focus" in HOME_MOUNTED_FEATURES)
        val scaffold = compact(source("ui/home/HomeScaffold.kt"))
        assertTrue(scaffold.contains("\"lodge.focus\"->home.base?.buildings?.firstOrNull{it.type==\"lodge\"&&!it.underConstruction}" +
            "?.let{requests.request(HomeRequest.FocusBuilding(it.id))}"))
        assertTrue(scaffold.contains("herald=homeHeraldUi(defenceNotice)?:voyageSignals.herald"))
        assertTrue(scaffold.contains("ui.copy(context=ui.context?:voyageSignals.context)"))
        val signals = source("ui/home/HomeVoyageSignals.kt")
        assertTrue(signals.contains("FeatureId(\"lodge.underway\")")); assertTrue(signals.contains("FeatureId(\"lodge.focus\")"))
    }
}
