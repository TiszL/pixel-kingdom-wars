package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class GloamfangHitFeedbackTest {
    private fun clip(state:String)=AuthoredClip(state,"atlas/body.json",List(8) { r -> List(4) { "$state-$r-$it" } },
        listOf("s","sw","w","nw","n","ne","e","se"),10f,.5f,1f,1f,32f,32f,false,null,emptyMap())
    private val art=CombatArt(listOf("prowl","spawn","rend","howl","leap","lunge","hit","death").associateWith(::clip),
        JsonReader().parse("""{"stand":"prowl","move":"prowl","hit":"hit","death":"death","melee":{"troop":"rend","building":"rend"}}"""),
        emptyMap(),emptyMap(),0f,0f,leap=LeapMotionArt("leap",600f,.3f,HowlAimArt(.25f,32.5f),1f))
    private val deploy="""{"t":0,"e":"deploy","id":1,"troop":"gloamfang","x":0,"y":0}"""
    private fun hit(t:Int,target:Int=1)="""{"t":$t,"e":"hit","target":$target,"dmg":1}"""
    private fun attack(t:Int)="""{"t":$t,"e":"troopAttack","id":1,"targetKind":"building","ix":256,"iy":0}"""
    private fun ability(name:String,t:Int)="""{"t":$t,"e":"troopAbility","id":1,"ability":"$name","x":0,"y":0,"ix":256,"iy":0}"""
    private fun plan(events:List<String>,positions:Map<Int,PositionDelivery>?=null,from:Float=0f,spawn:Boolean=false,indexed:Boolean=false):GloamfangMotionTimeline {
        val parsed=events.map(PresentationEvent::fromJson)
        val body=if(spawn)art.copy(profile=JsonReader().parse(art.profile.toString()).also { it.addChild("spawn",com.badlogic.gdx.utils.JsonValue("spawn")) }) else art
        return GloamfangMotionTimeline(parsed,1,positions ?: PositionDelivery.compile(parsed,10,10,100f),body,100f,1f,
            actorEvents=if(indexed)parsed.mapIndexed { i,e -> i to JsonReader().parse(e.json) } else null,hitFromTick=from)
    }
    private fun state(p:GloamfangMotionTimeline,t:Float,name:String)=assertEquals(name,p.sample(t)!!.clipState)

    @Test fun `current idle flinch keeps its authored phase through repeated hits and random access`() {
        val p=plan(listOf(deploy,hit(5),hit(6)))
        state(p,4.99f,"prowl");state(p,5f,"hit");state(p,8.99f,"hit");state(p,9f,"prowl")
        assertEquals(500f,p.sample(8f)!!.phaseStartMs)
        assertEquals(listOf(500f),p.bodyActions.filter { it.state=="hit" }.map { it.startMs })
        assertEquals("prowl",p.sample(5f,beforeEventOrdinal=1)!!.clipState)
        assertEquals(plan(listOf(deploy,hit(5))).sample(6f),p.sample(6f),"A repeated hit cannot change the earlier owned body")
        state(plan(listOf(deploy)),6f,"prowl")
    }

    @Test fun `delivered movement blocks hits while a same time later writer preserves the current flinch`() {
        val moving="""{"t":15,"e":"pos","id":1,"x":100,"y":0}"""
        val before=plan(listOf(deploy,hit(6),moving))
        state(before,6f,"prowl");assertTrue(before.sample(6f)!!.moving)
        val after=plan(listOf(deploy,hit(5),moving))
        state(after,5f,"hit");state(after,8.99f,"hit");state(after,9f,"prowl")
        assertTrue(after.sample(9f)!!.moving)
        assertEquals(900f,after.sample(9f)!!.phaseStartMs)
        assertEquals("hit",after.sample(5f,beforeEventOrdinal=2)!!.clipState)
    }

    @Test fun `spawn rend and specialized abilities keep body ownership against damage`() {
        state(plan(listOf(deploy,hit(1)),spawn=true),1f,"spawn")
        state(plan(listOf(deploy,attack(5),hit(6))),6f,"rend")
        for(name in listOf("howl","leap","lunge")) {
            val p=plan(listOf(deploy,ability(name,5),hit(6)))
            state(p,6f,name)
            assertTrue(p.bodyActions.none { it.state=="hit" })
        }
    }

    @Test fun `later melee wins regardless of equal tick hit ordering without replaying old hit body`() {
        for(events in listOf(listOf(deploy,hit(5),attack(5)),listOf(deploy,attack(5),hit(5))))state(plan(events),5f,"rend")
        val p=plan(listOf(deploy,hit(5),attack(6)))
        state(p,5.5f,"hit");state(p,6f,"rend")
        assertEquals(600f,p.bodyActions.single { it.state=="hit" }.endMs)
    }

    @Test fun `a hit on the completion tick observes the still owned body before its callback`() {
        val p=plan(listOf(deploy,attack(5),hit(9),hit(10)))
        state(p,9f,"prowl");state(p,10f,"hit")
        assertEquals(listOf(1000f),p.bodyActions.filter { it.state=="hit" }.map { it.startMs })
    }

    @Test fun `death is terminal and cold historical hits cannot replace the resumed resting body`() {
        val dead=plan(listOf(deploy,hit(5),"""{"t":6,"e":"troopDeath","id":1}""",hit(7)))
        state(dead,7f,"death");assertFalse(dead.sample(7f)!!.alive)
        val cold=plan(listOf(deploy,hit(5),hit(7)),from=6f)
        state(cold,6f,"prowl");state(cold,7f,"hit")
        assertEquals(listOf(700f),cold.bodyActions.filter { it.state=="hit" }.map { it.startMs })
    }

    @Test fun `shared target indexed events admit current hits and ignore other actors`() {
        val events=listOf(deploy,hit(4,2),hit(5))
        val p=plan(events,indexed=true)
        state(p,4f,"prowl");state(p,5f,"hit")
        assertEquals(plan(events).bodyActions,p.bodyActions)
    }
}
