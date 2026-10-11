package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.quantity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.workshop.WorkshopIdentity
import gg.pixelkingdomwars.nativeclient.workshop.count
import gg.pixelkingdomwars.nativeclient.workshop.strictPrimitives
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import kotlinx.serialization.Serializable
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.*

internal val cosmeticJson = Json { encodeDefaults = true }
internal fun <T> cosmeticDecode(raw: JsonElement, serializer: KSerializer<T>): T {
    strictPrimitives(raw, serializer.descriptor)
    return cosmeticJson.decodeFromJsonElement(serializer, raw)
}
internal fun cosmeticHash(value: String) { require(value.matches(Regex("[0-9a-f]{64}"))) }
internal const val cosmeticBlueprint = "architect_blueprint_artisan_finishes_v1"
// Wire identities only. Immutable quantities, duration and required level come from the server.
internal val cosmeticOutputs = listOf("artisan_market_awning_t1", "artisan_market_awning_t2", "artisan_market_awning_t3", "artisan_market_awning_t4", "aurora_wake")
internal val awningRecipes = cosmeticOutputs.dropLast(1).map { "craft_${it}_v1" }
private val refinedIds = setOf("frostglass", "heartwood_beams", "sunstone_blocks", "crownsteel", "prismstone_lens", "stormalloy", "thornsilk", "embercore")

@Serializable data class BoundCosmeticIdentity(val origin: String, val cluster: String, val wallet: String) {
    fun validate() = WorkshopIdentity(origin, cluster, wallet).validate()
}
@Serializable data class BoundCosmeticInput(val itemId: String, val quantity: String)
@Serializable data class BoundCosmeticFacility(val type: String, val level: Long)
@Serializable data class BoundCosmeticRecipe(val recipeId: String, val recipeVersion: Long, val outputId: String,
    val quantity: String, val durationSec: Long, val inputs: List<BoundCosmeticInput>,
    val requiredFacility: BoundCosmeticFacility, val blueprintId: String) {
    /** Shape/identity validation only, never a native recipe/pricing authority. */
    fun validate() {
        require(outputId in cosmeticOutputs && recipeId == "craft_${outputId}_v1" && recipeVersion == 1L)
        require(quantity == "1" && blueprintId == cosmeticBlueprint); count(durationSec, true)
        require(inputs.isNotEmpty() && inputs.map { it.itemId }.distinct().size == inputs.size)
        inputs.forEach { require(it.itemId in refinedIds); quantity(it.quantity, true) }
        require(requiredFacility.type == if (outputId == "aurora_wake") "lodge" else "market"); count(requiredFacility.level, true)
    }
    companion object { fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() } }
}
@Serializable data class BoundCosmeticAppearance(val version: Int, val outputId: String, val sourceId: String,
    val sourceManifestSha256: String, val sourceIndexSha256: String, val bindingSha256: String) {
    fun validate() {
        require(version == 1 && outputId in cosmeticOutputs)
        require(sourceId == if (outputId == "aurora_wake") "auroraWake" else "artisan-market-t${outputId.last()}")
        listOf(sourceManifestSha256, sourceIndexSha256, bindingSha256).forEach(::cosmeticHash)
    }
    companion object { fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() } }
}
@Serializable data class BoundCosmeticRequest(val idempotencyKey: String, val baseId: String, val recipeId: String,
    val recipeVersion: Long, val appearanceBindingSha256: String) {
    fun validate() { uuid(idempotencyKey); uuid(baseId); require(recipeId in awningRecipes + "craft_aurora_wake_v1"); count(recipeVersion, true); cosmeticHash(appearanceBindingSha256) }
    fun body(): JsonObject = cosmeticJson.encodeToJsonElement(serializer(), this).jsonObject.also { validate() }
    companion object { fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() } }
}
@Serializable data class BoundCosmeticBlueprint(val blueprintId: String, val jobId: String, val baseId: String,
    val actorWallet: String, val completedAt: String) {
    fun validate() { require(blueprintId == cosmeticBlueprint); uuid(jobId); uuid(baseId); wallet(actorWallet); timestamp(completedAt) }
}
/** Closed command families; never serialized into the existing journal wire. */
enum class BoundCosmeticMode { AWNING, WAKE }
@Serializable data class BoundCosmeticCommand(val request: BoundCosmeticRequest, val recipe: BoundCosmeticRecipe,
    val appearance: BoundCosmeticAppearance) {
    val key get() = request.idempotencyKey
    val receiptPath get() = "/bound-cosmetics/jobs/by-key/$key"
    fun validate(mode: BoundCosmeticMode = BoundCosmeticMode.AWNING) {
        request.validate(); recipe.validate(); appearance.validate()
        require((recipe.outputId == "aurora_wake") == (mode == BoundCosmeticMode.WAKE))
        require(request.recipeId == recipe.recipeId && request.recipeVersion == recipe.recipeVersion && recipe.outputId == appearance.outputId
            && request.appearanceBindingSha256 == appearance.bindingSha256)
    }
    companion object { fun from(raw: JsonObject, mode: BoundCosmeticMode = BoundCosmeticMode.AWNING) = cosmeticDecode(raw, serializer()).also { it.validate(mode) } }
}
@Serializable data class BoundCosmeticReceipt(val wallet: String, val jobId: String, val request: BoundCosmeticRequest,
    val recipe: BoundCosmeticRecipe, val appearance: BoundCosmeticAppearance, val blueprint: BoundCosmeticBlueprint,
    val startedAt: String, val readyAt: String) {
    fun validate() {
        wallet(wallet); uuid(jobId); request.validate(); recipe.validate(); appearance.validate(); blueprint.validate()
        require(jobId == request.idempotencyKey && wallet == blueprint.actorWallet)
        require(recipe.recipeId == request.recipeId && recipe.recipeVersion == request.recipeVersion && recipe.outputId == appearance.outputId
            && recipe.blueprintId == blueprint.blueprintId && appearance.bindingSha256 == request.appearanceBindingSha256)
        require(timestamp(readyAt) == timestamp(startedAt).plusSeconds(recipe.durationSec) && timestamp(blueprint.completedAt) <= timestamp(startedAt))
    }
}
@Serializable data class BoundCosmeticCompletion(val completedAt: String)
@Serializable data class BoundCosmeticProof(val version: Int, val wallet: String, val idempotencyKey: String,
    val serverNow: String, val status: String, val receipt: BoundCosmeticReceipt?, val completion: BoundCosmeticCompletion?) {
    fun validate() {
        require(version == 1); wallet(wallet); uuid(idempotencyKey); val now = timestamp(serverNow)
        if (status == "unknown") { require(receipt == null && completion == null); return }
        require(status == "accepted"); val original = requireNotNull(receipt); original.validate()
        require(wallet == original.wallet && idempotencyKey == original.jobId && timestamp(original.startedAt) <= now)
        completion?.let { require(timestamp(it.completedAt) in timestamp(original.readyAt)..now) }
    }
    fun match(identity: BoundCosmeticIdentity, command: BoundCosmeticCommand, mode: BoundCosmeticMode = BoundCosmeticMode.AWNING) {
        validate(); identity.validate(); command.validate(mode); require(wallet == identity.wallet && idempotencyKey == command.key)
        receipt?.let { require(it.request == command.request && it.recipe == command.recipe && it.appearance == command.appearance) }
    }
    companion object {
        fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() }
        fun from(raw: JsonObject, identity: BoundCosmeticIdentity, command: BoundCosmeticCommand, mode: BoundCosmeticMode = BoundCosmeticMode.AWNING) = from(raw).also { it.match(identity, command, mode) }
    }
}

@Serializable data class BoundCosmeticAwning(val buildingId: String, val appearance: BoundCosmeticAppearance)
@Serializable data class BoundCosmeticBaseVisual(val version: Int, val marketAwnings: List<BoundCosmeticAwning>) {
    fun validate() { require(version == 1 && marketAwnings.map { it.buildingId }.distinct().size == marketAwnings.size)
        marketAwnings.forEach { uuid(it.buildingId); it.appearance.validate(); require(it.appearance.outputId != "aurora_wake") } }
}
data class BoundCosmeticVisualBuilding(val id: String, val type: String, val level: Long, val underConstruction: Boolean)
@Serializable data class BoundCosmeticBaseRead(val state: String, val visual: BoundCosmeticBaseVisual?) {
    fun validate() { when (state) { "available" -> requireNotNull(visual).validate(); "unavailable" -> require(visual == null); else -> error("Unknown cosmetic projection") } }
    /** Caller supplies the canonical admitted catalogue tier mapping; this module has no tuning table. */
    fun match(buildings: List<BoundCosmeticVisualBuilding>, completedMarketOutput: (Long) -> String) {
        validate(); val rows = visual?.marketAwnings.orEmpty(); if (rows.isEmpty()) return
        require(buildings.map { it.id }.distinct().size == buildings.size)
        rows.forEach { row -> val building = buildings.single { it.id == row.buildingId }
            require(building.type == "market" && !building.underConstruction && row.appearance.outputId == completedMarketOutput(building.level)) }
    }
    companion object { fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() } }
}
@Serializable data class BoundCosmeticPreferenceRequest(val baseId: String, val enabled: Boolean, val expectedRevision: String) {
    fun validate() { uuid(baseId); require(quantity(expectedRevision) < Long.MAX_VALUE.toBigInteger()) }
    fun body(): JsonObject = cosmeticJson.encodeToJsonElement(serializer(), this).jsonObject.also { validate() }
    companion object { fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() } }
}
@Serializable data class BoundCosmeticPreferenceResponse(val baseId: String, val enabled: Boolean, val revision: String,
    val visual: BoundCosmeticBaseRead) {
    fun validate() { uuid(baseId); quantity(revision, true); visual.validate() }
    fun match(request: BoundCosmeticPreferenceRequest) { validate(); request.validate()
        require(baseId == request.baseId && enabled == request.enabled && quantity(revision) == quantity(request.expectedRevision) + java.math.BigInteger.ONE) }
    companion object { fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() } }
}
