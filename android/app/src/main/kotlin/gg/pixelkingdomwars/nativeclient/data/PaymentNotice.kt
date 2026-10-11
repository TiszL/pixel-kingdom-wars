package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.wallet.WalletPaymentException

/** " — <reason>" for an outcome the wallet step classified ([WalletPaymentException.reason]): one plain sentence
 * and the bracket token (`[send:-4]`); empty for any other failure, whose text stays out of the notice. The
 * money-honest sentence around it is unchanged. */
internal fun paymentDetail(e: Exception): String = (e as? WalletPaymentException)?.reason?.let { " — ${it.notice}" } ?: ""

/** The notice for a payment that provably was NOT sent and is payable again. A classified wallet reason reads
 * "Payment was not sent — <one sentence>. <what to do> [stage:code]"; a stop of this app's own (payment window,
 * journal, missing wallet) keeps its own message and is never worded as the wallet's refusal. */
internal fun notSentNotice(e: WalletPaymentException, next: String): String =
    e.reason?.let { "Payment was not sent — ${it.kind.notice}. $next ${it.token}" } ?: "${ownSentence(e.message, "Payment was not sent.")} $next"
private fun ownSentence(message: String?, fallback: String): String =
    message?.trim()?.takeIf { it.isNotEmpty() }?.let { if (it.last() in ".!?") it else "$it." } ?: fallback

/** A signature is saved but this app stopped before relaying it (payment window, journal): its own message,
 * never "the wallet's reply failed". Null when [e] is anything else. */
internal fun stoppedBeforeRelayNotice(e: Exception, next: String): String? =
    (e as? WalletPaymentException)?.takeIf { it.refusedBeforeBroadcast && it.reason == null }?.let { "${ownSentence(it.message, "The payment was stopped before this app sent it.")} $next" }
