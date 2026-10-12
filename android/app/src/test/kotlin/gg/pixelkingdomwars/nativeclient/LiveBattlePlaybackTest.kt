package gg.pixelkingdomwars.nativeclient

import gg.pixelkingdomwars.nativeclient.generated.NativeClockDto
import gg.pixelkingdomwars.nativeclient.network.BattleClock
import gg.pixelkingdomwars.nativeclient.network.BattlePhase
import gg.pixelkingdomwars.nativeclient.renderer.*
import org.junit.Assert.*
import org.junit.Test
import kotlinx.serialization.json.*

class LiveBattlePlaybackTest {
    @Test fun `watch again cannot relabel a delayed archive as the currently watched raid`() {
        val archive=buildJsonObject { put("source","archive");put("raidId","previous");put("events",buildJsonArray {}) }
        val result=buildJsonObject { put("stars",1) }
        assertNull(archivedSpectatorReplay(archive,result,"current"))
        assertNull(archivedSpectatorReplay(archive,null,"previous"))
        assertNull(archivedSpectatorReplay(JsonObject(archive+("source" to JsonPrimitive("prediction"))),result,"previous"))
        val replay=requireNotNull(archivedSpectatorReplay(archive,result,"previous"))
        assertEquals("previous",replay.getValue("id").jsonPrimitive.content)
        assertSame("Adapting the wire ID must retain the frozen event bytes",archive["events"],replay["events"])
        assertFalse("The original archive must remain immutable",archive.containsKey("id"))
    }
    private fun prepared(revision: String, terminal: Boolean, end: Int = 100, raidId: String = "raid") = PreparedLiveBattle(
        BattleScene(BaseScene(emptyList(),16,16,64f),
            PresentationRevision(raidId,revision,14,0,0,listOf(
                PresentationEvent.fromJson("""{"t":$end,"e":"rally","x":0,"y":0}"""))),
            emptyMap(),256f,100f,10,10),terminal)

    @Test fun `a finish receipt pauses current GL time without seeking through obsolete predictions`() {
        val prediction=prepared("prediction",false)
        val control=livePlaybackScene(prediction,2500.0,BattlePhase.RESULT,true,2f)
        assertFalse(control.playing)
        assertTrue("Renderer must preserve its exact frame instead of replaying a stale sampled tick",control.retainPlaybackTick)
        assertEquals(25f,control.playheadTick,0f)
        assertSame(prediction,acceptLivePresentation(prediction,prepared("later-prediction",false),true,"raid"))
    }

    @Test fun `a cold result receipt cannot display any unconfirmed prediction`() {
        assertNull(acceptLivePresentation(null,prepared("prediction",false),true,"raid"))
    }

    @Test fun `complete terminal presentation can finish effects while the result remains authoritative`() {
        val prediction=prepared("prediction",false)
        val terminal=prepared("archive",true,70)
        assertSame(terminal,acceptLivePresentation(prediction,terminal,true,"raid"))
        val control=livePlaybackScene(terminal,2500.0,BattlePhase.RESULT,true,2f)
        assertTrue(control.playing)
        assertTrue(control.retainPlaybackTick)
        assertEquals("Cold recovery starts at the canonical end; renderer replacement preserves a current frame",70f,control.playheadTick,0f)
        assertSame(terminal.scene.revision,control.revision)
    }

    @Test fun `ordinary running and staging controls continue using the server clock`() {
        val prediction=prepared("live",false)
        val running=livePlaybackScene(prediction,3200.0,BattlePhase.RUNNING,false,2f)
        assertEquals(32f,running.playheadTick,0f);assertTrue(running.playing);assertFalse(running.retainPlaybackTick)
        assertFalse(livePlaybackScene(prediction,3200.0,BattlePhase.STAGING,false,1f).playing)
    }

    @Test fun `playhead controls retain immutable command plan without preparing every frame`() {
        val plan=BattleCommandDrawPlan(1L,"raid","live",mapOf(7 to 1L))
        val prediction=prepared("live",false).let {it.copy(scene=it.scene.copy(commandDrawPlan=plan))}
        val accepted=prepareLiveStart(null,prediction,100.0)
        assertSame(plan,accepted.scene.commandDrawPlan)
        for(phase in listOf(BattlePhase.RUNNING,BattlePhase.STAGING,BattlePhase.RESULT)) {
            for(clock in listOf(100.0,3200.0,3300.0)) {
                val control=livePlaybackScene(accepted,clock,phase,phase==BattlePhase.RESULT,2f)
                assertSame("Per-frame control copies must not republish an identical prepared scene",plan,control.commandDrawPlan)
                assertSame(accepted.scene.base,control.base)
                assertSame(accepted.scene.revision,control.revision)
            }
        }
    }

    @Test fun `queued frames from another raid or replaced revision cannot seek the replay result`() {
        val scene=prepared("archive",true).scene
        val frame=BattlePlaybackFrame("raid","archive",100f,BattlePlaybackExtent(100f,108f))
        assertTrue(frame.matches(scene))
        assertFalse(frame.copy(raidId="another-raid").matches(scene))
        assertFalse(frame.copy(revision="prediction").matches(scene))
    }

    @Test fun `live recovery suppresses only its original historical prefix across revisions`() {
        val recovered=prepareLiveStart(null,prepared("first",false),3250.0)
        assertEquals(BattlePresentationStart.ColdPrefix(32.5f),recovered.scene.presentationStart)
        val updated=prepareLiveStart(recovered,prepared("next",false),7100.0)
        assertEquals("A poll must not suppress effects that started after recovery",recovered.scene.presentationStart,updated.scene.presentationStart)
        val terminal=prepareLiveStart(updated,prepared("archive",true),10000.0)
        assertEquals(recovered.scene.presentationStart,terminal.scene.presentationStart)
        assertEquals("Archive replay construction still reconstructs the complete journal",
            BattlePresentationStart.Continuous,prepared("archive",true).scene.presentationStart)
    }

    @Test fun `another raid starts its own recovery boundary and invalid clocks fail closed`() {
        val first=prepareLiveStart(null,prepared("first",false),3250.0)
        val next=prepared("next",false).let { it.copy(scene=it.scene.copy(revision=it.scene.revision.copy(raidId="new-raid"))) }
        assertEquals(BattlePresentationStart.ColdPrefix(0f),prepareLiveStart(first,next,0.0).scene.presentationStart)
        listOf(Double.NaN,Double.POSITIVE_INFINITY,-1.0,Double.MAX_VALUE).forEach { clock ->
            assertThrows(IllegalArgumentException::class.java) { prepareLiveStart(null,next,clock) }
        }
    }

    @Test fun `cold terminal hydration uses the archive start frame despite a stale running clock`() {
        for(clock in listOf(200.0,15000.0)) {
            val terminal=prepareLiveStart(null,prepared("early-finish",true,70),clock)
            val playback=livePlaybackScene(terminal,clock,BattlePhase.RESULT,true,1f)
            assertEquals(BattlePresentationStart.ColdPrefix(playback.playheadTick),terminal.scene.presentationStart)
            assertEquals(70f,playback.playheadTick,0f)
        }
    }

    @Test fun `next target drops the previous battlefield through reservation gaps and delayed preparation`() {
        val previous=prepared("archive",true,raidId="previous-raid")
        assertNull("No reservation cannot own a retained battlefield",acceptLivePresentation(previous,previous,true,null))
        assertNull("A new reservation cannot display the previous opponent",acceptLivePresentation(previous,previous,false,"next-raid"))
        val next=prepared("first",false,raidId="next-raid")
        assertSame(next,acceptLivePresentation(previous,next,false,"next-raid"))
        assertSame("A late old archive must not replace the next opponent",next,acceptLivePresentation(next,previous,false,"next-raid"))
    }

    @Test fun `same raid revisions retain the current valid scene until its terminal presentation arrives`() {
        val first=prepared("first",false)
        val updated=prepared("second",false)
        assertSame(updated,acceptLivePresentation(first,updated,false,"raid"))
        assertSame(updated,acceptLivePresentation(updated,prepared("third",false),true,"raid"))
        val terminal=prepared("archive",true)
        assertSame(terminal,acceptLivePresentation(updated,terminal,true,"raid"))
    }

    @Test fun `an unrelated prepared scene cannot open or retain a cold spectator battlefield`() {
        val unrelated=prepared("archive",true,raidId="unrelated-raid")
        assertNull(acceptLivePresentation(null,unrelated,true,"watched-raid"))
        assertNull(acceptLivePresentation(unrelated,unrelated,true,"watched-raid"))
        val watched=prepared("archive",true,raidId="watched-raid")
        assertSame(watched,acceptLivePresentation(null,watched,true,"watched-raid"))
    }

    // Owner 2026-10-11 (Seeker, code 33): after ATTACK the troops stood, then the battle played "accelerated". The field
    // now shows the battle a held lag L behind the server clock instead of opening and seeking at server time.
    private fun live(vararg ticks: Int, terminal: Boolean = false, revision: String = "r${ticks.toList()}") = PreparedLiveBattle(
        BattleScene(BaseScene(emptyList(),16,16,64f),
            PresentationRevision("raid",revision,14,0,0,ticks.map { PresentationEvent.fromJson("""{"t":$it,"e":"rally","x":0,"y":0}""") }),
            emptyMap(),256f,100f,10,10),terminal)
    /** A running server clock sampled [simNowMs] at receipt nanosecond 0. */
    private fun clock(simNowMs: Long, rate: Int = 1, durationMs: Long = 180_000, started: Boolean = true) = BattleClock(
        NativeClockDto(2,1,rate,if(started) "2026-10-11T12:00:00Z" else null,0,"2026-10-11T12:00:02.500Z",simNowMs,
            if(started) "2026-10-11T12:03:00Z" else null,durationMs),0L)
    private fun seconds(value: Double) = (value*1_000_000_000).toLong()

    @Test fun `the first started revision with events fixes the lag so staged troops march from their deploy points`() {
        val staging=prepareLiveStart(null,live(),0.0)
        assertNull("Before ATTACK nothing has been simulated",livePresentationLagMs(null,staging,0.0,false))
        assertNull("A started clock without events leaves the troops waiting where they were placed",
            livePresentationLagMs(null,prepareLiveStart(staging,live(),2000.0),2000.0,true))
        assertEquals("The first started revision opens at its battle's start, not 2.5 s into the march",
            0.0,liveShownPlayheadMs(clock(2500),0,null,staging),0.0)
        val first=prepareLiveStart(staging,live(0,40),2500.0)
        val lag=requireNotNull(livePresentationLagMs(null,first,2500.0,true))
        assertEquals(2500.0,lag,0.0)
        assertEquals("Shown time starts at the staged troops' deploy tick",0.0,liveShownPlayheadMs(clock(2500),0,lag,first),0.0)
    }

    @Test fun `the lag is held for the whole battle so the field always plays at the clock own rate`() {
        val first=prepareLiveStart(prepareLiveStart(null,live(),0.0),live(0,40),2500.0)
        val lag=requireNotNull(livePresentationLagMs(null,first,2500.0,true))
        val later=prepareLiveStart(first,live(0,40,90),9000.0)
        assertEquals("A later revision, a terminal archive or a fresh server sample never shrinks the lag (no speed-up)",
            lag,requireNotNull(livePresentationLagMs(lag,later,9000.0,true)),0.0)
        assertEquals(lag,requireNotNull(livePresentationLagMs(lag,live(0,40,90,terminal=true),12000.0,true)),0.0)
        for(rate in 1..2) {
            val running=clock(2500,rate)
            var previous=liveShownPlayheadMs(running,0,lag,later)
            for(step in 1..100) {
                val now=seconds(step*0.5)
                val shown=liveShownPlayheadMs(running,now,lag,later)
                assertEquals("Shown time advances exactly as the server clock does at ${rate}x",500.0*rate,shown-previous,1e-6)
                assertEquals("Shown time stays exactly L behind while the server clock runs",running.playheadMs(now)-lag,shown,1e-6)
                assertTrue("The field is never ahead of the server",shown<=running.playheadMs(now))
                previous=shown
                if(running.playheadMs(now)>=40_000) break
            }
        }
    }

    @Test fun `shown time never exceeds the server clock for any lag or scene state`() {
        val scenes=listOf(null,prepareLiveStart(null,live(),0.0),prepareLiveStart(null,live(0,40),7000.0))
        for(server in listOf(0L,1200L,7000L,179_900L,180_000L)) for(lag in listOf(null,0.0,800.0,2500.0,500_000.0))
            for(scene in scenes) for(now in listOf(0L,seconds(0.3),seconds(4.0),seconds(30.0))) {
                val running=clock(server)
                val shown=liveShownPlayheadMs(running,now,lag,scene)
                assertTrue("server=$server lag=$lag now=$now shown=$shown",shown>=0 && shown<=running.playheadMs(now))
            }
        assertEquals("No started clock shows the start",0.0,liveShownPlayheadMs(clock(0,started=false),seconds(9.0),1000.0,null),0.0)
    }

    @Test fun `a reopened battle continues near server time instead of replaying from the start`() {
        // Recovery (and a defender opening WATCH LIVE mid-battle) prepares its first scene from the server clock.
        val reopenedAt=liveShownPlayheadMs(clock(60_000),0,null,null)
        assertEquals(60_000.0,reopenedAt,0.0)
        val recovered=prepareLiveStart(null,live(0,40,900),reopenedAt)
        assertEquals(BattlePresentationStart.ColdPrefix(600f),recovered.scene.presentationStart)
        val lag=requireNotNull(livePresentationLagMs(null,recovered,61_000.0,true))
        assertEquals("Only the time spent preparing is held; the battle is not replayed 61 s behind",1000.0,lag,0.0)
        assertEquals("The field opens at its cold boundary: no cue it shows was suppressed as history",
            60_000.0,liveShownPlayheadMs(clock(61_000),0,lag,recovered),0.0)
        assertEquals("A scene held before its lag exists never shows time it has not reached",
            60_000.0,liveShownPlayheadMs(clock(64_000),0,null,recovered),0.0)
        assertEquals("A first event later than the boundary starts the shown battle at that event",
            2000.0,requireNotNull(livePresentationLagMs(null,prepareLiveStart(null,live(300,400),29_000.0),32_000.0,true)),0.0)
    }

    // K-night-L2, 2026-10-12: L is fixed by whenever the first simulated revision reaches the phone. If that is very late
    // (app backgrounded right after ATTACK, a dropped connection, a slow server) an uncapped L held the whole battle tens
    // of seconds behind the server, so the player watched a fight the server had long since moved past. Above the cap the
    // field jumps once to server time minus the cap and then holds the cap: one seek, never a speed-up.
    private fun assertHeldFrom(server: Long, lag: Double, scene: PreparedLiveBattle) {
        val running=clock(server)
        var previous=liveShownPlayheadMs(running,0,lag,scene)
        for(step in 1..40) {
            val now=seconds(step*0.5)
            val shown=liveShownPlayheadMs(running,now,lag,scene)
            assertEquals("No further jump: the field advances exactly as the server clock does",500.0,shown-previous,1e-6)
            assertEquals("and stays exactly the held lag behind it",running.playheadMs(now)-lag,shown,1e-6)
            previous=shown
        }
    }

    @Test fun `a late first scene jumps once to server time minus the cap and then holds the cap`() {
        val staging=prepareLiveStart(null,live(),0.0)
        assertEquals("Until the first eventful revision arrives the troops wait at their deploy points",
            0.0,liveShownPlayheadMs(clock(25_000),0,null,staging),0.0)
        val first=prepareLiveStart(staging,live(0,40),0.0)
        val lag=requireNotNull(livePresentationLagMs(null,first,25_000.0,true))
        assertEquals("25 s late is capped, not held for the whole battle",LIVE_BATTLE_MAX_PRESENTATION_LAG_MS,lag,0.0)
        assertEquals("The single jump lands at server time minus the cap",
            25_000.0-LIVE_BATTLE_MAX_PRESENTATION_LAG_MS,liveShownPlayheadMs(clock(25_000),0,lag,first),0.0)
        val later=prepareLiveStart(first,live(0,40,900),30_000.0-LIVE_BATTLE_MAX_PRESENTATION_LAG_MS)
        assertEquals("Later revisions keep the capped lag",lag,requireNotNull(livePresentationLagMs(lag,later,30_000.0,true)),0.0)
        assertHeldFrom(25_000,lag,later)
    }

    @Test fun `an early first scene keeps its own lag under the cap`() {
        val staging=prepareLiveStart(null,live(),0.0)
        for(arrival in listOf(2500.0,LIVE_BATTLE_MAX_PRESENTATION_LAG_MS-1,LIVE_BATTLE_MAX_PRESENTATION_LAG_MS)) {
            val first=prepareLiveStart(staging,live(0,40),0.0)
            val lag=requireNotNull(livePresentationLagMs(null,first,arrival,true))
            assertEquals("A first scene ${arrival} ms after ATTACK still starts at the deploy tick",arrival,lag,0.0)
            assertEquals(0.0,liveShownPlayheadMs(clock(arrival.toLong()),0,lag,first),0.0)
        }
    }

    @Test fun `the defender watch path caps a late first scene the same way`() {
        // WATCH LIVE opens mid-battle: its first scene is prepared at the server clock (a cold boundary there).
        val openedAt=liveShownPlayheadMs(clock(60_000),0,null,null)
        val quick=prepareLiveStart(null,live(0,40,900),openedAt)
        assertEquals("A quick preparation keeps its own small lag",1000.0,
            requireNotNull(livePresentationLagMs(null,quick,61_000.0,true)),0.0)
        val slow=prepareLiveStart(null,live(0,40,900),openedAt)
        val lag=requireNotNull(livePresentationLagMs(null,slow,80_000.0,true))
        assertEquals("A 20 s preparation is capped",LIVE_BATTLE_MAX_PRESENTATION_LAG_MS,lag,0.0)
        assertEquals("The field jumps once to server time minus the cap",
            80_000.0-LIVE_BATTLE_MAX_PRESENTATION_LAG_MS,liveShownPlayheadMs(clock(80_000),0,lag,slow),0.0)
        assertHeldFrom(80_000,lag,slow)
    }

    @Test fun `the result hold plays the remaining lag at normal pace after the server clock ends`() {
        val lag=2500.0
        val first=prepareLiveStart(prepareLiveStart(null,live(),0.0),live(0,1790),2500.0)
        val ending=clock(179_000)
        assertEquals(176_500.0,liveShownPlayheadMs(ending,0,lag,first),0.0)
        assertEquals("The server clock rests at its end",180_000.0,ending.playheadMs(seconds(3.0)),0.0)
        assertEquals("The field keeps its own 1x pace through the last L",179_500.0,liveShownPlayheadMs(ending,seconds(3.0),lag,first),1e-6)
        assertEquals("and stops at the battle's end",180_000.0,liveShownPlayheadMs(ending,seconds(10.0),lag,first),0.0)
        // The result arrives while the field is still L behind: it pauses its actual frame (no seek through the
        // prediction), then the terminal archive plays the remainder from that frame instead of jumping to the end.
        val held=livePlaybackScene(first,liveShownPlayheadMs(ending,seconds(1.0),lag,first),BattlePhase.RESULT,true,1f)
        assertFalse(held.playing);assertTrue(held.retainPlaybackTick)
        val archive=prepareLiveStart(first,live(0,1790,terminal=true),180_000.0)
        val remainder=livePlaybackScene(archive,180_000.0,BattlePhase.RESULT,true,1f)
        assertTrue(remainder.playing);assertTrue(remainder.retainPlaybackTick);assertEquals(1f,remainder.rate,0f)
    }

    @Test fun `live playback is marked so the renderer eases its small clock corrections`() {
        val prepared=prepareLiveStart(null,live(0,40),0.0)
        for(phase in listOf(BattlePhase.STAGING,BattlePhase.RUNNING,BattlePhase.RESULT))
            assertTrue(livePlaybackScene(prepared,1200.0,phase,phase==BattlePhase.RESULT,1f).liveClock)
        assertFalse("A replay's own seeks (restart, skip to end) stay exact",prepared.scene.liveClock)
    }
}
