package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import org.junit.Test
import kotlin.test.*

class BuildingSpawnWorkTest {
    private val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val render = JsonReader().parse(root.resolve("render-catalog.json").readText())
    private val library = CombatArt.catalogue(render)
    private val frame = render.get("entries").first { it.getString("type") == "dragonnest" && it.getInt("level") == 20 }.getString("frameKey")
    private val art = library.getValue(frame).copy(spawnWork = SpawnWorkArt("work",500f))
    private fun plan(events: List<String>, legacy: Boolean = false, cold:Float?=null): CombatVisualPlan {
        val buildings = listOf("nest", "other").map { RenderBuilding(it,frame,0f,0f,3f,3f,100L,100L,"dragonnest") }
        val parsed = events.map(PresentationEvent::fromJson)
        val scene = BattleScene(BaseScene(buildings,10,10,64f),PresentationRevision("nest","fixture",14,0,0,parsed),emptyMap(),256f,100f,1,1,
            presentationStart=cold?.let { BattlePresentationStart.ColdPrefix(it) } ?: BattlePresentationStart.Continuous)
        return CombatVisualPlan(scene,BattleVisualModel(parsed,1),mapOf(frame to if(legacy)library.getValue(frame).copy(spawnWork=null) else art),.5f)
    }
    private fun spawn(t: Int, id: Int = 1, from: String = "nest") = """{"t":$t,"e":"spawn","id":$id,"troop":"wyrmling","from":"$from","x":256,"y":256}"""
    private fun isState(p: CombatVisualPlan,t: Float,state: String,id: String = "nest") {
        assertTrue(p.building(id,t)!!.frameKey in art.clips.getValue(state).frames.flatten(), "$id at $t should use $state")
    }
    @Test fun `canonical nest spawn animates only its source for the admitted work window`() {
        val p = plan(listOf(spawn(10)))
        isState(p,9.99f,"idle"); isState(p,10f,"work"); isState(p,14.99f,"work"); isState(p,15f,"idle")
        isState(p,11f,"idle","other")
        isState(p,10f,"work")
        isState(plan(emptyList()),11f,"idle")
        isState(plan(listOf(spawn(10,from="missing"))),11f,"idle")
        isState(plan(listOf(spawn(10)),legacy=true),11f,"idle")
        isState(plan(listOf(spawn(10)),cold=11f),11f,"idle")
        isState(plan(listOf(spawn(10)),cold=10f),10f,"work")
    }
    @Test fun `spawn does not override damaged or destroyed defense art and overlapping callbacks preserve the first stop`() {
        val hit = """{"t":9,"e":"hit","target":"nest","dmg":51}"""
        isState(plan(listOf(hit,spawn(10))),11f,"damaged")
        val death = """{"t":9,"e":"destroyed","id":"nest"}"""
        isState(plan(listOf(death,spawn(10))),11f,"collapse")
        val overlap = plan(listOf(spawn(10),spawn(12,2)))
        isState(overlap,14.99f,"work"); isState(overlap,15f,"idle"); isState(overlap,17f,"idle")
        assertEquals(overlap.building("nest",13f),plan(listOf(spawn(10))).building("nest",13f),"Second spawn preserves the original work loop phase")
        isState(plan(listOf(spawn(10),spawn(15,2))),15f,"idle")
    }
}
