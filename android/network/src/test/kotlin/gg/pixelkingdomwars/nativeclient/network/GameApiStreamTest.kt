package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.ActiveBaseRaid
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.*
import okhttp3.Cookie
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** The raid-events handshake rides the same session-bound HTTPS transport as every request: cookies go out,
 * a refusal is the server's coded failure, a non-SSE answer is an interrupted stream, frames decode in order. */
class GameApiStreamTest {
    private class Store : SecretStore { var value: String? = null; override fun read() = value; override fun write(value: String) { this.value = value }; override fun clear() { value = null } }
    private class Fixture : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val origin = server.url("/")
        val jar = SessionCookieJar(origin, Store())
        private val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val api = GameApi(origin.toString(), jar, "stream-test", transport)
        init { jar.saveFromResponse(origin, listOf(Cookie.parse(origin, "shardkeep_session=abc; Secure; HttpOnly; Path=/; Max-Age=3600")!!)) }
        override fun close() { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }
    private val base = "b86b557b-bb8f-488b-8b18-035600ba0e4a"

    @Test fun `frames arrive with the session cookie and the event-stream accept header`() = Fixture().use { f ->
        f.server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream; charset=utf-8")
            .setBody("event: snapshot\ndata: {\"baseId\":\"$base\",\"activeRaid\":{\"raidId\":\"r1\",\"state\":\"reserved\"}}\n\n: heartbeat\n\n"))
        val frames = runBlocking { f.api.raidEvents("/bases/$base/raid-events", base).take(2).toList() }
        assertEquals(listOf(RaidEventFrame.Snapshot(ActiveBaseRaid("r1", "reserved")), RaidEventFrame.Heartbeat), frames)
        val request = f.server.takeRequest()
        assertEquals("/api/bases/$base/raid-events", request.path)
        assertEquals("text/event-stream", request.getHeader("Accept")); assertTrue(request.getHeader("Cookie")!!.contains("shardkeep_session=abc"))
    }
    @Test fun `a refused stream is the server's coded failure and a JSON answer is an interrupted stream`() = Fixture().use { f ->
        f.server.enqueue(MockResponse().setResponseCode(404).setHeader("Content-Type", "application/json").setBody("""{"error":{"code":"RAID_EVENTS_DISABLED","message":"raid streaming is unavailable"}}"""))
        val refused = runBlocking { runCatching { f.api.raidEvents("/bases/$base/raid-events", base).toList() } }.exceptionOrNull() as ApiException
        assertEquals(404, refused.status); assertEquals(RAID_EVENTS_DISABLED, refused.code)
        f.server.enqueue(MockResponse().setHeader("Content-Type", "application/json").setBody("{}"))
        val invalid = runBlocking { runCatching { f.api.raidEvents("/bases/$base/raid-events", base).toList() } }.exceptionOrNull() as ApiException
        assertEquals(RAID_EVENTS_INVALID, invalid.code)
    }
    @Test fun `a valid case-insensitive media type keeps live defence updates available`() = Fixture().use { f ->
        f.server.enqueue(MockResponse().setHeader("Content-Type", " Text/Event-Stream ; charset=UTF-8")
            .setBody("event: snapshot\ndata: {\"baseId\":\"$base\",\"activeRaid\":null}\n\n"))
        val frames = runBlocking { f.api.raidEvents("/bases/$base/raid-events", base).take(1).toList() }
        assertEquals(listOf(RaidEventFrame.Snapshot(null)), frames)
    }
    @Test fun `a superseded session never opens a stream`() = Fixture().use { f ->
        val original = f.api.sessionToken()
        f.api.beginAuthentication()
        assertTrue(runBlocking { runCatching { f.api.raidEvents("/bases/$base/raid-events", base, original).toList() } }.exceptionOrNull() is SessionSupersededException)
        assertEquals(0, f.server.requestCount)
    }
    @Test fun `leaving the screen cancels a stalled response body without waiting for the socket timeout`() = Fixture().use { f ->
        // HTTP/1 keeps this deliberately incomplete body open; HTTP/2 would send END_STREAM.
        f.server.protocols = listOf(okhttp3.Protocol.HTTP_1_1)
        f.server.enqueue(MockResponse().setHeader("Content-Type", "text/event-stream")
            .setBody(": heartbeat\n\n").setHeader("Content-Length", "99999"))
        runBlocking {
            val received = CompletableDeferred<Unit>()
            val collector = launch(Dispatchers.IO) {
                f.api.raidEvents("/bases/$base/raid-events", base).collect { received.complete(Unit) }
            }
            try {
                withTimeout(5_000) { received.await() }
                // The next read is blocked by the server. Cancellation must close it immediately.
                withTimeout(2_000) { collector.cancelAndJoin() }
                assertTrue(collector.isCancelled)
            } finally { collector.cancel() }
        }
    }
}
