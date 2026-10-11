package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.GlobeArt
import gg.pixelkingdomwars.nativeclient.renderer.GlobeIsland
import gg.pixelkingdomwars.nativeclient.renderer.gl3.CoreRig
import gg.pixelkingdomwars.nativeclient.renderer.gl3.DirectProgramCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.world.IdleScheduler
import gg.pixelkingdomwars.nativeclient.renderer.world.InputScale
import gg.pixelkingdomwars.nativeclient.renderer.world.WebPin
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameExchange
import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor

/** The real exploration islands (the client pack's render catalogue, via tools/globe2-pin.mjs) as a legacy GlobeArt. */
internal fun goldenArt(effectsPath: String = "fx.json"): GlobeArt {
    val islands = Goldens.json("islands.json"); val shape = islands.get("shape")
    val list = ArrayList<GlobeIsland>()
    islands.get("chains").forEachIndexed { c, chain -> chain.get("islands").forEachIndexed { s, i -> list += GlobeIsland(c, s, i.getDouble("lon"), i.getDouble("lat"), i.getDouble("rx"), i.getDouble("ry")) } }
    return GlobeArt(islands.get("chains").map { it.getString("id") }, list, shape.getInt("cell"), shape.getInt("atlas"), shape.getDouble("extent"),
        "", 1, 1, emptyList(), "", 1, 1, emptyList(), effectsPath, 720, 360, { false }, { false }, { _, _ -> false })
}

/** Records every uniform name each program asks for (program id → names), and the last vec4 set per name (the fake's
 *  own locations are name lengths, which collide; here each name gets its own). Records nothing with the fake's
 *  `record` off, so the zero-allocation test can run through it. */
internal class UniformRecorder(val fake: FakeGl3) : Gl3 by fake {
    val asked = HashMap<Int, MutableSet<String>>()
    private val ids = HashMap<String, Int>(); private val names = HashMap<Int, String>()
    val vec4 = HashMap<String, FloatArray>()
    override fun getUniformLocation(program: Int, name: String): Int {
        asked.getOrPut(program) { HashSet() } += name; fake.getUniformLocation(program, name)
        return ids.getOrPut(name) { (1000 + ids.size).also { names[it] = name } }
    }
    override fun uniform4f(location: Int, x: Float, y: Float, z: Float, w: Float) {
        fake.uniform4f(location, x, y, z, w)
        if (fake.record) names[location]?.let { vec4[it] = floatArrayOf(x, y, z, w) }
    }

    /** Per instanced draw while recording: [instances, the texture bound at unit 5 (the island art unit), the bound
     *  vertex array's attribute-1 byte offset (its first instance record × 32), uIsleGrid.x, the program]. */
    val instanced = ArrayList<IntArray>()
    private var unit = 0; private val bound = IntArray(32); private var vao = 0; private val attrib1 = HashMap<Int, Int>()
    override fun activeTexture(unit: Int) { fake.activeTexture(unit); this.unit = unit - GL20.GL_TEXTURE0 }
    override fun bindTexture(target: Int, texture: Int) { fake.bindTexture(target, texture); if (unit in bound.indices) bound[unit] = texture }
    override fun bindVertexArray(array: Int) { fake.bindVertexArray(array); vao = array }
    override fun vertexAttribPointer(index: Int, size: Int, type: Int, normalized: Boolean, stride: Int, offset: Int) {
        fake.vertexAttribPointer(index, size, type, normalized, stride, offset)
        if (index == 1 && fake.record) attrib1[vao] = offset
    }
    override fun drawArraysInstanced(mode: Int, first: Int, count: Int, instances: Int) {
        fake.drawArraysInstanced(mode, first, count, instances)
        if (fake.record) instanced += intArrayOf(instances, bound[5], attrib1[vao] ?: -1, (vec4["uIsleGrid"]?.get(0) ?: -1f).toInt(), fake.program)
    }
}

/**
 * The worker side of the host's `StagingUploader.fresh` on the fake (as the realm tests' FakeRealmUploads): reserves
 * room on the GL side, creates and fills the array on the worker fake (sharing the world fake's objects), fences it,
 * and hands it back on [poll]. Fills after the first world frame, like the real worker.
 */
internal class FakeGlobeUploads(private val worker: FakeGl3) : GlobeUploader {
    private val pending = ArrayList<Triple<Gl3Texture, Int, Long>>()
    /** [width, layers, levels] of every texture filled, in order, and the textures themselves. */
    val filled = ArrayList<IntArray>()
    val created = ArrayList<Gl3Texture>()
    /** Adopt nothing while true: the host polls its uploads only outside flights and fades (a texture stays filling). */
    var hold = false
    override val fillsAfterFirstFrame: Boolean get() = true
    override fun fresh(core: Gl3Core, pool: Gl3Pool, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                       sampling: Gl3Sampling, wrap: Gl3Wrap, pixels: GlobePixels): Gl3Texture? {
        val texture = core.reserve(pool, true, width, height, layers, format, levels) ?: return null
        val name = worker.genTexture()
        worker.activeTexture(GL20.GL_TEXTURE0); worker.bindTexture(GL30.GL_TEXTURE_2D_ARRAY, name)
        worker.texStorage3D(GL30.GL_TEXTURE_2D_ARRAY, levels, format.internal, width, height, layers)
        for (layer in 0 until layers) for (level in 0 until levels) {
            val w = maxOf(1, width shr level); val h = maxOf(1, height shr level)
            pixels.fill(layer, level, w, h, ByteBuffer.allocateDirect(w * h * format.bytesPerTexel).order(ByteOrder.nativeOrder()))
        }
        filled += intArrayOf(width, layers, levels); created += texture
        pending += Triple(texture, name, worker.fenceSync())
        return texture
    }
    override fun poll(core: Gl3Core) { if (hold || pending.isEmpty()) return; for ((t, n, f) in pending) core.adopt(t, n, f); pending.clear() }
}

/** Tasks held until the test runs them (the decode pool, one task at a time or all). */
internal class HeldExecutor : Executor {
    val tasks = ArrayList<Runnable>()
    override fun execute(command: Runnable) { tasks += command }
    fun runNext(): Boolean { if (tasks.isEmpty()) return false; tasks.removeAt(0).run(); return true }
    fun runAll() { while (runNext()) Unit }
}

/** A globe on a recording fake GL, with tiny synthetic textures and the real geography, islands and shader stages.
 *  [direct]: the GL-thread-only uploader (no worker) instead of the fake worker; [decode]: the decode pool (inline by
 *  default); [content]: the staged assets. */
internal class GlobeRig(val strictCore: Boolean = true, withIdle: Boolean = false, val w: Int = 914, val h: Int = 2034,
                        direct: Boolean = false, val decode: Executor = Executor { it.run() },
                        content: (GlobeArt) -> GlobeAssets = { assets(it) }) {
    val world = FakeGl3()
    val worker = FakeGl3(world.group, "worker")
    val gl = UniformRecorder(world)
    val core = Gl3Core(gl, DirectProgramCompiler(ProgramBuilder(gl, null, CoreRig.VIEW_BLOCK, 0)), 256 * 1024L, strictCore).also { it.resize(w, h) }
    val events = Events()
    val idle = if (withIdle) IdleScheduler(WebPin.IDLE) else null
    val frames = WorldFrameExchange(16)
    val input = InputScale().also { it.set(w, h, w, h) }
    val art = goldenArt()
    var decodes = 0
    val uploads = FakeGlobeUploads(worker)
    val renderer = GlobeV2Renderer(core, { name -> stages(name) }, { decodes++; content(art) }, decode,
        if (direct) DirectGlobeUploader() else uploads, art, events, idle, frames, input, 2.0)
    var now = 1000.0
    var context = 1L

    fun frame(dtMs: Double = 16.0, ladder: gg.pixelkingdomwars.nativeclient.renderer.world.LadderKnobs? = null): Boolean {
        now += dtMs
        idle?.frameRendered(now.toLong())
        val report = renderer.renderFrame(now, context, w, h, ladder)
        return report != null
    }

    fun untilReady(max: Int = 10): Int { var n = 0; while (!renderer.ready && n < max) { frame(); n++ }; check(renderer.ready) { "not ready: ${renderer.failure}" }; return n }

    class Events : GlobeEvents {
        var ready = 0; val unavailable = ArrayList<String>(); val picks = ArrayList<GlobePickV2>(); val selections = ArrayList<String?>()
        val dives = ArrayList<String>(); val noMaps = ArrayList<String?>(); val parts = ArrayList<String>()
        val approaches = ArrayList<String>()
        val nearArts = ArrayList<Pair<String, Boolean>>()
        /** Per near display, as [nearArts]: [blurMs, in flight (1) or not (0), totalMs]. */
        val nearWaits = ArrayList<DoubleArray>()
        override fun approach(realmId: String) { approaches += realmId }
        override fun nearArt(islandId: String, cached: Boolean, decodeMs: Double, resampleMs: Double, mipMs: Double, uploadMs: Double, totalMs: Double,
                             blurMs: Double, inFlight: Boolean) {
            nearArts += islandId to cached; nearWaits += doubleArrayOf(blurMs, if (inFlight) 1.0 else 0.0, totalMs)
        }
        override fun partUnavailable(part: String, reason: String) { parts += part }
        override fun ready() { ready++ }
        override fun unavailable(reason: String) { unavailable += reason }
        override fun picked(pick: GlobePickV2) { picks += pick }
        override fun selected(realmId: String?, islandId: String?) { selections += realmId ?: islandId }
        override fun dive(realmId: String, lon: Double, lat: Double, sStartCss: Double) { dives += realmId }
        override fun noMap(realmId: String?) { noMaps += realmId }
    }

    companion object {
        /** The globe's pinned test copies, and the realm engine's blit from the generated WorldShaders (main resources). */
        fun stages(name: String): GlobeStages? {
            if (name == GlobeV2Renderer.PROGRAM_BLIT) return WorldShadersGlobeSource.stages(name)
            val vs = runCatching { Goldens.bytes("shaders/$name.vs.glsl").toString(Charsets.UTF_8) }.getOrNull() ?: return null
            val fs = Goldens.bytes("shaders/$name.fs.glsl").toString(Charsets.UTF_8)
            return GlobeStages(vs, fs, null, null)
        }

        fun tex(w: Int, h: Int, layers: Int, format: Gl3Format, mips: Boolean, sampling: Gl3Sampling, wrap: Gl3Wrap = Gl3Wrap.CLAMP): GlobeTextureData =
            GlobeTextureData(w, h, format, sampling, wrap, Array(layers) { l ->
                val base = ByteArray(w * h * format.bytesPerTexel) { (it * 7 + l).toByte() }
                if (mips) GlobeContent.mipChain(base, w, h, format.bytesPerTexel) else arrayOf(base)
            })

        private var geo: Pair<GlobeGeography, Array<GlobeRealmGeom>>? = null
        fun geography(): Pair<GlobeGeography, Array<GlobeRealmGeom>> = geo ?: run {
            val g = GlobeGeography.fromMasks(Goldens.bytes("surface-mask.png"), Goldens.bytes("realm-mask.png"))!!
            (g to Array(GlobeV2Pin.REALMS.size) { g.realmGeom(it) }).also { geo = it }
        }

        /** The Phase E island fields' synthetic sizes (the first is over COLD_UPLOAD_BYTES, so it goes up in strips) and
         *  window half extents, one per island, distinct so a test can tell which one the outline reads. */
        val PE_SIZES = arrayOf(intArrayOf(300, 300), intArrayOf(8, 6), intArrayOf(12, 10))
        val PE_HU = doubleArrayOf(0.16, 0.13, 0.17); val PE_HV = doubleArrayOf(0.2, 0.14, 0.12)

        /** A synthetic Phase E stage as GlobeContent plans it: [on] = the world index's flag (off: the batch runs and
         *  yields null); [fail] makes it throw (an island file that does not match its pin). */
        fun phaseE(on: Boolean, fail: Boolean = false): GlobeBatch<GlobePhaseE?> =
            GlobeBatch("phase-e", listOf({ if (fail) throw GlobeContentException("world content seeker-island.webp does not match its sha256") })) {
                if (!on) null
                else GlobePhaseE(tex(16, 16, GlobeV2Pin.PHASE_E.size, Gl3Format.RGBA8, true, Gl3Sampling.LINEAR_MIPMAP_LINEAR),
                    GlobeV2Pin.PHASE_E.mapIndexed { i, s -> GlobePhaseEField(s.id, PE_SIZES[i][0], PE_SIZES[i][1], PE_HU[i], PE_HV[i], ByteArray(PE_SIZES[i][0] * PE_SIZES[i][1] * 4) { (it % 7).toByte() }) })
            }

        /** The synthetic staged content: an 8² first albedo cube, a 32² late one, and the 7 chains' islands. [failIslands]
         *  makes the islands stage throw (a chain group that cannot be read). [phaseE] adds a Phase E stage (null: none,
         *  as before the islands had one). */
        fun assets(art: GlobeArt, failIslands: Boolean = false, phaseE: GlobeBatch<GlobePhaseE?>? = null,
                   phaseENear: GlobeNearArt? = null): GlobeAssets {
            val (g, geoms) = geography()
            val fx = GlobeFxPoints(3, floatArrayOf(0f, 0f, 1f, 1f, 0f, 0f, 0f, 1f, 0f), intArrayOf(0, 0, 0, 0, 1, 0, 0, 1, 2, 1, 5, 2), ByteArray(12) { -1 })
            val first = GlobeBatch("first", listOf({ Unit }, { Unit })) {
                GlobeFirst(tex(SMALL, SMALL, 6, Gl3Format.RGBA8, true, Gl3Sampling.LINEAR_MIPMAP_LINEAR), tex(8, 8, 6, Gl3Format.RG8, true, Gl3Sampling.LINEAR_MIPMAP_LINEAR),
                    tex(8, 8, 6, Gl3Format.R8, true, Gl3Sampling.LINEAR_MIPMAP_LINEAR), tex(16, 8, 8, Gl3Format.RG16F, false, Gl3Sampling.LINEAR, Gl3Wrap.REPEAT), g, geoms)
            }
            val high = GlobeBatch("albedo-1024", listOf({ Unit })) { tex(LARGE, LARGE, 6, Gl3Format.RGBA8, true, Gl3Sampling.LINEAR_MIPMAP_LINEAR) }
            val islands = GlobeBatch("islands", listOf({ if (failIslands) throw GlobeContentException("the client pack is missing chain art") })) {
                GlobeIslands(tex(16, 16, art.chainIds.size, Gl3Format.RGBA8, true, Gl3Sampling.LINEAR_MIPMAP_LINEAR), Array(art.chainIds.size) { java.util.BitSet() },
                    art.cell / 2, art.atlas / 2, fx)
            }
            return GlobeAssets(first, high, islands, phaseE, phaseENear)
        }

        /** The near slot's stand-in size (the real one is PhaseEIslandLayer.NEAR = 2048), distinct from the 16² far layers. */
        const val NEAR_SIZE = 64
        /** The synthetic first and late albedo sizes (the 256² and 1024² cubes' stand-ins). */
        const val SMALL = 8
        const val LARGE = 32
    }
}

/** The near slots' synthetic art: a one-layer [GlobeRig.NEAR_SIZE]² mipmapped RGBA8 texture per request; [asked] records
 *  the PHASE_E index of every request, [threads] the thread each ran on, [built] each result (weakly), [cancelled] the requests that found their
 *  cancel check true (they return null, as GlobeContent's build does), and [fail] makes each request throw (as an
 *  out-of-memory resample would). */
internal class NearSource(private val fail: Throwable? = null) : GlobeNearArt {
    val asked: MutableList<Int> = java.util.Collections.synchronizedList(ArrayList<Int>())
    val threads: MutableList<String> = java.util.Collections.synchronizedList(ArrayList<String>())
    val cancelled: MutableList<Int> = java.util.Collections.synchronizedList(ArrayList<Int>())
    /** Every build returned, weakly (a test can see what still holds one). */
    val built: MutableList<java.lang.ref.WeakReference<GlobeNearBuilt>> = java.util.concurrent.CopyOnWriteArrayList()
    /** Runs inside the build, before its cancel check (a test's GL frames between two of the build's checks). */
    @Volatile var onBuild: (() -> Unit)? = null
    override fun build(island: Int, cancelled: () -> Boolean): GlobeNearBuilt? {
        asked += island; threads += Thread.currentThread().name
        fail?.let { throw it }
        onBuild?.invoke()
        if (cancelled()) { this.cancelled += island; return null }
        return GlobeNearBuilt(GlobeRig.tex(GlobeRig.NEAR_SIZE, GlobeRig.NEAR_SIZE, 1, Gl3Format.RGBA8, true, Gl3Sampling.LINEAR_MIPMAP_LINEAR))
            .also { built += java.lang.ref.WeakReference(it) }
    }
}

/**
 * A resample lane that dies inside its band loop (as an OutOfMemoryError there would): [executor] runs each helper task
 * on its own thread, whose uncaught handler records into [uncaught] (the host's world-isle threads fail the whole world
 * from theirs), and [check], used as the lanes' cancel check, throws [error] on that thread; the calling lane waits
 * for that first, so the helper always dies inside the loop.
 */
internal class DyingLane(private val error: Throwable) {
    val uncaught: MutableList<Throwable> = java.util.concurrent.CopyOnWriteArrayList()
    private val threads = java.util.concurrent.CopyOnWriteArrayList<Thread>()
    private val died = java.util.concurrent.CountDownLatch(1)
    val executor = Executor { r ->
        Thread(r, NAME).also { t -> t.isDaemon = true; t.setUncaughtExceptionHandler { _, e -> uncaught += e }; threads += t; t.start() }
    }
    fun check(): Boolean {
        if (Thread.currentThread().name == NAME) { died.countDown(); throw error }
        if (threads.isNotEmpty()) died.await(5, java.util.concurrent.TimeUnit.SECONDS) // inside a resample: its helper runs
        return false
    }
    /** Every helper thread has ended (its uncaught handler, if any, has run). */
    fun join() { for (t in threads) t.join(5000) }
    companion object { const val NAME = "isle-lane-test" }
}
