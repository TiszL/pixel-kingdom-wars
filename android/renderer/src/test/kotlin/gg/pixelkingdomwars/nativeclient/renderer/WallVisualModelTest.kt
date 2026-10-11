package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.File
import org.junit.Test
import kotlin.test.*

class WallVisualModelTest {
    private val root = File("../app/src/main/assets/native")
    private val render = JsonReader().parse(root.resolve("render-catalog.json").readText())
    private val catalogue = WallCatalogue(render)
    private fun wall(id: String,x: Int,y: Int,level: Int=1): RenderBuilding {
        val entry=render.get("walls").first { it.getInt("level")==level && it.getInt("mask")==10 }
        return RenderBuilding(id,entry.getString("frameKey"),x.toFloat(),y.toFloat(),entry.getFloat("footprintWidth"),entry.getFloat("footprintHeight"))
    }
    private fun breach(tick: Int,id: String) = PresentationEvent.fromJson("""{"t":$tick,"e":"destroyed","id":"$id"}""")
    private fun expected(mask: Int,level: Int=1) = render.get("walls").first { it.getInt("mask")==mask && it.getInt("level")==level }.getString("frameKey")

    @Test fun `every authored junction uses orthogonal mixed tier neighbours and ignores buildings and diagonals`() {
        val directions=listOf(0 to -1,1 to 0,0 to 1,-1 to 0)
        for(mask in 0..15) {
            val buildings=mutableListOf(wall("center",4,4,11),wall("diagonal",5,5))
            directions.forEachIndexed { bit,(x,y) ->
                buildings += if(mask and (1 shl bit)!=0) wall("n$bit",4+x,4+y,6)
                    else RenderBuilding("other$bit","bld_keep_l1",(4+x).toFloat(),(4+y).toFloat(),1f,1f)
            }
            assertEquals(expected(mask,11),WallVisualModel(buildings,catalogue).frameAt("center",0f),"canonical N/E/S/W mask $mask")
        }
    }

    @Test fun `breach retiles surviving ends and freezes dying row through forward and backward seeking`() {
        val buildings=listOf(wall("a",2,3),wall("b",3,3),wall("c",4,3))
        val model=WallVisualModel(buildings,catalogue,listOf(breach(10,"b")))
        assertEquals(expected(2),model.frameAt("a",9f)); assertEquals(expected(10),model.frameAt("b",9f))
        assertEquals(expected(0),model.frameAt("a",10f)); assertEquals(expected(0),model.frameAt("c",10f))
        assertEquals(expected(10),model.frameAt("b",100f),"collapse preserves pre-breach row")
        assertEquals(expected(2),model.frameAt("a",0f),"seek reconstructs prior occupancy")
        val replacement=WallVisualModel(buildings,catalogue,listOf(breach(10,"a")))
        assertEquals(expected(2),replacement.frameAt("b",10f),"replacement must discard previous breach")
    }

    @Test fun `same tick canonical order changes second collapse piece without changing first`() {
        val buildings=listOf(wall("a",2,3),wall("b",3,3),wall("c",4,3))
        val ab=WallVisualModel(buildings,catalogue,listOf(breach(10,"a"),breach(10,"b")))
        val ba=WallVisualModel(buildings,catalogue,listOf(breach(10,"b"),breach(10,"a")))
        assertEquals(expected(2),ab.frameAt("b",10f)); assertEquals(expected(10),ba.frameAt("b",10f))
        assertEquals(expected(2),ab.frameAt("a",10f)); assertEquals(expected(0),ba.frameAt("a",10f))
        assertEquals(expected(0),ab.frameAt("c",10f))
    }

    @Test fun `base move removal and invalid inputs cannot retain stale topology`() {
        val a=wall("a",2,3);val b=wall("b",3,3)
        assertEquals(expected(2),WallVisualModel(listOf(a,b),catalogue).frameAt("a",0f))
        assertEquals(expected(0),WallVisualModel(listOf(a,b.copy(tileY=4f)),catalogue).frameAt("a",0f))
        assertFailsWith<IllegalArgumentException> { WallVisualModel(listOf(a,b.copy(tileX=2f)),catalogue) }
        assertFailsWith<IllegalArgumentException> { WallVisualModel(listOf(a,b),catalogue,listOf(breach(10,"a"),breach(9,"b"))) }
        assertFailsWith<IllegalArgumentException> { WallCatalogue(JsonReader().parse("""{"walls":[{"level":1,"mask":0,"frameKey":"wall"}]}""")) }
    }

    @Test fun `real connected art and collapse rows render from the same timeline used on GL`() {
        val buildings=mutableListOf<RenderBuilding>()
        for(mask in 0..15) {
            val x=2+(mask%4)*6; val y=2+(mask/4)*6
            buildings+=wall("center$mask",x,y,1+(mask/4)*5)
            listOf(0 to -1,1 to 0,0 to 1,-1 to 0).forEachIndexed { bit,(dx,dy) ->
                if(mask and (1 shl bit)!=0) buildings+=wall("$mask-$bit",x+dx,y+dy,1+(mask/4)*5)
            }
        }
        val events=listOf(breach(10,"center15"))
        val walls=WallVisualModel(buildings,catalogue,events)
        val presentation=JsonReader().parse(root.resolve("catalogue.json").readText()).get("presentation")
        val scene=BattleScene(BaseScene(buildings,24,24,presentation.getFloat("tilePixels")),
            PresentationRevision("walls","proof",14,0,0,events),emptyMap(),presentation.getFloat("unitsPerTile"),presentation.getFloat("tickMs"),1,1)
        val model=BattleVisualModel(events,1,1);val library=CombatArt.catalogue(render)
        val plan=CombatVisualPlan(scene,model,library)
        for(b in buildings) for(tick in listOf(0f,11f,50f)) {
            val frame=walls.frameAt(b.id,tick)!!
            assertNotNull(library[frame],"all admitted connection rows have authored combat art")
            val sprite=plan.building(b.id,tick,frameKey=frame)
            if(model.isDestroyed(b.id,tick)) {
                assertNotNull(sprite)
                assertTrue(sprite.frameKey in library.getValue(frame).clips.getValue("collapse").frames.flatten())
            } else assertNull(sprite,"Canonical healthy walls use a static connection alias, not an invented idle loop")
        }
        val proof=CpuCombatProof(root)
        proof.write(scene,model,plan,render,0f,"wall_connections_all_masks",walls)
        proof.write(scene,model,plan,render,11f,"wall_connections_breach",walls)
    }
}
