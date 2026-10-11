package gg.pixelkingdomwars.nativeclient.ops

import gg.pixelkingdomwars.nativeclient.model.*
import gg.pixelkingdomwars.nativeclient.network.ApiCompatibilityException
import kotlinx.serialization.json.*

class WallBatchSpec(private val cluster: String) : MoneyOpSpec<WallBatchReceipt> {
    override val kind = IntentKind.WALL_BATCH
    val path = "/base/walls/batch/v1"
    init { require(cluster in setOf("devnet", "mainnet-beta")) }
    fun intent(wallet: String, request: WallBatchRequest, terms: WallBatchTerms): PendingIntent {
        ClanCommandContract.wallet(wallet); request.validate(terms); require(request.maxCostShards == terms.cost(request.tiles.size))
        return PendingIntent(kind, wallet, request.baseId, request.idempotencyKey, path, request.body, "Place ${request.tiles.size} walls", buildJsonObject {
            put("cluster", cluster); put("unitCostShards", terms.unitCostShards); put("plotTiles", terms.plotTiles); put("maxTiles", terms.maxTiles); terms.plotGeometry?.let { put("plotGeometry", it.json) }
        })
    }
    fun terms(intent: PendingIntent): WallBatchTerms {
        val c = HeroRecruitmentContract; val q = requireNotNull(intent.quote)
        val terms = WallBatchTerms(c.text(q, "unitCostShards"), c.integer(q, "plotTiles"), c.integer(q, "maxTiles"), q["plotGeometry"]?.let { PlotGeometry.saved(it.jsonObject) })
        val request = WallBatchRequest.from(intent.body, terms); val expected = this.intent(intent.wallet, request, terms)
        require(intent.kind == kind && intent.path == path && intent.idempotencyKey == request.idempotencyKey
            && intent.baseId == request.baseId && intent.quote == expected.quote && intent.label == expected.label)
        return terms
    }
    override fun receiptRequest(intent: PendingIntent): ReceiptRequest { terms(intent); return ReceiptRequest("$path/${intent.idempotencyKey}", emptyMap()) }
    /** The key-scoped v1 receipt answers `receipt: null` only for this wallet's exact key (no closure route exists): the
     * wall batch card's CLOSE may then forget it on this device (owner 2026-10-06, the same rule as construction). */
    override val savedRequestExit = SavedRequestExit.FORGET_AFTER_SERVER_ABSENT
    override fun acknowledge(intent: PendingIntent, response: JsonObject) = WallBatchReceipt.from(response, terms(intent)).also {
        require(it.actor == intent.wallet && it.request.body == intent.body)
    }
    override fun decodeReceipt(intent: PendingIntent, response: JsonObject): Receipt<WallBatchReceipt> = try {
        terms(intent); val c = HeroRecruitmentContract; c.keys(response, "version", "wallet", "idempotencyKey", "enabled", "receipt")
        require(response["version"] == JsonPrimitive(1) && c.text(response, "wallet") == intent.wallet && c.text(response, "idempotencyKey") == intent.idempotencyKey)
        c.flag(response, "enabled")
        // Server 2026-10-06 (night/server): a locked read under the player row, so `receipt: null` proves no row holds this
        // key; it carries no absentAsOf, so MoneyOp applies the client minimum age before it can close anything.
        if (response["receipt"] == JsonNull) Receipt.Absent else Receipt.Accepted(acknowledge(intent, requireNotNull(response["receipt"] as? JsonObject)), ReceiptDocument.fromReceiptRoute(response))
    } catch (_: Exception) { throw ApiCompatibilityException("$path/${intent.idempotencyKey}") }
    override fun restore(intent: PendingIntent, document: JsonObject) = when (ReceiptDocument.source(document)) {
        ReceiptDocument.SOURCE_POST -> acknowledge(intent, ReceiptDocument.payload(document))
        ReceiptDocument.SOURCE_RECEIPT -> requireNotNull((decodeReceipt(intent, ReceiptDocument.payload(document)) as? Receipt.Accepted)?.value)
        else -> error("Unrecognized wall batch proof")
    }
}
