package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import kotlin.test.*
import org.junit.Test

class BattleSensoryTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/sensory/source-reference.json")).bufferedReader().use { it.readText() })
    private val policy=assertNotNull(SensoryPolicy.parse(reference.get("policy")))
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val catalogue=reader.parse(root.resolve("render-catalog.json").readText())
    private val library=CombatArt.catalogue(catalogue)
    private val frame=catalogue.get("actors").first { it.getString("type")=="theodor" }.getString("frameKey")
    private val phase=library.getValue(frame).heroEffects.getValue("cheekQuake:impact")
    private val shake=phase.sensory.filterIsInstance<HeroSensory.Shake>().single()
    private val cue=HeroSensoryCue(0,0,phase.sensory)
    private fun advance(p:BattleSensoryPlayback,t:Float,delta:Float=0f,epoch:Long=1,control:Long=1,playing:Boolean=true,rate:Float=1f)=
        p.advance(t,delta,rate,playing,epoch,control,policy,801f,603f,1f)
    private fun plan(events:List<String>,selected:SensoryPolicy?=policy.copy(eventHaptics=null)):CombatVisualPlan {
        val parsed=events.map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(emptyList(),32,32,64f),PresentationRevision("raid","rev",14,0,0,parsed),
            mapOf("theodor" to frame),256f,100f,5,5)
        return CombatVisualPlan(scene,BattleVisualModel(parsed,5),library,sensoryPolicy=selected)
    }
    private val cast="""{"e":"heroSkill","t":10,"id":1,"hero":"theodor","skill":"cheekQuake","phase":"impact","x":0,"y":0}"""
    private val birth="""{"e":"deploy","t":0,"id":1,"troop":"giant","hero":"theodor","x":0,"y":0}"""
    @Test fun `actual packed quake already has exact typed sensory body and external effect`() {
        assertEquals(listOf("medium"),phase.sensory.filterIsInstance<HeroSensory.Haptic>().map { it.strength })
        assertEquals("slam",library.getValue(frame).profile.get("heroSkills").get("cheekQuake:impact").getString("state"))
        assertEquals("fx_theo_quake",phase.effects.single().clip.key)
        catalogue.get("sensoryPolicy")?.let {
            val packed=assertNotNull(SensoryPolicy.parse(it))
            assertEquals(policy.copy(eventHaptics=null,mortarLanding=null,giantLanding=null,kegDetonation=null),packed.copy(eventHaptics=null,mortarLanding=null,giantLanding=null,kegDetonation=null))
            // Older optional policies retain Quake; only an advertised event extension must match it.
            packed.eventHaptics?.let { events->
                assertEquals(policy.eventHaptics?.copy(deployment=null),events.copy(deployment=null))
                events.deployment?.let {assertEquals(policy.eventHaptics?.deployment,it)}
            }
        }
    }
    @Test fun `global quake sensory survives absent or dead actor without changing body or external FX`() {
        val death="""{"e":"troopDeath","t":9,"id":1}"""
        for(events in listOf(listOf(cast),listOf(birth,cast),listOf(birth,death,cast))) {
            val current=plan(events);val historical=plan(events,null)
            assertEquals(1,current.sensoryCues.size);assertEquals(10f,current.sensoryCues.single().atTick)
            val a=mutableListOf<CombatSprite>();val b=mutableListOf<CombatSprite>()
            current.transientSprites(10f,a);historical.transientSprites(10f,b);assertEquals(b,a)
            assertEquals(historical.actor(1,10f),current.actor(1,10f))
        }
    }
    @Test fun `missing optional policy keeps old art and explicit coverage while invalid policy fails before drawing`() {
        val old=plan(listOf(birth,cast),null)
        assertTrue(old.sensoryCues.isEmpty());assertTrue("heroSensory:cheekQuake:impact" in old.missingCoverage)
        assertFailsWith<IllegalArgumentException> { SensoryPolicy.parse(reader.parse("""{"version":2}""")) }
        assertFailsWith<IllegalStateException> { HeroSensory.parse(reader.parse("""{"kind":"invented"}""")) }
    }
    @Test fun `camera offsets match actual Phaser random viewport zoom and pixel rounding samples`() {
        for(sample in reference.get("samples")) {
            val p=BattleSensoryPlayback { sample.getFloat("random") };p.replace(listOf(cue),true)
            p.advance(0f,0f,1f,true,1,1,policy,801f,603f,sample.getFloat("zoom"))
            assertEquals(sample.getFloat("x"),p.offset.x,0f);assertEquals(sample.getFloat("y"),p.offset.y,0f)
        }
    }
    @Test fun `shake real frame duration does not accelerate at double playback rate or extend on overlap`() {
        for(rate in listOf(1f,2f)) {
            val p=BattleSensoryPlayback { 0f };p.replace(listOf(cue,cue.copy(ordinal=1,atTick=1f)),true)
            advance(p,0f,rate=rate);assertNotEquals(SensoryOffset(),p.offset)
            advance(p,1f,shake.durationMs/2,rate=rate)
            advance(p,2f,shake.durationMs/2,rate=rate)
            assertEquals(SensoryOffset(),p.offset,"A refused second camera shake cannot restart the first duration")
        }
    }
    @Test fun `same frame shake cap never removes separately requested medium haptics`() {
        val p=BattleSensoryPlayback { 0f };p.replace(List(policy.concurrentShakeCap+1) { cue.copy(ordinal=it) },true)
        assertEquals(List(policy.concurrentShakeCap+1){HapticPattern(listOf(policy.mediumHapticMs))},advance(p,0f))
        advance(p,1f,shake.durationMs);assertEquals(SensoryOffset(),p.offset)
    }
    @Test fun `fresh actual zero remains available after initial asset loading but a cold first frame stays silent`() {
        for(fresh in listOf(false,true)) {
            val p=BattleSensoryPlayback();p.replace(listOf(cue),fresh);p.interrupted()
            assertEquals(if(fresh)listOf(HapticPattern(listOf(policy.mediumHapticMs))) else emptyList(),advance(p,0f))
        }
        val p=BattleSensoryPlayback();p.replace(listOf(cue),true)
        assertTrue(advance(p,1f).isEmpty());assertEquals(SensoryOffset(),p.offset)
    }
    @Test fun `seek admission pause and replacement discard old sensory including first resumed boundary`() {
        for(kind in listOf("seek","epoch","pause","disabled","loading")) {
            val p=BattleSensoryPlayback { 0f };p.replace(listOf(cue.copy(atTick=1f)),false);advance(p,0f)
            if(kind=="loading")p.interrupted()
            advance(p,1f,epoch=if(kind=="epoch")2 else if(kind=="disabled")-1 else 1,
                control=if(kind=="seek")2 else 1,playing=kind!="pause")
            assertEquals(SensoryOffset(),p.offset,kind)
            assertTrue(advance(p,2f,epoch=2,control=2).isEmpty())
        }
        val p=BattleSensoryPlayback { 0f };p.replace(listOf(cue),true);advance(p,0f)
        p.replace(emptyList(),false);advance(p,1f);assertEquals(SensoryOffset(),p.offset)
    }
    @Test fun `reduced motion admission cancels an active shake and never resumes its remaining tail`() {
        val p=BattleSensoryPlayback { 0f };p.replace(listOf(cue),true);advance(p,0f)
        advance(p,.5f,epoch=-1);assertEquals(SensoryOffset(),p.offset)
        advance(p,1f,epoch=2);assertEquals(SensoryOffset(),p.offset)
    }
}
