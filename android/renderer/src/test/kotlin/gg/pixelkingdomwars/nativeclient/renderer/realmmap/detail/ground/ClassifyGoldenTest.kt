package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Classes
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Flag
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmTestData
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.bits
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.hx
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.list
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * The classifier port against the pinned web `classify.js` over every real realm pack (`classify-<realm>.json`, written
 * by `tools/world-ground-golden.mjs`): the post-load fields (the foreign-sea cap and the tarn clip applied as ground.js
 * load() applies them), the prepared and bent rivers, the land bridges, and the class, ground class, ring flag and
 * sampled wetness of ~7,300 vertices per realm in eight windows (a river under a plot, a plot by the water, a coast, a
 * forest/field edge, rock/snow, a lake, and two MAP-lattice windows), plus exact intermediate doubles. Target 100 %.
 * Why it matters: web and Seeker draw ONE world; a vertex classed differently puts a tree in a river, a shore on land or a
 * kingdom's clearing in the sea on one client only. BASES' CPU class reads (bases.js via GROUND's classState) use this port.
 */
class ClassifyGoldenTest {
    private val plots = RealmTestData.plots
    private val common = GroundGolden.suite("classify-common")

    // ---------------------------------------------------------------- constants

    @Test fun `CLASS_CFG, LINES, BAKE, the line caps and the class ranks are the pinned classify js values`() {
        val c = common.get("CLASS_CFG"); val d = ClassCfg.DEFAULT
        fun noise(n: NoiseCfg, j: JsonValue, what: String) { assertEquals(j.getDouble("period"), n.period, "$what.period"); assertEquals(j.getDouble("amp"), n.amp, "$what.amp"); assertEquals(j.getInt("seed"), n.seed, "$what.seed") }
        noise(d.coastNoise, c.get("coastNoise"), "coastNoise"); noise(d.coastNoise2, c.get("coastNoise2"), "coastNoise2")
        noise(d.inlandNoise, c.get("inlandNoise"), "inlandNoise"); noise(d.beachNoise, c.get("beachNoise"), "beachNoise"); noise(d.ringNoise, c.get("ringNoise"), "ringNoise")
        val top = mapOf("coastK" to d.coastK, "inlandK" to d.inlandK, "force" to d.force, "deepT" to d.deepT, "beachW" to d.beachW, "rockT" to d.rockT,
            "slopeStep" to d.slopeStep, "snowT" to d.snowT, "rockWaterGap" to d.rockWaterGap, "rockPlotGap" to d.rockPlotGap, "roadInland" to d.roadInland,
            "roadCoast" to d.roadCoast, "fieldT" to d.fieldT, "forestT" to d.forestT, "specialT" to d.specialT, "g2T" to d.g2T, "plotMargin" to d.plotMargin,
            "cornerRadius" to d.cornerRadius, "warpFine" to d.warpFine, "riverNoiseReach" to d.riverNoiseReach, "far" to d.far)
        for ((k, v) in top) assertEquals(c.getDouble(k), v, "CLASS_CFG.$k")
        assertEquals("Infinity", c.getString("slopeT")); assertEquals(Double.POSITIVE_INFINITY, d.slopeT)
        assertEquals(c.getBoolean("hasShore"), d.hasShore); assertEquals(c.get("rim").getDouble("gap"), d.rimGap)
        val groups = mapOf(
            "island" to (listOf(d.island.base, d.island.corner, d.island.lobe, d.island.amp, d.island.period, d.island.amp2, d.island.period2, d.island.zig, d.island.zigCell,
                d.island.slope, d.island.shallow, d.island.shallowPeriod, d.island.k, d.island.seed.toDouble(), d.island.halo, d.island.haloFade, d.island.haloDeep) to
                listOf("base", "corner", "lobe", "amp", "period", "amp2", "period2", "zig", "zigCell", "slope", "shallow", "shallowPeriod", "k", "seed", "halo", "haloFade", "haloDeep")),
            "bend" to (listOf(d.bend.clear, d.bend.taper, d.bend.taperK, d.bend.iters.toDouble(), d.bend.seed.toDouble()) to listOf("clear", "taper", "taperK", "iters", "seed")),
            "parcel" to (listOf(d.parcel.block.toDouble(), d.parcel.min.toDouble(), d.parcel.max.toDouble(), d.parcel.salt.toDouble()) to listOf("block", "min", "max", "salt")),
            "clearing" to (listOf(d.clearing.extra, d.clearing.corner, d.clearing.lobe, d.clearing.amp, d.clearing.period, d.clearing.amp2, d.clearing.period2, d.clearing.seed.toDouble(), d.clearing.seed2.toDouble()) to
                listOf("extra", "corner", "lobe", "amp", "period", "amp2", "period2", "seed", "seed2")),
            "apron" to (listOf(d.apron.min, d.apron.amp, d.apron.period, d.apron.seed.toDouble(), d.apron.feather) to listOf("min", "amp", "period", "seed", "feather")),
            "claimRag" to (listOf(d.claimRag!!.amp, d.claimRag!!.period, d.claimRag!!.seed.toDouble()) to listOf("amp", "period", "seed")),
            "classWarp" to (listOf(d.classWarp!!.amp, d.classWarp!!.period, d.classWarp!!.amp2, d.classWarp!!.period2, d.classWarp!!.amp3, d.classWarp!!.cell3, d.classWarp!!.zig, d.classWarp!!.zigCell, d.classWarp!!.seed.toDouble()) to
                listOf("amp", "period", "amp2", "period2", "amp3", "cell3", "zig", "zigCell", "seed")),
            "riverMeander" to (listOf(d.riverMeander!!.amp, d.riverMeander!!.period, d.riverMeander!!.amp2, d.riverMeander!!.period2, d.riverMeander!!.hw, d.riverMeander!!.hwPeriod, d.riverMeander!!.step, d.riverMeander!!.seed.toDouble()) to
                listOf("amp", "period", "amp2", "period2", "hw", "hwPeriod", "step", "seed")),
            "lakeWarp" to (listOf(d.lakeWarp!!.amp, d.lakeWarp!!.period, d.lakeWarp!!.amp2, d.lakeWarp!!.period2, d.lakeWarp!!.seed.toDouble()) to listOf("amp", "period", "amp2", "period2", "seed")),
            "bridge" to (listOf(d.bridge.max, d.bridge.w, d.bridge.wAdd, d.bridge.head, d.bridge.wob, d.bridge.wobPeriod, d.bridge.taper, d.bridge.dirs.toDouble(), d.bridge.k, d.bridge.seed.toDouble()) to
                listOf("max", "w", "wAdd", "head", "wob", "wobPeriod", "taper", "dirs", "k", "seed")),
        )
        for ((name, pair) in groups) { val j = c.get(name); for ((i, key) in pair.second.withIndex()) assertEquals(j.getDouble(key), pair.first[i], "CLASS_CFG.$name.$key") }
        // every key of the pinned CLASS_CFG is one the port carries (a new key fails here until it is ported)
        val known = top.keys + setOf("slopeT", "hasShore", "rim", "coastNoise", "coastNoise2", "inlandNoise", "beachNoise", "ringNoise") + groups.keys
        for (k in list(c).map { it.name }) assertTrue(k in known, "CLASS_CFG.$k is not ported")
        val lines = common.get("LINES"); val l = LinesCfg.DEFAULT
        assertEquals(lines.getDouble("riverHwMin"), l.riverHwMin); assertEquals(lines.getDouble("trackHwMin"), l.trackHwMin)
        assertEquals(lines.getDouble("riverNoiseK"), l.riverNoiseK); assertEquals(lines.getDouble("lensMargin"), l.lensMargin)
        val bake = common.get("BAKE")
        assertEquals(bake.getInt("size"), ClassBake.PAGE); assertEquals(bake.getDouble("cap"), ClassBake.CAP); assertEquals(bake.getDouble("ampCap"), ClassBake.AMP_CAP)
        val cls = Classify(plots)
        val cap = common.get("LINE_CAP")
        assertEquals(cap.getInt("perDeed"), cls.lineCapPerDeed); assertEquals(cap.getDouble("margin"), cls.lineCapMargin); assertEquals(cap.getDouble("hwMax"), cls.lineCapHwMax)
        assertEquals(common.getInt("DESPECKLE_PASSES"), Resolve.DESPECKLE_PASSES); assertEquals(common.getInt("MAP_DESPECKLE"), Resolve.MAP_DESPECKLE)
        assertEquals(GroundGolden.ints(common.get("CLASS_RANK")).toList(), ClassNames.RANK.toList())
        assertEquals(common.getInt("TILES"), plots.tiles); assertEquals(common.getInt("PLOT_CENTRE"), plots.plotCentre)
    }

    @Test fun `plot geometry per keep level is the web's PLOT_GEOM, from the catalogue's claim tables`() {
        val cls = Classify(plots)
        assertEquals(common.getString("islandMaxMargin"), bits(cls.islandMaxMargin())); assertEquals(common.getString("islandReach"), bits(cls.islandReach()))
        var n = 0
        for (row in list(common.get("plotGeom"))) {
            val lv = row.getInt(0); val g = cls.plotGeom(lv)
            assertEquals(row.getInt(1), g.claim, "claim L$lv"); assertEquals(row.getInt(2), g.ring, "ring L$lv")
            assertEquals(row.getString(3), bits(g.half), "half L$lv"); assertEquals(row.getString(4), bits(g.r), "R L$lv")
            assertEquals(row.getString(5), bits(g.minX), "min L$lv"); assertEquals(row.getString(6), bits(g.maxX), "max L$lv"); n++
        }
        assertEquals(20, n)
        assertEquals(GroundGolden.ints(common.get("mapNoiseDefault")).toList(), GroundTables.mapNoise(ClassCfg.DEFAULT).toList(), "rm-map noise bank")
    }

    @Test fun `prepareLines and the land and river page bake agree with the web on synthetic tracks and bad data`() {
        val cls = Classify(plots)
        val s = common.get("synthLines")
        val json = s.get("json") // non-finite numbers arrive as the strings "NaN" / "Infinity": JS `+v` reads them back as numbers
        val cols = s.get("grid").getInt(0); val rows = s.get("grid").getInt(1)
        val lines = cls.prepareLines(json, cols, rows, ClassCfg.DEFAULT)
        assertEquals(s.getInt("bad"), lines.bad, "non-finite points dropped")
        for ((name, set) in listOf("rivers" to lines.rivers, "tracks" to lines.tracks)) {
            val j = s.get(name)
            assertEquals(j.getInt("count"), set.count, "$name count"); assertEquals(j.getInt("dropped"), set.dropped, "$name dropped")
            assertEquals(j.getString("segs"), GroundGolden.sha256Doubles(set.segs), "$name segments")
            val cells = ArrayList<Int>(); for ((k, a) in set.cells) { cells += k; cells += a.size; for (v in a) cells += v }
            assertEquals(j.getString("cells"), GroundGolden.sha256Ints(cells.toIntArray()), "$name per-deed lists and their order")
        }
        var n = 0
        val words = IntArray(ClassBake.PAGE_N)
        for (p in list(s.get("pages"))) {
            val dx = p.getInt("dx"); val dy = p.getInt("dy")
            if (p.getString("kind") == "land") ClassBake.landPageWords(lines.tracks, dx, dy, plots.tiles, ClassCfg.DEFAULT, words)
            else ClassBake.riverPageWords(lines.rivers, dx, dy, plots.tiles, ClassCfg.DEFAULT, words)
            assertEquals(p.getString("sha256"), GroundGolden.sha256Ints(words), "${p.getString("kind")} page ($dx, $dy)"); n++
        }
        assertEquals(list(s.get("pages")).size, n); assertTrue(n >= 4, "only $n synthetic pages")
    }

    // ---------------------------------------------------------------- real packs

    private class Realm(val cls: Classify, val g: JsonValue, val cfg: ClassCfg, val cols: Int, val rows: Int, val fields: Fields, val lines: Lines, val state: BaseState)

    private fun realm(id: String): Realm {
        val g = GroundGolden.suite("classify-$id")
        val cols = g.get("grid").getInt(0); val rows = g.get("grid").getInt(1)
        val cls = Classify(plots)
        val cfg = ClassCfg.from(g.get("classesOverride"))
        val fields = Fields(GroundGolden.image(g.get("fieldsA")), GroundGolden.image(g.get("fieldsBC")), plots.tiles)
        val lines = cls.prepareLines(g.get("lines"), cols, rows, cfg)
        val data = ByteArray(cols * rows * 4)
        for (i in 0 until cols * rows) data[i * 4] = 1 // classify.js makeState: kind 1 everywhere
        for (b in list(g.get("bases"))) {
            val i = (b.getInt(1) * cols + b.getInt(0)) * 4; val lv = b.getInt(2)
            data[i + 1] = (Flag.OCCUPIED or (if (b.getInt(3) == 1) Flag.MINE else 0)).toByte(); data[i + 2] = cls.plotGeom(lv).claim.toByte(); data[i + 3] = lv.toByte()
        }
        return Realm(cls, g, cfg, cols, rows, fields, lines, BaseState(cols, rows, data))
    }

    /**
     * Rewritten for stage B (was: "the foreign-sea cap rewrites fieldsA's coast byte for byte"): from pack a6447a69 every
     * realm.json says PACK baked the foreign-sea cap and the tarn clip into fieldsA.png, so ground.js load() runs neither and
     * the classifier reads the file's bytes. Why it matters: a loader that ignored the flag would cap the baked coast a second
     * time with its own far field and move the coast on one client only (border.json's reRun: 1,508 texels, 624 vertices
     * with the catalogue far field). The production pass function runs here over the file's crops with the realm's own
     * realm.json: it must run no pass (a re-run cap returns stats; the tarn clip cannot run on crops and would throw) and
     * leave every channel of every crop byte equal to the web's post-load fieldsA.
     */
    @Test fun `PACK's baked fieldsA is loaded as it is on every realm, neither load pass runs again`() {
        var texels = 0L
        for (id in GroundGolden.REALMS) {
            val g = GroundGolden.suite("classify-$id")
            val cols = g.get("grid").getInt(0); val rows = g.get("grid").getInt(1)
            val far = RealmLoader.farDeeds(GroundGolden.gunzip(g.getString("deeds")), cols, rows, 255)
            val meta = g.get("laneMeta")
            assertEquals(list(g.get("stageB").get("fieldsABaked")).map { it.asString() }, GroundLoad.bakedPasses(meta).sorted(), "$id: the passes realm.json says are baked")
            assertTrue(g.get("foreignSea").getBoolean("baked", false) && g.get("clipTarns").getBoolean("baked", false), "$id: the web ran a load pass")
            val file = GroundGolden.image(g.get("fieldsA"), "raw"); val post = GroundGolden.image(g.get("fieldsA"))
            val passes = GroundLoad.fieldPasses(meta, file, far, cols, rows, plots.tiles) { error("$id: the tarn clip asked for chart8 on a baked pack") }
            assertEquals(null, passes.foreignSea, "$id: the foreign-sea cap ran again over the baked coast")
            assertEquals(null, passes.tarns, "$id: the tarn clip ran again")
            var differ = 0
            for (c in list(g.get("fieldsA").get("crops"))) {
                val x0 = c.getInt("x0"); val y0 = c.getInt("y0")
                for (y in y0 until y0 + c.getInt("h")) for (x in x0 until x0 + c.getInt("w")) {
                    for (ch in 0 until 4) if (file.at(x, y, ch) != post.at(x, y, ch)) differ++
                    texels++
                }
            }
            assertEquals(0, differ, "$id: loaded fieldsA bytes differ from the web's post-load bytes")
        }
        assertTrue(texels > 100_000, "only $texels texels compared")
    }

    @Test fun `prepared rivers, bent rivers and their page order are the web's on every realm`() {
        for (id in GroundGolden.REALMS) {
            val r = realm(id); val p = r.g.get("prepared")
            assertEquals(p.getInt("bad"), r.lines.bad, "$id bad points")
            assertEquals(p.get("rivers").getInt("count"), r.lines.rivers.count, "$id river segments")
            assertEquals(p.get("rivers").getString("segs"), GroundGolden.sha256Doubles(r.lines.rivers.segs), "$id meandered rivers")
            assertEquals(p.get("tracks").getInt("count"), r.lines.tracks.count, "$id tracks")
            val bent = r.cls.bendRivers(r.lines, r.state, r.cfg); val b = r.g.get("bent")
            assertEquals(b.getInt("moved"), bent.moved, "$id vertices moved"); assertEquals(b.getInt("blocked"), bent.blocked, "$id blocked")
            assertEquals(b.getInt("count"), bent.count, "$id bent segments"); assertEquals(b.getString("segs"), GroundGolden.sha256Doubles(bent.segs), "$id bent rivers")
            assertEquals(b.getInt("pages"), bent.cells.size, "$id river pages")
            assertEquals(b.getString("pageKeys"), GroundGolden.sha256Ints(bent.cells.keys.toIntArray()), "$id river page order (the line bake's page numbers)")
        }
    }

    @Test fun `land bridges, river pages and downstream hints are the web's on every realm`() {
        var bridges = 0; var pages = 0
        for (id in GroundGolden.REALMS) {
            val r = realm(id)
            val out = r.cls.plotBridges(r.fields, r.lines, r.state, r.cfg)
            for (row in list(r.g.get("bridges"))) {
                val k = row.getInt(0)
                for (c in 0 until 4) assertEquals(row.getString(1 + c), bits(out[k * 4 + c].toDouble()), "$id bridge of deed $k [$c]")
                if (out[k * 4 + 2] > 0f) bridges++
            }
            val bent = r.cls.bendRivers(r.lines, r.state, r.cfg)
            val words = IntArray(ClassBake.PAGE_N); val hint = DoubleArray(2)
            for (p in list(r.g.get("pages"))) {
                val k = p.getInt("k")
                ClassBake.riverPageWords(bent, k % r.cols, k / r.cols, plots.tiles, r.cfg, words)
                assertEquals(p.getString("sha256"), GroundGolden.sha256Ints(words), "$id river page of deed $k")
                ClassBake.riverHint(bent, k, hint)
                assertEquals(p.get("hint").getString(0), bits(hint[0]), "$id hint x of $k"); assertEquals(p.get("hint").getString(1), bits(hint[1]), "$id hint y of $k")
                pages++
            }
        }
        assertTrue(bridges >= 5, "only $bridges bridges were exercised"); assertTrue(pages >= 16, "only $pages pages")
    }

    @Test fun `every sampled vertex of every realm has the web's class, ground class, ring flag and sampled wetness`() {
        var vertices = 0; var details = 0
        val miss = StringBuilder(); var mismatches = 0
        for (id in GroundGolden.REALMS) {
            val r = realm(id)
            r.state.rivers = r.cls.bendRivers(r.lines, r.state, r.cfg)
            r.state.bridges = r.cls.plotBridges(r.fields, r.lines, r.state, r.cfg)
            val d = ClassDetail()
            for (w in list(r.g.get("windows"))) {
                val x0 = w.getInt("x0"); val y0 = w.getInt("y0"); val ww = w.getInt("w"); val hh = w.getInt("h"); val step = w.getInt("step")
                val cfg = if (step > 1) r.cfg.lattice() else r.cfg
                val cls = w.getString("cls"); val ground = w.getString("ground"); val ring = w.getString("ring"); val wet = w.getString("wet")
                val detail = HashMap<Int, JsonValue>(); for (row in list(w.get("detail"))) detail[row.getInt(1) * ww + row.getInt(0)] = row
                for (j in 0 until hh) for (i in 0 until ww) {
                    val x = (x0 + i * step).toDouble(); val y = (y0 + j * step).toDouble(); val idx = j * ww + i
                    r.cls.classDetail(r.fields, r.lines, r.state, x, y, cfg, d)
                    val sw = r.cls.sampledWet(r.fields, r.lines, r.state, x, y, cfg)
                    val ok = cls[idx].digitToInt(16) == d.cls && ground[idx].digitToInt(16) == d.ground && (ring[idx] == '1') == d.ring && wet[idx].digitToInt() == sw
                    if (!ok) { mismatches++; if (miss.length < 2000) miss.append("$id ${w.getString("name")} ($x, $y): web ${cls[idx]}/${ground[idx]}/${ring[idx]}/${wet[idx]} native ${d.cls}/${d.ground}/${d.ring}/$sw\n") }
                    detail[idx]?.let { row ->
                        val got = doubleArrayOf(d.coast, d.inland, d.river, d.lake, d.bridge, d.island, d.plot, d.track)
                        for (f in got.indices) if (row.getString(2 + f) != bits(got[f])) { mismatches++; if (miss.length < 2000) miss.append("$id ${w.getString("name")} ($x, $y) field $f: web ${hx(row.getString(2 + f))} native ${got[f]}\n") }
                        details++
                    }
                    vertices++
                }
            }
        }
        assertEquals(0, mismatches, "vertices differing from the web classifier ($vertices checked):\n$miss")
        assertEquals(8 * (6 * 32 * 32 + 2 * 24 * 24), vertices)
        assertTrue(details >= 8 * 200, "only $details detail rows")
    }

    @Test fun `the CPU resolve reference (despeckle, legalise, lattice purity) equals the web's on real regions`() {
        var regions = 0
        for (id in GroundGolden.REALMS) {
            val r = realm(id)
            r.state.rivers = r.cls.bendRivers(r.lines, r.state, r.cfg)
            r.state.bridges = r.cls.plotBridges(r.fields, r.lines, r.state, r.cfg)
            val mapMeta = r.g.get("mapMeta"); val trueMeta = r.g.get("trueMeta")
            val mapTable = mapMeta?.takeIf { !it.isNull }?.let { BandTable.map(it) }
            val trueTable = trueMeta?.takeIf { !it.isNull }?.let { BandTable.trueBand(it) }
            val slots = mapTable?.let { t -> val wild = mapMeta.getString("wild"); IntArray(ClassNames.COUNT) { c -> val tt = t.terrainOf[c]; if (tt == wild) 0 else if (tt != null && Regex("^M[1-5]$").matches(tt)) tt[1] - '0' else 0 } }
            for (reg in list(r.g.get("regions"))) {
                val step = reg.getInt("step"); val withSlots = reg.getBoolean("withSlots")
                val table = if (step == 1) trueTable else mapTable
                val out = Resolve.region(r.cls, r.fields, r.lines, r.state, reg.getInt("x0"), reg.getInt("y0"), reg.getInt("w"), reg.getInt("h"), step, table, r.cfg,
                    slots = if (withSlots) slots else null)
                fun s(a: ByteArray) = a.joinToString("") { "0123456789abcdef"[it.toInt() and 15].toString() }
                assertEquals(reg.getString("grid"), s(out.grid), "$id region step $step grid")
                assertEquals(reg.getString("ground"), s(out.ground), "$id region step $step ground")
                assertEquals(reg.getString("ring"), s(out.ring), "$id region step $step ring")
                if (withSlots) assertEquals(reg.getString("pure"), s(out.pure!!), "$id region step $step purity")
                assertEquals(reg.getInt("collapsed"), out.collapsed); assertEquals(reg.getInt("illegal"), out.illegal); assertEquals(reg.getInt("flipped"), out.flipped, "$id flipped")
                regions++
            }
        }
        assertEquals(8 * 4, regions)
        // the regions exercise despeckle (the lattice coast regions flip vertices), not only the identity
        assertTrue(GroundGolden.REALMS.sumOf { id -> list(GroundGolden.suite("classify-$id").get("regions")).sumOf { it.getInt("flipped") } } > 0)
    }

    @Test fun `a lattice-wet vertex is never read as land by the sampled class reads (classes-sampled contract)`() {
        // P0 "classes-sampled": sampledWet ⊇ classAt's wet (only plot / island / bridge forcing dries); on the real windows
        var wetByClass = 0
        for (id in GroundGolden.REALMS) {
            val g = GroundGolden.suite("classify-$id")
            for (w in list(g.get("windows"))) {
                val cls = w.getString("cls"); val wet = w.getString("wet"); val ground = w.getString("ground")
                for (i in cls.indices) {
                    val c = ground[i].digitToInt(16)
                    if (c <= Classes.WATER && cls[i].digitToInt(16) != Classes.RING) { wetByClass++; assertTrue(wet[i] != '0', "$id ${w.getString("name")} vertex $i is wet by class but sampled dry") }
                }
            }
        }
        assertTrue(wetByClass > 1000, "only $wetByClass wet vertices checked")
    }
}
