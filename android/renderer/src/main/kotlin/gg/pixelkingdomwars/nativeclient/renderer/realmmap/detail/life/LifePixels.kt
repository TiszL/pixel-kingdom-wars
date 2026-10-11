package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

/** Straight RGBA8 pixels of a decoded atlas (row-major from the top). */
class LifeImage(val width: Int, val height: Int, val data: ByteArray) {
    init { require(width > 0 && height > 0 && data.size == width * height * 4) { "Bad image ${width}x$height" } }
}
/** A sprite frame inside an atlas (life.js `src`): the rect and the anchor, for the MAP reducers. */
class LifeFrameSource(val img: LifeImage, val x: Int, val y: Int, val w: Int, val h: Int, val ax: Double, val ay: Double)
/** life.js `reduceMap` result: a map-scale image and its anchor. */
class LifeReduced(val img: LifeImage, val w: Int, val h: Int, val ax: Double, val ay: Double)

/**
 * LIFE's CPU pixel work (web `life.js`, pinned), 1:1: frames copied into layers with binary alpha, their ink rows, the
 * RGB bleed into transparent texels, the mode-preserving 2× mip reducer, and the kit-art → map-art reducer (`reduceMap`,
 * 1 map px = 7 art px). Runs on the decode workers; never on the GL thread.
 */
object LifePixels {
    private fun u(b: Byte): Int = b.toInt() and 0xff

    /** life.js `copyFrame`: the [w]×[h] rect at ([sx], [sy]) into an [lw]×[lh] layer at ([ox], [oy]); alpha ≥ 128 → 255. */
    fun copyFrame(img: LifeImage, sx: Int, sy: Int, w: Int, h: Int, lw: Int, lh: Int, ox: Int, oy: Int): ByteArray {
        val out = ByteArray(lw * lh * 4); val src = img.data; val iw = img.width
        for (y in 0 until h) {
            val yy = sy + y; if (yy < 0 || yy >= img.height) continue
            for (x in 0 until w) {
                val xx = sx + x; if (xx < 0 || xx >= iw) continue
                val s = (yy * iw + xx) * 4; val d = ((oy + y) * lw + ox + x) * 4
                out[d] = src[s]; out[d + 1] = src[s + 1]; out[d + 2] = src[s + 2]; out[d + 3] = if (u(src[s + 3]) >= 128) -1 else 0
            }
        }
        return out
    }

    /** life.js `inkRows`: [top, bottom, left, right] of the opaque texels, or null. */
    fun inkRows(px: ByteArray, w: Int, h: Int): IntArray? {
        var top = -1; var bot = -1; var lft = w; var rgt = -1
        for (y in 0 until h) for (x in 0 until w) if (px[(y * w + x) * 4 + 3].toInt() != 0) { if (top < 0) top = y; bot = y; lft = Math.min(lft, x); rgt = Math.max(rgt, x) }
        return if (top < 0) null else intArrayOf(top, bot, lft, rgt)
    }

    /** life.js `bleed` (2 passes, in place): transparent texels take an opaque neighbour's RGB (pass 2: any tinted one). */
    fun bleed(px: ByteArray, w: Int, h: Int): ByteArray {
        val dx = intArrayOf(1, -1, 0, 0); val dy = intArrayOf(0, 0, 1, -1)
        for (pass in 0 until 2) {
            val src = px.copyOf()
            for (y in 0 until h) for (x in 0 until w) {
                val i = (y * w + x) * 4; if (src[i + 3].toInt() != 0) continue
                for (n in 0 until 4) {
                    val xx = x + dx[n]; val yy = y + dy[n]; if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue
                    val j = (yy * w + xx) * 4
                    if (src[j + 3].toInt() == 0 && !(pass != 0 && (u(src[j]) or u(src[j + 1]) or u(src[j + 2])) != 0)) continue
                    px[i] = src[j]; px[i + 1] = src[j + 1]; px[i + 2] = src[j + 2]; break
                }
            }
        }
        return px
    }

    class Level(val px: ByteArray, val w: Int, val h: Int)

    /** life.js `reduce2`: one mode-preserving 2× level (never an average of opaque colours, never "darkest wins"). */
    fun reduce2(px: ByteArray, w: Int, h: Int): Level {
        val dw = Math.max(1, w shr 1); val dh = Math.max(1, h shr 1); val out = ByteArray(dw * dh * 4)
        val cs = IntArray(4)
        for (y in 0 until dh) for (x in 0 until dw) {
            var nc = 0; var n = 0; var r = 0; var g = 0; var b = 0; var or = 0.0; var og = 0.0; var ob = 0.0
            for (j in 0 until 2) for (i in 0 until 2) {
                val sx = Math.min(w - 1, 2 * x + i); val sy = Math.min(h - 1, 2 * y + j); val k = (sy * w + sx) * 4; n++
                r += u(px[k]); g += u(px[k + 1]); b += u(px[k + 2])
                if (px[k + 3].toInt() != 0) { cs[nc++] = k; or += u(px[k]); og += u(px[k + 1]); ob += u(px[k + 2]) }
            }
            val d = (y * dw + x) * 4; val op = nc
            if (op != 0 && op * 2 >= n) {
                or /= op; og /= op; ob /= op
                var best = cs[0]; var bc = 0; var be = Double.POSITIVE_INFINITY
                for (a in 0 until nc) {
                    val k = cs[a]
                    var cnt = 0; for (q0 in 0 until nc) { val q = cs[q0]; if (px[q] == px[k] && px[q + 1] == px[k + 1] && px[q + 2] == px[k + 2]) cnt++ }
                    val er = u(px[k]) - or; val eg = u(px[k + 1]) - og; val eb = u(px[k + 2]) - ob
                    val e = er * er + eg * eg + eb * eb
                    if (cnt > bc || (cnt == bc && e < be)) { best = k; bc = cnt; be = e }
                }
                out[d] = px[best]; out[d + 1] = px[best + 1]; out[d + 2] = px[best + 2]; out[d + 3] = -1
            } else {
                // Uint8Array stores truncate: r / n with n = 4
                out[d] = (r.toDouble() / n).toInt().toByte(); out[d + 1] = (g.toDouble() / n).toInt().toByte(); out[d + 2] = (b.toDouble() / n).toInt().toByte(); out[d + 3] = 0
            }
        }
        return Level(out, dw, dh)
    }

    private fun luma(d: ByteArray, i: Int): Double = 0.3 * u(d[i]) + 0.59 * u(d[i + 1]) + 0.11 * u(d[i + 2])

    /** life.js `reduceMap`: kit art → map art (k = 7), blocks aligned on the anchor, the 55th luma percentile of each
     *  block's opaque body pixels (outline darks left out unless they are all there is), binary alpha. */
    fun reduceMap(src: LifeFrameSource, k: Int = 7): LifeReduced {
        val ax = JsMath.round(src.ax).toInt(); val ay = JsMath.round(src.ay).toInt(); val iw = src.img.width; val dd = src.img.data
        val x0 = ax - k * Math.ceil(ax.toDouble() / k).toInt(); val y0 = ay - k * Math.ceil(ay.toDouble() / k).toInt()
        val ow = Math.ceil((src.w - x0).toDouble() / k).toInt(); val oh = Math.ceil((src.h - y0).toDouble() / k).toInt()
        val out = ByteArray(ow * oh * 4)
        val cs = IntArray(k * k); val use = IntArray(k * k); val keys = DoubleArray(k * k)
        for (by in 0 until oh) for (bx in 0 until ow) {
            var n = 0
            for (j in 0 until k) for (i in 0 until k) {
                val sx = x0 + bx * k + i; val sy = y0 + by * k + j
                if (sx < 0 || sy < 0 || sx >= src.w || sy >= src.h) continue
                val q = ((src.y + sy) * iw + src.x + sx) * 4
                if (u(dd[q + 3]) >= 128) cs[n++] = q
            }
            if (n * 5 < k * k * 2) continue
            var top = Double.NEGATIVE_INFINITY; for (a in 0 until n) top = Math.max(top, luma(dd, cs[a]))
            var m = 0; for (a in 0 until n) if (luma(dd, cs[a]) >= 0.2 * top) use[m++] = cs[a]
            if (m == 0) { for (a in 0 until n) use[a] = cs[a]; m = n }
            for (a in 0 until m) keys[a] = luma(dd, use[a])
            // stable insertion sort by (luma, index): the web's comparator `luma(a) − luma(b) || a − b`
            for (a in 1 until m) {
                val qv = use[a]; val kv = keys[a]; var b = a - 1
                while (b >= 0 && (keys[b] > kv || (keys[b] == kv && use[b] > qv))) { use[b + 1] = use[b]; keys[b + 1] = keys[b]; b-- }
                use[b + 1] = qv; keys[b + 1] = kv
            }
            val q = use[Math.floor(m * 0.55).toInt()]; val o = (by * ow + bx) * 4
            out[o] = dd[q]; out[o + 1] = dd[q + 1]; out[o + 2] = dd[q + 2]; out[o + 3] = -1
        }
        return LifeReduced(LifeImage(ow, oh, out), ow, oh, (ax - x0).toDouble() / k, (ay - y0).toDouble() / k)
    }

    /** life.js `meanLuma` of an atlas rect's opaque pixels (0 when none). */
    fun meanLuma(img: LifeImage, x: Int, y: Int, w: Int, h: Int): Double {
        var n = 0; var l = 0.0
        for (yy in 0 until h) for (xx in 0 until w) {
            val q = ((y + yy) * img.width + x + xx) * 4
            if (u(img.data[q + 3]) >= 128) { n++; l += luma(img.data, q) }
        }
        return if (n != 0) l / n else 0.0
    }
}
