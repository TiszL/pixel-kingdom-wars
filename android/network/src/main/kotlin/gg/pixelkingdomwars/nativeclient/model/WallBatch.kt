package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*

/** The deployed shared constants bound one all-or-nothing instant wall purchase. */
data class WallBatchTerms(val unitCostShards: String, val plotTiles: Int, val maxTiles: Int, val plotGeometry: PlotGeometry? = null) {
    init {
        ForgeClaimContract.amount(unitCostShards); require(unitCostShards != "0" && plotTiles > 0 && maxTiles > 0)
        Math.multiplyExact(unitCostShards.toLong(), maxTiles.toLong())
        plotGeometry?.let { require(it == PlotGeometry.supported(it.version) && it.version == 2 && plotTiles == it.size) }
    }
    fun cost(count: Int): String { require(count > 0); return Math.multiplyExact(unitCostShards.toLong(), count.toLong()).toString() }
    companion object {
        fun from(catalogue: JsonObject, plotVersion: Int? = null): WallBatchTerms {
            val plot = PlotGeometry.from(catalogue, plotVersion)
            val c = requireNotNull(catalogue["constants"] as? JsonObject)
            val wall = requireNotNull((c["BUILD_COSTS"] as? JsonObject)?.get("wall") as? JsonObject)
            val cost = requireNotNull(wall["costShards"] as? JsonPrimitive).also { require(!it.isString && it.longOrNull != null) }.content
            val caps = requireNotNull((c["BUILD_COUNT_CAP_BY_KEEP"] as? JsonObject)?.get("wall") as? JsonArray).map {
                requireNotNull(it as? JsonPrimitive).let { value -> require(!value.isString); requireNotNull(value.intOrNull).also { cap -> require(cap > 0) } }
            }
            require(caps.isNotEmpty() && caps.last() == caps.max())
            return WallBatchTerms(cost, plot.size, caps.last(), plot.takeIf { it.version != 1 })
        }
    }
}

data class WallBatchTile(val tx: Int, val ty: Int) {
    val json get() = buildJsonObject { put("tx", tx); put("ty", ty) }
}
data class WallBatchRequest(val idempotencyKey: String, val baseId: String?, val tiles: List<WallBatchTile>, val maxCostShards: String) {
    val body get() = buildJsonObject {
        put("idempotencyKey", idempotencyKey); put("baseId", baseId?.let(::JsonPrimitive) ?: JsonNull)
        put("tiles", JsonArray(tiles.map { it.json })); put("maxCostShards", maxCostShards)
    }
    fun validate(terms: WallBatchTerms) {
        ClanCommandContract.id(idempotencyKey); baseId?.let(ClanCommandContract::id)
        require(tiles.size in 1..terms.maxTiles && tiles.distinct().size == tiles.size)
        require(tiles.all { terms.plotGeometry?.contains(it.tx, it.ty) ?: (it.tx in 0 until terms.plotTiles && it.ty in 0 until terms.plotTiles) })
        ForgeClaimContract.amount(maxCostShards); require(maxCostShards != "0")
    }
    companion object {
        fun from(raw: JsonObject, terms: WallBatchTerms): WallBatchRequest {
            val c = HeroRecruitmentContract; c.keys(raw, "idempotencyKey", "baseId", "tiles", "maxCostShards")
            return WallBatchRequest(c.text(raw, "idempotencyKey"), c.optional(raw, "baseId"), requireNotNull(raw["tiles"] as? JsonArray).map {
                val tile = requireNotNull(it as? JsonObject); c.keys(tile, "tx", "ty")
                WallBatchTile(c.integer(tile, "tx"), c.integer(tile, "ty"))
            }, c.text(raw, "maxCostShards")).also { it.validate(terms) }
        }
    }
}

/** The immutable ledger transaction proves the exact original tiles were inserted atomically.
 * Today's moved/sold/demolished wall rows are deliberately absent from this proof. */
data class WallBatchReceipt(val actor: String, val request: WallBatchRequest, val receiptId: String,
    val acceptedAt: String, val amount: String, val raw: JsonObject) {
    companion object {
        fun from(raw: JsonObject, terms: WallBatchTerms): WallBatchReceipt {
            val c = HeroRecruitmentContract
            c.keys(raw, "version", "actor", "idempotencyKey", "request", "receiptId", "acceptedAt", "funding")
            require(raw["version"] == JsonPrimitive(1)); val actor = c.text(raw, "actor").also(ClanCommandContract::wallet)
            val request = WallBatchRequest.from(requireNotNull(raw["request"] as? JsonObject), terms)
            require(c.text(raw, "idempotencyKey") == request.idempotencyKey)
            val id = c.text(raw, "receiptId").also(ClanCommandContract::id)
            val accepted = c.time(raw, "acceptedAt")
            require(java.time.format.DateTimeFormatterBuilder().appendInstant(3).toFormatter().format(accepted) == c.text(raw, "acceptedAt"))
            val funding = requireNotNull(raw["funding"] as? JsonObject); c.keys(funding, "currency", "amount")
            require(c.text(funding, "currency") == "SHARDS")
            val amount = c.text(funding, "amount").also(ForgeClaimContract::amount)
            require(amount != "0" && amount.toLong() <= request.maxCostShards.toLong())
            return WallBatchReceipt(actor, request, id, c.text(raw, "acceptedAt"), amount, raw)
        }
    }
}
