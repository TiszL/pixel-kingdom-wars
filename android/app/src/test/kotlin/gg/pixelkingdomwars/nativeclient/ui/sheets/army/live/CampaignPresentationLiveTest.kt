package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.model.CampaignStage
import gg.pixelkingdomwars.nativeclient.ui.attack.CampaignArtwork
import gg.pixelkingdomwars.nativeclient.ui.attack.CampaignChapterArt
import gg.pixelkingdomwars.nativeclient.ui.attack.CampaignRegionArt
import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** The CAMPAIGN tab names its act, chapter and stages from the same bundled presentation the campaign map reads, and
 *  only from it: progress stays the server's, and a missing or unmatched presentation never invents a chapter. */
class CampaignPresentationLiveTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val constants = obj("""{"CAMPAIGN":{"stagesPerAct":10,"firstThreeStarShardsByKeep":[500,800]}}""")
    private fun region(name: String) = CampaignRegionArt(name, "#406030", listOf(0, 0, 100, 100), listOf(listOf(10, 10)), "grass")
    private fun chapter(id: Int, region: String, name: String) = CampaignChapterArt(id, region, name, "$name epithet.", "$name lore.",
        "LANDMARK $id", (1..10).map { "$name stage $it" })
    private val art = CampaignArtwork(
        chapters = listOf(chapter(1, "crownlands", "The Crownroad"), chapter(2, "elderwood", "Beneath the Elderboughs")),
        regions = mapOf("crownlands" to region("Crownlands"), "elderwood" to region("Elderwood")),
    )
    private fun stage(n: Int, act: Int?, tactic: String? = null, bestStars: Int = 0, unlocked: Boolean = true) =
        CampaignStage(stage = n, act = act, name = "Server stage $n", tactic = tactic, keepLevel = 2, bestStars = bestStars, unlocked = unlocked)

    @Test fun `the act header reads the chapter whose id is the stage's act, not the first chapter or the list position`() {
        // Act 2 sits second in the list here, but the rule is the id match: a reordered file must not swap chapters.
        val stages = listOf(stage(11, 2, bestStars = 3), stage(12, 2), stage(13, 2, unlocked = false))
        val ui = requireNotNull(campaignLiveUi(stages, null, constants, 40, 50, art.copy(chapters = art.chapters.reversed()), 10))
        assertEquals("ACT 2 · ELDERWOOD", ui.act.title)
        assertEquals("Beneath the Elderboughs", ui.act.chapter)
        assertEquals("Beneath the Elderboughs epithet.", ui.act.epithet)
        assertEquals("1 of 3 cleared", ui.act.cleared)
    }

    @Test fun `the stage name is the chapter's name at stage minus one modulo stages per act`() {
        // Stage 13 is the third stage of act 2 at ten per act: names[2]. A wrong modulo would name another stage.
        assertEquals("Beneath the Elderboughs stage 3", stageCard(stage(13, 2), constants, 1, 2, art, 10).name)
        assertEquals("The Crownroad stage 10", stageCard(stage(10, 1), constants, 1, 2, art, 10).name)
        // Without the catalogue's stagesPerAct the presentation cannot place the stage: the server's name stays.
        assertEquals("Server stage 13", stageCard(stage(13, 2), constants, 1, 2, art, null).name)
    }

    @Test fun `stages per act comes from the catalogue CAMPAIGN rule exactly like the campaign map`() {
        assertEquals(10, campaignPerAct(constants))
        assertEquals(7, campaignPerAct(obj("""{"CAMPAIGN":{"stagesPerAct":"7"}}""")))
        assertNull(campaignPerAct(null))
        assertNull(campaignPerAct(obj("""{"CAMPAIGN":{}}""")))
        assertNull(campaignPerAct(obj("""{"CAMPAIGN":{"stagesPerAct":"ten"}}""")))
    }

    @Test fun `the server tactic is the lore line and the chapter lore only fills a stage without one`() {
        assertEquals("Towers guard the ford.", stageCard(stage(3, 1, tactic = "Towers guard the ford."), constants, 1, 2, art, 10).lore)
        assertEquals("The Crownroad lore.", stageCard(stage(3, 1), constants, 1, 2, art, 10).lore)
        assertEquals("The Crownroad lore.", stageCard(stage(3, 1, tactic = "  "), constants, 1, 2, art, 10).lore)
    }

    @Test fun `without the presentation the card keeps the server name and the chapter line stays blank, never invented`() {
        val stages = listOf(stage(1, 1, tactic = "Walls first."), stage(2, 1))
        val ui = requireNotNull(campaignLiveUi(stages, 1, constants, 40, 50))
        assertEquals("ACT 1", ui.act.title)
        assertEquals("", ui.act.chapter)
        assertEquals("", ui.act.epithet)
        assertEquals("Server stage 1", ui.selected.name)
        assertEquals("Walls first.", ui.selected.lore)
        assertEquals("", stageCard(stage(2, 1), constants, 1, 2).lore)
    }

    @Test fun `an act the presentation does not know keeps the server's values`() {
        val stages = listOf(stage(91, 9, tactic = "Siege lines."), stage(92, 9))
        val ui = requireNotNull(campaignLiveUi(stages, 91, constants, 40, 50, art, 10))
        assertEquals("ACT 9", ui.act.title)
        assertEquals("", ui.act.chapter)
        assertEquals("", ui.act.epithet)
        assertEquals("Server stage 91", ui.selected.name)
        assertEquals("Siege lines.", ui.selected.lore)
        // A stage with no act at all is the whole campaign: no chapter can be claimed for it.
        val actless = requireNotNull(campaignLiveUi(listOf(stage(1, null)), 1, constants, 40, 50, art, 10))
        assertEquals("CAMPAIGN", actless.act.title)
        assertEquals("Server stage 1", actless.selected.name)
    }

    @Test fun `the shipped presentation parses and names act 4 stage 36 as campaign png does`() {
        // rememberCampaignPresentation swallows a parse failure into null; this keeps the bundled file from silently
        // blanking every chapter line.
        val shipped = CampaignArtwork.read(File("src/main/res/raw/pkw_campaign_presentation.json").readText())
        val ui = requireNotNull(campaignLiveUi(listOf(stage(35, 4, bestStars = 3), stage(36, 4)), 36, constants, 42, 50, shipped, 10))
        assertEquals("ACT 4 · ELDERWOOD", ui.act.title)
        assertEquals("The Rootbound Covenant", ui.act.chapter)
        assertEquals("Listen beneath the stone.", ui.act.epithet)
        assertEquals("Dreamwood Passage", ui.selected.name)
    }
}
