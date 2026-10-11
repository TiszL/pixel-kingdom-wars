package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

private fun JsonObject.text(key: String) = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun amount(value: String) = value.also { require(it.length <= 32 && it.matches(Regex("0|[1-9][0-9]*"))) }
private fun address(value: String) = value.also { require(it.length in 32..44 && it.matches(Regex("[1-9A-HJ-NP-Za-km-z]+"))) }

/** Public signed intent only. Challenge tokens, signatures, grants and TOTP never belong here. */
data class WithdrawalQuote(val intent: JsonObject) {
    val gross get() = intent.text("grossAmount")
    val fee get() = intent.text("feeBurned")
    val net get() = intent.text("netAmount")
    val destination get() = intent.text("destination")
    val cluster get() = intent.text("cluster")
    val mint get() = intent.text("keepMint")
    val key get() = intent.text("idempotencyKey")
    val instant get() = intent.text("mode") == "instant"
    val hours get() = intent["unbondingHours"]!!.jsonPrimitive.long
    init {
        require(intent.keys == setOf("version", "grossAmount", "feeBurned", "netAmount", "destination", "cluster", "keepMint", "idempotencyKey", "mode", "unbondingHours"))
        require(intent["version"] == JsonPrimitive(1)); amount(gross); amount(fee); amount(net)
        require(gross.toBigInteger().signum() > 0 && gross.toBigInteger() - fee.toBigInteger() == net.toBigInteger())
        address(destination); address(mint); require(cluster in setOf("devnet", "mainnet-beta"))
        require(key.matches(Regex("[A-Za-z0-9._:-]{8,128}"))); require(intent.text("mode") in setOf("standard", "instant"))
        require(!intent["unbondingHours"]!!.jsonPrimitive.isString && hours >= 0 && hours <= ((1L shl 53) - 1))
        require(if (instant) hours == 0L else hours > 0L)
    }
    fun body() = buildJsonObject { put("amount", gross); put("destination", destination); put("idempotencyKey", key); put("instant", instant) }
    /** Hold hours are signed consent but are not independently recoverable from the stored receipt. */
    fun receiptQuery() = JsonObject(intent - "version" - "unbondingHours")
}
data class WithdrawalAcceptance(val withdrawalId: String, val unbondsAt: String, val quote: WithdrawalQuote)

object WithdrawalSpec : MoneyOpSpec<WithdrawalAcceptance> {
    override val kind = IntentKind.WITHDRAWAL
    /** The receipt answers `unknown` only for this exact key: no withdrawal row carries it (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    const val PATH = "/withdrawals"
    fun intent(wallet: String, baseId: String?, quote: WithdrawalQuote) = PendingIntent(kind, wallet, baseId, quote.key,
        PATH, quote.body(), "Withdraw ${quote.gross} KEEP", quote.intent)
    private fun quote(intent: PendingIntent) = WithdrawalQuote(requireNotNull(intent.quote)).also {
        require(intent.kind == kind && intent.path == PATH && intent.idempotencyKey == it.key && intent.body == it.body())
    }
    override fun receiptRequest(intent: PendingIntent) = ReceiptRequest("$PATH/receipt", quote(intent).receiptQuery().mapValues { it.value.jsonPrimitive.content })
    override fun acknowledge(intent: PendingIntent, response: JsonObject) = (decodeReceipt(intent, response) as? Receipt.Accepted)?.value
        ?: throw ApiCompatibilityException("$PATH/receipt")
    override fun acknowledgementDocument(response: JsonObject) = ReceiptDocument.fromReceiptRoute(response)
    override fun restore(intent: PendingIntent, document: JsonObject): WithdrawalAcceptance {
        require(ReceiptDocument.source(document) == ReceiptDocument.SOURCE_RECEIPT)
        return acknowledge(intent, ReceiptDocument.payload(document))
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<WithdrawalAcceptance> = try {
        val quote = quote(intent)
        if (response["version"] != JsonPrimitive(1)) Receipt.Unsupported
        else when (response.text("status")) {
            "unknown" -> { require(response.text("idempotencyKey") == quote.key); Receipt.Unknown }
            "accepted" -> {
                require(response.text("wallet") == intent.wallet && response["request"] == quote.receiptQuery())
                val id = response.text("receiptId"); require(UUID.fromString(id).toString() == id.lowercase())
                Instant.parse(response.text("acceptedAt"))
                val funding = response["funding"]!!.jsonObject
                require(funding.text("currency") == "KEEP" && funding.text("amount") == quote.gross)
                val result = response["result"]!!.jsonObject; val withdrawalId = result.text("withdrawalId")
                require(UUID.fromString(withdrawalId).toString() == withdrawalId.lowercase())
                val unbondsAt = result.text("unbondsAt"); Instant.parse(unbondsAt)
                Receipt.Accepted(WithdrawalAcceptance(withdrawalId, unbondsAt, quote), ReceiptDocument.fromReceiptRoute(response))
            }
            else -> Receipt.Unsupported
        }
    } catch (_: Exception) { throw ApiCompatibilityException("$PATH/receipt") }
}
