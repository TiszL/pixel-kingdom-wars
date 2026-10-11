package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.serialization.json.*

/** The original paid job episode; build and zero-cost completion never acquire this consent. */
data class BuilderJobSpeedupConsent(val kind: String, val buildingId: String?, val obstacleId: String?,
    val startedAt: String, val finishesAt: String, val maxCostKeep: String) {
    init {
        require(kind in setOf("upgrade", "repair", "clear_obstacle"))
        buildingId?.let(ResearchSpeedup::uuid); obstacleId?.let(ResearchSpeedup::uuid)
        require(if (kind == "clear_obstacle") obstacleId != null && buildingId == null else buildingId != null && obstacleId == null)
        require(BuilderJobSpeedup.time(startedAt) < BuilderJobSpeedup.time(finishesAt)); ResearchSpeedup.amount(maxCostKeep)
    }
    val json: JsonObject get() = buildJsonObject {
        put("version", 1); put("kind", kind); put("buildingId", buildingId?.let(::JsonPrimitive) ?: JsonNull)
        put("obstacleId", obstacleId?.let(::JsonPrimitive) ?: JsonNull); put("startedAt", startedAt)
        put("finishesAt", finishesAt); put("maxCostKeep", maxCostKeep)
    }
}

data class BuilderJobSpeedupIntent(val jobId: String, val baseId: String?, val idempotencyKey: String,
    val expectedCurrency: GameCurrency, val consent: BuilderJobSpeedupConsent) {
    init { ResearchSpeedup.uuid(jobId); baseId?.let(ResearchSpeedup::uuid); require(idempotencyKey.length in 8..128) }
    val path: String get() = "/base/jobs/$jobId/speedup"
    val json: JsonObject get() = buildJsonObject {
        put("jobId", jobId); put("baseId", baseId?.let(::JsonPrimitive) ?: JsonNull); put("idempotencyKey", idempotencyKey)
        put("expectedCurrency", expectedCurrency.name); put("consent", consent.json)
    }
    val body: JsonObject get() = buildJsonObject { baseId?.let { put("baseId", it) }; put("idempotencyKey", idempotencyKey); put("consent", consent.json) }
    val query: Map<String, String> get() = mapOf("jobId" to jobId, "idempotencyKey" to idempotencyKey) + baseId?.let { mapOf("baseId" to it) }.orEmpty()
}

data class BuilderJobSpeedupAcceptance(val intent: BuilderJobSpeedupIntent, val receiptId: String,
    val acceptedAt: String, val amount: String, val completedAt: String)

/** Mirrors shared/builderJobSpeedup.ts. Historical proof requires no current job or catalogue. */
object BuilderJobSpeedup {
    const val RECEIPT = "/base/jobs/speedup/receipt"
    private val timestamp = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    internal fun time(value: String): Instant = Instant.parse(value).also {
        require(value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")) && timestamp.format(it) == value)
    }
    private fun keys(raw: JsonObject, expected: Set<String>) = require(raw.keys == expected) { "Builder speedup fields differ" }
    private fun text(raw: JsonObject, key: String) = requireNotNull((raw[key] as? JsonPrimitive)?.takeIf { it.isString }?.content)
    private fun nullable(raw: JsonObject, key: String) = if (raw[key] == JsonNull) null else text(raw, key)
    fun consent(raw: JsonObject): BuilderJobSpeedupConsent {
        keys(raw, setOf("version", "kind", "buildingId", "obstacleId", "startedAt", "finishesAt", "maxCostKeep")); require(raw["version"] == JsonPrimitive(1))
        return BuilderJobSpeedupConsent(text(raw, "kind"), nullable(raw, "buildingId"), nullable(raw, "obstacleId"),
            text(raw, "startedAt"), text(raw, "finishesAt"), text(raw, "maxCostKeep"))
    }
    fun parse(raw: JsonObject): BuilderJobSpeedupIntent {
        keys(raw, setOf("jobId", "baseId", "idempotencyKey", "expectedCurrency", "consent"))
        return BuilderJobSpeedupIntent(text(raw, "jobId"), nullable(raw, "baseId"), text(raw, "idempotencyKey"),
            GameCurrency.valueOf(text(raw, "expectedCurrency")), consent(requireNotNull(raw["consent"] as? JsonObject)))
    }
    fun prepare(jobId: String, baseId: String, key: String, base: JsonObject, balances: JsonObject, capabilities: JsonObject): BuilderJobSpeedupIntent {
        require(text(base, "baseId") == baseId)
        val feature = (base["features"] as? JsonObject)?.get("builderJobSpeedup") as? JsonObject
        require(feature?.get("version") == JsonPrimitive(1) && feature["receipts"] == JsonPrimitive(1))
        val currency = (capabilities["economy"] as? JsonObject)?.get("gameCurrency") as? JsonObject
        require(currency?.get("version") == JsonPrimitive(1) && currency["exactSpendCurrency"] == JsonPrimitive(1))
        val job = requireNotNull(base["jobs"] as? JsonArray).map { requireNotNull(it as? JsonObject) }.single { text(it, "id") == jobId }
        val terms = consent(requireNotNull(job["paidFinishQuote"] as? JsonObject))
        require(terms.kind == text(job, "kind") && terms.buildingId == nullable(job, "buildingId") && terms.obstacleId == nullable(job, "obstacleId") &&
            terms.startedAt == text(job, "startedAt") && terms.finishesAt == text(job, "finishesAt") && terms.maxCostKeep == text(job, "finishCostKeep"))
        return BuilderJobSpeedupIntent(jobId, baseId, key, ExactGameCurrency.choose(terms.maxCostKeep, balances), terms)
    }
    fun proof(raw: JsonObject, wallet: String, original: BuilderJobSpeedupIntent): BuilderJobSpeedupAcceptance? {
        ResearchSpeedup.wallet(wallet); require(raw["version"] == JsonPrimitive(1))
        if (text(raw, "status") == "unknown") {
            keys(raw, setOf("version", "status", "idempotencyKey")); require(text(raw, "idempotencyKey") == original.idempotencyKey); return null
        }
        keys(raw, setOf("version", "status", "wallet", "request", "receiptId", "acceptedAt", "funding", "result"))
        require(text(raw, "status") == "accepted" && text(raw, "wallet") == wallet && parse(requireNotNull(raw["request"] as? JsonObject)) == original)
        val funding = requireNotNull(raw["funding"] as? JsonObject); keys(funding, setOf("currency", "amount"))
        val amount = ResearchSpeedup.amount(text(funding, "amount"))
        require(text(funding, "currency") == original.expectedCurrency.name && amount.toBigInteger() <= original.consent.maxCostKeep.toBigInteger())
        val result = requireNotNull(raw["result"] as? JsonObject); keys(result, setOf("jobId", "kind", "buildingId", "obstacleId", "completedAt"))
        require(text(result, "jobId") == original.jobId && text(result, "kind") == original.consent.kind &&
            nullable(result, "buildingId") == original.consent.buildingId && nullable(result, "obstacleId") == original.consent.obstacleId)
        val completedAt = text(result, "completedAt"); val at = time(completedAt)
        require(at >= time(original.consent.startedAt) && at < time(original.consent.finishesAt))
        return BuilderJobSpeedupAcceptance(original, ResearchSpeedup.uuid(text(raw, "receiptId")), text(raw, "acceptedAt").also { time(it) }, amount, completedAt)
    }
}
