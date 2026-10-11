package gg.pixelkingdomwars.nativeclient.renderer.world

import kotlin.math.ceil

/**
 * One Seeker panel row (GLOBE-NATIVE-PLAN §1.2, §5.5). The panel is the public spec (1200×2670, believed, not
 * measured) and the density is unknown, so every cost, HUD and instance test runs all of [SeekerRows.ALL] until the N0
 * device probe records `wm size` / `wm density`; then the measured row is pinned here.
 */
class SeekerRow(val panelW: Int, val panelH: Int, val density: Double) {
    val dpr: Double = InputScale.dpr(density)
    val bufferW: Int = InputScale.fixedBufferSide(panelW, density)
    val bufferH: Int = InputScale.fixedBufferSide(panelH, density)
    val bufferPx: Long get() = bufferW.toLong() * bufferH
    override fun toString() = "${panelW}x$panelH@$density (${bufferW}x$bufferH)"
}

object SeekerRows {
    /** UNVERIFIED (public spec, plan §10.3) until the N0 probe. */
    val ALL: List<SeekerRow> = listOf(SeekerRow(1200, 2670, 2.625), SeekerRow(1200, 2670, 2.75), SeekerRow(1200, 2670, 3.0))

    /** The owner's Seeker as the engine logged it on 2026-09-25 (`[world-engine] buffer 800x1780 for view 1200x2670 (dpr
     *  2.0)`): 1200 × 2 / 800 = 3.0, so density 3.0, the last row of [ALL]. [GpuCalibration.SEEKER] was taken on it. */
    val MEASURED: SeekerRow = ALL[2]
}

/**
 * Device rates the model turns work into time with. [PLACEHOLDER] is estimates only; [SEEKER] is bracketed by the owner's
 * first Seeker session until the N0 GPU bench (plan §5.2, §8.3) measures ms per production pass and ns per fetch on the
 * probe screen. [calibrated] says whether a figure used device evidence or estimates.
 */
class GpuCalibration(
    /** Texel fetches per ns across the whole GPU (bilinear, 32-bit texels). */
    val fetchesPerNs: Double,
    /** Fragment-shader arithmetic: malioc cycles per ns across the GPU (shader cores × clock). */
    val fragmentCyclesPerNs: Double,
    val vertexCyclesPerNs: Double,
    /** Bytes per ns of tile writeback / clear bandwidth. */
    val bytesPerNs: Double,
    val calibrated: Boolean,
    /** Texel fetches per ns in the vertex stages (their tables are small and cache-resident; see [SEEKER]). */
    val vertexFetchesPerNs: Double = fetchesPerNs,
) {
    companion object {
        /** Unverified estimates only: the plan's "11–17 Gtexel/s" G615 MC2 texel rate (midpoint), 2 cores × ~0.95 GHz,
         *  ~12 GB/s effective writeback. Not evidence of anything. */
        val PLACEHOLDER = GpuCalibration(fetchesPerNs = 14.0, fragmentCyclesPerNs = 1.9, vertexCyclesPerNs = 1.9, bytesPerNs = 12.0, calibrated = false)

        /**
         * The owner's Seeker (Mali-G615 MC2, [SeekerRows.MEASURED] 800 × 1780), bracketed by its first session (2026-09-25
         * 17:13–17:21, `.reports/globe-native-n3n4/seeker-1713/world-live.txt`); `RealmOverviewCostLanesTest` re-derives it,
         * each frame priced as that APK (code 27, web pin 4de21f1a) drew it: its lanes, and LIFE's vertex walk at that pin:
         * - FLOOR: Thornwake, the one realm whose frame the model prices with no upper-bound lane (at that pin no LIFE table,
         *   no kit dressing: GROUND and the core only; stage B gives it both), held L1 through the MAP band for 1.2 s and 2.5 s (17:20:19.9–21.1,
         *   29.3–31.8): fetches/ns ≥ 1.72. Only stretches on screen for a ladder window count; the fade-band frames (d 805 and
         *   1083, 82 and 66 ms on screen) that set the first floor of 2.70 could not have stepped the ladder at any cost.
         * - CEILING: every step of the session, each read as frames over the slot somewhere in its band stretch (the lanes'
         *   bounds only raise a figure, so LIFE realms cap it too). The lowest is Crownlands at L2 in the MAP band (the
         *   ladder stepped under the guard's floor at 17:14:50.2, 50.7 and 17:15:19.98): < 2.29. Frostveil's L1 → L2 step in
         *   the MAP band (17:17:16.1) caps it at 3.29, Thornwake's L0 MAP entry at 5.20.
         * [fetchesPerNs] is the bracket's geometric midpoint, √(1.72 × 2.29) = 1.99. A step is frame-INTERVAL evidence (CPU
         * or GPU) and the model is GPU only: were the Crownlands L2 steps CPU work after the trip, the ceiling is Frostveil's
         * and the midpoint 2.38; either way L1 is not a proven MAP resting level on LIFE realms. It is an EFFECTIVE rate, far
         * under the texel-rate estimate: the ground's worst-path fetches carry integer loops (MAP 87 iterations per
         * fragment, the resolve's despeckle 80) that stay unmodelled until the malioc report.
         * [vertexFetchesPerNs] stays the texel-rate estimate: LIFE's vertex stages read small cache-resident tables, and no
         * session frame isolates them (the frames with LIFE and BASES carry those lanes' upper bounds, so they bound
         * nothing). Writeback stays the estimate.
         */
        val SEEKER = GpuCalibration(fetchesPerNs = 1.99, fragmentCyclesPerNs = 1.9, vertexCyclesPerNs = 1.9, bytesPerNs = 12.0, calibrated = true,
            vertexFetchesPerNs = 14.0)
    }
}

/**
 * The GPU work of one part of a frame. Fragment work is [coverage] × the target's px (the ground target at scale k when
 * [onGround], else the full buffer); vertex work is [vertices] × max(fetch, ALU) time; [fixedFetches] is work not tied
 * to fragments (a resolve chain); [extraBytes] is bandwidth (a mid-pass clear). ALU cycles come from the Mali Offline
 * Compiler; NaN means "not measured yet" and is reported by [FrameCost.unmodelledAlu], never silently zero.
 */
class PassCost(
    val name: String,
    val onGround: Boolean = false,
    val coverage: Double = 0.0,
    val fetchesPerFragment: Double = 0.0,
    /** 64-bit texels (RGBA16UI records, the LIFE table): two texture cycles per fetch. */
    val wideTexels: Boolean = false,
    val trilinear: Boolean = false,
    val aluCyclesPerFragment: Double = Double.NaN,
    val vertices: Long = 0,
    val vsFetchesPerVertex: Double = 0.0,
    val vsCyclesPerVertex: Double = Double.NaN,
    val fixedFetches: Long = 0,
    val extraBytes: Long = 0,
)

class FrameCost(
    /** Modelled GPU ms of one frame. */
    val ms: Double,
    val targetFps: Int,
    val fetchesPerCanvasPx: Double,
    /** Passes with fragment or vertex work but no measured ALU cycles: the figure is fetch/bandwidth-bound only. */
    val unmodelledAlu: Int,
    val calibrated: Boolean,
) {
    /** GPU ms per 60 Hz slot: the load a level puts on the GPU (L3's 30 fps pacing halves it at the same frame cost). */
    val dutyMs: Double get() = ms * targetFps / 60.0
}

/**
 * The whole-frame analytic cost model (GLOBE-NATIVE-PLAN §5.2). The engines' own models (GroundCost, GlobeCost, the
 * LIFE/BASES planners) describe their passes; this sums them in Seeker milliseconds so the ladder and the gates see
 * the frame, not only the ground. Not a timer: SwiftShader or emulator timings never feed it.
 */
object WorldFrameCost {
    /** The native gate: ≤ 10 ms at L0 on every Seeker row (plan §1.2). */
    const val BUDGET_MS = 10.0
    /** One 60 Hz slot: a GPU frame over it misses vsync, which the ladder sees as a > 20 ms motion interval. */
    const val SLOT_MS = 1000.0 / 60
    private const val SCREEN_BYTES_PER_PX = 4L // RGB8 colour stored per frame; depth is invalidated, never stored

    fun evaluate(passes: List<PassCost>, bufferW: Int, bufferH: Int, groundK: Double, targetFps: Int,
                 calibration: GpuCalibration = GpuCalibration.PLACEHOLDER): FrameCost {
        val bufferPx = bufferW.toDouble() * bufferH
        val groundPx = if (groundK >= 0.999) bufferPx else ceil(bufferW * groundK) * ceil(bufferH * groundK)
        var ns = 0.0; var fetches = 0.0; var unmodelled = 0; var ground = false
        for (p in passes) {
            val fragments = p.coverage * (if (p.onGround) groundPx else bufferPx)
            val texCycles = p.fetchesPerFragment * (if (p.wideTexels) 2 else 1) * (if (p.trilinear) 2 else 1)
            val alu = if (p.aluCyclesPerFragment.isNaN()) 0.0 else p.aluCyclesPerFragment / calibration.fragmentCyclesPerNs
            ns += fragments * maxOf(texCycles / calibration.fetchesPerNs, alu)
            val vsAlu = if (p.vsCyclesPerVertex.isNaN()) 0.0 else p.vsCyclesPerVertex / calibration.vertexCyclesPerNs
            ns += p.vertices * maxOf(p.vsFetchesPerVertex / calibration.vertexFetchesPerNs, vsAlu)
            ns += p.fixedFetches / calibration.fetchesPerNs
            ns += p.extraBytes / calibration.bytesPerNs
            fetches += fragments * p.fetchesPerFragment + p.vertices * p.vsFetchesPerVertex + p.fixedFetches
            if ((fragments > 0 && p.aluCyclesPerFragment.isNaN()) || (p.vertices > 0 && p.vsCyclesPerVertex.isNaN())) unmodelled++
            if (p.onGround && p.coverage > 0) ground = true
        }
        // tile writeback of each render target at the end of its pass: the screen, and the ground target when k < 1
        ns += bufferPx * SCREEN_BYTES_PER_PX / calibration.bytesPerNs
        if (ground && groundK < 0.999) ns += groundPx * 4 / calibration.bytesPerNs
        return FrameCost(ns / 1e6, targetFps, fetches / bufferPx, unmodelled, calibration.calibrated)
    }
}
