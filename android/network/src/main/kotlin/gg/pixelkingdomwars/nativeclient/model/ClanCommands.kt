package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.util.UUID
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Exact shared/clanCommands v1 proof. Amounts and transaction identity are server evidence. */
object ClanCommandContract {
    fun id(value: String) {
        require(UUID.fromString(value).toString() == value && (value.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
            value == "00000000-0000-0000-0000-000000000000" || value == "ffffffff-ffff-ffff-ffff-ffffffffffff")) { "A canonical clan command UUID is required" }
    }
    fun wallet(value: String) { require(value.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))) }
    fun text(row: JsonObject, key: String): String = requireNotNull((row[key] as? JsonPrimitive)?.takeIf { it.isString }?.content)
    fun optional(row: JsonObject, key: String): String? = if (row[key] == JsonNull) null else text(row, key)
    val refusals = setOf("CLAN_CHANGED", "CLAN_LEADER_NOT_ALONE", "CLAN_NOT_LEADER", "CLAN_SELF_KICK", "CLAN_TARGET_ABSENT")
}

@Serializable data class ClanCommandReceipt(
    val version: Int, val actor: String, val idempotencyKey: String, val kind: String,
    val clanId: String, val baseId: String?, val target: String?, val state: String,
    val payoutShards: String, val ledgerTransactionId: String?, val refusalCode: String?, val createdAt: String,
) {
    init {
        require(version == 1); ClanCommandContract.wallet(actor); ClanCommandContract.id(idempotencyKey)
        ClanCommandContract.id(clanId); baseId?.let(ClanCommandContract::id); target?.let(ClanCommandContract::wallet)
        ledgerTransactionId?.let(ClanCommandContract::id); require(createdAt.endsWith('Z')); Instant.parse(createdAt)
        require(kind in setOf("leave", "kick") && state in setOf("left", "disbanded", "kicked", "refused"))
        require(if (kind == "leave") target == null && state != "kicked"
            else baseId == null && target != null && state in setOf("kicked", "refused"))
        require((state == "refused") == (refusalCode != null) && (refusalCode == null || refusalCode in ClanCommandContract.refusals))
        require(payoutShards.matches(Regex("0|[1-9][0-9]{0,18}")) && payoutShards.toLongOrNull() != null)
        require(if (state == "disbanded") (payoutShards != "0") == (ledgerTransactionId != null)
            else payoutShards == "0" && ledgerTransactionId == null)
    }
    companion object { fun from(raw: JsonObject): ClanCommandReceipt {
        require(raw["version"] == JsonPrimitive(1))
        listOf("actor", "idempotencyKey", "kind", "clanId", "state", "payoutShards", "createdAt").forEach { ClanCommandContract.text(raw, it) }
        listOf("baseId", "target", "ledgerTransactionId", "refusalCode").forEach { ClanCommandContract.optional(raw, it) }
        return Json.decodeFromJsonElement(raw)
    } }
}

@Serializable data class ClanCommandStatus(val version: Int, val wallet: String, val idempotencyKey: String, val receipt: ClanCommandReceipt?) {
    init {
        require(version == 1); ClanCommandContract.wallet(wallet); ClanCommandContract.id(idempotencyKey)
        require(receipt == null || (receipt.actor == wallet && receipt.idempotencyKey == idempotencyKey))
    }
    companion object { fun from(raw: JsonObject): ClanCommandStatus {
        require(raw["version"] == JsonPrimitive(1)); ClanCommandContract.text(raw, "wallet"); ClanCommandContract.text(raw, "idempotencyKey")
        if (raw["receipt"] != JsonNull) ClanCommandReceipt.from(requireNotNull(raw["receipt"] as? JsonObject))
        return Json.decodeFromJsonElement(raw)
    } }
}
