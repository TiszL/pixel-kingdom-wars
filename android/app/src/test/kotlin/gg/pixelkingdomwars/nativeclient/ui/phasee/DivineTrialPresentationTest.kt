package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.data.DivineTrialFixtures as F
import gg.pixelkingdomwars.nativeclient.divine.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class DivineTrialPresentationTest {
    private fun saved(participant:JsonObject?=F.participant())=DivineSavedEvent(F.rules.raw,F.event,participant)
    private fun prize(claim:JsonObject?=null)=buildJsonObject{put("amounts",F.event.getValue("budget"));put("claim",claim?:JsonNull)}
    private fun closed(e:DivineSavedEvent)=e.copy(event=JsonObject(e.event+("terminal" to buildJsonObject{})))

    @Test fun `missing participation does not invent either eligibility or a prize`() {
        assertEquals(DivineTrialActions(false,false,false),divineTrialActions(saved(null)))
    }
    @Test fun `accepted entry is recovered rather than replaced while an unused attempt remains available`() {
        val actions=divineTrialActions(saved())
        assertFalse(actions.enter);assertTrue(actions.attempt);assertFalse(actions.claim)
        assertTrue(divineTrialActions(saved(F.participant(e=null))).enter)
    }
    @Test fun `authoritative final results block entry and new attempts but preserve original prize claim`() {
        assertFalse(divineTrialActions(closed(saved(F.participant(e=null)))).enter)
        val actions=divineTrialActions(closed(saved(F.participant(prize=prize()))))
        assertFalse(actions.enter);assertFalse(actions.attempt);assertTrue(actions.claim)
    }
    @Test fun `unfinished original plan blocks replacement attempts in admitted and committed states`() {
        for(attempt in listOf(F.admitted,F.committed))assertFalse(divineTrialActions(saved(F.participant(attempts=listOf(attempt)))).attempt)
    }
    @Test fun `attempt allowance comes from saved rules and cannot be exceeded`() {
        val attempts=List(F.rules.bound("attemptsPerWallet")){F.complete}
        assertFalse(divineTrialActions(saved(F.participant(attempts=attempts))).attempt)
        assertTrue(divineTrialActions(saved(F.participant(attempts=attempts.dropLast(1)))).attempt)
    }
    @Test fun `held observations and any unanswered command prevent duplicate new requests`() {
        val entry=saved(F.participant(e=null))
        val held=entry.copy(held=listOf(DivineObservation(null,buildJsonObject{})))
        assertEquals(DivineTrialActions(false,false,false),divineTrialActions(held))
        val command=DivineCommand("saved-command","entries",buildJsonObject{put("baseId",F.base)})
        assertFalse(divineTrialActions(entry.copy(commands=listOf(command))).enter)
        val participating=saved(F.participant(prize=prize())).copy(commands=listOf(command))
        assertFalse(divineTrialActions(participating).attempt);assertFalse(divineTrialActions(participating).claim)
        assertTrue(participating.commands.single().retryable)
    }
    @Test fun `saved prize destination survives current kingdom changes until exact receipt confirms it`() {
        val command=DivineCommand("original-prize","prize",buildJsonObject{put("baseId",F.base)},sent=true)
        val e=saved(F.participant(prize=prize())).copy(commands=listOf(command))
        assertFalse(divineTrialActions(e).claim)
        assertEquals(F.base,divinePrizeDestination(e,"another-current-kingdom"))
        assertEquals(F.base,divinePrizeDestination(e,null))
        assertTrue(e.commands.single().retryable)
    }
    @Test fun `confirmed claim uses the original receipt and never becomes a fresh claim`() {
        val claim=buildJsonObject{put("baseId",F.base)}
        val e=saved(F.participant(prize=prize(claim)))
        assertEquals(F.base,divinePrizeDestination(e,"another-current-kingdom"))
        assertFalse(divineTrialActions(e).claim)
        assertEquals("current",divinePrizeDestination(saved(F.participant(prize=prize())),"current"))
    }
    @Test fun `committed or expired trial does not claim a completed score`() {
        assertEquals(PaymentTone.OPEN,divineAttemptPill(F.admitted).tone)
        assertEquals(PaymentTone.SENT,divineAttemptPill(F.committed).tone)
        assertEquals(PaymentTone.DONE,divineAttemptPill(F.complete).tone)
        val expired=JsonObject(F.admitted+("status" to JsonPrimitive("expired")))
        assertEquals(PaymentTone.CLOSED,divineAttemptPill(expired).tone)
    }
    @Test fun `attempt details keep complete original run wallet destination and raw timing`() {
        val rows=divineAttemptDetails(F.complete).associate{it.label to it.value}
        assertEquals(F.complete.dt("id"),rows["Original attempt"])
        assertEquals(F.complete.dt("wallet"),rows["Original wallet"])
        assertEquals(F.complete.dt("baseId"),rows["Original kingdom"])
        assertEquals(F.complete.dt("admittedAt"),rows["Admitted at (UTC)"])
        assertEquals(F.complete.dt("completedAt"),rows["Completed at (UTC)"])
        assertEquals(F.complete.dobj("result").dt("inputSha256"),rows["Result proof"])
    }
    @Test fun `sponsor prize values remain exact per material without a combined balance`() {
        val p=buildJsonObject{put("amounts",buildJsonObject{put("heartwood_beams","9223372036854775807");put("frostglass","0")})}
        val rows=divinePrizeRows(p)
        assertEquals(2,rows.size);assertEquals("Heartwood Beams",rows[0].label)
        assertEquals("9,223,372,036,854,775,807",rows[0].value);assertEquals("0",rows[1].value)
    }
}
