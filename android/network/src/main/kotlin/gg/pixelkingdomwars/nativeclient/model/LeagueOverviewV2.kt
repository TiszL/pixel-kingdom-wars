package gg.pixelkingdomwars.nativeclient.model

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.rawResourceIds
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.uuid as canonicalUuid
import gg.pixelkingdomwars.nativeclient.workshop.wallet as canonicalWallet
import java.math.BigInteger
import java.time.LocalDate
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.*
import kotlinx.serialization.serializer

// Wire identities only. Thresholds, reward amounts and allocation policy belong
// to the supplied catalogue/server; this decoder never projects a reward.
private val leagueV2TierIds = setOf("bronze", "silver", "gold", "platinum", "diamond", "solana", "seeker")
private val leagueV2Json = Json { ignoreUnknownKeys = true }
private val leagueU64Max = BigInteger.ONE.shiftLeft(64) - BigInteger.ONE

/** Derived from the original payload, never a wire-supplied presentation hint. */
enum class LeaguePresentationMode { LEGACY, V2, UNAVAILABLE }

internal fun leaguePresentationMode(raw: JsonObject): LeaguePresentationMode {
    if (raw.containsKey("ladderVersion")) {
        val version = raw["ladderVersion"] as? JsonPrimitive
        return if (version != null && !version.isString && version.intOrNull == 2) LeaguePresentationMode.V2
            else LeaguePresentationMode.UNAVAILABLE
    }
    // Losing an invalid optional field during sanitization must not revive a
    // legacy reward projection. Presence, including null, is protocol evidence.
    val standing = raw["you"] as? JsonObject
    val settlement = raw["lastSettlement"] as? JsonObject
    val hasV2Fields = listOf("weeklyBoard", "skr").any(raw::containsKey) ||
        listOf("tierV2", "rewardV2", "weeklyScore").any { standing?.containsKey(it) == true } ||
        listOf("tierV2", "gems", "pack").any { settlement?.containsKey(it) == true } ||
        (raw["board"] as? JsonArray)?.any { (it as? JsonObject)?.containsKey("tierV2") == true } == true
    return if (hasV2Fields) LeaguePresentationMode.UNAVAILABLE else LeaguePresentationMode.LEGACY
}

private fun leagueAmount(value: String, positive: Boolean = false) {
    require(value.matches(Regex("0|[1-9][0-9]{0,19}")))
    val amount = value.toBigInteger()
    require(amount <= leagueU64Max && (!positive || amount.signum() > 0))
}

@Serializable data class LeaguePackLine(val resourceId: String, val qty: String) {
    init {
        require(resourceId in rawResourceIds)
        leagueAmount(qty, positive = true)
        // Raw stock storage is signed int8; this is a representation bound,
        // not a local copy of the league pack policy.
        require(qty.toBigInteger() <= Long.MAX_VALUE.toBigInteger())
    }
}

@Serializable data class LeagueRewardV2(val shards: String, val gems: String, val pack: List<LeaguePackLine>) {
    init { leagueAmount(shards); leagueAmount(gems); uniquePack(pack) }
}

@Serializable data class LeagueWeeklyRank(val baseId: String, val name: String?, val weeklyScore: Int, val trophies: Int) {
    init { canonicalUuid(baseId); require(trophies >= 0) }
}

/** Wallet-scoped frozen allocation. A different selected base is valid; this
 * contains no authorization to sign, claim, transfer or spend the allocation. */
@Serializable data class LeagueSkrEntitlement(val week: String, val amountRaw: String, val baseId: String,
    val wallet: String, val decimals: Int, val place: Int, val band: Int, val weeklyScore: Int, val payoutStatus: String) {
    init {
        require(week.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}")) && LocalDate.parse(week).toString() == week)
        leagueAmount(amountRaw); canonicalUuid(baseId); canonicalWallet(wallet)
        // R0 resolveSkrMint's registry representation range, not mint-specific
        // tuning. Never assume the official mint or a fixed number of decimals.
        require(decimals in 0..19 && place > 0 && band in 1..3 && weeklyScore > 0)
        require(payoutStatus == "not_implemented")
    }
}

@Serializable data class LeagueSkrOverview(val status: String, val mint: String? = null, val label: String? = null,
    val entitlement: LeagueSkrEntitlement? = null) {
    init {
        require(status in setOf("disabled", "payout_deferred"))
        mint?.let(::canonicalWallet); label?.let { require(it.isNotBlank()) }
        require(status != "disabled" || entitlement == null)
    }
}

private fun uniquePack(pack: List<LeaguePackLine>) { require(pack.map { it.resourceId }.distinct().size == pack.size) }

/** Do not catch errors from the required legacy decoder. Only the additive
 * optional value being inspected is allowed to become unavailable. */
private inline fun <reified T> optionalValue(raw: JsonElement, validate: (T) -> Unit = {}): JsonElement? = runCatching {
    val schema = serializer<T>()
    strictPrimitives(raw, schema.descriptor)
    validate(leagueV2Json.decodeFromJsonElement(schema, raw))
    raw
}.getOrNull()

private fun JsonObject.optional(key: String, sanitize: (JsonElement) -> JsonElement?): JsonObject {
    val value = this[key] ?: return this
    val accepted = sanitize(value)
    return JsonObject(if (accepted == null) this - key else this + (key to accepted))
}

private fun tier(raw: JsonElement): JsonElement? = optionalValue<String>(raw) { require(it in leagueV2TierIds) }
private fun pack(raw: JsonElement): JsonElement? = runCatching {
    val schema = ListSerializer(LeaguePackLine.serializer())
    strictPrimitives(raw, schema.descriptor)
    uniquePack(leagueV2Json.decodeFromJsonElement(schema, raw))
    raw
}.getOrNull()

private fun skr(raw: JsonElement): JsonElement? {
    val value = raw as? JsonObject ?: return null
    val status = optionalValue<String>(value["status"] ?: return null) {
        require(it in setOf("disabled", "payout_deferred"))
    } ?: return null
    val normalized = value
        .optional("mint") { optionalValue<String>(it, ::canonicalWallet) }
        .optional("label") { optionalValue<String>(it) { text -> require(text.isNotBlank()) } }
        .optional("entitlement") {
            if (status.jsonPrimitive.content == "disabled") null else optionalValue<LeagueSkrEntitlement>(it)
        }
    return optionalValue<LeagueSkrOverview>(normalized)
}

/** The existing public LeagueOverview.from entry point calls this before its
 * unchanged legacy validation. Wrong required objects/rows are left intact so
 * the legacy serializer still refuses them. Unknown optional fields are ignored. */
internal fun sanitizeLeagueOverviewV2(raw: JsonObject): JsonObject {
    var normalized = raw
        .optional("ladderVersion") { optionalValue<Int>(it) { version -> require(version == 2) } }
        .optional("weeklyBoard") { optionalValue<List<LeagueWeeklyRank>>(it) { rows ->
            require(rows.map { row -> row.baseId }.distinct().size == rows.size)
        } }
        .optional("skr", ::skr)
    (raw["you"] as? JsonObject)?.let { standing ->
        normalized = JsonObject(normalized + ("you" to standing.optional("tierV2", ::tier)
            .optional("rewardV2") { optionalValue<LeagueRewardV2>(it) }
            .optional("weeklyScore") { optionalValue<Int>(it) }))
    }
    (raw["board"] as? JsonArray)?.let { board ->
        normalized = JsonObject(normalized + ("board" to JsonArray(board.map { row ->
            (row as? JsonObject)?.optional("tierV2", ::tier) ?: row
        })))
    }
    (raw["lastSettlement"] as? JsonObject)?.let { settlement ->
        normalized = JsonObject(normalized + ("lastSettlement" to settlement.optional("tierV2", ::tier)
            .optional("gems") { optionalValue<String>(it) { amount -> leagueAmount(amount) } }
            .optional("pack", ::pack)))
    }
    return normalized
}
