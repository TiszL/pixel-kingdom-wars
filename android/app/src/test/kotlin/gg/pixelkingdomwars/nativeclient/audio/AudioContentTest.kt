package gg.pixelkingdomwars.nativeclient.audio

import gg.pixelkingdomwars.nativeclient.FakeApiClient
import gg.pixelkingdomwars.nativeclient.network.ApiException
import gg.pixelkingdomwars.nativeclient.network.nativeContentManifest
import kotlinx.coroutines.*
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.concurrent.TimeUnit

class AudioContentTest {
    private val audioPath = MusicTrack.WORLD.path
    private val secondPath = MusicTrack.BATTLE.path
    private val bytes = "exact encoded music bytes"
    private fun hash(text: String) = MessageDigest.getInstance("SHA-256").digest(text.toByteArray()).joinToString("") { "%02x".format(it) }
    private fun manifest(audio: String = bytes): JsonObject {
        val paths = sortedMapOf("catalogue.json" to "{}", "render-catalog.json" to "{}", "contracts.json" to "{}",
            "atlas/meta.json" to "{}", "kotlin/NativeContracts.kt" to "{}", audioPath to audio, secondPath to audio)
        val files = buildJsonArray { paths.forEach { (path, value) -> add(buildJsonObject {
            put("path", path); put("sha256", hash(value)); put("size", value.length); put("tier", if (path.startsWith("audio/")) "optional" else "core")
        }) } }
        val identity = buildJsonObject { put("schemaVersion", 1); put("sourceCommit", "a".repeat(40)); put("simVersion", 14); put("files", files) }
        return buildJsonObject {
            identity.forEach { (key, value) -> put(key, value) }; put("contentVersion", hash(identity.toString()))
            put("cataloguePath", "catalogue.json"); put("renderCataloguePath", "render-catalog.json")
            put("contractPath", "contracts.json"); put("atlasMetadataPath", "atlas/meta.json"); put("kotlinModelsPath", "kotlin/NativeContracts.kt")
        }
    }
    private fun fixture(nowMs: () -> Long = { System.nanoTime() / 1_000_000 }, block: suspend (MockWebServer, AudioContent, FakeApiClient, File, AudioPack) -> Unit) = runBlocking {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(serverTls.sslSocketFactory(), false); start() }
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
            .addInterceptor { chain -> chain.proceed(chain.request().newBuilder().header("Authorization", "private-session").build()) }
            .cookieJar(object : CookieJar {
                override fun loadForRequest(url: HttpUrl) = listOf(Cookie.Builder().name("session").value("private").domain(url.host).build())
                override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) = Unit
            }).build()
        val root = Files.createTempDirectory("audio-content").toFile()
        val api = FakeApiClient()
        api.onGet("/native/capabilities") { Json.parseToJsonElement("""{"protocolVersion":2,"simVersion":14,"contentManifestUrl":"${server.url("/content/manifest.json")}"}""").jsonObject }
        val pack = AudioPack(nativeContentManifest(manifest(), 14), audioRuntime())
        try { block(server, AudioContent(root, server.url("/").toString(), transport = client, nowMs = nowMs), api, root, pack) }
        finally { server.shutdown(); root.deleteRecursively() }
    }
    @Test fun `verified optional bank reopens offline without account headers or another manifest request`() = fixture { server, content, api, _, pack ->
        server.enqueue(MockResponse().setBody(manifest().toString())); server.enqueue(MockResponse().setBody(bytes))
        content.acquire(pack, setOf(audioPath), api).use { assertEquals(bytes, it.file(audioPath).readText()) }
        repeat(2) { val request = server.takeRequest(); assertNull(request.getHeader("Cookie")); assertNull(request.getHeader("Authorization")) }
        api.onGet("/native/capabilities") { error("offline") }
        content.acquire(pack, setOf(audioPath), api).use { assertEquals(bytes, it.file(audioPath).readText()) }
        assertEquals(2, server.requestCount)
    }
    @Test fun `same path from a new release cannot replace the admitted generation`() = fixture { server, content, api, root, pack ->
        server.enqueue(MockResponse().setBody(manifest("replacement").toString()))
        assertThrows(IllegalArgumentException::class.java) { runBlocking { content.acquire(pack, setOf(audioPath), api) } }
        assertEquals(1, server.requestCount); assertTrue(root.listFiles().orEmpty().none { it.name.matches(Regex("[a-f0-9]{64}")) })
    }
    @Test fun `corrupt encoded bytes do not activate or become a playable lease`() = fixture { server, content, api, root, pack ->
        server.enqueue(MockResponse().setBody(manifest().toString())); server.enqueue(MockResponse().setBody("bad"))
        assertThrows(IllegalArgumentException::class.java) { runBlocking { content.acquire(pack, setOf(audioPath), api) } }
        assertTrue(root.listFiles().orEmpty().none { it.name.startsWith("staging-") || it.name.matches(Regex("[a-f0-9]{64}")) })
    }
    @Test fun `unlisted paths and redirects cannot bypass pinned same-origin audio`() = fixture { server, content, api, _, pack ->
        assertThrows(IllegalArgumentException::class.java) { runBlocking { content.acquire(pack, setOf("audio/../private"), api) } }
        assertEquals(0, server.requestCount)
        server.enqueue(MockResponse().setResponseCode(302).addHeader("Location", "https://other.example/audio.mp3"))
        assertThrows(IllegalStateException::class.java) { runBlocking { content.acquire(pack, setOf(audioPath), api) } }
        assertEquals(1, server.requestCount)
    }
    @Test fun `leaving during a stalled body cancels network and discards incomplete files`() = fixture { server, content, api, root, pack ->
        server.enqueue(MockResponse().setBody(manifest().toString()))
        server.enqueue(MockResponse().setBody(bytes).setBodyDelay(4, TimeUnit.SECONDS))
        coroutineScope {
            val job = launch(Dispatchers.Default) { content.acquire(pack, setOf(audioPath), api).close() }
            withContext(Dispatchers.IO) { repeat(2) { assertNotNull(server.takeRequest(5, TimeUnit.SECONDS)) } }
            withTimeout(1_000) { while (root.listFiles().orEmpty().none { it.name.startsWith("staging-") && File(it, audioPath).isFile }) delay(10) }
            withTimeout(2_000) { job.cancelAndJoin() }
        }
        assertTrue(root.listFiles().orEmpty().none { it.name.startsWith("staging-") || it.name.matches(Regex("[a-f0-9]{64}")) })
    }
    @Test fun `bank lease cannot expose an unrelated path or survive its own release`() = fixture { server, content, api, _, pack ->
        server.enqueue(MockResponse().setBody(manifest().toString())); server.enqueue(MockResponse().setBody(bytes))
        val lease = content.acquire(pack, setOf(audioPath), api)
        assertThrows(IllegalStateException::class.java) { lease.file("audio/other.mp3") }
        lease.close(); lease.close()
        assertThrows(IllegalStateException::class.java) { lease.file(audioPath) }
    }
    @Test fun `different cold samples share one pinned generation lookup instead of spending gameplay budget`() = fixture { server, content, api, _, pack ->
        var capabilityReads = 0
        api.onGet("/native/capabilities") { capabilityReads++; Json.parseToJsonElement("""{"protocolVersion":2,"simVersion":14,"contentManifestUrl":"${server.url("/content/manifest.json")}"}""").jsonObject }
        server.enqueue(MockResponse().setBody(manifest().toString()))
        repeat(2) { server.enqueue(MockResponse().setBody(bytes)) }
        coroutineScope {
            listOf(audioPath, secondPath).map { path -> async(Dispatchers.Default) {
                content.acquire(pack, setOf(path), api).use { assertEquals(bytes, it.file(path).readText()) }
            } }.awaitAll()
        }
        assertEquals(1, capabilityReads)
        assertEquals(3, server.requestCount) // One manifest plus two pinned files, not one handshake per cue.
        val paths = List(3) { server.takeRequest().path }
        assertEquals(1, paths.count { it == "/content/manifest.json" })
    }

    @Test fun `DNS failure cools the origin so new sound cues cannot hammer capabilities`() {
        var now = 0L
        fixture(nowMs = { now }) { server, content, api, _, pack ->
            var capabilityReads = 0
            api.onGet("/native/capabilities") { capabilityReads++; throw java.net.UnknownHostException("offline") }
            assertThrows(java.net.UnknownHostException::class.java) { runBlocking { content.acquire(pack, setOf(audioPath), api) } }
            repeat(100) { assertThrows(AudioRetryException::class.java) { runBlocking { content.acquire(pack, setOf(secondPath), api) } } }
            assertEquals(1, capabilityReads); assertEquals(0, server.requestCount)
            now = pack.runtime.manifestRetryDelayMs
            api.onGet("/native/capabilities") { capabilityReads++; Json.parseToJsonElement("""{"protocolVersion":2,"simVersion":14,"contentManifestUrl":"${server.url("/content/manifest.json")}"}""").jsonObject }
            server.enqueue(MockResponse().setBody(manifest().toString())); server.enqueue(MockResponse().setBody(bytes))
            content.acquire(pack, setOf(secondPath), api).close()
            assertEquals(2, capabilityReads)
        }
    }

    @Test fun `server retry after overrides shorter local audio cooldown without blocking verified disk audio`() {
        var now = 0L
        fixture(nowMs = { now }) { server, content, api, _, pack ->
            server.enqueue(MockResponse().setBody(manifest().toString())); server.enqueue(MockResponse().setBody(bytes))
            content.acquire(pack, setOf(audioPath), api).close()
            val retrySeconds = pack.runtime.manifestRetryDelayMs / 1_000 + 14
            server.enqueue(MockResponse().setResponseCode(429).addHeader("Retry-After", retrySeconds))
            assertThrows(ApiException::class.java) { runBlocking { content.acquire(pack, setOf(secondPath), api) } }
            content.acquire(pack, setOf(audioPath), api).use { assertEquals(bytes, it.file(audioPath).readText()) }
            now = retrySeconds * 1_000 - 1
            assertThrows(AudioRetryException::class.java) { runBlocking { content.acquire(pack, setOf(secondPath), api) } }
            assertEquals(3, server.requestCount)
            now++
            server.enqueue(MockResponse().setBody(bytes))
            content.acquire(pack, setOf(secondPath), api).close()
            assertEquals(4, server.requestCount)
        }
    }

    @Test fun `new pack must revalidate its own manifest after a prior verified generation`() = fixture { server, content, api, _, pack ->
        server.enqueue(MockResponse().setBody(manifest().toString())); server.enqueue(MockResponse().setBody(bytes))
        content.acquire(pack, setOf(audioPath), api).close()
        val changed = pack.copy(manifest = nativeContentManifest(manifest("replacement"), 14))
        server.enqueue(MockResponse().setBody(manifest().toString()))
        assertThrows(IllegalArgumentException::class.java) { runBlocking { content.acquire(changed, setOf(secondPath), api) } }
        assertEquals(3, server.requestCount)
    }

}
