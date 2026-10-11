package gg.pixelkingdomwars.nativeclient.boundcosmetics

import gg.pixelkingdomwars.nativeclient.ordinarycrafting.OrdinaryProtectedStock
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.quantity
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.timestamp
import gg.pixelkingdomwars.nativeclient.ordinarycrafting.uuid
import gg.pixelkingdomwars.nativeclient.workshop.wallet
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*
import java.math.BigInteger

@Serializable data class BoundCosmeticWakePreferenceRequest(val enabled: Boolean, val expectedRevision: String) {
    fun validate() { require(quantity(expectedRevision) < Long.MAX_VALUE.toBigInteger()) }
    fun body(): JsonObject = cosmeticJson.encodeToJsonElement(serializer(), this).jsonObject.also { validate() }
    companion object { fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() } }
}
@Serializable data class BoundCosmeticWakePreferenceResponse(val enabled: Boolean, val revision: String,
    val visual: BoundCosmeticWakeRead) {
    fun validate() {
        quantity(revision, true); visual.validate()
        require(visual.state != "available" || (visual.visual!!.wake != null) == enabled)
    }
    fun match(request: BoundCosmeticWakePreferenceRequest) {
        validate(); request.validate()
        require(enabled == request.enabled && quantity(revision) == quantity(request.expectedRevision) + BigInteger.ONE)
    }
    companion object { fun from(raw: JsonObject) = cosmeticDecode(raw, serializer()).also { it.validate() } }
}
@Serializable data class BoundCosmeticWakePreferenceSnapshot(val enabled: Boolean, val revision: String,
    val visual: BoundCosmeticWakeRead) {
    fun validate() {
        quantity(revision); visual.validate(); require(revision != "0" || !enabled)
        require(visual.state != "available" || (visual.visual!!.wake != null) == enabled)
    }
}
sealed interface BoundCosmeticWakeSelectedBase {
    val baseId: String
    data class Unavailable(override val baseId: String, val reason: String) : BoundCosmeticWakeSelectedBase
    data class Available(override val baseId: String, val craftingStock: List<OrdinaryProtectedStock>,
        val workshops: List<BoundCosmeticCompletedFacility>, val lodges: List<BoundCosmeticCompletedFacility>,
        val queue: List<BoundCosmeticQueueJob>) : BoundCosmeticWakeSelectedBase
}
/** Strict sibling to the four-Awning view. Server readiness is not native art/application admission. */
data class BoundCosmeticWakeWorkshopView(val version: Int, val wallet: String, val serverNow: String,
    val applicationReady: Boolean, val acceptingJobs: Boolean, val blueprint: BoundCosmeticBlueprintEligibility,
    val recipe: BoundCosmeticCatalogueRow, val original: BoundCosmeticProof?,
    val preference: BoundCosmeticWakePreferenceSnapshot, val selectedBase: BoundCosmeticWakeSelectedBase?) {
    companion object {
        fun from(raw: JsonObject, wallet: String, baseId: String?, maxConcurrentPerBase: () -> Int): BoundCosmeticWakeWorkshopView {
            wallet(wallet); require(wallet != "1".repeat(32)); baseId?.let(::uuid)
            val owned = cosmeticJson.parseToJsonElement(raw.toString()).jsonObject
            val v = cosmeticObject(owned, "version", "wallet", "serverNow", "applicationReady", "acceptingJobs", "blueprint", "recipe", "original", "preference", "selectedBase")
            require(v["version"] == JsonPrimitive(1) && cosmeticText(v["wallet"]) == wallet)
            val nowText = cosmeticText(v["serverNow"]); val now = timestamp(nowText)
            val ready = cosmeticBoolean(v["applicationReady"]); val accepting = cosmeticBoolean(v["acceptingJobs"])
            require(!accepting || ready)
            val blueprint = cosmeticBlueprintEligibility(v["blueprint"], wallet, now)
            val recipe = cosmeticDecode(requireNotNull(v["recipe"]), BoundCosmeticCatalogueRow.serializer()).also {
                it.recipe.validate(); it.appearance.validate()
                require(it.recipe.outputId == "aurora_wake" && it.appearance.outputId == "aurora_wake")
            }
            val original = if (v["original"] == JsonNull) null else BoundCosmeticProof.from(requireNotNull(v["original"] as? JsonObject)).also {
                require(it.status == "accepted" && it.wallet == wallet && timestamp(it.serverNow) <= now && it.receipt!!.recipe.outputId == "aurora_wake")
            }
            val preference = cosmeticDecode(requireNotNull(v["preference"]), BoundCosmeticWakePreferenceSnapshot.serializer()).also { it.validate() }
            preference.visual.visual?.wake?.let { selected ->
                require(original?.completion != null && original.receipt!!.appearance == selected)
            }
            val base = if (v["selectedBase"] == JsonNull) null else {
                val b = requireNotNull(v["selectedBase"] as? JsonObject); val id = cosmeticText(b["baseId"]).also(::uuid)
                when (cosmeticText(b["state"])) {
                    "unavailable" -> {
                        cosmeticObject(b, "state", "baseId", "reason"); val reason = cosmeticText(b["reason"])
                        require(reason in setOf("BASE_NOT_OWNED", "BASE_ID_REQUIRED", "DEED_AUTHORITY_UNAVAILABLE", "DEED_OWNERSHIP_CHANGED"))
                        BoundCosmeticWakeSelectedBase.Unavailable(id, reason)
                    }
                    "available" -> {
                        cosmeticObject(b, "state", "baseId", "craftingStock", "workshops", "lodges", "queue")
                        val stock = cosmeticWorkshopStock(b["craftingStock"])
                        val workshops = cosmeticFacilities(b["workshops"], now); val lodges = cosmeticFacilities(b["lodges"], now)
                        val facilities = workshops + lodges; require(facilities.map { it.buildingId }.distinct().size == facilities.size)
                        val queue = cosmeticArray(b["queue"]).map { cosmeticQueue(it.jsonObject).also { row ->
                            require(timestamp(row.startedAt) <= now && timestamp(row.readyAt) > now)
                        } }
                        // Account-only preference/recovery does not depend on a loaded kingdom catalogue.
                        val limit = maxConcurrentPerBase(); require(limit > 0)
                        require(queue.size <= limit && queue.map { it.jobId }.distinct().size == queue.size)
                        BoundCosmeticWakeSelectedBase.Available(id, stock, workshops, lodges, queue)
                    }
                    else -> error("Unknown selected kingdom state")
                }
            }
            require(base?.baseId == baseId) { "Workshop snapshot belongs to another selected kingdom" }
            return BoundCosmeticWakeWorkshopView(1, wallet, nowText, ready, accepting, blueprint, recipe, original, preference, base)
        }
    }
}
