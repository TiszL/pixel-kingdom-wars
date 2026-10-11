package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.model.HeroRoster
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.kit.UNKNOWN
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.HeroState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TroopCardState
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The live Army sheet must say only what the server and the catalogue say: a paid finish never shows a number this
 * client made up, FREE appears only on the server's own offer, unknown reads "…", and every refusal carries its reason. */
class ArmyLiveMapperTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2030-01-01T00:00:30Z").toEpochMilli()
    private val catalogue = obj("""{"constants":{
        "TROOPS":{"highlander":{"pts":2,"costKeep":12,"trainSec":12,"hp":120,"dps":18},
                  "bowman":{"pts":1,"costKeep":10,"trainSec":9,"hp":45,"dps":14},
                  "mage":{"pts":3,"costKeep":40,"trainSec":30,"hp":60,"dps":40,"requiresKeepLevel":9}},
        "TROOP_LEVELING":{"statMultPerLevel":1.2,"maxLevel":20}},
        "display":{"research":{"troops":["highlander","bowman","mage"]}}}""")
    private val base = BaseSnapshot.from(obj("""{"baseId":"b1","player":{"keepLevel":3},
        "buildings":[{"id":"bk","type":"barracks","level":4,"tx":0,"ty":0},{"id":"cp","type":"camp","level":2,"tx":2,"ty":0}]}"""))
    private val queueRows = """[
        {"id":"q1","troop":"highlander","startedAt":"2030-01-01T00:00:00Z","finishesAt":"2030-01-01T00:01:00Z","canCancel":true,"refundShards":"12"},
        {"id":"q2","troop":"highlander","startedAt":"2030-01-01T00:01:00Z","finishesAt":"2030-01-01T00:02:00Z","canCancel":true,"refundShards":"12"},
        {"id":"q3","troop":"bowman","startedAt":"2030-01-01T00:02:00Z","finishesAt":"2030-01-01T00:03:00Z"}]"""

    private fun army(extra: String = "", queue: String = "[]", roster: Int = 10, capacity: Int = 50, counts: String = """{"highlander":5}""") =
        ArmyState.from(obj("""{"counts":$counts,"levels":{"highlander":3,"bowman":1},"queue":$queue,"rosterPts":$roster,"queuedPts":0,
            "campCapacityPts":$capacity,"barracksQueuePts":20$extra}"""))

    private fun state(army: ArmyState?, quantities: Map<String, String> = emptyMap(), pending: Set<String> = emptySet()) = ArmyUiState(
        domain = ArmyDomainState(army = army, armyBaseId = "b1", armyBaseGeneration = 0L),
        home = BaseState(base = base), wallet = "w1", baseId = "b1", quantities = quantities, catalogue = catalogue, pendingCancelIds = pending)

    private val paidOffer = ""","features":{"trainingFinishReceipts":{"version":1}},"finishAllQuote":{"version":1,"maxCostKeep":"37"},
        "freeFinishAllOffer":null,"freeFinishAllReviewRequired":false"""

    // Rewritten with S1 (Barracks in place): a paid FINISH used to draw a CHECKING pill; like research and hero FINISH
    // after A5 it now draws no pill at all and says "Price shown in review". The rule it pins is unchanged: the button
    // never shows a number this client made up, and its tap only asks for the existing review.
    @Test fun `a paid finish shows no price of its own and says the review shows it, never a number this client made up`() {
        val ui = trainLiveUi(state(army(paidOffer, queueRows)), 0L, now, busy = false, actionsAllowed = true)
        val finish = requireNotNull(ui.finish)
        assertEquals(CommandState.ENABLED, finish.state)
        assertNull("The server's maxCostKeep is a ceiling for the review, not a drawn price", finish.price)
        assertEquals("Price shown in review", finish.sub)
        assertFalse(ui.freeFinish)
    }

    @Test fun `FREE is drawn only because the server offered the first free finish`() {
        val free = ""","freeFinishAllOffer":{"offer":"first_army","consent":{"version":1,"maxCostKeep":"0"}}"""
        val ui = trainLiveUi(state(army(free, queueRows)), 0L, now, busy = false, actionsAllowed = true)
        assertTrue(ui.freeFinish)
        assertEquals(PriceStatus.SERVER_ZERO, ui.finish?.price?.status)
    }

    @Test fun `without a compatible server quote FINISH is off and says why, and an empty queue has no FINISH`() {
        val ui = trainLiveUi(state(army(queue = queueRows)), 0L, now, busy = false, actionsAllowed = true)
        assertEquals(CommandState.DISABLED, ui.finish?.state)
        assertTrue(ui.finish?.reason!!.contains("compatible server quote"))
        assertNull(trainLiveUi(state(army()), 0L, now, busy = false, actionsAllowed = true).finish)
    }

    @Test fun `an army the server has not answered reads unknown everywhere and TRAIN cannot be pressed`() {
        val ui = trainLiveUi(state(null), 0L, now, busy = false, actionsAllowed = true)
        assertFalse(ui.housing.known)
        assertEquals(UNKNOWN, ui.header.chip?.emphasis)
        assertEquals(UNKNOWN, ui.troops.first().level)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertNotNull(ui.footer.primary.reason)
    }

    // Rewritten with S1: the card now carries train.png's two short lines ("Unlocks at / Keep 9") instead of "KEEP L9".
    // The Keep level still comes from the catalogue, and the troop's Info sheet keeps the full unlock path.
    @Test fun `a locked troop names its unlock path instead of taking a tap`() {
        val st = state(army())
        val mage = trainLiveUi(st, 0L, now, busy = false, actionsAllowed = true).troops.first { it.troop == "mage" }
        assertEquals(TroopCardState.LOCKED, mage.state)
        assertEquals("Unlocks at\nKeep 9", mage.lockReason)
        assertEquals("KEEP L9", troopLockReason(st, "mage"))
    }

    @Test fun `a full camp dims the cards and TRAIN explains the room, not silence`() {
        val ui = trainLiveUi(state(army(roster = 50, capacity = 50)), 0L, now, busy = false, actionsAllowed = true)
        assertTrue(ui.housing.full)
        assertEquals(TroopCardState.NO_ROOM, ui.troops.first { it.troop == "bowman" }.state)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertEquals("Camp and queue are full. FINISH or raid.", ui.footer.primary.reason)
    }

    @Test fun `the draft total is the catalogue prices the cards show, and TRAIN counts the draft`() {
        val ui = trainLiveUi(state(army(), mapOf("highlander" to "2", "bowman" to "1")), 0L, now, busy = false, actionsAllowed = true)
        assertEquals("34", ui.footer.price.single().amount)
        assertEquals("TRAIN 3", ui.footer.primary.caption)
        assertEquals(CommandState.ENABLED, ui.footer.primary.state)
        assertEquals(TroopCardState.CHOSEN, ui.troops.first { it.troop == "highlander" }.state)
        assertEquals(2, ui.troops.first { it.troop == "highlander" }.chosen)
    }

    @Test fun `orders blocked by an update or a raid keep TRAIN off with the reason`() {
        val ui = trainLiveUi(state(army(), mapOf("bowman" to "1")), 0L, now, busy = false, actionsAllowed = false)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertTrue(ui.footer.primary.reason!!.contains("raid"))
        assertEquals(CommandState.BUSY, trainLiveUi(state(army(), mapOf("bowman" to "1")), 0L, now, busy = true, actionsAllowed = true).footer.primary.state)
    }

    @Test fun `the queue groups by troop, skips rows a cancel tap already took, and only the head carries its timer`() {
        val ui = trainLiveUi(state(army(queue = queueRows), pending = setOf("q2")), 0L, now, busy = false, actionsAllowed = true)
        assertEquals(listOf("highlander" to 1, "bowman" to 1), ui.queue.map { it.troop to it.count })
        assertEquals(30L, ui.queue[0].firstRemainingSec)
        assertNull(ui.queue[1].firstRemainingSec)
        assertTrue("A refundable group says what a tap gives back", ui.queue[0].description.contains("12 Shards"))
        assertTrue(ui.queue[1].description.contains("Finishes normally"))
        assertEquals("LV 4", ui.header.levelTag)
    }

    @Test fun `an empty camp cannot ATTACK and sends the player to the Barracks`() {
        val ui = armyLiveUi(state(army(roster = 0, counts = "{}")), 0L, now, busy = false)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertEquals("Train troops first", ui.footer.primary.reason)
        assertNotNull(ui.emptyCamp)
        assertEquals("LV 2", ui.header.levelTag)
    }

    @Test fun `hero rows come from the server roster - resting shows the time back, unrecruited goes to the build tray`() {
        val roster = HeroRoster.from(obj("""{"heroes":[
            {"hero":"vex","name":"Vex","recruited":true,"level":4,"available":false,"recoveryUntil":"2030-01-01T00:10:30Z"},
            {"hero":"theodor","name":"Theodor","recruited":false}]}"""))
        val st = state(army()).let { it.copy(domain = it.domain.copy(heroes = roster)) }
        val ui = armyLiveUi(st, 0L, now, busy = false)
        val vex = ui.heroes.first { it.hero == "vex" }
        assertEquals(HeroState.RESTING, vex.state)
        assertEquals(600L, vex.remainingSec)
        val theo = ui.heroes.first { it.hero == "theodor" }
        assertEquals(HeroState.NOT_RECRUITED, theo.state)
        assertEquals("hud.build", heroRowDoor(theo).value)
        assertEquals("Heroes 0/1 ready", ui.footer.info[1])
    }

    @Test fun `prices and levels never invent a zero`() {
        assertEquals(PriceStatus.CHECKING, shardsPrice(null).status)
        assertNull(shardsPrice("12.5").amount)
        assertEquals("1,900", shardsPrice("1900").amount)
        assertEquals(UNKNOWN, levelTag(null))
    }
}
