package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Classes
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Flag
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPlotRules
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.SQRT2
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.TAU
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.jsHypot
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.kitHash
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.smax
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.unit24
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.vnoise
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.znoise
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.sqrt

/**
 * Decoded pack image texels (exact PNG bytes), addressed as the whole image of [width] × [height] × [channels]. Production
 * holds the whole image in one rect; the golden tests hold only crops, and a read outside every rect throws, so a crop
 * that is too small fails loudly instead of changing a class.
 */
class FieldImage(val width: Int, val height: Int, val channels: Int, private val rects: Array<Rect>) {
    class Rect(val x0: Int, val y0: Int, val w: Int, val h: Int, val data: ByteArray)

    constructor(width: Int, height: Int, channels: Int, data: ByteArray) : this(width, height, channels, arrayOf(Rect(0, 0, width, height, data)))

    fun at(i: Int, j: Int, ch: Int): Int {
        for (r in rects) {
            val x = i - r.x0; val y = j - r.y0
            if (x >= 0 && y >= 0 && x < r.w && y < r.h) return r.data[(y * r.w + x) * channels + ch].toInt() and 0xff
        }
        throw IllegalStateException("field texel ($i, $j) is outside every held rect of this ${width}x$height image")
    }

    fun set(i: Int, j: Int, ch: Int, v: Int) {
        for (r in rects) {
            val x = i - r.x0; val y = j - r.y0
            if (x >= 0 && y >= 0 && x < r.w && y < r.h) { r.data[(y * r.w + x) * channels + ch] = v.toByte(); return }
        }
        throw IllegalStateException("field texel ($i, $j) is outside every held rect")
    }

    /** The whole image's bytes (production images are one full rect). */
    fun fullData(): ByteArray { check(rects.size == 1 && rects[0].w == width && rects[0].h == height) { "a cropped image has no full data" }; return rects[0].data }
    fun holds(i: Int, j: Int): Boolean = rects.any { i >= it.x0 && j >= it.y0 && i < it.x0 + it.w && j < it.y0 + it.h }
}

/** classify.js `makeFields`: fieldsA RGB at 8 px/deed (coast SDF · lake SDF · relief), fieldsBC at 4 px/deed in two
 *  halves side by side (left forest, field, rock-paint · right snow, ground2, special). Tile-space samplers. */
class Fields(val a: FieldImage, val bc: FieldImage, private val tiles: Int, private val ppdA: Int = 8, private val ppdBC: Int = 4) {
    private val half: Int

    init {
        require(bc.width % 2 == 0) { "fieldsBC holds two halves side by side: its width ${bc.width} must be even" }
        half = bc.width / 2
    }

    /** classify.js `bilinear`: manual bilinear of one channel; texel i's centre sits at deed (i + 0.5)/ppd. */
    private fun bilinear(img: FieldImage, ppd: Int, x: Double, y: Double, ch: Int, x0: Int, w: Int): Double {
        val u = x * (ppd.toDouble() / tiles) - 0.5; val v = y * (ppd.toDouble() / tiles) - 0.5
        val i0 = floor(u); val j0 = floor(v); val fu = u - i0; val fv = v - j0
        val ii0 = i0.toInt(); val jj0 = j0.toInt(); val hgt = img.height
        fun at(i: Int, j: Int): Int {
            val ii = if (i < 0) 0 else if (i >= w) w - 1 else i
            val jj = if (j < 0) 0 else if (j >= hgt) hgt - 1 else j
            return img.at(x0 + ii, jj, ch)
        }
        val a = at(ii0, jj0).toDouble(); val b = at(ii0 + 1, jj0).toDouble(); val c = at(ii0, jj0 + 1).toDouble(); val d = at(ii0 + 1, jj0 + 1).toDouble()
        val top = a + (b - a) * fu; val bot = c + (d - c) * fu
        return top + (bot - top) * fv
    }

    fun coast(x: Double, y: Double): Double = (bilinear(a, ppdA, x, y, 0, 0, a.width) - 128) * 2
    fun lake(x: Double, y: Double): Double = (bilinear(a, ppdA, x, y, 1, 0, a.width) - 128) * 2
    fun relief(x: Double, y: Double): Double = bilinear(a, ppdA, x, y, 2, 0, a.width) / 255
    private fun bcAt(x: Double, y: Double, ch: Int, second: Boolean): Double = bilinear(bc, ppdBC, x, y, ch, if (second) half else 0, half) / 255
    fun forest(x: Double, y: Double) = bcAt(x, y, 0, false)
    fun field(x: Double, y: Double) = bcAt(x, y, 1, false)
    fun rock(x: Double, y: Double) = bcAt(x, y, 2, false)
    fun snow(x: Double, y: Double) = bcAt(x, y, 0, true)
    fun ground2(x: Double, y: Double) = bcAt(x, y, 1, true)
    fun special(x: Double, y: Double) = bcAt(x, y, 2, true)
}

/** classify.js `segSet`: a flat segment list [ax, ay, bx, by, hwA, hwB]… and per-deed index lists (insertion order kept,
 *  as the JS Map: the line bake assigns pages in this order). */
class SegSet(val segs: DoubleArray, val count: Int, val cells: LinkedHashMap<Int, IntArray>, val cols: Int, val rows: Int, val hwMin: Double,
             val dropped: Int) {
    /** bendRivers: vertices moved in its first pass, and plots whose river could not be cleared. */
    var moved = 0
    var blocked = 0
}

/** One meandered river / track polyline: [P] flat x, y…, [hw] per vertex. */
class LinePoly(val p: DoubleArray, val hw: DoubleArray)

/** classify.js `prepareLines` output. [polys] are the meandered river polylines bendRivers bends. */
class Lines(val rivers: SegSet, val tracks: SegSet, val cols: Int, val rows: Int, val polys: List<LinePoly>, val bad: Int)

/** One plot's geometry (classify.js `PLOT_GEOM[L]` at its G8 offset: `plotGeom(L, ox, oy)`). Deed-local tiles. */
class PlotGeom(val level: Int, val claim: Int, val ring: Int, val half: Double, val r: Double, val ox: Int, val oy: Int, val cx: Double, val cy: Double,
               val minX: Double, val maxX: Double, val minY: Double, val maxY: Double)

/**
 * The base state (plan §6.1): per deed RGBA — r kind, g flags ([Flag]), b claim tiles, a level. [off] pins a plot's G8
 * offset (tests only; the product always hashes). [bridges] / [rivers] are what ground.js keeps per state (plotBridges,
 * bendRivers); null means "compute from the state" as classify.js `bridgesFor` / `riversOf` do.
 */
class BaseState(val cols: Int, val rows: Int, val data: ByteArray, val off: Map<Int, IntArray>? = null) {
    var bridges: FloatArray? = null
    var rivers: SegSet? = null
}

/** Every intermediate of §3.2 at one vertex (classify.js `classDetail`). */
class ClassDetail {
    var plot = 0.0; var coast = 0.0; var inland = 0.0; var river = 0.0; var lake = 0.0; var track = 0.0; var bridge = 0.0; var island = 0.0
    var rock = Double.NaN
    var cls = Classes.WILD; var ground = Classes.WILD; var ring = false
}

/**
 * The CPU classifier: the pure reference of the GPU resolve passes (web `classify.js`, GROUND lane), ported 1:1 for
 * parity (golden vectors from the pinned JS over the real packs, exact). Coordinates are realm TILE VERTICES: tile =
 * deed · [tiles] + local. [plots] supplies the keep-level plot rules and offsets from the constants catalogue.
 * Not thread-safe (scratch state); one instance per thread.
 */
class Classify(val plots: RealmPlotRules) {
    val tiles: Int = plots.tiles
    private val plotCentre = plots.plotCentre.toDouble()
    private val maxLevel = plots.maxLevel

    // ---------------------------------------------------------------- plots

    /** classify.js `islandMaxMargin`: the largest island margin past the plot box (t). */
    fun islandMaxMargin(i: IslandCfg = ClassCfg.DEFAULT.island): Double = i.base + (SQRT2 - 1) * (i.corner - 3) + i.lobe + i.amp + i.amp2 + i.zig
    /** classify.js `islandReach`: past the plot box (Chebyshev, t), the island forcing is evaluated this far. */
    fun islandReach(i: IslandCfg = ClassCfg.DEFAULT.island): Double = islandMaxMargin(i) + i.halo + i.haloFade

    private val geom: Array<PlotGeom?> = arrayOfNulls(maxLevel + 1)
    private val offGeom = HashMap<Int, PlotGeom>()

    init {
        val d = ClassCfg.DEFAULT
        for (lv in 1..maxLevel) {
            val p = plots.rule(lv)
            val half = p.claim.toDouble() / 2 + p.ring + d.plotMargin
            val r = (half - d.cornerRadius) * SQRT2 + d.cornerRadius + islandMaxMargin()
            val mn = plotCentre - p.claim.toDouble() / 2; val mx = plotCentre + p.claim.toDouble() / 2
            geom[lv] = PlotGeom(lv, p.claim, p.ring, half, r, 0, 0, plotCentre, plotCentre, mn, mx, mn, mx)
        }
    }

    /** `PLOT_GEOM[L]` (L 1…maxLevel). */
    fun plotGeom(level: Int): PlotGeom = geom[level]!!

    /** classify.js `plotGeom(L, ox, oy)`. */
    fun plotGeom(level: Int, ox: Int, oy: Int): PlotGeom {
        val b = geom[level]!!
        if (ox == 0 && oy == 0) return b
        val key = level * 65536 + (ox + 128) * 256 + (oy + 128)
        return offGeom.getOrPut(key) {
            PlotGeom(level, b.claim, b.ring, b.half, b.r, ox, oy, plotCentre + ox, plotCentre + oy,
                (plotCentre - b.claim.toDouble() / 2) + ox, (plotCentre + b.claim.toDouble() / 2) + ox,
                (plotCentre - b.claim.toDouble() / 2) + oy, (plotCentre + b.claim.toDouble() / 2) + oy)
        }
    }

    /** classify.js `plotAt`: the plot of deed (dx, dy) at its G8 offset, or null (no base, out of grid). */
    fun plotAt(state: BaseState?, dx: Int, dy: Int): PlotGeom? {
        if (state == null || dx < 0 || dy < 0 || dx >= state.cols || dy >= state.rows) return null
        val k = dy * state.cols + dx; val i = k * 4
        if ((state.data[i + 1].toInt() and Flag.OCCUPIED) == 0 || state.data[i + 3].toInt() == 0) return null
        val lv = minOf(maxLevel, state.data[i + 3].toInt() and 0xff)
        state.off?.get(k)?.let { return plotGeom(lv, it[0], it[1]) }
        return plotGeom(lv, plots.offsetX(dx, dy, lv), plots.offsetY(dx, dy, lv))
    }

    private fun roundedBox(px: Double, py: Double, half: Double, r: Double): Double {
        val qx = abs(px) - (half - r); val qy = abs(py) - (half - r)
        val ox = maxOf(qx, 0.0); val oy = maxOf(qy, 0.0)
        return sqrt(ox * ox + oy * oy) + minOf(maxOf(qx, qy), 0.0) - r
    }

    private fun deedOf(v: Double): Int = floor(v / tiles).toInt()

    /** classify.js `plotSdf`: rounded-box SDF (t, < 0 inside) of every claimed plot in the 3×3 deeds. */
    fun plotSdf(state: BaseState?, x: Double, y: Double, cfg: ClassCfg): Double {
        val dx = deedOf(x); val dy = deedOf(y)
        var d = cfg.far
        for (j in -1..1) for (i in -1..1) {
            val g = plotAt(state, dx + i, dy + j) ?: continue
            val s = roundedBox(x - ((dx + i) * tiles + g.cx), y - ((dy + j) * tiles + g.cy), g.half, cfg.cornerRadius)
            if (s < d) d = s
        }
        return d
    }

    /** classify.js `rayBox`. */
    fun rayBox(ax: Double, ay: Double, h: Double, c: Double): Double {
        val t = minOf(if (ax > 1e-6) h / ax else 1e9, if (ay > 1e-6) h / ay else 1e9); val cc = h - c
        if (t * ax <= cc || t * ay <= cc) return t
        val s = (ax + ay) * cc
        return s + sqrt(maxOf(0.0, s * s - 2 * cc * cc + c * c))
    }

    /** classify.js `clearingSdf` (G9/G13). */
    fun clearingSdf(state: BaseState?, x: Double, y: Double, cfg: ClassCfg): Double {
        val dx = deedOf(x); val dy = deedOf(y); val c = cfg.clearing
        var d = cfg.far
        for (j in -1..1) for (i in -1..1) {
            val g = plotAt(state, dx + i, dy + j) ?: continue
            val h = g.half + c.extra; val ox = x - ((dx + i) * tiles + g.cx); val oy = y - ((dy + j) * tiles + g.cy); val r = sqrt(ox * ox + oy * oy)
            if (r > h * SQRT2 + c.lobe + c.amp + c.amp2) continue
            val s = r - clearingR(g, dx + i, dy + j, if (r > 1e-6) ox / r else 1.0, if (r > 1e-6) oy / r else 0.0, c)
            if (s < d) d = s
        }
        if (d >= cfg.far) return d
        return d - c.amp * (0.5 + 0.5 * vnoise(x, y, c.period, c.seed)) - c.amp2 * znoise(x, y, c.period2, c.seed2)
    }

    /** classify.js `clearingR` (G13). */
    fun clearingR(g: PlotGeom, dx: Int, dy: Int, ux: Double, uy: Double, c: ClearingCfg): Double {
        val h = g.half + c.extra; val seed = (kitHash(dx, dy) and 0x7fffffff) xor 0x3c1e
        val a2 = 0.6 + 0.4 * unit24(kitHash(1, seed)); val a3 = 0.3 + 0.4 * unit24(kitHash(2, seed))
        val q2 = TAU * unit24(kitHash(3, seed)); val q3 = TAU * unit24(kitHash(4, seed))
        val c2 = ux * ux - uy * uy; val s2 = 2 * ux * uy; val c3 = 4 * ux * ux * ux - 3 * ux; val s3 = 3 * uy - 4 * uy * uy * uy
        val n = (a2 * (c2 * StrictMath.cos(q2) + s2 * StrictMath.sin(q2)) + a3 * (c3 * StrictMath.cos(q3) + s3 * StrictMath.sin(q3))) / (a2 + a3)
        return rayBox(abs(ux), abs(uy), h, minOf(h, c.corner)) + c.lobe * (0.5 + 0.5 * n)
    }

    /** classify.js `claimDist`. */
    fun claimDist(g: PlotGeom, lx: Double, ly: Double): Double {
        val ex = maxOf(maxOf(g.minX - lx, 0.0), lx - g.maxX); val ey = maxOf(maxOf(g.minY - ly, 0.0), ly - g.maxY)
        return sqrt(ex * ex + ey * ey)
    }

    fun apronW(x: Double, y: Double, cfg: ClassCfg): Double { val a = cfg.apron; return a.min + a.amp * (0.5 + 0.5 * vnoise(x, y, a.period, a.seed)) }

    // ---------------------------------------------------------------- warps

    /** classify.js `waterWarp` (G14): the lake / coast lookup point. */
    fun waterWarpX(qx: Double, qy: Double, cfg: ClassCfg): Double {
        val w = cfg.lakeWarp ?: return qx
        return qx + w.amp * vnoise(qx, qy, w.period, w.seed) + w.amp2 * vnoise(qx, qy, w.period2, w.seed + 2)
    }
    fun waterWarpY(qx: Double, qy: Double, cfg: ClassCfg): Double {
        val w = cfg.lakeWarp ?: return qy
        return qy + w.amp * vnoise(qx, qy, w.period, w.seed + 1) + w.amp2 * vnoise(qx, qy, w.period2, w.seed + 3)
    }

    /** classify.js `classWarp` (G11). */
    fun classWarpX(x: Double, y: Double, cfg: ClassCfg): Double {
        val w = cfg.classWarp ?: return x
        val s = w.seed; val f = cfg.warpFine
        return x + w.amp * vnoise(x, y, w.period, s) + f * (w.amp2 * vnoise(x, y, w.period2, s + 2) + w.amp3 * vnoise(x, y, w.cell3, s + 5) + w.zig * znoise(x, y, w.zigCell, s + 7))
    }
    fun classWarpY(x: Double, y: Double, cfg: ClassCfg): Double {
        val w = cfg.classWarp ?: return y
        val s = w.seed; val f = cfg.warpFine
        return y + w.amp * vnoise(x, y, w.period, s + 1) + f * (w.amp2 * vnoise(x, y, w.period2, s + 3) + w.amp3 * vnoise(x, y, w.cell3, s + 6) + w.zig * znoise(x, y, w.zigCell, s + 8))
    }

    // ---------------------------------------------------------------- G16 islands

    private val shapeScratch = DoubleArray(6)

    /** classify.js `islandShape` → [c, base, h0, h1, h2, h3] in a reused array. */
    fun islandShape(g: PlotGeom, dx: Int, dy: Int, i: IslandCfg, out: DoubleArray = shapeScratch): DoubleArray {
        val seed = (kitHash(dx, dy) and 0x7fffffff) xor i.seed
        val c = minOf(3 + (i.corner - 3) * unit24(kitHash(5, seed)), g.half)
        val a2 = 0.5 + 0.5 * unit24(kitHash(1, seed)); val a3 = 0.2 + 0.4 * unit24(kitHash(2, seed))
        val q2 = TAU * unit24(kitHash(3, seed)); val q3 = TAU * unit24(kitHash(4, seed)); val nrm = 1 / (a2 + a3)
        out[0] = c; out[1] = i.base + (SQRT2 - 1) * (c - 3)
        out[2] = a2 * StrictMath.cos(q2) * nrm; out[3] = a2 * StrictMath.sin(q2) * nrm; out[4] = a3 * StrictMath.cos(q3) * nrm; out[5] = a3 * StrictMath.sin(q3) * nrm
        return out
    }

    /** classify.js `islandSdf`. */
    fun islandSdf(state: BaseState, x: Double, y: Double, cfg: ClassCfg): Double {
        val isl = cfg.island; val dx = deedOf(x); val dy = deedOf(y); val reach = islandReach(isl)
        var s = cfg.far
        for (j in -1..1) for (i in -1..1) {
            val g = plotAt(state, dx + i, dy + j) ?: continue
            val ox = x - ((dx + i) * tiles + g.cx); val oy = y - ((dy + j) * tiles + g.cy)
            if (maxOf(abs(ox), abs(oy)) - g.half > reach) continue
            val p = islandShape(g, dx + i, dy + j, isl); val r = sqrt(ox * ox + oy * oy)
            val ux = if (r > 1e-6) ox / r else 1.0; val uy = if (r > 1e-6) oy / r else 0.0
            val n = p[2] * (ux * ux - uy * uy) + p[3] * 2 * ux * uy + p[4] * (4 * ux * ux * ux - 3 * ux) + p[5] * (3 * uy - 4 * uy * uy * uy)
            val v = roundedBox(ox, oy, g.half, p[0]) - p[1] - isl.lobe * (0.5 + 0.5 * n)
            if (v < s) s = v
        }
        if (s >= cfg.far) return s
        return s - isl.amp * (0.5 + 0.5 * vnoise(x, y, isl.period, isl.seed)) - isl.amp2 * (0.5 + 0.5 * vnoise(x, y, isl.period2, isl.seed + 1)) -
            isl.zig * (0.5 + 0.5 * znoise(x, y, isl.zigCell, isl.seed + 2))
    }

    /** classify.js `islandForce`. */
    fun islandForce(state: BaseState, x: Double, y: Double, cfg: ClassCfg): Double {
        val s = islandSdf(state, x, y, cfg); if (s >= cfg.far) return -cfg.far
        val i = cfg.island; val u = minOf(1.0, maxOf(0.0, (s - i.halo) / i.haloFade))
        return if (s <= 0) -s else -s * i.slope * (1 + i.shallow * vnoise(x, y, i.shallowPeriod, i.seed + 3)) - i.haloDeep * u * u * (3 - 2 * u)
    }

    // ---------------------------------------------------------------- lines

    /** classify.js `LINE_CAP`. */
    val lineCapPerDeed = 128
    val lineCapMargin: Double get() = 2.0 * tiles
    val lineCapHwMax = 49.0

    /**
     * classify.js `prepareLines(json, {cols, rows}, cfg)`: lines.json → per-deed segment sets (rivers meandered, G14).
     * Non-finite points split a polyline; coordinates clamp to the grid ± 2 deeds; half-widths clamp to [hwMin, 49].
     */
    fun prepareLines(json: JsonValue?, cols: Int, rows: Int, cfg: ClassCfg, lines: LinesCfg = LinesCfg.DEFAULT): Lines {
        var bad = 0
        val x1 = cols.toDouble() * tiles + lineCapMargin; val y1 = rows.toDouble() * tiles + lineCapMargin; val lo = -lineCapMargin
        fun polysOf(list: JsonValue?, hwMin: Double, mea: MeanderCfg?): List<LinePoly> {
            val out = ArrayList<LinePoly>()
            if (list == null || !list.isArray) return out
            var l = list.child
            while (l != null) {
                val pts = l.get("pts")
                val raw = ArrayList<Double>()
                if (pts != null && pts.isArray) {
                    val first = pts.child
                    if (first != null && first.isArray) { var p = pts.child; while (p != null) { if (p.isArray) { var q = p.child; while (q != null) { raw += jsNumber(q); q = q.next } } else raw += jsNumber(p); p = p.next } }
                    else { var p = pts.child; while (p != null) { raw += jsNumber(p); p = p.next } }
                }
                val hwJ = l.get("hw")
                // Number.isFinite(h): only a real number counts (no coercion), else hwMin
                fun hwRaw(i: Int): Double {
                    val h: Double? = if (hwJ != null && hwJ.isArray) {
                        val n = hwJ.size
                        val e = if (i < n) hwJ.get(i) else null
                        val v = if (e != null && !e.isNull) e else if (n > 0) hwJ.get(n - 1) else null
                        if (v != null && v.isNumber) v.asDouble() else null
                    } else if (hwJ != null && hwJ.isNumber) hwJ.asDouble() else null
                    return if (h != null && h.isFinite()) minOf(h, lineCapHwMax) else hwMin
                }
                val runs = ArrayList<Pair<ArrayList<Double>, ArrayList<Double>>>()
                var cur: Pair<ArrayList<Double>, ArrayList<Double>>? = null
                var i = 0
                while (2 * i + 1 < raw.size) {
                    val x = raw[2 * i]; val y = raw[2 * i + 1]
                    if (!x.isFinite() || !y.isFinite()) { bad++; cur = null; i++; continue }
                    if (cur == null) { cur = Pair(ArrayList(), ArrayList()); runs += cur }
                    cur.first += minOf(x1, maxOf(lo, x)); cur.first += minOf(y1, maxOf(lo, y)); cur.second += hwRaw(i)
                    i++
                }
                for ((pList, hwList) in runs) {
                    if (pList.size < 4) continue
                    var pArr = pList.toDoubleArray()
                    var hwArr: DoubleArray
                    if (mea != null) {
                        val m = meander(pArr, DoubleArray(hwList.size) { maxOf(hwMin, hwList[it]) }, mea)
                        pArr = m.first; hwArr = DoubleArray(m.second.size) { maxOf(hwMin, m.second[it]) }
                    } else hwArr = DoubleArray(hwList.size) { maxOf(hwMin, hwList[it]) }
                    out += LinePoly(pArr, hwArr)
                }
                l = l.next
            }
            return out
        }
        val rivers = polysOf(json?.get("rivers"), lines.riverHwMin, cfg.riverMeander)
        val tracks = polysOf(json?.get("tracks"), lines.trackHwMin, null)
        return Lines(segSet(rivers, cols, rows, lines.riverHwMin), segSet(tracks, cols, rows, lines.trackHwMin), cols, rows, rivers, bad)
    }

    /** classify.js `meander` (G14): resampled every step t, displaced by one smooth 2-D field, half-widths × (1 ± hw). */
    fun meander(p: DoubleArray, hwAt: DoubleArray, m: MeanderCfg): Pair<DoubleArray, DoubleArray> {
        val out = ArrayList<Double>(); val hw = ArrayList<Double>(); val n = p.size / 2; val s = m.seed
        fun push(x: Double, y: Double, h: Double) {
            out += x + m.amp * vnoise(x, y, m.period, s) + m.amp2 * vnoise(x, y, m.period2, s + 2)
            out += y + m.amp * vnoise(x, y, m.period, s + 1) + m.amp2 * vnoise(x, y, m.period2, s + 3)
            hw += h * (1 + m.hw * vnoise(x, y, m.hwPeriod, s + 4))
        }
        for (i in 0 until n - 1) {
            val ax = p[2 * i]; val ay = p[2 * i + 1]; val bx = p[2 * i + 2]; val by = p[2 * i + 3]
            val k = maxOf(1.0, ceil(jsHypot(bx - ax, by - ay) / m.step)).toInt()
            for (j in 0 until k) { val t = j.toDouble() / k; push(ax + (bx - ax) * t, ay + (by - ay) * t, hwAt[i] + (hwAt[i + 1] - hwAt[i]) * t) }
        }
        if (n > 0) push(p[2 * n - 2], p[2 * n - 1], hwAt[n - 1])
        return Pair(out.toDoubleArray(), hw.toDoubleArray())
    }

    /** classify.js `segSet`: per-deed segment lists, each capped at [cap] (nearest / widest kept). */
    fun segSet(polys: List<LinePoly>, cols: Int, rows: Int, hwMin: Double, cap: Int = lineCapPerDeed): SegSet {
        val segsL = ArrayList<Double>()
        for (pl in polys) { val pp = pl.p; val hw = pl.hw; var i = 0; while (i + 1 < pp.size / 2) { segsL += pp[2 * i]; segsL += pp[2 * i + 1]; segsL += pp[2 * i + 2]; segsL += pp[2 * i + 3]; segsL += hw[i]; segsL += hw[i + 1]; i++ } }
        val s = segsL.toDoubleArray(); val count = s.size / 6
        val cells = LinkedHashMap<Int, IntList>()
        val reach = 8.0
        for (seg in 0 until count) {
            val o = seg * 6; val pad = maxOf(s[o + 4], s[o + 5]) + reach
            val dx0 = maxOf(0.0, floor((minOf(s[o], s[o + 2]) - pad) / tiles)).toInt(); val dx1 = minOf((cols - 1).toDouble(), floor((maxOf(s[o], s[o + 2]) + pad) / tiles)).toInt()
            val dy0 = maxOf(0.0, floor((minOf(s[o + 1], s[o + 3]) - pad) / tiles)).toInt(); val dy1 = minOf((rows - 1).toDouble(), floor((maxOf(s[o + 1], s[o + 3]) + pad) / tiles)).toInt()
            for (dy in dy0..dy1) for (dx in dx0..dx1) cells.getOrPut(dy * cols + dx) { IntList() }.add(seg)
        }
        var dropped = 0
        val seg = SegEval()
        val out = LinkedHashMap<Int, IntArray>()
        for ((k, a) in cells) {
            var arr = a.toArray()
            if (arr.size > cap) {
                val cx = (k % cols).toDouble() * tiles + tiles.toDouble() / 2; val cy = (k / cols).toDouble() * tiles + tiles.toDouble() / 2
                val key = HashMap<Int, Double>()
                for (sg in arr) { seg.eval(s, sg * 6, cx, cy, hwMin); key[sg] = seg.dist - seg.hw }
                val sorted = arr.toTypedArray().sortedWith { p, q -> val c = key[p]!!.compareTo(key[q]!!); if (c != 0) c else p - q }
                dropped += arr.size - cap
                arr = sorted.take(cap).sorted().toIntArray()
            }
            out[k] = arr
        }
        return SegSet(s, count, out, cols, rows, hwMin, dropped)
    }

    /** classify.js `strokeSdf` → [StrokeResult] (sdf, amp; amp = +∞ with no river within hw + reach). */
    fun strokeSdf(set: SegSet, qx: Double, qy: Double, cfg: ClassCfg, river: Boolean, out: StrokeResult, lines: LinesCfg = LinesCfg.DEFAULT): StrokeResult {
        var sdf = cfg.far; var amp = Double.POSITIVE_INFINITY
        val dx = deedOf(qx); val dy = deedOf(qy)
        val list = if (dx < 0 || dy < 0 || dx >= set.cols || dy >= set.rows) null else set.cells[dy * set.cols + dx]
        if (list != null) {
            val seg = out.seg
            for (n in list) {
                seg.eval(set.segs, n * 6, qx, qy, set.hwMin); val s = seg.dist - seg.hw
                if (s < sdf) sdf = s
                if (river && seg.dist <= seg.hw + cfg.riverNoiseReach) amp = minOf(amp, lines.riverNoiseK * (seg.hw - 0.5))
            }
        }
        out.sdf = sdf; out.amp = amp
        return out
    }

    // ---------------------------------------------------------------- G16 bends

    private fun boxSupport(h: Double, c: Double, nx: Double, ny: Double): Double = (h - c) * (abs(nx) + abs(ny)) + c

    /** classify.js `bendRivers` (G16): the river set bent one-sided round the plots of [state]. */
    fun bendRivers(lines: Lines, state: BaseState, cfg: ClassCfg, linesCfg: LinesCfg = LinesCfg.DEFAULT): SegSet {
        val polys = lines.polys
        if (polys.isEmpty()) return lines.rivers
        val b = cfg.bend; val cols = lines.cols; val rows = lines.rows; val maxM = cfg.force + 1
        val cur = polys.map { it.p.copyOf() }
        val cw = cols + 8
        fun ck(x: Int, y: Int) = (y + 2) * cw + x + 2
        var moved = 0; var blocked = 0
        val corner = ClassCfg.DEFAULT.cornerRadius
        for (it in 0 until b.iters) {
            val cell = LinkedHashMap<Int, IntList>()
            for ((pi, p) in cur.withIndex()) {
                var i = 0
                while (i + 1 < p.size / 2) {
                    val dx = floor((p[2 * i] + p[2 * i + 2]) / 2 / tiles).toInt(); val dy = floor((p[2 * i + 1] + p[2 * i + 3]) / 2 / tiles).toInt()
                    if (!(dx < -1 || dy < -1 || dx > cols || dy > rows)) { val a = cell.getOrPut(ck(dx, dy)) { IntList() }; a.add(pi); a.add(i) }
                    i++
                }
            }
            val pushes = LinkedHashMap<Int, DoubleArray>(); blocked = 0
            val seen = HashSet<Int>()
            for (k in cell.keys) {
                val cy0 = Math.floorDiv(k, cw) - 2; val cx0 = Math.floorMod(k, cw) - 2
                for (j in -1..1) for (i in -1..1) {
                    val xx = cx0 + i; val yy = cy0 + j; val key = yy * cols + xx
                    if (xx < 0 || yy < 0 || xx >= cols || yy >= rows || seen.contains(key)) continue
                    seen.add(key)
                    val g = plotAt(state, xx, yy) ?: continue
                    val cX = xx.toDouble() * tiles + g.cx; val cY = yy.toDouble() * tiles + g.cy
                    val near = IntList()
                    for (jj in -1..1) for (ii in -1..1) { val a = cell[ck(xx + ii, yy + jj)]; if (a != null) { var q = 0; while (q < a.size) { near.add(a[q]); near.add(a[q + 1]); q += 2 } } }
                    var worst = Double.NEGATIVE_INFINITY; var nx = 0.0; var ny = 0.0
                    val cand = ArrayList<Double>()
                    var q = 0
                    while (q < near.size) {
                        val pp = cur[near[q]]; val hw = polys[near[q]].hw; val s = near[q + 1]
                        val ax = pp[2 * s]; val ay = pp[2 * s + 1]; val ex = pp[2 * s + 2] - ax; val ey = pp[2 * s + 3] - ay; val l2 = ex * ex + ey * ey
                        val t = if (l2 > 0) maxOf(0.0, minOf(1.0, ((cX - ax) * ex + (cY - ay) * ey) / l2)) else 0.0
                        val qx = ax + ex * t - cX; val qy = ay + ey * t - cY; val d = jsHypot(qx, qy)
                        val h = hw[s] + (hw[s + 1] - hw[s]) * t
                        val ux: Double; val uy: Double
                        if (d > 1e-6) { ux = qx / d; uy = qy / d } else {
                            val ln = sqrt(l2).let { if (it == 0.0 || it.isNaN()) 1.0 else it }
                            val sg = if (kitHash(xx xor b.seed, yy) and 1 != 0) 1.0 else -1.0
                            ux = -ey / ln * sg; uy = ex / ln * sg
                        }
                        val need = boxSupport(g.half, corner, ux, uy) + maxM + h + b.clear
                        cand += qx; cand += qy; cand += h
                        if (need - d > worst) { worst = need - d; nx = ux; ny = uy }
                        q += 2
                    }
                    if (!(worst > 0.01)) continue
                    var aa = 0.0; var need0 = 0.0
                    var c = 0
                    while (c < cand.size) {
                        val need = boxSupport(g.half, corner, nx, ny) + maxM + cand[c + 2] + b.clear; val along = cand[c] * nx + cand[c + 1] * ny
                        val across = abs(cand[c] * ny - cand[c + 1] * nx)
                        if (across > need) { c += 3; continue }
                        if (along < -need * 0.25) { blocked++; c += 3; continue }
                        val a = sqrt(maxOf(0.0, need * need - across * across)) - along; if (a > aa) aa = a
                        need0 = maxOf(need0, need)
                        c += 3
                    }
                    if (aa > 0.01) pushes[key] = doubleArrayOf(cX, cY, nx, ny, aa, need0, need0 + maxOf(b.taper, b.taperK * aa))
                }
            }
            if (pushes.isEmpty()) break
            val byDeed = HashMap<Int, ArrayList<DoubleArray>>()
            for (v in pushes.values) {
                val xx = floor(v[0] / tiles).toInt(); val yy = floor(v[1] / tiles).toInt()
                for (j in -2..2) for (i in -2..2) byDeed.getOrPut(ck(xx + i, yy + j)) { ArrayList() }.add(v)
            }
            for (p in cur) for (i in 0 until p.size / 2) {
                val x = p[2 * i]; val y = p[2 * i + 1]
                val a = byDeed[ck(floor(x / tiles).toInt(), floor(y / tiles).toInt())] ?: continue
                var mx = 0.0; var my = 0.0
                for (v in a) {
                    val r = jsHypot(x - v[0], y - v[1]); if (r >= v[6]) continue
                    val f = if (r <= v[5]) 1.0 else { val u = (r - v[5]) / (v[6] - v[5]); 1 - u * u * (3 - 2 * (r - v[5]) / (v[6] - v[5])) }
                    mx += v[4] * v[2] * f; my += v[4] * v[3] * f
                }
                if ((mx != 0.0 && !mx.isNaN()) || (my != 0.0 && !my.isNaN())) { p[2 * i] = x + mx; p[2 * i + 1] = y + my; if (it == 0) moved++ }
            }
        }
        val out = segSet(cur.mapIndexed { i, p -> LinePoly(p, polys[i].hw) }, cols, rows, linesCfg.riverHwMin)
        out.moved = moved; out.blocked = blocked
        return out
    }

    private val bent = java.util.WeakHashMap<Lines, java.util.WeakHashMap<BaseState, SegSet>>()

    /** classify.js `riversOf`: the river set drawn for [state]: its kept `rivers` (ground.js), else bent once per
     *  (lines, state) pair and cached by identity (the JS WeakMap), never written onto the state. */
    fun riversOf(lines: Lines, state: BaseState?, cfg: ClassCfg): SegSet {
        if (state == null) return lines.rivers
        state.rivers?.let { return it }
        return bent.getOrPut(lines) { java.util.WeakHashMap() }.getOrPut(state) { bendRivers(lines, state, cfg) }
    }

    // ---------------------------------------------------------------- G15 bridges

    private val sw = StrokeResult()

    /** classify.js `srcWater` → coast, lake, river into [out] (0, 1, 2). */
    private fun srcWater(fields: Fields, rivers: SegSet?, x: Double, y: Double, cfg: ClassCfg, out: DoubleArray) {
        val cn = cfg.coastNoise; val c2 = cfg.coastNoise2; val wx = waterWarpX(x, y, cfg); val wy = waterWarpY(x, y, cfg)
        out[0] = fields.coast(wx, wy) + cn.amp * vnoise(x, y, cn.period, cn.seed) + c2.amp * vnoise(x, y, c2.period, c2.seed)
        out[2] = if (rivers != null) strokeSdf(rivers, x, y, cfg, true, sw).sdf else cfg.far
        out[1] = fields.lake(wx, wy)
    }

    private fun inWater(s: DoubleArray) = s[0] < 0 || s[1] < 0

    /** classify.js `bridgeOf` → the unpacked bridge [ux, uy, len, hw] (float32 values) or null. */
    fun bridgeOf(fields: Fields, lines: Lines?, state: BaseState, dx: Int, dy: Int, cfg: ClassCfg): DoubleArray? {
        val g = plotAt(state, dx, dy) ?: return null
        val b = cfg.bridge; val isl = cfg.island; val cx = dx.toDouble() * tiles + g.cx; val cy = dy.toDouble() * tiles + g.cy
        val rv = if (lines != null) riversOf(lines, state, cfg) else null
        val s = DoubleArray(3)
        srcWater(fields, rv, cx, cy, cfg, s)
        if (!inWater(s)) return null
        val mean = isl.base + 0.5 * (isl.lobe + isl.amp + isl.amp2 + isl.zig)
        val corner = ClassCfg.DEFAULT.cornerRadius
        fun ext(ux: Double, uy: Double) = rayBox(abs(ux), abs(uy), g.half, corner) + mean
        var bestKey = 0.0; var bestGap = 0.0; var bestUx = 0.0; var bestUy = 0.0; var bestSrc = 0.0; var bestReach = 0.0; var bestLen = Double.NaN; var has = false
        val rMax = ceil(g.r + b.max + 3).toInt()
        for (k in 0 until b.dirs) {
            val th = TAU * k / b.dirs; val ux = StrictMath.cos(th); val uy = StrictMath.sin(th)
            var start = -1; var first = -1; var refused = false
            for (r in 0..rMax) {
                srcWater(fields, rv, cx + ux * r, cy + uy * r, cfg, s)
                if (s[2] < 0 && !inWater(s)) { refused = true; break }
                if (inWater(s) || s[2] < 0) { start = -1; continue }
                if (start < 0) start = r
                if (r - start + 1 >= 3) { first = start; break }
            }
            if (refused || first < 0) continue
            srcWater(fields, rv, cx + ux * (first + 12), cy + uy * (first + 12), cfg, s)
            val gap = first - ext(ux, uy); val key = gap - 0.01 * minOf(minOf(s[0], s[1]), minOf(s[2], 60.0))
            if (!has || key < bestKey) { has = true; bestKey = key; bestGap = gap; bestUx = ux; bestUy = uy; bestSrc = first.toDouble(); bestReach = ext(ux, uy); bestLen = Double.NaN }
        }
        for (j in -1..1) for (i in -1..1) {
            if (i == 0 && j == 0) continue
            val h = plotAt(state, dx + i, dy + j) ?: continue
            val hx = (dx + i).toDouble() * tiles + h.cx - cx; val hy = (dy + j).toDouble() * tiles + h.cy - cy; val d = jsHypot(hx, hy)
            srcWater(fields, rv, cx + hx, cy + hy, cfg, s)
            if (!inWater(s)) continue
            val gap = d - ext(hx / d, hy / d) - (rayBox(abs(hx / d), abs(hy / d), h.half, corner) + mean)
            if (gap > b.max || (has && gap >= bestGap)) continue
            var river = false
            var t = 0.0
            while (t < d) { srcWater(fields, rv, cx + hx / d * t, cy + hy / d * t, cfg, s); if (s[2] < 0) { river = true; break }; t += 1.5 }
            if (!river) { has = true; bestKey = gap; bestGap = gap; bestUx = hx / d; bestUy = hy / d; bestLen = d; bestReach = ext(hx / d, hy / d) }
        }
        if (!has || bestGap > b.max) return null
        val len = if (!bestLen.isNaN()) bestLen else maxOf(bestSrc + 3, bestReach + 4)
        val w = if (bestLen.isNaN() && bestGap <= 0.6 * bestReach) 0.85 * bestReach else b.w + b.wAdd * unit24(kitHash(dx xor 0x2d, dy xor b.seed))
        return ClassBake.unpackBridge(ClassBake.packBridge(bestUx, bestUy, minOf(len, 80.0), w))
    }

    /** classify.js `plotBridges` for [deeds] (null = every deed) into [into] (cols × rows × 4 float32). */
    fun plotBridges(fields: Fields, lines: Lines?, state: BaseState, cfg: ClassCfg, into: FloatArray? = null, deeds: IntArray? = null): FloatArray {
        val out = into ?: FloatArray(state.cols * state.rows * 4)
        val list = deeds ?: IntArray(state.cols * state.rows) { it }
        for (k in list) {
            val r = bridgeOf(fields, lines, state, k % state.cols, k / state.cols, cfg)
            if (r == null) { out[k * 4] = 0f; out[k * 4 + 1] = 0f; out[k * 4 + 2] = 0f; out[k * 4 + 3] = 0f }
            else { out[k * 4] = r[0].toFloat(); out[k * 4 + 1] = r[1].toFloat(); out[k * 4 + 2] = r[2].toFloat(); out[k * 4 + 3] = r[3].toFloat() }
        }
        return out
    }

    private class BridgeEntry(val fields: Fields, val lines: Lines?, val bridges: FloatArray)
    private val bridgeCache = java.util.WeakHashMap<BaseState, BridgeEntry>()

    /** classify.js `bridgesFor`: [state]'s kept bridges (ground.js), else every plot's, computed once per (state, fields,
     *  lines) and cached by identity (the JS WeakMap), never written onto the state. */
    fun bridgesFor(fields: Fields, lines: Lines?, state: BaseState?, cfg: ClassCfg): FloatArray? {
        if (state == null) return null
        state.bridges?.let { return it }
        val e = bridgeCache[state]
        if (e != null && e.fields === fields && e.lines === lines) return e.bridges
        return plotBridges(fields, lines, state, cfg).also { bridgeCache[state] = BridgeEntry(fields, lines, it) }
    }

    /** classify.js `bridgeForce` (G15). */
    fun bridgeForce(bridges: FloatArray?, state: BaseState?, x: Double, y: Double, cfg: ClassCfg): Double {
        if (bridges == null || state == null) return -cfg.far
        val dx = deedOf(x); val dy = deedOf(y); val b = cfg.bridge
        var f = -cfg.far
        for (j in -1..1) for (i in -1..1) {
            val xx = dx + i; val yy = dy + j; if (xx < 0 || yy < 0 || xx >= state.cols || yy >= state.rows) continue
            val k = (yy * state.cols + xx) * 4; val len = bridges[k + 2].toDouble(); if (!(len > 0)) continue
            val g = plotAt(state, xx, yy) ?: continue
            val ax = xx.toDouble() * tiles + g.cx; val ay = yy.toDouble() * tiles + g.cy; val ux = bridges[k].toDouble(); val uy = bridges[k + 1].toDouble()
            val along = (x - ax) * ux + (y - ay) * uy; var t = along / len; t = if (t < 0) 0.0 else if (t > 1) 1.0 else t
            val px = x - (ax + ux * t * len); val py = y - (ay + uy * t * len)
            val hw = bridges[k + 3].toDouble()
            val v = minOf(hw * (1 - b.taper * t) - sqrt(px * px + py * py), along - 0.25 * hw)
            if (v > f) f = v
        }
        return if (f > -cfg.far) f + b.wob * vnoise(x, y, b.wobPeriod, b.seed) else f
    }

    // ---------------------------------------------------------------- parcels, classes

    private val parcelOut = IntArray(4)

    /** classify.js `parcelAt`: the hashed-split parcel of vertex (x, y) → [x0, y0, x1, y1) in a reused array. */
    fun parcelAt(x: Int, y: Int, p: ParcelCfg, out: IntArray = parcelOut): IntArray {
        val bs = p.block; val span = p.max - p.min + 1
        val bx = Math.floorDiv(x, bs); val by = Math.floorDiv(y, bs); val h = kitHash(bx xor p.salt, by xor (p.salt shl 1))
        val s1 = p.min + ((h ushr 1) % span); val ox = bx * bs; val oy = by * bs
        if (h and 1 != 0) {
            val left = x - ox < s1; out[0] = if (left) ox else ox + s1; out[2] = if (left) ox + s1 else ox + bs
            val s2 = p.min + Integer.remainderUnsigned(kitHash((bx * 2 + (if (left) 0 else 1)) xor p.salt, by xor 0x51), span)
            val top = y - oy < s2; out[1] = if (top) oy else oy + s2; out[3] = if (top) oy + s2 else oy + bs
        } else {
            val top = y - oy < s1; out[1] = if (top) oy else oy + s1; out[3] = if (top) oy + s1 else oy + bs
            val s2 = p.min + Integer.remainderUnsigned(kitHash(bx xor 0x51, (by * 2 + (if (top) 0 else 1)) xor p.salt), span)
            val left = x - ox < s2; out[0] = if (left) ox else ox + s2; out[2] = if (left) ox + s2 else ox + bs
        }
        return out
    }

    private val rv0 = StrokeResult()
    private val tr0 = StrokeResult()

    /**
     * classify.js `classDetail(fields, lines, state, [x, y], cfg)`: every intermediate of §3.2 at vertex (x, y), into
     * [out]. [lines] null = no rivers or tracks (the web's palette samples half its points that way).
     */
    fun classDetail(fields: Fields, lines: Lines?, state: BaseState?, x: Double, y: Double, cfg: ClassCfg, out: ClassDetail = ClassDetail()): ClassDetail {
        val plot = plotSdf(state, x, y, cfg)
        val cn = cfg.coastNoise; val c2 = cfg.coastNoise2; val cwx = waterWarpX(x, y, cfg); val cwy = waterWarpY(x, y, cfg)
        val coast0 = fields.coast(cwx, cwy) + cn.amp * vnoise(x, y, cn.period, cn.seed) + c2.amp * vnoise(x, y, c2.period, c2.seed)
        val isl = if (state != null) islandForce(state, x, y, cfg) else -cfg.far
        var coast = if (isl > -cfg.far) smax(coast0, isl, cfg.coastK) else coast0
        val lake = fields.lake(cwx, cwy)
        val rv = if (lines != null) strokeSdf(riversOf(lines, state, cfg), x, y, cfg, true, rv0) else rv0.also { it.sdf = cfg.far; it.amp = Double.POSITIVE_INFINITY }
        val river = rv.sdf; val inn = cfg.inlandNoise
        val nz = vnoise(x, y, inn.period, inn.seed)
        var wetL = lake + inn.amp * nz
        if (isl > -cfg.far) wetL = smax(wetL, isl, cfg.island.k)
        var inland = minOf(wetL, river + minOf(inn.amp, rv.amp) * nz)
        inland = smax(inland, cfg.force - plot, cfg.inlandK)
        val bf = bridgeForce(bridgesFor(fields, lines, state, cfg), state, x, y, cfg)
        if (bf > -cfg.far) { coast = smax(coast, bf, cfg.bridge.k); inland = smax(inland, bf, cfg.bridge.k) }
        val track = if (lines != null) strokeSdf(lines.tracks, x, y, cfg, false, tr0).sdf else cfg.far
        out.plot = plot; out.coast = coast; out.inland = inland; out.river = river; out.lake = lake; out.track = track; out.bridge = bf; out.island = isl
        out.cls = Classes.WILD; out.ground = Classes.WILD; out.ring = false; out.rock = Double.NaN
        val dx = deedOf(x); val dy = deedOf(y); val g = plotAt(state, dx, dy); val lx = x - dx * tiles; val ly = y - dy * tiles
        if (g != null && lx >= g.minX && lx <= g.maxX && ly >= g.minY && ly <= g.maxY) { out.cls = Classes.TURF; out.ground = Classes.TURF; return out }
        val rag = cfg.claimRag
        if (g != null && rag != null && coast >= 0 && inland >= 0 && claimDist(g, lx, ly) <= rag.amp * maxOf(0.0, vnoise(x, y, rag.period, rag.seed))) {
            out.cls = Classes.TURF; out.ground = Classes.TURF; return out
        }
        val ck = cfg.clearing
        var feather = false
        if (plot < ck.extra + ck.lobe + ck.amp + ck.amp2 + 1) {
            val cl = clearingSdf(state, x, y, cfg)
            out.ring = plot < 1 || (cl < 0 && coast >= 0 && inland >= 0)
            if (out.ring && g != null) {
                val cd = claimDist(g, lx, ly); val aw = apronW(x, y, cfg)
                if (cd < aw) { out.cls = Classes.RING; out.ground = Classes.RING; return out }
                feather = cd < aw + cfg.apron.feather
            }
        }
        if (coast < -cfg.deepT) return done(out, plot, Classes.DEEP)
        if (coast < 0) return done(out, plot, Classes.SEA)
        if (inland < 0) return done(out, plot, Classes.WATER)
        if (cfg.hasShore) { val bn = cfg.beachNoise; if (coast < cfg.beachW + bn.amp * vnoise(x, y, bn.period, bn.seed)) return done(out, plot, Classes.SHORE) }
        val wx = classWarpX(x, y, cfg); val wy = classWarpY(x, y, cfg)
        var rock = fields.rock(wx, wy)
        if (cfg.slopeT < Double.POSITIVE_INFINITY) {
            val h = cfg.slopeStep; val gx = fields.relief(wx + h, wy) - fields.relief(wx - h, wy); val gy = fields.relief(wx, wy + h) - fields.relief(wx, wy - h)
            if (sqrt(gx * gx + gy * gy) / (2 * h) * tiles > cfg.slopeT) rock = 1.0
        }
        out.rock = rock
        if (rock >= cfg.rockT && inland > cfg.rockWaterGap && coast > cfg.rockWaterGap && !feather)
            return done(out, plot, if (fields.snow(wx, wy) >= cfg.snowT) Classes.SNOW else Classes.ROCK)
        if (track < 0 && inland > cfg.roadInland && coast > cfg.roadCoast) return done(out, plot, Classes.ROAD)
        val p = parcelAt(floor(wx + 0.5).toInt(), floor(wy + 0.5).toInt(), cfg.parcel)
        if (fields.field((p[0] + p[2]).toDouble() / 2, (p[1] + p[3]).toDouble() / 2) >= cfg.fieldT) return done(out, plot, if (feather) Classes.WILD else Classes.FIELD)
        if (fields.forest(wx, wy) >= cfg.forestT) return done(out, plot, if (feather) Classes.WILD else Classes.FOREST)
        if (fields.special(wx, wy) >= cfg.specialT) return done(out, plot, if (feather) Classes.WILD else Classes.SPECIAL)
        if (fields.ground2(wx, wy) >= cfg.g2T) return done(out, plot, Classes.GROUND2)
        return done(out, plot, Classes.WILD)
    }

    private fun done(out: ClassDetail, plot: Double, c: Int): ClassDetail {
        out.ground = if (plot < 1 && c <= Classes.WATER) Classes.WILD else c
        out.cls = if (out.ring) Classes.RING else out.ground
        return out
    }

    /** classify.js `classAt` (§10.2): the class of vertex (x, y). */
    fun classAt(fields: Fields, lines: Lines?, state: BaseState?, x: Double, y: Double, cfg: ClassCfg): Int = classDetail(fields, lines, state, x, y, cfg).cls

    /**
     * classify.js `sampledWet` (P0 "classes-sampled", GLSL `mapClassFine`'s wet test): 1 sea, 2 inland water, 0 dry, from the
     * baked fields only (no island / bridge / plot forcing, which only dries).
     */
    fun sampledWet(fields: Fields, lines: Lines?, state: BaseState?, x: Double, y: Double, cfg: ClassCfg): Int {
        val cn = cfg.coastNoise; val c2 = cfg.coastNoise2; val cwx = waterWarpX(x, y, cfg); val cwy = waterWarpY(x, y, cfg)
        if (fields.coast(cwx, cwy) + cn.amp * vnoise(x, y, cn.period, cn.seed) + c2.amp * vnoise(x, y, c2.period, c2.seed) < 0) return 1
        val inn = cfg.inlandNoise; val nz = vnoise(x, y, inn.period, inn.seed)
        val rv = if (lines != null) strokeSdf(riversOf(lines, state, cfg), x, y, cfg, true, rv0) else rv0.also { it.sdf = cfg.far; it.amp = Double.POSITIVE_INFINITY }
        return if (minOf(fields.lake(cwx, cwy) + inn.amp * nz, rv.sdf + minOf(inn.amp, rv.amp) * nz) < 0) 2 else 0
    }

    companion object {
        /** JavaScript `+v` for a lines.json value: a number stays, null → 0, a boolean → 1/0, a string parses, else NaN. */
        fun jsNumber(v: JsonValue): Double = when {
            v.isNumber -> v.asDouble()
            v.isNull -> 0.0
            v.isBoolean -> if (v.asBoolean()) 1.0 else 0.0
            v.isString -> v.asString().trim().let { s -> if (s.isEmpty()) 0.0 else s.toDoubleOrNull() ?: Double.NaN }
            else -> Double.NaN
        }
    }
}

/** contracts.js `LINES` (riverHwMin, trackHwMin, riverNoiseK, lensMargin): the web engine's line presentation constants. */
class LinesCfg(val riverHwMin: Double, val trackHwMin: Double, val riverNoiseK: Double, val lensMargin: Double) {
    companion object { val DEFAULT = LinesCfg(riverHwMin = 1.5, trackHwMin = 1.0, riverNoiseK = 0.35, lensMargin = 6.0) }
}

/** strokeSdf's result and its segment scratch (reused, zero-allocation). */
class StrokeResult { var sdf = 0.0; var amp = 0.0; internal val seg = SegEval() }

/** classify.js `segEval`: one segment's distance and interpolated half-width at (qx, qy). */
class SegEval {
    var dist = 0.0; var hw = 0.0
    fun eval(s: DoubleArray, o: Int, qx: Double, qy: Double, hwMin: Double) {
        val ax = s[o]; val ay = s[o + 1]; val bx = s[o + 2]; val by = s[o + 3]
        val ex = bx - ax; val ey = by - ay; val l2 = ex * ex + ey * ey
        var t = if (l2 > 0) ((qx - ax) * ex + (qy - ay) * ey) / l2 else 0.0; t = if (t < 0) 0.0 else if (t > 1) 1.0 else t
        val px = qx - (ax + ex * t); val py = qy - (ay + ey * t)
        dist = sqrt(px * px + py * py); hw = maxOf(s[o + 4] + (s[o + 5] - s[o + 4]) * t, hwMin)
    }
}

/** A growable int list (no boxing). */
class IntList(capacity: Int = 8) {
    private var a = IntArray(capacity)
    var size = 0; private set
    fun add(v: Int) { if (size == a.size) a = a.copyOf(a.size * 2); a[size++] = v }
    operator fun get(i: Int): Int = a[i]
    fun toArray(): IntArray = a.copyOf(size)
    fun clear() { size = 0 }
}
