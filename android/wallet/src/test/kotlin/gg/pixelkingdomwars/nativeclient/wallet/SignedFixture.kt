package gg.pixelkingdomwars.nativeclient.wallet

import org.bouncycastle.math.ec.rfc8032.Ed25519

/** A market-shaped payment (two System transfers, the reference on the seller leg) whose fee payer is a fixed
 * TEST key, so tests can return replies that are validly signed yet altered — the only way to prove a rejection
 * comes from the specific check and not from a bad signature. The seed is a test constant, not a secret. */
internal class SignedFixture {
    private val seed = ByteArray(32) { (it + 1).toByte() }
    val publicKey: ByteArray = ByteArray(32).also { Ed25519.generatePublicKey(seed, 0, it, 0) }
    val wallet: String = base58(publicKey)
    val seller = ByteArray(32) { 11 }; val treasury = ByteArray(32) { 12 }; val reference = ByteArray(32) { 13 }; val blockhash = ByteArray(32) { 14 }
    private val systemProgram = ByteArray(32)
    private val computeBudgetProgram = publicKeyBytes("ComputeBudget111111111111111111111111111111")
    private fun le(value: Long, bytes: Int) = ByteArray(bytes) { (value shr (8 * it)).toByte() }

    fun transfer(to: ByteArray, lamports: Long, withReference: Boolean = false) = Instruction(systemProgram, buildList {
        add(AccountMeta(publicKey, signer = true, writable = true)); add(AccountMeta(to, signer = false, writable = true))
        if (withReference) add(AccountMeta(reference, signer = false, writable = false))
    }, byteArrayOf(2, 0, 0, 0) + le(lamports, 8))
    fun transfers(sellerLamports: Long = 190000, seller: ByteArray = this.seller) = listOf(transfer(seller, sellerLamports, withReference = true), transfer(treasury, 10000))
    /** A raw ComputeBudget instruction; [unitPrice] is SetComputeUnitPrice (3, u64 µlamports), [unitLimit] SetComputeUnitLimit (2, u32). */
    fun budget(data: ByteArray, keys: List<AccountMeta> = emptyList()) = Instruction(computeBudgetProgram, keys, data)
    fun unitPrice(microLamports: Long) = budget(byteArrayOf(3) + le(microLamports, 8))
    fun unitLimit(units: Long) = budget(byteArrayOf(2) + le(units, 4))
    /** What the owner's wallet prepends on chain: SetComputeUnitPrice (3) then SetComputeUnitLimit (2). */
    val computeBudget = listOf(unitPrice(375000), unitLimit(200000))

    val unsigned: ByteArray = LegacyTransaction.unsigned(publicKey, blockhash, transfers())
    /** A complete transaction over [message], signed by the test key unless [signature] overrides it. */
    fun signedMessage(message: ByteArray, signature: ByteArray? = null): ByteArray =
        byteArrayOf(1) + (signature ?: ByteArray(64).also { Ed25519.sign(seed, 0, message, 0, message.size, it, 0) }) + message
    fun signed(instructions: List<Instruction>, blockhash: ByteArray = this.blockhash, feePayer: ByteArray = publicKey): ByteArray =
        signedMessage(LegacyTransaction.message(feePayer, blockhash, instructions))
    val signedUnchanged: ByteArray = signed(transfers())
    val signedWithComputeBudget: ByteArray = signed(computeBudget + transfers())
}
