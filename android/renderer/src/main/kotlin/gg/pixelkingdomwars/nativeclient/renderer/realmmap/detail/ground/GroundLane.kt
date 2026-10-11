package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground

import com.badlogic.gdx.graphics.GL20
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Bands
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Classes
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Flag
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.GpuSafe
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants.Kind
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Load
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Restorable
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmMapEngine
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmProgramSource
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundMath.clamp
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneUploads
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.RealmClasses
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.RejectedExecutionException
import kotlin.math.floor
import kotlin.math.hypot

/**
 * Draws the core's `rm-chart` (the painted chart in the realm's own sea, [gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmChart])
 * into the bound target under GROUND's MAP/TRUE passes — ground.js draw() puts the chart under MAP while it fades in or
 * while the view's lattice still resolves. [fieldsA] is GROUND's real coast field once loaded (sea glints), else null.
 * The engine owns the chart's textures; it supplies this to the lane. False when it drew nothing.
 */
fun interface GroundChartUnder { fun draw(view: RealmView, alpha: Double, fieldsA: Gl3Texture?): Boolean }

/** GROUND's counters for `[world-perf]`, the debug overlay and the tests. */
class GroundStats {
    var status = "none"
    var error: String? = null
    var programsReady = false
    var mapReady = false
    var trueReady = false
    /** The loaded pack has TRUE ground (`GroundAssets.trueReady`): a resume at a TRUE camera waits for it only then. */
    var hasTrue = false
    var lavaMissing = false
    var latticeSubTiles = 0
    var latticeResolved = 0L
    var pagesResolved = 0L
    var lastSubs = 0
    var lastPages = 0
    var latticeMissingInView = 0
    var pagesMissingInView = 0
    var preMap = 0
    var bakeHeld = false
    var recPages = 0
    var pagesOverCap = 0
    var baseUploadsDeferred = 0L
    var lineUploadsPending = 0
    var drawnChart = false; var drawnMap = false; var drawnTrue = false
    var rehearsed = 0
    var deferredAdopts = 0L
    /** G15/G16 base-state jobs landed, river vertices they moved (first pass), plots with a land bridge, line bytes uploaded. */
    var baseJobs = 0
    var riversMoved = 0
    var bridges = 0
    var lineUploadBytes = 0L
    var lineFull = 0
    /** The line-field texture as the load baked it (ground.js `st.lines`): page capacity, river and land pages, size. */
    var lineCapacity = 0; var riverPages = 0; var landPages = 0; var lineTexW = 0; var lineTexH = 0
}

/**
 * The realm map's GROUND lane (web `ground.js`, native N3): the MAP band's layered composite over a lattice of classes
 * resolved on the GPU (vertices 7 tiles apart, 1024² R8UI pages, 256² sub-tiles, apron 5), the TRUE band's kit ground
 * from per-deed record pages (99² vertex classes → 98² records, an LRU sized from the screen), and the classes-sampled
 * bindings LIFE and BASES read ([bindClasses]). The FAR chart is the core's ([GroundChartUnder]).
 *
 * Plan §5 rules, all enforced here:
 * - load work runs on the realm's decode executor ([GroundLoad]); the GL thread adopts results only when the frame
 *   allows work (never in a flight or a fade) and fills textures only through the worker uploader;
 * - resolve slices are planned in [update] and issued in [drawOffscreen] (offscreen passes precede the screen pass),
 *   within `groundcost.js resolveBudget` of the canvas and the ladder's `maxResolves`; a lattice resolve is never a bake
 *   program's first draw while the MAP pass is not on screen (W1 fix pass 2 #3: [rehearse] draws them first);
 * - every program's every (program, state) pair is drawn by [rehearse] before its band (the rehearse contract,
 *   lane-ground.md W1 G1): the display programs down every sampling call site through the probe uniform `uRhAt`, the
 *   bakes into scratch targets of their real formats;
 * - no per-frame allocation on the steady path (the page LRU and the view's work lists are fixed arrays).
 */
class GroundLane(
    private val core: Gl3Core,
    private val u: GroundUniformSink,
    /** The worker-context fresh-texture uploader (LIFE's [LaneUploads]: one `:app` adapter over `StagingUploader.fresh`). */
    private val uploads: LaneUploads,
    /** The realm's pack as GROUND reads it (the host adapts the core's loader: realm.json + verified detail files). */
    private val sourceFor: (RealmOpen) -> GroundSource,
    /** GROUND's program sources for a realm id (worker; default: the pinned export). */
    private val shaderSources: (String) -> Map<String, RealmProgramSource> = { GroundPrograms.load(it) },
    /** The widest texture the context allows (`GL_MAX_TEXTURE_SIZE`, ≥ 2048 on GLES 3.0): the line texture's width. */
    private val maxTextureSize: Int = GroundLoad.LINE_TEX_W,
    /** Milliseconds (the host's frame clock): the FAR pre-resolve waits for `GPU_SAFE.rehearse.idleMs` of rest. */
    private val nowMs: () -> Double = { System.nanoTime() / 1e6 },
) : RealmLane, RealmClasses {
    override val name = "ground"
    /** The core's chart under GROUND's passes; null = the lane leaves every frame that needs the chart to the core. */
    var chartUnder: GroundChartUnder? = null
    val stats = GroundStats()

    // ---- the resident realm ----
    private var open: RealmOpen? = null
    /** Bumped on every release (GL thread only); the load and base-state jobs read it on the decode threads to publish only
     *  while their realm is still this lane's ([publish]). */
    @Volatile private var generation = 0
    private val inbox = ConcurrentLinkedQueue<Any>()
    private var assets: GroundAssets? = null
    private var progs: Array<Gl3Program>? = null
    private var programList: List<Gl3Program> = emptyList()
    private var glEpoch = -1
    private val restore = Gl3Restorable { restoreAfterLoss() }
    init { core.onRestore(restore) }

    // programs by role (indices into progs)
    private val pRaw = 0; private val pDsp = 1; private val pLeg = 2; private val pPure = 3; private val pRec = 4; private val pMap = 5; private val pTrue = 6

    // ---- textures ----
    private var fieldsA: Gl3Texture? = null; private var fieldsBC: Gl3Texture? = null; private var baseTex: Gl3Texture? = null
    private var farTex: Gl3Texture? = null; private var lineTex: Gl3Texture? = null; private var toneTex: Gl3Texture? = null; private var plotsTex: Gl3Texture? = null
    private var mapKit: Gl3Texture? = null; private var mapMask: Gl3Texture? = null
    private var gA: Gl3Texture? = null; private var gB: Gl3Texture? = null; private var gMask: Gl3Texture? = null; private var gDecal: Gl3Texture? = null; private var gDecalBox: Gl3Texture? = null
    private var latArr: Gl3Texture? = null; private val latSteps = arrayOfNulls<Gl3Texture>(GroundCost.LATTICE_PASSES.size)
    private var recArr: Gl3Texture? = null; private val pageSteps = arrayOfNulls<Gl3Texture>(3 + Resolve.DESPECKLE_PASSES); private var pageTable: Gl3Texture? = null
    private val owned = ArrayList<Gl3Texture>()

    // ---- lattice (MAP classes) ----
    private var latW = 0; private var latH = 0; private var latPx = 0; private var latPy = 0; private var latSx = 0; private var latSy = 0
    private var latDone = ByteArray(0)

    // ---- TRUE pages (fixed-array LRU keyed by deed; no boxing) ----
    private var recCap = 0
    private var pageOfDeed = IntArray(0)      // deed → layer + 1 (0 = not resident); mirrors the uploaded page table
    private var deedOfLayer = IntArray(0)     // layer → deed (−1 free)
    private var layerStamp = LongArray(0)
    private var stampClock = 0L
    private val one16 = ByteBuffer.allocateDirect(2).order(ByteOrder.nativeOrder())

    // ---- base state ----
    private var baseCpu = ByteArray(0)
    private var baseDirty = false
    private var baseBuf: ByteBuffer = ByteBuffer.allocateDirect(1)
    private var basesVersion = -1

    // ---- per-frame plans (fixed arrays) ----
    private val budget = GroundCost.Budget()
    private var subPlan = IntArray(8); private var subPlanN = 0
    private var subWant = IntArray(64); private var subDist = DoubleArray(64)
    private var pageKeys = IntArray(256); private var pageDist = DoubleArray(256)
    private val plan = GroundCost.Plan(256)
    private var pagePlan = IntArray(8); private var pagePlanN = 0
    private var lastMissing = 0; private var lastPagesMissing = 0
    private var lastMoveMs = 0.0
    /** The idle frame period [update] last declared ([idlePeriodMs]; the host files it under `IdleScheduler.TAG_GROUND`). */
    private var idleMs = 0
    private val resident = GroundCost.Resident { k -> pageOfDeed[k] != 0 }

    // ---- per-frame uniform scratch ----
    private val palMap = FloatArray(14 * 3); private val palTrue = FloatArray(12)
    private val plotRows = FloatArray(21 * 4); private var room4 = IntArray(24)
    private val terr16 = IntArray(16); private val order = IntArray(5); private val wall = FloatArray(24); private val famK = FloatArray(18)
    private val yard = FloatArray(84); private val yardT = FloatArray(84)
    private var lgMap: GroundTables.MapTables? = null; private var trueT: GroundTables.TrueTables? = null
    // stage B, per realm (uniformTables): the gem sea's share, drift and colours (uMpGem / uMpGemCol), the deep tint and the
    // TRUE gem-highlight luma
    private var gemShare = 0.0; private var gemOn = false; private var gemDx = 0f; private var gemDy = 0f
    private val gemCol6 = FloatArray(6); private val deepTint = DoubleArray(3); private var gemHl = 0f

    // ---- rehearsal ----
    private val rh = GroundRehearsal()
    private val rehearsedBake = BooleanArray(5)

    // =============================================================== RealmLane

    override fun open(realm: RealmOpen) {
        releaseAll()
        open = realm
        val gen = ++generation
        stats.status = "loading"; stats.error = null
        val src = try { sourceFor(realm) } catch (e: RuntimeException) { fail("no source: ${e.message}"); return }
        try {
            realm.executor.execute {
                if (gen != generation) return@execute // released before it started: decode nothing
                val m: Any? = try {
                    val sources = shaderSources(realm.realmId)
                    Loaded(gen, sources, GroundLoad.load(src, realm.plots, realm.deeds, realm.grid.cols, realm.grid.rows, maxTextureSize) { gen == generation })
                } catch (e: GroundLoad.Stale) { null } // released mid-load: the later stages never ran
                catch (e: Exception) { Failed(gen, e.message ?: e.javaClass.simpleName) }
                if (m != null && publish(gen, m)) realm.wake.run()
            }
        } catch (e: RejectedExecutionException) { fail("decode executor refused the ground load") }
    }

    private class Loaded(val gen: Int, val sources: Map<String, RealmProgramSource>, val assets: GroundAssets)
    private class Failed(val gen: Int, val reason: String)

    /**
     * A worker result into the inbox only while [gen] is still this lane's realm, taken back when a release raced the offer
     * (the release bumps [generation] before it clears the inbox, so every interleaving leaves no stale message). P0: a
     * disposed lane stays reachable (the core keeps its restore hook), and a load that landed after dispose() used to sit
     * in its inbox holding a whole realm's pixels (the Seeker's +48.7 MB retention).
     */
    private fun publish(gen: Int, m: Any): Boolean {
        if (gen != generation) return false
        inbox.offer(m)
        if (gen != generation) { inbox.remove(m); return false }
        return true
    }

    private fun fail(reason: String) { stats.status = "failed"; stats.error = reason }

    override fun programs(): List<Gl3Program> = programList

    override fun rehearseTargets(program: Gl3Program): IntArray {
        val p = progs ?: return RealmLane.SCREEN_AND_RGBA
        return if (program === p[pMap] || program === p[pTrue]) RealmLane.SCREEN_AND_RGBA else OWN
    }

    override fun rehearseScratch(program: Gl3Program): Gl3Texture? {
        val p = progs ?: return null
        return when (program) {
            p[pRaw], p[pDsp], p[pLeg] -> rh.t8
            p[pPure] -> rh.t8a
            p[pRec] -> rh.trec
            else -> null
        }
    }

    override fun bandSet(): Int = if (stats.trueReady) 2 else if (stats.mapReady) 1 else 0
    override fun settled(): Boolean = stats.status == "ready" || stats.status == "failed"
    override fun readyFor(set: Int): Boolean = if (set >= 2) stats.trueReady else stats.mapReady

    /** ground.js `mapReady(view)` (W1 G4): the MAP data is in and every lattice sub-tile under the view is resolved. */
    override fun mapReady(view: RealmView): Boolean {
        if (!stats.mapReady || latDone.isEmpty()) return false
        val x0 = subAt(view.rectX0 - 0.5, latSx); val x1 = subAt(view.rectX1 + 0.5, latSx)
        val y0 = subAt(view.rectY0 - 0.5, latSy); val y1 = subAt(view.rectY1 + 0.5, latSy)
        for (y in y0..y1) for (x in x0..x1) if (latDone[y * latSx + x].toInt() == 0) return false
        return true
    }

    private fun subAt(v: Double, n: Int): Int = clamp(floor(v * 14 / GroundCost.SUB), 0.0, (n - 1).toDouble()).toInt()

    override fun basesChanged(bases: RealmBases) {
        latestBases = bases
        val a = assets ?: return
        if (baseCpu.isEmpty()) return
        val cols = a.cols; val rows = a.rows
        val next = baseCpu.copyOf()
        for (i in 0 until cols * rows) { next[i * 4 + 1] = 0; next[i * 4 + 2] = 0; next[i * 4 + 3] = 0 }
        for (i in 0 until bases.size) {
            val x = bases.deedX[i]; val y = bases.deedY[i]
            if (x < 0 || y < 0 || x >= cols || y >= rows) continue
            val o = (y * cols + x) * 4; val lv = clamp(bases.level[i].toDouble(), 1.0, 20.0).toInt()
            val f = bases.flags[i]
            next[o + 1] = (Flag.OCCUPIED or (if (f and Flag.MINE != 0) Flag.MINE else 0) or (if (f and Flag.SHIELD != 0) Flag.SHIELD else 0)).toByte()
            next[o + 2] = a.cls.plotGeom(lv).claim.toByte(); next[o + 3] = lv.toByte()
        }
        // ground.js applyBaseCpu + invalidateDeeds(baseChanged(…)): only deeds whose plot moved re-resolve
        for (i in 0 until cols * rows) {
            val o = i * 4
            val occA = baseCpu[o + 1].toInt() and Flag.OCCUPIED; val occB = next[o + 1].toInt() and Flag.OCCUPIED
            if (occA != occB || (occB != 0 && (baseCpu[o + 3] != next[o + 3] || baseCpu[o + 2] != next[o + 2]))) invalidateDeed(i)
        }
        var any = false
        for (i in next.indices) if (next[i] != baseCpu[i]) { any = true; break }
        if (!any) return
        for (i in 0 until cols * rows) {
            val o = i * 4
            if (next[o + 1] != baseCpu[o + 1] || next[o + 2] != baseCpu[o + 2] || next[o + 3] != baseCpu[o + 3]) changedPlots.add(i)
        }
        System.arraycopy(next, 0, baseCpu, 0, next.size)
        baseDirty = true
        kickBaseWork()
    }

    private var latestBases: RealmBases? = null
    /** Deeds whose plot changed since the last base-state job started (the job bridges their 3×3). */
    private val changedPlots = IntList()

    // ---- G15/G16 base-state work (ground.js updateBends / queueBridges / rebakeJob, P0 fix pass #8), on the worker ----
    private var baseJob = false
    private var baseWork: GroundBaseWork.Result? = null
    private var baseWorkAt = 0
    private val pageBuf: ByteBuffer = ByteBuffer.allocateDirect(ClassBake.PAGE_N * 4).order(ByteOrder.nativeOrder())
    private var rowBuf: ByteBuffer = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder())

    /** Start the worker job for the current base state (one at a time; a change during a job starts another after it). */
    private fun kickBaseWork() {
        val a = assets ?: return; val o = open ?: return; val lt = lineState ?: return
        if (baseJob || baseWork != null) return
        baseJob = true
        val gen = generation
        val input = GroundBaseWork.Input(a, baseCpu.copyOf(), changedPlots.toArray(), lt.copy(), rivers, bridges.copyOf())
        changedPlots.clear()
        try {
            o.executor.execute {
                if (gen != generation) return@execute // released before it started
                val r = try { GroundBaseWork.run(input) } catch (e: Exception) { null }
                if (publish(gen, BaseDone(gen, r))) o.wake.run()
            }
        } catch (e: RejectedExecutionException) { baseJob = false }
    }

    private class BaseDone(val gen: Int, val result: GroundBaseWork.Result?)

    /** Land a finished job's page and header uploads within this frame's upload budget; once all landed, switch the lane
     *  to the new rivers and bridges and re-resolve the deeds that read them (ground.js: `landed(k)` → invalidateDeeds). */
    private fun applyBaseWork(view: RealmView) {
        val r = baseWork ?: return; val t = lineTex ?: return
        while (baseWorkAt < r.uploads.size) {
            val u = r.uploads[baseWorkAt]
            val bytes = u.w.toLong() * u.h * 4
            if (view.uploadBytesLeft < bytes) return
            val buf = if (u.w * u.h == ClassBake.PAGE_N) pageBuf else { if (rowBuf.capacity() < u.words.size * 4) rowBuf = ByteBuffer.allocateDirect(u.words.size * 4).order(ByteOrder.nativeOrder()); rowBuf }
            buf.position(0); buf.asIntBuffer().put(u.words, 0, u.w * u.h); buf.position(0)
            core.upload(t, 0, 0, u.x, u.y, u.w, u.h, buf)
            view.uploadBytesLeft -= bytes; baseWorkAt++; stats.lineUploadBytes += bytes
        }
        stats.baseJobs++; stats.riversMoved = r.rivers.moved; stats.bridges = r.bridgeCount; if (r.full) stats.lineFull++
        rivers = r.rivers; bridges = r.bridges; bridgeCount = r.bridgeCount
        lineState = r.lines
        assets?.state?.let { it.rivers = r.rivers; it.bridges = r.bridges }
        for (k in r.invalidate) invalidateDeed(k)
        baseWork = null; baseWorkAt = 0
        if (changedPlots.size > 0) kickBaseWork()
    }

    override fun update(view: RealmView) {
        lastTargetW = view.targetW.toDouble(); lastTargetH = view.targetH.toDouble()
        if (view.workAllowed) adoptWork() else ensureGl()
        subPlanN = 0; pagePlanN = 0; stats.lastSubs = 0; stats.lastPages = 0
        val ready = assets != null && texturesReady(view.workAllowed)
        idleMs = idlePeriod(view)
        if (!ready) return
        if (view.moving) lastMoveMs = nowMs()
        if (baseDirty && view.workAllowed) flushBase(view)
        if (baseWork != null && view.workAllowed) applyBaseWork(view)
        val px = view.targetW.toDouble() * view.targetH
        GroundCost.resolveBudget(px, view.d < Bands.MAP_START, Resolve.DESPECKLE_PASSES, budget)
        val p = progs!!
        val bakesLinked = p[pRaw].ready && p[pDsp].ready && p[pLeg].ready && p[pPure].ready
        var subs = if (view.workAllowed && bakesLinked) budget.subs else 0
        var pages = if (view.workAllowed && bakesLinked && p[pRec].ready) budget.pages else 0
        if (view.maxResolves > 0) { subs = minOf(subs, view.maxResolves); pages = minOf(pages, view.maxResolves) }
        val needMap = view.d >= Bands.FAR_END * 0.75; val wantMap = stats.mapReady && needMap
        val mapShown = view.bands.far < 1
        val bakeCold = !(rehearsedBake[0] && rehearsedBake[1] && rehearsedBake[2] && rehearsedBake[3])
        val held = bakeCold && !mapShown
        stats.bakeHeld = held
        lastMissing = if (wantMap) latticePlan(view, if (held) 0 else subs) else if (needMap && !stats.mapReady && stats.error == null) 1 else 0
        stats.preMap = 0
        if (!needMap && stats.mapReady) {
            val preNow = !view.moving && nowMs() - lastMoveMs >= GpuSafe.REHEARSE_IDLE_MS && !held && view.workAllowed
            stats.preMap = latticePlan(view, if (preNow) 1 else 0) - subPlanN
        }
        // L1 (maxResolves 1): one sub-tile OR one page per frame, the sub-tile first (plan §5.4)
        if (view.maxResolves > 0 && subPlanN > 0) pages = 0
        lastPagesMissing = if (stats.trueReady) pagePlan(view, pages) else if (view.d >= Bands.PAGE_RESOLVE && trueT != null && stats.error == null) 1 else 0
        stats.latticeMissingInView = lastMissing; stats.pagesMissingInView = lastPagesMissing
    }

    override fun idlePeriodMs(): Int = idleMs

    /**
     * ground.js update() (205b6326, lines 1031-1032): `core.animating('ground', view.reducedMotion ? 0 : Math.min(125,
     * ready.true && w.true > 0 ? trueT.water.frameMs : 600))`, declared from the first frame after load() starts. What it
     * keeps moving at rest: the cloud shade (art-px steps ≈ 8 fps) and the glints in every band (the core's chart at FAR
     * included), Solana's MAP gem drift, and TRUE's kit water loop at its own period when faster (Solana's 110 ms gem
     * loop). The idle policy caps it and freezes it; reduced motion (or a safe ladder level) declares nothing.
     */
    private fun idlePeriod(view: RealmView): Int {
        if (open == null || view.reducedMotion) return 0
        val tt = trueT
        val water = if (stats.trueReady && view.bands.trueW > 0 && tt != null) tt.water.frameMs else IDLE_DRIFT_MS
        return minOf(IDLE_CAP_MS, water)
    }

    override fun drawOffscreen(view: RealmView) {
        val p = progs ?: return
        for (i in 0 until subPlanN) resolveSub(p, subPlan[i])
        for (i in 0 until pagePlanN) resolvePage(p, pagePlan[i] % assets!!.cols, pagePlan[i] / assets!!.cols)
        stats.lastSubs = subPlanN; stats.lastPages = pagePlanN
    }

    /** ground.js `passes(view)` as the RealmLane bitmask: chart under MAP while it fades in or while the lattice resolves;
     *  MAP under TRUE while it fades in or pages are missing; TRUE from the MAP→TRUE fade on. */
    override fun groundPasses(view: RealmView): Int {
        val tFM = 1 - view.bands.far; val tMT = view.bands.trueW
        val mapOn = stats.mapReady && tFM > 0; val trueOn = stats.trueReady && tMT > 0
        var m = 0
        if (!mapOn || tFM < 1 || lastMissing > 0) m = m or RealmLane.GROUND_CHART
        if (mapOn && (tMT < 1 || lastPagesMissing > 0 || !trueOn)) m = m or RealmLane.GROUND_MAP
        if (trueOn) m = m or RealmLane.GROUND_TRUE
        return m
    }

    override fun drawsGround(view: RealmView): Boolean {
        if (progs == null || !stats.mapReady) return false
        val m = groundPasses(view)
        if (m and (RealmLane.GROUND_MAP or RealmLane.GROUND_TRUE) == 0) return false   // FAR: the core's chart
        if (m and RealmLane.GROUND_CHART != 0 && chartUnder == null) return false         // the chart is the core's alone
        return true
    }

    override fun drawGround(view: RealmView) {
        val p = progs ?: return
        val m = groundPasses(view)
        val tFM = 1 - view.bands.far; val tMT = view.bands.trueW
        core.disable(GL20.GL_DEPTH_TEST); core.disable(GL20.GL_CULL_FACE); core.disable(GL20.GL_BLEND)
        stats.drawnChart = m and RealmLane.GROUND_CHART != 0; stats.drawnMap = m and RealmLane.GROUND_MAP != 0; stats.drawnTrue = m and RealmLane.GROUND_TRUE != 0
        if (stats.drawnChart) chartUnder?.draw(view, 1.0, fieldsA)
        if (stats.drawnMap) {
            if (tFM < 1) blendOn() else core.disable(GL20.GL_BLEND)
            drawMap(p[pMap], view, minOf(1.0, tFM)); core.disable(GL20.GL_BLEND)
        }
        if (stats.drawnTrue) {
            if (tMT < 1) blendOn() else core.disable(GL20.GL_BLEND)
            drawTrue(p[pTrue], view, tMT); core.disable(GL20.GL_BLEND)
        }
    }

    private fun blendOn() { core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_SRC_ALPHA, GL20.GL_ONE_MINUS_SRC_ALPHA) }

    override fun rehearse(program: Gl3Program, target: Int, view: RealmView): Boolean {
        val p = progs ?: return false
        val a = assets ?: return false
        if (!rh.ready(core)) return false
        val drew = when (program) {
            p[pRaw] -> { core.use(program); setFieldUniforms(program, a, rhGrid = true); setClassifyUniforms(program, a.cfg, 1.0); bindRhFields(program)
                u.i4(program, "uRsOrigin", 3, 3, 1, 0); core.fullscreen(); rehearsedBake[0] = true; true }
            p[pDsp] -> { core.use(program); core.bindTexture(0, rh.u8!!); u.i1(program, "uDsSrc", 0); u.i1(program, "uDsMode", 12); core.fullscreen(); rehearsedBake[1] = true; true }
            p[pLeg] -> { core.use(program); lgMap?.let { setLegalise(program, it.lg, false) } ?: u.i2(program, "uLgShift", 1, 1)
                core.bindTexture(0, rh.u8!!); u.i1(program, "uLgSrc", 0); core.fullscreen(); rehearsedBake[2] = true; true }
            p[pPure] -> { core.use(program); core.bindTexture(0, rh.u8!!); u.i1(program, "uPuSrc", 0); u.i2(program, "uPuShift", 1, 1); u.i1v(program, "uPuSlot", ZERO14, 14)
                core.fullscreen(); rehearsedBake[3] = true; true }
            p[pRec] -> { core.use(program); core.bindTexture(0, rh.u8!!); u.i1(program, "uTrV", 0); u.i2(program, "uTrDeed", 0, 0); u.i4(program, "uTrClaim", 0, 0, 3, 3)
                core.fullscreen(); rehearsedBake[4] = true; true }
            p[pMap] -> { rhMap(program, a); probe(program, rh.cx, rh.cy, 0f, 1); core.disable(GL20.GL_BLEND); core.fullscreen()
                probe(program, 0.02f, 0.02f, 1f, 0); blendOn(); core.fullscreen(); core.disable(GL20.GL_BLEND)
                if (stats.mapReady && latArr != null) { u.f4(program, "uRhAt", 0f, 0f, 0f, 0f); core.disable(GL20.GL_BLEND); drawMap(program, view, 1.0); blendOn(); drawMap(program, view, 0.5); core.disable(GL20.GL_BLEND) }
                u.f4(program, "uRhAt", 0f, 0f, 0f, 0f); true }
            p[pTrue] -> { rhTrue(program, a); probe(program, 0.002f, 0.002f, 0f, -1); core.disable(GL20.GL_BLEND); core.fullscreen()
                probe(program, 0.002f, 0.002f, 1f, -1); blendOn(); core.fullscreen(); core.disable(GL20.GL_BLEND)
                if (stats.trueReady && recArr != null) { u.f4(program, "uRhAt", 0f, 0f, 0f, 0f); core.disable(GL20.GL_BLEND); drawTrue(program, view, 1.0); blendOn(); drawTrue(program, view, 0.5); core.disable(GL20.GL_BLEND) }
                u.f4(program, "uRhAt", 0f, 0f, 0f, 0f); true }
            else -> false
        }
        if (drew) stats.rehearsed++
        return drew
    }

    /**
     * D-NEXT (amends D-173) ENGINE contract: is [program]'s pair drawable now? False while the rehearsal's own textures are
     * not resident yet: the engine skips the pair without counting a failed try (no 1.5-6 s backoff behind GROUND's own
     * fills, the cold-dive stall in the Seeker log) and asks again next frame.
     */
    override fun rehearsable(program: Gl3Program): Boolean = progs != null && assets != null && rh.ready(core)

    /** A realm leave (the engine evicts, then opens the next): nothing of this realm stays reachable from the lane. */
    override fun dispose() { releaseAll(); latestBases = null }

    // =============================================================== adoption

    private fun ensureGl() {
        if (glEpoch == core.epoch) return
        glEpoch = core.epoch
    }

    /**
     * D-NEXT (amends D-173) ENGINE contract: in any work frame, even while the engine holds this lane (it never draws here),
     * move a finished load into its uploads and poll their residency, so MAP is ready when the player first zooms in
     * rather than after the lane is released. Idempotent; sets [GroundStats.mapReady] (TRUE's too once a frame has sized
     * the record cache from the screen). [update] runs it first.
     */
    override fun adopt(nowMs: Double) = adoptWork()

    private fun adoptWork() {
        ensureGl()
        adoptInbox()
        if (assets != null) texturesReady(workAllowed = lastTargetW > 1.0 && lastTargetH > 1.0)
    }

    private fun adoptInbox() {
        while (true) {
            when (val m = inbox.poll() ?: break) {
                is Loaded -> if (m.gen == generation) adopt(m)
                is Failed -> if (m.gen == generation) fail(m.reason)
                is BaseDone -> if (m.gen == generation) { baseJob = false; baseWork = m.result; baseWorkAt = 0; if (m.result == null) stats.error = "base-state work failed" }
            }
        }
    }

    private fun adopt(m: Loaded) {
        val a = m.assets
        assets = a
        stats.lavaMissing = a.id == GroundPrograms.LAVA_REALM && GroundPrograms.MAP_LAVA !in m.sources
        val keys = arrayOf(GroundPrograms.RAW, GroundPrograms.DESPECKLE, GroundPrograms.LEGALISE, GroundPrograms.PURE, GroundPrograms.RECORD,
            if (m.sources.containsKey(GroundPrograms.MAP_LAVA)) GroundPrograms.MAP_LAVA else GroundPrograms.MAP, GroundPrograms.TRUE)
        progs = Array(keys.size) { i -> val s = m.sources.getValue(keys[i]); core.program(s.name, s.vs, s.fs, s.vsSha256, s.fsSha256) }
        programList = progs!!.toList()
        lgMap = a.mapT; trueT = a.trueT; stats.hasTrue = a.trueReady
        uniformTables(a)
        baseCpu = a.state.data.copyOf(); baseBuf = ByteBuffer.allocateDirect(baseCpu.size).order(ByteOrder.nativeOrder())
        // the load's zero bridges, shared (never written in place: a job works on copies, a landed one is swapped in whole)
        lineState = a.lineTex.pages(); rivers = a.lines.rivers; bridges = a.state.bridges ?: FloatArray(a.cols * a.rows * 4); bridgeCount = 0
        stats.lineCapacity = a.lineTex.cap; stats.riverPages = a.lineTex.riverPage.count { it >= 0 }; stats.landPages = a.lineTex.landPage.count { it >= 0 }
        stats.lineTexW = a.lineTex.w; stats.lineTexH = a.lineTex.h
        createTextures(a)
        stats.status = "ready"
        stats.mapReady = false; stats.trueReady = false
        latestBases?.let { basesChanged(it) } ?: open?.bases?.let { basesChanged(it) }
    }

    // the line texture's page bookkeeping and the state it was baked for (the worker job reads copies)
    private var lineState: LinePages? = null
    private var rivers: SegSet? = null
    private var bridges = FloatArray(0)

    private fun uniformTables(a: GroundAssets) {
        val rows = GroundTables.plotRows(a.cls); System.arraycopy(rows, 0, plotRows, 0, rows.size)
        room4 = GroundTables.room4(a.cls.plots)
        a.mapT?.let { System.arraycopy(it.terr, 0, terr16, 0, it.terr.size); for (i in 0 until 5) order[i] = it.order.getOrElse(i) { 0 } }
        a.palette.wall.forEachIndexed { i, c -> for (k in 0 until 4) wall[(i + 1) * 4 + k] = c.getOrElse(k) { 0.0 }.toFloat() }
        a.atlas?.let { for (i in 0 until 18) famK[i] = it.famK[i].toFloat() }
        System.arraycopy(a.yard, 0, yard, 0, 84); System.arraycopy(a.yardT, 0, yardT, 0, 84)
        // stage B (ground.js drawMap / drawTrue read these from meta and T every frame; built once here: no per-frame allocation)
        val gk = a.trueAtlas?.gemK
        gemOn = gk != null; gemShare = GroundTables.waterGems(a.meta)
        GroundTables.gemDrift(GroundTables.gemDriftLoop(a.meta)).let { gemDx = it[0].toFloat(); gemDy = it[1].toFloat() }
        for (i in 0 until 6) gemCol6[i] = gk?.getOrNull(i / 3)?.get(i % 3)?.toFloat() ?: 1f
        GroundTables.deepTint(a.palette.deep, a.meta).copyInto(deepTint)
        gemHl = GroundTables.gemHighlight(a.meta).toFloat()
    }

    private fun own(t: Gl3Texture?): Gl3Texture? { if (t != null) owned += t; return t }

    private fun fresh2D(w: Int, h: Int, f: Gl3Format, s: Gl3Sampling, bytes: ByteArray, levels: Int = 1): Gl3Texture? =
        own(uploads.fresh(core, Gl3Pool.REALM, false, w, h, 1, f, levels, s, Gl3Wrap.CLAMP) { _, _, _, _, out -> out.position(0); out.put(bytes, 0, minOf(bytes.size, out.remaining())); out.position(0) })

    /** R32UI filled straight from [words] on the uploader's decode thread: no GL-thread byte copy of the line field (6.3-18.7 MB
     *  on the real realms, the size of the allocations the Seeker's full heap failed). The same native-order bytes as before. */
    private fun freshWords(w: Int, h: Int, words: IntArray): Gl3Texture? =
        own(uploads.fresh(core, Gl3Pool.REALM, false, w, h, 1, Gl3Format.R32UI, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP) { _, _, _, _, out ->
            out.position(0)
            val ib = out.duplicate().order(ByteOrder.nativeOrder()).asIntBuffer()
            ib.put(words, 0, minOf(words.size, ib.remaining()))
        })

    private fun freshArray(l: LayerLevels, s: Gl3Sampling): Gl3Texture? =
        own(uploads.fresh(core, Gl3Pool.REALM, true, l.width, l.height, l.layers, Gl3Format.RGBA8, l.levels, s, Gl3Wrap.CLAMP) { layer, level, _, _, out -> l.fill(layer, level, out) })

    /**
     * The realm's textures, in the order the worker fills them: the rehearsal's 17 tiny textures FIRST (D-NEXT: the lane's
     * pairs rehearse while the ~21 MB of kit pixels still upload; last in the queue they held every GROUND pair behind
     * them), then the fields, base, far and line field, MAP's (the band the player zooms into first), then TRUE's.
     * Every fill captures its own arrays, so the load's upload-only part is dropped at the end ([GroundAssets.dropUploads]).
     */
    private fun createTextures(a: GroundAssets) {
        val cols = a.cols; val rows = a.rows
        rh.create(core, uploads, owned, a)
        fieldsA = fresh2D(a.fieldsA.width, a.fieldsA.height, Gl3Format.RGBA8, Gl3Sampling.NEAREST, a.fieldsA.rgba)
        fieldsBC = fresh2D(a.fieldsBC.width, a.fieldsBC.height, Gl3Format.RGBA8, Gl3Sampling.NEAREST, a.fieldsBC.rgba)
        baseTex = fresh2D(cols, rows, Gl3Format.RGBA8UI, Gl3Sampling.NEAREST, baseCpu)
        farTex = fresh2D(cols, rows, Gl3Format.R8, Gl3Sampling.LINEAR, ByteArray(cols * rows) { minOf(255.0, GroundMath.jsRound(a.far[it] * 16.0)).toInt().toByte() })
        val lt = a.lineTex
        lineTex = freshWords(lt.w, lt.h, lt.words)
        a.tone?.let { toneTex = fresh2D(it.width, it.height, Gl3Format.RGBA8, Gl3Sampling.LINEAR, it.rgba) }
        a.plots?.let { plotsTex = fresh2D(it.width, it.height, Gl3Format.RGBA8, Gl3Sampling.LINEAR, it.rgba) }
        a.atlas?.let { at ->
            at.kit?.let { mapKit = freshArray(it, Gl3Sampling.LINEAR_MIPMAP_LINEAR) }; at.mask?.let { mapMask = freshArray(it, Gl3Sampling.NEAREST_MIPMAP_NEAREST) }
        }
        // the lattice (render targets: allocated, never uploaded)
        latW = cols * 14 + 1; latH = rows * 14 + 1; latPx = (latW + LAT_PAGE - 1) / LAT_PAGE; latPy = (latH + LAT_PAGE - 1) / LAT_PAGE
        latSx = (latW + GroundCost.SUB - 1) / GroundCost.SUB; latSy = (latH + GroundCost.SUB - 1) / GroundCost.SUB
        latDone = ByteArray(latSx * latSy); stats.latticeSubTiles = latSx * latSy
        if (a.mapReady) {
            latArr = own(core.array(Gl3Pool.REALM, LAT_PAGE, LAT_PAGE, latPx * latPy, Gl3Format.R8UI))
            for (i in latSteps.indices) { val s = GroundCost.SUB + 2 * (GroundCost.APRON - i); latSteps[i] = own(core.texture2D(Gl3Pool.REALM, s, s, Gl3Format.R8UI)) }
        }
        a.trueAtlas?.let { t ->
            t.a?.let { gA = freshArray(it, Gl3Sampling.LINEAR_MIPMAP_LINEAR) }; t.b?.let { gB = freshArray(it, Gl3Sampling.LINEAR_MIPMAP_LINEAR) }
            t.mask?.let { gMask = freshArray(it, Gl3Sampling.NEAREST) }; t.decal?.let { gDecal = freshArray(it, Gl3Sampling.NEAREST) }
            t.decalBox?.let { gDecalBox = fresh2D(t.decalCount.coerceAtLeast(1), 1, Gl3Format.RGBA8, Gl3Sampling.NEAREST, it) }
        }
        if (a.trueReady) {
            recCap = 0 // sized at the first frame from the target (ground.js recCap: the screen)
            pageOfDeed = IntArray(cols * rows)
            pageTable = fresh2D(cols, rows, Gl3Format.R16UI, Gl3Sampling.NEAREST, ByteArray(cols * rows * 2))
            for (k in pageSteps.indices) { val s = 99 + 2 * k; pageSteps[k] = own(core.texture2D(Gl3Pool.REALM, s, s, Gl3Format.R8UI)) }
        }
        a.dropUploads()
    }

    private fun texturesReady(workAllowed: Boolean): Boolean {
        val a = assets ?: return false
        if (progs == null) return false
        val base = fieldsA?.ready == true && fieldsBC?.ready == true && baseTex?.ready == true && farTex?.ready == true && lineTex?.ready == true
        if (!base) return false
        val mapOk = a.mapReady && mapKit?.ready == true && mapMask?.ready == true && latArr?.ready == true && latSteps.all { it?.ready == true } &&
            (!a.hasTone || toneTex?.ready == true) && (!a.hasPlots || plotsTex?.ready == true)
        stats.mapReady = mapOk
        val trueOk = mapOk && a.trueReady && gA?.ready == true && gMask?.ready == true && pageTable?.ready == true && pageSteps.all { it?.ready == true } &&
            (a.trueAtlas?.hasB != true || gB?.ready == true) && (a.trueAtlas?.hasDecal != true || (gDecal?.ready == true && gDecalBox?.ready == true))
        if (trueOk && recArr == null && workAllowed) {
            // ground.js recCap(): the TRUE record cache holds a d-600 view of this screen (48…160 layers)
            recCap = GroundCost.recCapacity(maxOf(1.0, lastTargetW), maxOf(1.0, lastTargetH), Bands.PAGE_RESOLVE.toDouble())
            recArr = own(core.array(Gl3Pool.REALM, 98, 98, recCap, Gl3Format.RGBA16UI))
            deedOfLayer = IntArray(recCap) { -1 }; layerStamp = LongArray(recCap); stats.recPages = recCap
        }
        stats.trueReady = trueOk && recArr?.ready == true
        stats.programsReady = progs!!.all { it.ready }
        return true
    }

    private var lastTargetW = 1.0; private var lastTargetH = 1.0

    private fun flushBase(view: RealmView) {
        val t = baseTex ?: return
        val bytes = baseCpu.size.toLong()
        if (view.uploadBytesLeft < bytes) { stats.baseUploadsDeferred++; return }
        baseBuf.position(0); baseBuf.put(baseCpu); baseBuf.position(0)
        core.upload(t, 0, 0, 0, 0, t.width, t.height, baseBuf)
        view.uploadBytesLeft -= bytes
        baseDirty = false
    }

    // =============================================================== resolve planning

    /** ground.js latticeWork: the view's missing sub-tiles (2 deeds of margin) nearest the centre first, up to [n] of them
     *  planned for this frame → the count missing (the honest `missing`, W1 G4). */
    private fun latticePlan(view: RealmView, n: Int): Int {
        val x0 = subAt(view.rectX0 - 2, latSx); val x1 = subAt(view.rectX1 + 2, latSx)
        val y0 = subAt(view.rectY0 - 2, latSy); val y1 = subAt(view.rectY1 + 2, latSy)
        val cx = view.x * 14 / GroundCost.SUB; val cy = view.y * 14 / GroundCost.SUB
        var m = 0
        for (y in y0..y1) for (x in x0..x1) {
            val i = y * latSx + x
            if (latDone[i].toInt() != 0) continue
            if (m == subWant.size) { subWant = subWant.copyOf(m * 2); subDist = subDist.copyOf(m * 2) }
            subWant[m] = i; subDist[m] = hypot(x + 0.5 - cx, y + 0.5 - cy); m++
        }
        // insertion sort by distance (stable, like the web's sort of [dist, i] pairs by dist)
        for (i in 1 until m) { val w = subWant[i]; val d = subDist[i]; var j = i - 1
            while (j >= 0 && subDist[j] > d) { subWant[j + 1] = subWant[j]; subDist[j + 1] = subDist[j]; j-- }
            subWant[j + 1] = w; subDist[j + 1] = d }
        val take = minOf(n, m)
        if (subPlan.size < subPlanN + take) subPlan = subPlan.copyOf(subPlanN + take + 4)
        for (i in 0 until take) subPlan[subPlanN++] = subWant[i]
        return m
    }

    /** ground.js pageWork: keep the nearest `recCap` pages of the view (±1 deed), fetch their missing ones nearest-first
     *  within [n] → the kept pages still missing. */
    private fun pagePlan(view: RealmView, n: Int): Int {
        val a = assets ?: return 0
        if (recArr == null || view.d < Bands.PAGE_RESOLVE) return 0
        val cols = a.cols; val rows = a.rows
        val x0 = maxOf(0, floor(view.rectX0).toInt() - 1); val x1 = minOf(cols - 1, floor(view.rectX1).toInt() + 1)
        val y0 = maxOf(0, floor(view.rectY0).toInt() - 1); val y1 = minOf(rows - 1, floor(view.rectY1).toInt() + 1)
        var m = 0
        for (y in y0..y1) for (x in x0..x1) {
            if (m == pageKeys.size) { pageKeys = pageKeys.copyOf(m * 2); pageDist = pageDist.copyOf(m * 2) }
            pageKeys[m] = y * cols + x; pageDist[m] = hypot(x + 0.5 - view.x, y + 0.5 - view.y); m++
        }
        GroundCost.planPages(pageKeys, pageDist, m, recCap, resident, n, plan)
        for (i in plan.keepCount - 1 downTo 0) { val l = pageOfDeed[plan.keep[i]]; if (l != 0) layerStamp[l - 1] = ++stampClock }
        if (pagePlan.size < plan.fetchCount) pagePlan = IntArray(plan.fetchCount + 4)
        for (i in 0 until plan.fetchCount) pagePlan[i] = plan.fetch[i]
        pagePlanN = plan.fetchCount
        stats.pagesOverCap = maxOf(0, m - recCap)
        return plan.missing
    }

    // =============================================================== resolve passes (offscreen)

    private fun into(t: Gl3Texture) { core.offscreen(t, load = Gl3Load.DONT_CARE); core.fullscreen() }

    /** ground.js resolveSub: raw over the apron, despeckle ×2 (modes 12, 4), legalise ×2, then the purity pass into the
     *  sub-tile's rect of its lattice page. */
    private fun resolveSub(p: Array<Gl3Program>, i: Int) {
        val a = assets ?: return; val lat = latArr ?: return; val mt = lgMap ?: return
        val sx = i % latSx; val sy = i / latSx; val lx = sx * GroundCost.SUB; val ly = sy * GroundCost.SUB
        val pgx = lx / LAT_PAGE; val pgy = ly / LAT_PAGE; val layer = pgy * latPx + pgx
        val s = latSteps
        val raw = p[pRaw]
        core.offscreen(s[0]!!, load = Gl3Load.DONT_CARE)
        if (core.use(raw)) {
            setFieldUniforms(raw, a); setClassifyUniforms(raw, a.cfg, 0.0); bindFields(raw, 0); bindTex(raw, "uRmFieldsBC", 3, fieldsBC!!)
            u.i4(raw, "uRsOrigin", lx * 7, ly * 7, 7, GroundCost.APRON); core.fullscreen()
        }
        for (k in 0 until 2) {
            val dsp = p[pDsp]
            core.offscreen(s[k + 1]!!, load = Gl3Load.DONT_CARE)
            if (core.use(dsp)) { bindTex(dsp, "uDsSrc", 0, s[k]!!); u.i1(dsp, "uDsMode", Resolve.mapDespeckleMode(k)); core.fullscreen() }
        }
        for (k in 0 until 2) {
            val leg = p[pLeg]
            core.offscreen(s[k + 3]!!, load = Gl3Load.DONT_CARE)
            if (core.use(leg)) { setLegalise(leg, mt.lg, k == 1); bindTex(leg, "uLgSrc", 0, s[k + 2]!!); core.fullscreen() }
        }
        val ox = lx - pgx * LAT_PAGE; val oy = ly - pgy * LAT_PAGE
        val pure = p[pPure]
        core.offscreen(lat, layer, load = Gl3Load.KEEP)
        core.viewport(ox, oy, GroundCost.SUB, GroundCost.SUB)
        if (core.use(pure)) {
            bindTex(pure, "uPuSrc", 0, s[4]!!); u.i2(pure, "uPuShift", 1 - ox, 1 - oy); u.i1v(pure, "uPuSlot", mt.terr, 14); core.fullscreen()
        }
        latDone[i] = 1; stats.latticeResolved++
    }

    /** ground.js resolvePage: raw on the full apron, 6 despeckle passes, legalise ×2, then the records of deed (dx, dy). */
    private fun resolvePage(p: Array<Gl3Program>, dx: Int, dy: Int) {
        val a = assets ?: return; val rec = recArr ?: return; val tt = trueT ?: return
        val k = dy * a.cols + dx
        var layer = -1
        for (l in 0 until recCap) if (deedOfLayer[l] < 0) { layer = l; break }
        if (layer < 0) { var oldest = 0; for (l in 1 until recCap) if (layerStamp[l] < layerStamp[oldest]) oldest = l; evictLayer(oldest); layer = oldest }
        val s = pageSteps; val top = s.size - 1
        val raw = p[pRaw]
        core.offscreen(s[top]!!, load = Gl3Load.DONT_CARE)
        if (core.use(raw)) {
            setFieldUniforms(raw, a); setClassifyUniforms(raw, a.cfg, 1.0); bindFields(raw, 0); bindTex(raw, "uRmFieldsBC", 3, fieldsBC!!)
            u.i4(raw, "uRsOrigin", dx * a.cls.tiles, dy * a.cls.tiles, 1, top); core.fullscreen()
        }
        var i = top
        for (pass in 0 until Resolve.DESPECKLE_PASSES) {
            val dsp = p[pDsp]
            core.offscreen(s[i - 1]!!, load = Gl3Load.DONT_CARE)
            if (core.use(dsp)) { bindTex(dsp, "uDsSrc", 0, s[i]!!); u.i1(dsp, "uDsMode", Resolve.despeckleMode(pass)); core.fullscreen() }
            i--
        }
        while (i > 0) {
            val leg = p[pLeg]
            core.offscreen(s[i - 1]!!, load = Gl3Load.DONT_CARE)
            if (core.use(leg)) { setLegalise(leg, tt.lg, false); bindTex(leg, "uLgSrc", 0, s[i]!!); core.fullscreen() }
            i--
        }
        val r = p[pRec]
        core.offscreen(rec, layer, load = Gl3Load.DONT_CARE)
        if (core.use(r)) {
            bindTex(r, "uTrV", 0, s[0]!!)
            u.i2(r, "uTrDeed", dx, dy)
            claimOf(a, dx, dy)
            u.i4(r, "uTrClaim", claim[0], claim[1], claim[2], claim[3])
            u.i1v(r, "uTrTerr", tt.terr, 14); u.i1v(r, "uTrLayer", tt.layer, 16); u.i4v(r, "uTrPure", tt.pure, 16)
            u.i4v(r, "uTrPair4", tt.pair, 64); u.i4v(r, "uTrFam", tt.famU, 48); u.i1(r, "uTrWaterPhases", tt.water.phases)
            u.i1v(r, "uTrDecal", tt.decalOf, 14); u.i4v(r, "uTrDecalGroup", tt.groups, 8); u.i2v(r, "uTrDecalSalt", tt.salts, 8)
            core.fullscreen()
        }
        deedOfLayer[layer] = k; layerStamp[layer] = ++stampClock; pageOfDeed[k] = layer + 1
        writePageTable(dx, dy, layer + 1)
        stats.pagesResolved++
    }

    private val claim = IntArray(4)

    /** classify.js plotAt(state, dx, dy)'s closed claim rect (G8 offset), as uniform4i truncates it, into [claim]; all −1
     *  without a plot. No allocation (the record pass runs in motion frames). */
    private fun claimOf(a: GroundAssets, dx: Int, dy: Int) {
        val i = (dy * a.cols + dx) * 4
        val lv = baseCpu[i + 3].toInt() and 0xff
        if ((baseCpu[i + 1].toInt() and Flag.OCCUPIED) == 0 || lv == 0) { claim.fill(-1); return }
        val plots = a.cls.plots; val l = minOf(plots.maxLevel, lv); val c = plots.rule(l).claim.toDouble() / 2; val pc = plots.plotCentre.toDouble()
        val ox = plots.offsetX(dx, dy, l); val oy = plots.offsetY(dx, dy, l)
        claim[0] = GroundMath.toInt32(pc - c + ox); claim[1] = GroundMath.toInt32(pc - c + oy); claim[2] = GroundMath.toInt32(pc + c + ox); claim[3] = GroundMath.toInt32(pc + c + oy)
    }

    private fun evictLayer(l: Int) {
        val k = deedOfLayer[l]; if (k < 0) return
        deedOfLayer[l] = -1; pageOfDeed[k] = 0
        val cols = assets?.cols ?: return
        writePageTable(k % cols, k / cols, 0)
    }

    private fun writePageTable(x: Int, y: Int, v: Int) {
        val t = pageTable ?: return
        one16.position(0); one16.putShort(0, v.toShort()); one16.position(0)
        core.upload(t, 0, 0, x, y, 1, 1, one16)
    }

    /** ground.js invalidateDeeds([k]): the 3×3 deeds a plot reaches (+ the apron) re-resolve; their resident pages drop. */
    private fun invalidateDeed(k: Int) {
        val a = assets ?: return
        if (latDone.isEmpty()) return
        val dx = k % a.cols; val dy = k / a.cols; val ap = GroundCost.APRON; val sub = GroundCost.SUB
        for (y in Math.floorDiv((dy - 1) * 14 - ap, sub)..Math.floorDiv((dy + 2) * 14 + ap, sub))
            for (x in Math.floorDiv((dx - 1) * 14 - ap, sub)..Math.floorDiv((dx + 2) * 14 + ap, sub))
                if (x >= 0 && y >= 0 && x < latSx && y < latSy) latDone[y * latSx + x] = 0
        if (pageOfDeed.isEmpty()) return
        for (j in -1..1) for (i in -1..1) {
            val x = dx + i; val y = dy + j; if (x < 0 || y < 0 || x >= a.cols || y >= a.rows) continue
            val l = pageOfDeed[y * a.cols + x]; if (l != 0) evictLayer(l - 1)
        }
    }

    // =============================================================== uniforms (ground.js setFieldUniforms / setClassifyUniforms)

    private fun bindTex(p: Gl3Program, name: String, unit: Int, t: Gl3Texture) { core.bindTexture(unit, t); u.i1(p, name, unit) }

    /** rm-fields + rm-classify samplers at [first]: base, fieldsA, the line texture (ground.js bindFieldTextures). */
    private fun bindFields(p: Gl3Program, first: Int) {
        bindTex(p, "uRmBase", first, baseTex!!); bindTex(p, "uRmFieldsA", first + 1, fieldsA!!); bindTex(p, "uRmLineTex", first + 2, lineTex!!)
    }

    private fun setFieldUniforms(p: Gl3Program, a: GroundAssets, rhGrid: Boolean = false) {
        val lt = lineState ?: a.lineTex.pages()
        u.f4v(p, "uRmPlot", plotRows, 21)
        u.i4v(p, "uRmRoom4", room4, 6)
        if (rhGrid) { u.i4(p, "uRmGrid", 1, 1, 0, 1); u.i4(p, "uRmLinesGeo", 1, 7, 8, 0) }
        else { u.i4(p, "uRmGrid", a.cols, a.rows, 0, if (bridgeCount > 0) 1 else 0); u.i4(p, "uRmLinesGeo", lt.pr, lt.r0, lt.w, 0) }
        u.f4(p, "uRmBake", ClassBake.CAP.toFloat(), ClassBake.AMP_CAP.toFloat(), 0f, 0f)
        u.f4(p, "uRmFieldsPpd", 8f, 4f, 0f, 0f)
    }

    /** Plots with a land bridge in the current base state (ground.js `st.bridges`, uRmGrid.w). */
    private var bridgeCount = 0

    private fun setClassifyUniforms(p: Gl3Program, c: ClassCfg, fine: Double) {
        u.f4(p, "uRmCfgA", c.coastK.toFloat(), c.inlandK.toFloat(), c.force.toFloat(), 0f)
        val cl = c.clearing; val ap = c.apron; val w = c.classWarp; val lw = c.lakeWarp; val br = c.bridge
        u.f4(p, "uRmRing", cl.extra.toFloat(), cl.corner.toFloat(), cl.amp.toFloat(), cl.amp2.toFloat())
        u.i4(p, "uRmRingP", cl.period.toInt(), cl.period2.toInt(), cl.seed, cl.seed2)
        u.f4(p, "uRmRing2", cl.lobe.toFloat(), ap.min.toFloat(), ap.amp.toFloat(), ap.feather.toFloat()); u.i4(p, "uRmApronP", ap.period.toInt(), ap.seed, 0, 0)
        val rg = c.claimRag
        u.f4(p, "uRmRag", (rg?.amp ?: 0.0).toFloat(), (rg?.period ?: 5.0).toFloat(), (rg?.seed ?: 0).toFloat(), 0f)
        u.f4(p, "uRmWarp", (w?.amp ?: 0.0).toFloat(), (w?.amp2 ?: 0.0).toFloat(), (w?.amp3 ?: 0.0).toFloat(), fine.toFloat())
        u.i4(p, "uRmWarpP", (w?.period ?: 1.0).toInt(), (w?.period2 ?: 1.0).toInt(), (w?.cell3 ?: 1.0).toInt(), w?.seed ?: 0)
        u.f4(p, "uRmWarpZ", (w?.zig ?: 0.0).toFloat(), (w?.zigCell ?: 1.0).toFloat(), 0f, 0f)
        u.f4(p, "uRmLakeW", (lw?.amp ?: 0.0).toFloat(), (lw?.amp2 ?: 0.0).toFloat(), 0f, 0f)
        u.i4(p, "uRmLakeWP", (lw?.period ?: 1.0).toInt(), (lw?.period2 ?: 1.0).toInt(), lw?.seed ?: 0, 0)
        u.f4(p, "uRmBridge", br.k.toFloat(), br.wob.toFloat(), br.taper.toFloat(), 0f); u.i4(p, "uRmBridgeP", br.wobPeriod.toInt(), br.seed, 0, 0)
        u.f4(p, "uRmCfgB", c.deepT.toFloat(), c.beachW.toFloat(), if (c.hasShore) 1f else 0f, c.rockT.toFloat())
        u.f4(p, "uRmCfgC", (if (c.slopeT.isFinite()) c.slopeT else -1.0).toFloat(), c.slopeStep.toFloat(), c.snowT.toFloat(), c.fieldT.toFloat())
        u.f4(p, "uRmCfgD", c.forestT.toFloat(), c.specialT.toFloat(), c.g2T.toFloat(), c.riverNoiseReach.toFloat())
        u.f4(p, "uRmCfgE", c.rockWaterGap.toFloat(), c.rockPlotGap.toFloat(), c.roadInland.toFloat(), c.roadCoast.toFloat())
        u.f4(p, "uRmNoiseAmp", c.coastNoise.amp.toFloat(), c.inlandNoise.amp.toFloat(), c.beachNoise.amp.toFloat(), c.coastNoise2.amp.toFloat())
        u.i4(p, "uRmCoast2", c.coastNoise2.period.toInt(), c.coastNoise2.seed, 0, 0)
        u.i4(p, "uRmNoisePer", c.coastNoise.period.toInt(), c.inlandNoise.period.toInt(), c.beachNoise.period.toInt(), c.parcel.block)
        u.ui4(p, "uRmNoiseSeed", c.coastNoise.seed, c.inlandNoise.seed, c.beachNoise.seed, c.parcel.salt)
        u.i4(p, "uRmParcel", c.parcel.min, c.parcel.max, 0, 0)
        val l = LinesCfg.DEFAULT
        u.f4(p, "uRmLines", l.riverHwMin.toFloat(), l.trackHwMin.toFloat(), l.riverNoiseK.toFloat(), l.lensMargin.toFloat())
        val i = ClassCfg.DEFAULT.island
        u.f4(p, "uRmIsle", i.base.toFloat(), i.corner.toFloat(), i.lobe.toFloat(), i.slope.toFloat()); u.f4(p, "uRmIsle2", i.amp.toFloat(), i.amp2.toFloat(), i.zig.toFloat(), i.shallow.toFloat())
        u.i4(p, "uRmIsleP", i.period.toInt(), i.period2.toInt(), i.zigCell.toInt(), i.seed)
        u.f4(p, "uRmIsle3", i.k.toFloat(), i.shallowPeriod.toFloat(), islandReach.toFloat(), 0f)
        u.f4(p, "uRmIsle4", i.halo.toFloat(), i.haloFade.toFloat(), i.haloDeep.toFloat(), 0f)
    }

    private val islandReach: Double by lazy { assets?.cls?.islandReach() ?: 0.0 }

    private fun setLegalise(p: Gl3Program, t: LegaliseTables, plusOne: Boolean) {
        u.i1v(p, "uLgTerr", t.terr, 14); u.i1v(p, "uLgLegal", t.legal, 16); u.i1v(p, "uLgFallback", t.fallback, 14); u.i1v(p, "uLgRank", t.rank, 14)
        u.i2(p, "uLgShift", 1, 1); u.i1(p, "uLgPlusOne", if (plusOne) 1 else 0)
    }

    // =============================================================== display passes (ground.js drawMap / drawTrue)

    private fun drawMap(p: Gl3Program, view: RealmView, alpha: Double) {
        val a = assets ?: return; val mt = lgMap ?: return; val atlas = a.atlas ?: return
        if (!core.use(p)) return
        setFieldUniforms(p, a); setClassifyUniforms(p, a.cfg, 1.0)
        bindTex(p, "uMpKit", 0, mapKit!!); bindTex(p, "uMpMask", 1, mapMask!!); bindTex(p, "uMpLattice", 2, latArr!!); bindTex(p, "uRmFieldsA", 3, fieldsA!!)
        bindTex(p, "uRmFieldsBC", 4, fieldsBC!!); bindTex(p, "uRmLineTex", 5, lineTex!!); bindTex(p, "uMpTone", 7, toneTex ?: core.dummy(integer = false, array = false))
        bindTex(p, "uRmBase", 8, baseTex!!); bindTex(p, "uMpPlots", 9, plotsTex ?: core.dummy(integer = false, array = false))
        bindTex(p, "uMpRec", 10, recArr ?: core.dummy(integer = true, array = true)); bindTex(p, "uMpPage", 11, pageTable ?: core.dummy(integer = true, array = false))
        bindTex(p, "uMpFar", 12, farTex!!)
        val pal = a.palette; val d = view.d
        u.f3(p, "uMpSeaFar", pal.seaFar[0].toFloat(), pal.seaFar[1].toFloat(), pal.seaFar[2].toFloat())
        u.i4v(p, "uMpNz", a.nz, 28)
        u.i1(p, "uMpVtx", if (recArr != null && d >= Bands.PAGE_RESOLVE) 1 else 0)
        u.f4v(p, "uMpYard", yard, 21); u.f4v(p, "uMpYardT", yardT, 21); u.f1(p, "uMpYardW", if (plotsTex != null) view.bands.decor.toFloat() else 0f)
        u.i4(p, "uMpLat", LAT_PAGE, latPx, latW, latH)
        u.i4v(p, "uMpTerr4", terr16, 4); u.i4v(p, "uMpFam", atlas.fam, 6); u.i1(p, "uMpObst", mt.obst); u.i1(p, "uMpClr", mt.clr); u.i4v(p, "uMpWang", atlas.wang, 6)
        u.i4(p, "uMpOrder", order[0], order[1], order[2], order[3]); u.i1(p, "uMpOrder5", order[4])
        u.i2(p, "uMpWild", atlas.wild[0], atlas.wild[1]); u.i2(p, "uMpField", atlas.field[0], atlas.field[1])
        val gt = clamp(ln(d / TONE_START) / ln(TONE_END / TONE_START), 0.0, 1.0); val gradeW = 1 - gt * gt * (3 - 2 * gt)
        val lava = a.id == GroundPrograms.LAVA_REALM
        u.f4(p, "uMpGrade", gradeW.toFloat(), if (toneTex != null) 1f else 0f, alpha.toFloat(), if (lava) 1f else 0f)
        u.f2(p, "uMpToneK", 1f, TONE_CHROMA.toFloat())
        val famW = 1 - clamp(ln(d / 48) / ln(1100.0 / 48), 0.0, 1.0)
        u.f3v(p, "uMpFamK", famK, 6); u.f1(p, "uMpFamW", famW.toFloat())
        mapPalette(a, d)
        u.f3v(p, "uMpPal", palMap, 14)
        u.f4v(p, "uMpWall", wall, 6)
        val lineA = 0.045 * clamp((d - 150) / 150, 0.0, 1.0) * (1 - clamp(ln(d / 500) / ln(2.0), 0.0, 1.0))
        val trackW = 1 - clamp(ln(d / 500) / ln(800.0 / 500), 0.0, 1.0)
        u.f4(p, "uMpDeedLine", lineA.toFloat(), trackW.toFloat(), 0f, 0f)
        val thin = a.meta.get("map")?.get("trueThin")?.takeIf { it.isNumber }?.asDouble() ?: if (a.id == "sunscar") SUNSCAR_THIN else 0.0
        val share = thin * clamp(ln(d / THIN_D0) / ln(THIN_D1 / THIN_D0), 0.0, 1.0)
        u.f2(p, "uMpThin", share.toFloat(), 0f); u.i1(p, "uMpThinMask", mt.clr)
        // stage B: the gem sea (off until TRUE's loop colours are measured, and in every realm without a share); the drift is
        // set either way (ground.js gemDrift of the SEA loop)
        val gs = if (gemOn) gemShare * clamp(ln(d / GroundTables.GEM_D0) / ln(GroundTables.GEM_D1 / GroundTables.GEM_D0), 0.0, 1.0) else 0.0
        u.f4(p, "uMpGem", gs.toFloat(), gemDx, gemDy, if (gs > 0) 1f else 0f); u.f3v(p, "uMpGemCol", gemCol6, 2)
        core.fullscreen()
    }

    /** ground.js drawMap's class palette (GA2-07 water toward the kit loop with the realm's [GroundTables.deepTint], fix-2 #15
     *  and fix pass #6 rivers from the painting's own water at d 48 to the kit loop by d 120), into [palMap]. */
    private fun mapPalette(a: GroundAssets, d: Double) {
        val pal = a.palette; val t = a.trueAtlas; val kw = t?.kitWater
        val wk = if (kw != null) clamp(ln(d / 150) / ln(800.0 / 150), 0.0, 1.0) else 0.0
        val lava = a.id == GroundPrograms.LAVA_REALM; val seaLava = t?.seaIsLava == true
        val wS = if (seaLava) 0.0 else wk
        val wkIn = clamp(ln(d / 48) / ln(120.0 / 48), 0.0, 1.0)
        for (c in 0 until 3) {
            val tint = deepTint[c]
            val shallow = if (wS != 0.0) mix(pal.shallow[c], kw!![c], wS) else pal.shallow[c]
            val sea = if (wS != 0.0) mix(pal.sea[c], kw!![c] * (1 + (tint - 1) * 2 / 3), wS) else pal.sea[c]
            val deep = if (wS != 0.0) mix(pal.deep[c], kw!![c] * tint, wS) else pal.deep[c]
            val water = if (!lava && t?.kitInland != null) mix(pal.paintWater[c], t.kitInland[c], wkIn) else pal.water[c]
            palMap[0 * 3 + c] = shallow.toFloat(); palMap[1 * 3 + c] = sea.toFloat(); palMap[2 * 3 + c] = deep.toFloat(); palMap[3 * 3 + c] = pal.foam[c].toFloat()
            palMap[4 * 3 + c] = pal.beach[c].toFloat(); palMap[5 * 3 + c] = water.toFloat(); palMap[6 * 3 + c] = pal.bank[c].toFloat(); palMap[7 * 3 + c] = pal.road[c].toFloat()
            palMap[8 * 3 + c] = pal.roadEdge[c].toFloat(); palMap[9 * 3 + c] = pal.turf[c].toFloat()
            palMap[10 * 3 + c] = pal.edge[0][c].toFloat(); palMap[11 * 3 + c] = pal.edge[1][c].toFloat(); palMap[12 * 3 + c] = pal.edge[2][c].toFloat(); palMap[13 * 3 + c] = pal.wet[c].toFloat()
        }
    }

    private fun mix(a: Double, b: Double, k: Double) = a + (b - a) * k

    private fun drawTrue(p: Gl3Program, view: RealmView, alpha: Double) {
        val a = assets ?: return; val tt = trueT ?: return
        if (!core.use(p)) return
        setFieldUniforms(p, a); setClassifyUniforms(p, a.cfg, 1.0)
        bindTex(p, "uTgA", 0, gA!!); bindTex(p, "uTgB", 1, gB ?: core.dummy(integer = false, array = true)); bindTex(p, "uTgDecal", 2, gDecal ?: core.dummy(integer = false, array = true))
        bindTex(p, "uTgMask", 3, gMask!!); bindTex(p, "uTgRec", 4, recArr!!); bindTex(p, "uTgDecalBox", 5, gDecalBox ?: core.dummy(integer = false, array = false))
        bindTex(p, "uTgPage", 6, pageTable!!); bindTex(p, "uRmBase", 7, baseTex!!); bindTex(p, "uRmFieldsA", 8, fieldsA!!); bindTex(p, "uRmLineTex", 9, lineTex!!)
        bindTex(p, "uRmFieldsBC", 10, fieldsBC!!)
        // stage B: .w = the loop's phase step (0 would draw the pre-stage-B step 2: Solana's 16-frame gem rows would cluster)
        u.i4(p, "uTgWater", tt.water.first, tt.water.frames, tt.water.frameMs, tt.water.step); u.i4(p, "uTgWater2", tt.inland.first, tt.inland.frames, tt.inland.frameMs, tt.inland.step)
        val pal = a.palette
        for (c in 0 until 3) { palTrue[c] = deepTint[c].toFloat(); palTrue[3 + c] = pal.foam[c].toFloat() }
        // (RM-24: slot 2 was the selected deed's gold outline; TRUE no longer draws it, the slot stays for the layout)
        for (i in 6 until 12) palTrue[i] = 0f
        u.f3v(p, "uTgPal", palTrue, 4)
        u.f4(p, "uTgOpt", alpha.toFloat(), 0f, 10f, gemHl)
        core.fullscreen()
    }

    // =============================================================== classes (LIFE / BASES)

    /**
     * ground.js `bindClasses(p, first)` (the classes-sampled contract, lane-ground.md): binds units [first]…[first] + 6 —
     * the lattice, the TRUE records, the page table, the base state, fieldsA, the line texture, fieldsBC (dummies of the
     * right sampler kind before the band's data is in) — and every uniform `classes` reads, on [program] (in use).
     * Returns [first] + 7. LIFE and BASES call it (units 8–14 by `UNITS.classesFirst`).
     */
    override fun bindClasses(program: Gl3Program, firstUnit: Int): Boolean {
        if (lineTex?.ready != true || baseTex?.ready != true || fieldsA?.ready != true) return false
        bindClassUnits(program, firstUnit)
        return true
    }

    /** RealmClasses: GROUND's CPU class at a realm-local tile vertex (its own [Classify]: never shared across threads). */
    override fun classAt(): ((Int, Int) -> Int)? {
        val st = classState() ?: return null
        val cls = Classify(st.cls.plots)
        return { x, y -> cls.classAt(st.fields, st.lines, st.state, x.toDouble(), y.toDouble(), st.cfg) }
    }

    /** [bindClasses] without the readiness check (dummies of the right sampler kind where a band's data is missing):
     *  → [first] + 7. */
    fun bindClassUnits(program: Gl3Program, first: Int): Int {
        bindTex(program, "uRmLattice", first, latArr ?: core.dummy(integer = true, array = true))
        bindTex(program, "uRmRecords", first + 1, recArr ?: core.dummy(integer = true, array = true))
        bindTex(program, "uRmPageTable", first + 2, pageTable ?: core.dummy(integer = true, array = false))
        bindTex(program, "uRmBase", first + 3, baseTex ?: core.dummy(integer = true, array = false))
        bindTex(program, "uRmFieldsA", first + 4, fieldsA ?: core.dummy(integer = false, array = false))
        bindTex(program, "uRmLineTex", first + 5, lineTex ?: core.dummy(integer = true, array = false))
        bindTex(program, "uRmFieldsBC", first + 6, fieldsBC ?: core.dummy(integer = false, array = false))
        val a = assets
        if (a != null && lineTex != null) { setFieldUniforms(program, a); setClassifyUniforms(program, a.cfg, 1.0) }
        u.i4(program, "uRmLat", LAT_PAGE, if (latArr != null) latPx else 1, if (latArr != null) latW else 0, if (latArr != null) latH else 0)
        return first + 7
    }

    /** contracts.GROUND_API `classState()`: GROUND's CPU class inputs for [Classify.classAt] once loaded, else null. */
    fun classState(): GroundClassState? {
        val a = assets ?: return null
        if (!stats.mapReady) return null
        return GroundClassState(a.cls, a.fields, a.lines, BaseState(a.cols, a.rows, baseCpu.copyOf()).also { it.rivers = a.state.rivers; it.bridges = a.state.bridges }, a.cfg)
    }

    // =============================================================== rehearsal helpers

    private fun probe(p: Gl3Program, x: Float, y: Float, w: Float, vtx: Int) {
        u.f4(p, "uRhAt", x, y, 1f, w)
        if (vtx >= 0) u.i1(p, "uMpVtx", vtx)
    }

    private fun bindRhFields(p: Gl3Program) {
        bindTex(p, "uRmBase", 7, rh.base!!); bindTex(p, "uRmFieldsA", 8, rh.fA!!); bindTex(p, "uRmLineTex", 9, rh.lt!!); bindTex(p, "uRmFieldsBC", 10, rh.fBC!!)
    }

    /** ground.js rhMap: drawMap's state over the rehearsal textures (units as drawMap binds them). */
    private fun rhMap(p: Gl3Program, a: GroundAssets) {
        core.use(p)
        setFieldUniforms(p, a, rhGrid = true); setClassifyUniforms(p, a.cfg, 1.0)
        bindTex(p, "uMpKit", 0, mapKit ?: rh.kitLin!!); bindTex(p, "uMpMask", 1, mapMask ?: rh.kitNear!!); bindTex(p, "uMpLattice", 2, rh.lat!!)
        bindTex(p, "uRmFieldsA", 3, rh.fA!!); bindTex(p, "uRmFieldsBC", 4, rh.fBC!!); bindTex(p, "uRmLineTex", 5, rh.lt!!); bindTex(p, "uMpTone", 7, toneTex ?: rh.lin!!)
        bindTex(p, "uRmBase", 8, rh.base!!); bindTex(p, "uMpPlots", 9, plotsTex ?: rh.lin!!); bindTex(p, "uMpRec", 10, rh.rec!!); bindTex(p, "uMpPage", 11, rh.page!!)
        bindTex(p, "uMpFar", 12, rh.far!!)
        u.f3(p, "uMpSeaFar", 0.05f, 0.13f, 0.27f); u.i4v(p, "uMpNz", a.nz, 28)
        u.f4v(p, "uMpYard", rh.yard, 21); u.f4v(p, "uMpYardT", rh.yardT, 21); u.f1(p, "uMpYardW", 1f)
        u.i4(p, "uMpLat", 16, 1, 16, 16)
        u.i4v(p, "uMpTerr4", rh.terr, 4); u.i4v(p, "uMpFam", rh.fam, 6); u.i1(p, "uMpObst", 0); u.i1(p, "uMpClr", 0); u.i4v(p, "uMpWang", ZERO24, 6)
        u.i4(p, "uMpOrder", 1, 0, 0, 0); u.i1(p, "uMpOrder5", 0); u.i2(p, "uMpWild", 0, 4); u.i2(p, "uMpField", 0, 0)
        u.f4(p, "uMpGrade", 1f, 1f, 1f, if (a.id == GroundPrograms.LAVA_REALM) 1f else 0f); u.f2(p, "uMpToneK", 1f, TONE_CHROMA.toFloat())
        u.f3v(p, "uMpFamK", ONES18, 6); u.f1(p, "uMpFamW", 1f)
        u.f3v(p, "uMpPal", HALF42, 14); u.f4v(p, "uMpWall", ZERO24F, 6); u.f4(p, "uMpDeedLine", 0.045f, 1f, 0f, 0f)
    }

    /** ground.js rhTrue: drawTrue's state over the rehearsal textures (gB and decals of the kinds this realm binds). */
    private fun rhTrue(p: Gl3Program, a: GroundAssets) {
        core.use(p)
        setFieldUniforms(p, a, rhGrid = true); setClassifyUniforms(p, a.cfg, 1.0)
        val t = a.trueAtlas
        bindTex(p, "uTgA", 0, gA ?: rh.kitLin!!); bindTex(p, "uTgB", 1, gB ?: (if (t?.hasB == true) rh.kitLin!! else core.dummy(integer = false, array = true)))
        bindTex(p, "uTgDecal", 2, gDecal ?: (if (t?.hasDecal == true) rh.near1!! else core.dummy(integer = false, array = true)))
        bindTex(p, "uTgMask", 3, gMask ?: rh.near1!!); bindTex(p, "uTgRec", 4, rh.rec!!); bindTex(p, "uTgDecalBox", 5, if (t?.hasDecal == true) rh.box!! else core.dummy(integer = false, array = false))
        bindTex(p, "uTgPage", 6, rh.page!!); bindTex(p, "uRmBase", 7, rh.base!!); bindTex(p, "uRmFieldsA", 8, rh.fA!!); bindTex(p, "uRmLineTex", 9, rh.lt!!); bindTex(p, "uRmFieldsBC", 10, rh.fBC!!)
        u.i4(p, "uTgWater", 1, 1, 200, 0); u.i4(p, "uTgWater2", 1, 1, 200, 0)
        u.f3v(p, "uTgPal", HALF12, 4); u.f4(p, "uTgOpt", 1f, 0f, 10f, 0f)
    }

    // =============================================================== lifecycle

    private fun restoreAfterLoss() {
        // every GL name died with the context: forget them (the core freed its tally); the next open() reloads from the
        // verified files (plan §5.7: re-decoded, never refetched)
        generation++; inbox.clear() // bump first: a worker racing its offer then takes it back ([publish])
        owned.clear(); resetGlState(); assets = null
    }

    private fun resetGlState() {
        fieldsA = null; fieldsBC = null; baseTex = null; farTex = null; lineTex = null; toneTex = null; plotsTex = null; mapKit = null; mapMask = null
        gA = null; gB = null; gMask = null; gDecal = null; gDecalBox = null; latArr = null; latSteps.fill(null); recArr = null; pageSteps.fill(null); pageTable = null
        progs = null; programList = emptyList(); rh.reset(); rehearsedBake.fill(false)
        stats.mapReady = false; stats.trueReady = false; stats.programsReady = false
    }

    private fun releaseAll() {
        generation++
        inbox.clear()
        for (t in owned) core.free(t)
        owned.clear()
        resetGlState()
        open = null
        assets = null; baseCpu = ByteArray(0); latDone = ByteArray(0); pageOfDeed = IntArray(0); deedOfLayer = IntArray(0); layerStamp = LongArray(0)
        baseBuf = ByteBuffer.allocateDirect(1); rowBuf = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder())
        baseJob = false; baseWork = null; baseWorkAt = 0; changedPlots.clear(); lineState = null; rivers = null; bridges = FloatArray(0); bridgeCount = 0
        stats.status = "none"; stats.hasTrue = false
    }

    companion object {
        /** ground.js LAT_PAGE: lattice pages are 1024² R8UI layers. */
        const val LAT_PAGE = 1024
        /** ground.js P0 fix pass #2/#3, W1 G5: the tone grade eases out over d TONE_START (BANDS.farEnd) → 80. */
        val TONE_START = Bands.FAR_END.toDouble()
        const val TONE_END = 80.0
        const val TONE_CHROMA = 0.06
        /** ground.js TRUE_THIN (W1 G5): Sunscar's obstacle slots ease toward the wild ground by d 800. */
        const val SUNSCAR_THIN = 0.63
        const val THIN_D0 = 450.0
        const val THIN_D1 = 800.0
        /** ground.js update(): GROUND's idle period is at most 125 ms (the cloud drift's art-px steps, ≈ 8 fps)… */
        const val IDLE_CAP_MS = 125
        /** …and 600 ms (the glint step, rmGlint's `rmMs() / 600`) when no TRUE water loop is on screen. */
        const val IDLE_DRIFT_MS = 600
        private val OWN = intArrayOf(RealmMapEngine.TARGET_OWN)
        private val ZERO14 = IntArray(14)
        private val ZERO24 = IntArray(24)
        private val ZERO24F = FloatArray(24)
        private val ONES18 = FloatArray(18) { 1f }
        private val HALF42 = FloatArray(42) { 0.5f }
        private val HALF12 = FloatArray(12) { 0.5f }

        /** V8's Math.log is fdlibm's: StrictMath, so band weights match the web to the bit. */
        fun ln(x: Double): Double = StrictMath.log(x)
    }
}

/** GROUND's CPU class inputs (contracts.GROUND_API `classState()`), for BASES' CPU class reads. */
class GroundClassState(val cls: Classify, val fields: Fields, val lines: Lines, val state: BaseState, val cfg: ClassCfg) {
    fun classAt(x: Double, y: Double): Int = cls.classAt(fields, lines, state, x, y, cfg)
}

/** ground.js rhTextures(): the rehearsal's own tiny textures (made once at load, so a rehearsal never uploads). */
class GroundRehearsal {
    var t8: Gl3Texture? = null; var t8a: Gl3Texture? = null; var trec: Gl3Texture? = null
    var lat: Gl3Texture? = null; var u8: Gl3Texture? = null; var base: Gl3Texture? = null; var fA: Gl3Texture? = null; var fBC: Gl3Texture? = null
    var lt: Gl3Texture? = null; var far: Gl3Texture? = null; var lin: Gl3Texture? = null; var kitLin: Gl3Texture? = null; var kitNear: Gl3Texture? = null
    var near1: Gl3Texture? = null; var box: Gl3Texture? = null; var rec: Gl3Texture? = null; var page: Gl3Texture? = null
    val yard = FloatArray(84); val yardT = FloatArray(84); val terr = IntArray(16); val fam = IntArray(24)
    var cx = 0f; var cy = 0f
    private var made = false

    private var allReady = false

    fun ready(core: Gl3Core): Boolean {
        if (allReady) return true
        allReady = made && arrayOf(t8, t8a, trec, lat, u8, base, fA, fBC, lt, far, lin, kitLin, kitNear, near1, box, rec, page).all { it?.ready == true }
        return allReady
    }

    fun reset() { made = false; allReady = false; t8 = null; t8a = null; trec = null; lat = null; u8 = null; base = null; fA = null; fBC = null; lt = null; far = null; lin = null; kitLin = null; kitNear = null; near1 = null; box = null; rec = null; page = null }

    fun create(core: Gl3Core, uploads: LaneUploads, owned: MutableList<Gl3Texture>, a: GroundAssets) {
        fun f(array: Boolean, w: Int, h: Int, layers: Int, fmt: Gl3Format, levels: Int, s: Gl3Sampling, bytes: ByteArray?): Gl3Texture? =
            uploads.fresh(core, Gl3Pool.CORE, array, w, h, layers, fmt, levels, s, Gl3Wrap.CLAMP) { _, level, ww, hh, out ->
                out.position(0); if (bytes != null && level == 0) out.put(bytes, 0, minOf(bytes.size, out.remaining())); out.position(0) }?.also { owned += it }
        val lt8 = ByteArray(256) { i -> (((if ((i and 3) == 3) Classes.FOREST else Classes.WILD) + 1) or 16 or 64 or (if (i and 1 != 0) 32 else 0)).toByte() }
        lat = f(true, 16, 16, 1, Gl3Format.R8UI, 1, Gl3Sampling.NEAREST, lt8)
        val u8b = ByteArray(16) { (Classes.WILD + 1).toByte() }; u8b[5] = (Classes.WATER + 1).toByte(); u8b[6] = (Classes.FOREST + 1).toByte()
        u8 = f(false, 4, 4, 1, Gl3Format.R8UI, 1, Gl3Sampling.NEAREST, u8b)
        t8 = f(false, 4, 4, 1, Gl3Format.R8UI, 1, Gl3Sampling.NEAREST, null)
        t8a = f(true, 4, 4, 1, Gl3Format.R8UI, 1, Gl3Sampling.NEAREST, null)
        trec = f(true, 4, 4, 1, Gl3Format.RGBA16UI, 1, Gl3Sampling.NEAREST, null)
        val rhL = 5
        val g = a.cls.plotGeom(rhL)
        base = f(false, 1, 1, 1, Gl3Format.RGBA8UI, 1, Gl3Sampling.NEAREST, byteArrayOf(Kind.OPEN.toByte(), Flag.OCCUPIED.toByte(), g.claim.toByte(), rhL.toByte()))
        fA = f(false, 2, 2, 1, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, ByteArray(16) { 150.toByte() })
        fBC = f(false, 2, 2, 1, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, ByteArray(16) { 200.toByte() })
        val ltw = IntArray(64); val w0 = ClassBake.pack2(40.0, 2.0); for (i in 0 until 56) ltw[i] = w0
        ltw[56] = 1 or (200 shl 16) or (128 shl 24); ltw[57] = 1; ltw[58] = ClassBake.packBridge(0.3, 30.0, 6.0, 1.0)
        lt = f(false, 8, 8, 1, Gl3Format.R32UI, 1, Gl3Sampling.NEAREST, ByteArray(256).also { ByteBuffer.wrap(it).order(ByteOrder.nativeOrder()).asIntBuffer().put(ltw) })
        far = f(false, 1, 1, 1, Gl3Format.R8, 1, Gl3Sampling.LINEAR, byteArrayOf(8))
        lin = f(false, 1, 1, 1, Gl3Format.RGBA8, 1, Gl3Sampling.LINEAR, byteArrayOf(128.toByte(), 128.toByte(), 128.toByte(), 255.toByte()))
        kitLin = f(true, 32, 32, 1, Gl3Format.RGBA8, 6, Gl3Sampling.LINEAR_MIPMAP_LINEAR, null)
        kitNear = f(true, 32, 32, 1, Gl3Format.RGBA8, 6, Gl3Sampling.NEAREST_MIPMAP_NEAREST, null)
        near1 = f(true, 1, 1, 1, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, null)
        box = f(false, 1, 1, 1, Gl3Format.RGBA8, 1, Gl3Sampling.NEAREST, byteArrayOf(0, 0, 31, 31))
        val recB = ByteArray(8).also { val s = ByteBuffer.wrap(it).order(ByteOrder.nativeOrder()).asShortBuffer(); s.put(0, 1); s.put(1, 257); s.put(2, 0); s.put(3, (Classes.SEA or (1 shl 6) or (1 shl 7)).toShort()) }
        rec = f(true, 1, 1, 1, Gl3Format.RGBA16UI, 1, Gl3Sampling.NEAREST, recB)
        page = f(false, 1, 1, 1, Gl3Format.R16UI, 1, Gl3Sampling.NEAREST, ByteArray(2).also { ByteBuffer.wrap(it).order(ByteOrder.nativeOrder()).putShort(0, 1) })
        yard[rhL * 4] = 0f; yard[rhL * 4 + 1] = 0f; yard[rhL * 4 + 2] = 1f; yard[rhL * 4 + 3] = 1f
        yardT[rhL * 4] = -1000f; yardT[rhL * 4 + 1] = -1000f; yardT[rhL * 4 + 2] = 5000f; yardT[rhL * 4 + 3] = 1f
        terr[Classes.FOREST] = 1; fam[4] = 4; fam[5] = 1
        val ox = a.cls.plots.offsetX(0, 0, rhL); val oy = a.cls.plots.offsetY(0, 0, rhL)
        cx = ((49 + ox + 0.5) / a.cls.tiles).toFloat(); cy = ((49 + oy + 0.5) / a.cls.tiles).toFloat()
        made = true
    }
}
