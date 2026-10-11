package gg.pixelkingdomwars.nativeclient.scene

import gg.pixelkingdomwars.nativeclient.renderer.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CampSceneMapperTest {
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private val catalogue = json("""{"constants":{"AMBIENCE":{"garrisonMaxPerCamp":6,"garrisonSpeedPxPerSec":20,"garrisonWanderPadTiles":0.4,"garrisonPauseMinMs":700,"garrisonPauseMaxMs":2400,"walkerDetourSearchTiles":3,"walkerRouteRetries":6,"garrisonScale":0.66},"BATTLE_SCALE":{"troop":0.66}}}""")
    private val render = json("""{"basePresentation":{"tilePixels":64},"actors":[{"type":"bowman","level":1,"frameKey":"bowman1"},{"type":"dragon","level":20,"frameKey":"dragon20"},{"type":"dragon","level":19,"frameKey":"dragon19"}]}""")
    private fun camp(id: String, constructing: Boolean = false) = RenderBuilding(id,"camp",4f,4f,2f,2f,type="camp",underConstruction=constructing)
    @Test fun `large ready army deals at most visible camp seats with real levels and no expanded counts`() {
        val base = json("""{"army":[{"troop":"dragon","count":2147483647,"level":20},{"troop":"bowman","count":2147483647,"level":1}]}""")
        var work = 0
        val (troops, rules) = mapCampTroops(base, listOf(camp("b"),camp("a"),camp("unfinished",true)), catalogue, render) { work++ }
        assertEquals(12,troops.size); assertTrue(work <= 12)
        assertEquals(listOf("a","b","a","b"),troops.take(4).map { it.campId })
        assertEquals(listOf("bowman","dragon","bowman","dragon"),troops.take(4).map { it.troop })
        assertTrue(troops.filter { it.troop=="dragon" }.all { it.level==20 && it.frameKey=="dragon20" })
        assertEquals(6,troops.count { it.campId=="a" }); assertEquals(1f,rules!!.scaleRatio)
    }
    @Test fun `row reorder does not respawn seats while casualties training and levels change only the authoritative roster`() {
        fun base(dragon: Int, level: Int, reversed: Boolean = false): JsonObject {
            val rows = listOf("""{"troop":"dragon","count":$dragon,"level":$level}""", """{"troop":"bowman","count":1,"level":1}""")
            return json("""{"army":[${(if(reversed) rows.reversed() else rows).joinToString(",")}]}""")
        }
        val camps = listOf(camp("a"),camp("b"))
        val original = mapCampTroops(base(2,20),camps,catalogue,render).first
        assertEquals(original,mapCampTroops(base(2,20,true),camps.reversed(),catalogue,render).first)
        assertEquals(2,mapCampTroops(base(1,20),camps,catalogue,render).first.size)
        assertEquals(5,mapCampTroops(base(4,20),camps,catalogue,render).first.size)
        assertEquals("dragon19",mapCampTroops(base(1,19),camps,catalogue,render).first.single { it.troop=="dragon" }.frameKey)
        assertTrue(mapCampTroops(json("""{"army":[]}"""),camps,catalogue,render).first.isEmpty())
        assertTrue(mapCampTroops(base(2,20),listOf(camp("a",true)),catalogue,render).first.isEmpty())
    }
    @Test fun `missing authoritative level is not replaced with an invented troop level`() {
        val error = runCatching { mapCampTroops(json("""{"army":[{"troop":"dragon","count":1}]}"""),listOf(camp("a")),catalogue,render) }.exceptionOrNull()
        assertNotNull(error); assertTrue(error!!.message!!.contains("level is missing"))
    }
    @Test fun `declared compact catalogue must contain every visible camp body`() {
        val base=json("""{"army":[{"troop":"dragon","count":1,"level":20}]}""")
        val missing=JsonObject(render+mapOf("campPresentation" to json("""{"version":1,"actors":{}}""")))
        assertNotNull(runCatching {mapCampTroops(base,listOf(camp("a")),catalogue,missing)}.exceptionOrNull())
        val valid=JsonObject(render+mapOf("campPresentation" to json("""{"version":1,"actors":{"dragon20":{"move":{},"stand":{}}}}""")))
        assertEquals("dragon20",mapCampTroops(base,listOf(camp("a")),catalogue,valid).first.single().frameKey)
    }

}
