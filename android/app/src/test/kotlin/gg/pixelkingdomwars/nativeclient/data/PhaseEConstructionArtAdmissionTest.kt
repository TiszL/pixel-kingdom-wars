package gg.pixelkingdomwars.nativeclient.data

import gg.pixelkingdomwars.nativeclient.network.*
import gg.pixelkingdomwars.nativeclient.renderer.ServiceAtlasGroup
import gg.pixelkingdomwars.nativeclient.renderer.RendererCatalogue
import com.badlogic.gdx.utils.JsonReader
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

/** Real BUILD metadata, fake explicit residency. This proves no bundled bytes or rendered button. */
class PhaseEConstructionArtAdmissionTest {
    private fun fixture(name: String, sha: String): JsonObject {
        val bytes = requireNotNull(javaClass.getResourceAsStream("/iw3/$name")).use { it.readBytes() }
        assertEquals(sha, MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) })
        return Json.parseToJsonElement(bytes.decodeToString()).jsonObject
    }
    private val catalogue = fixture("catalogue.json", "a844d2ee5322bc687eaaea2874eb87a7df9ef2b1775171397750dce56685a5a2")
    private val render = fixture("render-catalog.json", "f9eff00c5a8119e3aed0675d816ba5371d1634332f36a398b570c1c488988133")
    private val types = listOf("workshop", "lodge", "market", "harvester", "berth")
    private fun json(text: String) = Json.parseToJsonElement(text).jsonObject
    private fun base(realm: String = "frostveil") = json("""{
        "features":{"phaseEBuildings":{"version":1,"enabledTypes":["workshop","lodge","market","harvester","berth"]}},
        "visualContext":{"version":1,"realmId":"$realm","artVersion":2},"buildings":[]
    }""")
    private class Resident : PhaseEConstructionResidency {
        var current = true
        val missing = mutableSetOf<String>()
        val seen = mutableListOf<ServiceAtlasGroup>()
        override fun isCurrent() = current
        override fun contains(group: ServiceAtlasGroup): Boolean { seen += group; return group.id !in missing }
    }
    private fun admission(resident: Resident = Resident(), render: JsonObject = this.render) =
        preparePhaseEConstructionArt(catalogue, render, resident)
    private fun available(type: String, level: Int = 1, base: JsonObject = base(), resident: Resident = Resident(),
        render: JsonObject = this.render, buildingId: String? = null): Boolean =
        constructionStartAvailable(base, catalogue, render, type, level, admission(resident, render), buildingId)
    private fun mutateEntry(type: String, level: Int, change: (JsonObject) -> JsonObject): JsonObject =
        JsonObject(render + ("entries" to JsonArray(render.getValue("entries").jsonArray.map { raw ->
            val row = raw.jsonObject
            if (row["type"] == JsonPrimitive(type) && row["level"] == JsonPrimitive(level)) change(row) else row
        })))
    private val berthA = "00000000-0000-4000-8000-000000000001"
    private val berthB = "00000000-0000-4000-8000-000000000002"
    private fun berths(starter: String = "null", advanced: String = "null"): JsonObject = JsonObject(base() + json("""{
        "buildings":[{"id":"$berthA","type":"berth","level":5,"underConstruction":false}],
        "servicePresentation":{"version":1,"berths":[{"buildingId":"$berthA","installation":$starter}]},
        "advancedServicePresentation":{"version":1,"berths":[{"buildingId":"$berthA","installation":$advanced}]}
    }"""))

    private fun selectedBerth(base: JsonObject, id: String): String {
        val row = render.getValue("entries").jsonArray.map { it.jsonObject }.single {
            it["type"] == JsonPrimitive("berth") && it["level"] == JsonPrimitive(6)
        }
        val art = requireNotNull(RendererCatalogue.serviceArt(JsonReader().parse(render.toString())))
        return constructionAppearance(PhaseEConstructionArtRequest(base, catalogue, render, row, "berth", 6, id), art).id
    }

    @Test fun `actual marker rows admit all five choices with explicit resident proof`() {
        assertEquals(types, phaseEConstructionChoices(base(), catalogue, render, art = admission()))
    }
    @Test fun `all ordinary completed tiers resolve using exported level mapping`() {
        for (type in listOf("workshop", "lodge", "market", "harvester")) for (level in 1..20)
            assertTrue("$type:$level", available(type, level))
        assertFalse(available("workshop", 21))
    }
    @Test fun `every actual harvester family is selected only from its semantic base realm`() {
        val families = render.getValue("phaseE").jsonObject.getValue("metadata").jsonObject
            .getValue("peAppearances").jsonObject.values.map { it.jsonObject }
            .filter { it["facility"] == JsonPrimitive("harvester") }.map { it.getValue("family").jsonPrimitive.content }.toSet()
        assertEquals(8, families.size)
        for (realm in families) for (level in listOf(1, 6, 11, 16)) assertTrue(available("harvester", level, base(realm)))
        for (realm in listOf("unknown", "starter", "Frostveil", "", " frostveil")) assertFalse(available("harvester", base = base(realm)))
    }
    @Test fun `wrongly typed future or absent realm context is closed without a guessed realm`() {
        for (value in listOf<JsonElement>(JsonNull, JsonPrimitive("frostveil"), json("""{"version":1,"realmId":3,"artVersion":2}"""),
            json("""{"version":"1","realmId":"frostveil","artVersion":2}"""), json("""{"version":2,"realmId":"frostveil","artVersion":2}"""),
            json("""{"version":1,"realmId":"frostveil","artVersion":"2"}""")))
            assertFalse(available("harvester", base = JsonObject(base() + ("visualContext" to value))))
        assertFalse(available("harvester", base = JsonObject(base() - "visualContext")))
        assertTrue(available("workshop", base = JsonObject(base() - "visualContext")))
    }
    @Test fun `new berth explicitly selects starter art without claiming an installation`() {
        val resident = Resident()
        assertTrue(available("berth", resident = resident))
        assertTrue(resident.seen.any { it.id == "pe_fleet_berths" })
        assertFalse(available("berth", 2))
    }
    @Test fun `berth upgrade uses the exact selected installed advanced family`() {
        val resident = Resident()
        assertTrue(available("berth", 6, berths(advanced = """{"family":"cargo_cutter","tier":2,"presence":"occupied"}"""), resident, buildingId = berthA))
        assertEquals("cargo-cutter-berth", selectedBerth(berths(advanced = """{"family":"cargo_cutter","tier":2,"presence":"occupied"}"""), berthA))
    }
    @Test fun `empty and starter berths use starter appearance only after valid identity closure`() {
        for (starter in listOf("null", """{"family":"starter","presence":"occupied"}"""))
            assertTrue(available("berth", 6, berths(starter = starter), buildingId = berthA))
        assertFalse(available("berth", 6, berths(), buildingId = berthB))
        assertFalse(available("berth", 7, berths(), buildingId = berthA))
    }
    @Test fun `malformed unknown contradictory or missing berth facts never default to starter`() {
        for (advanced in listOf("""{"family":"unknown","tier":2,"presence":"occupied"}""",
            """{"family":"cargo_cutter","tier":"2","presence":"occupied"}""",
            """{"family":"cargo-cutter","tier":2,"presence":"occupied"}"""))
            assertFalse(available("berth", 6, berths(advanced = advanced), buildingId = berthA))
        assertFalse(available("berth", 6, berths("""{"family":"starter","presence":"occupied"}""",
            """{"family":"cargo_cutter","tier":2,"presence":"occupied"}"""), buildingId = berthA))
        assertFalse(available("berth", 6, JsonObject(berths() - "advancedServicePresentation"), buildingId = berthA))
        assertFalse(available("berth", 6, JsonObject(berths() + ("servicePresentation" to JsonNull)), buildingId = berthA))
    }
    @Test fun `multiple berth identities do not select the first installed sibling`() {
        val raw = berths()
        val rows = raw.getValue("buildings").jsonArray
        val two = JsonObject(raw + json("""{
            "servicePresentation":{"version":1,"berths":[{"buildingId":"$berthA","installation":null},{"buildingId":"$berthB","installation":null}]},
            "advancedServicePresentation":{"version":1,"berths":[{"buildingId":"$berthA","installation":null},{"buildingId":"$berthB","installation":{"family":"survey_balloon","tier":1,"presence":"away"}}]}
        }""") + ("buildings" to JsonArray(rows + JsonObject(rows.single().jsonObject + ("id" to JsonPrimitive(berthB))))))
        val resident = Resident()
        assertTrue(available("berth", 6, two, resident, buildingId = berthB))
        assertEquals("survey-balloon-berth", selectedBerth(two, berthB))
        assertEquals("starter-berth", selectedBerth(two, berthA))
    }
    @Test fun `metadata and current permission without every resident group do not admit construction`() {
        val resident = Resident().apply { missing += "pe_workshop_t1" }
        assertFalse(available("workshop", resident = resident))
        // lodge-t1/destroyed aliases workshop-t1/rubble -> pe_workshop_t1_rubble_f1:
        // the Lodge needs that resident group for its authored destroyed state too.
        assertFalse(available("lodge", resident = resident))
        resident.current = false
        assertFalse(available("lodge", resident = resident))
    }
    @Test fun `future malformed graph and static fallback fields cannot replace genuine Phase E art`() {
        assertNull(admission(render = JsonObject(render - "phaseE")))
        assertNull(admission(render = JsonObject(render + ("rendererContractVersion" to JsonPrimitive(18)))))
        for (field in listOf("frameKey", "atlasPath", "motion")) {
            val changed = mutateEntry("workshop", 1) { JsonObject(it + (field to JsonPrimitive("invented"))) }
            assertFalse(available("workshop", render = changed))
        }
    }
    @Test fun `valid marker parser alone does not excuse tier disagreement with exported constants`() {
        val changed = mutateEntry("workshop", 1) { JsonObject(it + ("phaseE" to json("""{"facility":"workshop","tier":2}"""))) }
        assertFalse(available("workshop", render = changed))
    }
    @Test fun `a callback from another content object cannot authorize a new generation`() {
        assertFalse(constructionStartAvailable(base(), catalogue, JsonObject(render.toMap()), "workshop", art = admission()))
        assertFalse(constructionStartAvailable(base(), JsonObject(catalogue.toMap()), render, "workshop", art = admission()))
    }
    @Test fun `revocation during descriptor checks closes the same observation`() {
        val resident = object : PhaseEConstructionResidency {
            var current = true
            override fun isCurrent() = current
            override fun contains(group: ServiceAtlasGroup): Boolean { current = false; return true }
        }
        assertFalse(constructionStartAvailable(base(), catalogue, render, "workshop", art = preparePhaseEConstructionArt(catalogue, render, resident)))
    }
}
