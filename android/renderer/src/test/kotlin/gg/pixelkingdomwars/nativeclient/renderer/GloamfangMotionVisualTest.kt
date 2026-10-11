package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.test.*
import org.junit.Test

/** Synthetic geometry with canonical authored clocks; not a screenshot or outcome fixture. */
class GloamfangMotionVisualTest {
    private val reader=JsonReader()
    private val rows=listOf("e","se","s","sw","w","nw","n","ne")
    private fun clip(key:String,count:Int,fps:Float,loop:Boolean=false)=AuthoredClip(key,"atlas/$key.json",
        rows.map { row->List(count){"$key-$row-${it+1}"} },rows,fps,.5f,.5f,1f,20f,20f,loop,null,emptyMap())
    private val leap=clip("leap",8,13f).copy(fxCues=mapOf("dust" to listOf(2,8)),effectByCue=mapOf("dust" to "dust"))
    private val fist=reader.parse("""{"fist":${List(8){List(6){listOf(10,10)}}}}""")
    private val lunge=clip("lunge",6,13f).copy(emitters=fist,fxCues=mapOf("rend" to listOf(2,4)),effectByCue=mapOf("rend" to "rend"))
    private val aim=HowlAimArt(.25f,32.5f)
    private val art=CombatArt(mapOf("leap" to leap,"lunge" to lunge,"prowl" to clip("prowl",8,13f,true),
        "death" to clip("death",4,10f),"howl" to clip("howl",8,10f)),reader.parse("""{"stand":"prowl","move":"prowl","death":"death"}"""),
        emptyMap(),mapOf("dust" to clip("dust",4,14f),"rend" to clip("rend",4,18f)),0f,0f,
        fxEmitters=mapOf("rend" to "fist"),fxFacingRotationDeg=rows.associateWith { 0f },
        howl=HowlArt("howl",2,0f,0f,-1f,clip("ring",4,10f),aim),
        leap=LeapMotionArt("leap",600f,.3f,aim,1f),lunge=LungeMotionArt("lunge",aim))
    private val deploy="""{"e":"deploy","t":0,"id":1,"troop":"gloamfang","x":0,"y":0}"""
    private fun cast(kind:String="leap",tick:Int=10,x:Int=0,y:Int=0,ix:Int=x+200,iy:Int=y) =
        """{"e":"troopAbility","t":$tick,"id":1,"ability":"$kind","x":$x,"y":$y,"ix":$ix,"iy":$iy}"""
    private fun plan(vararg events:String,buildings:List<RenderBuilding> = emptyList()):CombatVisualPlan {
        val parsed=(listOf(deploy)+events).map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(buildings,10,10,256f),PresentationRevision("raid","revision",14,0,0,parsed),
            mapOf("gloamfang" to "actor"),256f,100f,5,5)
        return CombatVisualPlan(scene,BattleVisualModel(parsed,5),mapOf("actor" to art))
    }
    private fun effects(plan:CombatVisualPlan,tick:Float,key:String):List<CombatSprite> {
        val out=mutableListOf<CombatSprite>();plan.transientSprites(tick,out);return out.filter { it.clip.key==key }
    }
    @Test fun `Leap separates the arc sprite from ground depth and travel completion from body completion`() {
        val p=plan(cast());val middle=assertNotNull(p.actor(1,13f))
        assertEquals(100f,middle.x,.001f);assertEquals(-60f,middle.y,.001f)
        assertEquals(0f,middle.depth,.001f,"Depth follows ground height instead of the elevated body")
        val landed=assertNotNull(p.actor(1,16f));assertEquals(200f,landed.x,.001f);assertEquals(0f,landed.y,.001f)
        assertTrue(landed.frameKey.startsWith("leap-"),"600ms travel finishes before the eight-frame13FPS body")
        assertTrue(assertNotNull(p.actor(1,17f)).frameKey.startsWith("prowl-"))
        assertTrue(p.playbackExtent.visualEndTick>16f,"The remaining body and dust finish on their own authored clocks")
    }
    @Test fun `late Leap dust samples the visible arc and ground depth at its authored release then stays fixed`() {
        val p=plan(cast());val release=10f+7f*1000f/13f/100f
        val dust=effects(p,release+.001f,"dust").single()
        val fraction=(release-10f)/6f
        assertEquals(200f*fraction,dust.x,.01f)
        assertEquals(-200f*.3f*4f*fraction*(1f-fraction),dust.y,.01f)
        assertEquals(-1f,dust.depth,.01f,"Dust depth is source actor ground-depth minus one")
        val later=effects(p,release+1f,"dust").single()
        assertEquals(dust.x,later.x);assertEquals(dust.y,later.y)
        assertTrue(effects(p,release+3f,"dust").isEmpty())
    }
    @Test fun `Lunge uses the delivered position at tick ten instead of inventing its tick fifteen landing timer`() {
        val p=plan(cast("lunge"),"""{"e":"pos","t":15,"id":1,"x":300,"y":40}""")
        val landed=assertNotNull(p.actor(1,10f))
        assertEquals(300f,landed.x);assertEquals(40f,landed.y)
        assertTrue(landed.frameKey.startsWith("prowl-"),"Same-tick cast then delivered position immediately restores stand")
        assertTrue(effects(p,11f,"rend").isEmpty());assertTrue(effects(p,13f,"rend").isEmpty())
        val noPosition=plan(cast("lunge"))
        assertEquals(0f,assertNotNull(noPosition.actor(1,13f)).x,"The aimed target alone never moves Lunge")
        assertEquals(2,effects(noPosition,12.5f,"rend").size,"Without delivered landing, both authored rend releases survive")
    }
    @Test fun `death and a replacement ability cancel future rend but leave an already released contact to expire`() {
        for(interruption in listOf("""{"e":"troopDeath","t":12,"id":1}""",cast("lunge",12,500))) {
            val p=plan(cast("lunge"),interruption)
            val old=effects(p,12.5f,"rend").filter { it.x<100f }
            assertEquals(1,old.size,"Only the first contact was emitted before interruption")
            assertTrue(effects(p,13.1f,"rend").none { it.x<100f },"The cancelled second key must not resurrect the old action")
        }
    }
    @Test fun `death stops the arc at its intervention pose and rewinding reconstructs the same prior presentation`() {
        val p=plan(cast(),"""{"e":"troopDeath","t":13,"id":1}""")
        val dying=assertNotNull(p.actor(1,13.5f))
        assertEquals(100f,dying.x,.001f);assertEquals(-60f,dying.y,.001f)
        assertTrue(effects(p,16f,"dust").isEmpty(),"Death prevents the not-yet-emitted second dust key")
        val before=assertNotNull(p.actor(1,12f));p.actor(1,17f)
        assertEquals(before,p.actor(1,12f),"Sampling a later time cannot mutate the reconstructed earlier arc")
        assertNotEquals(before.x,assertNotNull(plan().actor(1,12f)).x,"A replacement revision without Leap cannot retain its transform")
    }
    @Test fun `Leap stand turns toward nearest surviving building bottom center while moving keeps its heading`() {
        val structures=listOf(RenderBuilding("gone","structure",1.53125f,0f,1f,1f),
            RenderBuilding("live","structure",1.28125f,1f,1f,1f))
        val leap=cast(x=256,y=256)
        assertTrue(assertNotNull(plan(leap,buildings=structures).actor(1,17f)).frameKey.startsWith("prowl-e-"))
        val destroyed="""{"e":"destroyed","t":12,"id":"gone"}"""
        assertTrue(assertNotNull(plan(leap,destroyed,buildings=structures).actor(1,17f)).frameKey.startsWith("prowl-s-"),
            "The destroyed nearest building cannot attract the idle heading; the surviving bottom-center lies south")
        val moving="""{"e":"pos","t":20,"id":1,"x":1000,"y":256}"""
        assertTrue(assertNotNull(plan(leap,destroyed,moving,buildings=structures).actor(1,17f)).frameKey.startsWith("prowl-e-"),
            "Completing the body during delivered movement must not turn toward an idle target")
    }
    @Test fun `chain snapshots respect same-tick source order instead of a later Leap or actor birth`() {
        val towerArt=CombatArt(mapOf("idle" to clip("tower",1,10f,true)),reader.parse("""{"stand":"idle"}"""),
            emptyMap(),emptyMap(),0f,0f,chain=ChainArt(StrokeProfile(600f,10f,listOf(StrokeLayer(2f,0xffffff,1f))),
                .5f,-10f,clip("chain-impact",4,10f)))
        fun chained(vararg events:String):CombatVisualPlan {
            val parsed=events.map(PresentationEvent::fromJson)
            val base=BaseScene(listOf(RenderBuilding("tower","tower-art",1f,1f,1f,1f)),10,10,256f)
            val scene=BattleScene(base,PresentationRevision("raid","revision",14,0,0,parsed),
                mapOf("gloamfang" to "actor"),256f,100f,5,5)
            return CombatVisualPlan(scene,BattleVisualModel(parsed,5),mapOf("actor" to art,"tower-art" to towerArt))
        }
        val chain="""{"e":"chain","t":10,"id":"tower","targets":[1],"dmg":[0]}"""
        val leap=cast(x=500,y=200)
        val out=mutableListOf<CombatStroke>()
        val before=chained(deploy,chain,leap);before.transientStrokes(10f,out)
        assertEquals(0f,out.single().toX);assertEquals(-10f,out.single().toY,
            "A later cast at the same tick cannot retroactively move the chain endpoint")
        val after=chained(deploy,leap,chain);after.transientStrokes(10f,out)
        assertEquals(500f,out.single().toX);assertEquals(190f,out.single().toY)
        val frozen=out.single();after.transientStrokes(12f,out)
        assertEquals(frozen.toX,out.single().toX);assertEquals(frozen.toY,out.single().toY,
            "The already emitted hop remains at the captured sprite position while Leap moves")
        after.transientStrokes(10f,out);assertEquals(frozen,out.single())
        val laterBirth=deploy.replace("\"t\":0","\"t\":10")
        chained(chain,laterBirth).transientStrokes(10f,out)
        assertTrue(out.isEmpty(),"A future same-tick birth must not be resurrected by the legacy position fallback")
    }
}
