package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Hero
import gg.pixelkingdomwars.nativeclient.model.HeroLoadout
import gg.pixelkingdomwars.nativeclient.model.HeroNext
import gg.pixelkingdomwars.nativeclient.model.HeroRecoveryFinish
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.model.Inventory
import gg.pixelkingdomwars.nativeclient.model.ItemDefinition
import gg.pixelkingdomwars.nativeclient.model.OwnedItem
import gg.pixelkingdomwars.nativeclient.model.SetBonus
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.Currency
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.model.PriceUi
import gg.pixelkingdomwars.nativeclient.ui.roster.RosterUiState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_HERO
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HERO_TAB_SKILLS
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TapRoute
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TierState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.commandTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.effectiveState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.healthLabel
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.heroTier
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.nextSkillLine
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.researchTap
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.skillLevelText
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The S4 detail pass of the Alchemy Lab and Hero Altar sheets (design/final/army research.png, research-busy.png,
 * heroes.png, heroes-theodor.png, heroes-skills.png, heroes-gear.png; SPEC §4, §5, E1.1-E1.2). Each case pins a rule a
 * frame depends on: no card starts research while the Lab works, a money tap never claims a currency before the server
 * review, and every level, tier and price on these sheets comes from the server or the catalogue. */
class ResearchHeroesDesignDetailsTest {
    private val now = Instant.parse("2030-01-01T00:00:00Z").toEpochMilli()

    // ---- Alchemy Lab ----

    private val labCatalogue = json("""{"constants":{
        "TROOPS":{"highlander":{"pts":2,"hp":100,"dps":10},"bowman":{"pts":1,"hp":40,"dps":12},"mage":{"pts":2,"hp":60,"dps":20}},
        "TROOP_LEVELING":{"statMultPerLevel":1.5,"maxLevel":3,"researchCostKeep":[100,200,300],"researchTimeSec":[60,120,180]}},
        "display":{"research":{"troops":["highlander","bowman","mage"],"darkTroops":[],"eliteItems":{}}}}""")
    private val running = """[{"troop":"highlander","toLevel":2,"finishesAt":"2030-01-01T00:00:30Z","episodeId":"e1","finishQuote":{"maxCostKeep":"5"}}]"""

    private fun lab(forge: Int = 2, research: String = "[]", jobs: String = "[]", catalogue: JsonObject? = labCatalogue) = ArmyUiState(
        domain = ArmyDomainState(army = ArmyState.from(json("""{"levels":{"highlander":1,"bowman":3,"mage":1},"research":$research,
            "features":{"researchConsent":{"version":1},"researchSpeedupReceipts":{"version":1}}}""")), armyBaseId = "b1", armyBaseGeneration = 0L),
        home = BaseState(base = BaseSnapshot.from(json("""{"baseId":"b1","player":{"keepLevel":5},
            "buildings":[{"id":"lab","type":"forge","level":$forge,"tx":0,"ty":0}],"jobs":$jobs}""")), balances = Balances("1000", "0")),
        wallet = "w1", baseId = "b1", catalogue = catalogue)

    @Test fun `a busy Lab maps every card to IN_LAB or BUSY and FINISH carries the review-priced line`() {
        // research-busy.png: the Lab works on one troop at a time, so no card may select or start while it runs; the paid
        // FINISH must not claim Gems or KEEP before the existing server review (A5), so it says where the price is shown.
        val ui = researchLiveUi(lab(research = running), 0L, now, "mage", busy = false, actionsAllowed = true)
        assertEquals(ResearchCardState.IN_LAB, ui.cards.first { it.troop == "highlander" }.state)
        assertTrue(ui.cards.filter { it.troop != "highlander" }.all { it.state == ResearchCardState.BUSY })
        assertTrue("Every tap only explains", ui.cards.all { researchTap(it.state, labBusy = true) == ResearchTap.BUSY })
        assertNull("A remembered pick is not shown while the Lab works", ui.selected)
        assertEquals("Price shown in review", ui.footer.primary.sub)
        assertNull(ui.footer.primary.price)
        assertEquals(TapRoute.RUN, commandTap(ui.footer.primary))
        assertEquals(listOf("Skip the wait,", "or let it finish."), ui.footer.info)
    }

    @Test fun `under a busy Lab a card keeps its look with a plain catalogue price and never a guessed shortfall`() {
        // The server verdict says "Forge is researching" before it checks the Shards, so affordability is unknown: the
        // dimmed grid reads the catalogue price plainly (never red) and a maxed troop still reads Max level.
        val ui = researchLiveUi(lab(research = running), 0L, now, null, busy = false, actionsAllowed = true)
        val mage = ui.cards.first { it.troop == "mage" }
        assertEquals(ResearchCardState.DEFAULT, mage.busyLook)
        assertEquals("100", mage.nextPrice?.amount)
        assertEquals(PriceStatus.OK, mage.nextPrice?.status)
        assertEquals(ResearchCardState.MAX, ui.cards.first { it.troop == "bowman" }.busyLook)
        assertNull("The card in the Lab draws its own state", ui.cards.first { it.troop == "highlander" }.busyLook)
    }

    @Test fun `a lab-cap card carries the Lab level it needs so its tap can name the upgrade`() {
        // research.png "Lab cap": troops max out at the Lab's level; the card says which Lab level opens the next one,
        // from the same server rule (completed Forge level = the target), never a number of its own.
        val ui = researchLiveUi(lab(forge = 1), 0L, now, null, busy = false, actionsAllowed = true)
        val highlander = ui.cards.first { it.troop == "highlander" }
        assertEquals(ResearchCardState.LAB_CAP, highlander.state)
        assertEquals("Upgrade the Alchemy Lab to Lv 2", highlander.reason)
        assertEquals(ResearchTap.LAB_CAP, researchTap(highlander.state, labBusy = false))
        val open = researchLiveUi(lab(), 0L, now, null, busy = false, actionsAllowed = true).cards.first { it.troop == "highlander" }
        assertEquals("The first affordable card is the default selection", ResearchCardState.SELECTED, open.state)
        assertNull("A card that selects explains nothing", open.reason)
    }

    @Test fun `while the Lab itself upgrades the panel pauses and RESEARCH is locked with its time`() {
        // SPEC §4 "Lab upgrading": the server already treats an upgrading Lab as absent (every card a cap), so the sheet
        // says why with the L state instead of "Lab is free" and nine identical "Lab cap" cards.
        val jobs = """[{"id":"j1","kind":"build","buildingId":"lab","finishesAt":"2030-01-01T01:00:00Z"}]"""
        val ui = researchLiveUi(lab(jobs = jobs), 0L, now, null, busy = false, actionsAllowed = true)
        assertTrue(ui.paused)
        assertEquals(CommandState.LOCKED, ui.footer.primary.state)
        assertEquals("Lab is upgrading · 1h", ui.footer.primary.reason)
        assertEquals(TapRoute.EXPLAIN, commandTap(ui.footer.primary))
        assertEquals("Lab is upgrading", ui.header.chip?.text)
        assertEquals("Lab is upgrading · 1h", ui.cards.first { it.troop == "highlander" }.reason)
        assertFalse(researchLiveUi(lab(), 0L, now, null, busy = false, actionsAllowed = true).paused)
    }

    @Test fun `a read kingdom without a verified catalogue shows the existing copy with REFRESH instead of endless skeletons`() {
        val ui = researchLiveUi(lab(catalogue = null), 0L, now, null, busy = false, actionsAllowed = true)
        assertFalse(ui.loading)
        assertEquals("Research controls need the latest verified game catalogue.", ui.catalogueMissing?.reason)
        assertEquals("REFRESH", ui.catalogueMissing?.goLabel)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertTrue("Nothing read yet is still loading", researchLiveUi(ArmyUiState(), 0L, now, null, busy = false, actionsAllowed = true).loading)
    }

    // ---- Hero Altar ----

    private val consent = json("""{"heroConsent":{"version":1}}""")
    private val skillsCatalogue = json("""{"constants":{"HERO_SKILLS":{"vex":{
        "crimsonDash":{"unlockLevel":1,"cdSec":12},"moonsunderWave":{"unlockLevel":6,"cdSec":16},
        "degenAwakening":{"unlockLevel":11,"cdSec":40},"doubleOrNothing":{"unlockLevel":16,"oncePerBattle":true}}}}}""")
    private val theodorUnrecruited = Hero("theodor", "Theodor", recruited = false)
    private fun vexAt(level: Int) = Hero("vex", "Vex", recruited = true, level = level, tier = heroTier(level), maxLevel = 20)
    private fun altar(vex: Hero, buildings: String = "[]", heroesBase: String = "b1", theodor: Hero = theodorUnrecruited) = RosterUiState(
        domain = ArmyDomainState(heroes = HeroRoster(listOf(vex, theodor), features = consent), heroesBaseId = heroesBase),
        home = BaseState(base = BaseSnapshot.from(json("""{"baseId":"b1","player":{"keepLevel":1},"buildings":$buildings}"""))),
        catalogue = skillsCatalogue)
    private fun skills(s: RosterUiState) = requireNotNull(heroSkillsLiveUi(s, "vex", heroesLiveUi(s, "vex", HERO_TAB_SKILLS, now, busy = false)))

    @Test fun `the tier track marks done current and future from the hero's own level`() {
        // heroes-skills.png: every skill grows by tier with the hero's level (T1 Lv 1-5 … T4 Lv 16-20); a cell is only ever
        // reached by that level, never by a guessed or default one.
        assertEquals(listOf(TierState.DONE, TierState.CURRENT, TierState.FUTURE, TierState.FUTURE), skills(altar(vexAt(8))).tiers.map { it.state })
        assertEquals(listOf(TierState.DONE, TierState.DONE, TierState.CURRENT, TierState.FUTURE), skills(altar(vexAt(11))).tiers.map { it.state })
        assertEquals(listOf("Lv 1-5", "Lv 6-10", "Lv 11-15", "Lv 16-20"), skills(altar(vexAt(8))).tiers.map { it.levels })
        assertEquals(heroTier(8), skills(altar(vexAt(8))).tier)
        assertEquals("The next unlock that starts a tier says so", "Degen Awakening, all skills T3", skills(altar(vexAt(8))).next?.line)
        val midTier = altar(vexAt(7)).copy(catalogue = json("""{"constants":{"HERO_SKILLS":{"vex":{
            "crimsonDash":{"unlockLevel":1},"doubleOrNothing":{"unlockLevel":9}}}}}"""))
        assertEquals("An unlock inside the current tier names only the skill", "Double or Nothing", skills(midTier).next?.line)
    }

    @Test fun `a locked skill keeps its unlock level on the SKILLS row the HERO strip and the next-skill row`() {
        // A locked skill must still say when it opens (heroes.png "Lv 11", heroes-skills.png "LV 11"): the level is the
        // catalogue's, and an unknown one reads "…", never "Lv 0".
        val s = altar(vexAt(8))
        val row = skills(s).skills.first { it.id == "degenAwakening" }
        assertFalse(row.unlocked)
        assertEquals(11, row.unlockLevel)
        assertNull("A locked row has no tier tag", row.tierLabel)
        val hero = heroesLiveUi(s, "vex", HERO_TAB_HERO, now, busy = false)
        val tile = hero.skills.first { it.id == "degenAwakening" }
        assertFalse(tile.unlocked)
        assertEquals(11, tile.unlockLevel)
        assertEquals("Degen Awakening · 3 levels to go", nextSkillLine(hero.nextSkill, hero.level, hero.maxLevel))
        assertEquals("The next-skill row draws the authored icon", "ui_skill_degenmode", hero.nextSkill?.icon)
        assertTrue("Once a battle comes from the catalogue", hero.skills.first { it.id == "doubleOrNothing" }.oncePerBattle)
        assertEquals(UNKNOWN, skillLevelText(0))
        assertEquals("11", skillLevelText(11))
    }

    @Test fun `skill names read as the hero frames write them`() {
        assertEquals("Degen Awakening", heroSkillName("DEGEN AWAKENING"))
        assertEquals("Silent but Deadly", heroSkillName("SILENT BUT DEADLY"))
        assertEquals("Cannonball", heroSkillName("CANNONBALL"))
    }

    @Test fun `the FINISH rest price CHECKING stays enabled navigation into the Seal`() {
        // heroes-theodor.png correction 7: CHECKING "…" is navigation into the Seal (which quotes), UNAVAILABLE explains and
        // SHORT opens Need-more. A FINISH that did nothing on tap would strand a resting hero with no way forward.
        val resting = vexAt(8).copy(available = false, recoveryUntil = "2030-01-01T01:20:00Z", recoveryFinishNow = HeroRecoveryFinish(4800, "18"))
        val ui = heroesLiveUi(altar(resting), "vex", HERO_TAB_HERO, now, busy = false)
        val finish = requireNotNull(ui.finishRest)
        assertNull("The review, not the sheet, names the currency", finish.price)
        assertEquals("Price shown in review", finish.sub)
        assertEquals(TapRoute.RUN, commandTap(finish))
        val checking = finish.copy(price = reviewedFinishPrice())
        assertEquals(PriceStatus.CHECKING, checking.price?.status)
        assertEquals(CommandState.ENABLED, effectiveState(checking))
        assertEquals(TapRoute.RUN, commandTap(checking))
        assertEquals(TapRoute.EXPLAIN, commandTap(finish.copy(price = PriceUi(Currency.GEMS, null, PriceStatus.UNAVAILABLE))))
        assertEquals(TapRoute.NEED_MORE, commandTap(finish.copy(price = PriceUi(Currency.GEMS, "18", PriceStatus.SHORT))))
        assertEquals("The rest time is the server's", "back in 1h 20m", healthLabel(ui.health.fraction, ui.health.remainingSec))
        assertEquals("1h 20m", ui.header.chip?.emphasis)
    }

    @Test fun `UPGRADE names where its price is shown because a bought level has no duration of its own`() {
        val vex = vexAt(8).copy(next = HeroNext(9, costKeep = "500"))
        val footer = heroesLiveUi(altar(vex), "vex", HERO_TAB_HERO, now, busy = false).footer
        assertEquals(listOf("Price shown in review"), footer.info)
        assertTrue(footer.price.isEmpty())
        assertNull(footer.primary.price)
        assertEquals("Vex to Lv 9", footer.primary.sub)
        assertEquals(CommandState.ENABLED, footer.primary.state)
    }

    @Test fun `the hero switch keeps a padlock while the other building is unbuilt and hides once it is built but unrecruited`() {
        // E1.2: "stool not built" keeps the switch with a padlock (its tap opens Theodor's recruit state, which says where
        // to build); SPEC §5 hides it for a built but unrecruited hero. Only the roster's own kingdom can say "not built".
        val unbuilt = requireNotNull(heroesLiveUi(altar(vexAt(8)), "vex", HERO_TAB_HERO, now, busy = false).header.switchTo)
        assertEquals("theodor", unbuilt.hero)
        assertTrue(unbuilt.locked)
        val built = altar(vexAt(8), buildings = """[{"id":"s1","type":"siegestool","level":1,"tx":0,"ty":0}]""")
        assertNull(heroesLiveUi(built, "vex", HERO_TAB_HERO, now, busy = false).header.switchTo)
        assertNull(heroesLiveUi(altar(vexAt(8), heroesBase = "b2"), "vex", HERO_TAB_HERO, now, busy = false).header.switchTo)
        val recruited = altar(vexAt(8), theodor = Hero("theodor", "Theodor", recruited = true, level = 4))
        assertFalse(requireNotNull(heroesLiveUi(recruited, "vex", HERO_TAB_HERO, now, busy = false).header.switchTo).locked)
    }

    @Test fun `the role line stays empty because the catalogue has no role copy`() {
        // heroes-theodor.png shows a role line; the catalogue's hero title is an epithet, not that line, and the line is
        // never paraphrased from combat numbers.
        val s = altar(vexAt(8).copy(title = "The Shardborn"))
        assertNull(heroTabExtrasLive(s, "vex").roleLine)
    }

    @Test fun `EQUIP says what it does to the selected slot and the HERO gear row drops the hero's name`() {
        // heroes-gear.png footer "Fills the empty / Cloak slot." (SPEC §5 "Old cloak goes back to your bag."); heroes.png
        // gear row "Wear 9 to awaken", the paper doll "Wear 9 to awaken Vex". Both thresholds are the server loadout's.
        val rare = ItemDefinition("rare", "Rare cloak", "gear", "cloak", asset = "itm_cloak")
        val old = ItemDefinition("old", "Old cloak", "gear", "cloak", asset = "itm_cloak")
        fun state(equipment: Map<String, String>) = RosterUiState(domain = ArmyDomainState(inventory = Inventory(catalog = listOf(rare, old),
            owned = listOf(OwnedItem("rare", "1"), OwnedItem("old", "1")),
            heroLoadouts = listOf(HeroLoadout("vex", recruited = true, version = 3, equipment = equipment, setBonus = SetBonus(pieces = 1, required = 9))))),
            catalogue = json("""{"constants":{"GEAR_SLOTS":["cloak"]}}"""), selectedHero = "vex", selectedItemId = "rare")
        val empty = gearLiveProjection(state(emptyMap()), "vex", "cloak", busy = false)
        assertEquals(listOf("Fills the empty", "Cloak slot."), empty.footer.info)
        assertEquals("Wear 9 to awaken", empty.gear.awakenSummary)
        assertEquals("Wear 9 to awaken Vex", empty.gear.awakenLine)
        val replacing = gearLiveProjection(state(mapOf("cloak" to "old")), "vex", "cloak", busy = false)
        assertEquals(listOf("Old cloak goes back", "to your bag."), replacing.footer.info)
        assertEquals("EQUIP", replacing.footer.primary.caption)
    }
}
