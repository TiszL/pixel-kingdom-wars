package gg.pixelkingdomwars.nativeclient.model

import java.time.OffsetDateTime
import java.util.UUID
import kotlinx.serialization.json.*

/** The original research episode and whole-currency ceiling. This is never a current army snapshot. */
data class ResearchSpeedupIntent(val troop: String, val baseId: String?, val idempotencyKey: String,
    val expectedCurrency: GameCurrency, val currentLevel: Int, val toLevel: Int, val finishesAt: String,
    val episodeId: String?, val maxCostKeep: String) {
    init {
        require(troop.matches(Regex("[a-z][a-z0-9_]*")))
        baseId?.let(ResearchSpeedup::uuid); episodeId?.let(ResearchSpeedup::uuid)
        require(idempotencyKey.length in 8..128)
        require(currentLevel > 0 && currentLevel < Int.MAX_VALUE && toLevel == currentLevel + 1)
        ResearchSpeedup.time(finishesAt); ResearchSpeedup.amount(maxCostKeep)
    }
    val json: JsonObject get() = buildJsonObject {
        put("troop", troop); put("baseId", baseId?.let(::JsonPrimitive) ?: JsonNull); put("idempotencyKey", idempotencyKey)
        put("expectedCurrency", expectedCurrency.name); put("currentLevel", currentLevel); put("toLevel", toLevel)
        put("finishesAt", finishesAt); put("episodeId", episodeId?.let(::JsonPrimitive) ?: JsonNull); put("maxCostKeep", maxCostKeep)
    }
    val body: JsonObject get() = buildJsonObject {
        put("troop", troop); baseId?.let { put("baseId", it) }; put("idempotencyKey", idempotencyKey)
        put("consent", JsonObject(json - setOf("troop", "baseId", "idempotencyKey", "expectedCurrency")))
    }
    val query: Map<String, String> get() = json.filterKeys { it != "baseId" || baseId != null }.mapValues {
        if (it.value == JsonNull) "null" else it.value.jsonPrimitive.content
    }
}

data class ResearchSpeedupAcceptance(val intent: ResearchSpeedupIntent, val receiptId: String,
    val acceptedAt: String, val amount: String)

/** Strict payment contract; old DTOs remain readable but cannot enable this new command. */
object ResearchSpeedup {
    const val PATH = "/army/research/speedup"
    const val RECEIPT = "$PATH/receipt"
    private val intentKeys = setOf("troop", "baseId", "idempotencyKey", "expectedCurrency", "currentLevel", "toLevel", "finishesAt", "episodeId", "maxCostKeep")
    private fun keys(raw: JsonObject, expected: Set<String>) = require(raw.keys == expected) { "Research fields differ" }
    private fun text(raw: JsonObject, key: String) = requireNotNull((raw[key] as? JsonPrimitive)?.takeIf { it.isString }?.content) { "Missing research text $key" }
    private fun integer(raw: JsonObject, key: String): Int {
        val value = requireNotNull(raw[key] as? JsonPrimitive).also { require(!it.isString) }
        return requireNotNull(value.intOrNull).also { require(value.content == it.toString()) }
    }
    private fun nullable(raw: JsonObject, key: String): String? = if (raw[key] == JsonNull) null else text(raw, key)
    fun uuid(value: String): String = value.also {
        require(it.matches(Regex("[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")))
        val parsed = UUID.fromString(it)
        require(it == "00000000-0000-0000-0000-000000000000" || it == "ffffffff-ffff-ffff-ffff-ffffffffffff" || parsed.version() in 1..8 && parsed.variant() == 2)
    }
    fun amount(value: String): String = value.also { require(it.matches(Regex("[1-9][0-9]{0,18}")) && it.toBigInteger() <= Long.MAX_VALUE.toBigInteger()) }
    fun time(value: String): String = value.also {
        require(it.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})")))
        OffsetDateTime.parse(it)
    }
    fun wallet(value: String): String = value.also { require(it.matches(Regex("[1-9A-HJ-NP-Za-km-z]{32,44}"))) }
    fun parse(raw: JsonObject): ResearchSpeedupIntent {
        keys(raw, intentKeys)
        return ResearchSpeedupIntent(text(raw, "troop"), nullable(raw, "baseId"), text(raw, "idempotencyKey"), GameCurrency.valueOf(text(raw, "expectedCurrency")),
            integer(raw, "currentLevel"), integer(raw, "toLevel"), text(raw, "finishesAt"), nullable(raw, "episodeId"), text(raw, "maxCostKeep"))
    }
    private fun supported(army: JsonObject): Boolean {
        val features = army["features"] as? JsonObject ?: return false
        return listOf("researchConsent", "researchSpeedupReceipts").all { (features[it] as? JsonObject)?.get("version") == JsonPrimitive(1) }
    }
    /** Only server-issued quotes plus verified catalogue bounds admit new intent creation. No local timer pricing. */
    fun prepare(troop: String, baseId: String?, key: String, army: JsonObject, balances: JsonObject,
                capabilities: JsonObject, catalogue: JsonObject): ResearchSpeedupIntent {
        check(supported(army)) { "Research finish receipts are unavailable" }
        val nativeCurrency = ((capabilities["economy"] as? JsonObject)?.get("gameCurrency") as? JsonObject)
        check(nativeCurrency?.get("version") == JsonPrimitive(1) && nativeCurrency["exactSpendCurrency"] == JsonPrimitive(1))
        val constants = requireNotNull(catalogue["constants"] as? JsonObject)
        check((constants["TROOPS"] as? JsonObject)?.containsKey(troop) == true)
        val maximum = integer(requireNotNull(constants["TROOP_LEVELING"] as? JsonObject), "maxLevel")
        val rows = requireNotNull(army["research"] as? JsonArray).map { requireNotNull(it as? JsonObject) }
        require(rows.map { text(it, "troop") }.distinct().size == rows.size)
        val row = rows.single { text(it, "troop") == troop }
        val quote = requireNotNull(row["finishQuote"] as? JsonObject) { "No current server finish quote" }
        keys(quote, setOf("currentLevel", "toLevel", "finishesAt", "episodeId", "maxCostKeep"))
        val current = integer(requireNotNull(army["levels"] as? JsonObject), troop)
        check(current > 0 && current < maximum && integer(quote, "currentLevel") == current)
        check(integer(row, "toLevel") == integer(quote, "toLevel") && row["finishesAt"] == quote["finishesAt"] && row["episodeId"] == quote["episodeId"])
        val currency = ExactGameCurrency.choose(amount(text(quote, "maxCostKeep")), balances)
        return parse(buildJsonObject {
            quote.forEach { (k, v) -> put(k, v) }; put("troop", troop); put("baseId", baseId?.let(::JsonPrimitive) ?: JsonNull)
            put("idempotencyKey", key); put("expectedCurrency", currency.name)
        })
    }
    /** Null means this exact key remains unknown. No level advancement or missing row is payment evidence. */
    fun proof(raw: JsonObject, originalWallet: String, intent: ResearchSpeedupIntent): ResearchSpeedupAcceptance? {
        wallet(originalWallet); require(raw["version"] == JsonPrimitive(1))
        if (text(raw, "status") == "unknown") {
            keys(raw, setOf("version", "status", "idempotencyKey")); require(text(raw, "idempotencyKey") == intent.idempotencyKey); return null
        }
        require(text(raw, "status") == "accepted")
        keys(raw, setOf("version", "status", "wallet", "request", "receiptId", "acceptedAt", "funding", "result"))
        require(text(raw, "wallet") == originalWallet && parse(requireNotNull(raw["request"] as? JsonObject)) == intent)
        val funding = requireNotNull(raw["funding"] as? JsonObject); keys(funding, setOf("currency", "amount"))
        require(text(funding, "currency") == intent.expectedCurrency.name)
        val debit = amount(text(funding, "amount")); require(debit.toBigInteger() <= intent.maxCostKeep.toBigInteger())
        val result = requireNotNull(raw["result"] as? JsonObject); keys(result, setOf("troop", "fromLevel", "toLevel"))
        require(text(result, "troop") == intent.troop && integer(result, "fromLevel") == intent.currentLevel && integer(result, "toLevel") == intent.toLevel)
        return ResearchSpeedupAcceptance(intent, uuid(text(raw, "receiptId")), time(text(raw, "acceptedAt")), debit)
    }
}
