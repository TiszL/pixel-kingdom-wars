package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.renderer.*
import gg.pixelkingdomwars.nativeclient.network.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class BattleDeployFeedbackTest {
    private val key=DeployMarkerKey("giant",null,1,2)
    private fun cue(id:Int,key:DeployMarkerKey=this.key,t:Int=1)=DeployHaptic(id,key,
        PresentationEvent.fromJson("""{"e":"deploy","t":$t,"id":$id,"troop":"${key.troop}","x":384,"y":640}"""))
    private class Harness(initial:Set<PresentationEvent> = emptySet()) {
        var context=SensoryContext(Any(),Any(),true,false,0)
        val owner=BattleDeployFeedback(context.identity!!,context.pack!!,"raid",{context},initial)
    }
    private fun staged(vararg ids:String):LiveBattleState {
        val clock=BattleClock.read(Json.parseToJsonElement("""{"protocolVersion":2,"revision":1,"rate":1,"durationMs":180000,"simNowMs":0,"anchorSimMs":0,"anchorWallAt":null,"battleEndsAt":null,"serverNow":"2026-09-13T00:00:00Z"}""").jsonObject,0)
        return LiveBattleState(phase=BattlePhase.STAGING,pending=PendingBattle("wallet","base",raidId="raid"),clock=clock,
            commands=ids.mapIndexed {index,id->Json.parseToJsonElement("""{"clientCommandId":"$id","sequence":$index,"kind":"deploy","payload":{"troop":"giant","tx":1,"ty":2}}""").jsonObject})
    }
    @Test fun `prestart accepted journal restores once without duplicating a live or consumed local ticket`() {
        val h=Harness();val local=h.owner.mark(key)!!;local.enqueued("local")
        val detached=h.owner.preview("raid")
        h.owner.restore(staged("local","restored"),null);h.owner.restore(staged("local","restored"),null)
        assertEquals(1,detached.size);assertEquals(2,h.owner.preview("raid").size)
        h.owner.observed("raid",cue(1));h.owner.observed("raid",cue(2))
        h.owner.restore(staged("local","restored"),null)
        assertTrue(h.owner.preview("raid").isEmpty())
    }
    @Test fun `cold actors suppress only their own prestart restored representation`() {
        val context=SensoryContext(Any(),Any(),true,false,0)
        val h=BattleDeployFeedback(context.identity!!,context.pack!!,"raid",{context},setOf(cue(1).source),listOf(key))
        h.restore(staged("already-drawn","pending"),null)
        assertEquals(1,h.preview("raid").size)
        h.observed("raid",cue(1));assertEquals(1,h.preview("raid").size)
        h.observed("raid",cue(2));assertTrue(h.preview("raid").isEmpty())
    }
    @Test fun `preferences preserve artwork and paused identity changes fence old previews`() {
        val h=Harness();h.owner.mark(key)
        val first=h.owner.preview("raid").single()
        h.context=h.context.copy(reducedMotion=true,haptics=false);assertEquals(first,h.owner.preview("raid").single())
        h.context=h.context.copy(foreground=false);assertTrue(h.owner.preview("raid").isEmpty())
        h.context=h.context.copy(foreground=true);assertEquals(first,h.owner.preview("raid").single())
        assertTrue(h.owner.preview("other").isEmpty())
        h.context=h.context.copy(identity=Any());assertTrue(h.owner.preview("raid").isEmpty())
    }
    @Test fun `matching taps are FIFO and a duplicate actor cannot consume the next marker`() {
        val h=Harness();val first=h.owner.mark(key)!!;val second=h.owner.mark(key)!!
        first.enqueued("a");second.enqueued("b")
        assertTrue(h.owner.observed("raid",cue(1)))
        first.refused("a") // Already consumed; cannot remove b.
        assertTrue(h.owner.observed("raid",cue(1)))
        assertTrue(h.owner.observed("raid",cue(2)))
        assertFalse(h.owner.observed("raid",cue(3)))
    }
    @Test fun `only the exact original refusal removes its ticket and unknown completion retains it`() {
        val h=Harness();val first=h.owner.mark(key)!!;val second=h.owner.mark(key)!!
        first.enter();first.enqueued("a");second.enter();second.enqueued("b")
        second.refused("a");first.actionFinished();second.actionFinished()
        first.refused("a")
        assertTrue(h.owner.observed("raid",cue(1)))
        assertFalse(h.owner.observed("raid",cue(2)))
    }
    @Test fun `preflight never entered and proven before-storage refusal clear but storage uncertainty stays`() {
        for(kind in listOf("notEntered","notEnqueued","storageUnknown")) {
            val h=Harness();val mark=h.owner.mark(key)!!
            if(kind!="notEntered")mark.enter()
            if(kind=="notEnqueued")mark.notEnqueued()
            mark.actionFinished()
            assertEquals(kind,kind=="storageUnknown",h.owner.observed("raid",cue(1)))
        }
    }
    @Test fun `hero troop and tile are part of the semantic match`() {
        val h=Harness();h.owner.mark(key)
        for((index,other) in listOf(key.copy(hero="theodor"),key.copy(troop="archer"),key.copy(tx=2),key.copy(ty=3)).withIndex())
            assertFalse(h.owner.observed("raid",cue(index+1,other)))
        assertTrue(h.owner.observed("raid",cue(5)))
    }
    @Test fun `background disallows fresh marks but retains the source scene marker through resume and preferences`() {
        val h=Harness();h.owner.mark(key)
        h.context=h.context.copy(foreground=false,lifecycleEpoch=1,haptics=false,reducedMotion=true)
        h.owner.environmentChanged();assertNull(h.owner.mark(key))
        assertTrue(h.owner.observed("raid",cue(1))) // Silent cursor hydration consumes it.
        h.context=h.context.copy(foreground=true,lifecycleEpoch=2)
        h.owner.mark(key);assertTrue(h.owner.observed("raid",cue(2)))
    }
    @Test fun `same wallet epoch pack logout raid and close cannot borrow or mutate replacement marks`() {
        for(kind in listOf("identity","pack","logout","close")) {
            val h=Harness();val old=h.owner.mark(key)!!;old.enqueued("a")
            when(kind) {"identity"->h.context=h.context.copy(identity=Any());"pack"->h.context=h.context.copy(pack=Any())
                "logout"->h.context=h.context.copy(identity=null);else->h.owner.close()}
            h.owner.environmentChanged();assertNull(h.owner.mark(key));assertTrue(h.owner.observed("raid",cue(1)))
            val fresh=Harness();fresh.owner.mark(key);old.refused("a");h.owner.close()
            assertTrue(fresh.owner.observed("raid",cue(1)));assertFalse(fresh.owner.observed("raid",cue(2)))
        }
        val h=Harness();h.owner.mark(key);assertTrue(h.owner.observed("other",cue(1)))
        assertTrue(h.owner.observed("raid",cue(1)))
    }
    @Test fun `restored historical deployment cannot consume a new tap before first GL hydration`() {
        val old=cue(1);val h=Harness(setOf(old.source));h.owner.mark(key)
        assertTrue(h.owner.observed("raid",old));assertTrue(h.owner.observed("raid",cue(2)))
        assertFalse(h.owner.observed("raid",cue(3)))
        // A source re-creation after death has a different original event; actor
        // presence dedup belongs to the visual plan, not a permanent ID blacklist.
        assertFalse(h.owner.observed("raid",cue(1,t=4)))
        assertTrue(h.owner.observed("raid",cue(1,t=4)))
    }
    @Test fun `restored prefix seed preserves genuinely fresh zero and does not preconsume future deployments`() {
        val events=listOf(cue(1,t=0).source,cue(2,t=5).source)
        val scene=BattleScene(BaseScene(emptyList(),1,1,1f),PresentationRevision("raid","rev",14,0,0,events),emptyMap(),256f,100f,5,5)
        assertTrue(restoredDeployEvents(scene).isEmpty())
        assertEquals(setOf(events.first()),restoredDeployEvents(scene.copy(presentationStart=BattlePresentationStart.ColdPrefix(0f))))
        assertEquals(setOf(events.first()),restoredDeployEvents(scene.copy(playheadTick=3f)))
    }
    @Test fun `hero donor comes only from admitted combat constants`() {
        val constants=Json.parseToJsonElement("""{"HERO_COMBAT":{"theodor":{"donor":"source-donor"}}}""").jsonObject
        assertEquals(DeployMarkerKey("source-donor","theodor",-1,2),deployMarkerKey("hero" to "theodor",-1,2,constants))
        assertNull(deployMarkerKey("hero" to "theodor",1,2,null))
        assertEquals(key,deployMarkerKey("deploy" to "giant",1,2,null))
    }
}
