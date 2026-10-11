package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GroundCost as G
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundCost.RestPass
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.bits
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.hx
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.list
import gg.pixelkingdomwars.nativeclient.renderer.world.GpuCalibration
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRow
import gg.pixelkingdomwars.nativeclient.renderer.world.SeekerRows
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameCost
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * GROUND's cost model (groundcost.js) ported under golden vectors, and its ceilings on the Seeker rows (plan §5.2, §5.5:
 * 1200×2670 at density 2.625 / 2.75 / 3.0, the fixed dpr-2 buffer). Why it matters: the realm map hung the owner's whole
 * Mac GPU once (RM-GPU-1), and no test may run the Seeker's GPU; so the bound is static. Every ground frame the engine can
 * issue — each band at rest, each cross-fade, each ladder level, with that frame's resolve slices — must stay under the
 * web's per-canvas-px budgets, and a regression (a heavier MAP pass, the ground cap switched off, an unsliced resolve)
 * must fail here before it reaches a phone.
 */
class GroundCostTest {
    private val g = GroundGolden.suite("groundcost")

    // ---------------------------------------------------------------- parity with the pinned web model

    @Test fun `the pass figures and budgets are the pinned groundcost js ones`() {
        val c = g.get("constants")
        val pass = c.get("PASS"); val iters = c.get("ITERS")
        for (p in GroundCost.Pass.entries) {
            val key = p.name.lowercase()
            assertEquals(pass.getInt(key), p.fetches, "PASS.$key"); assertEquals(iters.getInt(key), p.iters, "ITERS.$key")
        }
        assertEquals(c.getInt("DISPLAY_BUDGET"), G.DISPLAY_BUDGET); assertEquals(c.getInt("FRAME_BUDGET"), G.FRAME_BUDGET)
        assertEquals(c.getInt("FRAME_ITER_BUDGET"), G.FRAME_ITER_BUDGET); assertEquals(c.getInt("RESOLVE_BUDGET"), G.RESOLVE_BUDGET)
        val r = c.get("RESOLVE")
        assertEquals(r.getInt("sub"), GroundCost.SUB); assertEquals(r.getInt("apron"), GroundCost.APRON)
        assertEquals(r.getInt("maxSubsFar"), GroundCost.MAX_SUBS_FAR); assertEquals(r.getInt("maxSubsMap"), GroundCost.MAX_SUBS_MAP); assertEquals(r.getInt("maxPages"), GroundCost.MAX_PAGES)
        assertEquals(list(c.get("LATTICE_PASSES")).map { it.asString() }, GroundCost.LATTICE_PASSES.map { it.name.lowercase() })
        // one apron vertex per pass after the raw one, or the lattice pages would show seams
        assertEquals(GroundCost.APRON, GroundCost.LATTICE_PASSES.size)
    }

    @Test fun `sub-tile and page resolve work equals the web model for every despeckle count`() {
        val st = g.get("subTile")
        assertEquals(st.getString(0), bits(GroundCost.subTileFetches()), "subTileFetches"); assertEquals(st.getString(1), bits(GroundCost.subTileFetches(iters = true)), "subTile iters")
        var n = 0
        for (row in list(g.get("page"))) {
            val dp = row.getInt(0)
            assertEquals(row.getString(1), bits(GroundCost.pageFetches(dp)), "pageFetches($dp)"); assertEquals(row.getString(2), bits(GroundCost.pageFetches(dp, iters = true)), "page iters($dp)"); n++
        }
        assertEquals(9, n)
    }

    @Test fun `resolveBudget equals the web for every canvas, band and despeckle count`() {
        var n = 0
        for (row in list(g.get("budget"))) {
            val px = row.getDouble(0); val far = row.getInt(1) == 1; val dp = row.getInt(2)
            val b = GroundCost.resolveBudget(px, far, dp)
            assertEquals(row.getInt(3), b.subs, "subs at $px far=$far dp=$dp"); assertEquals(row.getInt(4), b.pages, "pages at $px far=$far dp=$dp"); n++
        }
        assertEquals(426, n)
    }

    @Test fun `frameCost equals the web to the bit over sizes, ground scales, drawn passes and resolve slices`() {
        var n = 0
        for (row in list(g.get("frame"))) {
            val w = row.getInt(0); val h = row.getInt(1); val k = hx(row.getString(2)); val m = row.getInt(3)
            val c = GroundCost.frameCost(w, h, k, chart = m and 1 != 0, map = m and 2 != 0, trueOn = m and 4 != 0, subs = row.getInt(4), pages = row.getInt(5), despecklePasses = row.getInt(6))
            val got = listOf(c.fetches, c.iters, c.perPx, c.itersPerPx, c.passesPerPx, c.resolvePerPx, c.groundPx)
            for (i in got.indices) assertEquals(row.getString(7 + i), bits(got[i]), "frameCost($w, $h, $k, $m) field $i")
            n++
        }
        assertEquals(9 * 7 * 8, n)
    }

    @Test fun `planPages keeps the nearest pages and fetches only their missing ones, as the web`() {
        val plan = GroundCost.Plan(8)
        var n = 0
        for (c in list(g.get("plans"))) {
            val want = list(c.get("want"))
            val m = want.size / 2
            val keys = IntArray(m) { want[2 * it].asInt() }; val dist = DoubleArray(m) { hx(want[2 * it + 1]) }
            val has = GroundGolden.ints(c.get("has")).toHashSet()
            val budget = c.getInt("budget").let { if (it < 0) Int.MAX_VALUE else it }
            GroundCost.planPages(keys, dist, m, c.getInt("cap"), { has.contains(it) }, budget, plan)
            assertEquals(GroundGolden.ints(c.get("keep")).toList(), plan.keep.copyOf(plan.keepCount).toList(), "keep, case $n")
            assertEquals(GroundGolden.ints(c.get("fetch")).toList(), plan.fetch.copyOf(plan.fetchCount).toList(), "fetch, case $n")
            assertEquals(c.getInt("missing"), plan.missing, "missing, case $n")
            n++
        }
        assertEquals(120, n)
    }

    @Test fun `the TRUE record cache is sized from the screen as the web sizes it`() {
        var n = 0
        for (row in list(g.get("demand"))) {
            val w = row.getDouble(0); val h = row.getDouble(1); val d = row.getDouble(2)
            assertEquals(row.getInt(3), GroundCost.pageDemand(w, h, d), "pageDemand($w, $h, $d)"); assertEquals(row.getInt(4), GroundCost.recCapacity(w, h, d), "recCapacity($w, $h, $d)"); n++
        }
        assertEquals(40, n)
    }

    // ---------------------------------------------------------------- the Seeker rows

    /** One ground frame kind: the passes drawn, the rest pass (null in a fade), the band's resolve kind. */
    private class Kind(val name: String, val chart: Boolean, val map: Boolean, val trueOn: Boolean, val rest: RestPass?, val far: Boolean, val pages: Boolean)

    /** Every frame GROUND issues (ground.js draw(): passes(view)), worst resolve slices included: at FAR only the rest-time
     *  lattice pre-resolve (one sub-tile), at MAP ≥ d 600 and in TRUE sub-tiles and pages. */
    private val kinds = listOf(
        Kind("FAR rest", chart = true, map = false, trueOn = false, rest = RestPass.CHART, far = true, pages = false),
        Kind("MAP rest", chart = false, map = true, trueOn = false, rest = RestPass.MAP, far = false, pages = true),
        Kind("TRUE rest", chart = false, map = false, trueOn = true, rest = RestPass.TRUE, far = false, pages = true),
        Kind("TRUE over MAP (pages missing)", chart = false, map = true, trueOn = true, rest = null, far = false, pages = true),
        Kind("FAR→MAP fade", chart = true, map = true, trueOn = false, rest = null, far = false, pages = false),
        Kind("MAP→TRUE fade (+ chart while the lattice resolves)", chart = true, map = true, trueOn = true, rest = null, far = false, pages = true),
    )

    private fun frame(row: SeekerRow, kind: Kind, webLevel: Int, maxResolves: Int): GroundCost.Frame {
        val px = row.bufferPx.toDouble()
        val k = 1.0 / GroundCost.groundDiv(row.dpr, webLevel, kind.rest)
        val b = GroundCost.resolveBudget(px, kind.far)
        var subs = if (kind.far) 1 else b.subs; var pages = if (kind.pages) b.pages else 0
        if (maxResolves > 0) { if (subs > 0) { subs = minOf(subs, maxResolves); pages = 0 } else pages = minOf(pages, maxResolves) }
        return GroundCost.frameCost(row.bufferW, row.bufferH, k, px, kind.chart, kind.map, kind.trueOn, subs, pages)
    }

    private val policy = LadderPolicy.PLAN

    @Test fun `every ground frame at every ladder level stays within the display, frame and iteration budgets on every Seeker row`() {
        var checked = 0
        for (row in SeekerRows.ALL) for (kind in kinds) for (level in 0..2) {
            val c = frame(row, kind, level, if (level >= 1) policy.l1MaxResolves else 0)
            assertTrue(c.passesPerPx <= G.DISPLAY_BUDGET, "${kind.name} L$level on $row: display ${c.passesPerPx} > ${G.DISPLAY_BUDGET} fetches per canvas px")
            assertTrue(c.perPx <= G.FRAME_BUDGET, "${kind.name} L$level on $row: frame ${c.perPx} > ${G.FRAME_BUDGET}")
            assertTrue(c.itersPerPx <= G.FRAME_ITER_BUDGET, "${kind.name} L$level on $row: ${c.itersPerPx} iterations > ${G.FRAME_ITER_BUDGET}")
            // the slices of one frame: within RESOLVE_BUDGET, or the one-sub-tile + one-page floor (below it nothing resolves)
            val floor = (GroundCost.subTileFetches() + GroundCost.pageFetches(6)) / row.bufferPx
            assertTrue(c.resolvePerPx <= maxOf(G.RESOLVE_BUDGET.toDouble(), floor) + 1e-9, "${kind.name} L$level on $row: resolve ${c.resolvePerPx}")
            checked++
        }
        assertEquals(3 * 6 * 3, checked)
    }

    @Test fun `the ground cap is load-bearing on the Seeker - all three passes at full resolution would not fit`() {
        for (row in SeekerRows.ALL) {
            val all = GroundCost.frameCost(row.bufferW, row.bufferH, 1.0, chart = true, map = true, trueOn = true)
            assertTrue(all.passesPerPx > G.DISPLAY_BUDGET, "uncapped fade fits anyway on $row: the fade k is decoration")
            // and the rule that picks k never renders a fade at full resolution
            assertEquals(2, GroundCost.groundDiv(row.dpr, 0, null), "a fade renders at k ½ on $row")
        }
    }

    @Test fun `MAP at rest renders at full resolution and still fits with its resolve slices - the P0 16-texel block would not`() {
        for (row in SeekerRows.ALL) {
            assertEquals(1, GroundCost.groundDiv(row.dpr, 0, RestPass.MAP), "MAP at rest is k 1 on $row")
            val c = frame(row, kinds[1], 0, 0)
            assertTrue(c.perPx <= G.DISPLAY_BUDGET, "MAP rest + slices = ${c.perPx} on $row")
            // teeth: P0's 4×4 lattice block read 8 more texels per pixel (61 fetches): it does not fit a Seeker row at k 1
            val p0 = c.perPx + 8.0
            assertTrue(p0 > G.DISPLAY_BUDGET, "the model no longer tells the P0 block (+8 fetches) from the purity bit on $row: ${p0}")
        }
    }

    @Test fun `the ladder never makes a ground frame heavier, and each step cuts the display passes it controls by at least a fifth`() {
        for (row in SeekerRows.ALL) for (kind in kinds) {
            val f0 = frame(row, kind, 0, 0); val f1 = frame(row, kind, 1, policy.l1MaxResolves); val f2 = frame(row, kind, 2, policy.l1MaxResolves)
            assertTrue(f1.perPx <= f0.perPx + 1e-9 && f2.perPx <= f1.perPx + 1e-9, "${kind.name} on $row: L0 ${f0.perPx}, L1 ${f1.perPx}, L2 ${f2.perPx}")
            // L2's ground k ⅓ (k ½ at L1): the display passes, which GROUND's ladder knob scales, drop by more than half
            assertTrue(f2.passesPerPx <= 0.8 * f1.passesPerPx, "${kind.name} on $row: L1→L2 display ${f1.passesPerPx} → ${f2.passesPerPx}")
            // L0→L1: a lone pass at rest goes k 1 → ½; a fade is already at ½ and saves only its resolve slice (the whole-frame
            // ≥ 20 % rule is WorldFrameCost's, with LIFE thinned and the heavy passes off at L1)
            if (kind.rest != null) assertTrue(f1.passesPerPx <= 0.8 * f0.passesPerPx, "${kind.name} L0→L1 display on $row")
            else assertEquals(f0.passesPerPx, f1.passesPerPx, "${kind.name}: a fade's display is k ½ at L0 and L1 on $row")
        }
    }

    @Test fun `the ground's share of the whole-frame model fits the 10 ms bar at L0 with placeholder rates`() {
        for (row in SeekerRows.ALL) for (kind in kinds) {
            val px = row.bufferPx.toDouble(); val k = 1.0 / GroundCost.groundDiv(row.dpr, 0, kind.rest)
            val b = GroundCost.resolveBudget(px, kind.far)
            val parts = GroundCost.passCosts(kind.chart, kind.map, kind.trueOn, if (kind.far) 1 else b.subs, if (kind.pages) b.pages else 0)
            val c = WorldFrameCost.evaluate(parts, row.bufferW, row.bufferH, k, 60, GpuCalibration.PLACEHOLDER)
            assertTrue(c.ms <= WorldFrameCost.BUDGET_MS, "${kind.name} on $row: ground alone ${c.ms} ms")
            assertTrue(!c.calibrated, "a placeholder figure must never pass for a measured one")
        }
    }
}
