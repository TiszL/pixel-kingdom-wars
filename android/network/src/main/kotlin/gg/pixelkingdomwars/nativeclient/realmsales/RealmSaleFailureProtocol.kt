package gg.pixelkingdomwars.nativeclient.realmsales

import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import java.math.BigInteger
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.Collections
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val failureJson = Json { encodeDefaults = true }
private const val failureSafeInteger = 9_007_199_254_740_991L
private const val failureLoader = "BPFLoaderUpgradeab1e11111111111111111111111"
private const val failureClock = "SysvarC1ock11111111111111111111111111111111"
private const val failureSysvar = "Sysvar1111111111111111111111111111111111111"
private fun failureCount(v: Long) { require(v in 0..failureSafeInteger) }
private fun failureAmount(v: String): BigInteger {
    require(v.length in 1..20 && v.matches(Regex("0|[1-9][0-9]{0,19}")))
    return v.toBigInteger().also { require(it <= BigInteger.ONE.shiftLeft(64) - BigInteger.ONE) }
}
private fun failureAddress(v: String) { require(v.length in 32..44 && v.matches(Regex("[1-9A-HJ-NP-Za-km-z]+"))) }
private fun failureHash(v: String) { require(v.length == 64 && v.matches(Regex("[0-9a-f]{64}"))) }
private fun failureSaleId(v: String) { require(v.length == 32 && v.matches(Regex("[0-9a-f]{32}")) && v != "00".repeat(16)) }
private fun failureUuid(v: String) {
    require(v.length == 36 && (v.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
        v == "00000000-0000-0000-0000-000000000000" || v == "ffffffff-ffff-ffff-ffff-ffffffffffff"))
}
private fun failureStamp(v: String) {
    require(v.length == 27 && v.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{6}Z")))
    require(DateTimeFormatterBuilder().appendInstant(6).toFormatter().format(Instant.parse(v)) == v)
}
private fun <T> failureDecode(raw: JsonObject, serializer: DeserializationStrategy<T>): T {
    var nodes = 0
    fun bound(value: JsonElement, depth: Int) {
        require(++nodes <= 256 && depth <= 8)
        when (value) {
            is JsonObject -> { require(value.size <= 40); value.forEach { (key, child) -> require(key.length <= 64); bound(child, depth + 1) } }
            is JsonArray -> { require(value.size == 3); value.forEach { bound(it, depth + 1) } }
            is JsonPrimitive -> require(value.content.length <= 2464)
        }
    }
    bound(raw, 0); strictPrimitives(raw, serializer.descriptor)
    return failureJson.decodeFromJsonElement(serializer, raw)
}

@Serializable data class RealmSaleFailureSource(val trust: String, val stateProvenance: String, val genesisHash: String,
    val programId: String, val reviewedDeploymentSlot: Long, val reviewedProgramDataSha256: String,
    val upgradeAuthority: String?, val accounts: List<RealmSaleProofAccount>) {
    fun validate() {
        require(trust == "trusted-finalized-rpc-reviewed-program" && stateProvenance == "fresh-reviewed-deployment")
        failureAddress(genesisHash); failureAddress(programId); failureCount(reviewedDeploymentSlot); failureHash(reviewedProgramDataSha256)
        upgradeAuthority?.let(::failureAddress); require(accounts.size == 3); accounts.forEach { it.validate() }
    }
}
@Serializable data class RealmSaleFailureReceipt(val version: Int, val wallet: String, val saleId: String, val spot: Long,
    val realm: Long, val round: String, val day: String, val signature: String, val originalMessageSha256: String,
    val signedTransactionSha256: String, val slot: Long, val blockTime: Long?, val feeLamports: String,
    val actualRentLamports: String, val buyerNetPaymentLamports: String, val accessChanged: Boolean, val quotaConsumed: Boolean,
    val observedAccountSlot: Long, val proofClockUnixTimestamp: String, val source: RealmSaleFailureSource,
    val outcome: String, val transactionFailed: Boolean, val finalityVerified: Boolean, val paymentAuthorized: Boolean,
    val admissionAuthorized: Boolean, val signingAuthorized: Boolean, val broadcastAuthorized: Boolean, val journalClearingAuthorized: Boolean) {
    fun validate(policy: RealmSalesProtocolPolicy) {
        policy.validate(); require(version == 1); failureAddress(wallet); failureSaleId(saleId)
        failureCount(spot); failureCount(realm); require(spot < policy.totalSpots && realm < policy.realmCount)
        failureAmount(round); failureAmount(day)
        require(signature.length in 64..88 && signature != "1".repeat(64) && signature.matches(Regex("[1-9A-HJ-NP-Za-km-z]+")))
        failureHash(originalMessageSha256); failureHash(signedTransactionSha256); failureCount(slot)
        blockTime?.let { require(it in -failureSafeInteger..failureSafeInteger) }; failureAmount(feeLamports)
        require(actualRentLamports == "0" && buyerNetPaymentLamports == "0" && !accessChanged && !quotaConsumed)
        failureCount(observedAccountSlot)
        require(proofClockUnixTimestamp.length in 1..19 && proofClockUnixTimestamp.matches(Regex("[1-9][0-9]*")))
        val clock = proofClockUnixTimestamp.toBigInteger(); require(clock <= BigInteger.valueOf(Long.MAX_VALUE))
        source.validate(); require(slot > source.reviewedDeploymentSlot && observedAccountSlot >= slot && (blockTime == null || clock >= blockTime.toBigInteger()))
        require(outcome == "failed" && transactionFailed && finalityVerified && !paymentAuthorized && !admissionAuthorized && !signingAuthorized && !broadcastAuthorized && !journalClearingAuthorized)
    }
}
/** finalityVerified records the owner's assertion. Grammar alone does not verify
 * chain finality, signatures, hashes, PDAs, payment, or journal-clearing authority. */
@Serializable data class RealmSaleFailure(val wallet: String, val idempotencyKey: String, val saleId: String,
    val receipt: RealmSaleFailureReceipt, val verifiedAt: String, val transactionFailed: Boolean,
    val purchaseFinalized: Boolean, val journalClearingAuthorized: Boolean) {
    fun validate(policy: RealmSalesProtocolPolicy) {
        failureAddress(wallet); failureUuid(idempotencyKey); failureSaleId(saleId); receipt.validate(policy); failureStamp(verifiedAt)
        require(wallet == receipt.wallet && saleId == receipt.saleId && transactionFailed && !purchaseFinalized && !journalClearingAuthorized)
    }
    fun validate(preparation: RealmSalePreparation, wire: RealmSaleSignedWire, policy: RealmSalesProtocolPolicy) {
        preparation.validate(policy); wire.validate(); validate(policy)
        val p = preparation; val w = wire; val r = receipt; val s = r.source
        require(wallet == p.wallet && idempotencyKey == p.idempotencyKey && saleId == p.saleId && w.wallet == p.wallet && w.idempotencyKey == p.idempotencyKey && w.saleId == p.saleId)
        require(r.spot == p.spot && r.realm == p.realm && r.round == p.terms.round && r.day == p.terms.day && r.signature == w.signature)
        require(r.originalMessageSha256 == p.quote.messageSha256 && w.messageSha256 == p.quote.messageSha256 && r.signedTransactionSha256 == w.wireSha256 && w.signedTransactionHex.substring(130) == p.quote.messageHex)
        require(s.genesisHash == p.source.genesisHash && s.programId == p.source.programId && s.reviewedDeploymentSlot == p.source.reviewedDeploymentSlot && s.reviewedProgramDataSha256 == p.source.programDataSha256 && r.slot >= p.source.admissionSlot)
        require(s.accounts.map { it.address }.distinct().size == 3 && s.accounts[0].address == p.source.programId && s.accounts[1].dataSha256 == p.source.programDataSha256 && s.accounts[2].address == failureClock)
        s.accounts.forEachIndexed { i, a -> require(a.owner == (if (i < 2) failureLoader else failureSysvar) && a.executable == (i == 0)) }
        // The original quote is not a cap on the already charged historical failure fee.
    }
    private fun owned() = copy(receipt = receipt.copy(source = receipt.source.copy(accounts = Collections.unmodifiableList(ArrayList(receipt.source.accounts)))))
    companion object {
        fun from(raw: JsonObject, policy: RealmSalesProtocolPolicy) = failureDecode(raw, serializer()).also { it.validate(policy) }.owned()
        fun from(preparation: RealmSalePreparation, wire: RealmSaleSignedWire, raw: JsonObject, policy: RealmSalesProtocolPolicy) =
            from(raw, policy).also { it.validate(preparation, wire, policy) }
    }
}
@Serializable data class RealmSaleFailureEnvelope(val wallet: String, val idempotencyKey: String, val failure: RealmSaleFailure?) {
    companion object {
        fun from(raw: JsonObject, policy: RealmSalesProtocolPolicy): RealmSaleFailureEnvelope {
            val value = failureDecode(raw, serializer()); failureAddress(value.wallet); failureUuid(value.idempotencyKey); policy.validate()
            val failure = raw["failure"]?.takeUnless { it == JsonNull }?.let { RealmSaleFailure.from(it.jsonObject, policy) }
            require(failure == null || failure.wallet == value.wallet && failure.idempotencyKey == value.idempotencyKey)
            return value.copy(failure = failure)
        }
    }
}
