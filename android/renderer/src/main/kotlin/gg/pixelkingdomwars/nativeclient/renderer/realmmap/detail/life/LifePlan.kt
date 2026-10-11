package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

/** A lattice window (scatter.js `latticeWindow`): first cell, cells per axis, world-aligned stride, the art-px margin. */
class PlanWindow {
    var ix0 = 0; var iy0 = 0; var nx = 0; var ny = 0; var stride = 1; var margin = 0.0
    fun set(o: PlanWindow) { ix0 = o.ix0; iy0 = o.iy0; nx = o.nx; ny = o.ny; stride = o.stride; margin = o.margin }
    fun clear() { ix0 = 0; iy0 = 0; nx = 0; ny = 0; stride = 1; margin = 0.0 }
}

/** One draw of a window's rank range [lo, hi) (scatter.js `rankDraw`): the plain window, or a rank window of blocks. */
class PlanRange {
    var lo = 0; var hi = 0; var count = 0
    var rl = false; var bx0 = 0; var by0 = 0; var nbx = 0; var nby = 0; var j0 = 0; var m = 0
}

class PlanGroup(val g: CGroup) {
    val win = PlanWindow()
    var on = false
    var keep = 1.0
    var kitK = 0; var twK = 0
    /** −1 = not set (the web's `undefined`: the group is off). */
    var truHi = -1; var keepHi = -1; var twinHi = -1
    val kit = PlanRange(); var hasKit = false
    val tw = PlanRange(); var hasTw = false
    /** A map-object group's twin draw is its kit draw (the web shares one object). */
    var twIsKit = false
    var count = 0
}

class PlanStands {
    var active = false
    val win = PlanWindow()
    var sites = 0; var keep = 1.0; var truHi = 0; var keepHi = 0
    val mem = PlanRange(); val clu = PlanRange()
    var members = 0; var clumps = 0; var merged = 0
    val mergedWin = PlanWindow(); var hasMergedWin = false
}

/** A keep-capped stream (herds/creatures, birds, one ambience emitter). */
class PlanStream(val kind: Int, val ambience: CAmbience?) {
    var active = false
    val win = PlanWindow()
    var count = 0; var keep = 1.0; var keep0 = Double.NaN
    var cap = 0; var scale = 1.0
    var pitchArt = 0; var per = 1; var k = 1
    companion object { const val CREATURES = 0; const val BIRDS = 1; const val AMBIENCE = 2 }
}

/**
 * One frame's LIFE draws (web `scatter.js` `planDraws`, pinned), allocation-free: per scatter group its lattice window
 * and rank ranges, the stands, herds/creatures, birds and ambience windows with their keep fractions, and the §9
 * submitted-instance ceiling (RM-20) fitted to pan-invariant cost bounds (W1). Every expression is the web's in the web's
 * order (golden vectors pin the result bit for bit); every buffer is allocated once per compiled realm.
 */
class LifePlanner(private val sc: Scatter, val life: CLife, private val bands: LifeBandsIn) {
    private val c = sc.c
    private val art = sc.geo.art.toDouble()
    private val deedArt = sc.geo.deedArt.toDouble()
    private val tiles = sc.geo.tilesPerDeed.toDouble()

    val groups: Array<PlanGroup> = Array(life.groups.size) { PlanGroup(life.groups[it]) }
    val stands = PlanStands()
    val creatures = PlanStream(PlanStream.CREATURES, null)
    val birds = PlanStream(PlanStream.BIRDS, null)
    val ambience: Array<PlanStream> = Array(life.ambience.size) { PlanStream(PlanStream.AMBIENCE, life.ambience[it]) }
    /** The ambience emitters drawn this frame, in the web's order (indices into [ambience]). */
    val ambienceOn = IntArray(life.ambience.size); var ambienceCount = 0
    var total = 0
    var cap = 0
    var trueOn = false
    var trueClasses = false
    /** planDraws returned before the plan (the view is outside the realm): only [trueClasses] and [total] = 0 hold. */
    var empty = true
    val tau = DoubleArray(4)
    var model = 0.0
    /** The ladder's cap (`RealmView.lifeCap`, plan §5.4: 40k at L0, halved at L1+); 0 = the web's per-device rule. */
    var capOverride = 0

    // THIN_ORDER tiers, pre-sorted once (the web sorts the on groups by a static rank every frame: the same order)
    private val tier1All: IntArray; private val tier3All: IntArray
    private val tier1 = IntArray(life.groups.size); private var tier1N = 0
    private val tier3 = IntArray(life.groups.size); private var tier3N = 0
    private val streams = arrayOfNulls<PlanStream>(2 + life.ambience.size); private var streamN = 0
    private val tmp = PlanWindow()

    init {
        fun rank(g: CGroup): Int { val i = c.thinOrder.indexOf(g.id); return if (i < 0) c.thinOrder.size else i }
        fun tier(twin: Boolean): IntArray = life.groups.indices.filter { !life.groups[it].mapOnly && life.groups[it].twin == twin }
            .sortedWith { a, b -> rank(life.groups[a]) - rank(life.groups[b]) }.toIntArray()
        tier1All = tier(false); tier3All = tier(true)
    }

    // ---- the frame's inputs (fields, not closures: the zero-allocation frame) ----
    private var d = 0.0; private var wTrue = 0.0; private var wTwin = 0.0
    /** The d (device px per deed) of the last [plan] ([LifeCost] prices the frame at it). */
    val planD: Double get() = d
    private var spW = 0.0; private var spH = 0.0
    private var rx0 = 0.0; private var ry0 = 0.0; private var rx1 = 0.0; private var ry1 = 0.0
    private var rampB = 0.0
    // stands state (st in planDraws)
    private var stOn = false; private var stKeep = 1.0; private var stMembers = false; private var stClumps = false
    private var stMemK = 0; private var stCluK = 0; private var stMw = false; private var stMergedB = Double.NaN; private var stTailB = Double.NaN
    private val stMwWin = PlanWindow()

    // ---------------------------------------------------------------- small rules

    private fun cellsB(p: Double, m: Double, s: Double = 1.0): Double = ((spW + 2 * m) / p / s + 2) * ((spH + 2 * m) / p / s + 2)
    private fun blocksB(p: Double, m: Double): Double = (((spW + 2 * m) / p + 1) / sc.rankB + 2) * (((spH + 2 * m) / p + 1) / sc.rankB + 2)
    private fun rlB(p: Double, m: Double, len: Double, slack: Double): Double = blocksB(p, m) * (sc.rankSlots * len + slack + 1e-3)
    private fun floorB(p: Double, m: Double, slack: Double = 1.0): Double = Math.min(cellsB(p, m), rlB(p, m, 0.0, slack))
    private fun epsB(p: Double, m: Double, len: Double, lenMax: Double, slack: Double): Double {
        if (!(len > 0)) return 0.0
        val pp = cellsB(p, m); val r = rlB(p, m, len, slack); val lenC = (pp / blocksB(p, m) - slack - 1e-3) / sc.rankSlots
        return if (lenMax <= lenC || len <= lenC) Math.min(pp, r) else Math.min(r, pp * (1 + c.thinEps * (len - lenC) / (lenMax - lenC)))
    }
    private fun after(t: Double): Double = JsMath.clamp(1 - JsMath.log(d / t) / JsMath.log(EASE), 0.0, 1.0)
    private fun before(t: Double): Double = JsMath.clamp(1 - JsMath.log(t / d) / JsMath.log(EASE), 0.0, 1.0)

    /** scatter.js `latticeWindow` into [out] from the frame rect. */
    private fun window(pitchArt: Int, marginArt: Double, stride: Int, out: PlanWindow) {
        val p = pitchArt.toDouble()
        var ix0 = Math.floor((rx0 - marginArt) / p); val ix1 = Math.floor((rx1 + marginArt) / p)
        var iy0 = Math.floor((ry0 - marginArt) / p); val iy1 = Math.floor((ry1 + marginArt) / p)
        if (stride > 1) {
            ix0 = Math.floor(ix0 / stride) * stride; iy0 = Math.floor(iy0 / stride) * stride
            out.ix0 = ix0.toInt(); out.iy0 = iy0.toInt()
            out.nx = Math.max(0.0, Math.floor((ix1 - ix0) / stride) + 1).toInt(); out.ny = Math.max(0.0, Math.floor((iy1 - iy0) / stride) + 1).toInt()
            out.stride = stride; out.margin = marginArt; return
        }
        out.ix0 = ix0.toInt(); out.iy0 = iy0.toInt()
        out.nx = Math.max(0.0, ix1 - ix0 + 1).toInt(); out.ny = Math.max(0.0, iy1 - iy0 + 1).toInt(); out.stride = 1; out.margin = marginArt
    }

    private fun floorDivD(a: Int, b: Int): Int = Math.floor(a.toDouble() / b).toInt()
    /** scatter.js `rankDraw(win, lo, hi)` into [out]. */
    fun rankDraw(win: PlanWindow, lo: Int, hi: Int, out: PlanRange) {
        val cells = win.nx * win.ny
        out.rl = false; out.lo = lo; out.hi = hi
        if (hi <= lo || cells == 0) { out.count = 0; return }
        if (lo <= 0 && hi >= 65536) { out.lo = 0; out.hi = 65536; out.count = cells; return }
        val bx0 = floorDivD(win.ix0, sc.rankB); val by0 = floorDivD(win.iy0, sc.rankB)
        val nbx = floorDivD(win.ix0 + win.nx - 1, sc.rankB) - bx0 + 1; val nby = floorDivD(win.iy0 + win.ny - 1, sc.rankB) - by0 + 1
        val j0: Int; val m: Int
        if (hi <= lo) { j0 = 0; m = 0 } else { j0 = Math.floor(lo.toDouble() / sc.rankStep).toInt(); m = Math.min(sc.rankSlots.toDouble(), Math.ceil(hi.toDouble() / sc.rankStep)).toInt() - j0 }
        val n = nbx * nby * m
        if (n < cells) { out.rl = true; out.bx0 = bx0; out.by0 = by0; out.nbx = nbx; out.nby = nby; out.j0 = j0; out.m = m; out.count = n }
        else out.count = cells
    }

    private fun kitK(g: CGroup, trueOnArg: Boolean, dd: Double): Int {
        val s = g.submit
        if (s == null) return if (g.mapOnly) 0 else 1
        return (if (!trueOnArg) s.kitMap else s.kit) + s.puffs
    }
    private fun twK(g: CGroup, dd: Double): Int {
        val twinNow = g.twin && dd < bands.trueFull
        val s = g.submit ?: return if (twinNow) 1 else 0
        return if (twinNow) s.twin else 0
    }

    private fun groupB(e: PlanGroup): Double {
        val g = e.g; val p = g.pitchArt.toDouble(); val m = g.maxExtent.toDouble(); val sub = g.submit
        if (!e.on) {
            val dOn = Math.max(if (g.mapOnly) bands.mapStart else if (g.twin) bands.twins0 else bands.trueStart, sc.minVisibleD(g.maxInkH.toDouble()))
            if (d <= dOn) {
                if (g.mapOnly || d * EASE <= dOn) return 0.0
                return (kitK(g, dOn > bands.trueStart, dOn) + twK(g, dOn)) * floorB(p, m) * before(dOn)
            }
            return if (g.mapOnly && d >= bands.trueFull) (if (sub != null) sub.kitMap + sub.puffs + sub.twin else 1) * Math.min(cellsB(p, m), rlB(p, m, e.keep, 1.0)) * after(bands.trueFull) else 0.0
        }
        if (g.mapOnly) return (e.kitK + e.twK) * Math.min(cellsB(p, m), rlB(p, m, e.keep, 1.0))
        if (!(e.keep > 0)) return 0.0
        if (!g.twin) return e.kitK * epsB(p, m, wTrue * e.keep, wTrue, 1.0)
        val tail = if (d >= bands.trueFull) (sub?.twin ?: 1) * floorB(p, m, 2.0) * after(bands.trueFull) else 0.0
        return e.kitK * epsB(p, m, wTwin * e.keep, wTwin, 1.0) + e.twK * epsB(p, m, (wTwin - wTrue) * e.keep, wTwin - wTrue, if (wTrue > 0) 2.0 else 1.0) + tail
    }

    private fun standsB(): Double {
        val s = life.stands ?: return 0.0
        val pa = s.pitchArt.toDouble(); val sm = c.standMargin.toDouble()
        return (if (stOn && stKeep > 0) (if (stMembers) stMemK * epsB(pa, sm, wTrue * stKeep, wTrue, 1.0) else 0.0) +
            (if (stClumps) stCluK * epsB(pa, sm, (1 - wTrue) * stKeep, 1 - wTrue, 2.0) else 0.0) else 0.0) +
            (if (stMergedB.isNaN()) 0.0 else stMergedB) + (if (stTailB.isNaN()) 0.0 else stTailB)
    }

    private fun streamsB(): Double {
        var a = rampB
        for (i in 0 until streamN) { val s = streams[i]!!; a += s.k * s.per * cellsB(s.pitchArt.toDouble(), s.win.margin, s.win.stride.toDouble()) }
        return a
    }

    private fun modelTotal(): Double {
        var a = 0.0
        for (e in groups) a += groupB(e)
        return a + standsB() + streamsB()
    }

    private fun setTier(tier: IntArray, n: Int, f: Double) { for (i in 0 until n) groups[tier[i]].keep = sc.thinFactor(i, n, f) }
    private fun applyTier(k: Int, f: Double) { when (k) { 1 -> setTier(tier1, tier1N, f); 2 -> stKeep = sc.thinFactor(0, 1, f); else -> setTier(tier3, tier3N, f) } }
    private fun fit(k: Int): Double {
        applyTier(k, 0.0); if (modelTotal() > cap) return 0.0
        var lo = 0.0; var hi = 1.0
        for (i in 0 until 40) { val mid = (lo + hi) / 2; applyTier(k, mid); if (modelTotal() > cap) hi = mid else lo = mid }
        applyTier(k, lo); return lo
    }
    private fun restream(s: PlanStream, n: Int) {
        if (s.count == 0 || (if (s.keep0.isNaN()) s.keep else s.keep0) * n * n > 1) return
        if (s.keep0.isNaN()) s.keep0 = s.keep
        window(s.pitchArt, s.win.margin, n, tmp); s.win.set(tmp)
        s.count = s.win.nx * s.win.ny * s.per; s.keep = s.keep0 * n * n
    }

    private fun maxDensity(a: IntArray): Double { var m = 0; for (v in a) m = Math.max(m, v); return m / 65535.0 }
    private fun birdsBigAt(x: Double): Boolean {
        val b = life.birds ?: return false
        val k = sc.skyScale(x, bands.trueFull)
        val sp = b.species
        for (i in sp.indices) if (sc.bigEnough(sp[i].sp.inkH.toDouble(), x, k)) return true // indexed: no iterator per frame
        return false
    }

    /**
     * scatter.js `planDraws(L, view)`: [x], [y] deed centre, [d] device px per deed, [w]/[h] CSS viewport, [dpr], [rm]
     * reduced motion. Bounds are [CLife]'s. Returns [total].
     */
    fun plan(x: Double, y: Double, dIn: Double, w: Double, h: Double, dpr: Double, rm: Boolean): Int {
        d = dIn
        trueClasses = d >= bands.pageResolve
        total = 0; ambienceCount = 0; streamN = 0; rampB = 0.0; empty = true
        for (e in groups) { e.on = false; e.hasKit = false; e.hasTw = false; e.twIsKit = false; e.count = 0; e.truHi = -1; e.keepHi = -1; e.twinHi = -1; e.win.clear() }
        stands.active = false; creatures.active = false; birds.active = false
        for (s in ambience) s.active = false
        val hw = w * dpr / d / 2; val hh = h * dpr / d / 2
        rx0 = (x - hw) * deedArt; ry0 = (y - hh) * deedArt; rx1 = (x + hw) * deedArt; ry1 = (y + hh) * deedArt
        rx0 = Math.max(rx0, life.bx0); ry0 = Math.max(ry0, life.by0); rx1 = Math.min(rx1, life.bx1); ry1 = Math.min(ry1, life.by1)
        if (rx1 <= rx0 || ry1 <= ry0) return 0
        empty = false
        val vw = (rx1 - rx0) / art; val vh = (ry1 - ry0) / art
        val fullW = w * dpr / d * tiles; val fullH = h * dpr / d * tiles
        wTrue = bands.lnT(d, bands.trueStart, bands.trueFull); wTwin = bands.lnT(d, bands.twins0, bands.twins1)
        trueOn = wTrue > 0
        spW = fullW * art; spH = fullH * art

        // ---- groups (G)
        for (e in groups) {
            val g = e.g
            val from = if (g.mapOnly) bands.mapStart else if (g.twin) bands.twins0 else bands.trueStart
            e.on = d >= from && (!g.mapOnly || d < bands.trueFull) && (g.mapOnly || g.twin || wTrue > 0) && sc.bigEnough(g.maxInkH.toDouble(), d)
            if (e.on) window(g.pitchArt, g.maxExtent.toDouble(), 1, e.win) else e.win.clear()
            e.keep = if (g.mapOnly) JsMath.clamp((c.capMapobj / Math.max(1.0, blocksB(g.pitchArt.toDouble(), g.maxExtent.toDouble())) - 1) / sc.rankSlots, 0.0, 1.0) else 1.0
            e.kitK = kitK(g, trueOn, d); e.twK = twK(g, d)
        }
        tier1N = 0; for (i in tier1All) if (groups[i].on) tier1[tier1N++] = i
        tier3N = 0; for (i in tier3All) if (groups[i].on) tier3[tier3N++] = i
        tau.fill(1.0)

        // ---- stands
        val s = life.stands
        stOn = false; stKeep = 1.0; stMembers = false; stClumps = false; stMw = false; stMergedB = Double.NaN; stTailB = Double.NaN; stMemK = 0; stCluK = 0
        val sm = c.standMargin.toDouble()
        if (s != null) {
            stMembers = wTrue > 0
            stClumps = d < bands.trueFull && d >= c.stand.splitFrom && s.maxInkH * d >= c.minSpritePx * deedArt
            stOn = stMembers || stClumps
            val ssMembers = s.submit?.members ?: 1; val ssClumps = s.submit?.clumps ?: 1
            stMemK = c.stand.members * ssMembers; stCluK = ssClumps
            val blocks = fullW * fullH / JsMath.pow((2 * c.stand.pitch).toDouble(), 2.0)
            val ms = if (blocks <= c.stand.mergeCap) 1 else if (blocks <= 4 * c.stand.mergeCap) 2 else 0
            if (ms != 0 && d >= c.stand.mergeFrom && d < s.mergeUntil && s.maxInkH.toDouble() * c.stand.merge * d >= c.minSpritePx * deedArt) {
                stMw = true; window(s.pitchArt * 2, sm * c.stand.merge, ms, stMwWin)
                stMergedB = stCluK * cellsB(s.pitchArt * 2.0, sm * c.stand.merge, ms.toDouble())
            } else if (d >= s.mergeUntil) stMergedB = stCluK * cellsB(s.pitchArt * 2.0, sm * c.stand.merge, 1.0) * after(s.mergeUntil)
            if (d >= bands.trueFull) stTailB = stCluK * floorB(s.pitchArt.toDouble(), sm, 2.0) * after(bands.trueFull)
        }
        if (s != null && !stMembers && d <= bands.trueStart) stTailB = (if (stTailB.isNaN()) 0.0 else stTailB) + stMemK * floorB(s.pitchArt.toDouble(), sm) * before(bands.trueStart)

        // ---- keep-capped streams
        val cr = life.creatures
        val herdMargin = (c.loopRadiusTiles * art + 64)
        if (cr != null && cr.species.isNotEmpty()) {
            val dOn = Math.max(bands.herds, sc.minVisibleD(cr.maxInkH.toDouble()))
            if (d < dOn) rampB += c.herdMax * cellsB(cr.pitchArt.toDouble(), herdMargin) * before(dOn)
        }
        if (cr != null && cr.species.isNotEmpty() && d >= bands.herds && sc.bigEnough(cr.maxInkH.toDouble(), d)) {
            val e = creatures
            window(cr.pitchArt, herdMargin, 1, e.win)
            val sites = vw * vh / (cr.pitch * cr.pitch)
            var mean = 0.0; val crs = cr.species; for (q in crs.indices) mean += (crs[q].herdMin + crs[q].herdMax) / 2.0
            mean /= cr.species.size
            e.cap = if (d >= bands.creatures) c.capCreatures else c.capHerds
            e.count = e.win.nx * e.win.ny * c.herdMax
            e.keep = sc.keepFraction(e.cap.toDouble(), sites * maxDensity(cr.density) * mean)
            e.keep0 = Double.NaN; e.pitchArt = cr.pitchArt; e.per = c.herdMax; e.k = 1; e.active = true
            streams[streamN++] = e
        }
        val b = life.birds
        if (b != null && b.species.isNotEmpty() && !rm) {
            if (!birdsBigAt(d) && birdsBigAt(d * EASE)) {
                var lo = d; var hi = d * EASE
                for (i in 0 until 24) { val mid = (lo + hi) / 2; if (birdsBigAt(mid)) hi = mid else lo = mid }
                val dOn = hi; val k = sc.skyScale(dOn, bands.trueFull)
                rampB += c.flockMax * (b.submit ?: 1) * cellsB(b.pitchArt.toDouble(), 12 * art + 160 * k) * before(dOn)
            }
            val k = sc.skyScale(d, bands.trueFull)
            if (birdsBigAt(d)) {
                val e = birds
                val reach = 12 * art + 160 * k
                window(b.pitchArt, reach, 1, e.win)
                val sites = (vw + 2 * reach / art) * (vh + 2 * reach / art) / (b.pitch * b.pitch)
                var mean = 0.0; val bs = b.species; for (q in bs.indices) mean += (bs[q].fMin + bs[q].fMax) / 2.0
                mean /= b.species.size
                e.count = e.win.nx * e.win.ny * c.flockMax
                e.keep = sc.keepFraction(c.capBirds.toDouble(), sites * b.p16 / 65535 * mean)
                e.scale = k; e.keep0 = Double.NaN; e.pitchArt = b.pitchArt; e.per = c.flockMax; e.k = b.submit ?: 1; e.active = true
                streams[streamN++] = e
            }
        }
        if (!rm) {
            var expected = 0.0
            val amb = life.ambience
            for (q in amb.indices) {
                val a = amb[q]
                val ink = sc.ambienceInk(a, bands.snap).toDouble()
                if (!sc.bigEnough(ink, d) && sc.bigEnough(ink, d * EASE)) rampB += cellsB(a.pitchArt.toDouble(), 160 + (a.alt ?: 0.0)) * before(sc.minVisibleD(ink))
            }
            for (i in amb.indices) {
                val a = amb[i]
                if (!sc.bigEnough(sc.ambienceInk(a, bands.snap).toDouble(), d)) continue
                val e = ambience[i]
                window(a.pitchArt, 160 + (a.alt ?: 0.0), 1, e.win)
                expected += vw * vh / JsMath.pow(a.pitchArt / art, 2.0) * maxDensity(a.density)
                e.count = e.win.nx * e.win.ny; e.active = true
                ambienceOn[ambienceCount++] = i
            }
            val keep = sc.keepFraction(c.capParticles.toDouble(), expected)
            for (j in 0 until ambienceCount) {
                val e = ambience[ambienceOn[j]]
                e.keep = keep; e.keep0 = Double.NaN; e.pitchArt = e.ambience!!.pitchArt; e.per = 1; e.k = 1
                streams[streamN++] = e
            }
        }

        // ---- the §9 ceiling (RM-20), fitted to the bounds (W1)
        cap = if (Math.min(w, h) <= c.phoneCssMax) c.submittedPhone else c.submittedDesktop
        if (capOverride > 0) cap = Math.min(cap, capOverride)
        if (modelTotal() > cap) {
            var n = 2
            while (n <= c.thinMax && modelTotal() > cap) {
                for (i in 0 until streamN) { if (modelTotal() <= cap) break; restream(streams[i]!!, n) }
                n *= 2
            }
            if (tier1N != 0 && modelTotal() > cap) tau[1] = fit(1)
            if ((if (stOn) 1 else 0) != 0 && modelTotal() > cap) tau[2] = fit(2)
            if (tier3N != 0 && modelTotal() > cap) tau[3] = fit(3)
        }
        model = modelTotal()

        // ---- the draws
        for (e in groups) {
            val g = e.g
            if (e.on && g.mapOnly) {
                e.truHi = 0; e.keepHi = sc.rankBound(e.keep); e.twinHi = e.keepHi
                rankDraw(e.win, 0, e.keepHi, e.kit); e.hasKit = true; e.hasTw = true; e.twIsKit = true
            } else if (e.on) {
                e.keepHi = sc.rankBound(e.keep); e.truHi = sc.rankBound(wTrue * e.keep); e.twinHi = if (g.twin) sc.rankBound(wTwin * e.keep) else 0
                rankDraw(e.win, 0, if (g.twin) e.twinHi else e.truHi, e.kit); e.hasKit = true
                if (g.twin && d < bands.trueFull) { rankDraw(e.win, e.truHi, e.twinHi, e.tw); e.hasTw = true }
            }
            e.count = if (e.hasKit) e.kit.count else 0
        }
        if (s != null && (stOn || stMw)) {
            val st = stands
            st.active = true
            if (stOn) window(s.pitchArt, sm, 1, st.win) else st.win.clear()
            st.keepHi = sc.rankBound(stKeep); st.truHi = sc.rankBound(wTrue * stKeep); st.keep = stKeep
            if (stMembers) rankDraw(st.win, 0, st.truHi, st.mem) else rankDraw(st.win, 0, 0, st.mem)
            if (stClumps) rankDraw(st.win, st.truHi, st.keepHi, st.clu) else rankDraw(st.win, 0, 0, st.clu)
            st.sites = st.win.nx * st.win.ny
            st.members = st.mem.count * c.stand.members; st.clumps = st.clu.count; st.merged = 0; st.hasMergedWin = false
            if (stMw) { st.merged = stMwWin.nx * stMwWin.ny; st.mergedWin.set(stMwWin); st.hasMergedWin = true }
        }
        total = submittedTotal()
        return total
    }

    /** scatter.js `submittedTotal(L, out, d)`. */
    fun submittedTotal(): Int {
        var a = 0
        for (e in groups) a += (if (e.hasKit) e.kit.count else 0) * e.kitK + (if (e.hasTw) (if (e.twIsKit) e.kit.count else e.tw.count) else 0) * e.twK
        val ss = life.stands?.submit
        if (stands.active) a += stands.members * (ss?.members ?: 1) + (stands.clumps + stands.merged) * (ss?.clumps ?: 1)
        if (creatures.active) a += creatures.count
        if (birds.active) a += birds.count * (life.birds?.submit ?: 1)
        for (j in 0 until ambienceCount) a += ambience[ambienceOn[j]].count
        return a
    }

    companion object {
        /** scatter.js planDraws: the phantom/phase-in span of a stream that starts or ends at a threshold (in d). */
        const val EASE = 1.1
    }
}

/**
 * The band inputs of the planner and of LIFE's draws: contracts.js BANDS values (generated constants) and camera.js
 * `bands(d).w`'s log fades, computed with fdlibm ([StrictMath]) like V8 so the golden vectors match bit for bit.
 */
class LifeBandsIn(
    val farEnd: Double, val mapStart: Double, val trueStart: Double, val trueFull: Double, val impostor0: Double, val impostor1: Double,
    val twins0: Double, val twins1: Double, val snap: Double, val herds: Double, val creatures: Double, val sway: Double, val pageResolve: Double,
) {
    private val edges: DoubleArray = run {
        val all = doubleArrayOf(farEnd, mapStart, trueStart, trueFull, impostor0, impostor1, twins0, twins1, snap)
        val out = ArrayList<Double>(); for (e in all) if (!out.contains(e)) out += e
        out.toDoubleArray()
    }
    fun snapEdge(d: Double): Double { for (e in edges) if (Math.abs(d - e) <= e * 1e-9) return e; return d }
    /** camera.js `lnT` on the snapped d. */
    fun lnT(d0: Double, a: Double, b: Double): Double {
        val d = snapEdge(d0)
        return JsMath.clamp((JsMath.log(d) - JsMath.log(a)) / (JsMath.log(b) - JsMath.log(a)), 0.0, 1.0)
    }

    companion object {
        fun fromGenerated(): LifeBandsIn {
            val b = gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Bands
            return LifeBandsIn(b.FAR_END.toDouble(), b.MAP_START.toDouble(), b.TRUE_START.toDouble(), b.TRUE_FULL.toDouble(), b.IMPOSTOR[0].toDouble(),
                b.IMPOSTOR[1].toDouble(), b.TWINS[0].toDouble(), b.TWINS[1].toDouble(), b.SNAP.toDouble(), b.HERDS.toDouble(), b.CREATURES.toDouble(),
                b.SWAY.toDouble(), b.PAGE_RESOLVE.toDouble())
        }
    }
}
