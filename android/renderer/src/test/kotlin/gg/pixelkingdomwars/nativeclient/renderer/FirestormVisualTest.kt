package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.math.*
import kotlin.test.*
import org.junit.Test

class FirestormVisualTest {
    private val reader=JsonReader()
    private val body=AuthoredClip("body","atlas/body.json",List(8){row->List(8){"body-$row-$it"}},
        listOf("e","se","s","sw","w","nw","n","ne"),10f,.5f,.5f,1f,20f,20f,false,
        reader.parse("""{"maw":[[[10,10],[20,10],[30,10],[40,10],[50,10],[60,10],[70,10],[80,10]]]}"""),emptyMap())
    private val fan=body.copy(key="fan",frames=listOf(List(8){"fan-${it+1}"}),rowOrder=listOf("s"),
        scale=.5f,anchorX=.1f,emitters=null)
    private val art=CombatArt(mapOf("firestorm" to body,"idle" to body),reader.parse("""{"stand":"idle","move":"idle"}"""),
        emptyMap(),emptyMap(),0f,0f,firestorm=FirestormArt("firestorm","maw",listOf(2,3,4),18f,1f,fan))
    private val deploy="""{"e":"deploy","t":0,"id":1,"troop":"direwyvern","x":0,"y":0}"""
    private val cast="""{"e":"troopAbility","t":1,"id":1,"ability":"firestorm","x":100,"y":100,"ix":500,"iy":100}"""
    private fun plan(events: List<String>,building: RenderBuilding?=null,buildingArt: CombatArt?=null):CombatVisualPlan {
        val parsed=events.map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(listOfNotNull(building),10,10,256f),PresentationRevision("raid","r",14,0,0,parsed),
            mapOf("direwyvern" to "actor"),256f,100f,5,5)
        return CombatVisualPlan(scene,BattleVisualModel(parsed,5),mapOf("actor" to art)+listOfNotNull(buildingArt?.let {"wall" to it}).toMap())
    }
    @Test fun `one fan starts at first authored release and repins only on keyed body frames`() {
        val p=plan(listOf(deploy,cast));val out=mutableListOf<CombatSprite>()
        assertTrue(p.missingCoverage.isEmpty());assertEquals(setOf("atlas/body.json"),p.requiredAtlases)
        p.transientSprites(1.99f,out);assertTrue(out.isEmpty())
        p.transientSprites(2f,out);val first=out.single();assertEquals("fan-1",first.frameKey)
        assertEquals(110f,first.x);assertEquals(100f,first.y);assertEquals(.5f,first.clip.scale)
        assertEquals(500f,first.x+18f*first.horizontalScale,.001f)
        p.transientSprites(2.9f,out);assertEquals(first,out.single())
        p.transientSprites(3f,out);assertEquals(120f,out.single().x);assertEquals("fan-2",out.single().frameKey)
        p.transientSprites(4f,out);val pinned=out.single();assertEquals(130f,pinned.x)
        p.transientSprites(8f,out);assertEquals(pinned.x,out.single().x)
        assertEquals(10f,p.playbackExtent.visualEndTick);p.transientSprites(10f,out);assertTrue(out.isEmpty())
        p.transientSprites(4f,out);assertEquals(pinned,out.single(),"Seeking reconstructs one ongoing fan, not a new emitter")
    }
    @Test fun `all target directions stretch along X without stretching thickness or mirroring art`() {
        val out=mutableListOf<CombatSprite>()
        for((dx,dy) in listOf(400 to 0,400 to 400,0 to 400,-400 to 400,-400 to 0,-400 to -400,0 to -400,400 to -400)) {
            val x=100+dx;val y=100+dy
            val p=plan(listOf(deploy,cast.replace("\"ix\":500","\"ix\":$x").replace("\"iy\":100","\"iy\":$y")))
            p.transientSprites(2f,out);val s=out.single();val radians=s.rotation*PI/180
            assertEquals(x.toFloat(),s.x+cos(radians).toFloat()*18f*s.horizontalScale,.001f)
            assertEquals(y.toFloat(),s.y+sin(radians).toFloat()*18f*s.horizontalScale,.001f)
            assertEquals(.5f,s.clip.scale);assertFalse(s.flipX)
        }
    }
    @Test fun `coincident maw and target collapses length without invalid transform or altered thickness`() {
        val p=plan(listOf(deploy,cast.replace("\"ix\":500","\"ix\":110")));val out=mutableListOf<CombatSprite>()
        p.transientSprites(2f,out);assertEquals(0f,out.single().horizontalScale)
        assertEquals(0f,out.single().rotation);assertEquals(.5f,out.single().clip.scale)
        p.transientSprites(3f,out);assertTrue(out.single().horizontalScale>0)
    }
    @Test fun `renderer eight requires fan metadata but preserves older compatibility`() {
        val json="""{"rendererContractVersion":8,"actors":[{"type":"direwyvern","frameKey":"actor"}]}"""
        assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(reader.parse(json))}
        assertTrue(CombatArt.catalogue(reader.parse(json.replace(":8",":7"))).isEmpty())
        assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(reader.parse(json.replace(":8",":11")))}
    }
    @Test fun `pins sample canonical movement but depth stays at fan creation and final attachment freezes`() {
        val p=plan(listOf(deploy,cast,"""{"e":"pos","t":6,"id":1,"x":200,"y":200}"""));val out=mutableListOf<CombatSprite>()
        p.transientSprites(2f,out);assertEquals(130f,out.single().x);assertEquals(121f,out.single().depth)
        p.transientSprites(4f,out);assertEquals(190f,out.single().x);assertEquals(121f,out.single().depth)
        p.transientSprites(8f,out);assertEquals(190f,out.single().x)
    }
    @Test fun `death and revision removal cannot leave an orphan fan or replay obsolete predictions`() {
        val out=mutableListOf<CombatSprite>();val p=plan(listOf(deploy,cast,"""{"e":"troopDeath","t":4,"id":1}"""))
        p.transientSprites(3f,out);assertEquals(1,out.size);p.transientSprites(4f,out);assertTrue(out.isEmpty())
        plan(listOf(deploy)).transientSprites(3f,out);assertTrue(out.isEmpty())
        plan(listOf(deploy,"""{"e":"troopDeath","t":1,"id":1}""",cast)).transientSprites(3f,out);assertTrue(out.isEmpty())
    }
    @Test fun `building centre is captured only if destruction precedes neither the cast nor its identity`() {
        val building=RenderBuilding("wall","wall",1f,1f,1f,1f)
        val targetArt=art.copy(firestorm=null,buildingTarget=5f to -80f)
        val named=cast.replace("\"ix\":500","\"targetBuildingId\":\"wall\",\"ix\":500")
        val destroyed="""{"e":"destroyed","t":1,"id":"wall"}""";val out=mutableListOf<CombatSprite>()
        fun endpoint(p:CombatVisualPlan):Pair<Float,Float>{p.transientSprites(2f,out);val s=out.single();val a=s.rotation*PI/180
            return s.x+cos(a).toFloat()*18f*s.horizontalScale to s.y+sin(a).toFloat()*18f*s.horizontalScale}
        val centered=endpoint(plan(listOf(deploy,named,destroyed),building,targetArt))
        assertEquals(389f,centered.first,.001f);assertEquals(432f,centered.second,.001f)
        val fallback=endpoint(plan(listOf(deploy,destroyed,named),building,targetArt))
        assertEquals(500f,fallback.first,.001f);assertEquals(100f,fallback.second,.001f)
        assertEquals(fallback,endpoint(plan(listOf(deploy,named))))
    }
}
