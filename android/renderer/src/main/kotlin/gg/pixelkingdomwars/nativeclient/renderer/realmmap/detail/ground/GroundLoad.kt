package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Classes
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.DeedPx
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPlotRules
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RgbaImage
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.clamp
import gg.pixelkingdomwars.nativeclient.renderer.world.ExactPng
import kotlin.math.ceil
import kotlin.math.floor

/** Where GROUND reads a realm's pack (decode threads only): verified bytes of `realm/<id>/<key>`, the art decoder. */
interface GroundSource {
    /** The realm's full `realm.json` (verified against the content manifest). */
    fun realmJson(): JsonValue
    /** A detail file's verified bytes, or null when the pack does not ship it. */
    fun bytes(key: String): ByteArray?
    /** An art image (WebP) as straight RGBA; data PNGs go through [png]. */
    fun image(bytes: ByteArray, key: String): RgbaImage?
    /** A data PNG decoded exactly ([ExactPng]: the web's exact decoder, no premultiply), or null when absent / not exact. */
    fun png(key: String): RgbaImage? = bytes(key)?.let { b -> ExactPng.decode(b)?.let { RgbaImage(it.width, it.height, it.rgba) } }
}

/**
 * The production [GroundSource] over the engine's [gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen]: detail
 * files through the core's verified reader (`RealmLoader.detail`: the pack's own sha256 table and the content manifest),
 * WebP art through its decoder, and `realm.json` through [realmJson] (the host's verified read of `realm/<id>/realm.json`:
 * the core parses only the first-frame fields of it and keeps no raw copy).
 */
class OpenGroundSource(private val open: gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen, private val realmJson: (String) -> ByteArray) : GroundSource {
    override fun realmJson(): JsonValue = JsonReader().parse(String(realmJson(open.realmId), Charsets.UTF_8))
    override fun bytes(key: String): ByteArray? = if (open.meta.files.containsKey(key)) open.loader.detail(open.meta, key) else null
    override fun image(bytes: ByteArray, key: String): RgbaImage? = open.loader.image(bytes, key)
}

/** One texture's pixels per layer and level (level 0 first), ready for a fresh upload's fill (LIFE's `LaneUploads`). */
class LayerLevels(val width: Int, val height: Int, val layers: Int, val levels: Int, val bytesPerTexel: Int, private val data: Array<Array<ByteArray?>>) {
    fun level(layer: Int, level: Int): ByteArray? = data[layer][level]
    fun fill(layer: Int, level: Int, out: java.nio.ByteBuffer) { out.position(0); data[layer][level]?.let { out.put(it) }; out.position(0) }
}

/** ground.js `palette()`: the painting's own colours per class, the sea at its border (seaFar), the plot styles.
 *  [paintWater] (fix pass #6) is the painting's own river / lake colour, always — [water] is PACK's kit water in every pack. */
class GroundPalette(
    val byClass: Array<DoubleArray>, val count: IntArray, val shallow: DoubleArray, val sea: DoubleArray, val deep: DoubleArray, val foam: DoubleArray,
    val beach: DoubleArray, val water: DoubleArray, val bank: DoubleArray, val road: DoubleArray, val roadEdge: DoubleArray, val turf: DoubleArray,
    val wet: DoubleArray, val edge: Array<DoubleArray>, val seaFar: DoubleArray, val wall: Array<DoubleArray>, val paintWater: DoubleArray,
)

/** The P0 line-field texture (ground.js linesJob): pages of 99² packHalf2x16 words above 3 header words per deed. */
class LineTexture(val w: Int, val h: Int, val pr: Int, val r0: Int, val cap: Int, words: IntArray, val riverPage: IntArray, val landPage: IntArray, val free: IntArrayDeque) {
    val headerRows: Int get() = h - r0
    /** Upload-only: every word of the texture (6.3-18.7 MB on the real realms), empty once the lane queued its fill
     *  ([GroundAssets.dropUploads]); the page bookkeeping above stays. */
    var words: IntArray = words; private set
    internal fun dropWords() { words = IntArray(0) }
}

/** A small int stack (free page numbers), no boxing. */
class IntArrayDeque(capacity: Int) {
    private var a = IntArray(maxOf(1, capacity)); var size = 0; private set
    fun push(v: Int) { if (size == a.size) a = a.copyOf(a.size * 2); a[size++] = v }
    fun pop(): Int = if (size == 0) -1 else a[--size]
    fun copy(): IntArrayDeque = IntArrayDeque(a.size).also { c -> for (i in 0 until size) c.push(a[i]) }
}

/** ground.js mapAtlas(): the MAP kit (colour + mask arrays), its layout uniforms and the per-slot family grade. */
class MapAtlas(kit: LayerLevels, mask: LayerLevels, val wild: IntArray, val fam: IntArray, val field: IntArray, val wang: IntArray,
               val famK: DoubleArray, val procedural: Boolean) {
    /** Upload-only: the kit's colour and mask mips, null once the lane queued their fills ([GroundAssets.dropUploads]). */
    var kit: LayerLevels? = kit; private set
    var mask: LayerLevels? = mask; private set
    internal fun dropPixels() { kit = null; mask = null }
}

/** ground.js trueSetup(): the TRUE kit arrays (A: globals 0…255, B: 256…), masks 4 per layer, decals and their boxes; in a
 *  gem-sea realm (stage B) the sea loop's two gem colours [gemCol] and their ratio to its mean [gemK] (`T.gemCol`, `T.gemK`). */
class TrueAtlas(a: LayerLevels, b: LayerLevels?, mask: LayerLevels, decal: LayerLevels?, decalBox: ByteArray?, val decalCount: Int,
                val kitWater: DoubleArray?, val kitInland: DoubleArray?, val seaIsLava: Boolean,
                val gemCol: Array<DoubleArray>?, val gemK: Array<DoubleArray>?) {
    /** Does this realm bind array B / the decals? (Read by the lane's readiness and rehearsal after the pixels went.) */
    val hasB = b != null
    val hasDecal = decal != null
    /** Upload-only: the kit arrays, masks, decals and boxes, null once the lane queued their fills ([GroundAssets.dropUploads]). */
    var a: LayerLevels? = a; private set
    var b: LayerLevels? = b; private set
    var mask: LayerLevels? = mask; private set
    var decal: LayerLevels? = decal; private set
    var decalBox: ByteArray? = decalBox; private set
    internal fun dropPixels() { a = null; b = null; mask = null; decal = null; decalBox = null }
}

/**
 * Everything GROUND's load() builds off the GL thread (ground.js load, W1 G3 slicing replaced by a worker), in two parts.
 * RESIDENT (kept while the realm is): what [Classify.classAt] reads (cls, [fields] over [fieldsA]/[fieldsBC]'s own arrays,
 * [lines], [state], [cfg]), the uniform tables (meta, mapT, trueT, nz, palette, yard, the kits' layout and gem/kit-water
 * scalars) and the line texture's page bookkeeping. UPLOAD-ONLY (filled into fresh textures once, never read again on the
 * CPU): the line words, the MAP kit and mask mips, the TRUE arrays, masks, decals and boxes, tone and plot art. The lane
 * calls [dropUploads] as soon as it has queued their fills (each fill captured its own arrays), so a resident realm holds
 * no upload pixels on the Java heap (P0, the Seeker's 2026-09-26 OOM on its 256 MB heap: the lanes kept 58-76 MB of
 * upload-only arrays per resident realm).
 */
class GroundAssets(
    val id: String, val cols: Int, val rows: Int, val meta: JsonValue, val cfg: ClassCfg, val cls: Classify,
    val fieldsA: RgbaImage, val fieldsBC: RgbaImage, val fields: Fields, val lines: Lines, val state: BaseState,
    val mapT: GroundTables.MapTables?, val trueT: GroundTables.TrueTables?, val nz: IntArray,
    val lineTex: LineTexture, val palette: GroundPalette, val atlas: MapAtlas?, tone: RgbaImage?, plots: RgbaImage?,
    val yard: FloatArray, val yardT: FloatArray, val trueAtlas: TrueAtlas?, val far: FloatArray,
    val foreignSea: IntArray?, val tarns: ClassBake.TarnResult?, val errors: List<String>,
) {
    val mapReady: Boolean get() = mapT != null && atlas != null
    val trueReady: Boolean get() = trueT != null && trueAtlas != null
    /** Does this realm draw tone / plot art? (Kept after [dropUploads]: the MAP band waits for their textures.) */
    val hasTone = tone != null
    val hasPlots = plots != null
    /** Upload-only (see the class doc): null after [dropUploads]. */
    var tone: RgbaImage? = tone; private set
    var plots: RgbaImage? = plots; private set

    /** Drop every upload-only array (see the class doc). Call only once their fills are queued: a fill holds its own
     *  references until the uploader has copied them, so nothing is lost; afterwards only the resident part is reachable. */
    fun dropUploads() {
        lineTex.dropWords(); atlas?.dropPixels(); trueAtlas?.dropPixels()
        tone = null; plots = null
    }
}

/**
 * GROUND's load (ground.js `load(pack)` up to the GL uploads), on a decode thread: realm.json tables, the exact field
 * decodes with the foreign-sea cap and the tarn clip, the lines and their baked pages, the palette measured on the
 * painting, the MAP and TRUE kits with their mips, tone and plot art. Pure (no GL); throws [IllegalStateException] only
 * for a pack the MAP band cannot draw (fields missing), which the lane reports and keeps the realm at FAR.
 */
object GroundLoad {
    /** ground.js `PLOT_STYLE`: per-realm plot edge colours until PACK's `realm.json.plotStyle` lands. */
    private val PLOT_STYLE = mapOf(
        "crownlands" to listOf("#4f7a34", "#24401c", "#86ab55"), "frostveil" to listOf("#dfe9ee", "#6f8591", "#ffffff"),
        "sunscar" to listOf("#c29a5b", "#6e4f2a", "#e3c38a"), "cinderfall" to listOf("#3a3438", "#141015", "#6c5f63"), "stormcairn" to listOf("#8c8f86", "#4a4c47", "#b8bab0"),
    )
    /** ground.js `WALL_TIER`: wall5 tier colours for the MAP wall-tier line (decor.json replaces them when BASES ships it). */
    private val WALL_TIER = arrayOf(doubleArrayOf(0.45, 0.32, 0.2, 0.0), doubleArrayOf(0.87, 0.81, 0.66, 0.0), doubleArrayOf(0.87, 0.81, 0.66, 0.0),
        doubleArrayOf(0.87, 0.81, 0.66, 0.0), doubleArrayOf(0.88, 0.83, 0.7, 1.0))
    /** ground.js linesJob: the widest line-field texture (the page rows grow in height). */
    const val LINE_TEX_W = 4096

    fun hex(s: String): DoubleArray {
        val n = s.replace("#", "").toLong(16).toInt()
        return doubleArrayOf(((n shr 16) and 255) / 255.0, ((n shr 8) and 255) / 255.0, (n and 255) / 255.0)
    }

    /** Thrown by [load] at a stage boundary once `alive()` answers false: the lane that asked for it released the realm. */
    object Stale : RuntimeException("stale ground load", null, false, false)

    /**
     * [alive] is asked between stages (P0, 2026-09-26): once the lane released this realm (dispose, the next open) the
     * load stops at the next stage with [Stale] instead of decoding and baking the rest of a realm nobody will adopt.
     */
    fun load(src: GroundSource, plots: RealmPlotRules, deeds: ByteArray, cols: Int, rows: Int, maxTextureSize: Int = LINE_TEX_W,
             alive: () -> Boolean = { true }): GroundAssets {
        fun live() { if (!alive()) throw Stale }
        val meta = src.realmJson()
        live()
        val id = meta.getString("id")
        val errors = ArrayList<String>()
        val cfg = ClassCfg.from(meta.get("classes"))
        val cls = Classify(plots)
        val tiles = plots.tiles
        val far = RealmLoader.farDeeds(deeds, cols, rows, DeedPx.THIS_REALM)
        // fields (exact PNG) + GA2-04 foreign sea + fix-2 #3 tarn clip, unless PACK baked them (realm.json fields.fieldsA.baked,
        // else fieldsA.baked: [bakedPasses]; every pack bakes both from stage B)
        val a = src.png("fieldsA.png") ?: error("fieldsA.png is missing or not exact-decodable")
        live()
        val bc = src.png("fieldsBC.png") ?: error("fieldsBC.png is missing or not exact-decodable")
        live()
        val aImg = FieldImage(a.width, a.height, 4, a.rgba)
        val passes = fieldPasses(meta, aImg, far, cols, rows, tiles) {
            val key = meta.get("chart8")?.getString("file", null) ?: "chart8.webp"
            src.bytes(key)?.let { src.image(it, key) } ?: run { errors += "clipTarns: $key did not decode"; null }
        }
        val fs = passes.foreignSea; val tarns = passes.tarns
        live()
        val fields = Fields(aImg, FieldImage(bc.width, bc.height, 4, bc.rgba), tiles)
        val linesJson = src.bytes("lines.json")?.let { JsonReader().parse(String(it, Charsets.UTF_8)) }
        val lines = cls.prepareLines(linesJson, cols, rows, cfg)
        val state = BaseState(cols, rows, ByteArray(cols * rows * 4).also { d -> for (i in 0 until cols * rows) d[i * 4] = kindOf(deeds[i]) })
        state.rivers = lines.rivers
        state.bridges = FloatArray(cols * rows * 4)
        val lineTex = bakeLines(cls, lines, state, cfg, cols, rows, minOf(LINE_TEX_W, maxTextureSize))
        live()
        val mapT = GroundTables.mapTables(meta)
        val trueT = GroundTables.trueTables(meta)
        val pal = palette(src, meta, id, cls, fields, lines, state, cfg, deeds, cols, rows)
        live()
        val atlas = if (mapT != null) mapAtlas(src, meta, mapT, pal, errors) else null
        live()
        val tone = meta.get("tone")?.getString("file", null)?.let { k -> src.bytes(k)?.let { src.image(it, k) } }
        live()
        var plotsArt: RgbaImage? = null
        val yard = FloatArray(21 * 4); val yardT = FloatArray(21 * 4)
        val pm = meta.get("plots")
        if (pm != null && pm.getString("file", null) != null && (pm.get("yards")?.size ?: 0) > 0) {
            val k = pm.getString("file")
            plotsArt = src.bytes(k)?.let { src.image(it, k) }
            var y = pm.get("yards").child
            while (y != null) {
                val lv = y.getInt("level", 0)
                if (lv in 1..20) {
                    yard[lv * 4] = y.getFloat("x"); yard[lv * 4 + 1] = y.getFloat("y"); yard[lv * 4 + 2] = y.getFloat("w"); yard[lv * 4 + 3] = y.getFloat("h")
                    val t0 = y.get("tile0"); yardT[lv * 4] = t0.getFloat(0); yardT[lv * 4 + 1] = t0.getFloat(1); yardT[lv * 4 + 2] = y.getFloat("tiles"); yardT[lv * 4 + 3] = 1f
                }
                y = y.next
            }
        }
        live()
        val trueAtlas = if (trueT != null) try { trueAtlas(src, meta, id) } catch (e: RuntimeException) { errors += "TRUE data: ${e.message}"; null } else null
        return GroundAssets(id, cols, rows, meta, cfg, cls, a, bc, fields, lines, state,
            mapT, trueT, GroundTables.mapNoise(cfg), lineTex, pal, atlas, tone, plotsArt, yard, yardT, trueAtlas, far, fs, tarns, errors)
    }

    /**
     * The load passes PACK says it baked into fieldsA.png (W1 G3): ground.js load()'s
     * `new Set(meta.fields?.fieldsA?.baked ?? meta.fieldsA?.baked ?? [])` — stage B reads realm.json's `fields.fieldsA.baked`
     * FIRST and the top-level `fieldsA.baked` only when that key is absent or null (so `fields.fieldsA.baked: []` bakes
     * nothing). A list keeps its string entries; a string gives its characters (JS iterates it, so no pass name matches);
     * any other value is not iterable, where ground.js throws and the MAP band stays down — so does this.
     */
    fun bakedPasses(meta: JsonValue): Set<String> {
        fun nn(v: JsonValue?) = if (v == null || v.isNull) null else v
        val b = nn(nn(nn(meta.get("fields"))?.get("fieldsA"))?.get("baked")) ?: nn(nn(meta.get("fieldsA"))?.get("baked")) ?: return emptySet()
        return when {
            b.isArray -> buildSet { var c = b.child; while (c != null) { if (c.isString) add(c.asString()); c = c.next } }
            b.isString -> b.asString().map { it.toString() }.toSet()
            else -> error("realm.json fieldsA.baked is not iterable (${b.type()})")
        }
    }

    /** What ground.js load()'s field passes did: the foreign-sea stats (noised, zeroed, kept) and the tarn clip, each null
     *  when PACK baked that pass (the file's bytes are used as they are). */
    class FieldPasses(val foreignSea: IntArray?, val tarns: ClassBake.TarnResult?)

    /**
     * ground.js load()'s passes over fieldsA [a] (mutated): GA2-04's foreign-sea cap from the far field [far], then fix-2 #3's
     * tarn clip over [chart] (chart8, asked for only when it runs; null = it did not decode, the clip is skipped), each only
     * when [bakedPasses] does not list it. With both baked (every pack from stage B) the loaded bytes are the file's.
     */
    fun fieldPasses(meta: JsonValue, a: FieldImage, far: FloatArray, cols: Int, rows: Int, tiles: Int, chart: () -> RgbaImage?): FieldPasses {
        val baked = bakedPasses(meta)
        val fs = if ("foreignSea" !in baked) ClassBake.foreignSea(a, far, cols, rows, tiles) else null
        var tarns: ClassBake.TarnResult? = null
        if ("clipTarns" !in baked) chart()?.let { c -> tarns = ClassBake.clipTarns(a.fullData(), a.width, a.height, c.rgba, c.width, c.height, 4) }
        return FieldPasses(fs, tarns)
    }

    /** ground.js load(): the base-state kind per deed from the deeds mask (KIND.open / otherRealm / none). */
    fun kindOf(d: Byte): Byte = when (d.toInt() and 0xff) {
        DeedPx.THIS_REALM -> gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Kind.OPEN.toByte()
        DeedPx.OTHER_REALM -> gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Kind.OTHER_REALM.toByte()
        else -> gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Kind.NONE.toByte()
    }

    // ---------------------------------------------------------------- lines (ground.js linesJob / writeHeaders)

    /** The whole line texture of [state]'s rivers and [lines]' tracks: river pages, then land pages, then the headers. */
    fun bakeLines(cls: Classify, lines: Lines, state: BaseState, cfg: ClassCfg, cols: Int, rows: Int, w: Int): LineTexture {
        val pn = ClassBake.PAGE; val pr = w / pn
        val rivers = state.rivers ?: lines.rivers
        val riverPage = IntArray(cols * rows) { -1 }; val landPage = IntArray(cols * rows) { -1 }
        val rv = rivers.cells.keys.toIntArray()
        val ld = ArrayList<Int>(); for (k in 0 until cols * rows) if (lines.tracks.cells.containsKey(k)) ld += k
        val need = rv.size + ld.size; val cap = need + maxOf(16, ceil(need * 0.25).toInt())
        val r0 = ceil(cap.toDouble() / pr).toInt() * pn; val h = r0 + ceil(cols.toDouble() * rows * 3 / w).toInt()
        check(h <= LINE_TEX_W * 4) { "line fields need ${w}x$h" }
        val words = IntArray(w * h)
        val page = IntArray(ClassBake.PAGE_N)
        var next = 0
        for (k in rv) { riverPage[k] = next++; ClassBake.riverPageWords(rivers, k % cols, k / cols, cls.tiles, cfg, page); blit(words, w, pr, riverPage[k], page) }
        for (k in ld) { landPage[k] = next++; ClassBake.landPageWords(lines.tracks, k % cols, k / cols, cls.tiles, cfg, page); blit(words, w, pr, landPage[k], page) }
        val free = IntArrayDeque(cap - next); for (i in cap - 1 downTo next) free.push(i)
        val tex = LineTexture(w, h, pr, r0, cap, words, riverPage, landPage, free)
        writeHeaders(tex, rivers, state.bridges, cols, rows, null)
        return tex
    }

    fun blit(words: IntArray, w: Int, pr: Int, pg: Int, page: IntArray) {
        val pn = ClassBake.PAGE; val x0 = (pg % pr) * pn; val y0 = (pg / pr) * pn
        for (j in 0 until pn) System.arraycopy(page, j * pn, words, (y0 + j) * w + x0, pn)
    }

    /** ground.js writeHeaders: 3 words per deed (river page + 1 | downstream hint; land page + 1; the packed bridge). */
    fun writeHeaders(t: LineTexture, rivers: SegSet?, bridges: FloatArray?, cols: Int, rows: Int, keys: IntArray?) {
        val hint = DoubleArray(2); val base = t.r0 * t.w
        val n = keys?.size ?: (cols * rows)
        for (i in 0 until n) {
            val k = keys?.get(i) ?: i
            ClassBake.riverHint(rivers, k, hint)
            val hx = (GroundMath.jsRound(hint[0] * 127).toInt() + 128) and 255; val hy = (GroundMath.jsRound(hint[1] * 127).toInt() + 128) and 255
            t.words[base + k * 3] = if (t.riverPage[k] >= 0) (t.riverPage[k] + 1) or (hx shl 16) or (hy shl 24) else 0
            t.words[base + k * 3 + 1] = if (t.landPage[k] >= 0) t.landPage[k] + 1 else 0
            val o = k * 4
            t.words[base + k * 3 + 2] = if (bridges != null) ClassBake.packBridge(bridges[o].toDouble(), bridges[o + 1].toDouble(), bridges[o + 2].toDouble(), bridges[o + 3].toDouble()) else 0
        }
    }

    // ---------------------------------------------------------------- palette (ground.js palette)

    fun palette(src: GroundSource, meta: JsonValue, id: String, cls: Classify, fields: Fields, lines: Lines, state: BaseState, cfg: ClassCfg,
                deeds: ByteArray, cols: Int, rows: Int): GroundPalette {
        val pm = meta.get("palette")
        fun pal(k: String): DoubleArray? = pm?.get(k)?.takeIf { it.isString }?.let { hex(it.asString()) }
        val key = meta.get("chart8")?.getString("file", null) ?: "chart8.webp" // ground.js pack.first.chartKey
        val img = src.bytes(key)?.let { src.image(it, key) }
        val tiles = cls.tiles
        val sums = Array(14) { DoubleArray(4) }
        if (img != null) {
            val w = img.width; val h = img.height
            // the palette's own state ({ cols, rows, data: baseCpu, bridges }): no rivers kept, so classAt bends them (stage B's
            // ground.js hands it T.rivers to skip that bend, perf only: the load's state has no plot, so the bend moves nothing)
            val st = BaseState(state.cols, state.rows, state.data); st.bridges = state.bridges
            for (i in 0 until 9000) {
                val hh = GroundMath.kitHash(i, 0x5eed)
                val x = Integer.remainderUnsigned(hh, cols * tiles); val y = Integer.remainderUnsigned(GroundMath.kitHash(i, 0x7a11), rows * tiles)
                if ((deeds[(y / tiles) * cols + x / tiles].toInt() and 0xff) == DeedPx.NONE && (hh and 3) != 0) continue
                val c = cls.classAt(fields, if (i and 1 != 0) lines else null, st, x.toDouble(), y.toDouble(), cfg)
                val px = minOf(w - 1, floor(x.toDouble() / tiles * (w.toDouble() / cols)).toInt()); val py = minOf(h - 1, floor(y.toDouble() / tiles * (h.toDouble() / rows)).toInt())
                val o = (py * w + px) * 4
                val s = sums[c]; s[0] += img.rgba[o].toInt() and 0xff; s[1] += img.rgba[o + 1].toInt() and 0xff; s[2] += img.rgba[o + 2].toInt() and 0xff; s[3]++
            }
        }
        fun mean(c: Int, fb: DoubleArray): DoubleArray = if (sums[c][3] > 8) doubleArrayOf(sums[c][0] / sums[c][3] / 255, sums[c][1] / sums[c][3] / 255, sums[c][2] / sums[c][3] / 255) else fb
        val seaFar = if (img != null) RealmLoader.ringSea(img).let { doubleArrayOf(it[0].toDouble(), it[1].toDouble(), it[2].toDouble()) } else doubleArrayOf(0.05, 0.13, 0.27)
        val sea = pal("sea") ?: mean(Classes.SEA, doubleArrayOf(0.16, 0.4, 0.55))
        val deep = pal("deep") ?: mean(Classes.DEEP, DoubleArray(3) { sea[it] * 0.7 })
        val wild = mean(Classes.WILD, doubleArrayOf(0.7, 0.62, 0.45))
        val sh = doubleArrayOf(0.03, 0.06, 0.05); val tk = doubleArrayOf(0.96, 1.02, 0.92)
        val style = meta.get("plotStyle")
        val edgeList = style?.get("edge")?.takeIf { it.isArray }?.let { e -> List(e.size) { e.getString(it) } } ?: PLOT_STYLE[id] ?: PLOT_STYLE.getValue("crownlands")
        val wallMean = style?.get("wallTierMean")?.takeIf { it.isArray }
        var turf = pal("turf") ?: DoubleArray(3) { clamp(wild[it] * tk[it], 0.0, 1.0) }
        style?.getString("turf", null)?.let { turf = hex(it) }
        var road = pal("road") ?: doubleArrayOf(0.62, 0.52, 0.38)
        style?.get("track")?.getString("colour", null)?.let { road = hex(it) }
        return GroundPalette(
            byClass = Array(14) { mean(it, wild) }, count = IntArray(14) { sums[it][3].toInt() },
            shallow = pal("shallow") ?: DoubleArray(3) { minOf(1.0, sea[it] * 1.18 + sh[it]) }, sea = sea, deep = deep,
            foam = pal("foam") ?: doubleArrayOf(0.93, 0.97, 0.98), beach = pal("beach") ?: mean(Classes.SHORE, doubleArrayOf(0.86, 0.78, 0.58)),
            water = pal("water") ?: mean(Classes.WATER, sea), bank = DoubleArray(3) { wild[it] * 0.55 }, road = road, roadEdge = doubleArrayOf(0.36, 0.29, 0.2),
            turf = turf, wet = DoubleArray(3) { wild[it] * 0.82 }, edge = Array(edgeList.size) { hex(edgeList[it]) }, seaFar = seaFar,
            wall = if (wallMean != null) Array(wallMean.size) { i -> hex(wallMean.getString(i)).let { c -> doubleArrayOf(c[0], c[1], c[2], if (i == 4) 1.0 else 0.0) } } else WALL_TIER,
            paintWater = mean(Classes.WATER, sea),
        )
    }

    // ---------------------------------------------------------------- MAP kit (ground.js mapAtlas / familyGrade / proceduralAtlas)

    /** Box-filtered mip chain of one square RGBA cell (the WebGL generateMipmap stand-in; colour art only, never masks
     *  that PACK ships its own mips for). */
    fun boxMips(level0: ByteArray, size: Int, levels: Int): Array<ByteArray?> {
        val out = arrayOfNulls<ByteArray>(levels); out[0] = level0
        var cur = level0; var s = size
        for (l in 1 until levels) {
            val n = maxOf(1, s / 2); val next = ByteArray(n * n * 4)
            for (y in 0 until n) for (x in 0 until n) for (c in 0 until 4) {
                val x0 = minOf(s - 1, 2 * x); val x1 = minOf(s - 1, 2 * x + 1); val y0 = minOf(s - 1, 2 * y); val y1 = minOf(s - 1, 2 * y + 1)
                val sum = (cur[(y0 * s + x0) * 4 + c].toInt() and 0xff) + (cur[(y0 * s + x1) * 4 + c].toInt() and 0xff) + (cur[(y1 * s + x0) * 4 + c].toInt() and 0xff) + (cur[(y1 * s + x1) * 4 + c].toInt() and 0xff)
                next[(y * n + x) * 4 + c] = ((sum + 2) / 4).toByte()
            }
            out[l] = next; cur = next; s = n
        }
        return out
    }

    private fun crop(img: RgbaImage, x: Int, y: Int, w: Int, h: Int): ByteArray {
        val out = ByteArray(w * h * 4)
        for (j in 0 until h) {
            val sy = y + j; if (sy < 0 || sy >= img.height) continue
            val sx0 = maxOf(0, x); val sx1 = minOf(img.width, x + w); if (sx1 <= sx0) continue
            System.arraycopy(img.rgba, (sy * img.width + sx0) * 4, out, (j * w + (sx0 - x)) * 4, (sx1 - sx0) * 4)
        }
        return out
    }

    fun mapAtlas(src: GroundSource, meta: JsonValue, mapT: GroundTables.MapTables, pal: GroundPalette, errors: MutableList<String>): MapAtlas {
        val a = meta.get("map")?.get("atlas")
        val file = a?.getString("file", null)
        val maskKey = meta.get("map")?.get("mask")?.getString("file", null) ?: "mapmask.png"
        val img = file?.let { src.png(it) }; val mimg = src.png(maskKey)
        if (a == null || img == null || mimg == null) { if (file != null) errors += "map atlas: $file / $maskKey did not decode"; return procedural(mapT, pal) }
        val cell = a.getInt("cell", 32); val colsA = a.getInt("cols", img.width / cell)
        val n = a.get("layers")?.asInt() ?: (colsA * ((a.get("rows0")?.asInt() ?: img.height) / cell))
        val mips = a.get("mips")?.takeIf { it.isArray && it.size > 0 }
        val levels = 6
        val kit = Array(n) { i -> boxMips(crop(img, (i % colsA) * cell, (i / colsA) * cell, cell, cell), cell, levels) }
        val maskLevels = if (mips != null) mips.size + 1 else levels
        val mask = Array(n) { i ->
            val l0 = crop(mimg, (i % colsA) * cell, (i / colsA) * cell, cell, cell)
            if (mips == null) boxMips(l0, cell, levels) else Array<ByteArray?>(maskLevels) { k ->
                if (k == 0) l0 else { val m = mips.get(k - 1); val c = cell shr k; crop(mimg, (i % colsA) * c, m.getInt("y") + (i / colsA) * c, c, c) }
            }
        }
        val pu = a.get("pureUpper"); val fl = meta.get("plotStyle")?.get("fieldLayers")?.takeIf { it.isArray }
        val famJ = a.get("families")
        val wild = a.get("wild")?.let { intArrayOf(it.getInt(0), it.getInt(1)) } ?: intArrayOf(0, 4)
        val fam = IntArray(24)
        for (s in 1..5) { val f = famJ?.get("M$s"); if (f != null && f.isNumber) { val p = pu?.get("M$s"); fam[s * 4] = f.asInt(); fam[s * 4 + 1] = 1; fam[s * 4 + 2] = p?.getInt(0) ?: 0; fam[s * 4 + 3] = p?.getInt(1) ?: 0 } }
        val field = if (fl != null) intArrayOf(fl.getInt(0), fl.getInt(1)) else famJ?.get("M2")?.takeIf { it.isNumber }?.let { intArrayOf(it.asInt() + 15, 1) } ?: intArrayOf(0, 0)
        val wang = IntArray(24)
        for (s in 0..5) { val w = a.get("pureWang")?.get("M$s"); if (w != null && w.isArray && w.getInt(1) >= 16 && w.getInt(0) + 16 <= n) { wang[s * 4] = w.getInt(0); wang[s * 4 + 1] = 16 } }
        val famK = familyGrade(img, a, n, cell, colsA, mapT, pal, GroundTables.famClamp(meta))
        return MapAtlas(LayerLevels(cell, cell, n, levels, 4, kit), LayerLevels(cell, cell, n, maskLevels, 4, mask), wild, fam, field, wang, famK, false)
    }

    /** ground.js familyGrade (GA2-05): per slot, painting mean of its classes ÷ the map art's mean of its pure cells, per
     *  channel within [fc] (stage B: the realm's [GroundTables.famClamp], 0.6…2.4 for the three darker MAP arts). */
    fun familyGrade(img: RgbaImage, a: JsonValue, n: Int, cell: Int, colsA: Int, mapT: GroundTables.MapTables, pal: GroundPalette,
                    fc: DoubleArray): DoubleArray {
        val out = DoubleArray(18) { 1.0 }
        fun artMean(layers: IntArray): DoubleArray? {
            val s = DoubleArray(3); var k = 0
            for (l in layers) {
                if (l < 0 || l >= n) continue
                val ox = (l % colsA) * cell; val oy = (l / colsA) * cell
                for (y in 0 until cell) for (x in 0 until cell) {
                    val o = ((oy + y) * img.width + ox + x) * 4
                    if ((img.rgba[o + 3].toInt() and 0xff) < 128) continue
                    s[0] += img.rgba[o].toInt() and 0xff; s[1] += img.rgba[o + 1].toInt() and 0xff; s[2] += img.rgba[o + 2].toInt() and 0xff; k++
                }
            }
            return if (k > 0) DoubleArray(3) { s[it] / k / 255 } else null
        }
        fun range(j: JsonValue?, c: Int? = null): IntArray = if (j == null) IntArray(0) else IntArray(c ?: j.getInt(1)) { j.getInt(0) + it }
        for (sl in 0..5) {
            val layers = if (sl == 0) range(a.get("wild") ?: JsonReader().parse("[0,4]"))
                else if (a.get("pureUpper")?.get("M$sl") != null) range(a.get("pureUpper").get("M$sl"))
                else a.get("families")?.get("M$sl")?.takeIf { it.isNumber }?.let { intArrayOf(it.asInt() + 15) } ?: IntArray(0)
            val am = artMean(layers) ?: continue
            val pm = DoubleArray(3); var w = 0.0
            for (c in 0 until 14) if (mapT.terr[c] == sl && c != Classes.TURF && c != Classes.RING && c > Classes.WATER) {
                val k = pal.count[c]; if (k < 8) continue
                for (i in 0 until 3) pm[i] += pal.byClass[c][i] * k
                w += k
            }
            if (w > 0) for (i in 0 until 3) out[sl * 3 + i] = clamp(pm[i] / w / maxOf(am[i], 0.02), fc[0], fc[1])
        }
        return out
    }

    /** ground.js proceduralAtlas: a stand-in kit from the palette so the MAP band still draws its classes crisply. */
    fun procedural(mapT: GroundTables.MapTables?, pal: GroundPalette): MapAtlas {
        val s = 32; val fams = 5; val n = 4 + fams * 16
        fun slotColour(sl: Int): DoubleArray {
            if (mapT == null || sl == 0) return pal.byClass[Classes.WILD]
            val cs = (0 until 14).filter { mapT.terr[it] == sl }; if (cs.isEmpty()) return pal.byClass[Classes.WILD]
            return DoubleArray(3) { i -> cs.sumOf { pal.byClass[it][i] } / cs.size }
        }
        val kit = arrayOfNulls<Array<ByteArray?>>(n); val mask = arrayOfNulls<Array<ByteArray?>>(n)
        fun fillLayer(layer: Int, colour: DoubleArray, maskFn: ((Int, Int) -> Int)?, seed: Int, style: Int) {
            val px = ByteArray(s * s * 4); val mk = ByteArray(s * s * 4)
            for (y in 0 until s) for (x in 0 until s) {
                val o = (y * s + x) * 4; val up = maskFn?.invoke(x, y) ?: 1; val h = GroundMath.kitHash(x + seed * 64, y + seed * 131); val j = ((h and 255) / 255.0 - 0.5) * 0.1
                var k = 1 + j
                if (style == 1 && up != 0) k *= if ((GroundMath.kitHash((x shr 2) + seed, (y shr 2) - seed) and 3) == 0) 0.72 else if (((x + y) and 3) == 0) 0.85 else 1.0
                if (style == 2 && up != 0) k *= if (y % 4 == 0) 0.82 else 1.0
                val c = if (up != 0) colour else slotColour(0)
                px[o] = clamp(c[0] * k * 255, 0.0, 255.0).toInt().toByte(); px[o + 1] = clamp(c[1] * k * 255, 0.0, 255.0).toInt().toByte(); px[o + 2] = clamp(c[2] * k * 255, 0.0, 255.0).toInt().toByte(); px[o + 3] = 255.toByte()
                mk[o] = (if (up != 0) 255 else 0).toByte(); mk[o + 3] = 255.toByte()
            }
            kit[layer] = boxMips(px, s, 6); mask[layer] = boxMips(mk, s, 6)
        }
        for (v in 0 until 4) fillLayer(v, slotColour(0), null, v + 1, 0)
        for (sl in 1..fams) {
            val colour = slotColour(sl); val style = if (sl == 1) 1 else if (sl == 2) 2 else 0
            for (m in 0 until 16) {
                val c = intArrayOf((m shr 3) and 1, (m shr 2) and 1, (m shr 1) and 1, m and 1)
                fillLayer(4 + (sl - 1) * 16 + m, colour, { x, y -> val u = (x + 0.5) / s; val v = (y + 0.5) / s
                    val w = c[0] * (1 - u) * (1 - v) + c[1] * u * (1 - v) + c[2] * (1 - u) * v + c[3] * u * v
                    if (w + ((GroundMath.kitHash(x + m * 7, y + sl * 13) and 255) / 255.0 - 0.5) * 0.12 > 0.5) 1 else 0 }, sl * 16 + m, style)
            }
        }
        val fam = IntArray(24); for (sl in 1..5) { fam[sl * 4] = 4 + (sl - 1) * 16; fam[sl * 4 + 1] = 1 }
        @Suppress("UNCHECKED_CAST")
        return MapAtlas(LayerLevels(s, s, n, 6, 4, kit as Array<Array<ByteArray?>>), LayerLevels(s, s, n, 6, 4, mask as Array<Array<ByteArray?>>),
            intArrayOf(0, 4), fam, intArrayOf(4 + 16 + 15, 1), IntArray(24), DoubleArray(18) { 1.0 }, true)
    }

    // ---------------------------------------------------------------- TRUE kit (ground.js trueSetup)

    fun trueAtlas(src: GroundSource, meta: JsonValue, id: String): TrueAtlas? {
        val t = meta.get("true") ?: return null
        val a = t.get("atlas") ?: return null
        val off = if (a.get("reserved0")?.let { it.isBoolean && it.asBoolean() } == true) 0 else 1
        val gp = src.png(a.getString("file")) ?: error("${a.getString("file")} did not decode")
        val mp = src.png(t.get("mask")?.getString("file", null) ?: "groundmask.png") ?: error("groundmask did not decode")
        val dKey = t.get("decals")?.getString("file", null)
        val dp = dKey?.let { src.png(it) }
        val cell = a.getInt("cell", 32); val colsA = a.get("cols")?.asInt() ?: (gp.width / cell)
        val n = a.get("layers")?.asInt() ?: (colsA * (gp.height / cell)); val nn = n + off
        val aCount = minOf(256, nn)
        val la = Array(aCount) { arrayOfNulls<ByteArray>(6) }
        val lb = if (nn > 256) Array(nn - 256) { arrayOfNulls<ByteArray>(6) } else null
        val ml = (nn + 3) / 4; val md = ByteArray(ml * 32 * 32 * 4)
        for (i in 0 until n) {
            val ox = (i % colsA) * cell; val oy = (i / colsA) * cell; val g = i + off
            val mips = boxMips(crop(gp, ox, oy, cell, cell), cell, 6)
            if (g < 256) la[g] = mips else lb!![g - 256] = mips
            val layer = g shr 2; val ch = g and 3
            for (y in 0 until 32) for (x in 0 until 32) md[((layer * 32 + y) * 32 + x) * 4 + ch] = if ((mp.rgba[((oy + y) * mp.width + ox + x) * 4].toInt() and 0xff) > 127) 255.toByte() else 0
        }
        val blank = ByteArray(cell * cell * 4)
        for (i in la.indices) if (la[i][0] == null) la[i] = boxMips(blank, cell, 6)
        lb?.let { for (i in it.indices) if (it[i][0] == null) it[i] = boxMips(blank, cell, 6) }
        val masks = Array(ml) { l -> arrayOf<ByteArray?>(md.copyOfRange(l * 4096, (l + 1) * 4096)) }
        var decal: LayerLevels? = null; var box: ByteArray? = null; var dn = 0
        if (dp != null) {
            val dc = t.get("decals").get("cols")?.asInt() ?: (dp.width / 32); dn = t.get("decals").get("count")?.asInt() ?: dc
            box = ByteArray(maxOf(1, dn) * 4)
            val ds = Array(dn) { i ->
                val ox = (i % dc) * 32; val oy = (i / dc) * 32
                var x0 = 31; var y0 = 31; var x1 = 0; var y1 = 0
                for (y in 0 until 32) for (x in 0 until 32) if ((dp.rgba[((oy + y) * dp.width + ox + x) * 4 + 3].toInt() and 0xff) > 127) { x0 = minOf(x0, x); y0 = minOf(y0, y); x1 = maxOf(x1, x); y1 = maxOf(y1, y) }
                if (x1 >= x0) { box[i * 4] = x0.toByte(); box[i * 4 + 1] = y0.toByte(); box[i * 4 + 2] = x1.toByte(); box[i * 4 + 3] = y1.toByte() }
                else { box[i * 4] = 0; box[i * 4 + 1] = 0; box[i * 4 + 2] = 31; box[i * 4 + 3] = 31 }
                arrayOf<ByteArray?>(crop(dp, ox, oy, 32, 32))
            }
            decal = LayerLevels(32, 32, dn, 1, 4, ds)
        }
        // GA2-07: each water loop's mean colour (frame 0, opaque texels)
        fun meanOf(first: Int): DoubleArray? {
            val sm = DoubleArray(4); val ox = (first % colsA) * cell; val oy = (first / colsA) * cell
            for (y in 0 until cell) for (x in 0 until cell) {
                val o = ((oy + y) * gp.width + ox + x) * 4
                if (o < 0 || o + 3 >= gp.rgba.size || (gp.rgba[o + 3].toInt() and 0xff) < 128) continue
                sm[0] += gp.rgba[o].toInt() and 0xff; sm[1] += gp.rgba[o + 1].toInt() and 0xff; sm[2] += gp.rgba[o + 2].toInt() and 0xff; sm[3]++
            }
            return if (sm[3] > 64) doubleArrayOf(sm[0] / sm[3] / 255, sm[1] / sm[3] / 255, sm[2] / sm[3] / 255) else null
        }
        val tt = GroundTables.trueTables(meta)!!
        val kitWater = meanOf(tt.waterSeaFirstPack)
        // stage B: a gem-sea realm's two gem colours, measured on the sea loop's first cell, and their ratio to its mean (MAP
        // draws each gem as that ratio × the MAP water under it: TRUE's gem-to-water contrast at every depth)
        val gemCol = if (GroundTables.waterGems(meta) > 0) GroundTables.gemColours(gp.rgba, gp.width, (tt.waterSeaFirstPack % colsA) * cell, (tt.waterSeaFirstPack / colsA) * cell, cell) else null
        @Suppress("UNCHECKED_CAST")
        return TrueAtlas(LayerLevels(cell, cell, aCount, 6, 4, la as Array<Array<ByteArray?>>), lb?.let { LayerLevels(cell, cell, it.size, 6, 4, it as Array<Array<ByteArray?>>) },
            LayerLevels(32, 32, ml, 1, 4, masks), decal, box, dn, kitWater, meanOf(tt.waterInlandFirstPack), t.get("waterByClass") == null && id == "cinderfall",
            gemCol, GroundTables.gemK(gemCol, kitWater))
    }
}
