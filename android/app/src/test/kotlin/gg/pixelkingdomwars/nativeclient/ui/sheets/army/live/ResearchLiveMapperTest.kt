package gg.pixelkingdomwars.nativeclient.ui.sheets.army.live

import gg.pixelkingdomwars.nativeclient.data.ArmyDomainState
import gg.pixelkingdomwars.nativeclient.data.BaseState
import gg.pixelkingdomwars.nativeclient.model.ArmyState
import gg.pixelkingdomwars.nativeclient.model.Balances
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import gg.pixelkingdomwars.nativeclient.ui.army.ArmyUiState
import gg.pixelkingdomwars.nativeclient.ui.model.CommandState
import gg.pixelkingdomwars.nativeclient.ui.model.PriceStatus
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.ResearchCardState
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.TapRoute
import gg.pixelkingdomwars.nativeclient.ui.sheets.army.commandTap
import java.time.Instant
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The live Lab reads the SAME server-rule verdicts ResearchScreen prints (researchChoices) and sends the SAME start
 * order; the paid FINISH opens the existing review without guessing its currency. */
class ResearchLiveMapperTest {
    private fun obj(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject
    private val now = Instant.parse("2030-01-01T00:00:00Z").toEpochMilli()
    private val catalogue = obj("""{"constants":{
        "TROOPS":{"highlander":{"pts":2,"costKeep":12,"hp":100,"dps":10},"bowman":{"pts":1,"costKeep":10,"hp":40,"dps":12}},
        "TROOP_LEVELING":{"statMultPerLevel":1.5,"maxLevel":3,"researchCostKeep":[100,200,300],"researchTimeSec":[60,120,180]}},
        "display":{"research":{"troops":["highlander","bowman"],"darkTroops":[],"eliteItems":{}}}}""")

    private fun state(forge: Int = 2, shards: String = "1000", research: String = "[]", levels: String = """{"highlander":1,"bowman":3}""",
        speedup: String = "") = ArmyUiState(
        domain = ArmyDomainState(army = ArmyState.from(obj("""{"levels":$levels,"research":$research,
            "features":{"researchConsent":{"version":1}$speedup}}""")), armyBaseId = "b1", armyBaseGeneration = 0L),
        home = BaseState(base = BaseSnapshot.from(obj("""{"baseId":"b1","player":{"keepLevel":5},
            "buildings":[{"id":"lab","type":"forge","level":$forge,"tx":0,"ty":0}],"jobs":[]}""")), balances = Balances(shards, "0")),
        wallet = "w1", baseId = "b1", catalogue = catalogue)

    @Test fun `START is the exact order ResearchScreen sends - shards price, current level and target`() {
        val st = state()
        val data = requireNotNull(researchLiveData(st, 0L))
        val choice = data.choices.first { it.troop == "highlander" }
        assertEquals(obj("""{"action":"start","troop":"highlander","level":1,"toLevel":2,"price":"100","baseId":"b1"}"""),
            researchStartOrder(data, choice))
    }

    @Test fun `the default selection is the first researchable troop and the footer names the target`() {
        val ui = researchLiveUi(state(), 0L, now, null, busy = false, actionsAllowed = true)
        assertEquals("highlander", ui.selected?.troop)
        assertEquals(ResearchCardState.SELECTED, ui.cards.first { it.troop == "highlander" }.state)
        assertEquals("L2", ui.cards.first { it.troop == "highlander" }.target)
        assertEquals(CommandState.ENABLED, ui.footer.primary.state)
        assertEquals("Highlander to L2", ui.footer.primary.sub)
        assertEquals("Stats are scaled like the Barracks cell", "100", ui.selected?.stats?.first()?.now)
        assertEquals("150", ui.selected?.stats?.first()?.next)
    }

    @Test fun `the server's caps become MAX and LAB_CAP cards, never a price`() {
        val ui = researchLiveUi(state(forge = 1), 0L, now, null, busy = false, actionsAllowed = true)
        val bowman = ui.cards.first { it.troop == "bowman" }
        assertEquals(ResearchCardState.MAX, bowman.state)
        assertNull(bowman.nextPrice)
        assertEquals(ResearchCardState.LAB_CAP, ui.cards.first { it.troop == "highlander" }.state)
        assertNull("Nothing can be researched, so nothing is selected", ui.selected)
    }

    @Test fun `not enough Shards is SHORT, and RESEARCH opens Need-more instead of sending`() {
        val ui = researchLiveUi(state(shards = "50"), 0L, now, "highlander", busy = false, actionsAllowed = true)
        assertEquals(ResearchCardState.SHORT, ui.cards.first { it.troop == "highlander" }.state)
        assertEquals(PriceStatus.SHORT, ui.cards.first { it.troop == "highlander" }.nextPrice?.status)
    }

    @Test fun `a busy Lab shows the job, dims every card and offers FINISH as a door into the review`() {
        val row = """[{"troop":"highlander","toLevel":2,"finishesAt":"2030-01-01T00:00:30Z","episodeId":"e1","finishQuote":{"maxCostKeep":"5"}}]"""
        val ui = researchLiveUi(state(research = row, speedup = ""","researchSpeedupReceipts":{"version":1}"""), 0L, now, null,
            busy = false, actionsAllowed = true)
        val job = requireNotNull(ui.job)
        assertEquals(30L, job.remainingSec)
        assertEquals("Progress comes from the pack's canonical duration", 0.5f, job.progress!!, 0.001f)
        // Rewritten with A5 (was a CHECKING Gems pill): the FINISH tap now opens the review in place, which alone knows the currency.
        assertNull("The review, not the sheet, determines GEMS versus KEEP", job.finish.price)
        assertEquals("Price shown in review", job.finish.sub)
        assertEquals(TapRoute.RUN, commandTap(ui.footer.primary))
        assertEquals(ResearchCardState.IN_LAB, ui.cards.first { it.troop == "highlander" }.state)
        assertEquals(ResearchCardState.BUSY, ui.cards.first { it.troop == "bowman" }.state)
        assertNull(ui.selected)
    }

    @Test fun `without the server's speed-up receipts FINISH explains itself instead of opening a review`() {
        val row = """[{"troop":"highlander","toLevel":2,"finishesAt":"2030-01-01T00:00:30Z"}]"""
        val ui = researchLiveUi(state(research = row), 0L, now, null, busy = false, actionsAllowed = true)
        assertEquals(CommandState.DISABLED, ui.job?.finish?.state)
        assertTrue(ui.job?.finish?.reason!!.contains("compatible server quote"))
    }

    @Test fun `nothing loaded yet reads loading with RESEARCH off and its reason`() {
        val ui = researchLiveUi(ArmyUiState(), 0L, now, null, busy = false, actionsAllowed = true)
        assertTrue(ui.loading)
        assertEquals(CommandState.DISABLED, ui.footer.primary.state)
        assertNotNull(ui.footer.primary.reason)
    }
}
