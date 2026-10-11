package gg.pixelkingdomwars.nativeclient.network
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.vehicle.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
class VehicleHttpTest {
 @Test fun `craft preview and v2 candidates use authenticated fixed routes without admitting crafting`()=tls{s,http->val f=F(s,http);val vectors=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/vehicle-craft-vectors.json")).readText()).jsonObject;val quote=vectors.getValue("quote").jsonObject
  s.enqueue(MockResponse().setBody(quote.toString()));val transport=VehicleTransport(VehicleHttpPort(f.port));val request=buildJsonObject{put("baseId",quote.getValue("baseId"));put("family","survey_balloon");put("tier",1);put("recipeVersion",1)}
  val got=runBlocking{transport.request("POST","/vehicles/craft/quote",request,{})};assertEquals(quote,VehicleCraftProtocol.quote(got));val sent=s.takeRequest();assertEquals("/api/vehicles/craft/quote",sent.path);assertEquals("session=original",sent.getHeader("Cookie"));assertEquals(request.toString(),sent.body.readUtf8())
  assertThrows(Exception::class.java){runBlocking{transport.request("POST","/vehicles/craft/reserve",request,{})}};assertEquals(1,s.requestCount)
  s.enqueue(MockResponse().setBody("{}"));runBlocking{transport.request("GET","/vehicles/client/assets-v2",guard={})};assertEquals("/api/vehicles/client/assets-v2",s.takeRequest().path)
 }
 private class Memory:SecretStore{var value:String?=null;override fun read()=value;override fun write(value:String){this.value=value};override fun clear(){value=null}}
 private fun tls(block:(MockWebServer,OkHttpClient)->Unit){val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build();val http=OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();try{MockWebServer().use{s->s.useHttps(tls.sslSocketFactory(),false);s.start();block(s,http)}}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 private inner class F(s:MockWebServer,http:OkHttpClient){val jar=SessionCookieJar(s.url("/"),Memory());val id=StarterIdentity(s.url("/").toString().trimEnd('/'),"devnet","GySVDr1omr3GTodgWFH7qD1ZKav9C5NMPFjdpwb33LvU");val port=GameApi.withTransport(id.origin,jar,"vehicle-test",http).charterClientPort(id,jar.sessionToken());init{jar.saveFromResponse(s.url("/"),listOf(requireNotNull(Cookie.parse(s.url("/"),"session=original; Path=/; Secure; HttpOnly"))))}}
 @Test fun `old arbitrary key stays one encoded path component with original cookies`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setBody("{}"));runBlocking{f.port.vehicleRequest("GET",VehicleProtocol.byKeyPath("installation","old/key?☃"),emptyMap(),null,{},{})};val r=s.takeRequest();assertEquals("/api/vehicles/client/installations/by-key/old%2Fkey%3F%E2%98%83",r.path);assertEquals("session=original",r.getHeader("Cookie"));assertEquals(1,s.requestCount)}
 @Test fun `RPC accepts bounded raw deployment replies and rejects sends before enqueue`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setBody(buildJsonObject{put("result","x".repeat(100_000))}.toString()));assertEquals(100_000,runBlocking{f.port.vehicleRpcRequest("getMultipleAccounts",JsonArray(emptyList()),{})}.getValue("result").jsonPrimitive.content.length);assertThrows(Exception::class.java){runBlocking{f.port.vehicleRpcRequest("sendTransaction",JsonArray(emptyList()),{})}};val r=s.takeRequest();assertEquals("/api/rpc/solana/devnet",r.path);assertEquals(1,s.requestCount)}
 @Test fun `chunked excessive RPC bytes fail before parsing or retaining and ordinary API retains smaller bound`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setChunkedBody(" ".repeat(16*1024*1024+1),65536));assertThrows(Exception::class.java){runBlocking{f.port.vehicleRpcRequest("getSlot",JsonArray(emptyList()),{})}};s.enqueue(MockResponse().setBody(" ".repeat(1_048_577)));var retained=false;assertThrows(Exception::class.java){runBlocking{f.port.vehicleRequest("GET","/vehicles/client/activity",emptyMap(),null,{},{retained=true})}};assertFalse(retained);assertEquals(2,s.requestCount)}
 @Test fun `redirect is never followed while valid owned response survives stale guard`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setResponseCode(307).addHeader("Location",s.url("/other")).setBody("{}"));assertThrows(Exception::class.java){runBlocking{f.port.vehicleRequest("GET","/vehicles/client/activity",emptyMap(),null,{},{})}};s.enqueue(MockResponse().setBody("{}"));var fresh=true;var saved=false;assertThrows(Exception::class.java){runBlocking{f.port.vehicleRequest("GET","/vehicles/client/activity",emptyMap(),null,{check(fresh)},{saved=true;fresh=false})}};assertTrue(saved);assertEquals(2,s.requestCount)}
 @Test fun `C5 advanced captures before request and publishes only marked creation after retention`() {
  for ((status,marked) in listOf(201 to true,200 to true,201 to false)) tls { server,http ->
   val f=F(server,http)
   val source=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/boundcosmetics/wake-sidecar-primary-pair.json")).readText()).jsonObject
    .getValue("advanced").jsonObject.getValue("selected").jsonObject.getValue("original").jsonObject
   val original=JsonObject(source+("wallet" to JsonPrimitive(f.id.wallet))+("receipt" to JsonObject(source.getValue("receipt").jsonObject+("wallet" to JsonPrimitive(f.id.wallet)))))
   val body=original.getValue("receipt").jsonObject.getValue("request").jsonObject
   val order=mutableListOf<String>()
   val transport=VehicleTransport(VehicleHttpPort(f.port),captureDeparture={ baseId,_ ->
    assertEquals(body.getValue("baseId").jsonPrimitive.content,baseId);assertEquals(0,server.requestCount);order+="capture";
    { proof -> assertEquals(original,proof.original);assertEquals(listOf("capture","retain"),order);order+="emit";error("optional observer") }
   })
   server.enqueue(MockResponse().setResponseCode(status).setBody(original.toString()).apply{if(marked)addHeader("x-pkw-journey-created","1")})
   assertEquals(original,runBlocking{transport.request("POST","/advanced-expeditions",body,{},retain={VehicleProtocol.expedition(it);order+="retain"})})
   assertEquals(if(status==201&&marked)listOf("capture","retain","emit")else listOf("capture","retain"),order)
   assertEquals(1,server.requestCount)
   server.enqueue(MockResponse().setResponseCode(201).addHeader("x-pkw-journey-created","1").setBody(original.toString()))
   runBlocking{transport.request("GET",VehicleProtocol.byKeyPath("expedition",original.getValue("idempotencyKey").jsonPrimitive.content),guard={})}
   server.enqueue(MockResponse().setResponseCode(201).addHeader("x-pkw-journey-created","1").setBody("{}"))
   runBlocking{transport.request("POST","/advanced-expeditions/collect",buildJsonObject{put("baseId",body.getValue("baseId"))},{})}
   assertEquals(if(status==201&&marked)3 else 2,order.size);assertEquals(3,server.requestCount)
  }
 }
 @Test fun `C5 advanced stale or failed retained write never invokes observer or retries`() {
  for(failedWrite in listOf(false,true))tls{server,http->
   val f=F(server,http);val source=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/boundcosmetics/wake-sidecar-primary-pair.json")).readText()).jsonObject
    .getValue("advanced").jsonObject.getValue("selected").jsonObject.getValue("original").jsonObject
   val body=source.getValue("receipt").jsonObject.getValue("request").jsonObject;var current=true;var retained=false;var emitted=0
   val transport=VehicleTransport(VehicleHttpPort(f.port),captureDeparture={_,_->{_->emitted++}})
   server.enqueue(MockResponse().setResponseCode(201).addHeader("x-pkw-journey-created","1").setBody(source.toString()))
   assertThrows(Exception::class.java){runBlocking{transport.request("POST","/advanced-expeditions",body,{check(current)},retain={
    if(failedWrite)error("storage failed");retained=true;current=false
   })}}
   assertEquals(!failedWrite,retained);assertEquals(0,emitted);assertEquals(1,server.requestCount)
  }
 }

}
