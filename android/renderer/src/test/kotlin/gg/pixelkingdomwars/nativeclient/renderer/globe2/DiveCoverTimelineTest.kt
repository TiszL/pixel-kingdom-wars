package gg.pixelkingdomwars.nativeclient.renderer.globe2

import gg.pixelkingdomwars.nativeclient.renderer.realmmap.RealmDiveFade
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The dive's cloud cover (owner, 2026-09-26: a 5 s dive "freeze" was too much; clouds between the globe and the map, or
 * better a dive under 1 s). D-NEXT makes a dive READY in 0.22–0.37 s cold and a few frames warm, so the clouds must never
 * show there (a flash of clouds over every dive would be a new artefact). They cover only a dive that really waits (a
 * first dive after an install, memory pressure): up by 700 ms, held while the realm's snapshot fades in under them, and
 * parted only over the live realm (never onto a frozen frame), or onto the globe when the dive fails. A leave has none.
 */
class DiveCoverTimelineTest {
    private val frameMs = 1000.0 / 60
    private val fadeMs = RealmDiveFade.PLAN_FADE_MS

    /** A dive as the host runs it: the wait from 0, READY at [readyMs], its snapshot fade, the live realm at
     *  [liveMs] (null: never live). Every frame's cover until [untilMs]. */
    private fun dive(readyMs: Double, liveMs: Double? = readyMs + fadeMs, untilMs: Double = readyMs + fadeMs + 1_500.0,
                     clock: DiveCoverClock = DiveCoverClock()): List<Pair<Double, Double>> {
        clock.start(0.0)
        var readied = false; var lived = false
        val out = ArrayList<Pair<Double, Double>>()
        var t = 0.0
        while (t <= untilMs) {
            if (!readied && t >= readyMs) { clock.ready(t); readied = true }
            if (readied && !lived && liveMs != null && t >= liveMs) { clock.live(t); lived = true }
            out += t to clock.alpha(t)
            t += frameMs
        }
        return out
    }

    @Test fun `a warm dive never shows the clouds`() {
        for (frames in 0..3) {
            val clock = DiveCoverClock()
            val seen = dive(readyMs = frames * frameMs, clock = clock)
            assertTrue(seen.all { it.second == 0.0 }, "READY after $frames frames: not one cloud (${seen.firstOrNull { it.second > 0 }})")
            assertFalse(clock.animating, "and no frame is kept busy for them")
        }
        // a normal cold dive (READY in 0.22–0.37 s under D-NEXT) is under the threshold too
        assertTrue(dive(readyMs = 370.0).all { it.second == 0.0 })
    }

    @Test fun `a cold dive is covered by 700 ms and stays covered until the live realm, then the clouds part`() {
        val seen = dive(readyMs = 1_500.0)
        assertTrue(seen.filter { it.first < 400.0 }.all { it.second == 0.0 }, "nothing in the first 400 ms")
        assertTrue(seen.filter { it.first in 400.0..700.0 }.zipWithNext().all { (a, b) -> b.second >= a.second }, "then they rise")
        val live = 1_500.0 + fadeMs
        assertTrue(seen.filter { it.first >= 700.0 && it.first < live }.all { it.second == 1.0 },
            "the whole screen from 700 ms, through the wait and the snapshot fade under it")
        val parting = seen.filter { it.first >= live }
        assertTrue(parting.zipWithNext().all { (a, b) -> b.second <= a.second }, "once live they only thin")
        assertTrue(parting.first { it.second == 0.0 }.first <= live + DiveCoverClock.PART_MS + 2 * frameMs, "gone in 450 ms")
    }

    @Test fun `the clouds part only while the realm is live, never onto a frozen frame`() {
        val clock = DiveCoverClock()
        // READY at 1.5 s, but the realm waits on screen (a context restore, its sea) until 5 s
        val seen = dive(readyMs = 1_500.0, liveMs = 5_000.0, untilMs = 6_000.0, clock = clock)
        assertTrue(seen.filter { it.first in 700.0..4_999.0 }.all { it.second == 1.0 }, "held over the waiting realm")
        assertTrue(seen.last().second == 0.0 && !clock.animating, "parted once it drew live")
        // never live: they hold (the host's dive bound, not the clouds, ends such a dive)
        val stuck = dive(readyMs = 1_500.0, liveMs = null, untilMs = 20_000.0)
        assertTrue(stuck.filter { it.first >= 700.0 }.all { it.second == 1.0 })
    }

    @Test fun `a READY halfway up the rise holds the clouds where they were and parts them from there`() {
        val seen = dive(readyMs = 500.0)
        val atReady = seen.last { it.first < 500.0 + frameMs }.second
        assertTrue(atReady in 0.2..0.45, "a third of the way up ($atReady)")
        assertTrue(seen.filter { it.first in 500.0 + frameMs..500.0 + fadeMs - frameMs }.all { it.second == atReady },
            "they stop rising at READY and hold through the fade: the realm is on its way")
        assertTrue(seen.filter { it.first >= 500.0 + fadeMs + DiveCoverClock.PART_MS * atReady + 2 * frameMs }.all { it.second == 0.0 },
            "a thinner cover parts sooner")
    }

    @Test fun `a failed dive parts the clouds onto the globe`() {
        val clock = DiveCoverClock()
        clock.start(0.0)
        assertEquals(1.0, clock.alpha(1_200.0))
        clock.failed(1_200.0)
        assertEquals(0.5, clock.alpha(1_200.0 + DiveCoverClock.PART_MS / 2), 1e-9)
        assertEquals(0.0, clock.alpha(1_200.0 + DiveCoverClock.PART_MS))
        assertFalse(clock.animating)
        // a dive cancelled before the clouds rose has nothing to part
        val quick = DiveCoverClock(); quick.start(0.0); quick.failed(300.0)
        assertEquals(0.0, quick.alpha(300.0)); assertFalse(quick.animating)
    }

    @Test fun `a leave never has clouds`() {
        val clock = DiveCoverClock()
        clock.start(0.0); clock.ready(1_500.0)
        assertEquals(1.0, clock.alpha(1_600.0))
        clock.reset() // the player pinched out while they were still parting
        assertEquals(0.0, clock.alpha(1_601.0)); assertFalse(clock.animating)
        clock.live(1_700.0) // a later live frame raises nothing
        assertEquals(0.0, clock.alpha(1_800.0))
    }

    @Test fun `the drift clock runs from the dive's start`() {
        val clock = DiveCoverClock(); clock.start(2_000.0)
        assertEquals(1.5, clock.seconds(3_500.0), 1e-9)
    }

    @Test fun `the clouds are one blended screen draw from the resident cloud array, rehearsed before the globe was ready`() {
        val rig = GlobeRig(); rig.renderer.start(); rig.untilReady(); rig.frame()
        val cover = rig.world.group.programs.indexOfFirst { it?.fs?.contains("uniform vec4 uCover") == true }
        assertTrue(cover > 0, "linked with the globe's own programs (the blit's stages, a native body)")
        assertTrue(rig.world.group.program(cover)!!.fs.contains("uniform highp sampler2DArray uCloud"), "it reads the c512 clouds: no new bytes")
        fun hostFrame(amount: Float) {
            rig.now += 16.0
            val nanos = (rig.now * 1e6).toLong()
            check(rig.core.beginFrame(nanos, rig.context))
            rig.renderer.update(rig.now, rig.w, rig.h)
            rig.core.beginScreen(0f, 0f, 0f, 1f)
            rig.renderer.draw()
            rig.renderer.drawCover(amount, 1.25, rig.w, rig.h) // last in the screen pass, as the host draws it
            rig.core.endFrame(nanos)
        }
        rig.world.draws.clear(); hostFrame(0.75f)
        val draws = rig.world.draws
        assertEquals(cover, draws.last().program, "over everything drawn before it")
        assertEquals(1, draws.count { it.program == cover })
        assertEquals(0, draws.last().framebuffer, "on the screen")
        assertEquals(listOf(0.75f, 1.25f, rig.w.toFloat(), rig.h.toFloat()), rig.gl.vec4.getValue("uCover").toList())
        assertEquals(0L, rig.core.stats.liveFirstDraws, "its (program, state) pair was rehearsed with the globe's, never built in a dive")
        assertFalse(rig.world.blend, "blending is off again for whatever draws next")
        rig.world.draws.clear(); hostFrame(0f)
        assertTrue(rig.world.draws.none { it.program == cover }, "no draw at all without clouds")
        // asleep under the realm map (the host parts the clouds over the live realm): still drawn, from the resident array
        rig.renderer.diveResult(true, "crownlands", rig.now)
        rig.world.draws.clear()
        rig.now += 16.0
        val nanos = (rig.now * 1e6).toLong()
        check(rig.core.beginFrame(nanos, rig.context))
        rig.renderer.update(rig.now, rig.w, rig.h)
        rig.core.beginScreen(0f, 0f, 0f, 1f)
        rig.renderer.drawCover(0.5f, 2.0, rig.w, rig.h)
        rig.core.endFrame(nanos)
        assertEquals(listOf(cover), rig.world.draws.map { it.program })
    }
}
