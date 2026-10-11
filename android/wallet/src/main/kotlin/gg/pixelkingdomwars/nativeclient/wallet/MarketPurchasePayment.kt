package gg.pixelkingdomwars.nativeclient.wallet

import gg.pixelkingdomwars.nativeclient.model.MarketQuote
import java.math.BigInteger

/** [lastValidBlockHeight] is the last block height the named blockhash is valid at; the app saves it with the
 * attempt so a later null signature status can be proven final ([SolanaRpc.signatureLanding]). */
data class PreparedMarketPurchase(val transaction: ByteArray, val feeLamports: BigInteger, val lastValidBlockHeight: Long? = null)

/** Exact web buildMarketBuyTx: two atomic SOL legs, reference on the seller leg only. */
object MarketPurchasePayment {
    fun instructions(quote: MarketQuote): List<Instruction> {
        require(MarketQuote.from(quote.raw) == quote) { "The saved market quote changed." }
        val addresses = listOf(quote.buyer, quote.seller, quote.feeTreasury, quote.reference)
        require(addresses.all(KeepDepositPayment::validAddress) && addresses.distinct().size == addresses.size)
        fun transfer(to: String, amount: BigInteger, reference: Boolean): Instruction {
            require(amount.signum() >= 0 && amount.bitLength() <= 64)
            val data = byteArrayOf(2, 0, 0, 0) + ByteArray(8) { i -> amount.shiftRight(8 * i).and(BigInteger.valueOf(255)).toByte() }
            return Instruction(ByteArray(32), buildList {
                add(AccountMeta(publicKeyBytes(quote.buyer), true, true)); add(AccountMeta(publicKeyBytes(to), false, true))
                if (reference) add(AccountMeta(publicKeyBytes(quote.reference), false, false))
            }, data)
        }
        return listOf(transfer(quote.seller, quote.sellerLamports.toBigInteger(), true), transfer(quote.feeTreasury, quote.feeLamports.toBigInteger(), false))
    }
    suspend fun prepare(rpc: SolanaRpc, quote: MarketQuote): PreparedMarketPurchase {
        val instructions = instructions(quote)
        val recent = rpc.recentBlockhash(); val blockhash = recent.hash
        val buyer = publicKeyBytes(quote.buyer)
        val fee = rpc.feeForMessage(LegacyTransaction.message(buyer, blockhash, instructions))
        check(rpc.balanceLamports(quote.buyer) >= quote.priceLamports.toBigInteger() + fee) { "Your wallet needs the quoted SOL price plus the network fee." }
        return PreparedMarketPurchase(LegacyTransaction.unsigned(buyer, blockhash, instructions), fee, recent.lastValidBlockHeight)
    }
}
