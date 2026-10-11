package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.wallet.*

/** What [WalletLogin.pay] hands the rail, as fakes: the wallet module's own tests (WalletPayTest,
 * SignedTransactionSemanticTest) prove how these outcomes are produced from a real association. */

/** The send answer that leads into the same-session signature. */
internal val SEND_METHOD_NOT_FOUND = WalletFailureReason(WalletFailureKind.METHOD_NOT_FOUND_SEND, -32601, WalletPayStage.SEND)
/** The player declined the wallet's own send: provably nothing was broadcast. */
internal fun declinedInWallet() = WalletPaymentException("Payment cancelled", true, IllegalStateException("PRIVATE wallet text"),
    WalletFailureReason(WalletFailureKind.NOT_SIGNED, -3, WalletPayStage.SEND))
/** The signed reply failed the semantic check after the send answered method-not-found: nothing was relayed. */
internal fun tamperedReply() = WalletPaymentException("Payment cancelled", true, IllegalArgumentException("PRIVATE wallet text"),
    WalletFailureReason(WalletFailureKind.TX_INSTRUCTIONS_CHANGED, stage = WalletPayStage.VALIDATE, after = SEND_METHOD_NOT_FOUND))
/** A checked signed-only payment whose fee-payer signature is 64 bytes of [fill]. */
internal fun signedOnly(transaction: ByteArray, fill: Int = 21, mutation: TransactionMutation = TransactionMutation.NONE,
                        sendRefusal: WalletFailureReason? = SEND_METHOD_NOT_FOUND): WalletPayment.SignedOnly {
    val signed = transaction.copyOf().apply { (1..64).forEach { this[it] = fill.toByte() } }
    return WalletPayment.SignedOnly(signed, signed.copyOfRange(1, 65), mutation, sendRefusal)
}
