package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.network.string
import gg.pixelkingdomwars.nativeclient.wallet.KeepDepositPayment
import gg.pixelkingdomwars.nativeclient.wallet.SignatureLanding
import java.math.BigDecimal
import java.math.BigInteger
import java.time.Instant
import kotlinx.serialization.json.*

data class MarketTradeBounds(val minPrice: BigInteger, val maxPrice: BigInteger, val pollMs: Long, val timeoutMs: Long) {
    init { require(minPrice.signum() > 0 && maxPrice >= minPrice && maxPrice.bitLength() <= 63 && pollMs > 0 && timeoutMs > 0) }
    fun price(input: String): String {
        val value = input.trim()
        require(value.length in 1..32 && value.matches(Regex("[0-9]+(?:\\.[0-9]{1,9})?"))) { "Enter a SOL price with at most nine decimal places." }
        val lamports = BigDecimal(value).movePointRight(9).toBigIntegerExact()
        require(lamports in minPrice..maxPrice) { "Use a price within the displayed market limits." }
        return lamports.toString()
    }
    companion object { fun from(catalogue: JsonObject?): MarketTradeBounds? = runCatching {
        val constants = requireNotNull(catalogue?.get("constants") as? JsonObject)
        val market = requireNotNull((constants["MARKETPLACE"] as? JsonObject)?.get("itemMarket") as? JsonObject)
        // Existing canonical payment-recovery cadence matches the web market's settle loop.
        val recovery = requireNotNull(constants["LAND_CHECKOUT_RECOVERY"] as? JsonObject)
        MarketTradeBounds(BigInteger(requireNotNull(market.string("minPriceLamports"))), BigInteger(requireNotNull(market.string("maxPriceLamports"))),
            requireNotNull(recovery.string("pollMs")).toLong(), requireNotNull(recovery.string("requestTimeoutMs")).toLong())
    }.getOrNull() }
}

/** [attemptedAtMs] is the wall-clock start of the wallet attempt; null on a purchase saved before the field existed
 * and on one that became attempted only because the server reported a signature. [walletEndedAtMs] is when the
 * wallet step ended (it answered, failed uncertainly, or a signature was first recorded) and [lastValidBlockHeight]
 * is the last block height the prepared payment's blockhash is valid at; both are null on older journals. */
data class SavedMarketPurchase(val quote: MarketQuote, val receipt: MarketReservationReceipt, val attempted: Boolean = false, val signature: String? = null,
    val attemptedAtMs: Long? = null, val walletEndedAtMs: Long? = null, val lastValidBlockHeight: Long? = null) {
    /** Leg 1 of [UnpaidAttempt]: the server ended THIS attempted reservation unpaid. */
    val unpaidEnd: Boolean get() = attempted && receipt.quote == quote && receipt.state in setOf("superseded", "cancelled") &&
        receipt.paymentSignature == null && receipt.txSignature == null
    /** Legs 1 and 2 by the DEVICE clock alone: ended unpaid and past the margin. It only decides whether one more
     * GET is worth asking; it never retires anything by itself. */
    fun unpaidAttemptDue(nowMs: Long): Boolean = unpaidEnd &&
        UnpaidAttempt.oldEnough(attemptedAtMs, walletEndedAtMs, Instant.parse(quote.payableUntil).toEpochMilli(), nowMs)
    /** The SERVER's clock on the saved receipt is the margin past the quote's payment deadline. No attempt can start
     * after `payableUntil`, so this bounds the margin even when the device clock jumped forward. */
    val serverPastMargin: Boolean get() = Instant.parse(receipt.serverNow).toEpochMilli() - Instant.parse(quote.payableUntil).toEpochMilli() >= UnpaidAttempt.MARGIN_MS
    /** Legs 1 and 2 in full: the device clock AND the server clock both put the attempt past the margin. */
    fun unpaidAttemptEnded(nowMs: Long): Boolean = unpaidAttemptDue(nowMs) && serverPastMargin
}

/** One encrypted origin/wallet/network journal; corruption never becomes an empty payment slot. */
class MarketPurchaseStore(private val secret: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    @Synchronized fun read(): SavedMarketPurchase? = secret.read()?.let {
        val raw = Json.parseToJsonElement(it).jsonObject
        require(raw["version"] == JsonPrimitive(1) && MarketContract.text(raw, "wallet") == wallet &&
            MarketContract.text(raw, "origin") == origin && MarketContract.text(raw, "cluster") == cluster)
        val quote = MarketQuote.from(requireNotNull(raw["quote"] as? JsonObject))
        val receipt = MarketReservationReceipt.from(requireNotNull(raw["receipt"] as? JsonObject))
        // Absent on a journal written before the field existed; such a purchase follows the quote-deadline rule.
        fun stamp(key: String) = raw[key]?.let { requireNotNull((it as? JsonPrimitive)?.takeUnless { p -> p.isString }?.longOrNull) }
        SavedMarketPurchase(quote, receipt, MarketContract.flag(raw, "attempted"), MarketContract.optional(raw, "signature"),
            stamp("attemptedAtMs"), stamp("walletEndedAtMs"), stamp("lastValidBlockHeight")).also(::validate)
    }
    private fun validate(saved: SavedMarketPurchase) {
        require(MarketQuote.from(saved.quote.raw) == saved.quote && MarketReservationReceipt.from(saved.receipt.raw) == saved.receipt)
        require(saved.quote == saved.receipt.quote && saved.quote.buyer == wallet && saved.quote.cluster == cluster && saved.quote.key != null)
        val signatures = listOfNotNull(saved.signature, saved.receipt.paymentSignature, saved.receipt.txSignature)
        require(signatures.all(KeepDepositPayment::validSignature) && signatures.distinct().size <= 1)
        require(signatures.isEmpty() || saved.attempted)
        require(saved.signature != null || signatures.isEmpty())
        require(saved.attemptedAtMs == null || saved.attempted && saved.attemptedAtMs >= 0)
        require(saved.walletEndedAtMs == null || saved.attempted && saved.walletEndedAtMs >= 0)
        require(saved.lastValidBlockHeight == null || saved.attempted && saved.lastValidBlockHeight > 0)
    }
    private fun write(saved: SavedMarketPurchase) {
        validate(saved)
        secret.write(buildJsonObject {
            put("version", 1); put("wallet", wallet); put("origin", origin); put("cluster", cluster)
            put("quote", saved.quote.raw); put("receipt", saved.receipt.raw); put("attempted", saved.attempted)
            put("signature", saved.signature?.let(::JsonPrimitive) ?: JsonNull)
            saved.attemptedAtMs?.let { put("attemptedAtMs", it) }
            saved.walletEndedAtMs?.let { put("walletEndedAtMs", it) }
            saved.lastValidBlockHeight?.let { put("lastValidBlockHeight", it) }
        }.toString())
    }
    /** Idempotent handover from reserve MoneyOp: a different quote can never overwrite a live payment. */
    @Synchronized fun adopt(receipt: MarketReservationReceipt): SavedMarketPurchase {
        val old = read()
        if (old != null) {
            require(receipt.quote == old.quote) { "The server returned different payment terms. The original quote is kept." }
            when (old.receipt.state) {
                "committed" -> require(receipt.state in setOf("committed", "settled"))
                "settled", "superseded", "cancelled" -> require(receipt.state == old.receipt.state && receipt.paymentSignature == old.receipt.paymentSignature &&
                    receipt.txSignature == old.receipt.txSignature && receipt.resolvedAt == old.receipt.resolvedAt)
            }
        }
        val signature = old?.signature ?: receipt.txSignature ?: receipt.paymentSignature
        return SavedMarketPurchase(receipt.quote, receipt, old?.attempted == true || signature != null, signature,
            old?.attemptedAtMs, old?.walletEndedAtMs, old?.lastValidBlockHeight).also(::write)
    }
    /** [lastValidBlockHeight] belongs to the blockhash of the payment just prepared for this attempt. */
    @Synchronized fun attempted(quote: MarketQuote, nowMs: Long, lastValidBlockHeight: Long? = null): SavedMarketPurchase {
        val old = requireNotNull(read()); require(old.quote == quote && !old.attempted && old.receipt.state == "reserved")
        return old.copy(attempted = true, attemptedAtMs = nowMs, walletEndedAtMs = null, lastValidBlockHeight = lastValidBlockHeight).also(::write)
    }
    /** A signature is recorded only from the wallet step, so it also stamps that step's end (never moved back). */
    @Synchronized fun recordSignature(quote: MarketQuote, signature: String, nowMs: Long): SavedMarketPurchase {
        val old = requireNotNull(read()); require(old.quote == quote && old.attempted && (old.signature == null || old.signature == signature))
        return old.copy(signature = signature, walletEndedAtMs = maxOf(old.walletEndedAtMs ?: nowMs, nowMs)).also(::write)
    }
    /** The wallet step ended without a verdict (timeout, dropped association, uncertain failure): the margin of
     * [UnpaidAttempt] runs from here, because the wallet could broadcast until now. */
    @Synchronized fun walletEnded(quote: MarketQuote, nowMs: Long): SavedMarketPurchase {
        val old = requireNotNull(read()); require(old.quote == quote && old.attempted)
        return old.copy(walletEndedAtMs = maxOf(old.walletEndedAtMs ?: nowMs, nowMs)).also(::write)
    }
    /** Called only on an explicit sign-only refusal before broadcast, with no recorded signed payload. */
    @Synchronized fun refusedBeforeSignature(quote: MarketQuote): SavedMarketPurchase {
        val old = requireNotNull(read()); require(old.quote == quote && old.attempted && old.signature == null && old.receipt.state == "reserved")
        return old.copy(attempted = false, attemptedAtMs = null, walletEndedAtMs = null, lastValidBlockHeight = null).also(::write)
    }
    @Synchronized fun close(quote: MarketQuote, hydrated: Boolean) {
        val old = requireNotNull(read()); require(old.quote == quote)
        require(!old.attempted || (old.receipt.state == "settled" && hydrated)) { "Recover and refresh this payment before finishing." }
        secret.clear()
    }
    /** The only exit for an attempted payment that never settled: every leg of [UnpaidAttempt], checked here again.
     * [latest] is the receipt the server just returned; [landing] is the cluster's verdict on the recorded signature
     * and must be null when none was recorded. */
    @Synchronized fun retireUnpaidAttempt(latest: MarketReservationReceipt, nowMs: Long, landing: SignatureLanding?) {
        val old = requireNotNull(read())
        require(latest == old.receipt && old.unpaidAttemptEnded(nowMs) && UnpaidAttempt.cleared(old.signature, landing, old.lastValidBlockHeight)) { "Recover and refresh this payment before finishing." }
        secret.clear()
    }
}
