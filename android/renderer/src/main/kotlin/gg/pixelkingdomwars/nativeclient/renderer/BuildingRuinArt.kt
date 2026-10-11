package gg.pixelkingdomwars.nativeclient.renderer

/** Rest cells for buildings whose authored `collapse` clip has no ruin. Mirrors the web
 * `apps/web/src/game/ware/ruin.ts` + the `hold` contract in `apps/web/src/game/v2/ticker.ts`.
 *
 * Owner 2026-09-17: "camp destroyed state looks awful, on both web and android". The camp
 * pack's collapse is a five-frame SINK whose final cell is a 12-px sliver of dirt; every
 * other M22 building authors real rubble as its last collapse frame, so only the camp rests
 * on a generated cell. The PNG ships in the renderer's own classpath (like ui/counter-vt323),
 * never in the synced pack, and shares the pack cell (104×96, anchor [52,80]) so the
 * building seat computed from the collapse frame stays valid. */
object BuildingRuinArt {
    const val CAMP = "ruin/ware_ruin_camp.png"

    /** Classpath path of the rest cell, or null to hold the authored final frame. */
    fun forBuilding(type: String?, frameKey: String): String? =
        if (type == "camp" || (type == null && frameKey.startsWith("bld_camp_"))) CAMP else null
}
