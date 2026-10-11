package gg.pixelkingdomwars.nativeclient.wallet

/** One wallet identity for one guarded signing operation; never broadcasts. */
interface WalletSigner {
    val address: String
    suspend fun signMessage(message: ByteArray): ByteArray
}

/** Signs the exact transaction without broadcasting; the caller persists its signature first. */
interface WalletTransactionSigner : WalletSigner {
    suspend fun signTransaction(serialized: ByteArray): ByteArray
}
/** Opt-in exact-payment evidence, delivered before post-wallet session guards. Never broadcasts. */
interface DurableWalletTransactionSigner : WalletTransactionSigner {
    suspend fun signTransactionWithEvidence(serialized: ByteArray, onSigned: (ByteArray) -> Unit): ByteArray
}

/** A detached MWA reply must belong to the exact request and authorized account. */
internal fun checkedDetachedSignature(request: ByteArray, publicKey: ByteArray, message: ByteArray,
                                      addresses: Array<ByteArray>, signatures: Array<ByteArray>): ByteArray {
    require(publicKey.size==32 && message.contentEquals(request)) { "The wallet changed the requested message" }
    require(addresses.size==1 && addresses.single().contentEquals(publicKey)) { "The wallet signed with a different account" }
    require(signatures.size==1 && signatures.single().size==64) { "The wallet returned an invalid signature" }
    return signatures.single().copyOf()
}
