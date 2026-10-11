package gg.pixelkingdomwars.nativeclient.ui.more

import gg.pixelkingdomwars.nativeclient.model.Quest
import gg.pixelkingdomwars.nativeclient.model.QuestBoard
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * hub SPEC §2.3: every quest in progress is a door to the place where it is done. Before this, only the six tutorial
 * templates had one, so almost every daily row was drawn LOCKED ("This quest destination is not connected yet"; owner
 * 2026-10-06 "UI unfinished"). WHY these pins matter: a daily quest without a door is a dead row, and a PvP quest that
 * opens the campaign (or the reverse) sends the player to the wrong fight.
 */
class QuestDoorsTest {
    /** The server's daily pool (constants.ts QUESTS.dailyTemplates) and tutorial chain, as the catalogue labels them. */
    private val serverTemplates = listOf(
        "all_3_buffs", "campaign_2_stages", "campaign_3star", "campaign_clear", "claim_daily_cache", "clear_2_keeps", "clear_5_keeps",
        "clear_obstacle", "clear_ruined_keep", "collect_1000_mined", "collect_mines", "defend_success", "deploy_20_troops", "deploy_hero",
        "earn_5_stars", "earn_8_stars", "first_barracks", "first_camp", "first_land", "first_mine", "first_raid", "first_troops",
        "forge_smelt", "hero_untouched", "place_10_walls", "place_5_walls", "raid_3_times", "scout_1", "scout_3", "spend_200", "spend_500",
        "steal_1500", "steal_500", "steal_5000", "train_100_points", "train_20_points", "train_5_troops", "train_tur_rider",
        "two_keg_runners", "upgrade_2_buildings", "upgrade_any", "upgrade_hero", "upgrade_to_level_3", "use_2_giants", "use_2_plunderers",
        "use_2_trolls", "use_3_tunnelers", "use_3_tur_riders", "use_5_bowmen", "use_5_highlanders", "use_a_dragon", "use_a_mage",
        "use_powder_charge", "use_swift_boots", "use_war_horn", "vault_buster", "win_10_raids", "win_2_raids", "win_2_star", "win_3_star",
        "win_from_map",
    )

    @Test fun `every server quest template has a door and a place icon so no daily row is a dead padlock`() {
        for (code in serverTemplates) {
            assertTrue("$code has a door", questDoorId(code) != null)
            assertTrue("$code has an icon", questDoorIcon(code) != null)
        }
    }

    @Test fun `PvP quests open the raid chooser and campaign quests open the campaign`() {
        for (code in listOf("win_2_raids", "steal_500", "use_a_dragon", "deploy_20_troops", "earn_5_stars", "scout_3", "vault_buster", "two_keg_runners"))
            assertEquals(code, QuestDoorIds.RAID, questDoorId(code))
        for (code in listOf("campaign_clear", "clear_ruined_keep", "clear_5_keeps", "first_raid"))
            assertEquals(code, QuestDoorIds.CAMPAIGN, questDoorId(code))
    }

    @Test fun `building, training, mine, forge and base quests go to their own place`() {
        assertEquals(QuestDoorIds.BUILD, questDoorId("upgrade_any"))
        assertEquals(QuestDoorIds.BUILD, questDoorId("place_10_walls"))
        assertEquals(QuestDoorIds.TRAIN, questDoorId("train_tur_rider"))
        assertEquals(QuestDoorIds.TRAIN, questDoorId("first_troops"))
        assertEquals(QuestDoorIds.MINE, questDoorId("collect_mines"))
        assertEquals(QuestDoorIds.FORGE, questDoorId("forge_smelt"))
        assertEquals(QuestDoorIds.HOME, questDoorId("claim_daily_cache"))
        assertEquals(QuestDoorIds.LAND, questDoorId("first_land"))
    }

    @Test fun `an unknown template is never guessed`() {
        assertNull(questDoorId("brand_new_mystery"))
        assertNull(questDoorIcon("brand_new_mystery"))
    }

    @Test fun `the daily bonus counts claimed dailies against the catalogue target and never invents one`() {
        val catalogue = buildJsonObject { put("constants", buildJsonObject { put("QUESTS", buildJsonObject { put("dailyBonusAt", JsonPrimitive(3)) }) }) }
        val board = QuestBoard(quests = listOf(
            Quest(id = "a", scope = "daily", templateCode = "win_2_raids", claimed = true, completed = true),
            Quest(id = "b", scope = "daily", templateCode = "upgrade_any", claimed = true, completed = true),
            Quest(id = "c", scope = "daily", templateCode = "scout_1"),
            Quest(id = "d", scope = "kingdom", templateCode = "first_camp", claimed = true, completed = true),
        ), allThreeBonus = "30")
        val target = questBonusTarget(catalogue)
        assertEquals(3, target)
        val bonus = questBonusUi(board, target)
        assertEquals("only claimed dailies count", 2, bonus.done)
        assertEquals(3, bonus.total)
        assertEquals("30", bonus.reward?.amount)
        assertNull("the board carries no reset time", bonus.resetsIn)
        val unknown = questBonusUi(board, questBonusTarget(null))
        assertNull(unknown.done); assertNull(unknown.total)
    }
}
