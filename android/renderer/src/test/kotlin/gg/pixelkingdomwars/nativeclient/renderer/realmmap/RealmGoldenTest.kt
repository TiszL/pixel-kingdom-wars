package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Test
import kotlin.math.abs
import kotlin.math.floor
import kotlin.math.max
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.test.fail

/**
 * Golden-vector parity with the pinned web realm engine (GLOBE-NATIVE-PLAN §7): every value below was computed by the
 * web modules at the shader pin (`tools/world-golden.mjs`), and the native port must reproduce 100 % of each exact suite
 * (camera within 1e-9 relative, the cluster spiral within 1e-9). Why it matters: the realm map is ONE world on web and
 * native: a plot, a band edge, a tap or a cluster count that differs by one deed puts a player's kingdom, or the deed
 * they buy, somewhere else on the other platform.
 */
class RealmGoldenTest {
    private val config = RealmWebPin.CONFIG
    private val rules = RealmBandRules(config.bands, RealmWebPin.DEED_ART)

    // ---- helpers -------------------------------------------------------------------------------------------------------
    private fun num(v: JsonValue): Double = if (v.isString) v.asString().toDouble() else v.asDouble()
    private fun rows(v: JsonValue, width: Int): List<JsonValue> {
        val out = ArrayList<JsonValue>()
        val first = v.child ?: return out
        if (first.isArray) { var c: JsonValue? = first; while (c != null) { out.add(c); c = c.next } ; return out }
        // a flattened table: rebuild rows of [width] values
        val all = ArrayList<JsonValue>(); var c: JsonValue? = first; while (c != null) { all.add(c); c = c.next }
        require(all.size % width == 0) { "flattened table of ${all.size} is not rows of $width" }
        for (i in all.indices step width) { val row = JsonValue(JsonValue.ValueType.array); for (j in 0 until width) row.addChild(copy(all[i + j])); out.add(row) }
        return out
    }
    private fun copy(v: JsonValue): JsonValue = when {
        v.isNull -> JsonValue(JsonValue.ValueType.nullValue)
        v.isString -> JsonValue(v.asString())
        v.isBoolean -> JsonValue(v.asBoolean())
        v.isLong -> JsonValue(v.asLong())
        else -> JsonValue(v.asDouble())
    }
    private fun close(expected: Double, actual: Double, what: String, rel: Double = 1e-9) {
        if (expected.isNaN()) { assertTrue(actual.isNaN(), what); return }
        if (expected.isInfinite()) { assertEquals(expected, actual, what); return }
        assertTrue(abs(expected - actual) <= rel * max(1.0, abs(expected)), "$what: expected $expected, got $actual")
    }

    // ---- contracts ----------------------------------------------------------------------------------------------------
    @Test fun `the test pin's presentation constants are the pinned web contracts`() {
        val g = RealmTestData.golden("contracts"); val c = g.get("constants"); val b = c.get("BANDS")
        val bands = config.bands
        for ((name, value) in listOf("farEnd" to bands.farEnd, "mapStart" to bands.mapStart, "trueStart" to bands.trueStart, "trueFull" to bands.trueFull,
            "restEaseMs" to bands.restEaseMs, "selectD" to bands.selectD, "myBaseD" to bands.myBaseD, "herds" to bands.herds, "creatures" to bands.creatures,
            "sway" to bands.sway, "snap" to bands.snap, "sMax" to bands.sMax, "uiDots" to bands.uiDots, "uiIcons" to bands.uiIcons, "keepMinCss" to bands.keepMinCss))
            assertEquals(b.getDouble(name), value, "BANDS.$name")
        assertEquals(b.get("impostor").asDoubleArray().toList(), bands.impostor.toList())
        assertEquals(b.get("twins").asDoubleArray().toList(), bands.twins.toList())
        val rest = ArrayList<Double>(); var r = b.get("rest").child; while (r != null) { rest += r.asDoubleArray().toList(); r = r.next }
        assertEquals(rest, bands.rest.toList(), "BANDS.rest")
        val gs = c.get("GPU_SAFE")
        assertEquals(gs.get("groundPx").asDoubleArray().toList(), config.groundPx.toList())
        assertEquals(gs.get("heavy").asBooleanArray().toList(), config.heavy.toList())
        val rh = gs.get("rehearse")
        assertEquals(rh.getDouble("idleMs"), config.rehearsal.idleMs); assertEquals(rh.getDouble("gapMs"), config.rehearsal.gapMs)
        assertEquals(rh.getDouble("retryMs"), config.rehearsal.retryMs); assertEquals(rh.getDouble("retryMaxMs"), config.rehearsal.retryMaxMs)
        assertEquals(rh.getInt("box"), config.rehearsal.box); assertEquals(rh.getDouble("stallMs"), config.rehearsal.stallMs)
        assertEquals(rh.getDouble("mapReadyHoldMs"), config.rehearsal.mapReadyHoldMs)
        // stage B D-173: the dive's chart → floor flight (the native landing) and the web's leave into the chart
        assertEquals(rh.getInt("diveMs"), GpuSafe.REHEARSE_DIVE_MS); assertEquals(rh.getInt("leaveMs"), GpuSafe.REHEARSE_LEAVE_MS)
        assertEquals(rh.get("trueSet").asStringArray().toSet(), config.rehearsal.trueSet)
        assertEquals(rh.get("order").asStringArray().toList(), config.rehearsal.order)
        assertEquals(c.get("IDLE").getDouble("evictMs"), config.evictMs)
        assertEquals(c.get("DEED_PX").getInt("thisRealm"), config.deedThisRealm); assertEquals(c.get("DEED_PX").getInt("otherRealm"), config.deedOtherRealm)
        assertEquals(c.getDouble("DEED_DEG"), config.deedDeg); assertEquals(c.getDouble("DEED_ART"), RealmWebPin.DEED_ART)
        assertEquals(c.getInt("PLOT_CENTRE"), RealmWebPin.PLOT_CENTRE)
        val po = c.get("PLOT_OFFSET")
        assertEquals(po.getInt("lensMargin"), RealmWebPin.LENS_MARGIN); assertEquals(po.getInt("rimGap"), RealmWebPin.RIM_GAP)
        assertEquals(po.getInt("plotMargin"), RealmWebPin.PLOT_MARGIN); assertEquals(po.getLong("salt").toInt(), RealmWebPin.SALT)
        val gc = g.get("groundcost")
        assertEquals(gc.get("PASS").getDouble("chart"), config.chartPassFetches)
        // the per-band ground scale (core.js fullResPass per pass) reads these: a drifted copy renders MAP or TRUE at the wrong k
        assertEquals(gc.get("PASS").getDouble("map"), config.mapPassFetches); assertEquals(gc.get("PASS").getDouble("true"), config.truePassFetches)
        assertEquals(gs.getLong("coldUploadBytes"), config.coldUploadBytes)
        assertEquals(gc.getDouble("DISPLAY_BUDGET"), config.displayBudget); assertEquals(gc.getDouble("RESOLVE_BUDGET"), config.resolveBudget)
        // the game numbers the catalogue feeds: DEED_ART = worldTiles × GRID.tilePx
        assertEquals(c.getInt("TILES"), RealmTestData.plots.tiles)
    }

    @Test fun `plot rules, rooms, hashes, offsets and centres match the web for every level and 500 deeds`() {
        val g = RealmTestData.golden("contracts"); val plots = RealmTestData.plots
        var n = 0
        var r = g.get("plotRule").child
        while (r != null) {
            val level = plots.clampLevel(num(r.get("in")))
            val rule = plots.rule(level)
            assertEquals(r.getInt("level"), rule.level, "plotRule(${num(r.get("in"))}).level")
            assertEquals(r.getInt("claim"), rule.claim); assertEquals(r.getInt("ring"), rule.ring); assertEquals(r.getInt("plotTiles"), rule.plotTiles)
            assertEquals(r.getInt("wallTier"), rule.wallTier); assertEquals(r.getInt("wallRings"), rule.wallRings)
            n++; r = r.next
        }
        val rooms = g.get("plotRoom").asIntArray()
        for (L in 1..20) assertEquals(rooms[L - 1], plots.room(L), "plotRoom($L)")
        val deeds = rows(g.get("deeds"), 2).map { it.getInt(0) to it.getInt(1) }
        val hashes = g.get("plotHash").asLongArray()
        assertEquals(500, deeds.size)
        for ((i, d) in deeds.withIndex()) { assertEquals(hashes[i], Integer.toUnsignedLong(plots.hash(d.first, d.second)), "plotHash$d"); n++ }
        val offsets = g.get("plotOffset")
        for (L in 1..20) {
            val o = offsets.get(L.toString()).asIntArray()
            for ((i, d) in deeds.withIndex()) {
                assertEquals(o[2 * i], plots.offsetX(d.first, d.second, L), "plotOffset$d L$L dx")
                assertEquals(o[2 * i + 1], plots.offsetY(d.first, d.second, L), "plotOffset$d L$L dy"); n++
            }
        }
        var i = 0; var c = g.get("plotCentre").child
        while (c != null) {
            val d = deeds[i]; var L = 1; var p = c.child
            while (p != null) {
                assertEquals(p.getDouble(0), plots.centreX(d.first, d.second, L), "plotCentre$d L$L x")
                assertEquals(p.getDouble(1), plots.centreY(d.first, d.second, L), "plotCentre$d L$L y")
                L++; n++; p = p.next
            }
            i++; c = c.next
        }
        assertTrue(n >= g.getInt("count"), "compared $n of ${g.getInt("count")} vectors")
    }

    // ---- camera -------------------------------------------------------------------------------------------------------
    @Test fun `band rules match the web at every edge and over 2000 samples`() {
        val g = RealmTestData.golden("camera"); val state = RealmBandState()
        val bands = rows(g.get("bands"), 14)
        assertTrue(bands.size > 2000)
        for (r in bands) {
            val d = num(r.get(0))
            close(num(r.get(1)), rules.snapEdge(d), "snapEdge($d)")
            assertEquals(r.getInt(2) == 1, rules.inRest(d), "inRest($d)")
            assertEquals(r.getString(3), RealmBand.name(rules.bandOf(d)), "bandOf($d)")
            rules.bands(d, state)
            close(num(r.get(4)), state.fadeWeight, "fadeWeight($d)")
            close(num(r.get(5)), rules.restTarget(d), "restTarget($d)")
            close(num(r.get(6)), state.far, "w.far($d)"); close(num(r.get(7)), state.map, "w.map($d)"); close(num(r.get(8)), state.trueW, "w.true($d)")
            close(num(r.get(9)), state.twins, "w.twins($d)"); close(num(r.get(10)), state.decor, "w.decor($d)")
            close(num(r.get(11)), state.herds, "w.herds($d)"); close(num(r.get(12)), state.creatures, "w.creatures($d)"); close(num(r.get(13)), state.sway, "w.sway($d)")
        }
        for (r in rows(g.get("rest"), 4)) close(num(r.get(3)), rules.restTarget(num(r.get(0)), num(r.get(1)), num(r.get(2))), "restTarget(${r})")
        for (r in rows(g.get("snap"), 3)) close(num(r.get(2)), rules.snapD(num(r.get(0)), num(r.get(1))), "snapD(${r})")
    }

    /**
     * Stage B adds the D-173 camera (camera.js 911b39c5/46c197f7): the floor (`floorD` op = setFloorD, null = the fit),
     * the leave's raw flight (`flyToDRaw`: no rest rule, no floor, no band hold) and the QA placement below the floor
     * (`setFree`). The dive traces pin the held flight that resumes at its own end when the gate opened while it still
     * flew to the chart's edge: without it the dive would park at `farEnd` and never land on the floor.
     */
    @Test fun `camera traces (pinch, fling, flights, double-tap, snap, band gate, wheel, pinch-out, D-173) replay the web exactly`() {
        val g = RealmTestData.golden("camera")
        var traces = 0; var states = 0; var trueTraces = 0; var d173 = 0
        var t = g.get("traces").child
        while (t != null) {
            var clock = 0.0
            val cam = RealmCamera(rules) { clock }
            val ops = rows(t.get("ops"), -1).ifEmpty { fail("trace without ops") }
            val expected = rows(t.get("states"), 7)
            assertEquals(ops.size, expected.size)
            for ((i, op) in ops.withIndex()) {
                clock = num(op.get(0))
                val a = { k: Int -> num(op.get(k + 2)) }
                var ret: Any? = null
                when (op.getString(1)) {
                    "viewport" -> cam.setViewport(a(0), a(1), a(2))
                    "grid" -> cam.setGrid(a(0).toInt(), a(1).toInt())
                    "set" -> cam.set(a(0), a(1), a(2))
                    "begin" -> cam.beginGesture()
                    "pan" -> cam.panBy(a(0), a(1))
                    "zoomAt" -> cam.zoomAt(a(0), a(1), a(2))
                    "end" -> cam.endGesture(a(0), a(1), a(2), a(3))
                    "step" -> ret = cam.step(a(0))
                    "wheel" -> cam.wheel(a(0), a(1), a(2))
                    "flyToD" -> cam.flyToD(a(0), a(1), a(2), a(3))
                    "zoomAround" -> cam.zoomAround(a(0), a(1), a(2), a(3))
                    "limitD" -> cam.limitD(a(0))
                    "settle" -> ret = cam.settle(a(0), a(1))
                    "floorD" -> cam.floorD = if (op.get(2).isNull) 0.0 else a(0) // setFloorD(null): the whole-realm fit
                    "flyToDRaw" -> cam.flyToD(a(0), a(1), a(2), a(3), raw = true)
                    "setFree" -> cam.set(a(0), a(1), a(2), free = true)
                    else -> fail("unknown op ${op.getString(1)}")
                }
                val e = expected[i]; val where = "${t.getString("name")} op $i ${op.getString(1)}"
                close(num(e.get(0)), cam.x, "$where x"); close(num(e.get(1)), cam.y, "$where y"); close(num(e.get(2)), cam.s, "$where s")
                assertEquals(e.getInt(3) == 1, cam.moving, "$where moving")
                assertEquals(if (e.get(4).isNull) null else e.getString(4), cam.goalKind, "$where goal")
                assertEquals(e.getInt(5) == 1, cam.pressing, "$where pressing")
                val er = e.get(6)
                if (!er.isNull) assertEquals(er.asBoolean(), ret, "$where return")
                states++
            }
            if (Regex("TRUE|pixel-snap|myBaseD").containsMatchIn(t.getString("name")) && !t.getString("name").contains("threshold")) trueTraces++
            if (t.getString("name").contains("D-173")) d173++
            traces++; t = t.next
        }
        assertEquals(84, traces, "21 scripts × 4 viewports (N3: 5 MAP/TRUE scripts and the measured Seeker row; stage B: 8 D-173 scripts)")
        assertEquals(24, trueTraces, "the MAP/TRUE scripts and the D-173 leave from TRUE on every viewport")
        assertEquals(32, d173, "the D-173 floor, QA, leave and dive scripts on every viewport")
        assertTrue(states > 1000, "replayed $states camera states")
    }

    /**
     * core.js `bandLimit` (stage B, 911b39c5) over every combination of its five flags and nine rehearsal item sets. Why it
     * matters: it is the one rule that decides how far a player may zoom while pipelines are still cold — too loose and
     * the first MAP or TRUE frame builds a pipeline on screen (the Seeker's hang), too tight and the zoom locks with the
     * detail ready. The D-173 dive rule (hold in the chart until the lanes are in) and the valve/bypass exits must match
     * the web; [RealmMapEngine]'s bandGate calls this function (D-177: without the dive rule, which stays pinned here only
     * for the stage-B pin's parity; [RealmBandGateTest] and [RealmMapFloorTest] pin that the engine never holds with it).
     */
    @Test fun `the band gate's limit matches core js bandLimit for every flag combination and item set`() {
        val g = RealmTestData.golden("bandlimit"); val bands = config.bands
        val itemSets = ArrayList<List<IntArray>>()
        var s = g.get("itemSets").child
        while (s != null) { val items = ArrayList<IntArray>(); var it = s.child; while (it != null) { items += it.asIntArray(); it = it.next }; itemSets += items; s = s.next }
        assertEquals(9, itemSets.size)
        fun band(v: JsonValue) = if (v.isNull) 0 else when (v.asString()) { "map" -> 1; "true" -> 2; else -> fail("band ${v.asString()}") }
        fun reason(v: JsonValue) = if (v.isNull) RealmMapEngine.GATE_NONE else when (v.asString()) {
            "loading" -> RealmMapEngine.GATE_LOADING; "rehearsal" -> RealmMapEngine.GATE_REHEARSAL
            "bypassed by a QA set()" -> RealmMapEngine.GATE_BYPASS; else -> fail("reason ${v.asString()}")
        }
        val out = RealmGateLimit()
        val seen = HashSet<String>()
        var n = 0; var r = g.get("rows").child
        while (r != null) {
            val f = IntArray(6) { r.get(it).asInt() }; val items = itemSets[f[5]]
            RealmBandLimit.limit(out, bands, on = f[0] == 1, bypass = f[1] == 1, valve = f[2] == 1, dive = f[3] == 1, lanesIn = f[4] == 1,
                n = items.size, set = { items[it][0] }, gating = { items[it][1] == 1 })
            val where = "bandLimit(on ${f[0]} bypass ${f[1]} valve ${f[2]} dive ${f[3]} lanesIn ${f[4]} items ${f[5]})"
            assertEquals(num(r.get(6)), out.lim, "$where lim"); assertEquals(band(r.get(7)), out.band, "$where band")
            assertEquals(reason(r.get(8)), out.reason, "$where reason")
            seen += "${out.lim}|${out.reason}"
            n++; r = r.next
        }
        assertEquals(288, n, "2^5 flag combinations × 9 item sets")
        assertEquals(setOf("Infinity|${RealmMapEngine.GATE_NONE}", "Infinity|${RealmMapEngine.GATE_BYPASS}", "${bands.farEnd}|${RealmMapEngine.GATE_LOADING}",
            "${bands.farEnd}|${RealmMapEngine.GATE_REHEARSAL}", "${bands.trueStart}|${RealmMapEngine.GATE_REHEARSAL}"), seen, "every outcome is exercised")
        // bandLimit() and bandLimit({}): on, no bypass/valve/dive, lanes in, no items
        for (d in rows(g.get("defaults"), 3)) {
            RealmBandLimit.limit(out, bands)
            assertEquals(num(d.get(0)), out.lim); assertEquals(band(d.get(1)), out.band); assertEquals(reason(d.get(2)), out.reason)
        }
    }

    // ---- grid, catalog and deed masks ----------------------------------------------------------------------------------
    @Test fun `deed-tile pairs, the Cinderfall wrap and lon-lat entry match the frozen catalog for all eight realms`() {
        val g = RealmTestData.golden("grid"); val catalog = RealmTestData.catalog
        assertEquals(g.get("catalog").getString("membershipSha256"), RealmTestData.worldJson.getString("membershipSha256"),
            "the app's catalog is the one the web pin was checked against")
        var realms = 0; var n = 0
        var r = g.get("realms").child
        while (r != null) {
            val id = r.getString("id"); val gg = r.get("grid")
            val grid = RealmGrid(gg.getInt("x0"), gg.getInt("y0"), gg.getInt("cols"), gg.getInt("rows"), config.deedDeg)
            assertEquals(r.getInt("catalogCount"), catalog.deedCount(id), "$id catalog deeds")
            for (row in rows(r.get("catalogTiles"), 3)) {
                val t = row.getInt(0)
                assertEquals(row.getInt(1), grid.deedX(t), "$id deedX($t)"); assertEquals(row.getInt(2), grid.deedY(t), "$id deedY($t)")
                assertEquals(id, catalog.realmOf(t), "$id owns $t"); n++
            }
            for (row in rows(r.get("forward"), 5)) {
                val t = grid.tileId(row.getInt(0), row.getInt(1))
                assertEquals(row.getInt(2), t, "$id tileId(${row.getInt(0)}, ${row.getInt(1)})")
                assertEquals(if (row.get(3).isNull) null else row.getString(3), if (t < 0) null else catalog.realmOf(t), "$id realm of $t"); n++
            }
            for (row in rows(r.get("lonlat"), 6)) {
                val dx = row.getInt(4); val dy = row.getInt(5)
                if (dx < 0) continue
                assertEquals(dx, floor(grid.xAtLon(num(row.get(0)))).toInt(), "$id x at lon ${num(row.get(0))}")
                assertEquals(dy, floor(grid.yAtLat(num(row.get(1)))).toInt(), "$id y at lat ${num(row.get(1))}")
                assertEquals(row.getInt(2), grid.tileId(dx, dy)); n++
            }
            for (row in rows(r.get("otherRealmSample"), 4)) {
                assertEquals(row.getInt(0), grid.tileId(row.getInt(1), row.getInt(2)))
                assertEquals(row.getString(3), catalog.realmOf(row.getInt(0))); n++
            }
            realms++; r = r.next
        }
        assertEquals(8, realms)
        assertEquals(g.getInt("count"), n + skippedLonLat(g), "every grid vector compared")
    }

    private fun skippedLonLat(g: JsonValue): Int {
        var n = 0; var r = g.get("realms").child
        while (r != null) { for (row in rows(r.get("lonlat"), 6)) if (row.getInt(4) < 0) n++; r = r.next }
        return n
    }

    @Test fun `the catalog mask the engine draws and picks with is the frozen catalog, cell for cell, in all eight realms`() {
        val g = RealmTestData.golden("deedmask"); val grids = gridsByRealm(); val catalog = RealmTestData.catalog
        var realms = 0
        var r = g.get("realms").child
        while (r != null) {
            val id = r.getString("id"); val grid = grids.getValue(id)
            val mask = catalog.mask(id, grid, config.deedThisRealm, config.deedOtherRealm)
            assertEquals(r.get("counts").getInt("catalogThis"), mask.count { (it.toInt() and 0xff) == 255 }, "$id catalog deeds in the mask")
            val mism = rows(r.get("mismatch"), 6)
            assertEquals(r.getInt("mismatchCount"), mism.size)
            // where the pack paints a deed differently, the engine's mask holds the catalog's value (the grid is never bent)
            for (m in mism) assertEquals(m.getInt(4), mask[m.getInt(2) * grid.cols + m.getInt(1)].toInt() and 0xff, "$id cell (${m.getInt(1)}, ${m.getInt(2)})")
            realms++; r = r.next
        }
        assertEquals(8, realms)
    }

    private fun gridsByRealm(): Map<String, RealmGrid> {
        val out = HashMap<String, RealmGrid>(); var r = RealmTestData.golden("grid").get("realms").child
        while (r != null) { val gg = r.get("grid"); out[r.getString("id")] = RealmGrid(gg.getInt("x0"), gg.getInt("y0"), gg.getInt("cols"), gg.getInt("rows"), config.deedDeg); r = r.next }
        return out
    }

    private fun basesOf(pick: JsonValue, id: String, grid: RealmGrid): RealmBases {
        val list = rows(pick.get("bases").get(id), 4)
        val bases = RealmBases(RealmTestData.plots); bases.reset(grid.cols, grid.rows)
        bases.set(WorldBases(1, id, IntArray(list.size) { list[it].getInt(0) }, IntArray(list.size) { list[it].getInt(1) },
            IntArray(list.size) { list[it].getInt(2) }, IntArray(list.size) { RealmBases.FLAG_OCCUPIED or (if (list[it].getInt(3) == 1) RealmBases.FLAG_MINE else 0) }))
        assertEquals(list.size, bases.size, "$id: every golden base is on its own deed")
        return bases
    }

    @Test fun `tap picking hits the same base or open catalog deed as the web at 1000 points per view`() {
        val g = RealmTestData.golden("pick"); val grids = gridsByRealm(); val catalog = RealmTestData.catalog
        val masks = HashMap<String, ByteArray>(); val basesBy = HashMap<String, RealmBases>()
        val result = RealmPickResult(); var points = 0; var cases = 0; var trueCases = 0
        var c = g.get("cases").child
        while (c != null) {
            val id = c.getString("realm"); val grid = grids.getValue(id)
            if (c.getString("view").startsWith("true")) { trueCases++; assertTrue(c.get("cam").asDoubleArray()[2] * c.getDouble("dpr") >= config.bands.trueFull, "a TRUE view") }
            val mask = masks.getOrPut(id) { catalog.mask(id, grid, 255, 96) }
            val bases = basesBy.getOrPut(id) { basesOf(g, id, grid) }
            val cam = RealmCamera(rules) { 0.0 }
            cam.setViewport(c.getDouble("W"), c.getDouble("H"), c.getDouble("dpr")); cam.setGrid(grid.cols, grid.rows)
            val cs = c.get("cam").asDoubleArray(); cam.set(cs[0], cs[1], cs[2])
            val hits = HashMap<Int, IntArray>()
            for (h in rows(c.get("hits"), 4)) hits[h.getInt(0)] = intArrayOf(h.getInt(1), h.getInt(2), h.getInt(3))
            val nx = c.get("points").getInt("nx"); val ny = c.get("points").getInt("ny")
            for (j in 0 until ny) for (i in 0 until nx) {
                val sx = (i + 0.5) * c.getDouble("W") / nx; val sy = (j + 0.5) * c.getDouble("H") / ny
                RealmPick.pick(cam, bases, mask, 255, sx, sy, result)
                val want = hits[j * nx + i]
                if (want == null) assertEquals(RealmPickResult.NONE, result.kind, "$id ${c.getString("view")} point ${j * nx + i}")
                else {
                    assertEquals(want[0], result.deedX); assertEquals(want[1], result.deedY)
                    if (want[2] >= 0) { assertEquals(RealmPickResult.BASE, result.kind); assertEquals(want[2], result.base) }
                    else assertEquals(RealmPickResult.OPEN, result.kind, "$id open deed at (${want[0]}, ${want[1]})")
                }
                points++
            }
            cases++; c = c.next
        }
        assertEquals(g.getInt("count"), points, "100 % of the pick points compared")
        assertTrue(cases >= 64)
        // N3: picking at TRUE (d 1400 and the pixel snap) on the Seeker rows, the measured one included, in all eight realms
        assertEquals(8 * 3 * 2, trueCases, "TRUE pick views")
    }

    @Test fun `FAR cluster counters match the web's counts, cells and placements off the chrome`() {
        val g = RealmTestData.golden("cluster"); val grids = gridsByRealm(); val pick = RealmTestData.golden("pick")
        val basesBy = HashMap<String, RealmBases>(); val cluster = RealmCluster()
        var cases = 0; var counters = 0
        var c = g.get("cases").child
        while (c != null) {
            val id = c.getString("realm"); val grid = grids.getValue(id)
            val bases = basesBy.getOrPut(id) { basesOf(pick, id, grid) }
            val chrome = rows(c.get("chrome"), 4); val flat = DoubleArray(chrome.size * 4)
            for ((i, r) in chrome.withIndex()) for (k in 0 until 4) flat[i * 4 + k] = r.getDouble(k)
            cluster.setChrome(flat, chrome.size)
            val box = c.get("box").asDoubleArray(); val cam = c.get("cam").asDoubleArray()
            val list = cluster.compute(bases, cam[0], cam[1], c.getDouble("s"), c.getDouble("W"), c.getDouble("H"), box[0], box[1], box[2], box[3])
            val want = rows(c.get("list"), 7)
            val where = "$id ${c.getString("viewport")} ${c.getString("view")}"
            assertEquals(c.getInt("onScreen"), cluster.onScreen, "$where on screen")
            assertEquals(want.size, list.size, "$where counters")
            var sum = 0
            for ((i, w) in want.withIndex()) {
                val got = list[i]
                assertEquals(w.getInt(0), got.n, "$where #$i n"); sum += got.n
                close(w.getDouble(1), got.px, "$where #$i px"); close(w.getDouble(2), got.py, "$where #$i py")
                assertEquals(w.getDouble(3), got.w, "$where #$i w")
                close(w.getDouble(4), got.u, "$where #$i u"); close(w.getDouble(5), got.v, "$where #$i v")
                assertEquals(w.getInt(6) == 1, got.mine, "$where #$i mine")
                counters++
            }
            assertEquals(cluster.onScreen, sum, "$where: the counts add up to the bases on screen")
            cases++; c = c.next
        }
        assertEquals(g.getInt("count"), cases)
        assertTrue(counters > 0)
    }
}
