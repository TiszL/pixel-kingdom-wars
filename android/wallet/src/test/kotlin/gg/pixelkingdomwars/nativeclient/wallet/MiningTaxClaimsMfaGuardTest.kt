package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.*
import org.junit.Test

/** Exercises the production social bridge with a suspending SDK surface. */
class MiningTaxClaimsMfaGuardTest {
    private class Memory : SecretStore {
        override fun read(): String? = null
        override fun write(value: String) = Unit
        override fun clear() = Unit
    }
    private class Surface(private val stage: Int) : PrivySurface {
        val request = PrivyMfaRequest("fixture-user", setOf("totp"))
        override val mfa = MutableStateFlow<PrivyMfaRequest?>(request)
        val entered = CompletableDeferred<Unit>(); val release = CompletableDeferred<Unit>(); var resumed = false
        override suspend fun submitTotp(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) {
            requireCurrentIdentity()
            // The real SDK suspends both for TOTP submission and verifiedUser().
            for (boundary in 0..1) { if (boundary == stage) { entered.complete(Unit); release.await() }; requireCurrentIdentity() }
            mfa.value = null; resumed = true
        }
        override suspend fun restore(): PrivySessionState = error("unused")
        override suspend fun loginWithOAuth(provider: SocialProvider, appUrlScheme: String): PrivySessionState.Verified = error("unused")
        override suspend fun sendEmailCode(email: String): Unit = error("unused")
        override suspend fun loginWithEmailCode(email: String, code: String): PrivySessionState.Verified = error("unused")
        override suspend fun signer(expectedWallet: String, requireCurrentIdentity: () -> Unit): WalletSigner = error("unused")
        override fun cancelMfa() = Unit
        override suspend fun logout() = Unit
    }
    @Test fun `production MFA bridge carries the live guard through verification and final identity awaits`() = runBlocking {
        for (stage in 0..1) {
            val surface = Surface(stage); var current = true
            val login = PrivySocialLogin(surface, { error("unused") }, {}, SocialLoginMarker(Memory(), Dispatchers.Unconfined), SocialBinding(Memory(), Dispatchers.Unconfined), "fixture")
            val result = async { runCatching { login.submitMfaCode(surface.request, "123456") { check(current) { "obsolete claim admission" } } } }
            surface.entered.await(); current = false; surface.release.complete(Unit)
            assertTrue(result.await().isFailure); assertFalse(surface.resumed); assertSame(surface.request, surface.mfa.value)
        }
    }
}
