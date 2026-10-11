package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test

/** The chooser's history door must reach the same owner as the shield HUD, including mark-read and Home exit. */
class ArmyLogDoorContractTest {
    private fun navigation() = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/ui/nav/PkwApp.kt").readText()

    @Test fun `chooser history reaches the registered raid log destination`() {
        val mount = navigation().substringAfter("ArmyHomeRaidMount(").substringBefore("\"research\" ->")
        assertTrue("The chooser keeps the registered history owner", mount.contains("onRaidLog ="))
        assertTrue(mount.contains("navController.navigate(RaidLogRoute)"))
        val retiredTab = navigation().substringAfter("HomeTab.ATTACK -> LaunchedEffect(Unit)").substringBefore("HomeTab.WORLD ->")
        assertTrue("Saved old Attack tab identities reach history", retiredTab.contains("navController.navigate(RaidLogRoute)"))
    }

    @Test fun `battle log route retains read acknowledgement and the Home exit`() {
        val log = navigation().substringAfter("composable<RaidLogRoute>").substringBefore("composable<BattleRoute>")
        assertTrue(log.contains("defenceNotices.markRead(seenBase?.baseId, seenBase?.raw"))
        assertTrue(log.contains("historyOnly = true, onBack = closeHistory"))
        assertTrue(log.contains("HomeRequest.Tab(HomeTab.KINGDOM)"))
    }
}
