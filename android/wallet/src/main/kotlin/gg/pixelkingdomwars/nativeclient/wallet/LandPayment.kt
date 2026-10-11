package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger

/** Advisory funding estimate (web `auth/landPayment.ts`); the program and the deposit watcher stay authoritative. */
data class LandFundingEstimate(
    val paymentLamports: BigInteger,
    val networkFeeLamports: BigInteger,
    val accountRentLamports: BigInteger,
    val balanceLamports: BigInteger,
) {
    val requiredLamports: BigInteger get() = paymentLamports + networkFeeLamports + accountRentLamports
    val funded: Boolean get() = balanceLamports >= requiredLamports
}

data class PreparedLandPayment(val transaction: ByteArray, val message: ByteArray, val estimate: LandFundingEstimate)

/** Builds and prices the reserved land payment before handing control to a wallet. */
object LandPayment {
    /** Anchor discriminator + Player fields in shardkeep-core/src/lib.rs (Borsh): 8 + 32 + 8 + 1 + 1 + 1. */
    const val ENTRY_PLAYER_ACCOUNT_BYTES = 8 + 32 + 8 + 1 + 1 + 1

    suspend fun prepare(rpc: SolanaRpc, addresses: ChainAddresses, wallet: String, reference: String, purchaseKind: String, amountLamports: BigInteger): PreparedLandPayment {
        require(purchaseKind == "entry" || purchaseKind == "deed") { "Unknown land purchase kind" }
        require(amountLamports.signum() > 0) { "The reserved price is missing" }
        val payer = publicKeyBytes(wallet); val referenceKey = publicKeyBytes(reference)
        val instruction = if (purchaseKind == "entry") {
            val pda = ShardkeepCore.playerPda(payer, addresses)
            ShardkeepCore.payEntry(payer, pda, referenceKey, addresses)
        } else ShardkeepCore.buyDeed(payer, referenceKey, amountLamports, addresses)
        val blockhash = rpc.latestBlockhash()
        val balance = rpc.balanceLamports(wallet)
        val rent = if (purchaseKind == "entry") {
            val pda = base58(instruction.keys[2].key)
            if (rpc.accountExists(pda)) BigInteger.ZERO else rpc.minimumBalanceForRentExemption(ENTRY_PLAYER_ACCOUNT_BYTES)
        } else BigInteger.ZERO
        val message = LegacyTransaction.message(payer, blockhash, listOf(instruction))
        val fee = rpc.feeForMessage(message)
        val transaction = LegacyTransaction.unsigned(payer, blockhash, listOf(instruction))
        validateTransactionSigner(transaction, wallet)
        return PreparedLandPayment(transaction, message, LandFundingEstimate(amountLamports, fee, rent, balance))
    }
}
