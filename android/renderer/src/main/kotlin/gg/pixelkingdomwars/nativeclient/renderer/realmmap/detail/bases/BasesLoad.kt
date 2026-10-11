package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePack
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeImage

/** One BASES sprite in the atlases (bases.js `catalog` entry): where its trimmed frames live, its anchor and scale, and
 *  its MAP mini-sprite and marker icon when it has them. */
class BasesCat(
    val key: String, val arr: Int, val layer0: Int, val frames: Int, val lw: Int, val lh: Int, val ox: Int, val oy: Int, val tw: Int, val th: Int,
    val anchorX: Double, val anchorY: Double, val scale: Double, val cellW: Int, val cellH: Int,
) {
    var mini: BasesMini? = null
    var icon: BasesIcon? = null
}
class BasesMini(val idx: Int, val ox: Int, val oy: Int, val w: Int, val h: Int, val k: Double, val ax: Double, val ay: Double)
class BasesIcon(val idx: Int, val ox: Int, val oy: Int, val w: Int, val h: Int, val ax: Double, val ay: Double)

/** A texture array being built: [lw]×[lh] layers, each with its mode-preserving mip chain ([layers][level]). */
class BasesArrayBuild(val lw: Int, val lh: Int, val levels: Int) { val layers = ArrayList<Array<ByteArray>>() }

/** Everything the GL thread adopts for a realm's BASES (built on a decode thread by [BasesLoad]). */
class BasesBuild(
    val realmId: String, val arrays: List<BasesArrayBuild>, val catalog: Map<String, BasesCat>, val mini: BasesArrayBuild, val icon: BasesArrayBuild,
    val road: BasesArrayBuild?, val soil: FloatArray?, val accent: FloatArray, val windX: Double, val missing: List<String>, val source: String,
    val cols: Int, val rows: Int,
)

/**
 * The CPU half of the web BASES lane's load (`bases.js` `gatherSources`, `buildAtlases`, `loadRoadTiles`), 1:1 minus the
 * dev-only raw masters: the shared keeps and decor atlases, the realm atlas (kit dressing, creatures, the plot-edge
 * autotile), PACK's MAP minis (`plots.webp`), then every sprite trimmed to its ink and packed into size-class arrays with
 * mode-preserving mips, the 16×16 mini and 72×72 icon arrays, and the realm kit's ROAD tiles for lanes and paths.
 * Anything missing is listed, never silently skipped.
 */
class BasesLoad(private val t: DecorTables, private val decor: Decor, private val game: DecorGame) {
    private val art = game.art.toDouble()

    private class Want(val cellW: Int, val cellH: Int, val frames: Int, val ax: Double, val ay: Double, val scale: Double, val noMini: Boolean)
    private class Got(val want: Want, val cellW: Int, val cellH: Int, val frames: List<ByteArray>, val ax: Double, val ay: Double) {
        var packMini: PackMini? = null
    }
    private class PackMini(val px: ByteArray, val w: Int, val h: Int, val ax: Double, val ay: Double, val per: Double)

    /**
     * BASES for [realmId] from its verified pack, or null without kit dressing. [live] is asked between the stages: once
     * it answers false (the lane moved on to another realm or was disposed) the rest is skipped and the answer is null,
     * so a stale load stops allocating (P0 memory, 2026-09-26: the Seeker's 256 MB heap). The decoded atlases live only
     * while their frames are cut ([gather]), not while the arrays and their mips are built.
     */
    fun build(pack: LanePack, realmId: String, live: () -> Boolean = { true }): BasesBuild? {
        if (t.dressing[realmId] == null) return null // bases.js: `no kit dressing for <realm>`: the lane stays off
        if (!live()) return null
        val meta = pack.realmJson(realmId)
        val missing = LinkedHashSet<String>()
        // ---- what the decor may draw (want), in the web's order
        val want = LinkedHashMap<String, Want>()
        for ((key, a) in t.gameArt) want[key] = Want(a[0], a[1], a[7], a[2].toDouble(), a[1].toDouble(), decor.scaleOf(key.substringBefore('/')), false)
        val pieces = listOf("post", "straight", "ns", "corner_ne", "corner_nw", "corner_se", "corner_sw", "cross", "end_e", "end_n", "end_s", "end_w", "tee_e", "tee_n", "tee_s", "tee_w")
        for (tier in 1..5) for (p in pieces) { val h = t.wallCellH[tier - 1]; want["wall5/t$tier/$p"] = Want(32, h, 1, 16.0, h.toDouble(), 1 / art, false) }
        want["fx/fire"] = Want(t.fireCell[0], t.fireCell[1], 3, 8.0, 24.0, 1 / art, true)
        val kitIds = LinkedHashSet<String>(); val smokeId = t.smokeIdOf(realmId) // stage B: Solana's chimneys breathe vapour_drift
        for ((_, v) in t.dressing.getValue(realmId)) { v.list?.let { kitIds.addAll(it) }; v.pieces?.let { kitIds.addAll(it.values) } }
        kitIds += smokeId
        for (id in kitIds) {
            val a = t.kitArt[realmId]?.get(id); val creature = id.startsWith("creature:")
            want["kit:$id"] = Want(a?.get(0) ?: 32, a?.get(1) ?: 32, if (a != null) (if (creature) 1 else a[8]) else 3, if (a != null) a[0] / 2.0 else 16.0, a?.get(1)?.toDouble() ?: 32.0, 1 / art, id == smokeId)
        }
        val gathered = gather(pack, realmId, meta, want, missing)
        val got = gathered.got; val source = gathered.source
        if (!live()) return null

        // ---- buildAtlases
        val arrays = ArrayList<BasesArrayBuild>(); val byClass = HashMap<String, ArrayList<Int>>()
        val catalog = LinkedHashMap<String, BasesCat>()
        class Small(val px: ByteArray, val w: Int, val box: IntArray)
        val minis = ArrayList<Small>(); val icons = ArrayList<Small>()
        for ((key, e) in got) {
            val w = e.cellW; val h = e.cellH; val box = BasesPixels.inkBox(e.frames, w, h)
            if (box == null) { missing += "$key (empty)"; continue }
            val x0 = Math.max(0, box[0] - 1); val y0 = Math.max(0, box[1] - 1); val x1 = Math.min(w, box[2] + 1); val y1 = Math.min(h, box[3] + 1); val tw = x1 - x0; val th = y1 - y0
            val cls = t.sizeClasses.firstOrNull { tw <= it[0] && th <= it[1] }
            if (cls == null) { missing += "$key (${tw}×$th too large)"; continue }
            val list = byClass.getOrPut("${cls[0]}x${cls[1]}") { ArrayList() }
            var ai = list.firstOrNull { arrays[it].layers.size + e.frames.size <= t.maxLayers } ?: -1
            if (ai < 0) { ai = arrays.size; arrays += BasesArrayBuild(cls[0], cls[1], BasesPixels.mipsOf(cls[0], cls[1])); list += ai }
            val a = arrays[ai]; val layer0 = a.layers.size
            for (px in e.frames) {
                val tpx = ByteArray(a.lw * a.lh * 4)
                for (y in 0 until th) System.arraycopy(px, ((y0 + y) * w + x0) * 4, tpx, y * a.lw * 4, tw * 4)
                a.layers += BasesPixels.mipChain(tpx, a.lw, a.lh, a.levels).map { it.px }.toTypedArray()
            }
            val ent = BasesCat(key, ai, layer0, e.frames.size, a.lw, a.lh, x0, y0, tw, th, e.ax, e.ay, e.want.scale, w, h)
            catalog[key] = ent
            if (!e.want.noMini && !key.startsWith("keep/")) {
                val r: BasesPixels.Img; val ax: Double; val ay: Double; val k: Double
                val pm = e.packMini
                if (pm != null) { r = BasesPixels.Img(pm.px, pm.w, pm.h); ax = pm.ax; ay = pm.ay; k = e.want.scale / pm.per }
                else {
                    val f = 1 / (e.want.scale * t.mapPxPerTile)
                    r = BasesPixels.reduceMode(e.frames[0], w, h, f, darkW = 0.35); ax = e.ax / f; ay = e.ay / f; k = e.want.scale * f
                }
                val mb = BasesPixels.inkBox(listOf(r.px), r.w, r.h)
                if (mb != null && mb[2] - mb[0] <= t.mini && mb[3] - mb[1] <= t.mini) { ent.mini = BasesMini(minis.size, mb[0], mb[1], mb[2] - mb[0], mb[3] - mb[1], k, ax, ay); minis += Small(r.px, r.w, mb) }
                else missing += "$key (mini)"
            }
            if (key.startsWith("keep/")) {
                val r = BasesPixels.reduceMode(e.frames[0], w, h, 2.0); val ib = BasesPixels.inkBox(listOf(r.px), r.w, r.h)
                if (ib != null) { ent.icon = BasesIcon(icons.size, ib[0], ib[1], ib[2] - ib[0], ib[3] - ib[1], e.ax / 2, e.ay / 2); icons += Small(r.px, r.w, ib) }
            }
        }
        fun packSmall(list: List<Small>, s: Int): BasesArrayBuild {
            val out = BasesArrayBuild(s, s, BasesPixels.mipsOf(s, s))
            for (m in list) {
                val tpx = ByteArray(s * s * 4); val x0 = m.box[0]; val y0 = m.box[1]; val x1 = m.box[2]; val y1 = m.box[3]
                for (y in 0 until y1 - y0) System.arraycopy(m.px, ((y0 + y) * m.w + x0) * 4, tpx, y * s * 4, (x1 - x0) * 4)
                out.layers += BasesPixels.mipChain(tpx, s, s, out.levels).map { it.px }.toTypedArray()
            }
            if (out.layers.isEmpty()) out.layers += BasesPixels.mipChain(ByteArray(s * s * 4), s, s, out.levels).map { it.px }.toTypedArray() // max(1, n) layers
            return out
        }
        if (!live()) return null
        val mini = packSmall(minis, t.mini); val icon = packSmall(icons, ICON_SIZE)
        // ---- the realm kit's ROAD tiles (lanes and paths at TRUE; their mips are MAP's mean). Stage B: a realm whose kit
        //      joins its yards with a worn track of another terrain paints them with it (DECOR_LAYOUT.track: Solana's crystaldust)
        var road: BasesArrayBuild? = null
        val tr = meta.get("true")
        try {
            val roadId = t.layout.track[realmId] ?: tr?.get("classToTerrain")?.getString("ROAD", null)
            var terr = tr?.get("terrains")?.child; var layers: IntArray? = null
            while (terr != null) { if (terr.getString("id", null) == roadId) { layers = terr.get("pureLayers")?.asIntArray(); break }; terr = terr.next }
            val file = tr?.get("atlas")?.getString("file", null)
            if (layers == null || layers.isEmpty() || file == null) missing += "road tiles (no ${roadId ?: "undefined"} terrain pure layers)"
            else {
                val img = pack.pixels(pack.realmFile(meta, realmId, file) ?: error("realm $realmId: $file missing"), file)
                val cell = tr.get("atlas").getInt("cell", 32); val ac = tr.get("atlas").getInt("cols", img.width / cell)
                val lv = BasesPixels.mipsOf(cell, cell)
                road = BasesArrayBuild(cell, cell, lv)
                for (li in layers) road.layers += BasesPixels.mipChain(BasesPixels.crop(img.data, img.width, img.height, (li % ac) * cell, (li / ac) * cell, cell, cell), cell, cell, lv).map { it.px }.toTypedArray()
            }
        } catch (e: RuntimeException) { missing += "road tiles: ${e.message}"; road = null }
        // ---- palette, accent, wind (bases.js load())
        // the path colour: the track terrain's kit swatch (stage B), else the realm's road, else the table's path soil
        val soilHex = t.layout.soil[realmId]; val palette = meta.get("palette"); val track = t.layout.track[realmId]
        val trackHex = if (track != null) palette?.get("kit")?.get("ground")?.getString(track, null) else null
        val soil = soilHex?.let { s -> val pathHex = trackHex ?: palette?.getString("road", null) ?: s[2]; floatArrayOf(*hex(s[0]), *hex(s[1]), *hex(pathHex)) }
        val accent = t.accent[realmId]?.let { hex(it) } ?: floatArrayOf(0.5f, 0.89f, 1.0f) // bases.js: the default accent
        val w = meta.get("wind")?.get("artPxPerSec")
        val windX = if (w != null && w.isArray) JsMath.clamp(w.getDouble(0) / 16, -0.3, 0.3) else 0.12 // bases.js: tiles of drift per 2 s rise
        val grid = meta.get("grid")
        return BasesBuild(realmId, arrays, catalog, mini, icon, road, soil, accent, windX, missing.toList(), source, grid.getInt("cols"), grid.getInt("rows"))
    }

    /** What [gather] cut from the pack's atlases (bases.js `gatherSources`): the frames, and whether any atlas was read. */
    private class Gathered(val got: LinkedHashMap<String, Got>, val source: String)

    /** bases.js `gatherSources`: every wanted sprite's frames cut from the PACK atlases (keeps, decor, the realm's sprites,
     *  creatures and edge autotile) and PACK's MAP minis. The decoded atlases die with this call's frame. */
    private fun gather(pack: LanePack, realmId: String, meta: JsonValue, want: LinkedHashMap<String, Want>, missing: LinkedHashSet<String>): Gathered {
        // ---- PACK atlases
        val got = LinkedHashMap<String, Got>(); var packed = false
        /** bases.js `takeStrip` (+ `frameW`): [stripW] is the strip's width (keeps.json gives the frame width). */
        fun takeStrip(key: String, img: LifeImage, r: JsonValue, stripW: Int) {
            val e = want[key] ?: return
            val n = Math.max(1, r.getInt("frames", 1)); val fw = if (n > 1 && r.get("ink") != null && stripW.toDouble() / n >= r.get("ink").getInt(2)) stripW / n else stripW
            val h = r.getInt("h"); val fr = ArrayList<ByteArray>()
            for (f in 0 until n) fr += BasesPixels.crop(img.data, img.width, img.height, r.getInt("x") + f * fw, r.getInt("y"), fw, h)
            val anchor = r.get("anchor")
            got[key] = Got(e, fw, h, fr, anchor?.getDouble(0) ?: r.getDouble("ax", fw / 2.0), anchor?.getDouble(1) ?: r.getDouble("ay", h.toDouble()))
        }
        try {
            pack.sharedJson("keeps.json")?.let { m ->
                val file = m.getString("atlas", "keeps.png"); val img = pack.pixels(pack.shared(file) ?: error("shared $file missing"), file)
                var l = m.get("levels")?.child
                while (l != null) { takeStrip("keep/l${l.getInt("level")}", img, l, l.getInt("w") * l.getInt("frames", 1)); l = l.next }
                packed = true
            }
        } catch (e: RuntimeException) { missing += "keeps atlas: ${e.message}" }
        try {
            pack.sharedJson("decor.json")?.let { m ->
                val file = m.getString("atlas", "decor.png"); val img = pack.pixels(pack.shared(file) ?: error("shared $file missing"), file)
                var s = m.get("sprites")?.child
                while (s != null) { takeStrip(s.name, img, s, s.getInt("w")); s = s.next }
                packed = true
            }
        } catch (e: RuntimeException) { missing += "decor atlas: ${e.message}" }
        val images = HashMap<String, LifeImage>()
        fun realmImage(key: String): LifeImage = images.getOrPut(key) { pack.pixels(pack.realmFile(meta, realmId, key) ?: error("realm $realmId: $key missing"), key) }
        val sAtlas = meta.get("sprites")?.getString("atlas", null)
        if (sAtlas != null && meta.get("sprites").get("rects") != null) try {
            val img = realmImage(sAtlas)
            var r = meta.get("sprites").get("rects").child
            while (r != null) {
                val key = "kit:${r.name.replace('-', '_')}"; val e = want[key]
                if (e != null) {
                    val n = Math.max(1, r.getInt("frames", 1)); val w = r.getInt("w"); val h = r.getInt("h"); val dx = r.getInt("dx", w); val fr = ArrayList<ByteArray>()
                    for (f in 0 until n) fr += BasesPixels.crop(img.data, img.width, img.height, r.getInt("x") + f * dx, r.getInt("y"), w, h)
                    got[key] = Got(e, w, h, fr, r.getDouble("ax", w / 2.0), r.getDouble("ay", h.toDouble()))
                }
                r = r.next
            }
            packed = true
        } catch (e: RuntimeException) { missing += "realm sprite atlas: ${e.message}" }
        val cAtlas = meta.get("creatures")?.getString("atlas", null)
        if (cAtlas != null && meta.get("creatures").get("list") != null) try {
            val img = realmImage(cAtlas)
            var cr = meta.get("creatures").get("list").child
            while (cr != null) {
                val key = "kit:creature:${cr.getString("id").replace('-', '_')}"; val e = want[key]
                if (e != null) {
                    val fw = cr.getInt("fw", 64); val fh = cr.getInt("fh", 64)
                    got[key] = Got(e, fw, fh, listOf(BasesPixels.crop(img.data, img.width, img.height, cr.getInt("x"), cr.getInt("y"), fw, fh)), cr.getDouble("ax", fw / 2.0), cr.getDouble("ay", fh.toDouble()))
                }
                cr = cr.next
            }
        } catch (e: RuntimeException) { missing += "realm creature atlas: ${e.message}" }
        for (k in want.keys) if (!got.containsKey(k)) missing += k
        // ART's plot-edge autotile (realm.json edges.pieces)
        val edges = meta.get("edges")?.get("pieces")
        if (edges != null) try {
            val file = meta.get("edges").getString("atlas", sAtlas) ?: error("edge atlas unnamed")
            val img = realmImage(file)
            for (name in t.edgeArms) {
                val r = edges.get(name)
                if (r == null) { missing += "edge:$name"; continue }
                val w = r.getInt("w"); val h = r.getInt("h")
                got["edge:$name"] = Got(Want(w, h, 1, w / 2.0, h.toDouble(), 1 / art, false), w, h, listOf(BasesPixels.crop(img.data, img.width, img.height, r.getInt("x"), r.getInt("y"), w, h)), w / 2.0, h.toDouble())
            }
        } catch (e: RuntimeException) { missing += "edge autotile: ${e.message}" }
        // MAP minis: PACK's plots.webp (anchor in mini px) when present, else the runtime reducer
        val plots = meta.get("plots")
        if (plots?.get("minis") != null && plots.getString("file", null) != null) try {
            val file = plots.getString("file"); val img = realmImage(file)
            var m = plots.get("minis").child
            while (m != null) {
                got[m.name]?.packMini = PackMini(BasesPixels.crop(img.data, img.width, img.height, m.getInt("x"), m.getInt("y"), m.getInt("w"), m.getInt("h")), m.getInt("w"), m.getInt("h"),
                    m.get("anchor").getDouble(0), m.get("anchor").getDouble(1), m.getDouble("scale"))
                m = m.next
            }
        } catch (e: RuntimeException) { missing += "plots.webp: ${e.message}" }
        return Gathered(got, if (packed) "pack" else "none")
    }

    private fun hex(h: String): FloatArray = floatArrayOf(Integer.parseInt(h.substring(1, 3), 16) / 255f, Integer.parseInt(h.substring(3, 5), 16) / 255f, Integer.parseInt(h.substring(5, 7), 16) / 255f)

    companion object {
        /** bases.js: the marker icons are packed into 72×72 layers (half the 144-px keep cell). */
        const val ICON_SIZE = 72
    }
}
