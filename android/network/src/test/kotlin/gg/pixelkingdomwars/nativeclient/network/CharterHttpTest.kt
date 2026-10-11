package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.charter.CharterTransport
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import java.io.IOException
import java.util.Base64
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.buffer
import org.junit.Assert.*
import org.junit.Test

/** Real TLS exercises the existing GameApi cookie owner and exact Charter HTTP port. */
class CharterHttpTest {
    private class Memory : SecretStore {
        var value:String?=null
        override fun read()=value
        override fun write(value:String){this.value=value}
        override fun clear(){value=null}
    }
    private val fixture=Json.parseToJsonElement(requireNotNull(javaClass.getResource("/charterClient.json")).readText()).jsonObject
    private val envelope=fixture.getValue("envelopes").jsonObject.getValue("creation").jsonObject
    private val wallet=envelope.getValue("actor").jsonPrimitive.content
    private val key=envelope.getValue("key").jsonPrimitive.content
    private val prefix="/clans/charter/client"
    private val creationPath get()="$prefix/creations/$key"
    private val request=envelope.getValue("state").jsonObject.getValue("request").jsonObject
    private val cookie="session=obsolete; Path=/; Secure; HttpOnly"
    private fun reply(body:JsonObject=envelope)=MockResponse().setBody(body.toString()).addHeader("Cache-Control","private, no-store")
    private fun tls(listener:EventListener.Factory=EventListener.Factory{object:EventListener(){}},block:(MockWebServer,OkHttpClient)->Unit){
        val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity=HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        // Force HTTP/1.1 to exercise real chunk framing, not an invalid HTTP/2 fixture body.
        val client=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).eventListenerFactory(listener).build()
        try{MockWebServer().use{server->server.protocols=listOf(Protocol.HTTP_1_1);server.useHttps(identity.sslSocketFactory(),false);server.start();block(server,client)}}
        finally{client.connectionPool.evictAll();client.dispatcher.executorService.shutdown()}
    }
    private inner class Fixture(server:MockWebServer,client:OkHttpClient){
        val memory=Memory()
        val jar=SessionCookieJar(server.url("/"),memory)
        val token=jar.sessionToken()
        val identity=StarterIdentity(server.url("/").toString().trimEnd('/'),"devnet",wallet)
        val api=GameApi.withTransport(server.url("/").toString(),jar,"charter-test",client)
        val port=api.charterClientPort(identity,token)
        val transport=CharterTransport(port)
        init{jar.saveFromResponse(server.url("/"),listOf(requireNotNull(Cookie.parse(server.url("/"),"session=original; Path=/; Secure; HttpOnly"))))}
    }
    @Test fun `routes query keys actor binding and request bounds reject before enqueue`()=tls{server,client->
        val f=Fixture(server,client)
        val badPaths=listOf("/me",prefix,"$creationPath?x=1","$creationPath/extra","$creationPath%2f","$prefix/creations/00000000-0000-0000-0000-000000000000","$prefix/sales/by-key/not-an-id")
        for(path in badPaths)assertThrows(Exception::class.java){runBlocking{f.port.request("GET",path,emptyMap(),null,{},{})}}
        for(body in listOf(buildJsonObject{},JsonObject(request+("extra" to JsonPrimitive(true))),JsonObject(request+("baseId" to JsonPrimitive(key.uppercase()))))){
            assertThrows(IllegalArgumentException::class.java){runBlocking{f.port.request("POST","$prefix/creations",emptyMap(),body,{},{})}}
        }
        assertThrows(IllegalStateException::class.java){runBlocking{f.port.request("POST","$prefix/creations",emptyMap(),JsonObject(request+("name" to JsonPrimitive(1))),{},{})}}
        val badQueries=listOf(mapOf("actor" to wallet),mapOf("cursor" to ""),mapOf("cursor" to "x".repeat(257)),mapOf("cursor" to "with space"))
        for(query in badQueries)assertThrows(IllegalArgumentException::class.java){runBlocking{f.port.request("GET","$prefix/activity",query,null,{},{})}}
        assertThrows(IllegalArgumentException::class.java){runBlocking{f.port.request("GET",creationPath,emptyMap(),buildJsonObject{},{},{})}}
        for(wire in listOf("not base64",Base64.getEncoder().encodeToString(ByteArray(1233))))assertThrows(IllegalArgumentException::class.java){runBlocking{
            f.port.request("POST","$creationPath/signed",emptyMap(),buildJsonObject{put("signedTransaction",wire)},{},{})
        }}
        assertThrows(IllegalArgumentException::class.java){f.api.charterClientPort(f.identity.copy(origin="https://example.invalid"),f.token)}
        assertThrows(IllegalArgumentException::class.java){f.port.requireCurrent(f.identity.copy(wallet=fixture.getValue("rows").jsonArray.first().jsonObject.getValue("buyer").jsonPrimitive.content),f.token)}
        f.jar.beginAuthentication()
        assertThrows(SessionSupersededException::class.java){runBlocking{f.port.request("GET",creationPath,emptyMap(),null,{},{})}}
        assertEquals(0,server.requestCount)
    }
    @Test fun `one successful POST owns its frozen intent and shares the original GameApi cookie jar`()=tls{server,client->runBlocking{
        val f=Fixture(server,client);val mutable=request.toMutableMap();val body=JsonObject(mutable);val expected=body.toString();var retained=0
        server.enqueue(reply().setResponseCode(201).addHeader("Set-Cookie","session=next; Path=/; Secure; HttpOnly"))
        val result=f.port.request("POST","$prefix/creations",emptyMap(),body,{mutable["name"]=JsonPrimitive("Changed after capture")}){raw->assertEquals(envelope,raw);yield();retained++}
        assertEquals(envelope,result);assertEquals(1,retained)
        val sent=requireNotNull(server.takeRequest(3,TimeUnit.SECONDS));assertEquals("POST",sent.method);assertEquals("/api$prefix/creations",sent.path)
        assertEquals(expected,sent.body.readUtf8());assertEquals("session=original",sent.getHeader("Cookie"));assertEquals(f.identity.origin,sent.getHeader("Origin"));assertEquals("android-native",sent.getHeader("X-PKW-Client"))
        assertEquals("PKW-Native/charter-test",sent.getHeader("User-Agent"));assertEquals("application/json",sent.getHeader("Accept"))
        server.enqueue(reply());f.api.get("/me",session=f.token)
        assertEquals("session=next",requireNotNull(server.takeRequest(3,TimeUnit.SECONDS)).getHeader("Cookie"));assertEquals(2,server.requestCount)
    }}
    @Test fun `private activity cursor original GET and seller by-key use exact read-only paths`()=tls{server,client->runBlocking{
        val f=Fixture(server,client)
        val activity=buildJsonObject{put("version",1);put("actor",wallet);put("newActions",buildJsonObject{put("creation",false);put("sale",false)});put("items",buildJsonArray{});put("nextCursor",JsonNull)}
        val cursor="next+a/b=="
        repeat(2){server.enqueue(reply(activity));assertEquals(activity,f.transport.activity(cursor,{}).raw)}
        repeat(2){val sent=requireNotNull(server.takeRequest(3,TimeUnit.SECONDS));assertEquals("GET",sent.method);assertEquals("/api$prefix/activity",sent.requestUrl?.encodedPath);assertEquals(cursor,sent.requestUrl?.queryParameter("cursor"));assertEquals(0,sent.bodySize);assertEquals("session=original",sent.getHeader("Cookie"))}
        server.enqueue(reply());f.transport.request("GET",creationPath,null,{}){assertEquals(envelope,it)}
        assertEquals("/api$creationPath",requireNotNull(server.takeRequest(3,TimeUnit.SECONDS)).path)
        val byKey=buildJsonObject{put("version",1);put("actor",wallet);put("idempotencyKey",key);put("sale",JsonNull)}
        server.enqueue(reply(byKey));f.transport.request("GET","$prefix/sales/by-key/$key",null,{}){assertEquals(byKey,it)}
        val sent=requireNotNull(server.takeRequest(3,TimeUnit.SECONDS));assertEquals("GET",sent.method);assertEquals("/api$prefix/sales/by-key/$key",sent.path);assertEquals(4,server.requestCount)
    }}
    @Test fun `owned body survives session change or cancellation and never publishes obsolete cookies`() {
        for(replace in listOf(false,true)){
            lateinit var job:Job;lateinit var f:Fixture;var socketCancelled=false
            tls(EventListener.Factory{object:EventListener(){override fun responseBodyStart(call:Call){if(replace)f.jar.beginAuthentication() else job.cancel();socketCancelled=call.isCanceled()}}}){server,client->runBlocking{
                f=Fixture(server,client);val original=f.memory.value;var retained=false;var failure:Throwable?=null
                server.enqueue(MockResponse().setChunkedBody(envelope.toString(),256).addHeader("Set-Cookie",cookie))
                job=launch(start=CoroutineStart.LAZY){try{f.transport.request("GET",creationPath,null,{}){raw->assertEquals(envelope,raw);yield();retained=true}}catch(e:Throwable){failure=e}}
                job.start();withTimeout(3000){job.join()}
                assertTrue(retained);assertNotNull(failure);assertFalse(socketCancelled);assertEquals(original,f.memory.value);assertEquals(1,server.requestCount)
            }}
        }
    }
    @Test fun `cancelling a suspending retention cannot release HTTP ownership before evidence drains`()=tls{server,client->runBlocking{
        val f=Fixture(server,client);val original=f.memory.value;val entered=CompletableDeferred<Unit>();val release=CompletableDeferred<Unit>();var retained=false;var finished=false
        server.enqueue(reply().addHeader("Set-Cookie",cookie))
        val job=launch{try{f.transport.request("GET",creationPath,null,{}){entered.complete(Unit);release.await();retained=true}}finally{finished=true}}
        withTimeout(3000){entered.await()};job.cancel();yield();assertFalse(finished);assertFalse(retained)
        release.complete(Unit);withTimeout(3000){job.join()};assertTrue(retained);assertTrue(finished);assertEquals(original,f.memory.value);assertEquals(1,server.requestCount)
    }}
    @Test fun `lifecycle changes failed custody and foreign actor evidence cannot publish response cookies`()=tls{server,client->
        val f=Fixture(server,client);val original=f.memory.value
        for(fail in listOf(false,true)){
            var active=true;var retained=false;server.enqueue(reply().addHeader("Set-Cookie",cookie))
            assertThrows(Exception::class.java){runBlocking{f.transport.request("GET",creationPath,null,{check(active)}){yield();if(fail)throw IOException("Durable custody unavailable");retained=true;active=false}}}
            assertEquals(!fail,retained);assertEquals(original,f.memory.value)
        }
        val other=fixture.getValue("rows").jsonArray.first().jsonObject.getValue("buyer")
        server.enqueue(reply(JsonObject(envelope+("actor" to other))).addHeader("Set-Cookie",cookie))
        assertThrows(IllegalArgumentException::class.java){runBlocking{f.transport.request("GET",creationPath,null,{}){fail("Foreign evidence must not reach the original journal")}}}
        assertEquals(original,f.memory.value);assertEquals(3,server.requestCount)
    }
    @Test fun `redirect failures malformed and oversized decoded bodies never become owned evidence or retries`()=tls{server,client->
        val f=Fixture(server,client);val original=f.memory.value;var retained=0
        val oversized=" ".repeat(65537)+envelope
        val gzip=okio.Buffer();okio.GzipSink(gzip).buffer().use{it.writeUtf8(oversized)}
        val responses=listOf(MockResponse().setResponseCode(307).addHeader("Location","/api$prefix/creations").setBody(envelope.toString()),
            MockResponse().setResponseCode(503).setBody(envelope.toString()),MockResponse().setBody("[]"),MockResponse().setBody("{"),
            MockResponse().setBody(oversized),MockResponse().setChunkedBody(oversized,1024),MockResponse().setBody(gzip).addHeader("Content-Encoding","gzip"))
        for(response in responses){server.enqueue(response.addHeader("Set-Cookie",cookie));assertThrows(Exception::class.java){runBlocking{f.transport.request("POST","$prefix/creations",request,{}){retained++}}}}
        assertEquals(0,retained);assertEquals(responses.size,server.requestCount);assertEquals(original,f.memory.value)
    }
    @Test fun `preownership cancellation and disconnected original GET or POST never drain or automatically retry`() {
        lateinit var job:Job
        tls(EventListener.Factory{object:EventListener(){override fun responseHeadersEnd(call:Call,response:Response){job.cancel()}}}){server,client->runBlocking{
            val f=Fixture(server,client);var retained=false;server.enqueue(reply())
            job=launch(start=CoroutineStart.LAZY){f.transport.request("GET",creationPath,null,{}){retained=true}}
            job.start();withTimeout(3000){job.join()};assertFalse(retained);assertEquals(1,server.requestCount)
        }}
        for(method in listOf("GET","POST"))tls{server,client->runBlocking{
            val f=Fixture(server,client);var retained=false
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            server.enqueue(reply()) // A forbidden automatic retry would consume this successful response.
            assertTrue(runCatching{f.transport.request(method,if(method=="GET")creationPath else "$prefix/creations",if(method=="GET")null else request,{}){retained=true}}.isFailure)
            assertFalse(retained);assertEquals(1,server.requestCount)
        }}
    }
}
