package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeGl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.FakeShareGroup
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ManualCompiler
import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder

/**
 * A world GL that remembers, for every draw, the program, the framebuffer, the texture on each unit and the last
 * `uniform3f` / `clearColor` values (the recording fake keeps names and counts only). Delegates everything to [fake].
 */
internal class ProbeGl3(val fake: FakeGl3) : Gl3 by fake {
    class Draw(val program: Int, val framebuffer: Int, val units: IntArray, val vec3: FloatArray, val blend: Boolean, val instances: Int)
    val draws = ArrayList<Draw>()
    /** uniform3f by location (the fake's location is the name's length: `uSeaFar` = 7, the minimap's `uSea` = 4). */
    val vec3 = HashMap<Int, FloatArray>()
    val clears = ArrayList<FloatArray>()
    var recording = true

    private fun snap(instances: Int) {
        if (!recording) return
        draws += Draw(fake.program, fake.framebuffer, fake.unitTextures.copyOf(), vec3[7]?.copyOf() ?: FloatArray(0), fake.blend, instances)
    }
    override fun uniform3f(location: Int, x: Float, y: Float, z: Float) { if (recording) vec3[location] = floatArrayOf(x, y, z); fake.uniform3f(location, x, y, z) }
    override fun clearColor(r: Float, g: Float, b: Float, a: Float) { if (recording) clears += floatArrayOf(r, g, b, a); fake.clearColor(r, g, b, a) }
    override fun drawArrays(mode: Int, first: Int, count: Int) { snap(1); fake.drawArrays(mode, first, count) }
    override fun drawArraysInstanced(mode: Int, first: Int, count: Int, instances: Int) { snap(instances); fake.drawArraysInstanced(mode, first, count, instances) }
}

/** [RealmGlRig] with the probe in front of the world fake. */
internal class RealmProbeRig {
    val group = FakeShareGroup()
    val fake = FakeGl3(group, "world")
    val gl = ProbeGl3(fake)
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

/**
 * A detail lane for the core's tests: its programs are created by name through the core (so they compile on the manual
 * compiler like real ones), its rehearsal hook draws a full-screen pass in the program's real state, and every call the
 * engine makes is counted. [readyFor], [settled], [bandSet], [mapReady] and whether the hook can draw are test knobs.
 */
internal class FakeLane(
    private val core: Gl3Core, override val name: String, private val programNames: List<String>,
    var bandSetValue: Int = 2,
) : RealmLane {
    private val programList = ArrayList<Gl3Program>()
    var settledValue = true
    var readySets = intArrayOf(1, 2)
    var mapReadyValue = true
    /** [mapReady] holds only after this many [update]s (GROUND's lattice resolving over the prefetch's frames). */
    var mapReadyAfterUpdates = 0
    /** When set (x0, y0, x1, y1, deeds), [mapReady] holds only for a view rect inside it: GROUND's lattice resolved there
     *  and nowhere else. */
    var mapReadyRegion: DoubleArray? = null
    var hookDraws = true
    /** Hook answers per program name (overrides [hookDraws]). */
    val hookFor = HashMap<String, Boolean>()
    var groundBands = 0
    var passesMask = 0
    var basesAt = -1
    var pickAnswer = -1
    val opened = ArrayList<RealmOpen>()
    /** Create the programs when the core opens the lane (the real lanes do it in their load). */
    var createOnOpen: Map<String, RealmProgramSource>? = null
    val rehearsed = ArrayList<String>()
    var updates = 0
    /** The view of the last [update]: d and the visible deed rect (x0, y0, x1, y1). */
    var updateD = 0.0
    val updateRect = DoubleArray(4)
    var offscreens = 0
    var draws = 0
    var groundDraws = 0
    val passes = ArrayList<Int>()
    var disposed = 0
    var basesChanges = 0
    var recordPasses = true
    /** Runs at the end of every [update] (a real lane adopts its worker's load there: its programs appear, it settles). */
    var onUpdate: (() -> Unit)? = null
    /** [adopt] calls (D-NEXT: every work frame, held or not) and a hook run in each (a real lane moves its finished
     *  load into uploads there). */
    var adopts = 0
    var onAdopt: (() -> Unit)? = null
    /** [rehearsable] answers (its inputs resident); every call is counted. */
    var rehearsableValue = true
    var rehearsableCalls = 0
    /** The order this lane was opened in, across lanes sharing [openLog]. */
    var openLog: MutableList<String>? = null

    fun create(sources: Map<String, RealmProgramSource>) {
        if (programList.isNotEmpty()) return
        val src = sources.getValue(RealmPrograms.BLIT)
        for (n in programNames) programList += core.program(n, src.vs, src.fs)
    }
    fun programNamed(n: String): Gl3Program = programList.first { it.name == n }

    override fun open(realm: RealmOpen) { opened += realm; openLog?.add(name); createOnOpen?.let { create(it) } }
    override fun adopt(nowMs: Double) { adopts++; onAdopt?.invoke() }
    override fun rehearsable(program: Gl3Program): Boolean { rehearsableCalls++; return rehearsableValue }
    override fun programs(): List<Gl3Program> = programList
    override fun bandSet(): Int = bandSetValue
    override fun settled(): Boolean = settledValue
    override fun readyFor(set: Int): Boolean = set in readySets
    override fun mapReady(view: RealmView): Boolean = mapReadyValue && updates >= mapReadyAfterUpdates &&
        (mapReadyRegion?.let { r -> view.rectX0 >= r[0] && view.rectY0 >= r[1] && view.rectX1 <= r[2] && view.rectY1 <= r[3] } ?: true)
    override fun update(view: RealmView) {
        updates++; updateD = view.d
        updateRect[0] = view.rectX0; updateRect[1] = view.rectY0; updateRect[2] = view.rectX1; updateRect[3] = view.rectY1
        onUpdate?.invoke()
    }
    override fun drawOffscreen(view: RealmView) { offscreens++ }
    override fun drawsGround(view: RealmView): Boolean = groundBands != 0 && view.bandSet >= groundBands
    override fun groundPasses(view: RealmView): Int = passesMask
    override fun drawGround(view: RealmView) {
        groundDraws++
        val p = programList.firstOrNull { it.ready } ?: return
        if (core.use(p)) core.fullscreen()
    }
    override fun drawsBases(view: RealmView): Boolean = basesAt >= 0 && view.bandSet >= basesAt
    override fun pickBase(view: RealmView, cssX: Double, cssY: Double): Int = pickAnswer
    override fun basesChanged(bases: RealmBases) { basesChanges++ }
    override fun draw(view: RealmView, pass: Int) { draws++; if (recordPasses) passes += pass }
    override fun rehearse(program: Gl3Program, target: Int, view: RealmView): Boolean {
        if (!(hookFor[program.name] ?: hookDraws)) return false
        rehearsed += "${program.name}|$target"
        if (!core.use(program)) return false
        core.fullscreen()
        return true
    }
    override fun dispose() { disposed++ }
}
