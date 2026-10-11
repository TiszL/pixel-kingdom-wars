package gg.pixelkingdomwars.nativeclient.mining

import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import java.math.BigInteger
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val taxReviewJson = Json { encodeDefaults = true }
private val taxReviewU64 = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
internal fun taxReviewCount(n: Long) { require(n in 0..9_007_199_254_740_991L) }
private fun amount(v: String): BigInteger {
    require(v.length in 1..20 && v.matches(Regex("0|[1-9][0-9]{0,19}")))
    return v.toBigInteger().also { require(it <= taxReviewU64) }
}
private fun address(v: String) {
    require(v.length in 32..44); val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; var n = BigInteger.ZERO
    for (c in v) { val d = alphabet.indexOf(c); require(d >= 0); n = n * BigInteger.valueOf(58) + BigInteger.valueOf(d.toLong()) }
    require(n.signum() > 0 && (n.bitLength() + 7) / 8 + v.takeWhile { it == '1' }.length == 32)
}
internal fun taxReviewKey(v: String) {
    require(v.length == 36 && (v.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) || v == "00000000-0000-0000-0000-000000000000" || v == "ffffffff-ffff-ffff-ffff-ffffffffffff"))
}
private fun hash(v: String) { require(v.length == 64 && v.matches(Regex("[0-9a-f]{64}"))) }
private fun instant(v: String): Instant {
    require(v.length == 24 && v.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")))
    return Instant.parse(v).also { require(DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(it) == v) }
}
private fun <T> decode(raw: JsonObject, serializer: DeserializationStrategy<T>): T {
    var nodes = 0
    fun bound(v: JsonElement, depth: Int) {
        require(++nodes <= 256 && depth <= 8)
        when (v) {
            is JsonObject -> { require(v.size <= 32); v.forEach { (k, x) -> require(k.length <= 64); bound(x, depth + 1) } }
            is JsonArray -> error("Unexpected tax review array")
            is JsonPrimitive -> require(v.content.length <= 2464)
        }
    }
    bound(raw, 0); strictPrimitives(raw, serializer.descriptor)
    require(raw["reason"] != JsonNull) { "Optional reason cannot be null" }
    return taxReviewJson.decodeFromJsonElement(serializer, raw)
}
@Serializable data class MiningTaxClaimsReviewSource(val genesisHash: String, val programId: String, val reviewedDeploymentSlot: Long,
    val reviewedProgramDataSha256: String, val snapshotSlot: Long, val feeSlot: Long, val blockHeight: Long, val lastValidBlockHeight: Long) {
    fun validate() {
        address(genesisHash); address(programId); hash(reviewedProgramDataSha256)
        listOf(reviewedDeploymentSlot, snapshotSlot, feeSlot, blockHeight, lastValidBlockHeight).forEach(::taxReviewCount)
        require(reviewedDeploymentSlot <= snapshotSlot && snapshotSlot <= feeSlot && blockHeight <= lastValidBlockHeight)
    }
}
/** Observations of saved consent, never a signing capability or finality proof. */
@Serializable data class MiningTaxClaimsReview(val wallet: String, val idempotencyKey: String, val claimId: String, val ordinal: Long,
    val status: String, val messageSha256: String, val blockhash: String, val preparedAt: String, val expiresAt: String, val observedAt: String,
    val feeLamports: String, val rentLamports: String, val totalLamports: String, val paidFeeLamports: String, val paidRentLamports: String,
    val source: MiningTaxClaimsReviewSource, val currentSigningAuthorized: Boolean, val relayAuthorized: Boolean, val settlementAuthorized: Boolean) {
    fun validate() {
        address(wallet); taxReviewKey(idempotencyKey); taxReviewKey(claimId); require(ordinal in 0..1 && status == "ready"); hash(messageSha256); address(blockhash)
        require(!currentSigningAuthorized && !relayAuthorized && !settlementAuthorized)
        require(instant(observedAt) >= instant(preparedAt) && instant(observedAt) < instant(expiresAt)); source.validate()
        listOf(feeLamports, rentLamports, totalLamports, paidFeeLamports, paidRentLamports).forEach { amount(it) }
        require(amount(feeLamports) + amount(rentLamports) == amount(totalLamports))
    }
}
@Serializable data class MiningTaxClaimsReviewResponse(val wallet: String, val idempotencyKey: String, val ordinal: Long,
    val status: String, val review: MiningTaxClaimsReview?, val reason: String? = null, val serverNow: String) {
    fun validate(p: MiningTaxClaimsPreparation) {
        p.validate(); address(wallet); taxReviewKey(idempotencyKey); require(ordinal in 0..1); instant(serverNow)
        require(wallet == p.wallet && idempotencyKey == p.idempotencyKey && ordinal.toInt() in p.transactions.indices)
        if (status == "unavailable") {
            require(review == null && reason in setOf("INVALID_INPUT", "NOT_PREPARED", "NOT_SIGNED", "SETUP_REQUIRED", "DISABLED", "EXPIRED", "CONTINUED", "SOURCE_CONFLICT", "QUOTE_UNAVAILABLE", "COST_CAP", "BUSY", "TIMEOUT", "PROVIDER_UNAVAILABLE")); return
        }
        require(status == "ready" && reason == null); val r = requireNotNull(review); r.validate()
        require(r.wallet == wallet && r.idempotencyKey == idempotencyKey && r.ordinal == ordinal)
        require(instant(serverNow) >= instant(r.observedAt) && instant(serverNow) < instant(r.expiresAt))
        val tx = p.transactions[ordinal.toInt()]; val s = r.source; val original = p.source
        require(r.claimId == p.claimId && r.messageSha256 == tx.messageSha256 && r.blockhash == p.blockhash && r.preparedAt == p.preparedAt && r.expiresAt == p.expiresAt)
        require(s.genesisHash == original.genesisHash && s.programId == original.programId && s.reviewedDeploymentSlot == original.reviewedDeploymentSlot && s.reviewedProgramDataSha256 == original.reviewedProgramDataSha256)
        require(s.snapshotSlot >= maxOf(original.snapshotSlot, original.blockhashSlot) && s.blockHeight >= p.blockHeight && s.lastValidBlockHeight == p.lastValidBlockHeight)
        if (ordinal == 0L) require(r.paidFeeLamports == "0" && r.paidRentLamports == "0")
        if (tx.kind == "claim") require(r.rentLamports == "0")
        val fee = amount(r.feeLamports) + amount(r.paidFeeLamports); val rent = amount(r.rentLamports) + amount(r.paidRentLamports)
        require(fee <= amount(p.caps.maxFeeLamports) && rent <= amount(p.caps.maxRentLamports) && fee + rent <= amount(p.caps.maxTotalLamports))
    }
    companion object { fun from(p: MiningTaxClaimsPreparation, raw: JsonObject) = decode(raw, serializer()).also { it.validate(p) } }
}
/** A delivery acknowledgement is not a payment receipt or archival proof. */
@Serializable data class MiningTaxClaimsSubmitResponse(val wallet: String, val idempotencyKey: String, val claimId: String?,
    val wire: MiningTaxClaimsSignedWire?, val delivery: String, val reason: String? = null, val serverNow: String) {
    fun validate() {
        address(wallet); taxReviewKey(idempotencyKey); claimId?.let(::taxReviewKey); instant(serverNow)
        require(delivery in setOf("held", "submitted", "setup", "settled") && (delivery == "held") == (reason != null))
        reason?.let { require(it.length in 1..64 && it.matches(Regex("[A-Z][A-Z0-9_]{0,63}"))) }
        val w = wire
        if (w == null) { require(claimId == null && delivery == "held" && reason == "STORAGE_UNCERTAIN"); return }
        w.validate(); require(w.wallet == wallet && w.idempotencyKey == idempotencyKey && w.claimId == claimId && reason != "STORAGE_UNCERTAIN")
        if (delivery == "setup") require(w.kind == "setup")
    }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() } }
}
