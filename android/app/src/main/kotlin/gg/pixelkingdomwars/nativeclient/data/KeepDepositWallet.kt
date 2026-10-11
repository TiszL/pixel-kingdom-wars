package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.session.AccountSession
import gg.pixelkingdomwars.nativeclient.session.AccountSessionHolder
import gg.pixelkingdomwars.nativeclient.telemetry.reportWalletFailure
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*

/** Current external wallet or the existing bound Privy wallet, with no provider fallback/replacement. */
class KeepDepositWallet(private val session: AccountSession, private val holder: AccountSessionHolder,
    private val isEmbedded: suspend (String) -> Boolean, private val social: () -> SocialLogin?,
    private val external: WalletPayer?, private val rpc: SolanaRpc, private val cluster: SolanaCluster,
    private val requirePaymentWindow: (KeepDepositQuote) -> Unit,
    private val report: (WalletFailureReason) -> Unit = ::reportWalletFailure,
) : KeepDepositSender {
    private val mutableMfa = MutableStateFlow<PrivyMfaRequest?>(null)
    val mfa = mutableMfa.asStateFlow()
    private var activeSocial: SocialLogin? = null
    override suspend fun send(transaction: ByteArray, quote: KeepDepositQuote, recordSignature: (String) -> Unit): String = coroutineScope {
        val context = currentCoroutineContext()
        fun guard() { context.ensureActive(); holder.requireCurrent(session) }
        guard(); require(quote.wallet == session.wallet && quote.origin == session.origin && quote.cluster == cluster.id)
        val embedded = isEmbedded(session.wallet); guard(); requirePaymentWindow(quote)
        val login = if (embedded) social() ?: throw WalletPaymentException("Reconnect the existing game wallet.", true) else null
        // The external wallet app ([WalletLogin.pay]) or the bound embedded wallet: either way one rail persists the
        // signature, re-checks the payment window and relays a signed-only transaction exactly once.
        val payer = if (login == null) external ?: throw WalletPaymentException("A compatible Solana wallet app is needed.", true)
            else embeddedWalletPayer(login, session, ::guard)
        activeSocial = login
        val prompt = login?.let { launch { it.mfa.collect { request -> guard(); mutableMfa.value = request } } }
        try { ExternalPaymentRail(payer, rpc, report).pay(transaction, cluster, quote.wallet, ::guard, recordSignature) { requirePaymentWindow(quote) } }
        finally { prompt?.cancel(); mutableMfa.value = null; activeSocial = null }
    }
    suspend fun submitMfa(request: PrivyMfaRequest, code: String) {
        holder.requireCurrent(session)
        val login = requireNotNull(activeSocial)
        check(mutableMfa.value === request && login.mfa.value === request)
        login.submitMfaCode(request, code); holder.requireCurrent(session)
    }
    fun cancelMfa(request: PrivyMfaRequest) {
        holder.requireCurrent(session)
        val login = activeSocial ?: return
        if (mutableMfa.value === request && login.mfa.value === request) login.cancelMfa()
    }
}
