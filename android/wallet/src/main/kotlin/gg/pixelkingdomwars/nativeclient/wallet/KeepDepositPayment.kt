package gg.pixelkingdomwars.nativeclient.wallet

import com.solana.publickey.ProgramDerivedAddress
import com.solana.publickey.SolanaPublicKey
import java.math.BigInteger

/** [lastValidBlockHeight] is the last block height the named blockhash is valid at; the app saves it with the
 * attempt so a later null signature status can be proven final ([SolanaRpc.signatureLanding]). */
data class PreparedKeepDeposit(val transaction: ByteArray, val feeLamports: BigInteger, val lastValidBlockHeight: Long? = null)

/** Canonical web lib/chain.ts buildKeepDepositTx, SPL Token TransferChecked (instruction 12).
 * No ATA creation or economic tuning: the server quote provides the custody destination. */
object KeepDepositPayment {
    private const val TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
    private const val ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"

    fun validAddress(value: String): Boolean = value.length in 32..44 && runCatching { publicKeyBytes(value); true }.getOrDefault(false)
    fun validSignature(value: String): Boolean = value.length in 64..88 && runCatching {
        val bytes = base58Decode(value); bytes.size == 64 && base58(bytes) == value
    }.getOrDefault(false)

    suspend fun sourceAta(wallet: String, mint: String): String = base58(ProgramDerivedAddress.find(
        listOf(publicKeyBytes(wallet), publicKeyBytes(TOKEN_PROGRAM), publicKeyBytes(mint)),
        SolanaPublicKey(publicKeyBytes(ASSOCIATED_TOKEN_PROGRAM)),
    ).getOrThrow().bytes)

    fun instruction(wallet: String, source: String, destination: String, mint: String, reference: String,
        amountBaseUnits: BigInteger, decimals: Int): Instruction {
        require(decimals in 0..19 && amountBaseUnits.signum() > 0 && amountBaseUnits.bitLength() <= 64) { "Invalid KEEP transfer amount" }
        val values = listOf(wallet, source, destination, mint, reference)
        require(values.all(::validAddress) && values.distinct().size == values.size) { "Invalid KEEP deposit accounts" }
        val amount = ByteArray(8) { i -> amountBaseUnits.shiftRight(8 * i).and(BigInteger.valueOf(255)).toByte() }
        return Instruction(publicKeyBytes(TOKEN_PROGRAM), listOf(
            AccountMeta(publicKeyBytes(source), false, true), AccountMeta(publicKeyBytes(mint), false, false),
            AccountMeta(publicKeyBytes(destination), false, true), AccountMeta(publicKeyBytes(wallet), true, false),
            AccountMeta(publicKeyBytes(reference), false, false),
        ), byteArrayOf(12) + amount + byteArrayOf(decimals.toByte()))
    }

    suspend fun prepare(rpc: SolanaRpc, wallet: String, source: String, destination: String, mint: String,
        reference: String, amountBaseUnits: BigInteger, decimals: Int): PreparedKeepDeposit {
        require(sourceAta(wallet, mint) == source) { "The quoted KEEP source is not this wallet's token account" }
        val ix = instruction(wallet, source, destination, mint, reference, amountBaseUnits, decimals)
        val recent = rpc.recentBlockhash(); val blockhash = recent.hash
        val message = LegacyTransaction.message(publicKeyBytes(wallet), blockhash, listOf(ix))
        val fee = rpc.feeForMessage(message)
        check(rpc.balanceLamports(wallet) >= fee) { "Add SOL to your wallet for the network fee." }
        check(rpc.tokenBalance(source, decimals) >= amountBaseUnits) { "Your wallet has insufficient on-chain KEEP." }
        return PreparedKeepDeposit(LegacyTransaction.unsigned(publicKeyBytes(wallet), blockhash, listOf(ix)), fee, recent.lastValidBlockHeight)
    }
}
