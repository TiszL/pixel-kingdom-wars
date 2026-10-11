package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.bases

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldEngineConstants
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3UniformBlock
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3VertexArray
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmBases
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmGrid
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmProgramSource
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.JsMath
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LanePack
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LaneUploads
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.LifeHash
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life.RealmClasses
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.RejectedExecutionException

/** The BANDS the BASES lane reads (contracts.js; presentation constants, from the generated table). */
class BasesBandsIn(
    val impostor0: Double, val impostor1: Double, val trueStart: Double, val trueFull: Double,
    val uiDots: Double, val uiIcons: Double, val keepMinCss: Double, val domeSilhouette: Double, val smoke: Double,
) {
    companion object {
        fun fromGenerated(): BasesBandsIn {
            val b = WorldEngineConstants.Bands
            return BasesBandsIn(b.IMPOSTOR[0].toDouble(), b.IMPOSTOR[1].toDouble(), b.TRUE_START.toDouble(), b.TRUE_FULL.toDouble(),
                b.UI_DOTS.toDouble(), b.UI_ICONS.toDouble(), b.KEEP_MIN_CSS.toDouble(), b.DOME_SILHOUETTE.toDouble(), b.SMOKE.toDouble())
        }
    }
}

/** The BASES lane's counters (bases.js `stats()`). */
class BasesStats {
    var why = "not loaded"
    var loaded = false
    var source = "none"
    var missing: List<String> = emptyList()
    var arrays = 0; var layers = 0; var sprites = 0; var gpuBytes = 0L
    var visible = 0; var keeps = 0; var icons = 0; var dots = 0; var minis = 0; var trues = 0; var domes = 0; var fx = 0; var groundCells = 0
    var paths = 0; var links = 0; var linksSettled = 0; var linksDropped = 0; var bridges = 0
    var pathsDone = false
    var updateMs = 0.0
    var draws = 0L; var rehearsalDraws = 0L
}

/** A growable float list reused across frames (bases.js `FL`): no per-frame garbage once grown. [ver] changes on [clear]. */
internal class FloatList(cap: Int = 1024) {
    var f = FloatArray(cap); var n = 0; var ver = 0
    fun clear() { n = 0; ver++ }
    fun room(m: Int) { if (n + m > f.size) f = f.copyOf(Math.max(f.size * 2, n + m)) }
    fun add(a: FloatArray) { if (a.isEmpty()) return; room(a.size); System.arraycopy(a, 0, f, n, a.size); n += a.size }
    fun put(v: Double) { f[n++] = v.toFloat() }
    fun toArray(): FloatArray = f.copyOf(n)
}

internal class IntList { var a = IntArray(4); var n = 0; fun add(v: Int) { if (n == a.size) a = a.copyOf(n * 2); a[n++] = v } }

/** Link ids per deed (bases.js `linkBuckets`, keyed y·65536 + x): an array over the grid (no boxing per frame), a map
 *  for the rare cell outside it. */
internal class Buckets(private val cols: Int, private val rows: Int) {
    private val cells = arrayOfNulls<IntList>(cols * rows)
    private val outside = HashMap<Long, IntList>()
    var empty = true; private set
    private fun key(x: Int, y: Int) = (y.toLong() shl 32) or (x.toLong() and 0xffffffffL)
    fun at(x: Int, y: Int): IntList? =
        if (x in 0 until cols && y in 0 until rows) cells[y * cols + x] else if (outside.isEmpty()) null else outside[key(x, y)]
    fun add(x: Int, y: Int, v: Int) {
        empty = false
        if (x in 0 until cols && y in 0 until rows) { val i = y * cols + x; (cells[i] ?: IntList().also { cells[i] = it }).add(v) }
        else outside.getOrPut(key(x, y)) { IntList() }.add(v)
    }
}

/**
 * The BASES lane of the realm map (web `bases.js`, pinned): every kingdom on its plot (at its hashed `plotOffset`),
 * drawn per base as an occupancy dot at FAR, a pixel-art marker icon (banners, companion towers from L12) or the live
 * keep with its decor at MAP/TRUE: organic clearings, farm fields, walls by level, the plot-edge autotile, the MAP
 * mini-sprites that dissolve into the TRUE sprites, smoke, pennants and hearth glow, the shield domes (capped: yours
 * first, then the nearest), the selection pulse, and the paths between neighbouring kingdoms settled over GROUND's
 * terrain with bridges and fords. Layouts come from [Decor] (golden-equal to the web); the bases from the engine's
 * [RealmBases] (the server feed; [DemoBases] only in the debug fallback). Nothing here decides who may be attacked.
 *
 * Band work (the path network, per-base decor caches, link settles) shares ONE per-frame CPU budget (`workMs`). Every
 * (program, state) pair of `BASES_GL` is rehearsed with the web's REHEARSAL resources from the moment the programs
 * exist, art or not. GL thread unless marked; the art builds on the realm's decode executor.
 *
 * Native divergence, [markers] false (owner 2026-09-26, D-NEXT, Seeker code 31: "current keep display is extra not
 * needed, on this range only player profile picture and name should be visible, in efficient way"). Where bases.js draws
 * its MAP marker (the castle icon, its banners and its companion towers), from `uiDots` until [BaseHandOver.drawsBase],
 * so until the kingdom's own live keep in its walls and fields, a kingdom here is bases.js's occupancy dot instead: the
 * same dot as the D-177 landing, one instanced draw for the realm. The HUD's name tag names it, but the tag cannot be its
 * only mark: the HUD places at most 16, drops any that collide or touch the controls, and names only the filtered
 * kingdoms (with the dot gone, all of those vanished). The hidden marker keeps the web's tap rect, a selection pulse
 * that rings the dot, and its shield dome (D-181). bases.js's own dithered dots below `uiIcons` stay exactly the web's
 * (dot and halo, no dome, no pulse). SHARDKEEP D-191 ([RealmBases.drawn]): a kingdom the active filter drops gets no
 * instance in any band, no dot, marker, keep, minis, emitters, tap rect or dome, only its claim's ground; bases.js's
 * `bakeDim` (the sprite flag's bit 0) is never fed. The selected kingdom always draws. The
 * web's `baseMode` still decides the hand-over, so each kingdom's own crossing between `IMPOSTOR[0]` and `IMPOSTOR[1]` is
 * unchanged. The icon array is never uploaded. [markers] true draws bases.js as pinned.
 */
class BasesLane(
    private val core: Gl3Core,
    private val t: DecorTables,
    private val decor: Decor,
    private val bands: BasesBandsIn,
    private val pack: LanePack,
    private val uploads: LaneUploads,
    private val classes: RealmClasses?,
    private val nowMs: BasesRules.MsClock = BasesRules.MsClock { System.nanoTime() / 1e6 },
    private val shaderSource: (WorldShaders.Stage) -> String = WorldShaders::source,
    private val markers: Boolean = false,
) : RealmLane {
    override val name = "bases"
    val stats = BasesStats()
    /** DEBUG FALLBACK ONLY ([DemoBases.snapshot]): seed kingdoms from their deed index like the web demo. Production
     *  seeds from the catalog tile id (stable across server snapshots). */
    var demoSeeds = false
    /** The shortest period the keeps' idle clips need on screen (bases.js `animating('bases', 83)`), 0 for none. */
    var animationPeriodMs = 0; private set
    /** The shield domes' pulse period (bases.js `animating('shield', 50)`), 0 for none. */
    var shieldPeriodMs = 0; private set
    /** This frame's selection pulse instance (bases.js `lists.select`: x, y, R, 0, 2, y, R, 0; empty with none). Tests only. */
    internal fun selectionRing(): FloatArray = lSelect.toArray()

    private val game = decor.game
    private val plots = decor.plots
    private val rules = BasesRules(t, bands.uiDots, bands.uiIcons, bands.keepMinCss, bands.impostor0, bands.impostor1)
    private val terrain = PathTerrainRules(t.pathTerrain, game.tilesPerDeed)
    private val tiles = game.tilesPerDeed.toDouble()
    private val deedArt = (game.tilesPerDeed * game.art).toFloat()
    private val mapArt = Math.round(t.mapPxPerTile * game.tilesPerDeed).toFloat()
    private val seatY = game.keepFootprint[1] / 2.0 + plots.plotCentre
    private val work = BasesRules.FrameWork(t.workMs, nowMs)
    // keepScale per level for the frame's d (pow per base per frame would allocate in the JVM's StrictMath port)
    private var ksD = Double.NaN; private var ksGen = 0
    private val ksStamp = IntArray(plots.maxLevel + 1); private val ksVal = DoubleArray(plots.maxLevel + 1)
    private val stField = t.basesGl.getValue("field"); private val stShieldBack = t.basesGl.getValue("shieldBack")
    private val stShieldFront = t.basesGl.getValue("shieldFront"); private val stSprite = t.basesGl.getValue("sprite")
    private val stSmoke = t.basesGl.getValue("smoke"); private val stPennant = t.basesGl.getValue("pennant")
    private val stGlow = t.basesGl.getValue("glow"); private val stDot = t.basesGl.getValue("dot")

    // ---- load. [generation] is read by the load job on its worker: a job whose generation is gone (a later open, a
    //      dispose) skips its remaining stages and never leaves its result in [inbox] (P0 2026-09-26: a result that arrived
    //      after dispose stayed in the host's still-reachable lane on the Seeker's 256 MB heap).
    @Volatile private var generation = -1
    private val inbox = ConcurrentLinkedQueue<Any>()
    private var loadDone = false
    private var wake: Runnable = Runnable {}
    private var realmId: String? = null
    private var grid: RealmGrid? = null
    private var sources: Map<String, RealmProgramSource>? = null
    private class Sources(val gen: Int, val src: Map<String, RealmProgramSource>)
    private class Built(val gen: Int, val build: BasesBuild?)
    private class Failed(val gen: Int, val why: String)

    // ---- programs, GL objects (VAOs and buffers are kept per context epoch and reused across realms)
    private var pSprite: Gl3Program? = null; private var pDot: Gl3Program? = null; private var pFx: Gl3Program? = null
    private var pShield: Gl3Program? = null; private var pField: Gl3Program? = null
    private var progList: List<Gl3Program> = emptyList()
    private class Slot(val vao: Gl3VertexArray, val buffer: Int, val floats: Int) { var list: FloatList? = null; var ver = -1; var n = 0 }
    private var glEpoch = -1
    private var quadBuf = 0
    private val spritePool = ArrayList<Slot>()
    private var dotSlot: Slot? = null; private var fxSlot: Slot? = null; private var shieldSlot: Slot? = null; private var fieldSlot: Slot? = null
    private var stage: FloatBuffer = ByteBuffer.allocateDirect(4096 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
    // the band rehearsal's own resources (bases.js makeRehearsal): view UBO on its own binding, instances, 2×2 array
    private var rhBlock: Gl3UniformBlock? = null
    private val rhSlots = HashMap<String, Slot>()
    private var rhTex: Gl3Texture? = null
    private val viewBlockIndex = HashMap<Gl3Program, Int>()

    // ---- the resident realm's art
    private var build: BasesBuild? = null
    private var ready = false
    private var catalog: Map<String, BasesCat> = emptyMap()
    private var arrayTex: Array<Gl3Texture?> = emptyArray()
    private var miniTex: Gl3Texture? = null; private var iconTex: Gl3Texture? = null; private var roadTex: Gl3Texture? = null
    private var roadN = 0
    private var hasBridge = false
    private var windX = 0.0
    private var keepCats: Array<BasesCat?> = emptyArray()
    private var smokeCat: BasesCat? = null

    // ---- the bases (a copy of the engine's geometry; ids and seeds derived once per change)
    private var bases: RealmBases? = null
    private var basesDirty = true
    private var nB = 0
    private var bx = IntArray(0); private var by = IntArray(0); private var blevel = IntArray(0)
    private var ids: Array<String> = emptyArray(); private var seeds = LongArray(0)
    private var looks: Array<IconLook?> = emptyArray(); private var towerCats: Array<BasesCat?> = emptyArray()
    private val instCache = HashMap<String, Static>()

    // ---- the paths between kingdoms
    private class Job(val gen: BasePathsJob, val buckets: Buckets) { var res: PathNetwork? = null; var i = 0; val linksOf = HashMap<String, IntList>() }
    private class Seat(val cat: BasesCat, val ax: Double, val ay: Double, val scale: Double, val x: Double, val y: Double, val z: Double, val h: Double)
    private class Settled(val inst: FloatArray, val bridges: Array<Seat>)
    private var paths: PathNetwork? = null
    private var job: Job? = null
    private var pathsDirty = true
    private var linkBuckets = Buckets(0, 0); private var linksOf = HashMap<String, IntList>()
    private var settledState = ByteArray(0) // 0 not yet, 1 settled, 2 dropped
    private var settled: Array<Settled?> = emptyArray()
    private var linkStamp = IntArray(0); private var frameNo = 0
    private var clsAt: ((Int, Int) -> Int)? = null
    private val clsMemo = HashMap<Long, Int>()
    private var terrainPending = false
    private var sidesChanged = false

    // ---- per-frame lists (bases.js `lists`), reused
    private val lDots = FloatList(); private val lMini = FloatList(); private val lIcons = FloatList(); private val lFx = FloatList()
    private val lGlow = FloatList(); private val lSelect = FloatList(); private val lShield = FloatList(); private val lGround = FloatList(8192)
    private var lSprites: Array<FloatList> = emptyArray(); private var lSmoke: Array<FloatList> = emptyArray()
    private var frameReady = false
    private var fTrueW = 0.0; private var fShieldLod = 0; private var fGroundFade = 0.0; private var lastD = 0.0
    private var keyValid = false
    private var kx = 0.0; private var ky = 0.0; private var ks = 0.0; private var kdpr = 0.0; private var kw = 0.0; private var kh = 0.0
    private var kState = -1; private var kReduced = false
    private var stateVersion = 0
    private var rects: Array<BasesRules.KeepRect> = emptyArray(); private var nRects = 0
    private var domes: Array<BasesRules.DomeHit> = emptyArray(); private var nDomes = 0
    private var shOrder = IntArray(0); private var shMine = BooleanArray(0); private var shDist = DoubleArray(0); private var shInst = DoubleArray(0)

    // ================================================================ RealmLane: load

    override fun open(realm: RealmOpen) {
        dispose()
        val gen = realm.generation; generation = gen; loadDone = false; stats.why = "loading"
        realmId = realm.realmId; grid = realm.grid; wake = realm.wake
        bases = realm.bases; basesDirty = true
        val have = sources
        try {
            realm.executor.execute {
                if (gen != generation) return@execute // superseded before it ran: nothing to load
                try {
                    val src = have ?: loadSources()
                    if (publish(gen, Sources(gen, src))) realm.wake.run() // the rehearsal needs no art (W1 B1)
                    if (gen == generation) {
                        val b = BasesLoad(t, decor, game).build(pack, realm.realmId) { gen == generation }
                        publish(gen, Built(gen, b))
                    }
                } catch (e: Exception) { publish(gen, Failed(gen, e.message ?: e.javaClass.simpleName)) }
                catch (e: OutOfMemoryError) { publish(gen, Failed(gen, "out of memory while loading BASES")) } // settles, never hangs the map
                if (gen == generation) realm.wake.run()
            }
        } catch (e: RejectedExecutionException) { loadDone = true; stats.why = "decode executor refused the load" }
    }

    /** Worker: hand [m] to the GL thread only while [gen] is current; a dispose racing the offer takes it back out. */
    private fun publish(gen: Int, m: Any): Boolean {
        if (gen != generation) return false
        inbox.offer(m)
        if (gen != generation) { inbox.remove(m); return false }
        return true
    }

    /** Worker: the five BASES stages, sha-checked by [WorldShaders.source]. */
    private fun loadSources(): Map<String, RealmProgramSource> {
        val out = LinkedHashMap<String, RealmProgramSource>()
        for (key in PROGRAM_KEYS) {
            val p = WorldShaders.realm[key] ?: error("world shader table has no $key")
            out[key] = RealmProgramSource(p.name, shaderSource(p.vs), shaderSource(p.fs), p.vs.sha256, p.fs.sha256)
        }
        return out
    }

    override fun programs(): List<Gl3Program> = progList
    override fun bandSet(): Int = if (ready) 2 else 0
    override fun settled(): Boolean = loadDone
    override fun basesChanged(bases: RealmBases) { this.bases = bases; basesDirty = true }

    /**
     * GL thread, a work frame: move a finished load into its programs and uploads (idempotent; never draws). The engine
     * calls it every work frame, also while the lane is held, so the arrays fill while the player looks at the overview;
     * [update] calls it first.
     */
    override fun adopt(nowMs: Double) {
        while (true) {
            when (val m = inbox.poll() ?: break) {
                is Failed -> if (m.gen == generation) { loadDone = true; stats.why = m.why }
                is Sources -> if (m.gen == generation) createPrograms(m.src)
                is Built -> if (m.gen == generation) create(m.build)
            }
        }
    }

    /** False while the rehearsal's placeholder array is still filling on the worker (try again, not a failed try); true
     *  once it is resident, or when there is none to wait for (refused: [rehearse] asks the pool again). */
    override fun rehearsable(program: Gl3Program): Boolean { val tx = rhTex; return tx == null || tx.ready }

    private fun createPrograms(src: Map<String, RealmProgramSource>) {
        sources = src
        fun prog(key: String) = src.getValue(key).let { core.program(it.name, it.vs, it.fs, it.vsSha256, it.fsSha256) }
        pSprite = prog(K_SPRITE); pShield = prog(K_SHIELD); pFx = prog(K_FX); pField = prog(K_FIELD); pDot = prog(K_DOT)
        progList = listOf(pSprite!!, pShield!!, pFx!!, pField!!, pDot!!) // contracts REHEARSE_ORDER
        ensureGl()
        makeRehearsal()
    }

    private fun create(b: BasesBuild?) {
        loadDone = true
        if (b == null) { stats.why = "no kit dressing for $realmId"; return }
        build = b; catalog = b.catalog
        var bytes = 0L; var layers = 0
        fun tex(a: BasesArrayBuild): Gl3Texture? {
            if (a.layers.isEmpty()) return null
            bytes += Gl3Format.RGBA8.layerBytes(a.lw, a.lh, a.levels) * a.layers.size; layers += a.layers.size
            // the fill's own snapshot of the layers: the build's list is cleared below, while the worker may not have
            // filled this texture yet (a fill that read the cleared list itself crashed the first prototype)
            val src = a.layers.toTypedArray()
            return uploads.fresh(core, Gl3Pool.REALM, true, a.lw, a.lh, src.size, Gl3Format.RGBA8, a.levels, Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP) { layer, level, _, _, out ->
                out.position(0); out.put(src[layer][level]); out.position(0)
            }
        }
        arrayTex = Array(b.arrays.size) { tex(b.arrays[it]) }
        miniTex = tex(b.mini); iconTex = if (markers) tex(b.icon) else null // D-NEXT: no marker icon is ever drawn
        roadTex = b.road?.let { tex(it) }; roadN = b.road?.layers?.size ?: 0
        // upload-only from here (P0 2026-09-26: 16.5 MB of mips per realm stayed on the heap for the whole visit): the
        // fills hold their snapshots until the worker has filled them; the draws read only the arrays' sizes, the catalog
        // and the counts; a context loss reloads from the pack files
        for (a in b.arrays) a.layers.clear()
        b.mini.layers.clear(); b.icon.layers.clear(); b.road?.layers?.clear()
        stats.gpuBytes = bytes; stats.layers = layers; stats.arrays = b.arrays.size; stats.sprites = b.catalog.size
        stats.missing = b.missing; stats.source = b.source
        hasBridge = decor.bridgePiece(b.realmId, "ew") != null && decor.bridgePiece(b.realmId, "ns") != null
        keepCats = Array(plots.maxLevel + 1) { if (it == 0) null else b.catalog["keep/l$it"] }
        smokeCat = b.catalog["kit:" + t.smokeIdOf(b.realmId)] // bases.js smokeIdOf: Solana's vapour_drift
        basesDirty = true // the marker looks' tower sprites resolve against this catalog
        windX = b.windX
        lSprites = Array(b.arrays.size) { FloatList(256) }; lSmoke = Array(b.arrays.size) { FloatList(64) }
        ensureGl()
        for (i in 0 until b.arrays.size + 2) spriteSlot(i)
        pathsDirty = true; job = null; instCache.clear(); frameReady = false; keyValid = false
        ready = true; stats.loaded = true
        stats.why = if (b.missing.isEmpty()) "ready" else "ready (${b.missing.size} missing)"
    }

    // ================================================================ GL objects

    private fun ensureGl() {
        if (glEpoch == core.epoch) return
        glEpoch = core.epoch
        quadBuf = 0; spritePool.clear(); dotSlot = null; fxSlot = null; shieldSlot = null; fieldSlot = null
        rhBlock = null; rhSlots.clear(); viewBlockIndex.clear()
    }

    private fun makeSlot(layout: Int, attribs: Int): Slot {
        val gl = core.gl
        if (quadBuf == 0) {
            quadBuf = gl.genBuffer(); gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quadBuf)
            gl.bufferData(GL20.GL_ARRAY_BUFFER, QUAD.capacity() * 4, QUAD, GL20.GL_STATIC_DRAW)
        }
        val buf = gl.genBuffer()
        val vao = core.vertexArray(layout)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, quadBuf); gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, GL20.GL_FLOAT, false, 0, 0)
        gl.bindBuffer(GL20.GL_ARRAY_BUFFER, buf)
        val stride = attribs * 16
        for (i in 0 until attribs) { gl.enableVertexAttribArray(1 + i); gl.vertexAttribPointer(1 + i, 4, GL20.GL_FLOAT, false, stride, i * 16); gl.vertexAttribDivisor(1 + i, 1) }
        core.bindVertexArray(null)
        return Slot(vao, buf, attribs * 4)
    }

    private fun spriteSlot(i: Int): Slot { while (spritePool.size <= i) spritePool += makeSlot(LAYOUT_4, 4); return spritePool[i] }
    private fun dot(): Slot = dotSlot ?: makeSlot(LAYOUT_3, 3).also { dotSlot = it }
    private fun fx(): Slot = fxSlot ?: makeSlot(LAYOUT_3, 3).also { fxSlot = it }
    private fun shield(): Slot = shieldSlot ?: makeSlot(LAYOUT_2, 2).also { shieldSlot = it }
    private fun field(): Slot = fieldSlot ?: makeSlot(LAYOUT_2, 2).also { fieldSlot = it }

    /** bases.js `makeRehearsal`: 112 B of view, ≤ 128 B of instances and 40 B of placeholder texels, made once. */
    private fun makeRehearsal() {
        val r = t.rehearsal
        if (rhBlock == null) {
            val b = core.uniformBlock(RH_BINDING, 112)
            for (i in r.view.indices) b.floats.put(i, r.view[i])
            for (i in r.view.size until 28) b.ints.put(i, 0) // uClock uvec4 0
            core.upload(b); rhBlock = b
        }
        if (rhSlots.isEmpty()) for ((name, f) in r.inst) {
            val attribs = r.attribs.getValue(name)
            val s = makeSlot(if (attribs == 4) LAYOUT_4 else if (attribs == 3) LAYOUT_3 else LAYOUT_2, attribs)
            val buf = ByteBuffer.allocateDirect(f.size * 4).order(ByteOrder.nativeOrder()).asFloatBuffer().put(f); buf.position(0)
            core.gl.bindBuffer(GL20.GL_ARRAY_BUFFER, s.buffer); core.gl.bufferData(GL20.GL_ARRAY_BUFFER, f.size * 4, buf, GL20.GL_STATIC_DRAW)
            s.n = f.size / s.floats
            rhSlots[name] = s
        }
        freshRehearsalTex()
    }

    /** REHEARSAL.tex: 2 layers of opaque-white 2×2 RGBA8 with their mips (retried from [rehearse] if the pool refused). */
    private fun freshRehearsalTex() {
        if (rhTex != null) return
        val r = t.rehearsal
        rhTex = uploads.fresh(core, Gl3Pool.REALM, true, r.texW, r.texH, r.texLayers, Gl3Format.RGBA8, r.texLevels,
            Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP) { _, _, w, h, out -> out.position(0); for (i in 0 until w * h * 4) out.put(255.toByte()); out.position(0) }
    }

    // ================================================================ bases and their static instances

    private fun syncBases() {
        basesDirty = false
        val b = bases ?: return
        val g = grid ?: return
        val n = b.size
        var geom = n != nB
        if (!geom) for (i in 0 until n) if (b.deedX[i] != bx[i] || b.deedY[i] != by[i] || b.level[i] != blevel[i]) { geom = true; break }
        if (geom) {
            nB = n; bx = b.deedX.copyOf(n); by = b.deedY.copyOf(n); blevel = b.level.copyOf(n)
            ids = Array(n) { val id = if (demoSeeds) by[it] * g.cols + bx[it] else g.tileId(bx[it], by[it]); id.toString() }
            seeds = LongArray(n) { decor.seedOf(ids[it].toDouble()) }
            instCache.clear(); pathsDirty = true
            looks = arrayOfNulls(n); towerCats = arrayOfNulls(n)
            if (rects.size < n) { rects = Array(n) { BasesRules.KeepRect() }; domes = Array(n) { BasesRules.DomeHit() } }
            if (shOrder.size < n) { shOrder = IntArray(n); shMine = BooleanArray(n); shDist = DoubleArray(n); shInst = DoubleArray(n * 8) }
        }
        // the marker look per base (level + seed only): computed once, never per frame
        if (looks.size != n) looks = arrayOfNulls(n)
        if (towerCats.size != n) towerCats = arrayOfNulls(n)
        for (i in 0 until n) if (looks[i] == null) {
            val look = rules.iconLook(blevel[i], seeds[i].toInt()); looks[i] = look
            towerCats[i] = if (look.towers != 0) look.tower?.let { catalog[it] } else null
        } else if (towerCats[i] == null && looks[i]!!.towers != 0) towerCats[i] = looks[i]!!.tower?.let { catalog[it] }
        stateVersion++
    }

    private fun hash01(a: Int, b: Int): Double = JsMath.u32(LifeHash.kitHash(a, b)) / 4294967296.0

    private class Em(val kind: String, val tx: Double, val ty: Double, val h: Double)
    private class Glow(val x: Double, val y: Double, val foot: Double, val r: Double, val a: Double, val h: Double)
    private class Static(val level: Int, val trueArr: IntArray, val trueF: Array<FloatArray>, val mini: FloatArray, val smoke: Array<Em>,
                         val glow: Array<Glow>, val keepEm: Array<Em>, val ground: FloatArray)
    private class Cell(val x: Int, val y: Int, val k: Int, val t: Int, val soft: Boolean)

    /** bases.js `baseStatic(b)`: everything about a base that does not depend on the camera, cached per base. */
    private fun baseStatic(i: Int): Static {
        val id = ids[i]
        instCache[id]?.let { if (it.level == blevel[i]) return it }
        val x = bx[i]; val y = by[i]; val level = blevel[i]; val sd = seeds[i].toInt()
        val linked: Collection<String> = paths?.sides?.get(id) ?: emptySet()
        val dec = decor.compose(level, realmId!!, seeds[i], linked)
        val ox = plots.offsetX(x, y, level).toDouble(); val oy = plots.offsetY(x, y, level).toDouble()
        val trues = LinkedHashMap<Int, FloatList>(); val mini = FloatList(256)
        var hi = 0
        val edgeList = if (catalog.containsKey("edge:post")) decor.edgeAutotileSprites(dec) else decor.edgeSprites(dec)
        for (list in arrayOf(dec.sprites, decor.wallSprites(dec), edgeList)) for (s in list) {
            val cat = catalog[s.key]; val h = hash01(sd, hi++)
            if (cat == null) continue
            val k = s.scale; val qx0 = (cat.ox - s.anchor[0]) * k; val qy0 = (cat.oy - s.anchor[1]) * k
            val l = trues.getOrPut(cat.arr) { FloatList(256) }; l.room(16)
            l.put(x + (s.tx + ox) / tiles); l.put(y + (s.ty + oy) / tiles); l.put(y + (s.z + oy) / tiles); l.put(h)
            l.put(qx0); l.put(qy0); l.put(qx0 + cat.tw * k); l.put(qy0 + cat.th * k)
            l.put(cat.layer0.toDouble()); l.put(if (s.clip) cat.frames.toDouble() else 1.0); l.put(if (s.clip) s.clipMs.toDouble() else 0.0); l.put(s.phase.toDouble())
            l.put(cat.tw.toDouble() / cat.lw); l.put(cat.th.toDouble() / cat.lh); l.put(0.0); l.put(0.0)
            // MAP minis: hedges, fences, walls (never hidden) and buildings (grow to the 6-px floor); not the wild specks
            val m = cat.mini
            if (m != null && !(s.role != null && t.speckRoles.contains(s.role))) {
                val mk = m.k; val mx = (m.ox - m.ax) * mk; val my = (m.oy - m.ay) * mk
                val flag = if (s.kind == "wall") 4.0 else if (s.kind == "building") 2.0 else 0.0
                mini.room(16)
                mini.put(x + (s.tx + ox) / tiles); mini.put(y + (s.ty + oy) / tiles); mini.put(y + (s.z + oy) / tiles); mini.put(h)
                mini.put(mx); mini.put(my); mini.put(mx + m.w * mk); mini.put(my + m.h * mk)
                mini.put(m.idx.toDouble()); mini.put(1.0); mini.put(0.0); mini.put(0.0)
                mini.put(m.w.toDouble() / t.mini); mini.put(m.h.toDouble() / t.mini); mini.put(1.0); mini.put(flag)
            }
        }
        val smoke = ArrayList<Em>(); val glow = ArrayList<Glow>(); val keepEm = ArrayList<Em>()
        for (e in dec.emitters) {
            if (e.kind == "glow") glow += Glow(x + (e.tx + ox) / tiles, y + (e.ty + oy) / tiles, y + (e.ty + oy + 0.6) / tiles, e.r ?: Double.NaN, e.a ?: Double.NaN, hash01(sd, hi++))
            else if (e.kind == "smoke" && smokeCat != null) {
                if (e.attach == "keep") keepEm += Em("smoke", e.tx, e.ty, hash01(sd, hi++)) else smoke += Em("smoke", e.tx + ox, e.ty + oy, hash01(sd, hi++))
            } else if (e.kind == "pennant") keepEm += Em("pennant", e.tx, e.ty, hash01(sd, hi++))
        }
        // tended ground: field soil, pen / camp earth and the linked sides' lanes, one cell instance per tile
        val tl = game.tilesPerDeed
        val cells = LinkedHashMap<Int, Cell>()
        for (lane in dec.lanes.values) for (c in lane) cells[c[1] * tl + c[0]] = Cell(c[0], c[1], 2, 0, false)
        for (g in dec.ground) cells[g.y * tl + g.x] = Cell(g.x, g.y, g.k, g.t, (g.k == 0 && dec.patches.getOrNull(g.p)?.hedged != true) || (g.k == 1 && g.t == 1))
        // every concave corner of a soft patch gets a fillet in the empty cell beside it (mask bits 16 NE, 32 SE, 64 SW, 128 NW)
        val fil = LinkedHashMap<Int, IntArray>()
        for ((key, c) in cells) {
            if (!c.soft) continue
            for (e in intArrayOf(key - tl, key + 1, key + tl, key - 1)) {
                if (cells.containsKey(e) || fil.containsKey(e)) continue
                val ex = e % tl; val ey = e / tl
                val n = at(cells, e - tl, c); val ea = at(cells, e + 1, c); val s = at(cells, e + tl, c); val w = at(cells, e - 1, c)
                val m = (if (n && ea) 16 else 0) or (if (s && ea) 32 else 0) or (if (s && w) 64 else 0) or (if (n && w) 128 else 0)
                if (m != 0) fil[e] = intArrayOf(ex, ey, c.k, c.t, m)
            }
        }
        val gc = FloatArray((cells.size + fil.size) * 8); val sdg = hash01(sd, 77); val wd = 0.5 / tiles; var n = 0
        fun put8(a: Double, b: Double, c: Double, d: Double, e: Double, f: Double) {
            gc[n] = a.toFloat(); gc[n + 1] = b.toFloat(); gc[n + 2] = c.toFloat(); gc[n + 3] = d.toFloat(); gc[n + 4] = e.toFloat(); gc[n + 5] = f.toFloat()
            gc[n + 6] = sdg.toFloat(); gc[n + 7] = 1f; n += 8
        }
        for ((key, c) in cells) {
            val m = (if (cells[key - tl]?.k == c.k) 1 else 0) or (if (cells[key + 1]?.k == c.k) 2 else 0) or (if (cells[key + tl]?.k == c.k) 4 else 0) or (if (cells[key - 1]?.k == c.k) 8 else 0)
            val x0 = x + (c.x + ox) / tiles; val y0 = y + (c.y + oy) / tiles
            put8(x0, y0, x0 + 1 / tiles, y0 + 1 / tiles, (c.k + 4 * c.t).toDouble(), m.toDouble())
        }
        for (f in fil.values) { // after the cells: a fillet covers its neighbours' rim at the corner
            val x0 = x + (f[0] + ox) / tiles; val y0 = y + (f[1] + oy) / tiles
            put8(x0 - wd, y0 - wd, x0 + 1 / tiles + wd, y0 + 1 / tiles + wd, (f[2] + 4 * f[3]).toDouble(), f[4].toDouble())
        }
        val keys = trues.keys.toIntArray()
        val st = Static(level, keys, Array(keys.size) { trues.getValue(keys[it]).toArray() }, mini.toArray(), smoke.toTypedArray(), glow.toTypedArray(), keepEm.toTypedArray(), gc)
        instCache[id] = st
        return st
    }

    private fun at(cells: Map<Int, Cell>, kk: Int, c: Cell): Boolean { val o = cells[kk] ?: return false; return o.soft && o.k == c.k && o.t == c.t }

    // ================================================================ the paths job

    private fun startPaths() {
        pathsDirty = false
        val list = ArrayList<PathBase>(nB)
        for (i in 0 until nB) list += PathBase(ids[i], seeds[i], bx[i], by[i], blevel[i])
        val g = grid!!
        job = Job(BasePathsJob(list, plots, t.paths, game.tilesPerDeed), Buckets(g.cols, g.rows))
        stats.pathsDone = false
    }

    private fun pumpPaths() {
        val j = job ?: return
        while (job === j && work.more()) {
            work.spend()
            val res = j.res
            if (res == null) { if (j.gen.step()) j.res = j.gen.result }
            else if (j.i < res.links.size) bucketLink(j, j.i++)
            else finishPaths(j)
        }
    }

    private fun bucketLink(j: Job, i: Int) {
        val l = j.res!!.links[i]
        j.linksOf.getOrPut(l.a) { IntList() }.add(i); j.linksOf.getOrPut(l.b) { IntList() }.add(i)
        var x0 = Double.POSITIVE_INFINITY; var x1 = Double.NEGATIVE_INFINITY; var y0 = Double.POSITIVE_INFINITY; var y1 = Double.NEGATIVE_INFINITY
        for (p in l.pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]) }
        for (y in Math.floor(y0).toInt()..Math.floor(y1).toInt()) for (x in Math.floor(x0).toInt()..Math.floor(x1).toInt())
            j.buckets.add(x, y, i)
    }

    private fun finishPaths(j: Job) {
        val prev: Map<String, Set<String>> = paths?.sides ?: emptyMap()
        val res = j.res!!
        job = null; paths = res; linkBuckets = j.buckets; linksOf = j.linksOf
        linkStamp = IntArray(res.links.size)
        stats.paths = res.segments.size; stats.links = res.links.size; stats.pathsDone = true
        settleOver(classes?.classAt())
        // the per-base caches depend on the laned sides only: keep them when a rebuild left the sides alone
        val same = prev.size == res.sides.size && res.sides.all { (id, sd) -> val o = prev[id]; o != null && o.size == sd.size && sd.all { o.contains(it) } }
        if (!same) instCache.clear()
        keyValid = false; wake.run()
    }

    /** bases.js `settleOver`: links settle lazily over GROUND's CPU classes (memoised per tile) once GROUND has them. */
    private fun settleOver(cls: ((Int, Int) -> Int)?) {
        val n = paths?.links?.size ?: 0
        clsMemo.clear(); settledState = ByteArray(n); settled = arrayOfNulls(n)
        clsAt = if (cls == null) null else { x, y -> val k = y * 1_000_000L + x; clsMemo[k] ?: cls(x, y).also { clsMemo[k] = it } }
        terrainPending = clsAt == null
        stats.linksSettled = 0; stats.linksDropped = 0; stats.bridges = 0
    }

    /** bases.js `settleLink(i)`: one link over terrain → its path cells and bridge seats, or null (dropped). */
    private fun settleLink(i: Int): Settled? {
        val l = paths!!.links[i]
        val r = terrain.settle(l.pts, clsAt!!, hasBridge)
        stats.linksSettled++
        if (r == null) { stats.linksDropped++; dropSides(i); return null }
        val seats = ArrayList<Seat>()
        for (cr in r.crossings) if (cr.kind == "bridge") {
            val piece = decor.bridgePiece(realmId!!, cr.axis) ?: continue
            for (seat in terrain.bridgeSeats(cr, piece)) {
                val cat = catalog[piece.key] ?: continue
                val bx0 = seat[0] / tiles; val by0 = seat[1] / tiles
                seats += Seat(cat, piece.anchor[0], piece.anchor[1], piece.scale, bx0, by0, seat[2] / tiles, hash01(i, JsMath.toInt32(bx0 * 977 + by0)))
            }
            stats.bridges++
        }
        val inst = FloatArray(r.segments.size * 8)
        for ((k, sg) in r.segments.withIndex()) {
            val o = k * 8
            inst[o] = sg.ax.toFloat(); inst[o + 1] = sg.ay.toFloat(); inst[o + 2] = sg.bx.toFloat(); inst[o + 3] = sg.by.toFloat()
            inst[o + 4] = 3f; inst[o + 5] = if (sg.bridge) 2f else if (sg.ford) 1f else 0f; inst[o + 6] = l.seed.toFloat(); inst[o + 7] = 1f
        }
        return Settled(inst, seats.toTypedArray())
    }

    /** bases.js `dropSides`: a dropped link takes its lanes with it unless another live link leaves by the same side. */
    private fun dropSides(i: Int) {
        val p = paths ?: return
        val l = p.links[i]
        for (k in 0..1) {
            val id = if (k == 0) l.a else l.b; val sd = if (k == 0) l.sa else l.sb
            var live = false
            val ls = linksOf[id]
            if (ls != null) for (q in 0 until ls.n) {
                val jx = ls.a[q]; if (jx == i || settledState[jx].toInt() == 2) continue
                val lj = p.links[jx]
                if ((if (lj.a == id) lj.sa else lj.sb) == sd) { live = true; break }
            }
            if (live || p.sides[id]?.remove(sd) != true) continue
            instCache.remove(id)
            sidesChanged = true
        }
    }

    // ================================================================ per frame

    override fun update(view: RealmView) {
        if (view.workAllowed) adopt(nowMs.now())
        if (basesDirty) syncBases()
        val t0 = nowMs.now()
        updateInner(view)
        stats.updateMs = nowMs.now() - t0
    }

    private fun updateInner(view: RealmView) {
        lastD = view.d
        if (!ready || nB == 0) { nRects = 0; nDomes = 0; frameReady = false; animationPeriodMs = 0; shieldPeriodMs = 0; return }
        val s = view.s; val d = view.d; val dpr = view.dpr
        val pathBand = d >= bands.impostor0 - 50
        work.begin() // the paths job, decor caches and link settles share ONE budget
        if (pathsDirty) startPaths()
        if (job != null) { pumpPaths(); if (job != null && pathBand) wake.run() }
        if (terrainPending && job == null) { val c = classes?.classAt(); if (c != null) { settleOver(c); keyValid = false } }
        if (keyValid && frameReady && view.x == kx && view.y == ky && s == ks && dpr == kdpr && view.viewW == kw && view.viewH == kh &&
            stateVersion == kState && view.reducedMotion == kReduced) return // idle animation frames: only the clock moved
        keyValid = true; kx = view.x; ky = view.y; ks = s; kdpr = dpr; kw = view.viewW; kh = view.viewH; kState = stateVersion; kReduced = view.reducedMotion
        val b = bases!!
        val trueW = JsMath.clamp((d - bands.trueStart) / (bands.trueFull - bands.trueStart), 0.0, 1.0)
        val pad = 1.0
        lDots.clear(); lMini.clear(); lIcons.clear(); lFx.clear(); lGlow.clear(); lSelect.clear(); lShield.clear(); lGround.clear()
        for (l in lSprites) l.clear(); for (l in lSmoke) l.clear()
        nRects = 0; nDomes = 0
        var nSh = 0
        val k = s / tiles // CSS px per tile
        val shieldLod = if (d >= bands.trueFull) 2 else if (s >= bands.domeSilhouette) 1 else 0
        var nKeep = 0; var nIcon = 0; var keepVis = false; var nMini = 0; var nTrue = 0; var pending = false; var visible = 0
        val lanesKnown = job == null && !pathsDirty // a base's decor lanes follow its links: build it once they exist
        val sel = if (b.size == nB) b.selectedBase else -1
        for (i in 0 until nB) {
            val x = bx[i]; val y = by[i]
            if (!(x >= view.rectX0 - pad && x < view.rectX1 + pad && y >= view.rectY0 - pad && y < view.rectY1 + pad)) continue
            visible++
            val flags = if (i < b.size) b.flags[i] else 0
            val mine = flags and RealmBases.FLAG_MINE != 0; val shielded = flags and RealmBases.FLAG_SHIELD != 0
            val hide = i < b.size && !b.drawn(i); val isSel = i == sel // D-191: a filtered-out kingdom draws nothing
            val level = blevel[i]; val seed = seeds[i]; val sd = seed.toInt()
            val ox = plots.offsetX(x, y, level); val oy = plots.offsetY(x, y, level)
            val cx = x + (plots.plotCentre + ox).toDouble() / tiles; val cy = y + (seatY + oy) / tiles
            val pcx = cx; val pcy = y + (plots.plotCentre + oy).toDouble() / tiles
            val mode = rules.baseMode(s, d, hash01(sd, 7), hash01(sd, 8))
            val hidden = !markers && mode == BasesRules.ICON // D-NEXT: the kingdom's dot where bases.js draws its castle marker
            if (mode == BasesRules.DOT || hidden) { // FAR: occupancy dot (+ halo), a quiet grain at the far overview
                if (!hide) {
                    val size = if (mine) JsMath.clamp(s * 0.45, 4.0, 6.0) else JsMath.clamp(s * 0.25, 2.0, 4.0)
                    lDots.room(12)
                    lDots.put(pcx); lDots.put(pcy); lDots.put(size); lDots.put(0.0)
                    if (mine) { lDots.put(t.gold[0]); lDots.put(t.gold[1]); lDots.put(t.gold[2]) } else { lDots.put(0.96); lDots.put(0.95); lDots.put(0.9) }
                    lDots.put(if (shielded) 1.0 else 0.0); lDots.put(if (mine) 1.0 else 0.85); lDots.put(0.0); lDots.put(0.0); lDots.put(0.0)
                }
                if (!hidden) continue
            }
            val cat = keepCats[level] ?: continue
            val live = mode == BasesRules.KEEP
            var footY = cy // the drawn keep's foot: the seat, or the marker icon's anchor (bases.js footY)
            if (!live) { // marker icon: ≥ 28 CSS px wide (by level + seed), centred on its plot (stage B iconAnchorY)
                if (hide) continue // D-191: no marker, tap rect or dome; the deed stays occupied for the core's pick
                val ic = cat.icon ?: continue
                val look = looks[i]!!; val css = look.css; val kk = css / ic.w / k // tiles per icon px
                val qx0 = (ic.ox - ic.ax) * kk; val qy0 = (ic.oy - ic.ay) * kk
                val iy = y + (rules.iconAnchorY(d, qy0 + ic.h * kk / 2, plots.plotCentre.toDouble(), seatY) + oy) / tiles // the icon group's anchor (bases.js shadows cy)
                footY = if (hidden) pcy else iy // D-NEXT: the pulse rings what is drawn, the kingdom's dot
                rect(i, cx, iy, view, k, qx0, qy0, qx0 + ic.w * kk, qy0 + ic.h * kk) // D-NEXT: still the tap target when hidden
                if (markers) {
                    put16(lIcons, cx, iy, iy, hash01(sd, 3), qx0, qy0, qx0 + ic.w * kk, qy0 + ic.h * kk, ic.idx.toDouble(), 1.0, 0.0, 0.0,
                        ic.w / ICON, ic.h / ICON, 3.0, 0.0)
                    nIcon++
                    // heraldic banners on the icon's spires (the base's own colour, gold for yours)
                    val tips = t.keepTips[level - 1]; val pw = Math.max(6.0, css * 0.26) / k; val ph = pw * 4 / 6
                    val col = colorOf(mine, sd)
                    for (ti in look.tips) {
                        val tx = tips[ti][0]; val ty = tips[ti][1]
                        put12(lFx, cx + (tx / 2.0 - ic.ax) * kk / tiles, iy + (ty / 2.0 - ic.ay) * kk / tiles, iy + 0.0002 / tiles, hash01(sd, 13 + ti), pw, ph, 1.0, 0.0,
                            col[0], col[1], col[2], 1.0)
                    }
                    // L12+: flanking defence towers behind the keep (count by level, type, side, height and set-back by seed)
                    val nT = look.towers; val tc = towerCats[i]
                    if (tc != null) {
                        val icW = ic.w * kk; val icH = ic.h * kk; val first = look.first
                        for (jt in 0 until nT) {
                            val kt = icH * (if (jt == 2) 0.7 else 0.58 + 0.2 * hash01(sd, 17 + jt)) / tc.th
                            val dx = if (jt == 2) (hash01(sd, 20) - 0.5) * icW * 0.3 else (if (jt == 0) first else -first) * icW * (0.56 + 0.14 * hash01(sd, 18 + jt))
                            val dy = if (jt == 2) -icH * 0.45 else -icH * (0.04 + 0.1 * hash01(sd, 19 + jt))
                            val tx = cx + dx / tiles; val ty = iy + dy / tiles
                            val tq0 = (tc.ox - tc.anchorX) * kt; val tq1 = (tc.oy - tc.anchorY) * kt
                            put16(lSprites[tc.arr], tx, ty, ty, hash01(sd, 21 + jt), tq0, tq1, tq0 + tc.tw * kt, tq1 + tc.th * kt, tc.layer0.toDouble(), 1.0, 0.0, 0.0,
                                tc.tw.toDouble() / tc.lw, tc.th.toDouble() / tc.lh, 3.0, 0.0)
                        }
                    }
                }
            } else { // live keep at true × keepScale (plan §6.7)
                val sc = keepScale(level, d); val kk = cat.scale * sc
                val qx0 = (cat.ox - cat.anchorX) * kk; val qy0 = (cat.oy - cat.anchorY) * kk
                if (!hide) {
                    put16(lSprites[cat.arr], cx, cy, cy, hash01(sd, 4), qx0, qy0, qx0 + cat.tw * kk, qy0 + cat.th * kk, cat.layer0.toDouble(), cat.frames.toDouble(),
                        KEEP_FRAME_MS, (JsMath.u32L(LifeHash.kitHash(sd, 5)) % 3).toDouble(), cat.tw.toDouble() / cat.lw, cat.th.toDouble() / cat.lh, 2.0, 0.0)
                    rect(i, cx, cy, view, k, qx0, qy0, qx0 + cat.tw * kk, qy0 + cat.th * kk)
                    nKeep++; keepVis = true
                }
                val id = ids[i]; val cached = instCache[id]; val fresh = cached != null && cached.level == level
                // new caches under the frame budget; a base still waiting keeps its keep, dome and selection ring meanwhile
                if (!fresh && !(lanesKnown && work.more())) pending = true
                else {
                    if (!fresh) work.spend()
                    val st0 = baseStatic(i)
                    lGround.add(st0.ground) // D-191: a filtered-out kingdom keeps its claim's ground, an occupied plot
                    if (hide) continue
                    if (trueW < 1) { lMini.add(st0.mini); nMini += st0.mini.size / 16 }
                    if (trueW > 0) for (a in st0.trueArr.indices) { lSprites[st0.trueArr[a]].add(st0.trueF[a]); nTrue += st0.trueF[a].size / 16 }
                    val keepPx = cat.tw * kk * k * dpr // keep-attached emitters scale about the keep seat
                    for (e in st0.keepEm) {
                        val ex = cx + (e.tx - plots.plotCentre) * sc / tiles; val ey = cy + (e.ty - seatY) * sc / tiles
                        if (e.kind == "pennant" && keepPx >= 20) {
                            val pw = Math.max(6 * cat.scale * sc, 5 / k / dpr); val ph = pw * 4 / 6; val col = colorOf(mine, sd)
                            put12(lFx, ex, ey, cy + 0.0001 / tiles, e.h, pw, ph, 1.0, 0.0, col[0], col[1], col[2], 1.0)
                        } else if (e.kind == "smoke" && s >= bands.smoke) pushSmoke(ex, ey, cy, e.h)
                    }
                    if (s >= bands.smoke) for (e in st0.smoke) pushSmoke(x + e.tx / tiles, y + e.ty / tiles, y + (e.ty + 1) / tiles, e.h)
                    if (trueW > 0) for (g in st0.glow) put12(lGlow, g.x, g.y, g.foot, g.h, g.r * 2, g.r * 2, 0.0, 0.05, 1.0, 0.72, 0.35, g.a * trueW)
                }
            }
            if (shielded && !hide) { // the magical transparent dome over the claim (D-191: none over a filtered-out kingdom)
                val sz = plots.rule(level).claim; val rx = sz / 2.0 + 2
                shOrder[nSh] = nSh; shMine[nSh] = mine; shDist[nSh] = JsMath.hypot(pcx - view.x, pcy - view.y)
                val o = nSh * 8
                shInst[o] = pcx; shInst[o + 1] = pcy; shInst[o + 2] = rx; shInst[o + 3] = hash01(sd, 6)
                shInst[o + 4] = ((if (mine) 1 else 0) or (if (isSel) 2 else 0)).toDouble(); shInst[o + 5] = pcy + (sz / 2.0) / tiles; shInst[o + 6] = 0.0; shInst[o + 7] = 0.0
                nSh++
                val h = domes[nDomes++]; h.base = i; h.sx = (pcx - view.x) * s + view.viewW / 2; h.sy = (pcy - view.y) * s + view.viewH / 2; h.rx = rx * k; h.ry = rx * 0.55 * k
            }
            if (isSel && s >= bands.uiDots) {
                val r = (cat.tw * cat.scale * (if (live) keepScale(level, d) else 1.0)) * 0.75 + 0.6
                lSelect.room(8); lSelect.put(cx); lSelect.put(footY); lSelect.put(r); lSelect.put(0.0); lSelect.put(2.0); lSelect.put(footY); lSelect.put(r); lSelect.put(0.0)
            }
        }
        // paths between kingdoms: from the impostor band on, culled to the view (no terrain yet: no paths)
        val cls = clsAt
        if (d >= bands.impostor0 - 50 && !linkBuckets.empty && cls != null) {
            frameNo++
            for (y in Math.floor(view.rectY0).toInt() - 1..Math.floor(view.rectY1).toInt() + 1) for (x in Math.floor(view.rectX0).toInt() - 1..Math.floor(view.rectX1).toInt() + 1) {
                val bucket = linkBuckets.at(x, y) ?: continue
                for (q in 0 until bucket.n) {
                    val li = bucket.a[q]
                    if (linkStamp[li] == frameNo) continue
                    linkStamp[li] = frameNo
                    if (settledState[li].toInt() == 0) {
                        if (!work.more()) { pending = true; continue }
                        work.spend(); val r = settleLink(li); settled[li] = r; settledState[li] = if (r == null) 2 else 1
                    }
                    val p = settled[li] ?: continue
                    lGround.add(p.inst)
                    for (br in p.bridges) { // the crossing's kit bridge pieces: TRUE sprite + MAP mini, like decor
                        val c = br.cat; val kk = br.scale; val qx0 = (c.ox - br.ax) * kk; val qy0 = (c.oy - br.ay) * kk
                        if (trueW > 0) put16(lSprites[c.arr], br.x, br.y, br.z, br.h, qx0, qy0, qx0 + c.tw * kk, qy0 + c.th * kk, c.layer0.toDouble(), 1.0, 0.0, 0.0,
                            c.tw.toDouble() / c.lw, c.th.toDouble() / c.lh, 0.0, 0.0)
                        val m = c.mini
                        if (trueW < 1 && m != null) {
                            val mk = m.k; val mx = (m.ox - m.ax) * mk; val my = (m.oy - m.ay) * mk
                            put16(lMini, br.x, br.y, br.z, br.h, mx, my, mx + m.w * mk, my + m.h * mk, m.idx.toDouble(), 1.0, 0.0, 0.0,
                                m.w.toDouble() / t.mini, m.h.toDouble() / t.mini, 1.0, 0.0)
                        }
                    }
                }
            }
        }
        // shield caps (plan §6.5): ≤ mapCap on screen at MAP, ≤ trueCap at TRUE — yours first, then the nearest
        if (sidesChanged) { sidesChanged = false; pending = true } // a dropped link changed some bases' lanes: redraw them
        val shown = rules.capShields(shOrder, nSh, shMine, shDist, shieldLod)
        lShield.room(shown * 8)
        for (q in 0 until shown) { val o = shOrder[q] * 8; for (c in 0 until 8) lShield.put(shInst[o + c]) }
        stats.visible = visible; stats.groundCells = lGround.n / 8; stats.fx = lFx.n / 12; stats.domes = shown; stats.keeps = nKeep; stats.icons = nIcon
        stats.dots = lDots.n / 12; stats.minis = nMini; stats.trues = nTrue
        fTrueW = trueW; fShieldLod = shieldLod; fGroundFade = JsMath.clamp((d - (bands.impostor0 - 50)) / 100, 0.0, 1.0)
        frameReady = true
        if (pending) { keyValid = false; wake.run() } // finish the remaining bases on the next frames
        animationPeriodMs = if (keepVis && !view.reducedMotion) KEEP_FRAME_MS.toInt() else 0
        shieldPeriodMs = if (shown > 0 && !view.reducedMotion) SHIELD_MS else 0
    }

    private fun keepScale(level: Int, d: Double): Double {
        if (d != ksD) { ksD = d; ksGen++ }
        if (ksStamp[level] != ksGen) { ksVal[level] = decor.keepScale(level, d); ksStamp[level] = ksGen }
        return ksVal[level]
    }

    private fun rect(i: Int, cx: Double, cy: Double, view: RealmView, k: Double, qx0: Double, qy0: Double, qx1: Double, qy1: Double) {
        val sx = (cx - view.x) * view.s + view.viewW / 2; val sy = (cy - view.y) * view.s + view.viewH / 2
        val r = rects[nRects++]; r.base = i; r.x0 = sx + qx0 * k; r.x1 = sx + qx1 * k; r.y0 = sy + qy0 * k; r.y1 = sy + qy1 * k; r.depth = cy
    }

    private fun colorOf(mine: Boolean, sd: Int): DoubleArray =
        if (mine) t.gold else t.heraldic[(JsMath.u32L(LifeHash.kitHash(sd, 99)) % t.heraldic.size).toInt()]

    private fun pushSmoke(x: Double, y: Double, foot: Double, h: Double) {
        val cat = smokeCat ?: return
        val kk = cat.scale; val qx0 = (cat.ox - cat.anchorX) * kk; val qy0 = (cat.oy - cat.anchorY) * kk; val l = lSmoke[cat.arr]
        for (i in 0..1) put16(l, x, y, foot, h, qx0, qy0, qx0 + cat.tw * kk, qy0 + cat.th * kk, cat.layer0.toDouble(), cat.frames.toDouble(), SMOKE_FRAME_MS,
            (h * 7 + i * 0.5) % 1, cat.tw.toDouble() / cat.lw, cat.th.toDouble() / cat.lh, 4.0, 0.0)
    }

    private fun put16(l: FloatList, a0: Double, a1: Double, a2: Double, a3: Double, a4: Double, a5: Double, a6: Double, a7: Double,
                      a8: Double, a9: Double, a10: Double, a11: Double, a12: Double, a13: Double, a14: Double, a15: Double) {
        l.room(16)
        l.put(a0); l.put(a1); l.put(a2); l.put(a3); l.put(a4); l.put(a5); l.put(a6); l.put(a7)
        l.put(a8); l.put(a9); l.put(a10); l.put(a11); l.put(a12); l.put(a13); l.put(a14); l.put(a15)
    }
    private fun put12(l: FloatList, a0: Double, a1: Double, a2: Double, a3: Double, a4: Double, a5: Double, a6: Double, a7: Double,
                      a8: Double, a9: Double, a10: Double, a11: Double) {
        l.room(12)
        l.put(a0); l.put(a1); l.put(a2); l.put(a3); l.put(a4); l.put(a5); l.put(a6); l.put(a7); l.put(a8); l.put(a9); l.put(a10); l.put(a11)
    }

    // ================================================================ draw

    override fun drawsBases(view: RealmView): Boolean = ready && frameReady

    override fun pickBase(view: RealmView, cssX: Double, cssY: Double): Int {
        if (!ready || !frameReady || basesDirty) return -1
        return rules.pickBase(rects, nRects, domes, nDomes, cssX, cssY)
    }

    /** bases.js `glState(k)`: the one table live draws and the rehearsal share. */
    private fun glState(s: GlState) {
        if (s.depthTest) { core.enable(GL20.GL_DEPTH_TEST); core.depthFunc(GL20.GL_LEQUAL) } else core.disable(GL20.GL_DEPTH_TEST)
        core.depthMask(s.depthWrite)
        if (s.blend == null) core.disable(GL20.GL_BLEND)
        else { core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_ONE, if (s.blend == "add") GL20.GL_ONE else GL20.GL_ONE_MINUS_SRC_ALPHA) }
    }
    /** The state the other lanes' passes expect after a BASES pass. */
    private fun restoreGl() { core.disable(GL20.GL_BLEND); core.depthMask(true); core.enable(GL20.GL_DEPTH_TEST) }

    private fun u(p: Gl3Program, name: String): Int = p.uniform(core, name)

    /** Upload [list] into [slot]'s instance buffer unless it already holds this version of it. */
    private fun upload(slot: Slot, list: FloatList) {
        if (slot.list === list && slot.ver == list.ver) return
        if (stage.capacity() < list.n) stage = ByteBuffer.allocateDirect(Math.max(list.n, stage.capacity() * 2) * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
        stage.clear(); stage.put(list.f, 0, list.n); stage.flip()
        core.gl.bindBuffer(GL20.GL_ARRAY_BUFFER, slot.buffer); core.gl.bufferData(GL20.GL_ARRAY_BUFFER, list.n * 4, stage, GL20.GL_DYNAMIC_DRAW)
        slot.list = list; slot.ver = list.ver; slot.n = list.n / slot.floats
    }

    private fun drawSlot(slot: Slot, list: FloatList) {
        upload(slot, list)
        core.bindVertexArray(slot.vao); core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, slot.n); stats.draws++
    }

    private fun drawList(tex: Gl3Texture?, lw: Int, lh: Int, slot: Slot, list: FloatList, blend: Boolean, shade: Float) {
        if (list.n == 0 || tex == null || !tex.ready) return
        val p = pSprite ?: return
        if (!core.use(p)) return
        val gl = core.gl
        gl.uniform1f(u(p, "uTrueW"), fTrueW.toFloat()); gl.uniform1f(u(p, "uMinPx"), t.minPx.toFloat()); gl.uniform2f(u(p, "uWind"), windX.toFloat(), 0f)
        gl.uniform1f(u(p, "uBlend"), if (blend) 1f else 0f); gl.uniform1f(u(p, "uShadeArt"), shade)
        core.bindTexture(0, tex); gl.uniform1i(u(p, "uTex"), 0); gl.uniform2f(u(p, "uLayerSize"), lw.toFloat(), lh.toFloat())
        drawSlot(slot, list)
        core.bindVertexArray(null)
    }

    override fun draw(view: RealmView, pass: Int) {
        val b = build ?: return
        if (!ready || !frameReady) return
        when (pass) {
            RealmLane.PASS_SHADOW -> { // tended ground: flat on the terrain, under every sprite
                val soil = b.soil
                if (lGround.n == 0 || soil == null || fGroundFade <= 0) return
                val p = pField ?: return
                if (!core.use(p)) return
                val gl = core.gl
                for (i in 0..2) gl.uniform3f(u(p, SOIL[i]), soil[i * 3], soil[i * 3 + 1], soil[i * 3 + 2])
                gl.uniform1f(u(p, "uArtPx"), if (view.d >= bands.trueStart) deedArt else mapArt)
                val road = roadTex?.takeIf { it.ready }
                core.bindTexture(0, road ?: core.dummy(integer = false, array = true)); gl.uniform1i(u(p, "uRoad"), 0)
                gl.uniform1f(u(p, "uRoadN"), if (road != null) roadN.toFloat() else 0f)
                gl.uniform1f(u(p, "uPathHW"), BasesCost.PATH_HW.toFloat()); gl.uniform1f(u(p, "uFade"), fGroundFade.toFloat())
                glState(stField)
                drawSlot(field(), lGround)
                core.bindVertexArray(null); restoreGl()
            }
            RealmLane.PASS_SHIELD_BACK -> {
                if (lSelect.n > 0) drawShield(lSelect, 1f, false, 0)
                if (lShield.n > 0) drawShield(lShield, 0f, false, fShieldLod)
            }
            RealmLane.PASS_SHIELD_FRONT -> if (lShield.n > 0) drawShield(lShield, 0f, true, fShieldLod)
            RealmLane.PASS_SPRITE -> {
                glState(stSprite)
                val shade = if (view.d >= bands.trueStart) deedArt else mapArt
                val n = b.arrays.size
                drawList(miniTex, b.mini.lw, b.mini.lh, spriteSlot(n), lMini, false, shade)
                drawList(iconTex, b.icon.lw, b.icon.lh, spriteSlot(n + 1), lIcons, false, 0f)
                for (ai in 0 until n) drawList(arrayTex[ai], b.arrays[ai].lw, b.arrays[ai].lh, spriteSlot(ai), lSprites[ai], false, shade)
            }
            RealmLane.PASS_FX -> {
                var smoke = false; for (l in lSmoke) if (l.n > 0) smoke = true
                if (smoke) { glState(stSmoke); for (ai in lSmoke.indices) drawList(arrayTex[ai], b.arrays[ai].lw, b.arrays[ai].lh, spriteSlot(ai), lSmoke[ai], true, 0f) }
                if (lFx.n > 0 || lGlow.n > 0) {
                    val p = pFx
                    if (p != null && core.use(p)) {
                        if (lFx.n > 0) { glState(stPennant); drawSlot(fx(), lFx) }
                        if (lGlow.n > 0) { glState(stGlow); drawSlot(fx(), lGlow) }
                        core.bindVertexArray(null)
                    }
                }
                if (lDots.n > 0) {
                    val p = pDot
                    if (p != null && core.use(p)) { glState(stDot); drawSlot(dot(), lDots); core.bindVertexArray(null) }
                }
                restoreGl()
            }
        }
    }

    /** bases.js `drawShield(l, mode, passFront, lod)`: mode 0 dome, 1 selection pulse. */
    private fun drawShield(l: FloatList, mode: Float, front: Boolean, lod: Int) {
        val p = pShield ?: return
        if (!core.use(p)) return
        val gl = core.gl; val a = build?.accent ?: DEFAULT_ACCENT
        gl.uniform1f(u(p, "uMode"), mode); gl.uniform1f(u(p, "uPass"), if (front) 1f else 0f); gl.uniform1f(u(p, "uDomeLod"), lod.toFloat())
        gl.uniform1f(u(p, "uArtPx"), if (lastD >= bands.trueStart) deedArt else mapArt)
        gl.uniform3f(u(p, "uAccent"), a[0], a[1], a[2])
        glState(if (front) stShieldFront else stShieldBack)
        drawSlot(shield(), l)
        core.bindVertexArray(null); restoreGl()
    }

    // ================================================================ band rehearsal (GPU_SAFE.rehearse, W1 B1)

    /**
     * bases.js `rehearse(prog)`: draw BASES program [program] once per GL state its real passes use (every `BASES_GL`
     * entry of that program) with REHEARSAL's own view, instances and placeholder array, so a band change finds its
     * pipelines built. Needs no art: it runs from the moment the programs exist. The rehearsal view sits on its own UBO
     * binding for the draws (the program's `RealmView` block is pointed at it and back), so the frame's RealmView on
     * binding 0 is never replaced (GROUND's offscreen bakes read it after the rehearsal step).
     */
    override fun rehearse(program: Gl3Program, target: Int, view: RealmView): Boolean {
        val block = rhBlock ?: return false
        freshRehearsalTex()
        val tex = rhTex ?: return false
        if (!program.ready || !tex.ready) return false
        val name = when (program) { pSprite -> "sprite"; pField -> "field"; pShield -> "shield"; pFx -> "fx"; pDot -> "dot"; else -> return false }
        val slot = rhSlots[name] ?: return false
        if (!core.use(program)) return false
        val gl = core.gl; val r = t.rehearsal
        when (name) {
            "sprite" -> {
                core.bindTexture(0, tex); gl.uniform1i(u(program, "uTex"), 0); gl.uniform2f(u(program, "uLayerSize"), r.texW.toFloat(), r.texH.toFloat())
                gl.uniform1f(u(program, "uTrueW"), 1f); gl.uniform1f(u(program, "uMinPx"), 0f); gl.uniform2f(u(program, "uWind"), 0f, 0f)
                gl.uniform1f(u(program, "uShadeArt"), deedArt)
            }
            "field" -> {
                core.bindTexture(0, tex); gl.uniform1i(u(program, "uRoad"), 0); gl.uniform1f(u(program, "uRoadN"), r.texLayers.toFloat())
                gl.uniform1f(u(program, "uArtPx"), deedArt); gl.uniform1f(u(program, "uPathHW"), BasesCost.PATH_HW.toFloat()); gl.uniform1f(u(program, "uFade"), 1f)
            }
            "shield" -> {
                val a = build?.accent ?: DEFAULT_ACCENT
                gl.uniform1f(u(program, "uMode"), 0f); gl.uniform1f(u(program, "uDomeLod"), 2f); gl.uniform1f(u(program, "uArtPx"), deedArt)
                gl.uniform3f(u(program, "uAccent"), a[0], a[1], a[2])
            }
        }
        val bi = viewBlockIndex.getOrPut(program) { gl.getUniformBlockIndex(program.handle, "RealmView") }
        val bound = bi != GL30.GL_INVALID_INDEX && bi >= 0
        gl.bindBufferBase(GL30.GL_UNIFORM_BUFFER, RH_BINDING, block.buffer)
        if (bound) gl.uniformBlockBinding(program.handle, bi, RH_BINDING)
        var n = 0
        try {
            core.bindVertexArray(slot.vao)
            for ((k, st) in t.basesGl) {
                if (st.program != name) continue
                glState(st)
                if (name == "sprite") gl.uniform1f(u(program, "uBlend"), if (k == "smoke") 1f else 0f)
                if (name == "shield") gl.uniform1f(u(program, "uPass"), if (k == "shieldFront") 1f else 0f)
                core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, slot.n); n++; stats.rehearsalDraws++
            }
        } finally {
            core.bindVertexArray(null)
            if (bound) gl.uniformBlockBinding(program.handle, bi, VIEW_BINDING)
        }
        return n > 0
    }

    override fun dispose() {
        generation++
        inbox.clear()
        for (tx in arrayTex) core.free(tx)
        core.free(miniTex); core.free(iconTex); core.free(roadTex); core.free(rhTex)
        arrayTex = emptyArray(); miniTex = null; iconTex = null; roadTex = null; rhTex = null; roadN = 0
        build = null; catalog = emptyMap(); ready = false; frameReady = false; keyValid = false
        instCache.clear(); paths = null; job = null; pathsDirty = true; linkBuckets = Buckets(0, 0); linksOf = HashMap()
        settled = emptyArray(); settledState = ByteArray(0); linkStamp = IntArray(0); clsAt = null; clsMemo.clear(); terrainPending = false
        lSprites = emptyArray(); lSmoke = emptyArray(); nRects = 0; nDomes = 0; nB = 0; basesDirty = true
        for (s in spritePool) s.list = null
        progList = emptyList(); pSprite = null; pDot = null; pFx = null; pShield = null; pField = null
        stats.loaded = false; animationPeriodMs = 0; shieldPeriodMs = 0
    }

    companion object {
        const val K_SPRITE = "bases-sprite"; const val K_SHIELD = "bases-shield"; const val K_FX = "bases-fx"
        const val K_FIELD = "bases-field"; const val K_DOT = "bases-dot"
        val PROGRAM_KEYS = listOf(K_SPRITE, K_SHIELD, K_FX, K_FIELD, K_DOT)
        /** Vertex layouts (pair keys): 4, 3 and 2 instance vec4s after the quad corner. The rehearsal uses the same. */
        const val LAYOUT_4 = 0x4234; const val LAYOUT_3 = 0x4233; const val LAYOUT_2 = 0x4232
        /** contracts.js UBO_VIEW (the frame's RealmView) and the rehearsal view's own binding. */
        const val VIEW_BINDING = 0; const val RH_BINDING = 1
        /** bases.js: the keep clip's frame time, the smoke drift's, the shield pulse cadence (presentation). */
        private const val KEEP_FRAME_MS = 83.0; private const val SMOKE_FRAME_MS = 260.0; private const val SHIELD_MS = 50
        private val ICON = BasesLoad.ICON_SIZE.toDouble()
        private val DEFAULT_ACCENT = floatArrayOf(0.5f, 0.89f, 1.0f)
        private val SOIL = arrayOf("uSoil[0]", "uSoil[1]", "uSoil[2]")
        private val QUAD: FloatBuffer = ByteBuffer.allocateDirect(12 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer()
            .put(floatArrayOf(0f, 0f, 1f, 0f, 1f, 1f, 0f, 0f, 1f, 1f, 0f, 1f)).also { it.position(0) }
    }
}
