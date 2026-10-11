package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import java.math.BigDecimal
import java.time.Instant
import java.util.UUID

/** Exact wallet grant state; this is neither a KEEP receipt nor inferred from a balance. */
data class DevnetGrant(val id: String, val status: String, val lamports: String, val signature: String?,
    val requestedAt: String, val sentAt: String?, val raw: JsonObject) {
    companion object { fun from(r: JsonObject): DevnetGrant {
        val id = r.requiredText("id"); require(UUID.fromString(id).toString() == id.lowercase())
        val status = r.requiredText("status"); require(status in setOf("requested", "sent", "failed"))
        val amount = r.requiredText("lamports"); require(amount.matches(Regex("[1-9][0-9]*")))
        val requested = r.requiredText("requestedAt"); Instant.parse(requested)
        val sent = r.nullableText("sentAt"); sent?.let(Instant::parse)
        val signature = r.nullableText("txSignature")
        if (signature != null) require(signature.matches(Regex("[1-9A-HJ-NP-Za-km-z]{64,88}")))
        if (status == "sent") require(signature != null && sent != null)
        return DevnetGrant(id, status, amount, signature, requested, sent, r)
    } }
}
data class DevnetFaucetStatus(val enabled: Boolean, val eligible: Boolean, val reason: String, val grantSol: String,
    val grantedSol: String, val lifetimeCapSol: String, val minBalanceSol: String, val cooldownHours: String,
    val nextEligibleAt: String?, val last: DevnetGrant?) {
    companion object { fun from(r: JsonObject): DevnetFaucetStatus {
        fun flag(k: String) = requireNotNull((r[k] as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull)
        fun amount(k: String): String = requireNotNull((r[k] as? JsonPrimitive)?.takeUnless { it.isString }?.content).also {
            require(BigDecimal(it).signum() >= 0)
        }
        val reason = r.requiredText("reason")
        require(reason in setOf("ok", "disabled", "not_devnet", "pending", "balance_ok", "cap_reached", "cooldown", "no_player", "rpc_unavailable"))
        val enabled = flag("enabled"); val eligible = flag("eligible")
        require(!eligible || (enabled && reason == "ok"))
        val next = r.nullableText("nextEligibleAt"); next?.let(Instant::parse)
        val last = r["last"].let { if (it == JsonNull) null else DevnetGrant.from(requireNotNull(it as? JsonObject)) }
        require(!eligible || last?.status != "requested")
        return DevnetFaucetStatus(enabled, eligible, reason, amount("grantSol"), amount("grantedSol"), amount("lifetimeCapSol"),
            amount("minBalanceSol"), amount("cooldownHours"), next, last)
    } }
}
private fun JsonObject.requiredText(k: String) = requireNotNull((get(k) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun JsonObject.nullableText(k: String): String? = if (get(k) == JsonNull) null else requiredText(k)
