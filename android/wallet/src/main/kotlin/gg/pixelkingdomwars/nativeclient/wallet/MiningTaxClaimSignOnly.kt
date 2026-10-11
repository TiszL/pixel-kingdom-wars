package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Exact sign-only association; retain owned bytes even after session/caller cancellation. */
internal suspend fun AdapterOperations.signMiningTaxClaimInSession(prepared: PreparedMiningTaxClaims, authorizedAccount: ByteArray?,
    guard: () -> Unit, onSigned: suspend (SignedMiningTaxClaims) -> Unit): SignedMiningTaxClaims {
    val context = currentCoroutineContext()
    fun current() { context.ensureActive(); guard() }
    current()
    require(authorizedAccount != null && authorizedAccount.contentEquals(publicKeyBytes(prepared.wallet))) { "Approve with the original tax claimant wallet" }
    val reply = signTransactions(arrayOf(prepared.unsignedTransaction()))
    require(reply.signedPayloads.size == 1) { "Invalid mining-tax wallet reply" }
    val checked = prepared.verifySigned(reply.signedPayloads.single())
    withContext(NonCancellable) { onSigned(checked) }
    current()
    return checked
}
