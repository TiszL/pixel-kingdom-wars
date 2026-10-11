package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** The selected deed's raid lock (shared `raidEvents.ts` `ActiveBaseRaid`): `GET /bases/:id/active-raid`
 * and every `snapshot` frame of `GET /bases/:id/raid-events`. A reconnect always begins with a full snapshot. */
@Serializable data class ActiveBaseRaid(val raidId: String, val state: String) {
    companion object {
        val STATES = setOf("reserved", "live", "releasing")
    }
}

/** `GET /map/scout/:target?baseId=` (web map.tsx `runScout`): the target's layout IS the read-only snapshot the
 * scout scene renders, and the HUD reads its name, keep level, trophies and the SERVER's preview window. */
data class ScoutReport(val name: String, val keepLevel: Int, val trophies: String, val previewSec: Int, val head: PresentationHead) {
    companion object {
        fun from(raw: JsonObject): ScoutReport {
            fun text(key: String) = (raw[key] as? JsonPrimitive)?.contentOrNull
            val previewSec = requireNotNull(text("previewSec")?.toIntOrNull()?.takeIf { it > 0 }) { "Scout report has no preview window" }
            return ScoutReport(text("name").orEmpty(), requireNotNull(text("keepLevel")?.toIntOrNull()) { "Scout report has no keep level" },
                text("trophies")?.takeIf { it.matches(Regex("-?[0-9]+")) } ?: "0", previewSec, PresentationHead.from(raw))
        }
    }
}
