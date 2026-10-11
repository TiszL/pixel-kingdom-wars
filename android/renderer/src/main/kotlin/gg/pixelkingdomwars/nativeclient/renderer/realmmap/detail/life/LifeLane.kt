package gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.life

import com.badlogic.gdx.graphics.GL20
import com.badlogic.gdx.graphics.GL30
import gg.pixelkingdomwars.nativeclient.renderer.generated.WorldShaders
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Core
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Format
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Sampling
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Texture
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Wrap
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmOpen
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmProgramSource
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmView
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.RejectedExecutionException

/** The LIFE lane's counters for the debug overlay and the tests (life.js `stats()`). */
class LifeStats {
    var why = "not loaded"
    var loaded = false
    var draws = 0; var submitted = 0
    var planned = 0
    var arrays = 0; var layers = 0
    var missing: List<String> = emptyList()
    var darkTwins: List<String> = emptyList()
    var gpuBytes = 0L
    var classesMissed = 0L
    var rehearsalDraws = 0L
}

/**
 * The LIFE lane of the realm map (web `life.js`, pinned): scatter (trees, scrub, rocks, crops, litter), features and
 * landmarks with their MAP twins and map objects, stands (MAP clumps, merged 2×2 clumps, TRUE members), herds and
 * creatures, birds with ground shadows, emitter puffs and realm ambience, all instanced from world-anchored lattices in
 * the VERBATIM web shaders. The CPU plans each frame's windows with [LifePlanner] (allocation-free, the §9 per-device cap
 * or the ladder's `view.lifeCap`); the GPU places every instance from the same tables and hashes.
 *
 * Needs GROUND's class inputs ([RealmClasses.bindClasses]): every LIFE program reads the classes include. Without them a
 * live frame draws no LIFE (never a guess) and counts [LifeStats.classesMissed]. Its (program, state) pairs are rehearsed
 * with one instance covering the view centre (`uRehearse`), in every pass state the real draws use.
 *
 * GL thread unless marked. Loading runs on the realm's decode executor ([RealmOpen.executor]); nothing uploads, links or
 * rehearses in a flight or a fade (the engine never calls [update]/[rehearse] then with work allowed).
 */
class LifeLane(
    private val core: Gl3Core,
    private val tables: LifeTablesFile,
    private val scatter: Scatter,
    private val bands: LifeBandsIn,
    private val pack: LanePack,
    private val uploads: LaneUploads,
    private val classes: RealmClasses?,
    private val shaderSource: (WorldShaders.Stage) -> String = WorldShaders::source,
    /** The integer uniform calls (null: `core.gl` when it implements [Gl3IntUniforms], else LIFE draws nothing). */
    private val intUniforms: Gl3IntUniforms? = null,
) : RealmLane {
    override val name = "life"
    private val c = tables.constants
    val stats = LifeStats()

    // ---- load. [generation] is read by the load job on its worker: a job whose generation is gone (a later open, a
    //      dispose) skips its remaining stages and never leaves its result in [inbox] (P0 2026-09-26: a build that arrived
    //      after dispose sat in the inbox of the host's still-reachable lane, 48.7 MB on the Seeker's 256 MB heap).
    @Volatile private var generation = -1
    private val inbox = ConcurrentLinkedQueue<Any>()
    private var loadDone = false
    private var sources: Map<String, RealmProgramSource>? = null
    private class Built(val gen: Int, val result: LifeLoad.Result, val sources: Map<String, RealmProgramSource>)
    private class Failed(val gen: Int, val why: String)

    // ---- resident
    private var build: LifeBuild? = null
    private var planner: LifePlanner? = null
    private var arrayTex: Array<Gl3Texture?> = emptyArray()
    private var filterSet = BooleanArray(0)
    private var table: Gl3Texture? = null
    private var progList: List<Gl3Program> = emptyList()
    private var pScatter: Gl3Program? = null; private var pCreature: Gl3Program? = null; private var pStand: Gl3Program? = null
    private var pStandMerged: Gl3Program? = null; private var pBird: Gl3Program? = null; private var pParticle: Gl3Program? = null
    private val ints: Gl3IntUniforms? = intUniforms ?: core.gl as? Gl3IntUniforms

    // per array: the groups that own it, per scatter mode (group indices in life order)
    private var sprTargets = IntArray(0); private var twTargets = IntArray(0)
    private var kitOwners: Array<IntArray> = emptyArray(); private var kitOwnersMap: Array<IntArray> = emptyArray(); private var twinOwners: Array<IntArray> = emptyArray()
    private var emitOwners = IntArray(0)
    private var standMemberArrays = IntArray(0); private var standClumpArrays = IntArray(0)
    private val gA = IntArray(32); private val gB = IntArray(32); private val gC = IntArray(32); private val gR = IntArray(32)

    // ---- the rehearsal plan (life.js rehearsalPlan): one 1-cell window per stream at the camera, whole rank ranges
    private var rehearsing = false
    private var frameTrueClasses = false; private var frameTrueOn = true

    // ================================================================ RealmLane

    override fun open(realm: RealmOpen) {
        dispose()
        val gen = realm.generation; generation = gen; loadDone = false; stats.why = "loading"
        val have = sources
        try {
            realm.executor.execute {
                if (gen != generation) return@execute // superseded before it ran: nothing to load
                try {
                    val src = have ?: loadSources()
                    val result = LifeLoad(tables, scatter).build(pack, realm.realmId) { gen == generation }
                    publish(gen, Built(gen, result, src))
                } catch (e: Exception) { publish(gen, Failed(gen, e.message ?: e.javaClass.simpleName)) }
                catch (e: OutOfMemoryError) { publish(gen, Failed(gen, "out of memory while loading LIFE")) } // settles, never hangs the map
                if (gen == generation) realm.wake.run()
            }
        } catch (e: RejectedExecutionException) { loadDone = true; stats.why = "decode executor refused the load" }
    }

    /** Worker: hand [m] to the GL thread only while [gen] is current; a dispose racing the offer takes it back out. */
    private fun publish(gen: Int, m: Any) {
        if (gen != generation) return
        inbox.offer(m)
        if (gen != generation) inbox.remove(m)
    }

    /** Worker: the six LIFE stages, sha-checked by [WorldShaders.source]. */
    private fun loadSources(): Map<String, RealmProgramSource> {
        val out = LinkedHashMap<String, RealmProgramSource>()
        for (key in PROGRAM_KEYS) {
            val p = WorldShaders.realm[key] ?: error("world shader table has no $key")
            out[key] = RealmProgramSource(p.name, shaderSource(p.vs), shaderSource(p.fs), p.vs.sha256, p.fs.sha256)
        }
        return out
    }

    override fun programs(): List<Gl3Program> = progList
    override fun bandSet(): Int = if (build != null) 2 else 0
    override fun settled(): Boolean = loadDone
    override fun readyFor(set: Int): Boolean = loadDone

    /**
     * GL thread, a work frame: move a finished load into its uploads (idempotent; never draws). The engine calls it every
     * work frame, also while the lane is held, so the arrays fill while the player looks at the overview; [update] calls
     * it first.
     */
    override fun adopt(nowMs: Double) {
        while (true) {
            when (val m = inbox.poll() ?: break) {
                is Failed -> if (m.gen == generation) { loadDone = true; stats.why = m.why }
                is Built -> if (m.gen == generation) create(m)
            }
        }
    }

    /** False while the texture arrays are still filling on the worker (the hook could not draw yet: try again, not a
     *  failed try); true once they are resident, or when there is nothing to fill (its false answers are then final). */
    override fun rehearsable(program: Gl3Program): Boolean = !filling()

    private fun filling(): Boolean {
        if (build == null) return false
        for (t in arrayTex) if (t != null && !t.ready) return true
        val tb = table
        return tb != null && !tb.ready
    }

    private fun create(m: Built) {
        sources = m.sources
        loadDone = true
        val b = m.result.build
        if (b == null) { stats.why = m.result.why; return }
        build = b
        stats.missing = b.missing; stats.darkTwins = b.darkTwins; stats.arrays = b.arrays.size
        planner = LifePlanner(scatter, b.life, bands)
        // textures: filled on the worker, never ghosted (plan §5.7)
        arrayTex = arrayOfNulls(b.arrays.size); filterSet = BooleanArray(b.arrays.size)
        var bytes = 0L; var layers = 0
        for ((i, a) in b.arrays.withIndex()) {
            if (a.mips.isEmpty()) continue
            val mips = a.mips
            arrayTex[i] = uploads.fresh(core, Gl3Pool.REALM, true, a.lw, a.lh, mips.size, Gl3Format.RGBA8, a.levels, Gl3Sampling.LINEAR_MIPMAP_LINEAR, Gl3Wrap.CLAMP) { layer, level, _, _, out ->
                out.position(0); out.put(mips[layer][level]); out.position(0)
            }
            bytes += Gl3Format.RGBA8.layerBytes(a.lw, a.lh, a.levels) * mips.size; layers += mips.size
        }
        val data = b.table
        table = uploads.fresh(core, Gl3Pool.REALM, false, b.tableW, b.tableRows, 1, Gl3Format.RGBA16UI, 1, Gl3Sampling.NEAREST, Gl3Wrap.CLAMP) { _, _, _, _, out ->
            out.position(0); out.order(ByteOrder.nativeOrder()).asShortBuffer().put(data); out.position(0)
        }
        stats.gpuBytes = bytes + Gl3Format.RGBA16UI.layerBytes(b.tableW, b.tableRows, 1); stats.layers = layers
        // programs (built on the worker context; READY once adopted)
        val s = m.sources
        fun prog(key: String) = s.getValue(key).let { core.program(it.name, it.vs, it.fs, it.vsSha256, it.fsSha256) }
        pScatter = prog(K_SCATTER); pCreature = prog(K_CREATURE); pStand = prog(K_STAND); pStandMerged = prog(K_STAND_MERGED); pBird = prog(K_BIRD); pParticle = prog(K_PARTICLE)
        progList = listOf(pScatter!!, pStand!!, pStandMerged!!, pBird!!, pParticle!!, pCreature!!)
        owners(b)
        // upload-only from here: each fill holds its own array's mips until the worker has filled it, and nothing else reads
        // them (owners() and LifeLoad.submitCounts asked for them above); a context loss reloads from the pack files
        for (a in b.arrays) a.mips = emptyArray()
        stats.why = if (ints == null) "no integer uniforms on this Gl3 (Gl3IntUniforms): LIFE draws nothing" else "ok"
        stats.loaded = true
    }

    /** Which groups draw into which array, per scatter mode (life.js `owns`), precomputed once. */
    private fun owners(b: LifeBuild) {
        val groups = b.life.groups; val n = b.arrays.size
        fun keyed(k: String) = (0 until n).filter { b.arrays[it].mips.isNotEmpty() && b.arrays[it].key.startsWith(k) }.toIntArray()
        sprTargets = keyed("spr"); twTargets = keyed("tw")
        kitOwners = Array(n) { ai -> groups.indices.filter { gi -> groups[gi].species.any { it.sp.arr == ai } }.toIntArray() }
        kitOwnersMap = Array(n) { ai -> groups.indices.filter { gi -> val g = groups[gi]; g.species.any { it.sp.arr == ai && g.twin && it.sp.twin == null } }.toIntArray() }
        twinOwners = Array(n) { ai -> groups.indices.filter { gi -> val g = groups[gi]; g.hasTwins && g.species.any { it.sp.twin?.arr == ai } }.toIntArray() }
        emitOwners = groups.indices.filter { groups[it].hasEmit }.toIntArray()
        val st = b.life.stands
        standMemberArrays = st?.species?.map { it.sp.arr }?.distinct()?.toIntArray() ?: IntArray(0)
        standClumpArrays = st?.variants?.mapNotNull { it.clump?.arr }?.distinct()?.toIntArray() ?: IntArray(0)
    }

    private fun texturesReady(): Boolean {
        if (build == null) return false
        for (t in arrayTex) if (t != null && !t.ready) return false
        return table?.ready == true
    }

    /** The shortest animation period LIFE needs on screen (life.js `declareAnimations`: clips, creatures, air 50 ms,
     *  beacon lens glow 100 ms (stage B), sway 100 ms), 0 for none. The host feeds it to `IdleScheduler.animating(TAG_LIFE, …)`. */
    var animationPeriodMs = 0; private set

    override fun update(view: RealmView) {
        stats.draws = 0; stats.submitted = 0 // per frame: the passes add up
        if (view.workAllowed) adopt(0.0)
        val p = planner ?: return
        frameTrueClasses = false
        if (!texturesReady()) { animationPeriodMs = 0; return }
        p.capOverride = if (view.lifeCap > 0) view.lifeCap else 0
        p.plan(view.x, view.y, view.d, view.viewW, view.viewH, view.dpr, view.reducedMotion)
        stats.planned = p.total
        frameTrueClasses = p.trueClasses; frameTrueOn = p.trueOn
        declareAnimations(view, p)
    }

    private fun declareAnimations(view: RealmView, p: LifePlanner) {
        if (view.reducedMotion) { animationPeriodMs = 0; return }
        var best = Int.MAX_VALUE
        val life = p.life
        // indexed loops over the lists: no iterator per frame
        for (e in p.groups) if (e.count > 0) { val sp = e.g.species; for (q in sp.indices) if (sp[q].sp.frames > 1) best = Math.min(best, sp[q].sp.frameMs) }
        if (p.creatures.active && p.creatures.count > 0) { val cs = life.creatures!!.species; for (q in cs.indices) best = Math.min(best, cs[q].sh.frameMs) }
        var air = (p.birds.active && p.birds.count > 0)
        for (j in 0 until p.ambienceCount) if (p.ambience[p.ambienceOn[j]].count > 0) air = true
        for (e in p.groups) if (e.count > 0 && e.g.hasEmit) air = true
        if (air) best = Math.min(best, 50)
        for (e in p.groups) if (e.count > 0 && e.g.hasGlow) best = Math.min(best, 100) // life.js on('life-glow', 100): beacon lenses pulse
        if (view.d >= bands.sway) {
            var sway = false
            for (e in p.groups) if (e.count > 0 && e.g.sway) sway = true
            val st = life.stands
            if (p.stands.active && p.stands.members > 0 && st != null) { val mx = st.mixes; for (q in mx.indices) if (mx[q].sway) sway = true }
            if (sway) best = Math.min(best, 100)
        }
        animationPeriodMs = if (best == Int.MAX_VALUE) 0 else best
    }

    override fun draw(view: RealmView, pass: Int) {
        val p = planner ?: return
        if (!texturesReady() || ints == null || p.empty) return
        when (pass) {
            RealmLane.PASS_SHADOW -> { if (p.birds.active && p.birds.count > 0) inPass(PASS_SHADOW) { drawBirds(true) } }
            RealmLane.PASS_SPRITE -> inPass(PASS_SPRITE) {
                drawScatter(0); if (view.d < bands.trueFull) drawScatter(2)
                drawStands(0); drawStands(2); drawStands(3); drawCreatures()
            }
            RealmLane.PASS_AIR -> inPass(PASS_AIR) { drawScatter(1); drawParticles(); drawBirds(false) }
        }
    }

    // ================================================================ GL state and draws

    /** life.js `inPass`: a pass's GL state around the draws (the rehearsal draws through the same code). The engine runs
     *  every lane pass with depth test on (LEQUAL), so a pass that turns it off turns it back on. */
    private inline fun inPass(pass: Int, fn: () -> Unit) {
        when (pass) {
            PASS_SHADOW -> { core.disable(GL20.GL_DEPTH_TEST); core.depthMask(false); core.enable(GL20.GL_BLEND); core.blendFunc(GL20.GL_DST_COLOR, GL20.GL_ZERO) }
            PASS_SPRITE -> { core.enable(GL20.GL_DEPTH_TEST); core.depthFunc(GL20.GL_LEQUAL); core.depthMask(true); core.disable(GL20.GL_BLEND) }
            else -> { core.disable(GL20.GL_DEPTH_TEST); core.disable(GL20.GL_BLEND) }
        }
        fn()
        if (pass == PASS_SHADOW) { core.disable(GL20.GL_BLEND); core.depthMask(true) }
        if (pass != PASS_SPRITE && !rehearsing) core.enable(GL20.GL_DEPTH_TEST)
        core.bindVertexArray(null)
    }

    private fun quads(n: Int) {
        core.bindVertexArray(core.quad)
        core.drawArraysInstanced(GL20.GL_TRIANGLES, 0, 6, if (rehearsing) 1 else n)
        stats.draws++; stats.submitted += n
        if (rehearsing) stats.rehearsalDraws++
    }

    private fun u(p: Gl3Program, name: String): Int = p.uniform(core, name)

    /** life.js `bindCommon`. False when the program is not bound or GROUND's classes are missing in a live frame. */
    private fun bindCommon(p: Gl3Program, arr: Int): Boolean {
        if (!core.use(p)) return false
        val tex = arrayTex[arr] ?: return false; val tb = table ?: return false
        val gl = core.gl; val iu = ints ?: return false
        gl.uniform1i(u(p, "uRehearse"), if (rehearsing) 1 else 0)
        core.bindTexture(0, tex); gl.uniform1i(u(p, "uArr"), 0)
        if (!filterSet[arr]) { filterSet[arr] = true; gl.texParameteri(GL30.GL_TEXTURE_2D_ARRAY, GL20.GL_TEXTURE_MIN_FILTER, GL20.GL_LINEAR_MIPMAP_NEAREST) } // one reducer level, never a blend of two
        core.bindTexture(1, tb); gl.uniform1i(u(p, "uLTable"), 1)
        if (classes == null || !classes.bindClasses(p, CLASSES_FIRST)) {
            if (!rehearsing) { stats.classesMissed++; return false }
            bindClassDummies(p)
        }
        val f = build!!.life.fields
        iu.uniform4i(u(p, "uField"), f[0].salt, f[1].salt, 0, 0); iu.uniform4i(u(p, "uCover"), f[0].lo, f[0].k, f[1].lo, f[1].k)
        gl.uniform1i(u(p, "uTrueCls"), if (frameTrueClasses) 1 else 0)
        return true
    }

    /** A rehearsal before GROUND's inputs exist still builds the pipeline: the classes samplers get the core's dummies. */
    private fun bindClassDummies(p: Gl3Program) {
        val gl = core.gl
        core.bindTexture(CLASSES_FIRST, core.dummy(integer = true, array = false)); gl.uniform1i(u(p, "uRmBase"), CLASSES_FIRST)
        core.bindTexture(CLASSES_FIRST + 1, core.dummy(integer = true, array = false)); gl.uniform1i(u(p, "uRmLineTex"), CLASSES_FIRST + 1)
        core.bindTexture(CLASSES_FIRST + 2, core.dummy(integer = true, array = false)); gl.uniform1i(u(p, "uRmPageTable"), CLASSES_FIRST + 2)
        core.bindTexture(CLASSES_FIRST + 3, core.dummy(integer = true, array = true)); gl.uniform1i(u(p, "uRmLattice"), CLASSES_FIRST + 3)
        core.bindTexture(CLASSES_FIRST + 4, core.dummy(integer = true, array = true)); gl.uniform1i(u(p, "uRmRecords"), CLASSES_FIRST + 4)
        core.bindTexture(CLASSES_FIRST + 5, core.dummy(integer = false, array = false)); gl.uniform1i(u(p, "uRmFieldsA"), CLASSES_FIRST + 5)
    }

    /** life.js `drawScatter(view, mode)`: one instanced draw per array, the groups owning species in it concatenated (≤ 8). */
    private fun drawScatter(mode: Int) {
        val p = planner!!; val prog = pScatter ?: return; val b = build!!
        val targets = when (mode) { 0 -> sprTargets; 2 -> twTargets; else -> if (b.airArray >= 0) AIR_ONE.also { it[0] = b.airArray } else NONE }
        for (ai in targets) {
            val owners = when (mode) { 0 -> if (frameTrueOn || rehearsing) kitOwners[ai] else kitOwnersMap[ai]; 2 -> twinOwners[ai]; else -> emitOwners }
            var n = 0; var start = 0
            gA.fill(0); gB.fill(0); gC.fill(0); gR.fill(0)
            for (gi in owners) {
                if (n == 8) break
                val pg = p.groups[gi]
                val count: Int; val rl: Boolean; val lo: Int; val hi: Int
                if (rehearsing) { count = 1; rl = false; lo = 0; hi = 65536 }
                else {
                    val r = if (mode == 2) (if (pg.twIsKit) pg.kit else pg.tw) else pg.kit
                    val has = if (mode == 2) pg.hasTw else pg.hasKit
                    if (!has || r.count <= 0) continue
                    count = r.count; rl = r.rl; lo = r.lo; hi = r.hi
                }
                val g = pg.g; val o = n * 4
                val r = if (mode == 2) (if (pg.twIsKit) pg.kit else pg.tw) else pg.kit
                if (!rehearsing && rl) { gA[o] = r.bx0; gA[o + 1] = r.by0; gA[o + 2] = r.nbx } else { gA[o] = if (rehearsing) rehearseCell(g.pitchArt, true) else pg.win.ix0; gA[o + 1] = if (rehearsing) rehearseCell(g.pitchArt, false) else pg.win.iy0; gA[o + 2] = if (rehearsing) 1 else pg.win.nx }
                gA[o + 3] = start
                gR[o] = if (!rehearsing && rl) r.m else 0; gR[o + 1] = if (!rehearsing && rl) r.j0 else 0
                gR[o + 2] = if (mode == 2) lo else (if (rehearsing) 65536 else (if (pg.truHi >= 0) pg.truHi else 0)); gR[o + 3] = hi
                gB[o] = g.pitchArt; gB[o + 1] = g.jitterArt; gB[o + 2] = g.salt; gB[o + 3] = g.species.size
                val md = g.mod
                gC[o] = (if (g.twin) 1 else 0) or (if (g.sway) 2 else 0) or (if (g.mapOnly) 4 else 0) or (pg.win.stride shl 8); gC[o + 1] = g.row
                gC[o + 2] = if (md != null) md.out or (md.inn shl 12) else 0
                gC[o + 3] = (if (md != null) md.edge or (md.id shl 12) or (1 shl 13) else 0) or (g.cluster8 shl 16)
                start += count; n++
            }
            if (n == 0) continue
            if (!bindCommon(prog, ai)) continue
            val gl = core.gl; val iu = ints!!
            iu.uniform4iv(u(prog, "uGrp"), 8, gA, 0); iu.uniform4iv(u(prog, "uGrpB"), 8, gB, 0); iu.uniform4iv(u(prog, "uGrpC"), 8, gC, 0); iu.uniform4iv(u(prog, "uGrpR"), 8, gR, 0)
            gl.uniform1i(u(prog, "uNG"), n); gl.uniform1i(u(prog, "uArray"), ai); gl.uniform1i(u(prog, "uMode"), mode)
            gl.uniform1i(u(prog, "uPuffs"), c.puffs); iu.uniform1ui(u(prog, "uPuffLife"), c.puffLifeMs)
            gl.uniform2f(u(prog, "uWind"), b.life.wind[0].toFloat(), b.life.wind[1].toFloat())
            gl.uniform1f(u(prog, "uArtPerDeed"), (if (mode == 2) scatter.geo.mapArt else scatter.geo.deedArt).toFloat())
            quads(if (mode == 1) start * c.puffs else start)
        }
    }

    /** The rehearsal plan's one cell at the camera (life.js `rehearsalPlan`: floor(view · 3136 / pitch)). */
    private var rehearseX = 0.0; private var rehearseY = 0.0
    private fun rehearseCell(pitchArt: Int, x: Boolean): Int = Math.floor((if (x) rehearseX else rehearseY) * scatter.geo.deedArt / pitchArt).toInt()

    /** life.js `drawStands(mode)`: members (0), own clumps (2), merged 2×2 clumps (3), one draw per array they use. */
    private fun drawStands(mode: Int) {
        val p = planner!!; val st = build!!.life.stands ?: return
        if (st.row < 0) return
        val ps = p.stands
        if (!rehearsing && !ps.active) return
        val n = if (rehearsing) 1 else when (mode) { 0 -> ps.members; 2 -> ps.clumps; else -> ps.merged }
        if (n == 0) return
        val r = if (mode == 0) ps.mem else if (mode == 2) ps.clu else null
        val rl = !rehearsing && r != null && r.rl
        val wx: Int; val wy: Int; val wn: Int; val ws: Int
        when {
            rehearsing -> { val pitch = if (mode == 3) 2 * st.pitchArt else st.pitchArt; wx = rehearseCell(pitch, true); wy = rehearseCell(pitch, false); wn = 1; ws = 1 }
            mode == 3 -> { wx = ps.mergedWin.ix0; wy = ps.mergedWin.iy0; wn = ps.mergedWin.nx; ws = ps.mergedWin.stride }
            rl -> { wx = r!!.bx0; wy = r.by0; wn = r.nbx; ws = 1 }
            else -> { wx = ps.win.ix0; wy = ps.win.iy0; wn = ps.win.nx; ws = 1 }
        }
        val prog = (if (mode == 3) pStandMerged else pStand) ?: return
        val used = if (mode == 0) standMemberArrays else standClumpArrays
        for (ai in used) {
            if (ai < 0 || ai >= arrayTex.size || arrayTex[ai] == null) continue
            if (!bindCommon(prog, ai)) continue
            val gl = core.gl; val iu = ints!!
            iu.uniform4i(u(prog, "uWin"), wx, wy, wn, ws)
            val lo = if (rehearsing) (if (mode == 2) 0 else 65536) else if (mode == 2) r!!.lo else ps.truHi
            iu.uniform4i(u(prog, "uRank"), if (rl) r!!.m else 0, if (rl) r!!.j0 else 0, lo, if (rehearsing) 65536 else (r?.hi ?: 65536))
            iu.uniform4i(u(prog, "uStand"), st.pitchArt, st.jitterArt, st.salt, st.variants.size)
            gl.uniform1i(u(prog, "uRow"), st.row); gl.uniform1i(u(prog, "uArray"), ai); gl.uniform1i(u(prog, "uMode"), mode)
            gl.uniform4f(u(prog, "uSplit"), c.stand.splitFrom.toFloat(), c.stand.splitFull.toFloat(), c.stand.mergeFrom.toFloat(), st.mergeUntil.toFloat())
            gl.uniform1f(u(prog, "uArtPerDeed"), when (mode) { 2 -> scatter.geo.mapArt.toFloat(); 3 -> scatter.geo.mapArt / 2f; else -> scatter.geo.deedArt.toFloat() })
            quads(n)
        }
    }

    private fun drawCreatures() {
        val p = planner!!; val cr = build!!.life.creatures ?: return
        if (cr.row < 0 || cr.species.isEmpty()) return
        val e = p.creatures
        if (!rehearsing && (!e.active || e.count == 0)) return
        val prog = pCreature ?: return
        if (!bindCommon(prog, cr.species[0].sh.arr)) return
        val gl = core.gl; val iu = ints!!
        if (rehearsing) iu.uniform4i(u(prog, "uWin"), rehearseCell(cr.pitchArt, true), rehearseCell(cr.pitchArt, false), 1, 1)
        else iu.uniform4i(u(prog, "uWin"), e.win.ix0, e.win.iy0, e.win.nx, e.win.stride)
        iu.uniform4i(u(prog, "uCre"), cr.pitchArt, cr.jitterArt, cr.salt, cr.species.size)
        gl.uniform1i(u(prog, "uRow"), cr.row); gl.uniform1f(u(prog, "uKeep"), if (rehearsing) 0f else e.keep.toFloat())
        gl.uniform1f(u(prog, "uArtPerDeed"), scatter.geo.deedArt.toFloat())
        quads(if (rehearsing) 1 else e.count)
    }

    private fun drawBirds(shadow: Boolean) {
        val p = planner!!; val b = build!!.life.birds ?: return; val air = build!!.airArray
        if (b.row < 0 || air < 0 || b.species.isEmpty()) return
        val e = p.birds
        if (!rehearsing && (!e.active || e.count == 0)) return
        val prog = pBird ?: return
        if (!bindCommon(prog, air)) return
        val gl = core.gl; val iu = ints!!
        if (rehearsing) iu.uniform4i(u(prog, "uWin"), rehearseCell(b.pitchArt, true), rehearseCell(b.pitchArt, false), 1, 1)
        else iu.uniform4i(u(prog, "uWin"), e.win.ix0, e.win.iy0, e.win.nx, e.win.stride)
        iu.uniform4i(u(prog, "uBird"), b.pitchArt, b.jitterArt, b.salt, b.species.size)
        gl.uniform1i(u(prog, "uRow"), b.row); gl.uniform1i(u(prog, "uP16"), b.p16); gl.uniform1f(u(prog, "uKeep"), if (rehearsing) 0f else e.keep.toFloat())
        gl.uniform1f(u(prog, "uSky"), if (rehearsing) 1f else e.scale.toFloat()); gl.uniform1i(u(prog, "uShadow"), if (shadow) 1 else 0)
        quads(if (rehearsing) 1 else e.count)
    }

    private fun drawParticles() {
        val p = planner!!; val b = build!!; val air = b.airArray
        if (air < 0) return
        val prog = pParticle ?: return
        val n = if (rehearsing) b.life.ambience.size else p.ambienceCount
        for (j in 0 until n) {
            val i = if (rehearsing) j else p.ambienceOn[j]
            val e = p.ambience[i]; val a = b.life.ambience[i]
            if (!rehearsing && e.count == 0) continue
            val sp = a.sp
            if (!bindCommon(prog, air)) continue
            val gl = core.gl; val iu = ints!!
            if (rehearsing) iu.uniform4i(u(prog, "uWin"), rehearseCell(a.pitchArt, true), rehearseCell(a.pitchArt, false), 1, 1)
            else iu.uniform4i(u(prog, "uWin"), e.win.ix0, e.win.iy0, e.win.nx, e.win.stride)
            iu.uniform4i(u(prog, "uAmb"), a.pitchArt, a.jitterArt, a.salt, when (a.kind) { "fall" -> 1; "spray" -> 2; else -> 0 })
            iu.uniform4i(u(prog, "uAmbB"), a.lifeMs, (a.alt ?: 0.0).toInt(), if (a.rise) 1 else 0, a.row)
            iu.uniform4i(u(prog, "uSpr"), sp.layer0, sp.frames, sp.frameMs, scatter.ambienceInk(a, bands.snap))
            iu.uniform2i(u(prog, "uAnchor"), sp.lax.toInt(), sp.lay.toInt())
            val k = a.windK ?: 1.0
            gl.uniform2f(u(prog, "uWind"), (b.life.wind[0] * k).toFloat(), (b.life.wind[1] * k).toFloat())
            gl.uniform1f(u(prog, "uKeep"), if (rehearsing) 0f else e.keep.toFloat()); gl.uniform1i(u(prog, "uShadow"), 0)
            quads(if (rehearsing) 1 else e.count)
        }
    }

    // ================================================================ rehearsal (GPU_SAFE.rehearse, W1)

    /**
     * Draw LIFE program [program] once per pass state its real passes use, one instance covering the view centre
     * (life.js `REHEARSE`), into the scratch target the engine bound. False while the textures or the program are not
     * ready (retried), or when this pack gives the program nothing to draw.
     */
    override fun rehearse(program: Gl3Program, target: Int, view: RealmView): Boolean {
        if (!texturesReady() || !program.ready || ints == null) return false
        val n0 = stats.rehearsalDraws
        rehearsing = true; rehearseX = view.x; rehearseY = view.y
        try {
            when (program) {
                pScatter -> { inPass(PASS_SPRITE) { drawScatter(0); drawScatter(2) }; inPass(PASS_AIR) { drawScatter(1) } }
                pStand -> inPass(PASS_SPRITE) { drawStands(0); drawStands(2) }
                pStandMerged -> inPass(PASS_SPRITE) { drawStands(3) }
                pCreature -> inPass(PASS_SPRITE) { drawCreatures() }
                pBird -> { inPass(PASS_SHADOW) { drawBirds(true) }; inPass(PASS_AIR) { drawBirds(false) } }
                pParticle -> inPass(PASS_AIR) { drawParticles() }
                else -> return false
            }
        } finally { rehearsing = false }
        return stats.rehearsalDraws > n0
    }

    override fun dispose() {
        generation++
        inbox.clear()
        for (t in arrayTex) core.free(t)
        core.free(table)
        arrayTex = emptyArray(); table = null; build = null; planner = null
        progList = emptyList(); pScatter = null; pCreature = null; pStand = null; pStandMerged = null; pBird = null; pParticle = null
        stats.loaded = false; animationPeriodMs = 0
    }

    companion object {
        /** Stage B: life.js compiles life-scatter with `LIFE_GLOW: 1` (the map-object lens glow), exported under this key;
         *  the program's name (the rehearsal order) stays `life-scatter`. */
        const val K_SCATTER = "life-scatter+LIFE_GLOW=1"; const val K_CREATURE = "life-creature"; const val K_STAND = "life-stand"
        const val K_STAND_MERGED = "life-stand-merged+STAND_MERGED=1"; const val K_BIRD = "life-bird"; const val K_PARTICLE = "life-particle"
        val PROGRAM_KEYS = listOf(K_SCATTER, K_STAND, K_STAND_MERGED, K_BIRD, K_PARTICLE, K_CREATURE)
        /** contracts.js UNITS.classesFirst: sprite programs own units 0–7, GROUND's classes 8–13. */
        const val CLASSES_FIRST = 8
        private const val PASS_SHADOW = 0; private const val PASS_SPRITE = 1; private const val PASS_AIR = 2
        private val NONE = IntArray(0)
        private val AIR_ONE = IntArray(1)
    }
}
