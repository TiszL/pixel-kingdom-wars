package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.world.ExactPng
import java.security.MessageDigest

/**
 * Where realm pack bytes come from (GLOBE-NATIVE-PLAN §6.3): the debug-bundled world content (`AssetManager`
 * `world/…`, NT's bundler) today, a verified `ContentStore` group later. Paths are relative to the pack root:
 * `realm/index.json`, `realm/<id>/realm.json`, `realm/<id>/chart8.webp`, … Called on a decode thread, never the GL thread.
 */
interface RealmPackFiles {
    /** The file's bytes, or null when it is absent. */
    fun read(path: String): ByteArray?
    /** The sha256 an outer manifest pins for [path] (`world/content.json` in the debug bundle), or null when there is
     *  no outer manifest. The loader checks it for every file, on top of the pack's own `realm.json` hashes. */
    fun expectedSha256(path: String): String? = null
}

/** Straight (non-premultiplied) RGBA8 pixels, row-major from the top. */
class RgbaImage(val width: Int, val height: Int, val rgba: ByteArray) {
    init { require(width > 0 && height > 0 && rgba.size == width * height * 4) { "Bad RGBA image ${width}x$height" } }
}

/**
 * Decodes an art image (the chart8 WebP) into straight RGBA. `:app` implements it with `BitmapFactory`
 * (`inPremultiplied = false`, `inScaled = false`); data PNGs never come here (they go through [ExactPng]).
 */
fun interface RealmImageDecoder { fun decode(bytes: ByteArray, key: String): RgbaImage? }

class RealmPackException(message: String) : RuntimeException(message)

/** One row of `realm/index.json`. [status] is `preview`, `unsynced` or `ready` (only `ready` may leave FAR in N3). */
class RealmIndexEntry(val id: String, val name: String, val status: String, val packVersion: String?, val deeds: Int)

/** The fields of `realm.json` (schema 1) the overview reads. */
class RealmMeta(
    val id: String, val name: String, val status: String, val packVersion: String?,
    val x0: Int, val y0: Int, val cols: Int, val rows: Int, val deeds: Int,
    /** file key → sha256 (every file the pack ships, `realm.json` itself excluded). */
    val files: Map<String, String>,
    val chartFile: String, val chartW: Int, val chartH: Int,
    val deedsFile: String, val deedThisRealm: Int, val deedOtherRealm: Int,
)

/**
 * The first-frame set of one realm, decoded and verified off the GL thread (web `openRealm` → `first`), plus what the
 * minimap derives from it. Held only until the GL thread has handed every level to the uploader: a context loss
 * re-reads the verified files (plan §5.7, no RAM-resident decoded cache).
 */
class RealmFirstSet(
    val meta: RealmMeta,
    val grid: RealmGrid,
    /** chart8 mip chain: level 0 is the decoded painting, each next level a 2×2 box average (the WebGL
     *  `generateMipmap` of `core.tex.image(…, { mips: true })`; chart8 is a painting, not pixel art). */
    val chartLevels: Array<RgbaImage>,
    /** The deeds mask the engine uploads and picks with: the catalog's when one was given, else the pack's. */
    val deeds: ByteArray,
    /** The pack's own mask, as shipped. */
    val packDeeds: ByteArray,
    /** Deeds where the pack mask disagrees with the catalog on "this realm" (0 without a catalog). */
    val maskMismatch: Int,
    val catalogUsed: Boolean,
    /** minimap.js `farDeeds` → R8 (`min(255, round(v · 16))`). */
    val far: ByteArray,
    /** minimap.js `ringSea`: the painting's own open-sea colour, 0..1 RGB. */
    val sea: FloatArray,
    val bytesRead: Long,
)

/**
 * Reads, verifies and decodes realm packs (web `loader.js`, native rules): every byte is hashed against the pack's own
 * `realm.json` `files` table, and `realm.json` / `index.json` against the outer manifest when there is one; a missing
 * hash, a mismatch, a wrong image size or a deed count that disagrees with `grid.deeds` refuses the realm (Rule 12:
 * never drawn approximately). Pure JVM; runs on the decode threads.
 */
class RealmLoader(private val files: RealmPackFiles, private val images: RealmImageDecoder) {
    // No shared JsonReader: a realm's first set can still be parsing on one world-load thread when a context restore or
    // the next prepare starts another on the second, and a JsonReader keeps its parse state in fields (one reader per
    // call, P0 2026-09-26).

    fun index(): List<RealmIndexEntry> {
        val root = parse(verified(INDEX, null), INDEX)
        val out = ArrayList<RealmIndexEntry>()
        var r = root.get("realms")?.child ?: throw RealmPackException("$INDEX has no realms")
        while (true) {
            val id = r.getString("id")
            out += RealmIndexEntry(id, r.getString("name", id), r.getString("status", "preview"), r.getString("packVersion", null), r.getInt("deeds", 0))
            r = r.next ?: break
        }
        return out
    }

    fun meta(realmId: String): RealmMeta {
        require(ID.matches(realmId)) { "Bad realm id $realmId" }
        val path = "realm/$realmId/realm.json"
        val root = parse(verified(path, null), path)
        if (root.getInt("schema", -1) != 1) throw RealmPackException("$path: schema ${root.getInt("schema", -1)} is not 1")
        if (root.getString("id", null) != realmId) throw RealmPackException("$path names realm ${root.getString("id", null)}")
        val g = root.get("grid") ?: throw RealmPackException("$path has no grid")
        val filesTable = LinkedHashMap<String, String>()
        var f = root.get("files")?.child
        while (f != null) { f.getString("sha256", null)?.let { filesTable[f.name] = it }; f = f.next }
        val chart = root.get("chart8")
        val deeds = root.get("deeds")
        return RealmMeta(
            realmId, root.getString("name", realmId), root.getString("status", "preview"), root.getString("packVersion", null),
            g.getInt("x0"), g.getInt("y0"), g.getInt("cols"), g.getInt("rows"), g.getInt("deeds"), filesTable,
            chart?.getString("file", CHART_KEY) ?: CHART_KEY, chart?.getInt("w", -1) ?: -1, chart?.getInt("h", -1) ?: -1,
            deeds?.getString("file", DEEDS_KEY) ?: DEEDS_KEY, deeds?.getInt("thisRealm", -1) ?: -1, deeds?.getInt("otherRealm", -1) ?: -1,
        )
    }

    /**
     * The verified first-frame set of [realmId]. With a [catalog], the uploaded mask is the catalog's (server truth) and
     * the pack's disagreement is counted; the pack mask's own deed count must still equal `grid.deeds`.
     */
    fun firstSet(realmId: String, config: RealmEngineConfig, catalog: RealmCatalog?): RealmFirstSet {
        val meta = meta(realmId)
        if (meta.deedThisRealm != config.deedThisRealm || meta.deedOtherRealm != config.deedOtherRealm)
            throw RealmPackException("realm $realmId: deeds mask values ${meta.deedThisRealm}/${meta.deedOtherRealm} differ from DEED_PX")
        val grid = RealmGrid(meta.x0, meta.y0, meta.cols, meta.rows, config.deedDeg)
        var bytes = 0L
        val chartBytes = verified("realm/$realmId/${meta.chartFile}", meta.files[meta.chartFile] ?: missingHash(realmId, meta.chartFile))
        val deedBytes = verified("realm/$realmId/${meta.deedsFile}", meta.files[meta.deedsFile] ?: missingHash(realmId, meta.deedsFile))
        bytes += chartBytes.size + deedBytes.size
        val png = ExactPng.decode(deedBytes) ?: throw RealmPackException("realm $realmId: ${meta.deedsFile} is not an exact-decodable PNG")
        if (png.width != meta.cols || png.height != meta.rows) throw RealmPackException("realm $realmId: deeds mask ${png.width}x${png.height} is not the ${meta.cols}x${meta.rows} grid")
        val pack = ByteArray(grid.size) { png.rgba[it * 4] }
        val count = pack.count { (it.toInt() and 0xff) == config.deedThisRealm }
        if (count != meta.deeds) throw RealmPackException("realm $realmId: deeds mask has $count deeds, realm.json declares ${meta.deeds}")
        val chart = images.decode(chartBytes, meta.chartFile) ?: throw RealmPackException("realm $realmId: ${meta.chartFile} did not decode")
        if (meta.chartW > 0 && (chart.width != meta.chartW || chart.height != meta.chartH))
            throw RealmPackException("realm $realmId: chart8 ${chart.width}x${chart.height} is not the declared ${meta.chartW}x${meta.chartH}")
        val catalogMask = catalog?.takeIf { realmId in it.realmIds }?.mask(realmId, grid, config.deedThisRealm, config.deedOtherRealm)
        val deeds = catalogMask ?: pack
        return RealmFirstSet(
            meta, grid, mipChain(chart), deeds, pack,
            if (catalogMask != null) RealmCatalog.mismatches(pack, catalogMask, config.deedThisRealm) else 0,
            catalogMask != null, farBytes(deeds, grid.cols, grid.rows, config.deedThisRealm), ringSea(chart), bytes,
        )
    }

    /**
     * A detail file of the realm [meta] describes (`realm.json` `files` key, e.g. `fieldsA.png`, `lines.json`), for the
     * N3 lanes: its bytes after the pack's own sha256 and the outer manifest's, both required to match (native rule:
     * content activates only after hash verification). A key `realm.json` pins no hash for is refused, never read
     * unverified. Decode thread only.
     */
    fun detail(meta: RealmMeta, key: String): ByteArray {
        require(!key.contains("..") && !key.startsWith("/")) { "Bad pack key $key" }
        return verified("realm/${meta.id}/$key", meta.files[key] ?: missingHash(meta.id, key))
    }

    /** Is [key] a file of this pack (pinned in `realm.json`)? */
    fun has(meta: RealmMeta, key: String): Boolean = meta.files.containsKey(key)

    /** Decode an art image of the pack (after [detail]) into straight RGBA with the app's decoder. */
    fun image(bytes: ByteArray, key: String): RgbaImage? = images.decode(bytes, key)

    private fun missingHash(realmId: String, key: String): Nothing = throw RealmPackException("realm $realmId: realm.json pins no sha256 for $key")

    /** The file's bytes after every hash that pins it: the pack's own `realm.json` table ([packSha256]) and the outer
     *  manifest (`world/content.json` for the debug bundle), whichever exist. */
    private fun verified(path: String, packSha256: String?): ByteArray {
        val bytes = files.read(path) ?: throw RealmPackException("$path is missing")
        val outer = files.expectedSha256(path)
        if (packSha256 == null && outer == null) return bytes
        val got = sha256Hex(bytes)
        if (packSha256 != null && got != packSha256.lowercase()) throw RealmPackException("$path does not match the sha256 its realm.json pins")
        if (outer != null && got != outer.lowercase()) throw RealmPackException("$path does not match the sha256 the content manifest pins")
        return bytes
    }

    private fun parse(bytes: ByteArray, path: String): JsonValue =
        try { JsonReader().parse(String(bytes, Charsets.UTF_8)) } catch (e: RuntimeException) { throw RealmPackException("$path is not JSON: ${e.message}") }

    companion object {
        const val INDEX = "realm/index.json"
        const val CHART_KEY = "chart8.webp"
        const val DEEDS_KEY = "deeds.png"
        private val ID = Regex("[a-z0-9][a-z0-9-]{0,40}")

        /** The debug world bundle's `content.json` (`files[].{path, sha256}`, paths relative to `world/`) as the outer
         *  manifest [RealmPackFiles.expectedSha256] answers from. */
        fun contentHashes(contentJson: String): Map<String, String> {
            val out = HashMap<String, String>()
            var f: JsonValue? = JsonReader().parse(contentJson).get("files")?.child ?: throw RealmPackException("content manifest has no files")
            while (f != null) { out[f.getString("path")] = f.getString("sha256"); f = f.next }
            return out
        }

        fun sha256Hex(bytes: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

        /** 2×2 box-averaged levels down to 1×1 (odd edges clamp), rounded to nearest. */
        fun mipChain(base: RgbaImage): Array<RgbaImage> {
            val levels = ArrayList<RgbaImage>()
            levels += base
            var cur = base
            while (cur.width > 1 || cur.height > 1) {
                val w = maxOf(1, cur.width / 2); val h = maxOf(1, cur.height / 2)
                val out = ByteArray(w * h * 4); val src = cur.rgba; val sw = cur.width
                for (y in 0 until h) for (x in 0 until w) {
                    val x0 = minOf(cur.width - 1, 2 * x); val x1 = minOf(cur.width - 1, 2 * x + 1)
                    val y0 = minOf(cur.height - 1, 2 * y); val y1 = minOf(cur.height - 1, 2 * y + 1)
                    for (c in 0 until 4) {
                        val sum = (src[(y0 * sw + x0) * 4 + c].toInt() and 0xff) + (src[(y0 * sw + x1) * 4 + c].toInt() and 0xff) +
                            (src[(y1 * sw + x0) * 4 + c].toInt() and 0xff) + (src[(y1 * sw + x1) * 4 + c].toInt() and 0xff)
                        out[(y * w + x) * 4 + c] = ((sum + 2) / 4).toByte()
                    }
                }
                cur = RgbaImage(w, h, out); levels += cur
            }
            return levels.toTypedArray()
        }

        /** minimap.js `farDeeds`: chamfer (1, √2) distance in deeds from this realm's own deeds, Float32 like the web. */
        fun farDeeds(deeds: ByteArray, cols: Int, rows: Int, thisRealm: Int): FloatArray {
            val d = FloatArray(cols * rows) { 1e9f }
            for (i in d.indices) if ((deeds[i].toInt() and 0xff) == thisRealm) d[i] = 0f
            val s2 = Math.sqrt(2.0)
            fun relax(x: Int, y: Int, dx: Int, dy: Int, w: Double) {
                val xx = x + dx; val yy = y + dy
                if (xx < 0 || yy < 0 || xx >= cols || yy >= rows) return
                val v = d[yy * cols + xx].toDouble() + w
                if (v < d[y * cols + x]) d[y * cols + x] = v.toFloat()
            }
            for (y in 0 until rows) for (x in 0 until cols) { relax(x, y, -1, 0, 1.0); relax(x, y, 0, -1, 1.0); relax(x, y, -1, -1, s2); relax(x, y, 1, -1, s2) }
            for (y in rows - 1 downTo 0) for (x in cols - 1 downTo 0) { relax(x, y, 1, 0, 1.0); relax(x, y, 0, 1, 1.0); relax(x, y, 1, 1, s2); relax(x, y, -1, 1, s2) }
            return d
        }

        fun farBytes(deeds: ByteArray, cols: Int, rows: Int, thisRealm: Int): ByteArray {
            val d = farDeeds(deeds, cols, rows, thisRealm)
            return ByteArray(d.size) { minOf(255.0, RealmBandRules.jsRound(d[it].toDouble() * 16)).toInt().toByte() }
        }

        /** minimap.js `ringSea`: the mean of the outer 3-px ring's blue-dominant pixels (all ring pixels when fewer
         *  than 20 % are), 0..1 RGB; the default deep sea when the ring is empty. */
        fun ringSea(img: RgbaImage): FloatArray {
            val w = img.width; val h = img.height; val data = img.rgba
            val ring = LongArray(4); val all = LongArray(4)
            for (y in 0 until h) for (x in 0 until w) {
                if (x > 2 && y > 2 && x < w - 3 && y < h - 3) continue
                val o = (y * w + x) * 4
                val r = data[o].toInt() and 0xff; val g = data[o + 1].toInt() and 0xff; val b = data[o + 2].toInt() and 0xff
                all[0] += r.toLong(); all[1] += g.toLong(); all[2] += b.toLong(); all[3]++
                if (b > r + 12 && b > g && r + g + b < 420) { ring[0] += r.toLong(); ring[1] += g.toLong(); ring[2] += b.toLong(); ring[3]++ }
            }
            val c = if (ring[3] >= all[3] * 0.2) ring else all
            if (c[3] == 0L) return floatArrayOf(0.05f, 0.13f, 0.27f)
            return FloatArray(3) { (c[it].toDouble() / c[3] / 255.0).toFloat() }
        }
    }
}
