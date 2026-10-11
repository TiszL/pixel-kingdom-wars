package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.GlobeArt
import kotlin.math.cos

/** What a tap on the flat globe picked (plan §7 "globe realm/island/chain pick, never a tile"). */
sealed interface GlobePickV2 {
    /** Off the sphere. */
    data object Space : GlobePickV2
    /** On the sphere, on nothing selectable (sea, or an exploration cell whose precise art says sea). */
    data class Nothing(val lon: Double, val lat: Double) : GlobePickV2
    /** A realm's visible land: [index] in REALMS order, [id] the server realm id. */
    data class Realm(val index: Int, val id: String, val lon: Double, val lat: Double, val deedEligible: Boolean) : GlobePickV2
    /** An exploration chain (far zoom) or one of its islands (close zoom, a land texel of its precise art). */
    data class Exploration(val chain: Int, val island: Int?, val lon: Double, val lat: Double) : GlobePickV2
    /** A Phase E island (only when that layer is on, RG-3). */
    data class PhaseE(val id: String, val lon: Double, val lat: Double) : GlobePickV2
}

/**
 * Tap picking on the flat globe (GLOBE-NATIVE-PLAN §3.2 GlobePicking): the concept's rule for realms (main.js tap: a
 * realm on visible land, else deselect) and the legacy native rule for the 32 exploration islands, unchanged (RG-1
 * "picking unchanged": FantasyGlobeRenderer's footprint test, `GlobeArt.islandAt`, and the precise mask's land texel).
 * [footprint] is screen px per geography px at the tapped point.
 */
class GlobePicking(private val geography: GlobeGeography, private val realmIds: List<String>, private val art: GlobeArt?,
                   private val chainLand: Array<java.util.BitSet>?, private val surfaceDeed: BooleanArray? = null) {
    /** The Phase E layer is live: its islands are picked first, by their D-165 tap ellipses (main.js tap). */
    var phaseE = false

    /** The Phase E island whose tap ellipse holds (lon, lat), or null (always null while the layer is off). */
    fun phaseEAt(lon: Double, lat: Double): String? {
        if (!phaseE) return null
        for (k in GlobeV2Pin.PHASE_E.indices) { // by index: no iterator (the zoom-floor hint may ask in a frame)
            val i = GlobeV2Pin.PHASE_E[k]
            val dx = (((lon - i.lon + 540) % 360) - 180) * cos(i.lat * V.RAD); val dy = lat - i.lat
            if ((dx / i.rx) * (dx / i.rx) + (dy / i.ry) * (dy / i.ry) < 1) return i.id
        }
        return null
    }

    fun pick(lon: Double, lat: Double, footprint: Double): GlobePickV2 {
        phaseEAt(lon, lat)?.let { return GlobePickV2.PhaseE(it, lon, lat) }
        val a = art
        if (a != null && footprint > LEGACY_ISLAND_FOOTPRINT) {
            val hit = a.islandAt(lon, lat)
            if (hit != null) {
                val land = chainLand?.getOrNull(hit.island.chain) ?: return GlobePickV2.Exploration(hit.island.chain, null, lon, lat)
                return if (land.get(hit.y * a.atlas + hit.x)) GlobePickV2.Exploration(hit.island.chain, hit.island.slot, lon, lat)
                else GlobePickV2.Nothing(lon, lat)
            }
        }
        val i = geography.index(lon, lat)
        val chain = geography.explore[i].toInt() and 0xFF
        if ((footprint > LEGACY_ISLAND_FOOTPRINT && chain > 0) || !geography.land[i]) return GlobePickV2.Nothing(lon, lat)
        if (chain > 0) return GlobePickV2.Exploration(chain - 1, null, lon, lat)
        val r = geography.region[i].toInt()
        if (r !in realmIds.indices) return GlobePickV2.Nothing(lon, lat)
        return GlobePickV2.Realm(r, realmIds[r], lon, lat, surfaceDeed?.get(i) ?: false)
    }

    companion object {
        /** FantasyGlobeRenderer: exploration islands are drawn and picked by their art above 1.5 screen px per
         *  geography px; below it the chain is picked by its cells. Native's own rule (RG-1), not a web number. */
        const val LEGACY_ISLAND_FOOTPRINT = 1.5
    }
}
