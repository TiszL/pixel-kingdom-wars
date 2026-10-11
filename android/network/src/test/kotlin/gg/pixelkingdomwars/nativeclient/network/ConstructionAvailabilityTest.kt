package gg.pixelkingdomwars.nativeclient.network

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ConstructionAvailabilityTest {
    private val types = listOf("workshop", "lodge", "market", "harvester", "berth")
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    // Deliberately small fixture values: production tuning is never supplied by this helper.
    private val catalogue = buildJsonObject { put("constants", buildJsonObject {
        put("PHASE_E_BUILDINGS", buildJsonObject { put("types", JsonArray(types.map(::JsonPrimitive))) })
        put("BUILD_COSTS", buildJsonObject { types.forEach { put(it, json("""{"costShards":13,"buildSec":17,"requiresKeepLevel":3}""")) } })
        put("STRUCTURES", buildJsonObject { types.forEach { put(it, json("""{"hp":19,"maxLevel":2,"footprint":[2,1]}""")) } })
        put("BUILD_COUNT_CAP_BY_KEEP", buildJsonObject { types.forEach { put(it, JsonArray(listOf(0, 0, 1).map(::JsonPrimitive))) } })
    }) }
    private val render = buildJsonObject { put("entries", JsonArray(types.flatMap { type -> (1..2).map { level ->
        json("""{"type":"$type","level":$level,"phaseE":{"facility":"$type","tier":$level},"footprintWidth":2,"footprintHeight":1}""")
    } })) }
    private fun base(feature: JsonElement = buildJsonObject { put("version", 1); put("enabledTypes", JsonArray(types.map(::JsonPrimitive))) }) =
        buildJsonObject { put("features", buildJsonObject { put("phaseEBuildings", feature) }) }
    private fun table(name: String, replacement: JsonElement?) = JsonObject(catalogue + ("constants" to JsonObject(
        catalogue.getValue("constants").jsonObject.toMutableMap().apply { if (replacement == null) remove(name) else put(name, replacement) })))
    // Explicit test-only capability for these synthetic metadata/control-boundary fixtures.
    // It does not certify resident pixels; PhaseEConstructionArtAdmissionTest owns that contract.
    private val admittedArt = PhaseEConstructionArt { true }
    private fun choices(base: JsonObject? = base(), catalogue: JsonObject? = this.catalogue, render: JsonObject? = this.render,
        level: Int = 1, art: PhaseEConstructionArt? = admittedArt) =
        phaseEConstructionChoices(base, catalogue, render, level, art)

    @Test fun `metadata requires an explicit currently admitting art capability`() {
        assertTrue(choices(art = null).isEmpty())
        var current = false
        val art = PhaseEConstructionArt { current }
        assertTrue(choices(art = art).isEmpty())
        current = true
        assertEquals(types, choices(art = art))
        current = false
        assertTrue("A previously admitted callback is rechecked", choices(art = art).isEmpty())
        assertTrue(choices(art = PhaseEConstructionArt { throw IllegalStateException("fixture retired") }).isEmpty())
    }

    @Test fun `static frame and atlas rows never substitute for typed art markers`() {
        val entries = render.getValue("entries").jsonArray
        val legacy = JsonObject((entries.first().jsonObject - "phaseE") + mapOf(
            "frameKey" to JsonPrimitive("fixture_workshop_1"), "atlasPath" to JsonPrimitive("atlas/fixture.json")))
        assertEquals(types - "workshop", choices(render = JsonObject(render +
            ("entries" to JsonArray(listOf(legacy) + entries.drop(1))))))
    }

    @Test fun `new types require the server feature and both admitted catalogues`() {
        assertEquals(types, choices())
        assertTrue(choices(base = null).isEmpty()); assertTrue(choices(base = json("{}" )).isEmpty())
        assertTrue(choices(catalogue = null).isEmpty()); assertTrue(choices(render = null).isEmpty())
        assertTrue("The old shipped pack cannot be taught types by an enabled server alone", choices(catalogue = table("PHASE_E_BUILDINGS", null)).isEmpty())
    }

    @Test fun `unknown malformed and duplicate features fail closed without throwing`() {
        listOf("null", "[]", "true", "{}", """{"version":2,"enabledTypes":["workshop"]}""",
            """{"version":"1","enabledTypes":["workshop"]}""", """{"version":1,"enabledTypes":"workshop"}""",
            """{"version":1,"enabledTypes":["workshop",null]}""", """{"version":1,"enabledTypes":["workshop","futuretype"]}""",
            """{"version":1,"enabledTypes":["workshop","workshop"]}""").forEach {
            assertTrue(it, choices(base = base(Json.parseToJsonElement(it))).isEmpty())
        }
    }

    @Test fun `a pause or subset only changes new start discovery in canonical order`() {
        assertTrue(choices(base = base(json("""{"version":1,"enabledTypes":[]}"""))).isEmpty())
        assertEquals(listOf("workshop", "berth"), choices(base = base(json("""{"version":1,"enabledTypes":["berth","workshop"]}"""))))
        assertTrue(constructionStartAvailable(null, null, null, "cannon"))
        assertTrue(constructionStartAvailable(null, null, null, "keep", 2))
        assertFalse(constructionStartAvailable(base(), catalogue, render, "futuretype"))
    }

    @Test fun `a malformed generated type declaration never widens the legacy list`() {
        listOf("{}", """{"types":["workshop","workshop"]}""", """{"types":["workshop",false]}""",
            """{"types":["cannon","workshop"]}""").forEach {
            assertTrue(choices(catalogue = table("PHASE_E_BUILDINGS", json(it))).isEmpty())
        }
    }

    @Test fun `an incomplete economic table hides starts instead of inventing tuning`() {
        listOf("BUILD_COSTS", "STRUCTURES", "BUILD_COUNT_CAP_BY_KEEP").forEach { assertTrue(it, choices(catalogue = table(it, null)).isEmpty()) }
        val costs = catalogue.getValue("constants").jsonObject.getValue("BUILD_COSTS").jsonObject
        listOf("{}", """{"costShards":13,"buildSec":17}""", """{"costShards":-1,"buildSec":17,"requiresKeepLevel":3}""").forEach {
            val withoutWorkshop = table("BUILD_COSTS", JsonObject(costs + ("workshop" to json(it))))
            assertEquals(types - "workshop", choices(catalogue = withoutWorkshop))
        }
        assertEquals(BaseOrderPrice("SHARDS", "13", "17"), buildingPrice(catalogue, base(), "workshop"))
        assertEquals(BuildCount(0, 1, null, false), buildCountPresentation(catalogue, "workshop", 3, emptyList()))
    }

    @Test fun `incomplete or invalid cap and footprint tables cannot use legacy defaults`() {
        val constants = catalogue.getValue("constants").jsonObject
        listOf("[]", "[0,null,1]", "[-1,0,1]").forEach { caps ->
            assertEquals(types - "workshop", choices(catalogue = table("BUILD_COUNT_CAP_BY_KEEP",
                JsonObject(constants.getValue("BUILD_COUNT_CAP_BY_KEEP").jsonObject + ("workshop" to Json.parseToJsonElement(caps))))))
        }
        listOf("[]", "[2]", "[0,1]").forEach { footprint ->
            val structure = JsonObject(constants.getValue("STRUCTURES").jsonObject.getValue("workshop").jsonObject + ("footprint" to Json.parseToJsonElement(footprint)))
            assertEquals(types - "workshop", choices(catalogue = table("STRUCTURES", JsonObject(constants.getValue("STRUCTURES").jsonObject + ("workshop" to structure)))))
        }
    }

    @Test fun `exact level art is required for placement and the next upgrade`() {
        val entries = render.getValue("entries").jsonArray
        val missing = JsonObject(render + ("entries" to JsonArray(entries.filterNot { it.jsonObject.string("type") == "workshop" && it.jsonObject.string("level") == "2" })))
        assertEquals(types, choices(render = missing))
        assertEquals(types - "workshop", choices(render = missing, level = 2))
        assertTrue(choices(level = 3).isEmpty())
        assertTrue(choices(level = 0).isEmpty())
    }

    @Test fun `cap admission uses the same integer range as the displayed count table`() {
        val caps = catalogue.getValue("constants").jsonObject.getValue("BUILD_COUNT_CAP_BY_KEEP").jsonObject
        val tooLarge = JsonPrimitive(Int.MAX_VALUE.toLong() + 1)
        val invalid = table("BUILD_COUNT_CAP_BY_KEEP", JsonObject(caps + ("workshop" to JsonArray(listOf(JsonPrimitive(0), JsonPrimitive(0), tooLarge)))))
        assertEquals("The display parser would otherwise drop the overflowing entry and read the wrong cap", 0,
            buildCountPresentation(invalid, "workshop", 3, emptyList())!!.max)
        assertEquals(types - "workshop", choices(catalogue = invalid))
        val maximumCap = JsonArray(listOf(JsonPrimitive(Int.MAX_VALUE)))
        val boundary = table("BUILD_COUNT_CAP_BY_KEEP", JsonObject(caps + ("workshop" to maximumCap)))
        assertEquals(types, choices(catalogue = boundary))
        assertEquals(Int.MAX_VALUE, buildCountPresentation(boundary, "workshop", 3, emptyList())!!.max)
    }

    @Test fun `Keep gates maximum levels and footprints cannot overflow their downstream integer parsers`() {
        val constants = catalogue.getValue("constants").jsonObject
        val tooLarge = JsonPrimitive(Int.MAX_VALUE.toLong() + 1)
        listOf("BUILD_COSTS" to "requiresKeepLevel", "STRUCTURES" to "maxLevel").forEach { (name, field) ->
            val rows = constants.getValue(name).jsonObject
            val row = JsonObject(rows.getValue("workshop").jsonObject + (field to tooLarge))
            assertEquals(field, types - "workshop", choices(catalogue = table(name, JsonObject(rows + ("workshop" to row)))))
        }
        val structures = constants.getValue("STRUCTURES").jsonObject
        val row = JsonObject(structures.getValue("workshop").jsonObject + ("footprint" to JsonArray(listOf(tooLarge, JsonPrimitive(1)))))
        val invalid = table("STRUCTURES", JsonObject(structures + ("workshop" to row)))
        val entries = render.getValue("entries").jsonArray
        val matchingArt = JsonObject(render + ("entries" to JsonArray(entries.map {
            if (it.jsonObject.string("type") == "workshop") JsonObject(it.jsonObject + ("footprintWidth" to tooLarge)) else it
        })))
        assertEquals("Even matching art cannot make an overflowing footprint safe", types - "workshop", choices(catalogue = invalid, render = matchingArt))
        // Build duration is read as Long by the tray, so its legitimate range is not narrowed to Int.
        val costs = constants.getValue("BUILD_COSTS").jsonObject
        val longDuration = table("BUILD_COSTS", JsonObject(costs + ("workshop" to JsonObject(costs.getValue("workshop").jsonObject + ("buildSec" to tooLarge)))))
        assertEquals(types, choices(catalogue = longDuration))
    }

    @Test fun `duplicate absent or mismatched scene art never gets a fallback`() {
        val entries = render.getValue("entries").jsonArray
        assertEquals(types - "workshop", choices(render = JsonObject(render + ("entries" to JsonArray(entries + entries.first())))))
        // The typed marker replaces both legacy static art fields; both footprint axes remain required.
        listOf("phaseE", "footprintWidth", "footprintHeight").forEach { field ->
            val incomplete = JsonObject(entries.first().jsonObject - field)
            assertEquals(types - "workshop", choices(render = JsonObject(render + ("entries" to JsonArray(listOf(incomplete) + entries.drop(1))))))
        }
        val mismatch = JsonObject(entries.first().jsonObject + ("footprintHeight" to JsonPrimitive(9)))
        assertEquals(types - "workshop", choices(render = JsonObject(render + ("entries" to JsonArray(listOf(mismatch) + entries.drop(1))))))
    }

    @Test fun `scene art keys must be actual JSON strings instead of coerced primitive text`() {
        // Retain every malformed-field refusal from the original test. The restored contract
        // additionally refuses valid strings and motion: ANY legacy fallback field is forbidden.
        val entries = render.getValue("entries").jsonArray
        listOf("frameKey", "atlasPath", "motion").forEach { field ->
            listOf("true", "27", "null", "{}", "[]", "\"\"", "\"   \"", "\"fixture-valid-string\"").forEach { raw ->
                val invalid = JsonObject(entries.first().jsonObject + (field to Json.parseToJsonElement(raw)))
                assertEquals("$field=$raw", types - "workshop", choices(render = JsonObject(render + ("entries" to JsonArray(listOf(invalid) + entries.drop(1))))))
            }
        }
    }

    @Test fun `service labels keep the complete owner approved names`() {
        assertEquals("EXPLORATION LODGE", trayLabel("lodge")); assertEquals("REALM HARVESTER", trayLabel("harvester"))
        assertEquals("WORKSHOP", trayLabel("workshop")); assertEquals("MARKET", trayLabel("market")); assertEquals("BERTH", trayLabel("berth"))
    }
}
