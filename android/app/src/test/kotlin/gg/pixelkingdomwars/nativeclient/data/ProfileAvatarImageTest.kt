package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.WALLET
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.IOException
import java.util.concurrent.TimeUnit

class ProfileAvatarImageTest {
    private class Fixture : AutoCloseable {
        private val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager)
            .cookieJar(object : CookieJar {
                override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) { error("Public image saved a cookie") }
                override fun loadForRequest(url: HttpUrl) = listOf(Cookie.Builder().name("shardkeep_session").value("private").domain("localhost").build())
            }).build()
        val loader = ProfileAvatarImage(transport)
        val path = "/avatar/$WALLET/${"a".repeat(64)}/11111111-1111-4111-8111-111111111111.webp"
        fun url() = server.url(path).toString()
        override fun close() { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }
    @Test fun `generation-specific public avatar never sends game credentials or accepts response cookies`() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").addHeader("Set-Cookie", "shardkeep_session=other; Path=/").setBody("pixels"))
            assertArrayEquals("pixels".toByteArray(), f.loader.load(f.url(), WALLET, 6))
            val req = f.server.takeRequest()
            assertNull(req.getHeader("Cookie")); assertNull(req.getHeader("Authorization")); assertNull(req.getHeader("x-shardkeep-recent-auth"))
            assertEquals(f.path, req.path)
        }
    }
    @Test fun `wrong owner insecure URL and unversioned images fail before any request`() = runBlocking {
        Fixture().use { f ->
            for (url in listOf(f.url().replace(WALLET, "other"), f.url().replace("https:", "http:"), f.server.url("/avatar/current.webp").toString(), f.url() + "?token=private")) {
                assertThrows(IllegalArgumentException::class.java) { runBlocking { f.loader.load(url, WALLET, 10) } }
            }
            assertEquals(0, f.server.requestCount)
        }
    }
    @Test fun `redirect cannot show an older image or follow another origin`() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", f.server.url("/old.webp")))
            assertThrows(IOException::class.java) { runBlocking { f.loader.load(f.url(), WALLET, 10) } }
            assertEquals(1, f.server.requestCount)
        }
    }
    @Test fun `unknown-length oversized image and non-image responses never reach a decoder`() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").setChunkedBody("12345", 2))
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.loader.load(f.url(), WALLET, 4) } }
            f.server.enqueue(MockResponse().setHeader("Content-Type", "text/html").setBody("oops"))
            assertThrows(IllegalArgumentException::class.java) { runBlocking { f.loader.load(f.url(), WALLET, 10) } }
            assertEquals(2, f.server.requestCount)
        }
    }
    @Test fun `closing the profile cancels an unfinished image without fallback`() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").setBody("x".repeat(100)).throttleBody(1, 1, TimeUnit.SECONDS))
            val load = launch { f.loader.load(f.url(), WALLET, 100) }
            withContext(Dispatchers.IO) { assertNotNull(f.server.takeRequest(3, TimeUnit.SECONDS)) }
            withTimeout(2_000) { load.cancelAndJoin() }
            assertEquals(1, f.server.requestCount)
        }
    }
}
