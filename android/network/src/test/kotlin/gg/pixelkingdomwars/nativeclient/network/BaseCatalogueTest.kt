package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Every number the base sheets show is read from the constants catalogue under its `constants.ts` name;
 * a pack that lacks a table yields nothing rather than a Kotlin copy. */
class BaseCatalogueTest {
    private val catalogue = Json.parseToJsonElement("""{"display":{"upgradeSolLamports":{"mine":{"4":"0","5":"500000000"}}},"constants":{
        "ART_V2":{"tiers":4,"levelsPerTier":5},
        "DEFENSE_LEVELING":{"statMultPerLevel":1.25,"maxLevel":20},
        "DEFENSES":{"cannon":{"hp":420,"dps":55,"rangeTiles":6,"footprint":[1,1]},"spiketrap":{"oneUse":true,"footprint":[1,1]},"powdermine":{"oneUse":true,"footprint":[1,1]}},
        "STRUCTURES":{"keep":{"hp":1200,"maxLevel":20,"footprint":[2,2]},"vault":{"hp":500,"maxLevel":20,"capacity":[500,1500,4000],"footprint":[1,1]},
            "mine":{"hp":300,"maxLevel":20,"footprint":[1,1]},"wall":{"hpByTier":[300,600,1200],"maxTier":3,"footprint":[1,1]},"barracks":{"hp":350,"maxLevel":20,"queuePts":[10,15],"footprint":[2,1]}},
        "LOOT":{"vaultProtectionMaxBps":3000},
        "MINING":{"MINE_MULT_BPS":[10000,13600,18800],"BPS_ONE":10000,"MAX_MINES_BY_KEEP":[2,3,4]},
        "TRAP_REPAIR":{"spiketrap":{"costShardsByTier":[20,30,45,65],"repairSec":30}},
        "OBSTACLES":{"tiers":{"small":{"costKeep":10,"clearSec":60,"sizeTiles":1,"kinds":["bush"]},"large":{"costKeep":60,"clearSec":600,"sizeTiles":2,"kinds":["boulder"]}},"clearRewardShards":15},
        "BUILDING_GEOMETRY":{"legacyVersion":1,"keepFootprintByVersion":{"1":[2,2],"2":[4,4]}},
        "CAPS":{"trapsByKeepLevel":[2,4,6],"expansionsMax":2,"expansionPriceSol":0.15,"expansionPriceSolByIndex":[0.15,0.25],"expansionReqKeepLevel":[3,6],"claimTilesByExpansion":[14,16,18]},
        "BUILD_COUNT_CAP_BY_KEEP":{"cannon":[1,1,2],"mortar":[0,0,1]},
        "BUILD_COSTS":{"cannon":{"costShards":200,"buildSec":60},"mortar":{"costShards":500,"buildSec":90,"requiresKeepLevel":3}},
        "TROOPS":{"highlander":{"pts":2},"giant":{"pts":8,"requiresKeepLevel":3}},
        "HEROES":{"vex":{"name":"Vex","unlockKeepLevel":5}},"RALLY":{"unlockKeepLevel":3},"KEEP_BATTERIES":{"highRangeUnlockLevel":15,"lowRangeUnlockLevel":17}}}""").jsonObject

    @Test fun `level stats quote the next level in gold and nothing at max`() {
        val cannon = requireNotNull(levelStats(catalogue, "cannon", 2))
        assertEquals("AT LEVEL 3", cannon.caption)
        assertEquals(listOf(StatRow("HP", "525", "656"), StatRow("DMG", "69", "86"), StatRow("RNG", "6", null)), cannon.rows)
        assertNull(levelStats(catalogue, "cannon", 20)!!.caption)
        assertEquals("Walls read the per-tier table, not the multiplier", listOf(StatRow("HP", "600", "1200")), levelStats(catalogue, "wall", 2)!!.rows)
        assertNull("Max tier quotes nothing", levelStats(catalogue, "wall", 3)!!.rows.single().next)
        val vault = levelStats(catalogue, "vault", 1)!!.rows
        assertEquals(StatRow("SHIELDS", "1.5%", "3%"), vault.first { it.label == "SHIELDS" })
        assertTrue("D-065: the Vault shows raid protection by level, never a storage cap", vault.none { it.label == "CAP" })
        assertEquals(StatRow("PWR", "×1", "×1.36"), levelStats(catalogue, "mine", 1)!!.rows.first { it.label == "PWR" })
        assertEquals(StatRow("CAP", "10", "15"), levelStats(catalogue, "barracks", 1)!!.rows.first { it.label == "CAP" })
        assertNull("Unknown type has no stats", levelStats(catalogue, "clanhall", 1))
        assertNull("No leveling table means no stats are invented", levelStats(buildJsonObject { put("constants", buildJsonObject {}) }, "cannon", 1))
    }
    @Test fun `max level trap repair and obstacle tiers come from their tables`() {
        assertEquals(3, maxLevelFor(catalogue, "wall")); assertEquals(20, maxLevelFor(catalogue, "cannon")); assertEquals(20, maxLevelFor(catalogue, "vault")); assertEquals(1, maxLevelFor(catalogue, "unknown"))
        assertTrue(isTrapType(catalogue, "spiketrap")); assertFalse(isTrapType(catalogue, "cannon"))
        assertNull(trapRepairDetails(catalogue, "spiketrap", 6, null))
        assertEquals(TrapRepair(30, 30), trapRepairDetails(catalogue, "spiketrap", 6, "2026-09-11T00:00:00Z"))
        assertNull("A defence without a repair table offers no repair", trapRepairDetails(catalogue, "cannon", 1, "2026-09-11T00:00:00Z"))
        assertEquals(ObstacleTier("large", 60, 600, 2), obstacleTier(catalogue, "boulder")); assertNull(obstacleTier(catalogue, "unknown"))
        assertEquals(2, obstacleSize(catalogue, "boulder")); assertEquals(1, obstacleSize(catalogue, "unknown")); assertEquals(15L, obstacleClearRewardShards(catalogue))
    }
    @Test fun `footprints follow the geometry version and the shared tables`() {
        assertEquals(2 to 2, footprintOf(catalogue, "keep")); assertEquals(4 to 4, footprintOf(catalogue, "keep", 2)); assertEquals(2 to 1, footprintOf(catalogue, "barracks")); assertEquals(1 to 1, footprintOf(catalogue, "unknown"))
    }
    @Test fun `keep unlocks are derived from the gates the server enforces`() {
        val three = unlocksAtKeepLevel(catalogue, 3)
        assertEquals(listOf(KeepUnlock("building", "mortar"), KeepUnlock("troop", "giant"), KeepUnlock("rally"), KeepUnlock("buildCount", "cannon", 1, 2),
            KeepUnlock("mineCap", null, 1, 4), KeepUnlock("trapCap", null, 2, 6), KeepUnlock("expansion", null, null, 16)), three)
        assertEquals("NEW BUILDING — MORTAR", unlockLabel(catalogue, three[0])); assertEquals("NEW TROOP — GIANT", unlockLabel(catalogue, three[1]))
        assertEquals("+1 CANNON (MAX 2)", unlockLabel(catalogue, three[3])); assertEquals("LAND EXPANSION AVAILABLE (16×16)", unlockLabel(catalogue, three[6]))
        assertEquals(listOf(KeepUnlock("hero", "vex")), unlocksAtKeepLevel(catalogue, 5)); assertEquals("HERO — VEX", unlockLabel(catalogue, KeepUnlock("hero", "vex")))
        assertEquals("KEEP BATTERY — LONG-RANGE GUN", unlockLabel(catalogue, unlocksAtKeepLevel(catalogue, 15).single()))
    }
    @Test fun `build counts share the trap cap and the mine cap has its own curve`() {
        assertEquals(BuildCount(1, 4, 2, false), buildCountPresentation(catalogue, "spiketrap", 2, listOf("spiketrap", "powdermine")))
        assertEquals(BuildCount(2, 2, null, true), buildCountPresentation(catalogue, "mine", 1, listOf("mine", "mine")))
        assertEquals(BuildCount(0, 0, null, true), buildCountPresentation(catalogue, "mortar", 1, emptyList()))
        assertNull("No cap table means no count is invented", buildCountPresentation(catalogue, "clanhall", 1, emptyList()))
    }
    @Test fun `berth capacity reads current server authority and preserves legacy fallback`() {
        val constants = catalogue.getValue("constants").jsonObject
        val tables = constants.getValue("BUILD_COUNT_CAP_BY_KEEP").jsonObject
        val withBerth = JsonObject(catalogue + ("constants" to JsonObject(constants +
            ("BUILD_COUNT_CAP_BY_KEEP" to JsonObject(tables + ("berth" to Json.parseToJsonElement("[0,0,1]")))))))
        val capacity = Json.parseToJsonElement("""{"version":1,"berth":{"max":5}}""")
        assertEquals(BuildCount(4, 5, null, false), buildCountPresentation(withBerth, "berth", 3, List(4) { "berth" }, capacity))
        assertEquals(BuildCount(5, 5, null, true), buildCountPresentation(withBerth, "berth", 3, List(5) { "berth" }, capacity))
        assertEquals(BuildCount(1, 1, null, true), buildCountPresentation(withBerth, "berth", 3, listOf("berth")))
        assertEquals(buildCountPresentation(catalogue, "cannon", 3, emptyList()), buildCountPresentation(catalogue, "cannon", 3, emptyList(), capacity))
        assertEquals(0, advertisedBerthBuildCapacity(Json.parseToJsonElement("""{"version":1,"berth":{"max":0}}""")))
        for (bad in listOf("null", "{}", """{"version":2,"berth":{"max":5}}""", """{"version":"1","berth":{"max":5}}""",
            """{"version":1,"berth":{"max":"5"}}""", """{"version":1,"berth":{"max":-1}}""", """{"version":1,"berth":{"max":1.5}}""")) {
            assertNull(advertisedBerthBuildCapacity(Json.parseToJsonElement(bad)))
            assertEquals(BuildCount(1, 1, null, true), buildCountPresentation(withBerth, "berth", 3, listOf("berth"), Json.parseToJsonElement(bad)))
        }
    }

    @Test fun `expansion offers read the ring size gate and price from CAPS`() {
        assertEquals(ExpansionOffer(0, 14, false, 16, 3, "0.15"), expansionOffer(catalogue, 0))
        assertEquals("A completed progression has no purchasable price", ExpansionOffer(2, 18, true, null, null, null), expansionOffer(catalogue, 2))
        assertEquals(500_000_000L, upgradeSolLamports(catalogue, "mine", 5)); assertEquals(0L, upgradeSolLamports(catalogue, "mine", 4)); assertNull(upgradeSolLamports(catalogue, "mine", 9))
    }
}
