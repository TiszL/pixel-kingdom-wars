package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.time.Instant
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class OrdinaryRouteRepositoryTest {
 private val f=VehicleFixtures
 private val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-route-vectors.json")).readText()).jsonObject
 private val modern=VehiclePolicy.from(JsonObject(f.policy.raw+("ordinaryRoutes" to vectors.charterObject("constants").getValue("ordinaryRoutes"))))
 private val installation="10000000-0000-4000-8000-000000000002"
 private fun previews(version:Long)=vectors.getValue("v$version").jsonArray.map{it.jsonObject}.filter{it.charterText("family")=="survey_balloon"&&CharterGrammar.number(it.getValue("tier"))==1L}
 private inner class Fixture(var policy:VehiclePolicy=modern) {
  val memory=VehicleFixtures.Memory();val identity=f.identity();val calls=mutableListOf<Pair<String,Map<String,String>>>();val originals=mutableMapOf<String,JsonObject>();val returned=mutableSetOf<String>();var allowed=true;var lose=false;var wrongVersion=false;var home="crownlands";var posts=0
  fun response(request:JsonObject,route:JsonObject)=buildJsonObject {
   put("wallet",f.wallet);put("idempotencyKey",request.getValue("idempotencyKey"));put("serverNow","2035-01-01T00:00:00.000Z");put("status","accepted")
   put("receipt",buildJsonObject{put("wallet",f.wallet);put("request",request);put("expeditionId",request.getValue("idempotencyKey"));put("installationId",installation);put("route",route);put("departedAt","2035-01-01T00:00:00.000Z");put("returnsAt",java.time.format.DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(java.time.ZoneOffset.UTC).format(Instant.parse("2035-01-01T00:00:00.000Z").plusSeconds(CharterGrammar.number(route.getValue("durationSec")))));put("termId","10000000-0000-4000-8000-000000000088");put("termHash","a".repeat(64));put("completedBefore","0")});put("return",JsonNull)
  }
  fun repo(store:VehicleStore=VehicleStore(memory,identity)):Pair<VehicleRepository,VehicleStore> {
   val ports=object:VehiclePorts {
    override val transport=VehicleTransport(object:VehiclePort {
     override val identity=this@Fixture.identity
     override suspend fun request(method:String,path:String,query:Map<String,String>,body:JsonObject?,guard:()->Unit,retain:suspend(JsonObject)->Unit):JsonObject {
      guard();calls+=path to query
      val raw=when {
       path=="/vehicles/fleet"->buildJsonObject{put("version",1);put("wallet",f.wallet);put("baseId",f.base);put("serverNow","2035-01-01T00:00:00.000Z");put("acceptingNewActions",allowed);put("vehicles",buildJsonArray{add(buildJsonObject{put("installationId",installation);put("berthId",f.berth);put("family","survey_balloon");put("tier",1);put("revision",0);put("completedTotal","0");put("allowanceStart","0");put("remainingUses",policy.completedUses);put("away",false);put("pendingService",false)})})}
       path=="/vehicles/client/routes"->buildJsonObject{put("version",1);put("wallet",f.wallet);put("baseId",f.base);put("items",buildJsonArray{add(buildJsonObject{put("installationId",installation);put("previews",JsonArray(previews(if(wrongVersion)1 else query["policyVersion"]?.toLong()?:1).map{r->if(CharterGrammar.number(r.getValue("policyVersion"))==1L)r else JsonObject(r+mapOf("homeRealmId" to JsonPrimitive(home),"accessRequirement" to JsonPrimitive(if(r.charterText("realmId")==home)"home" else "paid_realm")))}))})})}
       path=="/advanced-expeditions"->{posts++;val request=requireNotNull(body);val saved=store.read().records.single{it.request==request};assertTrue(saved.attempts.any{it.startsWith("post:")});assertEquals(saved.preview!!.getValue("policyVersion"),request.getValue("policyVersion"));val version=CharterGrammar.number(request.getValue("policyVersion"));val route=previews(version).single{it["routeId"]==request["routeId"]};response(request,route).also{originals[request.charterText("idempotencyKey")]=it;if(lose)throw IOException("Lost original reply")}}
       path.startsWith("/advanced-expeditions/by-key/")->originals.getValue(path.substringAfterLast('/')).let{r->if(r.charterText("idempotencyKey") !in returned)r else JsonObject(r+("return" to buildJsonObject{put("returnId","10000000-0000-4000-8000-000000000099");put("returnedAt",r.charterObject("receipt").getValue("returnsAt"));put("completedTotal","1")}))}
       else->error("Unexpected route $path")
      };retain(raw);guard();return raw
     }
    })
    override fun capture(fresh:Boolean):()->Unit={if(fresh)check(allowed)}
    override fun policy()=this@Fixture.policy;override fun trust():VehicleSigningTrust?=null;override fun key()=UUID.randomUUID().toString();override fun now()=0L
    override fun requireOwnedBase(base:String){require(base==f.base)}
    override suspend fun live(client:JsonObject,prepared:PreparedVehicle,pins:VehicleSigningTrust,policy:VehiclePolicy,networkFeeLamports:String,guard:()->Unit):()->Unit=error("Route cannot burn")
    override suspend fun ready(guard:()->Unit)=error("Route cannot approve")
    override suspend fun sign(prepared:PreparedVehicle,guard:()->Unit,beforeWallet:suspend ()->Unit,retain:suspend(JsonObject)->Unit)=error("Route cannot sign")
    override suspend fun hydrate(guard:()->Unit)=guard()
   }
   return VehicleRepository(store,ports) to store
  }
 }
 @Test fun `new catalogue fetch opts into2 only with independently installed support`()=runBlocking {
  for(policy in listOf(f.policy,modern)){val fixture=Fixture(policy);fixture.repo().first.fleet(f.base);assertEquals(if(policy==modern)"2" else null,fixture.calls.single{it.first=="/vehicles/client/routes"}.second["policyVersion"])}
 }
 @Test fun `selected v2 snapshot survives lost reply serialized restart and paused return without another POST`()=runBlocking {
  val x=Fixture();val(repo,store)=x.repo();repo.fleet(f.base);x.lose=true
  assertTrue(runCatching{repo.dispatch(f.base,installation,"mintwake-1",2)}.isFailure)
  val original=store.read().records.single();assertEquals(JsonPrimitive(2),original.request["policyVersion"]);assertEquals("mintwake-1",original.preview!!.charterText("routeId"))
  val coldStore=VehicleStore(VehicleFixtures.Memory().also{it.value=x.memory.value},x.identity);val cold=x.repo(coldStore).first;x.lose=false;cold.select(original.id)
  val receipt=coldStore.record(original.id).response!!.charterObject("receipt");x.returned+=original.key;x.allowed=false;cold.select(original.id)
  assertEquals(receipt,coldStore.record(original.id).response!!.charterObject("receipt"));assertNotNull(coldStore.record(original.id).response!!.charterOptional("return"));assertEquals(1,x.posts)
 }
 @Test fun `explicit fresh v1 selection remains supported after installing catalogue2`()=runBlocking {
  val x=Fixture();val(repo,store)=x.repo();repo.fleet(f.base);repo.dispatch(f.base,installation,previews(1).first().charterText("routeId"),1)
  assertEquals(JsonPrimitive(1),store.read().records.single().request["policyVersion"]);assertTrue(x.calls.filter{it.first=="/vehicles/client/routes"}.any{it.second["policyVersion"]==null})
 }
 @Test fun `server cannot answer requested2 with a v1 preview and enable dispatch`()=runBlocking {
  val x=Fixture();x.wrongVersion=true;val(repo,store)=x.repo();assertTrue(runCatching{repo.fleet(f.base)}.isFailure);assertEquals(0,x.posts);assertTrue(store.read().records.isEmpty())
 }
 @Test fun `missing installed v2 support and unknown versions refuse before dispatch HTTP`()=runBlocking {
  val x=Fixture(f.policy);val(repo,store)=x.repo();for(version in listOf(2L,3L))assertTrue(runCatching{repo.dispatch(f.base,installation,"mintwake-1",version)}.isFailure);assertEquals(0,x.posts);assertTrue(store.read().records.isEmpty())
 }
 @Test fun `old four-field expedition history remains readable when current catalogue changes`()=runBlocking {
  val x=Fixture(f.policy);val(repo,store)=x.repo();repo.dispatch(f.base,installation,previews(1).first().charterText("routeId"),1);val old=store.read().records.single();assertFalse(old.policy.containsKey("ordinaryRoutes"));x.policy=modern;x.allowed=false
  val cold=VehicleStore(VehicleFixtures.Memory().also{it.value=x.memory.value},x.identity);x.repo(cold).first.select(old.id);assertEquals(old.policy,cold.record(old.id).policy);assertEquals(old.response,cold.record(old.id).response)
 }
 @Test fun `changed authoritative HOME requires reviewing refreshed snapshot before provisions can be spent`()=runBlocking {
  val x=Fixture();val(repo,store)=x.repo();repo.fleet(f.base);x.home="seeker-reach"
  assertTrue(runCatching{repo.dispatch(f.base,installation,"mintwake-1",2)}.isFailure);assertEquals(0,x.posts);assertTrue(store.read().records.isEmpty())
 }

}
