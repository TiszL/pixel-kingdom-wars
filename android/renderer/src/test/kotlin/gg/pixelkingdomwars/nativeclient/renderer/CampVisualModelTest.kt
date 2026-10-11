package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import org.junit.Test
import kotlin.test.*

class CampVisualModelTest {
    private fun clip(name: String) = AuthoredClip(name,"atlas/$name.json",List(8) { row -> List(4) { "$name-$row-$it" } },
        listOf("e","se","s","sw","w","nw","n","ne"),10f,.5f,.9f,1.32f,32f,48f,true,null,emptyMap())
    private val move = clip("walk"); private val stand = clip("idle")
    private val art = CombatArt(mapOf("walk" to move,"idle" to stand,"attack" to clip("attack")),JsonReader().parse("""{"move":"walk","stand":"idle"}"""),emptyMap(),mapOf("death" to clip("death")),0f,0f)
    private val rules = CampPatrolRules(6,20f,.4f,700f,2400f,3,6,1f,64f)
    private val camp = RenderBuilding("camp","camp",6f,6f,3f,3f,type="camp",level=1)
    private fun scene(buildings: List<RenderBuilding> = listOf(camp), count: Int = 3) = BaseScene(buildings,30,30,64f,baseId="base",
        campTroops=List(count) { RenderCampTroop("camp",it,"bowman",1,"bowman") },campRules=rules)
    private fun prepared(scene: BaseScene) = PreparedCampScene.prepare(scene,mapOf("bowman" to art,"bowman2" to art),20000f)
    private fun sprites(model: CampVisualModel, reduced: Boolean = false) = mutableListOf<BaseVisualSprite>().also { model.sprites(it,reduced) }
    @Test fun `expanded signed plot routes around negative coordinate walls and preserves world positions`() {
        val wall = RenderBuilding("negative-wall","wall",-5f,-10f,1f,14f,type="wall")
        val expanded = scene(listOf(wall)).copy(columns=50,rows=50,minimumTileX=-10,minimumTileY=-10)
        val occupancy = CampOccupancy(expanded)
        val start = CampPoint(-6.5f*64,-3.5f*64); val goal = CampPoint(-3.5f*64,-3.5f*64)
        assertFalse(occupancy.free(-4.5f*64,-3.5f*64))
        assertFalse(occupancy.clear(start.x,start.y,goal.x,goal.y))
        val path = assertNotNull(occupancy.toward(goal).from(start))
        var prior=start
        for(point in path.points) { assertTrue(occupancy.clear(prior.x,prior.y,point.x,point.y));prior=point }
        assertTrue(path.points.any { it.y >= 4*64 })
        assertEquals(goal,path.points.last())
    }
    @Test fun `routes reach around a long wall without cutting corners or crossing real obstacles`() {
        val walls = (0..25).map { RenderBuilding("wall-$it","wall",9f,it.toFloat(),1f,1f,type="wall") }
        val scene = scene(walls).copy(obstacles=listOf(RenderObstacle("rock","rock",7f,4f,1f,2f)))
        val occupancy = CampOccupancy(scene)
        val start = CampPoint(8.5f*64,2.5f*64); val goal = CampPoint(10.5f*64,2.5f*64)
        assertFalse(occupancy.clear(start.x,start.y,goal.x,goal.y))
        val path = assertNotNull(occupancy.toward(goal).from(start))
        assertTrue(path.points.any { it.y >= 26*64 })
        var previous = start
        for(point in path.points) { assertTrue(occupancy.clear(previous.x,previous.y,point.x,point.y));previous=point }
        val moved = assertNotNull(occupancy.nearest(CampPoint(9.3f*64,2.7f*64),3))
        assertEquals(.3f, moved.x/64-kotlin.math.floor(moved.x/64),.0001f)
        assertEquals(.7f, moved.y/64-kotlin.math.floor(moved.y/64),.0001f)
    }
    @Test fun `camp loops use only real locomotion and stand atlases and every sampled foot remains free`() {
        val scene = scene().copy(obstacles=listOf(RenderObstacle("rock","rock",9f,7f,2f,2f)))
        val plan = assertNotNull(prepared(scene)); val model=CampVisualModel();model.replace(plan)
        assertEquals(setOf(move.atlasPath,stand.atlasPath),plan.requiredAtlases)
        val before=sprites(model)
        repeat(600) { model.advance(100f,false);sprites(model).forEach { assertTrue(plan.occupancy.free(it.x,it.y)) } }
        assertNotEquals(before.map {it.x to it.y},sprites(model).map {it.x to it.y})
        assertTrue(sprites(model).all {it.width==32f*1.32f && it.anchorY==.9f && it.depth==20000f+it.y})
    }
    @Test fun `same base refresh preserves position pauses and animation phase without doubling troops`() {
        val a=CampVisualModel();val b=CampVisualModel();a.replace(prepared(scene()));b.replace(prepared(scene()))
        repeat(45) {a.advance(100f,false);b.advance(100f,false)}
        a.replace(prepared(scene().copy(buildings=scene().buildings.reversed())))
        assertEquals(sprites(b),sprites(a));assertEquals(3,a.count)
        repeat(30) {a.advance(100f,false);b.advance(100f,false)}
        assertEquals(sprites(b),sprites(a))
    }
    @Test fun `reduced motion stands down and freezes patrol while empty army removes every actor`() {
        val model=CampVisualModel();model.replace(prepared(scene()));model.advance(4000f,false)
        val before=sprites(model,true)
        repeat(100) {model.advance(100f,true)}
        assertEquals(before,sprites(model,true));assertTrue(before.all {it.clip==stand})
        model.replace(prepared(scene(count=0)));assertEquals(0,model.count);assertTrue(sprites(model).isEmpty())
    }
    @Test fun `camp movement settles survivors on free ground and routes toward the new camp without duplicating`() {
        val model=CampVisualModel();model.replace(prepared(scene()));model.advance(3700f,false)
        val moved=scene(listOf(camp.copy(tileX=12f)))
        val plan=assertNotNull(prepared(moved));model.replace(plan)
        assertEquals(3,model.count)
        repeat(1200) {model.advance(100f,false);sprites(model).forEach { assertTrue(plan.occupancy.free(it.x,it.y)) }}
        assertTrue(sprites(model).all {it.x>10*64})
        model.replace(prepared(moved.copy(campTroops=moved.campTroops.take(1).map {it.copy(level=2,frameKey="bowman2")})))
        assertEquals(1,model.count)
        model.replace(prepared(moved.copy(baseId="other")))
        val fresh=CampVisualModel();fresh.replace(prepared(moved.copy(baseId="other")))
        assertEquals(sprites(fresh),sprites(model))
    }
    @Test fun `sealed camp has no false soldiers embedded in building footprints`() {
        val sealed=scene(listOf(camp,RenderBuilding("cover","cover",0f,0f,30f,30f,type="keep")))
        val model=CampVisualModel();model.replace(prepared(sealed));assertEquals(0,model.count)
    }
    @Test fun `installed troop levels resolve authored home bodies without requiring combat effect atlases`() {
        val root=java.io.File(System.getenv("PKW_COMBAT_PACK") ?: "../app/src/main/assets/native")
        val catalogue=JsonReader().parse(root.resolve("render-catalog.json").readText())
        val library=CombatArt.catalogue(catalogue)
        for (actor in catalogue.get("actors")) {
            val key=actor.getString("frameKey");val body=library.getValue(key)
            val move=body.clips.getValue(body.profile.getString("move"))
            val stand=body.clips.getValue(body.profile.getString("stand"))
            val scene=scene(count=1).copy(campTroops=listOf(RenderCampTroop("camp",0,actor.getString("type"),actor.getInt("level"),key)))
            val plan=assertNotNull(PreparedCampScene.prepare(scene,library,20000f))
            assertEquals(setOf(move.atlasPath,stand.atlasPath),plan.requiredAtlases)
            assertTrue(move.fps>0);assertTrue(move.frames.flatten().all {it.isNotEmpty()})
            assertFalse(move.flipX.any {it});assertFalse(stand.flipX.any {it})
        }
    }
    @Test fun `obsolete preparation cancels inside dense occupancy and route loops`() {
        var checkpoints=0
        val buildings=(0..100).map { RenderBuilding("wall$it","wall",(it%30).toFloat(),(it/30).toFloat(),1f,1f,type="wall") } + camp
        val scene=scene(buildings)
        assertFailsWith<java.util.concurrent.CancellationException> {
            PreparedCampScene.prepare(scene,mapOf("bowman" to art),20000f) { if(++checkpoints==20) throw java.util.concurrent.CancellationException() }
        }
        assertEquals(20,checkpoints);assertEquals(102,scene.buildings.size)
    }

    @Test fun `compact home clips own residency without changing authored body placement or cadence`() {
        val moveHome=move.copy(atlasPath="atlas/home.json",frames=move.frames.map {row->row.map {"home-$it"}})
        val standHome=stand.copy(atlasPath="atlas/home.json",frames=stand.frames.map {row->row.map {"home-$it"}})
        val compact=mapOf("bowman" to CampLocomotion(moveHome,standHome))
        val plan=assertNotNull(PreparedCampScene.prepare(scene(),emptyMap(),20000f,compact))
        assertEquals(setOf("atlas/home.json"),plan.requiredAtlases)
        val model=CampVisualModel();model.replace(plan);model.advance(3700f,false)
        assertTrue(sprites(model).all {it.frameKey.startsWith("home-") && it.width==32f*1.32f && it.anchorY==.9f})
        assertFailsWith<IllegalArgumentException> { PreparedCampScene.prepare(scene(),mapOf("bowman" to art),20000f,emptyMap()) }
    }

}
