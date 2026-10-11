package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import kotlin.test.*
import org.junit.Test

class MaulVisualTest {
    private val reader=JsonReader()
    private val body=AuthoredClip("body","atlas/body.json",List(8){r->List(8){"body-$r-$it"}},
        listOf("e","se","s","sw","w","nw","n","ne"),10f,.5f,.5f,1f,20f,20f,false,null,emptyMap())
    private val impact=body.copy(key="impact",atlasPath="atlas/impact.json",frames=listOf(List(10){"impact-$it"}),rowOrder=listOf("s"))
    private val art=CombatArt(mapOf("maul" to body,"idle" to body),reader.parse("""{"stand":"idle","move":"idle","melee":{"troop":"idle"}}"""),
        emptyMap(),emptyMap(),0f,0f,maul=MaulArt("maul",3,100f,-10f,10f,8f,1f,impact))
    private val deploy="""{"e":"deploy","t":0,"id":1,"troop":"direwyvern","x":0,"y":0}"""
    private val cast="""{"e":"troopAbility","t":1,"id":1,"ability":"maul","x":100,"y":100}"""
    private fun plan(events:List<String>):CombatVisualPlan {
        val parsed=events.map(PresentationEvent::fromJson)
        val scene=BattleScene(BaseScene(emptyList(),10,10,256f),PresentationRevision("raid","revision",14,0,0,parsed),
            mapOf("direwyvern" to "actor"),256f,100f,5,5)
        return CombatVisualPlan(scene,BattleVisualModel(parsed,5),mapOf("actor" to art))
    }
    @Test fun `two wing impacts release one authored body frame apart and expire independently`() {
        val p=plan(listOf(deploy,cast));val out=mutableListOf<CombatSprite>()
        assertTrue(p.missingCoverage.isEmpty());assertEquals(setOf("atlas/body.json","atlas/impact.json"),p.requiredAtlases)
        p.transientSprites(Math.nextDown(3f),out);assertTrue(out.isEmpty())
        p.transientSprites(3f,out);assertEquals(90f,out.single().x);assertEquals(108f,out.single().y)
        assertEquals("impact-0",out.single().frameKey);assertEquals(101f,out.single().depth)
        p.transientSprites(Math.nextDown(4f),out);assertEquals(1,out.size)
        p.transientSprites(4f,out);assertEquals(listOf(90f,110f),out.map { it.x });assertEquals(listOf("impact-1","impact-0"),out.map { it.frameKey })
        p.transientSprites(13f,out);assertEquals(110f,out.single().x)
        assertEquals(1f,p.playbackExtent.eventEndTick);assertEquals(14f,p.playbackExtent.visualEndTick)
        p.transientSprites(14f,out);assertTrue(out.isEmpty())
        p.transientSprites(4f,out);assertEquals(2,out.size,"Seeking reconstructs both original impacts without callbacks")
    }
    @Test fun `second impact samples current X and depth but retains first release ground Y`() {
        val p=plan(listOf(deploy,cast,"""{"e":"pos","t":6,"id":1,"x":200,"y":300}"""));val out=mutableListOf<CombatSprite>()
        assertEquals(100f,p.actor(1,1f)!!.x,"Maul snaps to the authoritative cast origin")
        p.transientSprites(4f,out);assertEquals(listOf(130f,170f),out.map { it.x })
        assertEquals(listOf(188f,188f),out.map { it.y });assertEquals(listOf(181f,221f),out.map { it.depth })
        val captured=out.toList();p.transientSprites(5f,out)
        assertEquals(captured.map { it.x to it.y },out.map { it.x to it.y },"Released impacts never follow later actor movement")
    }
    @Test fun `death removes the first image and cancels a not yet released second wing`() {
        val out=mutableListOf<CombatSprite>()
        for(death in listOf(2,3,4)) {
            val p=plan(listOf(deploy,cast,"""{"e":"troopDeath","t":$death,"id":1}"""))
            p.transientSprites(death.toFloat(),out);assertTrue(out.isEmpty())
            p.transientSprites(5f,out);assertTrue(out.isEmpty())
        }
        val p=plan(listOf(deploy,cast,"""{"e":"troopDeath","t":4,"id":1}"""))
        p.transientSprites(3f,out);assertEquals(1,out.size)
        plan(listOf(deploy,"""{"e":"troopDeath","t":1,"id":1}""",cast)).transientSprites(3f,out);assertTrue(out.isEmpty())
    }
    @Test fun `replacement rebuild discards obsolete impacts while a seek restores only current revision`() {
        val out=mutableListOf<CombatSprite>();val old=plan(listOf(deploy,cast))
        old.transientSprites(4f,out);assertEquals(2,out.size)
        plan(listOf(deploy)).transientSprites(4f,out);assertTrue(out.isEmpty())
        val moved=plan(listOf(deploy,cast.replace("\"x\":100","\"x\":500")))
        moved.transientSprites(4f,out);assertEquals(listOf(490f,510f),out.map { it.x })
        moved.transientSprites(2f,out);assertTrue(out.isEmpty());moved.transientSprites(4f,out);assertEquals(2,out.size)
    }
    @Test fun `run and bounded legacy duplicates cannot create a third impact`() {
        val out=mutableListOf<CombatSprite>();val run="""{"e":"attackRun","t":1,"id":1,"technique":"maul","count":1,"cadenceTicks":10}"""
        val legacy="""{"e":"troopAttack","t":1,"id":1,"target":9}"""
        val p=plan(listOf(deploy,run,legacy,cast));p.transientSprites(4f,out)
        assertEquals(2,out.size);assertTrue(p.missingCoverage.isEmpty())
    }
    @Test fun `targetless cast retains west facing instead of the cast snap or a future teleport direction`() {
        val p=plan(listOf(deploy,"""{"e":"pos","t":2,"id":1,"x":-100,"y":0}""",
            cast.replace("\"t\":1","\"t\":3"),"""{"e":"emerge","t":3,"id":1,"x":500,"y":100}"""))
        assertEquals("body-4-0",p.actor(1,3f)!!.frameKey)
        assertEquals("body-4-2",p.actor(1,5f)!!.frameKey)
    }
    @Test fun `targetless casts preserve completed attack facing until a newer movement changes it`() {
        val attack="""{"e":"troopAttack","t":1,"id":1,"target":9,"ix":-100,"iy":0}"""
        val p=plan(listOf(deploy,attack,cast.replace("\"t\":1","\"t\":12")))
        assertEquals("body-4-0",p.actor(1,12f)!!.frameKey,"Stand keeps the previous completed attack direction")
        val moved=plan(listOf(deploy,attack,"""{"e":"pos","t":15,"id":1,"x":500,"y":0}""",
            cast.replace("\"t\":1","\"t\":20")))
        assertEquals("body-0-0",moved.actor(1,20f)!!.frameKey,"Newer ordinary movement supersedes old attack facing")
    }
    @Test fun `standing after Maul retains facing until later movement or attack replaces it`() {
        val prelude=listOf(deploy,"""{"e":"pos","t":2,"id":1,"x":-100,"y":0}""",cast.replace("\"t\":1","\"t\":3"))
        assertTrue(plan(prelude).actor(1,12f)!!.frameKey.startsWith("body-4-"),"Finishing targetless Maul must not turn west into default south")
        val moved=prelude+"""{"e":"pos","t":15,"id":1,"x":500,"y":100}"""
        assertTrue(plan(moved).actor(1,16f)!!.frameKey.startsWith("body-0-"))
        val attacked=moved+"""{"e":"troopAttack","t":16,"id":1,"target":9,"ix":500,"iy":0}"""
        assertTrue(plan(attacked).actor(1,25f)!!.frameKey.startsWith("body-6-"),"Completed newer attack direction supersedes both Maul and movement")
    }
    @Test fun `renderer nine requires Maul and validates clocks without rejecting older eight`() {
        val clip="""{"key":"body","atlasPath":"atlas/body.json","frames":[["f1","f2"]],"rowOrder":["s"],"fps":10,"anchor":[0.5,0.5],"scale":1,"cellWidth":20,"cellHeight":20,"loop":false}"""
        val fan="""{"bodyState":"firestorm","emitter":"maw","pinFrames":[1],"reachPx":20,"depthOffset":1,"target":"visibleBuildingCenterOrEvent","clip":$clip}"""
        val maul="""{"bodyState":"maul","releaseFrame":2,"secondDelayMs":100,"leftOffsetX":-10,"rightOffsetX":10,"groundOffsetY":8,"depthOffset":1,"target":"currentActorXAtReleaseCapturedGroundY","clip":$clip}"""
        val noMaul="""{"rendererContractVersion":9,"actors":[{"type":"direwyvern","frameKey":"actor","combat":{"clips":{"maul":$clip},"profile":{},"firestorm":$fan}}]}"""
        assertEquals("Maul contract missing from admitted Direwyvern",assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(reader.parse(noMaul))}.message)
        assertEquals(1,CombatArt.catalogue(reader.parse(noMaul.replace(":9",":8"))).size)
        val valid=noMaul.replace("\"firestorm\":$fan","\"firestorm\":$fan,\"maul\":$maul")
        assertNotNull(CombatArt.catalogue(reader.parse(valid))["actor"]?.maul)
        assertNotNull(CombatArt.catalogue(reader.parse(valid.replace("\"rendererContractVersion\":9","\"rendererContractVersion\":15")))["actor"]?.maul,
            "Service catalogue support preserves the authored Maul contract")
        // Admitted content-mount contract 17 inherits the existing combat metadata unchanged.
        val contentMountCompatible=CombatArt.catalogue(reader.parse(valid.replace("\"rendererContractVersion\":9","\"rendererContractVersion\":17"))).getValue("actor")
        assertNotNull(contentMountCompatible.maul)
        assertEquals(CombatArt.catalogue(reader.parse(valid)).getValue("actor").atlases,contentMountCompatible.atlases,
            "Content-mount support preserves authored Maul residency")
        val missingBody=valid.replace("\"clips\":{\"maul\":$clip}","\"clips\":{}")
        assertEquals("Maul body clip missing: maul",assertFailsWith<IllegalArgumentException>{
            CombatArt.catalogue(reader.parse(missingBody))
        }.message,"Missing authored body art must fail at the content boundary with an actionable error")
        val missingClips=valid.replace("\"clips\":{\"maul\":$clip},","")
        assertEquals("Combat clips missing",assertFailsWith<IllegalArgumentException>{
            CombatArt.catalogue(reader.parse(missingClips))
        }.message)

        for(broken in listOf(valid.replace("\"releaseFrame\":2","\"releaseFrame\":3"),
            valid.replace("\"secondDelayMs\":100","\"secondDelayMs\":0"),valid.replace("currentActorXAtReleaseCapturedGroundY","unknown")))
            assertFailsWith<IllegalArgumentException>{CombatArt.catalogue(reader.parse(broken))}
        val unsupportedVersion=firstUnsupportedCombatRendererVersion()
        val unsupported=valid.replace("\"rendererContractVersion\":9","\"rendererContractVersion\":$unsupportedVersion")
        assertEquals("Unsupported combat renderer contract",assertFailsWith<IllegalArgumentException>{
            CombatArt.catalogue(reader.parse(unsupported))
        }.message)
    }
}
