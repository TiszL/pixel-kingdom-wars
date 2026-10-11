package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilter
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldFilterKind
import org.junit.Test
import java.lang.management.ManagementFactory
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * The realm engine against the recording fake GL (GLOBE-NATIVE-PLAN §3.5, §5.3, §5.9, §8.2). What each test protects:
 * - dive readiness really means "the first realm frame builds no pipeline": every (program, state) pair the live
 *   frame, the ground up-scale, the snapshot and the fade composite use is rehearsed first, into scratch targets;
 * - flights and fades carry no compile, rehearsal or upload (the Mali hitch the plan exists to avoid);
 * - the frame order suits a tiler (offscreen first, the screen bound once) and pause/dispose never wait;
 * - the overview never pretends a detail band exists (FAR clamp), and a context loss restores behind the deep sea.
 */
class RealmMapEngineTest {
    private val rig = RealmGlRig()
    private val failures = ArrayList<String>()
    private val selections = ArrayList<IntArray>()
    private val engine = RealmMapEngine(
        rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
        RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS,
    ).apply {
        listener = object : RealmMapListener {
            override fun onFailed(realmId: String, reason: String) { failures += "$realmId: $reason" }
            override fun onSelection(base: Int, deedX: Int, deedY: Int, tileId: Int) { selections += intArrayOf(base, deedX, deedY, tileId) }
        }
        setViewport(914, 2034, 2.0)
    }

    /** One host frame without a realm pass (the globe is on screen). */
    private fun globeFrame(allow: Boolean = true, rehearse: Boolean = true) {
        rig.compiler.runAll()
        rig.nowMs += 16.667
        check(rig.begin())
        engine.update(rig.nowMs, allow)
        rig.uploads.poll(rig.core)
        if (rehearse && allow) engine.rehearseStep(rig.nowMs)
        rig.core.beginScreen(0f, 0f, 0f, 1f) // the globe's own screen pass
        rig.end()
    }

    private fun realmFrame(allow: Boolean = true): Boolean {
        rig.compiler.runAll()
        rig.nowMs += 16.667
        check(rig.begin())
        engine.update(rig.nowMs, allow)
        rig.uploads.poll(rig.core)
        if (engine.waiting) engine.rehearseStep(rig.nowMs)
        val moving = engine.frame(rig.nowMs, rig.nowMs.toLong(), false)
        rig.end()
        return moving
    }

    private fun ready(): Int {
        assertTrue(engine.prepare("alpha"))
        var frames = 0
        while (!engine.ready && frames < 200) { globeFrame(); frames++ }
        assertTrue(engine.ready, "not dive-ready after $frames frames (status ${engine.status}, ${failures.joinToString()})")
        return frames
    }

    private fun enterAlpha() {
        val g = assertNotNull(engine.grid)
        assertTrue(engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        engine.setMinimapRect(12.0, 700.0, 130.0, 100.0)
    }

    private var localX = IntArray(0); private var localY = IntArray(0)
    private fun bases(realm: String = "alpha"): WorldBases {
        val g = engine.grid!!; val xs = ArrayList<Int>(); val ys = ArrayList<Int>()
        for (dy in 0 until g.rows) for (dx in 0 until g.cols) if ((engine.deeds[dy * g.cols + dx].toInt() and 0xff) == 255 && (dx + dy) % 3 == 0) { xs += dx; ys += dy }
        val n = xs.size
        localX = xs.toIntArray(); localY = ys.toIntArray()
        // the HUD's convention: WorldBases carry CATALOG columns/rows (tileId = y × 720 + x)
        val tiles = IntArray(n) { g.tileId(localX[it], localY[it]) }
        return WorldBases(7, realm, IntArray(n) { tiles[it] % RealmGrid.LATTICE_W }, IntArray(n) { tiles[it] / RealmGrid.LATTICE_W },
            IntArray(n) { 1 + it % 20 }, IntArray(n) { RealmBases.FLAG_OCCUPIED or (if (it == 0) RealmBases.FLAG_MINE else 0) })
    }

    @Test fun `dive readiness rehearses every pair the realm will draw, into scratch targets only, one per frame`() {
        val frames = ready()
        val stats = engine.stats
        // (10 since the selected open deed's box, owner 2026-09-26: it draws live on the screen, so the dive rehearses it too)
        assertEquals(10, stats.pairsTotal, "overview, blit, minimap and dots on the screen and an RGBA8 target, plus the fade composite and the selected deed's box")
        assertEquals(stats.pairsTotal, stats.pairsRehearsed)
        assertEquals(1.0, engine.readiness())
        assertTrue(frames >= stats.pairsTotal, "one pair per frame: $frames frames")
        val screenDraws = rig.gl.draws.filter { it.framebuffer == 0 }
        assertTrue(screenDraws.isEmpty(), "a rehearsal drew on the screen: ${screenDraws.size}")
        assertTrue(rig.gl.draws.all { it.scissor && it.scissorW == 1 && it.scissorH == 1 }, "every rehearsal draw is 1×1-scissored")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
        assertTrue(failures.isEmpty(), failures.joinToString())
    }

    @Test fun `the first realm frames, the half-scale ground, the snapshot and the fade composite build no pipeline`() {
        ready()
        enterAlpha()
        engine.setBases(bases())
        repeat(3) { realmFrame() }
        engine.ladderLevel = 1 // k ½: the ground renders into the low target and is scaled up
        repeat(3) { realmFrame() }
        assertEquals(0.5, engine.stats.groundScale)
        // a leave: the last realm frame into the snapshot, then the globe with the composite on top
        rig.nowMs += 16.667; rig.begin(); engine.update(rig.nowMs, false)
        assertTrue(engine.renderSnapshot(rig.nowMs.toLong(), false))
        rig.core.beginScreen(0f, 0f, 0f, 1f); engine.fade.start(RealmDiveFade.LEAVE, rig.nowMs); engine.compositeFade(rig.nowMs + 100); rig.end()
        assertEquals(0L, rig.core.stats.liveFirstDraws, "a pair drawn live for the first time is a Mali pipeline build in a frame")
        assertEquals(0L, rig.core.stats.orderViolations)
        assertTrue(rig.gl.draws.any { it.framebuffer == 0 }, "the realm drew on the screen")
    }

    @Test fun `a realm frame binds offscreen targets first and the screen exactly once, and invalidates depth`() {
        ready(); enterAlpha()
        engine.ladderLevel = 1
        realmFrame()
        rig.gl.framebufferHistory.clear(); val inval = rig.gl.invalidations
        realmFrame()
        val history = rig.gl.framebufferHistory.toList()
        assertEquals(1, history.count { it == 0 }, "the default framebuffer is bound once: $history")
        assertTrue(history.indexOf(0) > 0 && history.take(history.indexOf(0)).all { it != 0 }, "offscreen before the screen: $history")
        assertTrue(rig.gl.invalidations > inval, "depth invalidated before the swap")
    }

    @Test fun `a fade carries no compile, rehearsal or upload, and bases arriving in it are uploaded after`() {
        ready(); enterAlpha()
        realmFrame()
        val calls = listOf("compileShader", "linkProgram", "texSubImage2D", "texSubImage3D", "texStorage2D", "bufferData", "copyImageSubData")
        rig.gl.log.clear(); rig.worker.log.clear(); val rehearsed = rig.core.stats.rehearsalDraws
        engine.fade.start(RealmDiveFade.DIVE, rig.nowMs)
        engine.setBases(bases())
        while (!engine.fade.done(rig.nowMs)) {
            rig.nowMs += 16.667; rig.begin()
            engine.update(rig.nowMs, false) // the host: no work in a fade
            rig.core.beginScreen(0f, 0f, 0f, 1f); engine.compositeFade(rig.nowMs); rig.end()
        }
        for (c in calls) assertEquals(0, rig.gl.calls(c), "$c inside the fade")
        assertEquals(rehearsed, rig.core.stats.rehearsalDraws)
        assertTrue(engine.stats.deferredUploads > 0)
        engine.fade.finish()
        realmFrame()
        assertTrue(rig.gl.calls("texSubImage2D") > 0 && rig.gl.calls("bufferData") > 0, "the deferred occupancy and minimap uploads ran after the fade")
    }

    @Test fun `the fade's realm opacity rises on a dive, falls on a leave and is exactly 0 or 1 at rest`() {
        val f = engine.fade
        assertEquals(1.0, f.realmAlpha(0.0))
        f.start(RealmDiveFade.DIVE, 100.0)
        assertEquals(0.0, f.realmAlpha(100.0)); assertEquals(1.0, f.realmAlpha(100.0 + RealmDiveFade.PLAN_FADE_MS))
        var last = -1.0
        for (t in 0..45) { val a = f.realmAlpha(100.0 + t * 10); assertTrue(a >= last, "monotone"); last = a }
        f.start(RealmDiveFade.LEAVE, 0.0)
        assertEquals(1.0, f.realmAlpha(0.0)); assertEquals(0.0, f.realmAlpha(RealmDiveFade.PLAN_FADE_MS))
        assertEquals(0.5, RealmDiveFade.cssEase(0.5), 0.35) // CSS ease at mid-time is ~0.80 in y: well inside (0.15, 0.85)
        assertEquals(0.8024, RealmDiveFade.cssEase(0.5), 1e-3)
    }

    @Test fun `entry keeps the globe's scale up to FAR and the overview never zooms past FAR`() {
        ready()
        engine.setViewport(240, 520, 2.0) // the fixture realm is 12 deeds wide: this screen fits it below FAR, like a real realm
        val g = engine.grid!!
        assertTrue(engine.cam.sMin() * 2.0 < RealmWebPin.BANDS.farEnd)
        assertTrue(engine.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        assertEquals(maxOf(20.0, engine.cam.sMin() * 2.0), engine.cam.d, 1e-9, "d = min(sStart·dpr, farEnd), never below the fit")
        realmFrame()
        assertTrue(engine.stats.overviewClamp)
        engine.zoomBy(2.2); engine.zoomBy(2.2)
        repeat(60) { realmFrame() }
        assertTrue(engine.cam.d <= RealmWebPin.BANDS.farEnd + 1e-9, "overview mode clamps to FAR: d ${engine.cam.d}")
        // at the clamp edge (d = farEnd) bandOf says far-map, but the weights are pure FAR: one chart pass, no fade
        assertEquals(1.0, engine.view.bands.far); assertEquals(0.0, engine.view.bands.fadeWeight)
    }

    @Test fun `taps pick bases and open catalog deeds, report the server tile, and filters feed the occupancy and minimap`() {
        ready(); enterAlpha()
        val b = bases(); engine.setBases(b)
        realmFrame()
        val cam = engine.cam
        val bx = localX[1]; val by = localY[1]
        engine.onTap(cam.deedToScreenX(bx + 0.5), cam.deedToScreenY(by + 0.5))
        val sel = selections.last()
        assertEquals(1, sel[0]); assertEquals(bx, sel[1]); assertEquals(engine.grid!!.tileId(bx, by), sel[3])
        // an open deed of this realm
        val g = engine.grid!!
        var ox = -1; var oy = -1
        loop@ for (dy in 0 until g.rows) for (dx in 0 until g.cols) if ((engine.deeds[dy * g.cols + dx].toInt() and 0xff) == 255 && engine.bases.baseAt(dx, dy) < 0) { ox = dx; oy = dy; break@loop }
        engine.onTap(cam.deedToScreenX(ox + 0.5), cam.deedToScreenY(oy + 0.5))
        assertEquals(listOf(-1, ox, oy), selections.last().take(3))
        engine.setFilter(WorldFilter(WorldFilterKind.MINE))
        assertEquals(1, engine.bases.filteredCount)
        assertTrue(engine.bases.filterActive)
        // SHARDKEEP D-191: UNSHIELDED passes only a shield bit the read carried as false. The snapshot says which bits it
        // carried (shieldKnown) and that must survive the catalog → local mapping; a snapshot without it passes nothing.
        val n = b.size
        val flags = IntArray(n) { b.flags[it] or (if (it % 2 == 0) RealmBases.FLAG_SHIELD else 0) }
        val known = BooleanArray(n) { it % 3 != 0 }
        engine.setBases(WorldBases(8, "alpha", b.deedX, b.deedY, b.level, flags, known))
        engine.setFilter(WorldFilter(WorldFilterKind.UNSHIELDED))
        assertEquals((0 until n).count { known[it] && it % 2 != 0 }, engine.bases.filteredCount, "known and clear bits only")
        engine.setBases(WorldBases(9, "alpha", b.deedX, b.deedY, b.level, flags))
        assertEquals(0, engine.bases.filteredCount, "a snapshot that carries no shield bits passes nothing: never faked")
    }

    @Test fun `the core's stand-in dots hide a filtered-out kingdom on the main view while the minimap keeps every base`() {
        // SHARDKEEP D-191: until a bases lane draws the bases (none is wired here, as on a device while the lane opens, is
        // held, or failed), the core stands in with occupancy dots on the main view. They obey the lane's rule: a kingdom
        // that fails the filter is HIDDEN, never dimmed to 15 % (the look players read as "the filter does nothing"), and
        // the selected kingdom always draws. The minimap's own scissored pass keeps every base (filtered-in solid, the
        // rest dim) as context, so its count never moves.
        ready(); enterAlpha()
        val b = bases(); engine.setBases(b)
        val dots = engine.programs!!.dots.handle
        fun settle() { var i = 0; while (realmFrame() && i++ < 300) Unit }
        /** (main-view stand-in instances, minimap instances) of one settled frame; 0 when the stand-in did not draw. */
        fun passes(): Pair<Int, Int> {
            settle()
            val before = rig.gl.draws.size
            realmFrame()
            val f = rig.gl.draws.subList(before, rig.gl.draws.size).filter { it.program == dots && it.framebuffer == 0 }
            val main = f.filter { !it.scissor }; val mini = f.filter { it.scissor }
            assertTrue(main.size <= 1 && mini.size == 1, "at most one stand-in pass and one minimap pass (${main.size}, ${mini.size})")
            return (main.firstOrNull()?.instances ?: 0) to mini[0].instances
        }
        val n = b.size
        assertEquals(n to n, passes(), "no filter: every base once, on both")
        engine.setFilter(WorldFilter(WorldFilterKind.ALL, 7..20))
        val kept = engine.bases.filteredCount
        assertTrue(kept in 1 until n, "the range leaves some out ($kept of $n)")
        assertEquals(kept to n, passes(), "level 7-20: the stand-in draws the kept kingdoms only; the minimap keeps all $n")
        assertTrue(engine.stats.occupancyDots)
        val out = (0 until n).first { !engine.bases.passes(it) }
        engine.select(out)
        assertEquals(kept + 2 to n + 1, passes(), "the selected kingdom draws (its dot and the selection ring); the minimap adds the ring only")
        engine.select(-1)
        assertEquals(kept to n, passes(), "and hides again once its card is down")
        engine.setFilter(WorldFilter(WorldFilterKind.UNSHIELDED))
        assertEquals(0, engine.bases.filteredCount, "no read carried a shield bit")
        assertEquals(0 to n, passes(), "nothing passes, nothing stands in (never faked); the minimap still shows the realm")
        assertFalse(engine.stats.occupancyDots)
    }

    @Test fun `pause-time dispose issues only deletes and never waits`() {
        ready(); enterAlpha(); realmFrame()
        val blocking = rig.gl.blockingCalls
        rig.gl.log.clear()
        engine.dispose()
        assertEquals(blocking, rig.gl.blockingCalls)
        val allowed = setOf("deleteTexture", "deleteFramebuffer", "deleteSync", "deleteBuffer", "deleteVertexArray", "deleteProgram")
        assertTrue(rig.gl.log.all { it in allowed }, "dispose issued ${rig.gl.log.toSet() - allowed}")
        assertFalse(engine.active)
    }

    @Test fun `a context loss restores the realm behind the deep sea, keeping camera, bases and selection`() {
        ready(); enterAlpha()
        val b = bases(); engine.setBases(b); realmFrame()
        engine.select(2)
        var settle = 0
        while (engine.cam.moving && settle < 300) { realmFrame(); settle++ }
        val x = engine.cam.x; val y = engine.cam.y
        rig.contextId++ // the EGL context changed
        realmFrame()
        assertFalse(engine.ready)
        var frames = 0
        while (!engine.ready && frames < 200) { realmFrame(); frames++ }
        assertTrue(engine.ready, "restored after $frames frames")
        assertEquals(b.size, engine.bases.size); assertEquals(2, engine.bases.selectedBase)
        assertEquals(x, engine.cam.x, 1e-9); assertEquals(y, engine.cam.y, 1e-9)
        realmFrame()
        assertEquals(0L, rig.core.stats.liveFirstDraws, "the restored realm rehearsed before it drew")
    }

    @Test fun `a pack that fails its checks reports and never opens`() {
        val bad = RealmMapEngine(rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
            RealmLoader(FixturePack("tampered"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS)
        val reasons = ArrayList<String>()
        bad.listener = object : RealmMapListener { override fun onFailed(realmId: String, reason: String) { reasons += reason } }
        bad.setViewport(914, 2034, 2.0)
        bad.prepare("alpha")
        repeat(5) { rig.nowMs += 16.0; rig.begin(); bad.update(rig.nowMs, true); rig.end() }
        assertEquals(RealmMapEngine.STATUS_FAILED, bad.status)
        assertTrue(reasons.single().contains("sha256"))
        assertFalse(bad.enter(0.0, 0.0, 10.0))
    }

    @Test fun `a Select intent on a deed picks its base, an open deed of this realm, and never another realm's deed`() {
        ready(); enterAlpha()
        val b = bases(); engine.setBases(b)
        engine.selectDeed(localX[3], localY[3])
        assertEquals(3, engine.bases.selectedBase)
        val g = engine.grid!!
        var other = -1 to -1; var open = -1 to -1
        for (dy in 0 until g.rows) for (dx in 0 until g.cols) {
            val v = engine.deeds[dy * g.cols + dx].toInt() and 0xff
            if (v != 255 && other.first < 0) other = dx to dy
            if (v == 255 && engine.bases.baseAt(dx, dy) < 0 && open.first < 0) open = dx to dy
        }
        engine.selectDeed(open.first, open.second)
        assertEquals(listOf(-1, open.first, open.second), listOf(engine.bases.selectedBase, engine.bases.selectedX, engine.bases.selectedY))
        engine.selectDeed(other.first, other.second)
        assertFalse(engine.bases.hasSelection, "a deed outside this realm is not selectable")
        engine.selectDeed(-4, 2)
        assertFalse(engine.bases.hasSelection)
    }

    @Test fun `server bases and HUD intents in catalog columns land on the right local deeds, across the dateline too`() {
        // the wrap fixture realm starts at catalog column x0 = -3: columns 717..719 are its first three
        val wrap = RealmMapEngine(rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
            RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS)
        wrap.setViewport(914, 2034, 2.0)
        assertTrue(wrap.prepare("wrap"))
        var frames = 0
        while (!wrap.ready && frames < 200) {
            rig.compiler.runAll(); rig.nowMs += 16.667; check(rig.begin()); wrap.update(rig.nowMs, true); rig.uploads.poll(rig.core)
            wrap.rehearseStep(rig.nowMs); rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end(); frames++
        }
        val g = wrap.grid!!
        assertTrue(g.x0 < 0)
        var lx = -1; var ly = -1
        loop@ for (dy in 0 until g.rows) for (dx in 0 until minOf(-g.x0, g.cols)) if ((wrap.deeds[dy * g.cols + dx].toInt() and 0xff) == 255) { lx = dx; ly = dy; break@loop }
        assertTrue(lx >= 0, "the fixture has a deed west of the antimeridian")
        val t = g.tileId(lx, ly); val cx = t % RealmGrid.LATTICE_W; val cy = t / RealmGrid.LATTICE_W
        assertTrue(cx >= RealmGrid.LATTICE_W + g.x0, "a catalog column at the lattice's east end: $cx")
        wrap.setBases(WorldBases(1, "wrap", intArrayOf(cx, 3), intArrayOf(cy, 0), intArrayOf(5, 5), intArrayOf(RealmBases.FLAG_OCCUPIED, RealmBases.FLAG_OCCUPIED)))
        assertEquals(1, wrap.bases.size, "the base outside this realm's grid is dropped")
        assertEquals(lx, wrap.bases.deedX[0]); assertEquals(ly, wrap.bases.deedY[0])
        wrap.selectCatalogDeed(cx, cy)
        assertEquals(0, wrap.bases.selectedBase)
        assertTrue(wrap.flyToCatalogDeed(cx, cy, 20.0))
        assertFalse(wrap.flyToCatalogDeed(3, 0, 20.0), "a deed outside the grid is no fly target")
        wrap.dispose()
    }

    @Test fun `a tap is offered to the HUD first with its catalog deed, and the engine selects only when the HUD declines`() {
        ready(); enterAlpha()
        val b = bases(); engine.setBases(b); realmFrame()
        val offered = ArrayList<IntArray>()
        var answer = true
        engine.listener = object : RealmMapListener {
            override fun onSelection(base: Int, deedX: Int, deedY: Int, tileId: Int) { selections += intArrayOf(base, deedX, deedY, tileId) }
            override fun onTap(catalogX: Int, catalogY: Int, cssX: Double, cssY: Double): Boolean { offered += intArrayOf(catalogX, catalogY); return answer }
        }
        val cam = engine.cam
        val before = selections.size
        engine.onTap(cam.deedToScreenX(localX[1] + 0.5), cam.deedToScreenY(localY[1] + 0.5))
        assertEquals(listOf(b.deedX[1], b.deedY[1]), offered.last().toList(), "the HUD gets the catalog deed under the finger")
        assertEquals(before, selections.size, "the HUD answered: the engine selected nothing")
        answer = false
        engine.onTap(cam.deedToScreenX(localX[1] + 0.5), cam.deedToScreenY(localY[1] + 0.5))
        assertEquals(1, selections.last()[0], "declined: map.js onTap picks and selects the base")
    }

    @Test fun `a steady realm frame allocates nothing on the GL thread`() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        check(bean.isThreadAllocatedMemorySupported); bean.isThreadAllocatedMemoryEnabled = true
        ready(); enterAlpha(); engine.setBases(bases())
        rig.gl.record = false; rig.worker.record = false
        engine.ladderLevel = 1
        repeat(300) { realmFrame() }
        fun steady() { // the host's steady frame: no compiler or uploader polling (the harness's own lists allocate)
            rig.nowMs += 16.667
            check(rig.begin()); engine.update(rig.nowMs, true); engine.frame(rig.nowMs, rig.nowMs.toLong(), false); rig.end()
        }
        repeat(300) { steady() }
        var allocated = -1L; var windows = 0
        while (allocated != 0L && windows < 20) {
            val before = bean.currentThreadAllocatedBytes
            repeat(600) { steady() }
            allocated = bean.currentThreadAllocatedBytes - before
            windows++
        }
        assertEquals(0L, allocated, "all $windows windows of 600 steady realm frames allocated (the last: $allocated bytes)")
    }
}
