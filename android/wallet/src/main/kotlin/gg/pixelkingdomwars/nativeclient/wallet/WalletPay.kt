package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import com.solana.mobilewalletadapter.clientlib.DefaultTransactionParams
import com.solana.mobilewalletadapter.clientlib.TransactionResult
import com.solana.mobilewalletadapter.clientlib.successPayload

/** How one wallet payment ended inside its single MWA association. */
sealed interface WalletPayment {
    /** The fee-payer signature: the payment's identity for the journal and the server's reference scan. */
    val signature: ByteArray
    /** The wallet signed AND broadcast through its own `sign_and_send_transactions`. */
    class Sent(override val signature: ByteArray) : WalletPayment
    /** Nothing was broadcast yet: the caller persists [signature], re-checks its payment window and relays
     * [signedTransaction] — the RETURNED bytes — exactly once. [sendRefusal] is the wallet's answer to the send
     * that led here (null for a signer that never offers a send, the embedded wallet). */
    class SignedOnly(val signedTransaction: ByteArray, override val signature: ByteArray,
                     val mutation: TransactionMutation, val sendRefusal: WalletFailureReason?) : WalletPayment
}

/** The stage one payment reached, shared between the association block and the code that classifies its failure. */
internal class WalletPayFlight {
    @Volatile var stage: WalletPayStage = WalletPayStage.AUTHORIZE
    /** Set when the send answered -32601 / -2 and the same session went on to sign only. */
    @Volatile var sendRefusal: WalletFailureReason? = null
    /** The fee-payer signature the wallet's own send answered with. Once set the broadcast is KNOWN, whatever the
     * association does afterwards ([walletPaymentOutcome]). */
    @Volatile var sent: ByteArray? = null
}

/** The part of a payment that runs inside the one MWA association, after `authorize`.
 *
 * `sign_and_send_transactions` is called UNCONDITIONALLY. The 0.5.1 `get_capabilities` gate read a clientlib flag
 * that is false for every spec-conformant MWA 2.0 wallet (mandatory features are not listed in `features`), so
 * the send never reached the wallet. A wallet that really lacks the method answers -32601, and only that answer
 * or -2 (payload rejected before signing) continues with `sign_transactions` in the SAME session: no second
 * association, no second authorize. Every other send error is rethrown untouched for [walletPaymentFailure].
 *
 * [onSent] receives the send's signature the moment the wallet answers, INSIDE the association and before the
 * guard: returning it was the only route to the caller's journal, and clientlib-ktx 2.0.7 closes the session after
 * the block (`scenario.close().get(10 s)`, outside its own exception handling), so a wallet slow to disconnect
 * threw out of `transact` and a KNOWN broadcast was dropped as "uncertain". Journals carry their own identity check. */
internal suspend fun AdapterOperations.payInSession(flight: WalletPayFlight, authorizedAccount: ByteArray?, transaction: ByteArray,
                                                    expectedWallet: String, guard: () -> Unit, onSent: (ByteArray) -> Unit,
                                                    onSigned: ((ByteArray) -> Unit)? = null): WalletPayment {
    flight.stage = WalletPayStage.ACCOUNT_CHECK
    guard()
    val account = authorizedAccount ?: throw WalletRefusedException("The wallet did not provide an account", WalletFailureKind.INVALID_RESPONSE)
    if (!account.contentEquals(publicKeyBytes(expectedWallet))) throw WalletRefusedException(
        "Approve the payment with the same wallet you play with (${expectedWallet.take(4)}…${expectedWallet.takeLast(4)})")
    flight.stage = WalletPayStage.SEND
    try {
        val sent = signAndSendTransactions(arrayOf(transaction.copyOf()), DefaultTransactionParams)
        // From here on the wallet may already have broadcast: every failure below stays at SEND and is uncertain,
        // unless the reply carried a well-formed signature, which is persisted before anything else can interrupt.
        val reply = sent.signatures.singleOrNull()
        val signature = reply?.takeIf { it.size == 64 }?.copyOf()
        if (signature != null) { flight.sent = signature; onSent(signature.copyOf()) }
        guard()
        requireNotNull(reply) { "The wallet returned an invalid payment response" }
        return WalletPayment.Sent(requireNotNull(signature) { "The wallet returned an invalid payment signature" })
    } catch (e: Exception) {
        // ktx hands the wallet's JSON-RPC error over inside an ExecutionException; the verdict is read unwrapped.
        if (!permitsSignOnlyFallback(e)) throw e
        flight.sendRefusal = walletFailureReason(e, WalletPayStage.SEND)
    }
    flight.stage = WalletPayStage.SIGN
    guard()
    val reply = signTransactions(arrayOf(transaction.copyOf()))
    flight.stage = WalletPayStage.VALIDATE
    if (onSigned == null) guard()
    val signed = reply.signedPayloads.singleOrNull()?.copyOf()
        ?: throw SignedTransactionRejected(WalletFailureKind.INVALID_RESPONSE, "The wallet returned an invalid signing response")
    // Opt-in durable flows validate the original message and save its public signature before
    // a changed session can hide a returned result. Legacy callers retain their guard ordering.
    if (onSigned != null) { onSigned(signed.copyOf()); guard() }
    val checked = semanticPaymentSignature(transaction, signed, expectedWallet)
    return WalletPayment.SignedOnly(signed, checked.signature, checked.mutation, flight.sendRefusal)
}

/** The classified, money-honest failure of one payment: [WalletPaymentException.refusedBeforeBroadcast] by stage
 * and unwrapped code ([refusedBeforeBroadcast]), and the reason chained to the send refusal when the sign-only
 * fallback is what failed. The message is the land rail's sentence; the other rails show only the reason. */
internal fun walletPaymentFailure(flight: WalletPayFlight, cause: Throwable?, noWalletFound: Boolean = false): WalletPaymentException {
    val stage = flight.stage
    val reason = (if (noWalletFound) WalletFailureReason(WalletFailureKind.NOT_FOUND, stage = stage) else walletFailureReason(cause, stage))
        .copy(after = flight.sendRefusal)
    val refused = noWalletFound || refusedBeforeBroadcast(stage, cause)
    return WalletPaymentException(landPaymentNotice(refused, reason), refused, cause, reason)
}

/** What [WalletLogin.pay] returns or throws once its association ended: [result] is what `transact` returned,
 * [escaped] what it threw instead (ktx 2.0.7 converts runtime, execution, cancellation and interruption failures
 * into a [TransactionResult.Failure] and lets checked ones — its own close timeout — escape). A signature the
 * send already answered with ([WalletPayFlight.sent]) wins over every later ending of the session: the broadcast
 * is known, so the payment is [WalletPayment.Sent], never an uncertain failure. */
internal fun walletPaymentOutcome(flight: WalletPayFlight, result: TransactionResult<WalletPayment>?, escaped: Exception?): WalletPayment {
    flight.sent?.let { return WalletPayment.Sent(it.copyOf()) }
    if (escaped != null) throw walletPaymentFailure(flight, escaped)
    return when (result) {
        is TransactionResult.Success -> requireNotNull(result.successPayload) { "The wallet returned no payment response" }
        is TransactionResult.NoWalletFound -> throw walletPaymentFailure(flight, null, noWalletFound = true)
        is TransactionResult.Failure -> throw walletPaymentFailure(flight, result.e)
        null -> throw walletPaymentFailure(flight, null)
    }
}
