package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.io.File
import java.security.MessageDigest

/**
 * The golden-vector kit of the LIFE/BASES parity tests (tools/world-lifebases.mjs): resource loading, the canonical
 * projection the generator hashes (an integer below 2^53 in decimal, any other number as `x` + its IEEE-754 bits, strings
 * JSON-quoted, booleans 1/0, lists `[a,b]`), and the synthetic terrain every placement golden uses.
 */
object GoldenKit {
    fun json(owner: Class<*>, name: String): JsonValue {
        val s = owner.getResourceAsStream(name) ?: error("golden $name is not on the test classpath (run tools/world-lifebases.mjs)")
        return JsonReader().parse(s.use { String(it.readBytes(), Charsets.UTF_8) })
    }

    /** The app's constants catalogue (game numbers), as other renderer tests read it. */
    fun catalogue(): JsonValue = JsonReader().parse(File("../app/src/main/assets/native/catalogue.json").readText()).get("constants")

    fun num(v: Double): String {
        if (!v.isNaN() && !v.isInfinite() && v == Math.floor(v) && Math.abs(v) < 9007199254740992.0) return (if (v == 0.0) 0L else v.toLong()).toString()
        return "x" + String.format("%016x", java.lang.Double.doubleToLongBits(v))
    }

    fun canon(v: Any?): String = when (v) {
        null -> "null"
        is Boolean -> if (v) "1" else "0"
        is Int -> v.toString()
        is Long -> v.toString()
        is Double -> num(v)
        is Float -> num(v.toDouble())
        is String -> quote(v)
        is IntArray -> v.joinToString(",", "[", "]") { it.toString() }
        is DoubleArray -> v.joinToString(",", "[", "]") { num(it) }
        is List<*> -> v.joinToString(",", "[", "]") { canon(it) }
        is Array<*> -> v.joinToString(",", "[", "]") { canon(it) }
        else -> error("canon: unsupported ${v.javaClass}")
    }

    /** JSON.stringify of a string (the escapes V8 writes). */
    fun quote(s: String): String {
        val b = StringBuilder("\"")
        for (ch in s) when {
            ch == '"' -> b.append("\\\""); ch == '\\' -> b.append("\\\\")
            ch == '\b' -> b.append("\\b"); ch == '\u000c' -> b.append("\\f"); ch == '\n' -> b.append("\\n"); ch == '\r' -> b.append("\\r"); ch == '\t' -> b.append("\\t")
            ch.code < 0x20 -> b.append(String.format("\\u%04x", ch.code))
            else -> b.append(ch)
        }
        return b.append('"').toString()
    }

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun hashOf(v: Any?): String = sha256(canon(v).toByteArray(Charsets.UTF_8))

    fun u32(v: Int): Long = v.toLong() and 0xffffffffL

    /** The generator's synthetic terrain (golden `env`): 8-tile class blocks from kitHash; a plot SDF over fixed boxes. */
    class Env(private val plots: List<DoubleArray>) : LifeEnv {
        override fun classAt(tx: Int, ty: Int): Int = (u32(LifeHash.kitHash((tx shr 3) xor 81, (ty shr 3) xor 47)) % 14).toInt()
        override fun plotSdf(x: Double, y: Double): Double {
            var m = 1e9
            for (p in plots) m = Math.min(m, Math.max(Math.abs(x - p[0]), Math.abs(y - p[1])) - p[2])
            return m
        }
    }

    /** mulberry32 (the generator's and the web tests' sample generator). */
    class Rng(seed: Long) {
        private var s = seed.toInt()
        fun next(): Double {
            s += 0x6D2B79F5
            var t = s
            t = (t xor (t ushr 15)) * (t or 1)
            t = t xor (t + (t xor (t ushr 7)) * (t or 61))
            return u32(t xor (t ushr 14)).toDouble() / 4294967296.0
        }
    }

    /** The generator's `synthImage(w, h, seed)`. */
    fun synthImage(w: Int, h: Int, seed: Long): LifeImage {
        val r = Rng(seed); val data = ByteArray(w * h * 4)
        val pal = arrayOf(intArrayOf(30, 20, 15), intArrayOf(70, 110, 40), intArrayOf(90, 140, 50), intArrayOf(120, 170, 70), intArrayOf(200, 190, 120), intArrayOf(10, 10, 10))
        for (y in 0 until h) for (x in 0 until w) {
            val i = (y * w + x) * 4
            val a = x - w / 2.0; val bw = w / 2.2; val c = y - h * 0.6; val bh = h / 2.6
            val inside = (a * a) / (bw * bw) + (c * c) / (bh * bh) < 1
            val p = pal[Math.floor(r.next() * 6).toInt()]
            data[i] = p[0].toByte(); data[i + 1] = p[1].toByte(); data[i + 2] = p[2].toByte()
            data[i + 3] = (if (inside) (if (r.next() < 0.9) 255 else 90) else (if (r.next() < 0.05) 200 else Math.floor(r.next() * 100).toInt())).toByte()
        }
        return LifeImage(w, h, data)
    }

    fun ints(v: JsonValue): IntArray = v.asIntArray()
    fun doubles(v: JsonValue): DoubleArray = v.asDoubleArray()
    fun children(v: JsonValue?): List<JsonValue> { val out = ArrayList<JsonValue>(); var c = v?.child; while (c != null) { out.add(c); c = c.next }; return out }
}

/**
 * A canonical string of a nested value, so a golden JSON object (sorted keys) and a Kotlin projection compare as one
 * string (and a failure prints both): objects with sorted keys, lists, numbers as [GoldenKit.num] (exact), strings quoted.
 */
object Deep {
    fun json(v: JsonValue?): String {
        if (v == null || v.isNull) return "null"
        return when {
            v.isObject -> GoldenKit.children(v).sortedBy { it.name }.joinToString(",", "{", "}") { GoldenKit.quote(it.name) + ":" + json(it) }
            v.isArray -> GoldenKit.children(v).joinToString(",", "[", "]") { json(it) }
            v.isString -> GoldenKit.quote(v.asString())
            v.isBoolean -> if (v.asBoolean()) "1" else "0"
            v.isLong -> GoldenKit.num(v.asLong().toDouble())
            else -> GoldenKit.num(v.asDouble())
        }
    }

    fun kotlin(v: Any?): String = when (v) {
        null -> "null"
        is Map<*, *> -> v.entries.sortedBy { it.key as String }.joinToString(",", "{", "}") { GoldenKit.quote(it.key as String) + ":" + kotlin(it.value) }
        is List<*> -> v.joinToString(",", "[", "]") { kotlin(it) }
        is Array<*> -> v.joinToString(",", "[", "]") { kotlin(it) }
        is IntArray -> v.joinToString(",", "[", "]") { it.toString() }
        is LongArray -> v.joinToString(",", "[", "]") { it.toString() }
        is DoubleArray -> v.joinToString(",", "[", "]") { GoldenKit.num(it) }
        is Boolean -> if (v) "1" else "0"
        is Int -> v.toString()
        is Long -> GoldenKit.num(v.toDouble())
        is Double -> GoldenKit.num(v)
        is String -> GoldenKit.quote(v)
        else -> error("Deep: unsupported ${v.javaClass}")
    }

    /** The keys of a golden planDraws projection object, in the order of the flat list [LifeGoldenTest] builds. */
    val PLAN_KEYS = listOf("total", "cap", "trueOn", "trueClasses", "tau", "model", "groups", "stands", "creatures", "birds", "ambience")
}

/**
 * A tolerant deep comparison for values V8's `Math.pow` reaches: V8's pow is not fdlibm (measured: 1 ulp apart on ~4 %
 * of inputs against [StrictMath.pow]), so those doubles match within [rel] relative; every integer, string and null exact.
 */
object Close {
    fun assertClose(where: String, json: JsonValue?, v: Any?, rel: Double = 1e-12) {
        if (json == null || json.isNull) { if (v != null) throw AssertionError("$where: expected null, got $v"); return }
        when {
            json.isArray -> {
                val list: List<Any?> = when (v) { is List<*> -> v; is IntArray -> v.toList(); is DoubleArray -> v.toList(); is LongArray -> v.toList(); is Array<*> -> v.toList()
                    else -> throw AssertionError("$where: expected a list, got $v") }
                val kids = GoldenKit.children(json)
                if (kids.size != list.size) throw AssertionError("$where: expected ${kids.size} items, got ${list.size}")
                for (i in kids.indices) assertClose("$where[$i]", kids[i], list[i], rel)
            }
            json.isString -> if (json.asString() != v) throw AssertionError("$where: expected ${json.asString()}, got $v")
            json.isBoolean -> if (json.asBoolean() != (v == true || v == 1)) throw AssertionError("$where: expected ${json.asBoolean()}, got $v")
            else -> {
                val a = json.asDouble(); val b = (v as? Number)?.toDouble() ?: throw AssertionError("$where: expected $a, got $v")
                val ok = a == b || (a.isNaN() && b.isNaN()) || Math.abs(a - b) <= rel * Math.max(Math.abs(a), Math.abs(b))
                if (!ok) throw AssertionError("$where: expected $a, got $b")
            }
        }
    }
}
