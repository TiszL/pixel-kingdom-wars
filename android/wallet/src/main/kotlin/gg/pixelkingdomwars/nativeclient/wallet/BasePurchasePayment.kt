package gg.pixelkingdomwars.nativeclient.wallet

import java.math.BigInteger

/** Production deposit wire kinds. Mine also covers paid Gold Forge upgrades (D-057). */
enum class BasePurchaseKind(val wire: String) { ENERGY("energy"), ENERGY_PACK("energy_pack"), BUILDER("builder"), EXPANSION("expansion"), MINE("mine"), SHIELD("shield"), WARZONE_SHIELD("warzone_shield") }

/** [lastValidBlockHeight] is the last block height the named blockhash is valid at; the app saves it with the
 * attempt so a later null signature status can be proven final ([SolanaRpc.signatureLanding]). */
data class PreparedBasePurchase(val transaction: ByteArray, val feeLamports: BigInteger, val lastValidBlockHeight: Long? = null)

/** Exact current web useSolPurchase rails. The caller owns durable original-base
 * consent and the server quote; this layer only prepares its one unsigned payment. */
object BasePurchasePayment {
    fun instruction(addresses: ChainAddresses, kind: BasePurchaseKind, wallet: String,
        reference: String, amountLamports: BigInteger, destination: String?): Instruction {
        require(amountLamports.signum() > 0 && amountLamports.bitLength() <= 64) { "The quoted payment is not a positive u64 amount." }
        val payer = publicKeyBytes(wallet)
        val ref = publicKeyBytes(reference)
        val reserved = listOf(addresses.coreProgram, addresses.config, addresses.treasuryLiquidity,
            addresses.treasuryDev, addresses.treasuryOps, base58(ByteArray(32)))
        require(wallet != reference && wallet !in reserved && reference !in reserved) { "Payment accounts overlap." }
        require(kind != BasePurchaseKind.WARZONE_SHIELD) { "A Warzone shield requires both payment legs in one transaction." }
        return if (kind in setOf(BasePurchaseKind.BUILDER, BasePurchaseKind.SHIELD, BasePurchaseKind.ENERGY, BasePurchaseKind.ENERGY_PACK)) {
            require(destination == null) { "This purchase uses the configured program treasuries." }
            when (kind) {
                BasePurchaseKind.BUILDER -> ShardkeepCore.buyBuilder(payer, ref, amountLamports, addresses)
                BasePurchaseKind.SHIELD -> ShardkeepCore.buyShield(payer, ref, amountLamports, addresses)
                BasePurchaseKind.ENERGY -> ShardkeepCore.buyEnergy(payer, ref, amountLamports, addresses)
                BasePurchaseKind.ENERGY_PACK -> ShardkeepCore.buyEnergyPack(payer, ref, amountLamports, addresses)
                else -> error("Unsupported buy_sink purchase")
            }
        } else {
            // D-057 and canonical buildSolPaymentTx: the whole amount goes to
            // reviewed liquidity, with the deposit reference as a read-only account.
            require(destination == addresses.treasuryLiquidity) { "The quote does not name the configured liquidity wallet." }
            val data = byteArrayOf(2, 0, 0, 0) + ByteArray(8) { i ->
                amountLamports.shiftRight(8 * i).and(BigInteger.valueOf(255)).toByte()
            }
            Instruction(ByteArray(32), listOf(AccountMeta(payer, true, true),
                AccountMeta(publicKeyBytes(destination), false, true), AccountMeta(ref, false, false)), data)
        }
    }

    fun instructions(addresses: ChainAddresses, kind: BasePurchaseKind, wallet: String,
        reference: String, amountLamports: BigInteger, destination: String?,
        directLamports: BigInteger? = null, splitLamports: BigInteger? = null): List<Instruction> {
        if (kind != BasePurchaseKind.WARZONE_SHIELD) {
            require(directLamports == null && splitLamports == null)
            return listOf(instruction(addresses, kind, wallet, reference, amountLamports, destination))
        }
        val direct = requireNotNull(directLamports); val split = requireNotNull(splitLamports)
        require(direct.signum() > 0 && split.signum() > 0 && direct + split == amountLamports && amountLamports.bitLength() <= 64)
        // Canonical web buildWarzoneShieldTx: direct liquidity transfer first, then buy_sink(kind6), same reference.
        return listOf(instruction(addresses, BasePurchaseKind.EXPANSION, wallet, reference, direct, destination),
            ShardkeepCore.buyWarzoneShield(publicKeyBytes(wallet), publicKeyBytes(reference), split, addresses))
    }

    suspend fun prepare(rpc: SolanaRpc, addresses: ChainAddresses, kind: BasePurchaseKind,
        wallet: String, reference: String, amountLamports: BigInteger, destination: String?,
        directLamports: BigInteger? = null, splitLamports: BigInteger? = null): PreparedBasePurchase {
        val instructions = instructions(addresses, kind, wallet, reference, amountLamports, destination, directLamports, splitLamports)
        val payer = publicKeyBytes(wallet)
        val recent = rpc.recentBlockhash(); val blockhash = recent.hash
        val fee = rpc.feeForMessage(LegacyTransaction.message(payer, blockhash, instructions))
        check(rpc.balanceLamports(wallet) >= amountLamports + fee) { "Your wallet needs the quoted SOL price plus the network fee." }
        val transaction = LegacyTransaction.unsigned(payer, blockhash, instructions)
        validateTransactionSigner(transaction, wallet)
        return PreparedBasePurchase(transaction, fee, recent.lastValidBlockHeight)
    }
}
