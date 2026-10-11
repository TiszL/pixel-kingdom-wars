package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import kotlinx.serialization.json.*

/** The complete original paid queue. Free first_troops and legacy intents never acquire these terms. */
data class PaidTrainingFinishIntent(val baseId: String?, val idempotencyKey: String, val expectedCurrency: GameCurrency,
    val queue: List<QueueConsentRow>, val maxCostKeep: String) {
    init {
        baseId?.let(ResearchSpeedup::uuid); require(idempotencyKey.length in 8..128); ResearchSpeedup.amount(maxCostKeep)
        require(queue.isNotEmpty() && queue.map { it.id }.distinct().size == queue.size)
        queue.forEach { TrainingFinish.row(it) }
    }
    val consent: JsonObject get() = buildJsonObject {
        put("version", TrainingFinish.CONSENT_VERSION); put("queue", JsonArray(queue.map(TrainingFinish::rowJson))); put("maxCostKeep", maxCostKeep)
    }
    val json: JsonObject get() = buildJsonObject {
        put("baseId", baseId?.let(::JsonPrimitive) ?: JsonNull); put("idempotencyKey", idempotencyKey)
        put("expectedCurrency", expectedCurrency.name); put("consent", consent)
    }
    val body: JsonObject get() = buildJsonObject { baseId?.let { put("baseId", it) }; put("idempotencyKey", idempotencyKey); put("consent", consent) }
    val query: Map<String, String> get() = mapOf("idempotencyKey" to idempotencyKey) + baseId?.let { mapOf("baseId" to it) }.orEmpty()
}

data class PaidTrainingFinishAcceptance(val intent: PaidTrainingFinishIntent, val receiptId: String, val acceptedAt: String,
    val amount: String, val completedAt: String, val completed: List<Pair<String, Int>>)

/** Mirrors shared/trainingFinish.ts. Historical proof does not depend on today's catalogue or queue. */
object TrainingFinish {
    const val PATH = "/army/train/speedup"
    const val RECEIPT = "$PATH/receipt"
    const val CONSENT_VERSION = 2 // Wire protocol generation, not a game value.
    private val timestamp = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
    private fun keys(raw: JsonObject, expected: Set<String>) = require(raw.keys == expected) { "Training fields differ" }
    private fun text(raw: JsonObject, key: String) = requireNotNull((raw[key] as? JsonPrimitive)?.takeIf { it.isString }?.content)
    private fun integer(raw: JsonObject, key: String): Int {
        val n = requireNotNull(raw[key] as? JsonPrimitive).also { require(!it.isString) }
        return requireNotNull(n.intOrNull).also { require(n.content == it.toString()) }
    }
    private fun time(value: String): Instant = Instant.parse(value).also {
        require(value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")) && timestamp.format(it) == value)
    }
    internal fun row(value: QueueConsentRow) { ResearchSpeedup.uuid(value.id); require(time(value.startedAt) < time(value.finishesAt)) }
    internal fun rowJson(value: QueueConsentRow) = buildJsonObject { put("id", value.id); put("startedAt", value.startedAt); put("finishesAt", value.finishesAt) }
    private fun parseRow(raw: JsonObject): QueueConsentRow {
        keys(raw, setOf("id", "startedAt", "finishesAt"))
        return QueueConsentRow(text(raw, "id"), text(raw, "startedAt"), text(raw, "finishesAt")).also(::row)
    }
    private fun rows(raw: JsonElement?) = requireNotNull(raw as? JsonArray).map { parseRow(requireNotNull(it as? JsonObject)) }
    private fun troop(value: String) = value.also { require(it.matches(Regex("[a-z][a-z0-9_]*"))) }
    fun parse(raw: JsonObject): PaidTrainingFinishIntent {
        keys(raw, setOf("baseId", "idempotencyKey", "expectedCurrency", "consent"))
        val consent = requireNotNull(raw["consent"] as? JsonObject); keys(consent, setOf("version", "queue", "maxCostKeep"))
        require(consent["version"] == JsonPrimitive(CONSENT_VERSION))
        return PaidTrainingFinishIntent(if (raw["baseId"] == JsonNull) null else text(raw, "baseId"), text(raw, "idempotencyKey"),
            GameCurrency.valueOf(text(raw, "expectedCurrency")), rows(consent["queue"]), text(consent, "maxCostKeep"))
    }
    /** Server price and complete queue only. Missing/ambiguous free eligibility never authorizes a debit. */
    fun prepare(baseId: String?, key: String, army: JsonObject, balances: JsonObject, capabilities: JsonObject, catalogue: JsonObject): PaidTrainingFinishIntent {
        val features = requireNotNull(army["features"] as? JsonObject)
        require((features["trainingFinishReceipts"] as? JsonObject)?.get("version") == JsonPrimitive(1))
        val constants = requireNotNull(catalogue["constants"] as? JsonObject)
        val schedule = requireNotNull(constants["TRAINING_SCHEDULE"] as? JsonObject)
        val live = requireNotNull(features["trainingScheduling"] as? JsonObject)
        require(schedule["version"] == JsonPrimitive(CONSENT_VERSION) && live["version"] == schedule["version"] && live["mode"] == JsonPrimitive("sequential") &&
            live["lanes"] == schedule["lanesPerBase"] && integer(schedule, "lanesPerBase") > 0 && live["consentRequired"] == JsonPrimitive(true))
        require(army["freeFinishAllOffer"] == JsonNull && army["freeFinishAllReviewRequired"] == JsonPrimitive(false)) { "Resolve the free finish offer or review before paying" }
        val currency = requireNotNull((capabilities["economy"] as? JsonObject)?.get("gameCurrency") as? JsonObject)
        require(currency["version"] == JsonPrimitive(1) && currency["exactSpendCurrency"] == JsonPrimitive(1))
        val quote = requireNotNull(army["finishAllQuote"] as? JsonObject)
        val terms = parse(buildJsonObject { put("baseId", baseId?.let(::JsonPrimitive) ?: JsonNull); put("idempotencyKey", key)
            put("expectedCurrency", ExactGameCurrency.choose(text(quote, "maxCostKeep"), balances).name); put("consent", quote) })
        require(terms.queue.size <= integer(schedule, "maxConsentQueueRows"))
        val troops = requireNotNull(constants["TROOPS"] as? JsonObject)
        val current = requireNotNull(army["queue"] as? JsonArray).map { value ->
            val r = requireNotNull(value as? JsonObject); require(troops.containsKey(troop(text(r, "troop"))))
            parseRow(JsonObject(r.filterKeys { it in setOf("id", "startedAt", "finishesAt") }))
        }
        require(current == terms.queue) { "The price must describe the complete current queue" }
        return terms
    }
    fun proof(raw: JsonObject, wallet: String, original: PaidTrainingFinishIntent): PaidTrainingFinishAcceptance? {
        ResearchSpeedup.wallet(wallet); require(raw["version"] == JsonPrimitive(1))
        if (text(raw, "status") == "unknown") {
            keys(raw, setOf("version", "status", "idempotencyKey")); require(text(raw, "idempotencyKey") == original.idempotencyKey); return null
        }
        keys(raw, setOf("version", "status", "wallet", "request", "receiptId", "acceptedAt", "funding", "result"))
        require(text(raw, "status") == "accepted" && text(raw, "wallet") == wallet && parse(requireNotNull(raw["request"] as? JsonObject)) == original)
        val funding = requireNotNull(raw["funding"] as? JsonObject); keys(funding, setOf("currency", "amount"))
        val debit = ResearchSpeedup.amount(text(funding, "amount"))
        require(text(funding, "currency") == original.expectedCurrency.name && debit.toBigInteger() <= original.maxCostKeep.toBigInteger())
        val result = requireNotNull(raw["result"] as? JsonObject); keys(result, setOf("completedAt", "paidRows", "completed"))
        val completedAt = text(result, "completedAt"); val at = time(completedAt)
        val counts = linkedMapOf<String, Int>()
        val paid = requireNotNull(result["paidRows"] as? JsonArray).map { value ->
            val r = requireNotNull(value as? JsonObject); keys(r, setOf("id", "startedAt", "finishesAt", "troop"))
            val name = troop(text(r, "troop")); counts[name] = (counts[name] ?: 0) + 1
            parseRow(JsonObject(r - "troop")).also { require(time(it.finishesAt) > at) }
        }
        val due = original.queue.filter { time(it.finishesAt) > at }
        require(paid.isNotEmpty() && paid.size == due.size && paid.toSet().size == paid.size && paid.toSet() == due.toSet())
        val completed = requireNotNull(result["completed"] as? JsonArray).map { value ->
            val r = requireNotNull(value as? JsonObject); keys(r, setOf("troop", "count"))
            troop(text(r, "troop")) to integer(r, "count").also { require(it > 0 && it <= paid.size) }
        }
        require(completed == counts.toList()) { "Paid counts must match the original still-running rows" }
        return PaidTrainingFinishAcceptance(original, ResearchSpeedup.uuid(text(raw, "receiptId")), text(raw, "acceptedAt").also { time(it) }, debit, completedAt, completed)
    }
}
