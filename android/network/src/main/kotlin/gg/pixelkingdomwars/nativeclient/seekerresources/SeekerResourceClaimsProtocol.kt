package gg.pixelkingdomwars.nativeclient.seekerresources

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.starter.StarterIdentity
import gg.pixelkingdomwars.nativeclient.starter.starterPrimitives
import gg.pixelkingdomwars.nativeclient.starter.starterResourceRealms
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

internal val seekerResourceJson = Json { encodeDefaults = true }
private fun amount(v: String): Long { require(v.matches(Regex("0|[1-9][0-9]{0,18}"))); return requireNotNull(v.toLongOrNull()) }
private fun hash(v: String) { require(v.matches(Regex("[0-9a-f]{64}"))) }
private fun instant(v: String): Instant { require(v.matches(Regex("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z"))); return Instant.parse(v) }
private fun resource(v: String) { require(v in starterResourceRealms) }

@Serializable data class SeekerResourceClaimRequest(val idempotencyKey: String, val baseId: String, val termId: String, val resourceId: String, val spotId: Int) {
    fun validate() { listOf(idempotencyKey, baseId, termId).forEach(::uuid); resource(resourceId); require(spotId >= 0) }
    fun body() = seekerResourceJson.encodeToJsonElement(serializer(), this).jsonObject
    companion object { fun from(raw: JsonObject): SeekerResourceClaimRequest {
        starterPrimitives(raw, serializer().descriptor); return seekerResourceJson.decodeFromJsonElement<SeekerResourceClaimRequest>(raw).also { it.validate() }
    } }
}
@Serializable data class SeekerResourceClaimReceipt(val idempotencyKey: String, val baseId: String, val termId: String, val resourceId: String,
    val spotId: Int, val id: String, val wallet: String, val termHash: String, val winnerCount: Int, val poolTotal: String,
    val previousTotal: String, val cumulativeTotal: String, val quantity: String, val stockBefore: String, val stockAfter: String,
    val claimedAt: String, val shardsIncluded: Boolean) {
    fun request() = SeekerResourceClaimRequest(idempotencyKey, baseId, termId, resourceId, spotId)
    fun validate() {
        request().validate(); require(id == idempotencyKey && !shardsIncluded && winnerCount > 0); wallet(wallet); hash(termHash); instant(claimedAt)
        val pool = amount(poolTotal); val previous = amount(previousTotal); val cumulative = amount(cumulativeTotal)
        val paid = amount(quantity); val before = amount(stockBefore); val after = amount(stockAfter)
        require(paid > 0 && cumulative >= previous && cumulative - previous == paid && after >= before && after - before == paid && pool / winnerCount == cumulative)
    }
    fun validate(identity: StarterIdentity, command: SeekerResourceClaimCommand) {
        validate(); identity.validate(); command.validate(); require(wallet == identity.wallet && request() == command.request && termHash == command.termHash)
    }
}
@Serializable data class SeekerResourceClaimEnvelope(val wallet: String, val receipt: SeekerResourceClaimReceipt?) {
    companion object { fun from(raw: JsonObject): SeekerResourceClaimEnvelope {
        starterPrimitives(raw, serializer().descriptor)
        return seekerResourceJson.decodeFromJsonElement<SeekerResourceClaimEnvelope>(raw).also { v -> wallet(v.wallet); v.receipt?.let { it.validate(); require(it.wallet == v.wallet) } }
    } }
}
@Serializable data class SeekerResourceEntitlement(val termId: String, val termHash: String, val startsAt: String, val endsAt: String,
    val spotId: Int, val resourceId: String, val winnerCount: Int, val poolTotal: String, val cumulativeTotal: String, val claimedTotal: String, val dueQuantity: String) {
    fun validate() {
        uuid(termId); hash(termHash); require(instant(endsAt) > instant(startsAt)); resource(resourceId); require(spotId >= 0 && winnerCount > 0)
        val pool = amount(poolTotal); val cumulative = amount(cumulativeTotal); val claimed = amount(claimedTotal); val due = amount(dueQuantity)
        require(pool > 0 && pool / winnerCount == cumulative && claimed <= cumulative && cumulative - claimed == due)
    }
}
@Serializable data class SeekerResourceEntitlementView(val version: Int, val wallet: String, val claimsEnabled: Boolean, val shardsIncluded: Boolean,
    val status: String, val reason: String?, val cursor: String?, val nextCursor: String?, val rows: List<SeekerResourceEntitlement>) {
    fun validate() {
        require(version == 1 && !shardsIncluded); wallet(wallet); cursor?.let(::uuid); nextCursor?.let(::uuid)
        if (status == "unavailable") { require(reason in setOf("SOURCE_BOUNDS", "SOURCE_INTEGRITY") && rows.isEmpty() && nextCursor == null); return }
        require(status == "available" && reason == null && (cursor == null || nextCursor == null || nextCursor > cursor))
        var previous: SeekerResourceEntitlement? = null; val first = rows.firstOrNull()
        rows.forEach { r ->
            r.validate(); require(r.termId == first!!.termId && r.termHash == first.termHash && r.startsAt == first.startsAt && r.endsAt == first.endsAt && r.winnerCount == first.winnerCount)
            require((cursor == null || r.termId > cursor) && (nextCursor == null || r.termId <= nextCursor))
            previous?.let { require(r.spotId > it.spotId || r.spotId == it.spotId && r.resourceId > it.resourceId) }; previous = r
        }
    }
    companion object { fun from(raw: JsonObject): SeekerResourceEntitlementView {
        starterPrimitives(raw, serializer().descriptor); return seekerResourceJson.decodeFromJsonElement<SeekerResourceEntitlementView>(raw).also { it.validate() }
    } }
}
/** Cursor is only the browse page where consent was reviewed; it is never sent to a mutation. */
@Serializable data class SeekerResourceClaimCommand(val request: SeekerResourceClaimRequest, val termHash: String, val browseCursor: String?) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/seeker/resource-claims/by-key/$key"
    fun validate() { request.validate(); hash(termHash); browseCursor?.let(::uuid) }
    fun admit(identity: StarterIdentity, view: SeekerResourceEntitlementView) {
        validate(); identity.validate(); view.validate(); require(view.wallet == identity.wallet && view.cursor == browseCursor && view.claimsEnabled && view.status == "available")
        require(view.rows.any { it.termId == request.termId && it.termHash == termHash && it.spotId == request.spotId && it.resourceId == request.resourceId && amount(it.dueQuantity) > 0 })
    }
}
