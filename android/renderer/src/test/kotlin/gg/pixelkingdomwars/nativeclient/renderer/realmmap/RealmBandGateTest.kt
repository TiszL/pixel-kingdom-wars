package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.world.FrameLadder
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderInputs
import gg.pixelkingdomwars.nativeclient.renderer.world.LadderPolicy
import gg.pixelkingdomwars.nativeclient.renderer.world.WorldBases
import org.junit.Test
import java.lang.management.ManagementFactory
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * N3 in the core: the MAP and TRUE bands behind band readiness (map.js `bandGate`, `laneHeld`, `rehearse`; W1 S1/S2/S8),
 * with the detail lanes plugged in through [RealmLane]. What each test protects (the D-167 bar on the Seeker):
 * - no first-use hitch: a band is entered only after every (program, state) pair its lanes draw is rehearsed, and a
 *   lane that is not ready draws nothing (the core's chart holds the view) — `liveFirstDraws` stays 0. D-NEXT (amends
 *   D-173, overview first): the dive waits for the core's FAR set only and lands on the overview; the lanes open after
 *   it and their MAP and TRUE sets rehearse behind the overview, so these gates are what keeps MAP and TRUE hitch-free;
 * - the zoom stops at the band's edge (the HUD's "detail N%" cue) and a flight aimed past it waits and resumes, but a
 *   lane still loading, a hook with nothing to draw, a stuck link or GROUND's MAP data never lock it (the stall valve,
 *   nothing, the hold cap);
 * - rehearsal runs only in idle or urgent frames, one pair per frame, in map.js order, never in a fade;
 * - the ground's per-band scale, the lanes' frame order and budgets, and a steady frame that allocates nothing.
 */
class RealmBandGateTest {
    private val rig = RealmGlRig()
    private val sources = RealmPrograms.load()
    private val gates = ArrayList<DoubleArray>()
    private val bands = RealmWebPin.BANDS

    private fun engineWith(vararg lanes: FakeLane): RealmMapEngine = RealmMapEngine(
        rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
        RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS,
        shaderSources = { sources }, lanes = lanes.toList(),
    ).apply {
        listener = object : RealmMapListener {
            override fun onGate(held: Boolean, band: Int, progress: Double) { gates += doubleArrayOf(if (held) 1.0 else 0.0, band.toDouble(), progress) }
        }
        setViewport(240, 520, 2.0) // the 12 × 8 fixture realm fits below FAR, like a real realm
    }

    private fun lane(vararg programs: String, create: Boolean = true) =
        FakeLane(rig.core, "detail", programs.toList()).apply { if (create) createOnOpen = sources }

    private fun globeFrame(e: RealmMapEngine) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core); e.rehearseStep(rig.nowMs)
        rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end()
    }

    private fun realmFrame(e: RealmMapEngine, compile: Boolean = true): Boolean {
        if (compile) rig.compiler.runAll()
        rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core)
        if (e.waiting) e.rehearseStep(rig.nowMs)
        val moving = e.frame(rig.nowMs, rig.nowMs.toLong(), false)
        rig.end()
        return moving
    }

    /** Prepare, wait for dive readiness in globe frames (the stall valve included: ≤ 1000 frames), enter at FAR. */
    private fun enter(e: RealmMapEngine) {
        assertTrue(e.prepare("alpha"))
        var n = 0
        while (!e.ready && n < 1000) { globeFrame(e); n++ }
        assertTrue(e.ready, "dive-ready (status ${e.status})")
        val g = e.grid!!
        assertTrue(e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
    }

    /** Frames until [done] (at most [max]); returns the frames run. */
    private fun until(e: RealmMapEngine, max: Int = 2000, compile: Boolean = true, each: () -> Unit = {}, done: () -> Boolean): Int {
        var n = 0
        while (!done() && n < max) { realmFrame(e, compile); each(); n++ }
        assertTrue(done(), "condition not reached in $max frames")
        return n
    }

    @Test fun `dive readiness is the core's FAR pairs alone, and the lanes' MAP and TRUE sets rehearse behind the overview`() {
        // D-NEXT (was D-173's "the core's FAR pairs plus the lanes' MAP set"): the dive waits for nothing a lane does; the
        // lane opens at READY and its sets are built on the overview in idle frames, MAP first
        val l = lane("rm-map", "rm-true")
        val e = engineWith(l)
        enter(e)
        assertEquals(10, e.stats.pairsTotal); assertEquals(10, e.stats.pairsRehearsed) // (the core's 9 + the selected open deed's box)
        assertTrue(l.rehearsed.isEmpty(), "no lane pair before the dive")
        assertEquals(1, l.opened.size, "the lane was opened with the adopted first-frame set, at READY")
        assertContentEquals(e.deeds, l.opened[0].deeds, "the lane sees the catalog mask the core draws and picks with")
        until(e, done = { e.stats.lanePairsRehearsed == 4 })
        assertEquals(4, e.stats.lanePairsTotal, "rm-map and rm-true on the screen and an RGBA8 target")
        assertEquals(listOf("rm-map|0", "rm-map|1", "rm-true|0", "rm-true|1"), l.rehearsed, "MAP first, then TRUE")
        assertTrue(e.cam.d < bands.farEnd && !e.cam.moving, "the camera stayed on the overview: d ${e.cam.d}")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
        // a hook with nothing to draw for a ready lane that reports no band (BASES without kit dressing) is "nothing"
        val n = lane("rm-map").apply { hookDraws = false; bandSetValue = 0 }
        val e2 = engineWith(n)
        enter(e2)
        until(e2, done = { e2.stats.lanePairsNothing == 2 })
        assertEquals(0, e2.stats.lanePairsRehearsed)
        assertFalse(e2.stats.valveOpened, "no valve needed")
    }

    @Test fun `a zoom-in while the lanes still load is never held, and the lane's pipelines are built before it draws`() {
        // D-177 (owner 2026-09-26, "overview first, live": smoothness first, and he likes the web's behaviour). Was "a
        // zoom-in while the lanes still load waits at farEnd with the cue, and the valve lets it on": D-NEXT held the MAP
        // edge with core.js bandLimit's D-173 dive rule ('loading') while no lane could draw MAP, so the first pinch-in of
        // every cold visit froze at farEnd until the load landed (or stallMs). The web withdrew it (197d753c: "a lane still
        // loading never closes the zoom"): a lane's pairs gate only once it is in, and the core's chart holds the view until
        // then. A loading GROUND has no MAP data, so its mapReady() answers false too: that must not hold the edge either
        // (the MAP-data hold is for a loaded lane's unresolved view). The owner must never feel a freeze while pinching in.
        val l = lane("rm-map", "life-stand", create = false).apply {
            settledValue = false; readySets = intArrayOf(); bandSetValue = 0; groundBands = 1; mapReadyValue = false
        }
        val e = engineWith(l)
        assertTrue(e.prepare("alpha"))
        var f = 0; while (!e.ready && f < 1000) { globeFrame(e); f++ }
        val g = e.grid!!
        // sStart 11.5 lands at d 23, inside the MAP edge's window (≥ 0.9 × farEnd) like the Seeker's d 21–22, where the
        // edge's MAP-data hold is armed from the landing on
        assertTrue(e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 11.5))
        repeat(2) { realmFrame(e) } // (the gate reads the view from the frame before)
        assertTrue(e.cam.d >= bands.farEnd * 0.9 && e.cam.d <= bands.farEnd, "landed in the edge's window: d ${e.cam.d}")
        assertNotEquals(RealmMapEngine.GATE_LOADING, e.stats.gateReason, "no loading hold")
        assertNotEquals(RealmMapEngine.GATE_MAP_DATA, e.stats.gateReason, "no MAP-data hold for a lane with no MAP data")
        assertTrue(e.stats.limitD > bands.farEnd, "the MAP edge is open while the lane loads: limit ${e.stats.limitD}")
        e.zoomBy(2.2)
        val t0 = rig.nowMs
        until(e, done = { !e.cam.moving && e.cam.d > bands.farEnd })
        assertEquals(RealmBand.MAP, e.stats.band, "the + went straight on to MAP (nothing draws MAP yet: the chart holds the view)")
        assertTrue(rig.nowMs - t0 <= 380 + 4 * 16.667, "no hold on the way: ${rig.nowMs - t0} ms")
        val rest = e.cam.d
        assertTrue(gates.none { it[0] == 1.0 }, "no detail cue: nothing waited")
        assertFalse(e.stats.valveOpened, "no valve needed: no gate was closed")
        // the lane's load lands in the realm: its pipelines are built before it draws (held until then)
        l.settledValue = true; l.readySets = intArrayOf(1, 2); l.bandSetValue = 2; l.mapReadyValue = true; l.create(sources)
        until(e, done = { e.stats.lanePairsRehearsed == 4 })
        until(e, done = { e.stats.lanesHeld == 0 })
        assertTrue(l.updates > 0 && l.draws > 0, "the lane draws once its pairs are rehearsed")
        assertEquals(rest, e.cam.d, 0.0, "a lane that came in past the gate never pulled the camera back")
        assertEquals(0L, rig.core.stats.liveFirstDraws, "no (program, state) pair was drawn live for the first time")
    }

    @Test fun `the TRUE gate holds at trueStart for the TRUE set, waits out a hook's back-off, then opens`() {
        // no TRUE data yet: the lane can draw MAP only (bandSet 1), and rm-true's hook cannot draw (not "nothing": not ready)
        val l = lane("rm-map", "rm-true").apply { readySets = intArrayOf(1); hookFor["rm-true"] = false; bandSetValue = 1 }
        val e = engineWith(l)
        enter(e)
        until(e, done = { e.stats.lanePairsRehearsed == 2 })
        e.flyToDeed(6.0, 4.0, 150.0); until(e, done = { !e.cam.moving })
        assertEquals(150.0, e.cam.d, 1e-6)
        assertEquals(bands.trueStart, e.stats.limitD, "TRUE is out of reach while no lane can draw it")
        assertEquals(RealmMapEngine.GATE_OVERVIEW, e.stats.gateReason)
        // TRUE data arrives: rm-true now gates the TRUE edge until rehearsed (after its back-off from the failed try)
        l.bandSetValue = 2; l.readySets = intArrayOf(1, 2); l.hookFor.remove("rm-true")
        e.onInput(); e.flyToDeed(6.0, 4.0, bands.myBaseD)
        var maxD = 0.0
        until(e, each = { maxD = maxOf(maxD, e.cam.d) }) { e.stats.lanePairsRehearsed == 4 }
        assertTrue(maxD <= bands.trueStart * 1.001, "never inside the TRUE fade before rm-true's pairs: $maxD")
        assertTrue(gates.any { it[0] == 1.0 && it[1] == 2.0 }, "the cue names the TRUE band")
        until(e, done = { !e.cam.moving })
        assertEquals(bands.myBaseD, e.cam.d, 1e-6); assertEquals(RealmBand.TRUE, e.stats.band)
        assertEquals(0L, rig.core.stats.liveFirstDraws)
    }

    @Test fun `a ready lane's hook that cannot draw is nothing and never locks the zoom`() {
        val l = lane("rm-map", "life-stand").apply { hookFor["life-stand"] = false }
        val e = engineWith(l)
        enter(e)
        e.onInput(); e.flyToDeed(6.0, 4.0, 150.0)
        until(e, done = { !e.cam.moving && e.cam.d > bands.farEnd })
        assertEquals(2, e.stats.lanePairsNothing); assertEquals(2, e.stats.lanePairsRehearsed)
        assertEquals(0, e.stats.lanesHeld, "a 'nothing' pair does not hold its lane")
    }

    @Test fun `a gate that makes no progress opens after stallMs, and the still-linking lane stays held`() {
        val l = lane("rm-map", create = false).apply { readySets = intArrayOf(1, 2) }
        val e = engineWith(l)
        enter(e) // settled with no programs: nothing to load
        l.create(sources) // queued on the compiler, which never runs again: the program stays linking
        val u0 = l.updates
        realmFrame(e, compile = false)
        assertEquals(bands.farEnd, e.stats.limitD, "a linking program of a ready lane gates its band (native band readiness)")
        e.flyToDeed(6.0, 4.0, 150.0)
        val t0 = rig.nowMs
        until(e, max = 1000, compile = false, done = { e.stats.valveOpened })
        assertTrue(rig.nowMs - t0 >= RealmWebPin.REHEARSAL.stallMs, "the valve waits stallMs: ${rig.nowMs - t0}")
        until(e, compile = false, done = { e.cam.d > bands.farEnd && !e.cam.moving })
        assertTrue(e.cam.d > bands.farEnd, "the zoom is free again")
        assertEquals(1, e.stats.lanesHeld); assertEquals(u0, l.updates, "a held lane is never updated"); assertEquals(0, l.draws)
        assertEquals(0L, rig.core.stats.liveFirstDraws)
        // a new visit gives the stuck link a new chance (map.js startDive resets rh.stall and rh.valve): a valve carried
        // over would leave every later visit's MAP band ungated, and a stall count carried over would open it at once
        e.leave(rig.nowMs); e.fade.finish()
        val g = e.grid!!
        assertTrue(e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
        assertFalse(e.stats.valveOpened, "this visit's valve is closed")
        realmFrame(e, compile = false)
        assertEquals(bands.farEnd, e.stats.limitD, "the linking program gates its band again")
        e.flyToDeed(6.0, 4.0, 150.0)
        val t1 = rig.nowMs
        until(e, max = 1000, compile = false, done = { e.stats.valveOpened })
        // (the visit's first step counts at most 250 ms, map.js `rehearse`: the last visit's frame time is its base)
        assertTrue(rig.nowMs - t1 >= RealmWebPin.REHEARSAL.stallMs - 250, "the valve waits stallMs again: ${rig.nowMs - t1}")
    }

    @Test fun `once the stall valve has opened the gate the MAP edge waits for no map data`() {
        // map.js stage B bandGate: "an open valve waits for nothing more". The valve opens only after stallMs of a stuck
        // gate; holding the edge another mapReadyHoldMs for the ground's MAP data would stack a second wait on the first
        val ground = lane("rm-map")
        val stuck = lane("life-stand", create = false)
        val e = engineWith(ground, stuck)
        enter(e)
        stuck.create(sources) // queued on the compiler, which never runs again: its pair holds farEnd
        ground.mapReadyValue = false // and the ground's MAP data would hold the edge too
        realmFrame(e, compile = false)
        assertEquals(bands.farEnd, e.stats.limitD); assertEquals(RealmMapEngine.GATE_REHEARSAL, e.stats.gateReason)
        e.flyToDeed(6.0, 4.0, 150.0)
        until(e, max = 1000, compile = false, done = { e.stats.valveOpened })
        val t0 = rig.nowMs
        until(e, compile = false, done = { e.cam.d > bands.farEnd * 1.01 })
        assertTrue(rig.nowMs - t0 < RealmWebPin.REHEARSAL.mapReadyHoldMs / 2, "the edge held ${rig.nowMs - t0} ms after the valve opened")
        assertTrue(e.stats.gateReason != RealmMapEngine.GATE_MAP_DATA)
        until(e, compile = false, done = { !e.cam.moving })
        assertEquals(150.0, e.cam.d, 1e-6, "the held flight resumed to its target")
    }

    @Test fun `a zoom-in before the view's MAP data is in holds at farEnd with the cue for at most mapReadyHoldMs, once`() {
        // map.js's MAP-edge hold: MAP over an unresolved lattice pops in; waiting for ever would lock the zoom. The overview
        // often lands inside the edge's window (d ≥ 0.9 × farEnd; the Seeker's d 21–22): sStart 11.5 lands at d 23, 12 at
        // the edge itself. The hold is armed from the landing on, and its clock must start with the push, not the landing
        // (a hold spent while the player looked at the overview would let MAP pop in over an unresolved view)
        for (sStart in doubleArrayOf(11.5, 12.0)) {
            gates.clear()
            val l = lane("rm-map").apply { groundBands = 1 }
            val e = engineWith(l)
            assertTrue(e.prepare("alpha"))
            var n = 0; while (!e.ready && n < 300) { globeFrame(e); n++ }
            l.mapReadyValue = false // this view's lattice is not resolved yet
            val g = e.grid!!
            assertTrue(e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), sStart))
            until(e, done = { e.stats.lanePairsRehearsed == 2 }); repeat(90) { realmFrame(e) } // 1.5 s on the overview
            assertEquals(RealmMapEngine.GATE_MAP_DATA, e.stats.gateReason, "sStart $sStart: the MAP edge's hold is armed")
            assertFalse(e.cam.moving, "nothing moves by itself")
            e.zoomBy(2.2)
            val t0 = rig.nowMs
            until(e, done = { e.cam.d > bands.farEnd * 1.01 })
            assertTrue(rig.nowMs - t0 >= RealmWebPin.REHEARSAL.mapReadyHoldMs - 50, "sStart $sStart held for the cap: ${rig.nowMs - t0}")
            assertTrue(rig.nowMs - t0 <= RealmWebPin.REHEARSAL.mapReadyHoldMs + 600, "sStart $sStart then released, once: ${rig.nowMs - t0}")
            assertTrue(gates.any { it[0] == 1.0 && it[1] == 1.0 && it[2] == 0.95 }, "sStart $sStart: the detail cue while it held")
            until(e, done = { !e.cam.moving })
            assertTrue(e.cam.d >= bands.mapStart, "in MAP: d ${e.cam.d}")
            // the hold is over: nothing asks for a frame at rest (C10's 0 fps), a stale hold start must not wake the realm
            realmFrame(e)
            assertEquals(-1.0, e.wakeInMs(rig.nowMs), "sStart $sStart: a wake asked at rest after the hold")
        }
    }

    @Test fun `input pauses the lane rehearsal, idle runs one pair per frame, and a fade runs none`() {
        // D-NEXT: the lanes open at READY and all four pairs rehearse on the overview after the dive
        val l = lane("rm-map", "rm-true").apply { groundBands = 1 }
        val e = engineWith(l)
        enter(e)
        assertEquals(0, e.stats.lanePairsRehearsed)
        // a dive fade first: the host allows no work and draws no realm frame, so nothing is rehearsed in it
        val before = rig.core.stats.rehearsalDraws
        e.fade.start(RealmDiveFade.DIVE, rig.nowMs)
        repeat(20) { rig.nowMs += 16.667; rig.begin(); e.update(rig.nowMs, false); rig.core.beginScreen(0f, 0f, 0f, 1f); e.compositeFade(rig.nowMs); rig.end() }
        assertEquals(before, rig.core.stats.rehearsalDraws, "no rehearsal draw inside a fade")
        e.fade.finish()
        repeat(40) { e.onInput(); realmFrame(e) } // touching the overview: no set gates the band on screen, nothing waits
        assertEquals(0, e.stats.lanePairsRehearsed, "no rehearsal under input")
        var last = e.stats.lanePairsRehearsed; var frames = 0
        while (e.stats.lanePairsRehearsed < 4 && frames < 200) {
            realmFrame(e); frames++
            assertTrue(e.stats.lanePairsRehearsed - last <= 1, "one pair per frame"); last = e.stats.lanePairsRehearsed
        }
        assertEquals(4, e.stats.lanePairsRehearsed)
        assertTrue(frames * 16.667 >= RealmWebPin.REHEARSAL.idleMs, "idle means ≥ rehearse.idleMs since the input")
    }

    @Test fun `lane pairs rehearse in map-js rank order - MAP set by GPU_SAFE order, unlisted after, TRUE last`() {
        val l = lane("life-stand", "zz-unlisted", "rm-true", "rm-map")
        val e = engineWith(l)
        enter(e)
        until(e, done = { e.stats.lanePairsRehearsed == 8 })
        assertEquals(listOf("rm-map|0", "rm-map|1", "life-stand|0", "life-stand|1", "zz-unlisted|0", "zz-unlisted|1", "rm-true|0", "rm-true|1"), l.rehearsed)
    }

    @Test fun `a held lane draws nothing, a ready one draws its passes in map-js order, and its ground takes the slot`() {
        val l = lane("rm-map", create = false).apply { groundBands = 1 }
        val e = engineWith(l)
        enter(e)
        l.create(sources) // its program arrives after the dive: held until its pairs are rehearsed, the view waits at FAR
        e.onInput(); realmFrame(e)
        val u0 = l.updates
        assertEquals(1, e.stats.lanesHeld); assertEquals(0, l.draws)
        realmFrame(e); assertEquals(u0, l.updates, "a held lane is never updated")
        until(e, done = { e.stats.lanesHeld == 0 })
        l.passes.clear(); realmFrame(e)
        assertEquals(listOf(RealmLane.PASS_SHADOW, RealmLane.PASS_SHIELD_BACK, RealmLane.PASS_SPRITE, RealmLane.PASS_SHIELD_FRONT, RealmLane.PASS_AIR, RealmLane.PASS_FX), l.passes)
        assertEquals(0, l.groundDraws, "at FAR (the overview) the core's chart is the ground")
        e.flyToDeed(6.0, 4.0, bands.mapStart) // the player zooms in (nothing lands on MAP by itself)
        until(e, done = { !e.cam.moving && e.cam.d >= bands.mapStart })
        val g0 = l.groundDraws; realmFrame(e)
        assertEquals(g0 + 1, l.groundDraws, "from MAP the lane draws the ground")
        e.ladderLevel = 2; l.passes.clear(); realmFrame(e)
        assertFalse(RealmLane.PASS_AIR in l.passes, "safe mode drops the air pass (GPU_SAFE.heavy)")
    }

    @Test fun `settling a lane retries its backed-off pairs at once`() {
        val l = lane("rm-map").apply { settledValue = false; readySets = intArrayOf(); hookDraws = false }
        val e = engineWith(l)
        enter(e)
        repeat(40) { realmFrame(e) }
        assertEquals(0, e.stats.lanePairsRehearsed); assertEquals(0, e.stats.lanePairsNothing, "not ready: back-off, never nothing")
        l.settledValue = true; l.readySets = intArrayOf(1, 2); l.hookDraws = true
        val n = until(e, done = { e.stats.lanePairsRehearsed == 2 })
        assertTrue(n <= 4, "retried at the settle, not after the back-off: $n frames")
    }

    @Test fun `the ground renders at full resolution in every rest band at L0, at n0 in a band fade, coarser per level`() {
        val l = lane("rm-map", "rm-true").apply { groundBands = 1 }
        val e = engineWith(l)
        enter(e)
        until(e, done = { e.stats.lanePairsRehearsed == 4 })
        e.flyToDeed(6.0, 4.0, 150.0); until(e, done = { !e.cam.moving })
        l.passesMask = RealmLane.GROUND_MAP; realmFrame(e)
        assertEquals(RealmEngineConfig.PASS_MAP, e.stats.groundPass); assertEquals(1.0, e.stats.groundScale)
        l.passesMask = RealmLane.GROUND_CHART or RealmLane.GROUND_MAP; realmFrame(e)
        assertEquals(RealmEngineConfig.PASS_NONE, e.stats.groundPass); assertEquals(0.5, e.stats.groundScale, "a fade renders at n0")
        l.passesMask = 0; e.flyToDeed(6.0, 4.0, 1400.0); until(e, done = { !e.cam.moving }); realmFrame(e)
        assertEquals(RealmEngineConfig.PASS_TRUE, e.stats.groundPass, "without the lane's answer: the band weights (map.js groundPass)")
        assertEquals(1.0, e.stats.groundScale)
        e.ladderLevel = 1; realmFrame(e); assertEquals(0.5, e.stats.groundScale)
        e.ladderLevel = 2; realmFrame(e); assertEquals(1.0 / 3, e.stats.groundScale, 1e-12)
    }

    @Test fun `lane pairs stay rehearsed across a realm change in one context and rehearse again after a context loss`() {
        val l = lane("rm-map")
        val e = engineWith(l)
        enter(e)
        until(e, done = { e.stats.lanePairsRehearsed == 2 })
        e.leave(rig.nowMs); e.release()
        enter(e)
        realmFrame(e)
        assertEquals(2, e.stats.lanePairsRehearsed, "the same programs in the same context: their pipelines are built")
        val drawn = l.rehearsed.size
        rig.contextId++ // the EGL context changed: every pipeline is gone
        realmFrame(e)
        assertFalse(e.ready, "the restore reloads behind the realm's sea")
        until(e, done = { e.ready })
        assertEquals(3, l.opened.size, "opened at each READY: two entries and the restore")
        until(e, done = { e.stats.lanePairsRehearsed == 2 }) // (D-NEXT: READY is the core's; the lane's pairs follow on the map)
        assertEquals(drawn + 2, l.rehearsed.size, "rm-map's two pairs were rehearsed again in the new context")
        assertTrue(l.disposed >= 2, "disposed at the release and at the context change: ${l.disposed}")
    }

    @Test fun `the frame's budget reaches the lanes, a lane's pick answers first and its bases replace the core's dots`() {
        val l = lane("rm-map").apply { basesAt = 0 }
        val e = engineWith(l)
        enter(e)
        e.ladderKnobs = FrameLadder(LadderPolicy.PLAN, LadderInputs(1.5, 40_000)).knobs
        realmFrame(e)
        assertTrue(e.view.workAllowed); assertEquals(RealmWebPin.CONFIG.coldUploadBytes, e.view.uploadBytesLeft)
        assertEquals(RealmWebPin.CONFIG.resolveBudget, e.view.resolveBudget); assertEquals(0, e.view.maxResolves); assertEquals(40_000, e.view.lifeCap)
        e.ladderLevel = 1; realmFrame(e)
        assertEquals(1, e.view.maxResolves); assertEquals(20_000, e.view.lifeCap)
        // in a leave's snapshot frame the host allows no work: nothing may upload or resolve
        rig.nowMs += 16.667; rig.begin(); e.update(rig.nowMs, false); assertTrue(e.renderSnapshot(rig.nowMs.toLong(), false)); rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end()
        assertFalse(e.view.workAllowed); assertEquals(0L, e.view.uploadBytesLeft); assertEquals(0.0, e.view.resolveBudget)
        e.ladderLevel = 0
        until(e, done = { e.stats.lanesHeld == 0 })
        assertFalse(e.stats.occupancyDots, "the bases lane draws the bases")
        val g = e.grid!!; val t = (0 until g.size).first { (e.deeds[it].toInt() and 0xff) == 255 }
        val tile = g.tileId(t % g.cols, t / g.cols)
        e.setBases(WorldBases(1, "alpha", intArrayOf(tile % RealmGrid.LATTICE_W), intArrayOf(tile / RealmGrid.LATTICE_W), intArrayOf(4), intArrayOf(RealmBases.FLAG_OCCUPIED)))
        assertTrue(l.basesChanges > 0)
        l.pickAnswer = 0
        e.onTap(1.0, 1.0) // a corner of the screen, far from that deed: the lane's keep rect answered
        assertEquals(0, e.bases.selectedBase)
    }

    @Test fun `the gate cue is conflated to changes`() {
        val l = lane("rm-map", "rm-true")
        val e = engineWith(l)
        enter(e)
        e.onInput(); realmFrame(e) // the TRUE gate is in force (its set rehearses in the realm)
        e.flyToDeed(6.0, 4.0, bands.myBaseD)
        until(e, done = { !e.cam.moving && e.cam.d > bands.trueStart })
        repeat(30) { realmFrame(e) }
        assertTrue(gates.any { it[0] == 1.0 && it[1] == 2.0 }, "held at the TRUE gate")
        assertTrue(gates.size >= 2, "held, then released")
        for (i in 1 until gates.size) assertFalse(gates[i].contentEquals(gates[i - 1]), "a repeated cue at $i")
        assertEquals(0.0, gates.last()[0], "released at the end")
    }

    @Test fun `a steady realm frame with a live lane allocates nothing`() {
        val bean = ManagementFactory.getThreadMXBean() as com.sun.management.ThreadMXBean
        check(bean.isThreadAllocatedMemorySupported); bean.isThreadAllocatedMemoryEnabled = true
        val l = lane("rm-map", "rm-true").apply { recordPasses = false }
        val e = engineWith(l)
        enter(e)
        until(e, done = { e.stats.lanePairsRehearsed == 4 })
        rig.gl.record = false; rig.worker.record = false
        e.ladderLevel = 1
        repeat(300) { realmFrame(e) }
        fun steady() { rig.nowMs += 16.667; check(rig.begin()); e.update(rig.nowMs, true); e.frame(rig.nowMs, rig.nowMs.toLong(), false); rig.end() }
        repeat(300) { steady() }
        var allocated = -1L; var windows = 0
        while (allocated != 0L && windows < 20) {
            val before = bean.currentThreadAllocatedBytes
            repeat(600) { steady() }
            allocated = bean.currentThreadAllocatedBytes - before; windows++
        }
        assertEquals(0L, allocated, "all $windows windows of 600 steady realm frames allocated (the last: $allocated bytes)")
    }

    @Test fun `a lane reads detail files only through the pack's pinned hashes`() {
        val loader = RealmLoader(FixturePack("overview"), PNG_DECODER)
        val meta = loader.meta("alpha")
        assertTrue(loader.has(meta, "chart8.png"))
        assertNotNull(loader.detail(meta, "chart8.png"))
        assertFailsWith<RealmPackException> { loader.detail(meta, "fieldsA.png") }.also { assertTrue(it.message!!.contains("pins no sha256")) }
        assertFailsWith<IllegalArgumentException> { loader.detail(meta, "../beta/realm.json") }
        val outer = RealmLoader(FixturePack("overview", mapOf("realm/alpha/chart8.png" to "00".repeat(32))), PNG_DECODER)
        assertFailsWith<RealmPackException> { outer.detail(outer.meta("alpha"), "chart8.png") }.also { assertTrue(it.message!!.contains("content manifest")) }
    }
}
