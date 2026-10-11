package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import com.badlogic.gdx.utils.JsonValue

/** One sprite texture array being built (life.js `arrays[]` entry): frames at the layer size, then their mip chains. */
class LifeArrayBuild(val key: String, val lw: Int, val lh: Int) {
    val frames = ArrayList<ByteArray>()
    /** life.js: `floor(log2(max(LW, LH))) + 1`, the 2× chain down to 1×1. */
    val levels: Int get() = 32 - Integer.numberOfLeadingZeros(Math.max(lw, lh))
    /** [layer][level] RGBA8 pixels (level 0 bled, each next a reduce2 of the previous), filled by [LifeLoad.mips];
     *  emptied by [LifeLane] once the texture's fill holds them (upload-only: the fill is their last reader). */
    var mips: Array<Array<ByteArray>> = emptyArray()
}

/** Everything the GL thread needs to adopt a realm's LIFE (built on a decode thread by [LifeLoad]). */
class LifeBuild(
    val realmId: String, val life: CLife, val arrays: List<LifeArrayBuild>, val airArray: Int,
    /** The species/density table, RGBA16UI texels, [tableW] × [tableRows], u16 per channel. */
    val table: ShortArray, val tableW: Int, val tableRows: Int,
    val missing: List<String>, val darkTwins: List<String>,
)

/**
 * The CPU half of the web LIFE lane's load (`life.js` `readSprites`, `composeStands`, `uploadArrays`' pixel work,
 * `buildTable`, `submitCounts`), 1:1, on a decode thread: sprite frames into size-class layers with binary alpha, the
 * map twins (a pack twin far darker than its kit sprite at 1/7 is replaced by LIFE's own reduction), map objects, the
 * shared fx pack, the compiled tables, the stand clumps, the mode-preserving mips and the RGBA16UI species table.
 */
class LifeLoad(private val tables: LifeTablesFile, private val sc: Scatter) {
    private val c = tables.constants
    private fun norm(id: String) = id.replace('-', '_')

    class Result(val build: LifeBuild?, val why: String)

    companion object {
        /** [build]'s answer when [build]'s `live` said the load is no longer wanted. */
        const val STALE = "stale: the lane moved on"
    }

    /**
     * Build LIFE for [realmId] from its verified pack ([pack]); null build with the reason when the pack has no LIFE.
     * [live] is asked between the stages: once it answers false (the lane moved on to another realm or was disposed) the
     * rest is skipped, so a stale load stops allocating (P0 memory, 2026-09-26: the Seeker's 256 MB heap). The result
     * holds no decoded image: every sprite's source atlas and map reduction are dropped once the arrays are cut.
     */
    fun build(pack: LanePack, realmId: String, live: () -> Boolean = { true }): Result {
        val cut = cut(pack, realmId, live) // its decoded atlases and realm.json die with its frame, before the mips
        val life = cut.life ?: return Result(null, cut.why)
        val arrays = cut.arrays
        if (!live()) return Result(null, STALE)
        for (a in arrays) { mips(a); if (!live()) return Result(null, STALE) }
        val airArray = arrays.indexOfFirst { it.key == "air0" }
        val t = buildTable(life, cut.sprites)
        submitCounts(life, arrays, airArray)
        return Result(LifeBuild(realmId, life, arrays, airArray, t.first, c.maxSpecies * c.spt, t.second, cut.missing, cut.darkTwins), "ok")
    }

    /** What [cut] leaves for the mips and the table: no decoded image (null [life]: nothing to build, [why]). */
    private class Cut(val life: CLife?, val why: String, val arrays: List<LifeArrayBuild> = emptyList(), val sprites: Map<String, LifeSprite> = emptyMap(),
                      val missing: List<String> = emptyList(), val darkTwins: List<String> = emptyList())

    /** The pack's frames cut into size-class layers (life.js `readSprites`, `composeStands`), the tables compiled. */
    private fun cut(pack: LanePack, realmId: String, live: () -> Boolean): Cut {
        if (!live()) return Cut(null, STALE)
        val meta = pack.realmJson(realmId)
        val base = meta.get("life")?.let { LifeTablesFile.table(it) } ?: tables.tables[realmId] ?: return Cut(null, "no LIFE table for $realmId")
        val landmarks = ArrayList<String>(); var r = meta.get("sprites")?.get("rects")?.child
        while (r != null) { if (r.getString("kind", null) == "landmark") landmarks += r.name; r = r.next }
        val objects = ArrayList<Pair<String, String?>>(); var o = meta.get("map")?.get("objects")?.child
        while (o != null) { objects += o.name to o.getString("role", null); o = o.next }
        val table0 = sc.lifeTable(base, landmarks, objects)!!
        val arrays = ArrayList<LifeArrayBuild>(); val missing = ArrayList<String>(); val darkTwins = ArrayList<String>()
        val air = HashSet<String>()
        table0.birds?.species?.forEach { air += norm(it.id) }
        for (a in table0.ambience) air += norm(a.id)
        for (g in table0.groups) for (s in g.species) s.emit?.let { air += norm(it.fx) }

        val placer = Placer(arrays)
        fun place(key: String, fw: Int, fh: Int, count: Int, classes: Array<IntArray> = c.sizeClasses): Slot? = placer.place(key, fw, fh, count, classes)
        val sprites = HashMap<String, LifeSprite>(); val creatures = HashMap<String, LifeSheet>()
        val images = HashMap<String, LifeImage>()
        fun realmImage(key: String): LifeImage = images.getOrPut(key) { pack.pixels(pack.realmFile(meta, realmId, key) ?: throw IllegalStateException("realm $realmId: $key is missing"), key) }

        // ---- the realm's sprites (realm.json sprites.rects)
        val sAtlas = meta.get("sprites")?.getString("atlas", null)
        if (sAtlas != null) {
            val img = realmImage(sAtlas)
            var e = meta.get("sprites").get("rects")?.child
            while (e != null) {
                val id = norm(e.name); val w = e.getInt("w"); val h = e.getInt("h"); val n = Math.max(1, e.getInt("frames", 1)); val dx = e.getInt("dx", w)
                val slot = place(if (air.contains(id)) "air" else "spr", w, h, n)
                if (slot == null) { missing += "$id (${w}×$h too large)"; e = e.next; continue }
                var top = 1_000_000_000; var bot = -1; var wide = 0
                val fr = e.get("frameRects")
                for (f in 0 until n) {
                    val fx = fr?.get(f)?.getInt("x") ?: (e.getInt("x") + f * dx); val fy = fr?.get(f)?.getInt("y") ?: e.getInt("y")
                    val px = LifePixels.copyFrame(img, fx, fy, w, h, slot.lw, slot.lh, slot.ox, slot.oy)
                    LifePixels.inkRows(px, slot.lw, slot.lh)?.let { ink -> top = Math.min(top, ink[0]); bot = Math.max(bot, ink[1]); wide = Math.max(wide, ink[3] - ink[2] + 1) }
                    arrays[slot.arr].frames += px
                }
                val inkH = if (bot >= 0) bot - top + 1 else 0
                val f0x = fr?.get(0)?.getInt("x") ?: e.getInt("x"); val f0y = fr?.get(0)?.getInt("y") ?: e.getInt("y")
                val ax = e.getDouble("ax", w / 2.0); val ay = e.getDouble("ay", h.toDouble())
                val sp = LifeSprite(if (air.contains(id)) Math.max(inkH, wide) else inkH, w, h, ax, ay, n, e.getInt("frameMs", e.getInt("ms", 120)))
                sp.arr = slot.arr; sp.layer0 = slot.layer0; sp.lw = slot.lw; sp.lh = slot.lh; sp.lax = ax + slot.ox; sp.lay = ay + slot.oy
                sp.src = LifeFrameSource(img, f0x, f0y, w, h, ax, ay)
                sprites[id] = sp
                e = e.next
            }
        }
        if (!live()) return Cut(null, STALE)
        // ---- creatures (realm.json creatures.list)
        val cAtlas = meta.get("creatures")?.getString("atlas", null)
        if (cAtlas != null) {
            val img = realmImage(cAtlas)
            var e = meta.get("creatures").get("list")?.child
            while (e != null) {
                val id = norm(e.getString("id")); val fw = e.getInt("fw", 64); val fh = e.getInt("fh", 64); val dirs = e.getInt("directions", 4); val frs = e.getInt("frames", 6); val n = dirs * frs
                val slot = place("cre", fw, fh, n)
                if (slot == null) { missing += "$id (creature sheet too large)"; e = e.next; continue }
                var top = 1_000_000_000; var bot = -1
                for (f in 0 until n) {
                    val px = LifePixels.copyFrame(img, e.getInt("x") + f * fw, e.getInt("y"), fw, fh, slot.lw, slot.lh, slot.ox, slot.oy)
                    LifePixels.inkRows(px, slot.lw, slot.lh)?.let { ink -> top = Math.min(top, ink[0]); bot = Math.max(bot, ink[1]) }
                    arrays[slot.arr].frames += px
                }
                val sh = LifeSheet(if (bot >= 0) bot - top + 1 else 0, frs, e.getInt("frameMs", 120), e.getDouble("speed", 20.0), e.getInt("dwellMs", 1500), dirs, e.getString("kind", "ground") == "water")
                sh.arr = slot.arr; sh.layer0 = slot.layer0; sh.lw = slot.lw; sh.lh = slot.lh
                sh.lax = e.getDouble("ax", fw / 2.0) + slot.ox; sh.lay = e.getDouble("ay", fh.toDouble()) + slot.oy
                creatures[id] = sh
                e = e.next
            }
        }
        if (!live()) return Cut(null, STALE)
        // ---- PACK's map-scale twins (mapkit.png): drawn at MAP in place of minified kit art
        val mapFile = meta.get("map")?.get("atlas")?.getString("file", null)
        val twins = meta.get("map")?.get("twins")
        if (twins != null && mapFile != null) {
            val img = realmImage(mapFile)
            var e = twins.child
            while (e != null) {
                val id = norm(e.name); val sp = sprites[id]
                if (sp == null) { e = e.next; continue }
                var rx = e.getInt("x"); var ry = e.getInt("y"); var rw = e.getInt("w"); var rh = e.getInt("h")
                var rax = if (e.has("ax")) e.getDouble("ax") else rw / 2.0; var ray = if (e.has("ay")) e.getDouble("ay") else rh.toDouble()
                var from = img
                val mine = sp.src?.let { LifePixels.reduceMap(it) }
                if (mine != null && LifePixels.meanLuma(img, rx, ry, rw, rh) < 0.7 * LifePixels.meanLuma(mine.img, 0, 0, mine.w, mine.h)) {
                    rx = 0; ry = 0; rw = mine.w; rh = mine.h; rax = mine.ax; ray = mine.ay; from = mine.img; darkTwins += id
                }
                val slot = place("tw", rw, rh, 1, c.twinClasses)
                if (slot == null) { missing += "$id twin (${rw}×$rh too large)"; e = e.next; continue }
                arrays[slot.arr].frames += LifePixels.copyFrame(from, rx, ry, rw, rh, slot.lw, slot.lh, slot.ox, slot.oy)
                sp.twin = LifeTwin(slot.arr, slot.layer0, slot.lw, slot.lh, JsMath.round(rax + slot.ox).toInt(), JsMath.round(ray + slot.oy).toInt())
                e = e.next
            }
        }
        // ---- map objects (peaks, hills, crags, realm specials): map-scale art only
        val objs = meta.get("map")?.get("objects")
        if (objs != null && mapFile != null) {
            val img = realmImage(mapFile)
            var e = objs.child
            while (e != null) {
                val id = norm(e.name); val rw = e.getInt("w"); val rh = e.getInt("h")
                val slot = place("tw", rw, rh, 1, c.twinClasses)
                if (slot == null) { missing += "$id map object (${rw}×$rh too large)"; e = e.next; continue }
                val px = LifePixels.copyFrame(img, e.getInt("x"), e.getInt("y"), rw, rh, slot.lw, slot.lh, slot.ox, slot.oy); val ink = LifePixels.inkRows(px, slot.lw, slot.lh)
                arrays[slot.arr].frames += px
                val rax = if (e.has("ax")) e.getDouble("ax") else rw / 2.0; val ray = if (e.has("ay")) e.getDouble("ay") else rh.toDouble()
                val sp = LifeSprite((if (ink != null) ink[1] - ink[0] + 1 else rh) * 7, rw * 7, rh * 7, 0.0, 0.0, 1, 1000)
                sp.arr = c.noArray
                // stage B: the twin keeps its frame offset in the layer (the lens glow's anchor is in the map canvas)
                sp.twin = LifeTwin(slot.arr, slot.layer0, slot.lw, slot.lh, JsMath.round(rax + slot.ox).toInt(), JsMath.round(ray + slot.oy).toInt(), slot.ox, slot.oy)
                sprites[id] = sp
                e = e.next
            }
        }
        if (!live()) return Cut(null, STALE)
        // ---- the shared ambient fx pack (realm/shared/fx.png + fx.json)
        val fx = try { pack.sharedJson("fx.json") } catch (ex: RuntimeException) { null }
        val fxAtlas = fx?.getString("atlas", null)
        if (fx != null && fxAtlas != null) {
            val img = pack.pixels(pack.shared(fxAtlas) ?: throw IllegalStateException("shared $fxAtlas is missing"), fxAtlas)
            var e = (fx.get("sprites") ?: fx.get("rects"))?.child
            while (e != null) {
                val id = norm(e.name); val w = e.getInt("w"); val h = e.getInt("h"); val n = Math.max(1, e.getInt("frames", 1))
                val slot = place("air", w, h, n)
                if (slot == null) { missing += "$id (shared fx ${w}×$h too large)"; e = e.next; continue }
                var top = 1_000_000_000; var bot = -1; var wide = 0
                for (f in 0 until n) {
                    val px = LifePixels.copyFrame(img, e.getInt("x") + f * e.getInt("dx", w), e.getInt("y"), w, h, slot.lw, slot.lh, slot.ox, slot.oy)
                    LifePixels.inkRows(px, slot.lw, slot.lh)?.let { ink -> top = Math.min(top, ink[0]); bot = Math.max(bot, ink[1]); wide = Math.max(wide, ink[3] - ink[2] + 1) }
                    arrays[slot.arr].frames += px
                }
                val ax = e.getDouble("ax", w / 2.0); val ay = e.getDouble("ay", h / 2.0)
                val sp = LifeSprite(Math.max(if (bot >= 0) bot - top + 1 else 0, wide), w, h, ax, ay, n, e.getInt("frameMs", 160))
                sp.arr = slot.arr; sp.layer0 = slot.layer0; sp.lw = slot.lw; sp.lh = slot.lh; sp.lax = ax + slot.ox; sp.lay = ay + slot.oy
                sprites[id] = sp
                e = e.next
            }
        }
        if (sprites.isEmpty() && creatures.isEmpty()) return Cut(null, "pack has no realm.json sprites/creatures")
        val life = sc.compileLife(realmId, table0, object : LifeLookup {
            override fun sprite(id: String) = sprites[norm(id)]
            override fun creature(id: String) = creatures[norm(id)]
        }) ?: return Cut(null, "no LIFE table for $realmId")
        missing += life.missing
        val grid = meta.get("grid")
        life.bx0 = 0.0; life.by0 = 0.0; life.bx1 = grid.getInt("cols") * sc.geo.deedArt.toDouble(); life.by1 = grid.getInt("rows") * sc.geo.deedArt.toDouble()
        composeStands(life, arrays, missing, placer)
        meta.get("wind")?.get("artPxPerSec")?.takeIf { it.isArray }?.let { life.wind = it.asDoubleArray() }
        // the frames are cut: the atlases (LifeSprite.src, 8.5–10.9 MB per realm) and their map reductions are not read again
        for (sp in sprites.values) { sp.src = null; sp.map7 = null }
        return Cut(life, "ok", arrays, sprites, missing, darkTwins)
    }

    /** life.js `composeStands`: one MAP clump per stand variant, its members' kit art at map scale laid out where the TRUE
     *  members stand, painter-ordered, binary alpha. */
    private fun composeStands(life: CLife, arrays: List<LifeArrayBuild>, missing: MutableList<String>, placer: Placer) {
        val st = life.stands ?: return
        for (v in st.variants) {
            class Part(val t: LifeReduced, val x0: Int, val y0: Int, val flip: Int)
            val parts = ArrayList<Part>()
            for (m in v.members) {
                val sp = st.species[m.s].sp
                val t = sp.src?.let { src -> sp.map7 ?: LifePixels.reduceMap(src).also { sp.map7 = it } }
                if (t == null) { val msg = "${st.species[m.s].id} (stand clump art)"; if (!missing.contains(msg)) missing += msg; continue }
                val x0 = JsMath.round(m.dx / 7.0).toInt() - (if (m.flip != 0) (t.w - t.ax).toInt() else t.ax.toInt()); val y0 = JsMath.round(m.dy / 7.0).toInt() - t.ay.toInt()
                parts += Part(t, x0, y0, m.flip)
            }
            if (parts.isEmpty()) continue
            var minX = Int.MAX_VALUE; var minY = Int.MAX_VALUE; var maxX = Int.MIN_VALUE; var maxY = Int.MIN_VALUE
            for (p in parts) { minX = Math.min(minX, p.x0); minY = Math.min(minY, p.y0); maxX = Math.max(maxX, p.x0 + p.t.w); maxY = Math.max(maxY, p.y0 + p.t.h) }
            val w = maxX - minX; val h = maxY - minY
            val slot = placer.place("tw", w, h, 1, c.twinClasses)
            if (slot == null) { missing += "stand clump ${w}×$h too large"; continue }
            val arrIdx = slot.arr; val layer = slot.layer0; val lw = slot.lw; val lh = slot.lh; val ox = slot.ox; val oy = slot.oy
            val px = ByteArray(lw * lh * 4)
            for (p in parts) {
                val t = p.t; val iw = t.img.width; val d = t.img.data
                for (y in 0 until t.h) for (x in 0 until t.w) {
                    val si = (y * iw + x) * 4
                    if ((d[si + 3].toInt() and 0xff) < 128) continue
                    val dx = ox + p.x0 - minX + (if (p.flip != 0) t.w - 1 - x else x); val dy = oy + p.y0 - minY + y; val di = (dy * lw + dx) * 4
                    px[di] = d[si]; px[di + 1] = d[si + 1]; px[di + 2] = d[si + 2]; px[di + 3] = -1
                }
            }
            arrays[arrIdx].frames += px
            v.clump = LifeTwin(arrIdx, layer, lw, lh, ox - minX, oy - minY)
        }
    }
    /** A place in a layer (life.js `place` result): array, first layer, layer size, frame offset in the layer. */
    class Slot(val arr: Int, val layer0: Int, val lw: Int, val lh: Int, val ox: Int, val oy: Int)

    /** life.js `place`: frames go into the array of their size class (a new one when full, ≤ MAX_LAYERS layers). */
    inner class Placer(private val arrays: MutableList<LifeArrayBuild>) {
        fun place(key: String, fw: Int, fh: Int, count: Int, classes: Array<IntArray>): Slot? {
            val sc0 = classes.indexOfFirst { fw <= it[0] && fh <= it[1] }
            if (sc0 < 0) return null
            val lw = classes[sc0][0]; val lh = classes[sc0][1]
            var ai = arrays.indexOfFirst { it.key == key + sc0 && it.frames.size + count <= c.maxLayers }
            if (ai < 0) { arrays += LifeArrayBuild(key + sc0, lw, lh); ai = arrays.size - 1 }
            return Slot(ai, arrays[ai].frames.size, lw, lh, Math.floorDiv(lw - fw, 2), lh - fh)
        }
    }

    /** life.js `uploadArrays`' pixel work: every frame bled, then its mode-preserving 2× chain down to 1×1. */
    fun mips(a: LifeArrayBuild) {
        val levels = a.levels
        a.mips = Array(a.frames.size) { i ->
            var m = LifePixels.Level(LifePixels.bleed(a.frames[i], a.lw, a.lh), a.lw, a.lh)
            Array(levels) { l -> val px = m.px; if (l + 1 < levels) m = LifePixels.reduce2(m.px, m.w, m.h); px }
        }
        a.frames.clear()
    }

    /** life.js `buildTable`: RGBA16UI, 2 rows per scatter group, the stands (2 + a row per variant), creatures, birds, and
     *  one pair per ambience emitter. Returns the texels and the row count. Stage B: a map-only species with a lens glow and
     *  a twin sets flag 4 in T0.z and writes T4 = (glow x + twin ox, glow y + twin oy, GLOW.radiusMap, GLOW.periodMs) in
     *  place of the emitter's fx texel (SCATTER_VS reads it on the twin pass; SPRITE_FS under LIFE_GLOW draws the halo). */
    fun buildTable(life: CLife, sprites: Map<String, LifeSprite>): Pair<ShortArray, Int> {
        val tw = c.maxSpecies * c.spt
        val rows = ArrayList<ShortArray>()
        fun row(): Int { rows += ShortArray(tw * 4); return rows.size - 1 }
        fun put(r: Int, x: Int, v0: Double, v1: Double, v2: Double, v3: Double) {
            if (x >= tw) throw IllegalStateException("LIFE table row overflow at texel $x")
            val vs = doubleArrayOf(v0, v1, v2, v3)
            for (ch in 0 until 4) rows[r][x * 4 + ch] = Math.max(0.0, Math.min(65535.0, JsMath.round(vs[ch]))).toInt().toShort()
        }
        fun dens(r: Int, arr: IntArray) { for (i in arr.indices) rows[r][i] = arr[i].toShort() }
        for (g in life.groups) {
            g.row = row(); row(); dens(g.row + 1, g.density)
            for ((i, s) in g.species.withIndex()) {
                val sp = s.sp; val fxs = s.emit?.let { sprites[norm(it.fx)] }; val tw0 = if (g.twin) sp.twin else null
                val gl = s.glow
                val glow = if (g.mapOnly && gl != null && tw0 != null)
                    doubleArrayOf(gl.getOrElse(0) { Double.NaN } + tw0.ox, gl.getOrElse(1) { Double.NaN } + tw0.oy, c.glow.radiusMap.toDouble(), c.glow.periodMs.toDouble()) else null
                val flags = (if (s.coast) 1 else 0) or (if (fxs != null) 2 else 0) or (if (glow != null) 4 else 0)
                put(g.row, i * c.spt, sp.layer0.toDouble(), (s.cum - 1).toDouble(), (sp.arr or (flags shl 4)).toDouble(), s.on.toDouble())
                put(g.row, i * c.spt + 1, sp.frames.toDouble(), sp.frameMs.toDouble(), sp.inkH.toDouble(), s.footR.toDouble())
                put(g.row, i * c.spt + 2, sp.lw.toDouble(), sp.lh.toDouble(), sp.lax, sp.lay)
                put(g.row, i * c.spt + 3, 0.0, if (fxs != null) fxs.layer0 + 1.0 else 0.0, (s.emit?.dx ?: 0.0) + 32768, (s.emit?.dy ?: 0.0) + 32768)
                if (glow != null) put(g.row, i * c.spt + 4, glow[0], glow[1], glow[2], glow[3])
                else put(g.row, i * c.spt + 4, fxs?.frames?.toDouble() ?: 0.0, fxs?.frameMs?.toDouble() ?: 0.0, s.emit?.rise ?: 0.0, fxs?.inkH?.toDouble() ?: 0.0)
                if (tw0 != null) put(g.row, i * c.spt + 5, ((tw0.arr shl 9) or (tw0.layer + 1)).toDouble(), (tw0.lw or (tw0.lh shl 8)).toDouble(), tw0.lax.toDouble(), tw0.lay.toDouble())
                else put(g.row, i * c.spt + 5, 0.0, 0.0, 0.0, 0.0)
                if (tw0 != null) g.hasTwins = true
                if (fxs != null) g.hasEmit = true
                if (glow != null) g.hasGlow = true
            }
        }
        val st = life.stands
        if (st != null) {
            st.row = row(); row()
            for ((i, s) in st.species.withIndex()) {
                val sp = s.sp
                put(st.row, i * c.spt, sp.layer0.toDouble(), 0.0, sp.arr.toDouble(), 0.0)
                put(st.row, i * c.spt + 1, sp.frames.toDouble(), sp.frameMs.toDouble(), sp.inkH.toDouble(), 1.0)
                put(st.row, i * c.spt + 2, sp.lw.toDouble(), sp.lh.toDouble(), sp.lax, sp.lay)
            }
            for ((k, mx) in st.mixes.withIndex()) for (ch in mx.density.indices) rows[st.row + 1][(k * 4 + (ch shr 2)) * 4 + (ch and 3)] = mx.density[ch].toShort()
            for (v in st.variants) {
                val r = row(); val mx = st.mixes[v.mix]; val cl = v.clump
                put(r, 0, (v.mix or (v.members.size shl 4) or (mx.field.id shl 9) or ((if (mx.sway) 1 else 0) shl 10) or ((if (mx.mapOnly) 1 else 0) shl 11)).toDouble(),
                    v.r4.toDouble(), if (cl != null) cl.layer + 1.0 else 0.0, cl?.arr?.toDouble() ?: 0.0)
                if (cl != null) put(r, 1, (cl.lw or (cl.lh shl 8)).toDouble(), cl.lax.toDouble(), cl.lay.toDouble(), v.inkH.toDouble())
                else put(r, 1, 0.0, 0.0, 0.0, v.inkH.toDouble())
                for ((i, m) in v.members.withIndex()) put(r, 2 + i, m.dx + 32768.0, m.dy + 32768.0, m.s.toDouble(), m.flip.toDouble())
                put(r, 18, v.footDy + 32768.0, 0.0, 0.0, 0.0)
            }
        }
        val cr = life.creatures
        if (cr != null && cr.species.isNotEmpty()) {
            cr.row = row(); row(); dens(cr.row + 1, cr.density)
            for ((i, s) in cr.species.withIndex()) {
                val sh = s.sh
                put(cr.row, i * c.spt, sh.layer0.toDouble(), (s.cum - 1).toDouble(), if (sh.water) 1.0 else 0.0, s.on.toDouble())
                put(cr.row, i * c.spt + 1, sh.frames.toDouble(), sh.frameMs.toDouble(), sh.inkH.toDouble(), sh.speed)
                put(cr.row, i * c.spt + 2, sh.lw.toDouble(), sh.lh.toDouble(), sh.lax, sh.lay)
                put(cr.row, i * c.spt + 3, sh.dwellMs.toDouble(), s.herdMin.toDouble(), s.herdMax.toDouble(), sh.directions.toDouble())
            }
        }
        val b = life.birds
        if (b != null && b.species.isNotEmpty()) {
            b.row = row(); row()
            for ((i, s) in b.species.withIndex()) {
                val sp = s.sp
                put(b.row, i * c.spt, sp.layer0.toDouble(), (s.cum - 1).toDouble(), 0.0, s.on.toDouble())
                put(b.row, i * c.spt + 1, sp.frames.toDouble(), sp.frameMs.toDouble(), sp.inkH.toDouble(), s.speed)
                put(b.row, i * c.spt + 2, 32.0, 32.0, sp.lax, sp.lay)
                put(b.row, i * c.spt + 3, s.fMin.toDouble(), s.fMax.toDouble(), s.alt, 0.0)
            }
        }
        for (a in life.ambience) { a.row = row(); row(); dens(a.row + 1, a.density) }
        val data = ShortArray(tw * 4 * rows.size)
        for ((i, r) in rows.withIndex()) System.arraycopy(r, 0, data, i * tw * 4, tw * 4)
        return data to rows.size
    }

    /** life.js `submitCounts`: the instanced draws that submit each window (scatter.js `submittedTotal` counts them). */
    fun submitCounts(life: CLife, arrays: List<LifeArrayBuild>, airArray: Int) {
        fun has(a: Int, k: String) = a >= 0 && a < arrays.size && arrays[a].mips.isNotEmpty() && arrays[a].key.startsWith(k)
        val air = airArray >= 0
        for (g in life.groups) {
            val kit = g.species.map { it.sp.arr }.filter { has(it, "spr") }.toSet().size
            val kitMap = if (g.twin) g.species.filter { it.sp.twin == null }.map { it.sp.arr }.filter { has(it, "spr") }.toSet().size else 0
            val twin = if (g.hasTwins) g.species.mapNotNull { it.sp.twin?.arr }.filter { has(it, "tw") }.toSet().size else 0
            g.submit = GroupSubmit(kit, kitMap, twin, if (g.hasEmit && air) c.puffs else 0)
        }
        life.stands?.let { s ->
            s.submit = StandSubmit(s.species.map { it.sp.arr }.filter { it >= 0 && it < arrays.size && arrays[it].mips.isNotEmpty() }.toSet().size,
                s.variants.mapNotNull { it.clump?.arr }.filter { it < arrays.size && arrays[it].mips.isNotEmpty() }.toSet().size)
        }
        life.birds?.submit = if (air) 2 else 0
    }
}
