package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAtlasGroup
import gg.pixelkingdomwars.nativeclient.renderer.ServiceFilePin
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.coroutines.CoroutineContext

class ServiceContentTest {
    private val atlas = "atlas/pe_workshop_t1@1x.json"
    private val image = "atlas/pe_workshop_t1@1x.png"
    private val jsonBytes = "verified atlas JSON"
    private val imageBytes = "verified service PNG"
    private fun hash(value: String) = MessageDigest.getInstance("SHA-256").digest(value.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun manifest(pixels: String = imageBytes, source: String = "a".repeat(40), optional: Boolean = true): JsonObject {
        val values = sortedMapOf("catalogue.json" to "{}", "render-catalog.json" to "{}", "contracts.json" to "{}", "atlas/meta.json" to "{}", "kotlin/NativeContracts.kt" to "{}", atlas to jsonBytes, image to pixels)
        val files = buildJsonArray { values.forEach { (path, value) -> add(buildJsonObject {
            put("path", path); put("sha256", hash(value)); put("size", value.length); put("tier", if (optional && path in setOf(atlas, image)) "optional" else "core")
        }) } }
        val identity = buildJsonObject { put("schemaVersion", 1); put("sourceCommit", source); put("simVersion", 18); put("files", files) }
        return buildJsonObject {
            identity.forEach { (key, value) -> put(key, value) }; put("contentVersion", hash(identity.toString()))
            put("cataloguePath", "catalogue.json"); put("renderCataloguePath", "render-catalog.json"); put("atlasMetadataPath", "atlas/meta.json")
            put("contractPath", "contracts.json"); put("kotlinModelsPath", "kotlin/NativeContracts.kt")
        }
    }
    private fun group(pixels: String = imageBytes) = ServiceAtlasGroup("pe_workshop_t1", atlas, image, 112L * 112 * 4,
        listOf(ServiceFilePin(atlas, hash(jsonBytes), jsonBytes.length.toLong()), ServiceFilePin(image, hash(pixels), pixels.length.toLong())))
    private data class Harness(val server: MockWebServer, val content: ServiceContent, val api: FakeApiClient, val root: File, val owner: Job,
                               override val coroutineContext: CoroutineContext) : CoroutineScope
    private fun fixture(available: (File) -> Long = { it.usableSpace }, block: suspend Harness.() -> Unit) = runBlocking {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val trusted = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply { useHttps(serverTls.sslSocketFactory(), false); start() }
        val transport = OkHttpClient.Builder().sslSocketFactory(trusted.sslSocketFactory(), trusted.trustManager).cookieJar(object : CookieJar {
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {}
            override fun loadForRequest(url: HttpUrl) = listOf(Cookie.Builder().domain(url.host).name("ambient").value("must-not-leak").build())
        }).build()
        val root = Files.createTempDirectory("service-content-test").toFile()
        val content = ServiceContent(root, server.url("/").toString(), transport = transport, availableBytes = available)
        val owner = SupervisorJob(); val api = FakeApiClient()
        api.onGet("/native/capabilities") { buildJsonObject { put("protocolVersion", 2); put("simVersion", 18); put("contentManifestUrl", server.url("/content/manifest.json").toString()) } }
        try { Harness(server, content, api, root, owner, coroutineContext).block() }
        finally { owner.cancel(); owner.children.toList().joinAll(); content.awaitLeaseReleases(); server.shutdown(); root.deleteRecursively() }
    }
    private fun Harness.session(pixels: String = imageBytes, source: String = "a".repeat(40), guard: () -> Unit = {}): ServiceContentSession =
        content.session(nativeContentManifest(manifest(pixels, source), 18), mapOf("pe_workshop_t1" to group(pixels)), api, owner, guard)
    private fun Harness.enqueue(pixels: String = imageBytes) {
        server.enqueue(MockResponse().setBody(manifest(pixels).toString()))
        server.enqueue(MockResponse().setBody(jsonBytes)); server.enqueue(MockResponse().setBody(pixels))
    }
    private suspend fun ServiceContentSession.acquire() = withContext(Dispatchers.IO) { assets.acquire("pe_workshop_t1") {} }

    @Test fun `only selected pair downloads and verified cache reopens offline without cookies`() = fixture {
        enqueue()
        session().use { session -> session.acquire().use { lease ->
            assertEquals(jsonBytes, File(lease.directory.file(), atlas).readText())
            assertEquals(imageBytes, File(lease.directory.file(), image).readText())
        } }
        val paths = List(3) { requireNotNull(server.takeRequest(2, TimeUnit.SECONDS)).also { request ->
            assertEquals("GET", request.method); assertNull(request.getHeader("Cookie")); assertNull(request.getHeader("Authorization"))
        }.path }
        assertEquals(listOf("/content/manifest.json", "/content/$atlas", "/content/$image"), paths)
        api.onGet("/native/capabilities") { error("offline") }
        session().use { it.acquire().close() }; assertEquals(3, server.requestCount)
    }

    @Test fun `unchanged pair retains original receipt across unrelated content source changes`() = fixture {
        enqueue()
        val original = session().use { it.acquire().use { lease -> lease.directory.file() } }
        api.onGet("/native/capabilities") { error("offline") }
        session(source = "b".repeat(40)).use { it.acquire().use { lease -> assertEquals(original, lease.directory.file()) } }
        assertEquals(3, server.requestCount)
    }

    @Test fun `remote release cannot replace original group pins or silently mark them core`() = fixture {
        for (remote in listOf(manifest("new unrelated art"), manifest(optional = false))) {
            server.enqueue(MockResponse().setBody(remote.toString()))
            session().use { original -> assertThrows(IllegalArgumentException::class.java) { runBlocking { original.acquire().close() } } }
        }
        assertEquals(2, server.requestCount)
        assertFalse(File(root, "pe_workshop_t1/active").exists())
    }

    @Test fun `incorrect group pins and absent admitted full manifest membership refuse before network`() = fixture {
        val admitted = nativeContentManifest(manifest(), 18)
        for (wrong in listOf(group().copy(files = group().files.reversed()), group().copy(imagePath = "../private"), group().copy(id = "../private"),
            group().copy(files = group().files.map { it.copy(sha256 = "f".repeat(64)) }))) {
            assertThrows(IllegalArgumentException::class.java) { content.session(admitted, mapOf(wrong.id to wrong), api, owner) {} }
        }
        assertThrows(NoSuchElementException::class.java) { content.session(admitted.copy(files = admitted.files.filter { it.path != atlas }), mapOf(group().id to group()), api, owner) {} }
        assertEquals(0, server.requestCount)
    }

    @Test fun `unknown group and stale session refuse before any capability or asset request`() = fixture {
        val current = AtomicBoolean(true)
        val session = session { check(current.get()) { "session replaced" } }
        assertTrue(session.assets.isCurrent())
        assertThrows(IllegalArgumentException::class.java) { session.assets.acquire("pe_unknown") {} }
        current.set(false)
        assertFalse(session.assets.isCurrent())
        assertThrows(IllegalStateException::class.java) { session.assets.acquire(group().id) {} }
        session.close(); assertEquals(0, server.requestCount)
    }

    @Test fun `same-origin HTTPS refusal prevents foreign credentialed and query destinations`() = fixture {
        for (url in listOf("https://other.invalid/manifest.json", server.url("/manifest.json?token=x").toString(), server.url("/manifest.json").newBuilder().username("user").build().toString())) {
            api.onGet("/native/capabilities") { buildJsonObject { put("protocolVersion", 2); put("simVersion", 18); put("contentManifestUrl", url) } }
            session().use { original -> assertThrows(IllegalArgumentException::class.java) { runBlocking { original.acquire() } } }
        }
        assertEquals(0, server.requestCount)
    }

    @Test fun `redirected manifest is not followed`() = fixture {
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", server.url("/unexpected")))
        session().use { original -> assertThrows(IllegalArgumentException::class.java) { runBlocking { original.acquire() } } }
        assertEquals(1, server.requestCount)
    }

    @Test fun `wrong hash oversized and short body never activate partial pair`() = fixture {
        for (body in listOf("x".repeat(imageBytes.length), imageBytes + "extra", "short")) {
            server.enqueue(MockResponse().setBody(manifest().toString())); server.enqueue(MockResponse().setBody(jsonBytes)); server.enqueue(MockResponse().setBody(body))
            session().use { original -> assertThrows(IllegalArgumentException::class.java) { runBlocking { original.acquire() } } }
            assertFalse(File(root, "pe_workshop_t1/active").exists())
        }
    }

    @Test fun `insufficient storage refuses before downloading either file`() = fixture(available = { 0 }) {
        server.enqueue(MockResponse().setBody(manifest().toString()))
        session().use { original -> assertThrows(IllegalArgumentException::class.java) { runBlocking { original.acquire() } } }
        assertEquals(1, server.requestCount)
    }

    @Test fun `published closure is cancellation before lifetime propagation`() {
        val owner = SupervisorJob()
        val acquired = AtomicBoolean(false)
        val original = ServiceContentSession(owner, {}) { _, _ ->
            acquired.set(true); error("Closed session dispatched acquisition")
        }
        try {
            // Reproduce close's atomic publication boundary without a timing loop
            // or a production hook: lifetime cancellation has not propagated yet.
            val closed = ServiceContentSession::class.java.getDeclaredField("closed")
                .apply { isAccessible = true }.get(original) as AtomicBoolean
            closed.set(true)
            assertTrue(owner.children.single().isActive)
            assertThrows(CancellationException::class.java) { original.assets.acquire("pe_workshop_t1") {} }
            assertFalse(acquired.get())
            assertTrue(owner.isActive)
        } finally { owner.cancel() }
    }

    @Test fun `close cancels stalled body and joins actual installation cleanup`() = fixture {
        server.enqueue(MockResponse().setBody(manifest().toString()))
        server.enqueue(MockResponse().setBody(jsonBytes).setBodyDelay(3, TimeUnit.SECONDS))
        val original = session()
        val waiting = async(Dispatchers.IO) { original.assets.acquire(group().id) {} }
        withContext(Dispatchers.IO) { repeat(2) { assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)) } }
        original.close()
        assertFalse(original.assets.isCurrent())
        withTimeout(2_000) { assertTrue(runCatching { waiting.await() }.exceptionOrNull() is CancellationException) }
        assertFalse(File(root, "pe_workshop_t1/active").exists())
        assertTrue(File(root, "pe_workshop_t1").listFiles().orEmpty().none { it.name.startsWith("staging-") })
    }

    @Test fun `account scope cancellation immediately cancels HTTP without waiting for UI disposal`() = fixture {
        server.enqueue(MockResponse().setBody(manifest().toString()))
        server.enqueue(MockResponse().setBody(jsonBytes).setBodyDelay(3, TimeUnit.SECONDS))
        val original = session()
        val waiting = async(Dispatchers.IO) { original.assets.acquire(group().id) {} }
        withContext(Dispatchers.IO) { repeat(2) { assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)) } }
        owner.cancel()
        assertFalse(original.assets.isCurrent())
        withTimeout(2_000) { assertTrue(runCatching { waiting.await() }.exceptionOrNull() is CancellationException) }
        original.close(); assertFalse(File(root, "pe_workshop_t1/active").exists())
    }

    @Test fun `concurrent same group acquisition installs one immutable pair and keeps both leases`() = fixture {
        enqueue()
        session().use { original ->
            val values = List(2) { async(Dispatchers.IO) { original.assets.acquire(group().id) {} } }.awaitAll()
            assertEquals(values[0].directory.file(), values[1].directory.file()); values.forEach { it.close() }
        }
        assertEquals(3, server.requestCount)
    }

    @Test fun `lease close never waits on another stalled ContentStore install monitor`() = fixture {
        enqueue(); val priorSession = session(); val prior = priorSession.acquire()
        val next = "new source service PNG"
        server.enqueue(MockResponse().setBody(manifest(next).toString())); server.enqueue(MockResponse().setBody(jsonBytes).setBodyDelay(3, TimeUnit.SECONDS))
        val nextSession = session(next)
        val waiting = async(Dispatchers.IO) { nextSession.assets.acquire(group().id) {} }
        withContext(Dispatchers.IO) { repeat(5) { assertNotNull(server.takeRequest(2, TimeUnit.SECONDS)) } }
        withTimeout(1_000) { withContext(Dispatchers.Default) { prior.close(); prior.close() } }
        nextSession.close()
        withTimeout(2_000) { assertTrue(runCatching { waiting.await() }.exceptionOrNull() is CancellationException) }
        content.awaitLeaseReleases(); priorSession.close()
    }

    @Test fun `old absent and unknown renderer catalogues never create a service session`() = fixture {
        for (render in listOf<JsonObject?>(null, buildJsonObject { put("rendererContractVersion", 14) }, buildJsonObject { put("rendererContractVersion", 16) }, buildJsonObject { put("rendererContractVersion", "15") })) {
            assertThrows(IllegalArgumentException::class.java) { runBlocking { content.open(ContentState(renderCatalogue = render), api, owner) {} } }
        }
        assertEquals(0, server.requestCount)
    }

    private fun capability(enabled: Boolean) = buildJsonObject {
        put("protocolVersion", 2); put("simVersion", 18)
        put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", enabled) })
    }

    @Test fun `art permission requires exact current capability and failed reads revoke cached permission`() = runBlocking {
        val api = FakeApiClient(); val values = mutableListOf<Boolean>()
        val permission = ServiceArtPermission(api, {}, values::add)
        api.onGet("/native/capabilities") { capability(true) }; permission.refresh(); assertTrue(values.last())
        for (raw in listOf(buildJsonObject { put("protocolVersion", 2); put("simVersion", 18) },
            buildJsonObject { capability(true).forEach { (key, value) -> put(key, value) }; put("phaseEArt", buildJsonObject { put("version", 2); put("enabled", true) }) },
            buildJsonObject { capability(true).forEach { (key, value) -> put(key, value) }; put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", "true") }) })) {
            api.onGet("/native/capabilities") { raw }; permission.refresh(); assertFalse(values.last())
        }
        api.onGet("/native/capabilities") { error("offline") }; permission.refresh(); assertFalse(values.last())
        permission.close()
    }

    @Test fun `late positive observation cannot overwrite a newer disabled observation`() = runBlocking {
        val api = FakeApiClient(); val values = mutableListOf<Boolean>(); val original = CompletableDeferred<JsonObject>()
        val permission = ServiceArtPermission(api, {}, values::add)
        api.onGet("/native/capabilities") { original.await() }
        val first = async(start = CoroutineStart.UNDISPATCHED) { permission.refresh() }
        api.onGet("/native/capabilities") { capability(false) }; permission.refresh()
        original.complete(capability(true)); first.await()
        assertTrue(values.isNotEmpty()); assertTrue(values.none { it }); permission.close()
    }

    @Test fun `closed foreground owner cannot publish a late positive reply or fetch again`() = runBlocking {
        val api = FakeApiClient(); val values = mutableListOf<Boolean>(); val original = CompletableDeferred<JsonObject>(); var reads = 0
        val permission = ServiceArtPermission(api, {}, values::add)
        api.onGet("/native/capabilities") { reads++; original.await() }
        val first = async(start = CoroutineStart.UNDISPATCHED) { permission.refresh() }
        permission.close(); original.complete(capability(true)); first.await(); permission.refresh()
        assertEquals(1, reads); assertTrue(values.none { it })
    }

    @Test fun `same wallet reauthentication and changed content cannot revive the retired owner`() = runBlocking {
        val api = FakeApiClient(); val values = mutableListOf<Boolean>(); val original = CompletableDeferred<JsonObject>()
        var epoch = 1
        val permission = ServiceArtPermission(api, { check(epoch == 1) }, values::add)
        api.onGet("/native/capabilities") { original.await() }
        val first = async(start = CoroutineStart.UNDISPATCHED) { permission.refresh() }
        epoch = 3 // A → B → A is a different owner, even when the wallet/content names match.
        original.complete(capability(true)); first.await()
        assertTrue(values.none { it }); permission.close()
    }

    // ---- Renderer16 (C4): the candidate pack opens with the extension attached ------------
    private fun candidate(name: String) = File(CosmeticsCandidateFixture.root, name)
    private fun candidateState(): ContentState {
        val render = Json.parseToJsonElement(CosmeticsCandidateFixture.renderCatalogueText()).jsonObject
        val catalogue = Json.parseToJsonElement(candidate("catalogue.json").readText()).jsonObject
        val manifest = nativeContentManifest(Json.parseToJsonElement(candidate("manifest.json").readText()).jsonObject, 18)
        return ContentState(assets = candidate(""), catalogue = catalogue, renderCatalogue = render, manifest = manifest)
    }
    @Test fun `a renderer16 candidate opens once with the Awning extension on the same admitted graph and no network`() = fixture {
        val state = candidateState()
        runBlocking { content.open(state, api, owner) {} }.use { session ->
            val art = requireNotNull(session.art)
            assertNotNull(art.cosmetics); assertEquals(47, art.groups.size)
            assertTrue("pe_cosmetics" in art.groups)
            val admitted = requireNotNull(session.admitted())
            assertSame(art, admitted.art); assertSame(session.assets, admitted.assets)
            assertTrue(session.assets.isCurrent())
        }
        assertEquals(0, server.requestCount)
        // A 15 catalogue may not carry the block; a 16 catalogue may not omit it; the internal test seam has no art.
        val render = requireNotNull(state.renderCatalogue)
        val fifteen = JsonObject(render + ("rendererContractVersion" to JsonPrimitive(15)))
        assertThrows(IllegalArgumentException::class.java) { runBlocking { content.open(state.copy(renderCatalogue = fifteen), api, owner) {} } }
        val bare = JsonObject(render - "boundCosmetics")
        assertThrows(IllegalArgumentException::class.java) { runBlocking { content.open(state.copy(renderCatalogue = bare), api, owner) {} } }
        assertNull(session().use { it.art })
        assertEquals(0, server.requestCount)
    }

    // ---- N-C5 CONTENT17: the private fleet owner and the ordinary service metadata opener ----
    /** Root's READ-ONLY exact metadata fixture (test-fixtures/candidate-6f7a9e81-sim18-r17-fleet, see its README) plus the
     *  inherited candidate16 catalogue; every payload is size/digest-rechecked before use. Metadata only — no PNG payloads. */
    private object Fleet17Fixture {
        val root = File("../test-fixtures/candidate-6f7a9e81-sim18-r17-fleet")
        const val CONTENT_VERSION = "3d1c33336387e4f5880e47cacc1c4df4375e425855b3d71417b63387b07ba3bd"
        fun sha(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
        private fun pinned(bytes: ByteArray, size: Int, digest: String, name: String) = bytes.also { check(it.size == size && sha(it) == digest) { "$name differs from its pinned bytes" } }
        val manifestBytes: ByteArray by lazy { pinned(File(root, "manifest.json").readBytes(), 330796, "032af7f0e56331091a530311070db7b15e5a95273e5304364700705276c878b0", "manifest.json") }
        val renderBytes: ByteArray by lazy { pinned(java.util.zip.GZIPInputStream(File(root, "render-catalog.json.gz").inputStream()).use { it.readBytes() }, 8032245, "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133", "render-catalog.json") }
        val catalogueBytes: ByteArray by lazy { pinned(File(CosmeticsCandidateFixture.root, "catalogue.json").readBytes(), 296869, "50bd5758c55b445d1c6e206f40e17e6a35b6d8cf49597db7eb7427573d3a8f57", "catalogue.json") }
    }
    private val candidate17 = PrivateFleetCandidate(Fleet17Fixture.CONTENT_VERSION, 18)
    private suspend fun Harness.openFleet(candidate: PrivateFleetCandidate = candidate17, manifest: ByteArray = Fleet17Fixture.manifestBytes, catalogue: ByteArray = Fleet17Fixture.catalogueBytes,
        render: ByteArray = Fleet17Fixture.renderBytes, guard: () -> Unit = {}, values: MutableList<Boolean> = mutableListOf()): PrivateFleetHandle =
        PrivateFleetContent(content).open(candidate, manifest, catalogue, render, api, owner, guard, values::add)
    private fun flipped(bytes: ByteArray, at: Int = bytes.size - 2): ByteArray = bytes.copyOf().also { it[at] = (it[at].toInt() xor 0x01).toByte() }
    /** A TEST-ONLY re-pinned manifest (synthetic transport cases): the given paths' pins/tiers replaced and the canonical
     *  identity recomputed exactly as nativeContentManifest/tools/pack.mjs define it. Never the exact fixture. */
    private fun repinned(manifest: JsonObject, pins: Map<String, Pair<String, Long>> = emptyMap(), tiers: Map<String, String> = emptyMap(), drop: Set<String> = emptySet()): JsonObject {
        val files = JsonArray(manifest.getValue("files").jsonArray.mapNotNull { row ->
            val entry = row.jsonObject; val path = entry.getValue("path").jsonPrimitive.content
            if (path in drop) null else JsonObject(entry + buildMap<String, JsonElement> {
                pins[path]?.let { (sha, size) -> put("sha256", JsonPrimitive(sha)); put("size", JsonPrimitive(size)) }
                tiers[path]?.let { put("tier", JsonPrimitive(it)) } })
        })
        val identity = buildJsonObject { put("schemaVersion", 1); put("sourceCommit", manifest.getValue("sourceCommit").jsonPrimitive.content); put("simVersion", manifest.getValue("simVersion").jsonPrimitive.int); put("files", files) }
        return JsonObject(manifest + ("files" to files) + ("contentVersion" to JsonPrimitive(hash(identity.toString()))))
    }
    private fun repinGroup(groups: JsonArray, id: String, json: Pair<String, Long>, png: Pair<String, Long>): JsonArray = JsonArray(groups.map { g ->
        if (g.jsonObject.getValue("id").jsonPrimitive.content != id) g else JsonObject(g.jsonObject + ("files" to JsonArray(g.jsonObject.getValue("files").jsonArray.map { pin ->
            val (sha, size) = if (pin.jsonObject.getValue("path").jsonPrimitive.content.endsWith(".json")) json else png
            JsonObject(pin.jsonObject + ("sha256" to JsonPrimitive(sha)) + ("size" to JsonPrimitive(size))) })))
    })
    private fun bytes(text: String) = text.toByteArray(Charsets.UTF_8)

    @Test fun `private17 keeps 68 descriptors dark while ordinary renderer17 admits only its service graph offline`() = fixture {
        val values = mutableListOf<Boolean>()
        openFleet(values = values).use { handle ->
            assertEquals(candidate17, handle.candidate); assertEquals(18, handle.manifest.simVersion); assertEquals(Fleet17Fixture.CONTENT_VERSION, handle.manifest.contentVersion)
            assertEquals("6f7a9e81c7e1ab0c063a8a70067dcd410214d773", handle.manifest.sourceCommit); assertEquals("cea3a398d0bb1fe1184edf2b1e176d63814e5627", handle.fleet.sourceCommit)
            val fleet = handle.fleet
            assertEquals(21, fleet.groups.size); assertEquals(17, fleet.vehicles.size); assertEquals(5, fleet.tracks.size); assertEquals(2, fleet.gateEffects.size); assertEquals(2, fleet.gateStills.size)
            assertEquals(8, requireNotNull(fleet.services.cosmetics).clips.getValue("pe_cos_wake").frames.size)
            assertEquals(47 + 21, handle.descriptors.size); assertTrue("pe_fleet_starter" in handle.descriptors); assertTrue("pe_cosmetics" in handle.descriptors); assertTrue("pe_veh_cargo_cutter_t4" in handle.descriptors)
            assertSame("the session carries the SAME parsed service graph", fleet.services, handle.session.art); assertSame(fleet.services, requireNotNull(handle.session.admitted()).art)
            assertTrue(handle.session.assets.isCurrent()); assertEquals("permission starts dark", listOf(false), values)
            assertThrows(IllegalArgumentException::class.java) { handle.session.assets.acquire("pe_unknown") {} }
            assertTrue(runCatching { (handle.descriptors as MutableMap<String, ServiceAtlasGroup>).clear() }.isFailure)
        }
        assertEquals("opening performs no download", 0, server.requestCount)
        // Build1R admits the same exact catalogue through the ordinary service opener, without fleet residency.
        val render17 = Json.parseToJsonElement(String(Fleet17Fixture.renderBytes, Charsets.UTF_8)).jsonObject
        val catalogue17 = Json.parseToJsonElement(String(Fleet17Fixture.catalogueBytes, Charsets.UTF_8)).jsonObject
        val manifest17 = nativeContentManifest(Json.parseToJsonElement(String(Fleet17Fixture.manifestBytes, Charsets.UTF_8)).jsonObject, 18)
        content.open(ContentState(catalogue = catalogue17, renderCatalogue = render17, manifest = manifest17), api, owner) {}.use { session ->
            assertEquals(47, requireNotNull(session.art).groups.size)
            assertNotNull(requireNotNull(session.art).cosmetics)
            assertFalse("pe_fleet_starter" in requireNotNull(session.art).groups)
        }
        // A render catalogue by itself still cannot create a session without its admitted manifest and catalogue.
        assertThrows(IllegalArgumentException::class.java) { runBlocking { content.open(ContentState(renderCatalogue = render17), api, owner) {} } }
        assertEquals(0, server.requestCount)
    }

    @Test fun `private17 refuses before HTTP - identity, SIM, integrity, semantics, group pins - and leaks no session`() = fixture {
        val values = mutableListOf<Boolean>()
        suspend fun refuses(message: String, candidate: PrivateFleetCandidate = candidate17, manifest: ByteArray = Fleet17Fixture.manifestBytes,
            catalogue: ByteArray = Fleet17Fixture.catalogueBytes, render: ByteArray = Fleet17Fixture.renderBytes, pattern: Regex? = null) {
            val error = requireNotNull(runCatching { openFleet(candidate, manifest, catalogue, render, values = values) }.exceptionOrNull()) { "$message should refuse" }
            assertTrue("$message: ${error::class.simpleName}", error is IllegalArgumentException || error is NoSuchElementException || error is IllegalStateException)
            pattern?.let { assertTrue("$message: ${error.message}", it.containsMatchIn(error.message.orEmpty())) }
        }
        refuses("another explicit identity", candidate = candidate17.copy(contentVersion = "0".repeat(64)), pattern = Regex("identity differs"))
        refuses("unsupported SIM", candidate = candidate17.copy(simVersion = 17), pattern = Regex("compatible app update"))
        // Integrity. Malformed JSON is its own refusal (the parser), kept SEPARATE from identity.
        refuses("malformed manifest JSON (closing brace flipped)", manifest = flipped(Fleet17Fixture.manifestBytes))
        // Canonical identity: a syntactically VALID manifest whose sourceCommit has one valid hex digit changed while the
        // original contentVersion is kept (nothing recomputed) must reach the existing identity mismatch.
        val raw0 = Json.parseToJsonElement(String(Fleet17Fixture.manifestBytes, Charsets.UTF_8)).jsonObject
        val commit = raw0.getValue("sourceCommit").jsonPrimitive.content
        val identityTamper = bytes(JsonObject(raw0 + ("sourceCommit" to JsonPrimitive((if (commit[0] == '0') "1" else "0") + commit.substring(1)))).toString())
        refuses("a valid manifest whose identity no longer matches its stored contentVersion", manifest = identityTamper, pattern = Regex("identity mismatch"))
        refuses("tampered catalogue byte", catalogue = flipped(Fleet17Fixture.catalogueBytes), pattern = Regex("catalogue.json bytes differ from the manifest pin"))
        refuses("tampered render byte", render = flipped(Fleet17Fixture.renderBytes), pattern = Regex("render-catalog.json bytes differ from the manifest pin"))
        refuses("truncated render", render = Fleet17Fixture.renderBytes.copyOf(Fleet17Fixture.renderBytes.size - 1), pattern = Regex("render-catalog.json size differs"))
        // Semantics (TEST-ONLY re-pinned manifests so the bytes ARE the pins; the exact fixture itself is never modified):
        val raw = Json.parseToJsonElement(String(Fleet17Fixture.manifestBytes, Charsets.UTF_8)).jsonObject
        val render17 = Json.parseToJsonElement(String(Fleet17Fixture.renderBytes, Charsets.UTF_8)).jsonObject
        val render16 = bytes(JsonObject(render17 + ("rendererContractVersion" to JsonPrimitive(16))).toString())
        val manifestFor16 = repinned(raw, pins = mapOf("render-catalog.json" to (Fleet17Fixture.sha(render16) to render16.size.toLong())))
        refuses("a render root that is not 17 (semantic, pins valid)", candidate = PrivateFleetCandidate(manifestFor16.getValue("contentVersion").jsonPrimitive.content, 18),
            manifest = bytes(manifestFor16.toString()), render = render16, pattern = Regex("render catalogue is not renderer17"))
        val manifest16 = JsonObject(raw + ("rendererContractVersion" to JsonPrimitive(16)))
        refuses("a manifest that is not 17 (identity unchanged)", manifest = bytes(manifest16.toString()), pattern = Regex("manifest is not renderer17"))
        val foreign = bytes(JsonObject(Json.parseToJsonElement(String(Fleet17Fixture.catalogueBytes, Charsets.UTF_8)).jsonObject + ("sourceCommit" to JsonPrimitive("b".repeat(40)))).toString())
        val manifestForForeign = repinned(raw, pins = mapOf("catalogue.json" to (Fleet17Fixture.sha(foreign) to foreign.size.toLong())))
        refuses("a catalogue of another generation (semantic, pins valid)", candidate = PrivateFleetCandidate(manifestForForeign.getValue("contentVersion").jsonPrimitive.content, 18),
            manifest = bytes(manifestForForeign.toString()), catalogue = foreign, pattern = Regex("another content generation"))
        val coreTier = repinned(raw, tiers = mapOf("atlas/pe_fleet_starter@1x.png" to "core"))
        refuses("a fleet pair pinned as core", candidate = PrivateFleetCandidate(coreTier.getValue("contentVersion").jsonPrimitive.content, 18), manifest = bytes(coreTier.toString()), pattern = Regex("Service pins differ"))
        val altered = repinned(raw, pins = mapOf("atlas/pe_veh_cargo_cutter_t2@1x.json" to ("e".repeat(64) to 14467L)))
        refuses("an altered fleet pin", candidate = PrivateFleetCandidate(altered.getValue("contentVersion").jsonPrimitive.content, 18), manifest = bytes(altered.toString()), pattern = Regex("Service pins differ"))
        val missing = repinned(raw, drop = setOf("atlas/pe_cosmetics@1x.png"))
        refuses("a missing Wake group pin", candidate = PrivateFleetCandidate(missing.getValue("contentVersion").jsonPrimitive.content, 18), manifest = bytes(missing.toString()))
        assertEquals("nothing reached the network", 0, server.requestCount); assertTrue("no permission was ever published", values.isEmpty())
        owner.children.toList().joinAll(); assertTrue("no session lifetime leaked", owner.children.none { it.isActive })
    }

    @Test fun `private17 SYNTHETIC TLS pair proof - re-pinned fleet and Wake groups route same-origin, unknown groups refuse`() = fixture {
        // SYNTHETIC: these bytes are not authored art; this proves downloader routing and lease ownership for descriptors the
        // private opener registered, nothing about PNG validity, residency or hosting. The exact fixture case above is separate.
        val fleetJson = "synthetic fleet atlas JSON"; val fleetPng = "synthetic fleet PNG"; val cosJson = "synthetic cosmetics atlas JSON"; val cosPng = "synthetic cosmetics PNG"
        fun pin(text: String) = hash(text) to text.length.toLong()
        val render17 = Json.parseToJsonElement(String(Fleet17Fixture.renderBytes, Charsets.UTF_8)).jsonObject
        val fleetBlock = render17.getValue("fleetJourneys").jsonObject; val cosBlock = render17.getValue("boundCosmetics").jsonObject
        val mutated = JsonObject(render17 + ("fleetJourneys" to JsonObject(fleetBlock + ("groups" to repinGroup(fleetBlock.getValue("groups").jsonArray, "pe_fleet_starter", pin(fleetJson), pin(fleetPng)))))
            + ("boundCosmetics" to JsonObject(cosBlock + ("groups" to repinGroup(cosBlock.getValue("groups").jsonArray, "pe_cosmetics", pin(cosJson), pin(cosPng))))))
        val renderBytes = bytes(mutated.toString())
        val raw = Json.parseToJsonElement(String(Fleet17Fixture.manifestBytes, Charsets.UTF_8)).jsonObject
        val manifest = repinned(raw, pins = mapOf("render-catalog.json" to (Fleet17Fixture.sha(renderBytes) to renderBytes.size.toLong()),
            "atlas/pe_fleet_starter@1x.json" to pin(fleetJson), "atlas/pe_fleet_starter@1x.png" to pin(fleetPng), "atlas/pe_cosmetics@1x.json" to pin(cosJson), "atlas/pe_cosmetics@1x.png" to pin(cosPng)))
        val synthetic = PrivateFleetCandidate(manifest.getValue("contentVersion").jsonPrimitive.content, 18)
        assertNotEquals("the synthetic candidate is NOT the exact accepted candidate", candidate17, synthetic)
        openFleet(synthetic, bytes(manifest.toString()), Fleet17Fixture.catalogueBytes, renderBytes).use { handle ->
            server.enqueue(MockResponse().setBody(manifest.toString())); server.enqueue(MockResponse().setBody(fleetJson)); server.enqueue(MockResponse().setBody(fleetPng))
            withContext(Dispatchers.IO) { handle.session.assets.acquire("pe_fleet_starter") {} }.use { lease ->
                assertEquals(fleetJson, File(lease.directory.file(), "atlas/pe_fleet_starter@1x.json").readText()); assertEquals(fleetPng, File(lease.directory.file(), "atlas/pe_fleet_starter@1x.png").readText())
            }
            server.enqueue(MockResponse().setBody(manifest.toString())); server.enqueue(MockResponse().setBody(cosJson)); server.enqueue(MockResponse().setBody(cosPng))
            withContext(Dispatchers.IO) { handle.session.assets.acquire("pe_cosmetics") {} }.use { lease -> assertEquals(cosPng, File(lease.directory.file(), "atlas/pe_cosmetics@1x.png").readText()) }
            assertThrows(IllegalArgumentException::class.java) { handle.session.assets.acquire("pe_veh_zeppelin_t1") {} }
            assertThrows(IllegalArgumentException::class.java) { handle.session.assets.acquire("pe_fleet_berths_extra") {} }
        }
        val paths = List(6) { requireNotNull(server.takeRequest(2, TimeUnit.SECONDS)).also { assertNull(it.getHeader("Cookie")); assertNull(it.getHeader("Authorization")) }.path }
        assertEquals(listOf("/content/manifest.json", "/content/atlas/pe_fleet_starter@1x.json", "/content/atlas/pe_fleet_starter@1x.png",
            "/content/manifest.json", "/content/atlas/pe_cosmetics@1x.json", "/content/atlas/pe_cosmetics@1x.png"), paths)
        assertEquals(6, server.requestCount)
    }

    @Test fun `private17 owner replacement, reauthentication epoch and a failing guard before hand-off retire and leak nothing`() = fixture {
        // A throwing caller guard AFTER the session exists and before hand-off: the open fails and the created session is closed.
        var calls = 0; val values = mutableListOf<Boolean>()
        val error = runCatching { openFleet(guard = { if (++calls >= 5) throw CancellationException("owner replaced during open") }, values = values) }.exceptionOrNull()
        assertTrue("open failed instead of handing off: $error", error != null); assertTrue(calls >= 5)
        assertTrue("the created session's lifetime was closed, no join needed", owner.children.none { it.isActive }); assertTrue(values.none { it })
        // Owner replacement after open: the session is no longer current and the observation refuses to refresh positive.
        val current = AtomicBoolean(true); val observed = mutableListOf<Boolean>()
        val handle = openFleet(guard = { check(current.get()) { "service content owner changed" } }, values = observed)
        api.onGet("/native/capabilities") { capability(true) }
        handle.refreshPermission(); assertEquals(listOf(false, false, true), observed)
        current.set(false)
        assertFalse(handle.session.assets.isCurrent()); assertThrows(IllegalStateException::class.java) { runBlocking { handle.refreshPermission() } }
        assertFalse("a replaced owner never publishes positive again", observed.last())
        handle.close(); handle.close(); assertFalse(observed.last()); assertTrue(handle.retired)
        // Same wallet, new authentication epoch: A → B → A is a different owner even when every name matches.
        var epoch = 1; val reauth = mutableListOf<Boolean>()
        val second = openFleet(guard = { check(epoch == 1) }, values = reauth)
        epoch = 3; assertFalse(second.session.assets.isCurrent()); assertThrows(IllegalStateException::class.java) { runBlocking { second.refreshPermission() } }
        assertTrue(reauth.none { it }); second.close()
        assertEquals(0, server.requestCount)
    }

    @Test fun `private17 owner cancellation alone retires - prior positive dark, pending and next suppressed, no hand-off`() = fixture {
        // (a) After a positive observation, with caller guard {} and WITHOUT handle.close.
        val scoped = SupervisorJob(owner); val values = mutableListOf<Boolean>()
        val handle = PrivateFleetContent(content).open(candidate17, Fleet17Fixture.manifestBytes, Fleet17Fixture.catalogueBytes, Fleet17Fixture.renderBytes, api, scoped, {}, values::add)
        api.onGet("/native/capabilities") { capability(true) }
        handle.refreshPermission(); assertEquals(listOf(false, false, true), values)
        scoped.cancel(); withTimeout(2_000) { scoped.join() }
        assertTrue("owner cancellation retired the handle by itself", handle.retired); assertFalse("the prior positive is cleared", values.last())
        assertFalse(handle.session.assets.isCurrent())
        handle.refreshPermission(); assertFalse("a retired handle observes nothing: the next positive is suppressed", values.last()); assertEquals(1, values.count { it })
        // (b) During a pending positive reply, WITHOUT handle.close.
        val scoped2 = SupervisorJob(owner); val pendingValues = mutableListOf<Boolean>(); val late = CompletableDeferred<JsonObject>()
        val second = PrivateFleetContent(content).open(candidate17, Fleet17Fixture.manifestBytes, Fleet17Fixture.catalogueBytes, Fleet17Fixture.renderBytes, api, scoped2, {}, pendingValues::add)
        api.onGet("/native/capabilities") { late.await() }
        val pending = async(start = CoroutineStart.UNDISPATCHED) { second.refreshPermission() }
        scoped2.cancel(); withTimeout(2_000) { scoped2.join() }
        late.complete(capability(true)); pending.await()
        assertTrue("the pending positive reply is suppressed", pendingValues.none { it }); assertTrue(second.retired); assertFalse(second.session.assets.isCurrent())
        // (d) Controlled child: another child of the owner is HELD in its cancellation cleanup. The handle must already be retired and
        // the prior positive dark the moment the owner starts cancelling — BEFORE that child is released or joined.
        val scoped4 = SupervisorJob(owner); val heldValues = mutableListOf<Boolean>(); val gate = CompletableDeferred<Unit>()
        val fourth = PrivateFleetContent(content).open(candidate17, Fleet17Fixture.manifestBytes, Fleet17Fixture.catalogueBytes, Fleet17Fixture.renderBytes, api, scoped4, {}, heldValues::add)
        api.onGet("/native/capabilities") { capability(true) }; fourth.refreshPermission(); assertTrue(heldValues.last())
        // UNDISPATCHED: the child's try/finally has ENTERED (it is suspended in awaitCancellation) before the owner is cancelled.
        val held = CoroutineScope(scoped4 + Dispatchers.IO).launch(start = CoroutineStart.UNDISPATCHED) { try { awaitCancellation() } finally { withContext(NonCancellable) { gate.await() } } }
        try {
            scoped4.cancel() // the owner is now cancelling; `held` is draining under NonCancellable and keeps it from completing
            assertTrue("retired at cancellation START, not at terminal completion", fourth.retired); assertFalse("prior positive dark before the held child drains", heldValues.last())
            assertFalse(fourth.session.assets.isCurrent()); assertFalse("the owner has not completed yet", scoped4.isCompleted)
        } finally { gate.complete(Unit) } // an assertion failure must never strand the held child
        withTimeout(2_000) { held.join(); scoped4.join() }
        assertEquals(1, heldValues.count { it })
        // (c) Supplied-owner cancellation between session creation and hand-off (caller guard never throws): nothing is returned, nothing leaks.
        val scoped3 = SupervisorJob(owner); var calls = 0; val gone = mutableListOf<Boolean>()
        val error = runCatching { PrivateFleetContent(content).open(candidate17, Fleet17Fixture.manifestBytes, Fleet17Fixture.catalogueBytes, Fleet17Fixture.renderBytes, api, scoped3,
            { if (++calls == 5) scoped3.cancel() }, gone::add) }.exceptionOrNull()
        assertTrue("a dead owner receives no handle: $error", error != null); assertTrue(gone.none { it })
        withTimeout(2_000) { scoped3.join() }; assertTrue(scoped3.children.none { it.isActive })
        assertEquals(0, server.requestCount)
    }

    @Test fun `private17 throwing dark sink never prevents retirement - explicit close, failed open, owner hook`() = fixture {
        // Explicit close with a sink that throws on the dark publication after a positive observation.
        var throwDark = false; val values = mutableListOf<Boolean>()
        val sink: (Boolean) -> Unit = { v -> if (!v && throwDark) throw IllegalStateException("sink refused dark"); values += v }
        val scoped = SupervisorJob(owner)
        val handle = PrivateFleetContent(content).open(candidate17, Fleet17Fixture.manifestBytes, Fleet17Fixture.catalogueBytes, Fleet17Fixture.renderBytes, api, scoped, {}, sink)
        api.onGet("/native/capabilities") { capability(true) }; handle.refreshPermission(); assertTrue(values.last())
        throwDark = true
        handle.close()
        assertTrue("retired despite the throwing sink", handle.retired); assertNotNull("the contained sink failure is reported", handle.publicationFailure)
        assertFalse("the session is closed regardless", handle.session.assets.isCurrent()); assertTrue(scoped.children.none { it.isActive })
        assertTrue("no false was delivered to the throwing sink — and none is claimed", values.last())
        // Failed open: the initial dark publication throws → the open fails and the created session is closed.
        val failing = SupervisorJob(owner); var dark = 0
        val error = runCatching { PrivateFleetContent(content).open(candidate17, Fleet17Fixture.manifestBytes, Fleet17Fixture.catalogueBytes, Fleet17Fixture.renderBytes, api, failing, {}) { v -> if (!v) { dark++; throw IllegalStateException("sink refused dark") } } }.exceptionOrNull()
        assertTrue("open failed: $error", error is IllegalStateException); assertTrue("the sink threw on the initial dark publication and again on cleanup", dark >= 1)
        assertTrue("no session child stays active after the failed open", failing.children.none { it.isActive })
        // Owner-cancel hook with a throwing sink: retirement still completes.
        val scoped2 = SupervisorJob(owner); var hookDark = false
        val third = PrivateFleetContent(content).open(candidate17, Fleet17Fixture.manifestBytes, Fleet17Fixture.catalogueBytes, Fleet17Fixture.renderBytes, api, scoped2, {}) { v -> if (!v && hookDark) throw IllegalStateException("sink refused dark") }
        hookDark = true; scoped2.cancel(); withTimeout(2_000) { scoped2.join() }
        assertTrue(third.retired); assertNotNull(third.publicationFailure); assertFalse(third.session.assets.isCurrent()); assertTrue(scoped2.children.none { it.isActive })
        assertEquals(0, server.requestCount)
    }

    @Test fun `private17 permission starts dark, revokes before refresh, stays dark on bad reads, close stops positives`() = fixture {
        val values = mutableListOf<Boolean>()
        api.onGet("/native/capabilities") { capability(true) }
        openFleet(values = values).use { handle ->
            assertEquals("dark until a current refresh", listOf(false), values)
            handle.refreshPermission(); assertEquals("refresh revokes first, then observes", listOf(false, false, true), values)
            api.onGet("/native/capabilities") { capability(false) }; handle.refreshPermission(); assertFalse(values.last()); assertTrue(values.count { it } == 1)
            for (raw in listOf(buildJsonObject { put("protocolVersion", 2); put("simVersion", 18) },
                buildJsonObject { capability(true).forEach { (key, value) -> put(key, value) }; put("phaseEArt", buildJsonObject { put("version", 2); put("enabled", true) }) })) {
                api.onGet("/native/capabilities") { raw }; handle.refreshPermission(); assertFalse(values.last())
            }
            api.onGet("/native/capabilities") { error("offline") }; handle.refreshPermission(); assertFalse(values.last())
            api.onGet("/native/capabilities") { capability(true) }; handle.refreshPermission(); assertTrue(values.last())
            handle.close(); assertFalse("close publishes dark", values.last())
            val before = values.size; handle.refreshPermission(); assertEquals("a closed handle observes nothing", before, values.size)
        }
        assertEquals(0, server.requestCount)
    }
}
