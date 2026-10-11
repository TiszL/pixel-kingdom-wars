package gg.pixelkingdomwars.nativeclient.renderer

import org.junit.Test
import kotlin.test.*

class BattlePlaybackControlsTest {
    @Test fun `replay speed change retains the actual frame instead of seeking to delayed UI time`() {
        val controls = BattlePlaybackControls()
        controls.seek(30f,1f,true,1,40)
        controls.playing(true,1,41,2f)
        val speed = assertNotNull(controls.take(1,1))
        assertNull(speed.tick); assertEquals(2f,speed.rate); assertTrue(speed.playing)
        assertEquals(41L,speed.audioToken)
        controls.playing(false,1,42,2f)
        val paused = assertNotNull(controls.take(1,1))
        assertNull(paused.tick); assertFalse(paused.playing); assertEquals(2f,paused.rate)
        listOf(0f,-1f,Float.NaN,Float.POSITIVE_INFINITY).forEach { rate ->
            assertFailsWith<IllegalArgumentException> { controls.playing(true,1,rate=rate) }
        }
    }

    @Test fun `result pause discards queued prediction seek and keeps actual GL time and rate`() {
        val controls = BattlePlaybackControls()
        controls.seek(80f,2f,true,1,41)
        controls.playing(false,1,42)
        val paused = assertNotNull(controls.take(1,1))
        assertFalse(paused.playing); assertEquals(42L, paused.audioToken)
        assertEquals(20f,paused.tick ?: 20f,"Actual GL tick must not jump through obsolete predictions")
        assertEquals(1f,paused.rate ?: 1f,"Mode-only control does not replay a stale clock rate")
        assertNull(controls.take(1,1))
    }

    @Test fun `controls wait for their prepared generation and obsolete controls cannot affect replacement`() {
        val controls = BattlePlaybackControls()
        controls.playing(false,2)
        assertNull(controls.take(2,1))
        assertFalse(assertNotNull(controls.take(2,2)).playing)
        controls.seek(90f,2f,true,2)
        assertNull(controls.take(3,2));assertNull(controls.take(3,3))
    }

    @Test fun `explicit seek after mode change wins while resume has no sampled clock`() {
        val controls = BattlePlaybackControls()
        controls.playing(false,1)
        controls.seek(100f,2f,false,1,51)
        val result = assertNotNull(controls.take(1,1))
        assertEquals(51L,result.audioToken);assertEquals(100f,result.tick);assertEquals(2f,result.rate);assertFalse(result.playing)
        controls.playing(true,1)
        val resume = assertNotNull(controls.take(1,1))
        assertTrue(resume.playing);assertNull(resume.tick);assertNull(resume.rate)
    }

    // Owner 2026-10-11 (Seeker, code 33): the battle played "accelerated". A stalled frame and every live clock update
    // used to jump the bodies forward.
    private fun scene(live: Boolean, playing: Boolean = true) = BattleScene(BaseScene(emptyList(),16,16,256f),
        PresentationRevision("raid","live",14,0,0,emptyList()),emptyMap(),256f,100f,5,5,playing=playing,liveClock=live)

    @Test fun `a stalled frame cannot fast-forward the battle`() {
        assertEquals(.16f,battleFrameTicks(.016f,100f,1f),1e-6f)
        assertEquals(.32f,battleFrameTicks(.016f,100f,2f),1e-6f,"2x replays and battles keep their rate")
        for(stall in listOf(.1f,.25f,2f,30f))
            assertEquals(1f,battleFrameTicks(stall,100f,1f),1e-6f,"A ${stall}s hitch adds at most 100 ms of battle")
        assertEquals(0f,battleFrameTicks(-.5f,100f,1f),0f,"A clock step backwards never rewinds")
    }

    @Test fun `only a playing live battle eases a correction under one second`() {
        assertTrue(easesLiveCorrection(scene(true),9.99f));assertTrue(easesLiveCorrection(scene(true),-9.99f))
        assertFalse(easesLiveCorrection(scene(true),10f),"A second or more is a real seek (resume, reconnect)")
        assertFalse(easesLiveCorrection(scene(true),-25f))
        assertFalse(easesLiveCorrection(scene(false),2f),"Replay restart and skip-to-end stay exact")
        assertFalse(easesLiveCorrection(scene(true,playing=false),2f),"A paused frame shows exactly its target")
    }

    @Test fun `an eased correction converges within ten percent of normal speed and never runs backwards`() {
        for(start in listOf(9.5f,-9.5f,.4f)) {
            var correction = start
            var tick = 0f
            var target = start
            repeat(60*20) {
                val frame = battleFrameTicks(1f/60,100f,1f)
                val ease = liveEaseTicks(frame,correction)
                assertTrue(frame+ease >= frame*.9f-1e-6f && frame+ease <= frame*1.1f+1e-6f,"start=$start")
                correction -= ease; tick += frame+ease; target += frame
            }
            assertEquals(target,tick,1e-3f,"start=$start")
            assertEquals(0f,correction,1e-4f)
        }
    }
}
