package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Hero
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_SKILLS
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class HeroSkillInfoLiveMapperTest {
    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject
    private fun state(raw: String = """{"unlockLevel":1,"cdSec":12,"lineDmgPctDps":[200,260,320,400],"wallMult":[3,3,4,4],"rangeTiles":[4,4,5,5]}""") = RosterUiState(
        domain = ArmyDomainState(heroes = HeroRoster(listOf(Hero("vex", "Vex", recruited = true, level = 8, tier = 2, maxLevel = 20))), heroesBaseId = "b1"),
        home = BaseState(base = BaseSnapshot.from(obj("""{"baseId":"b1","player":{"keepLevel":1}}"""))),
        catalogue = obj("""{"constants":{"HERO_SKILLS":{"vex":{"crimsonDash":$raw}}}}"""), selectedHero = "vex")
    private fun info(s: RosterUiState = state()) = heroSkillInfoLiveUi(s, "vex", heroesLiveUi(s, "vex", HERO_TAB_SKILLS, 0L, false), "crimsonDash")

    @Test fun `tier table takes exact values and current tier from the same bound hero`() {
        val value = requireNotNull(info())
        assertEquals(2, value.currentTier)
        assertEquals(1, value.unlockLevel)
        assertEquals("every 12s", value.cooldown)
        assertEquals(listOf("200", "260", "320", "400"), value.metrics.first { it.label == "Line damage (% DPS)" }.values)
        assertEquals("ui_skill_crimsondash", value.icon)
    }

    @Test fun `scalars apply to all tiers while missing malformed and negative values stay unknown`() {
        val value = requireNotNull(info(state("""{"unlockLevel":1,"rangeTiles":"6.50","wallMult":[1,null,-1,"bad"]}""")))
        assertEquals(List(4) { "6.50" }, value.metrics.first { it.label == "Range (tiles)" }.values)
        assertEquals(listOf("1", UNKNOWN, UNKNOWN, UNKNOWN), value.metrics.first { it.label == "Wall multiplier" }.values)
    }

    @Test fun `wrong tier array length is not silently rescaled or truncated`() {
        val value = requireNotNull(info(state("""{"unlockLevel":1,"rangeTiles":4,"wallMult":[1,2,3]}""")))
        assertEquals(List(4) { UNKNOWN }, value.metrics.first { it.label == "Wall multiplier" }.values)
    }

    @Test fun `unknown mechanics or preview prose cannot fabricate an effect table`() {
        assertNull(info(state("""{"unlockLevel":1,"futureRule":[1,2,3,4],"effect":"Invented preview copy"}""")))
        val s = state()
        val sheet = heroesLiveUi(s, "vex", HERO_TAB_SKILLS, 0L, false)
        assertTrue(requireNotNull(heroSkillsLiveUi(s, "vex", sheet)).skills.all { it.effect == "Effect details unavailable." })
    }

    @Test fun `base and selected hero changes retire the detail instead of retaining stale stats`() {
        val s = state()
        assertNull(info(s.copy(selectedHero = "theodor")))
        assertNull(info(s.copy(domain = s.domain.copy(heroesBaseId = "b2"))))
        assertNull(info(s.copy(home = BaseState())))
    }

    @Test fun `all thirteen known skill ids resolve only to authored atlas names`() {
        val vex = mapOf("crimsonDash" to "crimsondash", "moonsunderWave" to "moonwave", "degenAwakening" to "degenmode", "doubleOrNothing" to "doubleornothing", "omegaShardstorm" to "shardstorm")
        val theo = mapOf("cheekQuake" to "cheekquake", "snotRocket" to "snotrocket", "cannonball" to "cannonball", "skillIssue" to "skillissue", "bellyBounce" to "bellybounce", "brownNote" to "brownnote", "rageQuit" to "ragequit", "silentButDeadly" to "silentbutdeadly")
        vex.forEach { (id, icon) -> assertEquals("ui_skill_$icon", heroSkillIcon("vex", id)) }
        theo.forEach { (id, icon) -> assertEquals("ui_skill_$icon", heroSkillIcon("theodor", id)) }
        assertNull(heroSkillIcon("vex", "cheekQuake"))
        assertNull(heroSkillIcon("unknown", "crimsonDash"))
        assertNull(heroSkillIcon("vex", "futureSkill"))
    }
}
