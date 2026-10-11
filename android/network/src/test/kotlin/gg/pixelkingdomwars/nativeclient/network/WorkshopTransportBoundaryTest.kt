package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.workshop.*
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class WorkshopTransportBoundaryTest {
    private class Memory:SecretStore {var raw:String?=null;override fun read()=raw;override fun write(value:String){raw=value};override fun clear(){raw=null}}
    private val wallet="11111111111111111111111111111111"
    private val base="00000000-0000-4000-8000-000000000001"
    private val job="00000000-0000-4000-8000-000000000002"
    private val command=WorkshopCommand("start",base,"boundary-original",1,null,1,17,1,61,"free_wallet")
    private fun proof(wrong:Boolean=false)="""{"wallet":"$wallet","idempotencyKey":"${command.key}","status":"accepted","serverNow":"2026-09-21T12:00:00.000Z","receipt":{"version":1,"status":"accepted","wallet":"$wallet","baseId":"${if(wrong) job else base}","jobId":"$job","receiptId":"$job","ingots":1,"shardsCharged":"17","recipeVersion":1,"workshopLevelAtStart":1,"startedAt":"2026-09-21T00:00:00.000Z","readyAt":"2026-09-21T00:01:01.000Z","acceptedAt":"2026-09-21T00:00:00.000Z"}}"""
    private fun runTls(listener:EventListener.Factory=EventListener.Factory{object:EventListener(){}}, block:(MockWebServer,OkHttpClient)->Unit) {
        val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build();val tls=HandshakeCertificates.Builder().heldCertificate(cert).build();val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val client=OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).eventListenerFactory(listener).build()
        try {MockWebServer().use {server->server.useHttps(tls.sslSocketFactory(),false);server.start();block(server,client)}} finally {client.connectionPool.evictAll();client.dispatcher.executorService.shutdown()}
    }
    @Test fun `Workshop paid enqueue has a currentness fence after IO without currency headers`() {
        var current=true;var checks=0
        runTls(EventListener.Factory {current=false;object:EventListener(){}}) {server,client->
            val jar=SessionCookieJar(server.url("/"),Memory());val api=GameApi.withTransport(server.url("/").toString(),jar,"test",client)
            assertThrows(IllegalStateException::class.java){runBlocking{api.postWorkshop(command.postPath,command.body(),jar.sessionToken()){checks++;check(current)}}}
            assertEquals(2,checks);assertEquals(0,server.requestCount)
        }
    }
    @Test fun `late original authenticated GET proof reaches journal before stale response and cookies are rejected`() {
        for(wrong in listOf(false,true)) {
            lateinit var jar:SessionCookieJar
            runTls(EventListener.Factory {object:EventListener(){override fun responseBodyStart(call:Call){jar.beginAuthentication()}}}) {server,client->
                val cookies=Memory();jar=SessionCookieJar(server.url("/"),cookies);val token=jar.sessionToken()
                val api=GameApi.withTransport(server.url("/").toString(),jar,"test",client)
                val store=WorkshopStore(Memory(),WorkshopIdentity(server.url("/").toString().trimEnd('/'),"devnet",wallet));store.begin(store.read(),command)
                val port=object:WorkshopPort {
                    override suspend fun get(path:String,guard:()->Unit,retain:(JsonObject)->Unit)=api.getWorkshop(path,emptyMap(),token,guard,retain)
                    override suspend fun post(path:String,body:JsonObject,guard:()->Unit,refusal:(ApiException)->Unit){error("GET recovery only")}
                }
                server.enqueue(MockResponse().setBody(proof(wrong)).addHeader("Set-Cookie","session=obsolete; Path=/; Secure; HttpOnly"))
                assertThrows(Exception::class.java){runBlocking{WorkshopTransport(store,port).check{}}}
                if(wrong) assertNull(store.read().operation!!.proof) else assertNotNull(store.read().operation!!.proof)
                assertNull(cookies.raw);assertEquals(1,server.requestCount);val request=server.takeRequest();assertEquals("GET",request.method)
                assertNull(request.getHeader("x-pkw-currency"));assertNull(request.getHeader("x-pkw-expected-currency"))
            }
        }
    }
    @Test fun `evidence callback is restricted to historical Workshop GET and failures are closed`() {
        runTls {server,client->
            val jar=SessionCookieJar(server.url("/"),Memory());val api=GameApi.withTransport(server.url("/").toString(),jar,"test",client)
            for(path in listOf("/me","/workshop","/workshop/jobs")) assertThrows(IllegalArgumentException::class.java){runBlocking{api.getWorkshop(path,emptyMap(),jar.sessionToken(),{}, {})}}
            assertEquals(0,server.requestCount)
            server.enqueue(MockResponse().setBody(proof()));assertThrows(java.io.IOException::class.java){runBlocking{api.getWorkshop(command.receiptPath,emptyMap(),jar.sessionToken(),{}, {throw java.io.IOException("durable write failed")})}}
            assertEquals(1,server.requestCount)
        }
    }
    private fun refusalBoundary(status:Int, code:String?, attempted:Boolean, definitive:Boolean) {
        lateinit var jar:SessionCookieJar
        runTls(EventListener.Factory {object:EventListener(){override fun responseBodyStart(call:Call){if(call.request().method=="POST") jar.beginAuthentication()}}}) {server,client->
            val cookies=Memory();jar=SessionCookieJar(server.url("/"),cookies);val token=jar.sessionToken()
            val api=GameApi.withTransport(server.url("/").toString(),jar,"test",client)
            val identity=WorkshopIdentity(server.url("/").toString().trimEnd('/'),"devnet",wallet)
            val store=WorkshopStore(Memory(),identity);val original=store.begin(store.read(),command)
            if(attempted) store.attempt(original)
            val otherMemory=Memory();val other=WorkshopStore(otherMemory,identity.copy(wallet="DnF3JgFtAEdF7Gkcdne5DMtwyLE1S25Uyb9ip4FEfVUX"))
            other.begin(other.read(),command.copy(key="new-account-original"));val untouched=otherMemory.raw
            val port=object:WorkshopPort {
                override suspend fun get(path:String,guard:()->Unit,retain:(JsonObject)->Unit)=api.getWorkshop(path,emptyMap(),token,guard,retain)
                override suspend fun post(path:String,body:JsonObject,guard:()->Unit,refusal:(ApiException)->Unit){api.postWorkshop(path,body,token,refusal,guard)}
            }
            val unknown=buildJsonObject {put("wallet",wallet);put("idempotencyKey",command.key);put("status","unknown");put("receipt",JsonNull);put("serverNow","2026-09-21T12:00:00.000Z")}
            server.enqueue(MockResponse().setBody(unknown.toString()))
            val failure=buildJsonObject {put("error",buildJsonObject {code?.let {put("code",it)};put("message","Original refusal")})}
            server.enqueue(MockResponse().setResponseCode(status).setBody(failure.toString()).addHeader("Set-Cookie","session=obsolete; Path=/; Secure; HttpOnly"))
            assertThrows(SessionSupersededException::class.java){runBlocking{WorkshopTransport(store,port).confirm(store.read()) {}}}
            val saved=store.read().operation!!;assertTrue(saved.attempted);assertNull(saved.proof);assertEquals(command,saved.command)
            if(definitive) assertEquals(WorkshopRefusal(status,code!!),saved.refusal) else assertNull(saved.refusal)
            assertEquals("A late old-account refusal cannot change another wallet's journal",untouched,otherMemory.raw)
            assertNull("Obsolete response cookies must not replace the new session",cookies.raw);assertNotSame(token,jar.sessionToken())
            assertEquals(2,server.requestCount);assertEquals("GET",server.takeRequest().method);val post=server.takeRequest()
            assertEquals("POST",post.method);assertEquals(command.body().toString(),post.body.readUtf8())
            assertNull(post.getHeader("x-pkw-currency"));assertNull(post.getHeader("x-pkw-expected-currency"))
        }
    }
    @Test fun `typed first POST refusal survives changed session without touching new wallet journal`() {
        refusalBoundary(422,"INSUFFICIENT_SHARDS",attempted=false,definitive=true)
    }
    @Test fun `generic body-mismatch wrong-kind and wrong-status late errors remain uncertain`() {
        refusalBoundary(409,null,attempted=false,definitive=false)
        refusalBoundary(409,"IDEMPOTENCY_BODY_MISMATCH",attempted=false,definitive=false)
        refusalBoundary(409,"JOB_NOT_READY",attempted=false,definitive=false)
        refusalBoundary(409,"INSUFFICIENT_SHARDS",attempted=false,definitive=false)
    }
    @Test fun `typed refusal after an earlier ambiguous attempt cannot disprove original acceptance`() {
        refusalBoundary(422,"INSUFFICIENT_SHARDS",attempted=true,definitive=false)
    }
    @Test fun `late receipt GET error after POST success is never first-request refusal evidence`() {
        lateinit var jar:SessionCookieJar
        runTls(EventListener.Factory {object:EventListener(){override fun responseHeadersEnd(call:Call,response:Response){if(response.code==422) jar.beginAuthentication()}}}) {server,client->
            jar=SessionCookieJar(server.url("/"),Memory());val token=jar.sessionToken();val api=GameApi.withTransport(server.url("/").toString(),jar,"test",client)
            val store=WorkshopStore(Memory(),WorkshopIdentity(server.url("/").toString().trimEnd('/'),"devnet",wallet));store.begin(store.read(),command)
            val port=object:WorkshopPort {
                override suspend fun get(path:String,guard:()->Unit,retain:(JsonObject)->Unit)=api.getWorkshop(path,emptyMap(),token,guard,retain)
                override suspend fun post(path:String,body:JsonObject,guard:()->Unit,refusal:(ApiException)->Unit){api.postWorkshop(path,body,token,refusal,guard)}
            }
            server.enqueue(MockResponse().setBody(buildJsonObject {put("wallet",wallet);put("idempotencyKey",command.key);put("status","unknown");put("receipt",JsonNull);put("serverNow","2026-09-21T12:00:00.000Z")}.toString()))
            server.enqueue(MockResponse().setBody("{}"))
            server.enqueue(MockResponse().setResponseCode(422).setBody("""{"error":{"code":"INSUFFICIENT_SHARDS","message":"Receipt outage"}}"""))
            assertThrows(SessionSupersededException::class.java){runBlocking{WorkshopTransport(store,port).confirm(store.read()) {}}}
            assertTrue(store.read().operation!!.attempted);assertNull(store.read().operation!!.refusal);assertEquals(3,server.requestCount)
        }
    }

    @Test fun `cancelled complete Workshop responses retain only original proof or first POST refusal`() {
        for (kind in listOf("proof", "refusal", "retry", "get-error")) {
            lateinit var task: Job
            val cancelMethod = if (kind == "refusal" || kind == "retry") "POST" else "GET"
            runTls(EventListener.Factory { object : EventListener() { override fun responseBodyEnd(call: Call, byteCount: Long) {
                if (call.request().method == cancelMethod) task.cancel()
            } } }) { server, client -> runBlocking {
                val cookies = Memory(); val jar = SessionCookieJar(server.url("/"), cookies); val token = jar.sessionToken()
                val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
                val memory = Memory(); val identity = WorkshopIdentity(server.url("/").toString().trimEnd('/'), "devnet", wallet)
                val store = WorkshopStore(memory, identity); val original = store.begin(store.read(), command)
                if (kind == "retry") store.attempt(original)
                val port = object : WorkshopPort {
                    override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) = api.getWorkshop(path, emptyMap(), token, guard, retain)
                    override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, refusal: (ApiException) -> Unit) { api.postWorkshop(path, body, token, refusal, guard) }
                }
                if (cancelMethod == "POST") server.enqueue(MockResponse().setBody("""{"wallet":"$wallet","idempotencyKey":"${command.key}","status":"unknown","receipt":null,"serverNow":"2026-09-21T12:00:00.000Z"}"""))
                server.enqueue(if (kind == "proof") MockResponse().setBody(proof()).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly")
                    else MockResponse().setResponseCode(422).setBody("""{"error":{"code":"INSUFFICIENT_SHARDS","message":"Original refusal"}}"""))
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) {
                    val transport = WorkshopTransport(store, port)
                    if (cancelMethod == "POST") transport.confirm(store.read()) {} else transport.check {}
                }
                task.start(); withTimeout(5_000) { task.join() }
                val saved = WorkshopStore(memory, identity).read().operation!!
                assertEquals(command, saved.command); assertEquals(kind == "proof", saved.proof != null)
                assertEquals(kind == "refusal", saved.refusal != null)
                assertEquals(if (cancelMethod == "POST") 2 else 1, server.requestCount); assertNull(cookies.raw)
            } }
        }
    }

}
