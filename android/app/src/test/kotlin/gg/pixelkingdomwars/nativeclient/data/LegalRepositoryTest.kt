package gg.pixelkingdomwars.nativeclient.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.mockwebserver.*
import org.junit.Assert.*
import org.junit.Test

class LegalRepositoryTest {
    private class Fixture : AutoCloseable {
        val server = MockWebServer().apply { start() }
        val requests = mutableListOf<Request>()
        val client = OkHttpClient.Builder().followRedirects(false).followSslRedirects(false).cookieJar(CookieJar.NO_COOKIES).build()
        val source = PublicLegalDocuments(Call.Factory { original ->
            requests += original
            // Test-only socket routing: the source still constructs the fixed canonical HTTPS request.
            client.newCall(original.newBuilder().url(server.url(original.url.encodedPath)).build())
        })
        fun html(body: String) { server.enqueue(MockResponse().setHeader("Content-Type","text/html; charset=utf-8").setBody(body)) }
        override fun close() { server.shutdown(); client.connectionPool.evictAll(); client.dispatcher.executorService.shutdown() }
    }
    @Test fun `both complete documents use only fixed cookie free HTTPS GET requests`() = Fixture().use { f ->
        for (document in LegalDocument.entries) {
            val html="<!doctype html><html><body><h1>${document.label}</h1><p>First paragraph.</p><p>Entire final section ©.</p></body></html>"
            f.html(html); assertEquals(html,runBlocking { f.source.load(document) })
            val original=f.requests.last(); assertEquals(document.url,original.url.toString()); assertEquals("GET",original.method)
            assertEquals(setOf("Accept"),original.headers.names()); assertEquals("text/html",original.header("Accept"))
            assertNull(original.header("Cookie")); assertNull(original.header("Authorization"))
        }
        assertEquals(listOf("/terms","/privacy"),listOf(f.server.takeRequest().path,f.server.takeRequest().path))
    }
    @Test fun `redirects and non HTML cannot substitute arbitrary content`() = Fixture().use { f ->
        f.server.enqueue(MockResponse().setResponseCode(302).setHeader("Location","https://arbitrary.example/game"))
        assertThrows(Exception::class.java) { runBlocking { f.source.load(LegalDocument.TERMS) } }
        assertEquals(1,f.server.requestCount)
        for(type in listOf("application/json","text/plain","text/html; charset=iso-8859-1")) {
            f.server.enqueue(MockResponse().setHeader("Content-Type",type).setBody("not the published HTML"))
            assertThrows(Exception::class.java) { runBlocking { f.source.load(LegalDocument.PRIVACY) } }
        }
        Unit
    }
    @Test fun `known and streaming oversized documents fail without truncated legal text`() = Fixture().use { f ->
        val oversized="x".repeat(PublicLegalDocuments.MAX_BYTES+1)
        f.html(oversized)
        assertThrows(Exception::class.java) { runBlocking { f.source.load(LegalDocument.TERMS) } }
        f.server.enqueue(MockResponse().setHeader("Content-Type","text/html").setChunkedBody(oversized,8192))
        assertThrows(Exception::class.java) { runBlocking { f.source.load(LegalDocument.PRIVACY) } }
        Unit
    }
    @Test fun `empty or malformed UTF8 is never shown as a complete legal document`() = Fixture().use { f ->
        f.html(" ")
        assertThrows(Exception::class.java) { runBlocking { f.source.load(LegalDocument.TERMS) } }
        f.server.enqueue(MockResponse().setHeader("Content-Type","text/html; charset=utf-8").setBody(okio.Buffer().write(byteArrayOf(0xc3.toByte(),0x28))))
        assertThrows(Exception::class.java) { runBlocking { f.source.load(LegalDocument.TERMS) } }
        Unit
    }
    @Test fun `leaving reader cancels outstanding network retrieval`() = Fixture().use { f -> runBlocking {
        f.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
        val job=launch { f.source.load(LegalDocument.TERMS) }
        withContext(Dispatchers.IO) { assertNotNull(f.server.takeRequest(5,TimeUnit.SECONDS)) }
        withTimeout(5000) { job.cancelAndJoin() }; assertTrue(job.isCancelled)
    } }
    @Test fun `server failure remains retryable and does not create a prose fallback`() = runBlocking {
        var fail=true; var requests=0
        val repo=LegalRepository(fetch={ requests++; if(fail) throw IOException("offline"); "Complete document" })
        repo.load(LegalDocument.TERMS); assertNull(repo.state.value.html); assertNotNull(repo.state.value.error)
        fail=false; repo.load(LegalDocument.TERMS,true); assertEquals("Complete document",repo.state.value.html); assertNull(repo.state.value.error)
        assertEquals(2,requests)
    }
    @Test fun `failed reload keeps only this document with an explicit stale notice`() = runBlocking {
        var fail=false
        val repo=LegalRepository(fetch={ if(fail) throw IOException(); it.label })
        repo.load(LegalDocument.TERMS); fail=true; repo.load(LegalDocument.TERMS,true)
        assertEquals("Terms of Use",repo.state.value.html); assertNotNull(repo.state.value.error)
        repo.load(LegalDocument.PRIVACY); assertNull(repo.state.value.html); assertEquals(LegalDocument.PRIVACY,repo.state.value.document)
    }
    @Test fun `late previous document cannot overwrite selected document`() = runBlocking {
        val entered=CompletableDeferred<Unit>(); val finish=CompletableDeferred<Unit>()
        val repo=LegalRepository(fetch={ if(it==LegalDocument.TERMS) { entered.complete(Unit); withContext(NonCancellable){finish.await()} }; it.label })
        val old=launch { repo.load(LegalDocument.TERMS) }; entered.await()
        repo.load(LegalDocument.PRIVACY); finish.complete(Unit); old.join()
        assertEquals(LegalDocument.PRIVACY,repo.state.value.document); assertEquals("Privacy Policy",repo.state.value.html)
    }
    @Test fun `Back fences late public results and offline preview performs no request`() = runBlocking {
        val entered=CompletableDeferred<Unit>(); val finish=CompletableDeferred<Unit>()
        val repo=LegalRepository(fetch={entered.complete(Unit);finish.await();"document"})
        val job=launch { repo.load(LegalDocument.TERMS) }; entered.await(); repo.close(); finish.complete(Unit); job.join()
        assertNull(repo.state.value.html); assertFalse(repo.state.value.loading)
        var requests=0; val offline=LegalRepository(true){requests++;"document"}; offline.load(LegalDocument.TERMS)
        assertEquals(0,requests); assertNull(offline.state.value.html); assertNotNull(offline.state.value.error)
    }
    @Test fun `foreground retains loaded text without a timer and explicit reload fetches again`() = runBlocking {
        var requests=0; val repo=LegalRepository(fetch={requests++;"document"})
        repo.load(LegalDocument.TERMS); repo.load(LegalDocument.TERMS); assertEquals(1,requests)
        repo.load(LegalDocument.TERMS,true); assertEquals(2,requests)
    }
    @Test fun `reader policy precedes remote markup without removing any legal text`() {
        val original="<!doctype html><html><head><meta http-equiv=refresh content='0;url=https://other.example'></head><body>Entire text and final section.</body></html>"
        val wrapped=legalReaderHtml(original)
        assertTrue(wrapped.startsWith("<meta http-equiv=\"Content-Security-Policy\""))
        assertTrue(wrapped.contains("script-src 'none'")); assertTrue(wrapped.contains("frame-src 'none'")); assertTrue(wrapped.contains("form-action 'none'"))
        assertTrue(wrapped.endsWith(original))
    }
    @Test fun `support matches published routes and encodes public wallet without mail header injection`() {
        assertEquals("support@pixelkingdomwars.com",GameSupport.EMAIL); assertEquals("https://discord.gg/PWb65fg3mN",GameSupport.DISCORD)
        assertEquals("mailto:support@pixelkingdomwars.com?subject=Pixel%20Kingdom%20Wars%20support",GameSupport.mailto(null))
        val mail=GameSupport.mailto("wallet&bcc=other@example.com#fragment")
        assertTrue(mail.contains("%26bcc%3D")); assertTrue(mail.contains("%23fragment")); assertFalse(mail.contains("&bcc=")); assertFalse(mail.contains("+"))
    }
}
