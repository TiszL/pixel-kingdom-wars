package gg.pixelkingdomwars.nativeclient.network
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.divine.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
class DivineHttpTest {
 private class Memory:SecretStore{var value:String?=null;override fun read()=value;override fun write(value:String){this.value=value};override fun clear(){error("No clear")}}
 private fun tls(block:(MockWebServer,OkHttpClient)->Unit){val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build();val http=OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();try{MockWebServer().use{s->s.useHttps(tls.sslSocketFactory(),false);s.start();block(s,http)}}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 private inner class F(s:MockWebServer,http:OkHttpClient){val jar=SessionCookieJar(s.url("/"),Memory());val id=StarterIdentity(s.url("/").toString().trimEnd('/'),"devnet","GySVDr1omr3GTodgWFH7qD1ZKav9C5NMPFjdpwb33LvU");val port=GameApi.withTransport(id.origin,jar,"divine-test",http).charterClientPort(id,jar.sessionToken());init{jar.saveFromResponse(s.url("/"),listOf(requireNotNull(Cookie.parse(s.url("/"),"session=original; Path=/; Secure; HttpOnly"))))}}
 @Test fun `dedicated routes carry original cookie and cannot invoke ordinary raids`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setBody("{}"));runBlocking{f.port.divineRequest("GET","/divine-trials/events",emptyMap(),null,{},{})};val r=s.takeRequest();assertEquals("/api/divine-trials/events",r.path);assertEquals("session=original",r.getHeader("Cookie"));assertThrows(Exception::class.java){runBlocking{f.port.divineRequest("POST","/raids",emptyMap(),buildJsonObject{},{},{})}};assertEquals(1,s.requestCount)}
 @Test fun `aggregate response cap admits public vector payload while legacy cap stays unchanged`()=tls{s,http->val f=F(s,http);val raw=javaClass.classLoader!!.getResource("divine-trial-vectors.json")!!.readText();assertTrue(raw.length>1_048_576);s.enqueue(MockResponse().setBody(raw));var saved=false;runBlocking{f.port.divineRequest("GET","/divine-trials/events",emptyMap(),null,{},{saved=true})};assertTrue(saved);s.enqueue(MockResponse().setBody(raw));assertThrows(Exception::class.java){runBlocking{f.port.vehicleRequest("GET","/vehicles/client/activity",emptyMap(),null,{},{error("Over-limit legacy response retained")})}};s.enqueue(MockResponse().setBody("{}").setHeader("Content-Length",DivineGrammar.MAX_RESPONSE_BYTES+1));assertThrows(Exception::class.java){runBlocking{f.port.divineRequest("GET","/divine-trials/events",emptyMap(),null,{},{error("Over-limit trial response retained")})}}}
 @Test fun `redirect never follows and late owned response survives stale guard`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setResponseCode(307).addHeader("Location",s.url("/raids")).setBody("{}"));assertThrows(Exception::class.java){runBlocking{f.port.divineRequest("GET","/divine-trials/events",emptyMap(),null,{},{})}};s.enqueue(MockResponse().setBody("{}"));var fresh=true;var retained=false;assertThrows(Exception::class.java){runBlocking{f.port.divineRequest("GET","/divine-trials/events",emptyMap(),null,{check(fresh)},{retained=true;fresh=false})}};assertTrue(retained);assertEquals(2,s.requestCount)}
}
