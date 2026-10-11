package gg.pixelkingdomwars.nativeclient.network
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.divinefragments.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
class DivineFragmentHttpTest {
 private class Memory:SecretStore{var value:String?=null;override fun read()=value;override fun write(value:String){this.value=value};override fun clear(){error("No clear")}}
 private fun tls(block:(MockWebServer,OkHttpClient)->Unit){val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build();val http=OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build();try{MockWebServer().use{s->s.useHttps(tls.sslSocketFactory(),false);s.start();block(s,http)}}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
 private inner class F(s:MockWebServer,http:OkHttpClient){val jar=SessionCookieJar(s.url("/"),Memory());val id=StarterIdentity(s.url("/").toString().trimEnd('/'),"devnet","GySVDr1omr3GTodgWFH7qD1ZKav9C5NMPFjdpwb33LvU");val port=GameApi.withTransport(id.origin,jar,"divine-test",http).charterClientPort(id,jar.sessionToken());init{jar.saveFromResponse(s.url("/"),listOf(requireNotNull(Cookie.parse(s.url("/"),"session=original; Path=/; Secure; HttpOnly"))))}}
 @Test fun `dedicated routes carry original cookie and cannot invoke ordinary raids`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setBody("{}"));runBlocking{f.port.fragmentRequest("GET","/divine-fragments/awards",emptyMap(),null,{},{})};val r=s.takeRequest();assertEquals("/api/divine-fragments/awards",r.path);assertEquals("session=original",r.getHeader("Cookie"));assertThrows(Exception::class.java){runBlocking{f.port.fragmentRequest("POST","/raids",emptyMap(),buildJsonObject{},{},{})}};s.enqueue(MockResponse().setBody("{}"));runBlocking{f.port.fragmentRequest("GET","/divine-fragments/seeker/terms/00000000-0000-4000-8000-000000000020",emptyMap(),null,{},{})};assertEquals("/api/divine-fragments/seeker/terms/00000000-0000-4000-8000-000000000020",s.takeRequest().path);assertEquals(2,s.requestCount)}
 @Test fun `oversized fragment response fails before evidence retention`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setBody("{}").setHeader("Content-Length",DivineFragmentProtocol.MAX_BYTES+1));assertThrows(Exception::class.java){runBlocking{f.port.fragmentRequest("GET","/divine-fragments/awards",emptyMap(),null,{},{error("Over-limit response retained")})}}}
 @Test fun `redirect never follows and late owned response survives stale guard`()=tls{s,http->val f=F(s,http);s.enqueue(MockResponse().setResponseCode(307).addHeader("Location",s.url("/raids")).setBody("{}"));assertThrows(Exception::class.java){runBlocking{f.port.fragmentRequest("GET","/divine-fragments/awards",emptyMap(),null,{},{})}};s.enqueue(MockResponse().setBody("{}"));var fresh=true;var retained=false;assertThrows(Exception::class.java){runBlocking{f.port.fragmentRequest("GET","/divine-fragments/awards",emptyMap(),null,{check(fresh)},{retained=true;fresh=false})}};assertTrue(retained);assertEquals(2,s.requestCount)}
}
