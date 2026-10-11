package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import com.badlogic.gdx.utils.JsonWriter
import java.io.File
import kotlin.test.*
import org.junit.Test

class MortarSensoryTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/sensory/source-reference.json")).bufferedReader().readText())
    private val policy=assertNotNull(SensoryPolicy.parse(reference.get("policy"))).copy(eventHaptics=null)
    private val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val catalogue=reader.parse(root.resolve("render-catalog.json").readText())
    private val library=CombatArt.catalogue(catalogue)
    private val entry=catalogue.get("entries").first { it.getString("type","")=="mortar" }
    private val frame=entry.getString("frameKey")
    private val art=library.getValue(frame)
    private val fire="""{"e":"fire","t":1,"id":"mortar","proj":"shell","ix":1024,"iy":1024}"""
    private val end="""{"e":"star","t":30,"n":1}"""
    private fun plan(records:List<String> = listOf(fire,end), selected:CombatArt?=art,
                     contract:SensoryPolicy?=policy,start:BattlePresentationStart=BattlePresentationStart.Continuous,
                     type:String="mortar",present:Boolean=true):CombatVisualPlan {
        val scene=scene(records,start,type,present)
        return CombatVisualPlan(scene,BattleVisualModel(scene.revision.events,5),selected?.let { mapOf(frame to it) } ?: emptyMap(),sensoryPolicy=contract)
    }
    private fun scene(records:List<String> = listOf(fire,end),start:BattlePresentationStart=BattlePresentationStart.Continuous,
                      type:String="mortar",present:Boolean=true):BattleScene {
        val building=RenderBuilding("mortar",frame,1f,1f,2f,2f,type=type)
        return BattleScene(BaseScene(if(present)listOf(building)else emptyList(),32,32,64f),
            PresentationRevision("raid","rev",14,0,0,records.map(PresentationEvent::fromJson)),emptyMap(),256f,100f,5,5,presentationStart=start)
    }
    private fun advance(p:BattleSensoryPlayback,t:Float,epoch:Long=1,control:Long=1,playing:Boolean=true,rate:Float=1f,delta:Float=0f)=
        p.advance(t,delta,rate,playing,epoch,control,policy,800f,600f,1f)
    private fun playback(cue:HeroSensoryCue,fresh:Boolean=false)=BattleSensoryPlayback { 0f }.also {it.replace(listOf(cue),fresh)}
    @Test fun `actual admitted mortar flight owns exact fractional release and landing rather than damage tick`() {
        val p=plan();val cue=p.sensoryCues.single();val flight=assertNotNull(cue.flight)
        val clip=art.clips.getValue("fire");val release=100f+(clip.fxCues.getValue("shell").first()-1)*1000f/clip.fps
        assertEquals(1f,flight.sourceTick);assertEquals(release/100f,flight.releaseTick,.00001f)
        assertEquals((release+art.projectiles.getValue("shell").travelMs)/100f,cue.atTick,.00001f)
        assertNotEquals(cue.atTick.toInt().toFloat(),cue.atTick)
        assertEquals(policy.mortarLanding,cue.effects)
        val out=mutableListOf<CombatSprite>();p.transientSprites(cue.atTick,out)
        assertTrue(out.any { it.clip.key==art.projectiles.getValue("shell").impact!!.key },"Feedback boundary is the existing visible impact")
        val clock=playback(cue);advance(clock,0f);advance(clock,flight.sourceTick);advance(clock,flight.releaseTick)
        assertTrue(advance(clock,Math.nextDown(cue.atTick)).isEmpty())
        assertEquals(listOf(policy.pattern("medium")),advance(clock,cue.atTick));assertNotEquals(SensoryOffset(),clock.offset)
        assertTrue(advance(clock,cue.atTick).isEmpty())
    }
    @Test fun `only authored mortar shell receives new feedback and absent optional policy preserves all art`() {
        for(p in listOf(plan(type="cannon"),plan(present=false),plan(selected=null),plan(contract=policy.copy(mortarLanding=null))))
            assertTrue(p.sensoryCues.isEmpty())
        val current=plan();val previous=plan(contract=policy.copy(mortarLanding=null))
        val a=mutableListOf<CombatSprite>();val b=mutableListOf<CombatSprite>()
        for(t in listOf(1f,3f,10f,15f,30f)){current.transientSprites(t,a);previous.transientSprites(t,b);assertEquals(b,a)}
    }
    @Test fun `missing release or travel omits landing but missing impact does not swallow source callback`() {
        val projectile=art.projectiles.getValue("shell")
        assertTrue(plan(selected=art.copy(projectiles=emptyMap())).sensoryCues.isEmpty())
        assertTrue(plan(selected=art.copy(projectiles=mapOf("shell" to projectile.copy(travel=null)))).sensoryCues.isEmpty())
        assertTrue(plan(selected=art.copy(clips=art.clips+ ("fire" to art.clips.getValue("fire").copy(fxCues=emptyMap())))).sensoryCues.isEmpty())
        assertEquals(1,plan(selected=art.copy(projectiles=mapOf("shell" to projectile.copy(impact=null)))).sensoryCues.size)
    }
    @Test fun `collapse before release cancels ownership while a launched shell outlives its building`() {
        val before=plan(listOf(fire,"""{"e":"destroyed","t":2,"id":"mortar"}""",end))
        val after=plan(listOf(fire,"""{"e":"destroyed","t":3,"id":"mortar"}""",end))
        assertEquals(0,before.flightCount);assertTrue(before.sensoryCues.isEmpty())
        assertEquals(1,after.flightCount);assertEquals(plan().sensoryCues,after.sensoryCues)
    }
    @Test fun `cold reconstruction during windup or flight preserves visual history but never arms its callback`() {
        for(boundary in listOf(1.5f,5f)) {
            val p=plan(start=BattlePresentationStart.ColdPrefix(boundary))
            assertEquals(1,p.flightCount);assertTrue(p.sensoryCues.isEmpty())
        }
    }
    @Test fun `fractional canonical event overrides share the same existing visible flight clock`() {
        val updated=fire.dropLast(1)+""", "releaseOffsetMs":12.5,"flightMs":537.5}"""
        val cue=plan(listOf(updated,end)).sensoryCues.single()
        assertEquals(1.125f,cue.flight!!.releaseTick);assertEquals(6.5f,cue.atTick)
    }
    @Test fun `seek pause pack identity or loading between start release and landing discards the whole old flight`() {
        val cue=plan().sensoryCues.single()
        for(at in listOf(1.5f,5f))for(mode in listOf("seek","pause","epoch","off","loading")) {
            val p=playback(cue);advance(p,0f);advance(p,1f)
            if(at>cue.flight!!.releaseTick)advance(p,cue.flight.releaseTick)
            if(mode=="loading")p.interrupted()
            val epoch=if(mode=="epoch")2L else if(mode=="off")-1L else 1L
            val control=if(mode=="seek")2L else 1L
            advance(p,at,epoch,control,mode!="pause")
            advance(p,at+.1f,if(mode=="off")2 else epoch,control,true)
            assertTrue(advance(p,cue.atTick,if(mode=="off")2 else epoch,control).isEmpty(),"$mode at$at")
            assertEquals(SensoryOffset(),p.offset)
        }
    }
    @Test fun `fresh actual zero fire can arm but cold first frame and late initial frame cannot`() {
        val cue=plan(listOf(fire.replace("\"t\":1","\"t\":0"),end)).sensoryCues.single()
        for(fresh in listOf(false,true)) {
            val p=playback(cue,fresh);advance(p,0f);advance(p,cue.flight!!.releaseTick)
            assertEquals(if(fresh)listOf(policy.pattern("medium"))else emptyList(),advance(p,cue.atTick))
        }
        val late=playback(cue,true);advance(late,.1f);advance(late,cue.flight!!.releaseTick);assertTrue(advance(late,cue.atTick).isEmpty())
    }
    @Test fun `overlapping owned landings preserve invocation order without coupling haptics to the shake cap`() {
        val cue=plan().sensoryCues.single();val n=policy.concurrentShakeCap+1
        val p=BattleSensoryPlayback();p.replace(List(n) {cue.copy(ordinal=it)},false)
        advance(p,0f);advance(p,cue.flight!!.sourceTick);advance(p,cue.flight.releaseTick)
        assertEquals(List(n){policy.pattern("medium")},advance(p,cue.atTick));assertTrue(advance(p,cue.atTick).isEmpty())
    }
    @Test fun `invalid optional landing policy fails before any rendering while old packs remain valid`() {
        assertNotNull(SensoryPolicy.parse(reader.parse(reference.get("policy").toJson(JsonWriter.OutputType.json)).also {it.remove("mortarLanding")}))
        for(field in listOf("requiresTravel","requiresImpact")) {
            val p=reader.parse(reference.get("policy").toJson(JsonWriter.OutputType.json));val value=p.get("mortarLanding").get(field)
            value.set(!value.asBoolean());assertFailsWith<IllegalArgumentException>{SensoryPolicy.parse(p)}
        }
    }

    @Test fun `unchanged same raid revision preserves started and released exact flights once`() {
        val cue=plan().sensoryCues.single();val old=scene()
        val records=listOf(fire,"""{"e":"star","t":20,"n":2}""",end)
        val next=scene(records).let {it.copy(revision=it.revision.copy(revision="appended",lastSequence=1))}
        for(at in listOf(1.5f,5f)) {
            val p=playback(cue);advance(p,0f);advance(p,1f);advance(p,at)
            assertTrue(p.continueRevision(plan(records).sensoryCues,old,next,at))
            advance(p,at);advance(p,cue.flight!!.releaseTick.coerceAtLeast(at))
            assertEquals(listOf(policy.pattern("medium")),advance(p,cue.atTick),"at$at")
            assertTrue(advance(p,cue.atTick).isEmpty())
        }
    }
    @Test fun `changed inserted or reordered rendered history revokes every old pool callback`() {
        val extra="""{"e":"star","t":1,"n":1}"""
        val original=listOf(fire,extra,end);val cue=plan(original).sensoryCues.single();val old=scene(original)
        for(records in listOf(listOf(fire.replace("1024","2048"),extra,end),listOf(extra,fire,end),listOf(fire,extra,extra,end))) {
            val p=playback(cue);advance(p,0f);advance(p,1f);advance(p,5f)
            val next=scene(records)
            assertFalse(p.continueRevision(plan(records).sensoryCues,old,next,5f))
            p.replace(plan(records).sensoryCues,false);advance(p,5f,control=2)
            assertTrue(advance(p,cue.atTick,control=2).isEmpty())
        }
    }
    @Test fun `same ordinal alone cannot transfer an altered source timing or ordered effect callback`() {
        val cue=plan().sensoryCues.single();val old=scene()
        val variants=listOf(cue.copy(ordinal=cue.ordinal+1),cue.copy(atTick=cue.atTick+1),
            cue.copy(effects=cue.effects.reversed()),cue.copy(flight=cue.flight!!.copy(source=PresentationEvent.fromJson(fire.replace("1024","2048")))))
        for(changed in variants) {
            val p=playback(cue);advance(p,0f);advance(p,1f);advance(p,5f)
            assertTrue(p.continueRevision(listOf(changed),old,old.copy(revision=old.revision.copy(revision="appended")),5f))
            advance(p,5f);assertTrue(advance(p,changed.atTick).isEmpty())
        }
    }
    @Test fun `a revision cannot rescue ownership revoked by loading lifecycle or explicit control`() {
        val cue=plan().sensoryCues.single();val old=scene()
        for(mode in listOf("loading","epoch","control","pause")) {
            val p=playback(cue);advance(p,0f);advance(p,1f);advance(p,5f)
            if(mode=="loading")p.interrupted()
            val accepted=p.continueRevision(listOf(cue),old,old.copy(revision=old.revision.copy(revision="appended")),5f)
            if(mode=="loading")assertFalse(accepted)
            val epoch=if(mode=="epoch")2L else 1L;val control=if(mode=="control")2L else 1L
            advance(p,5f,epoch,control,mode!="pause");advance(p,6f,epoch,control)
            assertTrue(advance(p,cue.atTick,epoch,control).isEmpty(),mode)
        }
    }
    @Test fun `cross raid rewind geometry and playback policy changes cannot qualify as continuous replacement`() {
        val cue=plan().sensoryCues.single();val old=scene()
        for(next in listOf(old.copy(revision=old.revision.copy(raidId="other")),old.copy(tickDurationMs=95f),
            old.copy(base=old.base.copy(tilePixels=32f)),old.copy(rate=2f),old.copy(playing=false),
            old.copy(presentationStart=BattlePresentationStart.ColdPrefix(5f)))) {
            val p=playback(cue);advance(p,0f);advance(p,1f);advance(p,5f)
            assertFalse(p.continueRevision(listOf(cue),old,next,5f))
        }
        val p=playback(cue);advance(p,0f);advance(p,1f);advance(p,5f)
        assertFalse(p.continueRevision(listOf(cue),old,old,4f))
    }
}
