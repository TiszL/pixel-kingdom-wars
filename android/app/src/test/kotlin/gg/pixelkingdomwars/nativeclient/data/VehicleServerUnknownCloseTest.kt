package gg.pixelkingdomwars.nativeclient.data
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
/** Owner rule 2026-10-06: no saved request may block play forever on this device. A pending, non-terminal vehicle original
 * blocks another expedition from its kingdom and another burn of its asset (VehicleStore.create). One the server has no
 * record of is archived only on its own by-key read in the closing action: expedition "unknown", or the installation/service
 * not-found code. A bare 404 is not evidence, a server answer that knows the key wins, and nothing is POSTed. */
class VehicleServerUnknownCloseTest {
 private val f=VehicleFixtures
 private fun rejects(block:suspend ()->Unit){assertThrows(Exception::class.java){runBlocking{block()}}}
 private fun expedition(key:String)=buildJsonObject{put("idempotencyKey",key);put("baseId",f.base);put("installationId",UUID.randomUUID().toString());put("routeId","forest_run");put("policyVersion",1)}
 private fun unknown(key:String)=buildJsonObject{put("wallet",f.wallet);put("idempotencyKey",key);put("serverNow","2035-01-01T00:00:00.000Z");put("status","unknown");put("receipt",JsonNull);put("return",JsonNull)}
 private inner class Fixture {
  val memory=VehicleFixtures.Memory();val store=VehicleStore(memory,f.identity())
  // known: the server holds the installation reservation. notFound: the code of its by-key 404 otherwise (null = a bare 404).
  // Every POST (a retry) is refused, so the saved original cannot be resent.
  var known=false;var notFound:String?=VehicleStore.unknownCode("installation");val calls=mutableListOf<Pair<String,String>>()
  fun repo()=VehicleRepository(store,object:VehiclePorts{
   override val transport=VehicleTransport(object:VehiclePort{override val identity=store.identity
    override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
     guard();calls+=method to path
     val raw=when{
      method=="POST"->throw ApiException(409,"REFUSED","The original request is refused")
      path.startsWith("/advanced-expeditions/by-key/")->unknown(path.substringAfterLast('/'))
      path.contains("/by-key/")->if(known)f.reserved() else throw ApiException(404,notFound,"Not found")
      else->error("Unexpected vehicle read $path")
     }
     retain(raw);guard();return raw
    }})
   override fun capture(fresh:Boolean):()->Unit={};override fun policy()=f.policy;override fun trust()=f.pins;override fun key()=UUID.randomUUID().toString();override fun now()=0L
   override fun requireOwnedBase(base:String){check(base==f.base)}
   override suspend fun live(client:JsonObject,prepared:PreparedVehicle,pins:VehicleSigningTrust,policy:VehiclePolicy,networkFeeLamports:String,guard:()->Unit):()->Unit{error("No live read in this test")}
   override suspend fun ready(guard:()->Unit){guard()}
   override suspend fun sign(prepared:PreparedVehicle,guard:()->Unit,beforeWallet:suspend ()->Unit,retain:suspend (JsonObject)->Unit){error("No wallet in this test")}
   override suspend fun hydrate(guard:()->Unit){guard()}
  })
  fun posts()=calls.count{it.first=="POST"}
  suspend fun attempted(kind:String,key:String,request:JsonObject):VehicleRecord {val r=store.begin(kind,key,request,f.policy);store.attempt(r.id,"post",true);return store.record(r.id)}
 }

 @Test fun `an expedition the server does not know cannot block a new expedition from its kingdom forever`()=runBlocking {
  val x=Fixture();val key=UUID.randomUUID().toString();val r=x.attempted("expedition",key,expedition(key))
  val repo=x.repo();repo.select(r.id);assertEquals("unknown",x.store.record(r.id).response!!.charterText("status"));rejects{repo.retry(r.id)}
  val next=UUID.randomUUID().toString();rejects{x.store.begin("expedition",next,expedition(next),f.policy)}
  val posts=x.posts();repo.closeUnknown();assertEquals("CLOSE sends nothing",posts,x.posts())
  val j=x.store.read();assertTrue(j.pending.isEmpty());val closed=j.archives.single();assertEquals(r.id,closed.id);assertEquals(unknown(key),closed.closedUnknown)
  x.store.begin("expedition",next,expedition(next),f.policy);assertEquals(next,x.store.read().pending.single().key)
  assertEquals(x.store.read(),VehicleStore(x.memory,x.store.identity).read())
 }
 @Test fun `an installation the server does not know cannot block reserving its asset forever`()=runBlocking {
  val x=Fixture();val r=x.attempted("installation",f.request.charterText("idempotencyKey"),f.request)
  val repo=x.repo();rejects{repo.select(r.id)};rejects{repo.retry(r.id)}
  val other=UUID.randomUUID().toString();val again=JsonObject(f.request+("idempotencyKey" to JsonPrimitive(other)))
  rejects{x.store.begin("installation",other,again,f.policy)}
  val posts=x.posts();repo.closeUnknown();assertEquals("CLOSE sends nothing",posts,x.posts())
  val closed=x.store.read().archives.single();assertEquals(r.id,closed.id);assertNull(closed.response);assertEquals(VehicleStore.serverUnknown("installation"),closed.closedUnknown)
  x.store.begin("installation",other,again,f.policy);assertEquals(other,x.store.read().pending.single().key)
 }
 @Test fun `close is refused on a bare 404 and when the server knows the installation`()=runBlocking {
  val x=Fixture();val r=x.attempted("installation",f.request.charterText("idempotencyKey"),f.request)
  val repo=x.repo();x.notFound=null;rejects{repo.select(r.id)}
  rejects{repo.closeUnknown()};assertEquals(r.id,x.store.read().pending.single().id);assertTrue(x.store.read().archives.isEmpty())
  x.known=true;repo.closeUnknown()
  val saved=x.store.read().pending.single();assertEquals(f.reserved(),saved.response);assertNull(saved.closedUnknown);assertTrue(x.store.read().archives.isEmpty())
  rejects{x.store.closeUnknown(r.id,saved,VehicleStore.serverUnknown("installation"))};assertEquals(0,x.posts())
 }
 @Test fun `a closed installation that the server later knows returns to pending with its reservation`()=runBlocking {
  val x=Fixture();val r=x.attempted("installation",f.request.charterText("idempotencyKey"),f.request)
  val repo=x.repo();rejects{repo.select(r.id)};repo.closeUnknown();assertEquals(r.id,x.store.read().archives.single().id)
  x.known=true;repo.select(r.id)
  val j=x.store.read();assertTrue(j.archives.isEmpty());val back=j.pending.single();assertEquals(f.reserved(),back.response);assertNull(back.closedUnknown);assertEquals(0,x.posts())
  assertEquals(j,VehicleStore(x.memory,x.store.identity).read())
 }
 @Test fun `a saved collection has no by-key read and is never closed`()=runBlocking {
  val x=Fixture();val r=x.attempted("collect",UUID.randomUUID().toString(),buildJsonObject{put("baseId",f.base)})
  rejects{x.store.closeUnknown(r.id,r,buildJsonObject{put("status",404);put("code",JsonNull)})};assertEquals(r,x.store.read().pending.single())
 }
 @Test fun `a vehicle journal saved before the close rule still decodes`()=runBlocking {
  val x=Fixture();val key=UUID.randomUUID().toString();x.attempted("expedition",key,expedition(key))
  val saved=Json.parseToJsonElement(x.memory.value!!).jsonObject
  val old=JsonObject(saved+("pending" to JsonArray(saved.getValue("pending").jsonArray.map{JsonObject(it.jsonObject-"closedUnknown")})))
  assertTrue(old.getValue("pending").jsonArray.none{"closedUnknown" in it.jsonObject})
  val m=VehicleFixtures.Memory();m.value=old.toString();assertEquals(x.store.read(),VehicleStore(m,x.store.identity).read())
 }
}
