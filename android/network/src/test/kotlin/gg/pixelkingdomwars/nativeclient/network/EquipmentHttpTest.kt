package gg.pixelkingdomwars.nativeclient.network
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
class EquipmentHttpTest {
 private class Memory:SecretStore{var value:String?=null;override fun read()=value;override fun write(value:String){this.value=value};override fun clear(){value=null}}
 private fun tls(block:(MockWebServer,OkHttpClient)->Unit){val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build();val http=OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();try{MockWebServer().use{s->s.useHttps(tls.sslSocketFactory(),false);s.start();block(s,http)}}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 private inner class F(s:MockWebServer,http:OkHttpClient){val jar=SessionCookieJar(s.url("/"),Memory());val id=StarterIdentity(s.url("/").toString().trimEnd('/'),"devnet","GySVDr1omr3GTodgWFH7qD1ZKav9C5NMPFjdpwb33LvU");val port=GameApi.withTransport(id.origin,jar,"equipment-test",http).charterClientPort(id,jar.sessionToken());init{jar.saveFromResponse(s.url("/"),listOf(requireNotNull(Cookie.parse(s.url("/"),"session=original; Path=/; Secure; HttpOnly"))))}}
 private val base="00000000-0000-4000-8000-000000000001"
 @Test fun `fitting is explicit query under original authenticated origin and cookie`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setBody("{}"));runBlocking{f.port.equipmentRequest("GET","/starter-expeditions",mapOf("baseId" to base,"fitting" to "route_compass"),null,{},{})};val r=s.takeRequest();assertEquals("/api/starter-expeditions?baseId=$base&fitting=route_compass",r.path);assertEquals("session=original",r.getHeader("Cookie"));assertEquals(1,s.requestCount)}
 @Test fun `redirect retry mutation and actor override cannot escape equipment allowlist`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setResponseCode(307).addHeader("Location",s.url("/other")).setBody("{}"));assertThrows(Exception::class.java){runBlocking{f.port.equipmentRequest("GET","/ordinary-equipment",mapOf("baseId" to base),null,{},{})}};assertThrows(Exception::class.java){runBlocking{f.port.equipmentRequest("POST","/ordinary-equipment/jobs/cancel",emptyMap(),buildJsonObject{},{},{})}};assertEquals(1,s.requestCount)}
 @Test fun `owned reply drains before stale view refusal and oversized response never reaches custody`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setBody("{}"));var fresh=true;var retained=false;assertThrows(Exception::class.java){runBlocking{f.port.equipmentRequest("GET","/ordinary-equipment",mapOf("baseId" to base),null,{check(fresh)},{retained=true;fresh=false})}};assertTrue(retained);s.enqueue(MockResponse().setChunkedBody(" ".repeat(1_048_577),65536));retained=false;assertThrows(Exception::class.java){runBlocking{f.port.equipmentRequest("GET","/ordinary-equipment",mapOf("baseId" to base),null,{},{retained=true})}};assertFalse(retained);assertEquals(2,s.requestCount)}
 @Test fun `owned authenticated refusal drains before changed view and keeps exact status code`()=tls{s,http->val f=F(s,http);val body=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-equipment.json")).readText()).jsonObject.getValue("request").jsonObject;s.enqueue(MockResponse().setResponseCode(422).setBody("{\"code\":\"INSUFFICIENT_CRAFTING_STOCK\",\"message\":\"materials changed\"}"));var current=true;var retained:ApiException?=null;assertThrows(Exception::class.java){runBlocking{f.port.equipmentRequest("POST","/ordinary-equipment/jobs",emptyMap(),body,{check(current)},{},refusal={retained=it;current=false})}};assertEquals(422,retained?.status);assertEquals("INSUFFICIENT_CRAFTING_STOCK",retained?.code);assertEquals(1,s.requestCount)}

 @Test fun `Lens catalogue and material query travel under the captured session without extra effects`()=tls{s,http->val f=F(s,http);for((path,query)in listOf("/ordinary-equipment" to mapOf("baseId" to base,"catalogueVersion" to "2"),"/starter-expeditions" to mapOf("baseId" to base,"fitting" to "survey_lens","resourceId" to "frost_quartz"))){s.enqueue(MockResponse().setBody("{}"));runBlocking{f.port.equipmentRequest("GET",path,query,null,{},{})};val r=s.takeRequest();assertEquals("session=original",r.getHeader("Cookie"));query.forEach{(k,v)->assertEquals(v,r.requestUrl!!.queryParameter(k))}};assertEquals(2,s.requestCount)}
 @Test fun `authenticated Lens last copy refusal retains exact code before stale view closes`()=tls{s,http->val f=F(s,http);val body=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/survey-lens.json")).readText()).jsonObject.getValue("starterEnvelope").jsonObject.getValue("receipt").jsonObject.getValue("request").jsonObject;s.enqueue(MockResponse().setResponseCode(409).setBody("{\"code\":\"LENS_UNAVAILABLE\",\"message\":\"reserved\"}"));var current=true;var retained:ApiException?=null;assertThrows(Exception::class.java){runBlocking{f.port.equipmentRequest("POST","/starter-expeditions",emptyMap(),body,{check(current)},{},refusal={retained=it;current=false})}};assertEquals(409,retained?.status);assertEquals("LENS_UNAVAILABLE",retained?.code);assertEquals(1,s.requestCount)}

 @Test fun `C5 fitted starter and advanced require marked201 after retained original with no recovery replay`() {
  for(kind in listOf("starter","advanced"))for((status,marked)in listOf(201 to true,200 to true,201 to false))tls{server,http->
   val f=F(server,http);val fixture=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/ordinary-equipment.json")).readText()).jsonObject
   val source=fixture.getValue("${kind}Envelope").jsonObject
   val original=JsonObject(source+("wallet" to JsonPrimitive(f.id.wallet))+("receipt" to JsonObject(source.getValue("receipt").jsonObject+("wallet" to JsonPrimitive(f.id.wallet)))))
   val body=original.getValue("receipt").jsonObject.getValue("request").jsonObject;val path="/${kind}-expeditions"
   val order=mutableListOf<String>()
   val transport=EquipmentTransport(EquipmentHttpPort(f.port),captureDeparture={baseId,_->
    assertEquals(body.getValue("baseId").jsonPrimitive.content,baseId);assertEquals(0,server.requestCount);order+="capture";
    {proof->assertEquals(original,proof.original);assertEquals(listOf("capture","retain"),order);order+="emit";error("optional failed")}
   })
   server.enqueue(MockResponse().setResponseCode(status).setBody(original.toString()).apply{if(marked)addHeader("x-pkw-journey-created","1")})
   assertEquals(original,runBlocking{transport.request("POST",path,body,{},retain={assertEquals(original,it);order+="retain"})})
   assertEquals(if(status==201&&marked)listOf("capture","retain","emit")else listOf("capture","retain"),order)
   server.enqueue(MockResponse().setResponseCode(201).addHeader("x-pkw-journey-created","1").setBody(original.toString()))
   runBlocking{transport.request("GET","$path/by-key/${original.getValue("idempotencyKey").jsonPrimitive.content}",guard={})}
   assertEquals(if(status==201&&marked)3 else 2,order.size);assertEquals(2,server.requestCount)
  }
 }

}
