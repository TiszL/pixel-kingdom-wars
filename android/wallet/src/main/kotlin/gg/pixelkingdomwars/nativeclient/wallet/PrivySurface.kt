package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.network.SecretStore
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** The Privy login methods the web offers: its one 'CONTINUE WITH GOOGLE / X / EMAIL' entry
 * (apps/web/src/ui/connectOptions.ts socialGroup) opens Privy's modal, whose provider list is dashboard
 * configuration. The native title shows the same three as separate buttons; that split is a native choice. */
enum class SocialProvider(val label: String) { GOOGLE("Google"), X("X"), EMAIL("email") }

/** One player-chosen sign-in. Email carries the one-time code the player received. */
sealed interface SocialLoginMethod {
    val provider: SocialProvider
    data object Google : SocialLoginMethod { override val provider = SocialProvider.GOOGLE }
    data object X : SocialLoginMethod { override val provider = SocialProvider.X }
    data class Email(val email: String, val code: String) : SocialLoginMethod { override val provider = SocialProvider.EMAIL }
}

/** What the game needs from the Privy SDK. [PrivyWalletAdapter] implements it; tests fake it.
 * Nothing here creates, migrates or exports a wallet. */
interface PrivySurface {
    val mfa: StateFlow<PrivyMfaRequest?>
    suspend fun restore(): PrivySessionState
    /** Browser round trip owned by the SDK (PrivyRedirectActivity + the manifest scheme). */
    suspend fun loginWithOAuth(provider: SocialProvider, appUrlScheme: String): PrivySessionState.Verified
    suspend fun sendEmailCode(email: String)
    suspend fun loginWithEmailCode(email: String, code: String): PrivySessionState.Verified
    suspend fun signer(expectedWallet: String, requireCurrentIdentity: () -> Unit): WalletSigner
    /** Must obtain a NEW successful provider TOTP verification, never merely reuse cached wallet MFA. */
    suspend fun requireFreshTotp(expectedWallet: String, requireCurrentIdentity: () -> Unit): Unit =
        throw SocialSignInException("Fresh wallet verification is unavailable in this build. Complete this recovery in the web game.")
    suspend fun totpEnrolled(wallet: String, guard: () -> Unit): Boolean =
        throw SocialSignInException("Wallet authenticator setup is unavailable.")
    suspend fun beginTotpEnrollment(wallet: String, guard: () -> Unit): PrivyTotpSetup =
        throw SocialSignInException("Wallet authenticator setup is unavailable.")
    suspend fun finishTotpEnrollment(setup: PrivyTotpSetup, code: String, guard: () -> Unit): Unit =
        throw SocialSignInException("Wallet authenticator setup is unavailable.")
    suspend fun submitTotp(request: PrivyMfaRequest, code: String, requireCurrentIdentity: () -> Unit)
    fun cancelMfa()
    suspend fun logout()
}

/** Player-facing social sign-in failures; the message never carries SDK text (auth URLs, codes). */
open class SocialSignInException(message: String) : IllegalStateException(message)
class SocialSignInCancelled : SocialSignInException("Sign-in cancelled. Choose a sign-in option when you are ready.")

/** The existing embedded wallet the server knows for this Privy user: the wallet the server last
 * confirmed for this user on this device, otherwise the user's only wallet. Never the first of
 * several and never a new one (docs/PRIVY_ANDROID.md: missing or ambiguous wallets fail). */
internal fun selectExistingWallet(remembered: String?, wallets: List<String>): String = when {
    remembered != null -> remembered.takeIf { it in wallets }
        ?: throw SocialSignInException("The game wallet linked to this account is unavailable. Sign in on the web to check your account; no replacement wallet was created.")
    wallets.isEmpty() -> throw SocialSignInException("This account has no game wallet yet. Sign in once in the web game to create it; the app never creates wallets.")
    wallets.size == 1 -> wallets.single()
    else -> throw SocialSignInException("This account has more than one game wallet and the app cannot choose between them. Sign in on the web or with a wallet app.")
}

/** The server-confirmed wallet for the last Privy user signed in on this device (public identifiers only).
 * [io] is the store's dispatcher; tests pass an inline one so reads settle synchronously. */
class SocialBinding(private val store: SecretStore, private val io: CoroutineDispatcher = Dispatchers.IO) {
    suspend fun walletOf(userId: String): String? = withContext(io) { read()?.takeIf { it.first == userId }?.second }
    suspend fun isBound(wallet: String): Boolean = withContext(io) { read()?.second == wallet }
    /** Sensitive actions cannot downgrade an unreadable embedded-wallet binding to external-wallet auth. */
    suspend fun isBoundForSecurity(wallet: String): Boolean = withContext(io) {
        val raw = store.read() ?: return@withContext false
        val value = try { Json.parseToJsonElement(raw).jsonObject } catch (_: Exception) {
            throw SocialSignInException("Saved wallet identity could not be verified. Reconnect before changing security.")
        }
        val user = value["userId"]?.jsonPrimitive?.contentOrNull
        val owner = value["wallet"]?.jsonPrimitive?.contentOrNull
        check(!user.isNullOrBlank() && !owner.isNullOrBlank()) { "Saved wallet identity could not be verified. Reconnect before changing security." }
        owner == wallet
    }
    /** A social sign-in bound some wallet on this device (the wallet signing out may be unknown to the caller). */
    suspend fun hasBinding(): Boolean = withContext(io) { read() != null }
    suspend fun remember(userId: String, wallet: String) = withContext(io) {
        store.write(buildJsonObject { put("userId", userId); put("wallet", wallet) }.toString())
    }
    private fun read(): Pair<String, String>? = store.read()?.let { raw ->
        runCatching {
            val value = Json.parseToJsonElement(raw).jsonObject
            requireNotNull(value["userId"]?.jsonPrimitive?.contentOrNull) to requireNotNull(value["wallet"]?.jsonPrimitive?.contentOrNull)
        }.getOrNull()
    }
}

/** Present only while the SDK's browser round trip is open, so a process death or a destroyed screen
 * during it is explained on the next title screen instead of silently forgotten (web:
 * apps/web/src/auth/socialLoginIntent.ts, consumed by useSocialAuth.ts after the redirect). Holds no
 * token, code or ownership claim. */
class SocialLoginMarker(private val store: SecretStore, private val io: CoroutineDispatcher = Dispatchers.IO) {
    suspend fun set(provider: SocialProvider) = withContext(io) { store.write(provider.name) }
    suspend fun clear() = withContext(io) { store.clear() }
    /** Returns and clears the interrupted provider, if any. */
    suspend fun consume(): SocialProvider? = withContext(io) {
        store.read()?.let { raw -> store.clear(); SocialProvider.entries.firstOrNull { it.name == raw } }
    }
}

/** Provider setup material is transient, identity-bound and never serialized/logged. */
class PrivyTotpSetup(val wallet: String, val userId: String, val secret: String) {
    init { require(secret.isNotBlank()) }
    override fun toString() = "PrivyTotpSetup(redacted)"
}
