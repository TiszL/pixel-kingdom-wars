package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*

/** This v1 key is client consent; returned ledger IDs are separate immutable server evidence. */
class ForgeClaimSpec(private val cluster: String) : MoneyOpSpec<ForgeClaimReceipt> {
    override val kind = IntentKind.FORGE_CLAIM
    /** The by-key status answers `receipt: null` only for this wallet's exact key (dead-end audit 2026-10-06). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    val path = "/forge/claims/v1"
    init { require(cluster in setOf("devnet", "mainnet-beta")) }
    fun intent(wallet: String, key: String, base: String?, day: String?, batchMax: Int): PendingIntent {
        ClanCommandContract.wallet(wallet); ClanCommandContract.id(key); base?.let(ClanCommandContract::id); day?.let(ForgeClaimContract::day)
        require(batchMax > 0)
        return PendingIntent(kind, wallet, base, key, path, buildJsonObject {
            put("idempotencyKey", key); put("baseId", base?.let(::JsonPrimitive) ?: JsonNull); put("day", day?.let(::JsonPrimitive) ?: JsonNull)
        }, "Claim Forge KEEP", buildJsonObject { put("cluster", cluster); put("claimBatchMax", batchMax) })
    }
    fun validate(intent: PendingIntent): Int {
        val quote = requireNotNull(intent.quote); val max = requireNotNull(quote["claimBatchMax"] as? JsonPrimitive)
        require(!max.isString); val batch = requireNotNull(max.intOrNull)
        val expected = this.intent(intent.wallet, intent.idempotencyKey, intent.baseId, ForgeClaimContract.optional(intent.body, "day"), batch)
        require(intent.kind == kind && intent.path == path && intent.body == expected.body && quote == expected.quote)
        return batch
    }
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest { validate(intent); return ReceiptRequest("$path/${intent.idempotencyKey}", emptyMap()) }
    private fun match(intent: PendingIntent, raw: JsonObject): ForgeClaimReceipt = ForgeClaimReceipt.from(raw, validate(intent)).also {
        require(it.actor == intent.wallet && it.idempotencyKey == intent.idempotencyKey && it.baseId == intent.baseId && it.day == ForgeClaimContract.optional(intent.body, "day"))
    }
    override fun acknowledge(intent: PendingIntent, response: JsonObject) = match(intent, response)
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<ForgeClaimReceipt> = try {
        val status = ForgeClaimStatus.from(response, validate(intent))
        require(status.wallet == intent.wallet && status.idempotencyKey == intent.idempotencyKey)
        if (status.receipt == null) Receipt.Unknown else Receipt.Accepted(match(intent, response["receipt"]!!.jsonObject), ReceiptDocument.fromReceiptRoute(response))
    } catch (_: Exception) { throw ApiCompatibilityException("$path/${intent.idempotencyKey}") }
    override fun restore(intent: PendingIntent, document: JsonObject): ForgeClaimReceipt = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        ReceiptDocument.SOURCE_RECEIPT -> requireNotNull((decodeReceipt(intent, ReceiptDocument.payload(document)) as? Receipt.Accepted)?.value)
        else -> error("Unrecognized Forge claim proof")
    }
}
