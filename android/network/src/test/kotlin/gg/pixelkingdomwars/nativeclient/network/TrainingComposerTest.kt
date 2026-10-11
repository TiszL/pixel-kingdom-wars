package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.TrainingQueueRow
import gg.pixelkingdomwars.nativeclient.model.TroopCount
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** The Barracks display rules ported from army.helpers.ts / troopRollout.ts / armyPresets.ts: every number is
 * a catalogue lookup by its constants.ts name, gates fail closed, and nothing here can move SHARDS or KEEP. */
class TrainingComposerTest {
    private fun json(value: String) = Json.parseToJsonElement(value).jsonObject
    private val catalogue = json("""{"display":{"research":{"troops":["highlander","bowman","gloamfang","mage"]}},"constants":{
        "TROOPS":{"highlander":{"pts":2,"costKeep":12},"bowman":{"pts":1,"costKeep":10},"gloamfang":{"pts":10,"costKeep":80},"mage":{"pts":3,"costKeep":22,"requiresKeepLevel":3},
            "barrowling":{"pts":0,"spawnOnly":true},"wyrmling":{"pts":0,"defenderOnly":true}},
        "ELITE_TROOP_UNLOCKS":{"itemByTroop":{"mage":"item_troop_mage","gloamfang":"item_troop_gloamfang"}},
        "ITEMS":{"item_troop_mage":{"costKeep":5000,"asset":"ui_portrait_mage_t1","acquisition":{"type":"shop"}},"item_troop_gloamfang":{"costKeep":0,"asset":"g","acquisition":{"type":"drop"}}},
        "DARK_ATTACKER_TROOPS":["gloamfang"],
        "ECONOMY":{"speedupKeepPer30Sec":2,"speedupGranularitySec":30,"speedupQuadraticSoftUnits":9000},
        "TRAINING_PRESETS":{"slots":3,"nameMaxLength":32,"maxCompositionUnits":1000}}}""")
    private fun row(id: String, troop: String, finish: String, refund: String? = "10") = TrainingQueueRow(id, troop, "2026-09-11T00:00:00Z", finish, 2, canCancel = refund != null, refundShards = refund)

    @Test fun `the train table follows the pack order and drops spawn-only and defender-only troops`() {
        assertEquals(listOf("highlander", "bowman", "gloamfang", "mage"), trainableTroops(catalogue))
        assertTrue("No catalogue: no cards", trainableTroops(null).isEmpty())
        assertEquals(2, troopPoints(catalogue, "highlander")); assertNull(troopPoints(catalogue, "dragon"))
    }
    @Test fun `manual room reserves the queue and the draft in both capacities and never goes negative`() {
        val queue = listOf(row("a", "highlander", "2026-09-11T00:00:12Z"))
        val room = manualTrainingRoom(catalogue, queue, rosterPts = 15, campCapacityPts = 20, barracksQueuePts = 10, draft = listOf(TroopCount("bowman", 2)))
        assertEquals(TrainingRoom(queuePts = 2, draftPts = 2, campFreePts = 1, queueFreePts = 6), room)
        assertEquals(0, manualTrainingRoom(catalogue, queue, 20, 20, 10, listOf(TroopCount("bowman", 3))).campFreePts)
    }
    @Test fun `writ gates fail closed until the server says the wallet consumed the unlock and name the path`() {
        assertEquals(TroopUnlock.Elite("UNLOCK: 5,000 KEEP WRIT", "ui_portrait_mage_t1"), troopUnlockView(catalogue, "mage", keepLevel = 9, eliteUnlocks = null))
        assertEquals(TroopUnlock.Elite("DROPS FROM GOLD FORGE", "g"), troopUnlockView(catalogue, "gloamfang", 9, mapOf("gloamfang" to false)))
        assertEquals("An unlocked writ falls through to the Keep gate", TroopUnlock.Keep("KEEP L3", 3), troopUnlockView(catalogue, "mage", keepLevel = 2, eliteUnlocks = mapOf("mage" to true)))
        assertEquals(TroopUnlock.Open, troopUnlockView(catalogue, "mage", keepLevel = 3, eliteUnlocks = mapOf("mage" to true)))
        assertEquals(TroopUnlock.Open, troopUnlockView(catalogue, "highlander", keepLevel = null, eliteUnlocks = null))
    }
    @Test fun `the dark roster is locked by the server capability alone and an absent capability fails closed`() {
        assertEquals(RolloutGate(false), troopRolloutGate(catalogue, "highlander", null))
        assertEquals(RolloutGate(true, "COMING SOON"), troopRolloutGate(catalogue, "gloamfang", null))
        assertEquals(RolloutGate(true, "Rolling out"), troopRolloutGate(catalogue, "gloamfang", json("""{"enabled":false,"message":" Rolling out "}""")))
        assertEquals(RolloutGate(false), troopRolloutGate(catalogue, "gloamfang", json("""{"enabled":true}""")))
    }
    @Test fun `a grouped minus-one targets the latest-finishing refundable row and taps resolve distinct ids`() {
        val queue = listOf(row("a", "bowman", "2026-09-11T00:00:09Z"), row("b", "bowman", "2026-09-11T00:00:18Z"), row("c", "bowman", "2026-09-11T00:00:27Z", refund = null), row("d", "highlander", "2026-09-11T00:00:39Z"))
        assertEquals("b", trainingCancelTarget(queue, "bowman")!!.id)
        assertEquals("a", nextTrainingCancelTarget(queue, "bowman", setOf("b"))!!.id)
        assertNull("Every refundable row spoken for: the extra tap is a no-op, never a duplicate POST", nextTrainingCancelTarget(queue, "bowman", setOf("a", "b")))
        assertNull(trainingCancelTarget(queue, "giant"))
        assertEquals(39L, queueRemainingSec(queue, java.time.Instant.parse("2026-09-11T00:00:00Z").toEpochMilli()))
        assertEquals(0L, queueRemainingSec(emptyList(), 0L))
    }
    @Test fun `the speed-up curve reads the catalogue coefficients and matches the server's prices`() {
        assertEquals("The 9-second queue the repository fixtures quote at 3 KEEP", "3", speedupCostKeep(catalogue, 9)!!.toString())
        assertEquals("A due queue still prices one granularity unit, like the server's max(1, …)", "3", speedupCostKeep(catalogue, 0)!!.toString())
        assertEquals("7", speedupCostKeep(catalogue, 61)!!.toString())
        assertNull("A pack without the coefficients prices nothing", speedupCostKeep(json("""{"constants":{"ECONOMY":{"speedupKeepPer30Sec":2}}}"""), 9))
    }
    @Test fun `durations and amounts format like the shared web helpers`() {
        assertEquals("6d 2h", fmtDur(6 * 86_400 + 2 * 3_600 + 59)); assertEquals("2h 36m", fmtDur(2 * 3_600 + 36 * 60 + 5)); assertEquals("36m 5s", fmtDur(36 * 60 + 5))
        assertEquals("45s", fmtDur(45)); assertEquals("0s", fmtDur(-3)); assertEquals("2h", fmtDur(7_200))
        assertEquals("532,100", fmtN("532100")); assertEquals("60", fmtN(60)); assertEquals("-1,000", fmtN("-1000")); assertEquals("0", fmtN("000")); assertEquals("Canonical fmtN truncates decimal labels without rounding balances", "3", fmtN("3.5"))
    }
    @Test fun `saved armies enforce the server's preset rules before any request leaves`() {
        val rules = requireNotNull(TrainingPresetRules.from(catalogue))
        assertEquals(TrainingPresetRules(3, 32, 1000), rules)
        assertNull("No TRAINING_PRESETS in the pack: saved armies fail closed", TrainingPresetRules.from(json("""{"constants":{}}""")))
        val trainable = trainableTroops(catalogue)
        rules.validateComposition(listOf(TroopCount("bowman", 999), TroopCount("highlander", 1)), trainable)
        assertEquals("choose at least one troop type", assertThrows(IllegalArgumentException::class.java) { rules.validateComposition(emptyList(), trainable) }.message)
        assertEquals("use one positive whole count per trainable troop type", assertThrows(IllegalArgumentException::class.java) { rules.validateComposition(listOf(TroopCount("bowman", 0)), trainable) }.message)
        assertEquals("use one positive whole count per trainable troop type", assertThrows(IllegalArgumentException::class.java) { rules.validateComposition(listOf(TroopCount("bowman", 1), TroopCount("bowman", 1)), trainable) }.message)
        assertEquals("use one positive whole count per trainable troop type", assertThrows(IllegalArgumentException::class.java) { rules.validateComposition(listOf(TroopCount("wyrmling", 1)), trainable) }.message)
        assertEquals("a plan supports up to 1000 troops", assertThrows(IllegalArgumentException::class.java) { rules.validateComposition(listOf(TroopCount("bowman", 1001)), trainable) }.message)
        assertEquals("ARMY 1", rules.validateName("  ARMY 1 "))
        assertThrows(IllegalArgumentException::class.java) { rules.validateName(" ") }; assertThrows(IllegalArgumentException::class.java) { rules.validateName("x".repeat(33)) }
        rules.validateSlot(3); assertThrows(IllegalArgumentException::class.java) { rules.validateSlot(4) }; assertThrows(IllegalArgumentException::class.java) { rules.validateSlot(0) }
    }
}
