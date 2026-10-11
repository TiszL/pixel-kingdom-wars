package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TroopCardState
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.*
import org.junit.Test

class ArmyPresentationDetailsTest {
    private fun obj(s: String): JsonObject = Json.parseToJsonElement(s).jsonObject
    private val catalogue = obj("""{"constants":{
      "TROOPS":{"highlander":{"pts":2,"costKeep":12,"trainSec":7.5,"hp":100,"dps":10,"range":"melee","speedTilesPerSec":2},
        "mage":{"pts":3,"costKeep":40,"trainSec":30,"requiresKeepLevel":9},
        "direwyvern":{"pts":8,"costKeep":90,"trainSec":60}},
      "TROOP_LEVELING":{"statMultPerLevel":1.2,"maxLevel":20},
      "ELITE_TROOP_UNLOCKS":{"itemByTroop":{"direwyvern":"writ"}},
      "ITEMS":{"writ":{"acquisition":{"type":"drop"}}}}}""")
    private val base = BaseSnapshot.from(obj("""{"baseId":"b","player":{"keepLevel":3},"buildings":[
      {"id":"keep-actual","type":"keep","level":3,"tx":0,"ty":0},
      {"id":"forge-actual","type":"goldforge","level":1,"tx":3,"ty":0}]}"""))
    private fun army(queue: String = "[]", levels: String = "{\"highlander\":3}") = ArmyState.from(obj("""{
      "counts":{"highlander":5},"levels":$levels,"queue":$queue,"rosterPts":10,"queuedPts":0,
      "campCapacityPts":100,"barracksQueuePts":100}"""))
    private fun state(balance: String? = "100", quantities: Map<String, String> = emptyMap(), a: ArmyState = army()) = ArmyUiState(
        domain = ArmyDomainState(army = a, armyBaseId = "b", armyBaseGeneration = 4),
        home = BaseState(base = base, balances = balance?.let { Balances(it, "999") }),
        wallet = "w", baseId = "b", quantities = quantities, catalogue = catalogue)

    @Test fun `known shards include the existing draft when pricing one more card`() {
        val st = state("20", mapOf("highlander" to "1"))
        val card = trainLiveUi(st, 4, 0, false, true).troops.first { it.troop == "highlander" }
        assertEquals(TroopCardState.SHORT, card.state)
        assertEquals(1, card.chosen)
        assertEquals("12", card.price.amount)
        assertEquals(PriceStatus.SHORT, card.price.status)
        assertEquals("24", trainShortPrice(st, 4, "highlander")?.amount)
        assertNull(trainShortPrice(state("24", mapOf("highlander" to "1")), 4, "highlander"))
    }

    @Test fun `unknown wrong-base and malformed balances never invent shortfall`() {
        assertNull(trainShortPrice(state(null), 4, "highlander"))
        assertNull(trainShortPrice(state("not-a-number"), 4, "highlander"))
        assertNull(trainShortPrice(state("0").copy(baseId = "another"), 4, "highlander"))
        assertNull(trainShortPrice(state("0"), 5, "highlander"))
        assertNotNull(trainShortPrice(state("0"), 4, "highlander"))
        assertNull(trainShortPrice(state("900719925474099312345"), 4, "highlander"))
    }

    // Owner 2026-10-11 (Seeker, code 33): with no Shards a troop tap sent the player to the Gold Forge. The tap must say
    // why it did nothing, in Shards, with the gap, so the player knows how many to collect while staying on the Barracks.
    // Rewritten 2026-10-11 (owner review of the Seeker code-33 fix): the earlier wording also named the balance and ran
    // 89-96 characters, so the toast's two-line ellipsis cut "(N short)". It now names the order total and the gap only.
    @Test fun `a short troop tap names the order and the gap in Shards`() {
        assertEquals("Not enough Shards for a Highlander: need 12, 12 short.",
            trainShortMessage(state("0"), 4, "highlander"))
        // The existing draft counts: one Highlander chosen + one more = 24 against 20.
        assertEquals("Not enough Shards for a Highlander: need 24, 4 short.",
            trainShortMessage(state("20", mapOf("highlander" to "1")), 4, "highlander"))
        assertEquals("Not enough Shards for a Highlander: need 12, 9.5 short.",
            trainShortMessage(state("2.5"), 4, "highlander"))
    }

    /** Greedy word wrap, as a TextView/Compose Text breaks a line at spaces. */
    private fun wrap(text: String, width: Int): List<String> = text.split(' ').fold(mutableListOf<String>()) { lines, word ->
        if (lines.isNotEmpty() && lines.last().length + 1 + word.length <= width) lines[lines.size - 1] = lines.last() + " " + word
        else lines += word
        lines
    }

    // The message is a toast: Toast (ui/kit/Feedback.kt) is maxLines = 2 with an ellipsis, VT323 at 8dp a character leaves
    // about 38 characters a line on a 360dp phone, and the owner rule in ui/Theme.kt:306 (2026-10-06) is "every answer
    // fits a two-line toast ... without an ellipsis". The gap is the point of the message (owner 2026-10-11), so the
    // longest troop names with 6-digit amounts must still show "N short" whole inside those two lines.
    @Test fun `the worst-case shortfall message fits the two-line toast with the gap visible`() {
        val dear = obj("""{"constants":{"TROOPS":{
          "bilgewraith":{"pts":8,"costKeep":999999,"trainSec":60},"kegrunner":{"pts":8,"costKeep":999999,"trainSec":60}}}}""")
        for (troop in listOf("bilgewraith", "kegrunner")) {
            val message = trainShortMessage(state("100000").copy(catalogue = dear), 4, troop)!!
            assertTrue("names the gap: $message", message.contains("899,999 short"))
            assertTrue("${message.length} > 76: $message", message.length <= 76)
            val lines = wrap(message, 38)
            assertTrue("wraps to ${lines.size} lines: $lines", lines.size <= 2 && lines.all { it.length <= 38 })
            assertTrue("the gap is not split or cut: $lines", lines.any { it.contains("899,999 short") })
        }
    }

    @Test fun `no shortfall message when the balance covers the tap or is not known`() {
        // Covered: the tap must add the troop, not refuse it.
        assertNull(trainShortMessage(state("12"), 4, "highlander"))
        // Unknown / stale balance: never invent a shortfall; the server quote stays the gate.
        assertNull(trainShortMessage(state(null), 4, "highlander"))
        assertNull(trainShortMessage(state("0").copy(baseId = "another"), 4, "highlander"))
        assertNull(trainShortMessage(state("0"), 5, "highlander"))
    }

    @Test fun `lock and no-room retain priority over a known shortage`() {
        val st = state("0")
        assertEquals(TroopCardState.LOCKED, trainLiveUi(st, 4, 0, false, true).troops.first { it.troop == "mage" }.state)
        val full = st.copy(domain = st.domain.copy(army = st.domain.army!!.copy(campCapacityPts = 10)))
        assertEquals(TroopCardState.NO_ROOM, trainLiveUi(full, 4, 0, false, true).troops.first { it.troop == "highlander" }.state)
    }

    // Rewritten with S1: train.png's footer has ONE VT line, "+n pts · work"; the "Est. work ·", troop-count and "Nothing
    // is bought" lines are gone. The rule kept: the catalogue's fractional work is shown as given, never rounded.
    @Test fun `draft work preserves fractional catalogue durations in the one footer points line`() {
        val st = state(quantities = mapOf("highlander" to "3"))
        assertEquals("22.5s", draftTrainingWork(st))
        assertEquals(listOf("+6 pts · 22.5s"), trainLiveUi(st, 4, 0, false, true).footer.info)
        assertNull(draftTrainingWork(st.copy(catalogue = null)))
        assertNull(draftTrainingWork(st.copy(quantities = mapOf("unpriced" to "2"))))
    }

    @Test fun `missing queue timestamps are unknown rather than ready now`() {
        val st = state(a = army("""[{"id":"q","troop":"highlander"}]"""))
        assertEquals(UNKNOWN, trainLiveUi(st, 4, 0, false, true).header.chip?.emphasis)
        assertNull(armyLiveUi(st, 4, 0, false).trainingDoneInSec)
        assertNull(trainQueueCompletion(st.domain.army!!, 0))
        assertEquals(0L, trainQueueCompletion(army(), 0))
    }

    @Test fun `initial loading activates actual skeletons while refresh keeps current cards`() {
        val st = state()
        val empty = st.copy(domain = st.domain.copy(army = null, loading = true))
        assertTrue(trainLiveUi(empty, 4, 0, false, true).loading)
        assertTrue(trainLiveUi(empty, 4, 0, false, true).troops.isEmpty())
        assertFalse(trainLiveUi(st.copy(domain = st.domain.copy(loading = true)), 4, 0, true, true).troops.isEmpty())
    }

    @Test fun `troop details scale only the observed research level and preserve missing stats`() {
        val info = requireNotNull(armyTroopInfo(state(), 4, "highlander"))
        assertEquals("L3", info.level)
        assertEquals("144", info.stats.first { it.first == "Hitpoints" }.second)
        assertEquals("14", info.stats.first { it.first == "Damage/s" }.second)
        assertNull(info.focusBuildingId)
        val unknown = requireNotNull(armyTroopInfo(state(a = army(levels = "{}")), 4, "highlander"))
        assertEquals(UNKNOWN, unknown.level)
        assertEquals(UNKNOWN, unknown.stats.first { it.first == "Hitpoints" }.second)
        assertNull(armyTroopInfo(state(), 4, "unknown-troop"))
    }

    @Test fun `lock guidance focuses an actual current building and never guesses a destination`() {
        val st = state()
        val keep = requireNotNull(armyTroopInfo(st, 4, "mage"))
        assertEquals("KEEP L9", keep.lockReason)
        assertEquals("keep-actual", keep.focusBuildingId)
        assertEquals("GO TO KEEP", keep.goLabel)
        assertEquals("forge-actual", armyTroopInfo(st, 4, "direwyvern")?.focusBuildingId)
        assertNull(armyTroopInfo(st.copy(home = st.home.copy(base = null)), 4, "mage")?.focusBuildingId)
        assertNull(armyTroopInfo(st, 5, "mage")?.focusBuildingId)
    }
}
