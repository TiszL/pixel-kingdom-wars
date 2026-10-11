package gg.pixelkingdomwars.nativeclient.network

import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import kotlinx.coroutines.*
import okhttp3.*
import okhttp3.mockwebserver.*
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class GameApiSessionEpochTest {
    @Test fun `binary request rejects stale identity and encoded path escape before HTTP`(): Unit = runBlocking {
        Fixture().use { f ->
            val old = f.api.sessionToken(); f.api.beginAuthentication(); f.seed(value = "new")
            try { f.api.download("/image", "image/webp", 100, old); fail("Stale binary sent") } catch (_: SessionSupersededException) { }
            for (path in listOf("/%2e%2e/private", "//external/image", "/image?token=bad")) {
                try { f.api.download(path, "image/webp", 100, f.api.sessionToken()); fail("Invalid image path sent") } catch (_: IllegalArgumentException) { }
            }
            assertEquals(0, f.server.requestCount)
        }
    }
    @Test fun `binary body cannot publish or accept cookies when identity changes after headers`(): Unit = runBlocking {
        val bodyStarted = CompletableDeferred<Unit>()
        Fixture(object : EventListener() { override fun responseBodyStart(call: Call) { bodyStarted.complete(Unit) } }).use { f ->
            f.seed(); f.server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").setBody("slow-body")
                .addHeader("Set-Cookie", cookie("shardkeep_session", "late")).throttleBody(1, 100, TimeUnit.MILLISECONDS))
            val read = async { f.api.download("/image", "image/webp", 100, f.api.sessionToken()) }
            withTimeout(5_000) { bodyStarted.await() }; f.api.beginAuthentication(); f.seed(value = "new")
            try { withTimeout(2_000) { read.await() }; fail("Stale body published") } catch (_: SessionSupersededException) { }
            assertEquals("new", f.value("shardkeep_session"))
        }
    }

    @Test fun `authenticated binary GET binds headers and exact bounded image without a grant`(): Unit = runBlocking {
        Fixture().use { f ->
            f.seed(); f.server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").setBody(okio.Buffer().write(byteArrayOf(0, 1, -1))))
            assertArrayEquals(byteArrayOf(0, 1, -1), f.api.download("/avatars/image.webp", "image/webp", 3, f.api.sessionToken()))
            val request = f.server.takeRequest(); assertEquals("GET", request.method)
            assertEquals("image/webp", request.getHeader("Accept")); assertEquals("shardkeep_session=old", request.getHeader("Cookie"))
            assertEquals(f.origin.toString().trimEnd('/'), request.getHeader("Origin")); assertTrue(request.getHeader("Cache-Control")!!.contains("no-store"))
            assertNull(request.getHeader("x-shardkeep-recent-auth"))
        }
    }
    @Test fun `binary GET bounds declared and chunked bodies and rejects wrong image content type`(): Unit = runBlocking {
        Fixture().use { f ->
            for (reply in listOf(MockResponse().setBody("abcdef"), MockResponse().setChunkedBody("abcdef", 1), MockResponse().setBody("html").setHeader("Content-Type", "text/html"))) {
                if (reply.headers["Content-Type"] == null) reply.setHeader("Content-Type", "image/webp")
                f.server.enqueue(reply)
                try { f.api.download("/image", "image/webp", 4, f.api.sessionToken()); fail("Invalid binary accepted") } catch (_: ApiCompatibilityException) { }
            }
            assertEquals(3, f.server.requestCount)
        }
    }
    @Test fun `late binary headers cannot publish or replace the next identity cookie`(): Unit = runBlocking {
        Fixture().use { f ->
            f.seed(); val delayed = Delayed("/api/image", MockResponse().setHeader("Content-Type", "image/webp").setBody("image").addHeader("Set-Cookie", cookie("shardkeep_session", "late")))
            f.server.dispatcher = delayed
            val read = async { f.api.download("/image", "image/webp", 10, f.api.sessionToken()) }
            try { delayed.awaitRequest(); f.api.beginAuthentication(); f.seed(value = "new") } finally { delayed.release.countDown() }
            try { read.await(); fail("Stale image published") } catch (_: SessionSupersededException) { }
            assertEquals("new", f.value("shardkeep_session"))
        }
    }
    @Test fun `leaving binary image cancels a blocked response body promptly`(): Unit = runBlocking {
        val bodyStarted = CompletableDeferred<Unit>()
        Fixture(object : EventListener() { override fun responseBodyStart(call: Call) { bodyStarted.complete(Unit) } }).use { f ->
            f.server.enqueue(MockResponse().setHeader("Content-Type", "image/webp").setBody("x".repeat(1000)).throttleBody(1, 1, TimeUnit.SECONDS))
            val read = launch { f.api.download("/image", "image/webp", 1000, f.api.sessionToken()) }
            withTimeout(5_000) { bodyStarted.await() }; withTimeout(2_000) { read.cancelAndJoin() }
            assertTrue(read.isCancelled); assertEquals(1, f.server.requestCount)
        }
    }
    @Test fun `binary failures retain routing status and redirects never carry cookies onward`(): Unit = runBlocking {
        Fixture().use { f ->
            f.seed(); f.server.enqueue(MockResponse().setResponseCode(401).setBody("{\"error\":{\"code\":\"SESSION_EXPIRED\",\"message\":\"Sign in\"}}"))
            try { f.api.download("/image", "image/webp", 1024, f.api.sessionToken()); fail("Unauthorized image") }
            catch (failure: ApiException) { assertEquals(401, failure.status); assertEquals("SESSION_EXPIRED", failure.code) }
            f.server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", requireNotNull(f.origin.resolve("/different"))))
            try { f.api.download("/image", "image/webp", 1024, f.api.sessionToken()); fail("Redirect followed") } catch (failure: ApiException) { assertEquals(302, failure.status) }
            assertEquals(2, f.server.requestCount)
        }
    }

    @Test fun `image PATCH retains exact bytes and session without changing ordinary JSON requests`() = runBlocking {
        Fixture().use { f ->
            f.seed()
            repeat(2) { f.server.enqueue(MockResponse().setBody("{}")) }
            val bytes = byteArrayOf(0, 1, -1, 34, 0, -128)
            f.api.upload("/image", "PATCH", bytes, "image/png", f.api.sessionToken())
            f.api.post("/ordinary", jsonBody("name" to "Kingdom"))
            val upload = f.server.takeRequest()
            assertEquals("PATCH", upload.method)
            assertEquals("image/png", upload.getHeader("Content-Type"))
            assertEquals("shardkeep_session=old", upload.getHeader("Cookie"))
            assertEquals(f.origin.toString().trimEnd('/'), upload.getHeader("Origin"))
            assertArrayEquals(bytes, upload.body.readByteArray())
            val ordinary = f.server.takeRequest()
            assertTrue(ordinary.getHeader("Content-Type")!!.startsWith("application/json"))
            assertEquals("{\"name\":\"Kingdom\"}", ordinary.body.readUtf8())
            assertNull(upload.getHeader("x-shardkeep-recent-auth"))
        }
    }

    @Test fun `lost upload acknowledgment never repeats the binary mutation`() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            f.server.enqueue(MockResponse().setBody("{}"))
            try { f.api.upload("/image", "POST", byteArrayOf(1), "image/webp", f.api.sessionToken()); fail("Lost upload accepted") }
            catch (_: IOException) { }
            assertEquals(1, f.server.requestCount)
        }
    }

    @Test fun `an upload cannot borrow a new identity or inject an image content type`() = runBlocking {
        Fixture().use { f ->
            val old = f.api.sessionToken()
            f.api.beginAuthentication()
            f.seed(value = "new")
            try { f.api.upload("/image", "PATCH", byteArrayOf(1), "image/jpeg", old); fail("Stale upload sent") }
            catch (_: SessionSupersededException) { }
            for ((method, type) in listOf("GET" to "image/png", "PATCH" to "image/png\r\nCookie: stolen")) {
                try { f.api.upload("/image", method, byteArrayOf(1), type, f.api.sessionToken()); fail("Invalid upload sent") }
                catch (_: IllegalArgumentException) { }
            }
            assertEquals(0, f.server.requestCount)
            assertEquals("new", f.value("shardkeep_session"))
        }
    }

    @Test fun `late upload response cannot publish or replace another account's cookie`() = runBlocking {
        Fixture().use { f ->
            f.seed()
            val delayed = Delayed("/api/image", MockResponse().setBody("{}").addHeader("Set-Cookie", cookie("shardkeep_session", "late")))
            f.server.dispatcher = delayed
            val upload = async { f.api.upload("/image", "PATCH", byteArrayOf(1), "image/png", f.api.sessionToken()) }
            try { delayed.awaitRequest(); f.api.beginAuthentication(); f.seed(value = "new") }
            finally { delayed.release.countDown() }
            discarded(upload)
            assertEquals("new", f.value("shardkeep_session"))
            assertEquals(1, f.server.requestCount)
        }
    }

    @Test fun `leaving an image upload cancels a blocked response body promptly`() = runBlocking {
        val bodyStarted = CompletableDeferred<Unit>()
        Fixture(object : EventListener() {
            override fun responseBodyStart(call: Call) { bodyStarted.complete(Unit) }
        }).use { f ->
            f.server.enqueue(MockResponse().setBody("{\"padding\":\"${"x".repeat(1000)}\"}").throttleBody(1, 1, TimeUnit.SECONDS))
            val upload = launch { f.api.upload("/image", "PATCH", byteArrayOf(1), "image/png", f.api.sessionToken()) }
            withTimeout(5_000) { bodyStarted.await() }
            withTimeout(2_000) { upload.cancelAndJoin() }
            assertTrue(upload.isCancelled)
            assertEquals(1, f.server.requestCount)
        }
    }

    @Test fun `recent auth belongs to one explicit session and one POST only`() = runBlocking {
        Fixture().use { f ->
            f.seed()
            repeat(3) { f.server.enqueue(MockResponse().setBody("{}")) }
            val session = f.api.sessionToken()
            f.api.postWithRecentAuth("/sensitive", jsonBody("action" to "one"), "ephemeral-grant", session)
            f.api.post("/ordinary")
            f.api.get("/ordinary")
            val sensitive = f.server.takeRequest()
            assertEquals("POST", sensitive.method)
            assertEquals("ephemeral-grant", sensitive.getHeader("x-shardkeep-recent-auth"))
            assertEquals("shardkeep_session=old", sensitive.getHeader("Cookie"))
            repeat(2) { assertNull(f.server.takeRequest().getHeader("x-shardkeep-recent-auth")) }
            assertFalse(f.store.value.orEmpty().contains("ephemeral-grant"))
            f.api.forgetLocalSession()
            try { f.api.postWithRecentAuth("/sensitive", jsonBody(), "ephemeral-grant", session); fail("Stale grant reused") }
            catch (_: SessionSupersededException) { }
            assertEquals(3, f.server.requestCount)
        }
    }

    @Test fun `malformed recent auth cannot inject headers or send an order`() = runBlocking {
        Fixture().use { f ->
            for (grant in listOf("", " ", "grant\r\nCookie: other")) {
                try { f.api.postWithRecentAuth("/sensitive", jsonBody(), grant, f.api.sessionToken()); fail("Invalid grant accepted") }
                catch (_: IllegalArgumentException) { }
            }
            assertEquals(0, f.server.requestCount)
        }
    }

    private class Store : SecretStore {
        var value: String?=null
        var onWrite: ()->Unit = {}
        override fun read()=value
        override fun write(value: String) { this.value=value;onWrite() }
        override fun clear() { value=null }
    }
    private class Fixture(listener: EventListener = EventListener.NONE) : AutoCloseable {
        val store=Store()
        private val cert=HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls=HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust=HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server=MockWebServer().apply { useHttps(tls.sslSocketFactory(),false);start() }
        val origin=server.url("/")
        val jar=SessionCookieJar(origin,store)
        private val transport=OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(),trust.trustManager).eventListener(listener).build()
        val api=GameApi(origin.toString(),jar,"session-epoch-test",transport)
        fun seed(name: String="shardkeep_session",value: String="old") {
            jar.saveFromResponse(origin,listOf(Cookie.parse(origin,"$name=$value; Secure; HttpOnly; Path=/; Max-Age=3600")!!))
        }
        fun value(name: String)=SessionCookieJar(origin,store).loadForRequest(origin).singleOrNull { it.name==name }?.value
        override fun close() { server.shutdown();transport.connectionPool.evictAll();transport.dispatcher.executorService.shutdown() }
    }
    private fun cookie(name: String,value: String)="$name=$value; Secure; HttpOnly; Path=/; Max-Age=3600"
    private fun deletion(name: String)="$name=; Path=/; Max-Age=0"
    private class Delayed(private val path: String,private val response: MockResponse,
                          private val other: (RecordedRequest)->MockResponse = { MockResponse().setBody("{}") }): okhttp3.mockwebserver.Dispatcher() {
        val entered=CountDownLatch(1);val release=CountDownLatch(1)
        override fun dispatch(request: RecordedRequest): MockResponse {
            if(request.path!=path) return other(request)
            entered.countDown()
            check(release.await(10,TimeUnit.SECONDS)) { "Test did not release delayed response" }
            return response
        }
        suspend fun awaitRequest() = withContext(Dispatchers.IO) { check(entered.await(5,TimeUnit.SECONDS)) }
    }
    private suspend fun discarded(result: Deferred<*>) {
        try { withTimeout(5_000) { result.await() };fail("Old response was accepted") }
        catch(_: SessionSupersededException) { }
    }

    @Test fun `a public read survives identity swaps mid-request and never sends or keeps a cookie`() = runBlocking {
        // M45 §5 emulator acceptance: the startup update check was bound to the launch token; the concurrent restore
        // (and a signed-out player's 401) replaced that token, the answer was discarded as superseded, and a signed-out
        // player never saw the stable offer. Public metadata must belong to no identity, and must never carry the
        // player's cookie out or plant one from its response.
        Fixture().use { f ->
            f.seed()
            val delayed = Delayed("/api/native/capabilities", MockResponse().setBody("{\"protocolVersion\":1}")
                .addHeader("Set-Cookie", cookie("shardkeep_session", "planted")))
            f.server.dispatcher = delayed
            val read = async { f.api.getPublic("/native/capabilities") }
            try { delayed.awaitRequest(); f.api.beginAuthentication(); f.api.beginAuthentication() } finally { delayed.release.countDown() }
            assertEquals("1", withTimeout(5_000) { read.await() }["protocolVersion"].toString())
            val request = f.server.takeRequest()
            assertNull(request.getHeader("Cookie"))
            assertEquals(f.origin.toString().trimEnd('/'), request.getHeader("Origin")); assertEquals("android-native", request.getHeader("X-PKW-Client"))
            assertEquals("The player's own cookie is untouched", "old", f.value("shardkeep_session"))
        }
    }
    @Test fun `a public read refuses path escapes before HTTP and never follows a redirect`() = runBlocking {
        // Same origin rule as every request: a public path can neither leave /api nor be bounced to another host.
        Fixture().use { f ->
            for (path in listOf("/%2e%2e/private", "//external/capabilities", "/native/capabilities?wallet=x")) {
                try { f.api.getPublic(path); fail("Invalid public path sent") } catch (_: IllegalArgumentException) { }
            }
            assertEquals(0, f.server.requestCount)
            f.server.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://example.invalid/api/native/capabilities"))
            try { f.api.getPublic("/native/capabilities"); fail("Redirect followed") } catch (failure: ApiException) { assertEquals(302, failure.status) }
            assertEquals(1, f.server.requestCount)
        }
    }

    @Test fun `late full and pending login cookies cannot resurrect explicit local sign out`() = runBlocking {
        for(name in listOf("shardkeep_session","shardkeep_login")) Fixture().use { f ->
            val delayed=Delayed("/api/old",MockResponse().setBody("{}").addHeader("Set-Cookie",cookie(name,"late")))
            f.server.dispatcher=delayed
            val old=async { f.api.post("/old") }
            try { delayed.awaitRequest();f.api.forgetLocalSession() }
            finally { delayed.release.countDown() }
            discarded(old);assertNull(f.store.value);assertNull(f.value(name));assertEquals(1,f.server.requestCount)
        }
    }
    @Test fun `old pending status deletion cannot erase a newer login even for the same wallet`() = runBlocking {
        Fixture().use { f ->
            f.seed("shardkeep_login")
            val delayed=Delayed("/api/auth/login/status",MockResponse().setBody("{\"loginRequired\":false}").addHeader("Set-Cookie",deletion("shardkeep_login"))) {
                MockResponse().setBody("{\"wallet\":\"same-wallet\",\"loginRequired\":true,\"expiresAt\":\"2026-09-07T00:00:00Z\"}")
                    .addHeader("Set-Cookie",cookie("shardkeep_login","new"))
            }
            f.server.dispatcher=delayed
            val old=async { f.api.get("/auth/login/status") }
            try {
                delayed.awaitRequest()
                val newer=f.api.beginAuthentication()
                f.api.post("/auth/verify",session=newer)
            } finally { delayed.release.countDown() }
            discarded(old);assertEquals("new",f.value("shardkeep_login"))
        }
    }
    @Test fun `late 401 is discarded and a previously delivered 401 cannot clear a newer session`() = runBlocking {
        Fixture().use { f ->
            val delayed=Delayed("/api/old",MockResponse().setResponseCode(401).setBody("{\"error\":\"expired\"}")) {
                MockResponse().setResponseCode(401).setBody("{\"error\":\"expired\"}")
            }
            f.server.dispatcher=delayed
            val old=async { f.api.get("/old") }
            try { delayed.awaitRequest();f.api.beginAuthentication();f.seed(value="new") }
            finally { delayed.release.countDown() }
            discarded(old)
            val error=try { f.api.get("/current");error("Expected401") } catch(e: ApiException) { e }
            f.api.beginAuthentication();f.seed(value="newer")
            assertFalse(f.api.forgetLocalSession(requireNotNull(error.session)))
            assertEquals("newer",f.value("shardkeep_session"))
        }
    }
    @Test fun `logout uses detached old credentials once and cannot delete a superseding login`() = runBlocking {
        Fixture().use { f ->
            f.seed()
            val delayed=Delayed("/api/auth/logout",MockResponse().setBody("{\"ok\":true}")
                .addHeader("Set-Cookie",deletion("shardkeep_session")))
            f.server.dispatcher=delayed
            val logoutToken=f.api.beginLogout()
            val old=async { f.api.logout(logoutToken) }
            try {
                delayed.awaitRequest()
                assertNull(f.store.value)
                assertThrows(IllegalStateException::class.java) { f.api.beginAuthentication() }
                val sent=f.server.takeRequest(1,TimeUnit.SECONDS)!!
                assertEquals("shardkeep_session=old",sent.getHeader("Cookie"));assertEquals("POST",sent.method)
                // Explicit reset simulates an externally superseding account; no automatic retry.
                f.api.forgetLocalSession();f.api.beginAuthentication();f.seed(value="new")
            } finally { delayed.release.countDown() }
            discarded(old);assertEquals("new",f.value("shardkeep_session"));assertEquals(1,f.server.requestCount)
        }
    }
    @Test fun `pending TOTP promotion sends its original proof and replaces it with the full session`() = runBlocking {
        Fixture().use { f ->
            f.seed("shardkeep_login","pending")
            f.server.enqueue(MockResponse().setBody("{\"wallet\":\"same-wallet\",\"entryPaid\":true}")
                .addHeader("Set-Cookie",deletion("shardkeep_login")).addHeader("Set-Cookie",cookie("shardkeep_session","full")))
            val attempt=f.api.beginAuthentication()
            f.api.withSession(attempt) { f.api.post("/auth/login/verify",jsonBody("code" to "123456")) }
            assertEquals("shardkeep_login=pending",f.server.takeRequest().getHeader("Cookie"))
            assertNull(f.value("shardkeep_login"));assertEquals("full",f.value("shardkeep_session"));assertEquals(1,f.server.requestCount)
        }
    }
    @Test fun `an old bound coroutine cannot borrow a new account for its next request`() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setBody("{}"))
            val firstDone=CompletableDeferred<Unit>();val resume=CompletableDeferred<Unit>()
            val oldToken=f.api.sessionToken()
            val old=async { f.api.withSession(oldToken) { f.api.get("/first");firstDone.complete(Unit);resume.await();f.api.post("/must-not-send") } }
            firstDone.await();f.api.beginAuthentication();f.seed(value="new");resume.complete(Unit)
            discarded(old);assertEquals(1,f.server.requestCount);assertEquals("new",f.value("shardkeep_session"))
        }
    }
    @Test fun `lost authentication mutation response is never retried`() = runBlocking {
        Fixture().use { f ->
            f.server.enqueue(MockResponse().setBody("{}"))
            f.api.get("/warm")
            f.server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
            f.server.enqueue(MockResponse().setBody("{\"wallet\":\"must-not-retry\",\"entryPaid\":true}"))
            try { f.api.post("/auth/verify");fail("Lost response accepted") } catch(_: IOException) { }
            assertEquals(2,f.server.requestCount);assertNull(f.store.value)
        }
    }
    @Test fun `a response queued for the caller dispatcher is rechecked before publication`() = runBlocking {
        Fixture().use { f -> Executors.newSingleThreadExecutor().asCoroutineDispatcher().use { caller ->
            val delayed=Delayed("/api/old",MockResponse().setBody("{}").addHeader("Set-Cookie",cookie("shardkeep_session","old")))
            f.server.dispatcher=delayed
            val saved=CompletableDeferred<Unit>();f.store.onWrite={ saved.complete(Unit) }
            val unblockCaller=CountDownLatch(1);val callerBlocked=CompletableDeferred<Unit>()
            val old=async(caller) { f.api.get("/old") }
            delayed.awaitRequest()
            val blocker=launch(caller) { callerBlocked.complete(Unit);check(unblockCaller.await(5,TimeUnit.SECONDS)) }
            try {
                callerBlocked.await();delayed.release.countDown()
                withTimeout(5_000) { saved.await() }
                f.api.beginAuthentication();f.seed(value="new")
            } finally { delayed.release.countDown();unblockCaller.countDown() }
            blocker.join();discarded(old);assertEquals("new",f.value("shardkeep_session"))
        } }
    }
}
