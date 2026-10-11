package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.serialization.json.JsonObject

/** Bound only to the exact sign-only WalletLogin association, never pay/send. */
fun interface VehicleExternalSigner {
    suspend fun sign(prepared: PreparedVehicle, cluster: SolanaCluster,
        onSigned: suspend (JsonObject) -> Unit, beforeWallet:suspend ()->Unit, guard: () -> Unit): JsonObject
}

/** Both tracks own verified bytes before session guards and await durable retention.
 * The embedded SDK callback is synchronous: capture exact immutable wire there,
 * then drain its single suspending write even if the association later fails. */
class VehicleWallet(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val origin: String, private val cluster: SolanaCluster, private val isEmbedded: suspend (String) -> Boolean,
    private val social: () -> SocialLogin?, private val external: VehicleExternalSigner?) {
    private val admission = Mutex()
    private val mutableMfa = MutableStateFlow<PrivyMfaRequest?>(null)
    val mfa = mutableMfa.asStateFlow()
    private var activeSocial: SocialLogin? = null
    private var activeGuard: (() -> Unit)? = null
    /** Check availability without opening an approval or consuming an attempt. */
    suspend fun requireAvailable(requireAdmission: () -> Unit) {
        fun guard() { holder.requireCurrent(session); requireAdmission() }
        currentCoroutineContext().ensureActive(); guard()
        check(!admission.isLocked) { "Vehicle approval is already in progress" }
        val embedded = isEmbedded(session.wallet); currentCoroutineContext().ensureActive(); guard()
        if (embedded) requireNotNull(social()) { "Reconnect the original Vehicle wallet" }
        else requireNotNull(external) { "A compatible Solana wallet is needed" }
        guard()
    }
    suspend fun sign(prepared: PreparedVehicle, record: suspend (JsonObject) -> Unit, beforeWallet:suspend ()->Unit,
        requireAdmission: () -> Unit): JsonObject = coroutineScope {
        check(admission.tryLock()) { "Vehicle approval is already in progress" }
        var prompt: Job? = null
        var retention: Deferred<JsonObject>? = null
        try {
            val context = currentCoroutineContext()
            fun guard() { context.ensureActive(); holder.requireCurrent(session); requireAdmission() }
            guard(); require(session.origin == origin && session.wallet == prepared.wallet)
            val invocationRequested=java.util.concurrent.atomic.AtomicBoolean(false)
            val invocationReady=java.util.concurrent.atomic.AtomicBoolean(false)
            suspend fun beforeSign() {
                guard();check(invocationRequested.compareAndSet(false,true)) { "Vehicle signing was already invoked" }
                beforeWallet();guard();invocationReady.set(true)
            }
            val evidenceLock = Any(); var owned: JsonObject? = null
            val durable = CoroutineScope(context + NonCancellable)
            fun capture(value: JsonObject): Deferred<JsonObject> = synchronized(evidenceLock) {
                check(invocationReady.get()) { "Vehicle wallet skipped the signing boundary" }
                val verified = prepared.verifyWire(value)
                require(value == verified) { "Wallet returned inconsistent Vehicle evidence" }
                owned?.let { check(it == verified) { "Wallet returned conflicting Vehicle evidence" }; return@synchronized requireNotNull(retention) }
                owned = verified
                durable.async { record(verified); verified }.also { retention = it }
            }
            suspend fun retain(value: JsonObject): JsonObject = withContext(NonCancellable) { capture(value).await() }
            val embedded = isEmbedded(session.wallet).also { guard() }
            val login = if (embedded) requireNotNull(social()) { "Reconnect the original Vehicle wallet" } else null
            activeSocial = login; activeGuard = ::guard
            prompt = login?.let { launch { it.mfa.collect { request -> guard(); mutableMfa.value = request } } }
            val result = if (login != null) {
                val signer = login.securitySigner(session.wallet, session.token, ::guard) as? DurableWalletTransactionSigner
                    ?: error("This wallet cannot retain Vehicle signature evidence")
                guard(); require(signer.address == prepared.wallet) { "The Vehicle wallet changed" }
                val unsigned=prepared.unsignedTransaction()
                beforeSign();guard()
                val bytes = signer.signTransactionWithEvidence(unsigned) { capture(prepared.verifySigned(it)) }
                retain(prepared.verifySigned(bytes))
            } else {
                val signer = requireNotNull(external) { "A compatible Solana wallet is needed" }; guard()
                val signed = signer.sign(prepared, cluster, { retain(it); Unit }, ::beforeSign, ::guard)
                retain(signed)
            }
            check(invocationReady.get()) { "Vehicle wallet skipped the signing boundary" };guard(); result
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
