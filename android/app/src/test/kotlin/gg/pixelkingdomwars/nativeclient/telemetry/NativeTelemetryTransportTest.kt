package gg.pixelkingdomwars.nativeclient.telemetry

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import okhttp3.*
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class NativeTelemetryTransportTest {
    @Test fun `telemetry uses its fixed HTTPS path without cookies or following a redirect`() {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        val jar = object : CookieJar {
            override fun loadForRequest(url: HttpUrl): List<Cookie> = error("Telemetry must not use game cookies")
            override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) = error("Telemetry must not accept response cookies")
        }
        val client = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).cookieJar(jar).build()
        try {
            server.enqueue(MockResponse().setResponseCode(307).addHeader("Location", server.url("/unexpected"))
                .addHeader("Set-Cookie", "session=secret; Secure; Path=/"))
            runBlocking { NativeTelemetryTransport(server.url("/").toString(), client).send(buildJsonObject { put("events", JsonArray(emptyList())) }) }
            val request = server.takeRequest(); assertEquals("/api/telemetry", request.path); assertEquals("POST", request.method)
            assertNull(request.getHeader("Cookie")); assertNull(request.getHeader("Authorization")); assertEquals("android-native", request.getHeader("X-PKW-Client"))
            assertEquals(1, server.requestCount)
            server.enqueue(MockResponse().setResponseCode(503).addHeader("Retry-After", "0"))
            server.enqueue(MockResponse().setResponseCode(204))
            runBlocking { NativeTelemetryTransport(server.url("/").toString(), client).send(buildJsonObject { put("events", JsonArray(emptyList())) }) }
            assertEquals("An explicit HTTP retry hint cannot replay diagnostic batches", 2, server.requestCount)
        } finally { server.shutdown(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    @Test fun `credentialed insecure or query-bearing origins are refused before sending`() {
        for (origin in listOf("http://example.com", "https://user:secret@example.com", "https://example.com?token=secret", "https://example.com/#secret", "https://example.com/unexpected"))
            assertThrows(IllegalArgumentException::class.java) { NativeTelemetryTransport(origin) }
    }
}
