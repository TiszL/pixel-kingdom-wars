package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException

/** One wallet step for one reviewed payment: the Mobile Wallet Adapter association ([WalletLogin.pay]) or the
 * bound embedded wallet ([embeddedWalletPayer]). It either broadcast already or hands back a checked signed
 * transaction; it never relays. Its failures are [WalletPaymentException]s with an exact money verdict.
 * `onSent` takes the signature of a send the wallet itself broadcast, the moment the wallet answers and before the
 * step can end any other way; a payer that only signs never calls it. */
fun interface WalletPayer { suspend fun pay(transaction: ByteArray, cluster: SolanaCluster, wallet: String, onSent: (ByteArray) -> Unit): WalletPayment }

/** The payment rail shared by land, market purchases, base purchases and KEEP deposits.
 *
 *  - [WalletPayment.Sent]: the wallet app signed and broadcast (`sign_and_send_transactions`, mandatory in MWA 2.0
 *    and the only path ever seen to land for the owner's wallet). Its signature is persisted at once — inside the
 *    wallet step (`onSent`) when the payer offers that, else on return — and exactly once either way.
 *  - [WalletPayment.SignedOnly]: the wallet only signed — the same-session fallback after the send answered
 *    -32601 / -2, or the embedded wallet. The signature is persisted FIRST, the payment window is re-checked
 *    ([pay]'s `beforeBroadcast`), and the RETURNED bytes are relayed exactly once.
 *
 * Nothing here re-prompts: a decline, a mismatch or an uncertain outcome ends the attempt. Only a wallet step or
 * the relay is reported as a wallet failure; an exception from `recordSignature`, `guard` or `beforeBroadcast`
 * is this app's own and keeps its own message. */
class ExternalPaymentRail(private val payer: WalletPayer, private val rpc: SolanaRpc, private val report: (WalletFailureReason) -> Unit) {
    suspend fun pay(transaction: ByteArray, cluster: SolanaCluster, wallet: String, guard: () -> Unit,
                    recordSignature: (String) -> Unit, beforeBroadcast: () -> Unit = {}): String {
        // A journal failure leaves this false, so the Sent branch below tries once more and lets it travel.
        var sentRecorded = false
        fun recordSent(signature: String) { if (!sentRecorded) { recordSignature(signature); sentRecorded = true } }
        val payment = try { payer.pay(transaction.copyOf(), cluster, wallet) { recordSent(base58(it)) } }
            catch (e: CancellationException) { throw e }
            catch (e: WalletPaymentException) { e.reason?.chain?.forEach(report); throw e }
        val signature = base58(payment.signature)
        when (payment) {
            is WalletPayment.Sent -> {
                // The wallet has broadcast: persist its signature before anything else can interrupt. A failure
                // here is not a wallet failure and must stay uncertain, so it travels as it is.
                recordSent(signature); guard()
            }
            is WalletPayment.SignedOnly -> {
                payment.sendRefusal?.let(report)
                try { guard(); recordSignature(signature); guard(); beforeBroadcast() }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) {
                    // Nothing was broadcast by anyone: the wallet only signed and this app has not relayed.
                    throw WalletPaymentException(e.message ?: "The payment was stopped before this app sent it.", true)
                }
                try { rpc.sendTransaction(payment.signedTransaction, signature); guard() }
                catch (e: CancellationException) { throw e }
                catch (e: Exception) {
                    // Once this app's single relay call starts, every result may follow a broadcast.
                    val reason = walletFailureReason(e, WalletPayStage.RELAY).copy(after = payment.sendRefusal); report(reason)
                    throw WalletPaymentException("Payment broadcast outcome is uncertain.", false, reason = reason)
                }
                if (payment.sendRefusal != null) report(WalletFailureReason(
                    if (payment.mutation == TransactionMutation.COMPUTE_BUDGET_ADDED) WalletFailureKind.FALLBACK_USED_COMPUTE_BUDGET else WalletFailureKind.FALLBACK_USED,
                    stage = WalletPayStage.RELAY, after = payment.sendRefusal))
            }
        }
        return signature
    }
}

/** The bound embedded (Privy) wallet: it signs only and must return the reviewed bytes unchanged
 * ([paymentTransactionSignature]); the rail then persists, re-checks and relays as for any signed-only payment.
 * A provider's text never travels — only the class of its failure. */
internal fun embeddedWalletPayer(login: SocialLogin, session: gg.pixelkingdomwars.nativeclient.session.AccountSession, guard: () -> Unit) = WalletPayer { transaction, _, wallet, _ ->
    var stage = WalletPayStage.SIGN
    try {
        val signer = login.securitySigner(session.wallet, session.token, guard) as? WalletTransactionSigner
            ?: throw WalletPaymentException("This wallet cannot sign native payments. Update the app.", true)
        guard(); require(signer.address == wallet)
        val signed = signer.signTransaction(transaction.copyOf())
        stage = WalletPayStage.VALIDATE; guard()
        WalletPayment.SignedOnly(signed, paymentTransactionSignature(transaction, signed, wallet), TransactionMutation.NONE, sendRefusal = null)
    } catch (e: CancellationException) { throw e }
    catch (e: WalletPaymentException) { throw e }
    catch (e: Exception) { throw WalletPaymentException("Wallet confirmation was not completed.", true, reason = walletFailureReason(e, stage)) }
}
