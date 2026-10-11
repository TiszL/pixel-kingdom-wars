package gg.pixelkingdomwars.nativeclient.ui.phasee
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedUiTest {
 private val f=MiningOrderedFixtures
 private fun operation()=MiningClaimsOperation(MiningClaimPrepareRequest(f.p.idempotencyKey,"ordered-v0"),f.policy,true,preparation=f.p,claim=f.claim(),ordered=MiningOrderedCustody())
 private fun state(op:MiningClaimsOperation)=MiningClaimsState(true,journal=MiningClaimsJournal(1,StarterIdentity("https://fixture.test","devnet",f.p.wallet),1,op,emptyList()),status=f.status(),review=f.p)
 @Test fun `confirmed setup remains unpaid and only next ordinal may be reviewed`() {
  val setup=operation().copy(claim=f.claim(setup=true),ordered=MiningOrderedCustody(signingStarted=listOf(0),signed=listOf(f.wires[0]),submitAttempted=listOf(0)))
  assertEquals("SETUP FINALIZED · KEEP NOT YET PAID",miningClaimsPhase(setup));val active=miningClaimsControls(state(setup),true);assertTrue(active.review&&active.sign);assertFalse(active.finish||active.submit)
  val paused=miningClaimsControls(state(setup),false);assertFalse(paused.review||paused.sign||paused.submit);assertTrue(paused.check)
 }
 @Test fun `unknown wallet offers explicit same-message review while terminal holds prevent all new actions`() {
  val unknown=operation().copy(ordered=MiningOrderedCustody(signingStarted=listOf(0)));assertTrue(miningClaimsPhase(unknown).contains("UNKNOWN"));val blocked=miningClaimsControls(state(unknown),true);assertTrue(blocked.review);assertFalse(blocked.submit||blocked.finish);assertTrue(blocked.check)
  val held=operation().copy(claim=f.claim(setup=true,paid=true),ordered=MiningOrderedCustody(held=true));assertTrue(miningClaimsPhase(held).contains("VERIFICATION"));val control=miningClaimsControls(state(held),true);assertFalse(control.finish||control.sign||control.submit);assertTrue(control.check)
 }
 @Test fun `saved child quote disables parent actions and a failed setup can archive unpaid receipt`() {
  val parent=operation().copy(claim=f.claim(setup=true),ordered=MiningOrderedCustody(continuation=f.continuation));val control=miningClaimsControls(state(parent),true);assertFalse(control.review||control.sign||control.submit||control.finish);assertTrue(control.check);assertEquals("REMAINING CLAIM QUOTE SAVED",miningClaimsPhase(parent))
  val base=f.claim(setup=true);val failed=operation().copy(claim=base.copy(state="failed",landing="failed",transactions=base.transactions.mapIndexed{i,t->if(i==0)t.copy(landing="failed",settledBaseUnits=null)else t}),ordered=MiningOrderedCustody(signingStarted=listOf(0),signed=listOf(f.wires[0])))
  assertTrue(miningClaimsControls(state(failed),false).archiveFailed);assertFalse(miningClaimsControls(state(failed),false).finish)
 }
 @Test fun `history names both continuation claims and ordinal signatures while a held terminal never announces paid`() {
  val op=operation().copy(claim=f.claim(setup=true),ordered=MiningOrderedCustody(signed=listOf(f.wires[0]),continuation=f.continuation))
  val details=miningClaimsSavedDetails(op);assertTrue(details.any{it.value==f.continuation.childClaimId});assertTrue(details.any{it.value==f.wires[0].signature});assertNull(miningClaimsPaidKeep(op))
  val held=operation().copy(claim=f.claim(setup=true,paid=true),ordered=MiningOrderedCustody(held=true));assertNull(miningClaimsPaidKeep(held));assertEquals("CHECKING",miningClaimsSavedPill(held).label)
 }

 @Test fun `existing-account single claim failure can archive while paused but held and busy remain closed`() {
  val p=f.continuation.childPreparation;val landing=f.claim(setup=true,failed=true).transactions.last().copy(ordinal=0)
  val receipt=MiningClaimView(1,p.wallet,p.claimId,"failed","failed",landing.signature,null,listOf(landing),p.serverNow,false).also{it.validate()}
  val op=operation().copy(request=MiningClaimPrepareRequest(p.idempotencyKey,"ordered-v0"),preparation=p,claim=receipt)
  assertNull(op.ordered!!.parent);assertTrue(miningClaimsControls(state(op),false).archiveFailed);assertFalse(miningClaimsControls(state(op),false).finish)
  assertFalse(miningClaimsControls(state(op.copy(ordered=op.ordered.copy(held=true))),false).archiveFailed);assertFalse(miningClaimsControls(state(op).copy(busy=true),true).archiveFailed)
 }
 @Test fun `definitive ordered prepare refusal can close through fresh absence while contradictory preparation or hold blocks it`() {
  for(refusal in listOf(MiningClaimPrepareRefusal(422,"INSUFFICIENT_SOL"),MiningClaimPrepareRefusal(503,"PHASE_E_DISABLED"))){
   val op=operation().copy(preparation=null,claim=null,prepareRefusal=refusal);assertTrue(miningClaimsControls(state(op),false).archiveRefusal)
   assertFalse(miningClaimsControls(state(op.copy(preparation=f.p)),false).archiveRefusal);assertFalse(miningClaimsControls(state(op.copy(claim=f.claim())),false).archiveRefusal)
   assertFalse(miningClaimsControls(state(op.copy(ordered=op.ordered!!.copy(held=true))),true).archiveRefusal)
  }
 }

}
