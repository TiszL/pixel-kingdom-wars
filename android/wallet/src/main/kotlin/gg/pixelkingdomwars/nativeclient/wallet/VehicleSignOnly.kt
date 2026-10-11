package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.mobilewalletadapter.clientlib.AdapterOperations
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject

/** Called inside an established MWA association. Authorization/setup failures do
 * not spend the durable attempt; every invoked sign remains an uncertain effect. */
internal suspend fun AdapterOperations.signVehicleInSession(prepared:PreparedVehicle,authorizedAccount:ByteArray?,
    guard:()->Unit,beforeWallet:suspend ()->Unit,onSigned:suspend (JsonObject)->Unit):JsonObject {
    guard()
    require(authorizedAccount!=null&&authorizedAccount.contentEquals(publicKeyBytes(prepared.wallet))) {
        "Approve with the original vehicle wallet"
    }
    val unsigned=prepared.unsignedTransaction()
    beforeWallet();guard()
    val reply=signTransactions(arrayOf(unsigned))
    require(reply.signedPayloads.size==1) { "Invalid vehicle wallet reply" }
    val wire=prepared.verifySigned(reply.signedPayloads.single())
    withContext(NonCancellable) { onSigned(wire) }
    guard();return wire
}
