package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import java.io.ByteArrayInputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest
import java.util.Base64
import java.util.zip.GZIPInputStream

/** The NR golden suites (`tools/world-ground-golden.mjs`, pinned web code over the real packs) and their encodings. */
internal object GroundGolden {
    private val cache = HashMap<String, JsonValue>()

    /** A suite from `/world/ground/<suite>.json`; fails loudly when it is absent (never a skipped test). */
    fun suite(name: String): JsonValue = cache.getOrPut(name) {
        val stream = checkNotNull(GroundGolden::class.java.getResourceAsStream("/world/ground/$name.json")) {
            "golden suite $name.json is missing: run node tools/world-ground-golden.mjs --source <monorepo root>"
        }
        JsonReader().parse(stream.use { it.readBytes().toString(Charsets.UTF_8) })
    }

    /** The realm ids with a classify suite (all packs the pinned manifest lists). */
    val REALMS = listOf("cinderfall", "crownlands", "elderwood", "frostveil", "seeker-reach", "stormcairn", "sunscar", "thornwake")

    /** A 16-hex-digit IEEE-754 bit string → the double, bit for bit. */
    fun hx(s: String): Double = java.lang.Double.longBitsToDouble(java.lang.Long.parseUnsignedLong(s, 16))
    fun hx(v: JsonValue): Double = hx(v.asString())
    fun bits(d: Double): String = String.format("%016x", java.lang.Double.doubleToRawLongBits(d))

    fun gunzip(b64: String): ByteArray = GZIPInputStream(ByteArrayInputStream(Base64.getDecoder().decode(b64))).use { it.readBytes() }

    fun sha256(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun sha256Ints(v: IntArray, n: Int = v.size): String {
        val b = ByteBuffer.allocate(n * 4).order(ByteOrder.LITTLE_ENDIAN); for (i in 0 until n) b.putInt(v[i]); return sha256(b.array())
    }
    fun sha256Doubles(v: DoubleArray): String {
        val b = ByteBuffer.allocate(v.size * 8).order(ByteOrder.LITTLE_ENDIAN); for (d in v) b.putDouble(d); return sha256(b.array())
    }

    fun list(v: JsonValue?): List<JsonValue> { val out = ArrayList<JsonValue>(); var c = v?.child; while (c != null) { out.add(c); c = c.next }; return out }
    fun ints(v: JsonValue): IntArray = list(v).map { it.asInt() }.toIntArray()

    /** A cropped image from the golden's `{ width, height, crops: [{ x0, y0, w, h, gz }] }`. */
    fun image(v: JsonValue, key: String = "crops"): FieldImage {
        val rects = list(v.get(key)).map { FieldImage.Rect(it.getInt("x0"), it.getInt("y0"), it.getInt("w"), it.getInt("h"), gunzip(it.getString("gz"))) }
        return FieldImage(v.getInt("width"), v.getInt("height"), 4, rects.toTypedArray())
    }
}
