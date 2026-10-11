package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.gl3.ProgramBuilder
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.FakeGroundUploads
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundLane
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.GroundPrograms
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.RecordingSink
import gg.pixelkingdomwars.nativeclient.renderer.realmmap.detail.ground.SyntheticGroundPack
import gg.pixelkingdomwars.nativeclient.renderer.world.FrameLadder
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderInputs
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The owner must not wait more than ~1 s for a realm map (2026-09-26, code 29.1 on the Seeker: "5 seconds delay is too
 * much for displaying the map of each realm ... optimize it to under 1 second"). The Seeker's log put the cold dives at
 * 2.6–3.0 s and the first at 5.7 s, every second of it D-173's lane items of dive readiness (GROUND settled, the lanes'
 * MAP sets rehearsed through a 1.5–6 s retry back-off, the landing view's lattice), where the pre-D-173 dives took
 * 0.7–0.8 s on the core's FAR set alone. D-NEXT (amends D-173):
 * - dive readiness is the core's FAR set only (first-frame textures, core programs, the 10 core pairs): a warm dive enters
 *   at once and a cold one waits exactly as long as a realm with no lanes, whatever the lanes are doing;
 * - the "Enter map" meter the HUD shows and the host's dive bound reads never goes back and reaches 1 only at READY;
 * - the band-gate stall valve (the only valve left) keeps 36f9067's rules: every slow frame counts in full (SwiftShader's
 *   0.35–4.5 s frames, a slow phone at the ladder's L2), a panned or flung camera never trips it, and progress that goes
 *   back and forth is not progress.
 * The six D-173 tests here were rewritten to pin these rules (none deleted).
 */
class RealmDiveWaitTest {
    private val rig = RealmGlRig()
    private val sources = RealmPrograms.load()
    private val stallMs = RealmWebPin.REHEARSAL.stallMs
    /** WorldEngineHost.DIVE_STALL_MS on a device: the valve plus 4 s (the app's WorldEngineIntegrationTest pins it). */
    private val hostBoundMs = stallMs + 4_000.0
    /** Build every queued program each frame (a warm program cache); false: the test links them itself. */
    private var compileAll = true
    private val lanePolls = ArrayList<FakeGroundUploads>()
    private val bands = RealmWebPin.BANDS

    private fun engineWith(vararg lanes: RealmLane): RealmMapEngine = RealmMapEngine(
        rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
        RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS,
        shaderSources = { sources }, lanes = lanes.toList(),
    ).apply { setViewport(240, 520, 2.0) }

    private fun lane(name: String, vararg programs: String, create: Boolean = true) =
        FakeLane(rig.core, name, programs.toList()).apply { if (create) createOnOpen = sources }

    /** A lane whose load stays on the worker: no programs, not settled, no band (LIFE's build in the code-29 smoke). */
    private fun loading(name: String, vararg programs: String) =
        lane(name, *programs, create = false).apply { settledValue = false; bandSetValue = 0; readySets = intArrayOf() }

    /** WorldEngineHost's `DiveStall`: the dive is answered once the readiness the host reads has not changed for longer
     *  than [boundMs]. */
    private class HostBound(private val boundMs: Double) {
        private var mark = Double.NaN
        var movedMs = 0.0; private set
        var changes = 0; private set
        fun start(nowMs: Double) { mark = Double.NaN; movedMs = nowMs; changes = 0 }
        fun stalled(nowMs: Double, readiness: Double): Boolean {
            if (readiness != mark) { mark = readiness; movedMs = nowMs; changes++; return false }
            return nowMs - movedMs > boundMs
        }
    }

    private fun poll() { rig.uploads.poll(rig.core); for (p in lanePolls) p.poll(rig.core) }

    /** A MODE_GLOBE frame in the host's order: update, the uploads, the idle rehearsal step (none while the globe moves). */
    private fun globeFrame(e: RealmMapEngine, dtMs: Double = 16.667, globeMoving: Boolean = false) {
        if (compileAll) rig.compiler.runAll()
        rig.nowMs += dtMs
        check(rig.begin()); e.update(rig.nowMs, true); poll()
        if (!globeMoving && (!e.ready || e.prefetchDue)) e.rehearseStep(rig.nowMs)
        rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end()
    }

    /**
     * A MODE_DIVE_WAIT frame (WorldEngineHost.diveStep): update, the uploads, then while not dive-ready one rehearsal step
     * and the readiness the host posts and bounds; once ready, the entry at the globe's point. Returns 1 when it entered,
     * −1 when the host gave up, 0 while it waits.
     */
    private fun diveFrame(e: RealmMapEngine, host: HostBound, dtMs: Double = 16.667, sStart: Double = 10.0): Int {
        if (compileAll) rig.compiler.runAll()
        rig.nowMs += dtMs
        check(rig.begin()); e.update(rig.nowMs, true); poll()
        var r = 0
        if (!e.ready) { e.rehearseStep(rig.nowMs); if (host.stalled(rig.nowMs, e.readiness())) r = -1 }
        else {
            val g = e.grid!!
            assertTrue(e.enter(g.lonAt(6.0), g.latAt(4.0), sStart))
            assertTrue(e.renderSnapshot(rig.nowMs.toLong(), false)); e.fade.start(RealmDiveFade.DIVE, rig.nowMs); r = 1
        }
        rig.core.beginScreen(0f, 0f, 0f, 1f); if (r == 1) e.compositeFade(rig.nowMs); rig.end()
        return r
    }

    /** The host's dive from its start: dive-wait frames until the entry. Returns the wait frames (the entry's excluded). */
    private fun dive(e: RealmMapEngine, each: (Int) -> Unit = {}): Int {
        if (e.realmId != "alpha") assertTrue(e.prepare("alpha")) // WorldEngineHost.beginDive
        val host = HostBound(hostBoundMs); host.start(rig.nowMs)
        var i = 0
        while (true) {
            each(i)
            val r = diveFrame(e, host)
            assertTrue(r >= 0, "the host gave up on the dive (meter ${e.readiness()})")
            if (r == 1) return i
            i++
            assertTrue(i < 2_000, "no entry")
        }
    }

    /** The fade over the globe (no work, no realm frame), then the first live frame. */
    private fun fadeIn(e: RealmMapEngine) {
        while (!e.fade.done(rig.nowMs)) {
            rig.nowMs += 16.667; check(rig.begin()); e.update(rig.nowMs, false)
            rig.core.beginScreen(0f, 0f, 0f, 1f); e.compositeFade(rig.nowMs); rig.end()
        }
        e.fade.finish()
    }

    private fun realmFrame(e: RealmMapEngine, dtMs: Double = 16.667): Boolean {
        if (compileAll) rig.compiler.runAll()
        rig.nowMs += dtMs
        check(rig.begin()); e.update(rig.nowMs, true); poll()
        if (e.waiting) e.rehearseStep(rig.nowMs)
        val moving = e.frame(rig.nowMs, rig.nowMs.toLong(), false)
        rig.end()
        return moving
    }

    @Test fun `a warm dive enters at once and the realm draws live on its first frame while every lane is still loading`() {
        // was "a dive at 70 percent on SwiftShader's frame cadence lands through the landing valve": there is no landing
        // valve; a dive whose core the globe's approach prefetch readied waits for nothing
        val lanes = arrayOf(loading("ground", "rm-map").apply { groundBands = 1 }, loading("life", "life-stand"), loading("bases", "bases-sprite"))
        val e = engineWith(*lanes)
        assertTrue(e.prepare("alpha", lanes = false)) // the globe's approach: the core's FAR set only
        var n = 0; while (!e.ready && n < 200) { globeFrame(e); n++ }
        assertTrue(e.ready)
        assertTrue(lanes.all { it.opened.isEmpty() }, "a core-only prepare opens no lane")
        assertEquals(0, dive(e), "a warm dive waits no frame")
        fadeIn(e)
        val drawn = e.stats.framesDrawn
        realmFrame(e)
        assertEquals(drawn + 1, e.stats.framesDrawn, "the first live frame draws the realm")
        realmFrame(e)
        assertEquals(drawn + 2, e.stats.framesDrawn)
        assertFalse(e.cam.moving, "and it is at rest: nothing lands after the fade")
        assertEquals(1, lanes[0].opened.size, "the lanes open after the entry, GROUND first")
        assertTrue(lanes[1].opened.isEmpty() && lanes[2].opened.isEmpty(), "one load at a time: GROUND is still loading")
        assertTrue(lanes.none { it.settledValue }, "every lane still loading")
    }

    @Test fun `a cold dive waits exactly as long as a realm with no lanes, and the lanes open only after READY`() {
        // was "a pinch-in dive whose lanes link a program every 2 s ...": lanes never delay the dive; with the real GROUND
        // lane at the ladder's L2 (hypothesis (b) of the smoke) its load and lattice come after the landing, on the map
        val warm = engineWith(); dive(warm); warm.dispose() // links the core's programs: both dives below find them linked
        val bare = engineWith()
        val coldBare = dive(bare)
        bare.dispose()
        val pack = SyntheticGroundPack(id = "alpha", cols = 12, rows = 8)
        val uploads = FakeGroundUploads(rig.worker).also { lanePolls += it }
        val ground = GroundLane(rig.core, RecordingSink(), uploads, { pack }, { GroundPrograms.load(it) }, nowMs = { rig.nowMs })
        val life = loading("life", "life-stand")
        val e = engineWith(ground, life)
        e.setViewport(160, 360, 2.0) // the 12 × 8 realm fits at d ≈ 13, below 0.75 × farEnd like a real realm on the Seeker
        e.ladderKnobs = FrameLadder(LadderPolicy.PLAN, LadderInputs(1.5, 40_000)).knobs; e.ladderLevel = 2
        var openedBeforeReady = 0
        val cold = dive(e, each = { openedBeforeReady = openedBeforeReady or e.stats.lanesOpened })
        assertEquals(coldBare, cold, "the lanes added no dive frame")
        assertEquals(0, openedBeforeReady, "no lane opened before READY")
        fadeIn(e)
        val x = e.cam.x; val y = e.cam.y; val s = e.cam.s
        var n = 0; while (!ground.readyFor(1) && n < 3_000) { realmFrame(e); n++ }
        assertTrue(ground.readyFor(1), "GROUND's MAP data came in on the map (status ${ground.stats.status} ${ground.stats.error})")
        assertTrue(e.stats.lanesOpened and 1 != 0)
        assertEquals(x, e.cam.x, 0.0); assertEquals(y, e.cam.y, 0.0); assertEquals(s, e.cam.s, 0.0, "the camera never moved meanwhile")
        assertEquals(1, life.opened.size, "LIFE opened once GROUND settled")
    }

    @Test fun `the entry opens GROUND at once, so its load runs under the dive's fade, warm or cold`() {
        // D-177 (smoothness first). The lanes opened only in work frames, and the 450 ms dive fade has none. So a pinch-dive
        // after the approach's core-only prefetch started GROUND's decode after the fade, and the first pinch-in stood at
        // farEnd ('detail N%', the loading hold) that much longer: the Seeker's code 29.1 had GROUND 0/1 two seconds in.
        // Opening a lane only starts its worker decode (no upload, no draw), so the entry itself may do it.
        fun lanes() = arrayOf(loading("ground", "rm-map").apply { groundBands = 1 }, loading("life", "life-stand"))
        val warmLanes = lanes()
        val warm = engineWith(*warmLanes)
        assertTrue(warm.prepare("alpha", lanes = false)) // the approach, then a rest: the core is READY before the dive
        var n = 0; while (!warm.ready && n < 200) { globeFrame(warm); n++ }
        assertTrue(warmLanes.all { it.opened.isEmpty() }, "a core-only prepare opens no lane")
        assertEquals(0, dive(warm))
        assertEquals(1, warmLanes[0].opened.size, "GROUND opened by the entry's own frame, before the fade's first")
        assertTrue(warmLanes[1].opened.isEmpty(), "one load at a time")
        fadeIn(warm)
        assertTrue(warmLanes[1].opened.isEmpty(), "the fade opens nothing more")
        warm.dispose()
        val coldLanes = lanes()
        val cold = engineWith(*coldLanes)
        assertTrue(cold.prepare("alpha", lanes = false)) // a pinch through the approach: the dive starts while the core loads
        assertTrue(dive(cold) > 0, "a cold dive waits for its core")
        assertEquals(1, coldLanes[0].opened.size, "GROUND opened by the entry's own frame, before the fade's first")
        assertTrue(coldLanes[1].opened.isEmpty(), "one load at a time")
    }

    @Test fun `the Enter-map meter moves with each core link, never goes back, and reaches 1 only at READY`() {
        // was "raw progress that goes back and forth ... for the valve and the meter": the meter counts the core's FAR set
        // alone now; lanes that open, load and add programs after READY never touch it
        val lanes = arrayOf(lane("ground", "rm-map").apply { groundBands = 1 }, lane("life", "life-stand", "life-bird"))
        val e = engineWith(*lanes)
        compileAll = false
        val builder = ProgramBuilder(rig.worker, null, "RealmView", 0)
        var linkAt = rig.nowMs + 2_000.0
        var last = 0.0; var links = 0
        val host = HostBound(hostBoundMs)
        assertTrue(e.prepare("alpha")); host.start(rig.nowMs)
        var n = 0
        while (!e.ready && n < 5_000) {
            if (rig.nowMs >= linkAt && rig.compiler.queued.isNotEmpty()) { builder.build(rig.compiler.queued.removeAt(0)); links++; linkAt += 2_000.0 }
            rig.nowMs += 16.667; check(rig.begin()); e.update(rig.nowMs, true); poll()
            if (!e.ready) {
                e.rehearseStep(rig.nowMs)
                val r = e.readiness()
                assertTrue(r >= last, "the meter went back: $last → $r"); last = r
                assertTrue(r < 1.0, "1 before READY")
                assertFalse(host.stalled(rig.nowMs, r), "the host's bound cut a dive whose core links every 2 s")
            }
            rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end(); n++
        }
        assertTrue(e.ready); assertEquals(1.0, e.readiness())
        assertTrue(links >= e.programs!!.all.size, "every core program linked before READY: $links links")
        assertTrue(host.changes >= links, "the meter moved with the links: ${host.changes} changes")
        compileAll = true
        repeat(120) { globeFrame(e); assertEquals(1.0, e.readiness(), "lane work after READY never moves the meter") }
        assertTrue(lanes.all { it.opened.size == 1 }, "the lanes opened after READY meanwhile")
    }

    @Test fun `on SwiftShader's frame cadence the band-gate valve opens stallMs after the gate stopped progressing`() {
        // 36f9067's first rule, moved from D-173's landing valve: every frame's FULL interval counts when the frame before it
        // gave the gate its chance. The smoke's frames came 0.375 s apart and every seventh took 4.5 s: counting at most
        // 250 ms of each opened the valve after ~31 s of wall time; a slow phone at L2 would wait as long
        val stuck = lane("ground", "rm-map", create = false).apply { groundBands = 1 }
        val e = engineWith(stuck)
        dive(e); fadeIn(e)
        realmFrame(e)
        compileAll = false
        stuck.create(sources) // queued on the compiler, which never runs again: its MAP pair gates farEnd for good
        realmFrame(e)
        assertEquals(RealmMapEngine.GATE_REHEARSAL, e.stats.gateReason); assertEquals(bands.farEnd, e.stats.limitD)
        e.zoomBy(2.2) // the player pushes against the edge and leaves the + pending
        val t0 = rig.nowMs
        var i = 0; while (!e.stats.valveOpened && rig.nowMs - t0 < 60_000) { realmFrame(e, if (i % 7 == 6) 4_500.0 else 375.0); i++ }
        assertTrue(e.stats.valveOpened, "the valve opened")
        assertTrue(rig.nowMs - t0 >= stallMs, "after stallMs: ${rig.nowMs - t0} ms")
        assertTrue(rig.nowMs - t0 < stallMs + 4_500.0 + 1.0, "in the first frame from stallMs on: ${rig.nowMs - t0} ms")
        var k = 0; while ((e.cam.moving || e.cam.d <= bands.farEnd * 1.01) && k < 100) { realmFrame(e, 375.0); k++ }
        assertTrue(e.cam.d > bands.farEnd * 1.01, "the push went on past the edge: d ${e.cam.d}")
        assertEquals(1, e.stats.lanesHeld, "the lane whose pipeline is not built stays held: it draws nothing")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
    }

    @Test fun `a panned or flung camera never trips the band-gate valve, and idle frames count again after it`() {
        // the valve counts only frames that gave the gate its chance: a player dragging the overview about for 25 s is not
        // waiting at the MAP edge, and the gate they have not reached must still hold when they do
        val stuck = lane("ground", "rm-map", create = false).apply { groundBands = 1 }
        val e = engineWith(stuck)
        dive(e); fadeIn(e); realmFrame(e)
        compileAll = false
        stuck.create(sources); realmFrame(e)
        assertEquals(RealmMapEngine.GATE_REHEARSAL, e.stats.gateReason)
        var t = rig.nowMs; var x = 40.0; var dir = 1.0
        e.touchDown(1, x, 130.0, t)
        repeat(1_500) { // 25 s of dragging back and forth
            x += 6.0 * dir; if (x > 100 || x < 20) dir = -dir; t += 16.667
            e.touchMove(1, x, 130.0, t); realmFrame(e)
        }
        e.touchUp(1, x + 30 * dir, 130.0, t + 8) // a fling: the camera coasts on
        var coast = 0; while (e.cam.moving && coast < 400) { realmFrame(e); coast++ }
        assertFalse(e.stats.valveOpened, "no chance, no valve")
        val t0 = rig.nowMs
        var n = 0; while (!e.stats.valveOpened && n < 2_000) { realmFrame(e); n++ }
        assertTrue(e.stats.valveOpened)
        assertTrue(rig.nowMs - t0 >= stallMs - 50.0, "stallMs of idle frames: ${rig.nowMs - t0} ms")
        assertTrue(rig.nowMs - t0 <= stallMs + RealmWebPin.REHEARSAL.idleMs + 100.0, "and no more: ${rig.nowMs - t0} ms")
    }

    @Test fun `progress that goes back and forth without getting further never holds the band-gate valve shut`() {
        // 36f9067's second rule, moved to the band gate: a count that falls and comes back (a lane that reports its load
        // twice, a pair asked again) is not a map getting closer. Reset by every change, the valve never opened and the
        // player's zoom stayed stuck at the MAP edge for as long as the lane flickered
        val stuck = lane("ground", "rm-map", create = false).apply { groundBands = 1 }
        val flaky = lane("life", "life-stand").apply { hookDraws = false; readySets = intArrayOf() }
        val e = engineWith(stuck, flaky)
        dive(e); fadeIn(e)
        var k = 0; while (flaky.opened.isEmpty() && k < 20) { realmFrame(e); k++ }
        assertEquals(1, flaky.opened.size)
        realmFrame(e) // its program links
        compileAll = false
        stuck.create(sources); realmFrame(e)
        assertEquals(RealmMapEngine.GATE_REHEARSAL, e.stats.gateReason)
        var i = 0
        val t0 = rig.nowMs
        while (!e.stats.valveOpened && i < 3_000) { flaky.settledValue = i % 2 == 0; realmFrame(e); i++ }
        assertTrue(e.stats.valveOpened, "the valve opened")
        assertTrue(rig.nowMs - t0 in stallMs..stallMs + 250.0, "stallMs after the last real progress: ${rig.nowMs - t0} ms")
    }
}
