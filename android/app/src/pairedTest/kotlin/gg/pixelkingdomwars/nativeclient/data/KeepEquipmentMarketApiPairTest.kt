package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.keepequipmentmarket.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.wallet.*
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

/** Real native repository, journal, app ports, current checker and TLS transport
 * against actual API/SQL. Finalized RPC rows are explicit simulated observations;
 * real SPL execution is the separate accepted local-validator pair. */
class KeepEquipmentMarketApiPairTest {
 @Test fun `legacy exact signed purchase survives interruption pause and transferred base`()=journey(JsonPrimitive("legacy"))
 @Test fun `v0 ATA creation purchase survives interruption pause and transferred base`()=journey(JsonPrimitive(0))
 @Test fun `legacy reservations release before preparation and after exact failed payment`()=releaseJourney(JsonPrimitive("legacy"))
 @Test fun `v0 reservations release before preparation and after exact failed payment`()=releaseJourney(JsonPrimitive(0))
 private fun releaseJourney(version:JsonElement)=Fixture(version).use{f->runBlocking {
  var buyer=f.client("buyer");buyer.repo.open();val listing=f.setup.charterObject("initialListing")
  buyer.repo.reviewFill(listing,"1");buyer.repo.confirm();val unprepared=requireNotNull(buyer.repo.state.value.selectedKey);assertEquals("reserved",buyer.original(unprepared).charterText("status"))
  val beforeCancel=f.posts.size;buyer.repo.release();assertEquals(listOf("/keep-equipment-market/fills/$unprepared/release"),f.posts.drop(beforeCancel));assertEquals("never_prepared",buyer.original(unprepared).charterObject("release").charterText("reason"));assertEquals(0,f.approvals);buyer.repo.archive(unprepared)
  buyer.repo.reviewFill(listing,"2");buyer.repo.confirm();val id=requireNotNull(buyer.repo.state.value.selectedKey);buyer.repo.command("prepare");buyer.repo.reviewPayment();buyer.repo.approve(version==JsonPrimitive(0));val signed=requireNotNull(buyer.store.record(id).signed);val preparation=buyer.original(id).charterObject("preparation")
  buyer.repo.send();assertEquals(1,f.approvals);assertEquals(1,f.posts.count{it.endsWith("/deliver")});f.command("fail"){put("fillId",id)}
  f.command("transfer"){};f.command("restart"){put("paused",true)};buyer=f.client("buyer",MemoryStore(buyer.disk.value),true);buyer.repo.open();buyer.repo.selectSaved(id)
  f.loseNextPost="/keep-equipment-market/fills/$id/release";assertTrue(runCatching{buyer.repo.release()}.isFailure);assertEquals("signed",buyer.original(id).charterText("status"));assertTrue(buyer.store.record(id).attempts.any{it.startsWith("release:")})
  buyer=f.client("buyer",MemoryStore(buyer.disk.value),true);buyer.repo.open();buyer.repo.selectSaved(id);buyer.repo.command("recover");buyer.repo.release()
  val closed=buyer.original(id);assertEquals("released",closed.charterText("status"));assertEquals("finalized_failed",closed.charterObject("release").charterText("reason"));assertEquals(preparation,closed["preparation"]);assertEquals(signed,buyer.store.record(id).signed);assertEquals(f.buyerBase,closed.charterObject("fill").charterText("buyerBaseId"));assertEquals(JsonNull,closed["delivery"])
  f.command("positive-again"){put("fillId",id)};val count=f.posts.size;buyer.repo.command("recover");buyer.repo.release();assertEquals(closed,buyer.original(id));assertEquals(count,f.posts.size);assertTrue(runCatching{buyer.repo.reviewPayment()}.isFailure);assertTrue(runCatching{buyer.repo.send()}.isFailure);buyer.repo.archive(id)
  val archived=KeepEquipmentMarketStore(MemoryStore(buyer.disk.value),buyer.store.identity).read().archives;assertEquals(2,archived.size);assertEquals(closed,archived.single{it.key==id}.response);assertEquals(1,f.approvals)
  val report=f.command("inspect"){};assertEquals(1,report.getValue("sends").jsonPrimitive.int);assertEquals(0,report.getValue("deliveries").jsonPrimitive.int);assertEquals(2,report.getValue("releases").jsonPrimitive.int);assertEquals("0",report.charterObject("buyer").charterText("available"));assertEquals("2",report.charterObject("buyer").charterText("market_incoming"));assertEquals("3",report.charterObject("seller").charterText("available"));assertEquals("7",report.charterObject("seller").charterText("market_outgoing"))
 }}
 private fun journey(version:JsonElement)=Fixture(version).use{f->runBlocking {
  var seller=f.client("seller");seller.repo.open();seller.repo.reviewCancel(f.setup.charterObject("initialListing"));seller.repo.confirm()
  val cancellation=requireNotNull(seller.repo.state.value.selectedKey);seller.repo.archive(cancellation)
  seller.repo.reviewListing("route_compass","3",f.setup.charterText("price"));val listingKey=requireNotNull(seller.repo.state.value.selectedKey)
  f.loseNextPost="/keep-equipment-market/listings";assertTrue(runCatching{seller.repo.confirm()}.isFailure)
  assertNull(seller.store.record(listingKey).response);assertTrue(seller.store.record(listingKey).attempts.any{it.startsWith("post:")})
  seller=f.client("seller",MemoryStore(seller.disk.value));seller.repo.selectSaved(listingKey);val listing=requireNotNull(seller.store.record(listingKey).response);seller.repo.archive(listingKey)
  var buyer=f.client("buyer");buyer.repo.open();buyer.repo.reviewFill(listing,"2");val id=requireNotNull(buyer.repo.state.value.selectedKey)
  assertEquals(f.buyerBase,buyer.store.record(id).request.charterText("buyerBaseId"));assertTrue(buyer.store.record(id).attempts.isEmpty())
  f.loseNextPost="/keep-equipment-market/fills";assertTrue(runCatching{buyer.repo.confirm()}.isFailure);assertNull(buyer.store.record(id).response)
  buyer=f.client("buyer",MemoryStore(buyer.disk.value));buyer.repo.selectSaved(id);assertEquals("reserved",buyer.original(id).charterText("status"))
  f.loseNextPost="/keep-equipment-market/fills/$id/prepare";assertTrue(runCatching{buyer.repo.command("prepare")}.isFailure)
  buyer=f.client("buyer",MemoryStore(buyer.disk.value));buyer.repo.selectSaved(id);val preparation=buyer.original(id).charterObject("preparation");assertEquals(version,preparation["transactionVersion"])
  buyer.repo.reviewPayment();buyer.repo.approve(version==JsonPrimitive(0));val signed=requireNotNull(buyer.store.record(id).signed)
  assertEquals(1,f.approvals);assertFalse(f.posts.any{it.endsWith("/signed")||it.endsWith("/deliver")})
  f.loseNextPost="/keep-equipment-market/fills/$id/signed";assertTrue(runCatching{buyer.repo.send()}.isFailure);assertEquals(signed,buyer.store.record(id).signed)
  buyer=f.client("buyer",MemoryStore(buyer.disk.value));buyer.repo.selectSaved(id);assertEquals(signed.charterText("signature"),buyer.original(id).charterObject("wire").charterText("signature"))
  f.loseNextPost="/keep-equipment-market/fills/$id/deliver";assertTrue(runCatching{buyer.repo.send()}.isFailure)
  assertEquals(1,f.posts.count{it.endsWith("/signed")});assertEquals(1,f.posts.count{it.endsWith("/deliver")});assertEquals(1,f.approvals)
  f.command("finalize"){put("fillId",id)};val transfer=f.command("transfer"){};assertNotEquals(f.wallet("buyer"),transfer.charterText("newBuyer"))
  f.command("restart"){put("paused",true)};buyer=f.client("buyer",MemoryStore(buyer.disk.value),true);buyer.repo.open();buyer.repo.selectSaved(id);buyer.repo.command("recover");buyer.repo.command("recover")
  val done=buyer.original(id);assertEquals("delivered",done.charterText("status"));assertEquals(preparation,done["preparation"]);assertEquals(f.buyerBase,done.charterObject("delivery").charterText("buyerBaseId"));assertEquals(signed,buyer.store.record(id).signed)
  assertTrue(buyer.repo.state.value.history!!.getValue("items").jsonArray.any{it.jsonObject.charterText("id")==id&&it.jsonObject.charterText("baseId")==f.buyerBase})
  assertTrue(runCatching{buyer.repo.reviewPayment()}.isFailure);assertTrue(runCatching{buyer.repo.send()}.isFailure);buyer.repo.archive(id)
  val disk=buyer.disk.value;assertTrue(KeepEquipmentMarketStore(MemoryStore(disk),buyer.store.identity).read().archives.any{it.key==id});assertEquals(1,f.approvals)
  val other=f.client("seller",paused=true);other.repo.open();assertTrue(other.store.read().records.none{it.key==id})
  val foreign=f.command("request"){put("actor",f.wallet("seller"));put("method","GET");put("path","/keep-equipment-market/fills/$id")};assertEquals(404,foreign.getValue("status").jsonPrimitive.int)
  val report=f.command("inspect"){};assertEquals(1,report.getValue("sends").jsonPrimitive.int);assertEquals(1,report.getValue("deliveries").jsonPrimitive.int);assertEquals(signed.charterText("signedTransactionHex"),report.charterText("wire"));assertEquals("2",report.charterObject("buyer").charterText("available"))
 }}
 private class Client(val f:Fixture,val actor:String,val disk:MemoryStore,val paused:Boolean){
  val holder=testHolder();private val cookies=SessionCookieJar(f.server.url("/"),MemoryStore()).apply{saveFromResponse(f.server.url("/"),listOf(requireNotNull(Cookie.parse(f.server.url("/"),"pairedActor=${f.wallet(actor)}; Path=/; Secure; HttpOnly"))))}
  private val game=GameApi.withTransport(f.origin,cookies,"native-keep-market-pair",f.transport);private val session=AccountSession(f.wallet(actor),f.origin,game.sessionToken()).also(holder::replace)
  val store=KeepEquipmentMarketStore(disk,StarterIdentity(f.origin,"devnet",f.wallet(actor)))
  private val http=game.keepEquipmentMarketClientPort(store.identity,session.token)
  private val wallet=VehicleWallet(session,holder,f.origin,SolanaCluster.DEVNET,{false},{null},if(paused)null else VehicleExternalSigner{prepared,cluster,retain,beforeWallet,guard->
   assertEquals(SolanaCluster.DEVNET,cluster);guard();beforeWallet();guard();val row=store.read().records.single{it.consent?.purchase?.charterObject("preparation")?.charterText("messageSha256")==prepared.messageSha256};assertTrue("wallet" in row.attempts);assertNull(row.signed)
   f.approvals++;val wire=f.command("sign"){put("purchase",requireNotNull(row.consent).purchase)}.charterObject("wire");val valid=prepared.verifyWire(wire);retain(valid);guard();valid
  })
  private val ports=KeepEquipmentMarketAppPorts(session,holder,KeepEquipmentMarketTransport(http),{if(paused)null else f.pins},
   {CharterLifecycle(true,true,0,!paused,true,"owned-pair-content",false,if(paused)null else f.base(actor))},
   {if(paused)null else f.base(actor)},{base->check(!paused&&base==f.base(actor))},
   KeepEquipmentMarketRpcReads{method,params->http.rpc(method,params){holder.requireCurrent(session)}},wallet,{System.nanoTime()/1_000_000},{})
  val repo=KeepEquipmentMarketRepository(store,ports)
  suspend fun original(id:String)=requireNotNull(store.record(id).response)
 }
 private class Fixture(version:JsonElement):AutoCloseable {
  private val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();private val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();private val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
  val server=MockWebServer().apply{protocols=listOf(Protocol.HTTP_1_1);useHttps(tls.sslSocketFactory(),false);start()};val origin=server.url("/").toString().trimEnd('/')
  val transport=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();private val bridge=Bridge()
  val setup=try{command("start"){put("origin",origin);put("version",version)}}catch(error:Throwable){runCatching{bridge.close()};server.shutdown();transport.dispatcher.executorService.shutdown();throw error}
  val pins=KeepEquipmentMarketSigningTrust.from(setup.charterObject("trust"));val buyerBase=setup.charterText("buyerBaseId")
  private lateinit var active:Client;var approvals=0;val posts=java.util.Collections.synchronizedList(mutableListOf<String>());@Volatile var loseNextPost:String?=null
  init{server.dispatcher=object:okhttp3.mockwebserver.Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
   val actor=request.getHeader("Cookie")?.split(';')?.map{it.trim()}?.singleOrNull{it.startsWith("pairedActor=")}?.substringAfter('=')?:return MockResponse().setResponseCode(401)
   require(actor in listOf(wallet("buyer"),wallet("seller")));val url=requireNotNull(request.requestUrl);val path=url.encodedPath.removePrefix("/api");val method=requireNotNull(request.method);val raw=request.body.readUtf8();val body=if(raw.isEmpty())null else Json.parseToJsonElement(raw).jsonObject
   if(path=="/rpc/solana/devnet"){
    require(method=="POST");val rpc=requireNotNull(body);val response=command("live"){put("method",rpc.getValue("method"));put("params",rpc.getValue("params"))};return MockResponse().setHeader("content-type","application/json").setBody(response.toString())
   }
   if(method=="POST"&&!path.endsWith("/review"))runBlocking{
    val rows=active.store.read().records;val name=path.substringAfterLast('/');val row=if(name in listOf("prepare","signed","recover","deliver","release"))rows.single{it.key==path.split('/')[3]}else rows.single{it.request==body}
    val marker=when(name){"signed"->"upload";"prepare","recover","deliver","release"->name;else->"post"};assertTrue("Durable original must precede HTTP",row.attempts.any{it.startsWith("$marker:")});if(marker in listOf("upload","deliver"))assertNotNull(row.signed)
   }
   val response=command("request"){put("actor",actor);put("method",method);put("path",path);if(url.queryParameterNames.isNotEmpty())put("query",buildJsonObject{url.queryParameterNames.forEach{put(it,requireNotNull(url.queryParameter(it)))}});body?.let{put("body",it)}}
   if(method=="POST")posts.add(path)
   if(method=="POST"&&loseNextPost==path){loseNextPost=null;return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)}
   return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int).setBody(response.charterText("body")).apply{response.charterObject("headers").forEach{(k,v)->addHeader(k,v.jsonPrimitive.content)}}
  }}}
  fun wallet(actor:String)=setup.charterText(actor+"Wallet")
  fun base(actor:String)=setup.charterText(actor+"BaseId")
  fun command(operation:String,fields:JsonObjectBuilder.()->Unit)=bridge.command(buildJsonObject{put("operation",operation);fields()})
  fun client(actor:String,disk:MemoryStore=MemoryStore(),paused:Boolean=false)=Client(this,actor,disk,paused).also{active=it}
  override fun close(){try{bridge.close()}finally{server.shutdown();transport.connectionPool.evictAll();transport.dispatcher.executorService.shutdown()}}
 }
 private class Bridge:AutoCloseable {
  private val url=requireNotNull(System.getenv("PHASE_E_KEEP_MARKET_PAIR_URL")).toHttpUrl().also{require(it.scheme=="http"&&it.host=="127.0.0.1"&&it.encodedPath=="/"&&it.query==null&&it.fragment==null&&it.username.isEmpty()&&it.password.isEmpty())}
  private val token=requireNotNull(System.getenv("PHASE_E_KEEP_MARKET_PAIR_TOKEN")).also{require(it.isNotBlank()&&it.length<=256&&it.all{c->c.code in 33..126})}
  private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(60,TimeUnit.SECONDS).build()
  @Synchronized fun command(value:JsonObject):JsonObject {val request=Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build();return http.newCall(request).execute().use{response->val body=requireNotNull(response.body);require(body.contentLength()<=1_048_576&&!body.source().request(1_048_577));val raw=Json.parseToJsonElement(body.string()).jsonObject;check(response.isSuccessful){"Private market command refused: ${value.charterText("operation")}: $raw"};raw}}
  override fun close(){try{command(buildJsonObject{put("operation","close")})}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 }
}
