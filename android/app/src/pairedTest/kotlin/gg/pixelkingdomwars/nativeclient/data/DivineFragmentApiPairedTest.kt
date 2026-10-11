package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
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

/** Root owns actual trial/source/SQL setup. Native owns every consent and authenticated custody command. */
class DivineFragmentApiPairedTest {
 @Test fun `actual earned delivery and permanent spot claim survive lost replies cold source pause and transfer`()=Fixture().use{f->runBlocking{
  var c=f.client();c.repo.discoverEntry();assertTrue(c.repo.state.value.available);c.repo.discover("awards")
  val award=c.repo.state.value.awards!!.fr("rows").single{it.fo("award").ft("eventId")==f.event}.fo("award")
  assertEquals(f.actor,award.ft("wallet"));c.repo.reviewDelivery(f.event);val delivery=c.store.read().commands.single()
  f.loseNextPost=delivery.path;assertTrue(runCatching{c.repo.confirm(c.repo.state.value.review!!)}.isFailure)
  val unknownDelivery=c.store.read().commands.single();assertTrue(unknownDelivery.sent);assertNull(unknownDelivery.receipt);assertEquals(1,f.posts.size)
  f.command("restart"){put("paused",true);put("termSource",false)};f.selected=f.otherBase
  c=f.client(MemoryStore(c.disk.value));c.repo.local();c.repo.check(delivery.key)
  val delivered=c.store.read().commands.single().receipt!!;assertEquals(f.base,delivered.ft("baseId"));assertEquals(award["net"],delivered["quantity"]);assertNull(c.repo.state.value.stock);assertEquals(1,f.posts.size)
  // Source pause is independent of delivery and permanent rights. Destination authority remains current.
  f.selected=f.base;c.repo.dismiss();c.repo.discover("claims")
  var page=c.repo.state.value.claims!!;var row=page.fr("rows").singleOrNull{it.ft("termId")==f.term&&it.fn("spotId")==f.spot}
  while(row==null&&page["nextCursor"]!=JsonNull){c.repo.discover("claims",page.ft("nextCursor"));page=c.repo.state.value.claims!!;row=page.fr("rows").singleOrNull{it.ft("termId")==f.term&&it.fn("spotId")==f.spot}}
  c.repo.reviewClaim(requireNotNull(row));val claim=c.store.read().commands.last();assertEquals("claim",claim.kind)
  f.loseNextPost=claim.path;assertTrue(runCatching{c.repo.confirm(c.repo.state.value.review!!)}.isFailure)
  assertNull(c.store.read().commands.last().receipt);assertEquals(2,f.posts.size)
  f.command("transfer"){put("baseId",f.base)};f.transferred=true;f.selected=f.otherBase
  f.command("restart"){put("paused",true);put("termSource",false)}
  c=f.client(MemoryStore(c.disk.value));c.repo.local();c.repo.check(claim.key)
  val claimed=c.store.read().commands.last().receipt!!;assertEquals(f.base,claimed.ft("baseId"));assertEquals(f.term,claimed.ft("termId"));assertEquals(f.spot,claimed.fn("spotId"));assertNull(c.repo.state.value.stock)
  c.repo.check(delivery.key);c.repo.check(claim.key);assertEquals(2,f.posts.size);assertEquals(delivered,c.store.read().commands.first().receipt)
  val inspect=f.command("inspect"){};assertEquals(1L,inspect.fn("deliveryCount"));assertEquals(1L,inspect.fn("claimCount"));assertEquals(claimed.ft("stockAfter"),inspect.ft("originalBaseStock"));assertEquals(delivered.fa("stockAfter")+claimed.fa("quantity"),claimed.fa("stockAfter"))
  // Distinct authenticated actors never adopt this encrypted journal or its receipts.
  assertTrue(runCatching{DivineFragmentStore(MemoryStore(c.disk.value),StarterIdentity(f.origin,"devnet",f.otherActor)).read()}.isFailure)
  val other=f.request(f.otherActor,"GET",delivery.receiptPath,null,emptyMap());assertTrue(other.fn("status") in listOf(200L,404L));if(other.fn("status")==200L)assertEquals(JsonNull,Json.parseToJsonElement(other.ft("body")).jsonObject["receipt"])
  val unauth=f.request("unknown","GET",delivery.receiptPath,null,emptyMap());assertEquals(401L,unauth.fn("status"));assertEquals(2,f.posts.size)
  f.offline=true;val saved=c.store.read();assertEquals(saved,DivineFragmentStore(MemoryStore(c.disk.value),c.store.identity).read())
 }}
 private class Client(val f:Fixture,val disk:MemoryStore){
  private val holder=testHolder();private val cookies=SessionCookieJar(f.server.url("/"),MemoryStore()).apply{saveFromResponse(f.server.url("/"),listOf(requireNotNull(Cookie.parse(f.server.url("/"),"pairedActor=${f.actor}; Path=/; Secure; HttpOnly"))))}
  private val game=GameApi.withTransport(f.origin,cookies,"native-divine-fragment-pair",f.transport);private val session=AccountSession(f.actor,f.origin,game.sessionToken()).also(holder::replace)
  val store=DivineFragmentStore(disk,StarterIdentity(f.origin,"devnet",f.actor))
  private val ports=DivineFragmentAppPorts(session,holder,DivineFragmentTransport(DivineFragmentHttpPort(game.charterClientPort(store.identity,session.token))),{f.setup.fo("catalogue")},{CharterLifecycle(true,true,1,true,true,"paired-content",false,f.selected)},{f.selected},{base->require(!f.transferred&&base==f.base&&base==f.selected)},{})
  val repo=DivineFragmentRepository(store,ports)
 }
 private class Fixture:AutoCloseable {
  private val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();private val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();private val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
  val server=MockWebServer().apply{protocols=listOf(Protocol.HTTP_1_1);useHttps(tls.sslSocketFactory(),false);start()};val origin=server.url("/").toString().trimEnd('/')
  val transport=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();private val bridge=Bridge()
  val setup=try{command("start"){put("origin",origin)}}catch(e:Throwable){runCatching{bridge.close()};server.shutdown();transport.dispatcher.executorService.shutdown();throw e}
  val actor=setup.ft("wallet");val otherActor=setup.ft("otherWallet");val base=setup.ft("baseId");val otherBase=setup.ft("otherBaseId");val event=setup.ft("eventId");val term=setup.ft("termId");val spot=setup.fn("spotId")
  @Volatile var selected=base;@Volatile var transferred=false;private lateinit var active:Client
  val posts=java.util.Collections.synchronizedList(mutableListOf<String>());@Volatile var loseNextPost:String?=null;@Volatile var offline=false
  init{DivineFragmentRules.installed(setup.fo("policy"),setup.fo("catalogue"));server.dispatcher=object:okhttp3.mockwebserver.Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   if(offline)return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
   val actor=request.getHeader("Cookie")?.split(';')?.map{it.trim()}?.singleOrNull{it.startsWith("pairedActor=")}?.substringAfter('=')?:return MockResponse().setResponseCode(401)
   val url=requireNotNull(request.requestUrl);val path=url.encodedPath.removePrefix("/api");require(path.startsWith("/divine-fragments/"));val method=requireNotNull(request.method);val raw=request.body.readUtf8();val body=if(raw.isEmpty())null else Json.parseToJsonElement(raw).jsonObject;val query=url.queryParameterNames.associateWith{requireNotNull(url.queryParameter(it))}
   if(method=="POST")runBlocking{val c=active.store.read().commands.single{it.path==path&&it.consent.fo("request")==body};assertTrue("Exact consent and sent marker persisted before HTTP",c.sent);assertEquals(actor,c.consent.ft("wallet"))}
   val response=this@Fixture.request(actor,method,path,body,query)
   if(method=="POST")posts.add(path);if(method=="POST"&&loseNextPost==path){loseNextPost=null;return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)}
   return MockResponse().setResponseCode(response.fn("status").toInt()).setBody(response.ft("body")).apply{response.fo("headers").forEach{(k,v)->addHeader(k,v.jsonPrimitive.content)}}
  }}}
  fun request(actor:String,method:String,path:String,body:JsonObject?,query:Map<String,String>)=command("request"){put("actor",actor);put("method",method);put("path",path);if(query.isNotEmpty())put("query",buildJsonObject{query.forEach{(k,v)->put(k,v)}});body?.let{put("body",it)}}
  fun command(operation:String,fields:JsonObjectBuilder.()->Unit)=bridge.command(buildJsonObject{put("operation",operation);fields()})
  fun client(disk:MemoryStore=MemoryStore())=Client(this,disk).also{active=it}
  override fun close(){try{bridge.close()}finally{server.shutdown();transport.connectionPool.evictAll();transport.dispatcher.executorService.shutdown()}}
 }
 private class Bridge:AutoCloseable {
  private val url=requireNotNull(System.getenv("PHASE_E_DIVINE_FRAGMENT_PAIR_URL")).toHttpUrl().also{require(it.scheme=="http"&&it.host=="127.0.0.1"&&it.encodedPath=="/"&&it.query==null&&it.fragment==null&&it.username.isEmpty()&&it.password.isEmpty())}
  private val token=requireNotNull(System.getenv("PHASE_E_DIVINE_FRAGMENT_PAIR_TOKEN")).also{require(it.isNotBlank()&&it.length<=256&&it.all{c->c.code in 33..126})}
  private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).readTimeout(60,TimeUnit.SECONDS).callTimeout(60,TimeUnit.SECONDS).build()
  @Synchronized fun command(value:JsonObject):JsonObject{val request=Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build();return http.newCall(request).execute().use{r->val b=requireNotNull(r.body);require(b.contentLength()<=DivineFragmentProtocol.MAX_BYTES&&!b.source().request(DivineFragmentProtocol.MAX_BYTES+1L));val raw=Json.parseToJsonElement(b.string()).jsonObject;check(r.isSuccessful){"Private fragment fixture refused ${value.ft("operation")}"};raw}}
  override fun close(){try{command(buildJsonObject{put("operation","close")})}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 }
}
