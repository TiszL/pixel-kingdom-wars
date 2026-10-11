package gg.pixelkingdomwars.nativeclient.ui.battle

import java.io.File
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The live battle ends on the designed result card (result.png), not the old Material dialog, and its doors still run the
 *  existing battle owners; while the designed HUD is up, END asks through the HUD's own confirm. */
class BattleResultMountContractTest {
    private fun source(path: String) = listOf(File("src/main/kotlin/gg/pixelkingdomwars/nativeclient", path),
        File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient", path)).first { it.isFile }.readText()
    private fun screens() = source("ui/battle/BattleScreens.kt")
    private fun liveBattle() = screens().substringAfter("@Composable fun LiveBattleScreen(")
        .substringBefore("/** The same durable commands remain recoverable")

    @Test fun `the live result is the designed card and the old dialog is off the player path`() {
        val live = liveBattle()
        assertTrue(live.contains("BattleResultCardV2("))
        assertTrue("Every number comes from the server result mapper",
            live.contains("battleResultV2Ui(result, target, nextLabel, live, content.catalogue, busy)"))
        assertFalse(screens().contains("RaidResultPanel("))
        assertFalse("The card draws its own rays; the old corner FX would double them", live.contains("ResultDecorations("))
        assertTrue("The existing owner still plays the result sounds and haptics", live.contains("rememberLiveResult("))
    }

    @Test fun `the four result exits still run the existing battle owners`() {
        val actions = liveBattle().substringAfter("BattleResultV2Actions(").substringBefore("Modifier.fillMaxSize())")
        assertTrue(actions.contains("onHome = { leave(model::returnHome) }"))
        assertTrue(actions.contains("onNext = { leave(model::raidAgain) }"))
        assertTrue("RETRAIN opens the composer on TRAIN", actions.contains("model.exitTo(HomeRequest.Training)"))
        assertTrue("REPLAY reaches the raid log", actions.contains("model.exitTo(HomeRequest.Tab(HomeTab.ATTACK))"))
        assertTrue("A refused door says why", actions.contains("model::buffNotice"))
    }

    @Test fun `the hud end confirm asks while the hud is up and the dialog only covers the opening path`() {
        val live = liveBattle()
        assertTrue(live.contains("endConfirmShown = confirmRetreat"))
        assertTrue(live.contains("BattleHudEndConfirmLayer(designedHud, designedActions)"))
        // c-gap-army 2026-10-06: the opening-path confirm is still the only one outside the HUD, but it is now the designed
        // BattleDecisionDialog (the old dark chrome AlertDialog was deliberately retired from the battle path).
        assertTrue(live.contains("if (confirmRetreat && !hudConfirm && live.result == null) BattleDecisionDialog("))
        assertTrue(live.contains("confirmRetreat = false; model.retreat()"))
        assertFalse("The HUD confirm must not be wired to no-ops", live.contains("onConfirmEnd = {}, onCancelEnd = {}"))
    }

    /** c-gap-army 2026-10-06 (owner: "I should not see any even 1 of old screens"): every raid and every scout opens through
     *  this path, so an old ink LoadingCard or a Material dialog here is the most-seen old screen in the game. The opening
     *  must keep the existing retry owner and way out.
     *  Rewritten 2026-10-06 (d-loading V2, owner: "black screen is low quality … professional solution", design default the
     *  220 ms fade through the scene colour): the kit shell (BattleLoadingOverlay, an opaque #100E14 plate) is replaced by
     *  BattleSceneCover — the player's own base dimmed or the wallpaper, the honest indicator, then the fade through the
     *  target's ground colour. Same retry owners and way out as before; no dark plate on any battle opening. */
    @Test fun `the raid entry and the scout preview open through the scene cover and ask only in designed dialogs`() {
        val live = liveBattle()
        assertTrue(live.contains("BattleSceneCover(live = !opening, fieldPresented = presented, ground = battleGround, postcard = homePostcard,"))
        assertTrue("The opening keeps its retry owner", live.contains("onRetry = retryEntry ?: fieldRetry, route = \"battle\","))
        assertTrue("and its way out", live.contains("topBar = openingActions)"))
        assertTrue("and says why it paused", live.contains("cause = entryRecovery.message ?: if (fieldFailed)"))
        assertFalse("No Material dialog on the live battle path", live.contains("AlertDialog("))
        assertFalse("No dark plate on any battle opening", screens().contains("BattleLoadingOverlay(") || screens().contains("LoadingOverlay("))
        val scout = screens().substringAfter("Scouting the kingdom…").substringBefore("ScoutLiveOverlay(")
        assertTrue(screens().contains("cause = if (error == null && !fieldFailed) \"Scouting the kingdom…\""))
        assertTrue("The scout keeps its retry", scout.contains("onRetry = if (error != null) ({ preparationAttempt++; Unit }) else fieldRetry"))
        assertTrue("The scout camera tools ask in the designed dialog",
            screens().substringAfter("ScoutLiveOverlay(").contains("BattleDecisionDialog(\"PREVIEW CAMERA\""))
    }
}
