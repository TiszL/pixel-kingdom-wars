package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.GemsBuyIntent
import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.telemetry.reportWalletFailure
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** AppGraph must bind this to WalletLogin.payWithEvidence and the captured session token. */
fun interface GemsBuyPayer {
    suspend fun pay(transaction: ByteArray, cluster: SolanaCluster, wallet: String,
        onSent: (ByteArray) -> Unit, onSigned: (ByteArray) -> Unit, guard: () -> Unit): WalletPayment
}

/** Gems-specific orchestration: legacy KEEP custody signing/relay ordering stays untouched. */
class GemsBuyWallet(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val origin: String, private val cluster: SolanaCluster, private val payments: GemsBuyPayment,
    private val isEmbedded: suspend (String) -> Boolean, private val social: () -> SocialLogin?,
    private val external: GemsBuyPayer?, private val requirePaymentWindow: (GemsBuyIntent) -> Unit,
    private val report: (WalletFailureReason) -> Unit = ::reportWalletFailure) : GemsBuySender {
    private val mutableMfa = MutableStateFlow<PrivyMfaRequest?>(null); val mfa = mutableMfa.asStateFlow()
    private var activeSocial: SocialLogin? = null

    override suspend fun send(transaction: ByteArray, quote: GemsBuyIntent, recordSignature: (String, Boolean) -> Unit): String = coroutineScope {
        val context = currentCoroutineContext(); val original = transaction.copyOf()
        fun guard() { context.ensureActive(); holder.requireCurrent(session); requirePaymentWindow(quote) }
        var recorded: Pair<String, Boolean>? = null
        fun persist(signature: String, exact: Boolean) {
            require(KeepDepositPayment.validSignature(signature))
            recorded?.let { check(it == (signature to exact)) { "Wallet returned conflicting payment evidence." }; return }
            // No identity guard: a received signature belongs to this original journal even after logout.
            recordSignature(signature, exact); recorded = signature to exact
        }
        fun signed(bytes: ByteArray) { persist(payments.signedSignature(original, quote, bytes), true) }
        fun sent(bytes: ByteArray) { require(bytes.size == 64); persist(base58(bytes), false) }
        try {
            guard(); require(session.origin == origin && quote.wallet == session.wallet && payments.cluster == cluster)
            payments.validatePrepared(original, quote); payments.requireLive(original, quote); guard()
        } catch (e: CancellationException) { throw e }
        catch (e: Exception) { throw WalletPaymentException(e.message ?: "Wallet payment is not ready.", true, e) }

        val embedded = try { isEmbedded(session.wallet).also { guard() } }
            catch (e: CancellationException) { throw e }
            catch (_: Exception) { throw WalletPaymentException("The existing wallet could not be verified. Nothing was sent.", true) }
        val login = if (embedded) social() ?: throw WalletPaymentException("Reconnect the existing game wallet.", true) else null
        activeSocial = login
        val prompt = login?.let { launch { it.mfa.collect { request -> guard(); mutableMfa.value = request } } }
        try {
            val payment = if (login != null) {
                try {
                    val signer = login.securitySigner(session.wallet, session.token, ::guard) as? DurableWalletTransactionSigner
                        ?: throw WalletPaymentException("This wallet cannot preserve payment evidence. Update the app.", true)
                    guard(); require(signer.address == session.wallet)
                    val wire = signer.signTransactionWithEvidence(original.copyOf(), ::signed)
                    // Validate/save before any post-wallet guard; this also protects custom signer implementations.
                    signed(wire)
                    WalletPayment.SignedOnly(wire.copyOf(), paymentTransactionSignature(original, wire, session.wallet), TransactionMutation.NONE, null)
                } catch (e: CancellationException) { throw e }
                catch (e: WalletPaymentException) { throw e }
                catch (_: Exception) { throw WalletPaymentException("Wallet approval or payment evidence could not be completed. Nothing was relayed by this app.", true) }
            } else {
                val payer = external ?: throw WalletPaymentException("A compatible Solana wallet app is needed.", true)
                try { payer.pay(original.copyOf(), cluster, session.wallet, ::sent, ::signed, ::guard) }
                catch (e: CancellationException) { throw e }
                catch (e: WalletPaymentException) { e.reason?.chain?.forEach(report); throw e }
                catch (_: Exception) { throw WalletPaymentException("Wallet payment outcome is uncertain. Check the saved purchase.", false) }
            }
            when (payment) {
                is WalletPayment.Sent -> {
                    sent(payment.signature); guard()
                    // MWA already broadcast. Never relay, re-sign or assign the prepared height to this signature.
                    base58(payment.signature)
                }
                is WalletPayment.SignedOnly -> {
                    val wire = payment.signedTransaction.copyOf()
                    val signature = try {
                        val sig = payments.signedSignature(original, quote, wire)
                        require(sig == base58(payment.signature)); persist(sig, true)
                        guard(); payments.requireLive(original, quote); guard(); sig
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) { throw WalletPaymentException(e.message ?: "Payment stopped before this app's relay.", true, e) }
                    try { payments.broadcast(original, quote, wire, signature); guard() }
                    catch (e: CancellationException) { throw e }
                    catch (_: Exception) { throw WalletPaymentException("Payment broadcast outcome is uncertain. Check the original purchase.", false) }
                    signature
                }
            }
        } finally { prompt?.cancel(); mutableMfa.value = null; activeSocial = null }
    }
    suspend fun submitMfa(request: PrivyMfaRequest, code: String) {
        holder.requireCurrent(session); val login = requireNotNull(activeSocial)
        check(mutableMfa.value === request && login.mfa.value === request)
        login.submitMfaCode(request, code); holder.requireCurrent(session)
    }
    fun cancelMfa(request: PrivyMfaRequest) {
        holder.requireCurrent(session); val login = activeSocial ?: return
        if (mutableMfa.value === request && login.mfa.value === request) login.cancelMfa()
    }
}
