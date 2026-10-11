package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArt
import gg.pixelkingdomwars.nativeclient.network.PhaseEConstructionArtRequest
import gg.pixelkingdomwars.nativeclient.network.constructionStartAvailable
import gg.pixelkingdomwars.nativeclient.network.phaseEConstructionChoices
import kotlinx.serialization.json.*
import java.util.Collections

/** Bounded metadata demand for the existing residency owner, never construction permission.
 * Reuses IW3's exact catalogue/feature/row checks. The collector ALWAYS refuses admission;
 * only the provider's later verified leases can make a real action available. Keep this demand
 * bound to pre-art base/content/local state, never feed constructionArt-backed UI state into it. */
internal fun phaseEConstructionRequests(base: JsonObject?, catalogue: JsonObject?, render: JsonObject?,
    selectedBuildingId: String?): List<PhaseEConstructionArtRequest> {
    if (base == null || catalogue == null || render == null) return emptyList()
    val requests = mutableListOf<PhaseEConstructionArtRequest>()
    phaseEConstructionChoices(base,catalogue,render,level=1,art=PhaseEConstructionArt { request ->
        requests += request
        false
    })
    if (selectedBuildingId != null) {
        val buildings = (base["buildings"] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()
        val selected = buildings.singleOrNull { (it["id"] as? JsonPrimitive)?.takeIf { id -> id.isString }?.content == selectedBuildingId }
        val type = (selected?.get("type") as? JsonPrimitive)?.takeIf { it.isString }?.content
        val level = (selected?.get("level") as? JsonPrimitive)?.takeUnless { it.isString }?.intOrNull
        val construction = selected?.get("underConstruction")
        if (type != null && level != null && level > 0 && level < Int.MAX_VALUE &&
            (construction == null || construction == JsonPrimitive(false))) {
            constructionStartAvailable(base,catalogue,render,type,level+1,
                art=PhaseEConstructionArt { request ->
                    if (request.type == type && request.buildingId == selectedBuildingId) requests += request
                    false
                }, buildingId=selectedBuildingId)
        }
    }
    return Collections.unmodifiableList(requests)
}
