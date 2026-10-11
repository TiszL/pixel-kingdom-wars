package gg.pixelkingdomwars.nativeclient.wallet

import android.content.Context
import android.os.Looper
import io.privy.auth.AuthState
import io.privy.auth.AuthenticationException
import io.privy.auth.MfaMethod
import io.privy.auth.PrivyUser
import io.privy.auth.mfa.MfaConfig
import io.privy.auth.mfa.MfaListener
import io.privy.auth.oAuth.OAuthProvider
import io.privy.logging.PrivyLogLevel
import io.privy.sdk.Privy
import io.privy.sdk.PrivyConfig
import java.io.IOException
import java.util.Base64
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** Public identifiers only. Missing configuration cannot initialize a different app. */
data class PrivyPublicConfig(val appId: String, val appClientId: String) {
    init { require(appId.isNotBlank() && appClientId.isNotBlank()) }
    companion object {
        fun from(appId: String?, appClientId: String?): PrivyPublicConfig? =
            if(appId.isNullOrBlank() || appClientId.isNullOrBlank()) null
            else PrivyPublicConfig(appId,appClientId)
    }
}
sealed interface PrivySessionState {
    data object NotReady : PrivySessionState
    data object Unverified : PrivySessionState
    data object SignedOut : PrivySessionState
    /** A restored verified session is reused by every social tap, whichever provider created it (web rule). */
    data class Verified(val userId: String, val wallets: List<String>) : PrivySessionState
}
class PrivyMfaRequest(val userId: String, val methods: Set<String>, val fresh: Boolean = false)

/** The one Privy SDK instance. Login is limited to the web's social options; there is no wallet
 * creation, migration or broadcasting. App session approval stays the caller's responsibility. */
class PrivyWalletAdapter private constructor(context: Context, private val config: PrivyPublicConfig) : PrivySurface {
    private val scope = CoroutineScope(SupervisorJob()+Dispatchers.Main.immediate)
    private val signing = SigningQueue(Dispatchers.Main.immediate)
    private val pendingMfa = MutableStateFlow<PrivyMfaRequest?>(null)
    private class FreshVerification(val request: PrivyMfaRequest, val guard: () -> Unit, val done: CompletableDeferred<Unit>)
    private var freshVerification: FreshVerification? = null
    override val mfa: StateFlow<PrivyMfaRequest?> = pendingMfa.asStateFlow()
    private val sdk = Privy.init(context.applicationContext,PrivyConfig(
        appId=config.appId,appClientId=config.appClientId,logLevel=PrivyLogLevel.NONE,
        disableAutomaticMigration=true,
        mfaConfig=MfaConfig(listener=object : MfaListener {
            override fun onMfaRequired(user: PrivyUser) {
                pendingMfa.value=PrivyMfaRequest(user.id,user.mfaMethods.map { when(it) {
                    is MfaMethod.Totp -> "totp"; is MfaMethod.Sms -> "sms"; is MfaMethod.Passkey -> "passkey"
                } }.toSet())
            }
        })
    ))
    val session: StateFlow<PrivySessionState> = sdk.authState.map(::sessionState)
        .stateIn(scope,SharingStarted.Eagerly,PrivySessionState.NotReady)

    override suspend fun restore(): PrivySessionState = sessionState(sdk.getAuthState())

    /** The SDK owns the browser round trip: PrivyRedirectActivity (manifest, [appUrlScheme]) receives the
     * callback and resumes this call; a closed tab resumes it with the SDK's cancellation. */
    override suspend fun loginWithOAuth(provider: SocialProvider, appUrlScheme: String): PrivySessionState.Verified = withContext(Dispatchers.Main.immediate) {
        val oauth=when(provider) {
            SocialProvider.GOOGLE -> OAuthProvider.Google
            SocialProvider.X -> OAuthProvider.Twitter
            SocialProvider.EMAIL -> throw IllegalArgumentException("Email signs in with a one-time code")
        }
        require(appUrlScheme.isNotBlank() && "://" !in appUrlScheme) { "The OAuth callback is a bare scheme" }
        // The dashboard registers the callback as "<scheme>://"; hand the SDK that exact redirect URI. (0.14.0's
        // RealLoginWithOAuth appends "://" itself only when the argument lacks one; being explicit removes the guess.)
        verified(sdk.oAuth.login(oauth,"$appUrlScheme://").loginValue("Unable to complete social sign-in. Please try again."))
    }
    override suspend fun sendEmailCode(email: String) { withContext(Dispatchers.Main.immediate) {
        sdk.email.sendCode(email).loginValue("Unable to send a sign-in code to that address. Check it and try again.")
    } }
    override suspend fun loginWithEmailCode(email: String, code: String): PrivySessionState.Verified = withContext(Dispatchers.Main.immediate) {
        require(code.matches(Regex("[0-9]{6}"))) { "Enter the 6-digit code from your email" }
        verified(sdk.email.loginWithCode(code,email).loginValue("The code was not accepted. Request a new code and try again."))
    }

    /** Bind to the server-selected wallet; never substitute the first available wallet. */
    override suspend fun signer(expectedWallet: String, requireCurrentIdentity: () -> Unit): PrivyExistingSigner {
        requireCurrentIdentity()
        val user=verifiedUser()
        existingWallet(user,expectedWallet)
        requireCurrentIdentity()
        return PrivyExistingSigner(this,user.id,expectedWallet,requireCurrentIdentity)
    }

    /** SDK 0.14's public verify.submit always calls TotpMfaRepository.verify(code, accessToken),
     * even with a cached MFA token. We explicitly await that NEW provider verification before signing;
     * on failure its implementation deletes the cached token. No SDK internal API/reflection is used. */
    override suspend fun requireFreshTotp(expectedWallet: String, requireCurrentIdentity: () -> Unit) = withContext<Unit>(Dispatchers.Main.immediate) {
        requireCurrentIdentity()
        val user = verifiedUser(); existingWallet(user, expectedWallet)
        check(user.mfaMethods.any { it is MfaMethod.Totp }) { "Set up your Privy wallet authenticator in Account Security before recovering this account." }
        check(pendingMfa.value == null && freshVerification == null) { "Finish the existing wallet verification first." }
        val request = PrivyMfaRequest(user.id, setOf("totp"), fresh = true)
        val pending = FreshVerification(request, requireCurrentIdentity, CompletableDeferred())
        freshVerification = pending; pendingMfa.value = request
        try {
            pending.done.await(); requireCurrentIdentity()
            check(verifiedUser().id == user.id); existingWallet(verifiedUser(), expectedWallet)
        } finally {
            if (freshVerification === pending) freshVerification = null
            if (pendingMfa.value === request) pendingMfa.value = null
        }
    }

    override suspend fun totpEnrolled(wallet: String, guard: () -> Unit): Boolean = withContext(Dispatchers.Main.immediate) {
        guard(); val user = verifiedUser(); existingWallet(user, wallet)
        user.refresh().safeValue(); guard()
        val refreshed = verifiedUser(); check(refreshed.id == user.id); existingWallet(refreshed, wallet)
        refreshed.mfaMethods.any { it is MfaMethod.Totp }
    }
    override suspend fun beginTotpEnrollment(wallet: String, guard: () -> Unit): PrivyTotpSetup = withContext(Dispatchers.Main.immediate) {
        guard(); val user = verifiedUser(); existingWallet(user, wallet)
        check(!user.mfaMethods.any { it is MfaMethod.Totp }) { "Your wallet authenticator is already enrolled. Refresh its status." }
        check(pendingMfa.value == null) { "Finish the existing wallet verification first." }
        val setup = user.mfa.totp.enroll.generateSecret().safeValue(); guard()
        check(verifiedUser().id == user.id); existingWallet(verifiedUser(), wallet)
        PrivyTotpSetup(wallet, user.id, setup.secret)
    }
    override suspend fun finishTotpEnrollment(setup: PrivyTotpSetup, code: String, guard: () -> Unit): Unit = withContext(Dispatchers.Main.immediate) {
        require(code.matches(Regex("[0-9]{6}"))); guard()
        val user = verifiedUser(); check(user.id == setup.userId); existingWallet(user, setup.wallet)
        val updated = user.mfa.totp.enroll.submit(code).safeValue(); guard()
        check(updated.id == setup.userId && verifiedUser().id == setup.userId)
        existingWallet(updated, setup.wallet)
        check(updated.mfaMethods.any { it is MfaMethod.Totp }) { "Refresh wallet security to confirm enrollment." }
    }

    override suspend fun submitTotp(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit) = withContext<Unit>(Dispatchers.Main.immediate) {
        require(code.matches(Regex("[0-9]{6}")))
        check(pendingMfa.value===request) { "This wallet verification request is no longer pending" }
        require("totp" in request.methods)
        requireCurrentIdentity()
        val fresh = freshVerification?.takeIf { it.request === request }
        check(!request.fresh || fresh != null) { "This fresh wallet verification is no longer pending" }
        fresh?.guard?.invoke()
        val user=verifiedUser(); check(user.id==request.userId)
        requireCurrentIdentity()
        fresh?.guard?.invoke()
        user.mfa.totp.verify.submit(code).safeValue()
        requireCurrentIdentity()
        fresh?.guard?.invoke()
        check(verifiedUser().id==request.userId && pendingMfa.value===request)
        requireCurrentIdentity()
        fresh?.guard?.invoke()
        pendingMfa.value=null
        if (fresh != null) fresh.done.complete(Unit) else sdk.mfa.resumeBlockedActions()
    }
    override fun cancelMfa() {
        scope.launch { cancelPendingMfa() }
    }
    private fun cancelPendingMfa() {
        if(pendingMfa.value==null) return
        val fresh = freshVerification?.takeIf { it.request === pendingMfa.value }
        pendingMfa.value=null
        if (fresh != null) fresh.done.cancel(CancellationException("Wallet verification cancelled"))
        else sdk.mfa.resumeBlockedActions(mfaError=CancellationException("Wallet verification cancelled"))
    }
    override suspend fun logout() = withContext(Dispatchers.Main.immediate) { cancelPendingMfa(); sdk.logout() }

    internal suspend fun sign(userId: String, wallet: String, bytes: ByteArray, transaction: Boolean, guard: () -> Unit,
        onSigned: ((ByteArray) -> Unit)? = null): ByteArray = signing.run(bytes,::cancelPendingMfa) { input ->
        guard()
        val user=verifiedUser(); check(user.id==userId) { "The wallet account changed" }
        val provider=existingWallet(user,wallet).provider
        if(transaction) validateTransactionSigner(input,wallet)
        guard()
        try {
            val encoded=if(transaction) provider.signTransaction(input.copyOf()).safeValue() else provider.signMessage(input.copyOf()).safeValue()
            if (onSigned != null) {
                check(transaction)
                val evidence = try { Base64.getDecoder().decode(encoded) } catch (_: IllegalArgumentException) { throw IOException("Wallet returned an invalid signature") }
                paymentTransactionSignature(input, evidence, wallet)
                semanticPaymentSignature(input, evidence, wallet)
                onSigned(evidence.copyOf())
            }
            guard()
            val after=verifiedUser(); check(after.id==userId); existingWallet(after,wallet)
            guard()
            val signed=try { Base64.getDecoder().decode(encoded) } catch(_: IllegalArgumentException) { throw IOException("Wallet returned an invalid signature") }
            if(transaction) validateSignedTransaction(input,signed,wallet) else check(signed.size==64) { "Wallet returned an invalid signature" }
            signed
        } catch(e: CancellationException) { cancelPendingMfa(); throw e }
        finally { pendingMfa.value=null }
    }
    private suspend fun verifiedUser(): PrivyUser = (sdk.getAuthState() as? AuthState.Authenticated)?.user
        ?: throw IOException("Wallet authentication is not verified. Reconnect before signing.")
    private fun existingWallet(user: PrivyUser, wallet: String) = user.embeddedSolanaWallets.singleOrNull { it.address==wallet }
        ?: throw IOException("The existing game wallet is unavailable. No replacement wallet was created.")

    companion object {
        private var instance: PrivyWalletAdapter? = null
        /** Keep one application-context SDK instance; an absent client ID is a disabled feature. */
        @Synchronized fun create(context: Context, config: PrivyPublicConfig?): PrivyWalletAdapter? {
            if(config==null) return null
            check(Looper.myLooper()==Looper.getMainLooper()) { "Initialize the wallet on the main thread" }
            return instance?.also { check(it.config==config) { "A different Privy app is already initialized" } }
                ?: PrivyWalletAdapter(context,config).also { instance=it }
        }
    }
}

class PrivyExistingSigner internal constructor(private val adapter: PrivyWalletAdapter, private val userId: String,
    override val address: String, private val requireCurrentIdentity: () -> Unit) : DurableWalletTransactionSigner {
    override suspend fun signMessage(message: ByteArray) = adapter.sign(userId,address,message,false,requireCurrentIdentity)
    override suspend fun signTransaction(serialized: ByteArray) = adapter.sign(userId,address,serialized,true,requireCurrentIdentity)
    override suspend fun signTransactionWithEvidence(serialized: ByteArray, onSigned: (ByteArray) -> Unit) =
        adapter.sign(userId,address,serialized,true,requireCurrentIdentity,onSigned)
}
private fun <T> Result<T>.safeValue(): T = getOrElse {
    if(it is CancellationException) throw it
    // SDK errors may contain auth URLs or tokens. Keep their text out of game diagnostics/UI.
    throw IOException("The wallet operation failed or was rejected")
}
/** PrivyRedirectActivity resumes a closed or abandoned browser tab with exactly this message (SDK 0.14.0). */
private const val OAUTH_CANCELLED = "OAuth flow cancelled by user"
private fun <T> Result<T>.loginValue(failure: String): T = getOrElse {
    if(it is CancellationException) throw it
    if(it is AuthenticationException && it.message==OAUTH_CANCELLED) throw SocialSignInCancelled()
    // Login errors may carry provider URLs or one-time codes. Only fixed game copy reaches the UI.
    throw SocialSignInException(failure)
}
internal fun verified(user: PrivyUser) = PrivySessionState.Verified(user.id,user.embeddedSolanaWallets.map { it.address })
internal fun sessionState(state: AuthState): PrivySessionState = when(state) {
    AuthState.NotReady -> PrivySessionState.NotReady
    AuthState.Unauthenticated -> PrivySessionState.SignedOut
    is AuthState.AuthenticatedUnverified -> PrivySessionState.Unverified
    is AuthState.Authenticated -> verified(state.user)
}
