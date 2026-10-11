package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonValue
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
import gg.pixelkingdomwars.nativeclient.renderer.world.ExactPng
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.Executor

/**
 * The web presentation constants these tests run with, as `contracts.js` and `groundcost.js` define them at the shader
 * pin `globe-realms` 4de21f1a (read at fd1c0c9a; W1 fix pass 2 moved rm-record and life-creature from the TRUE
 * rehearsal set to the MAP set, because both first draw inside MAP: BANDS.pageResolve 600 and BANDS.herds 300; every
 * other value here is unchanged since 3266f710). Test inputs only: production
 * builds [RealmEngineConfig] from the generated constants. [RealmGoldenTest] checks every value here against the golden
 * `contracts.json` exported from the pinned web code, so a drifted copy fails there.
 */
internal object RealmWebPin {
    val BANDS = RealmBands(
        farEnd = 24.0, mapStart = 48.0, trueStart = 800.0, trueFull = 1100.0, impostor = doubleArrayOf(200.0, 280.0),
        rest = doubleArrayOf(24.0, 48.0, 200.0, 280.0, 800.0, 1100.0), restEaseMs = 250.0, selectD = 700.0, myBaseD = 1400.0,
        twins = doubleArrayOf(250.0, 350.0), herds = 300.0, creatures = 1100.0, sway = 2000.0, snap = 3136.0, sMax = 6272.0,
        uiDots = 24.0, uiIcons = 48.0, keepMinCss = 28.0,
    )
    val TRUE_SET = setOf("rm-true")
    val ORDER = listOf("rm-raw", "rm-despeckle", "rm-legalise", "rm-pure", "rm-chart", "rm-map", "rm-lowres-blit", "life-scatter", "life-stand",
        "life-stand-merged", "bases-sprite", "bases-shield", "bases-fx", "bases-field", "bases-dot", "minimap", "minimap-dots", "life-bird",
        "life-particle", "rm-record", "life-creature", "rm-true")
    val REHEARSAL = RealmRehearsal(idleMs = 400.0, gapMs = 32.0, retryMs = 1500.0, retryMaxMs = 6000.0, box = 8, stallMs = 8000.0,
        mapReadyHoldMs = 1500.0, trueSet = TRUE_SET, order = ORDER)
    val CONFIG = RealmEngineConfig(BANDS, REHEARSAL, groundPx = doubleArrayOf(1.5, 1.0), heavy = booleanArrayOf(true, true, false),
        chartPassFetches = 4.0, mapPassFetches = 53.0, truePassFetches = 22.0, displayBudget = 64.0, resolveBudget = 6.0,
        evictMs = 5000.0, coldUploadBytes = 262_144L, dprCap = 2.0,
        deedThisRealm = 255, deedOtherRealm = 96, deedDeg = 0.5)
    /** DEED_ART = worldTiles 98 × GRID.tilePx 32. */
    const val DEED_ART = 3136.0
    const val PLOT_CENTRE = 49
    const val LENS_MARGIN = 6
    const val RIM_GAP = 2
    const val PLOT_MARGIN = 2
    const val SALT = 0x6a09e667
}

/** Test data read from the app's bundled assets and the golden vectors. */
internal object RealmTestData {
    private val assets = File("../app/src/main/assets/native")

    fun json(file: File): JsonValue = JsonReader().parse(file.readText())

    /** Game numbers from the generated constants catalogue (never a Kotlin copy). */
    val plots: RealmPlotRules by lazy {
        val c = json(File(assets, "catalogue.json")).get("constants")
        val claims = c.get("CAMPAIGN").get("claimTilesByKeep").asIntArray()
        val walls = c.get("CAMPAIGN_LAYOUT").get("wallRingsByKeep").asIntArray()
        val tiles = c.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles")
        RealmPlotRules(claims, walls, tiles, RealmWebPin.PLOT_CENTRE, RealmWebPin.LENS_MARGIN, RealmWebPin.RIM_GAP, RealmWebPin.PLOT_MARGIN, RealmWebPin.SALT)
    }

    /** The frozen deed catalog the app ships (`fantasy/world-v1.json`). */
    val worldJson: JsonValue by lazy { json(File(assets, "fantasy/world-v1.json")) }
    val catalog: RealmCatalog by lazy {
        val regions = LinkedHashMap<String, IntArray>()
        var r = worldJson.get("regions").child
        while (r != null) {
            val runs = ArrayList<Int>()
            var run = r.get("runs").child
            while (run != null) { runs += run.getInt(0); runs += run.getInt(1); run = run.next }
            regions[r.getString("id")] = runs.toIntArray(); r = r.next
        }
        RealmCatalog(regions)
    }

    /** A golden suite exported from the pinned web code by `tools/world-golden.mjs` (fails loudly when absent). */
    fun golden(suite: String): JsonValue {
        val stream = checkNotNull(RealmTestData::class.java.getResourceAsStream("/world/golden/$suite.json")) {
            "golden suite $suite.json is missing: run node tools/world-golden.mjs --source <monorepo root>"
        }
        return JsonReader().parse(stream.use { it.readBytes().toString(Charsets.UTF_8) })
    }

    fun resource(path: String): ByteArray? = RealmTestData::class.java.getResourceAsStream(path)?.use { it.readBytes() }
}

/** The synthetic fixture packs (`tools/world-fixtures.mjs`) as a [RealmPackFiles]; [outer] = an outer manifest. */
internal class FixturePack(private val pack: String, private val outer: Map<String, String> = emptyMap()) : RealmPackFiles {
    val reads = ArrayList<String>()
    override fun read(path: String): ByteArray? { reads += path; return RealmTestData.resource("/world/fixtures/packs/$pack/$path") }
    override fun expectedSha256(path: String): String? = outer[path]
}

/** The fixtures' chart8 is a PNG (the JVM decodes no WebP): straight RGBA through the exact decoder. */
internal val PNG_DECODER = RealmImageDecoder { bytes, _ -> ExactPng.decode(bytes)?.let { RgbaImage(it.width, it.height, it.rgba) } }

/** Runs every task at once on the caller (decode "threads" in tests). */
internal object DirectExecutor : Executor { override fun execute(command: Runnable) = command.run() }

/** Queues tasks until [runAll] (a decode thread that has not run yet). */
internal class QueuedExecutor : Executor {
    val tasks = ArrayList<Runnable>()
    override fun execute(command: Runnable) { tasks += command }
    fun runAll() { val t = tasks.toList(); tasks.clear(); t.forEach { it.run() } }
}

/**
 * The worker side of `StagingUploader.fresh` on the fake: reserves room on the GL side, creates and fills the texture on
 * the worker fake (sharing the world fake's objects), fences it, and hands it back on [poll] like the real uploader.
 */
internal class FakeRealmUploads(private val worker: FakeGl3) : RealmUploads {
    private val pending = ArrayList<Triple<Gl3Texture, Int, Long>>()
    val filled = ArrayList<IntArray>() // [width, height, levels, bytes]
    var refuse = false

    override fun fresh(core: Gl3Core, pool: Gl3Pool, width: Int, height: Int, format: Gl3Format, levels: Int,
                       sampling: Gl3Sampling, wrap: Gl3Wrap, fill: RealmPixelFill): Gl3Texture? {
        if (refuse) return null
        val texture = core.reserve(pool, false, width, height, 1, format, levels) ?: return null
        val name = worker.genTexture()
        worker.activeTexture(GL20.GL_TEXTURE0); worker.bindTexture(GL20.GL_TEXTURE_2D, name)
        worker.texStorage2D(GL20.GL_TEXTURE_2D, levels, format.internal, width, height)
        var bytes = 0
        for (level in 0 until levels) {
            val w = maxOf(1, width shr level); val h = maxOf(1, height shr level)
            val out = ByteBuffer.allocateDirect(w * h * format.bytesPerTexel).order(ByteOrder.nativeOrder())
            fill.fill(level, w, h, out)
            bytes += out.capacity()
        }
        filled += intArrayOf(width, height, levels, bytes)
        pending += Triple(texture, name, worker.fenceSync())
        return texture
    }

    fun poll(core: Gl3Core) { for ((t, n, f) in pending) core.adopt(t, n, f); pending.clear() }
}

/** A world fake, its worker, a manual compiler and a strict core: the realm engine's GL world in tests. */
internal class RealmGlRig {
    val group = FakeShareGroup()
    val gl = FakeGl3(group, "world")
    val worker = FakeGl3(group, "worker")
    val compiler = ManualCompiler(ProgramBuilder(worker, null, "RealmView", 0))
    val core = Gl3Core(gl, compiler, 256 * 1024L, strict = true)
    val uploads = FakeRealmUploads(worker)
    var nowMs = 1000.0
    var contextId = 1L
    init { core.resize(914, 2034) }

    fun begin(): Boolean = core.beginFrame((nowMs * 1e6).toLong(), contextId)
    fun end() = core.endFrame((nowMs * 1e6).toLong())
}
