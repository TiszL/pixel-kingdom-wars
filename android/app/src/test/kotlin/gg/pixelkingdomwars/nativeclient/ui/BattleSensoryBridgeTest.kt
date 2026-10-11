package gg.pixelkingdomwars.nativeclient.ui

import gg.pixelkingdomwars.nativeclient.data.DeviceSettings
import gg.pixelkingdomwars.nativeclient.renderer.*
import org.junit.Assert.*
import org.junit.Test

class BattleSensoryBridgeTest {
    private val scene=BattleScene(BaseScene(emptyList(),1,1,1f),PresentationRevision("raid","rev",14,0,0,emptyList()),emptyMap(),1f,100f,5,5)
    @Test fun `preview artwork uses exact current token independently from sensory preference admission`() {
        val context=SensoryContext(Any(),Any(),true,true,0,false)
        val owner=BattleDeployFeedback(context.identity!!,context.pack!!,"raid",{context});owner.mark(DeployMarkerKey("giant",null,1,2))
        val bridge=BattleSensoryBridge({context},{it()},{},deployment=owner);bridge.expect(scene,1)
        assertEquals(-1L,bridge.admission("raid","rev",1));assertEquals(1,bridge.deployPreview("raid","rev",1).size)
        bridge.expect(scene.copy(revision=scene.revision.copy(revision="new")),2,true)
        assertTrue(bridge.deployPreview("raid","rev",1).isEmpty());assertEquals(1,bridge.deployPreview("raid","new",2).size)
        bridge.close();assertTrue(bridge.deployPreview("raid","new",2).isEmpty())
    }
    private class Harness {
        val tasks=ArrayDeque<()->Unit>();val pulses=mutableListOf<HapticPattern>()
        var context=SensoryContext(Any(),Any(),true,false,0)
        var active:HapticPattern?=null
        val bridge=BattleSensoryBridge({context},{tasks+=it},{pulses+=it;active=it},{active=null})
        init {bridge.expect(BattleScene(BaseScene(emptyList(),1,1,1f),PresentationRevision("raid","rev",14,0,0,emptyList()),emptyMap(),1f,100f,5,5),1)}
        fun epoch()=bridge.admission("raid","rev",1)
        fun offer(pulse:Long=25) {bridge.offer(SensoryFrame(epoch(),1,listOf(HapticPattern(listOf(pulse))),1))}
        fun drain() {while(tasks.isNotEmpty())tasks.removeFirst()()}
    }
    @Test fun `deployment marker observation rejects obsolete tokens but hydrates cold or disabled exact frames`() {
        var context=SensoryContext(Any(),Any(),true,false,0)
        val owner=BattleDeployFeedback(context.identity!!,context.pack!!,"raid",{context})
        val bridge=BattleSensoryBridge({context},{it()},{},deployment=owner)
        val key=DeployMarkerKey("giant",null,1,2)
        fun cue(id:Int)=DeployHaptic(id,key,PresentationEvent.fromJson("""{"e":"deploy","t":1,"id":$id,"troop":"giant","x":384,"y":640}"""))
        bridge.expect(scene,1);owner.mark(key)
        bridge.expect(scene.copy(revision=scene.revision.copy(revision="new")),2,revisionReplacement=true)
        assertTrue(bridge.deployed("raid","rev",1,cue(1)))
        assertTrue(bridge.deployed("raid","new",2,cue(2))) // Old token did not steal the mark.
        context=context.copy(foreground=false,reducedMotion=true,haptics=false)
        assertFalse(bridge.deployed("raid","new",2,cue(3))) // State observation only; admission remains closed.
        assertEquals(-1L,bridge.admission("raid","new",2))
        assertTrue(bridge.deployed("raid","new",2,cue(3)))
        bridge.close();assertTrue(bridge.deployed("raid","new",2,cue(4)))
    }
    @Test fun `deployment account replacement during no-frame pause cannot consume a new owners marker`() {
        var context=SensoryContext(Any(),Any(),true,false,0)
        val old=BattleDeployFeedback(context.identity!!,context.pack!!,"raid",{context})
        val bridge=BattleSensoryBridge({context},{it()},{},deployment=old);bridge.expect(scene,1)
        val key=DeployMarkerKey("giant",null,1,2)
        old.mark(key);context=context.copy(identity=Any(),lifecycleEpoch=2)
        val replacement=BattleDeployFeedback(context.identity!!,context.pack!!,"raid",{context});replacement.mark(key)
        val cue=DeployHaptic(1,key,PresentationEvent.fromJson("""{"e":"deploy","t":1,"id":1}"""))
        assertTrue(bridge.deployed("raid","rev",1,cue));assertNull(old.mark(key));old.close()
        assertTrue(replacement.observed("raid",cue))
    }

    @Test fun `independent actual frame admission delivers once without audio or an actor requirement`() {
        val h=Harness();h.offer();h.drain();h.drain();assertEquals(listOf(HapticPattern(listOf(25L))),h.pulses);h.bridge.close()
    }
    @Test fun `paused and resumed without a GL frame still invalidate the queued old epoch`() {
        val h=Harness();h.offer();h.context=h.context.copy(lifecycleEpoch=2);h.drain()
        assertTrue(h.pulses.isEmpty());h.offer();h.drain();assertEquals(listOf(HapticPattern(listOf(25L))),h.pulses)
    }
    @Test fun `replacement account including same wallet epoch cannot inherit original sensory`() {
        val h=Harness();h.offer();h.context=h.context.copy(identity=Any());h.drain()
        assertTrue(h.pulses.isEmpty());assertEquals(-1L,h.epoch())
    }
    @Test fun `logout missing identity or content replacement closes original ownership`() {
        for(kind in listOf("logout","pack","missingPack")) {
            val h=Harness();h.offer();h.context=when(kind) {
                "logout"->h.context.copy(identity=null);"pack"->h.context.copy(pack=Any());else->h.context.copy(pack=null)
            };h.drain();assertTrue(kind,h.pulses.isEmpty());assertEquals(-1L,h.epoch())
        }
    }
    @Test fun `control revision and scene departure fence already posted cues before new render commands`() {
        for(replacement in listOf(scene,scene.copy(revision=scene.revision.copy(revision="new")),null)) {
            val h=Harness();h.offer();h.bridge.expect(replacement,2);h.drain()
            assertTrue(h.pulses.isEmpty());assertEquals(-1L,h.epoch())
        }
    }
    @Test fun `mailbox congestion drops stale sensory instead of playing a delayed batch`() {
        val h=Harness();h.offer();h.offer();assertEquals(1,h.tasks.size);h.drain();assertTrue(h.pulses.isEmpty())
        h.offer();h.drain();assertEquals(listOf(HapticPattern(listOf(25L))),h.pulses)
    }
    @Test fun `closed reduced motion and background cannot deliver queued or new pulses`() {
        for(kind in listOf("closed","reduce","background")) {
            val h=Harness();h.offer()
            when(kind) {"closed"->h.bridge.close();"reduce"->h.context=h.context.copy(reducedMotion=true);else->h.context=h.context.copy(foreground=false)}
            h.drain();h.offer();h.drain();assertTrue(kind,h.pulses.isEmpty())
        }
    }
    @Test fun `active patterns stop when identity pack haptics motion or lifecycle changes without another GL frame`() {
        for(kind in listOf("identity","pack","haptics","reduce","pause","closed")) {
            val h=Harness();h.offer(45);h.drain();assertNotNull(h.active)
            when(kind) {
                "identity"->h.context=h.context.copy(identity=Any())
                "pack"->h.context=h.context.copy(pack=Any())
                "haptics"->h.context=h.context.copy(haptics=false)
                "reduce"->h.context=h.context.copy(reducedMotion=true)
                "pause"->h.context=h.context.copy(foreground=false)
                else->h.bridge.close()
            }
            h.bridge.environmentChanged();assertNull(kind,h.active)
            if(kind=="haptics")assertTrue("Haptics OFF does not disable camera admission",h.epoch()>=0)
        }
    }
    @Test fun `medium pulse preserves explicit app OS motion foreground and View feedback guards`() {
        val settings=DeviceSettings(soundFx=false,music=false);val system=SystemExperience(foreground=true)
        assertTrue(patternHapticsAllowed(settings,system,true,true,true))
        for(variant in listOf(settings.copy(haptics=false),settings.copy(reduceMotion=true)))
            assertFalse(patternHapticsAllowed(variant,system,true,true,true))
        for(variant in listOf(system.copy(haptics=false),system.copy(animatorScale=0f),system.copy(foreground=false)))
            assertFalse(patternHapticsAllowed(settings,variant,true,true,true))
        assertFalse(patternHapticsAllowed(settings,system,false,true,true))
        assertFalse(patternHapticsAllowed(settings,system,true,false,true))
        assertFalse(patternHapticsAllowed(settings,system,true,true,false))
    }

    @Test fun `ordinary revision retains only environment epoch and rejects every old token delivery race`() {
        val h=Harness();val epoch=h.epoch();h.offer()
        val next=scene.copy(revision=scene.revision.copy(revision="appended"))
        h.bridge.expect(next,2,revisionReplacement=true)
        assertEquals(epoch,h.bridge.admission("raid","appended",2))
        h.bridge.offer(SensoryFrame(epoch,2,listOf(HapticPattern(listOf(25L))),1))
        h.drain();assertTrue(h.pulses.isEmpty())
        h.bridge.offer(SensoryFrame(epoch,3,listOf(HapticPattern(listOf(25L))),2))
        h.drain();assertEquals(listOf(HapticPattern(listOf(25L))),h.pulses)
    }
    @Test fun `lifecycle control or raid change cannot carry an earlier revision environment epoch`() {
        for(kind in listOf("pause","off","control","raid")) {
            val h=Harness();val old=h.epoch()
            if(kind=="pause")h.context=h.context.copy(lifecycleEpoch=2)
            if(kind=="off")h.context=h.context.copy(haptics=false)
            val next=scene.copy(revision=scene.revision.copy(raidId=if(kind=="raid")"other" else "raid",revision="appended"))
            h.bridge.expect(next,2,revisionReplacement=kind!="control")
            val current=h.bridge.admission(next.revision.raidId,"appended",2)
            assertNotEquals(kind,old,current)
            h.bridge.offer(SensoryFrame(old,2,listOf(HapticPattern(listOf(25L))),2));h.drain();assertTrue(h.pulses.isEmpty())
        }
    }
    @Test fun `candidate revision cannot rebind the original account or admitted pack`() {
        for(kind in listOf("identity","pack","background","reduce")) {
            val h=Harness();val old=h.epoch()
            h.context=when(kind) {"identity"->h.context.copy(identity=Any());"pack"->h.context.copy(pack=Any())
                "background"->h.context.copy(foreground=false);else->h.context.copy(reducedMotion=true)}
            h.bridge.expect(scene,2,revisionReplacement=true)
            assertEquals(-1L,h.bridge.admission("raid","rev",2))
            h.bridge.offer(SensoryFrame(old,2,listOf(HapticPattern(listOf(25L))),2));h.drain();assertTrue(h.pulses.isEmpty())
        }
    }

    @Test fun `old rendered frame during asynchronous replacement cannot erase or emit an unchanged released flight`() {
        val h=Harness();val policy=SensoryPolicy(2,25)
        val event=PresentationEvent.fromJson("""{"e":"fire","t":1,"id":"mortar"}""")
        val original=scene.copy(revision=scene.revision.copy(events=listOf(event)))
        val next=original.copy(revision=original.revision.copy(revision="appended"))
        val cue=HeroSensoryCue(0,10f,listOf(HeroSensory.Haptic("medium")),SensoryFlight(1f,2f,event))
        for(background in listOf(false,true)) {
            val p=BattleSensoryPlayback();p.replace(listOf(cue),false)
            fun advance(t:Float,e:Long,current:Boolean=true)=p.advance(t,0f,1f,true,e,1,policy,800f,600f,1f,current)
            val epoch=h.bridge.admission("raid",if(background)"appended" else "rev",if(background)2 else 1)
            advance(0f,epoch);advance(1f,epoch);advance(5f,epoch)
            var currentScene=true
            h.bridge.expect(next,2,revisionReplacement=true) { currentScene=false }
            assertTrue(advance(5f,h.bridge.admission("raid","rev",1),currentScene).isEmpty())
            assertEquals(SensoryOffset(),p.offset)
            if(background) {h.context=h.context.copy(lifecycleEpoch=2);h.bridge.environmentChanged()}
            assertTrue(p.continueRevision(listOf(cue),original,next,5f))
            val current=h.bridge.admission("raid","appended",2)
            advance(5f,current)
            assertEquals(if(background)emptyList()else listOf(HapticPattern(listOf(25L))),advance(10f,current))
        }
    }
}
