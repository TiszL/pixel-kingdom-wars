package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBandRules
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBand
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmCamera
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGlRig
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMeta
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackFiles
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPick
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPickResult
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmWebPin
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePack
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePixelFill
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneUploads
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor

/**
 * What a tap on the realm map selects, composed end to end and held to the pinned web engine (`tools/world-pick-golden.mjs`,
 * GLOBE-NATIVE-PLAN §7): map.js `pick()` asks BASES first (a keep or marker-icon rect, the one nearest the viewer, then a
 * shield dome's ground ellipse) and only then the deed cell (a kingdom on it, else an open deed of this realm, else nothing).
 * Here the native pair the engine's `onTap` runs in that order — [BasesLane.pickBase], then [RealmPick.pick] — answers every
 * golden point: a grid over the Seeker screen plus probes a quarter px either side of every tap-region edge the web found.
 *
 * Why it matters: the owner taps kingdoms to open their card. A keep rect built from different ink boxes, a keep scale or a
 * dome radius off by a pixel, or the deed cell asked before BASES, opens the wrong kingdom or none, and the piecewise tests
 * (the rule table, one keep tap, the deed-cell golden) each pass while the composed tap is wrong. The keep art is the real
 * pinned `keeps.png` (hash-checked); the realm around it is the golden's synthetic grid, mask and kingdoms.
 */
class ComposedPickGoldenTest {
    private val g: JsonValue = JsonReader().parse(resource(GOLDEN).toString(Charsets.UTF_8))
    private val t = DecorTables.load()
    private val game = DecorGame.fromCatalogue(GoldenKit.catalogue())
    private val plots = RealmEngineWiring.plots(game.claimTilesByKeep, game.wallRingsByKeep, game.tilesPerDeed)
    private val decor = Decor(t, game, plots)
    private val rules = RealmBandRules(RealmWebPin.CONFIG.bands, RealmWebPin.DEED_ART)

    private fun resource(name: String): ByteArray =
        checkNotNull(javaClass.getResourceAsStream("/world/pickbases/$name")) { "/world/pickbases/$name is missing: run node tools/world-pick-golden.mjs --source ~/Desktop/SHARDKEEP-globe" }
            .use { it.readBytes() }

    /** The realm's pack as BASES reads it: the real shared keeps atlas (pinned by the golden's hashes) and a realm.json. */
    private inner class Pack(realmId: String, cols: Int, rows: Int) : RealmPackFiles {
        private val files = HashMap<String, ByteArray>()
        private val sha = HashMap<String, String>()
        init {
            for (f in KEEPS) { files["realm/shared/$f"] = resource(f); sha["realm/shared/$f"] = g.get("files").getString(f) }
            files["realm/$realmId/realm.json"] = "{\"grid\":{\"cols\":$cols,\"rows\":$rows}}".toByteArray()
        }
        override fun read(path: String): ByteArray? = files[path]
        override fun expectedSha256(path: String): String? = sha[path]
    }

    /** The worker side of the lane's fresh uploads on the fake: filled at once, adopted on [poll]. */
    private class Uploads(private val worker: FakeGl3) : LaneUploads {
        private val pending = ArrayList<Triple<Gl3Texture, Int, Long>>()
        override fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                           sampling: Gl3Sampling, wrap: Gl3Wrap, fill: LanePixelFill): Gl3Texture? {
            val texture = core.reserve(pool, array, width, height, layers, format, levels) ?: return null
            val name = worker.genTexture(); val target = if (array) GL30.GL_TEXTURE_2D_ARRAY else GL20.GL_TEXTURE_2D
            worker.bindTexture(target, name)
            if (array) worker.texStorage3D(target, levels, format.internal, width, height, layers) else worker.texStorage2D(target, levels, format.internal, width, height)
            for (layer in 0 until layers) for (level in 0 until levels) {
                val w = maxOf(1, width shr level); val h = maxOf(1, height shr level)
                fill.fill(layer, level, w, h, ByteBuffer.allocateDirect(w * h * format.bytesPerTexel).order(ByteOrder.nativeOrder()))
            }
            pending += Triple(texture, name, worker.fenceSync())
            return texture
        }
        fun poll(core: Gl3Core) { for ((tx, n, f) in pending) core.adopt(tx, n, f); pending.clear() }
    }

    private object Now : Executor { override fun execute(command: Runnable) = command.run() }

    /** One realm of the golden on the lane: loaded, its kingdoms set, ready to be looked at from each golden camera. */
    private inner class Rig(val realmId: String) {
        val realm: JsonValue = g.get("realm")
        val cols = realm.getInt("cols"); val rows = realm.getInt("rows")
        val grid = RealmGrid(realm.getInt("x0"), realm.getInt("y0"), cols, rows, RealmWebPin.CONFIG.deedDeg)
        val mask = ByteArray(cols * rows) { realm.get("mask").getInt(it).toByte() }
        val rig = RealmGlRig()
        val uploads = Uploads(rig.worker)
        var now = 1000.0
        val lane = BasesLane(rig.core, t, decor, BasesBandsIn.fromGenerated(), LanePack(Pack(realmId, cols, rows)) { _, _ -> null }, uploads, null, BasesRules.MsClock { now })
        val bases = RealmBases(plots)
        val view = RealmView()
        val open = RealmOpen(realmId, RealmMeta(realmId, realmId, "ready", null, grid.x0, grid.y0, cols, rows, cols * rows, emptyMap(),
            "chart8.webp", -1, -1, "deeds.png", 255, 96), grid, mask, ByteArray(cols * rows), floatArrayOf(0.1f, 0.2f, 0.4f),
            RealmLoader(object : RealmPackFiles { override fun read(path: String): ByteArray? = null }) { _, _ -> null },
            Now, 1, Runnable { }, bases, plots, RealmWebPin.CONFIG)
        val ids: IntArray

        init {
            bases.reset(cols, rows)
            val list = realm.get("bases"); val n = list.size
            ids = IntArray(n) { list.get(it).getInt(0) }
            val flags = IntArray(n) { val r = list.get(it); RealmBases.FLAG_OCCUPIED or (if (r.getInt(4) == 1) RealmBases.FLAG_MINE else 0) or (if (r.getInt(5) == 1) RealmBases.FLAG_SHIELD else 0) }
            bases.set(WorldBases(1, realmId, IntArray(n) { list.get(it).getInt(1) }, IntArray(n) { list.get(it).getInt(2) }, IntArray(n) { list.get(it).getInt(3) }, flags))
            assertEquals("every golden kingdom is on its own deed", n, bases.size)
            for (i in 0 until n) {
                assertEquals("kingdom $i keeps the golden order", list.get(i).getInt(1), bases.deedX[i]); assertEquals(list.get(i).getInt(2), bases.deedY[i])
                assertEquals("kingdom $i: the web seeds it by its catalog tile id, so must the lane", ids[i], grid.tileId(bases.deedX[i], bases.deedY[i]))
            }
            lane.open(open); repeat(3) { frame() }
            lane.basesChanged(bases)
        }

        /** The engine's `fillView` for camera [cam] (RealmMapEngine), at the device buffer of that viewport. */
        fun look(cam: RealmCamera, dpr: Double) {
            view.x = cam.x; view.y = cam.y; view.s = cam.s; view.dpr = dpr; view.d = cam.d
            view.viewW = cam.viewW; view.viewH = cam.viewH
            view.targetW = Math.round(cam.viewW * dpr).toInt(); view.targetH = Math.round(cam.viewH * dpr).toInt()
            rules.bands(cam.d, view.bands); view.bandSet = RealmBand.set(view.bands.band)
            view.rectX0 = cam.rectX0(); view.rectY0 = cam.rectY0(); view.rectX1 = cam.rectX1(); view.rectY1 = cam.rectY1()
            view.cols = cols; view.rows = rows; view.gridX0 = grid.x0; view.gridY0 = grid.y0
            view.workAllowed = true; view.uploadBytesLeft = 256 * 1024L
        }

        fun frame() {
            rig.compiler.runAll(); uploads.poll(rig.core)
            now += 16.7; rig.nowMs += 16.7
            check(rig.begin())
            lane.update(view)
            rig.core.beginScreen(0f, 0f, 0f, 1f)
            for (pass in PASSES) lane.draw(view, pass)
            rig.end()
        }
    }

    @Test fun `a tap selects the same kingdom or deed as the web, at every golden point, from MAP marker icons to the TRUE pixel snap`() {
        val rigs = HashMap<String, Rig>(); val result = RealmPickResult()
        val ready = g.get("ready")
        val mismatches = ArrayList<String>(); var bad = 0; var points = 0; var laneHits = 0; var trueViews = 0; val bandsSeen = HashSet<Int>()
        var v = g.get("views").child
        while (v != null) {
            val id = v.getString("realm")
            val r = rigs.getOrPut(id) { Rig(id) }
            val w = v.getDouble("W"); val h = v.getDouble("H"); val dpr = v.getDouble("dpr"); val cs = v.get("cam").asDoubleArray()
            val cam = RealmCamera(rules) { 0.0 }
            cam.setViewport(w, h, dpr); cam.setGrid(r.cols, r.rows); cam.set(cs[0], cs[1], cs[2])
            val where = "$id ${v.getString("viewport")} d ${v.getDouble("d")} at ${v.getString("centre")}"
            assertEquals("$where: camera x", cs[0], cam.x, 0.0); assertEquals("$where: camera y", cs[1], cam.y, 0.0); assertEquals("$where: camera s", cs[2], cam.s, 0.0)
            r.look(cam, dpr)
            repeat(4) { r.frame() }
            assertEquals("$where: BASES loads only where the web's does (kit dressing)", ready.getBoolean(id), r.lane.stats.loaded)
            if (v.getDouble("d") >= RealmWebPin.CONFIG.bands.trueFull) trueViews++
            bandsSeen += r.view.bandSet
            val nx = v.get("grid").getInt("nx"); val ny = v.get("grid").getInt("ny"); val probes = v.get("probes").asDoubleArray(); val codes = v.get("codes").asIntArray()
            assertEquals("$where: one code per point", nx * ny + probes.size / 2, codes.size)
            for (k in codes.indices) {
                val sx: Double; val sy: Double
                if (k < nx * ny) { sx = (k % nx + 0.5) * w / nx; sy = (k / nx + 0.5) * h / ny } else { sx = probes[2 * (k - nx * ny)]; sy = probes[2 * (k - nx * ny) + 1] }
                val b = r.lane.pickBase(r.view, sx, sy)
                val got = if (b in 0 until r.bases.size) { laneHits++; b } else {
                    RealmPick.pick(cam, r.bases, r.mask, 255, sx, sy, result)
                    when (result.kind) {
                        RealmPickResult.BASE -> CELL + result.base
                        RealmPickResult.OPEN -> OPEN + result.deedY * r.cols + result.deedX
                        else -> -1
                    }
                }
                if (got != codes[k]) { bad++; if (mismatches.size < 40) mismatches += "$where point $k (${"%.4f".format(sx)}, ${"%.4f".format(sy)}): web ${describe(codes[k])}, native ${describe(got)}" }
                points++
            }
            v = v.next
        }
        assertEquals("composed picks differing from the web (first ${mismatches.size} of $bad):\n${mismatches.joinToString("\n")}", 0, bad)
        assertEquals("100 % of the golden points compared", g.getInt("count"), points)
        // the defect's bar: TRUE d 1400 and the d 3136 snap, both Seeker viewports, 3 centres each (an undressed realm adds more)
        assertTrue("TRUE views at d 1400 and the snap on both viewports: $trueViews", trueViews >= 12)
        assertTrue("MAP and TRUE bands both ran: $bandsSeen", bandsSeen.containsAll(listOf(1, 2)))
        assertTrue("taps landed on keeps, icons and domes, not only on deeds: $laneHits", laneHits >= 1000)
    }

    @Test fun `the golden was computed over the keeps atlas this test reads, at the renderer's pin`() {
        for (f in KEEPS) assertEquals("$f is the pinned pack file", g.get("files").getString(f), RealmLoader.sha256Hex(resource(f)))
        assertEquals("the golden's pin is the one the renderer's shaders and tables come from", gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.PIN, g.getString("pin"))
        // the transcribed tap order is map.js's own text at the pin (the generator refuses otherwise); BASES before the deed cell
        val order = g.getString("mapPick")
        assertTrue(order.indexOf("basesMod?.pick?.") in 0 until order.indexOf("R.byCell.get"))
        assertTrue(order.indexOf("R.byCell.get") < order.indexOf("DEED_PX.thisRealm"))
    }

    /**
     * This golden composes [BasesLane.pickBase] then [RealmPick.pick] by hand; the engine's own tap must run that order,
     * or the 100 % match above holds for a composition the owner's finger never reaches (map.js pick(): BASES first).
     */
    @Test fun `the engine's tap asks the lanes' BASES pick before the deed cell, the order this golden composes`() {
        val src = File("src/main/kotlin/gg/pixelkingdomwars/nativeclient/renderer/realmmap/RealmMapEngine.kt").readText()
        val start = src.indexOf("override fun onTap(sx: Double, sy: Double)")
        assertTrue("RealmMapEngine.onTap(sx, sy) exists", start >= 0)
        val tap = src.substring(start, src.indexOf("\n    }\n", start))
        val lane = tap.indexOf(".pickBase(view, sx, sy)"); val cell = tap.indexOf("RealmPick.pick(")
        assertTrue("onTap asks each lane's pickBase ($lane) before RealmPick.pick ($cell)", lane in 0 until cell)
    }

    private fun describe(c: Int): String = when {
        c < 0 -> "nothing"
        c < CELL -> "kingdom $c (BASES rect or dome)"
        c < OPEN -> "kingdom ${c - CELL} (its deed cell)"
        else -> "open deed ${c - OPEN}"
    }

    companion object {
        private const val GOLDEN = "pick-bases.json"
        private val KEEPS = listOf("keeps.json", "keeps.png")
        private const val CELL = 100000
        private const val OPEN = 200000
        /** The engine's sprite passes in map.js order (BASES has no air pass). */
        private val PASSES = intArrayOf(RealmLane.PASS_SHADOW, RealmLane.PASS_SHIELD_BACK, RealmLane.PASS_SPRITE, RealmLane.PASS_SHIELD_FRONT, RealmLane.PASS_FX)
    }
}
