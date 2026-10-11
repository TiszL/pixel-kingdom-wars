package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Verb
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.BattleMode
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.MedalTone
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResultSettlement
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** result.png / result-defeat.png: the celebration pays out only what the persisted server result says. A number the
 *  result does not carry reads "…" (never a reassuring 0), and every door runs an existing battle owner. */
class BattleResultLiveMapperTest {
    private val victory = """{"stars":2,"destructionPct":74,"keepDestroyed":false,"lootShards":12400,"attackerTrophyDelta":18,
        "defenderTrophyDelta":-18,"retreated":false,"lootRedacted":false}"""
    private val defeat = """{"stars":0,"destructionPct":37,"keepDestroyed":false,"lootShards":0,"attackerTrophyDelta":-9,
        "defenderTrophyDelta":9,"retreated":false,"lootRedacted":false}"""
    private val snapshot = """{"armySnapshot":{"counts":{"highlander":8,"bowman":10,"mage":2},"levels":{"highlander":3,"bowman":1},
        "heroes":["vex"],"heroLevels":{"vex":1},"attackerKeepLevel":5}}"""

    private fun deploy(troop: String) = buildJsonObject { put("kind", "deploy"); put("payload", buildJsonObject { put("troop", troop) }) }
    private fun hero(id: String) = buildJsonObject { put("kind", "hero"); put("payload", buildJsonObject { put("hero", id) }) }
    private fun live(commands: List<JsonObject> = List(3) { deploy("highlander") } + List(2) { deploy("bowman") },
        raidId: String? = "raid-1", target: PendingRaidTarget? = PendingRaidTarget(defenderBaseId = "deed-ironjaw", name = "Ironjaw"),
        stage: Int? = null) = LiveBattleState(phase = BattlePhase.RUNNING, connected = true,
        pending = PendingBattle("wallet", "base", raidId, stage = stage, target = target), presentation = json(snapshot), commands = commands)
    private fun card(result: String, state: LiveBattleState = live(), target: RaidCreateTarget? = RaidCreateTarget.Pvp(name = "Ironjaw"),
        next: String = "NEXT", busy: Boolean = false, catalogue: JsonObject? = null) =
        battleResultV2Ui(json(result), target, next, state.copy(result = json(result)), catalogue, busy)

    @Test fun `victory numbers come only from the server result`() {
        val ui = card(victory)
        assertTrue(ui.won)
        assertEquals(2, ui.stars)
        assertEquals(74, ui.destroyedPct)
        assertEquals("destroyed · vs Ironjaw", ui.verdict)
        assertEquals(ResultSettlement.SETTLED, ui.settlement)
        assertEquals(BattleMode.PVP, ui.mode)
        val (shards, trophies) = ui.medallions
        assertEquals("+12,400", shards.delta)
        assertEquals(MedalTone.GAIN, shards.tone)
        assertEquals("Critic fix wording", "into your stores", shards.context)
        assertTrue("A victory's gain counts into the stores with the coin flight", shards.counting)
        assertEquals("+18", trophies.delta)
        assertEquals(MedalTone.GAIN, trophies.tone)
        assertFalse(trophies.counting)
        assertTrue("The result carries no balances, so no before/after readout is computed", ui.readouts.isEmpty())
        // Another server figure changes the card: nothing is cached, derived from stars or taken from constants.
        val other = card(victory.replace("12400", "300").replace("\"destructionPct\":74", "\"destructionPct\":51"))
        assertEquals("+300", other.medallions.first().delta)
        assertEquals(51, other.destroyedPct)
        assertEquals("destroyed · vs Ironjaw · keep fell", card(victory.replace("\"keepDestroyed\":false", "\"keepDestroyed\":true")).verdict)
        assertEquals("The server's star count is capped to the three drawn", 3, card(victory.replace("\"stars\":2", "\"stars\":7")).stars)
    }

    @Test fun `redacted loot shows no count`() {
        val ui = card(victory.replace("\"lootRedacted\":false", "\"lootRedacted\":true"))
        assertEquals(ResultSettlement.REDACTED, ui.settlement)
        val shards = ui.medallions.first()
        assertEquals("REDACTED", shards.delta)
        assertFalse("A withheld loot never leaks the number", shards.delta.any { it.isDigit() })
        assertFalse(shards.counting)
    }

    @Test fun `missing loot or destruction reads unknown and never zero`() {
        val ui = card("""{"stars":1,"retreated":false}""")
        assertNull("Missing destruction is drawn as unknown, not 0%", ui.destroyedPct)
        assertEquals("…", ui.medallions[0].delta)
        assertEquals("…", ui.medallions[1].delta)
        assertTrue(ui.medallions.none { it.delta == "0" || it.delta == "+0" })
        assertFalse("Nothing counts or flies for an unknown amount", ui.medallions[0].counting)
        val malformed = card("""{"stars":1,"destructionPct":"lots","lootShards":"12.5","attackerTrophyDelta":"x"}""")
        assertNull(malformed.destroyedPct)
        assertEquals(listOf("…", "…"), malformed.medallions.map { it.delta })
    }

    @Test fun `defeat has grey stars a trophy loss and the defeat hint`() {
        val ui = card(defeat)
        assertFalse(ui.won)
        assertEquals("Unearned stars land grey", 0, ui.stars)
        assertEquals(37, ui.destroyedPct)
        assertEquals("destroyed · the walls held", ui.verdict)
        val (shards, trophies) = ui.medallions
        assertEquals("0", shards.delta)
        assertEquals(MedalTone.ZERO, shards.tone)
        assertEquals("nothing taken", shards.context)
        assertFalse("result-defeat.png draws no counting tint and nothing flies", shards.counting)
        assertEquals("−9", trophies.delta)
        assertEquals(MedalTone.LOSS, trophies.tone)
        assertEquals("REPLAY shows what held them off.", ui.defeatHint)
        assertNull("The hint is the defeat's only", card(victory).defeatHint)
    }

    @Test fun `campaign mode and NEXT label come from the create target`() {
        // A first-clear reward in the constants must never become a paid medallion: only the result could say it was paid.
        val catalogue = json("""{"constants":{"CAMPAIGN":{"tierByStage":[1,1,2],"firstClearRewardShards":2400}}}""")
        val campaign = card(victory, state = live(target = null, stage = 2), target = RaidCreateTarget.Campaign(2), next = "NEXT STAGE",
            catalogue = catalogue)
        assertEquals(BattleMode.CAMPAIGN, campaign.mode)
        assertEquals("destroyed · Stage 2", campaign.verdict)
        assertEquals("NEXT STAGE", campaign.next.caption)
        assertEquals(2, campaign.medallions.size)
        // A resumed raid has no create target; its pending stage still names the campaign.
        val resumed = card(victory, state = live(target = null, stage = 7), target = null)
        assertEquals(BattleMode.CAMPAIGN, resumed.mode)
        assertEquals("destroyed · Stage 7", resumed.verdict)
        assertEquals("NEXT", card(victory).next.caption)
    }

    @Test fun `HOME is the primary door and every door holds while an order is in flight`() {
        for (ui in listOf(card(victory), card(defeat))) {
            assertTrue("HOME is the primary on both frames, onboarding or not", ui.home.primary)
            assertEquals(Verb.GREEN, ui.home.verb)
            assertFalse(ui.retrain.primary)
            assertEquals(Verb.BLUE, ui.retrain.verb)
            assertFalse(ui.next.primary)
            assertEquals(Verb.STONE, ui.next.verb)
            assertEquals(Verb.STONE, ui.replay?.verb)
            assertTrue(listOfNotNull(ui.retrain, ui.replay, ui.next, ui.home).all { it.state == CommandState.ENABLED })
        }
        assertEquals("raid-1", card(victory).replayId)
        val busy = card(victory, busy = true)
        assertTrue("Nothing may be sent twice", listOfNotNull(busy.retrain, busy.replay, busy.next, busy.home).all { it.state == CommandState.BUSY })
        val noRaid = card(victory, state = live(raidId = null))
        assertNull("No raid id, no replay to point at, so no silent REPLAY door", noRaid.replay)
        assertNull(noRaid.replayId)
    }

    @Test fun `retrainCount comes from the spent troops`() {
        val ui = card(victory)
        assertEquals(5, ui.retrainCount)
        assertEquals(listOf("highlander" to "3", "bowman" to "2"), ui.armySpent.map { it.troop to it.count })
        assertEquals("L3", ui.armySpent.first().level)
        assertTrue("The hero stayed in camp", ui.heroesUsed.isEmpty())
        val withHero = card(victory, state = live(commands = listOf(deploy("mage"), hero("vex"))))
        assertEquals(1, withHero.retrainCount)
        assertEquals(listOf("mage" to "1"), withHero.armySpent.map { it.troop to it.count })
        assertEquals(listOf("hero_vex_portrait"), withHero.heroesUsed)
        val none = card(victory, state = live(commands = emptyList()))
        assertNull("No badge when nothing was spent", none.retrainCount)
        assertTrue(none.armySpent.isEmpty())
    }
}
