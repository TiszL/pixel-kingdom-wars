package gg.pixelkingdomwars.nativeclient.renderer.world

import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeCost
import kotlin.test.*
import org.junit.Test

/**
 * The whole-frame model on every Seeker row (GLOBE-NATIVE-PLAN §5.2, §5.4). The frames below are REFERENCE worst
 * frames built from the plan and the pinned web cost figures ([WebPin]), with the knobs taken from the production
 * [FrameLadder]: change a level's knobs and these tests re-price it. Coverage figures marked "placeholder" and the
 * [GpuCalibration.PLACEHOLDER] rates are estimates until the engines' own models (GroundCost, GlobeCost, LIFE/BASES
 * planners), the malioc report and the N0 GPU bench replace them; ALU is unmodelled (no malioc yet) and reported.
 */
class WorldFrameCostTest {
    private val ladder = FrameLadder(LadderPolicy.PLAN, WebPin.LADDER_INPUTS)

    /** The realm map's worst frame: a MAP→TRUE fade with the frame's resolve slices, LIFE at its cap, every pass on. */
    private fun realm(row: SeekerRow, knobs: LadderKnobs): FrameCost {
        val lifeShare = knobs.lifeCap.toDouble() / WebPin.LIFE_CAP_PHONE
        val resolve = if (knobs.maxResolves == 0) WebPin.SUB_TILE_FETCHES + WebPin.RESOLVE_BUDGET_PAGES.getValue(row.bufferPx) * WebPin.PAGE_FETCHES
            else WebPin.SUB_TILE_FETCHES // L1+: one sub-tile or one page, the sub-tile being the larger
        val passes = buildList {
            add(PassCost("ground-fade", onGround = true, coverage = 1.0, fetchesPerFragment = WebPin.GROUND_FADE_FETCHES))
            add(PassCost("ground-resolve", fixedFetches = resolve))
            add(PassCost("lowres-blit", coverage = 1.0, fetchesPerFragment = 1.0))
            add(PassCost("life", coverage = 0.6 * lifeShare /* placeholder */, fetchesPerFragment = 1.0,
                vertices = 6L * knobs.lifeCap, vsFetchesPerVertex = WebPin.LIFE_VS_FETCHES_AT_CAP / (6.0 * WebPin.LIFE_CAP_PHONE)))
            add(PassCost("bases", coverage = 0.3 /* placeholder */, fetchesPerFragment = 4.0))
            add(PassCost("minimap", coverage = 0.04 /* placeholder */, fetchesPerFragment = 5.0))
            add(PassCost("mid-pass depth clear", extraBytes = row.bufferPx * 2))
            if (knobs.heavy) {
                add(PassCost("air", coverage = 1.0 /* placeholder */, fetchesPerFragment = 2.0))
                add(PassCost("bird shadows", coverage = 0.1 /* placeholder */, fetchesPerFragment = 1.0))
                add(PassCost("cloud shade", coverage = 1.0 /* placeholder */, fetchesPerFragment = 2.0))
            }
        }
        return WorldFrameCost.evaluate(passes, row.bufferW, row.bufferH, knobs.groundScale(row.dpr), knobs.targetFps)
    }

    /** The flat globe's worst frame from the globe's own model (GlobeCost, the one globe model: Rule 7): the sphere
     *  filling the buffer with a realm selected, plus the exploration islands, at the level's render scale. */
    private fun globe(row: SeekerRow, knobs: LadderKnobs): FrameCost =
        WorldFrameCost.evaluate(GlobeCost.referencePasses(knobs), row.bufferW, row.bufferH, GlobeCost.renderScale(knobs), knobs.targetFps)

    @Test fun `the reference frames fit the 10 ms bar at L0 on every Seeker row`() {
        for (row in SeekerRows.ALL) {
            val realm = realm(row, ladder.knobs[0]); val globe = globe(row, ladder.knobs[0])
            assertTrue(realm.ms <= WorldFrameCost.BUDGET_MS, "realm ${realm.ms} ms on $row")
            assertTrue(globe.ms <= WorldFrameCost.BUDGET_MS, "globe ${globe.ms} ms on $row")
            assertFalse(realm.calibrated, "a placeholder figure must never pass for a measured one")
            assertTrue(realm.unmodelledAlu > 0, "ALU is not measured yet (no malioc): the figure is fetch-bound only")
            assertTrue(globe.fetchesPerCanvasPx <= 12.0, "the globe's own ≤ 12 fetches per canvas px budget")
        }
    }

    @Test fun `every realm-map ladder step cuts the modelled load by at least a fifth on every Seeker row`() {
        for (row in SeekerRows.ALL) for (level in 1 until FrameLadder.LEVELS) {
            val before = realm(row, ladder.knobs[level - 1]).dutyMs
            val after = realm(row, ladder.knobs[level]).dutyMs
            assertTrue(after <= 0.8 * before, "realm L${level - 1}→L$level on $row: $before → $after ms is a near no-op")
        }
    }

    @Test fun `every globe ladder step cuts the modelled load by at least a fifth on every Seeker row`() {
        for (row in SeekerRows.ALL) for (level in 1 until FrameLadder.LEVELS) {
            val before = globe(row, ladder.knobs[level - 1]).dutyMs
            val after = globe(row, ladder.knobs[level]).dutyMs
            assertTrue(after <= 0.8 * before, "globe L${level - 1}→L$level on $row: $before → $after ms")
        }
    }

    /**
     * The plan's "every step cuts ≥ 20 %" rule for the globe at L1→L2 (fixed in the NG fix pass; this test used to pin
     * the open issue that L2 was "L1 + animation off", a no-op for a motion frame). A globe still missing 60 fps at L1
     * must get a real cut: L2 draws the ray–sphere pass at half scale into the globe's own target and upscales it, so a
     * motion frame pays a quarter of the sphere's fragments. If L2 lost its scale step this fails.
     */
    @Test fun `the globe's L2 draws the sphere at half scale, a real motion-frame cut beyond L1`() {
        val l1 = ladder.knobs[1]; val l2 = ladder.knobs[2]
        assertEquals(1.0, GlobeCost.renderScale(l1)); assertEquals(0.5, GlobeCost.renderScale(l2))
        assertEquals(l1.cloudShell, l2.cloudShell, "the cut is the scale, not another feature")
        for (row in SeekerRows.ALL) {
            val a = globe(row, l1); val b = globe(row, l2)
            assertEquals(a.targetFps, b.targetFps, "a motion frame at the same pacing")
            assertTrue(b.ms <= 0.8 * a.ms, "globe L1→L2 motion frame on $row: ${a.ms} → ${b.ms} ms")
        }
    }

    @Test fun `the model counts the ground at its scale, wide texels twice and unmeasured ALU loudly`() {
        val row = SeekerRows.ALL[0]
        val full = WorldFrameCost.evaluate(listOf(PassCost("g", onGround = true, coverage = 1.0, fetchesPerFragment = 10.0)), row.bufferW, row.bufferH, 1.0, 60)
        val half = WorldFrameCost.evaluate(listOf(PassCost("g", onGround = true, coverage = 1.0, fetchesPerFragment = 10.0)), row.bufferW, row.bufferH, 0.5, 60)
        assertEquals(10.0, full.fetchesPerCanvasPx, 1e-9)
        assertEquals(2.5, half.fetchesPerCanvasPx, 0.01, "a half-scale ground target has a quarter of the fragments")
        val narrow = WorldFrameCost.evaluate(listOf(PassCost("r", coverage = 1.0, fetchesPerFragment = 4.0, aluCyclesPerFragment = 0.0)), 100, 100, 1.0, 60)
        val wide = WorldFrameCost.evaluate(listOf(PassCost("r", coverage = 1.0, fetchesPerFragment = 4.0, wideTexels = true, aluCyclesPerFragment = 0.0)), 100, 100, 1.0, 60)
        assertTrue(wide.ms > narrow.ms)
        assertEquals(0, narrow.unmodelledAlu)
        val aluBound = WorldFrameCost.evaluate(listOf(PassCost("a", coverage = 1.0, fetchesPerFragment = 1.0, aluCyclesPerFragment = 400.0)), 100, 100, 1.0, 60)
        assertTrue(aluBound.ms > narrow.ms, "a measured ALU-bound pass must cost its cycles, not its fetches")
        assertEquals(30, WorldFrameCost.evaluate(emptyList(), 10, 10, 1.0, 30).targetFps)
    }

    /**
     * Why: the Seeker session prices the ground's fragment fetches at an effective 1.99/ns (their unmodelled loops ride on
     * them) while LIFE's vertex stages read cache-resident tables at the texel rate. One shared rate would charge LIFE's
     * worst-path vertices seven times over and make every LIFE-heavy view look like the MAP entry the device could not draw.
     */
    @Test fun `vertex fetches are priced at the vertex rate and fragment fetches at the fragment rate`() {
        val seeker = GpuCalibration.SEEKER
        val vs = WorldFrameCost.evaluate(listOf(PassCost("v", vertices = 6_000_000, vsFetchesPerVertex = 10.0)), 1, 1, 1.0, 60, seeker)
        val fs = WorldFrameCost.evaluate(listOf(PassCost("f", coverage = 1.0, fetchesPerFragment = 60.0)), 1_000, 1_000, 1.0, 60, seeker)
        val wb1 = WorldFrameCost.evaluate(emptyList(), 1, 1, 1.0, 60, seeker).ms
        val wb = WorldFrameCost.evaluate(emptyList(), 1_000, 1_000, 1.0, 60, seeker).ms
        assertEquals(60e6 / seeker.vertexFetchesPerNs / 1e6, vs.ms - wb1, 1e-9)
        assertEquals(60e6 / seeker.fetchesPerNs / 1e6, fs.ms - wb, 1e-9)
        assertTrue(seeker.vertexFetchesPerNs > seeker.fetchesPerNs)
        assertEquals(GpuCalibration.PLACEHOLDER.fetchesPerNs, GpuCalibration.PLACEHOLDER.vertexFetchesPerNs, "the estimates keep one texel rate")
    }
}
