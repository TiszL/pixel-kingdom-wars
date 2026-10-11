package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

private fun JsonObject.unwindText(key: String): String = requireNotNull((get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun unwindAmount(text: String): String = text.also { require(it.matches(Regex("0|[1-9][0-9]{0,18}")) && it.toLong() >= 0) }
private fun unwindId(text: String): String = text.also { require(UUID.fromString(it).toString() == it) }
private fun JsonObject.unwindNullable(key: String): String? = if (get(key) == JsonNull) null else unwindText(key)

enum class WithdrawalUnwindAction(val title: String, val terminal: String) {
    CANCEL("Cancel withdrawal", "cancelled"), REFUND("Refund withdrawal", "refunded");
    val route get() = name.lowercase()
}

/** Only original immutable withdrawal facts are consent. Mint/status/signature
 * may change as the server's payout worker resolves the same row. */
data class WithdrawalUnwindTarget(val document: JsonObject) {
    val id get() = document.unwindText("id")
    val gross get() = document.unwindText("amount")
    val destination get() = document.unwindText("destination")
    init {
        require(document.keys == setOf("id", "amount", "feeBurned", "netAmount", "destination", "createdAt", "unbondsAt"))
        unwindId(id); val gross = unwindAmount(gross).toLong(); require(gross > 0)
        val fee = unwindAmount(document.unwindText("feeBurned")).toLong()
        val net = unwindAmount(document.unwindText("netAmount")).toLong(); require(gross - fee == net)
        require(destination.length in 32..44 && destination.matches(Regex("[1-9A-HJ-NP-Za-km-z]+")))
        Instant.parse(document.unwindText("createdAt")); document.unwindNullable("unbondsAt")?.let(Instant::parse)
    }
    companion object {
        fun from(row: JsonObject) = WithdrawalUnwindTarget(JsonObject(row.filterKeys {
            it in setOf("id", "amount", "feeBurned", "netAmount", "destination", "createdAt", "unbondsAt")
        }))
    }
}
data class WithdrawalUnwindOutcome(val action: WithdrawalUnwindAction, val target: WithdrawalUnwindTarget,
    val baseId: String?, val status: String, val completedAt: String, val signature: String?) {
    val returnedToWallet get() = status == "cancelled" || status == "refunded"
}

/** Existing server cancel/refund transactions atomically couple their terminal
 * row state with escrow compensation. Missing rows, balances or a mutable failed
 * flag never prove a refund. POST only addresses the original immutable row. */
object WithdrawalUnwindSpec : MoneyOpSpec<WithdrawalUnwindOutcome> {
    override val kind = IntentKind.WITHDRAWAL_UNWIND
    /** Unknown means the target withdrawal is still not cancelled/refunded/sent: the unwind left no effect. Closing it only
     * lets the player ask again; the server refuses an unwind of an already settled row (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    fun intent(wallet: String, baseId: String?, action: WithdrawalUnwindAction, target: WithdrawalUnwindTarget) =
        PendingIntent(kind, wallet, baseId, "${target.id}:${action.route}", "/withdrawals/${target.id}/${action.route}",
            buildJsonObject {}, "${action.title} · ${target.gross} KEEP", buildJsonObject {
                put("action", action.route); put("target", target.document)
            })
    fun consent(intent: PendingIntent): Pair<WithdrawalUnwindAction, WithdrawalUnwindTarget> {
        val quote = requireNotNull(intent.quote); require(quote.keys == setOf("action", "target"))
        val action = WithdrawalUnwindAction.entries.single { it.route == quote.unwindText("action") }
        val target = WithdrawalUnwindTarget(requireNotNull(quote["target"] as? JsonObject))
        require(intent.kind == kind && intent.idempotencyKey == "${target.id}:${action.route}"
            && intent.path == "/withdrawals/${target.id}/${action.route}" && intent.body.isEmpty())
        intent.baseId?.let(::unwindId); return action to target
    }
    fun supported(raw: JsonObject): Boolean = ((raw["features"] as? JsonObject)?.get("withdrawalReceipts") as? JsonObject)?.get("version") == JsonPrimitive(1)
    fun row(raw: JsonObject, id: String): JsonObject? {
        unwindId(id); val rows = requireNotNull(raw["withdrawals"] as? JsonArray).map { it.jsonObject }
        val ids = rows.map { unwindId(it.unwindText("id")) }; require(ids.distinct().size == ids.size)
        return rows.singleOrNull { it.unwindText("id") == id }
    }
    fun eligible(row: JsonObject, action: WithdrawalUnwindAction): Boolean = when (action) {
        WithdrawalUnwindAction.CANCEL -> row.unwindText("status") == "unbonding"
        WithdrawalUnwindAction.REFUND -> row.unwindText("status") == "failed" && row["refundable"] == JsonPrimitive(true)
    }
    fun validateAcknowledgement(intent: PendingIntent, raw: JsonObject) {
        val (action, target) = consent(intent)
        require(raw.unwindText("id") == target.id && raw.unwindText("status") == action.terminal)
        if (action == WithdrawalUnwindAction.REFUND) require(raw.unwindText("amount") == target.gross)
    }
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest { consent(intent); return ReceiptRequest("/withdrawals", emptyMap()) }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<WithdrawalUnwindOutcome> = try {
        val (action, target) = consent(intent)
        if (!supported(response)) Receipt.Unsupported
        else {
            val row = row(response, target.id)
            if (row == null) Receipt.Unknown else {
                require(WithdrawalUnwindTarget.from(row) == target)
                val status = row.unwindText("status")
                if (status !in setOf("cancelled", "refunded", "sent")) Receipt.Unknown else {
                    val completed = row.unwindText("completedAt"); Instant.parse(completed)
                    val signature = row.unwindNullable("txSignature")
                    if (status == "sent") require(!signature.isNullOrBlank())
                    Receipt.Accepted(WithdrawalUnwindOutcome(action, target, intent.baseId, status, completed, signature), ReceiptDocument.fromReceiptRoute(response))
                }
            }
        }
    } catch (_: Exception) { throw ApiCompatibilityException("/withdrawals") }
    override fun acknowledge(intent: PendingIntent, response: JsonObject) = (decodeReceipt(intent, response) as? Receipt.Accepted)?.value
        ?: throw ApiCompatibilityException("/withdrawals")
    override fun acknowledgementDocument(response: JsonObject) = ReceiptDocument.fromReceiptRoute(response)
    override fun restore(intent: PendingIntent, document: JsonObject): WithdrawalUnwindOutcome {
        require(ReceiptDocument.source(document) == ReceiptDocument.SOURCE_RECEIPT)
        return acknowledge(intent, ReceiptDocument.payload(document))
    }
}
