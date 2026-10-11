package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Hero
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_SKILLS
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TierState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** Read-only skills never infer a level, tier, price, cooldown or current-base provenance. */
class HeroSkillsLiveMapperTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val vex = Hero("vex", "Vex", recruited = true, level = 8, tier = 2, maxLevel = 20)
    private val theo = Hero("theodor", "Theodor", recruited = true, level = 3, tier = 1, maxLevel = 20)
    private val catalogue = obj("""{"constants":{"HERO_SKILLS":{
        "vex":{"degenAwakening":{"unlockLevel":11,"cdSec":40},
            "crimsonDash":{"unlockLevel":1,"cdSec":12},"moonsunderWave":{"unlockLevel":6,"cdSec":16},
            "doubleOrNothing":{"unlockLevel":16,"oncePerBattle":true}},
        "theodor":{"snotRocket":{"unlockLevel":3,"cdSec":8},"cheekQuake":{"unlockLevel":1,"cdSec":10}}}}}""")
    private fun state(hero: Hero = vex, cat: JsonObject? = catalogue) = RosterUiState(
        domain = ArmyDomainState(heroes = HeroRoster(listOf(hero, theo)), heroesBaseId = "b1"),
        home = BaseState(base = BaseSnapshot.from(obj("""{"baseId":"b1","player":{"keepLevel":1}}"""))), catalogue = cat)
    private fun sheet(s: RosterUiState, hero: String = "vex") = heroesLiveUi(s, hero, HERO_TAB_SKILLS, 0L, busy = false)
    private fun mapped(s: RosterUiState = state(), hero: String = "vex") = heroSkillsLiveUi(s, hero, sheet(s, hero))
    private fun withSkills(skills: String) = obj("""{"constants":{"HERO_SKILLS":{"vex":$skills}}}""")

    @Test fun `selected hero uses its own roster and catalogue rather than default Vex`() {
        val ui = requireNotNull(mapped(hero = "theodor"))
        assertEquals("Theodor", ui.hero)
        assertEquals(3, ui.level)
        assertEquals(1, ui.tier)
        assertEquals(listOf("cheekQuake", "snotRocket"), ui.skills.map { it.id })
        assertTrue(ui.skills.all { it.unlocked })
        assertEquals(listOf("every 10s", "every 8s"), ui.skills.map { it.cooldown })
    }

    @Test fun `catalogue unlock order and current server level control ready skills and next unlock`() {
        val ui = requireNotNull(mapped())
        assertEquals(listOf("crimsonDash", "moonsunderWave", "degenAwakening", "doubleOrNothing"), ui.skills.map { it.id })
        assertEquals(listOf(true, true, false, false), ui.skills.map { it.unlocked })
        assertEquals(listOf("T2", "T2", null, null), ui.skills.map { it.tierLabel })
        assertEquals(11, ui.next?.level)
        // Rewritten with the S4 design pass (was "Degen awakening"): heroes-skills.png names the skill in title case and,
        // because Lv 11 also starts tier 3 for a tier-2 hero, says so ("Degen Awakening, all skills T3").
        assertEquals("Degen Awakening, all skills T3", ui.next?.line)
        assertEquals("ui_skill_degenmode", ui.next?.icon)
    }

    @Test fun `skills retain the exact existing blocked payment footer without adding a price`() {
        val s = state().copy(ordersAllowed = false)
        val existing = sheet(s).copy(footer = sheet(s).footer.copy(primary = liveCommand(
            ArmyLiveIds.HERO_UPGRADE, "UPGRADE", CommandState.DISABLED, "A saved hero payment is being checked.")))
        val ui = requireNotNull(heroSkillsLiveUi(s, "vex", existing))
        assertSame(existing.footer, ui.footer)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertEquals("A saved hero payment is being checked.", ui.footer.primary.reason)
        assertTrue(ui.footer.price.isEmpty())
        assertNull(ui.footer.primary.price)
    }

    @Test fun `unread roster catalogue and selected hero stay unavailable`() {
        val s = state()
        assertNull(mapped(s.copy(domain = s.domain.copy(heroes = null))))
        assertNull(mapped(state(cat = null)))
        assertNull(mapped(s, "unknownHero"))
        assertNull(mapped(state(cat = obj("""{"constants":{}}"""))))
        assertNull(mapped(state(cat = withSkills("{}"))))
    }

    @Test fun `unknown invalid and mismatched level or tier cannot become a current tier`() {
        listOf(vex.copy(level = null), vex.copy(level = 0), vex.copy(level = -1), vex.copy(level = 21),
            vex.copy(tier = null), vex.copy(tier = 0), vex.copy(tier = 5), vex.copy(tier = 1)).forEach {
            assertNull("$it must remain unavailable", mapped(state(it)))
        }
    }

    @Test fun `unrecruited heroes use the existing recruit surface without invented skill facts`() {
        val s = state(vex.copy(recruited = false, level = null, tier = null))
        val existing = sheet(s)
        assertEquals("RECRUIT", existing.footer.primary.caption)
        assertTrue(existing.recruit != null)
        assertNull(heroSkillsLiveUi(s, "vex", existing))
    }

    @Test fun `missing fractional negative zero and overflowing unlocks refuse the whole list`() {
        listOf("{}", "{\"unlockLevel\":null}", "{\"unlockLevel\":0}", "{\"unlockLevel\":-1}",
            "{\"unlockLevel\":1.9}", "{\"unlockLevel\":2147483648}", "{\"unlockLevel\":\"1.0\"}",
            "{\"unlockLevel\":true}", "[]", "null").forEach { invalid ->
            val cat = withSkills("""{"valid":{"unlockLevel":1},"unknown":$invalid}""")
            assertNull("Do not drop or fabricate $invalid", mapped(state(cat = cat)))
        }
    }

    @Test fun `unlock after the known server maximum is inconsistent rather than a next reward`() {
        assertNull(mapped(state(cat = withSkills("""{"later":{"unlockLevel":21}}"""))))
    }

    @Test fun `unknown server maximum cannot admit an unlock outside the four tier display`() {
        assertNull(mapped(state(vex.copy(maxLevel = null), withSkills("""{"later":{"unlockLevel":21}}"""))))
    }

    @Test fun `a shorter server track cannot mark unrepresented future tiers complete`() {
        val shortCatalogue = withSkills("""{"first":{"unlockLevel":1}}""")
        assertNull(mapped(state(vex.copy(level = 5, tier = 1, maxLevel = 5), shortCatalogue)))
        assertNull(mapped(state(vex.copy(maxLevel = 10), shortCatalogue)))
    }

    @Test fun `a known server maximum marks every tier complete and hides next unlock`() {
        val ui = requireNotNull(mapped(state(vex.copy(level = 20, tier = 4))))
        assertEquals(4, ui.tier)
        assertTrue(ui.tiers.all { it.state == TierState.DONE })
        assertTrue(ui.skills.all { it.unlocked })
        assertNull(ui.next)
    }

    @Test fun `missing maximum never marks the current tier complete and invalid maximum refuses mapping`() {
        val ui = requireNotNull(mapped(state(vex.copy(level = 20, tier = 4, maxLevel = null))))
        assertEquals(TierState.CURRENT, ui.tiers.last().state)
        listOf(0, -1, 7, 21).forEach { maximum -> assertNull(mapped(state(vex.copy(maxLevel = maximum)))) }
    }

    @Test fun `once per battle suppresses periodic cooldown even if both are present`() {
        val cat = withSkills("""{"once":{"unlockLevel":1,"oncePerBattle":true,"cdSec":12}}""")
        val skill = requireNotNull(mapped(state(cat = cat))).skills.single()
        assertTrue(skill.oncePerBattle)
        assertNull(skill.cooldown)
    }

    @Test fun `missing and malformed cooldowns remain absent and never use duration`() {
        listOf("null", "0", "-1", "true", "[]", "\"not-a-time\"").forEach { cd ->
            val cat = withSkills("""{"passive":{"unlockLevel":1,"cdSec":$cd,"durationSec":4}}""")
            val skill = requireNotNull(mapped(state(cat = cat))).skills.single()
            assertNull("$cd is not a cooldown", skill.cooldown)
            assertFalse(skill.oncePerBattle)
        }
        val cat = withSkills("""{"passive":{"unlockLevel":1,"durationSec":4}}""")
        assertNull(requireNotNull(mapped(state(cat = cat))).skills.single().cooldown)
    }

    @Test fun `cooldown decimal text stays exact without binary floating point`() {
        val cat = withSkills("""{"precise":{"unlockLevel":1,"cdSec":"12.50"}}""")
        assertEquals("every 12.50s", requireNotNull(mapped(state(cat = cat))).skills.single().cooldown)
    }

    @Test fun `effect details are explicitly unavailable instead of invented from preview copy`() {
        assertTrue(requireNotNull(mapped()).skills.all { it.effect == "Effect details unavailable." })
    }

    @Test fun `another base or missing base provenance cannot publish current hero facts`() {
        val s = state()
        assertNull(mapped(s.copy(domain = s.domain.copy(heroesBaseId = "b2"))))
        assertNull(mapped(s.copy(domain = s.domain.copy(heroesBaseId = null))))
        assertNull(mapped(s.copy(home = BaseState())))
    }

    @Test fun `a footer belonging to another hero is never attached to the selected hero`() {
        val s = state()
        assertNull(heroSkillsLiveUi(s, "vex", sheet(s, "theodor")))
    }

    @Test fun `retained roster while refreshing carries loading with no fabricated timestamp or animation`() {
        val s = state().let { it.copy(domain = it.domain.copy(loading = true, error = "Refresh failed")) }
        val ui = requireNotNull(mapped(s))
        assertTrue(ui.loading)
        assertNull(ui.staleSince)
        assertNull(ui.justUnlocked)
    }
}
