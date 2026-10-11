package gg.pixelkingdomwars.nativeclient.ui.home

import java.io.File
import org.junit.Assert.*
import org.junit.Test

/** Mount seams over existing owners. Authored before a31 navigation edits; Cedar3 owns execution. */
class WorkshopToolsNavigationTest {
    private fun app() = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()

    @Test fun `Home TOOLS tab uses the current sheet handoff and the existing equipment owner`() {
        val source = app().substringAfter("val changeTab: (String) -> Unit =")
            .substringBefore("val legacy: (Destination) -> Unit")
        assertTrue(source.contains("localRouteHost.canUseReadControl(lease)"))
        assertTrue(source.contains("entry.destination is Destination.Workshop && selected == \"EQUIPMENT\""))
        assertTrue(source.contains("!routeAdmissionBlocked.value()"))
        assertTrue(source.contains("it.destination == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT && it.available"))
        assertTrue(source.contains("handoff { fleet?.open(gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT) }"))
        assertTrue(source.contains("Tools are waiting for the current Workshop. Try again."))
        // Rewritten for the in-place mount (ui-craft): the designed Home Workshop sheet's tabs and its OPEN TOOLS door both
        // go through this same guarded changeTab.
        assertTrue(app().contains("onTab = changeTab, onClose = close, onOpenTools = { changeTab(\"EQUIPMENT\") }"))
    }

    @Test fun `equipment form inherits only an existing Workshop host and keeps the one fleet form`() {
        val source = app().substringAfter("// Workshop TOOLS borrows the existing Equipment form and registration.")
            .substringBefore("Box(Modifier.fillMaxSize())")
        assertTrue(source.contains("fleet?.destination() == gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT"))
        assertTrue(source.contains("LocalWorkshopOwnerHost provides"))
        assertTrue(source.contains("WorkshopOwnerHost(\"EQUIPMENT\""))
        assertEquals(2, source.split("fleet?.form()?.invoke()").size - 1) // Mutually exclusive equipped and unchanged sibling branches.
        assertFalse(source.contains("EquipmentViewModel(")); assertFalse(source.contains("EquipmentRepository("))
    }

    @Test fun `equipment sibling handoffs recheck identity lifecycle and review then close the pane before routing`() {
        val source = app().substringAfter("// Workshop TOOLS borrows the existing Equipment form and registration.")
            .substringBefore("Box(Modifier.fillMaxSize())")
        assertTrue(source.contains("currentPresentationIdentity.value() == equipmentIdentity"))
        assertTrue(source.contains("lifecycle.currentState == Lifecycle.State.RESUMED"))
        assertTrue(source.contains("hasRoute<HomeRoute>() == true"))
        assertTrue(source.contains("BackPriority.SHEET"))
        assertTrue(source.contains("if (!equipmentCurrent())"))
        // Rewritten for the in-place mount (ui-craft): REFINE, INGOTS and STYLE now close the pane and open the designed Home
        // Workshop sheet on that tab once Home admits it. The original routes remain only as the fallback for a sheet Home
        // refuses or never admits, so a tab tap can never be lost.
        assertTrue(source.contains("\"REFINE\", \"INGOTS\", \"COSMETICS\" -> { workshopReturn = selected; fleet?.closeAll() }"))
        assertFalse(source.contains("navController.navigate("))
        val back = app().substringAfter("LaunchedEffect(workshopReturn) {").substringBefore("when (tab) {")
        assertTrue(back.contains("localRouteHost.navigateResult(Destination.Workshop(selected), HomeTab.KINGDOM)"))
        assertTrue(back.contains("result != HomeNavigationResult.DISPATCHED"))
        assertTrue(back.contains("hasRoute<HomeRoute>() == true"))
        assertTrue(back.contains("\"INGOTS\" -> navController.navigate(WorkshopRoute)"))
        assertTrue(back.contains("else -> navController.navigate(OrdinaryCraftingRoute())"))
        assertTrue(back.contains("\"COSMETICS\" -> navController.navigate(OrdinaryCraftingRoute(\"COSMETICS\"))"))
        // The designed TOOLS sheet carries the Workshop's header art tier and level from the server snapshot.
        assertTrue(source.contains("craftBuildingArtTier(content.catalogue, equipmentLevel)"))
        assertTrue(source.contains("titleTag = equipmentLevel?.let { \"LV \$it\" }"))
    }

    @Test fun `existing ingot and refining owners can open Tools without creating another owner`() {
        val source = app()
        for ((route, end) in listOf("WorkshopRoute" to "OrdinaryCraftingRoute", "OrdinaryCraftingRoute" to "MiningContributionRoute")) {
            val branch = source.substringAfter("composable<$route>").substringBefore("composable<$end>")
            assertTrue(branch.contains("selected == \"EQUIPMENT\""))
            assertTrue(branch.contains("graph.holder.current === s.session"))
            assertTrue(branch.contains("toolsLifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)"))
            assertTrue(branch.contains("fleet?.open(gg.pixelkingdomwars.nativeclient.ui.economy.FleetCommandDestination.EQUIPMENT)"))
            assertTrue(branch.contains("Tools are waiting for the current Workshop. Try again."))
            assertFalse(branch.contains("EquipmentViewModel(")); assertFalse(branch.contains("EquipmentRepository("))
        }
    }
}
