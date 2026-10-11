package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.model.GemsBuyIntent

/** Per-session prepared evidence. Public byte arrays cannot rewrite the original proof. */
class GemsBuyPayment(private val rpc: SolanaRpc, val cluster: SolanaCluster, private val mint: String) {
    private class Proof(val quote: GemsBuyIntent, val transaction: ByteArray, val height: Long)
    private val prepared = mutableMapOf<String, Proof>()
    suspend fun prepare(q: GemsBuyIntent): PreparedKeepDeposit {
        q.validate(); require(q.mint == mint) { "The quoted KEEP mint is not this network's configured mint." }
        require(rpc.genesisHash() == cluster.genesisHash) { "The payment RPC serves a different Solana network." }
        val payment = KeepDepositPayment.prepare(rpc, q.wallet, q.source, q.destination, q.mint, q.reference, q.baseUnits, q.decimals)
        val height = requireNotNull(payment.lastValidBlockHeight) { "Payment blockhash expiry is unavailable." }
        check(rpc.confirmedBlockHeight() <= height) { "The payment blockhash expired." }
        synchronized(prepared) { prepared[q.id] = Proof(q, payment.transaction.copyOf(), height) }
        return payment
    }
    private fun proof(transaction: ByteArray, q: GemsBuyIntent): Proof = synchronized(prepared) {
        requireNotNull(prepared[q.id]) { "Review and prepare this wallet payment first." }.also {
            require(it.quote == q && it.transaction.contentEquals(transaction)) { "The prepared wallet purchase changed." }
        }
    }
    fun validatePrepared(transaction: ByteArray, q: GemsBuyIntent) { proof(transaction, q) }
    /** Exact message AND Ed25519 signature, unlike the legacy rail's permitted compute-budget extension. */
    fun signedSignature(transaction: ByteArray, q: GemsBuyIntent, signed: ByteArray): String {
        val original = proof(transaction, q).transaction
        val signature = paymentTransactionSignature(original, signed, q.wallet)
        val checked = semanticPaymentSignature(original, signed, q.wallet)
        require(checked.mutation == TransactionMutation.NONE && signature.contentEquals(checked.signature))
        return base58(signature)
    }
    suspend fun requireLive(transaction: ByteArray, q: GemsBuyIntent) {
        val proof = proof(transaction, q)
        require(rpc.genesisHash() == cluster.genesisHash) { "The payment RPC serves a different Solana network." }
        check(rpc.confirmedBlockHeight() <= proof.height) { "The payment blockhash expired." }
    }
    /** Only the original, exact signed bytes are relayed; the caller persists and rechecks identity first. */
    suspend fun broadcast(transaction: ByteArray, q: GemsBuyIntent, signed: ByteArray, signature: String) {
        require(signedSignature(transaction, q, signed) == signature)
        rpc.sendTransaction(signed.copyOf(), signature)
    }
}
