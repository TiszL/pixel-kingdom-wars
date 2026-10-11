package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.VehiclePolicy
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

/** Root owns the actual database, API clock, stock and stable-deed transfer.
 * This JVM case runs native transport/journal/repository through captured TLS. */
class SurveyLensApiPairedTest {
 @Test fun `one durable Lens preserves both cargo legs through restart and original kingdom transfer`()=Fixture().use{f->runBlocking{
  var c=f.client();c.repo.choose("survey_lens",f.text("lensResourceId"));assertEquals("0",c.repo.state.value.view!!.equipmentStock.single{it.itemId=="survey_lens"}.available)
  c.repo.reviewCraft();f.loseNextPost="/ordinary-equipment/jobs";assertTrue(runCatching{c.repo.confirm()}.isFailure)
  val craft=c.store.read().pending.single();assertTrue(craft.attempted);assertEquals("unknown",craft.response!!.charterText("status"))
  c=f.client(MemoryStore(c.disk.value));c.repo.check();val craftReceipt=c.store.record(craft.key).response!!.charterObject("receipt");assertEquals(craft.request,craftReceipt.charterObject("request"))
  f.command("finish-craft"){put("key",craft.key)};c.repo.check();assertNotNull(c.store.record(craft.key).response!!.charterOptional("completion"));c.repo.archive(craft.key);c.repo.choose("survey_lens",f.text("lensResourceId"));assertEquals("1",c.repo.state.value.view!!.equipmentStock.single{it.itemId=="survey_lens"}.available)
  val starter=c.repo.state.value.starter!!.getValue("routes").jsonArray.map{it.jsonObject}.single{it.charterText("routeId")==f.text("starterRouteId")}
  c.repo.reviewTrip("starter",f.text("starterInstallationId"),starter);f.loseNextPost="/starter-expeditions";assertTrue(runCatching{c.repo.confirm()}.isFailure)
  val starterOriginal=c.store.read().pending.single();c=f.client(MemoryStore(c.disk.value));c.repo.check();assertEquals(starter,c.store.record(starterOriginal.key).response!!.charterObject("receipt").charterObject("route"));c.repo.choose("survey_lens",f.text("lensResourceId"));assertEquals("1",c.repo.state.value.view!!.equipmentStock.single{it.itemId=="survey_lens"}.reserved)
  f.command("finish-expedition"){put("kind","starter");put("key",starterOriginal.key)};c.repo.check();assertNotNull(c.store.record(starterOriginal.key).response!!.charterOptional("return"));assertEquals(starter["secondaryOutput"],c.store.record(starterOriginal.key).response!!.charterObject("return")["secondaryOutput"]);c.repo.archive(starterOriginal.key);c.repo.choose("survey_lens",f.text("lensResourceId"));assertEquals("1",c.repo.state.value.view!!.equipmentStock.single{it.itemId=="survey_lens"}.available)
  val advanced=c.repo.state.value.routes!!.getValue("items").jsonArray.map{it.jsonObject}.single{it.charterText("installationId")==f.text("advancedInstallationId")}.getValue("previews").jsonArray.map{it.jsonObject}.single{it.charterText("routeId")==f.text("advancedRouteId")}
  c.repo.reviewTrip("advanced",f.text("advancedInstallationId"),advanced);f.loseNextPost="/advanced-expeditions";assertTrue(runCatching{c.repo.confirm()}.isFailure)
  val trip=c.store.read().pending.single();c=f.client(MemoryStore(c.disk.value));c.repo.check();val receipt=c.store.record(trip.key).response!!.charterObject("receipt");assertEquals(trip.request,receipt.charterObject("request"));assertEquals(advanced,receipt.charterObject("route"))
  f.command("transfer"){};f.command("finish-expedition"){put("kind","advanced");put("key",trip.key)};f.command("restart"){put("paused",true);put("providerless",true)}
  c=f.client(MemoryStore(c.disk.value),paused=true,owned=false);c.repo.open();assertNull(c.repo.state.value.view);assertNotNull(c.store.record(trip.key).response!!.charterOptional("return"));assertEquals(receipt,c.store.record(trip.key).response!!.charterObject("receipt"));assertEquals(advanced["secondaryOutput"],c.store.record(trip.key).response!!.charterObject("return")["secondaryOutput"]);c.repo.archive(trip.key)
  c.repo.select(craft.key);assertEquals(craftReceipt,c.store.record(craft.key).response!!.charterObject("receipt"));c.repo.select(starterOriginal.key);assertNotNull(c.store.record(starterOriginal.key).response!!.charterOptional("return"))
  assertTrue(runCatching{c.repo.reviewCraft()}.isFailure);assertEquals(listOf("/ordinary-equipment/jobs","/starter-expeditions","/advanced-expeditions"),f.posts.toList());assertTrue(f.fittedQueries>=2)
  val saved=c.store.read();f.offline=true;assertEquals(saved,EquipmentStore(MemoryStore(c.disk.value),c.store.identity).read());assertEquals(3,saved.archives.size)
 }}
 private class Client(val f:Fixture,val disk:MemoryStore,paused:Boolean,owned:Boolean){
  private val holder=testHolder();private val cookies=SessionCookieJar(f.server.url("/"),MemoryStore()).apply{saveFromResponse(f.server.url("/"),listOf(requireNotNull(Cookie.parse(f.server.url("/"),"pairedActor=${f.actor}; Path=/; Secure; HttpOnly"))))}
  private val game=GameApi.withTransport(f.origin,cookies,"native-survey-lens-pair",f.transport);private val session=AccountSession(f.actor,f.origin,game.sessionToken()).also(holder::replace)
  val store=EquipmentStore(disk,StarterIdentity(f.origin,"devnet",f.actor));private val http=EquipmentTransport(EquipmentHttpPort(game.charterClientPort(store.identity,session.token)))
  private val ports=object:EquipmentPorts{
   override val transport=http;override fun capture(fresh:Boolean):()->Unit={holder.requireCurrent(session);if(fresh)check(!paused)}
   override fun policy()=if(paused)null else f.equipment;override fun vehiclePolicy()=if(paused)null else f.vehicles
   override fun selectedBase()=f.base;override fun requireOwnedBase(base:String){require(owned&&base==f.base)};override fun key()=UUID.randomUUID().toString()
   override suspend fun hydrate(guard:()->Unit){guard();if(owned){val raw=http.request("GET","/ordinary-equipment",guard=guard,query=mapOf("baseId" to f.base,"catalogueVersion" to "2"));val view=EquipmentView.from(raw);require(view.wallet==f.actor&&view.baseId==f.base)};guard()}
  }
  val repo=EquipmentRepository(store,ports)
 }
 private class Fixture:AutoCloseable{
  private val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();private val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();private val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
  val server=MockWebServer().apply{protocols=listOf(Protocol.HTTP_1_1);useHttps(tls.sslSocketFactory(),false);start()};val origin=server.url("/").toString().trimEnd('/')
  val transport=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();private val bridge=Bridge()
  val setup=try{command("start"){put("origin",origin)}}catch(e:Throwable){runCatching{bridge.close()};server.shutdown();transport.dispatcher.executorService.shutdown();throw e}
  val actor=text("wallet");val base=text("baseId");val equipment=EquipmentPolicy.from(setup.charterObject("equipmentPolicy"));val vehicles=VehiclePolicy.from(setup.charterObject("vehiclePolicy"))
  private lateinit var active:Client;val posts=java.util.Collections.synchronizedList(mutableListOf<String>());@Volatile var fittedQueries=0;@Volatile var loseNextPost:String?=null;@Volatile var offline=false
  init{server.dispatcher=object:okhttp3.mockwebserver.Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   if(offline)return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
   val actor=request.getHeader("Cookie")?.split(';')?.map{it.trim()}?.singleOrNull{it.startsWith("pairedActor=")}?.substringAfter('=')?:return MockResponse().setResponseCode(401);require(actor==this@Fixture.actor)
   val url=requireNotNull(request.requestUrl);val path=url.encodedPath.removePrefix("/api");val method=requireNotNull(request.method);val raw=request.body.readUtf8();val body=if(raw.isEmpty())null else Json.parseToJsonElement(raw).jsonObject;val query=url.queryParameterNames.associateWith{requireNotNull(url.queryParameter(it))};if(query["fitting"]=="survey_lens")fittedQueries++
   if(method=="POST")runBlocking{require(path in listOf("/ordinary-equipment/jobs","/starter-expeditions","/advanced-expeditions"));val saved=active.store.read().pending.single{it.request==body};assertTrue("Original and marker saved before HTTP",saved.attempted);if(path!="/ordinary-equipment/jobs")assertEquals(equipment.selectionFor("survey_lens",text("lensResourceId")),saved.request["fitting"])}
   val response=command("request"){put("actor",actor);put("method",method);put("path",path);if(query.isNotEmpty())put("query",buildJsonObject{query.forEach{(k,v)->put(k,v)}});body?.let{put("body",it)}}
   if(method=="POST")posts.add(path);if(method=="POST"&&loseNextPost==path){loseNextPost=null;return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)}
   return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int).setBody(response.charterText("body")).apply{response.charterObject("headers").forEach{(k,v)->addHeader(k,v.jsonPrimitive.content)}}
  }}}
  fun text(key:String)=setup.charterText(key)
  fun command(operation:String,fields:JsonObjectBuilder.()->Unit)=bridge.command(buildJsonObject{put("operation",operation);fields()})
  fun client(disk:MemoryStore=MemoryStore(),paused:Boolean=false,owned:Boolean=true)=Client(this,disk,paused,owned).also{active=it}
  override fun close(){try{bridge.close()}finally{server.shutdown();transport.connectionPool.evictAll();transport.dispatcher.executorService.shutdown()}}
 }
 private class Bridge:AutoCloseable{
  private val url=requireNotNull(System.getenv("PHASE_E_SURVEY_LENS_PAIR_URL")).toHttpUrl().also{require(it.scheme=="http"&&it.host=="127.0.0.1"&&it.encodedPath=="/"&&it.query==null&&it.fragment==null&&it.username.isEmpty()&&it.password.isEmpty())}
  private val token=requireNotNull(System.getenv("PHASE_E_SURVEY_LENS_PAIR_TOKEN")).also{require(it.isNotBlank()&&it.length<=256&&it.all{c->c.code in 33..126})}
  private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).readTimeout(60,TimeUnit.SECONDS).callTimeout(60,TimeUnit.SECONDS).build()
  @Synchronized fun command(value:JsonObject):JsonObject{val request=Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build();return http.newCall(request).execute().use{r->val body=requireNotNull(r.body);require(body.contentLength()<=16*1024*1024&&!body.source().request(16*1024*1024+1L));val raw=Json.parseToJsonElement(body.string()).jsonObject;check(r.isSuccessful){"Private equipment command refused: ${value.charterText("operation")}"};raw}}
  override fun close(){try{command(buildJsonObject{put("operation","close")})}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 }
}
