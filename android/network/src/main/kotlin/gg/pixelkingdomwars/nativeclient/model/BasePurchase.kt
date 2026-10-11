package gg.pixelkingdomwars.nativeclient.model

import java.math.BigInteger
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.*

/** Exact additive shared/basePurchases v1 wire. Legacy deposit detail cannot recreate a quote. */
object BasePurchaseContract {
    fun keys(raw: JsonObject, vararg keys: String) { require(raw.keys == keys.toSet()) { "Incompatible paid-base document." } }
    fun text(raw: JsonObject, key: String) = MarketContract.text(raw, key)
    fun optional(raw: JsonObject, key: String) = MarketContract.optional(raw, key)
    fun integer(raw: JsonObject, key: String) = MarketContract.integer(raw, key)
    fun flag(raw: JsonObject, key: String) = MarketContract.flag(raw, key)
    fun id(value: String) = MarketContract.id(value)
    fun address(value: String) = MarketContract.address(value)
    fun signature(value: String) = MarketContract.signature(value)
    fun amount(value: String) = MarketContract.amount(value)
    fun lamports(value: String) = amount(value).also { require(BigInteger(it) <= BigInteger("9007199254740991")) }
    fun date(value: String) = value.also {
        require(DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC).format(Instant.parse(it)) == it)
    }
    fun obj(raw: JsonObject, key: String) = requireNotNull(raw[key] as? JsonObject)
}

data class BasePurchaseRequest(val raw: JsonObject, val key: String, val baseId: String, val kind: String,
    val expectedBuilders: Int? = null, val expectedExpansions: Int? = null, val buildingId: String? = null,
    val buildingType: String? = null, val fromLevel: Int? = null, val toLevel: Int? = null, val maxCostShards: String? = null) {
    companion object { fun from(raw: JsonObject): BasePurchaseRequest = with(BasePurchaseContract) {
        val key = id(text(raw, "idempotencyKey")); val base = id(text(raw, "baseId")); val kind = text(raw, "kind")
        when (kind) {
            "energy", "energy_pack", "shield", "warzone_shield" -> { keys(raw, "idempotencyKey", "baseId", "kind"); BasePurchaseRequest(raw, key, base, kind) }
            "builder" -> { keys(raw, "idempotencyKey", "baseId", "kind", "expectedBuilders")
                BasePurchaseRequest(raw, key, base, kind, expectedBuilders = integer(raw, "expectedBuilders").also { require(it >= 1) }) }
            "expansion" -> { keys(raw, "idempotencyKey", "baseId", "kind", "expectedExpansions")
                BasePurchaseRequest(raw, key, base, kind, expectedExpansions = integer(raw, "expectedExpansions").also { require(it >= 0) }) }
            "mine" -> { keys(raw, "idempotencyKey", "baseId", "kind", "buildingId", "buildingType", "fromLevel", "toLevel", "maxCostShards")
                val from = integer(raw, "fromLevel"); val to = integer(raw, "toLevel")
                require(from >= 1 && from < Int.MAX_VALUE && to == from + 1)
                BasePurchaseRequest(raw, key, base, kind, buildingId = id(text(raw, "buildingId")),
                    buildingType = text(raw, "buildingType").also { require(it in setOf("mine", "goldforge")) },
                    fromLevel = from, toLevel = to, maxCostShards = amount(text(raw, "maxCostShards"))) }
            else -> error("Unsupported paid base purchase.")
        }
    } }
}

data class BasePurchaseRail(val raw: JsonObject, val cluster: String, val coreProgram: String, val configPda: String,
    val treasuryLiquidity: String, val treasuryDev: String, val treasuryOps: String, val systemProgram: String,
    val mode: String, val destination: String?, val sinkKind: Int? = null,
    val directLamports: String? = null, val splitLamports: String? = null) {
    companion object { fun from(raw: JsonObject): BasePurchaseRail = with(BasePurchaseContract) {
        val mode = text(raw, "mode"); val destination = optional(raw, "destination")?.let(::address)
        val fields = arrayOf("cluster", "coreProgram", "configPda", "treasuryLiquidity", "treasuryDev", "treasuryOps", "systemProgram", "mode", "sinkKind", "destination")
        keys(raw, *if (mode == "warzone_split") fields + arrayOf("directLamports", "splitLamports") else fields)
        val sinkKind = if (raw["sinkKind"] == JsonNull) null else integer(raw, "sinkKind")
        require(when (mode) {
            "buy_sink" -> sinkKind in setOf(3, 4, 7, 8) && destination == null
            "sol_transfer" -> sinkKind == null && destination != null
            "warzone_split" -> sinkKind == 6 && destination != null
            else -> false
        })
        val direct = if (mode == "warzone_split") lamports(text(raw, "directLamports")).also { require(BigInteger(it).signum() > 0) } else null
        val split = if (mode == "warzone_split") lamports(text(raw, "splitLamports")).also { require(BigInteger(it).signum() > 0) } else null
        BasePurchaseRail(raw, text(raw, "cluster").also { require(it in setOf("devnet", "mainnet-beta")) },
            address(text(raw, "coreProgram")), address(text(raw, "configPda")), address(text(raw, "treasuryLiquidity")),
            address(text(raw, "treasuryDev")), address(text(raw, "treasuryOps")), text(raw, "systemProgram").also { require(it == "11111111111111111111111111111111") }, mode, destination, sinkKind, direct, split)
    } }
}

data class BasePurchaseQuote(val raw: JsonObject, val depositId: String, val wallet: String, val request: BasePurchaseRequest,
    val landPaidAt: String, val deedAssetId: String?, val reference: String, val amountLamports: String,
    val quotedCostShards: String?, val rail: BasePurchaseRail, val createdAt: String, val payableUntil: String, val retryAt: String, val energyQuantity: Int? = null) {
    companion object { fun from(raw: JsonObject): BasePurchaseQuote = with(BasePurchaseContract) {
        val request = BasePurchaseRequest.from(obj(raw, "request"))
        val energyKind = request.kind in setOf("energy", "energy_pack")
        val fields = arrayOf("version", "depositId", "wallet", "request", "baseEpoch", "reference", "amountLamports", "quotedCostShards", "rail", "createdAt", "payableUntil", "retryAt")
        keys(raw, *if (energyKind) fields + "energyQuantity" else fields)
        require(raw["version"] == JsonPrimitive(1)); val epoch = obj(raw, "baseEpoch"); keys(epoch, "landPaidAt", "deedAssetId")
        val q = BasePurchaseQuote(raw, id(text(raw, "depositId")), address(text(raw, "wallet")), request,
            date(text(epoch, "landPaidAt")), optional(epoch, "deedAssetId")?.let(::address), address(text(raw, "reference")), lamports(text(raw, "amountLamports")),
            optional(raw, "quotedCostShards")?.let(::amount), BasePurchaseRail.from(obj(raw, "rail")), date(text(raw, "createdAt")), date(text(raw, "payableUntil")), date(text(raw, "retryAt")),
            if (energyKind) integer(raw, "energyQuantity").also { require(it > 0) } else null)
        require(Instant.parse(q.createdAt) < Instant.parse(q.payableUntil) && Instant.parse(q.payableUntil) < Instant.parse(q.retryAt))
        require(when (q.request.kind) {
            "energy" -> q.rail.mode == "buy_sink" && q.rail.sinkKind == 3
            "energy_pack" -> q.rail.mode == "buy_sink" && q.rail.sinkKind == 7
            "builder" -> q.rail.mode == "buy_sink" && q.rail.sinkKind == 8
            "shield" -> q.rail.mode == "buy_sink" && q.rail.sinkKind == 4
            "warzone_shield" -> q.rail.mode == "warzone_split" && q.rail.destination == q.rail.treasuryLiquidity
                && BigInteger(requireNotNull(q.rail.directLamports)) + BigInteger(requireNotNull(q.rail.splitLamports)) == BigInteger(q.amountLamports)
            else -> q.rail.mode == "sol_transfer" && q.rail.destination == q.rail.treasuryLiquidity
        })
        require(if (q.request.kind == "mine") q.quotedCostShards != null && BigInteger(q.quotedCostShards) <= BigInteger(requireNotNull(q.request.maxCostShards)) else q.quotedCostShards == null)
        q
    } }
}

data class BasePurchaseReceipt(val raw: JsonObject, val depositId: String, val acceptedAt: String, val txSignature: String,
    val amountLamports: String, val shardReceiptId: String?, val costShards: String?,
    val shieldGranted: Boolean? = null, val shieldExpiresAt: String? = null, val energyQuantity: Int? = null) {
    companion object { fun from(raw: JsonObject, kind: String? = null): BasePurchaseReceipt = with(BasePurchaseContract) {
        val fields = arrayOf("version", "depositId", "acceptedAt", "txSignature", "amountLamports", "shards")
        val shieldKind = kind in setOf("shield", "warzone_shield")
        val energyKind = kind in setOf("energy", "energy_pack")
        keys(raw, *when { shieldKind -> fields + "shield"; energyKind -> fields + "energy"; else -> fields }); require(raw["version"] == JsonPrimitive(1))
        val energy = if (energyKind) obj(raw, "energy").also { keys(it, "quantity") } else null
        val shield = if (shieldKind) obj(raw, "shield").also { keys(it, "granted", "expiresAt") } else null
        val granted = shield?.let { flag(it, "granted") }
        val expires = shield?.let { optional(it, "expiresAt")?.let(::date) }
        if (shieldKind) {
            require(granted != true || expires != null)
            require(kind != "warzone_shield" || granted == true)
            if (granted == true) require(Instant.parse(requireNotNull(expires)) > Instant.parse(date(text(raw, "acceptedAt"))))
        }
        val shards = if (raw["shards"] == JsonNull) null else obj(raw, "shards").also { keys(it, "receiptId", "currency", "amount"); require(text(it, "currency") == "SHARDS") }
        BasePurchaseReceipt(raw, id(text(raw, "depositId")), date(text(raw, "acceptedAt")), signature(text(raw, "txSignature")), lamports(text(raw, "amountLamports")),
            shards?.let { id(text(it, "receiptId")) }, shards?.let { amount(text(it, "amount")) }, granted, expires, energy?.let { integer(it, "quantity").also { qty -> require(qty > 0) } })
    } }
}

data class BasePurchaseState(val raw: JsonObject, val quote: BasePurchaseQuote, val status: String, val paymentSignature: String?,
    val txSignature: String?, val amount: String?, val finalizedAt: String?, val receipt: BasePurchaseReceipt?) {
    companion object { fun from(raw: JsonObject): BasePurchaseState = with(BasePurchaseContract) {
        keys(raw, "quote", "status", "paymentSignature", "txSignature", "amount", "finalizedAt", "receipt")
        val quote = BasePurchaseQuote.from(obj(raw, "quote"))
        val p = BasePurchaseState(raw, quote, text(raw, "status").also { require(it in setOf("pending", "credited", "expired", "failed")) },
            optional(raw, "paymentSignature")?.let(::signature), optional(raw, "txSignature")?.let(::signature), optional(raw, "amount")?.let(::amount),
            optional(raw, "finalizedAt")?.let(::date), if (raw["receipt"] == JsonNull) null else BasePurchaseReceipt.from(obj(raw, "receipt"), quote.request.kind))
        require(listOfNotNull(p.paymentSignature, p.txSignature, p.receipt?.txSignature).distinct().size <= 1)
        if (p.status == "credited") {
            val r = requireNotNull(p.receipt)
            require(r.depositId == p.quote.depositId && r.txSignature == p.txSignature && r.acceptedAt == p.finalizedAt
                && r.amountLamports == p.quote.amountLamports && p.amount == p.quote.amountLamports)
            require(r.energyQuantity == p.quote.energyQuantity)
            require(if (p.quote.request.kind == "mine") r.costShards != null && BigInteger(r.costShards) <= BigInteger(requireNotNull(p.quote.request.maxCostShards)) else r.costShards == null)
        } else {
            require(p.receipt == null)
            if (p.status == "failed") {
                // A failed payment is evidence of funds received, never an unpaid dismissal.
                require(p.txSignature != null && p.amount != null && p.finalizedAt != null)
            } else {
                require(p.txSignature == null && p.amount == null && p.finalizedAt == null)
                if (p.status == "expired") require(p.paymentSignature == null)
            }
        }
        p
    } }
}

data class BasePurchaseStatus(val raw: JsonObject, val wallet: String, val key: String, val enabled: Boolean, val serverNow: String, val purchase: BasePurchaseState?) {
    companion object { fun from(raw: JsonObject): BasePurchaseStatus = with(BasePurchaseContract) {
        keys(raw, "version", "wallet", "idempotencyKey", "enabled", "serverNow", "purchase"); require(raw["version"] == JsonPrimitive(1))
        val s = BasePurchaseStatus(raw, address(text(raw, "wallet")), id(text(raw, "idempotencyKey")), flag(raw, "enabled"), date(text(raw, "serverNow")),
            if (raw["purchase"] == JsonNull) null else BasePurchaseState.from(obj(raw, "purchase")))
        require(s.purchase == null || s.purchase.quote.wallet == s.wallet && s.purchase.quote.request.key == s.key); s
    } }
}

/** Explicit closure fences an unquoted key; an already-created quote must be recovered instead. */
data class BasePurchaseCancellation(val raw: JsonObject, val wallet: String, val key: String,
    val cancelled: Boolean, val purchase: BasePurchaseState?) {
    companion object { fun from(raw: JsonObject): BasePurchaseCancellation = with(BasePurchaseContract) {
        keys(raw, "version", "wallet", "idempotencyKey", "cancelled", "purchase"); require(raw["version"] == JsonPrimitive(1))
        val c = BasePurchaseCancellation(raw, address(text(raw, "wallet")), id(text(raw, "idempotencyKey")), flag(raw, "cancelled"),
            if (raw["purchase"] == JsonNull) null else BasePurchaseState.from(obj(raw, "purchase")))
        require(c.cancelled == (c.purchase == null))
        require(c.purchase == null || c.purchase.quote.wallet == c.wallet && c.purchase.quote.request.key == c.key)
        c
    } }
}
