package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ui.phasee.miningClaimsPhase
import java.util.UUID
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedStoreTest {
 private val f=MiningOrderedFixtures
 private fun store()=MiningClaimsStore(MemoryStore(),StarterIdentity("https://${UUID.randomUUID()}.test","devnet",f.p.wallet)).also{s->s.begin(s.read(),f.p.idempotencyKey,f.policy,"ordered-v0");s.prepareAttempt(s.read());s.acceptPreparation(f.p.idempotencyKey,f.p);s.acceptClaim(f.p.idempotencyKey,f.claim())}
 private fun setup(s:MiningClaimsStore){s.signingAttempt(s.read(),0);s.acceptSigned(f.p.idempotencyKey,f.wires[0].wire,0);s.submitAttempt(s.read(),0);s.acceptClaim(f.p.idempotencyKey,f.claim(setup=true))}
 @Test fun `setup wire and receipt do not authorize reward until ordinal zero is finalized`() {
  val s=store();assertEquals(0,nextMiningOrdinal(s.read().operation!!));assertNotNull(runCatching{s.signingAttempt(s.read(),1)}.exceptionOrNull());s.signingAttempt(s.read(),0);s.acceptSigned(f.p.idempotencyKey,f.wires[0].wire,0);assertNotNull(runCatching{s.signingAttempt(s.read(),1)}.exceptionOrNull());s.acceptClaim(f.p.idempotencyKey,f.claim(setup=true));assertEquals(1,nextMiningOrdinal(s.read().operation!!));assertNull(s.read().operation!!.claim!!.settledBaseUnits);assertTrue(miningClaimsPhase(s.read().operation!!).contains("KEEP NOT YET PAID"))
 }
 @Test fun `two exact ordinal signatures remain independent and paid receipt archives both`() {
  val s=store();setup(s);s.signingAttempt(s.read(),1);assertNotNull(runCatching{s.acceptSigned(f.p.idempotencyKey,f.wires[0].wire,1)}.exceptionOrNull());s.acceptSigned(f.p.idempotencyKey,f.wires[1].wire,1);s.submitAttempt(s.read(),1);s.acceptClaim(f.p.idempotencyKey,f.claim(setup=true,paid=true));s.finish(s.read());assertEquals(f.wires,s.read().archives.single().ordered!!.signed);assertEquals("8",s.read().archives.single().claim!!.settledBaseUnits)
 }
 @Test fun `wallet-start history alone does not replace retained-wire custody for expired continuation`() {
  val s=store();setup(s);s.signingAttempt(s.read(),1);assertEquals(s.read(),s.signingAttempt(s.read(),1));s.continuationAttempt(s.read(),f.continuation.childPreparation.idempotencyKey);s.acceptContinuation(f.p.idempotencyKey,f.envelope());assertEquals(f.continuation,s.read().operation!!.ordered!!.continuation)
 }
 @Test fun `unsigned expired continuation is saved before explicit child activation with ancestor setup`() {
  val s=store();setup(s);s.continuationAttempt(s.read(),f.continuation.childPreparation.idempotencyKey);s.acceptContinuation(f.p.idempotencyKey,f.envelope());assertEquals(f.p.claimId,s.read().operation!!.preparation!!.claimId);s.useContinuation(s.read());assertEquals(f.continuation.childClaimId,s.read().operation!!.preparation!!.claimId);assertEquals(f.continuation,s.read().operation!!.ordered!!.parent);assertEquals(f.wires[0],s.read().archives.single().ordered!!.signed.single());assertEquals(0,nextMiningOrdinal(s.read().operation!!));assertNull(s.read().operation!!.claim)
 }
 @Test fun `known refusal and fresh unknown receipt alone permit a new continuation key`() {
  val s=store();setup(s);val first=UUID.randomUUID().toString();s.continuationAttempt(s.read(),first);assertNotNull(runCatching{s.renewContinuation(s.read(),f.continuation.childPreparation.idempotencyKey,f.envelope(null))}.exceptionOrNull());s.continuationRefused(f.p.idempotencyKey,MiningOrderedRefusal(409,"MINING_CLAIM_NOT_EXPIRED"));s.renewContinuation(s.read(),f.continuation.childPreparation.idempotencyKey,f.envelope(null));assertEquals(first,s.read().operation!!.ordered!!.previousContinuations.single().key);s.acceptContinuation(f.p.idempotencyKey,f.envelope());assertEquals(f.continuation,s.read().operation!!.ordered!!.continuation)
 }
 @Test fun `malformed terminal custody persists and stale nonterminal cannot reopen the wallet`() {
  val s=store();val raw=Json.encodeToJsonElement(MiningClaimView.serializer(),f.claim(setup=true,paid=true)).jsonObject;val bad=JsonObject(raw+("settledBaseUnits" to JsonPrimitive("-1")));s.observeOrderedClaim(f.p.idempotencyKey,bad);assertTrue(s.read().operation!!.ordered!!.held);assertNotNull(runCatching{s.acceptClaim(f.p.idempotencyKey,f.claim())}.exceptionOrNull());assertNotNull(runCatching{s.signingAttempt(s.read(),0)}.exceptionOrNull());s.acceptClaim(f.p.idempotencyKey,f.claim(setup=true,paid=true));assertFalse(s.read().operation!!.ordered!!.held)
 }
 @Test fun `failed setup with never started remainder archives original unpaid fee evidence`() {
  val s=store();s.signingAttempt(s.read(),0);s.acceptSigned(f.p.idempotencyKey,f.wires[0].wire,0);val setup=f.claim(setup=true);val failed=setup.copy(state="failed",landing="failed",transactions=setup.transactions.mapIndexed{i,t->if(i==0)t.copy(landing="failed",settledBaseUnits=null) else t});s.acceptClaim(f.p.idempotencyKey,failed);assertTrue(orderedFailedSetup(s.read().operation!!));s.archiveFailed(s.read(),failed);assertNull(s.read().operation);assertNull(s.read().archives.single().claim!!.settledBaseUnits);assertEquals(f.wires[0],s.read().archives.single().ordered!!.signed.single())
 }
 @Test fun `repeated receipt polling cannot exhaust terminal custody or undo a later conflicting claim`() {
  val s=store();val setup=f.claim(setup=true)
  repeat(100){n->val c=setup.copy(serverNow="2035-01-01T00:00:00.${n.toString().padStart(3,'0')}Z");s.observeOrderedClaim(f.p.idempotencyKey,Json.encodeToJsonElement(MiningClaimView.serializer(),c).jsonObject);s.acceptClaim(f.p.idempotencyKey,c)}
  assertEquals(1,s.read().operation!!.ordered!!.observations.size);assertFalse(s.read().operation!!.ordered!!.held)
  val bad=Json.encodeToJsonElement(MiningClaimView.serializer(),f.claim(setup=true,paid=true)).jsonObject;s.observeOrderedClaim(f.p.idempotencyKey,JsonObject(bad+("settledBaseUnits" to JsonPrimitive("-1"))))
  assertNotNull(runCatching{s.acceptClaim(f.p.idempotencyKey,setup)}.exceptionOrNull());assertTrue(s.read().operation!!.ordered!!.held)
 }

 @Test fun `locally retained remainder blocks unsigned expiry replacement but later failed server signature preserves old child receipt`() {
  val signed=store();setup(signed);signed.signingAttempt(signed.read(),1);signed.acceptSigned(f.p.idempotencyKey,f.wires[1].wire,1);signed.continuationAttempt(signed.read(),f.continuation.childPreparation.idempotencyKey);assertNotNull(runCatching{signed.acceptContinuation(f.p.idempotencyKey,f.envelope())}.exceptionOrNull())
  val late=store();setup(late);late.continuationAttempt(late.read(),f.continuation.childPreparation.idempotencyKey);late.acceptClaim(f.p.idempotencyKey,f.claim(setup=true,failed=true));late.acceptContinuation(f.p.idempotencyKey,f.envelope());assertEquals(f.continuation,late.read().operation!!.ordered!!.continuation);assertEquals(f.wires[1].signature,late.read().operation!!.claim!!.transactions[1].signature)
 }

 @Test fun `late original wire stays in parent custody after explicit continuation and cannot silently activate a replacement`() {
  fun prepared():MiningClaimsStore{val s=store();setup(s);s.signingAttempt(s.read(),1);s.continuationAttempt(s.read(),f.continuation.childPreparation.idempotencyKey);s.acceptContinuation(f.p.idempotencyKey,f.envelope());return s}
  val before=prepared();before.acceptSigned(f.p.idempotencyKey,f.wires[1].wire,1);assertNotNull(runCatching{before.useContinuation(before.read())}.exceptionOrNull());assertEquals(f.p.claimId,before.read().operation!!.preparation!!.claimId)
  val late=prepared();late.useContinuation(late.read());late.acceptSigned(f.p.idempotencyKey,f.wires[1].wire,1);assertEquals(f.wires,late.read().archives.single().ordered!!.signed);assertEquals(f.continuation.childClaimId,late.read().operation!!.preparation!!.claimId);assertTrue(late.read().operation!!.ordered!!.signingStarted.isEmpty());assertTrue(late.read().operation!!.ordered!!.signed.isEmpty())
 }

 @Test fun `continuation refresh advances only nested observation times and preserves first retained quote bytes`() {
  val s=store();setup(s);s.continuationAttempt(s.read(),f.continuation.childPreparation.idempotencyKey);s.acceptContinuation(f.p.idempotencyKey,f.envelope());val original=s.read();val time="2035-01-01T00:00:01.000Z"
  val refreshed=f.continuation.copy(parentPreparation=f.continuation.parentPreparation.copy(serverNow=time),childPreparation=f.continuation.childPreparation.copy(serverNow=time));s.acceptContinuation(f.p.idempotencyKey,f.envelope(refreshed).copy(serverNow=time));assertEquals(original,s.read())
  val changed=refreshed.copy(childPreparation=refreshed.childPreparation.copy(fees=refreshed.childPreparation.fees.copy(payerBalanceLamports="99999999")));assertNotNull(runCatching{s.acceptContinuation(f.p.idempotencyKey,f.envelope(changed))}.exceptionOrNull());assertEquals(original,s.read())
 }

}
