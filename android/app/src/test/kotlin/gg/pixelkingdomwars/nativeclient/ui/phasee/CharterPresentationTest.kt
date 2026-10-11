package gg.pixelkingdomwars.nativeclient.ui.phasee

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.ui.chrome.PaymentTone
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CharterPresentationTest {
    private fun record(e: CharterEnvelope) = CharterRecord(e.key,e.kind,null,e.key,envelope=e.raw)

    @Test fun `sale review separates seller proceeds and included royalty without adding it to buyer consent`() {
        val costs=CharterFixtures.envelope("sale",true).signing!!.charterObject("costs")
        val rows=charterCostRows(costs).associate{it.label to it.value}
        assertEquals("0.101000003 SOL",rows["Sale price"])
        assertEquals("0.095950003 SOL",rows["Seller receives from sale"])
        assertEquals("0.00505 SOL",rows["Royalty included in sale price"])
        assertFalse(rows.containsKey("NFT creation fee"))
        assertEquals("101017003",costs.charterText("totalLamports"))
    }
    @Test fun `transaction fees retain one lamport and large exact consent without rounding`() {
        val rows=charterCostRows(buildJsonObject { put("networkFeeLamports","1");put("rentLamports","18446744073709551615") })
        assertEquals("0.000000001 SOL",rows[0].value)
        assertEquals("18446744073.709551615 SOL",rows[1].value)
        assertTrue(charterCostRows(buildJsonObject {}).isEmpty())
    }
    @Test fun `creation funding never appears as a SOL royalty or sale price`() {
        val rows=charterCostRows(CharterFixtures.envelope().signing!!.charterObject("costs")).map{it.label}
        assertEquals(listOf("Network fee","Account rent","NFT creation fee"),rows)
    }
    @Test fun `buyer and seller review explicitly identify the original role`() {
        assertEquals("BUY CLAN LEADERSHIP",charterRole(CharterFixtures.envelope("sale",true)))
        assertEquals("SELL CLAN LEADERSHIP",charterRole(CharterFixtures.envelope("sale")))
        assertEquals("CLAN CREATION",charterRole(CharterFixtures.envelope()))
    }
    @Test fun `unknown approval and held response never look paid or complete`() {
        val e=CharterFixtures.envelope();val r=record(e)
        assertEquals(PaymentTone.TROUBLE,charterRecordPill(r,null).tone)
        assertEquals(PaymentTone.TROUBLE,charterRecordPill(r.copy(held=true),e).tone)
        assertEquals(PaymentTone.TROUBLE,charterRecordPill(r.copy(attempts=listOf("wallet")),e).tone)
        assertEquals(PaymentTone.OPEN,charterRecordPill(r,e).tone)
    }
    @Test fun `retained full sale wire is ready for delivery not a completed sale`() {
        val e=CharterFixtures.status(CharterFixtures.envelope("sale",true),"signed",wire=CharterFixtures.row.charterObject("saleWire"),contributions=listOf(CharterFixtures.row.charterObject("buyerContribution"),CharterFixtures.row.charterObject("sellerContribution")))
        val pill=charterRecordPill(record(e).copy(attempts=listOf("wallet")),e)
        assertEquals("READY",pill.label);assertEquals(PaymentTone.SENT,pill.tone)
    }
    @Test fun `terminal cancellation is not presented as successful purchase`() {
        val original=CharterFixtures.envelope("sale",true)
        val e=CharterFixtures.status(original,"cancelled",false,terminal=buildJsonObject{put("id",original.key);put("outcome","cancelled")})
        assertEquals(PaymentTone.CLOSED,charterRecordPill(record(e),e).tone)
    }
    @Test fun `original parties and request identities remain complete in recoverable details`() {
        val e=CharterFixtures.envelope("sale",true)
        val rows=charterOriginalDetails(record(e),e).associate{it.label to it.value}
        assertEquals(e.original.charterText("seller"),rows["Original seller"])
        assertEquals(e.original.charterText("buyer"),rows["Original buyer"])
        assertEquals(e.key,rows["Saved request"])
        assertEquals(e.actor,rows["Original wallet"])
    }
    @Test fun `event details retain all raw timestamps while local dates are only presentation`() {
        val e=TournamentFixtures.event;val rows=tournamentScheduleDetails(e)
        assertEquals(listOf(e.charterText("entryStartsAt"),e.charterText("playStartsAt"),e.charterText("playEndsAt"),e.charterText("occupationEndsAt")),rows.map{it.value})
        assertTrue(rows.all{it.label.contains("UTC")})
    }
    @Test fun `lock consent distinguishes entry from release without implying a Charter sale`() {
        val op=TournamentFixtures.operation
        assertTrue(tournamentLockConsent(op).contains("frozen roster"))
        assertTrue(tournamentLockConsent(op).contains("Your Charter stays with you"))
        val original=op.charterObject("original")
        val clear=JsonObject(op+("original" to JsonObject(original+("operation" to JsonObject(original.charterObject("operation")+("action" to JsonPrimitive("clear")))))))
        assertTrue(tournamentLockConsent(clear).contains("release"))
        assertTrue(tournamentLockConsent(clear).contains("original roster"))
    }
    @Test fun `sponsor prize quantities stay exact and separate by resource`() {
        val prize=buildJsonObject{put("amounts",buildJsonObject{put("frostglass","9223372036854775807");put("heartwood_beams","0")})}
        val rows=tournamentPrizeRows(prize)
        assertEquals("Frostglass",rows[0].label);assertEquals("9223372036854775807",rows[0].value)
        assertEquals("Heartwood Beams",rows[1].label);assertEquals("0",rows[1].value)
    }
    @Test fun `only the known current captain may start entry without changing frozen member rights`() {
        val leader=TournamentFixtures.leader
        assertTrue(tournamentCaptainCanEnter(leader,leader))
        assertFalse(tournamentCaptainCanEnter(leader,"another-member"))
        assertFalse(tournamentCaptainCanEnter(null,null))
        assertFalse(tournamentCaptainCanEnter(leader,null))
    }
    @Test fun `captain cannot create a new entry after results or beside original participation`() {
        val leader=TournamentFixtures.leader
        assertFalse(tournamentCaptainCanEnter(leader,leader,eventCompleted=true))
        assertFalse(tournamentCaptainCanEnter(leader,leader,alreadyEntered=true))
        assertFalse(tournamentCaptainCanEnter(leader,leader,eventCompleted=true,alreadyEntered=true))
        assertTrue(tournamentCaptainCanEnter(leader,leader))
    }
}
