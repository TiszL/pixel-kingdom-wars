package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.json.*

/** shared/baseClaims.ts: protocol validation only; the server decides ownership and transfer. */
object BaseClaimContract {
    fun keys(raw: JsonObject, vararg fields: String) { require(raw.keys == fields.toSet()) }
    fun text(raw: JsonObject, key: String) = requireNotNull((raw[key] as? JsonPrimitive)?.takeIf { it.isString }?.content)
    fun flag(raw: JsonObject, key: String) = requireNotNull((raw[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull)
    fun uuid(value: String) = value.also { require(UUID.fromString(it).toString() == it &&
        (it == "00000000-0000-0000-0000-000000000000" || it == "ffffffff-ffff-ffff-ffff-ffffffffffff" ||
            it[14] in '1'..'8' && it[19] in "89ab")) }
    fun wallet(value: String) = value.also { require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))) }
    fun version(raw: JsonObject) { require(raw["version"] == JsonPrimitive(1)) }
    fun nullable(raw: JsonObject, key: String) = if (raw[key] == JsonNull) null else text(raw, key)
}

data class BaseClaimRequest(val idempotencyKey: String, val baseId: String, val deedAssetId: String) {
    fun json() = buildJsonObject { put("idempotencyKey", idempotencyKey); put("baseId", baseId); put("deedAssetId", deedAssetId) }
    companion object { fun from(raw: JsonObject): BaseClaimRequest = with(BaseClaimContract) {
        keys(raw, "idempotencyKey", "baseId", "deedAssetId")
        BaseClaimRequest(uuid(text(raw, "idempotencyKey")), uuid(text(raw, "baseId")), wallet(text(raw, "deedAssetId")))
    } }
}
data class BaseClaimCandidate(val baseId: String, val deedAssetId: String)
data class BaseClaimOffer(val wallet: String, val enabled: Boolean, val candidate: BaseClaimCandidate?, val reason: String) {
    companion object { fun from(raw: JsonObject): BaseClaimOffer = with(BaseClaimContract) {
        keys(raw, "version", "wallet", "enabled", "candidate", "reason"); version(raw)
        val enabled = flag(raw, "enabled"); val reason = text(raw, "reason")
        require(reason in setOf("ok", "none", "not_transferable", "unavailable"))
        val candidate = if (raw["candidate"] == JsonNull) null else {
            val item = requireNotNull(raw["candidate"] as? JsonObject); keys(item, "baseId", "deedAssetId")
            BaseClaimCandidate(uuid(text(item, "baseId")), wallet(text(item, "deedAssetId")))
        }
        require(if (candidate != null) enabled && reason == "ok" else reason != "ok")
        BaseClaimOffer(wallet(text(raw, "wallet")), enabled, candidate, reason)
    } }
}
data class BaseClaimReceipt(val actor: String, val request: BaseClaimRequest, val outcome: String,
    val active: Boolean, val transferId: String?, val fromWallet: String?, val raw: JsonObject) {
    companion object { fun from(raw: JsonObject): BaseClaimReceipt = with(BaseClaimContract) {
        keys(raw, "version", "actor", "idempotencyKey", "request", "outcome", "active", "transferId", "fromWallet", "ownership", "createdAt"); version(raw)
        val actor = wallet(text(raw, "actor")); val request = BaseClaimRequest.from(requireNotNull(raw["request"] as? JsonObject))
        require(uuid(text(raw, "idempotencyKey")) == request.idempotencyKey)
        val outcome = text(raw, "outcome"); val transfer = nullable(raw, "transferId")?.let(::uuid); val from = nullable(raw, "fromWallet")?.let(::wallet)
        require(when (outcome) { "claimed" -> transfer != null && from != null && from != actor; "already_owned" -> transfer == null && from == null; else -> false })
        val ownership = requireNotNull(raw["ownership"] as? JsonObject); keys(ownership, "owner", "collection", "slot")
        require(wallet(text(ownership, "owner")) == actor); wallet(text(ownership, "collection"))
        val slot = text(ownership, "slot"); require(slot.matches(Regex("0|[1-9][0-9]{0,15}")) && slot.toLong() <= 9007199254740991L)
        val at = text(raw, "createdAt"); require(at.endsWith('Z')); Instant.parse(at)
        BaseClaimReceipt(actor, request, outcome, flag(raw, "active"), transfer, from, raw)
    } }
}
data class BaseClaimStatus(val enabled: Boolean, val receipt: BaseClaimReceipt?) {
    companion object { fun from(raw: JsonObject, wallet: String, request: BaseClaimRequest): BaseClaimStatus = with(BaseClaimContract) {
        keys(raw, "version", "wallet", "idempotencyKey", "enabled", "receipt"); version(raw)
        require(raw["wallet"] == JsonPrimitive(wallet) && raw["idempotencyKey"] == JsonPrimitive(request.idempotencyKey))
        val receipt = if (raw["receipt"] == JsonNull) null else BaseClaimReceipt.from(requireNotNull(raw["receipt"] as? JsonObject))
        require(receipt == null || receipt.actor == wallet && receipt.request == request)
        BaseClaimStatus(flag(raw, "enabled"), receipt)
    } }
}
data class BaseClaimCancellation(val cancelled: Boolean, val receipt: BaseClaimReceipt?) {
    companion object { fun from(raw: JsonObject, wallet: String, request: BaseClaimRequest): BaseClaimCancellation = with(BaseClaimContract) {
        keys(raw, "version", "wallet", "idempotencyKey", "cancelled", "receipt"); version(raw)
        require(raw["wallet"] == JsonPrimitive(wallet) && raw["idempotencyKey"] == JsonPrimitive(request.idempotencyKey))
        val receipt = if (raw["receipt"] == JsonNull) null else BaseClaimReceipt.from(requireNotNull(raw["receipt"] as? JsonObject))
        val cancelled = flag(raw, "cancelled"); require(cancelled == (receipt == null))
        require(receipt == null || receipt.actor == wallet && receipt.request == request)
        BaseClaimCancellation(cancelled, receipt)
    } }
}
