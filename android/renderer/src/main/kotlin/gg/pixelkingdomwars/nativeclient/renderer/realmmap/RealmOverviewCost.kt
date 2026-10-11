package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.world.FrameCost
import gg.pixelkingdomwars.nativeclient.renderer.world.GpuCalibration
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderKnobs
import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameCost

/**
 * The core's realm frame in the whole-frame model (GLOBE-NATIVE-PLAN §5.2): the passes [RealmMapEngine] itself issues,
 * priced by [WorldFrameCost]; the N3 lanes add theirs ([lanes]). Fetch counts are read off the pinned stages; every
 * fetch of a mipped sampler is counted trilinear (conservative). ALU is unmodelled until the malioc report (reported,
 * never zero).
 *
 * - `rm-chart` (the FAR ground, [RealmChart]): `groundcost.js PASS.chart` = 4 per fragment (chart8 mipped, chart16 when
 *   pages are on, `coastAt`'s fieldsA, `rmKeep`'s far field), at the ground scale k. The deeds `texelFetch` went with the
 *   other-realm veil at pin 02e9da84 (owner 2026-09-26: no grey on other realms' land at any zoom).
 * - `rm-lowres-blit`: 1 bilinear fetch, on the screen, only when the ground scale k < 1.
 * - `minimap-dots` on the main view (the occupancy dots, until a bases lane draws them): 6 vertices per base.
 * - `minimap`: `uFar`, chart8 → 2 fetches over the minimap rect (its `uDeeds` read went with the veil at 02e9da84); its
 *   dots 6 vertices per point.
 * - `world-fade`: 1 `texelFetch` over the screen, only in a dive/leave fade, on top of the live globe pass.
 */
object RealmOverviewCost {
    /** `groundcost.js PASS.chart` at the pin (checked against the golden contracts by the tests). */
    const val OVERVIEW_FETCHES = 4.0
    const val BLIT_FETCHES = 1.0
    const val MINIMAP_FETCHES = 2.0
    const val FADE_FETCHES = 1.0

    /** Which frame is priced. */
    enum class Phase {
        /** The live realm frame. */
        LIVE,
        /** The one-off snapshot frame at the dive's arrival: the realm offscreen, then the globe and the composite. */
        SNAPSHOT,
        /** A fade frame: the live globe plus the composite (the realm snapshot is not redrawn). */
        FADE,
    }

    /**
     * The passes of one frame. [k] is the ground scale the engine draws at ([RealmEngineConfig.groundDiv]),
     * [minimapShare] the minimap rect's share of the buffer (0 when collapsed), [points] the base points (the minimap's,
     * and the main view's occupancy dots when [occupancyDots]), [lanes] the detail lanes' own passes of this frame (their
     * ground replaces the chart when [laneGround]), and [globe] the globe's own pass for [Phase.SNAPSHOT] and [Phase.FADE].
     */
    fun passes(phase: Phase, k: Double, minimapShare: Double, points: Int, globe: List<PassCost>, bufferPx: Long,
               occupancyDots: Boolean = true, lanes: List<PassCost> = emptyList(), laneGround: Boolean = false): List<PassCost> = buildList {
        if (phase != Phase.FADE) {
            if (!laneGround) add(PassCost("rm-chart", onGround = true, coverage = 1.0, fetchesPerFragment = OVERVIEW_FETCHES, trilinear = true))
            if (k < 0.999) add(PassCost("lowres-blit", coverage = 1.0, fetchesPerFragment = BLIT_FETCHES))
            addAll(lanes)
            if (occupancyDots) add(PassCost("occupancy-dots", vertices = 6L * points, vsCyclesPerVertex = Double.NaN))
            if (minimapShare > 0) {
                add(PassCost("minimap", coverage = minimapShare, fetchesPerFragment = MINIMAP_FETCHES, trilinear = true))
                add(PassCost("minimap-dots", vertices = 6L * points, vsCyclesPerVertex = Double.NaN))
            }
        }
        if (phase == Phase.SNAPSHOT) {
            // the realm is drawn into the RGBA8 snapshot once: its tile writeback, on top of the screen's own
            add(PassCost("snapshot store", extraBytes = bufferPx * 4))
        }
        if (phase != Phase.LIVE) {
            addAll(globe)
            add(PassCost("world-fade", coverage = 1.0, fetchesPerFragment = FADE_FETCHES))
        }
    }

    /** The frame's cost on a [bufferW] × [bufferH] buffer at a ladder level's [knobs] (its fps and its ground scale). */
    fun evaluate(config: RealmEngineConfig, dpr: Double, knobs: LadderKnobs, pass: Int, phase: Phase, bufferW: Int, bufferH: Int,
                 minimapShare: Double, points: Int, globe: List<PassCost>,
                 calibration: GpuCalibration = GpuCalibration.PLACEHOLDER,
                 occupancyDots: Boolean = true, lanes: List<PassCost> = emptyList(), laneGround: Boolean = false): FrameCost {
        val k = 1.0 / config.groundDiv(dpr, minOf(2, knobs.level), pass)
        return WorldFrameCost.evaluate(passes(phase, k, minimapShare, points, globe, bufferW.toLong() * bufferH, occupancyDots, lanes, laneGround),
            bufferW, bufferH, k, knobs.targetFps, calibration)
    }
}
