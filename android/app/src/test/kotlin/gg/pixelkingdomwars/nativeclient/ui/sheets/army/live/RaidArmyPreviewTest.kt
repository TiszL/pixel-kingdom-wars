package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.BattleDomainState
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Hero
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.RAID_TAB_MATCH
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class RaidArmyPreviewTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val catalogue = obj("""{"constants":{"ART_V2":{"troops":["highlander","bowman","mage"],"levelsPerTier":5,"tiers":4},
        "TROOPS":{"highlander":{"pts":2},"bowman":{"pts":1},"mage":{"pts":3}}},
        "display":{"research":{"troops":["highlander","bowman","mage"]}}}""")
    private val home = BaseState(base = BaseSnapshot.from(obj("""{"baseId":"base","player":{"keepLevel":5},
        "energy":{"used":2,"free":3,"max":5},"armyStatus":{"readyTroopCount":4,"readyPts":7,"campCapacityPts":40}}""")))
    private fun state(counts: String = """{"highlander":3,"bowman":1,"mage":0}""", heroes: List<Hero> = emptyList()) = ArmyUiState(
        baseId = "base", wallet = "wallet", home = home.copy(base = BaseSnapshot.from(JsonObject(requireNotNull(home.base).raw +
            ("heroes" to buildJsonArray { heroes.forEach { hero -> add(buildJsonObject {
                put("hero", hero.hero); put("available", hero.available); hero.level?.let { put("level", it) }
            }) } })))), catalogue = catalogue,
        domain = ArmyDomainState(army = ArmyState.from(obj("""{"counts":$counts,"levels":{"highlander":6,"bowman":1,"mage":11},
            "rosterPts":7,"campCapacityPts":40}""")), armyBaseId = "base", armyBaseGeneration = 4,
            heroes = HeroRoster(heroes), heroesBaseId = "base"))

    @Test fun `preview uses current positive troop counts and catalogue portraits`() {
        val preview = requireNotNull(raidArmyPreview(state(), "base", 4))
        assertEquals(listOf("ui_portrait_highlander_t2", "ui_portrait_bowman_t1"), preview.army.preview)
        assertEquals(7, preview.army.ready)
        assertEquals(40, preview.army.capacity)
        assertFalse(preview.army.empty)
        assertTrue(preview.walkers.none { it.sprite.name.contains("mage") || it.sprite.name.contains("hero_") })
    }

    @Test fun `only recruited available current-base heroes enter the raid preview`() {
        val heroes = listOf(Hero("vex", "Vex", recruited = true, available = true, level = 16),
            Hero("theodor", "Theodor", recruited = true, available = false, level = 4),
            Hero("unrecruited", "Unknown", recruited = false, available = true))
        val current = state(heroes = heroes)
        val preview = requireNotNull(raidArmyPreview(current, "base", 4))
        assertEquals(listOf("hero_vex_portrait_t4"), preview.army.heroesReady)
        assertEquals(listOf("hero_vex_portrait_t4"), preview.walkers.map { it.sprite.name }.filter { it.startsWith("hero_") })
        val wrongRoster = current.copy(domain = current.domain.copy(heroesBaseId = "other"))
        assertTrue(requireNotNull(raidArmyPreview(wrongRoster, "base", 4)).army.heroesReady.isEmpty())
    }

    @Test fun `base and generation changes discard the preview including A to B to A`() {
        assertNull(raidArmyPreview(state(), "other", 4))
        assertNull(raidArmyPreview(state(), "base", 5))
        assertNull(raidArmyPreview(state().copy(baseId = null), "base", 4))
        assertNull(raidArmyPreview(state(), null, 4))
        assertNull(raidArmyPreview(state(), "base", null))
    }

    @Test fun `unread and truly empty armies never paint the sample marching troops`() {
        val empty = requireNotNull(raidArmyPreview(state("{}"), "base", 4))
        assertTrue(empty.army.empty)
        assertTrue(empty.walkers.isEmpty())
        val ui = raidLiveUi(RAID_TAB_MATCH, BattleDomainState(), home, "base", true, false, null, 0, null, false, true)
        assertTrue(ui.header.art.walkers.isEmpty())
        assertTrue(ui.army.preview.isEmpty())
    }

    @Test fun `live chooser uses supplied army and does not invent an energy refill timestamp`() {
        val ui = raidLiveUi(RAID_TAB_MATCH, BattleDomainState(), home, "base", true, false, null, 0, null, false, true,
            armyState = state(), baseGeneration = 4)
        assertEquals(listOf("ui_portrait_highlander_t2", "ui_portrait_bowman_t1"), ui.army.preview)
        assertEquals(3, ui.energy.now)
        assertNull(ui.energy.nextInSec)
        assertTrue(ui.header.art.walkers.isNotEmpty())
    }

    @Test fun `omitted roster fields stay unknown rather than proving an empty camp`() {
        val source = state()
        val sparse = source.copy(domain = source.domain.copy(army = ArmyState.from(obj("{}"))))
        val preview = requireNotNull(raidArmyPreview(sparse, "base", 4))
        assertNull(preview.army.ready)
        assertNull(preview.army.capacity)
        assertFalse(preview.army.empty)
        assertTrue(preview.walkers.isEmpty())
    }

    @Test fun `a ready hero keeps its army door even when no ordinary troops are ready`() {
        val current = state("{}", listOf(Hero("vex", "Vex", recruited = true, available = true, level = 1)))
        val preview = requireNotNull(raidArmyPreview(current, "base", 4))
        assertFalse(preview.army.empty)
        assertEquals(listOf("hero_vex_portrait"), preview.army.heroesReady)
    }

    @Test fun `a roster default cannot override current home hero recovery or missing readiness`() {
        val current = state(heroes = listOf(Hero("vex", "Vex", recruited = true, available = true, level = 1)))
        val missing = current.copy(home = home)
        assertTrue(requireNotNull(raidArmyPreview(missing, "base", 4)).army.heroesReady.isEmpty())
        val restingBase = BaseSnapshot.from(JsonObject(requireNotNull(home.base).raw +
            ("heroes" to obj("""{"rows":[{"hero":"vex","available":false,"level":1}]}""")["rows"]!!)))
        val resting = current.copy(home = home.copy(base = restingBase))
        assertTrue(requireNotNull(raidArmyPreview(resting, "base", 4)).army.heroesReady.isEmpty())
    }
}
