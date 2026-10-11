package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.GameApi
import gg.pixelkingdomwars.nativeclient.network.SessionToken
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** Social sign-in as the title screen sees it; [PrivySocialLogin] is the Privy-backed implementation. */
interface SocialLogin {
    /** Non-null while the embedded wallet waits for its Privy authenticator code. */
    val mfa: StateFlow<PrivyMfaRequest?>
    /** Non-null only while the SDK's browser round trip is open: the one moment the player has something
     * to finish in the browser, and the only step a process death or a destroyed screen can interrupt. */
    val handOff: StateFlow<SocialProvider?>
    suspend fun sendEmailCode(email: String)
    /** Privy login → the existing embedded wallet → the unchanged server challenge (client 'solana-mobile').
     * Returns the /auth/verify response: a full session or a pending-TOTP login. */
    suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject
    suspend fun submitMfaCode(request: PrivyMfaRequest, code: String)
    /** Transaction approval must pass its live guard through the provider's awaits. */
    suspend fun submitMfaCode(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit): Unit =
        throw SocialSignInException("Guarded wallet verification is unavailable in this build.")
    suspend fun securitySigner(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit): WalletSigner =
        throw SocialSignInException("Wallet confirmation is unavailable in this build.")
    suspend fun requireFreshMfa(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit): Unit =
        throw SocialSignInException("Fresh wallet verification is unavailable in this build.")
    suspend fun walletTotpEnrolled(wallet: String, session: SessionToken, guard: () -> Unit): Boolean =
        throw SocialSignInException("Wallet authenticator setup is unavailable.")
    suspend fun beginWalletTotp(wallet: String, session: SessionToken, guard: () -> Unit): PrivyTotpSetup =
        throw SocialSignInException("Wallet authenticator setup is unavailable.")
    suspend fun finishWalletTotp(setup: PrivyTotpSetup, session: SessionToken, code: String, guard: () -> Unit): Unit =
        throw SocialSignInException("Wallet authenticator setup is unavailable.")
    fun cancelMfa()
    suspend fun logout()
}

/** Production has social token login off, so a social account signs the same wallet challenge as
 * MWA with its existing Privy embedded wallet (web: apps/web/src/auth/useSocialAuth.ts, the SIWS
 * effect that runs while `socialTokenLogin` is false). */
class PrivySocialLogin internal constructor(
    private val surface: PrivySurface,
    private val challengeLogin: (SessionToken) -> WalletChallengeLogin,
    private val requireCurrentSession: (SessionToken) -> Unit,
    private val marker: SocialLoginMarker,
    private val binding: SocialBinding,
    private val appUrlScheme: String,
) : SocialLogin {
    constructor(surface: PrivySurface, api: GameApi, marker: SocialLoginMarker, binding: SocialBinding, appUrlScheme: String) :
        this(surface, { session -> WalletChallengeLogin(api, session) }, api::requireCurrentSession, marker, binding, appUrlScheme)

    override val mfa: StateFlow<PrivyMfaRequest?> get() = surface.mfa
    private val _handOff = MutableStateFlow<SocialProvider?>(null)
    override val handOff: StateFlow<SocialProvider?> = _handOff.asStateFlow()

    override suspend fun sendEmailCode(email: String) {
        val address = email.trim()
        require(address.contains('@') && address.length >= 3) { "Enter the email address of your account" }
        // The code belongs to the address the player typed, never to a session left on the device.
        endRestoredIdentity(surface.restore())
        surface.sendEmailCode(address)
    }

    override suspend fun signIn(method: SocialLoginMethod, session: SessionToken, requireCurrentIdentity: () -> Unit): JsonObject {
        val context = currentCoroutineContext()
        fun guard() { context.ensureActive(); requireCurrentSession(session); requireCurrentIdentity() }
        guard()
        val verified = authenticate(method)
        guard()
        val wallet = try { selectExistingWallet(binding.walletOf(verified.userId), verified.wallets) }
        catch (refused: SocialSignInException) {
            // A refused account is signed out of Privy: the next tap would otherwise restore and refuse the
            // same account, with no way to try another. (The web never refuses; it creates the wallet.)
            try { surface.logout() } catch (error: CancellationException) { throw error } catch (_: Exception) {}
            throw refused
        }
        val signer = surface.signer(wallet, ::guard)
        val result = challengeLogin(session).signIn(signer, ::guard)
        guard()
        // The server confirmed this wallet for this Privy user; later sign-ins select the same one.
        binding.remember(verified.userId, wallet)
        return result
    }

    /** Google / X reuse any verified restored Privy session, whichever provider created it (web
     * apps/web/src/auth/useSocialAuth.ts: `setPhase(authenticated ? 'wallet' : 'login')` — Privy's login()
     * is a no-op while authenticated, so the tap proceeds to SIWS with the existing account). Unverified
     * persisted credentials are signed out first. The email code always signs in the typed address:
     * [sendEmailCode] ended any restored identity when the code was requested. */
    private suspend fun authenticate(method: SocialLoginMethod): PrivySessionState.Verified {
        val restored = surface.restore()
        if (restored is PrivySessionState.Verified && method !is SocialLoginMethod.Email) return restored
        endRestoredIdentity(restored)
        return when (method) {
            SocialLoginMethod.Google, SocialLoginMethod.X -> browserHandOff(method.provider)
            is SocialLoginMethod.Email -> surface.loginWithEmailCode(method.email, method.code)
        }
    }

    /** The only step a process death or a destroyed screen can cut short. The marker is on disk before the
     * browser opens and leaves with the SDK's answer — a session, a failure or a closed tab; a cancelled
     * coroutine keeps it, so the next title screen explains the interruption (web:
     * apps/web/src/auth/socialLoginIntent.ts, consumed by useSocialAuth.ts once the redirect lands in a
     * fresh document). */
    private suspend fun browserHandOff(provider: SocialProvider): PrivySessionState.Verified {
        marker.set(provider)
        _handOff.value = provider
        try {
            return surface.loginWithOAuth(provider, appUrlScheme).also { clearMarker() }
        } catch (error: CancellationException) { throw error }
        catch (error: Exception) { clearMarker(); throw error }
        finally { _handOff.value = null }
    }
    private suspend fun clearMarker() { withContext(NonCancellable) { runCatching { marker.clear() } } }
    private suspend fun endRestoredIdentity(state: PrivySessionState) {
        if (state is PrivySessionState.Verified || state == PrivySessionState.Unverified) surface.logout()
    }

    override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String) = surface.submitTotp(request, code) {}
    override suspend fun submitMfaCode(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) =
        surface.submitTotp(request, code, requireCurrentIdentity)
    override suspend fun securitySigner(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit): WalletSigner {
        val context = currentCoroutineContext()
        fun guard() { context.ensureActive(); requireCurrentSession(session); requireCurrentIdentity() }
        guard()
        val user = surface.restore() as? PrivySessionState.Verified
            ?: throw SocialSignInException("Reconnect the existing game wallet before confirming this action.")
        guard()
        check(binding.walletOf(user.userId) == wallet && wallet in user.wallets) { "Confirm with the existing wallet that owns this account." }
        guard()
        return surface.signer(wallet, ::guard)
    }
    override suspend fun requireFreshMfa(wallet: String, session: SessionToken, requireCurrentIdentity: () -> Unit) {
        // Verify the restored provider account and remembered wallet before even presenting its factor.
        securitySigner(wallet, session, requireCurrentIdentity)
        surface.requireFreshTotp(wallet) { requireCurrentSession(session); requireCurrentIdentity() }
        requireCurrentSession(session); requireCurrentIdentity()
    }
    override suspend fun walletTotpEnrolled(wallet: String, session: SessionToken, guard: () -> Unit): Boolean {
        securitySigner(wallet, session, guard)
        return surface.totpEnrolled(wallet) { requireCurrentSession(session); guard() }.also { requireCurrentSession(session); guard() }
    }
    override suspend fun beginWalletTotp(wallet: String, session: SessionToken, guard: () -> Unit): PrivyTotpSetup {
        securitySigner(wallet, session, guard)
        return surface.beginTotpEnrollment(wallet) { requireCurrentSession(session); guard() }.also { requireCurrentSession(session); guard() }
    }
    override suspend fun finishWalletTotp(setup: PrivyTotpSetup, session: SessionToken, code: String, guard: () -> Unit) {
        securitySigner(setup.wallet, session, guard)
        surface.finishTotpEnrollment(setup, code) { requireCurrentSession(session); guard() }
        requireCurrentSession(session); guard()
    }
    override fun cancelMfa() = surface.cancelMfa()
    override suspend fun logout() = surface.logout()
}

/** After the server session is released: the wallet-app authorization is forgotten and the Privy session
 * ends (web apps/web/src/auth/useSignOut.ts: server logout, then Privy logout, so another account can
 * sign in on a shared device). Privy is started for it only when a social sign-in bound a wallet on this
 * device: the wallet signing out or, when that wallet is unknown because the server refused the account
 * before a session was installed (the alpha gate), any bound wallet. A wallet-app account never starts
 * the SDK. */
class LocalCredentialRelease(private val binding: SocialBinding, private val social: () -> SocialLogin?) {
    suspend fun release(clearWalletApp: () -> Unit, wallet: String?) {
        clearWalletApp()
        if (if (wallet == null) binding.hasBinding() else binding.isBound(wallet)) social()?.logout()
    }
}
