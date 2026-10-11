package gg.pixelkingdomwars.nativeclient.scene.world

import android.content.res.AssetManager
import android.opengl.EGL14
import android.opengl.GLES20
import android.os.Build
import android.os.Process
import com.badlogic.gdx.ApplicationListener
import com.badlogic.gdx.Gdx
import com.badlogic.gdx.InputProcessor
import com.badlogic.gdx.utils.JsonReader
import gg.pixelkingdomwars.nativeclient.renderer.GlobeArt
import gg.pixelkingdomwars.nativeclient.renderer.RealmKitRules
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Idle
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeAssets
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeContent
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeContentException
import gg.pixelkingdomwars.nativeclient.renderer.globe2.DiveCoverClock
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeEvents
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeFiles
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeImageDecoder
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobePickV2
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobePixels
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeRgba
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeUploader
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Pin
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Renderer
import gg.pixelkingdomwars.nativeclient.renderer.globe2.WorldShadersGlobeSource
import gg.pixelkingdomwars.nativeclient.renderer.globe2.globeLayoutFromView
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBand
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmCamera
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmDiveFade
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmEngineWiring
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLoader
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapListener
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapStats
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmPackException
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmResumeLanding
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmSeam
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmSeamCamera
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BasesBandsIn
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BasesLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.BasesRules
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.Decor
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorGame
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases.DecorTables
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GlGroundUniforms
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundChartUnder
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundStats
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.OpenGroundSource
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePack
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeBandsIn
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeGeometry
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeTablesFile
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.Scatter
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3FrameReport
import gg.pixelkingdomwars.nativeclient.renderer.world.FrameLadder
import gg.pixelkingdomwars.nativeclient.renderer.world.HangGuard
import gg.pixelkingdomwars.nativeclient.renderer.world.IdlePolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderInputs
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.ThermalStatus
import gg.pixelkingdomwars.nativeclient.renderer.world.IdleScheduler
import gg.pixelkingdomwars.nativeclient.renderer.world.InputScale
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldEngine
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameExchange
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameSampler
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntentSink
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntents
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldScene
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import gg.pixelkingdomwars.nativeclient.scene.AndroidGl3
import gg.pixelkingdomwars.nativeclient.scene.EglWorkerContexts
import gg.pixelkingdomwars.nativeclient.scene.PixelSource
import gg.pixelkingdomwars.nativeclient.scene.SharedContextCompiler
import gg.pixelkingdomwars.nativeclient.scene.StagingUploader
import gg.pixelkingdomwars.nativeclient.scene.WorldGraphics
import gg.pixelkingdomwars.nativeclient.ui.world.BaseEntryCamera
import gg.pixelkingdomwars.nativeclient.ui.world.BaseSeamSpec
import gg.pixelkingdomwars.nativeclient.ui.world.GlobeHudLayout
import gg.pixelkingdomwars.nativeclient.ui.world.MinimapGesture
import gg.pixelkingdomwars.nativeclient.ui.world.RealmGridInfo
import gg.pixelkingdomwars.nativeclient.ui.world.RealmResume
import gg.pixelkingdomwars.nativeclient.ui.world.WorldEngineControls
import gg.pixelkingdomwars.nativeclient.ui.world.WorldHudEvent
import java.io.Closeable
import java.io.File
import java.lang.ref.WeakReference
import java.util.Locale
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.ThreadFactory
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.function.DoubleSupplier

/** What the GL30 world needs from the app for one World entry (lead integration, N1/N2). All bytes it reads are
 *  hash-checked: the bundled world content against `world/content.json`, the client-pack globe files against the render
 *  catalogue's `fantasy.globe.files` (the same pins `WorldContent` verified them against at install). */
class WorldHostInputs(
    val assets: AssetManager,
    /** The bundled world content (`app/src/main/assets/world`, every build type since N5, D-175). */
    val world: AssetWorldFiles,
    /** Globe files of the client pack: the verified world overview, then the chain groups (exploration island art). */
    val pack: GlobeFiles,
    /** The legacy island model (RG-1) or null (no exploration islands: the globe still runs). */
    val art: GlobeArt?,
    /** The realm map's game numbers from the constants catalogue, or null (no realm maps: the globe still runs). */
    val catalogue: RealmEngineWiring.CatalogueNumbers?,
    /** Display density (px per dp) of the World surface. */
    val density: Double,
    /** Closed when the host is disposed (chain-group leases). */
    val resources: Closeable? = null,
    /** The device's crash record ([HangMemory]); null (the smoke) persists nothing and starts at L0. */
    val hangStore: HangRecordStore? = null,
)

/** GL thread → the UI thread. The fragment implements every call by posting to the main looper, epoch-guarded. */
interface WorldHostCallbacks {
    fun ready()
    fun failed(reason: String)
    /** One presented frame was published into the exchange (the implementation conflates to one post per vsync). */
    fun framePublished()
    fun event(event: WorldHudEvent)
    fun mapRealms(ids: Set<String>)
    fun readiness(realmId: String, value: Float)
    fun realmGrid(info: RealmGridInfo?)
    /** The globe's loading meter (NG `loadProgress`, 0..1, in 1 % steps) while it prepares its first frame. */
    fun loading(value: Float)
    /** A once-per-second debug line (engine, mode, fps, realm status) for the debug readout. */
    fun status(line: String)
    /** The realm map's band readiness cue (NM `onGate` → NU's scale pill "detail N%"), conflated by the engine. */
    fun bandGate(held: Boolean, band: Int, progress: Double)
    /** The mapped realms whose detail pack (GROUND's class inputs) is in this build: NU's MY PARCEL/My base ask for TRUE
     *  there, MAP with the deed selected elsewhere (F7). Sent once, when the realm engine is built. */
    fun detailRealms(ids: Set<String>)
}

/**
 * The N1/N2 world host (lead integration): one GL30 context that draws the flat globe ([GlobeV2Renderer], lane NG) and
 * the overview realm maps ([RealmMapEngine], lane NM), fed by the Compose HUD's intents (lane NU) and publishing
 * [gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrame]s back to it (GLOBE-NATIVE-PLAN §3.2–§3.5, §5.9).
 *
 * GL thread only (libGDX `ApplicationListener` + `InputProcessor`), except [controls], [setLayout], [setFocus] and
 * [viewSize] (UI thread), which only enqueue or write volatile fields.
 *
 * Modes: GLOBE → (the globe's `dive` event) DIVE_WAIT until the realm is ready → FADE_IN (a realm snapshot faded over
 * the live globe, NM's recommended order) → REALM (the realm frame binds the screen itself) → (Leave or a pinch-out)
 * FADE_OUT (the realm's last frame faded out over the globe's fly-out) → GLOBE. Uploads and first draws run only when
 * work is allowed: never inside a globe flight or a fade (plan §5.3).
 *
 * Safety: any failure before or during a frame hands the World tab back to the legacy globe ([WorldHostCallbacks.failed]
 * → the HUD's fallback); rule violations are counted, not thrown ([Gl3Core] non-strict in the owner build).
 */
class WorldEngineHost(
    private val inputs: WorldHostInputs,
    private val graphics: () -> WorldGraphics?,
    private val callbacks: WorldHostCallbacks,
    private val programRoot: File,
    private val versionCode: Long,
    private val log: (String) -> Unit,
) : ApplicationListener, InputProcessor {
    /** Render-target px per dp: the web's `min(2, devicePixelRatio)` (plan §5.5). */
    val dpr: Double = InputScale.dpr(inputs.density)
    val exchange = WorldFrameExchange(ANCHORS)
    private val intents = WorldIntents { graphics()?.pacer?.markDirty() }
    private val commands = ConcurrentLinkedQueue<Command>()
    private val input = InputScale()
    private val idle = IdleScheduler(IdlePolicy(Idle.FULL_MS.toLong(), Idle.FULL_CAP_FPS, Idle.CAP_FPS, Idle.FREEZE_MS.toLong()))
    private val sampler = WorldFrameSampler()
    /** GPU safety (plan §5.4): the hang guard (web GPU_SAFE, from the generated constants) floors the native 60-fps
     *  ladder; the ladder's knobs go to the globe (clouds, shimmer, animation) and its level to the realm map. Its crash
     *  record persists ([memory], N5): a real freeze (a visit that died inside the realm map, a lost context, a frozen
     *  frame; never a slow-frame trip) starts later sessions safe (their steady frames let the guard go) until clean
     *  realm-map visits or its day clear it ([HangMemory.sampled]). The
     *  ladder's LIFE cap is 0 until the N3 lanes are built, which replace it (before the first frame) with one whose L0
     *  cap is LIFE's phone cap, halved from L1 (plan §5.4). */
    private val hang = HangGuard(HangMemory.POLICY)
    private val memory = HangMemory(hang, inputs.hangStore, System::currentTimeMillis)
    private var ladder = FrameLadder(LadderPolicy.PLAN, LadderInputs(GpuSafe.GROUND_PX[0], 0))
    private var lastFrameNanos = 0L
    private var lastFrameMotion = false

    @Volatile private var viewW = 0
    @Volatile private var viewH = 0
    @Volatile private var focusDx = 0.0
    @Volatile private var focusDy = 0.0
    private var fixedW = 0
    private var fixedH = 0

    private var core: Gl3Core? = null
    private var staging: StagingUploader? = null
    private var globe: GlobeV2Renderer? = null
    private var realm: RealmMapEngine? = null
    private var lanes: DetailLanes? = null
    private var mapIds: Set<String> = emptySet()
    private var loadPool: ExecutorService? = null
    /** The Phase E near art's extra resample lanes ([islandPool]); shut down with [loadPool]. */
    private var islePool: ExecutorService? = null
    /** The shared GL worker: the GL teardown stops it through the core's compiler, [releaseWithoutGl] directly. */
    private var worker: WorldGlWorker? = null
    /** Set by the first of [dispose] and [releaseWithoutGl]; the other then does nothing. */
    private val released = AtomicBoolean(false)
    /** True once the host gave its world back ([dispose] on the GL thread, or [releaseWithoutGl]). */
    val disposed: Boolean get() = released.get()

    private var mode = MODE_GLOBE
    private var bufferW = 1
    private var bufferH = 1
    private var frameNow = 0.0
    private var createdMs = 0.0
    private var loadWaitMs = -1.0
    /** The guarded SwiftShader emulator decodes and JIT-compiles shaders on the CPU, several times slower than a phone:
     *  it gets longer bounds so the smoke tests the engine, not the emulator's speed (never performance evidence). */
    private val emulator = WorldEngineGuard.isEmulator(Build.HARDWARE)
    private val loadTimeoutMs = if (emulator) EMULATOR_LOAD_TIMEOUT_MS else LOAD_TIMEOUT_MS
    private val diveStall = DiveStall(if (emulator) EMULATOR_DIVE_STALL_MS else DIVE_STALL_MS)
    private val diveWaitLog = DiveWaitLog()
    /** The clouds over a dive that waits (the owner's fallback, D-NEXT): unseen unless the wait passes 400 ms. */
    private val cover = DiveCoverClock()
    /** A frame of this render pass was presented (the ladder counts only presented motion frames). */
    private var presented = false
    @Volatile private var failure: String? = null
    private var readySent = false
    private var lastLayout: GlobeHudLayout? = null
    private var lastMotionMs = 0.0

    // the dive in progress and the realm on screen
    private var diveRealm: String? = null
    private var diveLon = 0.0
    private var diveLat = 0.0
    private var diveS = 0.0
    private var shownRealm: String? = null
    /** The dive in progress is a resume ([resumeRealm]): it lands on this camera, and a failure leaves the globe clean. */
    private var resumeAt: RealmResume? = null
    /** When a resume's landing began ([diveStep]): the map is up under its clouds, waiting for its ground ([landingStep]);
     *  NaN once it is on screen (or none). */
    private var landingSince = Double.NaN
    private val landingHeld: Boolean get() = !landingSince.isNaN()
    /** The landing realm's GROUND lane stats, null when the realm has no detail pack (read once at the landing). */
    private var landingGround: GroundStats? = null
    private var leaveRequested = false
    private var readinessRealm: String? = null
    private var readinessSent = -1f
    private var loadingSent = -1
    // the realm's band and lane rehearsal, logged on change only (smoke and Seeker evidence)
    private var loggedBand = -1
    private var loggedPairs = -1
    private var loggedFloor = -1.0
    // the enter-base seam (OPEN BASE on your own deed): the flight to the kingdom and the wait for its TRUE picture
    private val seamWait = SeamWait(if (emulator) EMULATOR_DIVE_STALL_MS else SEAM_WAIT_MS)
    private val seamOut = RealmSeamCamera()
    private var seamKey: String? = null
    private var seam: RealmSeam? = null
    private var seamSpec: BaseSeamSpec? = null

    // the once-per-second debug line
    private var statusT0 = 0.0
    private var statusFrames = 0

    init { WorldLiveInstances.track(WorldLiveRegistry.HOST, this) }

    // ---------------------------------------------------------------- UI thread

    /** The HUD's UI → GL controls (NU's [WorldEngineControls]); every call only enqueues. */
    val controls: WorldEngineControls = object : WorldEngineControls {
        override fun offer(intent: WorldIntent) = intents.offer(intent)
        override fun zoom(steps: Int) = post { now ->
            if (mode == MODE_REALM) seamCancel("the zoom took the camera")
            when (mode) {
                MODE_REALM -> realm?.zoomBy(Math.pow(REALM_ZOOM_STEP, steps.toDouble()))
                MODE_GLOBE -> globe?.zoomBy(GLOBE_ZOOM_STEP * steps)
            }
            idle.input(now.toLong())
        }
        override fun home() = post { now -> if (mode == MODE_GLOBE) globe?.home(now) }
        // a minimap tap flies the map and a drag of its view box moves it; a double tap and a pinch zoom the minimap alone
        override fun minimap(gesture: MinimapGesture) = post { now -> if (mode == MODE_REALM) realm?.let {
            if (gesture is MinimapGesture.Tap || gesture is MinimapGesture.DragTo) seamCancel("the minimap took the camera")
            minimapGesture(it, gesture)
        }; idle.input(now.toLong()) }
        override fun minimapRect(viewRect: FloatArray?) = post { _ ->
            val r = realm ?: return@post
            if (viewRect == null) r.setMinimapRect(0.0, 0.0, 0.0, 0.0)
            else r.setMinimapRect(dp(input.viewToBufferX(viewRect[0])), dp(input.viewToBufferY(viewRect[1])),
                dp(input.viewToBufferX(viewRect[2])), dp(input.viewToBufferY(viewRect[3])))
        }
        override fun enterBase(catalogX: Int, catalogY: Int, seam: BaseSeamSpec) = post { now -> startSeam(catalogX, catalogY, seam, now) }
        override fun cancelBase() = post { _ ->
            if (seamWait.pending) { log("[world-engine] seam ${seamWait.catalogX},${seamWait.catalogY} cancelled by the HUD"); seamWait.clear() }
        }
        override fun resume(target: RealmResume) = post { _ -> resumeRealm(target) }
    }

    /** UI thread: the globe framing from the HUD (VIEW px); converted on the GL thread with the current [InputScale]. */
    fun setLayout(layout: GlobeHudLayout?) = post { _ -> lastLayout = layout; applyLayout() }

    /** UI thread: ui.js `focusOffset()` in dp (the realm camera's offset from a selected base beside the card). */
    fun setFocus(dx: Float, dy: Float) { focusDx = dx.toDouble(); focusDy = dy.toDouble() }

    /**
     * UI thread, on every layout of the surface view: fix its buffer at the engine's dpr (plan §5.5, 1200 px at density
     * 2.625 → 914) through [setFixedSize]; the GL thread's [resize] then sees the buffer and [InputScale] maps touches.
     */
    fun viewSize(width: Int, height: Int, setFixedSize: (Int, Int) -> Unit) {
        if (width <= 0 || height <= 0) return
        viewW = width; viewH = height
        val w = InputScale.fixedBufferSide(width, inputs.density); val h = InputScale.fixedBufferSide(height, inputs.density)
        if (w != fixedW || h != fixedH) { fixedW = w; fixedH = h; setFixedSize(w, h) }
    }

    private fun interface Command { fun run(nowMs: Double) }
    private fun post(command: Command) { commands.offer(command); graphics()?.pacer?.markDirty() }

    // ---------------------------------------------------------------- lifecycle (GL thread)

    override fun create() {
        Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY)
        createdMs = nowMs(); statusT0 = createdMs
        memory.start()
        if (hang.level > 0) log("[world-engine] hang guard starts at L${hang.level} (${hang.reason})")
        val world = graphics()
        val choice = WorldEngineGuard.decide(Build.HARDWARE, Gdx.gl?.glGetString(GLES20.GL_RENDERER), world?.getGL30() != null,
            Gdx.gl?.glGetString(GLES20.GL_VERSION), Gdx.gl?.glGetString(GLES20.GL_EXTENSIONS))
        log("[world-engine] ${choice.choice} ${choice.reason}")
        if (!choice.gl30 || world == null) { fail("the GL30 world is unavailable here: ${choice.reason}"); return }
        try { start(world, choice.paths) } catch (e: Exception) { fail("the GL30 world failed to start: ${e.message ?: e.javaClass.simpleName}"); return }
        WorldLiveInstances.log("create", core, log)
        Gdx.input.inputProcessor = this
        world.frameListener = WorldGraphics.FrameListener { start, cpu ->
            sampler.frame(start, if (mode == MODE_REALM) WorldScene.REALM else WorldScene.GLOBE, world.pacer.isContinuous, cpu, 0L)?.let { log("[world-perf] ${it.toJson()}") }
        }
    }

    private fun start(world: WorldGraphics, paths: Gles3Paths) {
        val spec = world.contextFactory.created ?: error("no world context spec")
        val gl = AndroidGl3(paths)
        // The worker thread (a GC root while it runs) holds these lambdas: they capture locals, never the host.
        val say = log; val root = programRoot; val code = versionCode
        val setup = SharedContextCompiler.create(
            worldGl = gl,
            contexts = EglWorkerContexts(spec) { say("[world-engine] $it") },
            share = EGL14.eglGetCurrentContext(),
            currentShare = { EGL14.eglGetCurrentContext() },
            cacheFactory = { g -> WorldGl30Listener.programCache(g, root, code) },
            threadSetup = EglWorkerContexts.workerThreadSetup {},
            log = { say("[world-engine] $it") },
        )
        log("[world-engine] compiler: ${setup.reason}")
        // Lead decision: without a shared worker context there is no off-thread upload path for the realm maps, and
        // the plan's "fill before the first frame" fallback is not built: the legacy globe runs instead.
        val worker = setup.worker ?: run { setup.compiler.dispose(); error("no shared worker context (${setup.reason})") }
        this.worker = worker
        val pacer = world.pacer
        // Non-strict in the owner build: a frame-order violation is counted and dropped, never thrown on the device.
        val c = Gl3Core(gl, setup.compiler, GpuSafe.COLD_UPLOAD_BYTES.toLong(), strict = false, wake = Runnable { pacer.markDirty() })
        core = c
        val up = StagingUploader(worker, Executors.newFixedThreadPool(2, daemon("world-decode")), DirectBufferPool.world(),
            { pacer.markDirty() }, stagingCopy = paths.stagingCopy, log = { say("[world-engine] uploader: $it") })
        staging = up
        val pool = Executors.newFixedThreadPool(2, daemon("world-load"))
        loadPool = pool
        islePool = islandPool()
        val g = GlobeV2Renderer(c, WorldShadersGlobeSource, { loadGlobe() }, pool, globeUploader(up), inputs.art, globeEvents, idle, exchange, input, dpr)
        globe = g
        WorldLiveInstances.track(WorldLiveRegistry.GLOBE, g)
        realm = buildRealm(c, up, pool, g)?.also { WorldLiveInstances.track(WorldLiveRegistry.ENGINE, it) }
        g.start()
    }

    /** The realm engine and the bundled realm index (small verified reads); null keeps the globe without dives. */
    private fun buildRealm(c: Gl3Core, up: StagingUploader, pool: ExecutorService, g: GlobeV2Renderer): RealmMapEngine? {
        val numbers = inputs.catalogue ?: run { log("[world-engine] no catalogue numbers: realm maps are off"); return null }
        return try {
            val loader = RealmLoader(inputs.world, BitmapRealmImages)
            val ids = loader.index().map { it.id }.toSet()
            val detail = detailLanes(c, up, numbers)
            val engine = RealmMapEngine(c, RealmEngineWiring.config(), numbers.plots, numbers.deedArt, loader, realmCatalog(inputs.assets),
                StagingRealmUploads(up), pool, DoubleSupplier { nowMs() }, RealmDiveFade.PLAN_FADE_MS, lanes = detail?.list ?: emptyList())
            engine.listener = realmListener
            engine.inputListener = { idle.input(nowMs().toLong()); graphics()?.pacer?.markDirty() }
            // NM host hooks: lanes wake the pacer when a worker result waits; the ladder's knobs set LIFE's cap and the
            // resolve slices per level; GROUND draws the core's chart under MAP (NR `chartUnder`)
            engine.wakeListener = Runnable { graphics()?.pacer?.markDirty() }
            engine.ladderKnobs = ladder.knobs
            detail?.ground?.chartUnder = GroundChartUnder { _, alpha, fieldsA -> engine.drawChartUnder(fieldsA, alpha) }
            lanes = detail
            mapIds = ids
            g.divable = ids
            callbacks.mapRealms(ids)
            callbacks.detailRealms(if (detail == null) emptySet() else ids.filterTo(HashSet()) { hasDetail(it) })
            log("[world-engine] realm maps: ${ids.sorted().joinToString(",")}; detail lanes ${if (detail == null) "off" else "ground, life, bases"}")
            engine
        } catch (e: Exception) {
            log("[world-engine] realm maps unavailable: ${e.message}")
            null
        }
    }

    /** The N3 detail lanes, in map.js order (NR GROUND, NL LIFE and BASES). */
    private class DetailLanes(val ground: GroundLane, val life: LifeLane, val bases: BasesLane) {
        val list: List<gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane> = listOf(ground, life, bases)
    }

    /**
     * The N3 lanes over the host's shared seams: one fresh-texture adapter over the worker uploader (GROUND, LIFE and BASES
     * share it), the GLES30 integer/array uniforms, the verified world bundle as their pack ([LanePack], GROUND's
     * [OpenGroundSource]) and the admitted catalogue's game numbers. Null (logged) when the catalogue lacks the lanes'
     * sections or a table does not load: the realm maps then stay the core's FAR overview (in its own sea, with base
     * dots), never a half-wired lane. GL thread, once, before the first frame (two small table parses).
     */
    private fun detailLanes(c: Gl3Core, up: StagingUploader, numbers: RealmEngineWiring.CatalogueNumbers): DetailLanes? {
        val constants = numbers.constants ?: run { log("[world-engine] no catalogue constants: realm maps stay at the overview"); return null }
        return try {
            val uploads = StagingLaneUploads(up)
            val pack = LanePack(inputs.world, BitmapRealmImages)
            val ground = GroundLane(c, GlGroundUniforms(c, Gles30LaneUniforms), uploads, { open -> OpenGroundSource(open) { id -> realmJson(id) } },
                maxTextureSize = c.gl.getInteger(GLES20.GL_MAX_TEXTURE_SIZE), nowMs = { nowMs() })
            val lifeTables = LifeTablesFile.load()
            val geo = LifeGeometry(constants.get("GRID").getInt("tilePx"), constants.get("BASE_GROUND_WORLD_GEOMETRY").getInt("worldTiles"),
                lifeTables.constants.pinnedMapArt)
            val life = LifeLane(c, lifeTables, Scatter(lifeTables.constants, geo), LifeBandsIn.fromGenerated(), pack, uploads, ground,
                intUniforms = Gles30LaneUniforms)
            val decor = DecorTables.load()
            val bases = BasesLane(c, decor, Decor(decor, DecorGame.fromCatalogue(constants), numbers.plots), BasesBandsIn.fromGenerated(), pack,
                uploads, ground, BasesRules.MsClock { nowMs() })
            // LIFE's phone cap at L0, halved from L1 (FrameLadder.knobs); no frame has run yet, so no ladder state is lost
            ladder = FrameLadder(LadderPolicy.PLAN, LadderInputs(GpuSafe.GROUND_PX[0], lifeTables.constants.submittedPhone))
            DetailLanes(ground, life, bases)
        } catch (e: Exception) {
            log("[world-engine] detail lanes unavailable (${e.javaClass.simpleName}: ${e.message}); realm maps stay at the overview")
            null
        }
    }

    /** Decode thread: `realm/<id>/realm.json` for GROUND, checked against the world bundle's manifest (the core's loader
     *  keeps no raw copy of it). */
    private fun realmJson(id: String): ByteArray {
        val path = "realm/$id/realm.json"
        val bytes = inputs.world.read(path) ?: throw RealmPackException("$path is missing")
        if (RealmLoader.sha256Hex(bytes) != inputs.world.expectedSha256(path).lowercase()) throw RealmPackException("$path does not match the sha256 the content manifest pins")
        return bytes
    }

    /** The bundle carries the realm's GROUND class inputs (the manifest lists them; each read is still verified). */
    private fun hasDetail(id: String): Boolean = DETAIL_KEYS.all { inputs.world.expectedSha256("realm/$id/$it").isNotEmpty() }

    /** Decode thread: the globe's content. When the exploration islands' art cannot be read (a chain group that is not
     *  installed and cannot be fetched), the globe loads without them rather than not at all (logged). */
    private fun loadGlobe(): GlobeAssets {
        val world = AssetGlobeFiles(inputs.world)
        val ids = GlobeV2Pin.REALMS.map { it.id }
        val lanes = islePool
        return try { GlobeContent(world, inputs.pack, BitmapGlobeImages, inputs.art, ids, nearHelpers = lanes, nearLanes = if (lanes == null) 1 else ISLE_HELPERS + 1).load() }
        catch (e: GlobeContentException) {
            if (inputs.art == null) throw e
            log("[world-engine] exploration islands unavailable (${e.message}); the globe loads without them")
            GlobeContent(world, inputs.pack, BitmapGlobeImages, null, ids, nearHelpers = lanes, nearLanes = if (lanes == null) 1 else ISLE_HELPERS + 1).load()
        }
    }

    /**
     * The Phase E islands' near-art lanes (owner 2026-09-27: the islands "take long time to load"): [ISLE_HELPERS] threads
     * that a near resample fans its row bands out to beside its own world-load thread, below normal priority so the GL
     * and UI threads keep their cores during the selection flight the build now overlaps. Idle threads end after
     * [ISLE_KEEP_ALIVE_S] (no thread stays up between approaches); the teardowns shut it down with the load pool.
     */
    private fun islandPool(): ExecutorService {
        val base = daemon("world-isle")
        val low = ThreadFactory { r -> base.newThread(r).apply { priority = Thread.NORM_PRIORITY - 2 } }
        return java.util.concurrent.ThreadPoolExecutor(ISLE_HELPERS, ISLE_HELPERS, ISLE_KEEP_ALIVE_S, java.util.concurrent.TimeUnit.SECONDS,
            java.util.concurrent.LinkedBlockingQueue(), low).apply { allowCoreThreadTimeOut(true) }
    }

    private fun globeUploader(up: StagingUploader) = object : GlobeUploader {
        override val fillsAfterFirstFrame: Boolean get() = true
        override fun fresh(core: Gl3Core, pool: Gl3Pool, width: Int, height: Int, layers: Int, format: Gl3Format, levels: Int,
                           sampling: Gl3Sampling, wrap: Gl3Wrap, pixels: GlobePixels): Gl3Texture? =
            up.fresh(core, pool, true, width, height, layers, format, levels, sampling, wrap, object : PixelSource {
                override fun decode(layer: Int, level: Int, width: Int, height: Int, out: java.nio.ByteBuffer) = pixels.fill(layer, level, width, height, out)
                // a big level goes up in StagingUploader.FILL_BAND_BYTES bands (the islands' 16 MiB near level 0)
                override fun decodesRows(): Boolean = pixels.fillsRows()
                override fun decodeRows(layer: Int, level: Int, width: Int, height: Int, y0: Int, rows: Int, out: java.nio.ByteBuffer) =
                    pixels.fillRows(layer, level, width, y0, rows, out)
            })
        // The host polls once per frame, and only when work is allowed (never in a flight or a fade, plan §5.7).
        override fun poll(core: Gl3Core) {}
    }

    override fun resize(width: Int, height: Int) {
        bufferW = maxOf(1, width); bufferH = maxOf(1, height)
        input.set(if (viewW > 0) viewW else bufferW, if (viewH > 0) viewH else bufferH, bufferW, bufferH)
        guarded("resize") {
            core?.resize(bufferW, bufferH)
            realm?.setViewport(bufferW, bufferH, dpr)
            applyLayout()
        }
        log("[world-engine] buffer ${bufferW}x$bufferH for view ${viewW}x$viewH (dpr $dpr)")
    }

    /** GL-thread entry points outside [render] (resize, touch): a failure hands the tab back to the legacy globe. */
    private inline fun guarded(what: String, block: () -> Unit) {
        try { block() } catch (e: Exception) { fail("the GL30 world failed in $what: ${e.javaClass.simpleName}: ${e.message}") }
    }

    private fun applyLayout() {
        val l = lastLayout ?: return
        globe?.layout = globeLayoutFromView(l.headerBottom, l.obstacles, l.count, l.panelFree, input)
    }

    override fun pause() {
        memory.realm(false) // a pause is a clean leave: the pending marker goes (the next frame after a resume sets it again)
        sampler.pause()
        WorldGdxStatics.clearGl30()
    }

    override fun resume() {
        WorldGdxStatics.restoreGl30(graphics()?.getGL30())
        graphics()?.pacer?.markDirty()
    }

    /**
     * O(1) (plan §5.9): `glDelete*` only, no join. P0 (the 2026-09-26 Seeker OutOfMemoryError): every heavy reference
     * goes first (the globe, the realm engine, the detail lanes, the uploader, the core, the load pool), so a host that
     * stays reachable afterwards (libGDX's `Gdx.app`, the HUD bridge) holds no realm data: a lane load finishing after the
     * dispose had kept 48.7 MB alive through [lanes], which was never cleared. Then each step runs in its own try
     * ([WorldTeardown]): a step that throws is logged and never skips the ones after it (a globe that threw here had left
     * the realm, the uploader, the core, the pool and the chain leases alive). Once per host, shared with
     * [releaseWithoutGl].
     */
    override fun dispose() {
        if (!released.compareAndSet(false, true)) return
        memory.realm(false)
        val g = globe; val r = realm; val s = staging; val c = core; val p = loadPool; val ip = islePool
        globe = null; realm = null; lanes = null; mapIds = emptySet(); staging = null; core = null; loadPool = null; islePool = null; worker = null
        commands.clear(); cover.reset()
        WorldTeardown.run({ log("[world-engine] $it") },
            "globe" to { g?.dispose() }, "realm" to { r?.dispose() }, "staging" to { s?.dispose() }, "core" to { c?.dispose() },
            "pool" to { p?.shutdownNow() }, "isle pool" to { ip?.shutdownNow() }, "resources" to { inputs.resources?.close() },
            "input" to { Gdx.input?.let { if (it.inputProcessor === this) it.inputProcessor = null } },
            "frames" to { graphics()?.frameListener = null },
            "statics" to { WorldGdxStatics.clearGl30() })
        for (o in listOfNotNull(g, r, this)) WorldLiveInstances.disposed(o)
        WorldLiveInstances.log("dispose", c, log)
    }

    /**
     * UI thread, from the World fragment's onDestroyView: the release of a host libGDX never disposed. libGDX 1.13.1
     * destroys its graphics (and so runs [dispose] on the GL thread) only in `AndroidFragmentApplication.onPause`, and only
     * while the fragment is being removed or the activity is finishing (javap: it has no onDestroy override). An activity
     * recreation with the World tab open (a dark-mode flip, a font-size or locale change: MainActivity's configChanges
     * lists none of them) is neither, and nothing else disposed the host: its pools and GL worker ran on, and a live thread
     * is a GC root, so each recreation stranded a whole world and the share group's GPU memory beside the new activity's
     * host (P0, 2026-09-26).
     *
     * No GL: no context is current on the UI thread, and the GL thread is paused since onPause. The GL names die with
     * their contexts: the surface's when its view detaches, the worker's when the worker stops. So this stops the threads
     * (both pools shut down; the worker is sent STOP and destroys its own context), closes the chain leases and drops
     * every heavy reference, each step in its own try ([WorldTeardown]). Once per host: after a [dispose] (a normal leave
     * runs it inside onPause, before onDestroyView) it does nothing, and a dispose after it does nothing.
     */
    fun releaseWithoutGl() {
        if (!released.compareAndSet(false, true)) return
        val g = globe; val r = realm; val s = staging; val c = core; val p = loadPool; val ip = islePool; val w = worker
        globe = null; realm = null; lanes = null; mapIds = emptySet(); staging = null; core = null; loadPool = null; islePool = null; worker = null
        commands.clear()
        WorldTeardown.run({ log("[world-engine] $it") },
            "staging" to { s?.dispose() }, "worker" to { w?.dispose() }, "pool" to { p?.shutdownNow() },
            "isle pool" to { ip?.shutdownNow() }, "resources" to { inputs.resources?.close() },
            "input" to { Gdx.input?.let { if (it.inputProcessor === this) it.inputProcessor = null } },
            "frames" to { graphics()?.frameListener = null })
        for (o in listOfNotNull(g, r, this)) WorldLiveInstances.disposed(o)
        WorldLiveInstances.log("release without GL", c, log)
    }

    // ---------------------------------------------------------------- the frame (GL thread)

    override fun render() {
        val c = core
        if (c == null || failure != null) { blank(); return }
        val nanos = System.nanoTime()
        val now = nanos / 1e6
        frameNow = now
        if (!c.beginFrame(nanos, graphics()?.contextHandle ?: EGL14.eglGetCurrentContext().nativeHandle)) { schedule(now); return }
        memory.realm(realmMarked()) // before any GL work of the frame (the realm's first frame after a resume)
        var report: Gl3FrameReport? = null
        presented = false
        try {
            frame(c, now)
        } catch (e: Exception) {
            fail("the GL30 world stopped: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            report = c.endFrame(System.nanoTime()) // the fence's time is its insertion: this frame's CPU time is never GPU time
        }
        report?.let { quality(it, nanos) }
        memory.realm(realmMarked()) // cleared once the realm is ready behind the globe, a leave or a failed dive ended
        idle.frameRendered(now.toLong())
        status(now)
        schedule(now)
    }

    private fun frame(c: Gl3Core, now: Double) {
        val g = globe ?: return
        val r = realm
        while (true) { val command = commands.poll() ?: break; command.run(now) }
        intents.drain(sink)
        if (leaveRequested && mode == MODE_REALM) { leaveRequested = false; startLeave(now) }
        val fading = mode == MODE_FADE_IN || mode == MODE_FADE_OUT
        val work = !fading && !g.camera.flying
        // the approach's hang marker is written off the GL thread: no realm GPU work until it is on disk (ms)
        val realmWork = work && memory.onDisk
        r?.update(now, realmWork)
        if (work) staging?.poll(c, GpuSafe.COLD_UPLOAD_BYTES.toLong())
        when (mode) {
            MODE_GLOBE, MODE_DIVE_WAIT -> {
                val drawn = g.update(now, bufferW, bufferH, ladder.current)
                if (!g.ready) {
                    // measured from when this wait began (the first frame, or a context restore after a resume), never from
                    // create(): a restore minutes into the session must get its own full load window
                    if (loadWaitMs < 0) loadWaitMs = now
                    publishLoading(g.loadProgress)
                    if (now - loadWaitMs > loadTimeoutMs) fail("the globe did not load in ${(loadTimeoutMs / 1000).toInt()} s")
                    return // NG's rule: nothing binds the screen until the globe is ready
                }
                loadWaitMs = -1.0
                // the islands' state at the reveal (owner 2026-10-06: they must be in the first frame): true and true is the
                // fix working; false after a wait of GlobeV2Renderer.ISLAND_HOLD_MS means they outlasted the hold
                if (!readySent) { readySent = true; callbacks.ready(); log("[world-engine] globe ready in ${(now - createdMs).toLong()} ms " +
                    "(exploration islands ${g.islandsShown}, phase-e islands ${g.phaseE.enabled}, waited ${g.islandWaitMs.toLong()} ms for them)") }
                if (g.camera.flying || g.gestures.active > 0 || g.camera.hasVel) lastMotionMs = now
                if (mode == MODE_DIVE_WAIT) diveStep(g, r, now)
                // D-NEXT: a prepared realm (the panel's, or the approach's core) keeps prefetching behind the globe
                // after its core is ready (prefetchDue); the hang marker covers that work too ([realmMarked])
                else if (r != null && r.realmId != null && (!r.ready || r.prefetchDue) && realmWork && now - lastMotionMs >= GpuSafe.REHEARSE_IDLE_MS) r.rehearseStep(now)
                if (drawn) {
                    // NG: the ladder's half-scale sphere (L2+) is an offscreen pass, so it comes before the screen pass;
                    // never on a fade's first frame (fades draw the globe at full scale)
                    if (mode != MODE_FADE_IN) g.drawOffscreen()
                    c.beginScreen(GlobeV2Renderer.SKY_R, GlobeV2Renderer.SKY_G, GlobeV2Renderer.SKY_B, 1f)
                    g.draw()
                    if (mode == MODE_FADE_IN) r?.compositeFade(now)
                    drawCover(g, now) // over a dive that waits, its fade's first frame, or a failed dive parting
                    callbacks.framePublished(); presented = true
                }
                if (mode == MODE_GLOBE) publishReadiness(r)
            }
            MODE_FADE_IN, MODE_FADE_OUT -> {
                val rr = r ?: run { mode = MODE_GLOBE; return }
                g.update(now, bufferW, bufferH, ladder.current)
                c.beginScreen(GlobeV2Renderer.SKY_R, GlobeV2Renderer.SKY_G, GlobeV2Renderer.SKY_B, 1f)
                g.draw()
                rr.compositeFade(now)
                if (mode == MODE_FADE_IN) drawCover(g, now) // the snapshot fade runs under the clouds; a leave has none
                idle.setMoving(true)
                callbacks.framePublished(); presented = true
                if (rr.fade.done(now)) {
                    rr.fade.finish()
                    val id = shownRealm
                    if (mode == MODE_FADE_IN) { if (id != null) { g.diveResult(true, id, now); enteredRealm(rr, id) } else mode = MODE_GLOBE }
                    else { mode = MODE_GLOBE; shownRealm = null; if (id != null) callbacks.event(WorldHudEvent.Left(id)) }
                }
            }
            MODE_REALM -> {
                val rr = r ?: run { mode = MODE_GLOBE; return }
                if (rr.waiting) rr.rehearseStep(now)
                val moving = rr.frame(now, idle.clockMs, idle.frozen) // binds the screen itself (NM)
                if (landingHeld) landingStep(g, rr, now)
                // the clouds part only over the live realm, never over a frozen frame, nor over a resume's chart stand-in
                if (!rr.waiting && !landingHeld) cover.live(now)
                drawCover(g, now)
                idle.setMoving(moving || rr.fade.fading)
                idle.animating(IdleScheduler.TAG_SELECT, rr.selectionPeriodMs())
                lanes?.let { l ->
                    // NL: the lanes' idle animations after their update (LIFE clips/creatures, BASES keeps, shield domes)
                    idle.animating(IdleScheduler.TAG_LIFE, l.life.animationPeriodMs)
                    idle.animating(IdleScheduler.TAG_BASES, l.bases.animationPeriodMs)
                    idle.animating(IdleScheduler.TAG_SHIELD, l.bases.shieldPeriodMs)
                    idle.animating(IdleScheduler.TAG_GROUND, l.ground.idlePeriodMs()) // stage B: the gem loop and MAP drift
                }
                logBand(rr)
                seamStep(rr, now)
                val f = exchange.back()
                f.engine = WorldEngine.REALM; f.ladderLevel = rr.ladderLevel
                f.cameraX = rr.cam.x; f.cameraY = rr.cam.y; f.cameraScale = rr.cam.d; f.anchorCount = 0
                exchange.publish()
                callbacks.framePublished(); presented = true
            }
        }
    }

    // ---------------------------------------------------------------- dive and leave (plan §3.5)

    private fun beginDive(realmId: String, lon: Double, lat: Double, sStart: Double) {
        diveRealm = realmId; diveLon = lon; diveLat = lat; diveS = sStart; diveStall.start(frameNow); diveWaitLog.start(); resumeAt = null
        cover.start(frameNow)
        mode = MODE_DIVE_WAIT
        memory.realm(true) // on disk before this frame's diveStep draws (a rehearsal pair, or a ready map's first frame)
        callbacks.event(WorldHudEvent.Diving(realmId)) // a pinch-in dive too: the globe's controls hide through it (NU)
        WorldLiveInstances.log("dive $realmId", core, log)
        val r = realm ?: return
        if (r.realmId != realmId || r.status == RealmMapEngine.STATUS_FAILED) r.prepare(realmId)
        log("[world-engine] dive $realmId (map ${if (r.ready) "ready" else "loading"})")
    }

    private fun diveStep(g: GlobeV2Renderer, r: RealmMapEngine?, now: Double) {
        val id = diveRealm ?: run { mode = MODE_GLOBE; return }
        if (r == null) { failDive(g, id, "no realm engine", now); return }
        if (r.realmId == id && r.status == RealmMapEngine.STATUS_FAILED) { failDive(g, id, r.stats.failure ?: "the map failed to load", now); return }
        if (r.realmId != id) r.prepare(id)
        if (!memory.onDisk) return // the approach's marker is still on its way to disk: no rehearsal, no entry before it
        if (!r.ready) {
            r.rehearseStep(now)
            // the HUD's dive watchdog re-arms on this; the host gives up only once it stops moving (D-NEXT: the core's
            // readiness, the FAR set a dive waits for)
            val v = r.readiness()
            publishReadiness(id, v, diving = true)
            if (WorldLog.enabled && diveWaitLog.due(now)) log(DiveWaitLog.line(id, r.stats, lanes?.list))
            if (diveStall.stalled(now, v)) failDive(g, id, "the map made no progress for ${(diveStall.stallMs / 1000).toInt()} s", now)
            return
        }
        cover.ready(now) // the clouds (if the wait raised them) stop rising; the snapshot fade runs under them
        r.setViewport(bufferW, bufferH, dpr)
        if (!r.enter(diveLon, diveLat, diveS)) { failDive(g, id, "the map refused the entry", now); return }
        val resuming = resumeAt != null
        resumeAt?.let { landResume(r, it, dpr); log("[world-engine] resume $id at d ${it.d.toInt()}") }; resumeAt = null
        shownRealm = id; diveRealm = null
        cancelTouches(g, null)
        // A resume lands at the old MAP/TRUE camera, past the MAP-data hold, before any lane is in: the map stays under its
        // clouds as live frames until its own ground draws there ([landingStep]). No snapshot fade: under full clouds it
        // was 450 ms unseen, in which no lane could adopt a load.
        if (resuming) { mode = MODE_REALM; landingSince = now; landingGround = lanes?.ground?.takeIf { hasDetail(id) }?.stats; diveStall.start(now); return }
        if (r.renderSnapshot(idle.clockMs, idle.frozen)) { r.fade.start(RealmDiveFade.DIVE, now); mode = MODE_FADE_IN }
        else { g.diveResult(true, id, now); enteredRealm(r, id) }
    }

    private fun failDive(g: GlobeV2Renderer, id: String, reason: String, now: Double) {
        log("[world-engine] dive $id failed: $reason")
        diveRealm = null; mode = MODE_GLOBE
        cover.failed(now) // the clouds part onto the globe
        // a resume never went through the globe's own dive: its globe stays clean (no realm selected), as the HUD's does
        if (resumeAt == null) g.diveResult(false, id, now)
        resumeAt = null
        callbacks.event(WorldHudEvent.DiveFailed(id, reason))
    }

    /**
     * Each live frame of a resume's landing ([diveStep]). The old camera sits at MAP or TRUE, where the core's chart (other
     * realms' deeds veiled per deed: grey hard-edged squares, which the owner rejected) stands in until GROUND's data is in,
     * its pairs rehearsed and the view's lattice resolved; then MAP popped in over it. So the clouds stay up and the HUD
     * stays on its dive until the resumed band's own ground drew this frame ([RealmResumeLanding.landed]): the first frame
     * the player sees is the real map at the saved spot. Bounded as the dive's wait ([diveStall]: the lanes' progress, not
     * the core's, stopped for its bound), with each step posted so the HUD's dive watchdog re-arms; past that it lands on
     * what it has.
     */
    private fun landingStep(g: GlobeV2Renderer, r: RealmMapEngine, now: Double) {
        val id = shownRealm ?: run { landingSince = Double.NaN; return }
        // GROUND is lane 0 of DetailLanes.list; a disabled GROUND (a program failed) never draws, as one with no detail pack
        val ground = landingGround?.takeIf { (r.stats.lanesDisabled and 1) == 0 }
        val landed = RealmResumeLanding.landed(r.stats.band, r.stats.groundPass, ground)
        val progress = RealmResumeLanding.progress(r.stats, ground)
        if (!landed && !diveStall.stalled(now, progress)) { publishReadiness(id, landingMeter(progress), diving = true); return }
        log("[world-engine] resume $id ${if (landed) "landed on its ground" else "landed without it (no lane progress in ${(diveStall.stallMs / 1000).toInt()} s)"}" +
            " in ${(now - landingSince).toLong()} ms at band ${r.stats.band}")
        landingSince = Double.NaN
        g.diveResult(true, id, now); enteredRealm(r, id) // the clouds part from this frame on
    }

    /** Back (or the HUD's dive watchdog) during a resume's landing: cancelled as in its wait ([failDive]), never left
     *  through a fade, whose snapshot would be the chart stand-in this landing hides. The clouds part onto the new engine's
     *  globe, which a resume never touched, and the HUD hears DiveFailed. */
    private fun cancelLanding(now: Double) {
        val id = shownRealm
        landingSince = Double.NaN
        realm?.leave(now)
        for (tag in REALM_TAGS) idle.animating(tag, 0)
        shownRealm = null; mode = MODE_GLOBE
        cover.failed(now)
        log("[world-engine] resume $id cancelled on its landing")
        id?.let { callbacks.event(WorldHudEvent.DiveFailed(it, "cancelled")) }
    }

    /**
     * The HUD's resume (UI → GL, [WorldEngineControls.resume]): the app stopped on [target]'s realm map, whose host was
     * released, and this new host starts on the globe. The owner (Seeker code 31) chose "Same map, same spot": a dive
     * straight into that realm, skipping the globe's flight, under clouds that are up from its first frame (this
     * engine's globe is not the place the player left), landing on the old camera ([diveStep]) and staying under them
     * until its own ground drew there ([landingStep]). The wait is a normal dive's: its readiness posts, its stall bound.
     * Where no dive can start ([resumeRefusal]) the HUD hears DiveFailed at once and falls back to the clean globe, never
     * at its 12 s watchdog.
     */
    private fun resumeRealm(target: RealmResume) {
        val g = globe; val r = realm
        val why = resumeRefusal(g?.ready == true, r != null, mode, target.realmId in mapIds)
        if (why != null) {
            log("[world-engine] resume ${target.realmId} refused: $why")
            callbacks.event(WorldHudEvent.DiveFailed(target.realmId, "resume refused: $why")); return
        }
        beginDive(target.realmId, 0.0, 0.0, 0.0) // the placement comes from the old camera, not the globe
        resumeAt = target
        cover.start(frameNow - cover.showAfterMs - cover.rampMs)
    }

    /** The dive's clouds over the frame drawn so far (last in the screen pass); nothing unless a wait raised them. */
    private fun drawCover(g: GlobeV2Renderer, now: Double) {
        if (mode == MODE_GLOBE) cover.failed(now) // on the globe the clouds only ever part (a dive that ended any way)
        val a = cover.alpha(now)
        if (a > 0.0) g.drawCover(a.toFloat(), cover.seconds(now), bufferW, bufferH)
    }

    private fun enteredRealm(r: RealmMapEngine, id: String) {
        mode = MODE_REALM
        // the globe sleeps: its idle animations stop declaring frames (the realm declares its own)
        idle.animating(IdleScheduler.TAG_WATER, 0); idle.animating(IdleScheduler.TAG_CLOUDS, 0); idle.animating(IdleScheduler.TAG_ISLANDS, 0)
        r.grid?.let { callbacks.realmGrid(RealmGridInfo(id, it.x0, it.y0, it.cols, it.rows)) }
        loggedBand = -1; loggedPairs = -1; loggedFloor = -1.0
        callbacks.event(WorldHudEvent.Dived(id))
        log("[world-engine] realm $id on screen (mask mismatch ${r.stats.maskMismatch}, pairs ${r.stats.pairsRehearsed}/${r.stats.pairsTotal})")
    }

    /** At frame start, before any pass: the realm's last frame into the fade snapshot, then the globe's fly-out. */
    private fun startLeave(now: Double) {
        val r = realm ?: return
        val g = globe ?: return
        val id = shownRealm ?: return
        // map.js exit: ui.hide() before onExit. The realm HUD (the minimap's frame) goes before the first fade frame,
        // never standing over the GL minimap while it fades out with the snapshot (a pinch-out has no HUD tap before it)
        callbacks.event(WorldHudEvent.Leaving(id))
        cover.reset() // never drawn for a leave
        if (seamWait.pending) { log("[world-engine] seam ${seamWait.catalogX},${seamWait.catalogY} cancelled by the leave"); seamWait.clear() }
        val snap = r.renderSnapshot(idle.clockMs, idle.frozen)
        cancelTouches(null, r)
        // the realm's idle animations end with it (the globe declares its own again)
        for (tag in REALM_TAGS) idle.animating(tag, 0)
        val at = r.leave(now)
        g.leave(id, at[0], at[1], now)
        callbacks.realmGrid(null)
        if (snap) { r.fade.start(RealmDiveFade.LEAVE, now); mode = MODE_FADE_OUT }
        else { mode = MODE_GLOBE; shownRealm = null; callbacks.event(WorldHudEvent.Left(id)) }
        log("[world-engine] leave $id")
    }

    /** One line per band or rest-floor change and once when the lanes' rehearsal completes (Seeker/smoke evidence; never
     *  per frame). D-173's check: once landed, every line reads band ≥ 2 (MAP) with floor 48 (`BANDS.mapStart`);
     *  LANDVALVE marks a landing the stall valve released before the lanes' MAP set was in. */
    private fun logBand(r: RealmMapEngine) {
        val st = r.stats
        val done = st.lanePairsTotal > 0 && st.lanePairsRehearsed >= st.lanePairsTotal
        if (st.band == loggedBand && st.floorD == loggedFloor && (!done || loggedPairs == st.lanePairsTotal)) return
        if (done) loggedPairs = st.lanePairsTotal
        loggedBand = st.band; loggedFloor = st.floorD
        val l = lanes
        log("[world-engine] realm ${st.realm} band ${st.band} d ${st.d.toInt()} floor ${st.floorD.toInt()}${if (st.landValveOpened) " LANDVALVE" else ""}" +
            " k ${st.groundScale} · lane pairs ${st.lanePairsRehearsed}/${st.lanePairsTotal}" +
            " (nothing ${st.lanePairsNothing}) held 0x${Integer.toHexString(st.lanesHeld)} disabled 0x${Integer.toHexString(st.lanesDisabled)}" +
            " gate ${st.gateBand}/${st.gateReason}${if (st.valveOpened) " VALVE" else ""} dots ${st.occupancyDots}" +
            (l?.let { " · ground ${it.ground.stats.status} map ${it.ground.stats.mapReady} true ${it.ground.stats.trueReady}${it.ground.stats.error?.let { e -> " ERR $e" } ?: ""}" +
                " · life ${it.life.stats.why} draws ${it.life.stats.draws} · bases ${it.bases.stats.why} keeps ${it.bases.stats.keeps} domes ${it.bases.stats.domes}" } ?: ""))
    }

    private fun cancelTouches(g: GlobeV2Renderer?, r: RealmMapEngine?) {
        for (p in 0 until MAX_POINTERS) { g?.touchCancelled(p); r?.touchCancel(p) }
    }

    private fun publishReadiness(r: RealmMapEngine?) {
        val id = r?.realmId ?: return
        publishReadiness(id, r.readiness())
    }

    /** One post per [postedReadiness] step, never per frame. */
    private fun publishReadiness(id: String, readiness: Double, diving: Boolean = false) {
        val v = postedReadiness(readiness, diving)
        if (id != readinessRealm || v != readinessSent) { readinessRealm = id; readinessSent = v; callbacks.readiness(id, v) }
    }

    /** The HUD's loading meter, conflated to 1 % steps (one post per step, never per frame). */
    private fun publishLoading(v: Float) {
        val p = (v * 100).toInt()
        if (p != loadingSent) { loadingSent = p; callbacks.loading(p / 100f) }
    }

    // ---------------------------------------------------------------- intents (GL thread, frame start)

    private val sink = WorldIntentSink { intent -> applyIntent(intent) }

    private fun applyIntent(intent: WorldIntent) {
        val now = frameNow
        val g = globe ?: return
        val r = realm
        when (intent) {
            is WorldIntent.SetBases -> r?.setBases(intent.bases) // kept until that realm's grid exists (NM)
            is WorldIntent.SetFilter -> r?.setFilter(intent.filter)
            is WorldIntent.SetNight -> g.apply(intent, now)
            is WorldIntent.SetReducedMotion -> { g.apply(intent, now); r?.reducedMotion = intent.reduced; idle.reducedMotion = intent.reduced }
            is WorldIntent.SetUiRects -> Unit // the HUD places its own labels (NU); the engines frame with setLayout
            WorldIntent.Leave -> when (mode) {
                MODE_REALM -> if (landingHeld) cancelLanding(now) else leaveRequested = true
                MODE_FADE_IN -> leaveRequested = true
                MODE_DIVE_WAIT -> diveRealm?.let { failDive(g, it, "cancelled", now) }
                // Nothing to leave (a HUD that believed a map was up): said at once, or the HUD sat LEAVING, which composes
                // no HUD, until its 4 s watchdog (owner, Seeker code 31: "for seconds screen loses HUD visibility"). Enter
                // map's approach flight is still the globe's: its dive is withdrawn first, or the flight's end pulled the
                // player into the map after the HUD was back on the globe (the HUD's dive watchdog lands here too)
                MODE_GLOBE -> {
                    g.cancelDive(now)?.let { log("[world-engine] dive $it cancelled on its approach") }
                    callbacks.event(WorldHudEvent.NothingToLeave)
                }
                else -> Unit // MODE_FADE_OUT: a leave runs already; its Left follows
            }
            is WorldIntent.Select -> if (mode == MODE_REALM) {
                when (val t = intent.target) {
                    is WorldTarget.Deed -> r?.selectCatalogDeed(t.deedX, t.deedY, fly = false, focusDx = focusDx, focusDy = focusDy)
                    null -> r?.select(-1)
                    else -> Unit
                }
            } else if (mode == MODE_GLOBE) {
                g.apply(intent, now)
                (intent.target as? WorldTarget.Realm)?.let { prepare(it.realmId) }
            }
            is WorldIntent.FlyTo -> if (mode == MODE_REALM) (intent.target as? WorldTarget.Deed)?.let { seamCancel("a flight took the camera"); flyToDeed(r, it, intent.d) }
                else if (mode == MODE_GLOBE) g.apply(intent, now)
            is WorldIntent.Dive -> if (mode == MODE_GLOBE) { prepare(intent.realmId); g.apply(intent, now) }
        }
    }

    /**
     * D-NEXT approach prefetch: the globe rests low over a realm with a map, or a pinch aims below it ([GlobeEvents.approach],
     * conflated by the globe). Only the core's FAR set loads (`lanes = false`, ~8 MB of GL), so a pinch dive that follows
     * is warm (0.47 s measured) instead of cold. Never over an open realm or outside the globe. The engine keeps a realm
     * already resident as it is (a panel's full prepare stays full; a core-only one's eviction starts again).
     */
    private fun prefetchApproach(realmId: String) {
        val r = realm ?: return
        if (mode != MODE_GLOBE || realmId !in mapIds || r.active) return
        if (!r.prepare(realmId, /* lanes = */ false)) return
        // mid-pinch: the commit runs on the hang writer, and the frame holds the realm's GPU work until it landed
        memory.realm(realmMarked(), background = true)
        log("[world-engine] approach $realmId: core prefetch")
    }

    /** The realm panel opened (Select(Realm)): start loading its map so "Enter map" is warm (NM `prepare`). */
    private fun prepare(realmId: String) {
        val r = realm ?: return
        if (realmId !in mapIds || r.active) return
        r.prepare(realmId)
        memory.realm(realmMarked()) // before this frame's update adopts it (programs, textures) and idle frames rehearse it
    }

    /** The crash record's pending marker ([HangMemory.realm]) for the current state ([realmMarked]). */
    private fun realmMarked(): Boolean =
        realmMarked(mode, realm?.realmId, realm?.status ?: RealmMapEngine.STATUS_NONE, realm?.prefetchDue == true)

    /** FlyTo(Deed, d) in catalog columns/rows, centred beside the card like map.js `select` (focusOffset ÷ s). */
    private fun flyToDeed(r: RealmMapEngine?, t: WorldTarget.Deed, d: Double?) {
        val rr = r ?: return
        val grid = rr.grid ?: return
        if (t.deedX !in 0 until RealmGrid.LATTICE_W || t.deedY !in 0 until RealmGrid.LATTICE_H) return
        val tile = t.deedY * RealmGrid.LATTICE_W + t.deedX
        val x = grid.deedX(tile); if (x < 0) return
        val y = grid.deedY(tile)
        val dT = d ?: rr.config.bands.selectD
        val sT = dT / dpr
        rr.flyToDeed(x + 0.5 + focusDx / sT, y + 0.5 + focusDy / sT, dT)
    }

    private fun minimapGesture(r: RealmMapEngine, g: MinimapGesture) {
        when (g) {
            is MinimapGesture.Tap -> r.minimapTap(dp(input.viewToBufferX(g.x)), dp(input.viewToBufferY(g.y)))
            MinimapGesture.DoubleTap -> r.minimapDoubleTap()
            is MinimapGesture.DragStart -> r.minimapDragStart(dp(input.viewToBufferX(g.x)), dp(input.viewToBufferY(g.y)))
            is MinimapGesture.DragTo -> r.minimapDragTo(dp(input.viewToBufferX(g.x)), dp(input.viewToBufferY(g.y)))
            MinimapGesture.DragEnd -> r.minimapDragEnd()
            is MinimapGesture.Pinch -> r.minimapPinch(g.scale.toDouble())
        }
    }

    private fun dp(bufferPx: Float): Double = bufferPx / dpr

    // ---------------------------------------------------------------- the enter-base seam (N3, D-162.3; GL thread)

    /**
     * OPEN BASE on your own deed: fly the realm map to the kingdom's plot centre at the base scene's opening scale
     * ([RealmSeam.landingD]: its zoom floor on this surface, the drawn realm-kit field covering the whole screen the base
     * scene draws on (D-185), at a rest the base keeps), then [seamStep] hands the base
     * scene that camera once the map rests there on the lane's TRUE ground. Answered at once with no camera where the map
     * cannot get there (no realm map on screen, no TRUE ground for it, a deed outside it): the base opens at its fit.
     */
    private fun startSeam(catalogX: Int, catalogY: Int, spec: BaseSeamSpec, now: Double) {
        val r = realm; val id = shownRealm; val grid = r?.grid; val s = seamRules(spec); val plots = inputs.catalogue?.plots
        val tile = catalogY * RealmGrid.LATTICE_W + catalogX
        val dx = if (grid == null || catalogX !in 0 until RealmGrid.LATTICE_W || catalogY !in 0 until RealmGrid.LATTICE_H) -1 else grid.deedX(tile)
        val why = when {
            mode != MODE_REALM || r == null || id == null || grid == null -> "no realm map on screen"
            s == null || plots == null -> "no seam numbers"
            lanes == null || !hasDetail(id) -> "no TRUE ground for $id"
            dx < 0 -> "the deed is not in $id"
            else -> null
        }
        if (why != null || r == null || grid == null || s == null || plots == null) {
            seamWait.clear(); log("[world-engine] seam $catalogX,$catalogY: $why; the base opens at its own fit")
            callbacks.event(WorldHudEvent.BaseSeam(catalogX, catalogY, null)); return
        }
        val dy = grid.deedY(tile)
        val b = r.bases.baseAt(dx, dy); val level = if (b >= 0) r.bases.level[b] else 0 // as seamToBase reads it
        val bands = r.config.bands
        val d = s.landingD(bufferW / dpr, bufferH / dpr, dpr, bands.trueFull, bands.snap, bands.sMax)
        val centre = s.kit.plotTiles / 2.0 * s.kit.tilePixels // the base scene's plot centre, art px
        r.flyToDeed(s.realmU(dx, dy, level, centre), s.realmV(dx, dy, level, centre), d, SEAM_FLY_MS)
        seamWait.start(catalogX, catalogY, now); seamSpec = spec
        log("[world-engine] seam $catalogX,$catalogY L$level: fly from d ${r.cam.d.toInt()} to d ${d.toInt()}")
    }

    /** The seam from the HUD's kit numbers and the host's plot rules, parsed once per spec (a few hundred bytes). */
    private fun seamRules(spec: BaseSeamSpec): RealmSeam? {
        if (spec.kitConstants == seamKey) return seam
        seamKey = spec.kitConstants
        seam = try { inputs.catalogue?.let { RealmSeam(RealmKitRules.read(JsonReader().parse(spec.kitConstants)), it.plots) } }
        catch (e: Exception) { log("[world-engine] seam numbers refused: ${e.javaClass.simpleName}: ${e.message}"); null }
        return seam
    }

    /** Each realm frame while OPEN BASE waits: the camera goes to the base scene once the map rests on the deed at full
     *  TRUE with a lane's TRUE ground drawn alone ([RealmSeamCamera.seamless]); the wait bound gives up. */
    private fun seamStep(r: RealmMapEngine, now: Double) {
        if (!seamWait.pending) return
        val s = seam; val spec = seamSpec
        val cx = seamWait.catalogX; val cy = seamWait.catalogY
        if (s == null || spec == null || !r.seamToBase(s, cx, cy, inputs.density, seamOut)) { seamGiveUp("the deed left the map"); return }
        when (seamWait.step(now, seamOut.seamless, r.cam.moving)) {
            SeamWait.HAND_OFF -> {
                val k = s.worldPerArt(spec.worldTilePixels)
                val camera = BaseEntryCamera((seamOut.baseX * k).toFloat(), (seamOut.baseY * k).toFloat(), (seamOut.zoom * k).toFloat())
                log("[world-engine] seam $cx,$cy seamless at d ${seamOut.d.toInt()} in ${(now - seamWait.since).toInt()} ms: base ${camera.worldX},${camera.worldY} zoom ${camera.zoom}")
                seamWait.clear(); callbacks.event(WorldHudEvent.BaseSeam(cx, cy, camera))
            }
            SeamWait.GIVE_UP -> seamGiveUp("not seamless in ${seamWait.waitMs.toInt()} ms (d ${seamOut.d.toInt()}, band ${r.stats.band}, moving ${r.cam.moving})")
        }
    }

    private fun seamGiveUp(why: String) {
        if (!seamWait.pending) return
        val cx = seamWait.catalogX; val cy = seamWait.catalogY
        seamWait.clear(); log("[world-engine] seam $cx,$cy gave up: $why; the base opens at its own fit")
        callbacks.event(WorldHudEvent.BaseSeam(cx, cy, null))
    }

    /** The player took the camera while OPEN BASE waited (a touch on the map, the HUD's zoom, minimap or a flight): the
     *  wait ends and nothing opens. A pinch-out's first finger lands here long before its leave (D-173: it returns to the
     *  globe), and a tap elsewhere is the player looking elsewhere; opening the base at its fit took both into the base. */
    private fun seamCancel(why: String) {
        if (!seamWait.pending) return
        val cx = seamWait.catalogX; val cy = seamWait.catalogY
        seamWait.clear(); log("[world-engine] seam $cx,$cy cancelled: $why; nothing opens")
        callbacks.event(WorldHudEvent.BaseSeamCancelled(cx, cy))
    }

    // ---------------------------------------------------------------- engine events (GL thread → UI)

    private val globeEvents = object : GlobeEvents {
        override fun unavailable(reason: String) = fail("the globe is unavailable: $reason")
        override fun picked(pick: GlobePickV2) = callbacks.event(WorldHudEvent.GlobePick(target(pick)))
        /** D-172: a Phase E island tap is reported by this alone (never [picked]); the HUD opens its panel from it. A realm's
         *  selection arrives here too, and the HUD leaves it to [picked] (`WorldHudFlow.globeSelected`). */
        override fun selected(realmId: String?, islandId: String?) = callbacks.event(WorldHudEvent.GlobeSelected(realmId, islandId))
        override fun dive(realmId: String, lon: Double, lat: Double, sStartCss: Double) = beginDive(realmId, lon, lat, sStartCss)
        override fun approach(realmId: String) = prefetchApproach(realmId)
        override fun noMap(realmId: String?) = callbacks.event(WorldHudEvent.NoMap(realmId))
        override fun partUnavailable(part: String, reason: String) = log("[world-engine] globe part unavailable: $part: $reason")
        /** The islands' near art (owner 2026-09-27): where a Seeker approach's time goes, to confirm the ranking on device. */
        override fun nearArt(islandId: String, cached: Boolean, decodeMs: Double, resampleMs: Double, mipMs: Double, uploadMs: Double, totalMs: Double,
                             blurMs: Double, inFlight: Boolean) {
            if (!WorldLog.enabled) return
            log(nearPerfLine(islandId, cached, decodeMs, resampleMs, mipMs, uploadMs, totalMs, blurMs, inFlight))
        }
    }

    /** NG → NU: a realm, an exploration island (`<chainId>/<slot>`, or the chain id alone for a chain picked by its
     *  cells: the EXPLORE panel opens on that chain), or nothing (sea, space). */
    private fun target(pick: GlobePickV2): WorldTarget? = when (pick) {
        is GlobePickV2.Realm -> WorldTarget.Realm(pick.id)
        is GlobePickV2.Exploration -> inputs.art?.chainIds?.getOrNull(pick.chain)?.let { chain -> WorldTarget.Island(pick.island?.let { "$chain/$it" } ?: chain) }
        else -> null
    }

    private val realmListener = object : RealmMapListener {
        override fun onExit(lon: Double, lat: Double) { if (mode == MODE_REALM) leaveRequested = true }
        override fun onTap(catalogX: Int, catalogY: Int, cssX: Double, cssY: Double): Boolean {
            val vx = input.bufferToViewX((cssX * dpr).toFloat()); val vy = input.bufferToViewY((cssY * dpr).toFloat())
            callbacks.event(WorldHudEvent.RealmTap(catalogX.takeIf { it >= 0 }, catalogY.takeIf { it >= 0 }, vx, vy))
            return true // NU's rule: the HUD answers every map tap (Select or FlyTo); the engine never selects on its own
        }
        override fun onFailed(realmId: String, reason: String) {
            log("[world-engine] realm $realmId failed: $reason")
            if (mode == MODE_GLOBE) callbacks.readiness(realmId, 0f)
        }
        override fun onGate(held: Boolean, band: Int, progress: Double) {
            if (held) log("[world-engine] band gate held at band $band (${(progress * 100).toInt()}%)")
            callbacks.bandGate(held, band, progress)
        }
    }

    private fun fail(reason: String) {
        if (failure != null) return
        failure = reason
        log("[world-engine] FALLBACK to the legacy globe: $reason")
        callbacks.failed(reason)
    }

    // ---------------------------------------------------------------- quality (plan §5.4)

    /** GL thread, after endFrame: GPU samples → hang guard → ladder floor; motion intervals → the ladder. Allocates nothing
     *  but a guard step's log line and the crash record's write on a real freeze. The guard's stop rule (`lossStop` lost
     *  contexts) hands the tab back to the legacy globe, and the stored record keeps later visits there
     *  ([HangMemory.stopReason]). */
    private fun quality(report: Gl3FrameReport, nanos: Long) {
        if (report.contextChanged) {
            val stop = hang.contextLost(); memory.incident()
            log("[world-engine] context changed: the hang guard floors L${HangGuard.SAFE_LEVEL}")
            if (stop) fail("the realm map stopped after ${hang.losses} lost graphics contexts")
        }
        // the crash record's clean visits count the samples drawn with the map on screen in its MAP set or deeper
        val inMap = mode == MODE_REALM && RealmBand.set(realm?.stats?.band ?: RealmBand.FAR) >= RealmBand.set(RealmBand.MAP)
        for (i in 0 until report.gpuSampleCount) {
            val ms = report.gpuSamplesMs[i]
            val step = hang.sample(ms, report.gpuSamplesCold[i])
            // only a frozen frame is stored; a slow-frame trip and a recovery stay in this session
            if (step == HangGuard.FREEZE) memory.incident()
            memory.sampled(report.gpuSamplesCold[i], inMap)
            if (step != HangGuard.HOLD) log("[world-engine] hang guard L${hang.level} (${hang.reason ?: "recovered"})${if (step == HangGuard.FREEZE) " ${ms.toInt()} ms" else ""}")
        }
        ladder.hangLevel(hang.level)
        val motion = presented && graphics()?.pacer?.isContinuous == true
        if (motion && lastFrameMotion && lastFrameNanos != 0L) {
            if (ladder.motionInterval((nanos - lastFrameNanos) / 1e6, report.cold) != FrameLadder.HOLD) log("[world-engine] ladder L${ladder.level} (reason ${ladder.lastReason})")
        }
        lastFrameNanos = nanos; lastFrameMotion = motion
        realm?.ladderLevel = ladder.level
    }

    /** Thermal status from the platform listener (any thread) → the ladder, on the GL thread. */
    fun thermal(status: Int, headroom: Double) = post { _ ->
        ladder.thermal(ThermalStatus.entries[status.coerceIn(0, ThermalStatus.entries.size - 1)], headroom)
    }

    // ---------------------------------------------------------------- pacing (plan §5.6, §5.8)

    private fun schedule(now: Double) {
        val pacer = graphics()?.pacer ?: return
        val g = globe; val r = realm; val c = core
        if (g != null && !g.ready && mode == MODE_GLOBE && failure == null) { pacer.setContinuous(false); pacer.requestIn(LOADING_FRAME_MS); return }
        val busy = g == null || !g.ready || mode == MODE_DIVE_WAIT || mode == MODE_FADE_IN || mode == MODE_FADE_OUT ||
            leaveRequested || c?.needsFrame == true || !commands.isEmpty() || !intents.isEmpty || seamWait.pending || cover.animating
        if (busy) { pacer.setContinuous(true); return }
        // a realm loading or rehearsing behind the globe, or prefetching after its core is ready (D-NEXT prefetchDue)
        val preparing = mode == MODE_GLOBE && r != null && r.realmId != null &&
            ((!r.ready && r.status != RealmMapEngine.STATUS_FAILED) || r.prefetchDue)
        // NM: a lane pair backing off (its lane still loading) or the idle wait before a rehearsal asks for its own frame
        val realmWake = if (mode == MODE_REALM && r != null) r.wakeInMs(now) else -1.0
        // A tripped hang guard releases on time, so it needs a probe frame now and then even while the map is still
        // (without it a still map keeps the safe level until the next gesture).
        val probe = if (mode == MODE_REALM) hang.wakeInMs().toDouble() else -1.0
        val realmOrProbe = if (realmWake < 0) probe else if (probe < 0) realmWake else minOf(realmWake, probe)
        val wake = earliestWake(realmOrProbe, if (mode == MODE_GLOBE && g != null) globeWake(g, r, now) else -1.0)
        val idleDelay = idle.delayMs(now.toLong())
        val delay = if (wake >= 0 && idleDelay != 0L) minOf(idleDelay, maxOf(1L, Math.ceil(wake).toLong())) else idleDelay
        when {
            delay == 0L -> if (idle.motion) pacer.setContinuous(true) else { pacer.setContinuous(false); pacer.markDirty() }
            preparing -> { pacer.setContinuous(false); pacer.requestAfterRest(now, delay) }
            delay == IdleScheduler.NEVER -> pacer.setContinuous(false)
            else -> { pacer.setContinuous(false); pacer.requestIn(delay) }
        }
    }

    /**
     * D-NEXT: a realm preparing behind the globe rehearses one pair per frame once the camera has rested
     * `REHEARSE_IDLE_MS`; from then on every vsync is a frame (9 core pairs in ~150 ms, where a 50 ms cadence took
     * ~450 ms and a pinch dive met them unrehearsed). Before the rest, one frame when it ends.
     */
    private fun gg.pixelkingdomwars.nativeclient.scene.FramePacer.requestAfterRest(now: Double, delay: Long) {
        val rest = GpuSafe.REHEARSE_IDLE_MS - (now - lastMotionMs)
        if (rest <= 0.0) markDirty() else requestIn(minOf(delay, maxOf(1L, Math.ceil(rest).toLong())))
    }

    /**
     * The globe's own wakes, in ms from [now] (-1 for none): a left realm's eviction (P0: it is freed `IDLE.evictMs`
     * after the leave even while the globe idles at 0 fps, where no frame used to run the engine's eviction until the
     * next touch, and the realm's ~57–83 MB of GL stayed), and the approach's rest (the globe asks for the realm's core
     * 400 ms after the camera settles low over it, which needs that frame).
     */
    private fun globeWake(g: GlobeV2Renderer, r: RealmMapEngine?, now: Double): Double {
        val evictAt = r?.evictAtMs() ?: Double.NaN
        val evict = if (evictAt.isNaN() || evictAt < 0) -1.0 else maxOf(0.0, evictAt - now)
        return earliestWake(evict, g.approachWakeInMs(now))
    }

    private fun status(now: Double) {
        if (!WorldLog.readout) return // developer builds only: release (N5) and the candidate draw no readout
        statusFrames++
        if (now - statusT0 < 1000.0) return
        val fps = statusFrames * 1000.0 / (now - statusT0)
        statusT0 = now; statusFrames = 0
        val r = realm
        val stats = core?.stats
        callbacks.status("GL30 ${MODE_NAMES[mode]} ${"%.0f".format(fps)} fps · L${ladder.level}${if (hang.level > 0) " (hang)" else ""}" +
            (r?.realmId?.let { " · $it ${STATUS_NAMES.getOrElse(r.status) { "?" }} ${(r.readiness() * 100).toInt()}%" } ?: "") +
            " · draws ${stats?.drawsLast ?: 0} · violations ${stats?.orderViolations ?: 0}")
    }

    private fun blank() {
        GLES20.glClearColor(GlobeV2Renderer.SKY_R, GlobeV2Renderer.SKY_G, GlobeV2Renderer.SKY_B, 1f)
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT)
        graphics()?.pacer?.setContinuous(false)
    }

    // ---------------------------------------------------------------- touch (libGDX InputProcessor, GL thread)

    private fun eventMs(): Double = (Gdx.input?.currentEventTime ?: System.nanoTime()) / 1e6
    private fun realmX(x: Int): Double = dp(input.viewToBufferX(x.toFloat()))
    private fun realmY(y: Int): Double = dp(input.viewToBufferY(y.toFloat()))

    override fun touchDown(screenX: Int, screenY: Int, pointer: Int, button: Int): Boolean {
        if (failure != null || pointer >= MAX_POINTERS) return false
        val t = eventMs()
        guarded("touch") { when (mode) {
            MODE_GLOBE -> globe?.touchDown(pointer, screenX.toFloat(), screenY.toFloat(), t)
            // a resume's landing is the saved spot under clouds: no touch moves it unseen
            MODE_REALM -> if (!landingHeld) { seamCancel("a touch took the camera"); realm?.touchDown(pointer, realmX(screenX), realmY(screenY), t); idle.input(t.toLong()) }
        } }
        return true
    }

    override fun touchDragged(screenX: Int, screenY: Int, pointer: Int): Boolean {
        if (failure != null || pointer >= MAX_POINTERS) return false
        val t = eventMs()
        guarded("touch") { when (mode) {
            MODE_GLOBE -> globe?.touchDragged(pointer, screenX.toFloat(), screenY.toFloat(), t)
            MODE_REALM -> if (!landingHeld) { realm?.touchMove(pointer, realmX(screenX), realmY(screenY), t); idle.input(t.toLong()) }
        } }
        return true
    }

    override fun touchUp(screenX: Int, screenY: Int, pointer: Int, button: Int): Boolean {
        if (failure != null || pointer >= MAX_POINTERS) return false
        val t = eventMs()
        guarded("touch") { when (mode) {
            MODE_GLOBE -> globe?.touchUp(pointer, screenX.toFloat(), screenY.toFloat(), t)
            MODE_REALM -> if (!landingHeld) { realm?.touchUp(pointer, realmX(screenX), realmY(screenY), t); idle.input(t.toLong()) }
        } }
        return true
    }

    override fun touchCancelled(screenX: Int, screenY: Int, pointer: Int, button: Int): Boolean {
        if (pointer >= MAX_POINTERS) return false
        guarded("touch") { globe?.touchCancelled(pointer); realm?.touchCancel(pointer) }
        return true
    }

    override fun keyDown(keycode: Int) = false
    override fun keyUp(keycode: Int) = false
    override fun keyTyped(character: Char) = false
    override fun mouseMoved(screenX: Int, screenY: Int) = false
    override fun scrolled(amountX: Float, amountY: Float) = false

    companion object {
        const val MODE_GLOBE = 0
        const val MODE_DIVE_WAIT = 1
        const val MODE_FADE_IN = 2
        const val MODE_REALM = 3
        const val MODE_FADE_OUT = 4
        private val MODE_NAMES = arrayOf("globe", "dive-wait", "fade-in", "realm", "fade-out")
        private val STATUS_NAMES = arrayOf("none", "loading", "uploading", "rehearsing", "ready", "failed")
        /** The realm map's idle animations, stopped at a leave. */
        private val REALM_TAGS = intArrayOf(IdleScheduler.TAG_SELECT, IdleScheduler.TAG_SHIELD, IdleScheduler.TAG_LIFE, IdleScheduler.TAG_BASES, IdleScheduler.TAG_GROUND)
        /** GROUND's class inputs: a realm whose bundle lists them has a detail pack (pack keys, not game numbers). */
        private val DETAIL_KEYS = arrayOf("fieldsA.png", "fieldsBC.png", "lines.json")
        /** The island near-art lanes beside the build's own thread (owner 2026-09-27, "islands take long time to load"):
         *  4 lanes on the Seeker's 8 cores (4 big) leave the GL and UI threads theirs; the band claims even out lanes that
         *  land on slower cores. M3 bench on the bundled art (2026-09-27, JVM): code 29's resample 452–524 ms, the banded
         *  one on 1 lane 273–313 ms and on 4 lanes 81–118 ms, bytes identical. */
        const val ISLE_HELPERS = 3
        /** Idle island lanes end after this (no thread stays up between approaches). */
        const val ISLE_KEEP_ALIVE_S = 2L
        /** Globe label anchors: one per realm (GlobeV2Pin.REALMS) with room to spare. */
        const val ANCHORS = 16
        const val MAX_POINTERS = 10
        /** NU's zoom tools: globe `cam.zT ± 0.12` per step, realm `d × 2.2^steps` (main.js / map.js tools). */
        const val GLOBE_ZOOM_STEP = 0.12
        const val REALM_ZOOM_STEP = 2.2
        /** Lead bound (not a web number): a globe that has not loaded in 120 s hands the World tab back to the legacy globe. */
        const val LOAD_TIMEOUT_MS = 120_000.0
        /** D-NEXT (amends D-173, "overview first, live"): a dive waits for the core's FAR set alone again (0.7–0.8 s on
         *  the Seeker before D-173), never for the lanes, so there is no landing valve to outwait: the host answers a
         *  dive once its core readiness has not moved for 8 s (lead bound, not a web number; the HUD's 12 s watchdog
         *  stays a backstop behind it). */
        const val DIVE_STALL_MS = 8_000.0
        const val EMULATOR_LOAD_TIMEOUT_MS = 300_000.0
        const val EMULATOR_DIVE_STALL_MS = 120_000.0
        /** The enter-base seam's wait for the lane's TRUE ground (lead bound, the 12 s it had under D-173; D-NEXT moved
         *  only the dive's bound, and TRUE is a lane, which now loads after the landing). */
        const val SEAM_WAIT_MS = 12_000.0
        /** The enter-base seam's flight to the kingdom (lead, like map.js `myBase`'s 900 ms). */
        const val SEAM_FLY_MS = 900.0
        /** Frame cadence while the globe loads (first load or a restore): polls uploads and rehearses one pair per
         *  frame without starving the decode threads of CPU (a continuous 60 Hz loop there only slows the load). */
        const val LOADING_FRAME_MS = 33L
        fun nowMs(): Double = System.nanoTime() / 1e6

        /**
         * The `[world-perf] near` line (debug and candidate builds): where an island close-up's time went, and the wait
         * the player saw (review 2026-09-27: the build's own times cannot show it). `blur`: ms the camera had been at the
         * island on its far layer before the close-up showed (0: shown before it got there); `in-flight`: the build
         * finished during the flight there (yes) or after it (no).
         */
        internal fun nearPerfLine(islandId: String, cached: Boolean, decodeMs: Double, resampleMs: Double, mipMs: Double, uploadMs: Double,
                                  totalMs: Double, blurMs: Double, inFlight: Boolean): String =
            if (cached) "[world-perf] near $islandId resident (no build) blur ${blurMs.toInt()} ms"
            else "[world-perf] near $islandId decode ${decodeMs.toInt()} resample ${resampleMs.toInt()} mips ${mipMs.toInt()} upload ${uploadMs.toInt()} " +
                "total ${totalMs.toInt()} blur ${blurMs.toInt()} ms in-flight ${if (inFlight) "yes" else "no"} (lanes ${ISLE_HELPERS + 1})"

        /** The earlier of two wakes in ms, -1 meaning none. */
        internal fun earliestWake(a: Double, b: Double): Double = if (a < 0) b else if (b < 0) a else minOf(a, b)

        /** Why a resume cannot start here ([resumeRealm]), null when it can: a dive needs the loaded globe, the realm
         *  engine, the globe mode (no dive, fade or map of its own) and a map for the realm in this build's bundle. */
        internal fun resumeRefusal(globeReady: Boolean, realmMaps: Boolean, mode: Int, mapped: Boolean): String? = when {
            !globeReady -> "the globe is not ready"
            !realmMaps -> "no realm maps"
            mode != MODE_GLOBE -> "the world is not on the globe (${MODE_NAMES[mode]})"
            !mapped -> "the realm has no map"
            else -> null
        }

        /** A resume's landing on the new engine's [cam]: the old camera's deed point and its d (device px per deed) at
         *  this engine's [dpr] (the camera's own scale is CSS px per deed). Placement only, as the entry's own. */
        internal fun placeResume(cam: RealmCamera, at: RealmResume, dpr: Double) = cam.set(at.x, at.y, at.d / dpr)

        /** A resume's landing on the new engine [r], right after its entry (which clears any selection): the HUD's chip
         *  and selected deed as the player left them, then the old camera ([placeResume]). In that order: the engine's
         *  select always flies (to SELECT_D from below it, else a re-centre on the deed), and the placement's `set` ends
         *  that flight before any frame, so the map is the same spot with nothing moving (owner, code 31: "Same map,
         *  same spot"). The deed's kingdom may not be in the new engine's bases yet: it is selected as open land, and
         *  becomes that kingdom when the HUD's bases arrive (RealmBases.set). */
        internal fun landResume(r: RealmMapEngine, at: RealmResume, dpr: Double) {
            at.filter?.let(r::setFilter)
            at.card?.let { r.selectCatalogDeed(it.x, it.y, fly = false) }
            placeResume(r.cam, at, dpr)
        }

        /** The landing's post to the HUD, rising with every step of [RealmResumeLanding.progress] and below 1: only the
         *  dive watchdog reads it (the realm panel, whose meter it would be, is closed through a resume). */
        internal fun landingMeter(progress: Double): Double = progress / (progress + 1)

        /** The dive readiness the HUD is sent: 5 % steps for the realm panel's meter, every change while a dive waits
         *  (D-173: the HUD's dive watchdog re-arms on each post, so it must see each step [DiveStall] sees, one per
         *  readiness item, ~50 a dive. In 5 % steps everything from 0.95 to the engine's 0.99 cap, the lanes' last MAP
         *  items the landing valve waits for, posted once and the watchdog cut dives seconds from landing). */
        internal fun postedReadiness(readiness: Double, diving: Boolean): Float =
            (if (diving) readiness else Math.floor(readiness * 20) / 20).toFloat()

        /**
         * N5: the crash record's pending marker spans every stretch in which realm-map GPU work can run, so a driver hang
         * or crash there floors the next session (and, in safe mode, stops the realm map) instead of repeating at L0.
         * That work starts before the dive: a realm the panel prepares behind the globe adopts its programs and textures
         * and first-draws every (program, state) pair in idle globe frames (D-173 rehearsal: the driver's
         * compile-on-first-draw point, the stall GPU_SAFE exists for). So: any mode but the globe, and on the globe a
         * realm that is loading or rehearsing (neither ready nor failed), or one whose core is ready and whose lanes
         * still prefetch behind the globe ([prefetch], D-NEXT `prefetchDue`: their programs and pairs are GPU work too).
         */
        internal fun realmMarked(mode: Int, realmId: String?, status: Int, prefetch: Boolean = false): Boolean =
            mode != MODE_GLOBE || (realmId != null && ((status != RealmMapEngine.STATUS_READY && status != RealmMapEngine.STATUS_FAILED) || prefetch))

        /** The host's pool threads. They never take the process down: an escaped Throwable (an OutOfMemoryError while
         *  decoding, a bug) hands the World tab back to the legacy globe instead of crashing the app (D-171: safe first).
         *  And they never keep a host alive (P0): a live thread is a GC root, and a handler holding the host pinned its
         *  whole world for as long as the pool ran, so the factory and its handler reach the host only weakly. */
        internal fun workerThreads(name: String, host: WorldEngineHost): ThreadFactory {
            val ref = WeakReference(host)
            val n = AtomicInteger()
            return ThreadFactory { r -> Thread(r, "$name-${n.incrementAndGet()}").apply {
                isDaemon = true
                setUncaughtExceptionHandler { t, e -> ref.get()?.workerDied(t.name, e) }
            } }
        }

    }

    private fun daemon(name: String): ThreadFactory = workerThreads(name, this)

    private fun workerDied(thread: String, e: Throwable) {
        log("[world-engine] $thread died: ${e.javaClass.simpleName}: ${e.message}"); fail("a world worker failed: ${e.javaClass.simpleName}")
    }
}

/**
 * The dive's wait bound (lead; D-NEXT): the map is given up on only when its readiness has not moved for [stallMs]
 * ([WorldEngineHost.DIVE_STALL_MS], 8 s). A dive whose core still makes progress keeps waiting however slow it is (a
 * cold first dive after an install links its programs), and one stuck from its start gets the whole bound. GL thread.
 */
internal class DiveStall(val stallMs: Double) {
    private var mark = Double.NaN
    private var movedMs = 0.0

    /** A new dive: the bound counts from [nowMs]. */
    fun start(nowMs: Double) { mark = Double.NaN; movedMs = nowMs }

    /** True when [readiness] has not changed for longer than [stallMs]. */
    fun stalled(nowMs: Double, readiness: Double): Boolean {
        if (readiness != mark) { mark = readiness; movedMs = nowMs; return false }
        return nowMs - movedMs > stallMs
    }
}

/**
 * The dive wait's diagnostic (code 29: the smoke's and the owner's Seeker evidence of what holds a dive): while a dive
 * waits, at most one line every [everyMs] through the host's WorldLog-gated logger (the caller checks
 * [WorldLog.enabled] first, so release formats nothing):
 *
 *     [world-engine] dive wait <realm> readiness <ratio> peak <meter> land <done>/<total> held 0x<lanes held>
 *         lanes <lane> <MAP set in 1|0>/<settled 1|0> … valve <ms of the landing valve's count>
 *
 * (one line). `readiness` is the items done over the items known now, `peak` the meter the HUD and [DiveStall] read,
 * `land` the D-173 items beyond the core, `held` the lanes held in the prefetch (bit i = lane i), each lane its
 * `readyFor(1)` and `settled()`, and `valve` the ms of frames that could make progress since the meter last moved (the
 * engine's landing valve opens at `rehearse.stallMs`). GL thread.
 */
internal class DiveWaitLog(private val everyMs: Double = 1_000.0) {
    private var lastMs = Double.NaN

    /** A new dive: its first waiting frame logs. */
    fun start() { lastMs = Double.NaN }

    /** True at most once per [everyMs]. */
    fun due(nowMs: Double): Boolean {
        if (!lastMs.isNaN() && nowMs - lastMs < everyMs) return false
        lastMs = nowMs
        return true
    }

    companion object {
        fun line(realmId: String, st: RealmMapStats, lanes: List<RealmLane>?): String = buildString(192) {
            append("[world-engine] dive wait ").append(realmId)
            append(" readiness ").append(fixed(st.readinessRaw)).append(" peak ").append(fixed(st.readinessPeak))
            append(" land ").append(st.landDone).append('/').append(st.landTotal)
            append(" held 0x").append(Integer.toHexString(st.lanesHeld))
            append(" lanes")
            if (lanes == null) append(" off")
            else for (l in lanes) append(' ').append(l.name).append(' ').append(if (l.readyFor(1)) 1 else 0).append('/').append(if (l.settled()) 1 else 0)
            append(" valve ").append(st.landStallMs.toLong())
        }

        private fun fixed(v: Double): String = String.format(Locale.ROOT, "%.3f", v)
    }
}

/**
 * The enter-base seam's wait (lead, N3, D-162.3): OPEN BASE on your own deed hands the base scene the map's camera only
 * once the map rests on that deed at full TRUE with a lane's TRUE ground drawn alone ([RealmSeamCamera.seamless], the
 * camera still): never a flight's midpoint, never the core's chart standing in for TRUE. Past [waitMs] without that the
 * HUD opens the base at its own fit instead (F8, as before the seam). A newer OPEN BASE replaces an older one; a leave,
 * Back, or the player taking the camera cancels it and nothing opens. GL thread.
 */
internal class SeamWait(val waitMs: Double) {
    var catalogX = -1; private set
    var catalogY = -1; private set
    var since = 0.0; private set
    val pending: Boolean get() = catalogX >= 0

    fun start(catalogX: Int, catalogY: Int, nowMs: Double) { this.catalogX = catalogX; this.catalogY = catalogY; since = nowMs }
    fun clear() { catalogX = -1; catalogY = -1 }

    /** [HAND_OFF] when the map shows the deed seamlessly and rests, [GIVE_UP] past the bound, else [WAIT]. */
    fun step(nowMs: Double, seamless: Boolean, moving: Boolean): Int = when {
        !pending -> WAIT
        seamless && !moving -> HAND_OFF
        nowMs - since > waitMs -> GIVE_UP
        else -> WAIT
    }

    companion object { const val WAIT = 0; const val HAND_OFF = 1; const val GIVE_UP = 2 }
}

/**
 * A teardown whose steps each run in their own try, in order (P0, 2026-09-26): one that throws (a driver error in a
 * `glDelete`, an OutOfMemoryError while the heap is full, a lease that fails to close) is logged and never skips the
 * steps after it, which free the rest of the world's memory. GL thread.
 */
internal object WorldTeardown {
    /** Runs every step of [steps] (name to step); returns the names of the steps that threw, each logged through [log]. */
    fun run(log: (String) -> Unit, vararg steps: Pair<String, () -> Any?>): List<String> {
        val failed = ArrayList<String>(0)
        for ((name, step) in steps) {
            try { step() } catch (t: Throwable) { failed += name; log("dispose: $name failed: ${t.javaClass.simpleName}: ${t.message}") }
        }
        return failed
    }
}

/** The bundled world content as the globe's world files ([AssetWorldFiles] checks every path against content.json). */
class AssetGlobeFiles(private val files: AssetWorldFiles) : GlobeFiles {
    override fun read(path: String): ByteArray? = files.read(path)
    override fun expectedSha256(path: String): String? = files.expectedSha256(path)
}

/** Albedo and cloud WebPs → straight RGBA8 (never premultiplied, never density-scaled), as [BitmapRealmImages]. */
object BitmapGlobeImages : GlobeImageDecoder {
    override fun decode(bytes: ByteArray, key: String): GlobeRgba? = BitmapRealmImages.decode(bytes, key)?.let { GlobeRgba(it.width, it.height, it.rgba) }
}
