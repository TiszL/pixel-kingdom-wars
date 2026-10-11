package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import kotlin.test.*
import org.junit.Test

class KegSensoryTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/sensory/source-reference.json")).bufferedReader().readText())
    private val policy=assertNotNull(SensoryPolicy.parse(reference.get("policy"))).copy(eventHaptics=null)
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val catalogue=reader.parse(root.resolve("render-catalog.json").readText())
    private val library=CombatArt.catalogue(catalogue)
    private val frames=catalogue.get("actors").filter {it.getString("type","")=="kegrunner"}.map {it.getString("frameKey")}.distinct()
    private val frame=frames.first();private val art=library.getValue(frame)
    private val birth="""{"e":"deploy","t":0,"id":1,"troop":"kegrunner","x":0,"y":0}"""
    private val detonate="""{"e":"detonate","t":1,"id":1,"x":1024,"y":1024}"""
    private val death="""{"e":"troopDeath","t":1,"id":1}"""
    private val end="""{"e":"star","t":30,"n":1}"""
    private fun scene(records:List<String> = listOf(birth,detonate,end),key:String=frame,
                      start:BattlePresentationStart=BattlePresentationStart.Continuous)=BattleScene(
        BaseScene(emptyList(),32,32,64f),PresentationRevision("keg","rev",14,0,0,records.map(PresentationEvent::fromJson)),
        mapOf("kegrunner" to key),256f,100f,5,5,presentationStart=start)
    private fun plan(records:List<String> = listOf(birth,detonate,end),key:String=frame,selected:CombatArt?=library[key],
                     contract:SensoryPolicy?=policy,start:BattlePresentationStart=BattlePresentationStart.Continuous):CombatVisualPlan {
        val s=scene(records,key,start)
        return CombatVisualPlan(s,BattleVisualModel(s.revision.events,5),selected?.let {mapOf(key to it)} ?: emptyMap(),sensoryPolicy=contract)
    }
    private fun clock(cues:List<HeroSensoryCue>,fresh:Boolean=false)=BattleSensoryPlayback {0f}.also {it.replace(cues,fresh)}
    private fun advance(p:BattleSensoryPlayback,t:Float,epoch:Long=1,control:Long=1,playing:Boolean=true,rate:Float=1f)=
        p.advance(t,0f,rate,playing,epoch,control,policy,800f,600f,1f)

    @Test fun `all admitted tiers deliver at their actual blast frame independent of the detonate event and damage`() {
        for(key in frames) {
            val a=library.getValue(key);val clip=a.clips.getValue(a.profile.getString("detonate"))
            val p=plan(key=key);val cue=p.sensoryCues.single();val body=assertNotNull(cue.body)
            assertEquals(1f,body.sourceTick);assertEquals(policy.kegDetonation!!.effects,cue.effects)
            assertEquals(1f+(clip.fxCues.getValue("keg_blast").first()-1)*10f/clip.fps,cue.atTick,.00001f)
            val sprites=mutableListOf<CombatSprite>();p.transientSprites(cue.atTick,sprites)
            assertTrue(sprites.any {it.clip.key==clip.effectByCue.getValue("keg_blast")})
            val c=clock(p.sensoryCues);advance(c,0f);assertTrue(advance(c,1f).isEmpty())
            assertTrue(advance(c,Math.nextDown(cue.atTick)).isEmpty())
            assertEquals(listOf(policy.pattern("medium")),advance(c,cue.atTick));assertNotEquals(SensoryOffset(),c.offset)
            assertTrue(advance(c,cue.atTick).isEmpty())
        }
    }
    @Test fun `compact missing actor profile and body use the captured immediate fallback without guessed animation`() {
        val profile=reader.parse(art.profile.toJson(JsonWriter.OutputType.json)).apply {remove("detonate")}
        for(p in listOf(plan(selected=null),plan(listOf(detonate,end)),plan(selected=art.copy(profile=profile)),
            plan(selected=art.copy(clips=art.clips-art.profile.getString("detonate"))))) {
            val cue=p.sensoryCues.single();assertEquals(1f,cue.atTick);assertNull(cue.body)
        }
    }
    @Test fun `missing optional blast art never swallows its body's exact callback`() {
        val p=plan(selected=art.copy(effects=emptyMap()))
        assertEquals(plan().sensoryCues,p.sensoryCues)
        val output=mutableListOf<CombatSprite>();p.transientSprites(p.sensoryCues.single().atTick,output);assertTrue(output.isEmpty())
    }
    @Test fun `ordinary death before detonate is immediate while same tick death afterward cannot cancel the dying callback`() {
        val before=plan(listOf(birth,death,detonate,end)).sensoryCues.single()
        assertEquals(1f,before.atTick);assertNull(before.body)
        assertEquals(plan().sensoryCues,plan(listOf(birth,detonate,death,end)).sensoryCues)
        assertTrue(plan(listOf(birth,death,end)).sensoryCues.isEmpty())
    }
    @Test fun `repeated authoritative detonate preserves the already registered blast plus source's immediate dead fallback`() {
        val p=plan(listOf(birth,detonate,detonate,end));assertEquals(2,p.sensoryCues.size)
        assertEquals(1,p.sensoryCues.count {it.body!=null})
        val c=clock(p.sensoryCues);advance(c,0f)
        assertEquals(listOf(policy.pattern("medium")),advance(c,1f))
        assertEquals(listOf(policy.pattern("medium")),advance(c,p.sensoryCues.maxOf {it.atTick}))
    }
    @Test fun `source fallback key and completion own missing and unreachable blast annotations`() {
        val clip=art.clips.getValue(art.profile.getString("detonate"))
        fun selected(frames:List<Int>?)=art.copy(clips=art.clips+("detonate" to clip.copy(fxCues=frames?.let {mapOf("keg_blast" to it)} ?: emptyMap())),effects=emptyMap())
        val missing=plan(selected=selected(null)).sensoryCues.single()
        assertEquals(1f+(policy.kegDetonation!!.fallbackFrame-1)*10f/clip.fps,missing.atTick,.00001f)
        val unreachable=plan(selected=selected(listOf(clip.frames.first().size+1))).sensoryCues.single()
        assertEquals(1f+clip.durationMs/100f,unreachable.atTick,.00001f)
        assertTrue(unreachable.atTick>missing.atTick)
    }
    @Test fun `absent optional policy leaves original prime body and effect bytes unchanged`() {
        val now=plan();val old=plan(contract=policy.copy(kegDetonation=null));assertTrue(old.sensoryCues.isEmpty())
        for(t in listOf(0f,1f,1.8f,3f,8f)) {
            assertEquals(old.actor(1,t),now.actor(1,t))
            val a=mutableListOf<CombatSprite>();val b=mutableListOf<CombatSprite>();old.transientSprites(t,a);now.transientSprites(t,b);assertEquals(a,b)
        }
        assertEquals(old.playbackExtent,now.playbackExtent)
    }
    @Test fun `cold body reconstruction never arms feedback and a later live detonate gets its own callback`() {
        assertTrue(plan(start=BattlePresentationStart.ColdPrefix(1.2f)).sensoryCues.isEmpty())
        val next=detonate.replace("\"t\":1","\"t\":2")
        val cold=plan(listOf(birth,detonate,next,end),start=BattlePresentationStart.ColdPrefix(1.2f)).sensoryCues.single()
        assertEquals(2f,cold.body!!.sourceTick)
        assertEquals(plan(listOf(birth,next,end)).sensoryCues.single().atTick,cold.atTick)
    }
    @Test fun `late first frame cannot invent a body callback whose source registration was never presented`() {
        val cue=plan().sensoryCues.single();val c=clock(listOf(cue));advance(c,1.2f)
        assertTrue(advance(c,cue.atTick).isEmpty());assertEquals(SensoryOffset(),c.offset)
    }
    @Test fun `pause seek background content identity and loading revoke pending body feedback`() {
        val cue=plan().sensoryCues.single()
        for(mode in listOf("pause","seek","epoch","off","loading")) {
            val c=clock(listOf(cue));advance(c,0f);advance(c,1f)
            if(mode=="loading")c.interrupted()
            val epoch=if(mode=="epoch")2L else if(mode=="off")-1L else 1L;val control=if(mode=="seek")2L else 1L
            advance(c,1.2f,epoch,control,mode!="pause");advance(c,1.3f,if(mode=="off")2 else epoch,control)
            assertTrue(advance(c,cue.atTick,if(mode=="off")2 else epoch,control).isEmpty(),mode)
        }
    }
    @Test fun `fresh actual zero is distinct from cold initialization and playback speed keeps authored tick ownership`() {
        val zero=detonate.replace("\"t\":1","\"t\":0");val cue=plan(listOf(birth,zero,end)).sensoryCues.single()
        for(rate in listOf(.5f,1f,2f)) {
            val fresh=clock(listOf(cue),true);advance(fresh,0f,rate=rate)
            assertEquals(listOf(policy.pattern("medium")),advance(fresh,cue.atTick,rate=rate))
            val cold=clock(listOf(cue));advance(cold,0f);assertTrue(advance(cold,cue.atTick).isEmpty())
        }
    }
    @Test fun `unchanged same raid append retains exact body ownership while corrected prior event revokes it`() {
        val cue=plan().sensoryCues.single();val c=clock(listOf(cue));advance(c,0f);advance(c,1f);advance(c,1.2f)
        val records=listOf(birth,detonate,"""{"e":"star","t":20,"n":2}""",end)
        assertTrue(c.continueRevision(plan(records).sensoryCues,scene(),scene(records),1.2f))
        advance(c,1.2f);assertEquals(listOf(policy.pattern("medium")),advance(c,cue.atTick))
        val other=clock(listOf(cue));advance(other,0f);advance(other,1f)
        val correction=listOf(birth,detonate.replace("1024","2048"),end)
        assertFalse(other.continueRevision(plan(correction).sensoryCues,scene(),scene(correction),1f))
    }
    @Test fun `optional Keg contract refuses changed callback policy or fractional fallback indices during preparation`() {
        val raw=reader.parse(reference.get("policy").toJson(JsonWriter.OutputType.json))
        raw.get("kegDetonation").get("fallbackFrame").set(1.5,null)
        assertFailsWith<IllegalArgumentException>{SensoryPolicy.parse(raw)}
        raw.remove("kegDetonation");assertNull(assertNotNull(SensoryPolicy.parse(raw)).kegDetonation)
    }
}
