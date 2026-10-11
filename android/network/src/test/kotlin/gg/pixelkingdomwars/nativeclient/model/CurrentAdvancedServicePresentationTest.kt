package gg.pixelkingdomwars.nativeclient.model

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class CurrentAdvancedServicePresentationTest {
    private fun id(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun building(n: Int, level: JsonElement = JsonPrimitive(1), construction: JsonElement? = null) = buildJsonObject {
        put("id", id(n)); put("type", "berth"); put("level", level); put("tx", 3); put("ty", 4)
        construction?.let { put("underConstruction", it) }
    }
    private fun installation(presence: String = "occupied") = buildJsonObject {
        put("family", "survey_balloon"); put("tier", 1); put("presence", presence)
    }
    private fun row(n: Int, installed: JsonElement = installation()) = buildJsonObject {
        put("buildingId", id(n)); put("installation", installed)
    }
    private fun proof(vararg rows: JsonElement) = buildJsonObject {
        put("version", 1); put("berths", JsonArray(rows.toList()))
    }
    private fun base(buildings: List<JsonElement>, value: JsonElement? = null) = buildJsonObject {
        put("player", buildJsonObject { put("keepLevel", 1) }); put("buildings", JsonArray(buildings))
        value?.let { put("advancedServicePresentation", it) }
    }

    @Test fun `current closed rows include initial construction without weakening the original snapshot grammar`() {
        val buildings = listOf(building(3, JsonPrimitive(0), JsonPrimitive(true)), building(1), building(2, JsonPrimitive(0)))
        val value = proof(row(1), row(2, JsonNull), row(3, JsonNull))
        val raw = base(buildings, value)
        val current = requireNotNull(BaseSnapshot.from(raw).advancedServicePresentation)
        assertEquals(listOf(id(1), id(2), id(3)), current.berths.map { it.buildingId })
        assertEquals(listOf(installation().getValue("family").jsonPrimitive.content, null, null), current.berths.map { it.installation?.family })
        assertEquals(current, BaseServiceFacts.current(raw).advancedPresentation)
        assertNull(AdvancedServicePresentation.optional(value, raw))
        assertNull(BaseServiceFacts.frozen(raw, raw).advancedPresentation)
        // The row for a new berth cannot disappear just because it has no vessel.
        assertNull(BaseSnapshot.from(base(buildings, proof(row(1), row(2, JsonNull)))).advancedServicePresentation)
    }

    @Test fun `current installed facts require completed numeric level and strict construction flags`() {
        for (flag in listOf<JsonElement>(JsonPrimitive("false"), JsonPrimitive(0), JsonNull)) {
            for (installed in listOf<JsonElement>(installation(), JsonNull))
                assertNull(BaseServiceFacts.current(base(listOf(building(1, construction = flag)), proof(row(1, installed)))).advancedPresentation)
        }
        assertNull(BaseServiceFacts.current(base(listOf(building(1, construction = JsonPrimitive(true))), proof(row(1)))).advancedPresentation)
        for (level in listOf<JsonElement>(JsonPrimitive(0), JsonPrimitive(-1), JsonPrimitive("1"), JsonPrimitive(1.5), JsonNull))
            assertNull(BaseServiceFacts.current(base(listOf(building(1, level)), proof(row(1)))).advancedPresentation)
        for (flag in listOf<JsonElement?>(null, JsonPrimitive(false))) {
            val raw = base(listOf(building(1, construction = flag)), proof(row(1)))
            assertEquals(BaseServiceFacts.frozen(raw, raw).advancedPresentation, BaseServiceFacts.current(raw).advancedPresentation)
            assertNotNull(BaseSnapshot.from(raw).advancedServicePresentation)
        }
    }

    @Test fun `malformed current observations clear only their sibling and never retain a previous positive`() {
        val starter = proof(row(1, buildJsonObject { put("family", "starter"); put("presence", "away") }))
        val common = JsonObject(base(listOf(building(1))) + mapOf(
            "servicePresentation" to starter,
            "serviceActivity" to buildJsonObject { put("version", 1); put("services", JsonArray(emptyList())) }))
        val good = proof(row(1))
        assertNotNull(BaseSnapshot.from(JsonObject(common + ("advancedServicePresentation" to good))).advancedServicePresentation)
        val bad = listOf<JsonElement?>(null, JsonNull, JsonObject(good + ("version" to JsonPrimitive(2))),
            JsonObject(good + ("actorWallet" to JsonPrimitive("private"))), proof(row(2)), proof(row(1), row(1)),
            proof(row(1, JsonObject(installation() + ("tier" to JsonPrimitive("1"))))),
            proof(row(1, JsonObject(installation() + ("presence" to JsonPrimitive("ready"))))))
        for (value in bad) {
            val raw = JsonObject(common + (value?.let { mapOf("advancedServicePresentation" to it) } ?: emptyMap()))
            val parsed = BaseSnapshot.from(raw)
            assertNull(parsed.advancedServicePresentation)
            assertEquals(StarterPresence.AWAY, parsed.servicePresentation!!.berths.single().installation!!.presence)
            assertNotNull(parsed.serviceActivity)
            assertNull(parsed.phaseEArt)
        }
        val duplicateFamily = base(listOf(building(1), building(2)), proof(row(1), row(2)))
        assertNull(BaseServiceFacts.current(duplicateFamily).advancedPresentation)
    }

    @Test fun `current facts use only their own root and closure rather than inner snapshot or independent fleet data`() {
        val advanced = proof(row(1))
        val own = base(listOf(building(1)), advanced)
        val wrong = JsonObject(base(listOf(building(2)), advanced) + ("snapshot" to own))
        assertNull(BaseServiceFacts.current(wrong).advancedPresentation)
        val missing = JsonObject(base(listOf(building(1))) + mapOf("snapshot" to own, "fleet" to advanced))
        assertNull(BaseSnapshot.from(missing).advancedServicePresentation)
        assertNull(PresentationHead.from(own).advancedServicePresentation)
        val envelope = buildJsonObject { put("snapshot", own) }
        assertNull(BaseServiceFacts.frozen(envelope, own).advancedPresentation)
        assertNull(PresentationHead.from(envelope).advancedServicePresentation)
    }

    @Test fun `current server presence is retained without timers economic counters or art permission`() {
        for ((wire, expected) in listOf("occupied" to AdvancedPresence.OCCUPIED, "away" to AdvancedPresence.AWAY,
            "exhausted" to AdvancedPresence.EXHAUSTED)) {
            // These unrelated current fields cannot overrule the explicit sibling.
            val raw = JsonObject(base(listOf(building(1)), proof(row(1, installation(wire)))) + mapOf(
                "serverNow" to JsonPrimitive("2099-01-01T00:00:00.000Z"),
                "vehicles" to buildJsonObject { put("remainingUses", 0); put("away", false) }))
            val parsed = BaseSnapshot.from(raw)
            assertEquals(expected, parsed.advancedServicePresentation!!.berths.single().installation!!.presence)
            assertNull(parsed.phaseEArt)
            assertNull(parsed.serviceActivity)
            assertNull(parsed.servicePresentation)
        }
    }
}
