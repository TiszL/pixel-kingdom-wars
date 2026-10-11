package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ClockPhase
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Frame 26: display projections preserve the existing raid owner. the content pipeline executes these tests. */
class BattleHudLiveMapperTest {
    private fun live() = LiveBattleState(phase = BattlePhase.STAGING, connected = true,
        pending = PendingBattle("wallet", "base", "raid", target = PendingRaidTarget(name = "Ironjaw")),
        presentation = Json.parseToJsonElement("""{"armySnapshot":{"counts":{"archer":2,"giant":1},"heroes":["vex"]}}""").jsonObject)
    private fun hud(state: LiveBattleState = live(), allowed: Boolean = true, selection: Pair<String, String>? = null,
        timer: String = "DEPLOY", duration: Long? = null, playhead: Double = 0.0) = liveBattleHudUi(state, null,
        selection, allowed, playhead, duration, timer, null, null, "", "END", true)

    @Test fun `target identity is real while absent level crest loot and progress stay unknown`() {
        val ui = hud()
        assertEquals("Ironjaw", ui.targetName)
        assertEquals("Lv …", ui.targetLevel)
        assertEquals("shape:unknown", ui.leagueCrest)
        assertNull(ui.lootLeft)
        assertNull(ui.stars)
        assertNull(ui.destructionPct)
        assertNull(ui.clock)
    }
    @Test fun `campaign identity never reuses a stale target name`() {
        val state = live().let { it.copy(pending = it.pending!!.copy(stage = 4)) }
        assertEquals("STAGE 4", hud(state).targetName)
    }
    @Test fun `staging countdown comes from existing server deadline formatter only`() {
        assertEquals("0:23", hud(timer = "0:23").clock)
        assertEquals(ClockPhase.SCOUT, hud(timer = "0:23").clockPhase)
        assertNull(hud(timer = "DEPLOY").clock)
    }
    @Test fun `running countdown subtracts canonical playhead and warns only below thirty seconds`() {
        val state = live().copy(phase = BattlePhase.RUNNING)
        assertEquals("0:30", hud(state, duration = 90000, playhead = 60000.0).clock)
        assertEquals(ClockPhase.FIGHT, hud(state, duration = 90000, playhead = 60000.0).clockPhase)
        assertEquals(ClockPhase.LAST_30, hud(state, duration = 90000, playhead = 61000.0).clockPhase)
        assertEquals("0:00", hud(state, duration = 90000, playhead = 100000.0).clock)
        assertNull(hud(state, duration = null).clock)
    }
    @Test fun `depleted troops stay in frozen roster order and exact typed ids resolve`() {
        val state = live().copy(commands = List(2) { buildJsonObject {
            put("kind", "deploy"); put("payload", buildJsonObject { put("troop", "archer") })
        } })
        val cards = hud(state).deck
        assertEquals(listOf("deploy:archer", "deploy:giant", "hero:vex"), cards.map { it.id })
        assertEquals(0, cards.first().count)
        assertFalse(cards.first().enabled)
        assertEquals("deploy" to "giant", liveBattleHudSelection(state, "deploy:giant"))
        assertNull(liveBattleHudSelection(state, "hero:giant"))
        assertNull(liveBattleHudSelection(state, "deploy:missing"))
    }
    @Test fun `sent hero is retained and disabled without inventing an ability`() {
        val state = live().copy(commands = listOf(buildJsonObject {
            put("kind", "hero"); put("payload", buildJsonObject { put("hero", "vex") })
        }))
        val hero = hud(state).deck.last()
        assertTrue(hero.isHero)
        assertTrue(hero.heroSent)
        assertEquals("SENT", hero.statusText)
        assertFalse(hero.enabled)
        assertFalse(hero.abilitySupported)
    }
    // Added with the designed END confirm (S2): a sent hero's card has no ability owner, so its tap must say so
    // (a door never does nothing) while every card that can still act carries no refusal at all.
    @Test fun `sent hero card explains that abilities are not open while live cards stay without a refusal`() {
        val sent = live().copy(commands = listOf(buildJsonObject {
            put("kind", "hero"); put("payload", buildJsonObject { put("hero", "vex") })
        }))
        assertEquals("Hero abilities are not open yet.", hud(sent).deck.last().refusal)
        assertNull("An unsent hero is still a selectable card", hud().deck.last().refusal)
        assertTrue(hud(sent).deck.filterNot { it.isHero }.all { it.refusal == null })
    }
    // The pending target carries a name only; a named PvP target must still not invent a level, crest or loot line.
    @Test fun `named pvp target keeps unknown level crest and no loot line`() {
        val state = live().let { it.copy(pending = it.pending!!.copy(target = PendingRaidTarget(defenderBaseId = "deed-1", name = "Ironjaw"))) }
        val ui = hud(state)
        assertEquals("Ironjaw", ui.targetName)
        assertEquals("Lv …", ui.targetLevel)
        assertEquals("shape:unknown", ui.leagueCrest)
        assertNull(ui.lootLeft)
    }
    @Test fun `admission or connection refusal leaves cards readable and disabled`() {
        assertTrue(hud(allowed = false).deck.none { it.enabled })
        assertTrue(hud(live().copy(connected = false)).deck.none { it.enabled })
        assertTrue(hud(live().copy(blocked = true)).deck.none { it.enabled })
    }
    @Test fun `end always uses existing confirmation owner and does not promise a free leave`() {
        val ui = hud(selection = "deploy" to "giant")
        assertFalse(ui.canLeaveFree)
        assertFalse(ui.endConfirmShown)
        assertEquals("END", ui.endText)
        assertEquals("deploy:giant", ui.selected)
        assertFalse(ui.showDeployLine)
        assertFalse(ui.showHint)
    }
}
