package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGlRig
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMeta
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.MemoryProbe
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.QueuedExecutor
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealWorld
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.DirectExecutor
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackFiles
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmWebPin
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RgbaImage
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.GoldenKit
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePack
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePixelFill
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneUploads
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.management.ManagementFactory
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor

/**
 * The BASES lane on the GL core (FakeGl3): what a player sees of every kingdom at each band, the tap, the dome caps, the
 * band rehearsal and a steady frame's cost. Why it matters: the owner's "needs some finishing to see bases" is exactly
 * this lane — a realm whose kingdoms stay dots at MAP, whose keeps cannot be tapped, or whose first MAP frame builds its
 * pipelines (the RM-GPU-1 freeze) fails the player even though the layouts are golden-equal to the web.
 */
class BasesLaneTest {
    private val t = DecorTables.load()
    private val game = DecorGame.fromCatalogue(GoldenKit.catalogue())
    private val plots = RealmEngineWiring.plots(game.claimTilesByKeep, game.wallRingsByKeep, game.tilesPerDeed)
    private val decor = Decor(t, game, plots)

    /** A synthetic realm pack BASES loads (the real packs live outside the repo): shared keeps and decor atlases with
     *  every keep level and every game sprite, the realm's smoke sprite and ROAD tiles. All hash-pinned. */
    private class Pack(t: DecorTables) : RealmPackFiles {
        val files = HashMap<String, ByteArray>(); val images = HashMap<String, RgbaImage>()
        private fun img(w: Int, h: Int, ink: (Int, Int) -> Boolean): RgbaImage =
            RgbaImage(w, h, ByteArray(w * h * 4) { i -> val p = i / 4; val x = p % w; val y = p / w; if (i % 4 == 3) (if (ink(x, y)) 255 else 0).toByte() else ((x * 7 + y * 3 + i % 4 * 50) and 255).toByte() })
        private fun put(path: String, bytes: ByteArray) { files[path] = bytes }
        private fun image(path: String, key: String, im: RgbaImage) { images[key] = im; put(path, "image:$key".toByteArray()) }
        fun sha(path: String) = RealmLoader.sha256Hex(files.getValue(path))
        init {
            // keeps: one 96×128 frame per level, ink 58×82 (anchor at the foot)
            image("realm/shared/keeps.webp", "keeps.webp", img(20 * 96, 128) { x, y -> x % 96 in 20..75 && y in 40..119 })
            put("realm/shared/keeps.json", ("{\"atlas\":\"keeps.webp\",\"levels\":[" +
                (1..20).joinToString(",") { "{\"level\":$it,\"x\":${(it - 1) * 96},\"y\":0,\"w\":96,\"h\":128,\"frames\":1,\"ax\":48,\"ay\":120}" } + "]}").toByteArray())
            // decor: every game sprite, one frame each, ink in its middle
            val keys = t.gameArt.keys.sorted(); var x = 0; var h = 1; val rects = StringBuilder()
            for (k in keys) { val a = t.gameArt.getValue(k); if (rects.isNotEmpty()) rects.append(','); rects.append("\"$k\":{\"x\":$x,\"y\":0,\"w\":${a[0]},\"h\":${a[1]},\"frames\":1,\"anchor\":[${a[2]},${a[1]}]}"); x += a[0]; h = maxOf(h, a[1]) }
            val xs = IntArray(keys.size + 1); run { var o = 0; for ((i, k) in keys.withIndex()) { xs[i] = o; o += t.gameArt.getValue(k)[0] }; xs[keys.size] = o }
            image("realm/shared/decor.webp", "decor.webp", img(x, h) { px, py ->
                var i = 0; while (xs[i + 1] <= px) i++
                val a = t.gameArt.getValue(keys[i]); val lx = px - xs[i]; lx in a[0] / 4 until a[0] * 3 / 4 && py in a[1] / 3 until a[1] - 2 })
            put("realm/shared/decor.json", "{\"atlas\":\"decor.webp\",\"sprites\":{$rects}}".toByteArray())
            // the realm: a smoke sprite and two ROAD tiles
            image("realm/crownlands/spr.webp", "spr.webp", img(48, 24) { px, py -> px % 16 in 5..10 && py in 4..20 })
            image("realm/crownlands/ground.webp", "ground.webp", img(64, 32) { _, _ -> true })
            put("realm/crownlands/realm.json", ("{\"grid\":{\"cols\":24,\"rows\":16},\"wind\":{\"artPxPerSec\":[2,0]}," +
                "\"files\":{\"spr.webp\":{\"sha256\":\"${sha("realm/crownlands/spr.webp")}\"},\"ground.webp\":{\"sha256\":\"${sha("realm/crownlands/ground.webp")}\"}}," +
                "\"sprites\":{\"atlas\":\"spr.webp\",\"rects\":{\"smoke_drift\":{\"x\":0,\"y\":0,\"w\":16,\"h\":24,\"frames\":3,\"dx\":16}}}," +
                "\"true\":{\"atlas\":{\"file\":\"ground.webp\",\"cell\":32,\"cols\":2},\"classToTerrain\":{\"ROAD\":\"road\"},\"terrains\":[{\"id\":\"road\",\"pureLayers\":[0,1]}]}}").toByteArray())
            // stage B, Solana Reach: its chimney sprite is vapour_drift (the kit has no smoke_drift); its ROAD terrain has 2 pure
            // layers and its crystaldust worn track 4 (DECOR_LAYOUT.track); palette.kit.ground names a crystaldust swatch that
            // differs from palette.road and from the table's soil path, so the test can tell which one the path took
            image("realm/seeker-reach/sr-spr.webp", "sr-spr.webp", img(64, 24) { px, py -> px % 16 in 5..10 && py in 4..20 })
            image("realm/seeker-reach/sr-ground.webp", "sr-ground.webp", img(96, 64) { _, _ -> true })
            put("realm/seeker-reach/realm.json", ("{\"grid\":{\"cols\":24,\"rows\":16},\"wind\":{\"artPxPerSec\":[2,0]}," +
                "\"files\":{\"sr-spr.webp\":{\"sha256\":\"${sha("realm/seeker-reach/sr-spr.webp")}\"},\"sr-ground.webp\":{\"sha256\":\"${sha("realm/seeker-reach/sr-ground.webp")}\"}}," +
                "\"palette\":{\"road\":\"#3a4568\",\"kit\":{\"ground\":{\"road\":\"#3a4568\",\"crystaldust\":\"$SOLANA_TRACK\"}}}," +
                "\"sprites\":{\"atlas\":\"sr-spr.webp\",\"rects\":{\"vapour_drift\":{\"x\":0,\"y\":0,\"w\":16,\"h\":24,\"frames\":4,\"dx\":16}}}," +
                "\"true\":{\"atlas\":{\"file\":\"sr-ground.webp\",\"cell\":32,\"cols\":3},\"classToTerrain\":{\"ROAD\":\"road\",\"FIELD\":\"crystaldust\"}," +
                "\"terrains\":[{\"id\":\"road\",\"pureLayers\":[0,1]},{\"id\":\"crystaldust\",\"pureLayers\":[2,3,4,5]}]}}").toByteArray())
        }
        /** Runs before every read (a test's hook into the worker's load). */
        var onRead: (String) -> Unit = {}
        override fun read(path: String): ByteArray? { onRead(path); return files[path] }
        override fun expectedSha256(path: String): String? = files[path]?.let { RealmLoader.sha256Hex(it) }
    }

    /** The worker side of the lane's fresh uploads on the fake: filled at once, or ([defer]) only at the next [poll] as
     *  the real uploader's decode thread does some frames later; adopted on [poll]. [sums] hashes every texture's texels. */
    private class Uploads(private val worker: FakeGl3, private val defer: Boolean = false) : LaneUploads {
        private val pending = ArrayList<Triple<Gl3Texture, Int, Long>>()
        private val later = ArrayList<() -> Unit>()
        val sums = ArrayList<Long>()
        override fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                           sampling: Gl3Sampling, wrap: Gl3Wrap, fill: LanePixelFill): Gl3Texture? {
            val texture = core.reserve(pool, array, width, height, layers, format, levels) ?: return null
            val run = {
                val name = worker.genTexture(); val target = if (array) GL30.GL_TEXTURE_2D_ARRAY else GL20.GL_TEXTURE_2D
                worker.bindTexture(target, name)
                if (array) worker.texStorage3D(target, levels, format.internal, width, height, layers) else worker.texStorage2D(target, levels, format.internal, width, height)
                var sum = 0L
                for (layer in 0 until layers) for (level in 0 until levels) {
                    val w = maxOf(1, width shr level); val h = maxOf(1, height shr level)
                    val out = ByteBuffer.allocateDirect(w * h * format.bytesPerTexel).order(ByteOrder.nativeOrder())
                    fill.fill(layer, level, w, h, out)
                    for (i in 0 until out.capacity()) sum = sum * 31 + out.get(i)
                }
                sums += sum
                pending += Triple(texture, name, worker.fenceSync())
            }
            if (defer) later += run else run()
            return texture
        }
        fun poll(core: Gl3Core) { for (r in later) r(); later.clear(); for ((tx, n, f) in pending) core.adopt(tx, n, f); pending.clear() }
    }

    private object Now : Executor { override fun execute(command: Runnable) = command.run() }
    private companion object { const val SOLANA_TRACK = "#123456" }
    /** The engine's sprite passes in map.js order (no air pass: BASES has none). */
    private val PASSES = intArrayOf(RealmLane.PASS_SHADOW, RealmLane.PASS_SHIELD_BACK, RealmLane.PASS_SPRITE, RealmLane.PASS_SHIELD_FRONT, RealmLane.PASS_FX)

    /** [decoded]: every image read decodes afresh (as the app's decoder does) and is tracked weakly; [executor] runs the
     *  load (at once by default); [deferFills]: the uploader fills textures only at the next poll; [markers]: the web's
     *  marker look (bases.js as pinned) instead of the native tag-only map range (D-NEXT). */
    private inner class Rig(val pack: RealmPackFiles = Pack(t), val classes: gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.RealmClasses? = null,
                            val realm: String = "crownlands", val decoded: MemoryProbe.Decoded? = null, private val executor: Executor = Now,
                            deferFills: Boolean = false, markers: Boolean = false) {
        val rig = RealmGlRig()
        val uploads = Uploads(rig.worker, deferFills)
        var now = 1000.0
        val lanePack = LanePack(pack) { _, key ->
            (pack as? Pack)?.images?.get(key)?.let { im -> if (decoded == null) im else RgbaImage(im.width, im.height, im.rgba.copyOf()).also { decoded.track(it.rgba) } }
        }
        val lane = BasesLane(rig.core, t, decor, BasesBandsIn.fromGenerated(), lanePack, uploads, classes, BasesRules.MsClock { now }, markers = markers)
        val bases = RealmBases(plots)
        val view = RealmView()
        var wakes = 0
        /** The engine's open of this realm; [gen] bumps on every open (a realm change, a context restore). */
        fun openAt(gen: Int) = RealmOpen(realm, RealmMeta(realm, realm, "ready", null, 0, 0, 24, 16, 24 * 16, emptyMap(),
            "chart8.webp", -1, -1, "deeds.png", 255, 96), RealmGrid(0, 0, 24, 16, 0.5), ByteArray(24 * 16) { 255.toByte() }, ByteArray(24 * 16),
            floatArrayOf(0.1f, 0.2f, 0.4f), RealmLoader(object : RealmPackFiles { override fun read(path: String): ByteArray? = null }) { _, _ -> null },
            executor, gen, Runnable { wakes++ }, bases, plots, RealmWebPin.CONFIG)
        val open = openAt(1)
        /** Pixel bytes the lane's own graph reaches (what it was given is not counted: the pack, the tables, the engine's
         *  bases and its wake hook, here this rig; its per-base settle flags are one byte per kingdom, not pixels, and
         *  there are no kingdoms in these checks). */
        fun heldPixels(): Long = MemoryProbe.pixelBytes(lane, MemoryProbe.stopAt(lanePack, t, decor, classes, uploads, bases, this))
        fun holders(): List<String> = MemoryProbe.pixelHolders(lane, MemoryProbe.stopAt(lanePack, t, decor, classes, uploads, bases, this))

        init {
            bases.reset(24, 16)
            view.targetW = 2400; view.targetH = 2400; view.dpr = 2.0; view.cols = 24; view.rows = 16
            view.viewW = 1200.0; view.viewH = 1200.0; view.workAllowed = true; view.uploadBytesLeft = 256 * 1024L
        }

        /** Kingdoms on every deed of x 4..19, y 4..11 (levels 1..20 cycling); yours at (12, 8); [shield] marks them all. */
        fun populate(shield: Boolean) {
            val xs = ArrayList<Int>(); val ys = ArrayList<Int>(); val lv = ArrayList<Int>(); val fl = ArrayList<Int>()
            for (y in 4..11) for (x in 4..19) {
                xs += x; ys += y; lv += 1 + (x * 7 + y * 3) % 20
                var f = RealmBases.FLAG_OCCUPIED
                if (x == 12 && y == 8) f = f or RealmBases.FLAG_MINE
                if (shield) f = f or RealmBases.FLAG_SHIELD
                fl += f
            }
            bases.set(WorldBases(1, realm, xs.toIntArray(), ys.toIntArray(), lv.toIntArray(), fl.toIntArray()))
            lane.basesChanged(bases)
        }

        fun look(x: Double, y: Double, d: Double) {
            view.x = x; view.y = y; view.d = d; view.s = d / view.dpr
            val hw = view.targetW / d / 2; val hh = view.targetH / d / 2
            view.rectX0 = x - hw; view.rectX1 = x + hw; view.rectY0 = y - hh; view.rectY1 = y + hh
        }

        fun frame(build: Boolean = true) {
            if (build) { rig.compiler.runAll(); uploads.poll(rig.core) }
            now += 16.7; rig.nowMs += 16.7
            check(rig.begin())
            lane.update(view)
            rig.core.beginScreen(0f, 0f, 0f, 1f)
            rig.core.enable(GL20.GL_DEPTH_TEST); rig.core.depthFunc(GL20.GL_LEQUAL)
            for (pass in PASSES) lane.draw(view, pass)
            rig.end()
        }

        /** The engine's band rehearsal for every BASES program in one frame (screen-format scratch with depth). */
        fun rehearseAll(): Map<String, Boolean> {
            val out = LinkedHashMap<String, Boolean>()
            now += 16.7; rig.nowMs += 16.7; check(rig.begin())
            val screen = rig.core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.RGB8)!!; val depth = rig.core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.DEPTH16)!!
            for (p in lane.programs()) { var ok = false; rig.core.rehearse(screen, depth, true, false) { ok = lane.rehearse(p, RealmMapEngine.TARGET_SCREEN, view) }; out[p.name] = ok }
            rig.end()
            return out
        }

        fun openAndLoad() { lane.open(open); repeat(3) { frame() } }

        /** One frame whose FX pass is counted apart: the sprite program's draws there are the chimney smoke (BASES_GL smoke). */
        fun smokeDraws(): Int {
            now += 16.7; rig.nowMs += 16.7
            check(rig.begin())
            lane.update(view)
            rig.core.beginScreen(0f, 0f, 0f, 1f)
            rig.core.enable(GL20.GL_DEPTH_TEST); rig.core.depthFunc(GL20.GL_LEQUAL)
            for (pass in PASSES) if (pass != RealmLane.PASS_FX) lane.draw(view, pass)
            val sprite = lane.programs().first { it.name == "bases-sprite" }.handle
            val n0 = rig.gl.draws.size
            lane.draw(view, RealmLane.PASS_FX)
            val n = rig.gl.draws.subList(n0, rig.gl.draws.size).count { it.program == sprite }
            rig.end()
            return n
        }
        fun settle(n: Int = 60) { repeat(n) { frame() } }
    }

    @Test fun everyBasesGlStateIsRehearsedFromTheProgramsAloneAndTheFrameViewBindingSurvives() {
        // a pack whose realm.json is missing: the art never loads, yet the pipelines of every band must be built (W1 B1)
        val r = Rig(object : RealmPackFiles { override fun read(path: String): ByteArray? = null })
        r.lane.open(r.open); repeat(3) { r.frame() }
        assertTrue("the lane settled with its failure: ${r.lane.stats.why}", r.lane.settled())
        assertEquals(listOf("bases-sprite", "bases-shield", "bases-fx", "bases-field", "bases-dot"), r.lane.programs().map { it.name })
        val pairs0 = r.rig.core.drawnPairs().size
        val d0 = r.lane.stats.rehearsalDraws
        val ok = r.rehearseAll()
        assertTrue("every program rehearsed: $ok", ok.values.all { it })
        // BASES_GL: sprite ×2 (sprite, smoke), shield ×2 (back, front), fx ×2 (pennant, glow), field, dot = 8 draws, 8 pairs
        assertEquals(t.basesGl.size.toLong(), r.lane.stats.rehearsalDraws - d0)
        assertEquals(t.basesGl.size, r.rig.core.drawnPairs().size - pairs0)
        // the rehearsal view sat on its own binding: every program's RealmView block is back on the frame's binding 0
        for (p in r.lane.programs()) assertEquals(p.name, BasesLane.VIEW_BINDING, r.rig.group.program(p.handle)!!.blockBinding)
        assertFalse("no live frame is drawn without art", r.lane.drawsBases(r.view))
    }

    /**
     * A kingdom per zoom: a dot on the D-177 landing, the same dot through the map range (under the HUD's name tag, never
     * bases.js's castle icon), then its live keep with the MAP minis and tended ground, and the decor sprites at TRUE.
     * Rewritten for D-NEXT from "a marker icon at MAP". The owner rejected bases.js's castle icon on the Seeker
     * (2026-09-26, code 31): "keep is displayed very ugly on current screen, zoomed in base is much better ... on this
     * range only player profile picture and name should be visible, in efficient way". The dot stays because the HUD
     * places at most 16 tags and drops any that collide or touch the controls: without it such a kingdom vanished. The
     * web's icon path is still checked with markers on, in the next test.
     */
    @Test fun aKingdomIsItsDotFromFarThroughMapAndALiveKeepWithItsDecorFromItsHandOver() {
        val r = Rig(); r.openAndLoad(); r.populate(shield = false)
        assertTrue("the art loaded: ${r.lane.stats.why}", r.lane.stats.loaded)
        r.look(12.0, 8.0, 40.0); r.settle(3)
        assertTrue(r.lane.drawsBases(r.view))
        assertTrue("FAR draws dots", r.lane.stats.dots > 0); assertEquals(0, r.lane.stats.icons); assertEquals(0, r.lane.stats.keeps)
        r.look(12.0, 8.0, 100.0); r.settle(3)
        assertTrue("MAP (s 50) has kingdoms in view", r.lane.stats.visible > 0)
        assertEquals("MAP (s 50) draws no marker icon", 0, r.lane.stats.icons); assertEquals(0, r.lane.stats.keeps)
        assertEquals("MAP (s 50): every kingdom in view is its dot", r.lane.stats.visible, r.lane.stats.dots)
        r.look(12.0, 8.0, 400.0); r.settle(120) // the path network and the decor caches build under the frame budget
        assertTrue("the path network finished", r.lane.stats.pathsDone)
        assertTrue("MAP d 400 draws live keeps", r.lane.stats.keeps > 0); assertEquals(0, r.lane.stats.icons)
        assertTrue("MAP minis stand in for the decor", r.lane.stats.minis > 0); assertEquals(0, r.lane.stats.trues)
        assertTrue("tended ground (lanes, fields) under the kingdoms", r.lane.stats.groundCells > 0)
        r.look(12.0, 8.0, 1200.0); r.settle(60)
        assertTrue("TRUE draws the decor sprites", r.lane.stats.trues > 0); assertEquals(0, r.lane.stats.minis)
        val draws = r.rig.gl.draws.map { d -> r.lane.programs().first { it.handle == d.program }.name }.toSet()
        assertTrue("sprites, dots and the tended ground all drew: $draws", draws.containsAll(listOf("bases-sprite", "bases-dot", "bases-field")))
    }

    /**
     * Stage B fix pass (bases.js 090b3428, the owner-bar critic's "the keep icon at the top edge of its pad"): at MAP up to
     * d 150 a marker icon's ink is centred on its plot centre (where GROUND's clearing, the claim tint and the dome ring
     * are), and the tap rect and the selection pulse follow the drawn icon; a live keep keeps both on its seat. The curve
     * is golden-tested (BasesGoldenTest); this checks the lane draws, picks and rings by it. The pulse stands on the icon's
     * anchor, (ay − oy − h) icon px below the bottom of its tap rect (the same catalog entry, built from the same pack).
     * D-NEXT: natively the icon is not drawn, but its place stays. The tap rect matches the web's to the bit, so tapping
     * where the kingdom is still selects it. The pulse rings what is drawn: natively the kingdom's dot on its plot centre.
     * A ring on the hidden icon's anchor floats half an icon below the dot, around nothing (the REFIX review, code 31).
     */
    @Test fun aMarkerIsCentredOnItsPlotItsTapRectFollowsItDrawnOrHiddenAndItsPulseRingsWhatIsDrawn() {
        val placed = HashMap<Boolean, List<Double>>()
        for (markers in listOf(true, false)) {
            val r = Rig(markers = markers); r.openAndLoad()
            // your kingdom alone (a neighbour's icon to the south would overlap its foot and win the tap there, by depth)
            r.bases.set(WorldBases(1, "crownlands", intArrayOf(12), intArrayOf(8), intArrayOf(9), intArrayOf(RealmBases.FLAG_OCCUPIED or RealmBases.FLAG_MINE)))
            val mine = r.bases.mineIndex(); r.bases.select(mine); r.lane.basesChanged(r.bases)
            fun cssY(y: Double) = (y - r.view.y) * r.view.s + r.view.viewH / 2
            r.look(12.0, 8.0, 100.0); r.settle(3)
            if (markers) assertTrue("the web: MAP d 100 draws marker icons", r.lane.stats.icons > 0)
            else assertEquals("native: MAP d 100 draws no marker icon", 0, r.lane.stats.icons)
            assertEquals(0, r.lane.stats.keeps)
            val sx = (r.bases.plotX[mine] - r.view.x) * r.view.s + r.view.viewW / 2
            var y0 = Double.NaN; var y1 = Double.NaN; var y = 0.0
            while (y < r.view.viewH) { if (r.lane.pickBase(r.view, sx, y) == mine) { if (y0.isNaN()) y0 = y; y1 = y }; y += 0.125 }
            assertFalse("markers $markers: the marker of your kingdom is under the plot centre's column", y0.isNaN())
            assertEquals("markers $markers: the marker's ink is centred on its plot", cssY(r.bases.plotY[mine]), (y0 + y1) / 2, 0.25)
            val seat = 8 + (game.keepFootprint[1] / 2.0 + plots.plotCentre + plots.offsetY(12, 8, r.bases.level[mine])) / game.tilesPerDeed
            val ring = r.lane.selectionRing()
            assertEquals(8, ring.size)
            val ic = BasesLoad(t, decor, game).build(r.lanePack, "crownlands")!!.catalog.getValue("keep/l9").icon!!
            val cssPerIconPx = (y1 - y0) / ic.h // the icon's drawn scale, from its tap rect
            val anchor = y1 + (ic.ay - ic.oy - ic.h) * cssPerIconPx
            if (markers) {
                assertEquals("the web: the pulse stands on the icon's anchor", anchor, cssY(ring[1].toDouble()), 0.25)
                assertTrue("… which is not the keep seat at MAP d 100", Math.abs(cssY(ring[1].toDouble()) - cssY(seat)) > 2)
            } else {
                assertEquals("native: the dot is what MAP d 100 draws of your kingdom", 1, r.lane.stats.dots)
                assertEquals("native: the pulse rings your kingdom's dot, on its plot centre", cssY(r.bases.plotY[mine]), cssY(ring[1].toDouble()), 0.01)
                assertTrue("… not the hidden icon's anchor below it", Math.abs(cssY(ring[1].toDouble()) - anchor) > 2)
            }
            assertEquals(ring[1], ring[5], 0f)
            placed[markers] = listOf(y0, y1, ring[0].toDouble(), ring[2].toDouble())
            r.look(12.0, 8.0, 400.0); r.settle(10)
            assertTrue(r.lane.stats.keeps > 0)
            assertEquals("a live keep's pulse is on its seat", seat, r.lane.selectionRing()[1].toDouble(), 1e-6)
        }
        assertEquals("the hidden marker taps where the web's icon does, and its pulse is as wide and on the same column", placed[true], placed[false])
    }

    /**
     * D-NEXT, the map range in detail (owner 2026-09-26, Seeker code 31: "current keep display is extra not needed, on
     * this range only player profile picture and name should be visible, in efficient way"). From uiDots until its own
     * hand-over a kingdom draws no castle: no marker icon, no L12+ companion towers, no banner. Its mark is bases.js's
     * occupancy dot, one instanced draw for the realm, the same dot as on the D-177 landing. The dot stays because the
     * HUD's name tag cannot be the only mark: the HUD places at most 16 tags, drops one that overlaps a neighbour's (every
     * other kingdom along a row below s of about 80) or touches the controls, and names only the filtered kingdoms. With
     * 82c91fc all of those kingdoms vanished at map zoom (REFIX review, finding 1). Hiding the castle means not drawing it,
     * not alpha 0: the sprite and banner passes issue no draw call, the icon array is never uploaded, and a panning frame
     * allocates nothing. A tap on the kingdom still selects it. Shield domes (D-181) stand where the web stands them, over
     * the kingdoms bases.js draws as icons. A kingdom bases.js keeps as a dot below uiIcons gets no dome, only its dot's
     * halo, as on the web (finding 4: 82c91fc stood a dome over every one of them, at s 24 over nothing).
     */
    @Test fun inTheMapRangeEveryKingdomIsItsDotNeverTheCastleAndStaysTappable() {
        val r = Rig(); r.openAndLoad(); r.populate(shield = true)
        val web = Rig(markers = true); web.openAndLoad(); web.populate(shield = true)
        fun prog(name: String) = r.lane.programs().first { it.name == name }.handle
        val sprite = prog("bases-sprite"); val dot = prog("bases-dot"); val fx = prog("bases-fx"); val shield = prog("bases-shield")
        val mine = r.bases.mineIndex()
        val domes = HashMap<Double, Int>()
        // s 24 … 99.5 at dpr 2: the web's dot/icon dither (s < 48), every icon size and the ground's fade-in (d ≥ 150)
        for (d in doubleArrayOf(48.0, 60.0, 90.0, 150.0, 199.0)) {
            r.look(12.0, 8.0, d); r.settle(3); web.look(12.0, 8.0, d); web.settle(3)
            val n0 = r.rig.gl.draws.size; r.frame(build = false)
            val drawn = r.rig.gl.draws.subList(n0, r.rig.gl.draws.size).map { it.program }
            assertTrue("d=$d: more kingdoms in view than the HUD's 16 tags could ever name", r.lane.stats.visible > 16)
            assertEquals("d=$d: every kingdom in view is its dot", r.lane.stats.visible, r.lane.stats.dots)
            assertEquals("d=$d: the dots are one draw call", 1, drawn.count { it == dot })
            assertEquals("d=$d: no marker icon", 0, r.lane.stats.icons)
            assertEquals("d=$d: no keep", 0, r.lane.stats.keeps); assertEquals("d=$d: no banner", 0, r.lane.stats.fx)
            assertFalse("d=$d: no sprite draw call (icon, towers, keep)", sprite in drawn); assertFalse("d=$d: no banner draw call", fx in drawn)
            assertEquals("d=$d: domes stand where the web's do, never over a kingdom bases.js draws as a dot", web.lane.stats.domes, r.lane.stats.domes)
            if (r.lane.stats.domes > 0) assertTrue("d=$d: and they draw", shield in drawn)
            domes[d] = r.lane.stats.domes
            val sx = (r.bases.plotX[mine] - r.view.x) * r.view.s + r.view.viewW / 2; val sy = (r.bases.plotY[mine] - r.view.y) * r.view.s + r.view.viewH / 2
            val picked = r.lane.pickBase(r.view, sx, sy)
            // the web's pick at the same point: its icon rects are the hidden markers' and its domes the same; below s 45 a
            // deed is narrower than two markers (the neighbour in front may win, by depth), and a bases.js dot takes no tap
            // (-1: the core's deed pick decides)
            assertEquals("d=$d: a tap there picks what the web's does", web.lane.pickBase(web.view, sx, sy), picked)
            if (d >= 90) assertEquals("d=$d: a tap on your kingdom still selects it", mine, picked)
        }
        assertEquals("s 24: bases.js draws every kingdom as a dot, so there is no dome", 0, domes[48.0])
        assertTrue("from s 45 bases.js draws icons, and the shielded kingdoms keep their domes (D-181): $domes", domes.getValue(90.0) > 0 && domes.getValue(150.0) > 0)
        r.look(12.0, 8.0, 46.0); r.settle(3)
        assertTrue("the D-177 landing below uiDots keeps its dots", r.lane.stats.dots > 0)
        // the web's look at the same cameras, for contrast: bases.js draws castles, banners and dithered dots there
        web.look(12.0, 8.0, 60.0); web.settle(3)
        assertTrue("the web dithers dots and icons at s 30", web.lane.stats.dots > 0 && web.lane.stats.icons > 0)
        web.look(12.0, 8.0, 150.0); web.settle(3)
        assertTrue("the web draws icons and banners at d 150", web.lane.stats.icons > 0 && web.lane.stats.fx > 0)
        val iconLayers = BasesLoad(t, decor, game).build(r.lanePack, "crownlands")!!.icon.layers.size
        assertTrue(iconLayers > 0)
        assertEquals("natively the icon array is never uploaded", web.lane.stats.layers - iconLayers, r.lane.stats.layers)
        // a panning map-range frame allocates nothing on the GL thread (the hidden markers still place their tap rects)
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        assertTrue("this JVM cannot count allocations: the gate would prove nothing", bean.isThreadAllocatedMemorySupported)
        bean.isThreadAllocatedMemoryEnabled = true
        for (i in 0 until 60) { r.look(12.0 + (i % 3) * 0.001, 8.0, 120.0); r.frame(build = false) }
        r.rig.gl.record = false; r.rig.worker.record = false
        val tid = Thread.currentThread().id
        var best = Long.MAX_VALUE
        for (window in 0 until 5) {
            val before = bean.getThreadAllocatedBytes(tid)
            repeat(300) { i -> r.look(12.0 + (i % 3) * 0.001, 8.0, 120.0); r.frame(build = false) }
            best = minOf(best, bean.getThreadAllocatedBytes(tid) - before)
            if (best == 0L) break
        }
        assertEquals("a window of 300 panning map-range frames allocated $best bytes", 0L, best)
    }

    /**
     * SHARDKEEP D-191 (owner 2026-09-28, endorsing a player: "the sort keep level seems like not functioning, I still can
     * see all the keeps even though I sort to level 7-20"). A filter (MINE, a level range, UNSHIELDED …) HIDES the
     * kingdoms it drops, in every band: no dot at FAR or in the map range, no marker, no live keep, no minis, no smoke,
     * no dome. Before D-191 a dropped kingdom kept a dimmed dot (bases.js `bakeDim`; the rule this test replaced, "keeps
     * its dimmed dot but no lone dome"), which players read as the filter doing nothing. The deed is still occupied: its
     * claim's ground draws at TRUE like every other plot, so it never reads as open land. The one exception is the
     * selected kingdom, whose card is up on it: it draws, dome and all, whatever the filter says.
     */
    @Test fun aFilteredOutKingdomDrawsNothingInAnyBandUnlessItIsSelected() {
        val r = Rig(); r.openAndLoad(); r.populate(shield = true)
        r.look(12.0, 8.0, 400.0); r.settle(150) // the live band, unfiltered: the baseline every claim's ground is measured against
        val inView = r.lane.stats.visible
        assertTrue("kingdoms beyond yours are in view (not a vacuous pass)", inView > 1)
        assertEquals("baseline: every kingdom in view is a live keep", inView, r.lane.stats.keeps)
        val groundAll = r.lane.stats.groundCells; val minisAll = r.lane.stats.minis; val domesAll = r.lane.stats.domes
        assertTrue("baseline: claims on the ground and minis drawn", groundAll > 0 && minisAll > 0 && domesAll > 1)
        r.bases.applyFilter(WorldFilter(WorldFilterKind.MINE)); r.lane.basesChanged(r.bases)
        assertEquals("the filter shows your kingdom alone", 1, r.bases.filteredCount)
        for (d in doubleArrayOf(30.0, 100.0, 150.0, 199.0)) { // FAR (a dithered dot) and the map range (the D-NEXT dot)
            r.look(12.0, 8.0, d); r.settle(3)
            assertTrue("d=$d: filtered-out kingdoms in view", r.lane.stats.visible > 1)
            assertEquals("d=$d: only the kingdom the filter keeps has a dot", 1, r.lane.stats.dots)
            // the web's FAR dots carry no dome (dot and halo only); from the map range on, the kept kingdom's dome alone
            assertEquals("d=$d: only that kingdom stands a dome", if (r.view.s < BasesBandsIn.fromGenerated().uiDots) 0 else 1, r.lane.stats.domes)
        }
        r.look(12.0, 8.0, 400.0); r.settle(150)
        assertEquals("live band: kingdoms in view are the baseline's", inView, r.lane.stats.visible)
        assertEquals("live band: only your keep draws", 1, r.lane.stats.keeps)
        assertEquals("live band: its dome alone", 1, r.lane.stats.domes)
        assertTrue("live band: its minis alone (${r.lane.stats.minis} of $minisAll)", r.lane.stats.minis in 1 until minisAll)
        assertEquals("every claim stays on the ground: an occupied plot, never open land", groundAll, r.lane.stats.groundCells)
        // the selection is exempt: a filtered-out kingdom the player selected draws with its dome, and the filter is unchanged
        val other = (0 until r.bases.size).first { !r.bases.filtered[it] && r.bases.deedX[it] in 11..13 && r.bases.deedY[it] in 7..9 }
        r.bases.select(other); r.lane.basesChanged(r.bases)
        assertEquals("selecting does not change the filter", 1, r.bases.filteredCount)
        r.settle(3)
        assertEquals("live band: your keep and the selected one", 2, r.lane.stats.keeps)
        assertEquals("live band: both domes", 2, r.lane.stats.domes)
        r.look(12.0, 8.0, 150.0); r.settle(3)
        assertEquals("map range: your dot and the selected one", 2, r.lane.stats.dots)
        assertEquals("map range: both domes", 2, r.lane.stats.domes)
        r.bases.clearSelection(); r.lane.basesChanged(r.bases); r.settle(3)
        assertEquals("deselected: hidden again", 1, r.lane.stats.dots)
    }

    /**
     * The hand-over the HUD follows (D-NEXT): between IMPOSTOR[0] and IMPOSTOR[1] each kingdom turns from its tag alone
     * into its real base at its own d, and [BaseHandOver.drawsBase] must name exactly those kingdoms, from the same catalog
     * tile, seed and hashes. Otherwise a tag would lose its keep level over a drawn base, or show it over an empty plot.
     */
    @Test fun theHudsHandOverNamesExactlyTheKingdomsWhoseLiveKeepDraws() {
        val r = Rig(); r.openAndLoad(); r.populate(shield = false)
        r.view.targetW = 8000; r.view.targetH = 8000 // every kingdom of the realm in view
        val tile = (0 until r.bases.size).map { i -> r.bases.deedY[i] * RealmGrid.LATTICE_W + r.bases.deedX[i] }
        var mixed = 0
        for (d in doubleArrayOf(150.0, 199.0, 200.0, 215.0, 240.0, 265.0, 279.0, 280.0, 400.0)) {
            r.look(12.0, 8.0, d); r.settle(3)
            assertEquals("d=$d: every kingdom in view", r.bases.size, r.lane.stats.visible)
            val want = tile.count { BaseHandOver.drawsBase(it, r.view.s, d) }
            assertEquals("d=$d: the lane's live keeps are the HUD's", want, r.lane.stats.keeps)
            if (want in 1 until r.bases.size) mixed++
        }
        assertTrue("the band hands kingdoms over one by one (not a vacuous pass): $mixed cameras were mixed", mixed >= 3)
    }

    @Test fun aTapOnAKeepPicksItsKingdom() {
        val r = Rig(); r.openAndLoad(); r.populate(shield = false)
        r.look(12.0, 8.0, 400.0); r.settle(10)
        val mine = r.bases.mineIndex()
        // the keep seat of your kingdom, in CSS px: plot centre x, keep footprint's south edge minus a little
        val cx = r.bases.plotX[mine]; val seat = 8 + (game.keepFootprint[1] / 2.0 + plots.plotCentre + plots.offsetY(12, 8, r.bases.level[mine])) / game.tilesPerDeed
        val sx = (cx - r.view.x) * r.view.s + r.view.viewW / 2; val sy = (seat - r.view.y) * r.view.s + r.view.viewH / 2 - 4
        assertEquals(mine, r.lane.pickBase(r.view, sx, sy))
        assertEquals(-1, r.lane.pickBase(r.view, 2.0, 2.0)) // open sea at the corner: the core's deed pick decides
    }

    @Test fun shieldDomesAreCappedOnScreenWithYoursAmongThem() {
        val r = Rig(); r.openAndLoad(); r.populate(shield = true)
        r.look(12.0, 8.0, 400.0); r.settle(10)
        assertTrue(r.lane.stats.domes in 1..t.shieldMapCap)
        r.look(12.0, 8.0, 1200.0); r.settle(10)
        assertEquals("TRUE shows at most trueCap domes", t.shieldTrueCap, r.lane.stats.domes)
    }

    @Test fun aSteadyBasesFrameAllocatesNothingOnTheGlThread() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        assertTrue("this JVM cannot count allocations: the gate would prove nothing", bean.isThreadAllocatedMemorySupported)
        bean.isThreadAllocatedMemoryEnabled = true
        val r = Rig(); r.openAndLoad(); r.populate(shield = true)
        r.look(12.0, 8.0, 400.0); r.settle(150)
        for (i in 0 until 60) { r.look(12.0 + (i % 3) * 0.001, 8.0, 400.0); r.frame(build = false) } // warm: every cache built
        r.rig.gl.record = false; r.rig.worker.record = false
        val tid = Thread.currentThread().id
        var best = Long.MAX_VALUE
        for (window in 0 until 5) {
            val before = bean.getThreadAllocatedBytes(tid)
            repeat(300) { i -> r.look(12.0 + (i % 3) * 0.001, 8.0, 400.0); r.frame(build = false) } // a pan: every list rebuilt
            best = minOf(best, bean.getThreadAllocatedBytes(tid) - before)
            if (best == 0L) break
        }
        assertEquals("a window of 300 panning BASES frames allocated $best bytes", 0L, best)
    }

    @Test fun pathsBetweenKingdomsWaitForGroundsTerrainThenSettleOverIt() {
        // no terrain yet: the network builds, but no link is drawn (it would run straight over water)
        val dry = Rig(); dry.openAndLoad(); dry.populate(shield = false)
        dry.look(12.0, 8.0, 400.0); dry.settle(150)
        assertTrue(dry.lane.stats.pathsDone); assertTrue("kingdoms have neighbours to link", dry.lane.stats.links > 0)
        assertEquals(0, dry.lane.stats.linksSettled)
        // GROUND's classes arrive (land everywhere): the links in view settle and their path cells join the tended ground
        val land = object : gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.RealmClasses {
            override fun bindClasses(program: gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program, firstUnit: Int) = true
            override fun classAt(): ((Int, Int) -> Int)? = { _, _ -> 6 }
        }
        val r = Rig(classes = land); r.openAndLoad(); r.populate(shield = false)
        r.look(12.0, 8.0, 400.0); r.settle(150)
        assertTrue("links in view settled: ${r.lane.stats.linksSettled}", r.lane.stats.linksSettled > 0)
        assertEquals("no link dropped on dry land", 0, r.lane.stats.linksDropped)
        assertTrue("the paths add ground cells: ${r.lane.stats.groundCells} vs ${dry.lane.stats.groundCells}", r.lane.stats.groundCells > dry.lane.stats.groundCells)
    }

    private fun hex(h: String) = floatArrayOf(Integer.parseInt(h.substring(1, 3), 16) / 255f, Integer.parseInt(h.substring(3, 5), 16) / 255f, Integer.parseInt(h.substring(5, 7), 16) / 255f)

    /**
     * Stage B (bases.js aff798ad), Solana Reach's own kit: its chimneys breathe vapour_drift (`smokeIdOf`: it has no
     * smoke_drift), catalogued like smoke (no MAP mini, never a missing smoke_drift); its lanes and paths are painted with
     * its crystaldust worn track (`DECOR_LAYOUT.track`: 4 pure layers, where the obsidian ROAD has 2) in the kit's own
     * crystaldust swatch (`palette.kit.ground[track]`, ahead of `palette.road`). Why it matters: with the old fixed ids
     * Solana's kingdoms had no chimney smoke, a stray vapour mini and dark obsidian lanes through its crystal yards. The
     * web tests this on the real Solana pack; this synthetic one makes every alternative distinguishable. Crownlands
     * (no track, smoke_drift) must be unchanged.
     */
    @Test fun solanaReachBreathesVapourAndPavesItsLanesWithItsCrystaldustTrack() {
        val pack = Pack(t); val lp = LanePack(pack) { _, key -> pack.images[key] }
        val sr = BasesLoad(t, decor, game).build(lp, "seeker-reach")!!
        assertEquals("vapour_drift", t.smokeIdOf("seeker-reach"))
        val vapour = sr.catalog["kit:vapour_drift"]
        assertTrue("the vapour sprite is catalogued: ${sr.missing.take(8)}", vapour != null)
        assertEquals("a drifting puff has no MAP mini (noMini, like smoke_drift)", null, vapour!!.mini)
        assertFalse("Solana never wants a smoke_drift: ${sr.missing.filter { "smoke" in it }}", sr.missing.contains("kit:smoke_drift"))
        val road = sr.road!!
        assertEquals("the crystaldust track's pure layers, not ROAD's", 4, road.layers.size)
        val ground = pack.images.getValue("sr-ground.webp")
        for (i in 0 until 4) assertTrue("road layer $i is crystaldust pure layer ${2 + i}",
            road.layers[i][0].contentEquals(BasesPixels.crop(ground.rgba, ground.width, ground.height, ((2 + i) % 3) * 32, ((2 + i) / 3) * 32, 32, 32)))
        assertTrue("the path colour is the kit's crystaldust swatch: ${sr.soil!!.toList()}", sr.soil!!.copyOfRange(6, 9).contentEquals(hex(SOLANA_TRACK)))
        assertTrue("field and pen keep the table's soil", sr.soil!!.copyOfRange(0, 6).contentEquals(hex(t.layout.soil.getValue("seeker-reach")[0]) + hex(t.layout.soil.getValue("seeker-reach")[1])))
        // every other realm unchanged: crownlands' ROAD terrain (2 layers), its smoke_drift (no mini), its table path soil
        val cl = BasesLoad(t, decor, game).build(lp, "crownlands")!!
        assertEquals(2, cl.road!!.layers.size)
        assertEquals("smoke_drift", t.smokeIdOf("crownlands"))
        assertTrue(cl.catalog.containsKey("kit:smoke_drift")); assertEquals(null, cl.catalog.getValue("kit:smoke_drift").mini)
        assertTrue(cl.soil!!.copyOfRange(6, 9).contentEquals(hex(t.layout.soil.getValue("crownlands")[2])))
    }

    @Test fun solanaReachChimneysDrawTheKitsVapourAtTrue() {
        // the draw half of smokeIdOf: the keeps' chimney emitters (smokeByBand) push the realm's smoke sprite, so a lane
        // that still looked up kit:smoke_drift would draw no Solana smoke at all. Crownlands is the control.
        for (realm in listOf("crownlands", "seeker-reach")) {
            val r = Rig(realm = realm); r.openAndLoad(); r.populate(shield = false)
            assertTrue("$realm loaded: ${r.lane.stats.why}", r.lane.stats.loaded)
            r.look(12.0, 8.0, 1200.0); r.settle(150)
            assertTrue("$realm draws live keeps at TRUE", r.lane.stats.keeps > 0)
            assertTrue("$realm chimneys smoke", r.smokeDraws() > 0)
        }
    }

    @Test fun theDemoFallbackFeedsTheEngineInCatalogColumnsWithTheWebsFlags() {
        val grid = RealmGrid(700, 10, 24, 16, 0.5) // across the antimeridian wrap
        val snap = DemoBases(t).snapshot("crownlands", grid, ByteArray(24 * 16) { 255.toByte() }, 255, 7)
        val demo = DemoBases(t).demoBases("crownlands", 24, 16, ByteArray(24 * 16) { 255.toByte() }, 255)
        assertEquals(demo.size, snap.size)
        for (i in 0 until snap.size) {
            val tile = snap.deedY[i] * RealmGrid.LATTICE_W + snap.deedX[i]
            assertEquals(demo[i].x, grid.deedX(tile)); assertEquals(demo[i].y, grid.deedY(tile)); assertEquals(demo[i].level, snap.level[i])
            assertEquals(demo[i].mine, snap.flags[i] and RealmBases.FLAG_MINE != 0)
            assertEquals(demo[i].shield == true, snap.flags[i] and RealmBases.FLAG_SHIELD != 0)
            assertEquals(demo[i].attackable, snap.flags[i] and RealmBases.FLAG_ATTACKABLE != 0)
        }
    }

    // ---- P0 memory (2026-09-26): the owner's Seeker ran out of its 256 MB Java heap after a few realm visits. BASES kept
    //      every realm's sprite arrays with their mips (16.5 MB) for the whole visit, only to upload them once, and a load
    //      that finished after the lane moved on stayed in its inbox. A resident BASES keeps its catalog and counts and no
    //      pixels; a context loss reloads from the pack files.

    @Test fun afterItsUploadBasesHoldsNoDecodedAtlasAndNoMips() {
        val decoded = MemoryProbe.Decoded()
        val r = Rig(decoded = decoded); r.openAndLoad()
        assertTrue("the art loaded: ${r.lane.stats.why}", r.lane.stats.loaded)
        assertTrue("the pack's atlases were decoded through the tracked decoder", decoded.count() > 0)
        MemoryProbe.gc { decoded.alive().isEmpty() }
        assertEquals("decoded atlases still reachable after BASES' upload: ${decoded.aliveBytes()} B", 0, decoded.alive().size)
        assertEquals("BASES keeps no pixels once uploaded: ${r.holders()}", 0L, r.heldPixels())
        r.populate(shield = false); r.look(12.0, 8.0, 400.0); r.settle(120)
        assertTrue("and it still draws live keeps from the uploaded arrays", r.lane.stats.keeps > 0)
    }

    /** The fills read a snapshot of each array's layers: the build's lists are cleared as soon as the lane hands them over,
     *  while the real uploader fills some frames later (a fill that read the cleared list crashed M4's prototype). */
    @Test fun theFillsUploadTheSameTexelsWhenTheUploaderRunsThemAfterBasesLetGo() {
        val now = Rig(); now.openAndLoad()
        val later = Rig(deferFills = true)
        later.lane.open(later.open)
        later.rig.compiler.runAll(); later.frame(build = false) // create: the fills are queued, the layers cleared
        assertTrue("the art fills wait on the uploader", later.uploads.sums.size < now.uploads.sums.size)
        assertEquals(0L, later.heldPixels())
        repeat(3) { later.frame() } // the uploader runs them now
        assertEquals("every texture's texels, filled after the lane let go, equal an immediate fill's", now.uploads.sums, later.uploads.sums)
        assertTrue(later.lane.stats.loaded)
    }

    @Test fun aContextLossReloadsBasesFromThePackFiles() {
        val r = Rig(); r.openAndLoad()
        val sums = r.uploads.sums.toList()
        r.rig.contextId++ // the EGL context is gone with every texture; the engine disposes and reopens its lanes
        r.lane.dispose(); r.lane.open(r.openAt(2))
        repeat(3) { r.frame() }
        assertTrue("BASES reloaded: ${r.lane.stats.why}", r.lane.stats.loaded)
        assertEquals("the same texels again, read from the pack", sums, r.uploads.sums.subList(sums.size, r.uploads.sums.size))
        r.populate(shield = false); r.look(12.0, 8.0, 400.0); r.settle(120)
        assertTrue("it draws live keeps again", r.lane.stats.keeps > 0)
    }

    @Test fun aLoadThatFinishesAfterDisposeLeavesNothingBehind() {
        // queued: the realm changed (or the map was left for good) before the worker ran the load
        val queued = QueuedExecutor()
        val r = Rig(executor = queued)
        r.lane.open(r.open); r.lane.dispose()
        queued.runAll()
        // the engine never calls a disposed lane again (the host just keeps it reachable): nothing may wait in it
        assertEquals("nothing of the stale load waits in the disposed lane: ${r.holders()}", 0L, r.heldPixels())
        repeat(3) { r.frame() }
        assertFalse("a disposed lane adopts no stale build", r.lane.stats.loaded)
        assertTrue("nor its stale programs", r.lane.programs().isEmpty())
        assertEquals("nothing of the stale load is reachable from the lane: ${r.holders()}", 0L, r.heldPixels())
        // in flight: dispose lands while the worker cuts the realm's sprites; the atlases and mips are skipped and nothing kept
        val decoded = MemoryProbe.Decoded()
        val pack = Pack(t)
        val mid = Rig(pack = pack, decoded = decoded)
        pack.onRead = { if (it.endsWith("/spr.webp")) mid.lane.dispose() }
        mid.lane.open(mid.open)
        assertEquals("nothing of the in-flight load waits in the disposed lane: ${mid.holders()}", 0L, mid.heldPixels())
        repeat(3) { mid.frame() }
        assertFalse(mid.lane.stats.loaded)
        MemoryProbe.gc { decoded.alive().isEmpty() }
        assertEquals("the in-flight load's atlases are garbage", 0, decoded.alive().size)
        assertEquals("nothing of the in-flight load is reachable from the lane: ${mid.holders()}", 0L, mid.heldPixels())
    }

    @Test fun whileItsRehearsalArrayFillsBasesIsNotRehearsableYetAndThenItIs() {
        val r = Rig(deferFills = true)
        r.lane.open(r.open)
        r.rig.compiler.runAll(); r.frame(build = false) // the programs and the placeholder array exist; its fill waits
        val programs = r.lane.programs()
        assertEquals(BasesLane.PROGRAM_KEYS.size, programs.size)
        for (p in programs) assertFalse("${p.name}: the placeholder array is still filling, a rehearsal now is not a failed try", r.lane.rehearsable(p))
        assertFalse(r.rehearseAll().values.any { it })
        repeat(2) { r.frame() }
        for (p in programs) assertTrue("${p.name}: resident, its answers count again", r.lane.rehearsable(p))
        assertTrue(r.rehearseAll().values.all { it })
    }

    /** D-NEXT, the engine half: with BASES' arrays (its rehearsal placeholder first) held on the uploader for 3 s after its
     *  build landed, the engine asks again every 32 ms and counts no failed try, so once they are resident BASES rehearses
     *  at once and every lane pair is built within a second. Counted tries back off 1.5 → 3 → 6 s: seconds of a cold dive
     *  on the owner's Seeker. */
    @Test fun whileBasesArraysFillTheEngineAsksAgainAndNeverBacksOff() {
        val w = RealWorld(DirectExecutor)
        val ms = w.msToRehearseAfterHeldFills(w.bases, drew = { w.bases.stats.rehearsalDraws })
        println("BASES: rehearsed ${"%.0f".format(ms)} ms after its held arrays filled")
        assertTrue("BASES rehearsed and every lane pair built ${"%.0f".format(ms)} ms after its arrays became resident (≤ 1000)", ms <= 1000.0)
    }
}
