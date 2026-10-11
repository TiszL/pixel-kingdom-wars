package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.migration.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class MigrationRepositoryTest {
 private val f=MigrationFixtures
 private class Fixture {
  val f=MigrationFixtures;val memory=CharterFixtures.Memory();val identity=f.identity();val store=MigrationStore(memory,identity);var current=true;var configured=true;var generation=0
  var remote:JsonObject?=null;var loseCreate=false;var loseBeforePrepare=false;var late=false;var noWalletReply=false;var failHydrate=false;var loseDelivery=false;var prompts=0;val calls=mutableListOf<String>()
  val port=object:MigrationPort{
   override val identity=this@Fixture.identity
   override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonElement)->Unit):JsonElement{
    guard();calls+="$method $path"
    if(path.endsWith("/activity")){val result=f.activity();retain(result);guard();return result}
    if(method=="POST"){
     val saved=store.record(f.key);assertTrue(saved.attempts.isNotEmpty())
     if(path.endsWith("/prepare")&&loseBeforePrepare){loseBeforePrepare=false;error("Lost before candidate persistence")}
     if(path.endsWith("/deliver")&&loseDelivery){loseDelivery=false;error("Send accepted but reply lost")}
     remote=when(path.substringAfterLast('/')){"migrations"->f.status("pending");"prepare","recover-preparation"->f.prepared;"signed"->{assertEquals(f.wire.charterText("signedTransaction"),body!!.charterText("signedTransaction"));f.status("signed")};"recover"->f.status("controlled");"cancel"->f.status("cancelled");else->requireNotNull(remote)}
     if(path.endsWith("/migrations")&&loseCreate)error("Lost create reply")
    }
    val result=if("/by-key/" in path)buildJsonObject{put("version",1);put("actor",f.actor);put("idempotencyKey",f.key);put("migration",remote?:JsonNull)} else requireNotNull(remote)
    retain(result);guard();return result
   }
  }
  val ports=object:MigrationPorts{
   override val transport=MigrationTransport(port)
   override fun capture(newAction:Boolean):()->Unit{val before=generation;return {check(current);if(newAction)check(configured&&generation==before)}}
   override fun trust()=if(configured)f.pins else null
   override fun cryptoPolicy()=f.crypto
   override fun key()=f.key
   override fun validate(migration:JsonObject){MigrationProtocol.migration(migration)}
   override suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit):()->Unit=guard
   override suspend fun ready(guard:()->Unit)=guard()
   override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend(SignedCharter)->Unit){guard();prompts++;assertTrue("wallet" in store.record(f.key).attempts);if(noWalletReply)error("Unknown wallet reply");val checked=prepared.verifySigned(f.bytes);if(late)generation++;retain(checked);guard()}
   override suspend fun hydrate(guard:()->Unit){guard();check(!failHydrate){"Current clan refresh failed"}}
  }
  fun repository()=MigrationRepository(store,ports)
  suspend fun prepared():MigrationRepository{val r=repository();r.open();r.begin(f.clan);r.command("prepare");return r}
 }
 @Test fun `actual HTTP packet survives snapshot sign-only delivery and paused terminal restart`()=runBlocking {
  val x=Fixture();val r=x.prepared();r.review();r.approve();assertEquals(1,x.prompts);assertEquals(f.wire,x.store.record(f.key).signed);r.upload();r.deliver();r.command("recover");assertTrue(x.store.record(f.key).terminal)
  x.configured=false;x.failHydrate=true;val before=x.calls.size;val reopened=x.repository();reopened.open();assertTrue(reopened.state.value.record!!.terminal);assertNotNull(reopened.state.value.error);assertEquals(before,x.calls.size);assertEquals(f.prepared.getValue("snapshot"),reopened.state.value.record!!.response!!.getValue("snapshot"));Unit
 }
 @Test fun `lost initial response uses original key lookup with no replacement POST`()=runBlocking {
  val x=Fixture();x.loseCreate=true;val r=x.repository();r.open();assertNotNull(runCatching{r.begin(f.clan)}.exceptionOrNull());assertNull(x.store.record(f.key).response)
  val reopened=x.repository();reopened.open();reopened.check();assertEquals(f.status("pending"),x.store.record(f.key).response);assertEquals(1,x.calls.count{it.startsWith("POST")});assertTrue(x.calls.last().contains("/by-key/"));Unit
 }
 @Test fun `failed initial persistence prevents creation effect and wallet marker precedes prompt`()=runBlocking {
  val x=Fixture();val r=x.repository();r.open();x.memory.fail=true;assertNotNull(runCatching{r.begin(f.clan)}.exceptionOrNull());assertTrue(x.calls.none{it.startsWith("POST")});assertEquals(0,x.prompts);Unit
 }
 @Test fun `late wallet bytes drain before changed base guard and never permit reapproval`()=runBlocking {
  val x=Fixture();val r=x.prepared();r.review();x.late=true;assertNotNull(runCatching{r.approve()}.exceptionOrNull());assertEquals(f.wire,MigrationStore(x.memory,x.identity).record(f.key).signed);assertEquals(1,x.prompts)
  val reopened=x.repository();reopened.open();assertNotNull(runCatching{reopened.review()}.exceptionOrNull());assertEquals(1,x.prompts);Unit
 }
 @Test fun `unknown wallet outcome persists through restart without a second prompt`()=runBlocking {
  val x=Fixture();val r=x.prepared();r.review();x.noWalletReply=true;assertNotNull(runCatching{r.approve()}.exceptionOrNull());val reopened=x.repository();reopened.open();assertNotNull(runCatching{reopened.review()}.exceptionOrNull());assertEquals(1,x.prompts);assertTrue("wallet" in x.store.record(f.key).attempts);Unit
 }
 @Test fun `fresh review requires hydration while providerless original lookup still works`()=runBlocking {
  val x=Fixture();x.prepared();x.failHydrate=true;val r=x.repository();r.open();assertNotNull(runCatching{r.review()}.exceptionOrNull());assertEquals(0,x.prompts);x.configured=false;val reopened=x.repository();reopened.open();reopened.check();assertEquals(f.prepared,reopened.state.value.record!!.response);assertNotNull(reopened.state.value.error);Unit
 }
 @Test fun `owned damaged terminal survives direct transport restart and stale reply until real terminal`()=runBlocking {
  val x=Fixture();val r=x.prepared();val final=f.status("controlled");val bad=JsonObject(final+("snapshot" to JsonNull));x.remote=bad
  assertNotNull(runCatching{r.check()}.exceptionOrNull());assertEquals(bad,x.store.record(f.key).observations.last());val reopened=x.repository();reopened.open();assertTrue(reopened.state.value.record!!.held)
  x.remote=f.prepared;assertNotNull(runCatching{reopened.check()}.exceptionOrNull());assertTrue(x.store.record(f.key).held);assertNotNull(runCatching{reopened.review()}.exceptionOrNull());assertEquals(0,x.prompts)
  reopened.command("recover");assertTrue(x.store.record(f.key).terminal);assertFalse(x.store.record(f.key).held);Unit
 }
 @Test fun `by key custody excludes foreign original before retaining damaged terminal`()=runBlocking {
  val x=Fixture();x.loseCreate=true;val r=x.repository();r.open();assertNotNull(runCatching{r.begin(f.clan)}.exceptionOrNull())
  val final=f.status("controlled");val bad=JsonObject(final+("snapshot" to JsonNull));x.remote=JsonObject(bad+("request" to buildJsonObject{put("clanId","cccccccc-cccc-4ccc-8ccc-cccccccccccc");put("idempotencyKey",f.key)}))
  assertNotNull(runCatching{r.check()}.exceptionOrNull());assertTrue(x.store.record(f.key).observations.isEmpty());assertFalse(x.store.record(f.key).held)
  x.remote=bad;assertNotNull(runCatching{r.check()}.exceptionOrNull());val reopened=x.repository();reopened.open();assertTrue(reopened.state.value.record!!.held);x.remote=f.prepared;assertNotNull(runCatching{reopened.check()}.exceptionOrNull());reopened.command("recover");assertTrue(x.store.record(f.key).terminal);assertFalse(x.store.record(f.key).held);assertEquals(1,x.calls.count{it=="POST /clans/charter/migrations"});Unit
 }
 @Test fun `prepare retry observes same pending original and existing candidate uses lookup only`()=runBlocking {
  val x=Fixture();val r=x.repository();r.open();r.begin(f.clan);x.loseBeforePrepare=true;assertNotNull(runCatching{r.command("prepare")}.exceptionOrNull());val reopened=x.repository();reopened.open();reopened.command("prepare");assertEquals("prepared",x.store.record(f.key).response!!.charterText("status"));assertEquals(2,x.calls.count{it.endsWith("/prepare")});reopened.command("prepare");assertEquals(2,x.calls.count{it.endsWith("/prepare")})
  val y=Fixture();val second=y.repository();second.open();second.begin(f.clan);y.remote=f.status("issuing");second.command("prepare");assertEquals(0,y.calls.count{it.endsWith("/prepare")});second.command("recover-preparation");assertEquals(f.prepared,y.store.record(f.key).response);assertEquals(0,y.prompts);Unit
 }
 @Test fun `unknown delivery survives restart and outcome check never resends or approves`()=runBlocking {
  val x=Fixture();val r=x.prepared();r.review();r.approve();r.upload();x.loseDelivery=true;assertNotNull(runCatching{r.deliver()}.exceptionOrNull());val reopened=x.repository();reopened.open();reopened.check();assertEquals(f.wire,x.store.record(f.key).signed);reopened.command("recover");assertEquals(1,x.calls.count{it.endsWith("/deliver")});assertEquals(1,x.prompts);Unit
 }
 @Test fun `remote history imports original terminal without current leader or signing provider`()=runBlocking {
  val x=Fixture();x.configured=false;x.remote=f.status("controlled");val r=x.repository();r.open();r.selectRemote(f.id);assertEquals(f.key,r.state.value.selected);assertTrue(r.state.value.record!!.terminal);assertEquals(0,x.prompts);assertTrue(x.calls.all{it.startsWith("GET")});Unit
 }
}
