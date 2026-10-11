package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.sqrt

/**
 * The integer hashes and noises the web GROUND lane shares with its GLSL twins (`glsl/common.glsl.js` kitHash / pcg2d /
 * vnoise, `classify.js` znoise / smin / smax), plus the JavaScript number semantics a bit-exact port needs.
 *
 * Parity rules (golden vectors check every one):
 * - hashes are uint32 in JS; here they are the same 32 bits in an [Int] (use [u32] / `Integer.remainderUnsigned` where the
 *   JS divides or compares the unsigned value);
 * - every double expression keeps the JS evaluation order (the JVM never contracts to FMA);
 * - `Math.sin/cos/atan2/exp/log` are V8's fdlibm ports, so [StrictMath] (fdlibm) is used, never [Math];
 * - `Math.hypot` is V8's own normalised Kahan sum ([jsHypot]), not fdlibm's `e_hypot`;
 * - `Math.round` rounds half up ([jsRound]).
 */
object GroundMath {
    const val TAU = 2 * Math.PI
    const val SQRT2 = 1.4142135623730951 // Math.SQRT2

    /** The kit's `realmKitTileHash` (packages/shared realmKit.ts), verbatim: the uint32 result as Int bits. */
    fun kitHash(tx: Int, ty: Int): Int {
        var h = (tx * 0x27d4eb2d) xor (ty * 0x165667b1) xor 0x5bd1e995
        h = h xor (h ushr 15); h *= 0x2c1b3c6d
        h = h xor (h ushr 12); h *= 0x297a2d39
        h = h xor (h ushr 15)
        return h
    }

    /** uint32 bits → the unsigned value. */
    fun u32(h: Int): Long = h.toLong() and 0xffffffffL

    /** Hash → [0, 1) from its top 24 bits (GLSL `float(h >> 8u) / 16777216.0`). */
    fun unit24(h: Int): Double = (h ushr 8).toDouble() / 16777216.0

    /** `pcg2d(x, y)[0]` (common.glsl.js): the x word only, which every noise here reads. */
    fun pcg2dX(x0: Int, y0: Int): Int {
        var x = x0 * 1664525 + 1013904223
        var y = y0 * 1664525 + 1013904223
        x += y * 1664525; y += x * 1664525
        x = x xor (x ushr 16); y = y xor (y ushr 16)
        x += y * 1664525; y += x * 1664525
        x = x xor (x ushr 16)
        return x
    }

    /** Value noise at (vx, vy) (common.glsl.js `vnoise`, GLSL `vnoise(ivec2, int, uint)`), in [−1, 1]. */
    fun vnoise(vx: Double, vy: Double, period: Double, seed: Int): Double {
        val cxD = floor(vx / period); val cyD = floor(vy / period)
        var fx = (vx - cxD * period) / period; var fy = (vy - cyD * period) / period
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
        val s0 = seed; val s1 = seed * 7
        val cx = toInt32(cxD); val cy = toInt32(cyD)
        val a = u01(pcg2dX(cx xor s0, cy xor s1)); val b = u01(pcg2dX((cx + 1) xor s0, cy xor s1))
        val c = u01(pcg2dX(cx xor s0, (cy + 1) xor s1)); val d = u01(pcg2dX((cx + 1) xor s0, (cy + 1) xor s1))
        val ab = a + (b - a) * fx; val cd = c + (d - c) * fx
        return (ab + (cd - ab) * fy) * 2 - 1
    }

    private fun u01(h: Int): Double = (h ushr 8).toDouble() / 16777216.0

    /**
     * Zig-zag noise (classify.js `znoise`, GLSL `rmZNoise`): the mean of two value noises whose lattice values alternate in
     * sign by column and by row (magnitude 0.5…1), so the field crosses zero every `cell` units. [−1, 1].
     */
    fun znoise(x: Double, y: Double, cell: Double, seed: Int): Double {
        val cxD = floor(x / cell); val cyD = floor(y / cell)
        var fx = (x - cxD * cell) / cell; var fy = (y - cyD * cell) / cell
        fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy)
        val s0 = seed; val s1 = seed * 7
        val cx = toInt32(cxD); val cy = toInt32(cyD)
        val a = zAt(cx, cy, s0, s1); val b = zAt(cx + 1, cy, s0, s1); val c = zAt(cx, cy + 1, s0, s1); val d = zAt(cx + 1, cy + 1, s0, s1)
        val ab = a + (b - a) * fx; val cd = c + (d - c) * fx
        return 0.5 * (ab + (cd - ab) * fy)
    }

    private fun zMag(i: Int, j: Int, k: Int, s0: Int, s1: Int): Double = 0.5 + 0.5 * ((pcg2dX(i xor s0, j xor s1 xor k) ushr 8).toDouble() / 16777216.0)
    private fun zAt(i: Int, j: Int, s0: Int, s1: Int): Double {
        val m0 = zMag(i, j, 0, s0, s1); val m1 = zMag(i, j, 0x55, s0, s1)
        return (if (i and 1 != 0) -m0 else m0) + (if (j and 1 != 0) -m1 else m1)
    }

    /** Polynomial smooth min; ≤ min(a, b), equal once |a − b| ≥ k. */
    fun smin(a: Double, b: Double, k: Double): Double { val h = maxOf(k - abs(a - b), 0.0) / k; return minOf(a, b) - h * h * k * 0.25 }

    /** Polynomial smooth max; ≥ max(a, b), equal once |a − b| ≥ k. */
    fun smax(a: Double, b: Double, k: Double): Double { val h = maxOf(k - abs(a - b), 0.0) / k; return maxOf(a, b) + h * h * k * 0.25 }

    /** JavaScript ToInt32: truncate toward zero, wrap modulo 2³² (non-finite → 0). */
    fun toInt32(d: Double): Int {
        if (d.isNaN() || d.isInfinite()) return 0
        val t = if (d < 0) ceil(d) else floor(d)
        return (t % 4294967296.0).toLong().toInt()
    }

    /** JavaScript `Math.round`: the nearest integer, halves toward +∞. */
    fun jsRound(x: Double): Double {
        if (x.isNaN() || x.isInfinite()) return x
        val c = ceil(x)
        return if (c - 0.5 > x) c - 1.0 else c
    }

    /** V8's `Math.hypot(a, b)` (builtins math.tq): |values| normalised by the largest, Kahan-summed squares, √ × max. */
    fun jsHypot(a: Double, b: Double): Double {
        if (a.isInfinite() || b.isInfinite()) return Double.POSITIVE_INFINITY
        if (a.isNaN() || b.isNaN()) return Double.NaN
        val x = abs(a); val y = abs(b)
        val max = if (y > x) y else x
        if (max == 0.0) return 0.0
        var sum = 0.0; var compensation = 0.0
        run {
            val n = x / max; val summand = n * n - compensation; val preliminary = sum + summand
            compensation = (preliminary - sum) - summand; sum = preliminary
        }
        run {
            val n = y / max; val summand = n * n - compensation; val preliminary = sum + summand
            compensation = (preliminary - sum) - summand; sum = preliminary
        }
        return sqrt(sum) * max
    }

    fun clamp(x: Double, a: Double, b: Double): Double = maxOf(a, minOf(b, x))

    /** `Math.fround`: the nearest float32. */
    fun fround(x: Double): Double = x.toFloat().toDouble()
}
