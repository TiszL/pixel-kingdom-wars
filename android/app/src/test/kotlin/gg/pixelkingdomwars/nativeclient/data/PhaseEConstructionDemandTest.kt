package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.constructionStartAvailable
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** Metadata demand is not residency or action authority; real IW3 dependency staged by the content pipeline. */
class PhaseEConstructionDemandTest {
    private fun fixture(name: String) = Json.parseToJsonElement(requireNotNull(javaClass.getResourceAsStream("/iw3/$name"))
        .use { it.readBytes().decodeToString() }).jsonObject
    private val catalogue by lazy { fixture("catalogue.json") }
    private val render by lazy { fixture("render-catalog.json") }
    private fun building(id: String = "selected", type: String = "workshop", level: Int = 1, constructing: Boolean = false) = buildJsonObject {
        put("id",id); put("type",type); put("level",level); put("underConstruction",constructing)
    }
    private fun base(types: List<String> = listOf("workshop","lodge"), buildings: List<JsonObject> = emptyList(), version: Int = 1) = buildJsonObject {
        put("baseId","00000000-0000-4000-8000-000000000001")
        put("features",buildJsonObject { put("phaseEBuildings",buildJsonObject {
            put("version",version); put("enabledTypes",JsonArray(types.map(::JsonPrimitive)))
        }) })
        put("buildings",JsonArray(buildings))
    }
    @Test fun `placement demand is bounded to current advertised types and exact level one rows`() {
        val base = base(); val requests = phaseEConstructionRequests(base,catalogue,render,null)
        assertEquals(listOf("workshop","lodge"),requests.map { it.type })
        assertTrue(requests.all { it.level == 1 && it.buildingId == null })
        assertTrue(requests.all { it.base === base && it.catalogue === catalogue && it.renderCatalogue === render })
        assertFalse(constructionStartAvailable(base,catalogue,render,"workshop"))
    }
    @Test fun `only exact selected completed building adds one next level request`() {
        val base = base(buildings=listOf(building(),building("other","lodge",2)))
        val requests = phaseEConstructionRequests(base,catalogue,render,"selected")
        val upgrade = requests.filter { it.buildingId != null }.single()
        assertEquals("selected",upgrade.buildingId); assertEquals("workshop",upgrade.type); assertEquals(2,upgrade.level)
        assertEquals(3,requests.size)
    }
    @Test fun `unknown duplicate incomplete and maximum level selections cannot acquire upgrade art`() {
        for (buildings in listOf(emptyList(),listOf(building(),building()),
            listOf(building(constructing=true)),listOf(building(level=Int.MAX_VALUE)))) {
            val requests = phaseEConstructionRequests(base(buildings=buildings),catalogue,render,"selected")
            assertTrue(requests.none { it.buildingId != null })
        }
    }
    @Test fun `missing or future feature and missing content produce no demand`() {
        assertTrue(phaseEConstructionRequests(null,catalogue,render,null).isEmpty())
        assertTrue(phaseEConstructionRequests(base(),null,render,null).isEmpty())
        assertTrue(phaseEConstructionRequests(base(),catalogue,null,null).isEmpty())
        assertTrue(phaseEConstructionRequests(base(version=2),catalogue,render,null).isEmpty())
        assertTrue(phaseEConstructionRequests(base(types=emptyList()),catalogue,render,null).isEmpty())
    }
    @Test fun `ambiguous render row is not retained as a construction request`() {
        val entries = render.getValue("entries").jsonArray
        val row = entries.single { it.jsonObject["type"] == JsonPrimitive("workshop") && it.jsonObject["level"] == JsonPrimitive(1) }
        val ambiguous = JsonObject(render + ("entries" to JsonArray(entries + row)))
        assertEquals(listOf("lodge"),phaseEConstructionRequests(base(),catalogue,ambiguous,null).map { it.type })
    }
    @Test fun `changing selected building never expands placement demand to every tier or realm`() {
        val base = base(buildings=listOf(building(),building("other","lodge",2)))
        val before = phaseEConstructionRequests(base,catalogue,render,"selected")
        val after = phaseEConstructionRequests(base,catalogue,render,"other")
        assertEquals(before.filter { it.buildingId == null },after.filter { it.buildingId == null })
        assertEquals("other",after.single { it.buildingId != null }.buildingId)
        assertEquals(3,after.single { it.buildingId != null }.level)
    }
}
