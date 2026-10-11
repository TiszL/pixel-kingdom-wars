package gg.pixelkingdomwars.nativeclient.model

import gg.pixelkingdomwars.nativeclient.workshop.wallet
import kotlinx.serialization.json.*
import java.math.BigInteger
import java.time.Instant
import java.time.LocalDate
import java.util.Base64
import java.util.UUID

/** Unknown additive states are preserved, and are never silently promoted to an actionable state. */
data class SkrFaucetValue(val raw: String, val known: Boolean) {
    fun isValue(expected: String) = known && raw == expected
}

data class SkrFaucetAttempt(val id: String, val phase: SkrFaucetValue, val signature: String?, val lastValidBlockHeight: String) {
    companion object { fun from(raw: JsonObject): SkrFaucetAttempt {
        val signature = raw.skrNullableText("signature")
        signature?.let { require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{64,88}"))) }
        return SkrFaucetAttempt(skrUuid(raw.skrText("id")), raw.skrEnum("phase", setOf("prepared", "player_signed", "submitted", "finalized", "failed", "expired", "abandoned")),
            signature, skrAmount(raw.skrText("lastValidBlockHeight"), positive = true))
    } }
}
data class SkrFaucetGrant(val id: String, val status: SkrFaucetValue, val mint: String, val decimals: Int,
    val amountRaw: String, val error: String?, val requestedAt: String, val sentAt: String?,
    val attempt: SkrFaucetAttempt?, val raw: JsonObject) {
    fun sameIdentity(other: SkrFaucetGrant) = id == other.id && mint == other.mint && decimals == other.decimals &&
        amountRaw == other.amountRaw && requestedAt == other.requestedAt
    companion object {
        fun from(raw: JsonObject): SkrFaucetGrant {
            val mint = raw.skrText("mint").also(::wallet)
            val decimals = raw.skrInt("decimals").also { require(it in 0..255) }
            val sentAt = raw.skrNullableText("sentAt")?.also(Instant::parse)
            val status = raw.skrEnum("status", setOf("requested", "sent", "failed"))
            val attempt = raw.skrNullableObject("attempt")?.let(SkrFaucetAttempt::from)
            // DAILY_LIMIT's today DTO legitimately omits the attempt even for a sent grant.
            if (status.isValue("sent")) require(sentAt != null)
            return SkrFaucetGrant(skrUuid(raw.skrText("id")), status, mint, decimals, skrAmount(raw.skrText("amountRaw"), positive = true),
                raw.skrNullableText("error"), raw.skrText("requestedAt").also(Instant::parse), sentAt, attempt, raw)
        }
        fun fromDailyLimit(details: JsonObject): SkrFaucetGrant? = details.skrNullableObject("today")?.let(::from)
    }
}
data class SkrFaucetStatus(val enabled: Boolean, val eligible: Boolean, val reason: SkrFaucetValue,
    val label: String, val symbol: String, val mint: String?, val decimals: Int?, val grantSkr: String,
    val grantRaw: String?, val day: String, val nextEligibleAt: String, val today: SkrFaucetGrant?) {
    companion object { fun from(raw: JsonObject): SkrFaucetStatus {
        require(raw.skrText("cluster") == "devnet" && raw.skrBoolean("isTestToken"))
        val mint = raw.skrNullableText("mint")?.also(::wallet)
        val decimals = if (raw["decimals"] == JsonNull) null else raw.skrInt("decimals").also { require(it in 0..255) }
        return SkrFaucetStatus(raw.skrBoolean("enabled"), raw.skrBoolean("eligible"), raw.skrEnum("reason", setOf("ok", "disabled", "unconfigured", "unavailable",
            "select_base", "deed_required", "retired_deed", "deed_unavailable", "daily_limit", "pending", "sign_required", "submitted")),
            raw.skrText("label"), raw.skrText("symbol"), mint, decimals, skrAmount(raw.skrText("grantSkr"), true),
            raw.skrNullableText("grantRaw")?.let { skrAmount(it, true) }, raw.skrText("day").also(LocalDate::parse),
            raw.skrText("nextEligibleAt").also(Instant::parse), raw.skrNullableObject("today")?.let(SkrFaucetGrant::from))
    } }
}
data class SkrFaucetPrepared(val grant: SkrFaucetGrant, val unsignedTransaction: String,
    val networkFeeLamports: String, val accountRentLamports: String) {
    companion object { fun from(raw: JsonObject): SkrFaucetPrepared {
        val wire = raw.skrText("unsignedTransaction")
        require(wire.length <= 1644 && wire.matches(Regex("[A-Za-z0-9+/]+={0,2}")))
        val bytes = Base64.getDecoder().decode(wire)
        require(bytes.size <= 1232 && Base64.getEncoder().encodeToString(bytes) == wire)
        val grant = SkrFaucetGrant.from(requireNotNull(raw["grant"] as? JsonObject))
        require(grant.status.isValue("requested") && grant.attempt?.phase?.isValue("prepared") == true)
        return SkrFaucetPrepared(grant, wire, skrAmount(raw.skrText("networkFeeLamports")), skrAmount(raw.skrText("accountRentLamports")))
    } }
}

/** Authenticated wallet-owned nonterminal discovery; the cap comes from the admitted P5 policy. */
data class SkrFaucetGrantPage(val items: List<SkrFaucetGrant>, val nextCursor: String?) {
    companion object { fun from(raw: JsonObject, maxItems: Int): SkrFaucetGrantPage {
        require(maxItems > 0 && raw.keys == setOf("items", "nextCursor"))
        val rows = requireNotNull(raw["items"] as? JsonArray)
        require(rows.size <= maxItems)
        val items = rows.map { SkrFaucetGrant.from(it.jsonObject) }
        require(items.map { it.id }.distinct().size == items.size)
        val cursor = raw.skrNullableText("nextCursor")?.let(::skrUuid)
        require(cursor == null || items.lastOrNull()?.id == cursor)
        return SkrFaucetGrantPage(items, cursor)
    } }
}

private fun JsonObject.skrText(key: String): String = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content).also { require(it.isNotEmpty()) }
private fun JsonObject.skrNullableText(key: String): String? = if (get(key) == JsonNull) null else skrText(key)
private fun JsonObject.skrNullableObject(key: String): JsonObject? = if (get(key) == JsonNull) null else requireNotNull(get(key) as? JsonObject)
private fun JsonObject.skrInt(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
private fun JsonObject.skrBoolean(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull)
private fun JsonObject.skrEnum(key: String, known: Set<String>) = skrText(key).let { SkrFaucetValue(it, it in known) }
private fun skrUuid(value: String) = value.also { require(UUID.fromString(it).toString() == it) }
private fun skrAmount(value: String, positive: Boolean = false): String = value.also {
    require(it.matches(Regex(if (positive) "[1-9][0-9]{0,19}" else "0|[1-9][0-9]{0,19}")))
    require(it.toBigInteger() <= BigInteger.ONE.shiftLeft(64).subtract(BigInteger.ONE))
}
