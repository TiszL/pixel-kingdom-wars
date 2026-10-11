package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.telemetry.reportWalletFailure
import gg.pixelkingdomwars.nativeclient.wallet.*
import kotlinx.coroutines.CancellationException

/** The land rail is the shared [ExternalPaymentRail] over the wallet app ([WalletLogin.pay]): the wallet's own send
 * first, and the same-session sign-only fallback whose checked bytes this app relays once, signature persisted
 * first. Only the copy differs: a classified wallet failure speaks the land checkout's two sentences
 * ([landPaymentNotice]); this app's own stop keeps its own message. */
class LandPaymentWallet(
    private val payer: WalletPayer,
    private val rpc: SolanaRpc,
    private val report: (WalletFailureReason) -> Unit = ::reportWalletFailure,
) : LandSigner {
    override suspend fun signAndSend(transaction: ByteArray, cluster: SolanaCluster, wallet: String, recordSignature: (ByteArray) -> Unit): ByteArray {
        var signature: ByteArray? = null
        val tracking = WalletPayer { tx, net, owner, onSent -> payer.pay(tx, net, owner) { signature = it.copyOf(); onSent(it) }.also { signature = it.signature.copyOf() } }
        try {
            ExternalPaymentRail(tracking, rpc, report).pay(transaction, cluster, wallet, guard = {}, recordSignature = { recordSignature(requireNotNull(signature).copyOf()) })
            return requireNotNull(signature)
        } catch (e: CancellationException) { throw e }
        catch (e: WalletPaymentException) {
            val reason = e.reason ?: throw e
            throw WalletPaymentException(landPaymentNotice(e.refusedBeforeBroadcast, reason), e.refusedBeforeBroadcast, reason = reason)
        }
    }
}
