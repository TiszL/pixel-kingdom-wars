package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext

/** Exact sign-only association for the devnet test SKR claim: the faucet authority co-signs and sends it server-side,
 *  so the wallet only signs. Retain the verified bytes even after session/caller cancellation. */
internal suspend fun AdapterOperations.signSkrFaucetClaimInSession(prepared: PreparedSkrFaucetClaim, authorizedAccount: ByteArray?,
    guard: () -> Unit, onSigned: suspend (SignedSkrFaucetClaim) -> Unit): SignedSkrFaucetClaim {
    val context = currentCoroutineContext()
    fun current() { context.ensureActive(); guard() }
    current()
    require(authorizedAccount != null && authorizedAccount.contentEquals(publicKeyBytes(prepared.wallet))) { "Approve with the wallet that claims the test SKR" }
    val reply = signTransactions(arrayOf(prepared.unsignedTransaction()))
    require(reply.signedPayloads.size == 1) { "Invalid test SKR wallet reply" }
    val checked = prepared.verifySigned(reply.signedPayloads.single())
    withContext(NonCancellable) { onSigned(checked) }
    current()
    return checked
}
