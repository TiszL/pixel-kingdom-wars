package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.BasePurchaseOffer
import gg.pixelkingdomwars.nativeclient.network.SecretStore
import gg.pixelkingdomwars.nativeclient.wallet.KeepDepositPayment
import gg.pixelkingdomwars.nativeclient.wallet.SignatureLanding
import java.time.Instant
import kotlinx.serialization.json.*

/** Draft is durable before quote POST; a full quote is durable before wallet handoff. [attemptedAtMs] is the
 * wall-clock start of the wallet attempt; null on a purchase saved before the field existed and on one that became
 * attempted only because the server reported a signature. [walletEndedAtMs] is when the wallet step ended (it
 * answered, failed uncertainly, or a signature was first recorded) and [lastValidBlockHeight] is the last block
 * height the prepared payment's blockhash is valid at; both are null on older journals. */
data class SavedBasePurchase(val request: BasePurchaseRequest, val offer: BasePurchaseOffer,
    val purchase: BasePurchaseState? = null, val attempted: Boolean = false, val signature: String? = null,
    val attemptedAtMs: Long? = null, val walletEndedAtMs: Long? = null, val lastValidBlockHeight: Long? = null) {
    /** Leg 1 of [UnpaidAttempt]: the server ended THIS attempted quote unpaid. Only `expired` is unpaid: a `failed`
     * purchase always carries the finalized transaction of funds the server RECEIVED and is never retired. */
    val unpaidEnd: Boolean get() = attempted && purchase != null && purchase.status == "expired" &&
        purchase.paymentSignature == null && purchase.txSignature == null
    /** Legs 1 and 2: ended unpaid, and the attempt is past the margin. */
    fun unpaidAttemptEnded(nowMs: Long): Boolean = unpaidEnd &&
        UnpaidAttempt.oldEnough(attemptedAtMs, walletEndedAtMs, Instant.parse(requireNotNull(purchase).quote.payableUntil).toEpochMilli(), nowMs)
}

class BasePurchaseStore(private val secret: SecretStore, private val wallet: String, private val origin: String, private val cluster: String) {
    @Synchronized fun read(): SavedBasePurchase? = secret.read()?.let {
        val raw = Json.parseToJsonElement(it).jsonObject; val c = BasePurchaseContract
        // The three stamps are absent on a journal written before they existed (see [UnpaidAttempt] for each fallback).
        c.keys(JsonObject(raw - setOf("attemptedAtMs", "walletEndedAtMs", "lastValidBlockHeight")), "version", "wallet", "origin", "cluster", "request", "offer", "purchase", "attempted", "signature")
        fun stamp(key: String) = raw[key]?.let { requireNotNull((it as? JsonPrimitive)?.takeUnless { p -> p.isString }?.longOrNull) }
        require(raw["version"] == JsonPrimitive(1) && c.text(raw, "wallet") == wallet && c.text(raw, "origin") == origin && c.text(raw, "cluster") == cluster)
        SavedBasePurchase(BasePurchaseRequest.from(c.obj(raw, "request")), Json.decodeFromJsonElement<BasePurchaseOffer>(raw.getValue("offer")),
            if (raw["purchase"] == JsonNull) null else BasePurchaseState.from(c.obj(raw, "purchase")), c.flag(raw, "attempted"), c.optional(raw, "signature"),
            stamp("attemptedAtMs"), stamp("walletEndedAtMs"), stamp("lastValidBlockHeight")).also(::validate)
    }
    private fun validate(saved: SavedBasePurchase) {
        saved.offer.validate(); require(saved.request == saved.offer.request(saved.request.key))
        require(saved.purchase != null || !saved.attempted && saved.signature == null)
        require(saved.attemptedAtMs == null || saved.attempted && saved.attemptedAtMs >= 0)
        require(saved.walletEndedAtMs == null || saved.attempted && saved.walletEndedAtMs >= 0)
        require(saved.lastValidBlockHeight == null || saved.attempted && saved.lastValidBlockHeight > 0)
        saved.purchase?.let { p ->
            require(BasePurchaseState.from(p.raw) == p && p.quote.request == saved.request && p.quote.wallet == wallet && p.quote.rail.cluster == cluster)
            val quotedCostShards = p.quote.quotedCostShards
            require(p.quote.amountLamports == saved.offer.amountLamports && (quotedCostShards == null ||
                quotedCostShards.toBigInteger() <= requireNotNull(saved.offer.maxCostShards).toBigInteger()))
            require(p.quote.energyQuantity == saved.offer.energyQuantity) { "The energy quantity differs from the original reviewed offer." }
            require(p.quote.rail.directLamports == saved.offer.directLamports && p.quote.rail.splitLamports == saved.offer.splitLamports)
            val signatures = listOfNotNull(saved.signature, p.paymentSignature, p.txSignature)
            require(signatures.all(KeepDepositPayment::validSignature) && signatures.distinct().size <= 1)
            require(signatures.isEmpty() || saved.attempted && saved.signature != null)
            require(p.status != "credited" || saved.attempted)
        }
    }
    private fun write(saved: SavedBasePurchase): SavedBasePurchase {
        validate(saved)
        secret.write(buildJsonObject {
            put("version", 1); put("wallet", wallet); put("origin", origin); put("cluster", cluster)
            put("request", saved.request.raw); put("offer", Json.encodeToJsonElement(saved.offer))
            put("purchase", saved.purchase?.raw ?: JsonNull); put("attempted", saved.attempted); put("signature", saved.signature?.let(::JsonPrimitive) ?: JsonNull)
            saved.attemptedAtMs?.let { put("attemptedAtMs", it) }
            saved.walletEndedAtMs?.let { put("walletEndedAtMs", it) }
            saved.lastValidBlockHeight?.let { put("lastValidBlockHeight", it) }
        }.toString()); return saved
    }
    @Synchronized fun draft(request: BasePurchaseRequest, offer: BasePurchaseOffer): SavedBasePurchase {
        require(read() == null) { "Finish the original saved purchase before creating another." }
        return write(SavedBasePurchase(request, offer))
    }
    @Synchronized fun adopt(purchase: BasePurchaseState): SavedBasePurchase {
        val old = requireNotNull(read()); require(purchase.quote.request == old.request)
        old.purchase?.let { previous ->
            require(previous.quote == purchase.quote) { "The server changed the original quote. Keep this purchase for support." }
            if (previous.status == "credited") require(previous == purchase) { "The accepted purchase receipt changed." }
            if (previous.paymentSignature != null) require(purchase.paymentSignature == previous.paymentSignature || purchase.txSignature == previous.paymentSignature)
            if (previous.txSignature != null) require(purchase.txSignature == previous.txSignature)
        }
        val signature = old.signature ?: purchase.txSignature ?: purchase.paymentSignature
        return write(old.copy(purchase = purchase, attempted = old.attempted || signature != null || purchase.status == "credited", signature = signature))
    }
    /** [lastValidBlockHeight] belongs to the blockhash of the payment just prepared for this attempt. */
    @Synchronized fun attempted(quote: BasePurchaseQuote, nowMs: Long, lastValidBlockHeight: Long? = null): SavedBasePurchase {
        val old = requireNotNull(read()); require(old.purchase?.quote == quote && !old.attempted && old.purchase.status == "pending")
        return write(old.copy(attempted = true, attemptedAtMs = nowMs, walletEndedAtMs = null, lastValidBlockHeight = lastValidBlockHeight))
    }
    /** A signature is recorded only from the wallet step, so it also stamps that step's end (never moved back). */
    @Synchronized fun recordSignature(quote: BasePurchaseQuote, signature: String, nowMs: Long): SavedBasePurchase {
        val old = requireNotNull(read()); require(old.purchase?.quote == quote && old.attempted && (old.signature == null || old.signature == signature))
        return write(old.copy(signature = signature, walletEndedAtMs = maxOf(old.walletEndedAtMs ?: nowMs, nowMs)))
    }
    /** The wallet step ended without a verdict (timeout, dropped association, uncertain failure): the margin of
     * [UnpaidAttempt] runs from here, because the wallet could broadcast until now. */
    @Synchronized fun walletEnded(quote: BasePurchaseQuote, nowMs: Long): SavedBasePurchase {
        val old = requireNotNull(read()); require(old.purchase?.quote == quote && old.attempted)
        return write(old.copy(walletEndedAtMs = maxOf(old.walletEndedAtMs ?: nowMs, nowMs)))
    }
    @Synchronized fun refusedBeforeSignature(quote: BasePurchaseQuote): SavedBasePurchase {
        val old = requireNotNull(read()); require(old.purchase?.quote == quote && old.purchase.status == "pending" && old.attempted && old.signature == null)
        return write(old.copy(attempted = false, attemptedAtMs = null, walletEndedAtMs = null, lastValidBlockHeight = null))
    }
    @Synchronized fun finish(key: String, hydrated: Boolean) {
        val old = requireNotNull(read()); require(old.request.key == key)
        // Pending quotes still reserve the original target. Only server-proven terminal
        // unpaid quotes can retire; an attempted expired/failed payment is not refunded and
        // never finishes here — its only other exit is [retireUnpaidAttempt].
        require(old.purchase != null && (
            old.purchase.status == "credited" && hydrated ||
                !old.attempted && old.purchase.status in setOf("expired", "failed")
            )) { "Recover the original payment before starting another." }
        secret.clear()
    }
    /** The only exit for an attempted payment that was never credited: every leg of [UnpaidAttempt], checked here
     * again. [latest] is the purchase the server just returned; [landing] is the cluster's verdict on the recorded
     * signature and must be null when none was recorded. */
    @Synchronized fun retireUnpaidAttempt(latest: BasePurchaseState, nowMs: Long, landing: SignatureLanding?) {
        val old = requireNotNull(read())
        require(latest == old.purchase && old.unpaidAttemptEnded(nowMs) && UnpaidAttempt.cleared(old.signature, landing, old.lastValidBlockHeight)) { "Recover the original payment before starting another." }
        secret.clear()
    }
    @Synchronized fun cancelUnquoted(receipt: BasePurchaseCancellation) {
        require(BasePurchaseCancellation.from(receipt.raw) == receipt && receipt.cancelled && receipt.wallet == wallet)
        val saved = requireNotNull(read())
        require(saved.request.key == receipt.key && saved.purchase == null && !saved.attempted && saved.signature == null)
        secret.clear()
    }
}
