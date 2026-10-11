package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexData
import gg.pixelkingdomwars.nativeclient.ui.roster.CodexTab
import gg.pixelkingdomwars.nativeclient.ui.kingdom.sheetBuildingInfo
import org.junit.Assert.*
import org.junit.Test

/** The Codex (web screens/codex.tsx) reads every number in its tag lines from the constants catalogue by the
 * name constants.ts exports; an entry whose constant is missing is omitted, never written from memory. */
class CodexDataTest {
    private val catalogue = json("""{"constants":{
        "TROOPS":{"highlander":{"pts":2,"costKeep":12,"trainSec":12,"hp":120,"dps":18,"speedTilesPerSec":1.2,"range":"melee"},"bowman":{"pts":1,"costKeep":10,"trainSec":9,"hp":45,"dps":14,"speedTilesPerSec":1.4,"range":3.5},
            "kegrunner":{"pts":1,"costKeep":10,"trainSec":7.5,"hp":25,"dps":45,"speedTilesPerSec":2.4,"range":"melee"},"turrider":{"pts":5,"costKeep":35,"trainSec":30,"hp":520,"dps":40,"speedTilesPerSec":0.9,"range":"melee"},"direwyvern":{"pts":25,"costKeep":190,"trainSec":90,"hp":1,"dps":1,"speedTilesPerSec":1,"range":"melee"}},
        "TROOP_LEVELING":{"statMultPerLevel":1.2,"maxLevel":20},
        "TROOP_ABILITIES":{"hexbarrow":{"brood":{"lifespanSec":12,"variants":4}}},
        "DEFENSES":{"cannon":{"rangeTiles":6,"fireIntervalSec":1.2},"archertower":{"rangeTiles":7,"fireIntervalSec":0.5},"spiketrap":{"burstDamageByTier":[250,325,425,550]},"pitfall":{"stunTicksByTier":[5,7,9,12]}},
        "BUILD_COSTS":{"spiketrap":{"costShards":30},"pitfall":{"costShards":55,"requiresKeepLevel":4},"clanhall":{"costShards":2000,"requiresKeepLevel":5}},
        "TRAP_REPAIR":{"spiketrap":{"costShardsByTier":[20,30,45,65]}},"ART_V2":{"tiers":4},"WALL_ART":{"tiers":5},
        "STRUCTURES":{"keep":{"maxLevel":20,"footprint":[2,2]},"vault":{"maxLevel":20,"footprint":[1,1]},"wall":{"maxTier":20},"camp":{"maxLevel":3,"footprint":[2,2],"capacityPts":[20,35,50]},"clanhall":{"maxLevel":5,"footprint":[2,2]}},
        "KEEP_BATTERIES":{"highRangeUnlockLevel":15,"lowRangeUnlockLevel":17},"LOOT":{"balanceLootableBps":5000,"vaultProtectionMaxBps":3000},
        "SHIELD":{"hoursOnLoss":48,"extendHours":12,"maxHours":48},
        "HERO_SKILLS":{"vex":{"moonsunderWave":{"unlockLevel":6},"crimsonDash":{"unlockLevel":1}}}}}""")

    @Test fun `troop tags spell points shards and time from the catalogue and skip troops the pack lacks`() {
        val troops = CodexData.troops(catalogue)
        assertEquals("2 PTS · 12 SHARDS · 12 SEC", troops.first { it.key == "highlander" }.tag)
        assertEquals("1 PT · 10 SHARDS · 7.5 SEC · THE WALL BREAKER", troops.first { it.key == "kegrunner" }.tag)
        assertEquals("25 PTS · 190 SHARDS · 90 SEC · FORGE WRIT", troops.first { it.key == "direwyvern" }.tag)
        assertTrue(troops.first { it.key == "direwyvern" }.who.contains("occupies 25 camp points"))
        assertEquals("SPAWN ONLY · 12 SEC LIFESPAN · 4 VARIANTS", troops.first { it.key == "barrowling" }.tag)
        assertNull("No TROOPS.tunneler in this pack: no entry", troops.firstOrNull { it.key == "tunneler" })
        assertEquals("Under a minute reads as SEC, spelled out", "5 PTS · 35 SHARDS · 30 SEC", troops.first { it.key == "turrider" }.tag)
        assertTrue(CodexData.troop(catalogue, "bowman")!!.strat!!.startsWith("Shoots from 3.5 tiles"))
        assertTrue(CodexData.troops(null).isEmpty())
    }
    @Test fun `defense and building tags derive their figures and vanish when a constant is missing`() {
        val defense = CodexData.entries(catalogue, CodexTab.DEFENSE).associateBy { it.key }
        assertEquals("RANGE 6 · 1 SHOT / 1.2 SEC", defense.getValue("cannon").tag); assertEquals("RANGE 7 · 2 SHOTS / SEC", defense.getValue("archertower").tag)
        assertEquals("30 SHARDS · ONE USE · REPAIR 20–65 SHARDS", defense.getValue("spiketrap").tag); assertTrue(defense.getValue("spiketrap").strat!!.startsWith("250–550 damage"))
        assertEquals("55 SHARDS · ONE USE · GROUND STUN · KEEP L4", defense.getValue("pitfall").tag); assertTrue(defense.getValue("pitfall").strat!!.contains("from 5 to 12 simulation ticks"))
        assertEquals("5 ART TIERS · 20 LEVELS", defense.getValue("wall").tag)
        assertNull("No DEFENSES.airdefence in this pack", defense["airdefence"]); assertNull(defense["powdermine"])
        val buildings = CodexData.entries(catalogue, CodexTab.BUILDINGS).associateBy { it.key }
        assertEquals("2×2 · L1–L20 · THE HEART", buildings.getValue("keep").tag); assertTrue(buildings.getValue("keep").strat!!.contains("At L15") && buildings.getValue("keep").strat!!.contains("at L17"))
        assertTrue(buildings.getValue("vault").strat!!.contains("up to 50%") && buildings.getValue("vault").strat!!.contains("1.5 points at L1, 30 at L20") && buildings.getValue("vault").strat!!.contains("only 20% lootable"))
        assertEquals("2×2 · L1–L3 · CAP 20–50 PTS", buildings.getValue("camp").tag); assertEquals("2×2 · L1–L5 · KEEP L5", buildings.getValue("clanhall").tag)
        assertNull("No STRUCTURES.mine", buildings["mine"])
        val items = CodexData.entries(catalogue, CodexTab.ITEMS).associateBy { it.key }
        assertEquals("2D AFTER A LOSS", items.getValue("shield").tag); assertTrue(items.getValue("shield").who.contains("Extend +12H with SOL (max 2D)"))
        assertNull(CodexData.entries(json("""{"constants":{}}"""), CodexTab.ITEMS).firstOrNull { it.key == "shield" })
    }
    @Test fun `troop stat badges scale HP and DMG by the leveling multiplier from the real army level`() {
        val l1 = CodexData.troopStats(catalogue, "highlander", null)!!
        assertEquals(listOf(1, 120L, 18L, "1.2", "MELEE", 20), listOf(l1.level, l1.hp, l1.dmg, l1.speed, l1.range, l1.maxLevel))
        val l3 = CodexData.troopStats(catalogue, "bowman", 3)!!
        assertEquals("45 × 1.2² rounded", 65L, l3.hp); assertEquals(20L, l3.dmg); assertEquals("3.5", l3.range)
        assertNull(CodexData.troopStats(catalogue, "dragon", 1))
        assertEquals(listOf("CRIMSON DASH L1", "MOONSUNDER WAVE L6"), CodexData.heroSkills(catalogue, "vex").map { "${it.name} L${it.unlockLevel}" })
        assertTrue(CodexData.heroSkills(catalogue, "theodor").isEmpty())
    }
    @Test fun `selected building INFO uses its authored field report and never a currency entry`() {
        assertEquals(CodexData.defense(catalogue).first { it.key == "cannon" }, sheetBuildingInfo(catalogue, "cannon"))
        assertEquals(CodexData.buildings(catalogue).first { it.key == "keep" }, sheetBuildingInfo(catalogue, "keep"))
        assertTrue(requireNotNull(sheetBuildingInfo(catalogue, "keep")).who.contains("tallest tower"))
        assertNull("Gold Forge has no approved prose: use the same stats-only note as web", sheetBuildingInfo(catalogue, "goldforge"))
        assertNull("A missing structure must not fall through to the KEEP currency report", sheetBuildingInfo(json("""{"constants":{}}"""), "keep"))
    }
}
