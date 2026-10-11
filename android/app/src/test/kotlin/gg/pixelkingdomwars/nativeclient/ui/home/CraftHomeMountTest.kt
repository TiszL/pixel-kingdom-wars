package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.features.Destination
import gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.MarketTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.WorkshopTab
import gg.pixelkingdomwars.nativeclient.ui.sheets.craft.live.keepMarketEntry
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * The craft group on the player path (ui-craft mount): every Workshop, Harvester and Market door on Home opens the designed
 * body that acts in place, and the old route screens remain only as the fallback for a sheet Home cannot admit. Pins which
 * body each door opens and the host behaviour those doors rely on. Authored without a build; the main loop runs it.
 */
class CraftHomeMountTest {
    private fun app() = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
    private val identity = HomeRouteIdentity(Any(), "base-a", 4)

    /** One current Home sheet mount; [blocked] stands in for Home admission (for example the Equipment pane still open). */
    private class Mounted(identity: HomeRouteIdentity) {
        var blocked = false
        val opened = mutableListOf<Destination>()
        val reasons = mutableListOf<String>()
        val host = HomeSheetRouteHost({ identity }, { blocked }, { reasons += it })
        val lease = Any()
        init { host.attach(identity, {}, { false }, owner = lease, openBody = { opened += it }).reportBlocked(false) }
    }

    // WHY: a REFINE or STYLE door must land on that tab of the designed sheet; dropping the tab would show INGOTS instead.
    @Test fun `every Workshop tab and the Harvester open their designed Home sheet on the requested tab`() {
        val f = Mounted(identity)
        for (tab in listOf(WorkshopTab.INGOTS, WorkshopTab.REFINE, WorkshopTab.COSMETICS))
            assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.Workshop(tab), HomeTab.KINGDOM))
        assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.Harvester(), HomeTab.KINGDOM))
        assertEquals(listOf(Destination.Workshop("INGOTS"), Destination.Workshop("REFINE"), Destination.Workshop("COSMETICS"),
            Destination.Harvester()), f.opened)
        assertTrue(f.reasons.isEmpty())
    }

    // WHY: the Home switch decides which screen the player gets; the old observation-only bodies must not come back.
    @Test fun `the Workshop and Harvester bodies are the designed in place owners with no route hop`() {
        val app = app()
        val workshop = app.substringAfter("is Destination.Workshop -> gg.pixelkingdomwars.nativeclient.ui.home.HomeWorkshopOwnerSheet(")
            .substringBefore("is Destination.Harvester ->")
        assertTrue(app.contains("is Destination.Workshop -> gg.pixelkingdomwars.nativeclient.ui.home.HomeWorkshopOwnerSheet("))
        assertTrue(workshop.contains("onOpenTools = { changeTab(\"EQUIPMENT\") }"))
        assertTrue(workshop.contains("onOpenDestination = craftDoor"))
        assertFalse(workshop.contains("navController.navigate("))
        val harvesterStart = "is Destination.Harvester -> gg.pixelkingdomwars.nativeclient.ui.home.HomeHarvesterOwnerSheet("
        assertTrue(app.contains(harvesterStart))
        val harvester = app.substringAfter(harvesterStart).substringBefore("is Destination.Lodge, is Destination.Berth ->")
        for (wired in listOf("reviewController = harvesterReviewController", "harvesterHeaderArtKey(",
            "home.base?.takeIf { it.baseId == identity.baseId }?.raw", "craftBuildingArtTier(content.catalogue, level)",
            "onFocusBuilding = { id -> handoff { graph.homeRequests.request(HomeRequest.FocusBuilding(id)) } }",
            "onOpenDestination = craftDoor"))
            assertTrue(wired, harvester.contains(wired))
        // The retired Home bodies stay in source tonight but are no longer called.
        for (retired in listOf("HomeWorkshopSheet(", "HomeHarvesterSheet(")) assertFalse(retired, app.contains(retired))
    }

    // WHY: the Market has no Home sheet frame, so a Workshop or Harvester GO to the Market must reach its existing KEEP
    // owner on the requested tab, never an empty refusal or the generic waiting sentence.
    @Test fun `a Market door is not a Home sheet so the craft door hands it to the KEEP Market owner`() {
        assertNull(mountedHomeSheetFrame(SheetEntry(Destination.Market(MarketTab.SELL))))
        val f = Mounted(identity)
        assertEquals(HomeNavigationResult.REFUSED, f.host.navigateResult(Destination.Market(MarketTab.SELL), HomeTab.KINGDOM))
        assertTrue(f.opened.isEmpty())
        val door = app().substringAfter("val craftDoor: (Destination) -> Unit = { destination ->").substringBefore("val openWorkshopTab:")
        assertTrue(door.contains("FleetCommandDestination.KEEP_MARKET && it.available"))
        assertTrue(door.contains("owner?.openEntry?.let"))
        assertTrue(door.contains("if (destination.tab == \"SELL\") \"SELL\" else \"BUY\""))
        assertTrue(door.contains("if (opening != null) handoff { opening() }"))
        assertTrue(door.contains("else localRouteHost.locked(\"Market controls are unavailable for this kingdom.\")"))
        assertTrue(door.contains("else -> openHub(destination)"))
        // The two names the door sends are exactly the entries the KEEP Market owner opens on.
        assertEquals(MarketTab.SELL, keepMarketEntry("SELL").tab)
        assertEquals(MarketTab.BUY, keepMarketEntry("BUY").tab)
    }

    // WHY: Home sees the Equipment pane close only after it recomposes. Falling back at the first DEFERRED would send every
    // TOOLS tab tap to the old route screen; the return waits for admission and falls back only when Home never admits it.
    @Test fun `a Workshop return from TOOLS waits for Home admission before any fallback`() {
        val f = Mounted(identity); f.blocked = true
        assertEquals(HomeNavigationResult.DEFERRED, f.host.navigateResult(Destination.Workshop(WorkshopTab.REFINE), HomeTab.KINGDOM))
        assertTrue(f.opened.isEmpty()); assertTrue(f.reasons.isEmpty())
        f.blocked = false
        assertEquals(HomeNavigationResult.DISPATCHED, f.host.navigateResult(Destination.Workshop(WorkshopTab.REFINE), HomeTab.KINGDOM))
        assertEquals(listOf<Destination>(Destination.Workshop("REFINE")), f.opened)
        val back = app().substringAfter("LaunchedEffect(workshopReturn) {").substringBefore("when (tab) {")
        assertTrue(back.contains("while (attempt == HomeNavigationResult.DEFERRED)"))
        assertTrue(back.contains("kotlinx.coroutines.withTimeoutOrNull("))
        assertTrue(back.contains("if (result != HomeNavigationResult.DISPATCHED"))
    }

    // WHY: Mail, History and Event cards reach the craft sheets too; HarvesterRoute is the old dark screen.
    @Test fun `hub links open the designed craft sheets and keep the old screens only as a fallback`() {
        val links = app().substringAfter("val openHubLink: (gg.pixelkingdomwars.nativeclient.ui.sheets.hub.HubLink) -> Unit = { link ->")
            .substringBefore("when (entry.destination) {")
        assertTrue(links.contains("\"workshop.craft\" -> openWorkshopTab(\"INGOTS\")"))
        assertTrue(links.contains("\"refining.open\" -> openWorkshopTab(\"REFINE\")"))
        assertTrue(links.contains("\"harvester.harvest\" -> openHub(Destination.Harvester())"))
        assertFalse(links.contains("HarvesterRoute"))
        val tab = app().substringAfter("val openWorkshopTab: (String, () -> Unit) -> Unit = { selected, original ->")
            .substringBefore("val openHubLink:")
        assertTrue(tab.contains("localRouteHost.navigateResult(Destination.Workshop(selected), HomeTab.KINGDOM) != HomeNavigationResult.DISPATCHED"))
        assertTrue(tab.contains("handoff(original)"))
    }
}
