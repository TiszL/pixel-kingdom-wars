package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext

/** Exact sign-only association; retain owned bytes even after session/caller cancellation. */
internal suspend fun AdapterOperations.signRealmSaleInSession(prepared: PreparedRealmSale, authorizedAccount: ByteArray?,
    guard: () -> Unit, onSigned: suspend (SignedRealmSale) -> Unit): SignedRealmSale {
    guard()
    require(authorizedAccount != null && authorizedAccount.contentEquals(publicKeyBytes(prepared.wallet))) { "Approve with the original realm buyer wallet" }
    val reply = signTransactions(arrayOf(prepared.unsignedTransaction()))
    require(reply.signedPayloads.size == 1) { "Invalid realm-sale wallet reply" }
    val checked = prepared.verifySigned(reply.signedPayloads.single())
    withContext(NonCancellable) { onSigned(checked) }
    guard()
    return checked
}
