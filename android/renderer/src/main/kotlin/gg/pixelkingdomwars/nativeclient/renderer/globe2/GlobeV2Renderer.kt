package gg.pixelkingdomwars.nativeclient.renderer.globe2

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.GlobeArt
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Load
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Restorable
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.globe2.GlobeV2Pin as P
import gg.pixelkingdomwars.nativeclient.renderer.world.IdleScheduler
import gg.pixelkingdomwars.nativeclient.renderer.world.InputScale
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderKnobs
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldEngine
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFrameExchange
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldIntent
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldTarget
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.hypot
import kotlin.math.sqrt

/** A program's two preprocessed stages and their pinned sha256 (from NT's generated `WorldShaders`). */
class GlobeStages(val vs: String, val fs: String, val vsSha256: String?, val fsSha256: String?)

/** Where the globe's programs come from: `WorldShaders.globe["globe-flat" | "globe-isles" | "globe-fx"]` (and the realm
 *  engine's `rm-lowres-blit` for the half-scale ladder step) through `WorldShaders.source(stage)` (called on the decode
 *  thread: it reads the APK). Null when the pin lacks a program. */
fun interface GlobeShaderSource { fun stages(name: String): GlobeStages? }

/** GL → UI (called on the GL thread; the host marshals to the UI thread with its epoch-guarded publish). */
interface GlobeEvents {
    /** Every texture and program is resident: the host may drop its loading state and bind the screen. */
    fun ready() {}
    /** The globe cannot run (missing shader or content, a refused upload): the host shows the legacy globe. */
    fun unavailable(reason: String) {}
    /** A tap resolved to [pick]. Not called for a Phase E island: that tap selects it and is reported by [selected]
     *  (null, islandId) alone, so a host that maps the picks it knows (realm, exploration island) and treats the rest as
     *  "nothing" never deselects the island it just selected. */
    fun picked(pick: GlobePickV2) {}
    /** The selection changed (a tap, an intent or a leave): realm id, Phase E island id, or neither. The HUD opens the
     *  Phase E island panel from this (D-172). */
    fun selected(realmId: String?, islandId: String?) {}
    /** Dive into [realmId]'s map now (plan §3.5): the realm engine opens at [sStartCss] CSS px per deed. The globe is
     *  diving until [GlobeV2Renderer.diveResult]. */
    fun dive(realmId: String, lon: Double, lat: Double, sStartCss: Double) {}
    /** D-NEXT: the player is about to dive into [realmId] (the camera rests low over it, or a pinch aims below the
     *  approach altitude; [GlobeApproach], once per realm while the camera stays near): the host may load its map's
     *  core now, so the dive that follows is warm. */
    fun approach(realmId: String) {}
    /** Pushed past the zoom floor where there is no map: the web's hint. [realmId] is the realm there, the Phase E
     *  island's id over a live one (main.js noMapHint names the island), or null over the sea. */
    fun noMap(realmId: String?) {}
    /** A part adopted after the first frame could not load ([part]: "albedo-1024", "islands", "phase-e islands",
     *  "half-scale blit"): the globe keeps running without it (the 256² cube, no exploration or Phase E islands, no L2
     *  half scale). For the host's log. */
    fun partUnavailable(part: String, reason: String) {}
    /** A Phase E island's near art is displayed ([islandId]): [cached] = shown from a resident slot (no build); else
     *  where its time went in ms ([GlobeNearBuilt]: decode, resample, mips on a decode thread; [uploadMs] from the build's
     *  end to the texture being resident; [totalMs] from the request to the display). [blurMs]: how long the camera had
     *  been at the island (arrived or at rest there, below [PhaseEIslandLayer.NEAR_ALT]) showing its far layer before
     *  this display, 0 when it was shown before the camera got there; [inFlight]: the build finished while the camera
     *  was still flying there. For the host's `[world-perf]` log (owner 2026-09-27: the islands "take long time to
     *  load": the blur is what the player waits through). */
    fun nearArt(islandId: String, cached: Boolean, decodeMs: Double, resampleMs: Double, mipMs: Double, uploadMs: Double, totalMs: Double,
                blurMs: Double, inFlight: Boolean) {}
}

/**
 * Where the HUD sits, in buffer px (the host converts Compose bounds with [InputScale]): the header's bottom edge,
 * the obstacles the home frame keeps the globe clear of (tools, hint: x0, y0, x1, y1 quadruples), and the free rect
 * the realm panel or sheet leaves when a selection is shown (x0, y0, x1, y1; null = the whole screen).
 */
class GlobeLayout(val top: Float, val obstacles: FloatArray, val obstacleCount: Int, val panelFree: FloatArray?) {
    companion object { val NONE = GlobeLayout(0f, FloatArray(0), 0, null) }
}

/**
 * The flat painted globe on the world surface's GL30 context (GLOBE-NATIVE-PLAN §3.2 GlobeV2Renderer; lane NG, N1).
 *
 * Draws the pinned shared shaders (`src/globe/flat.glsl.js`): 'globe-flat' (one full-screen ray–sphere pass: sky,
 * painted albedo, sea and shore, clouds and their shadow, glow, the D-166 selection), then the 32 exploration islands
 * ([ExplorationIslandLayer]: 'globe-isles' + 'globe-fx') and, only when the world content asks for them (D-172, debug
 * bundles), the Phase E islands ([PhaseEIslandLayer]: 'globe-isles' again, its own art array; off otherwise, RG-3).
 * Camera, gestures and picking are ports of the concept (GlobeCameraV2, GlobeGestures, GlobePicking); presentation
 * numbers come from the generated [GlobeV2Pin].
 *
 * Lifecycle (GL thread): [start] reads the program stages on [decode] and hands them to the core's background compiler
 * as soon as they are read, while the content's first stage ([GlobeAssets.first]: the 256² albedo cube, sea/shore,
 * clouds, selection fields, geography) decodes in parallel jobs across the [decode] threads ([content] only plans the
 * jobs; each world file is hashed before it is decoded). Textures are created through [uploader] once decoded. Until
 * [ready], [update] draws nothing and the host must NOT bind the screen (the GL-thread upload fallback is legal only
 * before the first world frame). [loadProgress] is the loading meter. The islands hold the reveal (owner 2026-10-06:
 * Solana, Seeker, Divine and the exploration archipelagos must be on the globe in the very first frame it shows, never
 * popping in after it): ready waits until the exploration and Phase E islands are resident and their draws rehearsed
 * with the globe's own pairs (or their part failed, or is absent), for at most [ISLAND_HOLD_MS] after the rest is
 * resident. Past that bound (a chain group that downloads, a slow device) the globe shows without them and they appear
 * once resident and rehearsed on an idle frame, as before. After ready the 1024² albedo cube, which never holds the
 * reveal, replaces the 256² one when its fresh texture is resident; a failed late part is reported
 * ([GlobeEvents.partUnavailable]) and the globe keeps running without it. With a GL-thread-only uploader (no worker)
 * every late part is waited for before ready instead. A context change re-decodes from the verified files (plan §5.7,
 * no RAM cache).
 *
 * Per frame (host order, plan §5.9): `core.beginFrame` → [update] (input, camera, dive, selection, idle declarations,
 * the WorldFrame) → optional [drawTo] (the dive snapshot, offscreen) → [drawOffscreen] (the half-scale sphere at
 * ladder L2+) → `core.beginScreen` → [draw] → `core.endFrame`. [renderFrame] does that whole sequence for a host that
 * runs the globe alone. No allocation in a steady frame.
 */
class GlobeV2Renderer(
    private val core: Gl3Core,
    private val shaders: GlobeShaderSource,
    private val content: () -> GlobeAssets,
    private val decode: Executor,
    private val uploader: GlobeUploader,
    private val art: GlobeArt?,
    private val events: GlobeEvents,
    private val idle: IdleScheduler? = null,
    private val frames: WorldFrameExchange? = null,
    private val input: InputScale = InputScale(),
    pxPerDp: Double = 2.0,
) {
    /** The Phase E islands: on only once the world content asked for them and they are live (D-172; RG-3 otherwise). */
    val phaseE = PhaseEIslandLayer()
    val realmIds: List<String> = P.REALMS.map { it.id }
    val camera = GlobeCameraV2(pxPerDp)
    val gestures = GlobeGestures(camera) { x, y, now -> tap(x, y, now) }

    var state = LOADING; private set
    val ready: Boolean get() = state == READY
    var failure: String? = null; private set
    @Volatile var divable: Set<String> = emptySet()
    @Volatile var layout: GlobeLayout = GlobeLayout.NONE
    var night = false
    var reducedMotion = false
        set(value) { field = value; camera.reducedMotion = value }
    var cloudsOn = true
    /** The realm map is open (the globe sleeps: no frames, no dive checks). */
    var asleep = false; private set

    // programs and resources
    private var flat: Gl3Program? = null
    private var isles: Gl3Program? = null
    private var fx: Gl3Program? = null
    /** The half-scale step's upscale (the realm engine's `rm-lowres-blit`); null = L2 draws at full scale. */
    private var blit: Gl3Program? = null
    /** The dive's cloud cover ([GlobeDiveCover], on the blit's stages); null = a waiting dive shows the globe alone. */
    private var cover: Gl3Program? = null
    /** D-NEXT: when to tell the host a dive is coming ([GlobeEvents.approach]). */
    private val approach = GlobeApproach()
    /** What the flat pass samples: the 256² cube until the 1024² one ([albedoHigh]) is resident. */
    private var albedo: Gl3Texture? = null
    private var albedoHigh: Gl3Texture? = null
    private var ssg: Gl3Texture? = null
    private var clouds: Gl3Texture? = null
    private var selection: Gl3Texture? = null
    private var isleArt: Gl3Texture? = null
    /** The island layer, built once its art is resident; drawn and picked only when [islesLive]. */
    private var islands: ExplorationIslandLayer? = null
    private var isleAssets: GlobeIslands? = null
    private var islesLive = false
    /** The Phase E art array; its fields go up in ≤ COLD_UPLOAD_BYTES strips ([peData], [peField], [peRow]) on rested
     *  frames (whole before the first frame); the layer is built when both are resident and live once rehearsed. */
    private var peArt: Gl3Texture? = null
    private var peData: GlobePhaseE? = null
    private var peField = 0; private var peRow = 0
    private var peStrip: java.nio.ByteBuffer? = null
    private var peFieldsDone = false
    private var peBuilt = false
    /** The near slots ([PhaseEIslandLayer.NEAR_SLOTS] of [PhaseEIslandLayer.NEAR]²): the art source from the content;
     *  the one build at a time ([nearBuilding]: its island until its outcome is taken, -1: none; [nearLive]: the token
     *  its cancel check compares, 0 once cancelled); a finished build waiting for a slot ([nearWaiting]: its pixels, the
     *  only copy, see [adoptNear]); the texture filling on the worker; the islands whose near art could not be made. */
    @Volatile private var nearSource: GlobeNearArt? = null
    private var nearBuilding = -1
    @Volatile private var nearLive = 0
    private var nearSerial = 0
    private var nearAskedMs = 0.0
    private var nearWaiting: GlobeNearBuilt? = null; private var nearWaitingIsland = -1
    private var nearPending: Gl3Texture? = null; private var nearPendingIsland = -1
    /** The waiting or filling build's times for [GlobeEvents.nearArt] ([NearTimes]: its 22 MB of pixels are never kept
     *  for them), and [nearFresh]'s, the resident island whose first display reports them (-1: reported, or none). */
    private var nearTimes: NearTimes? = null
    private var freshTimes: NearTimes? = null; private var nearFresh = -1
    /** The blur clock ([GlobeEvents.nearArt] blurMs): the island the camera arrived at (not flying, at the view centre
     *  below NEAR_ALT) while its close-up was not displayed, and since when (frame ms); -1 / NaN: none. */
    private var blurIsland = -1; private var blurSince = Double.NaN
    private val nearRefused = BooleanArray(P.PHASE_E.size)
    private val nearDir = DoubleArray(3)
    /** [nearTarget]'s answer beside the island: may it cancel a build for another island (an intent: a flight's target, a
     *  realm or a dive, or a camera at rest), or only start one (a gesture still moving)? */
    private var nearMayCancel = false
    /** The island [nearTarget] last aimed at (-1: none): a finished build's slot is never taken from it ([adoptNear]). */
    private var nearAimed = -1
    /** The current flight may start an island build: an island selection's or a double tap's (a zoom to a point). A
     *  realm's framing, a leave, the dive's approach and the World tool's flight out never do (review 2026-09-27: Solana
     *  Reach's frame centre is within NEAR_REACH of Seeker Island, so selecting or diving into it built Seeker's close-up
     *  on the world-load pool beside the realm's own prefetch). Set wherever a flight starts. */
    private var nearFlightAims = false
    /** A real two-finger pinch writes its zoom straight into z and zT ([GlobeGestures.move]): its aim is where its trend
     *  goes. The z and frame ms of its last zoom step, and its rate (z per ms, > 0 zooming in); NaN / 0: no pinch. */
    private var pinchZ = Double.NaN; private var pinchMs = Double.NaN; private var pinchRate = 0.0
    private var picking: GlobePicking? = null
    private var geoms: Array<GlobeRealmGeom>? = null
    private var geography: GlobeGeography? = null
    /** The half-scale target (ladder L2+): the globe's own, never the realm ground's shared `core.lowres`. */
    private var low: Gl3Texture? = null
    private var frameNo = 0L; private var lowFrame = -1L; private var lowK = 1.0
    private var lastMotionMs = Double.NEGATIVE_INFINITY

    // the staged load: results from the decode threads, taken on the GL thread (a superseded generation is dropped)
    private class Outcome<T>(val generation: Int, val value: T?, val failure: String?)
    private val stagesOut = AtomicReference<Outcome<List<GlobeStages?>>?>(null)
    private val firstOut = AtomicReference<Outcome<GlobeFirst>?>(null)
    private val highOut = AtomicReference<Outcome<GlobeTextureData>?>(null)
    private val islesOut = AtomicReference<Outcome<GlobeIslands>?>(null)
    private val peOut = AtomicReference<Outcome<GlobePhaseE?>?>(null)
    private class NearArt(val island: Int, val token: Int, val built: GlobeNearBuilt?)
    /** One build's decode-thread times (ms), frame times (request, finish, resident) and whether it finished in a flight. */
    private class NearTimes(val decodeMs: Double, val resampleMs: Double, val mipMs: Double, val askedMs: Double, val builtMs: Double,
                            val inFlight: Boolean) { var readyMs = 0.0 }
    private val nearOut = AtomicReference<Outcome<NearArt>?>(null)
    @Volatile private var generation = 0
    private val jobsDone = AtomicInteger(0)
    @Volatile private var jobsTotal = 0
    /** Late parts still expected this generation (a GL-thread-only uploader waits for them before ready). */
    private var highPending = false; private var islesPending = false; private var pePending = false
    /** Frame ms since when everything but the islands was ready to show (NaN: not yet, or no wait): the bound of the
     *  islands' hold ([ISLAND_HOLD_MS]). */
    private var islandHoldSince = Double.NaN
    /** How long the reveal waited for the islands this generation (ms, 0 when it did not), for the host's ready line. */
    var islandWaitMs = 0.0; private set
    /** The last late part that could not load (also sent to [GlobeEvents.partUnavailable]). */
    var lateFailure: String? = null; private set

    // selection (main.js sel + selFx)
    var selectedRealm = -1; private set
    var selectedIsland: String? = null; private set
    private var selMode = 0; private var selK = 0.0; private var selKT = 0.0; private var selT0 = 0.0
    /** The Phase E island (PHASE_E index) whose field the outline reads while [selMode] is 2 (kept through the fade-out). */
    private var selIsle = -1
    private var selR = 1f; private var selG = 1f; private var selB = 1f
    private val selC = DoubleArray(3); private val selE = DoubleArray(3); private val selN = DoubleArray(3)
    private var selLayer = 0f

    // dive and frame state
    private var diving = false; private var pendingDive = -1; private var diveBlockUntil = 0.0
    private var lastMs = Double.NaN; private var lastTapX = 0.0; private var lastTapY = 0.0; private var lastTapMs = -1e9
    private var homeCy = 0.0; private var homeZ = Double.NaN; private val homeT = DoubleArray(3)
    private var lastLayout: GlobeLayout? = null; private var lastW = 0; private var lastH = 0
    private var noMapShown = false
    private var knobs: LadderKnobs? = null

    // scratch
    private val sun = DoubleArray(3); private val e0 = DoubleArray(3); private val n0 = DoubleArray(3); private val d0 = DoubleArray(3)
    private val hit = DoubleArray(3); private val xy = DoubleArray(2); private val cy = DoubleArray(1)
    private val anchorXY = FloatArray(2)

    init {
        core.onRestore(Gl3Restorable { restore() })
    }

    // ---------------------------------------------------------------- lifecycle

    /**
     * GL thread: start the load (once per context lifetime). One decode task reads the program stages (handed to the
     * compiler on the next frame, so linking overlaps the decode), plans the content, then fans the first stage out
     * over [PARALLEL] decode tasks; the exploration islands and the Phase E islands (one task each: a chain read may
     * wait on the network, and a large art decode never takes both threads) queue behind it, and the 1024² cube
     * ([PARALLEL] tasks) last: the islands hold the reveal (owner 2026-10-06), the cube does not.
     */
    fun start() {
        val gen = ++generation
        stagesOut.set(null); firstOut.set(null); highOut.set(null); islesOut.set(null); peOut.set(null); nearOut.set(null)
        nearSource = null; nearBuilding = -1; nearLive = 0; nearWaiting = null; nearWaitingIsland = -1; nearPending = null; nearPendingIsland = -1
        nearTimes = null; freshTimes = null; nearFresh = -1; nearAimed = -1; blurIsland = -1; blurSince = Double.NaN; nearRefused.fill(false)
        jobsDone.set(0); jobsTotal = 0
        highPending = true; islesPending = art != null; pePending = true
        islandHoldSince = Double.NaN; islandWaitMs = 0.0
        val cancelled = { gen != generation }
        val task = Runnable {
            val stages: List<GlobeStages?> = try {
                val required = REQUIRED.map { shaders.stages(it) ?: throw GlobeContentException("the shader pin has no $it") }
                required + listOf(runCatching { shaders.stages(PROGRAM_BLIT) }.getOrNull())
            } catch (t: Throwable) { put(firstOut, Outcome(gen, null, reason(t))); return@Runnable }
            put(stagesOut, Outcome(gen, stages, null))
            val assets = try { content() } catch (t: Throwable) { put(firstOut, Outcome(gen, null, reason(t))); return@Runnable }
            if (cancelled()) return@Runnable
            jobsTotal = assets.first.jobs.size
            GlobeFanOut(assets.first, PARALLEL, cancelled, jobsDone) { r, e -> put(firstOut, Outcome(gen, r, e?.let { reason(it) })) }.start(decode)
            // the islands next (they hold the reveal), one task each so the two decode threads take one each
            val isl = assets.islands
            if (isl == null) put(islesOut, Outcome(gen, null, null))
            else GlobeFanOut(isl, 1, cancelled, null) { r, e -> put(islesOut, Outcome(gen, r, e?.let { reason(it) })) }.start(decode)
            // the Phase E islands on one task too: without the world index's flag the batch is a no-op (RG-3)
            nearSource = assets.phaseENear
            val pe = assets.phaseE
            if (pe == null) put(peOut, Outcome(gen, null, null))
            else GlobeFanOut(pe, 1, cancelled, null) { r, e -> put(peOut, Outcome(gen, r, e?.let { reason(it) })) }.start(decode)
            // the 1024² cube last: it only sharpens the sphere after the first frame
            val high = assets.albedoHigh
            if (high == null) put(highOut, Outcome(gen, null, null))
            else GlobeFanOut(high, PARALLEL, cancelled, null) { r, e -> put(highOut, Outcome(gen, r, e?.let { reason(it) })) }.start(decode)
        }
        try { decode.execute(task) } catch (e: RejectedExecutionException) { put(firstOut, Outcome(gen, null, "the decode pool is shut down")) }
    }

    /** Publish [o] unless a newer generation's outcome is already there (a superseded load never overwrites a fresh one). */
    private fun <T> put(ref: AtomicReference<Outcome<T>?>, o: Outcome<T>) {
        while (true) {
            val cur = ref.get()
            if (cur != null && cur.generation > o.generation) return
            if (ref.compareAndSet(cur, o)) return
        }
    }

    /** Take this generation's outcome, if any (GL thread). */
    private fun <T> take(ref: AtomicReference<Outcome<T>?>): Outcome<T>? {
        val o = ref.get() ?: return null
        if (o.generation != generation) { ref.compareAndSet(o, null); return null }
        return if (ref.compareAndSet(o, null)) o else null
    }

    private fun reason(t: Throwable): String = t.message ?: t.javaClass.simpleName

    /** The program stages, as soon as they are read: the core compiles them in the background while the content decodes. */
    private fun adoptPrograms() {
        if (flat != null) return
        val o = take(stagesOut) ?: return
        val s = o.value ?: return
        fun make(name: String, st: GlobeStages) = core.program(name, st.vs, st.fs, st.vsSha256, st.fsSha256)
        flat = make(PROGRAM_FLAT, s[0]!!); isles = make(PROGRAM_ISLES, s[1]!!); fx = make(PROGRAM_FX, s[2]!!)
        blit = s[3]?.let { make(PROGRAM_BLIT, it) }
        if (blit == null) lateFail("half-scale blit", "the shader pin has no $PROGRAM_BLIT")
        cover = s[3]?.let { b ->
            runCatching { core.program(GlobeDiveCover.PROGRAM, b.vs, GlobeDiveCover.fragment(b.fs), b.vsSha256, null) }
                .onFailure { lateFail(PART_COVER, it.message ?: it.javaClass.simpleName) }.getOrNull()
        }
    }

    /** The first stage: create its four textures and the picking; a failed first stage makes the globe unavailable. */
    private fun adoptFirst() {
        if (albedo != null) return
        val o = take(firstOut) ?: return
        val a = o.value ?: return fail(o.failure ?: "the globe content could not be decoded")
        albedo = texture(a.albedo); ssg = texture(a.ssg); clouds = texture(a.clouds); selection = texture(a.selection)
        geography = a.geography; geoms = a.geoms
        // the exploration islands are picked by their art only once they are drawn (what you see is what you tap)
        picking = GlobePicking(a.geography, realmIds, null, null).also { it.phaseE = phaseE.enabled }
        camera.phaseE = phaseE.enabled
        if (albedo == null || ssg == null || clouds == null || selection == null) fail("the globe textures were refused (allocator or uploader)")
    }

    /** Late parts (the 1024² cube, the islands): create their fresh textures when they arrive; swap the cube in and build
     *  the island layer once resident. With a GL-thread-only uploader they are adopted only before the first frame. */
    private fun adoptLate() {
        if (albedo == null) return // the first stage leads: its textures take the allocator first
        if (!uploader.fillsAfterFirstFrame && core.firstWorldFrameDrawn) return
        take(highOut)?.let { o ->
            highPending = false
            val d = o.value
            if (d == null) { if (o.failure != null) lateFail("albedo-1024", o.failure) }
            else { albedoHigh = texture(d); if (albedoHigh == null) lateFail("albedo-1024", "the texture was refused (allocator or uploader)") }
        }
        val high = albedoHigh
        if (high != null && high.ready) { core.free(albedo); albedo = high; albedoHigh = null; idle?.invalidate() }
        take(islesOut)?.let { o ->
            val v = o.value
            if (v == null || art == null) { islesPending = false; if (o.failure != null) lateFail("islands", o.failure) }
            else {
                isleArt = texture(v.art)
                if (isleArt == null) { islesPending = false; lateFail("islands", "the texture was refused (allocator or uploader)") } else isleAssets = v
            }
        }
        val v = isleAssets; val a = art
        if (v != null && a != null && islands == null && isleArt?.ready == true) {
            islands = ExplorationIslandLayer(a, v.cell, v.atlas, v.fx?.count ?: 0).also { it.build(core, v.fx) }
            enqueue(PAIR_ISLES); enqueue(PAIR_FX)
        }
        take(peOut)?.let { o ->
            val d = o.value
            if (d == null) { pePending = false; if (o.failure != null) lateFail(PART_PHASE_E, o.failure) }
            else {
                peArt = texture(d.art)
                if (peArt == null) { pePending = false; lateFail(PART_PHASE_E, "the texture was refused (allocator or uploader)") }
                else { peData = d; peField = 0; peRow = 0 }
            }
        }
        // before the first world frame a GL-thread upload may be whole (a GL-thread-only uploader lands here)
        if (peData != null && !core.firstWorldFrameDrawn) uploadFields(Long.MAX_VALUE)
        if (peFieldsDone && !peBuilt && peArt?.ready == true) { phaseE.build(core); peBuilt = true; enqueue(PAIR_PHASE_E) }
        adoptNear()
    }

    /**
     * The near art arrived: it takes a slot and is filled on the worker; once resident it waits in its slot until the
     * view centre shows it ([showNear]). A build that was cancelled (or superseded) is dropped: its island is not refused,
     * a later approach builds it again.
     *
     * The slot (review 2026-09-27: a victim picked when the pixels arrived, mid-flight, lost a resident island to a
     * change of mind before the new texture could even be adopted, which the host does only outside flights and fades):
     * - a free slot is taken at once, in a flight too (its upload overlaps the flight, as the build did);
     * - with every slot held, the build waits ([nearWaiting]: its pixels on the heap, no texture reserved) until the camera
     *   is not flying and [nearTarget] still aims at its island; only then is a victim freed ([PhaseEIslandLayer.makeRoom]):
     *   the least recently used slot that is not displayed (never the island aimed at: that is the one being placed);
     * - a change of mind before then cancels the waiting build ([followNear]), so every resident island stays.
     */
    private fun adoptNear() {
        take(nearOut)?.let { o ->
            nearBuilding = -1
            val n = o.value ?: return@let
            if (n.token != nearLive) return@let // cancelled: the camera left, or another island was wanted
            nearLive = 0
            if (!phaseE.enabled) return@let
            val b = n.built
            if (b == null) {
                if (o.failure == null) return@let // cancelled at its last check
                nearRefused[n.island] = true; lateFail(PART_PHASE_E_NEAR, o.failure); return@let
            }
            nearWaiting = b; nearWaitingIsland = n.island
            nearTimes = NearTimes(b.decodeMs, b.resampleMs, b.mipMs, nearAskedMs, lastMs, camera.flying)
        }
        val w = nearWaiting
        if (w != null && (phaseE.slotFree || (!camera.flying && nearAimed == nearWaitingIsland && phaseE.makeRoom(core)))) {
            val i = nearWaitingIsland
            nearWaiting = null; nearWaitingIsland = -1 // only the timings are kept: the texture's fill holds the pixels
            val t = texture(w.data)
            if (t == null) { nearRefused[i] = true; lateFail(PART_PHASE_E_NEAR, "the texture was refused (allocator or uploader)") }
            else { nearPending = t; nearPendingIsland = i }
        }
        val t = nearPending
        if (t != null && t.ready) {
            phaseE.store(core, nearPendingIsland, t)
            nearFresh = nearPendingIsland; freshTimes = nearTimes?.also { it.readyMs = lastMs }; nearTimes = null
            nearPending = null; nearPendingIsland = -1
            idle?.invalidate()
        }
    }

    /** The island nearest [dir] in art widths (angle ÷ wDeg) under [PhaseEIslandLayer.NEAR_REACH], as main.js
     *  islandArt.bind ranks them; [residentOnly]: among those with near art resident. -1: none. No allocation. */
    private fun nearestIsland(dir: DoubleArray, residentOnly: Boolean): Int {
        var best = -1; var bestD = PhaseEIslandLayer.NEAR_REACH
        for (i in P.PHASE_E.indices) {
            if (residentOnly && !phaseE.resident(i)) continue
            val s = P.PHASE_E[i]
            V.dirOf(nearDir, s.lon, s.lat)
            val d = kotlin.math.acos(V.clamp(V.dot(dir, nearDir), -1.0, 1.0)) / V.RAD / s.wDeg
            if (d < bestD) { best = i; bestD = d }
        }
        return best
    }

    /**
     * Which resident close-up is displayed (GL thread, every frame, no allocation): as main.js islandArt.bind binds its
     * slot art to the camera, below [PhaseEIslandLayer.NEAR_ALT] the resident island nearest the view centre
     * (camera.t, in art widths, under NEAR_REACH); otherwise the displayed one stays. So a flight between two islands
     * keeps the one being left until the view centre is nearer the destination (review 2026-09-27: switching on the
     * flight's first frame dropped the island still on screen to its far layer). Runs the blur clock too.
     */
    private fun showNear(nowMs: Double) {
        V.norm(e0, camera.t)
        val low = camera.altOf(camera.z) < PhaseEIslandLayer.NEAR_ALT
        val at = if (low) nearestIsland(e0, residentOnly = false) else -1
        // the blur clock: the camera arrived (or rests) at [at] and its close-up is not displayed yet
        if (at != blurIsland) { blurIsland = -1; blurSince = Double.NaN }
        if (at >= 0 && at != blurIsland && !camera.flying && !(phaseE.nearActive && phaseE.nearIsland == at)) { blurIsland = at; blurSince = nowMs }
        val show = if (low) nearestIsland(e0, residentOnly = true) else -1
        if (show < 0 || show == phaseE.nearIsland || !phaseE.show(show)) return
        val blur = if (show == blurIsland && !blurSince.isNaN()) nowMs - blurSince else 0.0
        if (show == blurIsland) { blurIsland = -1; blurSince = Double.NaN }
        val id = P.PHASE_E[show].id
        val f = freshTimes
        if (show == nearFresh && f != null) {
            nearFresh = -1; freshTimes = null
            events.nearArt(id, false, f.decodeMs, f.resampleMs, f.mipMs, f.readyMs - f.builtMs, nowMs - f.askedMs, blur, f.inFlight)
        } else events.nearArt(id, true, 0.0, 0.0, 0.0, 0.0, 0.0, blur, false)
        idle?.invalidate()
    }

    /**
     * The island the near slots should hold (GL thread, every frame, no allocation): the live layer's island nearest the
     * camera's aim in art widths ([nearestIsland]) with the aim's altitude below [PhaseEIslandLayer.NEAR_ALT]; -1 for
     * none, [NEAR_HOLD] while the aim is unknown (a fling's inertia: never build what it passes over). The aim is the
     * intent, so the build starts when the approach does (owner 2026-09-27), not when the camera arrives:
     * - never while a realm is the aim (review 2026-09-27): a dive committed or running, a realm selected (its panel's
     *   prefetch), the approach prefetch fired for the realm under the view, or a flight that frames a realm, leaves a
     *   map or flies out ([nearFlightAims] false); these cancel a build too;
     * - an island selection's or a double tap's flight: its target and end altitude (a selection frames its island);
     * - else the view centre at the lowest of the altitude, the zoom target (the + / − tools heading down) and where a
     *   real pinch's trend takes it within [PINCH_LEAD_MS] ([pinchAltitude]).
     * Sets [nearMayCancel]: a flight, a realm aim or a resting camera may cancel a build for another island; a gesture
     * still in progress only starts one.
     */
    private fun nearTarget(motion: Boolean, nowMs: Double): Int {
        if (!phaseE.enabled || nearSource == null || !uploader.fillsAfterFirstFrame) return -1
        nearMayCancel = true
        if (diving || pendingDive >= 0 || selectedRealm >= 0 || approach.fired != null) return -1
        val alt: Double
        if (camera.flying) {
            if (!nearFlightAims) return -1
            V.norm(e0, camera.flightTarget); alt = camera.altOf(camera.flightZ)
        } else {
            if (camera.hasVel) return NEAR_HOLD
            V.norm(e0, camera.t); alt = minOf(camera.altOf(camera.z), camera.altOf(camera.zT), pinchAltitude(nowMs)); nearMayCancel = !motion
        }
        if (alt >= PhaseEIslandLayer.NEAR_ALT) return -1
        return nearestIsland(e0, residentOnly = false)
    }

    /** Where a real pinch zooming in reaches in [PINCH_LEAD_MS] at its current rate (+∞ when no pinch zooms in, or its
     *  last step is older than that: fingers held still). */
    private fun pinchAltitude(nowMs: Double): Double {
        if (pinchRate <= 0.0 || pinchMs.isNaN() || nowMs - pinchMs > PINCH_LEAD_MS) return Double.POSITIVE_INFINITY
        return camera.altOf(minOf(1.0, camera.z + pinchRate * PINCH_LEAD_MS))
    }

    /** One frame of the pinch trend ([pinchRate]): the zoom a two-finger gesture wrote since its last step. */
    private fun pinchStep(nowMs: Double) {
        if (gestures.active < 2) { pinchZ = Double.NaN; pinchMs = Double.NaN; pinchRate = 0.0; return }
        if (pinchMs.isNaN()) { pinchZ = camera.z; pinchMs = nowMs; pinchRate = 0.0; return }
        if (camera.z != pinchZ && nowMs > pinchMs) { pinchRate = (camera.z - pinchZ) / (nowMs - pinchMs); pinchZ = camera.z; pinchMs = nowMs }
    }

    /** Follow the aim: display by the view centre ([showNear]); cancel a build for another island when allowed, and
     *  start this one's when it is not resident and no build is out (one at a time). */
    private fun followNear(motion: Boolean, nowMs: Double) {
        if (!phaseE.enabled) return
        showNear(nowMs)
        val want = nearTarget(motion, nowMs)
        if (want == NEAR_HOLD) return
        nearAimed = want
        val live = if (nearBuilding >= 0 && nearLive != 0) nearBuilding else if (nearWaiting != null) nearWaitingIsland
            else if (nearPending != null) nearPendingIsland else -1
        if (live >= 0 && live != want && nearMayCancel) cancelNear()
        if (want < 0 || phaseE.resident(want)) return
        if (want == live || nearBuilding >= 0 || nearWaiting != null || nearPending != null || nearRefused[want]) return
        requestNear(want, nowMs)
    }

    /** Build island [i]'s near art on a decode thread (the host's world-load pool; its resample fans out over the
     *  island lanes). The slots keep what they hold until the new texture needs one ([adoptNear]). */
    private fun requestNear(i: Int, nowMs: Double) {
        val src = nearSource ?: return
        val gen = generation
        val token = ++nearSerial
        nearBuilding = i; nearLive = token; nearAskedMs = nowMs
        val cancelled = { nearLive != token || gen != generation }
        try {
            decode.execute {
                // an OutOfMemoryError here (or rethrown from a resample lane) costs only the near slot: the island keeps
                // its far layer, and the host logs it; a build cancelled while it finished keeps no 22 MB result in [nearOut]
                val o = if (cancelled()) Outcome(gen, NearArt(i, token, null), null)
                    else try { Outcome(gen, NearArt(i, token, src.build(i, cancelled)?.takeUnless { cancelled() }), null) } catch (t: Throwable) { Outcome(gen, NearArt(i, token, null), reason(t)) }
                put(nearOut, o) // taken by the next frame: [lateWork] keeps the idle cadence running while a build is out
            }
        } catch (e: RejectedExecutionException) { nearBuilding = -1; nearLive = 0; nearRefused[i] = true }
    }

    /** The camera left the island being built (or another is wanted, or a realm): the build stops at its next check and
     *  reports nothing to show; a finished build waiting for a slot is dropped; a texture still filling on the worker is
     *  freed (the worker skips the rest of its fills). */
    private fun cancelNear() {
        nearLive = 0
        nearWaiting = null; nearWaitingIsland = -1; nearTimes = null
        core.free(nearPending); nearPending = null; nearPendingIsland = -1
    }

    /**
     * The Phase E selection fields into 2D RG16F textures (the shared shader reads them through `sampler2D uSelIsleMap`,
     * and the worker uploader makes arrays): from the GL thread, at most [maxBytes] per call, in whole rows. After the
     * first world frame [maxBytes] is COLD_UPLOAD_BYTES (plan §5.3/§5.9: no bigger GL-thread upload), one strip per
     * rested frame; about 2.4 MB in all, so a dozen idle frames. A refused texture drops the Phase E part.
     */
    private fun uploadFields(maxBytes: Long) {
        val d = peData ?: return
        var budget = maxBytes
        while (peField < d.fields.size) {
            val f = d.fields[peField]
            val t = phaseE.fields[peField] ?: core.texture2D(Gl3Pool.GLOBE, f.width, f.height, Gl3Format.RG16F, 1, Gl3Sampling.LINEAR, Gl3Wrap.CLAMP)
                ?.also { phaseE.fields[peField] = it; phaseE.hu[peField] = f.hu; phaseE.hv[peField] = f.hv }
            if (t == null) {
                for (i in phaseE.fields.indices) { core.free(phaseE.fields[i]); phaseE.fields[i] = null }
                core.free(peArt); peArt = null; peData = null; peStrip = null; pePending = false
                return lateFail(PART_PHASE_E, "a selection field was refused (allocator)")
            }
            val rowBytes = f.width * 4
            val rows = minOf((f.height - peRow).toLong(), budget / rowBytes).toInt()
            if (rows <= 0) return
            val bytes = rows * rowBytes
            val strip = peStrip?.takeIf { it.capacity() >= bytes } ?: java.nio.ByteBuffer.allocateDirect(bytes).order(java.nio.ByteOrder.nativeOrder()).also { peStrip = it }
            strip.clear(); strip.put(f.rg16f, peRow * rowBytes, bytes); strip.flip()
            core.upload(t, 0, 0, 0, peRow, f.width, rows, strip)
            budget -= bytes; peRow += rows
            if (peRow >= f.height) { peField++; peRow = 0 }
        }
        peData = null; peStrip = null; peFieldsDone = true
    }

    /** The islands' two pairs are rehearsed: draw them and pick them by their art from now on (RG-1). */
    private fun islandsLive() {
        val v = isleAssets ?: return; val g = geography ?: return
        islesLive = true; islesPending = false; isleAssets = null
        picking = GlobePicking(g, realmIds, art, v.land).also { it.phaseE = phaseE.enabled }
        idle?.invalidate()
    }

    /** The Phase E draw is rehearsed: draw, pick and frame the islands from now on (what you see is what you tap). */
    private fun phaseELive() {
        phaseE.goLive(); pePending = false
        picking?.phaseE = true; camera.phaseE = true
        idle?.invalidate()
    }

    private fun lateFail(part: String, reason: String) {
        lateFailure = "$part: $reason"
        events.partUnavailable(part, reason)
    }

    private fun texture(d: GlobeTextureData): Gl3Texture? =
        uploader.fresh(core, Gl3Pool.GLOBE, d.width, d.height, d.layers, d.format, d.levels, d.sampling, d.wrap, d.pixels)

    private fun fail(reason: String) {
        if (state == FAILED) return
        state = FAILED; failure = reason
        events.unavailable(reason)
    }

    private fun restore() {
        // every GL name died with the old context; the core resubmits the programs itself (they are made again here)
        flat = null; isles = null; fx = null; blit = null; cover = null
        approach.reset()
        albedo = null; albedoHigh = null; ssg = null; clouds = null; selection = null; isleArt = null; low = null
        islands?.lost(); islands = null; isleAssets = null; islesLive = false
        phaseE.lost(); peArt = null; peData = null; peStrip = null; peFieldsDone = false; peBuilt = false; peField = 0; peRow = 0
        nearPending = null; nearPendingIsland = -1; nearWaiting = null; nearWaitingIsland = -1; nearBuilding = -1; nearLive = 0
        nearTimes = null; freshTimes = null; nearFresh = -1; nearAimed = -1; blurIsland = -1; blurSince = Double.NaN
        camera.phaseE = false
        scratchColor = null; scratchDepth = null; scratchRgba = null
        pairHead = 0; pairTail = 0; lowFrame = -1
        if (state == FAILED) return
        state = LOADING
        start()
    }

    /** The realm map took over (after a successful dive): no frames, no dive checks. */
    fun sleep() {
        asleep = true; diving = false; approach.reset()
        // the realm map holds no more of the islands than one slot: the spare goes, a build still out is cancelled
        phaseE.dropSpare(core); cancelNear()
        take(nearOut)?.let { nearBuilding = -1 }
    }

    /** The realm map closed: frame the realm the map showed, as main.js leaveRealm. */
    fun leave(realmId: String?, lon: Double, lat: Double, nowMs: Double) {
        asleep = false; diving = false; pendingDive = -1; nearFlightAims = false
        diveBlockUntil = nowMs + P.LEAVE_BLOCK_MS
        camera.stopMotion()
        val here = V.dirOf(d0, lon, lat)
        val r = realmId?.let { realmIds.indexOf(it) } ?: -1
        if (selectedRealm >= 0) {
            V.copy(camera.t, here)
            selectRealm(if (r >= 0) r else selectedRealm, nowMs, fly = true)
            val t2 = if (camera.flying) DoubleArray(3).also { V.copy(it, camera.flightTarget) } else here.copyOf()
            val z2 = if (camera.flying) camera.flightZ else camera.z
            camera.lensX = camera.lensTx; camera.lensY = camera.lensTy
            V.copy(camera.t, t2)
            camera.z = maxOf(z2, minOf(z2 + 0.06, camera.zOf(P.ALT_MIN_ATLAS))); camera.zT = camera.z
            camera.flyTo(t2, z2, nowMs, 900.0, GlobeEase.OUT)
            if (selT0 > nowMs) selT0 = entranceAt(900.0, nowMs)
        } else {
            V.copy(camera.t, here)
            camera.z = camera.zOf(0.7); camera.zT = camera.z
            camera.flyTo(V.dirOf(lon, lat), camera.zOf(0.9), nowMs, 900.0, GlobeEase.OUT)
            nearFlightAims = false // the realm's frame, not an island's
        }
        idle?.invalidate()
    }

    /** The host's answer to [GlobeEvents.dive]: false = the realm map could not open (main.js enterRealm catch). */
    fun diveResult(ok: Boolean, realmId: String, nowMs: Double) {
        diving = false
        if (ok) { sleep(); return }
        diveBlockUntil = nowMs + P.DIVE_FAIL_BLOCK_MS
        if (camera.altOf(camera.zT) < 0.34) { camera.stopFlight(); camera.zT = camera.zOf(0.34) }
        val r = realmIds.indexOf(realmId)
        if (r >= 0) selectRealm(r, nowMs, fly = true, durMs = 600.0)
    }

    /** O(1) (plan §5.9): `glDelete*` of the buffers only; the core frees textures and programs in its own dispose. */
    fun dispose() {
        islands?.dispose(core); islands = null; islesLive = false
        phaseE.dispose(core)
        generation++ // the decode tasks of this load skip their remaining jobs
    }

    // ---------------------------------------------------------------- intents and HUD tools (GL thread)

    fun apply(intent: WorldIntent, nowMs: Double) {
        when (intent) {
            is WorldIntent.Select -> when (val t = intent.target) {
                null -> deselect()
                is WorldTarget.Realm -> realmIds.indexOf(t.realmId).takeIf { it >= 0 }?.let { selectRealm(it, nowMs, fly = true) }
                is WorldTarget.Island -> selectIsland(t.islandId, nowMs)
                else -> Unit
            }
            is WorldIntent.FlyTo -> when (val t = intent.target) {
                is WorldTarget.Realm -> realmIds.indexOf(t.realmId).takeIf { it >= 0 }?.let { selectRealm(it, nowMs, fly = true) }
                else -> Unit
            }
            is WorldIntent.Dive -> realmIds.indexOf(intent.realmId).takeIf { it >= 0 }?.let { diveInto(it, nowMs) }
            is WorldIntent.SetNight -> night = intent.night
            is WorldIntent.SetReducedMotion -> reducedMotion = intent.reduced
            else -> Unit
        }
        idle?.invalidate()
    }

    /** The + / − tools (main.js tools 'in' / 'out'). */
    fun zoomBy(dz: Double) { camera.zT = V.clamp(camera.zT + dz, camera.zLo, 1.0); camera.hasAnchor = false; idle?.input(lastClockMs()) }

    /** The World tool: deselect and fly out to the home frame (main.js tools 'world'). */
    fun home(nowMs: Double) {
        deselect()
        val v = camera.view
        val alt = applyHome(v.w, v.h, snap = false)
        camera.flyTo(V.norm(d0, camera.t), camera.zOf(alt), nowMs); nearFlightAims = false
        updateLens()
        idle?.invalidate()
    }

    // ---------------------------------------------------------------- selection (main.js selectRealm/selectIsland/deselect)

    fun selectRealm(r: Int, nowMs: Double, fly: Boolean, durMs: Double = -1.0) {
        val g = geoms?.getOrNull(r) ?: return
        val fresh = !(selMode == 1 && selectedRealm == r && selK > 0.01)
        selectedRealm = r; selectedIsland = null
        selMode = 1; selKT = 1.0; selLayer = r.toFloat()
        accent(P.REALMS[r].accent)
        fxFrame(g.c)
        val dur = if (fly) focusOn(g.c, g.pts, g.count, P.REALM_FOCUS_ALT, durMs, nowMs).also { nearFlightAims = false } else 0.0
        if (fresh) selT0 = entranceAt(dur, nowMs)
        events.selected(realmIds[r], null)
    }

    /**
     * Phase E islands only, and only with that layer live (RG-3); otherwise ignored. main.js selectIsland: frame the
     * island (its tap ellipse × 1.7, floor 0.2) and, on a fresh selection, outline it exactly like a realm from its own
     * coast (D-166.1: `uSel.x = 2`, its prebaked field in the art's frame), drawn on as the camera settles.
     */
    fun selectIsland(id: String, nowMs: Double) {
        if (!phaseE.enabled) return
        val i = P.PHASE_E.indexOfFirst { it.id == id }
        if (i < 0) return
        val spec = P.PHASE_E[i]
        val fresh = !(selMode == 2 && selectedIsland == id && selK > 0.01)
        selectedRealm = -1; selectedIsland = id
        val c = V.dirOf(spec.lon, spec.lat); val cl = kotlin.math.cos(spec.lat * V.RAD)
        val pts = DoubleArray(24 * 3)
        for (a in 0 until 24) { val d = V.dirOf(spec.lon + kotlin.math.cos(a / 24.0 * 2 * PI) * spec.rx * 1.7 / cl, spec.lat + kotlin.math.sin(a / 24.0 * 2 * PI) * spec.ry * 1.7); pts[a * 3] = d[0]; pts[a * 3 + 1] = d[1]; pts[a * 3 + 2] = d[2] }
        val dur = focusOn(c, pts, 24, 0.2, -1.0, nowMs)
        nearFlightAims = true // its close-up builds while the camera flies there
        events.selected(null, id)
        if (!fresh) return
        if (phaseE.fields[i]?.ready != true) { selKT = 0.0; return } // no field resident: selected without an outline
        selMode = 2; selKT = 1.0; selIsle = i
        accent(spec.accent)
        fxFrame(c)
        selT0 = maxOf(entranceAt(dur, nowMs), nowMs)
    }

    fun deselect() {
        if (selectedRealm < 0 && selectedIsland == null) return
        selectedRealm = -1; selectedIsland = null; selKT = 0.0
        updateLens()
        events.selected(null, null)
    }

    private fun accent(rgb: Int) { selR = (rgb shr 16 and 255) / 255f; selG = (rgb shr 8 and 255) / 255f; selB = (rgb and 255) / 255f }
    private fun fxFrame(c: DoubleArray) { V.copy(selC, c); V.norm(selE, V.crossUp(selE, c)); V.cross(selN, c, selE) }
    private fun entranceAt(dur: Double, nowMs: Double): Double = nowMs + maxOf(0.0, dur * P.ENTRANCE_K - P.ENTRANCE_LEAD_MS)

    /** main.js focusOn: frame [pts] around [c] inside the free rect (the panel's, while a selection is shown). */
    private fun focusOn(c: DoubleArray, pts: DoubleArray, n: Int, minAlt: Double, durMs: Double, nowMs: Double): Double {
        updateLens()
        val v = camera.view; val f = freeRect(); val pad = P.FOCUS_PAD * camera.pxScale
        val alt = camera.fitAlt(pts, n, c, maxOf(60 * camera.pxScale, (f[2] - f[0]) / 2 - pad), maxOf(60 * camera.pxScale, (f[3] - f[1]) / 2 - pad),
            minAlt, v.w.toDouble(), v.h.toDouble())
        return camera.flyTo(c, camera.zOf(alt), nowMs, durMs)
    }

    private val free = DoubleArray(4)
    private fun panelOpen(): Boolean = (selectedRealm >= 0 || selectedIsland != null) && layout.panelFree != null
    /** main.js freeRect(): the screen, or what the panel leaves while a selection is shown. */
    private fun freeRect(): DoubleArray {
        val v = camera.view; val p = layout.panelFree
        if (panelOpen() && p != null) { free[0] = p[0].toDouble(); free[1] = p[1].toDouble(); free[2] = p[2].toDouble(); free[3] = p[3].toDouble() }
        else { free[0] = 0.0; free[1] = 0.0; free[2] = v.w.toDouble(); free[3] = v.h.toDouble() }
        return free
    }
    /** main.js updateLens(): the principal point at the free area's centre (or the home frame's centre). */
    private fun updateLens() {
        val v = camera.view; val w = v.w.toDouble(); val h = v.h.toDouble(); val f = freeRect(); val open = panelOpen()
        camera.lensTx = if (open) ((f[0] + f[2]) / 2 - w / 2) / (w / 2) else 0.0
        camera.lensTy = (h / 2 - (if (open) (f[1] + f[3]) / 2 else homeCy)) / (h / 2)
    }
    /** main.js applyHome(snap). Returns the home altitude. */
    private fun applyHome(w: Int, h: Int, snap: Boolean): Double {
        val l = layout
        val alt = camera.homeFrame(w.toDouble(), h.toDouble(), l.top.toDouble(), l.obstacles, l.obstacleCount, cy)
        camera.zLo = minOf(0.0, camera.zOf(alt)); homeCy = cy[0]
        if (snap) {
            camera.z = camera.zOf(alt); camera.zT = camera.z
            homeZ = camera.z; V.copy(homeT, camera.t)
            updateLens(); camera.lensX = camera.lensTx; camera.lensY = camera.lensTy
        }
        return alt
    }
    private fun atHome(): Boolean = !homeZ.isNaN() && !camera.flying && camera.z == homeZ && camera.zT == homeZ &&
        camera.t[0] == homeT[0] && camera.t[1] == homeT[1] && camera.t[2] == homeT[2]

    // ---------------------------------------------------------------- the dive (main.js diveInto / frame / enterRealm)

    fun diveInto(r: Int, nowMs: Double) {
        val id = realmIds.getOrNull(r) ?: return
        if (id !in divable || diving || asleep) return
        val target = geoms?.getOrNull(r)?.c ?: return
        diving = true
        V.norm(d0, camera.t)
        val far = acos(V.clamp(V.dot(d0, target), -1.0, 1.0)) > P.DIVE_FAR_RAD
        camera.flyTo(target, camera.zOf(P.DIVE_FLIGHT_ALT), nowMs, if (far) -1.0 else P.DIVE_FLIGHT_MS, if (far) GlobeEase.INOUT else GlobeEase.IN)
        nearFlightAims = false
        pendingDive = r
    }

    /**
     * Back during the approach flight of a committed dive ([diveInto]: "Enter map", the host still on the globe): the dive
     * is withdrawn, so the flight's end never enters the realm (owner rule: Back never looks like it worked and then pulls
     * the player into the map). The realm stays selected and is framed again from where the flight was, and a pinch dive
     * waits out the leave's block, as after a leave. Returns the realm's id, or null when no dive was committed (a dive
     * already handed to the host is its [GlobeEvents.dive]; the host cancels that one itself).
     */
    fun cancelDive(nowMs: Double): String? {
        if (!diving || pendingDive < 0) return null
        val r = pendingDive
        diving = false; pendingDive = -1
        diveBlockUntil = nowMs + P.LEAVE_BLOCK_MS
        camera.stopFlight()
        selectRealm(r, nowMs, fly = true)
        idle?.invalidate()
        return realmIds.getOrNull(r)
    }

    private fun enterRealm(id: String, lon: Double, lat: Double) {
        diving = true
        // the realm's loads and map never run beside the globe's spare close-up or an island build (sleep() is the backstop)
        phaseE.dropSpare(core); cancelNear()
        val v = camera.view
        val sStart = 0.5 * V.RAD * (v.pxPerRad / camera.pxScale) / v.alt
        events.dive(id, lon, lat, sStart)
    }

    // ---------------------------------------------------------------- input

    /** A tap from [GlobeGestures] (main.js tap): double tap zooms, a single tap picks. Screen px. */
    private fun tap(x: Double, y: Double, nowMs: Double) {
        val t = nowMs
        if (t - lastTapMs < P.DOUBLE_TAP_MS && hypot(x - lastTapX, y - lastTapY) < P.DOUBLE_TAP_PX * camera.pxScale) {
            if (camera.hitSphere(x, y, hit)) { camera.flyTo(hit, V.clamp(camera.z + P.DOUBLE_TAP_DZ, 0.0, 1.0), t, P.DOUBLE_TAP_MS2); nearFlightAims = true }
            lastTapMs = -1e9; return
        }
        lastTapX = x; lastTapY = y; lastTapMs = t
        val p = picking
        if (!camera.hitSphere(x, y, hit) || p == null) { deselect(); events.picked(GlobePickV2.Space); return }
        val lon = V.lon(hit); val lat = V.lat(hit)
        val v = camera.view
        val dist = sqrt((v.eye[0] - hit[0]) * (v.eye[0] - hit[0]) + (v.eye[1] - hit[1]) * (v.eye[1] - hit[1]) + (v.eye[2] - hit[2]) * (v.eye[2] - hit[2]))
        val footprint = PI / P.GEO_H * v.pxPerRad / dist
        val pick = p.pick(lon, lat, footprint)
        when (pick) {
            is GlobePickV2.Realm -> selectRealm(pick.index, nowMs, fly = true)
            // reported by selected(null, id) only (see GlobeEvents.picked)
            is GlobePickV2.PhaseE -> { selectIsland(pick.id, nowMs); return }
            else -> deselect()
        }
        events.picked(pick)
    }

    /** Touch in VIEW px from libGDX (the host's InputProcessor): converted to buffer px here (plan §3.7). */
    fun touchDown(pointer: Int, viewX: Float, viewY: Float, nowMs: Double) {
        if (!ready || asleep) return
        idle?.input(lastClockMs())
        gestures.down(pointer, input.viewToBufferX(viewX).toDouble(), input.viewToBufferY(viewY).toDouble(), nowMs)
    }
    fun touchDragged(pointer: Int, viewX: Float, viewY: Float, nowMs: Double) {
        if (!ready || asleep) return
        idle?.input(lastClockMs())
        gestures.move(pointer, input.viewToBufferX(viewX).toDouble(), input.viewToBufferY(viewY).toDouble(), nowMs)
    }
    fun touchUp(pointer: Int, viewX: Float, viewY: Float, nowMs: Double) {
        if (!ready || asleep) return
        idle?.input(lastClockMs())
        gestures.up(pointer, input.viewToBufferX(viewX).toDouble(), input.viewToBufferY(viewY).toDouble(), nowMs)
    }
    fun touchCancelled(pointer: Int) { gestures.cancel(pointer) }

    // ---------------------------------------------------------------- frame

    /** Input timestamps for the idle scheduler (its phases run on the frame time the host passes). */
    private fun lastClockMs(): Long = if (lastMs.isNaN()) 0L else lastMs.toLong()

    /**
     * GL thread, after `core.beginFrame` and before any pass. Returns true when [draw] has something to draw this frame
     * (READY and awake). [w], [h]: the buffer size; [ladder]: the current knobs (null = level 0 behaviour).
     */
    fun update(nowMs: Double, w: Int, h: Int, ladder: LadderKnobs? = null): Boolean {
        knobs = ladder
        frameNo++
        uploader.poll(core)
        if (state != FAILED) { adoptPrograms(); adoptFirst() }
        if (state != FAILED) adoptLate()
        if (state == LOADING && allReady(nowMs)) { state = REHEARSING; initialPairs() }
        if (state == REHEARSING) {
            rehearseNext()
            if (pairHead >= pairTail) { state = READY; events.ready(); idle?.invalidate() }
        }
        if (state != READY || asleep) { lastMs = nowMs; return false }
        if (lastLayout !== layout || lastW != w || lastH != h) {
            val first = lastLayout == null || lastW == 0
            camera.computeView(w, h)
            applyHome(w, h, snap = first || atHome())
            updateLens()
            lastLayout = layout; lastW = w; lastH = h
        }
        val dt = if (lastMs.isNaN()) 0.0 else minOf(P.DT_MAX, (nowMs - lastMs) / 1000)
        lastMs = nowMs
        val t = nowMs
        camera.computeView(w, h) // the gestures of this frame grab against the view they see
        // the zoom floor: realms whose map can open dive past it (main.js frame)
        V.norm(d0, camera.t)
        val lon = V.lon(d0); val lat = V.lat(d0)
        val region = geography?.regionAt(lon, lat) ?: -1
        val here = realmIds.getOrNull(region)
        val canDive = here != null && here in divable && t > diveBlockUntil
        val zMax = camera.zOf(if (canDive) P.ALT_MIN_ATLAS * P.DIVE_ALT_K else camera.minAltAt(camera.t))
        val pushed = camera.zT > zMax + .004 && !camera.flying && !diving
        // main.js noMapHint: a Phase E island names itself ("no map yet": island maps come with Phase E, D-172.2)
        if (pushed && !noMapShown) events.noMap(picking?.phaseEAt(lon, lat) ?: if (region >= 0) here else null)
        noMapShown = pushed
        var moving = camera.step(t, dt, zMax)
        // selection fade (0.32 s) and the dive
        if (selK != selKT) { selK = V.clamp(selK + Math.signum(selKT - selK) * dt / P.SEL_FADE_S, 0.0, 1.0); if (selK == 0.0) selMode = 0; moving = true }
        if (pendingDive >= 0 && !camera.flying) {
            val r = pendingDive; pendingDive = -1
            V.norm(d0, camera.t)
            enterRealm(realmIds[r], V.lon(d0), V.lat(d0))
        } else if (!camera.flying && !diving && camera.zT >= camera.z - 1e-3 && camera.altOf(camera.z) < P.DIVE_ALT && t > diveBlockUntil && canDive) {
            if (selectedRealm >= 0 && realmIds[selectedRealm] != here) deselect()
            enterRealm(here!!, lon, lat)
        }
        camera.computeView(w, h)
        if (islesLive) islands?.frame(camera, camera.pxScale)
        val motion = moving || gestures.active > 0 || camera.hasVel || camera.flying
        if (motion) lastMotionMs = t
        // D-NEXT: a dive is coming (a rest low over a realm with a map, or a pinch aiming below the approach altitude)
        approach.step(t, if (here != null && here in divable) here else null, camera.altOf(camera.z), camera.altOf(camera.zT),
            gestures.active >= 2, motion, camera.hasVel, camera.flying || diving)?.let {
            events.approach(it)
            // the realm's core prefetch starts now: no island build beside it, and the spare close-up goes (review 2026-09-27)
            phaseE.dropSpare(core); cancelNear()
        }
        // late pairs (the islands') are rehearsed, and the Phase E fields uploaded a strip at a time, only after the camera
        // has rested, never in a gesture or a flight: one piece of work per rested frame
        if (!motion && t - lastMotionMs >= GpuSafe.REHEARSE_IDLE_MS) {
            if (pairHead < pairTail) rehearseNext() else if (peData != null) uploadFields(GpuSafe.COLD_UPLOAD_BYTES.toLong())
        }
        // the near slots follow the camera's aim to the island it is heading for (a selection's flight, a pinch down, a
        // rest; never what a fling passes over, never a realm's); decode, resample and fill run off the GL thread
        pinchStep(t)
        followNear(motion, t)
        declareIdle(motion, t)
        publish()
        return true
    }

    // ---- rehearsal (plan §5.3 step 3): each (program, state) pair the globe draws is drawn once into a 1×1 scratch
    // target of the live target's formats before it is first drawn live, so Mali builds its pipeline variants behind the
    // loading state (or on an idle frame, for the late islands) instead of in a frame the player sees. One pair per frame.
    private val pairQueue = IntArray(8)
    private var pairHead = 0; private var pairTail = 0
    private var scratchColor: Gl3Texture? = null
    private var scratchDepth: Gl3Texture? = null
    private var scratchRgba: Gl3Texture? = null

    private fun enqueue(pair: Int) { if (pairTail < pairQueue.size) pairQueue[pairTail++] = pair }

    /** The pairs rehearsed before ready: the flat pass on the screen, the half-scale pass and its blit (when the blit
     *  program exists), and the islands if their art is already resident. */
    private fun initialPairs() {
        pairHead = 0; pairTail = 0
        enqueue(PAIR_FLAT)
        if (blit != null) { enqueue(PAIR_FLAT_LOW); enqueue(PAIR_BLIT) }
        if (cover != null) enqueue(PAIR_COVER)
        if (islands != null && !islesLive) { enqueue(PAIR_ISLES); enqueue(PAIR_FX) }
        if (peBuilt && !phaseE.enabled) enqueue(PAIR_PHASE_E)
    }

    private fun rehearseNext() {
        if (pairHead >= pairTail) return
        val color = scratchColor?.takeIf { it.ready } ?: core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.RGB8).also { scratchColor = it }
        val depth = scratchDepth?.takeIf { it.ready } ?: core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.DEPTH16).also { scratchDepth = it }
        if (color == null || depth == null) { pairHead = pairTail; afterPairs(); return } // no room for 1×1 scratch: skip, never block
        val layer = islands
        when (pairQueue[pairHead]) {
            PAIR_FLAT -> core.rehearse(color, depth, forScreen = true, testDepth = false) {
                core.disable(GL20.GL_CULL_FACE)
                val p = flat
                if (p != null && core.use(p)) { flatSamplers(p); core.fullscreen() }
            }
            PAIR_FLAT_LOW -> {
                // the half-scale pass: the same program into an RGBA8 target without depth (its own pipeline variant)
                val rgba = scratchRgba?.takeIf { it.ready } ?: core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.RGBA8).also { scratchRgba = it }
                if (rgba != null) core.rehearse(rgba, null, forScreen = false, testDepth = false) {
                    core.disable(GL20.GL_CULL_FACE)
                    val p = flat
                    if (p != null && core.use(p)) { flatSamplers(p); core.fullscreen() }
                }
            }
            PAIR_BLIT -> core.rehearse(color, depth, forScreen = true, testDepth = false) {
                core.disable(GL20.GL_CULL_FACE)
                val p = blit
                if (p != null && core.use(p)) { blitSamplers(p, core.dummy(false, false), 0.5); core.fullscreen() }
            }
            // the dive cover: blended over the screen, as [drawCover] draws it
            PAIR_COVER -> core.rehearse(color, depth, forScreen = true, testDepth = false) {
                core.disable(GL20.GL_CULL_FACE); core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
                val p = cover; val c = clouds
                if (p != null && c != null && core.use(p)) { coverUniforms(p, c, 0.5f, 0.0, 1, 1); core.fullscreen() }
            }
            PAIR_ISLES -> if (layer != null) core.rehearse(color, depth, forScreen = true, testDepth = false) {
                core.disable(GL20.GL_CULL_FACE); core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
                val p = isles
                if (p != null && core.use(p)) { isleSamplers(p, isleArt!!); layer.drawIsles(core, p) }
            }
            PAIR_FX -> if (layer != null) core.rehearse(color, depth, forScreen = true, testDepth = false) {
                core.disable(GL20.GL_CULL_FACE); core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
                val p = fx
                if (p != null && core.use(p)) layer.drawFxAlways(core)
            }
            // the Phase E draw: the islands' program and state (a pair of its own only when there are no exploration
            // islands; else already known, and the rehearsal is a no-op the core does not count)
            PAIR_PHASE_E -> { val art = peArt; if (art != null) core.rehearse(color, depth, forScreen = true, testDepth = false) {
                core.disable(GL20.GL_CULL_FACE); core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
                val p = isles
                if (p != null && core.use(p)) { isleSamplers(p, art); phaseE.draw(core) }
            } }
        }
        pairHead++
        afterPairs()
    }

    /** Every queued pair is rehearsed: a built island layer goes live. */
    private fun afterPairs() {
        if (pairHead < pairTail) return
        if (islands != null && !islesLive) islandsLive()
        if (peBuilt && !phaseE.enabled) phaseELive()
    }

    private fun flatSamplers(p: Gl3Program) {
        sampler(p, "uAlbedo", 0, albedo!!); sampler(p, "uSsg", 1, ssg!!); sampler(p, "uCloud", 2, clouds!!)
        sampler(p, "uSelMap", 3, selection!!); sampler(p, "uSelIsleMap", 4, selIsleField() ?: core.dummy(false, false))
    }
    private fun isleSamplers(p: Gl3Program, art: Gl3Texture) {
        sampler(p, "uIsleArt", 5, art); sampler(p, "uCloud", 2, clouds!!)
        sampler(p, "uSelMap", 3, selection!!); sampler(p, "uSelIsleMap", 4, selIsleField() ?: core.dummy(false, false))
    }
    /** The outlined Phase E island's field while the outline is in island mode and the field is resident, else null. */
    private fun selIsleField(): Gl3Texture? = if (selMode == 2) phaseE.fields.getOrNull(selIsle)?.takeIf { it.ready } else null
    /** rm-lowres-blit: `uLow` (the k× target, sampled with its texel-snapped AA) and `uK` (target px per screen px). */
    private fun blitSamplers(p: Gl3Program, t: Gl3Texture, k: Double) {
        sampler(p, "uLow", 0, t)
        core.gl.uniform1f(p.uniform(core, "uK"), k.toFloat())
    }

    private fun allReady(nowMs: Double): Boolean {
        val failed = flat?.state == Gl3Program.FAILED || isles?.state == Gl3Program.FAILED || fx?.state == Gl3Program.FAILED
        if (failed) { fail("a globe program failed to build: ${flat?.error ?: isles?.error ?: fx?.error}"); return false }
        val b = blit
        if (b != null && b.state == Gl3Program.FAILED) { blit = null; lateFail("half-scale blit", b.error ?: "the program failed to build") }
        val cv = cover
        if (cv != null && cv.state == Gl3Program.FAILED) { cover = null; lateFail(PART_COVER, cv.error ?: "the program failed to build") }
        // the cover is rehearsed with the globe's own pairs: its first use is a dive that already waits
        val programs = flat?.ready == true && isles?.ready == true && fx?.ready == true && (blit?.ready ?: true) && (cover?.ready ?: true)
        val textures = albedo?.ready == true && ssg?.ready == true && clouds?.ready == true && selection?.ready == true
        if (!programs || !textures) return false
        // a GL-thread-only uploader cannot fill after the first frame: every late part loads before it instead
        if (!uploader.fillsAfterFirstFrame) return !highPending && albedoHigh == null && islandsSettled()
        return islandsSettled() || islandHoldOver(nowMs)
    }

    /** Both island parts are built (their pairs then go into [initialPairs], so they are live at ready), failed, or
     *  absent (no island model, no Phase E flag). */
    private fun islandsSettled(): Boolean = (!islesPending || islands != null) && (!pePending || peBuilt)

    /** The islands' hold has run [ISLAND_HOLD_MS] since everything else was ready: the globe shows without them. */
    private fun islandHoldOver(nowMs: Double): Boolean {
        if (islandHoldSince.isNaN()) islandHoldSince = nowMs
        islandWaitMs = nowMs - islandHoldSince
        return islandWaitMs >= ISLAND_HOLD_MS
    }

    /** Late parts still on their way (decode, upload, the Phase E field strips, or a rehearsal): the idle scheduler keeps
     *  a slow cadence so their adoption never waits for input. */
    val lateWork: Boolean get() = state == READY && (highPending || albedoHigh != null || (islesPending && !islesLive) ||
        (pePending && !phaseE.enabled) || pairHead < pairTail || nearBuilding >= 0 || nearWaiting != null || nearPending != null)

    private var shownProgress = 0f
    /**
     * The loading meter (GL thread; the host feeds `bridge.loading` from it): finished first-stage decode jobs, linked
     * programs, resident first textures, the two island parts that hold the reveal (settled: built, failed or absent)
     * and rehearsed pairs over their totals, never moving backwards; 1 once ready.
     */
    val loadProgress: Float get() {
        if (state == READY) return 1f
        if (state == FAILED) return shownProgress
        val jobs = jobsTotal
        val programs = one(flat?.ready) + one(isles?.ready) + one(fx?.ready)
        val textures = one(albedo?.ready) + one(ssg?.ready) + one(clouds?.ready) + one(selection?.ready)
        val islandParts = one(!islesPending || islands != null) + one(!pePending || peBuilt)
        val pairsTotal = if (state == REHEARSING) pairTail else INITIAL_PAIRS
        val pairsDone = if (state == REHEARSING) pairHead else 0
        val done = minOf(jobsDone.get(), jobs) + programs + textures + islandParts + pairsDone
        val total = maxOf(jobs, 1) + 3 + 4 + 2 + pairsTotal
        shownProgress = maxOf(shownProgress, minOf(0.99f, done.toFloat() / total))
        return shownProgress
    }
    private fun one(b: Boolean?): Int = if (b == true) 1 else 0

    private fun declareIdle(moving: Boolean, t: Double) {
        val s = idle ?: return
        s.setMoving(moving)
        val animation = knobs?.animation ?: true
        val motion = animation && !reducedMotion
        s.animating(IdleScheduler.TAG_WATER, if (motion) WATER_PERIOD_MS else 0)
        s.animating(IdleScheduler.TAG_CLOUDS, if (motion && cloudAmount() > 0) WATER_PERIOD_MS else 0)
        s.animating(IdleScheduler.TAG_SELECT, if (motion && selMode > 0) SELECT_PERIOD_MS else 0)
        s.animating(IdleScheduler.TAG_ISLANDS, if (motion && islesLive && (islands?.visibleCount ?: 0) > 0) ExplorationIslandLayer.FX_STEP_MS.toInt() else 0)
        s.animating(TAG_LATE, if (lateWork) LATE_PERIOD_MS else 0)
        if (selMode > 0 && t - selT0 < P.FX_BUSY_MS && motion) s.setMoving(true)
    }

    private fun cloudAmount(): Double =
        if (!cloudsOn || knobs?.cloudShell == false) 0.0 else V.smooth(P.CLOUD_ALT0, P.CLOUD_ALT1, camera.view.alt)

    /** The WorldFrame for Compose (plan §3.4): camera and the realm label anchors in VIEW px (main.js updateLabels). */
    private fun publish() {
        val ex = frames ?: return
        val f = ex.back()
        val v = camera.view
        f.engine = WorldEngine.GLOBE; f.band = 0; f.ladderLevel = knobs?.level ?: 0
        f.cameraX = v.lon; f.cameraY = v.lat; f.cameraScale = v.alt
        f.anchorCount = 0
        if (v.alt > P.LABEL_ALT) {
            V.norm(e0, v.eye); val eL = v.eyeLen
            for (i in P.REALMS.indices) {
                val r = P.REALMS[i]
                V.dirOf(d0, r.lon, r.lat)
                if (V.dot(d0, e0) < 1 / eL + P.LABEL_LIMB) continue
                if (!camera.projectDir(d0, P.LABEL_LIFT, xy)) continue
                anchorXY[0] = input.bufferToViewX(xy[0].toFloat()); anchorXY[1] = input.bufferToViewY(xy[1].toFloat())
                f.addAnchor(i, anchorXY[0], anchorXY[1])
            }
            // the live Phase E islands are destinations too (main.js destinations: realms, then the islands), by the same rule
            if (phaseE.enabled) for (i in P.PHASE_E.indices) {
                val s = P.PHASE_E[i]
                V.dirOf(d0, s.lon, s.lat)
                if (V.dot(d0, e0) < 1 / eL + P.LABEL_LIMB) continue
                if (!camera.projectDir(d0, P.LABEL_LIFT, xy)) continue
                anchorXY[0] = input.bufferToViewX(xy[0].toFloat()); anchorXY[1] = input.bufferToViewY(xy[1].toFloat())
                f.addAnchor(PhaseEIslandLayer.ANCHOR_BASE + i, anchorXY[0], anchorXY[1])
            }
        }
        ex.publish()
    }

    // ---------------------------------------------------------------- draw

    // per-frame shading values, computed once per draw call (fields: no allocation)
    private var fSeconds = 0.0; private var fCloud = 0.0; private var fSelK = 0.0; private var fSelSeconds = 0.0
    private var fSelMotion = 0f; private var fClockMs = 0L; private var fAnimation = true

    private fun frameValues() {
        val v = camera.view
        fAnimation = (knobs?.animation ?: true) && !reducedMotion
        fClockMs = idle?.clockMs ?: lastMs.toLong()
        fSeconds = if (fAnimation) fClockMs / 1000.0 else 0.0
        // light: follows the camera (upper-left), or the real sun at night (main.js frame)
        V.norm(e0, V.crossUp(e0, v.t)); V.cross(n0, v.t, e0)
        if (night) V.norm(sun, V.set(sun, v.t[0] * P.NIGHT_SUN_T + e0[0] * P.NIGHT_SUN_EAST, v.t[1] * P.NIGHT_SUN_T + e0[1] * P.NIGHT_SUN_EAST, v.t[2] * P.NIGHT_SUN_T + e0[2] * P.NIGHT_SUN_EAST))
        else V.norm(sun, V.set(sun, v.t[0] * P.SUN_T + e0[0] * P.SUN_EAST + n0[0] * P.SUN_NORTH, v.t[1] * P.SUN_T + e0[1] * P.SUN_EAST + n0[1] * P.SUN_NORTH, v.t[2] * P.SUN_T + e0[2] * P.SUN_EAST + n0[2] * P.SUN_NORTH))
        fCloud = cloudAmount()
        fSelK = selK * selK * (3 - 2 * selK)
        fSelSeconds = (lastMs - selT0) / 1000
        fSelMotion = if (fAnimation && knobs?.shimmer != false) 1f else 0f
    }

    /** The ray–sphere pass into the bound target at [scale] of the buffer (1 = the screen or a full-size snapshot). */
    private fun drawFlat(scale: Double): Boolean {
        val pf = flat ?: return false
        core.disable(GL20.GL_DEPTH_TEST); core.disable(GL20.GL_BLEND); core.disable(GL20.GL_CULL_FACE)
        if (!core.use(pf)) return false
        common(pf, camera.view, scale)
        flatSamplers(pf)
        core.fullscreen()
        return true
    }

    /**
     * The half-scale step (ladder L2+, [GlobeCost.renderScale]): the ray–sphere pass into the globe's own k× target,
     * which [draw] then upscales with `rm-lowres-blit` (a quarter of the flat pass's fragments). Call it after [update]
     * (and any [drawTo]) and before `core.beginScreen`, as an offscreen pass must come first (plan §5.9). At L0/L1, or
     * without the blit program, it draws nothing and [draw] renders the sphere at full scale.
     */
    fun drawOffscreen() {
        if (state != READY || asleep) return
        val k = GlobeCost.renderScale(knobs)
        val b = blit
        if (k >= 1.0 || b == null || !b.ready) return
        val v = camera.view
        val t = lowTarget(maxOf(1, Math.ceil(v.w * k).toInt()), maxOf(1, Math.ceil(v.h * k).toInt())) ?: return
        frameValues()
        core.offscreen(t, load = Gl3Load.DONT_CARE) // the pass writes every pixel
        core.disable(GL20.GL_SCISSOR_TEST)
        if (drawFlat(k)) { lowFrame = frameNo; lowK = k }
    }

    private fun lowTarget(w: Int, h: Int): Gl3Texture? {
        val t = low
        if (t != null && t.ready && t.width == w && t.height == h) return t
        core.free(t)
        low = core.texture2D(Gl3Pool.GLOBE, w, h, Gl3Format.RGBA8, sampling = Gl3Sampling.LINEAR)
        return low
    }

    /** Draw the globe into the bound target (the screen, after `core.beginScreen`): the sphere (or, when [drawOffscreen]
     *  drew it this frame, its upscale), then the exploration islands and their features at full scale. */
    fun draw() { drawScene(allowLow = true) }

    private fun drawScene(allowLow: Boolean) {
        if (state != READY || asleep) return
        val v = camera.view
        frameValues()
        val b = blit; val t = low
        if (allowLow && lowFrame == frameNo && b != null && t != null && t.ready) {
            core.disable(GL20.GL_DEPTH_TEST); core.disable(GL20.GL_BLEND); core.disable(GL20.GL_CULL_FACE)
            if (core.use(b)) { blitSamplers(b, t, lowK); core.fullscreen() }
        } else drawFlat(1.0)
        val layer = if (islesLive) islands else null
        val peTex = if (phaseE.enabled) peArt else null
        val pi = isles
        if (pi == null || (layer == null && peTex == null)) return
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        if (core.use(pi)) {
            common(pi, v, 1.0)
            vp(pi, v)
            if (layer != null) {
                core.gl.uniform4f(pi.uniform(core, "uIsleGrid"), layer.gridX, layer.gridY, layer.gridZ, 0f)
                isleSamplers(pi, isleArt!!)
                layer.drawIsles(core, pi)
            }
            if (peTex != null) {
                // one island per layer: the cell is the whole layer, the box extent 1 (its rx, ry are the box itself)
                core.gl.uniform4f(pi.uniform(core, "uIsleGrid"), peTex.width.toFloat(), peTex.width.toFloat(), 1f, 0f)
                isleSamplers(pi, peTex)
                phaseE.draw(core)
                // the near slot's island from its own NEAR² art, in the same box (the far draw left it out)
                val nt = phaseE.near
                if (nt != null && phaseE.nearActive) {
                    core.gl.uniform4f(pi.uniform(core, "uIsleGrid"), nt.width.toFloat(), nt.width.toFloat(), 1f, 0f)
                    sampler(pi, "uIsleArt", 5, nt)
                    phaseE.drawNear(core)
                }
            }
        }
        if (layer == null) { core.disable(GL20.GL_BLEND); return }
        val pfx = fx
        if (pfx != null && core.use(pfx)) {
            common(pfx, v, 1.0)
            vp(pfx, v)
            core.gl.uniform4f(pfx.uniform(core, "uFx"), layer.phase(fClockMs, fAnimation).toFloat(), 0f, v.w.toFloat(), v.h.toFloat())
            for (i in 0 until layer.islandCount) core.gl.uniform4f(pfx.uniform(core, ISLE_FX[i]), layer.fx[i * 4], layer.fx[i * 4 + 1], 0f, 0f)
            layer.drawFx(core, pfx)
        }
        core.disable(GL20.GL_BLEND)
    }

    /** Draw into an offscreen colour target (the dive/leave snapshot for the realm engine's cross-fade), before the
     *  frame's screen pass (plan §5.9 frame order). Always at full scale: a one-off frame the fade holds. */
    fun drawTo(target: Gl3Texture) {
        if (state != READY) return
        core.offscreen(target)
        drawScene(allowLow = false)
    }

    /**
     * The dive's cloud cover ([GlobeDiveCover]) over whatever the bound screen pass has drawn so far: the globe, the
     * dive's snapshot fade, or the realm's live frame (the globe sleeps then; its cloud array stays resident). [amount]
     * 0..1 from the host's [DiveCoverClock], [seconds] its drift clock (held still under reduced motion), [w] × [h] the buffer.
     * Nothing without the program or the clouds.
     */
    fun drawCover(amount: Float, seconds: Double, w: Int, h: Int) {
        val p = cover ?: return
        val c = clouds ?: return
        if (state != READY || amount <= 0f || !p.ready || !c.ready) return
        core.disable(GL20.GL_DEPTH_TEST); core.disable(GL20.GL_CULL_FACE)
        core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA)
        if (core.use(p)) { coverUniforms(p, c, amount, if (reducedMotion) 0.0 else seconds, w, h); core.fullscreen() }
        core.disable(GL20.GL_BLEND)
    }

    private fun coverUniforms(p: Gl3Program, c: Gl3Texture, amount: Float, seconds: Double, w: Int, h: Int) {
        sampler(p, "uCloud", 2, c)
        core.gl.uniform4f(p.uniform(core, "uCover"), amount, seconds.toFloat(), w.toFloat(), h.toFloat())
    }

    /** D-NEXT: ms until the approach's rest answers ([GlobeApproach.wakeInMs]; the host asks for that frame), -1 for none. */
    fun approachWakeInMs(nowMs: Double): Double = if (state != READY || asleep) -1.0 else approach.wakeInMs(nowMs)

    /** A whole frame for a host that runs the globe alone: begin, update, the half-scale pass, screen, draw, end.
     *  Returns the frame's report (null when the core skipped the frame). Until READY nothing binds the screen. */
    fun renderFrame(nowMs: Double, contextId: Long, w: Int, h: Int, ladder: LadderKnobs? = null): gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3FrameReport? {
        val nanos = (nowMs * 1e6).toLong()
        if (!core.beginFrame(nanos, contextId)) return null
        if (update(nowMs, w, h, ladder)) {
            drawOffscreen()
            core.beginScreen(SKY_R, SKY_G, SKY_B, 1f)
            draw()
        }
        return core.endFrame(nanos)
    }

    private fun sampler(p: Gl3Program, name: String, unit: Int, t: Gl3Texture) {
        core.bindTexture(unit, t)
        core.gl.uniform1i(p.uniform(core, name), unit)
    }

    private fun vp(p: Gl3Program, v: GlobeView) {
        val m = v.vp; val g = core.gl
        g.uniform4f(p.uniform(core, "uVP0"), m[0], m[1], m[2], m[3]); g.uniform4f(p.uniform(core, "uVP1"), m[4], m[5], m[6], m[7])
        g.uniform4f(p.uniform(core, "uVP2"), m[8], m[9], m[10], m[11]); g.uniform4f(p.uniform(core, "uVP3"), m[12], m[13], m[14], m[15])
    }

    /** The uniforms every globe program shares. [scale]: the target's px per buffer px (uEye.w is radians per TARGET px). */
    private fun common(p: Gl3Program, v: GlobeView, scale: Double) {
        val g = core.gl; val m = v.inv
        g.uniform4f(p.uniform(core, "uInvVP0"), m[0], m[1], m[2], m[3]); g.uniform4f(p.uniform(core, "uInvVP1"), m[4], m[5], m[6], m[7])
        g.uniform4f(p.uniform(core, "uInvVP2"), m[8], m[9], m[10], m[11]); g.uniform4f(p.uniform(core, "uInvVP3"), m[12], m[13], m[14], m[15])
        g.uniform4f(p.uniform(core, "uEye"), v.eye[0].toFloat(), v.eye[1].toFloat(), v.eye[2].toFloat(), (1 / (v.pxPerRad * scale)).toFloat())
        g.uniform4f(p.uniform(core, "uSun"), sun[0].toFloat(), sun[1].toFloat(), sun[2].toFloat(), if (night) 1f else 0f)
        g.uniform4f(p.uniform(core, "uClock"), fSeconds.toFloat(), (fSeconds * P.CLOUD_ROT_PER_S).toFloat(), fCloud.toFloat(), v.alt.toFloat())
        // island mode needs its field resident (a context loss drops it until the Phase E part reloads): else no outline
        val island = selMode == 2 && selIsleField() != null
        val mode = if (selMode == 2 && !island) 0 else selMode
        g.uniform4f(p.uniform(core, "uSel"), (if (mode > 0 && fSelK > 0) mode else 0).toFloat(), fSelK.toFloat(), fSelSeconds.toFloat(), fSelMotion)
        g.uniform4f(p.uniform(core, "uSelCol"), selR, selG, selB, 1f)
        g.uniform4f(p.uniform(core, "uSelC"), selC[0].toFloat(), selC[1].toFloat(), selC[2].toFloat(), selLayer)
        g.uniform4f(p.uniform(core, "uSelE"), selE[0].toFloat(), selE[1].toFloat(), selE[2].toFloat(), 0f)
        g.uniform4f(p.uniform(core, "uSelN"), selN[0].toFloat(), selN[1].toFloat(), selN[2].toFloat(), 0f)
        // the island field's window half extents (radians, globe-v2.json hu/hv); unused by a realm
        if (island) g.uniform4f(p.uniform(core, "uSelIsle"), phaseE.hu[selIsle].toFloat(), phaseE.hv[selIsle].toFloat(), 0f, 0f)
        else g.uniform4f(p.uniform(core, "uSelIsle"), 1f, 1f, 0f, 0f)
    }

    /** The albedo cube the flat pass samples now (256 until the 1024² cube is resident; tests and the debug readout). */
    val albedoSize: Int get() = albedo?.width ?: 0
    /** The exploration islands are drawn and picked (their art is resident and their draws rehearsed). */
    val islandsShown: Boolean get() = islesLive

    /** Resident globe bytes in the allocator tally (plan §5.8 gpuMB.globe). */
    val gpuBytes: Long get() = core.stats.gpuBytes(Gl3Pool.GLOBE)

    companion object {
        const val PROGRAM_FLAT = "globe-flat"
        const val PROGRAM_ISLES = "globe-isles"
        const val PROGRAM_FX = "globe-fx"
        /** The half-scale upscale: the realm engine's pinned lowres blit (layout(location = 0), texel-snapped AA). */
        const val PROGRAM_BLIT = "rm-lowres-blit"
        private val REQUIRED = arrayOf(PROGRAM_FLAT, PROGRAM_ISLES, PROGRAM_FX)
        /** Decode tasks per stage: the host's world-load pool has two threads (plan §5.7). */
        const val PARALLEL = 2
        const val LOADING = 0
        const val READY = 1
        const val FAILED = 2
        /** Programs and textures are resident; the (program, state) pairs are being rehearsed, one per frame. */
        const val REHEARSING = 3
        // the (program, state) pairs the globe rehearses
        private const val PAIR_FLAT = 0
        private const val PAIR_FLAT_LOW = 1
        private const val PAIR_BLIT = 2
        private const val PAIR_ISLES = 3
        private const val PAIR_FX = 4
        private const val PAIR_PHASE_E = 5
        private const val PAIR_COVER = 6
        /** The Phase E islands' late part, as [GlobeEvents.partUnavailable] names it. */
        const val PART_PHASE_E = "phase-e islands"
        /** The near slot's art (one island at NEAR²), as [GlobeEvents.partUnavailable] names it: that island keeps its
         *  far layer. */
        const val PART_PHASE_E_NEAR = "phase-e near art"
        /** [nearTarget]: the camera's aim is unknown this frame (a fling's inertia): keep what is being built. */
        private const val NEAR_HOLD = -2
        /** How far ahead a real pinch's zoom trend aims ([nearTarget]; review 2026-09-27: a pinch writes zT = z, so without
         *  it a pinch built only once the camera itself was below NEAR_ALT): about the 4-lane build on the Seeker
         *  (81–118 ms on an M3, a few times that on the device), so the close-up is building while the fingers still
         *  spread. Native tuning, not a game number. */
        const val PINCH_LEAD_MS = 250.0
        /** The dive's cloud cover, as [GlobeEvents.partUnavailable] names it: a waiting dive then shows the globe alone. */
        const val PART_COVER = "dive cover"
        /** The loading meter's pair estimate before the rehearsal starts (flat, half-scale flat, blit). */
        private const val INITIAL_PAIRS = 3
        /**
         * How long the reveal may wait for the islands once everything else is ready (owner 2026-10-06: the islands must
         * be in the globe's first frame). Native tuning, not a game number. Unmeasured on the Seeker: the base globe was
         * ready in 1.1 s there (2026-09-25) and the islands decode on the two load threads right behind its first stage
         * (14 exact PNG decodes for the exploration chains; three WebP decodes and three 1024² resamples across the
         * island lanes for Phase E), estimated well under this. The bound only matters when a chain group still downloads (the first
         * World entry; WorldPackFiles gives those 20 s) or the device is throttled: the player then gets the globe
         * after this wait and the islands as soon as they are resident, never a loading screen held longer for them.
         */
        const val ISLAND_HOLD_MS = 6_000.0
        /** An idle-scheduler tag of the globe's own (the scheduler's named tags end at 5): the slow cadence that adopts
         *  the late parts when nothing else asks for a frame. */
        const val TAG_LATE = 6
        const val LATE_PERIOD_MS = 100
        /** The idle cadence of the sea shimmer and the cloud drift, and of the selection shimmer (the concept's idle
         *  redraw: ~20 fps, 30 fps with a selection); the scheduler caps both by the C10 phases. */
        const val WATER_PERIOD_MS = 50
        const val SELECT_PERIOD_MS = 33
        /** The clear colour under the full-screen pass (the pass writes every pixel; this only shows if it is skipped). */
        const val SKY_R = 0.02f; const val SKY_G = 0.025f; const val SKY_B = 0.05f
        /** "uIsleFx[i]" location names, built once (the frame never builds a string). */
        private val ISLE_FX = Array(ExplorationIslandLayer.MAX_ISLANDS) { "uIsleFx[$it]" }
    }
}
