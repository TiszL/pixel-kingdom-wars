package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.MemoryStore
import gg.pixelkingdomwars.nativeclient.charter.*
import gg.pixelkingdomwars.nativeclient.tournament.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.testHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import java.util.Base64
import java.util.UUID
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

/** Actual native repositories, serialized journals, TLS transport and sign-only wallet.
 * The root-owned loopback controller supplies genuine authenticated API effects and
 * private calendar/finality fixtures. This is not device or live-chain acceptance. */
class TournamentApiPairedTest {
    @Test fun `captain entry battle prize and clear survive lost replies and paused serialized reopen`() = Fixture().use { f -> runBlocking {
        val first = f.client(); first.repo.open(); first.repo.selectEvent(f.eventId)
        assertTrue(requireNotNull(first.repo.state.value.events).getValue("events").jsonArray.any { it.jsonObject.charterText("id") == f.eventId })
        f.loseNextPost = "$PREFIX/entries"
        assertTrue(runCatching { first.repo.enter(f.text("clanId")) }.isFailure)
        val intent = first.store.read().records.single(); assertEquals("entry",intent.kind)
        assertTrue(intent.attempts.any { it.startsWith("post:") }); assertNull(intent.response)
        val entered = f.client(MemoryStore(first.disk.value)); entered.repo.open(); entered.repo.selectEvent(f.eventId)
        entered.repo.recoverIntent(intent.key)
        val setId = entered.operationId(); assertEquals("set",entered.operation().charterObject("original").charterObject("operation").charterText("action"))
        assertTrue(f.reads.any { it.path == "$PREFIX/entries/by-key/${intent.key}" })
        f.loseNextPost = "$PREFIX/operations/$setId/prepare"
        assertTrue(runCatching { entered.repo.command("prepare") }.isFailure)
        val captain = f.client(MemoryStore(entered.disk.value)); captain.repo.open(); captain.repo.selectEvent(f.eventId); captain.repo.selectOperation(setId)
        assertNotNull(captain.operation().charterOptional("preparation"))
        captain.repo.review(); captain.repo.approve(); val setWire = requireNotNull(captain.store.record(setId).signed)
        f.loseNextPost = "$PREFIX/operations/$setId/signed"
        assertTrue(runCatching { captain.repo.upload() }.isFailure)
        assertEquals(setWire,captain.store.record(setId).signed)
        captain.repo.check(); captain.repo.selectOperation(setId)
        assertEquals(setWire,captain.operation().charterObject("signed"))
        f.loseNextPost = "$PREFIX/operations/$setId/deliver"
        assertTrue(runCatching { captain.repo.deliver() }.isFailure)
        f.command("settle") { put("operationId",setId) }
        captain.repo.selectOperation(setId); assertNull(captain.operation().charterOptional("terminal"))
        captain.repo.command("recover"); captain.repo.check()
        assertEquals("completed",requireNotNull(captain.store.record(setId).response).charterText("status"))
        assertEquals("entered",requireNotNull(captain.store.record(intent.key).response).charterText("status"))
        assertEquals(1,captain.hydrates)

        f.command("play") {}
        f.loseNextPost = "$PREFIX/events/${f.eventId}/raids"
        assertTrue(runCatching { captain.repo.raid(f.baseId) }.isFailure)
        val raidIntent = captain.store.read().records.single { it.kind == "raid" }
        assertNull(raidIntent.response)
        captain.repo.recoverIntent(raidIntent.key)
        val raid = requireNotNull(captain.store.record(raidIntent.key).response)
        assertEquals("admitted",raid.charterText("status")); assertEquals(1,raid.getValue("ordinal").jsonPrimitive.int)
        val raidId = raid.charterObject("raid").charterText("id")
        captain.repo.play(raidIntent.key); assertEquals(listOf(raidId to f.baseId),captain.battles)
        f.command("finish") { put("raidId",raidId) }
        f.command("close-time") {}
        captain.repo.closeEvent()
        val eventTerminal = requireNotNull(requireNotNull(captain.repo.state.value.event).charterOptional("terminal"))
        assertTrue(eventTerminal.getValue("rankings").jsonArray.any { it.jsonObject.charterText("clanId") == f.text("clanId") })
        val prize = requireNotNull(requireNotNull(captain.repo.state.value.participation).charterOptional("prize"))
        assertTrue(prize.charterObject("amounts").values.any { CharterGrammar.amount(it).signum() > 0 })
        f.loseNextPost = "$PREFIX/events/${f.eventId}/prize"
        assertTrue(runCatching { captain.repo.claim(f.baseId) }.isFailure)
        val prizeIntent = captain.store.read().records.single { it.kind == "prize" }
        captain.repo.recoverIntent(prizeIntent.key)
        val claim = requireNotNull(captain.store.record(prizeIntent.key).response)
        assertEquals(f.creator,claim.charterText("wallet")); assertEquals(f.baseId,claim.charterText("baseId"))
        assertEquals(prize.charterObject("amounts"),claim.charterObject("amounts"))

        val entryId = requireNotNull(captain.store.record(intent.key).response).charterText("id")
        f.loseNextPost = "$PREFIX/entries/$entryId/clear"
        assertTrue(runCatching { captain.repo.clear() }.isFailure)
        val clearIntent = captain.store.read().records.single { it.kind == "clear" }
        captain.repo.recoverIntent(clearIntent.key)
        // A latest-operation GET cannot attribute the lost intent key. Retry its exact POST.
        captain.repo.retry(clearIntent.key)
        val clearId = captain.operationId(); assertNotEquals(setId,clearId)
        assertEquals("clear",captain.operation().charterObject("original").charterObject("operation").charterText("action"))
        assertEquals(eventTerminal,captain.operation().charterObject("operationTerms").charterObject("clearance"))
        captain.repo.command("prepare"); captain.repo.review(); captain.repo.approve()
        val clearWire = requireNotNull(captain.store.record(clearId).signed)
        captain.repo.upload(); captain.repo.deliver()
        f.command("settle") { put("operationId",clearId) }
        captain.repo.command("recover"); captain.repo.check()
        assertEquals("completed",requireNotNull(captain.store.record(clearId).response).charterText("status"))
        assertEquals("released",requireNotNull(captain.store.record(intent.key).response).charterText("status"))
        val original = captain.store.read()
        f.command("restart") { put("paused",true); put("providerless",true) }
        val cold = f.client(MemoryStore(captain.disk.value),paused=true)
        cold.repo.open(); cold.repo.selectEvent(f.eventId); cold.repo.check(); cold.repo.selectOperation(clearId)
        assertEquals(clearWire,cold.store.record(clearId).signed); assertEquals(setWire,cold.store.record(setId).signed)
        assertEquals(claim,cold.store.record(prizeIntent.key).response)
        for (id in listOf(setId,clearId)) {
            assertEquals(original.records.single { it.key == id }.review,cold.store.record(id).review)
            assertEquals(original.records.single { it.key == id }.response,cold.store.record(id).response)
        }
        assertEquals(eventTerminal,requireNotNull(cold.repo.state.value.event).charterObject("terminal"))
        assertTrue(runCatching { cold.repo.review() }.isFailure); assertTrue(runCatching { cold.repo.approve() }.isFailure)
        assertTrue(runCatching { cold.repo.deliver() }.isFailure); assertEquals(2,f.approvals)
        assertEquals(1,f.posts.count { it.path == "$PREFIX/entries" })
        assertEquals(1,f.posts.count { it.path == "$PREFIX/events/${f.eventId}/raids" })
        assertEquals(1,f.posts.count { it.path == "$PREFIX/events/${f.eventId}/prize" })
        assertEquals(2,f.posts.count { it.path.endsWith("/signed") }); assertEquals(2,f.posts.count { it.path.endsWith("/deliver") })
        val saved = cold.store.read(); f.offline = true
        assertEquals(saved,TournamentStore(MemoryStore(cold.disk.value),cold.store.identity).read())
    } }

    private class Client(val fixture: Fixture,val disk: MemoryStore,val paused: Boolean) {
        val holder = testHolder()
        private val cookies = SessionCookieJar(fixture.server.url("/"),MemoryStore()).apply {
            saveFromResponse(fixture.server.url("/"),listOf(requireNotNull(Cookie.parse(fixture.server.url("/"),"pairedActor=${fixture.creator}; Path=/; Secure; HttpOnly"))))
        }
        private val game = GameApi.withTransport(fixture.server.url("/").toString(),cookies,"native-tournament-pair",fixture.transport)
        private val session = AccountSession(fixture.creator,fixture.origin,game.sessionToken()).also(holder::replace)
        val store = TournamentStore(disk,StarterIdentity(fixture.origin,"devnet",fixture.creator))
        var hydrates = 0
        val battles = mutableListOf<Pair<String,String>>()
        private val wallet = CharterWallet(session,holder,session.origin,SolanaCluster.DEVNET,{false},{null},
            if(paused) null else CharterExternalSigner { prepared,cluster,retain,guard ->
                assertEquals(SolanaCluster.DEVNET,cluster); assertEquals("tournament",prepared.kind); guard()
                val record = store.read().records.single { it.review?.operation?.charterObject("attempt")?.charterText("id") == prepared.attemptId }
                assertTrue("wallet" in record.attempts); assertNull(record.signed)
                fixture.approvals++
                val response = fixture.command("sign") { put("actor",fixture.creator); put("unsignedTransaction",Base64.getEncoder().encodeToString(prepared.unsignedTransaction())) }
                val checked = prepared.verifySignedBase64(response.charterText("signedTransaction")); retain(checked); guard(); checked
            })
        private val ports = object : TournamentPorts {
            override val transport = TournamentTransport(TournamentHttpPort(game.charterClientPort(store.identity,session.token)))
            override fun capture(newAction: Boolean): () -> Unit {
                val check = { holder.requireCurrent(session); if(newAction) check(!paused) { "Paired fixture is paused" } }
                check(); return check
            }
            override fun trust() = if(paused) null else fixture.pins
            override fun cryptoPolicy() = if(paused) null else fixture.crypto
            override fun policy() = if(paused) null else fixture.policy
            override fun key() = UUID.randomUUID().toString()
            override fun requireBase(baseId: String) { require(baseId == fixture.baseId) }
            override suspend fun live(prepared: PreparedCharter,operation: JsonObject,guard: () -> Unit): () -> Unit {
                guard(); check(!paused)
                val live = fixture.command("live") {}; val quote = operation.charterObject("attempt").charterObject("quote")
                assertEquals(fixture.pins.toJson().charterObject("deployment").charterText("expectedGenesisHash"),live.charterText("genesisHash"))
                val height = live.getValue("blockHeight").jsonPrimitive.long; val slot = live.getValue("slot").jsonPrimitive.long
                val clock = live.charterText("clockUnixTimestamp").toLong()
                require(height in 0..quote.charterObject("packetInput").getValue("lastValidBlockHeight").jsonPrimitive.long)
                require(slot >= quote.charterObject("context").getValue("closingSlot").jsonPrimitive.long)
                require(clock in prepared.observedUnixTimestamp..prepared.expiryUnixTimestamp)
                return { guard(); check(!paused) }
            }
            override suspend fun ready(guard: () -> Unit) = wallet.requireAvailable(guard)
            override suspend fun sign(prepared: PreparedCharter,guard: () -> Unit,retain: suspend (SignedCharter) -> Unit) { wallet.sign(prepared,retain,guard) }
            override suspend fun hydrate(guard: () -> Unit) { guard(); hydrates++ }
            override suspend fun battle(raidId: String,baseId: String,guard: () -> Unit) { guard(); requireBase(baseId); battles += raidId to baseId }
        }
        val repo = TournamentRepository(store,ports)
        fun operationId() = requireNotNull(repo.state.value.selectedOperation)
        fun operation() = requireNotNull(repo.state.value.operation?.response)
    }
    private data class RequestRecord(val path: String)
    private class Fixture : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { protocols=listOf(Protocol.HTTP_1_1); useHttps(tls.sslSocketFactory(),false); start() }
        val origin = server.url("/").toString().trimEnd('/')
        val transport = OkHttpClient.Builder().protocols(listOf(Protocol.HTTP_1_1)).sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).build()
        private val bridge = Bridge()
        val setup = try { command("start") { put("origin",origin) } } catch(error: Throwable) {
            runCatching { bridge.close() }; server.shutdown(); transport.dispatcher.executorService.shutdown(); throw error
        }
        val creator = text("creator"); val baseId = text("baseId"); val eventId = text("eventId")
        val pins = CharterSigningTrust.from(setup.charterObject("trust"))
        private val catalogue = buildJsonObject { put("constants",setup.getValue("constants")) }
        val crypto = requireNotNull(charterAppPolicy(catalogue)).crypto
        val policy = requireNotNull(tournamentPolicy(catalogue))
        private lateinit var active: Client
        var approvals = 0
        val posts = java.util.Collections.synchronizedList(mutableListOf<RequestRecord>())
        val reads = java.util.Collections.synchronizedList(mutableListOf<RequestRecord>())
        @Volatile var loseNextPost: String? = null
        @Volatile var offline = false
        init { server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse {
                if(offline) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
                val actor = request.getHeader("Cookie")?.split(';')?.map { it.trim() }?.singleOrNull { it.startsWith("pairedActor=") }?.substringAfter('=')
                    ?: return MockResponse().setResponseCode(401)
                require(actor == creator)
                val url = requireNotNull(request.requestUrl); val path = url.encodedPath.removePrefix("/api"); val method = requireNotNull(request.method)
                val raw = request.body.readUtf8(); val body = if(raw.isEmpty()) null else Json.parseToJsonElement(raw).jsonObject
                if(method == "POST" && !path.endsWith("/close")) runBlocking {
                    val records = active.store.read().records
                    val pair = if(path.startsWith("$PREFIX/operations/")) {
                        val action = path.substringAfterLast('/'); val id = path.removePrefix("$PREFIX/operations/").substringBefore('/')
                        records.single { it.key == id && it.kind == "operation" } to if(action == "signed") "upload" else action
                    } else records.single { it.path == path && (path.endsWith("/prize") || it.body["idempotencyKey"] == requireNotNull(body)["idempotencyKey"]) } to "post"
                    assertTrue("Original attempt must be durable before HTTP",pair.first.attempts.any { it == pair.second || it.startsWith("${pair.second}:") })
                    if(pair.second in listOf("upload","deliver")) assertNotNull(pair.first.signed)
                }
                val response = command("request") {
                    put("actor",actor); put("method",method); put("path",path)
                    if(url.queryParameterNames.isNotEmpty()) put("query",buildJsonObject { url.queryParameterNames.forEach { put(it,requireNotNull(url.queryParameter(it))) } })
                    body?.let { put("body",it) }
                }
                (if(method == "POST") posts else reads).add(RequestRecord(path))
                if(method == "POST" && loseNextPost == path) { loseNextPost = null; return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
                return MockResponse().setResponseCode(response.getValue("status").jsonPrimitive.int).setBody(response.charterText("body")).apply {
                    response.charterObject("headers").forEach { (name,value) -> addHeader(name,value.jsonPrimitive.content) }
                }
            }
        } }
        fun text(key: String) = setup.charterText(key)
        fun command(operation: String,fields: JsonObjectBuilder.() -> Unit) = bridge.command(buildJsonObject { put("operation",operation); fields() })
        fun client(disk: MemoryStore = MemoryStore(),paused: Boolean = false) = Client(this,disk,paused).also { active=it }
        override fun close() { try { bridge.close() } finally { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() } }
    }
    private class Bridge : AutoCloseable {
        private val url = requireNotNull(System.getenv("PHASE_E_TOURNAMENT_PAIR_URL")).toHttpUrl().also {
            require(it.scheme == "http" && it.host == "127.0.0.1" && it.encodedPath == "/" && it.query == null && it.fragment == null && it.username.isEmpty() && it.password.isEmpty())
        }
        private val token = requireNotNull(System.getenv("PHASE_E_TOURNAMENT_PAIR_TOKEN")).also { require(it.isNotBlank() && it.length <= 256 && it.all { c -> c.code in 33..126 }) }
        private val http = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).callTimeout(60,TimeUnit.SECONDS).build()
        @Synchronized fun command(value: JsonObject): JsonObject {
            val request = Request.Builder().url(url).header("Authorization","Bearer $token").post(value.toString().toRequestBody("application/json".toMediaType())).build()
            return http.newCall(request).execute().use { response ->
                val body = requireNotNull(response.body); require(body.contentLength() <= 2_097_152 && !body.source().request(2_097_153))
                val raw = Json.parseToJsonElement(body.string()).jsonObject
                check(response.isSuccessful) { "Private tournament fixture command refused: ${value.charterText("operation")}" }; raw
            }
        }
        override fun close() { try { command(buildJsonObject { put("operation","close") }) } finally { http.connectionPool.evictAll(); http.dispatcher.executorService.shutdown() } }
    }
    companion object { private const val PREFIX = "/clans/charter/tournaments" }
}
