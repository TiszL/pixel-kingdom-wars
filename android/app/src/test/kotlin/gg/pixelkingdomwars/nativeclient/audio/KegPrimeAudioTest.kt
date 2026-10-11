package gg.pixelkingdomwars.nativeclient.audio

import gg.pixelkingdomwars.nativeclient.renderer.*
import org.junit.Assert.*
import org.junit.Test

class KegPrimeAudioTest {
    private val cue=BattleAudioCue(1000.0,"sfx_troop_kegrunner_plant_brace","1:10:detonate:prime",dispatch=AudioDispatch.KEG_PRIME)
    private val zeroCue=cue.copy(atMs=300.0,variantKey="1:3:detonate:prime")
    private class Sink:BattleAudioSink {
        val primes=mutableListOf<BattleAudioCue>()
        override fun replace(cues:List<BattleAudioCue>,fromMs:Double) {}
        override fun advance(toMs:Double,audible:Boolean) {}
        override fun actorLoop(actor:String,cue:BattleAudioCue) {}
        override fun actorEnded(actor:String) {}
        override fun actorCue(cue:BattleAudioCue) { primes+=cue }
        override fun close() {}
    }
    private fun player(sink:Sink,fresh:Boolean=false,cues:List<BattleAudioCue> = listOf(cue))=BattleFramePlayback(sink).also {
        it.replace(PreparedBattleAudio("raid","rev",100,cues,emptyList()),fresh)
    }
    private fun frame(tick:Float,prime:KegPrimePresentation?=null,playing:Boolean=true,epoch:Long=1,token:Long=1,
                      identity:String="kegrunner",id:Int=1)=BattleAudioRenderFrame("raid","rev",tick,playing,token,epoch,
        listOf(BattleAudioActor(id,identity,false,prime)))
    @Test fun `only the drawn prime crossing dispatches its exact existing source key once`() {
        val sink=Sink();val player=player(sink);val prime=KegPrimePresentation(5f,10)
        player.frame(frame(4f),false);player.frame(frame(5.25f,prime),false)
        player.frame(frame(5.25f,prime),false);player.frame(frame(9f,prime),false);player.frame(frame(10f),false)
        assertEquals(listOf(cue),sink.primes);player.close()
    }
    @Test fun `first cold or delayed plan frame inside prime cannot emit a late sound`() {
        for(fresh in listOf(false,true)) {
            val sink=Sink();val player=player(sink,fresh);val prime=KegPrimePresentation(5f,10)
            player.frame(frame(6f,prime),false);player.frame(frame(7f,prime),false)
            assertTrue(sink.primes.isEmpty());player.close()
        }
    }
    @Test fun `pause epoch seek token playing reset and mailbox gap discard their prime crossing`() {
        for(kind in listOf("epoch","token","pause","gap","backward")) {
            val sink=Sink();val player=player(sink);val prime=KegPrimePresentation(5f,10)
            player.frame(frame(if(kind=="backward")9f else 4f),false)
            val reset=frame(5f,prime,playing=kind!="pause",epoch=if(kind=="epoch")2 else 1,token=if(kind=="token")2 else 1)
            player.frame(reset,kind=="gap");player.frame(reset.copy(tick=6f,playing=true),false)
            assertTrue(kind,sink.primes.isEmpty());player.close()
        }
    }
    @Test fun `missing atlas offscreen body or skipped whole interval cannot catch up when a later body appears`() {
        val sink=Sink();val player=player(sink);val prime=KegPrimePresentation(5f,10)
        player.frame(frame(4f),false);player.frame(frame(5f),false);player.frame(frame(6f,prime),false)
        player.frame(frame(11f,prime),false)
        assertTrue(sink.primes.isEmpty());player.close()
        val skipped=Sink();val other=player(skipped)
        other.frame(frame(4f),false);other.frame(frame(10f),false)
        assertTrue(skipped.primes.isEmpty());other.close()
    }
    @Test fun `fresh drawn zero prime differs from resumed zero and control replacement`() {
        for(fresh in listOf(false,true)) {
            val sink=Sink();val player=player(sink,fresh,listOf(zeroCue));val prime=KegPrimePresentation(0f,3)
            player.frame(frame(0f,prime),false);player.frame(frame(.25f,prime),false)
            assertEquals(if(fresh)listOf(zeroCue) else emptyList<BattleAudioCue>(),sink.primes)
            player.replace(PreparedBattleAudio("raid","rev",100,listOf(zeroCue),emptyList()))
            player.frame(frame(0f,prime,token=2),false)
            assertEquals(if(fresh)1 else 0,sink.primes.size);player.close()
        }
    }
    @Test fun `proof binds actor species key original detonation and a finite currently live interval`() {
        val invalid=listOf(frame(5f,KegPrimePresentation(Float.NaN,10)),frame(5f,KegPrimePresentation(-1f,10)),
            frame(5f,KegPrimePresentation(5f,5)),frame(5f,KegPrimePresentation(6f,10)),
            frame(5f,KegPrimePresentation(5f,11)),frame(5f,KegPrimePresentation(5f,10),id=2),
            frame(5f,KegPrimePresentation(5f,10),identity="tunneler"),
            frame(5f,KegPrimePresentation(5f,10)).copy(raidId="old"),frame(5f,KegPrimePresentation(5f,10)).copy(revision="old"))
        for(value in invalid) {
            val sink=Sink();val player=player(sink);player.frame(frame(4f),false);player.frame(value,false)
            assertTrue(value.toString(),sink.primes.isEmpty());player.close()
        }
    }
    @Test fun `replacement discards obsolete detonation prime even when the old body proof arrives`() {
        val sink=Sink();val player=player(sink);player.frame(frame(4f),false)
        player.replace(PreparedBattleAudio("raid","new",100,emptyList(),emptyList()))
        player.frame(frame(5f,KegPrimePresentation(5f,10)),false)
        player.frame(frame(5f,KegPrimePresentation(5f,10)).copy(revision="new"),false)
        player.frame(frame(6f,KegPrimePresentation(5f,10)).copy(revision="new"),false)
        assertTrue(sink.primes.isEmpty());player.close()
    }
    @Test fun `a subsequent explicit replay can own a new real crossing without retaining old fired state`() {
        val sink=Sink();val player=player(sink);val prime=KegPrimePresentation(5f,10)
        player.frame(frame(4f),false);player.frame(frame(5f,prime),false)
        player.frame(frame(4f,token=2),false);player.frame(frame(5f,prime,token=2),false)
        assertEquals(listOf(cue,cue),sink.primes);player.close()
    }
}
