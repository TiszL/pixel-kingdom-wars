package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
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
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.lang.management.ManagementFactory
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor

/**
 * The LIFE lane on the GL core (FakeGl3): a synthetic Crownlands pack (every sprite its pinned table names, hash-pinned)
 * loads, every LIFE (program, pass state) is rehearsed before its band, a live MAP/TRUE frame draws the scatter within
 * the device cap, a frame without GROUND's classes draws nothing (never a guess at the terrain), and a steady panning
 * frame allocates nothing. Why it matters: the placement is golden-equal to the web, but a lane that first-draws a
 * pipeline at the band change (the RM-GPU-1 freeze), overshoots the phone's instance cap or churns garbage every frame
 * breaks the realm map on a real phone where no parity test looks.
 */
class LifeLaneTest {
    private val file = LifeTablesFile.load()
    private val cat = GoldenKit.catalogue()
    private val geo = LifeGeometry(cat.get("GRID").getInt("tilePx"), cat.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles"), file.constants.pinnedMapArt)
    private val sc = Scatter(file.constants, geo)
    private val plots = RealmEngineWiring.plots(cat.get("CAMPAIGN").get("claimTilesByKeep").asIntArray(),
        cat.get("CAMPAIGN_LAYOUT").get("wallRingsByKeep").asIntArray(), geo.tilesPerDeed)

    /** A synthetic realm pack: files hash-pinned by its realm.json, images served by key. */
    private abstract class SynthPack : RealmPackFiles {
        val files = HashMap<String, ByteArray>(); val images = HashMap<String, RgbaImage>()
        override fun read(path: String): ByteArray? = files[path]
        override fun expectedSha256(path: String): String? = files[path]?.let { RealmLoader.sha256Hex(it) }
    }

    /** Every id the pinned Crownlands table draws, as 16×16 realm sprites (one frame) and 32×32 creature sheets. */
    private class Pack(table: LifeTable) : SynthPack() {
        init {
            val ids = LinkedHashSet<String>()
            for (g in table.groups) for (s in g.species) { ids += s.id; s.emit?.let { ids += it.fx } }
            table.mixes?.forEach { m -> for ((id, _) in m.species) ids += id }
            table.birds?.species?.forEach { ids += it.id }
            for (a in table.ambience) ids += a.id
            val cre = table.creatures?.species?.map { it.id } ?: emptyList()
            val list = ids.toList()
            val w = maxOf(16, list.size * 16)
            images["spr.webp"] = RgbaImage(w, 16, ByteArray(w * 16 * 4) { i -> val p = i / 4; val x = p % 16; val y = p / w
                if (i % 4 == 3) (if (x in 5..10 && y in 3..15) 255 else 0).toByte() else ((p * 13 + i % 4 * 70) and 255).toByte() })
            val cw = maxOf(32, cre.size * 8 * 32)
            images["cre.webp"] = RgbaImage(cw, 32, ByteArray(cw * 32 * 4) { i -> val p = i / 4; val x = p % 32; val y = p / cw
                if (i % 4 == 3) (if (x in 10..21 && y in 12..31) 255 else 0).toByte() else ((p * 7 + i % 4 * 40) and 255).toByte() })
            files["realm/crownlands/spr.webp"] = "image:spr".toByteArray(); files["realm/crownlands/cre.webp"] = "image:cre".toByteArray()
            val rects = list.withIndex().joinToString(",") { (i, id) -> "\"$id\":{\"x\":${i * 16},\"y\":0,\"w\":16,\"h\":16,\"frames\":1,\"ax\":8,\"ay\":15}" }
            val creatures = cre.withIndex().joinToString(",") { (i, id) -> "{\"id\":\"$id\",\"x\":${i * 8 * 32},\"y\":0,\"fw\":32,\"fh\":32,\"directions\":4,\"frames\":2}" }
            fun sha(p: String) = RealmLoader.sha256Hex(files.getValue(p))
            files["realm/crownlands/realm.json"] = ("{\"grid\":{\"cols\":24,\"rows\":16}," +
                "\"files\":{\"spr.webp\":{\"sha256\":\"${sha("realm/crownlands/spr.webp")}\"},\"cre.webp\":{\"sha256\":\"${sha("realm/crownlands/cre.webp")}\"}}," +
                "\"sprites\":{\"atlas\":\"spr.webp\",\"rects\":{$rects}},\"creatures\":{\"atlas\":\"cre.webp\",\"list\":[$creatures]}}").toByteArray()
        }
    }

    /**
     * A Solana Reach pack of map objects only (stage B): the pinned table's beacon (whose lens the table's `glow` lights)
     * and a plain crag, 64×64 each on an opaque mapkit. With [LifeLaneTest.mapObjectsOnly] nothing else in LIFE animates.
     */
    private class BeaconPack : SynthPack() {
        init {
            images["mapkit.webp"] = RgbaImage(128, 64, ByteArray(128 * 64 * 4) { i -> if (i % 4 == 3) -1 else ((i * 29) and 255).toByte() })
            files["realm/seeker-reach/mapkit.webp"] = "image:mapkit".toByteArray()
            files["realm/seeker-reach/realm.json"] = ("{\"grid\":{\"cols\":24,\"rows\":16}," +
                "\"files\":{\"mapkit.webp\":{\"sha256\":\"${RealmLoader.sha256Hex(files.getValue("realm/seeker-reach/mapkit.webp"))}\"}}," +
                "\"map\":{\"atlas\":{\"file\":\"mapkit.webp\"},\"objects\":{" +
                "\"map_beacon_1\":{\"x\":0,\"y\":0,\"w\":64,\"h\":64,\"role\":\"beacon\"},\"map_crag_1\":{\"x\":64,\"y\":0,\"w\":64,\"h\":64,\"role\":\"crag\"}}}}").toByteArray()
        }
    }

    /** The pinned Solana Reach table cut to its map objects ([glow] kept or dropped): no clips, sway, herds, birds or air. */
    private fun mapObjectsOnly(glow: Boolean): LifeTablesFile {
        val t = file.tables.getValue("seeker-reach")
        val cut = LifeTable(t.wind, null, null, null, t.groups.filter { it.id == "mapobj" }, null, null, emptyList(), t.mapobjs, if (glow) t.glow else emptyMap())
        return LifeTablesFile(file.pin, file.generator, file.constants, linkedMapOf("seeker-reach" to cut))
    }

    /** The worker side of `StagingUploader.fresh`: fills at once, or ([defer]) only at the next [poll], as the real
     *  uploader's decode thread does some frames after the lane handed it the fill. [sums] is a hash of every filled
     *  texture's bytes, in order. */
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

    /** GROUND's class inputs stand-in: the classes include's samplers get the core's dummies (the fake samples nothing). */
    private class Classes(private val core: Gl3Core) : RealmClasses {
        var ready = true
        override fun bindClasses(program: Gl3Program, firstUnit: Int): Boolean {
            if (!ready) return false
            for (i in 0 until 6) core.bindTexture(firstUnit + i, core.dummy(integer = i != 5, array = i == 3 || i == 4))
            return true
        }
        override fun classAt(): ((Int, Int) -> Int)? = null
    }

    private object NoInts : Gl3IntUniforms {
        override fun uniform1ui(location: Int, v: Int) {}
        override fun uniform2i(location: Int, x: Int, y: Int) {}
        override fun uniform4i(location: Int, x: Int, y: Int, z: Int, w: Int) {}
        override fun uniform4iv(location: Int, count: Int, v: IntArray, offset: Int) {}
    }

    private object Now : Executor { override fun execute(command: Runnable) = command.run() }
    private val passes = intArrayOf(RealmLane.PASS_SHADOW, RealmLane.PASS_SPRITE, RealmLane.PASS_AIR)

    /** [decoded]: every image read decodes afresh (as the app's decoder does) and is tracked weakly; [executor] runs the
     *  load (at once by default); [deferFills]: the uploader fills textures only at the next poll. */
    private inner class Rig(val realm: String = "crownlands", val pack: SynthPack = Pack(file.tables.getValue("crownlands")), val tables: LifeTablesFile = file,
                            val decoded: MemoryProbe.Decoded? = null, private val executor: Executor = Now, deferFills: Boolean = false) {
        val rig = RealmGlRig()
        val uploads = Uploads(rig.worker, deferFills)
        val classes = Classes(rig.core)
        val lanePack = LanePack(pack) { _, key ->
            pack.images[key]?.let { im -> if (decoded == null) im else RgbaImage(im.width, im.height, im.rgba.copyOf()).also { decoded.track(it.rgba) } }
        }
        val lane = LifeLane(rig.core, tables, sc, LifeBandsIn.fromGenerated(), lanePack, uploads, classes, intUniforms = NoInts)
        val view = RealmView()
        /** The engine's open of this realm; [gen] bumps on every open (a realm change, a context restore). */
        fun openAt(gen: Int) = RealmOpen(realm, RealmMeta(realm, realm, "ready", null, 0, 0, 24, 16, 24 * 16, emptyMap(),
            "chart8.webp", -1, -1, "deeds.png", 255, 96), RealmGrid(0, 0, 24, 16, 0.5), ByteArray(24 * 16) { 255.toByte() }, ByteArray(24 * 16),
            floatArrayOf(0.1f, 0.2f, 0.4f), RealmLoader(object : RealmPackFiles { override fun read(path: String): ByteArray? = null }) { _, _ -> null },
            executor, gen, Runnable {}, RealmBases(plots).also { it.reset(24, 16) }, plots, RealmWebPin.CONFIG)
        val open = openAt(1)
        /** Pixel bytes the lane's own graph reaches (what it was given is not counted). */
        fun heldPixels(): Long = MemoryProbe.pixelBytes(lane, MemoryProbe.stopAt(lanePack, tables, sc, classes, uploads, NoInts, this))
        fun holders(): List<String> = MemoryProbe.pixelHolders(lane, MemoryProbe.stopAt(lanePack, tables, sc, classes, uploads, NoInts, this))

        init { view.targetW = 1080; view.targetH = 2400; view.dpr = 2.0; view.viewW = 540.0; view.viewH = 1200.0; view.workAllowed = true }

        fun look(x: Double, y: Double, d: Double) {
            view.x = x; view.y = y; view.d = d; view.s = d / view.dpr
            val hw = view.targetW / d / 2; val hh = view.targetH / d / 2
            view.rectX0 = x - hw; view.rectX1 = x + hw; view.rectY0 = y - hh; view.rectY1 = y + hh
        }

        fun frame(build: Boolean = true) {
            if (build) { rig.compiler.runAll(); uploads.poll(rig.core) }
            rig.nowMs += 16.7
            check(rig.begin())
            lane.update(view)
            rig.core.beginScreen(0f, 0f, 0f, 1f)
            rig.core.enable(GL20.GL_DEPTH_TEST); rig.core.depthFunc(GL20.GL_LEQUAL)
            for (p in passes) lane.draw(view, p)
            rig.end()
        }

        fun rehearseAll(): Map<String, Boolean> {
            val out = LinkedHashMap<String, Boolean>()
            rig.nowMs += 16.7; check(rig.begin())
            val screen = rig.core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.RGB8)!!; val depth = rig.core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.DEPTH16)!!
            for (p in lane.programs()) { var ok = false; rig.core.rehearse(screen, depth, true, false) { ok = lane.rehearse(p, RealmMapEngine.TARGET_SCREEN, view) }; out[p.name] = ok }
            rig.end()
            return out
        }
    }

    private fun loaded(r: Rig = Rig()): Rig {
        r.look(12.0, 8.0, 400.0)
        r.lane.open(r.open); repeat(4) { r.frame() }
        assertTrue("LIFE loaded: ${r.lane.stats.why} missing ${r.lane.stats.missing}", r.lane.stats.loaded)
        return r
    }

    @Test fun theSyntheticPackLoadsEveryProgramAndRehearsesEveryPassStateBeforeItsBand() {
        val r = loaded()
        assertEquals(LifeLane.PROGRAM_KEYS.map { it.substringBefore('+') }.toSet(), r.lane.programs().map { it.name.substringBefore('+') }.toSet())
        val pairs0 = r.rig.core.drawnPairs().size
        val ok = r.rehearseAll()
        assertTrue("every LIFE program with something to draw rehearsed: $ok", ok.filterKeys { it != "life-stand-merged" }.values.all { it })
        assertTrue("the rehearsal drew (program, state) pairs", r.rig.core.drawnPairs().size > pairs0)
        // after the rehearsal the live passes of MAP and TRUE find every pair already built
        val rehearsed = r.rig.core.drawnPairs().toSet()
        r.look(12.0, 8.0, 400.0); repeat(3) { r.frame() }
        r.look(12.0, 8.0, 1200.0); repeat(3) { r.frame() }
        val live = r.rig.core.drawnPairs().toSet() - rehearsed
        assertTrue("live LIFE frames first-drew pairs the rehearsal missed: ${live.size}", live.isEmpty())
    }

    @Test fun aLiveFrameDrawsTheScatterWithinTheCapAndNothingWithoutGroundsClasses() {
        val r = loaded()
        r.look(12.0, 8.0, 400.0); repeat(3) { r.frame() }
        assertTrue("MAP draws LIFE: planned ${r.lane.stats.planned}", r.lane.stats.draws > 0)
        assertTrue("submitted ≤ the §9 phone cap", r.lane.stats.planned <= file.constants.submittedPhone)
        r.view.lifeCap = 1000; r.frame()
        assertTrue("the ladder's cap binds: ${r.lane.stats.planned}", r.lane.stats.planned <= 1000)
        r.view.lifeCap = 0
        r.classes.ready = false; val missed = r.lane.stats.classesMissed; r.frame()
        assertEquals("no LIFE draw without GROUND's classes", 0, r.lane.stats.draws)
        assertTrue(r.lane.stats.classesMissed > missed)
        assertFalse(r.lane.stats.why.contains("no integer uniforms"))
    }

    /**
     * Stage B (life.js declareAnimations `on('life-glow', 100)`): Solana Reach's beacon lenses pulse on the GPU clock, so
     * LIFE must ask the host for 100-ms frames while a glowing group is planned on screen, or the idle scheduler stops
     * redrawing and the owner's beacons freeze mid-pulse at rest. The same map objects without the table's `glow` ask for
     * nothing (the tick is the glow's, not the map objects'), and reduced motion asks for nothing (the lens rests).
     */
    @Test fun aPlannedBeaconGlowAsksForHundredMillisecondFramesAndNothingElseDoes() {
        val lit = loaded(Rig("seeker-reach", BeaconPack(), mapObjectsOnly(glow = true)))
        assertTrue("the beacons are planned at MAP: ${lit.lane.stats.planned}", lit.lane.stats.planned > 0)
        assertEquals("a planned beacon glow ticks at 100 ms", 100, lit.lane.animationPeriodMs)
        lit.view.reducedMotion = true; lit.frame()
        assertEquals("reduced motion: the lens rests, no tick", 0, lit.lane.animationPeriodMs)
        val dark = loaded(Rig("seeker-reach", BeaconPack(), mapObjectsOnly(glow = false)))
        assertTrue(dark.lane.stats.planned > 0)
        assertEquals("the same map objects without a glow need no tick", 0, dark.lane.animationPeriodMs)
    }

    @Test fun aSteadyPanningLifeFrameAllocatesNothingOnTheGlThread() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        assertTrue("this JVM cannot count allocations: the gate would prove nothing", bean.isThreadAllocatedMemorySupported)
        bean.isThreadAllocatedMemoryEnabled = true
        val r = loaded()
        for (i in 0 until 120) { r.look(12.0 + (i % 3) * 0.001, 8.0, 400.0); r.frame(build = false) }
        r.rig.gl.record = false; r.rig.worker.record = false
        val tid = Thread.currentThread().id
        var best = Long.MAX_VALUE
        for (window in 0 until 5) {
            val before = bean.getThreadAllocatedBytes(tid)
            repeat(300) { i -> r.look(12.0 + (i % 3) * 0.001, 8.0, 400.0); r.frame(build = false) }
            best = minOf(best, bean.getThreadAllocatedBytes(tid) - before)
            if (best == 0L) break
        }
        assertEquals("a window of 300 panning LIFE frames allocated $best bytes", 0L, best)
    }

    // ---- P0 memory (2026-09-26): the owner's Seeker ran out of its 256 MB Java heap after a few realm visits. LIFE kept
    //      every realm's mip chains (10–13 MB) and its sprite atlas (8.5–10.9 MB) for the whole visit, only to upload them
    //      once, and a load that finished after the lane moved on stayed in its inbox. A resident LIFE keeps what it draws
    //      with and nothing it has uploaded; a context loss reloads from the pack files.

    /** The pixel bytes a loaded LIFE may keep: none (it kept its arrays' mips and its sprite atlas before the fix). */
    private val keptPixelBytes = 0L

    @Test fun afterItsUploadLifeHoldsNoDecodedAtlasAndNoMips() {
        val decoded = MemoryProbe.Decoded()
        val r = loaded(Rig(decoded = decoded))
        assertTrue("the pack's atlases were decoded through the tracked decoder", decoded.count() > 0)
        MemoryProbe.gc { decoded.alive().isEmpty() }
        assertEquals("decoded atlases still reachable after LIFE's upload: ${decoded.aliveBytes()} B", 0, decoded.alive().size)
        val held = r.heldPixels()
        assertTrue("LIFE keeps $held B of pixels after its upload (at most $keptPixelBytes): ${r.holders()}", held <= keptPixelBytes)
        r.look(12.0, 8.0, 400.0); repeat(3) { r.frame() }
        assertTrue("and it still draws from the uploaded arrays: ${r.lane.stats.draws}", r.lane.stats.draws > 0)
    }

    @Test fun theFillsUploadTheSameTexelsWhenTheUploaderRunsThemAfterLifeLetGo() {
        val now = loaded(Rig())
        val later = Rig(deferFills = true)
        later.look(12.0, 8.0, 400.0); later.lane.open(later.open)
        later.rig.compiler.runAll(); later.frame(build = false) // create: the fills are queued, the lane drops its mips
        assertTrue("the fills wait on the uploader", later.uploads.sums.isEmpty())
        assertTrue(later.heldPixels() <= keptPixelBytes)
        repeat(3) { later.frame() } // the uploader runs them now
        assertEquals("every texture's texels, filled after the lane let go, equal an immediate fill's", now.uploads.sums, later.uploads.sums)
        assertTrue(later.lane.stats.loaded)
    }

    @Test fun aContextLossReloadsLifeFromThePackFiles() {
        val r = loaded()
        val sums = r.uploads.sums.toList()
        r.rig.contextId++ // the EGL context is gone with every texture; the engine disposes and reopens its lanes
        r.lane.dispose(); r.lane.open(r.openAt(2))
        repeat(4) { r.frame() }
        assertTrue("LIFE reloaded: ${r.lane.stats.why}", r.lane.stats.loaded)
        assertEquals("the same texels again, read from the pack", sums, r.uploads.sums.subList(sums.size, r.uploads.sums.size))
        r.look(12.0, 8.0, 400.0); repeat(3) { r.frame() }
        assertTrue("it draws again: ${r.lane.stats.draws}", r.lane.stats.draws > 0)
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
        assertEquals("nothing of the stale load is reachable from the lane: ${r.holders()}", 0L, r.heldPixels())
        // in flight: dispose lands while the worker cuts the frames; the rest of the load is skipped and nothing is kept
        val decoded = MemoryProbe.Decoded()
        lateinit var mid: Rig
        val pack = object : SynthPack() {
            val base = Pack(file.tables.getValue("crownlands"))
            init { files.putAll(base.files); images.putAll(base.images) }
            override fun read(path: String): ByteArray? { if (path.endsWith("cre.webp")) mid.lane.dispose(); return super.read(path) }
        }
        mid = Rig(pack = pack, decoded = decoded)
        mid.lane.open(mid.open)
        assertEquals("nothing of the in-flight load waits in the disposed lane: ${mid.holders()}", 0L, mid.heldPixels())
        repeat(3) { mid.frame() }
        assertFalse(mid.lane.stats.loaded)
        MemoryProbe.gc { decoded.alive().isEmpty() }
        assertEquals("the in-flight load's atlases are garbage", 0, decoded.alive().size)
        assertEquals("nothing of the in-flight load is reachable from the lane: ${mid.holders()}", 0L, mid.heldPixels())
    }

    @Test fun whileItsArraysFillLifeIsNotRehearsableYetAndThenItIs() {
        val r = Rig()
        r.look(12.0, 8.0, 400.0); r.lane.open(r.open)
        r.rig.compiler.runAll(); r.frame(build = false) // create: the arrays are reserved, their fills not adopted
        val programs = r.lane.programs()
        assertEquals(LifeLane.PROGRAM_KEYS.size, programs.size)
        for (p in programs) assertFalse("${p.name}: the arrays are still filling, a rehearsal now is not a failed try", r.lane.rehearsable(p))
        val p = programs.first()
        assertFalse(r.rehearseAll().getValue(p.name))
        repeat(2) { r.frame() } // the uploader's fences signal
        for (q in programs) assertTrue("${q.name}: resident, its answers count again", r.lane.rehearsable(q))
        assertTrue(r.rehearseAll().getValue(p.name))
    }

    /** D-NEXT, the engine half: with LIFE's arrays held on the uploader for 3 s after its build landed, the engine asks
     *  again every 32 ms and counts no failed try, so once they are resident LIFE rehearses at once and every lane pair is
     *  built within a second. Counted tries back off 1.5 → 3 → 6 s: seconds of a cold dive on the owner's Seeker. */
    @Test fun whileLifesArraysFillTheEngineAsksAgainAndNeverBacksOff() {
        val w = RealWorld(DirectExecutor)
        val ms = w.msToRehearseAfterHeldFills(w.life, drew = { w.life.stats.rehearsalDraws })
        println("LIFE: rehearsed ${"%.0f".format(ms)} ms after its held arrays filled")
        assertTrue("LIFE rehearsed and every lane pair built ${"%.0f".format(ms)} ms after its arrays became resident (≤ 1000)", ms <= 1000.0)
    }
}
