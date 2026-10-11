package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.time.LocalDate
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Exact shared/forgeClaims v1. KEEP always belongs to the actor's wallet ledger. */
object ForgeClaimContract {
    fun day(value: String) { require(value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}"))); require(LocalDate.parse(value).toString() == value) }
    fun amount(value: String): Long = value.also { require(it.matches(Regex("0|[1-9][0-9]{0,18}"))) }.toLong().also { require(it >= 0) }
    fun text(raw: JsonObject, key: String) = ClanCommandContract.text(raw, key)
    fun optional(raw: JsonObject, key: String) = ClanCommandContract.optional(raw, key)
}
@Serializable data class ForgeClaimDay(val day: String, val keep: String, val ledgerTransactionId: String) {
    init { ForgeClaimContract.day(day); require(ForgeClaimContract.amount(keep) > 0); ClanCommandContract.id(ledgerTransactionId) }
}
@Serializable data class ForgeClaimResult(val claimed: List<ForgeClaimDay>, val totalKeep: String, val remaining: Long) {
    init {
        ForgeClaimContract.amount(totalKeep); require(remaining in 0..((1L shl 53) - 1))
        require(claimed.sumOf { it.keep.toBigInteger() } == totalKeep.toBigInteger())
        require(claimed.zipWithNext().all { (a, b) -> a.day < b.day })
        require(claimed.map { it.ledgerTransactionId }.distinct().size == claimed.size)
    }
}
@Serializable data class ForgeClaimReceipt(val version: Int, val actor: String, val idempotencyKey: String,
    val baseId: String?, val day: String?, val result: ForgeClaimResult, val createdAt: String) {
    init {
        require(version == 1); ClanCommandContract.wallet(actor); ClanCommandContract.id(idempotencyKey)
        baseId?.let(ClanCommandContract::id); day?.let(ForgeClaimContract::day)
        require(createdAt.endsWith('Z')); Instant.parse(createdAt)
        require(day == null || result.claimed.all { it.day == day })
    }
    companion object { fun from(raw: JsonObject, batchMax: Int): ForgeClaimReceipt {
        require(batchMax > 0 && raw["version"] == JsonPrimitive(1))
        listOf("actor", "idempotencyKey", "createdAt").forEach { ForgeClaimContract.text(raw, it) }
        listOf("baseId", "day").forEach { ForgeClaimContract.optional(raw, it) }
        val result = requireNotNull(raw["result"] as? JsonObject); ForgeClaimContract.text(result, "totalKeep")
        val remaining = requireNotNull(result["remaining"] as? JsonPrimitive); require(!remaining.isString && remaining.longOrNull != null)
        val rows = requireNotNull(result["claimed"] as? JsonArray); require(rows.size <= batchMax)
        rows.forEach { row -> listOf("day", "keep", "ledgerTransactionId").forEach { ForgeClaimContract.text(row.jsonObject, it) } }
        return Json.decodeFromJsonElement(raw)
    } }
}
@Serializable data class ForgeClaimStatus(val version: Int, val wallet: String, val idempotencyKey: String,
    val enabled: Boolean, val receipt: ForgeClaimReceipt?) {
    init { require(version == 1); ClanCommandContract.wallet(wallet); ClanCommandContract.id(idempotencyKey)
        require(receipt == null || receipt.actor == wallet && receipt.idempotencyKey == idempotencyKey) }
    companion object { fun from(raw: JsonObject, batchMax: Int): ForgeClaimStatus {
        require(raw["version"] == JsonPrimitive(1)); ForgeClaimContract.text(raw, "wallet"); ForgeClaimContract.text(raw, "idempotencyKey")
        require(raw["enabled"] == JsonPrimitive(true) || raw["enabled"] == JsonPrimitive(false))
        if (raw["receipt"] != JsonNull) ForgeClaimReceipt.from(requireNotNull(raw["receipt"] as? JsonObject), batchMax)
        return Json.decodeFromJsonElement(raw)
    } }
}
