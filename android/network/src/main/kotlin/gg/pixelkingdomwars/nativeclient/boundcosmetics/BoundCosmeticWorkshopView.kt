package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.*
import gg.pixelkingdomwars.nativeclient.ordinaryequipment.EquipmentRecipe
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

/** Values must come from the admitted canonical catalogue, not another Kotlin policy. */
class BoundCosmeticWorkshopRules(private val queueLimit: () -> Int, val completedMarketOutput: (Long) -> String) {
    constructor(maxConcurrentPerBase: Int, completedMarketOutput: (Long) -> String) : this({ maxConcurrentPerBase }, completedMarketOutput)
    // A missing catalogue holds new observations without hiding saved originals.
    val maxConcurrentPerBase: Int get() = queueLimit()
}
data class BoundCosmeticBlueprintEligibility(val state: String, val proof: BoundCosmeticBlueprint?, val reason: String?)
@Serializable data class BoundCosmeticCatalogueRow(val recipe: BoundCosmeticRecipe, val appearance: BoundCosmeticAppearance)
@Serializable data class BoundCosmeticCompletedFacility(val buildingId: String, val level: Long, val completedAt: String)
@Serializable data class BoundCosmeticPreference(val enabled: Boolean, val revision: String)
data class BoundCosmeticQueueJob(val kind: String, val jobId: String, val recipe: JsonObject,
    val durationSec: Long, val startedAt: String, val readyAt: String)
sealed interface BoundCosmeticSelectedBase {
    val baseId: String
    data class Unavailable(override val baseId: String, val reason: String) : BoundCosmeticSelectedBase
    data class Available(override val baseId: String, val craftingStock: List<OrdinaryProtectedStock>,
        val workshops: List<BoundCosmeticCompletedFacility>, val markets: List<BoundCosmeticCompletedFacility>,
        val queue: List<BoundCosmeticQueueJob>, val preference: BoundCosmeticPreference,
        val visual: BoundCosmeticBaseRead) : BoundCosmeticSelectedBase
}
/** Validated authenticated server facts. This is neither art admission nor permission to spend. */
data class BoundCosmeticWorkshopView(val version: Int, val wallet: String, val serverNow: String,
    val acceptingJobs: Boolean, val applicationReady: Boolean, val blueprint: BoundCosmeticBlueprintEligibility,
    val recipes: List<BoundCosmeticCatalogueRow>, val originals: List<BoundCosmeticProof>, val selectedBase: BoundCosmeticSelectedBase?) {
    companion object {
        fun from(raw: JsonObject, wallet: String, baseId: String?, rules: BoundCosmeticWorkshopRules): BoundCosmeticWorkshopView {
            wallet(wallet); baseId?.let(::uuid); require(rules.maxConcurrentPerBase > 0)
            val owned = cosmeticJson.parseToJsonElement(raw.toString()).jsonObject
            val v = cosmeticObject(owned, "version", "wallet", "serverNow", "acceptingJobs", "applicationReady", "blueprint", "recipes", "originals", "selectedBase")
            require(v["version"] == JsonPrimitive(1) && cosmeticText(v["wallet"]) == wallet)
            val nowText = cosmeticText(v["serverNow"]); val now = timestamp(nowText)
            val accepting = cosmeticBoolean(v["acceptingJobs"]); val ready = cosmeticBoolean(v["applicationReady"]); require(!accepting || ready)
            val blueprint = cosmeticBlueprintEligibility(v["blueprint"], wallet, now)
            val recipes = cosmeticArray(v["recipes"]).map { cosmeticDecode(it, BoundCosmeticCatalogueRow.serializer()).also { row ->
                row.recipe.validate(); row.appearance.validate(); require(row.recipe.outputId == row.appearance.outputId) } }
            require(recipes.map { it.recipe.recipeId } == awningRecipes)
            val originals = cosmeticArray(v["originals"]).map { BoundCosmeticProof.from(it.jsonObject) }
            require(originals.size <= cosmeticOutputs.size && originals.all { it.status == "accepted" && it.wallet == wallet && timestamp(it.serverNow) <= now })
            require(originals.map { it.idempotencyKey }.distinct().size == originals.size && originals.map { it.receipt!!.recipe.outputId }.distinct().size == originals.size)
            val base = if (v["selectedBase"] == JsonNull) null else {
                val b = requireNotNull(v["selectedBase"] as? JsonObject); val id = cosmeticText(b["baseId"]).also(::uuid)
                when (cosmeticText(b["state"])) {
                    "unavailable" -> { cosmeticObject(b, "state", "baseId", "reason"); val reason = cosmeticText(b["reason"])
                        require(reason in setOf("BASE_NOT_OWNED", "BASE_ID_REQUIRED", "DEED_AUTHORITY_UNAVAILABLE", "DEED_OWNERSHIP_CHANGED")); BoundCosmeticSelectedBase.Unavailable(id, reason) }
                    "available" -> {
                        cosmeticObject(b, "state", "baseId", "craftingStock", "workshops", "markets", "queue", "preference", "visual")
                        val stock = cosmeticWorkshopStock(b["craftingStock"])
                        val workshops = cosmeticFacilities(b["workshops"], now); val markets = cosmeticFacilities(b["markets"], now); val buildings = workshops + markets
                        markets.forEach { require(rules.completedMarketOutput(it.level) in cosmeticOutputs.dropLast(1)) }
                        require(buildings.map { it.buildingId }.distinct().size == buildings.size)
                        val queue = cosmeticArray(b["queue"]).map { cosmeticQueue(it.jsonObject).also { row -> require(timestamp(row.startedAt) <= now && timestamp(row.readyAt) > now) } }
                        require(queue.size <= rules.maxConcurrentPerBase && queue.map { it.jobId }.distinct().size == queue.size)
                        val preference = cosmeticDecode(requireNotNull(b["preference"]), BoundCosmeticPreference.serializer())
                        quantity(preference.revision); require(preference.revision != "0" || !preference.enabled)
                        val visual = BoundCosmeticBaseRead.from(requireNotNull(b["visual"] as? JsonObject))
                        visual.match(markets.map { BoundCosmeticVisualBuilding(it.buildingId, "market", it.level, false) }, rules.completedMarketOutput)
                        BoundCosmeticSelectedBase.Available(id, stock, workshops, markets, queue, preference, visual)
                    }
                    else -> error("Unknown selected kingdom state")
                }
            }
            require(base?.baseId == baseId) { "Workshop snapshot belongs to another selected kingdom" }
            return BoundCosmeticWorkshopView(1, wallet, nowText, accepting, ready, blueprint, recipes, originals, base)
        }
    }
}

internal fun cosmeticQueue(raw: JsonObject): BoundCosmeticQueueJob {
    val v = cosmeticObject(raw, "kind", "jobId", "recipe", "startedAt", "readyAt")
    val kind = cosmeticText(v["kind"]); val recipe = requireNotNull(v["recipe"] as? JsonObject)
    val duration = when (kind) {
        "ordinary" -> cosmeticDecode(recipe, OrdinaryCraftingRecipe.serializer()).also { it.validate() }.durationSec
        "equipment" -> cosmeticDecode(recipe, EquipmentRecipe.serializer()).also { it.validate() }.durationSec
        "cosmetic" -> BoundCosmeticRecipe.from(recipe).durationSec
        else -> error("Unknown Workshop queue kind")
    }
    count(duration, true); val id = cosmeticText(v["jobId"]).also(::uuid)
    val started = cosmeticText(v["startedAt"]); val ready = cosmeticText(v["readyAt"])
    require(timestamp(ready) == timestamp(started).plusSeconds(duration))
    return BoundCosmeticQueueJob(kind, id, recipe, duration, started, ready)
}
internal fun cosmeticObject(value: JsonElement?, vararg keys: String): JsonObject = requireNotNull(value as? JsonObject).also { require(it.keys == keys.toSet()) }
internal fun cosmeticText(value: JsonElement?): String = requireNotNull((value as? JsonPrimitive)?.takeIf { it.isString }?.content)
internal fun cosmeticBoolean(value: JsonElement?): Boolean = requireNotNull((value as? JsonPrimitive)?.takeUnless { it.isString }?.booleanOrNull)
internal fun cosmeticArray(value: JsonElement?): JsonArray = requireNotNull(value as? JsonArray)

internal fun cosmeticBlueprintEligibility(raw: JsonElement?, wallet: String, now: java.time.Instant): BoundCosmeticBlueprintEligibility {
    val bp = requireNotNull(raw as? JsonObject); val bpState = cosmeticText(bp["state"])
    return when (bpState) {
        "eligible" -> { cosmeticObject(bp, "state", "proof")
            val proof = cosmeticDecode(requireNotNull(bp["proof"]), BoundCosmeticBlueprint.serializer()).also { it.validate() }
            require(proof.actorWallet == wallet && timestamp(proof.completedAt) <= now); BoundCosmeticBlueprintEligibility(bpState, proof, null) }
        "not-earned" -> { cosmeticObject(bp, "state", "proof"); require(bp["proof"] == JsonNull); BoundCosmeticBlueprintEligibility(bpState, null, null) }
        "unavailable" -> { cosmeticObject(bp, "state", "reason", "proof"); require(bp["proof"] == JsonNull)
            val reason = cosmeticText(bp["reason"]); require(reason in setOf("NOT_CONFIGURED", "SOURCE_UNAVAILABLE", "SOURCE_CONFLICT")); BoundCosmeticBlueprintEligibility(bpState, null, reason) }
        else -> error("Unknown Blueprint eligibility")
    }
}
internal fun cosmeticWorkshopStock(raw: JsonElement?): List<OrdinaryProtectedStock> = cosmeticArray(raw).map {
    cosmeticDecode(it, OrdinaryProtectedStock.serializer()).also { row -> row.validate() }
}.also { stock -> require(stock.size == craftingItemIdsV2.size && stock.map { it.itemId }.toSet() == craftingItemIdsV2) }
internal fun cosmeticFacilities(raw: JsonElement?, now: java.time.Instant): List<BoundCosmeticCompletedFacility> = cosmeticArray(raw).map {
    cosmeticDecode(it, BoundCosmeticCompletedFacility.serializer()).also { row ->
        uuid(row.buildingId); count(row.level, true); require(timestamp(row.completedAt) <= now)
    }
}
