package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPlotRules
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath

/** A kingdom as the path network sees it: its id as the web writes it (`String(b.id)`), seed, deed and level. */
class PathBase(val id: String, val seed: Long, val x: Int, val y: Int, val level: Int)
class PathSegment(val ax: Double, val ay: Double, val bx: Double, val by: Double, val seed: Double)
class PathLink(val a: String, val b: String, val sa: String, val sb: String, val pts: List<DoubleArray>, val seed: Double)
/** The network (decor.js `basePaths`): segments, the sides each kingdom's lanes leave by, and the links. */
class PathNetwork(val segments: List<PathSegment>, val sides: LinkedHashMap<String, LinkedHashSet<String>>, val links: List<PathLink>)

/**
 * decor.js `basePathsJob`, as a resumable job: [step] does ONE unit of the web generator's work (64 kingdoms' plot boxes,
 * the deed grid, one kingdom's neighbour search, the pair sort, one link attempt) and returns true when the network is
 * done ([result]). However a caller slices it, the result equals the web's (it holds no clock; the bases must not change
 * while it runs). The paths are presentation: kingdoms make their own roads because the packs carry none.
 */
class BasePathsJob(private val bases: List<PathBase>, private val plots: RealmPlotRules, private val o: PathRules, private val tiles: Int) {
    private class P(val b: PathBase, val cx: Double, val cy: Double, val half: Double, val seed: Long, val ring: Int)
    private val p = arrayOfNulls<P>(bases.size)
    private val grid = HashMap<Long, ArrayList<Int>>()
    private val pairs = LinkedHashMap<String, IntArray>()
    private var order: List<Pair<String, IntArray>> = emptyList()
    private val segments = ArrayList<PathSegment>(); private val links = ArrayList<PathLink>()
    private val sides = LinkedHashMap<String, LinkedHashSet<String>>()
    private var phase = 0; private var i = 0; private var loneC: List<Int> = emptyList(); private var loneK = 0
    var result: PathNetwork? = null; private set
    val done: Boolean get() = result != null
    private val c = plots.plotCentre

    fun run(): PathNetwork { while (!step()) Unit; return result!! }

    /** One unit of work; true when the network is complete. */
    fun step(): Boolean {
        if (result != null) return true
        when (phase) {
            0 -> { // plot boxes, 64 a unit (the web yields when (i & 63) == 63)
                while (i < bases.size) {
                    val b = bases[i]; val r = plots.rule(b.level)
                    p[i] = P(b, b.x + (c + plots.offsetX(b.x, b.y, b.level)).toDouble() / tiles, b.y + (c + plots.offsetY(b.x, b.y, b.level)).toDouble() / tiles, r.plotTiles / 2.0 / tiles, b.seed, r.ring)
                    val yieldNow = (i and 63) == 63
                    i++
                    if (yieldNow) return false
                }
                phase = 1; return false
            }
            1 -> { for ((k, q) in p.withIndex()) grid.getOrPut(cellKey(Math.floor(q!!.cx).toInt(), Math.floor(q.cy).toInt())) { ArrayList() }.add(k); phase = 2; i = 0; return false }
            2 -> {
                if (i < p.size) {
                    val q = p[i]!!
                    val cand = near(q.cx, q.cy, o.maxDeeds).filter { it != i }.map { j -> JsMath.hypot(p[j]!!.cx - q.cx, p[j]!!.cy - q.cy) to j }
                        .filter { it.first <= o.maxDeeds }.sortedWith { a, b -> if (a.first != b.first) java.lang.Double.compare(a.first, b.first) else a.second - b.second }
                    for ((n, dj) in cand.take(2).withIndex()) {
                        val d = dj.first; val j = dj.second
                        if (n == 0 || d <= o.secondDeeds) pairs[if (i < j) "$i|$j" else "$j|$i"] = intArrayOf(Math.min(i, j), Math.max(i, j))
                    }
                    i++; return false
                }
                order = pairs.entries.map { it.key to it.value }.sortedWith { a, b -> if (a.first < b.first) -1 else 1 }
                phase = 3; i = 0; return false
            }
            3 -> {
                if (i < order.size) { val ij = order[i].second; tryLink(ij[0], ij[1]); i++; return false }
                phase = 4; i = 0; loneC = emptyList(); loneK = 0; return false
            }
            4 -> {
                // a kingdom whose pairs all failed walks on to its next-nearest neighbours up to loneDeeds
                while (i < p.size) {
                    val q = p[i]!!
                    if (loneK == 0) {
                        if (sides[q.b.id]?.isNotEmpty() == true) { i++; continue }
                        loneC = near(q.cx, q.cy, o.loneDeeds).filter { it != i }.map { j -> JsMath.hypot(p[j]!!.cx - q.cx, p[j]!!.cy - q.cy) to j }
                            .filter { it.first <= o.loneDeeds }.sortedWith { a, b -> if (a.first != b.first) java.lang.Double.compare(a.first, b.first) else a.second - b.second }
                            .take(6).map { it.second }
                    }
                    if (loneK < loneC.size) {
                        val j = loneC[loneK++]
                        val ok = !pairs.containsKey(if (i < j) "$i|$j" else "$j|$i") && tryLink(Math.min(i, j), Math.max(i, j))
                        if (ok || loneK >= loneC.size) { i++; loneK = 0 }
                        return false
                    }
                    i++; loneK = 0
                }
                result = PathNetwork(segments, sides, links); return true
            }
        }
        return false
    }

    private fun cellKey(x: Int, y: Int): Long = (x.toLong() shl 32) xor (y.toLong() and 0xffffffffL)
    private fun near(cx: Double, cy: Double, rr: Double): List<Int> {
        val out = ArrayList<Int>(); val r = Math.ceil(rr).toInt(); val fx = Math.floor(cx).toInt(); val fy = Math.floor(cy).toInt()
        for (dy in -r..r) for (dx in -r..r) grid[cellKey(fx + dx, fy + dy)]?.let { out.addAll(it) }
        return out
    }
    private fun inBox(q: P, x: Double, y: Double, m: Double) = Math.abs(x - q.cx) < q.half + m && Math.abs(y - q.cy) < q.half + m
    private fun sidesOf(a: P, b: P): Array<String> {
        val dx = b.cx - a.cx; val dy = b.cy - a.cy; val h = if (dx > 0) "E" else "W"; val v = if (dy > 0) "S" else "N"
        return if (Math.abs(dx) >= Math.abs(dy)) arrayOf(h, v) else arrayOf(v, h)
    }
    private fun sx(s: String) = when (s) { "E" -> 1; "W" -> -1; else -> 0 }
    private fun sy(s: String) = when (s) { "S" -> 1; "N" -> -1; else -> 0 }
    /** decor.js `exit`: where the side's lane meets the plot edge (laneMeander's end is 0 at the pin). */
    private fun exit(q: P, s: String): DoubleArray {
        val sh = 0.0 / tiles; val ns = s == "N" || s == "S"
        return doubleArrayOf(q.cx + sx(s) * q.half + (if (ns) sh else 0.0), q.cy + sy(s) * q.half + (if (ns) 0.0 else sh))
    }
    private fun tryLink(i: Int, j: Int): Boolean {
        val a = p[i]!!; val b = p[j]!!
        val h = JsMath.u32(gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash.kitHash(i * 7919 + j, 4241)) / 4294967296.0
        val others = near((a.cx + b.cx) / 2, (a.cy + b.cy) / 2, o.maxDeeds).filter { it != i && it != j }
        val m = o.clearTiles / tiles
        var bestSa: String? = null; var bestSb: String? = null; var bestPts: List<DoubleArray>? = null
        for (sa in sidesOf(a, b)) for (sb in sidesOf(b, a)) {
            if (bestPts != null) break
            val e1 = exit(a, sa); val e2 = exit(b, sb); val dist = JsMath.hypot(e2[0] - e1[0], e2[1] - e1[1])
            if (dist < 2.0 / tiles) continue
            val k = Math.max(3.0 / tiles, 0.4 * dist); val px = -(e2[1] - e1[1]) / dist; val py = (e2[0] - e1[0]) / dist; val bow = (h - 0.5) * 0.3 * dist
            val c1x = e1[0] + sx(sa) * k + px * bow; val c1y = e1[1] + sy(sa) * k + py * bow
            val c2x = e2[0] + sx(sb) * k + px * bow; val c2y = e2[1] + sy(sb) * k + py * bow
            val n = Math.max(4.0, Math.ceil((dist * tiles) / o.stepTiles)).toInt(); val pts = ArrayList<DoubleArray>()
            var ok = true; var s = 0
            while (s <= n && ok) {
                val t = s.toDouble() / n; val u = 1 - t
                val x = u * u * u * e1[0] + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * e2[0]
                val y = u * u * u * e1[1] + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * e2[1]
                pts += doubleArrayOf(x, y)
                if (s > 0 && s < n && (inBox(a, x, y, -1e-9) || inBox(b, x, y, -1e-9) || others.any { inBox(p[it]!!, x, y, m) })) ok = false
                s++
            }
            if (ok) { bestSa = sa; bestSb = sb; bestPts = pts }
        }
        val pts = bestPts ?: return false
        for (s in 0 until pts.size - 1) segments += PathSegment(pts[s][0], pts[s][1], pts[s + 1][0], pts[s + 1][1], h)
        links += PathLink(a.b.id, b.b.id, bestSa!!, bestSb!!, pts, h)
        sides.getOrPut(a.b.id) { LinkedHashSet() }.add(bestSa); sides.getOrPut(b.b.id) { LinkedHashSet() }.add(bestSb!!)
        return true
    }
}

/** decor.js `settlePath` result: segments (deed units) with ford/bridge flags and the crossings. */
class SettledSegment(val ax: Double, val ay: Double, val bx: Double, val by: Double, val ford: Boolean, val bridge: Boolean)
class Crossing(val axis: String, val kind: String, val from: DoubleArray, val to: DoubleArray)
class SettledPath(val segments: List<SettledSegment>, val crossings: List<Crossing>)

/** decor.js paths over terrain (`settlePath`, `bridgeSeats`), pure: the caller passes GROUND's class at a tile. */
class PathTerrainRules(private val o: PathTerrain, private val tiles: Int) {
    /**
     * One link over terrain → null (dropped: open water too wide, or a wet end) or its segments and crossings. Wet =
     * DEEP/SEA/WATER (class ≤ 2; Cinderfall's WATER is lava). A short run is bridged (or forded without a bridge piece) on
     * a straight axis, bank to bank.
     */
    fun settle(pts: List<DoubleArray>, clsAt: (Int, Int) -> Int, bridge: Boolean = true): SettledPath? {
        val tt = tiles.toDouble()
        fun wetAt(x: Double, y: Double) = clsAt(Math.floor(x).toInt(), Math.floor(y).toInt()) <= 2
        val pp = pts.map { doubleArrayOf(it[0] * tt, it[1] * tt) }
        val s = ArrayList<DoubleArray>()
        for (i in 0 until pp.size - 1) {
            val ax = pp[i][0]; val ay = pp[i][1]; val bx = pp[i + 1][0]; val by = pp[i + 1][1]
            val n = Math.max(1.0, Math.ceil(JsMath.hypot(bx - ax, by - ay) / o.step)).toInt()
            for (t in (if (i != 0) 1 else 0)..n) s += doubleArrayOf(ax + ((bx - ax) * t) / n, ay + ((by - ay) * t) / n, (if (t == n) i + 1 else i).toDouble())
        }
        val wet = BooleanArray(s.size) { wetAt(s[it][0], s[it][1]) }
        fun toSegs(list: List<DoubleArray>, spans: Map<Int, String>): List<SettledSegment> {
            val out = ArrayList<SettledSegment>()
            for (i in 0 until list.size - 1) {
                val a = list[i]; val b = list[i + 1]
                if (JsMath.hypot(b[0] - a[0], b[1] - a[1]) < 1e-6) continue
                out += SettledSegment(a[0] / tt, a[1] / tt, b[0] / tt, b[1] / tt, spans[i] == "ford", spans[i] == "bridge")
            }
            return out
        }
        if (!wet.contains(true)) return SettledPath(toSegs(pp, emptyMap()), emptyList())
        if (wet[0] || wet[wet.size - 1]) return null
        fun dryLine(p: DoubleArray, q: DoubleArray): Boolean {
            val n = Math.max(1.0, Math.ceil(JsMath.hypot(q[0] - p[0], q[1] - p[1]) / o.probe)).toInt()
            for (t in 0..n) if (wetAt(p[0] + ((q[0] - p[0]) * t) / n, p[1] + ((q[1] - p[1]) * t) / n)) return false
            return true
        }
        val maxSpan = if (bridge) o.maxBridge else o.maxFord
        val res = ArrayList<DoubleArray>(); res += pp[0]
        val spans = HashMap<Int, String>(); val crossings = ArrayList<Crossing>()
        var k = 0; var last = 0
        while (k < s.size) {
            if (!wet[k]) { k++; continue }
            var e = k; while (e < s.size && wet[e]) e++
            val a = s[k - 1]; val b = s[e]; val m = s[(k + e - 1) shr 1]; val ew = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1])
            val sgRaw = Math.signum(if (ew) b[0] - a[0] else b[1] - a[1]); val sg = if (sgRaw == 0.0) 1.0 else sgRaw
            fun at(t: Double) = if (ew) doubleArrayOf(m[0] + t * sg, m[1]) else doubleArrayOf(m[0], m[1] + t * sg)
            var lo = 0.0; var hi = 0.0
            while (at(lo - o.probe).let { wetAt(it[0], it[1]) }) { lo -= o.probe; if (hi - lo > maxSpan) return null }
            while (at(hi + o.probe).let { wetAt(it[0], it[1]) }) { hi += o.probe; if (hi - lo > maxSpan) return null }
            val pa = at(lo - 1); val pb = at(hi + 1); val a0 = at(lo - 1 - o.approach); val b0 = at(hi + 1 + o.approach)
            if (!dryLine(a, a0) || !dryLine(a0, pa) || !dryLine(pb, b0) || !dryLine(b0, b)) return null
            for (v in last + 1..a[2].toInt()) res += pp[v]
            res += a; res += a0; res += pa; spans[res.size - 1] = if (bridge) "bridge" else "ford"
            res += pb; res += b0; res += b
            crossings += Crossing(if (ew) "ew" else "ns", if (bridge) "bridge" else "ford", at(lo - o.probe), at(hi + o.probe))
            last = b[2].toInt(); k = e
        }
        for (v in last + 1 until pp.size) res += pp[v]
        return SettledPath(toSegs(res, spans), crossings)
    }

    /** decor.js `bridgeSeats`: kit bridge pieces along the crossing's axis, centred on the wet span (world tiles). */
    fun bridgeSeats(cr: Crossing, piece: DecorSprite): List<DoubleArray> {
        val fw = piece.fp[0].toDouble(); val fh = piece.fp[1].toDouble(); val ew = cr.axis == "ew"
        val len = Math.abs(if (ew) cr.to[0] - cr.from[0] else cr.to[1] - cr.from[1]) + 1
        val step = if (ew) Math.min(fw, (piece.ink[2] - piece.ink[0] - 1) * piece.scale) else Math.min(fh, (piece.ink[3] - piece.ink[1] - 1) * piece.scale)
        val n = Math.max(1.0, Math.ceil(len / step)).toInt(); val mx = (cr.from[0] + cr.to[0]) / 2; val my = (cr.from[1] + cr.to[1]) / 2
        val out = ArrayList<DoubleArray>()
        for (i in 0 until n) {
            val off = (i - (n - 1) / 2.0) * step
            if (ew) { val x0 = mx + off - fw / 2; val y0 = Math.floor(my - fh / 2 + 0.5); out += doubleArrayOf(x0 + fw / 2, y0 + fh, y0 + fh) }
            else { val x0 = Math.floor(mx - fw / 2 + 0.5); val y0 = my + off - fh / 2; out += doubleArrayOf(x0 + fw / 2, y0 + fh, y0 + fh) }
        }
        return out
    }
}
