package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.mining.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MiningOrderedAppPortsTest {
 private val f=MiningOrderedFixtures
 private fun catalogue(limit:JsonElement=JsonPrimitive(200000))=buildJsonObject{putJsonObject("constants"){putJsonObject("TOKEN"){put("decimals",9)};putJsonObject("PHASE_E_MINING_CLAIM_QUOTE"){put("version",1);put("ttlSec",120)}};putJsonObject("mining"){putJsonObject("claimFormat"){put("version",1);put("computeUnitLimit",limit)}}}
 private class Fixture {
  val f=MiningOrderedFixtures;val holder=testHolder();val session=signedIn(holder,f.p.wallet);val memory=MemoryStore();val identity=StarterIdentity(session.origin.trimEnd('/'),"devnet",f.p.wallet);val store=MiningClaimsStore(memory,identity);val gate=MiningClaimsRpcGate();var page=MiningClaimsLifecycle(true,true,1,true,true,"content",false);var value=Json.encodeToJsonElement(MiningClaimView.serializer(),f.claim()).jsonObject;var after:()->Unit={};val paths=mutableListOf<String>();var lastBody:JsonObject?=null
  init{store.begin(store.read(),f.p.idempotencyKey,f.policy,"ordered-v0");store.prepareAttempt(store.read());store.acceptPreparation(f.p.idempotencyKey,f.p);store.acceptClaim(f.p.idempotencyKey,f.claim())}
  val api=object:ApiClient by FakeApiClient(){
   override suspend fun getMiningClaim(path:String,guard:()->Unit,evidence:((JsonObject)->Unit)?):JsonObject{guard();paths+=path;after();evidence?.invoke(value);guard();return value}
   override suspend fun postMiningClaim(path:String,body:JsonObject,guard:()->Unit,evidence:((JsonObject)->Unit)?,refusal:((ApiException)->Unit)?):JsonObject{guard();paths+=path;lastBody=body;after();evidence?.invoke(value);guard();return value}
  }
  fun ports()=MiningClaimsAppPorts(session,holder,api,store,{MiningOrderedAppPortsTest().catalogue()},{f.pins},{page},object:MiningClaimsRpcReads{override suspend fun genesisHash()=f.p.identity.genesisHash;override suspend fun finalizedBlockHeight()=100L},gate,{_,_,_->error("No wallet expected")},{0L})
 }
 @Test fun `ordered compute policy comes only from installed numeric catalogue and is optional for legacy`() {
  assertEquals(f.policy,miningClaimsPolicy(catalogue()));for(bad in listOf(JsonPrimitive("200000"),JsonPrimitive(0),JsonPrimitive(-1),JsonNull))assertNull(miningClaimsPolicy(catalogue(bad)))
  assertEquals(f.policy.copy(orderedComputeUnitLimit=null),miningClaimsPolicy(JsonObject(catalogue()-"mining")))
 }
 @Test fun `owned malformed terminal latches before parse and survives restart stale response until matching terminal`()=runBlocking {
  val x=Fixture();try{val ports=x.ports();val paid=Json.encodeToJsonElement(MiningClaimView.serializer(),f.claim(setup=true,paid=true)).jsonObject;x.value=JsonObject(paid+("settledBaseUnits" to JsonPrimitive("-1")))
   assertNotNull(runCatching{ports.claim(f.p.claimId,ports.capture(false)){x.store.acceptClaim(f.p.idempotencyKey,it)}}.exceptionOrNull());assertTrue(MiningClaimsStore(x.memory,x.identity).read().operation!!.ordered!!.held)
   x.value=Json.encodeToJsonElement(MiningClaimView.serializer(),f.claim()).jsonObject;assertNotNull(runCatching{ports.claim(f.p.claimId,ports.capture(false)){x.store.acceptClaim(f.p.idempotencyKey,it)}}.exceptionOrNull());assertTrue(x.store.read().operation!!.ordered!!.held)
   x.value=paid;ports.claim(f.p.claimId,ports.capture(false)){x.store.acceptClaim(f.p.idempotencyKey,it)}.also{x.store.acceptClaim(f.p.idempotencyKey,it)};assertFalse(x.store.read().operation!!.ordered!!.held);assertEquals("8",x.store.read().operation!!.claim!!.settledBaseUnits)
   val before=x.store.read();x.value=JsonObject(paid+("wallet" to JsonPrimitive("11111111111111111111111111111111")));assertNotNull(runCatching{ports.claim(f.p.claimId,ports.capture(false)){}}.exceptionOrNull());assertEquals(before,x.store.read())
  }finally{x.gate.close()};Unit
 }
 @Test fun `adapter binds ordinal and original continuation key and retains a late owned child before session guard`()=runBlocking {
  val x=Fixture();try{val ports=x.ports();x.value=Json.encodeToJsonElement(MiningClaimOrdinalReview.serializer(),f.reviews[0]).jsonObject;assertEquals(f.reviews[0],ports.reviewOrdinal(f.p.claimId,0,ports.capture(true)));assertEquals("/claims/mining/${f.p.claimId}/review?ordinal=0",x.paths.single())
   assertNotNull(runCatching{ports.reviewOrdinal(f.p.claimId,1,ports.capture(true))}.exceptionOrNull())
   x.store.acceptClaim(f.p.idempotencyKey,f.claim(setup=true));x.store.continuationAttempt(x.store.read(),f.continuation.childPreparation.idempotencyKey);x.value=Json.encodeToJsonElement(MiningClaimContinuationEnvelope.serializer(),f.envelope()).jsonObject
   x.after={x.page=x.page.copy(viewEpoch=2)};val guard=ports.capture(true);assertNotNull(runCatching{ports.continueClaim(f.p.claimId,f.continuation.childPreparation.idempotencyKey,guard,{x.store.acceptContinuation(f.p.idempotencyKey,it)},{})}.exceptionOrNull())
   assertEquals(f.continuation,x.store.read().operation!!.ordered!!.continuation);assertEquals("/claims/mining/${f.p.claimId}/continue",x.paths.last());assertEquals(buildJsonObject{put("idempotencyKey",f.continuation.childPreparation.idempotencyKey)},x.lastBody)
  }finally{x.gate.close()};Unit
 }
 @Test fun `fresh authenticated terminal custody can archive verified single claim without stale revision or new providers`()=runBlocking {
  val p=f.continuation.childPreparation;val holder=testHolder();val session=signedIn(holder,p.wallet);val memory=MemoryStore();val store=MiningClaimsStore(memory,StarterIdentity(session.origin.trimEnd('/'),"devnet",p.wallet));val gate=MiningClaimsRpcGate()
  val landed=f.claim(setup=true,failed=true).transactions.last().copy(ordinal=0);val failed=MiningClaimView(1,p.wallet,p.claimId,"failed","failed",landed.signature,null,listOf(landed),p.serverNow,false).also{it.validate()}
  store.begin(store.read(),p.idempotencyKey,f.policy,"ordered-v0");store.prepareAttempt(store.read());store.acceptPreparation(p.idempotencyKey,p);store.acceptClaim(p.idempotencyKey,failed);var gets=0
  val api=object:ApiClient by FakeApiClient(){override suspend fun getMiningClaim(path:String,guard:()->Unit,evidence:((JsonObject)->Unit)?):JsonObject{assertEquals("/claims/mining/${p.claimId}",path);guard();gets++;val value=Json.encodeToJsonElement(MiningClaimView.serializer(),failed).jsonObject;evidence?.invoke(value);guard();return value}}
  try{val ports=MiningClaimsAppPorts(session,holder,api,store,{null},{null},{MiningClaimsLifecycle(true,true,1,false,false,null,true)},object:MiningClaimsRpcReads{override suspend fun genesisHash():String=error("No RPC expected");override suspend fun finalizedBlockHeight():Long=error("No RPC expected")},gate,{_,_,_->error("No wallet expected")},{0L})
   MiningClaimsRepository(store,ports).archiveFailed();assertEquals(1,gets);assertNull(store.read().operation);assertEquals(failed,store.read().archives.single().claim);assertNull(store.read().archives.single().claim!!.settledBaseUnits)
  }finally{gate.close()};Unit
 }

}
