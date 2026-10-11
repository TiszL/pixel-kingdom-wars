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

/** Native HTTP/session, journal, sign-only wallet and current checks against the
 * actual API/SQL and earned Divine stock fixture. SecretStore uses its JVM memory
 * adapter. RPC finality is simulated here; actual SPL credit/burn is separate. */
class KeepFragmentMarketApiPairTest {
 @Test fun `earned fragments buy once survive lost replies and can be relisted without buying personal rights`()=Fixture(JsonPrimitive(0)).use{f->runBlocking {
  val root=KeepEquipmentMarketProtocol.ROOT
  val item=f.setup.charterText("itemId");val quantity=f.setup.charterText("quantity")
  assertEquals("crystal_fragment",item);assertEquals("3",quantity)
  val listing=f.setup.charterObject("initialListing");assertEquals(item,listing.charterText("itemId"))
  var buyer=f.client("buyer");buyer.repo.open()
  val stock=requireNotNull(buyer.repo.state.value.stock)
  assertEquals(JsonPrimitive(4),stock["catalogueVersion"]);assertEquals(14,stock.getValue("items").jsonArray.size)
  assertTrue(buyer.repo.state.value.listings!!.getValue("items").jsonArray.none{it.jsonObject["id"]==listing["id"]})
  buyer.repo.browse("resources")
  assertTrue(buyer.repo.state.value.listings!!.getValue("items").jsonArray.any{it.jsonObject["id"]==listing["id"]})
  for(path in listOf("listings","history"))assertEquals(mapOf("catalogueVersion" to "4","category" to "resources"),f.reads.last{it.first=="$root/$path"}.second)
  val oldPage=f.command("request"){put("actor",f.wallet("buyer"));put("method","GET");put("path","$root/listings")}
  assertEquals(200,oldPage.getValue("status").jsonPrimitive.int)
  assertTrue(Json.parseToJsonElement(oldPage.charterText("body")).jsonObject.getValue("items").jsonArray.none{it.jsonObject["id"]==listing["id"]})

  buyer.repo.reviewFill(listing,quantity);val id=requireNotNull(buyer.repo.state.value.selectedKey)
  val originalRequest=buyer.store.record(id).request
  assertEquals(f.buyerBase,originalRequest.charterText("buyerBaseId"));assertTrue(buyer.store.record(id).attempts.isEmpty())
  buyer.repo.browse("items");assertEquals(id,buyer.repo.state.value.selectedKey);assertEquals(originalRequest,buyer.store.record(id).request);assertTrue(f.posts.isEmpty())
  buyer.repo.browse("resources")
  f.loseNextPost="$root/fills";assertTrue(runCatching{buyer.repo.confirm()}.isFailure);assertNull(buyer.store.record(id).response)
  buyer=f.client("buyer",MemoryStore(buyer.disk.value));buyer.repo.selectSaved(id)
  assertEquals("reserved",buyer.original(id).charterText("status"));assertEquals(item,buyer.original(id).charterObject("fill").charterText("itemId"))
  assertEquals(originalRequest,buyer.store.record(id).request);assertEquals(1,f.posts.count{it=="$root/fills"})
  assertEquals("2",f.command("claim-source-share"){}.charterText("quantity"))
  assertTrue(f.reads.last{it.first=="$root/fills/$id"}.second.isEmpty())
  f.loseNextPost="$root/fills/$id/prepare";assertTrue(runCatching{buyer.repo.command("prepare")}.isFailure)
  buyer=f.client("buyer",MemoryStore(buyer.disk.value));buyer.repo.selectSaved(id)
  val preparation=buyer.original(id).charterObject("preparation");assertEquals(JsonPrimitive(0),preparation["transactionVersion"])
  buyer.repo.reviewPayment();buyer.repo.approve(true);val signed=requireNotNull(buyer.store.record(id).signed)
  assertEquals(1,f.approvals);assertFalse(f.posts.any{it.endsWith("/signed")||it.endsWith("/deliver")})
  f.loseNextPost="$root/fills/$id/signed";assertTrue(runCatching{buyer.repo.send()}.isFailure)
  buyer=f.client("buyer",MemoryStore(buyer.disk.value));buyer.repo.selectSaved(id)
  assertEquals(signed.charterText("signature"),buyer.original(id).charterObject("wire").charterText("signature"))
  f.loseNextPost="$root/fills/$id/deliver";assertTrue(runCatching{buyer.repo.send()}.isFailure)
  assertEquals(1,f.posts.count{it.endsWith("/signed")});assertEquals(1,f.posts.count{it.endsWith("/deliver")});assertEquals(1,f.approvals)

  f.command("finalize"){put("fillId",id)};f.command("restart"){put("paused",true)}
  buyer=f.client("buyer",MemoryStore(buyer.disk.value),true);buyer.repo.open();buyer.repo.selectSaved(id)
  f.loseNextPost="$root/fills/$id/recover";assertTrue(runCatching{buyer.repo.command("recover")}.isFailure)
  val recoveryPosts=f.posts.size
  buyer=f.client("buyer",MemoryStore(buyer.disk.value),true);buyer.repo.open();val pausedBrowse=runCatching{buyer.repo.browse("resources")}.exceptionOrNull();assertTrue(pausedBrowse is ApiException && pausedBrowse.status==503 && pausedBrowse.code=="KEEP_EQUIPMENT_MARKET_DISABLED");buyer.repo.selectSaved(id);buyer.repo.command("recover")
  val done=buyer.original(id)
  assertEquals("delivered",done.charterText("status"));assertEquals(preparation,done["preparation"]);assertEquals(signed,buyer.store.record(id).signed)
  assertEquals(f.buyerBase,done.charterObject("delivery").charterText("buyerBaseId"));assertEquals(quantity,done.charterObject("delivery").charterText("quantity"));assertEquals(recoveryPosts,f.posts.size)
  assertTrue(buyer.repo.state.value.history!!.getValue("items").jsonArray.any{it.jsonObject.charterText("id")==id&&it.jsonObject.charterText("baseId")==f.buyerBase})

  buyer.repo.archive(id)
  // The buyer can sell delivered stock again. A purchase never changes the
  // personal winning award or the original permanent Seeker entitlement.
  f.command("restart"){put("paused",false)}
  val resaleClient=f.client("buyer",MemoryStore(buyer.disk.value));resaleClient.repo.open()
  resaleClient.repo.reviewListing(item,quantity,f.setup.charterText("price"));val resaleId=requireNotNull(resaleClient.repo.state.value.selectedKey)
  resaleClient.repo.confirm();val resale=resaleClient.original(resaleId);resaleClient.repo.archive(resaleId)
  resaleClient.repo.reviewCancel(resale);val cancelId=requireNotNull(resaleClient.repo.state.value.selectedKey);resaleClient.repo.confirm();resaleClient.repo.archive(cancelId)
  val seller=f.client("seller");seller.repo.open();seller.repo.reviewCancel(listing);val sellerCancel=requireNotNull(seller.repo.state.value.selectedKey);seller.repo.confirm();seller.repo.archive(sellerCancel)
  f.command("restart"){put("paused",true)}
  val beforeHistorical=f.posts.size
  buyer=f.client("buyer",MemoryStore(resaleClient.disk.value),true);buyer.repo.open()
  val originalArchive=buyer.store.read().archives.single{it.key==id};assertEquals(done,originalArchive.response);assertEquals(originalRequest,originalArchive.request)
  assertEquals(beforeHistorical,f.posts.size)
  val archived=KeepEquipmentMarketStore(MemoryStore(buyer.disk.value),buyer.store.identity).read().archives.single{it.key==id}
  assertEquals(done,archived.response);assertEquals(signed,archived.signed)
  val other=f.client("seller",paused=true);other.repo.open();assertTrue(other.store.read().records.none{it.key==id})
  val foreign=f.command("request"){put("actor",f.wallet("seller"));put("method","GET");put("path","$root/fills/$id")}
  assertEquals(404,foreign.getValue("status").jsonPrimitive.int)
  val report=f.command("inspect"){}
  assertEquals(1,report.getValue("sends").jsonPrimitive.int);assertEquals(1,report.getValue("deliveries").jsonPrimitive.int);assertEquals(1,report.getValue("releases").jsonPrimitive.int)
  assertEquals(signed.charterText("signedTransactionHex"),report.charterText("wire"));assertEquals(1,f.approvals)
  assertEquals("3",report.charterObject("buyer").charterText("available"));assertEquals("0",report.charterObject("buyer").charterText("market_incoming"))
  assertEquals(f.setup.charterText("expectedSellerAvailable"),report.charterObject("seller").charterText("available"));assertEquals("0",report.charterObject("seller").charterText("market_outgoing"))
  assertEquals(JsonPrimitive(true),report["originalSourceUnchanged"])
 }}
 private class Client(val f:Fixture,val actor:String,val disk:MemoryStore,val paused:Boolean){
  val holder=testHolder();private val cookies=SessionCookieJar(f.server.url("/"),MemoryStore()).apply{saveFromResponse(f.server.url("/"),listOf(requireNotNull(Cookie.parse(f.server.url("/"),"pairedActor=${f.wallet(actor)}; Path=/; Secure; HttpOnly"))))}
  private val game=GameApi.withTransport(f.origin,cookies,"native-keep-fragment-market-pair",f.transport);private val session=AccountSession(f.wallet(actor),f.origin,game.sessionToken()).also(holder::replace)
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
  private lateinit var active:Client;var approvals=0;val posts=java.util.Collections.synchronizedList(mutableListOf<String>());val reads=java.util.Collections.synchronizedList(mutableListOf<Pair<String,Map<String,String>>>());@Volatile var loseNextPost:String?=null
  init{server.dispatcher=object:okhttp3.mockwebserver.Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse {
   val actor=request.getHeader("Cookie")?.split(';')?.map{it.trim()}?.singleOrNull{it.startsWith("pairedActor=")}?.substringAfter('=')?:return MockResponse().setResponseCode(401)
   require(actor in listOf(wallet("buyer"),wallet("seller")));val url=requireNotNull(request.requestUrl);val path=url.encodedPath.removePrefix("/api");val method=requireNotNull(request.method);val raw=request.body.readUtf8();val body=if(raw.isEmpty())null else Json.parseToJsonElement(raw).jsonObject
   if(method=="GET")reads.add(path to url.queryParameterNames.associateWith{requireNotNull(url.queryParameter(it))})
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
  private val url=requireNotNull(System.getenv("PHASE_E_KEEP_FRAGMENT_MARKET_PAIR_URL")).toHttpUrl().also{require(it.scheme=="http"&&it.host=="127.0.0.1"&&it.encodedPath=="/"&&it.query==null&&it.fragment==null&&it.username.isEmpty()&&it.password.isEmpty())}
  private val token=requireNotNull(System.getenv("PHASE_E_KEEP_FRAGMENT_MARKET_PAIR_TOKEN")).also{require(it.isNotBlank()&&it.length<=256&&it.all{c->c.code in 33..126})}
  private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(60,TimeUnit.SECONDS).build()
  @Synchronized fun command(value:JsonObject):JsonObject {val request=Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build();return http.newCall(request).execute().use{response->val body=requireNotNull(response.body);require(body.contentLength()<=1_048_576&&!body.source().request(1_048_577));val raw=Json.parseToJsonElement(body.string()).jsonObject;check(response.isSuccessful){"Private market command refused: ${value.charterText("operation")}: $raw"};raw}}
  override fun close(){try{command(buildJsonObject{put("operation","close")})}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 }
}
