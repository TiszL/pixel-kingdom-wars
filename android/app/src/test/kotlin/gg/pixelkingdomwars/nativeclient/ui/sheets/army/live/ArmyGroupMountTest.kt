package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.ui.home.HOME_MOUNTED_FEATURES
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import java.io.File
import org.junit.Assert.*
import org.junit.Test

/**
 * The army group's mount (night UI, 2026-10-06): which body each Home door opens. Every Army door lands on its designed
 * sheet over the retained Kingdom; since c-gap-army (2026-10-06) the legacy ArmyScreen, ResearchScreen and HeroesScreen
 * are only the history fallback of the standalone routes (Home passes designed history doors). A door that quietly moved back to an old
 * screen, or a Need-more pill that did nothing, would still pass every mapper test, so these read the call sites
 * (source contract; Compose execution is the device run's gate).
 */
class ArmyGroupMountTest {
    private fun source(path: String) = listOf(File("src/main/kotlin/gg/pixelkingdomwars/nativeclient", path),
        File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient", path)).first { it.isFile }.readText()
    private fun homeArmyFrame() = source("ui/nav/PkwApp.kt")
        .substringAfter("ArmyHomeFrame { key(armyLiveSheet) { when (armyLiveSheet) {")
        .substringBefore("HomeTab.ARMY -> LaunchedEffect(Unit)")
    private fun branch(label: String, next: String) = homeArmyFrame().substringAfter(label).substringBefore(next)
    private fun armyBranch() = branch("\"army\" ->", "\"raid\", \"campaign\" ->")
    private fun raidBranch() = branch("\"raid\", \"campaign\" ->", "\"research\" ->")
    private fun researchBranch() = branch("\"research\" ->", "\"heroes\" ->")
    private fun heroesBranch() = branch("\"heroes\" ->", "} } }")
    private fun hosts() = source("ui/sheets/army/live/ArmyLiveHosts.kt")
    private val live = "gg.pixelkingdomwars.nativeclient.ui.sheets.army.live."

    @Test fun `each Army sheet value opens its designed host and an old screen only as the legacy body of that host`() {
        assertTrue(armyBranch().trimStart().startsWith("${live}ArmyLiveHost("))
        assertTrue(raidBranch().trimStart().startsWith("${live}ArmyHomeRaidMount("))
        assertTrue(researchBranch().trimStart().startsWith("${live}ResearchLiveHost("))
        assertTrue(heroesBranch().trimStart().startsWith("${live}HeroesLiveHost("))
        // The old full screens are only handed in as `legacy`; the host decides when (history and payment recovery).
        for ((body, old) in listOf(armyBranch() to "ArmyScreen(", researchBranch() to "ResearchScreen(", heroesBranch() to "HeroesScreen(")) {
            assertFalse("$old must not be the body of its Home door", body.substringBefore("legacy = { done ->").contains(old))
            assertTrue(body.substringAfter("legacy = { done ->").contains(old))
        }
        assertFalse("The raid door has no legacy body at all", raidBranch().contains("legacy ="))
        assertFalse(raidBranch().contains("AttackScreen("))
    }

    @Test fun `the raid door opens the designed chooser and the full campaign map only behind its MAP button`() {
        val mount = source("ui/sheets/army/live/ArmyHomeMount.kt").substringAfter("@Composable internal fun ArmyHomeRaidMount(")
        assertTrue(mount.contains("RaidChooserLiveHost(model, home, landOwned, onboarding, constants, actionsAllowed,"))
        assertTrue("CAMPAIGN opens the chooser on its CAMPAIGN tab", mount.contains("initialTab = if (campaign) RAID_TAB_CAMPAIGN else null"))
        assertTrue(mount.contains("onOpenCampaignMap = { mapShown = true }"))
        assertTrue("The Need-more door the Home frame routes reaches the chooser unchanged", mount.contains("onNeedMore = onNeedMore"))
        assertTrue(mount.substringBefore("RaidChooserLiveHost(").contains("if (mapShown)"))
    }

    @Test fun `the CAMPAIGN tab takes its act chapter and stage names from the bundled presentation`() {
        val chooser = hosts().substringAfter("@Composable internal fun RaidChooserLiveHost(").substringBefore("val revengeUi =")
        assertTrue(chooser.contains("val campaignArt = rememberCampaignPresentation()"))
        assertTrue("Without it the tab shows bare ACT n and a blank chapter line", chooser.contains("campaignArt = campaignArt)"))
    }

    @Test fun `a SHORT Shards pill opens the Gold Forge and a SHORT energy pill opens Supplies after the chooser closes`() {
        val needMore = raidBranch().substringAfter("onNeedMore = { price ->").substringBefore("armyState = armyHomeState")
        assertTrue(needMore.contains("val forge = price.icon != \"energy\""))
        assertTrue("Home holds a queued Forge request while the chooser is open, so it must close first",
            needMore.contains("if (forge) { armyLiveSheet = null; attack.closeChooser() }"))
        assertTrue(needMore.contains("handleFeatureDoor(gg.pixelkingdomwars.nativeclient.ui.features.FeatureId(\"goldforge.open\"))"))
        assertTrue("goldforge.open must be a door the Home sheet host mounts", "goldforge.open" in HOME_MOUNTED_FEATURES)
        assertTrue("A refused door or a missing dispatcher still says why", needMore.contains("\"Not enough Shards for this raid.\""))
        // c-gap-army 2026-10-06: rewritten. Energy used to keep only its toast ("no Supplies tab on Home yet"); the SPEC §6
        // door is SUPPLIES, and the designed Supplies sheet (ShopRoute) sells raid energy, so the SHORT energy pill opens it
        // from Home after the chooser closes. Off Home (no Home route to return to) it still says why instead of nothing.
        val supplies = needMore.substringAfter("if (supplies) {").substringBefore("}")
        assertTrue("The chooser closes before the Supplies sheet opens", supplies.contains("armyLiveSheet = null; attack.closeChooser()"))
        assertTrue(supplies.contains("navController.navigate(ShopRoute)"))
        assertTrue(needMore.contains("val supplies = !forge && navController.currentBackStackEntry?.destination?.hasRoute<HomeRoute>() == true"))
        assertTrue("A refused energy door still says why", needMore.contains("\"No raid energy left right now.\""))
        // The split relies on the Shards ante pill carrying no icon override (the energy pill's icon is "energy").
        val shards = shardsAntePrice("100", "40")
        assertEquals(PriceStatus.SHORT, shards.status)
        assertEquals(Currency.SHARDS, shards.currency)
        assertNull(shards.icon)
    }

    // c-gap-army 2026-10-06: rewritten. This case pinned "the old screens are reached from history and saved-payment
    // recovery", which this work deliberately replaced (owner: "I should not see any even 1 of old screens"). The new rule:
    // saved-payment recovery acts on the sheet, and the legacy screen survives only as the history fallback of the
    // standalone routes, which pass no designed history door.
    @Test fun `Research and Heroes reach a legacy screen only as the standalone history fallback`() {
        val research = hosts().substringAfter("@Composable internal fun ResearchLiveHost(").substringBefore("// Heroes (")
        assertEquals(1, Regex("legacyOpen = true").findAll(research).count())
        assertTrue(research.contains("onHistory = { if (onHistoryDoor != null) onHistoryDoor() else legacyOpen = true }"))
        assertFalse("Payment recovery acts on the sheet now", research.contains("onCheckPayment = { legacyOpen = true }"))
        assertTrue("CHECK is the existing receipt observation", research.contains("model.interrupted.check(IntentKind.RESEARCH)"))
        val heroes = hosts().substringAfter("@Composable internal fun HeroesLiveHost(").substringBefore("// Raid chooser")
        assertEquals(1, Regex("legacyOpen = true").findAll(heroes).count())
        assertTrue("The designed door wins; GEAR history opens the bag and the rest the legacy screen only without it",
            heroes.contains("onHistory = { if (onHistoryDoor != null) onHistoryDoor() else if (tab == HERO_TAB_GEAR) onOpenGear() else legacyOpen = true }"))
    }

    /** On Home every history icon of the group is a designed destination: an old screen behind the header icon is the
     *  most visible way back to the retired look, and no mapper test would notice it. */
    @Test fun `the Home history icons open the designed Battle log and History sheet`() {
        val armyDoor = armyBranch().substringAfter("onHistoryDoor = {")
        assertTrue(armyDoor.substringBefore("})").contains("navController.navigate(RaidLogRoute)"))
        for (body in listOf(researchBranch(), heroesBranch())) {
            val door = body.substringAfter("onHistoryDoor = {").substringBefore("})")
            assertTrue(door.contains("localRouteHost.navigateResult(Destination.WalletHistory(), HomeTab.KINGDOM) == HomeNavigationResult.DISPATCHED"))
            assertTrue("A refused History still says why", door.contains("localRouteHost.locked("))
        }
        val hosts = hosts()
        assertEquals("Army, Research and Heroes each take the door", 3, Regex("onHistoryDoor: \\(\\(\\) -> Unit\\)\\? = null").findAll(hosts).count())
    }

    /** c-gap-army 2026-10-06: with history going to the Battle log, the old ArmyScreen editor is off Home, so a saved army's
     *  REPLACE and DELETE live on the ARMY tab. They must be the same PUT / DELETE the old editor sent, and a dialog that
     *  leaves must clear its draft, or Home keeps refusing to swap the army owner. */
    @Test fun `a saved army is replaced or deleted on the ARMY tab through the existing preset owner`() {
        val army = hosts().substringAfter("@Composable internal fun ArmyLiveHost(").substringBefore("// Research")
        assertTrue(army.contains("onManageSaved = { slot ->"))
        val dialog = army.substringAfter("manageSlot?.let { slot ->").substringBefore("val info = infoTroop")
        assertTrue("REPLACE saves today's camp, never a guessed list",
            dialog.contains("currentArmyPresetComposition(current, baseGeneration)") && dialog.contains("model.saveCurrentArmy(slot,"))
        assertTrue("DELETE removes only the slot the dialog marked", dialog.contains("model.state.value.presetDraft?.slot == slot) { model.deletePreset()"))
        assertTrue("CLOSE clears the draft", dialog.contains("val close: () -> Unit = { model.cancelEditing(); manageSlot = null }"))
        assertTrue("Leaving without CLOSE clears it too", dialog.contains("DisposableEffect(slot) { onDispose {"))
    }

    @Test fun `saved payments recover on the TRAIN and Lab sheets`() {
        val army = hosts().substringAfter("@Composable internal fun ArmyLiveHost(").substringBefore("// Research")
        assertTrue(army.contains("trainingSavedPayments(state)"))
        assertTrue(army.contains("model.reviewTrainingFinishSaved()"))
        assertTrue(army.contains("trainRecovery = trainRecovery"))
        val research = hosts().substringAfter("@Composable internal fun ResearchLiveHost(").substringBefore("// Heroes (")
        assertTrue(research.contains("researchSavedPayments(state)"))
        assertTrue(research.contains("model.reviewResearchSaved()"))
        assertTrue(research.contains("recovery = recovery"))
    }

    @Test fun `the raid log door opens the designed battle log`() {
        val attack = source("ui/attack/AttackScreen.kt").substringAfter("@Composable fun AttackScreen(")
        assertTrue(attack.substringBefore("val state by model.state.collectAsState()")
            .contains("if (historyOnly && gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.ArmyLive.ENABLED) {"))
        assertTrue(attack.contains("BattleLogLiveHost(model, onBack)"))
        assertTrue(ArmyLive.ENABLED)
    }
}
