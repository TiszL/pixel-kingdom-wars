package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import kotlin.test.*
import org.junit.Test

class GiantSensoryTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/sensory/source-reference.json")).bufferedReader().readText())
    private val policy=assertNotNull(SensoryPolicy.parse(reference.get("policy"))).copy(eventHaptics=null)
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val catalogue=reader.parse(root.resolve("render-catalog.json").readText())
    private val library=CombatArt.catalogue(catalogue)
    private val frames=catalogue.get("actors").filter { it.getString("type","")=="giant" }.map {it.getString("frameKey")}.distinct()
    private val frame=frames.first()
    private val art=library.getValue(frame)
    private val birth="""{"e":"deploy","t":0,"id":1,"troop":"giant","x":0,"y":0}"""
    private val fire="""{"e":"troopFire","t":1,"id":1,"proj":"boulder","ix":1024,"iy":1024}"""
    private val end="""{"e":"star","t":40,"n":1}"""
    private fun scene(records:List<String> = listOf(birth,fire,end),key:String=frame,
                      start:BattlePresentationStart=BattlePresentationStart.Continuous)=BattleScene(
        BaseScene(emptyList(),32,32,64f),PresentationRevision("raid","rev",14,0,0,records.map(PresentationEvent::fromJson)),
        mapOf("giant" to key,"donor" to key),256f,100f,5,5,presentationStart=start)
    private fun plan(records:List<String> = listOf(birth,fire,end),key:String=frame,selected:CombatArt?=library[key],
                     contract:SensoryPolicy?=policy,start:BattlePresentationStart=BattlePresentationStart.Continuous):CombatVisualPlan {
        val scene=scene(records,key,start)
        return CombatVisualPlan(scene,BattleVisualModel(scene.revision.events,5),selected?.let {mapOf(key to it)} ?: emptyMap(),sensoryPolicy=contract)
    }
    private fun advance(p:BattleSensoryPlayback,t:Float,epoch:Long=1,control:Long=1,playing:Boolean=true)=
        p.advance(t,0f,1f,playing,epoch,control,policy,800f,600f,1f)
    private fun playback(cues:List<HeroSensoryCue>)=BattleSensoryPlayback {0f}.also {it.replace(cues,false)}

    @Test fun `every admitted Giant tier lands at its own visible fractional projectile boundary exactly once`() {
        for(key in frames) {
            val a=library.getValue(key);val p=plan(key=key);val cue=p.sensoryCues.single();val ownership=assertNotNull(cue.flight)
            val clip=a.clips.getValue("throw");val projectile=a.projectiles.getValue("boulder")
            val release=100f+(clip.fxCues.getValue("boulder").first()-1)*1000f/clip.fps
            assertEquals(1f,ownership.sourceTick);assertEquals(release/100f,ownership.releaseTick,.00001f)
            assertEquals((release+projectile.travelMs)/100f,cue.atTick,.00001f)
            assertEquals(policy.giantLanding?.effects,cue.effects)
            val sprites=mutableListOf<CombatSprite>();p.transientSprites(cue.atTick,sprites)
            assertTrue(sprites.any {it.clip.key==projectile.impact!!.key},key)
            val clock=playback(listOf(cue));advance(clock,0f);advance(clock,1f);advance(clock,ownership.releaseTick)
            assertTrue(advance(clock,Math.nextDown(cue.atTick)).isEmpty())
            assertEquals(listOf(policy.pattern("medium")),advance(clock,cue.atTick));assertNotEquals(SensoryOffset(),clock.offset)
            assertTrue(advance(clock,cue.atTick).isEmpty())
        }
    }
    @Test fun `missing actor rich throw release or travel cannot invent source rich-controller feedback`() {
        val boulder=art.projectiles.getValue("boulder")
        for(p in listOf(plan(listOf(fire,end)),plan(selected=null),plan(selected=art.copy(clips=art.clips-"throw")),
            plan(selected=art.copy(projectiles=emptyMap())),plan(selected=art.copy(projectiles=mapOf("boulder" to boulder.copy(travel=null)))),
            plan(selected=art.copy(clips=art.clips+("throw" to art.clips.getValue("throw").copy(fxCues=emptyMap())))),
            plan(listOf(birth.replace("\"troop\":\"giant\"","\"troop\":\"giant\",\"hero\":\"donor\""),fire,end))))
            assertTrue(p.sensoryCues.isEmpty())
    }
    @Test fun `optional impact absence still completes but historical policy preserves original body and flight`() {
        val boulder=art.projectiles.getValue("boulder")
        assertEquals(1,plan(selected=art.copy(projectiles=mapOf("boulder" to boulder.copy(impact=null)))).sensoryCues.size)
        val now=plan();val old=plan(contract=policy.copy(giantLanding=null));assertTrue(old.sensoryCues.isEmpty())
        val a=mutableListOf<CombatSprite>();val b=mutableListOf<CombatSprite>()
        for(t in listOf(1f,3f,5f,14f,30f)){now.transientSprites(t,a);old.transientSprites(t,b);assertEquals(a,b)}
        assertEquals(now.playbackExtent,old.playbackExtent)
    }
    @Test fun `death before authored release cancels while a launched boulder survives its Giant`() {
        fun death(t:Int)="""{"e":"troopDeath","t":$t,"id":1}"""
        assertTrue(plan(listOf(birth,death(0),fire,end)).sensoryCues.isEmpty())
        assertTrue(plan(listOf(birth,fire,death(3),end)).sensoryCues.isEmpty())
        assertEquals(plan().sensoryCues,plan(listOf(birth,fire,death(4),end)).sensoryCues)
        val clock=playback(plan(listOf(birth,fire,death(4),end)).sensoryCues)
        val cue=plan().sensoryCues.single();advance(clock,0f);advance(clock,1f);advance(clock,5f)
        assertEquals(listOf(policy.pattern("medium")),advance(clock,cue.atTick))
    }
    @Test fun `midthrow hit and movement keep released ownership rather than replaying damage feedback`() {
        val records=listOf(birth,fire,"""{"e":"hit","t":2,"target":1,"dmg":1}""",
            """{"e":"pos","t":2,"id":1,"x":128,"y":128}""",end)
        assertEquals(plan().sensoryCues,plan(records).sensoryCues)
    }
    @Test fun `compact attack run cycles use each actual start and retain only future cold suffix ownership`() {
        val run="""{"e":"attackRun","t":1,"id":1,"mode":"projectile","technique":"boulder","count":3,"cadenceTicks":10,"ix":1024,"iy":1024}"""
        val records=listOf(birth,run,fire,end)
        val cues=plan(records).sensoryCues
        assertEquals(listOf(1f,11f,21f),cues.map {it.flight!!.sourceTick})
        assertEquals(3,plan(records).flightCount,"Legacy duplicate does not create a second callback")
        val cold=plan(records,start=BattlePresentationStart.ColdPrefix(5f))
        assertEquals(listOf(11f,21f),cold.sensoryCues.map {it.flight!!.sourceTick})
        val clock=playback(cold.sensoryCues);advance(clock,5f)
        val times=cold.sensoryCues.flatMap {listOf(it.flight!!.sourceTick,it.flight.releaseTick,it.atTick)}.distinct().sorted()
        assertEquals(List(2){policy.pattern("medium")},times.flatMap {advance(clock,it)})
    }
    @Test fun `cold windup and in flight reconstruction never renew an expired callback`() {
        for(at in listOf(2f,5f)) {
            val p=plan(start=BattlePresentationStart.ColdPrefix(at));assertEquals(1,p.flightCount);assertTrue(p.sensoryCues.isEmpty())
        }
    }
    @Test fun `seek pause loading and context changes revoke Giant callbacks in both ownership phases`() {
        val cue=plan().sensoryCues.single()
        for(at in listOf(2f,5f))for(mode in listOf("seek","pause","loading","epoch")) {
            val p=playback(listOf(cue));advance(p,0f);advance(p,1f);advance(p,at)
            if(mode=="loading")p.interrupted()
            val epoch=if(mode=="epoch")2L else 1L;val control=if(mode=="seek")2L else 1L
            advance(p,at,epoch,control,mode!="pause");advance(p,at+.1f,epoch,control)
            assertTrue(advance(p,cue.atTick,epoch,control).isEmpty(),"$mode at$at")
        }
    }
    @Test fun `safe same raid appends preserve Giant ownership and corrected fire never transfers it`() {
        val cue=plan().sensoryCues.single();val old=scene()
        for(at in listOf(2f,5f)) {
            val p=playback(listOf(cue));advance(p,0f);advance(p,1f);advance(p,at)
            val records=listOf(birth,fire,"""{"e":"star","t":30,"n":2}""",end)
            assertTrue(p.continueRevision(plan(records).sensoryCues,old,scene(records),at))
            advance(p,at);advance(p,cue.flight!!.releaseTick.coerceAtLeast(at))
            assertEquals(listOf(policy.pattern("medium")),advance(p,cue.atTick))
        }
        val p=playback(listOf(cue));advance(p,0f);advance(p,1f);advance(p,5f)
        val records=listOf(birth,fire.replace("1024","2048"),end)
        assertFalse(p.continueRevision(plan(records).sensoryCues,old,scene(records),5f))
    }
    @Test fun `rich-controller requirement is explicit and absent optional Giant policy remains readable`() {
        val raw=reader.parse(reference.get("policy").toJson(JsonWriter.OutputType.json))
        raw.get("giantLanding").get("requiresRichThrow").set(false)
        assertFailsWith<IllegalArgumentException>{SensoryPolicy.parse(raw)}
        raw.remove("giantLanding");assertNull(assertNotNull(SensoryPolicy.parse(raw)).giantLanding)
    }

    @Test fun `different admitted body cancels only a throw that has not released`() {
        fun melee(t:Int)="""{"e":"troopAttack","t":$t,"id":1,"targetKind":"building","technique":"strike","ix":1024,"iy":1024}"""
        val before=listOf(birth,fire,melee(2),end)
        assertEquals(0,plan(before).flightCount);assertTrue(plan(before).sensoryCues.isEmpty())
        assertEquals(1,plan(before,contract=policy.copy(giantLanding=null)).flightCount,"Old optional packs preserve historical rendering")
        val after=plan(listOf(birth,fire,melee(4),end))
        assertEquals(1,after.flightCount);assertEquals(plan().sensoryCues,after.sensoryCues)
    }
    @Test fun `identical and hysteresis retained throw rows preserve original callback target and phase`() {
        val original=plan()
        for(second in listOf(fire.replace("\"t\":1","\"t\":2"),
            """{"e":"troopFire","t":2,"id":1,"proj":"boulder","ix":2048,"iy":700}""")) {
            val p=plan(listOf(birth,fire,second,end))
            assertEquals(1,p.flightCount);assertEquals(original.sensoryCues,p.sensoryCues)
            assertEquals(original.actor(1,3f)?.frameKey,p.actor(1,3f)?.frameKey)
            val expected=mutableListOf<CombatSprite>();val actual=mutableListOf<CombatSprite>()
            original.transientSprites(original.sensoryCues.single().atTick,expected)
            p.transientSprites(original.sensoryCues.single().atTick,actual);assertEquals(expected,actual)
        }
    }
    @Test fun `changed throw row transfers callback target while keeping old phase before release`() {
        val second=fire.replace("\"t\":1","\"t\":2").replace("\"ix\":1024","\"ix\":-1024")
        val p=plan(listOf(birth,fire,second,end));val cue=p.sensoryCues.single();val normal=plan()
        assertEquals(1,p.flightCount);assertEquals(2f,cue.flight!!.sourceTick)
        assertEquals(normal.sensoryCues.single().atTick,cue.atTick)
        assertEquals(normal.actor(1,3f)?.frameKey?.substringAfterLast("_f"),p.actor(1,3f)?.frameKey?.substringAfterLast("_f"))
        val sprites=mutableListOf<CombatSprite>();p.transientSprites(cue.atTick,sprites)
        assertEquals(-256f,sprites.single {it.clip.key==art.projectiles.getValue("boulder").impact!!.key}.x)
        val dies=plan(listOf(birth,fire,second,"""{"e":"troopDeath","t":4,"id":1}""",end))
        assertEquals(p.sensoryCues,dies.sensoryCues,"Death after preserved release must not use restarted release time")
    }
    @Test fun `row changes after release neither cancel the independent boulder nor reenter its passed release frame`() {
        for(second in listOf(fire.replace("\"t\":1","\"t\":4"),fire.replace("\"t\":1","\"t\":4").replace("\"ix\":1024","\"ix\":-1024"))) {
            val p=plan(listOf(birth,fire,second,end));assertEquals(1,p.flightCount);assertEquals(plan().sensoryCues,p.sensoryCues)
        }
    }
    @Test fun `walk after completed throw owns the next stable facing while an active throw preserves its row`() {
        val walk="""{"e":"pos","t":12,"id":1,"x":-1024,"y":0}"""
        val next="""{"e":"troopFire","t":13,"id":1,"proj":"boulder","ix":-2048,"iy":600}"""
        val p=plan(listOf(birth,fire,walk,next,end))
        val body=assertNotNull(p.actor(1,13f));val clip=art.clips.getValue("throw")
        assertEquals(clip.frames[clip.row("w")].first(),body.frameKey,
            "The completed southeast throw cannot override the later westward walk's hysteresis")
        assertEquals(2,p.flightCount)
    }

    @Test fun `future cold suffix cannot inherit the phase or callback of a suppressed historical throw`() {
        for(next in listOf(fire.replace("\"t\":1","\"t\":2"),
            fire.replace("\"t\":1","\"t\":2").replace("\"ix\":1024","\"ix\":-1024"))) {
            val p=plan(listOf(birth,fire,next,end),start=BattlePresentationStart.ColdPrefix(1.5f))
            val fresh=plan(listOf(birth,next,end));val cue=p.sensoryCues.single()
            assertEquals(fresh.sensoryCues.single().atTick,cue.atTick)
            assertEquals(2f,cue.flight!!.sourceTick)
            assertEquals(fresh.actor(1,3f)?.frameKey,p.actor(1,3f)?.frameKey)
            assertEquals(2,p.flightCount,"Existing historical flight reconstruction remains visual-only")
            val clock=playback(p.sensoryCues);advance(clock,1.5f);advance(clock,2f);advance(clock,cue.flight!!.releaseTick)
            assertEquals(listOf(policy.pattern("medium")),advance(clock,cue.atTick))
        }
    }

}
