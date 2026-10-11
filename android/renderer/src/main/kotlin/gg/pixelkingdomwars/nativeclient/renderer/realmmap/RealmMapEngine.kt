package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Load
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Restorable
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3UniformBlock
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderKnobs
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executor
import java.util.concurrent.RejectedExecutionException
import java.util.function.DoubleSupplier
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/** Discrete realm-map events for the UI (GL thread; the host publishes them through its epoch-guarded channel). */
interface RealmMapListener {
    /** The selection changed: a base ([base] ≥ 0), an open deed ([base] = −1, [deedX] ≥ 0) or nothing (all −1).
     *  [tileId] is the catalog tile (the server's address), −1 when nothing is selected. */
    fun onSelection(base: Int, deedX: Int, deedY: Int, tileId: Int) {}
    /** The map asks to leave (a pinch-out below 0.7 × the rest floor): the globe takes over at ([lon], [lat]). Once per
     *  visit; the host answers with its leave (the realm snapshot faded out over the globe's fly-out, plan §3.5). */
    fun onExit(lon: Double, lat: Double) {}
    /**
     * A tap on the map at ([cssX], [cssY]) over the CATALOG deed ([catalogX], [catalogY]) (−1 outside the realm grid).
     * Return true when the HUD answers it (NU: a counter tap → `FlyTo`, else `Select(Deed)`; the engines never select
     * on their own initiative); false lets the engine do map.js `onTap` itself (counter fly, else pick and select).
     */
    fun onTap(catalogX: Int, catalogY: Int, cssX: Double, cssY: Double): Boolean = false
    /** A realm's first-frame set failed its checks: the realm cannot open (never drawn approximately). */
    fun onFailed(realmId: String, reason: String) {}
    /**
     * Band readiness cue (web ui.js scale pill, W1 S2): [held] while the zoom waits at a band gate the player pushes
     * against, for [band] (1 = MAP, 2 = TRUE), [progress] 0..1 of that band's rehearsal (the pill shows
     * `detail N%`). Conflated: sent only when a value changes (progress in 5 % steps).
     */
    fun onGate(held: Boolean, band: Int, progress: Double) {}
}

/** The realm engine's counters for the debug overlay, `[world-perf]` and the tests (plan §8.3). */
class RealmMapStats {
    var realm: String? = null
    var status = RealmMapEngine.STATUS_NONE
    var failure: String? = null
    var band = RealmBand.FAR
    var d = 0.0
    var fadeWeight = 0.0
    var groundScale = 1.0
    /** The ground display pass the frame drew alone ([RealmEngineConfig.PASS_CHART] …) or PASS_NONE in a fade. */
    var groundPass = RealmEngineConfig.PASS_NONE
    var maskMismatch = 0
    var catalogUsed = false
    var packStatus: String? = null
    /** The core's pairs (dive readiness). */
    var pairsRehearsed = 0
    var pairsTotal = 0
    /** The lanes' pairs (band readiness). */
    var lanePairsRehearsed = 0
    var lanePairsTotal = 0
    var lanePairsNothing = 0
    var rehearsalDraws = 0L
    var deferredUploads = 0L
    var framesDrawn = 0L
    var snapshots = 0L
    var bytesRead = 0L
    /** The zoom limit in force: band readiness or the overview clamp (+∞ = none). */
    var limitD = Double.POSITIVE_INFINITY
    var overviewClamp = false
    /** The gate in force: band 0 none / 1 MAP / 2 TRUE, and why ([RealmMapEngine.GATE_REHEARSAL] …). */
    var gateBand = 0
    var gateReason = 0
    var gateProgress = 1.0
    /** The stall valve opened a gate without rehearsal progress (map.js `rh.valve`, logged). */
    var valveOpened = false
    /** Retired by D-NEXT (amends D-173: overview first): dive readiness is the core's FAR set only, so there is no
     *  landing valve. Always false; kept until the host's `[world-engine]` log lines stop printing it. */
    var landValveOpened = false
    /** "Enter map" readiness while the realm prepares (the core's FAR set: first-frame textures, core programs, core
     *  pairs): the items done over the items known now ([readinessRaw]) and the meter the HUD and the host's dive bound
     *  read ([readinessPeak], never back). */
    var readinessRaw = 0.0
    var readinessPeak = 0.0
    /** Retired by D-NEXT (the D-173 lane items of dive readiness and its landing valve's count): always 0; kept until
     *  the host's dive-wait log line stops printing them. */
    var landDone = 0
    var landTotal = 0
    var landStallMs = 0.0
    /** The camera's rest floor, device px per deed: always 0 (the whole-realm fit). D-NEXT retired D-173's MAP floor;
     *  kept until the host's band log line stops printing it. */
    var floorD = 0.0
    /** Lanes held this frame (bit i = lane i), lanes disabled (a program failed) and lanes opened for the resident
     *  realm (D-NEXT: one at a time after READY, GROUND → LIFE → BASES). */
    var lanesHeld = 0
    var lanesDisabled = 0
    var lanesOpened = 0
    /** The core drew the stand-in occupancy dots this frame (no bases lane drew the bases). */
    var occupancyDots = false
    /** The selected open deed's box drew this frame ([RealmSelectBox]). */
    var selectBox = false
    var exitRequests = 0
    var counters = 0
    var counterSum = 0
    var basesOnScreen = 0
}

/** What a lane receives when the core adopts a realm's first-frame set (GL thread; map.js `loadModules` → `load(pack)`). */
class RealmOpen(
    val realmId: String,
    val meta: RealmMeta,
    val grid: RealmGrid,
    /** The catalog deeds mask the core draws and picks with (server truth; the pack's paint is compared, never used). */
    val deeds: ByteArray,
    /** The far field (ground.js `farField` = minimap.js `farDeeds`, ×16 R8), the bytes the core's chart samples. */
    val far: ByteArray,
    /** The painting's open-sea colour (ground.js `palette().seaFar` = minimap.js `ringSea`), 0..1 RGB. */
    val sea: FloatArray,
    /** Verified reads of the pack's detail files ([RealmLoader.detail]); decode threads only. */
    val loader: RealmLoader,
    /** The decode executor (never the GL thread). */
    val executor: Executor,
    /** Bumped by every open (a realm change, a context restore): drop worker results of an older one. */
    val generation: Int,
    /** Ask the host for a frame (thread-safe): a lane whose worker finished calls it so the GL thread adopts the result. */
    val wake: Runnable,
    val bases: RealmBases,
    val plots: RealmPlotRules,
    val config: RealmEngineConfig,
)

/**
 * The realm map (web `map.js`): one resident realm, drawn as the web's FAR ground (`rm-chart`, the painting in its own
 * sea: [RealmChart]) with the base points, the minimap, the ground up-scale at the ladder's integer ground scale,
 * picking, cluster counters, filters, selection and flights, the dive/leave cross-fade — and the N3 detail lanes
 * ([RealmLane]: ground, life, bases) behind band readiness.
 *
 * Life cycle, all on the GL thread (plan §3.5; D-NEXT "overview first, live", amends D-173):
 * 1. [prepare] at the realm panel's open (or `prepare(id, lanes = false)` from the globe's approach prefetch: the core
 *    only): sources are read and the first-frame set decoded and verified on [executor]; [update] then creates the
 *    programs (built on the worker context) and fresh textures (filled on the worker).
 * 2. [rehearseStep] in idle globe frames, one never-drawn (program, state) pair per call into a same-format scratch
 *    target, until [ready]. Dive readiness = the core's FAR set: the first-frame textures resident, the core's programs
 *    adopted and every core pair rehearsed. It never waits on a lane (D-173's lane items took a cold dive to 2.6–5.7 s on
 *    the Seeker; the owner's bar is ~1 s). Pairs rehearsed in this GL context stay rehearsed across realm changes.
 * 3. From READY, with the lanes wanted (a lanes prepare, or [enter]), the detail lanes open ONE AT A TIME in list order
 *    (GROUND → LIFE → BASES), each after the one before it settled or failed, in work frames and at [enter] (an open only
 *    starts a worker decode, so GROUND's runs under the dive's fade): at most one lane load is in flight and none during
 *    the dive wait. Every work frame lets each opened lane [RealmLane.adopt] its finished
 *    loads, held or not. While the realm waits behind the globe ([prefetchDue]) the host's idle globe frames call
 *    [rehearseStep], which updates the lanes on a whole-realm view and rehearses one lane pair.
 * 4. [enter] at the dive's arrival (camera placement only, at the globe's own scale, d = clamp(sStart·dpr, fit·dpr,
 *    farEnd)), [renderSnapshot] once, then the host composites it over the globe with [fade] and ends with
 *    [RealmDiveFade.finish]; from then [frame] draws live. Nothing moves the camera after the landing: the player zooms
 *    in themselves, and MAP then TRUE sharpen as they do. Each live frame runs at most one lane rehearsal step before its
 *    passes (idle, or urgent: the camera waits at a gate, or a lane is held in the band on screen), and the zoom stops at
 *    a band's edge until that band is ready (map.js `bandGate`; D-177: a lane still loading never closes a band, so
 *    the first pinch-in never waits for a load), lifted by the stall valve after `rehearse.stallMs` without progress.
 * 5. [leave] (◀ Globe, Back, or a pinch-out below 0.7 × the whole-realm fit: [RealmMapListener.onExit]): [renderSnapshot]
 *    the last frame, fade it out over the globe, then [release] (frees the realm's GPU objects; a quick re-dive stays
 *    warm) or the eviction at [evictAtMs].
 *
 * Every GL-thread call is bounded: no link, no status query, no fence wait, no upload over `coldUploadBytes`; work that
 * would upload ([update]) or draw a first pair ([rehearseStep]) runs only when the host allows it (never in a flight or
 * a fade). [dispose] and [release] issue only `glDelete*`. A steady frame allocates nothing.
 */
class RealmMapEngine(
    private val core: Gl3Core,
    val config: RealmEngineConfig,
    private val plots: RealmPlotRules,
    deedArt: Double,
    private val loader: RealmLoader,
    private val catalog: RealmCatalog?,
    private val uploads: RealmUploads,
    private val executor: Executor,
    private val clock: DoubleSupplier,
    fadeMs: Double,
    private val shaderSources: () -> Map<String, RealmProgramSource> = { RealmPrograms.load() },
    lanes: List<RealmLane> = emptyList(),
) : RealmGestureListener {
    val rules = RealmBandRules(config.bands, deedArt)
    val cam = RealmCamera(rules, clock)
    val gestures = RealmGestures(cam, this)
    val bases = RealmBases(plots)
    val cluster = RealmCluster()
    val minimap = RealmMinimap(core)
    val fade = RealmDiveFade(core, fadeMs)
    val selectBox = RealmSelectBox(core)
    val view = RealmView()
    val stats = RealmMapStats()
    var listener: RealmMapListener? = null
    /** Ask the host for a frame from any thread (the host sets it to its pacer's `markDirty`). */
    var wakeListener: Runnable? = null
    /** The ladder's knobs per level (the host's `FrameLadder.knobs`), for the lanes' LIFE cap and resolve slices. */
    var ladderKnobs: Array<LadderKnobs>? = null

    private val lanes: Array<RealmLane> = lanes.toTypedArray()
    private val laneCount = this.lanes.size

    // ---- resident realm ----
    var realmId: String? = null; private set
    var status = STATUS_NONE; private set
    private var generation = 0
    private val inbox = ConcurrentLinkedQueue<Any>()
    private var sources: Map<String, RealmProgramSource>? = null
    private var first: RealmFirstSet? = null
    var grid: RealmGrid? = null; private set
    /** The deeds mask the map picks with (the catalog's when there is one). */
    var deeds: ByteArray = ByteArray(0); private set
    private var meta: RealmMeta? = null
    private var farBytes = ByteArray(0)
    private val sea = floatArrayOf(SEA_R, SEA_G, SEA_B)
    private var chart: Gl3Texture? = null
    private var deedsTex: Gl3Texture? = null
    private var farTex: Gl3Texture? = null
    private var occTex: Gl3Texture? = null
    private var fieldsTex: Gl3Texture? = null
    private var occ = ByteArray(0)
    private var occBuf: ByteBuffer = ByteBuffer.allocateDirect(1)
    private var occDirty = false
    private var pointsDirty = false
    private var mx = DoubleArray(1); private var my = DoubleArray(1); private var mf = IntArray(1)
    var programs: RealmProgramSet? = null; private set
    private var ubo: Gl3UniformBlock? = null
    private var scratchScreen: Gl3Texture? = null
    private var scratchDepth: Gl3Texture? = null
    private var scratchRgba: Gl3Texture? = null
    private var chart16Stand: Gl3Texture? = null
    private var glEpoch = -1

    // ---- live state ----
    var active = false; private set
    private var leftAt = Double.NaN
    private var bufferW = 1; private var bufferH = 1; private var dpr = 1.0
    var ladderLevel = 0
    var reducedMotion = false
    private var workAllowed = false
    private var lastPass = RealmEngineConfig.PASS_NONE
    private var lastFade = true
    private var groundLane = -1
    private val pick = RealmPickResult()
    private var safeL = 0.0; private var safeT = 0.0; private var safeR = 0.0; private var safeB = 0.0
    private var countersSig = Double.NaN
    private var countersVersion = -1
    private var chromeGen = 0
    private var countersChrome = -1
    private var latestBases: WorldBases? = null
    private var restoring = false
    private var exitRequested = false
    private var lastInputMs = -1e12
    private var viewValid = false

    // ---- rehearsal (GPU_SAFE.rehearse): the core's pairs first (dive readiness), then the lanes' (band readiness) ----
    private val pairProgram = ArrayList<Gl3Program>()
    private var pairTarget = IntArray(16)
    private var pairLane = IntArray(16)
    private var pairSet = IntArray(16)
    private var pairDone = BooleanArray(16)
    private var pairNothing = BooleanArray(16)
    private var pairNext = DoubleArray(16)
    private var pairTries = IntArray(16)
    private var pairCount = 0
    private var corePairs = 0
    /**
     * Every (program, target, lane) pair rehearsed in the GL context of [rehearsedEpoch] ([pairKey]), core and lane pairs
     * alike, whatever the realm: map.js `rh.done` is keyed by the program object, which lives as long as its context, and
     * the core caches programs by name, so a realm change finds the same programs and their pipelines already built (the
     * 9 core pairs cost ~150 ms of a Seeker's cold dive each time). Cleared on a context change. N3 carried only the lane
     * pairs, and lost them: the carry ran at the core's adoption, before the lanes had their programs back.
     */
    private val rehearsedKeys = HashSet<Long>()
    private var rehearsedEpoch = -1
    private val laneLists = arrayOfNulls<List<Gl3Program>>(laneCount)
    private val laneSizes = IntArray(laneCount) { -1 }
    private val laneSettled = BooleanArray(laneCount)
    private val lanePending = BooleanArray(laneCount)
    private val laneDisabled = BooleanArray(laneCount)
    private val laneHeld = BooleanArray(laneCount)
    /** Some pair of lane i is rehearsed (its hook has drawn in this context): its "nothing" answers are final. */
    private val laneDrew = BooleanArray(laneCount)
    /** The band-gate stall valve (map.js `rh.stall` / `rh.valve`): ms of frames that gave a closed rehearsal gate its
     *  chance since progress last went past [valveBest], the time of the last check, and whether the frame
     *  before this one was such a chance ([valveChance]: then this frame's full interval counts, however long). */
    private var stall = 0.0
    private var valve = false
    private var valveCheckMs = Double.NaN
    private var valveChance = false
    private var valveBest = -1
    private var mapHoldT = Double.NaN
    private var rehearsedFrame = -1L
    private var gateLim = Double.POSITIVE_INFINITY
    private val gateOut = RealmGateLimit()
    private var gateBand = 0
    private var gateReason = 0
    private var sentHeld = false; private var sentBand = -1; private var sentProgress = -1.0

    // ---- D-NEXT (amends D-173): overview first; the lanes open after READY, one at a time ----
    /** The "Enter map" meter ([advanceReadiness]): never goes back, and moves on every item done past the most ever done
     *  ([readinessDone]). */
    private var readinessPeak = 0.0
    private var readinessDone = 0
    /** What an opening lane receives (built at the core's adoption; the lanes open later, [openLanes]). */
    private var openRealm: RealmOpen? = null
    /** Lane i was opened for the resident realm ([RealmLane.open]); an unopened lane has no programs, no pairs, draws
     *  nothing and holds nothing. */
    private val laneOpened = BooleanArray(laneCount)
    /** The lanes may open: a lanes [prepare] (the realm panel) or [enter]; a core-only prepare (the globe's approach
     *  prefetch) leaves them shut. */
    private var lanesWanted = false
    /** A core-only prepare never entered: freed `approachEvictMs` after it (NaN: none). */
    private var approachAt = Double.NaN

    private val restore = Gl3Restorable { restoreAfterLoss() }
    private val wakeHook = Runnable { wakeListener?.run() }
    init { core.onRestore(restore) }

    // =============================================================== loading

    /**
     * Start loading [id] (idempotent while it loads or is resident). Refused while another realm is open; any other
     * resident realm is freed first (one resident realm). Decoding and verification run on [executor]; nothing touches GL
     * until [update]. [lanes] false (the globe's approach prefetch) loads the core's FAR set only, freed
     * `approachEvictMs` after its last prepare unless a lanes prepare or [enter] wants it first; true (the realm panel)
     * also opens the detail lanes after READY, and wants a realm left moments ago again (no eviction at [evictAtMs]).
     */
    fun prepare(id: String, lanes: Boolean = true): Boolean {
        if (realmId == id && status != STATUS_FAILED) {
            if (lanes) { lanesWanted = true; approachAt = Double.NaN; if (!active) leftAt = Double.NaN }
            else if (!lanesWanted && !active) approachAt = clock.asDouble
            return true
        }
        if (active) return false
        releaseResident()
        realmId = id; status = STATUS_LOADING; stats.realm = id; stats.status = status; stats.failure = null
        lanesWanted = lanes; approachAt = if (lanes) Double.NaN else clock.asDouble
        resetMeter()
        val gen = ++generation
        val have = sources
        try {
            executor.execute {
                try {
                    val src = have ?: shaderSources()
                    inbox.offer(Loaded(gen, src, loader.firstSet(id, config, catalog)))
                } catch (e: Exception) { inbox.offer(Failed(gen, id, e.message ?: e.javaClass.simpleName)) }
            }
        } catch (e: RejectedExecutionException) { fail(id, "decode executor refused the load") }
        return true
    }

    private class Loaded(val gen: Int, val sources: Map<String, RealmProgramSource>, val first: RealmFirstSet)
    private class Failed(val gen: Int, val id: String, val reason: String)

    private fun fail(id: String, reason: String) {
        status = STATUS_FAILED; stats.status = status; stats.failure = reason
        listener?.onFailed(id, reason)
    }

    /**
     * Per-frame bookkeeping before any pass (GL thread, after `Gl3Core.beginFrame`). With [workAllowed] (the host: no
     * flight, no fade) it adopts load results (creates programs and fresh textures) and flushes the occupancy and minimap
     * uploads, and once the realm is READY lets every opened lane [RealmLane.adopt] its finished loads (held or not) and
     * opens the next lane ([openLanes]); otherwise it only counts what it deferred. It polls the lanes' programs (their
     * rehearsal pairs follow them) and frees an inactive realm at [evictAtMs].
     */
    fun update(nowMs: Double, workAllowed: Boolean) {
        ensureGl()
        this.workAllowed = workAllowed && !fade.fading
        if (!active && !fade.fading && realmId != null) { val at = evictAtMs(); if (!at.isNaN() && nowMs >= at) release() }
        if (this.workAllowed) {
            while (true) {
                when (val m = inbox.poll() ?: break) {
                    is Loaded -> if (m.gen == generation) adopt(m)
                    is Failed -> if (m.gen == generation) fail(m.id, m.reason)
                }
            }
            flushUploads()
        } else if (occDirty || pointsDirty || !inbox.isEmpty()) stats.deferredUploads++
        if (status == STATUS_UPLOADING && residentReady()) { first = null; status = STATUS_REHEARSING }
        if (status == STATUS_REHEARSING && coreReady) status = STATUS_READY
        if (status == STATUS_READY && this.workAllowed && laneCount > 0) {
            for (i in 0 until laneCount) if (laneOpened[i]) lanes[i].adopt(nowMs)
            openLanes()
        }
        if (grid != null) syncLanes()
        programs?.failed?.let { if (status != STATUS_FAILED) fail(realmId ?: "?", it.error ?: "program ${it.name} failed") }
        stats.status = status
    }

    /** The core can draw the realm: first-frame textures resident, programs adopted, every core pair rehearsed (the FAR
     *  set: dive readiness, and what a context restore waits for before the live realm draws again). */
    private val coreReady: Boolean get() = (status == STATUS_REHEARSING || status == STATUS_READY) && programsReady() && corePairsLeft() == 0

    /**
     * D-NEXT: open the next lane, at most one per frame and one load at a time: lane i opens once lane i − 1 has settled
     * or failed ([laneIn]). GROUND first (LIFE and BASES read it), then LIFE, then BASES, in the host's list order. The
     * Seeker's code-29.1 OOM had every lane load of every visited realm decoding at once on two world-load threads.
     */
    private fun openLanes() {
        val open = openRealm ?: return
        if (!lanesWanted) return
        for (i in 0 until laneCount) {
            if (laneOpened[i]) { if (laneIn(i)) continue else return }
            laneOpened[i] = true
            lanes[i].open(open)
            lanes[i].basesChanged(bases)
            return
        }
    }

    /** Lane i's load is over: it settled, or one of its programs failed. */
    private fun laneIn(i: Int): Boolean = laneDisabled[i] || lanes[i].settled()

    /** A lane may open in the next work frame (the host keeps frames coming for it: [frame], [wakeInMs]). */
    private fun laneOpenDue(): Boolean {
        if (!lanesWanted || openRealm == null || status != STATUS_READY) return false
        for (i in 0 until laneCount) if (!laneOpened[i]) return i == 0 || laneIn(i - 1)
        return false
    }

    /** Lane i's programs as the engine sees them: none until it is opened for the resident realm. */
    private fun lanePrograms(i: Int): List<Gl3Program> = if (laneOpened[i]) lanes[i].programs() else NO_PROGRAMS

    /** Some lane is still to open or to load (then "no lane can draw MAP yet" is no overview clamp: D-177, the zoom stays
     *  open while a lane loads). */
    private fun lanesLoading(): Boolean {
        if (!lanesWanted) return false
        for (i in 0 until laneCount) if (!laneDisabled[i] && (!laneOpened[i] || !laneSettled[i])) return true
        return false
    }

    /**
     * The realm waits behind the globe (READY, not on screen) with lane work left: a lane to open or still loading, or a
     * lane pair to rehearse (not "nothing", not failed). The host then runs [rehearseStep] in its idle globe frames too,
     * so the MAP set is built before the dive when the player lingers on the realm panel. No allocation.
     */
    val prefetchDue: Boolean get() {
        if (active || status != STATUS_READY || !lanesWanted || laneCount == 0) return false
        if (lanesLoading()) return true
        for (i in 0 until laneCount) if (lanePending[i] && !laneDisabled[i]) return true
        for (k in corePairs until pairCount) {
            if (pairDone[k] || pairNothing[k] || laneDisabled[pairLane[k]] || pairProgram[k].state == Gl3Program.FAILED) continue
            return true
        }
        return false
    }

    /**
     * When the resident realm is freed if nothing wants it first (NaN: never by time): `IDLE.evictMs` after a leave, and
     * `approachEvictMs` after the last core-only [prepare] of a realm never entered (the globe's approach prefetch; the
     * next prepare of another realm frees it sooner). The host asks for a frame then, since the globe may idle at 0 fps.
     * A realm the panel prepared and never entered waits for the next prepare: the panel still offers its dive.
     */
    fun evictAtMs(): Double {
        if (active || realmId == null) return Double.NaN
        if (!leftAt.isNaN()) return leftAt + config.evictMs
        if (!approachAt.isNaN()) return approachAt + config.approachEvictMs
        return Double.NaN
    }

    private fun resetMeter() {
        readinessPeak = 0.0; readinessDone = 0
        stats.readinessRaw = 0.0; stats.readinessPeak = 0.0
        viewValid = false
    }

    private fun ensureGl() {
        if (rehearsedEpoch != core.epoch) { rehearsedKeys.clear(); rehearsedEpoch = core.epoch }
        if (ubo == null) ubo = core.uniformBlock(0, UBO_BYTES)
        if (glEpoch != core.epoch) {
            glEpoch = core.epoch
            minimap.createGl()
            scratchScreen = core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.RGB8)
            scratchDepth = core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.DEPTH16)
            scratchRgba = core.texture2D(Gl3Pool.CORE, 1, 1, Gl3Format.RGBA8)
            chart16Stand = core.dummy(integer = false, array = true)
        }
    }

    private fun adopt(m: Loaded) {
        sources = m.sources
        val fs = m.first
        first = fs; grid = fs.grid; deeds = fs.deeds; meta = fs.meta; farBytes = fs.far
        fs.sea.copyInto(sea, 0, 0, 3)
        stats.maskMismatch = fs.maskMismatch; stats.catalogUsed = fs.catalogUsed; stats.packStatus = fs.meta.status; stats.bytesRead = fs.bytesRead
        val g = fs.grid
        if (programs == null) programs = RealmProgramSet(core, m.sources)
        buildCorePairs()
        cam.setGrid(g.cols, g.rows)
        if (!restoring || bases.cols != g.cols || bases.rows != g.rows) {
            bases.reset(g.cols, g.rows); bases.applyFilter(bases.filter)
            latestBases?.let { if (it.realmId == fs.meta.id) bases.set(toLocal(it)) }
            minimap.setGrid(g.cols, g.rows)
        }
        restoring = false
        minimap.setSea(fs.sea)
        occ = ByteArray(g.size); occBuf = ByteBuffer.allocateDirect(g.size).order(ByteOrder.nativeOrder())
        mx = DoubleArray(1); my = DoubleArray(1); mf = IntArray(1)
        createTextures(fs)
        occDirty = true; pointsDirty = true
        status = STATUS_UPLOADING
        if (laneCount > 0) { // the lanes open after READY, one at a time ([openLanes])
            openRealm = RealmOpen(fs.meta.id, fs.meta, g, fs.deeds, fs.far, fs.sea.copyOf(), loader, executor, generation, wakeHook, bases, plots, config)
            laneOpened.fill(false)
        }
    }

    private fun createTextures(fs: RealmFirstSet) {
        val g = fs.grid
        val levels = fs.chartLevels
        chart = uploads.fresh(core, Gl3Pool.REALM, levels[0].width, levels[0].height, Gl3Format.RGBA8, levels.size,
            Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP) { level, w, h, out -> copy(levels[level].rgba, w * h * 4, out) }
        val mask = fs.deeds; val far = fs.far
        deedsTex = uploads.fresh(core, Gl3Pool.REALM, g.cols, g.rows, Gl3Format.R8UI, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP) { _, _, _, out -> copy(mask, mask.size, out) }
        farTex = uploads.fresh(core, Gl3Pool.REALM, g.cols, g.rows, Gl3Format.R8, 1, Gl3Sampling.LINEAR, Gl3Wrap.CLAMP) { _, _, _, out -> copy(far, far.size, out) }
        val zero = ByteArray(g.size)
        occTex = uploads.fresh(core, Gl3Pool.REALM, g.cols, g.rows, Gl3Format.R8UI, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP) { _, _, _, out -> copy(zero, zero.size, out) }
        fieldsTex = uploads.fresh(core, Gl3Pool.REALM, 1, 1, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP) { _, _, _, out -> copy(NEUTRAL_FIELDS, 4, out) }
        if (chart == null || deedsTex == null || farTex == null || occTex == null || fieldsTex == null) fail(fs.meta.id, "the realm pool refused the first-frame textures")
    }

    private fun copy(src: ByteArray, n: Int, out: ByteBuffer) { out.position(0); out.put(src, 0, n); out.position(0) }

    private fun residentReady(): Boolean =
        chart?.ready == true && deedsTex?.ready == true && farTex?.ready == true && occTex?.ready == true && fieldsTex?.ready == true
    /** The core's programs only: lane programs build behind band readiness and never delay the dive (plan §3.5). */
    private fun programsReady(): Boolean = programs?.ready == true

    private fun flushUploads() {
        val t = occTex
        if (occDirty && t != null && t.ready) {
            bases.occupancy(occ)
            occBuf.position(0); occBuf.put(occ); occBuf.position(0)
            core.upload(t, 0, 0, 0, 0, t.width, t.height, occBuf)
            occDirty = false
        }
        if (pointsDirty && grid != null) {
            if (mx.size < bases.size + 1) { mx = DoubleArray(bases.size + 1); my = DoubleArray(bases.size + 1); mf = IntArray(bases.size + 1) }
            val n = bases.minimapPoints(mx, my, mf)
            minimap.setPoints(n, mx, my, mf, bases.filterActive)
            // SHARDKEEP D-191: the main view's stand-in list hides what the filter hides (the minimap keeps every base)
            val drawn = bases.standInPoints(mx, my, mf)
            minimap.setStandIn(drawn, mx, my, mf)
            minimap.flush()
            pointsDirty = false
        }
    }

    /** Readiness 0..1 for the "Enter map" progress (dive readiness, D-NEXT: the core's FAR set only): first-frame
     *  textures resident, core programs adopted, core pairs rehearsed ([advanceReadiness]). Never goes back; 1 only once
     *  the dive may start. No lane counts: the lanes open after READY. */
    fun readiness(): Double {
        if (status == STATUS_READY) return 1.0
        if (status == STATUS_NONE || status == STATUS_FAILED || status == STATUS_LOADING) return 0.0
        advanceReadiness()
        return readinessPeak
    }

    /**
     * Count the "Enter map" items and move the meter ([readinessPeak], capped below 1 until the dive may start). The meter
     * never goes back and it moves on every item done past the most ever done ([readinessDone]), by that item's share of
     * the way left to the cap, when the ratio alone does not move it (the host's dive bound reads it: a meter that sits
     * still while work lands reads as "no progress"). No allocation.
     */
    private fun advanceReadiness() {
        var tex = 0
        if (chart?.ready == true) tex++; if (deedsTex?.ready == true) tex++; if (farTex?.ready == true) tex++
        if (occTex?.ready == true) tex++; if (fieldsTex?.ready == true) tex++
        val progs = programs?.readyCount ?: 0
        var pairs = 0; for (i in 0 until corePairs) if (pairDone[i]) pairs++
        val done = tex + progs + pairs
        val total = 5 + (programs?.all?.size ?: 5) + max(1, corePairs)
        val ratio = min(READINESS_CAP, done.toDouble() / total)
        var next = max(readinessPeak, ratio)
        if (done > readinessDone) {
            if (next == readinessPeak) next = readinessPeak + (READINESS_CAP - readinessPeak) * (done - readinessDone) / max(1, total - readinessDone)
            readinessDone = done
        }
        if (next > readinessPeak) readinessPeak = min(READINESS_CAP, next)
        stats.readinessRaw = ratio; stats.readinessPeak = readinessPeak
    }

    val ready: Boolean get() = status == STATUS_READY

    // =============================================================== rehearsal pairs (plan §5.3 step 3)

    private fun growPairs(n: Int) {
        if (pairTarget.size >= n) return
        val c = max(n, pairTarget.size * 2)
        pairTarget = pairTarget.copyOf(c); pairLane = pairLane.copyOf(c); pairSet = pairSet.copyOf(c); pairDone = pairDone.copyOf(c)
        pairNothing = pairNothing.copyOf(c); pairNext = pairNext.copyOf(c); pairTries = pairTries.copyOf(c)
    }

    private fun addPair(program: Gl3Program, target: Int, lane: Int, set: Int, done: Boolean = false, nothing: Boolean = false, next: Double = 0.0, tries: Int = 0) {
        growPairs(pairCount + 1)
        if (pairProgram.size > pairCount) pairProgram[pairCount] = program else pairProgram += program
        pairTarget[pairCount] = target; pairLane[pairCount] = lane; pairSet[pairCount] = set
        pairDone[pairCount] = done; pairNothing[pairCount] = nothing; pairNext[pairCount] = next; pairTries[pairCount] = tries
        pairCount++
    }

    /** The core's pairs in order of need (the ground slot, its up-scale, the minimap, the dive composite, the selected
     *  open deed's box; screen first), then the lanes' (rebuilt from their current programs). A pair rehearsed in this
     *  same context stays rehearsed across a realm change ([rehearsedKeys]). */
    private fun buildCorePairs() {
        pairCount = 0; corePairs = 0
        val p = programs ?: return
        for (target in SCREEN_RGBA) { addCorePair(p.overview, target); addCorePair(p.blit, target) }
        for (target in SCREEN_RGBA) { addCorePair(p.minimap, target); addCorePair(p.dots, target) }
        addCorePair(p.fade, TARGET_SCREEN)
        addCorePair(p.select, TARGET_SCREEN)
        corePairs = pairCount
        var n = 0; for (k in 0 until corePairs) if (pairDone[k]) n++
        stats.pairsTotal = corePairs; stats.pairsRehearsed = n
        for (i in 0 until laneCount) { laneLists[i] = null; laneSizes[i] = -1 }
        rebuildLanePairs()
    }

    private fun addCorePair(program: Gl3Program, target: Int) =
        addPair(program, target, -1, 0, done = pairKey(program, target, -1) in rehearsedKeys)

    /** Poll the lanes (GL thread, every frame, no allocation unless a program list changed): programs, settled, failed.
     *  A lane not opened for the resident realm has no programs and has not settled. */
    private fun syncLanes() {
        var changed = false; var opened = 0
        for (i in 0 until laneCount) {
            val lane = lanes[i]
            val list = lanePrograms(i)
            if (list !== laneLists[i] || list.size != laneSizes[i]) changed = true
            var pending = false; var failed = false
            for (j in 0 until list.size) { val pr = list[j]; if (pr.state == Gl3Program.FAILED) failed = true else if (!pr.ready) pending = true }
            lanePending[i] = pending; laneDisabled[i] = failed
            val settled = laneOpened[i] && lane.settled()
            if (settled && !laneSettled[i]) { // map.js `settled(name)`: its falsy hooks now mean "nothing"; retry them at once
                for (k in corePairs until pairCount) if (pairLane[k] == i) { pairTries[k] = 0; pairNext[k] = 0.0; pairNothing[k] = false }
            }
            laneSettled[i] = settled
            if (laneOpened[i]) opened = opened or (1 shl i)
        }
        if (changed) rebuildLanePairs()
        var dis = 0; for (i in 0 until laneCount) if (laneDisabled[i]) dis = dis or (1 shl i)
        stats.lanesDisabled = dis; stats.lanesOpened = opened
    }

    /** Rebuild the lane pairs from the lanes' current programs, keeping the state of every pair that survives and taking
     *  a new pair as done when it was rehearsed in this context ([rehearsedKeys]); sorted by map.js rank: set · 1000 +
     *  the position in `GPU_SAFE.rehearse.order` (unlisted programs after every listed one). */
    private fun rebuildLanePairs() {
        val kept = HashMap<Long, Int>()
        val oldProgram = ArrayList<Gl3Program>(pairCount - corePairs); val oldTarget = IntArray(pairCount - corePairs); val oldLane = IntArray(pairCount - corePairs)
        val oldDone = BooleanArray(pairCount - corePairs); val oldNothing = BooleanArray(pairCount - corePairs)
        val oldNext = DoubleArray(pairCount - corePairs); val oldTries = IntArray(pairCount - corePairs)
        for (k in corePairs until pairCount) {
            val o = k - corePairs
            oldProgram += pairProgram[k]; oldTarget[o] = pairTarget[k]; oldLane[o] = pairLane[k]
            oldDone[o] = pairDone[k]; oldNothing[o] = pairNothing[k]; oldNext[o] = pairNext[k]; oldTries[o] = pairTries[k]
            kept[pairKey(pairProgram[k], pairTarget[k], pairLane[k])] = o
        }
        pairCount = corePairs
        val order = config.rehearsal.order
        val start = pairCount
        for (i in 0 until laneCount) {
            val list = lanePrograms(i)
            laneLists[i] = list; laneSizes[i] = list.size
            for (j in 0 until list.size) {
                val program = list[j]
                val set = if (program.name in config.rehearsal.trueSet || baseName(program.name) in config.rehearsal.trueSet) 2 else 1
                for (target in lanes[i].rehearseTargets(program)) {
                    val key = pairKey(program, target, i)
                    var dup = false
                    for (k in start until pairCount) if (pairKey(pairProgram[k], pairTarget[k], pairLane[k]) == key) { dup = true; break }
                    if (dup) continue
                    val o = kept[key]
                    if (o != null) addPair(program, target, i, set, oldDone[o] || key in rehearsedKeys, oldNothing[o], oldNext[o], oldTries[o])
                    else addPair(program, target, i, set, done = key in rehearsedKeys)
                }
            }
        }
        // stable insertion sort of the lane pairs by rank (a few dozen: only on a program-list change)
        fun rank(k: Int): Int {
            val idx = order.indexOf(baseName(pairProgram[k].name)).let { if (it < 0) order.size else it }
            return pairSet[k] * 1000 + idx
        }
        for (a in start + 1 until pairCount) {
            var b = a
            while (b > start && rank(b - 1) > rank(b)) { swapPairs(b - 1, b); b-- }
        }
        stats.lanePairsTotal = pairCount - corePairs
        countLanePairs()
    }

    private fun swapPairs(a: Int, b: Int) {
        val p = pairProgram[a]; pairProgram[a] = pairProgram[b]; pairProgram[b] = p
        var t = pairTarget[a]; pairTarget[a] = pairTarget[b]; pairTarget[b] = t
        t = pairLane[a]; pairLane[a] = pairLane[b]; pairLane[b] = t
        t = pairSet[a]; pairSet[a] = pairSet[b]; pairSet[b] = t
        t = pairTries[a]; pairTries[a] = pairTries[b]; pairTries[b] = t
        var f = pairDone[a]; pairDone[a] = pairDone[b]; pairDone[b] = f
        f = pairNothing[a]; pairNothing[a] = pairNothing[b]; pairNothing[b] = f
        val n = pairNext[a]; pairNext[a] = pairNext[b]; pairNext[b] = n
    }

    private fun pairKey(program: Gl3Program, target: Int, lane: Int): Long = (program.uid.toLong() shl 16) or ((lane + 1).toLong() shl 4) or target.toLong()

    private fun corePairsLeft(): Int { var n = 0; for (i in 0 until corePairs) if (!pairDone[i]) n++; return n }

    private fun countLanePairs() {
        var done = 0; var nothing = 0
        laneDrew.fill(false)
        for (k in corePairs until pairCount) { if (pairDone[k]) { done++; laneDrew[pairLane[k]] = true }; if (pairNothing[k]) nothing++ }
        stats.lanePairsRehearsed = done; stats.lanePairsNothing = nothing
    }

    /**
     * Is lane pair [k]'s "nothing" final? Only once its lane cannot draw that band ([RealmLane.bandSet] below the pair's
     * set) or another of its pairs drew. A lane that reports the band and has drawn none of its pairs is still loading:
     * LIFE settles when its build lands, while its texture arrays still fill on the worker, and its hooks answer false
     * until they are resident. Such a pair is retried and still counts as unbuilt for the lane's hold and the zoom's
     * gate: a MAP pipeline first drawn live is the first-use hitch band readiness exists to prevent. The lane's first
     * draw asks its earlier "nothing" pairs again at once ([rehearsePair]), so every final one was answered after it.
     */
    private fun nothingFinal(k: Int): Boolean = pairNothing[k] && (laneDrew[pairLane[k]] || lanes[pairLane[k]].bandSet() < pairSet[k])

    /**
     * Rehearse ONE never-drawn (program, state) pair into a same-format scratch target (GL thread, before any pass of the
     * frame). The core's pairs first: dive readiness. Then, once READY while the realm waits behind the globe with its
     * lanes wanted ([prefetchDue]), the lanes' prefetch: the lanes that are not held update on a whole-realm view (they
     * adopt their loads and upload within this frame's budget; GROUND pre-resolves its lattice) and one lane pair is
     * rehearsed, MAP set first. The host calls it only in idle globe frames outside flights and fades — or at once while
     * the realm is on screen and waits for it (after a context restore). True when it drew a pair.
     */
    fun rehearseStep(nowMs: Double): Boolean {
        ensureGl()
        if (status != STATUS_REHEARSING && status != STATUS_READY && status != STATUS_UPLOADING) return false
        if (!residentReady() || rehearsedFrame == core.stats.frames) return false
        for (i in 0 until corePairs) {
            if (pairDone[i] || pairNext[i] > nowMs) continue
            val program = pairProgram[i]
            if (!program.ready) continue
            return rehearsePair(i, nowMs)
        }
        if (active || status != STATUS_READY || laneCount == 0 || !lanesWanted) return false
        return prefetchLanes(nowMs)
    }

    /** The lanes' prefetch in an idle globe frame after READY (see [rehearseStep]); no allocation. */
    private fun prefetchLanes(nowMs: Double): Boolean {
        val g = grid ?: return false
        cam.set(g.cols / 2.0, g.rows / 2.0, cam.sMin()) // the whole realm (the camera is placed again at [enter])
        fillView(TARGET_SCREEN)
        uploadUbo(1.0) // the lanes' rehearsal hooks read the RealmView UBO
        computeHeld()
        for (i in 0 until laneCount) if (!laneHeld[i]) lanes[i].update(view)
        for (i in 0 until laneCount) if (!laneHeld[i]) lanes[i].drawOffscreen(view)
        for (k in corePairs until pairCount) {
            if (pairDone[k] || pairNext[k] > nowMs) continue
            if (laneDisabled[pairLane[k]] || !pairProgram[k].ready || !rehearsable(k, nowMs)) continue
            return rehearsePair(k, nowMs)
        }
        return false
    }

    /**
     * Can lane pair [k]'s hook draw now ([RealmLane.rehearsable]: its inputs are resident)? When not, it is asked again
     * `notResidentMs` later and NO try is counted: a lane still uploading is not failing. Counting those tries took the
     * pair into the 1.5 → 6 s back-off (core.js `retryAt`) while its textures landed a frame later; with the lanes held
     * meanwhile that back-off was seconds of a cold dive on the Seeker. No draw, no allocation.
     */
    private fun rehearsable(k: Int, nowMs: Double): Boolean {
        if (lanes[pairLane[k]].rehearsable(pairProgram[k])) return true
        pairNext[k] = nowMs + config.notResidentMs
        return false
    }

    /** One pair into its scratch target. True when the hook drew. */
    private fun rehearsePair(i: Int, nowMs: Double): Boolean {
        val program = pairProgram[i]; val target = pairTarget[i]; val lane = pairLane[i]
        val scratch = when (target) {
            TARGET_SCREEN -> scratchScreen
            TARGET_RGBA -> scratchRgba
            else -> if (lane >= 0) lanes[lane].rehearseScratch(program) else null
        }
        if (scratch == null) { pairTries[i]++; pairNext[i] = config.rehearsal.retryAt(pairTries[i], nowMs); return false }
        val depth = if (target == TARGET_SCREEN) scratchDepth else null
        rehearsedFrame = core.stats.frames
        var hooked = false
        val drew = core.rehearse(scratch, depth, target == TARGET_SCREEN, false) { hooked = rehearseDraw(i, program, target) }
        stats.rehearsalDraws++
        if (hooked) {
            pairDone[i] = true; pairNothing[i] = false; pairTries[i] = 0
            rehearsedKeys += pairKey(program, target, lane) // built in this context, whatever realm comes next
            if (i < corePairs) { var n = 0; for (k in 0 until corePairs) if (pairDone[k]) n++; stats.pairsRehearsed = n }
            else {
                // the lane's first draw: it was loading, so its "nothing" answers so far are asked again at once
                if (!laneDrew[lane]) for (k in corePairs until pairCount) {
                    if (pairLane[k] == lane && pairNothing[k]) { pairNothing[k] = false; pairTries[k] = 0; pairNext[k] = 0.0 }
                }
                countLanePairs()
            }
        } else {
            pairTries[i]++; pairNext[i] = config.rehearsal.retryAt(pairTries[i], nowMs)
            if (lane >= 0 && !laneDisabled[lane] && lanes[lane].readyFor(pairSet[i])) { pairNothing[i] = true; countLanePairs() } // map.js 'nothing'
        }
        return drew || hooked
    }

    private fun rehearseDraw(i: Int, program: Gl3Program, target: Int): Boolean {
        val p = programs ?: return false
        val lane = pairLane[i]
        if (lane >= 0) return lanes[lane].rehearse(program, target, view)
        fillView(TARGET_SCREEN)
        uploadUbo(1.0)
        return when (program) {
            p.overview -> drawChart(p)
            // (the stand-in source is chart8, an RGBA8 texture that is never the bound scratch target)
            p.blit -> { val stand = chart ?: return false; drawBlit(p, stand, 1.0) }
            p.minimap, p.dots -> minimap.rehearse(program, p.minimap, p.dots, chart, deedsTex, farTex, 1, 1)
            p.fade -> fade.rehearse(p.fade, chart ?: return false)
            p.select -> selectBox.rehearse(p.select)
            else -> false
        }
    }

    /**
     * map.js `rehearse(view, moving, t)` for the LANES, once per live realm frame before any pass: the first runnable pair
     * (retry time passed; program linked; inputs resident, [rehearsable]) in rank order, when the map is idle
     * (≥ `rehearse.idleMs` since input and the camera still) or the pair is urgent (the camera waits at a gate, or the
     * pair gates the band on screen). It also runs the stall valve ([stallValve]).
     */
    private fun laneRehearsal(nowMs: Double, moving: Boolean) {
        val idle = nowMs - lastInputMs >= config.rehearsal.idleMs && !moving
        val waiting = cam.pressing
        stallValve(nowMs, idle || waiting)
        if (pairCount == corePairs || rehearsedFrame == core.stats.frames) return
        val bs = view.bandSet // map.js: urgent = waiting at a gate, or gating the band on screen (FAR's lanes wait for idle)
        for (k in corePairs until pairCount) {
            if (pairDone[k] || pairNext[k] > nowMs) continue
            val lane = pairLane[k]
            if (laneDisabled[lane] || !pairProgram[k].ready) continue
            val urgent = waiting || (pairSet[k] <= bs && !pairNothing[k] && lanes[lane].readyFor(pairSet[k]))
            if (!idle && !urgent) continue
            if (!rehearsable(k, nowMs)) continue // not resident yet: no draw, no try; the next pair may run
            rehearsePair(k, nowMs)
            return
        }
    }

    /**
     * The band-gate stall valve (map.js `rh.valve`): a closed rehearsal gate that makes no progress for
     * `rehearse.stallMs` of frames that gave it its chance (the player idle, or pushing against it) opens for the rest of
     * the visit. Two rules from the code-29 smoke (36f9067, once on D-173's landing valve):
     * - every frame's FULL interval counts when the frame before it was such a chance: capping a frame's share (250 ms)
     *   counted almost nothing of SwiftShader's 0.35–4.5 s frames, or a slow phone's at the ladder's L2, and the valve
     *   never opened; frames of a panning or flung camera are no chance, so moving the map never trips it;
     * - only progress past the most ever made this visit ([valveBest]: lanes in + lane pairs rehearsed) resets the count:
     *   a count that falls and comes back (a lane re-held, a pair dropped and built again) is not a map getting closer.
     * No allocation.
     */
    private fun stallValve(nowMs: Double, chanceNow: Boolean) {
        if (valveChance && !valveCheckMs.isNaN()) stall += max(0.0, nowMs - valveCheckMs)
        valveCheckMs = nowMs
        val progress = valveProgress()
        if (progress > valveBest) { valveBest = progress; stall = 0.0 }
        valveChance = chanceNow && !valve && gateLim < Double.POSITIVE_INFINITY && gateReason == GATE_REHEARSAL
        if (!valve && stall > config.rehearsal.stallMs) { valve = true; stats.valveOpened = true }
    }

    /** The valve's progress: lanes whose load is over plus lane pairs rehearsed. */
    private fun valveProgress(): Int {
        var n = 0
        for (i in 0 until laneCount) if (laneOpened[i] && laneIn(i)) n++
        for (k in corePairs until pairCount) if (pairDone[k]) n++
        return n
    }

    /** Is lane pair [k] holding the zoom (map.js `gating`): its lane is in ([RealmLane.readyFor]), it is not rehearsed and
     *  not "nothing" (its program may still be linking: native band readiness includes the link). */
    private fun gating(k: Int): Boolean {
        val lane = pairLane[k]
        return !pairDone[k] && !pairNothing[k] && !laneDisabled[lane] && pairProgram[k].state != Gl3Program.FAILED && lanes[lane].readyFor(pairSet[k])
    }

    /** map.js `laneHeld` (native-strict): a lane not opened yet, a failed or still-linking lane, or one with an
     *  un-rehearsed pair of a set it may draw now (set ≤ max(1, the band set on screen)) that is not finally "nothing"
     *  ([nothingFinal]), draws nothing this frame (it still adopts its loads in [update]). */
    private fun computeHeld() {
        val bs = max(1, view.bandSet)
        var mask = 0
        for (i in 0 until laneCount) {
            var held = !laneOpened[i] || laneDisabled[i] || lanePending[i]
            if (!held) for (k in corePairs until pairCount) {
                if (pairLane[k] == i && pairSet[k] <= bs && !pairDone[k] && !nothingFinal(k)) { held = true; break }
            }
            laneHeld[i] = held
            if (held) mask = mask or (1 shl i)
        }
        stats.lanesHeld = mask
    }

    // =============================================================== entry / exit

    /** The fixed buffer (device px) and the engine's dpr (plan §5.5: dpr 2 on every Seeker row). */
    fun setViewport(bufferW: Int, bufferH: Int, dpr: Double) {
        this.bufferW = max(1, bufferW); this.bufferH = max(1, bufferH); this.dpr = dpr
        cam.setViewport(this.bufferW / dpr, this.bufferH / dpr, dpr)
    }

    /**
     * Open the map at the dive's arrival (camera placement only; no GL work): the globe's point ([lon], [lat]) and its
     * own scale [sStart] (CSS px per deed, `0.5° · pxPerRad / alt`), in the FAR band chosen in device px:
     * d = clamp(sStart · dpr, fit · dpr, farEnd) (scale continuity: the dive fade crosses into the same picture). D-NEXT
     * (amends D-173, owner 2026-09-26: the auto zoom-in to MAP felt "strange"): this IS the landing. Nothing moves the
     * camera after the fade; the player zooms in themselves, and the whole-realm fit is one pinch-out away (the exit is
     * below 0.7 × the fit). [landingD] is that one expression, should the owner want the literal fit instead. Opens the
     * next lane at once when none is loading (GROUND after the approach's core-only prefetch): an open only starts the
     * lane's worker decode, which then runs under the dive's fade (a frame without work), where it used to start after
     * the fade and hold the first pinch-in at farEnd that much longer (D-177, smoothness first). False when the realm is
     * not dive-ready.
     */
    fun enter(lon: Double, lat: Double, sStart: Double): Boolean {
        val g = grid ?: return false
        if (!ready || active) return false
        active = true; leftAt = Double.NaN; approachAt = Double.NaN; lanesWanted = true; exitRequested = false; viewValid = false
        val x = g.xAtLon(lon).coerceIn(0.0, g.cols.toDouble()); val y = g.yAtLat(lat).coerceIn(0.0, g.rows.toDouble())
        cam.limitD(Double.POSITIVE_INFINITY)
        // a new visit (map.js `startDive`): a MAP-edge hold or a stall valve left from the last one gets a new chance
        mapHoldT = Double.NaN; stall = 0.0; valve = false; stats.valveOpened = false
        valveCheckMs = Double.NaN; valveChance = false; valveBest = -1
        cam.set(x, y, landingD(sStart) / dpr)
        bases.clearSelection(); occDirty = true; pointsDirty = true
        countersSig = Double.NaN
        lanesBasesChanged()
        openLanes()
        return true
    }

    /** The landing scale, device px per deed: the globe's own scale [sStart] (CSS px per deed) kept inside FAR and never
     *  below the whole-realm fit (the N1/N2 continuity landing the owner praised). A literal whole-realm landing would be
     *  `cam.sMin() * dpr`. */
    fun landingD(sStart: Double): Double = max(min(sStart * dpr, config.bands.farEnd), cam.sMin() * dpr)

    /** Leave the map (◀ Globe, Back, the pinch-out): the camera centre in lon/lat, for the globe's fly-out. The GPU
     *  objects stay until [release] (the host calls it after the fly-out) or [evictAtMs], so a re-dive is warm. */
    fun leave(nowMs: Double): DoubleArray {
        val g = grid
        active = false; leftAt = nowMs
        return if (g == null) doubleArrayOf(0.0, 0.0) else doubleArrayOf(g.lonAt(cam.x), g.latAt(cam.y))
    }

    /** Free the resident realm's GPU objects (glDelete only; O(1) in waits). The next [prepare] loads it again. */
    fun release() {
        if (active) return
        releaseResident()
        realmId = null; status = STATUS_NONE; stats.status = status
    }

    private fun releaseResident() {
        generation++
        inbox.clear()
        core.free(chart); core.free(deedsTex); core.free(farTex); core.free(occTex); core.free(fieldsTex)
        chart = null; deedsTex = null; farTex = null; occTex = null; fieldsTex = null
        first = null; grid = null; deeds = ByteArray(0); meta = null; farBytes = ByteArray(0)
        bases.reset(0, 0)
        for (i in 0 until laneCount) lanes[i].dispose()
        laneOpened.fill(false); openRealm = null; lanesWanted = false; approachAt = Double.NaN
        resetGate()
        leftAt = Double.NaN
    }

    private fun resetGate() {
        stall = 0.0; valve = false; mapHoldT = Double.NaN; stats.valveOpened = false
        valveCheckMs = Double.NaN; valveChance = false; valveBest = -1
        gateLim = Double.POSITIVE_INFINITY; gateBand = 0; gateReason = 0
        sentHeld = false; sentBand = -1; sentProgress = -1.0
    }

    // =============================================================== frames

    /** The ground's integer scale for this frame (core.js `groundDiv` through the ladder's web level). */
    fun groundScale(): Double = 1.0 / config.groundDiv(dpr, view.webLevel, lastPass)

    /**
     * map.js `groundPass`: the ONE ground display pass this frame draws alone, or PASS_NONE in a cross-fade. The ground
     * lane's own answer when it gives one ([RealmLane.groundPasses]); else the band weights. The core's chart is a lone
     * chart pass.
     */
    private fun groundPass(): Int {
        val gl = groundLane
        if (gl < 0) { lastFade = false; return RealmEngineConfig.PASS_CHART }
        val m = lanes[gl].groundPasses(view)
        if (m != 0) {
            val one = Integer.bitCount(m) == 1
            lastFade = !one
            return if (!one) RealmEngineConfig.PASS_NONE else when (m) {
                RealmLane.GROUND_CHART -> RealmEngineConfig.PASS_CHART; RealmLane.GROUND_MAP -> RealmEngineConfig.PASS_MAP; else -> RealmEngineConfig.PASS_TRUE
            }
        }
        val b = view.bands
        val fadeNow = (b.far > 0 && b.far < 1) || (b.trueW > 0 && b.trueW < 1)
        lastFade = fadeNow
        return if (fadeNow) RealmEngineConfig.PASS_NONE else if (b.far >= 1) RealmEngineConfig.PASS_CHART
            else if (b.trueW >= 1) RealmEngineConfig.PASS_TRUE else RealmEngineConfig.PASS_MAP
    }

    /**
     * Band readiness and the overview clamp (map.js `bandGate`, W1 S2/S8; GLOBE-PRODUCTION-PLAN §2.4.1): the highest d
     * the camera may reach now. The rehearsal rule is core.js `bandLimit` ([RealmBandLimit], stage B): `farEnd` while a
     * MAP-set pair gates, `trueStart` while a TRUE-set pair gates, lifted by the stall valve. Then, at the MAP edge only,
     * while a lane's `mapReady` is false, `farEnd` for ≤ `mapReadyHoldMs` (not once the valve is open: map.js stage B
     * "an open valve waits for nothing more"). Native addition, the overview clamp: FAR only while no lane can draw past
     * it once every lane is in (a realm with no detail), `trueStart` while no lane can draw TRUE (the valve never lifts it).
     *
     * D-177 (owner 2026-09-26, "overview first, live"; web 197d753c): a lane still loading never closes the zoom. The
     * lanes load after the landing, and D-NEXT held the MAP edge meanwhile with `bandLimit`'s D-173 dive rule ('loading'):
     * every cold visit's first pinch-in froze there. Now no dive rule is passed, a lane's pairs gate only once it is in
     * ([gating]), and the MAP-data hold asks only lanes whose MAP data is in ([mapReadyAll]); until then the core's chart
     * holds the view. Kept, as on the web: the rehearsal gate of a loaded lane's sets (the "detail N%" cue, lifted by the
     * stall valve) and the MAP-data hold (≤ `mapReadyHoldMs`). Native core has no QA set(), so bypass is false.
     *
     * The MAP-data hold's clock starts only once the player pushes against the edge ([RealmCamera.pressing]), a native
     * divergence: the overview lands at the globe's scale, often inside the edge's window (d ≥ 0.9 × farEnd: the Seeker's
     * d 22), where map.js's clock would start at the landing and be spent before the player's first pinch, and MAP would
     * then open over an unresolved lattice. It still holds the zoom while it waits. No allocation.
     */
    private fun bandGate(nowMs: Double) {
        var lim = Double.POSITIVE_INFINITY; var band = 0; var reason = 0
        val b = config.bands
        var maxSet = 0
        for (i in 0 until laneCount) if (laneOpened[i] && !laneDisabled[i]) maxSet = max(maxSet, lanes[i].bandSet())
        val loading = lanesLoading()
        if (maxSet == 0 && !loading) { lim = b.farEnd; band = 1; reason = GATE_OVERVIEW }
        else {
            val c0 = corePairs
            // (D-177: no dive / lanesIn: the D-173 'loading' hold froze the first pinch-in of every cold visit)
            val g = RealmBandLimit.limit(gateOut, b, valve = valve, n = pairCount - c0,
                set = { pairSet[c0 + it] }, gating = { gating(c0 + it) })
            lim = g.lim; band = g.band; reason = g.reason
            if (maxSet < 2 && lim > b.trueStart) { lim = b.trueStart; band = 2; reason = GATE_OVERVIEW }
            if (lim > b.farEnd && !valve) {
                if (cam.d < b.farEnd * 0.9) mapHoldT = Double.NaN
                else if (cam.d <= b.farEnd * 1.001 && viewValid && !mapReadyAll(view)) {
                    if (mapHoldT.isNaN() && cam.pressing) mapHoldT = nowMs
                    if (mapHoldT.isNaN() || nowMs - mapHoldT < config.rehearsal.mapReadyHoldMs) { lim = b.farEnd; band = 1; reason = GATE_MAP_DATA }
                } else mapHoldT = Double.NaN // past the edge or the data is in: the next approach to it holds afresh
            }
        }
        gateLim = lim; gateBand = band; gateReason = reason
        stats.limitD = lim; stats.overviewClamp = reason == GATE_OVERVIEW && band == 1
        stats.gateBand = band; stats.gateReason = reason
        cam.limitD(lim)
    }

    /** Every opened lane's [RealmLane.mapReady] for [v], skipping a disabled or still-linking lane, one whose MAP data is
     *  not in yet (D-177: a lane still loading never closes the zoom; the chart holds the view until it is in) and one
     *  that settled with no programs (GROUND after a failed load: its MAP data never comes, there is nothing to wait for). */
    private fun mapReadyAll(v: RealmView): Boolean {
        for (i in 0 until laneCount) {
            if (!laneOpened[i] || laneDisabled[i] || lanePending[i]) continue
            val lane = lanes[i]
            if (!lane.readyFor(1)) continue
            if (lane.settled() && lane.programs().isEmpty()) continue
            if (!lane.mapReady(v)) return false
        }
        return true
    }

    /** The rehearsed share (0..1) of the set the closed gate waits for (map.js `gateProgress`): the HUD's cue. */
    fun gateProgress(): Double {
        if (gateLim == Double.POSITIVE_INFINITY || gateReason == GATE_OVERVIEW) return 1.0
        if (gateReason == GATE_MAP_DATA) return 0.99
        var done = 0; var left = 0
        for (k in corePairs until pairCount) {
            if (pairSet[k] > gateBand) continue
            if (pairDone[k]) done++ else if (gating(k)) left++
        }
        return done.toDouble() / max(1, done + left)
    }

    private fun fillView(target: Int) {
        val g = grid
        view.ladderLevel = ladderLevel // first: safe mode and reduced motion below read its web level (they lagged a frame)
        view.x = cam.x; view.y = cam.y; view.s = cam.s; view.dpr = dpr; view.d = cam.d
        view.viewW = cam.viewW; view.viewH = cam.viewH
        view.targetW = bufferW; view.targetH = bufferH
        rules.bands(cam.d, view.bands)
        view.bandSet = RealmBand.set(view.bands.band)
        view.rectX0 = cam.rectX0(); view.rectY0 = cam.rectY0(); view.rectX1 = cam.rectX1(); view.rectY1 = cam.rectY1()
        view.reducedMotion = reducedMotion || !config.heavy[view.webLevel]
        view.safe = !config.heavy[view.webLevel]
        if (g != null) { view.cols = g.cols; view.rows = g.rows; view.gridX0 = g.x0; view.gridY0 = g.y0 }
        view.selX = bases.selectedX; view.selY = bases.selectedY
        view.moving = cam.moving; view.speed = cam.speed
        view.ladderLevel = ladderLevel
        view.workAllowed = workAllowed
        view.uploadBytesLeft = if (workAllowed) config.coldUploadBytes else 0L
        view.resolveBudget = if (workAllowed) config.resolveBudget else 0.0
        val knobs = ladderKnobs?.let { it[min(ladderLevel, it.size - 1)] }
        view.maxResolves = knobs?.maxResolves ?: (if (ladderLevel >= 1) 1 else 0)
        view.lifeCap = knobs?.lifeCap ?: -1
        if (target == TARGET_RGBA) { view.targetW = bufferW; view.targetH = bufferH }
    }

    /** core.js `begin(view)`: the RealmView UBO (std140, binding 0); [dprScale] lowers uCam.w for a k× target. */
    private fun uploadUbo(dprScale: Double) {
        val block = ubo ?: return
        val f = block.floats; val u = block.ints; val v = view; val b = v.bands
        f.put(0, v.x.toFloat()); f.put(1, v.y.toFloat()); f.put(2, v.s.toFloat()); f.put(3, (v.dpr * dprScale).toFloat())
        f.put(4, v.viewW.toFloat()); f.put(5, v.viewH.toFloat()); f.put(6, v.d.toFloat()); f.put(7, if (v.safe) 2f else if (v.reducedMotion) 1f else 0f)
        f.put(8, v.cols.toFloat()); f.put(9, v.rows.toFloat()); f.put(10, v.gridX0.toFloat()); f.put(11, v.gridY0.toFloat())
        f.put(12, b.far.toFloat()); f.put(13, b.map.toFloat()); f.put(14, b.trueW.toFloat()); f.put(15, b.twins.toFloat())
        f.put(16, b.decor.toFloat()); f.put(17, b.creatures.toFloat()); f.put(18, b.sway.toFloat()); f.put(19, b.fadeWeight.toFloat())
        f.put(20, v.selX.toFloat()); f.put(21, v.selY.toFloat()); f.put(22, v.hovX.toFloat()); f.put(23, v.hovY.toFloat())
        u.put(24, v.clockMs.toInt()); u.put(25, v.pulseMs.toInt()); u.put(26, if (v.frozen) 1 else 0); u.put(27, core.stats.frames.toInt())
        core.upload(block)
    }

    /**
     * The live realm frame (GL thread, between `beginFrame` and `endFrame`, when [active] and not fading): band readiness
     * is applied, the camera steps (only the player's gestures, flights and the rest rule move it: D-NEXT, no landing
     * flight), one lane rehearsal step may run (before any pass), then offscreen passes first (lane resolves, the k×
     * ground target), the screen once (cleared to the realm's own sea), the ground (a lane's, else the core's chart), the
     * lanes' sprite passes in map.js order, the stand-in occupancy dots, the selected open deed's box, the minimap last.
     * [clockMs] / [frozen] come from the `IdleScheduler`. Returns true while the camera moves, a rehearsal is due or a lane
     * may open (the host keeps the pacer at motion cadence).
     */
    fun frame(nowMs: Double, clockMs: Long, frozen: Boolean): Boolean {
        ensureGl()
        if (!active) return false
        if (!coreReady) { core.beginScreen(sea[0], sea[1], sea[2], 1f); return false } // a restore: the realm's sea, never garbage
        bandGate(nowMs)
        val stepped = cam.step(nowMs) // (a held flight whose gate rose meanwhile resumes inside step: camera.js 911b39c5)
        val moving = stepped || cam.moving
        view.clockMs = clockMs; view.pulseMs = clockMs; view.frozen = frozen
        fillView(TARGET_SCREEN)
        viewValid = true
        if (laneCount > 0) {
            uploadUbo(1.0) // the lanes' rehearsal hooks read the RealmView UBO
            laneRehearsal(nowMs, moving)
            computeHeld()
            for (i in 0 until laneCount) if (!laneHeld[i]) lanes[i].update(view)
        }
        pickGroundLane()
        val pass = groundPass(); lastPass = pass
        val k = groundScale()
        stats.band = view.bands.band; stats.d = view.d; stats.fadeWeight = view.bands.fadeWeight; stats.groundScale = k; stats.groundPass = pass
        drawRealm(null, k)
        stats.framesDrawn++
        publishGate()
        return moving || rehearsalDue(nowMs) || laneOpenDue()
    }

    private fun pickGroundLane() {
        groundLane = -1
        for (i in 0 until laneCount) if (!laneHeld[i] && lanes[i].drawsGround(view)) { groundLane = i; break }
    }

    /**
     * Render the realm's current view into the fade snapshot (offscreen passes only; GL thread, before the globe's
     * screen pass). Used once at the dive's arrival and once at a leave. False when it could not.
     */
    fun renderSnapshot(clockMs: Long, frozen: Boolean): Boolean {
        ensureGl()
        if (!coreReady) return false
        val target = fade.snapshotTarget(bufferW, bufferH) ?: return false
        view.clockMs = clockMs; view.pulseMs = clockMs; view.frozen = frozen
        fillView(TARGET_RGBA)
        viewValid = true // the dive's snapshot is this camera's view: the MAP-edge hold reads its MAP data from the first live frame
        if (laneCount > 0) computeHeld()
        pickGroundLane()
        lastPass = groundPass()
        drawRealm(target, groundScale())
        stats.snapshots++
        return true
    }

    /** The web frame order for one target: [snapshot] null = the screen. */
    private fun drawRealm(snapshot: Gl3Texture?, k: Double) {
        val p = programs ?: return
        val gl = groundLane
        var live = false
        for (i in 0 until laneCount) if (!laneHeld[i]) { live = true; lanes[i].drawOffscreen(view) }
        var low: Gl3Texture? = null
        if (k < 0.999) {
            low = core.lowres(k)
            if (low != null) {
                core.offscreen(low, load = Gl3Load.CLEAR)
                uploadUbo(k)
                if (gl >= 0) lanes[gl].drawGround(view) else drawChart(p)
            }
        }
        if (snapshot != null) core.offscreen(snapshot, load = Gl3Load.CLEAR) else core.beginScreen(sea[0], sea[1], sea[2], 1f)
        uploadUbo(1.0)
        if (low != null) drawBlit(p, low, k)
        else if (gl >= 0) lanes[gl].drawGround(view) else drawChart(p)
        var basesDrawn = false
        if (live) {
            core.enable(GL20.GL_DEPTH_TEST); core.depthFunc(GL20.GL_LEQUAL)
            lanePass(RealmLane.PASS_SHADOW)
            core.depthMask(true); core.gl.clear(GL20.GL_DEPTH_BUFFER_BIT) // map.js: the mid-pass depth clear (costed, plan §5.9)
            lanePass(RealmLane.PASS_SHIELD_BACK)
            lanePass(RealmLane.PASS_SPRITE)
            lanePass(RealmLane.PASS_SHIELD_FRONT)
            if (!view.safe) lanePass(RealmLane.PASS_AIR)
            lanePass(RealmLane.PASS_FX)
            core.disable(GL20.GL_DEPTH_TEST)
            for (i in 0 until laneCount) if (!laneHeld[i] && lanes[i].drawsBases(view)) { basesDrawn = true; break }
        }
        stats.occupancyDots = !basesDrawn && minimap.drawOccupancy(p.dots, view) // drawn bases only (D-191), never the minimap's dimmed set
        // the selected OPEN deed's box, at every zoom (a kingdom keeps its own selection); never in a fade snapshot
        stats.selectBox = snapshot == null && bases.selectedFreeX >= 0 && selectBox.draw(p.select, view, bases.selectedFreeX, bases.selectedFreeY)
        val c = chart; val dt = deedsTex; val ft = farTex
        if (c != null && dt != null && ft != null) minimap.draw(p.minimap, p.dots, c, dt, ft, view, bufferH)
    }

    private fun lanePass(pass: Int) { for (i in 0 until laneCount) if (!laneHeld[i]) lanes[i].draw(view, pass) }

    private fun drawChart(p: RealmProgramSet): Boolean {
        val c = chart ?: return false; val c16 = chart16Stand ?: return false; val dt = deedsTex ?: return false
        val fa = fieldsTex ?: return false; val ft = farTex ?: return false
        return RealmChart.draw(core, p.overview, c, c16, dt, fa, ft, sea, 1.0)
    }

    /**
     * GROUND's chart under its MAP passes (NR `GroundLane.chartUnder`; ground.js draws `drawChart` under MAP in the
     * FAR→MAP fade and while the view's lattice resolves): the core's `rm-chart` into the bound target, with GROUND's
     * [fieldsA] once resident (else the neutral texel). Lead integration; GL thread, inside a lane's `drawGround`.
     */
    fun drawChartUnder(fieldsA: Gl3Texture?, alpha: Double): Boolean {
        val p = programs ?: return false
        val c = chart ?: return false; val c16 = chart16Stand ?: return false; val dt = deedsTex ?: return false
        val fa = fieldsA?.takeIf { it.ready } ?: fieldsTex ?: return false; val ft = farTex ?: return false
        return RealmChart.draw(core, p.overview, c, c16, dt, fa, ft, sea, alpha)
    }

    private fun drawBlit(p: RealmProgramSet, low: Gl3Texture, k: Double): Boolean {
        if (!core.use(p.blit)) return false
        core.disable(GL20.GL_BLEND); core.disable(GL20.GL_DEPTH_TEST); core.disable(GL20.GL_SCISSOR_TEST)
        core.bindTexture(0, low)
        core.gl.uniform1i(p.blit.uniform(core, "uLow"), 0); core.gl.uniform1f(p.blit.uniform(core, "uK"), k.toFloat())
        core.fullscreen()
        return true
    }

    private fun publishGate() {
        val held = gateLim < Double.POSITIVE_INFINITY && gateReason != GATE_OVERVIEW && cam.pressing
        val progress = Math.floor(gateProgress() * 20) / 20
        stats.gateProgress = progress
        if (held == sentHeld && gateBand == sentBand && progress == sentProgress) return
        sentHeld = held; sentBand = gateBand; sentProgress = progress
        listener?.onGate(held, gateBand, progress)
    }

    /** A lane pair can be rehearsed within the next rehearsal gap (keep frames coming; never for "nothing" pairs or pairs
     *  backing off, so the idle policy's 0 fps holds: map.js `wakeIn`). */
    private fun rehearsalDue(nowMs: Double): Boolean {
        for (k in corePairs until pairCount) {
            if (pairDone[k] || pairNothing[k] || laneDisabled[pairLane[k]] || !pairProgram[k].ready) continue
            if (pairNext[k] <= nowMs + config.rehearsal.gapMs) return true
        }
        return false
    }

    /** ms until the next lane rehearsal may run (a pair backing off, or the idle wait) or the MAP-edge hold ends, −1 for
     *  none: the host requests a frame then (map.js `wakeIn`). The hold counts only while it holds (map.js asks `wakeIn`
     *  inside that branch alone): its start time outlives it, and a spent hold asked for a frame per vsync at rest. A
     *  "nothing" that is not final ([nothingFinal]) still wakes: its lane is held until the retry draws, and at rest the
     *  idle policy may draw no frame to retry it in. A lane that may open ([openLanes]) asks for the next frame. */
    fun wakeInMs(nowMs: Double): Double {
        if (laneOpenDue()) return 0.0
        var best = Double.POSITIVE_INFINITY
        for (k in corePairs until pairCount) {
            if (pairDone[k] || nothingFinal(k) || laneDisabled[pairLane[k]] || !pairProgram[k].ready) continue
            best = min(best, max(pairNext[k], lastInputMs + config.rehearsal.idleMs))
        }
        if (!mapHoldT.isNaN() && gateReason == GATE_MAP_DATA) best = min(best, mapHoldT + config.rehearsal.mapReadyHoldMs)
        return if (best == Double.POSITIVE_INFINITY) -1.0 else max(0.0, best - nowMs)
    }

    /**
     * The fade composite (the host calls it last in the screen pass): a realm snapshot over the live globe, or — when
     * the globe drew its last frame into [RealmDiveFade.snapshotTarget] and the fade was started with
     * `snapshotIsRealm = false` — the globe snapshot over the live realm [frame].
     */
    fun compositeFade(nowMs: Double) { programs?.let { fade.composite(it.fade, fade.snapshotAlpha(nowMs)) } }

    /** The selection pulse's animation period while the selection is on screen (map.js `animating('select')`), else 0.
     *  An open deed counts as on screen while its box is ([RealmSelectBox]: ≥ 18 CSS px, so it can show past the deed). */
    fun selectionPeriodMs(): Int {
        if (!active || !bases.hasSelection || !config.heavy[view.webLevel]) return 0
        val sx = bases.selectedX; val sy = bases.selectedY
        if (bases.selectedBase < 0) return if (selectBox.onScreen(view, sx, sy)) 50 else 0
        return if (sx + 1 > view.rectX0 && sx < view.rectX1 && sy + 1 > view.rectY0 && sy < view.rectY1) 50 else 0
    }

    /** The realm's own open-sea colour (0..1 RGB, the chart's `uSeaFar`): the host clears to it before a realm frame. */
    fun seaColour(out: FloatArray) { sea.copyInto(out, 0, 0, 3) }

    // =============================================================== HUD data

    /** HUD control rects in CSS px ([l, t, r, b] × count), measured by Compose; tags and counters stay off them. */
    fun setChrome(rects: DoubleArray, count: Int) { cluster.setChrome(rects, count); chromeGen++ }
    fun setSafeInsets(l: Double, t: Double, r: Double, b: Double) { safeL = l; safeT = t; safeR = r; safeB = b; chromeGen++ }

    /**
     * The FAR cluster counters for this view (s < `BANDS.uiDots`), recomputed only when the camera, the screen, the
     * filtered list or the chrome changed (W1 S7). Empty from `uiDots` on (Compose draws tags there).
     */
    fun counters(): List<RealmCounter> {
        if (!active || cam.s >= config.bands.uiDots) { stats.counters = 0; stats.counterSum = 0; return EMPTY }
        val sig = cam.x * 31 + cam.y * 17 + cam.s * 7 + cam.viewW * 3 + cam.viewH
        if (sig == countersSig && countersVersion == bases.version && countersChrome == chromeGen) return cluster.list
        countersSig = sig; countersVersion = bases.version; countersChrome = chromeGen
        val list = cluster.compute(bases, cam.x, cam.y, cam.s, cam.viewW, cam.viewH, safeL + 2, safeT + 2, cam.viewW - safeR - 2, cam.viewH - safeB - 2)
        var sum = 0; for (c in list) sum += c.n
        stats.counters = list.size; stats.counterSum = sum; stats.basesOnScreen = cluster.onScreen
        return list
    }

    // =============================================================== intents

    /**
     * The server's bases for a realm, in CATALOG columns/rows (the HUD's convention: tileId = y × 720 + x), kept until
     * that realm's grid exists, so a snapshot may arrive before the load. Bases outside this realm's grid are dropped.
     */
    fun setBases(snapshot: WorldBases) {
        latestBases = snapshot
        if (grid == null || snapshot.realmId != realmId) return
        val open = bases.selectedFreeX >= 0
        bases.set(toLocal(snapshot)); occDirty = true; pointsDirty = true
        lanesBasesChanged()
        // the open deed became a kingdom (RealmBases.set): announce the kingdom, as select() would have
        if (open && bases.selectedBase >= 0) listener?.onSelection(bases.selectedBase, bases.selectedX, bases.selectedY, grid?.tileId(bases.selectedX, bases.selectedY) ?: -1)
    }

    private fun lanesBasesChanged() { for (i in 0 until laneCount) if (laneOpened[i]) lanes[i].basesChanged(bases) }

    /** Catalog columns/rows → this grid's local deeds (−1 outside it), across the antimeridian wrap. */
    private fun toLocal(s: WorldBases): WorldBases {
        val g = grid ?: return s
        val xs = IntArray(s.size); val ys = IntArray(s.size)
        for (i in 0 until s.size) {
            val t = catalogTile(s.deedX[i], s.deedY[i])
            xs[i] = if (t < 0) -1 else g.deedX(t); ys[i] = if (t < 0) -1 else g.deedY(t)
        }
        return WorldBases(s.epoch, s.realmId, xs, ys, s.level, s.flags, s.shieldKnown)
    }

    private fun catalogTile(x: Int, y: Int): Int =
        if (x in 0 until RealmGrid.LATTICE_W && y in 0 until RealmGrid.LATTICE_H) y * RealmGrid.LATTICE_W + x else -1

    /** `WorldIntent.Select(WorldTarget.Deed)` in catalog columns/rows (see [selectDeed]). */
    fun selectCatalogDeed(catalogX: Int, catalogY: Int, fly: Boolean = true, focusDx: Double = 0.0, focusDy: Double = 0.0) {
        val g = grid ?: return
        val t = catalogTile(catalogX, catalogY)
        val x = if (t < 0) -1 else g.deedX(t); val y = if (t < 0) -1 else g.deedY(t)
        if (x < 0) { select(-1); return }
        selectDeed(x, y, fly, focusDx, focusDy)
    }

    /** `WorldIntent.FlyTo(WorldTarget.Deed, d)` in catalog columns/rows: the deed's centre at [d] (the rest rule and
     *  band readiness apply: a flight past a closed gate waits at its edge and resumes when it opens). False when the
     *  deed is not in this realm's grid. */
    fun flyToCatalogDeed(catalogX: Int, catalogY: Int, d: Double, ms: Double = 700.0): Boolean {
        val g = grid ?: return false
        val t = catalogTile(catalogX, catalogY)
        val x = if (t < 0) -1 else g.deedX(t)
        if (x < 0) return false
        cam.flyToD(x + 0.5, g.deedY(t) + 0.5, d, ms)
        return true
    }

    fun setFilter(filter: WorldFilter) { bases.applyFilter(filter); occDirty = true; pointsDirty = true; lanesBasesChanged() }

    /**
     * map.js `select(b, fly)`: a base index, an open deed ([base] −1 with a deed), or none. Flies to the plot, centred in
     * the part of the screen the card leaves free ([focusDx], [focusDy] CSS px from the HUD's `focusOffset`).
     */
    fun select(base: Int, deedX: Int = -1, deedY: Int = -1, fly: Boolean = false, focusDx: Double = 0.0, focusDy: Double = 0.0) {
        when {
            base >= 0 -> bases.select(base)
            deedX >= 0 -> bases.selectFree(deedX, deedY)
            else -> bases.clearSelection()
        }
        occDirty = true; pointsDirty = true
        lanesBasesChanged()
        listener?.onSelection(bases.selectedBase, bases.selectedX, bases.selectedY, grid?.tileId(bases.selectedX, bases.selectedY) ?: -1)
        if (!bases.hasSelection) return
        val d = cam.d; val sel = config.bands.selectD
        val dT = if (fly || d < sel) max(d, sel) else rules.restTarget(d); val sT = dT / dpr
        cam.flyToD(bases.selectedAimX + focusDx / sT, bases.selectedAimY + focusDy / sT, dT, if (fly || d < sel) 700.0 else 500.0)
    }

    /**
     * `WorldIntent.Select(WorldTarget.Deed)`: the base on that deed, else the open deed when the catalog puts it in this
     * realm, else nothing (a deed of another realm or the sea is never selectable here).
     */
    fun selectDeed(deedX: Int, deedY: Int, fly: Boolean = true, focusDx: Double = 0.0, focusDy: Double = 0.0) {
        val g = grid ?: return
        if (!g.contains(deedX, deedY)) { select(-1); return }
        val b = bases.baseAt(deedX, deedY)
        when {
            b >= 0 -> select(b, fly = fly, focusDx = focusDx, focusDy = focusDy)
            (deeds[deedY * g.cols + deedX].toInt() and 0xff) == config.deedThisRealm -> select(-1, deedX, deedY, fly, focusDx, focusDy)
            else -> select(-1)
        }
    }

    /** map.js `step(dir)` (◀ ▶ in the card): the proximity walk in the filtered list. */
    fun step(dir: Int, focusDx: Double = 0.0, focusDy: Double = 0.0) {
        val b = bases.step(dir, cam.x, cam.y); if (b >= 0) select(b, fly = true, focusDx = focusDx, focusDy = focusDy)
    }

    /** map.js `myBase()`: select your base and fly to `BANDS.myBaseD` (TRUE: the flight waits at a closed gate's edge). */
    fun myBase(focusDx: Double = 0.0, focusDy: Double = 0.0): Boolean {
        val m = bases.mineIndex(); if (m < 0) return false
        select(m, focusDx = focusDx, focusDy = focusDy)
        val sT = config.bands.myBaseD / dpr
        cam.flyToD(bases.plotX[m] + focusDx / sT, bases.plotY[m] + focusDy / sT, config.bands.myBaseD, 900.0)
        return true
    }

    /** The zoom tools (+ / −): map.js `zoomBy(k)` (2.2 per step; never below the rest floor, the whole-realm fit). D-NEXT:
     *  − at the fit stays on the whole realm (D-173's "− at the floor leaves" is retired with its floor): the globe is
     *  a pinch-out below 0.7 × the fit, ◀ Globe or Back. */
    fun zoomBy(k: Double) { cam.flyToD(cam.x, cam.y, cam.d * k, 380.0); onInput() }

    fun flyToDeed(x: Double, y: Double, d: Double, ms: Double = 700.0) = cam.flyToD(x, y, d, ms)

    // ---- the enter-base seam (D-162.3, F8) ----

    /**
     * "Enter base" (OPEN BASE on your own deed): the base-scene camera that continues this view into the base of catalog
     * deed ([catalogX], [catalogY]) — the base-world art px under the screen centre (clamped into the kit field) and the
     * zoom showing the same size on a surface of [surfacePxPerDp] px per dp. [RealmSeamCamera.seamless] is true when the
     * map is at full TRUE (d ≥ `BANDS.trueFull`) with that deed under the centre AND the last frame drew a lane's TRUE
     * ground alone (TRUE readiness: its pairs rehearsed, its data in; never the core's chart standing in at TRUE scale
     * after the stall valve): then the base scene opens on the same picture. False when the deed is not in this realm.
     */
    fun seamToBase(seam: RealmSeam, catalogX: Int, catalogY: Int, surfacePxPerDp: Double, out: RealmSeamCamera): Boolean {
        val g = grid ?: return false
        val t = catalogTile(catalogX, catalogY); if (t < 0) return false
        val dx = g.deedX(t); val dy = g.deedY(t); if (dx < 0) return false
        val b = bases.baseAt(dx, dy); val level = if (b >= 0) bases.level[b] else 0
        val lo = seam.kit.fieldOriginTiles.toDouble() * seam.kit.tilePixels; val hi = seam.kit.fieldEndTile.toDouble() * seam.kit.tilePixels - 1e-6
        out.catalogX = catalogX; out.catalogY = catalogY
        out.baseX = seam.baseX(dx, dy, level, cam.x).coerceIn(lo, hi); out.baseY = seam.baseY(dx, dy, level, cam.y).coerceIn(lo, hi)
        out.zoom = seam.baseZoom(cam.s, surfacePxPerDp)
        out.realmX = cam.x; out.realmY = cam.y; out.d = cam.d
        out.seamless = cam.d >= config.bands.trueFull && groundLane >= 0 && lastPass == RealmEngineConfig.PASS_TRUE &&
            Math.floor(cam.x).toInt() == dx && Math.floor(cam.y).toInt() == dy
        return true
    }

    /**
     * Back from a base (the World tab reopened on the deed the player left): after [enter], fly to the realm point the
     * base camera ([baseX], [baseY], [zoom]) shows, at the same size (clamped to the camera's reach). The flight waits at
     * a closed band gate's edge and resumes when TRUE is ready (band readiness), so the return never first-draws a
     * TRUE pipeline. False when the deed is not in this realm.
     */
    fun returnFromBase(seam: RealmSeam, catalogX: Int, catalogY: Int, baseX: Double, baseY: Double, zoom: Double,
                       surfacePxPerDp: Double, ms: Double = 900.0): Boolean {
        val g = grid ?: return false
        val t = catalogTile(catalogX, catalogY); if (t < 0) return false
        val dx = g.deedX(t); val dy = g.deedY(t); if (dx < 0) return false
        val b = bases.baseAt(dx, dy); val level = if (b >= 0) bases.level[b] else 0
        val u = seam.realmU(dx, dy, level, baseX).coerceIn(dx.toDouble(), dx + 1.0); val v = seam.realmV(dx, dy, level, baseY).coerceIn(dy.toDouble(), dy + 1.0)
        val d = min(seam.realmS(zoom, surfacePxPerDp), config.bands.sMax) * dpr
        if (b >= 0) select(b) else selectDeed(dx, dy, fly = false) // the card on the deed; its own flight is replaced here
        cam.flyToD(u, v, max(d, config.bands.trueFull), ms)
        return true
    }

    // ---- touch on the map (CSS px; the host converts view px → buffer px → ÷ dpr) ----
    fun touchDown(id: Int, x: Double, y: Double, t: Double) = gestures.down(id, x, y, t)
    fun touchMove(id: Int, x: Double, y: Double, t: Double) = gestures.move(id, x, y, t)
    fun touchUp(id: Int, x: Double, y: Double, t: Double) = gestures.up(id, x, y, t)
    fun touchCancel(id: Int) = gestures.cancel(id)

    var inputListener: (() -> Unit)? = null
    override fun onInput() { lastInputMs = clock.asDouble; inputListener?.invoke() }
    override fun onChange() {}

    /**
     * A pinch-out below 0.7 × the rest floor, the whole-realm fit (camera.js `exitCheck`, the pre-D-173 rule; D-NEXT: the
     * owner found D-173's exit, measured from MAP's start, left for the globe too early): hand the view back to the
     * globe, once per visit. The host's leave renders this realm frame into the fade snapshot and fades it out over the
     * globe's fly-out (the dive's fade reversed), so the zoom-out never shows a black or cut frame.
     */
    override fun onPinchOut() {
        val g = grid ?: return
        if (!active || exitRequested) return
        exitRequested = true; stats.exitRequests++
        listener?.onExit(g.lonAt(cam.x), g.latAt(cam.y))
    }

    override fun onTap(sx: Double, sy: Double) {
        val g = grid ?: return
        if (!active) return
        val t = g.tileId(Math.floor(cam.screenToDeedX(sx)).toInt(), Math.floor(cam.screenToDeedY(sy)).toInt())
        val handled = listener?.onTap(if (t < 0) -1 else t % RealmGrid.LATTICE_W, if (t < 0) -1 else t / RealmGrid.LATTICE_W, sx, sy) == true
        if (handled) return
        val c = cluster.hit(sx, sy)
        if (c != null) { cam.flyToD(c.u / c.n, c.v / c.n, max(cam.d * 2.4, config.bands.mapStart), 600.0); return }
        for (i in 0 until laneCount) {
            if (laneHeld[i]) continue
            val b = lanes[i].pickBase(view, sx, sy)
            if (b in 0 until bases.size) { select(b); return }
        }
        RealmPick.pick(cam, bases, deeds, config.deedThisRealm, sx, sy, pick)
        when (pick.kind) {
            RealmPickResult.BASE -> select(pick.base)
            RealmPickResult.OPEN -> select(-1, pick.deedX, pick.deedY)
            else -> select(-1)
        }
    }

    // ---- minimap (ui.js hit-div handlers; minimap-local CSS px) ----
    private var mmDown = false; private var mmX = 0.0; private var mmY = 0.0; private var mmMoved = false; private var mmBox = false
    private var mmCamX = 0.0; private var mmCamY = 0.0; private var mmDpp = 1.0; private var mmLastTap = -1e9
    private var mmPointers = 0; private var mmPinch = 0.0
    private val mmPx = DoubleArray(2); private val mmPy = DoubleArray(2); private val mmId = intArrayOf(-1, -1)

    fun setMinimapRect(x: Double, y: Double, w: Double, h: Double) = minimap.setRect(x, y, w, h)

    fun minimapDown(id: Int, x: Double, y: Double, t: Double) {
        if (mmPointers >= 2) return
        mmId[mmPointers] = id; mmPx[mmPointers] = x; mmPy[mmPointers] = y; mmPointers++
        onInput()
        if (mmPointers == 1) {
            mmDown = true; mmX = x; mmY = y; mmMoved = false
            mmBox = minimap.inBox(x, y, view.rectX0, view.rectY0, view.rectX1, view.rectY1)
            if (mmBox) { minimap.freeze(); mmCamX = cam.x; mmCamY = cam.y; mmDpp = minimap.deedPerPx() }
        } else { mmPinch = hypot(mmPx[0] - mmPx[1], mmPy[0] - mmPy[1]); if (mmDown) mmMoved = true; endMinimapDrag() }
    }

    fun minimapMove(id: Int, x: Double, y: Double) {
        val i = if (mmId[0] == id) 0 else if (mmId[1] == id) 1 else return
        mmPx[i] = x; mmPy[i] = y
        if (mmPointers == 2 && mmPinch > 0) { val d = hypot(mmPx[0] - mmPx[1], mmPy[0] - mmPy[1]); minimap.zoomBy(d / mmPinch); mmPinch = d; return }
        if (!mmDown) return
        if (hypot(x - mmX, y - mmY) > 4) mmMoved = true
        if (mmMoved && mmBox) { cam.set(mmCamX + (x - mmX) * mmDpp, mmCamY + (y - mmY) * mmDpp, Double.NaN); onInput() }
    }

    fun minimapUp(id: Int, t: Double) {
        val i = if (mmId[0] == id) 0 else if (mmId[1] == id) 1 else return
        if (i == 0) { mmId[0] = mmId[1]; mmPx[0] = mmPx[1]; mmPy[0] = mmPy[1] }
        mmId[1] = -1; mmPointers--
        if (mmPointers > 0) return
        mmPinch = 0.0
        if (mmDown && !mmMoved) {
            if (t - mmLastTap < 300) { minimap.resetZoom(); mmLastTap = -1e9 }
            else {
                mmLastTap = t
                val wx = minimap.toDeedX(mmX); val wy = minimap.toDeedY(mmY)
                if (!wx.isNaN()) cam.flyToD(wx, wy, max(cam.d, config.bands.mapStart), 600.0)
            }
        } else if (mmDown && mmBox) cam.settle()
        endMinimapDrag(); mmDown = false
    }

    fun minimapCancel() { mmPointers = 0; mmId[0] = -1; mmId[1] = -1; endMinimapDrag(); mmDown = false; mmPinch = 0.0 }

    // ---- minimap, the HUD's recognised gestures (NU `MinimapGesture`, minimap-local CSS px; ui.js rules) ----
    /** Tap: fly there at max(d, mapStart) (band readiness holds it at a closed gate's edge). */
    fun minimapTap(mx: Double, my: Double) {
        val wx = minimap.toDeedX(mx); val wy = minimap.toDeedY(my)
        if (!wx.isNaN()) cam.flyToD(wx, wy, max(cam.d, config.bands.mapStart), 600.0)
        onInput()
    }
    /** Double tap: back to the whole realm. */
    fun minimapDoubleTap() { minimap.resetZoom(); onInput() }
    /** A drag that starts on the main view's box (≥ 44 CSS px grab zone) moves the map; the minimap's own camera holds. */
    fun minimapDragStart(mx: Double, my: Double) {
        mmX = mx; mmY = my
        mmBox = minimap.inBox(mx, my, view.rectX0, view.rectY0, view.rectX1, view.rectY1)
        if (mmBox) { minimap.freeze(); mmCamX = cam.x; mmCamY = cam.y; mmDpp = minimap.deedPerPx() }
        onInput()
    }
    fun minimapDragTo(mx: Double, my: Double) { if (mmBox) { cam.set(mmCamX + (mx - mmX) * mmDpp, mmCamY + (my - mmY) * mmDpp, Double.NaN); onInput() } }
    fun minimapDragEnd() { if (mmBox) cam.settle(); endMinimapDrag() }
    /** Pinch on the minimap: its own zoom (fit ↔ 12× the main view). */
    fun minimapPinch(k: Double) { minimap.zoomBy(k); onInput() }
    private fun endMinimapDrag() { if (mmBox) { minimap.unfreeze(); mmBox = false } }

    // =============================================================== context loss (plan §5.7)

    /**
     * After a context change every GL name is gone: the realm reloads its first-frame set from the verified files
     * (never refetched, no decoded RAM cache), keeping the camera, bases, filter and selection; the programs are
     * resubmitted by the core, every pair is rehearsed again ([waiting] asks the host for it at once), and the lanes are
     * disposed and opened again after READY, one at a time, with the reloaded set.
     */
    private fun restoreAfterLoss() {
        glEpoch = -1
        for (k in 0 until pairCount) { pairDone[k] = false; pairNothing[k] = false; pairTries[k] = 0; pairNext[k] = 0.0 }
        rehearsedKeys.clear(); rehearsedEpoch = core.epoch // a new context builds every pipeline again
        val id = realmId ?: return
        chart = null; deedsTex = null; farTex = null; occTex = null; fieldsTex = null
        for (i in 0 until laneCount) lanes[i].dispose()
        laneOpened.fill(false)
        stats.pairsRehearsed = 0; countLanePairs(); resetGate(); resetMeter()
        generation++; inbox.clear()
        restoring = true
        status = STATUS_LOADING; stats.status = status
        val gen = generation; val have = sources
        try {
            executor.execute {
                try { inbox.offer(Loaded(gen, have ?: shaderSources(), loader.firstSet(id, config, catalog))) }
                catch (e: Exception) { inbox.offer(Failed(gen, id, e.message ?: e.javaClass.simpleName)) }
            }
        } catch (e: RejectedExecutionException) { fail(id, "decode executor refused the restore") }
    }

    /** The realm is on screen but cannot draw yet (a restore in progress): the host runs [rehearseStep] every frame. */
    val waiting: Boolean get() = active && !coreReady

    /** Free everything with `glDelete*` only (plan §5.9: runs inside libGDX's pause handshake). */
    fun dispose() {
        active = false
        releaseResident()
        fade.dispose(); minimap.dispose()
        core.free(scratchScreen); core.free(scratchDepth); core.free(scratchRgba)
        scratchScreen = null; scratchDepth = null; scratchRgba = null
        realmId = null; status = STATUS_NONE
    }

    companion object {
        const val STATUS_NONE = 0
        const val STATUS_LOADING = 1
        const val STATUS_UPLOADING = 2
        const val STATUS_REHEARSING = 3
        const val STATUS_READY = 4
        const val STATUS_FAILED = 5

        /** A pass drawn to the screen (RGB8 + depth16) or to an RGBA8 offscreen target (the k× ground, the snapshot). */
        const val TARGET_SCREEN = 0
        const val TARGET_RGBA = 1
        /** A lane's bake pass drawn into a target of its own format ([RealmLane.rehearseScratch] is the scratch). */
        const val TARGET_OWN = 2
        private val SCREEN_RGBA = intArrayOf(TARGET_SCREEN, TARGET_RGBA)

        /** Why a gate holds the zoom ([RealmMapStats.gateReason]). */
        const val GATE_NONE = 0
        const val GATE_REHEARSAL = 1
        const val GATE_MAP_DATA = 2
        /** No lane can draw past this band for the resident realm (the overview clamp; native, not in core.js). */
        const val GATE_OVERVIEW = 3
        /** core.js `bandLimit` 'loading', D-173's dive rule at the pin 205b6326. D-177 withdrew it (web 197d753c): the
         *  engine never gates with it; only [RealmBandLimit]'s replay of the pinned golden still returns it. */
        const val GATE_LOADING = 4
        /** core.js `bandLimit` 'bypassed by a QA set()' (the web's QA hook; native has no QA set, so never live). */
        const val GATE_BYPASS = 5
        /** The "Enter map" meter stays below 1 until the dive may start (then [readiness] answers 1). */
        private const val READINESS_CAP = 0.99

        /** core.js RealmView: 7 std140 vec4s. */
        const val UBO_BYTES = 112
        /** map.js frame(): `gl.clearColor(0.05, 0.13, 0.27, 1)`, the deep sea until the realm's own sea is known. */
        const val SEA_R = 0.05f
        const val SEA_G = 0.13f
        const val SEA_B = 0.27f
        /** The neutral coast field texel for `rm-chart` without the pack's fieldsA ([RealmChart.NEUTRAL_COAST]). */
        private val NEUTRAL_FIELDS = byteArrayOf(RealmChart.NEUTRAL_COAST, RealmChart.NEUTRAL_COAST, RealmChart.NEUTRAL_COAST, 0xff.toByte())
        private val EMPTY: List<RealmCounter> = emptyList()
        private val NO_PROGRAMS: List<Gl3Program> = emptyList()

        /** A program name without its `+DEFINE` suffix (the rehearsal order and TRUE set name base programs). */
        fun baseName(name: String): String { val at = name.indexOf('+'); return if (at < 0) name else name.substring(0, at) }
    }
}
