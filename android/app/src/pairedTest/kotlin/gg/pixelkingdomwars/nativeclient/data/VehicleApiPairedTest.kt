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

/** Root owns DB, dates and private chain fixture. All client effects cross actual
 * TLS, authenticated API routes, exact native signing and serialized journals. */
class VehicleApiPairedTest {
 @Test fun `install upgrade dispatch exhaustion restore and paused history retain every original`()=Fixture().use{f->runBlocking {
  val first=f.client();first.repo.open();first.repo.assets()
  assertTrue(first.repo.state.value.assets!!.getValue("items").jsonArray.any{it.jsonObject.charterObject("identity").charterText("assetId")==f.text("initialAssetId")})
  f.loseNextPost="/vehicles/client/installations"
  assertTrue(runCatching{first.repo.reserve(f.base,f.text("berthId"),f.text("initialAssetId"))}.isFailure)
  val initial=first.store.read().records.single();assertNull(initial.response);assertTrue(initial.attempts.any{it.startsWith("post:")})
  var c=f.client(MemoryStore(first.disk.value));c.repo.open();c.repo.select(initial.id)
  val initialRef=VehicleProtocol.reference(c.original());val initialId=initialRef.charterText("id")
  f.loseNextPost="/vehicles/client/installations/$initialId/prepare"
  assertTrue(runCatching{c.repo.command("prepare")}.isFailure)
  c=f.client(MemoryStore(c.disk.value));c.repo.select(initial.id);assertNotNull(c.original().charterObject("record").charterOptional("preparation"))
  c.repo.review();c.repo.approve();val initialWire=requireNotNull(c.store.record(initial.id).signed)
  f.loseNextPost="/vehicles/client/installations/$initialId/signed"
  assertTrue(runCatching{c.repo.upload()}.isFailure);c.repo.select(initial.id);assertEquals(initialWire.charterText("signature"),c.original().charterObject("record").charterObject("signed").charterText("signature"))
  f.loseNextPost="/vehicles/client/installations/$initialId/deliver"
  assertTrue(runCatching{c.repo.deliver()}.isFailure);f.command("finalize"){put("reference",initialRef)};c.repo.command("recover")
  val installed=VehicleProtocol.terminal(c.original())!!;assertEquals(f.base,installed.charterText("baseId"));assertEquals(f.text("berthId"),installed.charterText("berthId"))
  val installation=installed.charterText("installationId");c.repo.fleet(f.base);assertEquals(1,c.repo.state.value.fleet!!.getValue("vehicles").jsonArray.size)

  f.loseNextPost="/vehicles/client/services"
  assertTrue(runCatching{c.repo.service(f.base,installation,f.text("upgradeAssetId"),"upgrade")}.isFailure)
  val upgrade=c.store.read().records.single{it.kind=="service"};c=f.client(MemoryStore(c.disk.value));c.repo.select(upgrade.id)
  c.completeBurn();assertEquals(2,VehicleProtocol.terminal(c.original())!!.getValue("tierAfter").jsonPrimitive.int)
  c.repo.fleet(f.base);val upgraded=c.repo.state.value.fleet!!.getValue("vehicles").jsonArray.single().jsonObject;assertEquals(2,upgraded.getValue("tier").jsonPrimitive.int)
  f.loseNextPost="/advanced-expeditions";assertTrue(runCatching{c.repo.dispatch(f.base,installation,f.text("routeId"))}.isFailure)
  val trip=c.store.read().records.single{it.kind=="expedition"};c=f.client(MemoryStore(c.disk.value));c.repo.select(trip.id)
  val receipt=c.store.record(trip.id).response!!.charterObject("receipt");assertEquals(f.base,receipt.charterObject("request").charterText("baseId"));assertEquals(installation,receipt.charterText("installationId"))
  f.command("finish-expedition"){put("expeditionId",receipt.getValue("expeditionId"))};f.loseNextPost="/advanced-expeditions/collect";assertTrue(runCatching{c.repo.collect(f.base)}.isFailure)
  val collection=c.store.read().records.single{it.kind=="collect"};c.repo.check();assertNull(c.store.record(collection.id).response);c.repo.retry(collection.id)
  assertNotNull(c.store.record(trip.id).response!!.charterOptional("return"));assertEquals(receipt,c.store.record(trip.id).response!!.charterObject("receipt"))
  f.command("exhaust"){put("installationId",installation)};c.repo.fleet(f.base)
  assertEquals(0,c.repo.state.value.fleet!!.getValue("vehicles").jsonArray.single().jsonObject.getValue("remainingUses").jsonPrimitive.int)
  c.repo.service(f.base,installation,f.text("restoreAssetId"),"restore_uses");val restore=c.repo.state.value.selected!!;c.completeBurn()
  val restored=VehicleProtocol.terminal(c.original())!!;assertEquals(f.policy.completedUses,restored.getValue("remainingUses").jsonPrimitive.long);assertEquals(restored["completedTotal"],restored["allowanceStartAfter"])
  c.repo.fleet(f.base);assertEquals(f.policy.completedUses,c.repo.state.value.fleet!!.getValue("vehicles").jsonArray.single().jsonObject.getValue("remainingUses").jsonPrimitive.long)
  val originals=c.store.read();assertEquals(3,f.approvals);assertEquals(1,f.posts.count{it=="/vehicles/client/installations"});assertEquals(2,f.posts.count{it=="/vehicles/client/services"});assertEquals(1,f.posts.count{it=="/advanced-expeditions"})
  f.command("restart"){put("paused",true);put("providerless",true)}
  val cold=f.client(MemoryStore(c.disk.value),true);cold.repo.open();cold.repo.check();cold.repo.select(restore.id)
  for(saved in originals.records){val current=cold.store.record(saved.id);assertEquals(saved.signed,current.signed);assertEquals(saved.consent,current.consent);if(saved.kind in listOf("installation","service"))assertEquals(VehicleProtocol.terminal(saved.response!!),VehicleProtocol.terminal(current.response!!))}
  assertTrue(runCatching{cold.repo.review()}.isFailure);assertTrue(runCatching{cold.repo.approve()}.isFailure);assertTrue(runCatching{cold.repo.deliver()}.isFailure);assertEquals(3,f.approvals)
  cold.repo.archive();assertTrue(cold.store.read().archives.any{it.id==restore.id});assertEquals(initialWire,cold.store.record(initial.id).signed)
  val final=cold.store.read();f.offline=true;assertEquals(final,VehicleStore(MemoryStore(cold.disk.value),cold.store.identity).read())
 }}
 private class Client(val f:Fixture,val disk:MemoryStore,val paused:Boolean){
  val holder=testHolder();private val cookies=SessionCookieJar(f.server.url("/"),MemoryStore()).apply{saveFromResponse(f.server.url("/"),listOf(requireNotNull(Cookie.parse(f.server.url("/"),"pairedActor=${f.actor}; Path=/; Secure; HttpOnly"))))}
  private val game=GameApi.withTransport(f.origin,cookies,"native-vehicle-pair",f.transport);private val session=AccountSession(f.actor,f.origin,game.sessionToken()).also(holder::replace)
  val store=VehicleStore(disk,StarterIdentity(f.origin,"devnet",f.actor));var hydrates=0
  private val wallet=VehicleWallet(session,holder,f.origin,SolanaCluster.DEVNET,{false},{null},if(paused)null else VehicleExternalSigner{prepared,cluster,retain,beforeWallet,guard->
   assertEquals(SolanaCluster.DEVNET,cluster);guard();beforeWallet();guard();val r=store.read().records.single{it.consent?.client?.charterObject("record")?.charterObject("preparation")?.charterText("messageSha256")==prepared.messageSha256};assertTrue("wallet" in r.attempts);assertNull(r.signed);f.approvals++
   val wire=f.command("sign"){put("client",r.consent!!.client)}.charterObject("wire");val valid=prepared.verifyWire(wire);retain(valid);guard();valid
  })
  private val ports=object:VehiclePorts {
   override val transport=VehicleTransport(VehicleHttpPort(game.charterClientPort(store.identity,session.token)))
   override fun capture(fresh:Boolean):()->Unit {val g={holder.requireCurrent(session);if(fresh)check(!paused)};g();return g}
   override fun policy()=f.policy;override fun trust()=if(paused)null else f.pins;override fun key()=UUID.randomUUID().toString();override fun now()=System.nanoTime()/1_000_000
   override fun requireOwnedBase(base:String){require(base==f.base)}
   override suspend fun live(client:JsonObject,prepared:PreparedVehicle,pins:VehicleSigningTrust,policy:VehiclePolicy,networkFeeLamports:String,guard:()->Unit)=VehicleCurrent.verify(client,pins,policy,networkFeeLamports,VehicleRpcReads{method,params->f.command("live"){put("method",method);put("params",params)}},guard)
   override suspend fun ready(guard:()->Unit)=wallet.requireAvailable(guard)
   override suspend fun sign(prepared:PreparedVehicle,guard:()->Unit,beforeWallet:suspend ()->Unit,retain:suspend(JsonObject)->Unit){wallet.sign(prepared,retain,beforeWallet,guard)}
   override suspend fun hydrate(guard:()->Unit){guard();hydrates++}
  }
  val repo=VehicleRepository(store,ports)
  fun original()=requireNotNull(repo.state.value.selected?.response)
  suspend fun completeBurn(){repo.command("prepare");repo.review();repo.approve();repo.upload();repo.deliver();f.command("finalize"){put("reference",VehicleProtocol.reference(original()))};repo.command("recover");assertNotNull(VehicleProtocol.terminal(original()))}
 }
 private class Fixture:AutoCloseable {
  private val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();private val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();private val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
  val server=MockWebServer().apply{protocols=listOf(Protocol.HTTP_1_1);useHttps(tls.sslSocketFactory(),false);start()};val origin=server.url("/").toString().trimEnd('/')
  val transport=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();private val bridge=Bridge()
  val setup=try{command("start"){put("origin",origin)}}catch(e:Throwable){runCatching{bridge.close()};server.shutdown();transport.dispatcher.executorService.shutdown();throw e}
  val actor=text("wallet");val base=text("baseId");val policy=VehiclePolicy.from(setup.charterObject("policy"));val pins=VehicleSigningTrust.from(setup.charterObject("trust"))
  private lateinit var active:Client;var approvals=0;val posts=java.util.Collections.synchronizedList(mutableListOf<String>());@Volatile var loseNextPost:String?=null;@Volatile var offline=false
  init{server.dispatcher=object:okhttp3.mockwebserver.Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
   if(offline)return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
   val actor=request.getHeader("Cookie")?.split(';')?.map{it.trim()}?.singleOrNull{it.startsWith("pairedActor=")}?.substringAfter('=')?:return MockResponse().setResponseCode(401);require(actor==this@Fixture.actor)
   val url=requireNotNull(request.requestUrl);val path=url.encodedPath.removePrefix("/api");val method=requireNotNull(request.method);val raw=request.body.readUtf8();val body=if(raw.isEmpty())null else Json.parseToJsonElement(raw).jsonObject
   if(method=="POST"&&!path.endsWith("/review"))runBlocking{val rows=active.store.read().records;val command=path.substringAfterLast('/');val row=if(command in listOf("prepare","signed","recover","deliver")){val id=path.split('/')[4];rows.single{it.response?.let{v->it.kind in listOf("installation","service")&&VehicleProtocol.reference(v).charterText("id")==id}==true}}else rows.single{it.request==body&&it.kind==when(path){"/vehicles/client/installations"->"installation";"/vehicles/client/services"->"service";"/advanced-expeditions"->"expedition";else->"collect"}}
    val name=if(command=="signed")"upload" else if(command in listOf("prepare","recover","deliver"))command else "post";assertTrue("Intent must be durable before HTTP",row.attempts.any{it.startsWith("$name:")});if(name in listOf("upload","deliver"))assertNotNull(row.signed)
   }
   val response=command("request"){put("actor",actor);put("method",method);put("path",path);if(url.queryParameterNames.isNotEmpty())put("query",buildJsonObject{url.queryParameterNames.forEach{put(it,requireNotNull(url.queryParameter(it)))}});body?.let{put("body",it)}}
   if(method=="POST")posts.add(path)
   if(method=="POST"&&loseNextPost==path){loseNextPost=null;return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)}
   return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int).setBody(response.charterText("body")).apply{response.charterObject("headers").forEach{(k,v)->addHeader(k,v.jsonPrimitive.content)}}
  }}}
  fun text(key:String)=setup.charterText(key)
  fun command(operation:String,fields:JsonObjectBuilder.()->Unit)=bridge.command(buildJsonObject{put("operation",operation);fields()})
  fun client(disk:MemoryStore=MemoryStore(),paused:Boolean=false)=Client(this,disk,paused).also{active=it}
  override fun close(){try{bridge.close()}finally{server.shutdown();transport.connectionPool.evictAll();transport.dispatcher.executorService.shutdown()}}
 }
 private class Bridge:AutoCloseable {
  private val url=requireNotNull(System.getenv("PHASE_E_VEHICLE_PAIR_URL")).toHttpUrl().also{require(it.scheme=="http"&&it.host=="127.0.0.1"&&it.encodedPath=="/"&&it.query==null&&it.fragment==null&&it.username.isEmpty()&&it.password.isEmpty())}
  private val token=requireNotNull(System.getenv("PHASE_E_VEHICLE_PAIR_TOKEN")).also{require(it.isNotBlank()&&it.length<=256&&it.all{c->c.code in 33..126})}
  private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(60,TimeUnit.SECONDS).build()
  @Synchronized fun command(value:JsonObject):JsonObject {val request=Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build();val client=if(value.charterText("operation")=="exhaust")http.newBuilder().readTimeout(120,TimeUnit.SECONDS).callTimeout(120,TimeUnit.SECONDS).build() else http;return client.newCall(request).execute().use{r->val body=requireNotNull(r.body);require(body.contentLength()<=16*1024*1024&&!body.source().request(16*1024*1024+1L));val raw=Json.parseToJsonElement(body.string()).jsonObject;check(r.isSuccessful){"Private vehicle command refused: ${value.charterText("operation")}"};raw}}
  override fun close(){try{command(buildJsonObject{put("operation","close")})}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 }
}
