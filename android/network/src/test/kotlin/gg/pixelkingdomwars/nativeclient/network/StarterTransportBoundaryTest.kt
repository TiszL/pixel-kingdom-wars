package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.starter.*
import gg.pixelkingdomwars.nativeclient.fleetjourney.FreshFleetDeparture
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryRawStock
import java.io.IOException
import java.util.concurrent.CountDownLatch
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

/** Real HTTPS, original journals and exact adapters for both unpaid starter commands.
 * Synthetic server terms exercise transport integrity, never chain admission or tuning. */
class StarterTransportBoundaryTest {
    private enum class Kind { FLEET, EXPEDITION }
    private class Memory : SecretStore {
        var bytes: String? = null; var fail = false
        override fun read() = bytes
        override fun write(value: String) { if (fail) throw IOException("durable write failed"); bytes = value }
        override fun clear() { bytes = null }
    }
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private val wallet = "11111111111111111111111111111111"
    private val base = id(1); private val key = id(2); private val now = "2026-09-22T12:00:00.000Z"
    private val berth = StarterFleetBerth(id(3), id(4), now)
    private val installation = StarterFleetInstallation(id(5), base, berth.berthId, "starter", berth.completedBuildJobId, now, now)
    private val fleetCommand = StarterFleetCommand(StarterFleetRequest(key, base, berth.berthId), berth, null)
    private fun route(id: String): StarterExpeditionRoute {
        val common = id.startsWith("common_"); val realm = if (common) id.removePrefix("common_").replace('_', '-') else "crownlands"
        return StarterExpeditionRoute(2, 2, id, realm, starterResourceRealms.entries.single { it.value == realm }.key, "starter", 17,
            "101", "77", "24", if (common) StarterExpeditionAccess("starter_common", 1) else null)
    }
    private val expeditionCommand = StarterExpeditionCommand(StarterExpeditionRequest(key, base, installation.installationId, "coastal_survey", 2, 2), route("coastal_survey"), installation)
    private fun fleetView() = StarterFleetView(wallet, base, now, StarterFleetFeatures(StarterFleetFeature(1, 1)), true, null, listOf(berth))
    private fun expeditionView() = StarterExpeditionView(wallet, base, now, StarterExpeditionFeatures(StarterExpeditionFeature(1, 1)), true,
        StarterExpeditionHome("free_policy_preview", 1, "crownlands"), starterRouteIds.map(::route), installation, null, now,
        starterResourceRealms.keys.map { OrdinaryRawStock(it, "9", "1", "10") })
    private inline fun <reified T> raw(value: T) = starterJson.encodeToJsonElement(value).jsonObject
    private fun proof(kind: Kind, accepted: Boolean = true, wrong: Boolean = false): JsonObject = when (kind) {
        Kind.FLEET -> raw(StarterFleetProof(wallet, key, now, if (accepted) "accepted" else "unknown", if (accepted)
            StarterFleetReceipt(wallet, fleetCommand.request.copy(baseId = if (wrong) key else base), installation, now) else null))
        Kind.EXPEDITION -> raw(StarterExpeditionProof(wallet, key, now, if (accepted) "accepted" else "unknown", if (accepted)
            StarterExpeditionReceipt(wallet, expeditionCommand.request.copy(baseId = if (wrong) key else base), key, installation.installationId,
                expeditionCommand.route, now, "2026-09-22T12:00:17.000Z", id(6), "ab".repeat(32)) else null, null))
    }
    private fun failure(code: String) = """{"error":{"code":"$code","message":"Original refusal"}}"""
    private fun tls(listener: EventListener.Factory = EventListener.Factory { object : EventListener() {} }, block: (MockWebServer, OkHttpClient) -> Unit) {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val identity = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).eventListenerFactory(listener).build()
        try { MockWebServer().use { server -> server.useHttps(identity.sslSocketFactory(), false); server.start(); block(server, client) } }
        finally { client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    private inner class Fixture(val kind: Kind, val server: MockWebServer, client: OkHttpClient) {
        val cookies = Memory(); val jar = SessionCookieJar(server.url("/"), cookies); val token = jar.sessionToken()
        val api = GameApi.withTransport(server.url("/").toString(), jar, "test", client)
        val memory = Memory(); val identity = StarterIdentity(server.url("/").toString().trimEnd('/'), "devnet", wallet)
        private val fleet = if (kind == Kind.FLEET) StarterFleetStore(memory, identity) else null
        private val expedition = if (kind == Kind.EXPEDITION) StarterExpeditionStore(memory, identity) else null
        private val fleetTransport = fleet?.let { StarterFleetTransport(it, object : StarterFleetPort {
            override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) = api.getStarterFleet(path, emptyMap(), token, guard, retain)
            override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit) = api.postStarterFleet(path, body, token, guard, retain, refusal)
        }) }
        val departures = mutableListOf<FreshFleetDeparture>()
        var captures = 0; var failVisual = false; var invalidateAfterRetain = false
        private val expeditionTransport = expedition?.let { StarterExpeditionTransport(it, object : StarterExpeditionPort {
            override suspend fun get(path: String, guard: () -> Unit, retain: (JsonObject) -> Unit) = api.getStarterExpedition(path, emptyMap(), token, guard, retain)
            override suspend fun post(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit, refusal: (ApiException) -> Unit) = api.postStarterExpedition(path, body, token, guard, retain, refusal)
            override suspend fun postWithDeparture(path: String, body: JsonObject, guard: () -> Unit, retain: (JsonObject) -> Unit,
                refusal: (ApiException) -> Unit, created: (FreshFleetDeparture) -> Unit) = api.postStarterExpeditionWithDeparture(path, body, token, guard,
                    { raw -> retain(raw); if (invalidateAfterRetain) jar.beginAuthentication() }, refusal, created)
        }, captureDeparture = { capturedBase, _ ->
            assertEquals(base, capturedBase); assertEquals(1, server.requestCount); captures++;
            { departure: FreshFleetDeparture ->
                assertEquals(departure.original, retained()); departures += departure
                if (failVisual) error("optional animation failed")
            }
        }) }
        val currentPath get() = if (kind == Kind.FLEET) "/starter-fleet" else "/starter-expeditions"
        val postPath get() = if (kind == Kind.FLEET) "/starter-fleet/installations" else "/starter-expeditions"
        val receiptPath get() = if (kind == Kind.FLEET) fleetCommand.receiptPath else expeditionCommand.receiptPath
        val body get() = if (kind == Kind.FLEET) fleetCommand.request.body() else expeditionCommand.request.body()
        val code get() = if (kind == Kind.FLEET) "PHASE_E_DISABLED" else "STARTER_EXPEDITIONS_DISABLED"
        val requests get() = fleet?.requests ?: requireNotNull(expedition).requests
        init { fleet?.begin(fleet.read(), fleetCommand); expedition?.begin(expedition.read(), expeditionCommand) }
        suspend fun confirm() { if (kind == Kind.FLEET) fleetTransport!!.confirm(fleet!!.read(), ::fleetView) {} else expeditionTransport!!.confirm(expedition!!.read(), ::expeditionView) {} }
        suspend fun check() { if (kind == Kind.FLEET) fleetTransport!!.check {} else expeditionTransport!!.check {} }
        fun markAttempt() { fleet?.attempt(fleet.read()); expedition?.attempt(expedition.read()) }
        fun attempted() = if (kind == Kind.FLEET) fleet!!.read().operation!!.attemptRevision != null else expedition!!.read().operation!!.attemptRevision != null
        fun refused() = if (kind == Kind.FLEET) fleet!!.read().operation!!.refusal != null else expedition!!.read().operation!!.refusal != null
        fun retained(): JsonObject? = if (kind == Kind.FLEET) StarterFleetStore(memory, identity).read().operation!!.proof?.let { raw(it) }
            else StarterExpeditionStore(memory, identity).read().operation!!.proof?.let { raw(it) }
        suspend fun get(path: String, query: Map<String, String>, guard: () -> Unit = {}, retain: ((JsonObject) -> Unit)? = null) =
            if (kind == Kind.FLEET) api.getStarterFleet(path, query, token, guard, retain) else api.getStarterExpedition(path, query, token, guard, retain)
        suspend fun post(path: String, body: JsonObject, guard: () -> Unit = {}) = if (kind == Kind.FLEET) api.postStarterFleet(path, body, token, guard, {}, {})
            else api.postStarterExpedition(path, body, token, guard, {}, {})
        fun unknown() { server.enqueue(MockResponse().setBody(proof(kind, false).toString())) }
        fun accepted(wrong: Boolean = false, created: Boolean = false, status: Int = 201) {
            server.enqueue(MockResponse().setResponseCode(status).setBody(proof(kind, wrong = wrong).toString())
                .addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly").apply { if (created) addHeader("x-pkw-journey-created", "1") })
        }
    }

    @Test fun `C5 starter captures before POST and emits only marked201 after durable retention never history`() {
        for ((status, marked) in listOf(201 to true, 200 to true, 201 to false)) tls { server, client ->
            val f = Fixture(Kind.EXPEDITION, server, client); f.failVisual = true
            f.unknown(); f.accepted(created = marked, status = status)
            runBlocking { f.confirm() }
            assertEquals(1, f.captures); assertNotNull(f.retained())
            assertEquals(if (status == 201 && marked) 1 else 0, f.departures.size)
            f.accepted(created = true); runBlocking { f.check() }
            assertEquals(1, f.captures); assertEquals(if (status == 201 && marked) 1 else 0, f.departures.size)
            assertEquals(3, server.requestCount)
        }
    }
    @Test fun `C5 changed session retains original but cannot emit a fresh departure`() = tls { server, client ->
        val f = Fixture(Kind.EXPEDITION, server, client); f.invalidateAfterRetain = true
        f.unknown(); f.accepted(created = true)
        assertThrows(SessionSupersededException::class.java) { runBlocking { f.confirm() } }
        assertNotNull(f.retained()); assertTrue(f.departures.isEmpty()); assertEquals(2, server.requestCount)
    }

    @Test fun `C5 Wake sidecar reads stay exact guarded paths without any departure metadata`() = tls { server, client ->
        val f = Fixture(Kind.EXPEDITION, server, client)
        val pair = Json.parseToJsonElement(requireNotNull(javaClass.getResource("/boundcosmetics/wake-sidecar-primary-pair.json")).readText()).jsonObject
        for (kind in listOf("starter", "advanced")) {
            val sample = pair.getValue(kind).jsonObject.getValue("selected").jsonObject
            val side = sample.getValue("sidecar").jsonObject
            server.enqueue(MockResponse().setBody(side.toString()))
            assertEquals(side, runBlocking { f.api.getBoundCosmetic("/bound-cosmetics/wakes/v1/originals/$kind/${side.getValue("key").jsonPrimitive.content}", emptyMap(), f.token, {}) })
        }
        val current = pair.getValue("starter").jsonObject.getValue("selected").jsonObject.getValue("current").jsonObject
        server.enqueue(MockResponse().setBody(current.toString()))
        assertEquals(current, runBlocking { f.api.getBoundCosmetic("/bound-cosmetics/wakes/v1/current", mapOf("baseId" to current.getValue("baseId").jsonPrimitive.content), f.token, {}) })
        for ((path, query) in listOf("/bound-cosmetics/wakes/v1/current" to emptyMap(),
            "/bound-cosmetics/wakes/v1/current" to mapOf("baseId" to base, "wallet" to wallet),
            "/bound-cosmetics/wakes/v1/originals/other/$key" to emptyMap(),
            "/bound-cosmetics/wakes/v1/originals/starter/$key/extra" to emptyMap(),
            "/bound-cosmetics/wakes/v1/originals/starter/$key" to mapOf("baseId" to base))) {
            assertThrows(Exception::class.java) { runBlocking { f.api.getBoundCosmetic(path, query, f.token, {}) } }
        }
        assertEquals(3, server.requestCount); assertTrue(f.departures.isEmpty())
    }

    @Test fun `strict paths queries scalar bodies and immutable sessions refuse before network`() {
        for (kind in Kind.entries) tls { server, client ->
            val f = Fixture(kind, server, client)
            for ((path, query) in listOf("/me" to emptyMap(), f.currentPath to emptyMap(), f.currentPath to mapOf("baseId" to base, "wallet" to wallet),
                f.currentPath to mapOf("baseId" to "bad"), f.receiptPath to mapOf("baseId" to base), "${f.receiptPath}/" to emptyMap(),
                "${f.receiptPath}%2f" to emptyMap(), f.receiptPath.replace(key, "ABCDEF00-0000-4000-8000-000000000002") to emptyMap()))
                assertThrows(Exception::class.java) { runBlocking { f.get(path, query, retain = {}) } }
            assertThrows(Exception::class.java) { runBlocking { f.get(f.receiptPath, emptyMap()) } }
            assertThrows(Exception::class.java) { runBlocking { f.post("/me", f.body) } }
            for (body in listOf(JsonObject(f.body + ("wallet" to JsonPrimitive(wallet))), JsonObject(f.body + ("baseId" to JsonPrimitive(true))),
                JsonObject(f.body + ((if (kind == Kind.FLEET) "berthId" else "routeVersion") to JsonPrimitive("7")))))
                assertThrows(Exception::class.java) { runBlocking { f.post(f.postPath, body) } }
            assertEquals(0, server.requestCount)
            server.enqueue(MockResponse().setBody(if (kind == Kind.FLEET) raw(fleetView()).toString() else raw(expeditionView()).toString()))
            runBlocking { val result = f.get(f.currentPath, mapOf("baseId" to base)); if (kind == Kind.FLEET) StarterFleetView.from(result) else StarterExpeditionView.from(result) }
            assertEquals("/api${f.currentPath}?baseId=$base", server.takeRequest().path)
            f.jar.beginAuthentication(); assertThrows(SessionSupersededException::class.java) { runBlocking { f.get(f.receiptPath, emptyMap(), retain = {}) } }
            assertEquals(1, server.requestCount)
        }
    }
    @Test fun `actual enqueue rechecks admission after IO without sending an obsolete review`() {
        for (kind in Kind.entries) {
            var current = true; var checks = 0
            tls(EventListener.Factory { current = false; object : EventListener() {} }) { server, client ->
                val f = Fixture(kind, server, client)
                assertThrows(IllegalStateException::class.java) { runBlocking { f.post(f.postPath, f.body) { checks++; check(current) } } }
                assertEquals(2, checks); assertEquals(0, server.requestCount)
            }
        }
    }
    @Test fun `one exact unpaid POST retains accepted proof without automatic GET retry or currency headers`() {
        for (kind in Kind.entries) tls { server, client ->
            val f = Fixture(kind, server, client); f.unknown(); f.accepted(); runBlocking { f.confirm() }
            assertEquals(proof(kind), f.retained()); assertEquals(2, server.requestCount)
            val get = server.takeRequest(); assertEquals("GET", get.method); assertEquals("/api${f.receiptPath}", get.path)
            val sent = server.takeRequest(); assertEquals("POST", sent.method); assertEquals("/api${f.postPath}", sent.path)
            assertEquals(f.body.toString(), sent.body.readUtf8()); assertNull(sent.getHeader("x-pkw-currency")); assertNull(sent.getHeader("x-pkw-expected-currency"))
        }
    }
    @Test fun `GET and POST retain only matching original scope before rejecting retired session and cookies`() {
        for (kind in Kind.entries) for (method in listOf("GET", "POST")) for (wrong in listOf(false, true)) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (call.request().method == method) f.jar.beginAuthentication() } } }) { server, client ->
                f = Fixture(kind, server, client); if (method == "POST") f.unknown(); f.accepted(wrong)
                assertThrows(Exception::class.java) { runBlocking { if (method == "POST") f.confirm() else f.check() } }
                assertEquals(!wrong, f.retained() != null); assertNull(f.cookies.bytes); assertNotSame(f.token, f.jar.sessionToken())
                assertEquals(if (method == "POST") 2 else 1, server.requestCount)
            }
        }
    }
    @Test fun `typed first refusal survives cancellation while retry and GET remain uncertain`() {
        for (kind in Kind.entries) for (attempt in listOf("first", "retry", "get")) {
            lateinit var task: Job; val method = if (attempt == "get") "GET" else "POST"
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyEnd(call: Call, byteCount: Long) { if (call.request().method == method) task.cancel() } } }) { server, client -> runBlocking {
                val f = Fixture(kind, server, client); if (attempt == "retry") f.markAttempt(); if (method == "POST") f.unknown()
                server.enqueue(MockResponse().setResponseCode(503).setBody(failure(f.code)).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { if (method == "POST") f.confirm() else f.check() }
                task.start(); withTimeout(5_000) { task.join() }; assertEquals(attempt == "first", f.refused()); assertNull(f.retained())
                assertNull(f.cookies.bytes); assertEquals(if (method == "POST") 2 else 1, server.requestCount)
            } }
        }
    }
    @Test fun `first typed refusal is persisted before replacement session rejects its cookies`() {
        for (kind in Kind.entries) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                if (call.request().method == "POST") f.jar.beginAuthentication()
            } } }) { server, client ->
                f = Fixture(kind, server, client); f.unknown()
                server.enqueue(MockResponse().setResponseCode(503).setBody(failure(f.code)).addHeader("Set-Cookie", "session=obsolete; Path=/; Secure; HttpOnly"))
                assertThrows(SessionSupersededException::class.java) { runBlocking { f.confirm() } }
                assertTrue(f.refused()); assertTrue(f.attempted()); assertNull(f.retained()); assertNull(f.cookies.bytes); assertEquals(2, server.requestCount)
            }
        }
    }
    @Test fun `cancelled complete original GET keeps positive proof and rejects obsolete cookies`() {
        for (kind in Kind.entries) {
            lateinit var task: Job
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyEnd(call: Call, byteCount: Long) { task.cancel() } } }) { server, client -> runBlocking {
                val f = Fixture(kind, server, client); f.accepted()
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.check() }; task.start(); withTimeout(5_000) { task.join() }
                assertEquals(proof(kind), f.retained()); assertNull(f.cookies.bytes); assertEquals(1, server.requestCount)
            } }
        }
    }
    @Test fun `malformed wrong-status and conflicting error bodies stay uncertain through callback and catch`() {
        for (kind in Kind.entries) for (retire in listOf(false, true)) {
            val code = if (kind == Kind.FLEET) "PHASE_E_DISABLED" else "STARTER_EXPEDITIONS_DISABLED"
            for ((status, body) in listOf(503 to """{"error":{"code":"$code","message":true}}""", 503 to """{"error":{"code":true,"message":"No"}}""",
                503 to """{"code":"$code","message":"No"}""", 503 to "{bad-json", 409 to failure(code), 409 to failure("IDEMPOTENCY_BODY_MISMATCH"))) {
                lateinit var f: Fixture
                tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (retire && call.request().method == "POST") f.jar.beginAuthentication() } } }) { server, client ->
                    f = Fixture(kind, server, client); f.unknown(); server.enqueue(MockResponse().setResponseCode(status).setBody(body))
                    assertThrows(Exception::class.java) { runBlocking { f.confirm() } }; assertTrue(f.attempted()); assertFalse(f.refused()); assertNull(f.retained()); assertEquals(2, server.requestCount)
                }
            }
        }
    }
    @Test fun `failed success or refusal persistence prevents cookies and preserves attempted original`() {
        for (kind in Kind.entries) for (accepted in listOf(false, true)) {
            lateinit var f: Fixture
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) { if (call.request().method == "POST") f.memory.fail = true } } }) { server, client ->
                f = Fixture(kind, server, client); f.unknown()
                server.enqueue(MockResponse().setResponseCode(if (accepted) 201 else 503).setBody(if (accepted) proof(kind).toString() else failure(f.code)).addHeader("Set-Cookie", "session=uncommitted; Path=/; Secure; HttpOnly"))
                assertThrows(IOException::class.java) { runBlocking { f.confirm() } }; assertTrue(f.attempted()); assertFalse(f.refused()); assertNull(f.retained()); assertNull(f.cookies.bytes)
                assertEquals(2, server.requestCount)
            }
        }
    }
    @Test fun `owned cancellation drains original body before releasing journal lock or accepting cookies`() {
        for (kind in Kind.entries) {
            lateinit var f: Fixture; lateinit var task: Job
            val entered = CountDownLatch(1); val release = CountDownLatch(1); val cancelled = java.util.concurrent.atomic.AtomicBoolean()
            tls(EventListener.Factory { object : EventListener() { override fun responseBodyStart(call: Call) {
                if (call.request().method == "POST") { f.jar.beginAuthentication(); task.cancel(); entered.countDown(); check(release.await(5, TimeUnit.SECONDS)); cancelled.set(call.isCanceled()) }
            } } }) { server, client -> runBlocking {
                f = Fixture(kind, server, client); f.unknown(); f.accepted()
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.confirm() }; task.start()
                try { assertTrue(entered.await(5, TimeUnit.SECONDS)); assertFalse(task.isCompleted); assertFalse(f.requests.tryLock()); assertNull(f.retained()) }
                finally { release.countDown() }
                withTimeout(5_000) { task.join() }; assertFalse(cancelled.get()); assertEquals(proof(kind), f.retained()); assertNull(f.cookies.bytes)
                assertTrue(f.requests.tryLock()); f.requests.unlock(); assertEquals(2, server.requestCount)
            } }
        }
    }
    @Test fun `partial response and redirect cannot manufacture proof relay or automatically replay a command`() {
        for (kind in Kind.entries) for (redirect in listOf(false, true)) tls { server, client ->
            val f = Fixture(kind, server, client); f.unknown()
            server.enqueue(if (redirect) MockResponse().setResponseCode(307).addHeader("Location", server.url("/other")).setBody("{}")
                else MockResponse().setResponseCode(201).setBody(proof(kind).toString()).setSocketPolicy(SocketPolicy.DISCONNECT_DURING_RESPONSE_BODY))
            assertThrows(if (redirect) ApiException::class.java else IOException::class.java) { runBlocking { f.confirm() } }
            assertTrue(f.attempted()); assertNull(f.retained()); assertFalse(f.refused()); assertEquals(2, server.requestCount)
        }
    }
    @Test fun `owned stalled refusal times out after cancellation and never supplies terminal evidence`() {
        for (kind in Kind.entries) {
            lateinit var task: Job
            val owned = CompletableDeferred<Unit>(); val armed = java.util.concurrent.atomic.AtomicBoolean(); val readFailure = java.util.concurrent.atomic.AtomicReference<IOException?>()
            tls(EventListener.Factory { object : EventListener() { override fun responseFailed(call: Call, ioe: IOException) { readFailure.set(ioe) } } }) { server, client -> runBlocking {
                val bounded = client.newBuilder().addInterceptor { chain ->
                    val response = chain.proceed(chain.request()); if (chain.request().method != "POST") return@addInterceptor response
                    val body = requireNotNull(response.body)
                    val source = object : okio.ForwardingSource(body.source()) {
                        override fun read(sink: okio.Buffer, byteCount: Long): Long {
                            if (armed.compareAndSet(false, true)) { timeout().timeout(500, TimeUnit.MILLISECONDS); owned.complete(Unit); task.cancel() }
                            return super.read(sink, byteCount)
                        }
                    }.buffer()
                    response.newBuilder().body(object : ResponseBody() {
                        override fun contentType() = body.contentType(); override fun contentLength() = body.contentLength(); override fun source() = source
                    }).build()
                }.build()
                val f = Fixture(kind, server, bounded); f.unknown(); server.enqueue(MockResponse().setResponseCode(503).setBody(failure(f.code)).setBodyDelay(2, TimeUnit.SECONDS))
                task = launch(Dispatchers.Default, start = CoroutineStart.LAZY) { f.confirm() }; task.start(); withTimeout(5_000) { owned.await() }; withTimeout(3_000) { task.join() }
                assertTrue(readFailure.get() is java.net.SocketTimeoutException); assertNull(f.retained()); assertFalse(f.refused()); assertTrue(f.attempted()); assertEquals(2, server.requestCount)
            } }
        }
    }
}
