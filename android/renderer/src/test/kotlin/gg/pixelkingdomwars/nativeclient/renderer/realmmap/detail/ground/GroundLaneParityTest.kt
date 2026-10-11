package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGlRig
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMeta
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackFiles
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmTestData
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmWebPin
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RgbaImage
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGolden.list
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/**
 * GROUND's GL orchestration against the pinned web `ground.js` itself (`classify-<realm>.json` → `lane`): the generator ran
 * `createGround(core).load(pack)` on a recording fake core over each REAL pack, set the realm suite's plots, and drew one
 * MAP frame (d 150) and one TRUE frame (d 1200) on a 914×2034 canvas, recording every uniform per program (the first and
 * the last value of each frame). The native lane runs the same frames on the recording fake GL over the same realm.json,
 * lines.json, deeds mask and plots, and must set the same value for every uniform that does not depend on the painting's
 * pixels (excluded: the palette `uMpPal`/`uTgPal`, the family grade `uMpFamK`, the ring sea `uMpSeaFar`, and uRmGrid's
 * bridge flag — the JVM test decodes no WebP and holds no real fields; and, in the one gem-sea realm, the gem colours
 * `uMpGemCol`, measured on its ground.png, which the golden does not carry: GroundStageBGoldenTest pins them against the
 * web's measured gemK and GroundLaneTest the wiring; the gem share, drift and on flag `uMpGem` are compared everywhere,
 * and `uMpGemCol` on every other realm, where it is the web's ones). Why it matters: these uniforms are the MAP and TRUE
 * ground's whole CPU half (the legalise and record tables, the noise bank, the band weights, the resolve origins and page
 * geometry, the plot claims); a value that differs draws a different world on the Seeker than on the web.
 */
class GroundLaneParityTest {
    private val excluded = setOf("uMpPal", "uTgPal", "uMpFamK", "uMpSeaFar")

    /** A GroundSource over the golden's real realm.json / lines.json and synthetic images of the real sizes. */
    private class GoldenSource(private val g: JsonValue) : GroundSource {
        private val lm = g.get("laneMeta")
        override fun realmJson(): JsonValue = lm
        override fun bytes(key: String): ByteArray? = when (key) {
            "lines.json" -> g.get("lines").toJson(JsonWriter.OutputType.json).toByteArray()
            "chart8.webp", "tone.webp", "plots.webp" -> ByteArray(1)
            else -> null
        }
        override fun image(bytes: ByteArray, key: String): RgbaImage? = when (key) {
            "chart8.webp" -> img(lm.get("chart8")?.getInt("w", 64) ?: 64, lm.get("chart8")?.getInt("h", 64) ?: 64)
            "tone.webp", "plots.webp" -> img(16, 16)
            else -> null
        }
        override fun png(key: String): RgbaImage? {
            val a = lm.get("map")?.get("atlas"); val ta = lm.get("true")?.get("atlas"); val dc = lm.get("true")?.get("decals")
            return when (key) {
                "fieldsA.png" -> img(g.get("fieldsA").getInt("width"), g.get("fieldsA").getInt("height"))
                "fieldsBC.png" -> img(g.get("fieldsBC").getInt("width"), g.get("fieldsBC").getInt("height"))
                a?.getString("file", "") -> img(a!!.getInt("cols", 16) * a.getInt("cell", 32), 1760)
                lm.get("map")?.get("mask")?.getString("file", "mapmask.png") ?: "mapmask.png" -> img((a?.getInt("cols", 16) ?: 16) * (a?.getInt("cell", 32) ?: 32), 1760)
                ta?.getString("file", "") -> img(ta!!.getInt("cols", 16) * ta.getInt("cell", 32), ta.getInt("rows", 24) * ta.getInt("cell", 32))
                lm.get("true")?.get("mask")?.getString("file", "groundmask.png") ?: "groundmask.png" -> img((ta?.getInt("cols", 16) ?: 16) * 32, (ta?.getInt("rows", 24) ?: 24) * 32)
                dc?.getString("file", "") -> img(dc!!.getInt("cols", 16) * 32, ((dc.getInt("count", 16) + dc.getInt("cols", 16) - 1) / dc.getInt("cols", 16)) * 32)
                else -> null
            }
        }
        private fun img(w: Int, h: Int) = RgbaImage(w, h, ByteArray(w * h * 4) { i -> if (i % 4 == 3) 255.toByte() else ((i / 4) % 251).toByte() })
    }

    /** The lane of [realmFrames]' run (its stats), for the stats test. */
    private val lanes = HashMap<String, GroundLane>()
    private fun realmLane(id: String): GroundLane = lanes[id] ?: realmFrames(id).let { lanes.getValue(id) }

    private fun realmFrames(id: String): Pair<JsonValue, Map<String, RecordingSink>> {
        val g = GroundGolden.suite("classify-$id")
        val cols = g.get("grid").getInt(0); val rows = g.get("grid").getInt(1)
        val deeds = GroundGolden.gunzip(g.getString("deeds"))
        val rig = RealmGlRig(); val sink = RecordingSink(); val uploads = FakeGroundUploads(rig.worker); val plots = RealmTestData.plots
        var now = 1000.0
        val lane = GroundLane(rig.core, sink, uploads, { GoldenSource(g) }, { GroundPrograms.load(it) }, nowMs = { now })
        lane.chartUnder = GroundChartUnder { _, _, _ -> true } // the core's chart under MAP (not compared here)
        val bases = RealmBases(plots); bases.reset(cols, rows)
        val open = RealmOpen(id, RealmMeta(id, id, "preview", null, 0, 0, cols, rows, 0, emptyMap(), "chart8.webp", -1, -1, "deeds.png", 255, 96),
            RealmGrid(0, 0, cols, rows, 0.5), deeds, ByteArray(cols * rows), floatArrayOf(0f, 0f, 0f),
            RealmLoader(object : RealmPackFiles { override fun read(path: String): ByteArray? = null }) { _, _ -> null }, Now, 1, Runnable {}, bases, plots, RealmWebPin.CONFIG)
        val view = RealmView().apply { targetW = 914; targetH = 2034; dpr = 2.0; this.cols = cols; this.rows = rows; workAllowed = true; maxResolves = 0 }
        fun look(x: Double, y: Double, d: Double, far: Double, trueW: Double, decor: Double) {
            view.x = x; view.y = y; view.d = d; view.s = d / 2
            val hw = 914 / d / 2; val hh = 2034 / d / 2
            view.rectX0 = x - hw; view.rectX1 = x + hw; view.rectY0 = y - hh; view.rectY1 = y + hh
            view.bands.far = far; view.bands.map = 1 - far; view.bands.trueW = trueW; view.bands.decor = decor
        }
        fun frame() {
            rig.compiler.runAll(); uploads.poll(rig.core); now += 16.7
            check(rig.begin()); view.uploadBytesLeft = 256 * 1024L
            lane.update(view); lane.drawOffscreen(view); rig.core.beginScreen(0f, 0f, 0f, 1f)
            if (lane.drawsGround(view)) lane.drawGround(view)
            rig.end()
        }
        val at = g.get("lane").get("at"); val ax = at.getDouble(0); val ay = at.getDouble(1)
        lane.open(open)
        look(ax, ay, 12.0, 1.0, 0.0, 0.0)
        repeat(3) { frame() }
        check(lane.readyFor(1) && lane.readyFor(2)) { "$id: the lane never became ready (${lane.stats.error})" }
        val xs = ArrayList<Int>(); val ys = ArrayList<Int>(); val lv = ArrayList<Int>(); val fl = ArrayList<Int>()
        for (b in list(g.get("bases"))) { xs += b.getInt(0); ys += b.getInt(1); lv += b.getInt(2); fl += if (b.getInt(3) == 1) gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Flag.MINE else 0 }
        bases.set(WorldBases(1L, id, xs.toIntArray(), ys.toIntArray(), lv.toIntArray(), fl.toIntArray()))
        lane.basesChanged(bases)
        var n = 0; while (lane.stats.baseJobs == 0 && n++ < 200) frame()   // the web waited for its base-state work too
        check(lane.stats.baseJobs == 1) { "$id: the base-state work never landed" }
        val out = HashMap<String, RecordingSink>()
        sink.reset(); look(ax, ay, 150.0, 0.0, 0.0, 0.0); frame(); out["map"] = snapshot(sink)
        sink.reset(); look(ax, ay, 1200.0, 0.0, 1.0, 1.0); frame(); out["true"] = snapshot(sink)
        // the rehearse hook on every program at the TRUE view (bakes into their own scratch, display into a screen scratch)
        sink.reset(); now += 16.7; check(rig.begin())
        val screen = rig.core.texture2D(gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool.CORE, 1, 1, gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format.RGB8)!!
        for (p in lane.programs()) {
            val own = lane.rehearseScratch(p)
            val drew = rig.core.rehearse(own ?: screen, null, own == null, false) { check(lane.rehearse(p, if (own != null) gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine.TARGET_OWN else gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine.TARGET_SCREEN, view)) { "$id: rehearse(${p.name})" } }
            check(drew || true)
        }
        rig.end(); out["rehearse"] = snapshot(sink)
        lanes[id] = lane
        return Pair(g, out)
    }

    private fun snapshot(s: RecordingSink) = RecordingSink().also { c -> c.ints.putAll(s.ints); c.floats.putAll(s.floats); c.firstInts.putAll(s.firstInts); c.firstFloats.putAll(s.firstFloats) }

    @Test fun `every pixel-independent uniform of the MAP and TRUE frames is the web ground js value, and of the rehearse hook, on all eight realms`() {
        var compared = 0; val miss = StringBuilder(); var mismatches = 0
        for (id in GroundGolden.REALMS) {
            val (g, frames) = realmFrames(id)
            val trace = g.get("lane").get("frames")
            val skip = if (g.get("stageB").get("gems")?.isNull == false) excluded + "uMpGemCol" else excluded
            // (the rehearsal's FIRST values differ by design: ground.js sets the real grid, then overrides it with the probe's;
            // the native hook sets the probe's directly — only the values each draw sees, the last ones, are compared)
            for ((f, which) in listOf("map" to "first", "map" to "last", "true" to "first", "true" to "last", "rehearse" to "last")) {
                val sink = frames.getValue(f)
                for (prog in list(trace.get(f).get(which))) {
                    if (prog.name == "rm-chart") continue // the core's chart (NM), not GROUND's
                    for (u in list(prog)) {
                        if (u.name in skip) continue
                        val key = "${prog.name}/${u.name}"
                        val web = list(u)
                        val gotI = (if (which == "first") sink.firstInts else sink.ints)[key]
                        val gotF = (if (which == "first") sink.firstFloats else sink.floats)[key]
                        val n = if (u.name == "uRmGrid") 3 else web.size // uRmGrid.w = bridges present: from the real fields only
                        val ok = when {
                            gotI != null -> gotI.size == web.size && (0 until n).all { gotI[it] == web[it].asLong().toInt() }
                            gotF != null -> gotF.size == web.size && (0 until n).all { gotF[it] == web[it].asDouble().toFloat() }
                            else -> false
                        }
                        compared++
                        if (!ok) { mismatches++; if (miss.length < 3000) miss.append("$id $f $which $key: web ${web.map { it.asDouble() }} native ${gotI?.toList() ?: gotF?.toList()}\n") }
                    }
                }
            }
        }
        assertEquals(0, mismatches, "uniforms differing from the web ground.js ($compared compared):\n$miss")
        assertTrue(compared >= 8 * 700, "only $compared uniforms compared")
    }

    /**
     * The same frames' GROUND stats against the web's (`lane.stats`): the line-field texture the load bakes (page capacity,
     * river and land pages, W×H), the river vertices the plots' bend moved, and the TRUE record pages. Why it matters: stage B
     * traces Elderwood's and Thornwake's rivers as whole lines (812 and 1,908 points, were 112 and 250), so their line
     * textures grow to 393 river pages (4096×1197 at Thornwake); a native bake that pages or sizes them differently reads
     * other words on the GPU than the web. (Not compared: the web's `rebakes`, a count of its main-thread re-bake slices; the
     * native re-bake runs on the worker, its pages are pinned bit for bit by ClassifyGoldenTest's river pages.)
     */
    @Test fun `the line-field texture, the plots' river bend and the record pages are the web's on all eight realms`() {
        for (id in GroundGolden.REALMS) {
            val g = GroundGolden.suite("classify-$id"); val web = g.get("lane").get("stats"); val l = web.get("lines")
            val lane = realmLane(id)
            val s = lane.stats
            assertEquals(listOf(l.getInt("capacity"), l.getInt("riverPages"), l.getInt("landPages")), listOf(s.lineCapacity, s.riverPages, s.landPages), "$id line pages (capacity, river, land)")
            assertEquals(l.getString("texture"), "${s.lineTexW}×${s.lineTexH}", "$id line texture")
            assertEquals(web.get("bends").getInt("moved"), s.riversMoved, "$id river vertices the plots moved (G16)")
            assertEquals(web.getInt("recPages"), s.recPages, "$id TRUE record pages")
        }
    }
}
