package gg.pixelkingdomwars.nativeclient.retirement

import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class RetirementHttpTest {
 private class Memory:SecretStore {var value:String?=null;override fun read()=value;override fun write(value:String){this.value=value};override fun clear(){value=null}}
 private val draft=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterRetirement.json")).readText()).jsonObject.charterObject("draft")
 private val path=RetirementProtocol.ROOT+"/"+draft.charterText("id")
 private fun tls(listener:EventListener.Factory=EventListener.Factory{object:EventListener(){}},block:(MockWebServer,OkHttpClient)->Unit){
  val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();val identity=HandshakeCertificates.Builder().heldCertificate(cert).build();val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
  val client=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).eventListenerFactory(listener).build()
  try{MockWebServer().use{s->s.protocols=listOf(Protocol.HTTP_1_1);s.useHttps(identity.sslSocketFactory(),false);s.start();block(s,client)}}finally{client.connectionPool.evictAll();client.dispatcher.executorService.shutdown()}
 }
 private inner class Fixture(s:MockWebServer,client:OkHttpClient){
  val memory=Memory();val jar=SessionCookieJar(s.url("/"),memory);val token=jar.sessionToken();val identity=StarterIdentity(s.url("/").toString().trimEnd('/'),"devnet",draft.charterText("actor"))
  val api=GameApi.withTransport(s.url("/").toString(),jar,"retirement-test",client);val port=RetirementHttpPort(api.charterClientPort(identity,token));val transport=RetirementTransport(port)
  init{jar.saveFromResponse(s.url("/"),listOf(requireNotNull(Cookie.parse(s.url("/"),"session=original; Path=/; Secure; HttpOnly"))))}
 }
 @Test fun `exact create and original lookup share authenticated session and retain only one frozen intent`()=tls{s,client->runBlocking{
  val f=Fixture(s,client);val fields=draft.charterObject("request").toMutableMap();val original=JsonObject(fields.toMap());var count=0
  s.enqueue(MockResponse().setResponseCode(201).setBody(draft.toString()))
  f.transport.request("POST",RetirementProtocol.ROOT,JsonObject(fields),{fields["clanId"]=JsonPrimitive("changed")}){assertEquals(draft,it);count++}
  val sent=requireNotNull(s.takeRequest(3,TimeUnit.SECONDS));assertEquals("/api"+RetirementProtocol.ROOT,sent.path);assertEquals(original.toString(),sent.body.readUtf8());assertEquals("session=original",sent.getHeader("Cookie"));assertEquals(1,count)
  val key=draft.charterObject("request").charterText("idempotencyKey");val absent=buildJsonObject{put("version",1);put("actor",f.identity.wallet);put("idempotencyKey",key);put("draft",JsonNull)}
  s.enqueue(MockResponse().setBody(absent.toString()));f.transport.request("GET",RetirementProtocol.ROOT+"/by-key/"+key,null,{}){assertEquals(absent,it)}
  val get=requireNotNull(s.takeRequest(3,TimeUnit.SECONDS));assertEquals("GET",get.method);assertEquals(0,get.bodySize);assertEquals(2,s.requestCount)
 }}
 @Test fun `foreign original and redirects are refused without retention cookie changes or retries`()=tls{s,client->
  val f=Fixture(s,client);val before=f.memory.value
  for(raw in listOf(JsonObject(draft+("id" to draft.getValue("fenceId"))),JsonObject(draft+("actor" to draft.charterObject("operation").charterObject("original").charterObject("creation").charterObject("chain").getValue("economyProgram"))))){
   s.enqueue(MockResponse().setBody(raw.toString()).addHeader("Set-Cookie","session=foreign; Path=/; Secure; HttpOnly"));assertThrows(Exception::class.java){runBlocking{f.transport.request("GET",path,null,{}){fail("Foreign receipt retained")}}};assertEquals(before,f.memory.value)
  }
  s.enqueue(MockResponse().setResponseCode(307).addHeader("Location",s.url("/elsewhere")))
  assertThrows(Exception::class.java){runBlocking{f.transport.request("POST",path+"/prepare",buildJsonObject{},{}){fail("Redirect retained")}}}
  assertEquals(3,s.requestCount);assertEquals(before,f.memory.value)
  assertThrows(Exception::class.java){runBlocking{f.port.request("POST",path+"/prepare",emptyMap(),buildJsonObject{put("extra",true)},{},{})}};assertEquals(3,s.requestCount)
 }
 @Test fun `owned response drains after cancellation before stale session cookies can publish`() {
  lateinit var job:Job;var cancelled=false
  tls(EventListener.Factory{object:EventListener(){override fun responseBodyStart(call:Call){job.cancel();cancelled=call.isCanceled()}}}){s,client->runBlocking{
   val f=Fixture(s,client);val before=f.memory.value;var retained=false
   s.enqueue(MockResponse().setChunkedBody(draft.toString(),128).addHeader("Set-Cookie","session=obsolete; Path=/; Secure; HttpOnly"))
   job=launch(start=CoroutineStart.LAZY){try{f.transport.request("GET",path,null,{}){yield();retained=true}}catch(_:CancellationException){}}
   job.start();withTimeout(5000){job.join()};assertTrue(retained);assertFalse(cancelled);assertEquals(before,f.memory.value);assertEquals(1,s.requestCount)
  }}
 }
 @Test fun `bounded owned malformed terminal evidence reaches custody before full validation fails`()=tls{s,client->
  val f=Fixture(s,client);val before=f.memory.value
  val operation=JsonObject(draft.charterObject("operation")+("status" to JsonPrimitive("completed")))
  val damaged=JsonObject(draft+("operation" to operation));val key=draft.charterObject("request").charterText("idempotencyKey")
  val byKey=buildJsonObject{put("version",1);put("actor",f.identity.wallet);put("idempotencyKey",key);put("draft",damaged)}
  for((url,value) in listOf(path to damaged,(RetirementProtocol.ROOT+"/by-key/"+key) to byKey)){
   var owned:JsonElement?=null;s.enqueue(MockResponse().setBody(value.toString()).addHeader("Set-Cookie","session=damaged; Path=/; Secure; HttpOnly"))
   assertThrows(Exception::class.java){runBlocking{f.transport.request("GET",url,null,{}){owned=it}}}
   assertEquals(value,owned);assertEquals(before,f.memory.value)
  }
  assertEquals(2,s.requestCount)
 }
}
