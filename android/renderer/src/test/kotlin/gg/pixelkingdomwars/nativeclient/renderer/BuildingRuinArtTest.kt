package gg.pixelkingdomwars.nativeclient.renderer

import com.badlogic.gdx.utils.JsonReader
import java.io.DataInputStream
import java.io.File
import org.junit.Test
import kotlin.test.*

/** Mirrors web `apps/web/src/game/ware/ruin.test.ts` + the ticker `hold` cases. WHY: the camp
 * pack's collapse sinks into a dirt sliver (owner 2026-09-17 "camp destroyed state looks awful");
 * the ruin must appear only after the authored sink has played in full, only for the camp, and
 * must share the pack cell so the seat set from the collapse frame stays valid. */
class BuildingRuinArtTest {
    private val root = System.getenv("PKW_COMBAT_PACK")?.let(::File) ?: File("../app/src/main/assets/native")
    private val render = JsonReader().parse(root.resolve("render-catalog.json").readText())
    private val library = CombatArt.catalogue(render)
    private fun frame(type: String, level: Int) =
        render.get("entries").first { it.getString("type") == type && it.getInt("level") == level }.getString("frameKey")
    private val camp = frame("camp", 1); private val nest = frame("dragonnest", 20)
    private fun plan(events: List<String>): CombatVisualPlan {
        val buildings = listOf(RenderBuilding("camp",camp,0f,0f,2f,2f,100L,100L,"camp"), RenderBuilding("nest",nest,4f,0f,3f,3f,100L,100L,"dragonnest"))
        val parsed = events.map(PresentationEvent::fromJson)
        val scene = BattleScene(BaseScene(buildings,10,10,64f),PresentationRevision("camp","fixture",14,0,0,parsed),emptyMap(),256f,100f,1,1)
        return CombatVisualPlan(scene,BattleVisualModel(parsed,1),mapOf(camp to library.getValue(camp), nest to library.getValue(nest)),.5f)
    }
    private val collapse = library.getValue(camp).clips.getValue("collapse")

    @Test fun `camp rests on the ruin cell only after its authored sink has played in full`() {
        val p = plan(listOf("""{"t":9,"e":"destroyed","id":"camp"}""", """{"t":9,"e":"destroyed","id":"nest"}"""))
        assertNull(p.building("camp",8.99f)!!.ruin)
        val sinking = p.building("camp",9f)!!
        assertEquals(collapse.frames.first().first(), sinking.frameKey); assertNull(sinking.ruin)
        val lastAuthoredTick = 9f + (collapse.durationMs - 1f) / 100f
        val held = p.building("camp",lastAuthoredTick)!!
        assertEquals(collapse.frames.first().last(), held.frameKey); assertNull(held.ruin, "the sink must finish before the ruin")
        val ruined = p.building("camp",9f + (collapse.durationMs + 1f) / 100f)!!
        assertEquals(BuildingRuinArt.CAMP, ruined.ruin)
        assertEquals(collapse.frames.first().last(), ruined.frameKey, "seat stays on the collapse cell the ruin replaces")
        assertEquals(held.copy(ruin = BuildingRuinArt.CAMP), ruined)
        assertEquals(BuildingRuinArt.CAMP, p.building("camp",600f)!!.ruin)
        assertNull(p.building("nest",60f)!!.ruin, "authored rubble stays authored")
    }

    @Test fun `only the camp has a generated rest cell and it ships in the renderer classpath at the pack cell size`() {
        assertEquals(BuildingRuinArt.CAMP, BuildingRuinArt.forBuilding("camp", "bld_camp_l7"))
        assertEquals(BuildingRuinArt.CAMP, BuildingRuinArt.forBuilding(null, "bld_camp_l20"))
        assertNull(BuildingRuinArt.forBuilding("barracks", "bld_barracks_l1"))
        assertNull(BuildingRuinArt.forBuilding("mine", "bld_camp_l1"), "an explicit type wins over the frame prefix")
        val png = checkNotNull(javaClass.classLoader.getResourceAsStream(BuildingRuinArt.CAMP)) { "ruin cell missing from renderer resources" }
        DataInputStream(png).use { stream ->
            val signature = ByteArray(8); stream.readFully(signature)
            assertEquals(listOf(0x89, 0x50, 0x4E, 0x47), signature.take(4).map { it.toInt() and 0xFF })
            stream.skipBytes(8) // IHDR length + type
            assertEquals(collapse.cellWidth.toInt(), stream.readInt()); assertEquals(collapse.cellHeight.toInt(), stream.readInt())
        }
        assertEquals(104, collapse.cellWidth.toInt()); assertEquals(96, collapse.cellHeight.toInt())
    }
}
