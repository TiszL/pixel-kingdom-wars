package gg.pixelkingdomwars.nativeclient.ordinarycrafting

import gg.pixelkingdomwars.nativeclient.network.longValueExactCompat
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.stamp
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import java.math.BigInteger
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

internal val ordinaryJson = Json { encodeDefaults = true }
// Resource identities, not tuning. Prices, quantities, durations and batch limits come from the server.
private val refinedInputs = linkedMapOf("frostglass" to "frost_quartz", "heartwood_beams" to "heartwood_logs",
    "sunstone_blocks" to "sunstone_rubble", "crownsteel" to "crown_iron_ore", "prismstone_lens" to "rough_prism",
    "stormalloy" to "storm_ore", "thornsilk" to "thorn_fibre", "embercore" to "ember_nodules")
internal val rawResourceIds = refinedInputs.values.toSet()
internal val craftingItemIds = refinedInputs.keys + "navigation_kit"
internal val craftingItemIdsV2 = craftingItemIds + setOf("climate_kit", "expedition_kit")
internal val ordinaryRecipeIds = refinedInputs.keys.map { "refine_$it" }.toSet() + "craft_navigation_kit"
internal val ordinaryRecipeIdsV2 = ordinaryRecipeIds + setOf("craft_climate_kit", "craft_expedition_kit")
internal fun quantity(value: String, positive: Boolean = false): BigInteger {
    require(value.matches(Regex("0|[1-9][0-9]{0,18}")))
    return value.toBigInteger().also { require(it <= BigInteger.valueOf(Long.MAX_VALUE) && (!positive || it.signum() > 0)) }
}
internal fun timestamp(value: String): Instant {
    require(value.matches(Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z")))
    return stamp(value)
}
internal fun whole(value: Int) { require(value > 0) } // PostgreSQL integer request domain, not a batch cap.
/** Backend z.uuid plus lowercase canonical wire identity (RFC versions, nil and max). */
internal fun uuid(value: String) {
    require(value.matches(Regex("[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")) ||
        value == "00000000-0000-0000-0000-000000000000" || value == "ffffffff-ffff-ffff-ffff-ffffffffffff")
}

@Serializable data class OrdinaryCraftingIdentity(val origin: String, val cluster: String, val wallet: String) {
    fun validate() = WorkshopIdentity(origin, cluster, wallet).validate()
}
@Serializable data class OrdinaryCraftingFeature(val version: Int, val receipts: Int)
@Serializable data class OrdinaryCraftingFeatures(val ordinaryCrafting: OrdinaryCraftingFeature)
@Serializable data class OrdinaryCraftingInput(val kind: String, val itemId: String, val quantity: String)
@Serializable data class OrdinaryCraftingOutput(val itemId: String, val quantity: String)
@Serializable data class OrdinaryCraftingRecipe(val recipeVersion: Int, val recipeId: String, val quantity: Int,
    val durationSec: Long, val inputs: List<OrdinaryCraftingInput>, val output: OrdinaryCraftingOutput) {
    fun validate() {
        require(recipeVersion in 1..2); whole(quantity); count(durationSec, true)
        require(recipeId in if (recipeVersion == 1) ordinaryRecipeIds else ordinaryRecipeIdsV2)
        quantity(output.quantity, true); require(output.itemId in if (recipeVersion == 1) craftingItemIds else craftingItemIdsV2)
        require(inputs.isNotEmpty() && inputs.map { it.kind to it.itemId }.distinct().size == inputs.size)
        inputs.forEach { quantity(it.quantity, true); require(when (it.kind) { "raw" -> it.itemId in rawResourceIds; "crafting" -> it.itemId in craftingItemIdsV2; "shards" -> recipeVersion == 2 && it.itemId == "shards"; else -> false }) }
        if (recipeId == "craft_navigation_kit") {
            require(output.itemId == "navigation_kit" && inputs.map { it.kind to it.itemId } == listOf("crafting" to "prismstone_lens", "crafting" to "frostglass"))
        } else if (recipeId == "craft_climate_kit") {
            require(output.itemId == "climate_kit" && inputs.map { it.kind to it.itemId } == listOf("crafting" to "sunstone_blocks", "crafting" to "embercore"))
        } else if (recipeId == "craft_expedition_kit") {
            require(output.itemId == "expedition_kit" && inputs.map { it.kind to it.itemId } == listOf("crafting" to "heartwood_beams", "crafting" to "thornsilk", "shards" to "shards"))
        } else require(recipeId == "refine_${output.itemId}" && inputs.size == 1 && inputs.single().kind == "raw" && inputs.single().itemId == refinedInputs[output.itemId])
    }
    /** Exact display/review scaling only. The server still determines and commits conversion. */
    fun batch(size: Int): OrdinaryCraftingRecipe {
        validate(); require(quantity == 1); whole(size)
        fun scale(value: String) = (quantity(value, true) * size.toBigInteger()).toString().also { quantity(it, true) }
        val duration = (durationSec.toBigInteger() * size.toBigInteger()).longValueExactCompat()
        return copy(quantity = size, durationSec = duration, inputs = inputs.map { it.copy(quantity = scale(it.quantity)) }, output = output.copy(quantity = scale(output.quantity))).also { it.validate() }
    }
}
@Serializable data class OrdinaryRawStock(val resourceId: String, val available: String, val reserved: String, val total: String) {
    fun validate() { require(resourceId in rawResourceIds); require(quantity(available) + quantity(reserved) == quantity(total)) }
}
@Serializable data class OrdinaryProtectedStock(val itemId: String, val available: String, val pendingOutput: String) {
    fun validate() { require(itemId in craftingItemIdsV2); require(quantity(available) + quantity(pendingOutput) <= BigInteger.valueOf(Long.MAX_VALUE)) }
}
@Serializable data class OrdinaryCraftingPendingJob(val jobId: String, val recipe: OrdinaryCraftingRecipe, val startedAt: String, val readyAt: String) {
    fun validate() { uuid(jobId); recipe.validate(); require(timestamp(readyAt) == timestamp(startedAt).plusSeconds(recipe.durationSec)) }
}
@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
@Serializable data class OrdinaryCraftingView(val wallet: String, val baseId: String, val features: OrdinaryCraftingFeatures,
    val acceptingJobs: Boolean, val recipeVersion: Int, val maxBatch: Int, val recipes: List<OrdinaryCraftingRecipe>,
    val rawStock: List<OrdinaryRawStock>, val craftingStock: List<OrdinaryProtectedStock>,
    val pendingJobs: List<OrdinaryCraftingPendingJob>, val serverNow: String,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val catalogueVersion: Int? = null,
    @kotlinx.serialization.EncodeDefault(kotlinx.serialization.EncodeDefault.Mode.NEVER) val shardsAvailable: String? = null) {
    fun validate() {
        wallet(wallet); uuid(baseId); require(features.ordinaryCrafting == OrdinaryCraftingFeature(1, 1)); whole(maxBatch)
        require(catalogueVersion == null || catalogueVersion == 2)
        require(recipeVersion == (catalogueVersion ?: 1))
        if (catalogueVersion == null) require(shardsAvailable == null) else quantity(requireNotNull(shardsAvailable))
        val recipeIds = if (catalogueVersion == null) ordinaryRecipeIds else ordinaryRecipeIdsV2
        val stockIds = if (catalogueVersion == null) craftingItemIds else craftingItemIdsV2
        val now = timestamp(serverNow)
        require(recipes.map { it.recipeId }.toSet() == recipeIds && recipes.size == recipeIds.size)
        recipes.forEach { it.validate(); require(it.recipeVersion == recipeVersion && it.quantity == 1) }
        require(rawStock.map { it.resourceId }.toSet() == rawResourceIds && rawStock.size == rawResourceIds.size); rawStock.forEach { it.validate() }
        require(craftingStock.map { it.itemId }.toSet() == stockIds && craftingStock.size == stockIds.size); craftingStock.forEach { it.validate() }
        require(pendingJobs.map { it.jobId }.distinct().size == pendingJobs.size)
        pendingJobs.forEach { it.validate(); require(catalogueVersion == 2 || it.recipe.recipeVersion == 1); require(timestamp(it.startedAt) <= now && timestamp(it.readyAt) > now) }
        craftingStock.forEach { stock -> require(quantity(stock.pendingOutput) == pendingJobs.filter { it.recipe.output.itemId == stock.itemId }
            .fold(BigInteger.ZERO) { sum, job -> sum + quantity(job.recipe.output.quantity, true) }) }
    }
    fun available(input: OrdinaryCraftingInput): String = when (input.kind) {
        "raw" -> rawStock.single { it.resourceId == input.itemId }.available
        "crafting" -> craftingStock.single { it.itemId == input.itemId }.available
        "shards" -> requireNotNull(shardsAvailable)
        else -> error("Unknown crafting ingredient")
    }
    companion object { fun from(raw: JsonObject): OrdinaryCraftingView {
        require(if ("catalogueVersion" in raw) raw["catalogueVersion"] == JsonPrimitive(2) && "shardsAvailable" in raw else "shardsAvailable" !in raw)
        strictPrimitives(raw, serializer().descriptor); return ordinaryJson.decodeFromJsonElement<OrdinaryCraftingView>(raw).also { it.validate() }
    } }
}
@Serializable data class OrdinaryCraftingRequest(val idempotencyKey: String, val baseId: String, val recipeId: String, val recipeVersion: Int, val quantity: Int) {
    fun validate() { uuid(idempotencyKey); uuid(baseId); require(recipeId.matches(Regex("[a-z][a-z0-9_]{0,63}"))); whole(recipeVersion); whole(quantity) }
    fun body(): JsonObject = ordinaryJson.encodeToJsonElement(serializer(), this).jsonObject
}
/** Full reviewed recipe is durable alongside the exact explicit command, never reconstructed from live policy. */
@Serializable data class OrdinaryCraftingCommand(val request: OrdinaryCraftingRequest, val recipe: OrdinaryCraftingRecipe) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/ordinary-crafting/jobs/by-key/$key"
    fun validate() { request.validate(); recipe.validate(); require(request.recipeId == recipe.recipeId && request.recipeVersion == recipe.recipeVersion && request.quantity == recipe.quantity) }
    fun admit(identity: OrdinaryCraftingIdentity, current: OrdinaryCraftingView) {
        validate(); identity.validate(); current.validate()
        require(current.wallet == identity.wallet && current.baseId == request.baseId && current.acceptingJobs && current.pendingJobs.isEmpty())
        require(request.recipeVersion == current.recipeVersion && request.quantity <= current.maxBatch)
        require(current.recipes.single { it.recipeId == request.recipeId }.batch(request.quantity) == recipe)
        recipe.inputs.forEach { input ->
            val available = current.available(input)
            require(quantity(available) >= quantity(input.quantity, true))
        }
        val output = current.craftingStock.single { it.itemId == recipe.output.itemId }
        require(quantity(output.available) + quantity(output.pendingOutput) + quantity(recipe.output.quantity, true) <= BigInteger.valueOf(Long.MAX_VALUE))
    }
    companion object { fun review(identity: OrdinaryCraftingIdentity, view: OrdinaryCraftingView, key: String, recipeId: String, quantity: Int): OrdinaryCraftingCommand {
        view.validate(); val recipe = view.recipes.single { it.recipeId == recipeId }.batch(quantity)
        return OrdinaryCraftingCommand(OrdinaryCraftingRequest(key, view.baseId, recipeId, view.recipeVersion, quantity), recipe).also { it.admit(identity, view) }
    } }
}
@Serializable data class OrdinaryCraftingReceipt(val jobId: String, val recipe: OrdinaryCraftingRecipe, val startedAt: String,
    val readyAt: String, val wallet: String, val request: OrdinaryCraftingRequest) {
    fun validate(identity: OrdinaryCraftingIdentity, command: OrdinaryCraftingCommand) {
        identity.validate(); command.validate(); wallet(wallet); require(wallet == identity.wallet && request == command.request && recipe == command.recipe && jobId == request.idempotencyKey)
        OrdinaryCraftingPendingJob(jobId, recipe, startedAt, readyAt).validate()
    }
}
@Serializable data class OrdinaryCraftingCompletion(val completedAt: String)
@Serializable data class OrdinaryCraftingProof(val wallet: String, val idempotencyKey: String, val serverNow: String,
    val status: String, val receipt: OrdinaryCraftingReceipt?, val completion: OrdinaryCraftingCompletion?) {
    fun validate(identity: OrdinaryCraftingIdentity, command: OrdinaryCraftingCommand) {
        identity.validate(); command.validate(); require(wallet == identity.wallet && idempotencyKey == command.key); val now = timestamp(serverNow)
        if (status == "unknown") { require(receipt == null && completion == null); return }
        require(status == "accepted"); val original = requireNotNull(receipt); original.validate(identity, command)
        require(timestamp(original.startedAt) <= now)
        completion?.let { require(timestamp(it.completedAt) in timestamp(original.readyAt)..now) }
    }
    companion object { fun from(raw: JsonObject, identity: OrdinaryCraftingIdentity, command: OrdinaryCraftingCommand): OrdinaryCraftingProof {
        strictPrimitives(raw, serializer().descriptor); return ordinaryJson.decodeFromJsonElement<OrdinaryCraftingProof>(raw).also { it.validate(identity, command) }
    } }
}
