package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.*
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.UUID
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Root alone owns dates, DB and previous v1 completion. Native uses actual TLS,
 * captured authentication, durable repositories and unchanged expedition routes. */
class OrdinaryRouteApiPairedTest {
 @Test fun `named v2 dispatch return lost replies and cold history preserve original v1 policy`()=Fixture().use{f->runBlocking {
  var c=f.client(legacy=true);c.repo.open()
  val prior=c.repo.state.value.activity!!.getValue("items").jsonArray.map{it.jsonObject}.single{it.charterText("idempotencyKey")==f.text("v1IdempotencyKey")}
  c.repo.openActivity(prior);val old=c.store.read().records.single();assertNotNull(old.response!!.charterOptional("return"));assertFalse(old.policy.containsKey("ordinaryRoutes"));assertEquals(JsonPrimitive(1),old.preview!!["policyVersion"])
  c=f.client(MemoryStore(c.disk.value));c.repo.fleet(f.base)
  assertEquals(32,requireNotNull(f.policy.ordinaryRoutes).routes.size)
  val previews=c.repo.state.value.routes!!.getValue("items").jsonArray.single().jsonObject.getValue("previews").jsonArray
  assertEquals(8,previews.size);assertTrue(previews.all{it.jsonObject["policyVersion"]==JsonPrimitive(2)})
  val selected=previews.map{it.jsonObject}.single{it.charterText("routeId")==f.text("routeId")};assertEquals("home",selected.charterText("accessRequirement"))
  f.loseNextPost="/advanced-expeditions"
  assertTrue(runCatching{c.repo.dispatch(f.base,f.text("installationId"),f.text("routeId"),CharterGrammar.number(selected.getValue("policyVersion")))}.isFailure)
  val original=c.store.read().records.single{it.id!=old.id};assertNull(original.response);assertEquals(selected,original.preview);assertEquals(JsonPrimitive(2),original.request["policyVersion"])
  c=f.client(MemoryStore(c.disk.value));c.repo.select(original.id)
  val receipt=c.store.record(original.id).response!!.charterObject("receipt");assertEquals(original.request,receipt.charterObject("request"));assertEquals(selected,receipt.charterObject("route"))
  f.command("finish-expedition"){put("expeditionId",receipt.getValue("expeditionId"))}
  f.loseNextPost="/advanced-expeditions/collect";assertTrue(runCatching{c.repo.collect(f.base)}.isFailure)
  val collecting=c.store.read().records.single{it.kind=="collect"};assertNull(collecting.response)
  c=f.client(MemoryStore(c.disk.value));c.repo.check();assertNotNull(c.store.record(original.id).response!!.charterOptional("return"));assertEquals(receipt,c.store.record(original.id).response!!.charterObject("receipt"))
  assertEquals(old.response!!.charterObject("receipt"),c.store.record(old.id).response!!.charterObject("receipt"));assertEquals(old.response!!["return"],c.store.record(old.id).response!!["return"]);assertEquals(old.policy,c.store.record(old.id).policy)
  assertEquals(1,f.posts.count{it=="/advanced-expeditions"});assertEquals(1,f.posts.count{it=="/advanced-expeditions/collect"})
  assertTrue(f.routeQueries.any{it["policyVersion"]=="2"})
  f.command("restart"){put("paused",true);put("providerless",true)}
  val cold=f.client(MemoryStore(c.disk.value),paused=true);cold.repo.open();cold.repo.select(old.id);cold.repo.select(original.id)
  assertEquals(receipt,cold.store.record(original.id).response!!.charterObject("receipt"));assertEquals(old.policy,cold.store.record(old.id).policy)
  assertTrue(runCatching{cold.repo.dispatch(f.base,f.text("installationId"),f.text("routeId"),2)}.isFailure)
  val saved=cold.store.read();f.offline=true;assertEquals(saved,VehicleStore(MemoryStore(cold.disk.value),cold.store.identity).read())
 }}
 private class Client(val f:Fixture,val disk:MemoryStore,paused:Boolean,legacy:Boolean) {
  private val holder=testHolder();private val cookies=SessionCookieJar(f.server.url("/"),MemoryStore()).apply{saveFromResponse(f.server.url("/"),listOf(requireNotNull(Cookie.parse(f.server.url("/"),"pairedActor=${f.actor}; Path=/; Secure; HttpOnly"))))}
  private val game=GameApi.withTransport(f.origin,cookies,"native-ordinary-route-pair",f.transport);private val session=AccountSession(f.actor,f.origin,game.sessionToken()).also(holder::replace)
  val store=VehicleStore(disk,StarterIdentity(f.origin,"devnet",f.actor))
  private val ports=object:VehiclePorts {
   override val transport=VehicleTransport(VehicleHttpPort(game.charterClientPort(store.identity,session.token)))
   override fun capture(fresh:Boolean):()->Unit={holder.requireCurrent(session);if(fresh)check(!paused)}
   override fun policy()=if(legacy)VehiclePolicy.from(JsonObject(f.policy.raw-"ordinaryRoutes")) else f.policy
   override fun trust():VehicleSigningTrust?=null;override fun key()=UUID.randomUUID().toString();override fun now()=System.nanoTime()/1_000_000
   override fun requireOwnedBase(base:String){require(base==f.base)}
   override suspend fun live(client:JsonObject,prepared:PreparedVehicle,pins:VehicleSigningTrust,policy:VehiclePolicy,networkFeeLamports:String,guard:()->Unit):()->Unit=error("Routes never burn")
   override suspend fun ready(guard:()->Unit)=error("Routes never approve")
   override suspend fun sign(prepared:PreparedVehicle,guard:()->Unit,beforeWallet:suspend ()->Unit,retain:suspend(JsonObject)->Unit)=error("Routes never sign")
   override suspend fun hydrate(guard:()->Unit)=guard()
  }
  val repo=VehicleRepository(store,ports)
 }
 private class Fixture:AutoCloseable {
  private val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();private val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();private val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
  val server=MockWebServer().apply{protocols=listOf(Protocol.HTTP_1_1);useHttps(tls.sslSocketFactory(),false);start()};val origin=server.url("/").toString().trimEnd('/')
  val transport=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();private val bridge=Bridge()
  val setup=try{command("start"){put("origin",origin)}}catch(e:Throwable){runCatching{bridge.close()};server.shutdown();transport.dispatcher.executorService.shutdown();throw e}
  val actor=text("wallet");val base=text("baseId");val policy=VehiclePolicy.from(setup.charterObject("policy"))
  private lateinit var active:Client;val posts=java.util.Collections.synchronizedList(mutableListOf<String>());val routeQueries=java.util.Collections.synchronizedList(mutableListOf<Map<String,String>>());@Volatile var loseNextPost:String?=null;@Volatile var offline=false
  init{server.dispatcher=object:okhttp3.mockwebserver.Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
   if(offline)return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
   val actor=request.getHeader("Cookie")?.split(';')?.map{it.trim()}?.singleOrNull{it.startsWith("pairedActor=")}?.substringAfter('=')?:return MockResponse().setResponseCode(401);require(actor==this@Fixture.actor)
   val url=requireNotNull(request.requestUrl);val path=url.encodedPath.removePrefix("/api");val method=requireNotNull(request.method);val raw=request.body.readUtf8();val body=if(raw.isEmpty())null else Json.parseToJsonElement(raw).jsonObject
   val query=url.queryParameterNames.associateWith{requireNotNull(url.queryParameter(it))};if(path=="/vehicles/client/routes")routeQueries.add(query)
   if(method=="POST")runBlocking{require(path in listOf("/advanced-expeditions","/advanced-expeditions/collect"));val saved=active.store.read().records.single{it.request==body};assertTrue("Original before HTTP",saved.attempts.any{it.startsWith("post:")});if(path=="/advanced-expeditions")assertEquals(saved.preview!!.getValue("policyVersion"),saved.request["policyVersion"])}
   val response=command("request"){put("actor",actor);put("method",method);put("path",path);if(query.isNotEmpty())put("query",buildJsonObject{query.forEach{(k,v)->put(k,v)}});body?.let{put("body",it)}}
   if(method=="POST")posts.add(path)
   if(method=="POST"&&loseNextPost==path){loseNextPost=null;return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)}
   return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int).setBody(response.charterText("body")).apply{response.charterObject("headers").forEach{(k,v)->addHeader(k,v.jsonPrimitive.content)}}
  }}}
  fun text(key:String)=setup.charterText(key)
  fun command(operation:String,fields:JsonObjectBuilder.()->Unit)=bridge.command(buildJsonObject{put("operation",operation);fields()})
  fun client(disk:MemoryStore=MemoryStore(),paused:Boolean=false,legacy:Boolean=false)=Client(this,disk,paused,legacy).also{active=it}
  override fun close(){try{bridge.close()}finally{server.shutdown();transport.connectionPool.evictAll();transport.dispatcher.executorService.shutdown()}}
 }
 private class Bridge:AutoCloseable {
  private val url=requireNotNull(System.getenv("PHASE_E_ORDINARY_ROUTE_PAIR_URL")).toHttpUrl().also{require(it.scheme=="http"&&it.host=="127.0.0.1"&&it.encodedPath=="/"&&it.query==null&&it.fragment==null&&it.username.isEmpty()&&it.password.isEmpty())}
  private val token=requireNotNull(System.getenv("PHASE_E_ORDINARY_ROUTE_PAIR_TOKEN")).also{require(it.isNotBlank()&&it.length<=256&&it.all{c->c.code in 33..126})}
  private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).readTimeout(60,TimeUnit.SECONDS).callTimeout(60,TimeUnit.SECONDS).build()
  @Synchronized fun command(value:JsonObject):JsonObject {val request=Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build();return http.newCall(request).execute().use{r->val body=requireNotNull(r.body);require(body.contentLength()<=16*1024*1024&&!body.source().request(16*1024*1024+1L));val raw=Json.parseToJsonElement(body.string()).jsonObject;check(r.isSuccessful){"Private route command refused: ${value.charterText("operation")}"};raw}}
  override fun close(){try{command(buildJsonObject{put("operation","close")})}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 }
}
