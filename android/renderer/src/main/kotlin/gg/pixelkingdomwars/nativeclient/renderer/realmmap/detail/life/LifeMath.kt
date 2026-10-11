package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

/**
 * The JavaScript number semantics the realm-map LIFE and BASES ports need to reproduce the web engine bit for bit
 * (golden vectors, GLOBE-NATIVE-PLAN §7): V8's `Math.round`, `Math.hypot` and `>>>`/`Math.imul`, and fdlibm
 * transcendental functions through [StrictMath] (V8's `Math.sin/cos/atan2/log/pow` are fdlibm ports; the JIT-intrinsic
 * `java.lang.Math` versions may differ in the last bit). Pure JVM; allocation-free.
 */
object JsMath {
    /** V8 `Math.round`: ceil, then one down when the ceiling is more than ½ above (ties go to +∞). */
    fun round(x: Double): Double {
        if (x.isNaN() || x.isInfinite()) return x
        val c = Math.ceil(x)
        return if (c - 0.5 <= x) c else c - 1.0
    }

    /** V8 `Math.hypot(a, b)`: normalise by the largest magnitude, Kahan-summed squares, `sqrt(sum) · max`. */
    fun hypot(a: Double, b: Double): Double {
        if (a.isInfinite() || b.isInfinite()) return Double.POSITIVE_INFINITY
        if (a.isNaN() || b.isNaN()) return Double.NaN
        val x = Math.abs(a); val y = Math.abs(b)
        val max = if (y > x) y else x
        if (max == 0.0) return 0.0
        var sum = 0.0; var comp = 0.0
        var n = x / max; var summand = n * n - comp; var pre = sum + summand; comp = (pre - sum) - summand; sum = pre
        n = y / max; summand = n * n - comp; pre = sum + summand; sum = pre
        return Math.sqrt(sum) * max
    }

    fun log(x: Double): Double = StrictMath.log(x)
    fun pow(x: Double, y: Double): Double = StrictMath.pow(x, y)
    fun sin(x: Double): Double = StrictMath.sin(x)
    fun cos(x: Double): Double = StrictMath.cos(x)
    fun atan2(y: Double, x: Double): Double = StrictMath.atan2(y, x)

    /** `v >>> 0` as a double (the uint32 view of a 32-bit int). */
    fun u32(v: Int): Double = (v.toLong() and 0xffffffffL).toDouble()
    fun u32L(v: Int): Long = v.toLong() and 0xffffffffL

    /** JS ToInt32 (`v | 0`) of a double: modulo 2^32, NaN/±∞ → 0. */
    fun toInt32(v: Double): Int {
        if (v.isNaN() || v.isInfinite()) return 0
        val t = if (v < 0) Math.ceil(v) else Math.floor(v)
        val m = t % 4294967296.0
        return m.toLong().toInt()
    }

    /** JS `clamp(x, a, b)` = `Math.max(a, Math.min(b, x))` (NaN propagates like the web's). */
    fun clamp(x: Double, a: Double, b: Double): Double = Math.max(a, Math.min(b, x))
}

/**
 * The engine's integer hashes (web `glsl/common.glsl.js` JS twins, the GLSL uses the same uint maths): [kitHash] is the
 * realm kit's `realmKitTileHash` verbatim, [pcg2d] the 2D PCG. Results are 32-bit patterns in an [Int]; read the
 * unsigned value with [JsMath.u32L].
 */
object LifeHash {
    fun kitHash(tx: Int, ty: Int): Int {
        var h = (tx * 0x27d4eb2d) xor (ty * 0x165667b1) xor 0x5bd1e995
        h = h xor (h ushr 15); h *= 0x2c1b3c6d
        h = h xor (h ushr 12); h *= 0x297a2d39
        h = h xor (h ushr 15)
        return h
    }

    /** `pcg2d(x, y)[0]`. */
    fun pcgX(x0: Int, y0: Int): Int {
        var x = x0 * 1664525 + 1013904223; var y = y0 * 1664525 + 1013904223
        x += y * 1664525; y += x * 1664525
        x = x xor (x ushr 16); y = y xor (y ushr 16)
        x += y * 1664525; y += x * 1664525
        x = x xor (x ushr 16)
        return x
    }

    /** `pcg2d(x, y)[1]`. */
    fun pcgY(x0: Int, y0: Int): Int {
        var x = x0 * 1664525 + 1013904223; var y = y0 * 1664525 + 1013904223
        x += y * 1664525; y += x * 1664525
        x = x xor (x ushr 16); y = y xor (y ushr 16)
        x += y * 1664525; y += x * 1664525
        y = y xor (y ushr 16)
        return y
    }

    /** The per-instance hashed switch: on at weight [w] (`(h & 0xffff) < w · 65536`). Never an alpha blend. */
    fun dissolve(h: Int, w: Double): Boolean = (h and 0xffff) < w * 65536

    /** decor.js `hash2`: the kit hash over JS ToInt32 inputs (same bits as [kitHash]). */
    fun hash2(a: Int, b: Int): Int = kitHash(a, b)
}
