package gg.pixelkingdomwars.nativeclient.renderer.globe2

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/**
 * The concept's vector helpers (main.js "math" block) on DoubleArray(3), in the same operation order so the golden
 * vectors hold to the last bits that matter. The `into` forms write a caller array and never allocate (the steady
 * frame is allocation-free, plan §5.9); the returning forms are for set-up code.
 */
internal object V {
    const val RAD = Math.PI / 180

    fun dot(a: DoubleArray, b: DoubleArray): Double = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    /** `Math.hypot(x, y, z)` (V8 scales by the largest magnitude; sqrt of the sum is equal within 1 ulp here). */
    fun len(a: DoubleArray): Double = sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2])
    fun set(o: DoubleArray, x: Double, y: Double, z: Double): DoubleArray { o[0] = x; o[1] = y; o[2] = z; return o }
    fun copy(o: DoubleArray, a: DoubleArray): DoubleArray = set(o, a[0], a[1], a[2])
    /** norm(a) = mulS(a, 1 / len(a)). */
    fun norm(o: DoubleArray, a: DoubleArray): DoubleArray { val k = 1 / len(a); return set(o, a[0] * k, a[1] * k, a[2] * k) }
    fun cross(o: DoubleArray, a: DoubleArray, b: DoubleArray): DoubleArray =
        set(o, a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])
    fun add(o: DoubleArray, a: DoubleArray, b: DoubleArray): DoubleArray = set(o, a[0] + b[0], a[1] + b[1], a[2] + b[2])
    fun sub(o: DoubleArray, a: DoubleArray, b: DoubleArray): DoubleArray = set(o, a[0] - b[0], a[1] - b[1], a[2] - b[2])
    fun mulS(o: DoubleArray, a: DoubleArray, s: Double): DoubleArray = set(o, a[0] * s, a[1] * s, a[2] * s)
    /** Cross with the world up (0, 1, 0) first: cross([0,1,0], a). */
    fun crossUp(o: DoubleArray, a: DoubleArray): DoubleArray = set(o, 1 * a[2] - 0 * a[1], 0 * a[0] - 0 * a[2], 0 * a[1] - 1 * a[0])

    fun dirOf(o: DoubleArray, lon: Double, lat: Double): DoubleArray =
        set(o, cos(lat * RAD) * sin(lon * RAD), sin(lat * RAD), cos(lat * RAD) * cos(lon * RAD))
    fun dirOf(lon: Double, lat: Double): DoubleArray = dirOf(DoubleArray(3), lon, lat)
    fun lon(d: DoubleArray): Double = atan2(d[0], d[2]) / RAD
    fun lat(d: DoubleArray): Double = asin(d[1].coerceIn(-1.0, 1.0)) / RAD

    fun clamp(x: Double, a: Double, b: Double): Double = maxOf(a, minOf(b, x))
    fun mix(a: Double, b: Double, t: Double): Double = a + (b - a) * t
    /** main.js smooth(a, b, x) (edges may be reversed: it is the formula, not GLSL smoothstep). */
    fun smooth(a: Double, b: Double, x: Double): Double { val t = clamp((x - a) / (b - a), 0.0, 1.0); return t * t * (3 - 2 * t) }

    /** Rodrigues rotation of v about the unit axis k by ang (main.js rotate). */
    fun rotate(o: DoubleArray, v: DoubleArray, k: DoubleArray, ang: Double): DoubleArray {
        val c = cos(ang); val s = sin(ang)
        val kvx = k[1] * v[2] - k[2] * v[1]; val kvy = k[2] * v[0] - k[0] * v[2]; val kvz = k[0] * v[1] - k[1] * v[0]
        val kd = dot(k, v)
        return set(o, v[0] * c + kvx * s + k[0] * kd * (1 - c), v[1] * c + kvy * s + k[1] * kd * (1 - c), v[2] * c + kvz * s + k[2] * kd * (1 - c))
    }

    /** main.js slerp(a, b, t) (b itself when the angle is below 1e-5). */
    fun slerp(o: DoubleArray, a: DoubleArray, b: DoubleArray, t: Double): DoubleArray {
        val d = clamp(dot(a, b), -1.0, 1.0); val w = kotlin.math.acos(d)
        if (w < 1e-5) return copy(o, b)
        val s = sin(w); val ka = sin((1 - t) * w) / s; val kb = sin(t * w) / s
        return set(o, a[0] * ka + b[0] * kb, a[1] * ka + b[1] * kb, a[2] * ka + b[2] * kb)
    }
}
