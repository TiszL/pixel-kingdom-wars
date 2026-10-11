package gg.pixelkingdomwars.nativeclient.model

import java.time.Instant
import kotlinx.serialization.json.*

/** Shared heroRecruitment v1. Prices and tile bounds come from the verified catalogue. */
data class HeroAltarDefinition(val hero: String, val type: String, val name: String, val itemId: String,
    val costKeep: String, val keepLevel: Int, val buildSec: Int, val plotTiles: Int, val plotGeometry: PlotGeometry? = null) {
    init { plotGeometry?.let { require(it == PlotGeometry.supported(it.version) && it.version == 2 && plotTiles == it.size) } }
    companion object {
        fun all(catalogue: JsonObject, plotVersion: Int? = null): List<HeroAltarDefinition> {
            val plot = PlotGeometry.from(catalogue, plotVersion)
            val constants = requireNotNull(catalogue["constants"] as? JsonObject)
            val heroes = requireNotNull(constants["HEROES"] as? JsonObject)
            val costs = requireNotNull(constants["BUILD_COSTS"] as? JsonObject)
            val tiles = plot.size
            return heroes.map { (hero, value) ->
                val raw = value.jsonObject; val type = HeroRecruitmentContract.text(raw, "altar")
                require(HeroRecruitmentContract.hero(type) == hero)
                val cost = requireNotNull(raw["recruitCostKeep"] as? JsonPrimitive).also { require(!it.isString && it.longOrNull != null) }.content
                ForgeClaimContract.amount(cost); require(cost != "0")
                val level = HeroRecruitmentContract.integer(raw, "unlockKeepLevel").also { require(it > 0) }
                val build = requireNotNull(costs[type] as? JsonObject)
                require(HeroRecruitmentContract.integer(build, "requiresKeepLevel") == level)
                val seconds = HeroRecruitmentContract.integer(build, "buildSec").also { require(it >= 0) }
                HeroAltarDefinition(hero, type, HeroRecruitmentContract.text(raw, "name"), HeroRecruitmentContract.text(raw, "recruitItemId"), cost, level, seconds, tiles, plot.takeIf { it.version != 1 })
            }.also { require(it.map { row -> row.type }.toSet() == setOf("heroaltar", "siegestool")) }
        }
    }
}

data class HeroRecruitmentRequest(val idempotencyKey: String, val baseId: String?, val type: String,
    val tx: Int, val ty: Int, val heroContractOnly: Boolean, val maxCostKeep: String) {
    val body get() = buildJsonObject {
        put("idempotencyKey", idempotencyKey); put("baseId", baseId?.let(::JsonPrimitive) ?: JsonNull)
        put("type", type); put("tx", tx); put("ty", ty); put("heroContractOnly", heroContractOnly); put("maxCostKeep", maxCostKeep)
    }
    fun validate(plotTiles: Int, plotGeometry: PlotGeometry? = null) {
        ClanCommandContract.id(idempotencyKey); baseId?.let(ClanCommandContract::id); HeroRecruitmentContract.hero(type)
        require(plotTiles > 0 && (plotGeometry?.contains(tx, ty) ?: (tx in 0 until plotTiles && ty in 0 until plotTiles)))
        ForgeClaimContract.amount(maxCostKeep); require(if (heroContractOnly) maxCostKeep == "0" else maxCostKeep != "0")
    }
    companion object { fun from(raw: JsonObject, plotTiles: Int, plotGeometry: PlotGeometry? = null): HeroRecruitmentRequest {
        HeroRecruitmentContract.keys(raw, "idempotencyKey", "baseId", "type", "tx", "ty", "heroContractOnly", "maxCostKeep")
        return HeroRecruitmentRequest(HeroRecruitmentContract.text(raw, "idempotencyKey"), HeroRecruitmentContract.optional(raw, "baseId"),
            HeroRecruitmentContract.text(raw, "type"), HeroRecruitmentContract.integer(raw, "tx"), HeroRecruitmentContract.integer(raw, "ty"),
            HeroRecruitmentContract.flag(raw, "heroContractOnly"), HeroRecruitmentContract.text(raw, "maxCostKeep")).also { it.validate(plotTiles, plotGeometry) }
    } }
}

/** No derived current building or bag state is ever converted into historical proof. */
data class HeroRecruitmentReceipt(val actor: String, val request: HeroRecruitmentRequest, val hero: String,
    val buildingId: String, val jobId: String, val finishesAt: String, val funding: JsonObject, val raw: JsonObject) {
    companion object { fun from(raw: JsonObject, definition: HeroAltarDefinition): HeroRecruitmentReceipt {
        val c = HeroRecruitmentContract
        c.keys(raw, "version", "actor", "idempotencyKey", "request", "hero", "building", "job", "funding", "createdAt")
        require(raw["version"] == JsonPrimitive(1)); val actor = c.text(raw, "actor").also(ClanCommandContract::wallet)
        val request = HeroRecruitmentRequest.from(requireNotNull(raw["request"] as? JsonObject), definition.plotTiles, definition.plotGeometry)
        require(c.text(raw, "idempotencyKey") == request.idempotencyKey && request.type == definition.type)
        val hero = c.text(raw, "hero"); require(hero == definition.hero)
        val building = requireNotNull(raw["building"] as? JsonObject)
        c.keys(building, "id", "baseId", "type", "level", "tx", "ty")
        val buildingId = c.text(building, "id").also(ClanCommandContract::id)
        require(c.optional(building, "baseId") == request.baseId && c.text(building, "type") == request.type
            && c.integer(building, "level") == 1 && c.integer(building, "tx") == request.tx && c.integer(building, "ty") == request.ty)
        val job = requireNotNull(raw["job"] as? JsonObject); c.keys(job, "id", "buildingId", "startedAt", "finishesAt")
        val jobId = c.text(job, "id").also(ClanCommandContract::id); require(c.text(job, "buildingId") == buildingId)
        val start = c.time(job, "startedAt"); val finish = c.time(job, "finishesAt"); require(!finish.isBefore(start)); c.time(raw, "createdAt")
        val funding = requireNotNull(raw["funding"] as? JsonObject)
        when (c.text(funding, "kind")) {
            "contract" -> {
                c.keys(funding, "kind", "itemId", "itemUseId", "sourceBaseId", "quantity")
                require(c.text(funding, "itemId") == definition.itemId && c.integer(funding, "quantity") == 1)
                c.text(funding, "itemUseId").also(ClanCommandContract::id)
                val source = c.optional(funding, "sourceBaseId"); source?.let(ClanCommandContract::id)
                require(source == null || source == request.baseId)
            }
            "keep" -> {
                c.keys(funding, "kind", "amount", "ledgerTransactionId"); require(!request.heroContractOnly)
                val paid = c.text(funding, "amount").also(ForgeClaimContract::amount)
                require(paid != "0" && paid.toLong() <= request.maxCostKeep.toLong())
                c.text(funding, "ledgerTransactionId").also(ClanCommandContract::id)
            }
            else -> error("Unrecognized recruitment funding")
        }
        return HeroRecruitmentReceipt(actor, request, hero, buildingId, jobId, c.text(job, "finishesAt"), funding, raw)
    } }
}

object HeroRecruitmentContract {
    fun hero(type: String): String = when (type) { "heroaltar" -> "vex"; "siegestool" -> "theodor"; else -> error("Not a hero altar") }
    fun keys(raw: JsonObject, vararg names: String) { require(raw.keys == names.toSet()) }
    fun text(raw: JsonObject, key: String) = ForgeClaimContract.text(raw, key)
    fun optional(raw: JsonObject, key: String) = ForgeClaimContract.optional(raw, key)
    fun flag(raw: JsonObject, key: String): Boolean { require(raw[key] == JsonPrimitive(true) || raw[key] == JsonPrimitive(false)); return raw[key] == JsonPrimitive(true) }
    fun integer(raw: JsonObject, key: String): Int = requireNotNull(raw[key] as? JsonPrimitive).let { require(!it.isString); requireNotNull(it.intOrNull) }
    fun time(raw: JsonObject, key: String): Instant = text(raw, key).let { require(it.endsWith('Z')); Instant.parse(it) }
}
