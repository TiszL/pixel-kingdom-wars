package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeShareGroup
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ManualCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BasesBandsIn
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BasesLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BasesRules
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.Decor
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorGame
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorTables
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GlGroundUniforms
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundGl
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.OpenGroundSource
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.Gl3IntUniforms
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePack
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePixelFill
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneUploads
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeBandsIn
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeGeometry
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeTablesFile
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.Scatter
import gg.pixelkingdomwars.nativeclient.renderer.world.ExactPng
import java.io.File
import java.lang.ref.WeakReference
import java.lang.reflect.Modifier
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.IdentityHashMap
import java.util.concurrent.Executor

/**
 * Heap evidence for the realm map's memory rules (P0 2026-09-26: the owner's Seeker ran out of its 256 MB Java heap after
 * a few realm visits). Two instruments:
 * - [Decoded]: a weak reference to every decoded image array (the exact PNG decoder's trace hook, and [track] for the
 *   WebP stand-in), tagged by realm, so a test can ask which decodes are still reachable after a GC;
 * - [pixelBytes]: the byte arrays reachable from an object through its fields, collections and maps (the lane's own
 *   graph; the GL core and JDK internals are not entered), so a test can say "this lane holds no pixels" without
 *   knowing its private fields.
 */
internal object MemoryProbe {
    /** Collect garbage until [done] holds or the tries run out (weak references clear at a full GC). */
    fun gc(done: () -> Boolean = { false }) {
        for (i in 0 until 8) {
            System.gc(); System.runFinalization()
            if (done()) return
            Thread.sleep(10L + 10L * i)
        }
    }

    /** Every decoded image array while [install]ed, tagged with [tag] at decode time (weakly held). */
    class Decoded : AutoCloseable {
        class Entry(val tag: String, val bytes: Int, val ref: WeakReference<Any>)
        private val entries = ArrayList<Entry>()
        @Volatile var tag = ""

        fun install(): Decoded { ExactPng.trace = { track(it) }; return this }
        @Synchronized fun track(array: Any) { entries += Entry(tag, (array as? ByteArray)?.size ?: 0, WeakReference(array)) }
        @Synchronized fun alive(): List<Entry> = entries.filter { it.ref.get() != null }
        @Synchronized fun aliveBytes(tag: String? = null): Long = entries.filter { (tag == null || it.tag == tag) && it.ref.get() != null }.sumOf { it.bytes.toLong() }
        @Synchronized fun count(tag: String? = null): Int = entries.count { tag == null || it.tag == tag }
        @Synchronized fun decodedBytes(tag: String? = null): Long = entries.filter { tag == null || it.tag == tag }.sumOf { it.bytes.toLong() }
        override fun close() { ExactPng.trace = null }
    }

    /**
     * Bytes of every `ByteArray` reachable from [root]: through the declared fields of the app's own classes (lambdas and
     * inner classes included), the elements of collections, arrays and maps. Not entered: the GL core and its fakes
     * (`…renderer.gl3`), JDK objects other than collections and maps (strings, buffers, threads), and anything [stop]
     * names (shared objects the lane was given: its tables, its pack, the test's uploader; see [stopAt]).
     */
    fun pixelBytes(root: Any, stop: (Any) -> Boolean = { false }): Long = walk(root, stop, null)

    /** Where [pixelBytes] found its arrays of 4 KB or more: "field.path (bytes)", for a failure message. */
    fun pixelHolders(root: Any, stop: (Any) -> Boolean = { false }): List<String> = ArrayList<String>().also { walk(root, stop, it) }

    private fun walk(root: Any, stop: (Any) -> Boolean, holders: MutableList<String>?): Long {
        val seen = IdentityHashMap<Any, Boolean>()
        val stack = ArrayList<Pair<Any, String>>()
        stack += root to root.javaClass.simpleName
        var bytes = 0L
        while (stack.isNotEmpty()) {
            val (o, path) = stack.removeAt(stack.size - 1)
            if (seen.put(o, true) != null) continue
            when (o) {
                is ByteArray -> { bytes += o.size; if (holders != null && o.size >= 4096) holders += "$path (${o.size})"; continue }
                is Array<*> -> { for ((i, e) in o.withIndex()) if (e != null) stack += e to "$path[$i]"; continue }
                is Collection<*> -> { for ((i, e) in o.toTypedArray().withIndex()) if (e != null) stack += e to "$path[$i]"; continue }
                is Map<*, *> -> { for ((k, v) in o.entries.toTypedArray()) { if (k != null) stack += k to "$path.key"; if (v != null) stack += v to "$path[$k]" }; continue }
            }
            val cls = o.javaClass
            if (cls.isArray) continue // the other primitive arrays: not pixels
            val name = cls.name
            if (!ours(name)) continue
            if (name.startsWith("gg.pixelkingdomwars.nativeclient.renderer.gl3.") || stop(o)) continue
            var c: Class<*>? = cls
            while (c != null && ours(c.name)) {
                for (f in c.declaredFields) {
                    if (Modifier.isStatic(f.modifiers) || f.type.isPrimitive) continue
                    f.isAccessible = true
                    val v = f.get(o) ?: continue
                    stack += v to "$path.${f.name}"
                }
                c = c.superclass
            }
        }
        return bytes
    }

    /** The app's classes (and their lambdas), and Kotlin's value holders (Pair, Triple, lazies). */
    private fun ours(name: String) = name.startsWith("gg.pixelkingdomwars.") || name.startsWith("kotlin.")

    /** A [pixelBytes] stop for these exact objects (what a lane was given, not what it made). */
    fun stopAt(vararg shared: Any?): (Any) -> Boolean {
        val set = IdentityHashMap<Any, Boolean>(); for (o in shared) if (o != null) set[o] = true
        return { set.containsKey(it) }
    }
}

/** The world bundle the APK ships (stage B, `app/src/main/assets/world`), its content manifest as the outer manifest.
 *  [onRead] runs before every read (a test's hook into a worker's load). */
internal class BundleFiles(val root: File = File("../app/src/main/assets/world")) : RealmPackFiles {
    private val hashes = RealmLoader.contentHashes(File(root, "content.json").readText())
    @Volatile var onRead: (String) -> Unit = {}
    override fun read(path: String): ByteArray? { onRead(path); return File(root, path).takeIf { it.isFile }?.readBytes() }
    override fun expectedSha256(path: String): String? = hashes[path]
}

/**
 * The JVM decodes no WebP (chart8, tone and plots are WebP in the bundle): a stand-in of the real image's size, read from
 * its VP8 / VP8L header, filled with a fixed opaque pattern. It allocates like the app's decoder does on the Java heap
 * (one w · h · 4 array; the Android Bitmap itself is native) and reports every array to [decoded].
 */
internal class WebpStandIn(private val decoded: MemoryProbe.Decoded?) : RealmImageDecoder {
    override fun decode(bytes: ByteArray, key: String): RgbaImage? {
        val wh = size(bytes) ?: return null
        val px = ByteArray(wh[0] * wh[1] * 4)
        for (i in px.indices) px[i] = if (i and 3 == 3) -1 else ((i * 37) ushr 5).toByte()
        decoded?.track(px)
        return RgbaImage(wh[0], wh[1], px)
    }

    companion object {
        /** Width and height from a simple-format WebP (RIFF / WEBP / `VP8 ` or `VP8L`), null otherwise. */
        fun size(b: ByteArray): IntArray? {
            if (b.size < 30 || String(b, 0, 4, Charsets.ISO_8859_1) != "RIFF" || String(b, 8, 4, Charsets.ISO_8859_1) != "WEBP") return null
            fun u(i: Int) = b[i].toInt() and 0xff
            return when (String(b, 12, 4, Charsets.ISO_8859_1)) {
                "VP8 " -> intArrayOf((u(26) or (u(27) shl 8)) and 0x3fff, (u(28) or (u(29) shl 8)) and 0x3fff)
                "VP8L" -> { val bits = u(21) or (u(22) shl 8) or (u(23) shl 16) or (u(24) shl 24); intArrayOf((bits and 0x3fff) + 1, ((bits ushr 14) and 0x3fff) + 1) }
                else -> null
            }
        }
    }
}

/**
 * `StagingUploader.fresh` as the device runs it: the GL thread reserves the texture; its fill waits in a queue (the fill
 * holds its pixels until then) and runs at the next [runFills] into one reused direct buffer, as the uploader's decode
 * thread does; the texture is adopted at the next [poll]. A texture freed before its fill ran is never filled (its name
 * is deleted at the poll).
 */
internal class DeferredUploads(private val worker: FakeGl3) : RealmUploads, LaneUploads {
    private val queue = ArrayList<() -> Unit>()
    private val held = ArrayList<() -> Unit>()
    private val done = ArrayList<Triple<Gl3Texture, Int, Long>>()
    private var scratch: ByteBuffer = ByteBuffer.allocateDirect(1)
    val waiting: Int get() = queue.size + held.size
    /** The fills of these lanes ([lane]'s tag) wait until [release] (a slow uploader, a busy decode thread). */
    var hold: Set<String> = emptySet()
    fun release() { hold = emptySet(); queue += held; held.clear() }
    /** The uploader as lane [tag] sees it (one shared queue; [hold] can single the lane out). */
    fun lane(tag: String): LaneUploads = object : LaneUploads {
        override fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                           sampling: Gl3Sampling, wrap: Gl3Wrap, fill: LanePixelFill): Gl3Texture? =
            fresh(core, pool, array, width, height, layers, format, levels, tag) { layer, level, w, h, out -> fill.fill(layer, level, w, h, out) }
    }

    private fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                      tag: String = "", fill: (Int, Int, Int, Int, ByteBuffer) -> Unit): Gl3Texture? {
        val t = core.reserve(pool, array, width, height, layers, format, levels) ?: return null
        queue += {
            val target = if (array) GL30.GL_TEXTURE_2D_ARRAY else GL20.GL_TEXTURE_2D
            val name = worker.genTexture(); worker.activeTexture(GL20.GL_TEXTURE0); worker.bindTexture(target, name)
            if (array) worker.texStorage3D(target, levels, format.internal, width, height, layers) else worker.texStorage2D(target, levels, format.internal, width, height)
            if (t.state == Gl3Texture.PENDING) for (layer in 0 until layers) for (level in 0 until levels) {
                val w = maxOf(1, width shr level); val h = maxOf(1, height shr level); val n = w * h * format.bytesPerTexel
                if (scratch.capacity() < n) scratch = ByteBuffer.allocateDirect(n).order(ByteOrder.nativeOrder())
                scratch.clear(); scratch.limit(n)
                fill(layer, level, w, h, scratch.slice().order(ByteOrder.nativeOrder()))
            }
            done += Triple(t, name, worker.fenceSync())
        }
        if (tag in hold) held += queue.removeAt(queue.size - 1)
        return t
    }
    override fun fresh(core: Gl3Core, pool: Gl3Pool, width: Int, height: Int, format: Gl3Format, levels: Int, sampling: Gl3Sampling, wrap: Gl3Wrap,
                       fill: RealmPixelFill): Gl3Texture? =
        fresh(core, pool, false, width, height, 1, format, levels) { _, level, w, h, out -> fill.fill(level, w, h, out) }
    override fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                       sampling: Gl3Sampling, wrap: Gl3Wrap, fill: LanePixelFill): Gl3Texture? =
        fresh(core, pool, array, width, height, layers, format, levels) { layer, level, w, h, out -> fill.fill(layer, level, w, h, out) }
    fun runFills() { while (queue.isNotEmpty()) { val q = queue.toList(); queue.clear(); q.forEach { it() } } }
    fun poll(core: Gl3Core) {
        for ((t, n, f) in done) { if (t.state == Gl3Texture.PENDING) core.adopt(t, n, f) else { worker.deleteTexture(n); worker.deleteSync(f) } }
        done.clear()
    }
}

/** The GL calls the lanes add to `Gl3` (GROUND's vector uniforms, LIFE's integer ones): nothing to record here. */
internal object NoLaneGl : GroundGl, Gl3IntUniforms {
    override fun uniform1ui(location: Int, v: Int) {}
    override fun uniform2i(location: Int, x: Int, y: Int) {}
    override fun uniform4i(location: Int, x: Int, y: Int, z: Int, w: Int) {}
    override fun uniform4ui(location: Int, x: Int, y: Int, z: Int, w: Int) {}
    override fun uniform1iv(location: Int, count: Int, v: IntArray, offset: Int) {}
    override fun uniform2iv(location: Int, count: Int, v: IntArray, offset: Int) {}
    override fun uniform4iv(location: Int, count: Int, v: IntArray, offset: Int) {}
    override fun uniform3fv(location: Int, count: Int, v: FloatArray, offset: Int) {}
    override fun uniform4fv(location: Int, count: Int, v: FloatArray, offset: Int) {}
}

/**
 * The realm map as WorldEngineHost wires it on the Seeker (buffer 800 × 1780 at dpr 2): the production engine config
 * and catalogue numbers, the frozen deed catalog, GROUND + LIFE + BASES over the real bundle, the deferred uploader, on
 * FakeGl3 without call recording. [executor] runs the loads (the host's two world-load threads, or the test thread).
 */
internal class RealWorld(val executor: Executor, decoded: MemoryProbe.Decoded? = null) {
    val bundle = BundleFiles()
    val images = WebpStandIn(decoded)
    val group = FakeShareGroup()
    val gl = FakeGl3(group, "world").apply { record = false }
    val worker = FakeGl3(group, "worker").apply { record = false }
    val compiler = ManualCompiler(ProgramBuilder(worker, null, "RealmView", 0))
    val core = Gl3Core(gl, compiler, 262_144L, strict = false)
    val uploads = DeferredUploads(worker)
    val numbers = RealmEngineWiring.fromCatalogue(File("../app/src/main/assets/native/catalogue.json").readText())
    val config = RealmEngineWiring.config()
    var now = 1000.0
    val lanePack = LanePack(bundle, images)
    val ground = GroundLane(core, GlGroundUniforms(core, NoLaneGl), uploads.lane("ground"), { open -> OpenGroundSource(open) { id -> bundle.read("realm/$id/realm.json")!! } },
        maxTextureSize = 4096, nowMs = { now })
    val lifeTables = LifeTablesFile.load()
    private val constants = numbers.constants!!
    val scatter = Scatter(lifeTables.constants, LifeGeometry(constants.get("GRID").getInt("tilePx"), constants.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles"),
        lifeTables.constants.pinnedMapArt))
    val life = LifeLane(core, lifeTables, scatter, LifeBandsIn.fromGenerated(), lanePack, uploads.lane("life"), ground, intUniforms = NoLaneGl)
    val decorTables = DecorTables.load()
    val decor = Decor(decorTables, DecorGame.fromCatalogue(constants), numbers.plots)
    val bases = BasesLane(core, decorTables, decor, BasesBandsIn.fromGenerated(), lanePack, uploads.lane("bases"), ground, BasesRules.MsClock { now })
    val lanes: List<RealmLane> = listOf(ground, life, bases)
    val engine = RealmMapEngine(core, config, numbers.plots, numbers.deedArt, RealmLoader(bundle, images),
        RealmCatalog.parse(File("../app/src/main/assets/native/fantasy/world-v1.json").readText()), uploads, executor, { now }, RealmDiveFade.PLAN_FADE_MS,
        lanes = lanes)

    init { core.resize(800, 1780); engine.setViewport(800, 1780, 2.0) }

    val realmBytes: Long get() = core.stats.poolBytes[Gl3Pool.REALM.ordinal]
    fun settled(): Boolean = ground.settled() && life.settled() && bases.settled()
    /** Pixel bytes [lane]'s own graph reaches (not what it was given: the pack, the tables, the engine, its clock (this
     *  harness), GROUND for LIFE and BASES). */
    fun heldPixels(lane: RealmLane): Long = MemoryProbe.pixelBytes(lane, given(lane))
    /** Where [heldPixels] found them (for a failure message). */
    fun holders(lane: RealmLane): List<String> = MemoryProbe.pixelHolders(lane, given(lane))
    private fun given(lane: RealmLane) = MemoryProbe.stopAt(this, lanePack, bundle, images, uploads, lifeTables, scatter, decorTables, decor, numbers,
        engine, engine.bases, if (lane === ground) null else ground)

    private fun ns() = (now * 1e6).toLong()
    /** A MODE_GLOBE frame (the host's order): fills, programs, update, adoption, the idle rehearsal step. */
    fun globeFrame(dtMs: Double = 16.667) {
        uploads.runFills(); compiler.runAll(); now += dtMs
        check(core.beginFrame(ns(), 1L)); engine.update(now, true); uploads.poll(core)
        if (!engine.ready) engine.rehearseStep(now)
        engine.readiness()
        core.beginScreen(0f, 0f, 0f, 1f); core.endFrame(ns())
    }
    /**
     * The engine half of [RealmLane.rehearsable] with a lane's real inputs: dive into crownlands with every texture fill
     * of [lane] held on the uploader until [holdMs] after it settled (built, its arrays waiting); then let them fill and
     * return the ms until its hook has drawn a rehearsal ([drew] went up) and every lane pair is rehearsed or finally
     * "nothing". A lane whose hook's false answers while filling counted as failed tries would first wait out the
     * 1.5 → 3 → 6 s back-off.
     */
    fun msToRehearseAfterHeldFills(lane: RealmLane, drew: () -> Long, holdMs: Double = 3000.0): Double {
        uploads.hold = setOf(lane.name)
        check(engine.prepare("crownlands"))
        var n = 0
        while (!engine.ready && n < 4000) { globeFrame(); n++ }
        check(engine.ready) { "crownlands dive-ready (status ${engine.status})" }
        val g = engine.grid!!
        check(engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        n = 0
        while (!lane.settled() && n < 4000) { realmFrame(); n++ }
        check(lane.settled()) { "${lane.name} built and settled while its fills were held" }
        val t0 = now
        while (now - t0 < holdMs) realmFrame()
        val drew0 = drew()
        check(drew0 == 0L) { "${lane.name} drew a rehearsal without its arrays: $drew0" }
        uploads.release()
        val t1 = now
        fun done() = drew() > drew0 && engine.stats.lanePairsRehearsed + engine.stats.lanePairsNothing == engine.stats.lanePairsTotal
        while (!done() && now - t1 < 10_000.0) realmFrame()
        check(done()) { "${lane.name} drew ${drew()}; lane pairs ${engine.stats.lanePairsRehearsed} rehearsed + ${engine.stats.lanePairsNothing} nothing of ${engine.stats.lanePairsTotal}" }
        return now - t1
    }

    /** A MODE_MAP frame: fills, programs, update, adoption, the rehearsal step while waiting, the realm frame. */
    fun realmFrame() {
        uploads.runFills(); compiler.runAll(); now += 16.667
        check(core.beginFrame(ns(), 1L)); engine.update(now, true); uploads.poll(core)
        if (engine.waiting) engine.rehearseStep(now)
        engine.frame(now, now.toLong(), false)
        core.endFrame(ns())
    }
}
