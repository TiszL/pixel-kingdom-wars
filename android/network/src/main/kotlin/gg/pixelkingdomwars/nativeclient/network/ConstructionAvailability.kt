package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import java.util.concurrent.CancellationException

/** Existing tray order is presentation only; every price, gate and cap stays in the generated catalogue. */
val ordinaryBuildingChoices = listOf("mine", "vault", "barracks", "forge", "camp", "clanhall", "goldforge")
val defenceBuildingChoices = listOf("cannon", "archertower", "mortar", "airdefence", "spiketrap", "powdermine", "pitfall", "airmine", "wall", "electrictower", "magetower", "lasertower", "dragonnest")

private fun legacyConstruction(type: String) = type in ordinaryBuildingChoices || type in defenceBuildingChoices || type in setOf("keep", "heroaltar", "siegestool")
private fun JsonElement?.whole(): Long? = (this as? JsonPrimitive)?.contentOrNull
    ?.takeIf { it.matches(Regex("0|[1-9][0-9]*")) }?.toLongOrNull()
/** Caps, Keep gates, maximum levels and footprints are read as Int by BaseCatalogue/BuildMenu. */
private fun JsonElement?.wholeInt(): Int? = whole()?.takeIf { it <= Int.MAX_VALUE }?.toInt()
private fun JsonElement?.text(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content
private fun JsonElement?.types(): List<String>? {
    val values = this as? JsonArray ?: return null
    val types = values.map { value -> (value as? JsonPrimitive)?.takeIf { it.isString }?.content
        ?.takeIf { it.matches(Regex("[a-z]+")) } ?: return null }
    return types.takeIf { it.distinct().size == it.size }
}

/** App-owned renderer/residency admission. The network module never parses a renderer graph.
 * Implementations bind these exact content objects, current permission, and verified resident group descriptors. */
data class PhaseEConstructionArtRequest(val base: JsonObject, val catalogue: JsonObject,
    val renderCatalogue: JsonObject, val entry: JsonObject, val type: String, val level: Int,
    val buildingId: String?)
fun interface PhaseEConstructionArt { fun isAvailable(request: PhaseEConstructionArtRequest): Boolean }

/** Additive discovery, not mutation authority. Both inputs are the currently admitted content generation.
 * A server flag alone cannot offer an unrenderable building; an old pack never guesses a Phase E list.
 * Missing, malformed or future feature versions close new starts without filtering existing base state. */
fun phaseEConstructionChoices(base: JsonObject?, catalogue: JsonObject?, renderCatalogue: JsonObject?, level: Int = 1,
    art: PhaseEConstructionArt? = null): List<String> = phaseEChoices(base, catalogue, renderCatalogue, level, art, null)

private fun phaseEChoices(base: JsonObject?, catalogue: JsonObject?, renderCatalogue: JsonObject?, level: Int,
    art: PhaseEConstructionArt?, buildingId: String?): List<String> {
    if (level <= 0 || base == null || catalogue == null || renderCatalogue == null || art == null) return emptyList()
    val constants = catalogue?.get("constants") as? JsonObject ?: return emptyList()
    val declared = ((constants["PHASE_E_BUILDINGS"] as? JsonObject)?.get("types")).types()
        ?.takeIf { it.isNotEmpty() && it.none(::legacyConstruction) } ?: return emptyList()
    val feature = (base?.get("features") as? JsonObject)?.get("phaseEBuildings") as? JsonObject ?: return emptyList()
    val version = feature["version"] as? JsonPrimitive ?: return emptyList()
    if (version.isString || version.content != "1") return emptyList()
    val enabled = feature["enabledTypes"].types()?.takeIf { it.all { type -> type in declared } } ?: return emptyList()
    val entries = (renderCatalogue?.get("entries") as? JsonArray)?.mapNotNull { it as? JsonObject } ?: return emptyList()
    return declared.filter { type ->
        if (type !in enabled) return@filter false
        val cost = (constants["BUILD_COSTS"] as? JsonObject)?.get(type) as? JsonObject ?: return@filter false
        val structure = (constants["STRUCTURES"] as? JsonObject)?.get(type) as? JsonObject ?: return@filter false
        val caps = (constants["BUILD_COUNT_CAP_BY_KEEP"] as? JsonObject)?.get(type) as? JsonArray ?: return@filter false
        val footprint = structure["footprint"] as? JsonArray ?: return@filter false
        if (cost["costShards"].whole() == null || (cost["buildSec"].whole() ?: 0) <= 0 ||
            (cost["requiresKeepLevel"].wholeInt() ?: 0) <= 0 || (structure["maxLevel"].wholeInt() ?: 0) < level ||
            (structure["hp"].whole() ?: 0) <= 0 || caps.isEmpty() || caps.any { it.wholeInt() == null } ||
            footprint.size != 2 || footprint.any { (it.wholeInt() ?: 0) <= 0 }) return@filter false
        // Match SceneMapper's exact type/level lookup. Duplicate entries are ambiguous; absent art has no fallback.
        val entry = entries.singleOrNull { it["type"].text() == type && it["level"].wholeInt() == level } ?: return@filter false
        if (entry["phaseE"] !is JsonObject || listOf("frameKey", "atlasPath", "motion").any(entry::containsKey) ||
            entry["footprintWidth"].wholeInt() != footprint[0].wholeInt() ||
            entry["footprintHeight"].wholeInt() != footprint[1].wholeInt()) return@filter false
        try { art.isAvailable(PhaseEConstructionArtRequest(base, catalogue, renderCatalogue, entry, type, level, buildingId)) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (_: RuntimeException) { false }
    }
}

/** Legacy starts retain their existing flow. Unknown additive types cannot bypass discovery through a stale tap. */
fun constructionStartAvailable(base: JsonObject?, catalogue: JsonObject?, renderCatalogue: JsonObject?, type: String, level: Int = 1,
    art: PhaseEConstructionArt? = null, buildingId: String? = null): Boolean =
    legacyConstruction(type) || type in phaseEChoices(base, catalogue, renderCatalogue, level, art, buildingId)
