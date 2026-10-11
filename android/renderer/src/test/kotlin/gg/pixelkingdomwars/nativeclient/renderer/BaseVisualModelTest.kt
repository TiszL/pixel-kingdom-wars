package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class BaseVisualModelTest {
    private fun clip(name: String)=AuthoredClip(name,"atlas/$name.json",List(8) { row -> List(4) { "$name-$row-$it" } },
        listOf("e","se","s","sw","w","nw","n","ne"),10f,.5f,1f,2f,16f,24f,true,null,emptyMap())
    private val walk=clip("walk");private val attack=clip("attack")
    private val rules=BasePresentation(64f,setOf("mine","forge"),setOf("mine","forge","keep"),setOf("cannon","mortar"),
        "idle","work","build","levelup",false,JobPresentation(1200f,1f,-24f,-40f,-44f,-6f,clip("scaffold"),
            mapOf(1 to (walk to attack)),20000f,10000f,8f))
    private val art=CombatArt(listOf("idle","work","build","levelup").associateWith(::clip),JsonReader().parse("{}"),emptyMap(),emptyMap(),0f,0f)
    private fun scene(job: RenderJob?=null,level: Int=1,base: String="a",constructing: Boolean=false)=BaseScene(
        listOf(RenderBuilding("keep","keep",2f,2f,2f,2f,type="keep",level=1),
            RenderBuilding("mine","mine$level",5f,4f,2f,2f,type="mine",level=level,underConstruction=constructing)),
        16,16,64f,baseId=base,jobs=listOfNotNull(job),keepLevel=1)
    private fun job(id: String="job",kind: String="upgrade",start: Long=0L,end: Long=3000L)=RenderJob(id,kind,5f,4f,2f,2f,start,end,"mine")
    private fun model(scene: BaseScene,at: Long=0,old: BaseVisualModel?=null)=BaseVisualModel(scene,mapOf("keep" to art,"mine1" to art,"mine2" to art),rules,at,old)
    @Test fun `installed pack rest metadata animates Air Mine and follows server spent repair states`() {
        val root=java.io.File(System.getenv("PKW_COMBAT_PACK") ?: "../app/src/main/assets/native")
        val catalogue=JsonReader().parse(root.resolve("render-catalog.json").readText())
        val sourceRules=assertNotNull(RendererCatalogue.basePresentation(catalogue))
        val library=CombatArt.catalogue(catalogue)
        for(level in 1..20) {
            val entry=catalogue.get("entries").first { it.getString("type","")=="airmine" && it.getInt("level",0)==level }
            val key=entry.getString("frameKey")
            val scene=BaseScene(listOf(RenderBuilding("trap",key,4f,6f,1f,1f,type="airmine",level=level)),30,30,64f,baseId="fixture")
            val first=BaseVisualModel(scene,library,sourceRules,0)
            val sprite=assertNotNull(first.building("trap",0))
            assertEquals("drift",library.getValue(key).profile.getString("stand"))
            assertNotEquals(sprite.frameKey,first.building("trap",200)!!.frameKey)
            assertEquals(sprite.clip.anchorY,sprite.anchorY,"The floating authored seat must not become a bottom-anchored building")
            assertEquals(setOf(sprite.clip.atlasPath),first.requiredAtlases,"No trigger or projectile residency is added")
            val refreshed=BaseVisualModel(scene,library,sourceRules,150,first)
            assertEquals(first.building("trap",300),refreshed.building("trap",300))
            val spent=scene.copy(buildings=scene.buildings.map { it.copy(trapSpent=true) })
            val disabled=BaseVisualModel(spent,library,sourceRules,400,refreshed)
            assertTrue(disabled.building("trap",500)!!.frameKey.contains("sprung"))
            assertEquals(disabled.building("trap",500),disabled.building("trap",5000))
            val repaired=BaseVisualModel(scene,library,sourceRules,600,disabled)
            assertEquals(sprite.frameKey,repaired.building("trap",600)!!.frameKey)
            assertNull(BaseVisualModel(scene.copy(buildings=scene.buildings.map { it.copy(underConstruction=true) }),library,sourceRules,0).building("trap",200))
        }
    }
    @Test fun `base building loops slow down without retiming construction flashes builders or authored combat clips`() {
        val slower=rules.copy(buildingLoopSpeed=0.5f)
        fun slow(scene: BaseScene,at: Long=0,old: BaseVisualModel?=null)=BaseVisualModel(scene,mapOf("keep" to art,"mine1" to art,"mine2" to art),slower,at,old)
        assertEquals(model(scene()).building("mine",100)!!.frameKey,slow(scene()).building("mine",200)!!.frameKey)
        assertEquals(model(scene()).building("keep",100)!!.frameKey,slow(scene()).building("keep",200)!!.frameKey)
        assertNotEquals(model(scene()).building("mine",200)!!.frameKey,slow(scene()).building("mine",200)!!.frameKey)
        val before=slow(scene(job()))
        assertEquals(model(scene(job())).building("mine",200)!!.frameKey,before.building("mine",200)!!.frameKey)
        val fastJobs=mutableListOf<BaseVisualSprite>();val slowJobs=mutableListOf<BaseVisualSprite>()
        model(scene(job())).jobs(200,fastJobs);before.jobs(200,slowJobs);assertEquals(fastJobs,slowJobs)
        val completed=slow(scene(level=2),3000,before)
        assertEquals("levelup-0-2",completed.building("mine",3200)!!.frameKey)
        assertTrue(completed.building("mine",3400)!!.frameKey.startsWith("work-"),"the upgrade flash ends on its authored clock")
        assertEquals(10f,art.clips.getValue("work").fps,"base scaling never edits the combat/shared clip")
    }
    @Test fun `home residency includes active body and transition dependencies but excludes combat effects`() {
        val fullArt=art.copy(clips=art.clips+mapOf("fire" to clip("defense-fire")),effects=mapOf("projectile" to clip("projectile-fx")))
        val library=mapOf("keep" to fullArt,"mine1" to fullArt,"mine2" to fullArt)
        val home=BaseVisualModel(scene(),library,rules,0)
        assertEquals(setOf("atlas/idle.json","atlas/work.json"),home.requiredAtlases)
        val building=BaseVisualModel(scene(job()),library,rules,0,home)
        assertEquals(setOf("atlas/idle.json","atlas/build.json","atlas/scaffold.json","atlas/walk.json","atlas/attack.json"),building.requiredAtlases)
        val completed=BaseVisualModel(scene(level=2),library,rules,3000,building)
        assertEquals(setOf("atlas/idle.json","atlas/work.json","atlas/levelup.json"),completed.requiredAtlases,
            "Confirmed flash needs its later resting clip while combat projectile and attack atlases remain absent")
        val fallback=BaseVisualModel(scene(job()),library.mapValues { it.value.copy(clips=mapOf("idle" to clip("idle"))) },rules,0)
        assertTrue("atlas/idle.json" in fallback.requiredAtlases,"Canonical missing-build fallback must already be resident")
    }
    @Test fun `animated seats preserve source offsets and missing construction clip loops canonical idle`() {
        val scene=scene(job()).copy(buildings=scene(job()).buildings.map { if(it.id=="mine")it.copy(type="cannon")else it })
        val idleOnly=art.copy(clips=mapOf("idle" to clip("idle")))
        val model=BaseVisualModel(scene,mapOf("mine1" to idleOnly),rules,0,seatOffsets=mapOf("mine1" to (2f to -3f)))
        val sprite=model.building("mine",500)!!
        assertEquals("idle-0-1",sprite.frameKey,"Absent authored build/work falls back to looping idle, never a static alias or held final frame")
        assertEquals(386f,sprite.x);assertEquals(381f,sprite.y)
        assertEquals(model.structureDepth(384f),sprite.depth,"Art nudge must not change footprint painter order")
    }
    @Test fun `resource work remains active without research and refresh keeps authored phase`() {
        val first=model(scene())
        assertTrue(first.building("mine",150)!!.frameKey.startsWith("work-"))
        val refresh=model(scene(),120,first)
        assertEquals(first.building("mine",250),refresh.building("mine",250))
        assertTrue(first.building("keep",150)!!.frameKey.startsWith("idle-"))
        assertFalse(first.building("mine",150)!!.frameKey.startsWith("levelup-"),"Initial completed snapshot must not replay an upgrade")
    }
    @Test fun `builder follows actual job geometry then works past deadline until server removes the job`() {
        val first=model(scene(job()))
        val sprites=mutableListOf<BaseVisualSprite>()
        first.jobs(0,sprites)
        assertEquals(2,sprites.size);assertEquals(128f,sprites.first().width);assertEquals(128f,sprites.first().height)
        val start=sprites.last();assertEquals(168f,start.x);assertEquals(216f,start.y)
        first.jobs(600,sprites);assertEquals(222f,sprites.last().x);assertEquals(297f,sprites.last().y)
        first.jobs(1200,sprites);assertEquals(276f,sprites.last().x);assertEquals(378f,sprites.last().y)
        assertTrue(sprites.last().frameKey.startsWith("attack-0-"))
        assertTrue(first.building("mine",7000)!!.frameKey.endsWith("-3"),"Build clip holds; elapsed deadline is not authority")
        first.jobs(7000,sprites);assertEquals(2,sprites.size)
        val expired=sprites.toList();first.jobs(200,sprites);first.jobs(7000,sprites);assertEquals(expired,sprites)
        val refresh=model(scene(job()),6500,first);refresh.jobs(7000,sprites);assertEquals(expired,sprites)
        model(scene(),7100,refresh).jobs(7200,sprites);assertTrue(sprites.isEmpty())
    }
    @Test fun `only observed completed upgrade flashes and new job or base invalidates old one shot`() {
        val before=model(scene(job()))
        val complete=model(scene(level=2),3000,before)
        assertTrue(complete.building("mine",3100)!!.frameKey.startsWith("levelup-"))
        val refresh=model(scene(level=2),3150,complete)
        assertEquals(complete.building("mine",3200),refresh.building("mine",3200))
        assertTrue(refresh.building("mine",3400)!!.frameKey.startsWith("work-"))
        assertTrue(model(scene(),3000,before).building("mine",3100)!!.frameKey.startsWith("work-"),"Cancellation at unchanged level must not flash completion")
        assertTrue(model(scene(job("replacement",start=3150,end=6000),level=2),3150,complete).building("mine",3200)!!.frameKey.startsWith("build-"))
        assertTrue(model(scene(level=2,base="other"),3100,complete).building("mine",3200)!!.frameKey.startsWith("work-"))
    }
    @Test fun `one builder workman serves every keep level walking gate to site then hammering toward the target`() {
        val order=listOf("s","sw","w","nw","n","ne","e","se")
        fun body(name: String,frames: Int,fps: Float)=AuthoredClip(name,"atlas/builder.json",List(8) { row -> List(frames) { "$name-${order[row]}-$it" } },order,fps,.5f,70f/84,.55f,84f,84f,true,null,emptyMap())
        val workman=BuilderPresentation(body("walk",8,10f),body("work",6,8f),body("idle",1,1f),1200f,0f,40f,-40f,-12f,-52f,12f)
        val model=BaseVisualModel(scene(job()).copy(keepLevel=7),mapOf("keep" to art,"mine1" to art),rules,0,builder=workman)
        assertEquals(setOf("atlas/idle.json","atlas/build.json","atlas/scaffold.json","atlas/builder.json"),model.requiredAtlases,
            "the single-body builder atlas replaces the per-level stand-in atlases")
        val sprites=mutableListOf<BaseVisualSprite>()
        model.jobs(0,sprites);val start=sprites.last()
        assertEquals(168f,start.x);assertEquals(216f,start.y,"keep gate: (keep.tx+gate.tileX)*T+gate.offsetX, keep south+gate.offsetY")
        assertEquals("walk-se-0",start.frameKey,"walking faces gate to site, never a fixed row");assertEquals(84*.55f,start.width);assertEquals(70f/84,start.anchorY)
        model.jobs(600,sprites);assertEquals(238f,sprites.last().x);assertEquals(274f,sprites.last().y);assertEquals("walk-se-6",sprites.last().frameKey)
        model.jobs(1200,sprites);val working=sprites.last()
        assertEquals(308f,working.x);assertEquals(332f,working.y,"site: left+site.offsetX, south+site.offsetY")
        assertEquals("work-e-0",working.frameKey,"the hammer loop restarts at the cutover and faces the target centre")
        model.jobs(1200+375,sprites);assertEquals("work-e-3",sprites.last().frameKey)
        model.jobs(1200+750,sprites);assertEquals("work-e-0",sprites.last().frameKey,"the work loop keeps its authored phase")
        assertEquals(start.depth,rules.jobs.actorDepthOffset+start.y,"the builder is an actor sorted on his feet")
        val nested=scene(job().copy(targetX=1f,targetY=1f))
        BaseVisualModel(nested,mapOf("keep" to art,"mine1" to art),rules,0,builder=workman).jobs(0,sprites)
        assertEquals("walk-nw-0",sprites.last().frameKey,"a site north-west of the gate walks north-west")
        BaseVisualModel(scene(job()).copy(keepLevel=null),mapOf("keep" to art,"mine1" to art),rules,0,builder=workman).jobs(0,sprites)
        assertEquals(2,sprites.size,"one civilian body needs no keep level")
        assertFailsWith<IllegalArgumentException> { BuilderPresentation.parse(JsonReader().parse("{\"version\":2}")) }
    }
    @Test fun `the scene draws exactly one builder per server job whatever the footprint and none for a service build`() {
        // Owner 2026-10-06: "when building something big builders second one appears". Builders on screen must be exactly
        // the server's jobs: one Workman per ordinary job (a 4x4 site is still one body, never one per tile or per edge),
        // none for a Phase E service build (its construction marker stands the builder), none without a job (a placement
        // ghost is Compose-only and never reaches the scene), and the Compose layer reads the same set via workmanJobs.
        val order=listOf("s","sw","w","nw","n","ne","e","se")
        fun body(name: String)=AuthoredClip(name,"atlas/builder.json",List(8) { row -> List(4) { "$name-${order[row]}-$it" } },order,8f,.5f,.8f,.55f,84f,84f,true,null,emptyMap())
        val workman=BuilderPresentation(body("walk"),body("work"),null,1200f,0f,40f,-40f,-12f,-52f,12f)
        val big=RenderBuilding("bigmine","mine1",9f,9f,4f,4f,type="mine",level=1,underConstruction=true)
        val service=RenderBuilding("ws","service:workshop:1",3f,9f,2f,2f,type="workshop",level=1,underConstruction=true,
            service=RenderServiceIdentity("workshop",1))
        val base=scene(job())
        val jobs=listOf(job(),RenderJob("big","build",9f,9f,4f,4f,0L,9000L,"bigmine"),RenderJob("svc","build",3f,9f,2f,2f,0L,9000L,"ws"))
        val built=base.copy(buildings=base.buildings+big+service,jobs=jobs)
        assertEquals(listOf("job","big"),built.workmanJobs().map { it.id },"a service build has no scene Workman")
        val sprites=mutableListOf<BaseVisualSprite>()
        for(now in listOf(0L,600L,1500L,8000L)) {
            for(presentation in listOf(null,workman)) {
                BaseVisualModel(built,mapOf("keep" to art,"mine1" to art),rules,0,builder=presentation).jobs(now,sprites)
                val bodies=sprites.filter { it.clip.atlasPath=="atlas/builder.json" || it.clip==walk || it.clip==attack }
                assertEquals(built.workmanJobs().size,bodies.size,"one builder per ordinary job at ${now}ms")
                assertEquals(2,sprites.count { it.clip==rules.jobs.scaffold },"one scaffold per ordinary job")
            }
        }
        BaseVisualModel(scene(),mapOf("keep" to art,"mine1" to art),rules,0,builder=workman).jobs(0,sprites)
        assertTrue(sprites.isEmpty(),"no job, no builder: nothing previews a builder before the server starts one")
        assertTrue(scene().workmanJobs().isEmpty())
    }
    @Test fun `replacement jobs and moved targets discard stale builder positions without guessing missing keep art`() {
        val first=model(scene(job()))
        val replacement=model(scene(job("new",start=4000,end=9000)),4000,first)
        val sprites=mutableListOf<BaseVisualSprite>();replacement.jobs(4000,sprites)
        assertEquals(168f,sprites.last().x)
        val moved=scene(job().copy(targetX=7f))
        model(moved,5000,first).jobs(5000,sprites);assertEquals(404f,sprites.last().x)
        model(scene(job()).copy(keepLevel=null)).jobs(5000,sprites)
        assertEquals(1,sprites.size,"Missing decorative tier retains scaffold, never invents a troop level")
        assertFailsWith<IllegalArgumentException> { model(scene(job().copy(finishesAtMs=-1))) }
    }
}
