package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.PreparedMiningClaim
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedRepositoryTest {
 private class Fixture {
  val f=MiningOrderedFixtures;val store=MiningClaimsStore(MemoryStore(),StarterIdentity("https://${UUID.randomUUID()}.test","devnet",f.p.wallet));var generation=0;var allowed=true;var prepared=false;var setup=false;var paid=false;var late=false;var unknown=false;var loseSubmit=false;var loseContinue=false;var continued=false;var refuseContinue=false;var prepares=0;var signs=0;var submits=0;var continues=0;val reviews=mutableListOf<Int>();var key=f.p.idempotencyKey
  val ports=object:MiningClaimsPorts{
   override fun capture(newAction:Boolean):()->Unit{val g=generation;return {check(generation==g);if(newAction)check(allowed)}}
   override fun policy()=f.policy;override fun trust()=if(allowed)f.pins else null;override fun key()=key;override fun clockMs()=0L
   override suspend fun status(guard:()->Unit)=f.status().also{guard()}
   override suspend fun prepare(request:MiningClaimPrepareRequest,guard:()->Unit,retain:(MiningClaimPreparationView)->Unit,refusal:(MiningClaimPrepareRefusal)->Unit):MiningClaimPreparationView{assertEquals("ordered-v0",request.profile);assertTrue(store.read().operation!!.prepareAttempted);prepares++;prepared=true;retain(f.p);guard();return f.p}
   override suspend fun preparation(key:String,guard:()->Unit,retain:(MiningClaimPreparationEnvelope)->Unit):MiningClaimPreparationEnvelope{val v=MiningClaimPreparationEnvelope(f.p.wallet,key,if(prepared)"prepared" else "unknown",if(prepared)f.p else null,f.p.serverNow);retain(v);guard();return v}
   override suspend fun claim(id:String,guard:()->Unit,retain:(MiningClaimView)->Unit)=f.claim(setup,paid).also{retain(it);guard()}
   override suspend fun live(preparation:MiningClaimPreparationView,guard:()->Unit)=guard()
   override suspend fun reviewOrdinal(id:String,ordinal:Int,guard:()->Unit):MiningClaimOrdinalReview{guard();reviews+=ordinal;if(ordinal==1)check(setup);return f.reviews[ordinal]}
   override suspend fun sign(prepared:PreparedMiningClaim,guard:()->Unit,retain:(MiningClaimSavedWire)->Unit){guard();signs++;assertTrue(prepared.ordinal in store.read().operation!!.ordered!!.signingStarted);if(unknown)error("Unknown wallet result");val signed=prepared.verifySignedBase64(f.wires[prepared.ordinal].wire);if(late)generation++;retain(MiningClaimSavedWire(signed.ordinal,signed.wire,signed.signature));guard()}
   override suspend fun submit(request:MiningClaimSubmitRequest,guard:()->Unit):MiningClaimSubmitResponse{guard();val ordinal=f.wires.single{it.wire==request.signedTransaction}.ordinal;assertTrue(ordinal in store.read().operation!!.ordered!!.submitAttempted);submits++;if(ordinal==0)setup=true else paid=true;if(loseSubmit)error("Lost delivered reply");return MiningClaimSubmitResponse(f.p.claimId,f.wires[ordinal].signature,f.p.serverNow,"settled")}
   override suspend fun continuation(id:String,guard:()->Unit,retain:(MiningClaimContinuationEnvelope)->Unit)=f.envelope(if(continued)f.continuation else null).also{retain(it);guard()}
   override suspend fun continueClaim(id:String,key:String,guard:()->Unit,retain:(MiningClaimContinuationEnvelope)->Unit,refusal:(MiningOrderedRefusal)->Unit):MiningClaimContinuationEnvelope{guard();continues++;assertEquals(key,store.read().operation!!.ordered!!.continuationRequest);if(loseContinue)error("Unknown outcome");if(refuseContinue){refusal(MiningOrderedRefusal(409,"MINING_CLAIM_NOT_EXPIRED"));error("Not expired")};continued=true;val v=f.envelope();retain(v);guard();return v}
  }
  fun repo()=MiningClaimsRepository(store,ports)
  suspend fun begin():MiningClaimsRepository{val r=repo();r.open();r.begin(true);return r}
  suspend fun setup():MiningClaimsRepository{val r=begin();r.review();r.sign();r.submit();return r}
 }
 @Test fun `two separately reviewed wallet approvals finalize setup then reward and preserve both wires`()=runBlocking {
  val x=Fixture();val r=x.setup();assertNull(x.store.read().operation!!.claim!!.settledBaseUnits);r.review();r.sign();r.submit();r.finish();assertEquals(2,x.signs);assertEquals(2,x.submits);assertTrue(x.reviews.count{it==0}>=3&&x.reviews.count{it==1}>=3);assertEquals(MiningOrderedFixtures.wires,x.store.read().archives.single().ordered!!.signed);Unit
 }
 @Test fun `lost setup send reply recovers by GET without repeating send or approval`()=runBlocking {
  val x=Fixture();val r=x.begin();r.review();r.sign();x.loseSubmit=true;assertNotNull(runCatching{r.submit()}.exceptionOrNull());val reopened=x.repo();reopened.open();assertEquals(1,nextMiningOrdinal(x.store.read().operation!!));assertEquals(1,x.submits);assertEquals(1,x.signs);Unit
 }
 @Test fun `late original ordinal evidence persists before stale lifecycle guard`()=runBlocking {
  val x=Fixture();val r=x.begin();r.review();x.late=true;assertNotNull(runCatching{r.sign()}.exceptionOrNull());assertEquals(listOf(MiningOrderedFixtures.wires[0]),x.store.read().operation!!.ordered!!.signed);val reopened=x.repo();reopened.open();assertNotNull(runCatching{reopened.review()}.exceptionOrNull());assertEquals(1,x.signs);Unit
 }
 @Test fun `drained unknown wallet needs explicit original review while uncertain continuation remains lookup only`()=runBlocking {
  val x=Fixture();val r=x.begin();r.review();x.unknown=true;assertNotNull(runCatching{r.sign()}.exceptionOrNull());val reopened=x.repo();reopened.open();assertNotNull(runCatching{reopened.sign()}.exceptionOrNull());assertEquals(1,x.signs);x.unknown=false;reopened.review();assertEquals(1,x.signs);reopened.sign();assertEquals(2,x.signs);assertEquals(listOf(0),x.store.read().operation!!.ordered!!.signingStarted);assertEquals(MiningOrderedFixtures.wires[0],x.store.read().operation!!.ordered!!.signed.single())
  val y=Fixture();val second=y.setup();y.key=MiningOrderedFixtures.continuation.childPreparation.idempotencyKey;y.loseContinue=true;assertNotNull(runCatching{second.continueOriginal()}.exceptionOrNull());val resumed=y.repo();resumed.open();resumed.continueOriginal();assertEquals(1,y.continues);assertNull(y.store.read().operation!!.ordered!!.continuation);Unit
 }
 @Test fun `known refusal requires lookup absence before distinct new key and explicit child consent`()=runBlocking {
  val x=Fixture();val r=x.setup();x.key=UUID.randomUUID().toString();val original=x.key;x.refuseContinue=true;assertNotNull(runCatching{r.continueOriginal()}.exceptionOrNull());x.refuseContinue=false;x.key=MiningOrderedFixtures.continuation.childPreparation.idempotencyKey;r.continueOriginal();assertEquals(original,x.store.read().operation!!.ordered!!.previousContinuations.single().key);assertEquals(MiningOrderedFixtures.p.claimId,x.store.read().operation!!.preparation!!.claimId);r.useContinuation();assertEquals(MiningOrderedFixtures.continuation.childClaimId,x.store.read().operation!!.preparation!!.claimId);assertEquals(1,x.store.read().archives.size);assertEquals(1,x.signs);Unit
 }
 @Test fun `held original with saved continuation cannot activate through repository or direct journal transition`()=runBlocking {
  val x=Fixture();val r=x.setup();x.key=MiningOrderedFixtures.continuation.childPreparation.idempotencyKey;r.continueOriginal();val p=MiningOrderedFixtures.p
  val paid=Json.encodeToJsonElement(MiningClaimView.serializer(),MiningOrderedFixtures.claim(setup=true,paid=true)).jsonObject;x.store.observeOrderedClaim(p.idempotencyKey,JsonObject(paid+("settledBaseUnits" to JsonPrimitive("-1"))))
  assertNotNull(runCatching{x.store.useContinuation(x.store.read())}.exceptionOrNull());assertNotNull(runCatching{r.useContinuation()}.exceptionOrNull());assertEquals(p.claimId,x.store.read().operation!!.preparation!!.claimId);assertTrue(x.store.read().operation!!.ordered!!.held);assertEquals(0,x.store.read().archives.size);Unit
 }

}
