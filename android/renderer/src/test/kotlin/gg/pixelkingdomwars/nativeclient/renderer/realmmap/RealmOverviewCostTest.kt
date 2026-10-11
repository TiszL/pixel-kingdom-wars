package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeCost
import gg.pixelkingdomwars.nativeclient.renderer.world.FrameLadder
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderKnobs
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderInputs
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRows
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameCost
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The core's realm frames in the whole-frame model (GLOBE-NATIVE-PLAN §1.2, §5.2, §5.4) on every Seeker row, at every ladder
 * level, in every frame kind the engine draws: the live overview at rest (the chart pass alone), the live overview
 * inside a band fade (two-pass scale rule, n0), the dive's one-off snapshot frame, and a dive/leave fade frame (the live
 * globe plus the composite). The bar: ≤ 10 ms modelled at L0, and no level costs more than the one before it. The rates
 * are the placeholder G615 figures until the N0 GPU bench; ALU is unmodelled until malioc (reported).
 */
class RealmOverviewCostTest {
    private val config = RealmWebPin.CONFIG
    /** GPU_SAFE.groundPx[0] and LIFE_CAPS.submitted.phone (the ladder's web inputs at the pin). */
    private val ladder = FrameLadder(LadderPolicy.PLAN, LadderInputs(config.groundPx[0], 40_000))
    /** The approved HUD's minimap on a phone: about 132 × 100 CSS px of a ~436 × 971 CSS px screen (≈ 3 %); 6 % priced. */
    private val minimapShare = 0.06
    /** Every base of the largest realm on the minimap (Stormcairn: 15,270 deeds, all occupied). */
    private val points = 15_271

    /** The globe's reference frame from the globe's own model (GlobeCost, the one globe model: Rule 7). A fade draws the
     *  globe at full scale at every level (the half-scale step runs only on plain globe frames). */
    private fun globe(k: LadderKnobs): List<PassCost> = GlobeCost.referencePasses(k, scaled = false)

    private fun cost(level: Int, pass: Int, phase: RealmOverviewCost.Phase, rowIndex: Int) = SeekerRows.ALL[rowIndex].let { row ->
        val knobs = ladder.knobs[level]
        RealmOverviewCost.evaluate(config, row.dpr, knobs, pass, phase, row.bufferW, row.bufferH, minimapShare, points, globe(knobs))
    }

    @Test fun `every N2 frame kind fits the 10 ms bar at every ladder level on every Seeker row`() {
        for (r in SeekerRows.ALL.indices) for (level in 0 until FrameLadder.LEVELS) {
            for (phase in RealmOverviewCost.Phase.entries) for (pass in intArrayOf(RealmEngineConfig.PASS_CHART, RealmEngineConfig.PASS_NONE)) {
                val c = cost(level, pass, phase, r)
                assertTrue(c.ms <= WorldFrameCost.BUDGET_MS, "${SeekerRows.ALL[r]} L$level $phase pass $pass: ${c.ms} ms")
                assertFalse(c.calibrated, "placeholder rates never pass for measured ones")
                assertTrue(c.unmodelledAlu > 0, "ALU is not measured yet: the figure is fetch/bandwidth-bound only")
            }
        }
    }

    @Test fun `no ladder level costs more than the level before it`() {
        for (r in SeekerRows.ALL.indices) for (phase in RealmOverviewCost.Phase.entries) for (pass in intArrayOf(RealmEngineConfig.PASS_CHART, RealmEngineConfig.PASS_NONE))
            for (level in 1 until FrameLadder.LEVELS) {
                val before = cost(level - 1, pass, phase, r).dutyMs; val after = cost(level, pass, phase, r).dutyMs
                assertTrue(after <= before + 1e-12, "${SeekerRows.ALL[r]} $phase pass $pass L${level - 1}→L$level: $before → $after ms")
            }
    }

    @Test fun `the resting overview renders its lone chart pass at full resolution at L0 and at an integer fraction below`() {
        for (row in SeekerRows.ALL) {
            assertEquals(1, config.groundDiv(row.dpr, 0, RealmEngineConfig.PASS_CHART), "L0 rest: chart 4 + resolve 6 ≤ display 64")
            // the per-band k (core.js groundDiv with the pass drawn alone): MAP 53 + 6 and TRUE 22 + 6 fit 64 too, so every
            // rest band renders at full resolution at L0; a pass whose cost is unknown never does
            assertEquals(1, config.groundDiv(row.dpr, 0, RealmEngineConfig.PASS_MAP), "L0 MAP rest")
            assertEquals(1, config.groundDiv(row.dpr, 0, RealmEngineConfig.PASS_TRUE), "L0 TRUE rest")
            assertEquals(2, config.groundDiv(row.dpr, 0, 99), "an unknown pass renders at n0")
            assertEquals(2, config.groundDiv(row.dpr, 1, RealmEngineConfig.PASS_MAP)); assertEquals(3, config.groundDiv(row.dpr, 2, RealmEngineConfig.PASS_TRUE))
            assertEquals(2, config.groundDiv(row.dpr, 0, RealmEngineConfig.PASS_NONE), "L0 fade: n0 = ⌈2 / 1.5⌉")
            assertEquals(2, config.groundDiv(row.dpr, 1, RealmEngineConfig.PASS_CHART))
            assertEquals(3, config.groundDiv(row.dpr, 2, RealmEngineConfig.PASS_CHART))
        }
    }

    /**
     * The core's resting overview frame on each ladder step. This test used to pin the N2 shape "L1 → L2 cuts less than a
     * fifth": the `stub-ground` overview (3 fetches) was so light that the screen's tile writeback, which no level removes,
     * dominated it. The owner's zoom-out fix (2026-09-25) drew the web's FAR program `rm-chart` instead (then 5 fetches,
     * trilinear), and L1 → L2 cleared a fifth. At pin 02e9da84 the chart lost its other-realm veil and with it the deeds
     * `texelFetch` (owner 2026-09-26: "check crownland also have that grey area on the edges, which sunscar had, fix it for
     * all realms"; `groundcost.js PASS.chart` 5 → 4), so the writeback's share grew again and L1 → L2 (ground scale ½ → ⅓)
     * now cuts 19.35–19.41 % on the three Seeker rows; L0 → L1 cuts 29.7 % and L2 → L3 (30 fps) 50 %.
     *
     * That is not the plan's rule failing: §5.4's rule is the whole frame's, wherever it runs over the 10 ms budget
     * (RealmOverviewCostLanesTest pins it over the MAP band), and this frame's L0 duty is at most 1.72 ms. What holds,
     * pinned: the frame is far under the bar, and every step cuts it by at least 19 % (the measured worst, 19.35 %, rounded
     * down): a change that makes a level cut less, or a no-op, for the core's frame fails here.
     */
    @Test fun `every ladder step cuts the core's live rest frame, far under the bar`() {
        val cuts = mutableListOf<Pair<String, Double>>()
        for (r in SeekerRows.ALL.indices) {
            val l0 = cost(0, RealmEngineConfig.PASS_CHART, RealmOverviewCost.Phase.LIVE, r)
            assertTrue(l0.ms < 0.25 * WorldFrameCost.BUDGET_MS, "${SeekerRows.ALL[r]} core frame L0 ${l0.ms} ms")
            for (level in 1 until FrameLadder.LEVELS) {
                val before = cost(level - 1, RealmEngineConfig.PASS_CHART, RealmOverviewCost.Phase.LIVE, r).dutyMs
                val after = cost(level, RealmEngineConfig.PASS_CHART, RealmOverviewCost.Phase.LIVE, r).dutyMs
                cuts += "${SeekerRows.ALL[r]} L${level - 1}→L$level $before → $after" to 1 - after / before
            }
        }
        val worst = cuts.minBy { it.second }
        assertTrue(worst.second >= 0.19, "worst step ${worst.first}: cut ${worst.second} (all: ${cuts.joinToString("; ") { "${it.first} ${it.second}" }})")
    }
}
