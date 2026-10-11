package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
import com.badlogic.gdx.utils.JsonWriter
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGlRig
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMeta
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackFiles
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmProgramSource
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmTestData
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmWebPin
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RgbaImage
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor

/** Records every GROUND uniform by program name and uniform name (the last value), plus a per-name call count. */
internal class RecordingSink : GroundUniformSink {
    val ints = HashMap<String, IntArray>(); val floats = HashMap<String, FloatArray>(); val calls = HashMap<String, Int>()
    /** The first value set since [reset] (the web trace records first and last per frame). */
    val firstInts = HashMap<String, IntArray>(); val firstFloats = HashMap<String, FloatArray>()
    var record = true
    fun reset() { ints.clear(); floats.clear(); calls.clear(); firstInts.clear(); firstFloats.clear() }
    /** Keyed like the web trace: by program name, without the exported define suffix (Cinderfall's "rm-map+RM_LAVA" is the
     *  web's 'rm-map' with defines { RM_LAVA }). */
    private fun k(p: Gl3Program, n: String) = p.name.substringBefore('+') + "/" + n
    private fun i(p: Gl3Program, n: String, v: IntArray) { if (!record) return; val key = k(p, n); ints[key] = v; firstInts.putIfAbsent(key, v); calls[key] = (calls[key] ?: 0) + 1 }
    private fun f(p: Gl3Program, n: String, v: FloatArray) { if (!record) return; val key = k(p, n); floats[key] = v; firstFloats.putIfAbsent(key, v); calls[key] = (calls[key] ?: 0) + 1 }
    override fun i1(p: Gl3Program, name: String, v: Int) = i(p, name, intArrayOf(v))
    override fun f1(p: Gl3Program, name: String, v: Float) = f(p, name, floatArrayOf(v))
    override fun f2(p: Gl3Program, name: String, x: Float, y: Float) = f(p, name, floatArrayOf(x, y))
    override fun f3(p: Gl3Program, name: String, x: Float, y: Float, z: Float) = f(p, name, floatArrayOf(x, y, z))
    override fun f4(p: Gl3Program, name: String, x: Float, y: Float, z: Float, w: Float) = f(p, name, floatArrayOf(x, y, z, w))
    override fun i2(p: Gl3Program, name: String, x: Int, y: Int) = i(p, name, intArrayOf(x, y))
    override fun i4(p: Gl3Program, name: String, x: Int, y: Int, z: Int, w: Int) = i(p, name, intArrayOf(x, y, z, w))
    override fun ui4(p: Gl3Program, name: String, x: Int, y: Int, z: Int, w: Int) = i(p, name, intArrayOf(x, y, z, w))
    override fun i1v(p: Gl3Program, name: String, v: IntArray, n: Int) = i(p, name, v.copyOf(n))
    override fun i2v(p: Gl3Program, name: String, v: IntArray, n: Int) = i(p, name, v.copyOf(n * 2))
    override fun i4v(p: Gl3Program, name: String, v: IntArray, n: Int) = i(p, name, v.copyOf(n * 4))
    override fun f3v(p: Gl3Program, name: String, v: FloatArray, n: Int) = f(p, name, v.copyOf(n * 3))
    override fun f4v(p: Gl3Program, name: String, v: FloatArray, n: Int) = f(p, name, v.copyOf(n * 4))
}

/** The worker side of GROUND's fresh uploads on the fake (2D and arrays, every level): adopted on [poll]. */
internal class FakeGroundUploads(private val worker: FakeGl3) : gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneUploads {
    private val pending = ArrayList<Triple<Gl3Texture, Int, Long>>()
    val filled = ArrayList<IntArray>() // [array 0/1, width, height, layers, levels, bytes]
    /** Every request's pool and format, in the order the worker receives (and fills) them; parallel to [filled]. */
    val requests = ArrayList<Pair<Gl3Pool, Gl3Format>>()
    /** Requests of these (pool, format)s keep their layer-0 level-0 bytes in [kept] (what the fill wrote). */
    var keep: Set<Pair<Gl3Pool, Gl3Format>> = emptySet()
    val kept = ArrayList<ByteArray>()
    /** Heap bytes this thread allocated inside [fresh] (the fills and the fake's own buffers): a test subtracts them to see
     *  what the lane itself allocated on the GL thread. */
    var freshAllocated = 0L
    private val bean = java.lang.management.ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
    override fun fresh(core: Gl3Core, pool: Gl3Pool, array: Boolean, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                       sampling: Gl3Sampling, wrap: Gl3Wrap, fill: gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePixelFill): Gl3Texture? {
        val tid = Thread.currentThread().id; val before = bean.getThreadAllocatedBytes(tid)
        try {
            val texture = core.reserve(pool, array, width, height, layers, format, levels) ?: return null
            val name = worker.genTexture(); val target = if (array) GL30.GL_TEXTURE_2D_ARRAY else GL20.GL_TEXTURE_2D
            worker.activeTexture(GL20.GL_TEXTURE0); worker.bindTexture(target, name)
            if (array) worker.texStorage3D(target, levels, format.internal, width, height, layers) else worker.texStorage2D(target, levels, format.internal, width, height)
            var bytes = 0
            for (layer in 0 until layers) for (level in 0 until levels) {
                val w = maxOf(1, width shr level); val h = maxOf(1, height shr level)
                val out = ByteBuffer.allocateDirect(w * h * format.bytesPerTexel).order(ByteOrder.nativeOrder())
                fill.fill(layer, level, w, h, out); bytes += out.capacity()
                if (layer == 0 && level == 0 && (pool to format) in keep) kept += ByteArray(out.capacity()).also { out.position(0); out.get(it); out.position(0) }
            }
            filled += intArrayOf(if (array) 1 else 0, width, height, layers, levels, bytes)
            requests += pool to format
            pending += Triple(texture, name, worker.fenceSync())
            return texture
        } finally { freshAllocated += bean.getThreadAllocatedBytes(tid) - before }
    }
    fun poll(core: Gl3Core) { for ((t, n, f) in pending) core.adopt(t, n, f); pending.clear() }
}

/** A pack a [GroundRig] can open: a [GroundSource] and the grid (id, size, deeds mask) the core would hand the lane. */
internal interface RigPack : GroundSource {
    val id: String
    val cols: Int
    val rows: Int
    val deeds: ByteArray
}

/**
 * A synthetic realm pack GROUND can load in a test (the real packs live outside the repo): a [cols] × [rows] grid with a
 * sea on the west third, a lake, a river across and forest in the east; the MAP / TRUE sections of Crownlands' real
 * `realm.json` (from the classify golden: families, classToTerrain, terrains, decal groups, water loops) over small
 * synthetic kits of the real cell size. Everything is deterministic. [extra] adds or replaces realm.json keys (a test's
 * `palette`, overrides).
 */
internal class SyntheticGroundPack(override val id: String = "crownlands", override val cols: Int = 60, override val rows: Int = 40, private val extra: (JsonValue) -> Unit = {}) : RigPack {
    private val golden = GroundGolden.suite("classify-crownlands")
    override val deeds = ByteArray(cols * rows) { i -> val x = i % cols; val y = i / cols; if (x in 2 until cols - 2 && y in 2 until rows - 2) 255.toByte() else 0 }

    override fun realmJson(): JsonValue {
        fun obj(vararg kv: Pair<String, JsonValue>) = JsonValue(JsonValue.ValueType.`object`).also { o -> for ((k, v) in kv) o.addChild(k, v) }
        fun num(v: Long) = JsonValue(v)
        fun str(v: String) = JsonValue(v)
        fun ints(vararg v: Long) = JsonValue(JsonValue.ValueType.array).also { a -> for (x in v) a.addChild(JsonValue(x)) }
        fun copy(v: JsonValue) = JsonReader().parse(v.toJson(JsonWriter.OutputType.json))
        val map = copy(golden.get("mapMeta"))
        map.addChild("atlas", obj("file" to str("mapkit.png"), "cell" to num(32), "cols" to num(16), "layers" to num(96), "wild" to ints(80, 8),
            "families" to obj("M1" to num(0), "M2" to num(16), "M3" to num(32), "M4" to num(48), "M5" to num(64))))
        map.addChild("mask", obj("file" to str("mapmask.png")))
        val tr = copy(golden.get("trueMeta"))
        val atlas = tr.get("atlas"); atlas.addChild("file", str("ground.png")); atlas.addChild("cell", num(32)); atlas.addChild("cols", num(16))
        tr.addChild("mask", obj("file" to str("groundmask.png")))
        tr.addChild("decals", obj("file" to str("decals.png"), "cols" to num(16), "count" to num(36)))
        return obj("schema" to num(1), "id" to str(id), "grid" to obj("cols" to num(cols.toLong()), "rows" to num(rows.toLong())),
            "classes" to obj("hasShore" to JsonValue(true)), "map" to map, "true" to tr).also(extra)
    }

    override fun bytes(key: String): ByteArray? = when (key) {
        "lines.json" -> ("{\"rivers\":[{\"pts\":[[${cols * 98 * 0.4},${rows * 98 * 0.2}],[${cols * 98 * 0.55},${rows * 98 * 0.5}],[${cols * 98 * 0.7},${rows * 98 * 0.8}]],\"hw\":[3,4,5]}]," +
            "\"tracks\":[]}").toByteArray()
        "chart8.webp" -> ByteArray(1) // decoded by [image]
        else -> null
    }

    override fun image(bytes: ByteArray, key: String): RgbaImage? = if (key == "chart8.webp") chart8() else null

    override fun png(key: String): RgbaImage? = when (key) {
        "fieldsA.png" -> img(cols * 8, rows * 8) { x, y, c -> when (c) { 0 -> if (x < cols * 8 / 3) 100 else 160; 1 -> if (hypot2(x - cols * 4, y - rows * 4) < 40) 110 else 170; 2 -> (x + y) and 255; else -> 255 } }
        "fieldsBC.png" -> img(cols * 8, rows * 4) { x, _, c -> if (c == 0 && x > cols * 3) 220 else if (c == 3) 255 else 20 }
        "mapkit.png" -> img(512, 192) { x, y, c -> if (c == 3) 255 else (x * 3 + y * 5 + c * 40) and 255 }
        "mapmask.png" -> img(512, 192) { x, y, c -> if (c == 0) (if ((x + y) % 7 == 0) 255 else 0) else if (c == 3) 255 else 0 }
        "ground.png" -> img(512, 768) { x, y, c -> if (c == 3) 255 else (x + y * 2 + c * 60) and 255 }
        "groundmask.png" -> img(512, 768) { x, y, c -> if (c == 0) (if ((x xor y) and 8 != 0) 255 else 0) else 255 }
        "decals.png" -> img(512, 96) { x, y, c -> if (c == 3) (if ((x % 32) in 8..20 && (y % 32) in 10..22) 255 else 0) else 90 }
        else -> null
    }

    private fun hypot2(a: Int, b: Int) = Math.sqrt((a * a + b * b).toDouble())
    fun chart8(): RgbaImage = img(cols * 8, rows * 8) { x, _, c -> when (c) { 0 -> if (x < cols * 8 / 3) 30 else 120; 1 -> if (x < cols * 8 / 3) 70 else 140; 2 -> if (x < cols * 8 / 3) 150 else 60; else -> 255 } }
    private fun img(w: Int, h: Int, f: (Int, Int, Int) -> Int): RgbaImage = RgbaImage(w, h, ByteArray(w * h * 4) { i -> val p = i / 4; f(p % w, p / w, i % 4).toByte() })
}

/** Runs every task at once on the caller. */
internal object Now : Executor { override fun execute(command: Runnable) = command.run() }

/** The GL world + one GROUND lane over a [SyntheticGroundPack], with a view it drives. */
internal class GroundRig(val pack: RigPack = SyntheticGroundPack(), executor: Executor = Now, sinkFor: ((Gl3Core) -> GroundUniformSink)? = null) {
    val rig = RealmGlRig()
    val sink = RecordingSink()
    val uploads = FakeGroundUploads(rig.worker)
    val plots = RealmTestData.plots
    var now = 1000.0
    val lane = GroundLane(rig.core, sinkFor?.invoke(rig.core) ?: sink, uploads, { pack }, { GroundPrograms.load(it) }, nowMs = { now })
    val bases = RealmBases(plots)
    var wakes = 0
    val open = RealmOpen(pack.id, RealmMeta(pack.id, pack.id, "ready", null, 0, 0, pack.cols, pack.rows, pack.deeds.count { it.toInt() and 0xff == 255 }, emptyMap(),
        "chart8.webp", -1, -1, "deeds.png", 255, 96), RealmGrid(0, 0, pack.cols, pack.rows, 0.5), pack.deeds, ByteArray(pack.cols * pack.rows), floatArrayOf(0.1f, 0.2f, 0.4f),
        RealmLoader(object : RealmPackFiles { override fun read(path: String): ByteArray? = null }) { _, _ -> null }, executor, 1, Runnable { wakes++ }, bases, plots, RealmWebPin.CONFIG)
    val view = RealmView()

    init {
        bases.reset(pack.cols, pack.rows)
        view.targetW = 914; view.targetH = 2034; view.dpr = 2.0; view.cols = pack.cols; view.rows = pack.rows
        view.workAllowed = true; view.uploadBytesLeft = 256 * 1024L; view.maxResolves = 0
    }

    /** Point the camera at deed (x, y) at d (device px per deed), with the band weights of that d. */
    fun look(x: Double, y: Double, d: Double, far: Double, trueW: Double) {
        view.x = x; view.y = y; view.d = d; view.s = d / view.dpr
        val hw = view.targetW / d / 2; val hh = view.targetH / d / 2
        view.rectX0 = x - hw; view.rectX1 = x + hw; view.rectY0 = y - hh; view.rectY1 = y + hh
        view.bands.far = far; view.bands.map = 1 - far; view.bands.trueW = trueW; view.bands.decor = if (d >= 200) 1.0 else 0.0
    }

    /** One realm frame through the lane in the engine's order; the worker builds programs and fills textures between. */
    fun frame(build: Boolean = true) {
        if (build) { rig.compiler.runAll(); uploads.poll(rig.core) }
        now += 16.7
        check(rig.begin())
        view.uploadBytesLeft = 256 * 1024L
        lane.update(view)
        lane.drawOffscreen(view)
        rig.core.beginScreen(0f, 0f, 0f, 1f)
        if (lane.drawsGround(view)) lane.drawGround(view)
        rig.end()
    }

    fun openAndLoad() { lane.open(open); repeat(3) { frame() } }

    /** The engine's band rehearsal for every GROUND program (one frame; bakes into their own scratch, display programs
     *  into a screen-format scratch), as `RealmMapEngine.rehearseStep` would over several idle frames. */
    fun rehearseAll() {
        now += 16.7; check(rig.begin())
        val screen = rig.core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.RGB8)!!; val depth = rig.core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.DEPTH16)!!
        for (p in lane.programs()) {
            val own = lane.rehearseScratch(p)
            if (own != null) rig.core.rehearse(own, null, false, false) { lane.rehearse(p, gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine.TARGET_OWN, view) }
            else rig.core.rehearse(screen, depth, true, false) { lane.rehearse(p, gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine.TARGET_SCREEN, view) }
        }
        rig.end()
    }
}

/** The production uniform path over a GL that ignores the vector calls (the zero-allocation gate). */
internal object NoopGroundGl : GroundGl {
    override fun uniform2i(location: Int, x: Int, y: Int) {}
    override fun uniform4i(location: Int, x: Int, y: Int, z: Int, w: Int) {}
    override fun uniform4ui(location: Int, x: Int, y: Int, z: Int, w: Int) {}
    override fun uniform1iv(location: Int, count: Int, v: IntArray, offset: Int) {}
    override fun uniform2iv(location: Int, count: Int, v: IntArray, offset: Int) {}
    override fun uniform4iv(location: Int, count: Int, v: IntArray, offset: Int) {}
    override fun uniform3fv(location: Int, count: Int, v: FloatArray, offset: Int) {}
    override fun uniform4fv(location: Int, count: Int, v: FloatArray, offset: Int) {}
}

internal fun ground(name: String): RealmProgramSource = GroundPrograms.load("crownlands").getValue(name)
