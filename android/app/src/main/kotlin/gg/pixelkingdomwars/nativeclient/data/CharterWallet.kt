package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex

/** Bound only to the exact sign-only WalletLogin association, never pay/send. */
fun interface CharterExternalSigner {
    suspend fun sign(prepared: PreparedCharter, cluster: SolanaCluster,
        onSigned: suspend (SignedCharter) -> Unit, guard: () -> Unit): SignedCharter
}

/** Both tracks own verified bytes before session guards and await durable retention.
 * The embedded SDK callback is synchronous: capture exact immutable wire there,
 * then drain its single suspending write even if the association later fails. */
class CharterWallet(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val origin: String, private val cluster: SolanaCluster, private val isEmbedded: suspend (String) -> Boolean,
    private val social: () -> SocialLogin?, private val external: CharterExternalSigner?) {
    private val admission = Mutex()
    private val mutableMfa = MutableStateFlow<PrivyMfaRequest?>(null)
    val mfa = mutableMfa.asStateFlow()
    private var activeSocial: SocialLogin? = null
    private var activeGuard: (() -> Unit)? = null
    /** Check availability without opening an approval or consuming an attempt. */
    suspend fun requireAvailable(requireAdmission: () -> Unit) {
        fun guard() { holder.requireCurrent(session); requireAdmission() }
        currentCoroutineContext().ensureActive(); guard()
        check(!admission.isLocked) { "Charter approval is already in progress" }
        val embedded = isEmbedded(session.wallet); currentCoroutineContext().ensureActive(); guard()
        if (embedded) requireNotNull(social()) { "Reconnect the original Charter wallet" }
        else requireNotNull(external) { "A compatible Solana wallet is needed" }
        guard()
    }
    suspend fun sign(prepared: PreparedCharter, record: suspend (SignedCharter) -> Unit,
        requireAdmission: () -> Unit): SignedCharter = coroutineScope {
        check(admission.tryLock()) { "Charter approval is already in progress" }
        var prompt: Job? = null
        var retention: Deferred<SignedCharter>? = null
        try {
            val context = currentCoroutineContext()
            fun guard() { context.ensureActive(); holder.requireCurrent(session); requireAdmission() }
            guard(); require(session.origin == origin && session.wallet == prepared.wallet)
            val evidenceLock = Any(); var owned: SignedCharter? = null
            val durable = CoroutineScope(context + NonCancellable)
            fun capture(value: SignedCharter): Deferred<SignedCharter> = synchronized(evidenceLock) {
                val verified = prepared.verifySignedBase64(value.wire)
                require(value == verified) { "Wallet returned inconsistent Charter evidence" }
                owned?.let { check(it == verified) { "Wallet returned conflicting Charter evidence" }; return@synchronized requireNotNull(retention) }
                owned = verified
                durable.async { record(verified); verified }.also { retention = it }
            }
            suspend fun retain(value: SignedCharter): SignedCharter = withContext(NonCancellable) { capture(value).await() }
            val embedded = isEmbedded(session.wallet).also { guard() }
            val login = if (embedded) requireNotNull(social()) { "Reconnect the original Charter wallet" } else null
            activeSocial = login; activeGuard = ::guard
            prompt = login?.let { launch { it.mfa.collect { request -> guard(); mutableMfa.value = request } } }
            val result = if (login != null) {
                val signer = login.securitySigner(session.wallet, session.token, ::guard) as? DurableWalletTransactionSigner
                    ?: error("This wallet cannot retain Charter signature evidence")
                guard(); require(signer.address == prepared.wallet) { "The Charter wallet changed" }
                val bytes = signer.signTransactionWithEvidence(prepared.unsignedTransaction()) { capture(prepared.verifySigned(it)) }
                retain(prepared.verifySigned(bytes))
            } else {
                val signer = requireNotNull(external) { "A compatible Solana wallet is needed" }; guard()
                val signed = signer.sign(prepared, cluster, { retain(it); Unit }, ::guard)
                retain(signed)
            }
            guard(); result
        } finally {
            // A failing/cancelled wallet cannot let its owner close the encrypted
            // journal before the original callback's suspending write finishes.
            try { withContext(NonCancellable) { retention?.await() } }
            finally { prompt?.cancel(); mutableMfa.value = null; activeSocial = null; activeGuard = null; admission.unlock() }
        }
    }
    suspend fun submitMfa(request: PrivyMfaRequest, code: String) {
        currentCoroutineContext().ensureActive(); val guard = requireNotNull(activeGuard); guard()
        val login = requireNotNull(activeSocial)
        check(mutableMfa.value === request && login.mfa.value === request)
        login.submitMfaCode(request, code, guard); guard()
    }
    fun cancelMfa(request: PrivyMfaRequest) {
        holder.requireCurrent(session); val login = activeSocial ?: return
        if (mutableMfa.value === request && login.mfa.value === request) login.cancelMfa()
    }
}
