package gg.pixelkingdomwars.nativeclient.mining

import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val continuationJson = Json { encodeDefaults = true }
private fun instant(value: String, digits: Int) {
    require(value.length == 21 + digits && value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{$digits}Z")))
    require(DateTimeFormatterBuilder().appendInstant(digits).toFormatter().format(Instant.parse(value)) == value)
}
private fun <T> decode(raw: JsonObject, serializer: DeserializationStrategy<T>): T {
    var nodes = 0
    fun bound(v: JsonElement, depth: Int, field: String?) {
        require(++nodes <= 2048 && depth <= 11)
        when (v) {
            is JsonObject -> { require(v.size <= 40); v.forEach { (key, child) -> require(key.length <= 64); bound(child, depth + 1, key) } }
            is JsonArray -> { require(v.size <= when (field) { "transactions", "wires" -> 2; "newAccounts", "accrualDays" -> 10; else -> 0 }); v.forEach { bound(it, depth + 1, null) } }
            is JsonPrimitive -> require(v.content.length <= 2464)
        }
    }
    bound(raw, 0, null); strictPrimitives(raw, serializer.descriptor)
    return continuationJson.decodeFromJsonElement(serializer, raw)
}
@Serializable data class MiningTaxClaimsContinuationRequest(val idempotencyKey: String, val caps: MiningTaxClaimsCaps) {
    fun validate() { taxReviewKey(idempotencyKey); caps.validate() }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer()).also { it.validate() } }
}
@Serializable data class MiningTaxClaimsContinuationExpiry(val genesisHash: String, val programId: String,
    val reviewedDeploymentSlot: Long, val reviewedProgramDataSha256: String, val blockHeight: Long, val slot: Long)

/** Historical owner consistency only. Expiry is no proof that an absent packet
 * never ran and this unsigned link grants no signing, relay or clearing right. */
@Serializable data class MiningTaxClaimsContinuation(val version: Int, val wallet: String, val parentIdempotencyKey: String,
    val parentPreparation: MiningTaxClaimsPreparation, val parentWire: MiningTaxClaimsSignedWire,
    val parentSetup: MiningTaxClaimsSettlement, val childPreparation: MiningTaxClaimsPreparation,
    val expiry: MiningTaxClaimsContinuationExpiry, val createdAt: String, val currentSigningAuthorized: Boolean,
    val relayAuthorized: Boolean, val settlementAuthorized: Boolean, val journalClearingAuthorized: Boolean) {
    fun validate() {
        require(version == 1 && !currentSigningAuthorized && !relayAuthorized && !settlementAuthorized && !journalClearingAuthorized)
        instant(createdAt, 6); val p = parentPreparation; val c = childPreparation; val e = expiry
        p.validate(); c.validate()
        MiningTaxClaimsRecoveryEnvelope(wallet, parentIdempotencyKey, p.claimId, "setup", p, listOf(parentWire), parentSetup, p.preparedAt).validate()
        require(parentSetup.ordinal == 0L && !parentSetup.claimFinalized && parentSetup.receipt.phase == "setup" && p.transactions.size == 2 && p.transactions[0].kind == "setup" && p.transactions[1].kind == "claim")
        require(wallet == p.wallet && parentIdempotencyKey == p.idempotencyKey && c.wallet == p.wallet && c.idempotencyKey != p.idempotencyKey && c.claimId != p.claimId && c.blockhash != p.blockhash)
        require(c.round == p.round && c.spot == p.spot && c.identity == p.identity && c.term == p.term)
        listOf(e.reviewedDeploymentSlot, e.blockHeight, e.slot).forEach(::taxReviewCount)
        for (s in listOf(p.source, c.source)) require(e.genesisHash == s.genesisHash && e.programId == s.programId && e.reviewedDeploymentSlot == s.reviewedDeploymentSlot && e.reviewedProgramDataSha256 == s.reviewedProgramDataSha256)
        require(e.blockHeight > p.lastValidBlockHeight && c.blockHeight >= e.blockHeight && e.slot >= maxOf(p.source.snapshotSlot, p.source.blockhashSlot, parentSetup.receipt.source.observedAccountSlot))
        require(c.source.firstSnapshotSlot >= e.slot && c.source.snapshotSlot >= e.slot)
        val clock = parentSetup.receipt.source.observedClockUnixTimestamp
        if (c.snapshot.unixTimestamp.matches(Regex("[0-9]+")) && clock.matches(Regex("[0-9]+"))) require(c.snapshot.unixTimestamp.toBigInteger() >= clock.toBigInteger())
    }
}
@Serializable data class MiningTaxClaimsContinuationEnvelope(val wallet: String, val parentIdempotencyKey: String,
    val status: String, val continuation: MiningTaxClaimsContinuation?, val serverNow: String) {
    fun validate() {
        MiningTaxClaimsRecoveryEnvelope(wallet, parentIdempotencyKey, null, "unknown", null, emptyList(), null, serverNow).validate()
        require(status in setOf("continued", "unknown") && (status == "continued") == (continuation != null))
        continuation?.let { it.validate(); require(it.wallet == wallet && it.parentIdempotencyKey == parentIdempotencyKey) }
    }
    companion object {
        fun from(raw: JsonObject): MiningTaxClaimsContinuationEnvelope {
            val value = decode(raw, serializer()).also { it.validate() }; val c = value.continuation ?: return value
            val r = raw.getValue("continuation").jsonObject
            return value.copy(continuation = c.copy(parentPreparation = MiningTaxClaimsPreparation.from(r.getValue("parentPreparation").jsonObject),
                childPreparation = MiningTaxClaimsPreparation.from(r.getValue("childPreparation").jsonObject), parentSetup = MiningTaxClaimsSettlement.from(r.getValue("parentSetup").jsonObject)))
        }
    }
}
