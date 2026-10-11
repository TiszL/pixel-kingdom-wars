package gg.pixelkingdomwars.nativeclient.data

import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.model.AdvancedServicePresentation
import gg.pixelkingdomwars.nativeclient.model.BaseServicePresentation
import gg.pixelkingdomwars.nativeclient.model.VisualContext
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArtRequest
import gg.pixelkingdomwars.nativeclient.renderer.PhaseEServiceArt
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAppearance
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAtlasGroup
import gg.pixelkingdomwars.nativeclient.renderer.resolveServicePlan
import kotlinx.serialization.json.*
import java.util.concurrent.CancellationException

/** Supplied by the content owner after actual hash/size verification, never by manifest membership alone.
 * isCurrent includes current account/base/content ownership AND the current Phase E art permission.
 * contains compares the full descriptor (paths, hashes, sizes), backed by still-owned verified resident files.
 * Neither method may fetch, decode textures, open files, or block from a UI admission read. */
interface PhaseEConstructionResidency {
    fun isCurrent(): Boolean
    fun contains(group: ServiceAtlasGroup): Boolean
}

/** Prepare once on the existing content worker. Reuse the renderer's complete accepted parser, not a
 * second interpretation of phaseE.metadata. A new generation needs a new callback; a retired proof
 * cannot authorize either a visible affordance or dispatch. This function performs no IO or mutation.
 * No caller is wired here: the owning IW2/IW4 integration must supply actual residency + permission. */
fun preparePhaseEConstructionArt(catalogue: JsonObject, renderCatalogue: JsonObject,
    residency: PhaseEConstructionResidency): PhaseEConstructionArt? {
    val art = try { RendererCatalogue.serviceArt(JsonReader().parse(renderCatalogue.toString())) ?: return null }
    catch (cancelled: CancellationException) { throw cancelled }
    catch (_: RuntimeException) { return null }
    return PhaseEConstructionArt { request ->
        if (request.catalogue !== catalogue || request.renderCatalogue !== renderCatalogue || !residency.isCurrent()) false
        else {
            val appearance = constructionAppearance(request, art)
            // Include every authored state and its cross-group references (e.g. rubble/craft-success),
            // not merely an idle body that would turn a missing later state into a fallback.
            val groups = appearance.states.keys.flatMap { state ->
                requireNotNull(resolveServicePlan(art, appearance, state, reducedMotion = false)).groups
            }.toSet()
            groups.isNotEmpty() && groups.all { residency.contains(art.groups.getValue(it)) } && residency.isCurrent()
        }
    }
}

/** Pure selected-appearance seam. Throws on malformed input; the network gate contains ordinary
 * refusals and propagates cancellation. No atlas frame, realm, tier or installation is invented. */
internal fun constructionAppearance(request: PhaseEConstructionArtRequest, art: PhaseEServiceArt): ServiceAppearance {
    val row = request.entry
    require(row["type"].strictText() == request.type && row["level"].positiveInt() == request.level)
    val identity = PhaseEServiceArt.entry(JsonReader().parse(row.toString()))
    val constants = requireNotNull(request.catalogue["constants"] as? JsonObject)
    val structure = requireNotNull((constants["STRUCTURES"] as? JsonObject)?.get(request.type) as? JsonObject)
    require(request.level <= structure["maxLevel"].positiveInt())
    val footprint = requireNotNull(structure["footprint"] as? JsonArray)
    require(footprint.size == 2 && footprint.all { it.positiveInt() == 2 })
    if (identity.facility != "berth") {
        val mapping = requireNotNull(constants["ART_V2"] as? JsonObject)
        val tiers = mapping["tiers"].positiveInt()
        val levelsPerTier = mapping["levelsPerTier"].positiveInt()
        require(identity.tier == minOf(tiers, (request.level - 1) / levelsPerTier + 1))
    }
    request.buildingId?.let { id ->
        val buildings = requireNotNull(request.base["buildings"] as? JsonArray).map { requireNotNull(it as? JsonObject) }
        val selected = requireNotNull(buildings.singleOrNull { it["id"].strictText() == id })
        require(selected["type"].strictText() == request.type)
        val level = selected["level"].positiveInt()
        require(level < Int.MAX_VALUE && request.level == level + 1)
        require(selected["underConstruction"] == null || selected["underConstruction"] == JsonPrimitive(false))
    }
    val id = when (identity.facility) {
        "harvester" -> {
            val raw = requireNotNull(request.base["visualContext"] as? JsonObject)
            require(raw["version"] == JsonPrimitive(1))
            raw["realmId"].strictText(); raw["artVersion"].positiveInt()
            val visual = requireNotNull(VisualContext.of(request.base))
            "harvester-${visual.realmId}-t${identity.tier}"
        }
        "berth" -> "${berthFamily(request)}-berth"
        else -> "${identity.facility}-t${identity.tier}"
    }
    val appearance = requireNotNull(art.appearances[id])
    require(appearance.facility == identity.facility && appearance.tier == identity.tier)
    return appearance
}

private fun berthFamily(request: PhaseEConstructionArtRequest): String {
    val id = request.buildingId
    if (id == null) {
        require(request.level == 1) { "A berth upgrade requires the selected building identity" }
        return "starter" // Explicit new-placement appearance; this claims no installed vehicle.
    }
    val buildings = requireNotNull(request.base["buildings"] as? JsonArray)
    // Both current projections must have valid full identity closure. An absent or malformed
    // advanced projection cannot be reinterpreted as an empty berth or a starter installation.
    val starter = BaseServicePresentation.from(requireNotNull(request.base["servicePresentation"]), buildings)
        .berths.single { it.buildingId == id }.installation
    val advanced = requireNotNull(AdvancedServicePresentation.optionalCurrent(request.base["advancedServicePresentation"], request.base))
        .berths.single { it.buildingId == id }.installation
    require(starter == null || advanced == null) { "Contradictory berth installations" }
    return when {
        advanced != null -> advanced.family.replace('_', '-') // Accepted wire family -> renderer key, as the fleet renderer.
        starter != null -> starter.family
        else -> "starter" // Both validated projections explicitly name an empty selected berth.
    }
}

private fun JsonElement?.strictText(): String = requireNotNull((this as? JsonPrimitive)?.takeIf { it.isString }?.content)
private fun JsonElement?.positiveInt(): Int = requireNotNull((this as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull)
    .also { require(it > 0) }
