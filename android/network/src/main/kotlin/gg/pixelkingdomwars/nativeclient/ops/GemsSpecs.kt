package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import gg.pixelkingdomwars.nativeclient.network.ApiException
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import java.io.IOException
import java.time.Instant
import java.util.UUID

private fun JsonObject.text(name: String) = requireNotNull((get(name) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun positive(value: String) = value.also { require(it.length <= 32 && it.matches(Regex("[1-9][0-9]*"))) }
private fun uuid(value: String) = value.also { require(UUID.fromString(it).toString().equals(it, ignoreCase = true)) }.lowercase()
private fun task(value: String) = value.also { require(it.matches(Regex("[a-z0-9_-]{1,64}"))) }
private fun keySegment(key: String) = java.net.URLEncoder.encode(key, Charsets.UTF_8.name()).replace("+", "%20")

/** Optional only for reading old journals. New repository submissions carry
 * the exact terms in their body so the server can enforce them with the debit. */
private fun expectedTerms(intent: PendingIntent): JsonObject? {
    if (!intent.body.containsKey("expected")) return null
    val expected = requireNotNull(intent.body["expected"] as? JsonObject)
    require(expected.keys == setOf("rate", "output"))
    val output = positive(expected.text("output"))
    if (intent.kind == IntentKind.GEMS_TASK_CLAIM) require(expected["rate"] == JsonNull)
    else {
        val rate = economyRate(expected["rate"])
        val input = intent.body.text(if (intent.kind == IntentKind.GEMS_FROM_KEEP) "keep" else "gems")
        require(input.toBigInteger() * rate.toBigInteger() == output.toBigInteger())
    }
    return expected
}
private fun validateBody(intent: PendingIntent, legacy: JsonObject) {
    expectedTerms(intent)
    require(JsonObject(intent.body - "expected") == legacy)
}
private fun validateOutput(intent: PendingIntent, output: String, rate: Long?) {
    val expected = expectedTerms(intent) ?: return
    require(expected["output"] == JsonPrimitive(output) && expected["rate"] == (rate?.let(::JsonPrimitive) ?: JsonNull))
}

data class GemsAcceptance(val kind: String, val receiptId: String, val amount: String, val currency: String,
    val baseId: String? = null, val taskId: String? = null, val funding: Funding? = null, val rate: Long? = null)

/** Receipts bind the saved wallet/key/body/base. No balance delta or task claimed flag is proof.
 * POST acknowledgements deliberately require the exact GET receipt, matching EconomySpec. */
sealed class GemsSpec(override val kind: String) : MoneyOpSpec<GemsAcceptance> {
    /** The key-scoped receipt answers `unknown` only for this wallet's exact key (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    protected abstract fun request(path: String, body: JsonObject): ReceiptRequest
    protected abstract fun validate(intent: PendingIntent)
    protected abstract fun accepted(intent: PendingIntent, receipt: JsonObject, id: String): GemsAcceptance
    override fun validateSend(intent: PendingIntent) = validate(intent)
    override fun observedInitialRejection(intent: PendingIntent, error: ApiException): Boolean = when (kind) {
        IntentKind.GEMS_FROM_KEEP -> error.status == 422 && error.code in setOf("GEMS_PURCHASE_BELOW_MINIMUM", "GEMS_PURCHASE_ABOVE_MAXIMUM", "INSUFFICIENT_KEEP") || error.status == 409 && error.code == "GEMS_TERMS_CHANGED"
        IntentKind.GEMS_TO_SHARDS -> error.status == 422 && error.code == "INSUFFICIENT_GEMS" || error.status == 404 && error.code == "BASE_NOT_OWNED" || error.status == 409 && error.code == "GEMS_TERMS_CHANGED"
        IntentKind.GEMS_TASK_CLAIM -> error.status == 404 && error.code == "TASK_UNKNOWN" || error.status == 409 && error.code in setOf("CLAIM_ALREADY_SETTLED", "GEMS_TERMS_CHANGED")
        else -> false
    }
    override fun definitiveInitialRejection(intent: PendingIntent, error: ApiException) = observedInitialRejection(intent, error)

    override fun receiptRequest(intent: PendingIntent): ReceiptRequest { validate(intent); return request(intent.path, intent.body) }
    override fun acknowledge(intent: PendingIntent, response: JsonObject): GemsAcceptance =
        (decodeReceipt(intent, response) as? Receipt.Accepted)?.value ?: throw ApiCompatibilityException(intent.path)
    override fun acknowledgementDocument(response: JsonObject) = ReceiptDocument.fromReceiptRoute(response)
    override fun restore(intent: PendingIntent, document: JsonObject): GemsAcceptance {
        require(ReceiptDocument.source(document) == ReceiptDocument.SOURCE_RECEIPT)
        return acknowledge(intent, ReceiptDocument.payload(document))
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<GemsAcceptance> = try {
        validate(intent)
        val receipt = if (kind == IntentKind.GEMS_TO_SHARDS) response else {
            require(response.text("wallet") == intent.wallet && response.text("idempotencyKey") == intent.idempotencyKey)
            Instant.parse(response.text("serverNow"))
            when (response.text("status")) {
                "unknown" -> { require(response["receipt"] == JsonNull); null }
                "accepted" -> requireNotNull(response["receipt"] as? JsonObject).also { require(it.text("status") == "accepted") }
                else -> throw IllegalArgumentException("Unsupported receipt envelope")
            }
        }
        when {
            receipt == null -> Receipt.Unknown
            receipt["version"] != JsonPrimitive(1) -> Receipt.Unsupported
            receipt.text("status") == "unknown" -> { require(receipt.text("idempotencyKey") == intent.idempotencyKey); Receipt.Unknown }
            receipt.text("status") == "accepted" -> {
                require(receipt.text("wallet") == intent.wallet)
                val id = uuid(receipt.text("receiptId")); Instant.parse(receipt.text("acceptedAt"))
                Receipt.Accepted(accepted(intent, receipt, id), ReceiptDocument.fromReceiptRoute(response))
            }
            else -> Receipt.Unsupported
        }
    } catch (_: Exception) { throw ApiCompatibilityException(intent.path) }

    /** No exception after a successful POST may masquerade as a definitive first-attempt refusal.
     * The wrapped MoneyOp preserves its attempted intent, including on a receipt GET 401/404. */
    fun verifiedTransport(transport: OpTransport): OpTransport = object : OpTransport {
        override suspend fun get(path: String, query: Map<String, String>) = transport.get(path, query)
        override suspend fun postObserved(intent: PendingIntent, refusal: (ApiException) -> Unit): JsonObject {
            val receipt = receiptRequest(intent)
            transport.postObserved(intent, refusal)
            return readAfterPost(receipt)
        }
        override suspend fun post(path: String, body: JsonObject): JsonObject {
            val receipt = request(path, body)
            transport.post(path, body)
            return readAfterPost(receipt)
        }
        private suspend fun readAfterPost(receipt: ReceiptRequest): JsonObject = try {
                transport.get(receipt.path, receipt.query).also {
                    if (it["status"] != JsonPrimitive("accepted")) throw IOException("Acceptance is not yet confirmed")
                }
            } catch (error: CancellationException) { throw error }
            catch (error: Exception) { throw IOException("Request sent. Check its saved status to confirm the result.", error) }
    }
}

object GemsFromKeepSpec : GemsSpec(IntentKind.GEMS_FROM_KEEP) {
    const val PATH = "/gems/from-keep"
    fun intent(wallet: String, key: String, keep: String) = PendingIntent(kind, wallet, null, key, PATH,
        buildJsonObject { put("keep", positive(keep)); put("idempotencyKey", key) }, "Get Gems")
    override fun validate(intent: PendingIntent) {
        require(intent.kind == kind && intent.path == PATH && intent.baseId == null)
        validateBody(intent, this.intent(intent.wallet, intent.idempotencyKey, intent.body.text("keep")).body)
    }
    override fun request(path: String, body: JsonObject): ReceiptRequest {
        require(path == PATH); return ReceiptRequest("$PATH/by-key/${keySegment(body.text("idempotencyKey"))}", emptyMap())
    }
    override fun accepted(intent: PendingIntent, receipt: JsonObject, id: String): GemsAcceptance {
        require(receipt["request"] == intent.body)
        val funding = requireNotNull(receipt["funding"] as? JsonObject)
        require(funding.text("currency") == "KEEP" && funding.text("amount") == intent.body.text("keep"))
        val result = requireNotNull(receipt["result"] as? JsonObject)
        val gems = positive(result.text("gems")); val rate = economyRate(result["rate"])
        require(intent.body.text("keep").toBigInteger() * rate.toBigInteger() == gems.toBigInteger())
        validateOutput(intent, gems, rate)
        return GemsAcceptance(kind, id, gems, "GEMS", funding = Funding("KEEP", funding.text("amount")), rate = rate)
    }
}
object GemsToShardsSpec : GemsSpec(IntentKind.GEMS_TO_SHARDS) {
    const val PATH = "/gems/to-shards"
    fun intent(wallet: String, baseId: String?, key: String, gems: String): PendingIntent {
        val base = baseId?.let(::uuid)
        return PendingIntent(kind, wallet, base, key, PATH, buildJsonObject {
            put("gems", positive(gems)); put("idempotencyKey", key); base?.let { put("baseId", it) }
        }, "Convert Gems to SHARDS")
    }
    override fun validate(intent: PendingIntent) {
        require(intent.kind == kind && intent.path == PATH)
        validateBody(intent, this.intent(intent.wallet, intent.baseId, intent.idempotencyKey, intent.body.text("gems")).body)
    }
    override fun request(path: String, body: JsonObject): ReceiptRequest {
        require(path == PATH); return ReceiptRequest("$PATH/receipt", body.filterKeys { it != "expected" }.mapValues { it.value.jsonPrimitive.content })
    }
    override fun accepted(intent: PendingIntent, receipt: JsonObject, id: String): GemsAcceptance {
        require(receipt["request"] == intent.body && receipt["baseId"] == (intent.baseId?.let(::JsonPrimitive) ?: JsonNull))
        val funding = requireNotNull(receipt["funding"] as? JsonObject)
        require(funding.text("currency") == "GEMS" && funding.text("amount") == intent.body.text("gems"))
        val result = requireNotNull(receipt["result"] as? JsonObject)
        val shards = positive(result.text("shards")); val rate = economyRate(result["rate"])
        require(intent.body.text("gems").toBigInteger() * rate.toBigInteger() == shards.toBigInteger())
        validateOutput(intent, shards, rate)
        return GemsAcceptance(kind, id, shards, "SHARDS", intent.baseId, funding = Funding("GEMS", funding.text("amount")), rate = rate)
    }
}
object GemsTaskClaimSpec : GemsSpec(IntentKind.GEMS_TASK_CLAIM) {
    fun intent(wallet: String, taskId: String, key: String) = PendingIntent(kind, wallet, null, key,
        "/gems/tasks/${task(taskId)}/claim", buildJsonObject { put("idempotencyKey", key) }, "Claim Gems task",
        buildJsonObject { put("taskId", taskId) })
    override fun validate(intent: PendingIntent) {
        require(intent.kind == kind && intent.baseId == null)
        val original = this.intent(intent.wallet, requireNotNull(intent.quote).text("taskId"), intent.idempotencyKey)
        require(original.path == intent.path); validateBody(intent, original.body)
    }
    override fun request(path: String, body: JsonObject): ReceiptRequest {
        require(path.matches(Regex("/gems/tasks/[a-z0-9_-]{1,64}/claim")))
        return ReceiptRequest("$path/by-key/${keySegment(body.text("idempotencyKey"))}", emptyMap())
    }
    override fun accepted(intent: PendingIntent, receipt: JsonObject, id: String): GemsAcceptance {
        val taskId = requireNotNull(intent.quote).text("taskId")
        require(receipt.text("taskId") == taskId)
        require(receipt["request"] == JsonObject(intent.body + ("taskId" to JsonPrimitive(taskId))))
        val gems = positive(requireNotNull(receipt["result"] as? JsonObject).text("gems"))
        validateOutput(intent, gems, null)
        return GemsAcceptance(kind, id, gems, "GEMS", taskId = taskId)
    }
}
