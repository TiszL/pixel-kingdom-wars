package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.test.*
import org.junit.Test

/** Synthetic clocks make lifecycle intent visible; production clocks and art remain generated. */
class BurrowMotionTest {
    private val rows=listOf("s","sw","w","nw","n","ne","e","se")
    private fun clip(key:String,count:Int=4,loop:Boolean=false)=AuthoredClip(key,"atlas/$key.json",
        rows.map { row->List(count){"$key-$row-${it+1}"} },rows,10f,.5f,.5f,1f,20f,20f,loop,null,emptyMap())
    private val art=CombatArt(mapOf("burrow" to clip("burrow").copy(fxCues=mapOf("soil" to listOf(3)),effectByCue=mapOf("soil" to "soil")),
        "surface" to clip("surface").copy(fxCues=mapOf("soil" to listOf(2)),effectByCue=mapOf("soil" to "soil")),
        "tunnel" to clip("tunnel",3,true),"idle" to clip("idle",3,true),"walk" to clip("walk",4,true),
        "attack" to clip("attack"),"hit" to clip("hit"),"death" to clip("death",3)),
        JsonReader().parse("""{"burrow":{"enter":"burrow","tunnel":"tunnel","surface":"surface"},"stand":"idle","move":"walk","death":"death","hit":"hit","melee":{"troop":"attack","building":"attack"}}"""),
        emptyMap(),mapOf("soil" to clip("soil",5)),100f,100f,
        burrowMotion=BurrowMotionArt("burrow","tunnel","surface",1f,HowlAimArt(.25f,32.5f),-1f))
    private val birth="""{"e":"deploy","t":0,"id":1,"troop":"tunneler","x":0,"y":0}"""
    private fun event(type:String,t:Int,extra:String="")="""{"e":"$type","t":$t,"id":1$extra}"""
    private fun pos(t:Int,x:Int,y:Int=0)=event("pos",t,",\"x\":$x,\"y\":$y")
    private fun plan(vararg records:String,start:BattlePresentationStart=BattlePresentationStart.Continuous,custom:CombatArt=art,buildings:List<RenderBuilding> = emptyList()):CombatVisualPlan {
        val events=(listOf(birth)+records).map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(buildings,10,10,256f),PresentationRevision("raid","revision",14,0,0,events),
            mapOf("tunneler" to "actor"),256f,100f,10,10,presentationStart=start)
        return CombatVisualPlan(scene,BattleVisualModel(events,10),mapOf("actor" to custom))
    }
    private fun soil(p:CombatVisualPlan,t:Float)=mutableListOf<CombatSprite>().also { p.transientSprites(t,it) }.filter { it.clip.key=="soil" }
    @Test fun `rich burrow remains visible through entry and looping tunnel`() {
        val p=plan(event("burrow",2))
        assertEquals("burrow-s-1",p.actor(1,2f)?.frameKey)
        assertEquals("burrow-s-4",p.actor(1,5.9f)?.frameKey)
        assertEquals("tunnel-s-1",p.actor(1,6f)?.frameKey)
        assertEquals("tunnel-s-1",p.actor(1,9f)?.frameKey)
        assertEquals(1,soil(p,4f).size);assertEquals(0,soil(p,9f).size)
        assertEquals(9f,p.playbackExtent.visualEndTick,"Stable tunnel is visible but does not run the terminal clock forever")
    }
    @Test fun `movement continues under entry and soil freezes the release pose`() {
        val p=plan(event("burrow",2),pos(10,1000,100))
        assertEquals(400f,p.actor(1,4f)?.x);assertEquals("burrow-e-3",p.actor(1,4f)?.frameKey)
        val first=soil(p,4f).single();assertEquals(400f,first.x);assertEquals(40f,first.y);assertEquals(39f,first.depth)
        assertEquals(first.x,soil(p,7f).single().x)
        assertEquals(1000f,p.actor(1,12f)?.x);assertTrue(p.actor(1,12f)!!.frameKey.startsWith("tunnel-e-"))
    }
    @Test fun `coordinate emerge kills transform but retains walking flag after surface`() {
        val p=plan(event("burrow",2),event("emerge",5,",\"x\":500,\"y\":50"),pos(10,1000,100))
        assertEquals(500f,p.actor(1,5f)?.x);assertEquals(500f,p.actor(1,11f)?.x)
        assertTrue(p.actor(1,9f)!!.frameKey.startsWith("walk-e-"),"Source keeps moving true although coordinate emerge killed its tween")
        assertEquals(500f,soil(p,6f).last().x)
    }
    @Test fun `legacy emerge leaves the existing transform alive`() {
        val p=plan(event("burrow",2),event("emerge",5),pos(10,1000,100))
        assertEquals(700f,p.actor(1,7f)?.x);assertEquals(1000f,p.actor(1,11f)?.x)
        assertTrue(p.actor(1,11f)!!.frameKey.startsWith("idle-e-"))
    }
    @Test fun `identical entry and surface registration do not restart phase or duplicate soil`() {
        val p=plan(event("burrow",2),event("burrow",3),event("emerge",8),event("emerge",9))
        assertEquals("burrow-s-3",p.actor(1,4f)?.frameKey);assertEquals(1,soil(p,5f).size)
        assertEquals("tunnel-s-1",p.actor(1,6f)?.frameKey)
        assertEquals("surface-s-2",p.actor(1,9f)?.frameKey);assertEquals(1,soil(p,10f).size)
        assertEquals("idle-s-1",p.actor(1,12f)?.frameKey)
    }
    @Test fun `death cancels unreleased keys but leaves released soil to expire independently`() {
        val early=plan(event("burrow",2),event("troopDeath",4))
        assertTrue(soil(early,4f).isEmpty(),"Clock death at the keyed instant precedes ticker callback")
        val late=plan(event("burrow",2),event("troopDeath",5))
        assertEquals(1,soil(late,8f).size);assertTrue(soil(late,9f).isEmpty())
        assertNull(late.actor(1,10f));assertTrue(soil(late,late.playbackExtent.visualEndTick).isEmpty())
    }
    @Test fun `melee restarts its own body and permanently cancels the pending entry callback`() {
        val attack=event("troopAttack",3,",\"ix\":100,\"iy\":0,\"targetKind\":\"troop\"")
        val p=plan(event("burrow",2),attack)
        assertTrue(p.actor(1,4f)!!.frameKey.startsWith("attack-e-"));assertTrue(soil(p,5f).isEmpty())
        assertTrue(p.actor(1,8f)!!.frameKey.startsWith("idle-e-"),"Cancelled entry must never resurrect tunnel")
    }
    @Test fun `same tick emerge and delivered endpoint preserve original source order`() {
        val emerge=event("emerge",10,",\"x\":500,\"y\":50")
        val before=plan(event("burrow",2),pos(10,100),pos(10,900),emerge)
        val after=plan(event("burrow",2),pos(10,100),emerge,pos(10,900))
        assertEquals(500f,before.actor(1,10f)?.x,"Later emerge wins over the delivered zero-duration endpoint")
        assertEquals(900f,after.actor(1,10f)?.x,"Later delivered endpoint wins over emerge snap")
    }
    @Test fun `fractional cold prefix materializes tunnel without historical entry or soil`() {
        val records=arrayOf(event("burrow",5),pos(10,1000))
        val continuous=plan(*records);val cold=plan(*records,start=BattlePresentationStart.ColdPrefix(5.5f))
        assertTrue(continuous.actor(1,5.5f)!!.frameKey.startsWith("burrow-"))
        assertEquals("tunnel-s-1",cold.actor(1,5.5f)?.frameKey)
        assertTrue(soil(cold,7f).isEmpty());assertEquals(1,soil(continuous,7f).size)
        assertEquals(1000f,cold.actor(1,10f)?.x)
    }
    @Test fun `cold emerge uses stable rest while continuous reconstruction retains surface`() {
        val records=arrayOf(event("burrow",2),event("emerge",5,",\"x\":500,\"y\":50"))
        val cold=plan(*records,start=BattlePresentationStart.ColdPrefix(5.5f))
        assertEquals("idle-s-1",cold.actor(1,5.5f)?.frameKey);assertEquals(500f,cold.actor(1,5.5f)?.x)
        assertTrue(soil(cold,6f).isEmpty())
        assertTrue(plan(*records).actor(1,5.5f)!!.frameKey.startsWith("surface-"))
    }
    @Test fun `seeking and a replacement revision never preserve obsolete future soil`() {
        val p=plan(event("burrow",2),event("emerge",8))
        val body=p.actor(1,4.5f);val particles=soil(p,4.5f);p.actor(1,15f);soil(p,15f)
        assertEquals(body,p.actor(1,4.5f));assertEquals(particles,soil(p,4.5f))
        assertTrue(soil(plan(),4.5f).isEmpty());assertTrue(plan().actor(1,4.5f)!!.frameKey.startsWith("idle-"))
    }
    @Test fun `cold prefix preserves later cycles of a compact attack run`() {
        val run=event("attackRun",2,",\"technique\":\"strike\",\"count\":3,\"cadenceTicks\":4,\"ix\":100,\"iy\":0,\"targetKind\":\"troop\"")
        val p=plan(run,event("rally",10),start=BattlePresentationStart.ColdPrefix(5.5f))
        assertEquals("attack-e-1",p.actor(1,6f)?.frameKey)
        assertEquals("attack-e-1",p.actor(1,10f)?.frameKey,"Each surviving canonical run cycle deliberately restarts attack")
    }
    @Test fun `canonical hit target dispatches idle flinch but never interrupts entry`() {
        val hit="""{"e":"hit","t":3,"target":1,"dmg":1}"""
        assertTrue(plan(hit).actor(1,3f)!!.frameKey.startsWith("hit-"))
        assertTrue(plan(event("burrow",2),hit).actor(1,3f)!!.frameKey.startsWith("burrow-"))
    }
    @Test fun `same registration at the completion instant completes instead of restarting surface`() {
        val p=plan(event("emerge",5),event("emerge",9))
        assertEquals("idle-s-1",p.actor(1,9f)?.frameKey,"Clock re-registration sees the existing ticker before its completion update")
        assertTrue(soil(p,11f).isEmpty(),"Identical boundary registration cannot emit a second surface soil")
    }
    @Test fun `idle retargets after destruction while preserving the existing loop phase`() {
        val structures=listOf(RenderBuilding("east","structure",0f,-.5f,1f,.5f),RenderBuilding("south","structure",-.5f,1f,1f,1f))
        val p=plan("""{"e":"destroyed","t":2,"id":"east"}""",buildings=structures)
        assertEquals("idle-e-1",p.actor(1,0f)?.frameKey)
        assertEquals("idle-s-3",p.actor(1,2f)?.frameKey,"Changing the row must not restart the idle clip")
    }
    @Test fun `same tick body commands run before idle retarget after a destruction`() {
        val structures=listOf(RenderBuilding("east","structure",0f,-.5f,1f,.5f),RenderBuilding("south","structure",-.5f,1f,1f,1f))
        val destroyed="""{"e":"destroyed","t":2,"id":"east"}"""
        val hit="""{"e":"hit","t":2,"target":1,"dmg":1}"""
        for((command,body) in listOf(event("burrow",2) to "burrow",hit to "hit")) {
            val p=plan(destroyed,command,buildings=structures)
            assertEquals("$body-e-1",p.actor(1,2f)?.frameKey,"The body command preserves heading before the idle update can run")
        }
        val immediate=plan(event("burrow",0),buildings=structures)
        assertEquals("burrow-s-1",immediate.actor(1,0f)?.frameKey,"A same-tick spawn then burrow has no intervening idle frame")
    }

}
