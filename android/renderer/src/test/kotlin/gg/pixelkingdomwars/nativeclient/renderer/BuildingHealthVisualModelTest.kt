package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import org.junit.Test
import kotlin.test.*

class BuildingHealthVisualModelTest {
    private fun building(id: String="wall", initial: Long?=100L, max: Long?=100L)=RenderBuilding(id,"wall",0f,0f,1f,1f,initial,max)
    private fun event(json: String)=PresentationEvent.fromJson(json)
    private fun hit(t: Int, damage: Int)=event("""{"t":$t,"e":"hit","target":"wall","dmg":$damage}""")
    @Test fun `display health uses only canonical hits and the supplied strict threshold`() {
        val events=listOf(hit(2,50),hit(3,1),hit(4,20),event("""{"t":5,"e":"destroyed","id":"wall"}"""),hit(6,7))
        val model=BuildingHealthVisualModel(listOf(building()),events,.5f)
        assertNull(model.at("wall",2f)!!.damagedSinceTick,"Exactly half is not canonical damage state")
        assertEquals(3,model.at("wall",3f)!!.damagedSinceTick)
        assertEquals(29L,model.at("wall",4f)!!.hp)
        assertEquals(3,model.at("wall",4f)!!.damagedSinceTick,"Further hits do not restart authored damage loop")
        assertEquals(0L,model.at("wall",6f)!!.hp)
        assertEquals(100L,model.at("wall",0f)!!.hp)
        assertNull(BuildingHealthVisualModel(listOf(building()),events,.25f).at("wall",4f)!!.damagedSinceTick)
        assertNull(BuildingHealthVisualModel(listOf(building()),events,null).at("wall",4f)!!.damagedSinceTick)
    }
    @Test fun `event ordinal excludes later same-tick damage and destruction while tick view keeps final state`() {
        val events=listOf(event("""{"e":"noop","t":3}"""),hit(3,50),hit(3,1),event("""{"t":3,"e":"destroyed","id":"wall"}"""))
        val model=BuildingHealthVisualModel(listOf(building()),events,.5f)
        assertEquals(100L,model.afterEvent("wall",0)!!.hp)
        assertEquals(50L,model.afterEvent("wall",1)!!.hp);assertNull(model.afterEvent("wall",1)!!.damagedSinceTick)
        assertEquals(49L,model.afterEvent("wall",2)!!.hp);assertEquals(3,model.afterEvent("wall",2)!!.damagedSinceTick)
        assertEquals(0L,model.at("wall",3f)!!.hp)
        assertNull(model.afterEvent("missing",2))
        assertNull(BuildingHealthVisualModel(listOf(building(initial=null,max=null)),events,.5f).afterEvent("wall",2))
    }
    @Test fun `unknown health stays unknown and numeric troop targets cannot damage string building identities`() {
        val troop=event("""{"t":1,"e":"hit","target":1,"dmg":99}""")
        assertEquals(100L,BuildingHealthVisualModel(listOf(building("1")),listOf(troop),.5f).at("1",1f)!!.hp)
        assertNull(BuildingHealthVisualModel(listOf(building(initial=null,max=null)),listOf(hit(1,80)),.5f).at("wall",2f))
        assertNull(BuildingHealthVisualModel(listOf(building(initial=0,max=0)),emptyList(),.5f).at("wall",0f)!!.damagedSinceTick)
        assertFailsWith<IllegalArgumentException> { BuildingHealthVisualModel(listOf(building(initial=101)),emptyList(),.5f) }
        assertFailsWith<IllegalArgumentException> { BuildingHealthVisualModel(listOf(building()),listOf(hit(2,1),hit(1,1)),.5f) }
        assertFailsWith<IllegalArgumentException> { BuildingHealthVisualModel(listOf(building()),listOf(event("""{"t":1,"e":"hit","target":"wall","dmg":1.5}""")),.5f) }
    }
    @Test fun `damaged wall retile restarts the authored row and seeking or replacement restores the right phase`() {
        val root=System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
        val render=JsonReader().parse(root.resolve("render-catalog.json").readText())
        val wallEntries=render.get("walls").filter { it.getInt("level")==1 }
        fun wall(id: String,x: Float)=building(id).copy(frameKey=wallEntries.first { it.getInt("mask")==10 }.getString("frameKey"),tileX=x)
        val buildings=listOf(wall("wall",2f),wall("neighbour",3f))
        val breach=event("""{"t":4,"e":"destroyed","id":"neighbour"}""")
        val destroyed=event("""{"t":8,"e":"destroyed","id":"wall"}""")
        val events=listOf(hit(1,51),breach,destroyed)
        val catalogue=WallCatalogue(render);val library=CombatArt.catalogue(render)
        fun plan(e: List<PresentationEvent>): CombatVisualPlan {
            val scene=BattleScene(BaseScene(buildings,8,8,64f),PresentationRevision("r","v",14,0,0,e),emptyMap(),256f,100f,1,1)
            return CombatVisualPlan(scene,BattleVisualModel(e,1),library,.5f)
        }
        val model=WallVisualModel(buildings,catalogue,events);val p=plan(events)
        fun sprite(t: Float)=p.building("wall",t,frameKey=model.frameAt("wall",t),frameSinceTick=model.frameSinceTick("wall",t) ?: 0)
        val connected=library.getValue(model.frameAt("wall",3f)!!).clips.getValue("damaged")
        assertEquals(connected.frame(200f,0,true),sprite(3f)!!.frameKey)
        val separated=library.getValue(model.frameAt("wall",4f)!!).clips.getValue("damaged")
        assertEquals(separated.frames[0][0],sprite(4f)!!.frameKey,"Breach changes the mask and restarts its authored damage row")
        assertTrue(sprite(8f)!!.frameKey in library.getValue(model.frameAt("wall",8f)!!).clips.getValue("collapse").frames.flatten())
        assertEquals(connected.frame(200f,0,true),sprite(3f)!!.frameKey)
        assertNull(plan(emptyList()).building("wall",3f,frameKey=model.frameAt("wall",3f)),"Removed damage prediction returns to canonical healthy alias")
        val afterBreach=listOf(breach,hit(5,51))
        val afterModel=WallVisualModel(buildings,catalogue,afterBreach)
        assertEquals(separated.frames[0][0],plan(afterBreach).building("wall",5f,frameKey=afterModel.frameAt("wall",5f),frameSinceTick=4)!!.frameKey)
        val scene=BattleScene(BaseScene(buildings,8,8,64f),PresentationRevision("wall-damage","fixture",14,0,0,events),emptyMap(),256f,100f,1,1)
        val visual=BattleVisualModel(events,1)
        val authored=CombatVisualPlan(scene,visual,library,render.getFloat("buildingDamageThreshold"))
        for(tick in listOf(0f,3f,4f,8f))
            CpuCombatProof(root).write(scene,visual,authored,render,tick,"wall_damage_tick_$tick",model)
    }
}
