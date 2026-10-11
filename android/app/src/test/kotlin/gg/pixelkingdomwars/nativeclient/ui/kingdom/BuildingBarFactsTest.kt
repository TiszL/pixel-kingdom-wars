package gg.pixelkingdomwars.nativeclient.ui.kingdom

import gg.pixelkingdomwars.nativeclient.BASE_ID
import gg.pixelkingdomwars.nativeclient.armyJson
import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.data.OrdinaryCraftingState
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.Inventory
import gg.pixelkingdomwars.nativeclient.model.ItemDefinition
import gg.pixelkingdomwars.nativeclient.model.ItemDiscovery
import gg.pixelkingdomwars.nativeclient.model.OwnedItem
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingFeature
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingFeatures
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingIdentity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingInput
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingJournal
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingOutput
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingPendingJob
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingRecipe
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryCraftingView
import gg.pixelkingdomwars.nativeclient.ui.army.armyPortrait
import gg.pixelkingdomwars.nativeclient.ui.model.BadgeTone
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.live.liveTroopName
import java.time.Instant
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

/**
 * The pure producers behind the bar and plate (BuildingBarFacts.kt). Each reads one owner's server state through the
 * rule that owner's own screen uses, so the bar can never disagree with the sheet it opens; and each refuses state that
 * belongs to another wallet or kingdom, because a badge borrowed from someone else's base would be a lie on Home.
 */
class BuildingBarFactsTest {
    private val now = Instant.parse("2026-10-06T00:00:00.000Z").toEpochMilli()

    // ---- Alchemy Lab research ----

    private val researchCatalogue = json("""{"constants":{"TROOP_LEVELING":{"researchTimeSec":[3600,10000]}}}""")
    private fun army(research: String = """[{"troop":"giant","toLevel":3,"finishesAt":"2026-10-06T02:10:00.000Z"}]""", base: String? = BASE_ID) =
        ArmyDomainState(army = ArmyState.from(JsonObject(armyJson() + mapOf("research" to json("""{"r":$research}""").getValue("r")))),
            armyBaseId = base)

    @Test fun `research fact reads the running research the way the Lab sheet does`() {
        // commands-2: "Giant 3 · 2h 10m", the blue meter from the pack's research time and the timer chip on RESEARCH.
        val fact = requireNotNull(researchBarFact(army(), researchCatalogue, now, BASE_ID))
        assertEquals("${liveTroopName("giant")} 3 · 2h 10m", fact.stateLine)
        assertEquals("2h 10m", fact.timer)
        assertEquals(0.22f, fact.progress!!, 0.001f)
        assertEquals(armyPortrait(researchCatalogue, "giant", null), fact.icon)
        // Without the pack's research table the meter is unknown, never a guessed fill.
        assertNull(researchBarFact(army(), null, now, BASE_ID)?.progress)
    }

    @Test fun `research fact is absent while the Lab is idle or the army read is another kingdoms`() {
        // An idle Lab shows no line; another base's research must never ride on this Lab's button.
        assertNull(researchBarFact(army(research = "[]"), researchCatalogue, now, BASE_ID))
        assertNull(researchBarFact(army(base = "00000000-0000-4000-8000-000000000009"), researchCatalogue, now, BASE_ID))
        assertNull(researchBarFact(ArmyDomainState(), researchCatalogue, now))
    }

    // ---- Hero GEAR NEW ----

    @Test fun `gear NEW follows the gear sheet rule of owned and not yet seen`() {
        // GearLiveMapper.hasNew: only gear the deed owns and has never looked at earns the gold NEW.
        val helm = ItemDefinition("helm_1", kind = "gear")
        assertTrue(gearNewFact(Inventory(catalog = listOf(helm), owned = listOf(OwnedItem("helm_1", "1")))))
        assertFalse(gearNewFact(Inventory(catalog = listOf(helm), owned = listOf(OwnedItem("helm_1", "1")),
            discovery = listOf(ItemDiscovery("helm_1")))))
        assertFalse(gearNewFact(Inventory(catalog = listOf(helm))))
        assertFalse(gearNewFact(Inventory(catalog = listOf(ItemDefinition("keg", kind = "consumable")), owned = listOf(OwnedItem("keg", "2")))))
        assertFalse(gearNewFact(null))
    }

    // ---- Workshop refining ----

    private val wallet = "11111111111111111111111111111112"
    private val base = "00000000-0000-4000-8000-000000000001"
    private val serverNow = "2026-10-06T00:00:00.000Z"
    private val recipe = OrdinaryCraftingRecipe(1, "refine_frostglass", 1, 42, listOf(OrdinaryCraftingInput("raw", "frost_quartz", "13")),
        OrdinaryCraftingOutput("frostglass", "3"))
    private fun crafting(viewWallet: String = wallet, viewBase: String = base, jobs: Int = 2, busy: Boolean = false) = OrdinaryCraftingState(
        OrdinaryCraftingJournal(1, OrdinaryCraftingIdentity("https://example.invalid", "devnet", wallet), 0, null, emptyList()),
        OrdinaryCraftingView(viewWallet, viewBase, OrdinaryCraftingFeatures(OrdinaryCraftingFeature(1, 1)), true, 1, 7, listOf(recipe),
            emptyList(), emptyList(), (1..jobs).map { i ->
                OrdinaryCraftingPendingJob("00000000-0000-4000-8000-00000000000$i", recipe, serverNow,
                    Instant.parse(serverNow).plusSeconds(42L * i).toString())
            }, serverNow), busy = busy, advertised = true)

    @Test fun `workshop fact counts this kingdoms refining jobs and times the soonest one`() {
        // commands-4: red count = jobs running, "Refining · 42s" to the first batch out.
        val fact = requireNotNull(workshopBarFact(crafting(), base, now))
        assertEquals("Refining · 42s", fact.stateLine)
        assertEquals("2", fact.badge?.text)
        assertEquals(BadgeTone.COUNT, fact.badge?.tone)
        assertNull(workshopBarFact(crafting(jobs = 0), base, now))
    }

    @Test fun `workshop fact refuses a view of another wallet or another kingdom`() {
        // A foreign view would put someone else's jobs on this Workshop's CRAFT button.
        assertNull(workshopBarFact(crafting(viewWallet = "11111111111111111111111111111113"), base, now))
        assertNull(workshopBarFact(crafting(viewBase = "00000000-0000-4000-8000-000000000002"), base, now))
        assertNull(workshopBarFact(crafting(), null, now))
        assertNull(workshopBarFact(null, base, now))
    }

    @Test fun `workshop timer never shows more than the server said and keeps its line while a command runs`() {
        // A phone clock running behind is floored at serverNow; one running ahead counts down from it.
        assertEquals("Refining · 42s", workshopBarFact(crafting(), base, now - 60_000)?.stateLine)
        assertEquals("Refining · 32s", workshopBarFact(crafting(), base, now + 10_000)?.stateLine)
        // A routine refresh must not blank a line that was already shown (the repository clears its own view on re-read).
        assertEquals("Refining · 42s", workshopBarFact(crafting(busy = true), base, now)?.stateLine)
    }

    // ---- KingdomUiState plate lines ----

    private fun kingdom(keep: Int = 2, buildings: String = "[]", extra: String = "", catalogue: JsonObject? = null) = KingdomUiState(
        home = BaseState(base = BaseSnapshot.from(json("""{"baseId":"$BASE_ID","player":{"keepLevel":$keep},"buildings":$buildings$extra}"""))),
        catalogue = catalogue)

    @Test fun `Keep line names the nearest catalogue unlock above the Keep`() {
        // commands-1 "Next: Lv 11 opens the Market": the smallest requiresKeepLevel above today's Keep, from BUILD_COSTS.
        val costs = json("""{"constants":{"BUILD_COSTS":{"vault":{"costShards":"50","requiresKeepLevel":1},
            "barracks":{"costShards":"100","requiresKeepLevel":3},"cannon":{"costShards":"300","requiresKeepLevel":4}}}}""")
        assertEquals("Next: Lv 3 opens the Barracks", keepBarFact(kingdom(keep = 2, catalogue = costs))?.stateLine)
        assertEquals("Next: Lv 4 opens the Cannon", keepBarFact(kingdom(keep = 3, catalogue = costs))?.stateLine)
        assertNull(keepBarFact(kingdom(keep = 4, catalogue = costs)))
        assertNull(keepBarFact(kingdom(keep = 2)))
    }

    @Test fun `defence line states damage and range from levelStats`() {
        // commands-3 "Damage 38 · range 10": the same table the INFO sheet's stat rows read.
        val defences = json("""{"constants":{"DEFENSES":{"archertower":{"hp":400,"dps":38,"rangeTiles":10}},
            "DEFENSE_LEVELING":{"statMultPerLevel":1,"maxLevel":10}}}""")
        assertEquals("Damage 38 · range 10", defenceBarFact(defences, "archertower", 5)?.stateLine)
        assertNull(defenceBarFact(defences, "vault", 5))
    }

    @Test fun `hero line says ready or recovering from the base read and nothing when unknown`() {
        // commands-2 "Vex · ready to fight" or the recovery timer; a missing hero row is not invented as ready.
        val ready = kingdom(extra = ""","heroes":[{"hero":"vex","available":true}]""")
        assertEquals("Vex · ready to fight", heroBarFact(ready, "heroaltar", now)?.stateLine)
        val resting = kingdom(extra = ""","heroes":[{"hero":"vex","available":false,"recoveryUntil":"2026-10-06T00:30:00.000Z"}]""")
        assertEquals("Recovering · 30m", heroBarFact(resting, "heroaltar", now)?.stateLine)
        assertNull(heroBarFact(kingdom(), "heroaltar", now))
        assertNull(heroBarFact(ready, "siegestool", now))
    }

    @Test fun `camp and mine lines stay absent rather than read zero when the server has not said`() {
        // DESIGN-SYSTEM §9: unknown is the ellipsis or nothing, never 0.
        assertNull(campBarFact(kingdom()))
        assertNull(campBarFact(kingdom(extra = ""","armyStatus":{"readyPts":10}""")))
        assertNull(mineBarFact(kingdom()))
    }

    @Test fun `wall line counts the walls the base owns`() {
        // commands-3 "132 owned": a count of this base's wall pieces, nothing estimated.
        val walls = """[{"id":"w1","type":"wall","level":1,"tx":0,"ty":0},{"id":"w2","type":"wall","level":1,"tx":1,"ty":0},
            {"id":"k","type":"keep","level":1,"tx":5,"ty":5}]"""
        assertEquals("2 owned", wallBarFact(kingdom(buildings = walls))?.stateLine)
    }
}
