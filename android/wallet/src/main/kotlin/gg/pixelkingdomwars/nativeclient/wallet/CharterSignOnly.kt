package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/** Opt-in v0 support never changes legacy callers. No wallet broadcast operation. */
internal suspend fun AdapterOperations.signCharterInSession(prepared: PreparedCharter, authorizedAccount: ByteArray?,
    guard: () -> Unit, onSigned: suspend (SignedCharter) -> Unit): SignedCharter {
    guard()
    require(authorizedAccount != null && authorizedAccount.contentEquals(publicKeyBytes(prepared.wallet))) {
        "Approve with the original Charter participant wallet"
    }
    val capabilities = getCapabilities()
    guard()
    require(capabilities.supportedTransactionVersions.any { it is Number && it.toLong() == 0L && it.toDouble() == 0.0 }) {
        "This wallet does not support Charter versioned transactions"
    }
    val response = signTransactions(arrayOf(prepared.unsignedTransaction()))
    require(response.signedPayloads.size == 1) { "Invalid Charter wallet reply" }
    val checked = prepared.verifySigned(response.signedPayloads.single())
    withContext(NonCancellable) { onSigned(checked) }
    guard()
    return checked
}
