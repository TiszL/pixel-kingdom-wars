package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.io.IOException
import java.util.Base64
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Explicit paired JVM acceptance. Real product repositories, journal serialization,
 * TLS transport and sign-only wallet use the actual authenticated fixture API.
 * Keys/DB remain in root's private loopback controller; chain time is injected
 * fixture authority, never the returned signing DTO or a device/RPC claim. */
class CharterApiPairedTest {
    @Test fun `creation exact signature and delivery survive lost replies and paused providerless serialized reopen`()=Fixture("creation").use{f->runBlocking{
        val before=f.inspect();val first=f.client(f.creator);first.repo.open()
        f.loseNextPost="$PREFIX/creations"
        assertTrue(runCatching{first.repo.create(f.text("baseId"),f.text("creationName"),f.text("creationTag"),"open")}.isFailure)
        val intent=first.store.read().records.single();val key=intent.localKey
        assertTrue("create" in intent.attempts);assertNull(intent.envelope)
        val funded=f.client(f.creator,MemoryStore(first.disk.value));funded.repo.open();funded.repo.selectSaved(key)
        assertEquals("funded",funded.envelope().status);assertEquals(key,funded.envelope().key)
        f.loseNextPost="$PREFIX/creations/$key/prepare"
        assertTrue(runCatching{funded.repo.prepare()}.isFailure)
        val prepared=f.client(f.creator,MemoryStore(funded.disk.value));prepared.repo.open();prepared.repo.selectSaved(key)
        assertNotNull(prepared.envelope().signing);prepared.repo.review();prepared.repo.approve()
        val own=requireNotNull(prepared.store.record(key).ownSignature);assertNotNull(own.transactionSignature)
        f.loseNextPost="$PREFIX/creations/$key/signed"
        assertTrue(runCatching{prepared.repo.publishSignature()}.isFailure)
        assertEquals(own,prepared.store.record(key).ownSignature)
        prepared.repo.checkOriginal();assertEquals(own.wire,requireNotNull(prepared.envelope().wire).charterText("signedTransaction"))
        f.loseNextPost="$PREFIX/creations/$key/deliver"
        assertTrue(runCatching{prepared.repo.deliver()}.isFailure)
        assertEquals(own,prepared.store.record(key).ownSignature)
        f.command("settle"){put("kind","creation");put("key",key)}
        prepared.repo.checkOriginal();assertNull(prepared.envelope().terminal) // Observing the bank alone never changes product state.
        prepared.repo.recover();assertEquals("activated",prepared.envelope().status);assertEquals(1,prepared.hydrates)
        val original=prepared.store.record(key)
        f.command("restart"){put("paused",true);put("providerless",true)}
        val reopened=f.client(f.creator,MemoryStore(prepared.disk.value),paused=true);reopened.repo.open();reopened.repo.selectSaved(key)
        assertEquals("activated",reopened.envelope().status);assertEquals(1,reopened.hydrates);assertEquals(own,reopened.store.record(key).ownSignature)
        assertEquals(original.review,reopened.store.record(key).review);assertEquals(original.envelope,reopened.store.record(key).envelope)
        assertTrue(runCatching{reopened.repo.approve()}.isFailure);assertTrue(runCatching{reopened.repo.deliver()}.isFailure)
        assertEquals(1,f.approvals[f.creator]);assertEquals(1,f.posts.count{it.path=="$PREFIX/creations"})
        assertEquals(1,f.posts.count{it.path.endsWith("/signed")});assertEquals(1,f.posts.count{it.path.endsWith("/deliver")})
        assertCounts(before,f.inspect(),creation=1,sale=0,signatures=1)
        val saved=reopened.store.read();f.offline=true
        assertEquals(saved,CharterStore(MemoryStore(reopened.disk.value),reopened.store.identity).read())
    }}
    @Test fun `sale two independent participants recover seller key partial approvals full wire and one members-first terminal`()=Fixture("sale").use{f->runBlocking{
        val before=f.inspect();val first=f.client(f.creator);first.repo.open()
        f.loseNextPost="$PREFIX/sales"
        assertTrue(runCatching{first.repo.sell(f.text("clanId"),f.buyer,f.text("priceLamports"),f.setup.getValue("sellerLeaves").jsonPrimitive.boolean)}.isFailure)
        val local=first.store.read().records.single().localKey;assertNull(first.store.record(local).serverKey)
        val seller=f.client(f.creator,MemoryStore(first.disk.value));seller.repo.open();seller.repo.selectSaved(local)
        val key=seller.envelope().key;assertEquals(key,seller.store.record(local).serverKey)
        assertTrue(f.reads.any{it.actor==f.creator && it.path=="$PREFIX/sales/by-key/$local"})
        val buyer=f.client(f.buyer);buyer.repo.open()
        assertTrue(requireNotNull(buyer.repo.state.value.activity).raw.getValue("items").jsonArray.any{it.jsonObject.charterText("key")==key})
        buyer.repo.select("sale",key);buyer.repo.accept(f.text("buyerBaseId"))
        seller.repo.checkOriginal();seller.repo.payMembers();assertNotNull(seller.envelope().state["memberPayment"]?.takeUnless{it==JsonNull})
        seller.repo.prepare();buyer.repo.checkOriginal()
        seller.repo.review();seller.repo.approve();val sellerOwn=requireNotNull(seller.store.record(local).ownSignature)
        assertNull(sellerOwn.transactionSignature)
        f.loseNextPost="$PREFIX/sales/$key/signature"
        assertTrue(runCatching{seller.repo.publishSignature()}.isFailure)
        seller.repo.checkOriginal();assertEquals(1,seller.envelope().contributions.size);assertNull(seller.envelope().wire)
        assertTrue(runCatching{seller.repo.deliver()}.isFailure);assertFalse(f.posts.any{it.path.endsWith("/deliver")})
        buyer.repo.review();buyer.repo.approve();val buyerOwn=requireNotNull(buyer.store.record(key).ownSignature)
        assertNull(buyerOwn.transactionSignature);buyer.repo.publishSignature();seller.repo.checkOriginal()
        val wire=requireNotNull(buyer.envelope().wire);assertEquals(wire,seller.envelope().wire)
        assertEquals(2,buyer.envelope().contributions.size);assertEquals(2,seller.envelope().contributions.size)
        f.loseNextPost="$PREFIX/sales/$key/deliver"
        assertTrue(runCatching{buyer.repo.deliver()}.isFailure)
        f.command("settle"){put("kind","sale");put("key",key)}
        seller.repo.checkOriginal();assertNull(seller.envelope().terminal)
        seller.repo.recover();buyer.repo.checkOriginal()
        assertEquals("completed",seller.envelope().status);assertEquals("completed",buyer.envelope().status)
        assertEquals(seller.envelope().terminal,buyer.envelope().terminal);assertEquals(1,seller.hydrates);assertEquals(1,buyer.hydrates)
        f.command("restart"){put("paused",true);put("providerless",true)}
        val sellerCold=f.client(f.creator,MemoryStore(seller.disk.value),paused=true);sellerCold.repo.open();sellerCold.repo.selectSaved(local)
        val buyerCold=f.client(f.buyer,MemoryStore(buyer.disk.value),paused=true);buyerCold.repo.open();buyerCold.repo.selectSaved(key)
        assertEquals(wire,sellerCold.envelope().wire);assertEquals(wire,buyerCold.envelope().wire)
        assertEquals(1,sellerCold.hydrates);assertEquals(1,buyerCold.hydrates)
        assertEquals(sellerOwn,sellerCold.store.record(local).ownSignature);assertEquals(buyerOwn,buyerCold.store.record(key).ownSignature)
        assertEquals("completed",buyerCold.envelope().status);assertTrue(runCatching{buyerCold.repo.approve()}.isFailure)
        assertEquals(1,f.approvals[f.creator]);assertEquals(1,f.approvals[f.buyer]);assertEquals(1,f.posts.count{it.path=="$PREFIX/sales"})
        assertEquals(2,f.posts.count{it.path.endsWith("/signature")});assertEquals(1,f.posts.count{it.path.endsWith("/deliver")})
        assertCounts(before,f.inspect(),creation=0,sale=1,signatures=2)
    }}
    private fun assertCounts(before:JsonObject,after:JsonObject,creation:Int,sale:Int,signatures:Int){
        for((field,expected)in mapOf("creationPosts" to creation,"salePosts" to sale,"signaturePosts" to signatures,"signatures" to signatures,"sends" to 1,"settlements" to 1,"wireCount" to 1))
            assertEquals(field,expected,after.getValue(field).jsonPrimitive.int-before.getValue(field).jsonPrimitive.int)
    }
    private class Client(val fixture:Fixture,val actor:String,val disk:MemoryStore,val paused:Boolean){
        val holder=testHolder()
        private val cookies=SessionCookieJar(fixture.server.url("/"),MemoryStore()).apply{
            // This public local actor label is mapped to genuine auth only inside root's private fixture.
            saveFromResponse(fixture.server.url("/"),listOf(requireNotNull(Cookie.parse(fixture.server.url("/"),"pairedActor=$actor; Path=/; Secure; HttpOnly"))))
        }
        private val game=GameApi.withTransport(fixture.server.url("/").toString(),cookies,"native-charter-pair",fixture.transport)
        private val session=AccountSession(actor,fixture.origin,game.sessionToken()).also(holder::replace)
        val store=CharterStore(disk,StarterIdentity(fixture.origin,"devnet",actor))
        var hydrates=0
        private val wallet=CharterWallet(session,holder,session.origin,SolanaCluster.DEVNET,{false},{null},
            if(paused)null else CharterExternalSigner{prepared,cluster,retain,guard->
                assertEquals(SolanaCluster.DEVNET,cluster);guard()
                val record=store.read().records.single{it.review?.signing?.charterText("attemptId")==prepared.attemptId}
                assertTrue("wallet" in record.attempts);assertNull(record.ownSignature)
                fixture.approvals.compute(actor){_,old->(old?:0)+1}
                val response=fixture.command("sign"){put("actor",actor);put("unsignedTransaction",Base64.getEncoder().encodeToString(prepared.unsignedTransaction()))}
                val checked=prepared.verifySignedBase64(response.charterText("signedTransaction"));retain(checked);guard();checked
            })
        private val ports=object:CharterPorts{
            override val transport=CharterTransport(game.charterClientPort(store.identity,session.token))
            override fun capture(newAction:Boolean):()->Unit {
                val check={holder.requireCurrent(session);if(newAction)check(!paused){"Paired fixture is paused"}}
                check();return check
            }
            override fun policy()=if(paused)null else fixture.policy.protocol
            override fun cryptoPolicy()=if(paused)null else fixture.policy.crypto
            override fun trust()=if(paused)null else fixture.pins
            override fun key()=UUID.randomUUID().toString()
            override suspend fun live(prepared:PreparedCharter,signing:JsonObject,guard:()->Unit):()->Unit{
                guard();check(!paused)
                val live=fixture.command("live"){}
                assertEquals(fixture.pins.toJson().charterObject("deployment").charterText("expectedGenesisHash"),live.charterText("genesisHash"))
                val height=live.getValue("blockHeight").jsonPrimitive.long;val slot=live.getValue("slot").jsonPrimitive.long
                val clock=live.charterText("clockUnixTimestamp").toLong()
                require(height in 0..signing.getValue("lastValidBlockHeight").jsonPrimitive.long)
                require(slot>=signing.charterObject("context").getValue("closingSlot").jsonPrimitive.long)
                require(clock in prepared.observedUnixTimestamp..prepared.expiryUnixTimestamp)
                return {guard();check(!paused)}
            }
            override suspend fun ready(guard:()->Unit)=wallet.requireAvailable(guard)
            override suspend fun hydrate(guard:()->Unit){guard();hydrates++}
            override suspend fun sign(prepared:PreparedCharter,guard:()->Unit,retain:suspend(SignedCharter)->Unit){wallet.sign(prepared,retain,guard)}
        }
        val repo=CharterRepository(store,ports)
        fun envelope()=requireNotNull(repo.state.value.envelope)
    }
    private data class RequestRecord(val actor:String,val path:String)
    private class Fixture(val kind:String):AutoCloseable{
        private val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls=HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server=MockWebServer().apply{protocols=listOf(Protocol.HTTP_1_1);useHttps(tls.sslSocketFactory(),false);start()}
        val origin=server.url("/").toString().trimEnd('/')
        val transport=OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build()
        private val bridge=Bridge()
        val setup=try{command("start"){put("kind",kind);put("origin",origin)}}catch(e:Throwable){runCatching{bridge.close()};server.shutdown();transport.dispatcher.executorService.shutdown();throw e}
        val creator=text("creator");val buyer=text("buyer")
        val pins=CharterSigningTrust.from(setup.charterObject("trust"))
        val policy=requireNotNull(charterAppPolicy(buildJsonObject{put("constants",setup.getValue("constants"))})).also{
            assertEquals(setup.charterObject("protocol"),it.protocol.toJson());assertEquals(setup.charterObject("cryptoPolicy"),charterCryptoJson(it.crypto))
        }
        private val active=ConcurrentHashMap<String,Client>()
        val approvals=ConcurrentHashMap<String,Int>()
        val posts=java.util.Collections.synchronizedList(mutableListOf<RequestRecord>())
        val reads=java.util.Collections.synchronizedList(mutableListOf<RequestRecord>())
        @Volatile var loseNextPost:String?=null
        @Volatile var offline=false
        init{server.dispatcher=object:Dispatcher(){override fun dispatch(request:RecordedRequest):MockResponse{
            if(offline)return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
            val actor=request.getHeader("Cookie")?.split(';')?.map{it.trim()}?.singleOrNull{it.startsWith("pairedActor=")}?.substringAfter('=')
                ?:return MockResponse().setResponseCode(401)
            require(actor==creator || actor==buyer)
            val url=requireNotNull(request.requestUrl);val path=url.encodedPath.removePrefix("/api");val method=requireNotNull(request.method)
            val raw=request.body.readUtf8();val body=if(raw.isEmpty())null else Json.parseToJsonElement(raw).jsonObject
            if(method=="POST")runBlocking{
                val records=requireNotNull(active[actor]).store.read().records
                val record=if(path=="$PREFIX/creations" || path=="$PREFIX/sales")records.single{it.localKey==requireNotNull(body).charterText(if(kind=="creation")"creationIntentId" else "idempotencyKey")}
                    else records.single{it.serverKey==path.substringBeforeLast('/').substringAfterLast('/')}
                val action=if(path=="$PREFIX/creations" || path=="$PREFIX/sales")"create" else path.substringAfterLast('/')
                val attempt=when(action){"signed","signature"->"retain-signature";else->action}
                assertTrue("Attempt must be durable before API effect",record.attempts.any{it==attempt || it.startsWith("$attempt:")})
                if(action in listOf("signed","signature","deliver"))assertNotNull(record.ownSignature)
            }
            val response=command("request"){
                put("actor",actor);put("method",method);put("path",path)
                if(url.queryParameterNames.isNotEmpty())put("query",buildJsonObject{url.queryParameterNames.forEach{put(it,requireNotNull(url.queryParameter(it)))}})
                body?.let{put("body",it)}
            }
            (if(method=="POST")posts else reads).add(RequestRecord(actor,path))
            if(method=="POST" && loseNextPost==path){loseNextPost=null;return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)}
            return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int).setBody(response.charterText("body")).apply{
                response.charterObject("headers").forEach{(name,value)->addHeader(name,value.jsonPrimitive.content)}
            }
        }}}
        fun text(key:String)=setup.charterText(key)
        fun command(operation:String,fields:JsonObjectBuilder.()->Unit)=bridge.command(buildJsonObject{put("operation",operation);fields()})
        fun inspect()=command("inspect"){}
        fun client(actor:String,disk:MemoryStore=MemoryStore(),paused:Boolean=false)=Client(this,actor,disk,paused).also{active[actor]=it}
        override fun close(){try{bridge.close()}finally{server.shutdown();transport.connectionPool.evictAll();transport.dispatcher.executorService.shutdown()}}
    }
    /** Only root's authenticated 127.0.0.1 control plane may supply test authority. */
    private class Bridge:AutoCloseable{
        private val url=requireNotNull(System.getenv("PHASE_E_CHARTER_PAIR_URL")).toHttpUrl().also{require(it.scheme=="http" && it.host=="127.0.0.1" && it.encodedPath=="/" && it.query==null && it.fragment==null && it.username.isEmpty() && it.password.isEmpty())}
        private val token=requireNotNull(System.getenv("PHASE_E_CHARTER_PAIR_TOKEN")).also{require(it.isNotBlank() && it.length<=256 && it.all{c->c.code in 33..126})}
        private val http=OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(60,TimeUnit.SECONDS).build()
        @Synchronized fun command(value:JsonObject):JsonObject{
            val request=Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build()
            return http.newCall(request).execute().use{response->
                val body=requireNotNull(response.body);require(body.contentLength()<=262144 && !body.source().request(262145))
                val raw=Json.parseToJsonElement(body.string()).jsonObject
                check(response.isSuccessful){"Private Charter fixture command refused: ${value.charterText("operation")}"};raw
            }
        }
        override fun close(){try{command(buildJsonObject{put("operation","close")})}finally{http.connectionPool.evictAll();http.dispatcher.executorService.shutdown()}}
    }
    companion object{private const val PREFIX="/clans/charter/client"}
}
