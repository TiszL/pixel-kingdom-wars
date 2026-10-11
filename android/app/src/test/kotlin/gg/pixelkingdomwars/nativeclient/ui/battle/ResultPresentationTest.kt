package gg.pixelkingdomwars.nativeclient.ui.battle

import gg.pixelkingdomwars.nativeclient.ui.SensoryContext
import gg.pixelkingdomwars.nativeclient.network.LiveBattleState
import gg.pixelkingdomwars.nativeclient.network.PendingBattle
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ResultPresentationTest {
    private val reference=Json.parseToJsonElement(checkNotNull(javaClass.getResourceAsStream("/results/source-reference.json")).bufferedReader().readText()).jsonObject
    private val policy=checkNotNull(ResultPresentation.read(reference.getValue("policy").jsonObject))
    @Test fun `current source stars use the authored triangle and distinct filled alpha`() {
        val s=policy.stars
        assertEquals(48f,s.size);assertEquals(14f,s.gap);assertEquals(14f,s.top);assertEquals(4f,s.bottom)
        assertEquals(listOf(0f,-10f,0f),s.offsetY);assertEquals(listOf(.25f,.25f,.25f),s.opacity);assertEquals(listOf(1f,1f,1f),s.filledOpacity)
    }
    @Test fun `every captured victory selects exact source sound gain and waveform and defeat never vibrates`() {
        for(raw in reference.getValue("policy").jsonObject.getValue("victory").jsonArray) {
            val source=raw.jsonObject;val feedback=policy.feedback(true,source.getValue("stars").jsonPrimitive.int)
            assertEquals(source.getValue("audio").jsonArray.map { it.jsonObject.getValue("legacy").jsonPrimitive.content },feedback.sounds.map { it.legacy })
            assertTrue(feedback.sounds.all { it.gain==1f })
        }
        assertEquals(listOf(35L,30L,45L),policy.feedback(true,3).haptics.single().timings)
        assertEquals(policy.feedback(true,3),policy.feedback(true,100))
        assertEquals("sfx_shield_up",policy.feedback(false,0).sounds.single().legacy)
        assertEquals(.8f,policy.defeat.sounds.single().gain);assertTrue(policy.defeat.haptics.isEmpty())
    }
    @Test fun `literal source FX retain both anchors and exact260ms frame cycle with reduced first frame`() {
        assertEquals(2,policy.effects.size)
        val sparkle=policy.effects.first { !it.right };val loot=policy.effects.first { it.right }
        assertEquals(.08f,sparkle.horizontal);assertEquals(.1f,sparkle.vertical);assertFalse(sparkle.bottom)
        assertEquals(.07f,loot.horizontal);assertEquals(.12f,loot.vertical);assertTrue(loot.bottom)
        for(fx in policy.effects) {
            assertEquals(64f,fx.size);assertEquals(260L,fx.frameMs);assertEquals(3,fx.frames.size)
            assertEquals(listOf(0,0,1,2,0),listOf(0L,259,260,520,780).map { fx.frame(it,false) })
            for(t in listOf(0L,260,520,10_000))assertEquals(0,fx.frame(t,true))
            assertTrue(fx.frames.all { it.path.startsWith("ui/results/")&&it.width==32&&it.height==32 })
        }
    }
    @Test fun `old packs preserve the existing result without inventing new decoration or sounds`() {
        assertNull(ResultPresentation.read(null))
    }
    @Test fun `unknown advertised result policy is rejected rather than using arbitrary image paths or strength`() {
        val original=reference.getValue("policy").toString()
        for(text in listOf(original.replace("ui/results/fx_sparkle_f1.png","../secret.png"),
            original.replace("\"priority\":\"normal\"","\"priority\":\"critical\""),
            original.replace("\"frameMs\":260","\"frameMs\":0"))) {
            assertNotEquals(original,text)
            try {ResultPresentation.read(Json.parseToJsonElement(text).jsonObject);fail("Unsupported policy accepted")}
            catch(_:IllegalArgumentException){}
        }
    }
    @Test fun `actual admitted star crop preserves complete master bounds without atlas whole-page decode`() {
        val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("src/main/assets/native")
        val atlas=Json.parseToJsonElement(File(root,policy.stars.atlas).readText()).jsonObject
        val crop=ResultCrop.star(atlas,policy.stars.key)
        assertEquals("atlas/ui@1x.png",crop.image);assertEquals(24,crop.width);assertEquals(24,crop.height)
        assertTrue(crop.inside(crop.x+crop.width,crop.y+crop.height))
        assertFalse(crop.inside(crop.x+crop.width-1,crop.y+crop.height))
    }
    @Test fun `trimmed rotated duplicate or out-of-bounds cells cannot masquerade as the complete star`() {
        val frame="""{"filename":"ui_icon_star","rotated":false,"trimmed":false,"sourceSize":{"w":24,"h":24},"frame":{"x":0,"y":0,"w":24,"h":24}}"""
        for(raw in listOf(frame.replace("\"rotated\":false","\"rotated\":true"),frame.replace("\"trimmed\":false","\"trimmed\":true"),"$frame,$frame")) {
            try{ResultCrop.star(Json.parseToJsonElement("""{"textures":[{"image":"ui@1x.png","frames":[$raw]}]}""").jsonObject,"ui_icon_star");fail("Invalid cell accepted")}
            catch(_:IllegalArgumentException){}
        }
        assertFalse(ResultCrop("atlas/ui@1x.png",Int.MAX_VALUE,0,24,24).inside(1024,1024))
    }
    private class Fixture {
        val identity=Any();val pack=Any();var context=SensoryContext(identity,pack,true,false,0)
        var cancelled=0;val owner=ResultCueOwner(identity,pack,{context},{cancelled++})
        val key=ResultCueKey("raid",true,3)
    }
    @Test fun `first current live result mounts once and reward-only refresh never replays its cue`() {
        val f=Fixture();assertTrue(f.owner.shown(f.key));assertFalse(f.owner.shown(f.key))
        assertTrue(f.owner.shown(f.key.copy(stars=2)));assertFalse(f.owner.shown(f.key.copy(stars=2)))
    }
    @Test fun `a result first observed in background is consumed and never delayed until resume`() {
        val f=Fixture();f.context=f.context.copy(foreground=false)
        assertFalse(f.owner.shown(f.key));f.context=f.context.copy(foreground=true,lifecycleEpoch=2)
        assertFalse(f.owner.shown(f.key))
    }
    @Test fun `coordinator result arriving with no stopped Compose frame cannot play at first resumed composition`() = runBlocking {
        for(stars in listOf(0,3)) {
            val f=Fixture();val states=MutableStateFlow(LiveBattleState(pending=PendingBattle("wallet","base","raid")))
            val observer=launch(start=CoroutineStart.UNDISPATCHED){observeResultKeys(states,f.owner)}
            try {
                f.context=f.context.copy(foreground=false,lifecycleEpoch=1);f.owner.environmentChanged()
                states.value=states.value.copy(result=buildJsonObject {put("stars",stars)})
                yield() // Coordinator delivery only: no visible mount/effect or Compose frame ran.
                f.context=f.context.copy(foreground=true,lifecycleEpoch=2);f.owner.environmentChanged()
                assertFalse(f.owner.shown(checkNotNull(resultCueKey("raid",states.value.result))))
            } finally {observer.cancelAndJoin()}
        }
    }
    @Test fun `background observer leaves a current result for its actual visible mount effect`() = runBlocking {
        val f=Fixture();val states=MutableStateFlow(LiveBattleState(pending=PendingBattle("wallet","base","raid")))
        val observer=launch(start=CoroutineStart.UNDISPATCHED){observeResultKeys(states,f.owner)}
        try {
            states.value=states.value.copy(result=buildJsonObject {put("stars",3)})
            yield()
            assertTrue(f.owner.shown(checkNotNull(resultCueKey("raid",states.value.result))))
            assertFalse(f.owner.shown(f.key))
        } finally {observer.cancelAndJoin()}
    }
    @Test fun `foreground result cannot renew its first unpainted cue after pause resume and repeated metrics`() = runBlocking {
        val f=Fixture();val states=MutableStateFlow(LiveBattleState(pending=PendingBattle("wallet","base","raid")))
        val observer=launch(start=CoroutineStart.UNDISPATCHED){observeResultKeys(states,f.owner)}
        try {
            states.value=states.value.copy(result=buildJsonObject {put("stars",3)})
            yield() // Arrival observed, but the visible result effect has not run.
            f.context=f.context.copy(foreground=false,lifecycleEpoch=1);f.owner.environmentChanged()
            f.context=f.context.copy(foreground=true,lifecycleEpoch=2);f.owner.environmentChanged()
            states.value=states.value.copy(result=buildJsonObject {put("stars",3);put("lootShards","100")})
            yield()
            assertFalse(f.owner.shown(checkNotNull(resultCueKey("raid",states.value.result))))
        } finally {observer.cancelAndJoin()}
    }
    @Test fun `pause cancels active haptic and resume does not replay the consumed stinger`() {
        val f=Fixture();assertTrue(f.owner.shown(f.key));f.context=f.context.copy(foreground=false,lifecycleEpoch=1);f.owner.environmentChanged()
        assertEquals(1,f.cancelled);f.context=f.context.copy(foreground=true,lifecycleEpoch=2);f.owner.environmentChanged()
        assertFalse(f.owner.shown(f.key))
    }
    @Test fun `OFF and reduced motion cancel haptics without disabling independent source sound`() {
        val f=Fixture();assertTrue(f.owner.shown(f.key));f.context=f.context.copy(haptics=false,reducedMotion=true)
        f.owner.environmentChanged();assertEquals(1,f.cancelled);assertTrue(f.owner.isCurrent())
        assertFalse(f.owner.shown(f.key))
    }
    @Test fun `same-wallet epoch and pack replacement permanently revoke the mounted result owner`() {
        for(kind in listOf("identity","pack")) {
            val f=Fixture();f.context=if(kind=="identity")f.context.copy(identity=Any())else f.context.copy(pack=Any())
            assertFalse(f.owner.shown(f.key));f.context=SensoryContext(f.identity,f.pack,true,false,2)
            assertFalse(f.owner.shown(f.key.copy(stars=2)))
        }
    }
    @Test fun `Back disposal cancels only this result owner and cannot be rearmed by a stars update`() {
        val f=Fixture();f.owner.close();f.owner.close();assertEquals(1,f.cancelled);assertFalse(f.owner.shown(f.key))
    }
    @Test fun `fresh authenticated process recovery may mount the live result once while old owner stays closed`() {
        val f=Fixture();assertTrue(f.owner.shown(f.key));f.owner.close()
        val recovered=ResultCueOwner(f.identity,f.pack,{f.context},{})
        assertTrue(recovered.shown(f.key));assertFalse(recovered.shown(f.key));assertFalse(f.owner.shown(f.key))
    }
}
