package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.ui.features.FeatureId
import gg.pixelkingdomwars.nativeclient.ui.hud.HudGeometry
import gg.pixelkingdomwars.nativeclient.ui.hud.HudIds
import gg.pixelkingdomwars.nativeclient.ui.hud.homeHeraldShown
import gg.pixelkingdomwars.nativeclient.ui.model.ChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandBarUi
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandUi
import gg.pixelkingdomwars.nativeclient.ui.model.DeckButtonUi
import gg.pixelkingdomwars.nativeclient.ui.model.HeraldUi
import gg.pixelkingdomwars.nativeclient.ui.model.HomeHudUi
import gg.pixelkingdomwars.nativeclient.ui.model.ProfileMedallionUi
import gg.pixelkingdomwars.nativeclient.ui.model.ResourceChipUi
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Home and buildings gap pass of 2026-10-06 (owner: "I should not see any even 1 of old screens", "none of screens
 * should overlay each other"). WHY each case matters:
 * - a selection or a placement draft must own the top of the screen: the herald, the test tag and the recovery column sat
 *   on the placement hint and beside the name plate (owner screenshots 3 and 4), against buildings/SPEC.md §1.2 item 5;
 * - the recovery column must end before the QUESTS edge button, or its plates cover a door (owner screenshot 1);
 * - the first-selections hint must only promise "open it" when tap 2 opens something (COLLECT and REARM act in place);
 * - the old dark ink panel, cards and dialogs must not come back on the Home path; their words are consent and must not
 *   change while the look does (money rule).
 * Composables do not run on the JVM: the pure rules are tested directly and the mount is pinned by its text.
 */
class HomeGapHomeBuildingsTest {
    private fun source(path: String) = listOf(File("src/main/kotlin/gg/pixelkingdomwars/nativeclient", path),
        File("app/src/main/kotlin/gg/pixelkingdomwars/nativeclient", path)).first { it.isFile }.readText()

    private val hud = HomeHudUi(
        profile = ProfileMedallionUi(HudIds.PROFILE, "4", null, "Profile, Keep level 4"),
        builders = ChipUi(HudIds.BUILDERS, "builder", "1/2", "Builders 1 of 2 free"),
        shield = ChipUi(HudIds.SHIELD, "shield", "4h", "Shield 4 hours"),
        resources = listOf(ResourceChipUi(HudIds.SHARDS, "shards", "40,943", null, false, null, name = "Shards")),
        rightEdge = emptyList(), leftEdge = emptyList(),
        herald = HeraldUi("land", "map", "Buy land to join the world map", FeatureId("land.herald")),
        deck = listOf(
            DeckButtonUi(HudIds.ATTACK, "attack", "ATTACK", true, null, null, verb = Verb.RED),
            DeckButtonUi(HudIds.BUILD, "shape:hammer", "BUILD", true, null, null, verb = Verb.GREEN),
        ),
        deckVisible = true,
    )

    private fun command(id: FeatureId, caption: String, primary: Boolean = false, state: CommandState = CommandState.ENABLED) =
        CommandUi(id, "ui:icon", caption, null, primary, state, if (state == CommandState.ENABLED) null else "Busy", null)

    private fun bar(primary: CommandUi) = CommandBarUi("b1", listOf(command(BuildingCommandIds.INFO, "INFO"), primary))

    @Test fun `the herald steps aside while a building is selected or placed and returns with the deck`() {
        assertEquals("at rest the land herald is the land door", hud.herald, homeHeraldShown(hud))
        assertNull("a selection or a draft hides the deck, and the herald with it", homeHeraldShown(hud.copy(deckVisible = false)))
    }

    @Test fun `the recovery column hides with the top-left cluster and only then`() {
        assertTrue(homeStatusShown(selected = false, placing = false))
        assertFalse("a selected building owns the top (name plate)", homeStatusShown(selected = true, placing = false))
        assertFalse("a draft owns the top (placement hint)", homeStatusShown(selected = false, placing = true))
    }

    @Test fun `the recovery plates end where the herald ends so QUESTS is never covered`() {
        // Each plate pads 8 dp inside the column; column end inset + 8 must equal the herald's own end inset.
        assertEquals(HudGeometry.HERALD_END, HOME_STATUS_END_DP + 8)
        assertTrue("the QUESTS button starts right of the plates",
            HudGeometry.SCREEN_W - HOME_STATUS_END_DP - 8 <= HudGeometry.SCREEN_W - HudGeometry.EDGE_RIGHT - HudGeometry.EDGE)
    }

    @Test fun `the first selections hint names the building and only promises a door`() {
        assertEquals("Tap the gold forge again to open it",
            selectionHintLine("GOLD FORGE", bar(command(BuildingCommandIds.FORGE, "FORGE", primary = true))))
        assertNull("COLLECT collects in place, it opens nothing",
            selectionHintLine("MINE", bar(command(BuildingCommandIds.COLLECT, "COLLECT", primary = true))))
        assertNull("REARM spends in place", selectionHintLine("SPIKE TRAP", bar(command(BuildingCommandIds.REARM, "REARM", primary = true))))
        assertNull("a swapped COLLECT with its own id is still in place",
            selectionHintLine("LODGE", bar(command(FeatureId("lodge.collect"), "COLLECT", primary = true))))
        assertNull("an off primary cannot be opened by tap 2",
            selectionHintLine("BARRACKS", bar(command(BuildingCommandIds.TRAIN, "TRAIN", primary = true, state = CommandState.DISABLED))))
        assertNull("no plate, no hint", selectionHintLine(null, bar(command(BuildingCommandIds.TRAIN, "TRAIN", primary = true))))
    }

    @Test fun `the hint shows for the first three selections per install`() {
        assertEquals(3, SELECTION_HINT_LIMIT)
        assertTrue(selectionHintDue(0)); assertTrue(selectionHintDue(2)); assertFalse(selectionHintDue(3))
        val screen = source("ui/kingdom/KingdomScreen.kt")
        assertTrue("the bar carries the hint the command bar already draws",
            screen.contains("SelectionAnchorLayer(currentPlate, currentBar?.copy(hint = selectionHint),"))
        assertTrue(screen.contains("rememberSelectionHint(local.selectedBuildingId, selectionHintLine(currentPlate?.name, currentBar))"))
    }

    @Test fun `legacy drafts get the kit band with the old words`() {
        val wall = legacyPlacementBandUi("wall", "Wall", wall = null, builderBusy = false)
        assertEquals("WALL", wall.name)
        assertEquals("release submits the stroke, so the hint must say so", WALL_STROKE_HINT, wall.hint)
        assertTrue(wall.hint.contains("Release to build the whole green stroke."))
        assertNull(wall.warning)
        val mine = legacyPlacementBandUi("mine", "Mine", wall = null, builderBusy = true)
        assertEquals("Tap a location for Mine. Pinch to zoom; drag to explore.", mine.hint)
        assertEquals("No free builder", mine.warning)
        assertNull(legacyPlacementBandUi("mine", "Mine", wall = null, builderBusy = false).warning)
    }

    @Test fun `two short recovery doors share a row and long ones stack so no caption is cut`() {
        assertTrue(recoveryActionsInRow(listOf("RETRY CHECK", "TRY AGAIN")))
        assertFalse(recoveryActionsInRow(listOf("CHECK ORIGINAL RECEIPT")))
        assertFalse(recoveryActionsInRow(listOf("A", "B", "C")))
    }

    @Test fun `no old dark panel card or dialog is left on the Home path of this group`() {
        val screen = source("ui/kingdom/KingdomScreen.kt")
        val status = screen.substringAfter("if (!editing && liveTray == null && homeStatusShown(").substringBefore("statusContent() }")
        assertFalse("the recovery column draws no ink box behind its plates", status.contains("background(Palette.ink)"))
        assertTrue(status.contains("end = HOME_STATUS_END_DP.dp"))
        assertFalse("the placement ink panel is gone", screen.contains("YOUR BUILDER IS BUSY — OPEN THE ACTIVE JOB ABOVE"))
        assertTrue(screen.contains("LegacyPlacementHost(draft.type, trayLabel(draft.type),"))
        // The tile dialog, the KEEP builder finish and the saved builder payment keep their words on kit surfaces.
        assertTrue(screen.contains("KingdomConfirmDialog(KingdomConfirmUi(\"Place \${trayLabel(draft.type)}\".uppercase(),"))
        assertTrue(screen.contains("\"Pay only the shown currency. The charge may decrease as this job finishes naturally.\""))
        assertTrue(screen.contains("RecoveryPlate(\"SAVED BUILDER PAYMENT\""))
        val pending = screen.substringAfter("private fun BuilderFinishPending(").substringBefore("private fun BuilderFinishCurrencyConfirm(")
        assertFalse(pending.contains("Card("))
        val confirm = screen.substringAfter("private fun BuilderFinishCurrencyConfirm(").substringBefore("/** Receipt-only entry")
        assertFalse(confirm.contains("AlertDialog("))
        val panels = source("ui/kingdom/HeroAltarPanels.kt")
        val heroConfirm = panels.substringAfter("internal fun HeroAltarConfirm(").substringBefore("internal fun HeroRecruitmentHistory(")
        assertFalse(heroConfirm.contains("AlertDialog("))
        assertTrue("the hero consent words are unchanged", heroConfirm.contains(
            "The server uses an available prepaid hero contract first. Otherwise it may charge up to the reviewed KEEP amount."))
        assertFalse(panels.substringAfter("internal fun HeroRecruitmentHistory(").contains("Card("))
        assertFalse(source("ui/kingdom/WallBatchPanels.kt").contains("Card("))
        val sheet = source("ui/kingdom/BuildingSheet.kt")
        val cancel = sheet.substringAfter("fun CancelJobDialog(").substringBefore("fun KeepSpendDialog(")
        assertFalse(cancel.contains("AlertDialog("))
        assertTrue(cancel.contains("\"THE BUILDER IS FREED · A PAID FINISH IS NOT REFUNDED\""))
        assertFalse(sheet.substringAfter("internal fun RunningObstacleSheet(").contains("AlertDialog("))
    }

    @Test fun `the herald and the test tag step aside through the HUD itself`() {
        assertTrue(source("ui/hud/HomeHud.kt").contains("HeraldBanner(homeHeraldShown(ui), on.openFeature,"))
        assertTrue(source("ui/home/HomeScaffold.kt").contains("Modifier.homeChromeHidden(world && !showTasks)"))
    }
}
