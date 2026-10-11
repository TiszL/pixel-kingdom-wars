package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.network.fmtN
import gg.pixelkingdomwars.nativeclient.json
import gg.pixelkingdomwars.nativeclient.model.BattleOpponent
import gg.pixelkingdomwars.nativeclient.model.BattleRecord
import gg.pixelkingdomwars.nativeclient.ui.attack.*
import gg.pixelkingdomwars.nativeclient.ui.more.baseLocationLabel
import gg.pixelkingdomwars.nativeclient.ui.more.deedLine
import gg.pixelkingdomwars.nativeclient.model.BaseSummary
import org.junit.Assert.*
import org.junit.Test

/** The pure rules the PvP screens are built on, each pinned to the production module it mirrors. */
class RaidRulesTest {
    private val constants = json("""{"RAID_ENERGY":{"perRaid":1,"freePerDay":6},"PVP_ATTACK_SHARD_COST_BY_KEEP_LEVEL":[100,200,300],"RAID_RULES":{"revengeLockHours":4}}""")

    @Test fun `the landowner chooser is production's three rows and the deedless chooser leads with campaign and never picks targets`() {
        val owner = raidChoices(landOwned = true)
        assertEquals(listOf("auto", "map", "campaign"), owner.map { it.id }); assertTrue(owner.first().gold); assertTrue(owner.none { it.preview })
        val deedless = raidChoices(landOwned = false)
        assertEquals("CAMPAIGN leads because the landless pool starts empty (F10)", listOf("campaign", "auto", "map"), deedless.map { it.id })
        assertTrue(deedless.first().gold); assertTrue("The map row is a look, not a target picker", deedless.last().preview)
        assertEquals("WORLD MAP — LOOK ONLY", deedless.last().title)
        val onboarding = raidChoices(landOwned = true, onboarding = true)
        assertEquals("The first-raid onboarding keeps CAMPAIGN primary for a landowner too", "campaign", onboarding.first().id); assertFalse(onboarding.last().preview)
    }
    @Test fun `the entry ante is the catalogue table clamped to the attacker's keep and a missing table fails closed`() {
        assertEquals("100", pvpAttackShardCost(constants, 1)); assertEquals("300", pvpAttackShardCost(constants, 9)); assertEquals("100", pvpAttackShardCost(constants, 0))
        assertEquals("1 ENERGY + 200 SHARDS", raidEntryCostLabel(constants, 2))
        assertEquals("1 ENERGY + — SHARDS", raidEntryCostLabel(constants, null))
        assertNull("No Kotlin copy of the ante: a pack without the table states nothing", raidEntryCostLabel(json("""{"RAID_RULES":{}}"""), 2))
        assertEquals("1,234,567", fmtN("1234567")); assertEquals("-9,007,199,254,740,993", fmtN("-9007199254740993")); assertEquals("0", fmtN("0"))
    }
    private fun row(role: String = "defender", mode: String = "pvp", opponent: BattleOpponent? = BattleOpponent("deed-9", "AttackerWallet", "Kane", true), createdAt: String = "2026-09-11T00:00:00Z", amount: String? = "-120", redacted: Boolean = false) =
        BattleRecord("r1", "deed-1", role, mode, null, "defeat", 2, "63", amount, amount, "SHARDS", redacted, opponent, createdAt)

    @Test fun `only a pvp defence with a known opponent offers revenge and the label follows the lock window`() {
        val target = requireNotNull(revengeTarget(row()))
        assertEquals("AttackerWallet", target.defenderWallet); assertEquals("deed-9", target.defenderBaseId); assertEquals("Kane", target.name)
        assertNull(revengeTarget(row(role = "attacker"))); assertNull(revengeTarget(row(mode = "campaign"))); assertNull(revengeTarget(row(opponent = null)))
        assertNull("A legacy row without a deed id takes the auto-match target shape", revengeTarget(row(opponent = BattleOpponent("", "w", "", false)))!!.defenderBaseId)
        val created = java.time.Instant.parse("2026-09-11T00:00:00Z").toEpochMilli()
        assertEquals("REVENGE", revengeLabel(row(), constants, created + 3 * 3_600_000))
        assertEquals("ATTACK BACK", revengeLabel(row(), constants, created + 5 * 3_600_000))
        assertNull("No lock window in the pack: no promise is made", revengeLabel(row(), json("{}"), created))
    }
    @Test fun `settled loot keeps exact text and names redaction and the attacker line names the real attacker`() {
        assertEquals("-120 SHARDS", settledLootLabel(row())); assertEquals("+9,007,199,254,740,993 SHARDS", settledLootLabel(row(amount = "9007199254740993")))
        assertEquals("LOOT REDACTED", settledLootLabel(row(redacted = true))); assertEquals("LOOT REDACTED", settledLootLabel(row(amount = null)))
        assertEquals("Kane" to true, battleAttacker(row())); assertEquals("YOU" to false, battleAttacker(row(role = "attacker"))); assertEquals("UNKNOWN" to false, battleAttacker(row(opponent = null)))
        assertEquals("Atta…llet" to false, battleAttacker(row(opponent = BattleOpponent("d", "AttackerWallet", "", false))))
        val created = java.time.Instant.parse("2026-09-11T00:00:00Z").toEpochMilli()
        assertEquals("JUST NOW", relTime("2026-09-11T00:00:00Z", created + 30_000)); assertEquals("5M AGO", relTime("2026-09-11T00:00:00Z", created + 5 * 60_000))
        assertEquals("3H AGO", relTime("2026-09-11T00:00:00Z", created + 3 * 3_600_000)); assertEquals("2D AGO", relTime("2026-09-11T00:00:00Z", created + 50 * 3_600_000))
        assertTrue(raidWon("1")); assertFalse(raidWon("0")); assertFalse(raidWon(null))
    }
    @Test fun `base cards name the realm tile from the catalogue and the deed state from the directory`() {
        val names = json("""{"sunscar":"Sunscar"}""")
        val fantasy = BaseSummary("a", "active", 3, slot = 1, deedAssetId = "DeedAsset123456789", fantasyLocation = json("""{"realmId":"sunscar","tileId":42}"""))
        assertEquals("SUNSCAR · TILE 42", baseLocationLabel(fantasy, true, names)); assertEquals("DEED DeedAs…6789", deedLine(fantasy))
        assertEquals("DEED LOCATION PENDING", baseLocationLabel(BaseSummary("b", landPaidAt = "2026-09-01T00:00:00Z"), true, names))
        assertEquals("NO DEEDED LAND", baseLocationLabel(BaseSummary("c"), true, names)); assertEquals("FREE BASE · NO DEED", deedLine(BaseSummary("c")))
        assertEquals("LAND PAID · DEED PENDING", deedLine(BaseSummary("b", landPaidAt = "2026-09-01T00:00:00Z")))
        assertEquals("EARTH CELL PENDING", baseLocationLabel(BaseSummary("d"), false, names))
    }
}
