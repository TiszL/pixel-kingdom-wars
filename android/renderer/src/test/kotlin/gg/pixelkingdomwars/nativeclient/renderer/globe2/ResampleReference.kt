package gg.pixelkingdomwars.nativeclient.renderer.globe2

import kotlin.math.atan
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * The Phase E layer resample as it shipped in code 29 (PhaseEIslandLayer.resample at 66b85c0, verbatim but for the
 * qualified names): one thread, `V.dirOf` and nine land tests per texel. The banded resample that replaced it
 * (2026-09-27) must produce these bytes exactly: the islands look the same, only sooner.
 */
internal object ResampleReference {
    private val TEAL = doubleArrayOf(58.0, 170.0, 190.0)

    fun resample(spec: GlobeIslandSpec, rgba: ByteArray, w: Int, h: Int, size: Int): ByteArray {
        require(rgba.size == w * h * 4) { "${spec.id} art is ${rgba.size} bytes, not ${w}x$h" }
        val b = PhaseEIslandLayer.box(spec)
        val art = Reduced(rgba, w, h, PhaseEIslandLayer.reduction(spec, w, h, size))
        val kw = art.w; val kh = art.h
        val c = DoubleArray(3); val e = DoubleArray(3); val n = DoubleArray(3); val d = DoubleArray(3)
        PhaseEIslandLayer.axes(spec, c, e, n)
        val hDeg = spec.wDeg * spec.aspect
        val margin = kw * PhaseEIslandLayer.MARGIN
        val step = max(1, (kw * PhaseEIslandLayer.NEAR_STEP).roundToInt())
        val out = ByteArray(size * size * 4)
        val px = DoubleArray(4)
        for (j in 0 until size) for (i in 0 until size) {
            val lon = spec.lon + b[0] * ((i + 0.5) / (size / 2.0) - 1)
            val lat = spec.lat + b[1] * (1 - (j + 0.5) / (size / 2.0))
            V.dirOf(d, lon, lat)
            val dz = V.dot(d, c)
            if (dz < PhaseEIslandLayer.DZ_MIN) continue
            val u = atan(V.dot(d, e) / dz) / V.RAD; val v = atan(V.dot(d, n) / dz) / V.RAD
            val fx = (u / spec.wDeg + 0.5) * kw; val fy = (0.5 - v / hDeg) * kh
            if (fx < -margin || fy < -margin || fx > kw + margin || fy > kh + margin) continue
            var near = 0
            val cx = floor(fx).toInt(); val cy = floor(fy).toInt()
            for (dy in -1..1) for (dx in -1..1) {
                val xx = cx + dx * step; val yy = cy + dy * step
                if (xx >= 0 && yy >= 0 && xx < kw && yy < kh && art.land(yy * kw + xx)) near++
            }
            val inside = fx >= 0 && fy >= 0 && fx < kw && fy < kh
            if (inside) {
                val bx = V.clamp(fx - 0.5, 0.0, kw - 1.001); val by = V.clamp(fy - 0.5, 0.0, kh - 1.001)
                val xa = floor(bx).toInt(); val ya = floor(by).toInt(); val tx = bx - xa; val ty = by - ya
                val t00 = ya * kw + xa; val t10 = ya * kw + minOf(kw - 1, xa + 1)
                val t01 = minOf(kh - 1, ya + 1) * kw + xa; val t11 = minOf(kh - 1, ya + 1) * kw + minOf(kw - 1, xa + 1)
                for (ch in 0 until 4) px[ch] = (art.pm(t00, ch) * (1 - tx) + art.pm(t10, ch) * tx) * (1 - ty) + (art.pm(t01, ch) * (1 - tx) + art.pm(t11, ch) * tx) * ty
            } else px.fill(0.0)
            // premultiplied art colour = rgb · a (composite's alpha-weighted colour times its alpha)
            val a = px[3] / 255; val cr = px[0]; val cg = px[1]; val cb = px[2]
            val hk = if (near > 0 && a < 0.5) PhaseEIslandLayer.SHALLOWS * near / 9 else 0.0
            val alpha = hk + a - hk * a
            if (alpha <= 0.0) continue
            val o = (j * size + i) * 4
            out[o] = (TEAL[0] * hk * (1 - a) + cr).roundToInt().coerceIn(0, 255).toByte()
            out[o + 1] = (TEAL[1] * hk * (1 - a) + cg).roundToInt().coerceIn(0, 255).toByte()
            out[o + 2] = (TEAL[2] * hk * (1 - a) + cb).roundToInt().coerceIn(0, 255).toByte()
            out[o + 3] = (alpha * 255).roundToInt().coerceIn(0, 255).toByte()
        }
        return out
    }

    /**
     * The art at 1/[k] as premultiplied 8-bit texels ([w]×[h] of them): with k = 1 the straight-alpha art itself,
     * premultiplied as it is read (no copy); else its k×k box average (4 B a texel). [pm] is 0..255 premultiplied
     * rgb, or the alpha for channel 3.
     */
    private class Reduced(private val rgba: ByteArray, sw: Int, sh: Int, k: Int) {
        val w = sw / k; val h = sh / k
        private val box: ByteArray? = if (k == 1) null else ByteArray(w * h * 4).also { out ->
            val nk = k * k
            for (y in 0 until h) for (x in 0 until w) {
                var r = 0; var g = 0; var bl = 0; var a = 0
                for (yy in 0 until k) for (xx in 0 until k) {
                    val i = ((y * k + yy) * sw + x * k + xx) * 4
                    val al = rgba[i + 3].toInt() and 0xFF
                    r += (rgba[i].toInt() and 0xFF) * al; g += (rgba[i + 1].toInt() and 0xFF) * al; bl += (rgba[i + 2].toInt() and 0xFF) * al; a += al
                }
                val o = (y * w + x) * 4
                out[o] = ((r + 255 * nk / 2) / (255 * nk)).toByte(); out[o + 1] = ((g + 255 * nk / 2) / (255 * nk)).toByte()
                out[o + 2] = ((bl + 255 * nk / 2) / (255 * nk)).toByte(); out[o + 3] = ((a + nk / 2) / nk).toByte()
            }
        }

        fun pm(t: Int, ch: Int): Int {
            val b = box
            if (b != null) return b[t * 4 + ch].toInt() and 0xFF
            val a = rgba[t * 4 + 3].toInt() and 0xFF
            return if (ch == 3) a else ((rgba[t * 4 + ch].toInt() and 0xFF) * a + 127) / 255
        }

        /** composite.mjs islandAt's land: alpha over 128 and not the art's own water colour. */
        fun land(t: Int): Boolean {
            val al = pm(t, 3)
            if (al <= 128) return false
            val sr = pm(t, 0) * 255.0 / al; val sg = pm(t, 1) * 255.0 / al; val sb = pm(t, 2) * 255.0 / al
            return !(sg > 110 && sb > 130 && sr < 110 && sb - sr > 60)
        }
    }
}
