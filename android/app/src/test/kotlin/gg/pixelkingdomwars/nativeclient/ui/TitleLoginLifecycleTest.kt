package gg.pixelkingdomwars.nativeclient.ui

import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewModelScope
import gg.pixelkingdomwars.nativeclient.*
import gg.pixelkingdomwars.nativeclient.data.*
import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.ui.boot.BootDestination
import gg.pixelkingdomwars.nativeclient.ui.boot.bootDestination
import gg.pixelkingdomwars.nativeclient.ui.title.EmailStep
import gg.pixelkingdomwars.nativeclient.ui.title.TitleViewModel
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.*
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/** The real repository publishes busy before either signer yields. Mirror the shell's route-owned
 * ViewModel disposal so an accidental trip back to Boot cancels the attempt, just as on the phone. */
@OptIn(ExperimentalCoroutinesApi::class)
class TitleLoginLifecycleTest {
    @After fun reset() { Dispatchers.resetMain() }

    @Test fun `email approval survives repository busy and hydrates the existing account once`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        Fixture().use { f ->
            f.signedOut()
            val shell = title(f)
            shell.model.continueWith(SocialProvider.EMAIL)
            shell.model.sendEmailCode("player@example.com")?.join()
            shell.model.verifyEmailCode("123456")
            runCurrent()
            shell.assertAwaitingApproval()
            assertEquals(EmailStep.CODE, shell.model.social.value.emailStep)
            shell.model.verifyEmailCode("123456")
            runCurrent()
            assertEquals("Repeated taps cannot create another sign-in", 1, f.social.attempts)
            f.enqueue(
                """{"wallet":"$WALLET","name":"Existing player","keepLevel":1,"entryPaid":false,"seeker":{"linked":false}}""",
                """{"enabled":true,"worldId":"fantasy-v1","maxActive":5,"bases":[{"id":"$BASE_ID","status":"active","keepLevel":1,"slot":1}]}""",
                """{"open":true}""",
            )
            f.social.approval.complete(Unit)
            f.repository.state.first { it.phase == AccountPhase.SIGNED_IN && !it.busy }
            runCurrent()
            assertEquals(WALLET, f.holder.current!!.wallet)
            assertEquals(BASE_ID, f.repository.state.value.selectedBaseId)
            assertEquals(listOf(BootDestination.TITLE, BootDestination.HOME), shell.destinations)
            assertEquals("Exactly one hydrated account is installed", 1, f.sessions)
            assertEquals(listOf("/api/auth/login/status", "/api/me", "/api/bases", "/api/playtest/access"),
                List(4) { f.server.takeRequest().path })
        }
    }

    @Test fun `Privy MFA stays reachable until approval then the server TOTP gate takes over`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        Fixture().use { f ->
            f.signedOut()
            f.social.needsMfa = true
            f.social.result = json("""{"wallet":"$WALLET","loginRequired":true}""")
            val shell = title(f)
            shell.model.continueWith(SocialProvider.GOOGLE)
            runCurrent()
            shell.assertAwaitingApproval()
            assertNotNull("Wallet MFA must remain on the screen that owns its sign-in", shell.model.social.value.mfa)
            shell.model.submitPrivyMfa("123456")
            f.repository.state.first { it.phase == AccountPhase.TOTP && !it.busy }
            runCurrent()
            assertEquals(listOf(BootDestination.TITLE, BootDestination.TOTP), shell.destinations)
            assertEquals(WALLET, f.repository.state.value.pendingWallet)
            assertNull("A pending login is not a gameplay session", f.holder.current)
            assertEquals("No account hydration before the server's authenticator is verified", 1, f.server.requestCount)
        }
    }

    @Test fun `rejected email approval leaves the same code entry and retry action alive`() = runTest {
        Dispatchers.setMain(StandardTestDispatcher(testScheduler))
        Fixture().use { f ->
            f.signedOut()
            val shell = title(f)
            shell.model.continueWith(SocialProvider.EMAIL)
            shell.model.sendEmailCode("player@example.com")?.join()
            shell.model.verifyEmailCode("000000")
            runCurrent()
            shell.assertAwaitingApproval()
            f.social.approval.completeExceptionally(SocialSignInException("The code was not accepted. Request a new code and try again."))
            shell.model.busy.first { !it }
            runCurrent()
            assertEquals(listOf(BootDestination.TITLE), shell.destinations)
            assertEquals(EmailStep.CODE, shell.model.social.value.emailStep)
            assertTrue(f.repository.state.value.error!!.contains("not accepted"))
            assertNull(f.holder.current)
            shell.model.changeEmail()
            assertEquals("A refusal releases the action slot without recreating the title", EmailStep.ADDRESS, shell.model.social.value.emailStep)
        }
    }

    private fun TestScope.title(f: Fixture): TitleEntry {
        val model = TitleViewModel(f.repository, true, { f.social }, null) { _, _ -> }
        val store = ViewModelStore().apply { put("title", model) }
        val destinations = mutableListOf<BootDestination>()
        backgroundScope.launch(UnconfinedTestDispatcher(testScheduler)) {
            try {
                f.repository.state.map { bootDestination(LaunchMode.ACCOUNT, true, null, it.phase, it.busy) }
                    .distinctUntilChanged().collect { destination ->
                        destinations += destination
                        // PkwApp navigates with inclusive popUpTo(0): the old entry's ViewModels are cleared.
                        if (destination != BootDestination.TITLE) store.clear()
                    }
            } finally { store.clear() }
        }
        return TitleEntry(model, destinations)
    }

    private class TitleEntry(val model: TitleViewModel, val destinations: List<BootDestination>) {
        fun assertAwaitingApproval() {
            assertEquals("Signing in must not navigate away and cancel the title's coroutine", listOf(BootDestination.TITLE), destinations)
            assertTrue(model.viewModelScope.coroutineContext[Job]!!.isActive)
            assertTrue("Keep the title's duplicate-submit protection active", model.busy.value)
            assertTrue("Exercise the real repository busy transition, absent from the older fake", model.account.value.busy)
        }
    }

    private class ControlledSocialLogin : SocialLogin {
        override val mfa = MutableStateFlow<PrivyMfaRequest?>(null)
        override val handOff = MutableStateFlow<SocialProvider?>(null)
        val approval = CompletableDeferred<Unit>()
        var attempts = 0
        var needsMfa = false
        var result: JsonObject = json("""{"wallet":"$WALLET","entryPaid":false}""")
        override suspend fun sendEmailCode(email: String) {}
        override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject {
            attempts++
            requireCurrentIdentity()
            if (needsMfa) mfa.value = PrivyMfaRequest("test-user", setOf("totp"))
            try { approval.await(); requireCurrentIdentity(); return result }
            finally { mfa.value = null }
        }
        override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) {
            check(mfa.value === request)
            approval.complete(Unit)
        }
        override fun cancelMfa() { approval.cancel() }
        override suspend fun logout() {}
    }

    private class Fixture : AutoCloseable {
        private val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val tls = HandshakeCertificates.Builder().heldCertificate(cert).build()
        private val trust = HandshakeCertificates.Builder().addTrustedCertificate(cert.certificate).build()
        val server = MockWebServer().apply { useHttps(tls.sslSocketFactory(), false); start() }
        private val transport = OkHttpClient.Builder().sslSocketFactory(trust.sslSocketFactory(), trust.trustManager).build()
        private val api = GameApi.withTransport(server.url("/").toString(), SessionCookieJar(server.url("/"), MemoryStore()), "title-lifecycle-test", transport)
        val holder = testHolder()
        var sessions = 0
        val repository = LiveAccountRepository(api, server.url("/").toString().trimEnd('/'), holder, MemoryStore(), ApiRouting()) { sessions++ }
        val social = ControlledSocialLogin()
        suspend fun signedOut() {
            server.enqueue(MockResponse().setResponseCode(401).setBody("""{"error":{"code":"SESSION_EXPIRED","message":"Sign in again"}}"""))
            repository.restore()
            assertEquals(AccountPhase.SIGNED_OUT, repository.state.value.phase)
        }
        fun enqueue(vararg bodies: String) = bodies.forEach { server.enqueue(MockResponse().setBody(it)) }
        override fun close() {
            holder.replace(null)
            server.shutdown()
            transport.connectionPool.evictAll()
            transport.dispatcher.executorService.shutdown()
        }
    }
}
