package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
class VehicleRepositoryTest {
 private val f=VehicleFixtures
 private inner class Fixture {
  val memory=VehicleFixtures.Memory();val store=VehicleStore(memory,f.identity());var allowed=true;var owned=true;var configured=true;var current=f.client;var currentPolicy=f.policy;var failPost=false;var failCollect=false;var staleAfterSign=false;var failLive=false;var signSetupFails=false;var signInvocationFails=false;var approvals=0;var hydrates=0;var posts=0;var nextKey=f.request.charterText("idempotencyKey")
  var active=true;var hydrationError:Exception?=null;var onHydrate:()->Unit={};val calls=mutableListOf<Pair<String,String>>()
  val ports=object:VehiclePorts {
   override val transport=VehicleTransport(object:VehiclePort{override val identity=store.identity;override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
    guard();calls+=method to path;val raw=when{path=="/advanced-expeditions/collect"->(if(failCollect)throw IOException("lost collect reply") else buildJsonObject{put("baseId",f.base);put("serverNow","2035-01-01T00:00:00.000Z");put("returned",0)});path=="/vehicles/fleet"->buildJsonObject{put("version",1);put("wallet",f.wallet);put("baseId",f.base);put("serverNow","2035-01-01T00:00:00.000Z");put("acceptingNewActions",false);put("vehicles",JsonArray(emptyList()))};path=="/vehicles/client/routes"->buildJsonObject{put("version",1);put("wallet",f.wallet);put("baseId",f.base);put("items",JsonArray(emptyList()))};path.endsWith("/activity")->buildJsonObject{put("version",1);put("wallet",f.wallet);put("items",JsonArray(emptyList()));put("nextCursor",JsonNull)};path.endsWith("/review")->f.review(current);method=="GET"->current;else->{posts++;val r=store.read().records.single();assertTrue(r.attempts.isNotEmpty());if(path.endsWith("/signed"))current=f.signed();if(failPost)throw IOException("reply lost");current}}
    retain(raw);guard();return raw
   }})
   override fun capture(fresh:Boolean):()->Unit {val g={check(active);if(fresh)check(allowed)};g();return g};override fun policy()=currentPolicy;override fun trust()=if(configured)f.pins else null;override fun key()=nextKey;override fun now()=0L;override fun requireOwnedBase(base:String){check(owned&&base==f.base)}
   override suspend fun live(client:JsonObject,prepared:PreparedVehicle,pins:VehicleSigningTrust,policy:VehiclePolicy,networkFeeLamports:String,guard:()->Unit):()->Unit{check(!failLive);return guard}
   override suspend fun ready(guard:()->Unit)=guard()
   override suspend fun sign(prepared:PreparedVehicle,guard:()->Unit,beforeWallet:suspend ()->Unit,retain:suspend(JsonObject)->Unit){if(signSetupFails)throw IOException("signer setup failed");beforeWallet();guard();val r=store.read().records.single();assertTrue("wallet" in r.attempts);approvals++;if(signInvocationFails)throw IOException("wallet outcome uncertain");if(staleAfterSign)allowed=false;retain(prepared.verifyWire(f.wire));guard()}
   override suspend fun hydrate(guard:()->Unit){guard();onHydrate();hydrationError?.let{throw it};guard();hydrates++}
  }
  fun repo()=VehicleRepository(store,ports)
 }
 private fun rejects(block:suspend ()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 @Test fun `lost reservation is recovered after ownership transfer without another POST`()=runBlocking {
  val x=Fixture();x.current=f.reserved();x.failPost=true;val first=x.repo();rejects{first.reserve(f.base,f.berth,f.request.charterText("assetId"))};val r=x.store.read().records.single();assertNull(r.response);x.owned=false;x.failPost=false
  val cold=x.repo();cold.retry(r.id);assertEquals(x.current,x.store.record(r.id).response);assertEquals(1,x.posts);Unit
 }
 @Test fun `original consent can sign after base sale with one durable wallet marker and exact wire`()=runBlocking {
  val x=Fixture();val r=x.store.adopt(f.client,f.policy);x.owned=false;val repo=x.repo();repo.select(r.id);repo.review();repo.approve();assertEquals(f.wire,x.store.record(r.id).signed);assertEquals(1,x.approvals);rejects{repo.approve()};Unit
 }
 @Test fun `failed signer setup preserves unmarked original for later explicit review and approval`()=runBlocking {
  val x=Fixture();val r=x.store.adopt(f.client,f.policy);val repo=x.repo();repo.select(r.id);repo.review();x.signSetupFails=true;rejects{repo.approve()};assertFalse("wallet" in x.store.record(r.id).attempts);assertNull(x.store.record(r.id).signed);x.signSetupFails=false;repo.review();repo.approve();assertEquals(1,x.approvals);assertEquals(f.wire,x.store.record(r.id).signed);Unit
 }
 @Test fun `invoked wallet failure keeps durable uncertainty and forbids a fresh review`()=runBlocking {
  val x=Fixture();val r=x.store.adopt(f.client,f.policy);val repo=x.repo();repo.select(r.id);repo.review();x.signInvocationFails=true;rejects{repo.approve()};assertTrue("wallet" in x.store.record(r.id).attempts);assertNull(x.store.record(r.id).signed);x.signInvocationFails=false;rejects{repo.review()};assertEquals(1,x.approvals);Unit
 }
 @Test fun `late wallet signature is retained before changed view refusal`()=runBlocking {
  val x=Fixture();val r=x.store.adopt(f.client,f.policy);val repo=x.repo();repo.select(r.id);repo.review();x.staleAfterSign=true;rejects{repo.approve()};assertEquals(f.wire,x.store.record(r.id).signed);assertEquals(1,x.approvals);Unit
 }
 @Test fun `API ready cannot bypass independent live hold or default absent trust`()=runBlocking {
  for(missing in listOf(false,true)){val x=Fixture();val r=x.store.adopt(f.client,f.policy);val repo=x.repo();repo.select(r.id);x.configured=!missing;x.failLive=!missing;rejects{repo.review()};assertEquals(0,x.approvals);assertTrue(x.store.record(r.id).attempts.isEmpty())};Unit
 }
 @Test fun `saved signed wire can upload while fresh actions paused and cannot be replaced`()=runBlocking {
  val x=Fixture();val r=x.store.adopt(f.client,f.policy);val repo=x.repo();repo.select(r.id);repo.review();repo.approve();x.allowed=false;x.configured=false;repo.upload();assertEquals(f.wire,x.store.record(r.id).signed);assertEquals("signed",x.store.record(r.id).response!!.charterObject("record").charterText("status"));assertEquals(1,x.posts);Unit
 }
 @Test fun `completed expedition collection remains available while new actions are paused`()=runBlocking {val x=Fixture();x.nextKey=java.util.UUID.randomUUID().toString();x.allowed=false;x.configured=false;val repo=x.repo();repo.collect(f.base);assertEquals("collect",x.store.read().records.single().kind);assertNotNull(x.store.read().records.single().response);Unit}
 @Test fun `lost collection response can retry the same base while fresh actions stay paused`()=runBlocking {val x=Fixture();x.nextKey=java.util.UUID.randomUUID().toString();x.allowed=false;x.configured=false;x.failCollect=true;val repo=x.repo();rejects{repo.collect(f.base)};val r=x.store.read().records.single();assertNull(r.response);x.failCollect=false;repo.retry(r.id);assertNotNull(x.store.record(r.id).response);assertEquals(2,x.store.record(r.id).attempts.count{it.startsWith("post:")});Unit}
 @Test fun `terminal original refresh hydrates once and remains readable without trust`()=runBlocking {
  val x=Fixture();x.current=f.terminal();val r=x.store.adopt(x.current,f.policy);x.allowed=false;x.configured=false;val repo=x.repo();repo.open();repo.select(r.id);repo.check();assertEquals(1,x.hydrates);assertEquals(x.current,repo.state.value.selected!!.response);Unit
 }
 @Test fun `new ordinary route catalogue cannot invalidate an unchanged saved burn policy`()=runBlocking {
  val x=Fixture();val r=x.store.adopt(f.client,f.policy)
  val routes=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-route-vectors.json")).readText()).jsonObject.charterObject("constants").getValue("ordinaryRoutes")
  x.currentPolicy=VehiclePolicy.from(JsonObject(f.policy.raw+("ordinaryRoutes" to routes)))
  val repo=x.repo();repo.select(r.id);repo.review();repo.approve();assertEquals(f.wire,x.store.record(r.id).signed);assertEquals(1,x.approvals);Unit
 }
 @Test fun `changed fee policy still holds old burn after ordinary route compatibility change`()=runBlocking {
  val x=Fixture();val r=x.store.adopt(f.client,f.policy)
  x.currentPolicy=VehiclePolicy.from(f.change(f.policy.raw,"client.maxNetworkFeeLamports",JsonPrimitive(f.policy.bound("maxNetworkFeeLamports")+1)))
  val repo=x.repo();repo.select(r.id);rejects{repo.review()};assertEquals(0,x.approvals);assertTrue(x.store.record(r.id).attempts.isEmpty());Unit
 }

 @Test fun `cold terminal vehicle history and original GET survive continued account refresh failure without new effects`()=runBlocking {
  val x=Fixture();x.current=f.terminal();val r=x.store.adopt(x.current,f.policy);val saved=x.store.read();x.allowed=false;x.configured=false;x.owned=false;x.hydrationError=IOException("hydration offline")
  val cold=x.repo();cold.open();assertEquals(saved,cold.state.value.journal);cold.select(r.id);cold.check()
  assertEquals(x.current,cold.state.value.selected!!.response);assertTrue(x.calls.any{it.first=="GET"&&it.second=="/vehicles/client/installations/"+VehicleProtocol.reference(x.current).charterText("id")})
  assertTrue(x.calls.all{it.first=="GET"});assertEquals(0,x.posts);assertEquals(0,x.approvals);assertEquals(0,x.hydrates);assertEquals(saved.records,x.store.read().records)
  assertNull(cold.state.value.assets);assertNull(cold.state.value.fleet);assertNull(cold.state.value.routes);assertNull(cold.state.value.review);assertTrue(cold.state.value.error!!.contains("Saved vehicle receipts"))
  x.hydrationError=null;cold.check();assertEquals(1,x.hydrates);assertNull(cold.state.value.error);cold.check();assertEquals(1,x.hydrates);Unit
 }
 @Test fun `vehicle recovery hydration fallback never admits fresh or mixed mutation actions`()=runBlocking {
  val x=Fixture();x.current=f.terminal();val r=x.store.adopt(x.current,f.policy);x.hydrationError=IOException("hydration offline");val repo=x.repo();repo.select(r.id);val saved=x.store.read();val calls=x.calls.toList()
  val actions:List<suspend()->Unit> = listOf({repo.reserve(f.base,f.berth,f.request.charterText("assetId"))},{repo.command("recover")},{repo.upload()},{repo.collect(f.base)},{repo.archive()},{repo.retry(r.id)})
  for(action in actions){val error=assertThrows(Exception::class.java){runBlocking{action()}};assertEquals("hydration offline",error.message)}
  assertEquals(saved,x.store.read());assertEquals(calls,x.calls);assertEquals(0,x.posts);assertEquals(0,x.approvals);Unit
 }
 @Test fun `vehicle read recovery propagates cancellation and stale hydration guards without marking current state refreshed`()=runBlocking {
  for(cancel in listOf(true,false)){
   val x=Fixture();x.current=f.terminal();val r=x.store.adopt(x.current,f.policy);val repo=x.repo()
   if(cancel)x.hydrationError=CancellationException("hydration cancelled") else x.onHydrate={x.active=false}
   val error=assertThrows(Exception::class.java){runBlocking{repo.select(r.id)}}
   if(cancel)assertTrue(error is CancellationException)
   assertFalse(repo.state.value.error.orEmpty().contains("Saved vehicle receipts"));assertEquals(0,x.hydrates);assertEquals(x.current,x.store.record(r.id).response)
   x.active=true;x.hydrationError=null;x.onHydrate={};repo.check();assertEquals(1,x.hydrates);assertTrue(x.calls.all{it.first=="GET"});assertEquals(0,x.approvals)
  };Unit
 }

 @Test fun `failed vehicle archive hydration clears current fleet without hiding or archiving its original`()=runBlocking {
  val x=Fixture();x.current=f.terminal();val r=x.store.adopt(x.current,f.policy);val repo=x.repo();repo.select(r.id);repo.fleet(f.base);assertNotNull(repo.state.value.fleet);assertNotNull(repo.state.value.routes)
  x.hydrationError=IOException("hydration offline");rejects{repo.archive()};assertNull(repo.state.value.assets);assertNull(repo.state.value.fleet);assertNull(repo.state.value.routes);assertNull(repo.state.value.review)
  assertEquals(r.id,x.store.read().pending.single().id);assertTrue(x.store.read().archives.isEmpty());assertEquals(x.current,repo.state.value.selected!!.response);assertTrue(x.calls.all{it.first=="GET"});val calls=x.calls.toList();rejects{repo.reserve(f.base,f.berth,f.request.charterText("assetId"))};assertEquals(calls,x.calls);Unit
 }

}
