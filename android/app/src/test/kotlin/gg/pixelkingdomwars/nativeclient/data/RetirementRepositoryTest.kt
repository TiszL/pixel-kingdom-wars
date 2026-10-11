package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.retirement.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class RetirementRepositoryTest {
 private val f=RetirementFixtures
 private class Fixture {
  val f=RetirementFixtures;val memory=CharterFixtures.Memory();val identity=f.identity();val store=RetirementStore(memory,identity);var current=true;var configured=true;var generation=0
  var remote:JsonObject?=null;var loseCreate=false;var interruptAfterPayout=false;var loseBeforePrepare=false;var late=false;var noWalletReply=false;var failHydrate=false;var prompts=0;val calls=mutableListOf<String>()
  val port=object:RetirementPort{
   override val identity=this@Fixture.identity
   override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonElement)->Unit):JsonElement{
    guard();calls+="$method $path"
    if(method=="POST"){
     val saved=store.record(f.key);assertTrue(saved.attempts.isNotEmpty())
     if(path.endsWith("/prepare")&&loseBeforePrepare){loseBeforePrepare=false;error("Lost before candidate persistence")}
     if(path.endsWith("/pay-members")&&interruptAfterPayout){interruptAfterPayout=false;remote=JsonObject(f.draft+("operation" to JsonNull));error("Crashed after payout before retirement creation")}
     remote=when(path.substringAfterLast('/')){"retirements"->f.unpaid();"pay-members"->f.status("cleared");"prepare"->f.draft;"signed"->{assertEquals(java.util.Base64.getEncoder().encodeToString(f.bytes),body!!.charterText("signedTransaction"));f.status("signed")};"recover"->f.status("completed");else->requireNotNull(remote)}
     if(path.endsWith("/retirements")&&loseCreate)error("Lost create reply")
    }
    val result=if("/by-key/" in path)buildJsonObject{put("version",1);put("actor",f.actor);put("idempotencyKey",f.key);put("draft",remote?:JsonNull)} else requireNotNull(remote)
    retain(result);guard();return result
   }
  }
  val ports=object:RetirementPorts{
   override val transport=RetirementTransport(port)
   override fun capture(newAction:Boolean):()->Unit{val before=generation;return {check(current);if(newAction)check(configured&&generation==before)}}
   override fun trust()=if(configured)f.pins else null
   override fun cryptoPolicy()=f.crypto
   override fun key()=f.key
   override fun validate(draft:JsonObject){RetirementProtocol.draft(draft)}
   override suspend fun live(prepared:PreparedCharter,operation:JsonObject,guard:()->Unit):()->Unit=guard
   override suspend fun ready(guard:()->Unit)=guard()
   override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend(SignedCharter)->Unit){guard();prompts++;assertTrue("wallet" in store.record(f.key).attempts);if(noWalletReply)error("Unknown wallet reply");val checked=prepared.verifySigned(f.bytes);if(late)generation++;retain(checked);guard()}
   override suspend fun hydrate(guard:()->Unit){guard();check(!failHydrate){"Current kingdom refresh failed"}}
  }
  fun repository()=RetirementRepository(store,ports)
  suspend fun prepared():RetirementRepository{val r=repository();r.open();r.begin(f.clan);r.command("pay-members");r.command("prepare");return r}
 }
 @Test fun `ordinary freeze payout exact approval delivery and terminal survive restart`()=runBlocking {
  val x=Fixture();val r=x.prepared();r.review();r.approve();assertEquals(1,x.prompts);assertEquals(f.wire(),x.store.record(f.key).signed);r.upload();r.deliver();r.command("recover");assertTrue(x.store.record(f.key).terminal)
  x.configured=false;x.failHydrate=true;val before=x.calls.size;val reopened=x.repository();reopened.open();assertTrue(reopened.state.value.record!!.terminal);assertNotNull(reopened.state.value.error);assertEquals(before,x.calls.size);Unit
 }
 @Test fun `lost draft response uses by key without a replacement POST`()=runBlocking {
  val x=Fixture();x.loseCreate=true;val r=x.repository();r.open();assertNotNull(runCatching{r.begin(f.clan)}.exceptionOrNull());assertNull(x.store.record(f.key).response)
  val reopen=x.repository();reopen.open();reopen.check();assertEquals(f.unpaid(),x.store.record(f.key).response);assertEquals(1,x.calls.count{it.startsWith("POST")});assertTrue(x.calls.last().contains("/by-key/"));Unit
 }
 @Test fun `failed persistence prevents first network effect`()=runBlocking {
  val x=Fixture();val r=x.repository();r.open();x.memory.fail=true;assertNotNull(runCatching{r.begin(f.clan)}.exceptionOrNull());assertTrue(x.calls.isEmpty());Unit
 }
 @Test fun `late wallet callback is saved before stale base selection can publish`()=runBlocking {
  val x=Fixture();val r=x.prepared();r.review();x.late=true;assertNotNull(runCatching{r.approve()}.exceptionOrNull());assertEquals(f.wire(),RetirementStore(x.memory,x.identity).record(f.key).signed);assertEquals(1,x.prompts);val reopen=x.repository();reopen.open();assertNotNull(runCatching{reopen.review()}.exceptionOrNull());assertEquals(1,x.prompts);Unit
 }
 @Test fun `unknown wallet result blocks another approval through restart`()=runBlocking {
  val x=Fixture();val r=x.prepared();r.review();x.noWalletReply=true;assertNotNull(runCatching{r.approve()}.exceptionOrNull());val reopen=x.repository();reopen.open();assertNotNull(runCatching{reopen.review()}.exceptionOrNull());assertEquals(1,x.prompts);assertTrue("wallet" in x.store.record(f.key).attempts);Unit
 }
 @Test fun `fresh actions fail hydration while original checks remain reachable`()=runBlocking {
  val x=Fixture();x.prepared();x.failHydrate=true;val r=x.repository();r.open();assertNotNull("Restart hydration must fail closed for fresh effects",runCatching{r.review()}.exceptionOrNull());assertEquals(0,x.prompts);x.configured=false;val reopen=x.repository();reopen.open();reopen.check();assertEquals(f.draft,reopen.state.value.record!!.response);assertNotNull(reopen.state.value.error);Unit
 }
 @Test fun `owned malformed finality stays held through transport restart and stale nonterminal response`()=runBlocking {
  val x=Fixture();val r=x.prepared();val final=f.status("completed");val bad=JsonObject(final+("totalShards" to JsonPrimitive("-1")));x.remote=bad
  assertNotNull(runCatching{r.check()}.exceptionOrNull());assertEquals(bad,x.store.record(f.key).observations.last())
  val reopened=x.repository();reopened.open();assertTrue(reopened.state.value.record!!.held);x.remote=f.draft
  assertNotNull(runCatching{reopened.check()}.exceptionOrNull());assertTrue(x.store.record(f.key).held);assertNotNull(runCatching{reopened.review()}.exceptionOrNull());assertEquals(0,x.prompts)
  x.remote=final;reopened.check();assertTrue(x.store.record(f.key).terminal);assertFalse(x.store.record(f.key).held);Unit
 }
 @Test fun `by key damaged terminal custody binds original clan before surviving restart`()=runBlocking {
  val x=Fixture();x.loseCreate=true;val r=x.repository();r.open();assertNotNull(runCatching{r.begin(f.clan)}.exceptionOrNull())
  val final=f.status("completed");val bad=JsonObject(final+("totalShards" to JsonPrimitive("-1")))
  x.remote=JsonObject(bad+("request" to buildJsonObject{put("clanId","cccccccc-cccc-4ccc-8ccc-cccccccccccc");put("idempotencyKey",f.key)}))
  assertNotNull(runCatching{r.check()}.exceptionOrNull());assertTrue(x.store.record(f.key).observations.isEmpty());assertFalse(x.store.record(f.key).held)
  x.remote=bad;assertNotNull(runCatching{r.check()}.exceptionOrNull());val reopened=x.repository();reopened.open();assertTrue(reopened.state.value.record!!.held)
  x.remote=f.draft;assertNotNull(runCatching{reopened.check()}.exceptionOrNull());assertTrue(x.store.record(f.key).held)
  x.remote=final;reopened.check();assertTrue(x.store.record(f.key).terminal);assertFalse(x.store.record(f.key).held);assertEquals(1,x.calls.count{it=="POST /clans/charter/retirements"});Unit
 }
 @Test fun `interrupted paid draft resumes the same idempotent payout without a replacement draft`()=runBlocking {
  val x=Fixture();val r=x.repository();r.open();r.begin(f.clan);x.interruptAfterPayout=true;assertNotNull(runCatching{r.command("pay-members")}.exceptionOrNull())
  val paid=requireNotNull(x.remote).charterObject("memberPayment");val reopened=x.repository();reopened.open();reopened.check();assertNull(x.store.record(f.key).operation);assertEquals(paid,x.store.record(f.key).response!!.charterObject("memberPayment"))
  reopened.command("pay-members");assertEquals("cleared",x.store.record(f.key).operation!!.charterText("status"));assertEquals(paid,x.store.record(f.key).response!!.charterObject("memberPayment"));assertEquals(2,x.calls.count{it.endsWith("/pay-members")});assertEquals(1,x.calls.count{it=="POST /clans/charter/retirements"});assertEquals(0,x.prompts);Unit
 }
 @Test fun `prepare failure before candidate persistence retries only the still cleared original`()=runBlocking {
  val x=Fixture();val r=x.repository();r.open();r.begin(f.clan);r.command("pay-members");x.loseBeforePrepare=true;assertNotNull(runCatching{r.command("prepare")}.exceptionOrNull())
  val reopened=x.repository();reopened.open();reopened.command("prepare");assertEquals("prepared",x.store.record(f.key).operation!!.charterText("status"));assertEquals(2,x.calls.count{it.endsWith("/prepare")})
  reopened.command("prepare");assertEquals("prepared",x.store.record(f.key).operation!!.charterText("status"));assertEquals(2,x.calls.count{it.endsWith("/prepare")});assertEquals(0,x.prompts);Unit
 }
}
