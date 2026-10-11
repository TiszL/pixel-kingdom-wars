package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger
import java.util.Base64
import org.bouncycastle.math.ec.rfc8032.Ed25519

/** Only verified player-signed bytes are durable evidence. No client broadcasts this incomplete transaction. */
data class SignedSkrFaucetClaim(val wire: String, val playerSignature: String, val mutation: TransactionMutation)

/** Preflight checked receiving transaction. Every byte array leaving this object is independently owned. */
class PreparedSkrFaucetClaim internal constructor(val wallet: String, val mint: String, val decimals: Int,
    val grantRaw: String, private val authority: String, unsignedWire: ByteArray) {
    private val original = unsignedWire.copyOf()
    fun unsignedTransaction(): ByteArray = original.copyOf()
    fun verifySigned(bytes: ByteArray): SignedSkrFaucetClaim {
        val owned = bytes.copyOf()
        val checked = semanticCosignedSignature(original, owned, wallet, authority)
        return SignedSkrFaucetClaim(Base64.getEncoder().encodeToString(owned), base58(checked.signature), checked.mutation)
    }
}

/** No network, clock, wallet, or server authority is trusted here. The independent profile supplies mint/decimals;
 * the generated constants pack supplies grantSkr, and the prepare response supplies grantRaw and unsignedWire. */
object SkrFaucetClaimTransaction {
    private const val TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    private const val ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
    private const val COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111"
    private val canonicalBase64 = Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")

    suspend fun prepare(wallet: String, mint: String, decimals: Int, grantRaw: String, grantSkr: String,
        unsignedWire: String): PreparedSkrFaucetClaim {
        val player = key(wallet); val mintKey = key(mint)
        require(Ed25519.validatePublicKeyFull(player, 0)) { "The fee payer must be a signing wallet" }
        require(decimals in 0..19) { "Invalid profile decimals" }
        val amount = amount(grantRaw); val tokens = amount(grantSkr)
        require(amount == tokens * BigInteger.TEN.pow(decimals)) { "The grant does not match the constants pack" }
        require(unsignedWire.length in 4..1644 && canonicalBase64.matches(unsignedWire)) { "Invalid faucet wire encoding" }
        val bytes = Base64.getDecoder().decode(unsignedWire)
        require(bytes.size <= 1232 && Base64.getEncoder().encodeToString(bytes) == unsignedWire) { "Invalid faucet wire encoding" }
        val parsed = unsignedCosignedTransaction(bytes, wallet)
        val authority = parsed.accounts[1].key
        require(!authority.contentEquals(player) && Ed25519.validatePublicKeyFull(authority, 0)) { "Invalid faucet signer" }
        require(parsed.instructions.size == 2) { "The faucet must only create the token account and transfer SKR" }
        val creation = parsed.instructions[0]; val transfer = parsed.instructions[1]
        require(creation.accounts.size == 6 && transfer.accounts.size == 5) { "Unexpected faucet account list" }
        val reference = transfer.accounts.last().key
        val playerAta = publicKeyBytes(KeepDepositPayment.sourceAta(wallet, mint))
        val treasuryAta = publicKeyBytes(KeepDepositPayment.sourceAta(base58(authority), mint))
        val token = publicKeyBytes(TOKEN); val ata = publicKeyBytes(ATA); val system = ByteArray(32)
        val expectedKeys = listOf(player, authority, mintKey, playerAta, treasuryAta, token, ata, system, reference)
        require(expectedKeys.map(::base58).distinct().size == expectedKeys.size && !reference.contentEquals(publicKeyBytes(COMPUTE_BUDGET))) {
            "The reference must be distinct from every transaction role"
        }
        require(parsed.accounts.map { base58(it.key) }.toSet() == expectedKeys.map(::base58).toSet()) { "Unexpected faucet account keys" }
        fun account(key: ByteArray, signer: Boolean = false, writable: Boolean = false) = ResolvedAccount(key, signer, writable)
        val expectedCreation = ResolvedInstruction(account(ata), listOf(account(player, true, true), account(playerAta, writable = true),
            account(player, true, true), account(mintKey), account(system), account(token)), byteArrayOf(1))
        val encodedAmount = ByteArray(8) { amount.shiftRight(it * 8).toByte() }
        val expectedTransfer = ResolvedInstruction(account(token), listOf(account(treasuryAta, writable = true), account(mintKey),
            account(playerAta, writable = true), account(authority, signer = true), account(reference)),
            byteArrayOf(12) + encodedAmount + byteArrayOf(decimals.toByte()))
        require(creation.same(expectedCreation) && transfer.same(expectedTransfer)) { "The faucet transaction differs from the reviewed grant" }
        return PreparedSkrFaucetClaim(wallet, mint, decimals, grantRaw, base58(authority), bytes)
    }

    private fun key(value: String): ByteArray {
        require(value.length in 32..44) { "Invalid faucet identity" }
        return publicKeyBytes(value).also { require(base58(it) == value) { "Noncanonical faucet identity" } }
    }
    private fun amount(value: String): BigInteger {
        require(value.length in 1..20 && value.matches(Regex("[1-9][0-9]*"))) { "Invalid faucet amount" }
        return BigInteger(value).also { require(it.bitLength() <= 64) { "Faucet amount exceeds u64" } }
    }
}
