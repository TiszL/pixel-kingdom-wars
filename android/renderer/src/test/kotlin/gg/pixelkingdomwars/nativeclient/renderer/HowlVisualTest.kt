package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.test.*
import org.junit.Test

class HowlVisualTest {
    private val reader=JsonReader()
    private val body=AuthoredClip("body","atlas/body.json",List(8){r->List(8){"body-$r-$it"}},
        listOf("e","se","s","sw","w","nw","n","ne"),10f,.5f,.5f,1f,20f,20f,false,null,emptyMap())
    private val ring=body.copy(key="ring",atlasPath="atlas/ring.json",frames=listOf(List(4){"ring-$it"}),rowOrder=listOf("s"))
    private val art=CombatArt(mapOf("howl" to body,"idle" to body),reader.parse("""{"stand":"idle","move":"idle","melee":{"troop":"idle"}}"""),
        emptyMap(),emptyMap(),0f,0f,howl=HowlArt("howl",3,3f,-2f,-1f,ring,HowlAimArt(.25f,32.5f)))
    private val deploy="""{"e":"deploy","t":0,"id":1,"troop":"gloamfang","x":0,"y":0}"""
    private val cast="""{"e":"troopAbility","t":1,"id":1,"ability":"howl","x":100,"y":100}"""
    private fun plan(events:List<String>,tilePixels:Float=256f,customArt:CombatArt=art):CombatVisualPlan {
        val parsed=events.map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(emptyList(),10,10,tilePixels),PresentationRevision("raid","revision",14,0,0,parsed),
            mapOf("gloamfang" to "actor"),256f,100f,5,5)
        return CombatVisualPlan(scene,BattleVisualModel(parsed,5),mapOf("actor" to customArt))
    }
    @Test fun `one finite ring begins at the authored body key and seeking never refires it`() {
        val p=plan(listOf(deploy,cast));val out=mutableListOf<CombatSprite>()
        assertTrue(p.missingCoverage.isEmpty());assertEquals(setOf("atlas/body.json","atlas/ring.json"),p.requiredAtlases)
        assertEquals(100f,p.actor(1,1f)!!.x,"Ability cancels previous movement and snaps to canonical cast origin")
        p.transientSprites(Math.nextDown(3f),out);assertTrue(out.isEmpty())
        p.transientSprites(3f,out);assertEquals("ring-0",out.single().frameKey)
        assertEquals(103f,out.single().x);assertEquals(98f,out.single().y);assertEquals(99f,out.single().depth)
        p.transientSprites(6f,out);assertEquals("ring-3",out.single().frameKey)
        p.transientSprites(7f,out);assertTrue(out.isEmpty())
        assertEquals(1f,p.playbackExtent.eventEndTick);assertEquals(9f,p.playbackExtent.visualEndTick,"The body may outlive its ring")
        p.transientSprites(3f,out);assertEquals(1,out.size);assertEquals("ring-0",out.single().frameKey)
    }
    @Test fun `ring samples current position and depth at release then stays stationary`() {
        val p=plan(listOf(deploy,cast,"""{"e":"pos","t":6,"id":1,"x":200,"y":300}"""));val out=mutableListOf<CombatSprite>()
        p.transientSprites(3f,out);assertEquals(143f,out.single().x);assertEquals(178f,out.single().y);assertEquals(179f,out.single().depth)
        p.transientSprites(6f,out);assertEquals(143f,out.single().x);assertEquals(178f,out.single().y)
        assertEquals(200f,p.actor(1,6f)!!.x,"Later movement does not drag a released ring")
        assertEquals("body-2-5",p.actor(1,6f)!!.frameKey,"Moving during Howl does not rotate its active body")
    }
    @Test fun `death cancels pending and released rings with canonical same-tick ordering`() {
        val out=mutableListOf<CombatSprite>()
        for(death in listOf(2,3,4)) {
            val p=plan(listOf(deploy,cast,"""{"e":"troopDeath","t":$death,"id":1}"""))
            p.transientSprites(death.toFloat(),out);assertTrue(out.isEmpty())
            p.transientSprites(6f,out);assertTrue(out.isEmpty())
        }
        val dying=plan(listOf(deploy,cast,"""{"e":"troopDeath","t":4,"id":1}"""))
        dying.transientSprites(3f,out);assertEquals(1,out.size)
        plan(listOf(deploy,"""{"e":"troopDeath","t":1,"id":1}""",cast)).transientSprites(3f,out);assertTrue(out.isEmpty())
        plan(listOf(cast)).transientSprites(3f,out);assertTrue(out.isEmpty(),"Absent actors cannot create orphan ability effects")
    }
    @Test fun `replacing the body cancels pending release but leaves an already emitted ring alive`() {
        val out=mutableListOf<CombatSprite>()
        val attack="""{"e":"troopAttack","t":2,"id":1,"target":9,"ix":200,"iy":100}"""
        plan(listOf(deploy,cast,attack)).transientSprites(3f,out);assertTrue(out.isEmpty())
        val short=body.copy(frames=body.frames.map { it.take(1) },fps=20f)
        plan(listOf(deploy,cast,attack),customArt=art.copy(clips=art.clips+("idle" to short))).transientSprites(3f,out)
        assertTrue(out.isEmpty(),"A replacement that already ended still permanently cancels the old callback")
        plan(listOf(deploy,cast,attack.replace("\"t\":2","\"t\":3"))).transientSprites(3f,out);assertTrue(out.isEmpty())
        plan(listOf(deploy,cast,attack.replace("\"t\":2","\"t\":4"))).transientSprites(5f,out);assertEquals(1,out.size)
        val replaced=plan(listOf(deploy,cast,cast.replace("\"t\":1","\"t\":2").replace("\"x\":100","\"x\":500")))
        replaced.transientSprites(3f,out);assertTrue(out.isEmpty(),"A second Howl unregisters the first pending frame callback")
        replaced.transientSprites(4f,out);assertEquals(1,out.size);assertEquals(503f,out.single().x)
    }
    @Test fun `replacement discards obsolete ring and reconstructs only the new revision`() {
        val out=mutableListOf<CombatSprite>();plan(listOf(deploy,cast)).transientSprites(4f,out);assertEquals(1,out.size)
        plan(listOf(deploy)).transientSprites(4f,out);assertTrue(out.isEmpty())
        val moved=plan(listOf(deploy,cast.replace("\"x\":100","\"x\":500")))
        moved.transientSprites(4f,out);assertEquals(503f,out.single().x)
        moved.transientSprites(9f,out);assertTrue(out.isEmpty());moved.transientSprites(4f,out);assertEquals(503f,out.single().x)
    }
    @Test fun `run and legacy duplicates do not add melee or duplicate Howl effects`() {
        val run="""{"e":"attackRun","t":1,"id":1,"technique":"howl","count":1,"cadenceTicks":10}"""
        val legacy="""{"e":"troopAttack","t":1,"id":1,"target":9}"""
        val out=mutableListOf<CombatSprite>();val p=plan(listOf(deploy,run,legacy,cast));p.transientSprites(3f,out)
        assertEquals(1,out.size);assertTrue(p.missingCoverage.isEmpty())
    }
    @Test fun `targetless Howl keeps prior direction through body and stand but respects later movement and attacks`() {
        val prelude=listOf(deploy,"""{"e":"pos","t":2,"id":1,"x":-100,"y":0}""",cast.replace("\"t\":1","\"t\":3"))
        val p=plan(prelude);assertEquals("body-4-0",p.actor(1,3f)!!.frameKey)
        assertTrue(p.actor(1,12f)!!.frameKey.startsWith("body-4-"))
        val moved=prelude+"""{"e":"pos","t":15,"id":1,"x":500,"y":100}"""
        assertTrue(plan(moved).actor(1,16f)!!.frameKey.startsWith("body-0-"))
        val attacked=moved+"""{"e":"troopAttack","t":16,"id":1,"target":9,"ix":500,"iy":0}"""
        assertTrue(plan(attacked).actor(1,25f)!!.frameKey.startsWith("body-6-"))
        val priorAttack=listOf(deploy,"""{"e":"troopAttack","t":1,"id":1,"target":9,"ix":-100,"iy":0}""",
            cast.replace("\"t\":1","\"t\":12"))
        assertEquals("body-4-0",plan(priorAttack).actor(1,12f)!!.frameKey)
    }
    @Test fun `aim uses generated world-pixel deadzone and angular retention only at the Howl cast`() {
        val near=cast.dropLast(1)+",\"ix\":101,\"iy\":100}"
        assertEquals("body-2-0",plan(listOf(deploy,near),64f).actor(1,1f)!!.frameKey,"A quarter world pixel is inside the source squared deadzone")
        assertEquals("body-0-0",plan(listOf(deploy,near),256f).actor(1,1f)!!.frameKey)
        val eastPrelude=listOf(deploy,"""{"e":"pos","t":2,"id":1,"x":100,"y":0}""")
        val late=cast.replace("\"t\":1","\"t\":3").dropLast(1)
        assertEquals("body-0-0",plan(eastPrelude+(late+",\"ix\":200,\"iy\":160}")).actor(1,3f)!!.frameKey,"31 degrees retains east beyond nearest-octant boundary")
        assertEquals("body-1-0",plan(eastPrelude+(late+",\"ix\":200,\"iy\":170}")).actor(1,3f)!!.frameKey)
        val aim=art.howl!!.aim
        assertEquals("w",aim.facing(-100f,-60f,"w"),"Angular wrap must use the shortest distance")
        assertEquals("nw",aim.facing(-100f,-70f,"w"))
        assertEquals("e",aim.facing(.5f,0f,"s"),"The squared deadzone is strictly less, not inclusive")
        assertEquals("e",HowlAimArt(.25f,45f).facing(1f,1f,"e"),"Angular retention is inclusive at the generated boundary")
        assertEquals("se",HowlAimArt(.25f,44f).facing(1f,1f,"s"))
    }
    @Test fun `completed Howl starts prowl at frame one and subsequent direction changes preserve its phase`() {
        val prowl=body.copy(key="prowl",frames=body.frames.mapIndexed { r,row->row.indices.map { "prowl-$r-$it" } })
        val rend=body.copy(key="rend",frames=body.frames.mapIndexed { r,row->row.indices.map { "rend-$r-$it" } })
        val specific=art.copy(clips=art.clips+("idle" to prowl)+("rend" to rend),
            profile=reader.parse("""{"stand":"idle","move":"idle","melee":{"troop":"rend"}}"""))
        val p=plan(listOf(deploy,cast),customArt=specific)
        assertEquals("body-2-7",p.actor(1,Math.nextDown(9f))!!.frameKey)
        assertEquals("prowl-2-0",p.actor(1,9f)!!.frameKey,"Completion must not inherit the global battle clock")
        assertEquals("prowl-2-1",p.actor(1,10f)!!.frameKey)
        assertEquals("prowl-2-0",p.actor(1,9f)!!.frameKey,"Seeking restores the same completion boundary")
        val moved=plan(listOf(deploy,cast,"""{"e":"pos","t":15,"id":1,"x":500,"y":100}"""),customArt=specific)
        assertEquals("prowl-0-2",moved.actor(1,11f)!!.frameKey,"A later prowl row swap turns east without restarting its gait")
        val movingAtCompletion=plan(listOf(deploy,cast,"""{"e":"pos","t":12,"id":1,"x":500,"y":100}"""),customArt=specific)
        assertEquals("prowl-0-0",movingAtCompletion.actor(1,9f)!!.frameKey,"Completing during a live move also begins a fresh locomotion loop")
        val attacked=plan(listOf(deploy,cast,"""{"e":"troopAttack","t":10,"id":1,"target":9,"ix":200,"iy":100}"""),customArt=specific)
        assertEquals("rend-0-0",attacked.actor(1,10f)!!.frameKey)
        assertEquals("prowl-0-2",attacked.actor(1,18f)!!.frameKey,"A later non-Howl action retains existing transition behavior; this fix is scoped")
        assertEquals("prowl-2-1",plan(listOf(deploy),customArt=specific).actor(1,9f)!!.frameKey,"Actors without Howl retain prior loop timing")
    }
    @Test fun `renderer ten requires complete Howl metadata without rejecting older catalogues`() {
        val clip="""{"key":"body","atlasPath":"atlas/body.json","frames":[["f1","f2"]],"rowOrder":["s"],"fps":10,"anchor":[0.5,0.5],"scale":1,"cellWidth":20,"cellHeight":20,"loop":false}"""
        val howl="""{"bodyState":"howl","releaseFrame":2,"offsetX":0,"offsetY":0,"depthOffset":-1,"target":"currentActorAtRelease","facing":"retainUnlessAimed","ownedCancellation":true,"aim":{"minimumDeltaSquared":0.25,"retainWithinDegrees":32.5},"clip":$clip}"""
        val missing="""{"rendererContractVersion":10,"actors":[{"type":"gloamfang","frameKey":"actor","combat":{"clips":{"howl":$clip},"profile":{}}}]}"""
        assertEquals("Howl contract missing from admitted Gloamfang",assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(reader.parse(missing))}.message)
        assertEquals(1,CombatArt.catalogue(reader.parse(missing.replace(":10",":9"))).size)
        val valid=missing.replace("\"profile\":{}","\"profile\":{},\"howl\":$howl")
        assertNotNull(CombatArt.catalogue(reader.parse(valid))["actor"]?.howl)
        assertEquals("Howl body clip missing: howl",assertFailsWith<IllegalArgumentException>{
            CombatArt.catalogue(reader.parse(valid.replace("\"clips\":{\"howl\":$clip}","\"clips\":{}")))
        }.message)
        assertEquals("Howl aim contract missing",assertFailsWith<IllegalArgumentException>{
            CombatArt.catalogue(reader.parse(valid.replace("\"aim\":{\"minimumDeltaSquared\":0.25,\"retainWithinDegrees\":32.5},","")))
        }.message)
        for(broken in listOf(valid.replace("\"releaseFrame\":2","\"releaseFrame\":3"),valid.replace("\"ownedCancellation\":true","\"ownedCancellation\":false"),
            valid.replace("retainUnlessAimed","unknown"),valid.replace("currentActorAtRelease","unknown"),
            valid.replace("\"minimumDeltaSquared\":0.25","\"minimumDeltaSquared\":-1"),valid.replace("\"retainWithinDegrees\":32.5","\"retainWithinDegrees\":181"),
            // Contract 15 is the reviewed realm-kit contract (docs/REALM-KIT-PLAN.md E-8); 16 is the first future one.
            valid.replace("\"rendererContractVersion\":10","\"rendererContractVersion\":16")))
            assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(reader.parse(broken))}
    }
}
