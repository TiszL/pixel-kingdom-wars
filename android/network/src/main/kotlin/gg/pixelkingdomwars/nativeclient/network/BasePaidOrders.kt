package gg.pixelkingdomwars.nativeclient.network

import gg.pixelkingdomwars.nativeclient.model.BasePurchaseContract
import gg.pixelkingdomwars.nativeclient.model.BasePurchaseRequest
import gg.pixelkingdomwars.nativeclient.model.BaseSnapshot
import java.math.BigDecimal
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Prices/counts/steps come only from the admitted canonical catalogue and the original base. */
@Serializable data class BasePurchaseOffer(val kind: String, val baseId: String, val expectedCount: Int? = null,
    val buildingId: String? = null, val buildingType: String? = null, val fromLevel: Int? = null, val toLevel: Int? = null,
    val amountLamports: String, val maxCostShards: String? = null, val seconds: String? = null, val claimTiles: Int? = null,
    val directLamports: String? = null, val splitLamports: String? = null, val energyQuantity: Int? = null) {
    fun request(key: String): BasePurchaseRequest = BasePurchaseRequest.from(buildJsonObject {
        put("idempotencyKey", key); put("baseId", baseId); put("kind", kind)
        when (kind) {
            "energy", "energy_pack", "shield", "warzone_shield" -> Unit
            "builder" -> put("expectedBuilders", requireNotNull(expectedCount))
            "expansion" -> put("expectedExpansions", requireNotNull(expectedCount))
            "mine" -> { put("buildingId", requireNotNull(buildingId)); put("buildingType", requireNotNull(buildingType))
                put("fromLevel", requireNotNull(fromLevel)); put("toLevel", requireNotNull(toLevel)); put("maxCostShards", requireNotNull(maxCostShards)) }
            else -> error("Unsupported paid base purchase.")
        }
    })
    fun validate() {
        request("00000000-0000-4000-8000-000000000001"); BasePurchaseContract.lamports(amountLamports)
        val energyKind = kind in setOf("energy", "energy_pack")
        require(if (energyKind) energyQuantity != null && energyQuantity > 0 else energyQuantity == null)
        if (energyKind) {
            require(expectedCount == null && claimTiles == null && buildingId == null && buildingType == null && fromLevel == null && toLevel == null && maxCostShards == null && seconds == null)
        } else if (kind in setOf("shield", "warzone_shield")) {
            require(expectedCount == null && claimTiles == null && buildingId == null && buildingType == null && fromLevel == null && toLevel == null && maxCostShards == null)
            require(requireNotNull(seconds).toLong() > 0)
        } else if (kind == "mine") { require(expectedCount == null && claimTiles == null); BasePurchaseContract.amount(requireNotNull(maxCostShards)); require(requireNotNull(seconds).toLong() > 0) }
        else { require(buildingId == null && buildingType == null && fromLevel == null && toLevel == null && maxCostShards == null && seconds == null)
            require(if (kind == "expansion") requireNotNull(claimTiles) > 0 else claimTiles == null) }
        if (kind == "warzone_shield") {
            val direct = BasePurchaseContract.lamports(requireNotNull(directLamports)).toBigInteger()
            val split = BasePurchaseContract.lamports(requireNotNull(splitLamports)).toBigInteger()
            require(direct.signum() > 0 && split.signum() > 0 && direct + split == amountLamports.toBigInteger())
        } else require(directLamports == null && splitLamports == null)
    }
}

/** One energy is the single-SKU ABI; the pack's quantity and both prices come from canonical content. */
fun energyPurchaseOffer(constants: JsonObject, baseId: String, kind: String): BasePurchaseOffer? = runCatching {
    require(kind in setOf("energy", "energy_pack")); BasePurchaseContract.id(baseId)
    val rules = requireNotNull(constants["RAID_ENERGY"] as? JsonObject)
    val pack = kind == "energy_pack"
    val price = BasePurchaseContract.lamports(requireNotNull(rules.string(if (pack) "packLamports" else "solLamportsPerEnergy")))
    val quantity = if (pack) requireNotNull(rules.string("packSize")).toInt() else 1
    BasePurchaseOffer(kind, baseId, amountLamports = price, energyQuantity = quantity).also { it.validate() }
}.getOrNull()

fun basePurchaseOffer(catalogue: JsonObject, base: BaseSnapshot, kind: String, buildingId: String? = null): BasePurchaseOffer? = runCatching {
    val baseId = BasePurchaseContract.id(requireNotNull(base.baseId)); val c = requireNotNull(catalogue["constants"] as? JsonObject)
    fun table(name: String) = requireNotNull(c[name] as? JsonObject)
    fun at(raw: JsonObject, key: String, index: Int) = requireNotNull(((raw[key] as? JsonArray)?.getOrNull(index) as? JsonPrimitive)?.contentOrNull)
    fun sol(value: String) = BasePurchaseContract.lamports(BigDecimal(value).movePointRight(9).toBigIntegerExact().toString())
    when (kind) {
        "energy", "energy_pack" -> { require(buildingId == null); requireNotNull(energyPurchaseOffer(c, baseId, kind)) }
        "shield", "warzone_shield" -> {
            require(buildingId == null)
            val ordinary = kind == "shield"; val rules = table(if (ordinary) "SHIELD" else "WARZONE")
            val amount = BasePurchaseContract.lamports(requireNotNull(rules.string(if (ordinary) "extendCostSolLamports" else "shieldCostSolLamports")))
            val hours = requireNotNull(rules.string(if (ordinary) "extendHours" else "shieldDurationHours")).toLong()
            val direct = if (ordinary) null else {
                val bps = requireNotNull(rules.string("shieldLiquidityDirectBps")).toBigInteger()
                require(bps.signum() > 0 && bps < 10000.toBigInteger())
                amount.toBigInteger() * bps / 10000.toBigInteger()
            }
            BasePurchaseOffer(kind, baseId, amountLamports = amount, seconds = Math.multiplyExact(hours, 3600L).toString(),
                directLamports = direct?.toString(), splitLamports = direct?.let { (amount.toBigInteger() - it).toString() })
        }
        "builder" -> {
            require(buildingId == null); val count = requireNotNull(base.player.builders); val caps = table("CAPS")
            require(count >= 1 && count < requireNotNull(caps.string("buildersMax")).toInt())
            BasePurchaseOffer(kind, baseId, expectedCount = count, amountLamports = sol(at(caps, "builderPricesSol", count - 1)))
        }
        "expansion" -> {
            require(buildingId == null); val count = requireNotNull(base.player.expansions); require(count >= 0)
            val offer = requireNotNull(expansionOffer(catalogue, count))
            require(!offer.maxed && base.player.keepLevel >= requireNotNull(offer.requiredKeepLevel))
            BasePurchaseOffer(kind, baseId, expectedCount = count, amountLamports = sol(requireNotNull(offer.priceSol)), claimTiles = requireNotNull(offer.next))
        }
        "mine" -> {
            val building = base.buildings.single { it.id == buildingId }; require(building.type in setOf("mine", "goldforge"))
            val level = building.level; require(level >= 1 && level < maxLevelFor(catalogue, building.type) && level < base.player.keepLevel)
            require(!building.underConstruction && base.jobs.none { it.buildingId == buildingId } && base.freeBuilders > 0)
            val lamports = requireNotNull(upgradeSolLamports(catalogue, building.type, level + 1)).toString(); BasePurchaseContract.lamports(lamports)
            val shards = at(table("UPGRADE_COSTS"), building.type, level - 1); BasePurchaseContract.amount(shards)
            val seconds = at(table("UPGRADE_TIMES_SEC"), building.type, level - 1)
            BasePurchaseOffer(kind, baseId, buildingId = building.id, buildingType = building.type, fromLevel = level, toLevel = level + 1,
                amountLamports = lamports, maxCostShards = shards, seconds = seconds)
        }
        else -> error("Unsupported paid base purchase.")
    }.also { it.validate() }
}.getOrNull()
