package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GroundCost as G
import gg.pixelkingdomwars.nativeclient.renderer.world.PassCost
import kotlin.math.ceil
import kotlin.math.floor

/**
 * GROUND's analytic GPU cost model (web `groundcost.js`, P0 RM-GPU-1), ported 1:1 under golden vectors. The unit is
 * texel fetches EXECUTED per fragment on each pass's worst path, and loop iterations per fragment; every budget is per
 * CANVAS px. The per-pass figures and budgets come from the generated `WorldEngineConstants.GroundCost` (never a Kotlin
 * copy); this object adds the resolve geometry and the functions. The engine asks [resolveBudget] every frame and never
 * issues a resolve past it; [frameCost] is what the whole-frame model (`WorldFrameCost`) and the tests read.
 */
object GroundCost {
    /** Per-pass worst-case fetches per fragment (`PASS`) and loop iterations (`ITERS`), in pass order. */
    enum class Pass(val fetches: Int, val iters: Int) {
        CHART(G.PASS_CHART, G.ITERS_CHART), MAP(G.PASS_MAP, G.ITERS_MAP), TRUE(G.PASS_TRUE, G.ITERS_TRUE), RAW(G.PASS_RAW, G.ITERS_RAW),
        DESPECKLE(G.PASS_DESPECKLE, G.ITERS_DESPECKLE), LEGALISE(G.PASS_LEGALISE, G.ITERS_LEGALISE), RECORD(G.PASS_RECORD, G.ITERS_RECORD),
        PURE(G.PASS_PURE, G.ITERS_PURE),
    }

    /** The lattice sub-tile edge (vertices), its apron, and the per-band resolve caps (`RESOLVE`). */
    const val SUB = G.RESOLVE_SUB
    const val APRON = G.RESOLVE_APRON
    const val MAX_SUBS_FAR = G.RESOLVE_MAX_SUBS_FAR
    const val MAX_SUBS_MAP = G.RESOLVE_MAX_SUBS_MAP
    const val MAX_PAGES = G.RESOLVE_MAX_PAGES

    /** `LATTICE_PASSES`: the passes of one sub-tile resolve after the raw one, each 2 vertices smaller. */
    val LATTICE_PASSES: List<Pass> = listOf(Pass.DESPECKLE, Pass.DESPECKLE, Pass.LEGALISE, Pass.LEGALISE, Pass.PURE)

    private fun per(p: Pass, iters: Boolean): Double = if (iters) p.iters.toDouble() else p.fetches.toDouble()

    /** Fetches (or loop iterations) of one lattice sub-tile resolve: raw over the apron, then [LATTICE_PASSES]. */
    fun subTileFetches(iters: Boolean = false): Double {
        val s = SUB; val a = APRON
        var f = sq(s + 2 * a) * per(Pass.RAW, iters)
        for ((i, k) in LATTICE_PASSES.withIndex()) f += sq(s + 2 * a - 2 * (i + 1)) * per(k, iters)
        return f
    }

    /** Fetches (or loop iterations) of one TRUE page resolve: raw at 99 + 2·top, the despeckle passes, legalise ×2, records. */
    fun pageFetches(despecklePasses: Int, iters: Boolean = false): Double {
        val top = 2 + despecklePasses
        fun size(i: Int) = 99 + 2 * i
        var f = sq(size(top)) * per(Pass.RAW, iters); var i = top
        for (p in 0 until despecklePasses) { f += sq(size(i - 1)) * per(Pass.DESPECKLE, iters); i-- }
        while (i > 0) { f += sq(size(i - 1)) * per(Pass.LEGALISE, iters); i-- }
        return f + 98.0 * 98 * per(Pass.RECORD, iters)
    }

    private fun sq(n: Int): Double = n.toDouble() * n

    /** One frame's resolve allowance (reused: no per-frame allocation). */
    class Budget(var subs: Int = 0, var pages: Int = 0)

    /**
     * `resolveBudget(canvasPx, { far, despecklePasses })`: how many lattice sub-tiles and TRUE pages one frame may resolve
     * on a canvas of [canvasPx] device px — the most that keeps the slices within `RESOLVE_BUDGET` fetches per canvas px
     * (at least one of each, so a view always completes), capped by the band's own maximum.
     */
    fun resolveBudget(canvasPx: Double, far: Boolean = false, despecklePasses: Int = 6, out: Budget = Budget()): Budget {
        val room = G.RESOLVE_BUDGET * canvasPx; val sub = if (despecklePasses == 6) SUB_TILE else subTileFetches(); val page = if (despecklePasses == 6) PAGE6 else pageFetches(despecklePasses)
        val maxSubs = if (far) MAX_SUBS_FAR else MAX_SUBS_MAP
        val pages = maxOf(1.0, minOf(MAX_PAGES.toDouble(), floor((room - sub) / page))).toInt()
        val subs = maxOf(1.0, minOf(maxSubs.toDouble(), floor((room - pages * page) / sub))).toInt()
        out.subs = subs; out.pages = pages
        return out
    }

    private val SUB_TILE = subTileFetches()
    private val PAGE6 = pageFetches(6)

    /** The display pass drawn alone at rest (web core.js `fullResPass` keys). */
    enum class RestPass { CHART, MAP, TRUE }

    /** core.js `fullResPass(pass)`: may this lone display pass render at full resolution (its fetches + a full resolve
     *  slice fit `DISPLAY_BUDGET`)? null = a cross-fade (never full resolution). */
    fun fullResPass(pass: RestPass?): Boolean {
        val f = when (pass) { null -> return false; RestPass.CHART -> G.PASS_CHART; RestPass.MAP -> G.PASS_MAP; RestPass.TRUE -> G.PASS_TRUE }
        return f + G.RESOLVE_BUDGET <= G.DISPLAY_BUDGET
    }

    private fun divFor(dpr: Double, px: Double): Int = minOf(4.0, maxOf(1.0, ceil(maxOf(dpr, 1e-3) / maxOf(px, 1e-3) - 1e-6))).toInt()

    /**
     * core.js `groundDiv(dpr, level, pass)` with GROUND's own passes (the N2 engine's config knows only the chart): the
     * ground target is the canvas / n. Web level 0 renders a lone pass at rest at full resolution when [fullResPass]
     * allows it, a fade at n0; level 1 is n1; level 2 one step coarser. [groundPx] = `GPU_SAFE.groundPx`.
     */
    fun groundDiv(dpr: Double, webLevel: Int, pass: RestPass?, groundPx: DoubleArray = GpuSafe.GROUND_PX): Int {
        val n0 = divFor(dpr, groundPx[0]); val n1 = maxOf(n0, divFor(dpr, groundPx[1]))
        if (webLevel >= 2) return minOf(4, n1 + 1)
        if (webLevel == 1) return n1
        return if (fullResPass(pass)) 1 else n0
    }

    /** `frameCost(…)`'s result: fetches and iterations, per CANVAS px, the display share, the resolve share, ground px. */
    class Frame(val fetches: Double, val iters: Double, val perPx: Double, val itersPerPx: Double, val passesPerPx: Double, val resolvePerPx: Double, val groundPx: Double)

    /**
     * `frameCost({ w, h, k, canvasPx, drawn, subs, pages, despecklePasses })`: the display passes drawn over the ground
     * target (k × the canvas per axis, ceil like `core.lowres`) plus the resolve slices (always canvas-budgeted).
     */
    fun frameCost(w: Int, h: Int, k: Double = 1.0, canvasPx: Double = w.toDouble() * h, chart: Boolean = true, map: Boolean = true, trueOn: Boolean = true,
                  subs: Int = 0, pages: Int = 0, despecklePasses: Int = 6): Frame {
        val px = if (k >= 0.999) w.toDouble() * h else maxOf(1.0, ceil(w * k)) * maxOf(1.0, ceil(h * k)); val n = maxOf(1.0, canvasPx)
        fun sum(iters: Boolean) = (if (chart) per(Pass.CHART, iters) else 0.0) + (if (map) per(Pass.MAP, iters) else 0.0) + (if (trueOn) per(Pass.TRUE, iters) else 0.0)
        val passes = sum(false) * px; val resolve = subs * subTileFetches() + pages * pageFetches(despecklePasses)
        val iters = sum(true) * px + subs * subTileFetches(true) + pages * pageFetches(despecklePasses, true)
        return Frame(passes + resolve, iters, (passes + resolve) / n, iters / n, passes / n, resolve / n, px)
    }

    /** `planPages`'s result, reused frame to frame (no per-frame allocation): the kept keys nearest first ([keepCount]),
     *  the ones to fetch this frame ([fetchCount]) and how many kept pages are missing. Sized for [capacity] wanted pages. */
    class Plan(capacity: Int) {
        var order = IntArray(capacity); var keep = IntArray(capacity); var fetch = IntArray(capacity)
        var keepCount = 0; var fetchCount = 0; var missing = 0
        fun ensure(n: Int) { if (order.size < n) { order = IntArray(n); keep = IntArray(n); fetch = IntArray(n) } }
    }

    /** Is page [key] resident (or already on its way)? */
    fun interface Resident { fun has(key: Int): Boolean }

    /**
     * `planPages(want, cap, has, budget)`: the nearest [cap] of the [n] wanted pages ([keys], [dist]) are kept; only their
     * missing ones are requested, nearest first, at most [budget]. Ties on distance order by key (the web's
     * `a[1] − b[1] || a[0] − b[0]`). Why: a view that wants more pages than the cache holds must not evict a visible page
     * to make room every frame (it would never idle and would shimmer between two layers).
     */
    fun planPages(keys: IntArray, dist: DoubleArray, n: Int, cap: Int, has: Resident, budget: Int, out: Plan): Plan {
        out.ensure(n)
        val order = out.order
        for (i in 0 until n) order[i] = i
        // insertion sort by (dist, key): n is one view's pages (≤ a few hundred); stable, no boxing
        for (i in 1 until n) {
            val o = order[i]; var j = i - 1
            while (j >= 0 && (dist[order[j]] > dist[o] || (dist[order[j]] == dist[o] && keys[order[j]] > keys[o]))) { order[j + 1] = order[j]; j-- }
            order[j + 1] = o
        }
        val kc = minOf(maxOf(0, cap), n)
        var missing = 0; var fc = 0
        for (i in 0 until kc) {
            val k = keys[order[i]]; out.keep[i] = k
            if (!has.has(k)) { missing++; if (fc < maxOf(0, budget)) out.fetch[fc++] = k }
        }
        out.keepCount = kc; out.fetchCount = fc; out.missing = missing
        return out
    }

    /**
     * The ground's share of one frame for the whole-frame model (`WorldFrameCost`, plan §5.2): each drawn display pass over
     * the ground target (the chart reads a mipped chart8: trilinear; TRUE's records are RGBA16UI: 64-bit texels) and the
     * frame's resolve chain as fixed fetches. ALU is unmodelled until the malioc report (reported by `WorldFrameCost`).
     */
    fun passCosts(chart: Boolean, map: Boolean, trueOn: Boolean, subs: Int, pages: Int, despecklePasses: Int = 6): List<PassCost> = buildList {
        if (chart) add(PassCost("ground-chart", onGround = true, coverage = 1.0, fetchesPerFragment = G.PASS_CHART.toDouble(), trilinear = true))
        if (map) add(PassCost("ground-map", onGround = true, coverage = 1.0, fetchesPerFragment = G.PASS_MAP.toDouble()))
        if (trueOn) add(PassCost("ground-true", onGround = true, coverage = 1.0, fetchesPerFragment = G.PASS_TRUE.toDouble(), wideTexels = true))
        val fixed = subs * subTileFetches() + pages * pageFetches(despecklePasses)
        if (fixed > 0) add(PassCost("ground-resolve", fixedFetches = fixed.toLong()))
    }

    /** `pageDemand(wDev, hDev, d)`: TRUE record pages a view can want at d (its span + the 1-deed margin ring). */
    fun pageDemand(wDev: Double, hDev: Double, d: Double): Int = ((ceil(wDev / d) + 3) * (ceil(hDev / d) + 3)).toInt()

    /** `recCapacity`: the TRUE record cache, sized from the screen, never below / above `REC_PAGES`. */
    fun recCapacity(wDev: Double, hDev: Double, d: Double): Int = minOf(G.REC_PAGES_MAX, maxOf(G.REC_PAGES_MIN, pageDemand(wDev, hDev, d)))
}
