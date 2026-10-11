package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import kotlin.test.*
import org.junit.Test

class HitFeedbackTest {
    private val reader=JsonReader()
    private val reference=reader.parse(checkNotNull(javaClass.getResourceAsStream("/hit-feedback/source-reference.json")).bufferedReader().readText())
    private val policy=assertNotNull(HitFeedbackPolicy.parse(reference.get("policy")))
    private val pack=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val catalogue=reader.parse(pack.resolve("render-catalog.json").readText())
    private val actual=CombatArt.catalogue(catalogue)
    private val actorFrame=catalogue.get("actors").first { it.getString("type")=="highlander" }.getString("frameKey")
    private val buildingFrame=catalogue.get("entries").first { it.getString("type")=="cannon" }.getString("frameKey")
    private fun art(height:Float)=actual.mapValues { (_,art)->art.copy(clips=art.clips.mapValues { (_,c)->c.copy(cellHeight=height,scale=1f) }) }
    private val deploy="""{"e":"deploy","t":0,"id":1,"troop":"highlander","x":17,"y":23}"""
    private fun hit(t:Int=10,target:String="1",damage:String="8")="""{"e":"hit","t":$t,"target":$target,"dmg":$damage}"""
    private fun scene(events:List<String>,start:BattlePresentationStart=BattlePresentationStart.Continuous,type:String?=null):BattleScene {
        val service=type?.let { RenderServiceIdentity(it,if(it=="berth")null else 1) }
        return BattleScene(BaseScene(listOf(RenderBuilding("base",if(service==null)buildingFrame else "service:$type:1",4f,
            if(service==null)5f else 6f,2f,if(service==null)3f else 2f,type=type,service=service),
            RenderBuilding("tower",buildingFrame,0f,0f,1f,1f)),32,32,1f),
            PresentationRevision("raid","rev",if(service==null)14 else 18,0,0,events.map(PresentationEvent::fromJson)),mapOf("highlander" to actorFrame),1f,100f,5,5,presentationStart=start)
    }
    private fun plan(events:List<String>,p:HitFeedbackPolicy?=policy,height:Float=200f,start:BattlePresentationStart=BattlePresentationStart.Continuous,type:String?=null):CombatVisualPlan {
        val s=scene(events,start,type);return CombatVisualPlan(s,BattleVisualModel(s.revision.events,5),art(height),hitPolicy=p)
    }
    private fun stars(plan:CombatVisualPlan,tick:Float,from:Float=0f)=mutableListOf<CombatSprite>().also {
        plan.hitFeedback?.sprites(tick,from,it)
    }
    @Test fun `native admission and original anchors match every actual source handler case`() {
        for(c in reference.get("cases")) {
            val name=c.getString("name");val kind=c.getString("kind");val events=mutableListOf<String>()
            val missing=c.getBoolean("missing");val alive=c.getBoolean("alive")
            if(!missing)events+=deploy
            if(!alive)events+="""{"e":"troopDeath","t":9,"id":1}"""
            if(c.getBoolean("destroyed"))events+="""{"e":"destroyed","t":9,"id":"base"}"""
            val d=c.get("damage");val damage=if(d.isNull)"" else ",\"dmg\":${d.asInt()}"
            events+=when(kind) {
                "chain"->"""{"e":"chain","t":10,"id":"${if(missing)"missing" else "tower"}","targets":[1],"dmg":[${if(d.isNull)"" else d.asInt()}]}"""
                "building"->"""{"e":"hit","t":10,"target":"${if(missing)"missing" else "base"}"$damage}"""
                else->"""{"e":"hit","t":10,"target":1$damage}"""
            }
            val start=if(c.getBoolean("jumping"))BattlePresentationStart.ColdPrefix(11f) else BattlePresentationStart.Continuous
            val p=plan(events,height=c.getFloat("height"),start=start,type=c.getString("type",null))
            val cues=assertNotNull(p.hitFeedback).cues
            assertEquals(c.get("stars").size,cues.size,name)
            // The canonical handler probe supplies a controlled body height. Real service
            // readiness is independently covered by the leased-plan and cursor tests.
            val cursor=ServiceHitCursor();val rendered=mutableListOf<CombatSprite>()
            p.hitFeedback!!.sprites(10f,0f,rendered) { cue -> cursor.y(cue,policy) { c.getFloat("height") } }
            rendered.zip(c.get("stars").toList()).forEach { (actual,expected)->
                assertEquals(expected.getFloat("x"),actual.x,0.001f,name);assertEquals(expected.getFloat("y"),actual.y,0.001f,name)
            }
            assertEquals(c.get("stars").size,rendered.size,name)
        }
    }
    @Test fun `service hits retain source ordinal health without inventing a legacy frame or future same-tick damage`() {
        val events=listOf(hit(10,"\"base\"","50"),hit(10,"\"base\"","1"),
            """{"e":"destroyed","t":10,"id":"base"}""")
        val original=scene(events,type="workshop")
        val s=original.copy(base=original.base.copy(buildings=original.base.buildings.map { it.copy(initialHp=100,maxHp=100) }))
        val p=CombatVisualPlan(s,BattleVisualModel(s.revision.events,5),actual,.5f,hitPolicy=policy)
        val cues=p.hitFeedback!!.cues
        assertEquals(listOf(ServiceCombatState.IDLE,ServiceCombatState.DAMAGED),cues.map { it.service!!.state })
        assertEquals(listOf(0,1),cues.map { it.ordinal });assertTrue(cues.all { it.y==8f })
        assertTrue(stars(p,10f).isEmpty(),"Unknown current service geometry cannot use a legacy fallback")
        val unknownPlan=plan(listOf(hit(target="\"base\"")),type="workshop")
        assertNull(unknownPlan.buildingHealthAt("base",10f),"Historical absence must not invent HP")
        assertEquals(ServiceCombatState.IDLE,unknownPlan.hitFeedback!!.cues.single().service!!.state,
            "The actual painter retains its neutral IDLE body when health is unknown")
        for((initial,max,threshold) in listOf(Triple(0L,0L,.5f),Triple(100L,100L,null))) {
            val raw=scene(listOf(hit(target="\"base\"")),type="workshop")
            val edge=raw.copy(base=raw.base.copy(buildings=raw.base.buildings.map { it.copy(initialHp=initial,maxHp=max) }))
            val edgePlan=CombatVisualPlan(edge,BattleVisualModel(edge.revision.events,5),actual,threshold,hitPolicy=policy)
            assertNull(edgePlan.buildingHealthAt("base",10f)!!.damagedSinceTick)
            assertEquals(ServiceCombatState.IDLE,edgePlan.hitFeedback!!.cues.single().service!!.state)
        }
    }
    @Test fun `same tick death before hit suppresses while hit before death keeps independent star`() {
        val dead="""{"e":"troopDeath","t":10,"id":1}"""
        assertTrue(stars(plan(listOf(deploy,dead,hit())),10f).isEmpty())
        assertEquals(1,stars(plan(listOf(deploy,hit(),dead)),10f).size)
        assertEquals(1,stars(plan(listOf(deploy,hit(),dead)),11f).size)
    }
    @Test fun `later same tick attack cannot change original hit body height`() {
        val attack="""{"e":"troopAttack","t":10,"id":1,"ix":70,"iy":23}"""
        fun anchor(events:List<String>):Float {
            val s=scene(events);val library=art(200f).toMutableMap();val a=library.getValue(actorFrame)
            library[actorFrame]=a.copy(clips=a.clips.mapValues { (name,c)->if(name=="attack")c.copy(cellHeight=100f) else c })
            return CombatVisualPlan(s,BattleVisualModel(s.revision.events,5),library,hitPolicy=policy).hitFeedback!!.cues.single().y
        }
        assertEquals(23-200*policy.actorHeightFactor,anchor(listOf(deploy,hit(),attack)),.001f)
        assertEquals(23-100*policy.actorHeightFactor,anchor(listOf(deploy,attack,hit())),.001f)
    }
    @Test fun `equal-time accepted hero bodies use the last source command for the hit anchor`() {
        val frame=catalogue.get("actors").first { it.getString("type")=="theodor" }.getString("frameKey")
        val commands=reference.get("bodyOrdering").toList()
        val events=listOf(deploy.replace("highlander","theodor"))+commands.map { command->
            """{"e":"heroSkill","t":10,"id":1,"hero":"theodor","skill":"${command.getString("skill")}","phase":"impact","x":17,"y":23}"""
        }+hit()
        val s=scene(events).copy(actorFrames=mapOf("theodor" to frame));val a=actual.getValue(frame)
        val lastFrame=commands.last().get("frames").first().asString()
        // Distinct synthetic geometry exposes ordering even though today's hero cells have equal heights.
        val library=actual+(frame to a.copy(clips=a.clips.mapValues { (_,clip)->
            clip.copy(cellHeight=if(lastFrame in clip.frames.flatten())300f else 100f,scale=1f)
        }))
        val p=CombatVisualPlan(s,BattleVisualModel(s.revision.events,5),library,hitPolicy=policy)
        assertEquals(lastFrame,p.actor(1,10f)!!.frameKey)
        assertEquals(23-300*policy.actorHeightFactor,p.hitFeedback!!.cues.single().y,.001f,
            "Source playHeroBody replaces equal-priority commands synchronously before onHit")
    }
    @Test fun `actual admitted burrow bodies retain exact moving anchors while the generic model is hidden`() {
        for(unit in listOf("tunneler","bilgewraith")) {
            val frame=catalogue.get("actors").first { it.getString("type")==unit }.getString("frameKey")
            val a=actual.getValue(frame);val motion=assertNotNull(a.burrowMotion)
            val tunnelTick=2+kotlin.math.ceil(a.clips.getValue(motion.enterState).durationMs/100).toInt()+1
            val events=listOf(deploy.replace("highlander",unit),"""{"e":"burrow","t":2,"id":1}""",hit(2),
                hit(tunnelTick),"""{"e":"pos","t":${tunnelTick+5},"id":1,"x":200,"y":90}""")
            for(start in listOf(BattlePresentationStart.Continuous,BattlePresentationStart.ColdPrefix(tunnelTick.toFloat()))) {
                val s=scene(events,start).copy(actorFrames=mapOf(unit to frame))
                val model=BattleVisualModel(s.revision.events,5)
                val p=CombatVisualPlan(s,model,actual,hitPolicy=policy)
                for(cue in p.hitFeedback!!.cues) {
                    assertFalse(model.pose(1,cue.tick.toFloat())!!.visible)
                    val body=assertNotNull(p.actor(1,cue.tick.toFloat()))
                    assertEquals(body.x,cue.x,.001f,unit)
                    assertEquals(body.y-body.clip.cellHeight*body.clip.scale*policy.actorHeightFactor,cue.y,.001f,unit)
                }
                assertEquals(a.clips.getValue(motion.tunnelState).key,p.actor(1,tunnelTick.toFloat())!!.clip.key)
            }
        }
    }
    @Test fun `new hit policy refuses missing live body geometry instead of guessing a stand height`() {
        val s=scene(listOf(deploy,hit()));val a=actual.getValue(actorFrame)
        val library=actual+(actorFrame to a.copy(clips=emptyMap()))
        assertFailsWith<IllegalArgumentException> {
            CombatVisualPlan(s,BattleVisualModel(s.revision.events,5),library,hitPolicy=policy)
        }
        assertNull(CombatVisualPlan(s,BattleVisualModel(s.revision.events,5),library).hitFeedback)
    }
    @Test fun `building destruction and trap suppress only following hits and never remove emitted stars`() {
        for(e in listOf("destroyed","trap")) {
            val end="""{"e":"$e","t":10,"id":"base","kind":"spike"}"""
            assertTrue(stars(plan(listOf(end,hit(target="\"base\""))),10f).isEmpty())
            assertEquals(1,stars(plan(listOf(hit(target="\"base\""),end)),10f).size)
        }
    }
    @Test fun `star uses exact source frame transition expiry and finite tail`() {
        val p=plan(listOf(deploy,hit()));val feedback=p.hitFeedback!!
        val change=policy.starFrameTimes[1]/100
        assertEquals(policy.star.frames[0][0],stars(p,10f).single().frameKey)
        assertEquals(policy.star.frames[0][1],stars(p,10+change).single().frameKey)
        assertTrue(stars(p,10+policy.starMs/100).isEmpty())
        assertTrue(p.playbackExtent.visualEndTick>=feedback.endTick)
        assertTrue(feedback.flashing(HitTarget.Actor(1),10f,0f))
        assertFalse(feedback.flashing(HitTarget.Actor(1),10+policy.flashMs/100,0f))
    }
    @Test fun `earlier clear timer may end a newer overlap instead of extending the white fill`() {
        val p=HitFeedbackPlan(policy,listOf(HitFeedbackCue(HitTarget.Actor(1),0,0,0f,0f),HitFeedbackCue(HitTarget.Actor(1),1,1,0f,0f)),policy.flashMs/2)
        assertTrue(p.flashing(HitTarget.Actor(1),1f,0f))
        assertFalse(p.flashing(HitTarget.Actor(1),2f,0f))
        assertTrue(p.flashing(HitTarget.Actor(1),2f,1f),"A cold prefix does not recreate the old clear timer")
    }
    @Test fun `fractional cold prefix drops old effects while exact boundary is a new event`() {
        val p=plan(listOf(deploy,hit(8),hit(9)),start=BattlePresentationStart.ColdPrefix(8.5f))
        assertEquals(listOf(9),p.hitFeedback!!.cues.map { it.tick })
        assertEquals(1,stars(p,9f,9f).size)
        assertTrue(stars(p,9f,9.1f).isEmpty())
    }
    @Test fun `seek and suffix replacement do not restore old sparks and positions never follow later movement`() {
        val move="""{"e":"pos","t":15,"id":1,"x":100,"y":200}"""
        val p=plan(listOf(deploy,hit(),move));val cue=p.hitFeedback!!.cues.single()
        assertEquals(cue.x,stars(p,11f).single().x);assertEquals(cue.y,stars(p,11f).single().y)
        assertTrue(stars(p,11f,11f).isEmpty())
        assertTrue(stars(plan(listOf(deploy,move)),11f).isEmpty())
    }
    @Test fun `missing policy preserves historical renderer without generating a replacement visual`() {
        val p=plan(listOf(deploy,hit()),p=null);assertNull(p.hitFeedback)
        assertTrue(p.actor(1,10f,1f,0f)!!.hit)
    }
    @Test fun `actual admitted atlas contains the canonical spark frames and full dimensions`() {
        val atlas=reader.parse(pack.resolve(policy.star.atlasPath).readText())
        val frames=atlas.get("textures").flatMap { it.get("frames").toList() }
        for(frame in policy.star.frames.single()) {
            val actual=frames.single { it.getString("filename")==frame }
            assertEquals(policy.star.cellWidth,actual.get("sourceSize").getFloat("w"),0f)
            assertEquals(policy.star.cellHeight,actual.get("sourceSize").getFloat("h"),0f)
        }
    }
    @Test fun `repeated building targets preserve the earliest terminal ordinal without replaying its history per hit`() {
        val count=2048
        val events=List(count) { hit(10,target="\"base\"") }+
            listOf("""{"e":"destroyed","t":10,"id":"base"}""")+List(count) { hit(10,target="\"base\"") }+
            listOf("""{"e":"destroyed","t":10,"id":"base"}""")
        val cues=plan(events).hitFeedback!!.cues
        assertEquals(count,cues.size);assertEquals(count-1,cues.last().ordinal)
    }
    @Test fun `new malformed fill contract refuses unsupported rendering before any draw`() {
        assertFailsWith<IllegalArgumentException> { HitFeedbackPolicy.parse(reader.parse("""{"version":2}""")) }
        val v=reader.parse(reference.get("policy").toJson(com.badlogic.gdx.utils.JsonWriter.OutputType.json))
        v.get("flash").get("mode").set("multiply")
        assertFailsWith<IllegalArgumentException> { HitFeedbackPolicy.parse(v) }
    }
}
