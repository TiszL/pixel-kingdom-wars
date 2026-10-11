package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundStats

/**
 * A lock-screen resume's landing (owner, Seeker code 31: "Same map, same spot"; 2026-09-26: no grey hard-edged squares,
 * smoothness first). The app's new host lands the old camera, usually at MAP or TRUE, right after the entry, before any
 * lane is in: until GROUND draws there, the core's chart stands in, other realms' deeds veiled per deed (hard-edged grey
 * squares at MAP scale), and MAP then pops in over it sub-tile by sub-tile. The host keeps the landing under its clouds
 * until [landed] (WorldEngineHost.landingStep), bounded by the dive's stall rule over [progress]. GL thread, no allocation.
 */
object RealmResumeLanding {
    /**
     * The frame just drawn shows the resumed band's own ground: [band] and [pass] as the frame left them
     * ([RealmMapStats.band], [RealmMapStats.groundPass]), [ground] the GROUND lane's stats (null: the realm has no detail
     * pack, or GROUND is disabled: the chart is all it will draw). FAR is the core's chart itself. From FAR→MAP on, the
     * lane drew the ground (not the core's lone chart: a lane draws only with its MAP data in and its pairs rehearsed)
     * over a resolved lattice (the chart shows through every unresolved sub-tile); from MAP→TRUE on, with TRUE in and
     * every page of the view, when the realm has TRUE ground (else MAP is its picture there). A failed GROUND has nothing
     * better coming.
     */
    fun landed(band: Int, pass: Int, ground: GroundStats?): Boolean {
        if (band == RealmBand.FAR || ground == null || ground.status == "failed") return true
        if (pass == RealmEngineConfig.PASS_CHART || ground.latticeMissingInView > 0) return false
        return band < RealmBand.MAP_TRUE || !ground.hasTrue || (ground.trueReady && ground.pagesMissingInView == 0)
    }

    /** What a landing waits on, as one number that changes with every step (the host's stall rule reads a change as
     *  progress): lanes opened and lane pairs rehearsed, GROUND's load and data stages, the lattice sub-tiles and TRUE
     *  pages it resolved. */
    fun progress(st: RealmMapStats, ground: GroundStats?): Double {
        var p = (Integer.bitCount(st.lanesOpened) + st.lanePairsRehearsed).toDouble()
        if (ground != null) {
            if (ground.status == "ready") p++
            if (ground.mapReady) p++
            if (ground.trueReady) p++
            p += ground.latticeResolved + ground.pagesResolved
        }
        return p
    }
}
