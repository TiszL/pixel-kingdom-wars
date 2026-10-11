package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmProgramSource

/**
 * GROUND's programs (ground.js `programs()`, `tools/world-shaders-ground.json`): the five resolve bakes and the MAP and
 * TRUE display programs, from the pinned exported stages. The FAR chart (`rm-chart`) is the core's ([RealmChart]), drawn
 * under GROUND's passes by [GroundChartUnder]: one implementation, one program object (Gl3Core dedupes by name).
 */
object GroundPrograms {
    const val RAW = "rm-raw"
    const val DESPECKLE = "rm-despeckle"
    const val LEGALISE = "rm-legalise"
    const val PURE = "rm-pure"
    const val RECORD = "rm-record"
    const val MAP = "rm-map"
    /** Cinderfall's rm-map (ground.js:108 `gd.RM_LAVA`): the lava branch compiles only there. */
    const val MAP_LAVA = "rm-map+RM_LAVA"
    const val TRUE = "rm-true"
    /** The realm whose rm-map compiles the lava branch (ground.js `meta.id === 'cinderfall'`). */
    const val LAVA_REALM = "cinderfall"

    val BAKES = listOf(RAW, DESPECKLE, LEGALISE, PURE, RECORD)

    /** The exported key of this realm's rm-map, and whether the export carries it (the lava variant is pending NT). */
    fun mapKey(realmId: String, exported: Set<String> = WorldShaders.realm.keys): String =
        if (realmId == LAVA_REALM && MAP_LAVA in exported) MAP_LAVA else MAP

    /** The pinned sources of GROUND's programs for [realmId] (a worker: [WorldShaders.source] reads the APK). */
    fun load(realmId: String, read: (WorldShaders.Stage) -> String = WorldShaders::source): Map<String, RealmProgramSource> {
        val out = LinkedHashMap<String, RealmProgramSource>()
        for (key in BAKES + listOf(mapKey(realmId), TRUE)) {
            val p = WorldShaders.realm[key] ?: throw IllegalStateException("ground program $key is not exported")
            out[key] = RealmProgramSource(key, read(p.vs), read(p.fs), p.vs.sha256, p.fs.sha256)
        }
        return out
    }
}
