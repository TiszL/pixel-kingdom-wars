package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.fleetjourney.FleetJourneyEvent
import gg.pixelkingdomwars.nativeclient.fleetjourney.fleetJourneyEventKey
import gg.pixelkingdomwars.nativeclient.renderer.RenderFleetJourney
import gg.pixelkingdomwars.nativeclient.renderer.RenderJourneyKind
import gg.pixelkingdomwars.nativeclient.renderer.RenderJourneyVehicle
import gg.pixelkingdomwars.nativeclient.renderer.RenderJourneyWake

/** N-C5 app bridge: root's strict, already-validated network event becomes the renderer's
 *  minimal typed presentation. No field is invented or reinterpreted; the ORIGINAL frozen Wake
 *  capture keeps legacy / Off / unavailable / available distinct. The renderer module never
 *  imports the network module. */
fun renderFleetJourney(event: FleetJourneyEvent): RenderFleetJourney {
    event.validate()
    val kind = when (event.kind) {
        "departure" -> RenderJourneyKind.DEPARTURE
        "return" -> RenderJourneyKind.RETURN
        else -> error("Unknown journey kind")
    }
    val wake = when (event.wake.state) {
        "legacy" -> RenderJourneyWake.Legacy
        "unavailable" -> RenderJourneyWake.Unavailable
        "available" -> event.wake.visual?.wake?.let { appearance ->
            RenderJourneyWake.Available(appearance.outputId, appearance.bindingSha256, appearance.sourceManifestSha256, appearance.sourceIndexSha256)
        } ?: RenderJourneyWake.Off
        else -> error("Unknown wake capture state")
    }
    return RenderFleetJourney(fleetJourneyEventKey(event), kind, event.baseId, event.berthId, event.installationId,
        RenderJourneyVehicle(event.vehicle.family, event.vehicle.tier), wake)
}
