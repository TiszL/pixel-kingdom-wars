package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

private fun JsonObject.text(name: String) = requireNotNull((get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun positive(value: String) = value.also { require(it.length <= 32 && it.matches(Regex("[1-9][0-9]*"))) }
private fun uuid(value: String) = value.also { require(UUID.fromString(it).toString().equals(it, ignoreCase = true)) }.lowercase()
/** JSON integers in the canonical JavaScript schema must be exactly representable. */
fun economyRate(value: JsonElement?): Long {
    val number = requireNotNull(value as? JsonPrimitive); require(!number.isString)
    return requireNotNull(number.longOrNull).also { require(it in 1..((1L shl 53) - 1)) }
}

enum class EconomyAction(val title: String) { CONVERT("Convert KEEP"), CONTRIBUTE("Contribute SHARDS") }
data class EconomyAcceptance(val action: EconomyAction, val baseId: String?, val amount: String,
    val outputShards: String? = null, val rate: Long? = null, val day: String? = null)

/** Mirrors the reviewed source receipt contracts. No balance, aggregate, current rate or day is proof. */
sealed class EconomySpec(val action: EconomyAction, override val kind: String, val path: String,
    private val field: String, private val currency: String) : MoneyOpSpec<EconomyAcceptance> {
    /** The receipt answers `unknown` only for this exact key (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    fun intent(wallet: String, baseId: String?, key: String, amount: String): PendingIntent {
        val base = baseId?.let(::uuid); positive(amount)
        return PendingIntent(kind, wallet, base, key, path, buildJsonObject {
            put("idempotencyKey", key); put(field, amount); base?.let { put("baseId", it) }
        }, action.title)
    }
    override fun receiptRequest(intent: PendingIntent) = ReceiptRequest("$path/receipt", intent.body.mapValues { it.value.jsonPrimitive.content })
    override fun acknowledge(intent: PendingIntent, response: JsonObject): EconomyAcceptance =
        (decodeReceipt(intent, response) as? Receipt.Accepted)?.value ?: throw ApiCompatibilityException("$path/receipt")
    override fun acknowledgementDocument(response: JsonObject) = ReceiptDocument.fromReceiptRoute(response)
    override fun restore(intent: PendingIntent, document: JsonObject): EconomyAcceptance {
        require(ReceiptDocument.source(document) == ReceiptDocument.SOURCE_RECEIPT)
        return acknowledge(intent, ReceiptDocument.payload(document))
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<EconomyAcceptance> = try {
        require(intent.kind == kind && intent.path == path)
        require(intent.body == this.intent(intent.wallet, intent.baseId, intent.idempotencyKey, intent.body.text(field)).body)
        if (response["version"] != JsonPrimitive(1)) Receipt.Unsupported
        else when (response.text("status")) {
            "unknown" -> { require(response.text("idempotencyKey") == intent.idempotencyKey); Receipt.Unknown }
            "accepted" -> {
                require(response.text("wallet") == intent.wallet && response["request"] == intent.body)
                require(response["baseId"] == (intent.baseId?.let(::JsonPrimitive) ?: JsonNull))
                uuid(response.text("receiptId")); Instant.parse(response.text("acceptedAt"))
                val funding = response["funding"]!!.jsonObject
                require(funding.text("currency") == currency && funding.text("amount") == intent.body.text(field))
                val result = response["result"]!!.jsonObject; val amount = intent.body.text(field)
                val acceptance = if (action == EconomyAction.CONVERT) {
                    require(result.text("converted") == amount)
                    val shards = positive(result.text("shards")); val rate = economyRate(result["rate"])
                    require(rate > 0 && amount.toBigInteger() * rate.toBigInteger() == shards.toBigInteger())
                    EconomyAcceptance(action, intent.baseId, amount, outputShards = shards, rate = rate)
                } else {
                    require(result.text("contributedShards") == amount)
                    val day = result.text("day"); require(day.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}"))); LocalDate.parse(day)
                    EconomyAcceptance(action, intent.baseId, amount, day = day)
                }
                Receipt.Accepted(acceptance, ReceiptDocument.fromReceiptRoute(response))
            }
            else -> Receipt.Unsupported
        }
    } catch (_: Exception) { throw ApiCompatibilityException("$path/receipt") }
}
object KeepConversionSpec : EconomySpec(EconomyAction.CONVERT, IntentKind.KEEP_CONVERSION, "/forge/convert", "keep", "KEEP")
object ForgeContributionSpec : EconomySpec(EconomyAction.CONTRIBUTE, IntentKind.FORGE_CONTRIBUTION, "/forge/contribute", "shards", "SHARDS")
