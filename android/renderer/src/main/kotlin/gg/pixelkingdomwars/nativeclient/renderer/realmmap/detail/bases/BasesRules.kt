package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash

/** A kingdom's marker-mode look (bases.js `iconLook`): icon width, banner spires, companion towers. */
class IconLook(val css: Double, val tips: IntArray, val towers: Int, val tower: String?, val first: Int)

/**
 * The pure rules of the web BASES lane (`bases.js`, pinned), 1:1 and golden-tested: how a base draws at a camera (dot,
 * marker icon, live keep: per base, never blended), the marker look per level and seed, the tap order, the shield caps,
 * the per-frame CPU budget, and the mode-preserving pixel-art reducer the MAP minis and icons are built with.
 */
class BasesRules(private val t: DecorTables, private val uiDots: Double, private val uiIcons: Double, private val keepMinCss: Double,
                 private val impostor0: Double, private val impostor1: Double) {

    /** bases.js `baseMode(s, d, hIcon, hKeep)`: 0 dot, 1 icon, 2 keep. */
    fun baseMode(s: Double, d: Double, hIcon: Double, hKeep: Double): Int {
        val iconW = JsMath.clamp((s - uiDots) / (uiIcons - uiDots), 0.0, 1.0)
        if (!(s >= uiIcons || hIcon < iconW)) return DOT
        val keepW = JsMath.clamp((d - impostor0) / (impostor1 - impostor0), 0.0, 1.0)
        return if (d >= impostor1 || hKeep < keepW) KEEP else ICON
    }

    private fun h01(seed: Int, k: Int): Double = JsMath.u32(LifeHash.kitHash(seed, k)) / 4294967296.0
    /** bases.js `iconLook(level, seed)` ([seed] the uint32 seed bits). */
    fun iconLook(level: Int, seed: Int): IconLook {
        val l = Math.min(20, Math.max(1, JsMath.round(level.toDouble()).toInt().let { if (it == 0) 1 else it }))
        val tt = (l - 1) / 19.0
        val towers = if (l < 12) 0 else if (l < 15) 1 else if (l < 18) 2 else 2 + (if (h01(seed, 14) < 0.5) 0 else 1)
        return IconLook(keepMinCss * Math.max(1.0, (1 + 0.34 * tt) * (0.94 + 0.12 * h01(seed, 11))),
            if (l >= 12) intArrayOf(0, 3) else intArrayOf((JsMath.u32L(LifeHash.kitHash(seed, 12)) % 4).toInt()),
            towers, if (towers != 0) t.iconTowers[(JsMath.u32L(LifeHash.kitHash(seed, 15)) % t.iconTowers.size).toInt()] else null,
            if (h01(seed, 16) < 0.5) -1 else 1)
    }

    /**
     * bases.js `iconAnchorY(d, inkMid)` (stage B fix pass, 090b3428): the plot-local y (tiles) of a MAP marker icon's anchor.
     * The icon's ink is centred on the plot centre up to d `ICON_CENTRE_D[0]` (GROUND's clearing, the claim tint and the
     * shield ring are centred there) and eases back onto the keep seat by `ICON_CENTRE_D[1]` = `BANDS.impostor[0]`, where
     * the live keep takes over on its seat inside its walls: smoothstep in log d. [inkMid] is the icon ink's vertical middle
     * relative to its anchor (tiles, < 0 above it); [plotCentre] is contracts.js `PLOT_CENTRE` and [seat] the keep seat,
     * `KEEP_FOOTPRINT[1] / 2 + PLOT_CENTRE`. `Math.log` is V8's fdlibm port, so [JsMath.log] (StrictMath) matches it.
     */
    fun iconAnchorY(d: Double, inkMid: Double, plotCentre: Double, seat: Double): Double {
        val a = t.iconCentreD[0]; val b = t.iconCentreD[1]
        val tt = JsMath.clamp(JsMath.log(d / a) / JsMath.log(b / a), 0.0, 1.0); val w = 1 - tt * tt * (3 - 2 * tt)
        return seat + w * (plotCentre - inkMid - seat)
    }

    /** A tap target: a keep/icon rect (CSS px) and its depth, or a dome's ground ellipse. [base] is the caller's index. */
    class KeepRect(var base: Int = -1, var x0: Double = 0.0, var y0: Double = 0.0, var x1: Double = 0.0, var y1: Double = 0.0, var depth: Double = 0.0)
    class DomeHit(var base: Int = -1, var sx: Double = 0.0, var sy: Double = 0.0, var rx: Double = 0.0, var ry: Double = 0.0)

    /** bases.js `pickBase`: the keep/icon rect nearest the viewer (largest seat y) under the point, else the first dome
     *  whose ground ellipse holds it, else −1. */
    fun pickBase(rects: Array<KeepRect>, nRects: Int, domes: Array<DomeHit>, nDomes: Int, sx: Double, sy: Double): Int {
        var best: KeepRect? = null
        for (i in 0 until nRects) { val r = rects[i]; if (sx >= r.x0 && sx <= r.x1 && sy >= r.y0 && sy <= r.y1 && (best == null || r.depth > best.depth)) best = r }
        if (best != null) return best.base
        for (i in 0 until nDomes) { val h = domes[i]; val u = (sx - h.sx) / h.rx; val v = (sy - h.sy) / h.ry; if (u * u + v * v <= 1) return h.base }
        return -1
    }

    /**
     * bases.js `capShields`: ≤ mapCap domes on screen at MAP, ≤ trueCap at TRUE (lod 2); yours first, then the nearest.
     * Sorts [order] (indices, n entries) by (mine desc, dist asc), stable; returns the kept count.
     */
    fun capShields(order: IntArray, n: Int, mine: BooleanArray, dist: DoubleArray, lod: Int): Int {
        // stable insertion sort (n ≤ the visible domes; allocation-free)
        for (a in 1 until n) {
            val v = order[a]; var b = a - 1
            while (b >= 0 && before(v, order[b], mine, dist)) { order[b + 1] = order[b]; b-- }
            order[b + 1] = v
        }
        return Math.min(n, if (lod == 2) t.shieldTrueCap else t.shieldMapCap)
    }
    private fun before(a: Int, b: Int, mine: BooleanArray, dist: DoubleArray): Boolean {
        val ma = if (mine[a]) 1 else 0; val mb = if (mine[b]) 1 else 0
        if (ma != mb) return ma > mb
        return dist[a] < dist[b]
    }

    /** A millisecond clock with a primitive result (no boxing per call: the per-frame budget reads it every unit). */
    fun interface MsClock { fun now(): Double }

    /** bases.js `frameWork(ms, now)`: one frame's CPU budget; [more] is true for the first unit, then while within ms. */
    class FrameWork(private val ms: Double, private val now: MsClock) {
        private var end = 0.0; private var used = false
        fun begin(): FrameWork { end = now.now() + ms; used = false; return this }
        fun more(): Boolean = !used || now.now() < end
        fun spend() { used = true }
    }

    companion object {
        const val DOT = 0; const val ICON = 1; const val KEEP = 2
    }
}

/**
 * The BASES pixel reducers (bases.js `reduceMode`, `bleed`, `mipChain`), 1:1: a (possibly non-integer) mode-preserving,
 * alpha-aware reduction in 3-bit colour buckets (no averages, no dark bias), the RGB bleed into transparent texels, and
 * the mip chain built with it. Decode workers only.
 */
object BasesPixels {
    class Img(val px: ByteArray, val w: Int, val h: Int)
    private fun u(b: Byte) = b.toInt() and 0xff

    fun reduceMode(px: ByteArray, w: Int, h: Int, f: Double, ow0: Int = -1, oh0: Int = -1, darkW: Double = 1.0): Img {
        val ow = if (ow0 >= 0) ow0 else Math.max(1.0, Math.ceil(w / f)).toInt(); val oh = if (oh0 >= 0) oh0 else Math.max(1.0, Math.ceil(h / f)).toInt()
        val out = ByteArray(ow * oh * 4)
        // JS Maps in insertion order: buckets (bKey/bN) and, per bucket, its colours — kept as one list of (bucket, colour)
        // entries in first-seen order, which restricted to one bucket IS that bucket's Map order
        val cap = (Math.ceil(f).toInt() + 2) * (Math.ceil(f).toInt() + 2)
        val bKey = IntArray(cap); val bN = DoubleArray(cap); val eB = IntArray(cap); val eC = IntArray(cap); val eW = DoubleArray(cap)
        for (j in 0 until oh) for (i in 0 until ow) {
            val x0 = Math.max(0.0, Math.ceil(i * f - 0.5)).toInt(); val x1 = Math.min(w.toDouble(), Math.max(x0 + 1.0, Math.ceil((i + 1) * f - 0.5))).toInt()
            val y0 = Math.max(0.0, Math.ceil(j * f - 0.5)).toInt(); val y1 = Math.min(h.toDouble(), Math.max(y0 + 1.0, Math.ceil((j + 1) * f - 0.5))).toInt()
            var n = 0; var op = 0; var nb = 0; var ne = 0
            for (y in y0 until y1) for (x in x0 until x1) {
                n++; val k = (y * w + x) * 4; if (u(px[k + 3]) < 128) continue; op++
                val b = ((u(px[k]) shr 5) shl 6) or ((u(px[k + 1]) shr 5) shl 3) or (u(px[k + 2]) shr 5)
                val c = (u(px[k]) shl 16) or (u(px[k + 1]) shl 8) or u(px[k + 2])
                val wt = if (darkW != 1.0 && u(px[k]) * 0.3 + u(px[k + 1]) * 0.59 + u(px[k + 2]) * 0.11 < 48) darkW else 1.0
                var e = -1; for (q in 0 until nb) if (bKey[q] == b) { e = q; break }
                if (e < 0) { e = nb++; bKey[e] = b; bN[e] = 0.0 }
                bN[e] += wt
                var ee = -1; for (q in 0 until ne) if (eB[q] == e && eC[q] == c) { ee = q; break }
                if (ee < 0) { ee = ne++; eB[ee] = e; eC[ee] = c; eW[ee] = 0.0 }
                eW[ee] += wt
            }
            if (n == 0 || op * 2 < n) continue
            var win = -1; for (q in 0 until nb) if (win < 0 || bN[q] > bN[win]) win = q
            var best = 0; var bn = -1.0
            for (q in 0 until ne) if (eB[q] == win && eW[q] > bn) { best = eC[q]; bn = eW[q] }
            val o = (j * ow + i) * 4; out[o] = (best shr 16).toByte(); out[o + 1] = ((best shr 8) and 255).toByte(); out[o + 2] = (best and 255).toByte(); out[o + 3] = -1
        }
        return Img(out, ow, oh)
    }

    /** bases.js `bleed` (in place): transparent, black texels take an opaque neighbour's RGB (later passes: any tinted). */
    fun bleed(px: ByteArray, w: Int, h: Int, passes: Int = 2): ByteArray {
        val dx = intArrayOf(1, -1, 0, 0); val dy = intArrayOf(0, 0, 1, -1)
        for (p in 0 until passes) {
            val src = px.copyOf()
            for (y in 0 until h) for (x in 0 until w) {
                val k = (y * w + x) * 4; if (u(src[k + 3]) >= 128 || (u(src[k]) or u(src[k + 1]) or u(src[k + 2])) != 0) continue
                for (nn in 0 until 4) {
                    val xx = x + dx[nn]; val yy = y + dy[nn]; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
                    val q = (yy * w + xx) * 4
                    if (u(src[q + 3]) >= 128 || (p > 0 && (u(src[q]) or u(src[q + 1]) or u(src[q + 2])) != 0)) { px[k] = src[q]; px[k + 1] = src[q + 1]; px[k + 2] = src[q + 2]; break }
                }
            }
        }
        return px
    }

    /** bases.js `mipChain(px, w, h, levels)`: level 0 bled, each next a 2× reduceMode (then bled). */
    fun mipChain(px: ByteArray, w: Int, h: Int, levels: Int): List<Img> {
        val out = ArrayList<Img>(); out += Img(bleed(px, w, h), w, h)
        for (l in 1 until levels) {
            val p = out[l - 1]; val r = reduceMode(p.px, p.w, p.h, 2.0, Math.max(1, p.w shr 1), Math.max(1, p.h shr 1))
            out += Img(bleed(r.px, r.w, r.h), r.w, r.h)
        }
        return out
    }

    /** `Math.floor(Math.log2(Math.min(w, h))) + 1`: the full chain down to one texel per side. */
    fun mipsOf(w: Int, h: Int): Int = 32 - Integer.numberOfLeadingZeros(Math.min(w, h))

    /** bases.js `crop`: a [w]×[h] RGBA copy at ([x], [y]) (out-of-range texels stay 0). */
    fun crop(src: ByteArray, iw: Int, ih: Int, x: Int, y: Int, w: Int, h: Int): ByteArray {
        val out = ByteArray(w * h * 4)
        for (j in 0 until h) { val sy = y + j; if (sy < 0 || sy >= ih) continue
            for (i in 0 until w) { val sx = x + i; if (sx < 0 || sx >= iw) continue
                System.arraycopy(src, (sy * iw + sx) * 4, out, (j * w + i) * 4, 4) } }
        return out
    }

    /** bases.js `inkBox(frames, w, h)`: [x0, y0, x1, y1) of alpha ≥ 128 over every frame, or null. */
    fun inkBox(frames: List<ByteArray>, w: Int, h: Int): IntArray? {
        var x0 = w; var y0 = h; var x1 = -1; var y1 = -1
        for (px in frames) for (y in 0 until h) for (x in 0 until w) if (u(px[(y * w + x) * 4 + 3]) >= 128) {
            if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y
        }
        return if (x1 < 0) null else intArrayOf(x0, y0, x1 + 1, y1 + 1)
    }
}
