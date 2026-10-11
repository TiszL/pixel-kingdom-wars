package gg.pixelkingdomwars.nativeclient.renderer.world

import kotlin.test.*
import org.junit.Test

class HangGuardTest {
    private fun guard() = HangGuard(WebPin.GPU_SAFE).also { it.start(null, 0L) }
    /** The host's frame clock: paced 60 fps frames, frame n at n × 1000 / 60 ms (so 300 frames are exactly 5 s). */
    private var frames = 0L
    private fun HangGuard.frame(ms: Double): Int = sample(ms, cold = false, frameMs = frames++ * 1000L / 60)

    @Test fun `three slow GPU frames in six trip the guard to the safe level and two do not`() {
        val guard = guard()
        repeat(2) { assertEquals(HangGuard.HOLD, guard.sample(51.0, cold = false)) }
        repeat(3) { guard.sample(10.0, cold = false) }
        assertEquals(0, guard.level, "two slow frames in a window are not a hang")
        assertEquals(HangGuard.DOWN, guard.sample(51.0, cold = false))
        assertEquals(HangGuard.SAFE_LEVEL, guard.level)
    }

    @Test fun `one severe stall is a hiccup and two in the window trip the guard`() {
        val guard = guard()
        assertEquals(HangGuard.HOLD, guard.sample(300.0, cold = false))
        assertEquals(0, guard.level)
        assertEquals(HangGuard.DOWN, guard.sample(260.0, cold = false))
    }

    @Test fun `cold frames never count, however slow`() {
        val guard = guard()
        repeat(20) { guard.sample(2_000.0, cold = true) }
        assertEquals(0, guard.level, "a first draw of rm-map took over a second on Metal and must not drop the view into safe mode")
    }

    /**
     * Why (owner, Seeker 2026-09-25): after a MAP-entry spike the guard held ⅓-scale ground for ~50 s. Its web way back
     * (240 consecutive samples ≤ 12 ms) almost never completes while the realm map works: resolve slices and band changes
     * keep pushing the fence latency past 12 ms. The guard answers hangs, so 5 s of frames with no slow one lets it go,
     * however many of them sit between 12 and 50 ms (those are the ladder's). This test replaced "steps back up after 240
     * good samples and never again once an up was followed by a down" (the web rule the owner's evidence overturned).
     */
    @Test fun `after a trip the guard lets go after 5 s of frames with no slow one, busy frames included`() {
        val guard = guard()
        repeat(3) { guard.frame(60.0) }
        assertEquals(HangGuard.SAFE_LEVEL, guard.level)
        assertEquals(5_000L, guard.upAfterMs, "the owner's 5 s")
        // a busy Seeker at L2: mostly 8 ms, every 7th sample a 14–40 ms resolve or band-change frame (over the web's 12 ms)
        for (i in 0 until 299) assertEquals(HangGuard.HOLD, guard.frame(if (i % 7 == 3) 14.0 + i % 27 else 8.0), "sample $i")
        assertEquals(HangGuard.UP, guard.frame(8.0))
        assertEquals(0, guard.level)
        assertNull(guard.reason)
    }

    /**
     * Why (Seeker 2026-09-25, the trip lands 0.13–0.4 s after MAP entry, i.e. at the dive's landing): at the guard's L2 the
     * realm declares no idle animation, so once the player stops touching a still map no frame is drawn. A recovery that
     * counts drawn frames then never comes, and the landed map keeps ⅓-scale ground until 300 frames of later gestures.
     * The guard counts time instead, asks the host for a probe frame every 250 ms while tripped, and lets go 5 s after the
     * trip on those probes alone; a gap with no frames at all (a host that does not probe) is time too, but one frame after
     * it is not evidence: the next gesture's first 20 steady frames are.
     */
    @Test fun `a still view after a trip lets the guard go on the host's probes and idle gaps count as time`() {
        val probed = guard()
        var t = 0L
        repeat(3) { probed.sample(60.0, cold = false, frameMs = t) }
        assertEquals(HangRecovery.NATIVE.probeMs, probed.wakeInMs(), "a tripped guard asks the host for probe frames")
        repeat(19) { t += probed.wakeInMs(); assertEquals(HangGuard.HOLD, probed.sample(8.0, cold = false, frameMs = t), "probe at $t ms") }
        t += probed.wakeInMs()
        assertEquals(HangGuard.UP, probed.sample(8.0, cold = false, frameMs = t), "20 probes, 5 s after the trip")
        assertEquals(5_000L, t)
        assertEquals(-1L, probed.wakeInMs(), "a released guard asks for nothing: at rest the view costs 0 fps again")

        val idle = guard()
        repeat(3) { idle.sample(60.0, cold = false, frameMs = 0L) }
        t = 10_000L // the player looked at the still map for 10 s: no frame, no sample
        repeat(19) { assertEquals(HangGuard.HOLD, idle.sample(8.0, cold = false, frameMs = t)); t += 16 }
        assertEquals(HangGuard.UP, idle.sample(8.0, cold = false, frameMs = t), "the next gesture's 20th steady frame, not its 300th")
    }

    @Test fun `one slow frame restarts the steady run without tripping the guard again`() {
        val guard = guard()
        repeat(3) { guard.frame(60.0) }
        repeat(200) { guard.frame(8.0) }
        assertEquals(HangGuard.HOLD, guard.frame(51.0))
        repeat(299) { assertEquals(HangGuard.HOLD, guard.frame(8.0)) }
        assertEquals(HangGuard.SAFE_LEVEL, guard.level, "the run counts from the slow frame")
        assertEquals(HangGuard.UP, guard.frame(8.0))
        assertEquals(1, guard.trips)
    }

    /**
     * Why: the web locks the guard for the session once an up is followed by a down, so on the Seeker the second MAP entry
     * would have kept ⅓ ground for good. A backoff that doubles with every trip keeps the guard from oscillating (no
     * recovery comes sooner than twice the last one) without making one bad minute permanent; it saturates at 64 × 5 s.
     */
    @Test fun `each further trip doubles the steady run before the next recovery and none locks the session`() {
        val guard = guard()
        for (trip in 1..9) {
            repeat(3) { guard.frame(60.0) }
            assertEquals(HangGuard.SAFE_LEVEL, guard.level); assertEquals(trip, guard.trips)
            val runMs = 5_000L shl minOf(trip - 1, 6)
            assertEquals(runMs, guard.upAfterMs)
            val run = (runMs * 60 / 1000).toInt()
            repeat(run - 1) { assertEquals(HangGuard.HOLD, guard.frame(8.0), "trip $trip: no recovery before the backoff") }
            assertEquals(HangGuard.UP, guard.frame(8.0), "trip $trip recovers after $run steady frames")
        }
        assertEquals(5_000L * 64, guard.upAfterMs, "about 5 min at most")
    }

    @Test fun `a lost context restores at the safe level for good and a second loss stops the realm map`() {
        val guard = guard()
        assertFalse(guard.contextLost())
        assertEquals(HangGuard.SAFE_LEVEL, guard.level)
        repeat(1000) { guard.sample(5.0, cold = false) }
        assertEquals(HangGuard.SAFE_LEVEL, guard.level, "a lost context sets a floor, not a level")
        assertTrue(guard.contextLost())
        assertTrue(guard.stopped)
    }

    /**
     * Why (owner, Seeker code 30, 2026-09-26 12:28): the stored record used to FLOOR the next session at the safe level, so
     * after one trip every later World session drew ⅓-scale ground with no way back. A device that froze still starts
     * safe (the view that froze is not re-run at full cost on the first frame), but the stored level lets go by the same
     * steady-time rule as a trip, timed from the session's first sample, never from before the session.
     */
    @Test fun `a session that died inside the realm map starts the next one safe and lets go after 5 s of steady frames`() {
        val day = WebPin.GPU_SAFE.storeMs
        val died = HangRecord(level = 0, atMs = 1_000L, reason = null, pendingSinceMs = 1_000L)
        val next = HangGuard(WebPin.GPU_SAFE)
        assertEquals(HangGuard.SAFE_LEVEL, next.start(died, 1_000L + day - 1))
        assertEquals(0, next.floor, "a stored record is a start, not a floor")
        assertEquals("the last visit ended inside the realm map", next.hazard, "and it stays stored after the guard lets go")
        assertEquals(HangRecovery.NATIVE.probeMs, next.wakeInMs(), "a still view keeps sampling so the start can let go")
        val first = 3_600_000L // a frame clock far from 0: the steady time must count from this session's first sample
        for (i in 0 until 299) assertEquals(HangGuard.HOLD, next.sample(5.0, cold = false, frameMs = first + i * 1000L / 60), "frame $i")
        assertEquals(HangGuard.UP, next.sample(5.0, cold = false, frameMs = first + 5_000L))
        assertEquals(0, next.level, "full quality after 5 s of steady frames")
        assertEquals("the last visit ended inside the realm map", next.record(9L, realmOpenSinceMs = null)!!.reason)
        assertEquals(0, HangGuard(WebPin.GPU_SAFE).start(died, 1_000L + day), "a record older than storeMs is none")
        val loss = HangGuard(WebPin.GPU_SAFE)
        assertEquals(HangGuard.SAFE_LEVEL, loss.start(HangRecord(2, 5L, "a lost graphics context", null), 6L))
        repeat(19) { assertEquals(HangGuard.HOLD, loss.sample(5.0, cold = false, frameMs = 100L + it * 250L)) }
        assertEquals(HangGuard.UP, loss.sample(5.0, cold = false, frameMs = 100L + 5_000L), "a stored lost context lets go too")
        assertNull(guard().record(10L, realmOpenSinceMs = null), "a healthy session leaves no record")
        assertEquals(10L, guard().record(10L, realmOpenSinceMs = 10L)!!.pendingSinceMs)
    }

    /**
     * Why: the web stores no watchdog step ("a slow-but-alive GPU is not a hazard", map.js setLevel); code 30 stored every
     * slow-frame trip, and the Seeker's ordinary MAP-entry trip then started every later session at ⅓-scale ground. Only a
     * real freeze outlives the session: a lost context, or one steady frame of a second or more (a GPU that stopped, not
     * one that is slow). Cold frames stay one-off work however long they take.
     */
    @Test fun `only a real freeze is a hazard to store and a slow-frame trip never is`() {
        val slow = guard()
        repeat(6) { slow.frame(400.0) } // two severe stalls in the window: the MAP-entry kind of trip
        assertEquals(HangGuard.SAFE_LEVEL, slow.level)
        assertNull(slow.hazard, "a slow-frame trip is this session's")
        assertNull(slow.record(1L, realmOpenSinceMs = null), "and leaves nothing to store")
        assertEquals(0, slow.record(1L, realmOpenSinceMs = 1L)!!.level, "the pending marker alone is level 0")

        val frozen = guard()
        assertEquals(HangGuard.HOLD, frozen.frame(HangRecovery.NATIVE.freezeMs - 1), "just under a second is one severe stall")
        assertNull(frozen.hazard)
        assertEquals(HangGuard.FREEZE, frozen.frame(HangRecovery.NATIVE.freezeMs), "one frozen frame trips at once")
        assertEquals(HangGuard.SAFE_LEVEL, frozen.level)
        val stored = frozen.record(7L, realmOpenSinceMs = null)!!
        assertEquals(HangGuard.SAFE_LEVEL, stored.level); assertEquals("a frozen GPU frame", stored.reason)
        repeat(300) { frozen.frame(8.0) }
        assertEquals(0, frozen.level, "it lets go like any trip")
        assertNotNull(frozen.record(8L, realmOpenSinceMs = null), "but the freeze stays stored for the next session")
        assertEquals(HangGuard.FREEZE, frozen.frame(2_000.0), "a freeze after the release is one again")

        val cold = guard()
        repeat(5) { assertEquals(HangGuard.HOLD, cold.sample(5_000.0, cold = true)) }
        assertNull(cold.hazard, "a cold first draw is never a freeze")

        val lost = guard()
        lost.contextLost()
        assertEquals("a lost graphics context", lost.record(3L, realmOpenSinceMs = null)!!.reason)
    }
}

class FrameLadderTest {
    private fun ladder() = FrameLadder(LadderPolicy.PLAN, WebPin.LADDER_INPUTS)

    @Test fun `cold intervals never step the ladder`() {
        val ladder = ladder()
        repeat(40) { assertEquals(FrameLadder.HOLD, ladder.motionInterval(120.0, cold = true)) }
        assertEquals(0, ladder.level)
    }

    @Test fun `six slow motion intervals in twenty step down one level and five do not`() {
        val ladder = ladder()
        repeat(5) { ladder.motionInterval(25.0, cold = false) }
        repeat(14) { ladder.motionInterval(16.0, cold = false) }
        assertEquals(0, ladder.level, "a steady 20-59 fps must step down, but five janks in twenty are not that")
        assertEquals(FrameLadder.DOWN, ladder.motionInterval(21.0, cold = false))
        assertEquals(1, ladder.level)
        assertEquals(FrameLadder.REASON_SLOW_FRAMES, ladder.lastReason)
    }

    @Test fun `a steady 30 fps steps down to L2 and frame times alone never reach L3`() {
        val ladder = ladder()
        repeat(200) { ladder.motionInterval(33.3, cold = false) }
        assertEquals(2, ladder.level)
        assertEquals(60, ladder.current.targetFps, "30 fps pacing is thermal SEVERE only")
    }

    @Test fun `240 fast intervals step back up and an up followed by a down locks ups for the session`() {
        val ladder = ladder()
        repeat(6) { ladder.motionInterval(30.0, cold = false) }
        assertEquals(1, ladder.level)
        repeat(239) { ladder.motionInterval(16.6, cold = false) }
        assertEquals(FrameLadder.UP, ladder.motionInterval(16.6, cold = false))
        assertEquals(0, ladder.level)
        repeat(6) { ladder.motionInterval(30.0, cold = false) }
        assertTrue(ladder.upLocked)
        repeat(1000) { ladder.motionInterval(10.0, cold = false) }
        assertEquals(1, ladder.level)
    }

    @Test fun `thermal status floors the ladder and CRITICAL renders on input only`() {
        val ladder = ladder()
        ladder.thermal(ThermalStatus.MODERATE, Double.NaN)
        assertEquals(1, ladder.level); assertEquals(2, ladder.idleCadenceScale)
        ladder.thermal(ThermalStatus.SEVERE, Double.NaN)
        assertEquals(3, ladder.level); assertEquals(30, ladder.current.targetFps)
        ladder.thermal(ThermalStatus.CRITICAL, Double.NaN)
        assertTrue(ladder.inputOnly)
        ladder.thermal(ThermalStatus.NONE, Double.NaN)
        assertEquals(0, ladder.level); assertFalse(ladder.inputOnly); assertEquals(1, ladder.idleCadenceScale)
    }

    @Test fun `high thermal headroom steps down once per crossing`() {
        val ladder = ladder()
        ladder.thermal(ThermalStatus.LIGHT, 0.9)
        ladder.thermal(ThermalStatus.LIGHT, 0.95)
        assertEquals(1, ladder.level, "one step per crossing, not one per sample")
        ladder.thermal(ThermalStatus.LIGHT, 0.5)
        ladder.thermal(ThermalStatus.LIGHT, 0.9)
        assertEquals(2, ladder.level)
        assertEquals(FrameLadder.REASON_PREEMPT, ladder.lastReason)
    }

    @Test fun `the hang guard floors the ladder at L2 and the strictest source wins`() {
        val ladder = ladder()
        ladder.hangLevel(HangGuard.SAFE_LEVEL)
        assertEquals(2, ladder.level)
        repeat(500) { ladder.motionInterval(8.0, cold = false) }
        assertEquals(2, ladder.level, "fast frames cannot lift the hang guard's floor")
        ladder.thermal(ThermalStatus.SEVERE, Double.NaN)
        assertEquals(3, ladder.level)
        ladder.hangLevel(0); ladder.thermal(ThermalStatus.NONE, Double.NaN)
        assertEquals(1, ladder.level, "the guard lets go to L1, the ladder's own rule climbs the rest")
    }

    /**
     * Why (owner, Seeker 2026-09-25): the trip comes from the MAP band's entry at L0 (k 1), a frame the Seeker cannot draw
     * in a 60 Hz slot (RealmOverviewCostLanesTest). If the guard's release put the ladder back at L0, the next MAP frame
     * would trip it again; resuming at L1 (k ½) lets the ladder, not the guard, choose the MAP scale: it climbs to L0 only
     * after its own 240 fast intervals, and when L0 misses the slot again it locks L1 for the session.
     */
    @Test fun `when the hang guard lets go the ladder resumes at L1 and only its own fast frames climb to L0`() {
        val ladder = ladder()
        ladder.hangLevel(HangGuard.SAFE_LEVEL)
        repeat(500) { ladder.motionInterval(8.0, cold = false) } // fast frames under the floor prove L2, not L0
        ladder.hangLevel(0)
        assertEquals(1, ladder.level)
        repeat(239) { assertEquals(FrameLadder.HOLD, ladder.motionInterval(16.6, cold = false)) }
        assertEquals(FrameLadder.UP, ladder.motionInterval(16.6, cold = false))
        assertEquals(0, ladder.level)
        repeat(6) { ladder.motionInterval(33.3, cold = false) } // L0's MAP frame misses the slot again
        assertEquals(1, ladder.level)
        assertTrue(ladder.upLocked, "the ladder keeps MAP at k ½ for the session")
        repeat(1000) { ladder.motionInterval(10.0, cold = false) }
        assertEquals(1, ladder.level)
    }

    /**
     * Why (Seeker 2026-09-25): the intervals are frame start to frame start on the GL thread, so a paced 60 fps carries the
     * vsync wake jitter: [world-perf] steady motion p50 16.6, p95 17.9 ms, a third to a half of them over the plan's 16.7 ms. With
     * the up rule at 16.7 no run of 240 ever formed (zero ladder ups in the session, L1 held 40 s and 60 s), so after any
     * trip or slow burst the host stayed at L1 or L2 until the world scene was rebuilt: the owner's ⅓ ground again. A
     * steady 60 fps with that jitter must climb within ~5 s; a view that misses a slot twice a second must not.
     */
    @Test fun `the ladder climbs back through the Seeker's vsync jitter within 5 s but not through missed slots`() {
        val sorted = SEEKER_JITTER.sorted()
        assertEquals(16.6, (sorted[9] + sorted[10]) / 2, 1e-9, "p50 of the Seeker's steady motion intervals")
        assertEquals(17.9, sorted[18], 1e-9, "p95 (nearest rank)")
        assertTrue(SEEKER_JITTER.count { it > 16.7 } >= 7, "the plan's 16.7 ms line cuts through the jitter")

        val steady = ladder()
        repeat(6) { steady.motionInterval(30.0, cold = false) }
        assertEquals(1, steady.level)
        var climbedAt = -1
        for (i in 0 until 5 * 60) if (steady.motionInterval(SEEKER_JITTER[i % SEEKER_JITTER.size], cold = false) == FrameLadder.UP) { climbedAt = i; break }
        assertTrue(climbedAt in 0 until 5 * 60, "a jittery but steady 60 fps climbs back to L0 within 5 s (climbed at interval $climbedAt)")
        assertEquals(0, steady.level)

        val missing = ladder()
        repeat(6) { missing.motionInterval(30.0, cold = false) }
        for (i in 0 until 10 * 60 * 60) { // 10 min: a missed slot (33.3 ms) every 30th interval, the jitter between
            val ms = if (i % 30 == 29) 33.3 else SEEKER_JITTER[i % SEEKER_JITTER.size]
            assertEquals(FrameLadder.HOLD, missing.motionInterval(ms, cold = false), "interval $i")
        }
        assertEquals(1, missing.level, "missing a slot twice a second is not steady enough to try L0, and not slow enough to drop")
    }

    /**
     * Why: on the Seeker the hang guard, not the ladder, answers the MAP entry at L0 (it trips 0.1–0.4 s after entry,
     * before the ladder's 20-interval window fills). If a trip did not count as the ladder's step down, trip → release to
     * L1 → climb to L0 → trip would repeat for the whole session, with ⅓ ground for each recovery, never engaging the lock
     * that settles MAP at L1. The session's first trip, with no climb before it, must not lock anything.
     */
    @Test fun `a hang-guard trip after the ladder climbed is its step down and locks L1 for the session`() {
        val ladder = ladder()
        ladder.hangLevel(HangGuard.SAFE_LEVEL)
        assertFalse(ladder.upLocked, "a first trip with no climb before it locks nothing")
        ladder.hangLevel(0)
        assertEquals(1, ladder.level)
        repeat(240) { ladder.motionInterval(SEEKER_JITTER[it % SEEKER_JITTER.size], cold = false) }
        assertEquals(0, ladder.level, "the ladder tried L0 again by its own rule")
        ladder.hangLevel(HangGuard.SAFE_LEVEL) // and L0's MAP frame tripped the guard again
        assertTrue(ladder.upLocked)
        ladder.hangLevel(0)
        assertEquals(1, ladder.level)
        repeat(1000) { ladder.motionInterval(10.0, cold = false) }
        assertEquals(1, ladder.level, "one hitch, then L1 for the session, not a trip every few seconds")
    }

    /**
     * Why: frames drawn under the guard's floor are drawn at L2 and prove L2, not the ladder's own level. A ladder that
     * counted them climbed invisibly to L0 under the floor, and its next slow burst after the release (a band entry) then
     * locked ups at L2: ⅓ ground for every realm of the session. Its release also starts a fresh window, so nothing drawn
     * under the floor counts on either side.
     */
    @Test fun `frames drawn under the hang guard's floor never climb the ladder or arm its lock`() {
        val ladder = ladder()
        ladder.hangLevel(HangGuard.SAFE_LEVEL)
        repeat(6) { ladder.motionInterval(30.0, cold = false) } // lanes still loading: the ladder steps down under the floor
        assertEquals(1, ladder.frameLevel)
        repeat(1000) { ladder.motionInterval(10.0, cold = false) }
        assertEquals(1, ladder.frameLevel, "fast frames drawn at L2 do not climb the ladder to L0")
        repeat(5) { ladder.motionInterval(30.0, cold = false) }
        ladder.hangLevel(0)
        assertEquals(1, ladder.level)
        assertEquals(FrameLadder.HOLD, ladder.motionInterval(30.0, cold = false), "a fresh window: the five slow L2 frames do not count at L1")
        repeat(239) { assertEquals(FrameLadder.HOLD, ladder.motionInterval(10.0, cold = false)) }
        repeat(6) { ladder.motionInterval(30.0, cold = false) } // the next dive's band entry at L1
        assertEquals(2, ladder.level)
        assertFalse(ladder.upLocked, "no up happened at the ladder's own level, so nothing locks")
        repeat(240) { ladder.motionInterval(10.0, cold = false) }
        assertEquals(1, ladder.level, "the ladder climbs back from L2 by its own rule")
    }

    @Test fun `a ladder that stepped down itself keeps its own level when the guard lets go`() {
        val ladder = ladder()
        repeat(200) { ladder.motionInterval(33.3, cold = false) }
        assertEquals(2, ladder.frameLevel)
        ladder.hangLevel(HangGuard.SAFE_LEVEL); ladder.hangLevel(0)
        assertEquals(2, ladder.level, "the guard's release never raises quality past the ladder's own evidence")
    }

    @Test fun `the ground scale at dpr 2 is a half at L0 and L1 and a third at L2, so L2 really cuts the ground`() {
        val knobs = ladder().knobs
        assertEquals(0.5, knobs[0].groundScale(2.0))
        assertEquals(0.5, knobs[1].groundScale(2.0))
        assertEquals(1.0 / 3, knobs[2].groundScale(2.0), 1e-12)
        assertEquals(20_000, knobs[1].lifeCap)
        assertEquals(1.0, LadderKnobs.groundScale(1.0, 1.5), "a dpr-1 screen draws the ground at full size")
    }

    private companion object {
        /** Twenty steady 60 fps motion intervals (ms) with the Seeker's session statistics ([world-perf] 2026-09-25 17:13–
         *  17:21: p50 16.6, p95 17.9, mean ≈ one 60 Hz period), in a fixed interleaved order: a late wake is followed by a
         *  short interval. */
        val SEEKER_JITTER = doubleArrayOf(16.6, 17.9, 15.4, 16.5, 17.0, 16.3, 16.7, 15.0, 18.3, 16.55,
            16.2, 17.2, 15.8, 16.6, 16.9, 16.4, 17.5, 16.0, 16.8, 16.65)
    }
}
