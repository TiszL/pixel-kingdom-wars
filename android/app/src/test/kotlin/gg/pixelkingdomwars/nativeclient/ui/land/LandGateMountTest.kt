package gg.pixelkingdomwars.nativeclient.ui.land

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** Source wiring checks accompany the pure live-state tests; Cedar3 owns execution. */
class LandGateMountTest {
    private val root = "src/main/kotlin/gg/pixelkingdomwars/nativeclient"

    @Test fun `land player path mounts every designed stage and preserves the existing recovery owners`() {
        val source = File("$root/ui/land/LandGateScreen.kt").readText()
        for (component in listOf("LandGateCard(", "RealmPickerSheet(", "LandDoneCard(", "Seal(", "liveLandSeal("))
            assertTrue(component, source.contains(component))
        for (owner in listOf("model.open(kind)", "model.pollFunding()", "model.refreshDirectory()",
            "model.reserveDrafted()", "model.reserveRandom()", "model::pay", "model::retryPayment"))
            assertTrue(owner, source.contains(owner))
        for (recovery in listOf("onResearchPayment", "onTrainingPayment", "onBuilderPayment", "onClaimDeed", "onChooseOnMap"))
            assertTrue(recovery, source.contains(recovery))
    }

    @Test fun `credited land stays visible until the player chooses an existing entry owner`() {
        val source = File("$root/ui/land/LandGateScreen.kt").readText()
        for (oldEffect in listOf("LaunchedEffect(checkout.phase, state.landOwned)",
            "LaunchedEffect(state.checkout.phase, state.landOwned)"))
            assertFalse("The old credit-triggered effect must not skip the done card", source.contains(oldEffect))
        assertTrue(source.contains("onSeeMap"))
        assertTrue("The existing account and base refresh still owns entry", source.contains("model.enterGame("))
    }

    @Test fun `see map requests the existing MyDeeds route after successful land entry`() {
        val app = File("$root/ui/nav/PkwApp.kt").readText()
        val mount = app.substringAfter("composable<LandGateRoute>").substringBefore("composable<BaseClaimRoute>")
        assertTrue(mount.contains("onSeeMap ="))
        assertTrue(mount.contains("HomeRequest.World(gg.pixelkingdomwars.nativeclient.data.WorldEntry.MyDeeds)"))
        assertTrue(mount.contains("popBackStack<HomeRoute>(inclusive = false)"))
        assertTrue(mount.contains("navController.navigate(HomeRoute)"))
        assertTrue("The root keeps the current wallet signer", mount.contains("graph.landWallet(current, w)"))
    }
}
