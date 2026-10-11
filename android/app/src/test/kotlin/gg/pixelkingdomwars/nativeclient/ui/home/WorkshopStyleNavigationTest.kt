package gg.pixelkingdomwars.nativeclient.ui.home

import gg.pixelkingdomwars.nativeclient.ui.nav.OrdinaryCraftingRoute
import java.io.File
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.*
import org.junit.Test

/** STYLE uses the existing Ordinary Workshop owner. Authored before a40 navigation changes; unrun. */
class WorkshopStyleNavigationTest {
    @Test fun `old empty route and default callers still enter Refining`() {
        assertEquals("REFINE", OrdinaryCraftingRoute().ownerTab)
        assertEquals("REFINE", Json.decodeFromString<OrdinaryCraftingRoute>("{}").ownerTab)
    }

    @Test fun `explicit STYLE route survives serialization without storing derived admission`() {
        val route = OrdinaryCraftingRoute("COSMETICS")
        val encoded = Json.encodeToString(route)
        assertEquals("COSMETICS", Json.decodeFromString<OrdinaryCraftingRoute>(encoded).ownerTab)
        assertFalse(encoded.contains("ownerTab"))
    }

    @Test fun `unsupported route values cannot select another owner or arbitrary tab`() {
        for (tab in listOf("", "INGOTS", "EQUIPMENT", "WAKE", "cosmetics", " COSMETICS")) {
            assertEquals("REFINE", OrdinaryCraftingRoute(tab).ownerTab)
        }
    }

    @Test fun `Ordinary owner provider receives the admitted route tab and retains existing repositories`() {
        val ordinary = app().substringAfter("composable<OrdinaryCraftingRoute>").substringBefore("composable<MiningContributionRoute>")
        assertTrue(ordinary.contains("ordinaryEntry.toRoute<OrdinaryCraftingRoute>().ownerTab"))
        assertTrue(ordinary.contains("WorkshopOwnerHost(ordinaryTab,"))
        assertTrue(ordinary.contains("OrdinaryWorkshopScreen("))
        assertTrue(ordinary.contains("graph.holder.requireCurrent(s.session)"))
        assertTrue(ordinary.contains("graph.account.state.value.baseSelectionGeneration == selectionGeneration"))
        assertFalse(ordinary.contains("newOwner"))
    }

    @Test fun `Home STYLE controls preserve the owned handoff and original ingot recovery precedence`() {
        // Rewritten for the in-place mount (ui-craft): STYLE acts in place on the designed Home Workshop sheet, so the Home
        // branch has no route handoff left (the old onLegacy hop is gone). Tab taps still go through the lease-guarded
        // changeTab, and a saved INGOTS original still wins over a requested STYLE tab so its recovery is never hidden.
        val home = app().substringAfter("is Destination.Workshop -> gg.pixelkingdomwars.nativeclient.ui.home.HomeWorkshopOwnerSheet(")
            .substringBefore("is Destination.Harvester")
        assertFalse(home.contains("onLegacy"))
        assertFalse(home.contains("navController.navigate("))
        assertTrue(home.contains("canRead = { localRouteHost.canUseReadControl(lease) }"))
        assertTrue(home.contains("onTab = changeTab"))
        val sheet = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/home/HomeWorkshopOwnerSheet.kt").readText()
        assertTrue(sheet.contains("homeWorkshopOwnerTab(entry, ingotOriginalSaved = ingotState?.journal?.operation != null)"))
        assertTrue(sheet.contains("WorkshopTab.COSMETICS -> WorkshopStyleOwnerScreen("))
        val style = gg.pixelkingdomwars.nativeclient.ui.sheets.SheetEntry(gg.pixelkingdomwars.nativeclient.ui.features.Destination.Workshop("COSMETICS"))
        assertEquals("INGOTS", homeWorkshopOwnerTab(style, ingotOriginalSaved = true))
        assertEquals("COSMETICS", homeWorkshopOwnerTab(style))
    }

    @Test fun `INGOTS STYLE replaces the sibling only behind exact current review and lifecycle checks`() {
        val ingots = app().substringAfter("composable<WorkshopRoute>").substringBefore("composable<OrdinaryCraftingRoute>")
        val sibling = ingots.substringAfter("onTab = { selected ->").substringBefore("else if (selected == \"EQUIPMENT\")")
        assertTrue(sibling.contains("selected == \"REFINE\" || selected == \"COSMETICS\""))
        assertTrue(sibling.contains("graph.sessionGraph.value === s && graph.holder.current === s.session"))
        assertTrue(sibling.contains("graph.account.state.value.selectedBaseId == workshopSelectedBase"))
        assertTrue(sibling.contains("graph.account.state.value.baseSelectionGeneration == workshopSelectionGeneration"))
        assertTrue(sibling.contains("toolsLifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)"))
        assertTrue(sibling.contains("hasRoute<WorkshopRoute>() == true"))
        assertTrue(sibling.contains("repository.state.value.review == null && !repository.state.value.busy"))
        assertTrue(sibling.contains("BackPriority.SHEET"))
        assertTrue(sibling.contains("navController.navigate(OrdinaryCraftingRoute(selected))"))
        assertTrue(sibling.contains("popUpTo<WorkshopRoute> { inclusive = true }"))
        assertTrue(sibling.contains("Finish the current review or reopen this Workshop before changing tabs."))
    }

    @Test fun `TOOLS STYLE closes its pane only after current admission and routes the existing Ordinary owner`() {
        val tools = app().substringAfter("// Workshop TOOLS borrows the existing Equipment form and registration.")
            .substringBefore("Box(Modifier.fillMaxSize())")
        assertTrue(tools.contains("if (!equipmentCurrent())"))
        assertTrue(tools.contains("currentPresentationIdentity.value() == equipmentIdentity"))
        assertTrue(tools.contains("lifecycle.currentState == Lifecycle.State.RESUMED"))
        assertTrue(tools.contains("BackPriority.SHEET"))
        // Rewritten for the in-place mount (ui-craft): STYLE closes the pane and opens the designed Home Workshop sheet on
        // its STYLE tab; the Ordinary owner route stays only as the fallback when Home does not admit that sheet.
        assertTrue(tools.contains("\"REFINE\", \"INGOTS\", \"COSMETICS\" -> { workshopReturn = selected; fleet?.closeAll() }"))
        val back = app().substringAfter("LaunchedEffect(workshopReturn) {").substringBefore("when (tab) {")
        assertTrue(back.contains("localRouteHost.navigateResult(Destination.Workshop(selected), HomeTab.KINGDOM)"))
        assertTrue(back.contains("\"COSMETICS\" -> navController.navigate(OrdinaryCraftingRoute(\"COSMETICS\"))"))
        assertFalse(tools.contains("Style controls are available from the Refining owner's STYLE tab."))
    }

    private fun app() = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()
}
