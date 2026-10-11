package gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.live

import gg.pixelkingdomwars.nativeclient.model.Building
import gg.pixelkingdomwars.nativeclient.renderer.BaseScene
import gg.pixelkingdomwars.nativeclient.renderer.completedBerthAppearance
import gg.pixelkingdomwars.nativeclient.ui.sheets.buildings.buildingArtDrawable

internal val phaseEBuildingInfoTypes = setOf("lodge", "berth", "harvester", "workshop")

/** Bundled idle/intact stills of the SAME completed appearance selected by Home. The scene mapper owns tier and
 * realm validation; A1 owns Berth family selection. A portrait grants no activity, journey or asset admission.
 * A changed response strips service facts while its scene is preparing, so retained geometry cannot lend old art. */
internal fun phaseEBuildingInfoPortrait(baseId: String?, building: Building, scene: BaseScene?): String? {
    if (building.type !in phaseEBuildingInfoTypes || building.underConstruction || building.level <= 0) return null
    if (baseId == null || scene == null || scene.baseId != baseId || scene.services.phaseEArtEnabled != true) return null
    val rendered = scene.buildings.singleOrNull { it.id == building.id } ?: return null
    if (rendered.type != building.type || rendered.level != building.level || rendered.underConstruction) return null
    if (scene.jobs.any { it.buildingId == building.id && it.kind == "build" }) return null
    val service = rendered.service?.takeIf { it.facility == building.type } ?: return null
    val portrait = when (building.type) {
        "berth" -> completedBerthAppearance(rendered, scene.services)?.let { "ui:berth-${it.removeSuffix("-berth")}-intact" }
        "harvester" -> scene.visual?.realmId?.let { realm -> service.tier?.let { "ui:harv-$realm-t$it-idle" } }
        else -> service.tier?.let { "ui:${service.facility}-t$it-idle" }
    }
    return portrait?.takeIf { buildingArtDrawable(it) != null }
}
