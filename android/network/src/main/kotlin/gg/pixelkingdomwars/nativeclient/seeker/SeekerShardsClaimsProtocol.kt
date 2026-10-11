package gg.pixelkingdomwars.nativeclient.seeker

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.quantity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.stamp
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import java.math.BigInteger
import java.time.Instant
import java.util.Collections
import java.util.Locale
import kotlinx.serialization.DeserializationStrategy
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

private val shardsJson = Json { encodeDefaults = true }
/** Supplied from PHASE_E_POLICY.seekerIsland in the canonical catalogue, never
 * inferred from an entitlement response. Parsing grants no source, payout or base authority. */
@Serializable data class SeekerShardsClaimsPolicy(val totalSpots: Int, val operatingTermSec: Long) {
    fun validate() { require(totalSpots > 0); count(operatingTermSec, true) }
    companion object { fun from(raw: JsonObject) = decode(raw, serializer(), 0).also { it.validate() } }
}
private fun id(value: String): String {
    require(value.length == 36)
    return value.lowercase(Locale.ROOT).also(::uuid)
}
private fun hash(value: String) { require(value.length == 64 && value.matches(Regex("[0-9a-f]{64}"))) }
private fun instant(value: String): Instant {
    require(value.length == 24 && value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")))
    return stamp(value)
}
private fun spot(value: Int, policy: SeekerShardsClaimsPolicy) { require(value in 0 until policy.totalSpots) }
private fun winners(value: Int, policy: SeekerShardsClaimsPolicy) { require(value in 1..policy.totalSpots) }
/** The shared RAW_RESOURCE_STORAGE_MAX is PostgreSQL signed BIGINT. Reuse that
 * canonical decimal grammar and BigInteger arithmetic; additions never wrap Long. */
private fun amount(value: String): BigInteger { require(value.length in 1..19); return quantity(value) }
private fun <T> decode(raw: JsonObject, strategy: DeserializationStrategy<T>, maxRows: Int): T {
    var nodes = 0
    fun bound(value: JsonElement, depth: Int) {
        require(++nodes <= 8192 && depth <= 5)
        when (value) {
            is JsonObject -> { require(value.size <= 24); value.forEach { (key, child) -> require(key.length <= 32); bound(child, depth + 1) } }
            is JsonArray -> { require(value.size <= maxRows); value.forEach { bound(it, depth + 1) } }
            is JsonPrimitive -> require(value.content.length <= 128)
        }
    }
    bound(raw, 0); strictPrimitives(raw, strategy.descriptor)
    return shardsJson.decodeFromJsonElement(strategy, raw)
}

@Serializable data class SeekerShardsClaimRequest(val idempotencyKey: String, val baseId: String, val termId: String, val spotId: Int) {
    fun validate(policy: SeekerShardsClaimsPolicy) { policy.validate(); listOf(idempotencyKey, baseId, termId).forEach(::uuid); spot(spotId, policy) }
    internal fun canonical(policy: SeekerShardsClaimsPolicy) = copy(idempotencyKey = id(idempotencyKey), baseId = id(baseId), termId = id(termId)).also { it.validate(policy) }
    fun body(policy: SeekerShardsClaimsPolicy) = shardsJson.encodeToJsonElement(serializer(), canonical(policy)).jsonObject
    companion object { fun from(raw: JsonObject, policy: SeekerShardsClaimsPolicy) = decode(raw, serializer(), 0).canonical(policy.copy()) }
}
@Serializable data class SeekerShardsClaimReceipt(val idempotencyKey: String, val baseId: String, val termId: String, val spotId: Int,
    val id: String, val wallet: String, val termHash: String, val winnerCount: Int, val poolTotal: String, val previousTotal: String,
    val cumulativeTotal: String, val quantity: String, val balanceBefore: String, val balanceAfter: String, val claimedAt: String,
    val currency: String, val ledgerTransactionId: String) {
    fun request() = SeekerShardsClaimRequest(idempotencyKey, baseId, termId, spotId)
    fun validate(policy: SeekerShardsClaimsPolicy) {
        request().validate(policy); uuid(id); uuid(ledgerTransactionId); wallet(wallet); hash(termHash); instant(claimedAt)
        winners(winnerCount, policy); require(currency == "SHARDS" && id == idempotencyKey)
        val pool = amount(poolTotal); val previous = amount(previousTotal); val cumulative = amount(cumulativeTotal)
        val paid = amount(quantity); val before = amount(balanceBefore); val after = amount(balanceAfter)
        require(paid.signum() > 0 && previous + paid == cumulative && before + paid == after && pool / winnerCount.toBigInteger() == cumulative)
    }
    fun match(wallet: String, request: SeekerShardsClaimRequest, policy: SeekerShardsClaimsPolicy): SeekerShardsClaimReceipt {
        validate(policy); wallet(wallet); require(this.wallet == wallet && this.request() == request.canonical(policy)); return this
    }
    internal fun canonical(policy: SeekerShardsClaimsPolicy) = copy(idempotencyKey = id(idempotencyKey), baseId = id(baseId), termId = id(termId),
        id = id(id), ledgerTransactionId = id(ledgerTransactionId)).also { it.validate(policy) }
    companion object { fun from(raw: JsonObject, policy: SeekerShardsClaimsPolicy) = decode(raw, serializer(), 0).canonical(policy.copy()) }
}
@Serializable data class SeekerShardsClaimEnvelope(val wallet: String, val receipt: SeekerShardsClaimReceipt?) {
    fun validate(policy: SeekerShardsClaimsPolicy) { policy.validate(); wallet(wallet); receipt?.let { it.validate(policy); require(it.wallet == wallet) } }
    fun match(wallet: String, request: SeekerShardsClaimRequest? = null, policy: SeekerShardsClaimsPolicy): SeekerShardsClaimEnvelope {
        validate(policy); wallet(wallet); require(this.wallet == wallet)
        if (receipt != null && request != null) receipt.match(wallet, request, policy)
        return this
    }
    companion object { fun from(raw: JsonObject, policy: SeekerShardsClaimsPolicy): SeekerShardsClaimEnvelope {
        val rules = policy.copy().also { it.validate() }; val parsed = decode(raw, serializer(), 0)
        return parsed.copy(receipt = parsed.receipt?.canonical(rules)).also { it.validate(rules) }
    } }
}
@Serializable data class SeekerShardsEntitlementQuery(val cursor: String? = null) {
    companion object { fun from(raw: JsonObject): SeekerShardsEntitlementQuery {
        require("cursor" !in raw || raw["cursor"] != JsonNull)
        val value = decode(raw, serializer(), 0); return value.copy(cursor = value.cursor?.let(::id))
    } }
}
@Serializable data class SeekerShardsEntitlement(val termId: String, val termHash: String, val startsAt: String, val endsAt: String,
    val spotId: Int, val winnerCount: Int, val poolTotal: String, val cumulativeTotal: String, val claimedTotal: String, val dueQuantity: String) {
    fun validate(policy: SeekerShardsClaimsPolicy) {
        policy.validate(); uuid(termId); hash(termHash); spot(spotId, policy); winners(winnerCount, policy)
        require(instant(startsAt).plusSeconds(policy.operatingTermSec) == instant(endsAt))
        val pool = amount(poolTotal); val cumulative = amount(cumulativeTotal); val claimed = amount(claimedTotal); val due = amount(dueQuantity)
        require(pool.signum() > 0 && pool / winnerCount.toBigInteger() == cumulative && claimed <= cumulative && cumulative - claimed == due)
    }
}
/** Cursor is a browse position, never a completion watermark or mutation scope.
 * Empty available pages may have a next cursor; unavailable pages carry no amounts. */
@Serializable data class SeekerShardsEntitlementView(val version: Int, val wallet: String, val claimsEnabled: Boolean, val currency: String,
    val status: String, val reason: String?, val cursor: String?, val nextCursor: String?, val rows: List<SeekerShardsEntitlement>) {
    fun validate(policy: SeekerShardsClaimsPolicy) {
        policy.validate(); require(version == 1 && currency == "SHARDS" && rows.size <= policy.totalSpots)
        wallet(wallet); cursor?.let(::uuid); nextCursor?.let(::uuid)
        if (status == "unavailable") { require(reason in setOf("SOURCE_BOUNDS", "SOURCE_INTEGRITY") && rows.isEmpty() && nextCursor == null); return }
        require(status == "available" && reason == null && (cursor == null || nextCursor == null || nextCursor > cursor))
        val first = rows.firstOrNull(); var previous: SeekerShardsEntitlement? = null
        rows.forEach { r ->
            r.validate(policy)
            require(r.termId == first!!.termId && r.termHash == first.termHash && r.startsAt == first.startsAt && r.endsAt == first.endsAt &&
                r.winnerCount == first.winnerCount && r.poolTotal == first.poolTotal && r.cumulativeTotal == first.cumulativeTotal)
            require((cursor == null || r.termId > cursor) && (nextCursor == null || r.termId <= nextCursor))
            previous?.let { require(r.spotId > it.spotId) }; previous = r
        }
    }
    fun match(wallet: String, cursor: String? = null, policy: SeekerShardsClaimsPolicy): SeekerShardsEntitlementView {
        validate(policy); wallet(wallet); require(this.wallet == wallet && this.cursor == cursor?.let(::id)); return this
    }
    companion object { fun from(raw: JsonObject, policy: SeekerShardsClaimsPolicy): SeekerShardsEntitlementView {
        val rules = policy.copy().also { it.validate() }; val value = decode(raw, serializer(), rules.totalSpots)
        return value.copy(cursor = value.cursor?.let(::id), nextCursor = value.nextCursor?.let(::id),
            rows = Collections.unmodifiableList(value.rows.map { it.copy(termId = id(it.termId)) })).also { it.validate(rules) }
    } }
}
