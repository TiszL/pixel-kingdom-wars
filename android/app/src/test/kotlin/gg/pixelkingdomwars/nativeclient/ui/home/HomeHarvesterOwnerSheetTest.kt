package gg.pixelkingdomwars.nativeclient.ui.home

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The Harvester sheet on Home acts in place (frames harvester-yield, harvester-arrived, harvester-history): START and the
 * saved re-review use the existing reviewed owner, COLLECT celebrates the haul the player was shown, UPGRADE and the
 * USED FOR doors lead somewhere real, and nothing goes back to an explain-only toast or a raw chrome button. Source pins,
 * because the host is a Compose body over session-owned repositories; the pure parts are tested in
 * HarvesterCelebrationMapperTest. Authored without a build; the main loop runs it.
 */
class HomeHarvesterOwnerSheetTest {
    private fun source(path: String): String {
        val relative = "src/main/kotlin/gg/pixelkingdomwars/nativeclient/$path"
        return listOf(File(relative), File("app/$relative")).first { it.isFile }.readText()
    }

    private fun file(): String = source("ui/home/HomeHarvesterOwnerSheet.kt")
    private fun host(): String = file().substringAfter("@Composable internal fun HomeHarvesterOwnerSheet(")

    @Test fun `START and the saved request review open the existing reviewed owner in the sheet`() {
        val host = host()
        assertTrue(host.contains("reviewController?.open("))
        assertTrue(host.contains("reviewStart = { openReview(facts?.buildingId) }"))
        assertTrue(host.contains("if (saved != null) openReview(saved.command.request.harvesterId)"))
        // The saved re-review resumes only this kingdom's unproven request; accepted or declined ones stay with CHECK.
        assertTrue(host.contains("it.proof == null && it.refusal == null && it.command.request.baseId == identity.baseId"))
        assertFalse("no raw chrome button above the designed sheet", host.contains("TextButton("))
        assertFalse(host.contains("HarvesterViewModel(")); assertFalse(host.contains("HarvesterRepository("))
    }

    @Test fun `UPGRADE focuses the Harvester on Home instead of telling the player where to go`() {
        val host = host()
        val upgrade = host.substringAfter("openUpgrade = {").substringBefore("openWorkshop = {")
        assertTrue(upgrade.contains("if (building != null) onFocusBuilding(building)"))
        assertTrue("the building id comes from the server facts, never a guess", upgrade.contains("val building = facts?.buildingId"))
        assertFalse(host.contains("Select the Harvester building and open UPGRADE."))
    }

    @Test fun `refine and sell GO open the designed Workshop REFINE and Market SELL sheets`() {
        val host = host()
        assertTrue(host.contains("openWorkshop = { _ -> checked { onOpenDestination(Destination.Workshop(WorkshopTab.REFINE)) } }"))
        assertTrue(host.contains("openMarketSell = { _ -> checked { onOpenDestination(Destination.Market(MarketTab.SELL)) } }"))
        assertFalse(host.contains("Open the Workshop to refine this resource."))
        assertFalse(host.contains("Open the Market to sell this resource."))
    }

    @Test fun `COLLECT names the shown haul before the seen marker moves and never calls the server`() {
        val host = host()
        val collect = host.substringAfter("markSeen = {").substringBefore("openUpgrade = {")
        val party = collect.indexOf("harvesterArrivedCelebration(ui.harvest")
        val acknowledge = collect.indexOf("seen.acknowledge(source, harvesterLatestSequence(current.journal, source))")
        assertTrue("the celebration is built from the haul on the button", party >= 0)
        assertTrue("after the marker moves the same haul reads as seen, so the party must come first", acknowledge > party)
        assertTrue("a source replaced since the last paint celebrates nothing", collect.contains("if (source == sourceId)"))
        assertFalse(collect.contains("owner.refresh")); assertFalse(collect.contains("owner.check"))
        assertTrue(host.contains("celebrationDone = { celebration = null }"))
        assertTrue(host.contains("HarvesterSheetR2Ui(ui.copy(celebration = celebration), historyTab = history)"))
    }

    @Test fun `history keeps the honest receipt mapper and its guarded CHECK`() {
        val host = host()
        assertTrue(host.contains("harvesterHistoryLiveUi("))
        assertTrue(host.contains("onCheck = { if (canCheckNow()) retry++"))
        assertTrue(host.contains("snapshotFlow { currentCanRead() && reviewController?.holding != true }.first { it }"))
    }

    @Test fun `header art comes from the mount and is never derived in the host`() {
        val host = host()
        assertTrue(host.contains("artKey = artKey, tier = artTier(facts?.level)"))
        assertFalse("a null key would draw grass only, the gap this sheet closes", host.contains("artKey = null"))
        assertTrue(host.contains("reviewController: HomeHarvesterReviewController?, artKey: String?, artTier: (Int?) -> Int?,"))
    }

    @Test fun `every in-sheet door explains a refused guard instead of doing nothing`() {
        val host = host()
        assertTrue(host.contains("val checked: (() -> Unit) -> Unit = { action -> if (currentCanRead() && owner.projection.currentState() != null) action()"))
        val guard = host.substringAfter("val checked: (() -> Unit) -> Unit =").substringBefore("val openReview")
        assertEquals(1, Regex("""else\s+explain\(homeReadRefusalReason\(""").findAll(guard).count())
        for (door in listOf("markSeen = {", "openUpgrade = {", "openWorkshop = {", "openMarketSell = {", "needMore = {", "checkReceipt = {"))
            assertTrue(door, host.substringAfter(door).trimStart().startsWith("checked {") ||
                host.substringAfter(door).trimStart().startsWith("_ -> checked {") ||
                host.substringAfter(door).trimStart().startsWith("price -> checked {"))
    }

    @Test fun `owner missing plate is drawn with kit parts and keeps the recovery route`() {
        val file = file()
        assertFalse(file.contains("material3.Text")); assertFalse(file.contains("ui.chrome.TextButton"))
        assertTrue(file.contains("Harvester recovery is unavailable. Saved receipts are preserved."))
        assertTrue(file.contains("SecondaryButton(\"ORIGINAL REQUESTS\", onOriginal"))
        assertTrue(host().contains("onOriginal = { if (canRead()) onLegacy()"))
    }
}
