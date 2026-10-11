package gg.pixelkingdomwars.nativeclient.renderer.realmmap

import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Pool
import gg.pixelkingdomwars.nativeclient.renderer.gl3.Gl3Program
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * D-NEXT (amends D-173): the realm's detail arrives BEHIND the overview, after the dive, never before it, and without the
 * code-29.1 Seeker's two failures, the 2.6–5.7 s cold dives and the OutOfMemoryError after ~14 min of realm visits:
 * - the lanes open only after the core's READY, one at a time (GROUND → LIFE → BASES, each once the one before settled or
 *   failed): at most one lane load decodes at a time, and none while the dive waits;
 * - every work frame lets each opened lane adopt its finished loads, held or not (a held lane got no update, so its load
 *   waited on the heap while its pairs waited for the textures it had not uploaded);
 * - lane pairs rehearse when the map is idle, or at once while the player waits at a gate; a pair whose inputs are not
 *   resident yet is asked again 32 ms later with no failed try counted (never the 1.5 → 6 s back-off);
 * - every pair rehearsed in a GL context stays rehearsed across realm changes (the core's 10; 9 cost ~150 ms per cold dive)
 *   and none survives a context change;
 * - one resident realm at most, and none nobody wants: a core-only (approach) prepare never entered is freed 10 s after
 *   its last prepare, a realm left is freed `IDLE.evictMs` after the leave; [RealmMapEngine.evictAtMs] tells the host
 *   when to wake for it (the globe may idle at 0 fps).
 */
class RealmPrefetchTest {
    private val rig = RealmGlRig()
    private val sources = RealmPrograms.load()
    private val openLog = ArrayList<String>()

    private fun engineWith(vararg lanes: RealmLane): RealmMapEngine = RealmMapEngine(
        rig.core, RealmWebPin.CONFIG, RealmTestData.plots, RealmWebPin.DEED_ART,
        RealmLoader(FixturePack("overview"), PNG_DECODER), null, rig.uploads, DirectExecutor, { rig.nowMs }, RealmDiveFade.PLAN_FADE_MS,
        shaderSources = { sources }, lanes = lanes.toList(),
    ).apply { setViewport(240, 520, 2.0) }

    private fun lane(name: String, vararg programs: String, create: Boolean = true) =
        FakeLane(rig.core, name, programs.toList()).apply { if (create) createOnOpen = sources; openLog = this@RealmPrefetchTest.openLog }

    /** An idle globe frame as the host runs it: the core's rehearsal while not READY, the lanes' prefetch while due. */
    private fun globeFrame(e: RealmMapEngine, work: Boolean = true) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, work); rig.uploads.poll(rig.core)
        if (work && (!e.ready || e.prefetchDue)) e.rehearseStep(rig.nowMs)
        rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end()
    }

    private fun realmFrame(e: RealmMapEngine) {
        rig.compiler.runAll(); rig.nowMs += 16.667
        check(rig.begin()); e.update(rig.nowMs, true); rig.uploads.poll(rig.core)
        if (e.waiting) e.rehearseStep(rig.nowMs)
        e.frame(rig.nowMs, rig.nowMs.toLong(), false)
        rig.end()
    }

    private fun ready(e: RealmMapEngine, id: String = "alpha", lanes: Boolean = true, each: () -> Unit = {}): Int {
        assertTrue(e.prepare(id, lanes))
        var n = 0
        while (!e.ready && n < 300) { each(); globeFrame(e); n++ }
        assertTrue(e.ready, "dive-ready (status ${e.status})")
        return n
    }

    private fun enter(e: RealmMapEngine) {
        val g = e.grid!!
        assertTrue(e.enter(g.lonAt(g.cols / 2.0), g.latAt(g.rows / 2.0), 10.0))
    }

    @Test fun `the lanes open only after READY, one at a time, each once the one before it settled or failed`() {
        val ground = lane("ground", "rm-map").apply { settledValue = false }
        val life = lane("life", "life-stand")
        val bases = lane("bases", "bases-sprite").apply { settledValue = false }
        val e = engineWith(ground, life, bases)
        ready(e, each = { assertEquals(0, e.stats.lanesOpened, "a lane opened before READY") })
        assertEquals(listOf("ground"), openLog, "GROUND opened at READY, alone")
        repeat(120) { globeFrame(e) }
        assertEquals(listOf("ground"), openLog, "LIFE waits while GROUND's load is in flight")
        ground.settledValue = true
        globeFrame(e, work = false) // a frame with no work allowed (a flight, a fade) opens nothing
        assertEquals(listOf("ground"), openLog)
        globeFrame(e)
        assertEquals(listOf("ground", "life"), openLog, "LIFE opens in the next work frame")
        globeFrame(e)
        assertEquals(listOf("ground", "life", "bases"), openLog, "LIFE settled with its load: BASES next, one per frame")
        // a lane that fails (a program that does not link) counts as in: the one after it is not held back by it
        val a = lane("a", "rm-map").apply { settledValue = false }
        val b = lane("b", "life-stand")
        openLog.clear()
        val e2 = engineWith(a, b)
        ready(e2)
        repeat(10) { globeFrame(e2) }
        assertEquals(listOf("a"), openLog)
        a.programNamed("rm-map").state = Gl3Program.FAILED
        repeat(2) { globeFrame(e2) }
        assertEquals(listOf("a", "b"), openLog, "a failed lane's load is over")
        assertEquals(1, e2.stats.lanesDisabled)
    }

    @Test fun `a held lane adopts its loads every work frame, also while the camera pans, and draws only once rehearsed`() {
        // its load is in, but not resident: its textures fill as it adopts (here: resident after 5 adopts)
        val l = lane("life", "life-stand").apply { rehearsableValue = false }
        l.onAdopt = { if (l.adopts >= 5) l.rehearsableValue = true }
        val e = engineWith(l)
        ready(e)
        assertEquals(0, l.adopts, "nothing to adopt before READY, and no lane is open before it")
        enter(e); e.fade.finish()
        var t = rig.nowMs
        e.touchDown(1, 40.0, 130.0, t)
        repeat(40) { i -> t += 16.667; e.touchMove(1, 40.0 + 3 * (i % 20), 130.0, t); realmFrame(e) } // a pan, input every frame
        assertTrue(l.adopts >= 35, "adopted in every work frame while held and panning: ${l.adopts}")
        assertEquals(0, l.updates, "held: never updated")
        assertTrue(l.rehearsed.isEmpty(), "no rehearsal under input (nothing waits at a gate)")
        assertTrue(l.rehearsableValue, "the adopts made its inputs resident")
        e.touchUp(1, 60.0, 130.0, t + 8)
        var n = 0; while (l.updates == 0 && n < 200) { realmFrame(e); n++ }
        assertEquals(listOf("life-stand|0", "life-stand|1"), l.rehearsed, "rehearsed once the map was idle")
        assertTrue(l.updates > 0 && l.draws > 0, "then it draws")
        val a = l.adopts
        rig.nowMs += 16.667; check(rig.begin()); e.update(rig.nowMs, false); rig.core.beginScreen(0f, 0f, 0f, 1f); rig.end()
        assertEquals(a, l.adopts, "a frame without work (a fade, a flight) adopts nothing")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
    }

    @Test fun `lane pairs rehearse on the map only when it is idle, or at once while the player waits at a gate`() {
        val l = lane("ground", "rm-map", "rm-true").apply { groundBands = 1 }
        val e = engineWith(l)
        ready(e)
        enter(e); e.fade.finish()
        repeat(60) { e.onInput(); realmFrame(e) } // touching the overview: nothing waits at a gate
        assertTrue(l.rehearsed.isEmpty(), "no rehearsal under input")
        e.onInput(); e.zoomBy(2.2) // the player pushes into MAP: its set gates the edge
        var n = 0; while (e.stats.lanePairsRehearsed < 2 && n < 10) { e.onInput(); realmFrame(e); n++ }
        assertEquals(listOf("rm-map|0", "rm-map|1"), l.rehearsed, "the MAP set at once for the waiting player, input or not")
        assertTrue(n <= 3, "one pair per frame, no idle wait: $n frames")
        // on another visit to the overview, left alone: the pairs wait for idleMs after the last input, then one per frame
        val t = lane("true", "rm-true")
        val e2 = engineWith(t)
        ready(e2, lanes = false); enter(e2); e2.fade.finish() // (a core-only prepare: no prefetch behind the globe)
        repeat(30) { e2.onInput(); realmFrame(e2) }
        assertEquals(1, t.opened.size, "the lane opened on the map")
        assertTrue(t.rehearsed.isEmpty(), "no rehearsal under input")
        e2.onInput(); val lastInput = rig.nowMs // (the engine's input clock: the host's frame time of the touch)
        var first = -1.0
        n = 0; while (e2.stats.lanePairsRehearsed < 2 && n < 100) { realmFrame(e2); n++; if (first < 0 && t.rehearsed.isNotEmpty()) first = rig.nowMs }
        assertEquals(2, e2.stats.lanePairsRehearsed)
        assertTrue(first - lastInput >= RealmWebPin.REHEARSAL.idleMs, "idle means ≥ rehearse.idleMs since the input: ${first - lastInput} ms")
        assertEquals(0L, rig.core.stats.liveFirstDraws)
    }

    @Test fun `a pair whose inputs are not resident is asked again 32 ms later and never counts a failed try`() {
        // counted as tries, three seconds of "not resident yet" took the pair to the 6 s end of the retry back-off; its
        // first real failure then waited 6 s instead of 1.5 s, the lane held all along
        val l = lane("life", "life-stand").apply { rehearsableValue = false; hookDraws = false; readySets = intArrayOf() }
        val e = engineWith(l)
        ready(e)
        enter(e); e.fade.finish()
        repeat(10) { realmFrame(e) }
        val calls0 = l.rehearsableCalls; val draws0 = e.stats.rehearsalDraws
        repeat(180) { // three seconds idle, not resident
            realmFrame(e)
            val w = e.wakeInMs(rig.nowMs)
            // (+1e-9: (now + 32) - now is 32.00000000000023 at some frame times; one more core pair shifted them onto one)
            assertTrue(w in 0.0..RealmEngineConfig.NOT_RESIDENT_MS + 1e-9, "it asks for its own frame to be re-checked: $w ms")
        }
        assertTrue(l.rehearsableCalls - calls0 >= 80, "re-checked every 32 ms: ${l.rehearsableCalls - calls0} checks in 3 s")
        assertEquals(draws0, e.stats.rehearsalDraws, "a not-resident pair is never drawn")
        assertTrue(l.rehearsed.isEmpty())
        l.rehearsableValue = true // resident; its hook still cannot draw once: ONE failed try for each of its two pairs
        var n = 0; while (e.stats.rehearsalDraws < draws0 + 2 && n < 10) { realmFrame(e); n++ }
        assertEquals(draws0 + 2, e.stats.rehearsalDraws)
        l.hookDraws = true
        val t0 = rig.nowMs
        n = 0; while (l.rehearsed.size < 2 && n < 1_000) { realmFrame(e); n++ }
        assertEquals(2, l.rehearsed.size, "rehearsed")
        assertTrue(rig.nowMs - t0 <= RealmWebPin.REHEARSAL.retryMs + 100, "retried after one try's back-off: ${rig.nowMs - t0} ms")
    }

    @Test fun `pairs rehearsed in this GL context stay rehearsed across a realm change, and a context change clears them`() {
        val l = lane("ground", "rm-map")
        val e = engineWith(l)
        ready(e)
        var n = 0; while (e.prefetchDue && n < 100) { globeFrame(e); n++ }
        assertEquals(2, e.stats.lanePairsRehearsed)
        val draws = e.stats.rehearsalDraws; val laneDraws = l.rehearsed.size
        // another realm in the same context: the core's 10 pairs (the selected deed's box included) and the lane's are built already
        val frames = ready(e, "wrap")
        assertEquals("wrap", e.realmId)
        assertEquals(10, e.stats.pairsRehearsed, "the core's pairs came over")
        assertEquals(draws, e.stats.rehearsalDraws, "READY rehearsed nothing again ($frames frames)")
        n = 0; while (e.stats.lanePairsRehearsed < 2 && n < 20) { globeFrame(e); n++ }
        assertEquals(2, e.stats.lanePairsRehearsed, "the lane's pairs came over once it reopened")
        assertEquals(draws, e.stats.rehearsalDraws); assertEquals(laneDraws, l.rehearsed.size)
        // back to alpha and on screen: still nothing to rehearse
        ready(e, "alpha"); enter(e); e.fade.finish()
        repeat(20) { realmFrame(e) }
        assertEquals(draws, e.stats.rehearsalDraws, "nothing rehearsed again in this context")
        // a new EGL context: every pipeline is gone, every pair is rehearsed again
        rig.contextId++
        realmFrame(e)
        assertFalse(e.ready, "the restore reloads behind the realm's sea")
        n = 0; while ((!e.ready || e.stats.lanePairsRehearsed < 2) && n < 300) { realmFrame(e); n++ }
        assertEquals(10, e.stats.pairsRehearsed); assertEquals(2, e.stats.lanePairsRehearsed)
        assertTrue(e.stats.rehearsalDraws >= draws + 12, "the core's 10 and the lane's 2 pairs rehearsed again: ${e.stats.rehearsalDraws - draws}")
        assertEquals(laneDraws + 2, l.rehearsed.size)
        assertEquals(0L, rig.core.stats.liveFirstDraws)
    }

    @Test fun `a realm nobody wants is freed - an approach prepare 10 s after its last prepare, a left realm evictMs after the leave`() {
        val l = lane("ground", "rm-map")
        val e = engineWith(l)
        val approachMs = RealmWebPin.CONFIG.approachEvictMs; val evictMs = RealmWebPin.CONFIG.evictMs
        assertEquals(RealmEngineConfig.APPROACH_EVICT_MS, approachMs); assertEquals(10_000.0, approachMs)
        assertTrue(e.evictAtMs().isNaN(), "nothing resident, nothing due")
        // the globe's approach: the core only, never entered
        val t0 = rig.nowMs
        ready(e, lanes = false)
        assertEquals(t0 + approachMs, e.evictAtMs())
        assertTrue(l.opened.isEmpty(), "a core-only prepare opens no lane"); assertFalse(e.prefetchDue)
        while (rig.nowMs < t0 + approachMs - 100) globeFrame(e)
        assertEquals("alpha", e.realmId)
        val t1 = rig.nowMs; assertTrue(e.prepare("alpha", lanes = false)) // the camera still rests over it
        assertEquals(t1 + approachMs, e.evictAtMs(), "each approach prepare restarts the clock")
        while (rig.nowMs < t1 + approachMs + 50) globeFrame(e)
        assertEquals(null, e.realmId, "freed 10 s after its last prepare"); assertEquals(RealmMapEngine.STATUS_NONE, e.status)
        assertEquals(0L, rig.core.stats.gpuBytes(Gl3Pool.REALM), "no realm texture kept")
        assertTrue(e.evictAtMs().isNaN())
        // the panel wants it: the lanes open, and no clock frees a realm the panel still offers to dive into
        ready(e, lanes = false)
        assertTrue(e.prepare("alpha"))
        assertTrue(e.evictAtMs().isNaN(), "a lanes prepare keeps it")
        repeat(3) { globeFrame(e) }
        assertEquals(1, l.opened.size, "and opens its lanes")
        assertTrue(e.prepare("alpha", lanes = false)); assertTrue(e.evictAtMs().isNaN(), "a later approach prepare does not unwant it")
        // entered, then left: freed evictMs after the leave, whatever prepared it
        enter(e); e.fade.finish(); repeat(5) { realmFrame(e) }
        assertTrue(e.evictAtMs().isNaN(), "on screen: never")
        val tl = rig.nowMs
        e.leave(tl)
        assertEquals(tl + evictMs, e.evictAtMs())
        while (rig.nowMs < tl + evictMs - 100) globeFrame(e)
        assertEquals("alpha", e.realmId, "a quick re-dive stays warm")
        while (rig.nowMs < tl + evictMs + 50) globeFrame(e)
        assertEquals(null, e.realmId, "freed evictMs after the leave")
        assertEquals(0L, rig.core.stats.gpuBytes(Gl3Pool.REALM))
        // the next prepare of another realm frees the resident one at once (one resident realm)
        ready(e, lanes = false)
        assertTrue(e.prepare("wrap", lanes = false))
        globeFrame(e)
        assertEquals("wrap", e.realmId)
    }

    @Test fun `prefetchDue holds while the lanes have work behind the globe and ends when they are done`() {
        val l = lane("ground", "rm-map", "rm-true")
        val e = engineWith(l)
        ready(e, lanes = false)
        assertFalse(e.prefetchDue, "a core-only prepare has no lane work")
        assertTrue(e.prepare("alpha"))
        assertTrue(e.prefetchDue, "the panel's prepare: the lanes to open")
        var n = 0; while (e.prefetchDue && n < 100) { globeFrame(e); n++ }
        assertFalse(e.prefetchDue, "done: the host's globe frames stop prefetching")
        assertEquals(4, e.stats.lanePairsRehearsed, "the MAP and TRUE sets were built behind the globe")
        assertTrue(n < 20, "one pair per idle frame: $n frames")
        enter(e); assertFalse(e.prefetchDue, "never while the realm is on screen")
    }
}
