package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.charter.*
import kotlinx.serialization.json.*
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
class RetirementUiTest {
 @Test fun `separate payout preparation and wallet steps cannot be compressed into one consent`()=runBlocking {
  val f=RetirementFixtures;val identity=f.identity()
  fun state(r:RetirementRecord)=RetirementState(loaded=true,journal=RetirementJournal(identity=identity,records=listOf(r)),selected=f.key)
  val unpaid=RetirementRecord(f.key,f.clan,response=f.unpaid());val first=retirementControls(state(unpaid),true);assertTrue(first.pay);assertFalse(first.prepare);assertFalse(first.approve)
  val prepared=unpaid.copy(response=f.draft);val review=retirementControls(state(prepared),true);assertTrue(review.review);assertFalse(review.approve);assertTrue(retirementControls(state(prepared).copy(reviewed=true),true).approve)
  val uncertain=prepared.copy(attempts=listOf("wallet"));assertFalse(retirementControls(state(uncertain).copy(reviewed=true),true).approve);assertEquals("WALLET OUTCOME UNKNOWN",retirementStatus(uncertain));Unit
 }
 @Test fun `paused terminal and held history expose no new effects`()=runBlocking {
  val f=RetirementFixtures;val r=RetirementRecord(f.key,f.clan,response=f.status("completed"));val s=RetirementState(loaded=true,journal=RetirementJournal(identity=f.identity(),records=listOf(r)),selected=f.key)
  assertEquals("CLAN DISSOLVED",retirementStatus(r));val c=retirementControls(s,false);assertFalse(c.approve);assertFalse(c.pay);assertFalse(c.deliver);assertFalse(c.cancel)
  assertEquals("OUTCOME NEEDS VERIFICATION",retirementStatus(r.copy(held=true)));assertFalse(retirementControls(s.copy(busy=true),true).recover);Unit
 }
 @Test fun `saved dissolution alone keeps the parent entry available without Charter history or pins`()=runBlocking {
  val f=RetirementFixtures;val r=RetirementRecord(f.key,f.clan,response=f.status("completed"));val s=RetirementState(loaded=true,journal=RetirementJournal(identity=f.identity(),records=listOf(r)),selected=f.key)
  assertFalse(charterEntryAvailable(null,false,false));assertTrue(retirementEntryAvailable(s,false))
  assertTrue(retirementEntryAvailable(null,true));assertTrue(retirementEntryAvailable(RetirementState(error="Unreadable saved original"),false));assertFalse(retirementEntryAvailable(RetirementState(loaded=true),false))
 }
 @Test fun `interrupted member payout and still cleared preparation offer same original resume`()=runBlocking {
  val f=RetirementFixtures;val paid=RetirementRecord(f.key,f.clan,response=JsonObject(f.draft+("operation" to JsonNull)),attempts=listOf("pay-members:0"))
  fun state(r:RetirementRecord)=RetirementState(loaded=true,journal=RetirementJournal(identity=f.identity(),records=listOf(r)),selected=f.key)
  assertTrue(retirementControls(state(paid),true).pay);assertFalse(retirementControls(state(paid),false).pay)
  val cleared=paid.copy(response=f.status("cleared"),attempts=listOf("pay-members:0","prepare:0"));assertTrue(retirementControls(state(cleared),true).prepare)
  assertFalse(retirementControls(state(cleared.copy(response=f.draft)),true).prepare);Unit
 }
}
