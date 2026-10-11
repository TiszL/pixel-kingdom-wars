package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.divine.*
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

/** Root controls only fixture time/source and API; the actual native actor owns every request. */
class DivineTrialApiPairedTest {
 @Test fun `actual fixed trial command prize and cold originals survive lost replies and provider outage`()=Fixture().use{f->runBlocking{
  var c=f.client();c.repo.discover();val event=c.repo.state.value.discovery!!.drows("events").single{it.dt("id")==f.text("eventId")};c.repo.select(event);c.repo.enter(f.base)
  f.command("advance"){put("stage","play")};c.repo.admit(f.base);val attempt=c.repo.state.value.selected!!.participant!!.drows("attempts").single();val attemptId=attempt.dt("id")
  f.loseNextPost="/divine-trials/attempts/$attemptId/submit";assertTrue(runCatching{c.repo.submit(attemptId,f.setup.dobj("orders"))}.isFailure);val original=c.store.read().events.single().commands.last();assertEquals("submit",original.kind);assertTrue(original.sent);assertNull(original.response)
  c=f.client(MemoryStore(c.disk.value));c.repo.reopen(event.dt("id"));c.repo.retry(original.id);val complete=c.store.read().events.single().participant!!.drows("attempts").single();assertEquals("completed",complete.dt("status"));assertEquals(f.setup["orders"],complete["orders"]);assertEquals(1,f.posts.count{it.endsWith("/submit")})
  f.command("advance"){put("stage","close")};c.repo.discover();c.repo.select(c.repo.state.value.discovery!!.drows("events").single{it.dt("id")==event.dt("id")});assertNotNull(c.repo.state.value.selected!!.event.doptional("terminal"));assertNotNull(c.repo.state.value.selected!!.participant!!.doptional("prize"))
  f.loseNextPost="/divine-trials/events/${event.dt("id")}/prize";assertTrue(runCatching{c.repo.claim(f.base)}.isFailure);val claim=c.store.read().events.single().commands.last();assertNull(claim.response)
  f.command("restart"){put("paused",true);put("providerless",false)};c=f.client(MemoryStore(c.disk.value),paused=true);c.repo.reopen(event.dt("id"));c.repo.retry(claim.id);val saved=c.store.read().events.single();assertEquals(f.base,saved.commands.last().response!!.dt("baseId"));assertEquals(complete,saved.participant!!.drows("attempts").single());assertEquals(1,f.posts.count{it.endsWith("/prize")})
  f.command("restart"){put("paused",true);put("providerless",true)};c=f.client(MemoryStore(c.disk.value),paused=true);c.repo.local();assertTrue(runCatching{c.repo.reopen(event.dt("id"))}.isFailure);assertEquals(saved.commands,c.store.read().events.single().commands);assertTrue(runCatching{c.repo.admit(f.base)}.isFailure)
  f.offline=true;assertEquals(c.store.read(),DivineTrialStore(MemoryStore(c.disk.value),c.store.identity).read());assertEquals(4,f.posts.size);assertTrue(f.posts.all{it.startsWith("/divine-trials/")})
 }}
 private class Client(val f:Fixture,val disk:MemoryStore,paused:Boolean){
  private val holder=testHolder();private val cookies=SessionCookieJar(f.server.url("/"),MemoryStore()).apply{saveFromResponse(f.server.url("/"),listOf(requireNotNull(Cookie.parse(f.server.url("/"),"pairedActor=${f.actor}; Path=/; Secure; HttpOnly"))))}
  private val game=GameApi.withTransport(f.origin,cookies,"native-divine-trial-pair",f.transport);private val session=AccountSession(f.actor,f.origin,game.sessionToken()).also(holder::replace)
  val store=DivineTrialStore(disk,StarterIdentity(f.origin,"devnet",f.actor))
  private val catalogue=buildJsonObject{put("constants",JsonObject(f.setup.dobj("validationConstants")+mapOf("PHASE_E_DIVINE_TRIALS" to JsonObject(f.setup.dobj("policy")-setOf("prizeItems","fragments","prizeSource","tieBreak","heroes","energy")),"CAMPAIGN" to buildJsonObject{put("encounters",JsonArray(List(f.setup.dobj("policy").dn("campaignStage").toInt()){buildJsonObject{put("keepLevel",f.setup.dobj("validationConstants").getValue("campaignKeepLevel"))}}))}))) }
  private val ports=DivineTrialAppPorts(session,holder,DivineTransport(DivineHttpPort(game.charterClientPort(store.identity,session.token))),{catalogue},{CharterLifecycle(true,true,1,!paused,true,"paired-content",false,"paired-base")},{require(it==f.base)},{})
  val repo=DivineTrialRepository(store,ports)
 }
 private class Fixture:AutoCloseable{
  private val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();private val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();private val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
  val server=MockWebServer().apply{protocols=listOf(Protocol.HTTP_1_1);useHttps(tls.sslSocketFactory(),false);start()};val origin=server.url("/").toString().trimEnd('/')
  val transport=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();private val bridge=Bridge()
  val setup=try{command("start"){put("origin",origin)}}catch(e:Throwable){runCatching{bridge.close()};server.shutdown();transport.dispatcher.executorService.shutdown();throw e}
  val actor=text("wallet");val base=text("baseId");private lateinit var active:Client
  val posts=java.util.Collections.synchronizedList(mutableListOf<String>());@Volatile var loseNextPost:String?=null;@Volatile var offline=false
  init{DivineRules.installed(setup.dobj("policy"),setup.dobj("validationConstants"));server.dispatcher=object:okhttp3.mockwebserver.Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
   if(offline)return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
   val actor=request.getHeader("Cookie")?.split(';')?.map{it.trim()}?.singleOrNull{it.startsWith("pairedActor=")}?.substringAfter('=')?:return MockResponse().setResponseCode(401);require(actor==this@Fixture.actor)
   val url=requireNotNull(request.requestUrl);val path=url.encodedPath.removePrefix("/api");require(path.startsWith("/divine-trials/"));val method=requireNotNull(request.method);val raw=request.body.readUtf8();val body=if(raw.isEmpty())null else Json.parseToJsonElement(raw).jsonObject;val query=url.queryParameterNames.associateWith{requireNotNull(url.queryParameter(it))}
   if(method=="POST")runBlocking{val e=active.store.read().events.single();val c=e.commands.single{active.store.path(e.id,it)==path&&it.request==body};assertTrue("Durable original before HTTP",c.sent)}
   val response=command("request"){put("actor",actor);put("method",method);put("path",path);if(query.isNotEmpty())put("query",buildJsonObject{query.forEach{(k,v)->put(k,v)}});body?.let{put("body",it)}}
   if(method=="POST")posts.add(path);if(method=="POST"&&loseNextPost==path){loseNextPost=null;return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)}
   return MockResponse().setResponseCode(response.dn("status").toInt()).setBody(response.getValue("body").jsonPrimitive.content).apply{response.dobj("headers").forEach{(k,v)->addHeader(k,v.jsonPrimitive.content)}}
  }}}
  fun text(key:String)=setup.dt(key)
  fun command(operation:String,fields:JsonObjectBuilder.()->Unit)=bridge.command(buildJsonObject{put("operation",operation);fields()})
  fun client(disk:MemoryStore=MemoryStore(),paused:Boolean=false)=Client(this,disk,paused).also{active=it}
  override fun close(){try{bridge.close()}finally{server.shutdown();transport.connectionPool.evictAll();transport.dispatcher.executorService.shutdown()}}
 }
 private class Bridge:AutoCloseable {
  private val url=requireNotNull(System.getenv("PHASE_E_DIVINE_TRIAL_PAIR_URL")).toHttpUrl().also{require(it.scheme=="http"&&it.host=="127.0.0.1"&&it.encodedPath=="/"&&it.query==null&&it.fragment==null&&it.username.isEmpty()&&it.password.isEmpty())}
  private val token=requireNotNull(System.getenv("PHASE_E_DIVINE_TRIAL_PAIR_TOKEN")).also{require(it.isNotBlank()&&it.length<=256&&it.all{c->c.code in 33..126})}
  private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).readTimeout(60,TimeUnit.SECONDS).callTimeout(60,TimeUnit.SECONDS).build()
  @Synchronized fun command(value:JsonObject):JsonObject{val request=Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build();return http.newCall(request).execute().use{r->val b=requireNotNull(r.body);require(b.contentLength()<=DivineGrammar.MAX_RESPONSE_BYTES&&!b.source().request(DivineGrammar.MAX_RESPONSE_BYTES+1L));val raw=Json.parseToJsonElement(b.string()).jsonObject;check(r.isSuccessful){"Private trial fixture refused ${value.dt("operation")}"};raw}}
  override fun close(){try{command(buildJsonObject{put("operation","close")})}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 }
}
