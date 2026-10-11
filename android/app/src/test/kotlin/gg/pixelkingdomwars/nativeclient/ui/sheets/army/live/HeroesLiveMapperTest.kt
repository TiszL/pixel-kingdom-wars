package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_HERO
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_SKILLS
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Upgrading a hero and finishing its rest are KEEP / Gems spends decided by the server review: the live Heroes sheet
 * never prices them itself, and every figure it draws is the server roster's. */
class HeroesLiveMapperTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2030-01-01T00:00:00Z").toEpochMilli()
    private val catalogue = obj("""{"constants":{"HERO_SKILLS":{"vex":{"shadowStep":{"unlockLevel":1},"degenAwakening":{"unlockLevel":10}}}}}""")
    private fun roster(vex: String, theodor: String = """{"hero":"theodor","name":"Theodor","recruited":false}""", consent: Int = 1) =
        HeroRoster.from(obj("""{"heroes":[$vex,$theodor],"features":{"heroConsent":{"version":$consent}}}"""))
    private val ready = """{"hero":"vex","name":"Vex","recruited":true,"level":8,"maxLevel":20,"hp":"1200","dps":"80","available":true,
        "next":{"level":9,"hp":"1300","dps":"80","costKeep":"500"}}"""
    private fun state(r: HeroRoster?) = RosterUiState(domain = ArmyDomainState(heroes = r), catalogue = catalogue)

    @Test fun `UPGRADE carries no price of its own - the existing review states the currency and amount`() {
        val ui = heroesLiveUi(state(roster(ready)), "vex", HERO_TAB_HERO, now, busy = false)
        assertEquals(CommandState.ENABLED, ui.footer.primary.state)
        assertNull(ui.footer.primary.price)
        assertTrue(ui.footer.price.isEmpty())
        assertEquals("Vex to Lv 9", ui.footer.primary.sub)
        assertTrue("A recruited hero on HERO uses the re-done tab", usesHeroTabV2(ui))
    }

    @Test fun `stats are the server's, and an unchanged next value is not drawn as a change`() {
        val ui = heroesLiveUi(state(roster(ready)), "vex", HERO_TAB_HERO, now, busy = false)
        assertEquals("1,200", ui.stats[0].now); assertEquals("1,300", ui.stats[0].next)
        assertNull(ui.stats[1].next)
        assertEquals(listOf(true, false), ui.skills.map { it.unlocked })
        assertEquals(10, ui.nextSkill?.unlockLevel)
    }

    @Test fun `a server without hero consent keeps UPGRADE off with the reason`() {
        val ui = heroesLiveUi(state(roster(ready, consent = 2)), "vex", HERO_TAB_HERO, now, busy = false)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertTrue(ui.footer.primary.reason!!.contains("server update"))
    }

    @Test fun `a resting hero shows the time back and a FINISH whose price only the review knows`() {
        val resting = """{"hero":"vex","name":"Vex","recruited":true,"level":8,"available":false,"recoveryUntil":"2030-01-01T01:00:00Z",
            "recoveryFinishNow":{"remainingSec":3600,"costKeep":"40"}}"""
        val ui = heroesLiveUi(state(roster(resting)), "vex", HERO_TAB_HERO, now, busy = false)
        assertEquals("Resting", ui.header.chip?.text)
        assertEquals("1h", ui.header.chip?.emphasis)
        assertEquals(3600L, ui.health.remainingSec)
        // Rewritten with A5 (was a CHECKING Gems pill): the FINISH tap now opens the review in place, which alone knows the currency.
        assertNull("The review, not the sheet, determines GEMS versus KEEP", ui.finishRest?.price)
        assertEquals("Price shown in review", ui.finishRest?.sub)
        assertEquals(CommandState.ENABLED, ui.finishRest?.state)
    }

    @Test fun `an unrecruited hero offers RECRUIT at its building and no switch to it`() {
        val ui = heroesLiveUi(state(roster(ready)), "theodor", HERO_TAB_HERO, now, busy = false)
        assertEquals("RECRUIT", ui.footer.primary.caption)
        assertTrue(ui.recruit?.headline!!.contains("Siege Stool"))
        assertFalse(usesHeroTabV2(ui))
        assertNull("Vex's sheet has no switch while Theodor is not recruited",
            heroesLiveUi(state(roster(ready)), "vex", HERO_TAB_SKILLS, now, busy = false).header.switchTo)
    }

    @Test fun `before the roster answers everything reads unknown and nothing can be pressed`() {
        val ui = heroesLiveUi(state(null), "vex", HERO_TAB_HERO, now, busy = false)
        assertTrue(ui.loading)
        assertEquals(UNKNOWN, ui.header.chip?.emphasis)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
    }
}
