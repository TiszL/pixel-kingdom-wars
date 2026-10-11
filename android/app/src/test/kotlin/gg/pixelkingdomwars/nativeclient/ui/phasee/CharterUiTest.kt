package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.data.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CharterUiTest {
    private fun state(kind:String="creation",buyer:Boolean=false):CharterState {
        val e=CharterFixtures.envelope(kind,buyer);val id=CharterFixtures.identity(e.actor);val r=CharterRecord(e.key,e.kind,null,e.key,envelope=e.raw)
        return CharterState(true,journal=CharterJournal(identity=id,records=listOf(r)),activity=CharterActivity.from(CharterFixtures.activity(e.actor)),selected=e.key)
    }
    @Test fun `closed missing pins or lifecycle always blocks signing but keeps history controls`() {
        val s=state();assertTrue(charterEntryAvailable(s,false,false));assertTrue(charterEntryAvailable(null,false,true));assertFalse(charterEntryAvailable(null,false,false))
        val c=charterControls(s,false);assertTrue(c.check);assertFalse(c.review);assertFalse(c.approve);assertFalse(c.deliver)
        val lifetime=CharterViewLifetime();lifetime.start();lifetime.setOpen(true);assertTrue(charterActionsAllowed(true,lifetime.snapshot(true,true,"content",false)))
        lifetime.stop();assertFalse(charterActionsAllowed(true,lifetime.snapshot(true,true,"content",false)));lifetime.dispose();lifetime.start();assertFalse(charterActionsAllowed(true,lifetime.snapshot(true,true,"content",false)))
    }
    @Test fun `review approval retention waiting and complete delivery are distinct controls`() {
        val s=state();assertTrue(charterControls(s,true).review);assertFalse(charterControls(s,true).approve);assertTrue(charterControls(s.copy(reviewed=true),true).approve)
        val r=s.record!!;val attempted=r.copy(attempts=listOf("wallet"));val a=s.copy(journal=s.journal!!.copy(records=listOf(attempted)),reviewed=true)
        assertFalse(charterControls(a,true).approve);assertFalse(charterControls(a,true).review);assertFalse(charterControls(a,true).publish)
        val sale=state("sale",true);val full=CharterFixtures.status(sale.envelope!!,"signed",wire=CharterFixtures.row.charterObject("saleWire"),contributions=listOf(CharterFixtures.row.charterObject("buyerContribution"),CharterFixtures.row.charterObject("sellerContribution")))
        val signed=sale.copy(journal=sale.journal!!.copy(records=listOf(sale.record!!.copy(envelope=full.raw))));assertTrue(charterControls(signed,true).deliver);assertFalse(charterControls(signed,true).review)
        assertTrue(charterSummary(full).contains("BOTH APPROVALS"))
    }
    @Test fun `server pause and held evidence remove new effects without hiding recovery`() {
        val s=state();val activity=CharterActivity.from(JsonObject(s.activity!!.raw+("newActions" to buildJsonObject{put("creation",false);put("sale",false)})))
        assertFalse(charterControls(s.copy(activity=activity),true).review)
        val held=s.copy(journal=s.journal!!.copy(records=listOf(s.record!!.copy(held=true))));assertFalse(charterControls(held,true).review);assertTrue(charterControls(held,true).check)
        assertFalse(charterControls(s,true,true).check)
    }
    @Test fun `sale and member payment consent are offered only to original party in exact phase`() {
        val s=state("sale",true);val draft=CharterFixtures.status(s.envelope!!,"draft",false);val buyer=s.copy(journal=s.journal!!.copy(records=listOf(s.record!!.copy(envelope=draft.raw))))
        assertTrue(charterControls(buyer,true).accept);assertFalse(charterControls(buyer,true).pay)
        val seller=state("sale");val accepted=CharterFixtures.status(seller.envelope!!,"accepted",false);val paid=seller.copy(journal=seller.journal!!.copy(records=listOf(seller.record!!.copy(envelope=accepted.raw))))
        assertTrue(charterControls(paid,true).pay);assertFalse(charterControls(paid,true).accept)
    }
    @Test fun `SOL entry is exact and never rounds spending consent`() {
        assertEquals("1",charterSolPrice("0.000000001"));assertEquals("1250000000",charterSolPrice("1.25"))
        for(bad in listOf("0","-1","1e3","01","1,25","0.0000000001","18446744073.709551616"))assertNull(bad,charterSolPrice(bad))
    }
}
