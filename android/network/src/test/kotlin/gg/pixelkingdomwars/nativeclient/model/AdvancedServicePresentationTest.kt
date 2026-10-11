package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class AdvancedServicePresentationTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun building(n: Int, type: String = "berth", level: JsonElement = JsonPrimitive(1)) = buildJsonObject {
        put("id", id(n)); put("type", type); put("level", level); put("tx", 3); put("ty", 4)
    }
    private val buildings = JsonArray(listOf(building(2, "lodge"), building(1)))
    private fun installed(family: String = "survey_balloon", tier: JsonElement = JsonPrimitive(1), presence: String = "occupied") = buildJsonObject {
        put("family", family); put("tier", tier); put("presence", presence)
    }
    private fun row(n: Int = 1, installation: JsonElement = installed()) = buildJsonObject {
        put("buildingId", id(n)); put("installation", installation)
    }
    private fun proof(vararg rows: JsonElement) = buildJsonObject {
        put("version", 1); put("berths", JsonArray(rows.toList()))
    }
    private fun snapshot(rows: JsonArray = buildings) = buildJsonObject { put("buildings", rows) }
    private fun rejects(value: JsonElement, owner: JsonArray = buildings) {
        assertTrue(runCatching { AdvancedServicePresentation.from(value, owner) }.isFailure)
        assertNull(AdvancedServicePresentation.optional(value, snapshot(owner)))
    }

    @Test fun `all frozen wire families tiers and presence values are independent of current economic admission`() {
        for (family in listOf("survey_balloon", "cargo_cutter", "courier_airship", "expedition_barge"))
            for (tier in 1..4) for ((name, presence) in listOf("occupied" to AdvancedPresence.OCCUPIED,
                "away" to AdvancedPresence.AWAY, "exhausted" to AdvancedPresence.EXHAUSTED)) {
                val parsed = AdvancedServicePresentation.from(proof(row(installation = installed(family, JsonPrimitive(tier), name))), buildings)
                assertEquals(listOf(AdvancedBerthPresentation(id(1), AdvancedInstallationPresentation(family, tier, presence))), parsed.berths)
            }
    }

    @Test fun `missing or null whole facts stay unavailable while a null berth means only no advanced installation`() {
        for (value in listOf<JsonElement?>(null, JsonNull)) assertNull(AdvancedServicePresentation.optional(value, snapshot()))
        val parsed = AdvancedServicePresentation.from(proof(row(installation = JsonNull)), buildings)
        assertEquals(listOf(AdvancedBerthPresentation(id(1), null)), parsed.berths)
        assertNull(AdvancedServicePresentation.optional(proof(row()), null))
        assertEquals(emptyList<AdvancedBerthPresentation>(), AdvancedServicePresentation.from(proof(), JsonArray(listOf(building(2, "keep")))).berths)
    }

    @Test fun `future private malformed and coercing fields cannot produce partial advanced facts`() {
        val good = proof(row())
        for (invalid in listOf<JsonElement>(JsonPrimitive(true), JsonArray(emptyList()),
            JsonObject(good + ("version" to JsonPrimitive("1"))), JsonObject(good + ("version" to JsonPrimitive(2))),
            JsonObject(good + ("wallet" to JsonPrimitive("private"))), JsonObject(good - "berths"),
            proof(JsonObject(row() + ("receipt" to JsonPrimitive("private")))), proof(JsonObject(row() - "installation")))) rejects(invalid)
        for (tier in listOf<JsonElement>(JsonPrimitive("1"), JsonPrimitive(1.0), JsonPrimitive(true), JsonNull, JsonPrimitive(0), JsonPrimitive(5), JsonPrimitive(-1)))
            rejects(proof(row(installation = installed(tier = tier))))
        for (change in listOf("family" to JsonPrimitive("starter"), "family" to JsonPrimitive("survey-balloon"),
            "family" to JsonPrimitive(true), "presence" to JsonPrimitive("home"), "presence" to JsonPrimitive(1),
            "wallet" to JsonPrimitive("private"), "installationId" to JsonPrimitive(id(9)), "returnedAt" to JsonPrimitive("yesterday")))
            rejects(proof(row(installation = JsonObject(installed() + change))))
        for (key in listOf("family", "tier", "presence")) rejects(proof(row(installation = JsonObject(installed() - key))))
    }

    @Test fun `all snapshot berth identities require one unique sorted row and one installed family at most`() {
        val owners = JsonArray(listOf(building(3), building(2, "keep"), building(1)))
        val rows = listOf(row(1), row(3, installed("cargo_cutter")))
        assertEquals(listOf(id(1), id(3)), AdvancedServicePresentation.from(proof(*rows.toTypedArray()), owners).berths.map { it.buildingId })
        for (bad in listOf(rows.reversed(), rows.take(1), rows + row(4), listOf(row(1), row(1)), listOf(row(1), row(3))))
            rejects(proof(*bad.toTypedArray()), owners)
        rejects(proof(row(2)), buildings)
        rejects(proof(row()), JsonArray(buildings + building(1)))
        rejects(proof(row()), JsonArray(listOf(building(2, "keep"))))
        rejects(proof(JsonObject(row() + ("buildingId" to JsonPrimitive(id(1).replace("4000", "0000"))))))
        // Non-berth legacy identity grammar is outside this optional closure.
        val legacy = buildJsonObject { put("id", "legacy-keep"); put("type", "keep") }
        assertNotNull(AdvancedServicePresentation.optional(proof(row()), snapshot(JsonArray(buildings + legacy))))
    }

    @Test fun `construction and uncompleted installed berths cannot acquire frozen advanced art`() {
        for (flag in listOf<JsonElement>(JsonPrimitive(true), JsonPrimitive("false"), JsonNull)) {
            val owner = JsonArray(listOf(JsonObject(building(1) + ("underConstruction" to flag))))
            rejects(proof(row()), owner); rejects(proof(row(installation = JsonNull)), owner)
        }
        for (level in listOf<JsonElement>(JsonPrimitive(0), JsonPrimitive(-1), JsonPrimitive("1"), JsonPrimitive(1.5), JsonNull))
            rejects(proof(row()), JsonArray(listOf(building(1, level = level))))
        val levelZero = JsonArray(listOf(building(1, level = JsonPrimitive(0))))
        assertNotNull(AdvancedServicePresentation.optional(proof(row(installation = JsonNull)), snapshot(levelZero)))
        val complete = JsonArray(listOf(JsonObject(building(1) + ("underConstruction" to JsonPrimitive(false)))))
        assertNotNull(AdvancedServicePresentation.optional(proof(row()), snapshot(complete)))
    }

    @Test fun `current sibling is independent while frozen root still binds only its original buildings`() {
        val advanced = proof(row())
        val starter = proof(row(installation = buildJsonObject { put("family", "starter"); put("presence", "away") }))
        val current = JsonObject(snapshot() + mapOf("advancedServicePresentation" to advanced, "servicePresentation" to starter,
            "features" to buildJsonObject { put("phaseEArt", buildJsonObject { put("version", 1); put("enabled", true) }) }))
        // Current parsing is now explicitly supported; this never broadens the
        // historical head's original-root/snapshot-only boundary.
        assertEquals(AdvancedServicePresentation.from(advanced, buildings), BaseServiceFacts.current(current).advancedPresentation)
        assertNull(PresentationHead.from(current).advancedServicePresentation)
        val envelope = buildJsonObject { put("snapshot", current); put("advancedServicePresentation", advanced); put("servicePresentation", starter) }
        val facts = BaseServiceFacts.frozen(envelope, current)
        assertEquals(AdvancedPresence.OCCUPIED, facts.advancedPresentation!!.berths.single().installation!!.presence)
        assertEquals(StarterPresence.AWAY, facts.presentation!!.berths.single().installation!!.presence)
        assertNull(facts.phaseEArt); assertNull(facts.activity)
        assertEquals(facts.advancedPresentation, PresentationHead.from(envelope).advancedServicePresentation)
        assertNull(PresentationHead.from(JsonObject(envelope - "advancedServicePresentation")).advancedServicePresentation)
        assertNull(PresentationHead.from(JsonObject(envelope + ("snapshot" to JsonPrimitive("invalid")))).advancedServicePresentation)
        assertNull(BaseServiceFacts(null, null, null, null).advancedPresentation)
    }

    @Test fun `invalid advanced observation clears only its own optional field without changing starter grammar`() {
        val starter = proof(row(installation = buildJsonObject { put("family", "starter"); put("presence", "occupied") }))
        val malformed = JsonObject(proof(row()) + ("version" to JsonPrimitive(2)))
        val envelope = buildJsonObject { put("snapshot", snapshot()); put("servicePresentation", starter); put("advancedServicePresentation", malformed) }
        val facts = BaseServiceFacts.frozen(envelope, snapshot())
        assertNull(facts.advancedPresentation)
        assertEquals(StarterPresence.OCCUPIED, facts.presentation!!.berths.single().installation!!.presence)
        assertNull(BaseServicePresentation.optional(proof(row()), snapshot()))
        assertNull(AdvancedServicePresentation.optional(starter, snapshot()))
    }

    @Test fun `parsed advanced facts own immutable rows independently of the response backing map`() {
        val backing = proof(row()).toMutableMap()
        val parsed = AdvancedServicePresentation.from(JsonObject(backing), buildings)
        backing["berths"] = JsonArray(emptyList())
        assertEquals(1, parsed.berths.size)
        assertTrue(runCatching { (parsed.berths as MutableList).clear() }.isFailure)
    }
}
