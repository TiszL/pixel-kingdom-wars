package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.TAU
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.jsHypot
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.jsRound
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.vnoise
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.sqrt

/**
 * The CPU halves of GROUND's GPU inputs (web `classify.js` P0 bake, GA2-04 foreign sea, fix-2 #3 tarn clip): the line
 * fields baked per deed page as packHalf2x16 words, the one-word land bridges, the realm distance cut of the coast field,
 * and the painted-shadow clip of the lake field. Pure; runs on the decode / bake worker, never the GL thread.
 */
object ClassBake {
    /** classify.js `BAKE`: 99² pages (vertices 0…98 of a deed), the field cap (t) and the river-noise cap. */
    const val PAGE = 99
    const val CAP = 20.0
    const val AMP_CAP = 64.0
    const val PAGE_N = PAGE * PAGE

    /** Nearest-even IEEE binary16 bits of [v] through float32 (classify.js `toHalf`). */
    fun toHalf(v: Double): Int {
        val x = java.lang.Float.floatToRawIntBits(v.toFloat())
        val sign = (x ushr 16) and 0x8000; val e = (x ushr 23) and 0xff; var m = x and 0x7fffff
        if (e == 255) return sign or 0x7c00 or (if (m != 0) 0x200 else 0)
        val ee = e - 112
        if (ee >= 31) return sign or 0x7c00
        if (ee <= 0) {
            if (ee < -10) return sign
            m = m or 0x800000
            val sh = 14 - ee; val h = m ushr sh; val rem = m and ((1 shl sh) - 1); val half = 1 shl (sh - 1)
            return sign or (if (rem > half || (rem == half && (h and 1) != 0)) h + 1 else h)
        }
        val h = (ee shl 10) or (m ushr 13); val rem = m and 0x1fff
        return sign or (if (rem > 0x1000 || (rem == 0x1000 && (h and 1) != 0)) h + 1 else h)
    }

    /** The value of binary16 bits [h] (classify.js `fromHalf`). */
    fun fromHalf(h: Int): Double {
        val s = if (h and 0x8000 != 0) -1.0 else 1.0; val e = (h ushr 10) and 31; val m = h and 1023
        if (e == 0) return s * m * Math.scalb(1.0, -24)
        if (e == 31) return if (m != 0) Double.NaN else s * Double.POSITIVE_INFINITY
        return s * (1 + m / 1024.0) * Math.scalb(1.0, e - 15)
    }

    /** One packHalf2x16 word (a in the low half). */
    fun pack2(a: Double, b: Double): Int = toHalf(a) or (toHalf(b) shl 16)

    /**
     * classify.js `packBridge`: direction in 1/65536 turns (bits 0–15), length in ½ t (16–23), half-width in ¼ t (24–31);
     * 0 = none. The uint32 as Int bits.
     */
    fun packBridge(ux: Double, uy: Double, len: Double, hw: Double): Int {
        if (!(len > 0)) return 0
        val a = ((jsRound(StrictMath.atan2(uy, ux) / TAU * 65536) % 65536) + 65536) % 65536
        val l = maxOf(1.0, minOf(255.0, jsRound(len * 2))); val h = maxOf(1.0, minOf(255.0, jsRound(hw * 4)))
        return a.toInt() or (l.toInt() shl 16) or (h.toInt() shl 24)
    }

    /** classify.js `unpackBridge` → [ux, uy (float32), len, hw]. */
    fun unpackBridge(u: Int): DoubleArray {
        if (u == 0) return doubleArrayOf(0.0, 0.0, 0.0, 0.0)
        val a = (u and 0xffff) / 65536.0 * TAU
        return doubleArrayOf(GroundMath.fround(StrictMath.cos(a)), GroundMath.fround(StrictMath.sin(a)), ((u ushr 16) and 255) / 2.0, (u ushr 24) / 4.0)
    }

    /**
     * classify.js `rasterStrokes`: the strokes of [set] over deed ([dx], [dy])'s 99² page (row/column 98 from the next
     * deeds' lists) into [out] (and, for rivers, the noise cap into [amp]), min-rasterised per governing deed.
     */
    fun rasterStrokes(set: SegSet, dx: Int, dy: Int, tiles: Int, cfg: ClassCfg, out: DoubleArray, amp: DoubleArray?, lines: LinesCfg = LinesCfg.DEFAULT) {
        val n = PAGE; val cap = CAP; val s = set.segs; val reach = cfg.riverNoiseReach; val ox = dx.toDouble() * tiles; val oy = dy.toDouble() * tiles
        out.fill(cap); amp?.fill(AMP_CAP)
        val seg = SegEval()
        for (gy in 0..1) for (gx in 0..1) {
            val xx = dx + gx; val yy = dy + gy; if (xx < 0 || yy < 0 || xx >= set.cols || yy >= set.rows) continue
            val list = set.cells[yy * set.cols + xx] ?: continue
            val i0 = if (gx != 0) 98 else 0; val i1 = if (gx != 0) 98 else 97; val j0 = if (gy != 0) 98 else 0; val j1 = if (gy != 0) 98 else 97
            for (sg in list) {
                val o = sg * 6; val pad = maxOf(maxOf(s[o + 4], s[o + 5]), set.hwMin) + cap
                val a = maxOf(i0.toDouble(), ceil(minOf(s[o], s[o + 2]) - pad - ox)).toInt(); val b = minOf(i1.toDouble(), floor(maxOf(s[o], s[o + 2]) + pad - ox)).toInt()
                val c = maxOf(j0.toDouble(), ceil(minOf(s[o + 1], s[o + 3]) - pad - oy)).toInt(); val e = minOf(j1.toDouble(), floor(maxOf(s[o + 1], s[o + 3]) + pad - oy)).toInt()
                for (j in c..e) for (i in a..b) {
                    seg.eval(s, o, ox + i, oy + j, set.hwMin); val v = seg.dist - seg.hw; val k = j * n + i
                    if (v < out[k]) out[k] = v
                    if (amp != null && seg.dist <= seg.hw + reach) { val m = lines.riverNoiseK * (seg.hw - 0.5); if (m < amp[k]) amp[k] = m }
                }
            }
        }
    }

    /** classify.js `bakeRiverPage` → the page's packHalf2x16 words (sdf, amp) into [words] (99²). */
    fun riverPageWords(rivers: SegSet, dx: Int, dy: Int, tiles: Int, cfg: ClassCfg, words: IntArray, sdf: DoubleArray = DoubleArray(PAGE_N), amp: DoubleArray = DoubleArray(PAGE_N)): IntArray {
        rasterStrokes(rivers, dx, dy, tiles, cfg, sdf, amp)
        for (i in 0 until PAGE_N) words[i] = pack2(sdf[i], amp[i])
        return words
    }

    /** classify.js `bakeLandPage` → the page's words (track sdf, 0) into [words]. */
    fun landPageWords(tracks: SegSet?, dx: Int, dy: Int, tiles: Int, cfg: ClassCfg, words: IntArray, track: DoubleArray = DoubleArray(PAGE_N)): IntArray {
        if (tracks != null) rasterStrokes(tracks, dx, dy, tiles, cfg, track, null) else track.fill(CAP)
        for (i in 0 until PAGE_N) words[i] = pack2(track[i], 0.0)
        return words
    }

    /** classify.js `riverHint`: deed k's downstream direction (the normalised sum of its listed segments) → (x, y). */
    fun riverHint(rivers: SegSet?, k: Int, out: DoubleArray = DoubleArray(2)): DoubleArray {
        val list = rivers?.cells?.get(k)
        if (list == null) { out[0] = 0.0; out[1] = 0.0; return out }
        var x = 0.0; var y = 0.0
        for (s in list) { x += rivers.segs[s * 6 + 2] - rivers.segs[s * 6]; y += rivers.segs[s * 6 + 3] - rivers.segs[s * 6 + 1] }
        val l = jsHypot(x, y)
        if (l > 1e-9) { out[0] = x / l; out[1] = y / l } else { out[0] = 0.0; out[1] = 0.0 }
        return out
    }

    /**
     * classify.js `foreignSeaRows` (GA2-04 at MAP and TRUE) as one pass: the coast SDF (fieldsA R = 128 + d/2 t) is capped
     * at (cut − distance from the realm) deeds, the cut wandering 1.5…6.5 deeds; mutates [img] in place. [farD] = the realm
     * distance field (deeds, float32 semantics, texel centres at i + 0.5). → counts [noised, zeroed, kept].
     */
    fun foreignSea(img: FieldImage, farD: FloatArray, cols: Int, rows: Int, tiles: Int, rowsFrom: Int = 0, rowsTo: Int = img.height): IntArray {
        val w = img.width; val ppd = w.toDouble() / cols; val cutMin = 1.5; val cutMax = 6.5
        fun farAt(x: Double, y: Double): Double {
            val u = minOf((cols - 1).toDouble(), maxOf(0.0, x - 0.5)); val v = minOf((rows - 1).toDouble(), maxOf(0.0, y - 0.5))
            val x0 = floor(u).toInt(); val y0 = floor(v).toInt(); val x1 = minOf(cols - 1, x0 + 1); val y1 = minOf(rows - 1, y0 + 1); val fx = u - x0; val fy = v - y0
            return (farD[y0 * cols + x0] * (1 - fx) + farD[y0 * cols + x1] * fx) * (1 - fy) + (farD[y1 * cols + x0] * (1 - fx) + farD[y1 * cols + x1] * fx) * fy
        }
        fun cutAt(px: Double, py: Double): Double {
            val qx = px * 4; val qy = py * 4
            return minOf(cutMax, maxOf(cutMin, 3.5 - (1.5 * vnoise(qx, qy, 48.0, 0x6f13) + 0.8 * vnoise(qx, qy, 20.0, 0x1d27) + 0.9 * vnoise(qx, qy, 7.0, 0x4f1d) + 0.35 * vnoise(qx, qy, 3.0, 0x2a77))))
        }
        var noised = 0; var zeroed = 0; var kept = 0
        for (y in rowsFrom until rowsTo) for (x in 0 until w) {
            if (!img.holds(x, y)) continue
            val px = (x + 0.5) / ppd; val py = (y + 0.5) / ppd; val fd = farAt(px, py); if (fd <= 0.5) continue
            val c = (img.at(x, y, 0) - 128) * 2.0
            if (c <= (cutMin - fd) * tiles) { kept++; continue }
            if ((cutMax - fd) * tiles <= -256) { img.set(x, y, 0, 0); zeroed++; continue }
            val cap = (cutAt(px, py) - fd) * tiles; noised++
            if (cap < c) img.set(x, y, 0, minOf(255.0, maxOf(0.0, jsRound(128 + cap / 2))).toInt())
        }
        return intArrayOf(noised, zeroed, kept)
    }

    /** clipTarns' result: components, clipped, texels, and why it skipped (null when it ran). */
    class TarnResult(val components: Int, val clipped: Int, val texels: Int, val skipped: String?)

    /**
     * classify.js `clipTarns` (fix iteration 2 #3): a 4-connected lake component on land with no texel painted past
     * [wetT] along the realm's own land → water colour axis is a painted shadow, and dries by [dry] t. [fieldsA] RGBA
     * (lake in G) is mutated; [chart] = chart8 pixels on the same grid ([cs] channels per pixel).
     */
    fun clipTarns(fieldsA: ByteArray, w: Int, h: Int, chart: ByteArray, cw: Int, ch: Int, cs: Int, dry: Double = 12.0, wetT: Double = 0.45, minAxis: Double = 60.0): TarnResult {
        if (cw != w || ch != h) return TarnResult(0, 0, 0, "grid mismatch")
        val n = w * h
        fun a(i: Int, c: Int) = fieldsA[i * 4 + c].toInt() and 0xff
        fun c(i: Int, k: Int) = chart[i * cs + k].toInt() and 0xff
        fun wet(i: Int) = a(i, 1) < 128 && a(i, 0) > 128
        val lab = IntArray(n) { -1 }; val comps = ArrayList<IntArray>()
        val land = DoubleArray(4)
        for (i in 0 until n) if (a(i, 0) > 128 && a(i, 1) > 128) { land[0] += c(i, 0); land[1] += c(i, 1); land[2] += c(i, 2); land[3]++ }
        val nb = IntArray(4)
        for (s in 0 until n) {
            if (lab[s] >= 0 || !wet(s)) continue
            val id = comps.size; val px = IntList(); px.add(s); lab[s] = id
            var q = 0
            while (q < px.size) {
                val i = px[q]; val x = i % w
                nb[0] = if (x > 0) i - 1 else -1; nb[1] = if (x < w - 1) i + 1 else -1; nb[2] = i - w; nb[3] = i + w
                for (j in nb) if (j >= 0 && j < n && lab[j] < 0 && wet(j)) { lab[j] = id; px.add(j) }
                q++
            }
            comps += px.toArray()
        }
        if (comps.isEmpty() || land[3] == 0.0) return TarnResult(comps.size, 0, 0, null)
        var big = comps[0]; for (cc in comps) if (cc.size > big.size) big = cc
        val l = doubleArrayOf(land[0] / land[3], land[1] / land[3], land[2] / land[3]); val wc = DoubleArray(3)
        for (i in big) for (k in 0 until 3) wc[k] += c(i, k).toDouble() / big.size
        val ax = DoubleArray(3) { wc[it] - l[it] }; val n2 = ax[0] * ax[0] + ax[1] * ax[1] + ax[2] * ax[2]
        if (sqrt(n2) < minAxis) return TarnResult(comps.size, 0, 0, "water paints like land")
        var clipped = 0; var texels = 0
        val dryV = minOf(255.0, 128 + ceil(dry / 2)).toInt()
        for (px in comps) {
            var t = Double.NEGATIVE_INFINITY
            for (i in px) { val v = ((c(i, 0) - l[0]) * ax[0] + (c(i, 1) - l[1]) * ax[1] + (c(i, 2) - l[2]) * ax[2]) / n2; if (v > t) t = v; if (t > wetT) break }
            if (t > wetT) continue
            clipped++; texels += px.size
            for (i in px) fieldsA[i * 4 + 1] = dryV.toByte()
        }
        return TarnResult(comps.size, clipped, texels, null)
    }
}
