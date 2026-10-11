@file:OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
package gg.pixelkingdomwars.nativeclient.mining

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import java.math.BigInteger
import java.time.Instant
import java.util.Base64
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

internal val miningClaimsJson = Json { encodeDefaults = true }
/** Supplied from the canonical generated catalogue, never from the response being checked. */
@Serializable data class MiningClaimsProtocolPolicy(val tokenDecimals: Int, val quoteVersion: Int, val quoteTtlSec: Long,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val orderedComputeUnitLimit: Int? = null) {
    fun validate() { require(tokenDecimals in 0..255 && quoteVersion > 0); count(quoteTtlSec, true); orderedComputeUnitLimit?.let { require(it > 0) } }
}
private val u64Max = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE
private fun amount(value: String, positive: Boolean = false): BigInteger {
    require(value.length <= 20 && value.matches(Regex("0|[1-9][0-9]{0,19}")))
    return value.toBigInteger().also { require(it <= u64Max && (!positive || it.signum() > 0)) }
}
private fun timestamp(value: String): Instant {
    require(value.length <= 27 && value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.(?:[0-9]{3}|[0-9]{6})Z")))
    return Instant.parse(value).also { require(it.toString().take(19) == value.take(19)) }
}
private fun hash(value: String) { require(value.length == 64 && value.matches(Regex("[0-9a-f]{64}"))) }
internal fun miningClaimSignature(value: String) {
    require(value.length in 64..88 && value != "1".repeat(64))
    val alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
    var n = BigInteger.ZERO
    for (c in value) { val digit = alphabet.indexOf(c); require(digit >= 0); n = n * BigInteger.valueOf(58) + BigInteger.valueOf(digit.toLong()) }
    require((n.bitLength() + 7) / 8 + value.takeWhile { it == '1' }.length == 64)
}
private fun base64(value: String, maximum: Int, minimum: Int = 1) {
    require(value.length <= (maximum + 2) / 3 * 4 && value.length % 4 == 0)
    require(value.matches(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?")))
    val bytes = Base64.getDecoder().decode(value)
    require(bytes.size in minimum..maximum && Base64.getEncoder().encodeToString(bytes) == value)
}
private fun kind(value: String) { require(value in setOf("combined", "setup", "claim")) }
/** Bound the already parsed tree before descriptor walking or allocating DTO lists. */
internal fun <T> decodeMiningClaims(raw: JsonObject, serializer: DeserializationStrategy<T>): T {
    var nodes = 0
    fun bound(value: JsonElement, depth: Int) {
        require(++nodes <= 2048 && depth <= 12)
        when (value) {
            is JsonObject -> { require(value.size <= 40); value.forEach { (key, child) -> require(key.length <= 64); bound(child, depth + 1) } }
            is JsonArray -> { require(value.size <= 16); value.forEach { bound(it, depth + 1) } }
            is JsonPrimitive -> require(value.content.length <= 1644)
        }
    }
    bound(raw, 0); strictPrimitives(raw, serializer.descriptor)
    return miningClaimsJson.decodeFromJsonElement(serializer, raw)
}
@Serializable data class MiningClaimFeature(val version: Int, val receipts: Int,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val ordered: Int? = null)
@Serializable data class MiningClaimFeatures(val claims: MiningClaimFeature)
@Serializable data class MiningClaimStatusView(val features: MiningClaimFeatures, val wallet: String, val program: String,
    val programId: String?, val keepMint: String?, val state: String, val reason: String?, val rootSequence: String?,
    val cumulativeKeepBaseUnits: String?, val claimedBaseUnits: String?, val claimableBaseUnits: String?, val decimals: Int,
    val observedSlot: Long?, val chainUnixTimestamp: String?, val claimableAfterUnixTimestamp: String?, val needsAta: Boolean?,
    val needsMinerRecords: Boolean?, val preparationAllowed: Boolean, val claimSubmissionAuthorized: Boolean, val serverNow: String) {
    fun validate(policy: MiningClaimsProtocolPolicy) {
        policy.validate(); wallet(wallet); require(program == "shardkeep-economy" && features.claims.version == 1 && features.claims.receipts == 1 && features.claims.ordered in listOf(null, 1))
        require(decimals == policy.tokenDecimals && !claimSubmissionAuthorized); timestamp(serverNow)
        programId?.let(::wallet); keepMint?.let(::wallet); require((programId == null) == (keepMint == null))
        require(state in setOf("unavailable", "no_allocation", "ready", "delayed", "paused", "revoked", "claimed"))
        require(reason == null || reason in setOf("INVALID_WALLET", "DISABLED", "NOT_PROJECTED", "SOURCE_UNAVAILABLE", "SOURCE_CONFLICT", "UNSUPPORTED_FRONTIER", "BUSY", "TIMEOUT"))
        rootSequence?.let { amount(it, true) }; observedSlot?.let { count(it) }
        listOf(cumulativeKeepBaseUnits, claimedBaseUnits, claimableBaseUnits, chainUnixTimestamp, claimableAfterUnixTimestamp).filterNotNull().forEach { amount(it) }
        require(preparationAllowed == (state == "ready"))
        if (state == "unavailable") {
            require(reason != null && listOf(rootSequence, cumulativeKeepBaseUnits, claimedBaseUnits, claimableBaseUnits, observedSlot, chainUnixTimestamp,
                claimableAfterUnixTimestamp, needsAta, needsMinerRecords).all { it == null }); return
        }
        require(reason == null && rootSequence != null && observedSlot != null && chainUnixTimestamp != null)
        if (state in setOf("no_allocation", "revoked")) {
            require(claimableBaseUnits == if (state == "no_allocation") "0" else null)
            require(listOf(cumulativeKeepBaseUnits, claimedBaseUnits, claimableAfterUnixTimestamp, needsAta, needsMinerRecords).all { it == null }); return
        }
        require(needsAta != null && needsMinerRecords != null)
        val total = amount(requireNotNull(cumulativeKeepBaseUnits), true); val paid = amount(requireNotNull(claimedBaseUnits))
        val claimable = amount(requireNotNull(claimableBaseUnits)); val clock = amount(chainUnixTimestamp); val after = amount(requireNotNull(claimableAfterUnixTimestamp))
        require(paid + claimable == total && (claimable.signum() == 0) == (state == "claimed"))
        if (state == "ready") require(clock >= after)
        if (state == "delayed") require(clock < after)
    }
    companion object { fun from(raw: JsonObject, policy: MiningClaimsProtocolPolicy) = decodeMiningClaims(raw, serializer()).also { it.validate(policy) } }
}
@Serializable data class MiningClaimIdentity(val genesisHash: String, val programId: String, val configAddress: String, val keepMint: String, val reserveOwner: String) {
    fun validate() { listOf(genesisHash, programId, configAddress, keepMint, reserveOwner).forEach(::wallet) }
}
@Serializable data class MiningClaimLeaf(val wallet: String, val rootSequence: String, val cumulativeKeepBaseUnits: String, val cumulativeRenown: String, val cumulativeDays: String) {
    fun validate() { wallet(wallet); amount(rootSequence, true); amount(cumulativeKeepBaseUnits, true); require(amount(cumulativeRenown) <= amount(cumulativeDays)) }
}
@Serializable data class MiningClaimProofNode(val hash: String, val sumBaseUnits: String, val isLeft: Boolean) {
    fun validate() { hash(hash); amount(sumBaseUnits) }
}
@Serializable data class MiningClaimFees(val feeLamports: String, val rentLamports: String, val totalLamports: String, val payerBalanceLamports: String) {
    fun validate() { listOf(feeLamports, rentLamports, totalLamports, payerBalanceLamports).forEach { amount(it) } }
}
@Serializable data class MiningClaimTransaction(val ordinal: Int, val kind: String, val version: String, val message: String, val lookupTables: List<MiningClaimLookupTable>,
    val feePayer: String, val blockhash: String, val lastValidBlockHeight: Long, val feeLamports: String, val rentLamports: String) {
    fun validate() {
        require(ordinal in 0..1 && version in setOf("legacy", "v0") && lookupTables.size <= 1); lookupTables.forEach { it.validate() }; if(version=="legacy") require(lookupTables.isEmpty()); kind(kind); base64(message, 1167)
        wallet(feePayer); wallet(blockhash); count(lastValidBlockHeight); amount(feeLamports); amount(rentLamports)
        if (kind == "claim") require(rentLamports == "0")
    }
}
@Serializable data class MiningClaimPreparationView(val version: Int, val wallet: String, val idempotencyKey: String, val claimId: String, val quoteId: String,
    val quoteVersion: Int, val rootSequence: String, val day: String, val root: String, val totalCumulativeBaseUnits: String, val identity: MiningClaimIdentity,
    val leaf: MiningClaimLeaf, val proof: List<MiningClaimProofNode>, val needsAta: Boolean, val needsMinerRecords: Boolean, val fees: MiningClaimFees,
    val transactions: List<MiningClaimTransaction>, val preparedAt: String, val expiresAt: String, val serverNow: String, val state: String,
    val currentSigningAuthorized: Boolean, val claimSubmissionAuthorized: Boolean,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val format: MiningClaimOrderedFormat? = null) {
    fun validate(policy: MiningClaimsProtocolPolicy) {
        policy.validate(); require(version == (if(format==null)1 else 2) && quoteVersion == policy.quoteVersion && state == "prepared" && !currentSigningAuthorized && !claimSubmissionAuthorized)
        wallet(wallet); listOf(idempotencyKey, claimId, quoteId).forEach(::uuid); require(quoteId == claimId); amount(rootSequence, true); amount(day, true); hash(root)
        identity.validate(); leaf.validate(); fees.validate(); require(proof.size <= 16 && transactions.size in 1..2)
        proof.forEach { it.validate() }; transactions.forEach { it.validate() }
        format?.validate(); require(transactions.all { it.version == if(format==null)"legacy" else "v0" })
        if(format!=null) require(transactions.all { it.lookupTables==listOf(format.lookupTable) })
        require(leaf.wallet == wallet && leaf.rootSequence == rootSequence && amount(leaf.cumulativeKeepBaseUnits) <= amount(totalCumulativeBaseUnits, true))
        val start = timestamp(preparedAt); val end = timestamp(expiresAt); timestamp(serverNow)
        require(Math.subtractExact(end.toEpochMilli(), start.toEpochMilli()) == Math.multiplyExact(policy.quoteTtlSec, 1000))
        require(transactions.withIndex().all { (i, t) -> t.ordinal == i && t.feePayer == wallet && t.blockhash == transactions[0].blockhash && t.lastValidBlockHeight == transactions[0].lastValidBlockHeight })
        val setup = needsAta || needsMinerRecords
        require(if (transactions.size == 1) transactions[0].kind == (if (setup) "combined" else "claim") else setup && transactions[0].kind == "setup" && transactions[1].kind == "claim")
        if(format!=null) require(if(setup) transactions.size==2 else transactions.size==1)
        val fee = transactions.fold(BigInteger.ZERO) { n, t -> n + amount(t.feeLamports) }; val rent = transactions.fold(BigInteger.ZERO) { n, t -> n + amount(t.rentLamports) }
        require(fee == amount(fees.feeLamports) && rent == amount(fees.rentLamports) && fee + rent == amount(fees.totalLamports) && fee + rent <= amount(fees.payerBalanceLamports))
    }
    /** An observation timestamp may advance; every reviewed signing term stays fixed. */
    fun sameOriginal(other: MiningClaimPreparationView, policy: MiningClaimsProtocolPolicy): Boolean {
        validate(policy); other.validate(policy); return copy(serverNow = other.serverNow) == other
    }
    companion object { fun from(raw: JsonObject, policy: MiningClaimsProtocolPolicy) = decodeMiningClaims(raw, serializer()).also { it.validate(policy) } }
}
@Serializable data class MiningClaimPreparationEnvelope(val wallet: String, val idempotencyKey: String, val status: String, val receipt: MiningClaimPreparationView?, val serverNow: String) {
    fun validate(policy: MiningClaimsProtocolPolicy) {
        policy.validate(); wallet(wallet); uuid(idempotencyKey); timestamp(serverNow); require(status in setOf("unknown", "prepared") && (status == "unknown") == (receipt == null))
        receipt?.let { it.validate(policy); require(it.wallet == wallet && it.idempotencyKey == idempotencyKey && it.serverNow == serverNow) }
    }
    companion object { fun from(raw: JsonObject, policy: MiningClaimsProtocolPolicy) = decodeMiningClaims(raw, serializer()).also { it.validate(policy) } }
}
@Serializable data class MiningClaimLanding(val ordinal: Int, val kind: String, val signature: String?, val landing: String,
    val settledBaseUnits: String?, val acceptedAt: String?, val settledAt: String?) {
    fun validate() {
        require(ordinal in 0..1); kind(kind); signature?.let(::miningClaimSignature); acceptedAt?.let(::timestamp); settledAt?.let(::timestamp)
        require(landing in setOf("pending", "finalized", "failed") && (signature == null) == (acceptedAt == null))
        if (landing == "pending") require(settledBaseUnits == null && settledAt == null)
        else if (landing == "failed") require(signature != null && acceptedAt != null && settledAt != null && settledBaseUnits == null)
        else { require(signature != null && settledBaseUnits != null && settledAt != null); val paid = amount(settledBaseUnits); require(if (kind == "setup") paid.signum() == 0 else paid.signum() > 0) }
    }
}
@Serializable data class MiningClaimView(val version: Int, val wallet: String, val claimId: String, val state: String, val landing: String,
    val signature: String?, val settledBaseUnits: String?, val transactions: List<MiningClaimLanding>, val serverNow: String, val claimSubmissionAuthorized: Boolean) {
    fun validate() {
        require(version == 1 && !claimSubmissionAuthorized && transactions.size <= 2); wallet(wallet); uuid(claimId); timestamp(serverNow)
        signature?.let(::miningClaimSignature); settledBaseUnits?.let { amount(it) }; transactions.forEach { it.validate() }
        require(transactions.withIndex().all { (i, t) -> i == t.ordinal })
        if (transactions.size == 2) require(transactions[0].kind == "setup" && transactions[1].kind == "claim")
        if (transactions.size == 1) require(transactions[0].kind != "setup")
        val paid = transactions.find { it.kind != "setup" && it.landing == "finalized" }; val signed = transactions.filter { it.signature != null }
        val failed = transactions.lastOrNull { it.landing == "failed" }
        // A failed setup cannot erase a paid claim, nor retire another signed ordinal still pending.
        val terminalFailure = paid == null && failed != null && signed.none { it.landing == "pending" }
        val last = paid ?: if (terminalFailure) failed else signed.lastOrNull()
        require(state == if (transactions.isEmpty()) "unknown" else if (paid != null) "settled" else if (terminalFailure) "failed" else if (signed.isNotEmpty()) "retained" else "prepared")
        require(landing == if (paid != null) "finalized" else if (terminalFailure) "failed" else "pending")
        require(signature == last?.signature && settledBaseUnits == paid?.settledBaseUnits)
    }
    companion object { fun from(raw: JsonObject) = decodeMiningClaims(raw, serializer()).also { it.validate() } }
}
@Serializable data class MiningClaimPrepareRequest(val idempotencyKey: String,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val profile: String? = null) {
    fun validate() { uuid(idempotencyKey); require(profile in listOf(null,"ordered-v0")) }
    fun body(): JsonObject { validate(); return miningClaimsJson.encodeToJsonElement(serializer(), this).jsonObject }
    companion object { fun from(raw: JsonObject) = decodeMiningClaims(raw, serializer()).also { it.validate() } }
}
@Serializable data class MiningClaimSubmitRequest(val claimId: String, val signedTransaction: String) {
    fun validate() { uuid(claimId); base64(signedTransaction, 1232, 66) }
    fun body(): JsonObject { validate(); return miningClaimsJson.encodeToJsonElement(serializer(), this).jsonObject }
    companion object { fun from(raw: JsonObject) = decodeMiningClaims(raw, serializer()).also { it.validate() } }
}
@Serializable data class MiningClaimSubmitResponse(val claimId: String, val signature: String, val serverNow: String, val delivery: String, val reason: String? = null) {
    fun validate() { uuid(claimId); miningClaimSignature(signature); timestamp(serverNow); require(delivery in setOf("submitted", "held", "settled")); reason?.let { require(it.length in 1..128 && it.matches(Regex("[A-Z0-9_]+"))) } }
    companion object { fun from(raw: JsonObject): MiningClaimSubmitResponse { require(raw["reason"] != JsonNull); return decodeMiningClaims(raw, serializer()).also { it.validate() } } }
}
