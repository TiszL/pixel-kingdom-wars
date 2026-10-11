package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.async
import kotlinx.coroutines.CompletableDeferred
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

/** Sign-in and restoration against a real HTTPS transport, with typed decoding at every step. */
class AccountRepositoryTest {
    @Test fun `unlink keeps saved cookie and selection but cancels gameplay and never sends server logout`() = Fixture().use { f -> runBlocking {
        f.seedCookie(); f.enqueue("""{"loginRequired":false}""", me, bases, """{"open":true}""")
        f.repository.restore(); val original = f.holder.current!!; val cookie = f.cookies.value; val selection = f.selection.value
        var suspended = 0; var released = 0
        f.repository.beforeLogout = { suspended++; f.api.requireCurrentSession(original.token) }
        f.repository.unlink { released++ }
        assertEquals(1, suspended); assertEquals(1, released); assertNull(f.holder.current)
        assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase)
        assertEquals(cookie, f.cookies.value); assertEquals(selection, f.selection.value)
        assertEquals("Unlink sends no server logout or game mutation", 4, f.server.requestCount)
        assertThrows(SessionSupersededException::class.java) { f.api.requireCurrentSession(original.token) }
        f.enqueue("""{"loginRequired":false}""", me, bases, """{"open":true}""")
        f.repository.restore(); assertEquals(AccountPhase.SIGNED_IN, f.repository.state.value.phase)
        repeat(4) { f.server.takeRequest() }
        assertNotNull("The retained cookie supports a later normal restore", f.server.takeRequest().getHeader("Cookie"))
    } }
    @Test fun `unlink suspended during notification cleanup cannot disconnect a superseding wallet`() = Fixture().use { f -> runBlocking {
        f.seedCookie(); f.enqueue("""{"loginRequired":false}""", me, bases, """{"open":true}"""); f.repository.restore()
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var cleared = 0
        f.repository.beforeLogout = { entered.complete(Unit); release.await() }
        val old = async { runCatching { f.repository.unlink { cleared++ } } }; entered.await()
        f.enqueue(me, bases, """{"open":true}""")
        f.repository.connectWith { _, _ -> json("""{"wallet":"$WALLET","entryPaid":false}""") }
        val newer = f.holder.current!!; release.complete(Unit)
        assertTrue(old.await().isFailure); assertEquals(0, cleared); assertSame(newer, f.holder.current)
        f.api.requireCurrentSession(newer.token); assertEquals(AccountPhase.SIGNED_IN, f.repository.state.value.phase)
        assertEquals(7, f.server.requestCount)
    } }
    @Test fun `notification cleanup from old logout cannot revoke a superseding login`() = Fixture().use { f -> runBlocking {
        f.seedCookie(); f.enqueue("""{"loginRequired":false}""", me, bases, """{"open":true}""")
        f.repository.restore()
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>()
        f.repository.beforeLogout = { entered.complete(Unit); release.await() }
        val oldLogout = async { runCatching { f.repository.logout {} } }
        entered.await()
        f.enqueue(me, bases, """{"open":true}""")
        f.repository.connectWith { _, _ -> json("""{"wallet":"$WALLET","entryPaid":false}""") }
        val newer = f.holder.current!!; release.complete(Unit)
        assertTrue(oldLogout.await().isFailure)
        assertSame(newer, f.holder.current); f.api.requireCurrentSession(newer.token)
        assertEquals(AccountPhase.SIGNED_IN, f.repository.state.value.phase)
        assertEquals("No logout request was sent for the new cookie", 7, f.server.requestCount)
    } }
    @Test fun `pending login and definitive session loss synchronously revoke notification consent`() = Fixture().use { f ->
        var revoked = 0; f.repository.beforeIdentityChange = { revoked++ }
        f.seedCookie(); f.enqueue("""{"loginRequired":true,"wallet":"$WALLET"}""")
        runBlocking { f.repository.restore() }; assertEquals(1, revoked)
        f.enqueue("""{"wallet":"$WALLET","entryPaid":false}""", me, bases, """{"open":true}""")
        runBlocking { f.repository.verifyTotp("123456") }
        assertEquals(AccountPhase.SIGNED_IN, f.repository.state.value.phase)
        f.repository.discardSession(f.holder.current!!, ApiException(401, null, "expired"))
        assertEquals(2, revoked)
    }
    private class Fixture : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        private val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        val cookies = MemoryStore()
        val api = GameApi.withTransport(server.url("/").toString(), SessionCookieJar(server.url("/"), cookies), "account-test", transport)
        val holder = testHolder()
        val selection = MemoryStore()
        val sessions = mutableListOf<AccountSession>()
        val repository = LiveAccountRepository(api, server.url("/").toString().trimEnd('/'), holder, selection, ApiRouting()) { sessions += it }
        fun enqueue(vararg bodies: String) = bodies.forEach { server.enqueue(MockResponse().setBody(it)) }
        fun seedCookie() = SessionCookieJar(server.url("/"), cookies).saveFromResponse(server.url("/"), listOf(okhttp3.Cookie.parse(server.url("/"), "shardkeep_session=abc; Secure; HttpOnly; Path=/; Max-Age=3600")!!))
        override fun close() { server.shutdown(); transport.connectionPool.evictAll(); transport.dispatcher.executorService.shutdown() }
    }
    private val me = """{"wallet":"$WALLET","name":"","keepLevel":1,"entryPaid":false,"seeker":{"linked":false}}"""
    private val bases = """{"enabled":true,"worldId":"fantasy-v1","maxActive":5,"nextLandPurchaseKind":"entry","bases":[{"id":"$BASE_ID","status":"active","keepLevel":1,"slot":1}]}"""

    @Test fun `restore reads login status then identity directory and playtest access and installs the session`() = Fixture().use { f ->
        f.seedCookie()
        f.enqueue("""{"loginRequired":false}""", me, bases, """{"open":true,"playUrl":"https://play"}""")
        runBlocking { f.repository.restore() }
        val state = f.repository.state.value
        assertEquals(AccountPhase.SIGNED_IN, state.phase); assertEquals(WALLET, state.wallet); assertEquals(BASE_ID, state.selectedBaseId)
        assertTrue(state.directory!!.fantasy); assertTrue(state.playtest!!.open); assertFalse(state.landOwned)
        assertEquals(listOf("/api/auth/login/status", "/api/me", "/api/bases", "/api/playtest/access"), (1..4).map { f.server.takeRequest().path })
        assertSame(state.session, f.holder.current); assertEquals(listOf(state.session), f.sessions)
        assertTrue("Selection persisted per wallet", f.selection.value!!.contains(BASE_ID))
    }
    @Test fun `login protection routes to the TOTP gate without installing a session`() = Fixture().use { f ->
        f.seedCookie(); f.enqueue("""{"loginRequired":true,"wallet":"$WALLET"}""")
        runBlocking { f.repository.restore() }
        assertEquals(AccountPhase.TOTP, f.repository.state.value.phase); assertEquals(WALLET, f.repository.state.value.pendingWallet)
        assertNull(f.holder.current); assertTrue(f.sessions.isEmpty())
        f.enqueue("""{"wallet":"$WALLET","entryPaid":false}""", me, bases, """{"open":true}""")
        runBlocking { f.repository.verifyTotp("123456") }
        assertEquals(AccountPhase.SIGNED_IN, f.repository.state.value.phase)
        runBlocking { f.repository.verifyTotp("12") }
        assertEquals("A malformed code never reaches the server; the failure is shown in place", "Enter the 6-digit authenticator code", f.repository.state.value.error)
        assertEquals(AccountPhase.SIGNED_IN, f.repository.state.value.phase)
    }
    @Test fun `a rejected restore signs out locally and quietly and forgets the rejected cookies`() = Fixture().use { f ->
        f.seedCookie(); f.server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"SESSION_EXPIRED","message":"Sign in again"}}"""))
        runBlocking { f.repository.restore() }
        assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase)
        assertNull("A 401 on a cold restore means not signed in; the title shows no error (web: 401 => title)", f.repository.state.value.error)
        assertNull("Rejected credentials are gone", f.cookies.value)
        // A 401 met later, with an account already shown, is surfaced.
        f.seedCookie(); f.enqueue("""{"loginRequired":false}""", me, bases, """{"open":true}""")
        runBlocking { f.repository.restore() }
        f.repository.discardSession(requireNotNull(f.holder.current), ApiException(401, "SESSION_EXPIRED", "Sign in again"))
        assertEquals("Sign in again", f.repository.state.value.error)
    }
    @Test fun `a restore without any saved session lands on the title with the failure visible`() = Fixture().use { f ->
        f.server.enqueue(MockResponse().setResponseCode(500).setBody("""{"error":"boom"}"""))
        runBlocking { f.repository.restore() }
        assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase); assertNotNull(f.repository.state.value.error)
    }
    @Test fun `activating a deed posts the replacement choice and re-reads fresh ownership afterwards`() = Fixture().use { f ->
        f.seedCookie(); f.enqueue("""{"loginRequired":false}""", me, bases, """{"open":true}""")
        runBlocking { f.repository.restore() }
        val inactive = "11111111-1111-4111-8111-111111111111"
        f.enqueue("""{"baseId":"$inactive","slot":1}""", """{"enabled":true,"worldId":"fantasy-v1","maxActive":5,"nextLandPurchaseKind":"deed","capabilities":{"baseScopedReads":true,"baseScopedMutations":true,"cellReservations":true},"bases":[{"id":"$inactive","status":"active","keepLevel":2,"slot":1},{"id":"$BASE_ID","status":"inactive","keepLevel":1,"slot":null}]}""")
        runBlocking { f.repository.activateBase(inactive, BASE_ID) }
        repeat(4) { f.server.takeRequest() }
        val activate = f.server.takeRequest()
        assertEquals("/api/bases/$inactive/activate", activate.path); assertEquals("""{"replaceBaseId":"$BASE_ID"}""", activate.body.readUtf8())
        assertEquals("/api/bases", f.server.takeRequest().path)
        val state = f.repository.state.value
        assertTrue(state.directory!!.stableMutations); assertEquals("The displaced deed is no longer selectable; the fresh directory decides", inactive, state.selectedBaseId)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.activateBase("not-a-base", null) } }
        Unit
    }
    @Test fun `base selection generation invalidates A to B to A consent even when final base matches`() = Fixture().use { f ->
        val other = "11111111-1111-4111-8111-111111111111"
        val directory = """{"enabled":true,"bases":[{"id":"$BASE_ID","status":"active","slot":1},{"id":"$other","status":"active","slot":2}]}"""
        f.seedCookie(); f.enqueue("""{"loginRequired":false}""", me, directory, """{"open":true}""")
        runBlocking { f.repository.restore(); f.repository.selectBase(BASE_ID) }
        val initial = f.repository.state.value.baseSelectionGeneration
        runBlocking { f.repository.selectBase(other); f.repository.selectBase(BASE_ID) }
        assertEquals(BASE_ID, f.repository.state.value.selectedBaseId)
        assertEquals(initial + 2, f.repository.state.value.baseSelectionGeneration)
    }
    @Test fun `base selection is validated against the directory and discard only affects the current session`() = Fixture().use { f ->
        f.seedCookie(); f.enqueue("""{"loginRequired":false}""", me, bases, """{"open":true}""")
        runBlocking { f.repository.restore() }
        val session = requireNotNull(f.holder.current)
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.selectBase("missing") } }
        runBlocking { f.repository.selectBase(BASE_ID) }
        val stale = AccountSession(WALLET, session.origin, session.token)
        f.repository.discardSession(stale, null)
        assertEquals("A stale session cannot sign the current one out", AccountPhase.SIGNED_IN, f.repository.state.value.phase)
        f.repository.discardSession(session, ApiException(401, "SESSION_EXPIRED", "Expired"))
        assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase); assertNull(f.holder.current)
    }
    @Test fun `security completion ends a pending cookie and preserves its notice after local credential release`() = Fixture().use { f ->
        f.seedCookie(); f.enqueue("""{"loginRequired":true,"wallet":"$WALLET"}""")
        runBlocking { f.repository.restore() }
        val access = SecurityAccess(f.repository.state.value, f.api.sessionToken(), { f.repository.state.value }, f.api::requireCurrentSession)
        f.server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"message":"Session revoked"}}"""))
        var released = 0
        runBlocking { f.repository.endSecuritySession(access, "Recovery completed. Sign in to set up a replacement.") { released++ } }
        assertEquals(1, released); assertNull(f.cookies.value); assertNull(f.holder.current)
        assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase)
        assertEquals("Recovery completed. Sign in to set up a replacement.", f.repository.state.value.error)
        assertEquals("/api/auth/login/status", f.server.takeRequest().path)
        assertEquals("/api/auth/logout", f.server.takeRequest().path)
    }
    @Test fun `stale security completion cannot end a newer cookie or release its wallet`() = Fixture().use { f ->
        f.seedCookie(); f.enqueue("""{"loginRequired":true,"wallet":"$WALLET"}""")
        runBlocking { f.repository.restore() }
        val access = SecurityAccess(f.repository.state.value, f.api.sessionToken(), { f.repository.state.value }, f.api::requireCurrentSession)
        f.api.beginAuthentication()
        var released = 0
        assertThrows(SessionSupersededException::class.java) { runBlocking { f.repository.endSecuritySession(access, "old") { released++ } } }
        assertEquals(0, released); assertEquals(1, f.server.requestCount); assertNotNull(f.cookies.value)
    }

    private val noSeeker = """{"linked":false,"seekerWallet":null,"sgtMint":null,"memberNumber":null,"skrDomain":null,"verifiedAt":null,"stale":false,"verificationSources":0,"unconfirmed":false}"""
    private fun Fixture.gated(admitted: Boolean = false, wallet: String = WALLET) {
        seedCookie(); enqueue("""{"loginRequired":false}""")
        server.enqueue(MockResponse().setResponseCode(403).setBody("""{"error":{"code":"ALPHA_GATED","message":"Closed playtest"}}"""))
        enqueue("""{"wallet":"$wallet","admitted":$admitted,"seeker":$noSeeker}""")
    }
    @Test fun `pre admission restore retains authenticated game wallet without a playable session`() = Fixture().use { f ->
        f.gated(); runBlocking { f.repository.restore() }
        val state = f.repository.state.value
        assertEquals(AccountPhase.ALPHA, state.phase); assertEquals(WALLET, state.admission!!.wallet)
        assertNull(state.identity); assertNull(f.holder.current); assertTrue(f.sessions.isEmpty())
        assertEquals(listOf("/api/auth/login/status", "/api/me", "/api/alpha/seeker"), (1..3).map { f.server.takeRequest().path })
    }
    @Test fun `server admission retries normal account bootstrap with the original wallet and cookie`() = Fixture().use { f ->
        f.gated(true); f.enqueue(me, bases, """{"open":true}""")
        runBlocking { f.repository.restore() }
        assertEquals(AccountPhase.SIGNED_IN, f.repository.state.value.phase); assertEquals(1, f.sessions.size)
        assertEquals(WALLET, f.holder.current!!.wallet); assertEquals(6, f.server.requestCount)
    }
    @Test fun `admission cannot replace authenticated wallet while opening gameplay`() = Fixture().use { f ->
        f.gated(); runBlocking { f.repository.restore() }; val pending = f.repository.state.value.admission!!
        f.enqueue(me.replace(WALLET, "6Ckm2BrnXxsSjyG5b17kQQRjoECVrts92RKXVGT8XeqS"))
        assertThrows(IllegalArgumentException::class.java) { runBlocking { f.repository.resumeAdmission(pending) } }
        assertEquals(AccountPhase.ALPHA, f.repository.state.value.phase); assertNull(f.holder.current)
        f.enqueue(me, bases, """{"open":true}"""); runBlocking { f.repository.resumeAdmission(pending) }
        assertEquals(WALLET, f.holder.current!!.wallet); assertSame(pending.token, f.holder.current!!.token)
    }
    @Test fun `stale admission cannot resume or sign out a newer cookie`() = Fixture().use { f ->
        f.gated(); runBlocking { f.repository.restore() }; val pending = f.repository.state.value.admission!!
        f.api.beginAuthentication()
        assertThrows(SessionSupersededException::class.java) { runBlocking { f.repository.resumeAdmission(pending) } }
        assertThrows(SessionSupersededException::class.java) { f.repository.discardAdmission(pending, ApiException(401,"expired","expired")) }
        assertEquals(3, f.server.requestCount); assertNotNull(f.cookies.value)
    }
    @Test fun `expired pending admission returns to sign in without retaining rejected cookies`() = Fixture().use { f ->
        f.gated(); runBlocking { f.repository.restore() }; val pending = f.repository.state.value.admission!!
        f.repository.discardAdmission(pending, ApiException(401,"expired","Sign in again"))
        assertEquals(AccountPhase.SIGNED_OUT, f.repository.state.value.phase); assertNull(f.cookies.value)
    }
    @Test fun `malformed admission identity cannot become a native account`() = Fixture().use { f ->
        f.gated(wallet="invalid"); runBlocking { f.repository.restore() }
        assertEquals(AccountPhase.SIGNED_OUT,f.repository.state.value.phase); assertNotNull(f.repository.state.value.error)
        assertNull(f.holder.current); assertTrue(f.sessions.isEmpty())
    }
}
