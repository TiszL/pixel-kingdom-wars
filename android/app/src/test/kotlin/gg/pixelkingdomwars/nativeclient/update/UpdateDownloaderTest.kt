package gg.pixelkingdomwars.nativeclient.update

import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.ResponseBody
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import okio.BufferedSource
import org.junit.Assert.*
import org.junit.Test

/** M45 §5 transport: app-private, resumable, bounded, cancellable, and never redirected off the trusted origin.
 * Each case pins a way a hostile or broken server could otherwise fill storage or substitute bytes. */
class UpdateDownloaderTest {
    private val bytes = ByteArray(256 * 1024) { (it * 31 % 251).toByte() }
    private fun withServer(block: suspend (MockWebServer, OkHttpClient, File) -> Unit) {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val serverTls = HandshakeCertificates.Builder().heldCertificate(certificate).build()
        val clientTls = HandshakeCertificates.Builder().addTrustedCertificate(certificate.certificate).build()
        val server = MockWebServer().apply { useHttps(serverTls.sslSocketFactory(), false); start() }
        val client = OkHttpClient.Builder().sslSocketFactory(clientTls.sslSocketFactory(), clientTls.trustManager).build()
        val directory = Files.createTempDirectory("native-apk-update").toFile()
        try { runBlocking { block(server, client, File(directory, "updates")) } } finally { server.shutdown(); directory.deleteRecursively() }
    }
    private fun failure(block: suspend () -> Unit): UpdateFailure = runBlocking {
        try { block(); fail("Expected an update failure"); throw AssertionError() } catch (error: UpdateFailure) { error }
    }

    @Test fun `a full download lands in app-private storage without cookies`() = withServer { server, client, directory ->
        // The APK origin shares the game host: wallet session cookies must never ride along.
        server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
        val offer = offer(bytes); val progress = mutableListOf<Pair<Long, Long>>()
        File(directory.apply { mkdirs() }, "25-${"0".repeat(64)}.apk").writeText("stale")
        val apk = UpdateDownloader(directory, client).download(offer, server.url("/native/releases/26.apk")) { done, total -> progress += done to total }
        assertArrayEquals(bytes, apk.file.readBytes()); assertEquals(File(directory, "26-${offer.sha256}.apk"), apk.file)
        assertEquals(bytes.size.toLong() to bytes.size.toLong(), progress.last())
        assertEquals("Only one offer's files are kept", listOf(apk.file.name), directory.list()!!.toList())
        val request = server.takeRequest()
        assertNull(request.getHeader("Cookie")); assertNull(request.getHeader("Range"))
        UpdateDownloader(directory, client).discard(); assertEquals("An installed update leaves no APK behind", 0, directory.list()!!.size)
    }
    @Test fun `a partial file resumes with an exact Range and 206`() = withServer { server, client, directory ->
        // Players on a phone connection must not restart a 200 MB transfer after every interruption.
        val downloader = UpdateDownloader(directory, client); val offer = offer(bytes)
        directory.mkdirs(); downloader.partFile(offer).writeBytes(bytes.copyOfRange(0, 1000))
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 1000-${bytes.size - 1}/${bytes.size}")
            .setBody(Buffer().write(bytes, 1000, bytes.size - 1000)))
        val apk = downloader.download(offer, server.url("/apk")) { _, _ -> }
        assertEquals("bytes=1000-", server.takeRequest().getHeader("Range"))
        assertArrayEquals(bytes, apk.file.readBytes()); assertFalse(downloader.partFile(offer).exists())
    }
    @Test fun `a resume answered with the wrong range is refused`() = withServer { server, client, directory ->
        // Appending a mismatched range would corrupt the file silently until the hash check.
        val downloader = UpdateDownloader(directory, client); val offer = offer(bytes)
        directory.mkdirs(); downloader.partFile(offer).writeBytes(bytes.copyOfRange(0, 1000))
        server.enqueue(MockResponse().setResponseCode(206).setHeader("Content-Range", "bytes 0-${bytes.size - 1}/${bytes.size}").setBody(Buffer().write(bytes)))
        assertEquals(UpdateFailureKind.NETWORK, failure { downloader.download(offer, server.url("/apk")) { _, _ -> } }.kind)
        assertEquals(1000L, downloader.partFile(offer).length())
    }
    @Test fun `a redirect is refused, never followed`() = withServer { server, client, directory ->
        // Following a Location header would leave the trusted origin that eligibility checked.
        server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://evil.example/apk"))
        assertEquals(UpdateFailureKind.ORIGIN, failure { UpdateDownloader(directory, client).download(offer(bytes), server.url("/apk")) { _, _ -> } }.kind)
        assertEquals(1, server.requestCount)
    }
    @Test fun `a content length other than the offer is refused before writing`() = withServer { server, client, directory ->
        // A larger or unknown-length body must not start consuming storage.
        server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
        val downloader = UpdateDownloader(directory, client); val offer = offer(bytes, size = bytes.size + 1L)
        assertEquals(UpdateFailureKind.NETWORK, failure { downloader.download(offer, server.url("/apk")) { _, _ -> } }.kind)
        assertFalse(downloader.partFile(offer).exists()); assertFalse(downloader.apkFile(offer).exists())
        server.enqueue(MockResponse().setChunkedBody(Buffer().write(bytes), 4096))
        assertEquals(UpdateFailureKind.NETWORK, failure { downloader.download(offer(bytes), server.url("/apk")) { _, _ -> } }.kind)
    }
    @Test fun `bytes beyond the advertised size delete the partial file`() = withServer { server, client, directory ->
        // The streaming bound holds even when a declared length lies: no transfer may exceed the offer's size.
        server.enqueue(MockResponse().setBody(Buffer().write(bytes)))
        val lying = client.newBuilder().addInterceptor { chain ->
            val response = chain.proceed(chain.request()); response.body?.close()
            response.newBuilder().body(object : ResponseBody() {
                override fun contentType(): MediaType? = null
                override fun contentLength() = bytes.size.toLong()
                override fun source(): BufferedSource = Buffer().write(bytes).write(ByteArray(4096))
            }).build()
        }.build()
        val downloader = UpdateDownloader(directory, lying); val offer = offer(bytes)
        assertEquals(UpdateFailureKind.ORIGIN, failure { downloader.download(offer, server.url("/apk")) { _, _ -> } }.kind)
        assertFalse(downloader.partFile(offer).exists()); assertFalse(downloader.apkFile(offer).exists())
    }
    @Test fun `cancellation stops the transfer and keeps the partial file for a resume`() = withServer { server, client, directory ->
        // Cancel must free the connection promptly but not throw away what was already paid for in data.
        server.enqueue(MockResponse().setBody(Buffer().write(bytes)).throttleBody(8 * 1024, 40, TimeUnit.MILLISECONDS))
        val downloader = UpdateDownloader(directory, client); val offer = offer(bytes); val started = CompletableDeferred<Unit>()
        var last = 0L
        val job = CoroutineScope(Dispatchers.IO).launch { downloader.download(offer, server.url("/apk")) { done, _ -> last = done; if (done > 0) started.complete(Unit) } }
        started.await(); job.cancelAndJoin()
        val kept = downloader.partFile(offer).length()
        assertTrue("partial bytes kept: $kept", kept in 1 until bytes.size.toLong())
        assertFalse(downloader.apkFile(offer).exists()); assertTrue(last < bytes.size)
    }
    @Test fun `pruning keeps only files a newer offer can still use`() {
        // Code 61 installed from its own cached APK, and the file stayed: ~200 MB of app storage for nothing. A file at or
        // below the running version can never be installed again, and a name this client did not write is not ours to
        // keep. A newer partial download stays, so a relaunch resumes it instead of paying for the bytes twice.
        val directory = Files.createTempDirectory("native-apk-prune").toFile()
        try {
            val sha = "a".repeat(64)
            for (name in listOf("61-$sha.apk", "60-$sha.apk.part", "62-$sha.apk.part", "62-$sha.apk.tmp", "evil.apk"))
                File(directory, name).writeText("x")
            UpdateDownloader(directory).prune(61, keep = null)
            assertEquals(listOf("62-$sha.apk.part"), directory.list()!!.toList())
            // Once an offer is known, only its own files stay: a withdrawn or superseded offer never holds storage.
            val next = offer(bytes, code = 63); val downloader = UpdateDownloader(directory)
            downloader.partFile(next).writeText("resume")
            downloader.prune(61, keep = next)
            assertEquals(listOf(downloader.partFile(next).name), directory.list()!!.toList())
        } finally { directory.deleteRecursively() }
    }
}
